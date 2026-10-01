import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Loom Companion — a dm-scope Telegram binding whose chatId is a NEGATIVE integer can never go unflagged,
// at BIND TIME or at BOOT (card 61e33b99, round 2 — closing a fail-open window round 1 left open).
//
// ROUND 1 (boot-only) recap: factory.ts's boot-time check started PERSISTING the outbound-suppression flag
// (not just warning) for a dm-scope Telegram binding whose chatId is negative. That left
// db.upsertCompanionBinding's own ON CONFLICT path unconditionally RESETTING flagged_non_private to 0 on
// EVERY bind/re-bind — including a re-bind that does NOT fix the misconfiguration (same dm scope, same or
// another negative chatId) — clearing the flag immediately and reopening outbound until the NEXT gateway
// rebuild (boot/restart). ROUND 2 fixes the chokepoint itself: db.upsertCompanionBinding now computes the
// flag FRESH, via the SAME shared predicate (isLikelyGroupTelegramChatId, companion/types.ts) the boot-time
// backstop uses, on every write — so a re-bind can never again leave this unflagged.
//
// Fully hermetic: a REAL Db (proves persistence) + the REAL createCompanionGateway/ChatGateway/pairing
// production wiring — NO live network, NO real claude, NO daemon.
//
// Covers:
//   A. THE WRITE-TIME CHOKEPOINT (db.upsertCompanionBinding) — the fix itself:
//      A1. a fresh dm+negative-chatId bind is flagged IMMEDIATELY — no gateway, no inbound.
//      A2. THE EXACT REGRESSION THIS ROUND FIXES: a dm-scope RE-BIND to a negative chatId (over a
//          previously-fine binding) is flagged in the SAME write.
//      A3/A4. negative controls: a positive-chatId dm bind, and a group-scope bind (even w/ negative
//          chatId), both stay clear through repeated re-binds.
//      A5/A6. genuine remedy: re-binding to scope "group", or to a positive chatId, still clears the flag.
//      A7. idempotent same-route re-bind of an already-flagged binding stays flagged.
//   B. EVERY OTHER REAL WRITE PATH reaches the SAME chokepoint, exercised through the real call:
//      B1. pairing-code dm-bind REDEMPTION (db.redeemPairingCode via pairing.ts + chat-gateway.ts's real
//          handleInbound) — a chatIsDirect:true inbound (the only way redemption proceeds) whose numeric
//          chatId is still negative (e.g. an upstream chatIsDirect misreport) is flagged too.
//      B2. ChatGateway.bind's LIVE sync carries the already-correct flag forward with no extra logic of
//          its own (proven as part of B1 — the live routing map reflects the flag with no separate write).
//      (The REST bind handler, the env bootstrap seed, and the provision endpoint all call
//      db.upsertCompanionBinding with no logic of their own beyond what Part A already exercises directly —
//      see docs/decisions/61e33b99-boot-time-preflag-group-dm-bindings.md for the full file:line list.)
//   C. LEGACY-ROW BOOT BACKSTOP — a row written by an OLDER daemon build (a raw INSERT bypassing
//      upsertCompanionBinding entirely) still gets caught at boot, with no inbound needed; idempotent on a
//      2nd gateway build; negative controls (positive-chatId / group-scope legacy rows) untouched.
//   D. END-TO-END outbound suppression via a fresh gateway + deliverReply, both for a write-time-flagged
//      binding (no boot backstop involved at all) and for the legacy-row case; plus the remedy restoring
//      delivery.
//
// Run: 1) build (turbo builds shared first), 2) node test/companion-boot-preflag-group-dm.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-companion-boot-preflag-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

const { requireHermeticEnv } = await import("./_guard.mjs");
const { cleanupPathSync } = await import("./_tmp-fixture.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { createCompanionGateway } = await import("../dist/companion/factory.js");
const { ChatGateway } = await import("../dist/companion/chat-gateway.js");
const { createDbCompanionAuth } = await import("../dist/companion/auth.js");
const { createDbCompanionPairing } = await import("../dist/companion/pairing.js");
const { TELEGRAM_CHANNEL } = await import("../dist/companion/telegram.js");

const dbFile = path.join(tmpHome, "loom.db");
const db = new Db(dbFile);

// Spy on the reactive/boot-time writer ONLY — used in Part C to prove the boot backstop still fires for a
// LEGACY row, and does NOT re-fire once a row (whether write-time- or boot-flagged) is already flagged.
const flagCalls = [];
const realFlag = db.flagCompanionBindingNonPrivate.bind(db);
db.flagCompanionBindingNonPrivate = (sessionId, channel) => { flagCalls.push({ sessionId, channel }); return realFlag(sessionId, channel); };

function fakeAdapter(name) {
  const sent = [];
  return { name, maxMessageLength: 4096, start() {}, async stop() {}, async send(chatId, text) { sent.push({ chatId, text }); }, sent };
}

const now0 = new Date().toISOString();
function seedSession(id) {
  const projectId = randomUUID();
  db.insertProject({ id: projectId, name: id, repoPath: projectId, vaultPath: projectId, config: {}, createdAt: now0, archivedAt: null });
  const agentId = randomUUID();
  db.insertAgent({ id: agentId, projectId, name: "Companion", startupPrompt: "", position: 0 });
  db.insertSession({
    id, projectId, agentId, engineSessionId: `eng-${id}`, title: null, cwd: projectId,
    processState: "live", resumability: "resumable", busy: false,
    createdAt: now0, lastActivity: now0, lastError: null, role: "assistant", taskId: null,
  });
}

try {
  // ============ A. WRITE-TIME CHOKEPOINT (db.upsertCompanionBinding) ========================================
  const sessA = "sess-write-time";

  // A1. Fresh dm bind, negative chatId — flagged IMMEDIATELY, no gateway, no inbound.
  const a1 = db.upsertCompanionBinding({ sessionId: sessA, channel: TELEGRAM_CHANNEL, chatId: "-1001234567890", scope: "dm" });
  check("(A1) a FRESH dm bind with a negative Telegram chatId returns flaggedNonPrivate:true immediately", a1.flaggedNonPrivate === true);
  check("(A1) persisted: the db row is flagged", db.listCompanionBindings().find((b) => b.sessionId === sessA)?.flaggedNonPrivate === true);

  // A2. THE REGRESSION THIS ROUND FIXES: start a DIFFERENT session clean (positive chatId, unflagged), then
  // RE-BIND the SAME route to a negative chatId. Under round-1-only code, upsertCompanionBinding always
  // wrote flagged_non_private=0 on the ON CONFLICT path — this would wrongly return/persist false. This is
  // the assertion that was RED before this round's db.ts fix (see worker report for the revert/rebuild proof).
  const sessB = "sess-regression-rebind";
  const b0 = db.upsertCompanionBinding({ sessionId: sessB, channel: TELEGRAM_CHANNEL, chatId: "555666777", scope: "dm" });
  check("(A2 setup) the clean positive-chatId bind starts unflagged", b0.flaggedNonPrivate === false);
  const b1 = db.upsertCompanionBinding({ sessionId: sessB, channel: TELEGRAM_CHANNEL, chatId: "-1009998887776", scope: "dm" });
  check("(A2) a dm-scope RE-BIND to a negative chatId is flagged in the SAME write (the fail-open window this round closes)", b1.flaggedNonPrivate === true);
  check("(A2) persisted: the re-bound row is flagged", db.listCompanionBindings().find((b) => b.sessionId === sessB)?.flaggedNonPrivate === true);

  // A3. NEGATIVE CONTROL — a positive-chatId dm binding stays clear across repeated re-binds.
  const sessC = "sess-ordinary-dm-rebind";
  db.upsertCompanionBinding({ sessionId: sessC, channel: TELEGRAM_CHANNEL, chatId: "111222333", scope: "dm" });
  const c1 = db.upsertCompanionBinding({ sessionId: sessC, channel: TELEGRAM_CHANNEL, chatId: "444555666", scope: "dm" });
  check("(A3) a positive-chatId dm RE-BIND stays unflagged", c1.flaggedNonPrivate === false);

  // A4. NEGATIVE CONTROL — a group-scope binding, even with a negative chatId, stays clear across re-binds.
  const sessD = "sess-real-group-rebind";
  db.upsertCompanionBinding({ sessionId: sessD, channel: TELEGRAM_CHANNEL, chatId: "-1002223334445", scope: "group" });
  const d1 = db.upsertCompanionBinding({ sessionId: sessD, channel: TELEGRAM_CHANNEL, chatId: "-1009998887771", scope: "group" });
  check("(A4) a group-scope RE-BIND (negative chatId both times) stays unflagged — scope is dm-only", d1.flaggedNonPrivate === false);

  // A5. GENUINE REMEDY — re-binding the FLAGGED route (sessA) to scope "group" clears it in the same write.
  const a2 = db.upsertCompanionBinding({ sessionId: sessA, channel: TELEGRAM_CHANNEL, chatId: "-1001234567890", scope: "group" });
  check("(A5) remedy: re-binding to scope \"group\" (same negative chatId) clears the flag", a2.flaggedNonPrivate === false);

  // A6. GENUINE REMEDY — re-binding a FLAGGED route (sessB) to a real positive chatId clears it.
  const b2 = db.upsertCompanionBinding({ sessionId: sessB, channel: TELEGRAM_CHANNEL, chatId: "777888999", scope: "dm" });
  check("(A6) remedy: re-binding to a positive chatId clears the flag", b2.flaggedNonPrivate === false);

  // A7. IDEMPOTENT — re-binding an ALREADY-flagged dm+negative route to the SAME negative chatId stays flagged.
  const sessE = "sess-idempotent-reflag";
  db.upsertCompanionBinding({ sessionId: sessE, channel: TELEGRAM_CHANNEL, chatId: "-1005554443332", scope: "dm" });
  const e1 = db.upsertCompanionBinding({ sessionId: sessE, channel: TELEGRAM_CHANNEL, chatId: "-1005554443332", scope: "dm" });
  check("(A7) a same-route re-bind of an already-flagged dm+negative binding stays flagged", e1.flaggedNonPrivate === true);

  // ============ B. EVERY OTHER REAL WRITE PATH — pairing-code dm-bind redemption ============================
  // Exercised through the REAL chat-gateway + pairing + db wiring (not re-implemented): a chatIsDirect:true
  // inbound is the ONLY way redemption proceeds (card db49891d) — but that gate checks the boolean flag
  // alone, never the chatId's sign, so a channel that misreports chatIsDirect:true for a numerically
  // group-shaped chatId is exactly the defense-in-depth case this predicate also catches here.
  const sessF = "sess-pairing-redeem";
  const pairing = createDbCompanionPairing(db, { now: () => Date.now() });
  const minted = db.mintPairingCode({ sessionId: sessF, channel: TELEGRAM_CHANNEL, grantType: "dm-bind", ttlMs: 10 * 60_000 }, Date.now());
  const gwPairing = new ChatGateway(() => ({ delivered: true }), [], createDbCompanionAuth(db), pairing, (sid) => (sid === sessF ? { channel: TELEGRAM_CHANNEL, chatId: "-1007776665554" } : null));
  const redeemResult = await gwPairing.handleInbound({ channel: TELEGRAM_CHANNEL, chatId: "-1007776665554", body: minted.code, sender: { id: "owner-1" }, chatIsDirect: true });
  check("(B1) pairing redemption with a negative chatId still binds (dm-bind grant)", redeemResult.accepted === false && redeemResult.reason === "paired-dm");
  const pairedRow = db.listCompanionBindings().find((b) => b.sessionId === sessF);
  check("(B1) pairing-code dm-bind redemption with a negative chatId is flagged — the SAME chokepoint, no separate logic", pairedRow?.flaggedNonPrivate === true);
  // (B2) ChatGateway.bind's own live-sync: deliverReply on the just-paired route is ALREADY suppressed, with
  // no separate flagging step — the live routing map inherited the flag from upsertCompanionBinding's return
  // value via handleInbound's own `this.bind(red.binding)` call, never a second write.
  const rPairedReply = await gwPairing.deliverReply(sessF, "should never reach this negative-chatId route");
  check("(B2) the live routing map (ChatGateway.bind) already reflects the flag with no separate write", rPairedReply.delivered === false && rPairedReply.reason === "route-flagged-non-private");

  // ============ C. LEGACY-ROW BOOT BACKSTOP (a row written by an OLDER daemon build) =========================
  // Bypasses upsertCompanionBinding ENTIRELY via a raw INSERT — simulates a row that predates this fix (and
  // round 1's boot-time fix) and has never been re-bound since.
  const sessLegacyBad = "sess-legacy-misbound";
  seedSession(sessLegacyBad);
  db.db.prepare(
    `INSERT INTO companion_bindings (session_id, channel, chat_id, scope, created_at, flagged_non_private)
     VALUES (@sessionId, @channel, @chatId, @scope, @createdAt, 0)`,
  ).run({ sessionId: sessLegacyBad, channel: TELEGRAM_CHANNEL, chatId: "-1009990001112", scope: "dm", createdAt: now0 });
  check("(C setup) the legacy row starts UNFLAGGED (simulates a pre-fix write)", db.listCompanionBindings().find((b) => b.sessionId === sessLegacyBad)?.flaggedNonPrivate === false);

  flagCalls.length = 0;
  const cfgLegacy = { botToken: "fake-token", allowedChatId: "-1009990001112", sessionId: sessLegacyBad, chatScope: "dm", homeChannel: TELEGRAM_CHANNEL, homeChatId: "-1009990001112", heartbeatIntervalMinutes: 0, heartbeatPrompt: "" };
  const gwLegacy = createCompanionGateway(cfgLegacy, () => ({ delivered: true }), db, undefined, (sid) => (sid === sessLegacyBad ? { channel: TELEGRAM_CHANNEL, chatId: "-1009990001112" } : null));
  const tgLegacy = fakeAdapter(TELEGRAM_CHANNEL);
  gwLegacy.registerAdapter(tgLegacy);
  const rLegacy = await gwLegacy.deliverReply(sessLegacyBad, "heartbeat — must never reach a group the owner never confirmed");
  check("(C) the boot-time backstop still catches a LEGACY unflagged row — no inbound needed", rLegacy.delivered === false && rLegacy.reason === "route-flagged-non-private");
  check("(C) persisted: the legacy row is now flagged", db.listCompanionBindings().find((b) => b.sessionId === sessLegacyBad)?.flaggedNonPrivate === true);
  check("(C) the boot backstop used the real flagCompanionBindingNonPrivate writer", flagCalls.some((c) => c.sessionId === sessLegacyBad));

  // Idempotent: a SECOND gateway build does not re-invoke the writer (the row is already flagged).
  flagCalls.length = 0;
  const gwLegacy2 = createCompanionGateway(cfgLegacy, () => ({ delivered: true }), db, undefined, (sid) => (sid === sessLegacyBad ? { channel: TELEGRAM_CHANNEL, chatId: "-1009990001112" } : null));
  const tgLegacy2 = fakeAdapter(TELEGRAM_CHANNEL);
  gwLegacy2.registerAdapter(tgLegacy2);
  const rLegacy2 = await gwLegacy2.deliverReply(sessLegacyBad, "still suppressed on a fresh gateway build");
  check("(C idempotent) restart-survival: a 2nd fresh gateway build stays suppressed", rLegacy2.delivered === false && rLegacy2.reason === "route-flagged-non-private");
  check("(C idempotent) the writer is NOT re-invoked once already flagged", flagCalls.length === 0);

  // NEGATIVE CONTROLS — a legacy positive-chatId dm row, and a legacy group-scope row, are untouched by boot.
  const sessLegacyOk = "sess-legacy-ordinary";
  seedSession(sessLegacyOk);
  db.db.prepare(
    `INSERT INTO companion_bindings (session_id, channel, chat_id, scope, created_at, flagged_non_private)
     VALUES (@sessionId, @channel, @chatId, @scope, @createdAt, 0)`,
  ).run({ sessionId: sessLegacyOk, channel: TELEGRAM_CHANNEL, chatId: "999888777", scope: "dm", createdAt: now0 });
  const cfgLegacyOk = { botToken: "fake-token", allowedChatId: "999888777", sessionId: sessLegacyOk, chatScope: "dm", homeChannel: TELEGRAM_CHANNEL, homeChatId: "999888777", heartbeatIntervalMinutes: 0, heartbeatPrompt: "" };
  const gwLegacyOk = createCompanionGateway(cfgLegacyOk, () => ({ delivered: true }), db, undefined, (sid) => (sid === sessLegacyOk ? { channel: TELEGRAM_CHANNEL, chatId: "999888777" } : null));
  const tgLegacyOk = fakeAdapter(TELEGRAM_CHANNEL);
  gwLegacyOk.registerAdapter(tgLegacyOk);
  const rLegacyOk = await gwLegacyOk.deliverReply(sessLegacyOk, "a genuine legacy private chat, unaffected");
  check("(C control) a legacy positive-chatId dm row is untouched by the boot backstop", rLegacyOk.delivered === true && tgLegacyOk.sent.length === 1);

  // ============ D. REMEDY end-to-end — re-binding the write-time-flagged route (sessA) restores delivery =====
  // sessA was flagged in Part A1, then remedied in A5 (re-bound to scope "group"). Build a FRESH gateway and
  // confirm delivery resumes — proving the remedy isn't just a db-row artifact but actually restores outbound.
  seedSession(sessA); // createCompanionGateway's real chat-history recorder has a sessions(id) FK
  const cfgFixed ={ botToken: "fake-token", allowedChatId: "-1001234567890", sessionId: sessA, chatScope: "group", homeChannel: TELEGRAM_CHANNEL, homeChatId: "-1001234567890", heartbeatIntervalMinutes: 0, heartbeatPrompt: "" };
  const gwFixed = createCompanionGateway(cfgFixed, () => ({ delivered: true }), db, undefined, (sid) => (sid === sessA ? { channel: TELEGRAM_CHANNEL, chatId: "-1001234567890" } : null));
  const tgFixed = fakeAdapter(TELEGRAM_CHANNEL);
  gwFixed.registerAdapter(tgFixed);
  const rFixed = await gwFixed.deliverReply(sessA, "re-bound as group, delivery resumes");
  check("(D) remedy: delivery resumes on a fresh gateway after the write-time flag was cleared by a genuine fix", rFixed.delivered === true && tgFixed.sent.length === 1);
} finally {
  db.close();
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — db.upsertCompanionBinding (the ONE write chokepoint for every companion_bindings write) computes flagged_non_private fresh on every bind AND re-bind via the shared isLikelyGroupTelegramChatId predicate, so a dm-scope Telegram binding with a negative chatId can never go unflagged — not at a fresh bind, not at a re-bind that fails to fix the misconfiguration, and not via pairing-code redemption; a positive-chatId dm binding and a genuine group-scope binding stay unaffected across repeated re-binds; a genuine remedy (scope \"group\" or a real chatId) still clears it in the same write; and a LEGACY row from before this fix is still caught at boot, idempotently, with no inbound needed."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
