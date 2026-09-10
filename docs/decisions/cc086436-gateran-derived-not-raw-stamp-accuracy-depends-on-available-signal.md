# cc086436 — `GateHistoryRow.gateRan` is DERIVED, not a raw stamp everywhere

## Narrative

`gateRan` (introduced alongside card 3a6f04cc's cancelled/skipped non-verdict rule — see docs/decisions/3a6f04cc-gateoutcome-cancelled-and-skipped-are-not-verdicts.md) answers whether a gate PROCESS actually spawned for this op: `false` for a merge that REUSED an already-green worker self-check (no process spawned at merge time), a worker self-check cancelled BEFORE it was ever admitted past the queue (also no process spawned), or (card db9b0130) a merge whose ENTIRE changed-path set was proven inert (`outcome:"skipped"`) — same "no process spawned" fact as the reuse case, for a different reason: nothing to reuse, the gate was never even attempted. `true` for every other row, INCLUDING one cancelled WHILE running that DID spawn a step (real wall time consumed, even though no verdict was reached). It exists so a duration series built from this table can exclude non-runs without a per-row pivot to `gate_status(opId)` — a reused/never-spawned row's `durationMs` reflects bookkeeping overhead, not real gate work, and biases a naive average toward "getting faster" if left in.

A same-day Code Review correction (commit `cc086436`) narrowed the accuracy claim: this field is DERIVED, not a raw stamp everywhere, and its exactness depends on WHICH signal was available when the row was written. It is EXACT for `reused:true` rows and for any row carrying an explicit `gateSpawned` producer stamp (both worker-gate cancel sites — queued and running — stamp this explicitly as of the Code Review follow-up). For an OLDER cancelled row with no such stamp (written in the narrow window between this card's original fix and that follow-up), it falls back to "did this admit before it was cancelled" (`durationMs` presence) — admission is NOT the same fact as a process having spawned (a cancel landing between admission and the gate runner's own first-step check settles with zero steps run despite a real `durationMs`), so that fallback can read `true` for a row where nothing actually ran. Defaults `true` when no positive non-run signal exists at all (a real pass/fail/timeout/kill/error, or a deploy) — never `null`, but "never null" is not the same claim as "always exact"; treat it as reliable, not guaranteed, for the fallback case above.

Source: commit `cc086436`, no board card — this correction was folded into the same same-day commit that introduced the field, and carries no 8-hex card id anywhere (checked the commit message and the introducing diff).

## Do not

- Do not treat `gateRan` as an always-exact raw stamp — for an older cancelled row with no explicit `gateSpawned` stamp, it falls back to a `durationMs`-presence heuristic that can read `true` for a row where nothing actually spawned.
- Do not exclude a row from a duration series without checking `gateRan` first — a reused/never-spawned row's `durationMs` reflects bookkeeping overhead, not real gate work.

## Source

Inline comment in `packages/shared/src/types.ts` (`GateHistoryRow.gateRan`'s own doc comment). Extracted by card 555f817f (tranche 3 on `packages/shared/src/types.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped. Sha-keyed per the `sha:` grammar (card 969b0e1c) — no board card id appears anywhere in this block or its introducing commit `cc0864360263e2edbfd88eacff5e04b152a335be`.
