import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 1d882a8c — the owner's per-connection opt-in to PLAIN HTTP for a private/LAN host. This RELAXES an egress
// control, so every group below pins one invariant the relaxation must keep. Hermetic: temp LOOM_HOME, real Db,
// real envelope key, DNS is always an injected stub, the only sockets are loopback servers this file opens.
//   A. classifyAddress: the numeric address classes (v4, v6, IPv4-mapped), incl. the near-miss ranges.
//   B. store: default OFF; the flag is accepted only with a private host form; edits re-validate the host.
//   C. request, https unchanged; a stored `http://` host is still refused (no opt-in => no http).
//   D. request, opt-in: the RESOLVED-address rules (both polarities), resolve-once-and-pin.
//   E. the real pinned adapter against loopback servers: dials the checked address, never follows a redirect,
//      drops a caller Host, enforces the byte cap and the timeout, and its errors are URL-free.
//   F. tier gating (loopback-only REST) + no agent MCP path.
// Run: 1) build (turbo builds shared first), 2) node test/connections-plain-http.mjs
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = mkdtempManaged("loom-plainhttp-");
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
// The daemon's "own" ports for the hairpin-guard group G (paths.ts reads LOOM_PORT once at import).
const DAEMON_PORT = 47311;
const PROXY_PORT = 47312;
process.env.LOOM_PORT = String(DAEMON_PORT);

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { routeTier } = await import("../dist/gateway/trust-tier.js");
const { classifyAddress, createPinnedHttpFetch } = await import("../dist/connections/lanHttp.js");
const { createConnection, updateConnection, getConnectionMetadata, listConnections, validateConnectionHost } = await import("../dist/connections/store.js");
const { performAuthenticatedRequest, __resetConnectionsRateLimitState } = await import("../dist/connections/request.js");

const SECRET = "plex-DO-NOT-LEAK-7c1d9a";
const GUARD = { requestTimeoutMs: 5000, maxResponseBytes: 1000, rateLimitMax: 1000, rateLimitWindowMs: 60000 };

// ============ A. classifyAddress ============
{
  const want = {
    "10.0.0.1": "private", "10.255.255.255": "private", "172.16.0.1": "private", "172.31.255.255": "private",
    "192.168.178.136": "private", "127.0.0.1": "loopback", "127.9.9.9": "loopback", "169.254.169.254": "link-local",
    "172.15.255.255": "other", "172.32.0.1": "other", "192.169.0.1": "other", "11.0.0.1": "other", "8.8.8.8": "other",
    "100.64.0.1": "other", "0.0.0.0": "other", "224.0.0.1": "other", "255.255.255.255": "other",
    "::1": "loopback", "fd00::1": "private", "fc00::1": "private", "fe80::1": "link-local", "febf::1": "link-local",
    "fec0::1": "other", "2001:db8::1": "other", "::": "other", "ff02::1": "other",
    "::ffff:192.168.1.5": "private", "::ffff:127.0.0.1": "loopback", "::ffff:8.8.8.8": "other", "::ffff:169.254.169.254": "link-local",
    "[fd00::1]": "private", "not-an-ip": "other", "": "other",
  };
  for (const [addr, cls] of Object.entries(want)) check(`A: classifyAddress(${JSON.stringify(addr)}) === ${cls}`, classifyAddress(addr) === cls);
}

// ============ B. store ============
const db = new Db(path.join(tmpHome, "ph.db"));
const stub = {};
const app = await buildServer({
  db, pty: { enqueueStdin: () => ({ delivered: true }) }, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub,
  userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub,
});
const mk = (over) => createConnection(db, { name: `c${Math.random().toString(36).slice(2, 8)}`, host: "192.168.178.136:32400", authScheme: "api-key", secret: SECRET, ...over });
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

{
  const plain = mk({ host: "api.example.com" });
  check("B: default is OFF (metadata has no allowPlainHttp key)", !("allowPlainHttp" in plain) && db.getConnection(plain.id).allowPlainHttp === false);
  const lan = mk({ allowPlainHttp: true });
  check("B: opt-in with a private literal + port is stored and reads back true", lan.allowPlainHttp === true && db.getConnection(lan.id).allowPlainHttp === true);
  check("B: the host is stored as host:port, scheme never in it", db.getConnection(lan.id).host === "192.168.178.136:32400");
  check("B: a public IP literal is refused at save even with the opt-in", throws(() => mk({ host: "8.8.8.8:80", allowPlainHttp: true })) && throws(() => mk({ host: "8.8.8.8:8080", allowPlainHttp: true })));
  check("B: ':80' is refused for plain http (URL drops the default port)", !validateConnectionHost("192.168.1.5:80", "http").ok && validateConnectionHost("192.168.1.5:8080", "http").ok);
  check("B: ':443' stays refused for https but is a plain port for http", !validateConnectionHost("api.example.com:443", "https").ok && validateConnectionHost("192.168.1.5:443", "http").ok);
  check("B: a scheme in the host is refused even with the opt-in", throws(() => mk({ host: "http://192.168.1.5:32400", allowPlainHttp: true })));
  check("B: a hostname (judged at request time) and .local pass the save check", !throws(() => mk({ host: "plex.local:32400", allowPlainHttp: true })) && !throws(() => mk({ host: "nas.lan", allowPlainHttp: true })));
  check("B: a bracketed ULA v6 literal is accepted; a public v6 literal is refused", !throws(() => mk({ host: "[fd00::5]:8080", allowPlainHttp: true })) && throws(() => mk({ host: "[2001:db8::5]:8080", allowPlainHttp: true })));
  check("B: a non-boolean allowPlainHttp is refused", throws(() => mk({ allowPlainHttp: "yes" })));
  check("B: a non-private literal WITHOUT the opt-in is an ordinary https host (unchanged)", !throws(() => mk({ host: "8.8.8.8" })));
  check("B: loopback + link-local literals are accepted as written", !throws(() => mk({ host: "127.0.0.1:9000", allowPlainHttp: true })) && !throws(() => mk({ host: "169.254.10.10:9000", allowPlainHttp: true })));

  // edits
  const e = mk({ host: "api.example.com" });
  const on = updateConnection(db, e.id, { host: "192.168.50.7:8123", allowPlainHttp: true });
  check("B: an edit can set host + flag together; the changed-field NAMES include allowPlainHttp", on.metadata.allowPlainHttp === true && on.changedFields.includes("allowPlainHttp") && on.changedFields.includes("host"));
  check("B: a no-op resend of the flag changes nothing", updateConnection(db, e.id, { allowPlainHttp: true }).changedFields.length === 0);
  const off = updateConnection(db, e.id, { allowPlainHttp: false });
  check("B: turning it off reads back absent/false", !("allowPlainHttp" in off.metadata) && db.getConnection(e.id).allowPlainHttp === false);
  const pub = mk({ host: "8.8.8.8" });
  check("B: flipping the flag ON with an unchanged PUBLIC host is refused", throws(() => updateConnection(db, pub.id, { allowPlainHttp: true })) && db.getConnection(pub.id).allowPlainHttp === false);
  check("B: a non-boolean edit is refused", throws(() => updateConnection(db, e.id, { allowPlainHttp: 1 })));

  // The owner's Plex shape: a legacy row whose host text carries a scheme (db layer, bypassing today's validator).
  const legacy = db.createConnection({ name: "Plex", host: "http://192.168.178.136:32400", authScheme: "api-key", secretBlob: "v1:AAAA:BBBB:CCCC" });
  const lm = getConnectionMetadata(db, legacy.id);
  check("B: the legacy Plex row is flagged invalidHost and NOT silently migrated", lm.invalidHost === true && db.getConnection(legacy.id).host === "http://192.168.178.136:32400" && db.getConnection(legacy.id).allowPlainHttp === false);
  check("B: ticking the flag alone on that row is refused (the host is still invalid)", throws(() => updateConnection(db, legacy.id, { allowPlainHttp: true })));
  check("B: resending the invalid host while flipping the flag is refused too", throws(() => updateConnection(db, legacy.id, { host: "http://192.168.178.136:32400", allowPlainHttp: true })));
  const fixed = updateConnection(db, legacy.id, { host: "192.168.178.136:32400", allowPlainHttp: true });
  check("B: the owner's edit (host:port + flag) clears the flag and keeps the row id", fixed.metadata.id === legacy.id && !fixed.metadata.invalidHost && fixed.metadata.allowPlainHttp === true);

  // oauth2 / ssh never carry the flag
  const oa = db.createConnection({ name: "oa", host: "oauth.example.com", authScheme: "oauth2", secretBlob: "v1:AAAA:BBBB:CCCC" });
  check("B: an oauth2 row refuses the flag on edit", throws(() => updateConnection(db, oa.id, { allowPlainHttp: true })));
  const forced = db.createConnection({ name: "oa2", host: "oauth2.example.com", authScheme: "oauth2", secretBlob: "v1:AAAA:BBBB:CCCC", allowPlainHttp: true });
  check("B: even a tampered oauth2 row's flag is never surfaced", !("allowPlainHttp" in getConnectionMetadata(db, forced.id)));
}

// ============ C. request: https unchanged; no opt-in => no http ============
const reqDeps = (over = {}) => ({ db, ...over });
const okFetch = (calls) => async (url, init) => { calls.push({ url: String(url), init }); return new Response("ok", { status: 200 }); };
{
  __resetConnectionsRateLimitState();
  const c = mk({ host: "api.example.com:8443" });
  const calls = [];
  let factoryCalls = 0; let lookups = 0;
  const r = await performAuthenticatedRequest(reqDeps({ fetchImpl: okFetch(calls), pinnedFetchFactory: () => { factoryCalls++; return okFetch([]); }, lookupImpl: async () => { lookups++; return ["8.8.8.8"]; } }), [c.id], GUARD, { connection: c.id, path: "/x" });
  check("C: an https connection still dials https://<host><path> through the injected fetch", r.ok && calls[0].url === "https://api.example.com:8443/x");
  check("C: an https connection never touches DNS-pinning (no lookup, no pinned factory)", factoryCalls === 0 && lookups === 0);

  // An unfixed legacy row (the Plex shape: a scheme inside the host text, no opt-in).
  __resetConnectionsRateLimitState();
  const stored = db.createConnection({ name: "PlexOld", host: "http://192.168.178.136:32400", authScheme: "api-key", secretBlob: "v1:AAAA:BBBB:CCCC" });
  const calls3 = [];
  const r3 = await performAuthenticatedRequest(reqDeps({ fetchImpl: okFetch(calls3), pinnedFetchFactory: () => { factoryCalls++; return okFetch(calls3); } }), [stored.id], GUARD, { connection: stored.id, path: "/x" });
  check("C: a stored `http://…` host without the opt-in is refused before any dispatch", r3.ok === false && calls3.length === 0 && factoryCalls === 0);
}

// ============ D. request, opt-in: resolved-address rules + resolve-once-and-pin ============
const run = async (host, resolved, extra = {}) => {
  __resetConnectionsRateLimitState();
  // db layer on purpose: some rows here are ones the SAVE validator refuses (a public literal), proving the
  // REQUEST-time check is independent of the save-time one.
  const c = db.createConnection({ name: `d${Math.random().toString(36).slice(2, 8)}`, host, authScheme: extra.authScheme ?? "api-key", secretBlob: (await import("../dist/keys/envelope.js")).encryptSecret(SECRET), allowPlainHttp: true });
  const seen = { targets: [], lookups: 0, fetches: [] };
  const deps = reqDeps({
    lookupImpl: async (h) => { seen.lookups++; seen.lookedUp = h; if (resolved instanceof Error) throw resolved; return resolved; },
    pinnedFetchFactory: (t) => { seen.targets.push(t); return async (url, init) => { seen.fetches.push({ url: String(url), init }); return new Response("lan ok", { status: 200, headers: { "x-echo": init.headers["X-API-Key"] ?? "" } }); }; },
  });
  const r = await performAuthenticatedRequest(deps, [c.id], GUARD, { connection: c.id, path: "/status?x=1" });
  return { r, seen };
};
{
  const lit = await run("192.168.178.136:32400", []);
  check("D: a private IP literal with the opt-in is allowed, no DNS at all", lit.r.ok && lit.seen.lookups === 0 && lit.seen.targets[0].address === "192.168.178.136" && lit.seen.targets[0].port === 32400);
  check("D: the request URL is http:// with the original path+query, Host header = the configured host", lit.seen.fetches[0].url === "http://192.168.178.136:32400/status?x=1" && lit.seen.targets[0].hostHeader === "192.168.178.136:32400");
  check("D: the secret is injected server-side and never in the agent-visible result (echo header redacted)", lit.seen.fetches[0].init.headers["X-API-Key"] === SECRET && !JSON.stringify(lit.r).includes(SECRET));

  const pubLit = await run("8.8.8.8:8080", []);
  check("D: a PUBLIC IP literal is refused even with the opt-in (no pinned fetch built)", pubLit.r.ok === false && pubLit.seen.targets.length === 0);
  const loopLit = await run("127.0.0.1:9", []);
  check("D: a LOOPBACK literal is allowed as written", loopLit.r.ok && loopLit.seen.targets[0].address === "127.0.0.1");
  const llLit = await run("169.254.10.10:9", []);
  check("D: a LINK-LOCAL literal is allowed as written", llLit.r.ok && llLit.seen.targets[0].address === "169.254.10.10");
  const v6Lit = await run("[fd00::5]:8080", []);
  check("D: a ULA IPv6 literal is allowed and pinned unbracketed", v6Lit.r.ok && v6Lit.seen.targets[0].address === "fd00::5" && v6Lit.seen.targets[0].port === 8080);

  const named = await run("plex.local:32400", ["192.168.178.136"]);
  check("D: a name -> RFC1918 is allowed, looked up exactly ONCE, pinned to that address", named.r.ok && named.seen.lookups === 1 && named.seen.lookedUp === "plex.local" && named.seen.targets[0].address === "192.168.178.136" && named.seen.targets[0].hostHeader === "plex.local:32400");
  const ula = await run("nas.lan:8080", ["fd12:3456::9"]);
  check("D: a name -> ULA is allowed", ula.r.ok && ula.seen.targets[0].address === "fd12:3456::9");
  const pubName = await run("evil.example:8080", ["93.184.216.34"]);
  check("D: a name -> PUBLIC is refused (DNS-rebinding guard)", pubName.r.ok === false && pubName.seen.targets.length === 0);
  const mixed = await run("mixed.example:8080", ["192.168.1.5", "93.184.216.34"]);
  check("D: MIXED private+public A records refuse the lot", mixed.r.ok === false && mixed.seen.targets.length === 0);
  const mixed2 = await run("mixed2.example:8080", ["93.184.216.34", "192.168.1.5"]);
  check("D: ... in either order", mixed2.r.ok === false && mixed2.seen.targets.length === 0);
  const toLoop = await run("lan.example:8080", ["127.0.0.1"]);
  check("D: a NAME -> 127.0.0.1 is REFUSED (rebinding onto the daemon's own loopback)", toLoop.r.ok === false && toLoop.seen.targets.length === 0);
  const toLoop6 = await run("lan6.example:8080", ["::1"]);
  check("D: a NAME -> ::1 is REFUSED", toLoop6.r.ok === false && toLoop6.seen.targets.length === 0);
  const toMapped = await run("lanm.example:8080", ["::ffff:127.0.0.1"]);
  check("D: a NAME -> IPv4-mapped loopback is REFUSED", toMapped.r.ok === false && toMapped.seen.targets.length === 0);
  const toMeta = await run("meta.example:80", ["169.254.169.254"]);
  check("D: a NAME -> 169.254.169.254 (link-local) is REFUSED", toMeta.r.ok === false && toMeta.seen.targets.length === 0);
  const toLL6 = await run("ll6.example:8080", ["fe80::1"]);
  check("D: a NAME -> fe80:: is REFUSED", toLL6.r.ok === false && toLL6.seen.targets.length === 0);
  const toMappedPriv = await run("mp.example:8080", ["::ffff:192.168.1.9"]);
  check("D: a NAME -> IPv4-mapped RFC1918 is allowed (classified as the embedded IPv4)", toMappedPriv.r.ok && toMappedPriv.seen.targets[0].address === "::ffff:192.168.1.9");
  const lh = await run("localhost:9000", ["127.0.0.1", "::1"]);
  check("D: exactly `localhost` -> loopback addresses is allowed", lh.r.ok);
  const lhBad = await run("localhost:9000", ["192.168.1.2"]);
  check("D: `localhost` -> a non-loopback address is refused", lhBad.r.ok === false);
  const lhMixed = await run("localhost:9000", ["127.0.0.1", "192.168.1.2"]);
  check("D: `localhost` -> loopback + private is refused (every address must be loopback)", lhMixed.r.ok === false);
  const nxd = await run("gone.example:8080", new Error("ENOTFOUND"));
  check("D: a lookup failure refuses", nxd.r.ok === false && nxd.seen.targets.length === 0);
  const empty = await run("empty.example:8080", []);
  check("D: an empty answer refuses", empty.r.ok === false && empty.seen.targets.length === 0);
  const refusals = [pubLit, pubName, mixed, toLoop, toMeta, nxd].map((x) => JSON.stringify(x.r));
  check("D: refusals are fixed text — never the host, the resolved address or the secret",
    refusals.every((t) => !t.includes("example") && !t.includes("8.8.8.8") && !t.includes("93.184") && !t.includes("169.254") && !t.includes(SECRET)));
  // The oauth2 row with a tampered flag stays https.
  const oa = db.createConnection({ name: "oa-tamper", host: "oauth.example.com", authScheme: "oauth2", secretBlob: "v1:AAAA:BBBB:CCCC", allowPlainHttp: true });
  const calls = []; let pinned = 0;
  __resetConnectionsRateLimitState();
  const ro = await performAuthenticatedRequest(reqDeps({ fetchImpl: okFetch(calls), pinnedFetchFactory: () => { pinned++; return okFetch([]); } }), [oa.id], GUARD, { connection: oa.id, path: "/x" });
  check("D: a tampered oauth2 flag never switches the scheme (https path, no pinned factory)", pinned === 0 && !calls.some((c) => c.url.startsWith("http://")));
  void ro;
}

// ============ E. the real pinned adapter ============
const listen = (handler) => new Promise((resolve) => { const s = http.createServer(handler); s.listen(0, "127.0.0.1", () => resolve(s)); });
const portOf = (s) => s.address().port;
{
  const hits = [];
  const redirectHits = [];
  const other = await listen((req, res) => { redirectHits.push(req.url); res.end("OTHER"); });
  let mode = "ok";
  const srv = await listen((req, res) => {
    hits.push({ url: req.url, host: req.headers.host, key: req.headers["x-api-key"], connection: req.headers.connection, method: req.method });
    if (mode === "redirect-host") { res.writeHead(302, { Location: `http://127.0.0.1:${portOf(other)}/stolen` }); res.end(); return; }
    if (mode === "redirect-https") { res.writeHead(301, { Location: "https://127.0.0.1:1/x" }); res.end(); return; }
    if (mode === "big") { res.writeHead(200); res.write("x".repeat(5000)); res.end("y".repeat(5000)); return; }
    if (mode === "hang") { return; }
    if (mode === "204") { res.writeHead(204); res.end(); return; }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("hello lan");
  });
  const hostPort = `127.0.0.1:${portOf(srv)}`;
  const enc = (await import("../dist/keys/envelope.js")).encryptSecret;
  const mkReal = () => db.createConnection({ name: `real${Math.random().toString(36).slice(2, 8)}`, host: hostPort, authScheme: "api-key", secretBlob: enc(SECRET), allowPlainHttp: true });
  try {
    // Real end to end through performAuthenticatedRequest with NO seams except the (unused) literal path.
    __resetConnectionsRateLimitState();
    const c = mkReal();
    const r = await performAuthenticatedRequest(reqDeps(), [c.id], GUARD, { connection: c.id, path: "/p?q=1", headers: { Host: "evil.example", "X-Custom": "1" } });
    check("E: a real request to a private literal succeeds end to end", r.ok && r.status === 200 && r.body === "hello lan");
    check("E: the server saw the injected key, the configured Host (a caller Host is dropped), a fresh connection (no keep-alive)",
      hits[0].key === SECRET && hits[0].host === hostPort && hits[0].url === "/p?q=1" && String(hits[0].connection).toLowerCase() === "close");

    // Redirects: never followed, to another host or to https; surfaced as data; exactly one upstream hit.
    mode = "redirect-host"; __resetConnectionsRateLimitState(); const before = hits.length;
    const rr = await performAuthenticatedRequest(reqDeps(), [c.id], GUARD, { connection: c.id, path: "/r" });
    check("E: a redirect to ANOTHER HOST is returned as data, not followed (the other server got nothing, one hit here)",
      rr.ok && rr.status === 302 && rr.location?.includes("/stolen") && redirectHits.length === 0 && hits.length === before + 1);
    mode = "redirect-https"; __resetConnectionsRateLimitState(); const before2 = hits.length;
    const rs = await performAuthenticatedRequest(reqDeps(), [c.id], GUARD, { connection: c.id, path: "/r2" });
    check("E: a redirect to HTTPS is returned as data, not followed (one hit)", rs.ok && rs.status === 301 && hits.length === before2 + 1);

    // A 204 (null-body status) must not throw while building the Response.
    mode = "204"; __resetConnectionsRateLimitState();
    const r204 = await performAuthenticatedRequest(reqDeps(), [c.id], GUARD, { connection: c.id, path: "/n" });
    check("E: a 204 response is handled (null body)", r204.ok && r204.status === 204 && r204.body === "");

    // Byte cap enforced while streaming.
    mode = "big"; __resetConnectionsRateLimitState();
    const rb = await performAuthenticatedRequest(reqDeps(), [c.id], { ...GUARD, maxResponseBytes: 500 }, { connection: c.id, path: "/b" });
    check("E: the streamed body cap still applies through the pinned adapter", rb.ok === false && /exceeded/.test(rb.error));

    // Timeout bounds a hung upstream.
    mode = "hang"; __resetConnectionsRateLimitState();
    const rt = await performAuthenticatedRequest(reqDeps(), [c.id], { ...GUARD, requestTimeoutMs: 300 }, { connection: c.id, path: "/h" });
    check("E: the timeout still bounds a hung upstream", rt.ok === false && /timed out/.test(rt.error));

    // The pin: the URL authority is ignored — the connection goes to the pinned address only.
    mode = "ok"; const n0 = hits.length;
    const pinned = createPinnedHttpFetch({ address: "127.0.0.1", port: portOf(srv), hostHeader: "plex.local:32400" });
    // The URL's authority is a closed loopback port: a adapter that dialled it instead of the pin would refuse.
    let resp = null;
    try { resp = await pinned("http://127.0.0.1:1/elsewhere?z=2", { method: "GET", headers: { "X-API-Key": "k" } }); } catch { /* a mutant that dials the URL */ }
    check("E: the pinned fetch dials the CHECKED address even when the URL names another authority",
      resp?.status === 200 && hits.length === n0 + 1 && hits[n0].url === "/elsewhere?z=2" && hits[n0].host === "plex.local:32400");
    // A POST body round-trips with a computed Content-Length.
    const echoSrv = await listen((req, res) => { const b = []; req.on("data", (d) => b.push(d)); req.on("end", () => { res.end(`${req.headers["content-length"]}:${Buffer.concat(b).toString()}`); }); });
    const post = await createPinnedHttpFetch({ address: "127.0.0.1", port: portOf(echoSrv), hostHeader: "x" })("http://x/p", { method: "POST", body: "héllo" });
    check("E: a POST body is sent with the byte length as Content-Length", (await post.text()) === `${Buffer.byteLength("héllo")}:héllo`);
    echoSrv.closeAllConnections(); await new Promise((res) => echoSrv.close(res));

    // URL-free errors on a refused connection.
    const dead = await listen((q, s) => s.end()); const deadPort = portOf(dead); dead.closeAllConnections(); await new Promise((res) => dead.close(res));
    __resetConnectionsRateLimitState();
    const cd = db.createConnection({ name: `dead${Math.random().toString(36).slice(2, 6)}`, host: `127.0.0.1:${deadPort}`, authScheme: "api-key", secretBlob: enc(SECRET), allowPlainHttp: true });
    const rd = await performAuthenticatedRequest(reqDeps(), [cd.id], GUARD, { connection: cd.id, path: "/x" });
    check("E: a refused connection reports a fixed, URL-free error (code kept, no host/port/secret)",
      rd.ok === false && /^network error/.test(rd.error) && !rd.error.includes("127.0.0.1") && !rd.error.includes(String(deadPort)) && !rd.error.includes(SECRET));
  } finally {
    for (const s of [srv, other]) { s.closeAllConnections(); await new Promise((res) => s.close(res)); }
  }
}

// ============ F. tier gating + no agent path ============
{
  check("F: POST/PATCH/DELETE /api/connections* are Tier 0 (absent from every remote allowlist)",
    [["POST", "/api/connections"], ["PATCH", "/api/connections/:id"], ["DELETE", "/api/connections/:id"], ["GET", "/api/connections"], ["PUT", "/api/connections/:id/ssh"]]
      .every(([m, p]) => routeTier(m, p) === 0));

  const viaRest = await app.inject({ method: "POST", url: "/api/connections", payload: { name: "rest-lan", host: "192.168.1.20:32400", authScheme: "api-key", secret: SECRET, allowPlainHttp: true } });
  check("F: the loopback REST create accepts the flag and echoes no secret", viaRest.statusCode === 201 && viaRest.json().allowPlainHttp === true && !viaRest.body.includes(SECRET));
  const viaRestBad = await app.inject({ method: "POST", url: "/api/connections", payload: { name: "rest-pub", host: "8.8.8.8:8080", authScheme: "api-key", secret: SECRET, allowPlainHttp: true } });
  check("F: the loopback REST create refuses a public literal with the flag (400)", viaRestBad.statusCode === 400);
  const viaPatch = await app.inject({ method: "PATCH", url: `/api/connections/${viaRest.json().id}`, payload: { allowPlainHttp: false } });
  check("F: the loopback REST PATCH flips it off and audits the field NAME only", viaPatch.statusCode === 200 && !("allowPlainHttp" in viaPatch.json()) && db.listEventsSince(0, 5000).some((e) => e.kind === "connection_updated" && e.detail.fields.includes("allowPlainHttp")));
  const listed = (await app.inject({ method: "GET", url: "/api/connections" })).json();
  check("F: the list carries the flag for an opted-in row and never a secret", listed.some((c) => c.allowPlainHttp === true) && !JSON.stringify(listed).includes(SECRET));

  // Remote peer with the trust-tier hook live: both writers are refused outright, the flag never lands.
  const dbOn = new Db(path.join(tmpHome, "ph-on.db"));
  dbOn.setPlatformConfig({ remoteAccess: { enabled: true, bindHost: "0.0.0.0" } });
  const appOn = await buildServer({
    db: dbOn, pty: {}, sessions: {}, mcp: {}, orchMcp: {}, platformMcp: {}, auditMcp: {}, userAuditMcp: {}, setupMcp: {}, runMcp: {}, control: {}, usageStatus: {},
    requestShutdown: () => {}, verifyGatewayToken: (t) => t === "tok",
  });
  try {
    const body = { name: "remote-lan", host: "192.168.1.20:32400", authScheme: "api-key", secret: SECRET, allowPlainHttp: true };
    const remoteNoTok = await appOn.inject({ method: "POST", url: "/api/connections", remoteAddress: "203.0.113.5", payload: body });
    const remoteTok = await appOn.inject({ method: "POST", url: "/api/connections", remoteAddress: "203.0.113.5", headers: { authorization: "Bearer tok" }, payload: body });
    check("F: a REMOTE peer cannot create a connection (with or without a valid gateway token) — 403, nothing stored", remoteNoTok.statusCode === 403 && remoteTok.statusCode === 403 && dbOn.listConnections().length === 0);
    const seeded = createConnection(dbOn, { name: "seed", host: "192.168.1.20:32400", authScheme: "api-key", secret: SECRET });
    const remotePatch = await appOn.inject({ method: "PATCH", url: `/api/connections/${seeded.id}`, remoteAddress: "203.0.113.5", headers: { authorization: "Bearer tok" }, payload: { allowPlainHttp: true } });
    check("F: a REMOTE peer cannot flip the flag on an existing connection — 403, flag still off", remotePatch.statusCode === 403 && dbOn.getConnection(seeded.id).allowPlainHttp === false);
    const loopPatch = await appOn.inject({ method: "PATCH", url: `/api/connections/${seeded.id}`, payload: { allowPlainHttp: true } });
    check("F: (control) the SAME patch from loopback succeeds", loopPatch.statusCode === 200 && dbOn.getConnection(seeded.id).allowPlainHttp === true);
  } finally { await appOn.close(); dbOn.close(); }

  // No agent MCP path: no router source mentions the flag, and the scan can see it where it exists.
  const srcDir = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "src");
  const mcpFiles = fs.readdirSync(path.join(srcDir, "mcp")).filter((f) => f.endsWith(".ts"));
  const mentions = (rel) => /allowPlainHttp|allow_plain_http/.test(fs.readFileSync(path.join(srcDir, rel), "utf8"));
  check("F: (negative control) the scan pattern DOES match the store that owns the flag", mentions("connections/store.ts"));
  check(`F: no MCP router source (${mcpFiles.length} files) mentions the flag`, mcpFiles.length > 0 && mcpFiles.every((f) => !mentions(path.join("mcp", f))));
}

// ============ G. review round: daemon-hairpin guard, per-address fallback, default lookup, octal octets ============
{
  const { resolveLanTarget, daemonReservedPorts, DAEMON_SELF_TARGET_REFUSED } = await import("../dist/connections/lanHttp.js");
  check("G: daemonReservedPorts() reads the live listen PORT (LOOM_PORT)", daemonReservedPorts().includes(DAEMON_PORT));
  const proxyDb = { getPlatformConfig: () => ({ remoteAccess: { proxyPort: PROXY_PORT } }) };
  check("G: daemonReservedPorts(db) adds remoteAccess.proxyPort when set (and ignores an unset one)",
    daemonReservedPorts(proxyDb).includes(PROXY_PORT) && daemonReservedPorts(proxyDb).includes(DAEMON_PORT) && daemonReservedPorts({ getPlatformConfig: () => ({}) }).length === 1);

  const selfHosts = [`127.0.0.1:${DAEMON_PORT}`, `localhost:${DAEMON_PORT}`, `[::1]:${DAEMON_PORT}`, `[::ffff:7f00:1]:${DAEMON_PORT}`];
  for (const h of selfHosts) {
    const save = validateConnectionHost(h, "http");
    check(`G: SAVE refuses ${h} (the daemon's own port) with fixed text that never echoes the host`, save.ok === false && save.error === DAEMON_SELF_TARGET_REFUSED && !save.error.includes(String(DAEMON_PORT)));
    const lan = await resolveLanTarget(h, { timeoutMs: 2000, lookupImpl: async () => ["127.0.0.1"] });
    check(`G: REQUEST refuses ${h} (the daemon's own port)`, lan.ok === false && lan.error === DAEMON_SELF_TARGET_REFUSED);
    // Mutant control: with the port check dropped (an empty reserved set) the very same target is allowed — so the
    // assertion above is the check and not an accident of address classification.
    const dropped = await resolveLanTarget(h, { timeoutMs: 2000, lookupImpl: async () => ["127.0.0.1"], reservedPorts: [] });
    check(`G: (mutant control) with the port check dropped ${h} is allowed`, dropped.ok === true);
  }
  // The raw dotted-mapped form (not the canonical save form) is still caught at request time.
  const mappedDotted = await resolveLanTarget(`[::ffff:127.0.0.1]:${DAEMON_PORT}`, { timeoutMs: 2000 });
  check("G: REQUEST refuses ::ffff:127.0.0.1 written dotted, on the daemon port", mappedDotted.ok === false && mappedDotted.error === DAEMON_SELF_TARGET_REFUSED);
  // proxyPort via the real request path (db-sourced), literal and a stub-resolved `localhost`.
  __resetConnectionsRateLimitState();
  const px = db.createConnection({ name: "proxyself", host: `127.0.0.1:${PROXY_PORT}`, authScheme: "api-key", secretBlob: (await import("../dist/keys/envelope.js")).encryptSecret(SECRET), allowPlainHttp: true });
  let pxFactory = 0;
  const pxDb = Object.assign(Object.create(db), { getPlatformConfig: () => ({ remoteAccess: { proxyPort: PROXY_PORT } }) });
  const pxRes = await performAuthenticatedRequest(reqDeps({ db: pxDb, pinnedFetchFactory: () => { pxFactory++; return async () => new Response("x"); } }), [px.id], GUARD, { connection: px.id, path: "/api/projects" });
  check("G: REQUEST refuses the configured remoteAccess.proxyPort end to end (no pinned fetch built, no secret touched)", pxRes.ok === false && pxFactory === 0 && !JSON.stringify(pxRes).includes(SECRET));
  const proxyAtSave = validateConnectionHost(`127.0.0.1:${PROXY_PORT}`, "http", daemonReservedPorts(proxyDb));
  check("G: SAVE refuses the proxyPort too when the config is supplied", proxyAtSave.ok === false);
  // A DIFFERENT loopback port stays allowed (both at save and at request time) — the guard is port-specific.
  const otherPort = DAEMON_PORT + 100;
  check("G: SAVE allows a different loopback port", validateConnectionHost(`127.0.0.1:${otherPort}`, "http").ok === true && validateConnectionHost(`localhost:${otherPort}`, "http").ok === true);
  const okLan = await resolveLanTarget(`127.0.0.1:${otherPort}`, { timeoutMs: 2000 });
  check("G: REQUEST allows a different loopback port", okLan.ok === true);
  check("G: a PRIVATE host on the daemon port is not a hairpin (only loopback-class is refused)", (await resolveLanTarget(`192.168.1.9:${DAEMON_PORT}`, { timeoutMs: 2000 })).ok === true);

  // --- per-address fallback: only CHECKED addresses, in order, only on a connect failure ---
  const live = await listen((req, res) => res.end("second ok"));
  const dead = await listen((req, res) => res.end("never"));
  const deadPort = portOf(dead);
  await new Promise((r) => dead.close(r));
  const dialed = [];
  const map = { "10.0.0.1": deadPort, "10.0.0.2": portOf(live) };
  const seam = { request: (opts, cb) => { dialed.push(opts.host); if (!(opts.host in map)) throw new Error("dialled an address outside the checked set"); return http.request({ ...opts, host: "127.0.0.1", port: map[opts.host] }, cb); } };
  const fb = createPinnedHttpFetch({ address: "10.0.0.1", addresses: ["10.0.0.1", "10.0.0.2"], port: 1, hostHeader: "plex.local" }, seam);
  const fbRes = await fb("http://plex.local/x");
  check("G: the first checked address refuses -> the request lands on the second", fbRes.status === 200 && (await fbRes.text()) === "second ok" && dialed.join() === "10.0.0.1,10.0.0.2");
  dialed.length = 0;
  const allDead = createPinnedHttpFetch({ address: "10.0.0.1", addresses: ["10.0.0.1", "10.0.0.1"], port: 1, hostHeader: "plex.local" }, seam);
  const allErr = await allDead("http://plex.local/x").then(() => null, (e) => e);
  check("G: every checked address refusing -> a URL-free ECONNREFUSED, and nothing outside the set was dialled", allErr && allErr.code === "ECONNREFUSED" && allErr.message === "network error" && dialed.length === 2 && dialed.every((a) => a === "10.0.0.1"));
  const resolved = await resolveLanTarget("plex.local:32400", { timeoutMs: 2000, lookupImpl: async () => ["192.168.1.7", "192.168.1.8"] });
  check("G: resolveLanTarget hands the pinned fetch the WHOLE checked set, in lookup order", resolved.ok && resolved.target.addresses.join() === "192.168.1.7,192.168.1.8" && resolved.target.address === "192.168.1.7");
  await new Promise((r) => live.close(r));

  // --- the DEFAULT lookup (no lookupImpl): `localhost` resolves through the real resolver, loopback only ---
  const freePortSrv = await listen(() => {});
  const freePort = portOf(freePortSrv);
  await new Promise((r) => freePortSrv.close(r));
  const dflt = await resolveLanTarget(`localhost:${freePort}`, { timeoutMs: 5000 });
  check("G: the default lookup resolves localhost to loopback addresses only", dflt.ok === true && dflt.target.addresses.length > 0 && dflt.target.addresses.every((a) => classifyAddress(a) === "loopback"));

  // --- leading-zero octets are never accepted ---
  for (const bad of ["010.0.0.1", "10.0.0.01", "192.168.01.5", "192.168.1.007", "00.0.0.0"]) check(`G: classifyAddress(${JSON.stringify(bad)}) is "other" (leading zero)`, classifyAddress(bad) === "other");
  check("G: (control) the same shapes without a leading zero still classify", classifyAddress("10.0.0.1") === "private" && classifyAddress("192.168.1.7") === "private" && classifyAddress("10.0.0.0") === "private");
}

await app.close();
db.close();
await finishAndExit(failures);
