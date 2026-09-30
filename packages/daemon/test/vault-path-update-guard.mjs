import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 6a48b759 (Full review lane 4 486d4238 M4): the manager's OWN project_update
// (sessions/service.ts `updateProjectStructural`) wrote `patch.vaultPath` RAW — no expandTilde, no
// validateVaultPath (absolute), and no vault-only unbind refusal. The setup + platform project_update
// surfaces already ran a real rebind through validateVaultPath (card 96c4b245 — see
// vault-path-absolute.mjs) but, unlike the REST PATCH twin, neither refused an explicit `vaultPath:""`
// that would strand a VAULT-ONLY project (no separate repoPath to fall back on). This fix introduces ONE
// shared guard, `checkVaultPathUpdate` (projects/vault-path.ts), used by ALL FOUR project_update-shaped
// write surfaces (REST PATCH, the manager, setup, platform) — so a rebind/unbind now validates
// identically everywhere.
//
// HERMETIC + CLAUDE-FREE + NETWORK-FREE. Proves the DoD:
//   PART A — MANAGER (SessionService.updateProjectStructural, the project_update MCP tool's backing
//            method): (A1) a vault-only project's vaultPath:"" unbind is REJECTED (previously silently
//            accepted — this surface had NO validation of any kind); (A2) a repo-bound project's
//            vaultPath:"" unbind still SUCCEEDS (regression); (A3) a relative vaultPath rebind is
//            REJECTED (previously stored raw); (A4) a "~/…" vaultPath rebind EXPANDS (previously never
//            expandTilde'd at all).
//   PART B — SETUP project_update (MCP): (B1) a vault-only project's vaultPath:"" unbind is REJECTED
//            (previously accepted — setup had validateVaultPath but no unbind refusal); (B2) a
//            repo-bound project's unbind still SUCCEEDS (regression).
//   PART C — PLATFORM project_update (MCP): (C1) a vault-only project's vaultPath:"" unbind is REJECTED
//            (previously accepted, same gap as setup); (C2) a repo-bound project's unbind still
//            SUCCEEDS (regression).
//   PART D — REST PATCH /api/projects/:id: (D1) a vault-only project's vaultPath:"" unbind is REJECTED
//            (this surface ALREADY did this — no prior test covered the actual refusal case, only the
//            regression "still succeeds on a repo-bound project" shape in mgmt-project-agent.mjs A2) —
//            proves the refactor onto the shared helper preserved it byte-identically.
//
// Run: 1) build (turbo builds shared first), 2) node test/vault-path-update-guard.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-vaultpath-upd-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_PORT = String(hermeticPort());
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

import { requireHermeticEnv } from "./_guard.mjs";
import { hermeticPort } from "./_hermetic-port.mjs";
import { commitAll } from "./_git-commit.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { SetupMcpRouter } = await import("../dist/mcp/setup.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

// A real, existing git repo — the "repo-bound" regression fixture (repoPath IS a git repo, so unbinding
// its separate vaultPath must stay allowed).
const mkRepo = (tag) => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), `loom-vaultpath-upd-${tag}-`));
  fs.writeFileSync(path.join(r, "README.md"), `# ${tag}\n`);
  execSync(`git init -q`, { cwd: r });
  commitAll(r, "init", "-c user.email=r@loom -c user.name=r");
  return r;
};

// A real, existing, NON-git directory — the "vault-only" fixture (repoPath === vaultPath, and repoPath
// is NOT a git repo, so it's a genuine bare vault-only folder with nothing to fall back on if unbound).
const mkVaultOnlyDir = (tag) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `loom-vaultpath-upd-vaultonly-${tag}-`));
  fs.writeFileSync(path.join(d, "note.md"), `# ${tag}\n`);
  return d;
};

const now = new Date().toISOString();
const cleanupDirs = [tmpHome];

const pty = { enqueueStdin: () => ({ delivered: false }) };

try {
  // =====================================================================================================
  // PART A — MANAGER (sessions/service.ts updateProjectStructural)
  // =====================================================================================================
  {
    const db = new Db(path.join(tmpHome, "manager.db"));
    const svc = new SessionService(db, pty, new OrchestrationControl());

    const vaultOnlyDir = mkVaultOnlyDir("mgr");
    cleanupDirs.push(vaultOnlyDir);
    db.insertProject({ id: "pMgrVaultOnly", name: "MgrVaultOnly", repoPath: vaultOnlyDir, vaultPath: vaultOnlyDir, config: {}, createdAt: now, archivedAt: null, reserved: false });
    const repoBound = mkRepo("mgr");
    cleanupDirs.push(repoBound);
    const repoBoundVault = path.join(tmpHome, "mgr-repobound-vault");
    db.insertProject({ id: "pMgrRepoBound", name: "MgrRepoBound", repoPath: repoBound, vaultPath: repoBoundVault, config: {}, createdAt: now, archivedAt: null, reserved: false });

    db.insertAgent({ id: "aMgr", projectId: "pMgrVaultOnly", name: "Mgr", startupPrompt: "", position: 0, profileId: null });
    db.insertSession({
      id: "M", projectId: "pMgrVaultOnly", agentId: "aMgr", engineSessionId: null, title: null, cwd: tmpHome,
      processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
      lastError: null, role: "manager", parentSessionId: null,
    });
    db.insertAgent({ id: "aMgr2", projectId: "pMgrRepoBound", name: "Mgr2", startupPrompt: "", position: 0, profileId: null });
    db.insertSession({
      id: "M2", projectId: "pMgrRepoBound", agentId: "aMgr2", engineSessionId: null, title: null, cwd: tmpHome,
      processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
      lastError: null, role: "manager", parentSessionId: null,
    });

    // (A1) vault-only project: vaultPath:"" unbind → REJECTED.
    let a1Err = null;
    try { await svc.updateProjectStructural("M", "pMgrVaultOnly", { vaultPath: "" }); }
    catch (e) { a1Err = e instanceof Error ? e.message : String(e); }
    check("(A1) manager project_update vaultPath:\"\" unbind on a VAULT-ONLY project → rejected", typeof a1Err === "string" && /vault-only project/.test(a1Err));
    check("(A1) rejected unbind left vaultPath UNCHANGED", db.getProject("pMgrVaultOnly").vaultPath === vaultOnlyDir);

    // (A2) repo-bound project: vaultPath:"" unbind → SUCCEEDS (regression).
    const a2 = await svc.updateProjectStructural("M2", "pMgrRepoBound", { vaultPath: "" });
    check("(A2) manager project_update vaultPath:\"\" unbind on a REPO-BOUND project → succeeds", !a2.error && a2.vaultPath === "");
    check("(A2) vaultPath actually cleared in the Db", db.getProject("pMgrRepoBound").vaultPath === "");

    // (A3) relative vaultPath rebind → REJECTED.
    let a3Err = null;
    try { await svc.updateProjectStructural("M2", "pMgrRepoBound", { vaultPath: "Projects/Renamed" }); }
    catch (e) { a3Err = e instanceof Error ? e.message : String(e); }
    check("(A3) manager project_update with a RELATIVE vaultPath → rejected", typeof a3Err === "string" && /absolute path/.test(a3Err));
    check("(A3) rejected relative rebind left vaultPath UNCHANGED", db.getProject("pMgrRepoBound").vaultPath === "");

    // (A4) "~/…" vaultPath rebind → EXPANDS (previously never expandTilde'd on this surface at all).
    const tildeTarget = path.join(sandboxHome, "mgr-tilde-vault");
    fs.mkdirSync(tildeTarget, { recursive: true });
    const a4 = await svc.updateProjectStructural("M2", "pMgrRepoBound", { vaultPath: "~/mgr-tilde-vault" });
    check("(A4) manager project_update expands a '~/…' vaultPath (no error)", !a4.error);
    check("(A4) stored vaultPath is the EXPANDED absolute path", db.getProject("pMgrRepoBound").vaultPath === tildeTarget);

    db.close();
  }

  // =====================================================================================================
  // PART B — SETUP project_update (mcp/setup.ts)
  // =====================================================================================================
  {
    const db = new Db(path.join(tmpHome, "setup.db"));
    const vaultOnlyDir = mkVaultOnlyDir("setup");
    cleanupDirs.push(vaultOnlyDir);
    db.insertProject({ id: "pSetupVaultOnly", name: "SetupVaultOnly", repoPath: vaultOnlyDir, vaultPath: vaultOnlyDir, config: {}, createdAt: now, archivedAt: null, reserved: false });
    const repoBound = mkRepo("setup");
    cleanupDirs.push(repoBound);
    const repoBoundVault = path.join(tmpHome, "setup-repobound-vault");
    db.insertProject({ id: "pSetupRepoBound", name: "SetupRepoBound", repoPath: repoBound, vaultPath: repoBoundVault, config: {}, createdAt: now, archivedAt: null, reserved: false });

    class SeamHost extends createSeamHost(PtyHost) { stop() {} }
    const events = { onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); }, onBusy(id, busy) { db.setBusy(id, busy); }, onContextStats() {}, onRateLimited() {}, onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); } };
    const host = new SeamHost(events);
    const svc = new SessionService(db, host, new OrchestrationControl());
    const router = new SetupMcpRouter(db, svc);
    const server = router.buildServer();
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "vaultpath-upd-setup-test", version: "0" });
    await client.connect(clientT);
    const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

    // (B1) vault-only project: vaultPath:"" unbind → REJECTED.
    const b1 = await call("project_update", { projectId: "pSetupVaultOnly", vaultPath: "" });
    check("(B1) setup project_update vaultPath:\"\" unbind on a VAULT-ONLY project → rejected", typeof b1.error === "string" && /vault-only project/.test(b1.error));
    check("(B1) rejected unbind left vaultPath UNCHANGED", db.getProject("pSetupVaultOnly").vaultPath === vaultOnlyDir);

    // (B2) repo-bound project: vaultPath:"" unbind → SUCCEEDS (regression).
    const b2 = await call("project_update", { projectId: "pSetupRepoBound", vaultPath: "" });
    check("(B2) setup project_update vaultPath:\"\" unbind on a REPO-BOUND project → succeeds", !b2.error && b2.vaultPath === "");

    await client.close();
    db.close();
  }

  // =====================================================================================================
  // PART C — PLATFORM project_update (mcp/platform.ts)
  // =====================================================================================================
  {
    const db = new Db(path.join(tmpHome, "platform.db"));
    const vaultOnlyDir = mkVaultOnlyDir("plat");
    cleanupDirs.push(vaultOnlyDir);
    db.insertProject({ id: "pPlatVaultOnly", name: "PlatVaultOnly", repoPath: vaultOnlyDir, vaultPath: vaultOnlyDir, config: {}, createdAt: now, archivedAt: null, reserved: false });
    const repoBound = mkRepo("plat");
    cleanupDirs.push(repoBound);
    const repoBoundVault = path.join(tmpHome, "plat-repobound-vault");
    db.insertProject({ id: "pPlatRepoBound", name: "PlatRepoBound", repoPath: repoBound, vaultPath: repoBoundVault, config: {}, createdAt: now, archivedAt: null, reserved: false });

    class SeamHost extends createSeamHost(PtyHost) { stop() {} }
    const events = { onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); }, onBusy(id, busy) { db.setBusy(id, busy); }, onContextStats() {}, onRateLimited() {}, onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); } };
    const host = new SeamHost(events);
    const svc = new SessionService(db, host, new OrchestrationControl());
    const router = new PlatformMcpRouter(db, svc);
    const server = router.buildServer();
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "vaultpath-upd-platform-test", version: "0" });
    await client.connect(clientT);
    const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

    // (C1) vault-only project: vaultPath:"" unbind → REJECTED.
    const c1 = await call("project_update", { projectId: "pPlatVaultOnly", vaultPath: "" });
    check("(C1) platform project_update vaultPath:\"\" unbind on a VAULT-ONLY project → rejected", typeof c1.error === "string" && /vault-only project/.test(c1.error));
    check("(C1) rejected unbind left vaultPath UNCHANGED", db.getProject("pPlatVaultOnly").vaultPath === vaultOnlyDir);

    // (C2) repo-bound project: vaultPath:"" unbind → SUCCEEDS (regression).
    const c2 = await call("project_update", { projectId: "pPlatRepoBound", vaultPath: "" });
    check("(C2) platform project_update vaultPath:\"\" unbind on a REPO-BOUND project → succeeds", !c2.error && c2.vaultPath === "");

    await client.close();
    db.close();
  }

  // =====================================================================================================
  // PART D — REST PATCH /api/projects/:id
  // =====================================================================================================
  {
    const db = new Db(path.join(tmpHome, "rest.db"));
    const vaultOnlyDir = mkVaultOnlyDir("rest");
    cleanupDirs.push(vaultOnlyDir);
    db.insertProject({ id: "pRestVaultOnly", name: "RestVaultOnly", repoPath: vaultOnlyDir, vaultPath: vaultOnlyDir, config: {}, createdAt: now, archivedAt: null, reserved: false });

    const stub = {};
    const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, control: stub, usageStatus: stub });
    try {
      // (D1) vault-only project: PATCH vaultPath:"" → REJECTED (400).
      const d1 = await app.inject({ method: "PATCH", url: "/api/projects/pRestVaultOnly", payload: { vaultPath: "" } });
      check("(D1) REST PATCH vaultPath:\"\" unbind on a VAULT-ONLY project → 400", d1.statusCode === 400);
      check("(D1) error names the vault-only unbind refusal", /vault-only project/.test(d1.json().error ?? ""));
      check("(D1) rejected unbind left vaultPath UNCHANGED", db.getProject("pRestVaultOnly").vaultPath === vaultOnlyDir);
    } finally {
      db.close();
    }
  }
} finally {
  for (const d of cleanupDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — ONE shared vaultPath-update guard (checkVaultPathUpdate) now runs on every project_update-shaped write surface: the manager's own project_update (previously had NO vaultPath validation of any kind — relative paths stored raw, \"~\" never expanded, a vault-only unbind silently accepted), setup's and platform's project_update (previously validated absolute-path but NOT the vault-only unbind refusal), and REST PATCH (already correct — proves the refactor onto the shared helper preserved it byte-identically). A vault-only project's vaultPath can no longer be silently unbound, a relative/\"~\" rebind is rejected/expanded identically everywhere, and a repo-bound project's unbind still works everywhere (regression) — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
