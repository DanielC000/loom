import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Merge-gate CANONICAL-UNTRACKED-OVERLAP backstop test (board card 98d6264d). REAL git on temp repos, NO
// claude and NO live daemon — drives SessionService.confirmWorkerMerge() directly, plus unit-level checks
// of detectCanonicalUntrackedOverlap/mergeBranch (mirrors merge-canonical-dirty-overlap-backstop.mjs's
// in-process style, for the sibling untracked-collision class that card's own preflight deliberately does
// not cover — its probe is `git status --porcelain --untracked-files=no`, blind to untracked paths).
//
// THE STRUCTURAL GAP THIS GUARDS (card 98d6264d, filed 2026-09-02, split out of 4b7ff996 at review):
// `detectCanonicalDirtyOverlap`'s admission-time preflight only ever sees TRACKED canonical dirt. `git
// merge --squash` ALSO refuses when the canonical repo has an UNTRACKED file on a path the branch's own
// commits touch, with a DIFFERENT git wording ("The following untracked working tree files would be
// overwritten by merge") — so that class of unmergeable branch used to burn a full build/DoD gate lane
// before failing late, exactly the shape `detectCanonicalDirtyOverlap` already exists to remove, just on a
// path it doesn't cover.
//
// 🔴 A CARD PREMISE WAS REFUTED WHILE BUILDING THIS TEST, AND THE FIX FOLLOWS THE REFUTATION, NOT THE CARD:
// the card's own DoD-3 claimed a counter-case — "the branch adds N.txt, and canonical's untracked N.txt is
// byte-identical ⇒ the merge is a no-op ... and git does NOT refuse" — mirroring
// `detectCanonicalDirtyOverlap`'s narrowing (i) for the TRACKED case. Direct repro against real git
// `2.47.0.windows.2` (both `core.autocrlf` true and explicitly false, ruling out a line-ending artifact)
// shows this is FALSE for the UNTRACKED case: `git merge --squash` refuses on an untracked collision
// REGARDLESS of content match — it errors on PATH PRESENCE alone. Scenario (B) below reproduces this
// directly and proves the implementation does NOT content-compare (which would have produced a FALSE
// NEGATIVE — silently reintroducing the exact late-failure gap this card exists to close, just for the
// identical-content subcase). The narrowing that DOES genuinely apply — verified by a SEPARATE repro,
// scenario (I) below — is existence, not content: a candidate the branch's own tip no longer carries (e.g.
// independently untracked on canonical while the branch deletes the same tracked ancestor path) is a
// real no-op, and that is this card's actual DoD-3 acceptance-bar control.
//
// Proves:
//   (A) OVERLAP, differing content — canonical repo has an UNTRACKED file (never `git add`ed) on a path the
//       branch's own commits also add, with DIFFERENT content: detectCanonicalUntrackedOverlap (unit) names
//       the overlapping path, AND confirmWorkerMerge REFUSES AT ADMISSION — BEFORE the build/DoD gate ever
//       runs (proved by a marker-writing gate command that must NOT have fired) — with a reason/detailText
//       that (i) does NOT say "Re-task a rebase", (ii) does NOT call it "unstaged" (an untracked file
//       cannot be unstaged), and (iii) DOES name the colliding path and tell the manager to escalate to the
//       Platform Lead, and leaves the untracked file on disk untouched.
//   (B) OVERLAP, BYTE-IDENTICAL content (proves the card's own claimed counter-case is FALSE, and that the
//       fix does NOT content-compare) — canonical has an untracked file on the SAME path the branch adds,
//       with the EXACT SAME content the branch would write there: detectCanonicalUntrackedOverlap →
//       overlap:true ANYWAY (git refuses regardless of content match — verified directly), AND
//       confirmWorkerMerge REFUSES AT ADMISSION exactly like (A) — the gate never runs.
//   (I) THE REAL DoD-3 NEGATIVE CONTROL (unit-level: detectCanonicalUntrackedOverlap + a DIRECT mergeBranch()
//       call, mirroring the sibling test's (D)/(G) real-git controls) — the branch DELETES a path that was
//       tracked at the fork point (so `mergeBase..branch` genuinely reports it as changed — a real
//       candidate, not an empty diff), while canonical INDEPENDENTLY untracks that SAME path (keeping the
//       file on disk): detectCanonicalUntrackedOverlap → overlap:false (the existence check excludes it —
//       the branch's tip no longer carries the path), and a DIRECT mergeBranch() call proves real git
//       actually succeeds (a genuine empty-stage no-op, not a refusal) rather than merely asserting this
//       function's own opinion — canonical's untracked file survives untouched.
//   (U) UNRELATED UNTRACKED FILE (sanity, NOT a substitute for (I)) — canonical has an untracked file on a
//       path the branch never touches at all (empty intersection by construction): confirmWorkerMerge
//       proceeds to the real gate and merges normally, and the untracked file survives untouched.
//   (C) DEFENSE-IN-DEPTH — calling mergeBranch() directly (bypassing confirmWorkerMerge's preflight) with a
//       GENUINE untracked collision still fails closed at the squash itself, with git's own
//       "would be overwritten by merge" diagnostic preserved in `reason` (the SAME backstop classifier
//       `mergeBranchLocked` already uses for the tracked case, per that function's own doc).
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-canonical-untracked-overlap-backstop.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-cuo-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree, detectCanonicalDirtyOverlap, detectCanonicalUntrackedOverlap, mergeBranch } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=cuo@loom -c user.name=cuo";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
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
  db.insertProject({ id: p.projId, name: "CUO", repoPath: p.repo, vaultPath: p.repo, config: { orchestration: { gateCommand: p.gateCommand } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: p.agentId, projectId: p.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: p.taskId, projectId: p.projId, title: "CUO-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: p.mgrId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({ id: p.workerId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: p.mgrId, taskId: p.taskId, worktreePath: p.worktreePath, branch: p.branch });
}

function initRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  tmpDirs.push(repo);
  fs.writeFileSync(path.join(repo, "unrelated.txt"), "orig-unrelated\n");
  execSync(`git init -q && git config user.email cuo@loom && git config user.name cuo && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });
}

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// ── (A) OVERLAP, differing content: canonical has untracked new.txt, branch ALSO adds new.txt ────────────
const A = {
  projId: `cuo-a-proj-${sfx}`, agentId: `cuo-a-top-${sfx}`, taskId: `cuo-a-task-${sfx}`,
  mgrId: `cuo-a-mgr-${sfx}`, workerId: `cuo-a-wkr-${sfx}`,
  repo: path.join(os.tmpdir(), `loom-cuo-a-repo-${sfx}`),
  marker: path.join(os.tmpdir(), `loom-cuo-a-marker-${sfx}.log`),
};
A.gateCommand = markerCommand(A.marker);

// ── (B) OVERLAP, BYTE-IDENTICAL content: refutes the card's own claimed counter-case ──────────────────────
const B = {
  projId: `cuo-b-proj-${sfx}`, agentId: `cuo-b-top-${sfx}`, taskId: `cuo-b-task-${sfx}`,
  mgrId: `cuo-b-mgr-${sfx}`, workerId: `cuo-b-wkr-${sfx}`,
  repo: path.join(os.tmpdir(), `loom-cuo-b-repo-${sfx}`),
  marker: path.join(os.tmpdir(), `loom-cuo-b-marker-${sfx}.log`),
};
B.gateCommand = markerCommand(B.marker);

// ── (U) UNRELATED untracked file (sanity only — NOT a substitute for (I)'s real negative control) ────────
const U = {
  projId: `cuo-u-proj-${sfx}`, agentId: `cuo-u-top-${sfx}`, taskId: `cuo-u-task-${sfx}`,
  mgrId: `cuo-u-mgr-${sfx}`, workerId: `cuo-u-wkr-${sfx}`,
  repo: path.join(os.tmpdir(), `loom-cuo-u-repo-${sfx}`),
  marker: path.join(os.tmpdir(), `loom-cuo-u-marker-${sfx}.log`),
};
U.gateCommand = markerCommand(U.marker);

async function setup(p) {
  initRepo(p.repo);
  const { worktreePath, branch } = await createWorktree(p.repo, p.projId, p.taskId);
  tmpDirs.push(worktreePath);
  fs.writeFileSync(path.join(worktreePath, "new.txt"), "worker-version\n");
  execSync(`git add . && git ${GIT_ID} commit -q -m "new.txt work"`, { cwd: worktreePath });
  p.worktreePath = worktreePath; p.branch = branch;
  seed(p);
}

try {
  await setup(A);
  await setup(B);
  await setup(U);

  // (A) untracked (never `git add`ed) collision, DIFFERING content.
  fs.writeFileSync(path.join(A.repo, "new.txt"), "LIVE UNCOMMITTED UNTRACKED CONTENT\n");
  check("(A) setup: new.txt is UNTRACKED in canonical A", /^\?\? new\.txt$/m.test(git(A.repo, "status --porcelain")));

  // (B) untracked collision, BYTE-IDENTICAL content to what the branch would write.
  fs.writeFileSync(path.join(B.repo, "new.txt"), "worker-version\n");
  check("(B) setup: new.txt is UNTRACKED in canonical B", /^\?\? new\.txt$/m.test(git(B.repo, "status --porcelain")));
  check("(B) setup: canonical's untracked content is BYTE-IDENTICAL to the branch's", readText(path.join(B.repo, "new.txt")) === readText(path.join(B.worktreePath, "new.txt")));

  fs.writeFileSync(path.join(U.repo, "someone-elses.txt"), "SOMEONE ELSE'S UNTRACKED FILE\n");
  check("(U) setup: someone-elses.txt is UNTRACKED in canonical U", /^\?\? someone-elses\.txt$/m.test(git(U.repo, "status --porcelain")));

  // ── (A) RED HALF FIRST, against TODAY's shipped detectCanonicalDirtyOverlap: its own probe
  //     (--untracked-files=no) is blind to this untracked collision, so it reports overlap:false despite
  //     the genuine collision — proving the gap this card fixes is real before trusting the new function.
  {
    const trackedOnlyProbe = await detectCanonicalDirtyOverlap(A.repo, A.branch);
    check("(A) RED: detectCanonicalDirtyOverlap (tracked-only probe) is BLIND to the untracked collision — overlap:false", trackedOnlyProbe.overlap === false);
  }

  // ── (A) unit: detectCanonicalUntrackedOverlap names the overlap ────────────────────────────────────
  const detA = await detectCanonicalUntrackedOverlap(A.repo, A.branch);
  check("(A) detectCanonicalUntrackedOverlap → overlap:true", detA.overlap === true);
  check("(A) names the overlapping path", Array.isArray(detA.paths) && detA.paths.includes("new.txt"));

  // ── (A) confirmWorkerMerge refuses AT ADMISSION — before the gate ever runs ────────────────────────
  const mainBeforeA = git(A.repo, "rev-parse HEAD");
  const confirmA = await sessions.confirmWorkerMerge(A.mgrId, A.workerId);
  check("(A) confirmWorkerMerge → merged:false", confirmA.merged === false);
  check("(A) GATE NEVER RAN — marker file absent (admission-time refusal, not a post-gate failure)", !fs.existsSync(A.marker));
  check("(A) canonical HEAD UNCHANGED", git(A.repo, "rev-parse HEAD") === mainBeforeA);
  check("(A) canonical untracked file left UNTOUCHED", readText(path.join(A.repo, "new.txt")) === "LIVE UNCOMMITTED UNTRACKED CONTENT\n");
  check("(A) reason names the overlapping path", typeof confirmA.reason === "string" && confirmA.reason.includes("new.txt"));
  check("(A) reason does NOT say 'Re-task a rebase'", !/re-task a rebase/i.test(confirmA.reason ?? ""));
  check("(A) reason tells the manager to escalate to the Platform Lead", /escalate/i.test(confirmA.reason ?? "") && /Platform Lead/i.test(confirmA.reason ?? ""));
  check("(A) detailText does NOT say 'Re-task a rebase'", !/re-task a rebase/i.test(confirmA.detailText ?? ""));
  check("(A) detailText names the untracked path", (confirmA.detailText ?? "").includes("new.txt"));
  check("(A) detailText tells the manager to escalate to the Platform Lead", /escalate/i.test(confirmA.detailText ?? "") && /Platform Lead/i.test(confirmA.detailText ?? ""));
  check("(A) detailText does NOT call it 'unstaged' (an untracked file cannot be unstaged)", !/unstaged/i.test(confirmA.detailText ?? ""));
  check("(A) assigned branch NOT deleted (worktree retained)", git(A.repo, `branch --list ${A.branch}`) !== "");
  check("(A) task NOT moved to done", db.getTask(A.taskId).columnKey !== "done");
  check("(A) a merge_rejected(reason:canonical_dirty_overlap) event recorded",
    db.listEvents(A.mgrId).some((e) => e.kind === "merge_rejected" && e.detail && e.detail.reason === "canonical_dirty_overlap"));

  // ── (B) REFUTES THE CARD'S OWN CLAIMED COUNTER-CASE: byte-identical content STILL refuses ─────────────
  const detB = await detectCanonicalUntrackedOverlap(B.repo, B.branch);
  check("(B) detectCanonicalUntrackedOverlap → overlap:true EVEN THOUGH content is byte-identical (verified real-git behavior, not the card's assumed one)", detB.overlap === true);
  check("(B) names the overlapping path", Array.isArray(detB.paths) && detB.paths.includes("new.txt"));

  const mainBeforeB = git(B.repo, "rev-parse HEAD");
  const confirmB = await sessions.confirmWorkerMerge(B.mgrId, B.workerId);
  check("(B) confirmWorkerMerge → merged:false (refuses even on identical content, matching real git)", confirmB.merged === false);
  check("(B) GATE NEVER RAN — marker file absent", !fs.existsSync(B.marker));
  check("(B) canonical HEAD UNCHANGED", git(B.repo, "rev-parse HEAD") === mainBeforeB);

  // ── (U) sanity: an unrelated untracked file never blocks an unrelated merge ────────────────────────
  const detU = await detectCanonicalUntrackedOverlap(U.repo, U.branch);
  check("(U) detectCanonicalUntrackedOverlap → overlap:false (untracked file is on an unrelated path)", detU.overlap === false);
  const confirmU = await sessions.confirmWorkerMerge(U.mgrId, U.workerId);
  check("(U) GATE DID RUN (marker present) — unrelated untracked file never blocks an unrelated merge", fs.existsSync(U.marker));
  check("(U) confirmWorkerMerge → merged:true", confirmU.merged === true);
  check("(U) canonical someone-elses.txt survives the merge untouched", readText(path.join(U.repo, "someone-elses.txt")) === "SOMEONE ELSE'S UNTRACKED FILE\n");
  check("(U) branch content landed", readText(path.join(U.repo, "new.txt")) === "worker-version\n");

  // ── (I) THE REAL DoD-3 NEGATIVE CONTROL: the branch's own tip no longer carries the colliding path ────
  // Canonical starts with a TRACKED "existing.txt". The branch (forked from that commit) DELETES it and
  // commits the deletion — so `mergeBase..branch` genuinely reports "existing.txt" as changed (a real
  // candidate, not an empty diff). Canonical INDEPENDENTLY untracks the SAME path (`git rm --cached`,
  // keeping the file on disk) — so canonical now shows it as "?? existing.txt", a real path collision with
  // the branch's own changed-path set. But the branch's TIP no longer carries "existing.txt" at all (it
  // deleted it) — so there is nothing for the squash to write there, and the existence-check narrowing
  // must exclude this candidate, matching what real git actually does (a clean no-op, not a refusal).
  {
    const repo = path.join(os.tmpdir(), `loom-cuo-i-repo-${sfx}`);
    fs.mkdirSync(repo, { recursive: true });
    tmpDirs.push(repo);
    fs.writeFileSync(path.join(repo, "unrelated.txt"), "orig-unrelated\n");
    fs.writeFileSync(path.join(repo, "existing.txt"), "tracked-content\n");
    execSync(`git init -q && git config user.email cuo@loom && git config user.name cuo && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });

    const wt = await createWorktree(repo, `cuo-i-proj-${sfx}`, `cuo-i-task-${sfx}`);
    tmpDirs.push(wt.worktreePath);
    execSync(`git rm -q existing.txt && git ${GIT_ID} commit -q -m "branch: remove existing.txt"`, { cwd: wt.worktreePath });
    check("(I) setup: branch tip no longer carries existing.txt", (() => {
      try { execSync(`git cat-file -e ${wt.branch}:existing.txt`, { cwd: repo }); return false; } catch { return true; }
    })());

    // Canonical independently untracks the SAME path (keeps the file on disk, drops it from the index) —
    // a commit AFTER the branch's fork point, so mergeBase stays the original `init` commit.
    execSync(`git rm -q --cached existing.txt && git ${GIT_ID} commit -q -m "canonical: untrack existing.txt"`, { cwd: repo });
    check("(I) setup: existing.txt is UNTRACKED in canonical, content preserved on disk", /^\?\? existing\.txt$/m.test(git(repo, "status --porcelain")) && readText(path.join(repo, "existing.txt")) === "tracked-content\n");
    const mergeBase = git(repo, `merge-base HEAD ${wt.branch}`);
    const changedPaths = git(repo, `diff --name-only ${mergeBase}..${wt.branch}`);
    check("(I) setup: existing.txt genuinely appears in mergeBase..branch (a real candidate, not an empty diff)", changedPaths.split("\n").includes("existing.txt"));

    const detI = await detectCanonicalUntrackedOverlap(repo, wt.branch);
    check("(I) detectCanonicalUntrackedOverlap → overlap:false (branch tip lacks the path — existence-check narrowing excludes it)", detI.overlap === false);

    const resI = await mergeBranch(repo, wt.branch, "Card I title");
    // A GENUINE no-op for real git (0 diff to stage: the deletion is already reflected — canonical never
    // had the path tracked to begin with by the time the squash runs), NOT a refusal — `ok:true` either
    // way, but nothing to squash means no new commit, so `sha` is correctly absent here (unlike a real
    // content merge, which always produces one).
    check("(I) mergeBranch() succeeds for real (ok:true) — git has nothing to write/remove at this path", resI.ok === true);
    check("(I) classified as a genuine empty-stage no-op, not a dirtyOverlap refusal", resI.dirtyOverlap !== true);
    check("(I) canonical's untracked existing.txt survives UNTOUCHED", readText(path.join(repo, "existing.txt")) === "tracked-content\n");
  }

  // ── (C) defense-in-depth: mergeBranch() called directly still fails closed for a genuine collision ────
  const C = { repo: path.join(os.tmpdir(), `loom-cuo-c-repo-${sfx}`) };
  initRepo(C.repo);
  const wtC = await createWorktree(C.repo, `cuo-c-proj-${sfx}`, `cuo-c-task-${sfx}`);
  tmpDirs.push(wtC.worktreePath);
  fs.writeFileSync(path.join(wtC.worktreePath, "new.txt"), "worker-version-c\n");
  execSync(`git add . && git ${GIT_ID} commit -q -m "new.txt work c"`, { cwd: wtC.worktreePath });
  fs.writeFileSync(path.join(C.repo, "new.txt"), "LIVE UNCOMMITTED UNTRACKED CONTENT C\n");
  const headCBefore = git(C.repo, "rev-parse HEAD");

  const resC = await mergeBranch(C.repo, wtC.branch, "Card C title");
  check("(C) mergeBranch() called directly still refuses (ok:false)", resC.ok === false);
  check("(C) classified dirtyOverlap:true, not the generic failure", resC.dirtyOverlap === true);
  check("(C) reason carries git's own diagnostic ('would be overwritten')", typeof resC.reason === "string" && /would be overwritten/i.test(resC.reason));
  check("(C) canonical HEAD UNCHANGED", git(C.repo, "rev-parse HEAD") === headCBefore);
  check("(C) canonical untracked file left UNTOUCHED", readText(path.join(C.repo, "new.txt")) === "LIVE UNCOMMITTED UNTRACKED CONTENT C\n");
} finally {
  db.close();
  for (const p of [A, B, U]) {
    try { fs.rmSync(p.marker, { force: true }); } catch { /* ignore */ }
  }
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a canonical path GENUINELY untracked-colliding with a branch's own touched path (whether content differs OR is byte-identical — verified: real git refuses either way, refuting this card's own assumed counter-case) is refused AT ADMISSION before the gate runs, with a remedy naming the untracked path and pointing at the Platform Lead instead of a useless rebase, correctly worded as 'untracked' rather than 'unstaged'; the REAL negative control — a candidate the branch's own tip no longer carries — does NOT false-refuse, verified against what real git actually does; and mergeBranch() itself still fails closed and diagnosably for a genuine collision if this ever races past the preflight."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
