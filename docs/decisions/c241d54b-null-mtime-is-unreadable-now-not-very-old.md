# c241d54b — a `null` from `newestMtimeMs` means "unreadable now", never "very old"

## Narrative (this file's site: `newestMtimeMs`'s own doc)

A `null` return from `newestMtimeMs` is ambiguous on ITS OWN: it means "this dir has no files right now", which covers both "legitimately never built" AND "existed moments ago but vanished/emptied mid-scan (a build racing this read)". The function cannot and does not disambiguate those — its own internal guard only covers an individual FILE vanishing between listing and stat, not the whole tree being transiently unreadable across two separate calls into this module.

A CALLER that already confirmed the dir's presence moments earlier must treat a `null` here as "unreadable now", never coerce it to a default "very old" value.

## Narrative (second site: `computeDeployStaleness`'s handling of `distDir` — the caller that got this wrong once already)

`distDir` is confirmed to exist via the `statSync` on `distIndex` immediately before this call, so a `null` return from `newestMtimeMs(distDir)` here specifically means the tree became unreadable/vanished in the window between that check and this scan (a build racing this read), NOT "very old".

The prior code coerced that `null` to `?? 0` (epoch) alongside `sharedDistDir`'s own — but unlike `sharedDistDir`, `distDir` is NOT "legitimately absent" at this point, and "unreadable right now" is a different fact than "very old": coercing it to epoch silently corrupted every downstream reader of this clock — `commitsBehind` counted almost every restart-relevant commit ever, since `runningCodeBuiltAt` clamps to the same epoch; a test then fed the resulting epoch-derived date into `GIT_AUTHOR_DATE`, which git rejected outright. The fix surfaces it as `unavailable` instead of guessing.

## Do not

- Do not coerce a `null` from `newestMtimeMs(distDir)` to epoch (or any other default "old" value) once the dir's existence has already been confirmed moments earlier — surface `unavailable` instead.
- `sharedDistDir` is the one exception: it may legitimately be absent (an optional package), so its own `null` safely defaults to `0` in the `Math.max` — do not generalize that default to `distDir`, which the caller has already proven exists.

## Source

Inline comment in `packages/daemon/src/deploy-staleness.ts` (`newestMtimeMs`'s own doc), as of commit `7f437cda4ab4442656c935a8b2976f19bac504d9`. Relocated by card `4edb74d1` ("deploy-staleness.ts, tranche 2"); no wording changed, `*`-prefixed lines joined into flowing paragraphs.

Second site's inline comment in `computeDeployStaleness` (the `distDir`/`newestMtimeMs` call site), same file and commit. Relocated by the same card; no wording changed, `//`-prefixed lines joined into flowing paragraphs.
