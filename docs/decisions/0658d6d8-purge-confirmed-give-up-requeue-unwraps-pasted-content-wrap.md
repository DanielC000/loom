# 0658d6d8 — `purgeConfirmedGiveUpRequeueCore` unwraps a pasted-content composer wrap before its content-match signature check

**MECHANISM PARTIALLY SUPERSEDED by card `aeb62a82`** (`docs/decisions/aeb62a82-*.md`): the "Addendum
(card `fc82dd76`)" section's `unescapedUnwrappedSig` (reversing the CLI's escape on the REPORTED side) is
REMOVED. The comparison now uses a forward-escaped `escapedSig`, precomputed from the real text in
`requeueGiveUpOrigin` and propagated through `archiveAmbiguousDispatch`, compared against the unmodified
`unwrappedSig`.

**Correction (Code Review, Minor 3): the addendum's own "Accepted residual — a non-injective escape can
collide two distinct give-ups" section is STILL CURRENT, NOT closed.** An earlier version of this pointer
claimed otherwise — wrong: the residual is inherent to the engine's own real escape being non-injective
(it never touches an already-escaped occurrence), and `aeb62a82`'s `escapeNestedPastedContentTag` mirrors
that real escape exactly, so it inherits the exact same collision shape — switching which direction
(reverse-unescape vs forward-escape) this code applies changes nothing about whether the collision can
occur. **A second correction to the same earlier pointer text: the two cases below are NOT both safe.**
Read the "Accepted residual" section below exactly as it already states: the BOTH-AMBIGUOUS case is safe
(declined, fails toward a duplicate, never a loss); the ASYMMETRIC case (M already resolved/removed, N
still ambiguous) is a genuine, accepted LOSS — N's requeue gets purged for a confirmation that was never
about N. Neither case's outcome changed by this card. Only the MECHANISM that reaches the collision
changed: the match is now `entry.escapedSig` compared on arm 3 of `matchesSig`, not the removed
`unescapedUnwrappedSig` the section below still names (that section is kept as-written, describing how the
residual was originally found — the comparison target is what moved, not the residual itself). Everything
ABOVE the addendum (the base `0658d6d8` fix: unwrap-then-compare, the `trimEnd()`-less limitation, the "Do
not" items on substring-widening) is UNCHANGED and still governs.

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

## Addendum (card `fc82dd76`) — a third candidate signature for the CLI's own literal-tag escape

Discovered from card `691d02e1`: the current CLI escapes a literal `<pasted_content`/`</pasted_content`
occurrence found WITHIN a pasted body (inserting a `\` right after the `<`) — e.g. a give-up write whose
own text quotes this very wrap's syntax as prose. `isRecognizedPastedContentWrap` already reverses that
escape via `unescapeNestedPastedContentTag` for the unrelated prompt-mismatch-classification path (card
691d02e1), but this purge path's own unwrap computed `textSignature(wrapMatch[2])` over the RAW captured
inner only, never reversing the escape — so an archived signature over the genuinely-dispatched
(unescaped) text could never match a CLI-escaped echo of a give-up body that quoted the tag.

Reproduced hermetically (`packages/daemon/test/pty-giveup-pasted-content-wrap-confirm.mjs`, scenario 4):
RED on pre-fix code — same shape as scenario 1 (give-up, re-mint via an unrelated healthy generation,
late wrapped confirmation) but with a body that quotes the tag syntax, escaped by the CLI on echo exactly
as card 691d02e1's real-world specimens showed.

**The fix:** compute a third candidate signature, `textSignature(unescapeNestedPastedContentTag(wrapMatch[2]))`,
and fold it into `matchesSig` as a third OR-branch alongside the existing raw/unwrapped checks — purely
additive; the exact-hash (raw `sig`) and unwrapped-but-unescaped paths stay byte-identical.

**This is a SANCTIONED EXCEPTION to `691d02e1`'s own Do-not #2** (amended by this card to name it), not an
application already covered by that record's wording. `691d02e1`'s "one accepted failure direction" —
reversing outside `isRecognizedPastedContentWrap` only ever risks a false ALARM, never a masked loss —
does **not** carry over to this purge path unchanged: there, a false match is over-notification; here, a
false match PURGES a still-queued requeue. **The failure direction for THIS consumer is the opposite one:
a false match here is a possible LOSS, not a false alarm.** The exact-whole-inner-equality property (see
`matchesSig`'s construction, and the first "Do not" above) is what keeps that risk bounded to the
near-zero residual recorded below, rather than being the general case.

### Accepted residual — a non-injective escape can collide two distinct give-ups

The CLI's escape is non-injective in one narrow case: it only inserts a backslash before a BARE
`pasted_content`/`/pasted_content` occurrence (a negative lookbehind skips one that already has a
preceding backslash — established by `pty-prompt-mismatch.mjs` scenario 6x for card `691d02e1`). So two
byte-DIFFERENT original messages can echo to the byte-SAME wrapped inner: message **M**, whose own
authored text already contains the literal substring `<\pasted_content` (quoting the escaped form
itself, e.g. discussing this very mechanism) — left untouched by the CLI, since it already has the
backslash — and message **N**, otherwise byte-identical to M but with the bare `<pasted_content` (no
backslash) at that same position — which the CLI DOES escape on echo, producing `<\pasted_content`. M's
and N's echoes are now indistinguishable at the wrap level.

If M's own confirmation arrives while M is still ambiguous: `unwrappedSig` (the raw captured inner,
unescaped further) correctly matches M's own archived entry. But `unescapedUnwrappedSig` — stripping M's
*already-present* backslash, since the reversal cannot tell "the CLI inserted this" apart from "the
author typed this" — now equals N's own ORIGINAL (bare) signature. If N's entry is ALSO still ambiguous
at that moment, `matchedLogicalIds.length > 1` across distinct `batchId`s and the existing `bc0774c4`
ambiguous-decline (see that record) covers it: nothing is purged, failing toward a duplicate, never a
loss — **the both-ambiguous case is safe.** The genuine residual is the asymmetric case: M's entry has
ALREADY been resolved/removed by the time M's confirmation (or a stale replay of it) arrives, while N's
entry is STILL ambiguous — then only N matches, `matchedLogicalIds.length === 1`, and N's requeue is
purged even though this confirmation was never actually about N. This is a genuine, accepted LOSS
residual: it requires (1) a message literally authoring the escaped tag form as prose (rare on its own —
`691d02e1`'s own "one accepted failure direction" is this same rarity), (2) a second, concurrently
ambiguous message differing from the first by exactly that one backslash at that exact position, and (3)
the specific resolve-ordering above. No real specimen has ever shown precondition (2)+(3) together — left
recorded, not fixed, same posture as `691d02e1`'s own accepted false-alarm residual.

**Precondition (1) has now been observed in production, on the sibling mismatch-classification path (a
different consumer, not this purge path):** a Loom lead's `worker_message` to this worker session (gen=3,
written 1664 chars, `writtenHash d7f5d31e`, mint-time `2026-10-14T16:44:23.358Z`) mixed both the bare and
already-escaped forms of the tag in its own prose and, reaching this session, reported back as 1723
chars (`reportedHash fc802e3b`) — a +59 delta the narrow reversal could not round-trip, surfacing as
`[loom:prompt-mismatch-unmatched]` (the UNRECOGNIZED third state), never a confirmed loss. This lands on
`isRecognizedPastedContentWrap`'s own acceptance check, not on `purgeConfirmedGiveUpRequeueCore` — it is
the `691d02e1` false-ALARM direction, observed, not an instance of THIS record's purge-path loss residual
— but it confirms precondition (1) (a real message genuinely mixing both tag forms) is not merely
theoretical. Preconditions (2)+(3) — a second, concurrently-ambiguous message in THIS purge path,
differing by exactly that one backslash, resolved in the specific order the loss residual needs — remain
unobserved.

## Do not (2)

- Do not widen `unescapeNestedPastedContentTag` itself, or the equality check against its output, beyond
  what card `691d02e1`'s own record already allows for its OWN narrowness (pinned there by
  `pty-prompt-mismatch.mjs` scenarios 6y/6z) — this addendum reuses that existing, narrow reversal as a
  second unwrap pass in a NEW consumer; it introduces no new escape-reversal logic, and widening the
  shared helper to "fix" the residual above would reopen the exact masking hazard those scenarios guard
  against, in BOTH consumers at once.
- Do not let the escape-reversed candidate match anything less than exact whole-inner equality (same
  anchored-regex reasoning as the first "Do not" above) — a give-up whose unescaped text happens to be a
  substring/superset of an archived entry's text must still decline, exactly like the raw/unwrapped
  candidates already do (see `pty-giveup-pasted-content-wrap-confirm.mjs` scenario 5, the negative
  control pinning this specifically for the purge path's own `matchesSig`, distinct from — and in
  addition to — 6y/6z's pinning of the shared helper's narrowness above).
- Do not treat the accepted residual above as something to "fix" by widening or narrowing the reversal
  without a real specimen showing either precondition — the current form is deliberately the minimal,
  additive change that explains the one real specimen class (scenario 4's shape) without reopening the
  `691d02e1` do-not-relax posture.

## Source

Inline comment in `packages/daemon/src/pty/host.ts`, inside `purgeConfirmedGiveUpRequeueCore`, right after
the `const sig = textSignature(reportedPrompt)` line.
