import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Per-schedule custom prompt (card 35c72d0f): an OPTIONAL `prompt` on a Schedule, appended to the
// fired session's own startupPrompt (agent prompt first, then a clearly-delimited "Scheduled task:"
// block). HERMETIC + CLAUDE-FREE + NETWORK-FREE: a REAL Db + SessionService against a FAKE pty
// (mirrors manager-context-block.mjs), plus a raw better-sqlite3 legacy-DB synth (mirrors
// db-legacy-boot.mjs). Proves the DoD:
//   (1) MIGRATION: a real pre-`prompt` legacy `schedules` table boots clean under a real Db (no
//       crash), gains the `prompt` column, an existing row reads prompt as NULL, the migration is
//       idempotent (a second Db construction over the same file is still clean), and the
//       `idx_schedules_due` index does NOT reference `prompt`.
//   (2) COMPOSITION — prompt SET: startManager/startAuditor/startWorkspaceAuditor compose the
//       agent's OWN startupPrompt FIRST, then the schedule's custom prompt as a delimited trailing
//       block — never before/inside the agent's own prompt.
//   (3) COMPOSITION — prompt UNSET (omitted/null/undefined): byte-identical to today (asserted as an
//       exact string match AND as a prefix-preservation check against the prompt-SET case).
//   (4) db/service round-trip: insertSchedule/getSchedule/updateSchedule and
//       createSchedule/updateScheduleAsManager all carry `prompt` through untouched.
//
// Run: 1) build (turbo builds shared first), 2) node test/schedule-prompt.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// ============================================================================================
// (1) MIGRATION — synthesize a real pre-`prompt` legacy `schedules` table, boot a real Db against it.
// ============================================================================================
{
  const tmpHome = path.join(os.tmpdir(), `loom-schedprompt-mig-${Date.now()}-${process.pid}`);
  fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
  process.env.LOOM_HOME = tmpHome;
  const { requireHermeticEnv } = await import("./_guard.mjs");
  requireHermeticEnv();

  const dbFile = path.join(tmpHome, "legacy.db");
  const projId = randomUUID();
  const agentId = randomUUID();
  const schedId = randomUUID();
  const now = new Date().toISOString();

  // The true pre-this-change shape: `kind` already shipped (Platform Manager P5), `prompt` does not
  // exist yet — exactly what a real upgraded ~/.loom/loom.db looks like today.
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
        kind TEXT NOT NULL DEFAULT 'manager'
      );
      CREATE INDEX idx_schedules_due ON schedules(enabled, next_fire_at);
    `);
    raw.prepare("INSERT INTO projects (id, name, repo_path, vault_path, config_json, created_at, archived_at) VALUES (?, ?, ?, ?, '{}', ?, NULL)")
      .run(projId, "Legacy Sched Project", projId, projId, now);
    raw.prepare("INSERT INTO agents (id, project_id, name, startup_prompt, position) VALUES (?, ?, 'Legacy Agent', 'DOCTRINE', 0)")
      .run(agentId, projId);
    raw.prepare("INSERT INTO schedules (id, agent_id, cron, enabled, next_fire_at, last_fired_at, created_at, kind) VALUES (?, ?, '0 9 * * *', 1, ?, NULL, ?, 'manager')")
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
    check("(1) constructing Db against a legacy pre-`prompt` schedules DB does not throw", ctorError === null);
    if (ctorError) console.log(`    threw: ${ctorError?.stack || ctorError}`);

    if (!ctorError) {
      const raw2 = new Database(dbFile, { readonly: true });
      try {
        const cols = new Set(raw2.prepare("PRAGMA table_info(schedules)").all().map((c) => c.name));
        check("(1) schedules gained the prompt column", cols.has("prompt"));

        const idxSql = raw2.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_schedules_due'").get()?.sql ?? "";
        check("(1) idx_schedules_due still exists", idxSql.length > 0);
        check("(1) idx_schedules_due does NOT reference prompt (plain nullable data column)", !/prompt/i.test(idxSql));

        const legacy = db.getSchedule(schedId);
        check("(1) the pre-existing legacy row reads prompt as NULL (not crash, not coerced to '')", legacy.prompt === null);
        check("(1) ...and every other legacy field is untouched", legacy.cron === "0 9 * * *" && legacy.kind === "manager" && legacy.agentId === agentId);
      } finally {
        raw2.close();
      }

      // Idempotency: a SECOND Db construction over the SAME already-migrated file must not throw or
      // re-ALTER (ALTER TABLE ADD COLUMN on an existing column would throw "duplicate column name").
      db.close();
      let secondCtorError = null;
      try {
        const { Db } = await import("../dist/db.js");
        db = new Db(dbFile);
      } catch (err) { secondCtorError = err; }
      check("(1) a second Db construction over the already-migrated file is idempotent (no throw)", secondCtorError === null);
      check("(1) ...and the previously-NULL prompt is still NULL after the second boot", db.getSchedule(schedId)?.prompt === null);
    }
  } finally {
    try { db?.close(); } catch { /* ignore */ }
    for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
  }
}

// ============================================================================================
// (2)+(3) COMPOSITION — a fresh hermetic env (SessionService + fake pty), mirrors manager-context-block.mjs
// ============================================================================================
{
  const tmpHome = path.join(os.tmpdir(), `loom-schedprompt-comp-${Date.now()}-${process.pid}`);
  fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
  process.env.LOOM_HOME = tmpHome;

  const { Db } = await import("../dist/db.js");
  const { PtyHost } = await import("../dist/pty/host.js");
  const { SessionService } = await import("../dist/sessions/service.js");
  const { OrchestrationControl } = await import("../dist/orchestration/control.js");
  const { appendScheduledPrompt } = await import("../dist/sessions/manager-prompt.js");

  // ===== pure appendScheduledPrompt =====
  check("pure: unset (undefined) prompt returns the base untouched", appendScheduledPrompt("BASE", undefined) === "BASE");
  check("pure: null prompt returns the base untouched", appendScheduledPrompt("BASE", null) === "BASE");
  check("pure: blank/whitespace prompt returns the base untouched", appendScheduledPrompt("BASE", "   ") === "BASE");
  check("pure: undefined base + unset prompt returns undefined (no crash)", appendScheduledPrompt(undefined, undefined) === undefined);
  const purePrompted = appendScheduledPrompt("BASE", "Do the task.");
  check("pure: base preserved, custom prompt appended after a --- delimiter + label",
    purePrompted.startsWith("BASE") && purePrompted.includes("---\nScheduled task:\nDo the task."));
  const pureNoBase = appendScheduledPrompt(undefined, "Do the task.");
  check("pure: undefined base + a set prompt → block-only, no crash, no leading delimiter",
    pureNoBase === "Scheduled task:\nDo the task." && !pureNoBase.startsWith("---"));

  const vault = path.join(tmpHome, "vault");
  fs.mkdirSync(vault, { recursive: true });
  const repo = tmpHome; // manager cwd only — no git needed (no worker spawn in this section)
  const now = new Date().toISOString();
  // Explicit file path (NOT the default `new Db()` → DB_PATH): `paths.js`'s LOOM_HOME-derived DB_PATH
  // constant was already frozen at its first import in section (1) above — a bare `new Db()` here would
  // silently reopen section (1)'s now-deleted temp dir instead of this section's fresh tmpHome.
  const db = new Db(path.join(tmpHome, "sched.db"));
  db.insertProject({ id: "pS", name: "SchedProj", repoPath: repo, vaultPath: vault, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "agentMgr", projectId: "pS", name: "Mgr", startupPrompt: "AGENT_MGR_DOCTRINE", position: 0, profileId: null });
  db.insertAgent({ id: "agentAud", projectId: "pS", name: "Aud", startupPrompt: "AGENT_AUD_DOCTRINE", position: 1, profileId: null });
  db.insertAgent({ id: "agentWsa", projectId: "pS", name: "Wsa", startupPrompt: "AGENT_WSA_DOCTRINE", position: 2, profileId: null });

  class SeamHost extends PtyHost {
    constructor(events) { super(events); this.capture = []; }
    createPty(opts) {
      this.capture.push(opts);
      return { pid: 4242, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} };
    }
  }
  const events = {
    onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
    onBusy(id, busy) { db.setBusy(id, busy); },
    onContextStats() {}, onRateLimited() {},
    onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
  };
  const host = new SeamHost(events);
  const svc = new SessionService(db, host, new OrchestrationControl());
  const optsFor = (sid) => host.capture.find((o) => o.sessionId === sid);

  // ===== MANAGER: unset variants are byte-identical to each other =====
  const mOmitted = optsFor(svc.startManager("agentMgr").id);
  const mNull = optsFor(svc.startManager("agentMgr", null).id);
  const mUndef = optsFor(svc.startManager("agentMgr", undefined).id);
  check("(3) manager: omitted prompt === explicit null (byte-identical)", mOmitted.startupPrompt === mNull.startupPrompt);
  check("(3) manager: omitted prompt === explicit undefined (byte-identical)", mOmitted.startupPrompt === mUndef.startupPrompt);
  check("(3) manager: unset composed prompt carries no 'Scheduled task' block", !mOmitted.startupPrompt.includes("Scheduled task"));
  check("(3) manager: unset composed prompt still carries the 'Where things live' block + own doctrine (untouched by this feature)",
    mOmitted.startupPrompt.includes("## Where things live") && mOmitted.startupPrompt.includes("AGENT_MGR_DOCTRINE"));

  // ===== MANAGER: prompt SET composes agent-first, custom-prompt-appended =====
  const mSet = optsFor(svc.startManager("agentMgr", "Review the open PRs.").id);
  check("(2) manager: prompt-set startupPrompt is the UNSET composition + the appended block, verbatim (prefix-preserved)",
    mSet.startupPrompt.startsWith(mOmitted.startupPrompt) && mSet.startupPrompt.length > mOmitted.startupPrompt.length);
  check("(2) manager: prompt-set startupPrompt carries the delimited 'Scheduled task:' block with the custom text",
    mSet.startupPrompt.includes("---\nScheduled task:\nReview the open PRs."));
  check("(2) manager: agent's own doctrine + 'Where things live' block still precede the custom block",
    mSet.startupPrompt.indexOf("Where things live") < mSet.startupPrompt.indexOf("AGENT_MGR_DOCTRINE") &&
    mSet.startupPrompt.indexOf("AGENT_MGR_DOCTRINE") < mSet.startupPrompt.indexOf("Scheduled task"));

  // ===== AUDITOR: same contract, but NO 'Where things live' block (manager-only) =====
  const aOmitted = optsFor(svc.startAuditor("agentAud").id);
  const aSet = optsFor(svc.startAuditor("agentAud", "Audit the last 24h of transcripts.").id);
  check("(3) auditor: unset prompt is byte-identical to the agent's own startupPrompt (no manager block, no custom block)",
    aOmitted.startupPrompt === "AGENT_AUD_DOCTRINE");
  check("(2) auditor: prompt-set is the unset composition + the appended block, verbatim (prefix-preserved)",
    aSet.startupPrompt.startsWith(aOmitted.startupPrompt) && aSet.startupPrompt.includes("---\nScheduled task:\nAudit the last 24h of transcripts."));
  check("(2) auditor: does NOT pick up the manager-only 'Where things live' block", !aSet.startupPrompt.includes("Where things live"));

  // ===== WORKSPACE-AUDITOR: same contract =====
  const wOmitted = optsFor(svc.startWorkspaceAuditor("agentWsa").id);
  const wSet = optsFor(svc.startWorkspaceAuditor("agentWsa", "Review my workspace for friction.").id);
  check("(3) workspace-auditor: unset prompt is byte-identical to the agent's own startupPrompt", wOmitted.startupPrompt === "AGENT_WSA_DOCTRINE");
  check("(2) workspace-auditor: prompt-set is the unset composition + the appended block, verbatim (prefix-preserved)",
    wSet.startupPrompt.startsWith(wOmitted.startupPrompt) && wSet.startupPrompt.includes("---\nScheduled task:\nReview my workspace for friction."));

  // ===== (4) db/service round-trip: createSchedule / updateScheduleAsManager carry prompt through =====
  // A manager session so requireManager/requireOwnProject pass.
  db.insertSession({
    id: "mgrS", projectId: "pS", agentId: "agentMgr", engineSessionId: null, title: null,
    cwd: repo, processState: "live", resumability: "unknown", busy: false,
    createdAt: now, lastActivity: now, lastError: null, role: "manager",
  });
  const created = svc.createSchedule("mgrS", { agentId: "agentMgr", cron: "0 9 * * *", prompt: "Nightly sweep." });
  check("(4) createSchedule persists the prompt on the returned Schedule", created.prompt === "Nightly sweep.");
  check("(4) createSchedule persists the prompt in the DB (round-trip via getSchedule)", db.getSchedule(created.id)?.prompt === "Nightly sweep.");

  const noPrompt = svc.createSchedule("mgrS", { agentId: "agentMgr", cron: "0 10 * * *" });
  check("(4) createSchedule with no prompt persists prompt:null (not undefined/empty-string)", noPrompt.prompt === null);

  const updated = svc.updateScheduleAsManager("mgrS", noPrompt.id, { prompt: "Now set on update." });
  check("(4) updateScheduleAsManager sets a previously-null prompt", updated.prompt === "Now set on update.");
  const cleared = svc.updateScheduleAsManager("mgrS", noPrompt.id, { prompt: null });
  check("(4) updateScheduleAsManager clears a prompt back to null (the REST/web clear shape)", cleared.prompt === null);
  const untouchedByOmission = svc.updateScheduleAsManager("mgrS", created.id, { enabled: false });
  check("(4) updateScheduleAsManager omitting prompt leaves an existing prompt untouched", untouchedByOmission.prompt === "Nightly sweep." && untouchedByOmission.enabled === false);

  // ===== CR follow-up: the MCP surfaces can't carry `null` (Zod `z.string().optional()`), so they
  // clear a prompt via `""` — this must normalize to NULL at the shared DB write path, identically to
  // the REST/web `null` clear above, so schedule_get/list_all_schedules never disagree by surface. =====
  db.updateSchedule(created.id, { prompt: "" }); // the MCP clear shape, called at the db layer directly
  check("(4) db.updateSchedule: clearing via \"\" (the MCP shape) normalizes to NULL, not stored as \"\"",
    db.getSchedule(created.id)?.prompt === null);
  db.updateSchedule(created.id, { prompt: "   " }); // whitespace-only also normalizes (mirrors appendScheduledPrompt's trim)
  check("(4) db.updateSchedule: clearing via whitespace-only also normalizes to NULL", db.getSchedule(created.id)?.prompt === null);
  db.updateSchedule(created.id, { prompt: "Reset via db layer." });
  db.updateSchedule(created.id, { enabled: true }); // omitting prompt must still OMIT (not collapse to null)
  check("(4) db.updateSchedule: omitting prompt (undefined) leaves a set prompt untouched", db.getSchedule(created.id)?.prompt === "Reset via db layer.");
  db.insertSchedule({ id: randomUUID(), agentId: "agentMgr", cron: "0 11 * * *", enabled: true, nextFireAt: now, lastFiredAt: null, createdAt: now, kind: "manager", prompt: "" });
  const insertedBlank = db.listSchedules().find((s) => s.cron === "0 11 * * *");
  check("(4) db.insertSchedule: a create with prompt:\"\" also normalizes to NULL (not stored as \"\")", insertedBlank?.prompt === null);

  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — an optional per-schedule prompt migrates cleanly onto a real legacy DB (idempotent, no crash, no index reference), composes AFTER the agent's own startupPrompt (manager/auditor/workspace-auditor alike) with a clearly-delimited block, is byte-identical to today when unset, and round-trips through createSchedule/updateScheduleAsManager."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
