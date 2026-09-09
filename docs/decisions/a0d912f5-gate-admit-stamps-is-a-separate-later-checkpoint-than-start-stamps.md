# a0d912f5 — `gateAdmitStamps` is a deliberately separate, later checkpoint than `gateStartStamps`

## Narrative

The worktree stamp `runWorkerGate` records at the moment its currently-running gate op was ADMITTED past the semaphore is a sibling of `gateStartStamps`, keyed the same way, but deliberately a DIFFERENT checkpoint. Cleared alongside it, at the same site — but SET at a deliberately later, different site than `gateStartStamps` (which is set at FIRE time, before admission): this one is set only once `fn` is actually admitted and running, inside `runExclusive`'s callback.

Why a separate map, not a reuse of `gateStartStamps`: the pre-emptive stale-attach refusal a re-call performs before ever attaching must distinguish "the worktree moved during the QUEUE WAIT" (benign — the gate hasn't spawned yet, so it will build whatever's on disk at admission, commit included) from "the worktree moved while the gate was already admitted/running" (the only case a refusal is honest about). Comparing against `gateStartStamps` (fire time) instead would collapse exactly the distinction the three-stamp design exists to preserve — a queued op's own eventual result WOULD cover a commit made after fire time, so refusing on that basis tells a caller to cancel a run that was going to validate exactly what it wanted.

This map is read ONLY once the caller has independently confirmed (via a fresh `gateSemaphore.snapshot()` read) that the op is genuinely admitted, not merely queued — never trust its mere presence as proof of that on its own, since a raced entry could theoretically outlive its own queued phase in this map's absence rather than its presence (in practice this is only ever written from inside the admitted branch, so this is belt-and-suspenders, not a known gap).

## Do not

- Do not "simplify" `gateAdmitStamps` back into `gateStartStamps` — collapsing the two set-sites (fire-time vs admission-time) reintroduces the queued-op false refusal `run-gate-result-consumption.mjs` scenario (D) exists to prevent.
- Do not treat this map's mere presence as proof the op is admitted — always independently confirm via a fresh `gateSemaphore.snapshot()` read first.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (the `gateAdmitStamps` field doc, `SessionService`): originally lines 1899-1924, as of this tranche's HEAD. Relocated by card `9f4f8e5a` (tranche 7); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
