# 0d8270b2 — the root-creation capture slack is widened to the measured clock-domain skew; the test
helper retries only genuine infra failures

## Narrative

`pty-root-reap-test-tripwire.mjs` failed its "creationTime is armed" checks ((A), (B), (B4)/(B4a)) 3/3
times on 2026-10-23 ~04:00Z — once inside a real `merge_batch` gate, twice run directly — against code
that had passed a full gate hours earlier. A timeout hypothesis was tried, then DIRECTLY REFUTED: a
sibling file using the same capture failed its own check on a fresh run at only 1.1x ambient overshoot,
with no timeout/exception at all — the capture genuinely ran and returned a verified-null result. Added
diagnostics to `_guard.mjs`'s capture chain (classifying a null as `no-row`/`ppid-mismatch`/`slack-margin`)
and caught it directly, for a genuine REAL witness (not fabricated): `pid=52000: ... row.creationTime=
1792729433618, registeredAt=1792729433614, slack=2, delta=4`. `ppid` matched exactly (a genuine own
child) — only the slack check failed, by 4ms against the 2ms default.

This contradicts `ROOT_CREATION_CAPTURE_SLACK_MS`'s stated invariant (`docs/decisions/87691385-*.md`
round 3, "MINOR 3b"): *"CreateProcess returns before `startedAt` is stamped, so the root's creationTime is
ALWAYS `<= startedAt`; 2ms covers rounding only."* That is empirically false: a genuine, correctly-ppid-
matched child's WMI `CreationDate` can land a few ms AFTER Node's `Date.now()` read — clock-domain/
read-timing skew this investigation measured but did not fully characterize mechanically.

Measured the recurrence rate via two independent failure-rate campaigns (fresh `node` process per trial):
1 failure in 44 runs of `pty-exit-reap-seam.mjs`, and 1 in 215 trials of an isolated
`armWitnessWithFreshRetry(…, {attempts:1})` stress script — roughly 0.5–2%, rare but real, not dependent
on heavy host load (both catches at ≈1.0–1.2x ambient overshoot). **What is NOT recorded, and must not be
cited: no raw script output, no full distribution, no min/max (including any negative-side skew) beyond
the two rates above and the one `delta=4ms` catch.** An earlier draft of this record and of
`docs/decisions/87691385-*.md` round 7 asserted a "~950-trial campaign" with "a tail up to +4ms, roughly
symmetric noise in [-28,+4]ms" — **withdrawn**: not substantiated by anything actually retained, and never
re-derived before being repeated elsewhere (project memory included). If a fuller campaign is ever run and
its raw data kept, update this record with the real method/script/n — don't repeat the withdrawn figure.

Confirmed this was never a *silent* production bug: `verifyRootDeadOrForceKill`'s guard 2 already treats a
null `creationTime` as `"owner-creation-time-unavailable"` and REFUSES rather than unsafely proceeding
(`@decision 87691385`, fails-safe). Pre-fix, the same rare miss only ever produced an occasional, overly-
conservative refusal (under-kill) — but that IS a real production correctness gap (an avoidable loss of
the reap/kill filter's coverage for the affected session), which is why the fix below is a PRODUCTION
change, not test-only.

## The fix

1. **PRODUCTION: `ROOT_CREATION_CAPTURE_SLACK_MS` raised 2ms→20ms** (`pty/win32-root-creation.ts`) —
   ~5x the one measured worst case (+4ms), and above the classic Windows clock-interrupt granularity
   (~15.625ms) as a second ceiling. This is the real fix. See `docs/decisions/87691385-*.md` round 7 for
   the full write-up, including the one residual it does NOT close (below).
2. **TEST: `_guard.mjs` classifies WHY a verification failed** (`CAPTURE_REJECTION_REASONS`: pid →
   `"no-row"`/`"ppid-mismatch"`/`"slack-margin"`/`"infra"` — the last added in round 2, item 4) instead of
   discarding the reason.
3. **TEST: `armWitnessWithFreshRetry(spawnCandidate, {attempts=5})`** retries with a BRAND NEW candidate
   (never re-querying the same pid — `row.creationTime`/`registeredAt` are fixed once set) **on a genuine
   INFRA failure ONLY** (the spawn/CIM call itself threw/rejected). **Every verification rejection —
   `no-row`, `ppid-mismatch`, `slack-margin` — is HARD and NEVER retried**: retrying past a slack-margin
   miss would mask a future regression of the production fix (item 1); `ppid-mismatch`/`no-row` are
   already the genuine pid-reuse signals this mechanism exists to catch loudly. Mirrors
   `pty-exit-reap-seam.mjs`'s own pre-existing "only infra retries" design. A bounded, logged backoff
   (`INFRA_RETRY_BACKOFF_MS = [250,500,1000,2000]`) sits between infra retries only — 5 attempts /
   ~3.75s total, not a blind wait. Scenarios (A)/(B)/(B4) in the tripwire file use this helper.
4. **TEST, round 2: infra-vs-hard-reject is decided PER PID, never via the GLOBAL `CAPTURE_STATS.failed`
   counter.** The shipped helper classified a null result as "infra" whenever that global counter had
   advanced since the attempt started — but a concurrent capture failure for a totally unrelated pid, mid-
   await, bumps the SAME counter and could misread THIS pid's own genuine hard rejection as retryable,
   masking exactly the regression this mechanism exists to catch. Fixed: the catch handler now also
   records `"infra"` into `CAPTURE_REJECTION_REASONS` PER PID, and the helper reads THIS pid's own entry,
   never the global count. Pinned by a new `(helper)` scenario (tripwire file) using a `__testHooks` seam
   (test-only) that simulates a concurrent foreign-pid failure while THIS pid gets a `"slack-margin"`
   rejection, and asserts a hard reject with NO retry (one spawn attempt only).
5. **Orthogonal, kept, not the fix:** `_guard.mjs`'s capture timeouts are scaled by ambient load via
   `ambientScaledBudget` (same convention as `dev-server-teardown.mjs`). Harmless, a reasonable hardening
   against a slow CIM query under extreme contention, but not what caused this card's original failure.

## The residual this fix does not close

See `docs/decisions/87691385-*.md` round 7: `ppid === expectedPpid` does the vast majority of the real
pid-reuse-rejection work, independent of slack — but not all of it. A pid reused by ANOTHER of this same
daemon's own children (so `ppid` still matches), created within the slack window after `startedAt`, is
not structurally ruled out; widening the slack 10x widens that window by the same factor. Very improbable,
not impossible: needs the original root dead, the OS handing its exact freed pid to a brand-new,
unrelated `CreateProcess` from this same daemon, within ~20ms of the original spawn. Round 3 of
`87691385` already treated the analogous shape as an accepted residual; this card widens, but does not
newly introduce, that window.

## Do not

- **Do not shrink `ROOT_CREATION_CAPTURE_SLACK_MS` back toward 2ms** on the theory the skew "shouldn't"
  exist — it is measured (one direct +4ms catch), not theorized. See `87691385-*.md` round 7.
- **Do not read the retry helper as retrying slack-margin/ppid-mismatch/no-row** — all three are HARD,
  never retried (item 3). Only a genuine infra failure (spawn/CIM error) retries.
- **Do not classify a null result from the GLOBAL `CAPTURE_STATS.failed` counter** — use
  `CAPTURE_REJECTION_REASONS.get(pid)`, this pid's own entry (item 4). The global counter can advance from
  an unrelated, concurrently-capturing pid mid-await.
- Do not widen the PRODUCTION leaf module's own default `timeoutMs` to change timeout behavior — pass a
  larger `timeoutMs` explicitly from the TEST call site (item 5 already does this).
- Do not retry by re-querying the SAME pid — `row.creationTime`/`registeredAt` are fixed once set; only a
  fresh spawn gives an independent trial.
- Do not raise `AMBIENT_OVERSHOOT_CAP` or add a second multiplier on top — `4x` is the suite's established
  ceiling (shared with `dev-server-teardown.mjs`); change it once, in `_wait.mjs`, not per-caller.
- **Do not cite "~950 trials" or a "[-28,+4]ms" range for this card's measurement** — see the
  "Narrative"'s own explicit note on what is/isn't recorded; don't repeat the withdrawn figure.
