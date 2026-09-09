# 361520a0 — `ConfirmMergeResult.cancelled` is a "no verdict" outcome, never read as a rejection

## Narrative

Card 361520a0, Half Two: a distinct "no verdict" outcome — mirrors `WorkerGateResult.cancelled`. `merged` is always `false` alongside this, but this must NEVER be read as a rejection: THIS specific cancelled admission never ran (`gate_cancel` withdrew it while it was still QUEUED, before admission — see `GateSemaphore.cancelQueued`'s doc), so there is nothing to diagnose and nothing to hold against the branch for THAT admission. `cancelKind` distinguishes an automatic supersede from a manager's explicit `gate_cancel`; see `GateCancelKind`'s own doc. Only reachable while QUEUED — a RUNNING merge gate still refuses cancellation entirely (see `cancelGateOp`'s own doc for why those two phases deliberately differ).

## Do not

- Do not read `cancelled:true` as a rejection or hold it against the branch — the cancelled admission never ran at all; there is nothing to diagnose for that specific admission.
- Do not allow cancellation of a RUNNING merge gate — only a QUEUED one can be cancelled; `cancelGateOp` refuses a running one entirely.
- Do not map `outcome.value.cancelled` (Half Two) to `"fail"` in the merge-verdict derivation — it must map to `"cancelled"`, checked BEFORE `merged`, mirroring `deriveWorkerGateVerdict`'s own cancelled branch.
- Do not leave `gateDetail` (Half Three) missing `stderrTail`/`steps` on the merge-verdict `"fail"` mapping — `GateRejectionDetail` always carries both; omitting them here left the pull-based `gate_history`/`gate_status` read path with strictly LESS diagnostic richness than the push `[loom:merge-rejected]` nudge for the identical rejection.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`ConfirmMergeResult.cancelled`, lines 545-560; the merge-verdict derivation's cancelled/gateDetail handling, lines 726-769): as of commit `f9caa77e30d5c1a6dd994b6203261968c0dbf94f`. Relocated by card `8f4c8a8f`; no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
