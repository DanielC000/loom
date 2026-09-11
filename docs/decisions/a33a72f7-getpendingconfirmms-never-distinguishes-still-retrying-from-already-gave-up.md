# a33a72f7 — `getPendingConfirmMs` closes `composerDirtyLen`'s blind window, but never distinguishes "still retrying" from "already gave up"

## Narrative

Card `a33a72f7`: `getPendingConfirmMs` is a purely additive read of two fields `fireEnterAndVerify`/the
`UserPromptSubmit` hook already maintain for `latencyMs` logging — milliseconds elapsed since the CURRENT
generation's first Enter write (`Live.currentGenFirstWrittenAt`), for as long as that write remains
unconfirmed (`!Live.enterConfirmed`). Nothing here writes, times out, or changes when Loom gives up.

It exists to close a blind window `composerDirtyLen` leaves open: that field only ever becomes non-zero
once a give-up/heal-if-stuck actually FIRES (`FIRST_TURN_STALE_MS` 30s or `GIVE_UP_HOLD_MS` 20s, plus
retry time after the write) — so a manager glancing at a worker in that window sees a `0` indistinguishable
from a genuinely clean composer. This getter has no such floor: it reads non-null the INSTANT a write is
outstanding and keeps counting every ms after.

`undefined` means the session isn't live in this process (mirrors `getComposerDirtyLen`'s own
undefined-vs-0 discipline). `null` means nothing is currently outstanding — either no `submit()` has ever
run, or the current generation already confirmed (`enterConfirmed === true`); these two are NOT
distinguished from each other, deliberately: no manager decision turns on telling them apart, and
conflating them costs nothing extra bad — unlike the ambiguity below, which does.

## What this does NOT distinguish — read alongside `composerDirtyLen`, never instead of it

A non-null reading means ONLY "the current generation's Enter has been written and no confirming hook has
landed for it yet." It stays non-null identically whether Loom is still WITHIN its own give-up budget
(still retrying, or in `awaitGiveUpConfirmSettle`'s short window) OR has ALREADY given up for this exact
generation (`fireEnterAndVerify`'s GIVE-UP RECOVERY/SUPPRESSED branches touch neither `enterConfirmed` nor
`currentGenFirstWrittenAt` — only `composerDirtyLen`) — give-up firing does not make this field go null.

So a large `unconfirmedDeliveryMs` alone never proves "still trying" vs. "already gave up, outcome still
unknown" for THIS generation — cross-check `composerDirtyLen`: zero there while this reads non-null is the
ONE case unambiguously new information ("in flight, this session has never given up at all yet"); non-zero
there is ambiguous (may be THIS generation's own give-up, or stale residue from an earlier,
already-superseded generation still awaiting its own confirm-driven clear). Together the two are still
strictly MORE informative than either alone — the entire point of adding this getter rather than reworking
`composerDirtyLen` itself.

## Do not

- Do not read a large `unconfirmedDeliveryMs` alone as proof a generation is still actively retrying — it
  stays non-null identically whether Loom is still trying or has already given up. Cross-check
  `composerDirtyLen`.
- Do not distinguish the `null` case's two sub-causes (never submitted vs. already confirmed) — no manager
  decision turns on telling them apart.

## Source

Inline JSDoc in `packages/daemon/src/pty/host.ts` (`getPendingConfirmMs`'s own method doc), as of this
tranche's starting HEAD (main `f084a831`). Extracted by card `d4415d6b` (tranche 53 on `pty/host.ts`); no
wording changed beyond joining wrapped source lines into flowing paragraphs and stripping `*` markers.
