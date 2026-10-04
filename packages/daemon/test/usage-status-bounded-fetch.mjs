// Card 731aa517 — orchestration/usage-status.ts's plan-usage poll sent the host's real Claude OAuth
// Bearer token with NO timeout, NO size cap, and the fetch default redirect:"follow" (an undocumented,
// community-discovered endpoint that could start redirecting at any time, with no code here to refuse
// it). Now routed through the shared `boundedFetch` helper (connections/boundedFetch.ts).
//
// Against a REAL `http.createServer` on 127.0.0.1 (no fetchImpl override — the real global fetch, so the
// network layer itself proves `redirect:"manual"` is honored, not a mock that could be told to honor it
// regardless of what the code actually passed). No real network egress (127.0.0.1 only).
//
// Each check below is RED against the pre-fix `usage-status.ts` for the redirect case (verified
// manually: `git stash` the fix, rebuild, rerun — the redirect test fails because the pre-fix code
// auto-follows the 3xx and fails because the bearer token DOES reach the attacker target. The hang case
// was ALREADY bounded pre-fix in spirit — pre-fix `usage-status.ts` had no AbortSignal at all, so a hang
// there would have hung this test file forever instead of failing cleanly; this suite's own race turns
// that into an observable FAIL rather than a wedge. The oversized case is a genuinely NEW bound: pre-fix
// used a plain `res.json()` with no byte cap at all) and GREEN against the fixed code.
//
// Run: 1) build, 2) node packages/daemon/scripts/test-daemon.mjs --only=usage-status-bounded-fetch
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import "./_guard.mjs"; // arms the Db prod-guard (LOOM_TEST=1)
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
if (!process.env.LOOM_HOME) process.env.LOOM_HOME = mkdtempManaged("loom-usage-bounds-");
import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { UsageStatusPoller } = await import("../dist/orchestration/usage-status.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmp = mkdtempManaged("loom-usage-bounds-test-");
const BEARER_TOKEN = "secret-bearer-DO-NOT-LEAK-12345";
const credPath = path.join(tmp, "ok.json");
fs.writeFileSync(credPath, JSON.stringify({ claudeAiOauth: { accessToken: BEARER_TOKEN, expiresAt: Date.now() + 3_600_000 } }));

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const close = (server) => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
const readBody = (req) => new Promise((resolve) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
});

const servers = [];

try {
  // ============ 1 — redirect refused: the bearer token must NEVER reach the redirect target ============
  {
    let attackerHits = 0;
    let attackerAuth = null;
    const attacker = http.createServer(async (req, res) => {
      attackerHits++;
      attackerAuth = req.headers.authorization ?? null;
      await readBody(req);
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    await listen(attacker);
    servers.push(attacker);
    const attackerUrl = `http://127.0.0.1:${attacker.address().port}/steal`;

    let endpointHits = 0;
    const endpointSrv = http.createServer((req, res) => {
      endpointHits++;
      res.writeHead(302, { location: attackerUrl });
      res.end();
    });
    await listen(endpointSrv);
    servers.push(endpointSrv);
    const endpoint = `http://127.0.0.1:${endpointSrv.address().port}/usage`;

    const poller = new UsageStatusPoller({ credentialsPath: credPath, endpoint, userAgentVersion: "9.9.9" });
    await poller.pollOnce();
    const s = poller.getStatus();

    check("1a redirect: the usage endpoint was actually hit (the setup is real)", endpointHits === 1);
    check("1a redirect: reported as a clean failure (not a throw)", s.available === false);
    check("1a redirect: the redirect target was NEVER hit — no auto-follow", attackerHits === 0);
    check("1a redirect: the bearer token never reached the redirect target (implied by 0 hits, checked directly too)", attackerAuth === null);
    check("1a redirect: the reason names a DISTINCT, diagnosable redirect failure with the status code", /refused a redirect.*302/i.test(s.reason ?? ""));
    check("1a redirect: the reason never names the redirect target host/port", !(s.reason ?? "").includes(String(attacker.address().port)));
    check("1a redirect: the reason never leaks the bearer token", !(s.reason ?? "").includes(BEARER_TOKEN));
  }

  // ============ 2 — a hung usage endpoint resolves bounded (never hangs the poller) ============
  {
    const hangSrv = http.createServer(() => { /* never respond */ });
    await listen(hangSrv);
    servers.push(hangSrv);
    const endpoint = `http://127.0.0.1:${hangSrv.address().port}/usage`;

    // fetchTimeoutMs TEST override — short, so this doesn't wait out the real 8s production bound.
    const poller = new UsageStatusPoller({ credentialsPath: credPath, endpoint, userAgentVersion: "9.9.9", fetchTimeoutMs: 250 });

    const TEST_RACE_MS = 4000;
    const started = Date.now();
    const raced = await Promise.race([
      poller.pollOnce().then(() => ({ raced: false })),
      new Promise((resolve) => setTimeout(() => resolve({ raced: true }), TEST_RACE_MS)),
    ]);
    const elapsed = Date.now() - started;

    check("2a hang: resolves on its OWN timeout, not the test-level race (would be a hang pre-fix)", raced.raced === false);
    check("2a hang: bounded by fetchTimeoutMs (well under the test's own generous ceiling)", elapsed < TEST_RACE_MS);
    const s = poller.getStatus();
    check("2a hang: reported as a clean failure (available:false)", s.available === false);
    check("2a hang: the reason mentions the fetch failure/timeout", /timed out|usage fetch failed/i.test(s.reason ?? ""));
  }

  // ============ 3 — an oversized response is capped WHILE STREAMING, no padding leak ============
  {
    const HUGE = "X".repeat(20000);
    const oversizedSrv = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ five_hour: { utilization: 1, resets_at: null }, seven_day: { utilization: 1, resets_at: null }, padding: HUGE }));
    });
    await listen(oversizedSrv);
    servers.push(oversizedSrv);
    const endpoint = `http://127.0.0.1:${oversizedSrv.address().port}/usage`;

    // fetchMaxResponseBytes TEST override — far below HUGE, so this doesn't need a real 65536-byte probe.
    const poller = new UsageStatusPoller({ credentialsPath: credPath, endpoint, userAgentVersion: "9.9.9", fetchMaxResponseBytes: 200 });
    await poller.pollOnce();
    const s = poller.getStatus();

    check("3a oversized: reported as a clean failure (available:false)", s.available === false);
    check("3a oversized: the reason names the byte cap", /byte cap|exceeded/i.test(s.reason ?? ""));
    check("3a oversized: the padding payload never reaches the reason text", !(s.reason ?? "").includes("X".repeat(200)));
  }

  console.log(failures === 0
    ? "\n✅ ALL PASS — orchestration/usage-status.ts's plan-usage poll (via the shared boundedFetch helper): a redirect from the usage endpoint is NEVER auto-followed (the Claude OAuth bearer token proven to never reach a redirect target, against a real server), a hung endpoint resolves within its own bound instead of hanging, and an oversized response is capped while streaming with no body leak — each failure surfaces a distinct, diagnosable reason."
    : `\n❌ ${failures} FAILURE(S).`);
} finally {
  for (const s of servers) await close(s).catch(() => {});
}
await finishAndExit(failures === 0 ? 0 : 1);
