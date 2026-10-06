# 79999395 — decline-reason diagnostics for the wrap-excess near-miss, and a worker_status/worker_list field for `confirmed-pasted-content-wrap-replay`

## Narrative

Card 79999395 checked dc92f4b6's own attribution of its fourth specimen (session d0c329c1, 2026-10-03,
`lenDelta=+60`) to card `ff871b77`'s known 1-2-char wrap-excess shape (`detectPastedContentWrapSmallExcess`)
against the actual log, and against two further live specimens of the same magnitude (the Loom lead's own
session, 2026-10-06, gen=8 `+61` and gen=13 `+60`). The attribution did not hold: the detector's own
positive-match tag, `[prompt-mismatch-pasted-content-wrap-near-miss-excess]`, had ZERO occurrences for all
three specimens across every retained log file, while its sibling near-miss diagnostics (deficit,
divergence) fired correctly elsewhere in the same window — a positive control proving the logging path
itself is live, not dead. All three specimens pushed the manager-facing `[loom:prompt-mismatch-unmatched]`
"possible LOSS" notice (confirmed via `[prompt-mismatch-unmatched-pushed]`), classified
`arm=fallback-unrecognized`; the `d1ac9fed` small-bucket record-only path never engaged either
(`unaccountedIntended` reads the FULL `intendedLen` for all three, since it is computed from the raw
`reported`/`intended` common prefix+suffix, which a wrap-shaped divergence — diverging at char 0 — always
defeats, regardless of `lenDelta`'s own magnitude).

Owner/manager decision (2026-10-06): do not enable `LOOM_LOG_MESSAGE_CONTENT` to investigate (a host-wide,
owner-controlled privacy switch an agent must not flip). Instead, make the decline itself self-explaining —
log WHY `detectPastedContentWrapSmallExcess` returns no match, as a reason code + lengths only, never
content — so the NEXT occurrence of this shape explains itself without needing raw content.

## The fix

`detectPastedContentWrapSmallExcess` (host.ts) now returns `{excessIndex, excessChars}` on a match, or
`{decline: PastedContentWrapSmallExcessDecline}` on a non-match, naming exactly one of three reasons:
- `regex-no-match` — `PASTED_CONTENT_WRAP_RE` never matched `reported` at all (no id-backreferenced wrap
  framing present in the expected anchored shape).
- `excess-len-out-of-range` — the wrap matched, but `inner.length - intended.length` is not 1 or 2 (carries
  `wrapIdLen`/`innerLen`/`excessLen`, the latter signed so a negative/zero/large value is visible).
- `non-contiguous-placement` — the wrap matched and `excessLen` is 1 or 2, but no single contiguous
  insertion at one point explains the whole divergence (carries `wrapIdLen`/`innerLen`/`excessLen` plus a
  NEW, separately-computed `commonPrefixLen`/`commonSuffixLen` — a backward scan from the end, independent
  of the existing forward-only check, added purely for this diagnostic's own value: it shows how far the
  wrap's own inner content reconciles from EITHER end even when no single excessLen-sized insertion
  explains the rest, e.g. two separate single-char insertions, or an insertion plus a substitution).

The call site (inside `UserPromptSubmit`'s mismatch block) logs a NEW
`[prompt-mismatch-pasted-content-wrap-excess-declined]` line whenever this happens, unconditionally (same
posture as every sibling near-miss diagnostic in this file) — reason + lengths only, no content, no new
`redactedExcerpt(` call site. Because the detector itself is invoked on EVERY non-`isPastedContentWrap`
mismatch (not gated on any further shape heuristic — mirroring how the POSITIVE near-miss tag already runs
unconditionally too), this decline log now fires for every ordinary, unrelated mismatch as well — a
meaningful increase in log line volume versus before this card, accepted deliberately rather than trying to
pre-filter to "looks wrap-shaped" cases, which would risk silently hiding the exact next occurrence this
card exists to explain.

Separately, `confirmed-pasted-content-wrap-replay` (card dc92f4b6) wrote `live.mismatchResolvedGens` only
and had no worker_status/worker_list pull surface — a manager could not see it without reading
`daemon-output.log` directly. New field `Live.lastMismatchPastedContentWrapReplay` (+
`getLastMismatchPastedContentWrapReplay`), set at the same point `mismatchResolvedGens` is marked, mirrors
`lastMismatchFusion`'s own shape/contract: `{gen, recognizedGen, reportedLen, intendedLen, detectedAt}`,
STICKY, overwritten (not accumulated) by a later occurrence, NOT a loss — content identity against
`recognizedGen` only, never lineage. Surfaced on `worker_list`/`worker_status` (both the live-pty read and
every placeholder row, mirroring `lastMismatchFusion`'s own 6 call sites exactly) and documented inline in
both tools' descriptions. Deliberately NOT added to the generic derived `lastMismatch` view (that view's own
card, 68459420/31f3d047, covers replay/fusion/unmatched only — widening it was out of this card's scope) and
NOT added to `e1ac691b`'s four worker_merge_confirm candidates (a separate mechanism this card did not
touch).

## Do not

- Do not fold the decline-reason log into a content-bearing diagnostic — it is reason code + lengths only;
  adding a `redactedExcerpt(`-wrapped field here would need `log-message-content-gate.mjs`'s own exact-count
  census updated for a new site, and there is no reason to: nothing content-bearing is captured here at all.
- Do not read a non-null `lastMismatchPastedContentWrapReplay` as an established loss, or as proof `gen` was
  literally minted as `recognizedGen`'s own re-send — it proves CONTENT identity only (dc92f4b6's own
  posture, carried over verbatim).
- Do not add `lastMismatchPastedContentWrapReplay` to the generic `lastMismatch` derived view, or to
  `e1ac691b`'s four worker_merge_confirm candidates, without a deliberate follow-up card — both are
  separate, already-scoped mechanisms this card intentionally left untouched.
- Do not pre-filter the decline-reason log to "only when the shape looks wrap-like" — the whole point is
  that the shape of these 3 specimens was NOT determinable in advance; a pre-filter risks suppressing the
  exact future occurrence this diagnostic exists to explain. The resulting volume increase (one new log
  line per ordinary non-wrap mismatch) is accepted, not an oversight.
- Do not treat this card as having determined what the ff871b77/dc92f4b6-attributed specimens actually
  are — it did not; it only proved the existing detector does not recognize them as that shape, and gave the
  next occurrence a way to self-explain. ff871b77's "name it, don't fix it" posture is UNCHANGED for the
  population it actually covers (1-2 char contiguous wrap-excess, confirmed by the positive tag).

## Source

Inline comments in `packages/daemon/src/pty/host.ts`: `PastedContentWrapSmallExcessDecline`'s own doc,
`detectPastedContentWrapSmallExcess`'s own doc, the call site inside `UserPromptSubmit`'s mismatch block,
`Live.lastMismatchPastedContentWrapReplay`'s own doc, and `getLastMismatchPastedContentWrapReplay`'s own
doc. `lastMismatchPastedContentWrapReplay` call sites in `packages/daemon/src/mcp/orchestration.ts`
(`fleetView`'s real-worker row + 4 placeholder rows, `worker_status`'s single-record body, and both tools'
description strings).
