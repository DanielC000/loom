# cacc9f8a — trust-lock-pid-liveness case (0): B's deadline must not double as the age-break threshold

## What happened

The 0.31.0 release full gate (`run_gate` op `c2d7db2d`, main `a038054a`) went red on
`trust-lock-pid-liveness.mjs` case (0) under 3-lane gate concurrency. Triage (card `cacc9f8a`, worker
`bfc01ee1`) found it passed 5/5 when run alone. The failing run's output contained `trust lock ... busy
after 500ms — proceeding best-effort (possible clobber)` — `withTrustLock`'s own documented give-up/
degrade path (`claude-config.ts`), not a regression of the `abb17e7f` pid-liveness fix.

Root cause: case (0) ran two real child processes, A (holds the lock, does real read+merge+write work)
and B (a late-arriving waiter). Both read `LOOM_TRUST_LOCK_MS` from their own env — `withTrustLock` uses
that ONE value for two different things inside B's own process: how long B personally waits before
giving up (`deadline = Date.now() + timeout`), and (pre-fix) the age a held lock must exceed before it's
broken. The old test picked `LOOM_TRUST_LOCK_MS=500` specifically so B's age-check would fire just past
A's natural hold — but under real 3-lane gate contention, A's and B's own real I/O-bound work (reading a
large shared `.claude.json`) don't inflate by the same factor, so the margin between "B's age-check
should fire" and "B's own give-up deadline fires" could go negative: B's 500ms deadline expired while A
still genuinely held the lock, and B took the give-up path — an unlocked write that can race A's own
write.

## The fix

Give B's own `LOOM_TRUST_LOCK_MS` a value far beyond any realistic hold A could have (tens of seconds),
so B's own give-up-and-degrade path is never reached, regardless of host speed. This does not change the
deterministic handshake already in place (B waits for the lock file to exist — i.e., for A's
`attemptCreateLock` to have actually succeeded — before attempting itself, via
`_trust-writer-delayed.mjs`); it removes the OTHER source of flakiness, B's own acquire deadline racing
against A's real hold duration.

## The tradeoff this creates

Because `withTrustLock` uses the SAME constant for B's give-up deadline and (pre-fix) the age-break
threshold, making B's deadline generous also makes the age-break threshold generous. A's real hold in
this test (~1-2s) never comes close to a multi-second-or-longer threshold, so on PRE-FIX code the age
check never fires either — pre-fix code, in this specific scenario, now behaves IDENTICALLY to post-fix
code (both just wait for A's natural release and acquire cleanly). This is a real, accepted
consequence, not an oversight: section (0) is no longer this file's RED/GREEN proof for the
age-vs-pid-liveness distinction. That proof still lives in sections (1) and (3) of
`trust-lock-pid-liveness.mjs` — synthetic, single-process scenarios with directly-controlled lock
content and age, verified (by direct inspection and by running `negative-control` against the whole
file) to flip RED on a reverted `shouldBreakLock` and GREEN on the real fix.

Section (0) keeps its value as an end-to-end confirmation that two REAL OS processes never lose a write
under genuine filesystem-level lock contention — a stronger guarantee than a synthetic single-process
test gives — it's just no longer also a regression detector for this one mechanism.

## Do not

- Do not shrink case (0)'s `LOOM_TRUST_LOCK_MS` back down to make it "discriminate" pre-/post-fix again.
  `withTrustLock` uses one constant for both B's give-up deadline and (pre-fix) the age-break threshold;
  any value small enough to make pre-fix break the lock within a realistic test window is also small
  enough that B's own give-up can fire before A's real hold completes, under load — this is the exact
  defect this record fixes, and shrinking it back reintroduces the same flake class.
- Do not remove or weaken sections (1)/(3) of `trust-lock-pid-liveness.mjs` on the theory that case (0)
  already covers the age-vs-pid-liveness distinction. It does not, by design, since this fix.
- Do not conclude a clean run of case (0) alone proves the pid-liveness fix is working — it will pass
  identically whether or not the fix is present. Use `pnpm --filter @loom/daemon negative-control` against
  the whole file (or at least sections 1/3) to validate the fix, not case (0) in isolation.
