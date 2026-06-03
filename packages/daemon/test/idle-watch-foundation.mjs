// Asleep-at-the-Wheel idle-manager watchdog — FOUNDATION layer test (config + DB only; nothing reads
// these yet). HERMETIC like profiles.mjs / usage-limit-resume.mjs PART 1: isolated temp DB, imports
// dist/* + @loom/shared, NO daemon, NO real claude. Covers:
//   (A) config — resolveConfig returns the new orchestration defaults, honors a per-project override,
//       honors the LOOM_IDLE_NUDGE_MINUTES env (incl. "0" disables — must not be swallowed like `||`),
//       and override > env precedence.
//   (B) DB — the four idle_nudge_* columns round-trip on a FRESH DB (defaults + getter/setter accessors)
//       AND on an additive migration of a LEGACY DB created WITHOUT them (mirrors profiles.mjs's
//       legacy-topics migration test).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// ============================ (A) CONFIG ============================
const { resolveConfig } = await import("@loom/shared");
const ENV = "LOOM_IDLE_NUDGE_MINUTES";
const clearEnv = () => { delete process.env[ENV]; };

// Defaults (no override, no env).
clearEnv();
{
  const o = resolveConfig(undefined).orchestration;
  check("(A) default idleNudgeMinutes === 45", o.idleNudgeMinutes === 45);
  check("(A) default maxUnansweredNudges === 2", o.maxUnansweredNudges === 2);
  check("(A) default idleDefaultSnoozeMinutes === 30", o.idleDefaultSnoozeMinutes === 30);
  // sibling keys untouched (regression guard on the orchestration block).
  check("(A) existing recycleAtContextRatio default intact", o.recycleAtContextRatio === 0.80);
}

// Per-project override wins (both the no-env and the env-present paths exercise the override branch).
clearEnv();
{
  const o = resolveConfig({ orchestration: { idleNudgeMinutes: 10, maxUnansweredNudges: 5, idleDefaultSnoozeMinutes: 90 } }).orchestration;
  check("(A) override idleNudgeMinutes honored", o.idleNudgeMinutes === 10);
  check("(A) override maxUnansweredNudges honored", o.maxUnansweredNudges === 5);
  check("(A) override idleDefaultSnoozeMinutes honored", o.idleDefaultSnoozeMinutes === 90);
}
// An override of 0 disables (not swallowed) — on the override path.
clearEnv();
check("(A) override idleNudgeMinutes === 0 preserved (0 disables)",
  resolveConfig({ orchestration: { idleNudgeMinutes: 0 } }).orchestration.idleNudgeMinutes === 0);

// Env override at the platform-default layer — honored on BOTH resolveConfig(undefined) and the
// override-present fast path (the latter when the override omits idleNudgeMinutes).
process.env[ENV] = "5";
check("(A) env LOOM_IDLE_NUDGE_MINUTES=5 honored on no-override path",
  resolveConfig(undefined).orchestration.idleNudgeMinutes === 5);
check("(A) env honored when override omits the key",
  resolveConfig({ orchestration: { maxUnansweredNudges: 9 } }).orchestration.idleNudgeMinutes === 5);

// "0" via env disables — must be preserved, NOT swallowed by a `Number(x) || default` idiom.
process.env[ENV] = "0";
check("(A) env LOOM_IDLE_NUDGE_MINUTES=0 disables (not swallowed)",
  resolveConfig(undefined).orchestration.idleNudgeMinutes === 0);

// Precedence: a per-project override beats the env.
process.env[ENV] = "5";
check("(A) precedence: per-project override beats env",
  resolveConfig({ orchestration: { idleNudgeMinutes: 12 } }).orchestration.idleNudgeMinutes === 12);

// Blank / non-numeric env is ignored → hardcoded default applies.
process.env[ENV] = "   ";
check("(A) blank env ignored → default 45", resolveConfig(undefined).orchestration.idleNudgeMinutes === 45);
process.env[ENV] = "not-a-number";
check("(A) non-numeric env ignored → default 45", resolveConfig(undefined).orchestration.idleNudgeMinutes === 45);
clearEnv();

// ============================ (B) DB ============================
const { Db } = await import("../dist/db.js");

function tmpDbFile(tag) {
  return path.join(os.tmpdir(), `loom-idle-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
}
function rmDb(file) { for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(file + ext, { force: true }); } catch { /* ignore */ } } }

// --- (B1) FRESH DB: defaults + accessor round-trip ---------------------------------------------
{
  const file = tmpDbFile("fresh");
  const db = new Db(file);
  const now = new Date().toISOString();
  db.insertProject({ id: "p", name: "P", repoPath: "p", vaultPath: "p", config: {}, createdAt: now, archivedAt: null });
  db.insertTopic({ id: "t", projectId: "p", name: "t", startupPrompt: "x", position: 0 });
  db.insertSession({
    id: "s", projectId: "p", topicId: "t", engineSessionId: null, title: null, cwd: "/x",
    processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
  });

  // Defaults applied by the column DEFAULTs (insertSession never mentions these columns).
  const d = db.getIdleNudgeState("s");
  check("(B1) fresh: default policy 'watching'", d?.policy === "watching");
  check("(B1) fresh: default snoozeUntil null", d?.snoozeUntil === null);
  check("(B1) fresh: default lastIdleNudgeAt null", d?.lastIdleNudgeAt === null);
  check("(B1) fresh: default unanswered 0", d?.unanswered === 0);
  check("(B1) fresh: getIdleNudgeState(unknown) → undefined", db.getIdleNudgeState("nope") === undefined);

  // setIdleNudgePolicy('snoozed', ts) round-trips.
  const snoozeTs = new Date(Date.now() + 30 * 60_000).toISOString();
  db.setIdleNudgePolicy("s", "snoozed", snoozeTs);
  let r = db.getIdleNudgeState("s");
  check("(B1) setIdleNudgePolicy('snoozed', ts) round-trips", r?.policy === "snoozed" && r?.snoozeUntil === snoozeTs);

  // setIdleNudgePolicy('suppressed') clears the snooze (default null arg).
  db.setIdleNudgePolicy("s", "suppressed");
  r = db.getIdleNudgeState("s");
  check("(B1) setIdleNudgePolicy('suppressed') sets policy + clears snooze", r?.policy === "suppressed" && r?.snoozeUntil === null);

  // recordIdleNudge stamps + increments (twice).
  const nudgeTs = new Date().toISOString();
  db.recordIdleNudge("s", nudgeTs);
  db.recordIdleNudge("s", nudgeTs);
  r = db.getIdleNudgeState("s");
  check("(B1) recordIdleNudge stamps last_idle_nudge_at + increments unanswered", r?.lastIdleNudgeAt === nudgeTs && r?.unanswered === 2);

  // resetIdleNudgeState restores the watching/0/null baseline.
  db.resetIdleNudgeState("s");
  r = db.getIdleNudgeState("s");
  check("(B1) resetIdleNudgeState → watching / unanswered 0 / snooze null",
    r?.policy === "watching" && r?.unanswered === 0 && r?.snoozeUntil === null);

  // A plain insert never touches the orchestration/rate-limit columns (regression guard).
  check("(B1) plain session still inserts (rate-limit columns untouched)", db.getSession("s")?.rateLimitedUntil === null);

  db.close();
  rmDb(file);
}

// --- (B2) LEGACY DB: additive migration adds the columns + backfills existing rows --------------
{
  const file = tmpDbFile("legacy");
  // Seed a pre-watchdog `sessions` table WITHOUT the four idle_nudge_* columns + a legacy row.
  const old = new Database(file);
  old.exec(`CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    topic_id TEXT NOT NULL,
    cwd TEXT NOT NULL,
    process_state TEXT NOT NULL DEFAULT 'none',
    resumability TEXT NOT NULL DEFAULT 'unknown',
    busy INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    last_activity TEXT NOT NULL
  );`);
  old.prepare("INSERT INTO sessions (id,project_id,topic_id,cwd,process_state,resumability,busy,created_at,last_activity) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("legacyS", "pL", "tL", "/legacy/cwd", "exited", "resumable", 0, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  const colsBefore = new Set(old.prepare("PRAGMA table_info(sessions)").all().map((c) => c.name));
  const IDLE_COLS = ["idle_nudge_policy", "idle_nudge_snooze_until", "last_idle_nudge_at", "idle_nudge_unanswered"];
  check("(B2) precondition: legacy DB has NONE of the idle_nudge_* columns", IDLE_COLS.every((c) => !colsBefore.has(c)));
  old.close();

  // Opening with the real Db must run migrateSessions → ALTER TABLE ADD COLUMN for each missing column.
  const db = new Db(file);

  const raw = new Database(file, { readonly: true });
  const colsAfter = new Set(raw.prepare("PRAGMA table_info(sessions)").all().map((c) => c.name));
  check("(B2) migration: all four idle_nudge_* columns added", IDLE_COLS.every((c) => colsAfter.has(c)));
  raw.close();

  // The legacy row survives intact and its new columns backfill to the constant DEFAULTs.
  check("(B2) migration: legacy row intact (cwd preserved)", db.getSession("legacyS")?.cwd === "/legacy/cwd");
  const d = db.getIdleNudgeState("legacyS");
  check("(B2) migration: legacy row backfilled to policy 'watching'", d?.policy === "watching");
  check("(B2) migration: legacy row backfilled to unanswered 0", d?.unanswered === 0);
  check("(B2) migration: legacy row idle ts columns null", d?.snoozeUntil === null && d?.lastIdleNudgeAt === null);

  // Accessors work on the migrated DB too.
  db.setIdleNudgePolicy("legacyS", "snoozed", "2026-06-03T12:00:00.000Z");
  check("(B2) migration: accessors operate on migrated row",
    db.getIdleNudgeState("legacyS")?.policy === "snoozed" && db.getIdleNudgeState("legacyS")?.snoozeUntil === "2026-06-03T12:00:00.000Z");

  // Idempotent: re-opening the now-migrated DB must not throw (ADD COLUMN guarded by PRAGMA check).
  db.close();
  const db2 = new Db(file);
  check("(B2) migration idempotent: re-open does not throw + state persists",
    db2.getIdleNudgeState("legacyS")?.policy === "snoozed");
  db2.close();
  rmDb(file);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — idle-watchdog FOUNDATION: config defaults/override/env(+0-disables)/precedence resolve correctly; the four idle_nudge_* columns round-trip on a fresh DB and migrate additively onto a legacy DB (existing rows backfilled, migration idempotent)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
