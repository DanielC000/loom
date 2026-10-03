import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card dd494a9b condition #2 (manager direction): `reconcileOrchestrationOnBoot`'s own `mergeDoneSeqMap`
// must stay LIVE across a single run, not a one-shot snapshot taken at the top — Pass A's `finalizeMerge`
// (and Pass A2's own resolver) APPEND `merge_done` WHILE the loop is still running, and a LATER-processed
// session sharing the SAME branch must see an EARLIER-processed session's fresh append or it wrongly
// re-finalizes (a duplicate merge_done, a re-moved task column, a redundant branch-delete CAS attempt).
//
// REAL git on a temp repo, NO claude, NO live daemon — drives reconcileOrchestrationOnBoot() directly,
// exactly like worktree-recycle-alias-protection.mjs. Two session rows share ONE worktree/branch/task;
// NEITHER has a pre-existing merge_done (unlike that file's fixture F, which pre-seeds the successor's —
// this file's whole point is to make reconcile discover+finalize the FIRST row's landing LIVE, during
// this run, and prove the SECOND row sees it).
//
// listAllSessionsIncludingArchived orders by `last_activity DESC`, so Row1 (later lastActivity) is
// visited BEFORE Row2 (earlier lastActivity) — Row1 gets the real, full finalize; Row2 must defer.
//
// Also proves a NAIVE one-shot snapshot (built once, before reconcile runs, never updated) would have
// MISSED Row1's live append — the data Row2's own "finalizedElsewhere" check needs — by capturing exactly
// that snapshot and showing it lacks the entry the fix's live map has by the time Row2 is reached.
// Run: 1) build daemon, 2) node test/latest-event-seq-map-in-run-staleness.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { commitAll } from "./_git-commit.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-lesm-stale-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db, latestEventSeqMapKey } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=lesm@loom -c user.name=lesm";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const now = new Date().toISOString();

const db = new Db();
const sessions = new SessionService(db, {}, new OrchestrationControl());

const repo = path.join(os.tmpdir(), `loom-lesm-stale-repo-${sfx}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# lesm\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", GIT_ID);
git(repo, "branch -M main");

const projId = `lesm-proj-${sfx}`, agentId = `lesm-agent-${sfx}`, taskId = `lesm-task-${sfx}`, mgrId = `lesm-mgr-${sfx}`;
const row1Id = `lesm-row1-${sfx}`, row2Id = `lesm-row2-${sfx}`;
db.insertProject({ id: projId, name: "LESM-STALE", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
db.insertTask({ id: taskId, projectId: projId, title: "LESM-STALE", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

// ONE shared worktree/branch, a REAL squash landing with the Loom-Worker-Branch trailer — Pass A's
// squash-detection resolves `landedSha` for EITHER row sharing this branch, independent of which row's id
// is attached (the detection is git-trailer-based, not worktree-based).
const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
fs.writeFileSync(path.join(worktreePath, "change.txt"), "worker change\n");
commitAll(worktreePath, "change", GIT_ID);
execSync(`git ${GIT_ID} merge --squash ${branch} && git ${GIT_ID} commit -q -m "LESM-STALE" -m "Loom-Worker-Branch: ${branch}"`, { cwd: repo });

// Row1: visited FIRST (later lastActivity). NO pre-existing events at all — its landing is discovered
// and fully finalized LIVE, during this run.
const row1LastActivity = new Date(Date.parse(now) + 2000).toISOString();
db.insertSession({ id: row1Id, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: row1LastActivity, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });

// Row2: visited SECOND (earlier/`now` lastActivity). Pre-seeded with its OWN merge_request (so the
// unrelated "never requested a merge" early-out can't short-circuit past the live-map check this test is
// actually for) but deliberately NO merge_done — it must come from seeing Row1's LIVE append.
db.insertSession({ id: row2Id, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });
db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: row2Id, taskId, kind: "merge_request", detail: { branch, filesChanged: 1, tip: branch, repoKey: null } });

// ════════ THE NAIVE-SNAPSHOT DEMONSTRATION — captured BEFORE reconcile runs ════════
// A one-shot snapshot taken at this instant (before Row1 is even processed) cannot possibly contain
// Row1's merge_done — it doesn't exist yet. This is exactly what a naive "build once, never update"
// implementation would have used for BOTH rows' lookups.
const naiveEarlySnapshot = db.buildLatestEventSeqMap("merge_done");
const mergeRequestSnapshot = db.buildLatestEventSeqMap("merge_request"); // safe either way (never appended during a run)
check(
  "NAIVE one-shot snapshot (taken before reconcile runs) has NO entry for this branch yet — proves it would have been stale for Row2's own later-in-the-SAME-run read",
  naiveEarlySnapshot.get(latestEventSeqMapKey(branch, null)) === undefined,
);
// Directly replay Pass A's OWN "finalizedElsewhere" formula (sessions/service.ts) for Row2, using the
// NAIVE pre-run snapshot in place of the fix's live map — the exact substitution a one-shot-snapshot
// implementation would have made. This is the regression THIS suite exists to catch, shown without
// needing to run a parallel broken copy of reconcileOrchestrationOnBoot.
{
  const repoScope = null;
  const naiveLatestDoneSeq = naiveEarlySnapshot.get(latestEventSeqMapKey(branch, repoScope)) ?? null;
  const naiveLatestRequestSeq = mergeRequestSnapshot.get(latestEventSeqMapKey(branch, repoScope)) ?? null;
  const naiveFinalizedElsewhere = naiveLatestDoneSeq != null && (naiveLatestRequestSeq == null || naiveLatestDoneSeq > naiveLatestRequestSeq);
  check(
    "THE TEST HAS TEETH: replaying Pass A's own formula with the NAIVE pre-run snapshot gives finalizedElsewhere=false for Row2 — a naive implementation would wrongly fall through to a SECOND finalizeMerge call",
    naiveFinalizedElsewhere === false,
  );
}

// ════════ THE REAL RUN — with the fix's LIVE map ════════
const r = await sessions.reconcileOrchestrationOnBoot();

check("Row1 now has its OWN merge_done (a full, live finalize ran through it)", db.listEventsForWorker(row1Id).some((e) => e.kind === "merge_done"));
check("task moved OFF in_progress (Row1's finalize did the real bookkeeping)", db.getTask(taskId).columnKey !== "in_progress");
check("Row2 has NO merge_done of its own (no duplicate finalize ran through it)", db.listEventsForWorker(row2Id).every((e) => e.kind !== "merge_done"));
check(
  "exactly ONE merge_done total across both rows for this branch — the regression-sensitive assertion: a stale/one-shot map would let Row2 wrongly re-finalize, producing a SECOND merge_done",
  [...db.listEventsForWorker(row1Id), ...db.listEventsForWorker(row2Id)].filter((e) => e.kind === "merge_done").length === 1,
);
check("reconcile's own result reports exactly one merge finished (Row1's), not two", r.mergesFinished === 1);

// Prove the LIVE map (post-run) now DOES contain what the naive early snapshot (above) proved it lacked
// — same key, different map instance in time — demonstrating the fix's map genuinely picked up the
// in-run append the naive snapshot structurally could not have.
{
  const postRunMap = db.buildLatestEventSeqMap("merge_done");
  const postRunSeq = postRunMap.get(latestEventSeqMapKey(branch, null));
  const oracleSeq = db.latestEventSeqForBranch(branch, "merge_done", null);
  check(
    "the SAME key the naive snapshot lacked now resolves (post-run) to a real seq, matching the oracle",
    typeof postRunSeq === "number" && postRunSeq === oracleSeq,
  );
}

db.close();
try { fs.rmSync(worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }
try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });

console.log(failures === 0
  ? "\n✅ ALL PASS — reconcileOrchestrationOnBoot's in-run merge_done map stays live: a first-processed session's real, live finalize is correctly seen by a second-processed session sharing the same branch, within the SAME pass, so it takes the cleanup-only (deferring) path instead of wrongly re-finalizing. A one-shot snapshot taken before reconcile runs is shown to structurally lack the entry the fix's live map carries by the time it's needed."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
