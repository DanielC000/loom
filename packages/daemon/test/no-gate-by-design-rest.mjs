import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Trust-boundary test for Project.noGateByDesign (card 58b0bb60) — the HUMAN-only REST-settable flag that
// suppresses the per-merge "unverified: no gateCommand" warning. Modeled on reference-repos-rest.mjs (the
// sibling referenceRepos trust-boundary test). HERMETIC + CLAUDE-FREE + NETWORK-FREE.
//
// Proves the DoD's trust-posture requirement ("Human-only to set... Confirm it's rejected on every agent
// write surface"):
//   PART A — human REST create (POST /api/projects) + update (PATCH /api/projects/:id) round-trip
//            noGateByDesign; a non-boolean value is REJECTED (400) with the stored value left unchanged;
//            omitting the field on a PATCH leaves the existing value untouched.
//   PART B — every AGENT-facing write surface REJECTS/IGNORES a smuggled noGateByDesign: loom-setup's
//            project_create / project_init / project_update, and the elevated loom-platform's
//            project_create / project_init / project_update — none of them expose noGateByDesign in
//            their inputSchema, and a caller that smuggles it anyway never gets it persisted.
//   PART C — the profile validator (profiles/validate.ts, `.strict()`) REJECTS a noGateByDesign key
//            outright — it isn't a Profile field at all.
//
// Run: 1) build (turbo builds shared first), 2) node test/no-gate-by-design-rest.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-no-gate-by-design-rest-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_PORT = "45322";
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

const mkRepo = (tag) => {
  const r = path.join(os.tmpdir(), `loom-ngbd-${tag}-${Date.now()}-${process.pid}`);
  fs.mkdirSync(r, { recursive: true });
  fs.writeFileSync(path.join(r, "README.md"), `# ${tag}\n`);
  execSync(`git init -q && git add . && git -c user.email=r@loom -c user.name=r commit -q -m init`, { cwd: r });
  return r;
};
const primary = mkRepo("primary");

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
      // (A1) create with noGateByDesign:true round-trips it.
      const created = await app.inject({
        method: "POST", url: "/api/projects",
        payload: { name: "P", repoPath: primary, vaultPath: primary, noGateByDesign: true },
      });
      check("(A1) POST /api/projects with noGateByDesign:true → 201", created.statusCode === 201);
      const p1 = created.json();
      check("(A1) response round-trips noGateByDesign:true", p1.noGateByDesign === true);
      check("(A1) persisted to the Db", db.getProject(p1.id)?.noGateByDesign === true);

      // (A2) create omitting noGateByDesign defaults to false.
      const created2 = await app.inject({ method: "POST", url: "/api/projects", payload: { name: "P2", repoPath: primary, vaultPath: primary } });
      check("(A2) POST /api/projects omitting noGateByDesign → false default", created2.json().noGateByDesign === false);

      // (A3) PATCH sets noGateByDesign on an existing (false) project.
      const patched = await app.inject({ method: "PATCH", url: `/api/projects/${created2.json().id}`, payload: { noGateByDesign: true } });
      check("(A3) PATCH with noGateByDesign:true → 200", patched.statusCode === 200);
      check("(A3) PATCH round-trips noGateByDesign:true", patched.json().noGateByDesign === true);
      check("(A3) PATCH persisted to the Db", db.getProject(created2.json().id)?.noGateByDesign === true);

      // (A4) PATCH with a non-boolean value is REJECTED (400), stored value UNCHANGED.
      const patchBad = await app.inject({ method: "PATCH", url: `/api/projects/${created2.json().id}`, payload: { noGateByDesign: "yes" } });
      check("(A4) PATCH with a non-boolean noGateByDesign → 400", patchBad.statusCode === 400);
      check("(A4) rejected PATCH left noGateByDesign UNCHANGED", db.getProject(created2.json().id)?.noGateByDesign === true);

      // (A5) PATCH omitting noGateByDesign leaves the existing value untouched (only patches name).
      const patchOmit = await app.inject({ method: "PATCH", url: `/api/projects/${created2.json().id}`, payload: { name: "Renamed" } });
      check("(A5) PATCH omitting noGateByDesign → 200", patchOmit.statusCode === 200);
      check("(A5) noGateByDesign untouched by an unrelated PATCH", db.getProject(created2.json().id)?.noGateByDesign === true);
      check("(A5) name DID update", db.getProject(created2.json().id)?.name === "Renamed");

      // (A6) PATCH with explicit false clears it back.
      const patchClear = await app.inject({ method: "PATCH", url: `/api/projects/${created2.json().id}`, payload: { noGateByDesign: false } });
      check("(A6) PATCH with noGateByDesign:false → 200", patchClear.statusCode === 200);
      check("(A6) noGateByDesign cleared in the Db", db.getProject(created2.json().id)?.noGateByDesign === false);

      // (A7) POST /api/setup/project-init (the human wizard "Create new" path) round-trips noGateByDesign
      // too — the most relevant path in practice (a vault-only project has no buildable code).
      const initOk = await app.inject({
        method: "POST", url: "/api/setup/project-init",
        payload: { name: "InitVault", kind: "vault", noGateByDesign: true },
      });
      check("(A7) project-init with noGateByDesign:true → 201", initOk.statusCode === 201);
      check("(A7) project-init round-trips noGateByDesign:true", initOk.json().noGateByDesign === true);
      check("(A7) project-init persisted to the Db", db.getProject(initOk.json().id)?.noGateByDesign === true);
    } finally {
      db.close();
    }
  }

  // =====================================================================================================
  // PART B — every agent-facing write surface REJECTS/IGNORES a smuggled noGateByDesign.
  // =====================================================================================================
  {
    const db = new Db(path.join(tmpHome, "agent.db"));
    db.insertProject({ id: "pHome", name: "Loom Platform", repoPath: primary, vaultPath: primary, config: {}, createdAt: now, archivedAt: null, reserved: true, referenceRepos: [], noGateByDesign: false });
    db.insertProject({ id: "pExisting", name: "Existing", repoPath: primary, vaultPath: primary, config: {}, createdAt: now, archivedAt: null, reserved: false, referenceRepos: [], noGateByDesign: false });
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
      const client = new Client({ name: "ngbd-test", version: "0" });
      await client.connect(clientT);
      return { client, call: async (name, args) => parse(await client.callTool({ name, arguments: args })) };
    };

    const setup = await connect(new SetupMcpRouter(db, svc));
    const plat = await connect(new PlatformMcpRouter(db, svc));

    // (B0) neither surface even ADVERTISES noGateByDesign on any project-write tool's inputSchema.
    const setupTools = (await setup.client.listTools()).tools;
    const platTools = (await plat.client.listTools()).tools;
    for (const [label, tools] of [["loom-setup", setupTools], ["loom-platform", platTools]]) {
      for (const toolName of ["project_create", "project_init", "project_update"]) {
        const schema = tools.find((t) => t.name === toolName)?.inputSchema?.properties ?? {};
        check(`(B0) ${label} ${toolName} inputSchema has NO noGateByDesign`, !("noGateByDesign" in schema));
      }
    }

    // (B1) setup project_create: smuggled noGateByDesign is IGNORED — created project stays false.
    const c1 = await setup.call("project_create", { name: "SetupCreated", repoPath: primary, noGateByDesign: true });
    check("(B1) setup project_create smuggled noGateByDesign → created project has false (not persisted)", c1.noGateByDesign === false);
    check("(B1) confirmed in the Db too", db.getProject(c1.id)?.noGateByDesign === false);

    // (B2) platform (elevated) project_create: same guarantee.
    const c2 = await plat.call("project_create", { name: "PlatCreated", repoPath: primary, noGateByDesign: true });
    check("(B2) platform project_create smuggled noGateByDesign → created project has false (not persisted)", c2.noGateByDesign === false);
    check("(B2) confirmed in the Db too", db.getProject(c2.id)?.noGateByDesign === false);

    // (B3) setup project_init: smuggled noGateByDesign is IGNORED on the sanctioned-dir bootstrap path too.
    const i1 = await setup.call("project_init", { name: "SetupInit", kind: "vault", noGateByDesign: true });
    check("(B3) setup project_init smuggled noGateByDesign → created project has false (not persisted)", !i1.error && i1.noGateByDesign === false);

    // (B4) platform (elevated) project_init: same guarantee.
    const i2 = await plat.call("project_init", { name: "PlatInit", kind: "vault", noGateByDesign: true });
    check("(B4) platform project_init smuggled noGateByDesign → created project has false (not persisted)", !i2.error && i2.noGateByDesign === false);

    // (B5) setup project_update: smuggled noGateByDesign on an EXISTING project is IGNORED.
    await setup.call("project_update", { projectId: "pExisting", name: "SetupRenamed", noGateByDesign: true });
    check("(B5) setup project_update smuggled noGateByDesign leaves the Db value UNCHANGED", db.getProject("pExisting")?.noGateByDesign === false);
    check("(B5) the structural field it DOES own still applied", db.getProject("pExisting")?.name === "SetupRenamed");

    // (B6) platform (elevated) project_update: same guarantee — even the MOST privileged agent surface
    // can never introduce noGateByDesign.
    await plat.call("project_update", { projectId: "pExisting", name: "PlatRenamed", noGateByDesign: true });
    check("(B6) platform project_update smuggled noGateByDesign leaves the Db value UNCHANGED", db.getProject("pExisting")?.noGateByDesign === false);
    check("(B6) the structural field it DOES own still applied", db.getProject("pExisting")?.name === "PlatRenamed");

    await setup.client.close();
    await plat.client.close();
    db.close();
  }

  // =====================================================================================================
  // PART C — the profile validator REJECTS noGateByDesign outright (not a Profile field at all).
  // =====================================================================================================
  {
    const v = validateProfile({ name: "Rig", noGateByDesign: true });
    check("(C1) validateProfile REJECTS a noGateByDesign key (unrecognized, .strict())", v.ok === false && /noGateByDesign/.test(v.error));
    const clean = validateProfile({ name: "Rig" });
    check("(C1 control) the same payload minus noGateByDesign validates cleanly", clean.ok === true);
  }
} finally {
  for (const d of [tmpHome, primary]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — noGateByDesign round-trips on the HUMAN-only REST create/update/project-init (a non-boolean value 400s, rejection/omission leaves the stored value unchanged), is absent from every agent-facing MCP write surface's inputSchema (loom-setup + the elevated loom-platform's project_create/project_init/project_update), a smuggled value is never persisted on any of them, and the profile validator rejects it outright as an unrecognized key — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
