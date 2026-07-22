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

// --- onSettledAfterPending: the completion-nudge callback (card: worker_merge_confirm spin-poll fix) ---
// FAST path: op settles within waitMs → the callback must NOT fire (the caller already has the outcome
// inline; a push here would double-notify).
{
  const reg = new PendingOpRegistry();
  const calls = [];
  const r = await reg.attach("nudge:fast", "merge", "mgr1", 200, async () => ({ merged: true }), (o) => calls.push(o));
  check("(nudge fast) settles within budget as usual", r.settled === true && r.ok === true);
  check("(nudge fast) onSettledAfterPending is NEVER invoked — the sync caller already got the result inline", calls.length === 0);
}

// SLOW path: op outlives waitMs (caller told "pending") → once it later settles, the callback fires
// EXACTLY ONCE with the settled outcome, even though nobody ever re-polls.
{
  const reg = new PendingOpRegistry();
  const calls = [];
  const slow = async () => { await sleep(60); return { merged: true }; };
  const pending = await reg.attach("nudge:slow-ok", "merge", "mgr1", 10, slow, (o) => calls.push(o));
  check("(nudge slow-ok) degrades to pending first", pending.settled === false);
  check("(nudge slow-ok) callback has not fired yet — op still running", calls.length === 0);
  await sleep(100); // let the op actually settle, well past its own 60ms — nobody re-polls
  check("(nudge slow-ok) callback fired EXACTLY ONCE once the op actually terminates, with no re-poll", calls.length === 1 && calls[0].ok === true && calls[0].value.merged === true);
}

// SLOW path, FAILURE outcome (mirrors a gate-failed merge: confirmWorkerMerge doesn't throw for a gate
// failure, it just resolves with merged:false — this proves the ok:true/value shape covers that case, and
// a genuinely thrown error still surfaces via ok:false).
{
  const reg = new PendingOpRegistry();
  const calls = [];
  const slowGateFailed = async () => { await sleep(60); return { merged: false, reason: "build gate failed" }; };
  const pending = await reg.attach("nudge:slow-gate-failed", "merge", "mgr1", 10, slowGateFailed, (o) => calls.push(o));
  check("(nudge slow-gate-failed) degrades to pending first", pending.settled === false);
  await sleep(100);
  check("(nudge slow-gate-failed) callback fires once with the gate-failed result (ok:true, merged:false)", calls.length === 1 && calls[0].ok === true && calls[0].value.merged === false && calls[0].value.reason === "build gate failed");
}

// A retry's OWN callback closure is a no-op once an entry already exists — only the entry-creating call's
// callback is ever wired, so a later attach() on the same in-flight key must not cause a SECOND firing.
{
  const reg = new PendingOpRegistry();
  const calls1 = [], calls2 = [];
  const slow = async () => { await sleep(60); return { merged: true }; };
  const p1 = reg.attach("nudge:retry", "merge", "mgr1", 10, slow, (o) => calls1.push(o));
  await sleep(20);
  const p2 = reg.attach("nudge:retry", "merge", "mgr1", 10, slow, (o) => calls2.push(o)); // retry — attaches, does NOT re-register
  await Promise.all([p1, p2]);
  await sleep(80);
  check("(nudge retry) only the ORIGINAL (entry-creating) call's callback ever fires", calls1.length === 1 && calls2.length === 0);
}

// --- onSurfacedPending (card edc1ec12 — the durable-marker ORDERING guarantee): fires SYNCHRONOUSLY,
// strictly before ANY possible settle for the SAME op (see attach()'s own doc). A caller pairing "write a
// durable marker here, clear it in onSettledAfterPending" (SessionService's runWorkerGate/
// confirmWorkerMergeTracked, for the restart-orphan-signaling fix) can never observe the clear running
// before the write — even when the op settles as immediately as possible after being told "pending", the
// exact race the manager flagged as the failure mode to guard against, not just the happy "op survives a
// long time before settling" case. A manually-resolved deferred `run()` (no timer) gives exact control
// over when settle happens relative to attach() returning, mirroring the CLOBBER GUARD technique below. ---
{
  const reg = new PendingOpRegistry();
  const order = [];
  let resolveOp;
  const deferred = () => new Promise((resolve) => { resolveOp = resolve; });
  const pending = await reg.attach(
    "surf1", "gate", "mgr1", 5, deferred,
    () => order.push("settled"),
    { onSurfacedPending: () => order.push("surfaced") },
  );
  check("(onSurfacedPending) fires before attach() even returns the 'pending' result", pending.settled === false && order.length === 1 && order[0] === "surfaced");
  // Resolve as soon as possible after being told "pending" — the tightest gap a real caller could ever
  // produce between its own durable-marker write and the op's eventual settle.
  resolveOp({ ok: true });
  await sleep(10); // let the settle .then() microtask actually run
  check("(onSurfacedPending) the settled callback fires AFTER surfaced, never before — order holds even under the tightest possible race", order.length === 2 && order[0] === "surfaced" && order[1] === "settled");
}

// onSurfacedPending fires on EVERY call that observes "still pending" (idempotent by design — a
// durable-marker upsert keyed by opId is a harmless no-op on a repeat) — unlike onSettledAfterPending,
// it is NOT gated to only the entry-creating call.
{
  const reg = new PendingOpRegistry();
  let surfacedCount = 0;
  const slow = async () => { await sleep(80); return { ok: true }; };
  const p1 = reg.attach("surf2", "gate", "mgr1", 10, slow, undefined, { onSurfacedPending: () => surfacedCount++ });
  await sleep(20);
  const p2 = reg.attach("surf2", "gate", "mgr1", 10, slow, undefined, { onSurfacedPending: () => surfacedCount++ }); // re-attach, still running
  await Promise.all([p1, p2]);
  check("(onSurfacedPending repeat) fires once per call that observes 'still pending' — idempotent-upsert-friendly", surfacedCount === 2);
}

// onSurfacedPending does NOT fire on the fast path — the op already has an inline outcome, so there is
// nothing durable to mark as pending.
{
  const reg = new PendingOpRegistry();
  let surfaced = false;
  const r = await reg.attach("surf3", "gate", "mgr1", 200, async () => ({ ok: true }), undefined, { onSurfacedPending: () => { surfaced = true; } });
  check("(onSurfacedPending fast) settles within budget as usual", r.settled === true);
  check("(onSurfacedPending fast) never fires on the fast path — nothing to mark durably pending", surfaced === false);
}

// --- CLOBBER GUARD (card 27ea069e Code Review finding): evictDeadOwner() lets a fresh attach() start a
// NEW op under a key whose PRIOR op is still orphaned/in-flight in the background (unreachable, but not
// cancellable — see evictDeadOwner's doc). That prior op's EVENTUAL settle must not clobber the successor
// installed under the same key. Manually-resolved `run()`s (no timers) give exact control over which
// settles when, so this proves the identity-guarded delete rather than merely exercising a race. ---
{
  const reg = new PendingOpRegistry();
  const nudgesA = [];
  let resolveA;
  const runA = () => new Promise((resolve) => { resolveA = resolve; }); // never settles on its own — orphaned by eviction below

  const pendingA = await reg.attach("k6", "merge", "deadMgr", 10, runA, (o) => nudgesA.push(o));
  check("(clobber guard) the dead-owner op (run_A) degrades to pending", pendingA.settled === false);

  const evicted = reg.evictDeadOwner("k6");
  check("(clobber guard) evictDeadOwner removes the dead-owner entry", evicted === true);
  check("(clobber guard) peek shows nothing immediately after eviction", reg.peek("k6") === undefined);

  // A fresh attach() under the SAME key starts run_C — a genuinely new, live-owner op (mirrors
  // confirmWorkerMergeTracked's fresh confirm after evicting a dead-owner zombie). Manually-resolved,
  // same as run_A (card fea23514 de-race) — a real timer here previously self-evicted at a fixed ~30ms
  // wall-clock mark that raced the "survives" assertion below under host load; a held resolver removes
  // that race entirely instead of widening the margin.
  let runCStarted = false;
  let resolveC;
  const runC = () => { runCStarted = true; return new Promise((resolve) => { resolveC = resolve; }); }; // never settles on its own — resolved explicitly below
  const pendingC = await reg.attach("k6", "merge", "liveMgr", 10, runC);
  check("(clobber guard) run_C actually started under the same key", runCStarted === true);
  check("(clobber guard) run_C is tracked as running (the successor), NOT re-attached to run_A", pendingC.settled === false && pendingC.op.managerSessionId === "liveMgr");

  // NOW resolve the OLD orphaned run_A. Its settle callback must find a DIFFERENT entry (run_C's)
  // installed under "k6" and do NOTHING — neither deleting it nor firing run_A's own completion nudge
  // against it. THIS is the exact clobber the CR flagged: without the identity guard, this delete-by-key
  // wipes out run_C's live entry out from under it.
  resolveA({ fromA: true });
  // A fixed short delay (not a race): this attach() call passed no retainMs/onSettledAfterPending, so
  // PendingOpRegistry's settle callback for this key is plain synchronous code — no setTimeout/setImmediate
  // hop (retain()'s own timer is the only macrotask in the settle path, and it's opt-in via retainMs, which
  // this call doesn't set). Node fully drains the microtask queue — including run_A's `.then()` registered
  // inside attach() — before any timer callback fires, so any positive delay here is sufficient regardless
  // of host load; this is not competing against a moving deadline the way run_C's old internal sleep(30) was.
  await sleep(5);
  check("(clobber guard) run_C's entry SURVIVES run_A's late settle — NOT clobbered", reg.peek("k6") !== undefined && reg.peek("k6").managerSessionId === "liveMgr");
  check("(clobber guard) run_A's own completion nudge does NOT spuriously fire against the successor", nudgesA.length === 0);

  // Resolve run_C explicitly — ITS OWN settle (identity matches) correctly evicts. Same fixed-short-delay
  // reasoning as above applies here too: run_C's settle callback is equally synchronous/timer-free, so this
  // is a microtask-flush wait, not a deadline race.
  resolveC({ fromC: true });
  await sleep(5);
  check("(clobber guard) run_C's OWN settle correctly evicts once IT finishes", reg.peek("k6") === undefined);
}

// --- RETAINED TERMINAL VIEW (card d1aee5f1 follow-up — the Board merge-gate card's merged/rejected/
// failed fill): opts.retainMs keeps a settled op's terminal view peek()-able for a brief window instead
// of evicting it instantly; opts.classifyOutcome stamps a caller-chosen outcome string onto that view. ---
const classify = (outcome) => (!outcome.ok ? "failed" : outcome.value.merged ? "merged" : "rejected");

// A resolved SUCCESS (merged:true) classifies as "merged" and is peek()-able during the window, then
// expires exactly like the un-retained case once retainMs elapses.
{
  const reg = new PendingOpRegistry();
  const r = await reg.attach("m1", "merge", "mgr1", 200, async () => ({ merged: true }), undefined, { retainMs: 50, classifyOutcome: classify });
  check("(retain) the direct AttachResult is unchanged by retention/classification", r.settled === true && r.ok === true && r.value.merged === true);
  const retained = reg.peek("m1");
  check("(retain) peek() surfaces a RETAINED terminal view immediately after settle", retained !== undefined && retained.state === "done" && retained.outcome === "merged");
  // CR finding: peek() must PROJECT the retained view down to a bare PendingOpView — its internal
  // `expiresAt` bookkeeping field must never leak onto a caller-facing surface (worker_list/worker_status/
  // /api/sessions all spread this verbatim), and its shape must match a RUNNING row's exactly.
  check("(retain) the retained view's shape has NO internal 'expiresAt' field — it never leaks to callers", !("expiresAt" in retained));
  check("(retain) the retained view's keys match a plain PendingOpView (opId/kind/key/managerSessionId/startedAt/state/outcome only)",
    JSON.stringify(Object.keys(retained).sort()) === JSON.stringify(["key", "kind", "managerSessionId", "opId", "outcome", "startedAt", "state"]));
  await sleep(70); // past retainMs
  check("(retain) the retained view expires after retainMs — peek() reverts to undefined", reg.peek("m1") === undefined);
}

// A RESOLVED merge:false (a gate/stranded-work rejection — confirmWorkerMerge never throws for this)
// classifies as "rejected", not "failed" — this is the exact case that used to read as green "merged"
// via state:"done" alone before outcome existed.
{
  const reg = new PendingOpRegistry();
  await reg.attach("m2", "merge", "mgr1", 200, async () => ({ merged: false, reason: "gate failed" }), undefined, { retainMs: 50, classifyOutcome: classify });
  const retained = reg.peek("m2");
  check("(retain rejected) a resolved merged:false classifies as 'rejected' (op-state stays 'done')", retained?.outcome === "rejected" && retained.state === "done");
}

// A genuinely THROWN error classifies as "failed", with op-state "failed" too — distinct from a
// rejection (op-state "done" + outcome "rejected").
{
  const reg = new PendingOpRegistry();
  await reg.attach("m3", "merge", "mgr1", 200, async () => { throw new Error("boom"); }, undefined, { retainMs: 50, classifyOutcome: classify });
  const retained = reg.peek("m3");
  check("(retain failed) a thrown error classifies as 'failed' with op-state 'failed'", retained?.outcome === "failed" && retained.state === "failed");
}

// Without retainMs, behavior is BYTE-IDENTICAL to before this existed — evicts instantly, even if
// classifyOutcome was (harmlessly) also given.
{
  const reg = new PendingOpRegistry();
  await reg.attach("m4", "merge", "mgr1", 200, async () => ({ merged: true }), undefined, { classifyOutcome: classify });
  check("(no retainMs) a settled op still evicts immediately — no retained view without opting in", reg.peek("m4") === undefined);
}

// RETENTION-WINDOW DEDUPE (card 33172f01): a re-call landing WITHIN the retention window with NO running
// entry for the key must NOT start a fresh op — it must return the SAME cached settled outcome the first
// call produced, across all three settled shapes (merged / resolved-rejected / thrown-failed), and must
// NOT re-fire the completion-nudge callback (a within-window re-confirm on a FAILED op can't re-emit a
// duplicate [loom:merge-failed]-style push). Mirrors worker_spawn's own dedup-attach contract instead of
// racing a torn-down worktree with a second real invocation — see the class doc's "RETAINED TERMINAL VIEW"
// section.
{
  // (a) MERGED outcome: second call returns the cached value, run() invoked exactly once, no second nudge.
  const reg = new PendingOpRegistry();
  let calls = 0;
  const nudges = [];
  const r1 = await reg.attach("m5a", "merge", "mgr1", 200, async () => { calls++; return { merged: true, opId: "op-1" }; }, (o) => nudges.push(o), { retainMs: 200, classifyOutcome: classify });
  check("(retain dedupe/merged) first op ran once and settled", calls === 1 && r1.ok === true && r1.value.opId === "op-1");
  const r2 = await reg.attach("m5a", "merge", "mgr1", 200, async () => { calls++; return { merged: true, opId: "op-2" }; }, (o) => nudges.push(o), { retainMs: 200, classifyOutcome: classify });
  check("(retain dedupe/merged) re-call within the window does NOT invoke run() a second time", calls === 1);
  check("(retain dedupe/merged) re-call returns the SAME cached settled outcome (the ORIGINAL op's opId), not a fresh one", r2.settled === true && r2.ok === true && r2.value.opId === "op-1");
  check("(retain dedupe/merged) peek() still reflects the retained outcome (unaffected by the dedupe hit)", reg.peek("m5a")?.outcome === "merged");
  check("(retain dedupe/merged) the completion-nudge callback never fires at all — both calls were fast-path/short-circuit, neither was ever surfaced pending", nudges.length === 0);
}
{
  // (b) RESOLVED-REJECTED outcome (confirmWorkerMerge's gate-failed shape: resolves merged:false, doesn't throw).
  const reg = new PendingOpRegistry();
  let calls = 0;
  const r1 = await reg.attach("m5b", "merge", "mgr1", 200, async () => { calls++; return { merged: false, reason: "build gate failed", opId: "op-1" }; }, undefined, { retainMs: 200, classifyOutcome: classify });
  check("(retain dedupe/rejected) first op ran once and resolved rejected", calls === 1 && r1.ok === true && r1.value.merged === false);
  const r2 = await reg.attach("m5b", "merge", "mgr1", 200, async () => { calls++; return { merged: true, opId: "op-2" }; }, undefined, { retainMs: 200, classifyOutcome: classify });
  check("(retain dedupe/rejected) re-call within the window does NOT invoke run() a second time", calls === 1);
  check("(retain dedupe/rejected) re-call returns the SAME cached rejected outcome, not a fresh (different) one", r2.settled === true && r2.ok === true && r2.value.merged === false && r2.value.opId === "op-1");
}
{
  // (c) THROWN outcome (a genuine exception, e.g. an unexpected error mid-confirm — not a resolved rejection).
  const reg = new PendingOpRegistry();
  let calls = 0;
  const nudges = [];
  const r1 = await reg.attach("m5c", "merge", "mgr1", 200, async () => { calls++; throw new Error("boom-1"); }, (o) => nudges.push(o), { retainMs: 200, classifyOutcome: classify });
  check("(retain dedupe/failed) first op ran once and threw", calls === 1 && r1.ok === false && r1.error.message === "boom-1");
  const r2 = await reg.attach("m5c", "merge", "mgr1", 200, async () => { calls++; throw new Error("boom-2"); }, (o) => nudges.push(o), { retainMs: 200, classifyOutcome: classify });
  check("(retain dedupe/failed) re-call within the window does NOT invoke run() a second time", calls === 1);
  check("(retain dedupe/failed) re-call returns the SAME cached thrown error (identity preserved), not a fresh one", r2.settled === true && r2.ok === false && r2.error.message === "boom-1");
  check("(retain dedupe/failed) the completion-nudge callback never fires — a within-window re-confirm on a FAILED op cannot re-emit a duplicate failure nudge", nudges.length === 0);
}

// AFTER the retention window has expired, a re-call is a GENUINE fresh retry — the dedupe must be strictly
// bounded by retainMs, not permanently sticky (a real second merge attempt after the window must still work).
{
  const reg = new PendingOpRegistry();
  let calls = 0;
  await reg.attach("m5d", "merge", "mgr1", 200, async () => { calls++; return { merged: true, opId: "op-1" }; }, undefined, { retainMs: 30, classifyOutcome: classify });
  check("(retain dedupe/expired) first op ran once", calls === 1);
  await sleep(50); // past retainMs — the retained view has self-evicted
  check("(retain dedupe/expired) precondition: the retained view is gone", reg.peek("m5d") === undefined);
  const r2 = await reg.attach("m5d", "merge", "mgr1", 200, async () => { calls++; return { merged: false, reason: "y", opId: "op-2" }; }, undefined, { retainMs: 30, classifyOutcome: classify });
  check("(retain dedupe/expired) a re-call AFTER the window runs a genuinely FRESH op", calls === 2 && r2.settled === true && r2.value.opId === "op-2");
}

// opts.bypassRetained (CR BLOCKER 1, card 33172f01): an explicit one-shot escalation (mirrors
// confirmWorkerMergeTracked's forceRemoveWorktree) must NEVER be served from the retained cache — the
// caller's own forceful args would otherwise be silently swallowed by an EARLIER, non-forced call's cached
// result. Also proves the cache write on the forced call's OWN settle is unaffected: a THIRD, non-forced
// call right after still correctly dedupe-hits the fresh (forced) outcome, not the stale pre-force one.
{
  const reg = new PendingOpRegistry();
  let calls = 0;
  const r1 = await reg.attach("m5e", "merge", "mgr1", 200, async () => { calls++; return { merged: true, opId: "op-1", warning: "nested repo — re-run with forceRemoveWorktree" }; }, undefined, { retainMs: 200, classifyOutcome: classify });
  check("(bypassRetained) first (unforced) op ran once, carries the warning", calls === 1 && r1.value.warning !== undefined);
  // A plain re-call within the window would normally dedupe-hit — confirm that's still true WITHOUT the flag.
  const rPlain = await reg.attach("m5e", "merge", "mgr1", 200, async () => { calls++; return { merged: true, opId: "op-plain" }; }, undefined, { retainMs: 200, classifyOutcome: classify });
  check("(bypassRetained) precondition: an UNFLAGGED re-call still dedupe-hits (does not itself re-run)", calls === 1 && rPlain.value.opId === "op-1");
  // NOW the caller re-confirms WITH the force flag, still well within the original window.
  const rForced = await reg.attach("m5e", "merge", "mgr1", 200, async () => { calls++; return { merged: true, opId: "op-2", warning: undefined }; }, undefined, { retainMs: 200, classifyOutcome: classify, bypassRetained: true });
  check("(bypassRetained) a FORCED re-call within the window DOES invoke run() again — the cache is bypassed, not read", calls === 2 && rForced.value.opId === "op-2");
  check("(bypassRetained) the forced call's own fresh result is what comes back, not the stale cached one", rForced.value.warning === undefined);
  // A subsequent NON-forced call dedupes against the FRESH (forced) outcome — the forced call's own settle
  // still writes the cache (bypassRetained only gates the READ), so this must NOT see the stale op-1 view.
  const rAfter = await reg.attach("m5e", "merge", "mgr1", 200, async () => { calls++; return { merged: true, opId: "op-3" }; }, undefined, { retainMs: 200, classifyOutcome: classify });
  check("(bypassRetained) a later unflagged call dedupes against the NEW cached (forced) result, not the stale pre-force one", calls === 2 && rAfter.value.opId === "op-2");
}

// TTL IS NOT REFRESHED BY A DEDUPE HIT (card 33172f01): repeatedly re-confirming within the window must
// not extend the retained view's lifetime — it's anchored to the ORIGINAL settle, not to the most recent
// re-confirm. (This replaces the old "two real settled ops race each other's cleanup timer" clobber test:
// under NORMAL scheduling that scenario is no longer reachable through attach()'s public API via a
// same-tick re-confirm — by construction of the dedupe check above, a SECOND real op for a given key can
// only start once the first's retained view has expired via `Date.now() >= expiresAt`. It is NOT provably
// unreachable in general, though: `attach()`'s own expiry check races the SAME clock the cleanup timer in
// `retain()` uses, and under real event-loop congestion (documented ~500ms+ blocking on synchronous SQLite
// handlers under load — see the platform escalation this project tracks) a call landing in that narrow
// skew window could still see `Date.now() >= expiresAt` true while the timer hasn't fired yet, starting a
// genuinely fresh op while the old retained entry is still technically present — so `retain()`'s identity
// guard on its OWN cleanup timer stays load-bearing defense-in-depth, not dead code to delete just because
// no test currently drives its false branch. The `entries`-map clobber guard above — evictDeadOwner()
// freeing a key while an orphaned RUNNING op is still executing in the background — is a distinct scenario
// and is unaffected by this change.)
{
  const reg = new PendingOpRegistry();
  await reg.attach("m6", "merge", "mgr1", 200, async () => ({ merged: true, opId: "op-1" }), undefined, { retainMs: 40, classifyOutcome: classify });
  check("(retain ttl) retained view present after the first settle", reg.peek("m6")?.outcome === "merged");
  await sleep(20); // still within the original 40ms window
  const r2 = await reg.attach("m6", "merge", "mgr1", 200, async () => ({ merged: false, reason: "y", opId: "op-2" }), undefined, { retainMs: 40, classifyOutcome: classify });
  check("(retain ttl) the re-confirm at t=20ms dedupe-hits the cached op-1 result", r2.value.opId === "op-1");
  await sleep(25); // t=45ms total — past the ORIGINAL 40ms window (would still be live if the dedupe hit had refreshed the TTL)
  check("(retain ttl) the retained view is gone — its lifetime was anchored to the ORIGINAL settle, not extended by the re-confirm", reg.peek("m6") === undefined);
  let calls = 0;
  const r3 = await reg.attach("m6", "merge", "mgr1", 200, async () => { calls++; return { merged: true, opId: "op-3" }; }, undefined, { retainMs: 40, classifyOutcome: classify });
  check("(retain ttl) a call after expiry runs a genuinely FRESH op, unaffected by the earlier dedupe hits", calls === 1 && r3.value.opId === "op-3");
}

console.log(failures === 0
  ? "\n✅ ALL PASS — PendingOpRegistry: fast ops resolve synchronously (today's shape), slow ops degrade to a pending handle, a retry (sequential OR genuinely concurrent) attaches to the SAME in-flight op (run() invoked exactly once), a settled op is EVICTED the moment it settles (no stale placeholder, no leak, a failed slow op is retrievable rather than stuck 'running' forever), error identity (subclass + fields) survives the settle path, onSettledAfterPending pushes a completion callback exactly once for a genuinely-pending op (never for the fast path, never twice on retry), onSurfacedPending (card edc1ec12) fires synchronously and strictly BEFORE any possible settle for the same op — even under the tightest possible race — fires once per call that observes 'still pending', and never fires on the fast path, an orphaned op evicted by evictDeadOwner() can never clobber the successor started under its old key when its own late settle eventually fires, opts.retainMs/classifyOutcome retain+classify a settled op's terminal view for a brief window (distinguishing a resolved rejection from a thrown failure), card 33172f01: a re-call landing WITHIN that window (merged, resolved-rejected, or thrown-failed) dedupe-attaches to the cached outcome instead of starting a second real op or re-firing the completion nudge, strictly bounded by retainMs (never refreshed by a dedupe hit) so a genuine retry after the window still runs for real, and opts.bypassRetained lets an explicit one-shot escalation always run for real (never served from cache) while still updating the cache for later unflagged callers."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
