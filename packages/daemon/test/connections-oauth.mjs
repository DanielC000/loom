import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// OAuth2 authorization-code + PKCE flow (agent-tooling epic P5a, card c9440b57). SECURITY-CRITICAL,
// fully hermetic: NO real network. Part 1 drives the REAL gateway REST routes (buildServer + app.inject)
// end-to-end — register -> consent-initiate -> loopback callback -> code exchange — against a MOCK
// provider token endpoint: `globalThis.fetch` is monkeypatched for the duration of this test (restored in
// `finally`) to a stub responder keyed off the exact tokenUrl, so the REAL `exchangeAuthorizationCode` /
// gateway callback-route code runs unmodified against a local stub instead of a real provider (never real
// credentials). The stub independently re-derives the PKCE S256 challenge from the code_verifier the
// client sends and rejects a mismatch, so this is a genuine protocol round-trip, not just a shape check.
// Part 2 drives `performAuthenticatedRequest` directly (mirrors authenticated-request.mjs's Part 1 style)
// via its own `fetchImpl`/`now` test seams to cover the full token lifecycle: fresh-token use, lazy
// refresh-on-use, concurrent-refresh dedupe, clean failure (needs-reauth) on a revoked refresh token
// (unrecoverable, a 4xx/invalid_grant-shaped response), and clean failure WITHOUT needs-reauth on a
// transient refresh failure (a network error or a token-endpoint 5xx) — card 48564ab4.
//
// Covers the card's DoD:
//   - a full authorization-code+PKCE round-trip against a mock provider: initiate -> callback -> code
//     exchange -> persist -> a subsequent authenticated_request uses the token -> expiry -> refresh-on-use
//     -> dedupe under concurrency.
//   - human-only + never-echo: no MCP tool exposes any oauth-related surface; the client secret / access /
//     refresh tokens NEVER appear in any REST response body.
//
// Run: 1) build (turbo builds shared first), 2) node test/connections-oauth.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-connections-oauth-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_PORT = "43171"; // paths.ts reads this ONCE at import — must be set before any dist import

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const {
  createOAuthConnection, getOAuthTokenBundle, saveOAuthTokens, getConnectionMetadata, listConnections,
} = await import("../dist/connections/store.js");
const { performAuthenticatedRequest, __resetConnectionsRateLimitState } = await import("../dist/connections/request.js");
const { __resetOAuthRefreshState } = await import("../dist/connections/oauth.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { SetupMcpRouter } = await import("../dist/mcp/setup.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

const dbFile = (name) => path.join(tmpHome, name);
const CLIENT_SECRET = "mock-client-secret-DO-NOT-LEAK-xyz789";
const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const challengeFor = (verifier) => b64url(createHash("sha256").update(verifier).digest());

try {
  // ============ Part 1 — REST + PKCE consent round-trip (gateway layer, real routes) ============
  {
    const db = new Db(dbFile("p1.db"));
    const stub = {};
    const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub });
    const bodies = []; // every response body — swept for secrets at the end.
    const inject = async (opts) => { const r = await app.inject(opts); bodies.push(r.payload); return r; };

    const TOKEN_URL = "https://mock-token.example/oauth/token";
    const AUTH_URL = "https://mock-auth.example/oauth/authorize";

    // --- Mock provider token endpoint: a stub responder swapped in for globalThis.fetch, restored after. ---
    const originalFetch = globalThis.fetch;
    let tokenCallCount = 0;
    const issuedCodes = new Map(); // code -> expected code_challenge (PKCE)
    let latestGoodCode = null;
    globalThis.fetch = async (url, init) => {
      const urlStr = String(url);
      if (urlStr !== TOKEN_URL) throw new Error(`unexpected real fetch to ${urlStr} (test only stubs the token endpoint)`);
      tokenCallCount++;
      const params = new URLSearchParams(init.body);
      if (params.get("client_id") !== "mock-client-id" || params.get("client_secret") !== CLIENT_SECRET) {
        return new Response(JSON.stringify({ error: "invalid_client" }), { status: 401, headers: { "content-type": "application/json" } });
      }
      const code = params.get("code");
      const expectedChallenge = issuedCodes.get(code);
      if (!expectedChallenge) {
        return new Response(JSON.stringify({ error: "invalid_grant", error_description: "unknown code" }), { status: 400, headers: { "content-type": "application/json" } });
      }
      const verifier = params.get("code_verifier") ?? "";
      if (challengeFor(verifier) !== expectedChallenge) {
        return new Response(JSON.stringify({ error: "invalid_grant", error_description: "PKCE verification failed" }), { status: 400, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ access_token: "mock-access-token-1", refresh_token: "mock-refresh-token-1", expires_in: 3600, token_type: "Bearer" }), { status: 200, headers: { "content-type": "application/json" } });
    };

    try {
      // --- 1a. register a custom-provider oauth2 connection (human-only REST) ---
      const register = await inject({ method: "POST", url: "/api/connections/oauth", payload: {
        name: "Mock Provider", host: "api.mock-provider.example", provider: "custom",
        clientId: "mock-client-id", clientSecret: CLIENT_SECRET, authUrl: AUTH_URL, tokenUrl: TOKEN_URL, scopes: ["read", "write"],
      } });
      const conn = JSON.parse(register.payload);
      check("1a register: -> 201 with oauth2 metadata", register.statusCode === 201 && conn.authScheme === "oauth2" && conn.provider === "custom");
      check("1a register: starts NOT connected", conn.connected === false);
      check("1a register: response has no client secret / token fields", !("clientSecret" in conn) && !("secretBlob" in conn) && !("accessToken" in conn));

      // --- 1b. masked list read never carries secret material ---
      const list = await inject({ method: "GET", url: "/api/connections" });
      const listBody = JSON.parse(list.payload);
      check("1b list: the new connection is present, masked", listBody.some((c) => c.id === conn.id && c.authScheme === "oauth2"));
      check("1b list: JSON has no secret-shaped key anywhere", !JSON.stringify(listBody).includes(CLIENT_SECRET));

      // --- 1c/1d. initiate consent -> well-formed provider auth URL ---
      const initiate1 = await inject({ method: "POST", url: `/api/connections/${conn.id}/oauth/consent` });
      check("1c consent-initiate: -> 200 with an authUrl", initiate1.statusCode === 200 && typeof JSON.parse(initiate1.payload).authUrl === "string");
      const parsed1 = new URL(JSON.parse(initiate1.payload).authUrl);
      check("1d authUrl: rooted at the provider's auth endpoint", parsed1.origin + parsed1.pathname === AUTH_URL);
      check("1d authUrl: client_id present", parsed1.searchParams.get("client_id") === "mock-client-id");
      check("1d authUrl: redirect_uri is the FIXED loopback callback on this daemon's own port", parsed1.searchParams.get("redirect_uri") === "http://127.0.0.1:43171/oauth/callback");
      check("1d authUrl: response_type=code", parsed1.searchParams.get("response_type") === "code");
      check("1d authUrl: scope carries the registered scopes", parsed1.searchParams.get("scope") === "read write");
      check("1d authUrl: code_challenge_method=S256", parsed1.searchParams.get("code_challenge_method") === "S256");
      check("1d authUrl: a state param is present (CSRF correlation)", !!parsed1.searchParams.get("state"));
      check("1d authUrl: a code_challenge is present", !!parsed1.searchParams.get("code_challenge"));
      const state1 = parsed1.searchParams.get("state");
      const challenge1 = parsed1.searchParams.get("code_challenge");

      // --- 1e. callback with an UNKNOWN code -> the mock rejects it (invalid_grant), no connection made ---
      const cbBad = await inject({ method: "GET", url: `/oauth/callback?code=totally-unknown-code&state=${encodeURIComponent(state1)}` });
      check("1e callback bad code: -> 502 (token exchange failed)", cbBad.statusCode === 502);
      check("1e callback bad code: connection still not connected", getConnectionMetadata(db, conn.id).connected === false);

      // --- 1f. the SAME state is now consumed (one-shot) — a replay is rejected outright ---
      const cbReplay = await inject({ method: "GET", url: `/oauth/callback?code=whatever&state=${encodeURIComponent(state1)}` });
      check("1f callback replay of a consumed state: -> 400", cbReplay.statusCode === 400);
      check("1f callback replay: names it as expired/already used", /expired|already used/i.test(cbReplay.payload));

      // --- 1g. a FRESH consent-initiate + the CORRECT code + valid PKCE verifier -> success ---
      const initiate2 = await inject({ method: "POST", url: `/api/connections/${conn.id}/oauth/consent` });
      const parsed2 = new URL(JSON.parse(initiate2.payload).authUrl);
      const state2 = parsed2.searchParams.get("state");
      const challenge2 = parsed2.searchParams.get("code_challenge");
      check("1g fresh consent: a NEW state is issued (not reused)", state2 !== state1);
      issuedCodes.set("good-auth-code", challenge2);
      const cbGood = await inject({ method: "GET", url: `/oauth/callback?code=good-auth-code&state=${encodeURIComponent(state2)}` });
      check("1g callback good code+PKCE: -> 200", cbGood.statusCode === 200);
      check("1g callback good code+PKCE: friendly HTML confirms connection", /connected/i.test(cbGood.payload));
      const afterConnect = getConnectionMetadata(db, conn.id);
      check("1g after exchange: connected flips true", afterConnect.connected === true);
      check("1g after exchange: tokenExpiresAt set", typeof afterConnect.tokenExpiresAt === "string");
      check("1g after exchange: needsReauth false", afterConnect.needsReauth === false);
      check("1g exactly 2 real token-endpoint calls happened (1e's bad-code attempt + 1g's good one; 1f never reached the endpoint)", tokenCallCount === 2);

      // --- 1h. provider-side consent denial (?error=...) never attempts a token exchange ---
      const callsBeforeDenial = tokenCallCount;
      const cbDenied = await inject({ method: "GET", url: "/oauth/callback?error=access_denied" });
      check("1h consent denied: a friendly page, not a crash", cbDenied.statusCode === 200 && /not completed/i.test(cbDenied.payload));
      check("1h consent denied: no token exchange was attempted", tokenCallCount === callsBeforeDenial);

      // --- 1i. malformed callback (missing code/state) is rejected cleanly ---
      const cbMalformed = await inject({ method: "GET", url: "/oauth/callback" });
      check("1i malformed callback (no code/state): -> 400", cbMalformed.statusCode === 400);

      // --- 1i2. the CSRF/Origin-exemption carve-out for GET /oauth/callback (the onRequest hook's most
      // security-sensitive branch) — locks it so a future regression that broadens or drops it fails here. ---
      {
        // A NORMAL route still refuses a cross-origin Origin — the exemption is NOT global.
        const normalCrossOrigin = await inject({ method: "GET", url: "/api/connections", headers: { origin: "https://evil.example.com" } });
        check("1i2 cross-origin Origin on a NORMAL route: -> 403 (exemption is narrow, not global)", normalCrossOrigin.statusCode === 403);

        // The callback route itself tolerates a cross-origin Origin (a top-level provider redirect may or
        // may not carry one) — it must NOT be 403'd on Origin grounds. No state is provided, so a 400
        // (malformed callback) is the expected non-CSRF rejection — the point is it's not 403.
        const callbackCrossOrigin = await inject({ method: "GET", url: "/oauth/callback", headers: { origin: "https://evil.example.com" } });
        check("1i2 cross-origin Origin on GET /oauth/callback: NOT rejected as cross-origin (403)", callbackCrossOrigin.statusCode !== 403);
        check("1i2 cross-origin Origin on GET /oauth/callback: still 400 for the actual reason (missing code/state)", callbackCrossOrigin.statusCode === 400);

        // The Host check is UNCHANGED by the Origin exemption — a non-loopback Host still 403s the callback.
        const callbackBadHost = await inject({ method: "GET", url: "/oauth/callback", headers: { host: "evil.example.com" } });
        check("1i2 non-loopback Host on GET /oauth/callback: STILL -> 403 (Host check is not exempted)", callbackBadHost.statusCode === 403);
      }

      // --- 1j. the plaintext client secret / access / refresh tokens NEVER appear in ANY response body ---
      const leaked = [CLIENT_SECRET, "mock-access-token-1", "mock-refresh-token-1"].some((s) => bodies.some((b) => b.includes(s)));
      check("1j: no client secret / access / refresh token ever appears in a REST response body", !leaked);
    } finally {
      globalThis.fetch = originalFetch;
    }

    // --- 1k. HUMAN-ONLY: no MCP tool (setup / orchestration manager+worker+assistant / platform) exposes
    // any oauth-related surface — mirrors connections-store.mjs Part 4's pattern, extended to "oauth". ---
    {
      class SeamHost extends PtyHost {
        createPty() { return { pid: 1, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} }; }
        stop() {}
      }
      const host = new SeamHost({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} });
      const svc = new SessionService(db, host, new OrchestrationControl());
      const orch = new OrchestrationMcpRouter(db, svc);
      const setup = new SetupMcpRouter(db, svc);
      const platform = new PlatformMcpRouter(db, svc);

      const listOf = async (server) => {
        const [clientT, serverT] = InMemoryTransport.createLinkedPair();
        await server.connect(serverT);
        const client = new Client({ name: "connections-oauth-test", version: "0" });
        await client.connect(clientT);
        const tools = (await client.listTools()).tools;
        await client.close();
        return tools;
      };
      const mentionsOAuth = (tools) => tools.some((t) => /oauth/i.test(t.name) || /oauth/i.test(t.description ?? ""));

      for (const [label, tools] of [
        ["orchestration (manager)", await listOf(orch.buildServer("mgr-1", "manager"))],
        ["orchestration (worker)", await listOf(orch.buildServer("wkr-1", "worker"))],
        ["orchestration (assistant)", await listOf(orch.buildServer("assist-1", "assistant"))],
        ["setup", await listOf(setup.buildServer())],
        ["platform", await listOf(platform.buildServer("plat-1"))],
      ]) {
        check(`1k ${label}: NO tool name or description mentions 'oauth'`, !mentionsOAuth(tools));
      }
    }

    await app.close();
    db.close();
  }

  // ============ Part 2 — token lifecycle via performAuthenticatedRequest (direct, mirrors P2's style) ============
  {
    const db = new Db(dbFile("p2.db"));
    const conn = createOAuthConnection(db, {
      name: "Lifecycle Conn", host: "api.example.com", provider: "custom",
      clientId: "lc-client-id", clientSecret: CLIENT_SECRET,
      authUrl: "https://auth.example.com/authorize", tokenUrl: "https://token.example.com/token", scopes: ["read"],
    });
    const TOKEN_URL = "https://token.example.com/token";
    const RESOURCE_URL = "https://api.example.com/widgets";
    const GUARD = { requestTimeoutMs: 5000, maxResponseBytes: 100000, rateLimitMax: 1000, rateLimitWindowMs: 60000 };

    const T0 = 1_800_000_000_000; // an arbitrary fixed epoch ms baseline
    // Seed an already-valid token (as if a consent round-trip had just completed) — expires 1h after T0.
    saveOAuthTokens(db, conn.id, { clientSecret: CLIENT_SECRET, accessToken: "at-1", refreshToken: "rt-1", expiresAt: new Date(T0 + 3600_000).toISOString() }, undefined);

    // --- 2a. token still fresh: resource call uses it directly, NO token-endpoint call ---
    {
      __resetConnectionsRateLimitState();
      let tokenCalls = 0, resourceAuth = null;
      const fetchImpl = async (url, init) => {
        const u = String(url);
        if (u === TOKEN_URL) { tokenCalls++; throw new Error("should not refresh — token is still fresh"); }
        if (u === RESOURCE_URL) { resourceAuth = init.headers.Authorization; return new Response("ok", { status: 200 }); }
        throw new Error(`unexpected fetch: ${u}`);
      };
      const r = await performAuthenticatedRequest({ db, fetchImpl, now: () => T0 + 60_000 }, [conn.id], GUARD, { connection: conn.id, path: "/widgets" });
      check("2a fresh token: request succeeds", r.ok === true);
      check("2a fresh token: Authorization uses the CURRENT access token", resourceAuth === "Bearer at-1");
      check("2a fresh token: no refresh attempted", tokenCalls === 0);
    }

    // --- 2b. near/at expiry: lazy refresh-on-use fires, resource call uses the NEW token ---
    {
      __resetConnectionsRateLimitState();
      let tokenCalls = 0, resourceAuth = null, refreshBody = null;
      const fetchImpl = async (url, init) => {
        const u = String(url);
        if (u === TOKEN_URL) {
          tokenCalls++;
          refreshBody = new URLSearchParams(init.body);
          return new Response(JSON.stringify({ access_token: "at-2", refresh_token: "rt-2", expires_in: 3600, token_type: "Bearer" }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (u === RESOURCE_URL) { resourceAuth = init.headers.Authorization; return new Response("ok", { status: 200 }); }
        throw new Error(`unexpected fetch: ${u}`);
      };
      // now is PAST the at-1 expiry (T0 + 3600_000) — refresh must fire.
      const nowPastExpiry = T0 + 3600_000 + 1000;
      const r = await performAuthenticatedRequest({ db, fetchImpl, now: () => nowPastExpiry }, [conn.id], GUARD, { connection: conn.id, path: "/widgets" });
      check("2b expired token: request still succeeds (transparent refresh)", r.ok === true);
      check("2b expired token: refresh grant used the OLD refresh token", refreshBody?.get("grant_type") === "refresh_token" && refreshBody?.get("refresh_token") === "rt-1");
      check("2b expired token: exactly ONE refresh call", tokenCalls === 1);
      check("2b expired token: resource call used the NEW access token", resourceAuth === "Bearer at-2");
      const metaAfter = getConnectionMetadata(db, conn.id);
      check("2b expired token: DB persisted the new expiry", metaAfter.tokenExpiresAt === new Date(nowPastExpiry + 3600_000).toISOString());
      check("2b expired token: needsReauth stays false on a successful refresh", metaAfter.needsReauth === false);
    }

    // --- 2b2. a HOSTILE/nonconforming expires_in (non-numeric) is sanitized, never crashes the refresh ---
    {
      __resetConnectionsRateLimitState();
      __resetOAuthRefreshState();
      let resourceAuth = null;
      const fetchImpl = async (url, init) => {
        const u = String(url);
        if (u === TOKEN_URL) {
          // A hostile/nonconforming token endpoint sending a non-numeric expires_in — previously this
          // reached `new Date(now + expires_in * 1000)` downstream and threw RangeError.
          return new Response(JSON.stringify({ access_token: "at-2b", refresh_token: "rt-2b", expires_in: "not-a-number", token_type: "Bearer" }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (u === RESOURCE_URL) { resourceAuth = init.headers.Authorization; return new Response("ok", { status: 200 }); }
        throw new Error(`unexpected fetch: ${u}`);
      };
      const nowPastAt2Expiry = T0 + 3600_000 + 1000 + 3600_000 + 1000; // past at-2's expiry (set by 2b above); forces a refresh here too
      let threw = null;
      let r;
      try {
        r = await performAuthenticatedRequest({ db, fetchImpl, now: () => nowPastAt2Expiry }, [conn.id], GUARD, { connection: conn.id, path: "/widgets" });
      } catch (err) {
        threw = err;
      }
      check("2b2 hostile expires_in: never throws (RangeError from an invalid Date)", threw === null);
      check("2b2 hostile expires_in: the request still succeeds using the new access token", r?.ok === true && resourceAuth === "Bearer at-2b");
      check("2b2 hostile expires_in: sanitized to null (fail-safe), not stored as a bogus expiry", getConnectionMetadata(db, conn.id).tokenExpiresAt === null);
    }

    // --- 2c. concurrent dedupe: N parallel calls past expiry -> exactly ONE refresh call, ONE fresh token for all ---
    {
      __resetConnectionsRateLimitState();
      __resetOAuthRefreshState();
      let tokenCalls = 0;
      const resourceAuths = [];
      const fetchImpl = async (url, init) => {
        const u = String(url);
        if (u === TOKEN_URL) {
          tokenCalls++;
          await new Promise((resolve) => setTimeout(resolve, 30)); // widen the race window
          return new Response(JSON.stringify({ access_token: "at-3", refresh_token: "rt-3", expires_in: 3600, token_type: "Bearer" }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (u === RESOURCE_URL) { resourceAuths.push(init.headers.Authorization); return new Response("ok", { status: 200 }); }
        throw new Error(`unexpected fetch: ${u}`);
      };
      const nowPastExpiry2 = T0 + 3600_000 + 1000 + 3600_000 + 1000; // past at-2's expiry too
      const results = await Promise.all(Array.from({ length: 5 }, () =>
        performAuthenticatedRequest({ db, fetchImpl, now: () => nowPastExpiry2 }, [conn.id], GUARD, { connection: conn.id, path: "/widgets" }),
      ));
      check("2c concurrent dedupe: all 5 concurrent calls succeed", results.every((r) => r.ok === true));
      check("2c concurrent dedupe: EXACTLY ONE refresh call despite 5 concurrent callers", tokenCalls === 1);
      check("2c concurrent dedupe: every call used the SAME freshly-refreshed token", resourceAuths.length === 5 && resourceAuths.every((a) => a === "Bearer at-3"));
    }

    // --- 2d. refresh failure (revoked refresh token): needs-reauth surfaced, request fails cleanly, no stale token used ---
    {
      __resetConnectionsRateLimitState();
      __resetOAuthRefreshState();
      let resourceCalled = false;
      const fetchImpl = async (url) => {
        const u = String(url);
        if (u === TOKEN_URL) return new Response(JSON.stringify({ error: "invalid_grant", error_description: "Token has been revoked" }), { status: 400, headers: { "content-type": "application/json" } });
        if (u === RESOURCE_URL) { resourceCalled = true; return new Response("ok", { status: 200 }); }
        throw new Error(`unexpected fetch: ${u}`);
      };
      const nowPastExpiry3 = T0 + 3600_000 + 1000 + 3600_000 + 1000 + 3600_000 + 1000; // past at-3's expiry
      const r = await performAuthenticatedRequest({ db, fetchImpl, now: () => nowPastExpiry3 }, [conn.id], GUARD, { connection: conn.id, path: "/widgets" });
      check("2d revoked refresh token: request fails cleanly (not a throw)", r.ok === false);
      check("2d revoked refresh token: error names re-authentication", /re-?auth/i.test(r.error ?? ""));
      check("2d revoked refresh token: the resource endpoint was NEVER called (no stale-token fallback)", resourceCalled === false);
      const metaAfter = getConnectionMetadata(db, conn.id);
      check("2d revoked refresh token: needsReauth flips true", metaAfter.needsReauth === true);
      check("2d revoked refresh token: connected stays true (it WAS connected before going stale)", metaAfter.connected === true);
      check("2d revoked refresh token: the error never contains any token/secret material", !JSON.stringify(r).includes(CLIENT_SECRET) && !JSON.stringify(r).includes("rt-3") && !JSON.stringify(r).includes("at-3"));
    }

    // --- 2d2. TRANSIENT refresh failure (network error): needsReauth is left untouched, no false alarm ---
    {
      __resetConnectionsRateLimitState();
      __resetOAuthRefreshState();
      const metaBefore = getConnectionMetadata(db, conn.id);
      check("2d2 setup: needsReauth is currently true (set by 2d)", metaBefore.needsReauth === true);
      let resourceCalled = false;
      const fetchImpl = async (url) => {
        const u = String(url);
        if (u === TOKEN_URL) throw new Error("ECONNRESET");
        if (u === RESOURCE_URL) { resourceCalled = true; return new Response("ok", { status: 200 }); }
        throw new Error(`unexpected fetch: ${u}`);
      };
      const nowPastExpiry4 = T0 + 3600_000 + 1000 + 3600_000 + 1000 + 3600_000 + 1000 + 3600_000 + 1000; // past at-3's expiry
      const r = await performAuthenticatedRequest({ db, fetchImpl, now: () => nowPastExpiry4 }, [conn.id], GUARD, { connection: conn.id, path: "/widgets" });
      check("2d2 network error: request fails cleanly (not a throw)", r.ok === false);
      check("2d2 network error: error names it as a temporary failure, not re-auth", /temporar/i.test(r.error ?? "") && !/re-?auth/i.test(r.error ?? ""));
      check("2d2 network error: the resource endpoint was NEVER called", resourceCalled === false);
      check("2d2 network error: needsReauth is UNCHANGED (still whatever it was — no new false alarm)", getConnectionMetadata(db, conn.id).needsReauth === metaBefore.needsReauth);
    }

    // --- 2d3. TRANSIENT refresh failure (token endpoint 5xx): needsReauth is left untouched ---
    {
      __resetConnectionsRateLimitState();
      __resetOAuthRefreshState();
      const metaBefore = getConnectionMetadata(db, conn.id);
      let resourceCalled = false;
      const fetchImpl = async (url) => {
        const u = String(url);
        if (u === TOKEN_URL) return new Response("internal server error", { status: 503 });
        if (u === RESOURCE_URL) { resourceCalled = true; return new Response("ok", { status: 200 }); }
        throw new Error(`unexpected fetch: ${u}`);
      };
      const nowPastExpiry5 = T0 + 3600_000 * 5 + 5000; // comfortably past every prior expiry
      const r = await performAuthenticatedRequest({ db, fetchImpl, now: () => nowPastExpiry5 }, [conn.id], GUARD, { connection: conn.id, path: "/widgets" });
      check("2d3 5xx: request fails cleanly (not a throw)", r.ok === false);
      check("2d3 5xx: error names it as a temporary failure, not re-auth", /temporar/i.test(r.error ?? "") && !/re-?auth/i.test(r.error ?? ""));
      check("2d3 5xx: the resource endpoint was NEVER called", resourceCalled === false);
      check("2d3 5xx: needsReauth is UNCHANGED", getConnectionMetadata(db, conn.id).needsReauth === metaBefore.needsReauth);
    }

    // --- 2e. a non-oauth2 connection is unaffected by any of the above (byte-identical legacy path) ---
    {
      const { createConnection } = await import("../dist/connections/store.js");
      const bearerConn = createConnection(db, { name: "Legacy Bearer", host: "legacy.example.com", authScheme: "bearer", secret: "legacy-secret-abc" });
      __resetConnectionsRateLimitState();
      const fetchImpl = async (url, init) => {
        check("2e legacy bearer: Authorization uses the raw stored secret (no oauth machinery involved)", init.headers.Authorization === "Bearer legacy-secret-abc");
        return new Response("ok", { status: 200 });
      };
      const r = await performAuthenticatedRequest({ db, fetchImpl }, [bearerConn.id], GUARD, { connection: bearerConn.id, path: "/x" });
      check("2e legacy bearer: request succeeds", r.ok === true);
    }

    db.close();
  }

  console.log(failures === 0
    ? "\n✅ ALL PASS — oauth2 connections: REST registration + PKCE consent-initiate + loopback callback exercised end-to-end against a mock token endpoint (independent PKCE S256 re-derivation, one-shot state, clean rejection of a bad code/replayed state/denied consent), no secret ever leaks into a REST response body, no MCP tool (setup/orchestration/platform) exposes any oauth surface, and the token lifecycle (fresh-token use -> lazy refresh-on-use -> concurrent-refresh dedupe -> unrecoverable-failure needs-reauth on a revoked refresh token -> transient-failure (network error / 5xx) leaves needs-reauth untouched) all route through the SAME performAuthenticatedRequest seam the agent tool and PollService share, with the legacy api-key/bearer path untouched."
    : `\n❌ ${failures} FAILURE(S).`);
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL/handle retry (Windows) */ } }
}
process.exit(failures === 0 ? 0 : 1);
