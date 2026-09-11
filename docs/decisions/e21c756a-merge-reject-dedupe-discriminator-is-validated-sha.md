# e21c756a — the merge-reject dedupe discriminator is the validated sha, not `opId` or worker+reason alone

## Narrative

The third suppress condition in `shouldSuppressMergeReject` ([[8fb05b2d-suppress-stale-merge-reject-notify-when-already-resolved]]) de-dupes an identical rejection so a stale re-run doesn't notify twice — but keying that de-dupe correctly is genuinely hard, and two plausible-looking answers were tried and rejected before landing on the real discriminator.

**Wrong answer 1 — worker + reason alone.** Keying only on `(workerSessionId, reason)` used to let a SECOND, genuinely distinct rejection on the same worker silently vanish whenever it happened to reject with the same generic reason string (e.g. `"gate"`) — the manager was never told about a real, separate failure just because the reason text matched a prior one.

**Wrong answer 2 — `opId`.** The obvious-looking fix is to key on the tracked op's `opId` instead. This is ALSO wrong: `confirmWorkerMergeTracked`'s own `PendingOpRegistry.attach()` mints a genuinely FRESH `opId` for a retry of the exact SAME situation whenever its identity-gated verdict cache misses for a reason that has nothing to do with new work — e.g. a transient git-ref read failure, or `forceRemoveWorktree`'s deliberate cache bypass (see `confirmWorkerMergeTracked`'s own `verdictIdentity`/`bypassRetained` doc). `merge-reject-notify-suppress.mjs` scenario (D) calls `confirmWorkerMerge` directly — bypassing that registry entirely, so EVERY call mints its own random `opId` — specifically to prove that two calls reproducing the identical rejection for the identical commit must still notify only ONCE. Keying on `opId` fails that: same commit, same reason, different `opId` ⇒ wrongly treated as distinct, and the manager gets spammed with duplicate notifications for the one real failure.

**The actual discriminator: WHAT COMMIT WAS BEING VALIDATED**, read via `getWorktreeLatestNonMergeSha` — the same "did real new work land" signal the gate-timeout circuit breaker ([[3564fd1e-gate-timeout-circuit-breaker-streak]]) already uses. This sha is invariant to the pre-gate union-merge, so it doesn't move just because canonical main advanced, but DOES move the moment the worker pushes a genuine new commit. Two rejections for the same worker + same reason + same sha are the SAME underlying situation (a retry, a re-poll, a re-mint with a fresh `opId`) ⇒ suppress; a sha mismatch is genuinely distinct new work rejecting again ⇒ notify. A failed sha read (`null`) never matches — including against a prior `null` — so a flaky/unreadable worktree always fails toward notifying, never toward suppressing.

## Do not

- Do not key the de-dupe on `(worker, reason)` alone — a second, distinct failure with the same generic reason string silently vanishes.
- Do not key the de-dupe on `opId` — a retry of the identical situation can mint a genuinely fresh `opId` (see `PendingOpRegistry.attach()`), so this both under- and over-discriminates depending on which retry path fired.
- Do not let a null sha read match another null read — treat an unreadable worktree as always-distinct, never as a match, so it fails toward notifying.

## Source

JSDoc comment in `packages/daemon/src/sessions/service.ts`, above `shouldSuppressMergeReject` (the "DISCRIMINATOR" section): originally lines 11334-11354, as of service.ts tranche 40's HEAD. Extracted by tranche 40.
