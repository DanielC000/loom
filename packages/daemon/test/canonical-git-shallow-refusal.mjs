import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 7ebb4acf, Code Review B2 — a genuinely shallow-cloned canonical repo must FAIL CLOSED, LOUDLY, on
// the canonical merge path, rather than hit an unpredictable error or (worse) `git merge --squash`'s own
// SILENT "nothing to squash" no-op once `GIT_SHALLOW_FILE` is neutralized. MEASURED against a real
// `git clone --depth 1` scratch repo:
//   - `merge-base`/`rev-list` into missing shallow-boundary history error loudly (exit 255 / 128);
//   - `git merge --squash` against the SAME missing history instead reports "Already up to date.
//     (nothing to squash)" and exits 0 — the real content is never staged, with no visible failure.
// `detectShallowCanonicalRepo` (git/bounded.ts) refuses BEFORE either failure mode is reachable, on both
// entry points:
//   (M1) solo `mergeBranch` (git/worktrees.ts) refuses a shallow repo; (M2) its own positive control
//        (a full, non-shallow clone with the identical branch shape) still lands normally.
//   (B1) batch `runBatchedMerge` (git/batch-merge.ts) refuses a shallow repo before assembly ever starts.
// Run: 1) build daemon (pnpm build), 2) node test/canonical-git-shallow-refusal.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { registerForCleanup, useOwnLoomHome } from "./_tmp-fixture.mjs";
useOwnLoomHome("loom-shallow-refusal-home-");

const WT = await import("../dist/git/worktrees.js");
const BM = await import("../dist/git/batch-merge.js");
const BOUNDED = await import("../dist/git/bounded.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const IDENT = { GIT_AUTHOR_NAME: "gsr", GIT_AUTHOR_EMAIL: "gsr@loom", GIT_COMMITTER_NAME: "gsr", GIT_COMMITTER_EMAIL: "gsr@loom" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...IDENT }, stdio: ["ignore", "pipe", "pipe"] }).trim();

/** A REAL origin repo with `n` commits, plus a real `git clone --depth <depth>` of it, under its OWN
 *  `name` subdir of `root` (each caller passes a distinct name — these are called more than once against
 *  the SAME root, and a shared "origin"/"clone" pair would collide on the second call). */
function makeShallowClone(root, name, n, depth) {
  const origin = path.join(root, name, "origin");
  fs.mkdirSync(origin, { recursive: true });
  git(origin, "init", "-q");
  git(origin, "config", "core.autocrlf", "false"); git(origin, "config", "user.email", "gsr@loom"); git(origin, "config", "user.name", "gsr");
  for (let i = 1; i <= n; i++) { fs.writeFileSync(path.join(origin, "f.txt"), `line ${i}\n`, { flag: "a" }); commitAll(origin, `commit ${i}`); }
  const clone = path.join(root, name, "clone");
  execFileSync("git", ["clone", "--depth", String(depth), "-q", `file://${origin.replace(/\\/g, "/")}`, clone], { encoding: "utf8" });
  return { origin, clone };
}

/** Cuts `branchName` off the repo's current HEAD with one extra commit — mirrors a worker's own landed branch shape. */
function cutWorkerBranch(repo, branchName, fileName) {
  // Capture the ORIGINAL branch name BEFORE checking out the new one — reading it AFTER would just
  // return `branchName` itself, leaving the repo stranded on the worker branch (a real bug this comment
  // exists to prevent regrowing: mergeBranch would then "merge" the branch into itself, 0 diff, a silent
  // STAGE_EMPTY_RETRY noop that looks like a pass).
  const defaultBranch = git(repo, "symbolic-ref", "--short", "HEAD").trim();
  git(repo, "checkout", "-q", "-b", branchName);
  fs.writeFileSync(path.join(repo, fileName), "worker content\n");
  git(repo, "add", fileName);
  git(repo, "commit", "-q", "-m", "worker commit");
  git(repo, "checkout", "-q", defaultBranch); // back to default before testing — mergeBranch expects to be on main
}

const root = path.join(os.tmpdir(), `loom-gsr-${sfx}`);
fs.mkdirSync(root, { recursive: true }); registerForCleanup(root);

// ── (M1) solo mergeBranch refuses a shallow canonical repo ──
{
  const { clone } = makeShallowClone(root, "m1", 4, 1);
  cutWorkerBranch(clone, "loom/shallow-test", "w1.txt");
  const headBefore = git(clone, "rev-parse", "HEAD");
  const statusBefore = git(clone, "status", "--porcelain");
  const r = await WT.mergeBranch(clone, "loom/shallow-test", "test title");
  check(`(M1) mergeBranch refuses a shallow canonical repo (got ${JSON.stringify(r)})`, r.ok === false && /shallow/i.test(r.reason ?? ""));
  check("(M1) the refusal names an actionable remedy (git fetch --unshallow)", /git fetch --unshallow/.test(r.reason ?? ""));
  check("(M1) the canonical repo was NOT mutated by the refused attempt (HEAD unchanged)", git(clone, "rev-parse", "HEAD") === headBefore);
  check("(M1) the canonical repo was NOT mutated by the refused attempt (status unchanged)", git(clone, "status", "--porcelain") === statusBefore);
}

// ── (M2) POSITIVE CONTROL — the identical branch shape on a FULL (non-shallow) clone of the SAME origin
// lands normally; detectShallowCanonicalRepo must not false-positive on an ordinary repo. ──
{
  const { origin } = makeShallowClone(root, "m2", 4, 1); // only need a fresh origin; ignore its throwaway shallow clone
  cutWorkerBranch(origin, "loom/full-test", "w2.txt");
  check("(M2 setup) the origin repo is NOT shallow", git(origin, "rev-parse", "--is-shallow-repository") === "false");
  const r = await WT.mergeBranch(origin, "loom/full-test", "test title");
  check(`(M2) mergeBranch proceeds normally against a full (non-shallow) repo (got ${JSON.stringify(r)})`, r.ok === true && typeof r.sha === "string");
}

// ── (B1) batch runBatchedMerge refuses a shallow canonical repo BEFORE assembly ever starts ──
{
  const { clone } = makeShallowClone(root, "b1", 4, 1);
  const headBefore = git(clone, "rev-parse", "HEAD");
  let runGateCalled = false;
  const r = await BM.runBatchedMerge(clone, clone, headBefore, [], async () => { runGateCalled = true; return { passed: true }; });
  check(`(B1) runBatchedMerge refuses a shallow canonical repo (got ${JSON.stringify(r)})`, r.ok === false && /shallow/i.test(r.reason ?? ""));
  check("(B1) the refusal names an actionable remedy (git fetch --unshallow)", /git fetch --unshallow/.test(r.reason ?? ""));
  check("(B1) the refusal fires BEFORE assembly — runGate was never called", runGateCalled === false);
  check("(B1) the canonical repo was NOT mutated by the refused attempt (HEAD unchanged)", git(clone, "rev-parse", "HEAD") === headBefore);
}

const TIMEOUT_MS = 15_000;

// ── (D) SF4 (Re-review 11cd4e3e) — detectShallowCanonicalRepo must FAIL CLOSED when resolveGitDirsSync
// returns null (repoPath is a SUBDIRECTORY with no .git of its own), never silently "not shallow". ──
{
  // (D1) a SHALLOW clone, probed via a SUBDIRECTORY path (no .git there) — pre-fix this returned null
  // (not shallow, fail-open); post-fix it must resolve the common dir via `rev-parse --git-common-dir`
  // and correctly detect shallow.
  const { clone } = makeShallowClone(root, "d1", 4, 1);
  const sub = path.join(clone, "sub");
  fs.mkdirSync(sub, { recursive: true });
  check("(D1 setup) the subdir itself has no .git of its own", !fs.existsSync(path.join(sub, ".git")));
  const d1 = await BOUNDED.detectShallowCanonicalRepo(sub, TIMEOUT_MS);
  check(`(D1) detectShallowCanonicalRepo(subdir-of-a-shallow-clone) fails CLOSED — correctly detects shallow (got ${JSON.stringify(d1)})`, typeof d1 === "string" && /shallow/i.test(d1));

  // (D2) POSITIVE CONTROL — the SAME subdir probe against a FULL (non-shallow) repo must still return
  // `null` (not shallow) — the fail-closed fix must not false-positive on an ordinary repo accessed via a
  // subdir path.
  const { origin } = makeShallowClone(root, "d2", 4, 1);
  const subFull = path.join(origin, "sub");
  fs.mkdirSync(subFull, { recursive: true });
  const d2 = await BOUNDED.detectShallowCanonicalRepo(subFull, TIMEOUT_MS);
  check(`(D2) detectShallowCanonicalRepo(subdir-of-a-FULL-repo) correctly returns null (not shallow) (got ${JSON.stringify(d2)})`, d2 === null);

  // (D3) the fs-only fast path (repoPath itself has a .git) is UNCHANGED by this fix — still returns
  // `null` for a non-shallow repo without ever reaching the git-common-dir probe.
  const d3 = await BOUNDED.detectShallowCanonicalRepo(origin, TIMEOUT_MS);
  check(`(D3) detectShallowCanonicalRepo(the repo root itself) still returns null (not shallow) via the fs-only fast path (got ${JSON.stringify(d3)})`, d3 === null);

  // (D4) when EVEN the git-common-dir probe itself fails (repoPath is not a git repo at all, and has no
  // .git of its own either), refuse with an honest "could not determine" reason — never silently "not
  // shallow".
  const notARepo = path.join(root, "d4-not-a-repo");
  fs.mkdirSync(notARepo, { recursive: true });
  const d4 = await BOUNDED.detectShallowCanonicalRepo(notARepo, TIMEOUT_MS);
  check(`(D4) detectShallowCanonicalRepo(not a git repo at all) refuses with an honest "could not determine" reason, never null (got ${JSON.stringify(d4)})`, typeof d4 === "string" && /could not determine whether the canonical repo is shallow/.test(d4));

  // (D5) card 7ebb4acf, SF2 (Code Review e9cbcb15) — a repoPath that does not exist AT ALL (not even a
  // plain directory, unlike D4's `notARepo`) used to make this function THROW raw: simple-git's own
  // constructor throws synchronously (`GitConstructError`) for a nonexistent baseDir, and the git-factory
  // construction used to sit OUTSIDE the try that was supposed to catch exactly this. Must now return the
  // honest refusal, never throw.
  const nonexistent = path.join(root, "d5-does-not-exist-at-all");
  check("(D5 setup) the path genuinely does not exist", !fs.existsSync(nonexistent));
  let d5;
  let d5Threw = false;
  try { d5 = await BOUNDED.detectShallowCanonicalRepo(nonexistent, TIMEOUT_MS); } catch { d5Threw = true; }
  check(`(D5) detectShallowCanonicalRepo(a nonexistent repoPath) does NOT throw (threw: ${d5Threw})`, d5Threw === false);
  check(`(D5) ...and instead refuses with the honest "could not determine" reason, never null (got ${JSON.stringify(d5)})`, typeof d5 === "string" && /could not determine whether the canonical repo is shallow/.test(d5));
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
