import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// CANONICAL INDEX.LOCK — DETECT AND REFUSE (card 62c4953a).
//
// THE INCIDENT: a 0-byte `.git/index.lock` was found abandoned in the canonical Loom repo for ~4h20m, with
// no git process alive and nothing having signalled it. The next `worker_merge_confirm` failed with a
// generic, buried message ("git merge --squash failed (reset --hard (rawError cleanup) failed —
// canonical repo may have residue: fatal: Unable to create '.git/index.lock': File exists"), not a loud,
// actionable one naming the lock itself.
//
// THE FIX: `withCanonicalIndexLock` (git/repo-lock.ts) — the TRUE convergence point every canonical-index
// writer already routes through (same chokepoint the quarantine check lives at) — now ALSO checks for a
// real `.git/index.lock` immediately after acquiring the lock, throwing `CanonicalIndexLockPresentError`
// with a reason naming the lock's path, size, and mtime age, plus a best-effort liveness signal. NO
// auto-removal (owner ruling) — detect and refuse only.
//
// This file proves: (1) the refusal fires, with the named reason, against a real stale lock, and leaves
// the canonical repo untouched; (2) there is no refusal when no lock is present; (3) the SAME real lock
// file no longer blocks the SAME call once removed (the control every scenario below ends with).
//
// Run: 1) build daemon (pnpm build), 2) node test/canonical-index-lock-refusal.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-cilr-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const { mergeBranch, createWorktree } = await import(pathToFileURL(path.join(distGitDir, "worktrees.js")).href);
const { fastForwardCanonicalMain } = await import(pathToFileURL(path.join(distGitDir, "batch-merge.js")).href);
const { GitWriter } = await import(pathToFileURL(path.join(distGitDir, "writer.js")).href);
const { checkCanonicalIndexLockNotPresent, withCanonicalIndexLock, CanonicalIndexLockPresentError } =
  await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=cilr@loom -c user.name=cilr";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const tmpDirs = [];

function makeRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-cilr-${tag}-${sfx}`);
  fs.mkdirSync(repo, { recursive: true });
  tmpDirs.push(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "# canonical-index-lock-refusal\n");
  execSync(`git init -q && git config user.email cilr@loom && git config user.name cilr`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  execSync(`git branch other-branch`, { cwd: repo });
  return repo;
}

/** Plants a real, 0-byte `.git/index.lock` directly at the real on-disk path — never a shortcut via a
 *  real `git` call racing to hold it (this must be deterministic, not timing-dependent). */
function plantIndexLock(repo) {
  const lockPath = path.join(repo, ".git", "index.lock");
  fs.writeFileSync(lockPath, "");
  return lockPath;
}

try {
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // checkCanonicalIndexLockNotPresent — unit-level proof, no lock present
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const repo = makeRepo("unit-no-lock");
    const res = await checkCanonicalIndexLockNotPresent(repo);
    check("(unit, no lock) returns ok:true", res.ok === true);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // checkCanonicalIndexLockNotPresent — unit-level proof, a real stale lock present
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const repo = makeRepo("unit-lock");
    const lockPath = plantIndexLock(repo);
    const res = await checkCanonicalIndexLockNotPresent(repo);
    check("(unit, stale lock) returns ok:false", res.ok === false);
    check("(unit, stale lock) reason carries the specific reason code", /canonical_index_lock_present/.test(res.reason ?? ""));
    check("(unit, stale lock) reason names the exact lock path", (res.reason ?? "").includes(lockPath));
    check("(unit, stale lock) reason names the size", /\(0B,/.test(res.reason ?? ""));
    check("(unit, stale lock) reason names an age", /\d+(ms|s|m|h\d+m) old/.test(res.reason ?? ""));
    check("(unit, stale lock) tells the operator to remove it by hand once confirmed safe", /remove it by hand/i.test(res.reason ?? ""));

    fs.rmSync(lockPath);
    const res2 = await checkCanonicalIndexLockNotPresent(repo);
    check("(unit, stale lock) control: once removed, the SAME check returns ok:true", res2.ok === true);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // withCanonicalIndexLock itself, OPTED IN via {checkIndexLock:true} (round 2 scope ruling — the check
  // is opt-in, not unconditional; see B3 below for the deliberately-NOT-opted-in createWorktree case) —
  // throws CanonicalIndexLockPresentError, `fn` never runs.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const repo = makeRepo("lock-chokepoint");
    plantIndexLock(repo);
    let fnRan = false;
    let threw = null;
    try {
      await withCanonicalIndexLock(repo, async () => { fnRan = true; return "should never run"; }, { checkIndexLock: true });
    } catch (e) {
      threw = e;
    }
    check("(chokepoint) throws CanonicalIndexLockPresentError", threw instanceof CanonicalIndexLockPresentError);
    check("(chokepoint) the guarded callback never ran", fnRan === false);
    check("(chokepoint) error message names the reason code", /canonical_index_lock_present/.test(threw?.message ?? ""));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // withCanonicalIndexLock WITHOUT opting in (the default) — the check never fires; `fn` runs normally
  // even with a real lock present. This is the round-2 scope fix itself: round 1 shipped the check
  // unconditional at this chokepoint, which would have blocked createWorktree (see B3 above) too.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const repo = makeRepo("lock-chokepoint-default-off");
    plantIndexLock(repo);
    let fnRan = false;
    const result = await withCanonicalIndexLock(repo, async () => { fnRan = true; return "ran"; });
    check("(chokepoint, default off) `fn` DOES run — no opt-in means no check", fnRan === true && result === "ran");
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // mergeBranch (the solo squash path) — must refuse, name the reason, and leave canonical HEAD untouched
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const repo = makeRepo("mergebranch");
    execSync(`git worktree add -q -b loom/cilr-branch other-wt-${sfx} other-branch`, { cwd: repo });
    const wt = path.join(repo, `other-wt-${sfx}`);
    fs.writeFileSync(path.join(wt, "wt-file.txt"), "branch content\n");
    execSync(`git add -A && git ${GIT_ID} commit -q -m "branch work"`, { cwd: wt });
    const headBefore = git(repo, "rev-parse HEAD");

    const lockPath = plantIndexLock(repo);
    const res = await mergeBranch(repo, "loom/cilr-branch", "Index Lock Test Card");
    check("(mergeBranch) refuses while the lock is present", res.ok === false);
    check("(mergeBranch) result carries indexLockPresent:true", res.indexLockPresent === true);
    check("(mergeBranch) reason names the specific reason code", /canonical_index_lock_present/.test(res.reason ?? ""));
    check("(mergeBranch) reason names the exact lock path", (res.reason ?? "").includes(lockPath));
    check("(mergeBranch) canonical HEAD did NOT move — nothing ran", git(repo, "rev-parse HEAD") === headBefore);

    fs.rmSync(lockPath);
    const res2 = await mergeBranch(repo, "loom/cilr-branch", "Index Lock Test Card");
    check("(mergeBranch) control: once the lock is removed, the SAME merge lands", res2.ok === true);
    check("(mergeBranch) control: canonical HEAD actually moved", git(repo, "rev-parse HEAD") !== headBefore);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // fastForwardCanonicalMain (the batch union/ff path) — must refuse, name the reason, never advance HEAD
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const repo = makeRepo("ff");
    const baseSha = git(repo, "rev-parse HEAD");
    fs.writeFileSync(path.join(repo, "ff-file.txt"), "ff content\n");
    commitAll(repo, "feat(test): ff target", GIT_ID);
    const targetSha = git(repo, "rev-parse HEAD");
    execSync(`git reset --hard ${baseSha}`, { cwd: repo }); // canonical HEAD back at base; targetSha only reachable via its own ref

    const lockPath = plantIndexLock(repo);
    const res = await fastForwardCanonicalMain(repo, baseSha, targetSha);
    check("(ff) refuses while the lock is present", res.ok === false);
    check("(ff) result carries indexLockPresent:true", res.indexLockPresent === true);
    check("(ff) reason names the specific reason code", /canonical_index_lock_present/.test(res.reason ?? ""));
    check("(ff) canonical HEAD did NOT advance", git(repo, "rev-parse HEAD") === baseSha);

    fs.rmSync(lockPath);
    const res2 = await fastForwardCanonicalMain(repo, baseSha, targetSha);
    check("(ff) control: once the lock is removed, the SAME ff succeeds", res2.ok === true);
    check("(ff) control: canonical HEAD advanced to the target", git(repo, "rev-parse HEAD") === targetSha);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // createWorktree (round 2, CR 6ed0d5da B3) — MUST SUCCEED with a real lock present: `worktree prune`/
  // `branch --list`/`worktree add` all work fine against a canonical repo holding `.git/index.lock`
  // (verified against real git 2.47); a held lock must never block a worker/review spawn.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const repo = makeRepo("createworktree-b3");
    const lockPath = plantIndexLock(repo);
    const info = await createWorktree(repo, `cilr-proj-${sfx}`, `cilr-task-${sfx}`);
    check("(B3 createWorktree) SUCCEEDS despite a real .git/index.lock being present", !!info.worktreePath);
    check("(B3 createWorktree) the lock is untouched (no auto-removal, same as everywhere else)", fs.existsSync(lockPath));
    tmpDirs.push(info.worktreePath);
    fs.rmSync(lockPath);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // GitWriter.checkout/createBranch/commit (round 3, card e7a88047 item 4) — each must refuse while a
  // real lock is present, naming the specific reason code, and the SAME call must succeed once removed.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const repo = makeRepo("gitwriter");
    const mainlineBranch = git(repo, "rev-parse --abbrev-ref HEAD");
    const writer = new GitWriter(repo);

    // checkout — switch to the pre-existing "other-branch" makeRepo() already created.
    {
      const lockPath = plantIndexLock(repo);
      const res = await writer.checkout("other-branch");
      check("(GitWriter.checkout) refuses while the lock is present", res.ok === false);
      check("(GitWriter.checkout) error names the specific reason code", /canonical_index_lock_present/.test(res.error ?? ""));
      check("(GitWriter.checkout) canonical HEAD did not move", git(repo, "rev-parse --abbrev-ref HEAD") === mainlineBranch);
      fs.rmSync(lockPath);
      const res2 = await writer.checkout("other-branch");
      check("(GitWriter.checkout) control: once the lock is removed, checkout succeeds", res2.ok === true);
      check("(GitWriter.checkout) control: HEAD actually moved", git(repo, "rev-parse --abbrev-ref HEAD") === "other-branch");
      await writer.checkout(mainlineBranch); // back to mainline for the next sub-scenario
    }

    // createBranch
    {
      const lockPath = plantIndexLock(repo);
      const res = await writer.createBranch("gitwriter-new-branch-blocked");
      check("(GitWriter.createBranch) refuses while the lock is present", res.ok === false);
      check("(GitWriter.createBranch) error names the specific reason code", /canonical_index_lock_present/.test(res.error ?? ""));
      check("(GitWriter.createBranch) the branch was never created", !git(repo, "branch --list gitwriter-new-branch-blocked").trim());
      fs.rmSync(lockPath);
      const res2 = await writer.createBranch("gitwriter-new-branch-blocked");
      check("(GitWriter.createBranch) control: once the lock is removed, createBranch succeeds", res2.ok === true);
      check("(GitWriter.createBranch) control: the branch now exists", !!git(repo, "branch --list gitwriter-new-branch-blocked").trim());
    }

    // commit — HEAD is now on the just-created branch, which is fine; this only needs a lock refusal.
    {
      fs.writeFileSync(path.join(repo, "gitwriter-commit-test.txt"), "content\n");
      const countBefore = git(repo, "rev-list --count HEAD");
      const lockPath = plantIndexLock(repo);
      const res = await writer.commit("gitwriter commit blocked by lock");
      check("(GitWriter.commit) refuses while the lock is present", res.ok === false);
      check("(GitWriter.commit) error names the specific reason code", /canonical_index_lock_present/.test(res.error ?? ""));
      check("(GitWriter.commit) nothing committed", git(repo, "rev-list --count HEAD") === countBefore);
      fs.rmSync(lockPath);
      const res2 = await writer.commit("gitwriter commit after lock removed");
      check("(GitWriter.commit) control: once the lock is removed, commit succeeds", res2.ok === true);
      check("(GitWriter.commit) control: a new commit landed", git(repo, "rev-list --count HEAD") === String(Number(countBefore) + 1));
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // checkCanonicalIndexLockNotPresent — M6 liveness branch: the lock CHANGES during the witnessed wait
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const repo = makeRepo("unit-lock-live");
    const lockPath = plantIndexLock(repo);
    const before = fs.statSync(lockPath);
    // Rewrite the lock file's content partway through the check's own witnessed-wait window (300ms) —
    // deterministic (not a race): the rewrite always lands well before the check's own re-stat, and the
    // check's assertion is on the TEXT of the returned reason, not on timing.
    setTimeout(() => { fs.writeFileSync(lockPath, "x"); }, 100);
    const res = await checkCanonicalIndexLockNotPresent(repo);
    const after = fs.statSync(lockPath);
    check("(unit, live lock) the rewrite actually changed the file (size differs)", after.size !== before.size);
    check("(unit, live lock) still refuses (a changed lock is still a lock)", res.ok === false);
    check("(unit, live lock) reason reports it CHANGED during the check, not merely 'consistent with abandoned'", /it changed during a \d+ms check/.test(res.reason ?? ""));
    check("(unit, live lock) reason explicitly warns not to remove it", /do not remove it/i.test(res.reason ?? ""));
    fs.rmSync(lockPath);
  }
} finally {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a real stale .git/index.lock is detected before mergeBranch/fastForwardCanonicalMain " +
    "ever touch the canonical index, the refusal names the path/size/age, nothing runs, canonical HEAD " +
    "never moves, and removing the lock lets the SAME call land normally."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
