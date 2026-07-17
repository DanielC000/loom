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
import net from "node:net";
import { fileURLToPath } from "node:url";
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
const { validatePlatformConfigOverride, validatePlatformConfigPatch } = await import("../dist/mcp/platform.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { detectIntegrations } = await import("../dist/integrations/detect.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fakeOdCli = path.join(__dirname, "fixtures", "fake-open-design-cli.mjs");

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
  // companionVoiceEnabled defaults OFF (owner-directed opt-in for companion voice provisioning).
  check("(1) companionVoiceEnabled defaults false", p.companionVoiceEnabled === false);
}

// ============================ (1b) companionVoiceEnabled — global override wins ============================
clearWatcherEnvs();
{
  check("(1b) global override true wins",
    resolveConfig(undefined, { companionVoiceEnabled: true }).platform.companionVoiceEnabled === true);
  check("(1b) no override still defaults false",
    resolveConfig(undefined, {}).platform.companionVoiceEnabled === false);
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
  // exhaustedThresholdPct edges (0-100 utilization scale, bounded 50-100 — a threshold below 50% would
  // park on a barely-used window; card 6df15380's resumeResetFromUsageStatus tunable).
  check("(8) exhaustedThresholdPct:49 (<50 floor) rejected", validatePlatformConfigOverride({ rateLimit: { exhaustedThresholdPct: 49 } }).ok === false);
  check("(8) exhaustedThresholdPct:50 (floor) accepted", validatePlatformConfigOverride({ rateLimit: { exhaustedThresholdPct: 50 } }).ok === true);
  check("(8) exhaustedThresholdPct:100 (ceiling) accepted", validatePlatformConfigOverride({ rateLimit: { exhaustedThresholdPct: 100 } }).ok === true);
  check("(8) exhaustedThresholdPct:101 (>100 ceiling) rejected", validatePlatformConfigOverride({ rateLimit: { exhaustedThresholdPct: 101 } }).ok === false);
  check("(8) exhaustedThresholdPct non-integer rejected", validatePlatformConfigOverride({ rateLimit: { exhaustedThresholdPct: 90.5 } }).ok === false);

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

  // companionVoiceEnabled: a plain boolean, accepted both ways, non-boolean rejected.
  check("(8) companionVoiceEnabled:true accepted", validatePlatformConfigOverride({ companionVoiceEnabled: true }).ok === true);
  check("(8) companionVoiceEnabled:false accepted", validatePlatformConfigOverride({ companionVoiceEnabled: false }).ok === true);
  check("(8) companionVoiceEnabled non-boolean rejected", validatePlatformConfigOverride({ companionVoiceEnabled: "yes" }).ok === false);
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

    // exhaustedThresholdPct is REACHABLE via REST (card 6df15380 review finding: it must not be a
    // dead tunable pinned at its 95 default because the .strict() schema rejected the key wholesale).
    const thresholdGood = await app.inject({ method: "PATCH", url: "/api/platform/config", payload: { rateLimit: { exhaustedThresholdPct: 90 } } });
    check("(10) PATCH rateLimit.exhaustedThresholdPct:90 accepted (not 400'd)", thresholdGood.statusCode === 200 && thresholdGood.json().override.rateLimit.exhaustedThresholdPct === 90);
    check("(10) exhaustedThresholdPct persisted + resolvable", db.getPlatformConfig().rateLimit?.exhaustedThresholdPct === 90);
    const thresholdLow = await app.inject({ method: "PATCH", url: "/api/platform/config", payload: { rateLimit: { exhaustedThresholdPct: 40 } } });
    check("(10) PATCH rateLimit.exhaustedThresholdPct:40 (<50 floor) → 400", thresholdLow.statusCode === 400 && /exhaustedThresholdPct/.test(thresholdLow.json().error));
    const thresholdHigh = await app.inject({ method: "PATCH", url: "/api/platform/config", payload: { rateLimit: { exhaustedThresholdPct: 120 } } });
    check("(10) PATCH rateLimit.exhaustedThresholdPct:120 (>100 ceiling) → 400", thresholdHigh.statusCode === 400 && /exhaustedThresholdPct/.test(thresholdHigh.json().error));
    check("(10) rejected PATCHes did not clobber the persisted 90", db.getPlatformConfig().rateLimit?.exhaustedThresholdPct === 90);
  } finally {
    try { await app.close(); } catch { /* ignore */ }
    db.close();
  }
}

// ============================ (11) operatorEnabled false→true PATCH seeds the Elevated Operator agent ============================
// Bucket 2b hardening follow-up: seedOperatorAgent used to run ONLY in the boot seed sequence, so flipping
// platform.operatorEnabled on via the Settings PATCH left the bundled "Elevated Operator" convenience agent
// missing from the reserved "Platform" home until the next daemon restart. The PATCH handler now kicks the
// idempotent seed itself on a genuine false→true transition (best-effort — a seed failure must not fail the
// config write).
{
  const { seedSetupHome, OPERATOR_AGENT_NAME } = await import("../dist/setup/seed.js");
  const opDbFile = path.join(TMP, "operator-seed.db");
  const db = new Db(opDbFile);
  try {
    db.setPlatformConfig({}); // operatorEnabled defaults false
    const seeded = seedSetupHome(db); // seed-if-absent the reserved "Platform" home so seedOperatorAgent has somewhere to attach
    check("(11) reserved Platform home seeded", seeded.length > 0);
    const home = db.getReservedProjectByName("Platform");
    check("(11) reserved Platform home resolvable", !!home);

    const stub = {};
    const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, control: stub, usageStatus: stub });
    try {
      check("(11) no operator agent before the flag is ever enabled",
        !db.listAgents(home.id).some((a) => a.name === OPERATOR_AGENT_NAME));

      // false → true PATCH must seed the agent immediately — no daemon restart needed.
      const flipOn = await app.inject({ method: "PATCH", url: "/api/platform/config", payload: { operatorEnabled: true } });
      check("(11) PATCH operatorEnabled:true → 200", flipOn.statusCode === 200);
      check("(11) Elevated Operator agent present right after the false→true PATCH",
        db.listAgents(home.id).some((a) => a.name === OPERATOR_AGENT_NAME));
      const countAfterFirst = db.listAgents(home.id).filter((a) => a.name === OPERATOR_AGENT_NAME).length;
      check("(11) exactly one operator agent after the first flip", countAfterFirst === 1);

      // A second true→true PATCH is not a fresh false→true transition — must NOT double-seed.
      const flipStillOn = await app.inject({ method: "PATCH", url: "/api/platform/config", payload: { operatorEnabled: true } });
      check("(11) second true→true PATCH → 200", flipStillOn.statusCode === 200);
      const countAfterSecond = db.listAgents(home.id).filter((a) => a.name === OPERATOR_AGENT_NAME).length;
      check("(11) no double-seed on a true→true PATCH", countAfterSecond === 1);
    } finally {
      try { await app.close(); } catch { /* ignore */ }
    }
  } finally {
    db.close();
  }
}

// ============================ (12) PATCH shallow-merges onto the persisted config (no clobber) ============================
// Regression guard: the REST PATCH handler used to call db.setPlatformConfig(v.value) with ONLY the
// submitted fields, blindly REPLACING the whole persisted blob — so a Settings Save that resubmitted
// just one toggle silently dropped every other already-set field (real incident: coalesceAgentMessages
// flipped by an unrelated Save). The handler now shallow-merges the incoming top-level keys onto the
// existing persisted config before persisting.
{
  const mergeDbFile = path.join(TMP, "merge-guard.db");
  const db = new Db(mergeDbFile);
  const stub = {};
  const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, control: stub, usageStatus: stub });
  try {
    // Seed TWO top-level fields directly (bypassing the handler) so we start from a known persisted state.
    db.setPlatformConfig({ rateLimit: { defaultBackoffMs: 1800000 }, coalesceAgentMessages: true });
    const before = db.getPlatformConfig();
    check("(12) seed: two fields persisted", before.rateLimit?.defaultBackoffMs === 1800000 && before.coalesceAgentMessages === true);

    // PATCH a THIRD, unrelated top-level field only.
    const patch = await app.inject({ method: "PATCH", url: "/api/platform/config", payload: { watchers: { wakeMs: 90000 } } });
    check("(12) single-field PATCH → 200", patch.statusCode === 200 && patch.json().ok === true);

    const after = db.getPlatformConfig();
    check("(12) untouched sibling #1 (rateLimit) is byte-identical", after.rateLimit?.defaultBackoffMs === 1800000);
    check("(12) untouched sibling #2 (coalesceAgentMessages) is byte-identical", after.coalesceAgentMessages === true);
    check("(12) the patched field actually took", after.watchers?.wakeMs === 90000);

    // The response's echoed override reflects the full persisted (merged) config, matching GET's shape,
    // not just the submitted delta.
    const echoed = patch.json().override;
    check("(12) PATCH response echoes the full merged override, not just the submitted delta",
      echoed.rateLimit?.defaultBackoffMs === 1800000 && echoed.coalesceAgentMessages === true && echoed.watchers?.wakeMs === 90000);
  } finally {
    try { await app.close(); } catch { /* ignore */ }
    db.close();
  }
}

// ============================ (13) schedulerEnabled moved to daemon-global platform config ============================
// Card 1debd457: the owner-facing scheduler toggle used to be a per-project orchestration.schedulerEnabled
// field the boot gate never read (index.ts:676-677 only ever consulted resolved.orchestration.
// schedulerEnabled off the PLATFORM override, resolveConfig(undefined, platformOverride)) — so no
// persistent path could enable it, only the LOOM_SCHEDULER_ENABLED env var. Moved to
// PlatformConfigOverride.schedulerEnabled so the toggle actually reaches the boot gate; the per-project
// key is now a REJECTED unknown key on both the human and agent schemas (regression guard so it can't
// silently no-op again).
{
  const { validateProjectConfigOverride, validateAgentProjectConfigOverride } = await import("../dist/mcp/platform.js");

  // resolveConfig: the platform override reaches resolved.orchestration.schedulerEnabled, on BOTH the
  // no-project-override fast path and the full merge path.
  check("(13) default schedulerEnabled false (no override at all)", resolveConfig(undefined).orchestration.schedulerEnabled === false);
  check("(13) platform override true reaches resolved.orchestration.schedulerEnabled (no-project-override fast path)",
    resolveConfig(undefined, { schedulerEnabled: true }).orchestration.schedulerEnabled === true);
  check("(13) platform override true reaches resolved.orchestration.schedulerEnabled (WITH a project override present)",
    resolveConfig({ docLint: false }, { schedulerEnabled: true }).orchestration.schedulerEnabled === true);
  check("(13) platform override explicit false survives (not swallowed to default)",
    resolveConfig(undefined, { schedulerEnabled: false }).orchestration.schedulerEnabled === false);

  // Backward compat: a STALE per-project orchestration.schedulerEnabled (accepted before this field
  // moved) is now simply IGNORED by the merge, never read — it can neither enable the scheduler on its
  // own nor override a real platform-level decision.
  check("(13) stale per-project orchestration.schedulerEnabled alone (no platform override) does NOT enable it",
    resolveConfig({ orchestration: { schedulerEnabled: true } }).orchestration.schedulerEnabled === false);
  check("(13) stale per-project orchestration.schedulerEnabled cannot override the platform value either way",
    resolveConfig({ orchestration: { schedulerEnabled: true } }, { schedulerEnabled: false }).orchestration.schedulerEnabled === false);

  // validatePlatformConfigOverride: accepts the new daemon-global field, rejects a non-boolean.
  check("(13) platformConfigOverrideSchema accepts schedulerEnabled:true", validatePlatformConfigOverride({ schedulerEnabled: true }).ok === true);
  check("(13) platformConfigOverrideSchema accepts schedulerEnabled:false", validatePlatformConfigOverride({ schedulerEnabled: false }).ok === true);
  check("(13) platformConfigOverrideSchema rejects non-boolean schedulerEnabled", validatePlatformConfigOverride({ schedulerEnabled: "yes" }).ok === false);

  // Per-project schemas (both the human REST path and the agent-facing loom-platform/loom-setup path)
  // REJECT orchestration.schedulerEnabled as an unrecognized key — it's daemon-global now, not
  // per-project, so a NEW attempt to set it per-project 400s instead of silently no-op-ing.
  const humanReject = validateProjectConfigOverride({ orchestration: { schedulerEnabled: true } });
  check("(13) per-project (human) schema REJECTS orchestration.schedulerEnabled", humanReject.ok === false);
  const agentReject = validateAgentProjectConfigOverride({ orchestration: { schedulerEnabled: true } });
  check("(13) per-project (agent) schema REJECTS orchestration.schedulerEnabled", agentReject.ok === false);
}

// ============================ (14) host-tool integrations (card 8dc5ebb9) ============================
{
  // --- resolvePlatform: default + override precedence + deep-partial sibling isolation ---
  check("(14) default resolveConfig(undefined).platform.integrations ⇒ both tools present, no path set",
    resolveConfig(undefined).platform.integrations.openDesign.path === undefined &&
    resolveConfig(undefined).platform.integrations.codescape.path === undefined);
  const withOd = resolveConfig(undefined, { integrations: { openDesign: { path: "/abs/od" } } });
  check("(14) a global integrations.openDesign.path override reaches resolved.platform.integrations",
    withOd.platform.integrations.openDesign.path === "/abs/od");
  check("(14) untouched sibling (codescape) still inherits the default (deep-partial)",
    withOd.platform.integrations.codescape.path === undefined);

  // --- validatePlatformConfigOverride: accept / reject ---
  check("(14) {integrations:{}} accepted", validatePlatformConfigOverride({ integrations: {} }).ok === true);
  const okOne = validatePlatformConfigOverride({ integrations: { openDesign: { path: "/abs/od" } } });
  check("(14) one-tool integrations override accepted + round-trips", okOne.ok && okOne.value.integrations?.openDesign?.path === "/abs/od");
  check("(14) unknown nested key under a tool rejected", validatePlatformConfigOverride({ integrations: { openDesign: { bogus: 1 } } }).ok === false);
  check("(14) unknown top-level tool name rejected", validatePlatformConfigOverride({ integrations: { unknownTool: { path: "/x" } } }).ok === false);
  check("(14) non-string path rejected", validatePlatformConfigOverride({ integrations: { codescape: { path: 123 } } }).ok === false);
  check("(14) empty-string path rejected (min(1))", validatePlatformConfigOverride({ integrations: { codescape: { path: "" } } }).ok === false);

  // --- (14b) full stdio MCP spec (card e8eee68c): mcpConfig schema validation ---
  const odMcpSpec = { command: "/abs/od.exe", args: ["/abs/daemon-cli.mjs", "mcp"], env: { OD_DATA_DIR: "/x", ELECTRON_RUN_AS_NODE: "1" } };
  const okSpec = validatePlatformConfigOverride({ integrations: { openDesign: { mcpConfig: odMcpSpec } } });
  check("(14b) a full mcpConfig (command+args+env) accepted + round-trips",
    okSpec.ok && JSON.stringify(okSpec.value.integrations?.openDesign?.mcpConfig) === JSON.stringify(odMcpSpec));
  check("(14b) mcpConfig with ONLY command (args/env both optional) accepted",
    validatePlatformConfigOverride({ integrations: { openDesign: { mcpConfig: { command: "/abs/od.exe" } } } }).ok === true);
  check("(14b) mcpConfig missing 'command' rejected", validatePlatformConfigOverride({ integrations: { openDesign: { mcpConfig: { args: ["mcp"] } } } }).ok === false);
  check("(14b) mcpConfig with empty-string command rejected (min(1))",
    validatePlatformConfigOverride({ integrations: { openDesign: { mcpConfig: { command: "" } } } }).ok === false);
  check("(14b) mcpConfig.args with a non-string element rejected",
    validatePlatformConfigOverride({ integrations: { openDesign: { mcpConfig: { command: "/abs/od.exe", args: ["mcp", 5] } } } }).ok === false);
  check("(14b) mcpConfig.env with a non-string value rejected",
    validatePlatformConfigOverride({ integrations: { openDesign: { mcpConfig: { command: "/abs/od.exe", env: { X: 5 } } } } }).ok === false);
  check("(14b) mcpConfig with an unknown nested key rejected (.strict())",
    validatePlatformConfigOverride({ integrations: { openDesign: { mcpConfig: { command: "/abs/od.exe", bogus: 1 } } } }).ok === false);
  check("(14b) path and mcpConfig coexist on the same tool (path is the fallback, mcpConfig wins at spawn time)",
    validatePlatformConfigOverride({ integrations: { openDesign: { path: "/abs/od", mcpConfig: odMcpSpec } } }).ok === true);
  check("(14b) codescape is path-only: an mcpConfig is REJECTED at validation (fail-closed, not silently ignored)",
    validatePlatformConfigOverride({ integrations: { codescape: { mcpConfig: odMcpSpec } } }).ok === false);
  check("(14b) codescape still accepts a bare path override",
    validatePlatformConfigOverride({ integrations: { codescape: { path: "/abs/codescape" } } }).ok === true);

  // --- (14b) resolvePlatform threads mcpConfig through, deep-partial-isolated from codescape/path ---
  const withOdMcp = resolveConfig(undefined, { integrations: { openDesign: { mcpConfig: odMcpSpec } } });
  check("(14b) a global integrations.openDesign.mcpConfig override reaches resolved.platform.integrations",
    JSON.stringify(withOdMcp.platform.integrations.openDesign.mcpConfig) === JSON.stringify(odMcpSpec));
  check("(14b) default resolveConfig(undefined).platform.integrations.openDesign.mcpConfig is undefined",
    resolveConfig(undefined).platform.integrations.openDesign.mcpConfig === undefined);

  // --- SQLite round-trip ---
  const intDbFile = path.join(TMP, "integrations.db");
  {
    const db = new Db(intDbFile);
    try {
      db.setPlatformConfig({ integrations: { codescape: { path: "/abs/cs" } } });
      check("(14) DB round-trip persists integrations.codescape.path", db.getPlatformConfig().integrations?.codescape?.path === "/abs/cs");
    } finally {
      db.close();
    }
  }

  // --- Schema/migration discipline: a PRE-migration blob (no `integrations` key at all — the shape every
  // existing DB has before this card) must boot-read cleanly and resolve the new key's defaults, never
  // throw. Mirrors getPlatformConfig's existing "garbage JSON ⇒ {}" tolerance, but for a legitimate OLDER
  // valid shape rather than corrupt JSON — this table is a single JSON blob column (no ALTER/migration
  // required), so an existing row simply lacks the new nested key until a human sets one. ---
  const preMigrationFile = path.join(TMP, "pre-migration.db");
  {
    const db = new Db(preMigrationFile); // CREATE TABLE IF NOT EXISTS runs; row absent yet
    const raw = new Database(preMigrationFile);
    // Simulate a real pre-card DB: a platform_config row whose JSON has OTHER fields but no `integrations`.
    raw.prepare(
      `INSERT INTO platform_config (id, override_json, updated_at) VALUES (1, @json, @now)
       ON CONFLICT(id) DO UPDATE SET override_json = @json, updated_at = @now`,
    ).run({ json: JSON.stringify({ watchers: { wakeMs: 45000 }, coalesceAgentMessages: true }), now: new Date().toISOString() });
    raw.close();
    const db2 = new Db(preMigrationFile);
    try {
      const override = db2.getPlatformConfig();
      check("(14) pre-migration blob (no `integrations` key) reads back untouched", override.watchers?.wakeMs === 45000 && override.integrations === undefined);
      const resolved = resolveConfig(undefined, override);
      check("(14) resolveConfig against a pre-migration override defaults integrations cleanly (no throw)",
        resolved.platform.integrations.openDesign.path === undefined && resolved.platform.integrations.codescape.path === undefined);
      check("(14) resolveConfig against a pre-migration override still resolves its OWN fields correctly",
        resolved.platform.watchers.wakeMs === 45000 && resolved.platform.coalesceAgentMessages === true);
    } finally {
      db2.close();
    }
    db.close();
  }

  // --- REST /api/platform/config: the `integrations` key rides the EXISTING PATCH surface, and a
  // sibling-field PATCH doesn't clobber it (mirrors test (12)'s shallow-merge-onto-persisted guard) ---
  {
    const restDbFile = path.join(TMP, "integrations-rest.db");
    const db = new Db(restDbFile);
    const stub = {};
    const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, control: stub, usageStatus: stub });
    try {
      const patch = await app.inject({ method: "PATCH", url: "/api/platform/config", payload: { integrations: { openDesign: { path: fakeOdCli } } } });
      check("(14) PATCH integrations.openDesign.path → 200", patch.statusCode === 200 && patch.json().override.integrations.openDesign.path === fakeOdCli);
      check("(14) persisted to the DB", db.getPlatformConfig().integrations?.openDesign?.path === fakeOdCli);

      const bad = await app.inject({ method: "PATCH", url: "/api/platform/config", payload: { integrations: { openDesign: { path: 5 } } } });
      check("(14) PATCH a non-string path → 400", bad.statusCode === 400 && /integrations/.test(bad.json().error));
      check("(14) rejected PATCH did not clobber the persisted path", db.getPlatformConfig().integrations?.openDesign?.path === fakeOdCli);

      // A sibling top-level field PATCH must leave `integrations` byte-identical (shallow-merge, test (12)'s guard).
      const siblingPatch = await app.inject({ method: "PATCH", url: "/api/platform/config", payload: { watchers: { wakeMs: 90000 } } });
      check("(14) sibling-field PATCH → 200", siblingPatch.statusCode === 200);
      check("(14) sibling-field PATCH leaves integrations untouched", db.getPlatformConfig().integrations?.openDesign?.path === fakeOdCli);

      // GET reflects it too.
      const g = (await app.inject({ method: "GET", url: "/api/platform/config" })).json();
      check("(14) GET /api/platform/config reflects the persisted integrations override", g.override.integrations?.openDesign?.path === fakeOdCli);

      // CLEAR-BACK (code-review fix): the whole-key shallow-merge means a submitted `integrations` object
      // REPLACES the persisted one wholesale — so a caller that resends `{ openDesign: {} }` (path omitted,
      // exactly what the fixed Settings form now always sends for a blanked field) actually CLEARS the
      // previously-set path, rather than the stale path surviving because the key was omitted entirely
      // (the pre-fix Settings behavior). This is the backend half of the fix; the browser half (Settings.tsx
      // always emitting `integrations`) is covered end-to-end by e2e/settings.spec.ts.
      const clear = await app.inject({ method: "PATCH", url: "/api/platform/config", payload: { integrations: { openDesign: {} } } });
      check("(14) PATCH integrations.openDesign:{} (path omitted) → 200", clear.statusCode === 200);
      check("(14) clear-back: the persisted path is actually GONE, not stale", db.getPlatformConfig().integrations?.openDesign?.path === undefined);
      const gAfterClear = (await app.inject({ method: "GET", url: "/api/platform/config" })).json();
      check("(14) clear-back: GET reflects no path (resolves to env/none on the next spawn)", gAfterClear.override.integrations?.openDesign?.path === undefined);
    } finally {
      try { await app.close(); } catch { /* ignore */ }
      db.close();
    }
  }

  // --- (14b) REST /api/platform/config: mcpConfig rides the SAME PATCH surface, round-trips, and an
  // invalid shape 400s without clobbering the persisted spec. ---
  {
    const mcpRestDbFile = path.join(TMP, "integrations-mcp-rest.db");
    const db = new Db(mcpRestDbFile);
    const stub = {};
    const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, control: stub, usageStatus: stub });
    try {
      const patch = await app.inject({ method: "PATCH", url: "/api/platform/config", payload: { integrations: { openDesign: { mcpConfig: odMcpSpec } } } });
      check("(14b) PATCH integrations.openDesign.mcpConfig → 200", patch.statusCode === 200);
      check("(14b) persisted to the DB", JSON.stringify(db.getPlatformConfig().integrations?.openDesign?.mcpConfig) === JSON.stringify(odMcpSpec));

      const badMcp = await app.inject({ method: "PATCH", url: "/api/platform/config", payload: { integrations: { openDesign: { mcpConfig: { args: ["mcp"] } } } } });
      check("(14b) PATCH an mcpConfig missing 'command' → 400", badMcp.statusCode === 400 && /integrations/.test(badMcp.json().error));
      check("(14b) rejected PATCH did not clobber the persisted mcpConfig",
        JSON.stringify(db.getPlatformConfig().integrations?.openDesign?.mcpConfig) === JSON.stringify(odMcpSpec));
    } finally {
      try { await app.close(); } catch { /* ignore */ }
      db.close();
    }
  }

  // --- GET /api/integrations: the live detect/validate read, exercised via the REAL detectIntegrations()
  // (never mocked) — proves the three states without a real OD/Codescape install. ---
  {
    // A deterministically-CLOSED port for the "unreachable" case (code-review fix): bind an ephemeral
    // listener, capture its port, then close it — a subsequent connect to that exact port reliably
    // refuses, unlike gambling on OD's hardcoded default 7456 happening to be free on whatever host runs
    // this test. detectIntegrations' odDaemonPort override is a TEST SEAM ONLY (production always probes
    // the real OD_DAEMON_PORT default).
    const closedPort = await new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.listen(0, "127.0.0.1", () => {
        const p = srv.address().port;
        srv.close((err) => (err ? reject(err) : resolve(p)));
      });
      srv.once("error", reject);
    });

    // Nothing configured at all (neither DB nor env) ⇒ not-found, source none, for both tools.
    const savedOdEnv = process.env.LOOM_OPEN_DESIGN_BIN;
    const savedCsEnv = process.env.LOOM_CODESCAPE_BIN;
    delete process.env.LOOM_OPEN_DESIGN_BIN;
    delete process.env.LOOM_CODESCAPE_BIN;
    const none = await detectIntegrations({}, { odDaemonPort: closedPort });
    const odNone = none.find((s) => s.slug === "openDesign");
    const csNone = none.find((s) => s.slug === "codescape");
    check("(14) detectIntegrations: nothing configured ⇒ openDesign not-found, source none", odNone.state === "not-found" && odNone.source === "none" && odNone.path === null);
    check("(14) detectIntegrations: nothing configured ⇒ codescape not-found, source none", csNone.state === "not-found" && csNone.source === "none" && csNone.path === null);

    // A bogus configured path ⇒ not-found, source db (misconfigured, not merely absent).
    const bogus = await detectIntegrations({ integrations: { openDesign: { path: path.join(TMP, "does-not-exist.mjs") }, codescape: { path: path.join(TMP, "also-missing") } } }, { odDaemonPort: closedPort });
    check("(14) detectIntegrations: a bogus DB path ⇒ not-found, source db", bogus.find((s) => s.slug === "openDesign").state === "not-found" && bogus.find((s) => s.slug === "openDesign").source === "db");

    // A REAL, existing OD fixture ⇒ the binary resolves (detected) but the reachability probe targets our
    // deterministically-closed port, so it correctly downgrades to "unreachable" (residual risk 2's exact
    // scenario) rather than falsely reporting "detected" — with no dependency on what's bound to 7456.
    const odReachable = await detectIntegrations({ integrations: { openDesign: { path: fakeOdCli } } }, { odDaemonPort: closedPort });
    const od = odReachable.find((s) => s.slug === "openDesign");
    check("(14) detectIntegrations: a real OD binary but no daemon listening ⇒ unreachable (not falsely detected)",
      od.state === "unreachable" && od.source === "db" && od.path === fakeOdCli && typeof od.detail === "string");

    // Codescape has no reachability concept — a real, existing bin (process.execPath stands in for a
    // real compiled binary) is simply "detected".
    const csDetected = await detectIntegrations({ integrations: { codescape: { path: process.execPath } } });
    const cs = csDetected.find((s) => s.slug === "codescape");
    check("(14) detectIntegrations: a real codescape bin ⇒ detected (no reachability check)", cs.state === "detected" && cs.source === "db");

    // --- (14b) a full mcpConfig (card e8eee68c): the TCP daemon-port probe doesn't apply to the
    // desktop-app's named-pipe sidecar, so detectOpenDesign skips it entirely and reports "detected" on
    // binary presence alone — even against the SAME deterministically-closed port that downgrades the
    // plain-path form above to "unreachable". Proves the two forms are handled distinctly.
    const mcpSpecDetected = await detectIntegrations(
      { integrations: { openDesign: { mcpConfig: { command: process.execPath, args: ["-e", "process.exit(0)"] } } } },
      { odDaemonPort: closedPort },
    );
    const odMcp = mcpSpecDetected.find((s) => s.slug === "openDesign");
    check("(14b) detectIntegrations: a full mcpConfig ⇒ detected on binary presence alone, no TCP probe",
      odMcp.state === "detected" && odMcp.source === "db" && odMcp.path === process.execPath);
    const mcpSpecMissing = await detectIntegrations(
      { integrations: { openDesign: { mcpConfig: { command: path.join(TMP, "no-such-exe") } } } },
      { odDaemonPort: closedPort },
    );
    check("(14b) detectIntegrations: a full mcpConfig with a missing command ⇒ not-found, source db",
      mcpSpecMissing.find((s) => s.slug === "openDesign").state === "not-found" &&
      mcpSpecMissing.find((s) => s.slug === "openDesign").source === "db");

    if (savedOdEnv === undefined) delete process.env.LOOM_OPEN_DESIGN_BIN; else process.env.LOOM_OPEN_DESIGN_BIN = savedOdEnv;
    if (savedCsEnv === undefined) delete process.env.LOOM_CODESCAPE_BIN; else process.env.LOOM_CODESCAPE_BIN = savedCsEnv;
  }

  // --- GET /api/integrations REST wiring smoke: the route actually calls detectIntegrations against the
  // DB's live config (not a hardcoded/stubbed response). ---
  {
    const wireDbFile = path.join(TMP, "integrations-wire.db");
    const db = new Db(wireDbFile);
    db.setPlatformConfig({ integrations: { codescape: { path: process.execPath } } });
    const stub = {};
    const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, control: stub, usageStatus: stub });
    try {
      const r = await app.inject({ method: "GET", url: "/api/integrations" });
      check("(14) GET /api/integrations → 200", r.statusCode === 200);
      const body = r.json();
      const cs = body.integrations?.find((s) => s.slug === "codescape");
      check("(14) GET /api/integrations reflects the DB's persisted codescape path as detected", cs?.state === "detected" && cs?.path === process.execPath);
    } finally {
      try { await app.close(); } catch { /* ignore */ }
      db.close();
    }
  }
}

// ============================ (15) clear-to-inherit sentinel (card fd55ac8a, deep-merge (16) below) ============================
// Set→blank→save must actually clear a top-level scalar/group back to inherit-the-default — the PATCH
// handler used to shallow-merge ONLY submitted keys, so an omitted (blanked) field left the stale
// persisted value in place forever. An explicit `null` on one of the 7 clearable keys
// (schedulerEnabled/operatorEnabled/coalesceAgentMessages/maxConcurrentGates + the ms-keyed
// rateLimit/watchers/timeouts groups) now DELETES that key from the persisted override; an OMITTED key
// is unaffected (today's/unchanged behavior — test (12) above already covers that half). Card ba9ccd75
// widened this further: a field NESTED INSIDE a submitted rateLimit/watchers/timeouts group is now ALSO
// individually nullable (its own per-field clear sentinel) — see test (16) below for the deep-merge
// contract this enables.
{
  // --- validatePlatformConfigPatch: null accepted on every clearable key, rejected everywhere else ---
  check("(15) accepts schedulerEnabled:null", validatePlatformConfigPatch({ schedulerEnabled: null }).ok === true);
  check("(15) accepts operatorEnabled:null", validatePlatformConfigPatch({ operatorEnabled: null }).ok === true);
  check("(15) accepts coalesceAgentMessages:null", validatePlatformConfigPatch({ coalesceAgentMessages: null }).ok === true);
  check("(15) accepts maxConcurrentGates:null", validatePlatformConfigPatch({ maxConcurrentGates: null }).ok === true);
  check("(15) accepts rateLimit:null", validatePlatformConfigPatch({ rateLimit: null }).ok === true);
  check("(15) accepts watchers:null", validatePlatformConfigPatch({ watchers: null }).ok === true);
  check("(15) accepts timeouts:null", validatePlatformConfigPatch({ timeouts: null }).ok === true);
  // No client-facing blank-to-inherit control exists for these — they keep their plain (non-nullable)
  // shape, so `null` still 400s exactly like any other type mismatch.
  check("(15) REJECTS companionVoiceEnabled:null (no sentinel wired for it)", validatePlatformConfigPatch({ companionVoiceEnabled: null }).ok === false);
  check("(15) REJECTS connections:null", validatePlatformConfigPatch({ connections: null }).ok === false);
  check("(15) REJECTS integrations:null", validatePlatformConfigPatch({ integrations: null }).ok === false);
  check("(15) REJECTS remoteAccess:null", validatePlatformConfigPatch({ remoteAccess: null }).ok === false);
  // (card ba9ccd75 — INVERTS the pre-ba9ccd75 assertion here) A field nested INSIDE a submitted group is
  // now its OWN per-field clear sentinel, not rejected — this is the whole point of the widened schema.
  // A genuinely malformed field (wrong TYPE, not null) still 400s exactly like before.
  check("(15) accepts a null WITHIN rateLimit (per-field clear sentinel, card ba9ccd75)",
    validatePlatformConfigPatch({ rateLimit: { defaultBackoffMs: null } }).ok === true);
  check("(15) still REJECTS a wrong-typed (non-null, non-number) value within rateLimit",
    validatePlatformConfigPatch({ rateLimit: { defaultBackoffMs: "not-a-number" } }).ok === false);

  // --- REST round-trip: set → clear → the stored override no longer carries the key, resolves to the default ---
  const clearDbFile = path.join(TMP, "clear-sentinel.db");
  const db = new Db(clearDbFile);
  const stub = {};
  const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, control: stub, usageStatus: stub });
  try {
    // Seed all 4 scalar toggles + all 3 ms groups (rateLimit with THREE fields — one gets resent/changed,
    // one gets per-field-nulled, one stays OMITTED from the clear PATCH below to prove the deep merge
    // leaves an untouched sibling alone even inside a group that's otherwise being edited).
    db.setPlatformConfig({
      schedulerEnabled: true,
      operatorEnabled: true,
      coalesceAgentMessages: true,
      maxConcurrentGates: 5,
      rateLimit: { defaultBackoffMs: 3600000, resetBufferMs: 20000, deadlineAfterResetMs: 7200000 },
      watchers: { wakeMs: 90000 },
      timeouts: { gitPushMs: 90000 },
    });
    const before = db.getPlatformConfig();
    check("(15) seed: every field persisted before the clear",
      before.schedulerEnabled === true && before.operatorEnabled === true && before.coalesceAgentMessages === true &&
      before.maxConcurrentGates === 5 && before.rateLimit?.defaultBackoffMs === 3600000 && before.rateLimit?.resetBufferMs === 20000 &&
      before.rateLimit?.deadlineAfterResetMs === 7200000 && before.watchers?.wakeMs === 90000 && before.timeouts?.gitPushMs === 90000);

    // Clear 3 of the 4 scalars + both single-field ms groups via the `null` sentinel; leave
    // `operatorEnabled` UNTOUCHED (omitted) to prove an omitted top-level field survives a save that
    // clears its siblings. For `rateLimit`: resend `defaultBackoffMs` CHANGED, per-field-null
    // `resetBufferMs` to clear just that field, and OMIT `deadlineAfterResetMs` entirely — the deep-merge
    // contract (card ba9ccd75) this test now exercises.
    const clear = await app.inject({
      method: "PATCH", url: "/api/platform/config",
      payload: {
        schedulerEnabled: null,
        coalesceAgentMessages: null,
        maxConcurrentGates: null,
        rateLimit: { defaultBackoffMs: 1800000, resetBufferMs: null },
        watchers: null,
        timeouts: null,
      },
    });
    check("(15) clear PATCH → 200", clear.statusCode === 200 && clear.json().ok === true);

    const after = db.getPlatformConfig();
    check("(15) cleared scalar #1 (schedulerEnabled) is GONE, not stale", after.schedulerEnabled === undefined);
    check("(15) cleared scalar #2 (coalesceAgentMessages) is GONE, not stale", after.coalesceAgentMessages === undefined);
    check("(15) cleared scalar #3 (maxConcurrentGates) is GONE, not stale", after.maxConcurrentGates === undefined);
    check("(15) UNTOUCHED scalar (operatorEnabled, omitted from the PATCH) is byte-identical", after.operatorEnabled === true);
    check("(15) cleared group #1 (watchers) is GONE entirely, not stale", after.watchers === undefined);
    check("(15) cleared group #2 (timeouts) is GONE entirely, not stale", after.timeouts === undefined);
    check("(15) deep-merged group (rateLimit) applies the resent/changed field", after.rateLimit?.defaultBackoffMs === 1800000);
    check("(15) deep-merged group (rateLimit) clears the per-field null sentinel", after.rateLimit?.resetBufferMs === undefined);
    check("(15) deep-merged group (rateLimit) leaves the OMITTED sibling untouched (card ba9ccd75)", after.rateLimit?.deadlineAfterResetMs === 7200000);

    // resolveConfig now reflects the platform DEFAULT for every cleared key, not the stale override.
    const resolved = resolveConfig(undefined, after);
    const def = resolveConfig(undefined);
    check("(15) resolved schedulerEnabled reverted to the default", resolved.orchestration.schedulerEnabled === def.orchestration.schedulerEnabled);
    check("(15) resolved maxConcurrentGates reverted to the default", resolved.orchestration.maxConcurrentGates === def.orchestration.maxConcurrentGates);
    check("(15) resolved coalesceAgentMessages reverted to the default", resolved.platform.coalesceAgentMessages === def.platform.coalesceAgentMessages);
    check("(15) resolved watchers.wakeMs reverted to the default", resolved.platform.watchers.wakeMs === def.platform.watchers.wakeMs);

    // GET reflects the cleared store too (the effHint the Settings UI shows).
    const g = (await app.inject({ method: "GET", url: "/api/platform/config" })).json();
    check("(15) GET override no longer carries the cleared keys", g.override.schedulerEnabled === undefined && g.override.watchers === undefined);
    check("(15) GET resolved shows the default for a cleared key", g.resolved.watchers.wakeMs === def.platform.watchers.wakeMs);

    // A null on a key that was NEVER set is a harmless no-op (deleting an absent key).
    const noop = await app.inject({ method: "PATCH", url: "/api/platform/config", payload: { companionVoiceEnabled: false, schedulerEnabled: null } });
    check("(15) clearing an already-absent key is a harmless 200 no-op", noop.statusCode === 200 && db.getPlatformConfig().schedulerEnabled === undefined);
  } finally {
    try { await app.close(); } catch { /* ignore */ }
    db.close();
  }

  // --- maxConcurrentGates: a non-numeric client entry must still 400 (not silently "succeed" as a clear
  // via NaN → null JSON collision) — the Settings form routes an invalid entry through as the ORIGINAL
  // STRING (see Settings.tsx buildGlobalOverride) so it fails the number|null shape check distinctly
  // from the real null clear sentinel. ---
  {
    const invalidDbFile = path.join(TMP, "clear-sentinel-invalid.db");
    const db2 = new Db(invalidDbFile);
    const stub = {};
    const app2 = await buildServer({ db: db2, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, control: stub, usageStatus: stub });
    try {
      db2.setPlatformConfig({ maxConcurrentGates: 4 });
      const bad = await app2.inject({ method: "PATCH", url: "/api/platform/config", payload: { maxConcurrentGates: "not-a-number" } });
      check("(15) a non-numeric maxConcurrentGates string still 400s (not treated as a clear)", bad.statusCode === 400);
      check("(15) the rejected invalid PATCH did not clobber the persisted value", db2.getPlatformConfig().maxConcurrentGates === 4);
    } finally {
      try { await app2.close(); } catch { /* ignore */ }
      db2.close();
    }
  }
}

// ============================ (16) deep-merge the ms-keyed groups (card ba9ccd75) ============================
// The exact regression from the card: PATCHing ONE non-grid field of `rateLimit` (a field no Settings UI
// control renders — `exhaustedThresholdPct`/`crashRecoveryWatchMs`/`runMs` are human-settable only via
// direct loopback REST) used to silently WIPE every other persisted sibling in that group, because the
// pre-fix handler treated a submitted group as a wholesale replace (`merged[key] = val`) rather than
// merging field by field — the same "omitted ≠ leave alone" bug `fd55ac8a` fixed one level up, still
// present one level down. This test FAILS on pre-ba9ccd75 main (the siblings come back `undefined`).
{
  const deepMergeDbFile = path.join(TMP, "deep-merge-groups.db");
  const db = new Db(deepMergeDbFile);
  const stub = {};
  const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, control: stub, usageStatus: stub });
  try {
    // Seed a full rateLimit group with 3 fields, exactly as a human's earlier curl PATCHes might have
    // built it up over time.
    db.setPlatformConfig({ rateLimit: { defaultBackoffMs: 1800000, resetBufferMs: 10000, exhaustedThresholdPct: 80 } });

    // The card's exact repro: PATCH only exhaustedThresholdPct.
    const patch = await app.inject({
      method: "PATCH", url: "/api/platform/config",
      payload: { config: { rateLimit: { exhaustedThresholdPct: 90 } } },
    });
    check("(16) PATCH a single non-grid rateLimit field → 200", patch.statusCode === 200);

    const after = db.getPlatformConfig();
    check("(16) the submitted field applies", after.rateLimit?.exhaustedThresholdPct === 90);
    check("(16) sibling #1 (defaultBackoffMs) survives — NOT silently wiped", after.rateLimit?.defaultBackoffMs === 1800000);
    check("(16) sibling #2 (resetBufferMs) survives — NOT silently wiped", after.rateLimit?.resetBufferMs === 10000);

    // watchers/timeouts get the identical treatment (same DEEP_MERGE_GROUPS set in server.ts).
    db.setPlatformConfig({ ...db.getPlatformConfig(), watchers: { wakeMs: 60000, idleWatchMs: 30000 }, timeouts: { gitPushMs: 45000, gitOpMs: 20000 } });
    await app.inject({ method: "PATCH", url: "/api/platform/config", payload: { config: { watchers: { idleWatchMs: 45000 } } } });
    await app.inject({ method: "PATCH", url: "/api/platform/config", payload: { config: { timeouts: { gitOpMs: 25000 } } } });
    const after2 = db.getPlatformConfig();
    check("(16) watchers: submitted field applies, OMITTED sibling survives",
      after2.watchers?.idleWatchMs === 45000 && after2.watchers?.wakeMs === 60000);
    check("(16) timeouts: submitted field applies, OMITTED sibling survives",
      after2.timeouts?.gitOpMs === 25000 && after2.timeouts?.gitPushMs === 45000);

    // Whole-group `null` still clears the ENTIRE group, including a field the deep merge would otherwise
    // have preserved — the deep merge only changes OMITTED-field handling, not the whole-group sentinel.
    const wholeGroupClear = await app.inject({ method: "PATCH", url: "/api/platform/config", payload: { config: { rateLimit: null } } });
    check("(16) whole-group null still clears every field, unchanged", wholeGroupClear.statusCode === 200 && db.getPlatformConfig().rateLimit === undefined);

    // --- Code-review catch: the REACHABLE wire shape a garbage grid entry now produces client-side ---
    // Widening the per-field schema to accept `null` quietly removed a guard the grid was leaning on:
    // `Number("abc")` is NaN and `Number("1e999")` is Infinity, and BOTH JSON.stringify() to `null` — the
    // same wire shape as the legitimate clear sentinel. Pre-this-fix, Settings.tsx sent that raw NaN/
    // Infinity through untouched, so a garbage grid entry would have silently "succeeded" as a clear
    // instead of 400ing (the exact regression a Code Reviewer caught, since the non-nullable per-field
    // schema had been the ONLY thing 400ing garbage before ba9ccd75 widened it). The fixed Settings.tsx
    // (buildGlobalOverride) now routes a non-finite result through as the ORIGINAL STRING instead — this
    // is that reachable shape, proven still 400s and never clobbers the persisted value.
    db.setPlatformConfig({ timeouts: { busyStaleMs: 60000 } });
    for (const garbage of ["abc", "1e999"]) {
      const bad = await app.inject({ method: "PATCH", url: "/api/platform/config", payload: { config: { timeouts: { busyStaleMs: garbage } } } });
      check(`(16) the reachable garbage shape {busyStaleMs:${JSON.stringify(garbage)}} still 400s`, bad.statusCode === 400);
      check(`(16) that rejected PATCH did NOT clobber (let alone clear) the persisted field`, db.getPlatformConfig().timeouts?.busyStaleMs === 60000);
    }
  } finally {
    try { await app.close(); } catch { /* ignore */ }
    db.close();
  }
}

// ==== (17) PATCH per-field bounds are DERIVED from the persisted schemas, not hand-duplicated (card 389bb302) ====
// rateLimitPatchOverride/watchersPatchOverride/timeoutsPatchOverride are now built from
// rateLimitOverride/watchersOverride/timeoutsOverride's own `.shape` (`nullableShape`), so a nested
// field's bounds can never diverge from the persisted schema. Prove the derived schemas enforce the
// EXACT SAME edges as the hand-written ones did (validatePlatformConfigOverride's own (8)-style checks
// above), not just "it compiles" — one edge pair per group, plus the .strict() unknown-key guard still
// holding on a nested group.
{
  // rateLimit.defaultBackoffMs: 60000(1m)–86400000(24h), same edges as check (8) above.
  check("(17) PATCH rateLimit.defaultBackoffMs:59999 (<1m floor) rejected",
    validatePlatformConfigPatch({ rateLimit: { defaultBackoffMs: 59999 } }).ok === false);
  check("(17) PATCH rateLimit.defaultBackoffMs:60000 (1m floor) accepted",
    validatePlatformConfigPatch({ rateLimit: { defaultBackoffMs: 60000 } }).ok === true);
  check("(17) PATCH rateLimit.defaultBackoffMs:86400001 (>24h) rejected",
    validatePlatformConfigPatch({ rateLimit: { defaultBackoffMs: 86400001 } }).ok === false);

  // watchers share the 5000(5s)–3600000(1h) floor/ceiling.
  check("(17) PATCH watchers.contextWatchMs:4999 (<5s floor) rejected",
    validatePlatformConfigPatch({ watchers: { contextWatchMs: 4999 } }).ok === false);
  check("(17) PATCH watchers.contextWatchMs:5000 (5s floor) accepted",
    validatePlatformConfigPatch({ watchers: { contextWatchMs: 5000 } }).ok === true);
  check("(17) PATCH watchers.contextWatchMs:3600001 (>1h ceiling) rejected",
    validatePlatformConfigPatch({ watchers: { contextWatchMs: 3600001 } }).ok === false);

  // timeouts.runMs: 30000(30s)–3600000(1h).
  check("(17) PATCH timeouts.runMs:29999 (<30s floor) rejected",
    validatePlatformConfigPatch({ timeouts: { runMs: 29999 } }).ok === false);
  check("(17) PATCH timeouts.runMs:30000 (30s floor) accepted",
    validatePlatformConfigPatch({ timeouts: { runMs: 30000 } }).ok === true);
  check("(17) PATCH timeouts.runMs:3600001 (>1h ceiling) rejected",
    validatePlatformConfigPatch({ timeouts: { runMs: 3600001 } }).ok === false);

  // .strict() on the derived object still rejects an unknown key nested inside a submitted group.
  check("(17) PATCH rejects an unknown key nested inside rateLimit (.strict() preserved)",
    validatePlatformConfigPatch({ rateLimit: { bogusField: 1 } }).ok === false);

  // null still wins alongside a real bound (per-field clear sentinel unaffected by the derivation).
  check("(17) PATCH still accepts null on a bounded field",
    validatePlatformConfigPatch({ timeouts: { runMs: null } }).ok === true);
}

// cleanup the temp LOOM_HOME (best-effort; retry for the WAL handle on Windows)
for (let i = 0; i < 5; i++) { try { fs.rmSync(TMP, { recursive: true, force: true }); break; } catch { /* retry */ } }

console.log(failures === 0
  ? "\n✅ ALL PASS — resolveConfig resolves the daemon-global `platform` group (global > LOOM_* env > default; watcher floor-clamp; explicit-0 discipline; deep-partial) AND the two new per-project timeouts; validatePlatformConfigOverride bounds every numeric per the BOUNDS table (incl. watcher 5s floor + rate-limit 1m/24h edges) with .strict() unknown-key + field-named reasons; the SQLite store round-trips, upserts a singleton row, and falls back to {} on garbage JSON; GET/PATCH /api/platform/config (app.inject) validate → 400-or-persist and reflect the override + resolved.platform; a false→true operatorEnabled PATCH seeds the Elevated Operator agent immediately (idempotent — no double-seed on a repeat true→true PATCH); a single-field PATCH shallow-merges onto the persisted config instead of replacing it, leaving untouched sibling fields byte-identical; (card 8dc5ebb9) host-tool integrations: resolvePlatform/validatePlatformConfigOverride/the SQLite store all handle the new `integrations` key with deep-partial sibling isolation, a genuine pre-migration blob (no `integrations` key at all) boot-reads cleanly with no throw, the existing PATCH surface persists it without a separate write endpoint, and GET /api/integrations' REAL (unmocked) detectIntegrations() correctly reports not-found/unreachable/detected across not-configured, misconfigured, real-binary-but-nothing-listening (OD residual risk 2), and real-binary (Codescape) cases; (card e8eee68c) the full mcpConfig escape hatch: the zod schema accepts a valid command+args+env spec (args/env optional, command required + non-empty), rejects a bad shape (.strict() unknown key, non-string args/env values), rides the SAME PATCH surface with a 400 that never clobbers a valid persisted spec, resolvePlatform threads it through, and detectIntegrations skips the TCP daemon-port probe entirely for a full spec (reporting detected/not-found on binary presence alone — the desktop app's named-pipe sidecar makes that probe inapplicable) even against the same closed port that downgrades the plain-path form to unreachable; and (card fd55ac8a, widened by ba9ccd75) the clear-to-inherit sentinel: validatePlatformConfigPatch accepts `null` on exactly the 7 clearable keys (the 4 scalar toggles + the 3 ms-keyed groups) AND on any individual field nested inside a submitted rateLimit/watchers/timeouts group, rejects it everywhere else, a set→null→save round-trip actually DELETES the key from the persisted override (reverting resolveConfig to the platform default) while an omitted sibling stays byte-identical, clearing an already-absent key is a harmless no-op, and a non-numeric maxConcurrentGates entry still 400s instead of colliding with the null sentinel; and (card ba9ccd75) the PATCH handler DEEP-merges rateLimit/watchers/timeouts field by field instead of replacing the group wholesale — a PATCH touching one field (incl. a non-grid field with no Settings UI control, e.g. exhaustedThresholdPct) leaves every OMITTED sibling in that group byte-identical (the exact regression this card fixes — proven failing on pre-fix main), a per-field `null` clears just that field, whole-group `null` still clears the entire group unchanged, and the REACHABLE garbage-input wire shape a fixed Settings.tsx now sends (the original string, when Number()*unit is non-finite) still 400s and never clobbers the persisted field — the CR-caught guard the widened per-field-nullable schema would otherwise have silently swallowed as a false clear."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
