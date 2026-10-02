import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 7955458e, SECOND Code Review MAJOR 3 — a regression matrix for the round-1 repro this card exists
// to close: a `{role:"worker", harness:"codex"}` profile assigned to an agent, then spawned via an
// EXPLICIT-ROLE start method (startManager/startPlatformLead/startAuditor/startWorkspaceAuditor/
// startSetup) — the exact mismatch `resolveAgentSpawn`'s role-based force (not validateProfile's
// save-time, profile-role-keyed reject, which never sees this) exists to catch, since each of these
// methods resolves a DIFFERENT role than the profile's own "worker" field. `startNew` has NO such bypass
// (it never overrides the profile's own role — assistant is tested with a `{role:"assistant",
// harness:"codex"}` profile instead; see its own section below for why).
//
// Plus the three further pieces that same review round asked for:
//   (SETUP) the Setup surface's session_spawn(manager) end to end (spawnSessionAsPlatform → startManager,
//     the exact call the loom-setup MCP tool makes — see mcp/setup.ts's own session_spawn handler).
//   (RESUME) ruling 1(b): resume() of a pre-existing codex-pinned row whose role forces claude boots
//     FRESH on claude under the SAME session id, both with and without the agent row present.
//   (SPAWN-REFUSAL) ruling 1(a): PtyHost.spawn's own fail-closed backstop throws CodexRoleSpawnRefusedError
//     for this exact opts.harness/opts.role combination, independent of any caller.
//
// DETERMINISTIC + CLAUDE/CODEX-FREE: a real Db + SessionService against a fake pty (createPty faked via
// the shared seam fixture; LOOM_CODEX_BIN at a dead path as a loud backstop — createCodexPty must never
// be reached by ANY assertion here, since the whole point is that the force happens before it would be).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";

const tmpHome = path.join(os.tmpdir(), `loom-crfsm-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
process.env.LOOM_CODEX_BIN = path.join(tmpHome, "no-such-codex-binary");

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { CodexRoleSpawnRefusedError } = await import("../dist/profiles/codex-compat.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const repo = path.join(os.tmpdir(), `loom-crfsm-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# codex-role-force-start-matrix test\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", "-c user.email=crfsm@loom -c user.name=crfsm");

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pX", name: "X", repoPath: repo, vaultPath: repo, config: { orchestration: { maxConcurrentWorkers: 50 }, permission: { startupModeCycles: 0 } }, createdAt: now, archivedAt: null });

// THE bypass fixture: a WORKER-rig profile with harness:"codex" — validateProfile's save-time reject
// checks THIS field (role:"worker" is not in TRANSCRIPT_ROOT_DENY_ROLES) and would never refuse it; the
// danger is entirely in an explicit-role start resolving a DIFFERENT role than this.
db.insertProfile({ id: "profWorkerCodex", name: "profWorkerCodex", role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null, harness: "codex" });
db.insertProfile({ id: "profAssistantCodex", name: "profAssistantCodex", role: "assistant", description: "", allowDelta: [], skills: null, model: null, icon: null, harness: "codex" });
const agent = (id, profileId) => db.insertAgent({ id, projectId: "pX", name: id, startupPrompt: id, position: 0, profileId });
agent("aForMgr", "profWorkerCodex");
agent("aForLead", "profWorkerCodex");
agent("aForAud", "profWorkerCodex");
agent("aForWsAud", "profWorkerCodex");
agent("aForSetup", "profWorkerCodex");
agent("aForAssistant", "profAssistantCodex");
agent("aForSetupSpawn", "profWorkerCodex");
agent("aForResume", undefined);
db.insertProfile({ id: "profMgrPlain", name: "profMgrPlain", role: "manager", description: "", allowDelta: [], skills: null, model: null, icon: null });
agent("aForResumeNormal", "profMgrPlain");

class SeamHost extends createSeamHost(PtyHost) {
  constructor(events) { super(events); this.spawned = []; }
  createPty(opts) { this.spawned.push({ ...opts, viaCodex: false }); return super.createPty(opts); }
  createCodexPty(opts) { this.spawned.push({ ...opts, viaCodex: true }); throw new Error("MUST NEVER REACH createCodexPty in this test"); }
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());
const optsFor = (sid) => host.spawned.filter((o) => o.sessionId === sid).pop();
const forcedEvent = (workerSessionId) => db.listEvents(workerSessionId).find((e) => e.kind === "harness_role_forced_claude" && e.workerSessionId === workerSessionId);

try {
  // ---------------- start-path matrix ----------------
  const m = svc.startManager("aForMgr");
  check("(startManager) resolved role is manager, forced to claude, never reaches createCodexPty", m.role === "manager" && m.harness === undefined && optsFor(m.id)?.harness === undefined && optsFor(m.id)?.viaCodex === false);
  check("(startManager) harness_role_forced_claude filed naming role:manager + agentId", forcedEvent(m.id)?.detail.role === "manager" && forcedEvent(m.id)?.detail.agentId === "aForMgr");

  const lead = svc.startPlatformLead("aForLead");
  check("(startPlatformLead) resolved role is platform, forced to claude, never reaches createCodexPty", lead.role === "platform" && lead.harness === undefined && optsFor(lead.id)?.harness === undefined && optsFor(lead.id)?.viaCodex === false);
  check("(startPlatformLead) harness_role_forced_claude filed naming role:platform + agentId", forcedEvent(lead.id)?.detail.role === "platform" && forcedEvent(lead.id)?.detail.agentId === "aForLead");

  const aud = svc.startAuditor("aForAud");
  check("(startAuditor) resolved role is auditor, forced to claude, never reaches createCodexPty", aud.role === "auditor" && aud.harness === undefined && optsFor(aud.id)?.harness === undefined && optsFor(aud.id)?.viaCodex === false);
  check("(startAuditor) harness_role_forced_claude filed naming role:auditor + agentId", forcedEvent(aud.id)?.detail.role === "auditor" && forcedEvent(aud.id)?.detail.agentId === "aForAud");

  const wsAud = svc.startWorkspaceAuditor("aForWsAud");
  check("(startWorkspaceAuditor) resolved role is workspace-auditor, forced to claude, never reaches createCodexPty", wsAud.role === "workspace-auditor" && wsAud.harness === undefined && optsFor(wsAud.id)?.harness === undefined && optsFor(wsAud.id)?.viaCodex === false);
  check("(startWorkspaceAuditor) harness_role_forced_claude filed naming role:workspace-auditor + agentId", forcedEvent(wsAud.id)?.detail.role === "workspace-auditor" && forcedEvent(wsAud.id)?.detail.agentId === "aForWsAud");

  const setup = svc.startSetup("aForSetup");
  check("(startSetup) resolved role is setup, forced to claude, never reaches createCodexPty", setup.role === "setup" && setup.harness === undefined && optsFor(setup.id)?.harness === undefined && optsFor(setup.id)?.viaCodex === false);
  check("(startSetup) harness_role_forced_claude filed naming role:setup + agentId", forcedEvent(setup.id)?.detail.role === "setup" && forcedEvent(setup.id)?.detail.agentId === "aForSetup");

  // startNew never overrides the profile's own role field (no bypass vector) — the meaningful fixture
  // here is a profile whose OWN role is already "assistant", confirming the force fires on the
  // straightforward (non-bypass) path too, since this role was never exercised in recycle-harness-reresolve.mjs.
  const assistant = svc.startNew("aForAssistant", { companionName: "TestBot" });
  check("(startNew assistant) resolved role is assistant, forced to claude, never reaches createCodexPty", assistant.role === "assistant" && assistant.harness === undefined && optsFor(assistant.id)?.harness === undefined && optsFor(assistant.id)?.viaCodex === false);
  check("(startNew assistant) harness_role_forced_claude filed naming role:assistant + agentId", forcedEvent(assistant.id)?.detail.role === "assistant" && forcedEvent(assistant.id)?.detail.agentId === "aForAssistant");

  // ---------------- (SETUP) Setup surface's session_spawn(manager), end to end ----------------
  // spawnSessionAsPlatform(projectId, agentId, "manager") is the EXACT call mcp/setup.ts's session_spawn
  // tool makes (after its own manager|plain-only role gate) — card 7955458e's round-1 repro specifically
  // named this path (Setup's profile_assign + session_spawn manager) as agent-reachable.
  const viaSetup = svc.spawnSessionAsPlatform("pX", "aForSetupSpawn", "manager");
  check("(SETUP) session_spawn(manager) on a worker-rig codex profile ⇒ forced to claude end to end", viaSetup.role === "manager" && viaSetup.harness === undefined && optsFor(viaSetup.id)?.harness === undefined && optsFor(viaSetup.id)?.viaCodex === false);
  check("(SETUP) harness_role_forced_claude filed", forcedEvent(viaSetup.id)?.detail.role === "manager" && forcedEvent(viaSetup.id)?.detail.agentId === "aForSetupSpawn");

  // ---------------- (RESUME) ruling 1(b) ----------------
  // A pre-existing row (simulating one that predates this fix, or whose profile changed shape since) with
  // harness:"codex" pinned directly on the ROW and role:"manager" — resume() must boot it FRESH on claude
  // under the SAME session id, never attempt a codex --resume (there's no real codex transcript here at
  // all — proving resume() never even touches the codex-transcript-exists guard for this path).
  const resumeRow = (id, agentId, extra = {}) => db.insertSession({
    id, projectId: "pX", agentId, engineSessionId: "fake-codex-engine-id", title: null, cwd: repo,
    processState: "exited", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager", harness: "codex", gen: 0, ...extra,
  });
  const rId = "resume-normal-1";
  resumeRow(rId, "aForResumeNormal");
  const resumed = svc.resume(rId);
  check("(RESUME) same session id in, same id out — no new row minted", resumed.id === rId);
  check("(RESUME) row's harness corrected to claude (undefined) in the DB", db.getSession(rId).harness === undefined);
  check("(RESUME) returned Session reflects the correction + live", resumed.harness === undefined && resumed.processState === "live");
  check("(RESUME) opts.harness undefined, routed via createPty (createCodexPty never reached)", optsFor(rId)?.harness === undefined && optsFor(rId)?.viaCodex === false);
  check("(RESUME) a FRESH spawn, never a --resume of the old codex engine id", optsFor(rId)?.resumeId === undefined);
  check("(RESUME) harness_role_forced_claude filed with trigger:resume", forcedEvent(rId)?.detail.role === "manager" && forcedEvent(rId)?.detail.trigger === "resume");

  // Agent-missing variant: resume()'s own fresh-start helper must fall back to a direct reason/role
  // construction (no resolveAgentSpawn to force through), mirroring recycleHarness's !spawn branch.
  const rId2 = "resume-ghost-1";
  db.insertAgent({ id: "ghostResumeAgent", projectId: "pX", name: "ghostResumeAgent", startupPrompt: "x", position: 0, profileId: null });
  resumeRow(rId2, "ghostResumeAgent");
  db.db.pragma("foreign_keys = OFF");
  db.db.prepare("DELETE FROM agents WHERE id = ?").run("ghostResumeAgent");
  let resumedGhost;
  try { resumedGhost = svc.resume(rId2); } finally { db.db.pragma("foreign_keys = ON"); }
  check("(RESUME agent-missing) same id, corrected to claude anyway", resumedGhost.id === rId2 && db.getSession(rId2).harness === undefined);
  check("(RESUME agent-missing) harness_role_forced_claude still filed with trigger:resume", forcedEvent(rId2)?.detail.role === "manager" && forcedEvent(rId2)?.detail.agentId === "ghostResumeAgent" && forcedEvent(rId2)?.detail.trigger === "resume");

  // CONTROL: an ordinary claude-pinned manager row resumes completely unchanged (this whole path is a
  // no-op for every role NOT in TRANSCRIPT_ROOT_DENY_ROLES ∩ harness:"codex" — proves the branch is
  // correctly gated, not firing unconditionally on every resume).
  const rIdControl = "resume-control-1";
  db.insertSession({
    id: rIdControl, projectId: "pX", agentId: "aForResumeNormal", engineSessionId: null, title: null, cwd: repo,
    processState: "exited", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager", gen: 0,
  });
  check("(RESUME CONTROL) a row with no engineSessionId and claude harness throws the ORDINARY no-engine-id error, never the forced-fresh-start path", (() => {
    try { svc.resume(rIdControl); return false; } catch (e) { return /no engine id to resume/.test(e.message); }
  })());

  // ---------------- (SPAWN-REFUSAL) ruling 1(a) ----------------
  // PtyHost.spawn's own fail-closed backstop — independent of any caller, throws BEFORE createCodexPty.
  const bareEvents = { onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} };
  const barePty = new PtyHost(bareEvents);
  let refusalErr;
  try {
    barePty.spawn({
      sessionId: "spawn-refusal-1", cwd: repo,
      permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
      geometry: { cols: 120, rows: 40 }, sessionEnv: {},
      role: "manager", harness: "codex",
    });
    refusalErr = null;
  } catch (e) { refusalErr = e; }
  check("(SPAWN-REFUSAL) PtyHost.spawn REFUSES harness:codex + role:manager", refusalErr instanceof CodexRoleSpawnRefusedError);
  check("(SPAWN-REFUSAL) error names the role", typeof refusalErr?.message === "string" && refusalErr.message.includes('role "manager"'));
  // CONTROL: the identical call with role:"worker" (never denied — worker is excluded from
  // TRANSCRIPT_ROOT_DENY_ROLES) does NOT throw this error (it may throw/attempt the real codex binary
  // spawn instead, since LOOM_CODEX_BIN is a dead path — any OTHER error is fine here; only confirming
  // this ISN'T the role-refusal).
  let controlErr;
  try {
    barePty.spawn({
      sessionId: "spawn-refusal-control-1", cwd: repo,
      permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
      geometry: { cols: 120, rows: 40 }, sessionEnv: {},
      role: "worker", harness: "codex",
    });
    controlErr = null;
  } catch (e) { controlErr = e; }
  check("(SPAWN-REFUSAL CONTROL) role:worker + harness:codex is NOT refused by this backstop (worker excluded by design)", !(controlErr instanceof CodexRoleSpawnRefusedError));
} finally {
  db.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the round-1 bypass is closed across every explicit-role start path, the Setup surface, resume(), and PtyHost.spawn's own backstop."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
