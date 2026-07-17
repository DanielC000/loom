import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Access-story Phase A (card 766f8b50) — the per-route trust-tier wall (gateway/trust-tier.ts) + its
// onRequest hook in gateway/server.ts. Ships INERT: the hook only exists when a non-loopback bind is
// configured (remoteAccess.enabled && bindHost non-loopback), which is never true by default.
// HERMETIC + CLAUDE-FREE + NETWORK-FREE (Db + buildServer via app.inject, like csrf-rebind.mjs). Proves:
//   1. routeTier default-deny is TOTAL against the REAL registered route surface: every one of the 220
//      method+pattern combos the gateway actually registers (captured via app.printRoutes) classifies
//      Tier-0 EXCEPT the exact, explicit Tier-1 allowlist — so a route added later is Tier-0 unless someone
//      deliberately allowlists it.
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
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "loom-trust-tier-"));
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

// --- (1) routeTier vs. the REAL registered route surface -------------------------------------------
// Captured once via a throwaway buildServer + app.printRoutes({commonPrefix:false}) and hand-verified
// against the task's Tier-1 spec (a matching pure-function list also lives in trust-tier.ts). HEAD/
// OPTIONS/TRACE are Fastify auto-added siblings of GET, not distinct handlers, so they're excluded here —
// same reasoning the hook itself doesn't need to special-case them (a HEAD probe of a Tier-1 GET is
// itself intended to be Tier-1; a HEAD/OPTIONS of a Tier-0 route is intended to stay Tier-0).
const ALL_ROUTES = [
  ["GET", "*"],
  ["DELETE", "/api/agents/:id"], ["POST", "/api/agents/:id"],
  ["GET", "/api/agents/:id/sessions"], ["POST", "/api/agents/:id/sessions"],
  ["GET", "/api/archived-sessions"], ["GET", "/api/archived-sessions/:id"],
  ["GET", "/api/audit/diff"], ["GET", "/api/audit/session/:id"], ["GET", "/api/audit/wave/:managerId"],
  ["GET", "/api/capabilities"], ["POST", "/api/capabilities"], ["DELETE", "/api/capabilities/:id"],
  ["DELETE", "/api/companion/:sessionId/grants"], ["GET", "/api/companion/:sessionId/grants"],
  ["POST", "/api/companion/:sessionId/grants"], ["PUT", "/api/companion/:sessionId/grants"],
  ["POST", "/api/companion/:sessionId/upgrade"],
  ["GET", "/api/companion/allowed-senders"], ["POST", "/api/companion/allowed-senders"],
  ["DELETE", "/api/companion/allowed-senders/:id"],
  ["GET", "/api/companion/bindings"], ["POST", "/api/companion/bindings"],
  ["DELETE", "/api/companion/bindings/:sessionId"],
  ["GET", "/api/companion/config"], ["POST", "/api/companion/config"],
  ["DELETE", "/api/companion/config/:sessionId"], ["GET", "/api/companion/config/:sessionId"],
  ["PUT", "/api/companion/config/:sessionId"],
  ["GET", "/api/companion/conversations/:sessionId"], ["GET", "/api/companion/conversations/:sessionId/:seq"],
  ["DELETE", "/api/companion/home"], ["GET", "/api/companion/home"], ["PUT", "/api/companion/home"],
  ["GET", "/api/companion/memory/:sessionId"],
  ["DELETE", "/api/companion/memory/:sessionId/:name"], ["GET", "/api/companion/memory/:sessionId/:name"],
  ["GET", "/api/companion/messages/:sessionId"],
  ["POST", "/api/companion/pairing"],
  ["GET", "/api/companion/prompt/:sessionId"], ["PUT", "/api/companion/prompt/:sessionId"],
  ["POST", "/api/companion/provision"],
  ["GET", "/api/companion/reminders/:sessionId"], ["DELETE", "/api/companion/reminders/:sessionId/:reminderId"],
  ["GET", "/api/companion/restricted-tools/:sessionId"], ["PUT", "/api/companion/restricted-tools/:sessionId"],
  ["GET", "/api/companion/skills/:sessionId"],
  ["DELETE", "/api/companion/skills/:sessionId/:name"], ["GET", "/api/companion/skills/:sessionId/:name"],
  ["GET", "/api/companion/voice-prefs/:sessionId"],
  ["GET", "/api/connections"], ["POST", "/api/connections"], ["DELETE", "/api/connections/:id"],
  ["POST", "/api/connections/:id/oauth/consent"], ["POST", "/api/connections/oauth"],
  ["DELETE", "/api/gateway-tokens/:tokenId"], ["GET", "/api/gateway-tokens"], ["POST", "/api/gateway-tokens"],
  ["POST", "/api/gateway-tokens/:tokenId"], ["POST", "/api/gateway-tokens/:tokenId/rotate"],
  ["DELETE", "/api/keys/:keyId"], ["POST", "/api/keys/:keyId"],
  ["POST", "/api/keys/:keyId/kill"], ["POST", "/api/keys/:keyId/rotate"],
  ["GET", "/api/orchestration/events"], ["POST", "/api/orchestration/kill"],
  ["POST", "/api/orchestration/pause"], ["POST", "/api/orchestration/resume"], ["GET", "/api/orchestration/status"],
  ["GET", "/api/platform/config"], ["PATCH", "/api/platform/config"], ["GET", "/api/platform/home"],
  ["GET", "/api/poll-jobs"], ["POST", "/api/poll-jobs"], ["DELETE", "/api/poll-jobs/:id"], ["POST", "/api/poll-jobs/:id"],
  ["GET", "/api/preset-prompt-suggestions"], ["POST", "/api/preset-prompt-suggestions"],
  ["POST", "/api/preset-prompt-suggestions/:id/adopt"], ["POST", "/api/preset-prompt-suggestions/:id/dismiss"],
  ["GET", "/api/preset-prompts"], ["POST", "/api/preset-prompts"],
  ["DELETE", "/api/preset-prompts/:id"], ["PUT", "/api/preset-prompts/:id"],
  ["GET", "/api/profiles"], ["POST", "/api/profiles"], ["DELETE", "/api/profiles/:id"], ["GET", "/api/profiles/:id"],
  ["PUT", "/api/profiles/:id"], ["POST", "/api/profiles/:id/adopt"], ["GET", "/api/profiles/:id/merge-preview"],
  ["POST", "/api/profiles/:id/reset"], ["GET", "/api/profiles/:id/update-diff"],
  ["GET", "/api/projects"], ["POST", "/api/projects"], ["DELETE", "/api/projects/:id"], ["PATCH", "/api/projects/:id"],
  ["GET", "/api/projects/:id/agents"], ["POST", "/api/projects/:id/agents"], ["GET", "/api/projects/:id/archive"],
  ["GET", "/api/projects/:id/board"], ["PUT", "/api/projects/:id/columns"], ["PATCH", "/api/projects/:id/config"],
  ["POST", "/api/projects/:id/git/branch"], ["GET", "/api/projects/:id/git/branches"],
  ["POST", "/api/projects/:id/git/checkout"], ["POST", "/api/projects/:id/git/commit"],
  ["GET", "/api/projects/:id/git/log"], ["POST", "/api/projects/:id/git/push"],
  ["GET", "/api/projects/:id/git/reference-repos/:index/log"],
  ["GET", "/api/projects/:id/keys"], ["POST", "/api/projects/:id/keys"],
  ["DELETE", "/api/projects/:id/permanent"], ["POST", "/api/projects/:id/restore"],
  ["GET", "/api/projects/:id/run-events"], ["GET", "/api/projects/:id/runs"], ["GET", "/api/projects/:id/runs/:runId"],
  ["POST", "/api/projects/:id/runs/:runId/cancel"], ["GET", "/api/projects/:id/runs/:runId/transcript"],
  ["GET", "/api/projects/:id/tasks"], ["POST", "/api/projects/:id/tasks"],
  ["GET", "/api/projects/:id/vault"], ["DELETE", "/api/projects/:id/vault/file"],
  ["GET", "/api/projects/:id/vault/file"], ["POST", "/api/projects/:id/vault/file"], ["PUT", "/api/projects/:id/vault/file"],
  ["GET", "/api/projects/:id/vault/raw"], ["GET", "/api/projects/archived"],
  ["GET", "/api/python/provisioning"], ["POST", "/api/python/provisioning/retry"],
  ["GET", "/api/questions"], ["GET", "/api/questions/:id"], ["POST", "/api/questions/:id/answer"],
  ["POST", "/api/runs"], ["GET", "/api/runs/:id"], ["POST", "/api/runs/:id/cancel"],
  ["GET", "/api/schedules"], ["POST", "/api/schedules"], ["DELETE", "/api/schedules/:id"],
  ["POST", "/api/schedules/:id"], ["POST", "/api/schedules/preview"],
  ["GET", "/api/sessions"], ["DELETE", "/api/sessions/:id/archive"], ["GET", "/api/sessions/:id/diff"],
  ["POST", "/api/sessions/:id/end"], ["POST", "/api/sessions/:id/fork"], ["POST", "/api/sessions/:id/input"],
  ["POST", "/api/sessions/:id/merge"], ["GET", "/api/sessions/:id/queue"], ["PATCH", "/api/sessions/:id/queue"],
  ["DELETE", "/api/sessions/:id/queue/:entryId"], ["PATCH", "/api/sessions/:id/queue/:entryId"],
  ["POST", "/api/sessions/:id/rate-limit/clear"], ["POST", "/api/sessions/:id/restore"],
  ["POST", "/api/sessions/:id/resume"], ["POST", "/api/sessions/:id/stop"], ["GET", "/api/sessions/:id/transcript"],
  ["GET", "/api/sessions/:id/wakes"], ["DELETE", "/api/sessions/:id/wakes/:wakeId"],
  ["GET", "/api/setup/home"],
  ["GET", "/api/skills"], ["POST", "/api/skills"], ["DELETE", "/api/skills/:name"], ["GET", "/api/skills/:name"],
  ["PUT", "/api/skills/:name"], ["POST", "/api/skills/:name/adopt"], ["GET", "/api/skills/:name/merge-preview"],
  ["POST", "/api/skills/:name/publish"], ["POST", "/api/skills/:name/reset"], ["GET", "/api/skills/:name/update-diff"],
  ["DELETE", "/api/tasks/:id"], ["GET", "/api/tasks/:id"], ["POST", "/api/tasks/:id"],
  ["GET", "/api/terminals"], ["POST", "/api/terminals"], ["DELETE", "/api/terminals/:id"], ["GET", "/api/terminals/default-shell"],
  ["GET", "/api/update-status"], ["POST", "/api/usage/clear-hold"],
  ["GET", "/api/usage/history"], ["GET", "/api/usage/limits"], ["GET", "/api/usage/sessions/history"],
  ["GET", "/api/version"],
  ["GET", "/api/webhook-endpoints"], ["POST", "/api/webhook-endpoints"],
  ["DELETE", "/api/webhook-endpoints/:id"], ["POST", "/api/webhook-endpoints/:id/enabled"],
  ["POST", "/hooks/:endpointPath"],
  ["POST", "/internal/hook"], ["POST", "/internal/shutdown"],
  ["POST", "/internal/test/seed"], ["POST", "/internal/update"],
  ["DELETE", "/mcp-audit/:sessionId"], ["GET", "/mcp-audit/:sessionId"], ["PATCH", "/mcp-audit/:sessionId"],
  ["POST", "/mcp-audit/:sessionId"], ["PUT", "/mcp-audit/:sessionId"],
  ["DELETE", "/mcp-orch/:sessionId"], ["GET", "/mcp-orch/:sessionId"], ["PATCH", "/mcp-orch/:sessionId"],
  ["POST", "/mcp-orch/:sessionId"], ["PUT", "/mcp-orch/:sessionId"],
  ["DELETE", "/mcp-platform/:sessionId"], ["GET", "/mcp-platform/:sessionId"], ["PATCH", "/mcp-platform/:sessionId"],
  ["POST", "/mcp-platform/:sessionId"], ["PUT", "/mcp-platform/:sessionId"],
  ["DELETE", "/mcp-run/:sessionId"], ["GET", "/mcp-run/:sessionId"], ["PATCH", "/mcp-run/:sessionId"],
  ["POST", "/mcp-run/:sessionId"], ["PUT", "/mcp-run/:sessionId"],
  ["DELETE", "/mcp-setup/:sessionId"], ["GET", "/mcp-setup/:sessionId"], ["PATCH", "/mcp-setup/:sessionId"],
  ["POST", "/mcp-setup/:sessionId"], ["PUT", "/mcp-setup/:sessionId"],
  ["DELETE", "/mcp-user-audit/:sessionId"], ["GET", "/mcp-user-audit/:sessionId"], ["PATCH", "/mcp-user-audit/:sessionId"],
  ["POST", "/mcp-user-audit/:sessionId"], ["PUT", "/mcp-user-audit/:sessionId"],
  ["DELETE", "/mcp/:sessionId"], ["GET", "/mcp/:sessionId"], ["PATCH", "/mcp/:sessionId"],
  ["POST", "/mcp/:sessionId"], ["PUT", "/mcp/:sessionId"],
  ["GET", "/oauth/callback"],
  ["GET", "/ws/companion/:sessionId"], ["GET", "/ws/term/:sessionId"],
];

const EXPECTED_TIER_1 = new Set([
  "GET /api/projects", "GET /api/sessions", "GET /api/sessions/:id/transcript", "GET /api/sessions/:id/diff",
  "GET /api/projects/:id/board", "GET /api/projects/:id/tasks", "GET /api/projects/:id/agents",
  "GET /api/agents/:id/sessions", "GET /api/sessions/:id/queue", "GET /api/sessions/:id/wakes",
  "GET /api/audit/session/:id", "GET /api/audit/wave/:managerId", "GET /api/audit/diff",
  "GET /api/usage/limits", "GET /api/usage/history", "GET /api/usage/sessions/history",
  "GET /api/projects/:id/vault", "GET /api/projects/:id/vault/file", "GET /api/projects/:id/vault/raw",
  "GET /api/questions", "GET /api/questions/:id",
  "POST /api/questions/:id/answer", "POST /api/sessions/:id/input", "POST /api/sessions/:id/end",
  "POST /api/sessions/:id/stop", "POST /api/sessions/:id/resume", "POST /api/sessions/:id/rate-limit/clear",
  "GET /ws/term/:sessionId", "GET /ws/companion/:sessionId",
  // Access-story Phase C (card 6bc02f50) follow-up on 77ade04c: reads a remote read-only UI needs.
  "GET /api/version", "GET /api/update-status", "GET /api/orchestration/status", "GET /api/orchestration/events",
  "GET /api/projects/:id/git/log", "GET /api/projects/:id/git/branches",
  "GET /api/projects/:id/git/reference-repos/:index/log",
  "GET /api/profiles", "GET /api/profiles/:id", "GET /api/skills", "GET /api/skills/:name",
  "GET /api/archived-sessions", "GET /api/archived-sessions/:id", "GET /api/projects/:id/archive", "GET /api/projects/archived",
  "GET /api/companion/:sessionId/grants", "GET /api/companion/allowed-senders", "GET /api/companion/bindings",
  "GET /api/companion/config", "GET /api/companion/config/:sessionId",
  "GET /api/companion/conversations/:sessionId", "GET /api/companion/conversations/:sessionId/:seq",
  "GET /api/companion/home", "GET /api/companion/memory/:sessionId", "GET /api/companion/memory/:sessionId/:name",
  "GET /api/companion/messages/:sessionId", "GET /api/companion/prompt/:sessionId",
  "GET /api/companion/reminders/:sessionId", "GET /api/companion/restricted-tools/:sessionId",
  "GET /api/companion/skills/:sessionId", "GET /api/companion/skills/:sessionId/:name",
  "GET /api/companion/voice-prefs/:sessionId",
]);

// Tier 2 (agent-tooling epic P5b, card 8fbedcac): the ONE fixed webhook-ingress pattern — PUBLIC,
// signature-gated, deliberately NOT Tier 1 (it never accepts the gateway token).
const EXPECTED_TIER_2 = new Set([
  "POST /hooks/:endpointPath",
]);

check(`(1) TOTAL real registered routes classify correctly (${ALL_ROUTES.length} checked, ${EXPECTED_TIER_1.size} expected Tier-1, ${EXPECTED_TIER_2.size} expected Tier-2)`,
  ALL_ROUTES.every(([method, pattern]) => {
    const key = `${method} ${pattern}`;
    const expected = EXPECTED_TIER_1.has(key) ? 1 : EXPECTED_TIER_2.has(key) ? 2 : 0;
    const actual = routeTier(method, pattern);
    if (actual !== expected) { console.log(`  MISMATCH ${key}: expected tier ${expected}, got ${actual}`); return false; }
    return true;
  }));
check("(1b) every EXPECTED_TIER_1 entry is actually a real registered route (no stale/typo'd allowlist entry)",
  [...EXPECTED_TIER_1].every((key) => ALL_ROUTES.some(([m, p]) => `${m} ${p}` === key)));
check("(1c) every EXPECTED_TIER_2 entry is actually a real registered route (no stale/typo'd allowlist entry)",
  [...EXPECTED_TIER_2].every((key) => ALL_ROUTES.some(([m, p]) => `${m} ${p}` === key)));
check("(1d) the webhook-endpoints ADMIN surface (a writer, not the ingress route) stays Tier-0 (loopback-only)",
  routeTier("GET", "/api/webhook-endpoints") === 0 && routeTier("POST", "/api/webhook-endpoints") === 0
  && routeTier("DELETE", "/api/webhook-endpoints/:id") === 0 && routeTier("POST", "/api/webhook-endpoints/:id/enabled") === 0);

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

// --- (2) remoteAccess DISABLED (default): the hook never registers; a "remote" request to a writer still runs ---
let killCallsOff = 0;
const dbOff = new Db(path.join(TMP, "loom-off.db"));
const appOff = await buildServer({
  db: dbOff, pty: {}, sessions: { killAllWorkers: () => { killCallsOff++; return 0; } }, mcp: {}, orchMcp: {},
  platformMcp: {}, auditMcp: {}, userAuditMcp: {}, setupMcp: {}, runMcp: {}, control: {}, usageStatus: {},
  requestShutdown: () => {},
});
try {
  const r = await appOff.inject({ method: "POST", url: "/api/orchestration/kill", remoteAddress: "203.0.113.5" });
  check("(2) remoteAccess disabled: a 'remote' POST /api/orchestration/kill still runs (200, byte-identical)", r.statusCode === 200 && killCallsOff === 1);

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

// cleanup (retry for the WAL handle on Windows)
for (let i = 0; i < 5; i++) { try { fs.rmSync(TMP, { recursive: true, force: true }); break; } catch { /* retry */ } }

console.log(failures === 0
  ? "\n✅ ALL PASS — routeTier default-denies every non-listed real route, the hook stays dormant (byte-identical) when remoteAccess is disabled, a loopback request is unchanged when enabled, and a remote request 403s Tier-0 / 401s-then-200s Tier-1 by token."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
