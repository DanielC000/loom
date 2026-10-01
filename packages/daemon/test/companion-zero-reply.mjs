import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Companion ZERO-REPLY detector (card 48e8d289, split from dbba993f's DoD-4) — the CAUSE-AGNOSTIC
// detectability half of the 113-turns-silent-companion incident. NO claude, NO network, NO daemon: a REAL
// Db on an explicit temp file, `checkCompanionReplyHealth` driven directly with a real turn_seq counter
// (db.incrementTurnSeq — the same counter onTurnCompleted bumps in production).
//
// Covers:
//   (1) FIRE: a session that completes >= threshold turns with zero chat_reply crosses the threshold and
//       emits exactly ONE companion_zero_reply_detected event (once-per-streak dedup on later turns).
//   (2) NEGATIVE CONTROL: a session that calls chat_reply periodically (recordCompanionChatReply resets
//       the streak) NEVER trips the detector, even driven for MANY more turns than the threshold.
//   (3) Lazy baseline: a brand-new session's first observation seeds silently (no instant false alarm).
//   (4) A reply landing AFTER an alert re-arms: a later fresh streak crossing the threshold alerts again.
//   (5) Gating: a disabled companion_config, and a session with NO companion_config row at all (an
//       ordinary manager/worker), are both no-ops — never track, never throw.
//   (6) SCHEMA/MIGRATION (standing project rule): boot a Db against a companion_config table seeded on a
//       RAW connection with the PRE-this-card column set (no last_chat_reply_turn_seq/
//       zero_reply_alert_turn_seq) — proves the idempotent ADD COLUMN migration (not just a fresh
//       LOOM_HOME) backfills both to NULL without crashing boot, and that a legacy row's first health
//       check takes the lazy-baseline path (no instant alert) rather than reading NULL as a huge streak.
//   (7) ChatGateway wiring: `onReplyDelivered` fires on a genuine successful deliverReply, and does NOT
//       fire on a no-target/no-adapter failure.
//   (8) card 7578dea2: `onReplyDelivered` ALSO fires on a `route-flagged-non-private` suppression (a
//       genuine chat_reply ATTEMPT, not silence) — and end-to-end, a companion that keeps trying every
//       turn but is structurally suppressed NEVER trips `companion_zero_reply_detected`, even driven well
//       past the threshold. Without this, the zero-reply alarm would misfire for a companion that is
//       actively working, misdirecting a human toward "the agent is stuck" instead of "re-bind the channel"
//       (the binding-flag log/UI is the correct, already-surfaced diagnosis for this cause).
//   (9) card 1b0df437: a `route-unbound` refusal (no binding at all — e.g. a stale/bad home) is ALSO a
//       genuine attempt (onReplyDelivered still resets the streak, unchanged) AND is no longer silent —
//       the new `onUnboundRouteRefused` hook + a disclosure-safe console.warn fire exactly ONCE per
//       (session, route), never once per attempt, even driven well past the threshold; a
//       route-flagged-non-private refusal does NOT fire this new hook (the two causes stay distinct).
// Run: 1) build (turbo builds shared first), 2) node test/companion-zero-reply.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Db } from "../dist/db.js";
import { checkCompanionReplyHealth, DEFAULT_ZERO_REPLY_TURN_THRESHOLD } from "../dist/companion/reply-watch.js";
import { ChatGateway } from "../dist/companion/chat-gateway.js";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const THRESHOLD = DEFAULT_ZERO_REPLY_TURN_THRESHOLD;

function makeEnv() {
  const dbFile = path.join(os.tmpdir(), `loom-zr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Db(dbFile);
  const projId = `zp-${Math.random().toString(36).slice(2, 8)}`;
  const agentId = `za-${Math.random().toString(36).slice(2, 8)}`;
  const sessId = `zs-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  db.insertProject({ id: projId, name: "ZR", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "companion", startupPrompt: "", position: 0 });
  db.insertSession({
    id: sessId, projectId: projId, agentId, engineSessionId: "eng-1", title: null, cwd: projId,
    processState: "live", resumability: "resumable", busy: false,
    createdAt: now, lastActivity: now, lastError: null, role: "assistant",
  });
  db.upsertCompanionConfig({
    sessionId: sessId, botTokenBlob: "", channel: "telegram", allowedChatId: "chat-1",
    chatScope: "dm", heartbeatIntervalMinutes: 0, heartbeatPrompt: null, enabled: true,
  });
  return { dbFile, db, projId, agentId, sessId };
}
function cleanupEnv(e) {
  try { e.db.close(); } catch { /* ignore */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(e.dbFile + ext, { force: true }); } catch { /* ignore */ } }
}
const events = (e, kind) => e.db.listEvents(e.sessId).filter((ev) => ev.kind === kind);
/** Drive N completed turns for sessId (mirrors onTurnCompleted's own ordering: incrementTurnSeq, THEN the
 *  health check), returning the final turn_seq. */
function driveTurns(db, sessId, n) {
  let turnSeq;
  for (let i = 0; i < n; i++) {
    db.incrementTurnSeq(sessId);
    turnSeq = db.getSession(sessId).turnSeq;
    checkCompanionReplyHealth(db, sessId);
  }
  return turnSeq;
}

// --- 1. FIRE: driving exactly `threshold` silent turns trips the detector exactly once ---
{
  const e = makeEnv();
  // First ever call (turn 1) is the lazy baseline — seeds silently and does NOT itself count toward the
  // streak, so a virgin session needs (threshold + 1) total completed turns to first CROSS the threshold
  // (turnsSinceLastReply = turnSeq - 1 once the baseline is seeded at turnSeq 1).
  driveTurns(e.db, e.sessId, THRESHOLD); // turnsSinceLastReply = THRESHOLD - 1, still under
  check("fire: no alert before the threshold is reached", events(e, "companion_zero_reply_detected").length === 0);
  driveTurns(e.db, e.sessId, 1); // crosses the threshold on this turn
  check("fire: exactly ONE alert the moment the threshold is crossed", events(e, "companion_zero_reply_detected").length === 1);
  const detail = events(e, "companion_zero_reply_detected")[0].detail;
  check("fire: event detail carries turnsSinceLastReply >= threshold", detail.turnsSinceLastReply >= THRESHOLD && detail.threshold === THRESHOLD);
  // Dedup: many more silent turns past the threshold do NOT emit a second alert.
  driveTurns(e.db, e.sessId, 15);
  check("fire: no duplicate alert across many further silent turns (once-per-streak dedup)", events(e, "companion_zero_reply_detected").length === 1);
  cleanupEnv(e);
}

// --- 2. NEGATIVE CONTROL: a session that replies periodically NEVER trips the detector ---
{
  const e = makeEnv();
  // Drive well past the threshold's worth of turns, but reset the streak every 5 turns (< threshold) via
  // a genuine chat_reply record — the same call chat-gateway.ts's deliverReply makes on success.
  for (let round = 0; round < 6; round++) {
    driveTurns(e.db, e.sessId, 5);
    e.db.recordChatReplyDelivered(e.sessId); // "replied" — resets the streak
  }
  check("negative control: a periodically-replying session, driven well past the threshold in total turns, never alerts", events(e, "companion_zero_reply_detected").length === 0);
  cleanupEnv(e);
}

// --- 3. Lazy baseline: the very FIRST observation never alerts, however large turn_seq already is ---
{
  const e = makeEnv();
  // Simulate a session that already had many turns BEFORE the detector ever ran on it once (e.g. a
  // daemon upgrade landing mid-life) — jump turn_seq up first, THEN take the first-ever health check.
  for (let i = 0; i < THRESHOLD + 10; i++) e.db.incrementTurnSeq(e.sessId);
  checkCompanionReplyHealth(e.db, e.sessId); // first-ever call for this session
  check("lazy baseline: the first-ever observation never alerts even if turn_seq is already large", events(e, "companion_zero_reply_detected").length === 0);
  check("lazy baseline: it seeds lastChatReplyTurnSeq to the CURRENT turn_seq", e.db.getCompanionConfig(e.sessId).lastChatReplyTurnSeq === e.db.getSession(e.sessId).turnSeq);
  // From here, a genuinely fresh silent streak still fires normally.
  driveTurns(e.db, e.sessId, THRESHOLD);
  check("lazy baseline: a fresh streak AFTER the seeded baseline still fires", events(e, "companion_zero_reply_detected").length === 1);
  cleanupEnv(e);
}

// --- 4. Re-arm: an alert fires, a reply lands, a NEW streak crossing the threshold alerts again ---
{
  const e = makeEnv();
  driveTurns(e.db, e.sessId, THRESHOLD + 1); // virgin session — the lazy baseline call doesn't count (see test 1)
  check("re-arm: first streak alerts", events(e, "companion_zero_reply_detected").length === 1);
  e.db.recordChatReplyDelivered(e.sessId); // reply lands — ends the streak, clears the alert marker
  check("re-arm: a reply clears the active alert marker", e.db.getCompanionConfig(e.sessId).zeroReplyAlertTurnSeq === null);
  driveTurns(e.db, e.sessId, THRESHOLD);
  check("re-arm: a fresh streak past the reply alerts again (2 total)", events(e, "companion_zero_reply_detected").length === 2);
  cleanupEnv(e);
}

// --- 5. Gating: a DISABLED companion_config, and NO companion_config row at all, are both no-ops ---
{
  const e = makeEnv();
  e.db.upsertCompanionConfig({
    sessionId: e.sessId, botTokenBlob: "", channel: "telegram", allowedChatId: "chat-1",
    chatScope: "dm", heartbeatIntervalMinutes: 0, heartbeatPrompt: null, enabled: false,
  });
  driveTurns(e.db, e.sessId, THRESHOLD + 5);
  check("gating: a DISABLED companion_config is never tracked (no alert, ever)", events(e, "companion_zero_reply_detected").length === 0);
  check("gating: a disabled row's lastChatReplyTurnSeq is never touched (stays null — never observed)", e.db.getCompanionConfig(e.sessId).lastChatReplyTurnSeq === null);
  cleanupEnv(e);

  // An ORDINARY session (no companion_config row at all — a manager/worker) must never throw and never track.
  const e2 = makeEnv();
  e2.db.deleteCompanionConfig(e2.sessId);
  let threw = false;
  try { driveTurns(e2.db, e2.sessId, THRESHOLD + 5); } catch { threw = true; }
  check("gating: a session with NO companion_config row never throws", threw === false);
  check("gating: a session with NO companion_config row is never tracked", events(e2, "companion_zero_reply_detected").length === 0);
  cleanupEnv(e2);
}

// --- 6. SCHEMA/MIGRATION: boot against a companion_config table seeded on the PRE-this-card column set
//     (no last_chat_reply_turn_seq/zero_reply_alert_turn_seq) — the standing project rule (a fresh
//     LOOM_HOME is structurally blind to an ADD-COLUMN migration bug; this proves the real upgrade path).
{
  const tmpHome = path.join(os.tmpdir(), `loom-zr-migration-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(tmpHome, { recursive: true });
  const file = path.join(tmpHome, "legacy.db");

  // Build the schema via a real (post-card) Db first so every OTHER table exists, then close and drop
  // down to a raw connection to replace companion_config with the PRE-card shape (mirrors
  // companion-home-migration.mjs's "seed a pre-migration shape on a raw connection" house pattern).
  const boot = new Db(file);
  boot.close();
  const raw = new Database(file);
  raw.exec("DROP TABLE companion_config");
  raw.exec(`
    CREATE TABLE companion_config (
      session_id TEXT PRIMARY KEY,
      bot_token_blob TEXT NOT NULL,
      channel TEXT NOT NULL DEFAULT 'telegram',
      allowed_chat_id TEXT NOT NULL,
      chat_scope TEXT NOT NULL DEFAULT 'dm',
      heartbeat_interval_minutes INTEGER NOT NULL DEFAULT 0,
      heartbeat_prompt TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      provisioned INTEGER NOT NULL DEFAULT 0,
      name TEXT NOT NULL DEFAULT '',
      created_at TEXT,
      updated_at TEXT
    )`);
  const now = "2020-01-01T00:00:00.000Z";
  raw.prepare(
    `INSERT INTO companion_config (session_id, bot_token_blob, channel, allowed_chat_id, chat_scope,
       heartbeat_interval_minutes, heartbeat_prompt, enabled, provisioned, name, created_at, updated_at)
     VALUES ('legacy-sess', '', 'telegram', 'chat-1', 'dm', 0, NULL, 1, 0, '', ?, ?)`,
  ).run(now, now);
  raw.close();

  let threw = false, db2;
  try { db2 = new Db(file); } catch { threw = true; }
  check("migration: reopening a pre-card companion_config table never crashes boot", threw === false);
  const row = db2.getCompanionConfig("legacy-sess");
  check("migration: the ADD COLUMN migration backfills lastChatReplyTurnSeq to null on a legacy row", row && row.lastChatReplyTurnSeq === null);
  check("migration: the ADD COLUMN migration backfills zeroReplyAlertTurnSeq to null on a legacy row", row && row.zeroReplyAlertTurnSeq === null);

  // The INVERSE bug this rule also guards against: no index/constraint anywhere references either new
  // column (both are plain nullable ADD COLUMNs with no DEFAULT/NOT NULL/index/FK) — confirmed by the
  // migration succeeding above with zero schema errors; re-asserted here directly against sqlite_master.
  const rawCheck = new Database(file);
  const indexSql = rawCheck.prepare(
    "SELECT sql FROM sqlite_master WHERE type IN ('index','trigger') AND (sql LIKE '%last_chat_reply_turn_seq%' OR sql LIKE '%zero_reply_alert_turn_seq%')",
  ).all();
  check("migration (inverse bug): no index/trigger references either new column", indexSql.length === 0);
  rawCheck.close();

  // Legacy row's FIRST health check takes the lazy-baseline path (NULL read as "not yet observed", never
  // as an instant huge streak) — bump turn_seq up first (simulating a long-lived pre-upgrade companion)
  // to prove this explicitly, not just "it happens to be turn 0".
  const projId = "legacy-proj", agentId = "legacy-agent";
  db2.insertProject({ id: projId, name: "L", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
  db2.insertAgent({ id: agentId, projectId: projId, name: "companion", startupPrompt: "", position: 0 });
  db2.insertSession({
    id: "legacy-sess", projectId: projId, agentId, engineSessionId: "eng-legacy", title: null, cwd: projId,
    processState: "live", resumability: "resumable", busy: false,
    createdAt: now, lastActivity: now, lastError: null, role: "assistant",
  });
  for (let i = 0; i < THRESHOLD + 25; i++) db2.incrementTurnSeq("legacy-sess");
  checkCompanionReplyHealth(db2, "legacy-sess");
  const legacyEvents = db2.listEvents("legacy-sess").filter((ev) => ev.kind === "companion_zero_reply_detected");
  check("migration: an upgraded long-lived companion's first post-migration check does NOT instantly false-alarm", legacyEvents.length === 0);

  try { db2.close(); } catch { /* ignore */ }
  cleanupPathSync(tmpHome);
}

// --- 7. ChatGateway wiring: onReplyDelivered fires on genuine success, not on a no-target failure ---
{
  const fakeAdapter = (name, sent) => ({ name, maxMessageLength: 4096, start() {}, async stop() {}, async send(chatId, text) { sent.push({ chatId, text }); } });
  const noopSubmit = () => ({ delivered: true });
  const sent = [];
  const delivered = [];
  const onReplyDelivered = (sid) => delivered.push(sid);
  const gw = new ChatGateway(
    // card d3f9b4d2: a live binding must be seeded or the route is "route-unbound" regardless of shape;
    // card 94754bbe: the chatId must be numeric (a real Telegram chat id) or the shape check blocks it too.
    noopSubmit, [{ sessionId: "wired-sess", channel: "telegram", chatId: "444555666", scope: "dm" }], undefined, undefined,
    (sid) => (sid === "wired-sess" ? { channel: "telegram", chatId: "444555666" } : null), // originResolver
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    onReplyDelivered,
  );
  gw.registerAdapter(fakeAdapter("telegram", sent));

  const ok = await gw.deliverReply("wired-sess", "hello");
  check("wiring: onReplyDelivered fires on a genuine successful deliverReply", ok.delivered === true && delivered.length === 1 && delivered[0] === "wired-sess");

  const noTarget = await gw.deliverReply("no-route-sess", "x");
  check("wiring: onReplyDelivered does NOT fire on a no-target failure", noTarget.delivered === false && delivered.length === 1);
}

// --- 8. card 7578dea2: a suppressed (route-flagged-non-private) reply is a GENUINE ATTEMPT — it must
//     reset the zero-reply streak, not let it accumulate toward a misfire ---
{
  // 8a. UNIT: onReplyDelivered ALSO fires on route-flagged-non-private, not just a genuine successful send.
  const delivered2 = [];
  const onReplyDelivered2 = (sid) => delivered2.push(sid);
  const flaggedGw = new ChatGateway(
    () => ({ delivered: true }), [{ sessionId: "flagged-sess", channel: "telegram", chatId: "grp-1", scope: "dm", flaggedNonPrivate: true }],
    undefined, undefined,
    (sid) => (sid === "flagged-sess" ? { channel: "telegram", chatId: "grp-1" } : null), // originResolver
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    onReplyDelivered2,
  );
  const flaggedSent = [];
  flaggedGw.registerAdapter({ name: "telegram", maxMessageLength: 4096, start() {}, async stop() {}, async send(chatId, text) { flaggedSent.push({ chatId, text }); } });
  const r = await flaggedGw.deliverReply("flagged-sess", "should be suppressed but still counted as attempted");
  check("(8a) onReplyDelivered ALSO fires on route-flagged-non-private (a genuine attempt, not silence)", r.delivered === false && r.reason === "route-flagged-non-private" && delivered2.length === 1 && delivered2[0] === "flagged-sess");
  check("(8a) NOTHING was actually sent despite onReplyDelivered firing", flaggedSent.length === 0);

  // 8b. END-TO-END: wire a REAL ChatGateway exactly like factory.ts does (onReplyDelivered →
  // db.recordChatReplyDelivered) against a binding flagged EXACTLY the way warnUnconfirmedDirectInbound
  // flags one in production, then drive well past the threshold while calling deliverReply EVERY round
  // (mirrors test 2's negative-control shape, but the "reply" is always structurally suppressed, never a
  // genuine send) — the detector must NEVER fire, because the companion IS trying every turn.
  const e = makeEnv();
  const gw = new ChatGateway(
    () => ({ delivered: true }), [{ sessionId: e.sessId, channel: "telegram", chatId: "grp-1", scope: "dm", flaggedNonPrivate: true }],
    undefined, undefined,
    (sid) => (sid === e.sessId ? { channel: "telegram", chatId: "grp-1" } : null),
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    (sid) => e.db.recordChatReplyDelivered(sid), // the REAL production wiring (factory.ts)
  );
  const sent = [];
  gw.registerAdapter({ name: "telegram", maxMessageLength: 4096, start() {}, async stop() {}, async send(chatId, text) { sent.push({ chatId, text }); } });
  for (let round = 0; round < 6; round++) {
    driveTurns(e.db, e.sessId, 5);
    const rr = await gw.deliverReply(e.sessId, "trying every turn, always suppressed");
    check(`(8b) round ${round}: deliverReply is suppressed every time (still trying, never landing)`, rr.delivered === false && rr.reason === "route-flagged-non-private");
  }
  check("(8b) a companion that keeps TRYING every turn but is suppressed NEVER trips companion_zero_reply_detected", events(e, "companion_zero_reply_detected").length === 0);
  check("(8b) NOTHING was ever actually sent to the flagged route across the whole run", sent.length === 0);
  cleanupEnv(e);
}

// --- 9. card 1b0df437: a `route-unbound` refusal (no binding at all — a stale/bad home) is ALSO a
//     genuine attempt (resets the streak, unchanged) AND is no longer SILENT: logged + durably eventED
//     exactly once per (session, route), never once per attempt ---
{
  // 9a. UNIT: onReplyDelivered fires (unchanged reset behavior) AND the new onUnboundRouteRefused hook
  // fires, with the session/channel/chatId of the refused route.
  const delivered3 = [];
  const unbound3 = [];
  const unboundGw = new ChatGateway(
    () => ({ delivered: true }), [], undefined, undefined,
    (sid) => (sid === "unbound-sess" ? { channel: "telegram", chatId: "999888777" } : null), // originResolver
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    (sid) => delivered3.push(sid), undefined, undefined,
    (sid, channel, chatId) => unbound3.push({ sid, channel, chatId }),
  );
  unboundGw.registerAdapter({ name: "telegram", maxMessageLength: 4096, start() {}, async stop() {}, async send() {} });
  const realWarn = console.warn;
  const warnCalls = [];
  console.warn = (...args) => { warnCalls.push(args.map(String).join(" ")); };
  const ru1 = await unboundGw.deliverReply("unbound-sess", "nobody home");
  console.warn = realWarn;
  check("(9a) deliverReply reports route-unbound for a route with no live binding at all", ru1.delivered === false && ru1.reason === "route-unbound");
  check("(9a) onReplyDelivered STILL fires (a route-unbound refusal is still a genuine attempt, unchanged)", delivered3.length === 1 && delivered3[0] === "unbound-sess");
  check("(9a) the new onUnboundRouteRefused hook fires with the session/channel/chatId", unbound3.length === 1 && unbound3[0].sid === "unbound-sess" && unbound3[0].channel === "telegram" && unbound3[0].chatId === "999888777");
  check("(9a) a disclosure-safe console.warn fires (session id + channel, never the chatId)", warnCalls.some((c) => c.includes("unbound-sess") && c.includes("telegram") && !c.includes("999888777")));

  // 9b. DEDUP: a SECOND refusal on the SAME (session, route) resets the streak again but does NOT
  // re-fire the hook or the log — once-per-(session,route), mirroring warnUnconfirmedDirectInbound.
  const ru2 = await unboundGw.deliverReply("unbound-sess", "still nobody home");
  check("(9b) a second refusal on the SAME route still resets the streak (onReplyDelivered fires again)", ru2.delivered === false && ru2.reason === "route-unbound" && delivered3.length === 2);
  check("(9b) but the durable-event hook does NOT fire again — deduped per (session, route)", unbound3.length === 1);

  // 9c. END-TO-END, REAL Db: a companion that keeps trying every turn against a route with NO binding at
  // all (e.g. a stale/bad home) never trips companion_zero_reply_detected (same posture as 8b), and the
  // real durable event lands exactly ONCE despite being driven well past the threshold.
  const e2 = makeEnv();
  const gw2 = new ChatGateway(
    () => ({ delivered: true }), [], undefined, undefined,
    (sid) => (sid === e2.sessId ? { channel: "telegram", chatId: "222333444" } : null),
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    (sid) => e2.db.recordChatReplyDelivered(sid), undefined, undefined,
    (sid, channel, chatId) => e2.db.recordCompanionUnboundRouteRefused(sid, channel, chatId), // REAL production wiring (factory.ts)
  );
  const sent2 = [];
  gw2.registerAdapter({ name: "telegram", maxMessageLength: 4096, start() {}, async stop() {}, async send(chatId, text) { sent2.push({ chatId, text }); } });
  for (let round = 0; round < 6; round++) {
    driveTurns(e2.db, e2.sessId, 5);
    const rr2 = await gw2.deliverReply(e2.sessId, "trying every turn, always route-unbound");
    check(`(9c) round ${round}: deliverReply is route-unbound every time (still trying, never landing)`, rr2.delivered === false && rr2.reason === "route-unbound");
  }
  check("(9c) a companion that keeps TRYING every turn against an unbound route NEVER trips companion_zero_reply_detected", events(e2, "companion_zero_reply_detected").length === 0);
  check("(9c) NOTHING was ever actually sent to the unbound route across the whole run", sent2.length === 0);
  const unboundEvents = events(e2, "companion_unbound_route_refused");
  check("(9c) exactly ONE companion_unbound_route_refused event landed despite 6 rounds of refusal (deduped)", unboundEvents.length === 1);
  check("(9c) its detail carries the refused route", unboundEvents[0]?.detail?.channel === "telegram" && unboundEvents[0]?.detail?.chatId === "222333444");

  // 9d. NEGATIVE CONTROL: a route-flagged-non-private refusal (existing cause, card 7578dea2) does NOT
  // fire the new unbound-route hook — the two causes stay distinct, never cross-counted.
  const flagged3 = [];
  const flaggedGw3 = new ChatGateway(
    () => ({ delivered: true }), [{ sessionId: "flagged-sess-3", channel: "telegram", chatId: "grp-3", scope: "dm", flaggedNonPrivate: true }],
    undefined, undefined,
    (sid) => (sid === "flagged-sess-3" ? { channel: "telegram", chatId: "grp-3" } : null),
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined,
    (sid, channel, chatId) => flagged3.push({ sid, channel, chatId }),
  );
  flaggedGw3.registerAdapter({ name: "telegram", maxMessageLength: 4096, start() {}, async stop() {}, async send() {} });
  const rf3 = await flaggedGw3.deliverReply("flagged-sess-3", "flagged, not unbound");
  check("(9d negative control) a route-flagged-non-private refusal is NOT route-unbound", rf3.delivered === false && rf3.reason === "route-flagged-non-private");
  check("(9d negative control) the unbound-route hook does NOT fire for a flagged-binding refusal", flagged3.length === 0);

  cleanupEnv(e2);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the companion zero-reply detector fires exactly once per genuine silent streak past the threshold, never fires on a periodically-replying (negative-control) or freshly-observed session, is gated to enabled companion sessions only, survives an ADD-COLUMN migration from the pre-card schema without a false alarm, its ChatGateway hook fires only on a genuine delivered reply OR a route-flagged-non-private/route-unbound suppression (all are attempts, never silence), a companion suppressed by a flagged binding or an unbound route never misfires the alarm even when driven well past the threshold, and a route-unbound refusal is now logged + durably eventED exactly once per (session, route) rather than being completely silent."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
