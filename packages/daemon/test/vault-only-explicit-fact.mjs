import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card b98957e9 — vault-only-ness is now an EXPLICIT, stored `Project.vaultOnly` fact, never inferred
// from `repoPath === vaultPath && !isGitRepo(repoPath)`. That inference was unsound in two concrete ways
// (from the Code Review of 6a48b759, reviewer a7a7c3d6):
//   (a) VaultVersioner.start() git-inits a bare vault folder the FIRST TIME it's opened — from then on
//       isGitRepo(repoPath) is true for a genuine vault-only project, silently defeating the "cannot
//       unbind a vault-only project's vault" refusal.
//   (b) isGitRepo (simple-git checkIsRepo()) is true for ANY path inside a working tree, not just a repo
//       root — a vault-only folder that is itself a subfolder of a separate notes repo is misclassified
//       from day one, with no git-init step needed at all.
// HERMETIC + CLAUDE-FREE + NETWORK-FREE. Both (a) and (b) are reproduced with a REAL git repo (execSync),
// not a mock, so the RED/GREEN proof is against the actual mechanism, not a stand-in for it.
//
// Proves the DoD:
//   PART A — finding (a): a TRUE vault-only project (created via the vault-only branch, so `vaultOnly`
//            is stamped true at creation) whose folder is LATER git-init'd (simulating
//            VaultVersioner.start()'s first-boot behavior) still REFUSES an unbind — unaffected by the
//            folder becoming a git repo after the fact.
//   PART B — finding (b): a TRUE vault-only project whose folder is a SUBFOLDER of a SEPARATE, real git
//            repo (so isGitRepo would read true from the moment of creation, no later git-init needed)
//            still REFUSES an unbind.
//   PART C — write-once (manager-approved condition 3): the only two surfaces that can ever change an
//            existing project's `repoPath` (REST PATCH, platform project_update) both clear a true
//            `vaultOnly` fact to false IN THE SAME WRITE when the rebind leaves repoPath/vaultPath no
//            longer canonically paired — never when they're relocated TOGETHER to the same new folder.
//
// Run: 1) build (turbo builds shared first), 2) node test/vault-only-explicit-fact.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-vaultonly-fact-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_PORT = String(hermeticPort());

import { requireHermeticEnv } from "./_guard.mjs";
import { hermeticPort } from "./_hermetic-port.mjs";
import { commitAll } from "./_git-commit.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const gitInit = (dir) => {
  execSync(`git init -q`, { cwd: dir });
  commitAll(dir, "init", "-c user.email=r@loom -c user.name=r");
};
const mkRepo = (tag) => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), `loom-vaultonly-fact-repo-${tag}-`));
  fs.writeFileSync(path.join(r, "README.md"), `# ${tag}\n`);
  gitInit(r);
  return r;
};

const now = new Date().toISOString();
const cleanupDirs = [tmpHome];

try {
  // =====================================================================================================
  // PART A — finding (a): the vault-only folder is git-init'd AFTER creation (VaultVersioner.start()'s
  // real first-boot behavior) — the explicit `vaultOnly` fact must stay true regardless.
  // =====================================================================================================
  {
    const db = new Db(path.join(tmpHome, "finding-a.db"));
    const stub = {};
    const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, control: stub, usageStatus: stub });
    try {
      const vaultOnlyDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-vaultonly-fact-a-"));
      cleanupDirs.push(vaultOnlyDir);
      // Create via the REAL vault-only CREATE branch (POST /api/projects, no repoPath) — the fact is
      // stamped by the SAME code path a real user's vault-only bind goes through.
      const created = await app.inject({ method: "POST", url: "/api/projects", payload: { name: "FindingA", vaultPath: vaultOnlyDir } });
      check("(A setup) vault-only create → 201", created.statusCode === 201);
      const id = created.json().id;
      check("(A setup) created project stamped vaultOnly:true", db.getProject(id)?.vaultOnly === true);

      // Simulate VaultVersioner.start()'s first-boot git-init of the vault folder — this is the EXACT
      // mechanism finding (a) names: "VaultVersioner.start() git-inits a bare vault folder... from then
      // on isGitRepo is true". A real `isGitRepo` call against this folder now returns true — `git init`
      // alone is enough (simple-git's checkIsRepo() only needs the `.git` dir, no commit required).
      execSync(`git init -q`, { cwd: vaultOnlyDir });

      // The unbind refusal must still fire — it no longer depends on isGitRepo at all.
      const unbind = await app.inject({ method: "PATCH", url: `/api/projects/${id}`, payload: { vaultPath: "" } });
      check("(A) PATCH vaultPath:\"\" on a vault-only project whose folder is NOW a git repo → still 400 (refused)", unbind.statusCode === 400);
      check("(A) error names the vault-only refusal", /vault-only project/.test(unbind.json().error ?? ""));
      check("(A) vaultPath left UNCHANGED by the refused unbind", db.getProject(id)?.vaultPath === vaultOnlyDir);
      check("(A) vaultOnly fact itself is untouched by the git-init (still true)", db.getProject(id)?.vaultOnly === true);
    } finally {
      db.close();
    }
  }

  // =====================================================================================================
  // PART B — finding (b): the vault-only folder is a SUBFOLDER of a SEPARATE, pre-existing real git repo
  // (a notes repo) from the moment of creation — isGitRepo would read true immediately, no git-init step
  // needed. The explicit fact must still correctly mark this a vault-only project.
  // =====================================================================================================
  {
    const db = new Db(path.join(tmpHome, "finding-b.db"));
    const stub = {};
    const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, control: stub, usageStatus: stub });
    try {
      const notesRepo = mkRepo("notes-repo-b");
      cleanupDirs.push(notesRepo);
      // The vault-only folder lives INSIDE the notes repo's working tree — isGitRepo(subfolder) is true
      // from day one (simple-git's checkIsRepo() is true for ANY path inside a working tree).
      const vaultOnlySubfolder = path.join(notesRepo, "Projects", "SomeProject");
      fs.mkdirSync(vaultOnlySubfolder, { recursive: true });
      check("(B setup) the subfolder genuinely reads as a git repo (isGitRepo-true shape)", fs.existsSync(path.join(notesRepo, ".git")));

      const created = await app.inject({ method: "POST", url: "/api/projects", payload: { name: "FindingB", vaultPath: vaultOnlySubfolder } });
      check("(B setup) vault-only create (folder nested in a notes repo) → 201", created.statusCode === 201);
      const id = created.json().id;
      check("(B setup) created project stamped vaultOnly:true despite living inside a git repo", db.getProject(id)?.vaultOnly === true);

      const unbind = await app.inject({ method: "PATCH", url: `/api/projects/${id}`, payload: { vaultPath: "" } });
      check("(B) PATCH vaultPath:\"\" on a vault-only project nested in a notes repo → 400 (refused)", unbind.statusCode === 400);
      check("(B) error names the vault-only refusal", /vault-only project/.test(unbind.json().error ?? ""));
      check("(B) vaultPath left UNCHANGED by the refused unbind", db.getProject(id)?.vaultPath === vaultOnlySubfolder);
    } finally {
      db.close();
    }
  }

  // =====================================================================================================
  // PART C — write-once: a repoPath rebind that diverges a true vaultOnly pair clears the fact to false,
  // IN THE SAME WRITE, on both surfaces that can ever change repoPath (REST PATCH, platform
  // project_update) — and NEVER when repoPath/vaultPath are relocated TOGETHER to the same new folder.
  // =====================================================================================================
  {
    // --- C1/C2: REST PATCH /api/projects/:id ---
    const db = new Db(path.join(tmpHome, "writeonce-rest.db"));
    const stub = {};
    const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, control: stub, usageStatus: stub });
    try {
      const vaultOnlyDir1 = fs.mkdtempSync(path.join(os.tmpdir(), "loom-vaultonly-fact-c1-"));
      cleanupDirs.push(vaultOnlyDir1);
      db.insertProject({ id: "pC1", name: "C1", repoPath: vaultOnlyDir1, vaultPath: vaultOnlyDir1, config: {}, createdAt: now, archivedAt: null, reserved: false, repos: [], vaultOnly: true });

      // (C1) rebind repoPath to a genuinely DIFFERENT, real repo (vaultPath untouched) → vaultOnly flips
      // to false in the SAME write.
      const newRepo = mkRepo("writeonce-c1-new");
      cleanupDirs.push(newRepo);
      const c1 = await app.inject({ method: "PATCH", url: "/api/projects/pC1", payload: { repoPath: newRepo } });
      check("(C1) REST PATCH repoPath-only rebind off a vault-only project → 200", c1.statusCode === 200);
      check("(C1) repoPath actually rebound", db.getProject("pC1")?.repoPath === newRepo);
      check("(C1) vaultPath left UNCHANGED (still the original vault-only folder)", db.getProject("pC1")?.vaultPath === vaultOnlyDir1);
      check("(C1) ★ vaultOnly fact CLEARED to false in the same write (no longer vault-only — a real separate repo now exists)", db.getProject("pC1")?.vaultOnly === false);

      // (C2) relocate repoPath AND vaultPath TOGETHER to the SAME new folder → vaultOnly stays true.
      // The target must already be an existing git repo — checkRepoRebind enforces that UNCONDITIONALLY
      // for any repoPath patch, with no vault-only exemption (same requirement tilde-expansion.mjs's own
      // repoPath+vaultPath relocation case relies on).
      const vaultOnlyDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "loom-vaultonly-fact-c2-"));
      cleanupDirs.push(vaultOnlyDir2);
      db.insertProject({ id: "pC2", name: "C2", repoPath: vaultOnlyDir2, vaultPath: vaultOnlyDir2, config: {}, createdAt: now, archivedAt: null, reserved: false, repos: [], vaultOnly: true });
      const relocated = mkRepo("c2-relocated");
      cleanupDirs.push(relocated);
      const c2 = await app.inject({ method: "PATCH", url: "/api/projects/pC2", payload: { repoPath: relocated, vaultPath: relocated } });
      check("(C2) REST PATCH relocating repoPath+vaultPath TOGETHER off a vault-only project → 200", c2.statusCode === 200);
      check("(C2) both fields moved to the new shared folder", db.getProject("pC2")?.repoPath === relocated && db.getProject("pC2")?.vaultPath === relocated);
      check("(C2) ★ vaultOnly fact SURVIVES the relocation (still true — still a single shared folder)", db.getProject("pC2")?.vaultOnly === true);
    } finally {
      db.close();
    }

    // --- C3: the elevated platform project_update — same chokepoint (Db.updateProject), light coverage. ---
    const db2 = new Db(path.join(tmpHome, "writeonce-platform.db"));
    const vaultOnlyDir3 = fs.mkdtempSync(path.join(os.tmpdir(), "loom-vaultonly-fact-c3-"));
    cleanupDirs.push(vaultOnlyDir3);
    db2.insertProject({ id: "pC3", name: "C3", repoPath: vaultOnlyDir3, vaultPath: vaultOnlyDir3, config: {}, createdAt: now, archivedAt: null, reserved: false, repos: [], vaultOnly: true });
    class SeamHost extends createSeamHost(PtyHost) { stop() {} }
    const events = { onEngineSessionId(id, eng) { db2.setEngineSessionId(id, eng); }, onBusy(id, busy) { db2.setBusy(id, busy); }, onContextStats() {}, onRateLimited() {}, onExit(id) { db2.setProcessState(id, "exited"); db2.setBusy(id, false); } };
    const host = new SeamHost(events);
    const svc = new SessionService(db2, host, new OrchestrationControl());
    const router = new PlatformMcpRouter(db2, svc);
    const server = router.buildServer();
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "vaultonly-fact-platform-test", version: "0" });
    await client.connect(clientT);
    const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

    const newRepo3 = mkRepo("writeonce-c3-new");
    cleanupDirs.push(newRepo3);
    const c3 = await call("project_update", { projectId: "pC3", repoPath: newRepo3 });
    check("(C3) platform project_update repoPath-only rebind off a vault-only project → succeeds", !c3.error);
    check("(C3) ★ vaultOnly fact CLEARED to false in the same write", db2.getProject("pC3")?.vaultOnly === false);

    await client.close();
    db2.close();
  }
} finally {
  for (const d of cleanupDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — vault-only-ness is an explicit `Project.vaultOnly` fact stamped once at creation: it survives a later git-init of the folder (finding a) and a from-day-one nesting inside another repo (finding b), both of which defeated the old repoPath===vaultPath&&!isGitRepo inference; and a repoPath rebind that diverges a true vault-only pair clears the fact in the same write (REST PATCH + platform project_update, the only two repoPath-rebind-capable surfaces), while relocating both fields together to a new shared folder leaves it untouched — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
