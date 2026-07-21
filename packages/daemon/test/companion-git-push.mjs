import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Companion Capability & Permission-Lever Framework — `git-push`, the deferred "Option C" git commit+push
// lever (card a3c3ade8 Increment 1 / card 550d2add Increment 2, which added the "repo" target below). Two
// tools sharing ONE capability slug/pending-map namespace: `git_commit` (Tier A — flows inside a warm
// session-trust window, cold ⇒ one step-up, message defaults to requiring Primitive B unless the project's
// grant sets authoredContent:true) and `git_push` (Tier X — ALWAYS steps up, even inside an otherwise-warm
// window, mirroring board_relocate/session_spawn's dead-branch-guarded shape). The repo path is ALWAYS
// daemon-resolved from `project`+`target` — the agent never supplies a path. `target:"vault"` resolves to
// the vault's GOVERNING repo root (never the raw vaultPath — a vault may be a subfolder of a larger repo),
// refusing (never auto-initing) when the vault has no repo yet or is Obsidian-Git-managed. `target:"repo"`
// resolves to `project.repoPath` directly (mirrors mcp/platform.ts's `gitWriterFor(p.repoPath)` verbatim).
//
// UNLIKE companion-session-spawn.mjs/companion-board-relocate.mjs, this lever's backing op is REAL git —
// GitWriter is NOT mocked. Every vaultPath/repoPath here is a REAL temp git repo, so this test exercises
// real git commit/push end-to-end (mirrors test/git-writer.mjs's own real-git style), driven through a
// FAKE pty (getActiveTurnOwnerText/getActiveTurnOrigin/getActiveTurnSenderId) and a FAKE companion
// (deliverReply). NO network (the "remote" is a local bare repo), NO real claude, NO daemon.
//
// Covers the card's DoD:
//   - no grant / read-only grant ⇒ both tools absent (act-only + hasActGrant)
//   - targets allowlist: act grant with NO targets configured ⇒ tools present but target rejected;
//     targets:["vault"] ⇒ vault target accepted, repo target rejected; targets:["repo"] ⇒ the reverse
//   - resolution: vault IS the repo root; vault is a SUBFOLDER of a larger repo (commits at the governing
//     ROOT, never a nested repo); Obsidian-Git-managed (refused, never committed); no repo yet (refused,
//     never auto-inited)
//   - repo target: commits/pushes to project.repoPath end-to-end; an unset repoPath is a structured error
//   - content guard: git_commit's message defaults to requiring Primitive B (verbatim owner quote);
//     authoredContent:true relaxes it
//   - Tier A: a cold window steps up once; the step-up ARMS the window; a later git_commit within TTL
//     commits DIRECTLY (no propose/confirm)
//   - Tier X: git_push ALWAYS proposes first, even inside a warm window seeded by git_commit's own step-up;
//     the confirm text discloses the branch, ahead-count, and a BOUNDED latest-commit subject; a repeat
//     with the consumed confirm text does not push twice
//   - token-mismatch is retryable; a propose→confirm payload mismatch (different target) is rejected
//   - Primitive A (no owner text) ⇒ rejected; no reply-to route ⇒ rejected
//   - a clean tree (nothing to commit) surfaces GitWriter's own structured error, never a throw
//   - additive: byte-identical companion surface with no git-push grant
//   - grant/revoke: a live per-request row-read gates BOTH directions — granting registers both tools,
//     and DELETING the grant removes both on the very next buildServer/request (not just the grant path)
// Run: 1) build (turbo builds shared first), 2) node test/companion-git-push.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-companion-git-push-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

async function connect(server) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "companion-git-push-test", version: "0" });
  await client.connect(clientT);
  return client;
}
const listOf = async (server) => { const c = await connect(server); const names = (await c.listTools()).tools.map((t) => t.name); await c.close(); return names; };
const call = async (client, name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

const DEFAULT_ROUTE = { channel: "in-app", chatId: "cockpit" };

function makeFakePty(initialOwnerText, opts = {}) {
  let ownerText = initialOwnerText ?? null;
  const route = opts.route === undefined ? DEFAULT_ROUTE : opts.route;
  return {
    setOwnerText(t) { ownerText = t; },
    getActiveTurnOwnerText() { return ownerText; },
    getActiveTurnOrigin() { return route; },
    getActiveTurnSenderId() { return opts.senderId ?? null; },
    enqueueStdin() { return { delivered: false, reason: "held" }; },
  };
}

function makeFakeCompanion(shouldDeliver = true) {
  const delivered = [];
  return {
    async deliverReply(sessionId, text) {
      delivered.push({ sessionId, text });
      return { delivered: shouldDeliver };
    },
    delivered,
  };
}

function extractToken(deliveredText) {
  const m = /Reply CONFIRM (\S+) to proceed\.$/.exec(deliveredText);
  if (!m) throw new Error(`could not extract a confirm token from: ${deliveredText}`);
  return m[1];
}

const now = new Date().toISOString();
function seedProject(db, id, name, vaultPath, repoPath = id) {
  db.insertProject({ id, name, repoPath, vaultPath, config: {}, createdAt: now, archivedAt: null });
}
function seedSession(db, id, projectId, role) {
  const agentId = `a-${id}`;
  db.insertAgent({ id: agentId, projectId, name: role, startupPrompt: "", position: 0 });
  db.insertSession({
    id, projectId, agentId, engineSessionId: `eng-${id}`, title: null, cwd: projectId,
    processState: "live", resumability: "resumable", busy: false,
    createdAt: now, lastActivity: now, lastError: null, role,
  });
}
const tmpDb = () => new Db(path.join(tmpHome, `${randomUUID()}.db`));

// --- Real git fixtures (mirrors test/git-writer.mjs's own style) ---
const fixturesRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "loom-git-push-fixtures-")));
const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();

/** A real, identity-configured git repo at `dir` with one seed commit. */
function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init");
  git(dir, "checkout", "-b", "main");
  git(dir, "config", "user.email", "loom-test@example.com");
  git(dir, "config", "user.name", "loom-test");
  git(dir, "config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(dir, "seed.md"), "# seed\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "seed");
  return dir;
}

/** Adds a bare "remote" + sets up tracking so `push()` (plain, no -u) succeeds. */
function addRemote(dir, remoteName = "origin") {
  const bare = path.join(fixturesRoot, `${path.basename(dir)}-remote-${randomUUID()}.git`);
  execFileSync("git", ["init", "--bare", bare], { stdio: ["ignore", "pipe", "pipe"] });
  git(dir, "remote", "add", remoteName, bare);
  git(dir, "push", "-u", remoteName, "main");
  return bare;
}

try {
  // ============ no grant ⇒ both tools absent ============
  {
    const db = tmpDb();
    const vault = initRepo(path.join(fixturesRoot, "nogrant-vault"));
    const proj = "proj-nogrant";
    seedProject(db, proj, "No grant", vault);
    const companionSess = "companion-nogrant";
    seedSession(db, companionSess, proj, "assistant");
    const orch = new OrchestrationMcpRouter(db, {}, {}, makeFakePty(null));
    const tools = await listOf(orch.buildServer(companionSess, "assistant"));
    check("no grant: git_commit is NOT registered", !tools.includes("git_commit"));
    check("no grant: git_push is NOT registered", !tools.includes("git_push"));
    db.close();
  }

  // ============ read-only grant ⇒ both tools absent (act-only + hasActGrant) ============
  {
    const db = tmpDb();
    const vault = initRepo(path.join(fixturesRoot, "readonly-vault"));
    const proj = "proj-readonly";
    seedProject(db, proj, "Read-only", vault);
    const companionSess = "companion-readonly";
    seedSession(db, companionSess, proj, "assistant");
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "git-push", projectId: proj, mode: "read" });
    const orch = new OrchestrationMcpRouter(db, {}, {}, makeFakePty(null));
    const tools = await listOf(orch.buildServer(companionSess, "assistant"));
    check("read-only grant: git_commit is NOT registered", !tools.includes("git_commit"));
    check("read-only grant: git_push is NOT registered", !tools.includes("git_push"));
    db.close();
  }

  // ============ act grant, NO targets configured ⇒ tools present but target rejected ============
  {
    const db = tmpDb();
    const vault = initRepo(path.join(fixturesRoot, "notargets-vault"));
    const proj = "proj-notargets";
    seedProject(db, proj, "No targets", vault);
    const companionSess = "companion-notargets";
    seedSession(db, companionSess, proj, "assistant");
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "git-push", projectId: proj, mode: "act" });
    const pty = makeFakePty('the owner said: commit with message "notargets test"');
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));
    const tools = (await client.listTools()).tools.map((t) => t.name);
    check("act grant (no targets config): git_commit IS registered", tools.includes("git_commit"));
    check("act grant (no targets config): git_push IS registered", tools.includes("git_push"));
    const res = await call(client, "git_commit", { project: proj, target: "vault", message: "notargets test" });
    check("no targets allowed: git_commit rejected with an {error}", typeof res.error === "string" && res.status === undefined);
    check("no targets allowed: nothing delivered to the owner", companion.delivered.length === 0);
    const resPush = await call(client, "git_push", { project: proj, target: "vault" });
    check("no targets allowed: git_push rejected with an {error} too", typeof resPush.error === "string" && resPush.status === undefined);
    await client.close();
    db.close();
  }

  // ============ resolution: vault has NO git repo yet ⇒ refused, never auto-inits ============
  {
    const db = tmpDb();
    const bareVaultDir = path.join(fixturesRoot, "norepo-vault");
    fs.mkdirSync(bareVaultDir, { recursive: true }); // exists on disk, but never `git init`ed
    const proj = "proj-norepo";
    seedProject(db, proj, "No repo", bareVaultDir);
    const companionSess = "companion-norepo";
    seedSession(db, companionSess, proj, "assistant");
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "git-push", projectId: proj, mode: "act", config: { targets: ["vault"] } });
    const pty = makeFakePty('the owner said: commit with message "should not happen"');
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));
    const res = await call(client, "git_commit", { project: proj, target: "vault", message: "should not happen" });
    check("no repo yet: rejected with an {error}", typeof res.error === "string" && res.status === undefined);
    check("no repo yet: error names the missing repo", /no git repository/i.test(res.error));
    check("no repo yet: NEVER auto-inited a repo", !fs.existsSync(path.join(bareVaultDir, ".git")));
    check("no repo yet: nothing delivered to the owner", companion.delivered.length === 0);
    await client.close();
    db.close();
  }

  // ============ resolution: vault is Obsidian-Git-managed ⇒ refused, never committed ============
  {
    const db = tmpDb();
    const vault = initRepo(path.join(fixturesRoot, "obsidian-vault"));
    fs.mkdirSync(path.join(vault, ".obsidian", "plugins", "obsidian-git"), { recursive: true });
    const proj = "proj-obsidiangit";
    seedProject(db, proj, "Obsidian-Git managed", vault);
    const companionSess = "companion-obsidiangit";
    seedSession(db, companionSess, proj, "assistant");
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "git-push", projectId: proj, mode: "act", config: { targets: ["vault"] } });
    const pty = makeFakePty('the owner said: commit with message "should not happen either"');
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));
    const before = git(vault, "log", "--pretty=%H");
    const res = await call(client, "git_commit", { project: proj, target: "vault", message: "should not happen either" });
    check("obsidian-git managed: rejected with an {error}", typeof res.error === "string" && res.status === undefined);
    check("obsidian-git managed: error names the Obsidian Git plugin", /obsidian git/i.test(res.error));
    check("obsidian-git managed: history is UNCHANGED (no commit landed)", git(vault, "log", "--pretty=%H") === before);
    await client.close();
    db.close();
  }

  // ============ resolution: vault is a SUBFOLDER of a larger plain repo ⇒ commits at the governing ROOT ============
  {
    const db = tmpDb();
    const outerRepo = initRepo(path.join(fixturesRoot, "subfolder-outer"));
    const vaultSubfolder = path.join(outerRepo, "notes", "myproject");
    fs.mkdirSync(vaultSubfolder, { recursive: true });
    fs.writeFileSync(path.join(vaultSubfolder, "readme.md"), "# subfolder vault\n");
    const proj = "proj-subfolder";
    seedProject(db, proj, "Subfolder vault", vaultSubfolder);
    const companionSess = "companion-subfolder";
    seedSession(db, companionSess, proj, "assistant");
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "git-push", projectId: proj, mode: "act", config: { targets: ["vault"], authoredContent: true } });
    const pty = makeFakePty("the owner said: commit my vault");
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));
    const res = await call(client, "git_commit", { project: proj, target: "vault", message: "add subfolder readme" });
    // Cold window ⇒ proposes first (authoredContent:true only relaxes Primitive B, not the tier).
    check("subfolder: propose succeeds", res.status === "proposed");
    const token = extractToken(companion.delivered[0].text);
    pty.setOwnerText(`CONFIRM ${token}`);
    const confirmed = await call(client, "git_commit", { project: proj, target: "vault", message: "add subfolder readme" });
    check("subfolder: confirm commits", confirmed.status === "committed" && typeof confirmed.hash === "string");
    check("subfolder: commit landed at the OUTER repo root", git(outerRepo, "log", "--pretty=%s").includes("add subfolder readme"));
    check("subfolder: NO nested .git was created inside the vault subfolder", !fs.existsSync(path.join(vaultSubfolder, ".git")));
    await client.close();
    db.close();
  }

  // ============ Primitive A: no owner text (proactive/heartbeat turn) ⇒ rejected, both tools ============
  {
    const db = tmpDb();
    const vault = initRepo(path.join(fixturesRoot, "proactive-vault"));
    const proj = "proj-proactive";
    seedProject(db, proj, "Proactive", vault);
    const companionSess = "companion-proactive";
    seedSession(db, companionSess, proj, "assistant");
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "git-push", projectId: proj, mode: "act", config: { targets: ["vault"] } });
    const pty = makeFakePty(null);
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));
    const resCommit = await call(client, "git_commit", { project: proj, target: "vault", message: "x" });
    check("proactive turn: git_commit rejected with an {error}", typeof resCommit.error === "string" && resCommit.status === undefined);
    const resPush = await call(client, "git_push", { project: proj, target: "vault" });
    check("proactive turn: git_push rejected with an {error}", typeof resPush.error === "string" && resPush.status === undefined);
    check("proactive turn: nothing delivered to the owner", companion.delivered.length === 0);
    await client.close();
    db.close();
  }

  // ============ no reply-to route ⇒ fail closed, both tools ============
  {
    const db = tmpDb();
    const vault = initRepo(path.join(fixturesRoot, "noroute-vault"));
    const proj = "proj-noroute";
    seedProject(db, proj, "No route", vault);
    const companionSess = "companion-noroute";
    seedSession(db, companionSess, proj, "assistant");
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "git-push", projectId: proj, mode: "act", config: { targets: ["vault"] } });
    const pty = makeFakePty("the owner said: commit", { route: null });
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));
    const resCommit = await call(client, "git_commit", { project: proj, target: "vault", message: "x" });
    check("no route: git_commit rejected with an {error}", typeof resCommit.error === "string" && resCommit.status === undefined);
    const resPush = await call(client, "git_push", { project: proj, target: "vault" });
    check("no route: git_push rejected with an {error}", typeof resPush.error === "string" && resPush.status === undefined);
    check("no route: NO delivery was even attempted", companion.delivered.length === 0);
    await client.close();
    db.close();
  }

  // ============ content guard: default requires Primitive B (verbatim); non-verbatim rejected ============
  {
    const db = tmpDb();
    const vault = initRepo(path.join(fixturesRoot, "verbatim-vault"));
    const proj = "proj-verbatim";
    seedProject(db, proj, "Verbatim required", vault);
    const companionSess = "companion-verbatim";
    seedSession(db, companionSess, proj, "assistant");
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "git-push", projectId: proj, mode: "act", config: { targets: ["vault"] } }); // authoredContent OFF (default)
    const pty = makeFakePty("the owner said: please commit my vault");
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));
    const res = await call(client, "git_commit", { project: proj, target: "vault", message: "a message the owner never said" });
    check("non-verbatim message (authoredContent off): rejected with an {error}", typeof res.error === "string" && res.status === undefined);
    check("non-verbatim message: mentions verbatim/authoredContent in the error", /verbatim|authoredContent/i.test(res.error));
    check("non-verbatim message: nothing delivered to the owner (rejected before Primitive C)", companion.delivered.length === 0);
    await client.close();
    db.close();
  }

  // ============ content guard: authoredContent:true lets the companion author the message ============
  {
    const db = tmpDb();
    const vault = initRepo(path.join(fixturesRoot, "authored-vault"));
    const proj = "proj-authored";
    seedProject(db, proj, "Authored content allowed", vault);
    const companionSess = "companion-authored";
    seedSession(db, companionSess, proj, "assistant");
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "git-push", projectId: proj, mode: "act", config: { targets: ["vault"], authoredContent: true } });
    const pty = makeFakePty("the owner said: commit my vault");
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));
    fs.writeFileSync(path.join(vault, "authored.md"), "# authored\n");
    const res = await call(client, "git_commit", { project: proj, target: "vault", message: "an authored commit message the owner never dictated" });
    check("authoredContent:true: propose succeeds even with a non-verbatim message", res.status === "proposed");
    const token = extractToken(companion.delivered[0].text);
    pty.setOwnerText(`CONFIRM ${token}`);
    const confirmed = await call(client, "git_commit", { project: proj, target: "vault", message: "an authored commit message the owner never dictated" });
    check("authoredContent:true: confirm commits the authored message", confirmed.status === "committed");
    check("authoredContent:true: the authored message actually landed in history",
      git(vault, "log", "-1", "--pretty=%s").trim() === "an authored commit message the owner never dictated");
    await client.close();
    db.close();
  }

  // ============ Tier A: cold window steps up once; the step-up ARMS it; a later commit is DIRECT ============
  // ============ Tier X: git_push ALWAYS proposes first, even in the now-warm window ============
  {
    const db = tmpDb();
    const vault = initRepo(path.join(fixturesRoot, "tiera-vault"));
    const remote = addRemote(vault);
    const proj = "proj-tiera";
    seedProject(db, proj, "Tier A / Tier X", vault);
    const companionSess = "companion-tiera";
    seedSession(db, companionSess, proj, "assistant");
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "git-push", projectId: proj, mode: "act", config: { targets: ["vault"] } });
    const pty = makeFakePty('the owner said: commit with message "first commit via companion"');
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    fs.writeFileSync(path.join(vault, "one.md"), "# one\n");
    const proposed = await call(client, "git_commit", { project: proj, target: "vault", message: "first commit via companion" });
    check("cold window: git_commit proposes (no direct commit)", proposed.status === "proposed");
    check("cold window: nothing committed yet", git(vault, "log", "--pretty=%s").includes("first commit via companion") === false);
    const token = extractToken(companion.delivered[0].text);
    pty.setOwnerText(`CONFIRM ${token}`);
    const committed = await call(client, "git_commit", { project: proj, target: "vault", message: "first commit via companion" });
    check("cold window confirm: commits and returns a real hash", committed.status === "committed" && /^[0-9a-f]{7,40}$/.test(committed.hash ?? ""));
    check("cold window confirm: landed in real git history", git(vault, "log", "--pretty=%s").includes("first commit via companion"));

    // The step-up ARMED the trust window — a SECOND git_commit within the TTL commits DIRECTLY.
    fs.writeFileSync(path.join(vault, "two.md"), "# two\n");
    pty.setOwnerText('the owner said: commit again with message "second commit, warm window"');
    const direct = await call(client, "git_commit", { project: proj, target: "vault", message: "second commit, warm window" });
    check("warm window: SECOND git_commit commits DIRECTLY (no propose)", direct.status === "committed");
    check("warm window: still only ONE message delivered to the owner (no second confirm prompt)", companion.delivered.length === 1);
    check("warm window: the direct commit really landed", git(vault, "log", "-1", "--pretty=%s").trim() === "second commit, warm window");

    // git_push: Tier X ALWAYS proposes, even though the window is warm from the git_commit step-up above.
    pty.setOwnerText("the owner said: now push it");
    const pushProposed = await call(client, "git_push", { project: proj, target: "vault" });
    check("Tier X even-in-warm-window: git_push proposes, does NOT push", pushProposed.status === "proposed" && Object.keys(pushProposed).length === 2);
    check("Tier X even-in-warm-window: NO promptText/token returned to the companion", pushProposed.promptText === undefined && pushProposed.token === undefined);
    const pushPromptText = companion.delivered.at(-1).text;
    check("push confirm text names the project + target", pushPromptText.includes("Tier A / Tier X") && pushPromptText.includes("vault"));
    check("push confirm text discloses an ahead-count", /\d+ commit\(s\) ahead/.test(pushPromptText));
    check("push confirm text discloses the LATEST commit's subject (bounded disclosure)", pushPromptText.includes("second commit, warm window"));
    check("nothing pushed to the remote yet", execFileSync("git", ["--git-dir", remote, "log", "main", "--pretty=%s"], { stdio: ["ignore", "pipe", "pipe"] }).toString().includes("second commit, warm window") === false);

    const pushToken = extractToken(pushPromptText);
    pty.setOwnerText(`CONFIRM ${pushToken}`);
    const pushed = await call(client, "git_push", { project: proj, target: "vault" });
    check("push confirm: returns status:'pushed'", pushed.status === "pushed" && pushed.branch === "main");
    const remoteLog = execFileSync("git", ["--git-dir", remote, "log", "main", "--pretty=%s"], { stdio: ["ignore", "pipe", "pipe"] }).toString();
    check("push confirm: BOTH commits actually reached the remote", remoteLog.includes("first commit via companion") && remoteLog.includes("second commit, warm window"));
    // Tier X must NEVER arm/extend the trust window on commit.
    check("push confirm: does not deliver a second owner message", companion.delivered.length === 2);

    // A repeat call with the SAME (now-consumed) confirm text must NOT push again.
    const repeat = await call(client, "git_push", { project: proj, target: "vault" });
    check("exactly-once: a repeat push call with the same confirm text does not push twice", repeat.status !== "pushed");

    await client.close();
    db.close();
  }

  // ============ token-mismatch is RETRYABLE (leaves the pending proposal standing) ============
  {
    const db = tmpDb();
    const vault = initRepo(path.join(fixturesRoot, "tokenmismatch-vault"));
    addRemote(vault);
    const proj = "proj-tokenmismatch";
    seedProject(db, proj, "Token mismatch", vault);
    const companionSess = "companion-tokenmismatch";
    seedSession(db, companionSess, proj, "assistant");
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "git-push", projectId: proj, mode: "act", config: { targets: ["vault"] } });
    const pty = makeFakePty("the owner said: push it");
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    const proposed = await call(client, "git_push", { project: proj, target: "vault" });
    check("token-mismatch setup: propose succeeds", proposed.status === "proposed");

    pty.setOwnerText("CONFIRM GUESSED-WRONG");
    const guessed = await call(client, "git_push", { project: proj, target: "vault" });
    check("token-mismatch: reports status:'confirm-mismatch'", guessed.status === "confirm-mismatch");
    check("token-mismatch: nothing pushed", guessed.status !== "pushed");

    const realToken = extractToken(companion.delivered[0].text);
    pty.setOwnerText(`CONFIRM ${realToken}`);
    const confirmed = await call(client, "git_push", { project: proj, target: "vault" });
    check("token-mismatch: the REAL token still commits afterward", confirmed.status === "pushed");

    await client.close();
    db.close();
  }

  // ============ propose→confirm payload mismatch (different target) is rejected ============
  // (INCREMENT 1 has only one valid target, so this proves the payload-match discriminator using a
  // per-project SWAP — the confirm targets a DIFFERENT project's pending git-push than what it names.)
  {
    const db = tmpDb();
    const vaultA = initRepo(path.join(fixturesRoot, "mismatch-a-vault"));
    const vaultB = initRepo(path.join(fixturesRoot, "mismatch-b-vault"));
    const projA = "proj-mismatch-a";
    const projB = "proj-mismatch-b";
    seedProject(db, projA, "Mismatch A", vaultA);
    seedProject(db, projB, "Mismatch B", vaultB);
    const companionSess = "companion-mismatch";
    seedSession(db, companionSess, projA, "assistant");
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "git-push", projectId: projA, mode: "act", config: { targets: ["vault"] } });
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "git-push", projectId: projB, mode: "act", config: { targets: ["vault"] } });
    const pty = makeFakePty('the owner said: commit A with message "commit for A"');
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    fs.writeFileSync(path.join(vaultA, "a.md"), "# a\n");
    const proposed = await call(client, "git_commit", { project: projA, target: "vault", message: "commit for A" });
    check("mismatch setup: propose (project A) succeeds", proposed.status === "proposed");
    const token = extractToken(companion.delivered[0].text);
    pty.setOwnerText(`CONFIRM ${token}`);

    // Confirm attempted against project B — the token is real (same route), but the payload was proposed
    // for A, not B.
    const swapped = await call(client, "git_commit", { project: projB, target: "vault", message: "commit for A" });
    check("mismatch (project swapped): does NOT commit", swapped.status !== "committed");
    check("mismatch (project swapped): B's history is untouched", git(vaultB, "log", "--pretty=%s").includes("commit for A") === false);

    // Single-use: the token was consumed by the mismatched attempt — a repeat with the ORIGINAL (correct)
    // args does not commit either.
    const repeat = await call(client, "git_commit", { project: projA, target: "vault", message: "commit for A" });
    check("mismatch: token is single-use — a repeat with the original args does not commit either", repeat.status !== "committed");

    await client.close();
    db.close();
  }

  // ============ a clean tree (nothing to commit) surfaces GitWriter's own structured error ============
  {
    const db = tmpDb();
    const vault = initRepo(path.join(fixturesRoot, "cleantree-vault"));
    const proj = "proj-cleantree";
    seedProject(db, proj, "Clean tree", vault);
    const companionSess = "companion-cleantree";
    seedSession(db, companionSess, proj, "assistant");
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "git-push", projectId: proj, mode: "act", config: { targets: ["vault"], authoredContent: true } });
    const pty = makeFakePty("the owner said: commit my vault");
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    // No file changes since the seed commit — the working tree is clean.
    const proposed = await call(client, "git_commit", { project: proj, target: "vault", message: "nothing changed" });
    check("clean tree setup: propose succeeds", proposed.status === "proposed");
    const token = extractToken(companion.delivered[0].text);
    pty.setOwnerText(`CONFIRM ${token}`);
    const res = await call(client, "git_commit", { project: proj, target: "vault", message: "nothing changed" });
    check("clean tree: rejected with GitWriter's own structured error, not a throw/hang", typeof res.error === "string");
    check("clean tree: the error names the clean-tree condition", /nothing to commit/i.test(res.error));

    await client.close();
    db.close();
  }

  // ============ a failed outbound delivery ⇒ fail closed ============
  {
    const db = tmpDb();
    const vault = initRepo(path.join(fixturesRoot, "faildelivery-vault"));
    const proj = "proj-faildelivery";
    seedProject(db, proj, "Fail delivery", vault);
    const companionSess = "companion-faildelivery";
    seedSession(db, companionSess, proj, "assistant");
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "git-push", projectId: proj, mode: "act", config: { targets: ["vault"] } });
    const pty = makeFakePty('the owner said: commit with message "x"');
    const companion = makeFakeCompanion(false); // simulate no-adapter / send-failed
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));
    const res = await call(client, "git_commit", { project: proj, target: "vault", message: "x" });
    check("failed delivery: rejected with an {error}", typeof res.error === "string" && res.status === undefined);
    check("failed delivery: nothing committed", git(vault, "log", "--pretty=%s").includes("x\n") === false);
    await client.close();
    db.close();
  }

  // ============ repo target: end-to-end commit + push against project.repoPath ============
  {
    const db = tmpDb();
    const repo = initRepo(path.join(fixturesRoot, "repo-target-repo"));
    const remote = addRemote(repo);
    const proj = "proj-repotarget";
    seedProject(db, proj, "Repo target", "/does/not/matter/vault", repo);
    const companionSess = "companion-repotarget";
    seedSession(db, companionSess, proj, "assistant");
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "git-push", projectId: proj, mode: "act", config: { targets: ["repo"], authoredContent: true } });
    const pty = makeFakePty("the owner said: commit and push the repo");
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    fs.writeFileSync(path.join(repo, "code.txt"), "change\n");
    const proposed = await call(client, "git_commit", { project: proj, target: "repo", message: "repo target commit" });
    check("repo target: propose succeeds (cold window)", proposed.status === "proposed");
    const token = extractToken(companion.delivered[0].text);
    pty.setOwnerText(`CONFIRM ${token}`);
    const committed = await call(client, "git_commit", { project: proj, target: "repo", message: "repo target commit" });
    check("repo target: confirm commits with a real hash", committed.status === "committed" && typeof committed.hash === "string");
    check("repo target: commit landed in the PROJECT'S repo (repoPath), not any vault", git(repo, "log", "--pretty=%s").includes("repo target commit"));

    pty.setOwnerText("the owner said: now push it");
    const pushProposed = await call(client, "git_push", { project: proj, target: "repo" });
    check("repo target: git_push proposes (Tier X, even after the commit's own step-up)", pushProposed.status === "proposed");
    const pushPromptText = companion.delivered.at(-1).text;
    check("repo target: push confirm text names the target", pushPromptText.includes("repo"));
    const pushToken = extractToken(pushPromptText);
    pty.setOwnerText(`CONFIRM ${pushToken}`);
    const pushed = await call(client, "git_push", { project: proj, target: "repo" });
    check("repo target: push confirm returns status:'pushed'", pushed.status === "pushed");
    const remoteLog = execFileSync("git", ["--git-dir", remote, "log", "main", "--pretty=%s"], { stdio: ["ignore", "pipe", "pipe"] }).toString();
    check("repo target: the commit actually reached the remote", remoteLog.includes("repo target commit"));

    await client.close();
    db.close();
  }

  // ============ targets allowlist is PER-TARGET: vault-only grant rejects "repo", repo-only rejects "vault" ============
  {
    const db = tmpDb();
    const vault = initRepo(path.join(fixturesRoot, "crosscheck-vault"));
    const repo = initRepo(path.join(fixturesRoot, "crosscheck-repo"));
    const proj = "proj-crosscheck";
    seedProject(db, proj, "Cross-check", vault, repo);
    const companionSess = "companion-crosscheck";
    seedSession(db, companionSess, proj, "assistant");
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "git-push", projectId: proj, mode: "act", config: { targets: ["vault"] } });
    const pty = makeFakePty('the owner said: commit with message "cross-check"');
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));
    const repoRes = await call(client, "git_commit", { project: proj, target: "repo", message: "cross-check" });
    check("vault-only grant: target:\"repo\" is rejected", typeof repoRes.error === "string" && repoRes.status === undefined);
    const vaultRes = await call(client, "git_commit", { project: proj, target: "vault", message: "cross-check" });
    check("vault-only grant: target:\"vault\" is still accepted (proposes)", vaultRes.status === "proposed");
    await client.close();
    db.close();

    const db2 = tmpDb();
    seedProject(db2, proj, "Cross-check 2", vault, repo);
    seedSession(db2, companionSess, proj, "assistant");
    db2.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "git-push", projectId: proj, mode: "act", config: { targets: ["repo"] } });
    const pty2 = makeFakePty('the owner said: commit with message "cross-check 2"');
    const companion2 = makeFakeCompanion();
    const orch2 = new OrchestrationMcpRouter(db2, {}, companion2, pty2);
    const client2 = await connect(orch2.buildServer(companionSess, "assistant"));
    const vaultRes2 = await call(client2, "git_commit", { project: proj, target: "vault", message: "cross-check 2" });
    check("repo-only grant: target:\"vault\" is rejected", typeof vaultRes2.error === "string" && vaultRes2.status === undefined);
    const repoRes2 = await call(client2, "git_commit", { project: proj, target: "repo", message: "cross-check 2" });
    check("repo-only grant: target:\"repo\" is still accepted (proposes)", repoRes2.status === "proposed");
    await client2.close();
    db2.close();
  }

  // ============ repo target: an unset repoPath is a structured error, never a throw ============
  {
    const db = tmpDb();
    const proj = "proj-norepopath";
    db.insertProject({ id: proj, name: "No repo path", repoPath: "", vaultPath: "", config: {}, createdAt: now, archivedAt: null });
    const companionSess = "companion-norepopath";
    seedSession(db, companionSess, proj, "assistant");
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "git-push", projectId: proj, mode: "act", config: { targets: ["repo"] } });
    const pty = makeFakePty('the owner said: commit with message "x"');
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));
    const res = await call(client, "git_commit", { project: proj, target: "repo", message: "x" });
    check("no repo path: rejected with an {error}", typeof res.error === "string" && res.status === undefined);
    check("no repo path: error names the missing repo path", /repo path/i.test(res.error));
    check("no repo path: nothing delivered to the owner", companion.delivered.length === 0);
    await client.close();
    db.close();
  }

  // ============ grant/revoke: a live per-request row-read gates BOTH directions ============
  {
    const db = tmpDb();
    const vault = initRepo(path.join(fixturesRoot, "revoke-vault"));
    const proj = "proj-revoke";
    seedProject(db, proj, "Revoke", vault);
    const companionSess = "companion-revoke";
    seedSession(db, companionSess, proj, "assistant");
    const orch = new OrchestrationMcpRouter(db, {}, {}, makeFakePty(null));

    const beforeGrant = await listOf(orch.buildServer(companionSess, "assistant"));
    check("revoke setup: no grant yet ⇒ both tools absent", !beforeGrant.includes("git_commit") && !beforeGrant.includes("git_push"));

    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "git-push", projectId: proj, mode: "act", config: { targets: ["vault"] } });
    const afterGrant = await listOf(orch.buildServer(companionSess, "assistant"));
    check("grant present: git_commit IS registered on the next buildServer", afterGrant.includes("git_commit"));
    check("grant present: git_push IS registered on the next buildServer", afterGrant.includes("git_push"));

    db.deleteCompanionCapabilityGrant(companionSess, "git-push", proj);
    const afterRevoke = await listOf(orch.buildServer(companionSess, "assistant"));
    check("grant DELETED: git_commit is absent on the VERY NEXT buildServer/request", !afterRevoke.includes("git_commit"));
    check("grant DELETED: git_push is absent on the VERY NEXT buildServer/request", !afterRevoke.includes("git_push"));

    db.close();
  }

  // ============ additive: byte-identical companion surface with NO git-push grant ============
  {
    const db = tmpDb();
    const vault = initRepo(path.join(fixturesRoot, "additive-vault"));
    const proj = "proj-additive";
    seedProject(db, proj, "Additive", vault);
    const companionSess = "companion-additive";
    seedSession(db, companionSess, proj, "assistant");
    // Grant a DIFFERENT, unrelated capability only — git-push itself is never granted.
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "session-status", projectId: proj, mode: "read" });
    const orch = new OrchestrationMcpRouter(db, {}, {}, makeFakePty(null));
    const tools = await listOf(orch.buildServer(companionSess, "assistant"));
    check("additive: git_commit absent with no git-push grant", !tools.includes("git_commit"));
    check("additive: git_push absent with no git-push grant", !tools.includes("git_push"));
    check("additive: the unrelated granted lever's own tool is still present", tools.includes("sessions_status"));
    db.close();
  }
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
  try { fs.rmSync(fixturesRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — git-push (git_commit Tier A / git_push Tier X) is registered only under an act-mode grant; a configured targets allowlist gates which repo a call may touch, per-target (a vault-only grant rejects \"repo\" and vice versa); the vault target resolves to the GOVERNING repo root (never a raw subfolder path, never Obsidian-Git-managed, never auto-inited); the repo target resolves directly to project.repoPath (an unset repoPath is a structured error) and commits/pushes end-to-end for real; git_commit's message defaults to requiring a verbatim owner quote (relaxed only by an explicit per-project authoredContent:true); a cold Tier-A window steps up once and ARMS itself so a later commit applies directly, while git_push's Tier X ALWAYS proposes first (even inside that same warm window) with a bounded ahead-count+latest-subject confirm disclosure and never arms/extends the window on commit; token-mismatch is retryable and a propose→confirm payload mismatch is rejected without committing; a clean tree surfaces GitWriter's own structured error; Primitive A / no-route / failed-delivery all fail closed; a live per-request row-read gates BOTH grant AND revoke (deleting the grant removes both tools on the very next buildServer/request); and the surface is fully additive with no grant."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
