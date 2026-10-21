// Card 426f9bdb — a MONOTONIC-clock sibling of `_settle-tracked.mjs`'s own `settleTracked`, for the
// cut-base-sha-*/fork-point-* family specifically. `_settle-tracked.mjs` is a widely-shared file this
// card has no reason to touch; its own deadline uses `Date.now()`, which a system-clock adjustment
// mid-wait could silently defeat (turning a genuine wedge into a hang that never throws). This helper
// uses `performance.now()` instead — the SAME choice `cut-base-sha-confirm-and-batch.mjs`'s own
// `awaitBatchSettle` already made for its scenario (2) — generalized here so every OTHER real tracked
// `confirmWorkerMergeTracked`/`mergeBatchTracked` call across this test family can share ONE
// implementation instead of five near-identical copies.
//
// Tolerates the documented `{settled:false, op}` async degrade of a `*Tracked` call (see
// `orchestration/pending-ops.ts`) — a SUPPORTED path, not a failure. A test asserting `r.settled===true`
// on the FIRST result measures the host's speed, not the code under test. Re-calling the SAME closure
// RE-ATTACHES to the in-flight op (`PendingOpRegistry.attach` dedupes by key) instead of re-running it
// WHILE it is still running, so this is a condition wait on genuine settlement, bounded so a real wedge
// throws loudly and NAMES the last-seen op — never a blind sleep, and never a fabricated value for the
// unsettled case.
//
// ⚠️ DELIBERATELY NO cross-poll re-mint guard (unlike the ORIGINAL local `awaitBatchSettle` this
// generalizes from, which asserted consecutive pending polls carry the SAME opId): proven by a real run
// against a FAST, gateless solo confirm (`cut-base-sha-confirm-and-batch.mjs` scenario (1), under a
// forced `syncAttachBudgetMs: 1`) that this assertion is a FALSE POSITIVE for that shape. A gateless
// cross-lineage refusal settles in low single-digit milliseconds — faster than this helper's own
// call-await-call round-trip — so the FIRST minted op can genuinely SETTLE before the second poll even
// starts. confirmWorkerMergeTracked's own verdict handling for this outcome does not replay the just-
// settled verdict on that second call (see cut-base-sha-confirm-verdict-cache.mjs scenario (2)'s own
// "sanity: the REAL condition, not a cache, is still the blocker here" — a fresh real re-attempt, not a
// cache read) — it legitimately mints a SECOND real op. That is correct production behavior, not a race:
// this helper only ever has ONE in-flight call at a time (every iteration `await`s the previous one
// before issuing the next), so there is no way for THIS caller to cause two GENUINELY CONCURRENT real
// merges — a changed opId between two sequential, fully-awaited polls can only mean the first finished in
// between, never that two ran at once. Asserting same-ness there was testing an invariant the call
// pattern can't violate, while incorrectly flagging the real, intended NEVER_CACHED_OUTCOMES behavior as
// a bug. (The ORIGINAL `awaitBatchSettle`'s own guard happened to never trip in production because real
// batch assembly takes seconds, not milliseconds — the window this note describes is specific to a FAST
// underlying op under a FORCED tiny budget, which batch calls never hit.)
export async function awaitTrackedSettle(call, { label = "tracked call", timeoutMs = 60_000 } = {}) {
  const deadline = performance.now() + timeoutMs;
  let r = await call();
  while (!r.settled) {
    if (performance.now() > deadline) {
      throw new Error(`${label} did not settle within ${timeoutMs}ms (last op: ${JSON.stringify(r.op)})`);
    }
    r = await call();
  }
  return r;
}
