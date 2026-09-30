import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 25c93b6f — `connections/oauth.ts`'s token-endpoint POST used the bare default `fetch`:
// `redirect:"follow"` (a 307/308 re-POSTs client_secret/refresh_token/code_verifier to the Location,
// even cross-origin), no AbortSignal timeout (a hung token endpoint pinned `inFlightRefresh` forever),
// and an unbounded `.text()` whose first 500 chars reached the agent verbatim on error.
//
// UNLIKE connections-oauth.mjs (which drives the token lifecycle via an injected `fetchImpl` mock), every
// test here is against a REAL `http.createServer` on 127.0.0.1 with an ephemeral port, using the REAL
// global `fetch` (no fetchImpl override) — a mocked fetchImpl can be told to honor `redirect:"manual"`
// regardless of what the code actually passed; only a real server can prove the network layer really
// never re-dispatches to a redirect target. No real network egress (127.0.0.1 only).
//
// Each check below is RED against the pre-fix `oauth.ts` (verified manually: revert oauth.ts +
// boundedFetch.ts to HEAD, rebuild, rerun — every check in Parts 1, 1b, 3 and 4 fails via a normal
// assertion; Part 2's (and 2b's) hang/slow-drip cases never resolve at all pre-fix and are only graded
// FAIL by the test's own bounded race, not by hanging the suite) and GREEN against the fixed code.
//
// Run: 1) build, 2) node packages/daemon/scripts/test-daemon.mjs --only=connections-oauth-token-bounds
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-oauth-bounds-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { createOAuthConnection, saveOAuthTokens } = await import("../dist/connections/store.js");
const { performAuthenticatedRequest, __resetConnectionsRateLimitState } = await import("../dist/connections/request.js");
const { ensureFreshOAuthToken, __resetOAuthRefreshState } = await import("../dist/connections/oauth.js");

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const close = (server) => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
const readBody = (req) => new Promise((resolve) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
});

/**
 * Seed an oauth2 connection whose token is already expired, so any use forces a refresh_token grant.
 * `createOAuthConnection` REQUIRES an https:// tokenUrl (store.ts's own creation-time validation) — real
 * providers only ever use https, but this test needs a genuine loopback http server so the actual
 * network-level redirect/timeout/streaming behavior is exercised, not a mock. So: create with a throwaway
 * https:// placeholder (passes validation), then overwrite `token_url` directly at the SQL layer — that
 * validation only runs at creation, never on read, so this is a legitimate test-only bypass, not a hole
 * in the real (human-only, REST-driven) creation path.
 */
function seedExpiredConn(db, n, tokenUrl) {
  const conn = createOAuthConnection(db, {
    name: `bounds-${n}`, host: `unused-${n}.invalid.example`, provider: "custom",
    clientId: `client-${n}`, clientSecret: `secret-DO-NOT-LEAK-${n}`,
    authUrl: "https://auth.example.com/authorize", tokenUrl: "https://placeholder.invalid.example/token", scopes: ["read"],
  });
  db.db.prepare("UPDATE connections SET token_url = ? WHERE id = ?").run(tokenUrl, conn.id);
  saveOAuthTokens(db, conn.id, {
    clientSecret: `secret-DO-NOT-LEAK-${n}`, accessToken: "stale-at", refreshToken: `stale-rt-${n}`,
    expiresAt: new Date(0).toISOString(), // 1970 — always expired
  }, undefined);
  return conn;
}

const GUARD = { requestTimeoutMs: 5000, maxResponseBytes: 100000, rateLimitMax: 1000, rateLimitWindowMs: 60000 };

const db = new Db(path.join(tmpHome, "bounds.db"));
const servers = [];

try {
  // ============ Part 1 — 307 redirect, cross-origin: the credential must never reach the target ============
  {
    let attackerHits = 0;
    let attackerBody = null;
    const attacker = http.createServer(async (req, res) => {
      attackerHits++;
      attackerBody = await readBody(req);
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    await listen(attacker);
    servers.push(attacker);
    const attackerUrl = `http://127.0.0.1:${attacker.address().port}/steal`;

    let tokenHits = 0;
    const tokenSrv = http.createServer((req, res) => {
      tokenHits++;
      res.writeHead(307, { location: attackerUrl });
      res.end();
    });
    await listen(tokenSrv);
    servers.push(tokenSrv);
    const tokenUrl = `http://127.0.0.1:${tokenSrv.address().port}/token`;

    __resetConnectionsRateLimitState();
    __resetOAuthRefreshState();
    const conn = seedExpiredConn(db, "307", tokenUrl);
    const r = await performAuthenticatedRequest({ db }, [conn.id], GUARD, { connection: conn.id, path: "/x" });

    check("1a 307 redirect: the token endpoint was actually hit (the setup is real)", tokenHits === 1);
    check("1a 307 redirect: refresh reported as a clean failure (not a throw)", r.ok === false);
    check("1a 307 redirect: the redirect target was NEVER hit — no auto-follow", attackerHits === 0);
    check("1a 307 redirect: no client_secret ever reached the redirect target (implied by 0 hits, checked directly too)", attackerBody === null || !attackerBody.includes("secret-DO-NOT-LEAK"));
    check("1a 307 redirect: the agent-facing error never names the redirect target", !JSON.stringify(r).includes(String(attacker.address().port)));
  }

  // ============ Part 1b — 308 redirect, cross-origin: same proof, the other redirect-preserving status ============
  {
    let attackerHits = 0;
    const attacker = http.createServer((req, res) => { attackerHits++; res.writeHead(200); res.end("{}"); });
    await listen(attacker);
    servers.push(attacker);
    const attackerUrl = `http://127.0.0.1:${attacker.address().port}/steal`;

    let tokenHits = 0;
    const tokenSrv = http.createServer((req, res) => { tokenHits++; res.writeHead(308, { location: attackerUrl }); res.end(); });
    await listen(tokenSrv);
    servers.push(tokenSrv);
    const tokenUrl = `http://127.0.0.1:${tokenSrv.address().port}/token`;

    __resetConnectionsRateLimitState();
    __resetOAuthRefreshState();
    const conn = seedExpiredConn(db, "308", tokenUrl);
    const r = await performAuthenticatedRequest({ db }, [conn.id], GUARD, { connection: conn.id, path: "/x" });

    check("1b 308 redirect: the token endpoint was actually hit", tokenHits === 1);
    check("1b 308 redirect: refresh reported as a clean failure (not a throw)", r.ok === false);
    check("1b 308 redirect: the redirect target was NEVER hit — no auto-follow", attackerHits === 0);
  }

  // ============ Part 2 — a hung token endpoint resolves bounded, and frees inFlightRefresh for the NEXT call ============
  {
    let tokenHits = 0;
    const tokenSrv = http.createServer((req, res) => {
      tokenHits++;
      if (tokenHits === 1) return; // FIRST call: never respond — simulate a hung upstream.
      // SECOND+ call: a normal, valid token response.
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: "at-after-hang", refresh_token: "rt-after-hang", expires_in: 3600, token_type: "Bearer" }));
    });
    await listen(tokenSrv);
    servers.push(tokenSrv);
    const tokenUrl = `http://127.0.0.1:${tokenSrv.address().port}/token`;

    __resetOAuthRefreshState();
    const conn = seedExpiredConn(db, "hang", tokenUrl);
    const smallGuard = { requestTimeoutMs: 300, maxResponseBytes: 100000 };

    // A hard, generous test-level race so a regression here fails loudly (RED) instead of hanging this
    // whole test file forever — the pre-fix code has NO AbortSignal at all, so this race is what turns
    // "would hang forever" into an observable, bounded FAIL rather than a wedged suite.
    const TEST_RACE_MS = 4000;
    const started = Date.now();
    const raced = await Promise.race([
      ensureFreshOAuthToken({ db, guard: smallGuard }, conn.id).then((v) => ({ raced: false, v })),
      new Promise((resolve) => setTimeout(() => resolve({ raced: true }), TEST_RACE_MS)),
    ]);
    const elapsed = Date.now() - started;

    check("2a hang: resolves on its OWN timeout, not the test-level race (would be a hang pre-fix)", raced.raced === false);
    check("2a hang: bounded by requestTimeoutMs (well under the test's own generous ceiling)", elapsed < TEST_RACE_MS);
    check("2a hang: the first attempt is reported as a clean failure (not a throw)", raced.raced === false && raced.v?.ok === false);

    // The SAME connection, called again — if inFlightRefresh were never freed on timeout, this would
    // either hang too (awaiting the same dead promise) or dedupe onto the ALREADY-SETTLED-false promise
    // instead of issuing a fresh grant. A NEW, successful token proves neither happened.
    const second = await ensureFreshOAuthToken({ db, guard: smallGuard }, conn.id);
    check("2b after a timed-out refresh: a NEW token request is actually issued", tokenHits === 2);
    check("2b after a timed-out refresh: the SECOND attempt succeeds with a fresh token", second.ok === true && second.accessToken === "at-after-hang");
  }

  // ============ Part 2b — a SLOW-DRIP body (headers arrive fast, the body then trickles forever without
  // ever completing): proves the SAME timeout bounds the BODY-READ phase too, not just the initial
  // fetch() call — a different code path than Part 2's hang (which never even gets a response back).
  // Also re-proves inFlightRefresh gets freed on this failure mode too. ============
  {
    let tokenHits = 0;
    let dripInterval;
    const tokenSrv = http.createServer((req, res) => {
      tokenHits++;
      res.on("error", () => {}); // writes after the client aborts would otherwise throw an uncaught error
      if (tokenHits === 1) {
        // Headers + a first byte arrive immediately; the body then dribbles one byte at a time forever
        // (res.end() is never called) — the client-side fetch() has a Response already, only the BODY
        // READ hangs, which is what actually exercises the timeout's coverage of that phase.
        res.writeHead(200, { "content-type": "application/json" });
        res.write("{");
        dripInterval = setInterval(() => { try { res.write("x"); } catch { /* socket already gone */ } }, 20);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: "at-after-drip", refresh_token: "rt-after-drip", expires_in: 3600, token_type: "Bearer" }));
    });
    await listen(tokenSrv);
    servers.push(tokenSrv);
    const tokenUrl = `http://127.0.0.1:${tokenSrv.address().port}/token`;

    __resetOAuthRefreshState();
    const conn = seedExpiredConn(db, "drip", tokenUrl);
    const smallGuard = { requestTimeoutMs: 300, maxResponseBytes: 100000 };

    const TEST_RACE_MS = 4000;
    const started = Date.now();
    const raced = await Promise.race([
      ensureFreshOAuthToken({ db, guard: smallGuard }, conn.id).then((v) => ({ raced: false, v })),
      new Promise((resolve) => setTimeout(() => resolve({ raced: true }), TEST_RACE_MS)),
    ]);
    const elapsed = Date.now() - started;
    clearInterval(dripInterval);

    check("2c slow-drip: resolves on its OWN timeout, not the test-level race (would be a hang pre-fix)", raced.raced === false);
    check("2c slow-drip: bounded by requestTimeoutMs (well under the test's own generous ceiling)", elapsed < TEST_RACE_MS);
    check("2c slow-drip: the first attempt is reported as a clean failure (not a throw)", raced.raced === false && raced.v?.ok === false);

    const second = await ensureFreshOAuthToken({ db, guard: smallGuard }, conn.id);
    check("2d after a slow-drip timeout: a NEW token request is actually issued", tokenHits === 2);
    check("2d after a slow-drip timeout: the SECOND attempt succeeds with a fresh token", second.ok === true && second.accessToken === "at-after-drip");
  }

  // ============ Part 3 — oversized token response: capped WHILE STREAMING, error carries no body text ============
  {
    const HUGE = "X".repeat(20000);
    const tokenSrv = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: "at-oversized", refresh_token: "rt", expires_in: 3600, token_type: "Bearer", padding: HUGE }));
    });
    await listen(tokenSrv);
    servers.push(tokenSrv);
    const tokenUrl = `http://127.0.0.1:${tokenSrv.address().port}/token`;

    __resetConnectionsRateLimitState();
    __resetOAuthRefreshState();
    const conn = seedExpiredConn(db, "oversized", tokenUrl);
    const tinyGuard = { ...GUARD, maxResponseBytes: 200 }; // far below HUGE
    const r = await performAuthenticatedRequest({ db }, [conn.id], tinyGuard, { connection: conn.id, path: "/x" });

    check("3a oversized: refresh reported as a clean failure (not a throw)", r.ok === false);
    check("3a oversized: error names the byte cap", r.ok === false && /byte cap|exceeded/i.test(r.error));
    check("3a oversized: the padding payload never reaches the agent-facing error", r.ok === false && !r.error.includes("X".repeat(200)));
  }

  // ============ Part 4 — an error body containing a canary must NEVER reach the agent-facing error ============
  {
    const CANARY = "CANARY-SECRET-LEAK-9f8e7d6c5b4a";
    const tokenSrv = http.createServer((req, res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_grant", error_description: `internal detail: ${CANARY}` }));
    });
    await listen(tokenSrv);
    servers.push(tokenSrv);
    const tokenUrl = `http://127.0.0.1:${tokenSrv.address().port}/token`;

    __resetConnectionsRateLimitState();
    __resetOAuthRefreshState();
    const conn = seedExpiredConn(db, "canary", tokenUrl);
    const r = await performAuthenticatedRequest({ db }, [conn.id], GUARD, { connection: conn.id, path: "/x" });

    check("4a canary: refresh reported as a clean failure (not a throw)", r.ok === false);
    check("4a canary: the agent-facing error does NOT contain the token endpoint's raw body/canary", r.ok === false && !JSON.stringify(r).includes(CANARY));
    check("4a canary: the error still carries actionable status information (not silently empty)", r.ok === false && /400/.test(r.error));
  }

  console.log(failures === 0
    ? "\n✅ ALL PASS — connections/oauth.ts's token-endpoint calls (via the shared boundedFetch helper): a 307/308 from the token endpoint is NEVER auto-followed (cross-origin credential exfiltration closed, proven against a real redirect target on a real server), a hung token endpoint resolves within its own bound and frees inFlightRefresh for the next call instead of wedging it, an oversized response is capped while streaming with no body leak, and an error body's raw content (a canary string standing in for a real secret/internal detail) never reaches the agent-facing error — status + length only."
    : `\n❌ ${failures} FAILURE(S).`);
} finally {
  for (const s of servers) await close(s).catch(() => {});
  db.close();
  cleanupPathSync(tmpHome);
}
process.exit(failures === 0 ? 0 : 1);
