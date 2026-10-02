import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card f9360c84 (round 2) — GitWriter itself now refuses a write whose RAW repoPath, OR whose
// git-resolved TOPLEVEL, is LOOM_HOME or an ancestor of it (isLoomHomeOrAncestor, vault/versioner.ts),
// checked BEFORE any mutating git call in checkout/createBranch/commit/push. This is the unit-level
// proof of the guard itself, independent of any caller — see gateway-reserved-home-git-refusal.mjs /
// platform-reserved-home-git-refusal.mjs / operator-reserved-home-git-refusal.mjs for the end-to-end
// proof at each real write surface (human REST / Platform Lead / the bounded Operator).
// See docs/decisions/f9360c84-refuse-operational-dirs-in-vault-git-target-and-reserved-home-git-writers.md.
//
// HERMETIC + CLAUDE-FREE + NETWORK-FREE. Own temp LOOM_HOME (useOwnLoomHome + requireHermeticEnv).
// Covers:
//   (a) a NON-GIT DESCENDANT of LOOM_HOME (LOOM_HOME has a real .git; the descendant has none of its own)
//       — the round-2 CRITICAL bypass — commit is refused via the git-resolved-toplevel check, and
//       nothing lands staged in LOOM_HOME's own repo;
//   (b) LOOM_HOME itself (raw-path equality) — every write op (checkout/createBranch/commit/push) is
//       refused, before any mutating git call;
//   (c) an ANCESTOR of LOOM_HOME (raw-path match, the "user's home dir as repoPath" shape) is refused too;
//   (d) NEGATIVE CONTROL: an ordinary repo with its OWN top-level `worktrees/` folder is NOT refused
//       (proves the guard is PATH-RELATION ONLY — isLoomHomeOrAncestor — never isOperationalVaultDir's
//       content sniff, which would wrongly flag this shape);
//   (e) NEGATIVE CONTROL: a REAL linked git worktree under WORKTREES_DIR (a sibling of LOOM_HOME — the
//       shape every Loom worker's own worktree takes) is NOT refused.
//   (f) round 3: a toplevel-probe TIMEOUT on a non-git descendant of LOOM_HOME is FAIL-CLOSED (refused),
//       never treated like the clean "not a git repository" fall-through.
//   (g) round 3, win32 only: fs.realpathSync.native resolves a directory JUNCTION aliasing an ancestor
//       of LOOM_HOME, so isLoomHomeOrAncestor can't be defeated by one. Skipped (with a logged reason)
//       off win32 or if the junction can't be created without elevation. MEASURED non-discriminating on
//       this host (plain fs.realpathSync ALSO resolves a junction) — kept anyway as a real regression
//       guard; see the f9360c84 decision record for the 8.3-short-name alternative that was considered
//       and not pursued further.
// Run: 1) build, 2) node test/git-writer-operational-home-guard.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtempManaged, useOwnLoomHome, finishAndExit } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const loomHome = fs.realpathSync(useOwnLoomHome("loom-gitwriter-ophome-"));

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { GitWriter } = await import("../dist/git/writer.js");
const { WORKTREES_DIR } = await import("../dist/paths.js");

const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();
function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init");
  git(dir, "checkout", "-b", "main");
  git(dir, "config", "user.email", "loom-test@example.com");
  git(dir, "config", "user.name", "loom-test");
  git(dir, "config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(dir, "seed.md"), "# seed\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "seed");
}

// Give LOOM_HOME itself a real .git — the exact "pre-fix commitVault already ran / hand-made repo" shape
// a real host can carry, and the ONLY shape under which git's own upward discovery from a descendant
// actually finds something to walk up TO.
initRepo(loomHome);
const loomHomeHeadBefore = git(loomHome, "rev-parse", "HEAD").trim();
const loomHomeBranchesBefore = git(loomHome, "branch", "--list").trim();

const fixturesRoot = fs.realpathSync(mkdtempManaged("loom-gitwriter-ophome-fixtures-"));

try {
  // ===== (a) a non-git DESCENDANT of LOOM_HOME — the round-2 critical bypass =====
  const descendant = path.join(loomHome, "workspaces", "some-vault-only-home");
  fs.mkdirSync(descendant, { recursive: true });
  fs.writeFileSync(path.join(descendant, "pwned.txt"), "should never be committed\n");
  const wDescendant = new GitWriter(descendant);
  const commitDescendant = await wDescendant.commit("should never land");
  check("(a) commit against a non-git DESCENDANT of LOOM_HOME is refused (RED on old code: git would walk up and commit into LOOM_HOME/.git)",
    commitDescendant.ok === false);
  check("(a) …error names the operational home dir", /operational home directory/i.test(commitDescendant.error ?? ""));
  check("(a) LOOM_HOME's own repo HEAD is UNCHANGED", git(loomHome, "rev-parse", "HEAD").trim() === loomHomeHeadBefore);
  const loomHomeStatusAfter = git(loomHome, "status", "--porcelain");
  check("(a) NOTHING in LOOM_HOME's own repo is STAGED (no loom.db-shaped `add -A` sweep; index-column blank/untracked only)",
    !/^[MADRC]/m.test(loomHomeStatusAfter));
  check("(a) the descendant's file sits UNTRACKED under LOOM_HOME's own status (proves `add -A` never ran there)",
    loomHomeStatusAfter.includes("workspaces/"));

  // ===== (b) LOOM_HOME itself (raw-path equality) =====
  const wHome = new GitWriter(loomHome);
  const checkoutHome = await wHome.checkout("main");
  check("(b) checkout against LOOM_HOME itself is refused", checkoutHome.ok === false && /operational home directory/i.test(checkoutHome.error));
  const createBranchHome = await wHome.createBranch("pwned-branch");
  check("(b) createBranch against LOOM_HOME itself is refused", createBranchHome.ok === false && /operational home directory/i.test(createBranchHome.error));
  check("(b) …NO new branch was created", git(loomHome, "branch", "--list").trim() === loomHomeBranchesBefore);
  fs.writeFileSync(path.join(loomHome, "pwned2.txt"), "nope\n");
  const commitHome = await wHome.commit("should never land either");
  check("(b) commit against LOOM_HOME itself is refused", commitHome.ok === false && /operational home directory/i.test(commitHome.error));
  check("(b) …HEAD still unchanged", git(loomHome, "rev-parse", "HEAD").trim() === loomHomeHeadBefore);
  const pushHome = await wHome.push();
  check("(b) push against LOOM_HOME itself is refused", pushHome.ok === false && /operational home directory/i.test(pushHome.error));

  // ===== (c) an ANCESTOR of LOOM_HOME (raw-path match) =====
  const ancestor = path.dirname(loomHome);
  const wAncestor = new GitWriter(ancestor);
  const checkoutAncestor = await wAncestor.checkout("main");
  check("(c) checkout against an ANCESTOR of LOOM_HOME is refused", checkoutAncestor.ok === false && /operational home directory/i.test(checkoutAncestor.error));

  // ===== (d) NEGATIVE CONTROL: an ordinary repo with its OWN top-level worktrees/ folder =====
  const ordinaryWithWorktreesDir = path.join(fixturesRoot, "ordinary-with-worktrees-folder");
  initRepo(ordinaryWithWorktreesDir);
  fs.mkdirSync(path.join(ordinaryWithWorktreesDir, "worktrees"));
  const wOrdinaryWT = new GitWriter(ordinaryWithWorktreesDir);
  const branchOrdinaryWT = await wOrdinaryWT.createBranch("feature-wt");
  check("(d) negative control: an ordinary repo with its own top-level worktrees/ folder is NOT refused",
    branchOrdinaryWT.ok === true && branchOrdinaryWT.branch === "feature-wt");

  // ===== (e) NEGATIVE CONTROL: a REAL linked git worktree under WORKTREES_DIR (sibling of LOOM_HOME) =====
  const sourceRepo = path.join(fixturesRoot, "source-repo");
  initRepo(sourceRepo);
  fs.mkdirSync(WORKTREES_DIR, { recursive: true });
  const workerWorktree = path.join(WORKTREES_DIR, "fake-worker-id");
  git(sourceRepo, "worktree", "add", "-b", "loom/fake-worker-id", workerWorktree, "main");
  const wWorker = new GitWriter(workerWorktree);
  fs.writeFileSync(path.join(workerWorktree, "worker-file.txt"), "worker wrote this\n");
  const commitWorker = await wWorker.commit("feat(test): worker commit in its own worktree");
  check("(e) negative control: a real linked worktree under WORKTREES_DIR (a sibling of LOOM_HOME) is NOT refused",
    commitWorker.ok === true && typeof commitWorker.hash === "string");

  // ===== (f) round 3 (card f9360c84): a toplevel-PROBE TIMEOUT on a non-git descendant of LOOM_HOME
  // must FAIL CLOSED — refused, never fall through as if the probe had proven "not a git repository".
  // Injects a fake gitFactory (the writer's own test seam) whose revparse() never settles, with a tiny
  // gitLocalMs so the real withTimeout race inside refuseIfOperationalHome actually fires. Every OTHER
  // WriterGit method on this fake throws if called at all — proof the real op below never ran.
  const descendant2 = path.join(loomHome, "workspaces", "another-vault-only-home");
  fs.mkdirSync(descendant2, { recursive: true });
  fs.writeFileSync(path.join(descendant2, "pwned3.txt"), "should never be committed either\n");
  const neverReached = (label) => async () => { throw new Error(`should never be reached: ${label} (refusal must fire before any real git call)`); };
  const hungProbeGitFactory = () => ({
    checkout: neverReached("checkout"),
    checkoutLocalBranch: neverReached("checkoutLocalBranch"),
    branchLocal: neverReached("branchLocal"),
    status: neverReached("status"),
    raw: neverReached("raw"),
    commit: neverReached("commit"),
    revparse: () => new Promise(() => {}), // never settles — simulates a hung/slow toplevel probe
  });
  const wHungProbe = new GitWriter(descendant2, { gitLocalMs: 50, gitFactory: hungProbeGitFactory });
  const commitHungProbe = await wHungProbe.commit("should never land via a hung probe");
  check("(f) commit against a non-git descendant is REFUSED when the toplevel probe times out (RED on pre-fix fail-open code: would fall through and let the real op run)",
    commitHungProbe.ok === false);
  check("(f) …error says it could not verify the repo's location (never the clean 'not a git repository' fall-through message)",
    /could not verify this repo.s location/i.test(commitHungProbe.error ?? ""));
  check("(f) LOOM_HOME's own repo HEAD is STILL unchanged", git(loomHome, "rev-parse", "HEAD").trim() === loomHomeHeadBefore);
  check("(f) NOTHING in LOOM_HOME's own repo is STAGED", !/^[MADRC]/m.test(git(loomHome, "status", "--porcelain")));

  // ===== (g) round 3 (card f9360c84), win32 only: fs.realpathSync.native resolves a directory JUNCTION
  // aliasing an ANCESTOR of LOOM_HOME, so isLoomHomeOrAncestor can't be defeated by one. =====
  if (process.platform === "win32") {
    const junctionParent = fs.mkdtempSync(path.join(os.tmpdir(), "loom-gitwriter-ophome-junction-"));
    const junctionPath = path.join(junctionParent, "alias-of-loomhome-parent");
    let junctionCreated = false;
    try {
      fs.symlinkSync(path.dirname(loomHome), junctionPath, "junction");
      junctionCreated = true;
    } catch (e) {
      console.log(`SKIP  (g) win32 junction case — could not create a junction without elevation: ${e?.message ?? e}`);
    }
    if (junctionCreated) {
      const wJunction = new GitWriter(junctionPath);
      const checkoutJunction = await wJunction.checkout("main");
      check("(g) a win32 junction ALIASING an ancestor of LOOM_HOME is refused (realpathSync.native resolves it, defeating the alias)",
        checkoutJunction.ok === false && /operational home directory/i.test(checkoutJunction.error ?? ""));
    }
  } else {
    console.log("SKIP  (g) win32 junction case — not running on win32");
  }
} finally {
  try { fs.rmSync(WORKTREES_DIR, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — GitWriter itself refuses every write op (checkout/createBranch/commit/push) whose RAW repoPath, or whose git-resolved TOPLEVEL, is LOOM_HOME or an ancestor of it — including a non-git descendant of LOOM_HOME (the round-2 critical bypass), a hung toplevel probe (round 3, fail-closed), and a win32 junction alias (round 3, realpathSync.native coverage) — while an ordinary repo with its own worktrees/ folder and a real Loom worker worktree (sibling of LOOM_HOME) are both completely unaffected."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
