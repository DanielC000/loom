import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 66b1b40d (multi-harness epic df1f94b0) — the human-only fleet/project DEFAULT-HARNESS config
// (`harness: {default, scope}`) and its resolution at WORKER spawn. DETERMINISTIC + CLAUDE/CODEX-FREE:
// a real Db + SessionService driven against a fake pty via PtyHost's createPty() seam (same technique as
// profile-spawn.mjs) — no real claude, no real codex, no daemon, no network.
//
//   (1) pure resolution: resolveHarnessConfig / harnessDefaultForRole / resolveConfig precedence layers.
//   (2) spawn precedence through the REAL spawnWorker chokepoint: profile > project > platform > built-in
//       claude; a resolved claude leaves the session column NULL (byte-identical to before this card).
//   (3) scope: the default applies to role "worker" ONLY (a manager / plain spawn is untouched), even when a
//       raw `scope:"fleet"` was somehow stored — the resolver never honors it (card 4c4eb9af relaxes that).
//   (4) a default flip NEVER migrates a live session (its row is unchanged).
//   (5) validators: platform + project layers accept default/scope, REJECT scope:"fleet" naming card 4c4eb9af;
//       the AGENT project-config shape (mcp/platform.ts) and BOTH agent routers' project_configure REJECT the key.
//
// NOT COVERED here: recycle/resume/fork carrying the pinned harness (card 8d4b4433 changes recycle), the drain read
// model (3d8edea5), any web surface (b8e52cfe), and switch-now (fe4fdf5e).
//
// Run: 1) build (turbo builds shared first), 2) node test/default-harness-config.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-dhc-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { resolveConfig, resolveHarnessConfig, harnessDefaultForRole, PLATFORM_DEFAULTS } = await import("@loom/shared");
const platformMod = await import("../dist/mcp/platform.js");
const { PlatformMcpRouter, validatePlatformConfigOverride, validatePlatformConfigPatch, validateProjectConfigOverride, validateAgentProjectConfigOverride } = platformMod;
const { SetupMcpRouter } = await import("../dist/mcp/setup.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

// ============ (1) pure resolution ============
check("(1) PLATFORM_DEFAULTS.harness is {default:'claude', scope:'workers'} (today's behavior)",
  PLATFORM_DEFAULTS.harness.default === "claude" && PLATFORM_DEFAULTS.harness.scope === "workers");
check("(1) resolveConfig(undefined).harness is the built-in default", resolveConfig(undefined).harness.default === "claude");
check("(1) platform layer reaches resolveConfig on the no-project-override fast path", resolveConfig(undefined, { harness: { default: "codex" } }).harness.default === "codex");
check("(1) platform layer reaches resolveConfig on the with-project-override path", resolveConfig({}, { harness: { default: "codex" } }).harness.default === "codex");
check("(1) project layer beats platform layer", resolveConfig({ harness: { default: "claude" } }, { harness: { default: "codex" } }).harness.default === "claude");
check("(1) per-field merge: project sets scope only, platform sets default only ⇒ both survive",
  (() => { const h = resolveHarnessConfig({ harness: { scope: "workers" } }, { harness: { default: "codex" } }); return h.default === "codex" && h.scope === "workers"; })());
check("(1) harnessDefaultForRole: a codex default applies to worker", harnessDefaultForRole({ default: "codex", scope: "workers" }, "worker") === "codex");
check("(1) harnessDefaultForRole: a claude default resolves to undefined (⇒ NULL column, byte-identical)", harnessDefaultForRole({ default: "claude", scope: "workers" }, "worker") === undefined);
for (const role of ["manager", "platform", "auditor", "workspace-auditor", "setup", "run", "assistant", "operator", undefined]) {
  check(`(1) harnessDefaultForRole: a codex default does NOT apply to role ${role}`, harnessDefaultForRole({ default: "codex", scope: "workers" }, role) === undefined);
}
check("(1) harnessDefaultForRole ignores scope:'fleet' (fail-closed until card 4c4eb9af)", harnessDefaultForRole({ default: "codex", scope: "fleet" }, "manager") === undefined);
check("(1) NEGATIVE CONTROL: a wrong-role query really can differ (worker→codex vs manager→undefined on the SAME config)",
  harnessDefaultForRole({ default: "codex", scope: "workers" }, "worker") !== harnessDefaultForRole({ default: "codex", scope: "workers" }, "manager"));

// ============ (2)-(4) spawn precedence through the real spawnWorker chokepoint ============
const repo = path.join(os.tmpdir(), `loom-dhc-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# default-harness-config test\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", "-c user.email=dhc@loom -c user.name=dhc");

const now = new Date().toISOString();
const db = new Db();
// maxConcurrentWorkers raised so every spawn below is admitted (db writes bypass the validator on purpose).
const projConfig = (harness) => ({ orchestration: { maxConcurrentWorkers: 50 }, ...(harness ? { harness } : {}) });
db.insertProject({ id: "pH", name: "H", repoPath: repo, vaultPath: repo, config: projConfig(), createdAt: now, archivedAt: null });
db.insertProfile({ id: "profWorkerCodex", name: "WorkerCodex", role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null, harness: "codex" });
db.insertProfile({ id: "profWorkerClaude", name: "WorkerClaude", role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null, harness: "claude" });
db.insertProfile({ id: "profMgr", name: "Mgr", role: "manager", description: "", allowDelta: [], skills: null, model: null, icon: null });
db.insertAgent({ id: "agentPlain", projectId: "pH", name: "Plain", startupPrompt: "PLAIN", position: 0, profileId: null });
db.insertAgent({ id: "agentCodex", projectId: "pH", name: "WC", startupPrompt: "WC", position: 1, profileId: "profWorkerCodex" });
db.insertAgent({ id: "agentClaude", projectId: "pH", name: "WCl", startupPrompt: "WCL", position: 2, profileId: "profWorkerClaude" });
db.insertAgent({ id: "agentMgr", projectId: "pH", name: "Mgr", startupPrompt: "MGR", position: 3, profileId: "profMgr" });
db.insertSession({
  id: "mgr1", projectId: "pH", agentId: "agentPlain", engineSessionId: null, title: null,
  cwd: repo, processState: "live", resumability: "unknown", busy: false,
  createdAt: now, lastActivity: now, lastError: null, role: "manager",
});

// BOTH spawn chokepoints are faked: a codex-harness spawn goes through createCodexPty (NOT createPty), so
// leaving it un-overridden would launch the REAL codex binary. LOOM_CODEX_BIN points at a path that does not
// exist as a second, loud backstop — a real spawn attempt would fail visibly instead of booting codex.
process.env.LOOM_CODEX_BIN = path.join(tmpHome, "no-such-codex-binary");
const fakePty = () => ({ pid: 4242, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} });
class SeamHost extends PtyHost {
  constructor(events) { super(events); this.capture = []; }
  createPty(opts) { this.capture.push(opts); return fakePty(); }
  createCodexPty(opts) { this.capture.push(opts); return fakePty(); }
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());
const optsFor = (sid) => host.capture.find((o) => o.sessionId === sid);

const worktrees = [];
const spawn = async (agentId) => {
  const taskId = randomUUID();
  db.insertTask({ id: taskId, projectId: "pH", title: `T-${agentId}`, body: "", columnKey: "todo", position: 1, createdAt: now, updatedAt: now });
  const w = await svc.spawnWorker("mgr1", { taskId, agentId, kickoffPrompt: "KICK" });
  worktrees.push(w.worktreePath);
  return { w, opts: optsFor(w.id), row: db.getSession(w.id) };
};
const setPlatform = (h) => db.setPlatformConfig(h ? { harness: h } : {});
const setProject = (h) => db.setProjectConfig("pH", projConfig(h));

async function callTool(server, name, args) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "default-harness-config-test", version: "0" });
  await client.connect(clientT);
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? "";
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

try {
  // -- baseline: nothing configured ⇒ byte-identical to before this card --
  const base = await spawn("agentPlain");
  check("(2) baseline: no config ⇒ opts.harness undefined", base.opts?.harness === undefined);
  check("(2) baseline: no config ⇒ session column NULL/undefined (byte-identical)", base.row.harness === undefined || base.row.harness === null);

  // -- platform default codex, plain agent --
  setPlatform({ default: "codex" });
  const plat = await spawn("agentPlain");
  check("(2) platform default codex ⇒ a profile-less worker spawns codex (opts.harness)", plat.opts?.harness === "codex");
  check("(2) platform default codex ⇒ the codex pin is persisted on the session row", plat.row.harness === "codex");
  check("(4) the EARLIER baseline worker's row is unchanged by the default flip (never migrated)", (db.getSession(base.w.id).harness ?? null) === null);

  // -- project override beats platform --
  setProject({ default: "claude" });
  const projWins = await spawn("agentPlain");
  check("(2) project claude beats platform codex ⇒ opts.harness undefined", projWins.opts?.harness === undefined);
  check("(2) a resolved claude leaves the session column NULL (byte-identical)", projWins.row.harness === undefined || projWins.row.harness === null);

  // -- project codex with NO platform layer --
  setPlatform(null);
  setProject({ default: "codex" });
  const projOnly = await spawn("agentPlain");
  check("(2) project codex alone ⇒ codex", projOnly.opts?.harness === "codex" && projOnly.row.harness === "codex");

  // -- profile explicit wins over both layers, in both directions --
  setPlatform({ default: "codex" });
  setProject({ default: "codex" });
  const profClaude = await spawn("agentClaude");
  check("(2) profile harness 'claude' beats project+platform codex", profClaude.opts?.harness === "claude");
  setPlatform(null);
  setProject({ default: "claude" });
  const profCodex = await spawn("agentCodex");
  check("(2) profile harness 'codex' beats a claude default", profCodex.opts?.harness === "codex" && profCodex.row.harness === "codex");

  // -- (3) scope: a manager spawn is untouched by a codex default, even a raw stored scope:'fleet' --
  setPlatform({ default: "codex", scope: "fleet" }); // bypasses the validator on purpose — proves the resolver is fail-closed too
  setProject(null);
  const mgrSess = svc.startNew("agentMgr");
  check("(3) manager spawn under a codex default (+ stored scope:'fleet') stays claude (opts.harness undefined)", optsFor(mgrSess.id)?.harness === undefined);
  const plainSess = svc.startNew("agentPlain");
  check("(3) plain (role-less) spawn under a codex default stays claude", optsFor(plainSess.id)?.harness === undefined);
  const stillWorker = await spawn("agentPlain");
  check("(3) POSITIVE CONTROL: the SAME config still sends a WORKER to codex (the manager result above is not a broken harness)", stillWorker.opts?.harness === "codex");

  // -- (4) earlier live rows unchanged after all the flips --
  check("(4) every earlier session row still carries the harness it spawned with",
    (db.getSession(plat.w.id).harness) === "codex" && (db.getSession(profClaude.w.id).harness) === "claude");
} finally {
  try { const { removeWorktree } = await import("../dist/git/worktrees.js"); for (const wt of worktrees) { try { await removeWorktree(repo, wt); } catch { /* best-effort */ } } } catch { /* best-effort */ }
}

// ============ (5) validators ============
const ok = (r) => r.ok === true;
const err = (r) => (r.ok === false ? r.error : "");
check("(5) platform validator accepts {harness:{default:'codex'}}", ok(validatePlatformConfigOverride({ harness: { default: "codex" } })));
check("(5) platform validator accepts scope:'workers'", ok(validatePlatformConfigOverride({ harness: { scope: "workers" } })));
const platFleet = validatePlatformConfigOverride({ harness: { scope: "fleet" } });
check("(5) platform validator REJECTS scope:'fleet', naming the gate card", !ok(platFleet) && err(platFleet).includes("4c4eb9af"));
check("(5) platform validator rejects an unknown harness value", !ok(validatePlatformConfigOverride({ harness: { default: "gemini" } })));
check("(5) platform validator rejects an unknown harness sub-key (.strict)", !ok(validatePlatformConfigOverride({ harness: { nope: 1 } })));
check("(5) platform PATCH accepts a per-field null clear", ok(validatePlatformConfigPatch({ harness: { default: null } })));
check("(5) platform PATCH accepts a whole-group null clear", ok(validatePlatformConfigPatch({ harness: null })));
const patchFleet = validatePlatformConfigPatch({ harness: { scope: "fleet" } });
check("(5) platform PATCH REJECTS scope:'fleet', naming the gate card", !ok(patchFleet) && err(patchFleet).includes("4c4eb9af"));
check("(5) human project validator accepts {harness:{default:'codex'}}", ok(validateProjectConfigOverride({ harness: { default: "codex" } })));
const projFleet = validateProjectConfigOverride({ harness: { scope: "fleet" } });
check("(5) human project validator REJECTS scope:'fleet', naming the gate card", !ok(projFleet) && err(projFleet).includes("4c4eb9af"));
const agentSet = validateAgentProjectConfigOverride({ harness: { default: "codex" } });
check("(5) AGENT project-config shape REJECTS harness (human-only)", !ok(agentSet) && /harness/.test(err(agentSet)));
check("(5) CONTROL: the AGENT shape still accepts a normal key (docLint) — the rejection above is specific to harness", ok(validateAgentProjectConfigOverride({ docLint: false })));

// project_configure over both agent routers: the stored config must stay unchanged.
const storedBefore = JSON.stringify(db.getProject("pH").config);
const setupRes = await callTool(new SetupMcpRouter(db, svc).buildServer("SETUP"), "project_configure", { projectId: "pH", config: { harness: { default: "codex" } } });
check("(5) setup-surface project_configure REJECTS harness (error present)", typeof setupRes.error === "string" && /harness/.test(setupRes.error));
const leadRes = await callTool(new PlatformMcpRouter(db, svc).buildServer(), "project_configure", { projectId: "pH", config: { harness: { default: "codex" } } });
check("(5) platform-Lead project_configure REJECTS harness even though it shares the full human validator", typeof leadRes.error === "string" && /harness/.test(leadRes.error));
check("(5) neither rejected write changed the stored project config", JSON.stringify(db.getProject("pH").config) === storedBefore);
const leadOk = await callTool(new PlatformMcpRouter(db, svc).buildServer(), "project_configure", { projectId: "pH", config: { docLint: false } });
check("(5) CONTROL: the Lead's project_configure still accepts a normal key — the rejection is specific to harness", !leadOk.error);

db.close();
try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — default-harness config resolves profile > project > platform > claude at WORKER spawn only, a resolved claude stays NULL, live rows are never migrated, scope:'fleet' is fail-closed, and every agent path rejects the human-only key."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
