// SHARED TEST WAIT HELPER (card 0fa5beef) — poll for real state instead of guessing how long it takes
// to arrive.
//
// THE ANTI-PATTERN THIS EXISTS TO KILL: a test that samples timing-dependent state after a blind
// `await sleep(N)` is asserting against a GUESS about how long some other async operation takes, not an
// observation of it actually happening. It passes on an idle host and fails under load — and a red
// result then gets read as "probably a flake" instead of a real regression, which is precisely how a
// real regression eventually gets waved through. Filed after FOUR instances of this exact shape redded
// real merge gates in one day on branches that were entirely innocent: `2916357` (codescape-supervisor
// bad-bin), `1d7397e` (pty-restart-nudge-atomicity), `595aad10` (gate-semaphore-concurrency), `fea23514`
// (pending-ops-registry clobber guard). Two of those had already been "fixed" once by widening the
// sleep constant (`6c3d2d3`) — the widening did not hold; it only bought a slower flake.
//
// THE FIX IS NEVER TO WIDEN THE CONSTANT. Remove the ambiguity instead:
//   - `waitUntil(predicate, opts)` below — poll until state you can only OBSERVE (not control) holds,
//     e.g. "busy flipped to false", "the entry was evicted".
//   - `deferred()` below — for a promise YOU control the settlement of (a fake `run()`/callback under
//     test), hand-resolve it at exactly the moment the test wants, instead of pairing a blind sleep with
//     a real timer and hoping the two land in the right order.
//
// BARRIER vs DEFERRED — not stylistic, pick the one that matches what you're actually proving:
//   - A rendezvous BARRIER (N participants signal arrival, release once all N have) proves two
//     INDEPENDENT calls genuinely overlapped in time — use it for an "these two things ran
//     concurrently" claim (see gate-semaphore-concurrency.mjs section (B)'s inline barrier).
//   - A DEFERRED promise (this file's `deferred()`) observes ONE call's internal ordering — use it for
//     an "X happens before/after Y within a single flow" claim (see pending-ops-registry.mjs's CLOBBER
//     GUARD block and its onSurfacedPending-ordering block, both already hand-resolved for this reason).
//   Picking the wrong one still "passes" — it just stops testing the claim you think it's testing.
//
// TWO HARD-WON COROLLARIES (card b64b3726 — read before you "simplify" a wait you didn't write):
//   1. Removing a blind sleep can remove a HIDDEN GUARANTEE it was accidentally also providing. A sleep
//      can be doing two jobs at once and only one of them is visible in the test's own assertion — see
//      pty-giveup-false-negative.mjs's `awaitClockPast` doc for a real instance (a computed-deadline
//      sleep was accidentally also guaranteeing the millisecond clock had ticked between two events).
//   2. After changing a timing path, audit by GREP across the whole suite, not by memory. One product
//      change broke test timing in three separate waves; the third only surfaced when someone grepped
//      every file touching that chain and found one with zero slack that had simply never failed yet.
//
// USAGE:
//   import { waitUntil, deferred } from "./_wait.mjs";
//   await waitUntil(() => registry.peek(key) === undefined, { label: "k5 evicted after failure" });
//   const { promise, resolve } = deferred();
//   const pending = await reg.attach(key, kind, mgr, waitMs, () => promise);
//   resolve({ ok: true });   // settle it exactly when the test wants to, never "after enough sleep"
//
// Most `sleep()` calls in this suite are NOT this anti-pattern (letting a microtask drain, pacing a poll
// loop) — do not mass-convert every sleep you find; convert one only when it's genuinely racing another
// async operation's real duration.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function describe(value) {
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Poll `predicate` (sync or async) until it returns a truthy value. Throws on timeout naming `label`
 * and the LAST observed (falsy) value — a bare "timed out" is barely better than the blind sleep this
 * replaces.
 * @param {() => unknown} predicate
 * @param {{ timeoutMs?: number, intervalMs?: number, label?: string }} [opts]
 */
export async function waitUntil(predicate, { timeoutMs = 5000, intervalMs = 10, label = "condition" } = {}) {
  const t0 = Date.now();
  let last;
  for (;;) {
    last = await predicate();
    if (last) return last;
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`waitUntil: timed out after ${timeoutMs}ms waiting for ${label} (last observed: ${describe(last)})`);
    }
    await sleep(intervalMs);
  }
}

/**
 * A promise whose settlement YOU control, for hand-resolving a fake `run()`/callback under test at
 * exactly the moment the test wants — the deferred-promise half of the fix (see this file's header).
 * @returns {{ promise: Promise<any>, resolve: (v?: any) => void, reject: (e?: any) => void }}
 */
export function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
