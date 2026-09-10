# 460d3178 — boot-time orchestration reconcile is kicked AFTER `app.listen()`, fire-and-forget, never awaited

## Narrative

`sessions.reconcileOrchestrationOnBoot` (finishing any merge whose bookkeeping was interrupted, GCing orphaned worktrees from crashed workers) used to be `await`ed in `index.ts` BEFORE `app.listen()`. Owner-directed fix: boot was taking ~2 minutes because 8 dangling worktrees with stuck Windows dir handles each blocked reconcile's Pass A/B `removeWorktree` for the full `GIT_OP_TIMEOUT_MS` (15s) before its own `withTimeout` swallowed and moved on — 8 danglers serialized to 8×15s, and the port stayed unbound for the whole span. The fix moves the call to a fire-and-forget kick AFTER `app.listen()` — `void reconcileOrchestrationOnBoot(...).then(...).catch(...)`, never `await`ed — keeping the removals themselves serial (not parallelized — a threadpool-slot caveat, not a choice this fix touches) and the reconcile logic (guards, serial removal, summary log) byte-unchanged. Nothing between the old `await` site and `app.listen()` ever read the reconcile's result, so backgrounding it is pure ordering, not a behavior change. A merge briefly showing un-finalized on the board for the reconcile's own duration is a self-healing cosmetic cost, not a correctness one.

## Do not

- Do not `await` this call before `app.listen()` again — a single stuck Windows dir handle blocks the full `GIT_OP_TIMEOUT_MS`, and N dangling worktrees serialize to N × that timeout of unbound port.
- Do not parallelize the worktree removals themselves as a "fix" for the above — the fire-and-forget kick already solves the port-binding problem; parallelizing removal is a separate, unreviewed change with its own threadpool-slot caveat.

## Consequences

Boot no longer blocks port binding on worktree GC — a boot with several stuck dangling worktrees now listens immediately instead of taking minutes, at the cost of a brief window where a just-finished merge can show as un-finalized on the board until the background reconcile catches up.

## Source

Inline comment in `packages/daemon/src/index.ts`, immediately before the `sessions.reconcileOrchestrationOnBoot(...)` call, as of this worktree's HEAD before this extraction. Corroborated by `packages/daemon/test/boot-listen-not-blocked.mjs`'s own header comment (same card), which supplied the concrete "~2 minutes / 8 dangling worktrees" incident numbers not present in the source comment itself. Wrapped source lines joined into a flowing paragraph, `//` comment markers stripped, no wording changed beyond that merge.
