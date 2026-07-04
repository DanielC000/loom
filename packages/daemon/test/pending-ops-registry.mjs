// PendingOpRegistry unit test (card fb8df559 Part 1, Auditor finding b9515beb). HERMETIC: pure
// in-memory logic, NO daemon, NO git, NO spawn — drives orchestration/pending-ops.js directly with
// synthetic `run()` closures on tiny (ms-scale) wait budgets, so the fast/slow/retry/consume-once/
// evict-on-settle matrix runs in well under a second instead of waiting on the real
// SYNC_ATTACH_BUDGET_MS (12s).
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/pending-ops-registry.mjs
import { PendingOpRegistry } from "../dist/orchestration/pending-ops.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- fast path: run() settles WITHIN waitMs → consumed + returned immediately, no pending handle ---
{
  const reg = new PendingOpRegistry();
  const r = await reg.attach("k1", "spawn", "mgr1", 200, async () => ({ hello: "world" }));
  check("(fast) settles within budget → {settled:true, ok:true, value}", r.settled === true && r.ok === true && r.value.hello === "world");
  check("(fast) consumed — no longer tracked after the call that got the result", reg.peek("k1") === undefined);
}

// --- fast-path failure: run() rejects within waitMs → {settled:true, ok:false, error} with IDENTITY preserved ---
{
  class MarkerError extends Error { constructor(m) { super(m); this.marker = true; this.retryAfter = "2099-01-01T00:00:00.000Z"; } }
  const reg = new PendingOpRegistry();
  const r = await reg.attach("k1", "merge", "mgr1", 200, async () => { throw new MarkerError("nope"); });
  check("(fast fail) settles with ok:false", r.settled === true && r.ok === false);
  check("(fast fail) the RAW error object survives (not stringified) — subclass identity preserved", r.error instanceof MarkerError && r.error.marker === true);
  check("(fast fail) a typed field on the error (e.g. retryAfter) survives too", r.error.retryAfter === "2099-01-01T00:00:00.000Z");
}

// --- slow path: run() outlives waitMs → {settled:false, op} instead of throwing or blocking forever ---
{
  const reg = new PendingOpRegistry();
  let calls = 0;
  const slow = async () => { calls++; await sleep(150); return { done: true }; };
  const r1 = await reg.attach("k2", "spawn", "mgr1", 20, slow); // waitMs << the op's real duration
  check("(slow) still running past the wait budget → {settled:false, op}", r1.settled === false && r1.op.state === "running");
  check("(slow) the pending op's kind/key are surfaced", r1.op.kind === "spawn" && r1.op.key === "k2");

  // --- idempotent retry WHILE running (SEQUENTIAL): attaches to the SAME op, does NOT invoke run() again ---
  const r2 = await reg.attach("k2", "spawn", "mgr1", 20, slow); // a RETRY with a fresh (unused) `slow`
  check("(retry while running) returns the SAME opId — attached, not a second op", r2.settled === false && r2.op.opId === r1.op.opId);
  check("(retry while running) run() was NOT invoked a second time", calls === 1);

  // A THIRD call, given enough budget to actually observe the real settle this time:
  const r3 = await reg.attach("k2", "spawn", "mgr1", 500, async () => { calls++; return { should: "not run" }; });
  check("(settle) eventually resolves to the ORIGINAL op's result, not the third call's closure", r3.settled === true && r3.ok === true && r3.value.done === true);
  check("(settle) run() ran EXACTLY ONCE total across all three attach() calls", calls === 1);
  check("(consume-once) settled result is gone after being served", reg.peek("k2") === undefined);
}

// --- genuinely CONCURRENT retry-attach: Promise.all of two attach() calls with NO await between them ---
// (the sequential case above proves attach-while-running across separate turns; this proves the SAME
// no-await synchronous-registration window the ATOMICITY PROOF in service.ts relies on — see
// merge-spawn-tracked.mjs for the same invariant proven against REAL spawnWorker/confirmWorkerMerge.)
{
  const reg = new PendingOpRegistry();
  let calls = 0;
  const slow = async () => { calls++; await sleep(50); return { concurrent: true }; };
  const p1 = reg.attach("k3", "merge", "mgr1", 500, slow);
  const p2 = reg.attach("k3", "merge", "mgr1", 500, slow); // fired before p1 is awaited — no interleaving gap
  const [r1, r2] = await Promise.all([p1, p2]);
  check("(concurrent) run() was invoked EXACTLY ONCE despite two unawaited concurrent attach() calls", calls === 1);
  check("(concurrent) BOTH callers settle successfully with the SAME result", r1.settled && r1.ok && r2.settled && r2.ok && r1.value.concurrent === true && r2.value.concurrent === true);
}

// --- EVICT-ON-SETTLE: a settled op is removed the MOMENT it settles, not merely once consumed — so
// surfacing (peek/listByManager) never shows a stale "still running" op after the fact ---
{
  const reg = new PendingOpRegistry();
  const slow = async () => { await sleep(50); return { ok: true }; };
  const p = reg.attach("k4", "merge", "mgr1", 10_000, slow); // ample budget — this call will observe settle itself
  await sleep(10); // still running
  check("(evict-on-settle) peek shows it WHILE running", reg.peek("k4") !== undefined && reg.peek("k4").state === "running");
  await p; // let it settle (evicts inside the settle callback, independent of this awaiter)
  check("(evict-on-settle) peek shows NOTHING immediately after settle — no stale 'running' op lingers", reg.peek("k4") === undefined);
}

// --- a FAILED slow op is retrievable via a later call, NOT a perpetual placeholder ---
{
  const reg = new PendingOpRegistry();
  let calls = 0;
  const slowFail = async () => { calls++; await sleep(30); throw new Error("boom"); };
  const r1 = await reg.attach("k5", "spawn", "mgr1", 10, slowFail);
  check("(failed slow) still running past the short wait budget", r1.settled === false);
  await sleep(40); // let it fail for real
  check("(failed slow) once failed, it is EVICTED — not stuck showing 'running' forever", reg.peek("k5") === undefined);
  const r2 = await reg.attach("k5", "spawn", "mgr1", 100, slowFail); // "re-call" after the fact — ample budget to observe ITS OWN settle
  check("(failed slow) a later call sees NO tracked entry (not a stuck pending) and re-runs for a fresh answer", r2.settled === true && r2.ok === false);
  check("(failed slow) the re-run is a GENUINELY fresh op (calls() incremented) — this is the documented post-eviction re-invoke, not a bug", calls === 2);
}

// --- listByManager: pending-spawn placeholder surfacing, scoped per manager, RUNNING-ONLY ---
{
  const reg = new PendingOpRegistry();
  const neverSettle = () => new Promise(() => {});
  void reg.attach("spawn:t1", "spawn", "mgrA", 10, neverSettle);
  void reg.attach("spawn:t2", "spawn", "mgrA", 10, neverSettle);
  void reg.attach("spawn:t3", "spawn", "mgrB", 10, neverSettle);
  const settled = reg.attach("spawn:t4", "spawn", "mgrA", 10_000, async () => ({ landed: true })); // will settle fast
  await sleep(30); // let the never-settling three register + hit their deadlines, and t4 to actually settle
  await settled;
  const forA = reg.listByManager("mgrA", "spawn");
  const forB = reg.listByManager("mgrB", "spawn");
  check("(listByManager) scoped to the requesting manager only", forA.length === 2 && forB.length === 1);
  check("(listByManager) never consumes — a later peek still finds a genuinely running one", reg.peek("spawn:t1") !== undefined);
  check("(listByManager) a SETTLED op does NOT appear — no duplicate/stale placeholder once it landed", !forA.some((op) => op.key === "spawn:t4"));
}

console.log(failures === 0
  ? "\n✅ ALL PASS — PendingOpRegistry: fast ops resolve synchronously (today's shape), slow ops degrade to a pending handle, a retry (sequential OR genuinely concurrent) attaches to the SAME in-flight op (run() invoked exactly once), a settled op is EVICTED the moment it settles (no stale placeholder, no leak, a failed slow op is retrievable rather than stuck 'running' forever), and error identity (subclass + fields) survives the settle path."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
