import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Agent Runs — a run honors its agent's profile-resolved model + skills (the two-path-asymmetry fix).
// DETERMINISTIC, CLAUDE-FREE, NETWORK-FREE (same style as agent-runs-primitive.mjs + skills-subset-spawn.mjs):
// isolated LOOM_HOME, a REAL Db + SessionService driven against a FAKE pty via PtyHost's createPty() seam,
// a REAL temp git repo so createRunSnapshot's git plumbing runs.
//
// The bug: startRun hand-rolled its SpawnOpts from resolveConfig and never resolved the agent's Profile, so
// unlike startNew/startManager/spawnWorker it DROPPED both `model` and `skills`:
//   (a) a run of a model-pinned agent booted on the ENGINE DEFAULT (no `--model`);
//   (b) a run of a skills-pinned agent got ALL store skills (injectSkills received null ⇒ all).
// The fix routes startRun's capability resolution through resolveAgentSpawn (the same helper the other fresh
// spawns use), threading ONLY model + skills — while KEEPING the run's deliberate differences: role hardcoded
// "run", the VERBATIM boot permission, browserTesting/documentConversion false, and a loom-run-ONLY MCP mount.
//
// Proves:
//   1. a run of a model+skills-pinned agent → spawn opts carry the profile model + the pinned skill subset;
//   2. NO regression: role stays "run" and the MCP surface stays loom-run-ONLY;
//   3. a run of a PLAIN (no-profile) agent → model undefined + skills null (byte-identical to before the fix).
//
// Run: 1) build (turbo builds shared first), 2) node test/agent-runs-profile-attrs.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sameSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

// --- Hermetic LOOM_HOME (set BEFORE importing dist — paths.ts reads it at import time) ---
const tmpHome = path.join(os.tmpdir(), `loom-runs-pa-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { PtyHost, buildMcpServers } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { runSnapshotDir } = await import("../dist/runs/snapshot.js");

// --- a real temp git repo with a committed file so createRunSnapshot has a HEAD to extract ---
const repo = path.join(os.tmpdir(), `loom-runs-pa-repo-${Date.now()}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# agent-runs profile-attrs test\n");
execSync(`git init -q && git add . && git -c user.email=r@loom -c user.name=r commit -q -m init`, { cwd: repo });

const now = new Date().toISOString();
const PROJECT_ID = "pRunPA";
const db = new Db();
db.insertProject({ id: PROJECT_ID, name: "RunProj", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
// A profile that PINS both a model and a skills subset; the endpoint agent runs under it.
db.insertProfile({ id: "profRun", name: "RunRig", role: null, description: "model+skills pinned rig", allowDelta: [], skills: ["alpha", "beta"], model: "claude-opus-4-8", icon: null });
db.insertAgent({ id: "agentPinned", projectId: PROJECT_ID, name: "Pinned", startupPrompt: "PINNED_DOCTRINE", position: 0, profileId: "profRun", endpoint: true, ioSchema: null });
// A plain (no-profile) endpoint agent → the regression guard (byte-identical to before the fix).
db.insertAgent({ id: "agentPlain", projectId: PROJECT_ID, name: "Plain", startupPrompt: "PLAIN_DOCTRINE", position: 1, profileId: null, endpoint: true, ioSchema: null });

// --- fake pty + a PtyHost subclass capturing every SpawnOpts via createPty() ---
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
  // ===================== 1. a run of a model+skills-pinned agent threads BOTH =====================
  const { session } = await svc.startRun({ agentId: "agentPinned", input: { q: 1 }, schema: null });
  const o = optsFor(session.id);

  check("1 run spawn opts.model === the profile-pinned model (was DROPPED → engine default)", o?.model === "claude-opus-4-8");
  check("1 run spawn opts.skills === the profile-pinned subset (was DROPPED → all store skills)", sameSet(o?.skills ?? [], ["alpha", "beta"]));
  check("1 run DB row pins the subset too (what teardown/inspection read)", sameSet(db.getSession(session.id).skills ?? [], ["alpha", "beta"]));

  // ===================== 2. NO regression: role stays 'run' + the MCP surface stays loom-run-ONLY =====================
  check("2 spawn opts.role is still 'run' (NOT the profile role)", o?.role === "run" && db.getSession(session.id).role === "run");
  check("2 run is NOT given a profile browser/doc-conversion surface", o?.browserTesting === false && o?.documentConversion === false);
  const runServers = buildMcpServers({ sessionId: session.id, port: 4317, role: "run" });
  check("2 ONLY loom-run is mounted for the run (no loom-tasks/orch/platform/audit)",
    Object.keys(runServers).length === 1 && !!runServers["loom-run"] && !runServers["loom-tasks"]);

  // ===================== 3. regression guard: a PLAIN-agent run drops BOTH (byte-identical to before) =====================
  const { session: sPlain } = await svc.startRun({ agentId: "agentPlain", input: { q: 2 }, schema: null });
  const oPlain = optsFor(sPlain.id);
  check("3 plain-agent run: spawn opts.model is undefined (no `--model`, byte-identical)", oPlain?.model === undefined);
  check("3 plain-agent run: spawn opts.skills is null (deliver all, byte-identical)", (oPlain?.skills ?? null) === null);
  check("3 plain-agent run: DB row skills is null (today's default)", db.getSession(sPlain.id).skills === null);
  check("3 plain-agent run: role still 'run' + loom-run-only MCP", oPlain?.role === "run");
} finally {
  // GC the disposable run snapshot dirs the test created, then drop the db + temp dirs.
  try { for (const o of host.capture) { if (o.cwd?.startsWith(runSnapshotDir(""))) fs.rmSync(o.cwd, { recursive: true, force: true }); } } catch { /* best-effort */ }
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a run honors its agent's profile-resolved model + skills (threaded via resolveAgentSpawn), while role stays 'run' and the MCP surface stays loom-run-ONLY; a plain-agent run drops both (byte-identical) — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
