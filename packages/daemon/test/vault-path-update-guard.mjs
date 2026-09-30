import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 6a48b759 (Full review lane 4 486d4238 M4): the manager's OWN project_update
// (sessions/service.ts `updateProjectStructural`) wrote `patch.vaultPath` RAW — no expandTilde, no
// validateVaultPath (absolute), no vault-only unbind refusal, and no alias check. The setup + platform
// project_update surfaces already ran a real rebind through validateVaultPath (card 96c4b245 — see
// vault-path-absolute.mjs) but, unlike the REST PATCH twin, neither refused an explicit `vaultPath:""`
// that would strand a VAULT-ONLY project (no separate repoPath to fall back on), and NEITHER checked
// whether a rebind ALIASES repoPath itself (REST/platform's existing registry re-check only ever
// compared a REGISTRY ENTRY against repoPath/vaultPath, never vaultPath against repoPath directly) — the
// most damaging failure the card names: "a vaultPath aliasing repoPath points the vault auto-committer
// (git add -A) at the code repo". This fix introduces ONE shared guard, `checkVaultPathUpdate`
// (projects/vault-path.ts), used by ALL FOUR project_update-shaped write surfaces (REST PATCH, the
// manager, setup, platform) — so a rebind/unbind now validates identically everywhere, including the
// alias check (reusing `validateRepoRegistry`'s own registry logic + `repos.ts`'s path-normalization
// primitives for the direct repoPath comparison, not a second alias rule).
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
//   PART E — ALIAS CHECK on MANAGER: (E1) rebinding vaultPath to literally equal repoPath (a real git
//            repo) is REJECTED; (E2) rebinding to a genuinely distinct path still SUCCEEDS (regression);
//            (E3) a VAULT-ONLY project re-asserting vaultPath==repoPath (its own design) still SUCCEEDS
//            (the legitimate case the alias check must not break); (E4) rebinding vaultPath to alias a
//            REGISTERED `repos` entry (not the primary repoPath) is REJECTED via the shared
//            validateRepoRegistry check.
//   PART F — ALIAS CHECK on SETUP: (F1) direct repoPath alias REJECTED; (F2) the vault-only legitimate
//            case still SUCCEEDS.
//   PART G — ALIAS CHECK on PLATFORM: (G1) direct repoPath alias REJECTED (light coverage for symmetry —
//            platform already ran the registry-entries half of this via validateRepoRegistry).
//   PART H — ALIAS CHECK on REST PATCH: (H1) direct repoPath alias REJECTED (light coverage for symmetry).
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
  // =====================================================================================================
  // PART E — ALIAS CHECK on MANAGER project_update: a vaultPath rebind must not alias repoPath (unless
  // vault-only by design) or a registered `repos` entry (code-review ruling on card 6a48b759 — the
  // Failure line's most damaging case: "a vaultPath aliasing repoPath points the vault auto-committer
  // (git add -A) at the code repo").
  // =====================================================================================================
  {
    const db = new Db(path.join(tmpHome, "alias-manager.db"));
    const svc = new SessionService(db, pty, new OrchestrationControl());

    const codeRepo = mkRepo("alias-mgr-code");
    cleanupDirs.push(codeRepo);
    const separateVault = path.join(tmpHome, "alias-mgr-vault");
    db.insertProject({ id: "pAliasMgr", name: "AliasMgr", repoPath: codeRepo, vaultPath: separateVault, config: {}, createdAt: now, archivedAt: null, reserved: false, repos: [] });
    const vaultOnlyDir = mkVaultOnlyDir("alias-mgr");
    cleanupDirs.push(vaultOnlyDir);
    db.insertProject({ id: "pAliasMgrVaultOnly", name: "AliasMgrVaultOnly", repoPath: vaultOnlyDir, vaultPath: vaultOnlyDir, config: {}, createdAt: now, archivedAt: null, reserved: false, repos: [] });
    const secondaryRepo = mkRepo("alias-mgr-secondary");
    cleanupDirs.push(secondaryRepo);
    db.insertProject({ id: "pAliasMgrRegistry", name: "AliasMgrRegistry", repoPath: codeRepo, vaultPath: separateVault, config: {}, createdAt: now, archivedAt: null, reserved: false, repos: [{ key: "secondary", path: secondaryRepo }] });

    for (const [sid, pid] of [["MA1", "pAliasMgr"], ["MA2", "pAliasMgrVaultOnly"], ["MA3", "pAliasMgrRegistry"]]) {
      db.insertAgent({ id: `a${sid}`, projectId: pid, name: "Mgr", startupPrompt: "", position: 0, profileId: null });
      db.insertSession({
        id: sid, projectId: pid, agentId: `a${sid}`, engineSessionId: null, title: null, cwd: tmpHome,
        processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
        lastError: null, role: "manager", parentSessionId: null,
      });
    }

    // (E1) rebind vaultPath to literally equal repoPath (a real git repo) → REJECTED (alias).
    let e1Err = null;
    try { await svc.updateProjectStructural("MA1", "pAliasMgr", { vaultPath: codeRepo }); }
    catch (e) { e1Err = e instanceof Error ? e.message : String(e); }
    check("(E1) manager project_update rebinding vaultPath to equal repoPath → rejected (alias)", typeof e1Err === "string" && /aliases the project's repoPath/.test(e1Err));
    check("(E1) rejected alias rebind left vaultPath UNCHANGED", db.getProject("pAliasMgr").vaultPath === separateVault);

    // (E2) rebind vaultPath to a genuinely DISTINCT path → SUCCEEDS (regression: not every rebind aliases).
    const distinctVault = path.join(tmpHome, "alias-mgr-distinct-vault");
    const e2 = await svc.updateProjectStructural("MA1", "pAliasMgr", { vaultPath: distinctVault });
    check("(E2) manager project_update rebinding vaultPath to a DISTINCT path → succeeds", !e2.error && e2.vaultPath === distinctVault);

    // (E3) a VAULT-ONLY project re-asserting vaultPath == repoPath (its own design, not an unbind) →
    // SUCCEEDS — the legitimate case the alias check must not break.
    const e3 = await svc.updateProjectStructural("MA2", "pAliasMgrVaultOnly", { vaultPath: vaultOnlyDir });
    check("(E3) manager project_update re-asserting vaultPath==repoPath on a VAULT-ONLY project → succeeds (legitimate design)", !e3.error && e3.vaultPath === vaultOnlyDir);

    // (E4) rebind vaultPath to alias a REGISTERED repos entry (not the primary repoPath) → REJECTED via
    // the shared validateRepoRegistry check — the SAME validator REST/platform already run, not a second rule.
    let e4Err = null;
    try { await svc.updateProjectStructural("MA3", "pAliasMgrRegistry", { vaultPath: secondaryRepo }); }
    catch (e) { e4Err = e instanceof Error ? e.message : String(e); }
    check("(E4) manager project_update rebinding vaultPath to alias a REGISTERED repo → rejected", typeof e4Err === "string" && /conflicts with the existing repos registry/.test(e4Err));
    check("(E4) rejected registry-alias rebind left vaultPath UNCHANGED", db.getProject("pAliasMgrRegistry").vaultPath === separateVault);

    db.close();
  }

  // =====================================================================================================
  // PART F — ALIAS CHECK on SETUP project_update (MCP) — the other surface named in the ruling.
  // =====================================================================================================
  {
    const db = new Db(path.join(tmpHome, "alias-setup.db"));
    const codeRepo = mkRepo("alias-setup-code");
    cleanupDirs.push(codeRepo);
    const separateVault = path.join(tmpHome, "alias-setup-vault");
    db.insertProject({ id: "pAliasSetup", name: "AliasSetup", repoPath: codeRepo, vaultPath: separateVault, config: {}, createdAt: now, archivedAt: null, reserved: false, repos: [] });
    const vaultOnlyDir = mkVaultOnlyDir("alias-setup");
    cleanupDirs.push(vaultOnlyDir);
    db.insertProject({ id: "pAliasSetupVaultOnly", name: "AliasSetupVaultOnly", repoPath: vaultOnlyDir, vaultPath: vaultOnlyDir, config: {}, createdAt: now, archivedAt: null, reserved: false, repos: [] });

    class SeamHost extends createSeamHost(PtyHost) { stop() {} }
    const events = { onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); }, onBusy(id, busy) { db.setBusy(id, busy); }, onContextStats() {}, onRateLimited() {}, onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); } };
    const host = new SeamHost(events);
    const svc = new SessionService(db, host, new OrchestrationControl());
    const router = new SetupMcpRouter(db, svc);
    const server = router.buildServer();
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "vaultpath-upd-alias-setup-test", version: "0" });
    await client.connect(clientT);
    const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

    // (F1) rebind vaultPath to equal repoPath (a real git repo) → REJECTED (alias).
    const f1 = await call("project_update", { projectId: "pAliasSetup", vaultPath: codeRepo });
    check("(F1) setup project_update rebinding vaultPath to equal repoPath → rejected (alias)", typeof f1.error === "string" && /aliases the project's repoPath/.test(f1.error));
    check("(F1) rejected alias rebind left vaultPath UNCHANGED", db.getProject("pAliasSetup").vaultPath === separateVault);

    // (F2) a VAULT-ONLY project re-asserting vaultPath == repoPath → SUCCEEDS (legitimate design).
    const f2 = await call("project_update", { projectId: "pAliasSetupVaultOnly", vaultPath: vaultOnlyDir });
    check("(F2) setup project_update re-asserting vaultPath==repoPath on a VAULT-ONLY project → succeeds (legitimate design)", !f2.error && f2.vaultPath === vaultOnlyDir);

    await client.close();
    db.close();
  }

  // =====================================================================================================
  // PART G — ALIAS CHECK on PLATFORM project_update (MCP) — light coverage for symmetry.
  // =====================================================================================================
  {
    const db = new Db(path.join(tmpHome, "alias-platform.db"));
    const codeRepo = mkRepo("alias-plat-code");
    cleanupDirs.push(codeRepo);
    const separateVault = path.join(tmpHome, "alias-plat-vault");
    db.insertProject({ id: "pAliasPlat", name: "AliasPlat", repoPath: codeRepo, vaultPath: separateVault, config: {}, createdAt: now, archivedAt: null, reserved: false, repos: [] });

    class SeamHost extends createSeamHost(PtyHost) { stop() {} }
    const events = { onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); }, onBusy(id, busy) { db.setBusy(id, busy); }, onContextStats() {}, onRateLimited() {}, onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); } };
    const host = new SeamHost(events);
    const svc = new SessionService(db, host, new OrchestrationControl());
    const router = new PlatformMcpRouter(db, svc);
    const server = router.buildServer();
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "vaultpath-upd-alias-platform-test", version: "0" });
    await client.connect(clientT);
    const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

    // (G1) rebind vaultPath to equal repoPath (a real git repo) → REJECTED (alias).
    const g1 = await call("project_update", { projectId: "pAliasPlat", vaultPath: codeRepo });
    check("(G1) platform project_update rebinding vaultPath to equal repoPath → rejected (alias)", typeof g1.error === "string" && /aliases the project's repoPath/.test(g1.error));
    check("(G1) rejected alias rebind left vaultPath UNCHANGED", db.getProject("pAliasPlat").vaultPath === separateVault);

    await client.close();
    db.close();
  }

  // =====================================================================================================
  // PART H — ALIAS CHECK on REST PATCH /api/projects/:id — light coverage for symmetry.
  // =====================================================================================================
  {
    const db = new Db(path.join(tmpHome, "alias-rest.db"));
    const codeRepo = mkRepo("alias-rest-code");
    cleanupDirs.push(codeRepo);
    const separateVault = path.join(tmpHome, "alias-rest-vault");
    db.insertProject({ id: "pAliasRest", name: "AliasRest", repoPath: codeRepo, vaultPath: separateVault, config: {}, createdAt: now, archivedAt: null, reserved: false, repos: [] });

    const stub = {};
    const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, control: stub, usageStatus: stub });
    try {
      // (H1) rebind vaultPath to equal repoPath (a real git repo) → REJECTED (alias).
      const h1 = await app.inject({ method: "PATCH", url: "/api/projects/pAliasRest", payload: { vaultPath: codeRepo } });
      check("(H1) REST PATCH rebinding vaultPath to equal repoPath → 400 (alias)", h1.statusCode === 400);
      check("(H1) error names the alias refusal", /aliases the project's repoPath/.test(h1.json().error ?? ""));
      check("(H1) rejected alias rebind left vaultPath UNCHANGED", db.getProject("pAliasRest").vaultPath === separateVault);
    } finally {
      db.close();
    }
  }

  // =====================================================================================================
  // PART I — PARTIAL-WRITE REGRESSION (code review on 87e21134): a call carrying BOTH a config patch and
  // an invalid vaultPath must not half-apply — the config write must not land while the overall call
  // still reports an error. Both manager and setup run the vaultPath guard (their only await) BEFORE any
  // write now, so this must hold for both.
  // =====================================================================================================
  {
    const db = new Db(path.join(tmpHome, "partial-write-manager.db"));
    const svc = new SessionService(db, pty, new OrchestrationControl());
    const seededConfig = { docLint: true };
    const repoBoundMgr = mkRepo("partial-mgr");
    cleanupDirs.push(repoBoundMgr);
    db.insertProject({ id: "pPartialMgr", name: "PartialMgr", repoPath: repoBoundMgr, vaultPath: path.join(tmpHome, "partial-mgr-vault"), config: seededConfig, createdAt: now, archivedAt: null, reserved: false, repos: [] });
    db.insertAgent({ id: "aPartialMgr", projectId: "pPartialMgr", name: "Mgr", startupPrompt: "", position: 0, profileId: null });
    db.insertSession({
      id: "MP1", projectId: "pPartialMgr", agentId: "aPartialMgr", engineSessionId: null, title: null, cwd: tmpHome,
      processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
      lastError: null, role: "manager", parentSessionId: null,
    });

    // (I1) a SINGLE call carrying a valid config change AND an invalid (relative) vaultPath → the WHOLE
    // call errors, and the config change must NOT have landed.
    let i1Err = null;
    try { await svc.updateProjectStructural("MP1", "pPartialMgr", { config: { docLint: false }, vaultPath: "Projects/Bad" }); }
    catch (e) { i1Err = e instanceof Error ? e.message : String(e); }
    check("(I1) manager project_update {config, invalid vaultPath} → the call errors", typeof i1Err === "string" && /absolute path/.test(i1Err));
    check("(I1) ★ the config half did NOT land (no partial apply)", db.getProject("pPartialMgr").config.docLint === true);

    db.close();
  }
  {
    const db = new Db(path.join(tmpHome, "partial-write-setup.db"));
    const seededConfig = { docLint: true };
    const repoBound = mkRepo("partial-setup");
    cleanupDirs.push(repoBound);
    db.insertProject({ id: "pPartialSetup", name: "PartialSetup", repoPath: repoBound, vaultPath: path.join(tmpHome, "partial-setup-vault"), config: seededConfig, createdAt: now, archivedAt: null, reserved: false, repos: [] });

    class SeamHost extends createSeamHost(PtyHost) { stop() {} }
    const events = { onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); }, onBusy(id, busy) { db.setBusy(id, busy); }, onContextStats() {}, onRateLimited() {}, onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); } };
    const host = new SeamHost(events);
    const svc = new SessionService(db, host, new OrchestrationControl());
    const router = new SetupMcpRouter(db, svc);
    const server = router.buildServer();
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "vaultpath-upd-partial-setup-test", version: "0" });
    await client.connect(clientT);
    const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

    // (I2) same shape on setup's project_update.
    const i2 = await call("project_update", { projectId: "pPartialSetup", config: { docLint: false }, vaultPath: "Projects/Bad" });
    check("(I2) setup project_update {config, invalid vaultPath} → the call errors", typeof i2.error === "string" && /absolute path/.test(i2.error));
    check("(I2) ★ the config half did NOT land (no partial apply)", db.getProject("pPartialSetup").config.docLint === true);

    await client.close();
    db.close();
  }
} finally {
  for (const d of cleanupDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — ONE shared vaultPath-update guard (checkVaultPathUpdate) now runs on every project_update-shaped write surface: the manager's own project_update (previously had NO vaultPath validation of any kind — relative paths stored raw, \"~\" never expanded, a vault-only unbind silently accepted, no alias check), setup's and platform's project_update (previously validated absolute-path but NOT the vault-only unbind refusal or the direct repoPath alias), and REST PATCH (unbind refusal already correct — proves the refactor onto the shared helper preserved it byte-identically; the direct repoPath alias check is NEW everywhere). A vault-only project's vaultPath can no longer be silently unbound or aliased onto repoPath/a registered repo, a relative/\"~\" rebind is rejected/expanded identically everywhere, the vault-only vaultPath==repoPath design case still works, and a repo-bound project's unbind/distinct-rebind still works everywhere (regression) — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
