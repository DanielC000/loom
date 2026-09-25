import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Access-story Phase A (card 766f8b50) — the per-route trust-tier wall (gateway/trust-tier.ts) + its
// onRequest hook in gateway/server.ts. Ships INERT: the hook only exists when a non-loopback bind is
// configured (remoteAccess.enabled && bindHost non-loopback), which is never true by default.
// HERMETIC + CLAUDE-FREE + NETWORK-FREE (Db + buildServer via app.inject, like csrf-rebind.mjs). Proves:
//   1. routeTier default-deny is TOTAL against the REAL registered route surface: every method+pattern
//      combo the gateway actually registers is derived LIVE from the real Fastify router (never a hand-
//      maintained snapshot). Card 3c708c30 found the OLD hand-copied `ALL_ROUTES` array had drifted —
//      three real routes (/api/setup/project-init, /api/setup/templates, /api/setup/templates/apply)
//      weren't in it at all, and this file's own header claimed `app.printRoutes` backed it when that
//      call never actually ran (the capture was hand-typed once and never re-verified). This LIVE
//      derivation walks the real Fastify router's route table directly (see `liveRoutesOf` below) rather
//      than parsing `printRoutes`'s pretty-printed tree text — that text merges shared path PREFIXES at
//      arbitrary character boundaries (e.g. "test" + "ing" => "testing" with no separator), not just path
//      segments, making it fragile to reconstruct exact {method, pattern} pairs from; walking the
//      router's own `.routes` array gives those pairs directly and exactly. Anything not the exact,
//      explicit Tier-1/Tier-2 allowlist is Tier-0 — so a route added later is Tier-0 unless someone
//      deliberately allowlists it, AND is automatically covered by this check without anyone touching a
//      hand-maintained route list.
//   2. remoteAccess DISABLED (default): the hook is never even registered — a "remote-looking" request
//      (simulated remoteAddress) to a writer route behaves exactly as today (200, byte-identical).
//   3. remoteAccess ENABLED + a non-loopback bindHost:
//      a. a LOOPBACK request (the TCP peer in the loopback set) → unchanged (passes through to the handler).
//      b. a REMOTE request to a Tier-0 route (a writer, /internal/*, an /mcp-* mount) → 403; an UNMATCHED
//         route (undefined req.routeOptions.url) is ALSO Tier 0 (card 77ade04c nit: never fall back to the
//         attacker-controlled req.url); a spoofed X-Forwarded-For:127.0.0.1 does NOT count as loopback
//         (card 77ade04c nit: the peer check reads req.socket.remoteAddress directly, immune to trustProxy).
//      c. a REMOTE request to a Tier-1 route → 401 without a token, and passes with a (stubbed-valid) one.
//      d. the two WS routes ALSO accept the token via the double-subprotocol contract (Phase B, card
//         56ffe50a; the leak fix, card 42abca6a) — `[loom.v1, loom.bearer.<token>]`, preferred — or a
//         `?token=` query fallback — proven via a REAL handshake through @fastify/websocket's injectWS
//         (drives the SAME onRequest hook chain a genuine socket upgrade does).
//   4. selectWsSubprotocol (the wired-in `handleProtocols`) NEVER echoes a token-carrying subprotocol back
//      — always the fixed generic marker, or nothing — closing the card 42abca6a credential leak where
//      ws@8's default handleProtocols echoed the first client-offered entry (which used to BE the token)
//      verbatim into the 101 response's Sec-WebSocket-Protocol header.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import Fastify from "fastify";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TMP = mkdtempManaged("loom-trust-tier-");
process.env.LOOM_HOME = TMP;
process.env.LOOM_PORT = "45342";
const PORT = process.env.LOOM_PORT;
const sandboxHome = path.join(TMP, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { routeTier, selectWsSubprotocol, resolveWsSubprotocolToken, WS_GENERIC_SUBPROTOCOL, WS_BEARER_PREFIX } = await import("../dist/gateway/trust-tier.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- (4) selectWsSubprotocol (the wired-in `handleProtocols`) + resolveWsSubprotocolToken — pure unit ----
// checks against the actual functions gateway/server.ts wires in, so the assertion holds regardless of
// whatever a raw handshake's response bytes look like (injectWS's client-side shim doesn't parse the raw
// 101 response back into a `ws.protocol` the (3d) checks below could assert on directly — see the note
// there). This is what closes the card 42abca6a gap: "trust-tier.mjs only acknowledges the echo, doesn't
// assert against the leak."
const TOKEN_LOOKING_STRING = "super-secret-gateway-token-should-never-be-echoed";
check("(4) selectWsSubprotocol: generic offered alone → negotiates the generic marker",
  selectWsSubprotocol(new Set([WS_GENERIC_SUBPROTOCOL])) === WS_GENERIC_SUBPROTOCOL);
check("(4) selectWsSubprotocol: [generic, bearer(token)] offered → STILL negotiates the generic marker, NEVER the token",
  selectWsSubprotocol(new Set([WS_GENERIC_SUBPROTOCOL, `${WS_BEARER_PREFIX}${TOKEN_LOOKING_STRING}`])) === WS_GENERIC_SUBPROTOCOL);
check("(4) selectWsSubprotocol: a bearer-only offer (no generic) → false (never echoes the token)",
  selectWsSubprotocol(new Set([`${WS_BEARER_PREFIX}${TOKEN_LOOKING_STRING}`])) === false);
check("(4) selectWsSubprotocol: no subprotocol offered at all → false",
  selectWsSubprotocol(new Set()) === false);
check("(4) resolveWsSubprotocolToken: [generic, bearer(abc123)] → extracted BY PREFIX, order-independent",
  JSON.stringify(resolveWsSubprotocolToken(`${WS_BEARER_PREFIX}abc123, ${WS_GENERIC_SUBPROTOCOL}`)) === JSON.stringify({ outcome: "token", token: "abc123" }));
check("(4) resolveWsSubprotocolToken: a bearer-only offer (no generic) → rejected outright",
  resolveWsSubprotocolToken(`${WS_BEARER_PREFIX}abc123`).outcome === "rejected");
check("(4) resolveWsSubprotocolToken: generic offered alone (no bearer) → no-token (caller falls back to ?token=)",
  resolveWsSubprotocolToken(WS_GENERIC_SUBPROTOCOL).outcome === "no-token");
check("(4) resolveWsSubprotocolToken: no header at all → no-token",
  resolveWsSubprotocolToken(undefined).outcome === "no-token");

// --- LIVE route-surface derivation (card 3c708c30) ---------------------------------------------------
// find-my-way isn't a direct daemon dependency (only fastify is), so it's resolved the SAME way fastify
// resolves it internally — anchored at fastify's own package location via `createRequire` — guaranteeing
// this patches the identical prototype object fastify's own router construction uses, not some other
// copy that a plain `import("find-my-way")` from this file's own location might miss entirely (or worse,
// silently resolve to a different installed copy).
const FindMyWay = createRequire(import.meta.resolve("fastify"))("find-my-way");
let capturedRouter = null;
const originalRouterOn = FindMyWay.prototype.on;
FindMyWay.prototype.on = function capturingOn(...args) {
  capturedRouter = this; // find-my-way's own Router instance — its `.routes` array is the ground truth
  return originalRouterOn.apply(this, args);
};

/**
 * Registered {method, pattern} pairs the given find-my-way Router instance actually holds, deduped and
 * HEAD/OPTIONS/TRACE-filtered (Fastify auto-added siblings of GET, not distinct handlers — same reasoning
 * the onRequest hook itself doesn't special-case them: a HEAD probe of a Tier-1 GET is itself intended to
 * be Tier-1; a HEAD/OPTIONS of a Tier-0 route is intended to stay Tier-0). Uses `route.path` — NOT
 * `route.pattern`, which find-my-way mutates into its OWN internal tree-matching shorthand that strips
 * param names as it walks the string (e.g. "/hooks/:endpointPath" ends up as "/hooks/:") — `route.path` is
 * the literal, unmutated string passed to `.on()`, i.e. the real registered Fastify pattern.
 */
function liveRoutesOf(router) {
  const seen = new Set();
  const routes = [];
  for (const r of router.routes) {
    if (r.method === "HEAD" || r.method === "OPTIONS" || r.method === "TRACE") continue;
    const key = `${r.method} ${r.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    routes.push([r.method, r.path]);
  }
  routes.sort(([am, ap], [bm, bp]) => (am === bm ? ap.localeCompare(bp) : am.localeCompare(bm)));
  return routes;
}

// --- (1) routeTier vs. the REAL, LIVE-derived registered route surface -------------------------------
let killCallsOff = 0;
const dbOff = new Db(path.join(TMP, "loom-off.db"));
const appOff = await buildServer({
  db: dbOff, pty: {}, sessions: { killAllWorkers: () => { killCallsOff++; return 0; } }, mcp: {}, orchMcp: {},
  platformMcp: {}, auditMcp: {}, userAuditMcp: {}, setupMcp: {}, runMcp: {}, control: {}, usageStatus: {},
  requestShutdown: () => {},
});
try {
  if (!capturedRouter) {
    throw new Error("find-my-way's Router.prototype.on was never observed while building the server — the " +
      "live derivation's own interception is broken, which would otherwise make every check below pass " +
      "VACUOUSLY over an empty route list");
  }
  const LIVE_ROUTES = liveRoutesOf(capturedRouter);

  // (1-sanity) fail loudly if the derivation mechanism's own scope assumption stops holding, rather than
  // silently under-covering the way the old hand-copied ALL_ROUTES did. A floor (not an exact count) —
  // the real count drifts as routes are added — plus a known-stable landmark route.
  check(`(1-sanity) the live derivation observed a non-trivial route population (found ${LIVE_ROUTES.length}, floor 200)`,
    LIVE_ROUTES.length >= 200);
  check("(1-sanity) the live derivation includes a known-stable landmark route (GET /api/projects) — absence would mean the interception itself silently broke",
    LIVE_ROUTES.some(([m, p]) => m === "GET" && p === "/api/projects"));

  // (1e) LIVENESS demo: a brand-new route, never hardcoded anywhere in this file or in trust-tier.ts,
  // registered on a throwaway fixture app AFTER the LIVE_ROUTES snapshot above was taken, must appear in
  // the SAME derivation mechanism run again — proving this reads the router live, not a frozen snapshot
  // (the exact defect this card fixes one level up, at the ALL_ROUTES-was-a-stale-hand-capture level).
  {
    const fixtureApp = Fastify({ logger: false });
    fixtureApp.get("/api/fixture/trust-tier-liveness-demo", async () => ({}));
    const fixtureRoutes = liveRoutesOf(capturedRouter);
    check("(1e) a brand-new, never-hardcoded route appears in the SAME live derivation mechanism automatically",
      fixtureRoutes.some(([m, p]) => m === "GET" && p === "/api/fixture/trust-tier-liveness-demo"));
    await fixtureApp.close();
  }

  const EXPECTED_TIER_1 = new Set([
    "GET /api/projects", "GET /api/sessions", "GET /api/sessions/:id/transcript", "GET /api/sessions/:id/diff",
    "GET /api/projects/:id/board", "GET /api/projects/:id/tasks", "GET /api/projects/:id/agents",
    "GET /api/agents/:id/sessions", "GET /api/sessions/:id/queue", "GET /api/sessions/:id/wakes",
    "GET /api/audit/session/:id", "GET /api/audit/wave/:managerId", "GET /api/audit/diff",
    "GET /api/gates/active", "GET /api/gates/history",
    "GET /api/usage/limits", "GET /api/usage/history", "GET /api/usage/sessions/history",
    "GET /api/projects/:id/vault", "GET /api/projects/:id/vault/file", "GET /api/projects/:id/vault/raw",
    "GET /api/questions", "GET /api/questions/:id",
    "POST /api/questions/:id/answer", "POST /api/questions/:id/dismiss", "POST /api/sessions/:id/input", "POST /api/sessions/:id/end",
    "POST /api/sessions/:id/stop", "POST /api/sessions/:id/resume", "POST /api/sessions/:id/rate-limit/clear",
    "GET /ws/term/:sessionId", "GET /ws/companion/:sessionId", "GET /ws/fleet",
    // Access-story Phase C (card 6bc02f50) follow-up on 77ade04c: reads a remote read-only UI needs.
    "GET /api/version", "GET /api/update-status", "GET /api/orchestration/status", "GET /api/orchestration/events",
    "GET /api/schedules/history",
    "GET /api/projects/:id/git/log", "GET /api/projects/:id/git/branches",
    "GET /api/projects/:id/git/reference-repos/:index/log",
    "GET /api/projects/:id/git/repos/:index/log",
    "GET /api/profiles", "GET /api/profiles/:id", "GET /api/skills", "GET /api/skills/:name",
    "GET /api/archived-sessions", "GET /api/archived-sessions/:id", "GET /api/projects/:id/archive", "GET /api/projects/archived",
    "GET /api/companion/:sessionId/grants", "GET /api/companion/allowed-senders", "GET /api/companion/bindings",
    "GET /api/companion/config", "GET /api/companion/config/:sessionId",
    "GET /api/companion/conversations/:sessionId", "GET /api/companion/conversations/:sessionId/:seq",
    "GET /api/companion/home", "GET /api/companion/:sessionId/lead-mode",
    "GET /api/companion/memory/:sessionId", "GET /api/companion/memory/:sessionId/:name",
    "GET /api/companion/messages/:sessionId", "GET /api/companion/prompt/:sessionId",
    "GET /api/companion/reminders/:sessionId", "GET /api/companion/restricted-tools/:sessionId",
    "GET /api/companion/skills/:sessionId", "GET /api/companion/skills/:sessionId/:name",
    "GET /api/companion/voice-prefs/:sessionId",
    // Card 3c708c30 sync fix: these three are ALREADY Tier-1 in trust-tier.ts's real TIER_1_ROUTES (the
    // per-project memory read, and the companion reply-health telemetry from card 8bda9fc6) but were
    // missing from this test's OWN spec — the old hand-typed ALL_ROUTES never included these routes at
    // all, so check (1) never actually compared them against anything. Once the route surface is derived
    // LIVE (above), leaving these out would make (1) fail for real (expected 0, actual 1) — this is what
    // proves the completeness check now has teeth it didn't have before.
    "GET /api/projects/:id/memory", "GET /api/companion/status", "GET /api/companion/status/:sessionId",
  ]);

  // Tier 2 (agent-tooling epic P5b, card 8fbedcac): the ONE fixed webhook-ingress pattern — PUBLIC,
  // signature-gated, deliberately NOT Tier 1 (it never accepts the gateway token).
  const EXPECTED_TIER_2 = new Set([
    "POST /hooks/:endpointPath",
  ]);

  /** Pure comparison, decoupled from any real server — see the (1-control) positive control below. */
  function findTierMismatches(routes, tierFn, tier1Set, tier2Set) {
    const mismatches = [];
    for (const [method, pattern] of routes) {
      const key = `${method} ${pattern}`;
      const expected = tier1Set.has(key) ? 1 : tier2Set.has(key) ? 2 : 0;
      const actual = tierFn(method, pattern);
      if (actual !== expected) mismatches.push({ key, expected, actual });
    }
    return mismatches;
  }

  // POSITIVE CONTROL: proves findTierMismatches can actually go RED, on a route it has never seen and
  // that neither allowlist mentions — a `tierFn` that (buggily) tier-1's it must be caught; the SAME
  // route, correctly fail-closed, must be clean. This is the shape of mismatch (1) below would need to
  // catch for real: a route with no explicit expectation getting classified as non-zero anyway.
  {
    const neverSeenRoute = [["GET", "/api/fixture/never-real-trust-tier-mismatch"]];
    const buggyTierFn = () => 1;
    const caught = findTierMismatches(neverSeenRoute, buggyTierFn, new Set(), new Set());
    check("(1-control) the mismatch detector CATCHES an unlisted route incorrectly classified non-zero",
      caught.length === 1 && caught[0].expected === 0 && caught[0].actual === 1);
    const clean = findTierMismatches(neverSeenRoute, () => 0, new Set(), new Set());
    check("(1-control) the SAME route, correctly fail-closed, is clean", clean.length === 0);
  }

  const mismatches = findTierMismatches(LIVE_ROUTES, routeTier, EXPECTED_TIER_1, EXPECTED_TIER_2);
  check(`(1) TOTAL live registered routes classify correctly (${LIVE_ROUTES.length} checked, ${EXPECTED_TIER_1.size} expected Tier-1, ${EXPECTED_TIER_2.size} expected Tier-2, offenders: ${mismatches.length === 0 ? "none" : mismatches.map((m) => `${m.key} [expected ${m.expected}, got ${m.actual}]`).join(" | ")})`,
    mismatches.length === 0);
  check("(1b) every EXPECTED_TIER_1 entry is actually a real LIVE registered route (no stale/typo'd allowlist entry)",
    [...EXPECTED_TIER_1].every((key) => LIVE_ROUTES.some(([m, p]) => `${m} ${p}` === key)));
  check("(1c) every EXPECTED_TIER_2 entry is actually a real LIVE registered route (no stale/typo'd allowlist entry)",
    [...EXPECTED_TIER_2].every((key) => LIVE_ROUTES.some(([m, p]) => `${m} ${p}` === key)));
  check("(1d) the webhook-endpoints ADMIN surface (a writer, not the ingress route) stays Tier-0 (loopback-only)",
    routeTier("GET", "/api/webhook-endpoints") === 0 && routeTier("POST", "/api/webhook-endpoints") === 0
    && routeTier("DELETE", "/api/webhook-endpoints/:id") === 0 && routeTier("POST", "/api/webhook-endpoints/:id/enabled") === 0);

  // --- (2) remoteAccess DISABLED (default): the hook never registers. Card 4cbbc343 (M1): a request classed REMOTE with NO
  //     wall registered is now REFUSED (403 {error:'forbidden'}) rather than passed through — it can only be a wiring
  //     inconsistency (a non-loopback peer cannot reach a loopback-only daemon at all, so real traffic is unchanged). ---
  const r = await appOff.inject({ method: "POST", url: "/api/orchestration/kill", remoteAddress: "203.0.113.5" });
  check("(2) remoteAccess disabled: a 'remote' POST /api/orchestration/kill is REFUSED 403 forbidden (fail-closed: remote class with no wall) and never runs", r.statusCode === 403 && JSON.parse(r.body).error === "forbidden" && killCallsOff === 0);
  const rLoop = await appOff.inject({ method: "POST", url: "/api/orchestration/kill" });
  check("(2) ...while the ordinary loopback request still runs (200) — the default daemon is unchanged", rLoop.statusCode === 200 && killCallsOff === 1);

  // (2a2) card a5ecb6fd: GET /api/projects masks config.sessionEnv values. That fix's own regression
  // coverage is a Playwright e2e spec, which runs in a SEPARATE CI job, never inside this project's own
  // merge gate — so this hermetic assertion (which DOES run in the gate) is what actually stops a future
  // refactor of the route from re-exposing the secrets and still landing on main green.
  dbOff.insertProject({
    id: "pSenv", name: "Senv", repoPath: TMP, vaultPath: TMP,
    config: { sessionEnv: { ALPHA: "alpha-secret-value" } }, createdAt: new Date().toISOString(), archivedAt: null,
  });
  const listed = await appOff.inject({ method: "GET", url: "/api/projects" });
  const senv = listed.json().find((p) => p.id === "pSenv").config.sessionEnv;
  check("(2a2) GET /api/projects masks sessionEnv values: never the real value, exact length preserved",
    senv.ALPHA !== "alpha-secret-value" && senv.ALPHA.length === "alpha-secret-value".length);

  // (2b) REGRESSION GUARD (card 42abca6a): the loopback cockpit WS — today's web client connects with NO
  // Sec-WebSocket-Protocol header at all (see packages/web/src/components/Terminal.tsx) — must still
  // upgrade cleanly under the new handleProtocols. ws only invokes handleProtocols when the client sent a
  // subprotocol header at all, so a header-less offer never even reaches selectWsSubprotocol; this proves
  // the byte-identical claim end-to-end rather than resting on that reasoning alone.
  const loopbackNoProto = await appOff.injectWS("/ws/companion/sess1", { headers: { host: "127.0.0.1" } });
  check("(2b) loopback WS upgrade with NO Sec-WebSocket-Protocol header at all → still upgrades (unaffected by the fix)", !!loopbackNoProto);
  loopbackNoProto.close();
} finally {
  await appOff.close();
  dbOff.close();
}

// --- (3) remoteAccess ENABLED + non-loopback bindHost -----------------------------------------------
const GOOD_TOKEN = "test-valid-gateway-token";
let killCallsOn = 0;
const dbOn = new Db(path.join(TMP, "loom-on.db"));
dbOn.setPlatformConfig({ remoteAccess: { enabled: true, bindHost: "0.0.0.0" } });
const appOn = await buildServer({
  db: dbOn, pty: {}, sessions: { killAllWorkers: () => { killCallsOn++; return 0; } }, mcp: {}, orchMcp: {},
  platformMcp: {}, auditMcp: {}, userAuditMcp: {}, setupMcp: {}, runMcp: {}, control: {}, usageStatus: {},
  requestShutdown: () => {},
  verifyGatewayToken: (token) => token === GOOD_TOKEN,
});
try {
  // (3a) loopback request → unchanged (the hook's own early return), on both a writer and a Tier-1 read.
  const loopbackKill = await appOn.inject({ method: "POST", url: "/api/orchestration/kill" }); // default remoteAddress 127.0.0.1
  check("(3a) loopback POST /api/orchestration/kill (writer) → unchanged (200)", loopbackKill.statusCode === 200 && killCallsOn === 1);
  const loopbackRead = await appOn.inject({ method: "GET", url: "/api/projects" });
  check("(3a) loopback GET /api/projects (Tier-1 read) → unchanged (200, no token needed)", loopbackRead.statusCode === 200);

  // (3b) remote request to Tier-0 routes → 403: a writer, /internal/*, and an /mcp-* mount.
  const remoteKill = await appOn.inject({ method: "POST", url: "/api/orchestration/kill", remoteAddress: "203.0.113.5" });
  check("(3b) remote POST /api/orchestration/kill (writer) → 403", remoteKill.statusCode === 403 && killCallsOn === 1 /* not re-invoked */);
  const remoteInternal = await appOn.inject({ method: "POST", url: "/internal/shutdown", remoteAddress: "203.0.113.5" });
  check("(3b) remote POST /internal/shutdown → 403", remoteInternal.statusCode === 403);
  const remoteMcp = await appOn.inject({ method: "POST", url: "/mcp/some-session", remoteAddress: "203.0.113.5" });
  check("(3b) remote POST /mcp/:sessionId → 403", remoteMcp.statusCode === 403);
  const remoteWriterSameSurfaceOtherMethod = await appOn.inject({ method: "PUT", url: "/api/projects/proj1/vault/file", remoteAddress: "203.0.113.5" });
  check("(3b) remote PUT vault/file (writer sibling of a Tier-1 GET) → 403", remoteWriterSameSurfaceOtherMethod.statusCode === 403);
  // Belt-and-suspenders (CR follow-up on card 56ffe50a): the gateway-token ADMIN surface itself is NOT in
  // TIER_1_ROUTES, so it stays Tier-0 (loopback-only) by construction — even a VALID gateway token must
  // NOT authorize minting/rotating/revoking gateway tokens over a remote bind. Pinned here with the SAME
  // valid GOOD_TOKEN the (3c) Tier-1 checks below prove works elsewhere, so a future accidental addition
  // of these routes to TIER_1_ROUTES fails this test loudly.
  const remoteAdminEditWithValidToken = await appOn.inject({
    method: "POST", url: "/api/gateway-tokens/some-id", remoteAddress: "203.0.113.5",
    headers: { authorization: `Bearer ${GOOD_TOKEN}` },
  });
  check("(3b) remote POST /api/gateway-tokens/:id (admin) with a VALID gateway token → still 403 (Tier-0 default-deny)", remoteAdminEditWithValidToken.statusCode === 403);
  const remoteAdminDeleteWithValidToken = await appOn.inject({
    method: "DELETE", url: "/api/gateway-tokens/some-id", remoteAddress: "203.0.113.5",
    headers: { authorization: `Bearer ${GOOD_TOKEN}` },
  });
  check("(3b) remote DELETE /api/gateway-tokens/:id (admin) with a VALID gateway token → still 403 (Tier-0 default-deny)", remoteAdminDeleteWithValidToken.statusCode === 403);

  // (3c) remote request to a Tier-1 route → 401 without a token, 401 with a WRONG token, 200 with the valid one.
  const remoteReadNoToken = await appOn.inject({ method: "GET", url: "/api/projects", remoteAddress: "203.0.113.5" });
  check("(3c) remote GET /api/projects (Tier-1) with NO token → 401", remoteReadNoToken.statusCode === 401);
  const remoteReadBadToken = await appOn.inject({ method: "GET", url: "/api/projects", remoteAddress: "203.0.113.5", headers: { authorization: "Bearer wrong" } });
  check("(3c) remote GET /api/projects (Tier-1) with a WRONG token → 401", remoteReadBadToken.statusCode === 401);
  const remoteReadGoodToken = await appOn.inject({ method: "GET", url: "/api/projects", remoteAddress: "203.0.113.5", headers: { authorization: `Bearer ${GOOD_TOKEN}` } });
  check("(3c) remote GET /api/projects (Tier-1) with the VALID token → 200", remoteReadGoodToken.statusCode === 200);
  // A Tier-1 POST (answer/steer) behaves the same: blocked before the handler ever runs.
  const remoteInputNoToken = await appOn.inject({ method: "POST", url: "/api/sessions/nonexistent/input", remoteAddress: "203.0.113.5" });
  check("(3c) remote POST /api/sessions/:id/input (Tier-1) with NO token → 401", remoteInputNoToken.statusCode === 401);

  // (card 77ade04c nit) an UNMATCHED route (no registered handler at all) never falls back to
  // classifying on the raw resolved URL text — it's Tier 0 by construction, 403, no crash.
  const unmatched = await appOn.inject({ method: "GET", url: "/this/route/does/not/exist", remoteAddress: "203.0.113.5" });
  check("(3b) remote GET on an UNMATCHED route (undefined routeOptions.url) → Tier 0 (403), never throws", unmatched.statusCode === 403);

  // (card 77ade04c nit) the loopback peer check reads req.socket.remoteAddress directly — a REMOTE peer
  // can't spoof its way past the wall by sending an X-Forwarded-For claiming 127.0.0.1.
  const spoofedXff = await appOn.inject({ method: "POST", url: "/api/orchestration/kill", remoteAddress: "203.0.113.5", headers: { "x-forwarded-for": "127.0.0.1" } });
  check("(3b) a remote peer spoofing X-Forwarded-For: 127.0.0.1 is NOT treated as loopback (403)", spoofedXff.statusCode === 403 && killCallsOn === 1 /* not re-invoked */);

  // --- (3d) WS upgrade auth: the double-subprotocol contract (preferred) + ?token= (fallback) ----------
  // injectWS drives the request through the SAME fastify.routing() + onRequest hook chain a genuine
  // socket upgrade uses, so a REJECTED handshake (our hook 401s before the route ever hijacks the
  // socket) makes the client-side promise REJECT (no "101 Switching Protocols" ever comes back), and an
  // ACCEPTED one resolves to a real open `ws` client. Targets /ws/companion (its handler tolerates a
  // missing `deps.inApp`, unlike /ws/term's unconditional `deps.pty.subscribe`), with /ws/term covered
  // for the reject path (auth happens before either handler body ever runs).
  // The daemon's own CSRF/DNS-rebind onRequest hook (registered ahead of the trust-tier hook, so it runs
  // first) requires a loopback-shaped Host header on every request — a real browser always sends one, and
  // injectWS's hand-built request needs it supplied explicitly too, or every case here 403s from THAT
  // hook before ever reaching the trust-tier / token logic under test.
  const remoteSocket = { remoteAddress: "203.0.113.5" };
  const wsReject = async (wsPath, headers) => {
    try { const ws = await appOn.injectWS(wsPath, { headers: { host: "127.0.0.1", ...headers }, socket: remoteSocket }); ws.close(); return false; }
    catch { return true; }
  };
  const bearerProto = (token) => `${WS_GENERIC_SUBPROTOCOL}, ${WS_BEARER_PREFIX}${token}`;
  check("(3d) remote WS upgrade to /ws/companion with NO token → rejected before the 101 response",
    await wsReject("/ws/companion/sess1", {}));
  check("(3d) remote WS upgrade to /ws/term with NO token → rejected before the 101 response",
    await wsReject("/ws/term/sess1", {}));
  check("(3d) remote WS upgrade to /ws/fleet (C2, umbrella 1efde4ba) with NO token → rejected before the 101 response",
    await wsReject("/ws/fleet", {}));
  check("(3d) remote WS upgrade to /ws/companion with a [generic, bearer(WRONG)] offer → rejected",
    await wsReject("/ws/companion/sess1", { "sec-websocket-protocol": bearerProto("wrong-token") }));
  check("(3d) remote WS upgrade to /ws/companion with a BEARER-ONLY offer (no generic marker, valid token) → rejected outright",
    await wsReject("/ws/companion/sess1", { "sec-websocket-protocol": `${WS_BEARER_PREFIX}${GOOD_TOKEN}` }));
  check("(3d) remote WS upgrade to /ws/companion with a BAD ?token= query → rejected",
    await wsReject("/ws/companion/sess1?token=wrong-token", {}));

  // NOTE: the accepted-subprotocol-echo VALUE (that it's the generic marker, never the token) is asserted
  // directly against selectWsSubprotocol in section (4) above, not here — injectWS's client-side shim
  // doesn't parse the raw 101 response back into a `ws.protocol` a test could read. What THIS check
  // proves is the auth outcome: the handshake actually completes end-to-end for a conformant
  // [generic, bearer(valid)] offer.
  const wsOkProtocol = await appOn.injectWS("/ws/companion/sess1", { headers: { host: "127.0.0.1", "sec-websocket-protocol": bearerProto(GOOD_TOKEN) }, socket: remoteSocket });
  check("(3d) remote WS upgrade to /ws/companion with a VALID [generic, bearer] offer → accepted (real handshake completes)", !!wsOkProtocol);
  wsOkProtocol.close();

  const wsOkQuery = await appOn.injectWS(`/ws/companion/sess1?token=${GOOD_TOKEN}`, { headers: { host: "127.0.0.1" }, socket: remoteSocket });
  check("(3d) remote WS upgrade to /ws/companion with a VALID ?token= query fallback → accepted", !!wsOkQuery);
  wsOkQuery.close();

  const wsOkFleet = await appOn.injectWS("/ws/fleet", { headers: { host: "127.0.0.1", "sec-websocket-protocol": bearerProto(GOOD_TOKEN) }, socket: remoteSocket });
  check("(3d) remote WS upgrade to /ws/fleet with a VALID [generic, bearer] offer → accepted (real handshake completes)", !!wsOkFleet);
  wsOkFleet.close();

  // --- (3e) CR follow-up on card 42abca6a: a rejected bearer-only WS offer must share the SAME per-ip
  // rate-limit/lockout gate as any other 401 — NOT bypass it via an early return before isIpLockedOut/
  // allowRequest run. Plain .inject() (no real upgrade) is sufficient: the trust-tier onRequest hook
  // terminates a rejected/locked-out request before Fastify ever attempts to hijack the socket, so the
  // status code alone proves the gate. Uses a dedicated ip so its failure count can't mix with
  // 203.0.113.5's use elsewhere in this file. maxAttempts=5 is the default authFailLockout policy
  // (unset here, same as gateway/server.ts's own fallback).
  const spamIp = "203.0.113.77";
  const bearerOnlyRejectedHeaders = { host: "127.0.0.1", "sec-websocket-protocol": `${WS_BEARER_PREFIX}${GOOD_TOKEN}` };
  let allFiveWere401 = true;
  for (let i = 0; i < 5; i++) {
    const r = await appOn.inject({ method: "GET", url: "/ws/companion/sess-spam", remoteAddress: spamIp, headers: bearerOnlyRejectedHeaders });
    if (r.statusCode !== 401) allFiveWere401 = false;
  }
  check("(3e) 5 rejected bearer-only WS offers from one ip each 401 (folded into the rate-limited path, each counted as an auth failure)", allFiveWere401);
  const sixthFromSameIp = await appOn.inject({ method: "GET", url: "/ws/companion/sess-spam", remoteAddress: spamIp, headers: bearerOnlyRejectedHeaders });
  check("(3e) the 6th rejected bearer-only offer from the SAME ip is now LOCKED OUT (429) — proves the DoS-cap bypass the CR flagged is closed", sixthFromSameIp.statusCode === 429);
} finally {
  await appOn.close();
  dbOn.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — routeTier default-denies every non-listed LIVE-derived route, the hook stays dormant (byte-identical) when remoteAccess is disabled, a loopback request is unchanged when enabled, and a remote request 403s Tier-0 / 401s-then-200s Tier-1 by token."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
