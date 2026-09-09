# 361520a0 — `ConfirmMergeResult.cancelled` is a "no verdict" outcome, never read as a rejection

## Narrative

### Half One — `POST /api/sessions/:id/merge` routed through the tracked path

Human-initiated merge of a worker's branch (the Review panel / #18c) runs the daemon's fail-closed build gate then squash-merges (one clean commit); manager is derived from the worker's parent so the existing ownership check holds. Returns `{ merged }` or `{ merged:false, reason }`, or — on the still-running ceiling path — `{ merged:null, pending:true, opId, reason }`.

This route used to call the raw, untracked `confirmWorkerMerge` directly — no `PendingOpRegistry` dedupe, no durable `pending_gate_ops` tombstone — so an owner clicking Merge here while a manager's own `worker_merge_confirm` was already running on the SAME worker minted a genuine second gate run instead of attaching to the first (the incident this card fixes). `confirmWorkerMergeUntilSettled` shares the same `merge:${id}` dedupe key the MCP tool uses AND preserves this route's long-standing "block until the real outcome is known" contract. A `{settled:false}` result means the ceiling was hit while the gate is STILL genuinely running.

`merged:null`, NOT `merged:false` (Code Review, Half Four): a still-running gate used to report `merged:false` here — the ONLY field either web consumer (`reviewQueue.tsx`'s card, `ReviewPanel.tsx`) actually branches on — so a human polling mid-gate saw "rejected — gate/merge still running…" rendered in the SAME red "rejected" styling a genuine refusal gets. The natural response to a red "rejected" is to click Merge again — exactly the re-click this card's dedupe exists to prevent, and against a since-dead manager that re-click is the fleet-wide merge-lane DoS Half Four fixes. `null` is a real third state a strict `r.merged ? … : …` ternary can't collapse into "rejected" by accident — both consumers check `pending`/`merged === null` FIRST.

### Half Two — `ConfirmMergeResult.cancelled`

A distinct "no verdict" outcome — mirrors `WorkerGateResult.cancelled`. `merged` is always `false` alongside this, but this must NEVER be read as a rejection: THIS specific cancelled admission never ran (`gate_cancel` withdrew it while it was still QUEUED, before admission — see `GateSemaphore.cancelQueued`'s doc), so there is nothing to diagnose and nothing to hold against the branch for THAT admission. `cancelKind` distinguishes an automatic supersede from a manager's explicit `gate_cancel`; see `GateCancelKind`'s own doc. Only reachable while QUEUED — a RUNNING merge gate still refuses cancellation entirely (see `cancelGateOp`'s own doc for why those two phases deliberately differ).

## Do not

- Do not call `confirmWorkerMerge` directly from `POST /api/sessions/:id/merge` — always go through `confirmWorkerMergeUntilSettled` (the `merge:${id}`-deduped tracked path), or an owner click can race a manager's own in-flight `worker_merge_confirm` into a second gate run on the same worker.
- Do not report a still-running gate as `merged:false` on this route — that field is the only one either web consumer branches on, and it renders identically to a genuine rejection, inviting a re-click that defeats the dedupe. Use `merged:null` with `pending:true`.
- Do not read `cancelled:true` as a rejection or hold it against the branch — the cancelled admission never ran at all; there is nothing to diagnose for that specific admission.
- Do not allow cancellation of a RUNNING merge gate — only a QUEUED one can be cancelled; `cancelGateOp` refuses a running one entirely.
- Do not map `outcome.value.cancelled` (Half Two) to `"fail"` in the merge-verdict derivation — it must map to `"cancelled"`, checked BEFORE `merged`, mirroring `deriveWorkerGateVerdict`'s own cancelled branch.
- Do not leave `gateDetail` (Half Three) missing `stderrTail`/`steps` on the merge-verdict `"fail"` mapping — `GateRejectionDetail` always carries both; omitting them here left the pull-based `gate_history`/`gate_status` read path with strictly LESS diagnostic richness than the push `[loom:merge-rejected]` nudge for the identical rejection.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`ConfirmMergeResult.cancelled`, lines 545-560; the merge-verdict derivation's cancelled/gateDetail handling, lines 726-769): as of commit `f9caa77e30d5c1a6dd994b6203261968c0dbf94f`. Relocated by card `8f4c8a8f`; no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.

Half One additionally sourced from an inline comment in `packages/daemon/src/gateway/server.ts` (`POST /api/sessions/:id/merge`, lines 5377-5397 as of commit `a9b55042`). Relocated by card `c57868e5`; wording condensed, no substantive detail dropped.
