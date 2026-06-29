import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1)
// Fork-path allowlist parity test: forkSession must re-resolve the LAYERED allowlist exactly like
// resume(), not pass the bare config.permission (the two-path-asymmetry bug from the sessions review —
// fork was the one sibling spawn path that skipped withBaselineAllow + the profile allowDelta).
// DETERMINISTIC + CLAUDE-FREE, hermetic like spawn-allow-baseline.mjs / resume-mode-cycles.mjs: an
// isolated LOOM_HOME + a SANDBOXED HOME (so forkSession's engineTranscriptExists reads under the temp
// dir, never the real ~/.claude), a REAL Db + SessionService driven against a FAKE pty injected via
// PtyHost's createPty() seam, capturing the permission threaded to the forked spawn.
//
// PROVES, against a CUSTOM per-project permission.allow that resolveConfig substitutes WHOLESALE and
// that OMITS the task-board baseline:
//   (a) a fork of a profile-pinned manager is HEALED — the spawned fork carries mcp__loom-tasks (no
//       first-tasks_* hang) AND the profile's allowDelta entries (no silent loss);
//   (b) a fork in the DEFAULT-config project stays BYTE-IDENTICAL to the resolved config allow.
//
// Run: 1) build (turbo builds shared first), 2) node test/fork-allow-baseline.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME (host.ts log dir) AND a sandboxed HOME so forkSession's engineTranscriptExists
// reads under the temp dir, never the real ~/.claude. Set BEFORE importing dist (paths.ts/os.homedir). ---
const tmpHome = path.join(os.tmpdir(), `loom-forkbl-${Date.now()}-${process.pid}`);
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

// --- a real temp git repo so the source/fork sessions have a real cwd/HEAD (fork needs no worktree) ---
const repo = path.join(os.tmpdir(), `loom-forkbl-repo-${Date.now()}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# fork-allow-baseline test\n");
execSync(`git init -q && git add . && git -c user.email=fb@loom -c user.name=fb commit -q -m init`, { cwd: repo });

const now = new Date().toISOString();
const BASELINE = "mcp__loom-tasks";
const CUSTOM_EXTRA = "Bash(echo CUSTOM_OK:*)";
const PROFILE_ALLOW = "Bash(echo PROFILE_OK:*)";
// A CUSTOM project permission.allow that DROPS the baseline (resolveConfig substitutes it wholesale, so
// without the fork fix every fork here loses the baseline AND the profile delta).
const customConfig = { permission: { allow: [CUSTOM_EXTRA] } };

const db = new Db();
db.insertProject({ id: "pCustom", name: "Custom", repoPath: repo, vaultPath: repo, config: customConfig, createdAt: now, archivedAt: null });
db.insertProject({ id: "pDefault", name: "Default", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
// A manager-role profile that confers an allowDelta — the forked agent is profile-pinned, so the fork
// must layer this delta on (the silent-loss case the fix heals).
db.insertProfile({ id: "profMgr", name: "Orchestrator", role: "manager", description: "rig blurb", allowDelta: [PROFILE_ALLOW], skills: null, model: null, icon: "🧭" });
db.insertAgent({ id: "agCustom", projectId: "pCustom", name: "Mgr", startupPrompt: "P", position: 0, profileId: "profMgr" });
db.insertAgent({ id: "agDefault", projectId: "pDefault", name: "Plain", startupPrompt: "P", position: 0, profileId: null });

// Sanity: the CUSTOM resolved config really did drop the baseline (so the fix is what restores it).
check("setup: the custom project's resolved config.permission.allow OMITS the baseline (wholesale override)",
  !resolveConfig(customConfig).permission.allow.includes(BASELINE) && resolveConfig(customConfig).permission.allow.includes(CUSTOM_EXTRA));

class SeamHost extends PtyHost {
  constructor(events) { super(events); this.capture = []; }
  createPty(opts) { this.capture.push(opts); return { pid: 1, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} }; }
}
const events = { onEngineSessionId(id, e) { db.setEngineSessionId(id, e); }, onBusy(id, b) { db.setBusy(id, b); }, onContextStats() {}, onRateLimited() {}, onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); } };
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());
const optsFor = (sid) => host.capture.find((o) => o.sessionId === sid);

// Helper: seed a forkable IDLE source session — needs an engineSessionId + an on-disk transcript
// (under the sandboxed HOME) so forkSession's engineTranscriptExists guard passes.
function seedSource(id, projectId, agentId, role) {
  const engId = `${id}-eng-0000-0000-000000000000`;
  db.insertSession({ id, projectId, agentId, engineSessionId: engId, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role });
  const tpath = engineTranscriptPath(repo, engId);
  fs.mkdirSync(path.dirname(tpath), { recursive: true });
  fs.writeFileSync(tpath, JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n");
}

try {
  // (a) fork a profile-pinned MANAGER in the custom-allow project: baseline healed + allowDelta layered.
  seedSource("srcCustom", "pCustom", "agCustom", "manager");
  const fC = svc.forkSession("srcCustom");
  const oC = optsFor(fC.id);
  check("(a) fork in a custom-allow project HAS the mcp__loom-tasks baseline (healed — no first-tasks_* hang)",
    oC?.permission.allow.includes(BASELINE));
  check("(a) baseline appears exactly once (no duplicate)",
    oC.permission.allow.filter((t) => t === BASELINE).length === 1);
  check("(a) the forked profile-pinned manager KEEPS its profile allowDelta (no silent loss)",
    oC?.permission.allow.includes(PROFILE_ALLOW));
  check("(a) the custom allow's own entry is preserved too (union ADDS, not replaces)",
    oC?.permission.allow.includes(CUSTOM_EXTRA));
  check("(a) fork carries the source role (a forked manager keeps its orchestration surface)",
    oC?.role === "manager");
  check("(a) fork IS a --fork-session of the source transcript (resumeId = source engine id)",
    oC?.fork === true && oC?.resumeId === "srcCustom-eng-0000-0000-000000000000");

  // (b) fork in the DEFAULT-config project: BYTE-IDENTICAL to the resolved config allow (profile-less).
  seedSource("srcDefault", "pDefault", "agDefault", undefined);
  const fD = svc.forkSession("srcDefault");
  const oD = optsFor(fD.id);
  const defaultAllow = resolveConfig({}).permission.allow;
  check("(b) default-config fork: permission.allow EQUALS the resolved config allow (byte-identical)",
    JSON.stringify(oD?.permission.allow) === JSON.stringify(defaultAllow));
  check("(b) default-config fork: baseline present exactly once (no duplicate introduced)",
    oD.permission.allow.filter((t) => t === BASELINE).length === 1);
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — forkSession re-resolves the layered allowlist like resume(): the baseline is healed and the profile allowDelta layered for a custom-allow fork, and a default-config fork stays byte-identical."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
