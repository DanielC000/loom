import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card e41dbb58 — `GitWriter.commit()`/`checkout()`/`createBranch()` (git/writer.ts) write the SAME
// canonical repo index `mergeBranchLocked` (git/worktrees.ts) squash-merges against, but were NOT admitted
// through the per-repo merge mutex (card e076d2a2 / commit efeddcd) — the mutex serialized `mergeBranch`
// against `mergeBranch` only, an invariant attached to one CALLER instead of the INDEX it protects.
//
// SCENARIO 1 — GitWriter.commit() interleaved with an in-progress merge.
//
// THE BUG (verified against real, unmodified pre-fix `git/writer.ts` + `git/worktrees.ts` before this test
// was written, by instrumenting the compiled dist with timestamped tracing around each git call): a
// `GitWriter.commit()` call interleaved with an in-progress merge — specifically, fired AFTER
// `mergeBranchLocked`'s own `git merge --squash` has staged the branch's diff but BEFORE its own
// `git commit` (delayed here by a real, slow pre-commit hook, exactly like test/merge-hang-does-not-
// wedge-queue.mjs) has landed it — runs immediately (no lock check), sees the ALREADY-STAGED squash diff,
// and lands it under ITS OWN unrelated message with NO `Loom-Worker-Branch` trailer, well before the
// merge's own delayed commit resumes. **Worse than a clean failure**: once the merge's own delayed
// `git commit` finally resumes (its pre-commit hook wakes), the working tree is now clean relative to the
// NEW HEAD the writer just created — so its `git commit` genuinely creates NO new commit — but `simple-git`'s
// `raw()` doesn't reliably surface that as a thrown error (the exit-code handling this codebase's own
// `isBranchMerged` comment already flags as "unreliable"), so `mergeBranchLocked` never enters its
// commit-failure catch path at all. It just does `git rev-parse HEAD` next and reports `{ok:true, sha,
// subject}` — a **silent false success**: `sha` is actually the WRITER's stray, trailer-less commit, and
// `subject` is the merge's OWN intended subject, but neither is true of what's actually at that sha. The
// branch's content is on main, permanently untraceable (no trailer), while the merge layer confidently
// reports having landed it correctly. Reproduced with no artificial delays beyond the hook used to widen
// the interleaving window.
//
// SCENARIO 2 — GitWriter.createBranch() interleaved with an in-progress merge.
//
// THE BUG: `createBranch()` calls `git checkout -b <name>` — a plain checkout carries a staged-but-
// uncommitted diff forward onto the newly created branch WITHOUT conflict (verified directly against real
// git: `git checkout -b` never refuses over staged content when the new branch starts at the SAME commit
// HEAD already points to). If this lands mid-merge — after `mergeBranchLocked` has staged its squash but
// before its own delayed `git commit` runs — canonical HEAD now points at the freshly-created branch, so
// the merge's own commit (once its hook-delayed child resumes) lands the squash onto THAT branch instead
// of the mainline. The mainline branch silently never receives the work, while `mergeBranchLocked` still
// reads `git rev-parse HEAD` and reports `{ok:true, sha, subject}` — a false success pointing at a sha
// that is reachable from the new branch, not from the mainline branch the merge believes it landed on.
//
// THE FIX: `GitWriter.commit`/`checkout`/`createBranch` are now admitted through the SAME
// `withCanonicalIndexLock` (git/repo-lock.ts) `mergeBranchLocked` uses, keyed on the canonicalized repo
// path — so a `GitWriter` call interleaved with an in-progress merge QUEUES behind it instead of racing it.
//
// Both scenarios are RED against the pre-fix code (the writer/createBranch call steals or diverts the
// branch's staged content) and GREEN once GitWriter is admitted through the shared lock.
// Run: 1) build daemon (pnpm build), 2) node test/merge-writer-index-lock.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const distGitDir = path.join(process.cwd(), "dist", "git");
const { mergeBranch } = await import(pathToFileURL(path.join(distGitDir, "worktrees.js")).href);
const { GitWriter } = await import(pathToFileURL(path.join(distGitDir, "writer.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mwil@loom -c user.name=mwil";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();

const HOOK_SLEEP_S = 3; // long enough that the interleaved writer call unambiguously fires WHILE the
                         // merge's own commit is still blocked in the hook; short enough to keep the test
                         // fast and to let an orphaned hook process (if ever killed mid-sleep) self-exit
                         // quickly.
const WRITER_FIRE_DELAY_MS = 600; // fired well after the squash has staged (near-instant) but well before
                                   // the hook's sleep ends.
const GUARD_MS = 15_000; // this TEST's own patience — comfortably above HOOK_SLEEP_S so a genuinely fixed
                          // (queued) run has time to settle, comfortably bounded so a wedge can't hang CI.

const tmpDirs = [];

function makeRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-mwil-repo-${tag}`);
  fs.mkdirSync(repo, { recursive: true });
  tmpDirs.push(repo);
  execSync(`git init -q && git config user.email mwil@loom && git config user.name mwil && git add -A && git ${GIT_ID} commit -q -m init --allow-empty`, { cwd: repo });
  return repo;
}

function makeWorktree(repo, branch, file, content, tag) {
  const wt = path.join(os.tmpdir(), `loom-mwil-wt-${branch.replace(/\//g, "-")}-${tag}`);
  tmpDirs.push(wt);
  execSync(`git worktree add -q -b ${branch} "${wt}" HEAD`, { cwd: repo });
  fs.writeFileSync(path.join(wt, file), content);
  execSync(`git add -A && git ${GIT_ID} commit -q -m "${branch} work"`, { cwd: wt });
  return wt;
}

// ONE-SHOT hanging pre-commit hook — same marker-gated shape as merge-hang-does-not-wedge-queue.mjs so
// only the FIRST `git commit` against this repo ever blocks; any later commit (the merge's own, once it
// finally proceeds, or the writer's queued one post-fix) passes through instantly.
function installHangingHook(repo) {
  const hookPath = path.join(repo, ".git", "hooks", "pre-commit");
  fs.writeFileSync(hookPath, `#!/bin/sh\nif [ -f .git/hang-fired ]; then\n  exit 0\nfi\ntouch .git/hang-fired\nsleep ${HOOK_SLEEP_S}\n`);
  fs.chmodSync(hookPath, 0o755);
}

const guard = (ms, label) => new Promise((resolve) => setTimeout(() => resolve({ __guardFired: label }), ms));

async function scenarioWriterCommit(tag) {
  const repo = makeRepo(tag);
  const branch = "loom/steal-test";
  makeWorktree(repo, branch, "file-a.txt", `branch-content-${tag}\n`, tag);
  installHangingHook(repo);

  // Fire the merge — its own `git commit` (landing the squash under `subject` + the trailer) will hit the
  // hanging hook and block for HOOK_SLEEP_S.
  const mergePromise = mergeBranch(repo, branch, "Steal Test Card");

  // Fire the writer's commit WHILE the merge's own commit is still blocked in the hook — the branch's
  // diff is already staged (the squash itself is fast, well under WRITER_FIRE_DELAY_MS) but not yet
  // committed by the merge.
  await new Promise((r) => setTimeout(r, WRITER_FIRE_DELAY_MS));
  const writer = new GitWriter(repo);
  const writerPromise = writer.commit("stray edit landing mid-merge");

  const [mergeResult, writerResult] = await Promise.all([
    Promise.race([mergePromise, guard(GUARD_MS, "merge")]),
    Promise.race([writerPromise, guard(GUARD_MS, "writer")]),
  ]);

  check("[scenario 1] [guard] the merge settled within the test's patience window (not wedged)", mergeResult?.__guardFired !== "merge");
  check("[scenario 1] [guard] the writer's commit settled within the test's patience window (not wedged)", writerResult?.__guardFired !== "writer");

  // ── The properties that must hold regardless of ordering, once GitWriter is admitted through the same
  //    lock: the merge itself succeeds, lands the branch's own content under its OWN trailer, and the
  //    writer — having queued behind it — finds nothing left to steal (a clean "nothing to commit").
  check("[scenario 1] the merge itself succeeds (not pre-empted / raced out by the writer)", mergeResult?.ok === true);
  check("[scenario 1] the merge produced a sha", typeof mergeResult?.sha === "string" && mergeResult.sha.length > 0);
  // The false-success signature this bug actually produces: mergeBranch can report {ok:true, sha,
  // subject} while `sha` is really the WRITER's stray commit — a commit whose OWN message does not match
  // the reported `subject` at all. Check this directly, not just "a trailer commit exists somewhere".
  if (mergeResult?.ok === true && mergeResult.sha) {
    const shaSubject = execSync(`git --no-pager log -1 --format=%s ${mergeResult.sha}`, { cwd: repo }).toString().trim();
    check(
      "[scenario 1] the commit at the sha mergeBranch reports actually carries the subject mergeBranch reports " +
      "(not a false success pointing at an unrelated writer commit)",
      shaSubject === mergeResult.subject,
    );
  }

  const log = git(repo, "--no-pager log --format=%H");
  const shas = log.split("\n").filter(Boolean);
  let trailerFound = false;
  for (const sha of shas) {
    const msg = execSync(`git --no-pager log -1 --format=%B ${sha}`, { cwd: repo }).toString();
    if (!/^Loom-Worker-Branch:\s*loom\/steal-test\s*$/m.test(msg)) continue;
    trailerFound = true;
    let content;
    try { content = execSync(`git show ${sha}:file-a.txt`, { cwd: repo }).toString(); } catch { content = null; }
    check("[scenario 1] the trailer commit contains the branch's OWN file", content !== null);
    check("[scenario 1] the trailer commit's content matches the branch's own tip (not swapped/absorbed)", content === `branch-content-${tag}\n`);
  }
  check("[scenario 1] a commit carrying the branch's Loom-Worker-Branch trailer exists in history", trailerFound);

  check(
    "[scenario 1] the writer's commit(), having queued behind the merge, found nothing left to steal " +
    "(clean 'nothing to commit' — NOT a stray commit absorbing the branch's staged diff)",
    writerResult?.ok === false && /nothing to commit/i.test(writerResult?.error ?? ""),
  );
  check(
    "[scenario 1] no stray commit bearing the writer's own unrelated message ever landed in history",
    !log.split("\n").some((sha) => {
      if (!sha) return false;
      const subj = execSync(`git --no-pager log -1 --format=%s ${sha}`, { cwd: repo }).toString().trim();
      return subj === "stray edit landing mid-merge";
    }),
  );
}

async function scenarioCreateBranch(tag) {
  const repo = makeRepo(tag);
  const mainlineBranch = git(repo, "rev-parse --abbrev-ref HEAD");
  const branch = "loom/divert-test";
  makeWorktree(repo, branch, "file-a.txt", `branch-content-${tag}\n`, tag);
  installHangingHook(repo);

  // Fire the merge — its own `git commit` will hit the hanging hook and block for HOOK_SLEEP_S, leaving
  // the squash staged (but not committed) on the mainline branch's current checkout.
  const mergePromise = mergeBranch(repo, branch, "Divert Test Card");

  // Fire createBranch() WHILE the merge's own commit is still blocked in the hook — this moves canonical
  // HEAD to a brand-new branch pointing at the SAME commit, carrying the staged squash diff onto it.
  await new Promise((r) => setTimeout(r, WRITER_FIRE_DELAY_MS));
  const writer = new GitWriter(repo);
  const createBranchPromise = writer.createBranch("stray-branch-created-mid-merge");

  const [mergeResult, createBranchResult] = await Promise.all([
    Promise.race([mergePromise, guard(GUARD_MS, "merge")]),
    Promise.race([createBranchPromise, guard(GUARD_MS, "createBranch")]),
  ]);

  check("[scenario 2] [guard] the merge settled within the test's patience window (not wedged)", mergeResult?.__guardFired !== "merge");
  check("[scenario 2] [guard] createBranch() settled within the test's patience window (not wedged)", createBranchResult?.__guardFired !== "createBranch");

  check("[scenario 2] the merge itself succeeds", mergeResult?.ok === true);
  check("[scenario 2] the merge produced a sha", typeof mergeResult?.sha === "string" && mergeResult.sha.length > 0);

  if (mergeResult?.ok === true && mergeResult.sha) {
    // The false-success signature this bug produces: mergeBranch reports a sha that isn't actually
    // reachable from the mainline branch it believes it merged onto (it landed on the diverted branch
    // `checkout -b` created instead). Check reachability from the MAINLINE branch directly.
    let reachableFromMainline = false;
    try {
      execSync(`git merge-base --is-ancestor ${mergeResult.sha} ${mainlineBranch}`, { cwd: repo });
      reachableFromMainline = true;
    } catch { reachableFromMainline = false; }
    check(
      "[scenario 2] the sha mergeBranch reports is reachable from the MAINLINE branch " +
      "(not diverted onto a branch createBranch() created mid-merge)",
      reachableFromMainline,
    );
  }

  check(
    "[scenario 2] the mainline branch's own tip carries the branch's Loom-Worker-Branch trailer",
    /^Loom-Worker-Branch:\s*loom\/divert-test\s*$/m.test(execSync(`git --no-pager log -1 --format=%B ${mainlineBranch}`, { cwd: repo }).toString()),
  );
  check(
    "[scenario 2] the mainline branch's tip contains the branch's OWN file with the correct content",
    (() => {
      try { return execSync(`git show ${mainlineBranch}:file-a.txt`, { cwd: repo }).toString() === `branch-content-${tag}\n`; }
      catch { return false; }
    })(),
  );
}

try {
  await scenarioWriterCommit(`commit-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  await scenarioCreateBranch(`createbranch-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
} finally {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a GitWriter.commit()/createBranch() call interleaved with an in-progress merge queues behind the shared canonical-index lock instead of absorbing or diverting the merge's staged content."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
