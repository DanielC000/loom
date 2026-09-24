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
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { hermeticPort } from "./_hermetic-port.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TMP = mkdtempManaged("loom-remote-bind-");
process.env.LOOM_HOME = TMP;
process.env.LOOM_PORT = String(hermeticPort());
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
const { openRemoteListener } = await import("../dist/gateway/remote-listener.js");
const { remoteHostAllowlist, remoteListenerRefusalReasons, isForbiddenAllowedHost, canonicalHost } = await import("../dist/gateway/trust-tier.js");

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
// remote listener silently on plain HTTP while a caller's boot decision believes TLS is live. Since card
// 23496950 TLS belongs to the REMOTE listener (gateway/remote-listener.ts `openRemoteListener`), not to the
// Fastify app: its `httpsActive` result is the ONE real signal. Prove every failure shape refuses to open
// (never a throw, never plain HTTP on a non-tailnet host) AND that the app itself — the loopback listener
// every in-host consumer dials — is untouched and still serves.
{
  const NON_TAILNET_REMOTE_HOST = "loom-tls-fail-test.example.com";
  const refusal = async (label, remoteAccessCfg) => {
    const db = new Db(path.join(TMP, `loom-tls-${label}.db`));
    db.setPlatformConfig({ remoteAccess: remoteAccessCfg });
    const app = await buildApp(db);
    const ref = { current: null };
    let threw = false, result;
    try { result = await openRemoteListener(app, remoteAccessCfg, { loopbackPort: 4317, tokenExists: true, ref }); } catch { threw = true; }
    check(`(6${label}) openRemoteListener does NOT throw`, threw === false);
    check(`(6${label}) httpsActive is false (TLS material did not load)`, result?.httpsActive === false);
    check(`(6${label}) the listener is REFUSED (never opened as plain HTTP on a non-tailnet host)`, result?.opened === false && ref.current === null);
    check(`(6${label}) the refusal names the TLS reason (honest log line)`, (result?.reasons ?? []).some((r) => /TLS/.test(r)));
    const r = await app.inject({ method: "GET", url: "/api/version" }); // default loopback Host/remoteAddress
    check(`(6${label}) the app (loopback listener) still serves normally`, r.statusCode === 200);
    await app.close();
    db.close();
  };
  // (6a) certPath is a DIRECTORY (readFileSync throws EISDIR) — a portable stand-in for "unreadable".
  const dirAsCert = path.join(TMP, "cert-is-a-dir");
  fs.mkdirSync(dirAsCert, { recursive: true });
  const keyFile = path.join(TMP, "some-key.pem");
  fs.writeFileSync(keyFile, "irrelevant — cert read throws first");
  await refusal("a", { enabled: true, bindHost: NON_TAILNET_REMOTE_HOST, tls: { certPath: dirAsCert, keyPath: keyFile } });
  // (6b) files EXIST and are readable but the CONTENT is not valid PEM — the failure only surfaces once
  // Node's TLS layer parses the bytes (https.createServer), AFTER the readFileSync try/catch succeeded.
  const garbageCert = path.join(TMP, "garbage-cert.pem");
  const garbageKey = path.join(TMP, "garbage-key.pem");
  fs.writeFileSync(garbageCert, "this is not a certificate\n");
  fs.writeFileSync(garbageKey, "this is not a key\n");
  await refusal("b", { enabled: true, bindHost: NON_TAILNET_REMOTE_HOST, tls: { certPath: garbageCert, keyPath: garbageKey } });
  // NOTE: the happy path (valid TLS material actually applied) is not minted here — no hermetic X.509 helper;
  // section (1)'s pure-function coverage proves the GATING independent of real PEM bytes, and
  // remote-listener-real.mjs covers the real-listen plain-HTTP (tailnet-shaped) path.
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
  check("(5) ...including the card-23496950 keys (allowedHosts / port) — no agent-reachable schema can set them",
    validateProjectConfigOverride({ remoteAccess: { allowedHosts: ["example.com"] } }).ok === false
    && validateProjectConfigOverride({ remoteAccess: { port: 4444 } }).ok === false
    && validateProjectConfigOverride({ allowedHosts: ["example.com"] }).ok === false
    && validateProjectConfigOverride({ port: 4444 }).ok === false);
  check("(5) the human-only platform override accepts allowedHosts + port", validatePlatformConfigOverride({ remoteAccess: { enabled: true, bindHost: "0.0.0.0", allowedHosts: ["192.168.1.50", "loom.lan"], port: 4999 } }).ok === true);
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
const REMOTE_PORT = 4444; // card 23496950: a remote peer's Origin must be the FULL remote origin (scheme + host + port)
const appOn = await buildApp(dbOn, { verifyGatewayToken: (token) => token === GOOD_TOKEN, remoteEndpoint: { current: { scheme: "https", port: REMOTE_PORT } } });
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
    headers: { host: REMOTE_BIND_HOST, origin: `https://${REMOTE_BIND_HOST}:${REMOTE_PORT}`, authorization: `Bearer ${GOOD_TOKEN}` },
  });
  check("(3) a remote request whose Origin is the FULL remote origin (scheme+bindHost+port) passes the CSRF Origin check", remoteOriginOk.statusCode === 200);
  for (const [label, origin] of [["port-less", `https://${REMOTE_BIND_HOST}`], ["wrong port", `https://${REMOTE_BIND_HOST}:8080`], ["wrong scheme", `http://${REMOTE_BIND_HOST}:${REMOTE_PORT}`]]) {
    const r = await appOn.inject({ method: "GET", url: "/api/version", remoteAddress: REMOTE_IP, headers: { host: REMOTE_BIND_HOST, origin, authorization: `Bearer ${GOOD_TOKEN}` } });
    check(`(3) a remote Origin with the right host but a ${label} (${origin}) 403s — Origin is full-origin, not host-only`, r.statusCode === 403);
  }
  const remoteOriginMismatch = await appOn.inject({
    method: "GET", url: "/api/version", remoteAddress: REMOTE_IP,
    headers: { host: REMOTE_BIND_HOST, origin: `https://evil.example.com:${REMOTE_PORT}`, authorization: `Bearer ${GOOD_TOKEN}` },
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
  const appV6 = await buildApp(dbV6, { verifyGatewayToken: () => true, remoteEndpoint: { current: { scheme: "https", port: 4444 } } });
  try {
    const okBracketedHost = await appV6.inject({
      method: "GET", url: "/api/version", remoteAddress: "203.0.113.20",
      headers: { host: `[${IPV6_BIND_HOST}]`, authorization: "Bearer anything" }, // a browser ALWAYS brackets an IPv6 Host
    });
    check("(8) a bracketed IPv6 Host header ([2001:db8::1234]) matching the bare-stored bindHost is NOT 403'd", okBracketedHost.statusCode === 200);
    const okBracketedOrigin = await appV6.inject({
      method: "GET", url: "/api/version", remoteAddress: "203.0.113.20",
      headers: { host: `[${IPV6_BIND_HOST}]`, origin: `https://[${IPV6_BIND_HOST}]:4444`, authorization: "Bearer anything" },
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

// ===================== (10) card 23496950 — wildcard bind: allowedHosts, Host allowlist, peer-scoped Origin ===
{
  // --- validator ---
  const V = (remoteAccess) => validatePlatformConfigOverride({ remoteAccess }).ok;
  check("(10) allowedHosts rejects 0.0.0.0", V({ allowedHosts: ["0.0.0.0"] }) === false);
  check("(10) allowedHosts rejects ::", V({ allowedHosts: ["::"] }) === false);
  check("(10) allowedHosts rejects 127.0.0.1 / localhost / ::1 / 127.5.5.5 / ::ffff:127.0.0.1 / 0:0:0:0:0:0:0:1",
    ["127.0.0.1", "localhost", "::1", "127.5.5.5", "::ffff:127.0.0.1", "0:0:0:0:0:0:0:1"].every((h) => V({ allowedHosts: [h] }) === false));
  check("(10) allowedHosts rejects a URL-shaped / spaced / bracketed entry", ["http://a.com", "a b", "[2001:db8::1]"].every((h) => V({ allowedHosts: [h] }) === false));
  check("(10) allowedHosts accepts a LAN IP, a bare IPv6, and a hostname", V({ allowedHosts: ["192.168.1.50", "2001:db8::1", "loom.lan"] }) === true);
  check("(10) allowedHosts caps at 32 entries", V({ allowedHosts: Array.from({ length: 33 }, (_, i) => `h${i}.example.com`) }) === false);
  check("(10) port must be an int in 1..65535", V({ port: 0 }) === false && V({ port: 70000 }) === false && V({ port: 1.5 }) === false && V({ port: 4999 }) === true);
  check("(10) port equal to the daemon's own PORT is rejected", V({ port: Number(PORT) }) === false);
  check("(10) isForbiddenAllowedHost is the shared predicate (wildcard + loopback true, a LAN name false)",
    isForbiddenAllowedHost("0.0.0.0") && isForbiddenAllowedHost("LOCALHOST") && !isForbiddenAllowedHost("loom.lan"));

  // --- canonicalisation (card 23496950 re-review): entries are matched in the form the URL parser gives a request's
  // Host/Origin, so a non-canonical spelling still matches, and an AMBIGUOUS numeric-looking name is refused.
  check("(10) canonicalHost compresses a fully-written IPv6 literal", canonicalHost("2001:db8:0:0:0:0:0:1") === "2001:db8::1");
  check("(10) canonicalHost strips brackets and lower-cases", canonicalHost("[2001:DB8::1]") === "2001:db8::1" && canonicalHost("LOOM.Lan") === "loom.lan");
  check("(10) canonicalHost REFUSES a name the URL parser would silently turn into an IPv4 (hex / decimal / zero-padded-octal)",
    ["0x7f.0.0.1", "2130706433", "192.168.001.050", "0300.0.0.1"].every((h) => canonicalHost(h) === null));
  check("(10) a plain dotted-decimal IPv4 canonicalises to itself", canonicalHost("192.168.1.50") === "192.168.1.50");
  check("(10) allowedHosts accepts a NON-canonical IPv6 spelling (it will match — see the inject check below)", V({ allowedHosts: ["2001:db8:0:0:0:0:0:1"] }) === true);
  check("(10) allowedHosts REJECTS ambiguous numeric names (0x7f.0.0.1 / 2130706433 / 192.168.001.050 — the last is octal 192.168.1.40)",
    ["0x7f.0.0.1", "2130706433", "192.168.001.050"].every((h) => V({ allowedHosts: [h] }) === false));
  check("(10) bindHost REJECTS the same ambiguous names", ["0x7f.0.0.1", "192.168.001.050"].every((h) => V({ bindHost: h }) === false));
  check("(10) loopback-EQUIVALENT forms are forbidden AFTER canonicalisation (::0:1, ::ffff:7f00:1, ::7f00:1, ::ffff:0:0, 0:0:0:0:0:0:0:1, 0.1.2.3)",
    ["::0:1", "::ffff:7f00:1", "::7f00:1", "::ffff:0:0", "0:0:0:0:0:0:0:1", "0.1.2.3"].every((h) => isForbiddenAllowedHost(h) === true && V({ allowedHosts: [h] }) === false));
  check("(10) ...while a real LAN IPv6 / IPv4-mapped LAN address is NOT forbidden", ["2001:db8::1", "::ffff:c0a8:132", "fe80::1"].every((h) => isForbiddenAllowedHost(h) === false));
  check("(10) remoteHostAllowlist canonicalises bindHost AND allowedHosts",
    JSON.stringify(remoteHostAllowlist({ enabled: true, bindHost: "2001:db8:0:0:0:0:0:1234", allowedHosts: ["2001:DB8:0:0:0:0:0:1"] }).sort()) === JSON.stringify(["2001:db8::1", "2001:db8::1234"]));
  check("(10) remoteHostAllowlist DROPS an ambiguous entry (fail-closed) rather than matching something else",
    remoteHostAllowlist({ enabled: true, bindHost: "0.0.0.0", allowedHosts: ["192.168.001.050"] }).length === 0);
  {
    const dbC = new Db(path.join(TMP, "loom-canon.db"));
    dbC.setPlatformConfig({ remoteAccess: { enabled: true, bindHost: "2001:db8:0:0:0:0:0:1234", allowedHosts: ["2001:db8:0:0:0:0:0:1"] } });
    const appC = await buildApp(dbC, { verifyGatewayToken: () => true, remoteEndpoint: { current: { scheme: "https", port: 4444 } } });
    try {
      const C = (host, origin) => appC.inject({ method: "GET", url: "/api/version", remoteAddress: "203.0.113.31", headers: { host, authorization: "Bearer x", ...(origin ? { origin } : {}) } }).then((r) => r.statusCode);
      check("(10) a client's compressed Host [2001:db8::1] matches the NON-canonical allowedHosts entry → 200", (await C("[2001:db8::1]:4444")) === 200);
      check("(10) ...and the non-canonical bindHost's compressed Host [2001:db8::1234] → 200", (await C("[2001:db8::1234]:4444")) === 200);
      check("(10) ...and the full remote Origin on the compressed form → 200", (await C("[2001:db8::1]:4444", "https://[2001:db8::1]:4444")) === 200);
      check("(10) ...a different IPv6 Host still 403s", (await C("[2001:db8::2]:4444")) === 403);
    } finally { await appC.close(); dbC.close(); }
  }

  // --- fail-closed boot rule: a wildcard bind needs allowedHosts ---
  const wild = { enabled: true, bindHost: "0.0.0.0", tls: { certPath: "/a/c.pem", keyPath: "/a/k.pem" } };
  check("(10) wildcard bind + token + TLS but NO allowedHosts → refused (fail-closed)", canOpenRemoteListener(wild, true, true) === false);
  check("(10) ...the refusal reason names allowedHosts", remoteListenerRefusalReasons(wild, true, true).some((r) => /allowedHosts/.test(r)));
  check("(10) wildcard bind + token + TLS + allowedHosts → allowed", canOpenRemoteListener({ ...wild, allowedHosts: ["192.168.1.50"] }, true, true) === true);
  check("(10) '::' wildcard needs allowedHosts too", canOpenRemoteListener({ ...wild, bindHost: "::" }, true, true) === false);
  check("(10) allowedHosts is ADDITIVE for a specific bind (bindHost + extras, normalised)",
    JSON.stringify(remoteHostAllowlist({ enabled: true, bindHost: "Box.TS.net", allowedHosts: ["100.64.0.5"] }).sort()) === JSON.stringify(["100.64.0.5", "box.ts.net"]));
  check("(10) a wildcard bindHost contributes NOTHING to the allowlist", remoteHostAllowlist({ enabled: true, bindHost: "0.0.0.0", allowedHosts: [] }).length === 0);

  // --- Host allowlist over a real buildServer (wildcard bind) ---
  const dbW = new Db(path.join(TMP, "loom-wild.db"));
  dbW.setPlatformConfig({ remoteAccess: { enabled: true, bindHost: "0.0.0.0", allowedHosts: ["192.168.1.50", "Loom.LAN"] } });
  const appW = await buildApp(dbW, { verifyGatewayToken: (t) => t === "wtok", remoteEndpoint: { current: { scheme: "https", port: 4444 } } });
  const RIP = "203.0.113.30";
  const W = (headers, remoteAddress = RIP) => appW.inject({ method: "GET", url: "/api/version", remoteAddress, headers: { authorization: "Bearer wtok", ...headers } });
  try {
    check("(10) REPRO B3 fixed: wildcard bind, remote Host = an allowedHosts IP → 200 (was 403)", (await W({ host: "192.168.1.50:4444" })).statusCode === 200);
    check("(10) ...an allowedHosts hostname, case-insensitively → 200", (await W({ host: "LOOM.lan:4444" })).statusCode === 200);
    check("(10) ...a Host NOT on the list → 403 (DNS-rebind defence intact)", (await W({ host: "192.168.1.51:4444" })).statusCode === 403);
    check("(10) ...the literal 'Host: 0.0.0.0' no longer passes on a wildcard bind (was the only Host that did)", (await W({ host: "0.0.0.0:4444" })).statusCode === 403);
    check("(10) ...an attacker suffix of an allowed name (loom.lan.evil.com) → 403 (exact match, no suffix)", (await W({ host: "loom.lan.evil.com" })).statusCode === 403);
    check("(10) ...remote peer + full remote Origin on an allowed host → 200", (await W({ host: "192.168.1.50:4444", origin: "https://192.168.1.50:4444" })).statusCode === 200);
    check("(10) ...remote peer + Origin on the allowed host but another port → 403", (await W({ host: "192.168.1.50:4444", origin: "https://192.168.1.50:8080" })).statusCode === 403);
    // Origin PEER-scoping: a LOOPBACK peer must never be handed a remote Origin, or another local web
    // service at http://<allowedHost>:8080 in a browser on the daemon host could read loopback-exempt GETs.
    check("(10) MAJOR: a LOOPBACK peer with Origin http://<allowedHost>:8080 → 403 (Origin is peer-scoped)",
      (await W({ host: "192.168.1.50:4444", origin: "http://192.168.1.50:8080" }, "127.0.0.1")).statusCode === 403);
    check("(10) ...even the EXACT remote origin is refused from a loopback peer (remote origins are for remote peers only)",
      (await W({ host: "192.168.1.50:4444", origin: "https://192.168.1.50:4444" }, "127.0.0.1")).statusCode === 403);
    check("(10) ...a loopback peer with a loopback Origin still works (the dev/CLI path is unchanged)",
      (await W({ host: "127.0.0.1", origin: "http://127.0.0.1:5317" }, "127.0.0.1")).statusCode === 200);
  } finally {
    await appW.close();
    dbW.close();
  }
  // No remote endpoint yet (listener not open) => no remote Origin can match, even from a "remote" peer.
  const dbN = new Db(path.join(TMP, "loom-noep.db"));
  dbN.setPlatformConfig({ remoteAccess: { enabled: true, bindHost: "0.0.0.0", allowedHosts: ["192.168.1.50"] } });
  const appN = await buildApp(dbN, { verifyGatewayToken: () => true });
  try {
    const r = await appN.inject({ method: "GET", url: "/api/version", remoteAddress: RIP, headers: { host: "192.168.1.50:4444", origin: "https://192.168.1.50:4444", authorization: "Bearer x" } });
    check("(10) no remoteEndpoint (remote listener not open) => a remote Origin never matches (fail-closed)", r.statusCode === 403);
  } finally { await appN.close(); dbN.close(); }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — canOpenRemoteListener refuses a non-loopback bind without a token or (off-tailnet) without TLS while a tailnet bypasses the TLS mandate; the remote rate limiter locks out repeated wrong-token 401s and caps a sliding request window while never touching an absent-token first contact or the loopback interface; the CSRF hook accepts a remote Host/Origin matching the configured bindHost while still refusing a mismatched one; the tightened validator enforces bindHost shape + rateLimit bounds; and only the human-only platform override (never the agent-reachable project override) can set remoteAccess."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
