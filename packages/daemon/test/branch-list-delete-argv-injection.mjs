import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 7eac6366 (docs/decisions/7eac6366-*.md has the threat and fix mechanism; phase 2 of 65b2b002,
// which fixed changedPathsBetween/changedPathStatusesBetween's diff-range token and explicitly carded
// `git branch --list ${branch}` / `git branch -D ${branch}` out of its own scope). Real git, no claude/
// daemon. An option-shaped branch name (e.g. "--merged", "-f") passed as a bare argv token right after
// `--list`/`-D` is re-entered into git's own option parser instead of staying a literal positional name
// — unlike `--merged <value>`'s own required-argument slot, which always consumes the very next token
// literally regardless of shape (measured separately; that slot needed no fix and this file does not
// test it). Four scenarios, each proving a REAL observable divergence (never just "a guard fired"):
// (1) branchExistsInRepo false-POSITIVE on a nonexistent "--merged"-named branch; (2) deleteBranch
// silently fails to delete a REAL branch named "-f" while still reporting success; (3) the SAME silent
// skip inside deleteBranches' batched call, where git's own exit 0 makes the code wrongly record the
// skipped branch as deleted; (4) isBranchMerged's own false-positive, same canary as (1).
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { useOwnLoomHome, mkdtempManaged } from "./_tmp-fixture.mjs";

useOwnLoomHome("bld-home-"); // temp SHORT LOOM_HOME, set BEFORE the dist import below
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distUrl = pathToFileURL(path.join(__dirname, "..", "dist", "git", "worktrees.js")).href;
const { branchExistsInRepo, deleteBranch, deleteBranches, isBranchMerged } = await import(distUrl);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=bld@loom -c user.name=bld";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();

function newRepo(name) {
  const repo = mkdtempManaged(`loom-bld-${name}-`);
  // Pin the initial branch name explicitly to "master" — never leave it to the HOST's own
  // `init.defaultBranch` (main/master/trunk/...), or scenario (4) below can pass VACUOUSLY: its
  // `isBranchMerged(..., "master")` call would fail to resolve "master" at all on a host defaulting to
  // "main", erroring out (caught -> false) for a reason that has nothing to do with the fix under test.
  execSync(`git init -q -b master && git ${GIT_ID} commit -q -m init --allow-empty`, { cwd: repo });
  return repo;
}

function listLocalBranches(repo) {
  // Deliberately NOT the function under test — a raw, independent read so the assertion never
  // bottoms out on the same primitive it's trying to verify.
  return git(repo, "branch --list --format=%(refname:lstrip=2)").split("\n").map((s) => s.trim()).filter(Boolean);
}

try {
  // ── (1) branchExistsInRepo: false POSITIVE for a nonexistent option-shaped branch name ─────────────
  // `git branch --list --merged` (no --end-of-options) does not list a pattern "--merged" at all — it
  // re-enters option parsing and is consumed as the `--merged` (vs HEAD) FILTER flag instead, which
  // matches the always-merged-into-itself default branch and prints non-empty output. The pre-fix code
  // reads that non-empty output as "branch '--merged' exists" — it does not, anywhere in this repo.
  {
    const repo = newRepo("exists");
    const sha = git(repo, "rev-parse HEAD");
    git(repo, "branch real1");
    check("(1) PRECONDITION: no branch literally named \"--merged\" exists",
      !listLocalBranches(repo).includes("--merged"));
    const result = await branchExistsInRepo(repo, "--merged");
    check("(1) branchExistsInRepo(\"--merged\") correctly reports false (no such branch; FAILS pre-fix, " +
      "which misreads the --merged default-filter's own non-empty listing as a hit)", result === false);
    // Sanity/positive control: the fix must not break a genuine existing-branch check.
    check("(1) POSITIVE CONTROL: branchExistsInRepo(\"real1\") (an ordinary name) still reports true",
      (await branchExistsInRepo(repo, "real1")) === true);
    void sha;
  }

  // ── (2) deleteBranch: a REAL branch named "-f" silently survives, while the call still reports "ok" ─
  {
    const repo = newRepo("delone");
    const sha = git(repo, "rev-parse HEAD");
    execSync(`git update-ref refs/heads/-f ${sha}`, { cwd: repo }); // bypass branch-command argv parsing to create it
    check("(2) PRECONDITION: a real branch literally named \"-f\" exists", listLocalBranches(repo).includes("-f"));
    const ok = await deleteBranch(repo, "-f");
    check("(2) deleteBranch(\"-f\") reports some result (its own contract always resolves, never throws)", typeof ok === "boolean");
    check("(2) the branch literally named \"-f\" is ACTUALLY gone afterward (FAILS pre-fix: \"-f\" is " +
      "consumed as the `-D` force flag instead of a name, so the real ref survives untouched)",
      !listLocalBranches(repo).includes("-f"));
  }

  // ── (3) deleteBranches (batch): git's own exit 0 wrongly credits a skipped option-shaped name ──────
  {
    const repo = newRepo("delbatch");
    const sha = git(repo, "rev-parse HEAD");
    git(repo, "branch real1");
    git(repo, "branch real2");
    execSync(`git update-ref refs/heads/-f ${sha}`, { cwd: repo });
    check("(3) PRECONDITION: real1, real2, and a real branch literally named \"-f\" all exist",
      ["real1", "real2", "-f"].every((b) => listLocalBranches(repo).includes(b)));
    const { deleted } = await deleteBranches(repo, ["real1", "-f", "real2"]);
    const stillThere = listLocalBranches(repo);
    check("(3) the batch call does not CRASH and returns a deleted[] array", Array.isArray(deleted));
    check("(3) \"-f\" is ACTUALLY gone afterward too (FAILS pre-fix: git's own batched `-D real1 -f " +
      "real2` exits 0 having deleted real1+real2 but swallowed \"-f\" as the force flag — the real ref " +
      "survives even though git's exit code told the caller the whole chunk succeeded)",
      !stillThere.includes("-f"));
    check("(3) real1 and real2 are also gone (the fix must not regress the ordinary batch case)",
      !stillThere.includes("real1") && !stillThere.includes("real2"));
  }

  // ── (4) isBranchMerged: the SAME false-positive shape, through its own `--merged <base> --list ` slot ─
  {
    const repo = newRepo("merged");
    git(repo, "branch real1"); // trivially merged into master (same commit, no divergent work)
    check("(4) PRECONDITION: no branch literally named \"--merged\" exists",
      !listLocalBranches(repo).includes("--merged"));
    const result = await isBranchMerged(repo, "--merged", "master");
    check("(4) isBranchMerged(\"--merged\") correctly reports false (FAILS pre-fix, which misreads the " +
      "re-triggered --merged default-filter's own non-empty listing as a hit)", result === false);
    // Positive/sanity control: the fix must not break a genuine already-merged branch check — and this
    // also proves "master" itself resolved (scenario (4) above would otherwise pass VACUOUSLY if the
    // base branch name didn't exist at all on this host).
    check("(4) POSITIVE CONTROL: isBranchMerged(\"real1\") (an ordinary, genuinely merged name) reports true",
      (await isBranchMerged(repo, "real1", "master")) === true);
  }
} finally {
  // mkdtempManaged's own exit hooks are the real backstop; this just lets a solo run print success/failure
  // without waiting for process exit to confirm cleanup actually happened.
}

console.log(failures === 0
  ? "\n✅ ALL PASS — an option-shaped branch name (\"--merged\"/\"-f\") passed to `git branch --list`/" +
    "`-D` (solo or batched) is always treated as a literal name, never re-entered into git's own option " +
    "parser, across branchExistsInRepo/deleteBranch/deleteBranches/isBranchMerged."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
