// Card 731aa517 — orchestration/alert-webhook.ts's `defaultPost` used the bare default `fetch`:
// redirect:"follow" with no response bound at all (the webhook URL itself is the secret here — a Slack
// incoming-webhook URL — so a redirect target could receive it). Round 1 routed it through the shared
// `boundedFetch` helper; round 2 switched it to `guardedFetch` (the response body is never read/used by
// this poster, so success is now judged by HTTP status alone — see case 3 below). This file exercises
// `defaultPost` DIRECTLY (not a test-injected `post` stub — the existing alert-webhook.mjs test covers
// the emitter's own gating/payload logic via an injected stub and never touches `defaultPost` at all).
//
// Against a REAL `http.createServer` on 127.0.0.1 (no fetchImpl override). No real network egress.
//
// Cases 1 (redirect) and 2 (hang) are RED against the pre-fix `alert-webhook.ts` (verified manually:
// revert alert-webhook.ts + boundedFetch.ts to HEAD, rebuild, rerun — the redirect case fails because
// the pre-fix code auto-follows the 3xx and the attacker target IS hit; the hang case fails because the
// pre-fix code never bounded the response at all). Case 3 (oversized) is a REGRESSION LOCK for a defect
// round 1 itself introduced: round 1's `boundedFetch` buffered-and-capped the body, so a real, fully
// delivered 2xx with a large/slow body threw a spurious "exceeded byte cap" error — misreporting an
// already-successful delivery as failed (and, for `defaultRunWebhookPost`'s sibling retry loop, risking
// a duplicate POST). Round 2's `guardedFetch` fixes this by never reading the body at all.
//
// Run: 1) build, 2) node packages/daemon/scripts/test-daemon.mjs --only=alert-webhook-bounded-fetch
import http from "node:http";
import "./_guard.mjs"; // arms the Db prod-guard (LOOM_TEST=1)
import { useOwnLoomHome, finishAndExit } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-alertwh-bounds-");
const now = new Date().toISOString();

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { Db } = await import("../dist/db.js");
const { AlertWebhookEmitter } = await import("../dist/orchestration/alert-webhook.js");

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const close = (server) => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });

const db = new Db();
let seq = 0;
function seedProject(url) {
  const n = `pWH${seq++}`;
  db.insertProject({ id: n, name: "Hooked", repoPath: `C:/tmp/${n}`, vaultPath: `C:/tmp/${n}`,
    config: { orchestration: { alertWebhook: { url, events: ["merge_done"] } } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `a${n}`, projectId: n, name: "lead", startupPrompt: "", position: 0 });
  db.insertSession({ id: `m${n}`, projectId: n, agentId: `a${n}`, engineSessionId: null, title: null,
    cwd: `C:/tmp/${n}`, processState: "live", resumability: "unknown", busy: false,
    createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  return `m${n}`;
}
const evt = (kind, managerSessionId) => ({ id: `e-${kind}-${managerSessionId}`, ts: now, managerSessionId, kind });

const servers = [];

try {
  // ============ 1 — redirect refused: the webhook URL must NEVER reach the redirect target ============
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

    const errors = [];
    const mgr = seedProject(hookUrl);
    const emitter = new AlertWebhookEmitter({ db, onError: (m) => errors.push(m) });
    await emitter.onEvent(evt("merge_done", mgr));

    check("1a redirect: the webhook endpoint was actually hit (the setup is real)", hookHits === 1);
    check("1a redirect: the redirect target was NEVER hit — no auto-follow", attackerHits === 0);
    check("1a redirect: delivery failure was reported (swallowed, not silent)", errors.length === 1);
    check("1a redirect: the reason names a DISTINCT, diagnosable redirect failure with the status code", /refused a redirect.*302/i.test(errors[0] ?? ""));
    check("1a redirect: the reason never names the redirect target host/port", !(errors[0] ?? "").includes(String(attacker.address().port)));
    check("1a redirect: the reason never leaks the webhook URL itself", !(errors[0] ?? "").includes(hookUrl));
  }

  // ============ 2 — a hung webhook endpoint resolves bounded (never wedges the event path) ============
  {
    const hangSrv = http.createServer(() => { /* never respond */ });
    await listen(hangSrv);
    servers.push(hangSrv);
    const hookUrl = `http://127.0.0.1:${hangSrv.address().port}/hook`;

    const errors = [];
    const mgr = seedProject(hookUrl);
    // deps.timeoutMs TEST override — short, so this doesn't wait out the real 5000ms default.
    const emitter = new AlertWebhookEmitter({ db, timeoutMs: 250, onError: (m) => errors.push(m) });

    const TEST_RACE_MS = 4000;
    const started = Date.now();
    const raced = await Promise.race([
      emitter.onEvent(evt("merge_done", mgr)).then(() => ({ raced: false })),
      new Promise((resolve) => setTimeout(() => resolve({ raced: true }), TEST_RACE_MS)),
    ]);
    const elapsed = Date.now() - started;

    check("2a hang: resolves on its OWN timeout, not the test-level race (would be a hang pre-fix)", raced.raced === false);
    check("2a hang: bounded by the injected timeoutMs (well under the test's own generous ceiling)", elapsed < TEST_RACE_MS);
    check("2a hang: delivery failure was reported (swallowed, not silent)", errors.length === 1);
    check("2a hang: the reason mentions the timeout", /timed out/i.test(errors[0] ?? ""));
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

    const errors = [];
    const mgr = seedProject(hookUrl);
    const emitter = new AlertWebhookEmitter({ db, onError: (m) => errors.push(m) });
    await emitter.onEvent(evt("merge_done", mgr));

    check("3a oversized 2xx: the webhook was hit exactly ONCE (no retry on an already-delivered POST)", hookHits === 1);
    check("3a oversized 2xx: delivery succeeded — no throw, nothing reported to onError", errors.length === 0);
  }

  // ============ 4 — a malformed secret-bearing URL never leaks the secret in the thrown error ========
  {
    const SECRET = "SUPER-SECRET-SLACK-TOKEN-9f8e7d6c5b4a";
    // A raw space inside the URL fails `fetch()`'s own URL parsing — undici's real fetch throws
    // `TypeError: Failed to parse URL from <url>`, embedding the URL VERBATIM (secret included),
    // BEFORE any network call is ever attempted — no server needed for this case (verified directly
    // against the real global fetch, not a mock, so this proves the real engine's behavior).
    const malformedUrl = `http:// 127.0.0.1/hook/${SECRET}`;

    const errors = [];
    const mgr = seedProject(malformedUrl);
    const emitter = new AlertWebhookEmitter({ db, onError: (m) => errors.push(m) });
    await emitter.onEvent(evt("merge_done", mgr));

    check("4a malformed URL: delivery failure was reported (swallowed, not silent)", errors.length === 1);
    check("4a malformed URL: the secret never reaches the onError reason", !(errors[0] ?? "").includes(SECRET));
    check("4a malformed URL: the reason is a fixed, URL-free network-error message (no raw fetch message passed through)", /^delivery failed for merge_done: network error/i.test(errors[0] ?? ""));
  }

  console.log(failures === 0
    ? "\n✅ ALL PASS — orchestration/alert-webhook.ts's defaultPost (via the shared guardedFetch helper): a redirect from the webhook endpoint is NEVER auto-followed (the webhook URL proven to never reach a redirect target, against a real server), a hung endpoint resolves within its own bound instead of wedging the event path, and a 2xx with an oversized/slow body is delivered exactly once with no throw/retry (the body is never read) — each real failure still surfaces a distinct, diagnosable reason via the onError sink."
    : `\n❌ ${failures} FAILURE(S).`);
} finally {
  for (const s of servers) await close(s).catch(() => {});
  db.close();
}
await finishAndExit(failures === 0 ? 0 : 1);
