# ba41b402 — bound the dangling-worker candidate pool to the newest N, accepting a real coverage loss

## Narrative

Card ba41b402: `listArchivedWorkersInProject` returns the `limit` most-recently-created archived worker-role sessions in a project that still carry a `branch` — the candidate pool for `SessionService.getDanglingWorkers`. Deliberately PROJECT-scoped, not manager-scoped like `listArchivedWorkers`: a stopped worker's `parent_session_id` may point at a recycled predecessor manager, and the caller applies its own lineage-tolerant filter on top of this broad set (mirrors `orchestration.ts`'s `archivedUnreported` category, which does the same "broad candidate query, then lineage-filter in the caller" split for the identical reason).

BOUNDED, per manager review on this card: this set only ever GROWS — every worker a project has ever archived stays in it forever, and `worker_list`/`worker_status({})` call this on every read, so an unbounded scan is a real, ever-worsening cost on the manager's most-polled tool. `LIMIT` + `ORDER BY created_at DESC` caps it to the newest N regardless of the project's total archived-worker history. TRADE-OFF, stated plainly: a genuinely-dangling branch OLDER than the newest `limit` archived workers stops being surfaced by this view. Accepted deliberately — the incident this card documents was hours old, not months — but it is a real coverage loss, not just a performance tweak.

## Do not

- Do not remove the `LIMIT`/`ORDER BY created_at DESC` bound to "fix" the coverage gap — the unbounded scan is a real, ever-worsening cost on `worker_list`/`worker_status({})`'s every-read hot path.
- Do not treat the bound as free of cost — a genuinely-dangling branch older than the newest `limit` archived workers is invisible to this view; that's an accepted trade-off, not a non-issue.

## Source

Inline comment in `packages/daemon/src/db.ts` (`listArchivedWorkersInProject`): lines 4823-4839, as of this tranche's HEAD.
