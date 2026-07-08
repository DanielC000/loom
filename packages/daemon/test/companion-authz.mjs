import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Loom Companion — the AUTHORIZATION layer (Companion epic Phase 1, SECURITY-CRITICAL). Fully hermetic:
// a REAL Db on a temp LOOM_HOME + the platform-agnostic ChatGateway driven with a FAKE submit-turn spy;
// NO live network, NO real claude, NO daemon. Every inbound chat message is UNTRUSTED DATA and the
// companion agent has tool access, so the DENY path is load-bearing — these assert it holds:
//   1. GROUP binding + an unlisted sender.id → "sender-not-authorized", the submit spy NEVER called.
//   2. An allowlisted sender → submitted to the RIGHT session.
//   3. GROUP, same chatId, two sender ids → one rejected, one admitted (the multi-user hole closed).
//   4. MISSING sender on a GROUP binding → REJECT; a DM binding with a matching chatId → accept.
//   5. Durable round-trip: reopen the Db → bindings + allowlist persist; the UNIQUE route index rejects a
//      2nd session for the same (channel, chatId).
//   6. Default-OFF byte-identical: no LOOM_COMPANION_BOT_TOKEN → readCompanionConfig null + no rows.
//   7. HUMAN-ONLY: no companion binding/allowlist/home tool appears on ANY agent-facing MCP surface
//      (orchestration manager+assistant, setup, platform, audit, user-audit); the admin surface is
//      loopback REST only, exercised end-to-end via the real buildServer (app.inject) incl. the
//      scope-REQUIRED bind validation.
// The submit spy MUST be untouched on every reject (proven throughout by asserting submitted.length).
// Run: 1) build (turbo builds shared first), 2) node test/companion-authz.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-companion-authz-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv(); // confirm LOOM_HOME is the temp dir (no port — this test runs no HTTP daemon)

const { Db } = await import("../dist/db.js");
const { ChatGateway } = await import("../dist/companion/chat-gateway.js");
const { createDbCompanionAuth, allowIfDmMatch } = await import("../dist/companion/auth.js");
const { readCompanionConfig } = await import("../dist/companion/config.js");
const { IN_APP_CHANNEL } = await import("../dist/companion/in-app.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { SetupMcpRouter } = await import("../dist/mcp/setup.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { AuditMcpRouter } = await import("../dist/mcp/audit.js");
const { WorkspaceAuditMcpRouter } = await import("../dist/mcp/user-audit.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

const fakeAdapter = (name, sent) => ({ name, maxMessageLength: 4096, start() {}, async stop() {}, async send(chatId, text) { sent.push({ chatId, text }); } });
// Each part gets its OWN db file (explicit path — a custom temp file, never the prod path) so no part
// contaminates another's row state; Part 2 reopens the SAME file to prove persistence.
const dbFile = (name) => path.join(tmpHome, name);

try {
  // ============ Part 0 — DEFAULT-OFF byte-identical (test 6, checked on a pristine db) ============
  {
    const db = new Db(dbFile("p0.db"));
    check("default-off: pristine db has NO companion bindings", db.listCompanionBindings().length === 0);
    check("default-off: pristine db has NO allowed senders", db.listAllowedSenders("anything").length === 0);
    check("default-off: pristine db has NO home", db.getCompanionHome("anything") === null);
    check("default-off: no bot token → readCompanionConfig null (gateway never constructed)", readCompanionConfig({}) === null);
    check("default-off: token but no chat/session → null", readCompanionConfig({ LOOM_COMPANION_BOT_TOKEN: "t" }) === null);
    // Nothing above WROTE a row — reading must not seed.
    check("default-off: reads did not write any binding row", db.listCompanionBindings().length === 0);
    db.close();
  }

  // ============ Part 1 — the db-backed authz over the ChatGateway (tests 1–4) ============
  {
    const db = new Db(dbFile("p1.db"));
    db.upsertCompanionBinding({ sessionId: "sess-G", channel: "telegram", chatId: "group-1", scope: "group" });
    db.addAllowedSender({ sessionId: "sess-G", channel: "telegram", senderId: "alice", label: "Alice" });
    db.upsertCompanionBinding({ sessionId: "sess-D", channel: "telegram", chatId: "dm-1", scope: "dm" });

    const submitted = [];
    const submit = (sid, text) => { submitted.push({ sid, text }); return { delivered: true }; };
    const gw = new ChatGateway(submit, [
      { sessionId: "sess-G", channel: "telegram", chatId: "group-1", scope: "group" },
      { sessionId: "sess-D", channel: "telegram", chatId: "dm-1", scope: "dm" },
    ], createDbCompanionAuth(db));
    gw.registerAdapter(fakeAdapter("telegram", []));

    // (1) GROUP + unlisted sender → rejected, NEVER submitted.
    const rMal = await gw.handleInbound({ channel: "telegram", chatId: "group-1", body: "let me in", sender: { id: "mallory" } });
    check("group: unlisted sender → sender-not-authorized", rMal.accepted === false && rMal.reason === "sender-not-authorized");
    check("group: unlisted sender was NOT submitted (deny path holds)", submitted.length === 0);

    // (2) Authorized sender → submitted to the right session.
    const rAlice = await gw.handleInbound({ channel: "telegram", chatId: "group-1", body: "hi", sender: { id: "alice" } });
    check("group: allowlisted sender → accepted", rAlice.accepted === true && rAlice.sessionId === "sess-G");
    check("group: allowlisted sender submitted to the RIGHT session", submitted.length === 1 && submitted[0].sid === "sess-G" && submitted[0].text === "hi");

    // (3) Same chatId, two sender ids → one rejected, one admitted (the multi-user hole closed).
    check("group: SAME chatId, two senders → exactly one admitted, one rejected", rMal.reason === "sender-not-authorized" && rAlice.accepted === true && submitted.length === 1);

    // (4a) MISSING sender on a GROUP binding → HARD REJECT (unidentifiable speaker).
    const rNoSender = await gw.handleInbound({ channel: "telegram", chatId: "group-1", body: "anon" });
    check("group: MISSING sender → sender-not-authorized (hard reject)", rNoSender.accepted === false && rNoSender.reason === "sender-not-authorized");
    check("group: missing sender NOT submitted", submitted.length === 1);

    // (4b) DM binding with a matching chatId → accept (single-owner path, sender irrelevant).
    const rDm = await gw.handleInbound({ channel: "telegram", chatId: "dm-1", body: "owner here", sender: { id: "owner" } });
    check("dm: matching chatId → accepted, submitted to sess-D", rDm.accepted === true && submitted.length === 2 && submitted[1].sid === "sess-D");
    const rDmNoSender = await gw.handleInbound({ channel: "telegram", chatId: "dm-1", body: "still owner" });
    check("dm: matching chatId with NO sender → still accepted (route IS the proof)", rDmNoSender.accepted === true && submitted.length === 3);

    // A removed allowlist entry takes effect LIVE (the auth reads the db per-inbound, no restart).
    db.removeAllowedSender(db.listAllowedSenders("sess-G")[0].id);
    const rAliceGone = await gw.handleInbound({ channel: "telegram", chatId: "group-1", body: "hi again", sender: { id: "alice" } });
    check("group: removing the allowlist row revokes access LIVE", rAliceGone.accepted === false && rAliceGone.reason === "sender-not-authorized" && submitted.length === 3);

    db.close();
  }

  // ============ Part 2 — durable round-trip + the UNIQUE route index (test 5) ============
  {
    const db1 = new Db(dbFile("p2.db"));
    db1.upsertCompanionBinding({ sessionId: "sess-G", channel: "telegram", chatId: "group-1", scope: "group" });
    db1.addAllowedSender({ sessionId: "sess-G", channel: "telegram", senderId: "alice" });
    db1.setCompanionHome("sess-G", { channel: "telegram", chatId: "home-1" });
    db1.close();

    const db2 = new Db(dbFile("p2.db")); // reopen the SAME db file — proves persistence
    const bindings = db2.listCompanionBindings();
    check("durable: binding persisted across reopen", bindings.length === 1 && bindings[0].sessionId === "sess-G" && bindings[0].scope === "group");
    check("durable: allowlist persisted + isSenderAllowed reads it", db2.isSenderAllowed("sess-G", "telegram", "alice") === true);
    check("durable: isSenderAllowed false for an unlisted id", db2.isSenderAllowed("sess-G", "telegram", "mallory") === false);
    check("durable: home persisted across reopen (PER SESSION)", JSON.stringify(db2.getCompanionHome("sess-G")) === JSON.stringify({ channel: "telegram", chatId: "home-1" }));
    check("durable: a DIFFERENT session's home is untouched", db2.getCompanionHome("sess-D") === null);

    // The UNIQUE (channel, chat_id) route index: a 2nd, DIFFERENT session claiming the bound route is rejected.
    let threw = false;
    try { db2.upsertCompanionBinding({ sessionId: "sess-OTHER", channel: "telegram", chatId: "group-1", scope: "dm" }); } catch { threw = true; }
    check("durable: UNIQUE route index rejects a 2nd session for the same (channel, chatId)", threw === true);
    check("durable: the rejected 2nd session left no row", db2.listCompanionBindings().length === 1);
    // Re-binding the SAME session to a NEW route is an in-place update (not a dup).
    db2.upsertCompanionBinding({ sessionId: "sess-G", channel: "telegram", chatId: "group-2", scope: "group" });
    const after = db2.listCompanionBindings();
    check("durable: re-binding the same session updates in place", after.length === 1 && after[0].chatId === "group-2");
    db2.close();
  }

  // ============ Part 3 — the default (db-free) allow-if-DM-match auth ============
  {
    const auth = allowIfDmMatch();
    check("default-auth: DM binding authorized (single-owner route match)", auth.isSenderAuthorized({ sessionId: "s", channel: "telegram", chatId: "c", scope: "dm" }, { id: "x" }) === true);
    check("default-auth: GROUP binding REJECTED (no allowlist to consult)", auth.isSenderAuthorized({ sessionId: "s", channel: "telegram", chatId: "c", scope: "group" }, { id: "x" }) === false);
  }

  // ============ Part 4 — HUMAN-ONLY: no companion admin tool on ANY agent-facing MCP surface (test 7) ============
  {
    // Enumerate EVERY agent-facing MCP router (orchestration manager+assistant, setup, platform, audit,
    // user-audit) and assert none carries a binding/allowlist/home tool — the companion admin surface is
    // human-only loopback REST, reachable by NO agent. buildServer registers tools without invoking their
    // handlers, so a real Db + a fake-pty SessionService (createPty never reached) is enough; some
    // buildServer methods are TS-private but plain methods at runtime (see companion-loop.mjs).
    const db = new Db(dbFile("p4.db"));
    class SeamHost extends PtyHost {
      createPty() { return { pid: 1, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} }; }
      stop() {}
    }
    const host = new SeamHost({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} });
    const svc = new SessionService(db, host, new OrchestrationControl());
    const orch = new OrchestrationMcpRouter(db, svc, { companionSessionIds: new Set(["assist-1"]), deliverReply: async () => ({ delivered: true }) });

    const listOf = async (server) => {
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      await server.connect(serverT);
      const client = new Client({ name: "authz-test", version: "0" });
      await client.connect(clientT);
      const names = (await client.listTools()).tools.map((t) => t.name);
      await client.close();
      return names;
    };

    const managerTools = await listOf(orch.buildServer("mgr-1", "manager"));
    const assistantTools = await listOf(orch.buildServer("assist-1", "assistant"));
    const surfaces = {
      "orchestration:manager": managerTools,
      "orchestration:assistant": assistantTools,
      setup: await listOf(new SetupMcpRouter(db, svc).buildServer()),
      platform: await listOf(new PlatformMcpRouter(db, svc).buildServer()),
      audit: await listOf(new AuditMcpRouter(db, svc).buildServer("aud-1")),
      "user-audit": await listOf(new WorkspaceAuditMcpRouter(db, svc).buildServer("aud-1")),
    };

    // The companion admin surface (bindings/allowlist/home writers + DM-pairing MINT) exists on NO
    // agent-facing MCP router — the pairing mint is human-only loopback REST, so `pairing` is guarded here too.
    const forbidden = /bind|allow|home|sender|pairing/i;
    for (const [name, tools] of Object.entries(surfaces)) {
      const bad = tools.filter((t) => forbidden.test(t));
      check(`human-only: the ${name} MCP surface (${tools.length} tools) has NO binding/allowlist/home tool (found: ${bad.join(",") || "none"})`, bad.length === 0);
    }
    // The companion agent's companion surface is chat_reply + its self-authored skill + memory tools (Phase 2)
    // + its recurring reminder tools (s4) — never an admin writer (bindings/allowlist/home stay human-only
    // REST, asserted by the `forbidden` gate above).
    const companionSkillTools = new Set([
      "skill_author", "skill_list", "skill_read", "skill_remove",
      "memory_write", "memory_list", "memory_read", "memory_remove",
      "reminder_create", "reminder_list", "reminder_cancel",
    ]);
    check("human-only: the assistant's tools are chat_reply + my_context + its skill/memory/reminder tools (no admin writer)", assistantTools.includes("chat_reply") && assistantTools.every((t) => t === "chat_reply" || t === "my_context" || companionSkillTools.has(t)));
    check("human-only: a non-companion manager never even gets chat_reply", !managerTools.includes("chat_reply"));
    // Negative control — prove the substring gate HAS TEETH (a hypothetical admin tool WOULD be caught).
    check("human-only: negative control — a phantom 'companion_bind' tool WOULD trip the gate", forbidden.test("companion_bind"));
    db.close();
  }

  // ============ Part 5 — the human-only admin REST surface via the REAL buildServer (app.inject) ============
  // Drives the routes end-to-end (every non-db dep stubbed; no network) — and proves Fix [1]: the bind
  // endpoint REQUIRES an explicit scope (a group chat bound without scope would silently admit everyone).
  {
    const db = new Db(dbFile("p5.db"));
    const bound = [], unbound = [], reconciled = [];
    const stub = {};
    // `reconcile` mirrors the scoped no-op every REST config/home writer now calls post-write (card af12f808)
    // — a real CompanionController would refresh its live cfgs cache here; this stub just records the call.
    const companion = { bind: (b) => bound.push(b), unbind: (id, channel) => unbound.push({ sessionId: id, channel }), reconcile: async (sessionId) => { reconciled.push(sessionId); } };
    const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub, companion });

    // Real assistant-role sessions backing every sessionId this part POSTs to a write route (the
    // write routes now resolve the session via resolveCompanionAgent, same as the read routes).
    const p5Now = new Date().toISOString();
    db.insertProject({ id: "p5-proj", name: "Authz REST", repoPath: "p5-proj", vaultPath: "p5-proj", config: {}, createdAt: p5Now, archivedAt: null });
    db.insertAgent({ id: "p5-agent-asst", projectId: "p5-proj", name: "Companion", startupPrompt: "P", position: 0, profileId: null, endpoint: false, ioSchema: null });
    for (const sid of ["s1", "s2"]) {
      db.insertSession({
        id: sid, projectId: "p5-proj", agentId: "p5-agent-asst", engineSessionId: `eng-${sid}`, title: null, cwd: "p5-proj",
        processState: "live", resumability: "resumable", busy: false, createdAt: p5Now, lastActivity: p5Now, lastError: null, role: "assistant",
      });
    }

    // FIX [1]: scope is REQUIRED on the REST bind endpoint.
    const noScope = await app.inject({ method: "POST", url: "/api/companion/bindings", payload: { sessionId: "s1", channel: "telegram", chatId: "c1" } });
    check("REST bind: MISSING scope → 400 (no silent 'dm' default)", noScope.statusCode === 400);
    const badScope = await app.inject({ method: "POST", url: "/api/companion/bindings", payload: { sessionId: "s1", channel: "telegram", chatId: "c1", scope: "public" } });
    check("REST bind: invalid scope → 400", badScope.statusCode === 400);
    check("REST bind: neither 400 wrote a binding row", db.listCompanionBindings().length === 0);

    const grp = await app.inject({ method: "POST", url: "/api/companion/bindings", payload: { sessionId: "s1", channel: "telegram", chatId: "c1", scope: "group" } });
    check("REST bind: explicit scope:'group' → 201", grp.statusCode === 201 && JSON.parse(grp.payload).scope === "group");
    check("REST bind: POST poked the live gateway map (bind called)", bound.length === 1 && bound[0].sessionId === "s1" && bound[0].scope === "group");

    // A 2nd session on the same route → 409 (the unique route index).
    const dup = await app.inject({ method: "POST", url: "/api/companion/bindings", payload: { sessionId: "s2", channel: "telegram", chatId: "c1", scope: "dm" } });
    check("REST bind: a 2nd session for the same route → 409", dup.statusCode === 409);

    // Allowed-senders round-trip: add → list (session-scoped) → the authz predicate sees it.
    const addS = await app.inject({ method: "POST", url: "/api/companion/allowed-senders", payload: { sessionId: "s1", channel: "telegram", senderId: "alice", label: "Alice" } });
    check("REST allowed-senders: add → 201", addS.statusCode === 201);
    const listS = await app.inject({ method: "GET", url: "/api/companion/allowed-senders?sessionId=s1" });
    check("REST allowed-senders: session-scoped GET returns the row", JSON.parse(listS.payload).length === 1 && JSON.parse(listS.payload)[0].senderId === "alice");
    check("REST allowed-senders: GET without sessionId → 400", (await app.inject({ method: "GET", url: "/api/companion/allowed-senders" })).statusCode === 400);
    check("REST allowed-senders: the add is live in isSenderAllowed", db.isSenderAllowed("s1", "telegram", "alice") === true);
    const senderId = JSON.parse(listS.payload)[0].id;
    await app.inject({ method: "DELETE", url: `/api/companion/allowed-senders/${senderId}` });
    check("REST allowed-senders: DELETE revokes it (live)", db.isSenderAllowed("s1", "telegram", "alice") === false);

    // Home GET/PUT round-trip — PER SESSION (multi-companion cross-delivery fix): every route requires
    // sessionId, and a 2nd session's home is untouched by the 1st's write.
    check("REST home: GET without sessionId → 400", (await app.inject({ method: "GET", url: "/api/companion/home" })).statusCode === 400);
    check("REST home: GET is null before set", JSON.parse((await app.inject({ method: "GET", url: "/api/companion/home?sessionId=s1" })).payload ?? "null") === null);
    const putMissingSid = await app.inject({ method: "PUT", url: "/api/companion/home", payload: { channel: "telegram", chatId: "home-9" } });
    check("REST home: PUT missing sessionId → 400", putMissingSid.statusCode === 400);
    const putHome = await app.inject({ method: "PUT", url: "/api/companion/home", payload: { sessionId: "s1", channel: "telegram", chatId: "home-9" } });
    check("REST home: PUT sets + echoes", putHome.statusCode === 200 && JSON.parse(putHome.payload).chatId === "home-9");
    // card af12f808: a home write must reconcile the controller LIVE (scoped to the ONE session that changed)
    // so its cfgs cache never goes stale — see companion-home-cache.mjs for the full cache-refresh proof.
    check("REST home: PUT reconciles the controller, scoped to s1", reconciled[reconciled.length - 1] === "s1");
    check("REST home: PUT missing chatId → 400", (await app.inject({ method: "PUT", url: "/api/companion/home", payload: { sessionId: "s1", channel: "telegram" } })).statusCode === 400);
    check("REST home: a DIFFERENT session's home is untouched by s1's PUT", JSON.parse((await app.inject({ method: "GET", url: "/api/companion/home?sessionId=s2" })).payload ?? "null") === null);
    check("REST home: DELETE without sessionId → 400", (await app.inject({ method: "DELETE", url: "/api/companion/home" })).statusCode === 400);
    const delHome = await app.inject({ method: "DELETE", url: "/api/companion/home?sessionId=s1" });
    check("REST home: DELETE clears it (proactive heartbeat turns OFF for that session)", delHome.statusCode === 200 && db.getCompanionHome("s1") === null);
    check("REST home: DELETE reconciles the controller, scoped to s1", reconciled[reconciled.length - 1] === "s1");

    // DELETE a binding (no channel) → the live map is unbound too (channel undefined ⇒ omit path).
    await app.inject({ method: "DELETE", url: "/api/companion/bindings/s1" });
    check("REST bind DELETE: removed the row + unbound the live map", db.listCompanionBindings().length === 0
      && unbound.some((u) => u.sessionId === "s1" && u.channel === undefined));

    // ---- card 7bf124c8: the PER-CHANNEL unbind ROUTE ITSELF (query-param parse → isNonBlankStr guard →
    // .trim() → scoped db.deleteCompanionBinding/companion.unbind calls) — driven end-to-end via app.inject,
    // never bypassing the route wiring the connect-Telegram UI will actually call. ----
    db.upsertCompanionBinding({ sessionId: "s3", channel: IN_APP_CHANNEL, chatId: "s3", scope: "dm" });
    db.upsertCompanionBinding({ sessionId: "s3", channel: "telegram", chatId: "tg-s3", scope: "dm" });
    check("REST bind DELETE ?channel=: both channel bindings present before delete", db.listCompanionBindings().filter((b) => b.sessionId === "s3").length === 2);

    const delTelegram = await app.inject({ method: "DELETE", url: "/api/companion/bindings/s3?channel=telegram" });
    check("REST bind DELETE ?channel=telegram: 200 ok", delTelegram.statusCode === 200 && JSON.parse(delTelegram.payload).ok === true);
    const s3After = db.listCompanionBindings().filter((b) => b.sessionId === "s3");
    check("REST bind DELETE ?channel=telegram: ONLY telegram removed, in-app SURVIVES", s3After.length === 1 && s3After[0].channel === IN_APP_CHANNEL);
    check("REST bind DELETE ?channel=telegram: the route threaded the channel into companion.unbind",
      unbound.some((u) => u.sessionId === "s3" && u.channel === "telegram"));

    const delBlank = await app.inject({ method: "DELETE", url: "/api/companion/bindings/s3?channel=" });
    check("REST bind DELETE ?channel= (blank): 400 before any db write", delBlank.statusCode === 400);
    check("REST bind DELETE ?channel= (blank): the surviving in-app binding is untouched", db.listCompanionBindings().filter((b) => b.sessionId === "s3").length === 1);

    const delAll = await app.inject({ method: "DELETE", url: "/api/companion/bindings/s3" });
    check("REST bind DELETE (no channel param): still 200", delAll.statusCode === 200);
    check("REST bind DELETE (no channel param): removes ALL remaining bindings — omit path unchanged at the HTTP layer", db.listCompanionBindings().filter((b) => b.sessionId === "s3").length === 0);

    await app.close();
    db.close();
  }
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the Companion authz layer holds: GROUP bindings require an allowlisted sender (missing/unlisted → hard reject, never submitted), DM stays single-owner, the durable store round-trips + the unique route index blocks a 2nd session per route, default-OFF writes nothing, the REST bind endpoint REQUIRES an explicit scope, and NO binding/allowlist/home tool exists on ANY agent-facing MCP surface (admin is loopback REST only)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
