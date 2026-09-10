# 3ff61275 — mismatch notices need a wall-clock + message-id identity, not just a bare gen number

## Narrative

Card `3ff61275` DoD-7 (MINIMUM VIABLE FIX — a scoped floor beneath DoD-1's still-pending content-retention question, request `0eb43216`): every branch of the mismatch-notice text narrates THIS turn's own write (`gen=${live.submitGeneration}`) but, until this card, identified it by that bare gen number alone — no wall-clock anchor, no message identity.

THE THIRD FIELD INSTANCE (escalation `f1a8dce1`) is exactly this gap: a gen=1 mismatch notice, delivered at gen=2, was read by its recipient ~16 minutes later with an unrelated gen=3 approval already in hand — nothing in the notice text let it tell "this happened 19 minutes ago" apart from "this is about what I'm holding right now", so it misattributed the alarm to the wrong payload and escalated a false total-data-loss report.

All FIVE branches of the mismatch-text ternary (fusion, divergedPrior, wrapperDeficit, ansiStripDeficit, and the generic fallback) share this EXACT lead-in sentence and are equally exposed to the same failure mode regardless of their own conclusion — an "ESTABLISHED, nothing lost" notice is just as mis-attributable as a "possible LOSS" one if the recipient can't tell which payload it's about, so the identity clause is added ONCE, to the shared lead-in, rather than to only the fallback branch that happened to be the one hit so far.

`writeWallClockAt` reads the SAME field the `[submit] CONFIRMED` log line a few dozen lines above already reads for this identical generation (`live.currentGenFirstWrittenAt`) — the real Enter-write timestamp for THIS generation, not a detection-time `Date.now()` that would silently drift from when the content actually landed. `writeMsgId` reads the SAME `live.giveUpOrigin?.[0]?.logicalId` pattern that same log line already uses — the originating message's stable id, where one is recorded.

DECIDABILITY: both are rendered as an explicit "unrecorded"/"none recorded" word when absent — never an empty/blank field a reader could misread as "there was no write" (see card `280309d9` for the structured-`detail` counterpart of this same discipline).

## Do not

- Do not identify a mismatch notice's own turn by a bare gen number alone — a reader with an unrelated later generation already in hand cannot tell how stale the alarm is without a wall-clock anchor and a message id.
- Do not add the identity clause to only the branch that happens to motivate it — all five `mismatchText` branches share the same lead-in and are equally exposed.
- Do not leave an absent `writeWallClockAt`/`writeMsgId` as an empty/blank field — render it as an explicit "unrecorded"/"none recorded" word so it can't be misread as "there was no write".

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (`deliverHook`'s `UserPromptSubmit` case, the mismatch-notice shared lead-in). Extracted by card `96bf8f32` (tranche 22 on `pty/host.ts`); wording condensed, content preserved.
