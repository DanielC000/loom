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
    noopSubmit, [], undefined, undefined,
    (sid) => (sid === "wired-sess" ? { channel: "telegram", chatId: "c1" } : null), // originResolver
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    onReplyDelivered,
  );
  gw.registerAdapter(fakeAdapter("telegram", sent));

  const ok = await gw.deliverReply("wired-sess", "hello");
  check("wiring: onReplyDelivered fires on a genuine successful deliverReply", ok.delivered === true && delivered.length === 1 && delivered[0] === "wired-sess");

  const noTarget = await gw.deliverReply("no-route-sess", "x");
  check("wiring: onReplyDelivered does NOT fire on a no-target failure", noTarget.delivered === false && delivered.length === 1);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the companion zero-reply detector fires exactly once per genuine silent streak past the threshold, never fires on a periodically-replying (negative-control) or freshly-observed session, is gated to enabled companion sessions only, survives an ADD-COLUMN migration from the pre-card schema without a false alarm, and its ChatGateway hook fires only on a genuine delivered reply."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
