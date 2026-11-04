# 03b0377e — the not-found/not-yours split for the worker write tools lives at the MCP layer, not service.ts

Card `03b0377e` extends `b4b246dd`'s "no such worker session" vs "not your worker" split from the three worker read tools (worker_status/worker_transcript/worker_report_get) to the write tools: worker_message, worker_stop, worker_redirect, worker_set_mode, worker_recycle, worker_merge, worker_merge_confirm. worker_revive is deliberately excluded — its own `reviveWorker` already makes this split, in its own wording, and the lead's decision was to leave it alone rather than churn it.

## Where the fix lives, and why

The pre-check (`const w = selfHealWorkerLink(...); if (!w || !workerReadableByManager(w)) return ok(workerLookupError(...))`) sits in `mcp/orchestration.ts`, immediately before each tool's call into its underlying `sessions.*` method — mirroring exactly how `b4b246dd` already fixed the three read tools, and reusing the SAME `workerLookupError`/`workerNotFoundHint` helper. No new resolution logic was written.

`sessions/service.ts`'s own throws (`throw new Error("not your worker")` on `!worker || worker.parentSessionId !== managerSessionId`, at `messageWorker`/`stopWorker`/`redirectWorker`/`setWorkerMode`/`recycleWorker`/`reviewWorkerMerge`, and the typed `NotYourWorkerError` in `confirmWorkerMergeTracked`/`confirmWorkerMerge`) are left UNTOUCHED, as defense-in-depth for a caller that reaches the service layer directly. Two existing tests, `redirect-worker.mjs` and `worker-set-mode.mjs`, call `sessions.redirectWorker`/`sessions.setWorkerMode` directly with a bogus id and assert the literal, unsplit "not your worker" throw — exactly why the split was not pushed down into service.ts.

## worker_merge_confirm specifically

`confirmWorkerMergeTracked` already has its own, lineage-tolerant pre-`pendingOps.attach()` ownership check (decisions `656e326f`/`164f7915`), both of which explicitly warn against adding a second exact-id check on that path. The new MCP-layer pre-check never touches any of that — it runs strictly BEFORE `confirmWorkerMergeTracked` is ever called, using the SAME `selfHealWorkerLink`/`workerReadableByManager` lineage-tolerant check the read tools already use (never the narrower, exact-parent-only `db.listWorkers()`), so an EXITED/archived worker still in the caller's own lineage — worker_merge/worker_merge_confirm's common real-world target (a worker that reported done and exited, now awaiting review/confirm) — is never wrongly refused. Verified directly in `worker-write-notfound-didyoumean.mjs`'s case (D).

## No prefix resolution

The kickoff for this card originally asked whether the write tools should accept an 8-char id-prefix "like the read tools" — investigation found that premise false: neither the read tools nor any write tool resolves a prefix for `workerSessionId` today (the only existing precedent, `worker_relink`, resolves prefixes GLOBALLY, not lineage-scoped). The lead's revised decision: no prefix resolution on the write tools at all — they're destructive, and it removes the lineage-scope question entirely. Each tool's description now states plainly that `workerSessionId` must be the FULL session id.

## Do not

- Do not push this split down into `sessions/service.ts`'s own throws — `redirect-worker.mjs` and `worker-set-mode.mjs` call those methods directly and assert the old, unsplit "not your worker"; moving the split there breaks them for no benefit (the MCP layer already covers every real caller).
- Do not add prefix resolution to these write tools without first re-opening the lineage-scope question this card's investigation surfaced above — `worker_relink`'s own global (non-lineage-scoped) prefix resolution is not a safe precedent to copy here.
- Do not scope the orchestration.ts pre-check to `db.listWorkers()` (exact-parent, live-only) or otherwise narrow it below `workerReadableByManager`'s lineage-tolerant check — that would wrongly refuse an exited/archived worker still in the caller's lineage, the common case worker_merge/worker_merge_confirm actually serve.
- Do not re-wire worker_revive onto this split — leave its own, differently-worded not-found/not-yours split as-is.
