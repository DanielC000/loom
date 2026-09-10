# a640c110 — an ANSI/CSI-strip deficit is a rendering artifact, not content loss

## Narrative

Card a640c110: a sibling to `detectPossibleDuplicateWrapperDeficit` — a DIFFERENT benign byte-pattern that otherwise presents as an ordinary mismatch. Measured specimen (worker `671766c9…`, gen=3, from `daemon-output.log`): `reportedLen=4106 intendedLen=4115 lenDelta=-9 divergesAtChar=897`, and `intended` carried EXACTLY two ANSI/CSI escape sequences at that point (`\x1b[31m` = 5 chars, `\x1b[0m` = 4 chars) — `5 + 4 = 9`, matching `lenDelta` exactly, and `divergesAtChar` lands precisely where the first sequence starts. The engine's own echo had stripped both sequences and reproduced everything else byte-for-byte: NOT corruption, NOT content loss — an attribution/rendering artifact, same posture as the wrapper-deficit shape.

Precise and non-heuristic, mirroring `detectPossibleDuplicateWrapperDeficit`'s own exact-strip-and-compare discipline: reuses the EXISTING `ANSI_CSI` regex (this file — the same one `collapseBoot` already strips with), no new matcher. Fires ONLY when stripping EVERY ANSI/CSI escape sequence from `intended` produces `reported` EXACTLY, byte-for-byte — never a fuzzy/near match, and never a one-sided/partial strip (a payload where ANSI is present but the REMAINING content also genuinely diverges fails the `stripped !== reported` check and is correctly left unclassified, same as a payload with no ANSI at all).

### Precedence in the notice-classification chain

Deliberately does NOT require `replayedEntry === undefined` (mirrors `confirmedWrapperDeficit`'s own reasoning): an exact ANSI-stripped match is strictly MORE informative than the ambiguous replay framing the generic fallback would otherwise give it, so it wins precedence whenever it fires, regardless of whether `reported` also happens to coincide with some earlier recorded write. Guarded against `confirmedWrapperDeficit` too, so the two exact-strip shapes stay mutually exclusive in the vanishingly-unlikely case both matched.

### The notice text is worded on its own terms

The session-facing notice for this shape is never patched onto `lossClause`/`replayNote` and never worded as a possible LOSS (same posture as the wrapper-deficit notice) — but it is worded on ITS OWN terms, not borrowed from the wrapper-deficit branch's "stale confirmation of an EARLIER write" framing: this is a DIFFERENT benign shape (the engine's own echo stripping ANSI/CSI styling), not a stale out-of-order confirmation.

## Do not

- n=1 (one specimen, one shape) — this classifies THIS byte-pattern only; it is not license for any broader claim that mismatches are generally benign. See memory `the-qualifier-dies-in-the-summary-label`.
- Do not word this shape's notice text as a stale-confirmation-of-an-earlier-write (the wrapper-deficit framing) — it is a different mechanism (rendering, not attribution/ordering) and gets its own wording.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (`detectAnsiEscapeStripDeficit`'s function doc). Relocated by card a4818d7a (tranche 1 on `pty/host.ts`) — the n=1 scope caveat stayed inline per `CLAUDE.md`'s class-A rule, compressed in place. No wording changed in the narrative moved here; wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
