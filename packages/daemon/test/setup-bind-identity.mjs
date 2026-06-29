import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Setup-layer gap-hunt cleanup (PL umbrella ce55e67b, group C, scope `setup`) — two items:
//
//   ITEM 1 — project_update preserves SIBLING config keys (no whole-object clobber).
//     project_update routed its config write through setProjectConfigSafe (which RE-KEYS orphaned cards
//     but writes the WHOLE object it's handed — it does NOT deep-merge), so editing one config key dropped
//     a board's OTHER overrides. The fix deep-merges the validated partial into the existing override
//     FIRST (matching project_configure). This proves a single-key update keeps the sibling key intact.
//
//   ITEM 2 — a RESOLVABLE commit identity is asserted at project bind.
//     Binding a CODE repo now surfaces a NON-blocking `identityWarning` when no commit identity is
//     resolvable (a later worker/merge commit would FAIL) or when the configured identity is wrong for the
//     origin host — reusing the SAME GitHub-vs-self-hosted/Forgejo rule the push-time warning uses
//     (git/reader.ts › checkCommitIdentity, sharing writer.ts › commitIdentityHostWarning). Tested both
//     directly (the helper) and end-to-end through the setup surface's project_create.
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE (mirrors setup-surface.mjs): real Db + SessionService against
// a fake pty, the real SetupMcpRouter over an in-process MCP transport; real temp git repos, no real claude,
// no remote ever contacted (origin URLs are only READ, never pushed).
//
// Run: 1) build, 2) node test/setup-bind-identity.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME, and a NEUTRALIZED global/system git config so the
// "no identity" case is deterministic regardless of the host machine's ~/.gitconfig (only repo-LOCAL
// config is consulted). Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-bindid-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
// Point git's global+system config at non-existent files → git reads them as empty. So a repo with NO
// local identity is GENUINELY unresolvable here, independent of the runner's real git identity.
process.env.GIT_CONFIG_GLOBAL = path.join(tmpHome, "no-global-gitconfig");
process.env.GIT_CONFIG_SYSTEM = path.join(tmpHome, "no-system-gitconfig");

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { SetupMcpRouter } = await import("../dist/mcp/setup.js");
const { checkCommitIdentity } = await import("../dist/git/reader.js");
const { commitIdentityHostWarning, originHost } = await import("../dist/git/writer.js");
const { resolveConfig } = await import("@loom/shared");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

// --- git repo fixtures ---
const mkRepo = (suffix) => {
  const r = path.join(os.tmpdir(), `loom-bindid-${suffix}-${Date.now()}-${process.pid}`);
  fs.mkdirSync(r, { recursive: true });
  execSync("git init -q", { cwd: r });
  return r;
};
// (a) NO identity (no local config; global/system neutralized) → unresolvable.
const repoNoId = mkRepo("noid");
// (b) a resolvable LOCAL identity, NO remote → resolvable, no host warning.
const repoCleanLocal = mkRepo("clean");
execSync("git config user.email dev@example.com && git config user.name Dev", { cwd: repoCleanLocal });
// (c) a github-noreply identity but a SELF-HOSTED (Forgejo) origin → host-rule warning (unroutable there).
const repoForgejo = mkRepo("forgejo");
execSync("git config user.email u@users.noreply.github.com && git config user.name U", { cwd: repoForgejo });
execSync("git remote add origin https://git.selfhosted.example/owner/repo.git", { cwd: repoForgejo });
// (d) a REAL identity published to a GITHUB origin → host-rule warning (leakable email).
const repoGithubLeak = mkRepo("ghleak");
execSync("git config user.email real.person@gmail.com && git config user.name Real", { cwd: repoGithubLeak });
execSync("git remote add origin git@github.com:owner/repo.git", { cwd: repoGithubLeak });
// (e) a github-noreply identity on a GITHUB origin → CLEAN (no warning).
const repoGithubClean = mkRepo("ghclean");
execSync("git config user.email u@users.noreply.github.com && git config user.name U", { cwd: repoGithubClean });
execSync("git remote add origin https://github.com/owner/repo.git", { cwd: repoGithubClean });

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pHome", name: "Getting Started", repoPath: repoNoId, vaultPath: repoNoId, config: {}, createdAt: now, archivedAt: null, reserved: true });
db.insertAgent({ id: "agentSetup", projectId: "pHome", name: "Setup Assistant", startupPrompt: "SETUP", position: 0, profileId: null });
db.insertSession({
  id: "SETUP", projectId: "pHome", agentId: "agentSetup", engineSessionId: null,
  title: null, cwd: repoNoId, processState: "live", resumability: "unknown", busy: false,
  createdAt: now, lastActivity: now, lastError: null, role: "setup", parentSessionId: null,
});

class SeamHost extends PtyHost {
  constructor(events) { super(events); this.spawned = []; }
  createPty(opts) { this.spawned.push(opts); return { pid: 4242, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} }; }
  stop() {}
}
const host = new SeamHost({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} });
const svc = new SessionService(db, host, new OrchestrationControl());
const setupRouter = new SetupMcpRouter(db, svc);
const parse = (res) => JSON.parse(res.content[0].text);

try {
  const server = setupRouter.buildServer();
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "setup-bind-identity-test", version: "0" });
  await client.connect(clientT);
  const call = async (name, args) => parse(await client.callTool({ name, arguments: args }));

  // ============ ITEM 1 — project_update preserves sibling config keys ============
  const proj = await call("project_create", { name: "MergeProj", repoPath: repoCleanLocal });
  check("(1) project_create: created with an id", !!proj.id && !proj.error);
  // Set the FIRST config key (docLint) via project_configure.
  const cfgA = await call("project_configure", { projectId: proj.id, config: { docLint: true } });
  check("(1) project_configure: docLint set", cfgA.ok === true && resolveConfig(db.getProject(proj.id).config).docLint === true);
  // project_update a DIFFERENT key (obsidian.autoStart — an agent-settable nested key; sessionEnv is now
  // HUMAN-only) — the sibling docLint must SURVIVE (the clobber bug).
  const upd = await call("project_update", { projectId: proj.id, config: { obsidian: { autoStart: true } } });
  check("(1) project_update: returns the project (no error)", !!upd.id && !upd.error);
  const merged = resolveConfig(db.getProject(proj.id).config);
  check("(1) project_update: the NEW key applied (obsidian.autoStart)", merged.obsidian?.autoStart === true);
  check("(1) project_update: the SIBLING key PRESERVED (docLint still true — not clobbered)", merged.docLint === true);
  // And a project_update that ALSO renames (name + a config key together) still preserves siblings.
  const upd2 = await call("project_update", { projectId: proj.id, name: "MergeProj v2", config: { docLint: false } });
  const merged2 = resolveConfig(db.getProject(proj.id).config);
  check("(1) project_update: rename applied alongside config", upd2.name === "MergeProj v2" && !upd2.error);
  check("(1) project_update: updating docLint kept the sibling obsidian.autoStart", merged2.obsidian?.autoStart === true);
  check("(1) project_update: the updated key took effect (docLint now false)", merged2.docLint === false);

  // ============ ITEM 2 — resolvable-commit-identity assert at bind (direct helper) ============
  const noId = await checkCommitIdentity(repoNoId);
  check("(2) checkCommitIdentity: NO identity → resolvable:false + a warning", noId.resolvable === false && typeof noId.warning === "string" && /user\.name|identity/i.test(noId.warning));
  const cleanLocal = await checkCommitIdentity(repoCleanLocal);
  check("(2) checkCommitIdentity: a local identity, no remote → resolvable, NO warning", cleanLocal.resolvable === true && cleanLocal.email === "dev@example.com" && cleanLocal.warning === undefined);
  const forgejo = await checkCommitIdentity(repoForgejo);
  check("(2) checkCommitIdentity: github-noreply on a SELF-HOSTED origin → host-rule warning", forgejo.resolvable === true && typeof forgejo.warning === "string" && /self-hosted|unroutable/i.test(forgejo.warning));
  const ghLeak = await checkCommitIdentity(repoGithubLeak);
  check("(2) checkCommitIdentity: a REAL email on a GITHUB origin → leak warning", ghLeak.resolvable === true && typeof ghLeak.warning === "string" && /GitHub|leak|noreply/i.test(ghLeak.warning));
  const ghClean = await checkCommitIdentity(repoGithubClean);
  check("(2) checkCommitIdentity: github-noreply on a GITHUB origin → resolvable, NO warning", ghClean.resolvable === true && ghClean.warning === undefined);
  // never throws on a non-repo path
  const nonRepo = await checkCommitIdentity(path.join(tmpHome, "definitely-not-a-repo"));
  check("(2) checkCommitIdentity: a non-repo path → resolvable:false (never throws)", nonRepo.resolvable === false && typeof nonRepo.warning === "string");

  // The PURE host rule (single-sourced with the push-time warning) — boundary cases.
  check("(2) commitIdentityHostWarning: null host OR null email → undefined", commitIdentityHostWarning(null, "x@y.com") === undefined && commitIdentityHostWarning("github.com", null) === undefined);
  check("(2) commitIdentityHostWarning: github subdomain still counts as github", typeof commitIdentityHostWarning("gist.github.com", "real@gmail.com") === "string");
  check("(2) originHost: parses scp-shorthand + scheme URLs", originHost("git@github.com:o/r.git") === "github.com" && originHost("https://git.x.example/o/r.git") === "git.x.example");

  // ============ ITEM 2 — end-to-end through the setup surface ============
  // Binding the NO-identity repo surfaces the warning on the project_create result (non-blocking — still created).
  const boundNoId = await call("project_create", { name: "NoIdProj", repoPath: repoNoId });
  check("(2e) project_create: STILL binds a no-identity repo (non-blocking)", !!boundNoId.id && !boundNoId.error && !!db.getProject(boundNoId.id));
  check("(2e) project_create: surfaces an identityWarning for the no-identity repo", typeof boundNoId.identityWarning === "string" && /user\.name|identity/i.test(boundNoId.identityWarning));
  // Binding a clean-local-identity repo → NO identityWarning on the result.
  const boundClean = await call("project_create", { name: "CleanProj", repoPath: repoCleanLocal });
  check("(2e) project_create: NO identityWarning for a repo with a resolvable identity", !!boundClean.id && boundClean.identityWarning === undefined);
  // Binding the self-hosted-mismatch repo → host-rule identityWarning.
  const boundForgejo = await call("project_create", { name: "ForgejoProj", repoPath: repoForgejo });
  check("(2e) project_create: surfaces the host-rule warning (noreply on self-hosted)", typeof boundForgejo.identityWarning === "string" && /self-hosted|unroutable/i.test(boundForgejo.identityWarning));
  // A VAULT-ONLY bind (no repoPath) takes no commits → never an identityWarning, even if the folder is a repo.
  const vaultOnly = await call("project_create", { name: "VaultOnly", vaultPath: repoCleanLocal });
  check("(2e) project_create(vault-only): no identityWarning (notes folder takes no commits)", !!vaultOnly.id && vaultOnly.identityWarning === undefined);

  await client.close();
} finally {
  db.close();
  for (const d of [tmpHome, repoNoId, repoCleanLocal, repoForgejo, repoGithubLeak, repoGithubClean]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — project_update deep-merges (siblings preserved) + project bind asserts a resolvable commit identity (non-blocking warning, reusing the GitHub-vs-Forgejo host rule)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
