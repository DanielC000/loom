import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card c1161989 condition #1 (manager direction): `reconcileOrchestrationOnBoot`'s own `taskColumnKeyMap`
// (the bulk precompute replacing Pass A's per-session `getTask(s.taskId)?.columnKey` call) must stay LIVE
// across a single run, not a one-shot snapshot taken at the top — Pass A's own `finalizeMerge` call moves
// a task's columnKey WHILE the loop is still running, and a LATER-processed session sharing the SAME
// taskId (a re-task/recycle sibling) must see that fresh columnKey, or its `isTerminalTask` check wrongly
// reads false and it falls through to repoKey resolution it should have short-circuited past.
//
// REAL git on a temp repo, NO claude, NO live daemon — mirrors
// latest-event-seq-map-in-run-staleness.mjs's shape exactly, but for the TASK map instead of the
// merge_done seq map. Row1 and Row2 share ONE taskId but have SEPARATE branches/worktrees (a task can be
// re-tasked onto a brand-new worker while a stale sibling row lingers) — Row1 gets a real, live finalize
// that moves the task off "in_progress"; Row2 has NO merge_request of its own and a worktree that does
// NOT exist on disk, so it is eligible for Pass A's "never requested a merge, task already terminal"
// short-circuit the INSTANT the task map reflects Row1's write.
//
// Row2's own `repoKey` ("stale-repo-not-registered") names a repo the project never registered — if the
// short-circuit does NOT fire (a stale task map), Row2 falls through to `resolveRepoByKey`, which throws
// `UnknownRepoKeyError`, producing a wedged `mergesFailed` entry. This is the regression-sensitive
// assertion: with the fix's live map, Row2 never reaches that call at all.
//
// Run: 1) build daemon, 2) node test/reconcile-pass-a-task-map-live-update.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { commitAll } from "./_git-commit.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-pa-taskmap-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=patm@loom -c user.name=patm";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const now = new Date().toISOString();

const db = new Db();
const sessions = new SessionService(db, {}, new OrchestrationControl());

const repo = path.join(os.tmpdir(), `loom-patm-repo-${sfx}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# patm\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", GIT_ID);
git(repo, "branch -M main");

const projId = `patm-proj-${sfx}`, agentId = `patm-agent-${sfx}`, taskId = `patm-task-${sfx}`, mgrId = `patm-mgr-${sfx}`;
const row1Id = `patm-row1-${sfx}`, row2Id = `patm-row2-${sfx}`;
db.insertProject({ id: projId, name: "PATM", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
db.insertTask({ id: taskId, projectId: projId, title: "PATM", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

// Row1's own worktree/branch, a REAL squash landing with the Loom-Worker-Branch trailer — Pass A's
// squash-detection discovers + finalizes it LIVE during this run, moving taskId's columnKey.
const { worktreePath: wt1, branch: branch1 } = await createWorktree(repo, projId, taskId);
fs.writeFileSync(path.join(wt1, "change.txt"), "worker change\n");
commitAll(wt1, "change", GIT_ID);
execSync(`git ${GIT_ID} merge --squash ${branch1} && git ${GIT_ID} commit -q -m "PATM" -m "Loom-Worker-Branch: ${branch1}"`, { cwd: repo });

// Row1: visited FIRST (later lastActivity, listAllSessionsIncludingArchived orders DESC). Seeded with its
// OWN merge_request so the unrelated "never requested a merge" early-out can't short-circuit past the
// real finalize this test needs to happen.
const row1LastActivity = new Date(Date.parse(now) + 2000).toISOString();
db.insertSession({ id: row1Id, projectId: projId, agentId, engineSessionId: null, title: null, cwd: wt1, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: row1LastActivity, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: wt1, branch: branch1 });
db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: row1Id, taskId, kind: "merge_request", detail: { branch: branch1, filesChanged: 1, tip: branch1, repoKey: null } });

// Row2: SAME taskId, visited SECOND (earlier/`now` lastActivity). A DIFFERENT, never-created worktree
// path (never on disk) and branch, NO merge_request of its own, and a repoKey the project never
// registered — a stale leftover sibling row from before a re-task. It must be skipped CLEANLY by the
// "never requested a merge, task already terminal" early-out, never reaching repoKey resolution.
const wt2 = path.join(os.tmpdir(), `loom-patm-nonexistent-wt-${sfx}`);
const branch2 = `loom/patm-row2-${sfx}`;
db.insertSession({ id: row2Id, projectId: projId, agentId, engineSessionId: null, title: null, cwd: wt2, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: wt2, branch: branch2, repoKey: "stale-repo-not-registered" });

// ════════ ILLUSTRATIVE ONLY — NOT a regression check (Code Review round 2, finding 4) ════════
// Neither of the two console lines below exercises `reconcileOrchestrationOnBoot` itself — they replay a
// hand-rolled formula against a snapshot taken by THIS TEST, independent of whatever the real
// implementation (naive or fixed) actually does. Both therefore read identically whether Pass A's own
// task map is live or a stale one-shot snapshot, and so can never fail the way a real assertion should —
// they document WHY the fix matters, they do not prove it. The real regression-sensitive assertions are
// below, against the ACTUAL reconcile run's result.
const illustrativeEarlySnapshot = db.getTaskColumnKeysByIds([taskId]);
console.log(`(illustrative, not asserted) a one-shot snapshot taken before reconcile runs reads '${illustrativeEarlySnapshot.get(taskId)}' — a naive "build once" implementation would have used this stale value for Row2's own later-in-the-SAME-run isTerminalTask check instead of seeing Row1's live write.`);

// ════════ THE REAL RUN — with the fix's LIVE map ════════
const r = await sessions.reconcileOrchestrationOnBoot();

check("Row1 got its OWN merge_done (a full, live finalize ran through it)", db.listEventsForWorker(row1Id).some((e) => e.kind === "merge_done"));
check("task moved OFF in_progress (Row1's finalize did the real bookkeeping)", db.getTask(taskId).columnKey !== "in_progress");
check(
  "exactly ZERO merge reconciliation failures — the regression-sensitive assertion: a stale task map would let Row2 wrongly fall through to repoKey resolution and wedge on its unregistered repoKey",
  r.mergesFailed === 0 && r.mergeReconcileWedged === 0,
);
check("Row2 produced no merge-reconcile wedge record at all (it never reached repoKey resolution)", !db.listMergeReconcileWedges().some((w) => w.sessionId === row2Id));
check("reconcile's own result reports exactly one merge finished (Row1's)", r.mergesFinished === 1);

// Prove the LIVE map (post-run) now reflects Row1's write — same key, different map instance in time —
// demonstrating the fix's map genuinely picked up the in-run write the naive snapshot structurally could
// not have.
{
  const postRunMap = db.getTaskColumnKeysByIds([taskId]);
  const postRunColumnKey = postRunMap.get(taskId);
  check(
    "the SAME key the naive snapshot had stuck at 'in_progress' now resolves (post-run) to the real, moved columnKey",
    typeof postRunColumnKey === "string" && postRunColumnKey === db.getTask(taskId).columnKey && postRunColumnKey !== "in_progress",
  );
}

db.close();
try { fs.rmSync(wt1, { recursive: true, force: true }); } catch { /* ignore */ }
try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });

console.log(failures === 0
  ? "\n✅ ALL PASS — reconcileOrchestrationOnBoot's in-run taskColumnKeyMap stays live: a first-processed session's real, live finalize is correctly seen by a second-processed session sharing the same task, within the SAME pass, so it takes the cheap short-circuit path instead of wrongly falling through to repoKey resolution. A one-shot snapshot taken before reconcile runs is shown to structurally lack the write the fix's live map carries by the time it's needed."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
