# fd4704bc — `GIVE_UP_HOLD_MS` scales its extra wait with paste size, via the shared `scaledExtraMs` shape

Card 844ca34e (deployed at cdbfa311) stopped a give-up/re-mint cycle from re-pasting a stranded
message's body a second time — the composer-doubling corruption that was stranding large kickoffs. It
did not address why the FIRST delivery of a large (~67-70K char) kickoff so often goes unconfirmed in
the first place: `requeueGiveUpOrigin`'s fixed `GIVE_UP_HOLD_MS` (20s) is sized for an ordinary short
dispatch. A kickoff that size routinely takes the real engine tens of seconds to confirm via
`UserPromptSubmit` (measured 57s in production on a session that eventually confirmed cleanly) and can
legitimately run into the hundreds of seconds (pinned project memory
`engine-confirmation-can-lag-minutes-timeouts-assume-seconds` records 232s) — far past the fixed hold,
so the give-up/re-mint/park ladder was declaring the delivery dead and parking it well before the
engine's own hook had any real chance to land.

## The fix

`scaledExtraMs(textLength, aboveChars, bytesPerMs, maxExtraMs)` is a generic linear-with-cap scaling
shape, extracted from `pasteSettleExtraMs`'s own pre-existing formula (which already scales the
pre-Enter settle gap by paste size) so the two settle/hold windows share ONE formula instead of two
independently-invented ones. `giveUpHoldExtraMs` applies it with constants tuned for this much larger
timescale: `GIVE_UP_HOLD_SCALE_ABOVE_CHARS` (8,000) keeps every ordinary worker report/directive/
redirect at EXACTLY zero extra (small-write timing stays byte-identical); only the excess past that
floor is charged, at `GIVE_UP_HOLD_SCALE_BYTES_PER_MS` (1 char/ms), capped at
`GIVE_UP_HOLD_SCALE_MAX_EXTRA_MS` (90s) so a pathological body can't stall a single hold indefinitely.
A ~68,000-char kickoff (~60,000 excess chars) earns ~60s of extra hold per cycle.

Applied at all three `GIVE_UP_HOLD_MS` sites (`requeueGiveUpOrigin` in `pty/host.ts`, and both
`handleGiveUpExhausted`/`handleKickoffGiveUpExhausted` re-mint holds in `sessions/service.ts`) — see
`docs/decisions/73d5c34a-give-up-hold-window-outlasts-one-reconcile-tick.md`'s own "Do not" for why
`sessions/service.ts` must reuse `pty/host.ts`'s hold constant rather than inventing a second one; the
same discipline now applies to its extra-scaling function too.

## Accepted side effect: the park/spawn-broken notice now arrives much later for a huge kickoff

For a ~68-70K-char kickoff, the full give-up/re-mint ladder's worst-case time-to-park grows from roughly
~60s (the pre-this-card, unscaled ladder) to roughly ~240s (several holds, each individually scaled by
`giveUpHoldExtraMs`, chained through the ladder's bounded retry/re-mint budget). This is ACCEPTED, by
owner/manager ruling (card fd4704bc review): a HELD entry never blocks a redirect or any other drain for
the session, and the new worst case still roughly matches the real, measured confirmation lag this card's
own investigation found (pinned memory `engine-confirmation-can-lag-minutes-timeouts-assume-seconds`
records 232s) — so a kickoff that size legitimately needs a comparable amount of real patience before
Loom can honestly conclude delivery failed. Do not shrink the hold/cap to "speed up" the park/notice path
for a large kickoff without re-opening this tradeoff explicitly — that is exactly the premature-exhaustion
behavior this card exists to fix.

## Do not

- Do not widen `GIVE_UP_HOLD_MS` itself (the base constant) to fix this — that delays every small
  write's recovery too, not just a large kickoff's. Scale only the EXCESS over
  `GIVE_UP_HOLD_SCALE_ABOVE_CHARS`.
- Do not give `sessions/service.ts`'s two re-mint holds their own separate extra-scaling constants or
  formula — reuse `giveUpHoldExtraMs` (exported from `pty/host.ts`), mirroring `GIVE_UP_HOLD_MS`'s own
  existing single-source discipline (card 73d5c34a).
- Do not remove the `GIVE_UP_HOLD_SCALE_MAX_EXTRA_MS` cap — the give-up/re-mint ladder already bounds
  how many holds one message can accumulate (`GIVE_UP_REQUEUE_LIMIT`/`GIVE_UP_REMINT_LIMIT`); an
  uncapped per-hold extension would make the whole chain's worst case unbounded too.
- Do not invent a second scaling formula for a future settle/hold window that needs this same shape —
  reuse `scaledExtraMs` with its own constants, the way both `pasteSettleExtraMs` and
  `giveUpHoldExtraMs` already do.
