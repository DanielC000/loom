import "./_guard.mjs";
// Card 23496950 — the REMOTE listener is a separate server; the LOOPBACK listener stays plain HTTP on PORT.
// REAL-LISTEN test (ephemeral ports, real `ws` clients, real TLS) — remote-bind.mjs covers the same wall over
// app.inject; this file proves what inject cannot: two real sockets, the WS `upgrade` forwarding between them,
// TLS on the remote one only, and the mirrored slow-loris settings.
//
//   (A) specific bind on 127.0.0.2: a REAL client at 127.0.0.1 is a LOOPBACK PEER reaching the REMOTE port.
//       Card d0f3c8ea (built with 4cbbc343): the class follows the LISTENER, so EVERY request on the remote port is
//       remote-class — gateway token required, Tier-1 only, remote-endpoint Origin — even from a loopback peer.
//       (Before, this peer was wall-exempt: peer-address-only trust let a same-host dial of the internet-facing port
//       borrow loopback trust.) The loopback port is unchanged.
//   (B) bind on a real LAN interface address: a REAL non-loopback peer (this host's own LAN address). If this host
//       has no non-internal IPv4 address the scenario falls back to an injected remoteAddress (app.inject seam) and
//       SAYS SO in the output — it is then NOT a real-socket check.
//   (C) THE CRITICAL: enabled + a valid cert + NO gateway token. Used to build an HTTPS app that then "fell back"
//       to loopback OVER TLS (breaking every agent's MCP/hook). Loopback must be plain HTTP.
import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

const TMP = mkdtempManaged("loom-remote-listener-");
process.env.LOOM_HOME = TMP;
process.env.LOOM_PORT = "0"; // the daemon's own PORT is unused here (every listen below is an explicit ephemeral port)
const sandboxHome = path.join(TMP, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { openRemoteListener, startGatewayListeners, REMOTE_SERVER_TIMEOUTS } = await import("../dist/gateway/remote-listener.js");
const net = await import("node:net");
const tls = await import("node:tls");
const { WebSocket } = await import("ws");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// TEST-ONLY throwaway self-signed P-256 pair (CN=loom-test.invalid, minted once with openssl, never used
// anywhere else). Node has no built-in X.509 minting, so a fixed pair is what makes the real-TLS path hermetic.
const CERT = `-----BEGIN CERTIFICATE-----
MIIBjzCCATWgAwIBAgIUDSaGCT02BimFnIJq/4oxh9/rKVkwCgYIKoZIzj0EAwIw
HDEaMBgGA1UEAwwRbG9vbS10ZXN0LmludmFsaWQwIBcNMjYwOTI0MDIzNTQyWhgP
MjEyNjA4MzEwMjM1NDJaMBwxGjAYBgNVBAMMEWxvb20tdGVzdC5pbnZhbGlkMFkw
EwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE1pyyHjr5/WKK92h5+BcV0j8oTJQPhMaU
/e0VKAlhlUvfVQ8TvY5XtggQSgztTto7rTpQjJEB2dpr4qLkmHSai6NTMFEwHQYD
VR0OBBYEFE3aHYasXcQX5fKHlLnNx06vL6LjMB8GA1UdIwQYMBaAFE3aHYasXcQX
5fKHlLnNx06vL6LjMA8GA1UdEwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDSAAwRQIg
T/jbG+0km49XUEOU9uaPnt3QlyGn/81yT8fx4+dniXwCIQDK4Venq8ng0517QWwS
ytypmJPQftbk6rN0qjH+cl1e/Q==
-----END CERTIFICATE-----
`;
const KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQguZQh4k7zSGn6CmNL
0nKOIlRsjmmiqCeQGw1QWoooB3qhRANCAATWnLIeOvn9Yor3aHn4FxXSPyhMlA+E
xpT97RUoCWGVS99VDxO9jle2CBBKDO1O2jutOlCMkQHZ2mviouSYdJqL
-----END PRIVATE KEY-----
`;
const certPath = path.join(TMP, "test-cert.pem");
const keyPath = path.join(TMP, "test-key.pem");
fs.writeFileSync(certPath, CERT);
fs.writeFileSync(keyPath, KEY);

const TOKEN = "real-listen-gateway-token";
const SECRET = "real-listen-loopback-secret";
const stub = {};
const ptyStub = {
  subscribe: () => () => {}, writeStdin: () => {}, repaint: () => {}, resize: () => {},
  listShells: () => [], spawnShell: () => {}, stop: () => {},
};
let dbSeq = 0;
// Uses the SAME composition index.ts calls (`startGatewayListeners`), so the real boot wiring — loopback first,
// remote second, honest log lines — is what these scenarios exercise. `logs` captures the lines it would print.
async function boot(remoteAccess, { tokenExists = true, timeouts } = {}) {
  const db = new Db(path.join(TMP, `real-${++dbSeq}.db`));
  db.setPlatformConfig({ remoteAccess });
  const ref = { current: null };
  const app = await buildServer({
    db, pty: ptyStub, sessions: { killAllWorkers: () => 0 }, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub,
    userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub, requestShutdown: () => {},
    verifyGatewayToken: (t) => t === TOKEN, loopbackSecret: SECRET, remoteEndpoint: ref,
  });
  const logs = [];
  const started = await startGatewayListeners(app, {
    port: 0, remoteAccess, tokenExists: () => tokenExists, ref, timeouts,
    log: { info: (m) => logs.push(`INFO ${m}`), warn: (m) => logs.push(`WARN ${m}`) },
  });
  return { app, db, ref, loopbackPort: started.loopbackPort, remote: started.remote ?? { opened: false, reasons: [], httpsActive: false }, logs };
}
// Is 127.0.0.2 bindable here? (absent by default on macOS) — scenarios that need it SKIP with a message instead of failing.
const canBind127_2 = await new Promise((resolve) => {
  const s = net.createServer();
  s.once("error", (e) => resolve(e.code === "EADDRNOTAVAIL" ? false : true));
  s.listen(0, "127.0.0.2", () => s.close(() => resolve(true)));
});

function req(scheme, host, port, method, urlPath, headers = {}) {
  return new Promise((resolve) => {
    const mod = scheme === "https" ? https : http;
    const r = mod.request({ host, port, method, path: urlPath, headers: { connection: "close", ...headers }, agent: false, rejectUnauthorized: false, timeout: 5000 }, (res) => {
      let body = ""; res.on("data", (c) => { body += c; }); res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    r.on("error", (e) => resolve({ status: 0, error: e.code ?? e.message }));
    r.on("timeout", () => { r.destroy(new Error("timeout")); });
    r.end();
  });
}
// Resolves "open" | "http-<status>" | "error" — settled by the socket's own events, never a timer. An OPEN socket
// is closed GRACEFULLY (close handshake) and awaited, so no server-side connection lingers into app.close().
function wsProbe(url, protocols, headers = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, protocols, { rejectUnauthorized: false, headers });
    let settled = false, opened = false;
    const done = (v) => { if (!settled) { settled = true; try { ws.terminate(); } catch { /* */ } resolve(v); } };
    ws.on("open", () => { opened = true; ws.close(); });
    ws.on("unexpected-response", (rq, res) => { const st = res.statusCode; res.destroy(); rq.destroy(); done(`http-${st}`); });
    ws.on("error", () => done("error"));
    ws.on("close", () => done(opened ? "open" : "error"));
  });
}
const bearer = (t) => ["loom.v1", `loom.bearer.${t}`];

// ===================== (A) 127.0.0.2 specific bind — a loopback PEER on the remote port ====================
if (!canBind127_2) console.log("SKIP (A)+(T): 127.0.0.2 is not bindable on this host (EADDRNOTAVAIL — e.g. macOS) — the loopback-peer-on-the-remote-port scenarios need it");
else {
  const A = await boot({ enabled: true, bindHost: "127.0.0.2", port: 0, tls: { certPath, keyPath } });
  try {
    check("(A) the remote listener OPENED (tls loaded, token exists, own port)", A.remote.opened === true && A.remote.httpsActive === true);
    const rp = A.remote.endpoint.port;
    check("(A) the remote listener is on its OWN port, distinct from the loopback port", rp !== A.loopbackPort && rp > 0);
    check("(A) the remote endpoint ref carries scheme https + that port", A.ref.current?.scheme === "https" && A.ref.current?.port === rp);

    const lb = await req("http", "127.0.0.1", A.loopbackPort, "GET", "/api/version");
    check("(A) LOOPBACK listener is plain HTTP (a plain http GET works, 200) — TLS is off the app entirely", lb.status === 200);
    const lbTls = await req("https", "127.0.0.1", A.loopbackPort, "GET", "/api/version");
    check("(A) ...and a TLS client to the loopback port FAILS (it is not TLS)", lbTls.status === 0);
    const rm = await req("https", "127.0.0.2", rp, "GET", "/api/version", { authorization: `Bearer ${TOKEN}` });
    check("(A) REMOTE listener speaks TLS (https GET with the gateway token works)", rm.status === 200);
    const rmPlain = await req("http", "127.0.0.2", rp, "GET", "/api/version");
    check("(A) ...and a plain-HTTP client to the remote port does NOT get an app response", rmPlain.status !== 200);

    // WS upgrade on EACH port
    check("(A) real ws upgrade to /ws/fleet on the LOOPBACK port → open", await wsProbe(`ws://127.0.0.1:${A.loopbackPort}/ws/fleet`) === "open");
    check("(A) real wss upgrade to /ws/fleet on the REMOTE port (loopback peer) → open", await wsProbe(`wss://127.0.0.2:${rp}/ws/fleet`, bearer(TOKEN)) === "open");

    // /ws/term on the loopback port: the loopback-secret guard applies
    check("(A) /ws/term on the loopback port WITHOUT the secret → 401", await wsProbe(`ws://127.0.0.1:${A.loopbackPort}/ws/term/s1`) === "http-401");
    check("(A) /ws/term on the loopback port WITH the secret → 101 (open)", await wsProbe(`ws://127.0.0.1:${A.loopbackPort}/ws/term/s1`, bearer(SECRET)) === "open");

    // NO-FORWARDING NEGATIVE CONTROL: without the forwarder the SAME upgrade must fail; restoring it must fix it.
    A.remote.server.removeListener("upgrade", A.remote.forwardUpgrade);
    const noFwd = await wsProbe(`wss://127.0.0.2:${rp}/ws/fleet`, bearer(TOKEN));
    check("(A) NEGATIVE CONTROL: with the upgrade forwarder REMOVED the remote-port ws upgrade FAILS", noFwd !== "open");
    A.remote.server.on("upgrade", A.remote.forwardUpgrade);
    check("(A) ...and with the forwarder restored it opens again (the control could pass)", await wsProbe(`wss://127.0.0.2:${rp}/ws/fleet`, bearer(TOKEN)) === "open");

    // A LOOPBACK PEER on the REMOTE port (card d0f3c8ea): remote-class — the listener, not the peer address, decides.
    const noTok = await req("https", "127.0.0.2", rp, "GET", "/api/version");
    check("(A) loopback peer on the remote port: NO token ⇒ 401 (was 200 wall-exempt before d0f3c8ea)", noTok.status === 401);
    const write = await req("https", "127.0.0.2", rp, "POST", "/api/orchestration/pause", { "content-type": "application/json", authorization: `Bearer ${SECRET}` });
    check("(A) loopback peer on the remote port: a write is Tier-0 ⇒ 403 even carrying the loopback secret (never a loopback-secret route here)", write.status === 403);
    const remoteOrigin = await req("https", "127.0.0.2", rp, "GET", "/api/version", { origin: `https://127.0.0.2:${rp}`, authorization: `Bearer ${TOKEN}` });
    check("(A) loopback peer presenting the REMOTE origin + token → 200 (the remote listener's own full origin)", remoteOrigin.status === 200);
    const loopOrigin = await req("https", "127.0.0.2", rp, "GET", "/api/version", { origin: "http://127.0.0.1:5317", authorization: `Bearer ${TOKEN}` });
    check("(A) loopback peer presenting a loopback Origin on the remote port → 403 (remote-class Origin rule)", loopOrigin.status === 403);

    // Slow-loris limits on the pre-auth remote server: EXPLICIT, non-zero, and no weaker than plain Node (Fastify's own
    // requestTimeout 0 / keepAliveTimeout 72s were what the first cut copied — see REMOTE_SERVER_TIMEOUTS).
    const sv = A.remote.server, ap = A.app.server;
    check("(A) remote server carries exactly REMOTE_SERVER_TIMEOUTS (headers/request/keepAlive/timeout)",
      sv.headersTimeout === REMOTE_SERVER_TIMEOUTS.headersTimeout && sv.requestTimeout === REMOTE_SERVER_TIMEOUTS.requestTimeout
      && sv.keepAliveTimeout === REMOTE_SERVER_TIMEOUTS.keepAliveTimeout && sv.timeout === REMOTE_SERVER_TIMEOUTS.timeout);
    check("(A) ...every limit is NON-ZERO and no weaker than plain Node's defaults (requestTimeout<=300s, headersTimeout<=60s, keepAlive<=5s)",
      sv.requestTimeout > 0 && sv.requestTimeout <= 300000 && sv.headersTimeout > 0 && sv.headersTimeout <= sv.requestTimeout && sv.headersTimeout <= 60000
      && sv.keepAliveTimeout > 0 && sv.keepAliveTimeout <= 5000 && sv.timeout > 0);
    check("(A) ...and the LOOPBACK server keeps Fastify's own settings (untouched)", ap.requestTimeout !== sv.requestTimeout || ap.keepAliveTimeout !== sv.keepAliveTimeout);
    check("(A) the app's clientError handler is still reused on the remote server (>=1 listener, same count)",
      ap.listenerCount("clientError") >= 1 && sv.listenerCount("clientError") === ap.listenerCount("clientError"));

    // Teardown via the REAL app.close() (its preClose hook closes the remote listener first). This used to be
    // `A.remote.close()` because a 401-rejected WS upgrade above stranded its socket and app.close() never settled —
    // card 4a22aab8: fixed by registering @fastify/websocket before the guard hooks; ws-rejected-upgrade-close.mjs pins it.
    await A.app.close();
    check("(A) app.close() settles after the rejected 401 upgrade and stops the remote listener (connection refused after, endpoint ref cleared)", (await req("https", "127.0.0.2", rp, "GET", "/api/version")).status === 0 && A.ref.current === null);
  } finally { A.db.close(); }
}

// ===================== (B) a real LAN-interface bind — a non-loopback PEER ==================================
{
  const lan = Object.values(os.networkInterfaces()).flat().find((x) => x && x.family === "IPv4" && !x.internal)?.address;
  if (lan) {
    console.log(`(B) REAL non-loopback peer: binding the remote listener on this host's LAN address ${lan} (ephemeral port) — token-gated`);
    const B = await boot({ enabled: true, bindHost: lan, port: 0, tls: { certPath, keyPath } });
    try {
      check("(B) the LAN remote listener opened", B.remote.opened === true);
      const rp = B.remote.endpoint.port;
      const noTok = await req("https", lan, rp, "GET", "/api/version");
      check("(B) REAL non-loopback peer, NO token → 401 (bare 401; machine-readable body is card b855c37d)", noTok.status === 401);
      const withTok = await req("https", lan, rp, "GET", "/api/version", { authorization: `Bearer ${TOKEN}` });
      check("(B) REAL non-loopback peer, valid token → 200", withTok.status === 200);
      const tier0 = await req("https", lan, rp, "GET", "/api/orchestration/pause", { authorization: `Bearer ${TOKEN}` });
      check("(B) a Tier-0 route with a valid token → 403 (nothing widened)", tier0.status === 403);
      check("(B) real wss /ws/fleet WITHOUT a token → 401", await wsProbe(`wss://${lan}:${rp}/ws/fleet`) === "http-401");
      check("(B) real wss /ws/fleet WITH a token → open", await wsProbe(`wss://${lan}:${rp}/ws/fleet`, bearer(TOKEN)) === "open");
      const okOrigin = await req("https", lan, rp, "GET", "/api/version", { authorization: `Bearer ${TOKEN}`, origin: `https://${lan}:${rp}` });
      check("(B) non-loopback peer + the FULL remote origin → 200", okOrigin.status === 200);
      const badOrigin = await req("https", lan, rp, "GET", "/api/version", { authorization: `Bearer ${TOKEN}`, origin: "http://127.0.0.1:5317" });
      check("(B) non-loopback peer presenting a LOOPBACK Origin → 403", badOrigin.status === 403);
    } finally { await B.app.close(); B.db.close(); }
  } else {
    console.log("(B) NO non-internal IPv4 address on this host — falling back to an INJECTED remoteAddress (app.inject seam); this is NOT a real-socket non-loopback check");
    const db = new Db(path.join(TMP, "real-b-seam.db"));
    db.setPlatformConfig({ remoteAccess: { enabled: true, bindHost: "box.example.com" } });
    const app = await buildServer({ db, pty: ptyStub, sessions: { killAllWorkers: () => 0 }, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub, requestShutdown: () => {}, verifyGatewayToken: (t) => t === TOKEN, loopbackSecret: SECRET });
    try {
      const noTok = await app.inject({ method: "GET", url: "/api/version", remoteAddress: "203.0.113.9", headers: { host: "box.example.com" } });
      check("(B-seam) injected non-loopback peer, NO token → 401", noTok.statusCode === 401);
    } finally { await app.close(); db.close(); }
  }
}

// ===================== (S) a pre-auth peer holding a socket with an announced-but-unsent body is CUT ==========
// Behavioural proof of the timeout, not just the numbers: shrink the limits through the test seam (keep-alive and socket
// inactivity are pushed out so ONLY requestTimeout can be what cuts it — with them at their real values the 401 path is
// also bounded by keepAliveTimeout), announce a big
// Content-Length, send no body, and wait for the SERVER to close the socket (event-driven; the 20s guard timer is only
// a fail-safe that turns a hang into a FAIL).
if (canBind127_2) {
  const S = await boot({ enabled: true, bindHost: "127.0.0.2", port: 0, tls: { certPath, keyPath } },
    { timeouts: { headersTimeout: 150, requestTimeout: 300, connectionsCheckingInterval: 50, keepAliveTimeout: 60000, timeout: 0 } });
  try {
    const rp = S.remote.endpoint.port;
    const cutBy = await new Promise((resolve) => {
      const sock = tls.connect({ host: "127.0.0.2", port: rp, rejectUnauthorized: false }, () => {
        sock.write("POST /api/orchestration/pause HTTP/1.1\r\nHost: 127.0.0.2\r\nContent-Type: application/json\r\nContent-Length: 100000\r\n\r\n");
      });
      sock.on("error", () => {});
      sock.resume(); // consume the server's 408 so the close is observed (an unread TLS socket never reports it)
      sock.on("close", () => resolve("server-closed"));
      setTimeout(() => { sock.destroy(); resolve("still-open-after-20s"); }, 20000).unref();
    });
    check("(S) the remote server closes a socket that announced a body and never sent it (requestTimeout enforced)", cutBy === "server-closed");
  } finally { await S.app.close(); S.db.close(); }
}

// ===================== (T) app.close() tears the remote listener down too ==================================
if (canBind127_2) {
  const T = await boot({ enabled: true, bindHost: "127.0.0.2", port: 0, tls: { certPath, keyPath } });
  try {
    const rp = T.remote.endpoint.port;
    check("(T) precondition: the remote listener answers before close", (await req("https", "127.0.0.2", rp, "GET", "/api/version", { authorization: `Bearer ${TOKEN}` })).status === 200);
    check("(T) a live remote WS is open when close is requested", await wsProbe(`wss://127.0.0.2:${rp}/ws/fleet`, bearer(TOKEN)) === "open");
    await T.app.close();
    check("(T) app.close() (preClose hook) closes the remote listener: connection refused, endpoint ref cleared", (await req("https", "127.0.0.2", rp, "GET", "/api/version")).status === 0 && T.ref.current === null);
  } finally { T.db.close(); }
}

// ===================== (C) THE CRITICAL + the refusals ========================================================
{
  // enabled + a valid cert + NO gateway token: the remote listener must NOT open, and loopback must stay PLAIN HTTP.
  const C = await boot({ enabled: true, bindHost: "127.0.0.2", tls: { certPath, keyPath } }, { tokenExists: false });
  try {
    check("(C) enabled + valid cert + NO token → the remote listener is REFUSED", C.remote.opened === false && C.ref.current === null);
    check("(C) ...the refusal names the missing token (honest log line)", C.remote.reasons.some((r) => /no gateway token/.test(r)));
    const lb = await req("http", "127.0.0.1", C.loopbackPort, "GET", "/api/version");
    check("(C) the boot composition logged an HONEST line: NOT opening + loopback-only + the port + the reason",
      C.logs.some((l) => /^WARN .*NOT opening a remote listener.*loopback-only: plain HTTP on 127\.0\.0\.1:\d+/.test(l) && /no gateway token/.test(l) && l.includes(String(C.loopbackPort))));
    check("(C) THE CRITICAL: loopback is still PLAIN HTTP (200 over http://) — it was an HTTPS app on main", lb.status === 200);
    check("(C) ...and a TLS client to loopback fails", (await req("https", "127.0.0.1", C.loopbackPort, "GET", "/api/version")).status === 0);
  } finally { await C.app.close(); C.db.close(); }

  // wildcard bind + token + TLS but NO allowedHosts ⇒ refused.
  const W = await boot({ enabled: true, bindHost: "0.0.0.0", tls: { certPath, keyPath } });
  try {
    check("(C) wildcard bind + token + TLS + NO allowedHosts → the remote listener does NOT open", W.remote.opened === false && W.ref.current === null);
    check("(C) ...the refusal names allowedHosts", W.remote.reasons.some((r) => /allowedHosts/.test(r)));
  } finally { await W.app.close(); W.db.close(); }

  // port collision ⇒ refused (own port required).
  const db2 = new Db(path.join(TMP, "real-port.db"));
  db2.setPlatformConfig({ remoteAccess: { enabled: true, bindHost: "127.0.0.2", tls: { certPath, keyPath } } });
  const ref2 = { current: null };
  const app2 = await buildServer({ db: db2, pty: ptyStub, sessions: { killAllWorkers: () => 0 }, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub, requestShutdown: () => {}, verifyGatewayToken: () => true, remoteEndpoint: ref2 });
  await app2.listen({ port: 0, host: "127.0.0.1" });
  const lp2 = app2.server.address().port;
  try {
    const clash = await openRemoteListener(app2, { enabled: true, bindHost: "127.0.0.2", port: lp2, tls: { certPath, keyPath } }, { loopbackPort: lp2, tokenExists: true, ref: ref2 });
    check("(C) remoteAccess.port equal to the loopback port → refused, honestly", clash.opened === false && clash.reasons.some((r) => /own port/.test(r)) && ref2.current === null);
    check("(C) default remote port (unset) is loopback port + 1", (await import("../dist/gateway/remote-listener.js")).resolveRemotePort({ enabled: true, bindHost: "x" }, 1000) === 1001);
  } finally { await app2.close(); db2.close(); }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the loopback listener is plain HTTP on its own port in every config; the remote listener is a separate TLS server whose ws upgrades are forwarded (and fail without the forwarder), whose loopback peers are treated as loopback and non-loopback peers stay behind the token wall, and which is refused (never plain-HTTP-opened) when the token/TLS/allowedHosts/port preconditions fail."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
