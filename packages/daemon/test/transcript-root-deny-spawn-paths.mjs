import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1)
// Card 3388be4d — the transcript-root deny (ac90ca8e/44fa586a) used to be applied ONLY inside
// `resolveAgentSpawn` (sessions/service.ts), exactly ONE of ten `pty.spawn` call sites. Six other paths —
// startRun, resume, forkSession, recycleWorker, recycleManager, recyclePlatformLead — reached `pty.spawn`
// with a permission that never passed through it, and resume/forkSession's own agent-row-MISSING fallback
// (`agent ? resolveAgentSpawn(...).permission : config.permission`) silently dropped the deny even for an
// otherwise-correctly-denied role (assistant/auditor/workspace-auditor).
//
// THE FIX moves the union to `withTranscriptRootDenyForSpawn` at the single `PtyHost.createPty` spawn
// chokepoint (pty/host.ts), keyed off the session's PINNED `role` (the DB row's own `role` column) rather
// than re-derived from the agent. THIS FILE proves that fix for the six non-fresh-spawn paths, by
// capturing each path's real SpawnOpts (via the createPty() seam — see _seam-host-fixture.mjs) and
// feeding `(opts.permission, opts.role)` through the REAL exported `withTranscriptRootDenyForSpawn` — the
// exact function the real (unfaked) createPty calls (this file's SeamHost, like every other seam-based
// test in this suite, never invokes the real createPty body itself). See
// transcript-root-deny-chokepoint.mjs for the pure-function proof + a REAL (unsubclassed) createPty spawn.
//
// PROVES:
//   GROUP A (role survives correctly): spawnWorker→recycleWorker (role "worker", hardcoded — OUT of the
//     BLANKET scope, byte-identical deny, since no projectId-bearing getOtherProjects is wired in this
//     seam test), startRun (role "run" — DoD-5's deliberate exclusion, byte-identical), AND (card d78f8217)
//     a manager row→recycleManager (role "manager") / startPlatformLead→recyclePlatformLead (role
//     "platform") — these two are now correctly IN the BLANKET deny set, so their chokepoint-applied deny
//     DOES include the rule (a change from this file's pre-d78f8217 assertions, which expected them OUT).
//   GROUP B (THE HEADLINE REGRESSION, resume() — plus a CORRECTION for forkSession()): resume() of an
//     assistant-role and an auditor-role session whose `agentId` points at NO row in `agents` — the exact
//     "delete a companion's agent row, then resume it" scenario the card describes. ⚠️ VERIFIED (and
//     initially assumed wrong): better-sqlite3 defaults `PRAGMA foreign_keys = ON` (measured: v11.10.0,
//     `db.pragma('foreign_keys', {simple:true}) === 1`) — a bare `db.insertSession` against a
//     never-inserted `agentId` THROWS `SQLITE_CONSTRAINT_FOREIGNKEY`, and (since there is no `ON DELETE
//     CASCADE` on `sessions.agent_id`) a plain `DELETE FROM agents` while a session still references it
//     throws the SAME way — which is EXACTLY why the daemon's own `deleteAgent()` (db.ts) explicitly
//     cascade-deletes every referencing session in the same transaction: with FK enforcement genuinely
//     on, there is no other way to remove an agent that still has sessions. So this state is NOT
//     reachable through `deleteAgent()`/`deleteProject()` (both cascade) — see
//     `deleteAgentLeavingSessionsBehind`'s own doc for how this file constructs it anyway (a raw
//     `foreign_keys = OFF` DELETE, bypassing the app-level cascade — the shape of external DB surgery,
//     not a normal application code path). Asserts: (1) `opts.role` is STILL correctly the pinned value
//     despite the missing agent, (2) the BARE captured `opts.permission.deny` does NOT include the rule
//     (documenting the exact pre-3388be4d gap), and (3) applying the chokepoint function to that same
//     captured `(permission, role)` DOES include it — the fix closes the gap regardless of what
//     resolveAgentSpawn itself produced, and regardless of HOW the agent came to be missing.
//     ⚠️ CORRECTION TO THE CARD: forkSession()'s OWN "agent missing" branch — which the card names
//     alongside resume()'s — is DEAD CODE, not a live gap: forkSession INSERTS A NEW session row carrying
//     `agentId: src.agentId`, so with FK enforcement on, that insert itself throws
//     `SQLITE_CONSTRAINT_FOREIGNKEY` before forkSession's own fallback conditional is ever reached (see
//     the test below, which reproduces the throw). The chokepoint move still structurally covers
//     forkSession (and every future path) regardless — this correction is about which pre-existing
//     defect was actually LIVE, not about whether the fix is worth taking.
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic like respawn-profile-attrs.mjs / fork-allow-
// baseline.mjs / platform-lead-recycle.mjs / agent-runs-primitive.mjs: isolated LOOM_HOME + a sandboxed
// HOME (so resume()/forkSession()'s engineTranscriptExists never touches the real ~/.claude), a REAL Db +
// SessionService driven against a FAKE pty via PtyHost's createPty() seam — no real claude, no daemon, no
// network. Worker paths use a REAL temp git repo (spawnWorker/recycleWorker create real git worktrees).
//
// Run: 1) build (turbo builds shared first), 2) node test/transcript-root-deny-spawn-paths.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const ROLE_DENY = "Read(~/.claude/projects/**)";

// --- Hermetic LOOM_HOME + a sandboxed HOME (so resume/forkSession's engineTranscriptExists reads under
// the temp dir, never the real ~/.claude). Set BEFORE importing dist (paths.ts/os.homedir). ---
const tmpHome = path.join(os.tmpdir(), `loom-trdsp-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

const { Db } = await import("../dist/db.js");
const { PtyHost, withTranscriptRootDenyForSpawn } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");

// The REAL chokepoint function applied to a captured spawn's (permission, role) — what the real (unfaked)
// createPty computes and writes into settings.json.
const finalDeny = (o) => withTranscriptRootDenyForSpawn(o?.permission, o?.role).deny;

// --- a real temp git repo so spawnWorker/recycleWorker's worktree plumbing runs ---
const repo = path.join(os.tmpdir(), `loom-trdsp-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# transcript-root-deny-spawn-paths test\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", "-c user.email=trdsp@loom -c user.name=trdsp");

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "p1", name: "P", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: true });
db.insertAgent({ id: "agentMgr1", projectId: "p1", name: "Mgr1", startupPrompt: "M", position: 0, profileId: null });
db.insertAgent({ id: "agentWorker", projectId: "p1", name: "Worker", startupPrompt: "W", position: 1, profileId: null });
db.insertAgent({ id: "agentLead", projectId: "p1", name: "Lead", startupPrompt: "L", position: 2, profileId: null });
db.insertAgent({ id: "agentRun", projectId: "p1", name: "Run", startupPrompt: "R", position: 3, profileId: null, endpoint: true, ioSchema: null });
db.insertSession({ id: "mgr1", projectId: "p1", agentId: "agentMgr1", engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
db.insertSession({ id: "mgrRig", projectId: "p1", agentId: "agentMgr1", engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
const tW = "22222222-2222-4222-8222-222222222222";
db.insertTask({ id: tW, projectId: "p1", title: "t", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });

// Fake pty: captures every SpawnOpts BEFORE the (faked) createPty runs — the SAME technique as every
// seam-based test in this suite (createSeamHost's own createPty never calls the real one).
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

/** Seed a resumable/forkable session row directly (bypasses spawn), against a REAL agent row. */
function seedSource(id, agentId, role) {
  const engId = `${id}-eng-0000-0000-000000000000`;
  db.insertSession({ id, projectId: "p1", agentId, engineSessionId: engId, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role });
  const tpath = engineTranscriptPath(repo, engId);
  fs.mkdirSync(path.dirname(tpath), { recursive: true });
  fs.writeFileSync(tpath, JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n");
  return engId;
}

/** Construct the "agent row missing" state a session's own row can be left in: better-sqlite3 defaults
 *  `PRAGMA foreign_keys = ON` (measured: v11.10.0, `db.pragma('foreign_keys', {simple:true}) === 1`), and
 *  neither `sessions.agent_id`'s declared `REFERENCES agents(id)` NOR SQLite's implicit ON DELETE NO
 *  ACTION lets a normal `DELETE FROM agents` succeed while a session still references it — which is
 *  EXACTLY why the daemon's own `deleteAgent()` (db.ts) explicitly cascade-deletes every referencing
 *  session in the SAME transaction (there is no other way to remove an agent with FK enforcement genuinely
 *  on). So "an agent row is gone but its session survives" is NOT reachable through any current
 *  application code path (`deleteAgent`/`deleteProject` both cascade) — it can only arise from something
 *  OUTSIDE the app's own write paths: a hand-run SQL script, an external DB browser, a restored/imported
 *  DB, or a connection with foreign_keys explicitly toggled off. This constructs exactly that: toggle FK
 *  enforcement off for ONE raw DELETE (bypassing `deleteAgent`'s cascade), then restore it — leaving a
 *  session row whose `agentId` resolves to nothing, which is the precise state resume()/forkSession()'s
 *  own `agent ? ... : config.permission` fallback branch is written to handle. */
function deleteAgentLeavingSessionsBehind(agentId) {
  db.db.pragma("foreign_keys = OFF");
  try { db.db.prepare("DELETE FROM agents WHERE id = ?").run(agentId); }
  finally { db.db.pragma("foreign_keys = ON"); }
}

let workerWorktree = null, recycledWorktree = null;
try {
  // ===================== GROUP A: hardcoded-role paths — role correctly OUT of scope =====================

  // --- spawnWorker → recycleWorker (role "worker", hardcoded in both) ---
  const w = await svc.spawnWorker("mgr1", { taskId: tW, agentId: "agentWorker", kickoffPrompt: "GO" });
  workerWorktree = w.worktreePath;
  check("(spawnWorker) opts.role === 'worker'", lastOptsFor(w.id)?.role === "worker");
  check("(spawnWorker) chokepoint deny is BYTE-IDENTICAL (worker is out of scope)", JSON.stringify(finalDeny(lastOptsFor(w.id))) === JSON.stringify(lastOptsFor(w.id)?.permission.deny));
  check("(spawnWorker) chokepoint deny does NOT include the transcript-root rule", !finalDeny(lastOptsFor(w.id)).includes(ROLE_DENY));

  host.capture.length = 0;
  const rw = await svc.recycleWorker("mgr1", w.id, "HANDOFF: continue.");
  recycledWorktree = rw.worktreePath;
  check("(recycleWorker) opts.role === 'worker'", lastOptsFor(rw.id)?.role === "worker");
  check("(recycleWorker) chokepoint deny is BYTE-IDENTICAL (worker is out of scope)", JSON.stringify(finalDeny(lastOptsFor(rw.id))) === JSON.stringify(lastOptsFor(rw.id)?.permission.deny));
  check("(recycleWorker) chokepoint deny does NOT include the transcript-root rule", !finalDeny(lastOptsFor(rw.id)).includes(ROLE_DENY));

  // --- recycleManager (role "manager", hardcoded) — card d78f8217: NOW blanket-denied ---
  host.capture.length = 0;
  const rm = await svc.recycleManager("mgrRig", "CONTINUE: pick up the fleet.");
  check("(recycleManager) opts.role === 'manager'", lastOptsFor(rm.id)?.role === "manager");
  check("(recycleManager) chokepoint deny DOES include the transcript-root rule (d78f8217 blanket)", finalDeny(lastOptsFor(rm.id)).includes(ROLE_DENY));

  // --- startPlatformLead → recyclePlatformLead (role "platform", hardcoded) — card d78f8217: NOW blanket-denied ---
  host.capture.length = 0;
  const lead = svc.startPlatformLead("agentLead");
  check("(startPlatformLead) opts.role === 'platform'", lastOptsFor(lead.id)?.role === "platform");
  check("(startPlatformLead) chokepoint deny DOES include the transcript-root rule (d78f8217 blanket)", finalDeny(lastOptsFor(lead.id)).includes(ROLE_DENY));

  host.capture.length = 0;
  const leadSucc = await svc.recyclePlatformLead(lead.id, "HANDOFF: platform work continues.");
  check("(recyclePlatformLead) opts.role === 'platform'", lastOptsFor(leadSucc.id)?.role === "platform");
  check("(recyclePlatformLead) chokepoint deny DOES include the transcript-root rule (d78f8217 blanket)", finalDeny(lastOptsFor(leadSucc.id)).includes(ROLE_DENY));

  // --- startRun (role "run" — DoD-5's DELIBERATE exclusion, not an accident of refactoring) ---
  host.capture.length = 0;
  const { session: runSession } = await svc.startRun({ agentId: "agentRun", input: {}, schema: null });
  check("(startRun) opts.role === 'run'", lastOptsFor(runSession.id)?.role === "run");
  check("(startRun) chokepoint deny does NOT include the transcript-root rule (deliberately excluded — see host.ts's withTranscriptRootDenyForSpawn doc)",
    !finalDeny(lastOptsFor(runSession.id)).includes(ROLE_DENY));

  // ===================== GROUP B: THE HEADLINE REGRESSION — agent row MISSING on resume/forkSession =====================
  // Each case gets its OWN throwaway agent (inserted, referenced by the session, THEN deleted out from
  // under it via deleteAgentLeavingSessionsBehind — see that helper's doc for why this, not a bare
  // never-inserted id, is what's actually reachable under this daemon's real FK enforcement).

  // --- resume(), role="assistant", agent row MISSING ---
  db.insertAgent({ id: "agentGoneAssistant1", projectId: "p1", name: "GoneA1", startupPrompt: "", position: 10, profileId: null });
  seedSource("srcAssistantMissing", "agentGoneAssistant1", "assistant");
  deleteAgentLeavingSessionsBehind("agentGoneAssistant1");
  check("(setup) srcAssistantMissing's agent is genuinely gone", db.getAgent("agentGoneAssistant1") === undefined);
  check("(setup) srcAssistantMissing itself SURVIVED the agent's deletion (unlike deleteAgent's own cascade)", db.getSession("srcAssistantMissing") !== undefined);
  const resumed = svc.resume("srcAssistantMissing");
  const oResumeMissing = lastOptsFor(resumed.id);
  check("(resume, agent MISSING) opts.role is STILL correctly 'assistant' (the pinned row value, not agent-derived)", oResumeMissing?.role === "assistant");
  check("(resume, agent MISSING) the BARE captured permission.deny does NOT include the rule (documents the pre-3388be4d gap: resolveAgentSpawn's fallback returns bare config.permission)",
    !oResumeMissing?.permission.deny.includes(ROLE_DENY));
  check("(resume, agent MISSING) — THE FIX — the CHOKEPOINT-applied deny DOES include the rule (closed regardless of what resolveAgentSpawn itself produced)",
    finalDeny(oResumeMissing).includes(ROLE_DENY));

  // --- resume(), role="auditor", agent row MISSING (the fix generalizes beyond assistant) ---
  db.insertAgent({ id: "agentGoneAuditor1", projectId: "p1", name: "GoneAud1", startupPrompt: "", position: 11, profileId: null });
  seedSource("srcAuditorMissing", "agentGoneAuditor1", "auditor");
  deleteAgentLeavingSessionsBehind("agentGoneAuditor1");
  const resumedAuditor = svc.resume("srcAuditorMissing");
  const oResumeAuditorMissing = lastOptsFor(resumedAuditor.id);
  check("(resume auditor, agent MISSING) opts.role is STILL correctly 'auditor'", oResumeAuditorMissing?.role === "auditor");
  check("(resume auditor, agent MISSING) the BARE captured permission.deny does NOT include the rule", !oResumeAuditorMissing?.permission.deny.includes(ROLE_DENY));
  check("(resume auditor, agent MISSING) — THE FIX — the CHOKEPOINT-applied deny DOES include the rule", finalDeny(oResumeAuditorMissing).includes(ROLE_DENY));

  // --- forkSession(), role="assistant", SOURCE's agent row MISSING ---
  // --- forkSession()'s OWN agent-missing fallback is UNREACHABLE, unlike resume()'s — VERIFIED, not
  // assumed: forkSession INSERTS A NEW session row carrying `agentId: src.agentId` (unlike resume(), which
  // only reads the existing row and never re-inserts), so with FK enforcement genuinely on, forking a
  // session whose agent is gone throws `SQLITE_CONSTRAINT_FOREIGNKEY` at that insert — BEFORE
  // forkSession's own `agent ? resolveAgentSpawn(...) : config.permission` fallback conditional is ever
  // reached. This is a real, measured correction to the card's own framing (it names forkSession as one of
  // six paths sharing resume()'s "agent-missing" defect) — the chokepoint move is still the right fix
  // (structurally correct for every CURRENT and FUTURE path, not just the ones with a live repro today),
  // but forkSession's specific agent-missing branch was already dead code, not a live regression.
  db.insertAgent({ id: "agentGoneAssistant2", projectId: "p1", name: "GoneA2", startupPrompt: "", position: 12, profileId: null });
  seedSource("srcForkAssistantMissing", "agentGoneAssistant2", "assistant");
  deleteAgentLeavingSessionsBehind("agentGoneAssistant2");
  let forkMissingAgentThrew = false;
  try { svc.forkSession("srcForkAssistantMissing"); }
  catch (e) { forkMissingAgentThrew = /FOREIGN KEY/i.test(e?.message ?? "") || e?.code === "SQLITE_CONSTRAINT_FOREIGNKEY"; }
  check("(forkSession, agent MISSING) THROWS a foreign-key error at its own new-row insert — this branch is dead code, not a live path (a real, measured correction to the card's framing)", forkMissingAgentThrew);

  // forkSession's REAL path is agent-PRESENT (the only state it can ever actually run in) — role/deny
  // thread correctly there too, both under the OLD code (resolveAgentSpawn applied the deny unconditionally
  // whenever an existing agent's spawn was resolved) and the new chokepoint.
  seedSource("srcForkAssistantPresent", "agentMgr1", "assistant");
  const forkedPresent = svc.forkSession("srcForkAssistantPresent");
  const oForkPresent = lastOptsFor(forkedPresent.id);
  check("(forkSession, agent present) opts.role === 'assistant'", oForkPresent?.role === "assistant");
  check("(forkSession, agent present) chokepoint deny INCLUDES the rule", finalDeny(oForkPresent).includes(ROLE_DENY));
} finally {
  try {
    const { removeWorktree } = await import("../dist/git/worktrees.js");
    for (const wt of [workerWorktree, recycledWorktree].filter(Boolean)) { try { await removeWorktree(repo, wt); } catch { /* best-effort */ } }
  } catch { /* best-effort */ }
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — recycleWorker/startRun stay correctly OUT of the transcript-root deny scope; recycleManager/startPlatformLead/recyclePlatformLead are now correctly IN it (card d78f8217's blanket widening); the headline regression is fixed for resume() (an assistant/auditor session whose agent row is MISSING still gets the deny at the createPty chokepoint, even though resolveAgentSpawn's own fallback drops it); and forkSession()'s OWN 'agent missing' branch is verified DEAD CODE (its own new-row insert throws a foreign-key error first) — a measured correction to the card's framing, not a live gap this file could reproduce."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
