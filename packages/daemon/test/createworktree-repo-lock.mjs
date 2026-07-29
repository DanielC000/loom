import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card 2fcd5eae — createWorktree's git sequence (`worktree prune` -> `branch --list` -> `worktree
// add`, git/worktrees.ts) had NO per-repo lock, unlike mergeBranch/GitWriter which are already admitted
// through `withCanonicalIndexLock` (git/repo-lock.ts). Two concurrent createWorktree() calls against the
// SAME repo (e.g. two worker_spawn calls admitted by the same cap-admit tick) raced on the shared
// `.git/worktrees/` admin directory.
//
// CAPTURED SPECIMEN (card 6c0a6fe5, run 215/334 under real 8-way host load, preserved at
// worktree-add-race-6c0a6fe5-specimen.log): one concurrent createWorktree()'s `git worktree add` threw
//   fatal: failed to read .git/worktrees/<sibling>/commondir: No error
// while building its OWN new branch — `<sibling>` being the OTHER concurrent call's own worktree key.
//
// MECHANISM ESTABLISHED (add-vs-add, NOT prune-vs-add — refutes the manager's own "sharper suspect"
// hypothesis, using the specimen's own evidence, not a re-derived guess):
//   1. The specimen's error text is `Preparing worktree (new branch '...')` immediately followed by the
//      `fatal:` line, both captured from the SAME simple-git `.raw()` call — i.e. from ONE subprocess
//      invocation of `git worktree add` (that progress line is `add`'s own, printed as it begins; `git
//      worktree prune` never prints it and produced no error anywhere in the trace). The failing read of
//      the sibling's commondir happened INSIDE `add`, not inside a separate `prune` step.
//   2. Confirmed by direct experiment against real git 2.47.0.windows.2 (this host): a sibling
//      `.git/worktrees/<x>/` directory that is genuinely half-written (dir + gitdir present, commondir
//      missing) is NOT fatal to a concurrent `git worktree prune` OR `git worktree list` — both treat it
//      as cleanly "prunable" and move on with no error. `add`'s own internal validation (checked-out-
//      branch / worktree enumeration) is the path that can hit a transient Windows read failure
//      (`errno 0` / "No error" — a classic transient-sharing-violation signature) against a sibling
//      admin directory that is concurrently being written by that sibling's own in-flight `add`. Blind
//      OS-level concurrency (even 40-way, in-process, zero Node-side stagger) did not reproduce the exact
//      git-internal timing on this host in 560 trials — consistent with the specimen's own measured
//      ~0.3% rate; chasing that by sampling is explicitly out of scope for this fix (card 2fcd5eae DoD).
//
// SO: this test does not try to force git's own microsecond-scale internal race (unreproducible on
// demand, by design of the underlying OS I/O timing). Instead — same idiom as
// test/merge-writer-index-lock.mjs's slow pre-commit hook — it uses a SLOW `post-checkout` hook (fires
// during `git worktree add`'s own checkout, real and deterministic, no artificial delay beyond the hook)
// to reliably WIDEN each call's `worktree add` subprocess lifetime to a measurable, comparable duration,
// then proves the actual INVARIANT the fix establishes structurally, every run, with no dependency on
// whether the underlying git-internal race happens to fire this time:
//   - PRE-FIX: two concurrent createWorktree() calls' `worktree add` windows OVERLAP in wall-clock time
//     (nothing serializes them) — this IS the unsafe condition the specimen's race lives inside.
//   - POST-FIX: the same two calls' windows NEVER overlap — call B's locked sequence cannot even start
//     until call A's ENTIRE locked git sequence has finished, so they are strictly ordered.
//
// RED/GREEN, verified manually during development (not a live A/B toggle in this file, per the
// merge-writer-index-lock.mjs precedent): RED against pre-fix dist/git/worktrees.js (overlap detected,
// assertions below fail) — GREEN once createWorktree's prune/branch-list/add sequence is admitted through
// `withCanonicalIndexLock`, rebuilt.
//
// Also proves constraint 1 (board card 2fcd5eae): the lock must NOT wrap `provisionWorktreeDeps` — using
// the injectable `deps.provision` seam (an in-memory fake install, immune to real-subprocess/host timing
// jitter) to directly observe that both calls' install phases run CONCURRENTLY, never serialized behind
// the per-repo git-sequence lock.
//
// Run: 1) build daemon (pnpm build), 2) node test/createworktree-repo-lock.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";

// --- Hermetic LOOM_HOME (paths.ts reads it at import time) ---
const tmpHome = path.join(os.tmpdir(), `loom-cwlock-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { createWorktree, removeWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=cwlock@loom -c user.name=cwlock";

const HOOK_SLEEP_S = 2; // long enough that two concurrent `worktree add` windows unambiguously either
                         // overlap (pre-fix) or don't (post-fix), short enough to keep the test fast.

const repo = path.join(os.tmpdir(), `loom-cwlock-repo-${Date.now()}`);
fs.mkdirSync(repo, { recursive: true });
// A `package-lock.json` marker so provisionWorktreeDeps' `detectPackageManager` picks "npm" and actually
// invokes the injectable `deps.provision` seam below (constraint 1's own test needs a REAL install phase
// to observe, not the silent no-op a lockfile-less repo gets).
fs.writeFileSync(path.join(repo, "package-lock.json"), "{}\n");
execSync(`git init -q "${repo}"`);
execSync(`git -C "${repo}" add -A`);
execSync(`git -C "${repo}" ${GIT_ID} commit -q -m init`);

// SLOW post-checkout hook — fires on EVERY `worktree add` for this repo (no once-only marker: we WANT
// both concurrent calls' checkouts to be slow, to make their windows comparable and overlap-detectable).
// It logs its OWN start/end wall-clock timestamps (tagged by the checked-out BRANCH name — NOT `pwd`:
// git-bash's `pwd` reports its own MSYS mount view, e.g. `/tmp/...`, which does not string-match the
// Windows-style absolute path `createWorktree` returns — a branch name is a plain string both sides agree
// on) to a shared log file. This is the precise signal we need: measuring the whole createWorktree()
// PROMISE's duration would be contaminated by the UNLOCKED phases (mkdir, rev-parse HEAD,
// provisionWorktreeDeps), which legitimately CAN overlap between two calls (constraint 1) — only the
// locked git sequence (prune->branch-list->add, and `post-checkout` fires from inside that `add`) must
// never overlap.
const hookLog = path.join(repo, "hook-timing.log").replace(/\\/g, "/");
const hookPath = path.join(repo, ".git", "hooks", "post-checkout");
fs.writeFileSync(hookPath,
  `#!/bin/sh\n` +
  `BR=$(git rev-parse --abbrev-ref HEAD)\n` +
  `T0=$(node -e "process.stdout.write(String(Date.now()))")\n` +
  `echo "START $BR $T0" >> "${hookLog}"\n` +
  `sleep ${HOOK_SLEEP_S}\n` +
  `T1=$(node -e "process.stdout.write(String(Date.now()))")\n` +
  `echo "END $BR $T1" >> "${hookLog}"\n`);
fs.chmodSync(hookPath, 0o755);

const projectId = "pCwlock";
const taskA = randomUUID();
const taskB = randomUUID();
const worktrees = [];

// Constraint 1 (board card 2fcd5eae): the lock must NOT wrap `provisionWorktreeDeps`. Tested directly via
// the injectable `deps.provision` seam — a slow (but in-memory, subprocess-free — so it can't be
// contaminated by host/spawn jitter the way a wall-clock budget on real subprocess timing would be) fake
// installer that records its OWN start/end, tagged by worktreePath (its first arg). NOTE: since each
// call's OWN provisioning necessarily runs only AFTER that SAME call's OWN (now-serialized) git sequence
// finishes, the two calls' provision windows are naturally staggered too — that staggering alone does
// NOT prove the bug. The actual proof: whichever call's git sequence runs SECOND (queued behind the
// FIRST call's lock) must be able to START its locked git sequence WHILE the FIRST call's provisioning is
// still in flight — proving the first call's provisioning never held the lock the second call is queued
// on. If the fix wrongly swept provisioning into the lock, the second call could not acquire the lock
// until the first call's provisioning (not just its git sequence) had also finished.
const PROVISION_DELAY_MS = 1500;
const provisionEvents = {}; // worktreePath -> {start, end}
function slowProvision(worktreePath) {
  const start = Date.now();
  return new Promise((resolve) => {
    setTimeout(() => {
      provisionEvents[worktreePath] = { start, end: Date.now() };
      resolve({ ok: true });
    }, PROVISION_DELAY_MS);
  });
}

try {
  const [resA, resB] = await Promise.all([
    createWorktree(repo, projectId, taskA, { provision: slowProvision }),
    createWorktree(repo, projectId, taskB, { provision: slowProvision }),
  ]);

  check("[setup] call A's createWorktree succeeded", !!resA?.worktreePath);
  check("[setup] call B's createWorktree succeeded", !!resB?.worktreePath);
  worktrees.push(resA?.worktreePath, resB?.worktreePath);

  // Parse the hook's own log — the ACTUAL wall-clock window each `worktree add`'s checkout (and thus that
  // `add` subprocess as a whole) was alive, keyed by BRANCH NAME so we know which call it belongs to.
  const logLines = fs.existsSync(hookLog) ? fs.readFileSync(hookLog, "utf8").split("\n").filter(Boolean) : [];
  const windows = {}; // branch name -> {start, end}
  for (const line of logLines) {
    const m = line.match(/^(START|END)\s+(\S+)\s+(\d+)$/);
    if (!m) continue;
    const [, kind, branch, ts] = m;
    windows[branch] ??= {};
    windows[branch][kind === "START" ? "start" : "end"] = Number(ts);
  }
  const winA = windows[resA?.branch];
  const winB = windows[resB?.branch];

  check("[setup] hook fired (and was captured) for call A's worktree", !!(winA?.start && winA?.end));
  check("[setup] hook fired (and was captured) for call B's worktree", !!(winB?.start && winB?.end));

  if (winA?.start && winA?.end && winB?.start && winB?.end) {
    console.log(`  A checkout: [${winA.start}, ${winA.end}]  B checkout: [${winB.start}, ${winB.end}]`);
    const overlapStart = Math.max(winA.start, winB.start);
    const overlapEnd = Math.min(winA.end, winB.end);
    const overlapMs = overlapEnd - overlapStart;

    // The property the fix establishes: the two calls' `worktree add` checkout windows (a direct proxy
    // for "was the locked git sequence actually running concurrently") must NEVER overlap — call B's
    // locked sequence cannot start until call A's has fully released the lock.
    check(
      `[lock] the two concurrent createWorktree() calls' \`worktree add\` windows do NOT overlap ` +
      `(serialized) — overlap=${overlapMs}ms`,
      overlapMs <= 0,
    );
  }

  // Constraint 1: both calls' injected provision phases actually ran (detectPackageManager found the
  // package-lock.json marker and invoked the seam). Determine chronological order of the two calls' LOCKED
  // git sequences from the hook windows, then assert the SECOND call's git sequence started WHILE the
  // FIRST call's provisioning was still in flight — proving the first call's provisioning never held the
  // lock the second call queued on.
  const provA = provisionEvents[resA?.worktreePath];
  const provB = provisionEvents[resB?.worktreePath];
  check("[constraint 1] both calls' provision phase ran", !!provA && !!provB);
  if (winA?.start && winB?.start && provA && provB) {
    const [firstBranch, firstProv, secondWin] = winA.start <= winB.start
      ? ["A", provA, winB]
      : ["B", provB, winA];
    console.log(`  first=${firstBranch} provision:[${firstProv.start}, ${firstProv.end}]  second git-window start=${secondWin.start}`);
    check(
      `[constraint 1] the SECOND call's locked git sequence started (at ${secondWin.start}) WHILE the ` +
      `FIRST call's (${firstBranch}) provisioning was still running (ends ${firstProv.end}) — ` +
      `provisioning never held the git-sequence lock`,
      secondWin.start < firstProv.end,
    );
  }

  // Both worktrees/branches must still exist on disk — serialization must not drop or corrupt either.
  check("[integrity] call A's worktree exists on disk", !!resA?.worktreePath && fs.existsSync(resA.worktreePath));
  check("[integrity] call B's worktree exists on disk", !!resB?.worktreePath && fs.existsSync(resB.worktreePath));
  const branches = execSync(`git -C "${repo}" branch --list`, { encoding: "utf8" })
    .split("\n").map((l) => l.replace(/^[*+]?\s*/, "").trim()).filter(Boolean);
  check("[integrity] exactly 2 worker branches exist (no orphan, no loss)",
    branches.filter((b) => b.startsWith("loom/")).length === 2);
} finally {
  for (const wt of [...new Set(worktrees.filter(Boolean))]) { try { await removeWorktree(repo, wt); } catch { /* best-effort */ } }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — two concurrent createWorktree() calls on the same repo never overlap their git sequence (serialized per-repo), while dep-provisioning stays outside the lock."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
