// Card 6d484a46: bounds concurrent OS process-enumeration helper spawns (checkRootSurvival /
// reapOrphanedDescendants) across every session kill/exit path via a small, shared EnumerationSemaphore.
// See docs/decisions/6d484a46-root-reap-enumeration-concurrency-limiter.md for the full design + the
// verified "never escalates on unreadable" / "delayed sweep still can't kill a stranger" / "can't stall
// shutdown" findings, PLUS Round 2 (CR ab171b39): a hung-enumerator slot-leak fix (scenario H), a
// synchronous-throw unhandled-rejection fix (scenario I), and the fixes nitpicks below (G relabeled +
// strengthened, unnecessary sleep(10) pacing waits removed).
//
// Fixed env BEFORE importing dist (read once at module load) — concurrency=2, queueTimeout=250ms — every
// scenario below is tuned against this ONE fixed configuration so no scenario needs a fresh module
// instance. No real process spawn anywhere in this file: every scenario drives `checkRootSurvival`'s own
// `enumerate` param or `reapOrphanedDescendants`'s own `deps.enumerate` seam with a controllable fake.
process.env.LOOM_ROOT_REAP_ENUMERATION_CONCURRENCY = "2";
process.env.LOOM_ROOT_REAP_ENUMERATION_QUEUE_TIMEOUT_MS = "250";
// Derived from the SAME env value above, never a second hardcoded "2" — see `assertPoolFullyFree`'s
// own doc for why this exact cap matters (CR bc3a1445).
const CAP = Number(process.env.LOOM_ROOT_REAP_ENUMERATION_CONCURRENCY);

import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmpHome = path.join(os.tmpdir(), `loom-reap-enum-concurrency-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { checkRootSurvival, reapOrphanedDescendants } = await import("../dist/pty/host.js");

// @decision 8c8ee0ee — the real reaper's own test tripwire refuses a fabricated rootPid that was never
// (a) actually spawned by this process or (b) registered as dead-by-this-process — use a PID provably
// impossible on every OS (odd, > Linux's pid_max 2^22), and register each one as a "dead, ours" hit via
// the SAME globalThis registry `test/_guard.mjs` populates for a real spawn, mirroring the project's own
// documented pattern for a fabricated-row scenario (85ae7768's own "set the registry directly" note).
const SAFE_PID_BASE = 2_147_480_001;
check("[safety] SAFE_PID_BASE is a provably-impossible pid (odd, > Linux pid_max 2^22)",
  SAFE_PID_BASE % 4 !== 0 && SAFE_PID_BASE > 4_194_304);
let pidOffset = 0;
function freshPid() {
  const pid = SAFE_PID_BASE + pidOffset * 2; // stays odd — BASE is odd, increment is always even
  pidOffset++;
  globalThis.__LOOM_TEST_SPAWNED_PIDS__?.add(pid);
  return pid;
}

// A controllable fake enumerator: tracks in-flight concurrency and settles after `delayMs`.
function makeTrackedEnumerate(delayMs, { shouldReject = false } = {}) {
  const state = { inFlight: 0, maxInFlight: 0, totalCalls: 0 };
  const enumerate = async () => {
    state.inFlight++; state.totalCalls++;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    await sleep(delayMs);
    state.inFlight--;
    if (shouldReject) throw new Error("simulated enumeration failure");
    return [];
  };
  return { enumerate, state };
}

// CR bc3a1445 (re-CR on ab171b39's own fix): a bare "one following call is granted" check CANNOT
// detect a leaked slot when cap > 1 — with cap=2, a single leaked (never-released) slot still
// leaves `running` at 1, and `running(1) < max(2)` STILL takes the fast path for one more caller,
// indistinguishable from the healthy case. Proven by the reviewer with two dist mutations (drop
// `releaseOnce()` in `reapOrphanedDescendants`'s catch; make `checkRootSurvival`'s `finally` only
// release conditionally) that both stayed ALL PASS against the single-follow-up check. The REAL
// discriminator: dispatch exactly `CAP` tracked holders and assert they all enter CONCURRENTLY
// (`maxInFlight === CAP`) — this is only possible if `running` genuinely returned to 0. A leaked
// slot caps true concurrent admission at `CAP - leaked`, which this assertion catches directly
// (verified below, scenarios H/I's own RED proof against the reviewer's exact mutations).
async function assertPoolFullyFree(label) {
  const { enumerate, state } = makeTrackedEnumerate(80);
  await Promise.all(Array.from({ length: CAP }, (_, i) => checkRootSurvival(freshPid(), `sid-pool-free-${label}`, 5000, enumerate)));
  check(`(${label}) the pool is FULLY free afterward — ${CAP} tracked holders all ran CONCURRENTLY (maxInFlight===${CAP}, not just >=1 free)`,
    state.maxInFlight === CAP);
  check(`(${label}) both pool-free probe calls actually ran`, state.totalCalls === CAP);
}

// =============================================================================================
// (A) checkRootSurvival: N=6 concurrent calls with an 80ms fake enumerator — max-in-flight must
//     never exceed the configured cap (2).
// =============================================================================================
{
  const { enumerate, state } = makeTrackedEnumerate(80);
  const N = 6;
  await Promise.all(Array.from({ length: N }, () => checkRootSurvival(freshPid(), "sid-a", 5000, enumerate)));
  check("(A) checkRootSurvival bounds concurrency at the configured cap (2)", state.maxInFlight <= 2);
  check("(A) all 6 calls actually ran", state.totalCalls === N);

  // NEGATIVE CONTROL: call the SAME fake enumerator directly, bypassing checkRootSurvival (and so the
  // semaphore) entirely — proves the instrument CAN detect a violation; it is not vacuously bounded by
  // something else (e.g. Node's own concurrency limits).
  const { enumerate: bypassEnumerate, state: bypassState } = makeTrackedEnumerate(80);
  await Promise.all(Array.from({ length: N }, () => bypassEnumerate()));
  check("(A negative control) bypassing checkRootSurvival reaches the full N=6 unbounded", bypassState.maxInFlight === N);
}

// =============================================================================================
// (B) checkRootSurvival: two SLOW (500ms) holders saturate the cap (2); a third call must queue
//     and its wait (>250ms configured timeout) must exceed the bound — assert it fails CLOSED
//     (enumerationFailed:true, foundAlive:false), never a false "dead"/"confirmed gone".
// =============================================================================================
{
  // No pacing wait needed between dispatching the two holders and the third call below: `acquire()`'s
  // fast path increments `running` SYNCHRONOUSLY the instant it's called (no microtask/macrotask gap),
  // so by the time `checkRootSurvival(...)` for holderB has even RETURNED (a pending promise), both
  // slots are already taken — dispatching the third call immediately still correctly observes a
  // saturated pool (CR ab171b39 nitpick: an earlier draft inserted a `sleep(10)` here on the false
  // premise that the acquire needed time to "land").
  const { enumerate: slow } = makeTrackedEnumerate(500);
  const holderA = checkRootSurvival(freshPid(), "sid-b", 5000, slow);
  const holderB = checkRootSurvival(freshPid(), "sid-b", 5000, slow);
  const queuedResult = await checkRootSurvival(freshPid(), "sid-b-queued", 5000, slow);
  check("(B) a queue-wait timeout reports enumerationFailed:true (fail-closed)", queuedResult.enumerationFailed === true);
  check("(B) a queue-wait timeout reports foundAlive:false (never a false 'dead'/'confirmed gone' shape)", queuedResult.foundAlive === false);
  check("(B) a queue-wait timeout reports identityConfirmed:false", queuedResult.identityConfirmed === false);
  await Promise.all([holderA, holderB]); // drain the two slow holders before moving on
}

// =============================================================================================
// (C) NEGATIVE CONTROL for (B): same cap/timeout, but FAST (20ms) enumerators — the third call's
//     queue-wait stays well under 250ms, so it must resolve NORMALLY (enumerationFailed:false) —
//     proves the timeout mechanism doesn't fire spuriously under ordinary (non-overloaded) load.
// =============================================================================================
{
  const { enumerate: fast } = makeTrackedEnumerate(20);
  const [r1, r2, r3] = await Promise.all([
    checkRootSurvival(freshPid(), "sid-c", 5000, fast),
    checkRootSurvival(freshPid(), "sid-c", 5000, fast),
    checkRootSurvival(freshPid(), "sid-c", 5000, fast),
  ]);
  check("(C) a fast, non-overloaded queue-wait never times out (call 1)", r1.enumerationFailed === false);
  check("(C) a fast, non-overloaded queue-wait never times out (call 2)", r2.enumerationFailed === false);
  check("(C) a fast, non-overloaded queue-wait never times out (call 3, the one that had to queue)", r3.enumerationFailed === false);
}

// =============================================================================================
// (D) cross-function: checkRootSurvival and reapOrphanedDescendants share ONE pool. Saturate the
//     cap (2) with ONE holder of EACH kind (so BOTH functions are proven to draw from the SAME
//     pool, not just their own), then a THIRD call (checkRootSurvival, fast) must queue behind
//     them — proven by ORDER OF COMPLETION (never a timing threshold): its own fake enumerate
//     cannot possibly run before a slot frees, since the pool is saturated at the moment it's
//     dispatched. This is the card's own "2-3 enumerations per exit, one shared pool" fan-out,
//     reduced to its essence: one call of each kind is enough to prove sharing; a REAL
//     `reapOrphanedDescendants` call pays a real, synchronous ~550-620ms test-tripwire spawn
//     (`assertReapTargetIsOwnLiveDescendantUnderTest`) before it ever reaches the semaphore, so
//     this scenario deliberately uses ONLY ONE such call — a tight multi-call race here would be
//     fighting that real, unavoidable overhead rather than testing this card's own mechanism.
// =============================================================================================
{
  const completionOrder = [];
  const HOLDER_DELAY = 50; // comfortably under the 250ms queue timeout once each holder's real
                           // async work finally starts (see this file's own header: nothing async
                           // can progress until reapOrphanedDescendants's synchronous tripwire spawn
                           // — dispatched with NO yield in between — fully returns).
  const holderA = checkRootSurvival(freshPid(), "sid-d-holder", 5000, async () => {
    // TIMING-GUARD-SAFE: fully-awaited-completion — HOLDER_DELAY is the mocked subject's own scripted
    // latency, not a wait inserted to gate a check; `completionOrder.push(...)` runs SYNCHRONOUSLY the
    // instant this sleep genuinely resolves, and the checks below run only after `Promise.all` has
    // fully awaited every one of these promises to real completion — never a guess based on elapsed time.
    await sleep(HOLDER_DELAY); completionOrder.push("holderA(checkRootSurvival)"); return [];
  });
  const holderB = new Promise((resolve) => {
    reapOrphanedDescendants(freshPid(), null, {
      // TIMING-GUARD-SAFE: fully-awaited-completion — same reasoning as holderA above: HOLDER_DELAY is
      // the mocked subject's own scripted latency (the reapOrphanedDescendants counterpart, its own
      // `enumerate` seam), gated by the SAME fully-awaited Promise.all below.
      enumerate: async () => { await sleep(HOLDER_DELAY); completionOrder.push("holderB(reapOrphanedDescendants)"); resolve(); return []; },
      kill: () => {},
    });
  });
  // No pacing wait needed here either (see (B)'s own comment above) — by the time holderB's dispatch
  // call returns (after its own real tripwire spawn + its synchronous acquire()), the pool is already
  // saturated; dispatching the third call immediately still correctly observes that.
  const thirdCallDone = checkRootSurvival(freshPid(), "sid-d-third", 5000, async () => {
    completionOrder.push("thirdCall(checkRootSurvival)"); return [];
  });
  await Promise.all([holderA, holderB, thirdCallDone]);
  const thirdIdx = completionOrder.indexOf("thirdCall(checkRootSurvival)");
  const holderAIdx = completionOrder.indexOf("holderA(checkRootSurvival)");
  const holderBIdx = completionOrder.indexOf("holderB(reapOrphanedDescendants)");
  // With cap=2 and BOTH slots held, the third call can only ever start once AT LEAST ONE holder
  // releases (not necessarily both — the other may still be running concurrently with it) — this
  // is the exact, provable claim; asserting "after BOTH" would be wrong whenever only one holder
  // happens to release first.
  check("(D) the third call ran only AFTER at least one holder released its slot (never immediately)",
    thirdIdx > holderAIdx || thirdIdx > holderBIdx);
  check("(D) all three calls actually completed", holderAIdx !== -1 && holderBIdx !== -1 && thirdIdx !== -1);

  // NEGATIVE CONTROL: with only ONE holder (so the pool is NOT saturated — one slot stays free),
  // a fourth call must run IMMEDIATELY, BEFORE the one holder releases — proving the "ran only
  // after a release" check above has real discriminating power (it would correctly report FALSE
  // here) rather than being vacuously true for any ordering.
  const soloOrder = [];
  const soloHolder = checkRootSurvival(freshPid(), "sid-d-solo-holder", 5000, async () => {
    // TIMING-GUARD-SAFE: fully-awaited-completion — same reasoning as holderA/holderB above:
    // HOLDER_DELAY is the mocked subject's own scripted latency, and the check below is gated by the
    // fully-awaited Promise.all right after, never by this sleep's own duration.
    await sleep(HOLDER_DELAY); soloOrder.push("soloHolder"); return [];
  });
  const freeCallDone = checkRootSurvival(freshPid(), "sid-d-free", 5000, async () => {
    soloOrder.push("freeCall"); return [];
  });
  await Promise.all([soloHolder, freeCallDone]);
  check("(D negative control) with the pool NOT saturated, the free call runs BEFORE the lone holder releases",
    soloOrder.indexOf("freeCall") < soloOrder.indexOf("soloHolder"));
}

// =============================================================================================
// (G) a sweep FORCED TO ACTUALLY QUEUE (proven via completion order, not just hoped for) with a
//     stale-ppid row is still skipped, never killed — proves 85ae7768's own creation-time filter
//     stays correct no matter how long the queue wait before the snapshot was actually taken
//     (point 2 of the LEAD's review). RELABELED (CR ab171b39 nitpick): this does NOT itself prove
//     the limiter caused a delay — round 1's own RED proof showed it stayed green with the limiter
//     fully bypassed, since the filter's correctness is independent of timing. What it DOES need to
//     prove, and now does, is that the sweep's own enumeration genuinely ran only once a slot freed
//     — not merely that the filter is correct in isolation.
// =============================================================================================
{
  const rootPid = freshPid();
  const rootCreationTimeSim = 1_000_000;
  const staleChildPid = freshPid();
  const staleChildRow = { pid: staleChildPid, ppid: rootPid, creationTime: rootCreationTimeSim - 10_000 }; // predates the root — stale
  const genuineChildPid = freshPid();
  const genuineChildRow = { pid: genuineChildPid, ppid: rootPid, creationTime: rootCreationTimeSim + 10_000 }; // postdates the root — genuine

  const capturedLines = [];
  const origLog = console.log;
  console.log = (...args) => { capturedLines.push(args.join(" ")); origLog(...args); };

  try {
    const completionOrder = [];
    // Saturate the pool (cap=2) with two holders (no pacing wait needed — see (B)'s own comment) so the
    // sweep below is FORCED to queue; it must still be granted well within the 250ms queue timeout once
    // a holder releases.
    const holderA = checkRootSurvival(freshPid(), "sid-g-holder", 5000, async () => {
      // TIMING-GUARD-SAFE: fully-awaited-completion — same reasoning as (D)'s holders: this is the
      // mocked subject's own scripted latency, and the checks below are gated by the fully-awaited
      // `waitUntil`/`Promise.all` further down, never by this sleep's own duration.
      await sleep(150); completionOrder.push("holderA"); return [];
    });
    const holderB = checkRootSurvival(freshPid(), "sid-g-holder", 5000, async () => {
      // TIMING-GUARD-SAFE: fully-awaited-completion — same reasoning as holderA immediately above.
      await sleep(150); completionOrder.push("holderB"); return [];
    });

    const killedPids = [];
    reapOrphanedDescendants(rootPid, rootCreationTimeSim, {
      enumerate: async () => { completionOrder.push("sweepEnumerate"); return [staleChildRow, genuineChildRow]; },
      kill: (pid) => { killedPids.push(pid); },
    });
    await waitUntil(
      () => capturedLines.some((l) => l.includes(`[pty-reap] root=${rootPid}:`) && l.includes("found=")),
      { timeoutMs: 3000, label: "(G) the delayed sweep's own 'found=' log line" },
    );
    await Promise.all([holderA, holderB]);

    const sweepIdx = completionOrder.indexOf("sweepEnumerate");
    check("(G) the sweep actually QUEUED — its own enumerate ran only after at least one holder released",
      sweepIdx > completionOrder.indexOf("holderA") || sweepIdx > completionOrder.indexOf("holderB"));
    check("(G) a delayed sweep still SKIPS a stale-ppid row (never killed)", !killedPids.includes(staleChildPid));
    check("(G) a delayed sweep still KILLS a genuine child row", killedPids.includes(genuineChildPid));
    check("(G) the sweep's own log line reports skippedStale=1", capturedLines.some((l) => l.includes(`[pty-reap] root=${rootPid}:`) && l.includes("skippedStale=1")));
  } finally {
    console.log = origLog;
  }
}

// =============================================================================================
// (H) CR ab171b39 MAJOR fix: an injected enumerator that NEVER settles (simulates a hung POSIX
//     `/proc` read, which has no timer of its own) must not hold the semaphore slot forever — the
//     NEW `withReapTimeout` wrap around `enumerateWithRetry` bounds the whole call, so the slot
//     frees within the budget regardless of what the underlying (now-orphaned) enumerator does.
//     A custom, small `timeoutMs` keeps this test fast: totalBudgetMs = 2*100 + 500 = 700ms.
// =============================================================================================
{
  const neverSettles = () => new Promise(() => { /* deliberately never resolves or rejects */ });
  const hungResult = await checkRootSurvival(freshPid(), "sid-h-hung", 100, neverSettles);
  check("(H) a never-settling enumerator still resolves (fails closed) within the total budget",
    hungResult.enumerationFailed === true && hungResult.foundAlive === false);

  // The pool must be FULLY free afterward, not just "one more caller happens to fit" — see
  // `assertPoolFullyFree`'s own doc for why a single-follow-up check can't actually prove this.
  await assertPoolFullyFree("H");
}

// =============================================================================================
// (I) CR ab171b39 MINOR fix: a SYNCHRONOUSLY-throwing `deps.enumerate` reference inside
//     reapOrphanedDescendants must never become an unhandled rejection (which would exit the whole
//     process by default) and must still release its slot.
// =============================================================================================
{
  let unhandled = null;
  const onUnhandledRejection = (reason) => { unhandled = reason; };
  process.on("unhandledRejection", onUnhandledRejection);

  const capturedLines = [];
  const origLog = console.error;
  console.error = (...args) => { capturedLines.push(args.join(" ")); origLog(...args); };

  try {
    const syncThrowPid = freshPid();
    reapOrphanedDescendants(syncThrowPid, null, {
      enumerate: () => { throw new Error("simulated SYNCHRONOUS throw (card ab171b39 test)"); },
      kill: () => {},
    });
    await waitUntil(
      () => capturedLines.some((l) => l.includes(`[pty-reap] root=${syncThrowPid}:`) && l.includes("threw synchronously")),
      { timeoutMs: 3000, label: "(I) the sync-throw's own log line" },
    );
    // Wait exactly ONE event-loop turn (never a guessed duration) before checking for an unhandled
    // rejection — Node's own unhandledRejection detection runs synchronously within a turn, once the
    // microtask queue has drained for it; `setImmediate` schedules a callback for the NEXT turn, which
    // is both necessary and sufficient here, unlike a `sleep(ms)` guess at "long enough".
    await new Promise((resolve) => setImmediate(resolve));
    check("(I) a synchronous throw inside the real branch never surfaces as an unhandled rejection", unhandled === null);
    check("(I) the throw was logged (found/killed NOTHING), never silently swallowed",
      capturedLines.some((l) => l.includes(`[pty-reap] root=${syncThrowPid}:`) && l.includes("simulated SYNCHRONOUS throw")));
  } finally {
    console.error = origLog;
    process.off("unhandledRejection", onUnhandledRejection);
  }

  // The pool must be FULLY free afterward — same reasoning as (H)'s own comment above.
  await assertPoolFullyFree("I");
}

console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
fs.rmSync(tmpHome, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
