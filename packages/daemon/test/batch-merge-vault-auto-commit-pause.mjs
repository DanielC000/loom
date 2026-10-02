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
// SCENARIO 2 — a fast-forward refused by a canonical-repo quarantine (`RepoQuarantinedError`, thrown by
// `withCanonicalIndexLock` before the ff-only ever runs) still resumes the lease via `finally` — same
// foreign-pre-existing-lease proof as test/merge-vault-auto-commit-pause.mjs's own scenario 2.
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
const { enterMergeQuarantine, clearMergeQuarantine } = await import("../dist/git/merge-quarantine.js");
const { pauseVaultAutoCommit } = await import("../dist/vault/versioner.js");

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

  // Poll for the lease's appearance rather than a fixed sleep — pauseVaultAutoCommit runs synchronously
  // on entry, so this observes the REAL event (bounded well under HOOK_SLEEP_S, so the hanging post-merge
  // hook is still mid-sleep when this resolves, proving the lease is held WHILE the ff-only call is
  // genuinely still in flight, not merely sometime before it finishes).
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

async function scenarioQuarantinedFfStillResumes(tag) {
  const repo = makeRepo(tag);
  const baseMainSha = git(repo, "rev-parse HEAD");
  const { worktreePath } = await createWorktree(repo, projId, `bmvac-task-q-${tag}-${sfx}`);
  fs.writeFileSync(path.join(worktreePath, "q1.txt"), "q1\n");
  commitAll(worktreePath, "feat(test): q1", GIT_ID);
  const targetSha = git(worktreePath, "rev-parse HEAD");

  // A FOREIGN pre-existing lease — see merge-vault-auto-commit-pause.mjs's own scenario 2 for why this is
  // what lets "never touched the lease" (pre-fix) and "paused+resumed its own lease, clearing this one in
  // the process" (post-fix) actually read differently.
  const leasePath = path.join(repo, ".git", "loom-vault-pause.json");
  pauseVaultAutoCommit(repo, 60_000);
  check("[2] precondition: a foreign pre-existing vault-pause lease is in place before the quarantined fast-forward", fs.existsSync(leasePath));

  enterMergeQuarantine(repo, "unrelated-branch", "test: quarantine refusal must still resume the auto-committer (batch ff path)");
  let result;
  try {
    result = await fastForwardCanonicalMain(repo, baseMainSha, targetSha);
  } finally {
    clearMergeQuarantine(repo);
  }

  check("[2] the quarantined fast-forward is refused", result?.ok === false && result?.quarantined === true);
  check("[2] canonical HEAD did not move", git(repo, "rev-parse HEAD") === baseMainSha);
  check(
    "[2] after the quarantined call returns, no vault-pause lease is left stuck",
    !fs.existsSync(leasePath),
  );
}

try {
  await scenarioFfInFlightHoldsLease(`ff-${sfx}`);
  await scenarioQuarantinedFfStillResumes(`q-${sfx}`);
} catch (e) {
  console.error(e);
  failures++;
}

console.log(failures === 0
  ? "\nALL PASS — fastForwardCanonicalMain now brackets its canonical-index mutation in the same vault auto-commit pause/resume lease mergeBranch/GitWriter already hold, and resume survives a quarantine refusal via `finally`."
  : `\n${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
