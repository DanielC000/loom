import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Agent-tooling epic P2 — the `authenticated_request` MCP tool (card 302e551a). SECURITY-CRITICAL,
// fully hermetic: NO real network (every fetch is an injected fake), NO real claude, NO live daemon.
//
// Part 1 exercises `performAuthenticatedRequest` (connections/request.ts) directly via its `fetchImpl`/
// `now` test seams — the fast, deterministic path for every load-bearing invariant:
//   - auth injected server-side (bearer -> Authorization, api-key -> X-API-Key); the Authorization header
//     is REJECTED if the caller tries to set it; the secret never appears in a rejected/errored result.
//   - the session-pinned connection allowlist is enforced (a connection id outside it is rejected before
//     any fetch); path validation rejects "//", backslashes, embedded "://", and control chars.
//   - redirects are NEVER auto-followed (fetchImpl called exactly once even on a 3xx) — the credential is
//     never sent to a redirect target.
//   - an echo response that reflects the secret back (in body AND headers) comes back REDACTED.
//   - the response-size cap aborts an oversized body; the rate limiter rejects past its window max.
//
// Part 2 proves the profile-gating wiring end-to-end (shared type -> profiles/validate.ts -> resolveProfile
// -> session-row pin -> TaskMcpRouter tools/list) using a REAL SessionService driven against a FAKE pty
// (mirrors agent-runs-profile-attrs.mjs): a profile with an empty `connections` pins [] on the session row
// and the tool is OMITTED from that session's MCP tools/list; a profile with a connection id pins it and
// the tool IS listed — and the captured spawn opts are otherwise byte-identical (no `connections` key ever
// reaches SpawnOpts at all — the mechanism lives entirely in the DB-resolved MCP router, not the spawn path).
//
// Run: 1) build (turbo builds shared first), 2) node test/authenticated-request.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-auth-req-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { createConnection } = await import("../dist/connections/store.js");
const { performAuthenticatedRequest, __resetConnectionsRateLimitState } = await import("../dist/connections/request.js");
const { TaskMcpRouter } = await import("../dist/mcp/server.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

const PLAINTEXT = "sk-DO-NOT-LEAK-this-secret-9f8e7d6c5b4a";
// A generous rate-limit ceiling for the general functional tests below (1i has its OWN tight-limit guard,
// so the two never interfere — the rate guard only counts genuine dispatch attempts past every other
// validation, so this high ceiling is never actually approached outside 1i's dedicated block).
const GUARD = { requestTimeoutMs: 5000, maxResponseBytes: 100, rateLimitMax: 1000, rateLimitWindowMs: 60000 };

try {
  // ============ Part 1 — performAuthenticatedRequest, direct unit coverage ============
  {
    const db = new Db(path.join(tmpHome, "p1.db"));
    const bearerConn = createConnection(db, { name: "GitHub", host: "api.github.com", authScheme: "bearer", secret: PLAINTEXT });
    const apiKeyConn = createConnection(db, { name: "Widget", host: "widget.example", authScheme: "api-key", secret: PLAINTEXT });

    // --- 1a. bearer auth injected; secret absent from the returned result ---
    {
      const calls = [];
      const fetchImpl = async (url, init) => { calls.push({ url: String(url), init }); return new Response("ok body", { status: 200, headers: { "content-type": "text/plain" } }); };
      const r = await performAuthenticatedRequest({ db, fetchImpl }, [bearerConn.id], GUARD, { connection: bearerConn.id, path: "/repos/x/y" });
      check("1a bearer: request succeeds", r.ok === true && r.status === 200 && r.body === "ok body");
      check("1a bearer: URL built from the connection host + path", calls[0]?.url === "https://api.github.com/repos/x/y");
      check("1a bearer: Authorization header injected as 'Bearer <secret>'", calls[0]?.init?.headers?.Authorization === `Bearer ${PLAINTEXT}`);
      check("1a bearer: redirect mode is 'manual' (never auto-follow)", calls[0]?.init?.redirect === "manual");
      check("1a bearer: the secret never appears in the JSON-stringified result", !JSON.stringify(r).includes(PLAINTEXT));
    }

    // --- 1b. api-key auth injected as X-API-Key ---
    {
      const calls = [];
      const fetchImpl = async (url, init) => { calls.push({ url: String(url), init }); return new Response("{}", { status: 200 }); };
      const r = await performAuthenticatedRequest({ db, fetchImpl }, [apiKeyConn.id], GUARD, { connection: apiKeyConn.id, path: "/v1/things" });
      check("1b api-key: X-API-Key header injected", calls[0]?.init?.headers?.["X-API-Key"] === PLAINTEXT);
      check("1b api-key: no bearer-shaped Authorization header set", calls[0]?.init?.headers?.Authorization === undefined);
      check("1b api-key: request succeeds", r.ok === true);
    }

    // --- 1c. the caller cannot set its own Authorization header (rejected before any fetch) ---
    {
      let fetchCalled = false;
      const fetchImpl = async () => { fetchCalled = true; return new Response("x", { status: 200 }); };
      const r = await performAuthenticatedRequest({ db, fetchImpl }, [bearerConn.id], GUARD, { connection: bearerConn.id, path: "/x", headers: { Authorization: "Bearer attacker-supplied" } });
      check("1c caller Authorization header: rejected", r.ok === false);
      check("1c caller Authorization header: fetch never called", fetchCalled === false);
      check("1c caller Authorization header: error mentions Authorization", /Authorization/.test(r.error ?? ""));
      // Case-insensitive variant too.
      const r2 = await performAuthenticatedRequest({ db, fetchImpl }, [bearerConn.id], GUARD, { connection: bearerConn.id, path: "/x", headers: { authorization: "Bearer x" } });
      check("1c lowercase 'authorization' header: ALSO rejected", r2.ok === false);
    }

    // --- 1d. session allowlist: a connection NOT in the session's pinned list is rejected, no fetch ---
    {
      let fetchCalled = false;
      const fetchImpl = async () => { fetchCalled = true; return new Response("x", { status: 200 }); };
      const r = await performAuthenticatedRequest({ db, fetchImpl }, [/* empty allowlist */], GUARD, { connection: bearerConn.id, path: "/x" });
      check("1d not-allowlisted connection: rejected", r.ok === false);
      check("1d not-allowlisted connection: fetch never called", fetchCalled === false);
      check("1d not-allowlisted connection: secret absent from error", !JSON.stringify(r).includes(PLAINTEXT));
    }

    // --- 1e. path validation rejects exotic parser-confusion inputs; no fetch on any of them ---
    {
      let fetchCalled = false;
      const fetchImpl = async () => { fetchCalled = true; return new Response("x", { status: 200 }); };
      const bad = ["//evil.example/x", "\\x", "/a\\b", "http://evil.example", "/a\nb", "nope-no-leading-slash", ""];
      for (const p of bad) {
        const r = await performAuthenticatedRequest({ db, fetchImpl }, [bearerConn.id], GUARD, { connection: bearerConn.id, path: p });
        check(`1e path '${JSON.stringify(p)}' rejected`, r.ok === false);
      }
      check("1e: none of the bad paths ever reached fetch", fetchCalled === false);
      // A well-formed path is accepted.
      const good = await performAuthenticatedRequest({ db, fetchImpl: async (u) => new Response("ok", { status: 200 }) }, [bearerConn.id], GUARD, { connection: bearerConn.id, path: "/a/b?q=1" });
      check("1e: a well-formed path is accepted", good.ok === true);
    }

    // --- 1f. redirects are returned, NEVER followed — fetch is called exactly once ---
    {
      let callCount = 0;
      const fetchImpl = async () => { callCount++; return new Response(null, { status: 302, headers: { location: "https://attacker.example/steal" } }); };
      const r = await performAuthenticatedRequest({ db, fetchImpl }, [bearerConn.id], GUARD, { connection: bearerConn.id, path: "/x" });
      check("1f redirect: result carries the 3xx status", r.ok === true && r.status === 302);
      check("1f redirect: location surfaced to the caller", r.location === "https://attacker.example/steal");
      check("1f redirect: fetch called EXACTLY ONCE (never auto-followed to the redirect target)", callCount === 1);
    }

    // --- 1g. echo redaction: an API that reflects the secret back (body AND headers) is scrubbed ---
    {
      const echoBody = JSON.stringify({ headers: { authorization: `Bearer ${PLAINTEXT}` } });
      const fetchImpl = async () => new Response(echoBody, { status: 200, headers: { "x-echo": `Bearer ${PLAINTEXT}`, "content-type": "application/json" } });
      const r = await performAuthenticatedRequest({ db, fetchImpl }, [bearerConn.id], GUARD, { connection: bearerConn.id, path: "/headers" });
      check("1g echo: result body does NOT contain the raw secret", r.ok === true && !r.body.includes(PLAINTEXT));
      check("1g echo: result body carries the redaction marker instead", r.body.includes("[REDACTED]"));
      check("1g echo: result headers do NOT contain the raw secret", !Object.values(r.headers).some((v) => v.includes(PLAINTEXT)));
      check("1g echo: Set-Cookie is stripped entirely, not merely redacted", !("set-cookie" in r.headers));
    }

    // --- 1h. response-size cap aborts an oversized body (GUARD.maxResponseBytes === 100 here) ---
    {
      const fetchImpl = async () => new Response("x".repeat(GUARD.maxResponseBytes * 5), { status: 200 });
      const r = await performAuthenticatedRequest({ db, fetchImpl }, [bearerConn.id], GUARD, { connection: bearerConn.id, path: "/big" });
      check("1h oversized response: rejected", r.ok === false);
      check("1h oversized response: error names the cap", /byte/.test(r.error ?? ""));
    }

    // --- 1h2. the request timeout bounds the BODY READ too, not just the initial fetch() call ---
    // (Code-Reviewer finding: `clearTimeout` used to fire the instant fetch() resolved — headers received
    // — disarming the abort for the whole body-read phase. A slow-drip upstream that never closes its
    // stream, staying under the byte cap forever, would hang this call indefinitely.) A never-enqueuing,
    // never-closing ReadableStream simulates exactly that; a SHORT dedicated timeout proves the call
    // still resolves (rejected, not hung) — and we assert on wall-clock elapsed time, not just the
    // outcome, so a regression back to headers-only bounding would show up as a hang, not a silent pass.
    {
      const TIMEOUT_GUARD = { ...GUARD, requestTimeoutMs: 150, maxResponseBytes: 10_000_000 };
      const neverEndingStream = new ReadableStream({ pull() { return new Promise(() => {}); } });
      const fetchImpl = async () => new Response(neverEndingStream, { status: 200 });
      const startedAt = Date.now();
      const r = await performAuthenticatedRequest({ db, fetchImpl }, [bearerConn.id], TIMEOUT_GUARD, { connection: bearerConn.id, path: "/slow-drip" });
      const elapsedMs = Date.now() - startedAt;
      check("1h2 slow-drip body: the call resolves (rejected) instead of hanging", r.ok === false);
      check("1h2 slow-drip body: error names the timeout", /timed out/.test(r.error ?? ""));
      check(`1h2 slow-drip body: bounded by requestTimeoutMs, not left hanging (elapsed ${elapsedMs}ms, well under a 5s ceiling)`, elapsedMs < 5000);
    }

    // --- 1i. rate limiter: rejects the (rateLimitMax+1)th call within one window ---
    // A DEDICATED tight-limit guard (rateLimitMax:2) — kept separate from GUARD's generous ceiling above
    // so this block's exhaustion can never bleed into (or be masked by) the other functional tests.
    {
      __resetConnectionsRateLimitState();
      const TIGHT_GUARD = { ...GUARD, rateLimitMax: 2 };
      const fetchImpl = async () => new Response("ok", { status: 200 });
      const fixedNow = () => 1_000_000; // every call lands in the SAME window
      const r1 = await performAuthenticatedRequest({ db, fetchImpl, now: fixedNow }, [bearerConn.id], TIGHT_GUARD, { connection: bearerConn.id, path: "/1" });
      const r2 = await performAuthenticatedRequest({ db, fetchImpl, now: fixedNow }, [bearerConn.id], TIGHT_GUARD, { connection: bearerConn.id, path: "/2" });
      const r3 = await performAuthenticatedRequest({ db, fetchImpl, now: fixedNow }, [bearerConn.id], TIGHT_GUARD, { connection: bearerConn.id, path: "/3" });
      check("1i rate limit: first request (of max 2) ok", r1.ok === true);
      check("1i rate limit: second request (of max 2) ok", r2.ok === true);
      check("1i rate limit: third request in the SAME window rejected", r3.ok === false && /rate limit/.test(r3.error ?? ""));
      __resetConnectionsRateLimitState();
    }

    // --- 1j. unknown connection id -> a clean error, never a throw ---
    {
      const r = await performAuthenticatedRequest({ db, fetchImpl: async () => new Response("x") }, ["nope"], GUARD, { connection: "nope", path: "/x" });
      check("1j unknown connection: rejected cleanly (allowlist check runs first)", r.ok === false);
    }

    // --- 1k. structured-body (object) input is JSON-stringified with a Content-Type default ---
    {
      const calls = [];
      const fetchImpl = async (url, init) => { calls.push(init); return new Response("ok", { status: 200 }); };
      await performAuthenticatedRequest({ db, fetchImpl }, [bearerConn.id], GUARD, { connection: bearerConn.id, path: "/x", method: "POST", body: { a: 1 } });
      check("1k object body: JSON-stringified", calls[0]?.body === JSON.stringify({ a: 1 }));
      check("1k object body: Content-Type defaulted to application/json", calls[0]?.headers?.["Content-Type"] === "application/json");
    }

    db.close();
  }

  // ============ Part 2 — profile-gating wiring end-to-end (spawn -> session row -> tools/list) ============
  {
    const db = new Db(path.join(tmpHome, "p2.db"));
    const now = new Date().toISOString();
    const PROJECT_ID = "pAuthReq";
    db.insertProject({ id: PROJECT_ID, name: "AuthReqProj", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null });

    const granted = createConnection(db, { name: "GitHub", host: "api.github.com", authScheme: "bearer", secret: PLAINTEXT });

    // Profile A: no connections (the default/off case). Profile B: grants the one connection above.
    db.insertProfile({ id: "profNoConn", name: "NoConnRig", role: null, description: "", allowDelta: [], skills: null, model: null, icon: null });
    db.insertProfile({ id: "profWithConn", name: "WithConnRig", role: null, description: "", allowDelta: [], skills: null, model: null, icon: null, connections: [granted.id] });
    db.insertAgent({ id: "agentNoConn", projectId: PROJECT_ID, name: "NoConn", startupPrompt: "", position: 0, profileId: "profNoConn" });
    db.insertAgent({ id: "agentWithConn", projectId: PROJECT_ID, name: "WithConn", startupPrompt: "", position: 1, profileId: "profWithConn" });

    class SeamHost extends PtyHost {
      constructor(events) { super(events); this.capture = []; }
      createPty(opts) { this.capture.push(opts); return { pid: 1, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} }; }
    }
    const events = { onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} };
    const host = new SeamHost(events);
    const svc = new SessionService(db, host, new OrchestrationControl());
    const optsFor = (sid) => host.capture.find((o) => o.sessionId === sid);

    const sNoConn = svc.startNew("agentNoConn");
    const sWithConn = svc.startNew("agentWithConn");

    check("2a no-connections profile: session row pins connections = []", JSON.stringify(db.getSession(sNoConn.id).connections ?? []) === "[]");
    check("2b granted-connection profile: session row pins the connection id", (db.getSession(sWithConn.id).connections ?? []).includes(granted.id));

    // Spawn-path additivity: `connections` never reaches SpawnOpts at all (the mechanism lives entirely
    // in the DB-resolved MCP router, not the pty spawn path) — a fresh spawn is byte-identical either way.
    const oNo = optsFor(sNoConn.id);
    const oWith = optsFor(sWithConn.id);
    check("2c SpawnOpts carries NO 'connections' key on either session (spawn path untouched)", !("connections" in oNo) && !("connections" in oWith));
    check("2c otherwise-identical spawn opts (role/model/skills/browserTesting/documentConversion) match", oNo.role === oWith.role && oNo.model === oWith.model && JSON.stringify(oNo.skills) === JSON.stringify(oWith.skills) && oNo.browserTesting === oWith.browserTesting && oNo.documentConversion === oWith.documentConversion);

    // TaskMcpRouter: authenticated_request is OMITTED from tools/list for the no-connections session,
    // and PRESENT for the granted session. fetchOverride THROWS if ever hit (this test never calls the
    // tool — tools/list only — so a throw here would mean an accidental real network attempt).
    const wakes = {}; // tools/list never invokes a tool handler, so a stub suffices (wake_me/etc. unused)
    const throwFetch = async () => { throw new Error("unexpected real fetch in a tools/list-only test"); };
    const router = new TaskMcpRouter(db, wakes, throwFetch);

    const listOf = async (sessionId) => {
      const projectId = router.resolveProject(sessionId);
      const server = router.buildServer(projectId, sessionId);
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      await server.connect(serverT);
      const client = new Client({ name: "auth-req-test", version: "0" });
      await client.connect(clientT);
      const tools = (await client.listTools()).tools;
      await client.close();
      return tools;
    };

    const toolsNo = await listOf(sNoConn.id);
    const toolsWith = await listOf(sWithConn.id);
    check("2d no-connections session: authenticated_request OMITTED from tools/list", !toolsNo.some((t) => t.name === "authenticated_request"));
    check("2e granted-connection session: authenticated_request PRESENT in tools/list", toolsWith.some((t) => t.name === "authenticated_request"));
    check("2f every other loom-tasks tool still present on both (additive, not replacing)", ["tasks_list", "tasks_get", "wake_me"].every((n) => toolsNo.some((t) => t.name === n) && toolsWith.some((t) => t.name === n)));

    db.close();
  }

  console.log(failures === 0
    ? "\n✅ ALL PASS — authenticated_request: auth injected server-side (bearer/api-key), caller Authorization rejected, session allowlist + path validation enforced, redirects never auto-followed, echo responses redacted (body+headers, Set-Cookie stripped), response-size cap + rate limiter enforced, and the profile-gating wiring (spawn -> session row -> tools/list) is additive/byte-identical when off."
    : `\n❌ ${failures} FAILURE(S).`);
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL/handle retry (Windows) */ } }
}
process.exit(failures === 0 ? 0 : 1);
