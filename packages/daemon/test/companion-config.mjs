import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Loom Companion — the DB-backed RUN-config layer (Companion epic Phase 3, SECURITY-CRITICAL). Fully
// hermetic: a REAL Db on a temp LOOM_HOME + the REAL buildServer (app.inject) + the REAL envelope key file
// under the temp home; NO live network, NO real claude, NO daemon, NO live Telegram. The bot token is an
// OUTWARD credential the daemon must decrypt to use, so the whole point of this layer is: encrypted at
// rest, decrypted only internally, and NEVER returned in clear or logged. These assert it holds:
//   0. default-OFF byte-identical: no env + no DB row ⇒ resolveAllCompanionConfigs empty + no row written.
//   1. round-trip + encryption-at-rest + masked read: the stored blob is CIPHERTEXT (plaintext absent),
//      decrypts internally to the token, but the masked view is configured:true + last-4 only (plaintext
//      NEVER present in the masked JSON).
//   2. env bootstrap + OVERRIDE precedence: LOOM_COMPANION_* with no row seeds the row (token encrypted) +
//      lays app_meta home; with BOTH env and a row, env WINS; an enabled row with no env resolves; a
//      disabled row / a corrupt blob ⇒ dropped (never a crash); MORE THAN ONE enabled row resolves ALL of
//      them (multi-companion runtime — no more "pick one, warn the rest away").
//   3. REST CRUD via the real buildServer: POST→GET(masked)→PUT→DELETE, token never in ANY body, the stored
//      blob is ciphertext, and every validation 400 leaves no row.
//   3b. WRITE-ROUTE ROLE GATE: POST /config, /bindings, /allowed-senders, /pairing resolve the sessionId via
//      the SAME resolveCompanionAgent the read routes use — a non-assistant (manager/worker) sessionId is
//      refused (400, matching the read routes' error shape) and writes no row; an assistant sessionId still
//      succeeds on every one of the four routes.
//   4. token never in any captured log line across the whole run.
//   5. HUMAN-ONLY: the companion's OWN agent-facing MCP surface (orchestration assistant + manager) carries
//      NO config/token tool — it can never read/write its own bot token.
// Run: 1) build (turbo builds shared first), 2) node test/companion-config.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-companion-config-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME
// Ensure the ambient process env carries NO real companion vars (a dev shell might) — every env-path test
// passes an EXPLICIT env object, so the resolver never reads process.env here; belt-and-suspenders.
for (const k of Object.keys(process.env)) if (k.startsWith("LOOM_COMPANION_")) delete process.env[k];

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv(); // confirm LOOM_HOME is the temp dir (no port — no HTTP daemon; app.inject only)

// --- Capture EVERY console line (teed, still printed) so we can prove the plaintext token never logs. ---
const logSink = [];
for (const m of ["log", "warn", "error", "info"]) {
  const orig = console[m].bind(console);
  console[m] = (...args) => { logSink.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")); orig(...args); };
}

const { Db } = await import("../dist/db.js");
const { resolveAllCompanionConfigs, maskCompanionConfig } = await import("../dist/companion/store.js");
const { encryptSecret, decryptSecret } = await import("../dist/keys/envelope.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

const dbFile = (name) => path.join(tmpHome, name);
// A distinctive plaintext token used throughout — its presence in ANY body/blob/log is a hard failure.
const PLAINTEXT = "8123456789:AAHsecret-DO-NOT-LEAK-abcdefghij";
const LAST4 = PLAINTEXT.slice(-4);

try {
  // ============ Part 0 — DEFAULT-OFF byte-identical ============
  {
    const db = new Db(dbFile("p0.db"));
    check("default-off: pristine db has NO companion configs", db.listCompanionConfigs().length === 0);
    check("default-off: getCompanionConfig(any) is undefined", db.getCompanionConfig("nope") === undefined);
    check("default-off: no env + no row ⇒ resolveAllCompanionConfigs empty (companion never built)", resolveAllCompanionConfigs(db, {}).length === 0);
    check("default-off: the resolve wrote NO row (reads/OFF never seed)", db.listCompanionConfigs().length === 0);
    db.close();
  }

  // ============ Part 1 — round-trip + encryption at rest + masked read ============
  {
    const db = new Db(dbFile("p1.db"));
    const blob = encryptSecret(PLAINTEXT);
    const stored = db.upsertCompanionConfig({
      sessionId: "sess-1", botTokenBlob: blob, channel: "telegram", allowedChatId: "chat-1",
      chatScope: "dm", heartbeatIntervalMinutes: 360, heartbeatPrompt: null, enabled: true,
    });
    check("round-trip: upsert stamped created_at + updated_at", !!stored.createdAt && !!stored.updatedAt);
    const row = db.getCompanionConfig("sess-1");
    check("round-trip: the row reads back", !!row && row.sessionId === "sess-1" && row.allowedChatId === "chat-1");
    // Encryption AT REST: the stored blob is ciphertext, NOT the plaintext (and doesn't contain it).
    check("at-rest: stored blob is NOT the plaintext token", row.botTokenBlob !== PLAINTEXT);
    check("at-rest: stored blob does NOT contain the plaintext substring", !row.botTokenBlob.includes(PLAINTEXT));
    check("at-rest: stored blob is a v1 envelope", row.botTokenBlob.startsWith("v1:"));
    // Internally the daemon CAN decrypt it back (that's the point of a recoverable envelope).
    check("at-rest: decrypts internally back to the exact token", decryptSecret(row.botTokenBlob) === PLAINTEXT);
    // Masked read: configured + last-4 only — the plaintext is NEVER present in the masked JSON.
    const masked = maskCompanionConfig(row, db.getCompanionHome("sess-1"));
    check("masked: configured:true", masked.configured === true);
    check("masked: exposes ONLY the last-4 of the token", masked.tokenLast4 === LAST4);
    check("masked: carries channel/cadence/scope/enabled", masked.channel === "telegram" && masked.heartbeatIntervalMinutes === 360 && masked.chatScope === "dm" && masked.enabled === true);
    check("masked: name is empty string when never named", masked.name === "");
    // name round-trip: a config given a name surfaces it in the masked read (the read-back fix under test).
    const named = db.upsertCompanionConfig({
      sessionId: "sess-1", botTokenBlob: blob, channel: "telegram", allowedChatId: "chat-1",
      chatScope: "dm", heartbeatIntervalMinutes: 360, heartbeatPrompt: null, enabled: true, name: "Ada",
    });
    check("masked: a set name round-trips through maskCompanionConfig", maskCompanionConfig(named, db.getCompanionHome("sess-1")).name === "Ada");
    const maskedJson = JSON.stringify(masked);
    check("masked: the plaintext token is ABSENT from the masked JSON", !maskedJson.includes(PLAINTEXT));
    check("masked: no property named like a token blob leaked", !maskedJson.includes("botToken") && !maskedJson.includes("v1:"));
    // envPinned: false with no env; true only when an env config targets THIS row's sessionId.
    check("masked: envPinned false when no env passed", masked.envPinned === false);
    const envMatch = { LOOM_COMPANION_BOT_TOKEN: "t", LOOM_COMPANION_CHAT_ID: "c", LOOM_COMPANION_SESSION_ID: "sess-1" };
    check("masked: envPinned TRUE when env config targets this row's sessionId (env would override on next boot)", maskCompanionConfig(row, db.getCompanionHome("sess-1"), envMatch).envPinned === true);
    const envOther = { LOOM_COMPANION_BOT_TOKEN: "t", LOOM_COMPANION_CHAT_ID: "c", LOOM_COMPANION_SESSION_ID: "other-sess" };
    check("masked: envPinned FALSE when env targets a DIFFERENT session", maskCompanionConfig(row, db.getCompanionHome("sess-1"), envOther).envPinned === false);
    db.close();
  }

  // ============ Part 2 — env bootstrap + OVERRIDE precedence + OFF edge cases (resolveAllCompanionConfigs) ============
  {
    // (2a) env set, NO existing row → boot seeding creates the row (token encrypted) + lays app_meta home.
    const db = new Db(dbFile("p2a.db"));
    const env = {
      LOOM_COMPANION_BOT_TOKEN: PLAINTEXT, LOOM_COMPANION_CHAT_ID: "chat-env", LOOM_COMPANION_SESSION_ID: "sess-env",
      LOOM_COMPANION_HEARTBEAT_INTERVAL_MINUTES: "120",
    };
    const resolved = resolveAllCompanionConfigs(db, env);
    check("env-bootstrap: resolves a live config", resolved.length === 1 && resolved[0].sessionId === "sess-env" && resolved[0].botToken === PLAINTEXT);
    check("env-bootstrap: cadence carried from env", resolved[0].heartbeatIntervalMinutes === 120);
    const seeded = db.getCompanionConfig("sess-env");
    check("env-bootstrap: a DB row was seeded", !!seeded && seeded.allowedChatId === "chat-env");
    check("env-bootstrap: the seeded token is ENCRYPTED (blob decrypts to the token, not stored plaintext)", seeded.botTokenBlob !== PLAINTEXT && decryptSecret(seeded.botTokenBlob) === PLAINTEXT);
    check("env-bootstrap: app_meta home laid from env, PER SESSION (defaults to allowedChatId)", JSON.stringify(db.getCompanionHome("sess-env")) === JSON.stringify({ channel: "telegram", chatId: "chat-env" }));
    db.close();

    // (2b) BOTH env AND a pre-existing DB row (SAME session) → env OVERRIDES (env wins per the PL ruling).
    const db2 = new Db(dbFile("p2b.db"));
    db2.upsertCompanionConfig({
      sessionId: "sess-1", botTokenBlob: encryptSecret("DB-OLD-TOKEN-should-be-overridden"), channel: "telegram",
      allowedChatId: "chat-DB-old", chatScope: "dm", heartbeatIntervalMinutes: 999, heartbeatPrompt: "old", enabled: true,
    });
    const envOverride = {
      LOOM_COMPANION_BOT_TOKEN: PLAINTEXT, LOOM_COMPANION_CHAT_ID: "chat-ENV-new", LOOM_COMPANION_SESSION_ID: "sess-1",
      LOOM_COMPANION_HEARTBEAT_INTERVAL_MINUTES: "45",
    };
    const over = resolveAllCompanionConfigs(db2, envOverride);
    check("env-override: resolved config reflects ENV token", over.length === 1 && over[0].botToken === PLAINTEXT);
    check("env-override: resolved config reflects ENV chat id + cadence", over[0].allowedChatId === "chat-ENV-new" && over[0].heartbeatIntervalMinutes === 45);
    const overRow = db2.getCompanionConfig("sess-1");
    check("env-override: the DB row was overwritten to env (blob decrypts to env token)", decryptSecret(overRow.botTokenBlob) === PLAINTEXT && overRow.allowedChatId === "chat-ENV-new" && overRow.heartbeatIntervalMinutes === 45);
    db2.close();

    // (2c) NO env, an enabled DB row present → resolve picks it up (the REST-configured, env-free path).
    const db3 = new Db(dbFile("p2c.db"));
    db3.upsertCompanionConfig({
      sessionId: "sess-rest", botTokenBlob: encryptSecret(PLAINTEXT), channel: "telegram", allowedChatId: "chat-rest",
      chatScope: "group", heartbeatIntervalMinutes: 0, heartbeatPrompt: null, enabled: true,
    });
    const noEnv = resolveAllCompanionConfigs(db3, {});
    check("no-env: an enabled DB row alone resolves (REST-configured companion boots)", noEnv.length === 1 && noEnv[0].sessionId === "sess-rest" && noEnv[0].botToken === PLAINTEXT && noEnv[0].chatScope === "group");

    // (2d) a DISABLED row + no env → OFF (empty array).
    db3.upsertCompanionConfig({
      sessionId: "sess-rest", botTokenBlob: encryptSecret(PLAINTEXT), channel: "telegram", allowedChatId: "chat-rest",
      chatScope: "group", heartbeatIntervalMinutes: 0, heartbeatPrompt: null, enabled: false,
    });
    check("disabled: a disabled row + no env ⇒ OFF (empty array)", resolveAllCompanionConfigs(db3, {}).length === 0);
    db3.close();

    // (2e) a CORRUPT/undecryptable blob → dropped from the set (OFF for that row), never a crash.
    const db4 = new Db(dbFile("p2e.db"));
    db4.upsertCompanionConfig({
      sessionId: "sess-x", botTokenBlob: "not-a-valid-envelope", channel: "telegram", allowedChatId: "chat-x",
      chatScope: "dm", heartbeatIntervalMinutes: 0, heartbeatPrompt: null, enabled: true,
    });
    let threw = false, corrupt;
    try { corrupt = resolveAllCompanionConfigs(db4, {}); } catch { threw = true; }
    check("corrupt: an undecryptable blob ⇒ dropped (empty array), NOT a crash", threw === false && corrupt.length === 0);
    db4.close();

    // (2f) MULTI-COMPANION (the whole point of the card): MORE THAN ONE enabled row on DISTINCT tokens + no
    // env → resolves ALL of them (every enabled row gets its own CompanionConfig, no "pick one + warn the
    // rest away"). Same-TOKEN collision is a SEPARATE guard (2g below) — distinct tokens stay first-class.
    const db5 = new Db(dbFile("p2f.db"));
    const TOKEN_DISTINCT_A = "8100000001:AAA-distinct-token-A-abcdefg";
    const TOKEN_DISTINCT_B = "8100000002:BBB-distinct-token-B-abcdefg";
    db5.upsertCompanionConfig({ sessionId: "sess-A", botTokenBlob: encryptSecret(TOKEN_DISTINCT_A), channel: "telegram", allowedChatId: "chat-A", chatScope: "dm", heartbeatIntervalMinutes: 0, heartbeatPrompt: null, enabled: true });
    db5.upsertCompanionConfig({ sessionId: "sess-B", botTokenBlob: encryptSecret(TOKEN_DISTINCT_B), channel: "telegram", allowedChatId: "chat-B", chatScope: "dm", heartbeatIntervalMinutes: 0, heartbeatPrompt: null, enabled: true });
    const warnBefore = logSink.filter((l) => /shares its Telegram bot token/.test(l)).length;
    const multi = resolveAllCompanionConfigs(db5, {});
    const warnAfter = logSink.filter((l) => /shares its Telegram bot token/.test(l)).length;
    check(">1-enabled (distinct tokens): resolves BOTH enabled rows (multi-companion runtime)", multi.length === 2 && multi.some((c) => c.sessionId === "sess-A") && multi.some((c) => c.sessionId === "sess-B"));
    check(">1-enabled (distinct tokens): emits NO shared-token warning (distinct tokens are first-class, not a misconfiguration)", warnAfter === warnBefore);
    // A single enabled row still resolves to exactly that one (no regression from the multi-row case).
    db5.upsertCompanionConfig({ sessionId: "sess-B", botTokenBlob: encryptSecret(TOKEN_DISTINCT_B), channel: "telegram", allowedChatId: "chat-B", chatScope: "dm", heartbeatIntervalMinutes: 0, heartbeatPrompt: null, enabled: false });
    const single = resolveAllCompanionConfigs(db5, {});
    check(">1-enabled: disabling one drops it — exactly the remaining enabled row resolves", single.length === 1 && single[0].sessionId === "sess-A");
    db5.close();

    // (2g) SAME-TOKEN COLLISION GUARD (companion multi-bot-token collision guard): Telegram allows only ONE
    // getUpdates long-poll consumer per token, so two ENABLED rows sharing the SAME token must arm exactly
    // ONE (deterministically — the OLDEST/created-first row, since listCompanionConfigs orders by
    // created_at, rowid) and SKIP the rest with a clear diagnostic naming both sessions, instead of letting
    // the 2nd thrash forever on Telegram's HTTP 409.
    const db6 = new Db(dbFile("p2g.db"));
    db6.upsertCompanionConfig({ sessionId: "sess-old", botTokenBlob: encryptSecret(PLAINTEXT), channel: "telegram", allowedChatId: "chat-old", chatScope: "dm", heartbeatIntervalMinutes: 0, heartbeatPrompt: null, enabled: true });
    db6.upsertCompanionConfig({ sessionId: "sess-new", botTokenBlob: encryptSecret(PLAINTEXT), channel: "telegram", allowedChatId: "chat-new", chatScope: "dm", heartbeatIntervalMinutes: 0, heartbeatPrompt: null, enabled: true });
    const collideWarnBefore = logSink.filter((l) => /shares its Telegram bot token/.test(l)).length;
    const collided = resolveAllCompanionConfigs(db6, {});
    const collideWarnAfter = logSink.filter((l) => /shares its Telegram bot token/.test(l)).length;
    check("same-token collision: arms exactly ONE of the two (the oldest, sess-old)", collided.length === 1 && collided[0].sessionId === "sess-old");
    check("same-token collision: emits exactly one diagnostic naming BOTH sessions", collideWarnAfter === collideWarnBefore + 1 && logSink.some((l) => l.includes("sess-old") && l.includes("sess-new") && /shares its Telegram bot token/.test(l)));
    check("same-token collision: the diagnostic never leaks the plaintext token", logSink.every((l) => !l.includes(PLAINTEXT)));
    // Once given a DISTINCT token, the previously-skipped session arms too (the guard is token-scoped only).
    db6.upsertCompanionConfig({ sessionId: "sess-new", botTokenBlob: encryptSecret(TOKEN_DISTINCT_B), channel: "telegram", allowedChatId: "chat-new", chatScope: "dm", heartbeatIntervalMinutes: 0, heartbeatPrompt: null, enabled: true });
    const distinctNow = resolveAllCompanionConfigs(db6, {});
    check("same-token collision: given a distinct token, BOTH sessions now arm", distinctNow.length === 2);
    db6.close();
  }

  // ============ Part 3 — the human-only REST CRUD via the REAL buildServer (app.inject) ============
  {
    const db = new Db(dbFile("p3.db"));
    const stub = {};
    const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub });
    const bodies = []; // every response body — swept for the plaintext at the end.
    const inject = async (opts) => { const r = await app.inject(opts); bodies.push(r.payload); return r; };

    // Real assistant-role sessions backing every sessionId this part exercises on a WRITE route (the
    // write routes now resolve the session via resolveCompanionAgent, same as the read routes) — plus one
    // non-assistant (worker) session to prove the write-route role gate below.
    const p3Now = new Date().toISOString();
    db.insertProject({ id: "p3-proj", name: "Config REST", repoPath: "p3-proj", vaultPath: "p3-proj", config: {}, createdAt: p3Now, archivedAt: null });
    db.insertAgent({ id: "p3-agent-asst", projectId: "p3-proj", name: "Companion", startupPrompt: "P", position: 0, profileId: null, endpoint: false, ioSchema: null });
    for (const sid of ["sess-1", "sess-2", "fresh"]) {
      db.insertSession({
        id: sid, projectId: "p3-proj", agentId: "p3-agent-asst", engineSessionId: `eng-${sid}`, title: null, cwd: "p3-proj",
        processState: "live", resumability: "resumable", busy: false, createdAt: p3Now, lastActivity: p3Now, lastError: null, role: "assistant",
      });
    }
    db.insertAgent({ id: "p3-agent-worker", projectId: "p3-proj", name: "Worker", startupPrompt: "W", position: 1, profileId: null, endpoint: false, ioSchema: null });
    db.insertSession({
      id: "sess-worker", projectId: "p3-proj", agentId: "p3-agent-worker", engineSessionId: "eng-sess-worker", title: null, cwd: "p3-proj",
      processState: "live", resumability: "resumable", busy: false, createdAt: p3Now, lastActivity: p3Now, lastError: null, role: "worker",
    });

    // Empty list to start.
    const list0 = await inject({ method: "GET", url: "/api/companion/config" });
    check("REST GET: empty list before any create", list0.statusCode === 200 && JSON.parse(list0.payload).length === 0);

    // CREATE.
    const create = await inject({ method: "POST", url: "/api/companion/config", payload: {
      sessionId: "sess-1", botToken: PLAINTEXT, allowedChatId: "chat-1", chatScope: "dm",
      heartbeatIntervalMinutes: 360, home: { channel: "telegram", chatId: "home-1" },
    } });
    const created = JSON.parse(create.payload);
    check("REST POST: create → 201 masked", create.statusCode === 201 && created.configured === true && created.tokenLast4 === LAST4);
    check("REST POST: masked create carries home from the body", JSON.stringify(created.home) === JSON.stringify({ channel: "telegram", chatId: "home-1" }));
    check("REST POST: envPinned false (no LOOM_COMPANION_* in process.env)", created.envPinned === false);
    check("REST POST: create body has NO plaintext token", !create.payload.includes(PLAINTEXT));
    // The STORED blob is ciphertext.
    check("REST POST: stored blob is encrypted (decrypts to the token, plaintext not stored)", (() => { const row = db.getCompanionConfig("sess-1"); return row.botTokenBlob !== PLAINTEXT && decryptSecret(row.botTokenBlob) === PLAINTEXT; })());

    // GET (list + by id) masked.
    const getList = await inject({ method: "GET", url: "/api/companion/config" });
    check("REST GET list: one masked row, last-4 only", getList.statusCode === 200 && JSON.parse(getList.payload).length === 1 && JSON.parse(getList.payload)[0].tokenLast4 === LAST4);
    const getOne = await inject({ method: "GET", url: "/api/companion/config/sess-1" });
    check("REST GET by id: masked row", getOne.statusCode === 200 && JSON.parse(getOne.payload).sessionId === "sess-1");
    check("REST GET by id: unknown session → 404", (await inject({ method: "GET", url: "/api/companion/config/nope" })).statusCode === 404);

    // UPDATE via POST (upsert), tokenless → the stored token is PRESERVED, cadence changes → 200.
    const upd = await inject({ method: "POST", url: "/api/companion/config", payload: { sessionId: "sess-1", heartbeatIntervalMinutes: 30 } });
    check("REST POST update (tokenless): → 200, cadence updated, token PRESERVED (last-4 unchanged)", upd.statusCode === 200 && JSON.parse(upd.payload).heartbeatIntervalMinutes === 30 && JSON.parse(upd.payload).tokenLast4 === LAST4);

    // PUT a NEW token → last-4 changes; the new blob is ciphertext.
    const NEWTOKEN = "9999999999:BBBnew-secret-token-zzz9876";
    const put = await inject({ method: "PUT", url: "/api/companion/config/sess-1", payload: { botToken: NEWTOKEN } });
    check("REST PUT: new token → 200, last-4 reflects the NEW token", put.statusCode === 200 && JSON.parse(put.payload).tokenLast4 === NEWTOKEN.slice(-4));
    check("REST PUT: new blob is ciphertext (decrypts to the new token)", (() => { const row = db.getCompanionConfig("sess-1"); return decryptSecret(row.botTokenBlob) === NEWTOKEN; })());
    check("REST PUT: body carries neither the old nor the new plaintext token", !put.payload.includes(PLAINTEXT) && !put.payload.includes(NEWTOKEN));
    check("REST PUT: unknown session → 404", (await inject({ method: "PUT", url: "/api/companion/config/ghost", payload: { botToken: NEWTOKEN } })).statusCode === 404);

    // --- SAME-TOKEN COLLISION GUARD (companion multi-bot-token collision guard): the REST config-set path
    // rejects a create/edit that would arm a Telegram token already used by another ENABLED companion —
    // catching it before the reconcile-time skip-and-warn safety net ever has to act. `sess-1` is currently
    // enabled on NEWTOKEN (from the PUT above).
    const collideCreate = await inject({ method: "POST", url: "/api/companion/config", payload: {
      sessionId: "sess-2", botToken: NEWTOKEN, allowedChatId: "chat-2", chatScope: "dm",
    } });
    check("REST POST: creating a 2nd ENABLED companion on sess-1's token → 409", collideCreate.statusCode === 409 && /already used by another enabled companion/.test(JSON.parse(collideCreate.payload).error));
    check("REST POST: the rejected collision leaves NO 'sess-2' row", db.getCompanionConfig("sess-2") === undefined);
    check("REST POST: the collision error names the OTHER session, never the plaintext token", !collideCreate.payload.includes(NEWTOKEN) && collideCreate.payload.includes("sess-1".slice(0, 8)));

    // A DISABLED create on the same token is unaffected (never armed, so never a collision).
    const disabledSameToken = await inject({ method: "POST", url: "/api/companion/config", payload: {
      sessionId: "sess-2", botToken: NEWTOKEN, allowedChatId: "chat-2", chatScope: "dm", enabled: false,
    } });
    check("REST POST: a DISABLED create on the same token is NOT a collision → 201", disabledSameToken.statusCode === 201);

    // A DIFFERENT token for sess-2 (now enabling it) succeeds — distinct tokens are never a collision.
    const TOKEN_SESS2 = "7000000001:sess-2-own-distinct-token-xyz";
    const enableDistinct = await inject({ method: "PUT", url: "/api/companion/config/sess-2", payload: { botToken: TOKEN_SESS2, enabled: true } });
    check("REST PUT: enabling sess-2 on its OWN distinct token succeeds → 200", enableDistinct.statusCode === 200);

    // Now editing sess-2 to sess-1's token (both enabled) → 409, and sess-2's stored token is UNCHANGED.
    const collidePut = await inject({ method: "PUT", url: "/api/companion/config/sess-2", payload: { botToken: NEWTOKEN } });
    check("REST PUT: editing sess-2 onto sess-1's token (both enabled) → 409", collidePut.statusCode === 409);
    check("REST PUT: the rejected collision left sess-2's token UNCHANGED", decryptSecret(db.getCompanionConfig("sess-2").botTokenBlob) === TOKEN_SESS2);

    // Re-saving sess-1 itself (unchanged token) is NOT a self-collision.
    const selfResave = await inject({ method: "PUT", url: "/api/companion/config/sess-1", payload: { heartbeatIntervalMinutes: 15 } });
    check("REST PUT: re-saving sess-1 with its OWN unchanged token is not a self-collision → 200", selfResave.statusCode === 200);
    // Clean up sess-2 so the remaining assertions below (bodies-never-leak-PLAINTEXT sweep) aren't affected.
    await inject({ method: "DELETE", url: "/api/companion/config/sess-2" });

    // Validation 400s — none of these write/keep a bad row.
    check("REST POST: missing sessionId → 400", (await inject({ method: "POST", url: "/api/companion/config", payload: { botToken: PLAINTEXT, allowedChatId: "c" } })).statusCode === 400);
    check("REST POST: create with NO token → 400", (await inject({ method: "POST", url: "/api/companion/config", payload: { sessionId: "fresh", allowedChatId: "c" } })).statusCode === 400);
    check("REST POST: create with NO allowedChatId → 400", (await inject({ method: "POST", url: "/api/companion/config", payload: { sessionId: "fresh", botToken: PLAINTEXT } })).statusCode === 400);
    check("REST POST: invalid chatScope → 400", (await inject({ method: "POST", url: "/api/companion/config", payload: { sessionId: "fresh", botToken: PLAINTEXT, allowedChatId: "c", chatScope: "public" } })).statusCode === 400);
    check("REST POST: negative cadence → 400", (await inject({ method: "POST", url: "/api/companion/config", payload: { sessionId: "fresh", botToken: PLAINTEXT, allowedChatId: "c", heartbeatIntervalMinutes: -5 } })).statusCode === 400);
    check("REST POST: a rejected create left no 'fresh' row", db.getCompanionConfig("fresh") === undefined);

    // ---- WRITE-ROUTE ROLE GATE (bug fix regression): POST /config, /bindings, /allowed-senders, /pairing
    // now resolve the session via resolveCompanionAgent — same as the read routes — so a non-assistant
    // (manager/worker) sessionId is refused, matching the read routes' error shape, while an assistant
    // sessionId still succeeds. Previously these write routes took ANY raw sessionId with no role check.
    const wrongRoleConfig = await inject({ method: "POST", url: "/api/companion/config", payload: {
      sessionId: "sess-worker", botToken: PLAINTEXT, allowedChatId: "chat-worker",
    } });
    check("write-gate: POST /config on a worker (non-assistant) sessionId → 400", wrongRoleConfig.statusCode === 400);
    check("write-gate: POST /config error matches the read routes' shape", /not a companion \(assistant-role\) session/.test(JSON.parse(wrongRoleConfig.payload).error));
    check("write-gate: the rejected config write left no row for 'sess-worker'", db.getCompanionConfig("sess-worker") === undefined);

    const unknownSessionConfig = await inject({ method: "POST", url: "/api/companion/config", payload: {
      sessionId: "no-such-session", botToken: PLAINTEXT, allowedChatId: "chat-x",
    } });
    check("write-gate: POST /config on a sessionId with no session row at all → 404", unknownSessionConfig.statusCode === 404);

    const wrongRoleBinding = await inject({ method: "POST", url: "/api/companion/bindings", payload: {
      sessionId: "sess-worker", channel: "telegram", chatId: "chat-worker", scope: "dm",
    } });
    check("write-gate: POST /bindings on a worker sessionId → 400", wrongRoleBinding.statusCode === 400);
    check("write-gate: the rejected binding write created no binding row", db.listCompanionBindings().every((b) => b.sessionId !== "sess-worker"));

    const wrongRoleAllowedSender = await inject({ method: "POST", url: "/api/companion/allowed-senders", payload: {
      sessionId: "sess-worker", channel: "telegram", senderId: "u1",
    } });
    check("write-gate: POST /allowed-senders on a worker sessionId → 400", wrongRoleAllowedSender.statusCode === 400);

    const wrongRolePairing = await inject({ method: "POST", url: "/api/companion/pairing", payload: {
      sessionId: "sess-worker", grantType: "dm-bind",
    } });
    check("write-gate: POST /pairing on a worker sessionId → 400", wrongRolePairing.statusCode === 400);

    // An assistant-role sessionId still succeeds on every one of the four write routes (no regression).
    const okBinding = await inject({ method: "POST", url: "/api/companion/bindings", payload: {
      sessionId: "sess-1", channel: "telegram", chatId: "chat-ok", scope: "dm",
    } });
    check("write-gate: POST /bindings on an assistant sessionId still succeeds → 201", okBinding.statusCode === 201);
    const okAllowedSender = await inject({ method: "POST", url: "/api/companion/allowed-senders", payload: {
      sessionId: "sess-1", channel: "telegram", senderId: "u1",
    } });
    check("write-gate: POST /allowed-senders on an assistant sessionId still succeeds → 201", okAllowedSender.statusCode === 201);
    const okPairing = await inject({ method: "POST", url: "/api/companion/pairing", payload: {
      sessionId: "sess-1", grantType: "dm-bind",
    } });
    check("write-gate: POST /pairing on an assistant sessionId still succeeds → 201", okPairing.statusCode === 201);
    // (POST /config on an assistant sessionId is already proven throughout Part 3's create/update flow above.)

    // DELETE.
    const del = await inject({ method: "DELETE", url: "/api/companion/config/sess-1" });
    check("REST DELETE: → ok + row gone", del.statusCode === 200 && db.getCompanionConfig("sess-1") === undefined);
    check("REST DELETE: GET list empty again", JSON.parse((await inject({ method: "GET", url: "/api/companion/config" })).payload).length === 0);
    check("REST DELETE: unknown session is idempotent (200)", (await inject({ method: "DELETE", url: "/api/companion/config/whatever" })).statusCode === 200);

    // The plaintext token appears in NO response body across the whole sequence.
    check("REST: the plaintext token appears in NO response body", bodies.every((b) => !b.includes(PLAINTEXT)));

    await app.close();
    db.close();
  }

  // ============ Part 4 — the token never appears in ANY captured log line ============
  {
    check("logs: the plaintext token appears in NO captured log line", logSink.every((line) => !line.includes(PLAINTEXT)));
  }

  // ============ Part 5 — HUMAN-ONLY: the companion's own MCP surface has NO config/token tool ============
  {
    const db = new Db(dbFile("p5.db"));
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
      const client = new Client({ name: "cfg-test", version: "0" });
      await client.connect(clientT);
      const names = (await client.listTools()).tools.map((t) => t.name);
      await client.close();
      return names;
    };
    const assistantTools = await listOf(orch.buildServer("assist-1", "assistant"));
    const managerTools = await listOf(orch.buildServer("mgr-1", "manager"));
    // The companion RUN config (bot token!) is human-only loopback REST — no config/token tool on ANY agent
    // surface, LEAST OF ALL the companion's own assistant surface.
    const forbidden = /config|token/i;
    const badAssistant = assistantTools.filter((t) => forbidden.test(t));
    const badManager = managerTools.filter((t) => forbidden.test(t));
    check(`human-only: the companion assistant surface (${assistantTools.length} tools) has NO config/token tool (found: ${badAssistant.join(",") || "none"})`, badAssistant.length === 0);
    check(`human-only: the manager surface has NO config/token tool (found: ${badManager.join(",") || "none"})`, badManager.length === 0);
    // Negative control — prove the gate has teeth.
    check("human-only: negative control — a phantom 'companion_config_set' WOULD trip the gate", forbidden.test("companion_config_set"));
    db.close();
  }
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — DB-backed companion config: bot token ENCRYPTED at rest (plaintext never stored/returned/logged), masked reads expose only configured+last-4, env bootstraps + OVERRIDES the DB row, an enabled row alone boots, disabled/corrupt ⇒ OFF, default-OFF byte-identical, REST CRUD round-trips, and NO config/token tool on the companion's MCP surface."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
