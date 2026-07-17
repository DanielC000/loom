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
  // confirmWorkerMergeTracked's fresh confirm after evicting a dead-owner zombie).
  let runCStarted = false;
  const runC = async () => { runCStarted = true; await sleep(30); return { fromC: true }; };
  const pendingC = await reg.attach("k6", "merge", "liveMgr", 10, runC);
  check("(clobber guard) run_C actually started under the same key", runCStarted === true);
  check("(clobber guard) run_C is tracked as running (the successor), NOT re-attached to run_A", pendingC.settled === false && pendingC.op.managerSessionId === "liveMgr");

  // NOW resolve the OLD orphaned run_A. Its settle callback must find a DIFFERENT entry (run_C's)
  // installed under "k6" and do NOTHING — neither deleting it nor firing run_A's own completion nudge
  // against it. THIS is the exact clobber the CR flagged: without the identity guard, this delete-by-key
  // wipes out run_C's live entry out from under it.
  resolveA({ fromA: true });
  await sleep(5); // let run_A's .then() microtask actually run
  check("(clobber guard) run_C's entry SURVIVES run_A's late settle — NOT clobbered", reg.peek("k6") !== undefined && reg.peek("k6").managerSessionId === "liveMgr");
  check("(clobber guard) run_A's own completion nudge does NOT spuriously fire against the successor", nudgesA.length === 0);

  // Let run_C itself actually settle — ITS OWN settle (identity matches) correctly evicts.
  await sleep(40);
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

// A fresh attach() on the SAME key WHILE a retained view is still live must start a genuinely NEW op —
// retention is a read-only side channel for surfacing, never a dedup source for attach()'s own logic.
{
  const reg = new PendingOpRegistry();
  let calls = 0;
  await reg.attach("m5", "merge", "mgr1", 200, async () => { calls++; return { merged: true }; }, undefined, { retainMs: 200, classifyOutcome: classify });
  check("(retain) first op ran once", calls === 1 && reg.peek("m5")?.outcome === "merged");
  const r2 = await reg.attach("m5", "merge", "mgr1", 200, async () => { calls++; return { merged: false, reason: "x" }; }, undefined, { retainMs: 200, classifyOutcome: classify });
  check("(retain) a re-confirm during the retention window starts a FRESH op, not a dedup-attach to the stale result", calls === 2 && r2.settled === true && r2.ok === true && r2.value.merged === false);
  check("(retain) peek() now reflects the NEW op's retained outcome, replacing the old one", reg.peek("m5")?.outcome === "rejected");
}

// CLOBBER GUARD (retained-cache variant): op A's own delayed cleanup timer must NOT delete a NEWER
// retained view op B wrote under the same key before A's timer fires — mirrors the `entries`-map clobber
// guard above, but for the separate `retained` side channel.
{
  const reg = new PendingOpRegistry();
  await reg.attach("m6", "merge", "mgr1", 200, async () => ({ merged: true }), undefined, { retainMs: 30, classifyOutcome: classify });
  check("(retain clobber) op A's retained view present", reg.peek("m6")?.outcome === "merged");
  await sleep(10); // op A's 30ms cleanup timer has NOT fired yet
  await reg.attach("m6", "merge", "mgr1", 200, async () => ({ merged: false, reason: "y" }), undefined, { retainMs: 200, classifyOutcome: classify });
  check("(retain clobber) op B's retained view replaces op A's", reg.peek("m6")?.outcome === "rejected");
  await sleep(40); // op A's cleanup timer (fires ~30ms after A settled) has now long since fired
  check("(retain clobber) op A's stale cleanup timer did NOT delete op B's still-live retained view", reg.peek("m6")?.outcome === "rejected");
}

console.log(failures === 0
  ? "\n✅ ALL PASS — PendingOpRegistry: fast ops resolve synchronously (today's shape), slow ops degrade to a pending handle, a retry (sequential OR genuinely concurrent) attaches to the SAME in-flight op (run() invoked exactly once), a settled op is EVICTED the moment it settles (no stale placeholder, no leak, a failed slow op is retrievable rather than stuck 'running' forever), error identity (subclass + fields) survives the settle path, onSettledAfterPending pushes a completion callback exactly once for a genuinely-pending op (never for the fast path, never twice on retry), an orphaned op evicted by evictDeadOwner() can never clobber the successor started under its old key when its own late settle eventually fires, and opts.retainMs/classifyOutcome retain+classify a settled op's terminal view for a brief window (distinguishing a resolved rejection from a thrown failure) without ever letting retention interfere with attach()'s own dedup/clobber-guard logic."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
