import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 96c4b245: `vaultPath` must be an ABSOLUTE path, mirroring `validateReferenceRepos`
// (reference-repos-rest.mjs) which already enforces this for the structurally identical
// `referenceRepos` field. Before this fix, every write site only `expandTilde`d the input — never
// checked `path.isAbsolute` — so a relative value (e.g. copied out of Obsidian's own vault-relative
// note browser instead of a real filesystem path) was silently accepted and stored verbatim, then
// rendered as a confidently-wrong path in a manager's "Where things live" block. There is no
// recoverable "vault root" Loom could resolve a relative value against, so the fix rejects it at the
// bind boundary rather than guessing one at render time (see manager-context-block.mjs's (3i) for the
// render-time defensive note covering an already-bad legacy row). HERMETIC + CLAUDE-FREE + NETWORK-FREE,
// modeled on reference-repos-rest.mjs.
//
// Proves the DoD:
//   PART A — human REST create (POST /api/projects) + update (PATCH /api/projects/:id): a relative
//            vaultPath is REJECTED (400, named error) on BOTH the code-project and vault-only branches;
//            an absolute one still works; an explicit "" (unbind) is UNAFFECTED by the new guard.
//   PART B — loom-setup's project_create (both branches) + project_update reject a relative vaultPath;
//            "" still no-ops/unbinds.
//   PART C — the elevated loom-platform's project_create + project_update reject a relative vaultPath.
//            project_update previously had NO expandTilde/validation at all on this surface — this also
//            proves the consistency fix (a "~/…" vaultPath now expands here too) and that "" still works.
//
// Run: 1) build (turbo builds shared first), 2) node test/vault-path-absolute.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME (set BEFORE importing dist). ---
const tmpHome = path.join(os.tmpdir(), `loom-vaultpath-abs-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_PORT = "45323";
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { SetupMcpRouter } = await import("../dist/mcp/setup.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const mkRepo = (tag) => {
  const r = path.join(os.tmpdir(), `loom-vaultpath-${tag}-${Date.now()}-${process.pid}`);
  fs.mkdirSync(r, { recursive: true });
  fs.writeFileSync(path.join(r, "README.md"), `# ${tag}\n`);
  execSync(`git init -q && git add . && git -c user.email=r@loom -c user.name=r commit -q -m init`, { cwd: r });
  return r;
};
const primary = mkRepo("primary");
// A real, existing, non-git dir — a valid VAULT-ONLY target.
const realVaultDir = path.join(os.tmpdir(), `loom-vaultpath-vault-${Date.now()}-${process.pid}`);
fs.mkdirSync(realVaultDir, { recursive: true });

const now = new Date().toISOString();

try {
  // =====================================================================================================
  // PART A — human REST: POST /api/projects + PATCH /api/projects/:id
  // =====================================================================================================
  {
    const db = new Db(path.join(tmpHome, "rest.db"));
    const stub = {};
    const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, control: stub, usageStatus: stub });
    try {
      // (A1) CODE-project branch (repoPath given): a RELATIVE vaultPath is REJECTED, no row created.
      const beforeCount = db.listAllProjects().length;
      const relCode = await app.inject({
        method: "POST", url: "/api/projects",
        payload: { name: "RelCode", repoPath: primary, vaultPath: "Projects/Seismo" },
      });
      check("(A1) POST code-project branch with a relative vaultPath → 400", relCode.statusCode === 400);
      check("(A1) error names the absolute-path requirement", /absolute path/.test(relCode.json().error ?? ""));
      check("(A1) no project row was created on rejection", db.listAllProjects().length === beforeCount);

      // (A2) CODE-project branch: an ABSOLUTE (non-existent — scaffolded) vaultPath still works.
      const freshVault = path.join(tmpHome, "fresh-vault-a2");
      const okCode = await app.inject({
        method: "POST", url: "/api/projects",
        payload: { name: "AbsCode", repoPath: primary, vaultPath: freshVault },
      });
      check("(A2) POST code-project branch with an absolute vaultPath → 201", okCode.statusCode === 201);
      check("(A2) stored vaultPath is the absolute path given", okCode.json().vaultPath === freshVault);

      // (A3) VAULT-ONLY branch (no repoPath): a RELATIVE vaultPath is REJECTED — validated BEFORE the
      // isExistingDir check, so it 400s on the absolute-path error, not the "not an existing directory" one.
      const relVaultOnly = await app.inject({
        method: "POST", url: "/api/projects",
        payload: { name: "RelVaultOnly", vaultPath: "Projects/Notes" },
      });
      check("(A3) POST vault-only branch with a relative vaultPath → 400", relVaultOnly.statusCode === 400);
      check("(A3) error names the absolute-path requirement (not the existing-dir one)", /absolute path/.test(relVaultOnly.json().error ?? ""));

      // (A4) VAULT-ONLY branch: an ABSOLUTE, existing vaultPath still works (unaffected regression check).
      const okVaultOnly = await app.inject({
        method: "POST", url: "/api/projects",
        payload: { name: "AbsVaultOnly", vaultPath: realVaultDir },
      });
      check("(A4) POST vault-only branch with an absolute existing vaultPath → 201", okVaultOnly.statusCode === 201);

      // (A5) PATCH: a RELATIVE vaultPath rebind is REJECTED, stored value UNCHANGED.
      const target = okCode.json();
      const patchRel = await app.inject({ method: "PATCH", url: `/api/projects/${target.id}`, payload: { vaultPath: "Projects/Renamed" } });
      check("(A5) PATCH with a relative vaultPath → 400", patchRel.statusCode === 400);
      check("(A5) error names the absolute-path requirement", /absolute path/.test(patchRel.json().error ?? ""));
      check("(A5) rejected PATCH left vaultPath UNCHANGED", db.getProject(target.id)?.vaultPath === freshVault);

      // (A6) PATCH: an ABSOLUTE vaultPath rebind still works.
      const freshVault2 = path.join(tmpHome, "fresh-vault-a6");
      const patchAbs = await app.inject({ method: "PATCH", url: `/api/projects/${target.id}`, payload: { vaultPath: freshVault2 } });
      check("(A6) PATCH with an absolute vaultPath → 200", patchAbs.statusCode === 200);
      check("(A6) stored vaultPath updated", db.getProject(target.id)?.vaultPath === freshVault2);

      // (A7) PATCH: an explicit "" (UNBIND, card 9fe578b3/d867e478) is UNAFFECTED by the new absolute-path
      // guard — it must still succeed (the empty string is never routed through validateVaultPath).
      const patchUnbind = await app.inject({ method: "PATCH", url: `/api/projects/${target.id}`, payload: { vaultPath: "" } });
      check("(A7) PATCH vaultPath:\"\" (unbind) still → 200 (unregressed)", patchUnbind.statusCode === 200);
      check("(A7) vaultPath actually cleared", db.getProject(target.id)?.vaultPath === "");
    } finally {
      db.close();
    }
  }

  // =====================================================================================================
  // PART B — loom-setup (mcp/setup.ts): project_create (both branches) + project_update
  // =====================================================================================================
  {
    const db = new Db(path.join(tmpHome, "setup.db"));
    db.insertProject({ id: "pExisting", name: "Existing", repoPath: primary, vaultPath: primary, config: {}, createdAt: now, archivedAt: null, reserved: false });
    class SeamHost extends PtyHost {
      createPty() { return { pid: 4242, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} }; }
      stop() {}
    }
    const events = { onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); }, onBusy(id, busy) { db.setBusy(id, busy); }, onContextStats() {}, onRateLimited() {}, onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); } };
    const host = new SeamHost(events);
    const svc = new SessionService(db, host, new OrchestrationControl());
    const router = new SetupMcpRouter(db, svc);
    const server = router.buildServer();
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "vaultpath-setup-test", version: "0" });
    await client.connect(clientT);
    const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

    // (B1) CODE-project branch: a relative vaultPath is rejected.
    const beforeCount = db.listAllProjects().length;
    const relCode = await call("project_create", { name: "SetupRelCode", repoPath: primary, vaultPath: "Projects/Seismo" });
    check("(B1) setup project_create code-project branch with a relative vaultPath → error", typeof relCode.error === "string" && /absolute path/.test(relCode.error));
    check("(B1) no project row was created on rejection", db.listAllProjects().length === beforeCount);

    // (B2) VAULT-ONLY branch: a relative vaultPath is rejected (before the isExistingDir check).
    const relVaultOnly = await call("project_create", { name: "SetupRelVaultOnly", vaultPath: "Projects/Notes" });
    check("(B2) setup project_create vault-only branch with a relative vaultPath → error", typeof relVaultOnly.error === "string" && /absolute path/.test(relVaultOnly.error));

    // (B3) project_update: a relative vaultPath is rejected, stored value UNCHANGED.
    const updRel = await call("project_update", { projectId: "pExisting", vaultPath: "Projects/Renamed" });
    check("(B3) error names the absolute-path requirement", typeof updRel.error === "string" && /absolute path/.test(updRel.error));
    check("(B3) setup project_update relative vaultPath rejected, Db UNCHANGED", db.getProject("pExisting")?.vaultPath === primary);

    // (B4) project_update: "" still works as a no-vault-related rename (mirrors the REST unbind case —
    // this surface's project_update has no repoPath/vaultPath-unbind special-casing, just a plain write).
    const renamed = await call("project_update", { projectId: "pExisting", name: "ExistingRenamed", vaultPath: "" });
    check("(B4) setup project_update vaultPath:\"\" still succeeds (unregressed)", !renamed.error && renamed.vaultPath === "");

    await client.close();
    db.close();
  }

  // =====================================================================================================
  // PART C — the elevated loom-platform (mcp/platform.ts): project_create + project_update
  // =====================================================================================================
  {
    const db = new Db(path.join(tmpHome, "platform.db"));
    db.insertProject({ id: "pExisting2", name: "Existing2", repoPath: primary, vaultPath: primary, config: {}, createdAt: now, archivedAt: null, reserved: false });
    class SeamHost extends PtyHost {
      createPty() { return { pid: 4242, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} }; }
      stop() {}
    }
    const events = { onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); }, onBusy(id, busy) { db.setBusy(id, busy); }, onContextStats() {}, onRateLimited() {}, onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); } };
    const host = new SeamHost(events);
    const svc = new SessionService(db, host, new OrchestrationControl());
    const router = new PlatformMcpRouter(db, svc);
    const server = router.buildServer();
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "vaultpath-platform-test", version: "0" });
    await client.connect(clientT);
    const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

    // (C1) project_create: a relative vaultPath is rejected.
    const beforeCount = db.listAllProjects().length;
    const relCreate = await call("project_create", { name: "PlatRelCode", repoPath: primary, vaultPath: "Projects/Seismo" });
    check("(C1) platform project_create with a relative vaultPath → error", typeof relCreate.error === "string" && /absolute path/.test(relCreate.error));
    check("(C1) no project row was created on rejection", db.listAllProjects().length === beforeCount);

    // (C2) project_update: a relative vaultPath is rejected, stored value UNCHANGED. This surface
    // PREVIOUSLY had zero vaultPath validation (not even expandTilde) — proves the gap is closed.
    const updRel = await call("project_update", { projectId: "pExisting2", vaultPath: "Projects/Renamed" });
    check("(C2) platform project_update with a relative vaultPath → error", typeof updRel.error === "string" && /absolute path/.test(updRel.error));
    check("(C2) rejected update left vaultPath UNCHANGED", db.getProject("pExisting2")?.vaultPath === primary);

    // (C3) project_update: a "~/…" vaultPath now EXPANDS (this surface previously never expandTilde'd
    // vaultPath at all) — proves the consistency fix, not just the absolute-path rejection.
    const tildeTarget = path.join(sandboxHome, "tilde-vault");
    fs.mkdirSync(tildeTarget, { recursive: true });
    const updTilde = await call("project_update", { projectId: "pExisting2", vaultPath: "~/tilde-vault" });
    check("(C3) platform project_update expands a '~/…' vaultPath (no error)", !updTilde.error);
    check("(C3) stored vaultPath is the EXPANDED absolute path", db.getProject("pExisting2")?.vaultPath === tildeTarget);

    // (C4) project_update: "" still unbinds cleanly (unregressed — "" never reaches validateVaultPath).
    const updEmpty = await call("project_update", { projectId: "pExisting2", vaultPath: "" });
    check("(C4) platform project_update vaultPath:\"\" still succeeds (unregressed)", !updEmpty.error && updEmpty.vaultPath === "");

    await client.close();
    db.close();
  }
} finally {
  for (const d of [tmpHome, primary, realVaultDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — vaultPath must be an absolute path (mirroring validateReferenceRepos) on every write site: the human REST create/update (both the code-project and vault-only branches), loom-setup's project_create/project_update, and the elevated loom-platform's project_create/project_update (which previously had NO vaultPath validation at all) — a relative value is rejected with a named error and no row is created/changed, an absolute one still works, and the legitimate \"\" unbind case is entirely unaffected — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
