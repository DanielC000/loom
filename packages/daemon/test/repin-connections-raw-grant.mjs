import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Pins the invariant that keeps the two grant-drift counts in agreement: SessionService's write-free
// resolveRepinSurface(...).patch.connections must deep-equal the agent's OWN raw `connections` list.
//   - the human badge (GET /api/sessions/:id/grant-drift -> sessionGrantDrift) goes through resolveRepinSurface;
//   - the agent-facing note (connectionGrantDrift in connections/store.ts, via grantDriftNote in mcp/server.ts)
//     is a raw set diff against agent.connections.
// They agree only while resolveProfile applies no role/config filter to connections. If this test goes red,
// RE-BASE the agent note (connectionGrantDrift) on the same resolution as resolveRepinSurface.
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE: real Db, real SessionService on a fake pty seam (same fixture
// shape as grant-drift-route.mjs). resolveRepinSurface is private in TS only; JS reaches it directly.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-repinraw-${Date.now()}-${process.pid}`);
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
const { resolveConfig } = await import("@loom/shared");

const repo = path.join(os.tmpdir(), `loom-repinraw-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# repin-raw\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", "-c user.email=rr@loom -c user.name=rr");

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pR", name: "R", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
// A project carrying a config override (resolveConfig must not alter connections either).
db.insertProject({
  id: "pO", name: "O", repoPath: repo, vaultPath: repo, createdAt: now, archivedAt: null,
  config: { orchestration: { gateCommand: "echo gate" } },
});
db.insertProfile({
  id: "profR", name: "Rig", role: "manager", description: "", allowDelta: [], skills: null, model: null, icon: null,
  connections: [], capabilities: [], browserTesting: false, documentConversion: false, restrictedTools: false, noCommit: false, vaultWrite: false,
});

const conns = [
  db.createConnection({ name: "RawHttpA", host: "a.example.test", authScheme: "api-key", secretBlob: "x", projectId: null }).id,
  db.createConnection({ name: "RawHttpB", host: "b.example.test", authScheme: "api-key", secretBlob: "x", projectId: null }).id,
];
const GRANTS = [conns[1], conns[0]]; // deliberately non-sorted: order must survive too

db.insertAgent({ id: "agProf", projectId: "pR", name: "Profiled", startupPrompt: "", position: 0, profileId: "profR", connections: GRANTS });
db.insertAgent({ id: "agBare", projectId: "pR", name: "Profileless", startupPrompt: "", position: 1, profileId: null, connections: GRANTS });
db.insertAgent({ id: "agOver", projectId: "pO", name: "Overridden", startupPrompt: "", position: 0, profileId: "profR", connections: GRANTS });

class SeamHost extends createSeamHost(PtyHost) { isAlive() { return false; } }
const host = new SeamHost({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} });
const svc = new SessionService(db, host, new OrchestrationControl());

let n = 0;
const mkSession = (projectId, agentId, role) => {
  const id = `s-${++n}`;
  db.insertSession({
    id, projectId, agentId, engineSessionId: null, title: null, cwd: repo,
    processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
    role, parentSessionId: null,
  });
  return db.getSession(id);
};

const WHY = "re-base the agent note (connectionGrantDrift in connections/store.ts) on the same resolution as resolveRepinSurface";
const fixtures = [
  ["manager", "pR", "agProf", "manager"],
  ["worker", "pR", "agProf", "worker"],
  ["assistant (companion)", "pR", "agProf", "assistant"],
  ["platform-lead", "pR", "agProf", "platform"],
  ["profile-less agent (manager)", "pR", "agBare", "manager"],
  ["profile-less agent (worker)", "pR", "agBare", "worker"],
  ["project config override (manager)", "pO", "agOver", "manager"],
  ["project config override (worker)", "pO", "agOver", "worker"],
];
for (const [label, projectId, agentId, role] of fixtures) {
  const session = mkSession(projectId, agentId, role);
  const agent = db.getAgent(agentId);
  const config = resolveConfig(db.getProject(projectId).config);
  let got;
  try { got = svc.resolveRepinSurface(session, agent, config, true).patch.connections; } catch (e) { got = `THREW ${e?.message ?? e}`; }
  const ok = JSON.stringify(got) === JSON.stringify(agent.connections) && agent.connections.length === GRANTS.length;
  check(`${label}: resolveRepinSurface patch.connections deep-equals agent.connections${ok ? "" : ` — got ${JSON.stringify(got)}; ${WHY}`}`, ok);
}

db.close();
cleanupPathSync(tmpHome);
try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — resolveRepinSurface patch.connections == the agent's raw connections for every role/profile/config fixture."
  : `\n❌ ${failures} FAILURE(S) — ${WHY}.`);
process.exit(failures === 0 ? 0 : 1);
