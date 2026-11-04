import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// @decision 6745e4bc round 2 — the route maps ONLY a known refusal (RepinGrantsRefusalError) to 409; an
// unexpected thrown error must surface as a 500, never swallowed into the same 409 the route used to
// return for everything.
//
// This is the GATEWAY-level half of repinSessionGrants's contract (the service-level functional contract
// lives in repin-session-grants.mjs): POST /api/sessions/:id/repin-grants maps the service's
// refusals/success to the right HTTP status.
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE: Part A drives the REAL SessionService (a real Db + a fake
// pty seam, same hermetic shape as repin-session-grants.mjs) through the REAL buildServer via app.inject —
// so the refusal paths exercised here (archived/stale-id, assistant role) are the REAL refusals, not a
// stub standing in for them. Part B swaps in a stub `sessions.repinSessionGrants` that throws a PLAIN
// Error (never RepinGrantsRefusalError) to prove the unexpected-error path reaches a 500.
//
// Run: 1) build (turbo builds shared first), 2) node test/repin-grants-gateway.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-repin-gateway-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
delete process.env.CLAUDE_CONFIG_DIR;

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { buildServer } = await import("../dist/gateway/server.js");

const repo = path.join(os.tmpdir(), `loom-repin-gateway-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# repin-grants-gateway\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", "-c user.email=rgg@loom -c user.name=rgg");

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pG", name: "G", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
db.insertProfile({
  id: "profG", name: "Rig", role: "manager", description: "", allowDelta: [], skills: null, model: null, icon: null,
  connections: [], capabilities: [], browserTesting: false, documentConversion: false, restrictedTools: false, noCommit: false, vaultWrite: false,
});
db.insertAgent({ id: "agentG", projectId: "pG", name: "Profiled", startupPrompt: "", position: 0, profileId: "profG" });

db.insertSession({
  id: "s-mgr", projectId: "pG", agentId: "agentG", engineSessionId: null, title: null, cwd: repo,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
  role: "manager", parentSessionId: null,
});
db.insertSession({
  id: "s-companion", projectId: "pG", agentId: "agentG", engineSessionId: null, title: null, cwd: repo,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
  role: "assistant", parentSessionId: null,
});
db.insertSession({
  id: "s-stale-pred", projectId: "pG", agentId: "agentG", engineSessionId: null, title: null, cwd: repo,
  processState: "exited", resumability: "dead", busy: false, createdAt: now, lastActivity: now, lastError: null,
  role: "manager", parentSessionId: null,
});
db.insertSession({
  id: "s-stale-succ", projectId: "pG", agentId: "agentG", engineSessionId: null, title: null, cwd: repo,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
  role: "manager", parentSessionId: null, recycledFrom: "s-stale-pred",
});

const UNKNOWN_SESSION = "00000000-0000-0000-0000-000000000000";

class SeamHost extends createSeamHost(PtyHost) {
  isAlive() { return false; }
}
const host = new SeamHost({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} });
const svc = new SessionService(db, host, new OrchestrationControl());

// ===================== Part A — the REAL SessionService, through the REAL route =====================
{
  const stub = {};
  const app = await buildServer({
    db, pty: stub, sessions: svc, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, userAuditMcp: stub,
    setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub, requestShutdown: () => {},
  });
  try {
    {
      const res = await app.inject({ method: "POST", url: `/api/sessions/${UNKNOWN_SESSION}/repin-grants` });
      check("(1) unknown id -> 404", res.statusCode === 404);
    }
    {
      const res = await app.inject({ method: "POST", url: `/api/sessions/s-companion/repin-grants` });
      const body = JSON.parse(res.payload);
      check("(2) an assistant (companion) row -> 409", res.statusCode === 409);
      check("(2) the 409 body surfaces the real refusal message (points at the companion route)", /upgrade/i.test(body.error ?? ""));
    }
    {
      const res = await app.inject({ method: "POST", url: `/api/sessions/s-stale-pred/repin-grants` });
      const body = JSON.parse(res.payload);
      check("(3) a stale (superseded-by-recycle-successor) row -> 409", res.statusCode === 409);
      check("(3) the 409 body names the successor id", (body.error ?? "").includes("s-stale-succ"));
    }
    {
      const res = await app.inject({ method: "POST", url: `/api/sessions/s-mgr/repin-grants` });
      const body = JSON.parse(res.payload);
      check("(4) a real manager row -> 200", res.statusCode === 200);
      check("(4) the 200 body carries {sessionId, session, diff}", body.sessionId === "s-mgr" && body.session?.id === "s-mgr" && typeof body.diff === "object");
    }
  } finally {
    try { await app.close(); } catch { /* ignore */ }
  }
}

// ===================== Part B — an UNEXPECTED (non-refusal) throw surfaces as a 500, never a 409 =====================
{
  const stub = {};
  const stubSessions = { repinSessionGrants() { throw new TypeError("boom — unexpected, not a RepinGrantsRefusalError"); } };
  const app = await buildServer({
    db, pty: stub, sessions: stubSessions, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, userAuditMcp: stub,
    setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub, requestShutdown: () => {},
  });
  try {
    const res = await app.inject({ method: "POST", url: `/api/sessions/s-mgr/repin-grants` });
    check("(5) an unexpected (non-refusal) thrown error -> 500, NEVER 409 (the route's old catch-all bug)", res.statusCode === 500);
    check("(5) a 500 is NOT the same status the refusal path returns (the fix actually discriminates)", res.statusCode !== 409);
  } finally {
    try { await app.close(); } catch { /* ignore */ }
  }
}

db.close();
cleanupPathSync(tmpHome);
try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — POST /api/sessions/:id/repin-grants: unknown id -> 404, a real assistant/stale-id refusal -> 409 (naming the successor on the stale case), a real manager row -> 200 {sessionId,session,diff}, and an UNEXPECTED (non-RepinGrantsRefusalError) throw -> 500, never swallowed into 409."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
