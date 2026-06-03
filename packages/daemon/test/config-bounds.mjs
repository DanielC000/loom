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

// --- a fully-valid override still round-trips, and .strict() unknown-key guard is intact ------------
{
  const full = validateProjectConfigOverride(orch({ maxConcurrentWorkers: 4, maxConcurrentManagers: 2, recycleAtContextRatio: 0.9, idleNudgeMinutes: 45, maxUnansweredNudges: 2, idleDefaultSnoozeMinutes: 30 }));
  check("valid full orchestration override accepted", full.ok === true);
  check("accepted values round-trip unchanged", full.ok && full.value.orchestration?.recycleAtContextRatio === 0.9 && full.value.orchestration?.maxConcurrentWorkers === 4);
  check(".strict() still rejects an unknown orchestration key", validateProjectConfigOverride(orch({ bogusKey: 1 })).ok === false);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the project-config override schema bounds every orchestration numeric field (recycleAtContextRatio 0..1; caps int 1..100; minute fields/counter int ≥0), rejects out-of-range/negative/non-integer values with a field-named reason on BOTH the REST and agent paths, accepts valid + boundary + disable values, and keeps .strict() unknown-key rejection intact."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
