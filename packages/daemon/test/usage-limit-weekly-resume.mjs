// resumeResetFromUsageStatus + the onRateLimited park-site wiring (board card 6df15380). Pure +
// hermetic: NO daemon, NO claude, NO Db — only the browser-pure usage-limit.js helpers (→ dist).
//
// ROOT CAUSE this guards: a StopFailure hook with NO resetsAtSeconds (the common case) used to fall
// straight to the flat DEFAULT_RATE_LIMIT_BACKOFF_MS (5h) even when Loom's OWN UsageStatusPoller
// already knew a window (e.g. the 7-day weekly cap) was exhausted with a reset ~16h out — so the
// session resumed BACK INTO the still-active cap and re-capped in a loop. resumeResetFromUsageStatus
// consults the polled UsageLimitsStatus for a real reset before falling back to the default.
//
// Covers:
//   (1) weekly-exhausted, no hook reset → resumeResetFromUsageStatus returns the weekly reset.
//   (2) both fiveHour + sevenDay exhausted → returns the LATEST of the two.
//   (3) sevenDayOpus/sevenDaySonnet are scanned too.
//   (4) none exhausted → undefined.
//   (5) status unavailable → undefined.
//   (6) an exhausted window whose resetsAt has already passed is ignored.
//   (7) exhaustedThresholdPct is a genuine RateLimitConfig tunable (default 95; override changes the cut).
//   (8) the onRateLimited WIRING contract (mirrors index.ts exactly): no-hook-reset + weekly-exhausted
//       → rateLimitedUntil == weekly reset+buffer and rateLimitDeadline is PAST that reset (not now+6h);
//       hook-carries-reset path is BYTE-IDENTICAL (usage status never consulted); status-unavailable
//       path is BYTE-IDENTICAL (5h default backoff, 6h no-reset deadline).
import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "loom-rl-weekly-"));
process.env.LOOM_HOME = TMP;
process.env.LOOM_PORT = "45327";
requireHermeticEnv();

const {
  resumeResetFromUsageStatus, rateLimitedUntil, rateLimitDeadline, DEFAULT_RATE_LIMIT_BACKOFF_MS,
} = await import("../dist/orchestration/usage-limit.js");
const { PLATFORM_DEFAULTS } = await import("@loom/shared");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const rl = PLATFORM_DEFAULTS.platform.rateLimit;
const NOW = new Date("2026-07-07T08:00:00.000Z");
const win = (utilization, resetsAt) => ({ utilization, resetsAt });
const secondsOf = (iso) => Math.floor(new Date(iso).getTime() / 1000);

const WEEKLY_RESET = "2026-07-08T00:38:00.000Z"; // ~16h38m out, matching the owner's repro
const FIVE_HOUR_RESET = "2026-07-07T10:00:00.000Z"; // ~2h out

// --- (1) weekly-exhausted, no hook reset → the weekly reset ---
{
  const status = {
    available: true, fetchedAt: NOW.toISOString(),
    fiveHour: win(40, "2026-07-07T09:00:00.000Z"), // NOT exhausted
    sevenDay: win(100, WEEKLY_RESET), // exhausted
    sevenDayOpus: null, sevenDaySonnet: null, extraUsage: null,
  };
  const got = resumeResetFromUsageStatus(status, NOW, rl);
  check("(1) weekly-exhausted + fiveHour NOT exhausted → returns the weekly reset", got === secondsOf(WEEKLY_RESET));
}

// --- (2) both exhausted → the LATEST reset (never resume into a still-capped window) ---
{
  const status = {
    available: true, fetchedAt: NOW.toISOString(),
    fiveHour: win(96, FIVE_HOUR_RESET), // exhausted, resets SOONER
    sevenDay: win(100, WEEKLY_RESET), // exhausted, resets LATER
    sevenDayOpus: null, sevenDaySonnet: null, extraUsage: null,
  };
  const got = resumeResetFromUsageStatus(status, NOW, rl);
  check("(2) both exhausted → returns the LATEST reset (the weekly one)", got === secondsOf(WEEKLY_RESET));
}

// --- (3) sevenDayOpus/sevenDaySonnet are scanned too ---
{
  const status = {
    available: true, fetchedAt: NOW.toISOString(),
    fiveHour: win(10, "2026-07-07T09:00:00.000Z"),
    sevenDay: win(20, WEEKLY_RESET),
    sevenDayOpus: win(99, "2026-07-07T20:00:00.000Z"), // exhausted, only exhausted one
    sevenDaySonnet: win(0, null),
    extraUsage: null,
  };
  const got = resumeResetFromUsageStatus(status, NOW, rl);
  check("(3) sevenDayOpus exhausted alone → its reset is picked up", got === secondsOf("2026-07-07T20:00:00.000Z"));
}

// --- (4) none exhausted → undefined (fall through to the 5h default) ---
{
  const status = {
    available: true, fetchedAt: NOW.toISOString(),
    fiveHour: win(40, "2026-07-07T09:00:00.000Z"),
    sevenDay: win(33, WEEKLY_RESET),
    sevenDayOpus: null, sevenDaySonnet: null, extraUsage: null,
  };
  check("(4) no window exhausted → undefined", resumeResetFromUsageStatus(status, NOW, rl) === undefined);
}

// --- (5) status unavailable → undefined ---
{
  const unavailable = { available: false, reason: "no Claude credentials file", fetchedAt: null };
  check("(5a) available:false → undefined", resumeResetFromUsageStatus(unavailable, NOW, rl) === undefined);
  check("(5b) status undefined entirely → undefined", resumeResetFromUsageStatus(undefined, NOW, rl) === undefined);
}

// --- (6) an exhausted window whose reset has ALREADY PASSED is ignored ---
{
  const status = {
    available: true, fetchedAt: NOW.toISOString(),
    fiveHour: win(100, "2026-07-07T07:00:00.000Z"), // exhausted but reset is an hour in the PAST
    sevenDay: win(20, WEEKLY_RESET), // not exhausted
    sevenDayOpus: null, sevenDaySonnet: null, extraUsage: null,
  };
  check("(6) exhausted-but-past-reset window ignored → undefined", resumeResetFromUsageStatus(status, NOW, rl) === undefined);
}

// --- (6b) an EXHAUSTED window with resetsAt: null (no active reset) is skipped, not crashed on ---
{
  const status = {
    available: true, fetchedAt: NOW.toISOString(),
    fiveHour: win(100, null), // exhausted, but no reset at all
    sevenDay: win(20, WEEKLY_RESET), // not exhausted
    sevenDayOpus: null, sevenDaySonnet: null, extraUsage: null,
  };
  check("(6b) exhausted window with resetsAt:null ignored → undefined", resumeResetFromUsageStatus(status, NOW, rl) === undefined);
}

// --- (6c) an EXHAUSTED window with a non-date resetsAt string is skipped, not NaN-poisoned ---
{
  const status = {
    available: true, fetchedAt: NOW.toISOString(),
    fiveHour: win(100, "not-a-date"), // exhausted, but resetsAt doesn't parse
    sevenDay: win(20, WEEKLY_RESET), // not exhausted
    sevenDayOpus: null, sevenDaySonnet: null, extraUsage: null,
  };
  check("(6c) exhausted window with unparseable resetsAt ignored → undefined", resumeResetFromUsageStatus(status, NOW, rl) === undefined);
}

// --- (7) exhaustedThresholdPct is a real tunable ---
{
  const status = {
    available: true, fetchedAt: NOW.toISOString(),
    fiveHour: win(40, "2026-07-07T09:00:00.000Z"),
    sevenDay: win(92, WEEKLY_RESET), // below the 95 default, at-or-above a lowered 90
    sevenDayOpus: null, sevenDaySonnet: null, extraUsage: null,
  };
  check("(7a) default threshold (95) → 92% NOT exhausted → undefined", resumeResetFromUsageStatus(status, NOW, rl) === undefined);
  const lowered = { ...rl, exhaustedThresholdPct: 90 };
  check("(7b) lowered threshold (90) → 92% IS exhausted → returns the reset",
    resumeResetFromUsageStatus(status, NOW, lowered) === secondsOf(WEEKLY_RESET));
  check("(7c) PLATFORM_DEFAULTS.platform.rateLimit.exhaustedThresholdPct default is 95", rl.exhaustedThresholdPct === 95);
}

// --- (8) the onRateLimited wiring contract, composed exactly as index.ts does it ---
// resetsAtSeconds = detail.resetsAtSeconds ?? resumeResetFromUsageStatus(usageStatus.getStatus(), now, rl)
// then: until = rateLimitedUntil(resetsAtSeconds, now, rl); deadline = rateLimitDeadline(resetsAtSeconds, now, rl)
function resolveWiring(hookResetsAtSeconds, status, now, cfg) {
  const resetsAtSeconds = hookResetsAtSeconds ?? resumeResetFromUsageStatus(status, now, cfg);
  return {
    until: rateLimitedUntil(resetsAtSeconds, now, cfg),
    deadline: rateLimitDeadline(resetsAtSeconds, now, cfg),
  };
}
{
  // (8a) weekly-exhausted + NO hook reset → resume AT the weekly reset (+buffer), deadline PAST it.
  const status = {
    available: true, fetchedAt: NOW.toISOString(),
    fiveHour: win(10, "2026-07-07T09:00:00.000Z"),
    sevenDay: win(100, WEEKLY_RESET),
    sevenDayOpus: null, sevenDaySonnet: null, extraUsage: null,
  };
  const { until, deadline } = resolveWiring(undefined, status, NOW, rl);
  const expectedUntil = new Date(secondsOf(WEEKLY_RESET) * 1000 + rl.resetBufferMs).toISOString();
  check("(8a) weekly-exhausted, no hook reset → resume == weekly resetsAt(+buffer)", until === expectedUntil);
  check("(8a) deadline is PAST the weekly reset (not now+5h/6h)", new Date(deadline).getTime() > new Date(WEEKLY_RESET).getTime());
  check("(8a) deadline is NOT the flat now+6h no-reset horizon", new Date(deadline).getTime() !== NOW.getTime() + rl.deadlineNoResetMs);
  const naiveUntil = new Date(NOW.getTime() + rl.defaultBackoffMs);
  check("(8a) resume is NOT the flat 5h default (would still be inside the active weekly window)",
    new Date(until).getTime() !== naiveUntil.getTime() && naiveUntil.getTime() < new Date(WEEKLY_RESET).getTime());

  // (8b) hook DOES carry a reset → usage status must never override it (byte-identical to today).
  const hookResetSec = secondsOf("2026-07-07T09:05:00.000Z");
  const explicit = resolveWiring(hookResetSec, status, NOW, rl); // status has a LATER weekly reset — must be ignored
  const expectedExplicitUntil = rateLimitedUntil(hookResetSec, NOW, rl);
  check("(8b) hook-carries-reset path unchanged (usage status ignored)", explicit.until === expectedExplicitUntil);

  // (8c) usage status unavailable → unchanged 5h default backoff / 6h no-reset deadline.
  const unavailable = { available: false, reason: "no token", fetchedAt: null };
  const fallback = resolveWiring(undefined, unavailable, NOW, rl);
  check("(8c) status unavailable → 5h default backoff (unchanged)", fallback.until === new Date(NOW.getTime() + DEFAULT_RATE_LIMIT_BACKOFF_MS).toISOString());
  check("(8c) status unavailable → 6h no-reset deadline (unchanged)", fallback.deadline === new Date(NOW.getTime() + rl.deadlineNoResetMs).toISOString());

  // (8d) status available but nothing exhausted → same unchanged fallback as (8c).
  const notExhausted = {
    available: true, fetchedAt: NOW.toISOString(),
    fiveHour: win(10, "2026-07-07T09:00:00.000Z"), sevenDay: win(20, WEEKLY_RESET),
    sevenDayOpus: null, sevenDaySonnet: null, extraUsage: null,
  };
  const notExhaustedResolved = resolveWiring(undefined, notExhausted, NOW, rl);
  check("(8d) nothing exhausted → same 5h/6h fallback as unavailable", notExhaustedResolved.until === fallback.until && notExhaustedResolved.deadline === fallback.deadline);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — resumeResetFromUsageStatus derives a real reset from the polled plan-usage status (weekly-exhausted, latest-of-both, per-model windows, threshold-tunable, past-reset-ignored), and the onRateLimited wiring resumes AT that reset with a deadline past it instead of looping into a flat 5h/6h fallback — while the hook-carries-reset and status-unavailable paths stay byte-identical."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
