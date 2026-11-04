# da8b2fc6 — the composer exhaustion bypass must not skip an older, already-queued composer entry

From the 5f825506 CR round 3 (reviewer 9eddf2fa, MERGE) follow-up, untraced at the time: does
`enqueueStdin`'s `composerRecoveryBypassesQueue` let a NEW composer arrival jump an OLDER composer
entry still sitting in `live.pending`?

## Investigation — reachable, confirmed two ways

`composerRecoveryBypassesQueue` (`pty/host.ts`, `enqueueStdin`) used to be defined purely as
`live.contextExhausted && !this.exhaustionHoldAppliesTo(senderId)` — it inspected only global exhaustion
state and the ARRIVING message's own `senderId`, never `live.pending`'s own content. The justifying
comment above it ("there is no real FIFO order left to protect — nothing ahead of it could ever drain
while exhausted anyway") is true for a non-composer entry (exempted from `drainPending`'s own exhaustion
bail by the identical `exhaustionHoldAppliesTo` predicate), but false for an OLDER composer-sender entry
already queued: that entry is exempt from the SAME bail, so it can become independently eligible (its
own `isHumanSubmitHeld` hold, or its own per-entry give-up hold, clearing) with nobody re-checking it
until some unrelated `drainPending`/`reconcile()` call happens to run.

Reproduced hermetically twice (fake-pty seam, `PtyHost`, no real claude):

1. A composer entry (A) arrives while ALSO blocked by a different `idleEligible` conjunct — verified
   both via `isHumanSubmitHeld` (armed through a concurrent raw-terminal write) and via a per-entry
   give-up hold (injected directly onto `live.pending`, the established test pattern) — so A queues
   instead of bypassing.
2. A's OTHER hold clears. Nothing calls `drainPending`/`reconcile()` in between. A sits in
   `live.pending`, now eligible, untouched.
3. A second composer entry (B) arrives. `live.contextExhausted` is still true (only a busy rising edge
   clears it, and none has happened). Pre-fix, `composerRecoveryBypassesQueue` evaluated true for B
   without ever consulting `live.pending`, so B took the immediate-submit path and was written to the
   pty — **before** A.
4. Negative control: inserting one `reconcile()` call between steps 2 and 3 drains A first, and B then
   correctly queues FIFO-behind it — isolating the race window (not the harness) as the cause.

User-visible consequence: REORDERING, not loss. B is delivered before A, but A is never dropped —
firing B's own Stop afterward drains A normally via the ordinary (now non-exhausted) busy-queue path.

## The fix

```js
const olderComposerEntryQueued = live.pending.some((m) => !this.exhaustionHoldAppliesTo(m.senderId));
const composerRecoveryBypassesQueue = live.contextExhausted && !this.exhaustionHoldAppliesTo(senderId) && !olderComposerEntryQueued;
```

Scoped to composer-sender entries only (via the same `exhaustionHoldAppliesTo` predicate), so a queue
holding only non-composer entries (the case the original bypass exists for) is unaffected.

### Why the fall-through path needs no extra drain kick

When `olderComposerEntryQueued` makes `composerRecoveryBypassesQueue` false, B falls through to the
ordinary "held" push (`live.pending.splice(insertAt, 0, entry)`), exactly like any other held arrival.
But `idleEligible` for B is computed SEPARATELY from `composerRecoveryBypassesQueue` (it does not depend
on it), and stays true for B in this scenario — the exhaustion conjunct inside `idleEligible`
(`contextExhaustedHold`) is already exempted for a composer `senderId`, independent of
`composerRecoveryBypassesQueue`. `enqueueStdin`'s existing held-path code already runs
`if (idleEligible) { this.drainPending(sessionId); ... }` immediately after the push, in the SAME call —
no timer, no external event. At that point `live.pending` is `[A, B]`; `drainPending`'s own
exhaustion-aware composer scan (`live.pending.findIndex((m) => !this.isGiveUpHeld(m) &&
!this.exhaustionHoldAppliesTo(m.senderId))`) finds A FIRST (index 0) and drains it alone. B — not part
of that drained run — stays queued, correctly positioned behind A, and drains normally once A's own
turn ends (the same mechanism test (8c) already proves). So A is written before B, and both are
delivered, with zero external events, purely from B's own `enqueueStdin` call. Verified empirically
(repro scripts, both the `isHumanSubmitHeld` and the give-up-hold variant): A's write is observed before
B's, and the pending queue reaches 0 after B's own turn ends.

## Do not

- Do not revert `olderComposerEntryQueued` to simply checking `live.pending.length === 0` — that would
  reintroduce the original bug this record's bypass was designed to fix (5f825506's own Part 2/Round 2:
  a composer recovery message queued behind a genuinely-undeliverable non-composer entry must still
  bypass immediately, or the one write that can clear the exhaustion mark never runs).
- Do not add a timer/poll to force A's drain when B queues — `enqueueStdin`'s own `if (idleEligible)`
  branch already calls `drainPending` synchronously in the same call; a timer would be redundant and
  could itself race a later event.
- Do not assume this scenario requires a per-entry give-up hold specifically — any `idleEligible`
  conjunct holding the older composer entry (isHumanSubmitHeld, a give-up hold, or simply arriving before
  some other conjunct cleared) reproduces the same bypass defect; the fix is agnostic to WHY the older
  entry is still queued.
