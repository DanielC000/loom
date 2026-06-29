import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Resume-path permission-mode assertion test (board card f05e4897 — "daemon-resumed manager lands in
// PLAN mode"). DETERMINISTIC + CLAUDE-FREE, hermetic like browser-testing-spawn.mjs / profile-spawn.mjs:
// isolated LOOM_HOME + a SANDBOXED HOME (so resume()'s engineTranscriptExists reads under the temp dir,
// never the real ~/.claude), a REAL Db + SessionService driven against a FAKE pty injected via PtyHost's
// createPty() seam. No real claude, no daemon, no network.
//
// Contract guarded here (card f05e4897, the SUPERSEDING fix): the startup Shift+Tab mode-cycling is
// RELATIVE to the boot mode. BOTH a FRESH spawn and a `claude --resume` boot at the gate-free `mode`
// (acceptEdits) — `--resume` HONOURS `--permission-mode`, it does NOT restore the persisted mode
// (probe-verified on 2.1.163). A FRESH spawn blind-cycles the config's startupModeCycles (2) to the
// target (auto). A RESUME instead converges ABSOLUTELY: SessionService.resume passes `resumeModeTarget`
// (= the mode that same count maps to, modeAfterCyclesFromAcceptEdits(2) = auto) and host.ts
// feedback-cycles the footer to it. The earlier blind approaches both misbehaved on the resume path
// (blind-2 half-landed on plan on the summary-gate path; blind-0 left it ONE short, stuck at acceptEdits).
//
// This asserts that contract at the seam: a FRESH spawn carries the config's startupModeCycles (blind
// cycling) and NO resumeModeTarget, while a RESUME of the SAME session carries resumeModeTarget=auto
// (feedback cycling) with startupModeCycles pinned to 0 (the blind branch is inert on resume).
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
const { modeAfterCyclesFromAcceptEdits } = await import("../dist/pty/host.js");

// The config default a FRESH spawn must carry (read from resolveConfig, not hardcoded — robust to a
// future default change). Sanity-pin it to a positive count so the fresh-vs-resume contrast is meaningful.
const CONFIG_CYCLES = resolveConfig({}).permission.startupModeCycles;
check("(setup) config default startupModeCycles is a positive count (fresh spawns cycle)",
  typeof CONFIG_CYCLES === "number" && CONFIG_CYCLES > 0);
// The mode a fresh spawn of the default config lands in — the SAME mode a resume must converge to.
const FRESH_TARGET_MODE = modeAfterCyclesFromAcceptEdits(CONFIG_CYCLES);
check("(setup) the default config's fresh target mode is auto (the owner's required resume mode)",
  FRESH_TARGET_MODE === "auto");

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
  // resume()'s already-live short-circuit consults pty.isAlive: this capture seam drives NO live OS pty,
  // so report not-live — the test resumes a (notionally stopped) session to inspect its resume spawn args.
  isAlive() { return false; }
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
  check("(fresh) carries NO resumeModeTarget (the fresh path blind-cycles, it does not feedback-cycle)",
    oFresh?.resumeModeTarget == null);

  // ===================== RESUME the SAME session → feedback-cycle to the fresh target (auto) =====================
  // Give it an engine id + a sandboxed transcript so resume()'s resumability check passes.
  const engId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  db.setEngineSessionId(sMgr.id, engId);
  const tpath = engineTranscriptPath(repo, engId);
  fs.mkdirSync(path.dirname(tpath), { recursive: true });
  fs.writeFileSync(tpath, JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n");
  host.capture.length = 0; // isolate the resume's captured opts
  svc.resume(sMgr.id);
  const oResume = optsFor(sMgr.id);
  check("(resume) spawn passes resumeModeTarget=auto (feedback-cycle the footer to the fresh target mode)",
    oResume?.resumeModeTarget === FRESH_TARGET_MODE && oResume?.resumeModeTarget === "auto");
  check("(resume) pins startupModeCycles to 0 (the FRESH blind branch is inert on the resume path)",
    oResume?.permission.startupModeCycles === 0);
  check("(resume) still re-passes the role (a resumed manager keeps its orchestration surface)",
    oResume?.role === "manager");
  check("(resume) still passes resumeId (it IS a --resume, not a fresh spawn)",
    oResume?.resumeId === engId);

  // ===================== the contrast that IS the fix: fresh blind-cycles, resume feedback-cycles =====================
  check("(contract) RESUME feedback-cycles to auto while FRESH blind-cycles (>0) — resume converges, never overshoots",
    oResume?.resumeModeTarget === "auto" && oResume?.permission.startupModeCycles === 0 && (oFresh?.permission.startupModeCycles ?? 0) > 0);
  // The override is resume-LOCAL: the shared config object the fresh spawn used is untouched (still > 0).
  check("(contract) the config default is NOT mutated by the resume override (fresh stays at the default)",
    resolveConfig({}).permission.startupModeCycles === CONFIG_CYCLES);
} finally {
  db.close(); // free the WAL handle before removing the temp dir (Windows)
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a FRESH spawn blind-cycles off the gate-free boot default (config startupModeCycles) with no resumeModeTarget, while a RESUME passes resumeModeTarget=auto so host.ts feedback-cycles the footer to the same target a fresh spawn reaches (startupModeCycles pinned 0, blind branch inert) — claude-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
