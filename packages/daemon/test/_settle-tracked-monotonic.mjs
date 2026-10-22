// Card 426f9bdb — a MONOTONIC-clock sibling of `_settle-tracked.mjs`'s own `settleTracked`, for the
// cut-base-sha-*/fork-point-* family specifically. `_settle-tracked.mjs` is a widely-shared file this
// card has no reason to touch; its own deadline uses `Date.now()`, which a system-clock adjustment
// mid-wait could silently defeat (turning a genuine wedge into a hang that never throws). This helper
// uses `performance.now()` instead — the SAME choice `cut-base-sha-confirm-and-batch.mjs`'s own
// `awaitBatchSettle` already made for its scenario (2) — generalized here so every OTHER real tracked
// `confirmWorkerMergeTracked`/`mergeBatchTracked` call across this test family can share ONE
// implementation instead of five near-identical copies.
//
// @decision 89539537 — a `{settled:false, op}` degrade is recovered by polling `op.opId`'s own
// settlement read-only (`PendingOpRegistry.awaitSettleByOpId`), NEVER by re-invoking `call()` — see
// docs/decisions/89539537-await-settle-by-opid-not-re-invoke.md for why re-invoking is unsafe.
//
// Needs `{ pendingOps }` (the SessionService's own `PendingOpRegistry` instance — pass
// `sessions.pendingOps` / `d.sessions.pendingOps`, whatever the call site's session handle is named) to
// take the fixed path above. Every caller of this helper was updated to pass it (card 89539537) EXCEPT
// the four files card aa7677fa may be concurrently editing (mainline-watch.mjs, mainline-watch-batch.mjs,
// mainline-watch-boot.mjs, mainline-watch-batch-edges.mjs) — those still omit `pendingOps` and so still
// take the PRE-FIX path below (re-polling via `call()`, the same behavior this helper had before this
// card), pending a follow-up once that card's edits land. Do not add a new call site on the pre-fix path.
export async function awaitTrackedSettle(call, { label = "tracked call", timeoutMs = 60_000, pendingOps } = {}) {
  const deadline = performance.now() + timeoutMs;
  const r = await call();
  if (r.settled) return r;
  if (!pendingOps) {
    // PRE-FIX PATH — retained only for a caller not yet updated to pass `pendingOps` (see the header note
    // above). Loops by re-calling the SAME tracked closure until `settled`; carries the documented
    // double-run hazard this card fixed everywhere else (see docs/decisions/89539537-*.md).
    let cur = r;
    while (!cur.settled) {
      if (performance.now() > deadline) {
        throw new Error(`${label} did not settle within ${timeoutMs}ms (last op: ${JSON.stringify(cur.op)})`);
      }
      cur = await call();
    }
    return cur;
  }
  const remaining = Math.max(0, deadline - performance.now());
  const settled = await pendingOps.awaitSettleByOpId(r.op.opId, remaining);
  if (!settled) {
    throw new Error(`${label} did not settle within ${timeoutMs}ms (last op: ${JSON.stringify(r.op)})`);
  }
  return settled.ok ? { settled: true, ok: true, value: settled.value } : { settled: true, ok: false, error: settled.error };
}
