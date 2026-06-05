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
// Task B extends it (no daemon, no claude — Db + validators + the gateway via app.inject, all hermetic):
//   (8) validatePlatformConfigOverride: accept valid/boundary/deep-partial; reject under-floor, over-
//       ceiling, non-int, unknown key — incl. the watcher 5s floor & the rate-limit 1m/24h edges.
//   (9) SQLite store: round-trip via Db.set/getPlatformConfig; singleton upsert (two sets → one row);
//       bad/garbage JSON in the row → getPlatformConfig falls back to {} (never wedges boot).
//   (10) REST /api/platform/config via app.inject: PATCH out-of-range → 400 (field-named); valid →
//        persisted + reflected by GET (override + resolved.platform).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { requireHermeticEnv } from "./_guard.mjs";

// Isolated LOOM_HOME so we are demonstrably never pointed at the real ~/.loom (resolveConfig itself
// reads no files, but the doctrine is: every daemon test runs hermetic). A non-4317 LOOM_PORT keeps
// the app.inject section provably off the prod daemon (inject binds no port, but the doctrine asks it).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "loom-platform-config-"));
process.env.LOOM_HOME = TMP;
process.env.LOOM_PORT = "45317";
requireHermeticEnv();

const { resolveConfig } = await import("@loom/shared");
// dist imports happen AFTER LOOM_HOME is set (paths.ts reads it at module-eval time).
const { Db } = await import("../dist/db.js");
const { validatePlatformConfigOverride } = await import("../dist/mcp/platform.js");
const { buildServer } = await import("../dist/gateway/server.js");

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

// ============================ (8) validatePlatformConfigOverride accept / reject ============================
{
  // Empty / deep-partial accepted; an accepted value round-trips unchanged.
  check("(8) {} accepted", validatePlatformConfigOverride({}).ok === true);
  const dp = validatePlatformConfigOverride({ watchers: { wakeMs: 120000 } });
  check("(8) deep-partial (one watcher field) accepted + round-trips", dp.ok && dp.value.watchers?.wakeMs === 120000);
  const full = validatePlatformConfigOverride({
    rateLimit: { defaultBackoffMs: 3600000, resetBufferMs: 0, recencyWindowMs: 86400000 },
    watchers: { contextWatchMs: 5000, reconcileMs: 3600000 },
    timeouts: { gitOpMs: 1000, gitPushMs: 600000, provisionMs: 1800000, busyStaleMs: 30000 },
  });
  check("(8) full in-range override accepted", full.ok === true);

  // rate-limit edges (per epic BOUNDS): defaultBackoffMs 60000(1m)–86400000(24h).
  check("(8) defaultBackoffMs:59999 (<1m floor) rejected", validatePlatformConfigOverride({ rateLimit: { defaultBackoffMs: 59999 } }).ok === false);
  check("(8) defaultBackoffMs:60000 (1m floor) accepted", validatePlatformConfigOverride({ rateLimit: { defaultBackoffMs: 60000 } }).ok === true);
  check("(8) defaultBackoffMs:86400000 (24h ceiling) accepted", validatePlatformConfigOverride({ rateLimit: { defaultBackoffMs: 86400000 } }).ok === true);
  check("(8) defaultBackoffMs:86400001 (>24h) rejected", validatePlatformConfigOverride({ rateLimit: { defaultBackoffMs: 86400001 } }).ok === false);
  check("(8) resetBufferMs:0 (floor) accepted", validatePlatformConfigOverride({ rateLimit: { resetBufferMs: 0 } }).ok === true);
  check("(8) resetBufferMs:-1 (<0) rejected", validatePlatformConfigOverride({ rateLimit: { resetBufferMs: -1 } }).ok === false);
  check("(8) deadlineNoResetMs:172800000 (48h ceiling) accepted", validatePlatformConfigOverride({ rateLimit: { deadlineNoResetMs: 172800000 } }).ok === true);
  check("(8) deadlineNoResetMs:172800001 (>48h) rejected", validatePlatformConfigOverride({ rateLimit: { deadlineNoResetMs: 172800001 } }).ok === false);

  // watcher floor/ceiling (per epic BOUNDS): watchers.* 5000–3600000, .int().
  check("(8) watcher 4999 (<5s floor) rejected", validatePlatformConfigOverride({ watchers: { idleWatchMs: 4999 } }).ok === false);
  check("(8) watcher 5000 (5s floor) accepted", validatePlatformConfigOverride({ watchers: { idleWatchMs: 5000 } }).ok === true);
  check("(8) watcher 3600000 (ceiling) accepted", validatePlatformConfigOverride({ watchers: { schedulerMs: 3600000 } }).ok === true);
  check("(8) watcher 3600001 (>ceiling) rejected", validatePlatformConfigOverride({ watchers: { schedulerMs: 3600001 } }).ok === false);
  check("(8) watcher non-integer rejected", validatePlatformConfigOverride({ watchers: { wakeMs: 60000.5 } }).ok === false);

  // timeout edges (per epic BOUNDS).
  check("(8) timeouts.gitOpMs:999 (<floor) rejected", validatePlatformConfigOverride({ timeouts: { gitOpMs: 999 } }).ok === false);
  check("(8) timeouts.gitOpMs:120001 (>ceiling) rejected", validatePlatformConfigOverride({ timeouts: { gitOpMs: 120001 } }).ok === false);
  check("(8) timeouts.busyStaleMs:29999 (<floor) rejected", validatePlatformConfigOverride({ timeouts: { busyStaleMs: 29999 } }).ok === false);
  check("(8) timeouts.provisionMs:1800001 (>ceiling) rejected", validatePlatformConfigOverride({ timeouts: { provisionMs: 1800001 } }).ok === false);

  // .strict() unknown-key guards at every level + a field-named reason.
  check("(8) unknown top-level key rejected", validatePlatformConfigOverride({ bogus: 1 }).ok === false);
  const badNested = validatePlatformConfigOverride({ watchers: { bogusWatcher: 5000 } });
  check("(8) unknown nested key rejected", badNested.ok === false);
  const reason = validatePlatformConfigOverride({ timeouts: { gitPushMs: 999 } });
  check("(8) rejection reason names the field", reason.ok === false && /gitPushMs/.test(reason.error));
}

// ============================ (9) SQLite store: round-trip + singleton upsert + bad-JSON→{} ============================
const dbFile = path.join(TMP, "loom.db");
{
  const db = new Db(dbFile);
  try {
    // Fresh store → {} (no row yet).
    check("(9) empty store → {}", JSON.stringify(db.getPlatformConfig()) === "{}");
    // Round-trip a value.
    db.setPlatformConfig({ watchers: { wakeMs: 90000 }, timeouts: { gitPushMs: 60000 } });
    const got = db.getPlatformConfig();
    check("(9) round-trip persists the override", got.watchers?.wakeMs === 90000 && got.timeouts?.gitPushMs === 60000);
    // A SECOND set is an UPSERT, not an insert: the override is REPLACED and there is still ONE row.
    db.setPlatformConfig({ rateLimit: { defaultBackoffMs: 3600000 } });
    const after = db.getPlatformConfig();
    check("(9) second set replaces (no stale watchers key)", after.rateLimit?.defaultBackoffMs === 3600000 && after.watchers === undefined);
    const rowCount = new Database(dbFile, { readonly: true }).prepare("SELECT COUNT(*) AS c FROM platform_config").get().c;
    check("(9) singleton: exactly ONE row after two sets", rowCount === 1);
    // updated_at is stamped.
    const stamped = new Database(dbFile, { readonly: true }).prepare("SELECT updated_at FROM platform_config WHERE id = 1").get().updated_at;
    check("(9) updated_at stamped", typeof stamped === "string" && stamped.length > 0);
  } finally {
    db.close();
  }
  // Corrupt the singleton row's JSON via a separate connection; getPlatformConfig must fall back to {}.
  const raw = new Database(dbFile);
  raw.prepare("UPDATE platform_config SET override_json = '{not valid json' WHERE id = 1").run();
  raw.close();
  const db2 = new Db(dbFile);
  try {
    check("(9) garbage JSON in the row → getPlatformConfig() returns {}", JSON.stringify(db2.getPlatformConfig()) === "{}");
  } finally {
    db2.close();
  }
}

// ============================ (10) REST /api/platform/config via app.inject ============================
{
  const db = new Db(dbFile);
  // Reset to a clean store for the REST assertions (prior section left a garbage row).
  db.setPlatformConfig({});
  const stub = {};
  const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, control: stub, usageStatus: stub });
  try {
    // GET on the (empty) store → override {} + resolved.platform present with defaults.
    const g0 = await app.inject({ method: "GET", url: "/api/platform/config" });
    check("(10) GET 200", g0.statusCode === 200);
    const g0b = g0.json();
    check("(10) GET empty override + resolved defaults", JSON.stringify(g0b.override) === "{}" && g0b.resolved.watchers.wakeMs === 60000 && g0b.resolved.timeouts.gitPushMs === 45000);

    // PATCH out-of-range → 400 with a field-named reason; store untouched.
    const bad = await app.inject({ method: "PATCH", url: "/api/platform/config", payload: { config: { watchers: { wakeMs: 4999 } } } });
    check("(10) PATCH out-of-range → 400", bad.statusCode === 400);
    check("(10) 400 reason names the field", /wakeMs/.test(bad.json().error));
    check("(10) store untouched after a rejected PATCH", JSON.stringify(db.getPlatformConfig()) === "{}");

    // PATCH valid → 200 {ok,override}; persisted + reflected by a follow-up GET (override + resolved).
    const good = await app.inject({ method: "PATCH", url: "/api/platform/config", payload: { config: { watchers: { wakeMs: 120000 }, timeouts: { gitPushMs: 90000 } } } });
    check("(10) valid PATCH → 200 {ok:true}", good.statusCode === 200 && good.json().ok === true);
    check("(10) PATCH echoes the stored override", good.json().override.watchers.wakeMs === 120000);
    check("(10) persisted to the DB", db.getPlatformConfig().watchers?.wakeMs === 120000);
    const g1 = (await app.inject({ method: "GET", url: "/api/platform/config" })).json();
    check("(10) GET reflects the new override", g1.override.watchers.wakeMs === 120000 && g1.override.timeouts.gitPushMs === 90000);
    check("(10) GET resolves the override into resolved.platform", g1.resolved.watchers.wakeMs === 120000 && g1.resolved.timeouts.gitPushMs === 90000);

    // Bare-body form (no `config` wrapper) is also accepted (mirrors the project config PATCH `?? body`).
    const bare = await app.inject({ method: "PATCH", url: "/api/platform/config", payload: { rateLimit: { resetBufferMs: 0 } } });
    check("(10) bare-body PATCH accepted", bare.statusCode === 200 && bare.json().override.rateLimit.resetBufferMs === 0);
  } finally {
    try { await app.close(); } catch { /* ignore */ }
    db.close();
  }
}

// cleanup the temp LOOM_HOME (best-effort; retry for the WAL handle on Windows)
for (let i = 0; i < 5; i++) { try { fs.rmSync(TMP, { recursive: true, force: true }); break; } catch { /* retry */ } }

console.log(failures === 0
  ? "\n✅ ALL PASS — resolveConfig resolves the daemon-global `platform` group (global > LOOM_* env > default; watcher floor-clamp; explicit-0 discipline; deep-partial) AND the two new per-project timeouts; validatePlatformConfigOverride bounds every numeric per the BOUNDS table (incl. watcher 5s floor + rate-limit 1m/24h edges) with .strict() unknown-key + field-named reasons; the SQLite store round-trips, upserts a singleton row, and falls back to {} on garbage JSON; and GET/PATCH /api/platform/config (app.inject) validate → 400-or-persist and reflect the override + resolved.platform."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
