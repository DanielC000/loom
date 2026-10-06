# 0658d6d8 — `purgeConfirmedGiveUpRequeueCore` unwraps a pasted-content composer wrap before its content-match signature check

## Narrative

From the round-2 Code Review of dc92f4b6: `purgeConfirmedGiveUpRequeueCore` (host.ts) matched the RAW
`textSignature(reportedPrompt)` against `live.ambiguousDispatches`/`live.retiredGiveUpSignatures`, with
no awareness of the engine's own `<pasted_content id="X">…</pasted_content id="X">` composer wrap — the
SAME framing `isRecognizedPastedContentWrap` and dc92f4b6's `findRecognizedPastedContentWrapOfPriorWrite`
already recognize, but only on the UNRELATED prompt-mismatch-classification path. So a WRAPPED late
confirmation of a given-up generation K never matched its archived signature, and — whenever a fresh,
unrelated generation had since become current (the dc92f4b6 shape: give-up, re-mint, confirm elsewhere)
— the content-blind FIFO-position fallback had *already correctly declined* to touch K's entry (it only
covers a generation still at the front/current), leaving NOTHING to purge K's still-queued give-up
re-mint. That duplicate would eventually redrive as a genuine double-delivery once its hold window
cleared.

Reproduced hermetically (`packages/daemon/test/pty-giveup-pasted-content-wrap-confirm.mjs`, scenario 1):
RED on pre-fix main — gen 1 gives up genuinely (silent fake pty never confirms), a fresh gen 2 confirms
normally (so the FIFO fallback declines), then gen 1's own late confirmation arrives wrapped
(`pastedContentWrap(id, TEXT1)`) and neither a content-matched CONFIRMED log fires nor is the requeued
duplicate purged.

## The fix

Right after computing `const sig = textSignature(reportedPrompt)`, also `exec` the SAME module-level
`PASTED_CONTENT_WRAP_RE` (no new regex/parser — reused inline, exactly as
`detectPastedContentWrapSingleCharDeficit`/`detectPastedContentWrapSmallExcess`/
`detectPastedContentWrapContentDivergence` already do) against `reportedPrompt`. If it matches, compute a
SECOND signature over just the captured inner group (`m[2]`) — the regex is anchored `^...$`, so `m[2]` is
never a substring, which is what makes "exact whole-inner equality only" hold without any extra check.
Both match loops (`live.ambiguousDispatches` and `live.retiredGiveUpSignatures`) now accept either the raw
signature OR the unwrapped-inner signature via one shared `matchesSig` predicate.

Deliberately does NOT reuse dc92f4b6's `findRecognizedPastedContentWrapOfPriorWrite` directly: that helper
requires a `currentIntendedText` param and a `window: {gen,text}[]` of full prior text, proving content
identity against the CURRENT generation's own intended text specifically. This purge path is a different
shape — it resolves ANY still-ambiguous prior dispatch by content, regardless of what generation is
current, and the archived maps store only `{len,hash}`, never full text. Reusing that helper would need
either a fabricated `currentIntendedText` or restructuring the maps to carry full text; reusing just the
shared `PASTED_CONTENT_WRAP_RE` constant is the smaller, correct fix.

Deliberately does NOT consult `entry.memberSig` (decision `ee56a894`): this purge path stays keyed off the
joined `submittedSig` alone, exactly as before — `memberSig` is `hasAmbiguousMatch`'s own narrower-scoped
addition for a different consumer.

**Known, accepted limitation — no `trimEnd()` compensation.** `isRecognizedPastedContentWrap` tolerates
the engine trimming trailing whitespace off the pasted body (`m[2] === intended || m[2] === intended.trimEnd()`)
because it has the real `intended` text to compare against. This purge path only has an archived
`{len,hash}` signature — there is no original text left to re-derive a trim-tolerant comparison from, so a
written give-up whose text had trailing whitespace, echoed back trimmed, will fail to match here and
fall through to the unchanged (content-blind) FIFO fallback. Left loud rather than guessed at — mirrors
dc92f4b6's own posture on the `ff871b77`/d0c329c1 small-excess shape.

## Do not

- Do not widen the unwrapped-inner match to a substring/partial recognition — the anchored `^...$` regex
  is what makes "exact whole-inner equality only" hold; matching anything less than the whole captured
  group reopens the hazard dc92f4b6's own "Do not" section warns about for the sibling mismatch-
  classification path.
- Do not consult `entry.memberSig` in this purge path — see decision `ee56a894`; it is a different
  consumer's narrower field, not a substitute for the joined `submittedSig` this path has always used.
- Do not add a `trimEnd()` compensation here to close the known limitation above — there is no original
  text in the archived signature to re-derive a trim-tolerant comparison from; this is a real, accepted
  gap, not an oversight.
- Do not route `findRecognizedPastedContentWrapOfPriorWrite` into this path instead of reusing
  `PASTED_CONTENT_WRAP_RE` directly — that helper's `currentIntendedText`/`window` shape answers a
  different question (content identity against the CURRENT generation) than this purge path needs
  (content identity against ANY still-ambiguous archived dispatch).

## Source

Inline comment in `packages/daemon/src/pty/host.ts`, inside `purgeConfirmedGiveUpRequeueCore`, right after
the `const sig = textSignature(reportedPrompt)` line.
