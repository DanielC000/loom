import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 4b2ef44d — the symmetric half of c24dfd28: a project's repoPath or repos[] entry may not EQUAL or
// CONTAIN another project's existing vaultPath (that project's vault auto-committer would be governed by
// this repo), unless the written repo's git toplevel is a human-listed shared vault root and the repo is
// at-or-under it (same exemption as c24dfd28). A repo path canonically unchanged from what the project
// already stores is never re-judged. Surfaces: REST POST/PATCH (repoPath + repos[]), platform MCP
// project_create/project_update, setup MCP project_create. HERMETIC + CLAUDE-FREE; real git repos.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-rp-fv-${Date.now()}-${process.pid}`);
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

const now = new Date().toISOString();
const cleanupDirs = [tmpHome];
const mkRepo = (tag) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `loom-rp-fv-${tag}-`));
  cleanupDirs.push(repo);
  fs.writeFileSync(path.join(repo, "README.md"), `# ${tag}\n`);
  execSync("git init -q", { cwd: repo });
  commitAll(repo, "init", "-c user.email=r@loom -c user.name=r");
  return repo;
};
const FV_RE = /would contain another project's vault|equals another project's vault/;
const CONTAIN_RE = /would contain another project's vault/;
const EQUAL_RE = /equals another project's vault/;

try {
  const db = new Db(path.join(tmpHome, "rpfv.db"));
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
  const plat = await connect(new PlatformMcpRouter(db, svc), "rpfv-platform");
  const setup = await connect(new SetupMcpRouter(db, svc), "rpfv-setup");

  // Surface adapters: null on success, else the error string.
  const restCreate = async (name, body) => { const r = await app.inject({ method: "POST", url: "/api/projects", payload: { name, ...body } }); return r.statusCode === 201 ? null : (r.json().error ?? `HTTP ${r.statusCode}`); };
  const restUpdate = async (id, body) => { const r = await app.inject({ method: "PATCH", url: `/api/projects/${id}`, payload: body }); return r.statusCode === 200 ? null : (r.json().error ?? `HTTP ${r.statusCode}`); };
  const platCreate = async (name, body) => (await plat("project_create", { name, ...body })).error ?? null;
  const platUpdate = async (id, body) => (await plat("project_update", { projectId: id, ...body })).error ?? null;
  const setupCreate = async (name, body) => (await setup("project_create", { name, ...body })).error ?? null;

  const insert = (id, repoPath, vaultPath, extra = {}) =>
    db.insertProject({ id, name: id, repoPath, vaultPath, config: {}, createdAt: now, archivedAt: null, reserved: false, repos: [], ...extra });

  // The owner's layout, one root per surface/case so no two projects share a commondir pin: a git root R
  // whose subfolders are OTHER projects' vaults (a plain notes folder, as in the Obsidian vault).
  const layout = (tag) => {
    const R = mkRepo(`root-${tag}`);
    const vault = path.join(R, "Projects", `v-${tag}`);
    fs.mkdirSync(vault, { recursive: true });
    insert(`pVault-${tag}`, mkRepo(`code-${tag}`), vault);
    return { R, vault };
  };
  // One update-subject project per surface (own code repo + own vault outside every layout).
  const subjects = {};
  for (const s of ["rest", "plat"]) {
    const id = `pSubj-${s}`;
    insert(id, mkRepo(`subject-${s}`), path.join(tmpHome, `subject-${s}-vault`));
    subjects[s] = id;
  }

  // =====================================================================================================
  // (1) CONTAINS — a repo written at a directory that CONTAINS another project's vault, UNLISTED.
  // =====================================================================================================
  const L = {};
  for (const k of ["restCreate", "platCreate", "setupCreate", "restReposCreate", "restUpdate", "platUpdate", "restRepos", "rename", "subfolder"]) L[k] = layout(k);
  {
    const e1 = await restCreate("C-rest", { repoPath: L.restCreate.R });
    check("(1) rest CREATE repoPath containing another project's vault → refused", typeof e1 === "string" && CONTAIN_RE.test(e1));
    check("(1) the refusal names Settings → Platform → Shared vault roots", /Settings → Platform → Shared vault roots/.test(e1 ?? ""));
    check("(1) platform CREATE repoPath containing another project's vault → refused", CONTAIN_RE.test((await platCreate("C-plat", { repoPath: L.platCreate.R })) ?? ""));
    check("(1) setup CREATE repoPath containing another project's vault → refused", CONTAIN_RE.test((await setupCreate("C-setup", { repoPath: L.setupCreate.R })) ?? ""));
    const e4 = await restCreate("C-rest-repos", { repoPath: mkRepo("own-repos-create"), repos: [{ key: "extra", path: L.restReposCreate.R }] });
    check("(1) rest CREATE repos[] entry containing another project's vault → refused", typeof e4 === "string" && CONTAIN_RE.test(e4));
    const e5 = await restUpdate(subjects.rest, { repoPath: L.restUpdate.R });
    check("(1) rest PATCH repoPath rebind onto a dir containing another project's vault → refused", typeof e5 === "string" && CONTAIN_RE.test(e5));
    check("(1) refused PATCH left repoPath unchanged", db.getProject(subjects.rest).repoPath !== L.restUpdate.R);
    check("(1) platform project_update repoPath rebind onto such a dir → refused", CONTAIN_RE.test((await platUpdate(subjects.plat, { repoPath: L.platUpdate.R })) ?? ""));
    const e7 = await restUpdate(subjects.rest, { repos: [{ key: "extra", path: L.restRepos.R }] });
    check("(1) rest PATCH repos[] edit adding such an entry → refused", typeof e7 === "string" && CONTAIN_RE.test(e7));
    check("(1) refused repos[] edit left the registry unchanged", db.getProject(subjects.rest).repos.length === 0);
  }

  // =====================================================================================================
  // (2) EQUALS — a repo written AT another project's vault dir.
  // =====================================================================================================
  {
    const V = mkRepo("eq-vault"); // another project's vault that is itself a git repo
    insert("pEqVault", mkRepo("eq-code"), V);
    check("(2) rest CREATE repoPath EQUAL to another project's vault → refused", EQUAL_RE.test((await restCreate("E-rest", { repoPath: V })) ?? ""));
    check("(2) platform CREATE repoPath equal to another project's vault → refused", EQUAL_RE.test((await platCreate("E-plat", { repoPath: V })) ?? ""));
    check("(2) rest PATCH repoPath rebind equal to another project's vault → refused", EQUAL_RE.test((await restUpdate(subjects.rest, { repoPath: V })) ?? ""));
    check("(2) rest PATCH repos[] entry equal to another project's vault → refused", EQUAL_RE.test((await restUpdate(subjects.rest, { repos: [{ key: "x", path: V }] })) ?? ""));
    // An ARCHIVED project's vault counts as foreign too.
    const AV = mkRepo("eq-arch-vault");
    insert("pArchV", mkRepo("eq-arch-code"), AV, { archivedAt: now });
    check("(2) an ARCHIVED project's vault counts: repo equal to it → refused", EQUAL_RE.test((await restCreate("E-arch", { repoPath: AV })) ?? ""));
  }

  // =====================================================================================================
  // (3) Controls: a clear path is accepted on every surface (the refusals above are THIS check).
  // =====================================================================================================
  {
    check("(3) (positive control) rest CREATE with a clear repoPath → accepted", (await restCreate("Clear-rest", { repoPath: mkRepo("clear-rest") })) === null);
    check("(3) (positive control) platform CREATE with a clear repoPath → accepted", (await platCreate("Clear-plat", { repoPath: mkRepo("clear-plat") })) === null);
    check("(3) (positive control) setup CREATE with a clear repoPath → accepted", (await setupCreate("Clear-setup", { repoPath: mkRepo("clear-setup") })) === null);
    const target = mkRepo("clear-rebind");
    check("(3) (positive control) rest PATCH repoPath rebind to a clear repo → accepted", (await restUpdate(subjects.rest, { repoPath: target })) === null && db.getProject(subjects.rest).repoPath !== undefined);
    check("(3) (positive control) rest PATCH repos[] with a clear entry → accepted", (await restUpdate(subjects.rest, { repos: [{ key: "ok", path: mkRepo("clear-entry") }] })) === null);
    await restUpdate(subjects.rest, { repos: [] });
  }

  // =====================================================================================================
  // (4) UNCHANGED stored repo is never re-judged — rename resave on the owner's unlisted layout.
  // =====================================================================================================
  {
    const R = L.rename.R;
    const own = "pOwner-rename";
    insert(own, R, path.join(tmpHome, "owner-rename-vault"));
    check("(4) UNLISTED: rest rename resending the UNCHANGED repoPath (which contains another vault) → accepted", (await restUpdate(own, { name: "Renamed", repoPath: R })) === null && db.getProject(own).name === "Renamed");
    check("(4) UNLISTED: rest PATCH of only the name → accepted", (await restUpdate(own, { name: "Renamed2" })) === null);
    const own2 = "pOwner-reg";
    const regRepo = mkRepo("owner-reg-primary");
    insert(own2, regRepo, path.join(tmpHome, "owner-reg-vault"), { repos: [{ key: "notes", path: L.restRepos.R }] });
    check("(4) UNLISTED: rest PATCH echoing an UNCHANGED repos[] entry that contains another vault → accepted", (await restUpdate(own2, { name: "Renamed3", repos: [{ key: "notes", path: L.restRepos.R }] })) === null);
    // A CHANGED repoPath of the same project is still judged.
    check("(4) a CHANGED repoPath onto another containing dir is still refused", CONTAIN_RE.test((await restUpdate(own, { repoPath: L.restUpdate.R })) ?? ""));
  }

  // =====================================================================================================
  // (5) LISTING: the exemption is the written repo's git TOPLEVEL being a listed root and at-or-under it.
  // =====================================================================================================
  {
    // A listed SUBFOLDER of the root never vouches for the root.
    db.setPlatformConfig({ sharedVaultRoots: [path.join(L.restCreate.R, "Projects")] });
    check("(5) a listed SUBFOLDER of the root does NOT exempt the root: rest CREATE → still refused", CONTAIN_RE.test((await restCreate("Sub-rest", { repoPath: L.restCreate.R })) ?? ""));
    db.setPlatformConfig({ sharedVaultRoots: [L.restCreate.R, L.platCreate.R, L.setupCreate.R, L.restReposCreate.R, L.restUpdate.R, L.platUpdate.R, L.restRepos.R, L.subfolder.R] });
    check("(5) LISTED root: rest CREATE repoPath = the root → accepted", (await restCreate("L-rest", { repoPath: L.restCreate.R })) === null);
    check("(5) LISTED root: platform CREATE → accepted", (await platCreate("L-plat", { repoPath: L.platCreate.R })) === null);
    check("(5) LISTED root: setup CREATE → accepted", (await setupCreate("L-setup", { repoPath: L.setupCreate.R })) === null);
    check("(5) LISTED root: rest CREATE repos[] entry = the root → accepted", (await restCreate("L-rest-repos", { repoPath: mkRepo("own-repos-listed"), repos: [{ key: "extra", path: L.restReposCreate.R }] })) === null);
    check("(5) LISTED root: rest PATCH repoPath rebind → accepted", (await restUpdate(subjects.rest, { repoPath: L.restUpdate.R })) === null && db.getProject(subjects.rest).repoPath !== undefined);
    check("(5) LISTED root: platform project_update repoPath rebind → accepted", (await platUpdate(subjects.plat, { repoPath: L.platUpdate.R })) === null);
    check("(5) LISTED root: rest PATCH repos[] edit → accepted", (await restUpdate(subjects.plat, { repos: [{ key: "extra", path: L.restRepos.R }] })) === null);
    // The listing vouches for the listed roots only — an UNLISTED containing repo is still refused.
    const U = layout("unlisted-after");
    check("(5) NEGATIVE CONTROL: with other roots listed, an unlisted containing repo is STILL refused", CONTAIN_RE.test((await restCreate("U-rest", { repoPath: U.R })) ?? ""));
    // The repos-registry + unchanged resave still passes with the root listed.
    check("(5) LISTED: rename resave still accepted", (await restUpdate("pOwner-rename", { name: "Renamed4", repoPath: L.rename.R })) === null);
    // core.worktree laundering (mirrors c24dfd28's 7c, repo side): the WRITTEN repo W reports the LISTED root
    // as its toplevel but does not sit under it → NOT exempt.
    {
      const canon = (p) => fs.realpathSync.native(p).toLowerCase();
      const { gitToplevel } = await import("../dist/git/reader.js");
      const W = mkRepo("launder-written");
      const wVault = path.join(W, "Projects", "v-launder");
      fs.mkdirSync(wVault, { recursive: true });
      insert("pVault-launder", mkRepo("code-launder"), wVault);
      db.setPlatformConfig({ sharedVaultRoots: [L.subfolder.R] });
      // CONTROL: before planting, W's real toplevel is W (unlisted) → refused for the plain reason.
      check("(5) (control) unlaundered W containing a vault, root not W → refused", CONTAIN_RE.test((await restCreate("Laun-0", { repoPath: W })) ?? ""));
      execSync(`git config core.worktree "${L.subfolder.R.replace(/\\/g, "/")}"`, { cwd: W });
      const reported = await gitToplevel(W);
      check("(5) (control) the planted core.worktree makes W report the LISTED root as its toplevel", reported !== null && canon(reported) === canon(L.subfolder.R));
      // REST create refuses the planted repo earlier still (isGitRepo), so drive the shared check directly.
      const { checkRepoForeignVaultContainment } = await import("../dist/projects/vault-path.js");
      const { foreignRepoContext } = await import("../dist/projects/foreign-repos.js");
      const laun = await checkRepoForeignVaultContainment([W], foreignRepoContext(db, undefined));
      check("(5) a written repo reporting a listed root it does NOT sit under → still refused", laun.ok === false && CONTAIN_RE.test(laun.error));
      // CONTROL for the control: a W whose real toplevel IS the listed root (W nested in it) passes.
      const Wn = path.join(L.subfolder.R, "Projects", "nested-in-listed");
      fs.mkdirSync(path.join(Wn, "v"), { recursive: true });
      insert("pVault-nestedlisted", mkRepo("code-nl"), path.join(Wn, "v"));
      check("(5) (control) a repo path nested under the listed toplevel containing a vault → exempt", (await checkRepoForeignVaultContainment([Wn], foreignRepoContext(db, undefined))).ok === true);
    }
    db.setPlatformConfig({ sharedVaultRoots: [] });
  }

  // =====================================================================================================
  // (7) An unsafe-to-canonicalize OWN repo form (UNC admin-share alias) is REFUSED, never skipped — notably in
  //     the no-vault branch, where no earlier check canonicalises repoPath/repos[]. Driven directly with the
  //     alias string (a real UNC path can't be built hermetically; the unsafe-form test is textual, so this
  //     is platform-independent).
  // =====================================================================================================
  {
    const { checkRepoForeignVaultContainment, checkVaultRepoTripleContainment } = await import("../dist/projects/vault-path.js");
    const unc = "\\\\localhost\\C$\\some\\root";
    const ctx = { paths: [], vaultPaths: [path.join(tmpHome, "any-foreign-vault")], sharedVaultRoots: [] };
    const direct = await checkRepoForeignVaultContainment([unc], ctx);
    check("(7) UNC alias repo path with foreign vaults present → refused (not skipped)", direct.ok === false && /network\/device form/.test(direct.error));
    const noVault = await checkVaultRepoTripleContainment({ repoPath: unc, vaultPath: "", repos: [] }, { foreign: ctx });
    check("(7) no-vault triple with a UNC alias repoPath → refused", noVault.ok === false);
    const regs = await checkVaultRepoTripleContainment({ repoPath: mkRepo("unc-ok"), vaultPath: "", repos: [{ key: "u", path: unc }] }, { foreign: ctx });
    check("(7) no-vault triple with a UNC alias repos[] entry → refused", regs.ok === false);
    check("(7) (control) a safe repo path under the same context passes", (await checkVaultRepoTripleContainment({ repoPath: mkRepo("unc-safe"), vaultPath: "", repos: [] }, { foreign: ctx })).ok === true);
    check("(7) (control) with NO foreign vaults the early return still accepts the alias form", (await checkRepoForeignVaultContainment([unc], { ...ctx, vaultPaths: [] })).ok === true);
  }

  // =====================================================================================================
  // (6) Source scan: the symmetric check lives in the ONE shared triple check — no per-surface copy.
  // =====================================================================================================
  {
    const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
    const vp = fs.readFileSync(path.join(here, "..", "src", "projects", "vault-path.ts"), "utf8");
    check("(6) checkVaultRepoTripleContainment runs checkRepoForeignVaultContainment (positive control: the call exists)", /checkRepoForeignVaultContainment\(\[triple\.repoPath/.test(vp));
    check("(6) the check is not re-implemented at the surfaces", ["gateway/server.ts", "mcp/platform.ts", "mcp/setup.ts", "projects/create-input.ts"].every((f) => !fs.readFileSync(path.join(here, "..", "src", f), "utf8").includes("checkRepoForeignVaultContainment")));
  }

  db.close();
} finally {
  for (const d of cleanupDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
