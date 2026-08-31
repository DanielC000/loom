import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 9ccedbee (SECURITY) — the loopback human-only-write guard: any co-resident process (an agent
// session's own Bash tool included) could `curl` a REST writer, or open a `/ws/term` socket, directly and
// bypass the MCP tool surface entirely, because the daemon's default (no remoteAccess) posture trusted
// loopback UNCONDITIONALLY — no per-route auth at all beyond the CSRF/Host hook, which a same-host curl
// trivially satisfies. Driven via buildServer + app.inject/injectWS (HERMETIC + CLAUDE-FREE + NETWORK-
// FREE, like gateway-hardening.mjs and trust-tier.mjs).
//
// v2 (Code Review Critical): v1 only gated routeTier===0 writes, leaving every Tier-1 route open —
// exactly where the human's AUTHORITY lives (POST /api/sessions/:id/input feeds `ownerText`, the
// anti-fabrication invariant's whole premise is "this comes from the SAME loopback-only, human-
// authenticated composer"; POST /api/questions/:id/answer is a direct human decision; /ws/term's
// `{type:"stdin"}` writes raw bytes into ANY session's pty). v2 gates EVERY non-GET `/api/*` route PLUS
// the `/ws/term` upgrade — no Tier distinction. Covers:
//   (A) BACKWARD COMPAT: `loopbackSecret` omitted from GatewayDeps (every existing partial-stub test) →
//       the guard is a no-op for BOTH the REST write AND the /ws/term upgrade — unchanged.
//   (B) THE BYPASS, closed: with `loopbackSecret` wired, a Tier-0 write (PATCH /api/platform/config) with
//       NO Authorization header now 401s.
//   (C) a WRONG bearer value also 401s.
//   (D) POSITIVE CONTROL: the CORRECT bearer value succeeds.
//   (E) GET reads are UNAFFECTED (scope: this guard is WRITES + the /ws/term socket only).
//   (F) THE v1 GAP, closed: a Tier-1 write (POST /api/questions/:id/answer — the exact class the review
//       flagged as still-open) now ALSO 401s with no credential, and reaches its real handler (404 for a
//       nonexistent id) once the correct secret is presented — proving the guard, not routing, was v1's
//       actual failure.
//   (F2) the anti-fabrication route itself: POST /api/sessions/:id/input (ownerText) — same proof.
//   (H) /ws/term: a loopback upgrade with NO credential is REJECTED before the 101 response; a valid
//       [generic, bearer] subprotocol offer OR a valid `?token=` query fallback is ACCEPTED (reusing the
//       SAME mechanism trust-tier.mjs already proves for the remote case) — with `loopbackSecret` wired.
//   (G) structural: the guard's route-matching no longer references routeTier at all (v2 gates
//       unconditionally) — confirmed by reading the compiled hook body.
//
// v3 (card 351e89af — SECURITY): /ws/companion's inbound message path carried the identical assumption
// v1/v2 deliberately left open — "the loopback cockpit IS the authenticated human, so no auth at all" —
// documented as a known gap in this hook's own v2 doc comment. Unlike the alert-text path (018ce1db), an
// agent with Bash could inject straight into the owner-role Companion slot with NO manager involved at
// all. v3 gates `/ws/companion/:sessionId` by the EXACT same mechanism as /ws/term (no second scheme):
//   (I) a loopback upgrade to /ws/companion with NO credential is REJECTED before the 101 response; a
//       WRONG bearer subprotocol is also rejected; a VALID [generic, bearer] offer OR a valid `?token=`
//       fallback is ACCEPTED — mirroring (H) exactly, proving the SAME mechanism was reused, not a
//       parallel one. (loopbackSecret omitted ⇒ inert, proven alongside (A).)
//
// v4 (card 93249b52, SECURITY follow-up — renumbered (L)/(M)/(N) to avoid colliding with v3's own (I)
// above, both landed on main around the same time): the guard also covers POST /internal/shutdown and
// POST /internal/update — the two loomctl lifecycle writers left on the old loopback-only posture, one of
// which (/internal/update) fetches and INSTALLS code, a strictly larger blast radius than any /api/* write
// this guard already covered.
//   (L) POST /internal/shutdown, (M) POST /internal/update: 401 with no credential, 401 with a wrong one,
//       and the real handler reached (a deferred spy fires) with the correct one — same shape as (B)-(D).
//   (N) POST /internal/hook is proven to stay UNGATED even with loopbackSecret wired — a deliberate
//       exclusion (see server.ts's own comment at that route for why, and for the honest accounting of
//       what staying ungated does and doesn't defend against), not an oversight.
//
// v5 (card 214caa53, SECURITY follow-up — GAP 1): pre-v5, an UNDETERMINABLE `req.socket.remoteAddress`
// (empty string — Node clears it once the underlying handle is destroyed; see server.ts's own comment for
// the RST-race hypothesis this closes defense-in-depth against, tested and NOT reproduced, per that card)
// fell through `!LOOPBACK.has("")` (true) to a bare `return` — the hook silently NO-OP'd, permitting the
// request with NO credential check at all. v5 fails CLOSED instead: an undeterminable address is REJECTED
// outright on a guarded route, unconditionally (not rescued by a valid credential).
//   (P) a bare `injectWS` call with no `socket:` override (yielding an empty `remoteAddress` — see the
//       TEST NOTE above) on /ws/term now REJECTS with no credential (was silently ACCEPTED pre-fix) and
//       REJECTS even with a valid bearer credential (fail-closed is unconditional on the address, not
//       credential-gated); with `loopbackSecret` UNSET the same call still succeeds (inertness preserved).
import fs from "node:fs";
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";

const TMP = mkdtempManaged("loom-loopback-guard-");
process.env.LOOM_HOME = TMP;
const PORT = 45418 + (process.pid % 900); // non-4317, low-collision — see gateway-hardening.mjs's own note
process.env.LOOM_PORT = String(PORT);
const sandboxHome = path.join(TMP, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { WS_GENERIC_SUBPROTOCOL, WS_BEARER_PREFIX } = await import("../dist/gateway/trust-tier.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
// Anchored to the OBSERVABLE event (the spy counter actually incrementing), not a fixed sleep — mirrors
// shutdown-endpoint.mjs / update-endpoint.mjs's own waitUntil for the same deferred-setTimeout shape.
const waitUntil = async (pred, timeoutMs, intervalMs = 20) => {
  try {
    return await sharedWaitUntil(pred, { timeoutMs, intervalMs, label: "loopback-write-guard" });
  } catch (err) {
    if (!/waitUntil: timed out/.test(err?.message ?? "")) throw err;
    return false;
  }
};

const now = new Date().toISOString();
const stub = {};
// /ws/term's handler unconditionally calls `deps.pty.subscribe(sessionId, {...})` on a successful
// upgrade (and its returned unsub on socket close) — a bare `{}` stub would throw the moment an ACCEPT-
// path test (H below) actually connects. trust-tier.mjs's own equivalent test deliberately avoided this
// by only exercising /ws/term's REJECT path (auth happens before the handler ever runs, so a plain `{}`
// stub is fine there) and using /ws/companion for its accept-path proof instead (a handler that
// tolerates a missing dep). This file needs a real accept proof for /ws/term specifically (it's the
// route the Critical named), so it gets a minimal working stub instead.
const ptyStub = { subscribe: () => () => {}, writeStdin: () => {}, repaint: () => {}, resize: () => {} };
// Loopback headers so the CSRF/DNS-rebind onRequest hook lets every request through to the handler —
// mirrors gateway-hardening.mjs exactly (Host/Origin matched by hostname only, port is cosmetic here).
const H = { host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}`, "content-type": "application/json" };
const authH = (bearer) => (bearer ? { ...H, authorization: `Bearer ${bearer}` } : H);
const bearerProto = (token) => `${WS_GENERIC_SUBPROTOCOL}, ${WS_BEARER_PREFIX}${token}`;
// `injectWS` (unlike plain `.inject()`) does NOT default `remoteAddress` — an explicit `socket:` override
// is required to simulate a loopback WS upgrade, mirroring trust-tier.mjs's own `socket: remoteSocket`
// pattern for the remote-peer case. See the guard hook's own "TEST NOTE" doc comment in server.ts for how
// this was found (a bare call silently no-ops the guard instead of rejecting — confirmed via debug
// instrumentation, not assumed).
const LOOPBACK_SOCKET = { remoteAddress: "127.0.0.1" };

let appNoSecret, appWithSecret, db;
try {
  db = new Db(path.join(TMP, "loom.db"));
  db.insertProject({ id: "p1", name: "P1", repoPath: TMP, vaultPath: TMP, config: {}, createdAt: now, archivedAt: null });

  // ===================== (A) backward compat: loopbackSecret OMITTED =====================
  appNoSecret = await buildServer({
    db, pty: ptyStub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub,
    userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub,
  });
  const unguardedWrite = await appNoSecret.inject({ method: "PATCH", url: "/api/platform/config", headers: H, payload: {} });
  check("(A) loopbackSecret omitted → the guard is inert, a write with NO auth header still succeeds (existing tests stay byte-identical)",
    unguardedWrite.statusCode === 200);
  const unguardedSocket = await appNoSecret.injectWS("/ws/term/sess1", { headers: H, socket: LOOPBACK_SOCKET });
  check("(A) loopbackSecret omitted → /ws/term upgrade with NO credential still succeeds (unaffected)", !!unguardedSocket);
  unguardedSocket.close();
  const unguardedCompanionSocket = await appNoSecret.injectWS("/ws/companion/sess1", { headers: H, socket: LOOPBACK_SOCKET });
  check("(A) loopbackSecret omitted → /ws/companion upgrade with NO credential still succeeds (unaffected)", !!unguardedCompanionSocket);
  unguardedCompanionSocket.close();

  // ===================== (B)-(K) the real guard, wired =====================
  const SECRET = "test-loopback-secret-0123456789abcdef";
  let shutdownCalls = 0, updateCalls = 0;
  appWithSecret = await buildServer({
    db, pty: ptyStub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub,
    userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub,
    loopbackSecret: SECRET,
    // Spies for (I)/(J) below — POST /internal/shutdown/update defer these one tick via setTimeout, so an
    // undefined dep here would throw an uncaught TypeError once the POSITIVE-CONTROL case (correct secret)
    // actually reaches the real handler.
    requestShutdown: () => { shutdownCalls++; },
    beginSelfUpdate: () => { updateCalls++; },
  });
  const patchConfig = (bearer) => appWithSecret.inject({ method: "PATCH", url: "/api/platform/config", headers: authH(bearer), payload: {} });

  // (B) THE BYPASS: the exact shape of the demonstrated exploit — a same-host request to a human-only
  // config writer with NO credential at all.
  const noAuth = await patchConfig(undefined);
  check("(B) THE BYPASS IS CLOSED: PATCH /api/platform/config with NO Authorization header → 401 (was 200 pre-fix)",
    noAuth.statusCode === 401);

  // (C) a wrong bearer value is rejected too — not merely "any Authorization header present".
  const wrongAuth = await patchConfig("not-the-real-secret");
  check("(C) a WRONG bearer value → 401", wrongAuth.statusCode === 401);

  // (D) POSITIVE CONTROL: the correct secret succeeds — proves the request itself is well-formed and
  // (B)/(C) are genuinely about the auth check, not some unrelated breakage.
  const rightAuth = await patchConfig(SECRET);
  check("(D) POSITIVE CONTROL: the CORRECT bearer value → 200 (same call, only the credential differs)",
    rightAuth.statusCode === 200);

  // (E) reads stay unaffected — this guard is WRITES + /ws/term only.
  const readNoAuth = await appWithSecret.inject({ method: "GET", url: "/api/projects", headers: H });
  check("(E) GET /api/projects with NO auth header still succeeds (guard is write-only by design)",
    readNoAuth.statusCode === 200);

  // (E2) card f26339d7 — GET /api/deploy-status is the plain, unprivileged, loopback-only twin of the
  // agent-facing MCP tool `served_status`: it must be reachable from a bare loopback caller with NO
  // Authorization header (same guard-scope proof as (E)), and return the SAME shape (deployStaleness
  // carrying distBuiltSha/processBuiltSha/webBuiltSha) rather than a hand-duplicated, potentially-drifted copy.
  const deployStatusNoAuth = await appWithSecret.inject({ method: "GET", url: "/api/deploy-status", headers: H });
  check("(E2) GET /api/deploy-status with NO auth header still succeeds (the externally-readable twin of served_status is not gated)",
    deployStatusNoAuth.statusCode === 200);
  const deployStatusBody = deployStatusNoAuth.json();
  check("(E2) the response carries deployStaleness.distBuiltSha AND processBuiltSha (the two baked-at-build-time fields, not a hand-duplicated shape)",
    Object.prototype.hasOwnProperty.call(deployStatusBody.deployStaleness ?? {}, "distBuiltSha") &&
    Object.prototype.hasOwnProperty.call(deployStatusBody.deployStaleness ?? {}, "processBuiltSha"));
  check("(E2) and version/skillStoreStaleness alongside it — the SAME composition served_status uses, not a narrower one",
    typeof deployStatusBody.version === "string" && "skillStoreStaleness" in deployStatusBody);

  // (F) THE v1 GAP: a Tier-1 write (trust-tier.ts's own "safe for an authenticated REMOTE human"
  // allowlist — a materially different predicate from "safe from an unauthenticated co-resident agent",
  // which is what v1 conflated) is NOW gated too.
  const tier1NoAuth = await appWithSecret.inject({ method: "POST", url: "/api/questions/does-not-exist/answer", headers: H, payload: { answer: "yes" } });
  check("(F) THE v1 GAP IS CLOSED: POST /api/questions/:id/answer (Tier-1) with NO auth header → 401 (was 404-passthrough pre-v2)",
    tier1NoAuth.statusCode === 401);
  const tier1WithAuth = await appWithSecret.inject({ method: "POST", url: "/api/questions/does-not-exist/answer", headers: authH(SECRET), payload: { answer: "yes" } });
  check("(F) POSITIVE CONTROL: the SAME route with the correct secret reaches the real handler (404 for a nonexistent id, not 401)",
    tier1WithAuth.statusCode === 404);

  // (F2) the specific anti-fabrication route the review named: POST /api/sessions/:id/input feeds
  // `ownerText` (mcp/questionTool.ts) on the premise it comes from an authenticated human composer.
  const ownerTextNoAuth = await appWithSecret.inject({ method: "POST", url: "/api/sessions/does-not-exist/input", headers: H, payload: { text: "hi" } });
  check("(F2) POST /api/sessions/:id/input (ownerText source) with NO auth header → 401",
    ownerTextNoAuth.statusCode === 401);

  // ===================== (H) /ws/term: the stdin-write capability =====================
  const wsNoAuth = await (async () => {
    try { const ws = await appWithSecret.injectWS("/ws/term/sess1", { headers: H, socket: LOOPBACK_SOCKET }); ws.close(); return false; }
    catch { return true; }
  })();
  check("(H) /ws/term upgrade with NO credential → REJECTED before the 101 response (with loopbackSecret wired)", wsNoAuth);

  const wsWrongAuth = await (async () => {
    try { const ws = await appWithSecret.injectWS("/ws/term/sess1", { headers: { ...H, "sec-websocket-protocol": bearerProto("wrong-token") }, socket: LOOPBACK_SOCKET }); ws.close(); return false; }
    catch { return true; }
  })();
  check("(H) /ws/term upgrade with a WRONG bearer subprotocol → REJECTED", wsWrongAuth);

  const wsOkProto = await appWithSecret.injectWS("/ws/term/sess2", { headers: { ...H, "sec-websocket-protocol": bearerProto(SECRET) }, socket: LOOPBACK_SOCKET });
  check("(H) POSITIVE CONTROL: /ws/term upgrade with a VALID [generic, bearer] subprotocol offer → ACCEPTED", !!wsOkProto);
  wsOkProto.close();

  const wsOkQuery = await appWithSecret.injectWS(`/ws/term/sess3?token=${SECRET}`, { headers: H, socket: LOOPBACK_SOCKET });
  check("(H) POSITIVE CONTROL: /ws/term upgrade with a VALID ?token= query fallback → ACCEPTED", !!wsOkQuery);
  wsOkQuery.close();

  // ===================== (I) /ws/companion: the SAME gap, closed by card 351e89af =====================
  const wsCompanionNoAuth = await (async () => {
    try { const ws = await appWithSecret.injectWS("/ws/companion/csess1", { headers: H, socket: LOOPBACK_SOCKET }); ws.close(); return false; }
    catch { return true; }
  })();
  check("(I) THE GAP IS CLOSED: /ws/companion upgrade with NO credential → REJECTED before the 101 response (was ACCEPTED pre-fix)", wsCompanionNoAuth);

  const wsCompanionWrongAuth = await (async () => {
    try { const ws = await appWithSecret.injectWS("/ws/companion/csess1", { headers: { ...H, "sec-websocket-protocol": bearerProto("wrong-token") }, socket: LOOPBACK_SOCKET }); ws.close(); return false; }
    catch { return true; }
  })();
  check("(I) /ws/companion upgrade with a WRONG bearer subprotocol → REJECTED", wsCompanionWrongAuth);

  const wsCompanionOkProto = await appWithSecret.injectWS("/ws/companion/csess2", { headers: { ...H, "sec-websocket-protocol": bearerProto(SECRET) }, socket: LOOPBACK_SOCKET });
  check("(I) POSITIVE CONTROL: /ws/companion upgrade with a VALID [generic, bearer] subprotocol offer → ACCEPTED (proves the mechanism, not just the rejection)", !!wsCompanionOkProto);
  wsCompanionOkProto.close();

  const wsCompanionOkQuery = await appWithSecret.injectWS(`/ws/companion/csess3?token=${SECRET}`, { headers: H, socket: LOOPBACK_SOCKET });
  check("(I) POSITIVE CONTROL: /ws/companion upgrade with a VALID ?token= query fallback → ACCEPTED", !!wsCompanionOkQuery);
  wsCompanionOkQuery.close();

  // ===================== (L) POST /internal/shutdown =====================
  // Card 93249b52: this loomctl lifecycle writer joins the same guard — proven the same way as every
  // other write above: 401 with no credential, 401 with a wrong one, and the real handler reached (its
  // deferred requestShutdown spy fires) with the correct one.
  // `payload: {}` on every call below: `H` sets content-type:application/json, and a request that CLEARS
  // the guard now proceeds to Fastify's body parser — an empty body under that content-type is its own
  // 400 (FST_ERR_CTP_EMPTY_JSON_BODY), which would masquerade as a guard failure on the positive-control
  // calls specifically (found by running this positive control and reading its actual, non-401 status).
  const shutdownNoAuth = await appWithSecret.inject({ method: "POST", url: "/internal/shutdown", headers: H, payload: {}, remoteAddress: "127.0.0.1" });
  check("(L) POST /internal/shutdown with NO auth header → 401 (was loopback-only pre-fix)", shutdownNoAuth.statusCode === 401);
  const shutdownWrongAuth = await appWithSecret.inject({ method: "POST", url: "/internal/shutdown", headers: authH("not-the-real-secret"), payload: {}, remoteAddress: "127.0.0.1" });
  check("(L) POST /internal/shutdown with a WRONG bearer value → 401", shutdownWrongAuth.statusCode === 401);
  const shutdownRightAuth = await appWithSecret.inject({ method: "POST", url: "/internal/shutdown", headers: authH(SECRET), payload: {}, remoteAddress: "127.0.0.1" });
  check("(L) POSITIVE CONTROL: POST /internal/shutdown with the CORRECT secret → 202 (reaches the real handler)",
    shutdownRightAuth.statusCode === 202);
  check("(L) the real handler actually ran (requestShutdown spy fired) once authorized",
    await waitUntil(() => shutdownCalls === 1, 3000)); // > the endpoint's own 50ms defer, generous bound

  // ===================== (M) POST /internal/update =====================
  // Same proof, plus: the correct secret reaches PAST the guard into the packaged/source gate (409 here,
  // since this test process is a from-source checkout) rather than the guard's own 401 — i.e. the 409
  // proves routing reached the real handler, the same "not a coincidence" shape (F) proved for Tier-1.
  const updateNoAuth = await appWithSecret.inject({ method: "POST", url: "/internal/update", headers: H, payload: {}, remoteAddress: "127.0.0.1" });
  check("(M) POST /internal/update with NO auth header → 401 (was loopback-only pre-fix)", updateNoAuth.statusCode === 401);
  const updateWrongAuth = await appWithSecret.inject({ method: "POST", url: "/internal/update", headers: authH("not-the-real-secret"), payload: {}, remoteAddress: "127.0.0.1" });
  check("(M) POST /internal/update with a WRONG bearer value → 401", updateWrongAuth.statusCode === 401);
  const updateRightAuthSource = await appWithSecret.inject({ method: "POST", url: "/internal/update", headers: authH(SECRET), payload: {}, remoteAddress: "127.0.0.1" });
  check("(M) POSITIVE CONTROL: POST /internal/update with the CORRECT secret reaches the real handler (409 from-source, not 401)",
    updateRightAuthSource.statusCode === 409);
  process.env.LOOM_PACKAGED = "1";
  try {
    const updateRightAuthPackaged = await appWithSecret.inject({ method: "POST", url: "/internal/update", headers: authH(SECRET), payload: {}, remoteAddress: "127.0.0.1" });
    check("(M) POSITIVE CONTROL: on a PACKAGED install, the CORRECT secret → 202 (reaches the real handler)",
      updateRightAuthPackaged.statusCode === 202);
  } finally {
    delete process.env.LOOM_PACKAGED;
  }
  check("(M) the real handler actually ran (beginSelfUpdate spy fired) once authorized+packaged",
    await waitUntil(() => updateCalls === 1, 3000)); // > the endpoint's own 50ms defer, generous bound

  // ===================== (N) POST /internal/hook stays DELIBERATELY UNGATED =====================
  // Even with loopbackSecret wired, the SessionStart hook relay must keep working with NO credential at
  // all — see server.ts's own comment at that route for why (high-frequency, not human-driven, no
  // credential to attach). This is the negative-scope proof: NOT gating this route is a decision, not an
  // oversight — see (G) below for the structural check that the guard's own predicate excludes it by name.
  const hookNoAuth = await appWithSecret.inject({ method: "POST", url: "/internal/hook", headers: H, remoteAddress: "127.0.0.1", payload: {} });
  check("(N) POST /internal/hook with NO auth header still succeeds (deliberately excluded from the guard)",
    hookNoAuth.statusCode === 200);

  // ===================== (P) GAP 1 fail-closed: an UNDETERMINABLE peer address (card 214caa53) =====================
  // Pre-fix, `req.socket?.remoteAddress ?? ""` on an empty address fell through `!LOOPBACK.has("")` (true)
  // straight to `return` — the hook silently no-op'd and the request proceeded with NO credential check
  // at all (the fail-OPEN gap this card's DoD-2 closes). `.inject()`'s own `remoteAddress` option cannot
  // simulate this for a plain `/api/*` write — light-my-request falls back to `'127.0.0.1'` via
  // `options.remoteAddress || '127.0.0.1'`, so an explicit `""` is silently discarded (confirmed by
  // reading node_modules/light-my-request/lib/request.js — `this.socket = new MockSocket(options.
  // remoteAddress || '127.0.0.1')`). `injectWS`, by contrast, does NOT default it at all (see this hook's
  // own "TEST NOTE" doc comment) — a bare call with no `socket:` override yields a genuinely empty
  // `remoteAddress`, exercising the EXACT SAME `ip === ""` code line the REST-write path shares (one
  // unified check after the route-pattern gate) — so this is a faithful proof of the shared logic, not a
  // WS-only claim. RED-PROVEN: reverting just this file's GAP-1 fix (restoring the bare `if
  // (!LOOPBACK.has(ip)) return;`) and re-running this file fails exactly these two checks (the upgrade
  // succeeds with no credential, where it must now be rejected) — everything else in this file stays
  // green, isolating the regression to this exact change.
  const wsUndeterminedNoAuth = await (async () => {
    try { const ws = await appWithSecret.injectWS("/ws/term/sess-undetermined", { headers: H }); ws.close(); return false; }
    catch { return true; }
  })();
  check("(P) GAP 1 FIXED: /ws/term upgrade with an UNDETERMINABLE peer address (no socket override, no credential) → REJECTED (was silently ACCEPTED pre-fix)",
    wsUndeterminedNoAuth);

  // Fail-closed is unconditional on the ADDRESS, not rescued by a valid credential — the whole point is
  // we cannot confirm this connection is even the loopback caller the credential is scoped to trust.
  const wsUndeterminedValidAuth = await (async () => {
    try { const ws = await appWithSecret.injectWS("/ws/term/sess-undetermined2", { headers: { ...H, "sec-websocket-protocol": bearerProto(SECRET) } }); ws.close(); return false; }
    catch { return true; }
  })();
  check("(P) an undeterminable peer address is REJECTED even WITH a valid bearer credential (unconditional on the address)",
    wsUndeterminedValidAuth);

  // DoD-3: the `loopbackSecret === undefined` inertness this card was told to leave alone must still make
  // the WHOLE hook (this new ip==="" branch included) a no-op — re-confirms (A)'s inertness proof on this
  // specific new code path, since DoD-2 asked to verify the fix doesn't reach partial-stub tests.
  const unguardedUndetermined = await (async () => {
    try { const ws = await appNoSecret.injectWS("/ws/term/sess-undetermined3", { headers: H }); ws.close(); return true; }
    catch { return false; }
  })();
  check("(P) DoD-3: with loopbackSecret UNSET, an undeterminable-address /ws/term upgrade still succeeds (inertness preserved)",
    unguardedUndetermined);

  // (G) structural: v2 no longer consults routeTier at all in the guard (it gates unconditionally) —
  // confirmed by reading the compiled source, mirroring gateway-token.mjs's own (F) pattern.
  {
    const serverPath = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "dist", "gateway", "server.js");
    const src = fs.readFileSync(serverPath, "utf8");
    const guardIdx = src.indexOf("Loopback human-only-write guard");
    check("(G) the guard block exists in compiled output", guardIdx !== -1);
    // 18000 (was 13000, was 10000, was 7000): wide enough to comfortably reach past the WHOLE hook — doc
    // comment AND code, measured end-to-end at ~14346 chars as of this card's fix — with real headroom,
    // not a tight fit. Code Review finding (card 214caa53 review): a window sized to just barely fit the
    // last literal (13000 landed mid-token, clipping the LOOPBACK.has(ip) check entirely) is exactly the
    // brittleness that kept forcing this number up one clipped-literal at a time; codeSlice below is what
    // actually makes the checks comment-immune, this number just needs to not truncate the real code.
    const guardSlice = src.slice(guardIdx, guardIdx + 18000);
    // CODE-ONLY slice, from `app.addHook` onward — every (G) check below matches against THIS, never the
    // raw guardSlice. Code Review MAJOR finding (card 214caa53 review): a literal-text regex run over
    // guardSlice matches the ~10KB LEADING COMMENT BLOCK too, and prose in that block can echo the exact
    // code shape it's describing (this hook's own TEST-NOTE comment contains the literal text `` `ip ===
    // ""` check `` inside backticks — backticks aren't part of any of these regexes, so the prose matched
    // and the GAP-1 check below was a FALSE GREEN, proven by the reviewer deleting the real fix from dist
    // and re-running: the behavioral (P) checks went RED, this (G) check stayed GREEN). Slicing to
    // code-only makes every check here immune to comment growth — it ALSO retires the 7000→10000→13000
    // widening treadmill, since a comment addition can no longer push a matched literal near a boundary
    // that matters (the window above just needs to comfortably reach the code, not track every literal).
    const codeSlice = guardSlice.slice(guardSlice.indexOf("app.addHook"));
    check("(G) v2 gates every /api/* write unconditionally — no routeTier check inside the guard hook",
      !/routeTier\(req\.method, routePattern\)/.test(codeSlice));
    check("(G) the guard also matches the /ws/term upgrade route by pattern",
      /routePattern === ["']\/ws\/term\/:sessionId["']/.test(codeSlice));
    check("(G) v3: the guard also matches the /ws/companion upgrade route by pattern (card 351e89af)",
      /routePattern === ["']\/ws\/companion\/:sessionId["']/.test(codeSlice));
    // (G) card 93249b52: the guard's route-matching literally names /internal/shutdown + /internal/update,
    // and does NOT name /internal/hook — corroborates the behavioral (L)/(M)/(N) proof above structurally.
    check("(G) the guard matches /internal/shutdown by pattern", /["']\/internal\/shutdown["']/.test(codeSlice));
    check("(G) the guard matches /internal/update by pattern", /["']\/internal\/update["']/.test(codeSlice));
    check("(G) the guard does NOT match /internal/hook by pattern", !/["']\/internal\/hook["']/.test(codeSlice));
    // (G) card 214caa53: GAP 1's empty-address check — both PRESENCE and ORDERING. This check's whole job
    // is an ordering claim (the empty-address reject must run BEFORE the LOOPBACK-set membership check,
    // not be folded into or come after it — see server.ts's own comment for why), so verify the ordering
    // directly rather than mere presence, which proves nothing about precedence.
    const emptyAddrCheckIdx = codeSlice.search(/ip\s*===\s*["']["']/);
    const loopbackMembershipIdx = codeSlice.indexOf("LOOPBACK.has(ip)");
    check("(G) GAP 1: the guard checks for an empty/undeterminable peer address (ip === \"\")", emptyAddrCheckIdx !== -1);
    check("(G) GAP 1: the empty-address check runs BEFORE the LOOPBACK.has(ip) membership check (ordering, not just presence)",
      loopbackMembershipIdx !== -1 && emptyAddrCheckIdx !== -1 && emptyAddrCheckIdx < loopbackMembershipIdx);
  }
} finally {
  try { await appNoSecret?.close(); } catch { /* ignore */ }
  try { await appWithSecret?.close(); } catch { /* ignore */ }
  db?.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the loopback human-only-write guard (v5) closes the unauthenticated same-host bypass on EVERY non-GET /api/* write, the /ws/term stdin socket, the /ws/companion inbound chat socket (card 351e89af), AND POST /internal/shutdown + POST /internal/update (card 93249b52 — the loomctl lifecycle writers, one of which fetches+installs code) — including the Tier-1 human-authority routes v1 left open (session input's ownerText source, questions/answer) — proven both failing-without and succeeding-with the correct secret, leaves reads unaffected, proves POST /internal/hook stays deliberately ungated, fails CLOSED on an undeterminable peer address unconditionally (card 214caa53, GAP 1), and stays inert (byte-identical) for every existing partial-stub test that doesn't wire it."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
