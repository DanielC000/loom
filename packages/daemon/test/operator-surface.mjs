import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Bucket 2b "Bounded Elevated Operator" — the per-install, OPT-IN, HUMAN-SPAWNED-ONLY, OWN-WORKSPACE-
// CONFINED `operator` role + its `loom-operator` MCP surface (mcp/operator.ts). HERMETIC + CLAUDE-FREE +
// NETWORK-FREE (mirrors setup-surface.mjs): a REAL Db + SessionService driven against a FAKE pty, the
// REAL OperatorMcpRouter driven over an in-process MCP InMemoryTransport, a REAL temp git repo + a REAL
// bare remote (no external network — a second local temp dir as `origin`).
//
// Proves:
//   A. Fail-closed default: platform.operatorEnabled is OFF by default (isOperatorEnabled false);
//      resolveRole(an "operator" session) is null while OFF ⇒ /mcp-operator 404s; spawn byte-identity —
//      buildMcpServers/disallowedToolsForRole for every PRE-EXISTING role stays unchanged, and the new
//      "operator" case mounts loom-operator (+loom-tasks) only, with disallowedToolsForRole("operator")
//      === [] (default case — no human-prompt disallow, no task-tracking disallow, intentional).
//   B. Surface only when on: flipping platform.operatorEnabled ON makes resolveRole(operator session)
//      truthy and resolveRole(manager/worker/plain/setup) stays null; flipping OFF→ON→OFF again on the
//      SAME session proves the gate is read LIVE, not boot-memoized.
//   C. No self-elevation: setupRoleError("operator") errors; startOperator LOCKS the session role to
//      "operator" regardless of the agent's profile role; POST /api/agents/:id/sessions {role:"operator"}
//      403s when the flag is off and spawns when it's on; both setup's and platform's session_spawn
//      refuse role "operator".
//   D. Own-workspace confinement: every writer tool's schema carries NO projectId argument at all (an
//      extra projectId in the call args is inert — the write always targets the CALLER's own project);
//      git_checkout/create_branch/commit/push round-trip against a REAL repo + a REAL local remote;
//      vault_write confines to the caller's OWN vaultPath and rejects a traversal path.
//   E. Forbidden set absent: the registered tool list carries none of session_message/session_stop/
//      agent_delete/agent_clone(_batch)/schedule_*/project_configure/project_create/project_init/
//      profile_*/session_spawn/skill_write.
//   F. Subset/no-new-writer: mcp/operator.ts imports GitWriter (git/writer.js) + writeVaultFile
//      (vault/writer.js) verbatim and defines no simpleGit(/fs.writeFileSync( of its own.
//   G. Config plumbing: resolveConfig(undefined,{operatorEnabled:true}).platform.operatorEnabled===true;
//      default false; the agent-facing project config validator still rejects a `platform` key (unchanged).
//
// Run: 1) build (turbo builds shared first), 2) node test/operator-surface.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-operator-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_PORT = "45392";
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { seedDefaultProfiles } = await import("../dist/profiles/seed.js");
const { PtyHost, buildMcpServers, disallowedToolsForRole } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { SetupMcpRouter, setupRoleError } = await import("../dist/mcp/setup.js");
const { PlatformMcpRouter, validateAgentProjectConfigOverride } = await import("../dist/mcp/platform.js");
const { OperatorMcpRouter, isOperatorEnabled } = await import("../dist/mcp/operator.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { resolveConfig } = await import("@loom/shared");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

// --- a real temp git repo (project P1's repoPath) + a real bare "origin" remote (local, no network) ---
const repo = path.join(os.tmpdir(), `loom-operator-repo-${Date.now()}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# operator test repo\n");
// PERSISTED (not just -c per-invocation) repo-local identity — git_commit reuses GitWriter.commit()
// VERBATIM (no -c overrides, per the project convention), so it needs the repo's OWN configured identity.
execSync(`git init -q && git config user.email o@loom && git config user.name o && git add . && git commit -q -m init`, { cwd: repo });
const bareRemote = path.join(os.tmpdir(), `loom-operator-remote-${Date.now()}.git`);
execSync(`git init -q --bare "${bareRemote}"`);
execSync(`git remote add origin "${bareRemote}"`, { cwd: repo });
execSync(`git push -q -u origin HEAD:refs/heads/main`, { cwd: repo });

// A second project's repo — used ONLY to prove an extra `projectId` in a call's args can't redirect a write.
const otherRepo = path.join(os.tmpdir(), `loom-operator-otherrepo-${Date.now()}`);
fs.mkdirSync(otherRepo, { recursive: true });
fs.writeFileSync(path.join(otherRepo, "README.md"), "# other repo\n");
execSync(`git init -q && git add . && git -c user.email=o@loom -c user.name=o commit -q -m init`, { cwd: otherRepo });

const now = new Date().toISOString();
const db = new Db();
seedDefaultProfiles(db); // seeds the bundled "Elevated Operator" profile (ungated) among the core rigs
db.insertProject({ id: "P1", name: "Project One", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertProject({ id: "P2", name: "Project Two", repoPath: otherRepo, vaultPath: otherRepo, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertAgent({ id: "agentOp", projectId: "P1", name: "Operator Agent", startupPrompt: "OP", position: 0, profileId: null });
// An agent bound to a WORKER-role profile — proves startOperator LOCKS the session role regardless.
const workerProfile = db.listProfiles().find((p) => p.name === "Dev");
db.insertAgent({ id: "agentOpWithWorkerProfile", projectId: "P1", name: "Op w/ worker rig", startupPrompt: "OP2", position: 1, profileId: workerProfile?.id ?? null });

const seedSession = (id, role, projectId = "P1") => db.insertSession({
  id, projectId, agentId: "agentOp", engineSessionId: null,
  title: null, cwd: projectId === "P1" ? repo : otherRepo, processState: "live", resumability: "unknown", busy: false,
  createdAt: now, lastActivity: now, lastError: null, role, parentSessionId: null,
});
seedSession("OP", "operator");     // the operator session under test, bound to P1
seedSession("M", "manager");
seedSession("W", "worker");
seedSession("PLAIN", null);
seedSession("SETUP", "setup");

// Fake pty: capture createPty (spawn) calls; no real claude (mirrors setup-surface.mjs).
class SeamHost extends PtyHost {
  constructor(events) { super(events); this.spawned = []; }
  createPty(opts) { this.spawned.push(opts); return { pid: 4242, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} }; }
  stop() {}
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());
const operatorRouter = new OperatorMcpRouter(db, svc);
const setupRouter = new SetupMcpRouter(db, svc);
const platformRouter = new PlatformMcpRouter(db, svc);

const parse = (res) => JSON.parse(res.content[0].text);

try {
  // ============ A. FAIL-CLOSED DEFAULT ============
  check("(A) isOperatorEnabled(db) is FALSE by default (no platform_config row)", isOperatorEnabled(db) === false);
  check("(A) operatorRouter.resolveRole('OP') is NULL while the flag is off (a real 'operator' session, but flag-gated)",
    operatorRouter.resolveRole("OP") === null);

  // Spawn byte-identity: every PRE-EXISTING role's buildMcpServers map is UNCHANGED by this addition.
  const preExisting = [
    ["manager", { "loom-tasks": true, "loom-orchestration": true }],
    ["worker", { "loom-tasks": true, "loom-orchestration": true }],
    ["platform", { "loom-tasks": true, "loom-platform": true }],
    ["auditor", { "loom-tasks": true, "loom-audit": true }],
    ["workspace-auditor", { "loom-tasks": true, "loom-user-audit": true }],
    ["setup", { "loom-tasks": true, "loom-setup": true }],
    ["assistant", { "loom-tasks": true, "loom-orchestration": true }],
  ];
  for (const [role, expectKeys] of preExisting) {
    const map = buildMcpServers({ sessionId: "s1", port: 4317, role });
    const keys = Object.keys(map).sort();
    check(`(A) buildMcpServers(${role}): unchanged key set (${keys.join(",")})`,
      JSON.stringify(keys) === JSON.stringify(Object.keys(expectKeys).sort()));
    check(`(A) buildMcpServers(${role}): does NOT mount loom-operator`, !map["loom-operator"]);
  }
  const plainMap = buildMcpServers({ sessionId: "s1", port: 4317, role: undefined });
  check("(A) buildMcpServers(plain): byte-identical (loom-tasks only)", JSON.stringify(Object.keys(plainMap)) === JSON.stringify(["loom-tasks"]));

  // The NEW operator case: mounts loom-operator (+loom-tasks) ONLY.
  const opMap = buildMcpServers({ sessionId: "OP", port: 4317, role: "operator" });
  check("(A) buildMcpServers(operator): mounts loom-operator", !!opMap["loom-operator"]);
  check("(A) buildMcpServers(operator): still has loom-tasks", !!opMap["loom-tasks"]);
  check("(A) buildMcpServers(operator): EXACTLY {loom-tasks, loom-operator} — no orch/platform/audit/setup",
    JSON.stringify(Object.keys(opMap).sort()) === JSON.stringify(["loom-operator", "loom-tasks"]));
  check("(A) buildMcpServers(operator): the mounted URL is the /mcp-operator/:sessionId route",
    opMap["loom-operator"].url === "http://127.0.0.1:4317/mcp-operator/OP");

  // disallowedToolsForRole("operator") — the NO-CHANGE default case (falls through both switches):
  // NOT in the human-prompt-disallow set (it's human-driven, keeps AskUserQuestion, like manager/platform)
  // and NOT in the task-tracking-disallow set (that's manager/platform/auditor only) ⇒ exactly [].
  check("(A) disallowedToolsForRole('operator') === [] (intentional default-case fallthrough, mirrors manager/platform)",
    JSON.stringify(disallowedToolsForRole("operator")) === JSON.stringify([]));

  // ============ B. SURFACE ONLY WHEN ON (+ LIVE, not boot-memoized) ============
  db.setPlatformConfig({ operatorEnabled: true });
  check("(B) isOperatorEnabled(db) is TRUE once the flag is set", isOperatorEnabled(db) === true);
  check("(B) operatorRouter.resolveRole('OP') is now truthy (role=operator AND flag on)", !!operatorRouter.resolveRole("OP"));
  for (const id of ["M", "W", "PLAIN", "SETUP"]) {
    check(`(B) operatorRouter.resolveRole('${id}') is NULL (non-operator role, flag makes no difference)`, operatorRouter.resolveRole(id) === null);
  }
  // LIVE toggle proof: flip the SAME session's gate off, on, off again — no restart, no re-instantiation.
  db.setPlatformConfig({ operatorEnabled: false });
  check("(B) LIVE: flipping the flag OFF makes the SAME session's resolveRole null again (not boot-bound)", operatorRouter.resolveRole("OP") === null);
  db.setPlatformConfig({ operatorEnabled: true });
  check("(B) LIVE: flipping the flag back ON makes the SAME session's resolveRole truthy again", !!operatorRouter.resolveRole("OP"));

  // ============ C. NO SELF-ELEVATION ============
  check("(C) setupRoleError('operator') REJECTS — the ungated setup surface can never mint/assign an operator rig",
    typeof setupRoleError("operator") === "string");

  // startOperator LOCKS the session role to "operator" regardless of the agent's profile role.
  const opFromWorkerProfile = svc.startOperator("agentOpWithWorkerProfile");
  check("(C) startOperator: session role is LOCKED to 'operator' even on an agent bound to a WORKER-role profile",
    opFromWorkerProfile.role === "operator");
  const opPlain = svc.startOperator("agentOp");
  check("(C) startOperator: session role is 'operator' on a profile-less agent too", opPlain.role === "operator");
  check("(C) startOperator: CREATE-ONLY — two calls minted two DISTINCT sessions (not a singleton)", opFromWorkerProfile.id !== opPlain.id);

  // setup's and platform's session_spawn REFUSE role "operator" (already refused by the manager|plain
  // check; the message need not name it — mcp/setup.ts is BYTE-UNCHANGED for this build).
  const setupServer = setupRouter.buildServer("SETUP");
  const [setupClientT, setupServerT] = InMemoryTransport.createLinkedPair();
  await setupServer.connect(setupServerT);
  const setupClient = new Client({ name: "operator-test-setup", version: "0" });
  await setupClient.connect(setupClientT);
  const nSessBeforeSetupRefuse = db.listAllSessions().length;
  const setupRefuse = parse(await setupClient.callTool({ name: "session_spawn", arguments: { projectId: "P1", agentId: "agentOp", role: "operator" } }));
  check("(C) setup session_spawn REFUSES role 'operator'", typeof setupRefuse.error === "string" && !setupRefuse.id);
  check("(C) the refused setup spawn created NO session", db.listAllSessions().length === nSessBeforeSetupRefuse);
  await setupClient.close();

  const platformServer = platformRouter.buildServer("PLATFORM");
  const [platClientT, platServerT] = InMemoryTransport.createLinkedPair();
  await platformServer.connect(platServerT);
  const platClient = new Client({ name: "operator-test-platform", version: "0" });
  await platClient.connect(platClientT);
  const nSessBeforePlatRefuse = db.listAllSessions().length;
  const platRefuse = parse(await platClient.callTool({ name: "session_spawn", arguments: { projectId: "P1", agentId: "agentOp", role: "operator" } }));
  check("(C) platform session_spawn REFUSES role 'operator'", typeof platRefuse.error === "string" && !platRefuse.id);
  check("(C) the refused platform spawn created NO session", db.listAllSessions().length === nSessBeforePlatRefuse);
  await platClient.close();

  // REST: POST /api/agents/:id/sessions {role:"operator"} — 403 when off, spawns when on.
  const stub = {};
  const restApp = await buildServer({
    db, pty: stub, sessions: svc, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub,
    userAuditMcp: stub, setupMcp: stub, operatorMcp: stub, runMcp: stub, control: stub, usageStatus: stub,
    requestShutdown: () => {},
  });
  const H = { host: "127.0.0.1:45392", origin: "http://127.0.0.1:45392", "content-type": "application/json" };
  db.setPlatformConfig({ operatorEnabled: false });
  const nSessBeforeRestOff = db.listAllSessions().length;
  const restOff = await restApp.inject({ method: "POST", url: "/api/agents/agentOp/sessions", headers: H, payload: { role: "operator" } });
  check("(C) REST POST .../sessions {role:operator} → 403 when platform.operatorEnabled is OFF", restOff.statusCode === 403);
  check("(C) the refused REST spawn created NO session", db.listAllSessions().length === nSessBeforeRestOff);
  db.setPlatformConfig({ operatorEnabled: true });
  const restOn = await restApp.inject({ method: "POST", url: "/api/agents/agentOp/sessions", headers: H, payload: { role: "operator" } });
  const restOnBody = JSON.parse(restOn.body);
  check("(C) REST POST .../sessions {role:operator} → spawns (200/201) when the flag is ON", restOn.statusCode < 300 && restOnBody.role === "operator");
  await restApp.close();

  // ============ D. OWN-WORKSPACE CONFINEMENT ============
  const server = operatorRouter.buildServer("OP");
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "operator-e2e-test", version: "0" });
  await client.connect(clientT);
  const call = async (name, args) => parse(await client.callTool({ name, arguments: args }));

  const tools = await client.listTools();
  const toolNames = tools.tools.map((t) => t.name).sort();

  // NO projectId argument on ANY writer tool's schema.
  for (const name of ["git_checkout", "git_create_branch", "git_commit", "git_push", "vault_write"]) {
    const t = tools.tools.find((x) => x.name === name);
    const props = Object.keys(t?.inputSchema?.properties ?? {});
    check(`(D) ${name}: schema carries NO projectId argument (${JSON.stringify(props)})`, !props.includes("projectId"));
  }

  // git_create_branch + git_checkout round-trip against the REAL P1 repo.
  const branchRes = await call("git_create_branch", { name: "feature-op" });
  check("(D) git_create_branch: creates + switches to a new branch in the caller's OWN repo", branchRes.ok === true && branchRes.branch === "feature-op");
  const realBranch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: repo }).toString().trim();
  check("(D) git_create_branch: the REAL repo is actually on the new branch", realBranch === "feature-op");

  // An extra, unrelated `projectId` in the args is INERT — the write STILL targets P1 (never P2/otherRepo).
  const branchWithFakeProjectId = await call("git_create_branch", { name: "feature-ignored-arg", projectId: "P2" });
  check("(D) git_create_branch: an extra projectId in the call args does NOT redirect the write",
    branchWithFakeProjectId.ok === true);
  const p2Branches = execSync("git branch", { cwd: otherRepo }).toString();
  check("(D) confinement proof: P2's (otherRepo) branch list is UNCHANGED — the write never touched it", !p2Branches.includes("feature-ignored-arg"));
  const p1HasIt = execSync("git branch", { cwd: repo }).toString();
  check("(D) confinement proof: P1's (the caller's own repo) branch list DOES have it", p1HasIt.includes("feature-ignored-arg"));

  const checkoutRes = await call("git_checkout", { branch: "feature-op" });
  check("(D) git_checkout: switches to an existing local branch", checkoutRes.ok === true && checkoutRes.branch === "feature-op");

  // git_commit: stage+commit a REAL file change via the tool (add -A under the hood).
  fs.writeFileSync(path.join(repo, "note.txt"), "operator wrote this\n");
  const commitRes = await call("git_commit", { message: "feat(test): operator commit" });
  check("(D) git_commit: commits the real working-tree change", commitRes.ok === true && typeof commitRes.hash === "string" && commitRes.hash.length > 0);
  const cleanTreeCommit = await call("git_commit", { message: "nothing to commit" });
  check("(D) git_commit: a clean tree is an EXPECTED no-op failure, not a throw", cleanTreeCommit.ok === false && /clean/i.test(cleanTreeCommit.error ?? ""));

  // git_push: a REAL push to the local bare "origin" remote — no --force, GitWriter.push() verbatim.
  const pushRes = await call("git_push", {});
  check("(D) git_push: pushes the caller's own current branch (no args at all — no projectId)", pushRes.ok === true);
  const remoteBranches = execSync(`git --git-dir="${bareRemote}" branch`, {}).toString();
  check("(D) git_push: the REAL bare remote now has the pushed branch", remoteBranches.includes("feature-op"));

  // vault_write: confines to the caller's OWN vaultPath (P1's, = repo here).
  const vwRes = await call("vault_write", { path: "notes/hello.md", content: "hi from the operator" });
  check("(D) vault_write: writes into the caller's OWN vault", vwRes.ok === true);
  check("(D) vault_write: the file actually landed under P1's vaultPath", fs.existsSync(path.join(repo, "notes", "hello.md")) && fs.readFileSync(path.join(repo, "notes", "hello.md"), "utf8") === "hi from the operator");
  const vwTraversal = await call("vault_write", { path: "../escape.md", content: "evil" });
  check("(D) vault_write: a traversal path is REJECTED ({ok:false, reason:'traversal'})", vwTraversal.ok === false && vwTraversal.reason === "traversal");
  check("(D) vault_write: the rejected traversal wrote NOTHING outside the vault", !fs.existsSync(path.join(path.dirname(repo), "escape.md")));

  // my_project (own-project read, no arg) resolves to the CALLER's own project.
  const myProj = await call("my_project", {});
  check("(D) my_project: resolves to the caller's OWN project (P1), no argument taken", myProj.id === "P1" && myProj.repoPath === repo);

  // ============ E. FORBIDDEN SET ABSENT ============
  const forbidden = [
    "session_message", "session_stop", "agent_delete", "agent_clone", "agent_clone_batch",
    "schedule_create", "schedule_update", "schedule_get", "schedule_delete",
    "project_configure", "project_create", "project_init", "project_update", "project_archive",
    "profile_create", "profile_update", "profile_assign", "profile_delete",
    "session_spawn", "skill_write", "skill_list",
    "agent_create", "agent_update", "recycle_me",
  ];
  check("(E) the operator surface has NONE of the forbidden cross-project/config-set/self-improvement tools",
    forbidden.every((t) => !toolNames.includes(t)));
  check("(E) the operator surface is EXACTLY the 7-tool own-workspace subset",
    JSON.stringify(toolNames) === JSON.stringify(["end_me", "git_checkout", "git_commit", "git_create_branch", "git_push", "my_project", "vault_write"].sort()));

  await client.close();

  // ============ F. SUBSET / NO-NEW-WRITER (source-level) ============
  const operatorSrc = fs.readFileSync(path.join(__dirname, "..", "src", "mcp", "operator.ts"), "utf8");
  check("(F) mcp/operator.ts imports GitWriter from git/writer.js", /import\s*\{\s*GitWriter\s*\}\s*from\s*"\.\.\/git\/writer\.js"/.test(operatorSrc));
  check("(F) mcp/operator.ts imports writeVaultFile from vault/writer.js", /import\s*\{\s*writeVaultFile\s*\}\s*from\s*"\.\.\/vault\/writer\.js"/.test(operatorSrc));
  check("(F) mcp/operator.ts defines NO simpleGit( of its own", !/simpleGit\(/.test(operatorSrc));
  check("(F) mcp/operator.ts defines NO fs.writeFileSync( of its own", !/fs\.writeFileSync\(/.test(operatorSrc));

  // ============ G. CONFIG PLUMBING ============
  check("(G) resolveConfig(undefined,{operatorEnabled:true}).platform.operatorEnabled === true",
    resolveConfig(undefined, { operatorEnabled: true }).platform.operatorEnabled === true);
  check("(G) resolveConfig(undefined).platform.operatorEnabled === false (default)",
    resolveConfig(undefined).platform.operatorEnabled === false);
  // Agent-facing PROJECT config schemas are UNCHANGED: a `platform` key is still an unknown/rejected key
  // (platform.operatorEnabled is a DAEMON-GLOBAL field, never reachable through a per-project override).
  const platformKeyRejected = validateAgentProjectConfigOverride({ platform: { operatorEnabled: true } });
  check("(G) the agent-facing PROJECT config validator still REJECTS a `platform` key (unchanged)", platformKeyRejected.ok === false);
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(otherRepo, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(bareRemote, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the Bucket 2b Elevated Operator surface is fail-closed by default (flag off ⇒ 404, byte-identical spawn for every pre-existing role), gated LIVE (not boot-memoized) once on, cannot self-elevate (setupRoleError rejects it, setup/platform session_spawn refuse it, the REST spawn 403s while off), is own-workspace-confined (no projectId argument anywhere, an extra one is inert, git checkout/create-branch/commit/push + vault_write round-trip against the caller's own project only, traversal rejected), carries none of the forbidden cross-project/config-set/self-improvement tools, reuses GitWriter/writeVaultFile verbatim with no new writer of its own, and the config plumbing resolves/defaults correctly with the per-project validator unchanged."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
