import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Access-story Phase C (card 6bc02f50) — actually opening the authenticated remote bind: the
// canOpenRemoteListener boot-refusal (token + TLS-or-tailnet mandate), the CSRF-Host reconciliation that
// lets a real remote client's Host through the DNS-rebind hook, the remote-only rate limiter (sliding
// window + auth-failure lockout), the tightened remoteAccess validator, and the human-only surface.
// SHIPS INERT: remoteAccess.enabled:false by default, so the loopback daemon is unaffected — see
// csrf-rebind.mjs / trust-tier.mjs for the exhaustive default-config + Phase A/B coverage this test does
// NOT repeat. HERMETIC + CLAUDE-FREE + NETWORK-FREE (Db + buildServer via app.inject).
//
// Covers the card's DoD:
//   (1) canOpenRemoteListener / tlsRequirementSatisfied / isTailnetHost: refuses a non-loopback bind
//       without a token, refuses one without TLS (off-tailnet), tailnet bypasses the TLS mandate, and a
//       loopback/disabled config never needs either.
//   (2) Rate limiter: N consecutive WRONG-token 401s from an ip → 429 lockout; a per-ip sliding-window
//       request cap; loopback is fully exempt from both.
//   (3) CSRF-Host reconciliation: a remote Host matching the configured bindHost is NOT 403'd by the
//       CSRF/DNS-rebind hook; a mismatched/attacker Host still 403s.
//   (4) The tightened validator: bindHost host/IP shape + rateLimit upper bounds.
//   (5) No agent-facing config surface (the project-config override schema) can set `remoteAccess` — only
//       the human-only platform-config override can.
//   (9) P5b hardening follow-ups (card 80e2093f): isAllInterfacesBindHost (0.0.0.0/:: bind-posture
//       visibility) and GATEWAY_LOG_SERIALIZERS (the Authorization/Sec-WebSocket-Protocol redaction seam).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "loom-remote-bind-"));
process.env.LOOM_HOME = TMP;
process.env.LOOM_PORT = "45343";
const PORT = process.env.LOOM_PORT;
const sandboxHome = path.join(TMP, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer, GATEWAY_LOG_SERIALIZERS } = await import("../dist/gateway/server.js");
const { canOpenRemoteListener, tlsRequirementSatisfied, isTailnetHost, isTrustTierHookActive, isAllInterfacesBindHost } = await import("../dist/gateway/trust-tier.js");
const { validatePlatformConfigOverride, validateProjectConfigOverride } = await import("../dist/mcp/platform.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const stub = {};
const buildApp = (db, overrides = {}) => buildServer({
  db, pty: stub, sessions: { killAllWorkers: () => 0 }, mcp: stub, orchMcp: stub, platformMcp: stub,
  auditMcp: stub, userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub,
  requestShutdown: () => {},
  ...overrides,
});

// ===================== (1) canOpenRemoteListener / tlsRequirementSatisfied / isTailnetHost ==================
{
  const disabled = { enabled: false, bindHost: "127.0.0.1" };
  check("(1) disabled config never opens a remote listener regardless of token/TLS", canOpenRemoteListener(disabled, true, true) === false);

  const loopbackEnabled = { enabled: true, bindHost: "127.0.0.1" };
  check("(1) enabled but loopback bindHost is not a 'remote' bind — canOpenRemoteListener false", canOpenRemoteListener(loopbackEnabled, true, true) === false);
  check("(1) ...and the trust-tier hook itself never activates for a loopback bindHost", isTrustTierHookActive(loopbackEnabled) === false);

  const remoteNoTlsNoTailnet = { enabled: true, bindHost: "example.com" };
  check("(1) remote + NO token → refused", canOpenRemoteListener(remoteNoTlsNoTailnet, false, true) === false);
  check("(1) remote + token but NO tls configured (non-tailnet) → refused", canOpenRemoteListener(remoteNoTlsNoTailnet, true, false) === false);
  check("(1) ...tlsRequirementSatisfied itself is false with no tls block + non-tailnet host", tlsRequirementSatisfied(remoteNoTlsNoTailnet, true) === false);

  const remoteWithTls = { enabled: true, bindHost: "example.com", tls: { certPath: "/a/cert.pem", keyPath: "/a/key.pem" } };
  check("(1) remote + token + tls configured but files NOT on disk → refused", canOpenRemoteListener(remoteWithTls, true, false) === false);
  check("(1) remote + token + tls configured AND files on disk → allowed", canOpenRemoteListener(remoteWithTls, true, true) === true);

  const tailnet = { enabled: true, bindHost: "myhost.tailnet-abc123.ts.net" };
  check("(1) isTailnetHost recognizes a .ts.net suffix", isTailnetHost(tailnet.bindHost) === true);
  check("(1) isTailnetHost rejects a lookalike non-.ts.net host", isTailnetHost("ts.net.evil.example.com") === false);
  check("(1) a tailnet bindHost satisfies the TLS mandate with NO tls block configured at all", tlsRequirementSatisfied(tailnet, false) === true);
  check("(1) ...so canOpenRemoteListener only needs a token for a tailnet bind", canOpenRemoteListener(tailnet, true, false) === true);
  check("(1) ...and still refuses without a token even on a tailnet", canOpenRemoteListener(tailnet, false, false) === false);
}

// ===================== (6) CR follow-up — the existsSync-vs-readFileSync two-path asymmetry ================
// A cert/key that EXISTS but is UNREADABLE (or a directory, or invalid PEM content) must NEVER leave the
// server silently on plain HTTP while a caller's boot decision believes TLS is live. buildServer's
// `onHttpsResolved` callback is the ONE real signal for this — prove it fires `false` (not a throw) for
// every one of these failure shapes, and that the resulting boot decision (mirroring index.ts) stays
// loopback rather than opening a public interface as plain HTTP.
{
  const NON_TAILNET_REMOTE_HOST = "loom-tls-fail-test.example.com";

  // (6a) certPath is a DIRECTORY (readFileSync throws EISDIR) — a portable stand-in for "unreadable"
  // that doesn't depend on chmod semantics differing across Windows/POSIX.
  {
    const dirAsCert = path.join(TMP, "cert-is-a-dir");
    fs.mkdirSync(dirAsCert, { recursive: true });
    const keyFile = path.join(TMP, "some-key.pem");
    fs.writeFileSync(keyFile, "irrelevant — cert read throws first");
    const remoteAccessCfg = { enabled: true, bindHost: NON_TAILNET_REMOTE_HOST, tls: { certPath: dirAsCert, keyPath: keyFile } };
    const db = new Db(path.join(TMP, "loom-tls-dir.db"));
    db.setPlatformConfig({ remoteAccess: remoteAccessCfg });
    let httpsActive = "not called";
    let threw = false;
    let app;
    try {
      app = await buildApp(db, { onHttpsResolved: (active) => { httpsActive = active; } });
    } catch { threw = true; }
    check("(6a) certPath-is-a-directory: buildServer does NOT throw", threw === false);
    check("(6a) certPath-is-a-directory: onHttpsResolved fires false (not left uncalled)", httpsActive === false);
    check("(6a) certPath-is-a-directory: the boot decision (mirroring index.ts) stays loopback (canOpenRemoteListener false)",
      canOpenRemoteListener(remoteAccessCfg, true, httpsActive) === false);
    if (app) await app.close();
    db.close();
  }

  // (6b) cert/key files EXIST and are readable, but their CONTENT is not valid PEM material — the failure
  // only surfaces once Node's TLS layer parses the bytes, i.e. at Fastify's https construction, AFTER the
  // readFileSync try/catch has already succeeded. Must degrade the SAME way, not crash buildServer.
  {
    const garbageCert = path.join(TMP, "garbage-cert.pem");
    const garbageKey = path.join(TMP, "garbage-key.pem");
    fs.writeFileSync(garbageCert, "this is not a certificate\n");
    fs.writeFileSync(garbageKey, "this is not a key\n");
    const db = new Db(path.join(TMP, "loom-tls-garbage.db"));
    db.setPlatformConfig({ remoteAccess: { enabled: true, bindHost: NON_TAILNET_REMOTE_HOST, tls: { certPath: garbageCert, keyPath: garbageKey } } });
    let httpsActive = "not called";
    let threw = false;
    let app;
    try {
      app = await buildApp(db, { onHttpsResolved: (active) => { httpsActive = active; } });
    } catch { threw = true; }
    check("(6b) invalid PEM content: buildServer does NOT throw (caught at Fastify construction, not left to crash boot)", threw === false);
    check("(6b) invalid PEM content: onHttpsResolved fires false", httpsActive === false);
    check("(6b) invalid PEM content: the boot decision stays loopback", canOpenRemoteListener({ enabled: true, bindHost: NON_TAILNET_REMOTE_HOST, tls: { certPath: garbageCert, keyPath: garbageKey } }, true, httpsActive) === false);
    // And the server still WORKS over plain HTTP for a loopback caller — a TLS failure degrades gracefully,
    // it doesn't take the whole daemon down.
    if (app) {
      const r = await app.inject({ method: "GET", url: "/api/version" }); // default loopback Host/remoteAddress
      check("(6b) the degraded (plain-HTTP) server still serves loopback requests normally", r.statusCode === 200);
      await app.close();
    }
    db.close();
  }
  // NOTE: the happy path (valid TLS material actually applied → onHttpsResolved fires TRUE) is NOT
  // exercised end-to-end here — Node has no built-in "mint a self-signed X.509 cert" helper, and this
  // repo bundles no cert-generation tool, so a real readable-and-VALID PEM pair isn't hermetically
  // producible in this test. Section (1)'s pure-function coverage already proves the happy-path GATING
  // logic (`canOpenRemoteListener(remoteWithTls, true, true) === true`) independent of real PEM bytes;
  // 6a/6b above are the security-relevant regression this CR asked for (a present-but-broken cert/key
  // must never silently leave the server on plain HTTP while the boot decision believes TLS is live).
}

// ===================== (7) CR follow-up — rate-limiter Map eviction (unbounded growth) ======================
{
  const { SlidingWindowCounter } = await import("../dist/gateway/remote-rate-limit.js");
  const counter = new SlidingWindowCounter();
  const BASE_MS = 1_000_000_000_000;
  const N = 2001; // one past the internal SWEEP_THRESHOLD (2000) — triggers a self-sweep
  for (let i = 0; i < N; i++) counter.allow(`attacker-ip-${i}`, 100, BASE_MS);
  check(`(7) ${N} distinct one-off keys are all tracked immediately (nothing stale yet within the window)`, counter.size === N);
  // Advance past the 60s window, then touch ONE more key — this pushes size over threshold again and
  // self-triggers a sweep that must reclaim every now-stale entry, not just skip past them forever.
  const LATER_MS = BASE_MS + 61_000;
  counter.allow("attacker-ip-fresh", 100, LATER_MS);
  check("(7) crossing the threshold again with an expired backlog SWEEPS stale entries (bounded growth, not indefinite accumulation)", counter.size === 1);
}

// ===================== (4) tightened validator: bindHost shape + rateLimit bounds ==========================
{
  check("(4) bindHost '127.0.0.1' (loopback IP) accepted", validatePlatformConfigOverride({ remoteAccess: { bindHost: "127.0.0.1" } }).ok === true);
  check("(4) bindHost a valid tailnet hostname accepted", validatePlatformConfigOverride({ remoteAccess: { bindHost: "myhost.tailnet-abc.ts.net" } }).ok === true);
  check("(4) bindHost a bare IPv6 literal accepted", validatePlatformConfigOverride({ remoteAccess: { bindHost: "::1" } }).ok === true);
  check("(4) bindHost with a space rejected", validatePlatformConfigOverride({ remoteAccess: { bindHost: "not a host" } }).ok === false);
  check("(4) bindHost shaped like a URL rejected", validatePlatformConfigOverride({ remoteAccess: { bindHost: "http://example.com" } }).ok === false);
  check("(4) bindHost with a leading-hyphen label rejected", validatePlatformConfigOverride({ remoteAccess: { bindHost: "-bad.example.com" } }).ok === false);
  check("(4) empty bindHost rejected", validatePlatformConfigOverride({ remoteAccess: { bindHost: "" } }).ok === false);

  const goodRateLimit = { perIpPerMin: 60, perTokenPerMin: 60, authFailLockout: { maxAttempts: 5, windowMs: 600000, lockoutMs: 900000 } };
  check("(4) a well-formed rateLimit block accepted", validatePlatformConfigOverride({ remoteAccess: { rateLimit: goodRateLimit } }).ok === true);
  check("(4) perIpPerMin:0 (<1 floor) rejected", validatePlatformConfigOverride({ remoteAccess: { rateLimit: { ...goodRateLimit, perIpPerMin: 0 } } }).ok === false);
  check("(4) perIpPerMin:100001 (>100000 ceiling) rejected", validatePlatformConfigOverride({ remoteAccess: { rateLimit: { ...goodRateLimit, perIpPerMin: 100001 } } }).ok === false);
  check("(4) authFailLockout.lockoutMs:86400001 (>24h ceiling) rejected",
    validatePlatformConfigOverride({ remoteAccess: { rateLimit: { ...goodRateLimit, authFailLockout: { ...goodRateLimit.authFailLockout, lockoutMs: 86400001 } } } }).ok === false);
  check("(4) authFailLockout.windowMs:999 (<1s floor) rejected",
    validatePlatformConfigOverride({ remoteAccess: { rateLimit: { ...goodRateLimit, authFailLockout: { ...goodRateLimit.authFailLockout, windowMs: 999 } } } }).ok === false);
  // legacy Phase-A {max,windowMs} shape is a DIFFERENT (now-stale) shape — rejected as unknown keys.
  check("(4) the old Phase-A {max,windowMs} rateLimit shape is rejected (shape changed in Phase C)",
    validatePlatformConfigOverride({ remoteAccess: { rateLimit: { max: 10, windowMs: 60000 } } }).ok === false);
}

// ===================== (5) no agent-facing config surface can set remoteAccess =============================
{
  check("(5) the human-only platform override accepts remoteAccess", validatePlatformConfigOverride({ remoteAccess: { enabled: true, bindHost: "example.com" } }).ok === true);
  const agentAttempt = validateProjectConfigOverride({ remoteAccess: { enabled: true, bindHost: "example.com" } });
  check("(5) the project-config override (the agent-reachable schema) REJECTS remoteAccess as an unknown key", agentAttempt.ok === false);
}

// ===================== (2) rate limiter + (3) CSRF-Host reconciliation, over a real buildServer =============
const REMOTE_BIND_HOST = "loom-remote-test.example.com";
const GOOD_TOKEN = "test-valid-gateway-token";
const dbOn = new Db(path.join(TMP, "loom-on.db"));
dbOn.setPlatformConfig({
  remoteAccess: {
    enabled: true, bindHost: REMOTE_BIND_HOST,
    rateLimit: { perIpPerMin: 3, perTokenPerMin: 3, authFailLockout: { maxAttempts: 2, windowMs: 600000, lockoutMs: 900000 } },
  },
});
const appOn = await buildApp(dbOn, { verifyGatewayToken: (token) => token === GOOD_TOKEN });
const REMOTE_IP = "203.0.113.9";
try {
  // --- (3) CSRF-Host reconciliation ---
  const remoteHostOk = await appOn.inject({
    method: "GET", url: "/api/version", remoteAddress: REMOTE_IP,
    headers: { host: REMOTE_BIND_HOST, authorization: `Bearer ${GOOD_TOKEN}` },
  });
  check("(3) a remote request with Host === the configured bindHost is NOT 403'd by the CSRF hook (reaches the trust-tier hook, 200 with a valid token)", remoteHostOk.statusCode === 200);
  const remoteHostMismatch = await appOn.inject({
    method: "GET", url: "/api/version", remoteAddress: REMOTE_IP,
    headers: { host: "attacker.example.com", authorization: `Bearer ${GOOD_TOKEN}` },
  });
  check("(3) a remote request with a MISMATCHED Host (attacker.example.com) still 403s (DNS-rebind defence intact)", remoteHostMismatch.statusCode === 403);
  const remoteOriginOk = await appOn.inject({
    method: "GET", url: "/api/version", remoteAddress: REMOTE_IP,
    headers: { host: REMOTE_BIND_HOST, origin: `https://${REMOTE_BIND_HOST}`, authorization: `Bearer ${GOOD_TOKEN}` },
  });
  check("(3) a remote request whose Origin ALSO matches the configured bindHost passes the CSRF Origin check", remoteOriginOk.statusCode === 200);
  const remoteOriginMismatch = await appOn.inject({
    method: "GET", url: "/api/version", remoteAddress: REMOTE_IP,
    headers: { host: REMOTE_BIND_HOST, origin: "https://evil.example.com", authorization: `Bearer ${GOOD_TOKEN}` },
  });
  check("(3) a remote request with a cross-origin Origin (not the bindHost) still 403s", remoteOriginMismatch.statusCode === 403);

  // --- (2) auth-failure lockout: maxAttempts:2 — two WRONG-token 401s lock this ip out, a THIRD 429s ---
  const lockoutIp = "203.0.113.10";
  const badTokenReq = () => appOn.inject({
    method: "GET", url: "/api/version", remoteAddress: lockoutIp,
    headers: { host: REMOTE_BIND_HOST, authorization: "Bearer wrong-token-guess" },
  });
  const fail1 = await badTokenReq();
  check("(2) 1st wrong-token request → 401 (not yet locked)", fail1.statusCode === 401);
  const fail2 = await badTokenReq();
  check("(2) 2nd wrong-token request (hits maxAttempts:2) → 401", fail2.statusCode === 401);
  const fail3 = await badTokenReq();
  check("(2) 3rd request from the SAME ip, even with the VALID token, is now locked out → 429", fail3.statusCode === 429);
  const fail3WithGoodToken = await appOn.inject({
    method: "GET", url: "/api/version", remoteAddress: lockoutIp,
    headers: { host: REMOTE_BIND_HOST, authorization: `Bearer ${GOOD_TOKEN}` },
  });
  check("(2) ...lockout blocks even a VALID token from this ip until it expires (429, not 200)", fail3WithGoodToken.statusCode === 429);

  // An entirely ABSENT token must never itself count toward the lockout (ordinary unauthenticated first
  // contact, not a credential-guessing signal) — a fresh ip can 401 repeatedly with no token and still
  // succeed once it presents the real one. Kept under perIpPerMin:3 (2 no-token + 1 good-token) so the
  // sliding-window request cap below doesn't confound this assertion.
  const noTokenIp = "203.0.113.11";
  for (let i = 0; i < 2; i++) {
    const r = await appOn.inject({ method: "GET", url: "/api/version", remoteAddress: noTokenIp, headers: { host: REMOTE_BIND_HOST } });
    if (r.statusCode !== 401) { check(`(2) unexpected status on no-token attempt #${i}`, false); }
  }
  const thenGood = await appOn.inject({
    method: "GET", url: "/api/version", remoteAddress: noTokenIp, headers: { host: REMOTE_BIND_HOST, authorization: `Bearer ${GOOD_TOKEN}` },
  });
  check("(2) no-token 401s never lock the ip out — a subsequent VALID token still succeeds (200)", thenGood.statusCode === 200);

  // --- (2) sliding-window request cap: perIpPerMin:3 on a fresh ip. Deliberately NO Authorization header
  //     here — isolates the per-ip window from the per-TOKEN window (GOOD_TOKEN's own window already has
  //     hits from earlier assertions above; a shared-token cap is correct real behavior, just not what
  //     THIS assertion is isolating). A request that clears the rate cap but has no token still 401s
  //     (auth runs AFTER the cap check) — what distinguishes cap-exceeded is the 429 on request #4.
  const capIp = "203.0.113.12";
  const capReq = () => appOn.inject({ method: "GET", url: "/api/version", remoteAddress: capIp, headers: { host: REMOTE_BIND_HOST } });
  const c1 = await capReq(); const c2 = await capReq(); const c3 = await capReq();
  check("(2) requests 1-3 within the perIpPerMin:3 cap all reach auth (401, not 429 — the ip cap itself isn't tripped yet)", c1.statusCode === 401 && c2.statusCode === 401 && c3.statusCode === 401);
  const c4 = await capReq();
  check("(2) the 4th request within the same minute → 429 (sliding-window ip cap, distinct from the auth lockout)", c4.statusCode === 429);

  // --- (2) loopback exemption: the SAME lockout-triggering ip pattern, but via the loopback interface,
  //     is untouched — no rate limiting/lockout logic runs at all for a loopback peer.
  let loopbackFails = 0;
  for (let i = 0; i < 10; i++) {
    const r = await appOn.inject({ method: "GET", url: "/api/version", headers: { host: "127.0.0.1" } }); // default remoteAddress 127.0.0.1
    if (r.statusCode !== 200) loopbackFails++;
  }
  check("(2) 10 rapid loopback requests (no token, would exceed both caps remotely) are ALL 200 — loopback is fully exempt", loopbackFails === 0);
} finally {
  await appOn.close();
  dbOn.close();
}

// ===================== (8) CR follow-up — an IPv6-literal bindHost is reachable through the CSRF hook =====
// WHATWG URL.hostname keeps an IPv6 literal BRACKETED ("[2001:db8::1]"), but a human types/stores bindHost
// bare ("2001:db8::1" — the same shape platform-config's net.isIP validator accepts). Without normalizing
// both sides, EVERY remote request to an IPv6-literal bindHost 403s at the CSRF hook, before it ever
// reaches the trust-tier/token check. "::1" itself is loopback (excluded — it never activates the hook at
// all), so this uses a non-loopback IPv6 literal.
{
  const IPV6_BIND_HOST = "2001:db8::1234";
  const dbV6 = new Db(path.join(TMP, "loom-ipv6.db"));
  dbV6.setPlatformConfig({ remoteAccess: { enabled: true, bindHost: IPV6_BIND_HOST } });
  const appV6 = await buildApp(dbV6, { verifyGatewayToken: () => true });
  try {
    const okBracketedHost = await appV6.inject({
      method: "GET", url: "/api/version", remoteAddress: "203.0.113.20",
      headers: { host: `[${IPV6_BIND_HOST}]`, authorization: "Bearer anything" }, // a browser ALWAYS brackets an IPv6 Host
    });
    check("(8) a bracketed IPv6 Host header ([2001:db8::1234]) matching the bare-stored bindHost is NOT 403'd", okBracketedHost.statusCode === 200);
    const okBracketedOrigin = await appV6.inject({
      method: "GET", url: "/api/version", remoteAddress: "203.0.113.20",
      headers: { host: `[${IPV6_BIND_HOST}]`, origin: `https://[${IPV6_BIND_HOST}]`, authorization: "Bearer anything" },
    });
    check("(8) a bracketed IPv6 Origin matching the bare-stored bindHost is NOT 403'd", okBracketedOrigin.statusCode === 200);
    const mismatchedV6 = await appV6.inject({
      method: "GET", url: "/api/version", remoteAddress: "203.0.113.20",
      headers: { host: "[2001:db8::9999]", authorization: "Bearer anything" },
    });
    check("(8) a DIFFERENT bracketed IPv6 Host still 403s (not a blanket IPv6 bypass)", mismatchedV6.statusCode === 403);
  } finally {
    await appV6.close();
    dbV6.close();
  }
}

// ===================== (9) CR follow-up (card 80e2093f) — 0.0.0.0/:: bind-posture visibility + the =====
// ===================== gateway log-redaction serializer =================================================
{
  check("(9) isAllInterfacesBindHost recognizes IPv4 0.0.0.0", isAllInterfacesBindHost("0.0.0.0") === true);
  check("(9) isAllInterfacesBindHost recognizes IPv6 ::", isAllInterfacesBindHost("::") === true);
  check("(9) isAllInterfacesBindHost rejects loopback 127.0.0.1", isAllInterfacesBindHost("127.0.0.1") === false);
  check("(9) isAllInterfacesBindHost rejects a specific LAN IP", isAllInterfacesBindHost("192.168.1.50") === false);
  check("(9) isAllInterfacesBindHost rejects a tailnet/hostname bind", isAllInterfacesBindHost("myhost.tailnet-abc.ts.net") === false);

  const req = GATEWAY_LOG_SERIALIZERS.req({
    method: "GET",
    url: "/api/version",
    headers: {
      host: "example.com",
      authorization: "Bearer lgw_secret-token-value",
      "sec-websocket-protocol": "loom.v1, loom.bearer.secret-token-value",
      "user-agent": "test-agent/1.0",
    },
  });
  check("(9) GATEWAY_LOG_SERIALIZERS.req redacts the Authorization header", req.headers.authorization === "[redacted]");
  check("(9) GATEWAY_LOG_SERIALIZERS.req redacts the Sec-WebSocket-Protocol header", req.headers["sec-websocket-protocol"] === "[redacted]");
  check("(9) GATEWAY_LOG_SERIALIZERS.req leaves unrelated headers untouched", req.headers["user-agent"] === "test-agent/1.0");
  check("(9) GATEWAY_LOG_SERIALIZERS.req preserves method/url", req.method === "GET" && req.url === "/api/version");

  const reqNoAuth = GATEWAY_LOG_SERIALIZERS.req({ method: "GET", url: "/api/version", headers: { host: "example.com" } });
  check("(9) GATEWAY_LOG_SERIALIZERS.req is a no-op when no sensitive header is present", reqNoAuth.headers.authorization === undefined && reqNoAuth.headers["sec-websocket-protocol"] === undefined);
}

// cleanup (retry for the WAL handle on Windows)
for (let i = 0; i < 5; i++) { try { fs.rmSync(TMP, { recursive: true, force: true }); break; } catch { /* retry */ } }

console.log(failures === 0
  ? "\n✅ ALL PASS — canOpenRemoteListener refuses a non-loopback bind without a token or (off-tailnet) without TLS while a tailnet bypasses the TLS mandate; the remote rate limiter locks out repeated wrong-token 401s and caps a sliding request window while never touching an absent-token first contact or the loopback interface; the CSRF hook accepts a remote Host/Origin matching the configured bindHost while still refusing a mismatched one; the tightened validator enforces bindHost shape + rateLimit bounds; and only the human-only platform override (never the agent-reachable project override) can set remoteAccess."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
