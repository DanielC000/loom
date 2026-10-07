import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 87a3c87e — `fastForwardCanonicalMain` (git/batch-merge.ts), the batch landing path's own ONE
// canonical-mutating call (the `git merge --ff-only` that advances canonical main), never bracketed that
// mutation with `pauseVaultAutoCommit`/`resumeVaultAutoCommit` either — the same gap `mergeBranch`
// (git/worktrees.ts, covered by test/merge-vault-auto-commit-pause.mjs) had. The per-candidate cherry-pick
// landing itself happens in the batch WORKTREE, never the canonical repo, so it needs no bracket; only the
// fast-forward does.
//
// SCENARIO 1 — a fast-forward in flight (blocked in a hanging post-merge hook — `git merge --ff-only` runs
// its post-merge hook SYNCHRONOUSLY as part of the same git invocation, so this widens the window the same
// way a hanging pre-commit hook widens `mergeBranch`'s own squash+commit window) holds the vault-pause
// lease for the WHOLE call, not just the `--ff-only` itself.
//
// SCENARIO 2 (card `6e6b342d` round 2) — a fast-forward that is genuinely ADMITTED (its own lease taken)
// but then THROWS from inside the lock callback still resumes its lease via the callback's own `finally`.
// REWORKED TWICE by `6e6b342d`: round 1 quarantined the repo BEFORE calling `fastForwardCanonicalMain` at
// all and seeded a FOREIGN pre-existing lease, relying on the pre-fix single-overwrite CLOBBER (the bug
// `6e6b342d` fixes) as a side channel — once pause lives inside the lock, that proves nothing. Round 1's
// replacement (a wrong `expectedBaseSha` forfeit refusal) was ALSO not discriminating (Code Review Minor
// 1): a forfeit refusal RETURNS `{ok:false}`, it never throws — so a plain `resumeVaultAutoCommit()` call
// placed right after the `await`, with no `finally` at all, would have passed this test just as well. Round
// 2 (this version) injects a REAL, genuinely escaping THROW via a fake `gitFactory` whose first call fails
// synchronously — `batch-merge.ts`'s own `boundedGit`/`boundedMergeGit` construct `deps.gitFactory(...)`
// with NO try/catch around it (confirmed directly with a standalone probe before writing this), so the
// throw propagates all the way out of `fastForwardCanonicalMain`, uncaught — the one thing a forfeit
// refusal could never do. This STILL keeps the admission-gating proof (hold the lock externally, sample
// mid-hold) from round 1, since that property is independently useful and already set up here.
//
// Run: 1) build daemon (pnpm build), 2) node test/batch-merge-vault-auto-commit-pause.mjs
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome, mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { pollUntil } from "./_timing-guard.mjs";

useOwnLoomHome("loom-bmvac-home-");
requireHermeticEnv();

const { createWorktree } = await import("../dist/git/worktrees.js");
const { fastForwardCanonicalMain } = await import("../dist/git/batch-merge.js");
const { withCanonicalIndexLock } = await import("../dist/git/repo-lock.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=bmvac@loom -c user.name=bmvac";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const projId = `bmvac-proj-${sfx}`;

const root = fs.realpathSync(mkdtempManaged("loom-bmvac-"));

function makeRepo(tag) {
  const repo = path.join(root, `repo-${tag}`);
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# batch-merge-vault-auto-commit-pause\n");
  execSync("git init -q && git config user.email bmvac@loom && git config user.name bmvac", { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}

const HOOK_SLEEP_S = 3; // same sizing rationale as merge-vault-auto-commit-pause.mjs / merge-writer-index-lock.mjs
const CHECK_DELAY_MS = 1500; // poll timeout for the lease's appearance — comfortably below HOOK_SLEEP_S*1000
                              // so a successful poll proves the lease appeared WHILE the hook is still
                              // mid-sleep, not merely sometime before the whole call eventually finishes
const GUARD_MS = 25_000;
const LOCK_HOLD_MS = 1200; // scenario 2's own externally-held lock window — comfortably above normal
                            // process/scheduling jitter (tens of ms) so a mid-hold sample is unambiguous,
                            // short enough to keep the test fast.

// ONE-SHOT hanging post-merge hook (ff-only's own hook, not pre-commit — a fast-forward creates no new
// commit object, so pre-commit never fires; post-merge does, and git runs it SYNCHRONOUSLY as part of the
// same `git merge` invocation, widening the window the exact same way a hanging pre-commit hook widens
// mergeBranch's own squash+commit window).
function installHangingPostMergeHook(repo) {
  const hookPath = path.join(repo, ".git", "hooks", "post-merge");
  fs.writeFileSync(hookPath, `#!/bin/sh\nif [ -f .git/hang-fired ]; then\n  exit 0\nfi\ntouch .git/hang-fired\nsleep ${HOOK_SLEEP_S}\n`);
  fs.chmodSync(hookPath, 0o755);
}

const guard = (ms, label) => new Promise((resolve) => setTimeout(() => resolve({ __guardFired: label }), ms));

async function scenarioFfInFlightHoldsLease(tag) {
  const repo = makeRepo(tag);
  const baseMainSha = git(repo, "rev-parse HEAD");
  const { worktreePath } = await createWorktree(repo, projId, `bmvac-task-${tag}-${sfx}`);
  fs.writeFileSync(path.join(worktreePath, "f1.txt"), "f1\n");
  commitAll(worktreePath, "feat(test): f1", GIT_ID);
  const targetSha = git(worktreePath, "rev-parse HEAD");

  installHangingPostMergeHook(repo);
  const leasePath = path.join(repo, ".git", "loom-vault-pause.json");
  check("[1] precondition: no vault-pause lease exists before the fast-forward starts", !fs.existsSync(leasePath));

  const ffPromise = fastForwardCanonicalMain(repo, baseMainSha, targetSha);

  // Poll for the lease's appearance rather than a fixed sleep — pauseVaultAutoCommit now runs as the
  // FIRST thing inside the lock's own callback (card `6e6b342d`, taken at admission), so this observes
  // the REAL event (bounded well under HOOK_SLEEP_S, so the hanging post-merge hook is still mid-sleep
  // when this resolves, proving the lease is held WHILE the ff-only call is genuinely still in flight,
  // not merely sometime before it finishes).
  const leaseAppeared = await pollUntil(() => fs.existsSync(leasePath), { timeoutMs: CHECK_DELAY_MS });
  check(
    "[1] the vault-pause lease IS held while the fast-forward is still mid-flight (blocked in its own post-merge hook)",
    leaseAppeared,
  );

  const result = await Promise.race([ffPromise, guard(GUARD_MS, "ff")]);
  check("[1] [guard] the fast-forward settled within the test's patience window (not wedged)", result?.__guardFired !== "ff");
  check("[1] the fast-forward itself succeeds", result?.ok === true);
  check("[1] canonical main actually advanced to the target sha", git(repo, "rev-parse HEAD") === targetSha);
  check(
    "[1] once the fast-forward has returned, the vault-pause lease is resumed (no longer held)",
    !fs.existsSync(leasePath),
  );
}

async function scenarioAdmissionGatedThrowStillResumes(tag) {
  const repo = makeRepo(tag);
  const baseMainSha = git(repo, "rev-parse HEAD");
  const { worktreePath } = await createWorktree(repo, projId, `bmvac-task-q-${tag}-${sfx}`);
  fs.writeFileSync(path.join(worktreePath, "q1.txt"), "q1\n");
  commitAll(worktreePath, "feat(test): q1", GIT_ID);
  const targetSha = git(worktreePath, "rev-parse HEAD");

  const leasePath = path.join(repo, ".git", "loom-vault-pause.json");
  check("[2] precondition: no vault-pause lease exists before anything starts", !fs.existsSync(leasePath));

  // Hold the canonical lock OURSELVES so fastForwardCanonicalMain's own call queues behind it — card
  // `6e6b342d`: pause now fires at LOCK ADMISSION, not at call time, so while we hold the lock, no lease
  // should exist yet even though the call has already been made (fires below).
  const holdPromise = withCanonicalIndexLock(repo, () => new Promise((r) => setTimeout(r, LOCK_HOLD_MS)));

  // A fake gitFactory whose very FIRST call throws synchronously — see this scenario's own header for why
  // this genuinely escapes fastForwardCanonicalMain as a real rejection, not a returned {ok:false}.
  function throwingGitFactory() {
    throw new Error("INJECTED_SYNC_THROW (card 6e6b342d round 2, Minor 1)");
  }
  const ffPromise = fastForwardCanonicalMain(repo, baseMainSha, targetSha, { gitFactory: throwingGitFactory });

  await new Promise((r) => setTimeout(r, LOCK_HOLD_MS / 2)); // sample mid-hold
  check(
    "[2] precondition: while a DIFFERENT op still holds the canonical lock, fastForwardCanonicalMain's " +
    "own lease has NOT been taken yet (it is still queued, not admitted) — our own hold has NOT yet " +
    "released at this sample point, by construction (LOCK_HOLD_MS/2 is strictly inside the LOCK_HOLD_MS " +
    "window our own setTimeout above is still running), so admission past this point can only mean the " +
    "lock itself failed to serialize — not a timing coincidence this check could get lucky on",
    !fs.existsSync(leasePath),
  );

  await holdPromise;

  let threw = false;
  let thrownMessage = "";
  let raced;
  try {
    raced = await Promise.race([ffPromise, guard(GUARD_MS, "ff")]);
  } catch (e) {
    threw = true;
    thrownMessage = e?.message ?? String(e);
  }
  check("[2] [guard] the fast-forward settled within the test's patience window (not wedged)", threw || raced?.__guardFired !== "ff");
  check(
    "[2] the injected gitFactory failure genuinely ESCAPES as a throw (not caught/returned as {ok:false}) " +
    "— a plain resume-after-await with no `finally` would also pass a return-based check, so only a real " +
    "throw makes the next assertion meaningful",
    threw && thrownMessage.includes("INJECTED_SYNC_THROW"),
  );
  check("[2] canonical HEAD did not move", git(repo, "rev-parse HEAD") === baseMainSha);
  check(
    "[2] after the throw propagates out, no vault-pause lease is left stuck — its own admission-time " +
    "pause was resumed in the lock callback's OWN `finally` despite the throw",
    !fs.existsSync(leasePath),
  );
}

try {
  await scenarioFfInFlightHoldsLease(`ff-${sfx}`);
  await scenarioAdmissionGatedThrowStillResumes(`q-${sfx}`);
} catch (e) {
  console.error(e);
  failures++;
}

console.log(failures === 0
  ? "\nALL PASS — fastForwardCanonicalMain now brackets its canonical-index mutation in the same vault auto-commit pause/resume lease mergeBranch/GitWriter already hold, taken at lock admission, and resume survives a post-admission refusal via `finally`."
  : `\n${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
