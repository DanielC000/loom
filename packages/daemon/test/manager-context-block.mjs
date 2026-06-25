import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// PL Auditor finding #8 — "Where things live" manager context block. DETERMINISTIC + CLAUDE-FREE,
// hermetic like profile-spawn.mjs: isolated LOOM_HOME, a REAL Db + SessionService driven against a
// FAKE pty injected via PtyHost's createPty() seam — no real claude, no daemon, no network. A real
// temp git repo backs the project so spawnWorker's createWorktree (real git) works.
//
// Proves the DoD:
//   (1) a spawned MANAGER session's composed startupPrompt CONTAINS the project's absolute repoPath
//       AND vaultPath (the "Where things live" pre-block), with the agent's OWN prompt preserved after;
//   (2) a WORKER spawn does NOT get the MANAGER block (its opening is its agent brief + the kickoff — card af902717);
//   (3) the pure composeManagerStartupPrompt wraps/derives correctly (incl. the no-own-prompt case);
//   (4) the pickup + orchestrate skill ASSETS instruct reading the resume doc by ABSOLUTE path.
//
// Run: 1) build (turbo builds shared first), 2) node test/manager-context-block.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Hermetic LOOM_HOME (set BEFORE importing dist — paths.ts reads it at import time) ---
const tmpHome = path.join(os.tmpdir(), `loom-mctxblk-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { composeManagerStartupPrompt } = await import("../dist/sessions/manager-prompt.js");

// --- a real temp git repo so spawnWorker's createWorktree (real git) has a HEAD to branch off, and a
//     SEPARATE vault dir so we can prove BOTH absolute roots land in the block (not one path twice) ---
const repo = path.join(os.tmpdir(), `loom-mctxblk-repo-${Date.now()}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# manager-context-block test\n");
execSync(`git init -q && git add . && git -c user.email=mc@loom -c user.name=mc commit -q -m init`, { cwd: repo });
const vault = path.join(os.tmpdir(), `loom-mctxblk-vault-${Date.now()}`);
fs.mkdirSync(vault, { recursive: true });

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pM", name: "MProj", repoPath: repo, vaultPath: vault, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: "agentMgr", projectId: "pM", name: "Orchestrator", startupPrompt: "AGENT_MGR_DOCTRINE", position: 0, profileId: null });
db.insertAgent({ id: "agentWorker", projectId: "pM", name: "Dev", startupPrompt: "AGENT_WORKER_PROMPT", position: 1, profileId: null });
// a live manager so spawnWorker has a parent; worker_spawn validates the taskId is a real, non-terminal task
db.insertSession({
  id: "mgr1", projectId: "pM", agentId: "agentMgr", engineSessionId: null, title: null,
  cwd: repo, processState: "live", resumability: "unknown", busy: false,
  createdAt: now, lastActivity: now, lastError: null, role: "manager",
});
const taskW = "44444444-4444-4444-8444-444444444444";
db.insertTask({ id: taskW, projectId: "pM", title: "WORK", body: "", columnKey: "todo", position: 1, createdAt: now, updatedAt: now });

// --- the fake pty + a PtyHost subclass that captures every SpawnOpts via the createPty() seam ---
class SeamHost extends PtyHost {
  constructor(events) { super(events); this.capture = []; }
  createPty(opts) {
    this.capture.push(opts);
    return { pid: 4242, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} };
  }
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

let workerWorktree = null;
try {
  // ===================== (3) pure composeManagerStartupPrompt =====================
  const composed = composeManagerStartupPrompt("DOCTRINE_BODY", { repoPath: "/abs/repo", vaultPath: "/abs/vault" });
  check("(3) pure: block carries the absolute repoPath", composed.includes("/abs/repo"));
  check("(3) pure: block carries the absolute vaultPath", composed.includes("/abs/vault"));
  check("(3) pure: block header present", composed.includes("## Where things live"));
  check("(3) pure: the agent's OWN prompt is preserved AFTER the block", composed.includes("DOCTRINE_BODY") && composed.indexOf("Where things live") < composed.indexOf("DOCTRINE_BODY"));
  check("(3) pure: instructs never to Glob", /never Glob/i.test(composed));
  const blockOnly = composeManagerStartupPrompt(undefined, { repoPath: "/abs/repo", vaultPath: "/abs/vault" });
  check("(3) pure: undefined own-prompt → block-only (no crash, no trailing prompt)", blockOnly.includes("## Where things live") && blockOnly.includes("/abs/vault"));
  const blankCase = composeManagerStartupPrompt("   ", { repoPath: "/r", vaultPath: "/v" });
  check("(3) pure: blank/whitespace own-prompt → block-only (trimmed away)", blankCase.includes("## Where things live") && blankCase.trimEnd().endsWith("the exact path)."));

  // ===================== (1) MANAGER spawn → composed startupPrompt CONTAINS both absolute roots =====================
  const sM = svc.startManager("agentMgr");
  const oM = optsFor(sM.id);
  check("(1) manager spawn opts.startupPrompt contains the absolute repoPath", oM?.startupPrompt?.includes(repo));
  check("(1) manager spawn opts.startupPrompt contains the absolute vaultPath", oM?.startupPrompt?.includes(vault));
  check("(1) manager spawn opts.startupPrompt carries the 'Where things live' block", oM?.startupPrompt?.includes("## Where things live"));
  check("(1) manager spawn preserves the agent's OWN doctrine after the block", oM?.startupPrompt?.includes("AGENT_MGR_DOCTRINE"));
  check("(1) manager session is live + role manager", db.getSession(sM.id).processState === "live" && oM?.role === "manager");

  // ===================== (2) WORKER spawn does NOT get the MANAGER block (card af902717: it DOES now carry its agent brief) =====================
  const w = await svc.spawnWorker("mgr1", { taskId: taskW, agentId: "agentWorker", kickoffPrompt: "WORKER_KICKOFF" });
  workerWorktree = w.worktreePath;
  const oW = optsFor(w.id);
  check("(2) worker spawn opts.startupPrompt carries its agent brief THEN the kickoff", oW?.startupPrompt?.includes("AGENT_WORKER_PROMPT") && oW?.startupPrompt?.includes("WORKER_KICKOFF") && oW.startupPrompt.indexOf("AGENT_WORKER_PROMPT") < oW.startupPrompt.indexOf("WORKER_KICKOFF"));
  check("(2) worker spawn opts.startupPrompt does NOT carry the manager 'Where things live' block", !oW?.startupPrompt?.includes("Where things live"));

  // ===================== (4) skill ASSETS instruct read-by-absolute-path =====================
  const pickup = fs.readFileSync(path.join(__dirname, "..", "assets", "skills", "pickup", "SKILL.md"), "utf8");
  const orchestrate = fs.readFileSync(path.join(__dirname, "..", "assets", "skills", "orchestrate", "SKILL.md"), "utf8");
  check("(4) pickup asset references the 'Where things live' context block", /Where things live/.test(pickup));
  check("(4) pickup asset derives the resume doc path (Orchestrator Log.md)", /Orchestrator Log\.md/.test(pickup));
  check("(4) pickup asset instructs ABSOLUTE-path read, never Glob", /ABSOLUTE path/.test(pickup) && /never Glob/i.test(pickup));
  check("(4) orchestrate asset references the 'Where things live' context block", /Where things live/.test(orchestrate));
  check("(4) orchestrate asset derives the resume doc path (Orchestrator Log.md)", /Orchestrator Log\.md/.test(orchestrate));
  check("(4) orchestrate asset instructs ABSOLUTE-path read, never Glob", /ABSOLUTE path/.test(orchestrate) && /never Glob/i.test(orchestrate));
} finally {
  try { if (workerWorktree) { const { removeWorktree } = await import("../dist/git/worktrees.js"); await removeWorktree(repo, workerWorktree); } } catch { /* best-effort */ }
  db.close(); // free the WAL handle before removing the temp dir (Windows)
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(vault, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — managers get the 'Where things live' block (both absolute roots), workers stay byte-identical, and the pickup/orchestrate assets instruct absolute-path reads — claude-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
