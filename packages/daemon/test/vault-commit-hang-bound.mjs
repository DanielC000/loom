import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 54b839c5 — `commitVault` (versioner.ts), THE single vault commit path shared by the auto-committer
// and human UI writes (vault/writer.ts), built a plain `simpleGit(vaultPath)` with NO block timeout and
// NO `GIT_TERMINAL_PROMPT=0`, then ran `add`/`status`/`commit` through the user's own pre-commit hook with
// nothing bounding any of it — the exact hang vector card 816f0056 hardened on `flushSync`'s SHUTDOWN
// path, left open here on the path a human's HTTP request (vault/writer.ts) actually blocks on.
//
// This induces a REAL hang — a genuine `git commit` child blocked inside an actual pre-commit hook
// (`sleep`), not a mocked/injected promise — same proof shape and same reasoning as
// test/merge-hang-does-not-wedge-queue.mjs and test/vault-flush-sync-hang-bound.mjs (see either file's own
// header for why a real hook, not a mock, exercises the actual production spawn path — a fake `git` on
// PATH falls through to the real git.exe on this host and proves nothing).
//
// RED PROOF (performed manually against this SAME file, not committed): reverting ONLY commitVault's
// bounding (`git checkout HEAD -- packages/daemon/src/vault/versioner.ts` against the pre-fix commit),
// rebuilding, and re-running this unchanged test shows Case A's `commitVault` call hanging for the full
// HOOK_SLEEP_S (never resolving within the injected tiny timeout) instead of rejecting quickly — i.e. no
// bound at all, exactly the defect this fix closes. Restoring the fix and rebuilding returns this file to
// green. See the worker's own report for the observed numbers.
//
// Unlike `flushSync` (synchronous `execSync`, so a timeout ABANDONS the shell but the real `git.exe`
// grandchild survives), `commitVault` goes through simple-git's async `spawn`-based runner: on a block
// timeout it calls `spawned.kill("SIGINT")` on the DIRECTLY spawned `git.exe` (no shell wrapper, verified
// against the installed simple-git package — see commitVault's own doc). Whether the killed `git commit`
// still lands a commit object is therefore the SAME kind of race `flushSync`'s own doc describes (depends
// on how far git.exe had progressed before the kill reached it) — this file asserts only what is genuinely
// invariant: the call returns within its bound, the promise REJECTS (never a false success), no partial
// commit is visible IMMEDIATELY after the call settles, and the hook genuinely fired.
// Run after build: node test/vault-commit-hang-bound.mjs
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";

const { commitVault } = await import("../dist/vault/versioner.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const git = (cwd, args) => execSync(`git ${args}`, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();
function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init");
  git(dir, "config user.email vault-commit-hang@example.com");
  git(dir, "config user.name vault-commit-hang-test");
}
// `git rev-list --all --count` is 0 (clean exit) on a fresh repo with no commits yet — unlike `git log`.
const commitCount = (dir) => parseInt(git(dir, "rev-list --all --count").trim() || "0", 10);

// Long enough to be unambiguously distinct from the injected TINY_TIMEOUT_MS bound below, with generous
// headroom over suite contention (same reasoning as merge-hang-does-not-wedge-queue.mjs's own
// HOOK_SLEEP_S comment); short enough that a worst-case (regression) run doesn't burn excessive wall time.
const HOOK_SLEEP_S = 10;
// The injected per-op timeout (VaultGitDeps.timeoutMs, threaded through commitVault's `opts.deps` — the
// SAME test-only injection seam every other bounded git call in this module already accepts). Collapses
// BOTH commitVault tiers (cheap plumbing + working-tree) onto this one small value (see commitVault's own
// doc for why real callers never do this) — small relative to the real production ceilings (15s / 5min)
// so this test settles in a couple of seconds on the fixed code, but not as tiny as this repo's other
// tiny-timeout injections against a never-resolving MOCK git (spawn latency there is structurally zero).
// This runs REAL git spawns (checkIsRepo/revparse/add/status/config x2/commit) — same measured-margin
// reasoning as vault-flush-sync-hang-bound.mjs's own TINY_TIMEOUT_MS: on this host, under load, each real
// op is under ~120ms; 2000ms leaves wide margin over that while keeping HOOK_SLEEP_S (10s) 5x above it.
const TINY_TIMEOUT_MS = 2_000;

// Written via plain fs calls (no bash chmod) — Git for Windows invokes a shebang script via its bundled
// sh regardless of the exec bit; chmod is for POSIX hosts. Same convention as
// merge-hang-does-not-wedge-queue.mjs's/vault-flush-sync-hang-bound.mjs's installHangingHook. Touches a
// marker BEFORE sleeping so a caller can prove the hook genuinely fired, not merely that commitVault
// returned on time — an earlier call (e.g. `git add .`) timing out first would ALSO produce a fast/
// rejected result, indistinguishable from a real hooked-commit hang without this marker (the exact gap a
// Code Reviewer proved on card 816f0056's own test by replication).
function installHangingPreCommitHook(repo) {
  const hookPath = path.join(repo, ".git", "hooks", "pre-commit");
  fs.writeFileSync(hookPath, `#!/bin/sh\ntouch .git/pre-commit-fired\nsleep ${HOOK_SLEEP_S}\ntouch .git/pre-commit-done\n`);
  fs.chmodSync(hookPath, 0o755);
}
const hookFired = (repo) => fs.existsSync(path.join(repo, ".git", "pre-commit-fired"));
const hookDonePath = (repo) => path.join(repo, ".git", "pre-commit-done");
// Polls for an observable event rather than trusting a blind fixed wait.
async function waitForFile(filePath, timeoutMs) {
  try {
    return await sharedWaitUntil(() => fs.existsSync(filePath), { timeoutMs, intervalMs: 100, label: "vault-commit-hang-bound: waitForFile" });
  } catch (err) {
    if (!/waitUntil: timed out/.test(err?.message ?? "")) throw err;
    return fs.existsSync(filePath);
  }
}
// KNOWN, ACCEPTED cleanup risk (same as the sibling hang tests' own note): simple-git's block-timeout kill
// targets the immediate `git.exe` child directly (see commitVault's own doc — no shell wrapper here,
// unlike flushSync's shell-string execSync calls), but the hooked `sleep`/its wrapping `sh` is itself a
// GRANDCHILD of that `git.exe` and is not part of the kill — no job object, no tree kill — so it survives
// and keeps running for the rest of HOOK_SLEEP_S regardless. repoA's directory can therefore stay locked
// (a logged, non-fatal EBUSY from _tmp-fixture.mjs's best-effort cleanup) until that orphan exits on its
// own, up to HOOK_SLEEP_S after this file's process exits. Harmless and self-clearing; not the concern
// this test targets (commitVault's OWN bound on how long IT waits).

{
  // --- Case A: a REAL hung `git commit` (blocked inside an actual pre-commit hook) must not block
  // commitVault past its bounded timeout, must REJECT (never a false success), must not leave a partial
  // commit behind (checked immediately), and must be proven to have actually reached and blocked inside
  // the REAL hook, not merely that some earlier call timed out first.
  const repoA = mkdtempManaged("loom-commit-hang-a-");
  initRepo(repoA);
  installHangingPreCommitHook(repoA);
  fs.writeFileSync(path.join(repoA, "urgent.md"), "edited just before a wedged REST commit\n");
  const beforeA = commitCount(repoA);

  const t0 = performance.now(); // MONOTONIC — survives an NTP/backward clock step (see test/worktrees.mjs)
  let resultA;
  let threwA;
  try {
    resultA = await commitVault(repoA, "loom: write urgent.md (via UI)", { deps: { timeoutMs: TINY_TIMEOUT_MS } });
  } catch (err) {
    threwA = err;
  }
  const elapsedA = performance.now() - t0;

  check(
    `commitVault against a REAL hung pre-commit hook returns within its bounded timeout ` +
    `(${Math.round(elapsedA)}ms, cap ${TINY_TIMEOUT_MS}ms)`,
    // Generous headroom over real spawn latency (see TINY_TIMEOUT_MS's own measured-margin comment) while
    // staying far below HOOK_SLEEP_S — also catches "an earlier call timed out too", not just commit.
    elapsedA < TINY_TIMEOUT_MS * 3,
  );
  check("commitVault against a hung git child REJECTS (bounded, never hangs, never a false success)", threwA !== undefined && resultA === undefined);
  check("the rejection names a bound timeout (not some unrelated git error)", String(threwA?.message ?? "").includes("exceeded"));
  check("commitVault against a hung git child leaves no partial commit behind YET (checked immediately)", commitCount(repoA) === beforeA);
  check("the pre-commit hook genuinely fired (the hang is the REAL hooked commit, not an earlier call timing out first)", hookFired(repoA));

  // Whether the commit OBJECT itself eventually lands is a race decided by how far git.exe got before the
  // kill (see this file's header + commitVault's own doc) — not asserted either way. What IS observable
  // and asserted: the hooked script itself genuinely ran to completion in the background.
  const hookReallyFinished = await waitForFile(hookDonePath(repoA), (HOOK_SLEEP_S + 5) * 1000);
  check(`the hooked script itself genuinely ran to completion (observed via its own done-marker, not a blind timer) within ${HOOK_SLEEP_S + 5}s`, hookReallyFinished);

  // --- Case B (control, on the SAME tiny timeout): an ordinary, un-hung commit still succeeds under the
  // exact same tiny injected timeout — proves the bound doesn't itself break the normal commit path (the
  // distinct failure mode a too-tight timeout would cause, which the card explicitly warns against: a
  // bound that's wrong in THIS direction drops a real user edit).
  const repoB = mkdtempManaged("loom-commit-hang-b-");
  initRepo(repoB);
  fs.writeFileSync(path.join(repoB, "urgent.md"), "edited just before an ORDINARY REST commit\n");
  const resultB = await commitVault(repoB, "loom: write urgent.md (via UI)", { deps: { timeoutMs: TINY_TIMEOUT_MS } });
  check(
    "commitVault under the SAME tiny timeout still commits a normal (un-hung) write",
    resultB === true && commitCount(repoB) === 1,
  );

  console.log(failures === 0
    ? "\nALL PASS — commitVault's git calls are bounded, a hung pre-commit hook is rejected without " +
      "wedging the caller, and an ordinary commit still succeeds under the same bound."
    : `\n${failures} FAILURE(S).`);
  // repoA/repoB were both created via mkdtempManaged, which already registers them for guaranteed cleanup
  // at process exit (card 995be21f) — nothing else to release here.
}

await finishAndExit(failures === 0 ? 0 : 1);
