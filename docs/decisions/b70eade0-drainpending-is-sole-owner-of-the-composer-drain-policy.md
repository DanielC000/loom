# b70eade0 — delete the enqueue-side composer fast path; `drainPending` is the sole policy owner

Supersedes `da8b2fc6` (`docs/decisions/da8b2fc6-composer-fifo-bypass-must-not-skip-an-older-queued-composer-entry.md`)
— read that record for the original bug and its fix (`olderComposerEntryQueued`). This record covers
what happened next: a Code Review found that fix redundant, and this card deleted it.

## The finding

A Code Review of `da8b2fc6`'s fix (reviewer `41f3b0bc`, verdict HEALTHY) found
`composerRecoveryBypassesQueue` fully redundant: `drainPending`'s own exhausted-branch composer scan
(`5f825506` round 3, landed BEFORE `da8b2fc6`) already drains the same entry synchronously inside the
same `enqueueStdin` call — the push-then-drain fallthrough every other held entry uses. The only
observable difference was the `[submit-write] reason=` diagnostic label (`"immediate"` vs `"drain"`),
documented diagnostic-only.

Two mutants (against `dist/pty/host.js`, restored byte-identical) confirmed it:

- **M2** — revert `olderComposerEntryQueued` to `live.pending.length === 0` (`da8b2fc6`'s own former
  Do-not #1, which claimed this would reintroduce a never-delivered message). **Stayed GREEN** — that
  Do-not was FALSE; round 3's `drainPending` fix had already closed the strand a second way.
- **M3** — force `composerRecoveryBypassesQueue` to `false` unconditionally (whole bypass gone). Run
  against `context-exhausted-drain-hold.mjs` (8c)/(13)/(14)/(15) +
  `enqueuestdin-push-then-drain-fallthrough.mjs` + `pty-new-arrival-order-after-expired-human-hold.mjs` +
  `composer-input-sender-coalesce.mjs` — **all GREEN**.

## The fix

Deleted `composerRecoveryBypassesQueue` and `olderComposerEntryQueued` entirely from `enqueueStdin`
(`pty/host.ts`), leaving `live.pending.length === 0` as the sole immediate-submit disjunct (still
load-bearing for the empty-queue case — pinned by `context-exhausted-drain-hold.mjs` (14)/(15),
`enqueuestdin-push-then-drain-fallthrough.mjs`, and `pty-new-arrival-order-after-expired-human-hold.mjs`
(the reviewer's mutant E); NOT by test (7)/mutant B2). A composer entry that can't take that
disjunct now falls, unconditionally, to the ordinary held-push path, whose pre-existing
`if (idleEligible) { this.drainPending(...) }` drains it via the composer scan — one policy owner, not
two.

**Independent confirmation:**

- A whole-file negative control (`pnpm --filter @loom/daemon negative-control --file
  packages/daemon/src/pty/host.ts --ref 16975327 --test
  packages/daemon/test/context-exhausted-drain-hold.mjs`) came back GREEN both phases — expected for a
  behavior-preserving removal, not a failed RED proof.
- A targeted dist mutant (`drainPending`'s `composerIdx` forced to `-1`) run against current code turned
  (8c)/(9)/(9b)/(11a)/(11b)/(12a)/(12c)/(13)/(14)/(15) and the new no-reconcile test (16) ALL RED (46
  failing assertions), restored byte-identical. Proof the plain revert above can't give: every outcome
  pin now depends entirely on `drainPending`'s own scan.

## This rule is REVIEWER-enforced, not test-enforced

Mutant M2 is the load-bearing warning: a revived enqueue-side fast path that is itself gated to match
`drainPending`'s own composer-scan policy produces IDENTICAL outcomes to no fast path at all, by
construction — same entry, same order, same call. No test in this suite (or shaped like it) can tell the
two apart; there's nothing behavioral left to distinguish. The suite only catches a fast path that
DIVERGES from `drainPending`'s policy (the pre-`da8b2fc6` bug shape) — a faithfully-mirrored copy is
invisible to it on principle.

So "do not re-add an enqueue-side composer fast path" below is enforced by a reviewer reading the diff
and recognizing the shape, not by a test oracle going red. A future PR reintroducing a composer-sender
special-case in `enqueueStdin` — however carefully kept in sync with `drainPending`'s scan — can land
fully green. Treat review as the ONLY backstop; it is not a gap to fill with a new test, since the two
implementations being outcome-indistinguishable IS the thing being flagged.

## Do not

- Do not re-add an enqueue-side composer fast path in `enqueueStdin` (a revived
  `composerRecoveryBypassesQueue`/`olderComposerEntryQueued`, or any differently-named equivalent
  special-casing a composer-sender entry against `live.pending`'s content before the ordinary held
  push): `drainPending`'s exhausted-branch composer scan (`5f825506` round 3) is the single policy
  owner — a second copy is exactly where `da8b2fc6`'s own guard used to live, and review is what found
  it redundant, not load-bearing.
- Do not trust the test suite alone to catch a reintroduced fast path shaped like the one above — see
  "This rule is REVIEWER-enforced, not test-enforced." Review the diff for the shape itself; don't wait
  for a failing assertion.
- Do not read a reverted `olderComposerEntryQueued`/`composerRecoveryBypassesQueue` mutant staying GREEN
  as proof `da8b2fc6`'s original bug can't recur by some other means — it stays closed because
  `drainPending`'s composer scan (`5f825506` round 3) scans the WHOLE queue unconditionally; verify
  against THAT mechanism.
- Do not add a timer/poll to force an older composer entry's drain when a newer one queues behind it —
  `enqueueStdin`'s `if (idleEligible)` branch already calls `drainPending` synchronously in the same
  call; a timer would be redundant and could itself race a later event.
