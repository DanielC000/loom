import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 7aa0cc30: the LOOM_DEV Platform Lead's `project_update` (mcp/platform.ts) had NO `project.reserved`
// guard at all — only `project_archive` had one. At the time, `hasReservedProjectNamed` (db.ts) found the
// reserved home purely by NAME, so a Lead-driven RENAME via `project_update` would make the next boot's
// seed pass miss that lookup and mint a SECOND reserved home under the original name. Card 5dff8d08 later
// made EVERY runtime lookup across the daemon survive a rename (the stable id marker,
// resolveLiveSetupHome/resolveLivePlatformHome), so the refusal below is no longer a correctness
// workaround — it is kept anyway, DELIBERATELY, as a least-privilege choice: renaming a reserved home
// stays a human-REST-only administrative action, never surfaced on this or any agent-facing tool.
//
// Proves the DoD:
//   (1) renaming a RESERVED project via project_update is REFUSED, and the stored name is UNCHANGED;
//   (2) a SAME-NAME "rename" (name === current name) on a reserved project is a no-op PASS, not refused
//       — the guard is scoped to an actual name CHANGE, never a blanket block;
//   (3) a vaultPath-only edit to a RESERVED project still SUCCEEDS — the fix is name-scoped, not a
//       blanket refusal of every field;
//   (4) a rename of a NON-reserved project still SUCCEEDS (the ordinary, unaffected case);
//   (5) RED PROOF: reverting the guard reproduces the original bug (rename of a reserved project
//       silently succeeds) on the exact same fixture, then the guard is restored.
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic like project-rename-stale-prompt-lint.mjs: a REAL
// Db + SessionService against a FAKE pty, the REAL PlatformMcpRouter driven over in-process MCP
// InMemoryTransport (no HTTP).
//
// Run: 1) build (turbo builds shared first), 2) node test/platform-project-update-reserved-rename.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME (set BEFORE importing dist; paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-platform-reserved-rename-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const FIXTURE_PATH = path.join(os.tmpdir(), `loom-platform-reserved-rename-fixture-${Date.now()}-${process.pid}`);

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pHome", name: "Loom Platform", repoPath: FIXTURE_PATH, vaultPath: FIXTURE_PATH, config: {}, createdAt: now, archivedAt: null, reserved: true });
db.insertProject({ id: "pOrdinary", name: "Invest", repoPath: FIXTURE_PATH, vaultPath: FIXTURE_PATH, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertAgent({ id: "agentPL", projectId: "pHome", name: "Platform Lead", startupPrompt: "You are the Platform Lead.", position: 0, profileId: null });

const seedSession = (id, role, extra) => db.insertSession({
  id, projectId: extra?.projectId ?? "pOrdinary", agentId: extra?.agentId ?? "agentPL", engineSessionId: null, title: null,
  cwd: extra?.cwd ?? FIXTURE_PATH, processState: extra?.processState ?? "live", resumability: "unknown", busy: false,
  createdAt: now, lastActivity: now, lastError: null, role, parentSessionId: extra?.parent ?? null,
  worktreePath: extra?.worktreePath ?? null, branch: extra?.branch ?? null,
});
seedSession("PL", "platform", { projectId: "pHome" });

// Fake pty (no real claude). Same SeamHost shape as project-rename-stale-prompt-lint.mjs.
class SeamHost extends createSeamHost(PtyHost) {
  stop() {}
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());

const parse = (res) => JSON.parse(res.content[0].text);
const connect = async (router, sessionId) => {
  const server = router.buildServer(sessionId);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "platform-reserved-rename-test", version: "0" });
  await client.connect(clientT);
  return { client, call: async (name, args) => parse(await client.callTool({ name, arguments: args })) };
};

let newVault;
try {
  const plat = await connect(new PlatformMcpRouter(db, svc), "PL");

  // (1) Renaming the RESERVED home is refused; the stored name stays unchanged.
  const renameAttempt = await plat.call("project_update", { projectId: "pHome", name: "Renamed Platform" });
  check("(1) renaming a reserved project is refused (error present)", typeof renameAttempt.error === "string" && renameAttempt.error.length > 0);
  check("(1) stored name is unchanged after the refused rename", db.getProject("pHome").name === "Loom Platform");

  // (2) A same-name "rename" (no actual change) is a no-op PASS, not a refusal.
  const noopRename = await plat.call("project_update", { projectId: "pHome", name: "Loom Platform" });
  check("(2) a same-name patch on a reserved project succeeds (no-op, not refused)", !noopRename.error && noopRename.name === "Loom Platform");

  // (3) A vaultPath-only edit to the RESERVED project still succeeds — the fix is name-scoped.
  // fs.mkdtempSync (not a Date.now()-derived literal) so re-running this block never collides on a path.
  newVault = fs.mkdtempSync(path.join(os.tmpdir(), "loom-platform-reserved-rename-newvault-"));
  const vaultEdit = await plat.call("project_update", { projectId: "pHome", vaultPath: newVault });
  check("(3) a vaultPath-only edit to a reserved project still succeeds", !vaultEdit.error && vaultEdit.vaultPath === newVault);
  check("(3) the reserved project's name is still unchanged after the vaultPath edit", db.getProject("pHome").name === "Loom Platform");

  // (4) Renaming a NON-reserved project is entirely unaffected.
  const ordinaryRename = await plat.call("project_update", { projectId: "pOrdinary", name: "Investments" });
  check("(4) renaming a non-reserved project still succeeds", !ordinaryRename.error && ordinaryRename.name === "Investments");
} finally {
  db.close();
  for (const d of [FIXTURE_PATH, newVault]) { if (!d) continue; try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the Platform Lead's project_update refuses an actual NAME CHANGE on a reserved/system project — DELIBERATELY, a least-privilege choice (renaming stays human-REST-only), not because any runtime lookup would still break (card 5dff8d08 made them all survive a rename) — while leaving a same-name no-op, a vaultPath/repoPath/config edit, and a non-reserved rename all unaffected."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
