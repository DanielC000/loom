import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// The ALREADY_MERGED re-finalize route must not file a SECOND `merge_done` for a landing it already
// finalized — but it MUST file one for a genuinely DISTINCT second landing on the same worker+task+branch.
// @decision e34d475c (rounds 6-7, card 1f395ce9) — see that record's round-6/round-7 sections, plus the
// `already-merged-replay-duplicates-merge-done-by-design` project memory note, for the full investigation.
//
// THE BUG (round 6): `finalizeMerge`'s `merge_done` append (inside `betweenRemovalAndDelete`) was
// UNCONDITIONAL on every call. Three reachable routes re-invoke `finishAlreadyMerged` for a worker+task+
// branch that was already finalized once: (1) a `forceRemoveWorktree:true` re-confirm, (2) a direct
// `confirmWorkerMerge` call bypassing the tracked wrapper's cache, (3) a plain re-confirm after the
// process-local verdict cache is gone (e.g. a daemon restart) — the realistic production route. Each one
// filed ANOTHER `merge_done`, which `orchestration/alert-webhook.ts` relays as a duplicate external POST
// for any project subscribed to that kind (it hooks `Db.appendEvent` unconditionally).
//
// THE ROUND-6 FIX (incomplete — see round 7): `finalizeMerge` gained `suppressMergeDoneOnReplay`, set
// ONLY at `finishAlreadyMerged`'s own call site — when a `merge_done` already exists for this exact
// (workerSessionId, taskId, branch) — including the legacy null-branch fallback (round 3) — the append
// was skipped.
//
// THE ROUND-7 CORRECTION (Code Review on 89b942f4): the round-6 predicate was LANDING-BLIND — keyed only
// on (taskId, branch), it could not tell "a replay of THIS landing" apart from "a genuinely DISTINCT
// second landing on the same worker+task+branch" (e.g. landing 1 finalizes with a dirty retained
// worktree — keeping the branch — then the worker commits more and lands AGAIN, landing 2, but ITS finalize
// is interrupted; a plain re-confirm then takes the ALREADY_MERGED route and the round-6 guard wrongly
// suppressed landing 2's own, first-ever merge_done). Fixed: every `merge_done` now also stamps
// `detail.mergedSha` (the landing's own sha, `args.mergedSha`), and the suppression predicate additionally
// requires `detail.mergedSha === args.mergedSha` whenever BOTH sides carry one — the (taskId, branch)
// match alone is now only the fallback for a legacy row (or a defensive caller) with no sha on one side.
// `detail.mergedSha` rides the alert-webhook POST body verbatim (`detail` is forwarded unfiltered) — an
// ADDITIVE outward payload change (a new key in an existing JSON object), never read by web's
// `auditReplay.tsx` (its `merge_done` case only ever reads `detail.branch`).
//
// Section 1 proves all three named routes on a SOLO re-confirm (direct `confirmWorkerMerge`, cache-free
// by construction — this method never consults `confirmWorkerMergeTracked`'s pendingOps cache, so EVERY
// call already exercises the "cache is gone" shape; `forceRemoveWorktree:true` is passed explicitly on
// one call to also name route (1) by its own documented mechanism) keep the `merge_done` count at 1, and
// that the alert-webhook listener (wired exactly as `index.ts` wires it) fires exactly once.
//
// Section 2 proves the guard's OTHER direction: a worker's FIRST-EVER finalize reaching
// `finishAlreadyMerged` (never suppressed — there is no prior `merge_done` to match at all, so the sha
// comparison never even applies) still appends exactly one. Proven via a REAL `mergeBatchTracked` landing
// with TWO candidates (a single candidate degrades to a plain solo confirm per `mergeBatchTracked`'s own
// "fewer than 2 eligible candidates" fallback, never reaching the batch loop's `finishAlreadyMerged` call
// at all) — every batch candidate's `finishAlreadyMerged` call is, by construction, a first finalize
// (`merge-batch-completion-notice.mjs`'s own root-cause doc confirms this: "`finishAlreadyMerged`'s
// `alreadyFinalized` guard ... is `false` every time" for a batch).
//
// Section 3 is a UNIT check of the shared `finishAlreadyMerged` → `finalizeMerge` chokepoint with the
// batch loop's own call shape (`suppressNotify:true`) — NOT a simulation of a real redelivered batch op:
// the real batch loop (sessions/service.ts:23436-23453) always passes a (freshly re-checked)
// `expectedBranchTip`, and an already-finished candidate is diverted to the ordinary SOLO
// `confirmWorkerMergeTracked` fallback, never re-entered through the batch loop itself — there is no
// production path that re-invokes `mergeBatchTracked`'s own `finishAlreadyMerged` call for an
// already-landed candidate. This section exists to prove the guard behaves identically regardless of
// `suppressNotify`, since the guard's own predicate never reads that flag.
//
// Section 4 (round 7, Code Review fixture F3) proves the two things round 6 got wrong on its own: a
// DISTINCT second landing on the SAME worker+task+branch (dirty-retained landing 1, then the worker
// commits more and lands again as landing 2, finalized via the crash-recovery-shaped ALREADY_MERGED
// route — the same route exercised at ~service.ts:25277 in production) gets its OWN merge_done (count
// goes 1 -> 2, never suppressed); and a genuine REPLAY of landing 2 (a further re-confirm resolving the
// SAME landed sha) still dedups correctly (count stays at 2). The second half also confirms the
// assumption the round-7 fix depends on: the ALREADY_MERGED route's own sha lookup is deterministic
// across repeat calls for the same landing — if it weren't, the sha-match predicate would never fire and
// the dedup would silently stop working for every real replay, not just this fixture's.
//
// Run: 1) pnpm build, 2) node packages/daemon/test/merge-done-replay-dedup.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mdrd-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
registerForCleanup(process.env.LOOM_HOME);

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");
const { AlertWebhookEmitter } = await import("../dist/orchestration/alert-webhook.js");

const GIT_ID = "-c user.email=mdrd@loom -c user.name=mdrd";
const git = (cwd, args) => execSync(`git ${args}`, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const PASS_GATE = 'node -e "process.exit(0)"';
const mergeDoneCount = (db, workerId) => db.listEventsForWorker(workerId).filter((e) => e.kind === "merge_done").length;

function makeRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-mdrd-${tag}-${sfx}`);
  fs.mkdirSync(repo, { recursive: true });
  registerForCleanup(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "# mdrd\n");
  execSync(`git init -q && git config user.email mdrd@loom && git config user.name mdrd`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}

// ── SECTION 1: SOLO replay — all three named routes stay at merge_done count 1; webhook fires once ──────
{
  const tag = "solo";
  const repo = makeRepo(tag);
  const projId = `mdrd-proj-${tag}-${sfx}`, agentId = `mdrd-agent-${tag}-${sfx}`, taskId = `mdrd-task-${tag}-${sfx}`;
  const mgrId = `mdrd-mgr-${tag}-${sfx}`, workerId = `mdrd-wkr-${tag}-${sfx}`;

  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  registerForCleanup(worktreePath);
  fs.writeFileSync(path.join(worktreePath, "feat.txt"), "work\n");
  commitAll(worktreePath, "feat", GIT_ID);

  const db = new Db();
  // A webhook subscribed to merge_done, wired exactly as index.ts wires AlertWebhookEmitter to
  // Db.setEventListener — capturing the returned (already-.catch-guarded) promise per delivery so the
  // test can deterministically await it instead of racing a fire-and-forget call.
  const posts = [];
  const pendingDeliveries = [];
  const emitter = new AlertWebhookEmitter({ db, post: async (url, body) => { posts.push({ url, body }); } });
  db.setEventListener((evt) => { pendingDeliveries.push(emitter.onEvent(evt)); });
  const flushWebhook = async () => { await Promise.all(pendingDeliveries); pendingDeliveries.length = 0; };

  db.insertProject({ id: projId, name: "MDRD-solo", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: PASS_GATE, alertWebhook: { url: "https://hooks.example.com/mdrd", events: ["merge_done"] } } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: "MDRD-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({ id: workerId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });

  const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {}, getPid() { return undefined; } };
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { reapWorktreeProcesses: async () => ({ killedPids: [] }) });

  // call1: the GREEN path (a genuine fresh squash) — never touches the new guard, appends unconditionally.
  const call1 = await sessions.confirmWorkerMerge(mgrId, workerId);
  await flushWebhook();
  check("(solo) call1 merges successfully (Green path)", call1.merged === true);
  check("(solo) call1: exactly one merge_done filed", mergeDoneCount(db, workerId) === 1);
  check("(solo) call1: webhook posted exactly once", posts.length === 1);

  // call2: ROUTE 2/3 — a plain re-confirm. confirmWorkerMerge has NO cache of its own (that lives only in
  // confirmWorkerMergeTracked's pendingOps), so this call is already structurally "the verdict cache is
  // gone" — it reaches finishAlreadyMerged genuinely fresh, exactly like a post-restart re-confirm would.
  const call2 = await sessions.confirmWorkerMerge(mgrId, workerId);
  await flushWebhook();
  check("(solo) call2 (plain re-confirm, routes 2/3) reports ALREADY_MERGED", call2.merged === true && call2.emptyKind === "ALREADY_MERGED");
  check("(solo) call2: merge_done count STAYS at 1 (no duplicate)", mergeDoneCount(db, workerId) === 1);
  check("(solo) call2: webhook STILL posted only once (no duplicate external POST)", posts.length === 1);

  // call3: ROUTE 1 — forceRemoveWorktree:true re-confirm on the already-finalized worker (the card's own
  // named mechanism: a deliberate cache bypass).
  const call3 = await sessions.confirmWorkerMerge(mgrId, workerId, undefined, true);
  await flushWebhook();
  check("(solo) call3 (forceRemoveWorktree:true, route 1) reports ALREADY_MERGED", call3.merged === true && call3.emptyKind === "ALREADY_MERGED");
  check("(solo) call3: merge_done count STILL stays at 1 across all three routes", mergeDoneCount(db, workerId) === 1);
  check("(solo) call3: webhook STILL posted only once across all three routes", posts.length === 1);

  db.close();
}

// ── SECTION 2: first-ever finalize via finishAlreadyMerged (real batch landing) still appends exactly one ─
let batchFixture;
{
  const tag = "batch";
  const repo = makeRepo(tag);
  const projId = `mdrd-proj-${tag}-${sfx}`, agentId = `mdrd-agent-${tag}-${sfx}`;
  const mgrId = `mdrd-mgr-${tag}-${sfx}`;
  const cut = async (label) => {
    const taskId = `mdrd-task-${tag}-${label}-${sfx}`;
    const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
    registerForCleanup(worktreePath);
    fs.writeFileSync(path.join(worktreePath, `feature-${label}.txt`), `work ${label}\n`);
    commitAll(worktreePath, label, GIT_ID);
    return { taskId, branch, worktreePath };
  };
  // mergeBatchTracked's own fallback ("fewer than 2 eligible candidates — batching buys nothing over a
  // solo confirm") degrades a SINGLE candidate to a plain solo confirm, which never reaches
  // finishAlreadyMerged's batch loop at all — a second candidate (B) is required to force genuine batch
  // assembly, so this test actually proves what its own name claims.
  const a = await cut("a");
  const b = await cut("b");

  const db = new Db();
  db.insertProject({ id: projId, name: "MDRD-batch", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: PASS_GATE } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "dev", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  const wA = `mdrd-wkr-${tag}-a-${sfx}`, wB = `mdrd-wkr-${tag}-b-${sfx}`;
  for (const [wId, w, label] of [[wA, a, "a"], [wB, b, "b"]]) {
    db.insertTask({ id: w.taskId, projectId: projId, title: `feat(test): ${label}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: wId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: w.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: w.taskId, worktreePath: w.worktreePath, branch: w.branch });
  }

  const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {}, purgeQueuedWorkerReportNudgesOnMerge() {}, purgeQueuedWorkerIdleNudges() {} };
  // syncAttachBudgetMs pinned HIGH so the batch settles synchronously within this call (mirrors
  // batch-merge-dirty-worktree-retained.mjs's own harness).
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 600_000 });
  const r = await sessions.mergeBatchTracked(mgrId, [wA, wB]);
  check("(batch) the batch settled synchronously (pinned-high budget)", r.settled === true);
  const result = r.settled && r.ok ? r.value : undefined;
  check("(batch) batch ok:true and BOTH A and B landed on main (proves genuine batch assembly, not the <2-candidate solo fallback)",
    result?.ok === true && !!result.landed.find((l) => l.branch === a.branch) && !!result.landed.find((l) => l.branch === b.branch));
  check("(batch) worker A's FIRST-EVER finalize via finishAlreadyMerged (the batch's own landing call) appends EXACTLY ONE merge_done", mergeDoneCount(db, wA) === 1);
  check("(batch) worker B's FIRST-EVER finalize via finishAlreadyMerged appends EXACTLY ONE merge_done too", mergeDoneCount(db, wB) === 1);
  // A's OWN landed sha (not bare repo HEAD, which may be B's commit if B landed after A in this union
  // batch) — Section 3 below replays THIS landing, so it must compare against the sha THIS landing
  // actually stamped, exactly as the round-7 sha-match predicate itself does.
  const aLandedSha = result.landed.find((l) => l.branch === a.branch)?.sha;
  check("(batch) precondition: A's own landed sha was captured", typeof aLandedSha === "string" && aLandedSha.length > 0);

  batchFixture = { db, repo, projId, agentId, mgrId, a, wA, aLandedSha, sessions };
}

// ── SECTION 3: a unit check of the shared chokepoint with the batch loop's OWN call shape ────────────────
{
  const { db, a, mgrId, wA, aLandedSha, sessions } = batchFixture;
  const countBeforeReplay = mergeDoneCount(db, wA);
  check("(chokepoint-replay) precondition: exactly one merge_done before the replay", countBeforeReplay === 1);

  // NOT a simulation of a real redelivered batch op (see the file header) — a direct unit check of
  // `finishAlreadyMerged` with the batch loop's own call shape (`suppressNotify:true`), reusing A's own
  // landed sha so this exercises a replay of the SAME landing the guard must recognise. DELIBERATELY
  // omits `expectedBranchTip`: the real landing already deleted this branch, so passing a (necessarily
  // stale) tip here would hit finalizeMerge's OWN EARLIER "live tip moved" retain-and-return — which
  // short-circuits BEFORE ever reaching the append-skip guard under test, a vacuous pass that looks green
  // for the wrong reason (caught by running this against pre-fix code below: WITH a tip it passed
  // vacuously even unfixed; without one it goes genuinely RED).
  const amResult = await sessions.finishAlreadyMerged({
    managerSessionId: mgrId, workerSessionId: wA, taskId: a.taskId,
    worktreePath: a.worktreePath, branch: a.branch, repoPath: batchFixture.repo,
    projectId: batchFixture.projId, opId: "mdrd-batch-replay-op",
    mergedSha: aLandedSha, repoKey: null, suppressNotify: true,
  });
  check("(chokepoint-replay) the replayed finishAlreadyMerged call itself reports merged:true (no throw, genuinely reaches the append-skip guard)", amResult?.merged === true);
  check("(chokepoint-replay) merge_done count STAYS at 1 after a batch-shaped replay call", mergeDoneCount(db, wA) === 1);

  db.close();
}

// ── SECTION 4 (round 7, Code Review fixture F3): a DISTINCT second landing on the SAME worker+task+branch
// gets its OWN merge_done, and a replay of EITHER landing still dedups correctly ─────────────────────────
{
  const tag = "distinct";
  const repo = makeRepo(tag);
  const projId = `mdrd-proj-${tag}-${sfx}`, agentId = `mdrd-agent-${tag}-${sfx}`, taskId = `mdrd-task-${tag}-${sfx}`;
  const mgrId = `mdrd-mgr-${tag}-${sfx}`, workerId = `mdrd-wkr-${tag}-${sfx}`;
  const squashLand = (r, br, msg) => { git(r, `merge --squash ${br}`); git(r, `commit -q -m "${msg}" --trailer "Loom-Worker-Branch: ${br}"`); return git(r, "rev-parse HEAD"); };

  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  registerForCleanup(worktreePath);
  fs.writeFileSync(path.join(worktreePath, "f1.txt"), "one\n");
  commitAll(worktreePath, "f1", GIT_ID);

  const db = new Db();
  db.insertProject({ id: projId, name: "MDRD-distinct", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: PASS_GATE } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: "MDRD-DISTINCT-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({ id: workerId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });

  const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {}, getPid() { return undefined; }, purgeQueuedWorkerReportNudgesOnMerge() {}, purgeQueuedWorkerIdleNudges() {} };
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 600_000 });

  // Landing 1: a real squash lands directly on main (mirroring a crash-recovery-shaped finalize, the same
  // shape the fixture F3 exercises), then finalizeMerge runs with the worktree left DIRTY (an untracked
  // file) — the SAME "(fin)" shape mergeBatchTracked uses for a dirty-retained candidate — so the branch
  // and worktree are RETAINED (merge_done #1 filed, but the worker keeps working on the same branch).
  const landed1 = squashLand(repo, branch, "feat(x): distinct landing 1");
  fs.writeFileSync(path.join(worktreePath, "f2.txt"), "dirty, uncommitted");
  const fin1 = await sessions.finalizeMerge({ managerSessionId: mgrId, workerSessionId: workerId, taskId, worktreePath, branch, repoPath: repo, projectId: projId, mergedSha: landed1, repoKey: null, releaseHold: true });
  check("(distinct) landing1: the worktree was retained dirty (precondition for a second landing on the same branch)", !!fin1.dirtyWorktreeRetained);
  check("(distinct) landing1: branch survives (worktree still checked out on it)", (() => { try { git(repo, `rev-parse --verify refs/heads/${branch}`); return true; } catch { return false; } })());
  check("(distinct) landing1: exactly one merge_done filed", mergeDoneCount(db, workerId) === 1);

  // Intermediate replay of landing1 ITSELF (before landing2 ever happens) — "a replay of EITHER landing
  // stays deduped" covers this case too, not just a replay of the final one.
  const replayOfLanding1 = await sessions.confirmWorkerMerge(mgrId, workerId);
  check("(distinct) a replay of landing1 alone reports ALREADY_MERGED", replayOfLanding1.merged === true && replayOfLanding1.emptyKind === "ALREADY_MERGED");
  check("(distinct) a replay of landing1 alone stays deduped (still exactly one merge_done)", mergeDoneCount(db, workerId) === 1);

  // The worker commits the leftover dirty file, then lands AGAIN — a genuinely DISTINCT second squash on
  // the SAME worker+task+branch — but finalize for THIS landing never ran (the crash-recovery shape: a
  // plain re-confirm later discovers the content already landed via the ALREADY_MERGED route, exactly
  // like ~service.ts:25277 in production).
  commitAll(worktreePath, "f2", GIT_ID);
  const landed2 = squashLand(repo, branch, "feat(x): distinct landing 2");
  check("(distinct) precondition: landing2 is a genuinely distinct sha from landing1", landed2 !== landed1);
  const c2 = await sessions.confirmWorkerMerge(mgrId, workerId);
  check("(distinct) landing2's re-confirm reports ALREADY_MERGED", c2.merged === true && c2.emptyKind === "ALREADY_MERGED");
  const evsAfterLanding2 = db.listEventsForWorker(workerId).filter((e) => e.kind === "merge_done");
  check("(distinct) landing2 gets its OWN merge_done — count goes 1 -> 2, NOT suppressed as a false replay of landing1", evsAfterLanding2.length === 2);
  check("(distinct) the two merge_done events carry the two DISTINCT landed shas",
    evsAfterLanding2.some((e) => e.detail?.mergedSha === landed1) && evsAfterLanding2.some((e) => e.detail?.mergedSha === landed2));

  // A genuine REPLAY of landing2 (the ALREADY_MERGED route's own sha lookup must deterministically
  // re-resolve to landing2's SAME sha, or this sha-match predicate could never fire for a real replay).
  const c3 = await sessions.confirmWorkerMerge(mgrId, workerId);
  check("(distinct) a further re-confirm (replaying landing2) still reports ALREADY_MERGED", c3.merged === true && c3.emptyKind === "ALREADY_MERGED");
  check("(distinct) a replay of landing2 stays deduped (merge_done count STAYS at 2)", mergeDoneCount(db, workerId) === 2);

  db.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — an ALREADY_MERGED re-finalize (forceRemoveWorktree re-confirm, a direct confirmWorkerMerge call, and a plain cache-free re-confirm) never files a duplicate merge_done or a duplicate alert-webhook POST; a worker's genuine FIRST-EVER finalize through finishAlreadyMerged (a real batch landing) still appends exactly one; a batch-shaped unit check of the chokepoint also stays at exactly one; and a genuinely DISTINCT second landing on the same worker+task+branch gets its own merge_done (never suppressed as a false replay) while a true replay of either landing still dedups correctly."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
