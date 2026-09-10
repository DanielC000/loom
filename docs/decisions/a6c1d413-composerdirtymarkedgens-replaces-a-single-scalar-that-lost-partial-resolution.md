# a6c1d413 — `composerDirtyMarkedGens` (a per-generation Map) replaces a single scalar that couldn't tell partial resolution from total resolution

## Narrative

Card `a6c1d413`: `composerDirtyMarkedGens` (`Live` state, `pty/host.ts`) is a per-generation `Map<number, number>` — `gen -> chars that generation's give-up added` to `composerDirtyLen` — that gates the additive mark side the same way `composerDirtyLenClearedByGen` gates the reset side, so an already-marked generation's contribution isn't double-counted.

The bug this replaces: an earlier design used a SINGLE scalar, `composerDirtyMarkedForGen: number | null`, to hold only the MOST RECENT contributor. A confirm of that one generation blindly zeroed the WHOLE additive total — with no way to tell "the whole total is now resolved" from "only the latest contributor is; earlier still-unconfirmed contributors remain genuinely dirty." A `Map` lets `clearComposerDirtyOnConfirm` resolve exactly the contribution(s) a given confirmation actually proves, and leave the rest genuinely dirty.

## Do not

- Do not collapse this back to a single scalar tracking only the most recent contributor — a confirm of that one generation would again blindly zero the whole additive total, silently un-marking still-unconfirmed earlier contributions as clean.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (the `composerDirtyMarkedGens` field doc, `Live` state), as of commit `779f3ce7eccfb6cb3880d285b2016bc0554cc82c`. Extracted by card `6ba35149` (tranche 7 on `pty/host.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `//` comment markers stripped. The field's own base mechanism doc (the `composerDirtyLenClearedByGen`-mirroring gate description, card `3ce3fa39`/`a6c1d413`) remains inline at the same location as a Class-A guard — this record captures only the replaced-design narrative.
