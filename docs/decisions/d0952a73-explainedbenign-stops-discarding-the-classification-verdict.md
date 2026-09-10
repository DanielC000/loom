# d0952a73 — `explainedBenign` stops discarding the session notice's own classification verdict

## Narrative

Card `d0952a73`: `explainedBenign` threads the SAME `confirmedWrapperDeficit`/`confirmedAnsiStripDeficit`/`confirmedWrapperAwareFusion` verdict the session-facing notice (`deliverHook`, `pty/host.ts` ~line 6012-6036) already branches on, onto the manager-facing `lastMismatchReplay` pull surface. Before this card, that classification was computed and then DISCARDED: `worker_status`/`worker_list` showed only the raw replay (the alarm) with no way to tell it apart from a genuinely UNEXPLAINED one (the same alarm with no acquittal).

`null` means no independent classifier explained this replay as benign — it stays exactly as loud as an established/possible loss, unchanged from before this field existed. Set at the same detection point as the rest of the object, once the three `confirmed*` locals it reads are available.

The `live.lastMismatchReplay` write itself is positioned AFTER `confirmedWrapperDeficit`/`confirmedAnsiStripDeficit`/`confirmedWrapperAwareFusion` are computed (it used to fire earlier, unconditionally on `replayedEntry !== undefined`, before those three locals existed) — this pull surface needs their verdict to populate `explainedBenign`, and none of the three exists yet any earlier in the block. Nothing between the old and new site reads `live.lastMismatchReplay`, so the move is safe.

`confirmedFusion`/`confirmedDivergedPrior` are deliberately EXCLUDED from the `explainedBenign` discriminant: both REQUIRE `replayedEntry === undefined` in their own conditions, so on the `replayedEntry !== undefined` branch where this write happens they are always null and could never be the explanation for this replay.

## Do not

- Do not let a manager-facing pull surface silently drop a classification verdict the session-facing notice already computed — thread it through instead of discarding it.
- Do not position this write before `confirmedWrapperDeficit`/`confirmedAnsiStripDeficit`/`confirmedWrapperAwareFusion` are computed — `explainedBenign` needs their verdict and none of the three exists yet any earlier in the block.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (the `Live.lastMismatchReplay` field doc, `explainedBenign` clause), as of `main` `d8b3076b`. Extracted by card `b19e70d3` (tranche 10 on `pty/host.ts`); wording unchanged beyond joining wrapped lines and stripping `//` markers.
