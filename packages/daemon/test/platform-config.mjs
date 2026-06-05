import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Platform-config resolver-precedence test — FOUNDATION (epic 46b2b0fa task A). Pure + hermetic: NO
// daemon, NO claude, NO Db. It only exercises the browser-pure `resolveConfig(override,
// platformOverride?)` from @loom/shared (→ dist), so it is safe by construction; we still set an
// isolated LOOM_HOME + arm the prod-guard per the test doctrine (NEVER touch prod ~/.loom). Covers:
//   (1) defaults — platform group present with the documented numbers; single-arg callers unchanged.
//   (2) two NEW per-project orchestration timeouts: default + per-project override wins.
//   (3) global override (2nd arg) applies to rateLimit / watchers / timeouts.
//   (4) precedence per GLOBAL value: global override > LOOM_* env > hardcoded default (watchers).
//   (5) watcher floor-clamp: a stray `LOOM_*_INTERVAL_MS=0` (or negative) clamps to 5000, not 0.
//   (6) `??` discipline: an explicit 0 in the global override survives where meaningful (resetBufferMs).
//   (7) deep-partial: tuning ONE field inherits the rest of its group.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";

// Isolated LOOM_HOME so we are demonstrably never pointed at the real ~/.loom (resolveConfig itself
// reads no files, but the doctrine is: every daemon test runs hermetic).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "loom-platform-config-"));
process.env.LOOM_HOME = TMP;
requireHermeticEnv();

const { resolveConfig } = await import("@loom/shared");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Clear every watcher env so default-path assertions are deterministic regardless of the outer shell.
const WATCHER_ENVS = [
  "LOOM_CONTEXT_WATCH_INTERVAL_MS", "LOOM_IDLE_WATCH_INTERVAL_MS", "LOOM_RATE_LIMIT_WATCH_INTERVAL_MS",
  "LOOM_USAGE_POLL_INTERVAL_MS", "LOOM_WAKE_INTERVAL_MS", "LOOM_SCHEDULER_INTERVAL_MS", "LOOM_RECONCILE_INTERVAL_MS",
];
const clearWatcherEnvs = () => { for (const k of WATCHER_ENVS) delete process.env[k]; };

// ============================ (1) DEFAULTS + single-arg compat ============================
clearWatcherEnvs();
{
  const c = resolveConfig(undefined);
  const p = c.platform;
  check("(1) platform group present on resolveConfig(undefined)", !!p && !!p.rateLimit && !!p.watchers && !!p.timeouts);
  check("(1) rateLimit defaults", p.rateLimit.defaultBackoffMs === 18000000 && p.rateLimit.resetBufferMs === 10000 &&
    p.rateLimit.deadlineAfterResetMs === 1800000 && p.rateLimit.deadlineNoResetMs === 21600000 && p.rateLimit.recencyWindowMs === 21600000);
  check("(1) watcher defaults (60000 except reconcile 10000)", p.watchers.contextWatchMs === 60000 && p.watchers.idleWatchMs === 60000 &&
    p.watchers.rateLimitWatchMs === 60000 && p.watchers.usagePollMs === 60000 && p.watchers.wakeMs === 60000 &&
    p.watchers.schedulerMs === 60000 && p.watchers.reconcileMs === 10000);
  check("(1) timeout defaults", p.timeouts.gitOpMs === 15000 && p.timeouts.gitLocalMs === 15000 &&
    p.timeouts.gitPushMs === 45000 && p.timeouts.provisionMs === 180000 && p.timeouts.busyStaleMs === 300000);
  // The two NEW per-project orchestration timeouts default through.
  check("(1) gateCommandTimeoutMs default 120000", c.orchestration.gateCommandTimeoutMs === 120000);
  check("(1) alertWebhookTimeoutMs default 5000", c.orchestration.alertWebhookTimeoutMs === 5000);
  // Single-arg callers behave identically with an override too (no 2nd arg → platform defaults).
  check("(1) single-arg w/ project override still yields platform defaults",
    resolveConfig({ orchestration: { gateCommand: "pnpm build" } }).platform.timeouts.gitPushMs === 45000);
}

// ============================ (2) per-project timeouts — override wins ============================
clearWatcherEnvs();
{
  const c = resolveConfig({ orchestration: { gateCommandTimeoutMs: 300000, alertWebhookTimeoutMs: 12000 } });
  check("(2) per-project gateCommandTimeoutMs override wins", c.orchestration.gateCommandTimeoutMs === 300000);
  check("(2) per-project alertWebhookTimeoutMs override wins", c.orchestration.alertWebhookTimeoutMs === 12000);
  // These are PER-PROJECT (no global layer): the 2nd arg can't reach them, so the project value stands.
  const c2 = resolveConfig({ orchestration: { gateCommandTimeoutMs: 7000 } }, { timeouts: { gitOpMs: 1234 } });
  check("(2) per-project timeout unaffected by platform override arg", c2.orchestration.gateCommandTimeoutMs === 7000);
}

// ============================ (3) global override applies to each group ============================
clearWatcherEnvs();
{
  const c = resolveConfig(undefined, {
    rateLimit: { defaultBackoffMs: 90000, recencyWindowMs: 7200000 },
    watchers: { contextWatchMs: 30000 },
    timeouts: { gitPushMs: 60000, busyStaleMs: 600000 },
  });
  check("(3) global rateLimit override applies", c.platform.rateLimit.defaultBackoffMs === 90000 && c.platform.rateLimit.recencyWindowMs === 7200000);
  check("(3) global watcher override applies", c.platform.watchers.contextWatchMs === 30000);
  check("(3) global timeout override applies", c.platform.timeouts.gitPushMs === 60000 && c.platform.timeouts.busyStaleMs === 600000);
  // (7) deep-partial: untouched siblings inherit their default.
  check("(7) untouched rateLimit sibling inherits default", c.platform.rateLimit.resetBufferMs === 10000);
  check("(7) untouched watcher sibling inherits default", c.platform.watchers.idleWatchMs === 60000);
  check("(7) untouched timeout sibling inherits default", c.platform.timeouts.gitOpMs === 15000);
  // Global override also reaches the platform group on the full project-override path (both branches).
  const c2 = resolveConfig({ docLint: false }, { watchers: { reconcileMs: 25000 } });
  check("(3) global override applies on the project-override branch too", c2.platform.watchers.reconcileMs === 25000 && c2.docLint === false);
}

// ============================ (4) precedence: global > env > default (watchers) ============================
clearWatcherEnvs();
{
  // env beats default
  process.env.LOOM_CONTEXT_WATCH_INTERVAL_MS = "45000";
  check("(4) env beats default", resolveConfig(undefined).platform.watchers.contextWatchMs === 45000);
  // global override beats env
  check("(4) global override beats env",
    resolveConfig(undefined, { watchers: { contextWatchMs: 33000 } }).platform.watchers.contextWatchMs === 33000);
  clearWatcherEnvs();
}

// ============================ (5) watcher floor-clamp on stray 0 / negative env ============================
clearWatcherEnvs();
{
  process.env.LOOM_IDLE_WATCH_INTERVAL_MS = "0";
  check("(5) env 0 floor-clamped to 5000 (not 0, not default)", resolveConfig(undefined).platform.watchers.idleWatchMs === 5000);
  process.env.LOOM_IDLE_WATCH_INTERVAL_MS = "-100";
  check("(5) negative env floor-clamped to 5000", resolveConfig(undefined).platform.watchers.idleWatchMs === 5000);
  process.env.LOOM_IDLE_WATCH_INTERVAL_MS = "9000";
  check("(5) above-floor env passes through", resolveConfig(undefined).platform.watchers.idleWatchMs === 9000);
  // blank / non-numeric env → default (not clamped)
  process.env.LOOM_IDLE_WATCH_INTERVAL_MS = "   ";
  check("(5) blank env ignored → default 60000", resolveConfig(undefined).platform.watchers.idleWatchMs === 60000);
  process.env.LOOM_IDLE_WATCH_INTERVAL_MS = "nope";
  check("(5) non-numeric env ignored → default 60000", resolveConfig(undefined).platform.watchers.idleWatchMs === 60000);
  clearWatcherEnvs();
}

// ============================ (6) `??` discipline: explicit 0 survives where meaningful ============================
clearWatcherEnvs();
{
  // resetBufferMs:0 is a valid value (no slack); it must NOT fall through to the 10000 default.
  check("(6) global resetBufferMs:0 survives (not swallowed)",
    resolveConfig(undefined, { rateLimit: { resetBufferMs: 0 } }).platform.rateLimit.resetBufferMs === 0);
}

// cleanup the temp LOOM_HOME (best-effort)
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

console.log(failures === 0
  ? "\n✅ ALL PASS — resolveConfig(override, platformOverride?) resolves the new daemon-global `platform` group with precedence GLOBAL override > LOOM_* env > default (watchers), floor-clamps stray watcher env to 5000, preserves explicit 0 where meaningful, exposes the two new per-project timeouts (override-wins, no global layer), and leaves every single-arg caller byte-identical."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
