// Config-bounds test: the project-config override schema bounds its orchestration numeric fields, so
// an out-of-range value (e.g. recycleAtContextRatio:5, a negative/zero cap) is REJECTED with a clear
// reason instead of silently persisting and corrupting orchestration behavior. Hermetic — imports the
// built validators from dist/* only (no daemon, no claude). Mirrors the validator checks in
// idle-watcher.mjs (case 14). Exercises BOTH paths (REST/human + agent/loom-platform MCP).
import { validateProjectConfigOverride, validateAgentProjectConfigOverride } from "../dist/mcp/platform.js";

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
}

// --- a fully-valid override still round-trips, and .strict() unknown-key guard is intact ------------
{
  const full = validateProjectConfigOverride(orch({ maxConcurrentWorkers: 4, maxConcurrentManagers: 2, recycleAtContextRatio: 0.9, idleNudgeMinutes: 45, maxUnansweredNudges: 2, idleDefaultSnoozeMinutes: 30 }));
  check("valid full orchestration override accepted", full.ok === true);
  check("accepted values round-trip unchanged", full.ok && full.value.orchestration?.recycleAtContextRatio === 0.9 && full.value.orchestration?.maxConcurrentWorkers === 4);
  check(".strict() still rejects an unknown orchestration key", validateProjectConfigOverride(orch({ bogusKey: 1 })).ok === false);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the project-config override schema bounds every orchestration numeric field (recycleAtContextRatio 0..1; caps int 1..100; minute fields/counter int ≥0; gateCommandTimeoutMs int 1000..1800000; alertWebhookTimeoutMs int 500..60000), rejects out-of-range/negative/non-integer values with a field-named reason on the human REST path, REJECTS the two HUMAN-only timeouts on the agent path (omitted), rejects a daemon-global `platform` key on BOTH project validators (.strict() unknown key), and keeps the existing .strict()/bounds guarantees intact."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
