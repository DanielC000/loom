# 9f6598dd — the merge-kind verdict derivation closes the settled-merge gap Finding 1 measured

## Narrative

Card 9f6598dd: the `confirmWorkerMergeTracked` analogue of `deriveWorkerGateVerdict` — derives the durable `pending_gate_ops.verdict`/`verdict_payload_json` write from a settled `confirmWorkerMerge` outcome, closing the exact gap Finding 1 measured (`gate_status` on a settled MERGE op returning `{state:"settled",gateType:"merge",elapsedMs:null,idleMs:null}` — no `extended`, no duration, no outcome, because the merge-kind `onSettle` call site never passed a verdict at all before this).
- a thrown exception (`outcome.ok:false`) → `"error"`, `reason` only (nothing else is trustworthy — the throw could have struck at literally any point, see `ConfirmMergeResult`'s own doc).
- `outcome.value.merged` → `"pass"`, carrying `gateExtended` (renamed `extended` in the payload, same field every other kind uses) when a gate actually ran for this merge — `undefined` for a gateless project or a REUSED self-check, never a fabricated `false`.
- otherwise (a RESOLVED rejection — gate failure, merge conflict, stranded work, etc. — never a throw) → `"fail"`, the same `extended` field PLUS `gateDetail` when this rejection was gate-caused (every other rejection reason has none to report — `gateDetail` stays `undefined`, not fabricated).

`settledAt`/`totalDurationMs` are computed HERE, at the one point both the op's own `startedAt` (closed over as `opStartedAt`, see the call site) and "now" are both known — `totalDurationMs` is the REAL op wall time (worktree prep + union-merge + gate + squash), not `Σ(gateSteps)`'s floor (see the card's own "WHY settledAt SPECIFICALLY" doc). Set on every branch, including the thrown-exception one — a caller diagnosing an errored op still wants to know how long it ran before it errored.

## Do not

- Do not leave a merge-kind `onSettle` call site without a verdict write — before this card, `gate_status` on a settled merge op returned no `extended`, no duration, no outcome at all.
- Do not fabricate `gateExtended:false` for a gateless project or a reused self-check — leave it `undefined`.
- Do not skip `settledAt`/`totalDurationMs` on the thrown-exception branch — a caller diagnosing an errored op still wants to know how long it ran before it errored.
- Do not read `totalDurationMs` as `Σ(gateSteps)` — it is the REAL op wall time (worktree prep + union-merge + gate + squash), a larger figure.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (the merge-kind verdict-derivation closure): lines 726-769, as of commit `f9caa77e30d5c1a6dd994b6203261968c0dbf94f`. Relocated by card `8f4c8a8f`; no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
