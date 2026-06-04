import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Resume-path permission-mode assertion test (board card f05e4897 — "daemon-resumed manager lands in
// PLAN mode"). DETERMINISTIC + CLAUDE-FREE, hermetic like browser-testing-spawn.mjs / profile-spawn.mjs:
// isolated LOOM_HOME + a SANDBOXED HOME (so resume()'s engineTranscriptExists reads under the temp dir,
// never the real ~/.claude), a REAL Db + SessionService driven against a FAKE pty injected via PtyHost's
// createPty() seam. No real claude, no daemon, no network.
//
// Root cause guarded here: the startup Shift+Tab mode-cycling (host.ts sendModeCycles) is RELATIVE to the
// boot mode. A FRESH spawn boots at the gate-free `mode` (acceptEdits) and the config's 2 cycles step it
// to the target. But `claude --resume` RESTORES the session's persisted mode (it does NOT re-apply
// --permission-mode), so the engine is ALREADY at the target on resume — re-running the same 2 cycles
// OVERSHOOTS it (acceptEdits +2 → plan), wedging an auto-resumed manager. The fix: SessionService.resume
// pins startupModeCycles to 0 ONLY on the resume spawn; fresh spawns keep the config default (2).
//
// This asserts that contract at the seam: a FRESH spawn carries the config's startupModeCycles, while a
// RESUME of the SAME session carries startupModeCycles=0 — so the resumed session keeps its restored
// (acceptEdits/auto) mode and never overshoots into plan.
//
// Run: 1) build (turbo builds shared first), 2) node test/resume-mode-cycles.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME (host.ts log dir) AND a sandboxed HOME so resume()'s engineTranscriptExists
// reads under the temp dir, never the real ~/.claude. Set BEFORE importing dist (paths.ts/os.homedir). ---
const tmpHome = path.join(os.tmpdir(), `loom-rmc-${Date.now()}-${process.pid}`);
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

// The config default a FRESH spawn must carry (read from resolveConfig, not hardcoded — robust to a
// future default change). Sanity-pin it to a positive count so the fresh-vs-resume contrast is meaningful.
const CONFIG_CYCLES = resolveConfig({}).permission.startupModeCycles;
check("(setup) config default startupModeCycles is a positive count (fresh spawns cycle)",
  typeof CONFIG_CYCLES === "number" && CONFIG_CYCLES > 0);

// --- a real temp git repo so a manager session has a real cwd/HEAD (no worktree needed for resume) ---
const repo = path.join(os.tmpdir(), `loom-rmc-repo-${Date.now()}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# resume-mode-cycles test\n");
execSync(`git init -q && git add . && git -c user.email=rmc@loom -c user.name=rmc commit -q -m init`, { cwd: repo });

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pP", name: "P", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: "agentMgr", projectId: "pP", name: "Mgr", startupPrompt: "MGR_PROMPT", position: 0, profileId: null });

// Capture every SpawnOpts via the createPty() seam (mirrors profile-spawn.mjs / browser-testing-spawn.mjs).
class SeamHost extends PtyHost {
  constructor(events) { super(events); this.capture = []; }
  createPty(opts) { this.capture.push(opts); return { pid: 4242, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} }; }
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

try {
  // ===================== FRESH spawn → carries the config's startupModeCycles (must cycle) =====================
  const sMgr = svc.startManager("agentMgr");
  const oFresh = optsFor(sMgr.id);
  check("(fresh) spawn carries the config startupModeCycles (boots acceptEdits, steps to target)",
    oFresh?.permission.startupModeCycles === CONFIG_CYCLES);
  check("(fresh) that count is > 0 (a fresh manager DOES cycle off the gate-free boot default)",
    (oFresh?.permission.startupModeCycles ?? 0) > 0);
  check("(fresh) boots at acceptEdits (the gate-free mode --permission-mode emits)",
    oFresh?.permission.mode === "acceptEdits");

  // ===================== RESUME the SAME session → startupModeCycles pinned to 0 (no overshoot) =====================
  // Give it an engine id + a sandboxed transcript so resume()'s resumability check passes.
  const engId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  db.setEngineSessionId(sMgr.id, engId);
  const tpath = engineTranscriptPath(repo, engId);
  fs.mkdirSync(path.dirname(tpath), { recursive: true });
  fs.writeFileSync(tpath, JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n");
  host.capture.length = 0; // isolate the resume's captured opts
  svc.resume(sMgr.id);
  const oResume = optsFor(sMgr.id);
  check("(resume) spawn pins startupModeCycles to 0 (leave the restored mode — no Shift+Tab overshoot)",
    oResume?.permission.startupModeCycles === 0);
  check("(resume) still re-passes the role (a resumed manager keeps its orchestration surface)",
    oResume?.role === "manager");
  check("(resume) still passes resumeId (it IS a --resume, not a fresh spawn)",
    oResume?.resumeId === engId);

  // ===================== the contrast that IS the fix: fresh cycles, resume does not =====================
  check("(contract) RESUME cycles (0) differ from FRESH cycles (>0) — the resume path no longer overshoots",
    oResume?.permission.startupModeCycles === 0 && (oFresh?.permission.startupModeCycles ?? 0) > 0);
  // The override is resume-LOCAL: the shared config object the fresh spawn used is untouched (still > 0).
  check("(contract) the config default is NOT mutated by the resume override (fresh stays at the default)",
    resolveConfig({}).permission.startupModeCycles === CONFIG_CYCLES);
} finally {
  db.close(); // free the WAL handle before removing the temp dir (Windows)
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a FRESH spawn cycles off the gate-free boot default (config startupModeCycles), while a RESUME pins cycles to 0 so the restored acceptEdits/auto mode is left intact (never overshoots into plan) — claude-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
