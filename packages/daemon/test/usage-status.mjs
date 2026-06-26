// Plan-usage poller test — FULLY HERMETIC (no daemon, no claude, no network: fetch + credentials path
// are injected). Exercises the two things that must stay correct: the parse logic and the graceful
// failure modes (the endpoint is undocumented and MUST degrade to available:false, never throw).
//
// RUN (in-process; sets its OWN temp LOOM_HOME so the prod-guard is satisfied):
//   LOOM_HOME=<temp> LOOM_PORT=5399 node test/usage-status.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import "./_guard.mjs"; // arms the Db prod-guard (LOOM_TEST=1)
if (!process.env.LOOM_HOME) process.env.LOOM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "loom-usage-"));
import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv(); // LOOM_HOME must be a temp dir

const { readOAuthToken, parseUsagePayload, UsageStatusPoller } = await import("../dist/orchestration/usage-status.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loom-usage-test-"));
const credPath = (name, obj) => { const p = path.join(tmp, name); fs.writeFileSync(p, typeof obj === "string" ? obj : JSON.stringify(obj)); return p; };

// A representative live payload (captured from the real endpoint): per-model can be null, a window can
// have utilization with a null resets_at, extra_usage.utilization can be null.
const LIVE = {
  five_hour: { utilization: 48, resets_at: "2026-06-04T03:09:59+00:00" },
  seven_day: { utilization: 33, resets_at: "2026-06-09T15:00:00+00:00" },
  seven_day_opus: null,
  seven_day_sonnet: { utilization: 0, resets_at: null },
  extra_usage: { is_enabled: true, monthly_limit: 3500, used_credits: 0, utilization: null },
};

// ── readOAuthToken: every failure path + the happy path ─────────────────────────
{
  check("token: missing file → error (no credentials)",
    "error" in readOAuthToken(path.join(tmp, "nope.json")));
  check("token: malformed JSON → error",
    "error" in readOAuthToken(credPath("bad.json", "{not json")));
  check("token: no accessToken → error",
    "error" in readOAuthToken(credPath("empty.json", { claudeAiOauth: {} })));
  const expired = credPath("expired.json", { claudeAiOauth: { accessToken: "x", expiresAt: Date.now() - 1000 } });
  const r1 = readOAuthToken(expired);
  check("token: expired → error mentioning expiry", "error" in r1 && /expired/i.test(r1.error));
  const ok = credPath("ok.json", { claudeAiOauth: { accessToken: "tok-123", expiresAt: Date.now() + 3_600_000 } });
  const r2 = readOAuthToken(ok);
  check("token: valid + unexpired → { token }", "token" in r2 && r2.token === "tok-123");
  // expiresAt omitted is allowed (treat as usable).
  const r3 = readOAuthToken(credPath("noexp.json", { claudeAiOauth: { accessToken: "tok-9" } }));
  check("token: no expiresAt field → usable", "token" in r3 && r3.token === "tok-9");
}

// ── parseUsagePayload: valid, optional-null, schema drift ───────────────────────
{
  const at = new Date().toISOString();
  const s = parseUsagePayload(LIVE, at);
  check("parse: valid payload → available:true", s.available === true);
  check("parse: fiveHour utilization carried", s.available && s.fiveHour.utilization === 48);
  check("parse: sevenDay resets_at → resetsAt (camel)", s.available && s.sevenDay.resetsAt === "2026-06-09T15:00:00+00:00");
  check("parse: null per-model stays null", s.available && s.sevenDayOpus === null);
  check("parse: window with null resets_at parses (utilization kept)", s.available && s.sevenDaySonnet && s.sevenDaySonnet.resetsAt === null && s.sevenDaySonnet.utilization === 0);
  check("parse: extra_usage mapped (isEnabled + monthlyLimit, null utilization)", s.available && s.extraUsage && s.extraUsage.isEnabled === true && s.extraUsage.monthlyLimit === 3500 && s.extraUsage.utilization === null);
  check("parse: fetchedAt preserved", s.available && s.fetchedAt === at);

  check("parse: non-object → unavailable (shape)", parseUsagePayload(null, at).available === false);
  check("parse: missing five_hour → unavailable (schema drift)",
    parseUsagePayload({ seven_day: { utilization: 1, resets_at: null } }, at).available === false);
  const drift = parseUsagePayload({ five_hour: { utilization: "nope" }, seven_day: { utilization: 1, resets_at: null } }, at);
  check("parse: non-numeric utilization → unavailable", drift.available === false);
}

// ── poller graceful failure: no token / 401 / network throw / 200-success ───────
{
  const okCred = credPath("poll-ok.json", { claudeAiOauth: { accessToken: "tok", expiresAt: Date.now() + 3_600_000 } });

  // no credentials file → available:false, never throws
  const pNoCred = new UsageStatusPoller({ credentialsPath: path.join(tmp, "absent.json"), userAgentVersion: "9.9.9", fetchImpl: async () => { throw new Error("should not be called"); } });
  await pNoCred.pollOnce();
  check("poll: missing creds → available:false (no fetch attempted)", pNoCred.getStatus().available === false);

  // network throw → available:false with a reason
  const pNet = new UsageStatusPoller({ credentialsPath: okCred, userAgentVersion: "9.9.9", fetchImpl: async () => { throw new Error("ECONNREFUSED"); } });
  await pNet.pollOnce();
  const net = pNet.getStatus();
  check("poll: network error → available:false + reason", net.available === false && /ECONNREFUSED|fetch/i.test(net.reason));

  // 401 → available:false mentioning re-login
  const p401 = new UsageStatusPoller({ credentialsPath: okCred, userAgentVersion: "9.9.9", fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }) });
  await p401.pollOnce();
  const s401 = p401.getStatus();
  check("poll: 401 → available:false mentioning re-login", s401.available === false && /401|login/i.test(s401.reason));

  // 200 valid → available:true AND the load-bearing headers were sent
  let sentHeaders = null;
  const pOk = new UsageStatusPoller({
    credentialsPath: okCred,
    userAgentVersion: "1.2.3",
    fetchImpl: async (_url, init) => { sentHeaders = init.headers; return { ok: true, status: 200, json: async () => LIVE }; },
  });
  await pOk.pollOnce();
  check("poll: 200 valid → available:true", pOk.getStatus().available === true);
  check("poll: Authorization Bearer header sent", sentHeaders && sentHeaders.Authorization === "Bearer tok");
  check("poll: anthropic-beta header sent", sentHeaders && sentHeaders["anthropic-beta"] === "oauth-2025-04-20");
  check("poll: LOAD-BEARING User-Agent claude-code/<version> sent", sentHeaders && sentHeaders["User-Agent"] === "claude-code/1.2.3");
}

// ── start-on-login seam: poller installs the loop with NO creds, recovers on a post-boot login ──
// Regression for the gap where start() skipped the timer entirely when credentials were absent at
// boot, leaving the usage strip permanently stale after a post-boot `claude` login until a restart.
{
  const settle = () => new Promise((r) => setImmediate(r)); // let the async prime pollOnce flush

  // No credentials at boot: start() must still install the loop and degrade gracefully (no network).
  let loginFetches = 0;
  const lateCred = path.join(tmp, "late-login.json"); // deliberately absent at start()
  const pLogin = new UsageStatusPoller({
    credentialsPath: lateCred,
    userAgentVersion: "9.9.9",
    intervalMs: 3_600_000, // long — we drive the recovery tick manually
    fetchImpl: async () => { loginFetches++; return { ok: true, status: 200, json: async () => LIVE }; },
  });
  pLogin.start();
  await settle();
  check("login: no creds at boot → available:false, no fetch (loop still installed)",
    pLogin.getStatus().available === false && loginFetches === 0);

  // The user signs in: `claude` writes the credentials file out-of-band. The next tick polls for real.
  fs.writeFileSync(lateCred, JSON.stringify({ claudeAiOauth: { accessToken: "tok", expiresAt: Date.now() + 3_600_000 } }));
  await pLogin.pollOnce(); // simulate the next interval tick
  check("login: post-boot login recovers the strip (available:true, no restart)",
    pLogin.getStatus().available === true && loginFetches === 1);
  pLogin.stop();

  // Idempotent: two start() calls install ONE loop (one prime fetch), never two pollers.
  let primeFetches = 0;
  const okIdem = credPath("idem-ok.json", { claudeAiOauth: { accessToken: "tok", expiresAt: Date.now() + 3_600_000 } });
  const pIdem = new UsageStatusPoller({
    credentialsPath: okIdem,
    userAgentVersion: "9.9.9",
    intervalMs: 3_600_000,
    fetchImpl: async () => { primeFetches++; return { ok: true, status: 200, json: async () => LIVE }; },
  });
  pIdem.start();
  pIdem.start(); // second call must be a no-op
  await settle();
  check("start: idempotent — two start() calls prime once (single poller)", primeFetches === 1);
  pIdem.stop();
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log(failures === 0
  ? "\n✅ ALL PASS — token read (missing/malformed/expired/valid), payload parse (valid/optional-null/schema-drift), and the poller's graceful failure modes (no-token / 401 / network) all hold, with the load-bearing headers (incl. User-Agent: claude-code/<version>) sent on success."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
