# aeb62a82 — forward-escaping `intended` replaces reversing the CLI's escape out of the echo

## Narrative

Card `691d02e1` fixed the CLI's own escape of a literal `<pasted_content`/`</pasted_content` occurrence
inside a pasted body by reversing it: `unescapeNestedPastedContentTag(inner)` stripped a backslash from
every `<\pasted_content`/`<\/pasted_content` match, then compared the result to `intended`. That reversal
is non-injective — it cannot tell "a backslash the CLI just inserted" apart from "a backslash already
literally present in `intended`" (e.g. prose quoting the escaped form itself) — so when `intended` already
contained the escaped form, the reversal over-stripped and produced a false ALARM. `691d02e1`'s own record
accepted this as a bounded, false-alarm-only residual (never a masked loss, since the reversal only ever
removes characters it recognizes).

Card `aeb62a82` found two live specimens where the excess fell OUTSIDE `ff871b77`/`79999395`'s accepted
1-2 char range (a Loom lead's own `[prompt-mismatch-pasted-content-wrap-excess-declined]
reason=excess-len-out-of-range`, excessLen 3 and 5) because BOTH specimens were reports *about this very
framing*, quoting both raw and pre-escaped tag forms in the same body — exactly the case `691d02e1`
accepted as a residual, just with more than 1-2 tags in play. A third, independent specimen (this card's
own worker, session `4d9deed9`, gen=1 kickoff) reproduced the exact mechanism: the real engine transcript
showed 6 total `pasted_content` mentions in the echo, all in escaped form, while the logged excess was
exactly 2 — and those 2 corresponded exactly to the one RAW open+close tag pair in the kickoff's own prose
(quoting "3 opening `<pasted_content …`" / "2 closing `</pasted_content …`" from the card body), with the
other 4 being prose that had ALREADY typed the backslash itself (e.g. "`<\pasted_content`, `<\/pasted_content`").
In all 3 specimens, **excess length == raw (not-already-escaped) tag count**, confirming the CLI only ever
escapes a bare occurrence and never touches one that already has a backslash there.

## The fix

Replace the reverse reversal with its FORWARD mirror: `escapeNestedPastedContentTag(s)` applies the SAME
substitution the CLI applies (`<(\/?)pasted_content` → `<\$1pasted_content`) to `intended` (or a stored
entry's own text) instead of trying to undo it on the echo. It only ever matches a literal,
not-already-escaped `<` immediately followed by `pasted_content`/`/pasted_content`, so an already-escaped
occurrence in `intended` is naturally left alone (the character right after its `<` is `\`, not `/` or a
letter) with no separate "already escaped" guard needed.

**Correction (Code Review, Minor 3): this function is deterministic but NOT injective** — an earlier
version of this record claimed otherwise. Because it never touches an already-escaped occurrence,
`escapeNestedPastedContentTag(M)` and `escapeNestedPastedContentTag(N)` can be EQUAL for two genuinely
different inputs: `M` already containing `<\pasted_content` at some position, and `N` otherwise identical
but with the bare `<pasted_content` at that same position (verified: `escape('<\\pasted_content…') ===
escape('<pasted_content…')`, both equal `'<\\pasted_content…'`). This is the exact same non-injectivity
the real CLI escape has (by design — this function mirrors it exactly), so it inherits the CLI's own
collision shape, not a NEW one. See "What this does NOT close" below.

Comparing `escapeNestedPastedContentTag(intended) === inner` instead of
`unescapeNestedPastedContentTag(inner) === intended` closes the `691d02e1` false-alarm residual entirely
(that residual was specifically about the REVERSE direction's own inability to tell a CLI-added backslash
apart from an author-typed one when un-escaping the echo — the forward direction never un-escapes
anything, so that specific failure mode cannot occur), rather than merely narrowing it.

Applied at all 3 places `unescapeNestedPastedContentTag` was used:

1. `isRecognizedPastedContentWrap` (the full-framing recognizer, card `7c1487c8`).
2. `isRecognizedBarePastedContentWrapOfCurrent` (the bare-framing twin, card `37acd59f`).
3. `purgeConfirmedGiveUpRequeueCore` (the give-up purge path, card `fc82dd76`/`0658d6d8`) — this site only
   ever holds a `{len,hash}` SIGNATURE for a candidate entry, never its literal text, so the forward escape
   cannot be applied at comparison time. Instead, a new `escapedSig` field (additive, alongside the
   existing `memberSig`, same posture) is precomputed once in `requeueGiveUpOrigin`, from the real
   `submittedText`, and propagated through `archiveAmbiguousDispatch` exactly like `memberSig` already is.
   The comparison (`purgeConfirmedGiveUpRequeueCore`'s `matchesSig`) then compares the raw captured inner's
   own signature (`unwrappedSig`, unchanged) against `entry.escapedSig`, never reverse-escaping the echo.

## What this does NOT close

**Correction (Code Review, Minor 3):** an earlier version of this record claimed the forward-direction fix
also CLOSES `0658d6d8`'s own addendum (card `fc82dd76`) "Accepted residual — a non-injective escape can
collide two distinct give-ups" section. That is WRONG — the residual is UNCHANGED, not closed, because it
is inherent to the engine's own non-injective escape, not an artifact of which direction (reverse-unescape
or forward-escape) this code happens to apply. `escape(M) === escape(N)` for M/N differing only by one
pre-existing backslash at a position the CLI's own real escape would also leave untouched — the SAME
collision the real CLI echo itself produces, independent of this code. **A second correction: that
residual's two cases are NOT both safe.** When both candidates are simultaneously ambiguous, the
pre-existing `bc0774c4` AMBIGUOUS branch (more than one distinct logicalId sharing a signature) declines —
safe, fails toward a duplicate, never a loss. But in the ASYMMETRIC case (one candidate already
resolved/removed, the other still ambiguous), only the still-ambiguous one matches and gets purged for a
confirmation that was never about it — a genuine, accepted LOSS, unchanged by this card either way. The
collision is now reached via `entry.escapedSig` compared on arm 3 of `matchesSig`, never the removed
`unescapedUnwrappedSig`. See `0658d6d8`'s own "Accepted residual" section for the full case breakdown —
read it there, not restated here.

## Verification

Reproduced the real mechanism offline (no production code touched) with a scratch script: a synthetic
`intended` with 3 raw opens + 2 raw closes + 1 pre-existing escaped literal (mirroring the second real
specimen) → the OLD `unescape(inner) === intended` check is false, diverging exactly at the pre-existing
literal's position; the NEW `escape(intended) === inner` check is true. A negative control (a genuine
1-char content difference) still correctly fails under the new check — the fix does not mask a real
divergence.

`packages/daemon/test/pty-prompt-mismatch.mjs` scenario 6x (previously PINNING the false alarm as
accepted) now asserts the opposite: the shape is RECOGNIZED, no notice. Scenarios 6v/6w/6y/6z are
unaffected — none of their fixtures contain a pre-existing escaped literal, so forward-escape and the old
reversal agree on them. `packages/daemon/test/pty-giveup-pasted-content-wrap-confirm.mjs` scenarios 1-5
are unaffected for the same reason; a new scenario 6 covers the purge path's own both-raw-and-pre-escaped
shape specifically.

**Code Review round 1 found two further defects, both fixed and pinned:**

- **MAJOR 1 (a real regression):** `purgeConfirmedGiveUpRequeueCore`'s `sigCurrentOutstanding` candidate
  (built from `live.lastPrompt`, for the `7a64f16b` content-ancestry decline guard) was constructed as a
  bare `{len,hash}` with no `escapedSig` — so arm 3 of `matchesSig` silently never matched it, the decline
  guard never fired for a tagged current-write echo, and an unrelated OLDER ambiguous lineage got wrongly
  resolved/purged instead. Fixed by computing `escapedSig` for `sigCurrentOutstanding` too (from the real
  `live.lastPrompt` text, available there) and making `escapedSig` a REQUIRED field on `matchesSig`'s
  param type, so the compiler itself would catch a future candidate missing it. Pinned by
  `pty-giveup-pasted-content-wrap-confirm.mjs` scenario 7 (mirrors `pty-giveup-lone-signature-ancestry.mjs`
  scenario (a) with a tagged collision text) — shown RED on the pre-fix commit, GREEN after.
- **MAJOR 2 (missing coverage):** site 2 (`isRecognizedBarePastedContentWrapOfCurrent`) had no test
  combining a raw tag with a pre-existing escaped literal — its only escape coverage
  (`pty-prompt-mismatch-bare-wrap-of-current.mjs` scenarios (k)/(l)) used raw-only tags, where the old and
  new directions agree, so reverting site 2 alone stayed green. Added scenario (d2) to that file (mirrors
  (d), unambiguous, but with the raw+pre-escaped shape) — shown RED with site 2 alone reverted, GREEN
  after restoring.

## Do not

- Do not reintroduce a reverse-direction (unescape-the-echo) comparison at any of the 3 call sites above —
  it is non-injective; see the narrative.
- Do not widen `escapeNestedPastedContentTag`'s regex beyond the two literal substrings
  `<pasted_content`/`</pasted_content` without a new, verified specimen.
- For a STORED candidate (an `ambiguousDispatches`/`retiredGiveUpSignatures` entry) — never a
  `sigCurrentOutstanding`-shaped one built fresh at the comparison site, see the next item — do not derive
  `escapedSig` at `purgeConfirmedGiveUpRequeueCore`'s own comparison site — a stored entry only ever holds
  a signature there, never its literal text; `escapedSig` must stay precomputed in `requeueGiveUpOrigin`
  from the real `submittedText`, and propagated through `archiveAmbiguousDispatch` like `memberSig`.
- Do not read `691d02e1`'s "accepted residual" section as still current — it IS superseded (the false-alarm
  direction is closed). Do NOT read `0658d6d8`'s "Accepted residual" section as superseded — it is
  UNCHANGED (see "What this does NOT close" above); that record's own SUPERSEDED pointer must say so, not
  claim closure.
- Do not give `matchesSig` (or any future candidate built for it) an OPTIONAL `escapedSig` — the `?`
  modifier is exactly what let the Major-1 regression compile silently. `escapedSig` is REQUIRED on every
  candidate, including one built from `live.lastPrompt`/`live.giveUpOriginWrittenText` directly at the
  comparison site (not just entries precomputed in `requeueGiveUpOrigin`) — compute it fresh wherever a
  new candidate is constructed, never leave it to default/undefined.
- Do not add escape-tag test coverage to only ONE of the two recognizers (full-wrap vs bare-wrap) on the
  assumption the other is "the same code shape" — Major 2 is exactly a sibling recognizer with NO coverage
  of the raw+pre-escaped shape at all. Mirror a new fixture across BOTH `isRecognizedPastedContentWrap`'s
  and `isRecognizedBarePastedContentWrapOfCurrent`'s own test files when it's added to one.

## Source

Card `aeb62a82`, worker investigation + fix, 2026-10-19. Manager-approved fix plan (conditions A-E):
validate the forward-escape rule against a third, independent real specimen before implementing (done,
see Narrative); include the give-up purge path, tracing it first rather than forcing a mismatch (done, see
"The fix" item 3); implement the forward escape once, used at all 3 sites; negative controls per site,
shown RED before the fix.
