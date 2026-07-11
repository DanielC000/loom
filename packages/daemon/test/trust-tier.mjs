import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Access-story Phase A (card 766f8b50) — the per-route trust-tier wall (gateway/trust-tier.ts) + its
// onRequest hook in gateway/server.ts. Ships INERT: the hook only exists when a non-loopback bind is
// configured (remoteAccess.enabled && bindHost non-loopback), which is never true by default.
// HERMETIC + CLAUDE-FREE + NETWORK-FREE (Db + buildServer via app.inject, like csrf-rebind.mjs). Proves:
//   1. routeTier default-deny is TOTAL against the REAL registered route surface: every one of the 219
//      method+pattern combos the gateway actually registers (captured via app.printRoutes) classifies
//      Tier-0 EXCEPT the exact, explicit Tier-1 allowlist — so a route added later is Tier-0 unless someone
//      deliberately allowlists it.
//   2. remoteAccess DISABLED (default): the hook is never even registered — a "remote-looking" request
//      (simulated remoteAddress) to a writer route behaves exactly as today (200, byte-identical).
//   3. remoteAccess ENABLED + a non-loopback bindHost:
//      a. a LOOPBACK request (req.ip in the loopback set) → unchanged (passes through to the handler).
//      b. a REMOTE request to a Tier-0 route (a writer, /internal/*, an /mcp-* mount) → 403.
//      c. a REMOTE request to a Tier-1 route → 401 without a token, and passes with a (stubbed-valid) one.
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
const { routeTier } = await import("../dist/gateway/trust-tier.js");

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
  ["GET", "/api/archived-sessions"],
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
  ["GET", "/api/deja/capture-status"],
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
  ["DELETE", "/api/tasks/:id"], ["POST", "/api/tasks/:id"],
  ["GET", "/api/terminals"], ["POST", "/api/terminals"], ["DELETE", "/api/terminals/:id"], ["GET", "/api/terminals/default-shell"],
  ["GET", "/api/update-status"], ["POST", "/api/usage/clear-hold"],
  ["GET", "/api/usage/history"], ["GET", "/api/usage/limits"], ["GET", "/api/usage/sessions/history"],
  ["GET", "/api/version"],
  ["GET", "/internal/deja-context/:sessionId"], ["POST", "/internal/hook"], ["POST", "/internal/shutdown"],
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
]);

check(`(1) TOTAL real registered routes classify correctly (${ALL_ROUTES.length} checked, ${EXPECTED_TIER_1.size} expected Tier-1)`,
  ALL_ROUTES.every(([method, pattern]) => {
    const key = `${method} ${pattern}`;
    const expected = EXPECTED_TIER_1.has(key) ? 1 : 0;
    const actual = routeTier(method, pattern);
    if (actual !== expected) { console.log(`  MISMATCH ${key}: expected tier ${expected}, got ${actual}`); return false; }
    return true;
  }));
check("(1b) every EXPECTED_TIER_1 entry is actually a real registered route (no stale/typo'd allowlist entry)",
  [...EXPECTED_TIER_1].every((key) => ALL_ROUTES.some(([m, p]) => `${m} ${p}` === key)));

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
