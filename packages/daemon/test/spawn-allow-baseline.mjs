import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1)
// Service-level guard for the loom-tasks ALLOW BASELINE union (card c4df52b1). DETERMINISTIC + CLAUDE-FREE,
// hermetic like profile-spawn.mjs: a REAL Db + SessionService driven against a FAKE pty injected via
// PtyHost's createPty() seam, capturing the permission threaded to each spawn.
//
// PROVES that a CUSTOM per-project permission.allow (which resolveConfig substitutes WHOLESALE for the
// default — `override.permission?.allow ?? default`) can ADD to but never REMOVE the task-board baseline:
//   (a) a custom allow that OMITS mcp__loom-tasks is HEALED — every resolveAgentSpawn-driven role
//       (plain/worker/manager) spawns with mcp__loom-tasks present, so the session never hangs on its
//       first tasks_* call (acceptEdits doesn't auto-approve MCP tools — the §9 lesson);
//   (b) a custom allow keeps its OWN extra entries (the union ADDS, it doesn't replace);
//   (c) the DEFAULT config (baseline already present) is BYTE-IDENTICAL — same allow array, no dupes.
//
// Run: 1) build (turbo builds shared first), 2) node test/spawn-allow-baseline.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-allowbl-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { resolveConfig } = await import("@loom/shared");

// A real temp git repo so spawnWorker's createWorktree (real git) has a HEAD to branch off.
const repo = path.join(os.tmpdir(), `loom-allowbl-repo-${Date.now()}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# allow-baseline test\n");
execSync(`git init -q && git add . && git -c user.email=ab@loom -c user.name=ab commit -q -m init`, { cwd: repo });

const now = new Date().toISOString();
const BASELINE = "mcp__loom-tasks";
const CUSTOM_EXTRA = "Bash(echo CUSTOM_OK:*)";
// A CUSTOM project permission.allow that DROPS the baseline but keeps a project-specific entry. resolveConfig
// substitutes this wholesale for the default allow (so without the union fix, every session here loses tasks).
const customConfig = { permission: { allow: [CUSTOM_EXTRA] } };

const db = new Db();
db.insertProject({ id: "pCustom", name: "Custom", repoPath: repo, vaultPath: repo, config: customConfig, createdAt: now, archivedAt: null });
db.insertProject({ id: "pDefault", name: "Default", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: "agCustom", projectId: "pCustom", name: "Plain", startupPrompt: "P", position: 0, profileId: null });
db.insertAgent({ id: "agDefault", projectId: "pDefault", name: "Plain", startupPrompt: "P", position: 0, profileId: null });
db.insertSession({ id: "mgrCustom", projectId: "pCustom", agentId: "agCustom", engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
const taskW = "44444444-4444-4444-8444-444444444444";
db.insertTask({ id: taskW, projectId: "pCustom", title: "WORK", body: "", columnKey: "todo", position: 1, createdAt: now, updatedAt: now });

// Sanity: the CUSTOM resolved config really did drop the baseline (so the fix is what restores it).
check("setup: the custom project's resolved config.permission.allow OMITS the baseline (wholesale override)",
  !resolveConfig(customConfig).permission.allow.includes(BASELINE) && resolveConfig(customConfig).permission.allow.includes(CUSTOM_EXTRA));

class SeamHost extends PtyHost {
  constructor(events) { super(events); this.capture = []; }
  createPty(opts) {
    this.capture.push(opts);
    return { pid: 1, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} };
  }
}
const events = { onEngineSessionId(id, e) { db.setEngineSessionId(id, e); }, onBusy(id, b) { db.setBusy(id, b); }, onContextStats() {}, onRateLimited() {}, onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); } };
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());
const optsFor = (sid) => host.capture.find((o) => o.sessionId === sid);

let workerWorktree = null;
try {
  // (a)+(b) a PLAIN session in the custom-allow project: baseline healed, custom entry kept.
  const sP = svc.startNew("agCustom");
  const oP = optsFor(sP.id);
  check("(a) plain spawn in a custom-allow project HAS the mcp__loom-tasks baseline (healed)", oP?.permission.allow.includes(BASELINE));
  check("(b) the custom allow's own entry is preserved (union ADDS, not replaces)", oP?.permission.allow.includes(CUSTOM_EXTRA));
  check("(a) baseline appears exactly once (no duplicate)", oP.permission.allow.filter((t) => t === BASELINE).length === 1);

  // (a) a WORKER in the custom-allow project — the card's primary case (it must keep its report/coordinate tools).
  const w = await svc.spawnWorker("mgrCustom", { taskId: taskW, agentId: "agCustom", kickoffPrompt: "K" });
  workerWorktree = w.worktreePath;
  const oW = optsFor(w.id);
  check("(a) worker spawn in a custom-allow project HAS the mcp__loom-tasks baseline (can report/coordinate)", oW?.permission.allow.includes(BASELINE));
  check("(b) worker spawn keeps the custom allow entry too", oW?.permission.allow.includes(CUSTOM_EXTRA));

  // (c) the DEFAULT-config project is BYTE-IDENTICAL — baseline already present, no dupes, same array value.
  const sD = svc.startNew("agDefault");
  const oD = optsFor(sD.id);
  const defaultAllow = resolveConfig({}).permission.allow;
  check("(c) default-config spawn: permission.allow EQUALS the resolved config allow (byte-identical)",
    JSON.stringify(oD?.permission.allow) === JSON.stringify(defaultAllow));
  check("(c) default-config spawn: the baseline is present exactly once (no duplicate introduced)",
    oD.permission.allow.filter((t) => t === BASELINE).length === 1);
} finally {
  try { if (workerWorktree) { const { removeWorktree } = await import("../dist/git/worktrees.js"); await removeWorktree(repo, workerWorktree); } } catch { /* best-effort */ }
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a custom permission.allow can ADD to but never REMOVE the mcp__loom-tasks baseline (worker/manager/plain healed), the custom entry is kept, and a default-config spawn stays byte-identical."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
