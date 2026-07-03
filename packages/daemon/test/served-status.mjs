import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// GAP 2 (manager tooling): the loom-orchestration `served_status` read — a deploy/served-state check so
// post-daemon_restart verification doesn't need curl. HERMETIC + CLAUDE-FREE, same shape as
// agent-get-append.mjs: a REAL Db + SessionService against a fake pty, and the REAL OrchestrationMcpRouter
// (manager role) over an in-process MCP InMemoryTransport (no HTTP, no daemon boot).
//
// Proves:
//   (1) with LOOM_WEB_DIST pointed at a staged dist dir holding assets/index-<hash>.js, served_status
//       returns that EXACT filename as `webBundle`, plus a `version` string and numeric uptimeSeconds;
//   (2) `liveSessionCount` reflects live sessions ACROSS ALL projects (not just the caller's own) — a
//       LIVE session in a FOREIGN project still counts, an EXITED one does not;
//   (3) with no web dist built/found (LOOM_WEB_DIST pointed at an empty dir), `webBundle` is null (never
//       throws) — the tool degrades gracefully instead of erroring.
//
// Run: 1) build (turbo builds shared first), 2) node test/served-status.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-svst-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

// Stage a fake web dist BEFORE importing dist (resolveWebDistDir reads LOOM_WEB_DIST at CALL time, but
// set it up front for clarity) — assets/index-<hash>.js is what Vite actually produces.
const fakeDist = path.join(tmpHome, "web-dist");
fs.mkdirSync(path.join(fakeDist, "assets"), { recursive: true });
fs.writeFileSync(path.join(fakeDist, "index.html"), "<html></html>");
fs.writeFileSync(path.join(fakeDist, "assets", "index-DEADBEEF.js"), "/* fake bundle */");
fs.writeFileSync(path.join(fakeDist, "assets", "index-DEADBEEF.css"), "/* fake styles */");
process.env.LOOM_WEB_DIST = fakeDist;

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const now = new Date().toISOString();
const db = new Db(path.join(tmpHome, "loom.db"));

db.insertProject({ id: "pMine", name: "Mine", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertProject({ id: "pOther", name: "Other", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertAgent({ id: "aMine", projectId: "pMine", name: "Dev", startupPrompt: "", position: 0, profileId: null });
db.insertAgent({ id: "aOther", projectId: "pOther", name: "OtherDev", startupPrompt: "", position: 0, profileId: null });
db.insertAgent({ id: "aOther2", projectId: "pOther", name: "OtherDev2", startupPrompt: "", position: 1, profileId: null });

db.insertSession({
  id: "M", projectId: "pMine", agentId: "aMine", engineSessionId: null, title: null, cwd: tmpHome,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: "manager", parentSessionId: null,
});
// A LIVE session in a FOREIGN project — must still count (cross-project by design).
db.insertSession({
  id: "sForeignLive", projectId: "pOther", agentId: "aOther", engineSessionId: null, title: null, cwd: tmpHome,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: "worker", parentSessionId: null,
});
// An EXITED session — must NOT count.
db.insertSession({
  id: "sForeignExited", projectId: "pOther", agentId: "aOther2", engineSessionId: null, title: null, cwd: tmpHome,
  processState: "exited", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: "worker", parentSessionId: null,
});

const pty = { enqueueStdin: () => ({ delivered: false }) };
const svc = new SessionService(db, pty, new OrchestrationControl());
const router = new OrchestrationMcpRouter(db, svc);
const server = router.buildServer("M", "manager");
const [clientT, serverT] = InMemoryTransport.createLinkedPair();
await server.connect(serverT);
const client = new Client({ name: "served-status-test", version: "0" });
await client.connect(clientT);
const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args ?? {} })).content[0].text);

try {
  // ===================== (1) + (2) staged dist + cross-project live count =====================
  const status = await call("served_status");
  check("(1) served_status returns the staged bundle filename", status.webBundle === "index-DEADBEEF.js");
  check("(1) served_status returns a version string", typeof status.version === "string" && status.version.length > 0);
  check("(1) served_status returns a numeric uptimeSeconds", typeof status.uptimeSeconds === "number" && status.uptimeSeconds >= 0);
  // "M" (live, pMine) + "sForeignLive" (live, pOther) count; "sForeignExited" (exited) does not.
  check("(2) liveSessionCount counts live sessions ACROSS projects, excluding non-live", status.liveSessionCount === 2);

  // ===================== (3) no dist found → webBundle null, no throw =====================
  const emptyDist = path.join(tmpHome, "empty-dist");
  fs.mkdirSync(emptyDist, { recursive: true });
  process.env.LOOM_WEB_DIST = emptyDist;
  const statusEmpty = await call("served_status");
  check("(3) an unbuilt/missing web dist → webBundle: null (no throw)", statusEmpty.webBundle === null);
} finally {
  db.close();
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* retry (WAL handle) */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — served_status returns the served web bundle's index-<hash>.js filename (or null when the dist isn't built/found, never throwing), a version string, uptimeSeconds, and a cross-project liveSessionCount."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
