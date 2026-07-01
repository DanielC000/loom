import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Loom Companion — MULTI-CHANNEL bindings (one session reachable on in-app + Telegram AT ONCE). Fully
// hermetic: a REAL Db + a REAL PtyHost driven against a FAKE pty (createPty seam) + FAKE channel adapters;
// NO live network, NO real claude, NO daemon. This is a SECURITY-sensitive change to the companion
// routing/authz table — these assert the invariants hold across >1 binding per session:
//   (a)+(b) REPLY-ON-THE-INBOUND-CHANNEL, end-to-end through a REAL PtyHost: a companion with an in-app AND a
//       Telegram binding routes each inbound to the SAME session, and the agent's chat_reply goes back on the
//       channel THAT turn came from — even when a cross-channel inbound INTERLEAVES (arrives mid-turn). NO
//       swap, NO cross-wire (the in-app adapter never gets the Telegram reply and vice versa), NO broadcast.
//       The reply target is DAEMON-resolved from the in-flight turn's pinned origin (pty.getActiveTurnOrigin)
//       — never a shared/last-inbound field, never named by the agent.
//   (d) per-binding sender authz still gates EACH channel independently (a GROUP telegram binding rejects an
//       unlisted sender while the in-app DM binding on the same session still admits by route match);
//   (e) FAIL-SAFE: a session with NO in-flight companion turn → chat_reply delivers NOWHERE (no-target),
//       never a broadcast, never a guessed channel;
//   (f) the TABLE-REBUILD migration on a DB seeded with the OLD single-PK schema + an existing binding
//       preserves that row losslessly AND allows adding a 2nd-channel binding after (impossible under the
//       old session_id PRIMARY KEY), idempotently, with the UNIQUE route index still enforced.
// Sibling coverage: the pure pty route-keyed coalescing (cross-route ⇒ distinct turns; no-route worker path
// byte-identical) is in pty-route-coalesce.mjs; heartbeat→HOME via the route in companion-heartbeat.mjs;
// provision-writes-BOTH-bindings in companion-provision.mjs (Part 2).
// Run: 1) build (turbo builds shared first), 2) node test/companion-multichannel.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-companion-multichannel-${Date.now()}-${process.pid}`);
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
const { createDbCompanionAuth } = await import("../dist/companion/auth.js");
const { IN_APP_CHANNEL } = await import("../dist/companion/in-app.js");
const { PtyHost } = await import("../dist/pty/host.js");

const TELEGRAM = "telegram";
const dbFile = (name) => path.join(tmpHome, name);
// A conformant fake ChannelAdapter recording sends (no network).
const fakeAdapter = (name) => { const sent = []; return { name, maxMessageLength: name === TELEGRAM ? 4096 : undefined, start() {}, async stop() {}, async send(chatId, text) { sent.push({ chatId, text }); }, sent }; };

// A fake IPty + a PtyHost subclass injecting it (mirrors pty-route-coalesce.mjs) — the REAL turn machinery
// (enqueueStdin route pinning + drainPending route-keyed coalescing + getActiveTurnOrigin), no real claude.
const fakes = [];
function makeFakePty() {
  const fake = { pid: 4242, write() {}, onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), kill() {}, resize() {} };
  fakes.push(fake);
  return fake;
}
class TestPtyHost extends PtyHost { createPty() { return makeFakePty(); } }
const ptyEvents = { onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} };

try {
  // ============ Part 1 — (a)+(b) REPLY-ON-THE-INBOUND-CHANNEL end-to-end, INTERLEAVED, no swap ============
  {
    const host = new TestPtyHost(ptyEvents);
    const sid = "sess-multi";
    host.spawn({ sessionId: sid, cwd: tmpHome, permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {} });
    host.deliverHook(sid, { hook_event_name: "SessionStart" }); // → ready (idle)

    const inApp = fakeAdapter(IN_APP_CHANNEL);
    const tg = fakeAdapter(TELEGRAM);
    // The gateway wired to the REAL pty EXACTLY as the daemon wires it: submitTurn pins the originating route,
    // originResolver reads the in-flight turn's pinned origin. Both bindings dm ⇒ default auth authorizes.
    const gw = new ChatGateway(
      (s, text, route) => host.enqueueStdin(s, text, "system", undefined, route),
      [{ sessionId: sid, channel: IN_APP_CHANNEL, chatId: sid, scope: "dm" }, { sessionId: sid, channel: TELEGRAM, chatId: "tg-chat", scope: "dm" }],
      undefined, undefined,
      (s) => host.getActiveTurnOrigin(s),
    );
    gw.registerAdapter(inApp);
    gw.registerAdapter(tg);

    // (1) an IN-APP inbound starts a turn (idle → submitted); its chat_reply goes back IN-APP.
    const inA = await gw.handleInbound({ channel: IN_APP_CHANNEL, chatId: sid, body: "hi via cockpit" });
    check("(a) in-app inbound routes to the session + starts a turn", inA.accepted === true && inA.sessionId === sid && inA.queued === false);
    const rA = await gw.deliverReply(sid, "reply to cockpit");
    check("(b) chat_reply for the in-app turn delivers IN-APP", rA.delivered === true && inApp.sent.length === 1 && inApp.sent[0].chatId === sid && inApp.sent[0].text === "reply to cockpit");
    check("(b) no cross-wire: telegram adapter got nothing", tg.sent.length === 0);

    // (2) a TELEGRAM inbound INTERLEAVES while the in-app turn is still in flight → QUEUED, does NOT swap the
    //     in-flight turn's origin. A chat_reply now STILL goes to in-app (the turn it answers).
    const inT = await gw.handleInbound({ channel: TELEGRAM, chatId: "tg-chat", body: "hi via telegram", sender: { id: "owner" } });
    check("(a) telegram inbound to the SAME session is accepted (queued behind the busy turn)", inT.accepted === true && inT.sessionId === sid && inT.queued === true);
    const rA2 = await gw.deliverReply(sid, "still cockpit");
    check("(b) NO-SWAP — a reply mid-turn still goes IN-APP despite the queued telegram inbound", rA2.delivered === true && inApp.sent.length === 2 && inApp.sent[1].text === "still cockpit" && tg.sent.length === 0);

    // (3) the in-app turn ends → the queued telegram inbound becomes its OWN turn → its chat_reply goes TELEGRAM.
    host.deliverHook(sid, { hook_event_name: "Stop" });
    const rT = await gw.deliverReply(sid, "reply to telegram");
    check("(b) chat_reply for the telegram turn delivers via TELEGRAM (reply-on-inbound-channel)", rT.delivered === true && tg.sent.length === 1 && tg.sent[0].chatId === "tg-chat" && tg.sent[0].text === "reply to telegram");
    check("(b) no cross-wire the other way: in-app adapter did NOT get the telegram reply", inApp.sent.length === 2 && !inApp.sent.some((s) => s.text === "reply to telegram"));

    for (const t of ["sess-multi"]) { try { host.stop(t, "hard"); } catch { /* ignore */ } }
    await sleep(50);
  }

  // ============ Part 2 — (e) FAIL-SAFE: no in-flight turn → chat_reply delivers NOWHERE (no-target) ============
  {
    const host = new TestPtyHost(ptyEvents);
    const sid = "sess-idle";
    host.spawn({ sessionId: sid, cwd: tmpHome, permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {} });
    host.deliverHook(sid, { hook_event_name: "SessionStart" });
    const inApp = fakeAdapter(IN_APP_CHANNEL);
    const tg = fakeAdapter(TELEGRAM);
    const gw = new ChatGateway(
      (s, text, route) => host.enqueueStdin(s, text, "system", undefined, route),
      [{ sessionId: sid, channel: IN_APP_CHANNEL, chatId: sid, scope: "dm" }, { sessionId: sid, channel: TELEGRAM, chatId: "tg-chat", scope: "dm" }],
      undefined, undefined,
      (s) => host.getActiveTurnOrigin(s),
    );
    gw.registerAdapter(inApp);
    gw.registerAdapter(tg);
    // No inbound has formed a turn (getActiveTurnOrigin is null) → a chat_reply has NO reply-to route.
    const r = await gw.deliverReply(sid, "proactive with no turn");
    check("(e) a reply with no in-flight-turn origin → no-target, delivers NOWHERE", r.delivered === false && r.reason === "no-target");
    check("(e) fail-safe never broadcasts: NEITHER adapter was hit", inApp.sent.length === 0 && tg.sent.length === 0);
    try { host.stop(sid, "hard"); } catch { /* ignore */ }
    await sleep(50);
  }

  // ============ Part 3 — (d) per-binding sender authz gates EACH channel independently ============
  {
    const db = new Db(dbFile("p3.db"));
    const sid = "sess-authz";
    // in-app DM (route match is the proof) + telegram GROUP (requires an allowlisted sender).
    db.upsertCompanionBinding({ sessionId: sid, channel: IN_APP_CHANNEL, chatId: sid, scope: "dm" });
    db.upsertCompanionBinding({ sessionId: sid, channel: TELEGRAM, chatId: "grp-chat", scope: "group" });
    db.addAllowedSender({ sessionId: sid, channel: TELEGRAM, senderId: "alice", label: "Alice" });

    const submitted = [];
    const submit = (s, text) => { submitted.push({ s, text }); return { delivered: true }; };
    const gw = new ChatGateway(submit, db.listCompanionBindings().map((b) => ({ sessionId: b.sessionId, channel: b.channel, chatId: b.chatId, scope: b.scope })), createDbCompanionAuth(db));
    gw.registerAdapter(fakeAdapter(IN_APP_CHANNEL));
    gw.registerAdapter(fakeAdapter(TELEGRAM));

    // telegram GROUP: an UNLISTED sender is hard-rejected, NEVER submitted.
    const mal = await gw.handleInbound({ channel: TELEGRAM, chatId: "grp-chat", body: "let me in", sender: { id: "mallory" } });
    check("(d) telegram group: unlisted sender rejected, not submitted", mal.accepted === false && mal.reason === "sender-not-authorized" && submitted.length === 0);
    // telegram GROUP: an ALLOWLISTED sender is admitted.
    const alice = await gw.handleInbound({ channel: TELEGRAM, chatId: "grp-chat", body: "hello", sender: { id: "alice" } });
    check("(d) telegram group: allowlisted sender admitted", alice.accepted === true && submitted.length === 1 && submitted[0].s === sid);
    // in-app DM on the SAME session: authorized by the route match alone (sender-independent) — the group
    // authz on the telegram channel does NOT bleed onto the in-app channel.
    const cockpit = await gw.handleInbound({ channel: IN_APP_CHANNEL, chatId: sid, body: "cockpit msg" });
    check("(d) in-app DM on the same session: admitted by route match (authz is per-channel)", cockpit.accepted === true && submitted.length === 2 && submitted[1].s === sid);
    db.close();
  }

  // ============ Part 4 — (f) the TABLE-REBUILD migration (old single-PK schema → multi-channel) ============
  {
    const file = dbFile("p4.db");
    // Seed a LEGACY companion_bindings by hand: session_id PRIMARY KEY (the pre-multi-channel shape) + the
    // unchanged UNIQUE route index + one existing binding row.
    {
      const raw = new Database(file);
      raw.exec(`CREATE TABLE companion_bindings (
        session_id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'dm',
        created_at TEXT
      );
      CREATE UNIQUE INDEX idx_companion_bindings_route ON companion_bindings(channel, chat_id);`);
      raw.prepare("INSERT INTO companion_bindings (session_id, channel, chat_id, scope, created_at) VALUES (?,?,?,?,?)")
        .run("legacy-sess", TELEGRAM, "legacy-chat", "group", "2020-01-01T00:00:00.000Z");
      const pkBefore = raw.prepare("PRAGMA table_info(companion_bindings)").all().find((c) => c.name === "session_id").pk;
      check("(f) legacy schema has session_id as PRIMARY KEY before migration", pkBefore > 0);
      raw.close();
    }

    // Open through Db → migrateCompanionBindings() rebuilds the table.
    const db = new Db(file);
    const rows = db.listCompanionBindings();
    check("(f) the legacy binding row survived the rebuild (count)", rows.length === 1);
    const r = rows[0];
    check("(f) the legacy row is preserved LOSSLESSLY (all fields intact)",
      r.sessionId === "legacy-sess" && r.channel === TELEGRAM && r.chatId === "legacy-chat" && r.scope === "group" && r.createdAt === "2020-01-01T00:00:00.000Z");

    // The whole point: the SAME session can now bind a SECOND channel (impossible under the old PK, where
    // ON CONFLICT(session_id) would have UPDATED the single row instead of adding one).
    db.upsertCompanionBinding({ sessionId: "legacy-sess", channel: IN_APP_CHANNEL, chatId: "legacy-sess", scope: "dm" });
    const after = db.listCompanionBindings().filter((b) => b.sessionId === "legacy-sess");
    check("(f) a 2nd-channel binding can now be ADDED to the migrated session", after.length === 2 && after.some((b) => b.channel === IN_APP_CHANNEL) && after.some((b) => b.channel === TELEGRAM));
    check("(f) the original telegram binding was NOT clobbered by the 2nd add", after.find((b) => b.channel === TELEGRAM)?.chatId === "legacy-chat");

    // The UNIQUE route index still holds after the rebuild: a DIFFERENT session claiming the legacy route throws.
    let threw = false;
    try { db.upsertCompanionBinding({ sessionId: "other-sess", channel: TELEGRAM, chatId: "legacy-chat", scope: "dm" }); } catch { threw = true; }
    check("(f) the UNIQUE (channel, chat_id) route index still rejects a 2nd session for a bound route", threw === true);
    check("(f) that non-multi upsert on (session, channel) is an in-place update, not a dup", (() => {
      db.upsertCompanionBinding({ sessionId: "legacy-sess", channel: TELEGRAM, chatId: "legacy-chat-2", scope: "group" });
      const tg = db.listCompanionBindings().filter((b) => b.sessionId === "legacy-sess" && b.channel === TELEGRAM);
      return tg.length === 1 && tg[0].chatId === "legacy-chat-2";
    })());
    db.close();

    // IDEMPOTENT: reopening runs the guard again and must NOT re-rebuild or lose rows.
    const db2 = new Db(file);
    check("(f) migration is idempotent (reopen keeps every row)", db2.listCompanionBindings().filter((b) => b.sessionId === "legacy-sess").length === 2);
    db2.close();
  }
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a companion reachable on in-app + Telegram AT ONCE: each turn's chat_reply goes back on the channel that turn came from (proven end-to-end through the real pty, INTERLEAVED with no swap and no cross-wire), a turn with no origin delivers nowhere (no-target), per-binding sender authz gates each channel independently, and the table-rebuild migration turns the legacy single-PK bindings table multi-channel losslessly + idempotently."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
