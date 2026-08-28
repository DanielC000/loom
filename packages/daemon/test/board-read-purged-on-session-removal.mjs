import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 15bdb031: board-read.ts's `recordBoardRead` (card 9c8e256e) stores a per-session snapshot via the
// generic `Db.setMeta`, keyed `board_read:<sessionId>:<projectId>` (one row per project a session ever
// read — card e9750bc2). Nothing ever removed those rows, so an active daemon accumulates one permanently
// per session that ever called tasks_list. Db.archiveSession/deleteSession/deleteProject/deleteAgent are
// the FOUR real per-session removal points in db.ts (deleteSession already purges wakes/reminders/grants/
// questions the same way; deleteProject/deleteAgent replicate that same list per session inside their own
// cascades) — this proves all four now also purge a retired session's board-read snapshot(s), while never
// touching a DIFFERENT, still-live session's own snapshot (the negative arm — a purge that clears
// everything would pass a one-sided test).
//
// Each scenario is POSITIVE-CONTROLLED: the row is proven to EXIST (computeBoardDelta computed===true)
// BEFORE the removal call, so "absent afterwards" is never confused with "the key was never written."
//
// Also proves the PREFIX-delete shape is load-bearing, not incidental: a session that read TWO different
// projects' boards gets BOTH of its snapshots purged by ONE archiveSession call — a naive exact-key
// delete (matching only board_read:<sessionId> with no :<projectId> suffix) would silently miss the
// second one.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-brpsr-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { recordBoardRead, computeBoardDelta } = await import("../dist/orchestration/board-read.js");

const now = new Date().toISOString();
const dbFile = path.join(tmpHome, "brpsr.db");
const db = new Db(dbFile);

function makeProject(id) {
  db.insertProject({ id, name: id, repoPath: "C:/" + id, vaultPath: "C:/" + id, config: {}, createdAt: now, archivedAt: null, reserved: false });
  db.insertTask({ id: id + "-task", projectId: id, title: "T", body: "", columnKey: "todo", priority: "p2", position: 0, createdAt: now, updatedAt: now });
}
function makeAgent(id, projectId) {
  db.insertAgent({ id, projectId, name: id, startupPrompt: "BRIEF", position: 0 });
}
function seedSession(id, projectId, agentId, role = "manager") {
  db.insertSession({
    id, projectId, agentId, engineSessionId: "eng-" + id, title: null, cwd: "C:/f",
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role,
  });
}
const snapshot = (sessionId, projectId) => recordBoardRead(db, sessionId, projectId, now);
const exists = (sessionId, projectId) => computeBoardDelta(db, sessionId, projectId, db.listTasks(projectId)).computed === true;

try {
  makeProject("brpsr-p1");
  makeProject("brpsr-p2");
  makeAgent("brpsr-agent", "brpsr-p1");
  makeAgent("brpsr-agent-2", "brpsr-p1"); // dedicated agent for the deleteAgent scenario, so its cascade doesn't also delete unrelated sessions
  makeAgent("brpsr-agent-3", "brpsr-p1"); // dedicated agent for the deleteProject scenario's negative-arm session

  // The negative-arm control: a LIVE session, untouched by ANY of the four scenarios below, checked once
  // at the very end. If any scenario's purge over-reached (cleared everything instead of one session), this fails.
  const LIVE = "brpsr-live";
  seedSession(LIVE, "brpsr-p1", "brpsr-agent");
  snapshot(LIVE, "brpsr-p1");
  check("setup: the negative-control LIVE session's board-read row exists before any scenario runs", exists(LIVE, "brpsr-p1"));

  // ═══════════════════════ (1) archiveSession — also proves the PREFIX-delete shape ═══════════════════
  const ARCH = "brpsr-archive";
  seedSession(ARCH, "brpsr-p1", "brpsr-agent");
  snapshot(ARCH, "brpsr-p1");
  snapshot(ARCH, "brpsr-p2"); // this session ALSO read a second project's board (e9750bc2 multi-project keying)
  check("(1) positive control: archiveSession target's row exists (project 1) before archiving", exists(ARCH, "brpsr-p1"));
  check("(1) positive control: archiveSession target's row exists (project 2) before archiving", exists(ARCH, "brpsr-p2"));
  db.archiveSession(ARCH);
  check("(1) archiveSession purges the row for project 1", !exists(ARCH, "brpsr-p1"));
  check("(1) archiveSession ALSO purges the row for project 2 (prefix delete, not a single exact key)", !exists(ARCH, "brpsr-p2"));

  // ═══════════════════════════════════ (2) deleteSession ════════════════════════════════════════════
  const DEL = "brpsr-delete";
  seedSession(DEL, "brpsr-p1", "brpsr-agent");
  snapshot(DEL, "brpsr-p1");
  check("(2) positive control: deleteSession target's row exists before deleting", exists(DEL, "brpsr-p1"));
  db.deleteSession(DEL);
  check("(2) deleteSession purges the row", !exists(DEL, "brpsr-p1"));

  // ══════════════════════════════════ (3) deleteProject (cascade) ═══════════════════════════════════
  const PROJ_SESS = "brpsr-proj-sess";
  seedSession(PROJ_SESS, "brpsr-p2", "brpsr-agent-3");
  snapshot(PROJ_SESS, "brpsr-p2");
  check("(3) positive control: deleteProject cascade target's row exists before deleting the project", exists(PROJ_SESS, "brpsr-p2"));
  db.deleteProject("brpsr-p2");
  check("(3) deleteProject's cascade purges the row", !exists(PROJ_SESS, "brpsr-p2"));

  // ═══════════════════════════════════ (4) deleteAgent (cascade) ════════════════════════════════════
  const AGENT_SESS = "brpsr-agent-sess";
  seedSession(AGENT_SESS, "brpsr-p1", "brpsr-agent-2");
  snapshot(AGENT_SESS, "brpsr-p1");
  check("(4) positive control: deleteAgent cascade target's row exists before deleting the agent", exists(AGENT_SESS, "brpsr-p1"));
  db.deleteAgent("brpsr-agent-2");
  check("(4) deleteAgent's cascade purges the row", !exists(AGENT_SESS, "brpsr-p1"));

  // ═══════════════════════════════════════ negative arm ═════════════════════════════════════════════
  check("negative arm: the untouched LIVE session's board-read row SURVIVED all four scenarios", exists(LIVE, "brpsr-p1"));
} finally {
  try { db.close(); } catch { /* ignore */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* ignore */ } }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — archiveSession/deleteSession/deleteProject/deleteAgent all purge a retired session's board-read snapshot(s) (across every project it read), while a different live session's own snapshot is left untouched."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
