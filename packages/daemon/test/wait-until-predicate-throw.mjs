import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// waitUntil PREDICATE-THROW HANDLING (card d5ca8d57) — `_wait.mjs`'s poll loop used to be
// `last = await predicate();` with no try/catch anywhere: a predicate that THREW (e.g.
// `execSync("git rev-parse HEAD")` racing a concurrent writer, as in merge-batch-settle-deferred.mjs)
// did not read as "not yet observed" and get retried inside its own budget — it propagated out and
// killed the ENTIRE test file with exit 1. Real specimen: gate `d11bf5c8`, `merge-batch-settle-deferred`
// failed the full suite on exactly this shape and only passed alone (load/timing, not pollution — see
// the card body for why the usual retryPassed-in-isolation⇒pollution inference doesn't apply here).
//
// DoD-0 (this card): fixed SHARED in `_wait.mjs`, not at the one call site — a throwing predicate is
// now treated as falsy-and-retried inside the SAME budget, with only the LAST thrown error kept and
// named in the eventual timeout message. This is deliberately NOT "add a retry to quiet a flake": if
// the condition never becomes true, waitUntil still fails at the same budget — it just fails with the
// real cause attached instead of the first transient throw crashing the file uninformatively.
//
// Proves BOTH directions (DoD-3) — a clean pass alone would only show throws get swallowed:
//   (1) a predicate that throws on its first N calls then succeeds PASSES inside budget.
//   (2) a predicate that throws FOREVER still FAILS at the budget, with the last error's message
//       present in the thrown Error's own message (not merely logged).
// Also asserts the pre-fix crash class this card's own repro established doesn't happen anymore: no
// uncaught exception escapes waitUntil for a throwing predicate in either scenario — every failure
// mode surfaces as an ordinary rejected `waitUntil(...)` promise, catchable at the call site.
//
// FOLLOW-UP, same card (manager-directed, found by this card's own DoD-2 sweep): the shared retry-on-
// throw fix has a real side effect on `dev-server.mjs`/`serve-static.mjs`, which each define a LOCAL
// waitUntil wrapper (card a19e4c02) that deliberately re-throws a predicate's real bug instead of
// folding it into `false` — discriminated by regexing the thrown Error's MESSAGE for
// `/waitUntil: timed out/`. Post-fix, THIS function's own timeout message legitimately starts with
// that same text even when the cause was a persistent throw, so the regex can no longer tell "genuine
// never-true timeout" apart from "predicate never stopped throwing" — a19e4c02's wrappers silently
// started folding a real bug into `false`, verified empirically before this fix. The fix: a STRUCTURED
// `err.exhaustedOnThrow` boolean on the thrown Error, checked instead of the message text. Scenarios
// (4) and (5) below pin BOTH directions of that distinction, and (5) replicates the exact wrapper shape
// now used in dev-server.mjs/serve-static.mjs so a future `_wait.mjs` change can't silently re-break it.
//
// HERMETIC: no Db, no daemon, no dist import — this is a pure unit test of test/_wait.mjs itself.
// Run: node packages/daemon/test/wait-until-predicate-throw.mjs
import { waitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// (1) Throws on its first N calls, then succeeds — must PASS inside budget, not propagate the throw.
{
  let calls = 0;
  let threw = false;
  let result;
  try {
    result = await waitUntil(() => {
      calls++;
      if (calls < 3) throw new Error("transient: git rev-parse HEAD raced a concurrent writer");
      return "settled";
    }, { timeoutMs: 2000, intervalMs: 5, label: "transient-throw-then-succeed" });
  } catch {
    threw = true;
  }
  check("(1) a predicate that throws on its first calls then succeeds does NOT propagate the throw", threw === false);
  check("(1) it resolves with the real observed value once the predicate stops throwing", result === "settled");
  check("(1) the predicate was actually retried past its first throw (not short-circuited)", calls === 3);
}

// (2) Throws on EVERY call — must still fail at (approximately) the stated budget, not hang, and the
// thrown Error's own message must name the last error rather than reading as a bare "timed out".
{
  const timeoutMs = 100;
  const t0 = performance.now();
  let calls = 0;
  let caught;
  try {
    await waitUntil(() => {
      calls++;
      throw new Error("persistent: repo permanently unreadable");
    }, { timeoutMs, intervalMs: 10, label: "always-throws" });
  } catch (err) {
    caught = err;
  }
  const elapsed = performance.now() - t0;
  check("(2) a predicate that always throws still rejects (doesn't hang forever)", caught instanceof Error);
  check("(2) it was retried multiple times inside the budget, not just once", calls > 1);
  // Grace-window diagnostics (card 3fcd06d6, unrelated to this fix) can push the observed wall-clock past
  // the raw timeoutMs — bound generously (10x) so this only ever catches a genuine hang, never the grace
  // window's own documented ABSENT-characterisation polling.
  check("(2) it failed within a bounded window (no runaway retry loop)", elapsed < timeoutMs * 10);
  check("(2) the timeout Error names the last thrown error, not a bare \"timed out\"",
    typeof caught?.message === "string" && caught.message.includes("persistent: repo permanently unreadable"));
  check("(2) the timeout Error is marked exhaustedOnThrow:true — the LAST poll before failing was a throw",
    caught?.exhaustedOnThrow === true);
}

// (3) A predicate that never throws at all is byte-identical to pre-fix behaviour — the try/catch adds
// no observable difference for the common, non-throwing case.
{
  let calls = 0;
  const result = await waitUntil(() => {
    calls++;
    return calls >= 2 ? calls : false;
  }, { timeoutMs: 2000, intervalMs: 5, label: "never-throws" });
  check("(3) a non-throwing predicate still resolves with its own truthy return value", result === 2);
}

// (4) A GENUINE never-true timeout (the predicate never throws, it just never becomes true) must be
// marked exhaustedOnThrow:false — the other half of the distinction (4)/(5) exist to pin.
{
  let caught;
  try {
    await waitUntil(() => false, { timeoutMs: 100, intervalMs: 10, label: "genuine-never-true" });
  } catch (err) {
    caught = err;
  }
  check("(4) a genuine never-true timeout (no throw involved) is marked exhaustedOnThrow:false",
    caught?.exhaustedOnThrow === false);
}

// (5) THE WRAPPER-LEVEL REGRESSION TEST — replicates dev-server.mjs's/serve-static.mjs's exact local
// waitUntil wrapper (card a19e4c02, restored post-d5ca8d57's follow-up) byte-for-byte in shape,
// including the CANONICAL `!== false` form (not a bare truthy check — a bare `if (err?.exhaustedOnThrow)
// throw err;` would be a silent narrowing of the old regex's own defensiveness: the old regex also
// rethrew any error that didn't recognisably say "waitUntil: timed out", e.g. a foreign error escaping
// the wrapper). Proves the intent those two files carded — "a thrown predicate is a real bug and should
// propagate, not fold into false" — actually holds through the shared helper, across all 4 real cases.
{
  const wrapWaitUntil = async (predicate, timeoutMs = 100, stepMs = 10) => {
    try {
      return !!(await waitUntil(predicate, { timeoutMs, intervalMs: stepMs, label: "wrapper-replica: predicate" }));
    } catch (err) {
      if (err?.exhaustedOnThrow !== false) throw err;
      return false;
    }
  };

  // Case 1: absentErr, no lastError (genuine never-true) — exhaustedOnThrow:false → folds to false.
  const neverTrueResult = await wrapWaitUntil(() => false);
  check("(5) a19e4c02 preserved: a genuine never-true predicate (no throw) still folds to false through the wrapper",
    neverTrueResult === false);

  // Case 2: absentErr, with lastError (persistent throw) — exhaustedOnThrow:true → rethrows.
  let threwPersistentBug = false;
  try {
    await wrapWaitUntil(() => { throw new Error("a real bug in the predicate itself"); });
  } catch {
    threwPersistentBug = true;
  }
  check("(5) a19e4c02 restored: a predicate that never stops throwing PROPAGATES through the wrapper (not masked as false)",
    threwPersistentBug === true);

  // Case 3: lateErr (arrived true during the grace window, past budget) — exhaustedOnThrow:false →
  // folds to false, matching prior behaviour (a late-but-genuine arrival was always still a "failure"
  // by the caller's original budget, never a thrown bug). Timed off the real clock (not a call count —
  // a fixed count is timing-fragile across host load) so it genuinely lands past the 100ms budget but
  // inside the 400ms grace window.
  {
    const startedAt = performance.now();
    const lateResult = await wrapWaitUntil(() => (performance.now() - startedAt) > 150);
    check("(5) an arrived-late (never-thrown) predicate also folds to false through the wrapper",
      lateResult === false);
  }

  // Case 4: a foreign error (not one of waitUntil's own two constructed Errors) — exhaustedOnThrow is
  // undefined, `undefined !== false` → rethrows. Not reachable through the real sharedWaitUntil today
  // (poll() catches every predicate throw internally), but the wrapper must still be defensive against
  // it, exactly as the old regex was for any non-matching message.
  {
    let threwForeign = false;
    const wrapForeignCatch = async () => {
      try {
        throw new Error("not a waitUntil error at all");
      } catch (err) {
        if (err?.exhaustedOnThrow !== false) throw err;
        return false;
      }
    };
    try {
      await wrapForeignCatch();
    } catch {
      threwForeign = true;
    }
    check("(5) a foreign error (no exhaustedOnThrow marker) still rethrows, not folds to false",
      threwForeign === true);
  }
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
