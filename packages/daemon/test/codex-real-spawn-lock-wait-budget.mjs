import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — pure source-text/arithmetic below, no Db used
// Card fc53ea74 — regression coverage for `_codex-real-spawn-lock.mjs`'s cap-derived WAIT_TIMEOUT_MS
// arithmetic. The lock's own module-level `WAIT_TIMEOUT_MS` is computed ONCE at import time from
// `process.env.LOOM_GATE_CONCURRENT_CAP`, which makes it awkward to exercise multiple cap scenarios
// against the real module-level constant within one process (ES module instances are cached by resolved
// URL, so a second dynamic `import()` of the same path would not re-evaluate under a different env).
// Rather than spawning a child process per scenario, the lock file exports the arithmetic as two PURE
// functions (`resolveGateCapFromEnv`, `computeCodexLockWaitTimeoutMs`) — this test exercises those
// directly, the same real code `_codex-real-spawn-lock.mjs`'s own module-level constants call.
//
// Fully hermetic — no daemon, no claude, no real codex spawn; pure arithmetic only.
import { BASE_WAIT_TIMEOUT_MS, resolveGateCapFromEnv, computeCodexLockWaitTimeoutMs } from "./_codex-real-spawn-lock.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- resolveGateCapFromEnv: env-string -> cap number, with the bare/absent fallback -----------------
check("sanity: BASE_WAIT_TIMEOUT_MS is today's unchanged 180s figure", BASE_WAIT_TIMEOUT_MS === 180_000);

check("[fallback] undefined env (bare/manual run, no gate-child env) resolves to cap=2", resolveGateCapFromEnv(undefined) === 2);
check("[fallback] an empty-string env resolves to cap=2", resolveGateCapFromEnv("") === 2);
check("[fallback] a non-numeric env resolves to cap=2 (fails closed, never NaN)", resolveGateCapFromEnv("not-a-number") === 2);
check("a real cap of \"1\" resolves to 1, not the fallback", resolveGateCapFromEnv("1") === 1);
check("a real cap of \"2\" resolves to 2", resolveGateCapFromEnv("2") === 2);
check("a real cap of \"3\" resolves to 3", resolveGateCapFromEnv("3") === 3);
check("a real cap of \"8\" resolves to 8 (MAX_CONCURRENCY ceiling elsewhere in the codebase)", resolveGateCapFromEnv("8") === 8);

// --- Code Review follow-up (fc53ea74): accept ONLY finite integers >= 1, clamp to the validator's max ---
check("[fallback] \"Infinity\" does NOT resolve to an unbounded cap — falls back to 2", resolveGateCapFromEnv("Infinity") === 2);
check("[fallback] \"-Infinity\" falls back to 2", resolveGateCapFromEnv("-Infinity") === 2);
check("[fallback] a non-integer (\"2.5\") falls back to 2, never truncated/rounded", resolveGateCapFromEnv("2.5") === 2);
check("[fallback] zero falls back to 2 (never a zero-wait cap)", resolveGateCapFromEnv("0") === 2);
check("[fallback] a negative integer (\"-3\") falls back to 2", resolveGateCapFromEnv("-3") === 2);
check("a cap AT the validator's max (\"50\") resolves to 50 exactly, not clamped down", resolveGateCapFromEnv("50") === 50);
check("[CLAMP] a cap ABOVE the validator's max (\"51\") clamps to 50, does not fall back to 2", resolveGateCapFromEnv("51") === 50);
check("[CLAMP] an absurdly large cap (\"999999\") clamps to 50", resolveGateCapFromEnv("999999") === 50);
check("[CLAMP] \"Infinity\" is REJECTED (falls back to 2), never clamped to 50 — distinguishes reject-as-invalid from clamp-as-oversized", resolveGateCapFromEnv("Infinity") === 2 && resolveGateCapFromEnv("Infinity") !== 50);

// --- computeCodexLockWaitTimeoutMs: unchanged at cap<=2, scales linearly above it --------------------
check("[unchanged] cap=1 yields today's flat 180s (never smaller than before this card)", computeCodexLockWaitTimeoutMs(1) === 180_000);
check("[unchanged] cap=2 yields today's flat 180s — the owner-set cap today (gate-cap-is-2 memory)", computeCodexLockWaitTimeoutMs(2) === 180_000);
check("cap=3 scales to 360s (2 other-holder-worths)", computeCodexLockWaitTimeoutMs(3) === 360_000);
check("cap=4 scales to 540s (3 other-holder-worths)", computeCodexLockWaitTimeoutMs(4) === 540_000);

// --- RED PROOF: a flat-180s-regardless-of-cap regression (the bug this card fixes) would be caught ----
// If `computeCodexLockWaitTimeoutMs` were ever "simplified" back to always returning BASE_WAIT_TIMEOUT_MS
// (ignoring cap entirely — exactly the pre-fc53ea74 behavior), monotonicity below would fail: a higher
// cap MUST never yield a smaller-or-equal budget than a lower one above the cap<=2 floor.
check(
  "RED-PROOF SHAPE: the budget strictly increases past cap=2 (a flat-180s-always regression would fail this)",
  computeCodexLockWaitTimeoutMs(3) > computeCodexLockWaitTimeoutMs(2) && computeCodexLockWaitTimeoutMs(4) > computeCodexLockWaitTimeoutMs(3),
);
check(
  "the budget never DECREASES as cap rises (monotonic non-decreasing across the floor too)",
  computeCodexLockWaitTimeoutMs(2) >= computeCodexLockWaitTimeoutMs(1) && computeCodexLockWaitTimeoutMs(1) > 0,
);

console.log(`\n${failures === 0 ? "✅" : "❌"} codex-real-spawn-lock-wait-budget: ${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
