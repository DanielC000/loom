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
// SCENARIO 2 (card `6e6b342d` round 2) — a merge whose OWN squash commit genuinely fails AFTER admission
// (a failing pre-commit hook, not a pre-admission quarantine) still resumes its OWN vault auto-commit
// pause lease afterward, even though the op's work failed. REWORKED by `6e6b342d`: the pre-`6e6b342d`
// version of this scenario quarantined the repo BEFORE calling `mergeBranch` at all and seeded a FOREIGN
// pre-existing lease, relying on `mergeBranch`'s own pause silently CLOBBERING that foreign lease (the
// very bug `6e6b342d` fixes) as a side channel for detecting "mergeBranch touched the lease". Now that
// pause lives INSIDE the lock (taken at admission, never before a pre-admission quarantine refusal even
// reaches the callback) and a second holder's entry can no longer be clobbered, that old setup would just
// prove "mergeBranch never ran" trivially. This scenario instead observes mergeBranch's OWN entry
// directly — present (via the real lease file) while its own commit is genuinely blocked post-admission,
// absent once the call returns (having failed) — without any foreign-lease side channel.
//
// ⚠️ DOES NOT prove the resume specifically needs `finally` (Code Review round 2, Minor 1): every failure
// path reachable here — the failing hook included — makes `mergeBranchLocked` RETURN `{ok:false,...}`
// normally; it never REJECTS. A plain `resumeVaultAutoCommit()` placed right after the `await`, with no
// `finally` at all, would pass this exact assertion just as well, since nothing here ever skips past it.
// Verified directly: injecting a generic thrown `Error` via a fake `gitFactory` (the same seam used
// successfully below for `fastForwardCanonicalMain`) gets caught internally by `mergeBranchLocked`'s own
// broad, by-design error handling and converted to a structured `{ok:false, reason: ...}` return — it
// never escapes as a real rejection anywhere this was probed. `batch-merge-vault-auto-commit-pause.mjs`'s
// own scenario 2 is where the `finally`-specific claim is actually proven (via a gitFactory failure that
// DOES genuinely escape `fastForwardCanonicalMain`, confirmed by NC3: removing that file's `finally` and
// resuming plainly after the `await` makes ITS equivalent assertion go RED) — `mergeBranch` shares the
// exact same bracket SHAPE (pause at admission, resume in that callback's `finally`), so `finally`'s
// correctness there is the best available evidence for this file too, just not independently provable
// here with the seams this codebase currently exposes.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-vault-auto-commit-pause.mjs
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit, useOwnLoomHome } from "./_tmp-fixture.mjs";
import { pollUntil } from "./_timing-guard.mjs";

// HERMETICITY: same hermetic posture as every other test in this suite.
useOwnLoomHome("loom-mvac-home-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const distVaultDir = path.join(__dirname, "..", "dist", "vault");
const { mergeBranch } = await import(pathToFileURL(path.join(distGitDir, "worktrees.js")).href);
const { VaultVersioner } = await import(pathToFileURL(path.join(distVaultDir, "versioner.js")).href);

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
const LEASE_POLL_TIMEOUT_MS = 5_000; // pause now fires at lock admission, essentially immediately for an
                                      // uncontended repo — well under HOOK_SLEEP_S, so a short poll bound
                                      // is enough and a miss here means something is genuinely wrong.

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

// Same one-shot marker-gated shape as installHangingHook, but EXITS NONZERO after the sleep instead of
// succeeding — git aborts the commit on a nonzero pre-commit hook, so this produces a REAL, genuine
// post-admission failure (not a timeout/kill) to prove scenario 2's resume-after-failure against (see
// this file's own header for why that's a weaker claim than "resume survives a throw").
function installFailingHook(repo) {
  const hookPath = path.join(repo, ".git", "hooks", "pre-commit");
  fs.writeFileSync(hookPath, `#!/bin/sh\nif [ -f .git/hang-fired ]; then\n  exit 0\nfi\ntouch .git/hang-fired\nsleep ${HOOK_SLEEP_S}\nexit 1\n`);
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

async function scenarioMutateFailureStillResumes(tag) {
  const repo = makeRepo(tag);
  const branch = "loom/vault-pause-fail-test";
  makeWorktree(repo, branch, "file-b.txt", `branch-content-${tag}\n`, tag);
  installFailingHook(repo);

  const leasePath = path.join(repo, ".git", "loom-vault-pause.json");
  check("[2] precondition: no vault-pause lease exists before the merge starts", !fs.existsSync(leasePath));

  // Fire the merge — its squash stages fine (fast), but its own `git commit` hits the failing hook: blocks
  // for HOOK_SLEEP_S (the observation window below), then the hook exits nonzero and the commit genuinely
  // fails — a REAL post-admission failure, not a pre-admission quarantine refusal.
  const mergePromise = mergeBranch(repo, branch, `Mutate Fail Test Card ${tag}`);

  // Poll for the lease's appearance rather than a fixed sleep — pauseVaultAutoCommit now runs as the
  // FIRST thing inside the lock's own callback (card `6e6b342d`), so this observes mergeBranch's OWN
  // lease existing WHILE its own commit is still blocked in the failing hook — proving pause fired at
  // admission and genuinely brackets this (about to fail) attempt, with no foreign lease involved.
  const leaseAppeared = await pollUntil(() => fs.existsSync(leasePath), { timeoutMs: LEASE_POLL_TIMEOUT_MS });
  check("[2] the vault-pause lease IS held while the merge's own commit is still mid-flight (blocked in the failing hook)", leaseAppeared);

  const result = await Promise.race([mergePromise, guard(GUARD_MS, "merge")]);
  check("[2] [guard] the merge settled within the test's patience window (not wedged)", result?.__guardFired !== "merge");
  check("[2] the merge itself reports failure (the hook made the squash commit fail)", result?.ok === false);
  check(
    "[2] after the failed merge returns, its own pause is resumed despite the failure — no lease left " +
    "stuck (this is a RETURN-based failure, not a throw — see this file's own header for why that does " +
    "NOT discriminate `finally` from a plain post-await resume)",
    !fs.existsSync(leasePath),
  );
}

try {
  await scenarioMergeInFlightPausesVault(`pause-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  await scenarioMutateFailureStillResumes(`fail-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
} catch (e) {
  console.error(e);
  failures++;
}

console.log(failures === 0
  ? "\nALL PASS — mergeBranch now brackets its canonical-index mutation in the same vault auto-commit pause/resume lease GitWriter already holds, taken at lock admission, and resume survives a genuine post-admission failure (see this file's header for why the `finally`-specific claim is proven in batch-merge-vault-auto-commit-pause.mjs instead)."
  : `\n${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
