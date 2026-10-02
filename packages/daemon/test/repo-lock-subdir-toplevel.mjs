// Board card 7673d096 — `canonicalRepoLockKey` (git/repo-lock.ts) used to hash the project's BOUND
// `repoPath` directly (realpath + lowercase on win32). A project bound to a SUBDIRECTORY of a repo with
// no `.git` of its own (real specimen: a vault project bound inside a shared Obsidian vault repo) locked
// on the subdir key, while git itself operates against the TOPLEVEL's shared index — so a GitWriter op for
// it never serialized with a merge/GitWriter op on a SIBLING project bound to a DIFFERENT subdirectory of
// the SAME physical repo, despite both mutating the SAME `.git` index concurrently.
//
// THE FIX: `resolveGitToplevelSync` (git/repo-lock.ts) walks UP from the bound path's realpath to the
// nearest ancestor containing a `.git` entry; `canonicalRepoLockKey` now keys off THAT.
//
// PART 1 — resolveGitToplevelSync/canonicalRepoLockKey unit behavior (subdir resolves up; an
// already-toplevel path is unchanged; a non-repo path falls back exactly as before).
//
// PART 2 — THE STRUCTURAL PROPERTY: two sibling projects bound to DIFFERENT subdirectories of ONE
// physical repo now resolve to the SAME canonical key, and a GitWriter op on one actually SERIALIZES
// against a concurrent merge on the other (same hanging-pre-commit-hook idiom as
// test/merge-writer-index-lock.mjs, which proves the toplevel-bound case). RED on pre-fix code (verified
// manually during development by reverting git/repo-lock.ts to its pre-fix realpath-only key, rebuilding,
// and re-running this file — the two calls raced instead of queuing, matching the merge-writer-index-lock
// bug shape) — GREEN once both resolve to the same toplevel key.
//
// Run: 1) build daemon (pnpm build), 2) node test/repo-lock-subdir-toplevel.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const { canonicalRepoLockKey, resolveGitToplevelSync } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);
const { mergeBranch } = await import(pathToFileURL(path.join(distGitDir, "worktrees.js")).href);
const { GitWriter } = await import(pathToFileURL(path.join(distGitDir, "writer.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=rlst@loom -c user.name=rlst";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
const tmpDirs = [];
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function makeRepoWithSubdirs(tag) {
  const repo = path.join(os.tmpdir(), `loom-rlst-repo-${tag}`);
  const teamA = path.join(repo, "teamA"); // no .git of its own — a subdir-bound project specimen
  const teamB = path.join(repo, "teamB"); // same, a DIFFERENT subdir of the SAME physical repo
  fs.mkdirSync(teamA, { recursive: true });
  fs.mkdirSync(teamB, { recursive: true });
  tmpDirs.push(repo);
  fs.writeFileSync(path.join(teamA, "a.txt"), "team a\n");
  fs.writeFileSync(path.join(teamB, "b.txt"), "team b\n");
  execSync(`git init -q && git config user.email rlst@loom && git config user.name rlst && git add -A && git ${GIT_ID} commit -q -m init`, { cwd: repo });
  return { repo, teamA, teamB };
}

try {
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // PART 1 — unit behavior of resolveGitToplevelSync / canonicalRepoLockKey
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const sfx = freshSfx();
    const { repo, teamA, teamB } = makeRepoWithSubdirs(sfx);

    check("(unit) a subdir with no .git resolves UP to the repo toplevel", resolveGitToplevelSync(teamA) === fs.realpathSync.native(repo));
    check("(unit) a SIBLING subdir resolves to the SAME toplevel", resolveGitToplevelSync(teamB) === fs.realpathSync.native(repo));
    check("(unit) the toplevel itself resolves to itself (no change for an already-toplevel-bound project)", resolveGitToplevelSync(repo) === fs.realpathSync.native(repo));
    check("(unit) canonicalRepoLockKey collapses both subdirs AND the toplevel to the SAME key", canonicalRepoLockKey(teamA) === canonicalRepoLockKey(teamB) && canonicalRepoLockKey(teamB) === canonicalRepoLockKey(repo));

    // A deeper nested subdir still resolves to the same toplevel.
    const deeper = path.join(teamA, "nested", "deeper");
    fs.mkdirSync(deeper, { recursive: true });
    check("(unit) a DEEPER nested subdir also resolves up to the same toplevel", resolveGitToplevelSync(deeper) === fs.realpathSync.native(repo));

    // A path with no enclosing repo at all falls back to its own realpath, unchanged from the pre-fix
    // behavior (a vault-only project's bound path, or any directory not inside a git repo).
    //
    // Code Review finding 4 — `os.tmpdir()` is NOT guaranteed to be outside every git repo (a dotfiles-
    // managed home directory can put `.git` arbitrarily far up the chain). Verify the precondition against
    // REAL git itself before trusting the assertion below — `git rev-parse --show-toplevel` is the same
    // ground truth `resolveGitToplevelSync` is trying to replicate without a subprocess; if git itself
    // finds an enclosing repo here, this host's tmpdir isn't hermetic for this check — skip it LOUDLY
    // rather than assert something that isn't actually true of this environment.
    const nonRepo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "loom-rlst-nonrepo-")));
    tmpDirs.push(nonRepo);
    let nonRepoHermetic = true;
    try {
      execSync("git rev-parse --show-toplevel", { cwd: nonRepo, stdio: ["ignore", "pipe", "pipe"] });
      nonRepoHermetic = false; // git found a real enclosing repo — this host's tmpdir is not hermetic here
    } catch { /* git correctly reports "not a git repository" — the environment IS hermetic for this check */ }
    if (nonRepoHermetic) {
      check("(unit) a path with no enclosing repo at all falls back to its own realpath", resolveGitToplevelSync(nonRepo) === fs.realpathSync.native(nonRepo));
    } else {
      console.warn(`[repo-lock-subdir-toplevel] SKIPPED (not hermetic on this host): ${nonRepo} resolves to a REAL enclosing git repo per \`git rev-parse --show-toplevel\` — os.tmpdir() is apparently inside a dotfiles-managed repo on this machine, so the "no enclosing repo" precondition this check needs does not hold here.`);
    }

    // A linked worktree's .git is a FILE, not a directory — must still be recognized as a git root.
    // Placed OUTSIDE `repo` (a sibling tmp dir), not as a subdir of it, so `git worktree add` never treats
    // it as an embedded repo of the fixture itself.
    const wtPath = path.join(os.tmpdir(), `loom-rlst-wt-unit-${sfx}`);
    execSync(`git worktree add -q -b wt-branch-${sfx} "${wtPath}"`, { cwd: repo });
    tmpDirs.push(wtPath);
    check("(unit) worktree fixture: .git is a FILE (pointer), not a directory", fs.statSync(path.join(wtPath, ".git")).isFile());
    check("(unit) a linked worktree's own root resolves to ITSELF (its .git file is recognized as a git root)", resolveGitToplevelSync(wtPath) === fs.realpathSync.native(wtPath));
    const wtSubdir = path.join(wtPath, "deep", "inside");
    fs.mkdirSync(wtSubdir, { recursive: true });
    check("(unit) a subdir INSIDE a linked worktree resolves up to the worktree's own root (not the main repo)", resolveGitToplevelSync(wtSubdir) === fs.realpathSync.native(wtPath));

    // A path that doesn't exist on disk at all — best-effort fallback, must never throw.
    const ghost = path.join(os.tmpdir(), `loom-rlst-ghost-${sfx}`);
    let threw = null;
    let ghostResult;
    try { ghostResult = resolveGitToplevelSync(ghost); } catch (e) { threw = e; }
    check("(unit) a path that doesn't exist on disk never throws", threw === null);
    check("(unit) a path that doesn't exist on disk falls back to path.resolve(bp)", ghostResult === path.resolve(ghost));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // PART 2 — the structural property: GitWriter on one subdir-bound sibling serializes against a
  // concurrent merge on ANOTHER subdir-bound sibling of the SAME physical repo.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const sfx = freshSfx();
    const { repo, teamA, teamB } = makeRepoWithSubdirs(sfx);
    const branch = "loom/converge-test";
    const wt = path.join(os.tmpdir(), `loom-rlst-wt-${sfx}`);
    tmpDirs.push(wt);
    execSync(`git worktree add -q -b ${branch} "${wt}" HEAD`, { cwd: repo });
    fs.writeFileSync(path.join(wt, "branch-file.txt"), "branch content\n");
    execSync(`git add -A && git ${GIT_ID} commit -q -m "branch work"`, { cwd: wt });

    // ONE-SHOT hanging pre-commit hook (same marker-gated shape as merge-writer-index-lock.mjs) — widens
    // the merge's own `git commit` window so the interleaved GitWriter call unambiguously fires WHILE it
    // is still blocked.
    const HOOK_SLEEP_S = 3;
    const WRITER_FIRE_DELAY_MS = 600;
    const GUARD_MS = 25_000;
    const hookPath = path.join(repo, ".git", "hooks", "pre-commit");
    fs.writeFileSync(hookPath, `#!/bin/sh\nif [ -f .git/hang-fired ]; then\n  exit 0\nfi\ntouch .git/hang-fired\nsleep ${HOOK_SLEEP_S}\n`);
    fs.chmodSync(hookPath, 0o755);

    const guard = (ms, label) => new Promise((resolve) => setTimeout(() => resolve({ __guardFired: label }), ms));

    // The merge is called with repoPath = teamB (a subdir with no own .git); the writer is called with
    // repoPath = teamA (a DIFFERENT subdir). Pre-fix, these computed DIFFERENT lock keys and raced.
    const mergePromise = mergeBranch(teamB, branch, "Converge Test Card");
    await new Promise((r) => setTimeout(r, WRITER_FIRE_DELAY_MS));
    const writer = new GitWriter(teamA);
    const writerPromise = writer.commit("stray edit that must queue behind the sibling's merge");

    const [mergeResult, writerResult] = await Promise.all([
      Promise.race([mergePromise, guard(GUARD_MS, "merge")]),
      Promise.race([writerPromise, guard(GUARD_MS, "writer")]),
    ]);

    check("[part 2] [guard] the merge settled within the test's patience window (not wedged)", mergeResult?.__guardFired !== "merge");
    check("[part 2] [guard] the writer's commit settled within the test's patience window (not wedged)", writerResult?.__guardFired !== "writer");
    check("[part 2] the merge itself succeeds", mergeResult?.ok === true);
    check(
      "[part 2] the sibling's GitWriter op, having QUEUED behind the merge on the SAME physical repo, found " +
      "nothing left to commit (proves it waited for the merge to fully land, not that it raced and lost)",
      writerResult?.ok === false && /nothing to commit/i.test(writerResult?.error ?? ""),
    );
    check(
      "[part 2] no stray commit bearing the writer's own unrelated message ever landed (it never got to run " +
      "concurrently with the merge's own staged-but-uncommitted squash)",
      !git(repo, "--no-pager log --format=%s").split("\n").some((s) => s === "stray edit that must queue behind the sibling's merge"),
    );
  }
} finally {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — resolveGitToplevelSync walks a subdir up to its enclosing repo's toplevel (unit), and " +
    "two sibling subdir-bound projects of the SAME physical repo now collapse to the same canonical lock " +
    "key — a GitWriter op on one genuinely serializes against a concurrent merge on the other."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
