# d0952a73 — `explainedBenign` stops discarding the session notice's own classification verdict

## Narrative

Card `d0952a73`: `explainedBenign` threads the SAME `confirmedWrapperDeficit`/`confirmedAnsiStripDeficit`/`confirmedWrapperAwareFusion` verdict the session-facing notice (`deliverHook`, `pty/host.ts` ~line 6012-6036) already branches on, onto the manager-facing `lastMismatchReplay` pull surface. Before this card, that classification was computed and then DISCARDED: `worker_status`/`worker_list` showed only the raw replay (the alarm) with no way to tell it apart from a genuinely UNEXPLAINED one (the same alarm with no acquittal).

`null` means no independent classifier explained this replay as benign — it stays exactly as loud as an established/possible loss, unchanged from before this field existed. Set at the same detection point as the rest of the object, once the three `confirmed*` locals it reads are available.

## Do not

- Do not let a manager-facing pull surface silently drop a classification verdict the session-facing notice already computed — thread it through instead of discarding it.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (the `Live.lastMismatchReplay` field doc, `explainedBenign` clause), as of `main` `d8b3076b`. Extracted by card `b19e70d3` (tranche 10 on `pty/host.ts`); wording unchanged beyond joining wrapped lines and stripping `//` markers.
