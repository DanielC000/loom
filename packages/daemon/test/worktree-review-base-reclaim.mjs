import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 37fe091c: boot-reconcile Pass B's `worktreeHasWork` call hardcoded `"HEAD"` as the comparison base
// for EVERY session, including a REVIEW spawn whose branch is cut from the REVIEWED branch's tip
// (`createWorktree`'s `forkFrom` param) — so a reviewer who authored zero commits always read as "ahead
// of base" (counting commits it only ever INHERITED) and was kept forever. The fix: `worktreeHasWork`'s
// base is now `workerBaseRef(session.reviewBaseSha)`, mirroring `precheckWorkerDone`'s already-shipped
// pattern (card b866ab64) instead of recomputing the fallback inline a second, inconsistent way.
//
// Eight scenarios, all against ONE real repo/project, REAL git, a temp LOOM_HOME, NO claude + NO live
// daemon:
//   (a) review-spawn worktree, reviewBaseSha set, clean, 0 own commits beyond it       ⇒ RECLAIMED
//   (b) same, PLUS one real uncommitted file                                           ⇒ KEPT (dirty-tree)
//   (c) same, PLUS one real commit beyond reviewBaseSha                                ⇒ KEPT (unmerged-commits)
//   (d) a NON-review worker (reviewBaseSha null) ahead of main                         ⇒ KEPT (byte-identical to before this fix)
//   (e) reviewBaseSha pointing at an UNRESOLVABLE sha                                  ⇒ KEPT (fail-safe — a
//       probe that can't resolve its own comparison base must never be read as "no work")
//   (f) ALIASING (CR round 2): a review spawn whose taskId/reviewOf* alias an existing author
//       worktree/branch ⇒ the AUTHOR's work SURVIVES.
//   (g) REATTACH (round 3, test gap): a worktree dir removed but its branch survives, then re-created
//       WITH forkFrom passed again ⇒ createWorktree must still report forkedFromReviewed:false — forkFrom
//       is never consulted once the branch already exists.
//   (h) LEGACY RESIDUAL (round 3, REQUIRED): a lone TASKED row carrying a (legacy, pre-round-2-fix)
//       reviewBaseSha equal to its own current tip, with no sibling author row left to disagree ⇒ KEPT
//       — Pass B must never trust a TASKED row's reviewBaseSha, only a TASKLESS row's.
//
// Run: 1) build daemon, 2) node test/worktree-review-base-reclaim.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-wrbr-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree, reviewBaseShaToStamp } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=wrbr@loom -c user.name=wrbr";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

const repo = path.join(os.tmpdir(), `loom-wrbr-repo-${sfx}`);
const projId = `wrbr-proj-${sfx}`;
const agentId = `wrbr-agent-${sfx}`;
const mgrId = `wrbr-mgr-${sfx}`;

const db = new Db();
const sessions = new SessionService(db, {}, new OrchestrationControl());

const cleanupPaths = []; // every worktree dir this test creates, removed in `finally` regardless of outcome

let nextTaskSeq = 0;
function newTaskId(tag) { return `wrbr-task-${tag}-${sfx}-${nextTaskSeq++}`; }

/** A "reviewed" worker's own worktree: real createWorktree, one real commit. No DB session row for it —
 *  Pass B only ever acts on rows it's given, and this test only cares about the REVIEWER's fate. Returns
 *  the reviewed branch name + its tip sha (what a real review spawn's `reviewBaseSha` would be stamped to). */
async function makeReviewedBranch(tag) {
  const taskId = newTaskId(`reviewed-${tag}`);
  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  cleanupPaths.push(worktreePath);
  fs.writeFileSync(path.join(worktreePath, `${tag}.txt`), `real reviewed work (${tag})\n`);
  commitAll(worktreePath, `reviewed work ${tag}`, GIT_ID);
  const tip = execSync("git rev-parse HEAD", { cwd: worktreePath }).toString().trim();
  return { branch, tip };
}

/** A reviewer's worktree, forked from `reviewedBranch`'s tip via createWorktree's own `forkFrom` param —
 *  the EXACT mechanism a real `reviewOfWorkerSessionId`/`reviewOfTaskId` spawn uses. Returns
 *  `forkedFromReviewed` too, so a caller can assert the genuine fresh-cut case stamps `true` (round 3
 *  test gap: this positive case went unasserted — see the file header's scenario (g) for its negative
 *  twin). */
async function makeReviewerWorktree(tag, reviewedBranch) {
  const taskId = newTaskId(`reviewer-${tag}`);
  const { worktreePath, branch, forkedFromReviewed } = await createWorktree(repo, projId, taskId, {}, undefined, reviewedBranch);
  cleanupPaths.push(worktreePath);
  return { worktreePath, branch, taskId, forkedFromReviewed };
}

function seedSession(sessionId, taskId, worktreePath, branch, reviewBaseSha) {
  // Round 3: a real review spawn is TASKLESS by convention (spawnWorker's own doc) — Pass B's
  // taskless gate reads Session.taskId, never the string createWorktree was called with (that's only
  // used for worktree/branch naming). A caller modeling a genuine review spawn must pass taskId:null
  // here; only the (f)/(h)-style TASKED scenarios pass a real one.
  if (taskId != null) {
    db.insertTask({ id: taskId, projectId: projId, title: "WRBR-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  }
  db.insertSession({
    id: sessionId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath,
    processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch, reviewBaseSha,
  });
}

try {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# wrbr\n");
  execSync("git init -q", { cwd: repo });
  commitAll(repo, "init", GIT_ID);

  db.insertProject({ id: projId, name: `WRBR-${sfx}`, repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

  // ── (a) review-spawn, clean, 0 own commits ⇒ RECLAIMED ──────────────────────────────────────────────
  const reviewedA = await makeReviewedBranch("a");
  const reviewerA = await makeReviewerWorktree("a", reviewedA.branch);
  const reviewerASessionId = `wrbr-wkr-a-${sfx}`;
  // taskId:null — a genuine review spawn is TASKLESS by convention; reviewerA.taskId is only the string
  // createWorktree was called with (worktree/branch naming), never what a real spawn stores on the row.
  seedSession(reviewerASessionId, null, reviewerA.worktreePath, reviewerA.branch, reviewedA.tip);

  // ── (b) review-spawn, PLUS one real uncommitted file ⇒ KEPT (dirty-tree) ────────────────────────────
  const reviewedB = await makeReviewedBranch("b");
  const reviewerB = await makeReviewerWorktree("b", reviewedB.branch);
  fs.writeFileSync(path.join(reviewerB.worktreePath, "review-notes.txt"), "uncommitted review notes\n");
  const reviewerBSessionId = `wrbr-wkr-b-${sfx}`;
  seedSession(reviewerBSessionId, null, reviewerB.worktreePath, reviewerB.branch, reviewedB.tip); // taskless, see (a)'s note

  // ── (c) review-spawn, PLUS one real commit beyond reviewBaseSha ⇒ KEPT (unmerged-commits) ───────────
  const reviewedC = await makeReviewedBranch("c");
  const reviewerC = await makeReviewerWorktree("c", reviewedC.branch);
  fs.writeFileSync(path.join(reviewerC.worktreePath, "review-fix.txt"), "a real reviewer-authored commit\n");
  commitAll(reviewerC.worktreePath, "reviewer's own commit", GIT_ID);
  const reviewerCSessionId = `wrbr-wkr-c-${sfx}`;
  seedSession(reviewerCSessionId, null, reviewerC.worktreePath, reviewerC.branch, reviewedC.tip); // taskless, see (a)'s note

  // ── (d) NON-review worker (reviewBaseSha null), ahead of main ⇒ KEPT, unchanged ─────────────────────
  const taskD = newTaskId("plain-d");
  const { worktreePath: wtD, branch: branchD } = await createWorktree(repo, projId, taskD);
  cleanupPaths.push(wtD);
  fs.writeFileSync(path.join(wtD, "plain.txt"), "ordinary worker's own commit\n");
  commitAll(wtD, "plain work", GIT_ID);
  const workerDSessionId = `wrbr-wkr-d-${sfx}`;
  seedSession(workerDSessionId, taskD, wtD, branchD, null);

  // ── (e) reviewBaseSha pointing at an UNRESOLVABLE sha ⇒ KEPT, fail-safe ─────────────────────────────
  const taskE = newTaskId("unresolvable-e");
  const { worktreePath: wtE, branch: branchE } = await createWorktree(repo, projId, taskE); // fresh off main HEAD, 0 own commits, clean
  cleanupPaths.push(wtE);
  const bogusSha = "f".repeat(40); // well-formed 40-hex sha, never an object in this repo
  const workerESessionId = `wrbr-wkr-e-${sfx}`;
  // taskless, see (a)'s note — a reviewBaseSha-bearing row is a review spawn by convention, and the
  // taskless gate must actually let this row's (corrupted) reviewBaseSha reach workerBaseRef for the
  // fail-safe to be exercised at all; a tasked row would never even consult it.
  seedSession(workerESessionId, null, wtE, branchE, bogusSha);

  // ── (f) ALIASING (card 37fe091c, CR round 2, BLOCKING): a review spawn whose taskId/reviewOf* alias an
  //    EXISTING author worktree/branch makes createWorktree silently take the reuse/reattach path — the
  //    AUTHOR's real unmerged work must survive regardless. ──────────────────────────────────────────────
  const taskF = newTaskId("author-f");
  const { worktreePath: wtF, branch: branchF } = await createWorktree(repo, projId, taskF); // author's own worktree
  cleanupPaths.push(wtF);
  fs.writeFileSync(path.join(wtF, "author-work.txt"), "the author's real unmerged commit\n");
  commitAll(wtF, "author work", GIT_ID);
  const authorTip = execSync("git rev-parse HEAD", { cwd: wtF }).toString().trim();
  const authorSessionId = `wrbr-wkr-f-author-${sfx}`;
  seedSession(authorSessionId, taskF, wtF, branchF, null); // the author's OWN row: no review base

  // The aliased "review of my own task" spawn: SAME taskId (so createWorktree resolves to the SAME
  // path/branch) + forkFrom = the author's own branch. This calls the REAL createWorktree and the REAL
  // reviewBaseShaToStamp (the exact function spawnWorker itself calls) — not a hand-copied approximation
  // — so whatever this computes is exactly what a real aliased spawn would have stamped.
  const { forkedFromReviewed: aliasedForkedFromReviewed } = await createWorktree(repo, projId, taskF, {}, undefined, branchF);
  const aliasedReviewBaseSha = reviewBaseShaToStamp(aliasedForkedFromReviewed, authorTip);
  const reviewerSessionId = `wrbr-wkr-f-reviewer-${sfx}`;
  // NEWER lastActivity than the author's row — listAllSessionsIncludingArchived orders newest-first, so
  // this is the row boot-reconcile's Pass B visits FIRST for this shared path (matches the CR's own
  // description of the incident: "Pass B decides each path once, newest row first").
  db.insertSession({
    id: reviewerSessionId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: wtF,
    processState: "exited", resumability: "unknown", busy: false, createdAt: now,
    lastActivity: new Date(Date.now() + 1000).toISOString(), lastError: null, role: "worker",
    parentSessionId: mgrId, taskId: taskF, worktreePath: wtF, branch: branchF, reviewBaseSha: aliasedReviewBaseSha,
  });

  // ── (g) REATTACH (round 3, test gap): remove a worktree DIR but keep its branch, then re-create it
  //    WITH forkFrom passed — createWorktree must take the REATTACH path (branch already exists) and
  //    report forkedFromReviewed:false, never consulting forkFrom. No DB session row needed — this
  //    scenario asserts only createWorktree's own return value, not a boot-reconcile outcome. ───────────
  const taskG = newTaskId("reattach-g");
  const first = await createWorktree(repo, projId, taskG); // fresh cut, no forkFrom
  cleanupPaths.push(first.worktreePath);
  fs.rmSync(first.worktreePath, { recursive: true, force: true }); // dir gone; branch ref survives
  const reattached = await createWorktree(repo, projId, taskG, {}, undefined, reviewedA.branch); // forkFrom passed again
  cleanupPaths.push(reattached.worktreePath);

  // ── (h) LEGACY RESIDUAL (round 3, REQUIRED): a lone TASKED row carrying a (legacy, pre-round-2-fix)
  //    reviewBaseSha equal to its OWN current tip, with no sibling author row left to disagree (the real
  //    case: the author's own row was hard-deleted) — must still be KEPT, because Pass B must never trust
  //    a TASKED row's reviewBaseSha at all (only a TASKLESS row's path can never be aliased). ────────────
  const taskH = newTaskId("legacy-h");
  const { worktreePath: wtH, branch: branchH } = await createWorktree(repo, projId, taskH);
  cleanupPaths.push(wtH);
  fs.writeFileSync(path.join(wtH, "author-work-h.txt"), "the author's real unmerged commit (legacy)\n");
  commitAll(wtH, "legacy author work", GIT_ID);
  const legacyTipH = execSync("git rev-parse HEAD", { cwd: wtH }).toString().trim();
  const legacySessionId = `wrbr-wkr-h-${sfx}`;
  // Simulates the pre-round-2-fix bad stamp: reviewBaseSha === this row's OWN current tip, so a naive
  // "trust any tasked row's reviewBaseSha" base comparison would read 0-ahead and wrongly reclaim it.
  seedSession(legacySessionId, taskH, wtH, branchH, legacyTipH);

  // ── Run the real boot-reconcile (no protected sessions — everything here is "exited") ───────────────
  const r = await sessions.reconcileOrchestrationOnBoot(new Set());

  check("(a) reviewer's worktree with 0 own commits was RECLAIMED", !fs.existsSync(reviewerA.worktreePath));
  check("(a) reconcile's worktreesReviewForkReclaimed counts (a)'s reclaim", r.worktreesReviewForkReclaimed >= 1);
  check("(a) POSITIVE CASE (round 3 test gap) — the genuine fresh -b branch forkFrom cut reports forkedFromReviewed===true", reviewerA.forkedFromReviewed === true);

  check("(b) reviewer's worktree with a real uncommitted file was KEPT", fs.existsSync(reviewerB.worktreePath));
  check("(c) reviewer's worktree with a real own commit was KEPT", fs.existsSync(reviewerC.worktreePath));
  check("(d) the ordinary (non-review) worker's worktree was KEPT, unchanged", fs.existsSync(wtD));
  check("(e) the unresolvable-reviewBaseSha worktree was KEPT (fail-safe)", fs.existsSync(wtE));
  check("(f) ALIASING — createWorktree's second (aliasing) call correctly reports forkedFromReviewed=false", aliasedForkedFromReviewed === false);
  check("(f) ALIASING — reviewBaseShaToStamp correctly refused to stamp (null) for the aliased call", aliasedReviewBaseSha === null);
  check("(f) ALIASING — the AUTHOR's worktree with a real unmerged commit SURVIVES the aliased reviewer row", fs.existsSync(wtF));

  check("(g) REATTACH (round 3 test gap) — a dir removed but its branch survived, re-created with forkFrom, reports forkedFromReviewed===false (forkFrom never consulted)", reattached.forkedFromReviewed === false);
  check("(g) REATTACH — the branch name is unchanged across the reattach", reattached.branch === first.branch);
  check("(g) REATTACH — the worktree dir exists again after reattach", fs.existsSync(reattached.worktreePath));

  check("(h) LEGACY RESIDUAL — a lone tasked row's (legacy) reviewBaseSha is never trusted; the branch's real unmerged commit vs mainline HEAD keeps it", fs.existsSync(wtH));

  // ── Cross-check against the retained-worktree backlog surface: reason + commitsAhead must be derived
  //    against each session's OWN real base, not mainline HEAD, and reviewBaseSha must be surfaced. ────
  const { entries } = await sessions.getRetainedWorktrees();
  const byId = new Map(entries.map((e) => [e.sessionId, e]));

  const b = byId.get(reviewerBSessionId);
  check("(b) retained-backlog entry PRESENT", !!b);
  if (b) {
    check("(b) reason=dirty-tree", b.reason === "dirty-tree");
    check("(b) reviewBaseSha surfaced on the entry", b.reviewBaseSha === reviewedB.tip);
  }

  const c = byId.get(reviewerCSessionId);
  check("(c) retained-backlog entry PRESENT", !!c);
  if (c) {
    check("(c) reason=unmerged-commits", c.reason === "unmerged-commits");
    // THE discriminating assertion: commitsAhead must be the reviewer's OWN 1 commit beyond reviewBaseSha,
    // never the (much larger, if the reviewed branch had more history) count against mainline HEAD.
    check(`(c) commitsAhead === 1 (the reviewer's own commit, measured against reviewBaseSha — got ${c.commitsAhead})`, c.commitsAhead === 1);
    check("(c) reviewBaseSha surfaced on the entry", c.reviewBaseSha === reviewedC.tip);
  }

  const d = byId.get(workerDSessionId);
  check("(d) retained-backlog entry PRESENT", !!d);
  if (d) {
    check("(d) reason=unmerged-commits", d.reason === "unmerged-commits");
    check(`(d) commitsAhead === 1 (ordinary worker's own commit, measured against mainline HEAD — got ${d.commitsAhead})`, d.commitsAhead === 1);
    check("(d) reviewBaseSha is null (non-review)", d.reviewBaseSha === null);
  }

  const e = byId.get(workerESessionId);
  check("(e) retained-backlog entry PRESENT", !!e);
  if (e) {
    // The probe itself fails (bad revision) — commitsAhead must read as unknown (null), never a fabricated 0.
    check(`(e) commitsAhead is null (the probe against an unresolvable base failed — got ${e.commitsAhead})`, e.commitsAhead === null);
  }

  // Pass B's loop visits the NEWEST row first (the reviewer row) and claims the path under it — the
  // consensus fix overrides ONLY the reviewBaseSha used for the base/display, never which row's other
  // fields (sessionId/branch/taskId) represent the path in the retained-backlog entry.
  const f = byId.get(reviewerSessionId);
  check("(f) ALIASING — retained-backlog entry PRESENT (the author's real work is still visible, not silently dropped)", !!f);
  if (f) {
    check("(f) ALIASING — reason=unmerged-commits (the author's real commit, correctly NOT read as clean)", f.reason === "unmerged-commits");
    check(`(f) ALIASING — commitsAhead === 1, measured against mainline HEAD (consensus fell back to HEAD, not the aliased stamp) — got ${f.commitsAhead}`, f.commitsAhead === 1);
    check("(f) ALIASING — reviewBaseSha on the entry is null (consensus disagreement ⇒ HEAD, not the aliased sha)", f.reviewBaseSha === null);
  }

  const h = byId.get(legacySessionId);
  check("(h) LEGACY RESIDUAL — retained-backlog entry PRESENT", !!h);
  if (h) {
    check("(h) LEGACY RESIDUAL — reason=unmerged-commits (the real commit, correctly NOT read as clean)", h.reason === "unmerged-commits");
    check(`(h) LEGACY RESIDUAL — commitsAhead === 1, measured against mainline HEAD, NEVER the lone tasked row's own (legacy, self-equal) reviewBaseSha stamp (which would read 0) — got ${h.commitsAhead}`, h.commitsAhead === 1);
    check("(h) LEGACY RESIDUAL — reviewBaseSha on the entry is null (a TASKED row's reviewBaseSha is never trusted, regardless of consensus)", h.reviewBaseSha === null);
  }
} finally {
  db.close();
  for (const p of cleanupPaths) {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — boot-reconcile Pass B now measures a worker's OWN ahead-of-base work against its real base (workerBaseRef(reviewBaseSha)), reclaiming a zero-added-commit review spawn that the old hardcoded-HEAD comparison kept forever, while a dirty review worktree, a review worktree with a real own commit, an ordinary worker, an unresolvable reviewBaseSha, an aliased review spawn's author worktree, a reattached branch (forkFrom ignored), and a lone legacy tasked row's reviewBaseSha all still KEEP (or correctly report forkedFromReviewed) exactly as before."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
