# 593cedc8 — a merge gate's RED is recorded before the gate releases its admission and repo guard

Follows 6f13746c (merge-gate state changes happen in main's order, inside the repo guard). A failing gate releases its cap slot and per-repo guard when `GateSemaphore.runExclusive` exits, but the red (`recordMergeGateFailure`, which sets `gateOwed` under a periodic cadence) used to be recorded AFTER that, so a skip-decided sibling waiting on the guard could be admitted, pass 6f13746c's in-lock owed check (not yet owed) and land ungated on top of a known red.

## Decision

`runExclusive` takes an optional 6th parameter `beforeRelease(result, thrown?)`, run before the `finally` frees the slot and guard: after the last link on a normal end, and — when a LATER link or `next` throws — with the LAST SETTLED result plus the error, then the error is rethrown unchanged. It is best-effort (a throwing hook is logged, never masks the verdict or the error), and is not run when the first `fn` throws (no verdict yet). Both merge paths pass it, so the ordering lives in one place:

- **Solo** (`confirmWorkerMerge`): `recordSoloRedOnce` records the final verdict's red from the hook. On a throw it records only for `GateWorktreeDirtyError` (a retry/resume link found the tree dirty after attempt 1's red — the path that then falls through with attempt 1's verdict); any other throw records nothing, as before. There is no post-release fallback any more.
- **Batch** (`mergeBatchTracked`): the batch's own hook records the red (`candidates: K`) on a normal end only; a once-flag guards the later `result.gateFailed` call, which stays for exits that never reach the hook (e.g. a cancel).
- **Forfeited batch:** the gate PASSED, so nothing is recorded at the gate (no pass either: nothing landed); each candidate's solo fallback decides and records for itself. **Fallback per-candidate:** goes through the solo path, so it inherits the solo ordering.
- **Cadence `every`:** recording early is harmless — `applyGateFail` sets `gateOwed` only when the gate was periodic/owed, and under `every` every later merge is gated anyway.
- Both once-flags are set before the recorder's await, so a hypothetical throwing recorder records nothing (same as before); the recorder never throws in practice and the post-gate call is not a retry.

## Do not

- Do not move the red's recording back after `runExclusive` returns: the release admits a waiting same-repo sibling in the same tick, before that record runs.
- Do not hand-place a second recording call on either path; extend the shared hook and keep the once-flag, or a red is recorded twice (the ring dedupes by opId, but `gateOwed` timing would still differ).
- Do not run the hook per link: only the FINAL verdict is a red; an intermediate failing attempt that a retry then passes must not owe a gate.
- Do not decide "is this a red" inline on either path: both call `isMergeGateRed` (card 13571c71, `13571c71-a-cancelled-gate-is-not-a-red-and-starts-nothing.md`) — a cancelled-while-queued batch is not a red. Card 90db13d8 (retry-admission reunion failure) extends the rule there, not with a third condition.

## Source

`packages/daemon/src/orchestration/gate-semaphore.ts` (`runExclusive`), `packages/daemon/src/sessions/service.ts` (`recordSoloRedOnce`, the batch hook). Tests: `packages/daemon/test/merge-gate-interval.mjs` (W, WB, W2 — W/WB stub the recorder to wait for a WITNESS: the waiter's confirm settling, else a bound; the precondition asserts the bound fired AND the waiter had not yet acquired its repo guard when the recorder ran — the latter is timing-independent, so a slow waiter cannot make a regression look fixed) and `gate-semaphore-retry-continuation.mjs` (H: the hook's ordering and its throw-path argument). The retry-link dirty-tree path is covered at the semaphore level only: driving a real `GateWorktreeDirtyError` from a retry link needs a real failing-test gate output plus a tree that goes dirty between links, which has no deterministic seam.
