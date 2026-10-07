# 5b97da80 — the trust lock must not break a live holder

## Narrative

Before this card, `withTrustLock` (`packages/daemon/src/pty/claude-config.ts`) used ONE constant —
`trustLockMs()`, default 5000ms — for two different questions: how long a waiter waits before giving
up, and how old a HELD lock must be before it's assumed abandoned. Conflating them meant a lock held by
a LIVE process for longer than that constant was broken by ANY waiter polling at that moment.

Reproduced with two real OS processes, a shrunk `LOOM_TRUST_LOCK_MS`, and a large synthetic
`.claude.json` (`trust-lock-pid-liveness.mjs` section 0): a late-arriving waiter's first poll already
saw the lock as stale and broke it while the holder was still genuinely alive mid-write — a
double-execution clobber that silently lost one process's trust-write entry. Separately confirmed by
code read: `tryTrustLockOnce` (the GC path) never broke a stale lock, disabling GC removal forever.

### The fix

The lock file's content now records the holder's identity (`{pid, acquiredAt}`, written right after the
exclusive `wx` create). `shouldBreakLock` breaks a held lock on EITHER of two independent conditions:

1. **Confirmed-dead holder** (`isPidConfirmedDead`): `process.kill(pid, 0)` only probes existence.
   `ESRCH` means gone (break on the FIRST poll). `EPERM` means it exists but we lack permission (alive
   — e.g. pid 4 "System" on win32, pid 1 "init" on POSIX) — same "unknown == alive" conservatism
   `classifyPathLiveness` uses elsewhere.
2. **Hard age ceiling** (`staleLockCeilingMs()` = `max(10 * trustLockMs(), 60_000)`): REQUIRED. Pure
   pid-liveness is insufficient — pid reuse for an unrelated LIVE process would read "alive" forever,
   worse than the old heuristic. Set far above any realistic hold.

`tryTrustLockOnce` gets the SAME check plus one bounded extra open attempt — still "never sleep, never
loop" — closing the GC-wedge gap above.

### Round 2 (Code Review f82607a6) — four real findings fixed, not hardening

1. **Mtime equality does NOT prove the SAME incarnation (Minor 1).** Measured on a real NTFS host:
   1064/2000 back-to-back wx-create/write/rm cycles landed on an IDENTICAL mtimeMs while `ino` differed
   2000/2000. `shouldBreakLock` now compares dev+ino (bigint stat) AND re-reads `{pid, acquiredAt}`
   before trusting a dead-pid verdict. Two dedicated seams (`__setLockStatSyncForTest`/
   `__setLockContentReadForTest`) make this deterministic in `trust-lock-incarnation-guard.mjs` (A) —
   mutation-verified: disabling either check independently flips a distinct assertion to FAIL.
2. **EPERM pinned as alive (Minor 2).** A lock held by a pid that exists but can't be signalled (pid 4
   on win32, pid 1 non-root POSIX) must never be broken, by `shouldBreakLock` OR `tryTrustLockOnce` —
   pinned against the REAL pid on this host (confirmed it genuinely throws EPERM first).
3. **The `trust_lock_degraded` event had zero coverage (Minor 3).** `createPty`'s trust-lock-and-report
   logic is extracted to `ensureTrustedAndReportDegrade(cwd, sessionId)` so a hermetic test calls it
   directly (fake `PtyHostEvents`, alive-pid held lock, tiny `LOOM_TRUST_LOCK_MS`), no real pty spawn.
   Covers the event firing with a reason; does NOT cover `createPty` still calling it.
   `handleTrustLockDegraded` is separately proven to append a real, readable event.
4. **A stuck lock refroze the WHOLE daemon on every spawn (Minor 4, ruling: fix it).** A stuck lock made
   EVERY non-fast-path `ensureTrusted` sleepSync the FULL `trustLockMs()` again — up to ~12 freezes in a
   spawn burst, vs. one. A per-process memo of already-waited-out INCARNATIONS (dev+ino) makes a SECOND
   call against the SAME incarnation degrade immediately; a different one gets its own fresh wait.

### What this card does NOT fix (an accepted, separate tradeoff)

A waiter correctly NOT broken (holder alive) whose OWN acquire deadline elapses before the holder
releases still writes WITHOUT the lock (`EnsureTrustedResult.locked: false`) — the same best-effort
clobber risk the lock has always had; `ensureTrusted` must never refuse to write. Observability changed
(item 3 above), not this. `sleepSync`'s event-loop block is also kept: `createPty` calls this
synchronously by design, so async would need a much bigger refactor.

## Do not

- Do not reuse one constant for both the acquire deadline and the staleness threshold.
- Do not remove the hard ceiling or make pid-liveness the sole break condition (OS-pid-reuse wedge).
- Do not trust a dead-pid verdict without re-verifying the SAME incarnation — dev+ino AND content, not
  mtime alone (Minor 1 — a real, measured collision, not a theoretical worry).
- Do not treat EPERM as dead — only ESRCH is (Minor 2).
- Do not make `ensureTrusted` refuse or delay a write when the lock can't be acquired.
- Do not try to eliminate the give-up-degrade clobber risk by shrinking the acquire deadline.
- Do not wire a durable-event write directly into `claude-config.ts` — shared by the in-process daemon
  (DB access) and the standalone script (none); let each caller decide via `{locked, reason}`.
- Do not remove the per-incarnation stuck-lock memo (Minor 4) — it refreezes the whole daemon on every
  single spawn otherwise, not just the first.
- Do not trust a single clean run of `trust-lock.mjs`/`trust-lock-pid-liveness.mjs`/
  `trust-lock-incarnation-guard.mjs` — all three flake under real OS timing; re-run several times
  (≥10x/≥5x respectively) before trusting a green.

## Source

`packages/daemon/src/pty/claude-config.ts` (`withTrustLock`, `tryTrustLockOnce`, `shouldBreakLock` +
helpers), `pty/host.ts` (`ensureTrustedAndReportDegrade`, `createPty`), `sessions/service.ts`
(`handleTrustLockDegraded`). Card `5b97da80`; Code Review `d68749a8` (round 1), `f82607a6` (round 2).
