// Card 37fe091c: `mapWithConcurrency` is what replaced `getRetainedWorktrees`' fully SERIAL classify
// loop — a never-resolving, unbounded `Promise.all` over the whole set would trade "too slow" for "too
// many concurrent git subprocesses at once", so this proves the pool bound holds, never that it merely
// finishes. NO claude, no daemon, no git — pure unit test of the generic utility.
// Run: 1) build daemon, 2) node test/concurrency.mjs
const { mapWithConcurrency } = await import("../dist/concurrency.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

// ── (1) THE DISCRIMINATING ASSERTION — max concurrent in-flight never exceeds `limit` ──────────────────
// Each task blocks on its OWN deferred promise (never a fixed-timer sleep — a timer-based "prove it never
// exceeds N" would be unfalsifiable: a slow host could serialize naturally and still pass). Instead, every
// task signals it has STARTED, we wait until exactly `limit` are signalled as started with NONE released,
// confirm no (limit+1)th task starts while that's true, THEN release one and confirm exactly one more
// starts to take its place.
{
  const LIMIT = 3;
  const N = 10;
  const started = new Array(N).fill(false);
  const gates = Array.from({ length: N }, () => deferred());
  let maxInFlight = 0;
  let currentInFlight = 0;

  const fn = async (item, i) => {
    started[i] = true;
    currentInFlight++;
    maxInFlight = Math.max(maxInFlight, currentInFlight);
    await gates[i].promise;
    currentInFlight--;
    return item * 2;
  };

  const resultPromise = mapWithConcurrency(Array.from({ length: N }, (_, i) => i), LIMIT, fn);

  // Give the pool a microtask tick to admit its first wave.
  await new Promise((r) => setImmediate(r));
  check(`(1) exactly LIMIT=${LIMIT} tasks started immediately (got ${started.filter(Boolean).length})`,
    started.filter(Boolean).length === LIMIT);
  check(`(1) maxInFlight never exceeded LIMIT=${LIMIT} so far (got ${maxInFlight})`, maxInFlight === LIMIT);
  check("(1) task 3 (the (LIMIT+1)th) has NOT started while the pool is full", started[LIMIT] === false);

  // Release exactly one of the first LIMIT — exactly one MORE task must start to take its place, never two.
  gates[0].resolve();
  await new Promise((r) => setImmediate(r));
  const startedAfterOneRelease = started.filter(Boolean).length;
  check(`(1) releasing ONE in-flight task starts exactly ONE more (got ${startedAfterOneRelease} total started, expected ${LIMIT + 1})`,
    startedAfterOneRelease === LIMIT + 1);
  check(`(1) maxInFlight STILL never exceeded LIMIT=${LIMIT} (got ${maxInFlight})`, maxInFlight === LIMIT);

  // Release everything else and let it finish.
  for (let i = 1; i < N; i++) gates[i].resolve();
  const results = await resultPromise;
  check(`(1) maxInFlight NEVER exceeded LIMIT=${LIMIT} across the WHOLE run (got ${maxInFlight})`, maxInFlight <= LIMIT);
  check("(1) every task eventually ran (all `started` true)", started.every(Boolean));
  check("(1) result order matches input order regardless of completion order",
    JSON.stringify(results) === JSON.stringify(Array.from({ length: N }, (_, i) => i * 2)));
}

// ── (2) NEGATIVE CONTROL for (1)'s own instrument — an UNBOUNDED run (limit >= N) must be able to exceed
//    any smaller N-1 bound, proving the LIMIT=3 result above reflects a real enforced cap, not an
//    artifact of how fast these particular tasks happen to run. ────────────────────────────────────────
{
  const N = 10;
  const gates = Array.from({ length: N }, () => deferred());
  let maxInFlight = 0;
  let currentInFlight = 0;
  const fn = async (item) => {
    currentInFlight++;
    maxInFlight = Math.max(maxInFlight, currentInFlight);
    await gates[item].promise;
    currentInFlight--;
    return item;
  };
  const resultPromise = mapWithConcurrency(Array.from({ length: N }, (_, i) => i), N, fn); // limit === N: everything admitted at once
  await new Promise((r) => setImmediate(r));
  check(`(2) NEGATIVE CONTROL — limit===N admits ALL ${N} at once (maxInFlight=${maxInFlight}), proving (1)'s LIMIT=3 cap was a real enforced bound, not this environment's natural ceiling`,
    maxInFlight === N);
  for (const g of gates) g.resolve();
  await resultPromise;
}

// ── (3) order-preservation under OUT-OF-ORDER completion — the fastest task finishes first, but the
//    returned array must still be in INPUT order. ───────────────────────────────────────────────────────
{
  const delays = [30, 5, 20, 1, 10]; // deliberately scrambled
  const results = await mapWithConcurrency(delays, 5, (ms, i) => new Promise((resolve) => setTimeout(() => resolve(i), ms)));
  check(`(3) order preserved despite out-of-order completion (got [${results}])`, JSON.stringify(results) === "[0,1,2,3,4]");
}

// ── (4) edge cases ────────────────────────────────────────────────────────────────────────────────────
{
  let called = false;
  const empty = await mapWithConcurrency([], 5, async () => { called = true; return 1; });
  check("(4) empty items: resolves to []", Array.isArray(empty) && empty.length === 0);
  check("(4) empty items: fn never called", called === false);
}
{
  let called = false;
  const zeroLimit = await mapWithConcurrency([1, 2, 3], 0, async (x) => { called = true; return x; });
  check("(4) limit<=0: resolves to an array of the right length", zeroLimit.length === 3);
  check("(4) limit<=0: fn never called (nothing admitted)", called === false);
}
{
  // limit larger than items.length must not throw or hang — only items.length workers are ever needed.
  const results = await mapWithConcurrency([1, 2], 50, async (x) => x * 10);
  check("(4) limit > items.length: still resolves correctly", JSON.stringify(results) === "[10,20]");
}
{
  // a single item, limit 1 — the minimal real case.
  const results = await mapWithConcurrency(["x"], 1, async (s) => s.toUpperCase());
  check("(4) single item: resolves correctly", JSON.stringify(results) === '["X"]');
}
{
  // card 37fe091c minor #4: `!(limit >= 1)` must treat a NaN limit as unusable (never fall through to
  // `Math.min(NaN, items.length)` → `Array.from({length: NaN})`, which silently produces an EMPTY pool —
  // nothing would ever run, with no error and no signal that the limit itself was bogus).
  let called = false;
  const nanLimit = await mapWithConcurrency([1, 2, 3], NaN, async (x) => { called = true; return x; });
  check("(4) NaN limit: resolves to an array of the right length", nanLimit.length === 3);
  check("(4) NaN limit: fn never called (treated as unusable, same as limit<=0)", called === false);
}

// ── (5) REJECTION SEMANTICS — documented on the function itself; proven here, not just asserted in prose ──
{
  const err = new Error("boom");
  let rejected;
  try {
    await mapWithConcurrency([1, 2, 3], 2, async (x) => { if (x === 2) throw err; return x; });
  } catch (e) {
    rejected = e;
  }
  check("(5) a rejected fn call propagates as mapWithConcurrency's OWN rejection, unwrapped", rejected === err);
}
{
  // Other in-flight work is NOT cancelled by a rejection — it keeps running to completion in the
  // background (plain Promise.all semantics, inherited deliberately — see the function's own doc). Proven
  // via a side effect the caller never awaits: it must still land AFTER the rejection was already handled.
  const completed = [];
  let releaseGate;
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  // card 37fe091c (round 3): wait on a hook that resolves exactly when item 2 finishes, never on a
  // fixed number of setImmediate ticks — a tick count is a guess at how many microtask turns item 2's
  // own continuation needs, and is unfalsifiable if that happens to change.
  let onItem2Done;
  const item2Done = new Promise((resolve) => { onItem2Done = resolve; });
  const run = mapWithConcurrency([1, 2], 2, async (x) => {
    if (x === 1) throw new Error("fails fast");
    await gate; // item 2 is still "in flight" when item 1's rejection is observed below
    completed.push(x);
    onItem2Done();
    return x;
  });
  let caught = false;
  try { await run; } catch { caught = true; }
  check("(5) the rejection was observed by the caller", caught === true);
  check("(5) the OTHER in-flight call has NOT completed yet at the moment of rejection", completed.length === 0);
  releaseGate();
  // Round 3 (manager CR follow-up): race item2Done against a bounded timeout that FAILS LOUDLY — if a
  // future regression ever stops item 2 from completing, this must report a clear FAIL, never hang the
  // whole suite waiting on a promise that will never resolve.
  const ITEM2_TIMEOUT_MS = 5_000;
  let item2TimedOut = false;
  await Promise.race([
    item2Done,
    new Promise((resolve) => setTimeout(() => { item2TimedOut = true; resolve(); }, ITEM2_TIMEOUT_MS)),
  ]);
  check(`(5) item 2 actually completed within ${ITEM2_TIMEOUT_MS}ms (did not time out waiting for it)`, item2TimedOut === false);
  check("(5) ...and DOES complete afterward, unobserved by the caller — proves it was never cancelled", completed.length === 1);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — mapWithConcurrency enforces its concurrency bound exactly (proven against a negative control that shows an unbounded run WOULD exceed it), preserves input order regardless of completion order, handles empty/zero-limit/NaN-limit/oversized-limit/single-item edge cases correctly, and its rejection semantics (propagate-first-error, never cancel other in-flight work) are proven, not just documented."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
