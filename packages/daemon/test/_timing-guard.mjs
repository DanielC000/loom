// Shared timing-guard toolkit (card 1addef27) — safe primitives for proving "X does not happen" without
// resting on a bare fixed sleep. Companion to the write-time guard (fixed-wait-negative-guard.mjs), which
// enforces going forward that a negative assertion paired with a fixed wait either goes through
// assertNeverWithControl's mandatory positiveControl or carries an explicit TIMING-GUARD-SAFE exemption.
// See memory `fixed-wait-polarity-negative-assertions-fail-silently` (incl. §CLEARING) and the screen at
// 975956b2 for the defect class this exists to close and the full candidate population.

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll `predicate` every `intervalMs` until it resolves truthy, or `timeoutMs` elapses. DETERMINISTIC
 * SETTLEMENT: replaces "guess a sleep length, then look once" with "wait for the real condition, bounded"
 * — reach for this (or, better, directly `await`ing a real completion promise/event when one is exposed)
 * whenever a genuine completion signal exists to check for. Returns true iff the predicate became truthy
 * before the timeout.
 */
export async function pollUntil(predicate, { timeoutMs, intervalMs = 20 } = {}) {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (performance.now() >= deadline) return false;
    await wait(intervalMs);
  }
}

/**
 * Observe whether `check()` becomes true — via a real completion seam (`settle`) if one is given, else by
 * sampling `check()` every `intervalMs` across a `windowMs` window, returning as soon as it flips true
 * (fail-fast) rather than only looking once at the end. This is the ONE mechanism `assertNeverWithControl`
 * uses for both its mandatory positive control and the real run below, so both are provably observed the
 * identical way — never call it and hand-roll a second, subtly different, observation path.
 */
export async function observeOnce({ check, settle, windowMs, intervalMs = 20 }) {
  if (typeof settle === "function") { await settle(); return !!check(); }
  const deadline = performance.now() + windowMs;
  for (;;) {
    if (check()) return true;
    if (performance.now() >= deadline) return false;
    await wait(intervalMs);
  }
}

/**
 * Prove a negative assertion ("X never happens") without a bare fixed sleep — and without trusting that
 * proof unless it has just been shown, moments ago, capable of catching a real violation.
 *
 * GUARANTEES:
 *   - Fails FAST the instant `check()` flips true during `settle`/the sampling window, rather than
 *     looking only once at the end of a single guessed sleep.
 *   - REFUSES to run at all without a `positiveControl`: an async function that arms a real violation of
 *     the SAME invariant and, via `observeOnce` — the identical mechanism used for the real run below —
 *     must itself observe `check()` flip true (i.e. must return `true`). A call site that cannot prove its
 *     own check can go red never gets to assert the negative — enforced here at RUNTIME, not by
 *     convention or a comment. A faked no-op control (one that doesn't really arm anything) fails its own
 *     control phase, because nothing then flips `check()` true.
 *   - `windowMs` (when used instead of `settle`) should be DERIVED from a real, known/measured quantity —
 *     an internal debounce constant, a fixture's own write interval — never a bare guessed literal.
 *
 * DOES NOT GUARANTEE:
 *   - That a violation arriving AFTER `settle` resolves (or after the sampling window closes) is caught.
 *     A late arrival past the window/settlement point is exactly as invisible here as it is to a bare
 *     fixed sleep — this helper shrinks the window and makes it fail-fast WITHIN it; it does not make the
 *     window infinite, and it does not eliminate the possibility of a late arrival.
 *   - Prefer a real completion seam (`settle`: await the actual production promise/event) over a sampled
 *     `windowMs` whenever one is exposed by the code under test — reach for window-sampling only when no
 *     such seam exists to await directly.
 *
 * Returns true iff the real run never observed `check()` become true (i.e. the negative assertion holds).
 */
export async function assertNeverWithControl({ label, check, positiveControl, settle, windowMs, intervalMs = 20 }) {
  if (typeof positiveControl !== "function") {
    throw new Error(`assertNeverWithControl("${label}"): positiveControl is REQUIRED — a negative assertion with no proof it can go red is not a test.`);
  }
  const wentRed = await positiveControl();
  if (wentRed !== true) {
    throw new Error(`assertNeverWithControl("${label}"): positive control did NOT observe check() go true (got ${wentRed}) — this check cannot detect the violation it exists to guard against.`);
  }
  const observedTrue = await observeOnce({ check, settle, windowMs, intervalMs });
  return !observedTrue;
}
