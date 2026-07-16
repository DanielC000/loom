import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Reference-repos epic Phase 2 (card f4888775, "Interpretation A"): the HUMAN-only REST to set
// Project.referenceRepos, isGitRepo-validated, and REJECTED on every agent-facing write surface. Phase 1
// (the referenceRepos: string[] field + db column + migration, card f4888775 Phase 1) is already merged —
// see reference-repos-migration.mjs. HERMETIC + CLAUDE-FREE + NETWORK-FREE, modeled on project-rebind.mjs
// (the sibling repoPath trust-boundary test) + platform-home-rest.mjs (Db + buildServer via app.inject).
//
// Proves the DoD:
//   PART A — human REST create (POST /api/projects) + update (PATCH /api/projects/:id) ROUND-TRIP
//            referenceRepos; each entry is isGitRepo-checked; a non-repo / non-absolute entry is
//            REJECTED (400) with the stored value left UNCHANGED; omitting the field on a PATCH leaves
//            the existing value untouched; an explicit [] clears it.
//   PART B — every AGENT-facing write surface REJECTS/IGNORES a smuggled referenceRepos:
//            loom-setup's project_create / project_init / project_update, and the elevated
//            loom-platform's project_create / project_init / project_update — none of them expose
//            referenceRepos in their inputSchema, and a caller that smuggles it anyway never gets it
//            persisted (mirrors project-rebind.mjs's repoPath smuggle assertion).
//   PART C — the profile validator (profiles/validate.ts, `.strict()`) REJECTS a referenceRepos key
//            outright — it isn't a Profile field at all, so no profile write path can ever carry it.
//
// Run: 1) build (turbo builds shared first), 2) node test/reference-repos-rest.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME (set BEFORE importing dist; paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-refrepos-rest-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_PORT = "45321";
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
const { validateProfile } = await import("../dist/profiles/validate.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

// --- Real temp git repos: two valid reference targets, plus a real dir that is NOT a git repo. ---
const mkRepo = (tag) => {
  const r = path.join(os.tmpdir(), `loom-refrepos-${tag}-${Date.now()}-${process.pid}`);
  fs.mkdirSync(r, { recursive: true });
  fs.writeFileSync(path.join(r, "README.md"), `# ${tag}\n`);
  execSync(`git init -q && git add . && git -c user.email=r@loom -c user.name=r commit -q -m init`, { cwd: r });
  return r;
};
const primary = mkRepo("primary");
const refA = mkRepo("refA");
const refB = mkRepo("refB");
const nonRepo = path.join(os.tmpdir(), `loom-refrepos-nonrepo-${Date.now()}-${process.pid}`);
fs.mkdirSync(nonRepo, { recursive: true }); // a real dir, but NOT a git repo

const now = new Date().toISOString();

try {
  // =====================================================================================================
  // PART A — human-only REST: POST /api/projects + PATCH /api/projects/:id
  // =====================================================================================================
  {
    const db = new Db(path.join(tmpHome, "rest.db"));
    const stub = {};
    const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, control: stub, usageStatus: stub });
    try {
      // (A0) create with a NON-REPO primary repoPath is REJECTED (400), no project row created — closes
      // the two-path validation asymmetry (this REST create path used to only presence-check repoPath,
      // unlike project_create/checkRepoRebind and unlike the referenceRepos entries validated below).
      const beforeCount0 = db.listAllProjects().length;
      const badRepoPath = await app.inject({
        method: "POST", url: "/api/projects",
        payload: { name: "BadRepo", repoPath: nonRepo, vaultPath: primary },
      });
      check("(A0) POST with a non-repo repoPath → 400", badRepoPath.statusCode === 400);
      check("(A0) error names the offending repoPath", /not an existing git repository/.test(badRepoPath.json().error ?? ""));
      check("(A0) no project row was created on rejection", db.listAllProjects().length === beforeCount0);

      // (A1) create with a valid referenceRepos round-trips it.
      const created = await app.inject({
        method: "POST", url: "/api/projects",
        payload: { name: "P", repoPath: primary, vaultPath: primary, referenceRepos: [refA] },
      });
      check("(A1) POST /api/projects with a valid referenceRepos → 201", created.statusCode === 201);
      const p1 = created.json();
      check("(A1) response round-trips referenceRepos", Array.isArray(p1.referenceRepos) && p1.referenceRepos.length === 1 && p1.referenceRepos[0] === refA);
      check("(A1) persisted to the Db", JSON.stringify(db.getProject(p1.id)?.referenceRepos) === JSON.stringify([refA]));

      // (A2) create omitting referenceRepos defaults to [].
      const created2 = await app.inject({ method: "POST", url: "/api/projects", payload: { name: "P2", repoPath: primary, vaultPath: primary } });
      check("(A2) POST /api/projects omitting referenceRepos → [] default", Array.isArray(created2.json().referenceRepos) && created2.json().referenceRepos.length === 0);

      // (A3) create with a NON-REPO entry is REJECTED (400), no project row created.
      const beforeCount = db.listAllProjects().length;
      const badCreate = await app.inject({
        method: "POST", url: "/api/projects",
        payload: { name: "Bad", repoPath: primary, vaultPath: primary, referenceRepos: [nonRepo] },
      });
      check("(A3) POST with a non-repo referenceRepos entry → 400", badCreate.statusCode === 400);
      check("(A3) error names the offending non-repo entry", /not an existing git repository/.test(badCreate.json().error ?? ""));
      check("(A3) no project row was created on rejection", db.listAllProjects().length === beforeCount);

      // (A4) create with a RELATIVE entry is REJECTED (400) — absolute paths only.
      const badRelative = await app.inject({
        method: "POST", url: "/api/projects",
        payload: { name: "BadRel", repoPath: primary, vaultPath: primary, referenceRepos: ["../some-relative-repo"] },
      });
      check("(A4) POST with a relative referenceRepos entry → 400", badRelative.statusCode === 400);
      check("(A4) error names the absolute-path requirement", /absolute path/.test(badRelative.json().error ?? ""));

      // (A5) PATCH sets referenceRepos on an existing project.
      const patched = await app.inject({ method: "PATCH", url: `/api/projects/${p1.id}`, payload: { referenceRepos: [refA, refB] } });
      check("(A5) PATCH with valid referenceRepos → 200", patched.statusCode === 200);
      check("(A5) PATCH round-trips referenceRepos", JSON.stringify(patched.json().referenceRepos) === JSON.stringify([refA, refB]));
      check("(A5) PATCH persisted to the Db", JSON.stringify(db.getProject(p1.id)?.referenceRepos) === JSON.stringify([refA, refB]));

      // (A6) PATCH with a non-repo entry is REJECTED (400), stored value UNCHANGED.
      const patchBad = await app.inject({ method: "PATCH", url: `/api/projects/${p1.id}`, payload: { referenceRepos: [nonRepo] } });
      check("(A6) PATCH with a non-repo referenceRepos entry → 400", patchBad.statusCode === 400);
      check("(A6) rejected PATCH left referenceRepos UNCHANGED", JSON.stringify(db.getProject(p1.id)?.referenceRepos) === JSON.stringify([refA, refB]));

      // (A7) PATCH omitting referenceRepos leaves the existing value untouched (only patches name).
      const patchOmit = await app.inject({ method: "PATCH", url: `/api/projects/${p1.id}`, payload: { name: "Renamed" } });
      check("(A7) PATCH omitting referenceRepos → 200", patchOmit.statusCode === 200);
      check("(A7) referenceRepos untouched by an unrelated PATCH", JSON.stringify(db.getProject(p1.id)?.referenceRepos) === JSON.stringify([refA, refB]));
      check("(A7) name DID update", db.getProject(p1.id)?.name === "Renamed");

      // (A8) PATCH with an explicit [] CLEARS referenceRepos.
      const patchClear = await app.inject({ method: "PATCH", url: `/api/projects/${p1.id}`, payload: { referenceRepos: [] } });
      check("(A8) PATCH with [] clears referenceRepos → 200", patchClear.statusCode === 200);
      check("(A8) referenceRepos cleared in the Db", Array.isArray(db.getProject(p1.id)?.referenceRepos) && db.getProject(p1.id).referenceRepos.length === 0);

      // (A9) POST /api/setup/project-init (the human wizard "Create new" path — distinct from the AGENT
      // project_init in PART B, which IGNORES a smuggled ref) round-trips a valid referenceRepos: it
      // bootstraps a brand-new dir AND binds the ref, with the SAME absolute + isGitRepo validation.
      const initOk = await app.inject({
        method: "POST", url: "/api/setup/project-init",
        payload: { name: "InitWithRefs", referenceRepos: [refA] },
      });
      check("(A9) project-init with a valid referenceRepos → 201", initOk.statusCode === 201);
      check("(A9) project-init round-trips referenceRepos", JSON.stringify(initOk.json().referenceRepos) === JSON.stringify([refA]));
      check("(A9) project-init persisted to the Db", JSON.stringify(db.getProject(initOk.json().id)?.referenceRepos) === JSON.stringify([refA]));

      // (A10) project-init with a NON-REPO entry is REJECTED (400) — and, because it validates BEFORE
      // bootstrapping the dir, no project row is created (and no stray folder is left behind).
      const beforeInit = db.listAllProjects().length;
      const initBad = await app.inject({
        method: "POST", url: "/api/setup/project-init",
        payload: { name: "InitBad", referenceRepos: [nonRepo] },
      });
      check("(A10) project-init with a non-repo referenceRepos entry → 400", initBad.statusCode === 400);
      check("(A10) project-init error names the offending entry", /not an existing git repository/.test(initBad.json().error ?? ""));
      check("(A10) no project row was created on rejection", db.listAllProjects().length === beforeInit);
    } finally {
      db.close();
    }
  }

  // =====================================================================================================
  // PART B — every agent-facing write surface REJECTS/IGNORES a smuggled referenceRepos.
  // =====================================================================================================
  {
    const db = new Db(path.join(tmpHome, "agent.db"));
    db.insertProject({ id: "pHome", name: "Loom Platform", repoPath: primary, vaultPath: primary, config: {}, createdAt: now, archivedAt: null, reserved: true });
    db.insertProject({ id: "pExisting", name: "Existing", repoPath: primary, vaultPath: primary, config: {}, createdAt: now, archivedAt: null, reserved: false, referenceRepos: [] });
    db.insertAgent({ id: "agentLead", projectId: "pHome", name: "Lead", startupPrompt: "LEAD", position: 0, profileId: null });
    db.insertAgent({ id: "agentSetup", projectId: "pHome", name: "Setup", startupPrompt: "SETUP", position: 0, profileId: null });

    class SeamHost extends PtyHost {
      createPty() { return { pid: 4242, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} }; }
      stop() {}
    }
    const events = { onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); }, onBusy(id, busy) { db.setBusy(id, busy); }, onContextStats() {}, onRateLimited() {}, onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); } };
    const host = new SeamHost(events);
    const svc = new SessionService(db, host, new OrchestrationControl());

    const parse = (res) => JSON.parse(res.content[0].text);
    const connect = async (router) => {
      const server = router.buildServer();
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      await server.connect(serverT);
      const client = new Client({ name: "refrepos-test", version: "0" });
      await client.connect(clientT);
      return { client, call: async (name, args) => parse(await client.callTool({ name, arguments: args })) };
    };

    const setup = await connect(new SetupMcpRouter(db, svc));
    const plat = await connect(new PlatformMcpRouter(db, svc));

    // (B0) neither surface even ADVERTISES referenceRepos on any project-write tool's inputSchema.
    const setupTools = (await setup.client.listTools()).tools;
    const platTools = (await plat.client.listTools()).tools;
    for (const [label, tools] of [["loom-setup", setupTools], ["loom-platform", platTools]]) {
      for (const toolName of ["project_create", "project_init", "project_update"]) {
        const schema = tools.find((t) => t.name === toolName)?.inputSchema?.properties ?? {};
        check(`(B0) ${label} ${toolName} inputSchema has NO referenceRepos`, !("referenceRepos" in schema));
      }
    }

    // (B1) setup project_create: smuggled referenceRepos is IGNORED — created project stays [].
    const c1 = await setup.call("project_create", { name: "SetupCreated", repoPath: primary, referenceRepos: [refA] });
    check("(B1) setup project_create smuggled referenceRepos → created project has [] (not persisted)", Array.isArray(c1.referenceRepos) && c1.referenceRepos.length === 0);
    check("(B1) confirmed in the Db too", db.getProject(c1.id)?.referenceRepos?.length === 0);

    // (B2) platform (elevated) project_create: same guarantee.
    const c2 = await plat.call("project_create", { name: "PlatCreated", repoPath: primary, referenceRepos: [refA] });
    check("(B2) platform project_create smuggled referenceRepos → created project has [] (not persisted)", Array.isArray(c2.referenceRepos) && c2.referenceRepos.length === 0);
    check("(B2) confirmed in the Db too", db.getProject(c2.id)?.referenceRepos?.length === 0);

    // (B3) setup project_init: smuggled referenceRepos is IGNORED on the sanctioned-dir bootstrap path too.
    const i1 = await setup.call("project_init", { name: "SetupInit", referenceRepos: [refA] });
    check("(B3) setup project_init smuggled referenceRepos → created project has [] (not persisted)", !i1.error && Array.isArray(i1.referenceRepos) && i1.referenceRepos.length === 0);

    // (B4) platform (elevated) project_init: same guarantee.
    const i2 = await plat.call("project_init", { name: "PlatInit", referenceRepos: [refA] });
    check("(B4) platform project_init smuggled referenceRepos → created project has [] (not persisted)", !i2.error && Array.isArray(i2.referenceRepos) && i2.referenceRepos.length === 0);

    // (B5) setup project_update: smuggled referenceRepos on an EXISTING project is IGNORED.
    await setup.call("project_update", { projectId: "pExisting", name: "SetupRenamed", referenceRepos: [refB] });
    check("(B5) setup project_update smuggled referenceRepos leaves the Db value UNCHANGED", db.getProject("pExisting")?.referenceRepos?.length === 0);
    check("(B5) the structural field it DOES own still applied", db.getProject("pExisting")?.name === "SetupRenamed");

    // (B6) platform (elevated) project_update: same guarantee — even the MOST privileged agent surface
    // can never introduce referenceRepos.
    await plat.call("project_update", { projectId: "pExisting", name: "PlatRenamed", referenceRepos: [refB] });
    check("(B6) platform project_update smuggled referenceRepos leaves the Db value UNCHANGED", db.getProject("pExisting")?.referenceRepos?.length === 0);
    check("(B6) the structural field it DOES own still applied", db.getProject("pExisting")?.name === "PlatRenamed");

    await setup.client.close();
    await plat.client.close();
    db.close();
  }

  // =====================================================================================================
  // PART C — the profile validator REJECTS referenceRepos outright (not a Profile field at all).
  // =====================================================================================================
  {
    const v = validateProfile({ name: "Rig", referenceRepos: [refA] });
    check("(C1) validateProfile REJECTS a referenceRepos key (unrecognized, .strict())", v.ok === false && /referenceRepos/.test(v.error));
    // Control: the SAME payload minus referenceRepos validates cleanly, so the rejection is specific to
    // the smuggled key, not an unrelated schema issue.
    const clean = validateProfile({ name: "Rig" });
    check("(C1 control) the same payload minus referenceRepos validates cleanly", clean.ok === true);
  }
} finally {
  for (const d of [tmpHome, primary, refA, refB, nonRepo]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — referenceRepos round-trips on the HUMAN-only REST create/update/project-init (isGitRepo + absolute-path validated, rejection leaves the stored value unchanged / creates no row), is absent from every agent-facing MCP write surface's inputSchema (loom-setup + the elevated loom-platform's project_create/project_init/project_update), a smuggled value is never persisted on any of them, and the profile validator rejects it outright as an unrecognized key — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
