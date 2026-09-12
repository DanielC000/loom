// Config-bounds test: the project-config override schema bounds its orchestration numeric fields, so
// an out-of-range value (e.g. recycleAtContextRatio:5, a negative/zero cap) is REJECTED with a clear
// reason instead of silently persisting and corrupting orchestration behavior. Hermetic — imports the
// built validators from dist/* only (no daemon, no claude). Mirrors the validator checks in
// idle-watcher.mjs (case 14). Exercises BOTH paths (REST/human + agent/loom-platform MCP).
import { validateProjectConfigOverride, validateAgentProjectConfigOverride } from "../dist/mcp/platform.js";
import { resolveConfig, MEMORY_CONFIG_MAX } from "@loom/shared";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// A rejection must surface a clear, field-named reason (both validators format zod issues the same way).
const orch = (o) => ({ orchestration: o });

// --- recycleAtContextRatio: valid range 0..1 -------------------------------------------------------
{
  // The reported repro: 5 used to save 200 OK.
  const bad = validateProjectConfigOverride(orch({ recycleAtContextRatio: 5 }));
  check("recycleAtContextRatio:5 (>1) rejected", bad.ok === false);
  check("recycleAtContextRatio:5 reason names the field", bad.ok === false && /recycleAtContextRatio/.test(bad.error));
  check("recycleAtContextRatio:-0.1 (<0) rejected", validateProjectConfigOverride(orch({ recycleAtContextRatio: -0.1 })).ok === false);
  // Boundaries + a disable value all pass.
  check("recycleAtContextRatio:0 (disable) accepted", validateProjectConfigOverride(orch({ recycleAtContextRatio: 0 })).ok === true);
  check("recycleAtContextRatio:1 accepted", validateProjectConfigOverride(orch({ recycleAtContextRatio: 1 })).ok === true);
  check("recycleAtContextRatio:0.8 (default) accepted", validateProjectConfigOverride(orch({ recycleAtContextRatio: 0.8 })).ok === true);
}

// --- emergencyRecycleAtContextRatio: same [0,1] range as recycleAtContextRatio (card 9f279c7b) -------
{
  const bad = validateProjectConfigOverride(orch({ emergencyRecycleAtContextRatio: 5 }));
  check("emergencyRecycleAtContextRatio:5 (>1) rejected", bad.ok === false);
  check("emergencyRecycleAtContextRatio:5 reason names the field", bad.ok === false && /emergencyRecycleAtContextRatio/.test(bad.error));
  check("emergencyRecycleAtContextRatio:-0.1 (<0) rejected", validateProjectConfigOverride(orch({ emergencyRecycleAtContextRatio: -0.1 })).ok === false);
  check("emergencyRecycleAtContextRatio:0 (disable) accepted", validateProjectConfigOverride(orch({ emergencyRecycleAtContextRatio: 0 })).ok === true);
  check("emergencyRecycleAtContextRatio:0.9 (default) accepted", validateProjectConfigOverride(orch({ emergencyRecycleAtContextRatio: 0.9 })).ok === true);
  // Benign per-project tuning (no host-exec/exfil capability) — stays on the agent path, like
  // recycleAtContextRatio itself.
  check("agent path also accepts a valid emergencyRecycleAtContextRatio", validateAgentProjectConfigOverride(orch({ emergencyRecycleAtContextRatio: 0.95 })).ok === true);
}

// --- emergencyRecycleAtContextRatio ORDERING (card 9f279c7b DoD-2): resolveConfig CLAMPS an emergency
// floor configured BELOW the project's own ordinary ratio, rather than silently inverting the two. This
// is a resolveConfig (shared/config.ts) concern, not a schema-bound one — the schema above only checks
// the raw [0,1] range of each field independently; the cross-field invariant is checked here.
{
  const clamped = resolveConfig({ orchestration: { recycleAtContextRatio: 0.85, emergencyRecycleAtContextRatio: 0.5 } });
  check("an emergency floor BELOW the ordinary ratio is clamped UP to the ordinary ratio, never left inverted",
    clamped.orchestration.emergencyRecycleAtContextRatio === 0.85);

  const unclamped = resolveConfig({ orchestration: { recycleAtContextRatio: 0.7, emergencyRecycleAtContextRatio: 0.9 } });
  check("an emergency floor already ABOVE the ordinary ratio passes through unchanged",
    unclamped.orchestration.emergencyRecycleAtContextRatio === 0.9);

  // 0 (disabled) is never clamped UP into an active floor — a project that explicitly disabled the
  // emergency watcher must stay disabled regardless of its ordinary ratio.
  const disabledStaysDisabled = resolveConfig({ orchestration: { recycleAtContextRatio: 0.85, emergencyRecycleAtContextRatio: 0 } });
  check("emergencyRecycleAtContextRatio:0 (disabled) is never clamped into an active floor",
    disabledStaysDisabled.orchestration.emergencyRecycleAtContextRatio === 0);

  // A disabled ORDINARY ratio (0) has nothing to clamp the emergency floor against — the emergency value
  // passes through as configured.
  const ordinaryDisabled = resolveConfig({ orchestration: { recycleAtContextRatio: 0, emergencyRecycleAtContextRatio: 0.3 } });
  check("a disabled ordinary ratio (0) does not clamp an active emergency floor",
    ordinaryDisabled.orchestration.emergencyRecycleAtContextRatio === 0.3);

  // Platform defaults alone (no project override) already satisfy the invariant (0.90 >= 0.80).
  const defaults = resolveConfig(undefined);
  check("platform defaults already satisfy emergency >= ordinary with no clamp needed",
    defaults.orchestration.emergencyRecycleAtContextRatio === 0.90 && defaults.orchestration.recycleAtContextRatio === 0.80);
}

// --- concurrency caps: whole-number, >=1, <=100 ----------------------------------------------------
for (const key of ["maxConcurrentWorkers", "maxConcurrentManagers"]) {
  check(`${key}:0 rejected (a zero cap deadlocks spawning)`, validateProjectConfigOverride(orch({ [key]: 0 })).ok === false);
  check(`${key}:-1 rejected`, validateProjectConfigOverride(orch({ [key]: -1 })).ok === false);
  check(`${key}:1.5 (non-integer) rejected`, validateProjectConfigOverride(orch({ [key]: 1.5 })).ok === false);
  check(`${key}:1000 (over ceiling) rejected`, validateProjectConfigOverride(orch({ [key]: 1000 })).ok === false);
  check(`${key}:3 (default) accepted`, validateProjectConfigOverride(orch({ [key]: 3 })).ok === true);
  check(`${key}:1 accepted`, validateProjectConfigOverride(orch({ [key]: 1 })).ok === true);
}

// --- minute fields / unanswered-nudge counter: whole-number, >=0 -----------------------------------
for (const key of ["idleNudgeMinutes", "maxUnansweredNudges", "idleDefaultSnoozeMinutes"]) {
  check(`${key}:-1 rejected`, validateProjectConfigOverride(orch({ [key]: -1 })).ok === false);
  check(`${key}:2.5 (non-integer) rejected`, validateProjectConfigOverride(orch({ [key]: 2.5 })).ok === false);
  check(`${key}:0 accepted (0 is a real value)`, validateProjectConfigOverride(orch({ [key]: 0 })).ok === true);
  check(`${key}:30 accepted`, validateProjectConfigOverride(orch({ [key]: 30 })).ok === true);
}

// --- the agent (loom-platform MCP) path enforces the SAME bounds ------------------------------------
{
  const bad = validateAgentProjectConfigOverride(orch({ recycleAtContextRatio: 5 }));
  check("agent path: recycleAtContextRatio:5 rejected", bad.ok === false);
  check("agent path: rejection reason names the field", bad.ok === false && /recycleAtContextRatio/.test(bad.error));
  check("agent path: maxConcurrentWorkers:0 rejected", validateAgentProjectConfigOverride(orch({ maxConcurrentWorkers: 0 })).ok === false);
  check("agent path: valid orchestration override accepted", validateAgentProjectConfigOverride(orch({ recycleAtContextRatio: 0.75, maxConcurrentWorkers: 5, idleNudgeMinutes: 20 })).ok === true);
}

// --- per-project gate/webhook timeouts: HUMAN-only, bounded on the human path -----------------------
// gateCommandTimeoutMs 1000–1800000; alertWebhookTimeoutMs 500–60000; both `.int()`.
{
  check("gateCommandTimeoutMs:999 (<floor) rejected", validateProjectConfigOverride(orch({ gateCommandTimeoutMs: 999 })).ok === false);
  check("gateCommandTimeoutMs:1800001 (>ceiling) rejected", validateProjectConfigOverride(orch({ gateCommandTimeoutMs: 1800001 })).ok === false);
  check("gateCommandTimeoutMs:1500.5 (non-integer) rejected", validateProjectConfigOverride(orch({ gateCommandTimeoutMs: 1500.5 })).ok === false);
  check("gateCommandTimeoutMs:1000 (floor) accepted", validateProjectConfigOverride(orch({ gateCommandTimeoutMs: 1000 })).ok === true);
  check("gateCommandTimeoutMs:1800000 (ceiling) accepted", validateProjectConfigOverride(orch({ gateCommandTimeoutMs: 1800000 })).ok === true);
  check("gateCommandTimeoutMs:120000 (default) accepted", validateProjectConfigOverride(orch({ gateCommandTimeoutMs: 120000 })).ok === true);

  check("alertWebhookTimeoutMs:499 (<floor) rejected", validateProjectConfigOverride(orch({ alertWebhookTimeoutMs: 499 })).ok === false);
  check("alertWebhookTimeoutMs:60001 (>ceiling) rejected", validateProjectConfigOverride(orch({ alertWebhookTimeoutMs: 60001 })).ok === false);
  check("alertWebhookTimeoutMs:5000.5 (non-integer) rejected", validateProjectConfigOverride(orch({ alertWebhookTimeoutMs: 5000.5 })).ok === false);
  check("alertWebhookTimeoutMs:500 (floor) accepted", validateProjectConfigOverride(orch({ alertWebhookTimeoutMs: 500 })).ok === true);
  check("alertWebhookTimeoutMs:60000 (ceiling) accepted", validateProjectConfigOverride(orch({ alertWebhookTimeoutMs: 60000 })).ok === true);
  check("alertWebhookTimeoutMs:5000 (default) accepted", validateProjectConfigOverride(orch({ alertWebhookTimeoutMs: 5000 })).ok === true);

  // HUMAN-only: both are OMITTED from the agent schema, so .strict() rejects them as unknown keys
  // (exactly like the paired gateCommand/alertWebhook keys are dropped on the agent path).
  check("agent path: gateCommandTimeoutMs REJECTED (human-only, omitted)", validateAgentProjectConfigOverride(orch({ gateCommandTimeoutMs: 120000 })).ok === false);
  check("agent path: alertWebhookTimeoutMs REJECTED (human-only, omitted)", validateAgentProjectConfigOverride(orch({ alertWebhookTimeoutMs: 5000 })).ok === false);
  // ...but an IN-RANGE value on the human path round-trips both through.
  const human = validateProjectConfigOverride(orch({ gateCommandTimeoutMs: 90000, alertWebhookTimeoutMs: 8000 }));
  check("human path: both timeouts round-trip unchanged", human.ok && human.value.orchestration?.gateCommandTimeoutMs === 90000 && human.value.orchestration?.alertWebhookTimeoutMs === 8000);
}

// --- daemon-GLOBAL `platform` key is human-only: REJECTED by BOTH project validators ---------------
// The per-project schemas are .strict() and carry NO `platform` key, so an agent (or a fat-fingered
// human PATCH) putting `platform:{}` on a PROJECT override is auto-rejected as an unknown key. The
// global tuning surface is the separate /api/platform/config REST path (validatePlatformConfigOverride).
{
  check("project REST validator rejects a `platform` key (unknown)", validateProjectConfigOverride({ platform: {} }).ok === false);
  check("project AGENT validator rejects a `platform` key (unknown)", validateAgentProjectConfigOverride({ platform: { watchers: { wakeMs: 60000 } } }).ok === false);
  // companionVoiceEnabled specifically (owner-directed 2026-07-06 opt-in): same structural rejection — an
  // agent can never reach it, human-only via the separate /api/platform/config path.
  check("project AGENT validator rejects `platform.companionVoiceEnabled` (unknown top-level key)",
    validateAgentProjectConfigOverride({ platform: { companionVoiceEnabled: true } }).ok === false);
}

// --- a fully-valid override still round-trips, and .strict() unknown-key guard is intact ------------
{
  const full = validateProjectConfigOverride(orch({ maxConcurrentWorkers: 4, maxConcurrentManagers: 2, recycleAtContextRatio: 0.9, idleNudgeMinutes: 45, maxUnansweredNudges: 2, idleDefaultSnoozeMinutes: 30 }));
  check("valid full orchestration override accepted", full.ok === true);
  check("accepted values round-trip unchanged", full.ok && full.value.orchestration?.recycleAtContextRatio === 0.9 && full.value.orchestration?.maxConcurrentWorkers === 4);
  check(".strict() still rejects an unknown orchestration key", validateProjectConfigOverride(orch({ bogusKey: 1 })).ok === false);
}

// --- memory.budgetTokens: bounded by MEMORY_CONFIG_MAX.budgetTokens, on BOTH paths, DERIVED FROM THE
// LIVE CONSTANT rather than a second hardcoded literal (card 5df039d1, ceiling raised 8000 -> 25000 by
// owner decision `d2b3e43f`, 2026-09-12). The at-ceiling/one-over probes below never hardcode the numeric
// ceiling themselves — they read MEMORY_CONFIG_MAX.budgetTokens and test exactly at/over THAT value, so
// they keep discriminating a "validator schema hardcodes its own bound instead of deriving it" regression
// even if the ceiling is raised again later (if platform.ts's zod .max() ever hardcodes a literal instead
// of reading the constant, MAX+1 would wrongly be ACCEPTED the moment the constant next changes — these
// checks would go RED). Only the sanity check pins today's actual owner-decided number, and it alone is
// the "did the ceiling regress" half of DoD-5 — this is deliberately not the whole test, since a bare
// equality check would need editing on every future change and proves nothing about a second bound.
{
  const mem = (m) => ({ memory: m });
  const MAX = MEMORY_CONFIG_MAX.budgetTokens;

  check("(sanity) MEMORY_CONFIG_MAX.budgetTokens is the owner-decided ceiling (d2b3e43f, 2026-09-12)", MAX === 25000);

  check(`memory.budgetTokens:${MAX} (at the live ceiling) accepted on the human path`,
    validateProjectConfigOverride(mem({ budgetTokens: MAX })).ok === true);
  check(`memory.budgetTokens:${MAX + 1} (one over the live ceiling) rejected on the human path`,
    validateProjectConfigOverride(mem({ budgetTokens: MAX + 1 })).ok === false);
  check(`memory.budgetTokens:${MAX} (at the live ceiling) accepted on the agent path`,
    validateAgentProjectConfigOverride(mem({ budgetTokens: MAX })).ok === true);
  check(`memory.budgetTokens:${MAX + 1} (one over the live ceiling) rejected on the agent path`,
    validateAgentProjectConfigOverride(mem({ budgetTokens: MAX + 1 })).ok === false);

  check("memory.budgetTokens:0 (floor) accepted", validateProjectConfigOverride(mem({ budgetTokens: 0 })).ok === true);
  check("memory.budgetTokens:-1 (below floor) rejected", validateProjectConfigOverride(mem({ budgetTokens: -1 })).ok === false);
  check("memory.budgetTokens:1.5 (non-integer) rejected", validateProjectConfigOverride(mem({ budgetTokens: 1.5 })).ok === false);

  // resolveConfig's own clamp (shared/config.ts) is exercised separately in test/project-memory.mjs
  // ("(clamp) an absurd budgetTokens override is clamped to MEMORY_CONFIG_MAX.budgetTokens"), which
  // already derives from the same live constant — not duplicated here.
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the project-config override schema bounds every orchestration numeric field (recycleAtContextRatio/emergencyRecycleAtContextRatio 0..1; caps int 1..100; minute fields/counter int ≥0; gateCommandTimeoutMs int 1000..1800000; alertWebhookTimeoutMs int 500..60000), rejects out-of-range/negative/non-integer values with a field-named reason on the human REST path, REJECTS the two HUMAN-only timeouts on the agent path (omitted), rejects a daemon-global `platform` key on BOTH project validators (.strict() unknown key), resolveConfig clamps an emergency floor below the ordinary ratio (never below 0-disabled) while passing an already-valid ordering through unchanged, bounds memory.budgetTokens to the live MEMORY_CONFIG_MAX ceiling on BOTH the human and agent paths without a second hardcoded literal, and keeps the existing .strict()/bounds guarantees intact."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
