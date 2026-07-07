// GLOBAL usage awareness must track the SAME derived reset the per-session park uses (board card
// 2110726d, a fleet-level follow-up to 6df15380). FULLY HERMETIC: no daemon, no claude — only the
// browser-pure usage-limit.js + usage-awareness.js helpers (both → dist), with usage-awareness's
// LOOM_HOME-backed latch file pointed at a throwaway temp dir.
//
// ROOT CAUSE this guards: onRateLimited used to derive `resetsAtSeconds` (real reset, e.g. a weekly
// cap ~16h out) for the PER-SESSION park, but still fed the RAW (usually undefined) hook reset into
// recordClaudeRateLimit — so GLOBAL awareness (isLikelyNearClaudeUsageLimit, consulted by the
// Scheduler / worker_spawn) fell back to its own ~6h recency heuristic and could fire fresh work into
// a still-capped account hours before the real reset cleared.
//
// Covers, mirroring index.ts's onRateLimited EXACTLY (including the recency-floor guard):
//   (1) weekly-exhausted, no hook reset → global awareness holds to the WEEKLY reset, not now+6h.
//   (2) hook carries an explicit reset that's still far out → global awareness holds to it too.
//   (3) the derived reset is SHORTER than the recency floor (e.g. a soon five-hour reset) → the guard
//       must NOT shorten the hold below the recency heuristic (global reset omitted; recency wins).
//   (4) status unavailable / nothing exhausted → unchanged legacy behavior (no lastResetsAt, pure
//       recency-window awareness — byte-identical to before this fix).
import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "loom-rl-global-"));
process.env.LOOM_HOME = TMP;
process.env.LOOM_PORT = "45329";
requireHermeticEnv();

const { resumeResetFromUsageStatus } = await import("../dist/orchestration/usage-limit.js");
const {
  recordClaudeRateLimit, clearClaudeRateLimit, isLikelyNearClaudeUsageLimit, getClaudeUsageLimitRetryAfter,
} = await import("../dist/orchestration/usage-awareness.js");
const { PLATFORM_DEFAULTS } = await import("@loom/shared");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const rl = PLATFORM_DEFAULTS.platform.rateLimit;
const NOW = new Date("2026-07-07T08:00:00.000Z");
const win = (utilization, resetsAt) => ({ utilization, resetsAt });
const secondsOf = (iso) => Math.floor(new Date(iso).getTime() / 1000);

const WEEKLY_RESET = "2026-07-08T00:38:00.000Z"; // ~16h38m out, matching the owner's repro
const FIVE_HOUR_RESET_SOON = "2026-07-07T09:30:00.000Z"; // ~1h30m out — WITHIN the 6h recency floor

// Mirrors onRateLimited's exact composition (index.ts): the derived resetsAtSeconds, then the
// recency-floor guard that decides what (if anything) reaches recordClaudeRateLimit.
function deriveGlobalReset(hookResetsAtSeconds, status, now, cfg) {
  const resetsAtSeconds = hookResetsAtSeconds ?? resumeResetFromUsageStatus(status, now, cfg);
  const recencyFloorSeconds = now.getTime() / 1000 + cfg.recencyWindowMs / 1000;
  return typeof resetsAtSeconds === "number" && resetsAtSeconds >= recencyFloorSeconds ? resetsAtSeconds : undefined;
}

// --- (1) weekly-exhausted, no hook reset → global awareness holds to the WEEKLY reset ---
{
  clearClaudeRateLimit();
  const status = {
    available: true, fetchedAt: NOW.toISOString(),
    fiveHour: win(40, "2026-07-07T09:00:00.000Z"), // NOT exhausted
    sevenDay: win(100, WEEKLY_RESET), // exhausted
    sevenDayOpus: null, sevenDaySonnet: null, extraUsage: null,
  };
  const globalReset = deriveGlobalReset(undefined, status, NOW, rl);
  check("(1) weekly-exhausted → derived global reset IS the weekly reset (extends, not omitted)", globalReset === secondsOf(WEEKLY_RESET));
  recordClaudeRateLimit(globalReset);

  const justAfterSixHours = new Date(NOW.getTime() + rl.recencyWindowMs + 60_000);
  check("(1) 6h+1min after the hit → STILL near the limit (weekly reset, not the 6h recency heuristic)",
    isLikelyNearClaudeUsageLimit(justAfterSixHours, rl.recencyWindowMs) === true);
  check("(1) retry-after == the weekly reset instant",
    getClaudeUsageLimitRetryAfter(justAfterSixHours, rl.recencyWindowMs)?.toISOString() === WEEKLY_RESET);

  const justAfterWeeklyReset = new Date(new Date(WEEKLY_RESET).getTime() + 60_000);
  check("(1) just after the weekly reset → awareness finally relaxes",
    isLikelyNearClaudeUsageLimit(justAfterWeeklyReset, rl.recencyWindowMs) === false);
}

// --- (2) hook carries an explicit far-out reset → global awareness holds to it too ---
{
  clearClaudeRateLimit();
  const farHookReset = secondsOf("2026-07-08T12:00:00.000Z"); // ~28h out
  const globalReset = deriveGlobalReset(farHookReset, undefined, NOW, rl);
  check("(2) explicit hook reset beyond the recency floor → passed through unchanged", globalReset === farHookReset);
  recordClaudeRateLimit(globalReset);
  const justAfterSixHours = new Date(NOW.getTime() + rl.recencyWindowMs + 60_000);
  check("(2) 6h+1min after the hit → still near the limit (explicit far reset wins over recency)",
    isLikelyNearClaudeUsageLimit(justAfterSixHours, rl.recencyWindowMs) === true);
}

// --- (3) derived reset is SHORTER than the recency floor → guard omits it (never SHORTENS the hold) ---
{
  clearClaudeRateLimit();
  const status = {
    available: true, fetchedAt: NOW.toISOString(),
    fiveHour: win(96, FIVE_HOUR_RESET_SOON), // exhausted, resets in ~1h30m — inside the 6h recency floor
    sevenDay: win(20, WEEKLY_RESET), // not exhausted
    sevenDayOpus: null, sevenDaySonnet: null, extraUsage: null,
  };
  // Sanity: the per-session park DOES resolve a real (soon) reset here — only the GLOBAL feed is guarded.
  const perSessionReset = resumeResetFromUsageStatus(status, NOW, rl);
  check("(3) per-session resolution still finds the soon five-hour reset", perSessionReset === secondsOf(FIVE_HOUR_RESET_SOON));

  const globalReset = deriveGlobalReset(undefined, status, NOW, rl);
  check("(3) global reset OMITTED (would shorten the hold below the 6h recency heuristic)", globalReset === undefined);
  // recordClaudeRateLimit always stamps lastRateLimitAt with the REAL wall clock (no injectable "now"),
  // so the recency-window assertions below anchor to the actual hit instant, not the mocked NOW.
  const hitAt = new Date();
  recordClaudeRateLimit(globalReset);

  const justBeforeSixHours = new Date(hitAt.getTime() + rl.recencyWindowMs - 60_000);
  check("(3) just before 6h after the (real) hit → STILL near the limit (recency heuristic, not shortened)",
    isLikelyNearClaudeUsageLimit(justBeforeSixHours, rl.recencyWindowMs) === true);
  const justAfterSixHours = new Date(hitAt.getTime() + rl.recencyWindowMs + 60_000);
  check("(3) just after 6h after the (real) hit → recency heuristic relaxes (no lastResetsAt was recorded, so the soon five-hour reset never overrides recency down OR up)",
    isLikelyNearClaudeUsageLimit(justAfterSixHours, rl.recencyWindowMs) === false);
}

// --- (4) status unavailable / nothing exhausted → global reset omitted (legacy byte-identical behavior) ---
{
  clearClaudeRateLimit();
  const unavailable = { available: false, reason: "no Claude credentials file", fetchedAt: null };
  const globalReset = deriveGlobalReset(undefined, unavailable, NOW, rl);
  check("(4) status unavailable → global reset omitted (unchanged legacy path)", globalReset === undefined);
  const hitAt = new Date();
  recordClaudeRateLimit(globalReset);
  const justAfterSixHours = new Date(hitAt.getTime() + rl.recencyWindowMs + 60_000);
  check("(4) 6h+1min after the (real) hit → recency heuristic relaxes as before", isLikelyNearClaudeUsageLimit(justAfterSixHours, rl.recencyWindowMs) === false);
}

clearClaudeRateLimit();

console.log(failures === 0
  ? "\n✅ ALL PASS — the derived reset (weekly-exhausted or an explicit far hook reset) now reaches GLOBAL usage awareness, holding the Scheduler/worker_spawn gate to the REAL reset instead of relaxing after the old ~6h recency heuristic; a derived reset that would SHORTEN the hold below that heuristic is guarded out, and the unavailable/nothing-exhausted paths stay byte-identical."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
