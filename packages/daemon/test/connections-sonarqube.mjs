import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 1e8e9b1e — the SonarQube connection preset. Fully hermetic: NO real network (every fetch is an
// injected fake), NO real claude, NO live daemon.
//
// Part 1 exercises `validateSonarQubeCredential` (connections/sonarqube.ts) directly via its `fetchImpl`
// test seam — the DoD-1 pre-save probe:
//   - a rejected token (401/403) is reported as a clear "rejected" error, not a generic HTTP failure.
//   - a 200 response with NO authenticated `login` (the anonymous-bypass shape this module deliberately
//     avoids by NOT using `/api/authentication/validate`) is still treated as invalid — RED proof that the
//     check isn't merely "did the request succeed."
//   - a 200 response carrying a real `login` is accepted — GREEN.
//   - a host containing a scheme/path is rejected BEFORE any network call (fetchImpl never invoked).
//   - the request is Bearer-authenticated against `https://<host>/api/users/current` exactly.
//
// Part 2 proves DoD-3 (fail-closed): a session whose allowlist does NOT include the SonarQube connection
// gets a clean, generic refusal from `performAuthenticatedRequest` — never a confusing SonarQube-flavored
// auth error — and the fake fetch is never invoked; a session that DOES have it granted succeeds with the
// Authorization header built correctly. This reuses the already-hardened `connections/request.ts` — the
// consumer for this connection is the existing `authenticated_request` tool (see docs/decisions/1e8e9b1e-…
// for why no dedicated SonarQube capability/MCP server was built for v1).
//
// Run: 1) build (turbo builds shared first), 2) node test/connections-sonarqube.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-sonarqube-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { createConnection } = await import("../dist/connections/store.js");
const { performAuthenticatedRequest } = await import("../dist/connections/request.js");
const { validateSonarQubeCredential } = await import("../dist/connections/sonarqube.js");

const TOKEN = "squ_DO-NOT-LEAK-this-token-9f8e7d6c5b4a";
const GUARD = { requestTimeoutMs: 5000, maxResponseBytes: 4096, rateLimitMax: 1000, rateLimitWindowMs: 60000 };

try {
  // ============ Part 1 — validateSonarQubeCredential, direct unit coverage ============
  {
    // --- 1a. RED: SonarQube rejects the token (401) -> a clear, specific refusal ---
    {
      const calls = [];
      const fetchImpl = async (url, init) => { calls.push({ url: String(url), init }); return new Response("{}", { status: 401 }); };
      const r = await validateSonarQubeCredential({ fetchImpl }, "sonarcloud.io", TOKEN);
      check("1a 401: reported as ok:false", r.ok === false);
      check("1a 401: error names 'rejected the token', not a generic HTTP message", r.ok === false && /rejected the token/i.test(r.error));
      check("1a: probed /api/users/current on the given host", calls[0]?.url === "https://sonarcloud.io/api/users/current");
      check("1a: Bearer auth header carries the token", calls[0]?.init?.headers?.Authorization === `Bearer ${TOKEN}`);
    }

    // --- 1b. RED (the anonymous-bypass trap): HTTP 200 but no authenticated login -> still invalid ---
    // This is the exact shape /api/authentication/validate would have falsely accepted (its own
    // {"valid":true} for an anonymous caller) — proves this module's endpoint choice actually discriminates.
    {
      const fetchImpl = async () => new Response(JSON.stringify({}), { status: 200 });
      const r = await validateSonarQubeCredential({ fetchImpl }, "sonarcloud.io", TOKEN);
      check("1b 200-but-anonymous: still ok:false (no authenticated login present)", r.ok === false);
    }

    // --- 1c. GREEN: HTTP 200 with a real login -> accepted ---
    {
      const fetchImpl = async () => new Response(JSON.stringify({ login: "alice", name: "Alice" }), { status: 200 });
      const r = await validateSonarQubeCredential({ fetchImpl }, "sonarqube.example.com", TOKEN);
      check("1c 200-with-login: ok:true", r.ok === true);
    }

    // --- 1d. a host carrying a scheme/path is rejected BEFORE any network call ---
    {
      let called = false;
      const fetchImpl = async () => { called = true; return new Response("{}", { status: 200 }); };
      const r = await validateSonarQubeCredential({ fetchImpl }, "https://sonarcloud.io/", TOKEN);
      check("1d bad host: rejected without ever calling fetch", r.ok === false && called === false);
    }

    // --- 1e. malformed JSON body -> a clear, non-crashing refusal ---
    {
      const fetchImpl = async () => new Response("not json", { status: 200 });
      const r = await validateSonarQubeCredential({ fetchImpl }, "sonarcloud.io", TOKEN);
      check("1e malformed body: ok:false, no throw", r.ok === false);
    }

    // --- 1f. an unexpected non-401 HTTP failure (e.g. 404, wrong host) -> a clear "check the host" error ---
    {
      const fetchImpl = async () => new Response("not found", { status: 404 });
      const r = await validateSonarQubeCredential({ fetchImpl }, "sonarcloud.io", TOKEN);
      check("1f 404: ok:false, mentions the host may be wrong", r.ok === false && /host/i.test(r.error));
    }
  }

  // ============ Part 2 — DoD-3 fail-closed: the SonarQube connection is a normal P1 connection, and the
  // EXISTING authenticated_request mechanism (connections/request.ts) is its v1 consumer ============
  {
    const db = new Db(path.join(tmpHome, "p2.db"));
    const conn = createConnection(db, { name: "SonarQube", host: "sonarcloud.io", authScheme: "bearer", secret: TOKEN });

    // --- 2a. RED: a session that does NOT have this connection granted gets a CLEAN refusal, never a
    // confusing SonarQube-flavored auth error — and the fake fetch (which would return a 401 if reached,
    // easy to mistake for "the token is bad") is never invoked at all. ---
    {
      let called = false;
      const fetchImpl = async () => { called = true; return new Response("{}", { status: 401 }); };
      const r = await performAuthenticatedRequest({ db, fetchImpl }, [], GUARD, { connection: conn.id, path: "/api/qualitygates/project_status?projectKey=x" });
      check("2a ungranted: ok:false", r.ok === false);
      check("2a ungranted: clean 'not permitted' refusal, not an upstream auth error", r.ok === false && /not permitted/i.test(r.error));
      check("2a ungranted: no network call was ever made (fail-closed BEFORE dispatch)", called === false);
    }

    // --- 2b. GREEN: a session WITH this connection granted succeeds, Bearer-authenticated correctly ---
    {
      const calls = [];
      const fetchImpl = async (url, init) => { calls.push({ url: String(url), init }); return new Response(JSON.stringify({ projectStatus: { status: "OK" } }), { status: 200 }); };
      const r = await performAuthenticatedRequest({ db, fetchImpl }, [conn.id], GUARD, { connection: conn.id, path: "/api/qualitygates/project_status?projectKey=x" });
      check("2b granted: request succeeds", r.ok === true && r.status === 200);
      check("2b granted: URL built from the connection host + path", calls[0]?.url === "https://sonarcloud.io/api/qualitygates/project_status?projectKey=x");
      check("2b granted: Authorization header is 'Bearer <token>'", calls[0]?.init?.headers?.Authorization === `Bearer ${TOKEN}`);
      check("2b granted: the token never appears in the JSON-stringified result", !JSON.stringify(r).includes(TOKEN));
    }

    db.close();
  }

  console.log(failures === 0
    ? "\n✅ ALL PASS — SonarQube pre-save validation probes /api/users/current (never the anonymous-bypassable /api/authentication/validate), rejects a bad token/host/body cleanly without throwing, and the SonarQube connection's v1 consumer (authenticated_request) is fail-closed for an ungranted session with no accidental network call."
    : `\n❌ ${failures} FAILURE(S).`);
} finally {
  cleanupPathSync(tmpHome);
}
process.exit(failures === 0 ? 0 : 1);
