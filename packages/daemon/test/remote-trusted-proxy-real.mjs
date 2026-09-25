import "./_guard.mjs";
// Card 4cbbc343 (+ d0f3c8ea) — trusted-reverse-proxy mode over REAL sockets (ephemeral ports, real `ws`, and a real
// in-test reverse proxy standing in for `tailscale serve`). remote-trusted-proxy.mjs covers the predicate and the
// matchers; this file proves what inject cannot: that the class follows the LISTENER a real connection arrived on.
//
//   (P) the proxy listener: every request on it is remote-class whatever its Host — token-gated, Tier-1 only,
//       /internal/* and the loopback secret unreachable, Host==entry and same-entry Origin enforced, Funnel refused.
//   (R) a REAL reverse proxy in front of it (Host preserved, Host REWRITTEN to 127.0.0.1, both must stay remote/closed).
//   (M) Serve pointed at the daemon's OWN port instead: fails CLOSED (a trusted Host is refused; proxy headers downgrade).
//   (W) real WebSocket upgrades through the proxy listener: token-gated, /ws/term view-only, host shells refused.
//   (L) throttle-only, verify-first: a failed-token flood is throttled (429) but never locks a valid token out.
//   (S) the SPA shell (owner flag F1): public to the proxy class ONLY, keyed on the matched `/*` route, never an API path.
//   (B) boot: no token ⇒ the proxy listener does not open; no proxyPort ⇒ nothing extra listens.
// Every assertion on a refusal reads the response BODY, because an earlier guard (the Host check) also 403s: a bare
// status check could be satisfied by the wrong reason.
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { waitUntil } from "./_wait.mjs";

const TMP = mkdtempManaged("loom-trusted-proxy-real-");
process.env.LOOM_HOME = TMP;
process.env.LOOM_PORT = "0";
const sandboxHome = path.join(TMP, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
// A fixture web dist (LOOM_WEB_DIST) so the SPA-shell scenarios do not depend on a built packages/web, plus a
// SECRET sibling OUTSIDE it that no static route may ever serve (the traversal control).
const WEB = path.join(TMP, "web-dist");
fs.mkdirSync(path.join(WEB, "assets"), { recursive: true });
fs.writeFileSync(path.join(WEB, "index.html"), "<!doctype html><title>loom-shell-marker</title>");
fs.writeFileSync(path.join(WEB, "assets", "app.js"), "console.log('shell-asset-marker');");
fs.writeFileSync(path.join(TMP, "secret.txt"), "OUTSIDE-THE-WEB-DIST-SECRET");
fs.writeFileSync(path.join(WEB, ".hidden-secret"), "DOTFILE-IN-THE-WEB-DIST-SECRET");
fs.mkdirSync(path.join(WEB, ".well-known"), { recursive: true });
fs.writeFileSync(path.join(WEB, ".well-known", "x.txt"), "DOTDIR-IN-THE-WEB-DIST-SECRET");
process.env.LOOM_WEB_DIST = WEB;
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { startGatewayListeners } = await import("../dist/gateway/remote-listener.js");
const { PROXY_FAILED_AUTH_PER_MIN } = await import("../dist/gateway/remote-rate-limit.js");
const { WebSocket } = await import("ws");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const TOKEN = "trusted-proxy-gateway-token";
const SECRET = "trusted-proxy-loopback-secret";
const ENTRY_HOST = "box.tail1.ts.net:8443";
const ENTRY = "https://box.tail1.ts.net:8443";
const stub = {};
const frames = [];
const ptyStub = {
  subscribe: () => () => {}, writeStdin: (id, d) => { frames.push(["stdin", id, d]); }, repaint: (id) => { frames.push(["repaint", id]); }, resize: () => {},
  listShells: () => [{ id: "shell1", cwd: "/", command: "sh", label: "x", alive: true }], spawnShell: () => {}, stop: () => {},
};
let dbSeq = 0;
async function boot(remoteAccess, { tokenExists = true } = {}) {
  const db = new Db(path.join(TMP, `p-${++dbSeq}.db`));
  db.setPlatformConfig({ remoteAccess });
  const ref = { current: null };
  const app = await buildServer({
    db, pty: ptyStub, sessions: { killAllWorkers: () => 0 }, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub,
    userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub, requestShutdown: () => { frames.push(["shutdown"]); },
    verifyGatewayToken: (t) => t === TOKEN, loopbackSecret: SECRET, remoteEndpoint: ref,
  });
  const logs = [];
  const started = await startGatewayListeners(app, {
    port: 0, remoteAccess, tokenExists: () => tokenExists, ref,
    log: { info: (m) => logs.push(`INFO ${m}`), warn: (m) => logs.push(`WARN ${m}`) },
  });
  return { app, db, ref, loopbackPort: started.loopbackPort, proxy: started.proxy, logs };
}

function req(port, method, urlPath, headers = {}, payload) {
  return new Promise((resolve) => {
    const r = http.request({ host: "127.0.0.1", port, method, path: urlPath, headers: { connection: "close", ...headers }, agent: false, timeout: 5000 }, (res) => {
      let body = ""; res.on("data", (c) => { body += c; }); res.on("end", () => { let json = null; try { json = JSON.parse(body); } catch { /* text */ } resolve({ status: res.statusCode, body, json }); });
    });
    r.on("error", (e) => resolve({ status: 0, error: e.code ?? e.message }));
    r.on("timeout", () => r.destroy(new Error("timeout")));
    r.end(payload);
  });
}
const proxyHdrs = (extra = {}) => ({ host: ENTRY_HOST, origin: ENTRY, ...extra });
const bearer = (t) => ({ authorization: `Bearer ${t}` });
const subprotocol = (t) => ["loom.v1", `loom.bearer.${t}`];

// Resolves { result, first } — result "open" | "http-<n>" | "error" | "closed-<code>"; `first` = the first text frame, if any.
function wsProbe(port, urlPath, protocols, headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${urlPath}`, protocols, { headers });
    let settled = false, opened = false, first = null;
    const done = (v) => { if (!settled) { settled = true; try { ws.terminate(); } catch { /* */ } resolve({ result: v, first }); } };
    ws.on("open", () => { opened = true; });
    ws.on("message", (d, isBinary) => { if (first === null && !isBinary) { first = String(d); ws.close(); } });
    ws.on("unexpected-response", (rq, res) => { const st = res.statusCode; res.destroy(); rq.destroy(); done(`http-${st}`); });
    ws.on("error", () => done("error"));
    ws.on("close", (code) => done(opened ? (code === 1008 ? "closed-1008" : "open") : "error"));
    // A pane that never sends a frame (loopback-style) still settles: close it from our side shortly after open.
    ws.on("open", () => { setTimeout(() => { try { ws.close(); } catch { /* */ } }, 300); });
  });
}

// A real reverse proxy, the shape `tailscale serve` has: plain HTTP in, forwards to `targetPort`. `mutate(headers)` lets a
// case rewrite Host / add X-Forwarded-*. Upgrades are piped raw so a real ws client can go through it.
function reverseProxy(targetPort, mutate) {
  const srv = http.createServer((cReq, cRes) => {
    const headers = mutate({ ...cReq.headers });
    const up = http.request({ host: "127.0.0.1", port: targetPort, method: cReq.method, path: cReq.url, headers, agent: false }, (uRes) => { cRes.writeHead(uRes.statusCode ?? 502, uRes.headers); uRes.pipe(cRes); });
    up.on("error", () => { cRes.writeHead(502); cRes.end(); });
    cReq.pipe(up);
  });
  srv.on("upgrade", (cReq, cSock, head) => {
    const headers = mutate({ ...cReq.headers });
    const up = net.connect(targetPort, "127.0.0.1", () => {
      up.write(`${cReq.method} ${cReq.url} HTTP/1.1\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`);
      if (head?.length) up.write(head);
      up.pipe(cSock); cSock.pipe(up);
    });
    up.on("error", () => cSock.destroy());
    cSock.on("error", () => up.destroy());
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ port: srv.address().port, close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }) })));
}

const CFG = { enabled: true, bindHost: "127.0.0.1", proxyPort: 0, trustedProxyOrigins: [ENTRY] };

// ===================== (P) the proxy listener ==============================================================
const P = await boot(CFG);
try {
  check("(P) the proxy listener OPENED on its own ephemeral port, distinct from the loopback port", P.proxy?.opened === true && P.proxy.port > 0 && P.proxy.port !== P.loopbackPort);
  check("(P) it logged the trusted-proxy line naming the origin", P.logs.some((l) => l.startsWith("INFO") && l.includes("trusted-proxy listener") && l.includes(ENTRY)));
  const pp = P.proxy.port;

  const noTok = await req(pp, "GET", "/api/version", proxyHdrs());
  check("(P) no token ⇒ 401 with the gateway-token-required body", noTok.status === 401 && noTok.json?.error === "unauthorized" && noTok.json?.code === "gateway-token-required" && typeof noTok.json?.hint === "string");
  const ok = await req(pp, "GET", "/api/version", proxyHdrs(bearer(TOKEN)));
  check("(P) the gateway token ⇒ 200 on a Tier-1 read", ok.status === 200);
  const wrongTok = await req(pp, "GET", "/api/version", proxyHdrs(bearer("nope")));
  check("(P) a wrong token ⇒ 401 gateway-token-required", wrongTok.status === 401 && wrongTok.json?.code === "gateway-token-required");
  const secretOnly = await req(pp, "GET", "/api/version", proxyHdrs(bearer(SECRET)));
  check("(P) the LOOPBACK secret is not a credential here (401, not 200)", secretOnly.status === 401);

  // The class path (tier wall) — NOT the Host check: the Host is a valid entry and the token is valid.
  const tier0 = await req(pp, "GET", "/api/platform/config", proxyHdrs(bearer(TOKEN)));
  check("(P) a Tier-0 route with a VALID token + valid Host ⇒ 403 {error:'forbidden'} from the tier wall (not the Host check)", tier0.status === 403 && tier0.json?.error === "forbidden");
  const write = await req(pp, "POST", "/api/orchestration/pause", proxyHdrs({ ...bearer(TOKEN), "content-type": "application/json" }), "{}");
  check("(P) a write ⇒ 403 {error:'forbidden'} even with a valid gateway token", write.status === 403 && write.json?.error === "forbidden");
  const writeSecret = await req(pp, "POST", "/api/orchestration/pause", proxyHdrs({ ...bearer(SECRET), "content-type": "application/json" }), "{}");
  check("(P) a write carrying the LOOPBACK secret ⇒ still 403 {error:'forbidden'} (the loopback-secret path is unreachable to this class)", writeSecret.status === 403 && writeSecret.json?.error === "forbidden");
  for (const [m, u] of [["POST", "/internal/hook"], ["POST", "/internal/shutdown"], ["POST", "/internal/update"]]) {
    const r = await req(pp, m, u, proxyHdrs({ ...bearer(TOKEN), "content-type": "application/json" }), "{}");
    check(`(P) ${m} ${u} ⇒ 403 {error:'forbidden'} from the tier wall`, r.status === 403 && r.json?.error === "forbidden");
  }
  const rs = await req(pp, "POST", "/internal/shutdown", proxyHdrs({ ...bearer(SECRET), "content-type": "application/json" }), "{}");
  check("(P) /internal/shutdown with the loopback secret does NOT shut the daemon down", rs.status === 403 && !frames.some((f) => f[0] === "shutdown"));

  // Host / Origin rules.
  const rewritten = await req(pp, "GET", "/api/version", { host: `127.0.0.1:${pp}`, ...bearer(TOKEN) });
  check("(P) Host rewritten to 127.0.0.1:<proxy port> (a proxy's default) ⇒ 403 host-header-not-allowed: fails CLOSED, and NOT served as loopback", rewritten.status === 403 && rewritten.json?.error === "host header not allowed");
  const claimsMain = await req(pp, "GET", "/api/version", { host: `127.0.0.1:${P.loopbackPort}`, ...bearer(TOKEN) });
  check("(P) a client-chosen `Host: 127.0.0.1:<daemon port>` ⇒ 403 host-header-not-allowed (never loopback trust)", claimsMain.status === 403 && claimsMain.json?.error === "host header not allowed");
  const claimsMainTier0 = await req(pp, "GET", "/api/platform/config", { host: `127.0.0.1:${P.loopbackPort}` });
  check("(P) ...a Tier-0 GET with that Host and NO token is refused (403), not served (would be 200 as a loopback GET)", claimsMainTier0.status === 403);
  for (const [label, h] of [["trailing-dot Host", "box.tail1.ts.net.:8443"], ["userinfo Host", `evil@${ENTRY_HOST}`], ["wrong-port Host", "box.tail1.ts.net:9443"], ["port-less Host (entry has :8443)", "box.tail1.ts.net"]]) {
    const r = await req(pp, "GET", "/api/version", { host: h, ...bearer(TOKEN) });
    check(`(P) ${label} ⇒ 403 host-header-not-allowed`, r.status === 403 && r.json?.error === "host header not allowed");
  }
  for (const [label, o] of [["another origin", "https://evil.example.com"], ["the same host on the default port", "https://box.tail1.ts.net"], ["a loopback origin", "http://127.0.0.1:5317"], ["Origin: null", "null"], ["an EMPTY Origin", ""]]) {
    const r = await req(pp, "GET", "/api/version", { host: ENTRY_HOST, origin: o, ...bearer(TOKEN) });
    check(`(P) ${label} ⇒ 403 cross-origin-request-refused`, r.status === 403 && r.json?.error === "cross-origin request refused");
  }
  const noOrigin = await req(pp, "GET", "/api/version", { host: ENTRY_HOST, ...bearer(TOKEN) });
  check("(P) an ABSENT Origin + token is allowed (a non-browser client)", noOrigin.status === 200);
  const funnel = await req(pp, "GET", "/api/version", proxyHdrs({ ...bearer(TOKEN), "tailscale-funnel-request": "?1" }));
  check("(P) a Funnel-fronted request (Tailscale-Funnel-Request) ⇒ 403 funnel-refused, even with a valid token", funnel.status === 403 && funnel.json?.error === "funnel requests refused");
  const hook = await req(pp, "POST", "/hooks/anything", proxyHdrs({ "content-type": "application/json" }), "{}");
  check("(P) the public webhook ingress is NOT reachable through the proxy listener (403 forbidden)", hook.status === 403 && hook.json?.error === "forbidden");

  // The loopback listener itself is unchanged.
  const lb = await req(P.loopbackPort, "GET", "/api/version", { host: `127.0.0.1:${P.loopbackPort}` });
  check("(P) CONTROL: the daemon's own loopback port still serves a plain Tier-1 GET with no token (unchanged)", lb.status === 200);
  const lbTrusted = await req(P.loopbackPort, "GET", "/api/version", { host: ENTRY_HOST, ...bearer(TOKEN) });
  check("(M) Serve mis-pointed at the daemon's OWN port: a trusted Host on PORT is 403 host-header-not-allowed (fails closed)", lbTrusted.status === 403 && lbTrusted.json?.error === "host header not allowed");
  const lbFwd = await req(P.loopbackPort, "GET", "/api/version", { host: `127.0.0.1:${P.loopbackPort}`, "x-forwarded-for": "100.64.9.9" });
  check("(M) a proxy that rewrites Host to loopback but adds X-Forwarded-For, aimed at PORT ⇒ forwarded class: 401 token required (was 200)", lbFwd.status === 401 && lbFwd.json?.code === "gateway-token-required");
  const lbFwdTier0 = await req(P.loopbackPort, "GET", "/api/platform/config", { host: `127.0.0.1:${P.loopbackPort}`, "tailscale-user-login": "a@b" });
  check("(M) ...and a Tier-0 GET with a Tailscale-* header on PORT is 401/403, not served", lbFwdTier0.status === 401 || lbFwdTier0.status === 403);

  // ===================== (W) real WebSockets on the proxy listener ==========================================
  const wsNo = await wsProbe(pp, "/ws/fleet", undefined, { host: ENTRY_HOST, origin: ENTRY });
  check("(W) /ws/fleet with NO token ⇒ 401 (was an ungated loopback feed)", wsNo.result === "http-401");
  const wsOk = await wsProbe(pp, "/ws/fleet", subprotocol(TOKEN), { host: ENTRY_HOST, origin: ENTRY });
  check("(W) /ws/fleet with the token in the double-subprotocol ⇒ opens", wsOk.result === "open");
  const wsBadHost = await wsProbe(pp, "/ws/fleet", subprotocol(TOKEN), { host: `127.0.0.1:${P.loopbackPort}`, origin: ENTRY });
  check("(W) a ws upgrade with a loopback Host ⇒ 403 (never loopback trust)", wsBadHost.result === "http-403");
  const wsBadOrigin = await wsProbe(pp, "/ws/fleet", subprotocol(TOKEN), { host: ENTRY_HOST, origin: "https://evil.example.com" });
  check("(W) a cross-site page's ws upgrade (Origin evil) ⇒ 403", wsBadOrigin.result === "http-403");
  const wsSecret = await wsProbe(pp, "/ws/term/s1", subprotocol(SECRET), { host: ENTRY_HOST, origin: ENTRY });
  check("(W) /ws/term with the LOOPBACK secret ⇒ 401 (not a credential to this class)", wsSecret.result === "http-401");
  const term = await wsProbe(pp, "/ws/term/s1", subprotocol(TOKEN), { host: ENTRY_HOST, origin: ENTRY });
  check("(W) /ws/term with the gateway token opens AND the first frame announces a read-only pane", term.result === "open" && term.first !== null && JSON.parse(term.first).type === "readOnly" && JSON.parse(term.first).reason === "remote");
  const shell = await wsProbe(pp, "/ws/term/shell1", subprotocol(TOKEN), { host: ENTRY_HOST, origin: ENTRY });
  check("(W) a host-SHELL terminal is refused (closed 1008) — never attached to this class (710a34fa)", shell.result === "closed-1008" || shell.result === "error");
  // stdin dropped: send a stdin frame on a live /ws/term/s1 and assert the pty never sees it.
  // The witness is ORDER, not a timer: frames on one socket are handled in order, so once the repaint sent AFTER the stdin has been
  // honoured, the stdin frame has provably already been processed (and dropped).
  const wsStdin = new WebSocket(`ws://127.0.0.1:${pp}/ws/term/s1`, subprotocol(TOKEN), { headers: { host: ENTRY_HOST, origin: ENTRY } });
  await new Promise((resolve) => { wsStdin.on("open", resolve); wsStdin.on("error", resolve); });
  wsStdin.send(JSON.stringify({ type: "stdin", data: "rm -rf /\n" }));
  wsStdin.send(JSON.stringify({ type: "repaint" }));
  await waitUntil(() => frames.some((f) => f[0] === "repaint"), { label: "the repaint sent after the stdin frame is honoured" });
  check("(W) CONTROL: the trailing repaint frame WAS processed (so the stdin frame before it was too)", frames.some((f) => f[0] === "repaint"));
  wsStdin.close();
  check("(W) a raw `stdin` frame from this class is DROPPED (the pty never receives it)", !frames.some((f) => f[0] === "stdin"));

  // ===================== (R) a REAL reverse proxy in front of the proxy listener ============================
  const serveLike = await reverseProxy(pp, (h) => ({ ...h, "x-forwarded-for": "100.64.7.7", "x-forwarded-proto": "https", "tailscale-user-login": "someone@example.com" })); // Host preserved
  const rewrites = await reverseProxy(pp, (h) => ({ ...h, host: `127.0.0.1:${pp}`, "x-forwarded-for": "100.64.7.7" })); // Host REWRITTEN to the upstream, XFF added (aimed at the PROXY listener)
  const clientChosen = await reverseProxy(pp, (h) => ({ ...h, host: `127.0.0.1:${P.loopbackPort}` })); // an attacker-chosen loopback Host forwarded verbatim
  try {
    const a = await req(serveLike.port, "GET", "/api/version", proxyHdrs(bearer(TOKEN)));
    check("(R) through a Host-PRESERVING real proxy: 200 with the token (Serve's documented shape)", a.status === 200);
    const a0 = await req(serveLike.port, "GET", "/api/version", proxyHdrs());
    check("(R) ...and 401 gateway-token-required without it — the daemon sees peer 127.0.0.1 yet classes it remote", a0.status === 401 && a0.json?.code === "gateway-token-required");
    const a1 = await req(serveLike.port, "GET", "/api/platform/config", proxyHdrs(bearer(TOKEN)));
    check("(R) ...a Tier-0 read through it is 403 {error:'forbidden'}", a1.status === 403 && a1.json?.error === "forbidden");
    const aw = await wsProbe(serveLike.port, "/ws/fleet", subprotocol(TOKEN), { host: ENTRY_HOST, origin: ENTRY });
    check("(R) ...and a real ws upgrade THROUGH the proxy is token-gated and opens with the token", aw.result === "open");
    const awNo = await wsProbe(serveLike.port, "/ws/fleet", undefined, { host: ENTRY_HOST, origin: ENTRY });
    check("(R) ...and is refused without it", awNo.result === "http-401");
    const b = await req(rewrites.port, "GET", "/api/version", proxyHdrs(bearer(TOKEN)));
    check("(R) through a Host-REWRITING proxy aimed at the proxy listener: 403 host-not-allowed — fails closed, NOT served as loopback", b.status === 403 && b.json?.error === "host header not allowed");
    const b1 = await req(rewrites.port, "GET", "/api/platform/config", proxyHdrs());
    check("(R) ...and a Tier-0 GET through it with no token is 403, not served (loopback would serve it ungated)", b1.status === 403);
    const c = await req(clientChosen.port, "GET", "/api/platform/config", {});
    check("(R) a client-chosen loopback Host forwarded verbatim through the proxy is 403, not served", c.status === 403);
    const c1 = await wsProbe(clientChosen.port, "/ws/fleet");
    check("(R) ...and /ws/fleet through it (was ungated on loopback) is refused", c1.result !== "open");
  } finally { await serveLike.close(); await rewrites.close(); await clientChosen.close(); }

  // ===================== (S) the SPA shell (F1) ============================================================
  const shellRes = await req(pp, "GET", "/", { host: ENTRY_HOST });
  check("(S) GET / with a trusted Host and NO token ⇒ 200 the shell (a browser must load the app before it can present a token)", shellRes.status === 200 && shellRes.body.includes("loom-shell-marker"));
  const asset = await req(pp, "GET", "/assets/app.js", { host: ENTRY_HOST, origin: ENTRY });
  check("(S) a static asset is served the same way", asset.status === 200 && asset.body.includes("shell-asset-marker"));
  const deep = await req(pp, "GET", "/board", { host: ENTRY_HOST });
  check("(S) a client-router deep link falls back to the shell", deep.status === 200 && deep.body.includes("loom-shell-marker"));
  const head = await req(pp, "HEAD", "/", { host: ENTRY_HOST });
  check("(S) HEAD / ⇒ 200", head.status === 200);
  const apiStill = await req(pp, "GET", "/api/version", { host: ENTRY_HOST });
  check("(S) CONTROL: the exemption is the shell only — GET /api/version with no token is still 401 gateway-token-required", apiStill.status === 401 && apiStill.json?.code === "gateway-token-required");
  const apiUnknown = await req(pp, "GET", "/api/does-not-exist", { host: ENTRY_HOST });
  check("(S) an UNKNOWN /api path is never answered with the shell (404, no shell body) — the reserved-path rule holds behind the exemption", apiUnknown.status === 404 && !apiUnknown.body.includes("loom-shell-marker"));
  const mcp = await req(pp, "GET", "/mcp/some-session", { host: ENTRY_HOST });
  check("(S) /mcp/* is not the shell either (never 200 with the shell body)", !mcp.body.includes("loom-shell-marker"));
  const postShell = await req(pp, "POST", "/", { host: ENTRY_HOST, "content-type": "application/json" }, "{}");
  const postDeep = await req(pp, "POST", "/board", { host: ENTRY_HOST, "content-type": "application/json" }, "{}");
  check("(S) only GET/HEAD: POST / and POST /board ⇒ 403 {error:'forbidden'} (tier wall, method-keyed)", postShell.status === 403 && postDeep.status === 403 && postShell.json?.error === "forbidden");
  const shellBadHost = await req(pp, "GET", "/", { host: "evil.example.com" });
  check("(S) the shell still requires a trusted Host ⇒ 403 host-header-not-allowed", shellBadHost.status === 403 && shellBadHost.json?.error === "host header not allowed");
  const shellBadOrigin = await req(pp, "GET", "/assets/app.js", { host: ENTRY_HOST, origin: "https://evil.example.com" });
  check("(S) ...and a cross-site Origin ⇒ 403 cross-origin-request-refused", shellBadOrigin.status === 403 && shellBadOrigin.json?.error === "cross-origin request refused");
  const shellFunnel = await req(pp, "GET", "/", { host: ENTRY_HOST, "tailscale-funnel-request": "?1" });
  check("(S) ...and a Funnel-fronted shell request is refused too", shellFunnel.status === 403);
  for (const trav of ["/..%2fsecret.txt", "/%2e%2e/secret.txt", "/assets/..%2f..%2fsecret.txt", "/..%5csecret.txt"]) {
    const t = await req(pp, "GET", trav, { host: ENTRY_HOST });
    check(`(S) path traversal ${trav} never serves a file outside the web dist`, !t.body.includes("OUTSIDE-THE-WEB-DIST-SECRET"));
  }
  // A dotfile / dot-directory INSIDE the web dist must not be servable to this (public-shell) class either.
  for (const dot of ["/.hidden-secret", "/.well-known/x.txt", "/%2ehidden-secret"]) {
    const t = await req(pp, "GET", dot, { host: ENTRY_HOST });
    check("(S) dotfile " + dot + " in the web dist is NOT served (dotfiles: ignore)", !t.body.includes("DOTFILE-IN-THE-WEB-DIST-SECRET") && !t.body.includes("DOTDIR-IN-THE-WEB-DIST-SECRET"));
  }
  const dotLoop = await req(P.loopbackPort, "GET", "/.hidden-secret", { host: "127.0.0.1:" + P.loopbackPort });
  check("(S) ...and not on the loopback listener either (the option is the static registration's, not the class's)", !dotLoop.body.includes("DOTFILE-IN-THE-WEB-DIST-SECRET"));
  for (const h of ["x-real-ip", "via"]) {
    const r = await req(P.loopbackPort, "GET", "/api/version", { host: "127.0.0.1:" + P.loopbackPort, [h]: "100.64.9.9" });
    check("(M) a proxy that adds only " + h + " and is aimed at the daemon's own port => forwarded class: 401 token required", r.status === 401 && r.json?.code === "gateway-token-required");
  }
  const shellOnMain = await req(P.loopbackPort, "GET", "/", { host: `127.0.0.1:${P.loopbackPort}`, "x-forwarded-for": "100.64.9.9" });
  // No rate cap on the public shell (removed: every proxied peer shares 127.0.0.1, so a shared bucket would let one peer 429 the owner's app load).
  const shellBurst = [];
  for (let i = 0; i < 14; i++) shellBurst.push(...await Promise.all(Array.from({ length: 50 }, () => req(pp, "GET", "/assets/app.js", { host: ENTRY_HOST })))); // 700 in waves of 50 (a socket-count limit is not what this asserts)
  check("(S) 700 shell requests (waves of 50, well past the removed 600/min cap) are ALL served (no shared unauthenticated cap on static bytes)", shellBurst.every((r) => r.status === 200));
  const apiAfterBurst = await req(pp, "GET", "/api/version", { host: ENTRY_HOST, ...bearer(TOKEN) });
  check("(S) ...and a valid-token API call right after the burst is still served (the shell never touched the API throttles)", apiAfterBurst.status === 200);
  check("(S) the exemption is the proxy LISTENER's: a forwarded-class request on the daemon's own port gets 403 {error:'forbidden'} for GET / (tier 0), not the shell", shellOnMain.status === 403 && shellOnMain.json?.error === "forbidden" && !shellOnMain.body.includes("loom-shell-marker"));
  const shellLoop = await req(P.loopbackPort, "GET", "/", { host: `127.0.0.1:${P.loopbackPort}` });
  check("(S) CONTROL: the loopback listener still serves the shell to a plain loopback browser (unchanged)", shellLoop.status === 200 && shellLoop.body.includes("loom-shell-marker"));

  // ===================== (L) throttle-only, verify-first =====================================================
  const statuses = [];
  for (let i = 0; i < PROXY_FAILED_AUTH_PER_MIN + 25; i++) statuses.push((await req(pp, "GET", "/api/version", proxyHdrs(bearer(`guess-${i}`)))).status);
  const throttled = statuses.filter((s) => s === 429).length, unauthorized = statuses.filter((s) => s === 401).length;
  // Earlier scenarios in this file already spent some of the same 60s failure window, so the count of leading 401s is not fixed: assert
  // what SURVIVES the throttle instead — only 401s then 429s appear, >=1 of each, and no 401 after the first 429.
  check(`(L) a flood of ${statuses.length} failed-token requests is THROTTLED on the failure path (only 401/429 appear, >=1 of each, once throttled it stays throttled)`, throttled >= 1 && unauthorized >= 1 && unauthorized + throttled === statuses.length && !statuses.slice(statuses.indexOf(429)).includes(401));
  const after = await req(pp, "GET", "/api/version", proxyHdrs(bearer(TOKEN)));
  check("(L) ...and a VALID token right after is served (200): never locked out — verify-first, throttle-only", after.status === 200);
  const afterMany = await Promise.all(Array.from({ length: 10 }, () => req(pp, "GET", "/api/version", proxyHdrs(bearer(TOKEN)))));
  check("(L) ...ten valid requests in a row all succeed while the failure path is still throttled", afterMany.every((r) => r.status === 200));
  const stillThrottled = await req(pp, "GET", "/api/version", proxyHdrs(bearer("another-guess")));
  check("(L) ...and the failure path IS still throttled (the control: the throttle was engaged, not merely absent)", stillThrottled.status === 429);
} finally {
  await P.app.close(); P.db.close();
}

// ===================== (B) boot ============================================================================
{
  const B1 = await boot(CFG, { tokenExists: false });
  try {
    check("(B) no gateway token ⇒ the proxy listener does NOT open, and says why", B1.proxy?.opened === false && B1.proxy.reasons.some((r) => /no gateway token/.test(r)) && B1.logs.some((l) => l.startsWith("WARN") && /no gateway token/.test(l)));
    check("(B) ...the daemon carries on loopback-only (the loopback listener answers)", (await req(B1.loopbackPort, "GET", "/api/version")).status === 200);
  } finally { await B1.app.close(); B1.db.close(); }
  const B2 = await boot({ enabled: true, bindHost: "127.0.0.1", trustedProxyOrigins: [ENTRY] });
  try { check("(B) no proxyPort ⇒ no proxy mode, NOTHING extra listens", B2.proxy === null); } finally { await B2.app.close(); B2.db.close(); }
  const B3 = await boot({ enabled: false, bindHost: "127.0.0.1", proxyPort: 0, trustedProxyOrigins: [ENTRY] });
  try { check("(B) `enabled:false` ⇒ no proxy mode even with proxyPort + origins (one master switch)", B3.proxy === null); } finally { await B3.app.close(); B3.db.close(); }
  const B4 = await boot({ enabled: true, bindHost: "127.0.0.1", proxyPort: 0, trustedProxyOrigins: ["https://*.ts.net"] });
  try { check("(B) only-invalid origins ⇒ no proxy mode", B4.proxy === null); } finally { await B4.app.close(); B4.db.close(); }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the proxy listener's class follows the LISTENER: token-gated, Tier-1 only, Host==entry, same-entry Origin, Funnel refused, a rewritten/forged Host fails closed, ws is gated and view-only, throttle-only"
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
