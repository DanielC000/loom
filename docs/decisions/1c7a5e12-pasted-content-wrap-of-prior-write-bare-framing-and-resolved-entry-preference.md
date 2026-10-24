# 1c7a5e12 — the tag-aware pasted-content-wrap detector gains BARE framing and prefers an unresolved match

## Narrative

Two pre-existing follow-ups from card 437daade's second Code Review (reviewer a2df1914), both concerning
`findRecognizedPastedContentWrapOfPriorWrite` (card dc92f4b6, `pty/host.ts`) → arm
`confirmed-pasted-content-wrap-replay`. Both CONFIRMED by hermetic probe (createPty seam + fake pty,
mirroring `test/pty-prompt-mismatch-pasted-content-wrap-replay.mjs`'s own harness) before any code changed,
`worker_report`ed `blocked` with the exact mechanism and a fix plan, and implemented after manager sign-off.

**Point 1 — FULL framing only.** The detector only ever tested `PASTED_CONTENT_WRAP_RE` (the FULL
`\n\n<pasted_content...>\n...\n</pasted_content...>\n` shape). A BARE-wrapped tagged re-mint (the engine's
late echo uses the narrower `<pasted_content...>\n...\n</pasted_content...>` framing instead) fell through
entirely to card 437daade's own tag-FREE ring scan (`identicalContentPriorEntryBare`), which has no
visibility into the CURRENT generation's own possible-duplicate tag — the tag-stripping comparison only
happens inside dc92f4b6's own detector. Probe: gen=1 writes a kickoff (never confirmed); gen=2 re-mints it
(`framePossibleDuplicate`); the engine's late echo is a BARE wrap of gen=1's own write. Result (pre-fix):
gen=1 correctly resolved via the tag-free ring scan, but gen=2 (the current, tagged re-mint) stayed loud —
its own follow-up unresolved timer armed (`fallback-wrapped-replay-awaiting-resolution`) and genuinely
FIRED `onPromptMismatchUnresolved` after the resolve window, a measured false alarm for content that had,
in fact, fully arrived (gen=2's own tag-stripped content is content-identical to gen=1's write).

**Point 2 — no resolved-entry filter, no selection preference.** The detector scanned the ring newest-first
and returned the FIRST entry whose text matched both the wrap's inner content and the current generation's
own (tag-stripped) intended text — with no regard for whether that entry was already resolved by some
other mechanism. When two ring entries share identical content and the OLDER one is genuinely unresolved
(with its own real pending timer already armed, e.g. from an earlier, unrelated replay) while the NEWER one
is already resolved (e.g. via a clean echo, `Live.echoConfirmedGens`), the scan picked the newer,
already-resolved entry — a redundant, no-op mark — and never visited the older, genuinely-pending one.
That older entry's own real timer was then never cleared and genuinely fired a false alarm for content
that had, in fact, arrived via the very echo that matched its own identical text. Probe: gen=1 unrelated
content; gen=2 ("genA", older) intends shared content X, with its own hook plain-replaying gen=1's content
— arming genA's own unresolved timer (its own intended content never separately confirmed); gen=3 ("genB",
newer) also writes X, resolved via a real clean echo; gen=4 is a tagged re-mint of X, FULL-wrapped. The
detector matched genB (gen=3) instead of genA (gen=2), leaving genA's real timer to fire falsely.

Both specimens are "false alarm, loud direction" — never a silent loss. The detector's own tag-required
match criterion (requiring BOTH the wrap's inner AND the current generation's tag-stripped intended text to
equal the SAME entry) always ties the CURRENT generation's content identity to whichever entry is ultimately
selected — there is no 37acd59f/437daade-style "one echo could belong to either lineage" ambiguity to defer
for the CURRENT generation, since the tag was synthesized by wrapping specific prior content. The only
open question was WHICH prior entry to credit when several share identical text — a selection-preference
question, not a one-echo-two-gen ambiguity question. (See the manager's ruling below: dc92f4b6's original
"resolve both generations" posture stands, unchanged, for whichever entry is ultimately selected.)

## The fix

`findRecognizedPastedContentWrapOfPriorWriteCore` (`pty/host.ts`) — the shared scan body for BOTH framings,
parameterized by `wrapRe` (`PASTED_CONTENT_WRAP_RE` for FULL, `PASTED_CONTENT_BARE_WRAP_RE` for BARE), with
two thin entry points, `findRecognizedPastedContentWrapOfPriorWrite` (FULL) and the new
`findRecognizedBarePastedContentWrapOfPriorWrite` (BARE). The call site tries FULL first, then BARE only
when FULL declined (the two anchored wrap shapes can never both match `reported`), combining the result
into the SAME `pastedContentWrapOfPriorWrite` local every downstream consumer already reads, plus a new
`pastedContentWrapOfPriorWriteIsBare` boolean threaded only into the diagnostic log and
`lastMismatchPastedContentWrapReplay.bare`.

The shared core also takes `resolvedGens`/`echoConfirmedGens` (the SAME two sets 437daade's own
`findMostRecentUnresolvedPriorEntryAcceptedByRecognizer` already reads) and scans newest-first exactly as
before, but now **prefers an unresolved match**: a candidate already present in either set is remembered
as a fallback (first/newest one seen) and the scan keeps going; the first genuinely UNRESOLVED candidate
found is returned immediately. Only when NO unresolved candidate exists at all does the function fall back
to the remembered resolved one.

**Why not a hard skip-if-resolved filter, mirroring 437daade's sibling exactly?** That was considered and
rejected (manager ruling, point 2) — a hard skip would regress a real, if narrow, existing benefit: today,
when EVERY content-matching ring entry happens to already be resolved, the detector still credits one and
confirms the current generation silently. A hard skip would make the function return `null` in that case
(437daade's own ring-scan siblings apply the identical skip and would also return `null`), pushing the
current generation into a louder/weaker arm for no reason — its content is still provably identical to a
once-written entry, resolved or not. "Prefer unresolved, fall back to resolved" gets both properties: the
shadow is fixed when an unresolved candidate exists, and existing coverage is preserved when it doesn't
(test scenario 9, below).

**`lastMismatchPastedContentWrapReplay` gains a `bare: boolean` field** (mirrors `lastMismatchReplay`'s own
`wrapped` convention) — attribution only; severity/recovery semantics are IDENTICAL whether the match came
via FULL or BARE framing. `worker_list`'s own tool-description text for this field was updated in the same
change (contract change ⇒ docs in the same change) to name the new field and card 1c7a5e12. `worker_status`
only points at `worker_list` for this field's shape and needed no change.

**dc92f4b6's original "resolve both generations" ruling is UNCHANGED and stands** (manager ruling): marking
the matched prior entry resolved is a real effect (clears its own pending timer, if any); marking the
CURRENT generation resolved is pure state hygiene (no observable effect — no timer is ever reachable for it
on this branch). This card changes nothing about THAT marking — only which prior entry gets selected when
several share identical content.

## Verification

- `test/pty-prompt-mismatch-pasted-content-wrap-replay.mjs` gained three scenarios (71 total assertions,
  all passing): (7) POSITIVE CONTROL for point 1 — a BARE-wrapped tagged re-mint, asserting `bare=true`,
  `arm=confirmed-pasted-content-wrap-replay`, both generations resolved, NO follow-up timer armed, and
  `onPromptMismatchUnresolved` never fires. (8) POSITIVE CONTROL for point 2 — two identical-content ring
  entries, the older genuinely unresolved (its own real timer armed via an unrelated plain replay) and the
  newer already resolved (via a real clean echo, never an internal poke); the FULL-wrapped tagged re-mint
  must prefer the older, unresolved entry and its own timer must never fire. (9) NO-REGRESSION CONTROL —
  every matching candidate is already resolved (no unresolved one exists); the detector must still fall
  back to the resolved match and confirm the current generation silently, exactly as before this card.
- RED→GREEN, by execution: `git diff -- packages/daemon/src/pty/host.ts` captured, `git checkout HEAD --
  packages/daemon/src/pty/host.ts` (pre-fix), rebuilt, re-ran the test — scenarios 7 and 8's own target
  assertions failed RED for exactly the predicted reason (8 failures in scenario 7, 3 in scenario 8;
  scenarios 1–6 and 9 stayed green, confirming scenario 9 is a genuine "unchanged behaviour" control, not a
  new one). Restored via `git apply` of the saved diff, confirmed byte-identical
  (`git diff HEAD -- packages/daemon/src/pty/host.ts` matched the saved patch exactly), rebuilt, re-ran —
  all 71 assertions green again.
- Scenarios 1–6 (dc92f4b6/437daade's own existing positive/negative controls) re-ran unchanged and green
  both before and after this card's fix — no regression to the FULL-framing-only, already-resolved-ignoring
  behaviour those scenarios exercise.
- `log-message-content-gate.mjs`'s own exact-count census is unaffected — the new `bare=` field on the
  `[prompt-mismatch-pasted-content-wrap-replay]` diagnostic log is gen-numbers/lengths/booleans only, no
  new `redactedExcerpt(` call site.

### Code Review follow-up (reviewer 514cae2a, no Critical/Major findings) — three test-only additions

- Scenario 10 — a VARIANT of scenario 8 where the already-resolved candidate ("genB") is resolved via
  `mismatchResolvedGens` (a real lag-by-one plain replay) instead of `echoConfirmedGens`, so the
  `resolvedGens.has(entry.gen)` half of the core's predicate (host.ts ~661) is actually exercised, not only
  the `echoConfirmedGens.has(entry.gen)` half scenario 8 covers. RED→GREEN, by execution: mutated the
  predicate to `echoConfirmedGens.has(entry.gen)` only (dropping the `resolvedGens.has(entry.gen) ||`
  half), rebuilt, re-ran — exactly scenario 10's own three target assertions failed RED (scenario 8 and
  every other scenario stayed green, confirming the mutant's effect is precisely scoped to the half it
  removed); restored via `git checkout HEAD --`, confirmed no diff (byte-identical), rebuilt, re-ran — all
  94 assertions green again.
- Scenarios 11/12 — BARE twins of scenarios 4 and 6 (the unrelated-current-generation and decoupled-pairing
  counter-specimens), pinning this record's own Do-not #4: the BARE twin must apply the SAME tag-stripping
  and entry-pairing discipline as FULL, never a looser one. Both decline the BARE tagged detector and fall
  to 437daade's own pre-existing, tag-free `identicalContentPriorBare` ring scan instead
  (`arm=fallback-wrapped-replay-awaiting-resolution`), exactly mirroring 4/6's own FULL-framing behaviour.
- `worker-mismatch-pasted-content-wrap-replay-signal.mjs` gained a `bare:false` assertion on case (1)'s
  existing FULL-wrap row (both worker_list and worker_status) and a new case (1b) with a BARE-wrap fixture
  asserting `bare:true` on both tools' rows — `bare` is now pinned on the actual MCP response, not only via
  `host.getLastMismatchPastedContentWrapReplay`. The router-without-a-PtyHost byte-compat count (case 4)
  was bumped from 3 to 4 workers to account for the new fixture session.
- Both files re-ran green under both `env -u LOOM_DEV -u LOOM_SUPERVISED` and `LOOM_DEV=1`.
- `pnpm --filter @loom/daemon guards` — 30/30 green. `working-tree-eol-guard.mjs` passed (no new files this
  round — both edits used the `Edit` tool, which preserves existing line endings).

## Do not

- Do not reintroduce a hard skip-if-resolved filter (like 437daade's own
  `findMostRecentUnresolvedPriorEntryAcceptedByRecognizer`) in this detector — that regresses the
  all-candidates-already-resolved case (scenario 9): the current generation would lose its own free,
  silent confirmation and land in a louder/weaker arm for no reason.
- Do not drop the "prefer unresolved, fall back to resolved" scan order — a blind newest-first scan (the
  pre-1c7a5e12 shape) can shadow a genuinely-pending, older entry with an already-resolved, newer one
  sharing identical content, stranding the older entry's own real timer to fire a false alarm (scenario 8).
- Do not change dc92f4b6's "resolve both generations" marking — it is correct BECAUSE the tag ties the
  current generation's content identity to whichever entry is ultimately selected; there is no
  37acd59f/437daade-style two-lineage ambiguity to defer for the current generation here. Only the entry
  SELECTION step needed fixing, never the "mark both" rule itself.
- Do not let the BARE framing's own detection skip the tag-stripping check — `findRecognizedBarePastedContentWrapOfPriorWrite`
  shares the EXACT same core as the FULL twin (parameterized only by `wrapRe`); do not special-case BARE to
  compare against raw, un-stripped `currentIntendedText`.
- Do not word the `bare` field, or any description of this detector, as a lineage claim — CONTENT identity
  only, `dc92f4b6`'s own standing discipline, unchanged by this card.
- Do not treat `bare` as a different severity/recovery tier from the FULL match — the two are attribution
  only; a reader must not branch on `bare` to decide how seriously to treat a `confirmed-pasted-content-wrap-replay`
  arm.

## Source

Inline comments in `packages/daemon/src/pty/host.ts`: `findRecognizedPastedContentWrapOfPriorWriteCore`'s
own doc, `findRecognizedPastedContentWrapOfPriorWrite`'s and `findRecognizedBarePastedContentWrapOfPriorWrite`'s
own docs, the `pastedContentWrapOfPriorWriteFull`/`pastedContentWrapOfPriorWriteBare`/
`pastedContentWrapOfPriorWriteIsBare`/`pastedContentWrapOfPriorWrite` computation and the
`lastMismatchPastedContentWrapReplay` write inside `deliverHook`'s `UserPromptSubmit` case, and the
`Live.lastMismatchPastedContentWrapReplay` field's own doc. `mcp/orchestration.ts`'s `worker_list` tool
description for `lastMismatchPastedContentWrapReplay`. Tests:
`packages/daemon/test/pty-prompt-mismatch-pasted-content-wrap-replay.mjs` (scenarios 7/8/9, plus the Code
Review follow-up's scenarios 10/11/12), `packages/daemon/test/worker-mismatch-pasted-content-wrap-replay-signal.mjs`
(cases 1/1b).
