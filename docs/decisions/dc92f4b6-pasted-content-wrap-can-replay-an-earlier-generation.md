# dc92f4b6 — a late pasted-content-wrapped echo can replay an EARLIER generation, not just the current one

## Narrative

Card dc92f4b6: four real specimens on four different sessions, all large (~61-72k char) first kickoffs,
all producing a false `[loom:prompt-mismatch-unmatched]` "possible LOSS" push to the manager. Root-caused
from `daemon-output.log` (session ids d0c329c1, b17653a2, 413a268b, 5d3e32ed), not inferred.

Three of the four share one identical mechanism. Loom writes the real kickoff (generation 1,
`reason=kickoff-guarantee`). The engine's own confirmation lags past Loom's give-up window, so Loom
re-mints the same content wrapped in a `[loom:possible-duplicate root:xxxxxxxx] ` tag as generation 2
(`reason=drain`). The engine's LATE confirmation for the ORIGINAL generation 1 write then finally lands —
but by then it is compared against generation 2's `intended`, not generation 1's. The engine echoes
generation 1's content wrapped in its OWN paste-composer framing
(`\n\n<pasted_content id="XXXX">\n...\n</pasted_content id="XXXX">\n` — the same framing
`isRecognizedPastedContentWrap` already recognizes, but only against the CURRENT generation's own
`intended`). Compared against generation 2's dup-tag-wrapped `intended`, the two wrappers are textually
unrelated, so every existing "confirmed" reconciliation (`confirmedWrapperDeficit`/
`confirmedAnsiStripDeficit`/`confirmedWrapperAwareFusion`/`isRecognizedPastedContentWrap` itself) declines,
and the detector falls to `fallback-unrecognized` — even though `findRecognizedSubstring` independently
proves generation 1's FULL, exact content is present (its own `unmatchedRecognized` recognition is
enrichment-only, per card `d005f55b`, and never suppresses).

Verified arithmetically on all three specimens: the pasted-content-wrap overhead for a 4-char id is
58 chars (29 leading + 29 trailing — `\n\n<pasted_content id="` is 22 chars, `">\n` is 3, mirrored on the
closing tag); `reportedLen - intendedLen` was always exactly `58 - 40 = 18` (the dup-tag's own 40-char
overhead baked into the re-mint's `intended`), `divergesAtChar=0`, and `findRecognizedSubstring`'s own
`[prompt-mismatch-unmatched-remainder]` log named `recognizedGen=1` with `matchedLen` equal to generation
1's own recorded write length every time.

The fourth specimen (d0c329c1, gen=1 itself, `lenDelta=+60`, no re-mint involved) is a DIFFERENT,
already-known, already-instrumented shape: a 1-2 char excess INSIDE the wrap relative to the CURRENT
generation's own `intended` (card `ff871b77`'s `detectPastedContentWrapSmallExcess`), deliberately left
unsuppressed since existing doctrine there is "name it, don't fix it" (an unmeasured, possibly-genuine
tiny content divergence). This card's fix does not touch that shape.

A fifth, unrelated specimen (19b3d5cf, card `bd9a483b`) was checked and confirmed structurally distinct:
zero `[prompt-echo]` lines ever appear for it (the engine never confirms at all), vs. three stacking
`drain` re-mints — a real, separately-carded give-up/re-mint stacking bug, not a prompt-mismatch
detection gap, and untouched by this fix.

## The fix

`findRecognizedPastedContentWrapOfPriorWrite` (host.ts): parses the SAME `PASTED_CONTENT_WRAP_RE` as
`isRecognizedPastedContentWrap`, but matches the wrap's inner content against entries in
`live.recentWrittenTurns.slice(0, -1)` (the same window `findRecognizedSubstring` already searches,
excluding the current generation's own just-pushed entry) — requiring EXACT, WHOLE-INNER equality
(`entry.text` or `entry.text.trimEnd()`), never a substring.

**Code Review CRITICAL (confirmed) on the first cut**: matching the wrap against ANY prior ring entry
alone is unsound. The reviewer's own probe: generation 1 = A (unconfirmed), generation 2 = an UNRELATED
new message B (no possible-duplicate tag at all), and the engine happens to echo back the stale,
unconfirmed generation 1 wrapped in paste framing. The first cut confirmed on generation 1's content
regardless, which silently dropped generation 2's own real loss with no trace anywhere (no manager push,
no fallback classification) — and, since a BARE (unwrapped) replay of the same shape still correctly
falls to the ordinary unmatched/unrecognized path, the first cut made the WRAPPED shape *more lenient*
than the bare one for the exact same underlying hazard. Test scenario 4
(`pty-prompt-mismatch-pasted-content-wrap-replay.mjs`) reproduces this exact probe.

**The fix**: the detector now ALSO requires `stripPossibleDuplicateFrame(currentIntendedText)` to exactly
equal that SAME entry (`entry.text` or `entry.text.trimEnd()`), paired per-entry inside one loop iteration
— never inner-matches-one-entry while stripped-current matches a DIFFERENT one. `strippedCurrent ===
currentIntendedText` (no tag present at all) short-circuits to `null` immediately, so this tier never
engages for an ordinary, untagged generation.

**Code Review MAJOR (confirmed), round 2: the "SAME entry" half of this pairing was UNTESTED.** The
reviewer mutated the check to decouple the pairing — `matchesEntry(inner) && window.some(e =>
e.text===strippedCurrent || e.text.trimEnd()===strippedCurrent)` — checking the wrap's inner against
whichever entry the loop happens to bind, and `strippedCurrent` against ANY entry in the window
independently, rather than the SAME one. All 5 scenarios then in the file still PASSED under that mutant
— none of them had multiple window entries where inner matches one while `strippedCurrent` matches a
DIFFERENT one. Test scenario 6 closes that gap: generation 1=A (unconfirmed), generation 2=B (an
ORDINARY, UNRELATED new message, no tag), generation 3=`framePossibleDuplicate(B)` (current, tagged — a
re-send of B specifically), engine echoes `wrap(A)`. The mutant wrongly confirms (inner matches gen 1=A
via the loop; `strippedCurrent`=B separately matches gen 2 elsewhere in the window), misattributing
generation 3 to generation 1's content when generation 3's own tagged write is actually content-identical
to generation 2's. Proven RED under that exact mutant (mutated `src`, rebuilt, ran — scenario 6 failed on
all 4 of its own assertions, every other scenario still passed) and GREEN after a byte-identical restore
+ rebuild.

**CONTENT identity, never lineage.** The check proves `currentIntendedText` (tag stripped) is
byte-for-byte IDENTICAL to a prior entry's own recorded text — it does NOT, and cannot, prove the current
generation was literally MINTED as that entry's own re-send (an origin/causation claim the detector has
no way to observe). Word every description of this shape — comments, the diagnostic log, the
session-facing notice, this record — as content identity ("generation N's own intended text is
content-identical to generation K's write"), never as lineage ("generation N IS the re-mint of generation
K" / "the give-up re-mint of"). An earlier draft of the notice, the diagnostic log, and this record used
lineage wording throughout; Code Review (round 2) flagged it and all three were corrected.

When the check DOES engage: the CONTENT Loom intended for generation N is already known to have arrived,
confirmed via generation K's own echo — but generation N's OWN tagged write has NOT itself been
independently confirmed, and may still surface later as its own, separate
`[loom:possible-duplicate]`-labelled copy. The session-facing notice's action line names THAT pending
write as the duplicate-check risk (not generation K's own, already-confirmed turn) — the earlier draft
had this backwards too.

`live.mismatchResolvedGens` gets BOTH generations added, but for two DIFFERENT reasons, and the "Do not"
section below is precise about which is which: marking generation K is a REAL effect (clears a pending
resolve-timer on it, if any); marking generation N is pure STATE HYGIENE with NO observable effect (see
below for why).

Wired in at the same precedence tier as `confirmedWrapperAwareFusion` as a new
`confirmed-pasted-content-wrap-replay` arm, sending its own complete "NOT A LOSS OF CONTENT" session
notice (never patched onto `lossClause`). Since the manager push (`onPromptMismatchUnmatched`) only fires
for `mismatchArm === "fallback-unrecognized"`, reclassifying away from that arm is what stops the false
`[loom:prompt-mismatch-unmatched]` escalation — for the shape this fix actually covers; an unrelated
current generation's own loss still classifies `fallback-unrecognized` and still pushes, exactly as
before (scenarios 2, 3, 4, 6).

**No follow-up timer is involved anywhere in this population.** `isRecognizedReplayAwaitingResolution`
(the mechanism that arms `checkPromptMismatchUnresolved`) requires `replayedEntry !== undefined` — an
EXACT byte-for-byte match of the whole, unwrapped `reported` string — which is structurally impossible
for a wrapped echo (`reported` is never byte-identical to any entry once wrapped). `confirmedPastedContentWrapOfPriorWrite`
is still threaded into that condition's own exclusion list for textual completeness (it is
`isUnmatchableMismatch`'s documented structural twin — see `docs/decisions/f9b1ea00-orchestrationevent-prompt-mismatch-unresolved-ts-correction.md`
§3 for that twin-pairing contract itself), but it is a no-op there in practice. Marking generation N
resolved is therefore pure state hygiene: no timer to protect, added only so a later reader never
mis-reads generation N as "never resolved" for a shape that was, in fact, fully explained.

**Chained re-mint fail-closed limit**: if generation K is ITSELF re-minted more than once before
confirming (K → re-mint N → N also never confirms → re-mint M), `framePossibleDuplicate`'s own
idempotency (strips any existing tag before applying a new one) means `stripPossibleDuplicateFrame`
always recovers the SAME original, untagged content no matter how many hops occurred — so the identity
check still works IN PRINCIPLE across any chain length. In PRACTICE it depends on the original,
untagged entry still being present in `live.recentWrittenTurns`, a bounded ring (`COMPOSER_ACCUM_WINDOW`
= 8 entries). Once enough OTHER writes have happened in between to evict that original entry from the
ring, neither side of the pairing can match it any more, and this tier FAILS CLOSED — falls through to
the ordinary loud `fallback-unrecognized` path, exactly as if the fix didn't exist for that specimen.
Safe (never fails open), but means the false-positive reduction this card delivers does not extend
indefinitely across many re-mint hops or a busy ring.

## Do not

- Do not widen the match to a substring/partial recognition on EITHER side (the wrap's inner, or the
  current generation's own stripped intended text) — `findRecognizedSubstring` already names a partial
  wrap-inner match at its own weaker, non-suppressing tier (`unmatchedRecognized`); widening either side
  risks confirming on an unrelated current generation, reproducing the Code Review finding above
  (scenario 4).
- Do not decouple the pairing — matching the wrap's inner against ANY window entry and `strippedCurrent`
  against ANY window entry INDEPENDENTLY, rather than the SAME entry inside one loop iteration — that is
  the exact Code Review round-2 MAJOR finding; test scenario 6 exists specifically to catch a regression
  back to it, and was proven RED under that exact mutant.
- Do not drop the content-identity check (`stripPossibleDuplicateFrame(currentIntendedText)` against the
  matched entry) and go back to matching the wrap alone — that is the Code Review round-1 CRITICAL
  vulnerability; test scenario 4 exists specifically to catch a regression back to it.
- Do not word this check, or anything it produces, as proving LINEAGE ("generation N is the re-mint of
  generation K", "the give-up re-mint of") — it proves CONTENT identity only. An earlier draft got this
  wrong in the notice, the diagnostic log, and this record; Code Review (round 2) corrected all three.
- Do not describe marking generation K resolved and marking generation N resolved as the SAME kind of
  fact — K's marking is a real effect (clears a pending timer, if any); N's is pure state hygiene with no
  observable effect (no timer is ever reachable for it on this branch). Conflating the two overstates what
  the check establishes about generation N's own tagged write.
- Do not describe this population as arming (or needing to arm) a follow-up "unresolved" timer, in this
  record, in an inline comment, or in the session-facing notice — no such timer is structurally reachable
  for a wrapped echo (see above); an earlier draft of both the comment and this record incorrectly claimed
  one stayed armed for the current generation.
- Do not relax `isRecognizedPastedContentWrap`'s own `m[2] === intended` check (the CURRENT-generation
  case) to also search prior entries — that function is deliberately scoped to the current generation
  only; this is a separate, sibling detector precisely so the two never conflate.
- Do not fold the d0c329c1 / `ff871b77` small-excess shape into this fix — it is a different, unmeasured
  population that existing doctrine deliberately keeps loud.
- Do not add `confirmed-pasted-content-wrap-replay` to `RECORD_ONLY_MISMATCH_ARMS` — same posture as
  `confirmed-wrapper-deficit`/`confirmed-fusion`/`confirmed-diverged-prior`/`confirmed-wrapper-aware-fusion`
  (see the `d1ac9fed` record's own "Do not" section): it asks a real duplicate-check action of the reader.
- Do not assume this fix closes the gap across an arbitrary number of re-mint hops — it depends on the
  original, untagged entry still sitting in the bounded `live.recentWrittenTurns` ring; past that, it
  fails CLOSED (falls through to the loud path), never open.

## Source

Inline comments in `packages/daemon/src/pty/host.ts`: `findRecognizedPastedContentWrapOfPriorWrite`'s own
doc comment, the `pastedContentWrapOfPriorWrite`/`confirmedPastedContentWrapOfPriorWrite` computation
inside `deliverHook`'s `UserPromptSubmit` case, and the `mismatchArm`/`mismatchText` branches it feeds.
