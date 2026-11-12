import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card c24dfd28 — a project's vaultPath may not EQUAL or lie INSIDE ANOTHER project's repo path (the vault
// auto-committer would commit into that project's code repo), unless that foreign repo's own path / git
// toplevel is a human-listed shared vault root (7c1d6dbf's `isSharedVaultRoot`), or the write is a reserved
// home's own. Archived projects' repos count as foreign; the project's own paths never do.
// Surfaces under test: REST (POST/PATCH), platform MCP, setup MCP, manager project_update (service).
// HERMETIC + CLAUDE-FREE; real git repos. Every refusal is paired with an acceptance control.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-vp-foreign-${Date.now()}-${process.pid}`);
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
const { checkVaultForeignRepoContainment } = await import("../dist/projects/vault-path.js");
const { foreignRepoContext } = await import("../dist/projects/foreign-repos.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const now = new Date().toISOString();
const cleanupDirs = [tmpHome];
const mkRepo = (tag) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `loom-vp-foreign-${tag}-`));
  cleanupDirs.push(repo);
  fs.writeFileSync(path.join(repo, "README.md"), `# ${tag}\n`);
  execSync("git init -q", { cwd: repo });
  commitAll(repo, "init", "-c user.email=r@loom -c user.name=r");
  return repo;
};
const mkDir = (tag) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `loom-vp-foreign-${tag}-`)); cleanupDirs.push(d); return d; };
const FOREIGN_RE = /another project's repo at/;

try {
  const db = new Db(path.join(tmpHome, "foreign.db"));
  const stub = {};
  const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, control: stub, usageStatus: stub });

  class SeamHost extends createSeamHost(PtyHost) { stop() {} }
  const events = { onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} };
  const svc = new SessionService(db, new SeamHost(events), new OrchestrationControl());
  const connect = async (router, name) => {
    const server = router.buildServer();
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name, version: "0" });
    await client.connect(clientT);
    return async (tool, args) => JSON.parse((await client.callTool({ name: tool, arguments: args })).content[0].text);
  };
  const plat = await connect(new PlatformMcpRouter(db, svc), "foreign-platform");
  const setup = await connect(new SetupMcpRouter(db, svc), "foreign-setup");

  // ---- surface adapters: each returns null on success, else the error string -------------------------
  const restCreate = async (name, body) => { const r = await app.inject({ method: "POST", url: "/api/projects", payload: { name, ...body } }); return r.statusCode === 201 ? null : (r.json().error ?? `HTTP ${r.statusCode}`); };
  const restUpdate = async (id, body) => { const r = await app.inject({ method: "PATCH", url: `/api/projects/${id}`, payload: body }); return r.statusCode === 200 ? null : (r.json().error ?? `HTTP ${r.statusCode}`); };
  const platCreate = async (name, body) => (await plat("project_create", { name, ...body })).error ?? null;
  const platUpdate = async (id, body) => (await plat("project_update", { projectId: id, ...body })).error ?? null;
  const setupCreate = async (name, body) => (await setup("project_create", { name, ...body })).error ?? null;
  const setupUpdate = async (id, body) => (await setup("project_update", { projectId: id, ...body })).error ?? null;
  const mgrUpdate = async (id, body) => { try { await svc.updateProjectStructural(`S-${id}`, id, body); return null; } catch (e) { return e instanceof Error ? e.message : String(e); } };

  // One update-subject project per surface (own code repo + own plain vault) + a manager session for it.
  const subjects = {};
  for (const s of ["rest", "plat", "setup", "mgr"]) {
    const repo = mkRepo(`subject-${s}`);
    const vault = path.join(tmpHome, `subject-${s}-vault`);
    const id = `pSubj-${s}`;
    db.insertProject({ id, name: `Subj-${s}`, repoPath: repo, vaultPath: vault, config: {}, createdAt: now, archivedAt: null, reserved: false, repos: [] });
    subjects[s] = { id, vault };
  }
  db.insertAgent({ id: "aMgr", projectId: subjects.mgr.id, name: "Mgr", startupPrompt: "", position: 0, profileId: null });
  db.insertSession({ id: `S-${subjects.mgr.id}`, projectId: subjects.mgr.id, agentId: "aMgr", engineSessionId: null, title: null, cwd: tmpHome, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager", parentSessionId: null });
  const updaters = { rest: restUpdate, plat: platUpdate, setup: setupUpdate, mgr: mgrUpdate };
  const creators = { rest: restCreate, plat: platCreate, setup: setupCreate };

  // ---- the foreign code repo F (owned by pForeign) and the shared notes vault S ----------------------
  const F = mkRepo("foreign-code");
  db.insertProject({ id: "pForeign", name: "ForeignCode", repoPath: F, vaultPath: path.join(tmpHome, "foreign-code-vault"), config: {}, createdAt: now, archivedAt: null, reserved: false, repos: [] });
  const S = mkRepo("shared-notes");
  // The owner's layout: SEVERAL projects bind the shared vault as their (vault-only) repo/vault.
  for (const n of ["V1", "V2"]) db.insertProject({ id: `p${n}`, name: `Shared${n}`, repoPath: S, vaultPath: S, config: {}, createdAt: now, archivedAt: null, reserved: false, repos: [], vaultOnly: true });

  // =====================================================================================================
  // (1) NEGATIVE CONTROLS — foreign code repo F: equals AND nested, CREATE and UPDATE, every surface.
  // =====================================================================================================
  for (const [s, create] of Object.entries(creators)) {
    for (const [label, vaultPath] of [["equals", F], ["nested", path.join(F, "docs")]]) {
      const err = await create(`Create-${s}-${label}`, { repoPath: mkRepo(`c-${s}-${label}`), vaultPath });
      check(`(1) ${s} CREATE code project, vaultPath ${label} another project's repo → refused`, typeof err === "string" && FOREIGN_RE.test(err));
    }
  }
  {
    const e1 = await restCreate("Create-rest-vo-equals", { vaultPath: F });
    check("(1) rest CREATE vault-only, vaultPath equals another project's repo → refused", typeof e1 === "string" && FOREIGN_RE.test(e1));
    const e2 = await setupCreate("Create-setup-vo-equals", { vaultPath: F });
    check("(1) setup CREATE vault-only, vaultPath equals another project's repo → refused", typeof e2 === "string" && FOREIGN_RE.test(e2));
    fs.mkdirSync(path.join(F, "docs"), { recursive: true }); // setup's vault-only branch requires an EXISTING dir
    const e3 = await setupCreate("Create-setup-vo-nested", { vaultPath: path.join(F, "docs") });
    check("(1) setup CREATE vault-only, vaultPath nested in another project's repo → refused as foreign", typeof e3 === "string" && FOREIGN_RE.test(e3));
    check("(1) the refusal names the Settings location, not the config key", /Settings → Platform → Shared vault roots/.test(e3 ?? "") && !/sharedVaultRoots/.test(e3 ?? ""));
  }
  for (const [s, update] of Object.entries(updaters)) {
    for (const [label, vaultPath] of [["equals", F], ["nested", path.join(F, "docs")]]) {
      const err = await update(subjects[s].id, { vaultPath });
      check(`(1) ${s} UPDATE vaultPath ${label} another project's repo → refused`, typeof err === "string" && FOREIGN_RE.test(err));
      check(`(1) ${s} refused ${label} UPDATE left vaultPath unchanged`, db.getProject(subjects[s].id).vaultPath === subjects[s].vault);
    }
  }
  // Relocation: a vault-only project moved (repoPath+vaultPath together) onto F.
  {
    const plain = mkDir("reloc-plain");
    db.insertProject({ id: "pReloc", name: "Reloc", repoPath: plain, vaultPath: plain, config: {}, createdAt: now, archivedAt: null, reserved: false, repos: [], vaultOnly: true });
    const r1 = await restUpdate("pReloc", { repoPath: F, vaultPath: F });
    check("(1) rest vault-only RELOCATION (repoPath+vaultPath together) onto another project's repo → refused", typeof r1 === "string" && FOREIGN_RE.test(r1));
    const r2 = await platUpdate("pReloc", { repoPath: F, vaultPath: F });
    check("(1) platform vault-only RELOCATION onto another project's repo → refused", typeof r2 === "string" && FOREIGN_RE.test(r2));
    check("(1) refused relocations left the project where it was", db.getProject("pReloc").repoPath === plain && db.getProject("pReloc").vaultPath === plain);
  }
  // POSITIVE CONTROL: a path clear of every foreign repo is accepted on every surface (the refusals above
  // are the foreign check, not a blanket failure of the fixture).
  for (const [s, update] of Object.entries(updaters)) {
    const target = path.join(tmpHome, `clear-${s}-vault`);
    check(`(1) (positive control) ${s} UPDATE to a clear path → accepted`, (await update(subjects[s].id, { vaultPath: target })) === null && db.getProject(subjects[s].id).vaultPath === target);
  }
  for (const [s, create] of Object.entries(creators)) {
    check(`(1) (positive control) ${s} CREATE with a clear vaultPath → accepted`, (await create(`Clear-${s}`, { repoPath: mkRepo(`clear-${s}`), vaultPath: path.join(tmpHome, `clear-create-${s}-vault`) })) === null);
  }

  // =====================================================================================================
  // (2) The owner's layout WITHOUT the listing is refused; WITH the listing it stays valid.
  // =====================================================================================================
  const nestedS = (tag) => path.join(S, "Projects", tag);
  for (const [s, update] of Object.entries(updaters)) {
    const err = await update(subjects[s].id, { vaultPath: nestedS(`un-${s}`) });
    check(`(2) UNLISTED shared root: ${s} UPDATE vault nested under it (bound as repo by 2 projects) → refused`, typeof err === "string" && FOREIGN_RE.test(err));
  }
  for (const [s, create] of Object.entries(creators)) {
    const err = await create(`UnlistedCreate-${s}`, { repoPath: mkRepo(`ul-${s}`), vaultPath: nestedS(`ulc-${s}`) });
    check(`(2) UNLISTED shared root: ${s} CREATE vault nested under it → refused`, typeof err === "string" && FOREIGN_RE.test(err));
  }
  check("(2) UNLISTED shared root: rest CREATE vault-only equal to it → refused", FOREIGN_RE.test((await restCreate("UnlistedVO", { vaultPath: S })) ?? ""));

  // RENAME on the owner's layout while the list is EMPTY: the web Save always resends vaultPath, so an
  // UNCHANGED nested vaultPath must pass; a CHANGED one (different nested path) is still refused.
  for (const [s, update] of Object.entries({ rest: restUpdate, plat: platUpdate, setup: setupUpdate, mgr: mgrUpdate })) {
    const id = `pRename-${s}`;
    const nestedVault = nestedS(`rename-${s}`);
    db.insertProject({ id, name: `Rename-${s}`, repoPath: mkRepo(`rename-${s}`), vaultPath: nestedVault, config: {}, createdAt: now, archivedAt: null, reserved: false, repos: [] });
    if (s === "mgr") {
      db.insertAgent({ id: "aMgrR", projectId: id, name: "Mgr", startupPrompt: "", position: 0, profileId: null });
      db.insertSession({ id: `S-${id}`, projectId: id, agentId: "aMgrR", engineSessionId: null, title: null, cwd: tmpHome, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager", parentSessionId: null });
    }
    check(`(2) EMPTY list: ${s} rename-only write resending the UNCHANGED nested vaultPath → accepted`, (await update(id, { name: `Renamed-${s}`, vaultPath: nestedVault })) === null && db.getProject(id).name === `Renamed-${s}`);
    const changed = await update(id, { name: `Renamed2-${s}`, vaultPath: nestedS(`rename-changed-${s}`) });
    check(`(2) EMPTY list: ${s} a CHANGED nested vaultPath is still refused`, typeof changed === "string" && FOREIGN_RE.test(changed));
  }

  db.setPlatformConfig({ sharedVaultRoots: [S] }); // human-listed (what the REST PATCH /api/platform/config does)
  for (const [s, update] of Object.entries(updaters)) {
    const target = nestedS(`l-${s}`);
    check(`(2) LISTED shared root: ${s} UPDATE vault nested under it → accepted`, (await update(subjects[s].id, { vaultPath: target })) === null && db.getProject(subjects[s].id).vaultPath === target);
  }
  for (const [s, create] of Object.entries(creators)) {
    check(`(2) LISTED shared root: ${s} CREATE vault nested under it → accepted`, (await create(`ListedCreate-${s}`, { repoPath: mkRepo(`l-${s}`), vaultPath: nestedS(`lc-${s}`) })) === null);
  }
  check("(2) LISTED shared root: rest CREATE vault-only equal to it (a 3rd project binding it) → accepted", (await restCreate("ListedVO-rest", { vaultPath: S })) === null);
  check("(2) LISTED shared root: setup CREATE vault-only equal to it → accepted", (await setupCreate("ListedVO-setup", { vaultPath: S })) === null);
  // The listing vouches for S only — F (another project's code repo) is STILL refused with S listed.
  check("(2) NEGATIVE CONTROL: with S listed, an unlisted code repo F is STILL refused", FOREIGN_RE.test((await restUpdate(subjects.rest.id, { vaultPath: F })) ?? ""));

  // =====================================================================================================
  // (3) Archived projects' repo paths count as foreign.
  // =====================================================================================================
  {
    const A = mkRepo("archived-code");
    db.insertProject({ id: "pArch", name: "ArchivedCode", repoPath: A, vaultPath: path.join(tmpHome, "arch-vault"), config: {}, createdAt: now, archivedAt: now, reserved: false, repos: [] });
    check("(3) a vaultPath equal to an ARCHIVED project's repo → refused", FOREIGN_RE.test((await restUpdate(subjects.rest.id, { vaultPath: A })) ?? ""));
    check("(3) a vaultPath nested in an ARCHIVED project's repo → refused", FOREIGN_RE.test((await platUpdate(subjects.plat.id, { vaultPath: path.join(A, "n") })) ?? ""));
  }

  // =====================================================================================================
  // (4) A reserved home's own repo is not foreign territory (no write-side reserved exemption exists: no
  //     real path needed one — a reserved home's vault is its own dir, never another project's repo).
  // =====================================================================================================
  {
    const homeRepo = mkDir("reserved-home");
    db.insertProject({ id: "pReserved", name: "ReservedHome", repoPath: homeRepo, vaultPath: path.join(homeRepo, "vault"), config: {}, createdAt: now, archivedAt: null, reserved: true, repos: [] });
    check("(4) a RESERVED home's repo is absent from the foreign path list", !foreignRepoContext(db, undefined).paths.includes(homeRepo));
    check("(4) (control) an ordinary project's repo IS in the foreign path list", foreignRepoContext(db, undefined).paths.includes(F));
    check("(4) a vaultPath nested in a RESERVED home's repo is not refused for an ordinary project", (await restUpdate(subjects.rest.id, { vaultPath: path.join(homeRepo, "ordinary-vault") })) === null);
  }

  // =====================================================================================================
  // (7) The exemption is the listed git TOPLEVEL containing the foreign repo — never the raw repoPath.
  // =====================================================================================================
  {
    const canon = (p) => fs.realpathSync.native(p).toLowerCase();
    const { gitToplevel } = await import("../dist/git/reader.js");
    // (7a) a listed SUBFOLDER of a code repo never exempts it (versioner's isRecognizedVaultRoot refuses it too).
    const T = mkRepo("listed-subfolder-code");
    const tNotes = path.join(T, "notes"); fs.mkdirSync(tNotes);
    db.insertProject({ id: "pT", name: "SubfolderOwner", repoPath: tNotes, vaultPath: path.join(tmpHome, "pT-vault"), config: {}, createdAt: now, archivedAt: null, reserved: false, repos: [] });
    db.setPlatformConfig({ sharedVaultRoots: [S, tNotes] });
    const sub = await restUpdate(subjects.rest.id, { vaultPath: path.join(tNotes, "x") });
    check("(7a) a LISTED SUBFOLDER used as a foreign repoPath does NOT exempt: vault nested in it → refused", typeof sub === "string" && FOREIGN_RE.test(sub));
    check("(7a) the message names the foreign repo's git toplevel", (sub ?? "").toLowerCase().replace(/\\/g, "/").includes(canon(T).replace(/\\/g, "/")));
    // (7b) a foreign repoPath nested UNDER a listed root whose toplevel is that listed root → accepted.
    const sRepoSub = path.join(S, "ProjectsRepo"); fs.mkdirSync(sRepoSub, { recursive: true });
    db.insertProject({ id: "pSNested", name: "NestedUnderListed", repoPath: sRepoSub, vaultPath: path.join(tmpHome, "pSN-vault"), config: {}, createdAt: now, archivedAt: null, reserved: false, repos: [] });
    check("(7b) a foreign repoPath nested under a LISTED toplevel → a vault nested in it is accepted", (await restUpdate(subjects.rest.id, { vaultPath: path.join(sRepoSub, "deep", "vault") })) === null);
    // (7c) core.worktree laundering: F2 reports the LISTED S as its toplevel, but S is not an ancestor of F2.
    const F2 = mkRepo("launder-code");
    execSync(`git config core.worktree "${S.replace(/\\/g, "/")}"`, { cwd: F2 });
    const reported = await gitToplevel(F2);
    check("(7c) (control) the planted core.worktree really makes F2 report S as its toplevel", reported !== null && canon(reported) === canon(S));
    db.insertProject({ id: "pF2", name: "Launder", repoPath: F2, vaultPath: path.join(tmpHome, "pF2-vault"), config: {}, createdAt: now, archivedAt: null, reserved: false, repos: [] });
    const laundered = await restUpdate(subjects.rest.id, { vaultPath: path.join(F2, "docs") });
    check("(7c) a foreign repo whose reported toplevel is a listed root it does NOT sit under → refused", typeof laundered === "string" && FOREIGN_RE.test(laundered));
    db.setPlatformConfig({ sharedVaultRoots: [S] });
  }

  // =====================================================================================================
  // (5) Self-exclusion: a project's OWN repo path is never foreign.
  // =====================================================================================================
  {
    const own = mkRepo("self-own");
    db.insertProject({ id: "pSelf", name: "SelfExcl", repoPath: own, vaultPath: own, config: {}, createdAt: now, archivedAt: null, reserved: false, repos: [], vaultOnly: true });
    check("(5) foreign context excludes the project's own repo path", !foreignRepoContext(db, "pSelf").paths.includes(own));
    check("(5) (control) the SAME context WITHOUT the exclusion would refuse the project's own vault", (await checkVaultForeignRepoContainment(own, foreignRepoContext(db, undefined))).ok === false);
    check("(5) rest PATCH re-asserting a vault-only project's own vaultPath → accepted", (await restUpdate("pSelf", { vaultPath: own })) === null);
    check("(5) platform project_update re-asserting its own vaultPath → accepted", (await platUpdate("pSelf", { vaultPath: own })) === null);
    check("(5) setup project_update re-asserting its own vaultPath → accepted", (await setupUpdate("pSelf", { vaultPath: own })) === null);
  }

  // =====================================================================================================
  // (6) Source scan: every call to the shared triple check passes `foreign:` (no surface can forget it).
  // =====================================================================================================
  {
    const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith(".ts") ? [path.join(d, e.name)] : []));
    const calls = [];
    for (const f of walk(srcDir)) {
      const s = fs.readFileSync(f, "utf8");
      const rel = path.relative(srcDir, f).replace(/\\/g, "/");
      if (rel === "projects/vault-path.ts") continue; // the definition
      let i = -1;
      while ((i = s.indexOf("checkVaultRepoTripleContainment(", i + 1)) !== -1) {
        // the call's argument text: balance parens
        let depth = 0, j = i + "checkVaultRepoTripleContainment".length;
        for (; j < s.length; j++) { if (s[j] === "(") depth++; else if (s[j] === ")" && --depth === 0) break; }
        calls.push({ rel, args: s.slice(i, j) });
      }
    }
    check(`(6) the scan found the 8 surface calls (saw ${calls.length}: ${calls.map((c) => c.rel).join(", ")})`, calls.length === 8);
    const passesBuilder = (args) => /foreign:\s*foreignRepoContext\(/.test(args);
    check("(6) every call passes `foreign: foreignRepoContext(...)` (the context-builder call, never `undefined`)", calls.every((c) => passesBuilder(c.args)));
    // Positive controls for the scan predicate: absent, `undefined`, and a bare identifier all fail; the real shape passes.
    check("(6) (positive control) the predicate rejects no-foreign / `foreign: undefined` / a bare identifier, accepts the builder call",
      !passesBuilder("checkVaultRepoTripleContainment({a:1}, {pairingIsIntentional:true})")
      && !passesBuilder("checkVaultRepoTripleContainment({a:1}, {foreign: undefined})")
      && !passesBuilder("checkVaultRepoTripleContainment({a:1}, {foreign: ctx})")
      && passesBuilder("checkVaultRepoTripleContainment({a:1}, {foreign: foreignRepoContext(db, id)})"));
  }

  db.close();
} finally {
  for (const d of cleanupDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
