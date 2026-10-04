import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 9f5ae011 (round 3) — `removeLeakedCanonicalIndexLockIfSafe` (git/worktrees.ts) gained two new
// guards on top of round 2's (confirmed-kill shape, fresh mtime):
//   (b) an UPPER bound — a lock whose mtime postdates `killConfirmedAt` (the instant OUR OWN kill was
//       confirmed dead, captured by the caller BEFORE calling this) belongs to a DIFFERENT, still-live git
//       process (an IDE refresh, an owner shell, a second daemon) racing us, never our own leaked lock.
//   (c) a PERSISTENCE check — the lock must persist byte-for-byte (same mtime+size) across a short,
//       WITNESSED wait (`LOCK_PERSISTENCE_CHECK_DELAY_MS`): a live process still holding the lock
//       typically renames or rewrites it quickly, so a lock that visibly changes or vanishes during this
//       delay is live, not abandoned.
//
// merge-confirm-verdict-cache-solo-merge-transient.mjs's own real-git-backed scenarios cannot control a
// lock's mtime precisely relative to `killConfirmedAt`, or force a change/disappearance exactly mid-delay
// — this file tests `removeLeakedCanonicalIndexLockIfSafe` DIRECTLY and hermetically instead, against a
// bare `.git` DIRECTORY fixture (no real git init needed — `resolveGitDirsSync` only needs `.git` to be a
// directory to resolve `privateDir` to it, per its own doc in git/repo-lock.ts).
//
// [7] (round 4, CR item 1) also exercises `describeLockGiveUp` directly, against a fake `LockRemovalResult`
// for every `reasonCode` — asserting the EXACT give-up wording, not just that some string came back.
//
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/bounded-git-lock-removal-guards.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerForCleanup } from "./_tmp-fixture.mjs";

const { removeLeakedCanonicalIndexLockIfSafe, describeLockGiveUp } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

function makeRepo() {
  const repo = path.join(os.tmpdir(), `loom-bglrg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  registerForCleanup(repo);
  return repo;
}
const lockPathOf = (repo) => path.join(repo, ".git", "index.lock");

// [1] no-lock: nothing ever written — reasonCode "no-lock", removed:false, resolves fast (no delay).
{
  const repo = makeRepo();
  const t0 = Date.now();
  const r = await removeLeakedCanonicalIndexLockIfSafe(repo, Date.now() - 1000, Date.now());
  const elapsed = Date.now() - t0;
  check("[no-lock] removed is false", r.removed === false);
  check("[no-lock] reasonCode is no-lock", r.reasonCode === "no-lock");
  check("[no-lock] resolves fast (no persistence delay — nothing to wait on)", elapsed < 500);
}

// [2] predates-attempt: lock mtime OLDER than attemptStartedAt -> refused, untouched.
{
  const repo = makeRepo();
  const lp = lockPathOf(repo);
  fs.writeFileSync(lp, "");
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lp, old, old);
  const attemptStartedAt = Date.now();
  const killConfirmedAt = Date.now();
  const r = await removeLeakedCanonicalIndexLockIfSafe(repo, attemptStartedAt, killConfirmedAt);
  check("[predates-attempt] removed is false", r.removed === false);
  check("[predates-attempt] reasonCode is predates-attempt", r.reasonCode === "predates-attempt");
  check("[predates-attempt] lock left on disk", fs.existsSync(lp));
}

// [3] postdates-confirmation (round 3, NEW): lock mtime NEWER than killConfirmedAt -> refused, untouched —
// this is exactly the "live foreign git raced us" shape the round-3 upper bound exists to catch.
{
  const repo = makeRepo();
  const attemptStartedAt = Date.now();
  const killConfirmedAt = Date.now();
  // Well past the production clock-skew tolerance (50ms) — this must read as a genuinely LATER, foreign
  // lock, not just noise from Date.now() vs. fs mtime clock skew (measured ~1-2ms on this host).
  // TIMING-GUARD-SAFE: this wait IS the test's own independent variable, not a race against an
  // unobservable external event — the scenario under test is "a lock written strictly later than
  // killConfirmedAt", and separation-by-elapsed-time is the only way to manufacture that deterministically;
  // there is no condition to poll for instead. 300ms is 6x the 50ms tolerance it must clear.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const lp = lockPathOf(repo);
  fs.writeFileSync(lp, ""); // written well AFTER killConfirmedAt — a foreign process's lock, not ours
  const r = await removeLeakedCanonicalIndexLockIfSafe(repo, attemptStartedAt, killConfirmedAt);
  check("[postdates-confirmation] removed is false", r.removed === false);
  check("[postdates-confirmation] reasonCode is postdates-confirmation", r.reasonCode === "postdates-confirmation");
  check("[postdates-confirmation] lock left on disk (never touch a live foreign process's lock)", fs.existsSync(lp));
}

// [4] persistence check — unstable (round 3, NEW): the lock changes (size) DURING the witnessed wait ->
// refused, untouched (a live process is still actively writing it).
{
  const repo = makeRepo();
  const lp = lockPathOf(repo);
  fs.writeFileSync(lp, "x");
  const attemptStartedAt = Date.now() - 10;
  const killConfirmedAt = Date.now();
  setTimeout(() => { fs.writeFileSync(lp, "xx"); }, 200); // mutate mid-delay, well before the check re-stats
  const r = await removeLeakedCanonicalIndexLockIfSafe(repo, attemptStartedAt, killConfirmedAt);
  check("[unstable] removed is false", r.removed === false);
  check("[unstable] reasonCode is unstable", r.reasonCode === "unstable");
  check("[unstable] lock left on disk (never remove a lock that's still changing)", fs.existsSync(lp));
}

// [5] persistence check — disappeared (round 3, NEW): the lock is REMOVED by something else DURING the
// witnessed wait -> refused (nothing left to remove, and the vanish itself is evidence of a live writer).
{
  const repo = makeRepo();
  const lp = lockPathOf(repo);
  fs.writeFileSync(lp, "");
  const attemptStartedAt = Date.now() - 10;
  const killConfirmedAt = Date.now();
  setTimeout(() => { fs.unlinkSync(lp); }, 200);
  const r = await removeLeakedCanonicalIndexLockIfSafe(repo, attemptStartedAt, killConfirmedAt);
  check("[disappeared] removed is false", r.removed === false);
  check("[disappeared] reasonCode is disappeared", r.reasonCode === "disappeared");
  check("[disappeared] the lock is in fact gone (something else's doing, not ours)", !fs.existsSync(lp));
}

// [6] success: a lock within BOTH bounds, UNCHANGED across the persistence delay -> removed:true.
{
  const repo = makeRepo();
  const lp = lockPathOf(repo);
  const attemptStartedAt = Date.now();
  fs.writeFileSync(lp, "");
  const killConfirmedAt = Date.now();
  const r = await removeLeakedCanonicalIndexLockIfSafe(repo, attemptStartedAt, killConfirmedAt);
  check("[success] removed is true", r.removed === true);
  check("[success] the lock is actually gone from disk", !fs.existsSync(lp));
}

// [7] describeLockGiveUp wording (round 4, CR item 1) — EXACT text for every reasonCode. Round 4 fixed a
// self-contradiction: the caller's own sentence already says the reset "was confirmed-killed", so a
// wrapper clause claiming it "left"/"held" a lock while ALSO saying that lock "may not be ours" is
// incoherent (we can't both have left it and not own it). This asserts the exact wording directly — a
// future edit that reintroduces "left"/"held" ownership language, or re-doubles a phrase already present
// in `removal.reason`, fails here instead of only being noticed by eye in a give-up message.
{
  const lockPath = "/fake/.git/index.lock";
  const cases = [
    {
      removal: { removed: false, reasonCode: "unlink-failed", reason: "EPERM: operation not permitted", lockPath },
      expected: "left a leaked /fake/.git/index.lock that could not be removed (EPERM: operation not permitted)",
    },
    {
      removal: { removed: false, reasonCode: "predates-attempt", reason: "lock mtime predates this attempt", lockPath },
      expected: "found a /fake/.git/index.lock that may not be ours (lock mtime predates this attempt) — before removing it by hand, check whether a git process is still running against this repo first",
    },
    {
      removal: { removed: false, reasonCode: "postdates-confirmation", reason: "lock mtime postdates the kill's own confirmation", lockPath },
      expected: "found a /fake/.git/index.lock that may not be ours (lock mtime postdates the kill's own confirmation) — before removing it by hand, check whether a git process is still running against this repo first",
    },
    {
      removal: { removed: false, reasonCode: "unstable", reason: "the lock changed during the persistence check", lockPath },
      expected: "found a /fake/.git/index.lock that may not be ours (the lock changed during the persistence check) — before removing it by hand, check whether a git process is still running against this repo first",
    },
    {
      removal: { removed: false, reasonCode: "disappeared", reason: "a live process was still actively using it", lockPath },
      expected: "found a /fake/.git/index.lock that vanished during a persistence check (a live process was still actively using it) — likely a live process, not our own leaked lock, so nothing was removed",
    },
    {
      removal: { removed: false, reasonCode: "unresolved-git-dir", reason: "could not resolve the canonical repo's git directory" },
      expected: "could not even be checked for a leaked lock (could not resolve the canonical repo's git directory)",
    },
    {
      removal: { removed: false, reasonCode: "no-lock", reason: "no .git/index.lock is present" },
      expected: "no .git/index.lock is present",
    },
  ];
  for (const { removal, expected } of cases) {
    const actual = describeLockGiveUp(removal);
    check(`[describeLockGiveUp ${removal.reasonCode}] exact wording`, actual === expected);
    if (actual !== expected) console.log(`  expected: ${expected}\n  actual:   ${actual}`);
    // No reasonCode's wording doubles a "may not be ours" / "not our own leaked lock" / "briefly held"
    // clause — the round-4 defect this test guards against.
    check(`[describeLockGiveUp ${removal.reasonCode}] "may not be ours" never doubled`,
      (actual.match(/may not be ours/g) ?? []).length <= 1);
    check(`[describeLockGiveUp ${removal.reasonCode}] never claims ownership it then disclaims ("left"/"held" a lock "that may not be ours")`,
      !/\b(left|held)\b a .* that may not be ours/.test(actual));
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — removeLeakedCanonicalIndexLockIfSafe's upper-bound and persistence-check guards " +
    "(round 3) correctly refuse a lock postdating the kill's own confirmation and a lock that changes or " +
    "vanishes during the witnessed wait, while still removing a genuinely stable, in-window lock, and " +
    "treating no-lock-present as its own fast, non-refusing case; describeLockGiveUp's wording (round 4) " +
    "is exact for every reasonCode and never claims ownership of a lock it also disclaims."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
