import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 87a3c87e — `mergeBranch`/`mergeBranchLocked` (git/worktrees.ts) never bracketed their canonical-repo
// mutation with `pauseVaultAutoCommit`/`resumeVaultAutoCommit`, unlike `GitWriter.commit`/`checkout`/
// `createBranch` (git/writer.ts), which already hold that lease around their own canonical-index mutation
// (`withVaultPauseLease`). This let `VaultVersioner`'s own debounced auto-commit tick interleave with a
// merge's own squash+commit sequence against the SAME canonical repo's working tree/index, with nothing
// pausing the latter.
//
// SCENARIO 1 — a merge in flight (staged-but-not-committed, same hanging-pre-commit-hook idiom as
// test/merge-writer-index-lock.mjs) pauses a concurrent VaultVersioner.commit() tick on the SAME repo.
// RED on pre-fix code: a VaultVersioner.commit() tick fired while the merge's own squash is staged but not
// yet committed (blocked in the hook) sees no pause lease at all, so it runs `git add -A` + `git commit`
// right in the middle of the merge's own in-flight mutation. GREEN once `mergeBranch` brackets its own
// mutation in the same pause/resume lease GitWriter already holds.
//
// SCENARIO 2 — a merge refused by a canonical-repo quarantine (`RepoQuarantinedError`, thrown by
// `withCanonicalIndexLock` BEFORE `mergeBranchLocked` ever runs) still resumes the vault auto-commit pause
// lease via `finally`. Proven by seeding a FOREIGN pre-existing lease before the quarantined call:
// pre-fix, `mergeBranch` never touches the lease at all, so the foreign lease survives UNTOUCHED; post-fix,
// `mergeBranch`'s own pause (on entry) + resume (in `finally`) clears it, since nothing else re-paused
// after it.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-vault-auto-commit-pause.mjs
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit, useOwnLoomHome } from "./_tmp-fixture.mjs";

// HERMETICITY (card 500fe2df): SCENARIO 2 below calls the real enterMergeQuarantine() directly — a real
// durable latch write under LOOM_HOME. Isolate BEFORE the dist import below, same as every other hermetic
// test in this suite.
useOwnLoomHome("loom-mvac-home-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const distVaultDir = path.join(__dirname, "..", "dist", "vault");
const { mergeBranch } = await import(pathToFileURL(path.join(distGitDir, "worktrees.js")).href);
const { enterMergeQuarantine, clearMergeQuarantine } = await import(pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href);
const { VaultVersioner, pauseVaultAutoCommit } = await import(pathToFileURL(path.join(distVaultDir, "versioner.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mvac@loom -c user.name=mvac";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();

const HOOK_SLEEP_S = 3; // long enough that the interleaved vault commit unambiguously fires WHILE the
                         // merge's own commit is still blocked in the hook; short enough to keep the test
                         // fast and to let an orphaned hook process (if ever killed mid-sleep) self-exit
                         // quickly. Same value as test/merge-writer-index-lock.mjs.
const VAULT_FIRE_DELAY_MS = 600; // fired well after the squash has staged (near-instant) but well before
                                  // the hook's sleep ends.
const GUARD_MS = 25_000; // this TEST's own patience — see merge-writer-index-lock.mjs's identical constant
                          // for the full sizing rationale (shared shape, same headroom).

const root = fs.realpathSync(mkdtempManaged("loom-mvac-"));

function makeRepo(tag) {
  const repo = path.join(root, `repo-${tag}`);
  fs.mkdirSync(repo, { recursive: true });
  execSync(`git init -q && git config user.email mvac@loom && git config user.name mvac && git add -A && git ${GIT_ID} commit -q -m init --allow-empty`, { cwd: repo });
  return repo;
}

function makeWorktree(repo, branch, file, content, tag) {
  const wt = path.join(root, `wt-${branch.replace(/\//g, "-")}-${tag}`);
  execSync(`git worktree add -q -b ${branch} "${wt}" HEAD`, { cwd: repo });
  fs.writeFileSync(path.join(wt, file), content);
  execSync(`git add -A && git ${GIT_ID} commit -q -m "${branch} work"`, { cwd: wt });
  return wt;
}

// ONE-SHOT hanging pre-commit hook — same marker-gated shape as merge-writer-index-lock.mjs so only the
// FIRST `git commit` against this repo ever blocks; any later commit (the merge's own, once it finally
// proceeds, or the vault's own post-merge commit) passes through instantly.
function installHangingHook(repo) {
  const hookPath = path.join(repo, ".git", "hooks", "pre-commit");
  fs.writeFileSync(hookPath, `#!/bin/sh\nif [ -f .git/hang-fired ]; then\n  exit 0\nfi\ntouch .git/hang-fired\nsleep ${HOOK_SLEEP_S}\n`);
  fs.chmodSync(hookPath, 0o755);
}

const guard = (ms, label) => new Promise((resolve) => setTimeout(() => resolve({ __guardFired: label }), ms));

async function scenarioMergeInFlightPausesVault(tag) {
  const repo = makeRepo(tag);
  const branch = "loom/vault-pause-test";
  makeWorktree(repo, branch, "file-a.txt", `branch-content-${tag}\n`, tag);
  installHangingHook(repo);

  const versioner = new VaultVersioner(repo, 5000);
  await versioner.start();

  // Fire the merge — its own `git commit` (landing the squash) will hit the hanging hook and block for
  // HOOK_SLEEP_S, leaving the branch's diff STAGED but not yet committed on the canonical repo.
  const mergePromise = mergeBranch(repo, branch, "Vault Pause Test Card");

  // Edit the vault WHILE the merge's own commit is still blocked in the hook — the squash has already
  // staged (fast, well under VAULT_FIRE_DELAY_MS) but not yet committed.
  await new Promise((r) => setTimeout(r, VAULT_FIRE_DELAY_MS));
  fs.writeFileSync(path.join(repo, "vault-note.md"), `# vault edit during merge ${tag}\n`);
  await versioner.commit();

  check(
    "[1] a VaultVersioner.commit() tick fired WHILE the merge is still mid-flight is a no-op (paused) — " +
    "still only the init commit",
    git(repo, "log --oneline").trim().split("\n").length === 1,
  );
  check(
    "[1] the vault edit sits untouched (staged/untracked), not lost or absorbed into the merge's own commit",
    git(repo, "status --porcelain").includes("vault-note.md"),
  );

  const mergeResult = await Promise.race([mergePromise, guard(GUARD_MS, "merge")]);
  check("[1] [guard] the merge settled within the test's patience window (not wedged)", mergeResult?.__guardFired !== "merge");
  check("[1] the merge itself succeeds", mergeResult?.ok === true);
  check(
    "[1] once the merge lands, its own squash commit is the only NEW commit (the vault edit is still untouched)",
    git(repo, "log --oneline").trim().split("\n").length === 2,
  );

  // Once the merge has returned, its `finally` has resumed the auto-committer — the SAME pending vault
  // edit must now commit cleanly.
  await versioner.commit();
  check(
    "[1] once the merge has returned (pause resumed), the SAME pending vault edit now commits",
    git(repo, "log --oneline").trim().split("\n").length === 3, // init, merge's squash commit, vault commit
  );
  check(
    "[1] the vault commit actually landed the vault edit's content",
    (() => {
      try { return execSync("git show HEAD:vault-note.md", { cwd: repo }).toString() === `# vault edit during merge ${tag}\n`; }
      catch { return false; }
    })(),
  );

  await versioner.stop();
}

async function scenarioQuarantinedMergeStillResumes(tag) {
  const repo = makeRepo(tag);

  // A FOREIGN pre-existing lease, simulating some other in-flight op already holding the pause — lets us
  // tell "mergeBranch never touched the lease at all" (pre-fix) apart from "mergeBranch paused+resumed its
  // OWN lease, clearing this one in the process" (post-fix): both leave "no dangling lease of mergeBranch's
  // OWN making" trivially true, but only the fix actually clears this pre-existing foreign one.
  const leasePath = path.join(repo, ".git", "loom-vault-pause.json");
  pauseVaultAutoCommit(repo, 60_000);
  check("[2] precondition: a foreign pre-existing vault-pause lease is in place before the quarantined merge call", fs.existsSync(leasePath));

  enterMergeQuarantine(repo, "nonexistent-branch", "test: quarantine refusal must still resume the auto-committer");
  let result;
  try {
    result = await mergeBranch(repo, "nonexistent-branch", `Throw Test Card ${tag}`);
  } finally {
    clearMergeQuarantine(repo);
  }

  check("[2] the quarantined merge call is refused (never commits anything)", result?.ok === false);
  check("[2] the refusal names the quarantine", /quarantin/i.test(result?.reason ?? ""));
  check(
    "[2] after the quarantined call returns, no vault-pause lease is left stuck — mergeBranch's own pause " +
    "(on entry) was resumed in `finally`, clearing even the pre-existing foreign lease in the process",
    !fs.existsSync(leasePath),
  );
}

try {
  await scenarioMergeInFlightPausesVault(`pause-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  await scenarioQuarantinedMergeStillResumes(`throw-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
} catch (e) {
  console.error(e);
  failures++;
}

console.log(failures === 0
  ? "\nALL PASS — mergeBranch now brackets its canonical-index mutation in the same vault auto-commit pause/resume lease GitWriter already holds, and resume survives a quarantine refusal via `finally`."
  : `\n${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
