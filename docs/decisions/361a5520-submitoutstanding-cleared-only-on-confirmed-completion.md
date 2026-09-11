# 361a5520 — `submitOutstanding` (round 2): cleared only on confirmed completion, never mid-retry-ladder

## Narrative

Card 361a5520 round 2 (codex `pty/host.ts`): `submitOutstanding` latches `true` at the top of `submitCodex` — a turn Loom actually submitted is now outstanding — and is the gate behind `firstTurnStarted`/`onTurnCompleted`'s proven false-positive fix (round 1, same card — see `firstTurnStarted`'s own field doc): `armCodexBusyStaleTimer`'s CASE 2 only latches `firstTurnStarted` when `submitOutstanding` is also true, closing a boot-episode false positive the Code Reviewer reproduced (a stale marker satisfying CASE 2's `lastBusyMarkerAt >= enterWrittenAt` check trivially, with `enterWrittenAt` still at its `0` init value).

`submitOutstanding` is deliberately NOT cleared by CASE 3 (retry) or CASE 4 (exhausted) in `armCodexBusyStaleTimer` — a retry ladder or a fail-loud exhaustion is still the same outstanding submitted turn, and a LATER marker sighting can still resolve a CASE-4-exhausted turn into a genuine CASE-2 completion; clearing this early would wrongly suppress that resolution.

It IS cleared by `interruptForRedirectCodex`'s `enterPending` branch — a turn redirected before its own Enter ever went out, so nothing was actually sent and nothing is outstanding; that branch drains directly and never reaches CASE 2 at all, so leaving this set there would wrongly validate a later, unrelated marker sighting as confirming an abandoned turn.

It is deliberately NOT cleared by `interruptForRedirectCodex`'s common (already-confirmed) path — a redirect-interrupted turn that already had a confirmed marker before the interrupt is still the same outstanding turn, now settling via its own re-armed timer. This differs from claude's own `interruptForRedirect` settle-site exclusion (`onTurnCompleted`'s own contract doc) — a reasoned, disclosed divergence, not a defect.

## CASE 2 is codex's only turn-completion chokepoint (second site, same decision)

CASE 2 of `armCodexBusyStaleTimer` (the falling busy→idle edge) is codex's ONLY genuine turn-completion chokepoint — the counterpart of claude's `deliverHook` Stop/StopFailure case, which never fires for a codex session at all (no hook relay: `CodexLive.hookToken` is permanently `""`). Before this fix, `turnSeq` stayed structurally `0` forever for every codex session while being reported to managers as an OBSERVED fact. Mirrors claude's own ordering (`deliverHook`, same file: bump the counter immediately before drain).

The Round 2 false positive this record's Narrative section already describes was reproduced empirically at this site: a boot-episode-only marker, zero pty writes, still incremented `turnSeq`.

## Do not

- Do not clear `submitOutstanding` on CASE 3 (retry) or CASE 4 (exhausted) in `armCodexBusyStaleTimer` — a later marker sighting can still resolve an exhausted turn into a genuine completion.
- Do not clear `submitOutstanding` on `interruptForRedirectCodex`'s common (already-confirmed) path — the outstanding turn is still the same one, now settling via its own re-armed timer.

## `hasFirstTurnStarted`'s own site (`pty/host.ts`) — routed through `findAnyLive`, never `this.live.get`

`PtyHost.hasFirstTurnStarted` is routed through `findAnyLive`, never `this.live.get`: a codex session lives in the separate `liveCodex` map, so the old `this.live.get` read used to return this permanently `false` for every codex session — indistinguishable from a session that genuinely never started.

## Do not (2)

- Do not read `hasFirstTurnStarted` via bare `this.live.get` — a codex session lives in the separate `liveCodex` map and would read structurally, permanently `false`, indistinguishable from a session that genuinely never started.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (the `Live.submitOutstanding` field doc), as of `main` `8d9fe59d`. Extracted by card `a2a6b2ad` (tranche 11 on `pty/host.ts`); wording unchanged beyond joining wrapped lines and stripping `*` markers. The "CASE 2 is codex's only turn-completion chokepoint" section above is a second site, same card: `armCodexBusyStaleTimer`'s own CASE 2, extracted by tranche 18. The `hasFirstTurnStarted`'s own site section above is a third site, same card: `PtyHost.hasFirstTurnStarted`'s own doc, extracted by tranche 54.
