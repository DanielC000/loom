# a6c1d413 — `composerDirtyMarkedGens` (a per-generation Map) replaces a single scalar that couldn't tell partial resolution from total resolution

## Narrative

Card `a6c1d413`: `composerDirtyMarkedGens` (`Live` state, `pty/host.ts`) is a per-generation `Map<number, number>` — `gen -> chars that generation's give-up added` to `composerDirtyLen` — that gates the additive mark side the same way `composerDirtyLenClearedByGen` gates the reset side, so an already-marked generation's contribution isn't double-counted.

The bug this replaces: an earlier design used a SINGLE scalar, `composerDirtyMarkedForGen: number | null`, to hold only the MOST RECENT contributor. A confirm of that one generation blindly zeroed the WHOLE additive total — with no way to tell "the whole total is now resolved" from "only the latest contributor is; earlier still-unconfirmed contributors remain genuinely dirty." A `Map` lets `clearComposerDirtyOnConfirm` resolve exactly the contribution(s) a given confirmation actually proves, and leave the rest genuinely dirty.

## Do not

- Do not collapse this back to a single scalar tracking only the most recent contributor — a confirm of that one generation would again blindly zero the whole additive total, silently un-marking still-unconfirmed earlier contributions as clean.

## Why the `UserPromptSubmit` hook clears the WHOLE map, not just the scalars

A second site, in the `UserPromptSubmit` case of `deliverHook`, inside the same gated reset as `3ce3fa39`'s hook-side record: this hook belongs to the CURRENT (`submitGeneration`) generation — by construction the latest one there can ever be — so its own clear-prefix (the thing that originally set `composerDirtyLenClearedByGen`) targeted the FULL total accumulated from every still-unresolved OLDER generation. Clearing `composerDirtyMarkedGens` in full alongside the scalars is therefore safe at this call site specifically; leaving it un-cleared would strand an older generation's entry, unreachable by any future confirm.

### Do not (2)

- Do not clear only `composerDirtyLen`/`composerDirtyLenBelieved` at this hook without also clearing `composerDirtyMarkedGens` — an older generation's entry would linger orphaned.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (the `composerDirtyMarkedGens` field doc, `Live` state), as of commit `779f3ce7eccfb6cb3880d285b2016bc0554cc82c`. Extracted by card `6ba35149` (tranche 7 on `pty/host.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `//` comment markers stripped. The field's own base mechanism doc (the `composerDirtyLenClearedByGen`-mirroring gate description, card `3ce3fa39`/`a6c1d413`) remains inline at the same location as a Class-A guard — this record captures only the replaced-design narrative.

## Source (2)

Inline comment in `packages/daemon/src/pty/host.ts` (the `UserPromptSubmit` case in `deliverHook`), as of `main` `0cac46b89a9d2ad236117c355fb93d43f4f0f03f` (this tranche's starting HEAD). Extracted by card `7f448888` (tranche 19 on `pty/host.ts`).

## RE-SHAPE: `clearComposerDirtyOnConfirm` only touches `gen`'s own entry (or a proven-earlier chain), never a blind whole-field reset

Card `a6c1d413` RE-SHAPE: `decisive` gates HOW MUCH of the map a given confirmation may resolve.

- `decisive: true` (content-match, card `b932558c`): `gen`'s reported prompt exactly matches `gen`'s own pasted text — only possible if `gen`'s own clear-prefix landed (a botched clear glues stray text onto the paste, so the match never fires — see `3ce3fa39`'s "stray text glued onto a later submit" specimens). `submit()` doesn't always run that clear-prefix — two branches skip it (card `2a7f8040`): Enter-only redelivery (`isGiveUpRedelivery && composerBelievedTrustworthy`, repastes nothing) and plain `composerLen > 0` (raw-terminal typing), even though `composerDirtyLen` can still be `> 0`. Enter-only is harmless only because such a `gen` can never acquire an entry (see the early-return below). `composerLen > 0` used NOT to be protected — it stamped `composerBodyWrittenForGen` unconditionally, so it COULD acquire an entry and be wrongly resolved despite never clearing (pre-existing, not introduced by this re-shape — CLOSED by card `ef78c885`: stamp only when `composerDirtyLen === 0`, giving it the SAME protection Enter-only already had). Every `gen` reaching here WITH an entry already backspaced every OLDER contribution, same ordered write, immediately ahead of its own text — its match is transitive proof of the WHOLE chain, so this branch resolves every entry `<= gen`; a strictly LATER entry (unresolved when `gen` dispatched) stays marked.
- `decisive: false` (FIFO-position fallback, content-blind): resolves by queue position alone, no verification of what echoed — the SAME trust `composerDirtyLenClearedByGen` accepts for a bare Stop hook, but not license to discharge OTHER generations' marks. Resolves ONLY `gen`'s own entry.

**The early return is load-bearing:** an absent entry for `gen` is LOAD-BEARING for the Enter-only branch — it never stamps `composerBodyWrittenForGen = gen` (unlike the branches that DO write a fresh body), so it can never acquire an entry, stopping its own future decisive confirmation from being wrongly read as proof a clear-prefix it never ran succeeded.

### Do not (3)

- Do not make the Enter-only branch stamp `composerBodyWrittenForGen` as a drive-by (card `2a7f8040`) — that would let it acquire an entry and turn its future confirmation into a false-zero machine, discharging earlier generations' marks it never attempted to clear.

## Source (3)

Inline JSDoc in `packages/daemon/src/pty/host.ts` (`clearComposerDirtyOnConfirm`'s doc, "Card a6c1d413 RE-SHAPE"), commit `e17a8c2af20b2da570967744ef4e5f7f5f020fa0`. Extracted by card `8ebdd7d3` (t45); condensed, not verbatim.
