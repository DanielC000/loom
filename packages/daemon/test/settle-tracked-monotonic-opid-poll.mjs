// Card 89539537 — forced-budget RED/GREEN control for `_settle-tracked-monotonic.mjs`'s own two code
// paths, plus direct unit coverage of `PendingOpRegistry.awaitSettleByOpId` (the mechanism the fixed path
// relies on). HERMETIC: pure in-memory `PendingOpRegistry` + synthetic `run()` closures driven by
// externally-controlled resolvers — no daemon, no git, no real wall-clock race (every "settle between
// polls" moment is forced deterministically, never left to timing luck).
//
// THE BUG THIS CONTROLS FOR: `awaitTrackedSettle`'s pre-fix path recovers a `{settled:false}` degrade by
// re-calling the SAME tracked closure until it sees `{settled:true}`. For a key whose classified outcome
// is in `NEVER_CACHED_OUTCOMES` (here: "cancelled"), neither cache is ever written at settle — so if the
// FIRST op settles in the gap between polls, the next re-call finds no running entry and no cache hit and
// legitimately mints a genuinely SECOND real op. The old path then returns THAT op's verdict as if it
// were the first's. See docs/decisions/89539537-await-settle-by-opid-not-re-invoke.md.
//
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/settle-tracked-monotonic-opid-poll.mjs
import { PendingOpRegistry } from "../dist/orchestration/pending-ops.js";
import { awaitTrackedSettle } from "./_settle-tracked-monotonic.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (pred, { label, timeoutMs = 2_000 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`waitFor timed out: ${label ?? "<unlabeled>"}`);
    await sleep(2);
  }
};

// A `run()` whose completion is controlled from OUTSIDE (via `resolvers[n]()`), classified "cancelled" —
// a NEVER_CACHED_OUTCOMES member, so a settled op is never replayed from either cache and a re-call after
// settle genuinely re-mints. Mirrors the real `confirmWorkerMergeTracked` shape closely enough to exercise
// `awaitTrackedSettle`'s own two paths faithfully. `beforeCall(n)` (optional) runs BEFORE the n-th
// `attach()` invocation — used by the RED scenario below to force the exact "settled, and nothing is
// racing it" gap a real poll loop hits only rarely (by luck); every other scenario ignores it.
function makeFixture({ beforeCall } = {}) {
  const reg = new PendingOpRegistry();
  let callCount = 0;
  const resolvers = {};
  const run = async () => {
    callCount++;
    const num = callCount;
    await new Promise((resolve) => { resolvers[num] = resolve; });
    return { runNum: num };
  };
  const owner = { exempt: true, reason: "settle-tracked-monotonic-opid-poll.mjs control" };
  const classify = () => "cancelled";
  let invocation = 0;
  const call = async () => {
    invocation++;
    await beforeCall?.(invocation);
    return reg.attach("dbl-89539537", "merge", "mgr1", 5, run, undefined, { classifyOutcome: classify }, owner);
  };
  return { reg, call, resolvers, getCallCount: () => callCount };
}

// --- (RED) PRE-FIX PATH: awaitTrackedSettle with NO `pendingOps` re-polls via the closure and reports
// the SECOND op's verdict, not the first's, once the first settles between polls -----------------------
//
// A tight re-poll loop only hits the double-mint window when op #1 settles in the brief, timing-
// dependent GAP between one `call()` returning and the next one starting — real but not reliably
// reproducible on demand (see the b2c5a8f9 incident this card fixes: a FAST underlying op settling
// faster than the loop's own call-await-call round trip). `beforeCall` below forces that exact gap
// deterministically, ahead of the loop's SECOND invocation: resolve op #1 and wait for it to be fully
// evicted with NOTHING racing it — the precondition that makes the next `attach()` call genuinely mint,
// never luck-dependent.
{
  let resolvedOp1 = false;
  const { reg, call, resolvers, getCallCount } = makeFixture({
    beforeCall: async (n) => {
      if (n !== 2) return;
      resolvers[1]();
      resolvedOp1 = true;
      await waitFor(() => reg.peek("dbl-89539537") === undefined, { label: "op #1 evicted before the 2nd poll proceeds" });
    },
  });
  const oldResultPromise = awaitTrackedSettle(call, { label: "control-old", timeoutMs: 5_000 }); // no pendingOps
  await waitFor(() => resolvedOp1, { label: "the 2nd poll forced op #1's settle+eviction" });
  await waitFor(() => !!resolvers[2], { label: "a genuinely SECOND op minted after op #1 settled" });
  check("(RED setup) the pre-fix path's re-poll minted a genuinely SECOND real op after op #1 settled", getCallCount() === 2);
  resolvers[2]();
  const oldResult = await oldResultPromise;
  check("(RED) the pre-fix path settles", oldResult.settled === true && oldResult.ok === true);
  check("(RED) …but reports the SECOND op's verdict (runNum:2), not the op it originally started", oldResult.value.runNum === 2);
}

// --- (GREEN) FIXED PATH: awaitTrackedSettle WITH `pendingOps` never re-invokes the closure and reports
// the FIRST op's own verdict, even though the SAME never-cached outcome is in play ----------------------
{
  const { reg, call, resolvers, getCallCount } = makeFixture();
  const newResultPromise = awaitTrackedSettle(call, { label: "control-new", timeoutMs: 5_000, pendingOps: reg });
  await waitFor(() => !!resolvers[1], { label: "op #1 minted" });
  resolvers[1]();
  const newResult = await newResultPromise;
  check("(GREEN) the fixed path settles", newResult.settled === true && newResult.ok === true);
  check("(GREEN) …and reports the FIRST op's own verdict (runNum:1)", newResult.value.runNum === 1);
  check("(GREEN) the closure's run() was invoked EXACTLY ONCE — no double-run", getCallCount() === 1);
}

// --- direct unit coverage of PendingOpRegistry.awaitSettleByOpId -----------------------------------------

// (a) RUNNING-entry path: reads the live entry by reference, no second invocation, settles correctly.
{
  const { reg, call, resolvers, getCallCount } = makeFixture();
  const r1 = await call();
  check("(awaitSettleByOpId/running setup) op is pending", r1.settled === false);
  const settlePromise = reg.awaitSettleByOpId(r1.op.opId, 2_000);
  await waitFor(() => !!resolvers[1], { label: "op minted" });
  resolvers[1]();
  const settled = await settlePromise;
  check("(awaitSettleByOpId/running) recovers the live entry's own verdict", settled?.ok === true && settled.value.runNum === 1);
  check("(awaitSettleByOpId/running) never re-invoked run()", getCallCount() === 1);
}

// (b) EVICTED fallback path: the op already settled (and evicted) before awaitSettleByOpId is called —
// recovered from the unconditional, opId-keyed `settledByOpId` record instead of the live entry.
{
  const { reg, call, resolvers } = makeFixture();
  const r1 = await call();
  resolvers[1]();
  await waitFor(() => reg.peek("dbl-89539537") === undefined, { label: "op #1 evicted" });
  const settled = await reg.awaitSettleByOpId(r1.op.opId, 2_000);
  check("(awaitSettleByOpId/evicted-fallback) recovers the SAME verdict after eviction, via the opId-keyed record", settled?.ok === true && settled.value.runNum === 1);
}

// (c) UNKNOWN opId: neither a live entry nor a settle record exists — returns undefined, never a
// fabricated verdict.
{
  const { reg } = makeFixture();
  const settled = await reg.awaitSettleByOpId("bogus-opid-never-minted", 50);
  check("(awaitSettleByOpId/unknown) returns undefined for an opId that was never minted here", settled === undefined);
}

// (d) TIMEOUT: a RUNNING entry that never settles within the given budget — returns undefined (so the
// caller's own named-op wedge error still fires), never hangs past the budget.
{
  const { reg, call, resolvers } = makeFixture();
  const r1 = await call();
  const before = Date.now();
  const settled = await reg.awaitSettleByOpId(r1.op.opId, 60);
  const elapsed = Date.now() - before;
  check("(awaitSettleByOpId/timeout) returns undefined rather than hanging when the op never settles in time", settled === undefined);
  check("(awaitSettleByOpId/timeout) actually bounded by the given timeoutMs (not instant, not unbounded)", elapsed >= 50 && elapsed < 2_000);
  resolvers[1](); // let the real op settle so it doesn't leak into a later scenario via a dangling timer
}

// --- the monotonic deadline + named-op wedge error survive the fix (never silently hang) ----------------
{
  const { reg, call, resolvers } = makeFixture(); // intentionally never resolved — genuine wedge
  let threw;
  try {
    await awaitTrackedSettle(call, { label: "control-wedge", timeoutMs: 40, pendingOps: reg });
  } catch (err) { threw = err; }
  check("(wedge) a genuinely stuck op still throws a named error rather than hanging forever", threw instanceof Error && /control-wedge did not settle within 40ms/.test(threw.message));
  resolvers[1](); // let it settle so nothing dangles
}

console.log(failures === 0
  ? "\n✅ ALL PASS — Card 89539537: `awaitTrackedSettle`'s pre-fix (no `pendingOps`) path re-polls the tracked closure and, for a NEVER_CACHED_OUTCOMES key, genuinely mints and reports a SECOND real op once the first settles between polls (the documented double-run hazard, demonstrated RED); the fixed path (`pendingOps` given) recovers the FIRST op's own verdict via `PendingOpRegistry.awaitSettleByOpId` without ever re-invoking the closure (GREEN, run() invoked exactly once). `awaitSettleByOpId` itself is covered directly: a RUNNING entry is read by reference with no second invocation; an already-settled-and-EVICTED op is still recovered via the unconditional, opId-keyed settle record; an unknown opId returns `undefined` rather than a fabricated verdict; a genuinely stuck op times out to `undefined` rather than hanging, bounded by the caller's own budget. The monotonic deadline and the named-op wedge error both survive the fix."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
