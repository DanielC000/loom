import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Platform Manager P3 — the Lead's ELEVATED / human-equivalent surface (mcp/platform.ts), the
// TRUST-BOUNDARY PR. DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic like platform-mgmt-surface.mjs:
// a REAL Db + SessionService driven against a FAKE pty, the REAL PlatformMcpRouter over an in-process MCP
// InMemoryTransport (no HTTP, no external daemon). REAL temp git repos back the git ops (a working repo +
// a local BARE remote so a push genuinely succeeds NON-INTERACTIVELY, pushed NOWHERE real); a REAL temp
// vault dir backs vault_write. The only thing faked is the claude pty.
//
// Proves the DoD:
//   (a) a platform session can set the human-only orchestration.gateCommand/alertWebhook (FULL validator)
//       and an out-of-bounds value is REJECTED (stored config unchanged); the AGENT validator still
//       rejects gateCommand/alertWebhook (the manager/worker path is unchanged);
//   (b) git_checkout/git_create_branch/git_commit against a real temp repo work, and git_push succeeds
//       bounded + non-interactive against a LOCAL bare remote (reusing GitWriter verbatim);
//   (c) vault_write writes under the project vault AND a path-escape is rejected ('traversal');
//   (d) NONE of these elevated tools are reachable by a manager/worker session — resolveRole (the exact
//       predicate handle() 404s on) is null for non-platform roles.
//
// Run: 1) build (turbo builds shared first), 2) node test/platform-elevated-surface.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME (so nothing touches the real ~/.loom or ~/.claude). Set
// BEFORE importing dist (paths.ts reads LOOM_HOME at import time). ---
const tmpHome = path.join(os.tmpdir(), `loom-p3-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv(); // confirm LOOM_HOME is the temp dir (no port — this test runs no HTTP daemon)

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { PlatformMcpRouter, validateAgentProjectConfigOverride, validateProjectConfigOverride } = await import("../dist/mcp/platform.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

// --- a real temp git repo (the project repoPath) + a LOCAL bare remote so git_push has somewhere real-
// but-local to push (NEVER a real remote). Persistent user.name/email so GitWriter.commit (which passes
// NO -c identity override) has an identity to commit under. ---
const repo = path.join(os.tmpdir(), `loom-p3-repo-${Date.now()}`);
const bare = path.join(os.tmpdir(), `loom-p3-bare-${Date.now()}.git`);
fs.mkdirSync(repo, { recursive: true });
execSync("git init -q", { cwd: repo });
execSync("git config user.email p3@loom && git config user.name p3", { cwd: repo });
fs.writeFileSync(path.join(repo, "README.md"), "# platform P3 test repo\n");
execSync("git add . && git commit -q -m init", { cwd: repo });
execSync(`git init --bare -q "${bare}"`, { cwd: os.tmpdir() });
execSync(`git remote add origin "${bare}"`, { cwd: repo }); // local bare remote — push target

// --- a real temp VAULT dir (the project vaultPath), git-init'd so vault_write's commit path is exercised.
const vault = path.join(os.tmpdir(), `loom-p3-vault-${Date.now()}`);
const outside = path.join(os.tmpdir(), `loom-p3-outside-${Date.now()}`); // path-escape target (must stay empty)
const freshVault = path.join(os.tmpdir(), `loom-p3-fresh-vault-${Date.now()}`); // (c2) — deliberately NOT created here
fs.mkdirSync(vault, { recursive: true });
fs.mkdirSync(outside, { recursive: true });
execSync("git init -q && git config user.email p3@loom && git config user.name p3", { cwd: vault });

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pOrd", name: "Ordinary", repoPath: repo, vaultPath: vault, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertAgent({ id: "agentWork", projectId: "pOrd", name: "Work", startupPrompt: "WORK", position: 0, profileId: null });
// One session per role (the role-gate fixtures) — bound to pOrd/agentWork.
const seedSession = (id, role, parent) => db.insertSession({
  id, projectId: "pOrd", agentId: "agentWork", engineSessionId: null, title: null, cwd: repo,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
  role, parentSessionId: parent ?? null,
});
seedSession("PL", "platform", null);
seedSession("M", "manager", null);
seedSession("W", "worker", "M");
seedSession("P", null, null);

// Fake pty (the router needs a SessionService, but no elevated tool spawns — kept for construction parity).
class SeamHost extends PtyHost {
  constructor(events) { super(events); this.spawned = []; this.stopped = []; }
  createPty(opts) { this.spawned.push(opts); return { pid: 4242, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} }; }
  stop(id, mode) { this.stopped.push({ id, mode }); }
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());
const router = new PlatformMcpRouter(db, svc); // 2-arg: GitWriter falls back to its bounded module-const defaults

const parse = (res) => JSON.parse(res.content[0].text);

try {
  // ===================== (d) ROLE GATE — resolveRole is the predicate handle() 404s on =====================
  check("(d) platform session PL HAS the elevated surface (resolveRole truthy)", !!router.resolveRole("PL"));
  check("(d) manager session M gets NO surface (resolveRole null → no elevated tools)", router.resolveRole("M") === null);
  check("(d) worker session W gets NO surface (resolveRole null → no elevated tools)", router.resolveRole("W") === null);
  check("(d) plain session P gets NO surface (resolveRole null)", router.resolveRole("P") === null);

  // --- Connect a REAL MCP client to the router's tool server over an in-memory transport (no HTTP).
  const server = router.buildServer();
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "platform-p3-test", version: "0" });
  await client.connect(clientT);
  const call = async (name, args) => parse(await client.callTool({ name, arguments: args }));

  // 0) Surface: every P3 elevated tool is registered.
  const tools = (await client.listTools()).tools.map((t) => t.name);
  const elevated = ["git_checkout", "git_create_branch", "git_commit", "git_push", "vault_write"];
  check(`(d) surface includes all P3 elevated tools (missing: ${elevated.filter((t) => !tools.includes(t)).join(",") || "none"})`,
    elevated.every((t) => tools.includes(t)));

  // ===================== (a) ELEVATED CONFIG — gateCommand/alertWebhook via the FULL validator =====================
  const elevatedCfg = {
    orchestration: {
      gateCommand: "pnpm build && pnpm test",
      gateCommandTimeoutMs: 60000,
      alertWebhook: { url: "https://example.com/hook", events: ["worker_done"] },
      alertWebhookTimeoutMs: 5000,
    },
  };
  const setCfg = await call("project_configure", { projectId: "pOrd", config: elevatedCfg });
  check("(a) project_configure ACCEPTS gateCommand/alertWebhook (full validator, platform role)", setCfg.ok === true && !setCfg.error);
  const storedCfg = db.getProject("pOrd").config;
  check("(a) the elevated keys persisted to the project config",
    storedCfg.orchestration?.gateCommand === "pnpm build && pnpm test" &&
    storedCfg.orchestration?.alertWebhook?.url === "https://example.com/hook" &&
    storedCfg.orchestration?.gateCommandTimeoutMs === 60000);

  // Out-of-bounds value REJECTED (same bounds the human REST PATCH path applies), stored config unchanged.
  const badTimeout = await call("project_configure", { projectId: "pOrd", config: { orchestration: { gateCommand: "x", gateCommandTimeoutMs: 999 } } });
  check("(a) an out-of-bounds gateCommandTimeoutMs (<1000) is REJECTED", typeof badTimeout.error === "string" && !badTimeout.ok);
  const badWebhook = await call("project_configure", { projectId: "pOrd", config: { orchestration: { alertWebhook: { url: "not-a-url", events: [] } } } });
  check("(a) a non-URL alertWebhook is REJECTED", typeof badWebhook.error === "string" && !badWebhook.ok);
  check("(a) a rejected configure left the stored config UNCHANGED",
    db.getProject("pOrd").config.orchestration?.gateCommand === "pnpm build && pnpm test");

  // The AGENT/manager validator is UNCHANGED — it still rejects the human-only keys (DoD: bypass keyed
  // strictly to the platform route; the agent/manager path never widened).
  check("(a) validateAgentProjectConfigOverride STILL rejects gateCommand (agent path unchanged)",
    validateAgentProjectConfigOverride({ orchestration: { gateCommand: "calc.exe" } }).ok === false);
  check("(a) validateAgentProjectConfigOverride STILL rejects alertWebhook (agent path unchanged)",
    validateAgentProjectConfigOverride({ orchestration: { alertWebhook: { url: "https://e.com", events: [] } } }).ok === false);
  check("(a) validateProjectConfigOverride (full/human) ACCEPTS gateCommand", validateProjectConfigOverride({ orchestration: { gateCommand: "x" } }).ok === true);

  // ===================== (b) GIT WRITES — reuse GitWriter verbatim, real temp repo + local bare remote =====================
  const mkBranch = await call("git_create_branch", { projectId: "pOrd", name: "feat" });
  check("(b) git_create_branch creates + switches to a new branch", mkBranch.ok === true && mkBranch.branch === "feat");
  fs.writeFileSync(path.join(repo, "new.txt"), "elevated change\n");
  const commit = await call("git_commit", { projectId: "pOrd", message: "add new.txt via platform" });
  check("(b) git_commit stages + commits, returns a hash", commit.ok === true && typeof commit.hash === "string" && commit.hash.length > 0);
  const cleanCommit = await call("git_commit", { projectId: "pOrd", message: "noop" });
  check("(b) git_commit on a CLEAN tree is an expected no-op failure (nothing to commit)", cleanCommit.ok === false && /nothing to commit/i.test(cleanCommit.error));
  const push = await call("git_push", { projectId: "pOrd" });
  check("(b) git_push succeeds bounded + non-interactive against the LOCAL bare remote (set-upstream)", push.ok === true && push.branch === "feat");
  check("(b) the commit actually reached the bare remote (ref feat exists)",
    execSync(`git --git-dir="${bare}" rev-parse --verify refs/heads/feat`, { encoding: "utf8" }).trim().length === 40);
  const mkBranch2 = await call("git_create_branch", { projectId: "pOrd", name: "feat2" });
  check("(b) git_create_branch a second branch (now on feat2)", mkBranch2.ok === true && mkBranch2.branch === "feat2");
  const checkout = await call("git_checkout", { projectId: "pOrd", branch: "feat" });
  check("(b) git_checkout switches back to an existing branch", checkout.ok === true && checkout.branch === "feat");
  const checkoutGhost = await call("git_checkout", { projectId: "pOrd", branch: "no-such-branch" });
  check("(b) git_checkout an unknown branch fails (structured, not a throw)", checkoutGhost.ok === false && typeof checkoutGhost.error === "string");
  check("(b) a git tool on an unknown project 404s", (await call("git_commit", { projectId: "ghost", message: "x" })).error === "project not found");

  // ===================== (c) VAULT WRITE — reuse writeVaultFile verbatim (path-traversal guard) =====================
  const vw = await call("vault_write", { projectId: "pOrd", path: "notes/hello.md", content: "# hello\nfrom the platform lead\n" });
  check("(c) vault_write writes a file under the vault", vw.ok === true);
  check("(c) the file exists on disk with the written content",
    fs.existsSync(path.join(vault, "notes", "hello.md")) &&
    fs.readFileSync(path.join(vault, "notes", "hello.md"), "utf8").includes("from the platform lead"));
  const vwOver = await call("vault_write", { projectId: "pOrd", path: "notes/hello.md", content: "# hello\nedited\n" });
  check("(c) vault_write overwrites an existing file", vwOver.ok === true && fs.readFileSync(path.join(vault, "notes", "hello.md"), "utf8").includes("edited"));
  const vwEscape = await call("vault_write", { projectId: "pOrd", path: "../" + path.basename(outside) + "/evil.md", content: "PWNED" });
  check("(c) vault_write REJECTS a path escape ('..') with reason 'traversal'", vwEscape.ok === false && vwEscape.reason === "traversal");
  check("(c) the path-escape wrote NOTHING outside the vault", !fs.existsSync(path.join(outside, "evil.md")));
  const vwAbs = await call("vault_write", { projectId: "pOrd", path: path.join(outside, "abs-evil.md"), content: "PWNED" });
  check("(c) vault_write REJECTS an absolute path escape", vwAbs.ok === false && vwAbs.reason === "traversal" && !fs.existsSync(path.join(outside, "abs-evil.md")));
  check("(c) vault_write on an unknown project 404s", (await call("vault_write", { projectId: "ghost", path: "a.md", content: "x" })).error === "project not found");

  // ===== (c2) vault_write against a project whose vaultPath doesn't exist on disk yet — a freshly
  //       bound project. This must SCAFFOLD the root and write, not misreport 'traversal' (the bug this
  //       fixes: a security-flavored reason was returned for a merely-uncreated vault root). A genuine
  //       escape attempt against that same missing root must still be rejected as 'traversal'. =====
  db.insertProject({ id: "pFresh", name: "Fresh", repoPath: repo, vaultPath: freshVault, config: {}, createdAt: now, archivedAt: null, reserved: false });
  check("(c2) the fresh project's vaultPath does not exist yet", !fs.existsSync(freshVault));
  const vwFresh = await call("vault_write", { projectId: "pFresh", path: "notes/hello.md", content: "hello from a fresh vault\n" });
  check("(c2) vault_write on a missing vault root SUCCEEDS (scaffolded, not 'traversal')", vwFresh.ok === true);
  check("(c2) the vault root now exists on disk",
    fs.existsSync(freshVault) && fs.readFileSync(path.join(freshVault, "notes", "hello.md"), "utf8").includes("hello from a fresh vault"));
  const vwFreshEscape = await call("vault_write", { projectId: "pFresh", path: "../" + path.basename(outside) + "/evil-fresh.md", content: "PWNED" });
  check("(c2) an escape attempt against a MISSING vault root is still rejected as 'traversal'",
    vwFreshEscape.ok === false && vwFreshEscape.reason === "traversal");
  check("(c2) the escape wrote nothing outside", !fs.existsSync(path.join(outside, "evil-fresh.md")));

  await client.close();
} finally {
  db.close();
  for (const d of [tmpHome, repo, bare, vault, outside, freshVault]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the platform P3 ELEVATED surface works for a platform session (gateCommand/alertWebhook via the FULL validator, bounded; git checkout/create-branch/commit/push reusing GitWriter against a real repo + local bare remote; vault_write reusing writeVaultFile with the path-traversal guard), the agent/manager validator is unchanged (still rejects gateCommand/alertWebhook), and the role gate holds (manager/worker → no elevated surface) — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
