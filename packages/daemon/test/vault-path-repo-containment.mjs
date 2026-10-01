import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 5ba4412d — code review finding on 6a48b759: `checkVaultPathUpdate`'s alias check was EQUALITY-only,
// so the vault auto-committer's real hazard (`git add .` over a whole code repo, or the versioner
// git-initing a vault that embeds a code repo as a gitlink) was still reachable two ways 6a48b759 never
// covered:
//   (1) SUBDIR/CONTAINMENT — vaultPath = <repoPath>/docs (or any subfolder, existing or not): the vault
//       auto-committer's `resolveVaultRepoContext` (vault/versioner.ts) resolves a vault subfolder up to
//       its `git rev-parse --show-toplevel` root, then `git add .`s the WHOLE code tree. The REVERSE case
//       (a repo INSIDE the vault, vaultPath = parent of repoPath) makes the versioner git-init the parent
//       and embed the code repo as a gitlink.
//   (2) CREATE-PATH ASYMMETRY — REST POST /api/projects, platform project_create, and setup project_create
//       accepted vaultPath === repoPath (or any alias/containment) for a code repo outright: 6a48b759 only
//       guarded the UPDATE-shaped surfaces (rebind/unbind), never create.
// The fix is ONE shared predicate, `checkVaultPathRepoContainment` (projects/vault-path.ts), checked by
// PATH CONTAINMENT (never git-invoked on the vaultPath candidate itself, which may not exist yet) in BOTH
// directions against every code-repo path a project could alias (the effective repoPath, when real and
// distinct from vaultPath, plus every `repos` registry entry) — called from `checkVaultPathUpdate` (so
// every one of 6a48b759's four UPDATE surfaces inherits it for free) AND newly from the three CREATE
// surfaces named above. HERMETIC + CLAUDE-FREE + NETWORK-FREE, modeled on vault-path-update-guard.mjs /
// tilde-expansion.mjs.
//
// Proves the DoD:
//   PART A — UPDATE path (manager project_update, sessions/service.ts): (A1) rebinding vaultPath to a
//            SUBFOLDER of repoPath → REJECTED; (A2) rebinding vaultPath to the PARENT of repoPath (repo
//            nested inside vault) → REJECTED; (A3) rebinding vaultPath to a subfolder of a REGISTERED
//            `repos` entry (not the primary repoPath) → REJECTED; (A4) a genuinely distinct rebind still
//            SUCCEEDS (regression); (A5) the vault-only-by-design exemption (repoPath===vaultPath) still
//            SUCCEEDS re-asserting itself even as a "subfolder" of its own path (i.e. itself) — not a new
//            case, just confirming the containment check doesn't regress it.
//   PART B — UPDATE path light coverage on setup/platform/REST (symmetry): subdir → REJECTED.
//   PART C — CREATE path: REST POST /api/projects, platform project_create, setup project_create each
//            reject vaultPath===repoPath (exact alias, the asymmetry this card names), vaultPath as a
//            SUBFOLDER of repoPath, and vaultPath as the PARENT of repoPath — while a genuinely distinct
//            vaultPath still creates successfully (regression), and the vault-only branch (no repoPath)
//            is UNAFFECTED (exemption).
//   PART D — CREATE path, REST `repos` registry entries: a `repos` entry supplied on the SAME create call
//            whose path is a subfolder of / contains the candidate vaultPath is also REJECTED.
//
// Run: 1) build (turbo builds shared first), 2) node test/vault-path-repo-containment.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-vaultpath-contain-${Date.now()}-${process.pid}`);
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

// A code repo nested ONE level under its OWN dedicated parent dir (never directly under os.tmpdir()), so
// `path.dirname(repoPath)` is a real, existing directory that contains NOTHING ELSE this test cares about —
// the "repo nested inside vault" direction needs a real parent to point vaultPath at.
const mkRepoWithParent = (tag) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), `loom-vaultpath-contain-parent-${tag}-`));
  const repo = path.join(parent, "repo");
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, "README.md"), `# ${tag}\n`);
  execSync(`git init -q`, { cwd: repo });
  commitAll(repo, "init", "-c user.email=r@loom -c user.name=r");
  return { repo, parent };
};

const now = new Date().toISOString();
const cleanupDirs = [tmpHome];
const pty = { enqueueStdin: () => ({ delivered: false }) };

try {
  // =====================================================================================================
  // PART A — UPDATE path containment on MANAGER project_update (sessions/service.ts)
  // =====================================================================================================
  {
    const db = new Db(path.join(tmpHome, "manager.db"));
    const svc = new SessionService(db, pty, new OrchestrationControl());

    const { repo: codeRepo, parent: codeRepoParent } = mkRepoWithParent("mgr");
    cleanupDirs.push(codeRepoParent);
    const separateVault = path.join(tmpHome, "mgr-contain-vault");
    db.insertProject({ id: "pMgrContain", name: "MgrContain", repoPath: codeRepo, vaultPath: separateVault, config: {}, createdAt: now, archivedAt: null, reserved: false, repos: [] });

    const { repo: secondaryRepo, parent: secondaryParent } = mkRepoWithParent("mgr-secondary");
    cleanupDirs.push(secondaryParent);
    db.insertProject({ id: "pMgrContainRegistry", name: "MgrContainRegistry", repoPath: codeRepo, vaultPath: separateVault, config: {}, createdAt: now, archivedAt: null, reserved: false, repos: [{ key: "secondary", path: secondaryRepo }] });

    for (const [sid, pid] of [["CA1", "pMgrContain"], ["CA2", "pMgrContainRegistry"]]) {
      db.insertAgent({ id: `a${sid}`, projectId: pid, name: "Mgr", startupPrompt: "", position: 0, profileId: null });
      db.insertSession({
        id: sid, projectId: pid, agentId: `a${sid}`, engineSessionId: null, title: null, cwd: tmpHome,
        processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
        lastError: null, role: "manager", parentSessionId: null,
      });
    }

    // (A1) rebind vaultPath to a SUBFOLDER of repoPath → REJECTED (subdir/containment).
    let a1Err = null;
    try { await svc.updateProjectStructural("CA1", "pMgrContain", { vaultPath: path.join(codeRepo, "docs") }); }
    catch (e) { a1Err = e instanceof Error ? e.message : String(e); }
    check("(A1) manager project_update rebinding vaultPath to a SUBFOLDER of repoPath → rejected", typeof a1Err === "string" && /is inside the code repo at/.test(a1Err));
    check("(A1) rejected subdir rebind left vaultPath UNCHANGED", db.getProject("pMgrContain").vaultPath === separateVault);

    // (A2) rebind vaultPath to the PARENT of repoPath (repo nested inside vault) → REJECTED.
    let a2Err = null;
    try { await svc.updateProjectStructural("CA1", "pMgrContain", { vaultPath: codeRepoParent }); }
    catch (e) { a2Err = e instanceof Error ? e.message : String(e); }
    check("(A2) manager project_update rebinding vaultPath to the PARENT of repoPath → rejected", typeof a2Err === "string" && /would contain the code repo at/.test(a2Err));
    check("(A2) rejected parent-containment rebind left vaultPath UNCHANGED", db.getProject("pMgrContain").vaultPath === separateVault);

    // (A3) rebind vaultPath to a SUBFOLDER of a REGISTERED repos entry (not the primary repoPath) → REJECTED.
    let a3Err = null;
    try { await svc.updateProjectStructural("CA2", "pMgrContainRegistry", { vaultPath: path.join(secondaryRepo, "notes") }); }
    catch (e) { a3Err = e instanceof Error ? e.message : String(e); }
    check("(A3) manager project_update rebinding vaultPath to a SUBFOLDER of a registered repo → rejected", typeof a3Err === "string" && /is inside the code repo at/.test(a3Err));
    check("(A3) rejected registry-subdir rebind left vaultPath UNCHANGED", db.getProject("pMgrContainRegistry").vaultPath === separateVault);

    // (A4) rebind vaultPath to a genuinely DISTINCT, unrelated path → SUCCEEDS (regression).
    const distinctVault = path.join(tmpHome, "mgr-contain-distinct-vault");
    const a4 = await svc.updateProjectStructural("CA1", "pMgrContain", { vaultPath: distinctVault });
    check("(A4) manager project_update rebinding vaultPath to a DISTINCT unrelated path → succeeds", !a4.error && a4.vaultPath === distinctVault);

    db.close();
  }

  // =====================================================================================================
  // PART B — UPDATE path containment, light coverage on SETUP / PLATFORM / REST (symmetry).
  // =====================================================================================================
  {
    const db = new Db(path.join(tmpHome, "setup-contain.db"));
    const { repo: codeRepo } = mkRepoWithParent("setup-contain");
    cleanupDirs.push(path.dirname(codeRepo));
    const separateVault = path.join(tmpHome, "setup-contain-vault");
    db.insertProject({ id: "pSetupContain", name: "SetupContain", repoPath: codeRepo, vaultPath: separateVault, config: {}, createdAt: now, archivedAt: null, reserved: false, repos: [] });

    class SeamHost extends createSeamHost(PtyHost) { stop() {} }
    const events = { onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); }, onBusy(id, busy) { db.setBusy(id, busy); }, onContextStats() {}, onRateLimited() {}, onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); } };
    const host = new SeamHost(events);
    const svc = new SessionService(db, host, new OrchestrationControl());
    const router = new SetupMcpRouter(db, svc);
    const server = router.buildServer();
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "vaultpath-contain-setup-test", version: "0" });
    await client.connect(clientT);
    const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

    // (B1) rebind vaultPath to a SUBFOLDER of repoPath → REJECTED.
    const b1 = await call("project_update", { projectId: "pSetupContain", vaultPath: path.join(codeRepo, "docs") });
    check("(B1) setup project_update rebinding vaultPath to a SUBFOLDER of repoPath → rejected", typeof b1.error === "string" && /is inside the code repo at/.test(b1.error));
    check("(B1) rejected subdir rebind left vaultPath UNCHANGED", db.getProject("pSetupContain").vaultPath === separateVault);

    await client.close();
    db.close();
  }
  {
    const db = new Db(path.join(tmpHome, "platform-contain.db"));
    const { repo: codeRepo } = mkRepoWithParent("platform-contain");
    cleanupDirs.push(path.dirname(codeRepo));
    const separateVault = path.join(tmpHome, "platform-contain-vault");
    db.insertProject({ id: "pPlatContain", name: "PlatContain", repoPath: codeRepo, vaultPath: separateVault, config: {}, createdAt: now, archivedAt: null, reserved: false, repos: [] });

    class SeamHost extends createSeamHost(PtyHost) { stop() {} }
    const events = { onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); }, onBusy(id, busy) { db.setBusy(id, busy); }, onContextStats() {}, onRateLimited() {}, onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); } };
    const host = new SeamHost(events);
    const svc = new SessionService(db, host, new OrchestrationControl());
    const router = new PlatformMcpRouter(db, svc);
    const server = router.buildServer();
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "vaultpath-contain-platform-test", version: "0" });
    await client.connect(clientT);
    const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

    // (C1) rebind vaultPath to a SUBFOLDER of repoPath → REJECTED.
    const c1 = await call("project_update", { projectId: "pPlatContain", vaultPath: path.join(codeRepo, "docs") });
    check("(C1) platform project_update rebinding vaultPath to a SUBFOLDER of repoPath → rejected", typeof c1.error === "string" && /is inside the code repo at/.test(c1.error));
    check("(C1) rejected subdir rebind left vaultPath UNCHANGED", db.getProject("pPlatContain").vaultPath === separateVault);

    await client.close();
    db.close();
  }
  {
    const db = new Db(path.join(tmpHome, "rest-contain.db"));
    const { repo: codeRepo } = mkRepoWithParent("rest-contain");
    cleanupDirs.push(path.dirname(codeRepo));
    const separateVault = path.join(tmpHome, "rest-contain-vault");
    db.insertProject({ id: "pRestContain", name: "RestContain", repoPath: codeRepo, vaultPath: separateVault, config: {}, createdAt: now, archivedAt: null, reserved: false, repos: [] });

    const stub = {};
    const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, control: stub, usageStatus: stub });
    try {
      // (D1) rebind vaultPath to a SUBFOLDER of repoPath → 400.
      const d1 = await app.inject({ method: "PATCH", url: "/api/projects/pRestContain", payload: { vaultPath: path.join(codeRepo, "docs") } });
      check("(D1) REST PATCH rebinding vaultPath to a SUBFOLDER of repoPath → 400", d1.statusCode === 400);
      check("(D1) error names the containment refusal", /is inside the code repo at/.test(d1.json().error ?? ""));
      check("(D1) rejected subdir rebind left vaultPath UNCHANGED", db.getProject("pRestContain").vaultPath === separateVault);
    } finally {
      db.close();
    }
  }

  // =====================================================================================================
  // PART C — CREATE path: REST POST /api/projects, platform project_create, setup project_create.
  // =====================================================================================================
  {
    const db = new Db(path.join(tmpHome, "rest-create.db"));
    const stub = {};
    const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, control: stub, usageStatus: stub });
    try {
      const { repo: codeRepo1, parent: codeRepoParent1 } = mkRepoWithParent("rest-create-exact");
      cleanupDirs.push(codeRepoParent1);
      const exact = await app.inject({ method: "POST", url: "/api/projects", payload: { name: "RestCreateExact", repoPath: codeRepo1, vaultPath: codeRepo1 } });
      check("(E1) POST /api/projects with vaultPath===repoPath (exact alias) → 400", exact.statusCode === 400);
      check("(E1) error names the containment refusal", /equals\/aliases the code repo at/.test(exact.json().error ?? ""));

      const { repo: codeRepo2, parent: codeRepoParent2 } = mkRepoWithParent("rest-create-subdir");
      cleanupDirs.push(codeRepoParent2);
      const subdir = await app.inject({ method: "POST", url: "/api/projects", payload: { name: "RestCreateSubdir", repoPath: codeRepo2, vaultPath: path.join(codeRepo2, "docs") } });
      check("(E2) POST /api/projects with vaultPath a SUBFOLDER of repoPath → 400", subdir.statusCode === 400);
      check("(E2) error names the containment refusal", /is inside the code repo at/.test(subdir.json().error ?? ""));

      const { repo: codeRepo3, parent: codeRepoParent3 } = mkRepoWithParent("rest-create-parent");
      cleanupDirs.push(codeRepoParent3);
      const parentCase = await app.inject({ method: "POST", url: "/api/projects", payload: { name: "RestCreateParent", repoPath: codeRepo3, vaultPath: codeRepoParent3 } });
      check("(E3) POST /api/projects with vaultPath the PARENT of repoPath → 400", parentCase.statusCode === 400);
      check("(E3) error names the containment refusal", /would contain the code repo at/.test(parentCase.json().error ?? ""));

      const { repo: codeRepo4, parent: codeRepoParent4 } = mkRepoWithParent("rest-create-distinct");
      cleanupDirs.push(codeRepoParent4);
      const distinctVault = path.join(tmpHome, "rest-create-distinct-vault");
      const distinct = await app.inject({ method: "POST", url: "/api/projects", payload: { name: "RestCreateDistinct", repoPath: codeRepo4, vaultPath: distinctVault } });
      check("(E4) POST /api/projects with a genuinely DISTINCT vaultPath → 201 (regression)", distinct.statusCode === 201);
      check("(E4) stored vaultPath is the distinct path", distinct.json().vaultPath === distinctVault);

      // (E5) vault-only create (no repoPath) is UNAFFECTED by the containment check (exemption).
      const vaultOnlyDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-vaultpath-contain-vaultonly-"));
      cleanupDirs.push(vaultOnlyDir);
      const vaultOnly = await app.inject({ method: "POST", url: "/api/projects", payload: { name: "RestCreateVaultOnly", vaultPath: vaultOnlyDir } });
      check("(E5) vault-only create (no repoPath) → 201 (exemption unaffected)", vaultOnly.statusCode === 201);
    } finally {
      db.close();
    }
  }
  {
    const db = new Db(path.join(tmpHome, "platform-create.db"));
    class SeamHost extends createSeamHost(PtyHost) { stop() {} }
    const events = { onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); }, onBusy(id, busy) { db.setBusy(id, busy); }, onContextStats() {}, onRateLimited() {}, onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); } };
    const host = new SeamHost(events);
    const svc = new SessionService(db, host, new OrchestrationControl());
    const router = new PlatformMcpRouter(db, svc);
    const server = router.buildServer();
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "vaultpath-contain-platform-create-test", version: "0" });
    await client.connect(clientT);
    const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

    const { repo: codeRepo, parent: codeRepoParent } = mkRepoWithParent("platform-create-exact");
    cleanupDirs.push(codeRepoParent);
    const f1 = await call("project_create", { name: "PlatCreateExact", repoPath: codeRepo, vaultPath: codeRepo });
    check("(F1) platform project_create with vaultPath===repoPath → error", typeof f1.error === "string" && /equals\/aliases the code repo at/.test(f1.error));

    const distinctVault = path.join(tmpHome, "platform-create-distinct-vault");
    const f2 = await call("project_create", { name: "PlatCreateDistinct", repoPath: codeRepo, vaultPath: distinctVault });
    check("(F2) platform project_create with a genuinely DISTINCT vaultPath → succeeds (regression)", !f2.error && f2.vaultPath === distinctVault);

    await client.close();
    db.close();
  }
  {
    const db = new Db(path.join(tmpHome, "setup-create.db"));
    class SeamHost extends createSeamHost(PtyHost) { stop() {} }
    const events = { onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); }, onBusy(id, busy) { db.setBusy(id, busy); }, onContextStats() {}, onRateLimited() {}, onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); } };
    const host = new SeamHost(events);
    const svc = new SessionService(db, host, new OrchestrationControl());
    const router = new SetupMcpRouter(db, svc);
    const server = router.buildServer();
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "vaultpath-contain-setup-create-test", version: "0" });
    await client.connect(clientT);
    const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

    const { repo: codeRepo, parent: codeRepoParent } = mkRepoWithParent("setup-create-exact");
    cleanupDirs.push(codeRepoParent);
    const g1 = await call("project_create", { name: "SetupCreateExact", repoPath: codeRepo, vaultPath: codeRepo });
    check("(G1) setup project_create with vaultPath===repoPath → error", typeof g1.error === "string" && /equals\/aliases the code repo at/.test(g1.error));

    // (G2) the vault-only branch (no repoPath) still works — exemption unaffected.
    const vaultOnlyDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-vaultpath-contain-setup-vaultonly-"));
    cleanupDirs.push(vaultOnlyDir);
    const g2 = await call("project_create", { name: "SetupCreateVaultOnly", vaultPath: vaultOnlyDir });
    check("(G2) setup project_create vault-only (no repoPath) → succeeds (exemption unaffected)", !g2.error && g2.vaultPath === vaultOnlyDir);

    await client.close();
    db.close();
  }

  // =====================================================================================================
  // PART D — CREATE path, REST `repos` registry entries: a registry entry supplied on the SAME create
  // call is just as real a code repo as repoPath — must be containment-checked too.
  // =====================================================================================================
  {
    const db = new Db(path.join(tmpHome, "rest-create-registry.db"));
    const stub = {};
    const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, control: stub, usageStatus: stub });
    try {
      const { repo: primaryRepo, parent: primaryParent } = mkRepoWithParent("rest-create-reg-primary");
      cleanupDirs.push(primaryParent);
      const { repo: secondaryRepo, parent: secondaryParent } = mkRepoWithParent("rest-create-reg-secondary");
      cleanupDirs.push(secondaryParent);

      // (H1) vaultPath is a SUBFOLDER of the `repos` SECONDARY entry (not the primary repoPath) → 400.
      const h1 = await app.inject({
        method: "POST", url: "/api/projects",
        payload: { name: "RestCreateRegistrySubdir", repoPath: primaryRepo, vaultPath: path.join(secondaryRepo, "notes"), repos: [{ key: "secondary", path: secondaryRepo }] },
      });
      check("(H1) POST /api/projects with vaultPath a SUBFOLDER of a `repos` entry → 400", h1.statusCode === 400);
      check("(H1) error names the containment refusal", /is inside the code repo at/.test(h1.json().error ?? ""));

      // (H2) vaultPath genuinely distinct from BOTH primary and the registry entry → 201 (regression).
      const distinctVault = path.join(tmpHome, "rest-create-reg-distinct-vault");
      const h2 = await app.inject({
        method: "POST", url: "/api/projects",
        payload: { name: "RestCreateRegistryDistinct", repoPath: primaryRepo, vaultPath: distinctVault, repos: [{ key: "secondary", path: secondaryRepo }] },
      });
      check("(H2) POST /api/projects with a vaultPath distinct from both repoPath and registry → 201 (regression)", h2.statusCode === 201);
    } finally {
      db.close();
    }
  }
} finally {
  for (const d of cleanupDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — checkVaultPathRepoContainment closes the two gaps 6a48b759's equality-only alias check left open: a vaultPath that is a SUBFOLDER of a code repo (or a registered repos entry), and the reverse — a code repo nested INSIDE the vaultPath — are both refused on every UPDATE-shaped surface (manager/setup/platform/REST) AND, newly, on every CREATE-shaped surface (REST POST /api/projects, platform project_create, setup project_create), while a genuinely distinct vaultPath and the vault-only-by-design exemption both keep working — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
