import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — no daemon/Db used below, pure real-git exercise.
// Card 8d49c36c (from the Code Review of d8bb2074/cb6ba196) — vault/versioner.ts had NO merge-quarantine
// awareness at all: GitWriter.withVaultPauseLease always resumes the vault auto-committer's pause lease in
// `finally`, even when the wrapped op left the canonical repo QUARANTINED via an unconfirmed kill, so the
// instant the lease lifts, commitVault()/VaultVersioner.commit() could resume `add`/`commit` straight into
// a still-possibly-live orphan. Worse: the pause lease is ONLY ever acquired by GitWriter's own ops — a
// quarantine raised by the merge/batch path (mergeBranchLocked/fastForwardCanonicalMain/
// assembleBatchBranches) never touches the vault pause lease at all, so the vault's debounced tick could
// race THAT trigger with zero pause-lease signal. This file proves the fix: commitVault and
// VaultVersioner.flushSync() both now check `assertRepoNotQuarantined` on the CONFIRMED governing root,
// re-checked again immediately before the actual commit call.
//
// Run: 1) build daemon (pnpm build), 2) node test/vault-commit-quarantine.mjs
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit, useOwnLoomHome } from "./_tmp-fixture.mjs";

// HERMETICITY (card 500fe2df): this file calls the real enterMergeQuarantine() many times over (real
// durable latch writes under LOOM_HOME) — the three dist imports below were previously STATIC, which
// would evaluate before any runtime hermetic setup could run at all (static imports are hoisted ahead of
// every other top-level statement); converted to dynamic `await import(...)` so useOwnLoomHome()/
// requireHermeticEnv() below actually run first, same as every other hermetic test in this suite.
useOwnLoomHome("loom-vault-quarantine-home-");
requireHermeticEnv();

const { VaultVersioner, commitVault } = await import("../dist/vault/versioner.js");
const { enterMergeQuarantine, clearMergeQuarantine } = await import("../dist/git/merge-quarantine.js");
const { boundedSimpleGit } = await import("../dist/git/bounded.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

function initRepo(dir) {
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] }).toString();
  git("init", "-q");
  git("config", "user.email", "vault-quarantine@loom");
  git("config", "user.name", "vault-quarantine");
  git("commit", "-q", "--allow-empty", "-m", "init");
  return git;
}

function commitCount(git) {
  return git("log", "--oneline").trim().split("\n").filter(Boolean).length;
}

const root = fs.realpathSync(mkdtempManaged("loom-vault-quarantine-"));

// ═══════════════════ [1] VAULT IS THE REPO ROOT — the direct commitVault() path ═══════════════════
{
  const repo = path.join(root, "repo1");
  fs.mkdirSync(repo);
  const git = initRepo(repo);

  fs.writeFileSync(path.join(repo, "note.md"), "# note 1\n");
  enterMergeQuarantine(repo, "some-branch", "test: simulated quarantine, vault IS the repo root");
  const resultWhileQuarantined = await commitVault(repo, "loom: should be skipped");
  check("[1] commitVault() SKIPS (returns false) while the repo is quarantined", resultWhileQuarantined === false);
  check("[1] nothing was actually committed while quarantined", commitCount(git) === 1);

  clearMergeQuarantine(repo);
  const resultAfterClear = await commitVault(repo, "loom: should land now");
  check("[1] commitVault() succeeds once the quarantine clears", resultAfterClear === true);
  check("[1] the commit actually landed", commitCount(git) === 2 && git("log", "--oneline").includes("should land now"));
}

// ═══════════════════ [2] VAULT IS A SUBDIR OF A QUARANTINED REPO — the VaultVersioner-resolved path ═══════════════════
// A legacy row's vaultPath can be a SUBDIR of its own code repo (cb6ba196 only refuses new creates/
// updates). VaultVersioner.start() resolves such a vaultPath UP to its governing toplevel via
// resolveVaultRepoContext, and VaultVersioner.commit()'s tick then calls commitVault() with that resolved
// root — never the raw subdir. The quarantine check must be keyed on THAT resolved root, not the subdir.
{
  const repo = path.join(root, "repo2");
  const vaultSubdir = path.join(repo, "docs", "vault");
  fs.mkdirSync(vaultSubdir, { recursive: true });
  const git = initRepo(repo);

  const versioner = new VaultVersioner(vaultSubdir, 50);
  await versioner.start();
  check("[2] VaultVersioner resolves a subdir vaultPath UP to the repo toplevel", versioner.commitRoot === fs.realpathSync(repo));

  fs.writeFileSync(path.join(vaultSubdir, "note.md"), "# note 2\n");
  enterMergeQuarantine(repo, "some-branch", "test: simulated quarantine, vault is a SUBDIR of the repo");
  await versioner.commit();
  check("[2] the tick SKIPS while the governing repo is quarantined (vault itself is just a subdir)", commitCount(git) === 1);

  clearMergeQuarantine(repo);
  await versioner.commit();
  check("[2] the tick commits once the quarantine clears", commitCount(git) === 2);
  await versioner.stop();
}

// ═══════════════════ [3] A SPELLING VARIANT of the quarantined path still matches ═══════════════════
// `assertRepoNotQuarantined` → `canonicalRepoLockKey` normalizes via fs.realpathSync.native + win32
// lowercasing — a quarantine raised under a DIFFERENT spelling of the SAME real directory (trailing
// separator, forward slashes, or — on win32 — a different case) must still be found.
{
  const repo = path.join(root, "repo3");
  fs.mkdirSync(repo);
  const git = initRepo(repo);
  fs.writeFileSync(path.join(repo, "note.md"), "# note 3\n");

  const trailingSepVariant = repo + path.sep;
  enterMergeQuarantine(trailingSepVariant, "some-branch", "test: quarantine raised with a TRAILING SEPARATOR variant");
  const resultTrailingSep = await commitVault(repo, "loom: should be skipped (trailing sep variant)");
  check("[3] a trailing-separator spelling variant still matches (commitVault skips)", resultTrailingSep === false);
  check("[3] trailing-separator variant: nothing committed", commitCount(git) === 1);
  clearMergeQuarantine(trailingSepVariant);

  const forwardSlashVariant = repo.replace(/\\/g, "/");
  enterMergeQuarantine(forwardSlashVariant, "some-branch", "test: quarantine raised with a FORWARD-SLASH variant");
  const resultForwardSlash = await commitVault(repo, "loom: should be skipped (forward-slash variant)");
  check("[3] a forward-slash spelling variant still matches (commitVault skips)", resultForwardSlash === false);
  check("[3] forward-slash variant: nothing committed", commitCount(git) === 1);
  clearMergeQuarantine(forwardSlashVariant);

  if (process.platform === "win32") {
    const driveLetter = repo.slice(0, 1);
    const caseVariant = (driveLetter === driveLetter.toUpperCase() ? driveLetter.toLowerCase() : driveLetter.toUpperCase()) + repo.slice(1);
    enterMergeQuarantine(caseVariant, "some-branch", "test: quarantine raised with a drive-letter CASE variant");
    const resultCase = await commitVault(repo, "loom: should be skipped (case variant)");
    check("[3] a drive-letter case variant still matches (commitVault skips, win32-only)", resultCase === false);
    check("[3] case variant: nothing committed", commitCount(git) === 1);
    clearMergeQuarantine(caseVariant);
  } else {
    console.log("[3] (case-variant check skipped — not win32)");
  }

  // Confirm the repo is genuinely clear now and a normal commit lands (negative control — proves [3]'s
  // skips above were the quarantine, not some unrelated breakage).
  const resultAfterAllClears = await commitVault(repo, "loom: should land now");
  check("[3] once every variant is cleared, commitVault() succeeds normally", resultAfterAllClears === true);
  check("[3] the commit actually landed", commitCount(git) === 2);
}

// ═══════════════════ [4] VaultVersioner.flushSync() ALSO checks quarantine ═══════════════════
{
  const repo = path.join(root, "repo4");
  fs.mkdirSync(repo);
  const git = initRepo(repo);
  const versioner = new VaultVersioner(repo, 50);
  await versioner.start();

  fs.writeFileSync(path.join(repo, "note.md"), "# note 4\n");
  enterMergeQuarantine(repo, "some-branch", "test: simulated quarantine for flushSync");
  const flushedWhileQuarantined = versioner.flushSync();
  check("[4] flushSync() returns false while quarantined", flushedWhileQuarantined === false);
  check("[4] flushSync() committed nothing while quarantined", commitCount(git) === 1);

  clearMergeQuarantine(repo);
  const flushedAfterClear = versioner.flushSync();
  check("[4] flushSync() succeeds once the quarantine clears", flushedAfterClear === true);
  check("[4] flushSync()'s commit actually landed", commitCount(git) === 2);
  await versioner.stop();
}

// ═══════════════════ [5] NEGATIVE CONTROL — the WIRING fix, not an incidental side effect of GitWriter ═══════════════════
// THE discriminating scenario: a quarantine raised by something OTHER than a GitWriter op (simulating the
// merge/batch path, which never touches the vault pause lease at all) — no pause lease is ever held here.
// Pre-fix, commitVault had no quarantine awareness whatsoever, so this would commit right through it; this
// is the case that is RED on main and GREEN once the fix lands.
{
  const repo = path.join(root, "repo5");
  fs.mkdirSync(repo);
  const git = initRepo(repo);
  fs.writeFileSync(path.join(repo, "note.md"), "# note 5\n");

  // No pause lease anywhere in this scenario — enterMergeQuarantine simulates a SIBLING op (e.g. a batch
  // assembly or a merge) quarantining the SAME canonical repo via a completely different code path.
  enterMergeQuarantine(repo, "merge-batch-branch", "test: quarantine raised by a NON-GitWriter path, no pause lease held");
  const result = await commitVault(repo, "loom: must be skipped — this is the real wiring gap");
  check("[5] NEGATIVE CONTROL: commitVault SKIPS a quarantine raised with no pause lease ever held (the real gap this card fixes)", result === false);
  check("[5] NEGATIVE CONTROL: nothing committed", commitCount(git) === 1);
  clearMergeQuarantine(repo);
}

// ═══════════════════ [6] commitVault's OWN pre-existing-staged-residue is LOGGED (never refused/built further) ═══════════════════
{
  const repo = path.join(root, "repo6");
  fs.mkdirSync(repo);
  const git = initRepo(repo);

  // Simulate an escaped descendant's orphaned `git add` (already staged, outside commitVault's own
  // knowledge) sitting in the index before commitVault's own "git add ." runs.
  fs.writeFileSync(path.join(repo, "orphaned.md"), "# residue from an escaped descendant\n");
  git("add", "orphaned.md");
  fs.writeFileSync(path.join(repo, "intended.md"), "# the file this commit actually asked for\n");

  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(" ")); };
  let result;
  try {
    result = await commitVault(repo, "loom: auto-commit with pre-staged residue");
  } finally {
    console.warn = origWarn;
  }
  check("[6] commitVault still SUCCEEDS despite pre-existing residue (logged, never refused)", result === true);
  check("[6] both files actually landed in the commit", git("show", "--stat", "HEAD").includes("orphaned.md") && git("show", "--stat", "HEAD").includes("intended.md"));
  check("[6] a [vault-versioner] warning names the pre-existing residue file", warnings.some((w) => w.includes("[vault-versioner]") && w.includes("orphaned.md") && w.includes("already")));
}

// ═══════════════════ [7] PINS THE RE-CHECK ALONE — quarantine raised MID-CALL, after the FIRST check already passed ═══════════════════
// [1]/[3]/[5] above all raise the quarantine BEFORE calling commitVault — the FIRST check catches every
// one of them, so deleting the RE-CHECK (versioner.ts's second `assertRepoNotQuarantined` call, right
// before the real `git commit`) alone would leave every one of those tests GREEN. This test raises the
// quarantine from INSIDE `git add .` itself — i.e. AFTER the first check has already passed clean — via a
// gitFactory seam that delegates every call to a real bounded git instance except `add`, which performs
// the real add and THEN enters the quarantine. Only the RE-CHECK can catch this; deleting it alone must
// turn this test RED (and did, verified below).
{
  const repo = path.join(root, "repo7");
  fs.mkdirSync(repo);
  const git = initRepo(repo);
  fs.writeFileSync(path.join(repo, "note.md"), "# note 7\n");

  let quarantineRaisedMidCall = false;
  function midCallQuarantineGitFactory(repoPath, blockTimeoutMs) {
    const real = boundedSimpleGit(repoPath, blockTimeoutMs);
    return {
      checkIsRepo: (...a) => real.checkIsRepo(...a),
      revparse: (...a) => real.revparse(...a),
      init: (...a) => real.init(...a),
      raw: (...a) => real.raw(...a),
      status: (...a) => real.status(...a),
      commit: (...a) => real.commit(...a),
      add: async (...a) => {
        const result = await real.add(...a);
        if (!quarantineRaisedMidCall) {
          quarantineRaisedMidCall = true;
          enterMergeQuarantine(repo, "mid-call-branch", "test: quarantine raised DURING git add, after the first check already passed");
        }
        return result;
      },
    };
  }

  const result = await commitVault(repo, "loom: must be skipped — quarantine appeared mid-call", { deps: { gitFactory: midCallQuarantineGitFactory } });
  check("[7] precondition: the mid-call quarantine injection actually fired", quarantineRaisedMidCall === true);
  check("[7] commitVault SKIPS when the quarantine appears mid-call, AFTER the first check already passed (pins the RE-CHECK)", result === false);
  check("[7] nothing committed despite the mid-call quarantine", commitCount(git) === 1);
  clearMergeQuarantine(repo);
}

// ═══════════════════ [8] PINS THE FIRST CHECK ALONE — quarantine raised BEFORE the call: the INDEX must stay untouched ═══════════════════
// [1]/[3]/[5] above only assert `commitCount` is unchanged — that holds even if the FIRST check were
// deleted and only the RE-CHECK (after `git add .`) ever caught the quarantine, because either way nothing
// gets committed. Asserting the index is UNTOUCHED (`git diff --cached` empty) is the one observable that
// can only hold if the FIRST check fires BEFORE `git add .` ever runs — without it, `git add .` would
// stage note.md before the re-check caught the (already pre-existing) quarantine and bailed, leaving
// visibly mutated residue in the index despite the call "succeeding" at returning false.
{
  const repo = path.join(root, "repo8");
  fs.mkdirSync(repo);
  const git = initRepo(repo);
  fs.writeFileSync(path.join(repo, "note.md"), "# note 8\n");

  enterMergeQuarantine(repo, "some-branch", "test: quarantine raised BEFORE the call — pins the FIRST check");
  const result = await commitVault(repo, "loom: should be skipped (pins the first check)");
  check("[8] commitVault() SKIPS while quarantined (pre-call)", result === false);
  check("[8] the index is UNTOUCHED — `git add .` never ran (pins the FIRST check, not just the re-check)", git("diff", "--cached", "--name-only").trim() === "");
  check("[8] nothing committed", commitCount(git) === 1);

  clearMergeQuarantine(repo);
  const resultAfterClear = await commitVault(repo, "loom: should land now (after the first-check pin test)");
  check("[8] commitVault() succeeds once the quarantine clears", resultAfterClear === true);
  check("[8] the commit actually landed", commitCount(git) === 2);
}

console.log(failures === 0
  ? "\nALL PASS — commitVault()/VaultVersioner.flushSync() refuse to mutate a QUARANTINED governing repo (keyed on the resolved toplevel, spelling-variant-safe), regardless of whether a GitWriter pause lease was ever involved; commitVault's own pre-existing-staged-residue risk is logged, never built into a refusal; the first check and the re-check are each independently pinned."
  : `\n${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
