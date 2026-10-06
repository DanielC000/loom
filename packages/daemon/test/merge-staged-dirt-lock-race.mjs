import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Merge-gate STAGED-DIRT LOCK RACE test (board card 6b8822d2). REAL git on temp repos, NO claude and NO
// live daemon — drives SessionService.confirmWorkerMerge() directly, mirroring
// merge-canonical-dirty-overlap-backstop.mjs's in-process style.
//
// THE RACE THIS GUARDS (incident observed by the lead, 2026-10-05 ~18:30Z): `confirmWorkerMerge`'s
// admission-time `detectCanonicalStagedDirt` preflight used to run entirely UNLOCKED, long before the
// actual squash (which runs inside `mergeBranchLocked`, itself wrapped in the per-repo
// `withCanonicalIndexLock` mutex). `git merge --squash` stages a branch's diff into the canonical index
// without committing; between that squash call and the following commit call, the canonical repo is
// genuinely, legitimately staged-but-uncommitted. A SIBLING branch's unlocked admission preflight landing
// in that exact window used to misread the sibling's own in-progress work as unrelated human residue and
// refuse with "a HUMAN resolves the canonical checkout by hand" — for a condition that would have
// cleared itself within moments. The fix wraps the admission-time probe in the SAME `withCanonicalIndexLock`
// the squash itself uses, so the probe can only ever observe a genuinely-settled repo state.
//
// This test simulates "a sibling is mid-squash" directly (rather than racing two real confirms, which
// would be non-deterministic): it acquires the real per-repo lock itself, with a controllable holder that
// (1) leaves the canonical repo STAGED-but-uncommitted while held, exactly like a real squash between its
// `--squash` and `commit` calls, and (2) commits that staged content the moment it is released — mirroring
// a sibling's squash actually landing. A concurrent `confirmWorkerMerge` for an unrelated worker on the
// SAME repo must not observe the mid-flight staged state as a false "canonical_staged_dirt" refusal.
//
// The "did not settle early" half of this is a NEGATIVE assertion ("X did not happen") — unfalsifiable in
// one trial against a bare fixed wait (it cannot tell "queued behind the lock" from "hasn't gotten there
// yet", see CLAUDE.md's fixed-wait guidance). It is proven here via the shared `assertNeverWithControl`
// toolkit (`_timing-guard.mjs`, card 1addef27) instead: `windowMs` is DERIVED from a real, measured
// quantity — scenario (N)'s own observed settle latency for the identical confirmWorkerMerge call shape,
// run first, below — not a guessed literal, and a mandatory `positiveControl` (a fresh, genuinely
// unlocked/uncontended confirmWorkerMerge, scenario (N2)) independently proves, at runtime, that the exact
// same check CAN observe a real violation within that same window before the real (R) run is ever trusted
// to have avoided one.
//
// Round 2 (Code Reviewer e001ee19) moved detectCanonicalDirtyOverlap/detectCanonicalUntrackedOverlap INTO
// the same shared lock as the staged-dirt probe: git's unpack_trees writes WORKTREE files before the index
// rename, so a sibling's in-flight squash can ALSO transiently read as an unstaged-modified (" M") or
// untracked ("??") collision on a path the branch touches, not just as staged content. Delta review round 2
// (d9a2984c) found this file's own (R) scenario only ever exercises the STAGED shape (sibling-inflight.txt
// is `git add`ed) — a regression that moved the other two probes back OUTSIDE the shared lock left all
// OTHER coverage green, because nothing here ever drove an unstaged-modify or untracked race. (DO)/(UT)
// below close that gap.
//
// Proves:
//   (N) NEGATIVE CONTROL (run first, also the timing baseline) — genuine, pre-existing STAGED residue with
//       NO lock contention at all still refuses at admission exactly as before: the fix does not blunt
//       real detection, only the race. Its measured settle latency derives (R)'s windowMs below.
//   (R) RACE — while the test holds the per-repo lock with staged-but-uncommitted content (simulating a
//       sibling's in-flight squash), a concurrent confirmWorkerMerge for a DIFFERENT worker on the same
//       repo does NOT settle early with a false canonical_staged_dirt refusal (proven via
//       assertNeverWithControl, witnessed by a fresh (N2) positiveControl): it stays PENDING until the
//       lock is released, then (once the simulated sibling's content is committed and the repo is clean
//       again) lands normally. No merge_rejected(canonical_staged_dirt) event is ever recorded for it.
//   (DO) RACE, unstaged-modify shape — the per-repo lock is held while a BRANCH-TOUCHED path shows as an
//       unstaged modification (" M", never `git add`ed): the concurrent confirm does not settle early with
//       a false canonical_dirty_overlap refusal; once released (the transient edit is cleanly reverted,
//       mirroring the sibling's write never actually landing there) it merges normally.
//   (UT) RACE, untracked-collision shape — the per-repo lock is held while a BRANCH-ADDED path exists as an
//       UNTRACKED file ("??", never committed): same shape as (DO), for detectCanonicalUntrackedOverlap.
//
// ⚠️ (DO)/(UT) ABOVE, GOING THROUGH confirmWorkerMerge's FULL FLOW, CANNOT discriminate the EXACT "moved
// dirtyOverlap/untrackedOverlap back outside the lock while leaving detectCanonicalStagedDirt locked"
// regression — verified directly (manual RED-proof attempt, both a deterministic external-holder version
// and a 15-iteration real-two-concurrent-confirms version, neither reproduced a false refusal against that
// exact regression). Reason: `detectCanonicalStagedDirt` is UNCONDITIONALLY locked and runs FIRST in
// confirmWorkerMerge's sequence (true in both the fix and that regression) — its own lock-acquisition
// already forces the WHOLE confirm to wait for a single sibling's ENTIRE squash to fully release before
// confirmWorkerMerge's execution ever reaches dirtyOverlap/untrackedOverlap, locked or not; a single
// sibling's transient write can never still be present by the time execution gets there. The regression is
// only reachable by a narrower, three-party interleaving (a SECOND, independent squash starting inside the
// sub-millisecond JS-continuation gap between confirmWorkerMerge's own stagedDirt step resolving and its
// dirtyOverlap/untrackedOverlap step beginning) that is not practically reproducible without instrumenting
// production code with a test-only seam — which this card does not add. (DO_DIRECT)/(UT_DIRECT) below
// instead directly exercise the EXACT call-site pattern the fix applies — `withCanonicalIndexLock(repoPath,
// () => detectCanonicalDirtyOverlap(...))` vs a bare, unwrapped call — which IS fully deterministic and
// precisely proves the mechanism this card's fix relies on, independent of confirmWorkerMerge's own
// stagedDirt-first ordering. (DO)/(UT) are kept anyway: they are still valid, valuable end-to-end coverage
// that the fix doesn't regress ordinary behavior when overlap-shaped dirt coexists with the lock mechanism,
// and they DO catch a BROADER regression (e.g. the entire combined lock removed, or stagedDirt itself also
// unlocked).
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-staged-dirt-lock-race.mjs
// RED/GREEN proof against the pre-fix source (card 6b8822d2's own DoD-3):
//   pnpm --filter @loom/daemon negative-control --file packages/daemon/src/sessions/service.ts \
//     --test packages/daemon/test/merge-staged-dirt-lock-race.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { assertNeverWithControl } from "./_timing-guard.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-sdlr-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree, detectCanonicalDirtyOverlap, detectCanonicalUntrackedOverlap } = await import("../dist/git/worktrees.js");
const { withCanonicalIndexLock } = await import("../dist/git/repo-lock.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
// stagedCanonicalDirtRefusalMessage's (git/worktrees.ts) exact wording, quoted verbatim from source (never
// paraphrased) — shared by (N)'s positive-control assertion below (proves this regex CAN match a real
// occurrence) and (R)'s negative one (condition 3, manager, card 6b8822d2: pin that this wording never
// fires for the sibling-race case).
const HUMAN_MUST_RESOLVE_RE = /a HUMAN resolves the canonical checkout by hand/i;
const GIT_ID = "-c user.email=sdlr@loom -c user.name=sdlr";
const git = (cwd, args) => execFileSync("git", args, { cwd }).toString().trim();
const readText = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n"); // core.autocrlf may rewrite line endings on checkout
const now = new Date().toISOString();
const tmpDirs = [];

const db = new Db();
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
const sessions = new SessionService(db, ptyStub, new OrchestrationControl());

function markerCommand(markerPath) {
  const forJs = markerPath.replace(/\\/g, "/");
  return `node -e "require('fs').writeFileSync('${forJs}','1')"`;
}

function seed(p) {
  db.insertProject({ id: p.projId, name: "SDLR", repoPath: p.repo, vaultPath: p.repo, config: { orchestration: { gateCommand: p.gateCommand } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: p.agentId, projectId: p.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: p.taskId, projectId: p.projId, title: "SDLR-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: p.mgrId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({ id: p.workerId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: p.mgrId, taskId: p.taskId, worktreePath: p.worktreePath, branch: p.branch });
}

function initRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  tmpDirs.push(repo);
  fs.writeFileSync(path.join(repo, "shared.txt"), "orig\n");
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "sdlr@loom"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "sdlr"], { cwd: repo });
  commitAll(repo, "init", GIT_ID);
}

async function setup(p) {
  initRepo(p.repo);
  const { worktreePath, branch } = await createWorktree(p.repo, p.projId, p.taskId);
  tmpDirs.push(worktreePath);
  fs.writeFileSync(path.join(worktreePath, `${p.key}-work.txt`), "worker-version\n");
  commitAll(worktreePath, `${p.key} work`, GIT_ID);
  p.worktreePath = worktreePath; p.branch = branch;
  seed(p);
}

function stageGenuineResidue(p, fileName) {
  fs.writeFileSync(path.join(p.repo, fileName), "pre-existing human staged residue\n");
  execFileSync("git", ["add", fileName], { cwd: p.repo });
}

// A branch that MODIFIES an already-tracked path (for detectCanonicalDirtyOverlap's unstaged-modify shape)
// when `trackedInitial` is given, or ADDS a brand-new path (for detectCanonicalUntrackedOverlap's untracked
// shape, which refuses regardless of content match) when it is omitted.
async function setupOverlapBranch(p, touchedPath, trackedInitial, branchContent) {
  initRepo(p.repo);
  if (trackedInitial !== undefined) {
    fs.writeFileSync(path.join(p.repo, touchedPath), trackedInitial);
    commitAll(p.repo, `add ${touchedPath}`, GIT_ID);
  }
  const { worktreePath, branch } = await createWorktree(p.repo, p.projId, p.taskId);
  tmpDirs.push(worktreePath);
  fs.writeFileSync(path.join(worktreePath, touchedPath), branchContent);
  commitAll(worktreePath, `${p.key} touches ${touchedPath}`, GIT_ID);
  p.worktreePath = worktreePath; p.branch = branch;
  seed(p);
}

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function makeScenario(key) {
  return {
    key, projId: `sdlr-${key}-proj-${sfx}`, agentId: `sdlr-${key}-top-${sfx}`, taskId: `sdlr-${key}-task-${sfx}`,
    mgrId: `sdlr-${key}-mgr-${sfx}`, workerId: `sdlr-${key}-wkr-${sfx}`,
    repo: path.join(os.tmpdir(), `loom-sdlr-${key}-repo-${sfx}`),
    marker: path.join(os.tmpdir(), `loom-sdlr-${key}-marker-${sfx}.log`),
  };
}

// (N) NEGATIVE CONTROL + timing baseline, (N2) throwaway positiveControl witness, (R) the real race.
const N = makeScenario("n");
N.gateCommand = markerCommand(N.marker);
const N2 = makeScenario("n2");
N2.gateCommand = markerCommand(N2.marker);
const R = makeScenario("r");
R.gateCommand = markerCommand(R.marker);

// (DO) unstaged-modify overlap race: (DO_CTRL) genuine/uncontended timing baseline + positiveControl
// witness fixture generator, (DO) the real race.
const DO_CTRL = makeScenario("do-ctrl");
DO_CTRL.gateCommand = markerCommand(DO_CTRL.marker);
const DO_CTRL2 = makeScenario("do-ctrl2");
DO_CTRL2.gateCommand = markerCommand(DO_CTRL2.marker);
const DO = makeScenario("do");
DO.gateCommand = markerCommand(DO.marker);

// (UT) untracked-collision overlap race: same shape as (DO), for detectCanonicalUntrackedOverlap.
const UT_CTRL = makeScenario("ut-ctrl");
UT_CTRL.gateCommand = markerCommand(UT_CTRL.marker);
const UT_CTRL2 = makeScenario("ut-ctrl2");
UT_CTRL2.gateCommand = markerCommand(UT_CTRL2.marker);
const UT = makeScenario("ut");
UT.gateCommand = markerCommand(UT.marker);

// (DO_DIRECT)/(UT_DIRECT): the deterministic, probe-level proof (see the header note above for why the
// confirmWorkerMerge-level (DO)/(UT) above cannot discriminate this exact regression).
const DO_DIRECT = makeScenario("do-direct");
const UT_DIRECT = makeScenario("ut-direct");

try {
  await setup(N);
  await setup(N2);
  await setup(R);
  await setupOverlapBranch(DO_CTRL, "overlap.txt", "orig-overlap\n", "DO-CTRL-worker-version\n");
  await setupOverlapBranch(DO_CTRL2, "overlap.txt", "orig-overlap\n", "DO-CTRL2-worker-version\n");
  await setupOverlapBranch(DO, "overlap.txt", "orig-overlap\n", "DO-worker-version\n");
  await setupOverlapBranch(UT_CTRL, "untracked-overlap.txt", undefined, "UT-CTRL-worker-version\n");
  await setupOverlapBranch(UT_CTRL2, "untracked-overlap.txt", undefined, "UT-CTRL2-worker-version\n");
  await setupOverlapBranch(UT, "untracked-overlap.txt", undefined, "UT-worker-version\n");
  await setupOverlapBranch(DO_DIRECT, "overlap.txt", "orig-overlap\n", "DO-DIRECT-worker-version\n");
  await setupOverlapBranch(UT_DIRECT, "untracked-overlap.txt", undefined, "UT-DIRECT-worker-version\n");

  // ── (N) negative control, run FIRST: genuine STAGED residue, no lock contention at all — must still
  // refuse. Its measured settle latency is this file's "real, measured quantity" (never a guessed
  // literal) for deriving (R)'s windowMs below.
  stageGenuineResidue(N, "genuine-residue.txt");
  check("(N) setup: genuine-residue.txt is STAGED in canonical N", git(N.repo, ["diff", "--cached", "--name-only"]) === "genuine-residue.txt");

  const mainBeforeN = git(N.repo, ["rev-parse", "HEAD"]);
  const nStart = Date.now();
  const confirmN = await sessions.confirmWorkerMerge(N.mgrId, N.workerId);
  const nElapsedMs = Date.now() - nStart;
  console.log(`[diag] (N) baseline confirmWorkerMerge settled in ${nElapsedMs}ms`);
  check("(N) confirmWorkerMerge → merged:false", confirmN.merged === false);
  check("(N) GATE NEVER RAN — marker file absent (staged dirt still refuses BEFORE the gate)", !fs.existsSync(N.marker));
  check("(N) canonical HEAD UNCHANGED", git(N.repo, ["rev-parse", "HEAD"]) === mainBeforeN);
  check("(N) staged content left UNTOUCHED (still staged, not cleared)", git(N.repo, ["diff", "--cached", "--name-only"]) === "genuine-residue.txt");
  check("(N) reason names the STAGED condition", /STAGED/.test(confirmN.detailText ?? ""));
  check("(N) POSITIVE CONTROL: the 'a HUMAN resolves the canonical checkout by hand' wording DOES fire for a genuine, uncontended refusal (proves the regex (R) relies on below can actually match)",
    HUMAN_MUST_RESOLVE_RE.test(confirmN.detailText ?? ""));
  check("(N) a merge_rejected(reason:canonical_staged_dirt) event recorded",
    db.listEvents(N.mgrId).some((e) => e.kind === "merge_rejected" && e.detail && e.detail.reason === "canonical_staged_dirt"));

  // ── (R) simulate a sibling's in-flight squash: stage (never commit) unrelated content, and HOLD the
  // real per-repo lock while it stays staged — releasing the holder commits it, mirroring the sibling's
  // squash landing for real.
  fs.writeFileSync(path.join(R.repo, "sibling-inflight.txt"), "sibling squash content\n");
  execFileSync("git", ["add", "sibling-inflight.txt"], { cwd: R.repo });
  check("(R) setup: sibling-inflight.txt is STAGED in canonical R, not committed", git(R.repo, ["diff", "--cached", "--name-only"]) === "sibling-inflight.txt");

  let releaseHolder;
  const holderGate = new Promise((resolve) => { releaseHolder = resolve; });
  let holderCommitted = false;
  const holderPromise = withCanonicalIndexLock(R.repo, async () => {
    await holderGate;
    execFileSync("git", [...GIT_ID.split(" "), "commit", "-q", "-m", "simulated sibling squash commit"], { cwd: R.repo });
    holderCommitted = true;
    return "holder-done";
  });

  // Start confirmWorkerMerge for an UNRELATED worker on the SAME repo while the holder above still has
  // the lock — do NOT await it yet; track settlement via a side-effect flag so assertNeverWithControl's
  // sampling check() can observe it without consuming the real promise.
  const mainBeforeR = git(R.repo, ["rev-parse", "HEAD"]);
  let confirmRSettled = false;
  const confirmPromise = sessions.confirmWorkerMerge(R.mgrId, R.workerId);
  confirmPromise.then(() => { confirmRSettled = true; }, () => { confirmRSettled = true; });

  // windowMs: a generous multiple of (N)'s own REAL, measured settle time for the identical call shape —
  // never a bare guessed literal. Floored so host jitter on an unusually fast (N) run still leaves real
  // margin.
  const windowMs = Math.max(nElapsedMs * 4, 1500);
  console.log(`[diag] (R) derived windowMs=${windowMs} from (N)'s measured ${nElapsedMs}ms`);

  const neverSettledEarly = await assertNeverWithControl({
    label: "(R) confirmWorkerMerge did NOT settle early while the sibling's squash is still mid-flight (queued behind the lock, not racing it)",
    check: () => confirmRSettled,
    windowMs,
    positiveControl: async () => {
      // Arm a REAL violation of the identical check shape: a genuinely unlocked/uncontended staged-dirt
      // refusal (scenario N2, fresh project — never reused from N) really does settle quickly, proving
      // this file's "has confirmWorkerMerge settled" check CAN observe a true violation within windowMs
      // before (R)'s own absence of one is trusted.
      stageGenuineResidue(N2, "genuine-residue-n2.txt");
      const confirmN2 = await sessions.confirmWorkerMerge(N2.mgrId, N2.workerId);
      return confirmN2.merged === false;
    },
  });
  check("(R) confirmWorkerMerge did NOT settle early while the sibling's squash is still mid-flight (queued behind the lock, not racing it)", neverSettledEarly);
  check("(R) sibling's content is still only STAGED (holder not yet released)", !holderCommitted && git(R.repo, ["diff", "--cached", "--name-only"]) === "sibling-inflight.txt");

  // Release the simulated sibling: its content commits, repo goes clean, THEN confirmWorkerMerge's own
  // (now-unblocked) staged-dirt probe should run and see nothing wrong.
  releaseHolder();
  await holderPromise;
  check("(R) sibling's simulated squash committed for real", holderCommitted && git(R.repo, ["diff", "--cached", "--name-only"]) === "");

  const confirmR = await confirmPromise;
  check("(R) confirmWorkerMerge → merged:true (no false refusal once the sibling's work settled)", confirmR.merged === true);
  check("(R) NOT refused for canonical_staged_dirt",
    !db.listEvents(R.mgrId).some((e) => e.kind === "merge_rejected" && e.detail && e.detail.reason === "canonical_staged_dirt"));
  check("(R) NO merge_rejected event of ANY reason was recorded (a genuinely clean land, not merely a differently-reasoned refusal)",
    !db.listEvents(R.mgrId).some((e) => e.kind === "merge_rejected"));
  // Condition 3 (manager, card 6b8822d2): pin that the refusal's own WORDING — "a HUMAN resolves the
  // canonical checkout by hand" (stagedCanonicalDirtRefusalMessage's exact phrase, confirmed verbatim as a
  // POSITIVE control via (N)'s detailText above) — never appears anywhere in (R)'s result. The text is
  // ONLY ever emitted by the canonical_staged_dirt rejection path, so this strengthens (by checking the
  // ACTUAL STRING, not just the classified reason) the two checks just above.
  check("(R) the 'a HUMAN resolves the canonical checkout by hand' refusal wording never fired for the sibling case",
    !HUMAN_MUST_RESOLVE_RE.test(confirmR.reason ?? "") && !HUMAN_MUST_RESOLVE_RE.test(confirmR.detailText ?? ""));
  check("(R) canonical HEAD advanced past the sibling's commit", git(R.repo, ["rev-parse", "HEAD"]) !== mainBeforeR);
  check("(R) the sibling's simulated commit survives on canonical HEAD", readText(path.join(R.repo, "sibling-inflight.txt")) === "sibling squash content\n");
  check("(R) this branch's own work landed too", readText(path.join(R.repo, "r-work.txt")) === "worker-version\n");

  // ── (DO_CTRL) negative control + timing baseline: genuine, UNCONTENDED unstaged-modify overlap on a
  // branch-touched path — must still refuse via detectCanonicalDirtyOverlap, exactly as before this round's
  // fix. Content differs from both HEAD's original and the branch's own change, so narrowing (i)
  // ("already-landed content") never excludes it.
  fs.writeFileSync(path.join(DO_CTRL.repo, "overlap.txt"), "permanent human edit, unrelated to the branch\n");
  check("(DO_CTRL) setup: overlap.txt is an UNSTAGED modification in canonical DO_CTRL", git(DO_CTRL.repo, ["diff", "--name-only"]) === "overlap.txt" && git(DO_CTRL.repo, ["diff", "--cached", "--name-only"]) === "");
  const doCtrlStart = Date.now();
  const confirmDoCtrl = await sessions.confirmWorkerMerge(DO_CTRL.mgrId, DO_CTRL.workerId);
  const doCtrlElapsedMs = Date.now() - doCtrlStart;
  console.log(`[diag] (DO_CTRL) baseline confirmWorkerMerge settled in ${doCtrlElapsedMs}ms`);
  check("(DO_CTRL) confirmWorkerMerge → merged:false", confirmDoCtrl.merged === false);
  check("(DO_CTRL) GATE NEVER RAN — marker file absent (dirty overlap refuses BEFORE the gate)", !fs.existsSync(DO_CTRL.marker));
  check("(DO_CTRL) a merge_rejected(reason:canonical_dirty_overlap) event recorded",
    db.listEvents(DO_CTRL.mgrId).some((e) => e.kind === "merge_rejected" && e.detail && e.detail.reason === "canonical_dirty_overlap" && !e.detail.untracked));

  // ── (DO) simulate a sibling's in-flight squash on a path THIS branch also touches: an UNSTAGED
  // modification (never `git add`ed) — the shape git's unpack_trees can transiently produce mid-squash on
  // the WORKTREE before the index catches up. Releasing the holder cleanly reverts it (`git checkout --`),
  // mirroring the transient edit never actually landing on this path — never a committed conflict to
  // reconcile against this branch's own change.
  fs.writeFileSync(path.join(DO.repo, "overlap.txt"), "sibling mid-squash content\n");
  check("(DO) setup: overlap.txt is an UNSTAGED modification in canonical DO, not staged", git(DO.repo, ["diff", "--name-only"]) === "overlap.txt" && git(DO.repo, ["diff", "--cached", "--name-only"]) === "");

  let releaseDoHolder;
  const doHolderGate = new Promise((resolve) => { releaseDoHolder = resolve; });
  let doHolderReverted = false;
  const doHolderPromise = withCanonicalIndexLock(DO.repo, async () => {
    await doHolderGate;
    execFileSync("git", ["checkout", "--", "overlap.txt"], { cwd: DO.repo });
    doHolderReverted = true;
    return "holder-done";
  });

  const mainBeforeDo = git(DO.repo, ["rev-parse", "HEAD"]);
  let confirmDoSettled = false;
  const confirmDoPromise = sessions.confirmWorkerMerge(DO.mgrId, DO.workerId);
  confirmDoPromise.then(() => { confirmDoSettled = true; }, () => { confirmDoSettled = true; });

  const windowMsDo = Math.max(doCtrlElapsedMs * 4, 1500);
  console.log(`[diag] (DO) derived windowMs=${windowMsDo} from (DO_CTRL)'s measured ${doCtrlElapsedMs}ms`);
  const doNeverSettledEarly = await assertNeverWithControl({
    label: "(DO) confirmWorkerMerge did NOT settle early while the sibling's unstaged-modify is still mid-flight",
    check: () => confirmDoSettled,
    windowMs: windowMsDo,
    positiveControl: async () => {
      fs.writeFileSync(path.join(DO_CTRL2.repo, "overlap.txt"), "permanent human edit 2, unrelated to the branch\n");
      const confirmDoCtrl2 = await sessions.confirmWorkerMerge(DO_CTRL2.mgrId, DO_CTRL2.workerId);
      return confirmDoCtrl2.merged === false;
    },
  });
  check("(DO) confirmWorkerMerge did NOT settle early while the sibling's unstaged-modify is still mid-flight (queued behind the lock, not racing it)", doNeverSettledEarly);
  check("(DO) overlap.txt is still unstaged-modified (holder not yet released)", !doHolderReverted && git(DO.repo, ["diff", "--name-only"]) === "overlap.txt");

  releaseDoHolder();
  await doHolderPromise;
  check("(DO) the transient edit was reverted for real", doHolderReverted && git(DO.repo, ["diff", "--name-only"]) === "" && readText(path.join(DO.repo, "overlap.txt")) === "orig-overlap\n");

  const confirmDo = await confirmDoPromise;
  check("(DO) confirmWorkerMerge → merged:true (no false refusal once the sibling's edit cleared)", confirmDo.merged === true);
  check("(DO) NO merge_rejected event of ANY reason was recorded",
    !db.listEvents(DO.mgrId).some((e) => e.kind === "merge_rejected"));
  check("(DO) canonical HEAD advanced", git(DO.repo, ["rev-parse", "HEAD"]) !== mainBeforeDo);
  check("(DO) this branch's own work landed", readText(path.join(DO.repo, "overlap.txt")) === "DO-worker-version\n");

  // ── (UT_CTRL) negative control + timing baseline: genuine, UNCONTENDED untracked collision on a path
  // the branch ADDS — must still refuse via detectCanonicalUntrackedOverlap (content-independent).
  fs.writeFileSync(path.join(UT_CTRL.repo, "untracked-overlap.txt"), "permanent untracked human file\n");
  check("(UT_CTRL) setup: untracked-overlap.txt is UNTRACKED in canonical UT_CTRL", git(UT_CTRL.repo, ["status", "--porcelain"]) === "?? untracked-overlap.txt");
  const utCtrlStart = Date.now();
  const confirmUtCtrl = await sessions.confirmWorkerMerge(UT_CTRL.mgrId, UT_CTRL.workerId);
  const utCtrlElapsedMs = Date.now() - utCtrlStart;
  console.log(`[diag] (UT_CTRL) baseline confirmWorkerMerge settled in ${utCtrlElapsedMs}ms`);
  check("(UT_CTRL) confirmWorkerMerge → merged:false", confirmUtCtrl.merged === false);
  check("(UT_CTRL) GATE NEVER RAN — marker file absent (untracked overlap refuses BEFORE the gate)", !fs.existsSync(UT_CTRL.marker));
  check("(UT_CTRL) a merge_rejected(reason:canonical_dirty_overlap, untracked:true) event recorded",
    db.listEvents(UT_CTRL.mgrId).some((e) => e.kind === "merge_rejected" && e.detail && e.detail.reason === "canonical_dirty_overlap" && e.detail.untracked === true));

  // ── (UT) simulate a sibling's in-flight squash ADDING a path THIS branch also adds: an UNTRACKED file
  // (never committed) — the shape git's unpack_trees can transiently write mid-squash before the index
  // catches up. Releasing the holder removes it (nothing to revert — it was never tracked), mirroring the
  // transient file never actually landing there.
  fs.writeFileSync(path.join(UT.repo, "untracked-overlap.txt"), "sibling mid-squash untracked content\n");
  check("(UT) setup: untracked-overlap.txt is UNTRACKED in canonical UT", git(UT.repo, ["status", "--porcelain"]) === "?? untracked-overlap.txt");

  let releaseUtHolder;
  const utHolderGate = new Promise((resolve) => { releaseUtHolder = resolve; });
  let utHolderCleared = false;
  const utHolderPromise = withCanonicalIndexLock(UT.repo, async () => {
    await utHolderGate;
    fs.rmSync(path.join(UT.repo, "untracked-overlap.txt"), { force: true });
    utHolderCleared = true;
    return "holder-done";
  });

  const mainBeforeUt = git(UT.repo, ["rev-parse", "HEAD"]);
  let confirmUtSettled = false;
  const confirmUtPromise = sessions.confirmWorkerMerge(UT.mgrId, UT.workerId);
  confirmUtPromise.then(() => { confirmUtSettled = true; }, () => { confirmUtSettled = true; });

  const windowMsUt = Math.max(utCtrlElapsedMs * 4, 1500);
  console.log(`[diag] (UT) derived windowMs=${windowMsUt} from (UT_CTRL)'s measured ${utCtrlElapsedMs}ms`);
  const utNeverSettledEarly = await assertNeverWithControl({
    label: "(UT) confirmWorkerMerge did NOT settle early while the sibling's untracked file is still mid-flight",
    check: () => confirmUtSettled,
    windowMs: windowMsUt,
    positiveControl: async () => {
      fs.writeFileSync(path.join(UT_CTRL2.repo, "untracked-overlap.txt"), "permanent untracked human file 2\n");
      const confirmUtCtrl2 = await sessions.confirmWorkerMerge(UT_CTRL2.mgrId, UT_CTRL2.workerId);
      return confirmUtCtrl2.merged === false;
    },
  });
  check("(UT) confirmWorkerMerge did NOT settle early while the sibling's untracked file is still mid-flight (queued behind the lock, not racing it)", utNeverSettledEarly);
  check("(UT) untracked-overlap.txt is still present (holder not yet released)", !utHolderCleared && fs.existsSync(path.join(UT.repo, "untracked-overlap.txt")));

  releaseUtHolder();
  await utHolderPromise;
  check("(UT) the transient untracked file was removed for real", utHolderCleared && git(UT.repo, ["status", "--porcelain"]) === "");

  const confirmUt = await confirmUtPromise;
  check("(UT) confirmWorkerMerge → merged:true (no false refusal once the sibling's file cleared)", confirmUt.merged === true);
  check("(UT) NO merge_rejected event of ANY reason was recorded",
    !db.listEvents(UT.mgrId).some((e) => e.kind === "merge_rejected"));
  check("(UT) canonical HEAD advanced", git(UT.repo, ["rev-parse", "HEAD"]) !== mainBeforeUt);
  check("(UT) this branch's own work landed", readText(path.join(UT.repo, "untracked-overlap.txt")) === "UT-worker-version\n");

  // ── (DO_DIRECT) deterministic, probe-level proof of the EXACT call-site pattern the fix applies — see
  // the header note above for why (DO) above cannot discriminate this exact regression. A sibling holds
  // the lock with an unstaged-modify present on a branch-touched path:
  //   (a) the LOCKED call-site shape (`withCanonicalIndexLock(repo, () => detectCanonicalDirtyOverlap(...))`
  //       — exactly what confirmWorkerMerge's combined admission block now does) does NOT settle while the
  //       sibling holds the lock, and sees overlap:false once released+cleaned — the fix's mechanism.
  //   (b) the BARE, unwrapped call (`detectCanonicalDirtyOverlap(...)` with no lock at all — exactly the
  //       manufactured regression) does NOT wait at all and observes overlap:true immediately, while the
  //       sibling is still mid-flight — the EXACT exposure the fix closes.
  {
    fs.writeFileSync(path.join(DO_DIRECT.repo, "overlap.txt"), "sibling mid-squash content (direct a)\n");
    let releaseA;
    const gateA = new Promise((r) => { releaseA = r; });
    let revertedA = false;
    const holderA = withCanonicalIndexLock(DO_DIRECT.repo, async () => {
      await gateA;
      execFileSync("git", ["checkout", "--", "overlap.txt"], { cwd: DO_DIRECT.repo });
      revertedA = true;
      return "done";
    });
    let lockedSettled = false;
    const lockedPromise = withCanonicalIndexLock(DO_DIRECT.repo, () => detectCanonicalDirtyOverlap(DO_DIRECT.repo, DO_DIRECT.branch, {}));
    lockedPromise.then(() => { lockedSettled = true; }, () => { lockedSettled = true; });
    const lockedNeverSettledEarly = await assertNeverWithControl({
      label: "(DO_DIRECT a) the LOCKED detectCanonicalDirtyOverlap call-site does NOT settle while the sibling holds the lock",
      check: () => lockedSettled,
      windowMs: Math.max(doCtrlElapsedMs * 2, 800),
      positiveControl: async () => {
        // Genuinely exercises withCanonicalIndexLock's OWN settle mechanism (never a bare Promise.resolve)
        // on an INDEPENDENT, uncontended scratch key — proves THIS check's "has settled" flag-flip
        // mechanism really can observe a real withCanonicalIndexLock call completing within windowMs.
        let ctrlSettled = false;
        const ctrlPromise = withCanonicalIndexLock(path.join(os.tmpdir(), `loom-sdlr-do-direct-ctrl-${sfx}`), () => Promise.resolve("ok"));
        ctrlPromise.then(() => { ctrlSettled = true; });
        await ctrlPromise;
        return ctrlSettled;
      },
    });
    check("(DO_DIRECT a) the LOCKED call did NOT settle while the sibling holds the lock", lockedNeverSettledEarly);
    releaseA();
    await holderA;
    check("(DO_DIRECT a) the sibling's transient edit was reverted for real", revertedA && git(DO_DIRECT.repo, ["diff", "--name-only"]) === "");
    const lockedResult = await lockedPromise;
    check("(DO_DIRECT a) the LOCKED call sees overlap:false once settled (post-release, clean state)", lockedResult.overlap === false);

    fs.writeFileSync(path.join(DO_DIRECT.repo, "overlap.txt"), "sibling mid-squash content (direct b)\n");
    let releaseB;
    const gateB = new Promise((r) => { releaseB = r; });
    const holderB = withCanonicalIndexLock(DO_DIRECT.repo, async () => { await gateB; return "done"; });
    const bareResult = await detectCanonicalDirtyOverlap(DO_DIRECT.repo, DO_DIRECT.branch, {});
    check("(DO_DIRECT b) THE EXPOSURE: a BARE (unwrapped) call sees overlap:true immediately, WHILE the sibling still holds the lock (never waits for it) — exactly what this card's fix prevents",
      bareResult.overlap === true && Array.isArray(bareResult.paths) && bareResult.paths.includes("overlap.txt"));
    releaseB();
    await holderB;
    execFileSync("git", ["checkout", "--", "overlap.txt"], { cwd: DO_DIRECT.repo });
  }

  // ── (UT_DIRECT) same proof, for detectCanonicalUntrackedOverlap ──────────────────────────────────────
  {
    fs.writeFileSync(path.join(UT_DIRECT.repo, "untracked-overlap.txt"), "sibling mid-squash untracked content (direct a)\n");
    let releaseA;
    const gateA = new Promise((r) => { releaseA = r; });
    let clearedA = false;
    const holderA = withCanonicalIndexLock(UT_DIRECT.repo, async () => {
      await gateA;
      fs.rmSync(path.join(UT_DIRECT.repo, "untracked-overlap.txt"), { force: true });
      clearedA = true;
      return "done";
    });
    let lockedSettled = false;
    const lockedPromise = withCanonicalIndexLock(UT_DIRECT.repo, () => detectCanonicalUntrackedOverlap(UT_DIRECT.repo, UT_DIRECT.branch, {}));
    lockedPromise.then(() => { lockedSettled = true; }, () => { lockedSettled = true; });
    const lockedNeverSettledEarly = await assertNeverWithControl({
      label: "(UT_DIRECT a) the LOCKED detectCanonicalUntrackedOverlap call-site does NOT settle while the sibling holds the lock",
      check: () => lockedSettled,
      windowMs: Math.max(utCtrlElapsedMs * 2, 800),
      positiveControl: async () => {
        // Same reasoning as (DO_DIRECT a)'s own control — an independent, uncontended
        // withCanonicalIndexLock call, never a bare Promise.resolve.
        let ctrlSettled = false;
        const ctrlPromise = withCanonicalIndexLock(path.join(os.tmpdir(), `loom-sdlr-ut-direct-ctrl-${sfx}`), () => Promise.resolve("ok"));
        ctrlPromise.then(() => { ctrlSettled = true; });
        await ctrlPromise;
        return ctrlSettled;
      },
    });
    check("(UT_DIRECT a) the LOCKED call did NOT settle while the sibling holds the lock", lockedNeverSettledEarly);
    releaseA();
    await holderA;
    check("(UT_DIRECT a) the sibling's transient untracked file was removed for real", clearedA && git(UT_DIRECT.repo, ["status", "--porcelain"]) === "");
    const lockedResult = await lockedPromise;
    check("(UT_DIRECT a) the LOCKED call sees overlap:false once settled (post-release, clean state)", lockedResult.overlap === false);

    fs.writeFileSync(path.join(UT_DIRECT.repo, "untracked-overlap.txt"), "sibling mid-squash untracked content (direct b)\n");
    let releaseB;
    const gateB = new Promise((r) => { releaseB = r; });
    const holderB = withCanonicalIndexLock(UT_DIRECT.repo, async () => { await gateB; return "done"; });
    const bareResult = await detectCanonicalUntrackedOverlap(UT_DIRECT.repo, UT_DIRECT.branch, {});
    check("(UT_DIRECT b) THE EXPOSURE: a BARE (unwrapped) call sees overlap:true immediately, WHILE the sibling still holds the lock (never waits for it) — exactly what this card's fix prevents",
      bareResult.overlap === true && Array.isArray(bareResult.paths) && bareResult.paths.includes("untracked-overlap.txt"));
    releaseB();
    await holderB;
    fs.rmSync(path.join(UT_DIRECT.repo, "untracked-overlap.txt"), { force: true });
  }

  // ── (STRUCTURAL) does confirmWorkerMerge's REAL SOURCE actually route all three probes through the
  // SAME shared lock acquisition? (DO_DIRECT)/(UT_DIRECT) above prove the MECHANISM (locked waits+clean,
  // bare doesn't-wait+dirty) in isolation — this is the one check in this file that verifies confirmWorkerMerge's
  // OWN call site uses that mechanism, not just that the mechanism itself works. Reads src/sessions/service.ts
  // directly (never dist/ — sidesteps tsc's AST-reprint comment-survival nuance entirely; see CLAUDE.md's
  // CHANGED_TS_TEXT_SCANNER_REPO_PATHS note). Both polarities controlled: a hand-written fixture of the
  // CORRECT shape must match, and the SAME regex against a fixture of the EXACT manufactured regression
  // (dirtyOverlap/untrackedOverlap moved outside the lock, staged left inside — precisely what Code
  // Reviewer e001ee19 round 2 found) must NOT match.
  {
    const serviceSrcPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "sessions", "service.ts");
    const src = fs.readFileSync(serviceSrcPath, "utf8");
    // A LAZY `[\s\S]*?` span between tokens is UNSAFE against this file on its own: this file is 24,000+
    // lines, so a lazy wildcard happily stretches past any one lock block to the NEXT occurrence of a
    // later token anywhere else in the file, regardless of nesting — measured directly: an earlier draft
    // of this check used exactly that shape and still reported "matches" against the manufactured
    // regression fixture (the real source has plenty of unrelated, later `detectCanonicalDirtyOverlap(`/
    // `})))`-shaped text for the wildcard to latch onto). The robust, bounded signal instead: capture the
    // TEXT BETWEEN `detectCanonicalStagedDirt(` and the NEXT `detectCanonicalDirtyOverlap(` call, and check
    // whether THAT GAP contains the lock's own 4-character closing sequence `})));` — if it does, the lock
    // already closed before dirtyOverlap runs (the regression); if not, dirtyOverlap is still inside it (the fix).
    const gapBetween = (text, fromToken, toToken) => {
      const m = new RegExp(`${fromToken}[\\s\\S]*?${toToken}`).exec(text);
      return m ? m[0] : null;
    };
    const LOCK_CLOSE_RE = /\}\)\)\)/;
    const stagedToDirty = gapBetween(src, "detectCanonicalStagedDirt\\(", "detectCanonicalDirtyOverlap\\(");
    const dirtyToUntracked = gapBetween(src, "detectCanonicalDirtyOverlap\\(", "detectCanonicalUntrackedOverlap\\(");
    const allThreeShareOneLock = stagedToDirty !== null && dirtyToUntracked !== null
      && !LOCK_CLOSE_RE.test(stagedToDirty) && !LOCK_CLOSE_RE.test(dirtyToUntracked);

    const CORRECT_FIXTURE = `
      try {
        ({ stagedDirt, dirtyOverlap, untrackedOverlap } = await withCanonicalIndexLock(repoPath, async () => ({
          stagedDirt: await detectCanonicalStagedDirt(repoPath, { timeoutMs: this.gitOpMs }),
          dirtyOverlap: await detectCanonicalDirtyOverlap(repoPath, branch, { timeoutMs: this.gitOpMs }),
          untrackedOverlap: await detectCanonicalUntrackedOverlap(repoPath, branch, { timeoutMs: this.gitOpMs }),
        })));
      } catch (e) { if (!(e instanceof RepoQuarantinedError)) throw e; }
    `;
    const REGRESSED_FIXTURE = `
      try {
        ({ stagedDirt } = await withCanonicalIndexLock(repoPath, async () => ({
          stagedDirt: await detectCanonicalStagedDirt(repoPath, { timeoutMs: this.gitOpMs }),
        })));
      } catch (e) { if (!(e instanceof RepoQuarantinedError)) throw e; }
      dirtyOverlap = await detectCanonicalDirtyOverlap(repoPath, branch, { timeoutMs: this.gitOpMs });
      untrackedOverlap = await detectCanonicalUntrackedOverlap(repoPath, branch, { timeoutMs: this.gitOpMs });
    `;
    const checkShape = (text) => {
      const g1 = gapBetween(text, "detectCanonicalStagedDirt\\(", "detectCanonicalDirtyOverlap\\(");
      const g2 = gapBetween(text, "detectCanonicalDirtyOverlap\\(", "detectCanonicalUntrackedOverlap\\(");
      return g1 !== null && g2 !== null && !LOCK_CLOSE_RE.test(g1) && !LOCK_CLOSE_RE.test(g2);
    };
    check("(STRUCTURAL) positive control: the gap check finds all three calls present with NO lock-close between them, on a hand-written fixture of the CORRECT (combined-lock) shape", checkShape(CORRECT_FIXTURE));
    check("(STRUCTURAL) negative control: the SAME gap check correctly finds a lock-close BETWEEN stagedDirt and dirtyOverlap on a fixture of the exact manufactured regression", !checkShape(REGRESSED_FIXTURE));
    check("(STRUCTURAL) the REAL confirmWorkerMerge source (src/sessions/service.ts) currently has the CORRECT (combined-lock) shape — no lock-close between any of the three probe calls", allThreeShareOneLock);
  }
} finally {
  db.close();
  for (const p of [N, N2, R, DO_CTRL, DO_CTRL2, DO, UT_CTRL, UT_CTRL2, UT]) {
    try { fs.rmSync(p.marker, { force: true }); } catch { /* ignore */ }
  }
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the admission-time staged-dirt preflight no longer false-refuses on a sibling's real, in-flight (lock-held) squash: a concurrent confirmWorkerMerge correctly queues behind the lock and only observes genuinely-settled canonical state, while a GENUINE pre-existing staged residue (no lock contention) still refuses exactly as before."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
