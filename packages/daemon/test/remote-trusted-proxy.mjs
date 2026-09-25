import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 4cbbc343 — trusted-reverse-proxy mode (`tailscale serve` et al.): the PURE + injected half. The trust class
// follows the LISTENER a request arrived on (proxy listener / remote listener / a non-loopback peer), never a Host
// header; this file pins the predicate (`requestClass`), the canonical origin / Host / Origin matchers, the
// human-only config validation, `resolveRemoteTrust`'s single source of truth, and the fail-closed wall invariant.
// The REAL-socket half (a real proxy listener, a real Host-rewriting reverse proxy, real ws) is
// remote-trusted-proxy-real.mjs. HERMETIC + CLAUDE-FREE + NETWORK-FREE (Db + buildServer via app.inject).
import fs from "node:fs";
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { hermeticPort } from "./_hermetic-port.mjs";

const TMP = mkdtempManaged("loom-trusted-proxy-");
process.env.LOOM_HOME = TMP;
process.env.LOOM_PORT = String(hermeticPort());
const PORT = process.env.LOOM_PORT;
const sandboxHome = path.join(TMP, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const T = await import("../dist/gateway/trust-tier.js");
const { validatePlatformConfigOverride, validateProjectConfigOverride } = await import("../dist/mcp/platform.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// ===================== (1) canonicalTrustedProxyOrigin — the entry canonicaliser ===========================
{
  const c = T.canonicalTrustedProxyOrigin;
  check("(1) a plain https origin is kept", c("https://box.tail1.ts.net") === "https://box.tail1.ts.net");
  check("(1) canonicalised: upper-case host lower-cased, default port :443 stripped", c("HTTPS://Box.Tail1.TS.net:443") === "https://box.tail1.ts.net");
  check("(1) an explicit non-default port is kept", c("https://box.tail1.ts.net:8443") === "https://box.tail1.ts.net:8443");
  check("(1) http is accepted ONLY for a .ts.net name", c("http://box.tail1.ts.net:8080") === "http://box.tail1.ts.net:8080" && c("http://proxy.example.com") === null);
  check("(1) an https origin on a non-tailnet name (a real reverse proxy) is accepted", c("https://loom.example.com") === "https://loom.example.com");
  for (const [label, bad] of [
    ["a wildcard", "https://*.ts.net"], ["a leading wildcard label", "https://*.example.com"], ["a path", "https://box.ts.net/loom"],
    ["a bare trailing slash", "https://box.ts.net/"], ["a query", "https://box.ts.net?x=1"], ["a fragment", "https://box.ts.net#x"],
    ["userinfo", "https://user@box.ts.net"], ["a trailing-dot host", "https://box.ts.net."], ["surrounding whitespace", " https://box.ts.net"],
    ["loopback 127.0.0.1", "https://127.0.0.1:8443"], ["loopback localhost", "https://localhost"], ["::1", "https://[::1]:8443"],
    ["the wildcard bind 0.0.0.0", "https://0.0.0.0"], ["an ambiguous numeric host", "https://0x7f.0.0.1"], ["a non-http scheme", "ftp://box.ts.net"],
    ["no scheme", "box.ts.net"], ["the string null", "null"], ["an empty string", ""],
  ]) check(`(1) REJECTED: ${label} (${JSON.stringify(bad)})`, c(bad) === null);
  const list = T.trustedProxyOriginList({ enabled: true, bindHost: "127.0.0.1", trustedProxyOrigins: ["https://A.ts.net:443", "https://a.ts.net", "https://*.ts.net", "https://127.0.0.1"] });
  check("(1) trustedProxyOriginList canonicalises, de-duplicates and DROPS invalid entries (fail-closed)", JSON.stringify(list) === JSON.stringify(["https://a.ts.net"]));
}

// ===================== (2) the Host / Origin matchers ======================================================
{
  const E = ["https://box.tail1.ts.net:8443", "https://other.tail1.ts.net"];
  const host = (h) => T.trustedProxyEntryForHost(h, E);
  check("(2) Host === entry host:port matches", host("box.tail1.ts.net:8443") === E[0]);
  check("(2) Host matching is case-insensitive", host("BOX.tail1.ts.net:8443") === E[0]);
  check("(2) default port: an entry without a port matches BOTH `x` and `x:443`", host("other.tail1.ts.net") === E[1] && host("other.tail1.ts.net:443") === E[1]);
  check("(2) the entry WITH :8443 does not match the port-less host", host("box.tail1.ts.net") === null);
  check("(2) a wrong port does not match", host("box.tail1.ts.net:9443") === null);
  check("(2) a trailing-dot host never matches", host("box.tail1.ts.net.:8443") === null);
  check("(2) userinfo smuggling (`evil@box…`) is refused, not parsed", host("evil@box.tail1.ts.net:8443") === null);
  check("(2) a loopback Host never matches a trusted entry", host("127.0.0.1:4317") === null && host("localhost") === null);
  check("(2) an absent / empty Host never matches", host(undefined) === null && host("") === null);
  const o = (v, e = E[0]) => T.proxyOriginAllowed(v, e);
  check("(2) Origin ABSENT is allowed (a non-browser client)", o(undefined) === true);
  check("(2) Origin === the SAME entry is allowed", o("https://box.tail1.ts.net:8443") === true);
  check("(2) Origin of the OTHER entry is refused (must be THAT SAME entry)", o("https://other.tail1.ts.net") === false);
  check("(2) Origin with a different port / scheme is refused", o("https://box.tail1.ts.net") === false && o("http://box.tail1.ts.net:8443") === false);
  check("(2) `Origin: null` is refused", o("null") === false);
  check("(2) an EMPTY Origin is refused (not silently 'absent')", o("") === false);
  check("(2) a loopback Origin is refused", o("http://127.0.0.1:4317") === false);
  check("(2) a duplicated (array) Origin header is refused", o(["https://box.tail1.ts.net:8443", "https://box.tail1.ts.net:8443"]) === false);
}

// ===================== (3) requestClass — the ONE predicate ================================================
{
  const fake = (addr, headers = {}) => ({ socket: addr === undefined ? undefined : { remoteAddress: addr }, headers });
  const cls = (req, proxyMode = false) => T.requestClass(req, { proxyMode });
  const isLoop = (c) => c.kind === "loopback";
  check("(3) 127.0.0.1 / ::1 / ::ffff:127.0.0.1 peers are loopback", ["127.0.0.1", "::1", "::ffff:127.0.0.1"].every((a) => isLoop(cls(fake(a)))));
  check("(3) a LAN / tailnet peer is remote (via peer)", cls(fake("100.64.1.2")).via === "peer" && cls(fake("203.0.113.9")).kind === "remote");
  check("(3) an EMPTY peer address is remote (fail-closed)", cls(fake("")).kind === "remote");
  check("(3) a request with NO socket at all is remote (fail-closed)", cls(fake(undefined)).kind === "remote");
  const viaRemote = fake("127.0.0.1"); T.markRemoteListenerRequest(viaRemote);
  check("(3) d0f3c8ea: a LOOPBACK peer that arrived on the remote listener is remote (via remote-listener)", cls(viaRemote).kind === "remote" && cls(viaRemote).via === "remote-listener");
  const viaProxy = fake("127.0.0.1", { host: "127.0.0.1:4317" }); T.markProxyListenerRequest(viaProxy);
  check("(3) a request on the proxy listener is remote (via proxy) WHATEVER its Host says — even a loopback Host", cls(viaProxy).kind === "remote" && cls(viaProxy).via === "proxy");
  const both = fake("127.0.0.1"); T.markRemoteListenerRequest(both); T.markProxyListenerRequest(both);
  check("(3) ...and the proxy mark wins if a request is (impossibly) marked both", cls(both).via === "proxy");
  check("(3) proxy-shaped headers on a loopback peer: forwarded class ONLY in proxy mode", cls(fake("127.0.0.1", { "x-forwarded-for": "1.2.3.4" }), true).via === "forwarded" && isLoop(cls(fake("127.0.0.1", { "x-forwarded-for": "1.2.3.4" }), false)));
  for (const h of ["x-forwarded-host", "x-forwarded-proto", "forwarded", "x-real-ip", "via", "tailscale-user-login", "tailscale-funnel-request"]) {
    check(`(3) header ${h} on a loopback peer in proxy mode ⇒ forwarded (remote)`, cls(fake("127.0.0.1", { [h]: "x" }), true).kind === "remote");
  }
  check("(3) an ordinary loopback request with normal headers stays loopback in proxy mode (the control)", isLoop(cls(fake("127.0.0.1", { host: "127.0.0.1:4317", origin: "http://127.0.0.1:5317", authorization: "Bearer x" }), true)));
  // DOCUMENTED LIMIT (README + site/remote-access.html: "never point a proxy at the daemon's own port"): on the DAEMON'S OWN
  // port the class still follows the peer. A proxy that rewrites Host to 127.0.0.1:<port> and adds NO proxy-shaped header
  // (nginx's default proxy_pass) is indistinguishable from a local client and is loopback — this pins that so the docs'
  // warning can never silently become untrue in either direction.
  check("(3) LIMIT: loopback Host + NO proxy-shaped header on the daemon port ⇒ loopback, even in proxy mode (why the docs say never point a proxy there)", isLoop(cls(fake("127.0.0.1", { host: "127.0.0.1:4317" }), true)));
  check("(3) a Host naming a trusted entry does NOT make a loopback peer remote by itself (class follows the listener, not Host)", isLoop(cls(fake("127.0.0.1", { host: "box.tail1.ts.net:8443" }), true)));
  check("(3) peerAddressOf reads the socket address (rate-limit key only)", T.peerAddressOf(fake("10.1.2.3")) === "10.1.2.3" && T.peerAddressOf(fake(undefined)) === "");
}

// ===================== (3b) isStaticShellRoute — keyed on the matched PATTERN, never a path ================
{
  const S = T.isStaticShellRoute;
  check("(3b) GET/HEAD on the static wildcard pattern is the shell", S("GET", "/*") === true && S("HEAD", "/*") === true && S("get", "/*") === true);
  check("(3b) any other method is NOT (POST/PUT/DELETE/PATCH/OPTIONS on /*)", ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"].every((m) => S(m, "/*") === false));
  check("(3b) any other PATTERN is NOT — including look-alikes and real API/WS/MCP patterns", ["/", "/api/*", "/api/version", "/ws/fleet", "/mcp/:sessionId", "/internal/hook", "/*/x", "*", ""].every((p) => S("GET", p) === false));
  check("(3b) an UNMATCHED route (pattern undefined, a 404) is NOT the shell", S("GET", undefined) === false);
}

// ===================== (4) resolveRemoteTrust — the single source of truth =================================
{
  const base = { enabled: true, bindHost: "127.0.0.1" };
  const R = T.resolveRemoteTrust;
  check("(4) default config: no wall, no proxy mode", (() => { const r = R({ enabled: false, bindHost: "127.0.0.1" }); return !r.tierWall && !r.proxyMode && r.trustedOrigins.length === 0; })());
  check("(4) proxy mode needs proxyPort", R({ ...base, trustedProxyOrigins: ["https://a.ts.net"] }).proxyMode === false);
  check("(4) proxy mode needs a valid trusted origin", R({ ...base, proxyPort: 4500 }).proxyMode === false && R({ ...base, proxyPort: 4500, trustedProxyOrigins: ["https://*.ts.net"] }).proxyMode === false);
  check("(4) proxy mode needs `enabled` (F3: one master switch)", R({ enabled: false, bindHost: "127.0.0.1", proxyPort: 4500, trustedProxyOrigins: ["https://a.ts.net"] }).proxyMode === false);
  const on = R({ ...base, proxyPort: 4500, trustedProxyOrigins: ["https://A.ts.net:443"] });
  check("(4) enabled + proxyPort + a valid origin ⇒ proxyMode AND the wall is registered, origins canonical", on.proxyMode && on.tierWall && on.trustedOrigins[0] === "https://a.ts.net");
  check("(4) a remote (non-loopback) bind alone registers the wall without proxy mode", (() => { const r = R({ enabled: true, bindHost: "100.64.1.2" }); return r.tierWall && !r.proxyMode; })());
  const reasons = (cfg, tok = true, ports = { loopbackPort: 4317, remotePort: null }) => T.proxyListenerRefusalReasons(cfg, tok, ports);
  check("(4) a complete config has no refusal reasons", reasons({ ...base, proxyPort: 4500, trustedProxyOrigins: ["https://a.ts.net"] }).length === 0);
  check("(4) no gateway token ⇒ refused (boot refusal)", reasons({ ...base, proxyPort: 4500, trustedProxyOrigins: ["https://a.ts.net"] }, false).some((r) => /no gateway token/.test(r)));
  check("(4) proxyPort === the loopback port ⇒ refused", reasons({ ...base, proxyPort: 4317, trustedProxyOrigins: ["https://a.ts.net"] }).some((r) => /loopback listener's port/.test(r)));
  check("(4) proxyPort === the remote port ⇒ refused", reasons({ ...base, proxyPort: 4318, trustedProxyOrigins: ["https://a.ts.net"] }, true, { loopbackPort: 4317, remotePort: 4318 }).some((r) => /remote listener's port/.test(r)));
  check("(4) a trusted origin whose host is also an allowedHosts entry ⇒ refused (classes stay disjoint)", reasons({ enabled: true, bindHost: "100.64.1.2", allowedHosts: ["a.ts.net"], proxyPort: 4500, trustedProxyOrigins: ["https://a.ts.net"] }).some((r) => /disjoint/.test(r)));
}

// ===================== (5) human-only config validation ====================================================
{
  const v = (ra) => validatePlatformConfigOverride({ remoteAccess: ra });
  check("(5) a valid trustedProxyOrigins + proxyPort is accepted", v({ enabled: true, proxyPort: 4500, trustedProxyOrigins: ["https://box.tail1.ts.net:8443"] }).ok === true);
  const stored = v({ trustedProxyOrigins: ["HTTPS://Box.Tail1.ts.net:443"] });
  check("(5) ...and STORED canonical (the schema transforms)", stored.ok === true && stored.value?.remoteAccess?.trustedProxyOrigins?.[0] === "https://box.tail1.ts.net");
  for (const bad of ["https://*.ts.net", "https://127.0.0.1", "https://box.ts.net/path", "http://example.com", "https://box.ts.net."]) {
    check(`(5) REJECTED by the human validator: ${bad}`, v({ trustedProxyOrigins: [bad] }).ok === false);
  }
  check("(5) proxyPort === the daemon's own PORT is rejected", v({ proxyPort: Number(PORT) }).ok === false);
  check("(5) proxyPort out of range / non-integer rejected", v({ proxyPort: 0 }).ok === false && v({ proxyPort: 70000 }).ok === false && v({ proxyPort: 1.5 }).ok === false);
  check("(5) more than 16 origins rejected", v({ trustedProxyOrigins: Array.from({ length: 17 }, (_, i) => `https://h${i}.ts.net`) }).ok === false);
  // The AGENT-reachable project config can never carry these (remote-bind.mjs (5) already pins `remoteAccess`; re-pin the new keys).
  const p1 = validateProjectConfigOverride({ remoteAccess: { trustedProxyOrigins: ["https://box.ts.net"] } });
  const p2 = validateProjectConfigOverride({ remoteAccess: { proxyPort: 4500 } });
  check("(5) the agent-reachable project-config validator rejects remoteAccess.trustedProxyOrigins and .proxyPort", p1.ok === false && p2.ok === false);
}

// ===================== (6) the fail-closed wall invariant + the forwarded class (injected) =================
{
  const stub = {};
  const build = (db, extra = {}) => buildServer({
    db, pty: stub, sessions: { killAllWorkers: () => 0 }, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, userAuditMcp: stub,
    setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub, requestShutdown: () => {}, verifyGatewayToken: (t) => t === "GOOD", ...extra,
  });
  // (6a) DEFAULT config (no wall registered): a non-loopback peer must NOT fall through to loopback-era guards.
  const db0 = new Db(path.join(TMP, "a.db"));
  const app0 = await build(db0);
  try {
    const ok = await app0.inject({ method: "GET", url: "/api/version" });
    check("(6a) control: a default loopback GET /api/version is 200 (the config is inert)", ok.statusCode === 200);
    const r = await app0.inject({ method: "GET", url: "/api/version", remoteAddress: "203.0.113.9", headers: { host: "127.0.0.1:4317" } });
    check("(6a) FAIL-CLOSED: a remote-class request with NO wall registered is 403 {error:'forbidden'} (the class body, not the Host check's)", r.statusCode === 403 && JSON.parse(r.body).error === "forbidden");
    const fwd = await app0.inject({ method: "GET", url: "/api/version", headers: { "x-forwarded-for": "198.51.100.7" } });
    check("(6a) with proxy mode OFF, an X-Forwarded-For header on a loopback request changes nothing (byte-identical default)", fwd.statusCode === 200);
  } finally { await app0.close(); db0.close(); }

  // (6b) proxy mode configured: the wall is registered; a loopback peer on the daemon's own port carrying a proxy header is remote.
  const db1 = new Db(path.join(TMP, "b.db"));
  db1.setPlatformConfig({ remoteAccess: { enabled: true, bindHost: "127.0.0.1", proxyPort: 4500, trustedProxyOrigins: ["https://box.tail1.ts.net:8443"] } });
  const app1 = await build(db1);
  try {
    const plain = await app1.inject({ method: "GET", url: "/api/version" });
    check("(6b) proxy mode on: an ordinary loopback request is still 200 with no token (loopback unchanged)", plain.statusCode === 200);
    const f = await app1.inject({ method: "GET", url: "/api/version", headers: { "x-forwarded-for": "198.51.100.7" } });
    const fb = JSON.parse(f.body);
    check("(6b) a proxy-shaped header on the daemon's own port ⇒ remote class: 401 gateway-token-required (a downgrade only)", f.statusCode === 401 && fb.code === "gateway-token-required" && fb.error === "unauthorized");
    const g = await app1.inject({ method: "GET", url: "/api/version", headers: { "x-forwarded-for": "198.51.100.7", authorization: "Bearer GOOD" } });
    check("(6b) ...and with the gateway token that same request is served (Tier-1 read)", g.statusCode === 200);
    const w = await app1.inject({ method: "POST", url: "/api/orchestration/pause", headers: { "x-forwarded-for": "198.51.100.7", authorization: "Bearer GOOD" } });
    check("(6b) ...a Tier-0 write from it is 403 {error:'forbidden'} even WITH a valid gateway token", w.statusCode === 403 && JSON.parse(w.body).error === "forbidden");
    const proxyHost = await app1.inject({ method: "GET", url: "/api/version", headers: { host: "box.tail1.ts.net:8443", authorization: "Bearer GOOD" } });
    check("(6b) Serve mis-pointed at the daemon's own PORT fails CLOSED: a trusted Host on PORT is still 403 host-not-allowed", proxyHost.statusCode === 403 && JSON.parse(proxyHost.body).error === "host header not allowed");
    const internal = await app1.inject({ method: "POST", url: "/internal/shutdown", headers: { "x-forwarded-for": "198.51.100.7" }, payload: {} });
    check("(6b) /internal/shutdown from a forwarded-class request is 403 forbidden (never reaches the handler)", internal.statusCode === 403);
  } finally { await app1.close(); db1.close(); }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the trust class follows the listener (requestClass), trusted origins are canonical exact origins, Host/Origin matching is strict, config is human-only and validated, and a remote class with no wall fails closed"
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
