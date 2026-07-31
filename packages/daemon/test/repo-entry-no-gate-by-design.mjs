import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Per-entry no-gate-by-design test for RepoRegistryEntry.noGateByDesign (card 22629cb2, the multi-repo
// follow-up to Project.noGateByDesign / card 58b0bb60). REAL git on temp repos, NO claude and NO live
// daemon — drives SessionService.confirmWorkerMerge() directly (mirrors no-gate-by-design-merge-warning.mjs)
// for PART A, and the in-process MCP routers (mirrors no-gate-by-design-rest.mjs Part B) for PART B.
//
// THE PROBLEM: a registry entry with no gateCommand warned on EVERY merge into it, with no per-entry way
// to declare that repo intentionally gateless — only the whole PROJECT could opt out (card 58b0bb60), which
// also silences every OTHER repo's genuinely-missing-gate signal. THE FIX: RepoRegistryEntry.noGateByDesign,
// resolved onto ResolvedRepo.noGateByDesign (always false for primary), OR'd into confirmWorkerMerge's
// gateWarning condition alongside `gate` and `project.noGateByDesign`.
//
// Proves the DoD:
//   PART A (merge behavior):
//     (1) a FLAGGED registry entry with no gateCommand merges CLEAN — no warning for ITS OWN merges.
//     (2) an UNFLAGGED SIBLING entry on the SAME project still warns (the flag is per-entry, not global).
//     (3) the PRIMARY repo's warning is UNAFFECTED by any entry's flag — an entry flagged true does not
//         suppress a primary-repo merge's warning, and an unflagged primary still warns normally.
//     (4) the project-level Project.noGateByDesign flag's behavior is UNCHANGED: when true, it still
//         suppresses warnings project-wide (primary AND every registry entry), regardless of any entry's
//         own (false) flag — proving the two flags compose with OR, project-level short-circuiting first.
//   PART B (trust boundary): a smuggled per-entry noGateByDesign inside a `repos` array is hard-rejected
//     on both loom-setup and the elevated loom-platform surfaces — `repos` itself is never agent-settable,
//     so nesting the new field inside it buys an agent nothing, and this proves it explicitly rather than
//     relying on that inference.
// Run: 1) build daemon (pnpm build), 2) node test/repo-entry-no-gate-by-design.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-rengbd-home-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=rengbd@loom -c user.name=rengbd";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

const mkRepo = (dir) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), "# rengbd\n");
  execSync(`git init -q && git config user.email rengbd@loom && git config user.name rengbd && git add . && git ${GIT_ID} commit -q -m init`, { cwd: dir });
};

// =====================================================================================================
// PART A — merge-confirm behavior against a project with a registry: one flagged entry, one unflagged
// sibling entry, and the primary repo — all cut worktrees from the SAME project so the project-level
// flag's project-wide reach can be tested against every target in one place.
// =====================================================================================================
async function partA() {
  const db = new Db();
  const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl());

  const primaryRepo = path.join(os.tmpdir(), `loom-rengbd-primary-${sfx}`);
  const flaggedRepo = path.join(os.tmpdir(), `loom-rengbd-flagged-${sfx}`);
  const siblingRepo = path.join(os.tmpdir(), `loom-rengbd-sibling-${sfx}`);
  mkRepo(primaryRepo); mkRepo(flaggedRepo); mkRepo(siblingRepo);

  const projId = `rengbd-proj-${sfx}`;
  const agentId = `rengbd-agent-${sfx}`;
  db.insertProject({
    id: projId, name: "RENGBD", repoPath: primaryRepo, vaultPath: primaryRepo,
    config: {}, createdAt: now, archivedAt: null, reserved: false, referenceRepos: [],
    noGateByDesign: false, denyGlobs: [],
    repos: [
      { key: "flagged", path: flaggedRepo, noGateByDesign: true },
      { key: "sibling", path: siblingRepo, noGateByDesign: false },
    ],
  });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });

  const cleanup = [];
  async function commitAndConfirm(label, repoKey, repoPath, file) {
    const taskId = `rengbd-task-${label}-${sfx}`;
    const mgrId = `rengbd-mgr-${label}-${sfx}`;
    const workerId = `rengbd-wkr-${label}-${sfx}`;
    const { worktreePath, branch } = await createWorktree(repoPath, projId, taskId, {}, repoKey ?? "primary");
    fs.writeFileSync(path.join(worktreePath, file), "work\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "${file}"`, { cwd: worktreePath });
    db.insertTask({ id: taskId, projectId: projId, title: `RENGBD-${label}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now, repoKey: repoKey ?? null });
    db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: primaryRepo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    db.insertSession({ id: workerId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch, repoKey: repoKey ?? null });
    cleanup.push(worktreePath);
    return sessions.confirmWorkerMerge(mgrId, workerId);
  }

  try {
    // (1) FLAGGED entry, no gateCommand → merges clean, NO warning.
    {
      const r = await commitAndConfirm("flag", "flagged", flaggedRepo, "feat-flag.txt");
      check("(1) merged:true", r.merged === true);
      check("(1) NO warning — the per-entry flag suppressed its OWN merge's noise", r.warning === undefined);
    }

    // (2) SIBLING entry (unflagged), no gateCommand → STILL warns — the flag is per-entry, not global.
    {
      const r = await commitAndConfirm("sib", "sibling", siblingRepo, "feat-sib.txt");
      check("(2) merged:true", r.merged === true);
      check("(2) warning IS present — an unflagged sibling entry stays surfaced", typeof r.warning === "string");
      check("(2) warning names the sibling repo", /repo "sibling"/.test(r.warning ?? ""));
    }

    // (3) PRIMARY repo, no project-level flag → still warns, UNAFFECTED by the "flagged" entry's flag.
    {
      const r = await commitAndConfirm("prim", null, primaryRepo, "feat-prim.txt");
      check("(3) merged:true", r.merged === true);
      check("(3) warning IS present — the primary is ungoverned by any registry entry's flag", typeof r.warning === "string");
      check("(3) warning names \"this project\", not a registry entry", /unverified: no gateCommand is configured for this project/.test(r.warning ?? ""));
    }
  } finally {
    db.close();
    for (const d of [primaryRepo, flaggedRepo, siblingRepo, ...cleanup]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
}

// =====================================================================================================
// PART A2 — project-level Project.noGateByDesign's reach is UNCHANGED: true still suppresses project-WIDE
// (primary AND every registry entry), regardless of any entry's own (false) flag. Separate project from
// partA so this project's OWN project-level flag doesn't interact with partA's per-entry assertions.
// =====================================================================================================
async function partA2() {
  const db = new Db();
  const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl());

  const primaryRepo = path.join(os.tmpdir(), `loom-rengbd2-primary-${sfx}`);
  const entryRepo = path.join(os.tmpdir(), `loom-rengbd2-entry-${sfx}`);
  mkRepo(primaryRepo); mkRepo(entryRepo);

  const projId = `rengbd2-proj-${sfx}`;
  const agentId = `rengbd2-agent-${sfx}`;
  db.insertProject({
    id: projId, name: "RENGBD2", repoPath: primaryRepo, vaultPath: primaryRepo,
    config: {}, createdAt: now, archivedAt: null, reserved: false, referenceRepos: [],
    noGateByDesign: true, denyGlobs: [],
    repos: [{ key: "entry", path: entryRepo, noGateByDesign: false }],
  });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });

  const cleanup = [];
  async function commitAndConfirm(label, repoKey, repoPath, file) {
    const taskId = `rengbd2-task-${label}-${sfx}`;
    const mgrId = `rengbd2-mgr-${label}-${sfx}`;
    const workerId = `rengbd2-wkr-${label}-${sfx}`;
    const { worktreePath, branch } = await createWorktree(repoPath, projId, taskId, {}, repoKey ?? "primary");
    fs.writeFileSync(path.join(worktreePath, file), "work\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "${file}"`, { cwd: worktreePath });
    db.insertTask({ id: taskId, projectId: projId, title: `RENGBD2-${label}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now, repoKey: repoKey ?? null });
    db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: primaryRepo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    db.insertSession({ id: workerId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch, repoKey: repoKey ?? null });
    cleanup.push(worktreePath);
    return sessions.confirmWorkerMerge(mgrId, workerId);
  }

  try {
    // (4a) project-level flag TRUE → primary merges clean (unchanged baseline behavior).
    {
      const r = await commitAndConfirm("prim", null, primaryRepo, "feat-prim2.txt");
      check("(4a) merged:true", r.merged === true);
      check("(4a) primary: project-level flag suppresses as before", r.warning === undefined);
    }
    // (4b) project-level flag TRUE → the registry entry (itself unflagged) ALSO merges clean — the
    // project-level flag's project-wide reach is unchanged by this card.
    {
      const r = await commitAndConfirm("entry", "entry", entryRepo, "feat-entry2.txt");
      check("(4b) merged:true", r.merged === true);
      check("(4b) entry (unflagged itself): project-level flag STILL suppresses it — unchanged reach", r.warning === undefined);
    }
  } finally {
    db.close();
    for (const d of [primaryRepo, entryRepo, ...cleanup]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
}

// =====================================================================================================
// PART B — trust boundary: a smuggled per-entry noGateByDesign inside `repos` is hard-rejected on every
// agent-facing MCP write surface, mirroring no-gate-by-design-rest.mjs Part B.
// =====================================================================================================
async function partB() {
  const tmpHome = path.join(os.tmpdir(), `loom-rengbd-rest-${Date.now()}-${process.pid}`);
  fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
  const prevHome = process.env.LOOM_HOME;
  process.env.LOOM_HOME = tmpHome;
  const sandboxHome = path.join(tmpHome, "home");
  fs.mkdirSync(sandboxHome, { recursive: true });
  const prevUserProfile = process.env.USERPROFILE, prevHomeEnv = process.env.HOME;
  process.env.USERPROFILE = sandboxHome;
  process.env.HOME = sandboxHome;

  const { PtyHost } = await import("../dist/pty/host.js");
  const { createSeamHost } = await import("./_seam-host-fixture.mjs");
  const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
  const { SetupMcpRouter } = await import("../dist/mcp/setup.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

  const primary = path.join(os.tmpdir(), `loom-rengbd-rest-primary-${sfx}`);
  mkRepo(primary);

  const db = new Db(path.join(tmpHome, "agent.db"));
  db.insertProject({ id: "pHome", name: "Loom Platform", repoPath: primary, vaultPath: primary, config: {}, createdAt: now, archivedAt: null, reserved: true, referenceRepos: [], noGateByDesign: false, denyGlobs: [], repos: [] });
  db.insertProject({ id: "pExisting", name: "Existing", repoPath: primary, vaultPath: primary, config: {}, createdAt: now, archivedAt: null, reserved: false, referenceRepos: [], noGateByDesign: false, denyGlobs: [], repos: [] });
  db.insertAgent({ id: "agentLead", projectId: "pHome", name: "Lead", startupPrompt: "LEAD", position: 0, profileId: null });
  db.insertAgent({ id: "agentSetup", projectId: "pHome", name: "Setup", startupPrompt: "SETUP", position: 0, profileId: null });

  class SeamHost extends createSeamHost(PtyHost) {
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
    const client = new Client({ name: "rengbd-test", version: "0" });
    await client.connect(clientT);
    return { client, call: async (name, args) => parse(await client.callTool({ name, arguments: args })) };
  };

  try {
    const setup = await connect(new SetupMcpRouter(db, svc));
    const plat = await connect(new PlatformMcpRouter(db, svc));

    // (B0) neither surface even ADVERTISES `repos` (the carrier) on any project-write tool's inputSchema —
    // a per-entry field nested inside an undeclared key is doubly unreachable.
    const setupTools = (await setup.client.listTools()).tools;
    const platTools = (await plat.client.listTools()).tools;
    for (const [label, tools] of [["loom-setup", setupTools], ["loom-platform", platTools]]) {
      for (const toolName of ["project_create", "project_init", "project_update"]) {
        const schema = tools.find((t) => t.name === toolName)?.inputSchema?.properties ?? {};
        check(`(B0) ${label} ${toolName} inputSchema has NO repos`, !("repos" in schema));
      }
    }

    const rejects = (res, badKey) => res.isError === true && typeof res.content?.[0]?.text === "string" && res.content[0].text.includes(badKey);
    const smuggledRepos = [{ key: "sneaky", path: primary, noGateByDesign: true }];

    // (B1) setup project_create: a smuggled `repos` array (carrying a per-entry noGateByDesign) is
    // HARD-REJECTED — no project is created at all.
    const beforeB1 = db.listProjects().length;
    const c1 = await setup.client.callTool({ name: "project_create", arguments: { name: "SetupCreated", repoPath: primary, repos: smuggledRepos } });
    check("(B1) setup project_create smuggled repos (w/ per-entry noGateByDesign) → hard-rejected", rejects(c1, "repos"));
    check("(B1) no project was created for the rejected call", db.listProjects().length === beforeB1);

    // (B2) platform (elevated) project_create: same guarantee.
    const beforeB2 = db.listProjects().length;
    const c2 = await plat.client.callTool({ name: "project_create", arguments: { name: "PlatCreated", repoPath: primary, repos: smuggledRepos } });
    check("(B2) platform project_create smuggled repos → hard-rejected", rejects(c2, "repos"));
    check("(B2) no project was created for the rejected call", db.listProjects().length === beforeB2);

    // (B3) setup project_update: smuggled repos is HARD-REJECTED — even a legitimate co-supplied `name`
    // patch does not apply.
    const u1 = await setup.client.callTool({ name: "project_update", arguments: { projectId: "pExisting", name: "SetupRenamed", repos: smuggledRepos } });
    check("(B3) setup project_update smuggled repos → hard-rejected", rejects(u1, "repos"));
    check("(B3) repos left UNCHANGED (still [])", JSON.stringify(db.getProject("pExisting")?.repos) === "[]");
    check("(B3) the whole call was rejected — name was NOT applied either", db.getProject("pExisting")?.name === "Existing");

    // (B4) platform (elevated) project_update: same guarantee — even the most privileged agent surface
    // can never introduce a per-entry noGateByDesign via `repos`.
    const u2 = await plat.client.callTool({ name: "project_update", arguments: { projectId: "pExisting", name: "PlatRenamed", repos: smuggledRepos } });
    check("(B4) platform project_update smuggled repos → hard-rejected", rejects(u2, "repos"));
    check("(B4) repos left UNCHANGED (still [])", JSON.stringify(db.getProject("pExisting")?.repos) === "[]");
    check("(B4) the whole call was rejected — name was NOT applied either", db.getProject("pExisting")?.name === "Existing");

    await setup.client.close();
    await plat.client.close();
  } finally {
    db.close();
    process.env.LOOM_HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
    if (prevHomeEnv === undefined) delete process.env.HOME; else process.env.HOME = prevHomeEnv;
    for (const d of [tmpHome, primary]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
  }
}

try {
  await partA();
  await partA2();
  await partB();
} catch (err) {
  console.error(err);
  failures++;
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a registry entry flagged noGateByDesign merges with NO warning for its OWN merges; an unflagged sibling entry on the same project still warns; the primary repo's warning is unaffected by any entry's flag; Project.noGateByDesign's project-wide reach is unchanged (still suppresses primary + every entry regardless of the entry's own flag); and a smuggled per-entry noGateByDesign nested in `repos` is hard-rejected on every agent-facing MCP write surface — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
