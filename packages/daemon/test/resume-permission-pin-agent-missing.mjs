import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1)
// Card e98877b1 — `SessionService.resume()`'s `resumePermission` fell back to bare `config.permission`
// when the session's `agentId` resolves to no row in `agents` — silently DROPPING every role-keyed
// permission pin `resolveAgentSpawn` applies (today: the worker/assistant `startupModeCycles` → `auto`
// pin, audit finding 760cd01d / card 5603f40f), and reverting the resumed session to the project's
// shared `permission.startupModeCycles` knob instead. Same defect SHAPE card 3388be4d fixed one field
// over for the transcript-root deny (see transcript-root-deny-spawn-paths.mjs) — but a DIFFERENT fix
// site: that fix moved to the `createPty` chokepoint (pty/host.ts), keyed off `opts.role`; this one stays
// inside sessions/service.ts (the deny is a spawn-time settings.json concern read at the chokepoint that
// serves EVERY pty.spawn call site, while the mode-cycles pin is resume()-local and the card's own
// contended-file-set keeps this fix inside sessions/service.ts only — see e98877b1's body).
//
// THE FIX: `withRolePermissionModeCyclesPin(permission, role)` (sessions/service.ts, exported) is the
// pin's ONE derivation, keyed off the role alone — `resolveAgentSpawn` (agent-present path) and
// `resume()`'s agent-missing fallback both call it, so there is no second, driftable copy of the pin
// logic (the card's own explicit "do NOT fix this by making the fallback a copy" instruction).
//
// PROVES:
//   - (agent MISSING) a WORKER-role resume still lands its resumeModeTarget at "auto", not the project's
//     own (deliberately non-auto-producing) startupModeCycles knob.
//   - (agent MISSING) an ASSISTANT-role resume: same.
//   - (agent MISSING, CONTROL ARM) a MANAGER-role resume — NOT in the pinned-role set — still tracks the
//     project's own knob even with its agent gone, proving the fallback isn't just blanket-forcing every
//     agent-missing resume to "auto" (which would make the worker/assistant assertions above prove
//     nothing about role-scoping).
//   - (agent PRESENT, DoD-2) a worker/assistant resume with its agent intact is BYTE-IDENTICAL to before
//     this fix — same resumeModeTarget, same permission.startupModeCycles.
//   - `withRolePermissionModeCyclesPin` itself: worker/assistant get the pin: manager/undefined get the
//     SAME OBJECT REFERENCE back (a real no-op, not just an equal-shaped copy).
//
// THE "AGENT ROW MISSING BUT SESSION SURVIVES" STATE: reused verbatim from transcript-root-deny-spawn-
// paths.mjs's own `deleteAgentLeavingSessionsBehind` — better-sqlite3 defaults `PRAGMA foreign_keys = ON`,
// and `deleteAgent()`'s own app-level cascade is the ONLY way the app itself ever removes an agent with
// live sessions, so this state (an agent gone, its session intact) is constructed the same way that file
// documents: a raw FK-disabled DELETE, standing in for the external-DB-surgery shape (a hand-run SQL
// script, an imported/restored DB) the card itself names as the real-world trigger, not a normal
// application code path.
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic like assistant-mode-pin.mjs / transcript-root-
// deny-spawn-paths.mjs: isolated LOOM_HOME + a sandboxed HOME, a REAL Db + SessionService driven against a
// FAKE pty via PtyHost's createPty() seam — no real claude, no daemon, no network, no git repo needed
// (resume() itself never touches git).
//
// Run: 1) build (turbo builds shared first), 2) node test/resume-permission-pin-agent-missing.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME (resume()'s engineTranscriptExists must never touch the real
// ~/.claude). Set BEFORE importing dist (paths.ts/os.homedir reads happen at module load). ---
const tmpHome = path.join(os.tmpdir(), `loom-rppam-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService, withRolePermissionModeCyclesPin } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");
const { resolveConfig } = await import("@loom/shared");
const { modeAfterCyclesFromAcceptEdits, cyclesToReachFromAcceptEdits } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

// --- a plain (non-git) project dir — resume() never touches git ---
const repo = path.join(os.tmpdir(), `loom-rppam-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });

const now = new Date().toISOString();
const db = new Db();
// The project deliberately disables the boot-cycle knob (0 cycles ⇒ stays at acceptEdits) — a value that
// is NOT what the worker/assistant pin targets (auto), so a resumed session landing on "auto" anyway is a
// real discriminator, not a coincidence of the project's own default (mirrors assistant-mode-pin.mjs's
// own discriminating-pair rationale).
db.insertProject({ id: "p1", name: "P", repoPath: repo, vaultPath: repo, config: { permission: { startupModeCycles: 0 } }, createdAt: now, archivedAt: null });
const resolved = resolveConfig({ permission: { startupModeCycles: 0 } });
check("(setup) the project's resolved config really carries startupModeCycles:0", resolved.permission.startupModeCycles === 0);

db.insertAgent({ id: "agentMgrLive", projectId: "p1", name: "Mgr", startupPrompt: "M", position: 0, profileId: null });

/** Seed a resumable session row directly against a REAL agent row (bypasses spawn). */
function seedSource(id, agentId, role) {
  const engId = `${id}-eng-0000-0000-000000000000`;
  db.insertSession({ id, projectId: "p1", agentId, engineSessionId: engId, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role });
  const tpath = engineTranscriptPath(repo, engId);
  fs.mkdirSync(path.dirname(tpath), { recursive: true });
  fs.writeFileSync(tpath, JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n");
  return engId;
}

/** Construct the "agent row missing, session survives" state — verbatim technique from
 *  transcript-root-deny-spawn-paths.mjs's own `deleteAgentLeavingSessionsBehind` (see that file's doc for
 *  why a raw FK-disabled DELETE, not deleteAgent()'s own cascade, is what's actually reachable here). */
function deleteAgentLeavingSessionsBehind(agentId) {
  db.db.pragma("foreign_keys = OFF");
  try { db.db.prepare("DELETE FROM agents WHERE id = ?").run(agentId); }
  finally { db.db.pragma("foreign_keys = ON"); }
}

class SeamHost extends createSeamHost(PtyHost) {
  constructor(events) { super(events); this.capture = []; }
  createPty(opts) { this.capture.push(opts); return super.createPty(opts); }
  isAlive() { return false; } // no real OS pty behind this seam — resume()'s already-live short-circuit must not trip
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());
const lastOptsFor = (sid) => [...host.capture].reverse().find((o) => o.sessionId === sid);

try {
  // ===================== withRolePermissionModeCyclesPin itself: the pure derivation =====================
  const basePermission = resolved.permission;
  const workerPinned = withRolePermissionModeCyclesPin(basePermission, "worker");
  const assistantPinned = withRolePermissionModeCyclesPin(basePermission, "assistant");
  const managerPinned = withRolePermissionModeCyclesPin(basePermission, "manager");
  const undefinedRolePinned = withRolePermissionModeCyclesPin(basePermission, undefined);
  check("(pure fn) worker role is pinned to the auto-reaching cycle count", workerPinned.startupModeCycles === cyclesToReachFromAcceptEdits("auto"));
  check("(pure fn) assistant role is pinned to the auto-reaching cycle count", assistantPinned.startupModeCycles === cyclesToReachFromAcceptEdits("auto"));
  check("(pure fn) manager role is a NO-OP — the SAME object reference back (byte-identical, not just equal-shaped)", managerPinned === basePermission);
  check("(pure fn) undefined role is a NO-OP — the SAME object reference back", undefinedRolePinned === basePermission);

  // ===================== agent MISSING: WORKER resume still lands on "auto" (THE FIX) =====================
  db.insertAgent({ id: "agentGoneWorker", projectId: "p1", name: "GoneW", startupPrompt: "", position: 1, profileId: null });
  seedSource("srcWorkerMissing", "agentGoneWorker", "worker");
  deleteAgentLeavingSessionsBehind("agentGoneWorker");
  check("(setup) srcWorkerMissing's agent is genuinely gone", db.getAgent("agentGoneWorker") === undefined);
  check("(setup) srcWorkerMissing itself SURVIVED the agent's deletion (unlike deleteAgent's own cascade)", db.getSession("srcWorkerMissing") !== undefined);
  host.capture.length = 0;
  const resumedWorker = svc.resume("srcWorkerMissing");
  const oWorkerMissing = lastOptsFor(resumedWorker.id);
  check("(resume worker, agent MISSING) resumeModeTarget is 'auto' — the pin SURVIVES the missing agent row, not the project's own 0",
    oWorkerMissing?.resumeModeTarget === "auto");
  check("(resume worker, agent MISSING) that target really diverges from what the bare project knob alone would produce (acceptEdits) — the discriminator is real",
    modeAfterCyclesFromAcceptEdits(resolved.permission.startupModeCycles ?? 0) === "acceptEdits" && oWorkerMissing?.resumeModeTarget !== "acceptEdits");
  check("(resume worker, agent MISSING) opts.role is still correctly 'worker' (the pinned row value, not agent-derived)", oWorkerMissing?.role === "worker");

  // ===================== agent MISSING: ASSISTANT resume still lands on "auto" (THE FIX, generalizes) =====================
  db.insertAgent({ id: "agentGoneAssistant", projectId: "p1", name: "GoneA", startupPrompt: "", position: 2, profileId: null });
  seedSource("srcAssistantMissing", "agentGoneAssistant", "assistant");
  deleteAgentLeavingSessionsBehind("agentGoneAssistant");
  host.capture.length = 0;
  const resumedAssistant = svc.resume("srcAssistantMissing");
  const oAssistantMissing = lastOptsFor(resumedAssistant.id);
  check("(resume assistant, agent MISSING) resumeModeTarget is 'auto'", oAssistantMissing?.resumeModeTarget === "auto");
  check("(resume assistant, agent MISSING) opts.role is still correctly 'assistant'", oAssistantMissing?.role === "assistant");

  // ===================== agent MISSING, CONTROL ARM: MANAGER resume still tracks the project's OWN knob =====================
  // Manager is NOT in the pinned-role set — without this control, "worker/assistant land on auto" would
  // prove nothing about role-scoping if the fallback just blanket-forced every agent-missing resume to
  // auto regardless of role.
  db.insertAgent({ id: "agentGoneMgr", projectId: "p1", name: "GoneM", startupPrompt: "", position: 3, profileId: null });
  seedSource("srcMgrMissing", "agentGoneMgr", "manager");
  deleteAgentLeavingSessionsBehind("agentGoneMgr");
  host.capture.length = 0;
  const resumedMgr = svc.resume("srcMgrMissing");
  const oMgrMissing = lastOptsFor(resumedMgr.id);
  check("(resume manager, agent MISSING, CONTROL) resumeModeTarget stays 'acceptEdits' — the project's own knob (0 cycles), untouched by the worker/assistant pin",
    oMgrMissing?.resumeModeTarget === "acceptEdits");
  check("(resume manager, agent MISSING, CONTROL) opts.role is still correctly 'manager'", oMgrMissing?.role === "manager");

  // ===================== DoD-2: agent PRESENT — byte-identical to before this fix =====================
  seedSource("srcWorkerPresent", "agentMgrLive", "worker");
  host.capture.length = 0;
  const resumedWorkerPresent = svc.resume("srcWorkerPresent");
  const oWorkerPresent = lastOptsFor(resumedWorkerPresent.id);
  check("(resume worker, agent PRESENT, DoD-2) resumeModeTarget is 'auto' (via resolveAgentSpawn, unchanged code path)", oWorkerPresent?.resumeModeTarget === "auto");
  check("(resume worker, agent PRESENT, DoD-2) permission.startupModeCycles is pinned to 0 (the blind resume branch, unchanged)", oWorkerPresent?.permission.startupModeCycles === 0);

  seedSource("srcAssistantPresent", "agentMgrLive", "assistant");
  host.capture.length = 0;
  const resumedAssistantPresent = svc.resume("srcAssistantPresent");
  const oAssistantPresent = lastOptsFor(resumedAssistantPresent.id);
  check("(resume assistant, agent PRESENT, DoD-2) resumeModeTarget is 'auto' (via resolveAgentSpawn, unchanged code path)", oAssistantPresent?.resumeModeTarget === "auto");

  seedSource("srcMgrPresent", "agentMgrLive", "manager");
  host.capture.length = 0;
  const resumedMgrPresent = svc.resume("srcMgrPresent");
  const oMgrPresent = lastOptsFor(resumedMgrPresent.id);
  check("(resume manager, agent PRESENT, DoD-2, CONTROL) resumeModeTarget stays 'acceptEdits' (the project's own knob, unchanged)", oMgrPresent?.resumeModeTarget === "acceptEdits");
} finally {
  db.close(); // free the WAL handle before removing the temp dir (Windows)
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a resumed WORKER or ASSISTANT session keeps its role-keyed startupModeCycles→auto pin even when its agent row has been deleted out from under it (card e98877b1), a MANAGER resume under the SAME agent-missing condition still tracks the project's own knob (the discriminating control arm proving this isn't a blanket agent-missing override), an agent-PRESENT resume is byte-identical to before this fix, and the extracted `withRolePermissionModeCyclesPin` helper is a true no-op (same object reference) for every role outside the pinned set — claude-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
