import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card `6e6b342d` (finding c, TTL vs queue wait): a queued mergeBranch/fastForwardCanonicalMain/GitWriter
// op's own vault-pause lease must be taken at LOCK ADMISSION, not at call time. Pre-fix,
// `pauseVaultAutoCommit` ran BEFORE `withCanonicalIndexLock`, so a queued op's TTL silently ticked down
// during the ENTIRE queue wait before its own work even began — an op queued long enough could start
// mutating with an already-expired lease.
//
// Proven directly against `mergeBranch` (git/worktrees.ts): the test holds the canonical lock itself for
// LOCK_HOLD_MS, then calls mergeBranch, which queues behind that hold. It polls for the lease file's
// appearance CONTINUOUSLY starting right after the call (not after awaiting the hold) and measures the
// ELAPSED time from call to first observed appearance via `performance.now()` (monotonic — immune to a
// wall-clock adjustment mid-test, unlike `Date.now()` subtraction). Pre-fix, `pauseVaultAutoCommit` runs
// at CALL time regardless of the lock, so the lease file appears almost immediately — elapsed ≈ 0.
// Post-fix, it only appears once admitted — elapsed ≈ LOCK_HOLD_MS. Round 2 (Code Review Nit 1): dropped
// the earlier version's upper-bound check (the lower bound alone already discriminates pre-fix from
// post-fix; an upper bound only risked spurious failure under host load with no added discriminating
// power) and switched the elapsed measurement from `Date.now()` subtraction to `performance.now()`.
//
// Run: 1) build daemon (pnpm build), 2) node test/vault-pause-lease-admission-timing.mjs
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit, useOwnLoomHome } from "./_tmp-fixture.mjs";
import { pollUntil } from "./_timing-guard.mjs";

useOwnLoomHome("loom-vpla-home-");
requireHermeticEnv();

const { mergeBranch } = await import("../dist/git/worktrees.js");
const { withCanonicalIndexLock } = await import("../dist/git/repo-lock.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=vpla@loom -c user.name=vpla";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();

const LOCK_HOLD_MS = 2_000; // comfortably above scheduling jitter (tens of ms) — the discriminating
                             // signal below is roughly this size, so it can't be explained by jitter alone
const HOOK_SLEEP_S = 3; // extends the post-admission window so the lease file can be read reliably
const GUARD_MS = 25_000;
const POLL_TIMEOUT_MS = LOCK_HOLD_MS + 10_000; // generous — must comfortably outlast LOCK_HOLD_MS so a
                                                 // correctly-admission-gated lease still has time to appear
const TOLERANCE_MS = 1_000; // generous slack for process/scheduling jitter — tiny next to LOCK_HOLD_MS,
                             // so it can't paper over a real gap

const root = fs.realpathSync(mkdtempManaged("loom-vpla-"));

function makeRepo(tag) {
  const repo = path.join(root, `repo-${tag}`);
  fs.mkdirSync(repo, { recursive: true });
  execSync(`git init -q && git config user.email vpla@loom && git config user.name vpla && git add -A && git ${GIT_ID} commit -q -m init --allow-empty`, { cwd: repo });
  return repo;
}

function makeWorktree(repo, branch, file, content) {
  const wt = path.join(root, `wt-${branch.replace(/\//g, "-")}`);
  execSync(`git worktree add -q -b ${branch} "${wt}" HEAD`, { cwd: repo });
  fs.writeFileSync(path.join(wt, file), content);
  execSync(`git add -A && git ${GIT_ID} commit -q -m "${branch} work"`, { cwd: wt });
  return wt;
}

// Same ONE-SHOT marker-gated shape as merge-vault-auto-commit-pause.mjs's own hanging hook.
function installHangingHook(repo) {
  const hookPath = path.join(repo, ".git", "hooks", "pre-commit");
  fs.writeFileSync(hookPath, `#!/bin/sh\nif [ -f .git/hang-fired ]; then\n  exit 0\nfi\ntouch .git/hang-fired\nsleep ${HOOK_SLEEP_S}\n`);
  fs.chmodSync(hookPath, 0o755);
}

const guard = (ms, label) => new Promise((resolve) => setTimeout(() => resolve({ __guardFired: label }), ms));

const repo = makeRepo("admit");
const branch = "loom/vault-pause-admit-test";
makeWorktree(repo, branch, "file.txt", "content\n");
installHangingHook(repo);

const leasePath = path.join(repo, ".git", "loom-vault-pause.json");
check("precondition: no vault-pause lease exists before anything starts", !fs.existsSync(leasePath));

// Hold the canonical lock OURSELVES, then call mergeBranch — it queues behind our hold.
const holdPromise = withCanonicalIndexLock(repo, () => new Promise((r) => setTimeout(r, LOCK_HOLD_MS)));
const callTimePerf = performance.now();
const mergePromise = mergeBranch(repo, branch, "Admission Timing Test Card");

// Poll CONTINUOUSLY from right after the call (not after awaiting the hold) — this is what lets the
// elapsed measurement discriminate: pre-fix, the lease would already exist by the FIRST poll tick.
const leaseAppeared = await pollUntil(() => fs.existsSync(leasePath), { timeoutMs: POLL_TIMEOUT_MS });
const elapsedToLeaseMs = performance.now() - callTimePerf;
check("the lease appears once admitted (while the merge's own commit is blocked in the hook)", leaseAppeared);
check(
  `the lease does NOT appear until roughly LOCK_HOLD_MS has elapsed since the call (elapsed=${elapsedToLeaseMs.toFixed(0)}ms via performance.now(), must be >= ${LOCK_HOLD_MS - TOLERANCE_MS}ms) — it must reflect the queue wait, never be written before admission`,
  leaseAppeared && elapsedToLeaseMs >= LOCK_HOLD_MS - TOLERANCE_MS,
);

await holdPromise; // our own hold has long since released by this point — just closing it out cleanly

const raw = leaseAppeared ? JSON.parse(fs.readFileSync(leasePath, "utf8")) : null;
check("the lease file holds exactly one entry (no other concurrent holder)", Array.isArray(raw?.leases) && raw.leases.length === 1);

const result = await Promise.race([mergePromise, guard(GUARD_MS, "merge")]);
check("[guard] the merge settled within the test's patience window (not wedged)", result?.__guardFired !== "merge");
check("the merge itself succeeds", result?.ok === true);
check("after the merge returns, its own lease is resumed (no longer held)", !fs.existsSync(leasePath));

console.log(failures === 0
  ? "\nALL PASS — a queued mergeBranch's own vault-pause lease is taken at LOCK ADMISSION, not at call time (card 6e6b342d)."
  : `\n${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
