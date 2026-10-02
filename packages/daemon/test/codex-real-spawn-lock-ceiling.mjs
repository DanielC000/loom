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
