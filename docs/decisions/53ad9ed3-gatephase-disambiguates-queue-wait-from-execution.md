# 53ad9ed3 — `pendingMerge.gatePhase` disambiguates queue-wait from execution in `state:"running"`

## Narrative

`GET /api/sessions` enriches each row with its in-flight (or just-settled) merge-gate op (`pendingMerge`), read straight from the in-memory `PendingOpRegistry` via the SAME read-only peek `worker_list` uses (never consumes; non-null while the gate is genuinely running, and briefly after it settles via the registry's RETAINED terminal view). Not a DB column — it lives in the registry, so it's folded on here rather than in `listAllSessions`. Subset to the shared `PendingMerge` shape `{opId, state, startedAt, outcome, gatePhase}`, null on every non-merging session. `outcome` is carried straight through — undefined while running, "merged"/"rejected"/"failed" once settled (see `confirmWorkerMergeTracked`'s `classifyOutcome`) — so the Board can distinguish a rejected merge from a successful one instead of both reading as `state:"done"`.

`gatePhase` (card `53ad9ed3`, closing the divergence card `008f33f1` deliberately left open on this REST path) disambiguates `state:"running"` the SAME way `worker_list`/`worker_status`'s MCP `pendingMerge` already does: `state:"running"` is `PendingOpRegistry`'s own coarse in-flight bit, set the instant the merge op is minted — well before it's ever submitted to `GateSemaphore` for admission — so a viewer reading `startedAt` as "the gate started running" can watch the Board's live M:SS timer count queue-wait as if it were execution time. Reusing `gatePhaseForOpId` (never reimplemented — see its own doc in `sessions/service.ts`) folds in the SAME live `GateSemaphore.findByOpId` lookup `gate_status`/`gate_queue` already read, so this can never disagree with either. Only computed while `state === "running"` (a settled row's `outcome` already answers the question unambiguously) — omitted (not merely null) otherwise, byte-identical to before this field existed.

## Do not

- Do not reimplement the running/queued distinction here — always call the shared `gatePhaseForOpId` so this can never disagree with `gate_status`/`gate_queue`, which read the same `GateSemaphore.findByOpId` lookup.
- Do not compute `gatePhase` for a settled row — its `outcome` already answers the question; the field stays omitted, not merely null, for byte-identical behavior with sessions predating this field.

## Source

Inline comment in `packages/daemon/src/gateway/server.ts` (`GET /api/sessions`, lines 3935-3954 as of commit `a9b55042`). Relocated by card `c57868e5`; wording condensed, no substantive detail dropped.
