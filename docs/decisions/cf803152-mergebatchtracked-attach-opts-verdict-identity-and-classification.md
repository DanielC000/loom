# cf803152 — `mergeBatchTracked`'s `attach()` call also carries `retainMs`/`verdictIdentity`/`classifyOutcome`/`identityOptional`

## Narrative

Card cf803152: `mergeBatchTracked`'s `PendingOpRegistry.attach()` call (see
[[f944d4e4-mergebatchtracked-dedupe-attach-key]] for the dedupe key itself) now ALSO carries
`retainMs`/`retainVerdictUntilSuperseded`/`verdictIdentity`/`classifyOutcome`/`identityOptional` — through
two Code Review corrections: the first added `verdictIdentity`/`classifyOutcome` after the initial version
shipped without them; the second added `identityOptional` after this card's OWN new test caught the initial
"no mirror of the solo path's `alreadyFinished`" draft breaking recovery for the single most common real
case, a batch that landed.

It still carries no `onOpMinted`/`onSurfacedPending` — the batch's own `insertPendingGateOp` mint, inside
the gate closure, is unchanged, and still just receives the `opId` `attach()` mints instead of a
locally-generated one. `opts.onSettle` IS now passed (card `81d795de` — see
[[81d795de-mergebatch-settle-deferred-to-whole-batch-completion]] for the full deferred-settle mechanism
this enables). Card `be260976` (see [[be260976-batch-verdict-derivation-closes-the-never-existed-gap]])
already established that a `pending_gate_ops` tombstone row DOES exist for this op, correcting an earlier
"never routes through PendingOpRegistry" framing — this card is a CONTINUATION of that same,
already-sanctioned direction, not a new reversal of it.

The bounded `{settled:false}` return this whole `attach()` design produces mirrors `worker_merge_confirm`'s
own `{opId, status:"pending"}` vocabulary at the MCP layer (`mcp/orchestration.ts`'s `merge_batch` handler
translates it, same as that tool's own handler already does for `worker_merge_confirm`) rather than
inventing a parallel shape.

## Do not

- Do not add `onOpMinted`/`onSurfacedPending` to this `attach()` call — the batch's own `insertPendingGateOp` mint inside the gate closure is unchanged and deliberately still receives the `attach()`-minted `opId` rather than generating its own.
- Do not invent a parallel pending/settled vocabulary at the MCP layer for `merge_batch` — reuse `worker_merge_confirm`'s own `{opId, status:"pending"}` shape, which `mcp/orchestration.ts` already translates this call's bounded `{settled:false}` return into.
- Do not omit `identityOptional` on the assumption every batch outcome mirrors the solo path's `alreadyFinished` shape — an earlier draft without it broke recovery for the single most common real case, a batch that landed, and this card's own new test is what caught it.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts`, `mergeBatchTracked`'s own JSDoc header, as of this tranche's HEAD.

## `verdictIdentity` and the whole-batch `alreadyFinished` short-circuit — the mechanism itself

VERDICT IDENTITY: a REPRODUCED regression in this card's first attempt — `retainVerdictUntilSuperseded`
with no `verdictIdentity` made a rejected batch's cached verdict IMMORTAL: both workers could commit the
actual fix and a re-fire with the same resolved candidate set still replayed the stale rejection forever,
because `batchKey` is manager+workerSessionIds only, never branch content, and a `verdictIdentity`
mismatch is the ONLY non-`bypassRetained` route to a fresh mint under an existing key. Mirrors
`confirmWorkerMergeTracked`'s own `verdictIdentity` exactly (this file, on the solo merge key) — resolved
BEFORE the dedupe decision, from EVERY chosen candidate's CURRENT branch HEAD, sorted so identical content
in a different `chosen` order still matches — so a re-fire after ANY of them moves (a worker pushes the
actual fix; a candidate's branch is later deleted post-landing) is gated FOR REAL instead of replayed.
Fails safe to `undefined` on ANY resolution issue (a candidate's branch gone, a git error/timeout) —
`undefined` never dedupe-hits against a cached entry that itself carries a real identity, so an
unresolvable identity here means "don't trust the cache," never "trust it anyway," the same fail-safe
direction the solo path's own doc states.

ALREADY-FINISHED SHORT-CIRCUIT FOR THE WHOLE BATCH: the PRACTICAL gap an initial "no `identityOptional`
mirror" draft of this comment got wrong, caught by this card's own added test — a successful batch landing
deletes EVERY landed candidate's branch, via the SAME `finishAlreadyMerged`/`finalizeMerge` the solo path
already has to handle, so a recovery re-call made right after a batch actually LANDS would, absent this
check, resolve every branch as gone, compute `verdictIdentity: undefined`, mismatch the cached (real)
identity, and re-mint — defeating this whole card's recoverability goal for the single most common
real-world case, a batch that landed. Mirrors the solo path's OWN two-part `alreadyFinished` formula
exactly (worktree gone OR task already terminal — see that method's own doc for why either alone is
insufficient), generalized from one worker to the WHOLE `chosen` set:
true only when EVERY candidate independently satisfies it — a MIXED batch (one candidate finished, another
still genuinely live) still requires a real identity match, since only a WHOLLY finished batch is safe to
assume "this exact question was already answered."

### Source (2)

Inline comment in `packages/daemon/src/sessions/service.ts`, `mergeBatchTracked`'s body, immediately before
the `batchAlreadyFinished` computation (the VERDICT IDENTITY / ALREADY-FINISHED SHORT-CIRCUIT block), as of
this tranche's HEAD.
