# 37acd59f — a bare-tag wrap of the CURRENT generation is not a replay of an earlier one with identical text

## Narrative

Card 37acd59f, from the CR of `e59880fe` (reviewer `d4ea9a0c`, gen 425): a minor question, not a defect
proven by execution at filing time — repro built and confirmed by this card's own investigation before any
code changed.

If the current generation's own intended text is byte-identical to an earlier generation's recorded write
(e.g. "continue" sent twice) and the engine bare-wraps the CURRENT generation in the narrow 27/28 (4-char
id) paste framing (`matchPastedContentWrapFramingOfRemainder`, card `e59880fe`), `findRecognizedSubstring`
(host.ts) matched the EARLIER entry — it is the most recent entry in `live.recentWrittenTurns` whose text
is a substring of `reported`, and it never compares against the CURRENT generation's own `intended` text
at all. The session was told it received a REPLAY of the earlier generation and that its own text may not
have arrived, when it did — and the current generation's own `checkPromptMismatchUnresolved` follow-up
timer got armed (keyed to the current generation, which that path never marks resolved), a real false-alarm
precondition.

**This population splits into two cases that do NOT get the same treatment** (see "Round 3" below for the
current, correct statement of the split — Round 2's own statement of it was itself wrong and superseded):
whether this echo ACTUALLY resolved another generation (via `wrappedReplayOfPriorWrite` or `replayedEntry`).
When one did (the card's own "continue sent twice" repro among others), the fix stays loud. When neither
did (the current generation's own content, bare-wrapped, either unrelated to the ring or merely brushing
past an earlier entry as a substring without resolving it), the fix goes silent.

## What `dc92f4b6`/`79999395`/`7a64f16b` permit (manager-approved reading, filed before any code changed)

`dc92f4b6` establishes "CONTENT identity, never lineage" as the standing principle, and its own
`findRecognizedPastedContentWrapOfPriorWrite` already resolves a wrap as confirmed-benign purely on content
identity — but only for a re-mint (current gen carries a `[loom:possible-duplicate]` tag). That scoping was
about requiring a tag as the reason to even consider the current generation's identity for the FULL-framing
case; it was never a ruling that content-identity resolution against the current generation's own
`intended` is unsound in general. The round-1 CRITICAL / round-2 MAJOR findings in `dc92f4b6` were about a
different, riskier shape: matching the wrap's inner against ring entry K while checking a separate value
(`strippedCurrent`) against some OTHER, DECOUPLED entry J — a pairing failure that could misattribute an
unrelated real loss. `7a64f16b` establishes the analogous, independently-derived principle on a sibling
mechanism (the give-up/lone-signature matcher): "when the confirming content equals the currently
outstanding write's own text, attribute it to the current generation, unless ancestry says otherwise" — the
irreducible tie errs toward a duplicate, never a loss, and **one echo resolves at most one lineage**.

This card's fix (`isRecognizedBarePastedContentWrapOfCurrent`) never touches the ring on its own — it
compares `reported` (bare-wrap-stripped) directly against the CURRENT generation's own `intended`, the same
zero-ring-involvement shape as the already-shipped, uncontroversial `isRecognizedPastedContentWrap`
(full-framing case), just for the bare-framing variant `e59880fe` separately introduced. When
`inner === intended` (or `.trimEnd()`) and no OTHER generation was ACTUALLY RESOLVED by this same echo
(the precise signal Round 3 settles on — see below; a mere substring match that resolves nothing does not
count), the current generation's own content is PROVABLY known to have arrived — because the bytes the
engine echoed back are definitionally what the current generation needed delivered. **Round 2 found this
reasoning breaks down when another generation IS actually resolved by the same echo** — see below.

## Round 2 (Code Review BLOCKING) — one echo cannot resolve two generations

**The finding**, from a real lag-by-one chain (session `a7c072c4`, 2026-10-18): `intended` is
`live.lastPrompt`, the LATEST write. Generation 49's hook was a bare wrap of generation 48's write, and
generation 50's was a bare wrap of generation 49's — each generation's own confirmation lags one behind,
structurally, the whole session long. Generation 50's own text never separately echoed at all; its
`[prompt-mismatch-unresolved]` timer, once armed, is the ONLY signal that content was ever lost. Now make
generation 50's text byte-identical to generation 49's (the card's own "continue sent twice" shape — this
is NOT a contrived edge case, it is the SAME population the card was filed to fix). Round 1's cut matched
`isRecognizedBarePastedContentWrapOfCurrent` for generation 50's hook; the pre-existing path (unconditional)
marked generation 49 resolved, and Round 1's own `mismatchResolvedGens.add(submitGeneration)` marked
generation 50 resolved TOO — from the SAME single echo. No timer, no notice: a write that never arrived
goes silent forever. The record's original "provably arrived, not ambiguous" premise was wrong exactly
when the text is identical to an EARLIER entry's own text — at that point there are two equally-consistent
readings of the same echo (a late confirmation of generation 49, or an actual confirmation of generation
50), and resolving BOTH from one echo is precisely the double-resolution bug `7a64f16b` already warns
against.

**Round 2's own "exactly one reachable shape" derivation below was WRONG — superseded by Round 3.** It
claimed that whenever `unmatchedRecognized !== null` alongside `isRecognizedBarePastedContentWrapOfCurrent`,
the matched ring entry Y must satisfy `Y === intended` exactly (the full span), because a SHORTER or offset
Y would leave a remainder that isn't exactly the tag framing, making `wrappedReplayOfPriorWrite` fail — and
reasoned from that to "so checking `unmatchedRecognized !== null` alone is a sound ambiguity signal." THE
ERROR: a shorter Y failing to produce `wrappedReplayOfPriorWrite` is exactly the point — it means Y was
NEVER ACTUALLY RESOLVED by this echo at all, so there is NOTHING TO BE AMBIGUOUS ABOUT; the derivation
correctly proved the remainder mismatch and then drew the wrong conclusion from it (treating "no
double-resolution risk from this Y" as "therefore flag it ambiguous anyway"). See Round 3 below for the
corrected signal and its own test proof (scenario (f)).

**Round 2's own ruling text below is superseded too** — kept for history, but see Round 3's ruling, which
replaces `unmatchedRecognized !== null` with a signal keyed to whether a generation was ACTUALLY resolved:
- When `isRecognizedBarePastedContentWrapOfCurrent` matches AND an earlier ring entry also matched
  (`unmatchedRecognized !== null`, which implies `wrappedReplayOfPriorWrite !== null` too whenever both
  conditions hold — see the derivation above), do NOT mark the current generation resolved. Keep the
  current generation's unresolved timer ARMED — i.e. do not skip the notice/timer-arming else-if block;
  defer entirely to the pre-existing `wrappedReplayOfPriorWrite` path (loud, same as before this card ever
  existed). Suppressing the immediate mismatch notice specifically would have been acceptable too, but the
  simplest, safest implementation is to change nothing for this case at all.
- When NO earlier ring entry matched at all (unambiguous — the current generation's own bare-wrapped
  content, unrelated to anything else in the ring), keep the original behaviour: fully resolved and silent.

## Round 3 (Code Review BLOCKING, the CR's own probe) — ambiguity means "actually resolved," not "merely matched"

**The finding**: `findRecognizedSubstring` (host.ts:348) returns the newest ring entry appearing ANYWHERE
inside `reported` as a substring, with NO minimum length and no requirement that it resolves anything.
Round 2's `unmatchedRecognized !== null` signal fires on that bare substring match alone. Probe: gen=1
writes "ok"; gen=2's own intended text is "ok, continue with the plan"; the engine bare-wraps gen=2's echo.
"ok" IS a substring of the wrap's inner, so `unmatchedRecognized` is non-null (Round 2's signal says
ambiguous) — but `wrappedReplayOfPriorWrite` stays null: the leading/trailing remainders around "ok" are
`<pasted_content id="X">\n` (matches the open-tag shape) and `, continue with the plan\n</pasted_content
id="X">` (does NOT match `PASTED_CONTENT_WRAP_REMAINDER_SUFFIX_RE`, anchored both ends to `\n</pasted_content
id="X">` with nothing else) — so generation 1 was NEVER ACTUALLY RESOLVED by this echo. Round 2's own fix
would have left this generation 2 loud (notice enqueued, timer armed) for a shape that is, in truth, fully
explained — the exact over-broad false positive this round closes. Control: an unrelated gen=1 ("hello
there", no substring relationship at all) goes silent, gen=2 resolved — unaffected by this round's change.

**The corrected signal**: ambiguity means "this echo ACTUALLY resolved another generation" — i.e. one of
the two PRE-EXISTING, unconditional markers fired: `wrappedReplayOfPriorWrite !== null` OR `replayedEntry
!== undefined` (the latter closes a SEPARATE gap, Minor 3 below — Round 2 never checked it, but the exact
same double-resolution risk exists if `replayedEntry` is what actually resolved the earlier generation). A
mere substring match that resolves nothing is not a competing claim and must NOT suppress this check.

**The ruling (manager):**
```
bareWrapOfCurrentAmbiguous = isBarePastedContentWrapOfCurrent
  && (wrappedReplayOfPriorWrite !== null || replayedEntry !== undefined)
```
This REPLACES Round 2's `unmatchedRecognized !== null` entirely — `unmatchedRecognized` is no longer read
by this check at all. The log line also now names WHICH prior generation was actually resolved
(`resolvedPriorGen`, sourced from whichever of the two markers fired) rather than gesturing at "an earlier
ring entry also matches" without saying which or whether it did anything.

## The fix

`isRecognizedBarePastedContentWrapOfCurrent(reported, intended)` (host.ts) — mirrors
`isRecognizedPastedContentWrap` exactly, including its `unescapeNestedPastedContentTag` fallback arm (card
`691d02e1` — added in Round 2; Round 1 had omitted it), matching `PASTED_CONTENT_BARE_WRAP_RE`: the
WHOLE-STRING, anchored-both-ends form of the bare-tag shape `matchPastedContentWrapFramingOfRemainder`'s
own two anchored regexes already describe (never `PASTED_CONTENT_WRAP_RE`'s full `\n\n…\n` shape). Requires
the SAME backreferenced id (`\1`) on open/close tags; never a substring/partial match on `inner`. This
function alone does NOT establish which generation's content arrived — see Round 2.

At the call site (Round 3), `bareWrapOfCurrentAmbiguous = isBarePastedContentWrapOfCurrent &&
(wrappedReplayOfPriorWrite !== null || replayedEntry !== undefined)` and
`confirmedBarePastedContentWrapOfCurrent = isBarePastedContentWrapOfCurrent &&
!bareWrapOfCurrentAmbiguous`. The else-if gate that already excludes `isPastedContentWrap` now ALSO
excludes `confirmedBarePastedContentWrapOfCurrent` (never the raw, unguarded flag) — so the ambiguous case
runs the else-if block in full, exactly as if this card's fix did not exist for it, while the unambiguous
case still goes fully silent. `live.mismatchResolvedGens.add(live.submitGeneration)` (pure state hygiene,
mirroring `dc92f4b6`'s own "mark N too" posture) is likewise gated on `confirmedBarePastedContentWrapOfCurrent`
— never reached in the ambiguous case. `unmatchedRecognized` is NOT read by this check at all (Round 3) —
only whether `wrappedReplayOfPriorWrite`/`replayedEntry` actually fired.

`wrappedReplayOfPriorWrite`'s existing, UNCONDITIONAL marking of the matched PRIOR gen as resolved is
unaffected either way — correctly so, since by the same transitive logic the prior gen's content is also
known to have arrived regardless of which case this turns out to be.

A diagnostic log, `[prompt-mismatch-bare-pasted-content-wrap-of-current]`, fires unconditionally on a
positive match (ambiguous or not) — gen numbers, lengths, an `ambiguous=true/false` flag, and (Round 3) a
`resolvedPriorGen=<gen>|null` field naming WHICH prior generation this echo actually resolved (only
non-null when ambiguous) — never content (no `redactedExcerpt(` call site added; `log-message-content-
gate.mjs`'s exact-count census is unchanged, confirmed by re-running it after this fix). The wording is
CONTENT-IDENTITY only — "the engine's bare-wrap inner is content-identical to THIS generation's own
intended text" — never a lineage claim ("NOT A REPLAY of any earlier generation," Round 1's wording, was
struck: it is a lineage claim `dc92f4b6`'s own doctrine forbids, and in the ambiguous case it would
directly contradict the `[prompt-mismatch-pasted-content-wrap-remainder-replay]` line the SAME hook also
prints). Round 2's wording ("an earlier ring entry also matches this exact echo") was itself imprecise —
it was true only by coincidence for the specimens Round 2 tested, and would have been FALSE for Round 3's
own probe (scenario (f): an earlier ring entry DOES match, yet nothing was resolved) had Round 2's
ambiguity signal not already been wrong first. Round 3's wording names the actually-resolved generation
instead of gesturing at "a match."

## Verification

- `test/pty-prompt-mismatch-bare-wrap-of-current.mjs`: (a) THE CARD'S OWN REPRO, AMBIGUOUS via
  `wrappedReplayOfPriorWrite` and therefore still loud — `arm=fallback-wrapped-replay-awaiting-resolution`
  fires, the timer arms for the current generation, only the earlier generation is marked resolved, the
  session notice enqueues with REPLAY wording; the new diagnostic log fires too (`ambiguous=true,
  resolvedPriorGen=1`) but confirms nothing. (g, Round 3, Minor 3) AMBIGUOUS via the OTHER marker,
  `replayedEntry` — gen=1's own literal submitted text IS the exact bare-wrap string the engine later
  echoes for gen=2's own (different, shorter) intended text; `arm=fallback-replay-awaiting-resolution`
  fires (the BARE sibling, never the wrapped one), only gen=1 is marked resolved (via the pre-existing,
  unconditional `replayedEntry` marking), `lastMismatchReplay.wrapped === false` — proving the ambiguity
  guard defers to BOTH competing markers, not just the wrapped one. (b) an identical-length one-byte
  divergence still declines; (c-1) a wrap whose inner merely CONTAINS `intended` still declines; (c-2)
  mismatched ids front/back still decline; (d) UNAMBIGUOUS POSITIVE CONTROL — the current generation's own
  text UNRELATED to the ring, bare-wrapped — is recognized as benign and goes fully silent. (f, Round 3's
  own probe) THE SECOND UNAMBIGUOUS POSITIVE CONTROL — gen=1 writes "ok", gen=2's own intended text is
  "ok, continue with the plan" (bare-wrapped): "ok" IS a substring of the wrap's inner (the
  `[prompt-mismatch-unmatched-remainder]` diagnostic DOES fire, proving `unmatchedRecognized` is non-null),
  but `wrappedReplayOfPriorWrite` never fires (remainder isn't exactly the tag framing) — nothing was
  ACTUALLY resolved, so this must stay unambiguous: fully silent, gen=2 resolved, gen=1 NOT resolved, no
  timer armed. This is the exact shape Round 2's own (superseded) signal got wrong. (e) card `e59880fe`'s
  own genuinely-unrelated wrapped-replay population (current gen's text differs from the wrapped entry)
  stays loud and unaffected.
- `test/pty-prompt-mismatch-unresolved.mjs` PART 10 (unchanged from Round 2, RE-VERIFIED green under the
  new Round 3 definition): the IDENTICAL-TEXT lag-by-one-chain scenario — asserts the timer not only arms
  but actually FIRES `onPromptMismatchUnresolved` once the (env-shrunk) resolve window elapses with
  nothing to resolve generation 2, naming it (never the matched generation 1). This specimen's ambiguity
  is carried by `wrappedReplayOfPriorWrite` (not `replayedEntry`), so the Round 3 formula still classifies
  it ambiguous exactly as Round 2's did — the manager's own stop-condition ("if PART 10 stops being
  ambiguous under the new definition, report blocked") did NOT trigger.
- Lesson 199 negative controls, surgically, clearing `tsconfig.tsbuildinfo` before each rebuild: (1)
  removed `&& !confirmedBarePastedContentWrapOfCurrent` from the else-if gate, rebuilt — exactly 1 failure
  (scenario (d)'s own "no `[prompt-mismatch-arm]` line at all" check; scenario (a) is UNAFFECTED by this
  mutant, since it was already gated out via ambiguity before this clause even applies — a precise,
  narrow RED, not a broad one) — restored byte-identical, rebuilt, GREEN. (2) Weakened
  `PASTED_CONTENT_BARE_WRAP_RE` by dropping the `\1` backreference (two independent capture groups
  instead), rebuilt — scenario (c-2) (mismatched ids) went RED (3 failures), nothing else — restored
  byte-identical, rebuilt, GREEN. (3, Round 3) reverted `bareWrapOfCurrentAmbiguous` to Round 2's
  `isBarePastedContentWrapOfCurrent && unmatchedRecognized !== null`, rebuilt — 9 failures across BOTH new
  scenarios, in OPPOSITE directions: (f) went RED because Round 2's signal wrongly calls it ambiguous (the
  false positive this round's probe targeted), AND (g) ALSO went RED, for the opposite reason — Round 2's
  `unmatchedRecognized` is only computed when `replayedEntry === undefined` (host.ts ~:9340), so for
  scenario (g) (where `replayedEntry` IS what resolved generation 1) `unmatchedRecognized` stays `null` and
  Round 2's signal wrongly calls it UNAMBIGUOUS — a false negative that would have double-resolved two
  generations from one echo, the exact bug this round exists to close. Restored byte-identical, rebuilt,
  GREEN; PART 10 of `pty-prompt-mismatch-unresolved.mjs` re-confirmed GREEN both before and after this
  mutant (its own specimen is carried by `wrappedReplayOfPriorWrite`, which this mutant never touched).
- `pnpm --filter @loom/daemon guards` — all 30 guards pass.
- The full prompt-mismatch + give-up families, by the selector `test/*mismatch*.mjs` UNION `test/*giveup*.mjs`
  (56 distinct files) PLUS `log-message-content-gate.mjs` (57 files total, per the Code Reviewer's own
  count this round — the classifier changed, so this round re-ran the whole family rather than just the
  two directly-touched files), run serially under both `env -u LOOM_DEV -u LOOM_SUPERVISED` and
  `LOOM_DEV=1` — 114 runs, 0 failures.
- EOL: `working-tree-eol-guard.mjs` passes.
- `git show HEAD:packages/daemon/src/pty/host.ts` read back and confirmed matching the on-disk source.

## Known residual (flagged, not fixed by this card)

A tagged re-mint (current gen carries `[loom:possible-duplicate]`) that gets BARE-wrapped (rather than
full-framed) is an uncovered combination: `isRecognizedBarePastedContentWrapOfCurrent` compares against raw
`intended` (not tag-stripped), mirroring `isRecognizedPastedContentWrap` exactly — neither function strips
the possible-duplicate tag before comparing. `findRecognizedPastedContentWrapOfPriorWrite` (the dc92f4b6
re-mint-aware detector) only matches the FULL framing shape. So a re-mint that happens to get bare-wrapped
falls through to the ordinary `wrappedReplayOfPriorWrite`/`fallback-unrecognized` path, same as before this
card — out of scope here, same posture `dc92f4b6`/`79999395` took toward their own uncovered shapes (named,
not chased). Separately out of scope: the lead's own 06:52Z specimen (full framing, +3 in-body excess) —
carded separately by the manager, not this card's concern.

**Minor 2 (Round 3, record-only, no code change — accepted):** when the current generation's own intended
text literally CONTAINS a `<pasted_content id="...">...</pasted_content id="...">` tag (a nested/escaped
possible-duplicate framing), the engine's echo of it gets escaped by the CLI's own composer before Loom
ever sees `reported` — `unescapeNestedPastedContentTag` exists precisely to undo this (see
`isRecognizedBarePastedContentWrapOfCurrent`'s own `unescaped` fallback arm). When an EARLIER generation's
own recorded write ALSO contains that literal tag text, the escaping can hide the earlier entry from
`findRecognizedSubstring`'s own search (it scans `reported`'s literal bytes, which are the ESCAPED form,
against the ring's RAW, unescaped text) — so this check resolves the CURRENT generation instead of the
earlier one that might have been the "real" referent. This still resolves only ONE generation (never both
— the double-resolution bug this card fixes), and a resolution is never a false SILENCE of a real loss: at
most it attributes the resolution to the wrong one of two generations whose content both plausibly
arrived. Rare — requires literal paste-tag syntax inside ordinary session text — and accepted as a known,
out-of-scope attribution asymmetry, same posture as the possible-duplicate residual above.

## Do not

- Do not widen `isRecognizedBarePastedContentWrapOfCurrent`'s match to a substring/partial recognition on
  `inner` — it must be the WHOLE bare-wrap body, nothing more.
- Do not drop the backreferenced-id equality check (`\1`) in `PASTED_CONTENT_BARE_WRAP_RE` — proven
  load-bearing by its own lesson-199 mutant; a wrap with mismatched open/close ids must never confirm.
- Do not have this function strip a possible-duplicate tag from `intended` before comparing — it
  deliberately mirrors `isRecognizedPastedContentWrap`'s own untagged-comparison scope; the tagged/bare
  combination is a named, uncovered residual (see above), not something to fold in here.
- Do not mark the current generation resolved, and do not skip the notice/timer-arming else-if block, when
  `wrappedReplayOfPriorWrite !== null || replayedEntry !== undefined` alongside
  `isRecognizedBarePastedContentWrapOfCurrent` — that is the double-resolution bug Round 2/3 fixed
  (`7a64f16b`: one echo resolves at most one lineage). The ambiguity guard (`bareWrapOfCurrentAmbiguous`)
  belongs at the CALL SITE, never inside `isRecognizedBarePastedContentWrapOfCurrent` itself, which has no
  visibility into the ring at all by design.
- ⛔ Do NOT use `unmatchedRecognized !== null` as the ambiguity signal (Round 2's own formula) — it is
  BOTH too broad (a mere substring match that resolves nothing, scenario (f)) AND too narrow
  (`unmatchedRecognized` is only computed when `replayedEntry === undefined`, so it is structurally blind
  to the `replayedEntry`-carried ambiguity, scenario (g)). Round 3's lesson-199 mutant proved both
  directions wrong in one run (9 failures). The signal is specifically "did `wrappedReplayOfPriorWrite` or
  `replayedEntry` actually fire" — nothing else.
- Do not word the new diagnostic log, or any description of this check, as a lineage claim ("replay of",
  "is the re-mint of", "not a replay of") — content identity only, `dc92f4b6`'s own standing discipline.
  Round 1's own log line violated this ("NOT A REPLAY of any earlier generation") and was corrected in
  Round 2.
- Do not conflate marking the matched PRIOR generation resolved (a real effect, inherited unconditionally
  from the pre-existing `wrappedReplayOfPriorWrite`/`replayedEntry` marking, in EITHER the ambiguous or
  unambiguous case) with marking the CURRENT generation resolved (pure state hygiene, gated on
  `confirmedBarePastedContentWrapOfCurrent`, never reached in the ambiguous case) — same distinction
  `dc92f4b6` draws for its own two markings.
- Do not add content to the new diagnostic log line — gen numbers, lengths, the `ambiguous` boolean, and
  the resolved generation NUMBER (`resolvedPriorGen`) only; a content-bearing addition would need a
  `redactedExcerpt(` call and would need `log-message-content-gate.mjs`'s exact-count census updated,
  which this card deliberately avoided needing.
- Do not re-derive the prompt-mismatch + give-up family file count by hand-curating a list — use the
  `test/*mismatch*.mjs` UNION `test/*giveup*.mjs` selector (56 files as of this writing, itself subject to
  drift as files are added/removed) and re-glob it fresh each time, per this file's own "point at a source
  of truth" discipline. Round 3 ran this selector PLUS `log-message-content-gate.mjs` (57 files) — a
  separate, explicit addition, not folded into the selector itself.

## Source

Inline comments in `packages/daemon/src/pty/host.ts`: `PASTED_CONTENT_BARE_WRAP_RE`'s own doc,
`isRecognizedBarePastedContentWrapOfCurrent`'s own doc, and the `isBarePastedContentWrapOfCurrent`/
`bareWrapOfCurrentAmbiguous`/`confirmedBarePastedContentWrapOfCurrent`/`resolvedPriorGen` computation + its
gate in `deliverHook`'s `UserPromptSubmit` case. Tests:
`packages/daemon/test/pty-prompt-mismatch-bare-wrap-of-current.mjs` (scenarios a/d/f/g are the ones this
round added or changed meaning), PART 10 of `packages/daemon/test/pty-prompt-mismatch-unresolved.mjs`
(unchanged this round, re-verified).
