import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card c1161989 condition #4 (manager direction): a spy-based proof that `reconcileOrchestrationOnBoot`'s
// Pass A/A2 call `getProject`/`getTask`/`listEventsForWorker` O(1) TIMES (a handful of bulk queries), not
// O(N) (once per session) — the exact class of regression this card's fix exists to close. N worker
// sessions across 2 projects/tasks, all taking Pass A's cheapest "never requested a merge, task already
// terminal" short-circuit (no git/fs work needed, isolating the DB-call count from git-call noise).
//
// NO real git repo needed — every fixture session short-circuits BEFORE Pass A ever resolves a repo.
// Run: 1) build daemon, 2) node test/reconcile-pass-a-bulk-db-calls.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-pa-bulkcalls-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const now = new Date().toISOString();

const db = new Db();
const sessions = new SessionService(db, {}, new OrchestrationControl());

const N = 20;
const PROJECTS = 2;
const projIds = [];
const agentIds = [];
const mgrIds = [];
for (let p = 0; p < PROJECTS; p++) {
  const projId = `pabc-proj${p}-${sfx}`;
  const agentId = `pabc-agent${p}-${sfx}`;
  const mgrId = `pabc-mgr${p}-${sfx}`;
  // fake, never-touched paths — no fixture session here ever reaches a git/fs call on them.
  db.insertProject({ id: projId, name: `PABC-${p}`, repoPath: path.join(os.tmpdir(), `pabc-fake-repo-${p}-${sfx}`), vaultPath: path.join(os.tmpdir(), `pabc-fake-vault-${p}-${sfx}`), config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: os.tmpdir(), processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  projIds.push(projId); agentIds.push(agentId); mgrIds.push(mgrId);
}

for (let i = 0; i < N; i++) {
  const p = i % PROJECTS;
  const taskId = `pabc-task${i}-${sfx}`;
  // columnKey "done" matches this project's resolved default terminal role (config.ts's
  // DEFAULT_KANBAN_COLUMNS; config is `{}` here, so no override) — isTerminalTask reads true for every one.
  db.insertTask({ id: taskId, projectId: projIds[p], title: `PABC ${i}`, body: "", columnKey: "done", position: i, createdAt: now, updatedAt: now });
  const sessId = `pabc-sess${i}-${sfx}`;
  // worktreePath never exists on disk, and NO merge_request event is ever appended — every one of these
  // N sessions takes Pass A's "never requested a merge, task already terminal" short-circuit, the exact
  // branch that reads getProject/isTerminalTask/neverRequestedMerge and nothing past it.
  db.insertSession({
    id: sessId, projectId: projIds[p], agentId: agentIds[p], engineSessionId: null, title: null,
    cwd: path.join(os.tmpdir(), `pabc-fake-wt-${i}-${sfx}`), processState: "exited", resumability: "unknown",
    busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker",
    parentSessionId: mgrIds[p], taskId, worktreePath: path.join(os.tmpdir(), `pabc-fake-wt-${i}-${sfx}`),
    branch: `loom/pabc-${i}-${sfx}`,
  });
}

// ════════ SPY — wrap the per-session-shaped Db methods AFTER construction, before the real run ════════
const origGetProject = Db.prototype.getProject;
const origGetTask = Db.prototype.getTask;
const origListEventsForWorker = Db.prototype.listEventsForWorker;
const origGetTaskColumnKeysByIds = Db.prototype.getTaskColumnKeysByIds;
const origBuildWorkerEventPresenceMap = Db.prototype.buildWorkerEventPresenceMap;
const origListAllProjectsIncludingArchived = Db.prototype.listAllProjectsIncludingArchived;
const calls = { getProject: 0, getTask: 0, listEventsForWorker: 0, getTaskColumnKeysByIds: 0, buildWorkerEventPresenceMap: 0, listAllProjectsIncludingArchived: 0 };
Db.prototype.getProject = function (...a) { calls.getProject++; return origGetProject.apply(this, a); };
Db.prototype.getTask = function (...a) { calls.getTask++; return origGetTask.apply(this, a); };
Db.prototype.listEventsForWorker = function (...a) { calls.listEventsForWorker++; return origListEventsForWorker.apply(this, a); };
Db.prototype.getTaskColumnKeysByIds = function (...a) { calls.getTaskColumnKeysByIds++; return origGetTaskColumnKeysByIds.apply(this, a); };
Db.prototype.buildWorkerEventPresenceMap = function (...a) { calls.buildWorkerEventPresenceMap++; return origBuildWorkerEventPresenceMap.apply(this, a); };
Db.prototype.listAllProjectsIncludingArchived = function (...a) { calls.listAllProjectsIncludingArchived++; return origListAllProjectsIncludingArchived.apply(this, a); };

const r = await sessions.reconcileOrchestrationOnBoot();

// Restore immediately — never leave the spy installed past this one measured call.
Db.prototype.getProject = origGetProject;
Db.prototype.getTask = origGetTask;
Db.prototype.listEventsForWorker = origListEventsForWorker;
Db.prototype.getTaskColumnKeysByIds = origGetTaskColumnKeysByIds;
Db.prototype.buildWorkerEventPresenceMap = origBuildWorkerEventPresenceMap;
Db.prototype.listAllProjectsIncludingArchived = origListAllProjectsIncludingArchived;

console.log(`\ncall counts for N=${N} sessions across ${PROJECTS} projects: ${JSON.stringify(calls)}`);

// ════════ CORRECTNESS FIRST — the bulk path must still produce the RIGHT answer ════════
check(`all ${N} sessions short-circuited cleanly (0 merge failures, 0 wedges)`, r.mergesFailed === 0 && r.mergeReconcileWedged === 0);

// ════════ O(1), NOT O(N) — the regression-sensitive assertions ════════
// Bound well under N (20): a handful of bulk-map-building calls is fine, one-per-session is not.
const BOUND = 5;
check(`getProject called O(1) times (${calls.getProject}), not once per session (would be >= ${N})`, calls.getProject < BOUND);
check(`getTask called O(1) times (${calls.getTask}) — the bulk path never calls plain getTask per session (would be >= ${N} if it did)`, calls.getTask < BOUND);
check(`listEventsForWorker called ZERO times (${calls.listEventsForWorker}) — no session here ever reaches finalizeMerge/A2's own fallback append`, calls.listEventsForWorker === 0);
check(`getTaskColumnKeysByIds called O(1) times (${calls.getTaskColumnKeysByIds}), once per pass (Pass A + Pass A2), never once per session`, calls.getTaskColumnKeysByIds > 0 && calls.getTaskColumnKeysByIds < BOUND);
check(`buildWorkerEventPresenceMap called O(1) times (${calls.buildWorkerEventPresenceMap}), once per pass, never once per session`, calls.buildWorkerEventPresenceMap > 0 && calls.buildWorkerEventPresenceMap < BOUND);
// Round 2 (Code Review 5011411a, finding 1): Pass A2 and Pass B each rebuild their own FRESH project map
// now, rather than reusing Pass A's one-time snapshot (a project deleted/rebound mid-run must read as
// gone by the time a later pass runs) — so this is O(1) PER PASS (3 total: A, A2, B), not ONE shared call.
check(`listAllProjectsIncludingArchived called O(1) times per pass (${calls.listAllProjectsIncludingArchived}; 3 passes: A, A2, B), never once per session`, calls.listAllProjectsIncludingArchived > 0 && calls.listAllProjectsIncludingArchived < BOUND);

db.close();
fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });

console.log(failures === 0
  ? "\n✅ ALL PASS — reconcileOrchestrationOnBoot's Pass A/A2 resolve getProject/getTask/listEventsForWorker via a bounded number of bulk queries, independent of session count, instead of one DB call per session."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
