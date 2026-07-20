import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// WORKER structural `auto` default (audit finding 760cd01d, sev medium — origin platform-audit 2026-07-20).
//
// THE BUG: `acceptEdits` auto-approves file EDITS ONLY (Edit/Write/NotebookEdit) — Bash/`gh`/build/test
// and any non-allowlisted MCP call still prompt, and a spawned worker has no human at its TUI to answer,
// so it stalls. The owner had to manually worker_set_mode('auto') a stuck worker twice before this fix.
//
// THE FIX: SessionService.resolveAgentSpawn (the ONE chokepoint every fresh/resume/fork/recycle worker
// spawn threads through) now pins a WORKER's boot-cycle target to `auto` via
// `cyclesToReachFromAcceptEdits("auto")` — INDEPENDENT of the shared `config.permission.startupModeCycles`
// knob a project may set for manager/other-role reasons. Every OTHER role (manager/platform/setup/
// auditor/plain) keeps using `config.permission.startupModeCycles` verbatim — byte-identical to before.
//
// This test proves the ROLE-SCOPING is real, not coincidental: it configures the PROJECT with
// `startupModeCycles: 0` (a project that deliberately disabled the boot-cycle dance — e.g. for
// manager-related stability) and asserts a WORKER still targets `auto` while a MANAGER under the SAME
// config stays at the gate-free `acceptEdits` boot mode (0 cycles) — proving the worker override does
// not leak onto other roles, and that other roles are not touched by this change.
//
// DETERMINISTIC + CLAUDE-FREE, hermetic like resume-mode-cycles.mjs / respawn-profile-attrs.mjs:
// isolated LOOM_HOME + a sandboxed HOME, a REAL Db + SessionService driven against a FAKE pty injected
// via PtyHost's createPty() seam. No real claude, no daemon, no network.
//
// Run: 1) build (turbo builds shared first), 2) node test/worker-mode-default.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME (host.ts log dir) AND a sandboxed HOME so resume()'s engineTranscriptExists
// reads under the temp dir, never the real ~/.claude. Set BEFORE importing dist (paths.ts/os.homedir). ---
const tmpHome = path.join(os.tmpdir(), `loom-wmd-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");
const { resolveConfig } = await import("@loom/shared");
const { modeAfterCyclesFromAcceptEdits, cyclesToReachFromAcceptEdits } = await import("../dist/pty/host.js");

// --- pure helper contract: reverse of modeAfterCyclesFromAcceptEdits ---
check("(setup) cyclesToReachFromAcceptEdits('auto') round-trips through modeAfterCyclesFromAcceptEdits",
  modeAfterCyclesFromAcceptEdits(cyclesToReachFromAcceptEdits("auto")) === "auto");
check("(setup) cyclesToReachFromAcceptEdits('acceptEdits') is 0 (the gate-free boot mode itself)",
  cyclesToReachFromAcceptEdits("acceptEdits") === 0);

// --- a real temp git repo, with a PROJECT config that deliberately sets startupModeCycles:0 — proving
// the worker override is independent of this shared knob, not merely coincidental with today's default(2). ---
const repo = path.join(os.tmpdir(), `loom-wmd-repo-${Date.now()}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# worker-mode-default test\n");
execSync(`git init -q && git add . && git -c user.email=wmd@loom -c user.name=wmd commit -q -m init`, { cwd: repo });

const now = new Date().toISOString();
const db = new Db();
db.insertProject({
  id: "pP", name: "P", repoPath: repo, vaultPath: repo,
  config: { permission: { startupModeCycles: 0 } }, // project deliberately disables cycling
  createdAt: now, archivedAt: null,
});
const resolved = resolveConfig({ permission: { startupModeCycles: 0 } });
check("(setup) the project's resolved config really carries startupModeCycles:0", resolved.permission.startupModeCycles === 0);

db.insertAgent({ id: "agentWorker", projectId: "pP", name: "W", startupPrompt: "WORKER_PROMPT", position: 0, profileId: null });
db.insertAgent({ id: "agentMgr", projectId: "pP", name: "M", startupPrompt: "MGR_PROMPT", position: 1, profileId: null });
db.insertSession({
  id: "mgr1", projectId: "pP", agentId: "agentMgr", engineSessionId: null, title: null,
  cwd: repo, processState: "live", resumability: "unknown", busy: false,
  createdAt: now, lastActivity: now, lastError: null, role: "manager",
});
const tW = "11111111-1111-4111-8111-111111111111";
db.insertTask({ id: tW, projectId: "pP", title: "t", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });

// Fake pty seam: capture every SpawnOpts; kill() fires onExit so recycle's wait-for-dead loop resolves.
class SeamHost extends PtyHost {
  constructor(events) { super(events); this.capture = []; }
  createPty(opts) {
    this.capture.push(opts);
    let exitCb = null;
    return {
      pid: 4242, write() {}, onData() { return { dispose() {} }; },
      onExit(cb) { exitCb = cb; return { dispose() {} }; },
      kill() { if (exitCb) exitCb({ exitCode: 0 }); }, resize() {},
    };
  }
  isAlive() { return false; } // no real OS pty here — respawn/recycle paths treat the source as not-live
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

let workerWorktree = null, recycledWorktree = null;
try {
  // ===================== FRESH manager spawn under startupModeCycles:0 → stays at acceptEdits (UNCHANGED) =====================
  const mFresh = svc.startManager("agentMgr");
  const oMgrFresh = optsFor(mFresh.id);
  check("(manager fresh) carries the PROJECT's startupModeCycles verbatim (0) — role gating untouched",
    oMgrFresh?.permission.startupModeCycles === 0);
  check("(manager fresh) 0 cycles ⇒ stays at the gate-free acceptEdits boot mode (no forced auto)",
    modeAfterCyclesFromAcceptEdits(oMgrFresh?.permission.startupModeCycles ?? 0) === "acceptEdits");

  // ===================== FRESH worker spawn under the SAME startupModeCycles:0 → forced to auto =====================
  const w = await svc.spawnWorker("mgr1", { taskId: tW, agentId: "agentWorker", kickoffPrompt: "GO" });
  workerWorktree = w.worktreePath;
  const oWorkerFresh = optsFor(w.id);
  check("(worker fresh) does NOT inherit the project's 0 — it is pinned to reach auto regardless",
    oWorkerFresh?.permission.startupModeCycles === cyclesToReachFromAcceptEdits("auto"));
  check("(worker fresh) that pinned count actually lands on auto",
    modeAfterCyclesFromAcceptEdits(oWorkerFresh?.permission.startupModeCycles ?? 0) === "auto");
  check("(worker fresh) boots at acceptEdits (the gate-free mode --permission-mode emits) before cycling",
    oWorkerFresh?.permission.mode === "acceptEdits");

  // ===================== RESUME the worker → resumeModeTarget=auto, consistent with the fresh spawn =====================
  const engId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  db.setEngineSessionId(w.id, engId);
  const tpath = engineTranscriptPath(w.worktreePath, engId);
  fs.mkdirSync(path.dirname(tpath), { recursive: true });
  fs.writeFileSync(tpath, JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n");
  db.setBusy(w.id, false);
  host.capture.length = 0;
  svc.resume(w.id);
  const oWorkerResume = optsFor(w.id);
  check("(worker resume) resumeModeTarget=auto (matches the fresh worker's forced target, not the project's 0)",
    oWorkerResume?.resumeModeTarget === "auto");
  check("(worker resume) startupModeCycles still pinned to 0 (the blind branch stays inert on resume)",
    oWorkerResume?.permission.startupModeCycles === 0);

  // ===================== RESUME the manager under the SAME 0-config → stays at acceptEdits (UNCHANGED) =====================
  const engIdMgr = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
  db.setEngineSessionId(mFresh.id, engIdMgr);
  const tpathMgr = engineTranscriptPath(repo, engIdMgr);
  fs.mkdirSync(path.dirname(tpathMgr), { recursive: true });
  fs.writeFileSync(tpathMgr, JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n");
  db.setBusy(mFresh.id, false);
  host.capture.length = 0;
  svc.resume(mFresh.id);
  const oMgrResume = optsFor(mFresh.id);
  check("(manager resume) resumeModeTarget stays acceptEdits (the project's 0, untouched by the worker fix)",
    oMgrResume?.resumeModeTarget === "acceptEdits");

  // ===================== recycleWorker: re-resolves via the SAME chokepoint → still forced to auto =====================
  host.capture.length = 0;
  const rw = await svc.recycleWorker("mgr1", w.id, "HANDOFF: continue.");
  recycledWorktree = rw.worktreePath;
  const oRecycled = optsFor(rw.id);
  check("(recycleWorker) the successor is ALSO pinned to auto (goes through the same resolveAgentSpawn chokepoint)",
    oRecycled?.permission.startupModeCycles === cyclesToReachFromAcceptEdits("auto"));
} finally {
  try {
    const { removeWorktree } = await import("../dist/git/worktrees.js");
    for (const wt of [workerWorktree, recycledWorktree].filter(Boolean)) { try { await removeWorktree(repo, wt); } catch { /* best-effort */ } }
  } catch { /* best-effort */ }
  db.close(); // free the WAL handle before removing the temp dir (Windows)
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a spawned WORKER (fresh, resume, recycle) is structurally pinned to the `auto` boot target regardless of the project's shared startupModeCycles knob, while a manager under the SAME project config is left completely unchanged — claude-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
