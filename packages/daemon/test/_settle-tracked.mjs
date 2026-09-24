// SHARED HELPER (card 988d35f5) — tolerate the documented `{settled:false}` async degrade of a `*Tracked` call.
//
// Under host load a `…Tracked(` call on the default SYNC_ATTACH_BUDGET_MS (12s) legitimately degrades to
// `{settled:false, op}` (see pending-ops.ts) — a supported path, not a failure. A test asserting
// `r.settled === true` on the FIRST result is then measuring the host's speed, not the code. This re-calls the
// SAME closure to re-attach: `PendingOpRegistry.attach` dedupes by key, so a re-call while the op is in flight
// attaches to it and NEVER re-runs it (and the attach result carries the entry's own freshMint). Each re-call
// blocks on the real op for up to the budget, so this is a condition wait on genuine settlement, bounded so a
// real wedge throws loudly. NEVER fabricate a value for the unsettled case, and never widen the budget.
//
// MINT ANNOTATION: the FIRST call is the one that minted the op, so its `freshMint` is the annotation under test.
// A re-poll that lands AFTER the op settled is served from the retained verdict as a `cacheHit` (no `freshMint`) —
// an artefact of polling, not of the call under test — so when the first result degraded, the settled result
// carries the first result's `freshMint` and drops that polling-artefact `cacheHit`. A first call that settled
// inline is returned untouched.
//
// RE-MINT GUARD: a re-call is only a re-attach while the op is still RUNNING. `confirmWorkerMergeTracked` does an
// async git identity resolve BEFORE `attach`, so the op can settle inside that gap; for a branch whose identity the
// op's own union-merge moved, the re-call then mints a SECOND op (a second real gate) instead of attaching. That
// cannot be fixed from here, so it is DETECTED (settled `value.opId` differs from the degraded op's) and thrown
// loudly rather than surfacing as an unrelated later assertion. A fixture whose identity the op itself moves should
// pass a generous per-instance `syncAttachBudgetMs` (the DI seam — never the production constant) so it never
// degrades in the first place.
export async function settleTracked(call, { label = "tracked call", timeoutMs = 60_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const first = await call();
  let r = first;
  while (!r.settled) {
    if (Date.now() > deadline) throw new Error(`${label} did not settle within ${timeoutMs}ms (last op state: ${JSON.stringify(r.op)})`);
    r = await call();
  }
  if (first.settled) return r;
  if (r.ok && !r.cacheHit && r.value?.opId !== undefined && first.op?.opId !== undefined && r.value.opId !== first.op.opId) {
    throw new Error(`${label}: re-poll minted a fresh op ${r.value.opId} instead of re-attaching to ${first.op.opId} (the op settled between polls and its identity moved)`);
  }
  return { ...r, freshMint: first.freshMint, cacheHit: undefined };
}
