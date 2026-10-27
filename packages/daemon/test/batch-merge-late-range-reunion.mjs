import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// A HELD BRANCH'S LATE-RANGE UNION MUST NOT UNDO A CHANGE MAIN MADE AND THEN REVERTED (card 13fc5227, Code Review round 1) + the late-range review is exact + the fail-closed paths.
// Companion to batch-merge-late-range-landing.mjs (which proves the first union, the review field and two fail-closed cases). Fixture as there: A adds feature-a.txt + extra-a.txt, a real
// merge_batch retains it after the gate reverts extra-a.txt; main ALSO carries other.txt = "x" from the init commit.
//   (reunion-red)   confirm #1 unions main (other.txt = "y", M1) into A's worktree and the gate is RED, so the union U1 stays on the branch; main then REVERTS other.txt to "x" (M2); confirm #2
//                   re-unions. Using the assembled tip as the merge base AGAIN would take "y" from U1 (an older common base than M1) and land it, undoing main's revert; the plain merge
//                   (merge base M1) keeps "x". Asserts main keeps other.txt == "x" AND loses extra-a.txt. Must be RED on 19d20dd4.
//   (reunion-moved) same, but main moves DURING the (passing) gate: the first confirm is refused because main advanced, U1 stays, the re-confirm lands.
//   (review-exact)  after U1 the review's `lateRange` lists ONLY what will land (extra-a.txt, the late-revert subject) — not main's own changes/subjects.
//   (unverified)    the hold's release cannot be verified (a failing probe) ⇒ refused, a transient-git-error wording (round 5, card f2b4d684).
//   (no-tip)        a retain event with no assembledTip/landedTip/landedSha ⇒ refused, names the missing range.
//   (no-live-tip)   the branch ref cannot be read ⇒ refused.
//   (no-gate)       the repo has no gateCommand ⇒ refused (the late-range union exists only on the gated path).
// Card 1bf5d9c3 (speed-up, suite-speed-up epic 24608d33): (reunion-red)/(review-exact) and (reunion-moved) are this file's (and batch-merge-late-range-landing.mjs's) REAL-COVERAGE HOME for the
// "real batch squash + watermark state → late-range review/confirm" interaction (Code Review on card 13fc5227) — they stay on `setup()`'s real two-worker `mergeBatchTracked`, UNCHANGED. The four
// fail-closed scenarios below ((unverified)/(no-tip)/(no-live-tip)/(no-gate)) key only on THAT the branch is held, never on HOW — measured: 89-97% of each of their own wall time was spent inside
// setup()'s real batch merge, and none of their refusal paths (a mocked probe, a malformed retain event, a deleted ref, a missing gateCommand) ever reference worker B. They now run through
// `seededSetup()`, which builds worker A's real git history (same shape setup() already builds for A) and writes the HELD event directly via `seedHeldBranch` (./_held-branch-fixture.mjs,
// also used by batch-merge-late-range-commits.mjs, whose own (equivalence check) scenario is the ONE place the seeded event is proved field-for-field equal to the real writer's — see that
// helper's own doc comment). See each converted scenario's own comment, below, for the exact service.ts fields its refusal reads and why seeding supplies them identically.
// Run: 1) pnpm build, 2) node packages/daemon/test/batch-merge-late-range-reunion.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";
import { seedHeldBranch } from "./_held-branch-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-bmlu-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
registerForCleanup(process.env.LOOM_HOME);

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

const GIT_ID = "-c user.email=bmlu@loom -c user.name=bmlu";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const git = (cwd, args) => execSync(`git ${args}`, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const noReap = async () => ({ killedPids: [] });
const FAIL = { passed: false, failedStep: "test", failedStatus: 1, steps: [] };
const dbs = [];

// Card 3493d0b6 (round 2, speed-up): each of the 6 scenarios below calls `setup()` fresh, which used to
// pay a real `git init` + config + commit — replaced with a template-repo + `fs.cpSync` copy, the same
// pattern `merge-gate-interval.mjs` (card 8b5e002d) already proved byte-identical for this exact shape.
// Scoped strictly to this one step: each scenario still gets its own fully independent repo/worktrees/db
// afterward (no state is shared ACROSS scenarios) — this does not touch the "could 4 scenarios share one
// setup()" idea a round-2 reviewer also raised; that would reorder/share mutable state across what are
// today fully isolated scenarios (two of the four fail-closed checks mutate the branch ref / project
// config destructively) for a smaller gain than this already proved noise-level on a sibling file
// (merge-confirm-solo-finalize-tip-cas.mjs's own measured before/after) — skipped as not worth the risk.
const TEMPLATE_REPO = path.join(os.tmpdir(), `loom-bmlu-tmpl-${sfx}`);
registerForCleanup(TEMPLATE_REPO);
(() => {
  fs.mkdirSync(TEMPLATE_REPO, { recursive: true });
  fs.writeFileSync(path.join(TEMPLATE_REPO, "README.md"), "# bmlu\n");
  fs.writeFileSync(path.join(TEMPLATE_REPO, "other.txt"), "x\n");
  execSync(`git init -q && git config user.email bmlu@loom && git config user.name bmlu`, { cwd: TEMPLATE_REPO });
  commitAll(TEMPLATE_REPO, "init", GIT_ID);
})();
async function setup(tag) {
  const repo = path.join(os.tmpdir(), `loom-bmlu-${tag}-${sfx}`);
  registerForCleanup(repo);
  fs.cpSync(TEMPLATE_REPO, repo, { recursive: true });
  const projId = `bmlu-proj-${tag}-${sfx}`, agentId = `bmlu-agent-${tag}-${sfx}`, mgrId = `bmlu-mgr-${tag}-${sfx}`;
  const cut = async (label, files) => {
    const taskId = `bmlu-task-${tag}-${label}-${sfx}`;
    const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
    registerForCleanup(worktreePath);
    for (const f of files) fs.writeFileSync(path.join(worktreePath, f), `work ${label} ${f}\n`);
    commitAll(worktreePath, label, GIT_ID);
    return { taskId, branch, worktreePath };
  };
  const a = await cut("a", ["feature-a.txt", "extra-a.txt"]);
  const b = await cut("b", ["feature-b.txt"]);
  const script = path.join(os.tmpdir(), `loom-bmlu-gate-${tag}-${sfx}.mjs`);
  registerForCleanup(script);
  fs.writeFileSync(script, [
    `import fs from "node:fs"; import path from "node:path"; import { execSync } from "node:child_process";`,
    `const wt = ${JSON.stringify(a.worktreePath)};`,
    `if (fs.existsSync(path.join(wt, "extra-a.txt"))) {`,
    `  execSync("git rm -q extra-a.txt && git -c user.email=bmlu@loom -c user.name=bmlu commit -q -m late-revert", { cwd: wt, stdio: "ignore" });`,
    `}`,
    `process.exit(0);`,
  ].join("\n"));
  const db = new Db(); dbs.push(db);
  db.insertProject({ id: projId, name: `BMLU-${tag}`, repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: `node "${script}"` } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "dev", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  const wA = `bmlu-wkr-a-${tag}-${sfx}`, wB = `bmlu-wkr-b-${tag}-${sfx}`;
  for (const [wId, w, label] of [[wA, a, "a"], [wB, b, "b"]]) {
    db.insertTask({ id: w.taskId, projectId: projId, title: `feat(test): ${label}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: wId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: w.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: w.taskId, worktreePath: w.worktreePath, branch: w.branch });
  }
  const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {}, purgeQueuedWorkerReportNudgesOnMerge() {}, purgeQueuedWorkerIdleNudges() {} };
  const mk = (extra = {}) => new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 600_000, reapWorktreeProcesses: noReap, ...extra });
  const first = await mk().mergeBatchTracked(mgrId, [wA, wB]);
  const val = first.settled && first.ok ? first.value : undefined;
  check(`(${tag} setup) the batch landed A and B and RETAINED A`, val?.ok === true && !!val.landed.find((l) => l.branch === a.branch)?.branchAdvancedDuringGate);
  const mainCommit = (file, content, subject) => { fs.writeFileSync(path.join(repo, file), content); commitAll(repo, subject, GIT_ID); };
  return { repo, projId, mgrId, wA, a, db, mk, mainCommit, script };
}

// seededSetup: the lighter single-candidate fixture for the four fail-closed scenarios below — builds
// worker A's real git history (same shape setup() already builds for A) but writes the HELD
// `batch_merge_branch_retained` event directly via seedHeldBranch instead of running a real two-worker
// `mergeBatchTracked` (no worker B, no spawned gate script). See the file header for why this is safe
// for these four scenarios specifically, and each scenario's own comment for its exact field reads.
async function seededSetup(tag) {
  const repo = path.join(os.tmpdir(), `loom-bmlu-${tag}-${sfx}`);
  registerForCleanup(repo);
  fs.cpSync(TEMPLATE_REPO, repo, { recursive: true });
  const projId = `bmlu-proj-${tag}-${sfx}`, agentId = `bmlu-agent-${tag}-${sfx}`, mgrId = `bmlu-mgr-${tag}-${sfx}`;
  const taskId = `bmlu-task-${tag}-a-${sfx}`;
  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  registerForCleanup(worktreePath);
  fs.writeFileSync(path.join(worktreePath, "feature-a.txt"), "work a feature-a.txt\n");
  fs.writeFileSync(path.join(worktreePath, "extra-a.txt"), "work a extra-a.txt\n");
  commitAll(worktreePath, "a", GIT_ID);
  const a = { taskId, branch, worktreePath };
  const assembledTip = git(a.worktreePath, "rev-parse HEAD");
  // Stands in for "the batch landed A's assembled commits onto main" (same final tree as assembledTip) —
  // a plain commit instead of a real squash; its sha becomes `landedSha`. DELIBERATELY a DIFFERENT commit
  // message than the branch's own "a" commit — see batch-merge-late-range-commits.mjs's setup() for the
  // sha-collision reason (identical tree+parent+author+committer+message can land on the SAME sha when
  // git's one-second timestamp granularity lands both in the same second).
  fs.writeFileSync(path.join(repo, "feature-a.txt"), "work a feature-a.txt\n");
  fs.writeFileSync(path.join(repo, "extra-a.txt"), "work a extra-a.txt\n");
  commitAll(repo, "a-landed", GIT_ID);
  const landedSha = git(repo, "rev-parse HEAD");
  // The late commit a worker adds WHILE a real batch gate would run — applied directly instead of via a
  // spawned gate-command child process (none of the four scenarios that call this actually execute a real
  // gateCommand: each either injects its own `runGate` override or tests the ABSENT-gateCommand case
  // directly, so no spawnable script is needed here at all).
  git(a.worktreePath, "rm -q extra-a.txt");
  commitAll(a.worktreePath, "late-revert", GIT_ID);
  const liveTip = git(a.worktreePath, "rev-parse HEAD");
  const db = new Db(); dbs.push(db);
  db.insertProject({ id: projId, name: `BMLU-${tag}`, repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: `node -e "process.exit(0)"` } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "dev", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  const wA = `bmlu-wkr-a-${tag}-${sfx}`;
  db.insertTask({ id: a.taskId, projectId: projId, title: "feat(test): a", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: wA, projectId: projId, agentId, engineSessionId: null, title: null, cwd: a.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: a.taskId, worktreePath: a.worktreePath, branch: a.branch });
  seedHeldBranch(db, { managerSessionId: mgrId, workerSessionId: wA, taskId: a.taskId, branch: a.branch, assembledTip, liveTip, landedSha });
  const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {}, purgeQueuedWorkerReportNudgesOnMerge() {}, purgeQueuedWorkerIdleNudges() {} };
  const mk = (extra = {}) => new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 600_000, reapWorktreeProcesses: noReap, ...extra });
  const mainCommit = (file, content, subject) => { fs.writeFileSync(path.join(repo, file), content); commitAll(repo, subject, GIT_ID); };
  return { repo, projId, mgrId, wA, a, db, mk, mainCommit };
}

const otherOnMain = (repo) => fs.readFileSync(path.join(repo, "other.txt"), "utf8").trim();

try {
  // ── (reunion-red) + (review-exact) ─────────────────────────────────────────────────────────────────────────────────
  {
    const s = await setup("red");
    const { repo, mgrId, wA, a, mk, mainCommit } = s;
    await mk().reviewWorkerMerge(mgrId, wA);
    mainCommit("other.txt", "y\n", "main1-other-y");
    const red = await mk({ runGate: async () => FAIL }).confirmWorkerMerge(mgrId, wA);
    check("(reunion-red setup) confirm #1 was rejected by the red gate (nothing landed) and left the union of main on A's branch", red.merged === false && git(repo, `log ${a.branch} --format=%s`).includes("Merge main into branch (owed commits over"));
    mainCommit("other.txt", "x\n", "main2-revert-other");
    check("(reunion-red setup) main reverted other.txt to x", otherOnMain(repo) === "x");
    // (review-exact) the branch now HOLDS a union of main: the review must report only what will land, not main's own change or its subjects.
    const rev = await mk().reviewWorkerMerge(mgrId, wA);
    const lr = rev.lateRange;
    check("(review-exact) lateRange lists ONLY extra-a.txt (main's other.txt change is NOT reported as the branch's)", !!lr && lr.filesChanged === 1 && lr.files[0]?.file === "extra-a.txt" && lr.deletions === 1);
    check("(review-exact) lateRange subjects are ONLY the branch's own late commit (none of main's subjects)", !!lr && lr.commitSubjects.length === 1 && lr.commitSubjects[0] === "late-revert");
    const res = await mk({ runGate: async () => ({ passed: true }) }).confirmWorkerMerge(mgrId, wA);
    check("(reunion-red) the re-confirm lands: merged:true", res.merged === true);
    check("(reunion-red) OUTCOME: main KEEPS its own revert (other.txt == x), not the stale y", otherOnMain(repo) === "x");
    check("(reunion-red) OUTCOME: main lost the reverted extra-a.txt and still has feature-a.txt", !fs.existsSync(path.join(repo, "extra-a.txt")) && fs.existsSync(path.join(repo, "feature-a.txt")));
  }

  // ── (reunion-moved) main moves during a passing gate ──────────────────────────────────────────────────────────────────
  {
    const s = await setup("moved");
    const { repo, mgrId, wA, a, mk, mainCommit } = s;
    await mk().reviewWorkerMerge(mgrId, wA);
    mainCommit("other.txt", "y\n", "main1-other-y");
    let moved = false;
    const movingGate = async () => { if (!moved) { moved = true; mainCommit("other.txt", "x\n", "main2-revert-other"); } return { passed: true }; };
    const r1 = await mk({ runGate: movingGate }).confirmWorkerMerge(mgrId, wA);
    check("(reunion-moved setup) the first confirm did not land (main advanced during its gate)", r1.merged === false && moved === true);
    let r2 = await mk({ runGate: async () => ({ passed: true }) }).confirmWorkerMerge(mgrId, wA);
    for (let i = 0; i < 2 && r2.merged !== true; i++) r2 = await mk({ runGate: async () => ({ passed: true }) }).confirmWorkerMerge(mgrId, wA);
    check("(reunion-moved) the re-confirm lands: merged:true", r2.merged === true);
    check("(reunion-moved) OUTCOME: main KEEPS its own revert (other.txt == x) and lost extra-a.txt", otherOnMain(repo) === "x" && !fs.existsSync(path.join(repo, "extra-a.txt")) && fs.existsSync(path.join(repo, "feature-a.txt")));
    void a;
  }

  // ── fail-closed paths — all four converted to seededSetup() (card 1bf5d9c3): each refusal keys on service.ts fields seedHeldBranch writes identically to the real writer ────────────────────
  {
    // Reads (service.ts): isBranchHeld (~21861) — detail.assembledTip (via heldRecordedTip ~21886-21890) sets `recordedTip`, compared to the live branch tip (~21876/21879) so the hold does NOT
    // release; detail.landedSha (~21870/21887) is truthy, so isBranchHeld reaches the git-fact probe `findLaterBranchSquash` (~21881) — which THIS scenario's `heldProbeGitFactory` mocks to
    // throw, making it return "error" ⇒ gitUnverified:true (~21883) ⇒ resolveOwedRange's (~21900) "could not be verified" refusal. seedHeldBranch writes assembledTip/landedSha with the exact
    // same shapes/values the real writer would (a real worktree at assembledTip, a real commit at landedSha on main) — the mocked probe is what decides this scenario, not how the hold formed.
    const s = await seededSetup("unverified");
    const { repo, mgrId, wA, a, mk } = s;
    const failing = () => ({ raw: async () => { throw new Error("simulated transient git failure"); } });
    const mainBefore = git(repo, "rev-parse HEAD");
    const rev = await mk({ heldProbeGitFactory: failing }).reviewWorkerMerge(mgrId, wA);
    check("(unverified) worker_merge warns that the release could not be verified and shows no late range", rev.lateRange === undefined && /could not be verified/.test(rev.warning ?? ""));
    const res = await mk({ heldProbeGitFactory: failing, runGate: async () => ({ passed: true }) }).confirmWorkerMerge(mgrId, wA);
    // @decision f2b4d684 (round 5) — reworded from "usually transient, retry" to the unified transient
    // wording this card gives EVERY held-branch-unverifiable refusal; also now carries heldRangeUnverifiable
    // so it classifies into NEVER_CACHED_OUTCOMES rather than a stably-cached plain "rejected".
    check("(unverified) confirm REFUSES (a transient git error is possible — re-confirm once it clears); main untouched, branch intact", res.merged === false && /transient git error is possible/.test(res.reason ?? "") && git(repo, "rev-parse HEAD") === mainBefore && !!git(repo, `rev-parse ${a.branch}`));
    check("(unverified) THE FIX: carries heldRangeUnverifiable:true", res.heldRangeUnverifiable === true);
  }
  {
    // Reads (service.ts): isBranchHeld's retain-selection (~21867, picks the LATEST `ts` event for the branch) picks THIS scenario's own malformed second event (ts = +5s), never the seeded one
    // from setup — so heldRecordedTip (~21886-21890) and resolveOwedRange's base-null refusal (~21902, "records no readable assembledTip/landedTip") are driven entirely by the malformed event
    // this scenario appends itself. The seeded base event only needs to exist as a valid, non-interfering prior retain (no merge_done, which seedHeldBranch never writes) — its own field values
    // are irrelevant here, so seeding is safe independent of the field-equivalence argument above.
    const s = await seededSetup("notip");
    const { repo, mgrId, wA, a, db, mk } = s;
    db.appendEvent({ id: randomUUID(), ts: new Date(Date.now() + 5000).toISOString(), managerSessionId: mgrId, kind: "batch_merge_branch_retained", workerSessionId: wA, taskId: a.taskId, detail: { opId: "synthetic", branch: a.branch, phase: "pre-stop" } });
    const mainBefore = git(repo, "rev-parse HEAD");
    const res = await mk({ runGate: async () => ({ passed: true }) }).confirmWorkerMerge(mgrId, wA);
    check("(no-tip) confirm REFUSES: the retain records no readable assembledTip/landedTip; main untouched", res.merged === false && /records no readable assembledTip\/landedTip/.test(res.reason ?? "") && git(repo, "rev-parse HEAD") === mainBefore);
  }
  {
    // Reads (service.ts): isBranchHeld (~21861) reads detail.assembledTip to compute `recordedTip` (~21889) and detail.landedSha (~21870) to reach findLaterBranchSquash (~21881, real call here,
    // not mocked — returns "none" since no later squash exists) ⇒ gitUnverified:false, held stays true. resolveOwedRange then re-resolves the branch's CURRENT tip via resolveBranchTip (~21903)
    // — which THIS scenario forces to fail by deleting the branch ref — ⇒ the "current tip could not be read" refusal (~21904). seedHeldBranch's assembledTip/landedSha (real git commits,
    // landedSha reachable from main's HEAD) satisfy findLaterBranchSquash's own merge-base check identically to a real writer's values; the deleted ref is what actually triggers this refusal.
    const s = await seededSetup("nolive");
    const { repo, mgrId, wA, a, mk } = s;
    git(repo, `update-ref -d refs/heads/${a.branch}`);
    const mainBefore = git(repo, "rev-parse HEAD");
    const res = await mk({ runGate: async () => ({ passed: true }) }).confirmWorkerMerge(mgrId, wA);
    check("(no-live-tip) confirm REFUSES: the branch's current tip could not be read; main untouched", res.merged === false && /current tip could not be read/.test(res.reason ?? "") && git(repo, "rev-parse HEAD") === mainBefore);
  }
  {
    // Reads (service.ts): this is resolveOwedRange's full SUCCESS path (~21896-21913: held, gitUnverified:false, base=assembledTip, tip=live branch tip, baseIsCommit && baseIsAncestor both
    // true) ⇒ owed.kind==="range" — then confirmWorkerMerge's own `!gate` check (~18925/18971) fires the "no gateCommand" refusal because THIS scenario strips `gateCommand` from the project
    // config. seedHeldBranch's assembledTip must be a genuine git ancestor of the branch's live tip for baseIsAncestor to hold — true here because liveTip is assembledTip's own child commit
    // (the late-revert commit built on top of it), the same construction the real writer's single-candidate shape produces.
    const s = await seededSetup("nogate");
    const { repo, mgrId, wA, projId, db, mk } = s;
    const cfg = db.getProject(projId).config;
    db.setProjectConfig(projId, { ...cfg, orchestration: { ...(cfg.orchestration ?? {}), gateCommand: undefined } });
    const mainBefore = git(repo, "rev-parse HEAD");
    const res = await mk().confirmWorkerMerge(mgrId, wA);
    check("(no-gate) confirm REFUSES: a held branch's late range is landed only through the gated union; main untouched", res.merged === false && /no gateCommand/.test(res.reason ?? "") && git(repo, "rev-parse HEAD") === mainBefore);
  }
} finally {
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
}
console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
