import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 2ef54430 — the durable `codex_provider_dropped` event fires ONCE per spawn on EVERY path where a profile
// carries a codexProvider but the spawn's FINAL harness is not codex: the default-harness skip, a claude/unset
// harness, and the transcript-role force. DETERMINISTIC + CLAUDE/CODEX-FREE (fake pty on both spawn seams, a
// dead LOOM_CODEX_BIN as a loud backstop). Names the connection id only. NOT COVERED: recycle/resume trigger legs.
//
// Run: 1) build, 2) node test/codex-provider-dropped-event.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { hermeticPort } from "./_hermetic-port.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-cpde-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_PORT = String(hermeticPort());
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
delete process.env.CLAUDE_CONFIG_DIR;
process.env.LOOM_CODEX_BIN = path.join(tmpHome, "no-such-codex-binary");
delete process.env.CODEX_HOME;

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

const repo = path.join(os.tmpdir(), `loom-cpde-repo-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# codex-provider-dropped-event test\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", "-c user.email=cp@loom -c user.name=cp");

const now = new Date().toISOString();
const db = new Db();
db.setPlatformConfig({ harness: { default: "codex" } });
const baseCfg = { orchestration: { maxConcurrentWorkers: 50 } };
db.insertProject({ id: "pC", name: "C", repoPath: repo, vaultPath: repo, config: baseCfg, createdAt: now, archivedAt: null });
// A project whose own override pins the default back to claude (project beats platform).
db.insertProject({ id: "pCl", name: "Cl", repoPath: repo, vaultPath: repo, config: { ...baseCfg, harness: { default: "claude" } }, createdAt: now, archivedAt: null });

const CUSTOM = { id: "myhost", baseUrl: "https://api.example.com/v1", connectionId: "conn-secret-id-1" };
const OLLAMA = { id: "ollama" };
const profile = (id, role, extra) => db.insertProfile({ id, name: id, role, description: "", allowDelta: [], skills: null, model: null, icon: null, ...extra });
profile("profSkip", "worker", { restrictedTools: true, codexProvider: CUSTOM });   // harness unset + codex default + incompatible => default skipped
profile("profClaudeDefault", "worker", { codexProvider: OLLAMA });                 // harness unset + claude default
profile("profExplicitCodex", "worker", { harness: "codex", codexProvider: OLLAMA }); // CONTROL: stays codex, provider kept
profile("profSkipNoProvider", "worker", { restrictedTools: true });                // CONTROL: skipped but no provider
profile("profMgrCodex", "manager", { harness: "codex", codexProvider: OLLAMA });   // role force (manager is a transcript-deny role)
const agent = (id, projectId, profileId, pos) => db.insertAgent({ id, projectId, name: id, startupPrompt: id, position: pos, profileId });
agent("agSkip", "pC", "profSkip", 0);
agent("agClaudeDefault", "pCl", "profClaudeDefault", 0);
agent("agExplicit", "pC", "profExplicitCodex", 1);
agent("agSkipNoProvider", "pC", "profSkipNoProvider", 2);
agent("agMgr", "pC", null, 3);
agent("agMgrCodex", "pC", "profMgrCodex", 4);
db.insertSession({
  id: "mgr1", projectId: "pC", agentId: "agMgr", engineSessionId: null, title: null,
  cwd: repo, processState: "live", resumability: "unknown", busy: false,
  createdAt: now, lastActivity: now, lastError: null, role: "manager",
});
db.insertSession({
  id: "mgrCl", projectId: "pCl", agentId: "agMgr", engineSessionId: null, title: null,
  cwd: repo, processState: "live", resumability: "unknown", busy: false,
  createdAt: now, lastActivity: now, lastError: null, role: "manager",
});

const fakePty = () => {
  let exitCb = null;
  return { pid: 4242, write() {}, onData() { return { dispose() {} }; }, onExit(cb) { exitCb = cb; return { dispose() {} }; }, kill() { exitCb?.({ exitCode: 0 }); }, resize() {} };
};
class SeamHost extends PtyHost {
  sweepOrphanedDescendants(_rootPid) {}
  reapExitedDescendants(_rootPid) {} async probeRootSurvival(_rootPid, _sessionId) { return { foundAlive: false, identityConfirmed: false, enumerationFailed: false }; }
  async captureRootCreationRow(_pid) { return null; }
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
const dropsOf = (sid) => db.listEventsForWorker(sid).filter((e) => e.kind === "codex_provider_dropped");
const worktrees = [];
const spawn = async (agentId, mgrId = "mgr1", projectId = "pC") => {
  const taskId = randomUUID();
  db.insertTask({ id: taskId, projectId, title: `T-${agentId}`, body: "", columnKey: "todo", position: 1, createdAt: now, updatedAt: now });
  const w = await svc.spawnWorker(mgrId, { taskId, agentId, kickoffPrompt: "KICK" });
  worktrees.push(w.worktreePath);
  return w;
};

try {
  // (1) default-harness skip: the path that used to emit nothing.
  const w1 = await spawn("agSkip");
  check("(1) the incompatible worker really was default-skipped to claude", optsFor(w1.id)?.harness === undefined && w1.harnessDefaultSkipped?.some((i) => i.id === "restrictedTools") === true);
  const d1 = dropsOf(w1.id);
  check("(1) default-skip path: EXACTLY one codex_provider_dropped event", d1.length === 1);
  check("(1) event attribution: manager = spawning manager, worker = the new session", d1[0]?.managerSessionId === "mgr1" && d1[0]?.workerSessionId === w1.id);
  check("(1) event names the connection id and provider id", d1[0]?.detail.connectionId === "conn-secret-id-1" && d1[0]?.detail.providerId === "myhost");
  check("(1) event carries NO url (connection id only)", !JSON.stringify(d1[0]?.detail ?? {}).includes("api.example.com"));
  check("(1) the dropped provider is NOT pinned on the claude session row", !db.getSession(w1.id)?.codexProvider);

  // (2) harness unset + claude default (no skip, no role force at all).
  const w2 = await spawn("agClaudeDefault", "mgrCl", "pCl");
  check("(2) claude-default worker spawned as claude", optsFor(w2.id)?.harness === undefined);
  check("(2) claude-default path: EXACTLY one codex_provider_dropped event", dropsOf(w2.id).length === 1 && dropsOf(w2.id)[0].detail.connectionId === null);

  // (3) startNew (human +New) on the skipped agent: manager = the session itself.
  const sn = svc.startNew("agSkip");
  check("(3) startNew default-skip: one event with manager = the session itself", dropsOf(sn.id).length === 1 && dropsOf(sn.id)[0].managerSessionId === sn.id);

  // (4) role force: still exactly one (not two) after the refactor.
  const mg = svc.startManager("agMgrCodex");
  check("(4) role-force path (manager+codex) forced to claude", optsFor(mg.id)?.harness === undefined);
  check("(4) role-force path: EXACTLY one codex_provider_dropped event", dropsOf(mg.id).length === 1);
  check("(4) role-force: harness_role_forced_claude still filed", db.listEventsForWorker(mg.id).filter((e) => e.kind === "harness_role_forced_claude").length === 1);

  // (5) CONTROLS: no drop when nothing was dropped.
  const w5 = await spawn("agExplicit");
  check("(5) CONTROL: explicit codex profile + provider stays codex", optsFor(w5.id)?.harness === "codex" && db.getSession(w5.id)?.codexProvider?.id === "ollama");
  check("(5) CONTROL: ... and files NO codex_provider_dropped", dropsOf(w5.id).length === 0);
  const w6 = await spawn("agSkipNoProvider");
  check("(5) CONTROL: default-skipped worker WITHOUT a provider files NO codex_provider_dropped", optsFor(w6.id)?.harness === undefined && dropsOf(w6.id).length === 0);
} finally {
  for (const wt of worktrees) { try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* best-effort */ } }
}

db.close();
try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — codex_provider_dropped fires once per spawn on every path where the final harness is not codex."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
