import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// BATCH FINALIZE MUST NOT DESTROY A COMMIT ADDED DURING THE GATE (card 42daa283).
// A worker can commit to its candidate branch WHILE the batch gate runs. That commit is (correctly) not in the
// batch HEAD, but `finalizeMerge` used to `git branch -D` the branch and force-remove the worktree under a batch
// reporting "landed" — silently destroying it. Fixed: mergeBatchTracked compares each landed branch's live tip
// to the tip the batch assembled; a moved tip RETAINS branch + worktree + worker, flags `branchAdvancedDuringGate`
// and files a durable `batch_merge_branch_retained` event.
// Fixture: a REAL mergeBatchTracked run whose gate command (a real child process) commits to candidate A's own
// worktree mid-gate. B is the unmoved control and must finalize normally. Run TWICE, deliberately:
//   (sync)  syncAttachBudgetMs pinned HIGH through the constructor seam — the settled value is read directly, so
//           the outcome cannot depend on host speed (never widen the production SYNC_ATTACH_BUDGET_MS).
//   (async) syncAttachBudgetMs:0 FORCES the {settled:false} degrade path deterministically; the verdict is then
//           recovered by a same-ids re-call (retention cache).
// In BOTH, a re-call after the retain must return the RETAINED verdict from cache — never mint a new op that
// solo-confirms the branch and lands the unreviewed late commit (M1: the re-fire hazard).
//   (stop)  the tip moves only in the worker's hard-stop window (ptyStub.stop) — the at-finalize retain, driven through mergeBatchTracked.
//   (mixed) a third candidate C is dropped (conflict) and never finishes, so a same-ids re-fire is NOT a cache hit — the retained A must
//           still be neither assembled nor fallback-confirmed (held, keyed on the DURABLE retain event, not the process-local cache).
// The gate command is IDEMPOTENT (commits only if late-commit.txt is absent, exits 0), so the OUTCOME checks can actually go red.
// Also proves (unit) the compare-and-swap `deleteBranch({expectedTip})` and finalizeMerge's post-stop tip re-check.
// Run: 1) pnpm build, 2) node packages/daemon/test/batch-merge-branch-advanced-during-gate.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";
import { waitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-bmad-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
registerForCleanup(process.env.LOOM_HOME);

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree, deleteBranch } = await import("../dist/git/worktrees.js");

const GIT_ID = "-c user.email=bmad@loom -c user.name=bmad";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const git = (cwd, args) => execSync(`git ${args}`, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
// NOTE: `refs/heads/<b>` (never `<b>^{commit}` — cmd.exe treats `^` as its escape char on Windows).
const refExists = (repo, ref) => { try { git(repo, `rev-parse --verify --quiet refs/heads/${ref}`); return true; } catch { return false; } };

const dbs = [];

function makeRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-bmad-${tag}-${sfx}`);
  fs.mkdirSync(repo, { recursive: true });
  registerForCleanup(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "# bmad\n");
  execSync(`git init -q && git config user.email bmad@loom && git config user.name bmad`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}

// mode "gate":  the gate command (a real child process) commits to A's worktree mid-gate.
// mode "stop":  the gate is a plain pass; A's tip moves only in the worker's hard-stop window (ptyStub.stop), i.e. AFTER the
//               pre-stop tip check and BEFORE finalizeMerge's own re-check — driven through mergeBatchTracked (phase "at-finalize").
// mode "mixed": as "gate", plus a third candidate C that conflicts with A (dropped from the batch; its solo fallback is rejected),
//               so C is never "finished" — the reviewer's reproduced M1 hole for a MIXED batch.
async function scenario(tag, syncAttachBudgetMs, mode = "gate") {
  const repo = makeRepo(tag);
  const projId = `bmad-proj-${tag}-${sfx}`, agentId = `bmad-agent-${tag}-${sfx}`, mgrId = `bmad-mgr-${tag}-${sfx}`;
  const cut = async (label, file) => {
    const taskId = `bmad-task-${tag}-${label}-${sfx}`;
    const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
    registerForCleanup(worktreePath);
    fs.writeFileSync(path.join(worktreePath, file), `work ${label}\n`);
    commitAll(worktreePath, label, GIT_ID);
    return { taskId, branch, worktreePath };
  };
  const a = await cut("a", "feature-a.txt");
  const b = await cut("b", "feature-b.txt");
  // C adds the SAME path as A with different content: an add/add conflict once A has landed.
  const c = mode === "mixed" ? await cut("c", "feature-a.txt") : null;

  // IDEMPOTENT gate command: commits to A's worktree only if the late commit is absent, and always exits 0 — so a SECOND
  // gate run (a re-fire that wrongly mints a new op) passes instead of failing on an empty commit, which would have made
  // every OUTCOME check below unable to go red (reviewer finding: the M1 negative control only tripped structural checks).
  const script = path.join(os.tmpdir(), `loom-bmad-gate-${tag}-${sfx}.mjs`);
  registerForCleanup(script);
  fs.writeFileSync(script, mode === "stop" ? "process.exit(0);\n" : [
    `import fs from "node:fs"; import path from "node:path"; import { execSync } from "node:child_process";`,
    `const wt = ${JSON.stringify(a.worktreePath)};`,
    `if (!fs.existsSync(path.join(wt, "late-commit.txt"))) {`,
    `  fs.writeFileSync(path.join(wt, "late-commit.txt"), "added during the gate\\n");`,
    `  execSync("git add late-commit.txt && git -c user.email=bmad@loom -c user.name=bmad commit -q -m late-commit", { cwd: wt, stdio: "ignore" });`,
    `}`,
    `process.exit(0);`,
  ].join("\n"));

  const db = new Db(); dbs.push(db);
  db.insertProject({ id: projId, name: `BMAD-${tag}`, repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: `node "${script}"` } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "dev", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  const wA = `bmad-wkr-${tag}-a-${sfx}`, wB = `bmad-wkr-${tag}-b-${sfx}`, wC = `bmad-wkr-${tag}-c-${sfx}`;
  const members = [[wA, a, "a"], [wB, b, "b"], ...(c ? [[wC, c, "c"]] : [])];
  for (const [wId, w, label] of members) {
    db.insertTask({ id: w.taskId, projectId: projId, title: `feat(test): ${label}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: wId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: w.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: w.taskId, worktreePath: w.worktreePath, branch: w.branch });
  }
  let stopFired = false;
  const ptyStub = {
    stop(id) {
      // mode "stop": the worker commits in the window between the batch's pre-stop tip check and finalizeMerge's re-check.
      if (mode === "stop" && id === wA && !stopFired) {
        stopFired = true;
        fs.writeFileSync(path.join(a.worktreePath, "late-commit.txt"), "added while the worker was stopping\n");
        commitAll(a.worktreePath, "late-commit", GIT_ID);
      }
    },
    isAlive() { return false; }, enqueueStdin() {}, purgeQueuedWorkerReportNudgesOnMerge() {}, purgeQueuedWorkerIdleNudges() {},
  };
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs });
  const ids = members.map((m) => m[0]);

  const r = await sessions.mergeBatchTracked(mgrId, ids);
  if (syncAttachBudgetMs === 0) {
    check(`(${tag}) the forced-low budget really took the async degrade path ({settled:false})`, r.settled === false);
  } else {
    check(`(${tag}) the pinned-high budget took the sync path (outcome independent of host speed)`, r.settled === true);
  }
  if (!r.settled) {
    await waitUntil(() => sessions.gateStatus(r.op.opId).state === "settled", { timeoutMs: 60_000, label: "batch op to settle" });
  }
  const firstOpId = r.settled ? undefined : r.op.opId;
  // Sync: the value is right here. Async: `r.value` is unavailable, so recover it from the retention cache.
  const first = r.settled ? r : await sessions.mergeBatchTracked(mgrId, ids);
  const result = first.settled && first.ok ? first.value : undefined;

  check(`(${tag}) batch ok:true and A and B landed on main`, result?.ok === true && !!result?.landed.find((l) => l.branch === a.branch) && !!result?.landed.find((l) => l.branch === b.branch));
  check(`(${tag}) main carries A's and B's ORIGINAL work`, fs.existsSync(path.join(repo, "feature-a.txt")) && fs.existsSync(path.join(repo, "feature-b.txt")));
  check(`(${tag}) main does NOT carry the commit added after assembly (it was never gated)`, !fs.existsSync(path.join(repo, "late-commit.txt")));
  const landedA = result?.landed.find((l) => l.branch === a.branch);
  const landedB = result?.landed.find((l) => l.branch === b.branch);
  const wantPhase = mode === "stop" ? "at-finalize" : "pre-stop";
  check(`(${tag}) A's landed row carries branchAdvancedDuringGate (assembled != live tip), phase "${wantPhase}"`,
    !!landedA?.branchAdvancedDuringGate && landedA.branchAdvancedDuringGate.assembledTip !== landedA.branchAdvancedDuringGate.liveTip &&
    !!landedA.branchAdvancedDuringGate.liveTip && landedA.branchAdvancedDuringGate.phase === wantPhase);
  check(`(${tag}) negative control: B (tip unmoved) carries NO branchAdvancedDuringGate`, !!landedB && landedB.branchAdvancedDuringGate === undefined);

  // What survives (not merely that the flag fired): the late commit is still REACHABLE from a live ref.
  check(`(${tag}) A's branch ref survives (was \`git branch -D\`'d before the fix)`, refExists(repo, a.branch));
  check(`(${tag}) the late commit is still reachable from A's branch`, refExists(repo, a.branch) && git(repo, `log ${a.branch} --format=%s`).split("\n").includes("late-commit"));
  check(`(${tag}) A's worktree survives`, fs.existsSync(path.join(a.worktreePath, "late-commit.txt")));
  check(`(${tag}) A's worker session stays unarchived`, db.getSession(wA)?.archivedAt == null);
  check(`(${tag}) A's task is NOT moved to the terminal lane and no merge_done was filed for A`,
    db.getTask(a.taskId)?.columnKey === "in_progress" && !db.listEventsForWorker(wA).some((e) => e.kind === "merge_done"));
  check(`(${tag}) control: B's branch WAS finalized (deleted) as before`, !refExists(repo, b.branch));
  check(`(${tag}) control: B's worktree WAS removed`, !fs.existsSync(b.worktreePath));

  // Q5: the durable audit event.
  const retainedEvents = db.listEventsForWorker(wA).filter((e) => e.kind === "batch_merge_branch_retained");
  check(`(${tag}) exactly one batch_merge_branch_retained event for A (phase "${wantPhase}"), carrying branch/assembledTip/liveTip`,
    retainedEvents.length === 1 && retainedEvents[0].detail?.branch === a.branch && !!retainedEvents[0].detail?.assembledTip && !!retainedEvents[0].detail?.liveTip && retainedEvents[0].detail?.phase === wantPhase);
  check(`(${tag}) negative control: no batch_merge_branch_retained event for B`, !db.listEventsForWorker(wB).some((e) => e.kind === "batch_merge_branch_retained"));

  if (mode === "mixed") {
    check(`(${tag}) C was dropped from the batch and routed to fallback (so it is NOT finished)`, !!result?.fallback.find((f) => f.workerSessionId === wC));
    // C's own solo fallback confirm must settle (rejected on the add/add conflict) before we re-fire, so it cannot race the re-fire.
    try {
      await waitUntil(() => db.listEventsForWorker(wC).some((e) => e.kind === "merge_rejected" || e.kind === "merge_cancelled"), { timeoutMs: 90_000, label: "C's fallback confirm to be rejected" });
    } catch { check(`(${tag}) C's fallback confirm settled (rejected)`, false); }
    check(`(${tag}) C never landed (its branch and task are intact)`, refExists(repo, c.branch) && db.getTask(c.taskId)?.columnKey === "in_progress");
  }

  // M1: a same-ids RE-FIRE must never land the retained late commit.
  const mainBefore = git(repo, "rev-parse HEAD");
  const gateRowsBefore = db.listGateEvents({ projectId: projId, limit: 50, offset: 0 }).items.length;
  let refire = await sessions.mergeBatchTracked(mgrId, ids);
  if (!refire.settled) {
    await waitUntil(() => sessions.gateStatus(refire.op.opId).state === "settled", { timeoutMs: 90_000, label: "re-fire op to settle" });
    refire = await sessions.mergeBatchTracked(mgrId, ids);
  }
  const refireValue = refire.settled && refire.ok ? refire.value : undefined;
  if (mode !== "mixed") {
    // Every non-retained candidate is finished, so the retained verdict itself comes back from cache (no new op).
    check(`(${tag}) M1: the re-fire is served from cache (no new op minted)`, refire.settled === true && refire.cacheHit != null);
    check(`(${tag}) M1: the re-fire returns the SAME retained verdict (A still flagged)`,
      refireValue?.ok === true && !!refireValue.landed.find((l) => l.branch === a.branch)?.branchAdvancedDuringGate);
    if (firstOpId) check(`(${tag}) M1: the re-fire did not replace the original op`, sessions.gateStatus(firstOpId).state === "settled");
    check(`(${tag}) M1: the re-fire produced no new gate row`, db.listGateEvents({ projectId: projId, limit: 50, offset: 0 }).items.length === gateRowsBefore);
  } else {
    // MIXED: C is not finished, so the re-fire is NOT a cache hit and DOES mint a fresh op — the retained A must still be
    // neither assembled nor fallback-confirmed, and must be REPORTED as held.
    const heldA = refireValue?.fallback.find((f) => f.workerSessionId === wA);
    check(`(${tag}) M1-mixed: the re-fire reports A as held (fallback entry, started:false, "review it with worker_merge")`,
      !!heldA && heldA.started === false && /worker_merge/.test(heldA.reason) && /held/.test(heldA.reason));
  }
  // OUTCOME checks (these are the ones the M1 negative control must turn red — not just the structural ones):
  check(`(${tag}) M1 OUTCOME: main did not move on the re-fire`, git(repo, "rev-parse HEAD") === mainBefore);
  check(`(${tag}) M1 OUTCOME: the late commit is STILL not on main after the re-fire`, !fs.existsSync(path.join(repo, "late-commit.txt")) &&
    !git(repo, "log --format=%s").split("\n").includes("late-commit"));
  check(`(${tag}) M1 OUTCOME: A's branch, late commit and worktree STILL survive the re-fire`,
    refExists(repo, a.branch) && git(repo, `log ${a.branch} --format=%s`).split("\n").includes("late-commit") && fs.existsSync(path.join(a.worktreePath, "late-commit.txt")));
  check(`(${tag}) M1 OUTCOME: A's task is still in_progress after the re-fire (never solo-confirmed)`, db.getTask(a.taskId)?.columnKey === "in_progress" && !db.listEventsForWorker(wA).some((e) => e.kind === "merge_done"));
  check(`(${tag}) M1: no second retain event for A`, db.listEventsForWorker(wA).filter((e) => e.kind === "batch_merge_branch_retained").length === 1);
}

try {
  // BMAD_ONLY=<tag> runs a single scenario (used to isolate a RED for one failure mode); unset runs all four.
  const only = process.env.BMAD_ONLY;
  if (!only || only === "sync") await scenario("sync", 600_000);
  if (!only || only === "async") await scenario("async", 0);
  if (!only || only === "stop") await scenario("stop", 600_000, "stop");
  if (!only || only === "mixed") await scenario("mixed", 600_000, "mixed");

  // ── (unit) compare-and-swap deleteBranch (m3) ───────────────────────────────────────────────────────
  {
    const repo = makeRepo("cas");
    git(repo, "branch cas-keep");
    const tipOld = git(repo, "rev-parse cas-keep");
    fs.writeFileSync(path.join(repo, "x.txt"), "x\n");
    git(repo, "checkout -q cas-keep");
    commitAll(repo, "late", GIT_ID);
    const tipNew = git(repo, "rev-parse HEAD");
    git(repo, "checkout -q -");
    check("(cas) setup: the branch moved past the tip the caller read", tipOld !== tipNew);
    const refused = await deleteBranch(repo, "cas-keep", { expectedTip: tipOld });
    check("(cas) a stale expectedTip is REFUSED (returns false) and the branch survives with the late commit", refused === false && refExists(repo, "cas-keep") && git(repo, "rev-parse cas-keep") === tipNew);
    const deleted = await deleteBranch(repo, "cas-keep", { expectedTip: tipNew });
    check("(cas) the matching expectedTip deletes the branch (returns true)", deleted === true && !refExists(repo, "cas-keep"));
    check("(cas) an already-gone branch is idempotent success (returns true)", (await deleteBranch(repo, "cas-keep", { expectedTip: tipNew })) === true);
    git(repo, "branch cas-plain");
    check("(cas) no expectedTip keeps the original `branch -D` behavior", (await deleteBranch(repo, "cas-plain")) === true && !refExists(repo, "cas-plain"));
  }

  // ── (unit) finalizeMerge re-checks the tip AFTER the worker stop, before touching anything (m3) ───────
  {
    const repo = makeRepo("fin");
    const projId = `bmad-proj-fin-${sfx}`, agentId = `bmad-agent-fin-${sfx}`, mgrId = `bmad-mgr-fin-${sfx}`, wId = `bmad-wkr-fin-${sfx}`;
    const taskId = `bmad-task-fin-${sfx}`;
    const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
    registerForCleanup(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "f.txt"), "f\n");
    commitAll(worktreePath, "f", GIT_ID);
    const assembled = git(worktreePath, "rev-parse HEAD");
    const db = new Db(); dbs.push(db);
    db.insertProject({ id: projId, name: "BMAD-fin", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
    db.insertAgent({ id: agentId, projectId: projId, name: "dev", startupPrompt: "", position: 0 });
    db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    db.insertTask({ id: taskId, projectId: projId, title: "feat(test): fin", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: wId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {}, purgeQueuedWorkerReportNudgesOnMerge() {}, purgeQueuedWorkerIdleNudges() {} };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl());
    // The worker commits AFTER the caller captured `assembled` (i.e. in the hard-stop window).
    fs.writeFileSync(path.join(worktreePath, "late.txt"), "late\n");
    commitAll(worktreePath, "late-after-stop", GIT_ID);
    let retainedLive;
    const finArgs = { managerSessionId: mgrId, workerSessionId: wId, taskId, worktreePath, branch, repoPath: repo, projectId: projId, mergedSha: assembled, repoKey: null, mergedVerification: "pathset" };
    await sessions.finalizeMerge({ ...finArgs, expectedBranchTip: assembled, onBranchRetained: (live) => { retainedLive = live; } });
    check("(fin) a moved tip fires onBranchRetained with the LIVE tip", typeof retainedLive === "string" && retainedLive !== assembled);
    check("(fin) branch, worktree and the late commit all survive", refExists(repo, branch) && fs.existsSync(path.join(worktreePath, "late.txt")));
    check("(fin) nothing was finalized: task still in_progress, no merge_done event", db.getTask(taskId)?.columnKey === "in_progress" && !db.listEventsForWorker(wId).some((e) => e.kind === "merge_done"));
    // Control: the SAME call with the tip that is actually live finalizes normally (proves the check discriminates).
    let controlRetained = false;
    await sessions.finalizeMerge({ ...finArgs, expectedBranchTip: git(worktreePath, "rev-parse HEAD"), onBranchRetained: () => { controlRetained = true; } });
    check("(fin) control: an UNMOVED tip is not retained — branch deleted, worktree removed, merge_done filed",
      controlRetained === false && !refExists(repo, branch) && !fs.existsSync(worktreePath) && db.listEventsForWorker(wId).some((e) => e.kind === "merge_done"));
  }
} finally {
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
}
console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
