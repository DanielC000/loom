import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card b98957e9 (Code Review FIX ROUND, Major 1) — a vault-only project's invariant is "repoPath and
// vaultPath stay canonically paired" (LEAD ruling). Before this fix, REST PATCH and platform
// `project_update` cleared `vaultOnly` to `false` whenever EITHER field changed — including a
// vaultPath-ONLY move, directly contradicting the decision record's "never recomputed by a vaultPath-only
// edit" rule — while the manager's and setup's `project_update` never touched `vaultOnly` at ALL, so a
// vaultPath-only move on THOSE surfaces left a now-divergent pair stamped `vaultOnly: true` forever (the
// lockout direction: every future write through `checkVaultRepoTripleContainment`'s `pairingIsIntentional`
// exemption would then be judged against a FALSE premise).
//
// The fix routes every one of the four `project_update`-shaped write surfaces through ONE shared helper,
// `checkVaultOnlyOnUpdate` (projects/vault-path.ts), which enforces the ruling identically everywhere:
//   - a vaultPath-ONLY move that would UNPAIR a vault-only project is REFUSED outright (never silently
//     flips the fact to false, and never silently leaves it stale true).
//   - a repoPath rebind (REST/platform only — the only two surfaces that can ever touch repoPath) that
//     diverges the pair clears the fact to false in the SAME write (unchanged from before).
//   - moving repoPath AND vaultPath TOGETHER onto one new shared folder leaves the fact untouched (still
//     true) on every surface that can reach it.
//
// HERMETIC + CLAUDE-FREE + NETWORK-FREE. Proves the DoD: "the same vaultPath-only move, a repoPath-only
// rebind, and a move-both on ALL FOUR surfaces, asserting identical outcomes."
//
// Run: 1) build (turbo builds shared first), 2) node test/vault-only-update-asymmetry.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-vaultonly-asym-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_PORT = String(hermeticPort());

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

const mkRepo = (tag) => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), `loom-vaultonly-asym-repo-${tag}-`));
  fs.writeFileSync(path.join(r, "README.md"), `# ${tag}\n`);
  execSync(`git init -q`, { cwd: r });
  commitAll(r, "init", "-c user.email=r@loom -c user.name=r");
  return r;
};
const mkVaultOnlyDir = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `loom-vaultonly-asym-vo-${tag}-`));

const now = new Date().toISOString();
const cleanupDirs = [tmpHome];

const connectRouter = async (RouterClass, db) => {
  class SeamHost extends createSeamHost(PtyHost) { stop() {} }
  const events = { onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); }, onBusy(id, busy) { db.setBusy(id, busy); }, onContextStats() {}, onRateLimited() {}, onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); } };
  const host = new SeamHost(events);
  const svc = new SessionService(db, host, new OrchestrationControl());
  const router = new RouterClass(db, svc);
  const server = router.buildServer();
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "vaultonly-asym-test", version: "0" });
  await client.connect(clientT);
  return { client, call: async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text) };
};

try {
  // =====================================================================================================
  // PART A — VAULTPATH-ONLY MOVE that would UNPAIR a vault-only project → REFUSED on EVERY surface.
  // =====================================================================================================

  // --- A1: REST PATCH ---
  {
    const db = new Db(path.join(tmpHome, "a1-rest.db"));
    const vaultOnlyDir = mkVaultOnlyDir("a1");
    cleanupDirs.push(vaultOnlyDir);
    db.insertProject({ id: "pA1", name: "A1", repoPath: vaultOnlyDir, vaultPath: vaultOnlyDir, config: {}, createdAt: now, archivedAt: null, reserved: false, repos: [], vaultOnly: true });
    const stub = {};
    const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, control: stub, usageStatus: stub });
    const newVault = path.join(tmpHome, "a1-newvault");
    fs.mkdirSync(newVault, { recursive: true });
    const r = await app.inject({ method: "PATCH", url: "/api/projects/pA1", payload: { vaultPath: newVault } });
    check("(A1) REST PATCH vaultPath-only move that unpairs a vault-only project → 400 (refused)", r.statusCode === 400);
    check("(A1) ★ vaultPath left UNCHANGED by the refusal", db.getProject("pA1").vaultPath === vaultOnlyDir);
    check("(A1) ★ vaultOnly fact left UNCHANGED (still true — never silently cleared)", db.getProject("pA1").vaultOnly === true);
    db.close();
  }

  // --- A2: platform project_update ---
  {
    const db = new Db(path.join(tmpHome, "a2-platform.db"));
    const vaultOnlyDir = mkVaultOnlyDir("a2");
    cleanupDirs.push(vaultOnlyDir);
    db.insertProject({ id: "pA2", name: "A2", repoPath: vaultOnlyDir, vaultPath: vaultOnlyDir, config: {}, createdAt: now, archivedAt: null, reserved: false, repos: [], vaultOnly: true });
    const { client, call } = await connectRouter(PlatformMcpRouter, db);
    const newVault = path.join(tmpHome, "a2-newvault");
    fs.mkdirSync(newVault, { recursive: true });
    const r = await call("project_update", { projectId: "pA2", vaultPath: newVault });
    check("(A2) platform project_update vaultPath-only move that unpairs a vault-only project → refused", typeof r.error === "string");
    check("(A2) ★ vaultPath left UNCHANGED by the refusal", db.getProject("pA2").vaultPath === vaultOnlyDir);
    check("(A2) ★ vaultOnly fact left UNCHANGED (still true — never silently cleared)", db.getProject("pA2").vaultOnly === true);
    await client.close();
    db.close();
  }

  // --- A3: manager project_update (updateProjectStructural) ---
  {
    const db = new Db(path.join(tmpHome, "a3-manager.db"));
    const vaultOnlyDir = mkVaultOnlyDir("a3");
    cleanupDirs.push(vaultOnlyDir);
    db.insertProject({ id: "pA3", name: "A3", repoPath: vaultOnlyDir, vaultPath: vaultOnlyDir, config: {}, createdAt: now, archivedAt: null, reserved: false, repos: [], vaultOnly: true });
    const pty = { enqueueStdin: () => ({ delivered: false }) };
    const svc = new SessionService(db, pty, new OrchestrationControl());
    db.insertAgent({ id: "aA3", projectId: "pA3", name: "Mgr", startupPrompt: "", position: 0, profileId: null });
    db.insertSession({
      id: "MA3", projectId: "pA3", agentId: "aA3", engineSessionId: null, title: null, cwd: tmpHome,
      processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
      lastError: null, role: "manager", parentSessionId: null,
    });
    const newVault = path.join(tmpHome, "a3-newvault");
    fs.mkdirSync(newVault, { recursive: true });
    let err = null;
    try { await svc.updateProjectStructural("MA3", "pA3", { vaultPath: newVault }); }
    catch (e) { err = e instanceof Error ? e.message : String(e); }
    check("(A3) manager project_update vaultPath-only move that unpairs a vault-only project → refused", typeof err === "string");
    check("(A3) ★ vaultPath left UNCHANGED by the refusal", db.getProject("pA3").vaultPath === vaultOnlyDir);
    check("(A3) ★ vaultOnly fact left UNCHANGED (still true — the pre-fix lockout bug: this surface never cleared it at all)", db.getProject("pA3").vaultOnly === true);
    db.close();
  }

  // --- A4: setup project_update ---
  {
    const db = new Db(path.join(tmpHome, "a4-setup.db"));
    const vaultOnlyDir = mkVaultOnlyDir("a4");
    cleanupDirs.push(vaultOnlyDir);
    db.insertProject({ id: "pA4", name: "A4", repoPath: vaultOnlyDir, vaultPath: vaultOnlyDir, config: {}, createdAt: now, archivedAt: null, reserved: false, repos: [], vaultOnly: true });
    const { client, call } = await connectRouter(SetupMcpRouter, db);
    const newVault = path.join(tmpHome, "a4-newvault");
    fs.mkdirSync(newVault, { recursive: true });
    const r = await call("project_update", { projectId: "pA4", vaultPath: newVault });
    check("(A4) setup project_update vaultPath-only move that unpairs a vault-only project → refused", typeof r.error === "string");
    check("(A4) ★ vaultPath left UNCHANGED by the refusal", db.getProject("pA4").vaultPath === vaultOnlyDir);
    check("(A4) ★ vaultOnly fact left UNCHANGED (still true — the pre-fix lockout bug: this surface never cleared it at all)", db.getProject("pA4").vaultOnly === true);
    await client.close();
    db.close();
  }

  // =====================================================================================================
  // PART B — REPOPATH-ONLY REBIND that diverges the pair → clears vaultOnly to false. (REST + platform
  // only — the only two surfaces that can ever touch repoPath; manager/setup structurally cannot reach
  // this case at all, which IS the asymmetry PART A proves is now handled instead by a REFUSAL.)
  // =====================================================================================================

  // --- B1: REST PATCH ---
  {
    const db = new Db(path.join(tmpHome, "b1-rest.db"));
    const vaultOnlyDir = mkVaultOnlyDir("b1");
    cleanupDirs.push(vaultOnlyDir);
    db.insertProject({ id: "pB1", name: "B1", repoPath: vaultOnlyDir, vaultPath: vaultOnlyDir, config: {}, createdAt: now, archivedAt: null, reserved: false, repos: [], vaultOnly: true });
    const stub = {};
    const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, control: stub, usageStatus: stub });
    const newRepo = mkRepo("b1-new");
    cleanupDirs.push(newRepo);
    const r = await app.inject({ method: "PATCH", url: "/api/projects/pB1", payload: { repoPath: newRepo } });
    check("(B1) REST PATCH repoPath-only rebind that diverges a vault-only pair → 200", r.statusCode === 200);
    check("(B1) repoPath actually rebound", db.getProject("pB1").repoPath === newRepo);
    check("(B1) vaultPath left UNCHANGED", db.getProject("pB1").vaultPath === vaultOnlyDir);
    check("(B1) ★ vaultOnly fact CLEARED to false in the same write", db.getProject("pB1").vaultOnly === false);
    db.close();
  }

  // --- B2: platform project_update ---
  {
    const db = new Db(path.join(tmpHome, "b2-platform.db"));
    const vaultOnlyDir = mkVaultOnlyDir("b2");
    cleanupDirs.push(vaultOnlyDir);
    db.insertProject({ id: "pB2", name: "B2", repoPath: vaultOnlyDir, vaultPath: vaultOnlyDir, config: {}, createdAt: now, archivedAt: null, reserved: false, repos: [], vaultOnly: true });
    const { client, call } = await connectRouter(PlatformMcpRouter, db);
    const newRepo = mkRepo("b2-new");
    cleanupDirs.push(newRepo);
    const r = await call("project_update", { projectId: "pB2", repoPath: newRepo });
    check("(B2) platform project_update repoPath-only rebind that diverges a vault-only pair → succeeds", !r.error);
    check("(B2) repoPath actually rebound", db.getProject("pB2").repoPath === newRepo);
    check("(B2) vaultPath left UNCHANGED", db.getProject("pB2").vaultPath === vaultOnlyDir);
    check("(B2) ★ vaultOnly fact CLEARED to false in the same write", db.getProject("pB2").vaultOnly === false);
    await client.close();
    db.close();
  }

  // =====================================================================================================
  // PART C — MOVE BOTH repoPath+vaultPath TOGETHER onto one new shared folder → vaultOnly stays true.
  // (REST + platform only, for the same structural reason as PART B.)
  // =====================================================================================================

  // --- C1: REST PATCH ---
  {
    const db = new Db(path.join(tmpHome, "c1-rest.db"));
    const vaultOnlyDir = mkVaultOnlyDir("c1");
    cleanupDirs.push(vaultOnlyDir);
    db.insertProject({ id: "pC1", name: "C1", repoPath: vaultOnlyDir, vaultPath: vaultOnlyDir, config: {}, createdAt: now, archivedAt: null, reserved: false, repos: [], vaultOnly: true });
    const stub = {};
    const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, control: stub, usageStatus: stub });
    const relocated = mkRepo("c1-relocated");
    cleanupDirs.push(relocated);
    const r = await app.inject({ method: "PATCH", url: "/api/projects/pC1", payload: { repoPath: relocated, vaultPath: relocated } });
    check("(C1) REST PATCH relocating repoPath+vaultPath TOGETHER → 200", r.statusCode === 200);
    check("(C1) both fields moved to the new shared folder", db.getProject("pC1").repoPath === relocated && db.getProject("pC1").vaultPath === relocated);
    check("(C1) ★ vaultOnly fact SURVIVES the relocation (still true)", db.getProject("pC1").vaultOnly === true);
    db.close();
  }

  // --- C2: platform project_update ---
  {
    const db = new Db(path.join(tmpHome, "c2-platform.db"));
    const vaultOnlyDir = mkVaultOnlyDir("c2");
    cleanupDirs.push(vaultOnlyDir);
    db.insertProject({ id: "pC2", name: "C2", repoPath: vaultOnlyDir, vaultPath: vaultOnlyDir, config: {}, createdAt: now, archivedAt: null, reserved: false, repos: [], vaultOnly: true });
    const { client, call } = await connectRouter(PlatformMcpRouter, db);
    const relocated = mkRepo("c2-relocated");
    cleanupDirs.push(relocated);
    const r = await call("project_update", { projectId: "pC2", repoPath: relocated, vaultPath: relocated });
    check("(C2) platform project_update relocating repoPath+vaultPath TOGETHER → succeeds", !r.error);
    check("(C2) both fields moved to the new shared folder", db.getProject("pC2").repoPath === relocated && db.getProject("pC2").vaultPath === relocated);
    check("(C2) ★ vaultOnly fact SURVIVES the relocation (still true)", db.getProject("pC2").vaultOnly === true);
    await client.close();
    db.close();
  }

  // =====================================================================================================
  // PART D — REGRESSION: a vaultPath-only move on a NON-vault-only project is UNAFFECTED by any of the
  // above on every surface (the guard only ever engages for vaultOnly:true).
  // =====================================================================================================
  {
    const db = new Db(path.join(tmpHome, "d-regression.db"));
    const codeRepo = mkRepo("d-regress");
    cleanupDirs.push(codeRepo);
    const oldVault = path.join(tmpHome, "d-old-vault");
    const newVault = path.join(tmpHome, "d-new-vault");
    fs.mkdirSync(newVault, { recursive: true });
    db.insertProject({ id: "pD1", name: "D1", repoPath: codeRepo, vaultPath: oldVault, config: {}, createdAt: now, archivedAt: null, reserved: false, repos: [] });
    const stub = {};
    const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, control: stub, usageStatus: stub });
    const r = await app.inject({ method: "PATCH", url: "/api/projects/pD1", payload: { vaultPath: newVault } });
    check("(D1) REST PATCH vaultPath-only move on a NON-vault-only project → still succeeds", r.statusCode === 200);
    check("(D1) vaultPath actually moved", db.getProject("pD1").vaultPath === newVault);
    check("(D1) vaultOnly stays false (unaffected)", db.getProject("pD1").vaultOnly === false);
    db.close();
  }
} finally {
  for (const d of cleanupDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the SAME shared checkVaultOnlyOnUpdate guard now runs on every project_update-shaped write surface: a vaultPath-only move that would unpair a vault-only project is REFUSED outright (never silently flips vaultOnly to false on REST/platform, never silently leaves it stale true on manager/setup) on all four surfaces identically; a repoPath-only rebind that diverges the pair still clears vaultOnly to false (REST + platform, unchanged); relocating both fields together still leaves vaultOnly true (REST + platform, unchanged); and a non-vault-only project's ordinary vaultPath move is completely unaffected — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
