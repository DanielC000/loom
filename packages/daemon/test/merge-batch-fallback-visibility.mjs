import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// MERGE-BATCH FALLBACK VISIBILITY (card 19256231) — a red/forfeited batch's automatic per-branch fallback
// spawns one ordinary-shaped `worker_merge_confirm` merge gate PER candidate (real taskId, real branch,
// real workerLabel) — the OPPOSITE shape the documented "find a live batch op" predicate looks for
// (`taskId:null`/`branch:null`/`workerLabel:"Orchestrator"`, which only ever matches the batch's OWN gate
// row). A manager following that predicate verbatim sees the batch row settle, finds no Orchestrator row,
// and correctly concludes the BATCH is done — while up to K individually-gated merges it never separately
// authorized are still live on the daemon-global shared cap.
//
// THE FIX: every fallback confirm `mergeBatchTracked`'s own `runFallback` spawns (via
// confirmWorkerMergeTracked's `opts.fallbackOfBatchOpId`) now carries that batch's own opId through to its
// GateDescriptor, echoed by GateSemaphore.snapshot() and surfaced on gate_queue's own-project entries as
// `fallbackOfBatchOpId` — present (and equal to the batch's opId) on a fallback row, null/absent on an
// ordinary, non-batch-spawned merge.
//
// THIS TEST proves BOTH directions (DoD-3): every fallback row a REJECTED batch spawns carries
// `fallbackOfBatchOpId === <the batch's own opId>`, and a genuinely ordinary solo `worker_merge_confirm`
// (never routed through a batch) carries `fallbackOfBatchOpId: null` — a test asserting only the positive
// side could pass even if the tag were applied to every merge unconditionally.
//
// RED PROOF (done by hand during development — see this card's own worker_report for the transcript):
// (1) POSITIVE direction — with the two `runFallback([...], opId)` call sites in `mergeBatchTracked`
//     (sessions/service.ts) reverted to call `runFallback([...])` with no second argument (i.e. the
//     pre-fix shape, where nothing is ever threaded through), every "(positive)" check below fails: each
//     fallback row's `fallbackOfBatchOpId` reads back `null`, indistinguishable from the ordinary merge
//     the negative control checks.
// (2) NEGATIVE direction — with `gateQueueForManager`'s own-project branch in service.ts hacked to set
//     `entry.fallbackOfBatchOpId = e.fallbackOfBatchOpId ?? "OVER_TAGGED_SENTINEL"` (simulating a bug that
//     tags every own-project merge, not just a batch's real fallback rows), the "(negative)" check below
//     fails: the ordinary solo confirm's row reads back the sentinel instead of null.
// Restoring the real fix (both call sites passing `opId`, and the real `?? null` fallback in
// `gateQueueForManager`) makes every check below pass again.
//
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/merge-batch-fallback-visibility.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";
import { commitAll } from "./_git-commit.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mbfv-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

const GIT_ID = "-c user.email=mbfv@loom -c user.name=mbfv";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function makeRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  registerForCleanup(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "# mbfv\n");
  execSync(`git init -q && git config user.email mbfv@loom && git config user.name mbfv`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
}

async function cutBranch(repo, projId, label, file, content) {
  const taskId = `mbfv-task-${label}-${sfx}`;
  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  fs.writeFileSync(path.join(worktreePath, file), content);
  commitAll(worktreePath, label, GIT_ID);
  return { taskId, branch, worktreePath };
}

const worktrees = [];
let db;
try {
  const P = `mbfv-proj-${sfx}`;
  const PForeign = `mbfv-foreign-${sfx}`;
  const repo = path.join(os.tmpdir(), `loom-mbfv-repo-${sfx}`);
  makeRepo(repo);
  const repoForeign = path.join(os.tmpdir(), `loom-mbfv-foreign-repo-${sfx}`);
  makeRepo(repoForeign);

  // A truthy gateCommand is enough — `runGate` (the injected fake below) is what actually runs, the real
  // string is never spawned.
  db = new Db();
  db.insertProject({ id: P, name: "MBFV", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "node -e \"process.exit(0)\"" } }, createdAt: now, archivedAt: null });
  db.insertProject({ id: PForeign, name: "MBFV Foreign", repoPath: repoForeign, vaultPath: repoForeign, config: { orchestration: { gateCommand: "node -e \"process.exit(0)\"" } }, createdAt: now, archivedAt: null });
  const agentId = `${P}-dev`;
  db.insertAgent({ id: agentId, projectId: P, name: "dev", startupPrompt: "", position: 0 });
  const mgrId = `${P}-mgr1`;
  db.insertSession({ id: mgrId, projectId: P, agentId, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

  // K=3 candidates, default maxConcurrentWorkers (3) — mirrors merge-batch-completion-notice.mjs.
  const branchLabels = ["a", "b", "c"];
  const workers = [];
  const knownWorktrees = new Set();
  for (const label of branchLabels) {
    const { taskId, branch, worktreePath } = await cutBranch(repo, P, label, `feature-${label}.txt`, `work ${label}\n`);
    worktrees.push(worktreePath);
    knownWorktrees.add(worktreePath);
    db.insertTask({ id: taskId, projectId: P, title: `feat(test): ${label}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    const workerId = `${P}-wkr-${label}`;
    db.insertSession({ id: workerId, projectId: P, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });
    workers.push({ workerId, taskId, branch, worktreePath });
  }

  // A FOURTH, wholly independent worker — never passed to mergeBatchTracked — is this test's negative
  // control (an ordinary solo worker_merge_confirm, never routed through any batch).
  const solo = await cutBranch(repo, P, "solo", "feature-solo.txt", "work solo\n");
  worktrees.push(solo.worktreePath);
  knownWorktrees.add(solo.worktreePath);
  db.insertTask({ id: solo.taskId, projectId: P, title: "feat(test): solo", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const soloWorkerId = `${P}-wkr-solo`;
  db.insertSession({ id: soloWorkerId, projectId: P, agentId, engineSessionId: null, title: null, cwd: solo.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: solo.taskId, worktreePath: solo.worktreePath, branch: solo.branch });

  // fakeGate: the BATCH's own private worktree (freshly cut, never in `knownWorktrees`) rejects
  // IMMEDIATELY — a red gate — which is what fires runFallback for all 3 chosen candidates. Any KNOWN
  // worker worktree (a fallback candidate's own gate, or the solo negative control's own gate) HANGS
  // until this test explicitly releases it, so a live gate_queue read can catch it mid-flight.
  const releases = {};
  const fakeGate = async (_cmd, worktreePath) => {
    if (!knownWorktrees.has(worktreePath)) return { passed: false, reason: "simulated batch reject (test)" };
    return new Promise((res) => { releases[worktreePath] = res; });
  };

  const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
  // Small sync budget forces every confirmWorkerMergeTracked call (the batch's own outer attach, and each
  // fallback candidate's own inner attach) onto the async path quickly — mirrors the real incident (card
  // 19256231's own specimen: the fallback's own gates appeared ~3s after the batch rejected, not inline)
  // and merge-batch-completion-notice.mjs's identical seam.
  const TEST_SYNC_BUDGET_MS = 250;
  const svc = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate, syncAttachBudgetMs: TEST_SYNC_BUDGET_MS, gateOpRetainMs: 0 });

  const first = await svc.mergeBatchTracked(mgrId, workers.map((w) => w.workerId));
  check("precondition: the batch degrades to pending (async path — the batch's own gate rejects fast, but the fallback loop's 3 sequential sync-waits outlast the outer budget)", first.settled === false);
  const opId = first.op?.opId;
  check("precondition: the pending response carries the batch's own real opId", typeof opId === "string" && opId.length > 0);

  // Wait for all 3 fallback candidates to have minted a live gate_queue row (running or queued — cap
  // defaults to 1, so at most one is ever "running" at a time, matching the incident's own "one running
  // plus two queued" shape).
  await sharedWaitUntil(() => {
    const snap = svc.gateQueueForManager(P);
    const merges = [...snap.running, ...snap.queued].filter((e) => e.gateType === "merge");
    return merges.length >= 3;
  }, { timeoutMs: 10_000, intervalMs: 50, label: "all 3 fallback candidates registered in gate_queue" });

  const snap = svc.gateQueueForManager(P);
  const fallbackRows = [...snap.running, ...snap.queued].filter((e) => e.gateType === "merge");
  check("(positive, precondition) exactly 3 fallback merge rows are live (one per chosen candidate)", fallbackRows.length === 3);
  check("(positive) every fallback row carries a REAL taskId/branch — never the batch's own taskId:null/branch:null shape",
    fallbackRows.every((e) => e.taskId != null && e.branch != null && workers.some((w) => w.taskId === e.taskId && w.branch === e.branch)));
  check("(positive) EVERY fallback row carries fallbackOfBatchOpId === the batch's own opId — THE discriminating check",
    fallbackRows.every((e) => e.fallbackOfBatchOpId === opId));
  check("(positive) the batch's own opId never leaks into the branch identity (fallbackOfBatchOpId is a DIFFERENT id than any taskId/branch)",
    fallbackRows.every((e) => e.taskId !== opId && e.branch !== opId));

  // Cross-project redaction (DoD-2): a caller from a totally different project sees the SAME live rows
  // (one shared daemon-global registry) but redacted — taskId/branch/workerLabel AND fallbackOfBatchOpId
  // all omitted, mirroring the existing taskId/branch/workerLabel redaction rule exactly.
  const foreignView = svc.gateQueueForManager(PForeign);
  const foreignMerges = [...foreignView.running, ...foreignView.queued].filter((e) => e.gateType === "merge");
  check("(DoD-2) a foreign-project caller still sees the 3 live merge rows", foreignMerges.length === 3);
  check("(DoD-2) a foreign-project caller's rows carry redacted:true", foreignMerges.every((e) => e.redacted === true));
  check("(DoD-2) a foreign-project caller's rows OMIT fallbackOfBatchOpId entirely (never redacted-to-null, same rule as taskId/branch/workerLabel)",
    foreignMerges.every((e) => !("fallbackOfBatchOpId" in e)));

  // Release the 3 fallback gates (one at a time — cap 1 means only one is ever actually admitted and
  // calling fakeGate at once) so the fleet drains cleanly before the negative-control confirm below.
  const released = new Set();
  for (let i = 0; i < 3; i++) {
    await sharedWaitUntil(() => Object.keys(releases).some((wt) => !released.has(wt)), { timeoutMs: 10_000, intervalMs: 50, label: `release fallback gate ${i + 1}/3` });
    const wt = Object.keys(releases).find((w) => !released.has(w));
    released.add(wt);
    releases[wt]({ passed: false, reason: "test: fallback gate rejected (cleanup)" });
  }
  await sharedWaitUntil(() => {
    const s = svc.gateQueueForManager(P);
    return [...s.running, ...s.queued].filter((e) => e.gateType === "merge").length === 0;
  }, { timeoutMs: 10_000, intervalMs: 50, label: "all 3 fallback gates drained" });

  // (negative control) a genuinely ordinary solo confirm — NEVER routed through mergeBatchTracked at all —
  // must NOT carry the tag. This is the arm the kickoff asked to be proven, not merely asserted: a tag
  // applied to every own-project merge unconditionally (rather than only a batch's real fallback rows)
  // would make the "(positive)" checks above pass too, but THIS check would then fail — see the file
  // header's RED PROOF (2) for the by-hand confirmation that it actually does.
  const soloConfirm = svc.confirmWorkerMergeTracked(mgrId, soloWorkerId);
  await sharedWaitUntil(() => {
    const s = svc.gateQueueForManager(P);
    return [...s.running, ...s.queued].some((e) => e.gateType === "merge" && e.taskId === solo.taskId);
  }, { timeoutMs: 10_000, intervalMs: 50, label: "the solo (non-batch) confirm registered in gate_queue" });
  const soloSnap = svc.gateQueueForManager(P);
  const soloRow = [...soloSnap.running, ...soloSnap.queued].find((e) => e.gateType === "merge" && e.taskId === solo.taskId);
  check("(negative, precondition) the solo confirm's own row is found", soloRow != null);
  check("(negative) a genuinely ordinary solo confirm carries fallbackOfBatchOpId: null (present, own-project, but null — never absent, never the batch's opId)",
    soloRow != null && "fallbackOfBatchOpId" in soloRow && soloRow.fallbackOfBatchOpId === null);

  // Admission (visible in gate_queue) happens synchronously; the actual fakeGate invocation (and thus
  // `releases[wt]`'s own assignment) follows a real async pre-admission git read (confirmWorkerMerge's own
  // `reunionAtAdmission`) — mirrors gate-queue.mjs's own `waitUntilInvoked` two-step wait for the same gap.
  await sharedWaitUntil(() => typeof releases[solo.worktreePath] === "function", { timeoutMs: 5000, intervalMs: 25, label: "the solo confirm's own fakeGate invocation" });
  releases[solo.worktreePath]({ passed: false, reason: "test: solo gate rejected (cleanup)" });
  await soloConfirm.catch(() => {});
  await sharedWaitUntil(() => {
    const s = svc.gateQueueForManager(P);
    return [...s.running, ...s.queued].length === 0;
  }, { timeoutMs: 10_000, intervalMs: 50, label: "registry fully drained" });

} finally {
  if (db) try { db.close(); } catch { /* ignore */ }
  for (const wt of worktrees) try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
