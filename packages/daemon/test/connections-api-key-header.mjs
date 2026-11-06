import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 0683ac4d — an api-key connection may name the request header that carries its secret (Plex: X-Plex-Token).
// HUMAN-only (loopback REST + Settings), never an MCP field. Hermetic: temp LOOM_HOME, real Db, real envelope key,
// the only sockets are loopback servers this file opens.
//   A. validateApiKeyHeaderName: RFC 7230 token, length cap, every forbidden name (case-insensitive) + Proxy-*.
//   B. store: default unset (metadata has no key); create/PATCH accept a valid name; invalid/forbidden refused at both;
//      api-key only; null/blank clears; swapping away from api-key drops it; oauth2 rows refuse it.
//   C. request over https (injected fetch): the configured header carries the secret; the default is X-API-Key.
//   D. request over the REAL pinned http adapter: the configured header survives to the wire.
//   E. redaction: the secret never appears in a result, error, location or audit event.
//   F. loopback REST create/PATCH; a remote peer gets 403 and nothing lands.
//   G. no MCP surface mentions the field (source scan with a positive control).
// Run: 1) build (turbo builds shared first), 2) node test/connections-api-key-header.mjs
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = mkdtempManaged("loom-akh-");
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_PORT = "47321";
const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { validateApiKeyHeaderName, apiKeyHeaderFor, API_KEY_HEADER_MAX } = await import("../dist/connections/apiKeyHeader.js");
const { createConnection, updateConnection, getConnectionMetadata } = await import("../dist/connections/store.js");
const { performAuthenticatedRequest, __resetConnectionsRateLimitState } = await import("../dist/connections/request.js");
const { encryptSecret } = await import("../dist/keys/envelope.js");

const SECRET = "plex-DO-NOT-LEAK-4e2b81";
const GUARD = { requestTimeoutMs: 5000, maxResponseBytes: 5000, rateLimitMax: 1000, rateLimitWindowMs: 60000 };

// ============ A. validator ============
{
  for (const ok of ["X-Plex-Token", "x-api-key", "Api_Key", "X.Token", "A", "token!#$%&'*+^`|~1", "a".repeat(API_KEY_HEADER_MAX)]) {
    check(`A: ${JSON.stringify(ok.slice(0, 20))} is accepted`, validateApiKeyHeaderName(ok).ok === true);
  }
  check("A: the value is trimmed", validateApiKeyHeaderName("  X-Plex-Token  ").value === "X-Plex-Token");
  const forbidden = ["Host", "Content-Length", "Transfer-Encoding", "Connection", "Upgrade", "TE", "Trailer", "Keep-Alive", "Cookie", "Authorization", "Proxy-Authorization", "Proxy-Connection", "Proxy-X",
    "Content-Type", "Content-Encoding", "Content-Range", "User-Agent", "Referer", "Forwarded", "Via", "X-Real-IP", "X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Anything",
    "Origin", "Expect", "Accept", "Accept-Encoding", "Accept-Anything", "Range", "If-Match", "If-None-Match", "If-Modified-Since", "If-Anything", "Cache-Control", "Pragma"];
  for (const f of forbidden) {
    for (const v of [f, f.toUpperCase(), f.toLowerCase()]) {
      check(`A: forbidden ${v} is refused`, validateApiKeyHeaderName(v).ok === false);
    }
  }
  for (const bad of ["", "   ", "X Plex", "X:Plex", "X-Plex\r\nX-Evil: 1", "X-\nPlex", "Ünï", "a(b)", "a/b", "a,b", "a;b", "a=b", "a@b", "\"q\"", "a".repeat(API_KEY_HEADER_MAX + 1), 5, null, undefined, {}, ["X"]]) {
    check(`A: invalid ${JSON.stringify(bad)?.slice(0, 24)} is refused`, validateApiKeyHeaderName(bad).ok === false);
  }
  check("A: a near-miss name that merely CONTAINS a forbidden word is accepted", ["X-Host", "Hostname", "X-Cookie-Token", "Proxy", "Xproxy-Token", "Connection-Id", "TEx", "PRIVATE-TOKEN", "Ocp-Apim-Subscription-Key", "X-Accept", "Acceptx", "Ifx", "X-Forwarded", "Content", "X-Content-Type"].every((n) => validateApiKeyHeaderName(n).ok));
  check("A: the refusal text never echoes the submitted name", !validateApiKeyHeaderName("X-Secret-Name Bad").error.includes("Secret-Name") && !validateApiKeyHeaderName("Cookie").error.includes("'Cookie'"));
  check("A: apiKeyHeaderFor defaults to X-API-Key", apiKeyHeaderFor(null) === "X-API-Key" && apiKeyHeaderFor(undefined) === "X-API-Key" && apiKeyHeaderFor("") === "X-API-Key" && apiKeyHeaderFor("X-Plex-Token") === "X-Plex-Token");
}

// ============ B. store ============
const db = new Db(path.join(tmpHome, "akh.db"));
const mk = (over) => createConnection(db, { name: `c${Math.random().toString(36).slice(2, 8)}`, host: "api.example.com", authScheme: "api-key", secret: SECRET, ...over });
const throws = (fn) => { try { fn(); return false; } catch { return true; } };
{
  const plain = mk({});
  check("B: default is unset (metadata has no apiKeyHeader key; column NULL)", !("apiKeyHeader" in plain) && db.getConnection(plain.id).apiKeyHeader === null);
  const named = mk({ apiKeyHeader: "X-Plex-Token" });
  check("B: create stores and surfaces a valid name", named.apiKeyHeader === "X-Plex-Token" && db.getConnection(named.id).apiKeyHeader === "X-Plex-Token");
  check("B: a blank / null header at create means unset", !("apiKeyHeader" in mk({ apiKeyHeader: "  " })) && !("apiKeyHeader" in mk({ apiKeyHeader: null })));
  check("B: create refuses a forbidden name", throws(() => mk({ apiKeyHeader: "Authorization" })) && throws(() => mk({ apiKeyHeader: "cOOkie" })) && throws(() => mk({ apiKeyHeader: "Proxy-Authorization" })));
  check("B: create refuses a non-token / over-long / non-string name", throws(() => mk({ apiKeyHeader: "a b" })) && throws(() => mk({ apiKeyHeader: "a".repeat(API_KEY_HEADER_MAX + 1) })) && throws(() => mk({ apiKeyHeader: 5 })));
  check("B: create refuses the field on a bearer connection", throws(() => mk({ authScheme: "bearer", apiKeyHeader: "X-Plex-Token" })));
  check("B: a bearer connection without it is unchanged", !("apiKeyHeader" in mk({ authScheme: "bearer" })));

  const e = mk({});
  const set = updateConnection(db, e.id, { apiKeyHeader: "X-Plex-Token" });
  check("B: PATCH sets it and names the field (never the value) in changedFields", set.metadata.apiKeyHeader === "X-Plex-Token" && set.changedFields.length === 1 && set.changedFields[0] === "apiKeyHeader");
  check("B: a no-op resend changes nothing", updateConnection(db, e.id, { apiKeyHeader: "X-Plex-Token" }).changedFields.length === 0);
  check("B: PATCH refuses a forbidden / invalid name and keeps the stored one",
    throws(() => updateConnection(db, e.id, { apiKeyHeader: "Host" })) && throws(() => updateConnection(db, e.id, { apiKeyHeader: "Transfer-Encoding" })) &&
    throws(() => updateConnection(db, e.id, { apiKeyHeader: "bad name" })) && throws(() => updateConnection(db, e.id, { apiKeyHeader: 7 })) &&
    db.getConnection(e.id).apiKeyHeader === "X-Plex-Token");
  const cleared = updateConnection(db, e.id, { apiKeyHeader: null });
  check("B: null clears it back to the default", !("apiKeyHeader" in cleared.metadata) && db.getConnection(e.id).apiKeyHeader === null && cleared.changedFields.includes("apiKeyHeader"));
  updateConnection(db, e.id, { apiKeyHeader: "X-Plex-Token" });
  check("B: a blank string clears it too", db.getConnection(updateConnection(db, e.id, { apiKeyHeader: "  " }).metadata.id).apiKeyHeader === null);
  updateConnection(db, e.id, { apiKeyHeader: "X-Plex-Token" });
  const toBearer = updateConnection(db, e.id, { authScheme: "bearer" });
  check("B: swapping api-key -> bearer drops the stored name", db.getConnection(e.id).apiKeyHeader === null && !("apiKeyHeader" in toBearer.metadata));
  check("B: PATCH refuses setting it on a bearer row", throws(() => updateConnection(db, e.id, { apiKeyHeader: "X-Plex-Token" })));
  const both = updateConnection(db, e.id, { authScheme: "api-key", apiKeyHeader: "X-Plex-Token" });
  check("B: swapping back to api-key and naming the header in one PATCH works", both.metadata.apiKeyHeader === "X-Plex-Token");
  const oa = db.createConnection({ name: "oa", host: "oauth.example.com", authScheme: "oauth2", secretBlob: "v1:AAAA:BBBB:CCCC" });
  check("B: an oauth2 row refuses the field on edit", throws(() => updateConnection(db, oa.id, { apiKeyHeader: "X-Plex-Token" })));
  const forced = db.createConnection({ name: "oa2", host: "oauth2.example.com", authScheme: "oauth2", secretBlob: "v1:AAAA:BBBB:CCCC", apiKeyHeader: "X-Tampered" });
  check("B: even a tampered oauth2 row's header is never surfaced", !("apiKeyHeader" in updateConnection(db, forced.id, { name: "oa2b" }).metadata));
}

// ============ C. request over https (injected fetch) ============
const reqDeps = (over = {}) => ({ db, ...over });
const recordFetch = (calls, respond) => async (url, init) => { calls.push({ url: String(url), init }); return respond ? respond(init) : new Response("ok", { status: 200 }); };
{
  __resetConnectionsRateLimitState();
  const named = mk({ apiKeyHeader: "X-Plex-Token" });
  const calls = [];
  const r = await performAuthenticatedRequest(reqDeps({ fetchImpl: recordFetch(calls) }), [named.id], GUARD, { connection: named.id, path: "/x", headers: { "X-Custom": "1" } });
  const h = calls[0].init.headers;
  check("C: https — the configured header carries the secret", r.ok && h["X-Plex-Token"] === SECRET);
  check("C: https — X-API-Key is NOT also sent, and other caller headers survive", !("X-API-Key" in h) && h["X-Custom"] === "1");

  __resetConnectionsRateLimitState();
  const def = mk({});
  const callsD = [];
  await performAuthenticatedRequest(reqDeps({ fetchImpl: recordFetch(callsD) }), [def.id], GUARD, { connection: def.id, path: "/x" });
  check("C: the default is unchanged — exactly { X-API-Key } as the only credential header", JSON.stringify(callsD[0].init.headers) === JSON.stringify({ "X-API-Key": SECRET }));

  __resetConnectionsRateLimitState();
  const callsC = [];
  await performAuthenticatedRequest(reqDeps({ fetchImpl: recordFetch(callsC) }), [named.id], GUARD, { connection: named.id, path: "/x", headers: { "x-plex-token": "caller-supplied" } });
  const keys = Object.keys(callsC[0].init.headers);
  check("C: a caller header differing only by case cannot ride beside the credential (Loom's wins)", keys.filter((k) => k.toLowerCase() === "x-plex-token").length === 1 && callsC[0].init.headers["X-Plex-Token"] === SECRET);

  __resetConnectionsRateLimitState();
  const bearer = mk({ authScheme: "bearer" });
  const callsB = [];
  await performAuthenticatedRequest(reqDeps({ fetchImpl: recordFetch(callsB) }), [bearer.id], GUARD, { connection: bearer.id, path: "/x" });
  check("C: bearer is unchanged (Authorization: Bearer)", callsB[0].init.headers.Authorization === `Bearer ${SECRET}` && !("X-API-Key" in callsB[0].init.headers));

  // The default header drops a case-variant caller header too (not only when apiKeyHeader is set).
  __resetConnectionsRateLimitState();
  const callsX = [];
  await performAuthenticatedRequest(reqDeps({ fetchImpl: recordFetch(callsX) }), [def.id], GUARD, { connection: def.id, path: "/x", headers: { "x-api-key": "caller-supplied" } });
  const kx = Object.keys(callsX[0].init.headers);
  check("C: default X-API-Key — a caller `x-api-key` is dropped, Loom's wins", kx.length === 1 && kx[0] === "X-API-Key" && callsX[0].init.headers["X-API-Key"] === SECRET);

  // A stored value that today's validator would refuse (a tampered row, or one written before a name was
  // refused) must FAIL CLOSED at request time: the db layer is below the validator, so write forbidden names
  // straight in and prove nothing is fetched and the secret is never sent.
  __resetConnectionsRateLimitState();
  const tampered = db.createConnection({ name: "tamper", host: "api.example.com", authScheme: "api-key", secretBlob: encryptSecret(SECRET), apiKeyHeader: "X-Plex-Token" });
  const callsT = [];
  const rT = await performAuthenticatedRequest(reqDeps({ fetchImpl: recordFetch(callsT) }), [tampered.id], GUARD, { connection: tampered.id, path: "/x" });
  check("C: (control) a db-layer row with a valid name works the same way", rT.ok && callsT[0].init.headers["X-Plex-Token"] === SECRET);
  for (const bad of ["Host", "User-Agent"]) {
    __resetConnectionsRateLimitState();
    const t = db.createConnection({ name: `tamper-${bad}`, host: "api.example.com", authScheme: "api-key", secretBlob: encryptSecret(SECRET), apiKeyHeader: bad });
    const calls = [];
    const rr = await performAuthenticatedRequest(reqDeps({ fetchImpl: recordFetch(calls) }), [t.id], GUARD, { connection: t.id, path: "/x" });
    check(`C: a stored forbidden header (${bad}) fails closed — refused, no fetch, secret never sent`, rr.ok === false && calls.length === 0 && !JSON.stringify(rr).includes(SECRET) && !JSON.stringify(rr).includes(bad));
    const md = getConnectionMetadata(db, t.id);
    check(`C: a stored forbidden header (${bad}) is flagged on the metadata with fixed text`, md.invalidApiKeyHeader === true && typeof md.invalidApiKeyHeaderReason === "string" && !md.invalidApiKeyHeaderReason.includes(bad));
  }
  check("C: a valid stored header is not flagged", getConnectionMetadata(db, tampered.id).invalidApiKeyHeader === undefined);
}

// ============ D. request over the REAL pinned http adapter ============
const listen = (handler) => new Promise((resolve) => { const s = http.createServer(handler); s.listen(0, "127.0.0.1", () => resolve(s)); });
{
  const hits = [];
  const srv = await listen((req, res) => { hits.push(req.headers); res.writeHead(200, { "x-echo": String(req.headers["x-plex-token"] ?? req.headers["x-api-key"] ?? "") }); res.end("hello"); });
  const hostPort = `127.0.0.1:${srv.address().port}`;
  try {
    __resetConnectionsRateLimitState();
    const plex = db.createConnection({ name: "plexreal", host: hostPort, authScheme: "api-key", secretBlob: encryptSecret(SECRET), allowPlainHttp: true, apiKeyHeader: "X-Plex-Token" });
    const r = await performAuthenticatedRequest(reqDeps(), [plex.id], GUARD, { connection: plex.id, path: "/identity", headers: { Accept: "application/json" } });
    check("D: pinned http — the server received the secret in the configured header", r.ok && hits[0]["x-plex-token"] === SECRET);
    check("D: pinned http — no X-API-Key on the wire; Host is the configured host; other caller headers survive", !("x-api-key" in hits[0]) && hits[0].host === hostPort && hits[0].accept === "application/json");
    check("D: pinned http — the echoed secret is redacted from the response headers", !JSON.stringify(r).includes(SECRET));

    __resetConnectionsRateLimitState();
    const def = db.createConnection({ name: "defreal", host: hostPort, authScheme: "api-key", secretBlob: encryptSecret(SECRET), allowPlainHttp: true });
    const n0 = hits.length;
    const rd = await performAuthenticatedRequest(reqDeps(), [def.id], GUARD, { connection: def.id, path: "/identity" });
    check("D: pinned http default is unchanged (X-API-Key on the wire, no X-Plex-Token)", rd.ok && hits[n0]["x-api-key"] === SECRET && !("x-plex-token" in hits[n0]));
  } finally { srv.closeAllConnections(); await new Promise((res) => srv.close(res)); }
}

// ============ E. redaction ============
{
  const loc = http.createServer((req, res) => { res.writeHead(302, { Location: `http://192.168.1.2/next?tok=${req.headers["x-plex-token"]}`, "x-reflect": String(req.headers["x-plex-token"]) }); res.end(`body:${req.headers["x-plex-token"]}`); });
  await new Promise((r) => loc.listen(0, "127.0.0.1", r));
  try {
    __resetConnectionsRateLimitState();
    const c = db.createConnection({ name: "redact", host: `127.0.0.1:${loc.address().port}`, authScheme: "api-key", secretBlob: encryptSecret(SECRET), allowPlainHttp: true, apiKeyHeader: "X-Plex-Token" });
    const r = await performAuthenticatedRequest(reqDeps(), [c.id], GUARD, { connection: c.id, path: "/x" });
    check("E: body, headers and location are redacted when the secret rides a custom header", r.ok && r.status === 302 && r.body.includes("[REDACTED") && !JSON.stringify(r).includes(SECRET) && !!r.location);
  } finally { loc.closeAllConnections(); await new Promise((res) => loc.close(res)); }

  __resetConnectionsRateLimitState();
  const dead = await listen((q, s) => s.end()); const deadPort = dead.address().port; dead.closeAllConnections(); await new Promise((res) => dead.close(res));
  const cd = db.createConnection({ name: "deadc", host: `127.0.0.1:${deadPort}`, authScheme: "api-key", secretBlob: encryptSecret(SECRET), allowPlainHttp: true, apiKeyHeader: "X-Plex-Token" });
  const rd = await performAuthenticatedRequest(reqDeps(), [cd.id], GUARD, { connection: cd.id, path: "/x" });
  check("E: a failed dial's error carries neither the secret nor the header name", rd.ok === false && !rd.error.includes(SECRET) && !rd.error.includes("X-Plex-Token"));
}

// ============ F. REST + tier ============
const stub = {};
const app = await buildServer({
  db, pty: { enqueueStdin: () => ({ delivered: true }) }, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub,
  userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub,
});
{
  const base = { host: "192.168.178.136:32400", authScheme: "api-key", secret: SECRET, allowPlainHttp: true };
  const ok = await app.inject({ method: "POST", url: "/api/connections", payload: { name: "rest-plex", ...base, apiKeyHeader: "X-Plex-Token" } });
  check("F: loopback REST create accepts the header and echoes no secret", ok.statusCode === 201 && ok.json().apiKeyHeader === "X-Plex-Token" && !ok.body.includes(SECRET));
  const bad = await app.inject({ method: "POST", url: "/api/connections", payload: { name: "rest-bad", ...base, apiKeyHeader: "Authorization" } });
  check("F: loopback REST create refuses a forbidden header (400) and stores nothing", bad.statusCode === 400 && !db.listConnections().some((c) => c.name === "rest-bad"));
  const bad2 = await app.inject({ method: "POST", url: "/api/connections", payload: { name: "rest-bad2", ...base, apiKeyHeader: "bad header" } });
  check("F: loopback REST create refuses a non-token header (400)", bad2.statusCode === 400);
  const id = ok.json().id;
  const patchBad = await app.inject({ method: "PATCH", url: `/api/connections/${id}`, payload: { apiKeyHeader: "Cookie" } });
  check("F: loopback REST PATCH refuses a forbidden header (400); the stored one is kept", patchBad.statusCode === 400 && db.getConnection(id).apiKeyHeader === "X-Plex-Token");
  const patchOk = await app.inject({ method: "PATCH", url: `/api/connections/${id}`, payload: { apiKeyHeader: "X-Other-Token" } });
  check("F: loopback REST PATCH changes it and audits the field NAME only", patchOk.statusCode === 200 && patchOk.json().apiKeyHeader === "X-Other-Token" &&
    db.listEventsSince(0, 5000).some((e) => e.kind === "connection_updated" && e.detail.fields.includes("apiKeyHeader")) &&
    !JSON.stringify(db.listEventsSince(0, 5000)).includes("X-Other-Token") && !JSON.stringify(db.listEventsSince(0, 5000)).includes(SECRET));
  const patchClear = await app.inject({ method: "PATCH", url: `/api/connections/${id}`, payload: { apiKeyHeader: null } });
  check("F: loopback REST PATCH null clears it", patchClear.statusCode === 200 && !("apiKeyHeader" in patchClear.json()));
  const listed = (await app.inject({ method: "GET", url: "/api/connections" })).json();
  check("F: the list never carries a secret", !JSON.stringify(listed).includes(SECRET));

  const dbOn = new Db(path.join(tmpHome, "akh-on.db"));
  dbOn.setPlatformConfig({ remoteAccess: { enabled: true, bindHost: "0.0.0.0" } });
  const appOn = await buildServer({
    db: dbOn, pty: {}, sessions: {}, mcp: {}, orchMcp: {}, platformMcp: {}, auditMcp: {}, userAuditMcp: {}, setupMcp: {}, runMcp: {}, control: {}, usageStatus: {},
    requestShutdown: () => {}, verifyGatewayToken: (t) => t === "tok",
  });
  try {
    const body = { name: "remote-akh", host: "api.example.com", authScheme: "api-key", secret: SECRET, apiKeyHeader: "X-Plex-Token" };
    const noTok = await appOn.inject({ method: "POST", url: "/api/connections", remoteAddress: "203.0.113.5", payload: body });
    const tok = await appOn.inject({ method: "POST", url: "/api/connections", remoteAddress: "203.0.113.5", headers: { authorization: "Bearer tok" }, payload: body });
    check("F: a REMOTE peer cannot create a connection with the header — 403 (with or without a token), nothing stored", noTok.statusCode === 403 && tok.statusCode === 403 && dbOn.listConnections().length === 0);
    const seeded = createConnection(dbOn, { name: "seed", host: "api.example.com", authScheme: "api-key", secret: SECRET });
    const rp = await appOn.inject({ method: "PATCH", url: `/api/connections/${seeded.id}`, remoteAddress: "203.0.113.5", headers: { authorization: "Bearer tok" }, payload: { apiKeyHeader: "X-Plex-Token" } });
    check("F: a REMOTE peer cannot set the header on an existing connection — 403, still unset", rp.statusCode === 403 && dbOn.getConnection(seeded.id).apiKeyHeader === null);
    const lp = await appOn.inject({ method: "PATCH", url: `/api/connections/${seeded.id}`, payload: { apiKeyHeader: "X-Plex-Token" } });
    check("F: (control) the SAME patch from loopback succeeds", lp.statusCode === 200 && dbOn.getConnection(seeded.id).apiKeyHeader === "X-Plex-Token");
  } finally { await appOn.close(); dbOn.close(); }
}

// ============ G. no MCP surface ============
{
  const srcDir = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "src");
  const mcpFiles = fs.readdirSync(path.join(srcDir, "mcp")).filter((f) => f.endsWith(".ts"));
  const re = /api.?key.?header|apiKeyHeader|api_key_header/i;
  const mentions = (rel) => re.test(fs.readFileSync(path.join(srcDir, rel), "utf8"));
  check("G: (positive control) the scan pattern DOES match the store and the row type that own the field", mentions("connections/store.ts") && mentions("db.ts"));
  check("G: (positive control) a synthetic mcp-shaped snippet is caught", re.test("inputSchema: { apiKeyHeader: z.string() }") && re.test("api_key_header") && re.test("ApiKey-Header"));
  check(`G: no MCP router source (${mcpFiles.length} files) mentions an api-key-header field`, mcpFiles.length > 0 && mcpFiles.every((f) => !mentions(path.join("mcp", f))));
}

await app.close();
db.close();
await finishAndExit(failures);
