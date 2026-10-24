# fce93534 — `findRecognizedSubstring` prefers a framing-explained candidate over the newest-first hit

## Context

`findRecognizedSubstring` (`pty/host.ts`) is the only producer of `unmatchedRecognized` — a DIAGNOSTIC-
ONLY recognition (card d005f55b §2) that names which ring entry's own recorded write appears as a literal
substring of `reported`, for the residual case where `reported` is NOT exactly the anchored full-string
wrap of any one entry (so `identicalContentPriorEntryBare`/`Full`, card 437daade's own ring-scan fix for
the IDENTICAL/whole-match case, cannot fire).

Before this card, the function returned on the FIRST hit scanning newest-to-oldest. A short, unrelated,
MORE RECENT ring entry whose text happens to be a trivial literal substring of `reported` (e.g. a prior
write of the word "content", which occurs naturally inside the engine's own static
`<pasted_content ...></pasted_content ...>` tag text) pre-empted an OLDER entry's own much more complete,
genuinely-wrapped match — the SAME "shadowed ring entry" defect card 437daade already fixed for the
whole-match case, reopened here for this substring-only caller.

Reproduced hermetically (STEP 1 checkpoint, manager-approved): a probe with gen=1 writing a 60-char
payload Y (never confirmed), gen=2 writing the 7-char "content" (never confirmed), and the engine
reporting Y wrapped in the bare pasted-content tag framing plus ONE extra trailing space (disqualifying
the whole-match mechanism). `findRecognizedSubstring` named gen=2 (`matchedLen=7`) instead of gen=1
(`matchedLen=60`).

## Severity, traced to every call site (STEP 1 finding, unchanged by the fix)

`unmatchedRecognized` is used ONLY (a) in the `[prompt-mismatch-unmatched-remainder]` diagnostic log and
the session-facing notice's wording, and (b) as a bare BOOLEAN gate (`!unmatchedRecognized`) disqualifying
the benign-offset-insertion/omission arms — never keyed on WHICH gen matched. `unmatchedRecognized.gen` is
never added to `live.mismatchResolvedGens` anywhere. So the shadowing bug never flips LOUD to silent — the
arm stays `fallback-unrecognized` and the manager push still fires either way. The defect is purely a
MISATTRIBUTION: the diagnostic/notice names the trivial, irrelevant match and tells the recipient the
remainder (which is, in fact, the real entry's own payload) is "NOT accounted for."

## The fix

`findRecognizedSubstring` now scans every substring-matching candidate (never stops at the first hit) and
prefers one whose remainder is "pure wrap framing" of that candidate's own entry text — reusing the
EXISTING, UNMODIFIED `isRecognizedBarePastedContentWrapOfCurrent`/`isRecognizedPastedContentWrap`
recognizers verbatim (`isPureWrapFramingOfEntry`), never a new independent regex. The one widening beyond
what those two functions already tolerate for their own INNER-body comparison (card 7c1487c8's
`intended.trimEnd()` accommodation) is tolerating trailing WHITESPACE after the CLOSING tag, on the OUTER
boundary. This mirrors (does not duplicate) card 7c1487c8's own already-established engine behavior (the
composer trims/adds trailing whitespace around pasted-content payloads), applied to the wrapper's own end
rather than its inner body. A non-whitespace suffix still disqualifies the candidate — this is bounded,
never an arbitrary-content tolerance.

**ROUND 2 (Code Review BLOCKING, reviewer c8f6528c):** the first cut tested a blind `reported.trimEnd()`
against both recognizers. `PASTED_CONTENT_WRAP_RE` (the FULL-framing shape) requires a mandatory trailing
`"\n"` immediately before its own `$` anchor — `trimEnd()` strips that required byte along with any real
extra whitespace, so the full-framing recognizer could never match through this helper at all, even on an
untouched full wrap with zero extra whitespace (verified directly in node: `RE.test(full)` true,
`RE.test(full.trimEnd())` false). `isPureWrapFramingOfEntry` now tries RAW `reported` first against both
recognizers (the exact, no-tolerance case, for both shapes); only if that fails does it trim, and for the
full-framing shape specifically it restores exactly the one mandatory trailing `"\n"` after trimming the
rest (`` `${trimmed}\n` ``) — the bare-framing shape has no such requirement, so plain `trimmed` is still
correct for it. A full-framing twin of the repro (RED-proven against the round-1 commit 2b69ebf3, GREEN
after this fix) covers the shape the round-1 cut silently never caught.

When no candidate is framing-explained, the function falls back to the exact same newest-first hit as
before this card — byte-identical fallback, proven by a dedicated regression test (scenario 3,
`pty-prompt-mismatch-shadowed-substring-ranking.mjs`) using a plain, non-wrap-shaped specimen.

**Tie-break (two different generations, both framing-explained):** the anchored wrap regex extracts
exactly ONE inner string from the (possibly trimmed/newline-restored) `reported`, so two DIFFERENT ring
entries can both be framing-explained whenever their OWN text each independently satisfies the
recognizer's existing tolerance against that one extracted inner — `inner === entryText`,
`inner === entryText.trimEnd()`, or either of those after the CLI's own forward escape
(`escapeNestedPastedContentTag`, see `isRecognizedPastedContentWrap`'s own doc). This does NOT require the
two entries' texts to be byte-identical (e.g. `"X"` and `"X\n"` can both qualify against the same inner,
since the second's `trimEnd()` equals the first) — a genuine repeat is the simplest, not the only, way two
candidates can tie. The scan order (newest-to-oldest, returning on the first framing-explained hit)
naturally picks the more recent one — no separate tie-break logic was needed; this falls out of the scan
order itself. Tested (scenario 4, same file) against a THIRD, non-framing, more-recent substring hit
placed ahead of two framing-explained entries, so newest-framing (the second of the two) is proven to
differ from newest-ANY (the non-framing one) — the discriminating case the round-1 version of this
scenario did not actually exercise.

This stays attribution-only by construction: `isPureWrapFramingOfEntry` is used only to choose WHICH
already-unmatched candidate `findRecognizedSubstring` returns; the call site (`unmatchedRecognized`'s own
consumer in `pty/host.ts`) is unchanged, and `unmatchedRecognized.gen` still never reaches
`live.mismatchResolvedGens`. Tested explicitly (scenario 1 asserts `mismatchResolvedGens` stays empty for
both gens after the corrected attribution).

## Do not

- Do not widen `isPureWrapFramingOfEntry` past outer trailing WHITESPACE (`reported.trimEnd()`) — a
  non-whitespace suffix must keep disqualifying a candidate, or a genuine unrelated loss sitting right
  after the tag would silently pass as framing-explained.
- Do not call `isPureWrapFramingOfEntry` with anything other than the full, untrimmed `reported` — the
  trim happens once, inside the helper, against the WHOLE string; trimming at a call site first would
  silently change what "outer" means.
- Do not let `findRecognizedSubstring`'s new scan promote anything to confirmed/benign, or add its result
  to `live.mismatchResolvedGens` — it remains attribution-only, exactly as `unmatchedRecognized` already
  was (card d005f55b §2).
- Do not reintroduce an unconditional first-hit return ahead of the framing check — that is the exact
  defect this card fixes. The `fallback` local must stay captured on the FIRST iteration only and
  returned, unmodified, when no candidate is framing-explained.
- Do not assume this closes the WHOLE "shadowed ring entry" class — it closes the gap for THIS,
  substring-only caller (`unmatchedRecognized`); the whole-match case was already closed by card 437daade's
  own, independent `findMostRecentUnresolvedPriorEntryAcceptedByRecognizer` ring scan.
- Do not blindly `trimEnd()` `reported` before testing it against `isRecognizedPastedContentWrap` (the
  FULL-framing shape) — its own regex requires a mandatory trailing `"\n"`, which `trimEnd()` removes
  along with any real extra whitespace, silently disarming the full-framing match entirely. Always try
  RAW `reported` first, and restore exactly one trailing `"\n"` after trimming for the full shape only.
- Do not assume two framing-explained candidates must share byte-identical text — the underlying
  recognizers' own `trimEnd()`/escape tolerance means two DIFFERENT entry texts can both match the SAME
  extracted inner. "Both framing-explained" is not a synonym for "a genuine repeat."

## Source

`packages/daemon/src/pty/host.ts`: `isPureWrapFramingOfEntry` and `findRecognizedSubstring` (both
`@decision fce93534`-anchored). Tests: `packages/daemon/test/pty-prompt-mismatch-shadowed-substring-ranking.mjs`.
