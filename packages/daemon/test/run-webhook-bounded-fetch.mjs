// Card 731aa517 — sessions/service.ts's `defaultRunWebhookPost` (Agent Runs R3's run-completion
// webhook) used the bare default `fetch`: redirect:"follow" with no response bound at all (the
// caller-supplied `run.webhookUrl` can itself be a secret). Round 1 routed it through the shared
// `boundedFetch` helper; round 2 switched it to `guardedFetch` (the response body is never read/used by
// this poster, so success is now judged by HTTP status alone — see case 3 below). This file exercises
// `defaultRunWebhookPost` DIRECTLY — the existing agent-runs-rest.mjs test covers the Agent Runs REST
// surface via an injected `runWebhookPost` stub and never touches `defaultRunWebhookPost` itself.
//
// Against a REAL `http.createServer` on 127.0.0.1 (no fetchImpl override). No real network egress.
//
// Cases 1 (redirect) and 2 (hang) are RED against the pre-fix `sessions/service.ts` (verified manually:
// revert service.ts + boundedFetch.ts to HEAD, rebuild, rerun — the redirect case fails because the
// pre-fix code auto-follows the 3xx and the attacker target IS hit; the hang case fails because the
// pre-fix code never bounded the response at all). Case 3 (oversized) is a REGRESSION LOCK for a defect
// round 1 itself introduced: round 1's `boundedFetch` buffered-and-capped the body, so a real, fully
// delivered 2xx with a large/slow body THREW — and `deliverRunWebhook`'s ≤2-attempt retry loop
// (service.ts's `RUN_WEBHOOK_ATTEMPTS`) re-posts on ANY throw, so an already-delivered run-completion
// webhook could be POSTed a second time. Round 2's `guardedFetch` fixes this by never reading the body.
//
// Run: 1) build, 2) node packages/daemon/scripts/test-daemon.mjs --only=run-webhook-bounded-fetch
import http from "node:http";
import "./_guard.mjs"; // arms the Db prod-guard (LOOM_TEST=1)
import { finishAndExit } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { defaultRunWebhookPost } = await import("../dist/sessions/service.js");

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const close = (server) => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });

const servers = [];
const BODY = { runId: "r1", status: "completed", result: { ok: true }, error: null };

try {
  // ============ 1 — redirect refused: the run webhook URL must NEVER reach the redirect target =========
  {
    let attackerHits = 0;
    const attacker = http.createServer((req, res) => { attackerHits++; res.writeHead(200); res.end("{}"); });
    await listen(attacker);
    servers.push(attacker);
    const attackerUrl = `http://127.0.0.1:${attacker.address().port}/steal`;

    let hookHits = 0;
    const hookSrv = http.createServer((req, res) => { hookHits++; res.writeHead(302, { location: attackerUrl }); res.end(); });
    await listen(hookSrv);
    servers.push(hookSrv);
    const hookUrl = `http://127.0.0.1:${hookSrv.address().port}/hook`;

    let caught = null;
    try { await defaultRunWebhookPost(hookUrl, BODY, 5000); } catch (err) { caught = err; }

    check("1a redirect: the run webhook endpoint was actually hit (the setup is real)", hookHits === 1);
    check("1a redirect: the redirect target was NEVER hit — no auto-follow", attackerHits === 0);
    check("1a redirect: the poster rejects (not a silent success)", caught !== null);
    check("1a redirect: the error names a DISTINCT, diagnosable redirect failure with the status code", /refused a redirect.*302/i.test(caught?.message ?? ""));
    check("1a redirect: the error never names the redirect target host/port", !(caught?.message ?? "").includes(String(attacker.address().port)));
    check("1a redirect: the error never leaks the run webhook URL itself", !(caught?.message ?? "").includes(hookUrl));
  }

  // ============ 2 — a hung run-webhook endpoint resolves bounded, not an indefinite hang =================
  {
    const hangSrv = http.createServer(() => { /* never respond */ });
    await listen(hangSrv);
    servers.push(hangSrv);
    const hookUrl = `http://127.0.0.1:${hangSrv.address().port}/hook`;

    const TEST_RACE_MS = 4000;
    const SHORT_TIMEOUT_MS = 250;
    let caught = null;
    const started = Date.now();
    const raced = await Promise.race([
      defaultRunWebhookPost(hookUrl, BODY, SHORT_TIMEOUT_MS).then(() => ({ raced: false })).catch((err) => { caught = err; return { raced: false }; }),
      new Promise((resolve) => setTimeout(() => resolve({ raced: true }), TEST_RACE_MS)),
    ]);
    const elapsed = Date.now() - started;

    check("2a hang: resolves on its OWN timeout, not the test-level race (would be a hang pre-fix)", raced.raced === false);
    check("2a hang: bounded by the caller-supplied timeoutMs (well under the test's own generous ceiling)", elapsed < TEST_RACE_MS);
    check("2a hang: the poster rejects (not a silent success)", caught !== null);
    check("2a hang: the error mentions the timeout", /timed out/i.test(caught?.message ?? ""));
  }

  // ============ 3 — a 2xx with an oversized/slow body is delivered ONCE: no throw, no retry ==========
  {
    const CANARY = "CANARY-SECRET-LEAK-9f8e7d6c5b4a";
    const HUGE = "X".repeat(20000);
    let hookHits = 0;
    const oversizedSrv = http.createServer((req, res) => {
      hookHits++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, detail: CANARY, padding: HUGE }));
    });
    await listen(oversizedSrv);
    servers.push(oversizedSrv);
    const hookUrl = `http://127.0.0.1:${oversizedSrv.address().port}/hook`;

    let caught = null;
    try { await defaultRunWebhookPost(hookUrl, BODY, 5000); } catch (err) { caught = err; }

    check("3a oversized 2xx: the poster did NOT throw (an already-delivered POST must not look failed)", caught === null);
    check("3a oversized 2xx: the run webhook was hit exactly ONCE — the caller's retry loop never re-fires on a non-throw", hookHits === 1);
  }

  // ============ 4 — a malformed secret-bearing URL never leaks the secret in the rethrow =============
  {
    const SECRET = "SUPER-SECRET-RUN-WEBHOOK-TOKEN-9f8e7d6c5b4a";
    // A raw space inside the URL fails `fetch()`'s own URL parsing — undici's real fetch throws
    // `TypeError: Failed to parse URL from <url>`, embedding the URL VERBATIM (secret included),
    // BEFORE any network call is ever attempted — no server needed for this case (verified directly
    // against the real global fetch, not a mock, so this proves the real engine's behavior).
    const malformedUrl = `http:// 127.0.0.1/hook/${SECRET}`;

    let caught = null;
    try { await defaultRunWebhookPost(malformedUrl, BODY, 5000); } catch (err) { caught = err; }

    check("4a malformed URL: the poster rejects (not a silent success)", caught !== null);
    check("4a malformed URL: the secret never reaches the rethrown error", !(caught?.message ?? "").includes(SECRET));
    check("4a malformed URL: the error is a fixed, URL-free network-error message (no raw fetch message passed through)", /^network error/i.test(caught?.message ?? ""));
  }

  console.log(failures === 0
    ? "\n✅ ALL PASS — sessions/service.ts's defaultRunWebhookPost (via the shared guardedFetch helper): a redirect from the run webhook endpoint is NEVER auto-followed (the webhook URL proven to never reach a redirect target, against a real server), a hung endpoint resolves within its own bound instead of hanging, and a 2xx with an oversized/slow body is delivered exactly once with no throw/retry (the body is never read) — each real failure still surfaces a distinct, diagnosable reason."
    : `\n❌ ${failures} FAILURE(S).`);
} finally {
  for (const s of servers) await close(s).catch(() => {});
}
await finishAndExit(failures === 0 ? 0 : 1);
