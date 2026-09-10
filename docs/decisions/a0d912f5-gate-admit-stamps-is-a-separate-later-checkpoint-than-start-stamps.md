# a0d912f5 — TWO decisions, one card id: `gateAdmitStamps`' own checkpoint, and `gate_cancel`'s required `scope`

This record anchors TWO distinct decisions from the same card, at two unrelated sites, merged into one
record because they share a card id (`resolveRecord`'s `.sort()[0]` over candidate filenames means a
second `a0d912f5-*.md` file would silently shadow one of these two decisions rather than adding to them).

## Decision A: `gateAdmitStamps` is a deliberately separate, later checkpoint than `gateStartStamps`

### Narrative

The worktree stamp `runWorkerGate` records at the moment its currently-running gate op was ADMITTED past the semaphore is a sibling of `gateStartStamps`, keyed the same way, but deliberately a DIFFERENT checkpoint. Cleared alongside it, at the same site — but SET at a deliberately later, different site than `gateStartStamps` (which is set at FIRE time, before admission): this one is set only once `fn` is actually admitted and running, inside `runExclusive`'s callback.

Why a separate map, not a reuse of `gateStartStamps`: the pre-emptive stale-attach refusal a re-call performs before ever attaching must distinguish "the worktree moved during the QUEUE WAIT" (benign — the gate hasn't spawned yet, so it will build whatever's on disk at admission, commit included) from "the worktree moved while the gate was already admitted/running" (the only case a refusal is honest about). Comparing against `gateStartStamps` (fire time) instead would collapse exactly the distinction the three-stamp design exists to preserve — a queued op's own eventual result WOULD cover a commit made after fire time, so refusing on that basis tells a caller to cancel a run that was going to validate exactly what it wanted.

This map is read ONLY once the caller has independently confirmed (via a fresh `gateSemaphore.snapshot()` read) that the op is genuinely admitted, not merely queued — never trust its mere presence as proof of that on its own, since a raced entry could theoretically outlive its own queued phase in this map's absence rather than its presence (in practice this is only ever written from inside the admitted branch, so this is belt-and-suspenders, not a known gap).

### Do not

- Do not "simplify" `gateAdmitStamps` back into `gateStartStamps` — collapsing the two set-sites (fire-time vs admission-time) reintroduces the queued-op false refusal `run-gate-result-consumption.mjs` scenario (D) exists to prevent.
- Do not treat this map's mere presence as proof the op is admitted — always independently confirm via a fresh `gateSemaphore.snapshot()` read first.

### Source

Inline comment in `packages/daemon/src/sessions/service.ts` (the `gateAdmitStamps` field doc, `SessionService`): originally lines 1899-1924, as of this tranche's HEAD. Relocated by card `9f4f8e5a` (tranche 7); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.

## Decision B: `gate_cancel`'s `params.scope` is a REQUIRED discriminator, never optional (unrelated decision, same card id)

### Narrative

Card a0d912f5 (Code Review [4]): `cancelGateOp`'s `params.scope` is a REQUIRED discriminator — `{kind:"project"}` (the pre-existing MANAGER surface: project-scoped only, exactly as before this card) or `{kind:"own", sessionId}` (the WORKER-scoped surface added by this card: cancel only an op it OWNS — `gateType === "worker"` AND `entry.sessionId === sessionId`). REQUIRED, not optional, on purpose: an earlier draft made this an optional `restrictToOwnerSessionId` field, which meant a future caller that simply forgot to pass it would silently inherit MANAGER-level (any op in the project) cancel power instead of failing to compile — Code Review caught this as a real capability-escalation-by-omission risk before it ever shipped.

A "merge" gate's own descriptor happens to be stamped with the WORKER's sessionId too (it shares the same worktree key, `merge:${workerSessionId}` vs `gate:${workerSessionId}` — see `confirmWorkerMerge`'s own descriptor construction), so a bare sessionId match alone would let a worker cancel its OWN merge gate — a MANAGER's decision, never the worker's — as an accidental side effect of that coincidence; the explicit `gateType === "worker"` conjunct is what keeps `{kind:"own"}` scoped to a worker's own `run_gate` self-check and nothing else, in either branch (the ordinary registry entry and the repo-guard-only fallback, which is unconditionally merge-shaped).

### Do not

- Do not make `params.scope` optional, or default it to project-wide (manager-level) cancel power — a caller that forgets to pass it must fail to compile, not silently inherit escalated capability.
- Do not gate `{kind:"own"}` on a bare `sessionId` match alone — a merge gate's descriptor is stamped with the worker's sessionId too, so without the explicit `gateType === "worker"` conjunct a worker could cancel its own merge gate, a decision that belongs to its manager.

### Source

JSDoc comment in `packages/daemon/src/sessions/service.ts`, above `cancelGateOp` (the `params.scope` doc): lines 4176-4190, as of this tranche's HEAD (tranche 10).
