# 437daade — a FULL-framing wrap of the CURRENT generation is not a replay of an earlier one with identical text

The full-framing twin of `docs/decisions/37acd59f-bare-wrap-of-current-generation-content-identity.md`
(read that record first — the narrative, the ambiguity rule, and the "one echo resolves at most one
lineage" reasoning are all shared; this record states only what differs for the FULL-framing shape).

## Narrative

The second Code Reviewer on card 37acd59f flagged, by READING only, that the FULL-framing path
(`isRecognizedPastedContentWrap` / `isPastedContentWrap`, host.ts) behaves differently from its bare-tag
twin on an identical-text lag-by-one echo: it has NO ambiguity guard at the call site at all. If gen=2's
own intended text is byte-identical to gen=1's own (never-confirmed) recorded write, and the engine
FULL-wraps the echo (the `\n\n<pasted_content id="X">\n...\n</pasted_content id="X">\n` shape), the
unconditional `isPastedContentWrap` match silently skipped the ENTIRE else-if classification block — no
`[loom:prompt-mismatch]` notice, no follow-up unresolved timer, and NEITHER generation was ever marked in
`mismatchResolvedGens`. This is the loss-silencing direction the first CR on 37acd59f blocked on.

This worker (card 437daade) CONFIRMED the finding by direct, hermetic execution before any code changed
(a probe script mirroring PART 10 of `test/pty-prompt-mismatch-unresolved.mjs`, but with FULL framing),
reported it `blocked` with the exact mechanism and a fix plan, and implemented the approved plan after
manager sign-off.

**A second, compounding gap, found during investigation:** even with an ambiguity guard added, there was
no way to DETECT the ambiguity for the full-framing shape. `matchPastedContentWrapFramingOfRemainder`
(card e59880fe) only recognizes the BARE single-newline remainder shape
(`<pasted_content id="X">\n` / `\n</pasted_content id="X">`); the FULL double-newline remainder this
specimen's own leading/trailing remainders actually are (29/29 chars for a 4-char id, measured) never
matched it — so `wrappedReplayOfPriorWrite` stayed null even though `findRecognizedSubstring` DID find
the earlier generation as a substring (confirmed in the probe: `[prompt-mismatch-unmatched-remainder]`
fired, but `[prompt-mismatch-pasted-content-wrap-remainder-replay]` never did).

## The fix

`matchFullPastedContentWrapFramingOfRemainder` (host.ts) — the FULL-framing twin of
`matchPastedContentWrapFramingOfRemainder`, split at `PASTED_CONTENT_WRAP_RE`'s own capture boundary
instead of the bare tag's own. Reuses the ALREADY-COMPUTED `unmatchedRecognized` (no second ring query),
same discipline as e59880fe. Deliberately NO trimEnd()/escaped-nested-tag tolerance — those tolerances
belong to the VARIABLE BODY content comparison (`isRecognizedPastedContentWrap`'s own `inner` vs `intended`
check, a different layer this card does not touch), not to this fixed-syntax remainder match. Anchored
both ends, same id charset as `PASTED_CONTENT_WRAP_RE`'s own prefix/suffix, requiring the SAME
backreferenced id on both sides.

Produces `fullWrapReplayOfPriorWrite` — the full-framing twin of `wrappedReplayOfPriorWrite` — marked
resolved unconditionally, same posture as its bare/full-replay siblings.

At the call site: `pastedContentWrapOfCurrentAmbiguous = isPastedContentWrap && (fullWrapReplayOfPriorWrite
!== null || replayedEntry !== undefined)` and `confirmedPastedContentWrapOfCurrent = isPastedContentWrap &&
!pastedContentWrapOfCurrentAmbiguous` — mirroring 37acd59f's own `bareWrapOfCurrentAmbiguous`/
`confirmedBarePastedContentWrapOfCurrent` exactly. The else-if gate now excludes
`confirmedPastedContentWrapOfCurrent` (never the raw, unguarded `isPastedContentWrap`). The UNAMBIGUOUS
case now marks the current generation resolved too (`live.mismatchResolvedGens.add(live.submitGeneration)`)
— bookkeeping parity with the bare twin; before this card the unambiguous full-wrap case was silent but
marked nothing, which this card closes as pure state hygiene (no observable effect, since no timer is ever
reachable for this generation on that branch).

Threaded through the rest of the classifier exactly like `wrappedReplayOfPriorWrite`:
- `isUnmatchableMismatch`'s exclusion list gained `&& !fullWrapReplayOfPriorWrite`.
- A new arm, `fallback-full-wrapped-replay-awaiting-resolution` (`isFullWrapReplayAwaitingResolution`),
  joins the timer-arming `if` alongside the bare and wrapped siblings. Deliberately NOT added to
  `RECORD_ONLY_MISMATCH_ARMS` (it is a loss-possible arm, same posture as its two siblings).
- `replayNote`/`lossClause` each gained a `fullWrapReplayOfPriorWrite` branch, worded identically to the
  `wrappedReplayOfPriorWrite` branch except naming FULL framing.
- `live.lastMismatchReplay`'s own population condition, `replayedGen`, `wrapped`, and `wrapIdLen`
  computations were widened to also cover `fullWrapReplayOfPriorWrite` — `wrapped` stays a SINGLE boolean
  covering EITHER framing (a reader checking "was this wrapped at all" needs no new field).
- The diagnostic log `[prompt-mismatch-full-pasted-content-wrap-of-current]` fires unconditionally on a
  positive `isPastedContentWrap` match (ambiguous or not), mirroring the bare twin's own log exactly — gen
  numbers, lengths, an `ambiguous` flag, and `resolvedPriorGen` — never content. CONTENT-IDENTITY wording
  only (`dc92f4b6`'s own discipline), never a lineage claim.
- `[prompt-mismatch-full-pasted-content-wrap-remainder-replay]` fires unconditionally whenever
  `fullWrapReplayOfPriorWrite` is non-null, mirroring the bare twin's own remainder-replay log.

## Verification

- `test/pty-prompt-mismatch-full-wrap-of-current.mjs` (new, 49 assertions, all passing): mirrors
  `test/pty-prompt-mismatch-bare-wrap-of-current.mjs`'s own scenario set (a/b/c-1/c-2/d/e/f/g), plus a NEW
  scenario (h) — a remainder with one EXTRA leading newline (not pure full framing) must not match
  `matchFullPastedContentWrapFramingOfRemainder`, proving the detector is anchored and no more tolerant
  than `PASTED_CONTENT_WRAP_RE` itself.
  - (a) THE CARD'S OWN REPRO: identical-text lag-by-one, full framing — ambiguous via
    `fullWrapReplayOfPriorWrite`, stays loud, timer armed for gen=2, only gen=1 marked resolved, notice
    uses REPLAY wording.
  - (g) ambiguous via the OTHER marker, `replayedEntry` — proves the guard defers to BOTH competing
    markers.
  - (b)/(c-1)/(c-2) negative controls (one-byte divergence / inner contains intended / mismatched ids) —
    unaffected, still fall to `fallback-unrecognized`.
  - (d) THE NON-IDENTICAL CONTROL (gen=1 "hello there", gen=2 "continue", full-wrapped) — unambiguous,
    silent, gen=2 now marked resolved (bookkeeping parity).
  - (f) THE SUBSTRING CONTROL (gen=1 "ok", gen=2 "ok, continue with the plan") — `unmatchedRecognized`
    fires but `fullWrapReplayOfPriorWrite` does not (remainder isn't pure framing) — stays unambiguous.
  - (h) THE REMAINDER-DETECTOR NEGATIVE CONTROL — extra leading newline, must decline.
  - (e) a genuinely-unrelated full-wrap-of-prior-write — NEW classification (before this card: plain
    `fallback-unrecognized`, since nothing recognized this shape at all) — now correctly loud via
    `fallback-full-wrapped-replay-awaiting-resolution`.
- `test/pty-prompt-mismatch-bare-wrap-of-current.mjs`, `test/pty-prompt-mismatch-unresolved.mjs` (PART 10),
  `test/pty-prompt-mismatch.mjs` — re-run, all green, no regression.
- Lesson 199 negative controls (surgical, `tsconfig.tsbuildinfo` cleared before each rebuild; each mutant
  restored and the on-disk diff confirmed byte-identical to the pre-mutant diff before rebuilding GREEN
  again):
  (1) reverted the else-if gate to `!isPastedContentWrap` (dropping `confirmedPastedContentWrapOfCurrent`)
  — 8 failures, scenarios (a) and (g) only (both AMBIGUOUS cases: the gate no longer defers to either
  ambiguity marker, so both silently confirm again — their own `[prompt-mismatch-arm]`/timer/
  `lastMismatchReplay`/notice checks all fail). Scenarios (b/c-1/c-2/d/e/f/h), all unambiguous or
  genuinely-unmatched, are UNAFFECTED (for the unambiguous case `confirmedPastedContentWrapOfCurrent` and
  raw `isPastedContentWrap` are identical, so this mutant changes nothing there).
  (2) disabled `matchFullPastedContentWrapFramingOfRemainder` (forced it to unconditionally return `null`)
  — 13 failures: scenario (a) loses its own ambiguity signal entirely (neither `fullWrapReplayOfPriorWrite`
  nor `replayedEntry` fires) and silently reclassifies as `confirmedPastedContentWrapOfCurrent` — the
  ORIGINAL bug this card fixes reappears for this exact specimen (no arm, no timer, no notice, gen=2
  wrongly resolved); scenario (e) loses its own new, more-precise classification and falls back to plain
  `fallback-unrecognized` (the second, compounding gap this card closes reopens).
  (3) narrowed the ambiguity definition to `isPastedContentWrap && replayedEntry !== undefined` (dropping
  `fullWrapReplayOfPriorWrite !== null`) — 7 failures, scenario (a) ONLY (the one specimen whose ambiguity
  is carried exclusively by `fullWrapReplayOfPriorWrite`, never `replayedEntry`) — the double-resolution
  bug reappears for exactly that specimen; scenario (g) (ambiguous via `replayedEntry`) is correctly
  unaffected, proving this mutant's effect is precisely scoped to the signal it removed.
- `pnpm --filter @loom/daemon guards` — all guards pass.
- The family `test/*mismatch*.mjs` UNION `test/*giveup*.mjs` (57 files, re-globbed fresh) PLUS
  `log-message-content-gate.mjs` (58 files total), run serially under both `env -u LOOM_DEV
  -u LOOM_SUPERVISED` and `LOOM_DEV=1` — 116 runs, 0 failures.
- EOL: `working-tree-eol-guard.mjs` passes (new file written via the `Write` tool, checked before commit).
- `git show HEAD:packages/daemon/src/pty/host.ts` read back and confirmed matching the on-disk source.

## Round 2: ring-scan replaces the remainder-regex ambiguity mechanism

Filed by the Code Reviewer against this card AND its bare predecessor (37acd59f) at once. **The mechanism
described above in "The fix" (`matchFullPastedContentWrapFramingOfRemainder`, `fullWrapReplayOfPriorWrite`)
no longer exists** — it was REPLACED by what follows. Read this section as the CURRENT state; "The fix" and
"Verification"/"Do not" above describe Round 1 only and are kept for history.

### The finding

Round 1's ambiguity signal, for BOTH framings, was a remainder-regex match (`matchPastedContentWrapFraming
OfRemainder`/`matchFullPastedContentWrapFramingOfRemainder`) applied to `findRecognizedSubstring`'s own
SINGLE, newest-first substring hit. Verified by direct probe (not merely by reading) that this silently
loses the alarm for FOUR real shapes, in both framings:

1. **Trailing-newline trim.** `intended` ends in `\n` (e.g. `"continue\n"`); the engine's own composer trims
   trailing whitespace before wrapping, so the wrap's inner is `"continue"`. `findRecognizedSubstring`
   still finds the PRIOR entry's own `"continue\n"` as a literal substring of `reported` (the `\n` is
   genuinely present — it's the single newline the wrap places before the closing tag), but the matched
   substring CONSUMES that newline, so the remainder regex's own leading-`\n` requirement on the suffix
   side fails. `isRecognizedPastedContentWrap`/`isRecognizedBarePastedContentWrapOfCurrent`, by contrast,
   already accept `inner === entryText.trimEnd()` — this shape was never actually ambiguous to THEM.
2. **Trailing-space, no substring hit at all.** Same mechanism, but the prior entry's own raw text (e.g.
   `"continue "`) is never a literal substring of the TRIMMED echo (`"continue"`) in the first place —
   `findRecognizedSubstring` returns nothing, so there is no remainder to even test.
3. **The CLI's own escaped-nested-tag form (card 691d02e1).** A prior entry whose own text contains literal
   `<pasted_content`/`</pasted_content` syntax gets ESCAPED by the CLI's composer when echoed back inside a
   wrap. The entry's RAW (unescaped) text is never a literal substring of the ESCAPED echo, so
   `findRecognizedSubstring` again returns nothing — even though `isRecognizedPastedContentWrap`'s own
   `unescapeNestedPastedContentTag` fallback arm already handles exactly this case for `intended`.
4. **A SHADOWED ring.** `findRecognizedSubstring` returns the FIRST (most recent) ring entry that is MERELY
   a substring of `reported`, with no regard for whether it resolves anything. A newer, unrelated entry
   whose own text happens to be a substring of an EARLIER entry's content (e.g. ring gen=1 `"continue with
   the plan"`, gen=2 `"continue"`, current gen=3 echoing gen=1's text again) pre-empts gen=1 ever being
   considered at all — the scan stops at gen=2's own non-framing partial hit and never reaches gen=1's own
   exact, tolerant match.

Each of the four specimens, before this round's fix, produced: no new-check log line, `mismatchResolvedGens`
containing only the CURRENT generation (never the matched prior one), and zero pending unresolved timers —
the exact silent-loss shape this card exists to close, surviving for every shape the underlying recognizers
already tolerate.

### The fix (current)

Replace the remainder-regex approach with a direct ring scan using the SAME recognizer the caller already
used to accept `reported` against `intended`:

```
bareWrapOfCurrentAmbiguous = isBarePastedContentWrapOfCurrent
  && (identicalContentPriorEntryBare !== null || replayedEntry !== undefined)
pastedContentWrapOfCurrentAmbiguous = isPastedContentWrap
  && (identicalContentPriorEntryFull !== null || replayedEntry !== undefined)
```

`identicalContentPriorEntryBare`/`identicalContentPriorEntryFull` come from ONE shared helper,
`findMostRecentUnresolvedPriorEntryAcceptedByRecognizer(reported, window, resolvedGens, accepts)`
(`pty/host.ts`), parameterized by the recognizer (`isRecognizedBarePastedContentWrapOfCurrent` for bare,
`isRecognizedPastedContentWrap` for full). It scans the ring NEWEST-prior first, skips any entry already in
`resolvedGens` (load-bearing, proven by its own lesson-199 mutant), and returns the first entry for which
`accepts(reported, entry.text)` is true. Reusing the recognizer itself — rather than re-deriving a
parallel, looser tolerance check — means the trimEnd/escape/id-charset tolerances can never drift between
"content-identical to `intended`" and "content-identical to a prior entry": they are, structurally, the
same test. This closes all four specimens above in one mechanism, for BOTH framings.

**This also fully SUBSUMES Round 1's narrower "wraps a genuinely different prior generation"
classification** (37acd59f/e59880fe's own `wrappedReplayOfPriorWrite`, this card's own
`fullWrapReplayOfPriorWrite`) — when `identicalContentPriorEntryBare`/`Full` is found and the current
generation's own content does NOT ALSO match `intended` (i.e. `isBarePastedContentWrapOfCurrent`/
`isPastedContentWrap` is false), that is exactly the same shape, now more robustly detected by the same
helper. The old remainder-matching functions and their regexes (`matchPastedContentWrapFramingOfRemainder`,
`matchFullPastedContentWrapFramingOfRemainder`, `PASTED_CONTENT_WRAP_REMAINDER_PREFIX_RE`/`_SUFFIX_RE`,
`PASTED_CONTENT_WRAP_FULL_REMAINDER_PREFIX_RE`/`_SUFFIX_RE`) are REMOVED entirely — nothing else consumed
them (verified by repo-wide grep before removal). The `[prompt-mismatch-pasted-content-wrap-remainder-replay]`/
`[prompt-mismatch-full-pasted-content-wrap-remainder-replay]` diagnostic LOG TAGS are unchanged — only what
populates them changed, so no existing test asserting on the tag name itself needed updating for that
reason alone (several still needed updating for the wording change below).

`fullWrapIdLenOf`/`bareWrapIdLenOf` (`pty/host.ts`) are tiny, structural-only re-executions of the SAME
anchored regex, purely to read back the wrap's own id length for a diagnostic log — they decide nothing;
the acceptance decision was already made by the recognizer.

### Minor 2 — session-notice wording (manager ruling)

For the AMBIGUOUS-AND-IDENTICAL case in BOTH framings (current generation's own content matches `intended`
AND a prior entry, under the same recognizer, OR `replayedEntry` also fires) — the session notice now
states CONTENT IDENTITY, never a lineage assertion: the echo's content is identical to an earlier, still-
unconfirmed write of this session; Loom cannot tell which of the two turns it carries; THIS turn's own
submission is not yet confirmed and a follow-up timer is armed for it. This REPLACES the "is a REPLAY of an
earlier generation ... did not reach you" wording (`dc92f4b6`'s own lineage-flavored phrasing) for exactly
this ambiguous-and-identical population — not for the genuinely-different "wraps an earlier, non-identical
entry" population (e.g. this card's own `scenario e` shape), whose existing wording is UNCHANGED.

### Round 2 Verification

- `test/pty-prompt-mismatch-full-wrap-of-current.mjs` and `test/pty-prompt-mismatch-bare-wrap-of-current.mjs`
  each gained 6 new scenarios: (i) trailing-newline trim, (j) trailing-space/no-substring-hit, (k) the
  CLI's escaped-nested-tag form, (l) that escape combined with a trailing newline, (m) a SHADOWED ring
  (gen1=X, gen2=a distinct substring of X, gen3=X again — proves the scan does not stop at gen2's own
  non-matching hit), and (n) the resolved-entry filter (an entry already resolved by some OTHER mechanism
  is not a competing claim). All pass in both framings.
- PART 11 of `test/pty-prompt-mismatch-unresolved.mjs` — the full-framing twin of PART 10, proving the full
  arm's own follow-up timer actually FIRES, not merely arms (Minor 1).
- Round 3 correction (the Round 2 text above named the wrong scenario): it is `pty-prompt-mismatch-pasted-
  content-wrap-replay.mjs` scenario 1 (the POSITIVE CONTROL, where the TAG-required dc92f4b6 mechanism
  `pastedContentWrapOfPriorWrite` DOES confirm against gen=1) that was found to double-populate
  `lastMismatchReplay` — fixed by gating `identicalContentPriorEntryFull`/`Bare`'s own computation on the
  SAME exclusion list `unmatchedRecognized` already uses (a confirmed fusion/diverged-prior fusion/
  wrapper-aware fusion/`pastedContentWrapOfPriorWrite` already fully explains `reported`). Scenarios 4/6 of
  that same file are the UNRELATED/decoupled-pairing counter-specimens, where `pastedContentWrapOfPriorWrite`
  itself DECLINES — the exclusion gate has nothing to exclude there, so they were never the ones this gate
  fixed.
- Lesson-199 negative controls (`tsconfig.tsbuildinfo` cleared before each rebuild; each mutant restored
  and the on-disk diff confirmed byte-identical to the pre-mutant diff before rebuilding GREEN again):
  (a) replaced the helper's own ring scan with a faithful reproduction of the OLD mechanism's two defects
  at once (checks only the single newest entry, like `findRecognizedSubstring`'s own single hit, AND
  requires an exact, non-tolerant match) — scenarios (i)/(j)/(k)/(l)/(m) all went RED in both framings (29
  failures full, 24 failures bare); scenario (a) and (e) in the full file also went red as a side effect
  of the mutant's own regex shape, a broader but still correctly-directioned RED.
  (b) dropped the resolved-entry filter (`resolvedGens.has(entry.gen)` skip) — exactly scenario (n) went
  RED, in both framings, nothing else — precisely scoped to the signal the mutant removed.
  (c) hardcoded both `bareWrapOfCurrentAmbiguous`/`pastedContentWrapOfCurrentAmbiguous` to `false` — 37
  failures in each framing (every ambiguous scenario: a, g, i, j, k, l, m), the original double-resolution
  bug reappearing broadly.
- `pnpm --filter @loom/daemon guards` — all 30 guards pass.
- The family `test/*mismatch*.mjs` UNION `test/*giveup*.mjs` (57 files, re-globbed fresh) PLUS
  `log-message-content-gate.mjs` (58 files total), run serially under both `env -u LOOM_DEV
  -u LOOM_SUPERVISED` and `LOOM_DEV=1` — 116 runs, 0 failures.
- `git show HEAD:packages/daemon/src/pty/host.ts` read back and confirmed matching the on-disk source.

## Round 3: a generation confirmed by its own clean echo is not a competing ambiguous claim

### The finding

`findMostRecentUnresolvedPriorEntryAcceptedByRecognizer`'s own `resolvedGens` filter (Round 2) reads ONLY
`live.mismatchResolvedGens` — every write to that set happens in the MISMATCH branch of the classifier
(`hook.prompt !== live.lastPrompt`). A generation confirmed by its OWN clean, byte-identical echo (the
OTHER branch — `hook.prompt === live.lastPrompt`) was never added to it, so a cleanly-delivered prior
generation still counted as a candidate the ambiguity guard could defer to. Probe (both framings): gen=1
"continue" with a clean, byte-identical `UserPromptSubmit`; gen=2 "continue" whose echo is wrapped ⇒
ambiguous=true, gen=1 marked resolved, gen=2's own unresolved timer armed and `onPromptMismatchUnresolved`
fires — a FALSE alarm for two cleanly-delivered sends, where main (pre-437daade) was silent for the
FULL-framing shape. Round 1 of this card introduced the regression; the bare twin inherited it from
37acd59f.

### The fix

A new, dedicated, ring-bounded set, `Live.echoConfirmedGens` (`pty/host.ts`) — deliberately SEPARATE from
`mismatchResolvedGens`, never overloaded into it (every existing reader of `mismatchResolvedGens` means "a
mismatch was resolved"; conflating the two would change that meaning for no benefit). Populated at the
clean-echo branch of `UserPromptSubmit` (`hook.prompt === live.lastPrompt`), bounded to
`COMPOSER_ACCUM_WINDOW` and pruned oldest-first exactly like `recentWrittenTurns` — a gen outside that
window can never be returned by the scan anyway (it only ever walks `recentWrittenTurns`), so nothing
beyond the window is worth retaining. `findMostRecentUnresolvedPriorEntryAcceptedByRecognizer` gained a
4th parameter, `echoConfirmedGens`, and its filter now excludes a gen in EITHER set:
`resolvedGens.has(entry.gen) || echoConfirmedGens.has(entry.gen)`. Both call sites (bare and full) pass
`live.echoConfirmedGens`.

### Verification

- `test/pty-prompt-mismatch-full-wrap-of-current.mjs` and `test/pty-prompt-mismatch-bare-wrap-of-current.mjs`
  each gained scenarios (o) (the direct repro: a clean-confirmed immediate prior + a wrapped identical
  current generation ⇒ UNAMBIGUOUS, current resolved silently, NO timer, no notice) and (o2) (the same
  shape with the clean-confirmed entry TWO generations back, proving the exclusion isn't an
  immediate-prior-only special case). All pre-existing scenarios (a–n) stay green.
- Lesson-199 negative control (`tsconfig.tsbuildinfo` cleared before rebuild, mutant restored and the
  on-disk diff confirmed byte-identical to the pre-mutant diff before rebuilding GREEN again): dropped the
  `echoConfirmedGens.has(entry.gen)` half of the filter — exactly 8 failures per framing, scenarios (o) and
  (o2) only; every other scenario (a–n) unaffected.
- `pnpm --filter @loom/daemon build` clean.
- Closed a pre-existing test gap found during this round: three counter-specimen scenarios
  (`pty-prompt-mismatch-pasted-content-wrap-replay.mjs` scenarios 4/6, `pty-prompt-mismatch-wrapped-
  remainder-replay.mjs` scenario 4) asserted only that the follow-up timer was ARMED, never that the
  session notice was actually DELIVERED or that the timer actually FIRES. Each file now sets the same
  env-shrunk `LOOM_PROMPT_MISMATCH_RESOLVE_WINDOW_MS` and wires `onPromptMismatchUnresolved` the same way
  `pty-prompt-mismatch-unresolved.mjs` does, and asserts both.
- The family `test/*mismatch*.mjs` UNION `test/*giveup*.mjs` PLUS `log-message-content-gate.mjs`, re-globbed
  fresh, run serially under both `env -u LOOM_DEV -u LOOM_SUPERVISED` and `LOOM_DEV=1`.
- `pnpm --filter @loom/daemon guards` all pass.
- `git show HEAD:packages/daemon/src/pty/host.ts` read back and confirmed matching the on-disk source.

### Record correction (this round)

The Round 2 Verification section above wrongly attributed a `lastMismatchReplay` double-population defect
to `pty-prompt-mismatch-pasted-content-wrap-replay.mjs` scenarios 4/6. Those are the UNRELATED/decoupled-
pairing counter-specimens, where `pastedContentWrapOfPriorWrite` (the TAG-required dc92f4b6 mechanism)
itself DECLINES — the exclusion gate has nothing to exclude there. The scenario that actually exercises the
gate is scenario 1 (the POSITIVE CONTROL), where `pastedContentWrapOfPriorWrite` DOES confirm against
gen=1; without the gate, the tag-free ring scan would ALSO have matched gen=1 via the generic recognizer
and double-populated `lastMismatchReplay` even though the TAG-required mechanism already fully explained
`reported`. Fixed in that section's own text above (no further change needed there beyond the correction
already made).

### Non-blocking note (Code Review): a same-severity asymmetry in `replayedEntry`

`replayedEntry = live.recentWrittenTurns.findLast((e) => e.text === reported)` — the WHOLE-STRING exact
replay marker — does NOT apply the resolved-entry filter the ring-scan helper applies
(`resolvedGens`/`echoConfirmedGens`). So a wrapped re-echo whose bytes happen to equal an ALREADY-RESOLVED
prior entry's own literal text verbatim (the scenario (g) shape, but against a resolved entry instead of
an unresolved one) still matches `replayedEntry`, which in turn declines to recognize the wrap at all for
every current detector that depends on it being unmatched elsewhere — the net classification lands at
`fallback-unrecognized` (still loud, no follow-up timer armed via the wrap arms, since `replayedEntry`'s
own ambiguity/ different-shape reasoning doesn't apply once the matched entry is resolved). This is a
narrower, lower-frequency sibling of the gap Round 3 fixes for the ring-scan path, left as a NON-BLOCKING
observation — no code change was made for it in this round. A future round touching `replayedEntry`'s own
resolved-entry awareness should read this note first.

## Do not

- Do not reintroduce the remainder-regex approach Round 2 replaced — it is measured, not merely suspected,
  to miss the trailing-newline, trailing-space, escaped-tag, and shadowed-ring shapes.
- Do not overload `Live.mismatchResolvedGens` with a clean-echo confirmation (Round 3) — keep
  `echoConfirmedGens` a separate set, or every existing reader of `mismatchResolvedGens` ("a mismatch was
  resolved") silently gains a second, different meaning.
- Do not drop the `echoConfirmedGens.has(entry.gen)` half of the ring-scan helper's filter (Round 3) — a
  gen confirmed by its own clean echo is not a competing ambiguous claim; a lesson-199 mutant that drops
  only this half reproduces the false alarm for scenarios (o)/(o2) while leaving (a–n) untouched.
- Do not drop the resolved-entry filter (`resolvedGens.has(entry.gen)` skip) inside
  `findMostRecentUnresolvedPriorEntryAcceptedByRecognizer` — an entry already known to have arrived via
  some OTHER mechanism is not a competing, ambiguous claim; a lesson-199 mutant that ignores this filter
  wrongly classifies an already-resolved match as ambiguous.
- Do not widen the `accepts` parameter to anything looser than the real recognizer the caller uses for
  `intended` — the whole point is that the SAME function decides both questions, so they can never drift.
- Do not use Round 2's content-identity wording for the genuinely-different "wraps an earlier, non-
  identical entry" population — that wording is unchanged and must stay unchanged (Minor 2's own scope).
- Do not mark the current generation resolved, and do not skip the notice/timer-arming else-if block, when
  `identicalContentPriorEntryFull !== null || replayedEntry !== undefined` alongside `isPastedContentWrap` —
  that is the double-resolution bug this card fixes (`7a64f16b`: one echo resolves at most one lineage).
  The ambiguity guard (`pastedContentWrapOfCurrentAmbiguous`) belongs at the CALL SITE, never inside
  `isRecognizedPastedContentWrap` itself.
- Do not add `fallback-full-wrapped-replay-awaiting-resolution` to `RECORD_ONLY_MISMATCH_ARMS` — it is a
  loss-possible arm this alarm exists to keep loud, same as its two siblings.
- Do not word the diagnostic log, or any description of this check, as a lineage claim — content identity
  only, `dc92f4b6`'s own standing discipline.
- Do not re-derive the prompt-mismatch + give-up family file count by hand-curating a list — use the
  `test/*mismatch*.mjs` UNION `test/*giveup*.mjs` selector and re-glob it fresh each time.

## Source

Inline comments in `packages/daemon/src/pty/host.ts`: `findMostRecentUnresolvedPriorEntryAcceptedByRecognizer`'s
own doc, `fullWrapIdLenOf`/`bareWrapIdLenOf`'s own doc, and the `identicalContentPriorEntryFull`/
`identicalContentPriorEntryBare`/`pastedContentWrapOfCurrentAmbiguous`/`confirmedPastedContentWrapOfCurrent`/
`isFullWrapReplayAwaitingResolution`/`isAmbiguousIdenticalText` computation in `deliverHook`'s
`UserPromptSubmit` case. Tests: `packages/daemon/test/pty-prompt-mismatch-full-wrap-of-current.mjs` and
`packages/daemon/test/pty-prompt-mismatch-bare-wrap-of-current.mjs` (Round 2's own scenarios i/j/k/l/m/n,
both framings), PART 11 of `packages/daemon/test/pty-prompt-mismatch-unresolved.mjs`.
