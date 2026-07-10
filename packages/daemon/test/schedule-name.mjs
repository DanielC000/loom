import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Per-schedule NAME (Schedules UI redesign — card 1410f4fe): every Schedule carries a human-facing
// `name`, MANDATORY on new creation. HERMETIC + CLAUDE-FREE + NETWORK-FREE. Proves the DoD:
//   (0) CRON GENERATION — the shared friendly-cron model (cronFromBuilder / describeCron /
//       parseCronToBuilder): every frequency composes the right cron, reads back the right summary, and
//       round-trips through the parser (builder → cron → builder is stable).
//   (1) MIGRATION — a real pre-`name` legacy `schedules` table (kind + prompt already present, the true
//       shape of a current upgraded ~/.loom/loom.db) boots clean under a real Db, gains the `name`
//       column, an existing row reads a DERIVED default (describeCron(cron)) rather than NULL/'', the
//       migration is idempotent, and `idx_schedules_due` does NOT reference `name`.
//   (2) NAME VALIDATION / round-trip — db.insertSchedule with a blank/missing name derives the default;
//       with a real name stores it verbatim; service.createSchedule threads the name through and
//       derives on blank (the agent path stays backward-compatible); updateScheduleAsManager renames and
//       a blank rename is ignored (a schedule always keeps a name).
//
// Run: 1) build (turbo builds shared first), 2) node test/schedule-name.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { cronFromBuilder, describeCron, parseCronToBuilder, defaultBuilderState } from "@loom/shared";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// ============================================================================================
// (0) CRON GENERATION — the pure shared model. No Db, no daemon.
// ============================================================================================
{
  const base = defaultBuilderState();
  const cases = [
    { state: { ...base, frequency: "hourly", minute: 30 }, cron: "30 * * * *", summary: "Every hour at :30" },
    { state: { ...base, frequency: "everyNHours", minute: 0, interval: 6 }, cron: "0 */6 * * *", summary: "Every 6 hours at :00" },
    { state: { ...base, frequency: "daily", minute: 0, hour: 9 }, cron: "0 9 * * *", summary: "Every day at 9:00 AM" },
    { state: { ...base, frequency: "daily", minute: 5, hour: 0 }, cron: "5 0 * * *", summary: "Every day at 12:05 AM" },
    { state: { ...base, frequency: "daily", minute: 0, hour: 13 }, cron: "0 13 * * *", summary: "Every day at 1:00 PM" },
    { state: { ...base, frequency: "weekdays", minute: 0, hour: 9 }, cron: "0 9 * * 1-5", summary: "Every weekday at 9:00 AM" },
    { state: { ...base, frequency: "weekly", minute: 0, hour: 9, daysOfWeek: [3, 1] }, cron: "0 9 * * 1,3", summary: "Every Mon, Wed at 9:00 AM" },
    { state: { ...base, frequency: "monthly", minute: 0, hour: 8, dayOfMonth: 1 }, cron: "0 8 1 * *", summary: "Monthly on the 1st at 8:00 AM" },
    { state: { ...base, frequency: "monthly", minute: 0, hour: 8, dayOfMonth: 22 }, cron: "0 8 22 * *", summary: "Monthly on the 22nd at 8:00 AM" },
    { state: { ...base, frequency: "custom", raw: "*/15 2 * * 6" }, cron: "*/15 2 * * 6", summary: "*/15 2 * * 6" },
  ];
  for (const c of cases) {
    check(`(0) cronFromBuilder(${c.state.frequency}) === "${c.cron}"`, cronFromBuilder(c.state) === c.cron);
    check(`(0) describeCron("${c.cron}") === "${c.summary}"`, describeCron(c.cron) === c.summary);
  }
  // Round-trip stability: builder → cron → builder → cron is a fixpoint for every non-custom frequency.
  for (const c of cases) {
    const cron = cronFromBuilder(c.state);
    const reparsed = parseCronToBuilder(cron);
    check(`(0) round-trip stable for ${c.state.frequency}: parse(cron) re-emits the same cron`, cronFromBuilder(reparsed) === cron);
  }
  // A weekly with NO days selected still emits a valid 5-field cron (falls back to Monday), never "* * * *".
  const emptyWeekly = cronFromBuilder({ ...base, frequency: "weekly", minute: 0, hour: 9, daysOfWeek: [] });
  check("(0) weekly with zero days falls back to Monday (valid 5-field cron)", emptyWeekly === "0 9 * * 1");
  // An unrecognized cron reads back VERBATIM (never a wrong guess) and parses to frequency:custom.
  check("(0) describeCron of an unmodelled cron returns it verbatim", describeCron("7 */3 5 6 2") === "7 */3 5 6 2");
  check("(0) parseCronToBuilder of an unmodelled cron → custom + raw", (() => { const s = parseCronToBuilder("7 */3 5 6 2"); return s.frequency === "custom" && s.raw === "7 */3 5 6 2"; })());
}

// ============================================================================================
// (1) MIGRATION — synthesize a real pre-`name` legacy `schedules` table, boot a real Db against it.
// ============================================================================================
{
  const tmpHome = path.join(os.tmpdir(), `loom-schedname-mig-${Date.now()}-${process.pid}`);
  fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
  process.env.LOOM_HOME = tmpHome;
  const { requireHermeticEnv } = await import("./_guard.mjs");
  requireHermeticEnv();

  const dbFile = path.join(tmpHome, "legacy.db");
  const projId = randomUUID();
  const agentId = randomUUID();
  const schedId = randomUUID();
  const now = new Date().toISOString();

  // The true pre-this-change shape: `kind` + `prompt` already shipped, `name` does not exist yet.
  {
    const raw = new Database(dbFile);
    raw.pragma("journal_mode = WAL");
    raw.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_path TEXT NOT NULL, vault_path TEXT NOT NULL,
        config_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, archived_at TEXT
      );
      CREATE TABLE agents (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), name TEXT NOT NULL,
        startup_prompt TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE schedules (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id),
        cron TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        next_fire_at TEXT NOT NULL,
        last_fired_at TEXT,
        created_at TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'manager',
        prompt TEXT
      );
      CREATE INDEX idx_schedules_due ON schedules(enabled, next_fire_at);
    `);
    raw.prepare("INSERT INTO projects (id, name, repo_path, vault_path, config_json, created_at, archived_at) VALUES (?, ?, ?, ?, '{}', ?, NULL)")
      .run(projId, "Legacy Sched Project", projId, projId, now);
    raw.prepare("INSERT INTO agents (id, project_id, name, startup_prompt, position) VALUES (?, ?, 'Legacy Agent', 'DOCTRINE', 0)")
      .run(agentId, projId);
    raw.prepare("INSERT INTO schedules (id, agent_id, cron, enabled, next_fire_at, last_fired_at, created_at, kind, prompt) VALUES (?, ?, '0 9 * * *', 1, ?, NULL, ?, 'manager', NULL)")
      .run(schedId, agentId, now, now);
    raw.close();
  }

  let db;
  try {
    let ctorError = null;
    try {
      const { Db } = await import("../dist/db.js");
      db = new Db(dbFile);
    } catch (err) { ctorError = err; }
    check("(1) constructing Db against a legacy pre-`name` schedules DB does not throw", ctorError === null);
    if (ctorError) console.log(`    threw: ${ctorError?.stack || ctorError}`);

    if (!ctorError) {
      const raw2 = new Database(dbFile, { readonly: true });
      try {
        const cols = new Set(raw2.prepare("PRAGMA table_info(schedules)").all().map((c) => c.name));
        check("(1) schedules gained the name column", cols.has("name"));

        const idxSql = raw2.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_schedules_due'").get()?.sql ?? "";
        check("(1) idx_schedules_due still exists", idxSql.length > 0);
        check("(1) idx_schedules_due does NOT reference name (plain nullable data column)", !/name/i.test(idxSql));

        // The raw stored cell is still NULL (the migration doesn't rewrite legacy rows)…
        const rawName = raw2.prepare("SELECT name FROM schedules WHERE id = ?").get(schedId)?.name;
        check("(1) the legacy row's stored name cell is NULL (migration adds the column, doesn't backfill)", rawName === null);
      } finally {
        raw2.close();
      }

      // …but the Db read DERIVES a friendly default from the cron, so the model's name is never empty.
      const legacy = db.getSchedule(schedId);
      check("(1) the legacy row reads a DERIVED default name (describeCron of its cron)", legacy.name === "Every day at 9:00 AM");
      check("(1) ...and every other legacy field is untouched", legacy.cron === "0 9 * * *" && legacy.kind === "manager" && legacy.agentId === agentId && legacy.prompt === null);

      // Idempotency: a SECOND Db construction over the SAME already-migrated file must not throw or re-ALTER.
      db.close();
      let secondCtorError = null;
      try {
        const { Db } = await import("../dist/db.js");
        db = new Db(dbFile);
      } catch (err) { secondCtorError = err; }
      check("(1) a second Db construction over the already-migrated file is idempotent (no throw)", secondCtorError === null);
      check("(1) ...and the derived legacy name is stable across the second boot", db.getSchedule(schedId)?.name === "Every day at 9:00 AM");
    }
  } finally {
    try { db?.close(); } catch { /* ignore */ }
    for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
  }
}

// ============================================================================================
// (2) NAME VALIDATION / ROUND-TRIP — a fresh hermetic env (real Db + SessionService + fake pty).
// ============================================================================================
{
  const tmpHome = path.join(os.tmpdir(), `loom-schedname-comp-${Date.now()}-${process.pid}`);
  fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
  process.env.LOOM_HOME = tmpHome;

  const { Db } = await import("../dist/db.js");
  const { PtyHost } = await import("../dist/pty/host.js");
  const { SessionService } = await import("../dist/sessions/service.js");
  const { OrchestrationControl } = await import("../dist/orchestration/control.js");

  const vault = path.join(tmpHome, "vault");
  fs.mkdirSync(vault, { recursive: true });
  const repo = tmpHome;
  const now = new Date().toISOString();
  const db = new Db(path.join(tmpHome, "sched.db"));
  db.insertProject({ id: "pS", name: "SchedProj", repoPath: repo, vaultPath: vault, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "agentMgr", projectId: "pS", name: "Mgr", startupPrompt: "AGENT_MGR_DOCTRINE", position: 0, profileId: null });

  // ===== db.insertSchedule: name derive vs. verbatim =====
  const blankId = randomUUID();
  db.insertSchedule({ id: blankId, name: "", agentId: "agentMgr", cron: "0 9 * * 1-5", enabled: true, nextFireAt: now, lastFiredAt: null, createdAt: now, kind: "manager", prompt: null });
  check("(2) db.insertSchedule with a BLANK name derives the default (describeCron)", db.getSchedule(blankId)?.name === "Every weekday at 9:00 AM");

  const namedId = randomUUID();
  db.insertSchedule({ id: namedId, name: "  Nightly sweep  ", agentId: "agentMgr", cron: "0 2 * * *", enabled: true, nextFireAt: now, lastFiredAt: null, createdAt: now, kind: "manager", prompt: null });
  check("(2) db.insertSchedule stores a real name (trimmed)", db.getSchedule(namedId)?.name === "Nightly sweep");

  // ===== service.createSchedule / updateScheduleAsManager (the agent path) =====
  class SeamHost extends PtyHost {
    createPty() { return { pid: 4242, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} }; }
  }
  const events = {
    onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
    onBusy(id, busy) { db.setBusy(id, busy); },
    onContextStats() {}, onRateLimited() {},
    onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
  };
  const svc = new SessionService(db, new SeamHost(events), new OrchestrationControl());
  db.insertSession({
    id: "mgrS", projectId: "pS", agentId: "agentMgr", engineSessionId: null, title: null,
    cwd: repo, processState: "live", resumability: "unknown", busy: false,
    createdAt: now, lastActivity: now, lastError: null, role: "manager",
  });

  const withName = svc.createSchedule("mgrS", { agentId: "agentMgr", cron: "0 6 * * *", name: "Morning brief" });
  check("(2) service.createSchedule threads a name through", withName.name === "Morning brief" && db.getSchedule(withName.id)?.name === "Morning brief");

  const noName = svc.createSchedule("mgrS", { agentId: "agentMgr", cron: "0 12 * * *" });
  check("(2) service.createSchedule with NO name derives the default (agent backward-compat)", db.getSchedule(noName.id)?.name === "Every day at 12:00 PM");

  const renamed = svc.updateScheduleAsManager("mgrS", noName.id, { name: "Lunch check" });
  check("(2) updateScheduleAsManager renames a schedule", renamed.name === "Lunch check");

  const blankRename = svc.updateScheduleAsManager("mgrS", noName.id, { name: "   " });
  check("(2) updateScheduleAsManager IGNORES a blank rename (a schedule always keeps a name)", blankRename.name === "Lunch check");

  const untouched = svc.updateScheduleAsManager("mgrS", withName.id, { enabled: false });
  check("(2) updateScheduleAsManager omitting name leaves it untouched", untouched.name === "Morning brief" && untouched.enabled === false);

  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the friendly-cron model composes/reads/round-trips every frequency, a mandatory schedule `name` migrates cleanly onto a real legacy DB (idempotent, derived default, no index reference), and names round-trip through the db + service surfaces (blank derives/ignored, real stored verbatim)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
