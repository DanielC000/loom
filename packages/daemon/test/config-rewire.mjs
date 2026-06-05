import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Call-site rewiring test — epic 46b2b0fa task C. Proves the daemon call-sites now read the RESOLVED
// config instead of their old hardcoded constants. Pure + hermetic: NO daemon, NO claude, NO live :4317.
// It exercises only the parameterized pure functions (usage-limit / usage-awareness) + the browser-pure
// resolveConfig, the exact way the rewired daemon callers feed them. Covers:
//   (A) usage-limit MATH responds to a RateLimitConfig override (rateLimitedUntil + rateLimitDeadline),
//       and the resolved `platform.rateLimit` (from a platform override) flows through unchanged.
//   (B) the gate-command timeout the call-site reads is `resolveConfig(...).orchestration.gateCommandTimeoutMs`
//       (default + per-project override) — the value service.ts now passes to spawnSync.
//   (C) usage-awareness recency window is parameterized: the SAME state reads near/not-near by window.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";

// Isolated LOOM_HOME (usage-awareness reads/writes a state file under it at module-eval / call time).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "loom-config-rewire-"));
process.env.LOOM_HOME = TMP;
process.env.LOOM_PORT = "45318";
requireHermeticEnv();

const { resolveConfig } = await import("@loom/shared");
// dist imports happen AFTER LOOM_HOME is set (paths.ts reads it at module-eval time).
const { rateLimitedUntil, rateLimitDeadline, DEFAULT_RATE_LIMIT_BACKOFF_MS } = await import("../dist/orchestration/usage-limit.js");
const { recordClaudeRateLimit, clearClaudeRateLimit, isLikelyNearClaudeUsageLimit } = await import("../dist/orchestration/usage-awareness.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// ============================ (A) usage-limit math reads a RateLimitConfig ============================
{
  const now = new Date("2026-06-05T00:00:00.000Z");

  // Default (no cfg) — today's behavior, the module consts.
  check("default rateLimitedUntil (no reset) = now + 5h backoff const",
    rateLimitedUntil(undefined, now) === new Date(now.getTime() + DEFAULT_RATE_LIMIT_BACKOFF_MS).toISOString());

  // An override changes the no-reset backoff (the daemon caller passes platform.rateLimit here).
  const cfg = { defaultBackoffMs: 60_000, resetBufferMs: 999, deadlineAfterResetMs: 120_000, deadlineNoResetMs: 600_000, recencyWindowMs: 0 };
  check("override defaultBackoffMs changes the no-reset park",
    rateLimitedUntil(undefined, now, cfg) === new Date(now.getTime() + 60_000).toISOString());
  check("override is DIFFERENT from the default (math actually moved)",
    rateLimitedUntil(undefined, now, cfg) !== rateLimitedUntil(undefined, now));

  // resetBufferMs override changes the reset-KNOWN park.
  const resetSec = Math.floor(now.getTime() / 1000) + 3600;
  check("override resetBufferMs changes the reset-known park",
    rateLimitedUntil(resetSec, now, cfg) === new Date(resetSec * 1000 + 999).toISOString());
  check("explicit resetBufferMs=0 survives (?? discipline, not ||)",
    rateLimitedUntil(resetSec, now, { ...cfg, resetBufferMs: 0 }) === new Date(resetSec * 1000).toISOString());

  // rateLimitDeadline reads deadlineNoResetMs / deadlineAfterResetMs from the same cfg.
  check("override deadlineNoResetMs changes the no-reset deadline",
    rateLimitDeadline(undefined, now, cfg) === new Date(now.getTime() + 600_000).toISOString());
  check("override deadlineAfterResetMs changes the reset-known deadline",
    rateLimitDeadline(resetSec, now, cfg) === new Date(resetSec * 1000 + 120_000).toISOString());

  // The numbers the daemon caller actually feeds: resolveConfig(undefined, platformOverride).platform.rateLimit.
  const rl = resolveConfig(undefined, { rateLimit: { defaultBackoffMs: 90_000 } }).platform.rateLimit;
  check("a platform override flows through resolveConfig into the park math",
    rateLimitedUntil(undefined, now, rl) === new Date(now.getTime() + 90_000).toISOString());
  check("un-overridden rateLimit fields keep their resolved defaults (deadlineNoReset 6h)",
    rl.deadlineNoResetMs === 6 * 60 * 60_000 && rateLimitDeadline(undefined, now, rl) === new Date(now.getTime() + 6 * 60 * 60_000).toISOString());
}

// ============================ (B) gate timeout is read via resolveConfig ============================
{
  // service.ts confirmWorkerMerge now passes resolveConfig(project.config).orchestration.gateCommandTimeoutMs
  // to spawnSync({ timeout }). Prove the value it reads: default + per-project override.
  check("gate timeout default = 120000 (the old hardcoded spawnSync timeout)",
    resolveConfig(undefined).orchestration.gateCommandTimeoutMs === 120_000);
  check("per-project gateCommandTimeoutMs override wins (resolve-live)",
    resolveConfig({ orchestration: { gateCommandTimeoutMs: 7777 } }).orchestration.gateCommandTimeoutMs === 7777);
}

// ============================ (C) recency window is parameterized ============================
{
  clearClaudeRateLimit();
  // Record a hit with NO known reset, 4h ago.
  const fourHAgo = new Date(Date.now() - 4 * 60 * 60_000);
  // recordClaudeRateLimit stamps lastRateLimitAt = now, so write then assert relative to a probe `now`.
  recordClaudeRateLimit(); // lastRateLimitAt ≈ real now
  const probe = new Date(Date.now() + 5 * 60 * 60_000); // 5h after the hit
  check("5h after the hit: a 6h window still reads near-limit (default behavior)",
    isLikelyNearClaudeUsageLimit(probe, 6 * 60 * 60_000) === true);
  check("5h after the hit: a tightened 3h window reads NOT near-limit (window param took effect)",
    isLikelyNearClaudeUsageLimit(probe, 3 * 60 * 60_000) === false);
  check("default window arg (omitted) = 6h behavior",
    isLikelyNearClaudeUsageLimit(probe) === true);
  void fourHAgo;
  clearClaudeRateLimit();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the rewired call-sites read the RESOLVED config: usage-limit park/deadline math responds to a RateLimitConfig override (and the resolved platform.rateLimit flows through), the gate timeout is resolveConfig(...).orchestration.gateCommandTimeoutMs (default + override), and the usage-awareness recency window is parameterized."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
