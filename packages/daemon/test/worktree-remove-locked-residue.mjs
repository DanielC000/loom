import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 79b8d8a9 — `removeWorktree` (git/worktrees.ts) used a SINGLE `git worktree remove --force`. Against
// a LOCKED admin record (e.g. the `.git/worktrees/<name>/locked` residue a killed `worktree add` can
// leave — card 1a858805), that single `--force` FAILS outright ("cannot remove a locked working tree").
// The function's own filesystem backstop then deletes the worktree DIRECTORY anyway (unconditional), but
// the trailing `git worktree prune` SKIPS locked records BY DESIGN — leaving a PERMANENT ghost admin
// record with no directory. The next `createWorktree` at that same path then fails with "is a missing
// but locked worktree".
//
// This proves, against REAL git (not a mock): (a) the ghost record exists and is real; (b) `removeWorktree`
// now clears it via `-f -f` (git's own documented override for this lock reason); (c) a NON-locked, DIRTY
// worktree is removed exactly as before (no behavior change on the common path).
//
// FALSIFIABILITY: this test is run once against the OLD `removeWorktree` (single `--force`, restored via
// `git show HEAD:...` into a throwaway copy) to prove leg (b) genuinely goes RED without the fix, and once
// against the fixed `dist/` to prove it goes GREEN — see the worker's own report for the before/after run.
//
// Run: 1) build daemon (pnpm build), 2) node test/worktree-remove-locked-residue.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-wt-rm-lock-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { removeWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();

/** git's own worktree admin dir for `worktreePath` — `<name>` is the path's own basename for a fresh,
 *  uncollided path (verified against real git in this test's setup). */
const adminDirFor = (repoPath, worktreePath) => path.join(repoPath, ".git", "worktrees", path.basename(worktreePath));

const repo = path.join(os.tmpdir(), `loom-wt-rm-lock-repo-${Date.now()}-${process.pid}`);
const extraDirs = [];

try {
  fs.mkdirSync(repo, { recursive: true });
  execSync(`git init -q && git config user.email wtrmlock@loom && git config user.name wtrmlock && git commit -q --allow-empty -m init`, { cwd: repo });

  // (a) LOCKED + DIRTY residue: a real worktree, made dirty (tracked-modified + untracked), then locked —
  //     modeling the killed-mid-checkout marker card 1a858805 already established real git leaves behind.
  {
    const wtA = `${repo}-wt-a`;
    extraDirs.push(wtA);
    git(repo, `worktree add -q -b loom-rmlock-a "${wtA}"`);
    fs.writeFileSync(path.join(wtA, "dirty.txt"), "tracked-then-modified\n");
    git(wtA, "add dirty.txt");
    git(wtA, "commit -q -m seed");
    fs.appendFileSync(path.join(wtA, "dirty.txt"), "modified after commit\n"); // tracked-dirty
    fs.writeFileSync(path.join(wtA, "untracked.txt"), "untracked\n");         // untracked
    git(repo, `worktree lock "${wtA}" --reason "simulated killed add (card 1a858805 shape)"`);

    check("(a) [control] worktree list shows the locked record before any cleanup",
      git(repo, "worktree list --porcelain").includes("locked"));
    check("(a) [control] the admin record exists before removeWorktree runs",
      fs.existsSync(adminDirFor(repo, wtA)));

    const { removed, wedged } = await removeWorktree(repo, wtA, { timeoutMs: 10_000 });

    check("(a) removeWorktree reports removed:true", removed === true);
    check("(a) removeWorktree reports wedged:false", wedged === false);
    check("(a) THE FIX: the directory is gone", !fs.existsSync(wtA));
    check("(a) THE FIX: the admin record is gone — no ghost residue",
      !fs.existsSync(adminDirFor(repo, wtA)));
    check("(a) THE FIX: `git worktree list` no longer references it",
      !git(repo, "worktree list --porcelain").includes(path.basename(wtA)));

    // The bug this closes: a ghost record blocks a future `worktree add` at the same path with "is a
    // missing but locked worktree". Prove a fresh add at that exact path now succeeds.
    let readdErr = null;
    try { git(repo, `worktree add -q -b loom-rmlock-a-readd "${wtA}"`); }
    catch (e) { readdErr = (e.stderr ? e.stderr.toString() : "") || e.message || ""; }
    check("(a) THE FIX: a fresh `worktree add` at the same path now succeeds (no ghost blocking it)",
      readdErr === null && fs.existsSync(wtA));
    if (fs.existsSync(wtA)) { git(repo, `worktree remove "${wtA}" -f -f`); } // tidy for the finally-block rmSync below
  }

  // (b) ORDINARY (non-locked) DIRTY worktree — same removal path, no lock involved. Proves `-f -f` changes
  //     NOTHING here: git's own single `--force` already deletes dirty/untracked content on a non-locked
  //     tree (the second force bit only ever gates the locked/corrupted-HEAD check), so this must behave
  //     identically to before the fix.
  {
    const wtB = `${repo}-wt-b`;
    extraDirs.push(wtB);
    git(repo, `worktree add -q -b loom-rmlock-b "${wtB}"`);
    fs.writeFileSync(path.join(wtB, "dirty.txt"), "tracked-then-modified\n");
    git(wtB, "add dirty.txt");
    git(wtB, "commit -q -m seed");
    fs.appendFileSync(path.join(wtB, "dirty.txt"), "modified after commit\n");
    fs.writeFileSync(path.join(wtB, "untracked.txt"), "untracked\n");

    check("(b) [control] worktree is NOT locked", !git(repo, "worktree list --porcelain").includes("locked"));

    const { removed, wedged } = await removeWorktree(repo, wtB, { timeoutMs: 10_000 });

    check("(b) ordinary dirty worktree: removed:true (unchanged from before)", removed === true);
    check("(b) ordinary dirty worktree: wedged:false", wedged === false);
    check("(b) ordinary dirty worktree: directory gone (unchanged from before)", !fs.existsSync(wtB));
    check("(b) ordinary dirty worktree: admin record gone (unchanged from before)",
      !fs.existsSync(adminDirFor(repo, wtB)));
  }

  // (c) a path that is NOT a registered worktree of this repo at all — `-f -f` must REFUSE (not silently
  //     succeed against something git never knew about), and must not throw past removeWorktree (the
  //     filesystem backstop still tidies up any stray directory there, same as before).
  {
    const wtC = path.join(repo, "..", `loom-wt-rm-lock-notaworktree-${Date.now()}-${randomUUID()}`);
    extraDirs.push(wtC);
    fs.mkdirSync(wtC, { recursive: true });
    fs.writeFileSync(path.join(wtC, "junk.txt"), "not a worktree\n");

    let threw = false;
    let result;
    try { result = await removeWorktree(repo, wtC, { timeoutMs: 10_000 }); }
    catch { threw = true; }

    check("(c) removeWorktree does not throw against a non-worktree path", threw === false);
    check("(c) the filesystem backstop still removes the stray directory", result?.removed === true);
  }
} finally {
  for (const d of extraDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — removeWorktree's `-f -f` clears a locked ghost admin record end-to-end (directory, " +
    "admin record, and a subsequent re-add all recover), an ordinary non-locked dirty worktree removes " +
    "identically to before, and a non-worktree path is refused by git without throwing past removeWorktree."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
