# d1ac9fed — record-only mismatch notices, and the `fallback-unrecognized` rate escalation

## Narrative

Owner directive, 2026-09-23: a `[loom:prompt-mismatch]` session notice whose own wording says "no action
required"/"NOT A LOSS" still costs the recipient a turn and interrupts it — every classified mismatch arm
unconditionally minted a session-facing notice (`@decision 00b5066e`'s own rule: "neither direction
suppresses the notice, only its wording"). Measured since the `7c1487c8` classifier went live: 20 session
notices, 0 in a loss-possible arm.

`RECORD_ONLY_MISMATCH_ARMS` (`pty/host.ts`) is the fix's allow-list: for a mismatch classified into one of
these arms, Loom still records the detection (the unconditional `[prompt-mismatch-arm]` log line, and the
existing pull-surface writes — `lastMismatchUnmatched`/`lastMismatchReplay`/`lastMismatchFusion`, all
upstream of this gate) but sends NO session-facing turn and NO per-event parent push.

### The allow-list, and why each member/non-member is where it is

- **`confirmed-ansi-strip`** — the arm's own text: "What YOU can check yourself: nothing." A pure
  rendering artifact with no action to take. Uncontested record-only.
- **`fallback-benign-offset-insertion`** — "NOT A LOSS... note the extra content in your next report up
  in case it matters" is a soft, conditional aside, not a verification ask. Record-only.
- **`fallback-benign-offset-omission`** — no ask at all; the card's own motivating specimen. Record-only.
- **`fallback-unrecognized`** — "No action is required of you for this on its own." A genuine THIRD
  state (not confirmed benign — Loom could not confirm either way), so this arm is NOT blanket record-only
  — see "The FIVE-condition small-bucket split" below for the magnitude-based carve-out that actually
  governs it, and "Do not" for the two live tests (`cf2fef73`, `2b57b5a9`) that forced that narrowing.
- **`confirmed-wrapper-deficit` — DELIBERATELY EXCLUDED, a correction to the card's own step-1 list.**
  The card's fix list named this arm record-only, but that reading only examined its "NOT A LOSS" half.
  Its full text also asks: "if that earlier write's own turn already ran, this stale confirmation may be
  describing IT... check your own artifacts for whether you've now acted on the same underlying content
  twice." That is the SAME duplicate-check action `confirmed-fusion`/`confirmed-diverged-prior`/
  `confirmed-wrapper-aware-fusion` ask — all three of which the card explicitly left to "decide", and all
  three are kept loud. The card's own stated PRINCIPLE ("confirmed not-a-loss OR asks nothing") therefore
  excludes `confirmed-wrapper-deficit` too; the principle wins over a list built on a partial read of the
  arm's own text. Cost check: 0 of the 20 measured notices were in this arm, so excluding it from silencing
  costs nothing against the owner's measured complaint.
- **`confirmed-fusion` / `confirmed-diverged-prior` / `confirmed-wrapper-aware-fusion` — KEPT LOUD.** Each
  asks the recipient to check their own artifacts for a duplicate action. An action ask disqualifies an arm
  from this allow-list by construction.
- **`fallback-replay-awaiting-resolution` — MUST NEVER be added.** This is the loss-possible arm this
  whole alarm exists to protect: its own notice promises "wait one generation and re-check", and it alone
  arms the `checkPromptMismatchUnresolved` follow-up timer. That timer is a wholly separate, unconditional
  code path (armed at detection time, before and independent of this allow-list) — this allow-list has no
  power over it either way, but the arm itself must never be silenced at the session-notice layer either.

### The FIVE-condition small-bucket split for `fallback-unrecognized`

Two hand-run RED-PROOF sweeps against the full `cf2fef73`/`1a315058` safety-case family (9 specimens) plus
card `2b57b5a9`'s own scenario 16 found that a bound on `unaccountedIntended` ALONE (see
`computeUnaccountedIntended`'s own doc — common-prefix + common-suffix subtracted from `intended.length`)
was not sufficient: scenario 16 (a confirmed real 1-char loss from the chunk-seam FF race,
`lenDelta=0`) measures `unaccountedIntended=1`, comfortably under the 64-char bound, yet is a genuine,
mechanism-understood loss that must stay loud. A subsequent Code Review pass (2026-09-23, on commit
`f57a1d48`) found this THREE-condition cut still let through a second real gap:
`pty-composer-accumulation-diverged-prior.mjs` scenario 4 (a stale placeholder + an EARLIER generation's
own FULL recognized write + this generation's own text, sandwiched) has `unaccountedIntended=0` (every
byte of THIS generation's own intended text is recovered whole at the tail) but a REPORTED-side excess of
~4.8K unrecognized chars that includes another generation's own content whole — a genuine duplicate-action
risk, the exact ask kept loud for the `confirmed-fusion`-family arms. `unaccountedIntended` alone only
bounds the INTENDED side; it says nothing about what ELSE showed up in `reported`. `fallback-unrecognized`
therefore requires ALL FIVE of:

1. `unaccountedIntended <= UNRECOGNIZED_UNACCOUNTED_MAX_CHARS` (64, a first sizing).
2. `lenDelta >= 1` (reported strictly LONGER than intended). Grounding: every one of the card's own 20
   measured specimens was POSITIVE (+57×13, +60×2, +59×2, +18×2) — zero were <=0. A zero-or-negative delta
   inside this arm is exactly the substitution/loss shape instead (scenario 16: `lenDelta=0`).
3. No C0 control char other than TAB/LF/CR/DEL anywhere in the REPORTED-side divergent region
   (`UNRECOGNIZED_DISQUALIFYING_CONTROL_CHAR_RE`). Grounding: card `2b57b5a9`'s chunk-seam race inserts a
   stray FF into the diverging bytes and is PROVEN to drop real chars — its own signature must never read
   as benign-small, independent of magnitude.
4. `lenDelta <= UNRECOGNIZED_EXTRA_MAX_CHARS` (96, a first sizing grounded in the card's own max measured
   owner specimen, +60, plus headroom). Caps the REPORTED-side excess from above — closes the diverged-prior
   gap above; a specimen embedding another generation's whole content has a large `lenDelta` even when
   `unaccountedIntended=0`.
5. `!unmatchedRecognized` — `findRecognizedSubstring` (the same mechanism `[prompt-mismatch-unmatched-
   remainder]` reports on) must not have found ANOTHER generation's own recorded write inside `reported`.
   This is the more PRECISE guard for the same diverged-prior gap: a specimen can be shortened (small
   `lenDelta`) while still embedding recognized prior content — test scenario `31` (`SandwichedRecognizedSmall`)
   deliberately keeps `lenDelta` under 96 to isolate this condition as the ONLY thing keeping it loud,
   proving 4 and 5 are independently load-bearing, not redundant.

Any ONE condition failing routes to the PRE-CARD behaviour, completely unchanged: the session notice fires
via the untouched `mismatchText`, AND the original per-event `onPromptMismatchUnmatched` push fires with
its original wording (`escalation:"single-event"`). All five verified holding for all 9 safety-case
specimens plus scenario 16 and the diverged-prior scenario 4 (RED-PROVEN: conditions 3 alone — scenario 29
— and, jointly, 2+3 — scenario 16/24/29; condition 5 alone — scenario 4 via `pty-composer-accumulation-
diverged-prior.mjs`, and scenario 31 in this file; condition 4 alone — scenario 32, a large-`lenDelta`,
no-recognition specimen).

**Card `1a315058`'s own `PartialSubstringRecognized` specimen (test file scenario 13, `reported = intended`
verbatim + an unexplained trailing suffix)** measures `unaccountedIntended=0` — every byte of `intended`
recovered whole as a literal prefix — the structural MIRROR of `fallback-benign-offset-insertion` (extra
content prepended instead of appended). RE-VERIFIED under the five-condition split: `lenDelta=78` (under the
96 cap — condition 4 holds), and the trailing suffix matches no prior write (`unmatchedRecognized` stays
null — condition 5 holds, since gen=1 has no earlier generation to recognize). All five conditions hold, so
it stays record-only + rate-tracked, UNCHANGED from the original three-condition cut. Card `68459420` DoD-3's
own "possible LOSS" wording concern for this population is DELIVERY-SUPERSEDED: that wording concern was
already resolved by `1a315058`'s UNRECOGNIZED third-state framing, before this card: what a
zero-`unaccountedIntended` specimen leaves is only a possible DUPLICATE (the unattributed trailing content),
which the rate escalation exists to catch a BURST of, not a single occurrence.

**Incidental, not by design:** the 4 `cf2fef73`-family wrap specimens (`6g`/`6h`/`6k`/`6o`) all measure
`unaccountedIntended` equal to roughly the WHOLE of `intended` (not just the genuinely-lost portion) — the
raw prefix/suffix scan has no awareness of `<pasted_content id="...">` wrap framing, so a wrapped payload's
framing bytes alone already break the prefix/suffix match at position 0, before the scan ever reaches the
payload's real content. This happens to err in the SAFE direction (overestimates loss, stays loud) for
every wrap specimen measured so far, but it is NOT a designed guarantee — a future change making the scan
wrap-aware (to fix the overestimate) MUST re-verify all four of these specimens still classify loud before
shipping, not assume this note's "incidental loud" holds automatically.

**Dead branches, deliberately left in place:** `mismatchText`'s own `isOffsetInsertion`/`isOffsetOmission`-
worded sub-branches (the "NOT A LOSS..." text for those two arms) are now genuinely UNREACHABLE — nothing
ever reads that computed string for a record-only arm. Per the owner: leave them in place, don't delete in
this card; a follow-up cleanup card is expected. `packages/daemon/test/pty-prompt-mismatch.mjs` scenarios
22/23 (the arms' own DoD-6/DoD-7 tests) were re-pointed at the still-live UNCONDITIONAL `[prompt-mismatch]`
diagnostic line (computed upstream of classification) for their position-field assertions, and their
wording assertions were dropped rather than left false-green against dead code.

### Code Review fixes (2026-09-23, commit `f57a1d48` → this commit)

- **`disposition` replaces the misleading `delivered=` field.** The `[prompt-mismatch-arm]` log line used
  to log `delivered=!isExactRepeatNotice` unconditionally — TRUE for a record-only arm too, even though no
  session turn ever fires. This is the field the card's own 3-5-day re-measure reads. `disposition` (one
  of `delivered` / `recorded-only` / `exact-repeat-suppressed`) is the new, unambiguous field; `delivered`
  is KEPT (grepped the repo for other consumers — none found outside this file's own tests) but now means
  what it says.
- **The terminal `mismatchArm` branch is now EXPLICIT**, ending in `"unclassified"` rather than an assumed
  `"fallback-benign-offset-omission"`. `"unclassified"` is NEVER in `RECORD_ONLY_MISMATCH_ARMS` (now
  exported for testability) and never satisfies `isSmallUnrecognized` (both gate on specific named arm
  strings), so a future invariant break here fails LOUD by construction, not silent. Test scenario `33`
  asserts this safety property directly on the exported allow-list (the branch itself is unreachable by
  real input — the guard conditions are exhaustive by construction, proven by hand before this card).
- **Empty-`reported` carve-out.** `intended.startsWith("")` is trivially true for ANY `intended`, so a
  totally-empty `reported` (nothing arrived at all) for an `intended` up to `OFFSET_OMISSION_MAX_TAIL_CHARS`
  (2) chars long classifies `fallback-benign-offset-omission` — but a total loss of a real 1-2 char message
  must never go quiet just because the bound happens to be met that way. `isEmptyReportedOffsetOmission`
  excludes this one case from the allow-list; `isSmallUnrecognized` separately requires `reported.length >
  0` (defense in depth — already implied by condition 2 above, since `lenDelta >= 1` forces `reported.length
  > intended.length >= 1`, but stated explicitly per the reviewer's own request). Test scenario `34`.
- **Parentless sessions and the rate escalation.** A manager/Lead/plain top-level session has no
  `parentSessionId` — `SessionService.handlePromptMismatchUnmatched` already silently returns for ANY
  escalation in that case (intended: the owner's original complaint was specifically about a MANAGER
  getting one of these notices, and a parentless session has nobody upstream to notify anyway). Since this
  card, the rate-exceeded case logs a distinct line (`[prompt-mismatch-rate-exceeded-no-parent]`,
  `sessions/service.ts`) before returning, so this isn't silently indistinguishable from the single-event
  path simply never firing. Consequence: a parentless session's own sustained `fallback-unrecognized` rate
  is visible ONLY via this log line and the pull surface (`getLastMismatchUnmatched`) — nothing pushes
  proactively to anyone for it, by design.

### The `fallback-unrecognized` rate escalation

Per-event silence for a SMALL `fallback-unrecognized` (passing all three conditions above) is paired with a
session-scoped rate watch (`Live.unrecognizedMismatchTimestamps`/`unrecognizedMismatchCooldownUntil`):
`>= 3` such detections within a rolling 30-minute window triggers ONE escalation push (reusing the existing
`PtyHostEvents.onPromptMismatchUnmatched` → `SessionService.handlePromptMismatchUnmatched` wiring,
`escalation:"rate-exceeded"` — see that method's own doc for its TWO distinct uses), then a 30-minute
cooldown during which no further push fires for that session even if the rate keeps climbing. Session-
scoped, not host-scoped, because the push routes to that session's own parent — a host-wide counter would
have no single recipient to name. These numbers are a first sizing (owner's own call, not derived from the
20-specimen population, which had no genuine rate cluster to size from) — re-measure under card `d1ac9fed`'s
own 3-5-day log DoD before treating them as settled.

Consequence: `onPromptMismatchUnmatched`/`handlePromptMismatchUnmatched` now has TWO distinct callers/
wordings, discriminated by `info.escalation` — `"single-event"` (a `fallback-unrecognized` ABOVE the
magnitude bound, the pre-card behaviour unchanged) and `"rate-exceeded"` (a SMALL `fallback-unrecognized`
that crossed the rate threshold, new). `fallback-benign-offset-insertion`/`fallback-benign-offset-omission`
never reach this hook at all now (unconditionally record-only, no bound-based carve-out for them — only
`fallback-unrecognized` has one). The confirmed-* arms never pushed per-event even before this card (the
push only ever fired inside `if (isUnmatchableMismatch)`, which is false whenever any confirmed-* arm
matched). The wiring is kept (not deleted) and repurposed, never left as dead code.

### Real-specimen check (card DoD item 2)

Two real, hash-confirmed `+18`-delta `fallback-unrecognized` specimens were recovered from production
`daemon-output.log` and their engine transcripts (method: `[prompt-mismatch-arm]` log line → `[hook]
SessionStart session_id=...` → engine session id → `~/.claude/projects/.../<engine-session>.jsonl` →
`user`-role `message.content` → `fnv1a32` match against the logged `reportedHash`). Both REPORTED texts
were recovered and byte-exact hash-confirmed (72776 chars matching `reportedHash=3565e7ef`; 20555 chars
matching `reportedHash=ca4019ef`). Neither specimen's INTENDED text (72758 / 20537 chars, `writtenHash=
2e82b60b` / `a518a031`) was recoverable — no `user`-role transcript entry of that exact length exists in
either transcript, consistent with the intended content never having been echoed back as its own entry
(the defining property of a mismatch). `unaccountedIntended` could therefore NOT be computed for a real
specimen — only for the synthesized fixtures in the test suite, which reproduce the same measured
`lenDelta` (+18, +57, +59, +60) at `divergesAtChar=0` shape the daemon log's own population shows.

## Do not

- Do not add `fallback-replay-awaiting-resolution` to `RECORD_ONLY_MISMATCH_ARMS` — it is the loss-possible
  arm this alarm exists to keep loud; the allow-list is a positive list precisely so a mistake here defaults
  new/unlisted arms to LOUD, not silent, but an explicit wrong addition is not protected by that default.
- Do not add `confirmed-wrapper-deficit`/`confirmed-fusion`/`confirmed-diverged-prior`/
  `confirmed-wrapper-aware-fusion` to the allow-list — each asks a real duplicate-check action; see the
  correction above for why the card's own original list was wrong about the first of these four.
- Do not raise `UNRECOGNIZED_MISMATCH_RATE_THRESHOLD`/shrink the window/cooldown casually — these are a
  first sizing pending the card's own re-measure; treat a change here as needing the same measured
  justification `00b5066e`'s own bounds cite, not a round-number guess.
- Do not delete `onPromptMismatchUnmatched`/`handlePromptMismatchUnmatched` on the theory that per-event
  callers are gone — it is the live delivery path for the rate escalation above, just no longer called
  per-event.
- Do not remove condition 4 (`lenDelta <= UNRECOGNIZED_EXTRA_MAX_CHARS`) or condition 5
  (`!unmatchedRecognized`) from `isSmallUnrecognized`, and do not assume either alone is sufficient — test
  scenarios 31/32 prove them independently load-bearing (a small-`lenDelta` recognized specimen needs 5; a
  large-`lenDelta` unrecognized specimen needs 4).
- Do not read `delivered=true` in the `[prompt-mismatch-arm]` log line as "a session turn fired" without
  checking `disposition` first if parsing programmatically — `delivered` is now truthful, but a reader
  built against the OLD (always-true-unless-exact-repeat) semantics should switch to `disposition`.
- Do not let a future rewrite of `mismatchArm`'s classification collapse the explicit
  `(isOffsetOmission && !unmatchedRecognized)`/`"unclassified"` structure back into an implicit
  `else`-assumes-omission shape — that reopens the exact silent-misclassification risk this fix closes.

## Source

`packages/daemon/src/pty/host.ts` (`RECORD_ONLY_MISMATCH_ARMS` — exported — the rate constants,
`UNRECOGNIZED_EXTRA_MAX_CHARS`, and the classification site's dispatch in `deliverHook`'s `UserPromptSubmit`
case) and `packages/daemon/src/sessions/service.ts` (`handlePromptMismatchUnmatched`, including the
parentless-rate-exceeded log line). See also `docs/decisions/00b5066e-offset-aware-reconciliation-check.md`
§2 for what this card supersedes in that record's own original rationale.
