# 8f58c354 — `cancelQueued`'s gate-type check is a compile-enforced ALLOWLIST, never a denylist

## Narrative

Code Review re-review of card `8d585277`, card 8f58c354 (re-stated by card `361520a0` Half Two's CR follow-up, once `merge` gained the same catch): a `gateType` is cancellable in `GateSemaphore.cancelQueued` ONLY once its `runExclusive` caller has a `GateCancelledError` catch to turn a withdrawn admission into a clean settle instead of a crash-shaped throw. `worker` (`runWorkerGate`) and, since card `361520a0`, `merge` (`confirmWorkerMerge`) both have one; `deploy` (`deployOwnProject`) does NOT yet.

This is DELIBERATELY AN ALLOWLIST, NOT A DENYLIST — a card `361520a0` CR finding caught an earlier draft written as `gateType === "deploy"` (refuse), which flips fail-closed into fail-open: a FOURTH `GateType` added later would be silently CANCELLABLE by default (allowed by a denylist that never named it) instead of refused until its own caller is proven to have the catch. The `switch` is exhaustive over `GateType` — TypeScript raises a COMPILE ERROR at the `never` assignment in `default` the moment a new member is added to that union, forcing an explicit decision here rather than a silent permission grant. Enforced HERE, at the primitive, so a future third caller of this method inherits the SAME fail-closed default automatically instead of having to remember to re-derive it — the existing caller-side guards (`cancelGateOp`, `cancelQueuedForSession`'s own `gateType` match) stay in place as defence-in-depth, not a replacement for this.

## Do not

- Do not write `cancelQueued`'s gate-type check as a denylist (e.g. `gateType === "deploy"` → refuse) — that fails OPEN for a future fourth `GateType`, silently allowing cancellation before its `runExclusive` caller is proven to have the `GateCancelledError` catch that makes it safe.
- Do not rely on the exhaustive `switch`'s compile-time enforcement alone — the existing caller-side guards (`cancelGateOp`, `cancelQueuedForSession`) are defence-in-depth, not made redundant by it.

## Source

Inline comment in `packages/daemon/src/orchestration/gate-semaphore.ts` (`cancelQueued`'s own doc, lines 996-1010), commit `ede81d3b8`, as of `beeeb7c2`. Relocated by card `772735d2` (tranche 2); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
