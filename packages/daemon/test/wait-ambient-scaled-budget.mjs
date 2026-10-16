import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 7b9bafb7 — selftest for `_wait.mjs`'s `ambientScaledBudget`/`scaleAmbientBudget`, the shared
// ambient-overshoot calibration helper promoted out of three files that used to hand-copy the same inline
// pattern (dev-server-teardown.mjs, dist-importer-check-glue.mjs, trust-lock.mjs).
//
// Exercises the PURE math (`scaleAmbientBudget(baseMs, overshoot, marginMultiplier)`) with an arbitrary,
// caller-supplied `overshoot` rather than forcing real host contention — the cap exists precisely for a
// pathological overshoot reading, and that shape can't be reproduced on demand by actually loading the
// host. `ambientScaledBudget` itself (the memoized, real-measurement entry point) is exercised too, but
// only for its floor/memoization properties — it can't be driven to a high overshoot deterministically.
//
// Run: node test/wait-ambient-scaled-budget.mjs (no daemon build needed — pure ESM, no dist/ import)
import { scaleAmbientBudget, ambientScaledBudget, AMBIENT_OVERSHOOT_CAP } from "./_wait.mjs";
import { finishAndExit } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- FLOOR: never returns less than baseMs ---
check("(floor) idle host (overshoot 1x), default margin -> exactly baseMs",
  scaleAmbientBudget(1000, 1) === 1000);
check("(floor) a sub-1 overshoot reading still floors at baseMs (defensive — real measurement never produces one, but the clamp holds regardless)",
  scaleAmbientBudget(1000, 0.3) === 1000);
check("(floor) baseMs of 0 stays 0 (nothing to floor below)",
  scaleAmbientBudget(0, 50) === 0);

// --- CAP: the overshoot component alone never exceeds AMBIENT_OVERSHOOT_CAP ---
check(`(cap) a pathological overshoot (100x) clamps to exactly baseMs * ${AMBIENT_OVERSHOOT_CAP} with the default margin`,
  scaleAmbientBudget(1000, 100) === 1000 * AMBIENT_OVERSHOOT_CAP);
check(`(cap) an overshoot already AT the cap is unaffected (not clamped below it)`,
  scaleAmbientBudget(1000, AMBIENT_OVERSHOOT_CAP) === 1000 * AMBIENT_OVERSHOOT_CAP);
check(`(cap) an overshoot just under the cap scales linearly (the clamp hasn't engaged yet)`,
  scaleAmbientBudget(1000, AMBIENT_OVERSHOOT_CAP - 1) === 1000 * (AMBIENT_OVERSHOOT_CAP - 1));

// --- NEGATIVE CONTROL: prove the cap is actually doing something, not vacuously satisfied ---
// Without the cap, a 100x overshoot would scale baseMs by the full 100x (plus margin) — compute that
// uncapped figure independently and confirm the REAL (capped) result is genuinely smaller than it. A cap
// that never actually constrains anything would make this comparison pass by coincidence; this fails loud
// if `scaleAmbientBudget` is ever "simplified" back to an unclamped `baseMs * overshoot * margin`.
{
  const base = 1000, overshoot = 100, margin = 1;
  const uncapped = Math.round(base * overshoot * margin);
  const capped = scaleAmbientBudget(base, overshoot, margin);
  check("(negative control) the capped result is strictly smaller than what an uncapped formula would have produced",
    capped < uncapped && capped === base * AMBIENT_OVERSHOOT_CAP);
}

// --- MARGIN: a caller's own marginMultiplier is NEVER capped, only the overshoot component is ---
check("(margin) marginMultiplier applies on top of the capped overshoot, uncapped itself",
  scaleAmbientBudget(1000, 100, 3) === 1000 * AMBIENT_OVERSHOOT_CAP * 3);
check("(margin) effective multiplier under normal conditions (overshoot<=1) equals the margin alone — migration must not change this",
  scaleAmbientBudget(3000, 1, 2) === 3000 * 2 && scaleAmbientBudget(5000, 1, 4) === 5000 * 4 && scaleAmbientBudget(10_000, 1, 3) === 10_000 * 3);

// --- the real (measuring) entry point: floor + memoization, the two properties testable without forcing load ---
{
  const a = ambientScaledBudget(2000, 1);
  const b = ambientScaledBudget(2000, 1);
  check("(real) ambientScaledBudget never returns less than baseMs", a >= 2000);
  check("(real) ambientScaledBudget's probe is memoized — two calls in the same process return the identical scaled value for the same inputs", a === b);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — ambientScaledBudget/scaleAmbientBudget floor at baseMs, cap the overshoot component (not the caller's margin) at AMBIENT_OVERSHOOT_CAP, and the cap is proven to actually constrain something, not just pass vacuously."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
