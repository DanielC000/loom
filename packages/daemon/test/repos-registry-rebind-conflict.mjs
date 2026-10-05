import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Multi-repo epic 49136451 phase 1 — two code-review Majors, both proven here:
//
//   MAJOR 1: validateRepoRegistry only ran when the PATCH/project_update call explicitly included a
//   `repos` key. A repoPath/vaultPath REBIND that OMITTED `repos` entirely skipped the anti-alias check,
//   so a PATCH could rebind repoPath onto a dir an existing registry entry already points at, creating
//   the exact "primary" + registry-key alias the validator exists to block. Fixed by re-running
//   validateRepoRegistry against the EXISTING (unchanged) registry + the EFFECTIVE new repoPath/vaultPath
//   whenever either changes, on BOTH rebind surfaces: the human REST PATCH /api/projects/:id AND the
//   elevated loom-platform project_update.
//
//   MAJOR 2: the anti-alias/dedup checks compared paths with plain `===` after only `expandTilde` — on
//   Windows, `C:\work\api` and `C:/work/api` (or a different drive-letter case, or a trailing slash) are
//   the SAME directory to the OS but different strings, so the alias check failed OPEN. Fixed by
//   canonicalizing every path (repoPath/vaultPath AND every registry entry) via
//   `fs.realpathSync.native` + a win32 case-fold before any comparison.
//
// HERMETIC + CLAUDE-FREE + NETWORK-FREE, real temp git repos + a real Windows filesystem (this project
// targets Windows-first — see CLAUDE.md's junction-hazard notes), modeled on repos-registry-rest.mjs.
//
// Run: 1) build (turbo builds shared first), 2) node test/repos-registry-rebind-conflict.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-repos-rebind-conflict-${Date.now()}-${process.pid}`);
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
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const mkRepo = (tag) => {
  // fs.mkdtempSync (not Date.now()-${process.pid}): mkRepo runs multiple times PER PROCESS, so pid
  // (constant across those calls) can't discriminate two calls landing in the same millisecond — only
  // an OS-atomic unique dir does (card 11a25f10).
  const r = fs.mkdtempSync(path.join(os.tmpdir(), `loom-rebind-${tag}-`));
  fs.writeFileSync(path.join(r, "README.md"), `# ${tag}\n`);
  execSync(`git init -q`, { cwd: r });
  commitAll(r, "init", "-c user.email=r@loom -c user.name=r");
  return r;
};
const primary = mkRepo("primary");
const svcA = mkRepo("svcA");   // registered in the registry throughout
const svcB = mkRepo("svcB");   // card e3fcd8ea PART E/F: a second repo for a genuinely NEW registry entry
const newPrimary = mkRepo("newPrimary"); // a genuinely different repo to rebind repoPath to legitimately
const now = new Date().toISOString();

// Alternate SPELLINGS of the exact same real directory (svcA) — MAJOR 2's failure mode. Windows resolves
// all of these to the identical dir; the OLD `===` comparison treated them as different.
const svcAForwardSlash = svcA.replace(/\\/g, "/");
const svcACaseFlipped = svcA.charAt(0) === svcA.charAt(0).toUpperCase()
  ? svcA.charAt(0).toLowerCase() + svcA.slice(1)
  : svcA.charAt(0).toUpperCase() + svcA.slice(1);
const svcATrailingSlash = svcA + path.sep;
// A vault dir DISTINCT from every code repo above — card 5ba4412d now refuses vaultPath===repoPath for a
// CODE project at CREATE time, so every fixture below (previously paired repoPath with an identical
// vaultPath) needs a real, separate vault target that isn't itself part of what each case is testing.
const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-rebind-vault-"));

try {
  // =====================================================================================================
  // PART A — MAJOR 1: human REST PATCH /api/projects/:id, repoPath rebind ALONE (repos omitted)
  // =====================================================================================================
  {
    const db = new Db(path.join(tmpHome, "rest-a.db"));
    const stub = {};
    const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, control: stub, usageStatus: stub });
    try {
      const created = await app.inject({
        method: "POST", url: "/api/projects",
        payload: { name: "RebindTest", repoPath: primary, vaultPath: vaultDir, repos: [{ key: "api", path: svcA }] },
      });
      const projectId = created.json().id;
      check("(A0) setup: project created with a registry entry pointing at svcA", created.json().repos?.length === 1);

      // (A1) PATCH repoPath ALONE (no `repos` in the payload) onto svcA's own path — MUST be rejected,
      // because it would leave repoPath === the "api" registry entry's path (the exact alias the create
      // validator already refuses to create directly).
      const beforeProject = db.getProject(projectId);
      const badRebind = await app.inject({ method: "PATCH", url: `/api/projects/${projectId}`, payload: { repoPath: svcA } });
      check("(A1) PATCH repoPath alone into an existing registry entry's path -> 400", badRebind.statusCode === 400);
      check("(A1) error names the conflict", /repos registry|alias/i.test(badRebind.json().error ?? ""));
      check("(A1) repoPath UNCHANGED after rejection", db.getProject(projectId)?.repoPath === beforeProject.repoPath);
      check("(A1) registry UNCHANGED after rejection", JSON.stringify(db.getProject(projectId)?.repos) === JSON.stringify(beforeProject.repos));

      // (A2) regression: PATCH repoPath to a repo that does NOT conflict still succeeds normally.
      const goodRebind = await app.inject({ method: "PATCH", url: `/api/projects/${projectId}`, payload: { repoPath: newPrimary } });
      check("(A2) PATCH repoPath to a NON-conflicting repo -> 200 (regression: rebind still works)", goodRebind.statusCode === 200);
      check("(A2) repoPath actually rebound", db.getProject(projectId)?.repoPath === newPrimary);
      check("(A2) registry untouched by a non-conflicting rebind", db.getProject(projectId)?.repos?.length === 1 && db.getProject(projectId)?.repos[0].key === "api");

      // (A3) the SAME conflict via a vaultPath rebind (not just repoPath) is caught too.
      const created2 = await app.inject({
        method: "POST", url: "/api/projects",
        payload: { name: "RebindTest2", repoPath: primary, vaultPath: vaultDir, repos: [{ key: "api", path: svcA }] },
      });
      const projectId2 = created2.json().id;
      const badVaultRebind = await app.inject({ method: "PATCH", url: `/api/projects/${projectId2}`, payload: { vaultPath: svcA } });
      check("(A3) PATCH vaultPath alone into an existing registry entry's path -> 400", badVaultRebind.statusCode === 400);
      check("(A3) registry UNCHANGED after rejection", db.getProject(projectId2)?.repos?.length === 1);
    } finally {
      db.close();
    }
  }

  // =====================================================================================================
  // PART B — MAJOR 1: elevated loom-platform project_update, the SAME repoPath-rebind-omitting-repos gap
  // =====================================================================================================
  {
    const db = new Db(path.join(tmpHome, "platform-b.db"));
    db.insertProject({ id: "pHome", name: "Loom Platform", repoPath: primary, vaultPath: primary, config: {}, createdAt: now, archivedAt: null, reserved: true });
    db.insertProject({ id: "pTarget", name: "Target", repoPath: primary, vaultPath: primary, config: {}, createdAt: now, archivedAt: null, reserved: false, repos: [{ key: "api", path: svcA }] });
    db.insertAgent({ id: "agentLead", projectId: "pHome", name: "Lead", startupPrompt: "LEAD", position: 0, profileId: null });
    db.insertSession({ id: "PL", projectId: "pHome", agentId: "agentLead", engineSessionId: null, title: null, cwd: primary, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "platform", parentSessionId: null });

    class SeamHost extends createSeamHost(PtyHost) {
      createPty(opts) { return { ...super.createPty(opts), pid: 1 }; }
      stop() {}
    }
    const host = new SeamHost({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} });
    const svc = new SessionService(db, host, new OrchestrationControl());
    const server = new PlatformMcpRouter(db, svc).buildServer("PL");
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "rebind-conflict-test", version: "0" });
    await client.connect(clientT);
    const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

    // (B1) project_update repoPath rebind onto the registry entry's own path -> refused.
    const beforeRepoPath = db.getProject("pTarget").repoPath;
    const badUpdate = await call("project_update", { projectId: "pTarget", repoPath: svcA });
    check("(B1) platform project_update repoPath rebind into an existing registry entry's path -> {error}", typeof badUpdate.error === "string" && /repos registry|alias/i.test(badUpdate.error));
    check("(B1) repoPath UNCHANGED after rejection", db.getProject("pTarget")?.repoPath === beforeRepoPath);
    check("(B1) registry UNCHANGED after rejection", db.getProject("pTarget")?.repos?.length === 1);

    // (B2) regression: a non-conflicting rebind via project_update still works.
    const goodUpdate = await call("project_update", { projectId: "pTarget", repoPath: newPrimary });
    check("(B2) platform project_update repoPath rebind to a non-conflicting repo -> succeeds", !goodUpdate.error && goodUpdate.repoPath === newPrimary);

    await client.close();
    db.close();
  }

  // =====================================================================================================
  // PART C — MAJOR 2: differently-SPELLED paths to the identical real directory still collide
  // =====================================================================================================
  {
    const db = new Db(path.join(tmpHome, "spelling-c.db"));
    const stub = {};
    const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, control: stub, usageStatus: stub });
    try {
      // (C1) repoPath given in backslash form; a registry entry for the SAME dir given in forward-slash
      // form — must still be caught as an alias despite the different spelling.
      const c1 = await app.inject({
        method: "POST", url: "/api/projects",
        payload: { name: "SpellFwdSlash", repoPath: svcA, vaultPath: vaultDir, repos: [{ key: "same", path: svcAForwardSlash }] },
      });
      check("(C1) forward-slash spelling of repoPath as a registry entry -> 400 (still caught as an alias)", c1.statusCode === 400);

      // (C2) drive-letter (or first-segment) case flip of the SAME real directory.
      if (svcACaseFlipped !== svcA) {
        const c2 = await app.inject({
          method: "POST", url: "/api/projects",
          payload: { name: "SpellCaseFlip", repoPath: svcA, vaultPath: vaultDir, repos: [{ key: "same", path: svcACaseFlipped }] },
        });
        check("(C2) case-flipped spelling of repoPath as a registry entry -> 400 (still caught as an alias)", c2.statusCode === 400);
      } else {
        check("(C2) case-flipped spelling test skipped (path had no case-flippable segment) — not a failure", true);
      }

      // (C3) a trailing separator on an otherwise-identical path.
      const c3 = await app.inject({
        method: "POST", url: "/api/projects",
        payload: { name: "SpellTrailingSlash", repoPath: svcA, vaultPath: vaultDir, repos: [{ key: "same", path: svcATrailingSlash }] },
      });
      check("(C3) trailing-separator spelling of repoPath as a registry entry -> 400 (still caught as an alias)", c3.statusCode === 400);

      // (C4) TWO registry entries, differently spelled, pointing at the SAME real directory — the
      // seenPaths dedup must ALSO canonicalize, not just the repoPath/vaultPath alias checks.
      const c4 = await app.inject({
        method: "POST", url: "/api/projects",
        payload: { name: "SpellDedup", repoPath: primary, vaultPath: vaultDir, repos: [{ key: "one", path: svcA }, { key: "two", path: svcAForwardSlash }] },
      });
      check("(C4) two differently-spelled registry entries for the SAME real dir -> 400 (dedup catches it)", c4.statusCode === 400);
      check("(C4) error names the duplicate-path rule", /duplicat/i.test(c4.json().error ?? ""));

      // (C5) control: a genuinely DIFFERENT real repo, spelled with forward slashes, is accepted normally
      // — proves the canonicalization isn't over-matching every forward-slash path to repoPath/vaultPath.
      const c5 = await app.inject({
        method: "POST", url: "/api/projects",
        payload: { name: "SpellControl", repoPath: primary, vaultPath: vaultDir, repos: [{ key: "distinct", path: newPrimary.replace(/\\/g, "/") }] },
      });
      check("(C5) control: a distinct repo (forward-slash spelling) is accepted -> 201", c5.statusCode === 201);
      check("(C5) control: stored path is canonicalized (native realpath form)", c5.json().repos?.[0]?.path === newPrimary || c5.json().repos?.[0]?.path?.toLowerCase() === newPrimary.toLowerCase());
    } finally {
      db.close();
    }
  }

  // =====================================================================================================
  // PART D — CARRIED item 3 (multi-repo epic 49136451 phase 2): a `repos` registry EDIT (not just a
  // repoPath rebind) is refused while ANY live worktree session exists for the project — the gap phase
  // 1's checkRepoRebind never covered at all (it only ever ran on a repoPath rebind). Blanket per-project
  // policy, same as checkRepoRebind's own — registry edits are rare/human-only, and this reuses the SAME
  // shared checkLiveWorktreeSessions helper rather than a precise per-key diff.
  // =====================================================================================================
  {
    const db = new Db(path.join(tmpHome, "registry-edit-live-d.db"));
    const stub = {};
    const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, control: stub, usageStatus: stub });
    try {
      const created = await app.inject({
        method: "POST", url: "/api/projects",
        payload: { name: "RegistryEditLiveTest", repoPath: primary, vaultPath: vaultDir, repos: [{ key: "api", path: svcA }] },
      });
      const projectId = created.json().id;
      const now = new Date().toISOString();
      db.insertAgent({ id: "agentW", projectId, name: "Worker", startupPrompt: "", position: 0, profileId: null });
      db.insertSession({
        id: "liveWorktreeSession", projectId, agentId: "agentW", engineSessionId: null, title: null,
        cwd: svcA, processState: "live", resumability: "unknown", busy: false,
        createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: null,
        worktreePath: svcA, branch: "loom/somekey", repoKey: "api",
      });

      // (D1) editing the registry (repathing the "api" entry) while a live worktree session exists on
      // this project -> refused, registry UNCHANGED.
      const beforeRepos = db.getProject(projectId)?.repos;
      const badEdit = await app.inject({
        method: "PATCH", url: `/api/projects/${projectId}`,
        payload: { repos: [{ key: "api", path: newPrimary }] },
      });
      check("(D1) editing the repos registry while a live worktree session exists -> 400", badEdit.statusCode === 400);
      check("(D1) error names the live-worktree reason", /live worktree session/i.test(badEdit.json().error ?? ""));
      check("(D1) registry UNCHANGED after the refusal", JSON.stringify(db.getProject(projectId)?.repos) === JSON.stringify(beforeRepos));

      // (D2) removing the entry entirely (empty repos array) while live is ALSO refused, not just a repath.
      const badRemove = await app.inject({ method: "PATCH", url: `/api/projects/${projectId}`, payload: { repos: [] } });
      check("(D2) removing a registry entry while a live worktree session exists -> 400", badRemove.statusCode === 400);
      check("(D2) registry still UNCHANGED", db.getProject(projectId)?.repos?.length === 1);

      // (D3) once the live session exits, the SAME registry edit succeeds normally.
      db.setProcessState("liveWorktreeSession", "exited");
      const goodEdit = await app.inject({
        method: "PATCH", url: `/api/projects/${projectId}`,
        payload: { repos: [{ key: "api", path: newPrimary }] },
      });
      check("(D3) the same registry edit succeeds once the worktree session exits", goodEdit.statusCode === 200);
      check("(D3) registry actually updated", db.getProject(projectId)?.repos?.[0]?.path?.toLowerCase() === newPrimary.toLowerCase());
    } finally {
      db.close();
    }
  }

  // =====================================================================================================
  // PART E — card e3fcd8ea item 2: a repoPath/vaultPath rebind (or a `repos` echo) no longer 400s when
  // the STORED registry already carries a legacy key shaped like a renamed-aside stale-worktree leftover
  // (`.stale-<ts>`, STALE_ASIDE_SUFFIX_RE). CREATE has rejected this shape since `ad34efb5`, so the only
  // way a project can carry one is data written before that guard existed — seeded here directly via
  // `Db.insertProject` (bypassing validateRepoRegistry entirely) to simulate that.
  // =====================================================================================================
  {
    const db = new Db(path.join(tmpHome, "legacy-stale-key-e.db"));
    const stub = {};
    const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, control: stub, usageStatus: stub });
    try {
      db.insertProject({
        id: "pLegacy", name: "LegacyStaleKey", repoPath: primary, vaultPath: vaultDir, config: {},
        createdAt: now, archivedAt: null, reserved: false,
        repos: [{ key: "svc.stale-1", path: svcA }],
      });

      // (E1) repoPath-ONLY rebind (repos omitted) to a non-conflicting repo must now SUCCEED despite the
      // stored registry carrying the legacy stale-shaped key (previously 400'd: validateRepoRegistry
      // re-ran the shape check against the UNCHANGED stored registry on every rebind).
      const e1 = await app.inject({ method: "PATCH", url: "/api/projects/pLegacy", payload: { repoPath: newPrimary } });
      check("(E1) repoPath-only rebind succeeds despite a stored legacy .stale-<ts>-shaped key", e1.statusCode === 200);
      check("(E1) repoPath actually rebound", db.getProject("pLegacy")?.repoPath === newPrimary);
      check("(E1) the legacy key survives, UNCHANGED", db.getProject("pLegacy")?.repos?.[0]?.key === "svc.stale-1");

      // (E2) PATCH explicitly echoing the SAME (unchanged) repos array back also succeeds.
      const e2 = await app.inject({ method: "PATCH", url: "/api/projects/pLegacy", payload: { repos: [{ key: "svc.stale-1", path: svcA }] } });
      check("(E2) explicitly echoing the unchanged legacy registry -> 200", e2.statusCode === 200);
      check("(E2) the legacy key still present", db.getProject("pLegacy")?.repos?.[0]?.key === "svc.stale-1");

      // (E3) CONTROL: adding a brand-new, DIFFERENTLY-named stale-shaped key alongside the legacy one is
      // still REJECTED — the exemption must never widen to a key that wasn't already in the pre-patch
      // stored registry.
      const e3 = await app.inject({
        method: "PATCH", url: "/api/projects/pLegacy",
        payload: { repos: [{ key: "svc.stale-1", path: svcA }, { key: "new.stale-2", path: svcB }] },
      });
      check("(E3) CONTROL: adding a NEW stale-shaped key alongside the legacy one -> 400 (exemption doesn't widen)", e3.statusCode === 400);
      check("(E3) error still names the stale-aside rule", /stale-<ts>|renamed-aside/.test(e3.json().error ?? ""));
      check("(E3) registry UNCHANGED after rejection", db.getProject("pLegacy")?.repos?.length === 1);
    } finally {
      db.close();
    }
  }

  // =====================================================================================================
  // PART F — card e3fcd8ea item 2: the SAME exemption on the elevated loom-platform project_update surface.
  // =====================================================================================================
  {
    const db = new Db(path.join(tmpHome, "legacy-stale-key-f.db"));
    db.insertProject({ id: "pHome", name: "Loom Platform", repoPath: primary, vaultPath: primary, config: {}, createdAt: now, archivedAt: null, reserved: true });
    db.insertProject({
      id: "pLegacyPlatform", name: "LegacyPlatform", repoPath: primary, vaultPath: primary, config: {},
      createdAt: now, archivedAt: null, reserved: false,
      repos: [{ key: "svc.stale-1", path: svcA }],
    });
    db.insertAgent({ id: "agentLead", projectId: "pHome", name: "Lead", startupPrompt: "LEAD", position: 0, profileId: null });
    db.insertSession({ id: "PL2", projectId: "pHome", agentId: "agentLead", engineSessionId: null, title: null, cwd: primary, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "platform", parentSessionId: null });

    class SeamHost extends createSeamHost(PtyHost) {
      createPty(opts) { return { ...super.createPty(opts), pid: 1 }; }
      stop() {}
    }
    const host = new SeamHost({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} });
    const svc = new SessionService(db, host, new OrchestrationControl());
    const server = new PlatformMcpRouter(db, svc).buildServer("PL2");
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "legacy-stale-key-platform-test", version: "0" });
    await client.connect(clientT);
    const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

    const f1 = await call("project_update", { projectId: "pLegacyPlatform", repoPath: newPrimary });
    check("(F1) platform project_update repoPath rebind succeeds despite a stored legacy .stale-<ts>-shaped key", !f1.error && f1.repoPath === newPrimary);
    check("(F1) the legacy key survives, UNCHANGED", db.getProject("pLegacyPlatform")?.repos?.[0]?.key === "svc.stale-1");

    await client.close();
    db.close();
  }

  // =====================================================================================================
  // PART G — card 98039b36: the SAME `existingKeys` exemption shape, now for a CASE-ONLY-DISTINCT legacy
  // pair ("Svc"/"svc") — seeded here directly via `Db.insertProject` (bypassing validateRepoRegistry) to
  // simulate data written before this guard existed, exactly like PART E does for the stale-suffix shape.
  // Manager-approval point (a): the exemption must cover ONLY a pair where BOTH spellings are already
  // stored — a brand-new key that merely case-collides with ONE HALF of that legacy pair must still be
  // rejected, even though the pair itself is grandfathered.
  // =====================================================================================================
  {
    const db = new Db(path.join(tmpHome, "legacy-case-key-g.db"));
    const stub = {};
    const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, control: stub, usageStatus: stub });
    try {
      db.insertProject({
        id: "pLegacyCase", name: "LegacyCaseKey", repoPath: primary, vaultPath: vaultDir, config: {},
        createdAt: now, archivedAt: null, reserved: false,
        repos: [{ key: "Svc", path: svcA }, { key: "svc", path: svcB }],
      });

      // (G1) repoPath-ONLY rebind (repos omitted) to a non-conflicting repo succeeds despite the stored
      // registry carrying a legacy case-only-distinct pair.
      const g1 = await app.inject({ method: "PATCH", url: "/api/projects/pLegacyCase", payload: { repoPath: newPrimary } });
      check("(G1) repoPath-only rebind succeeds despite a stored legacy case-only-distinct key pair", g1.statusCode === 200);
      check("(G1) repoPath actually rebound", db.getProject("pLegacyCase")?.repoPath === newPrimary);
      check("(G1) both legacy keys survive, UNCHANGED", db.getProject("pLegacyCase")?.repos?.length === 2
        && db.getProject("pLegacyCase")?.repos.some((r) => r.key === "Svc")
        && db.getProject("pLegacyCase")?.repos.some((r) => r.key === "svc"));

      // (G2) PATCH explicitly echoing the SAME (unchanged) legacy pair back also succeeds.
      const g2 = await app.inject({ method: "PATCH", url: "/api/projects/pLegacyCase", payload: { repos: [{ key: "Svc", path: svcA }, { key: "svc", path: svcB }] } });
      check("(G2) explicitly echoing the unchanged legacy case-only-distinct pair -> 200", g2.statusCode === 200);
      check("(G2) both legacy keys still present", db.getProject("pLegacyCase")?.repos?.length === 2);

      // (G3) CONTROL (manager-approval point a): adding a brand-new key ("SVC", a THIRD casing) that
      // case-collides with HALF of the legacy pair is still REJECTED — the exemption must never widen to a
      // key that wasn't already in the pre-patch stored registry, even though its partner IS exempted.
      const svcC = mkRepo("svcC");
      const g3 = await app.inject({
        method: "PATCH", url: "/api/projects/pLegacyCase",
        payload: { repos: [{ key: "Svc", path: svcA }, { key: "svc", path: svcB }, { key: "SVC", path: svcC }] },
      });
      check("(G3) CONTROL: adding a NEW case-colliding key alongside the legacy pair -> 400 (exemption doesn't widen)", g3.statusCode === 400);
      check("(G3) error names the case-collision rule", /differs only in case/.test(g3.json().error ?? ""));
      check("(G3) registry UNCHANGED after rejection", db.getProject("pLegacyCase")?.repos?.length === 2);

      // (G4) Code Review b0369501 finding 2a: the SAME rejection must hold regardless of PAYLOAD ORDER —
      // the new key ("SVC") listed FIRST, ahead of both legacy spellings, must be rejected exactly like
      // G3 (where it was listed last). Proves the exemption check isn't order-sensitive (e.g. accidentally
      // keying off "whichever entry happens to be recorded first for a given fold").
      const g4 = await app.inject({
        method: "PATCH", url: "/api/projects/pLegacyCase",
        payload: { repos: [{ key: "SVC", path: svcC }, { key: "Svc", path: svcA }, { key: "svc", path: svcB }] },
      });
      check("(G4) CONTROL: the new case-colliding key FIRST in the payload -> 400 (order-independent)", g4.statusCode === 400);
      check("(G4) error names the case-collision rule", /differs only in case/.test(g4.json().error ?? ""));
      check("(G4) registry UNCHANGED after rejection", db.getProject("pLegacyCase")?.repos?.length === 2);
      try { fs.rmSync(svcC, { recursive: true, force: true }); } catch { /* best-effort */ }
    } finally {
      db.close();
    }
  }

  // =====================================================================================================
  // PART I — card 98039b36, Code Review b0369501 finding 2b: a SINGLE stored key (no pre-existing pair at
  // all — "Svc" alone), then a PATCH that ADDS "svc" alongside it, must be REJECTED. Distinct from G3/G4
  // (which start from an already-EXEMPTED pair): here `existingKeys` has only ONE of the two spellings, so
  // the pair can never be grandfathered — this is the ordinary "introducing a new collision" case, now
  // proven specifically for the single-stored-key starting point the manager named.
  // =====================================================================================================
  {
    const db = new Db(path.join(tmpHome, "single-key-add-collision-i.db"));
    const stub = {};
    const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, control: stub, usageStatus: stub });
    try {
      const created = await app.inject({
        method: "POST", url: "/api/projects",
        payload: { name: "SingleKeyAddCollision", repoPath: primary, vaultPath: vaultDir, repos: [{ key: "Svc", path: svcA }] },
      });
      const projectId = created.json().id;
      check("(I1-setup) project created with a single stored key \"Svc\"", created.json().repos?.length === 1);

      const i1add = await app.inject({
        method: "PATCH", url: `/api/projects/${projectId}`,
        payload: { repos: [{ key: "Svc", path: svcA }, { key: "svc", path: svcB }] },
      });
      check("(I1) PATCH adding \"svc\" alongside a lone stored \"Svc\" -> 400 (no pair to grandfather)", i1add.statusCode === 400);
      check("(I1) error names the case-collision rule", /differs only in case/.test(i1add.json().error ?? ""));
      check("(I1) registry UNCHANGED after rejection", db.getProject(projectId)?.repos?.length === 1);
    } finally {
      db.close();
    }
  }

  // =====================================================================================================
  // PART H — card 98039b36: the SAME legacy case-collision exemption on the elevated loom-platform
  // project_update surface (mirrors PART F exactly, for the case-only-distinct shape instead of the
  // stale-suffix shape).
  // =====================================================================================================
  {
    const db = new Db(path.join(tmpHome, "legacy-case-key-h.db"));
    db.insertProject({ id: "pHome", name: "Loom Platform", repoPath: primary, vaultPath: primary, config: {}, createdAt: now, archivedAt: null, reserved: true });
    db.insertProject({
      id: "pLegacyCasePlatform", name: "LegacyCasePlatform", repoPath: primary, vaultPath: primary, config: {},
      createdAt: now, archivedAt: null, reserved: false,
      repos: [{ key: "Svc", path: svcA }, { key: "svc", path: svcB }],
    });
    db.insertAgent({ id: "agentLead", projectId: "pHome", name: "Lead", startupPrompt: "LEAD", position: 0, profileId: null });
    db.insertSession({ id: "PL3", projectId: "pHome", agentId: "agentLead", engineSessionId: null, title: null, cwd: primary, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "platform", parentSessionId: null });

    class SeamHost extends createSeamHost(PtyHost) {
      createPty(opts) { return { ...super.createPty(opts), pid: 1 }; }
      stop() {}
    }
    const host = new SeamHost({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} });
    const svc = new SessionService(db, host, new OrchestrationControl());
    const server = new PlatformMcpRouter(db, svc).buildServer("PL3");
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "legacy-case-key-platform-test", version: "0" });
    await client.connect(clientT);
    const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

    const h1 = await call("project_update", { projectId: "pLegacyCasePlatform", repoPath: newPrimary });
    check("(H1) platform project_update repoPath rebind succeeds despite a stored legacy case-only-distinct key pair", !h1.error && h1.repoPath === newPrimary);
    check("(H1) both legacy keys survive, UNCHANGED", db.getProject("pLegacyCasePlatform")?.repos?.length === 2);

    await client.close();
    db.close();
  }
} finally {
  for (const d of [tmpHome, primary, svcA, svcB, newPrimary]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a repoPath/vaultPath rebind that OMITS `repos` still re-validates the EXISTING registry against the new primary on both the human REST PATCH and the elevated platform project_update (rejecting a conflict, leaving a non-conflicting rebind unaffected), every alias/dedup comparison canonicalizes paths first (native realpath + win32 case-fold) so differently-spelled/-cased/trailing-slashed paths to the identical real directory are still caught as the same repo, (CARRIED item 3, phase 2) a `repos` registry EDIT itself — repathing or removing an entry, not just a repoPath rebind — is refused while ANY live worktree session exists for the project, succeeding again once it exits, (card e3fcd8ea item 2) a project carrying a legacy .stale-<ts>-shaped stored key (pre-dating the write-side guard) is no longer permanently blocked from every future rebind/echo on either surface while a genuinely NEW stale-shaped key is still rejected, and (card 98039b36, incl. Code Review b0369501 finding 2) the SAME existingKeys-exemption shape for a legacy CASE-ONLY-DISTINCT key pair — grandfathered on rebind/echo on both surfaces, while a brand-new key that merely case-collides with HALF of that pair is still rejected regardless of PAYLOAD ORDER (the exemption never widens), and the same rejection holds starting from a single stored key with no pre-existing pair to grandfather at all."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
