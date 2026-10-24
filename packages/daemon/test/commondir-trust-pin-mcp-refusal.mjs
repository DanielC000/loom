import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1)
// CARD 4d60366b, Code Review 33b9c061 (round 3) — S2/S3's REST coverage (commondir-trust-pin-rest-
// refusal.mjs) never exercised the 5 agent-facing MCP sites that carry the SAME pre-flight + try/catch:
// platform.ts's project_create/project_init/project_update, and setup.ts's project_create/project_init.
// HERMETIC + CLAUDE-FREE + NETWORK-FREE: a real Db + the REAL PlatformMcpRouter/SetupMcpRouter over an
// in-process MCP InMemoryTransport (no HTTP), modeled on agent-id-prefix.mjs's own "(5) agent_get via the
// REAL PlatformMcpRouter" block. `sessions` is a harmless stub `{}` — none of these 5 handlers touch it.
//
// The conflict is constructed the SAME way the REST file's does: bind an OWNER to a SUBDIR of a real repo
// (no own .git — the walk resolves UP to the ancestor), then plant a FRESH real .git directly in that
// subdir — a later bind to the SAME literal path walks successfully but to a DIFFERENT toplevel. For the
// two project_init tools, the ancestor repo IS WORKSPACE_ROOT itself, so project-init's own dirName-leaf
// resolution can be made to predict the EXACT same literal path.
//
// Proves, for EACH of the 5 sites: a conflicting call returns `ok({error})` (never a thrown/uncaught MCP
// error) naming the conflict; for the two init tools, NO stray directory is created at the predicted
// target. Each case is proven to actually exercise the fix (not vacuous) via the SAME RED-before-GREEN
// method as the other commondir-trust-pin test files: run against the pre-pre-flight/catch source (card
// 9ef19185, before round 6's S2/S3), see it FAIL, then against the fix, see it PASS — see the worker_report
// for the exact commands.
// Run: 1) pnpm build, 2) node packages/daemon/test/commondir-trust-pin-mcp-refusal.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { useOwnLoomHome, registerForCleanup, finishAndExit } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

useOwnLoomHome("loom-cgcr-mcp-refusal-home-");

const { Db } = await import("../dist/db.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { SetupMcpRouter } = await import("../dist/mcp/setup.js");
const { WORKSPACE_ROOT } = await import("../dist/paths.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), `loom-cgcr-mcp-${sfx}-`));
registerForCleanup(SCRATCH);
const git = (cwd, args) => execSync(`git ${args}`, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const GIT_ID = "-c user.email=cgcrmcp@loom -c user.name=cgcrmcp";
function initRepo(name) {
  const dir = path.join(SCRATCH, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init -q -b main");
  fs.writeFileSync(path.join(dir, "f.txt"), `${name}\n`);
  git(dir, "add -A");
  git(dir, `${GIT_ID} commit -q -m "${name}: init"`);
  return dir;
}
function plantOwnGit(nested) { fs.mkdirSync(path.join(nested, ".git")); }

let workspaceRootReady = false;
function ensureWorkspaceRootRepo() {
  const root = path.resolve(WORKSPACE_ROOT);
  fs.mkdirSync(root, { recursive: true });
  if (!workspaceRootReady) {
    git(root, "init -q -b main");
    fs.writeFileSync(path.join(root, "f.txt"), "root\n");
    git(root, "add -A");
    git(root, `${GIT_ID} commit -q -m "root: init"`);
    workspaceRootReady = true;
  }
  return root;
}

const now = new Date().toISOString();
/** A minimal project+agent+session triple so `resolveRole` on each router passes — mirrors
 *  agent-id-prefix.mjs's own "(5)" block. `sessions` is a harmless stub `{}`: none of the 5 tool handlers
 *  under test touch it. */
function seedCallerSession(db, role, repo) {
  const pid = `cgcr-mcp-p-${role}-${sfx}`;
  const aid = `cgcr-mcp-a-${role}-${sfx}`;
  const sid = `cgcr-mcp-s-${role}-${sfx}`;
  db.insertProject({ id: pid, name: `caller-${role}`, repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false, referenceRepos: [], noGateByDesign: false, denyGlobs: ["mockups/**"], repos: [], vaultOnly: false });
  db.insertAgent({ id: aid, projectId: pid, name: `Caller ${role}`, startupPrompt: role, position: 0, profileId: null });
  db.insertSession({ id: sid, projectId: pid, agentId: aid, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role });
  return sid;
}
async function connectedClient(router, callerSessionId) {
  const server = router.buildServer(callerSessionId);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "commondir-trust-pin-mcp-refusal-test", version: "0" });
  await client.connect(clientT);
  // @decision 3a5c5d4a (round 6, Code Review e242c754 round 4) — TOLERANT call(): a thrown MCP protocol
  // error (a site whose pre-flight/catch was removed entirely, surfacing as an uncaught exception rather
  // than a clean ok({error})) or non-JSON tool content is caught HERE and turned into that site's own
  // {error} result, never an uncaught exception that would abort the whole file and silently hide every
  // LATER site's own checks.
  const call = async (name, args) => {
    let res;
    try { res = await client.callTool({ name, arguments: args }); }
    catch (e) { return { error: `callTool threw: ${e instanceof Error ? e.message : String(e)}` }; }
    const text = res?.content?.[0]?.text;
    try { return JSON.parse(text); }
    catch { return { error: `non-JSON tool result: ${String(text).slice(0, 200)}` }; }
  };
  return { client, call };
}

const callerRepo = initRepo("caller-home");
const db = new Db();
const platformSid = seedCallerSession(db, "platform", callerRepo);
const setupSid = seedCallerSession(db, "setup", callerRepo);
const platformRouter = new PlatformMcpRouter(db, {});
const setupRouter = new SetupMcpRouter(db, {});

// ===================== (1) platform project_create → ok({error}) on conflict =====================
{
  const { call } = await connectedClient(platformRouter, platformSid);
  const ancestor = initRepo("p1-ancestor");
  const nested = path.join(ancestor, "nested-dir");
  fs.mkdirSync(nested);
  const ownerId = `cgcr-mcp-owner1-${sfx}`;
  db.insertProject({ id: ownerId, name: "Owner1", repoPath: nested, vaultPath: nested, config: {}, createdAt: now, archivedAt: null, reserved: false, referenceRepos: [], noGateByDesign: false, denyGlobs: ["mockups/**"], repos: [], vaultOnly: false });
  check("(1, setup) owner bound to the subdir", db.getCommondirTrustPin(nested)?.projectId === ownerId);
  plantOwnGit(nested);
  const before = db.listAllProjects().length;
  const result = await call("project_create", { name: "Second1", repoPath: nested });
  check("(1) platform project_create on the conflicting path returns ok({error})", typeof result.error === "string" && /commondir-trust pin/i.test(result.error));
  check("(1) no new project was written", db.listAllProjects().length === before);
}

// ===================== (2) platform project_init → ok({error}) + NO stray dir =====================
{
  const { call } = await connectedClient(platformRouter, platformSid);
  const root = ensureWorkspaceRootRepo();
  const dirName = "p2-reused-leaf";
  const nested = path.join(root, dirName);
  fs.mkdirSync(nested);
  const ownerId = `cgcr-mcp-owner2-${sfx}`;
  db.insertProject({ id: ownerId, name: "Owner2", repoPath: nested, vaultPath: nested, config: {}, createdAt: now, archivedAt: null, reserved: false, referenceRepos: [], noGateByDesign: false, denyGlobs: ["mockups/**"], repos: [], vaultOnly: false });
  check("(2, setup) owner bound to the subdir leaf", db.getCommondirTrustPin(nested)?.projectId === ownerId);
  fs.rmSync(nested, { recursive: true, force: true }); // leaf vanishes; WORKSPACE_ROOT's own repo survives
  const before = db.listAllProjects().length;
  const result = await call("project_init", { name: "Second2", dirName });
  check("(2) platform project_init on the conflicting predicted target returns ok({error})", typeof result.error === "string" && /commondir-trust pin/i.test(result.error));
  check("(2) NO stray directory was created at the predicted target", !fs.existsSync(nested));
  check("(2) no new project was written", db.listAllProjects().length === before);
}

// ===================== (3) platform project_update → ok({error}), atomic =====================
{
  const { call } = await connectedClient(platformRouter, platformSid);
  const ancestor = initRepo("p3-ancestor");
  const nested = path.join(ancestor, "nested-dir");
  fs.mkdirSync(nested);
  const ownerId = `cgcr-mcp-owner3-${sfx}`;
  db.insertProject({ id: ownerId, name: "Owner3", repoPath: nested, vaultPath: nested, config: {}, createdAt: now, archivedAt: null, reserved: false, referenceRepos: [], noGateByDesign: false, denyGlobs: ["mockups/**"], repos: [], vaultOnly: false });
  plantOwnGit(nested);
  const otherRepo = initRepo("p3-other");
  const otherId = `cgcr-mcp-other3-${sfx}`;
  db.insertProject({ id: otherId, name: "Other3", repoPath: otherRepo, vaultPath: otherRepo, config: {}, createdAt: now, archivedAt: null, reserved: false, referenceRepos: [], noGateByDesign: false, denyGlobs: ["mockups/**"], repos: [], vaultOnly: false });
  const result = await call("project_update", { projectId: otherId, name: "renamed-by-refused-patch", repoPath: nested });
  check("(3) platform project_update onto the conflicting path returns ok({error})", typeof result.error === "string" && /commondir-trust pin/i.test(result.error));
  const after = db.getProject(otherId);
  check("(3) the WHOLE patch is refused atomically — name is unchanged too", after?.name === "Other3" && after?.repoPath === otherRepo);
}

// ===================== (4) setup project_create → ok({error}) on conflict =====================
{
  const { call } = await connectedClient(setupRouter, setupSid);
  const ancestor = initRepo("p4-ancestor");
  const nested = path.join(ancestor, "nested-dir");
  fs.mkdirSync(nested);
  const ownerId = `cgcr-mcp-owner4-${sfx}`;
  db.insertProject({ id: ownerId, name: "Owner4", repoPath: nested, vaultPath: nested, config: {}, createdAt: now, archivedAt: null, reserved: false, referenceRepos: [], noGateByDesign: false, denyGlobs: ["mockups/**"], repos: [], vaultOnly: false });
  plantOwnGit(nested);
  const before = db.listAllProjects().length;
  const result = await call("project_create", { name: "Second4", repoPath: nested });
  check("(4) setup project_create on the conflicting path returns ok({error})", typeof result.error === "string" && /commondir-trust pin/i.test(result.error));
  check("(4) no new project was written", db.listAllProjects().length === before);
}

// ===================== (5) setup project_init → ok({error}) + NO stray dir =====================
{
  const { call } = await connectedClient(setupRouter, setupSid);
  const root = ensureWorkspaceRootRepo();
  const dirName = "p5-reused-leaf";
  const nested = path.join(root, dirName);
  fs.mkdirSync(nested);
  const ownerId = `cgcr-mcp-owner5-${sfx}`;
  db.insertProject({ id: ownerId, name: "Owner5", repoPath: nested, vaultPath: nested, config: {}, createdAt: now, archivedAt: null, reserved: false, referenceRepos: [], noGateByDesign: false, denyGlobs: ["mockups/**"], repos: [], vaultOnly: false });
  fs.rmSync(nested, { recursive: true, force: true });
  const before = db.listAllProjects().length;
  const result = await call("project_init", { name: "Second5", dirName });
  check("(5) setup project_init on the conflicting predicted target returns ok({error})", typeof result.error === "string" && /commondir-trust pin/i.test(result.error));
  check("(5) NO stray directory was created at the predicted target", !fs.existsSync(nested));
  check("(5) no new project was written", db.listAllProjects().length === before);
}

// ===================== (6) card a8bc0404 — the re-pin route is NEVER reachable from MCP =====================
// A real tools/list sweep on BOTH routers, not an assumption: the repin capability is REST-only
// (gateway/server.ts's POST /api/projects/:id/commondir-trust-pin/repin) and was never registered as an
// MCP tool on either router — proven directly rather than inferred from "I didn't add one".
{
  const { client: platformClient } = await connectedClient(platformRouter, platformSid);
  const { client: setupClient } = await connectedClient(setupRouter, setupSid);
  const platformTools = (await platformClient.listTools()).tools.map((t) => t.name);
  const setupTools = (await setupClient.listTools()).tools.map((t) => t.name);
  const suspicious = (names) => names.filter((n) => /commondir|repin/i.test(n));
  check("(6) platform MCP surface has no commondir/repin-named tool", suspicious(platformTools).length === 0);
  check("(6) setup MCP surface has no commondir/repin-named tool", suspicious(setupTools).length === 0);
}

try { db.close(); } catch { /* best-effort — never let cleanup fail the test */ }
await finishAndExit(failures === 0 ? 0 : 1);
