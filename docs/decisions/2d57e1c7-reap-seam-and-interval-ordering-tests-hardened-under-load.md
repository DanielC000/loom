# 2d57e1c7 — harden reap-seam and interval-ordering tests under full-gate load (epic 24608d33)

## Do not

- Do not read a kill/failure on either file as a logic bug before checking whether it reproduces on a
  quiet host — both were green serially on main and on the branch, and green together in a 3-lane pool;
  the cause was load/timing-sensitive and unattributed, not a code defect.
- Do not fix this class by widening a wall-clock bound or retry count — anchor the wait to the real
  tracked settle / a real observable condition instead.
- Do not conflate `pty-exit-reap-seam.mjs`'s witness-capture failures with a genuine verification
  rejection — only the former should retry; a real rejection must still fail at once, with its own
  control intact.

## Narrative

Epic `24608d33` child, filed from full merge gate op `e0a9731e` (round 5 of card `0eaaa693`,
2026-10-21, `concurrentGatesMax 2` — a second gate overlapped). Three files went red; the in-gate 3-file
retry also failed. Two were untouched by the branch under review:

- `pty-exit-reap-seam.mjs`: "FAIL witness: creationTime is armed before reap (the filter this card
  protects)".
- `merge-gate-interval-ordering.mjs`: "FAIL (BF) K=2 at N=1 is due (0+2>1): the batch gate ran and FAILED
  ⇒ ok:false, nothing landed by the batch".

Neither reproduced on a quiet host — both green serially on main and on the branch, and green together
in a 3-lane `test-daemon.mjs --only=` pool (n=1 each: "not reproduced", not "cleared"). Cause left
unattributed.

**Fix** (landed ungated 2026-10-21 as main `75f95a88`):
- `pty-exit-reap-seam.mjs`'s witness now retries ONLY an infra capture failure (the process-`creationTime`
  read racing under load — "capture unverified — creationTime stays null (no row found)" in the gate
  log); a genuine verification rejection still fails immediately, with its own control intact.
- `merge-gate-interval-ordering.mjs`'s (BF) scenario now awaits the real tracked settle of the batch
  gate (`awaitTrackedSettle`, polling `PendingOpRegistry.awaitSettleByOpId`) instead of a bare single
  `await` that measured how fast the host happened to run the batch assembly + gate call, not the code
  under test.

Verified on main: build clean; both files `rc=0` under both `LOOM_DEV`/`LOOM_SUPERVISED` states; guards
0.

## Source

`packages/daemon/test/merge-gate-interval-ordering.mjs:357` (and `pty-exit-reap-seam.mjs`),
`@decision 2d57e1c7`. Merged `75f95a8`. Related: `24608d33` (parent epic — full-gate flakes), `0eaaa693`
(round 5, the gate op this was found in).
