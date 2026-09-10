# 361a5520 — `submitOutstanding` (round 2): cleared only on confirmed completion, never mid-retry-ladder

## Narrative

Card 361a5520 round 2 (codex `pty/host.ts`): `submitOutstanding` latches `true` at the top of `submitCodex` — a turn Loom actually submitted is now outstanding — and is the gate behind `firstTurnStarted`/`onTurnCompleted`'s proven false-positive fix (round 1, same card — see `firstTurnStarted`'s own field doc): `armCodexBusyStaleTimer`'s CASE 2 only latches `firstTurnStarted` when `submitOutstanding` is also true, closing a boot-episode false positive the Code Reviewer reproduced (a stale marker satisfying CASE 2's `lastBusyMarkerAt >= enterWrittenAt` check trivially, with `enterWrittenAt` still at its `0` init value).

`submitOutstanding` is deliberately NOT cleared by CASE 3 (retry) or CASE 4 (exhausted) in `armCodexBusyStaleTimer` — a retry ladder or a fail-loud exhaustion is still the same outstanding submitted turn, and a LATER marker sighting can still resolve a CASE-4-exhausted turn into a genuine CASE-2 completion; clearing this early would wrongly suppress that resolution.

It IS cleared by `interruptForRedirectCodex`'s `enterPending` branch — a turn redirected before its own Enter ever went out, so nothing was actually sent and nothing is outstanding; that branch drains directly and never reaches CASE 2 at all, so leaving this set there would wrongly validate a later, unrelated marker sighting as confirming an abandoned turn.

It is deliberately NOT cleared by `interruptForRedirectCodex`'s common (already-confirmed) path — a redirect-interrupted turn that already had a confirmed marker before the interrupt is still the same outstanding turn, now settling via its own re-armed timer. This differs from claude's own `interruptForRedirect` settle-site exclusion (`onTurnCompleted`'s own contract doc) — a reasoned, disclosed divergence, not a defect.

## Do not

- Do not clear `submitOutstanding` on CASE 3 (retry) or CASE 4 (exhausted) in `armCodexBusyStaleTimer` — a later marker sighting can still resolve an exhausted turn into a genuine completion.
- Do not clear `submitOutstanding` on `interruptForRedirectCodex`'s common (already-confirmed) path — the outstanding turn is still the same one, now settling via its own re-armed timer.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (the `Live.submitOutstanding` field doc), as of `main` `8d9fe59d`. Extracted by card `a2a6b2ad` (tranche 11 on `pty/host.ts`); wording unchanged beyond joining wrapped lines and stripping `*` markers.
