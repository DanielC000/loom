import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — pure arithmetic below, no Db used
// Card fc53ea74 Code Review (BLOCKING finding) — pins the invariant the review's fix exists to restore:
// EVERY codex-real-spawn family member's outer per-file harness timeout (`resolveEffectiveTimeoutMs`,
// scripts/test-daemon.mjs) must leave room for BOTH its own real work AND however long it could
// legitimately wait on `_codex-real-spawn-lock.mjs`'s own cross-process lock, at EVERY daemon
// `maxConcurrentGates` cap — never just the unscaled cap=2 case.
//
// WHY THIS MATTERS: before this fix, 6 of 7 family members ran on a flat 120_000ms outer ceiling with NO
// knowledge of the lock's own (now cap-scaled) WAIT_TIMEOUT_MS. At cap=2 that lock budget is already
// 180_000ms — ABOVE the 120_000ms outer ceiling — so the harness SIGTERM-kills a legitimately-waiting file
// 60s before its own lock wait would ever give up, making the whole cap-scaling fix a no-op in practice;
// at cap=3 (360_000ms) it even exceeds codex-doctrine-real-spawn's own prior 300_000ms override.
//
// Fully hermetic — no daemon, no claude; pure arithmetic + the real exported functions, no real codex spawn.
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  CODEX_REAL_SPAWN_BASENAMES, CODEX_OWN_WORK_BUDGET_MS, DEFAULT_CODEX_OWN_WORK_BUDGET_MS,
  computeCodexLockWaitTimeoutMs, computeCodexFileCeilingMs,
  BASE_WAIT_TIMEOUT_MS, BASE_WAIT_MARGIN_MS, computeBaseWaitTimeoutMs, STALE_MS, STALE_MARGIN_MS,
} from "./_codex-real-spawn-lock.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { resolveEffectiveTimeoutMs } = await import(
  pathToFileURL(path.join(import.meta.dirname, "..", "scripts", "test-daemon.mjs")).href
);

// Several caps spanning the realistic range: today's owner-set value (2), the next couple of values a
// human might raise it to, and the validator's own max (50) — see resolveGateCapFromEnv's own doc.
const CAPS_TO_CHECK = [1, 2, 3, 4, 5, 10, 50];

check(`sanity: CODEX_REAL_SPAWN_BASENAMES is non-empty (found ${CODEX_REAL_SPAWN_BASENAMES.length})`, CODEX_REAL_SPAWN_BASENAMES.length > 0);

// --- [known-bad baseline] RED PROOF: today's OLD static per-file ceiling (pre-fix: a flat 120_000ms for
// 6 of 7 members, 300_000ms for codex-doctrine-real-spawn, computed with ZERO knowledge of the lock's own
// wait budget) VIOLATES "ceiling >= wait budget + own work allowance" at some cap — this is the exact
// defect this whole file exists to prevent recurring. If this check ever stops failing on these OLD
// numbers, the real assertions below are no longer discriminating (they'd pass just as easily on the
// broken shape). ----------------------------------------------------------------------------------------
{
  const OLD_STATIC_CEILING_MS = { "codex-doctrine-real-spawn": 300_000 };
  const OLD_DEFAULT_CEILING_MS = 120_000;
  const violations = [];
  for (const name of CODEX_REAL_SPAWN_BASENAMES) {
    const oldCeiling = OLD_STATIC_CEILING_MS[name] ?? OLD_DEFAULT_CEILING_MS;
    const ownWork = CODEX_OWN_WORK_BUDGET_MS[name] ?? DEFAULT_CODEX_OWN_WORK_BUDGET_MS;
    for (const cap of CAPS_TO_CHECK) {
      const required = computeCodexLockWaitTimeoutMs(cap) + ownWork;
      if (oldCeiling < required) violations.push(`${name}@cap=${cap} (old ${oldCeiling}ms < required ${required}ms)`);
    }
  }
  check(
    `[known-bad baseline] today's OLD static per-file ceiling DOES violate the invariant at some cap (found ${violations.length} violation(s), e.g. ${JSON.stringify(violations.slice(0, 3))})`,
    violations.length > 0,
  );
}

// --- CARD 44634792: a SECOND, DIFFERENT invariant from the one above — "ceiling_i = waitBudget(cap) +
// ownWork_i" (the loop below, and everything above) is true BY CONSTRUCTION (computeCodexFileCeilingMs
// literally defines ceiling that way) and says nothing about whether waitBudget(cap) is ITSELF large
// enough to cover a SIBLING's own-work. A waiter gives up after waitBudget(cap)ms; a HOLDER can
// legitimately occupy the lock for up to ITS OWN ownWork ms. If any ownWork exceeds waitBudget(cap), a
// waiter queued behind a healthy, legitimately-slow holder hard-fails with a lock-timeout — the WRONG
// file fails, misattributing a sibling's slowness. This section pins "BASE_WAIT_TIMEOUT_MS (the cap<=2
// floor of waitBudget) >= every CODEX_OWN_WORK_BUDGET_MS entry" so that can never happen at cap<=2
// (the owner-set cap today), and that the derivation (`computeBaseWaitTimeoutMs`) is what actually
// produces the live constant, never a hand-picked literal that could silently undercut a future entry.
// See docs/decisions/fc53ea74-codex-lock-budget-scales-with-gate-cap.md's amendment for the full
// narrative and the honest cost accounting.
{
  const liveRequired = Math.max(...Object.values(CODEX_OWN_WORK_BUDGET_MS), DEFAULT_CODEX_OWN_WORK_BUDGET_MS);

  // [known-bad baseline, RED PROOF] the pre-44634792 state: commit c331dd79 (verifiable via
  // `git show c331dd79:packages/daemon/test/_codex-real-spawn-lock.mjs`) hand-picked BASE_WAIT_TIMEOUT_MS
  // at a frozen historical 180_000 with NO relationship to CODEX_OWN_WORK_BUDGET_MS — at that commit,
  // CODEX_OWN_WORK_BUDGET_MS already carried the SAME 5 entries (up to 2_880_000 for codex-transcript-
  // real-spawn) TODAY's own-work map carries. Checked against TODAY's live map (the entries haven't
  // changed since that commit) to confirm the real historical defect this card fixed.
  const OLD_HAND_PICKED_BASE_WAIT_TIMEOUT_MS = 180_000; // frozen historical fact — see comment above, not a live value
  check(
    `[known-bad baseline] the pre-44634792 hand-picked BASE_WAIT_TIMEOUT_MS (${OLD_HAND_PICKED_BASE_WAIT_TIMEOUT_MS}ms, commit c331dd79) DOES violate "covers every own-work entry" (required ${liveRequired}ms) — confirms this check discriminates, not vacuous`,
    OLD_HAND_PICKED_BASE_WAIT_TIMEOUT_MS < liveRequired,
  );

  // the real assertion, on the LIVE derived constant.
  check(
    `BASE_WAIT_TIMEOUT_MS (${BASE_WAIT_TIMEOUT_MS}ms) covers every CODEX_OWN_WORK_BUDGET_MS entry + the default (max ${liveRequired}ms) — a waiter's smallest possible wait budget (cap<=2) still exceeds the longest legitimate single hold`,
    BASE_WAIT_TIMEOUT_MS >= liveRequired,
  );

  // no-drift cross-check: the live constant must equal what the pure derivation function itself returns
  // for the SAME inputs — if BASE_WAIT_TIMEOUT_MS were ever hand-edited back to a literal, this catches it
  // even if that literal happened to still be large enough to pass the check above.
  check(
    "BASE_WAIT_TIMEOUT_MS exactly equals computeBaseWaitTimeoutMs(CODEX_OWN_WORK_BUDGET_MS, DEFAULT_CODEX_OWN_WORK_BUDGET_MS, BASE_WAIT_MARGIN_MS) — never a hand-edited literal",
    BASE_WAIT_TIMEOUT_MS === computeBaseWaitTimeoutMs(CODEX_OWN_WORK_BUDGET_MS, DEFAULT_CODEX_OWN_WORK_BUDGET_MS, BASE_WAIT_MARGIN_MS),
  );

  // [injected-value proof] a FUTURE too-large CODEX_OWN_WORK_BUDGET_MS entry would be caught: run the
  // SAME pure formula against the real map PLUS one synthetic oversized entry — proves the check doesn't
  // merely happen to pass today's numbers, it discriminates against a worse input the same shape.
  {
    const injected = { ...CODEX_OWN_WORK_BUDGET_MS, "fake-future-entry": BASE_WAIT_TIMEOUT_MS + 1 };
    const requiredWithInjected = Math.max(...Object.values(injected), DEFAULT_CODEX_OWN_WORK_BUDGET_MS);
    check(
      "[injected-value proof] a future CODEX_OWN_WORK_BUDGET_MS entry larger than BASE_WAIT_TIMEOUT_MS would FAIL this same invariant (required grows past the current BASE_WAIT_TIMEOUT_MS)",
      BASE_WAIT_TIMEOUT_MS < requiredWithInjected,
    );
  }

  // STALE_MS must stay above BASE_WAIT_TIMEOUT_MS: _codex-real-spawn-lock.mjs's tryAcquireOnce
  // force-reaps on `age > STALE_MS` regardless of isRecordedHolderDead's own verdict (even a CONFIRMED-
  // alive holder) — a STALE_MS at or below the longest legitimate hold would let a waiter steal the lock
  // out from under a still-running holder, the exact double-hold hazard this lock exists to prevent.
  check(
    `STALE_MS (${STALE_MS}ms) exceeds BASE_WAIT_TIMEOUT_MS (${BASE_WAIT_TIMEOUT_MS}ms) by STALE_MARGIN_MS (${STALE_MARGIN_MS}ms) — a confirmed-alive holder within its own worst case is never force-reaped purely by age`,
    STALE_MS === BASE_WAIT_TIMEOUT_MS + STALE_MARGIN_MS && STALE_MS > BASE_WAIT_TIMEOUT_MS,
  );
}

// --- the real assertion: for EVERY family member and EVERY cap checked, the LIVE resolved ceiling
// satisfies ceiling >= wait budget + the file's own work allowance ----------------------------------------
for (const name of CODEX_REAL_SPAWN_BASENAMES) {
  const ownWork = CODEX_OWN_WORK_BUDGET_MS[name] ?? DEFAULT_CODEX_OWN_WORK_BUDGET_MS;
  for (const cap of CAPS_TO_CHECK) {
    const waitBudget = computeCodexLockWaitTimeoutMs(cap);
    const required = waitBudget + ownWork;
    const resolved = await resolveEffectiveTimeoutMs(name, cap);
    check(`${name} @ cap=${cap}: resolved ceiling (${resolved}ms) >= wait budget + own work (${required}ms)`, resolved >= required);
  }
}

// --- no-drift cross-check: resolveEffectiveTimeoutMs (scripts/test-daemon.mjs) and
// computeCodexFileCeilingMs (_codex-real-spawn-lock.mjs) must compute the IDENTICAL number — the whole
// point of routing both through one shared function ---------------------------------------------------
for (const name of CODEX_REAL_SPAWN_BASENAMES) {
  const ownWork = CODEX_OWN_WORK_BUDGET_MS[name] ?? DEFAULT_CODEX_OWN_WORK_BUDGET_MS;
  for (const cap of CAPS_TO_CHECK) {
    const resolved = await resolveEffectiveTimeoutMs(name, cap);
    const direct = computeCodexFileCeilingMs(ownWork, cap);
    check(`${name} @ cap=${cap}: resolveEffectiveTimeoutMs matches computeCodexFileCeilingMs exactly (no drift)`, resolved === direct);
  }
}

// --- sanity control: a NON-codex file is completely unaffected by this — it keeps resolving via the
// static TEST_TIMEOUT_OVERRIDES/TEST_TIMEOUT_MS map, regardless of cap --------------------------------
{
  const nonCodexName = "definitely-not-a-codex-real-spawn-file";
  const atCap2 = await resolveEffectiveTimeoutMs(nonCodexName, 2);
  const atCap50 = await resolveEffectiveTimeoutMs(nonCodexName, 50);
  check(
    `a non-codex file's resolved timeout is UNCHANGED by cap (120000ms at cap=2: ${atCap2}, at cap=50: ${atCap50})`,
    atCap2 === 120_000 && atCap50 === 120_000,
  );
}

console.log(`\n${failures === 0 ? "✅" : "❌"} codex-real-spawn-lock-ceiling: ${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
