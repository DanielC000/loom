import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 280b1e44 (SECURITY) — the per-session-token guard for the 8 first-party `/mcp*` routes
// (gateway/server.ts's onRequest hook, PtyHost.verifyMcpToken/isMcpReachable). Before this card, every
// `/mcp*` route treated the URL session id as the ONLY credential — and that id is PUBLIC (listable via
// unauthenticated GET /api/sessions), so any co-resident process could drive ANY session's MCP surface.
//
// Driven via buildServer + app.inject (HERMETIC + CLAUDE-FREE + NETWORK-FREE, like loopback-write-guard.mjs
// and trust-tier.mjs). Uses a REAL PtyHost (via the shared `_seam-host-fixture.mjs` fake-pty double, same
// as tool-attribution-join.mjs) so `spawn()`/`stop()` mint and track REAL Live.mcpToken entries — this is
// what lets (D)/(E)/(G) below prove the LIVENESS half of the guard, not just the token-match half.
//
// Covers:
//   (A) BACKWARD COMPAT: a test's bare `pty: {}` stub (no verifyMcpToken/isMcpReachable methods) → every
//       /mcp* route 401s (fails CLOSED on an absent method, never open — see the guard's own `?.` doc).
//   (B) each of the 8 first-party /mcp* route patterns, with NO Authorization header → 401, and the
//       stubbed router's own `handle` is NEVER invoked (proves the guard returns before reply.hijack()).
//   (C) a WRONG token (well-formed, but not this session's) → 401.
//   (D) a token that is valid for a DIFFERENT session, presented for THIS session's route → 401 (the
//       credential must be scoped to the exact session it names, not merely "any real token").
//   (E) a LIVE session's own CORRECT token → reaches the real handler (proven via the stub's own marker).
//   (F) LIVENESS: a session that was spawned then STOPPED (exited) keeps its OLD Live entry with
//       `alive:false` (host.ts's own documented "never removed from `this.live`" invariant) — even
//       presenting that session's own still-remembered, still-token-matching credential → 401. Proves
//       isMcpReachable is a REAL second check, not redundant with verifyMcpToken.
//   (G) the isLoomDev() gate on /mcp-platform's OWN resolveRole (mcp/platform.ts) — independent of this
//       gateway hook, which is deliberately identity+liveness-only (role gates stay in the routers).
import fs from "node:fs";
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

const TMP = mkdtempManaged("loom-mcp-auth-guard-");
process.env.LOOM_HOME = TMP;
const PORT = 45718 + (process.pid % 900); // non-4317, low-collision — mirrors loopback-write-guard.mjs's own note
process.env.LOOM_PORT = String(PORT);
const sandboxHome = path.join(TMP, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const now = new Date().toISOString();
const H = { host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}` };
const authH = (bearer) => (bearer ? { ...H, authorization: `Bearer ${bearer}` } : H);

// The 8 first-party route templates, each with a router-stub `reached` counter so a 401 vs "reached the
// real handler" is distinguishable without needing each router's own real logic.
const ROUTES = [
  { pattern: "/mcp/:sessionId", depKey: "mcp" },
  { pattern: "/mcp-orch/:sessionId", depKey: "orchMcp" },
  { pattern: "/mcp-platform/:sessionId", depKey: "platformMcp" },
  { pattern: "/mcp-audit/:sessionId", depKey: "auditMcp" },
  { pattern: "/mcp-user-audit/:sessionId", depKey: "userAuditMcp" },
  { pattern: "/mcp-setup/:sessionId", depKey: "setupMcp" },
  { pattern: "/mcp-operator/:sessionId", depKey: "operatorMcp" },
  { pattern: "/mcp-run/:sessionId", depKey: "runMcp" },
];
const reachedCounts = {};
const mkRouterStub = (depKey) => ({
  handle: async (_req, res) => { reachedCounts[depKey] = (reachedCounts[depKey] ?? 0) + 1; res.statusCode = 299; res.end("reached"); },
});
const routerStubs = Object.fromEntries(ROUTES.map((r) => [r.depKey, mkRouterStub(r.depKey)]));

let appNoStub, appReal, db, host;
try {
  db = new Db(path.join(TMP, "loom.db"));
  db.insertProject({ id: "p1", name: "P1", repoPath: TMP, vaultPath: TMP, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "a1", projectId: "p1", name: "a", startupPrompt: "x", position: 0 });
  const mkSession = (id, role) => db.insertSession({
    id, projectId: "p1", agentId: "a1", engineSessionId: null, title: null, cwd: TMP,
    processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role,
  });
  mkSession("S1", "worker");
  mkSession("S2", "worker");
  mkSession("SDEAD", "worker");

  // ===================== (A) backward compat: a bare `{}` pty stub =====================
  appNoStub = await buildServer({
    db, pty: {}, sessions: {}, control: {}, usageStatus: {}, requestShutdown: () => {},
    ...routerStubs,
  });
  for (const { pattern } of ROUTES) {
    const url = pattern.replace(":sessionId", "S1");
    const res = await appNoStub.inject({ method: "POST", url, headers: authH("anything"), payload: {} });
    check(`(A) ${pattern} with a bare {} pty stub (no verifyMcpToken/isMcpReachable) → 401 (fail closed, never open)`, res.statusCode === 401);
  }
  await appNoStub.close();
  appNoStub = undefined;

  // ===================== real PtyHost: mint real tokens via spawn() =====================
  class TestPtyHost extends createSeamHost(PtyHost) {
    createPty(opts, hookToken, mcpToken) {
      return super.createPty(opts, hookToken, mcpToken);
    }
  }
  host = new TestPtyHost({ onEngineSessionId() {}, onBusy() {}, onRateLimited() {}, onExit() {}, onContextStats() {} });
  const spawnOpts = (id) => ({ sessionId: id, cwd: TMP, permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {}, role: "worker" });
  host.spawn(spawnOpts("S1"));
  host.spawn(spawnOpts("S2"));
  host.spawn(spawnOpts("SDEAD"));
  const tokenS1 = host.live.get("S1").mcpToken;
  const tokenS2 = host.live.get("S2").mcpToken;
  const tokenDead = host.live.get("SDEAD").mcpToken;
  check("setup: S1/S2/SDEAD each minted a real, distinct mcpToken", !!tokenS1 && !!tokenS2 && !!tokenDead && new Set([tokenS1, tokenS2, tokenDead]).size === 3);
  // (F) LIVENESS setup: stop SDEAD — its Live entry survives with alive:false (host.ts's own documented
  // "never removed from this.live on exit" invariant), keeping the SAME mcpToken.
  host.stop("SDEAD", "hard");
  check("setup: SDEAD's Live entry survives stop() (alive:false, NOT removed from the map)", host.live.get("SDEAD")?.alive === false && host.live.get("SDEAD")?.mcpToken === tokenDead);

  appReal = await buildServer({
    db, pty: host, sessions: {}, control: {}, usageStatus: {}, requestShutdown: () => {},
    ...routerStubs,
  });

  // ===================== (B) every route, no credential → 401, handler never reached =====================
  for (const { pattern, depKey } of ROUTES) {
    const before = reachedCounts[depKey] ?? 0;
    const url = pattern.replace(":sessionId", "S1");
    const res = await appReal.inject({ method: "POST", url, headers: H, payload: {} });
    check(`(B) ${pattern} with NO Authorization header → 401`, res.statusCode === 401);
    check(`(B) ${pattern} with NO Authorization header → the real router's handle() was NEVER invoked`, (reachedCounts[depKey] ?? 0) === before);
  }

  // ===================== (C) a wrong (well-formed but incorrect) token → 401 =====================
  {
    const res = await appReal.inject({ method: "POST", url: "/mcp/S1", headers: authH("00000000-0000-0000-0000-000000000000"), payload: {} });
    check("(C) /mcp/S1 with a WRONG (well-formed) token → 401", res.statusCode === 401);
  }

  // ===================== (D) a token valid for a DIFFERENT session → 401 =====================
  {
    const res = await appReal.inject({ method: "POST", url: "/mcp/S1", headers: authH(tokenS2), payload: {} });
    check("(D) /mcp/S1 presented with S2's OWN valid token → 401 (a token is scoped to the exact session it names)", res.statusCode === 401);
  }

  // ===================== (E) POSITIVE CONTROL: the correct token for a LIVE session reaches the handler ====
  for (const { pattern, depKey } of ROUTES) {
    const before = reachedCounts[depKey] ?? 0;
    const url = pattern.replace(":sessionId", "S1");
    const res = await appReal.inject({ method: "POST", url, headers: authH(tokenS1), payload: {} });
    check(`(E) POSITIVE CONTROL: ${pattern} with S1's OWN correct token → reaches the real handler (299)`, res.statusCode === 299);
    check(`(E) POSITIVE CONTROL: ${pattern} handle() was invoked exactly once`, (reachedCounts[depKey] ?? 0) === before + 1);
  }

  // ===================== (F) LIVENESS: an exited (stopped) session's own still-matching token → 401 =====
  {
    const res = await appReal.inject({ method: "POST", url: "/mcp/SDEAD", headers: authH(tokenDead), payload: {} });
    check("(F) LIVENESS: an exited session's OWN still-token-matching credential → 401 (isMcpReachable, not just verifyMcpToken)", res.statusCode === 401);
  }

  // ===================== (G) isLoomDev() gates /mcp-platform's OWN resolveRole =====================
  {
    delete process.env.LOOM_DEV;
    db.insertSession({
      id: "SPLAT", projectId: "p1", agentId: "a1", engineSessionId: null, title: null, cwd: TMP,
      processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
      lastError: null, role: "platform",
    });
    const router = new PlatformMcpRouter(db, {}, {}, {});
    check("(G) PlatformMcpRouter.resolveRole refuses a REAL role:platform session when LOOM_DEV is unset", router.resolveRole("SPLAT") === null);
    process.env.LOOM_DEV = "1";
    check("(G) PlatformMcpRouter.resolveRole accepts the SAME session once LOOM_DEV=1", router.resolveRole("SPLAT")?.id === "SPLAT");
    delete process.env.LOOM_DEV;
  }
} finally {
  try { await appNoStub?.close(); } catch { /* ignore */ }
  try { await appReal?.close(); } catch { /* ignore */ }
  try { host?.stop("S1", "hard"); } catch { /* ignore */ }
  try { host?.stop("S2", "hard"); } catch { /* ignore */ }
  db?.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the per-session-token guard on every first-party /mcp* route (card 280b1e44) fails CLOSED with a bare pty stub, 401s every one of the 8 patterns with no/wrong/cross-session credential without ever invoking the real router handler, accepts the exact right session-scoped token (positive control), refuses an exited-but-unarchived session's own still-matching token (the liveness half, distinct from the token-match half), and PlatformMcpRouter's OWN resolveRole independently gates on isLoomDev()."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
