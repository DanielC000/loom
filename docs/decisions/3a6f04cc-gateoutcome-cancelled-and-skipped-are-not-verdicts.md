# 3a6f04cc — `GateOutcome`'s `"cancelled"` and `"skipped"` are distinct non-verdicts, never `"reject"`/`"pass"`

## Narrative

Card 3a6f04cc: `"cancelled"` is a DISTINCT terminal state, not a `"reject"` — a cancelled run reached no verdict at all (withdrawn via `gate_cancel`, or auto-superseded), so it must never be counted as a failure when computing a pass/fail or rejection RATE from a series of `GateHistoryRow`s. Before this card, a cancelled `"worker"` row (the ONLY gate type whose cancel event shares the SAME `worker_gate` kind `Db.listGateEvents` reads — a cancelled MERGE gate emitted a separate `merge_cancelled` kind that `GATE_HISTORY_KINDS` excludes entirely, so it never reached this enum at all) fell through `gateOutcomeFromDetail`'s fallback and read as `"reject"`, silently inflating any rejection rate computed from this field.

CORRECTED (card 318ac7b2): a cancelled MERGE gate can now ALSO reach this enum, in one specific shape — the single-file retry's own admission cancelled while queued, AFTER attempt 1 already genuinely ran and failed (see `GateHistoryRow.retriedFile`'s own doc). That row is stamped `cancelled:true` on the SAME `build_gate` kind (not a second `merge_cancelled`-kind row — `GATE_HISTORY_KINDS` still excludes that kind entirely), so it reads `"cancelled"` here too, recording attempt 1's real run instead of losing it. See docs/decisions/318ac7b2-single-file-retry-cancel-while-queued-attempt1-not-lost.md for the caveat this correction rests on.

CORRECTED (card 518e7ff6): the SIBLING transient-kill-retry cancel-while-queued shape is now ALSO handled, but differently — its own attempt-1 `build_gate` row was already written (unconditionally, before that retry ever starts) and stays a real, unmodified `"reject"`; a SEPARATE `build_gate_retry` row is emitted alongside it, stamped `cancelled:true`, recording that the retry itself never reached a verdict. A rejection-rate consumer must read the PAIRING — a `"reject"` row immediately followed (same `opId`) by a `"cancelled"` `build_gate_retry` row — as one unresolved op, not a rejection. See docs/decisions/518e7ff6-transient-kill-retry-cancel-while-queued-uses-its-own-row.md.

Card db9b0130: `"skipped"` is likewise a DISTINCT non-verdict, not a `"pass"` — a merge whose diff was proven inert (see `isInertMergeDiff`) never spawned a gate process at all, so recording it as a pass would reintroduce the exact defect `gateRan` was added to fix, via a new door: a rate computed from `outcome === "pass"` alone would silently count a non-run as a measurement. Always paired with `gateRan:false` on the same row.

### `GateHistoryRow.passed` carries the identical trap under a different name

`passed` (card 753d9911, a plain `outcome === "pass"` boolean sibling added so agent-facing consumers don't have to derive pass/fail from the outcome enum themselves) is `false` for BOTH a genuine `"reject"` row and a `"cancelled"`/`"skipped"` row — but `passed:false` means something different on each: a cancelled run reached no verdict at all (withdrawn, not failed), and a skipped row's underlying event actually stamps `detail.passed:true` internally (so the merge could proceed to squash) even though this derived field still reads `false` for it. A caller computing a rejection RATE must filter on `outcome === "reject"`, never on `passed === false` alone, or a cancellation/skip is silently counted as a failure — the same rule as the `outcome` field itself, restated because `passed`'s own boolean shape invites exactly this shortcut. `passed`'s shape is deliberately left unchanged (still just `outcome === "pass"`) rather than widened to a tri-state; `outcome` is where the real granularity lives.

## Do not

- Do not count `outcome === "cancelled"` as a failure/rejection when computing a pass/fail or rejection rate — a cancelled run reached no verdict at all.
- Do not count `outcome === "skipped"` as a pass — an inert-diff merge that never spawned a gate process; always paired with `gateRan:false`.
- Do not read a single-file-retry cancel-while-queued row's `cancelled:true` as losing attempt 1's real failure — it's recorded on the sibling `build_gate` event.
- Do not read a transient-kill-retry `"reject"` row in isolation — a rejection-rate consumer must pair it (same `opId`) with any immediately-following `cancelled` `build_gate_retry` row and treat the pair as one unresolved op, not a rejection.
- Do not compute a rejection rate off `GateHistoryRow.passed === false` alone — it is `false` for a cancelled/skipped row too; filter on `outcome === "reject"` instead.

## Source

Inline comment in `packages/shared/src/types.ts` (`GateOutcome`'s type doc). Relocated by card 35d90c4e (tranche 1 on `packages/shared/src/types.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.

The "`GateHistoryRow.passed`" section above was appended by tranche 3 on `packages/shared/src/types.ts` (card 555f817f), extracted from `GateHistoryRow.passed`'s own doc comment — same decision, a second field it governs, folded into this existing file per the one-record-per-id rule rather than a new one.
