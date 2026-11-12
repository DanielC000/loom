import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1)
// @decision 509176c8 — a locked-role profile's explicit skills subset must stay human-only at BOTH the
// profile-write-time guard AND the session-role chokepoint (an explicit-role spawn can diverge the two);
// this file proves both halves — do not treat either as sufficient on its own.
//
// Covers:
//   (A) agentLockedRoleSkillsError, pure function: every LOCKED_PROFILE_ROLES member rejects a non-empty
//       subset, allows null/[]/omitted; unlocked roles (worker/manager) and role:null are unaffected.
//   (B) roleChangeLockedSkillsCarryoverError, pure function: a role change into locked with a merged
//       non-empty subset is refused; a same-call clear is allowed; no-role-change and a flip into an
//       UNLOCKED role are never guarded; a locked->locked flip is guarded too.
//   (C) mcp/platform.ts profile_create: locked role + non-empty skills -> rejected, nothing created;
//       locked role + skills:null -> allowed; NEGATIVE CONTROL (unlocked role + skills) -> allowed.
//   (D) mcp/platform.ts profile_update: direct set on an already-locked profile; single-call
//       flip+set; single-call flip+clear (the manager-approved allowed shape); the TWO-CALL role-flip
//       bypass itself (set skills while unlocked, then flip role with no skills mention -> rejected,
//       nothing silently cleared); an ordinary edit (rename) of an already-locked profile that doesn't
//       mention skills -> allowed, proving the Lead's routine edits still work; NEGATIVE CONTROL
//       (unlocked role, ordinary skills update) -> allowed.
//   (E) mcp/setup.ts: confirms the existing role gate makes this surface's skills check unreachable in
//       practice (locked role refused before skills is ever considered), for both profile_create and a
//       role-flip profile_update.
//   (F) REST (POST /api/profiles, PUT /api/profiles/:id) stays completely UNCHANGED: a human can create
//       a locked-role profile with a non-empty skills subset, or flip role+set skills in one PUT.
//
// Run: 1) build (turbo builds shared first), 2) node test/profile-locked-role-skills.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-locked-skills-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
// A SANDBOXED HOME too (CLAUDE_CONFIG_DIR is unset here, so engineTranscriptExists falls back to
// os.homedir() — card a92a0913: read fresh per call now, not cached at import, but set BEFORE any dist
// import regardless, same as every other LOOM_HOME-derived constant below) so forkSession's/resume()'s
// engineTranscriptExists reads under this temp dir, never the real ~/.claude — mirrors
// fork-allow-baseline.mjs's own setup.
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME
// @decision a92a0913 — also delete an ambient CLAUDE_CONFIG_DIR: claudeConfigHome() reads it ahead of
// os.homedir(), so an inherited value would bypass the HOME/USERPROFILE override above entirely.
delete process.env.CLAUDE_CONFIG_DIR;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { SetupMcpRouter } = await import("../dist/mcp/setup.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { agentLockedRoleSkillsError, roleChangeLockedSkillsCarryoverError, LOCKED_PROFILE_ROLES } =
  await import("../dist/profiles/validate.js");

const LOCKED_ROLES = [...LOCKED_PROFILE_ROLES];
check("(setup) LOCKED_PROFILE_ROLES is non-empty and excludes manager/worker",
  LOCKED_ROLES.length > 0 && !LOCKED_ROLES.includes("manager") && !LOCKED_ROLES.includes("worker"));

// ===================== (A) agentLockedRoleSkillsError — pure function =====================
for (const role of LOCKED_ROLES) {
  check(`(A:${role}) non-empty skills + locked role -> REJECTED`,
    typeof agentLockedRoleSkillsError({ skills: ["agent-written"] }, role) === "string");
  check(`(A:${role}) skills:null + locked role -> allowed (clearing is a reduction)`,
    agentLockedRoleSkillsError({ skills: null }, role) === null);
  check(`(A:${role}) skills:[] + locked role -> allowed (clearing is a reduction)`,
    agentLockedRoleSkillsError({ skills: [] }, role) === null);
  check(`(A:${role}) no "skills" key at all + locked role -> allowed (unrelated patch untouched)`,
    agentLockedRoleSkillsError({ name: "x" }, role) === null);
}
check("(A) unlocked role (worker) + non-empty skills -> allowed (stays agent-settable as today)",
  agentLockedRoleSkillsError({ skills: ["x"] }, "worker") === null);
check("(A) unlocked role (manager) + non-empty skills -> allowed",
  agentLockedRoleSkillsError({ skills: ["x"] }, "manager") === null);
check("(A) role:null + non-empty skills -> allowed (null is never locked)",
  agentLockedRoleSkillsError({ skills: ["x"] }, null) === null);
check("(A) role:undefined + non-empty skills -> allowed",
  agentLockedRoleSkillsError({ skills: ["x"] }, undefined) === null);
{
  const err = agentLockedRoleSkillsError({ skills: ["x"] }, "assistant");
  check("(A) the refusal names \"skills\" and the offending role",
    typeof err === "string" && err.includes("skills") && err.includes("assistant"));
}
check("(A) a non-array skills value (invalid shape, would already fail schema validation upstream) is never treated as non-empty",
  agentLockedRoleSkillsError({ skills: "not-an-array" }, "assistant") === null);

// ===================== (B) roleChangeLockedSkillsCarryoverError — pure function =====================
for (const role of LOCKED_ROLES) {
  check(`(B:${role}) worker -> ${role} with MERGED non-empty skills -> REJECTED`,
    typeof roleChangeLockedSkillsCarryoverError("worker", role, ["x"]) === "string");
  check(`(B:${role}) worker -> ${role} with MERGED skills:null -> allowed (same-call clear)`,
    roleChangeLockedSkillsCarryoverError("worker", role, null) === null);
  check(`(B:${role}) worker -> ${role} with MERGED skills:[] -> allowed`,
    roleChangeLockedSkillsCarryoverError("worker", role, []) === null);
}
check("(B) no role change (same role, non-null) with non-empty skills -> allowed regardless (first check)",
  roleChangeLockedSkillsCarryoverError("assistant", "assistant", ["x"]) === null);
check("(B) no role change, both null -> allowed",
  roleChangeLockedSkillsCarryoverError(null, null, ["x"]) === null);
check("(B) role change into an UNLOCKED role (worker) with non-empty skills -> allowed (never guarded)",
  roleChangeLockedSkillsCarryoverError("manager", "worker", ["x"]) === null);
check("(B) role change into null -> allowed",
  roleChangeLockedSkillsCarryoverError("worker", null, ["x"]) === null);
check("(B) a locked -> DIFFERENT locked flip (assistant -> setup) with non-empty skills -> REJECTED",
  typeof roleChangeLockedSkillsCarryoverError("assistant", "setup", ["x"]) === "string");

// ===================== DB + MCP test harness (mirrors profile-grant-reach.mjs) =====================
function mkDb(name) {
  const dbFile = path.join(tmpHome, `${name}.db`);
  return { dbFile, db: new Db(dbFile) };
}
function cleanup(e) {
  try { e.db.close(); } catch { /* ignore */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(e.dbFile + ext, { force: true }); } catch { /* ignore */ } }
}
function mkApp(e) {
  const stub = {};
  return buildServer({
    db: e.db, pty: { enqueueStdin: () => ({ delivered: true }) }, sessions: stub, mcp: stub, orchMcp: stub,
    platformMcp: stub, auditMcp: stub, userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub,
  });
}
const mkProfile = (e, id, over = {}) => {
  e.db.insertProfile({
    id, name: `Rig ${id}`, role: "worker", description: "", allowDelta: [], skills: null, model: null,
    icon: null, connections: [], capabilities: [], ...over,
  });
  return id;
};
async function mcpClient(router, sessionId) {
  const server = router.buildServer(sessionId);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "profile-locked-role-skills-test", version: "0" });
  await client.connect(clientT);
  return client;
}
const parseMcp = (res) => JSON.parse(res.content[0].text);

// ===================== (C) mcp/platform.ts profile_create =====================
{
  const e = mkDb("create-platform");
  const client = await mcpClient(new PlatformMcpRouter(e.db, {}), "any-caller");
  const call = (name, args) => client.callTool({ name, arguments: args }).then(parseMcp);

  const rejected = await call("profile_create", { profile: { name: "Bad", role: "assistant", restrictedTools: true, skills: ["agent-written"] } });
  check("(C) profile_create: locked role + non-empty skills -> REJECTED", typeof rejected.error === "string");
  check("(C) ...the refusal names skills and the role", rejected.error?.includes("skills") && rejected.error?.includes("assistant"));
  check("(C) ...nothing was created", e.db.listProfiles().length === 0);

  const okClear = await call("profile_create", { profile: { name: "Good", role: "assistant", restrictedTools: true, skills: null } });
  check("(C) profile_create: locked role + skills:null -> ALLOWED", !okClear.error);

  const okUnlocked = await call("profile_create", { profile: { name: "Worker", role: "worker", skills: ["x"] } });
  check("(C) NEGATIVE CONTROL: unlocked role (worker) + non-empty skills -> ALLOWED (unaffected by this fix)",
    !okUnlocked.error && okUnlocked.skills?.join() === "x");
  cleanup(e);
}

// ===================== (D) mcp/platform.ts profile_update =====================
{
  const e = mkDb("update-platform");
  const client = await mcpClient(new PlatformMcpRouter(e.db, {}), "any-caller");
  const call = (name, args) => client.callTool({ name, arguments: args }).then(parseMcp);

  // (D1) direct set on an already-locked profile -> rejected.
  const prof1 = mkProfile(e, "p1", { role: "assistant" });
  const r1 = await call("profile_update", { profileId: prof1, patch: { skills: ["x"] } });
  check("(D1) profile_update: direct skills set on an already-locked role -> REJECTED", typeof r1.error === "string");
  check("(D1) ...the profile's skills is untouched (still null)", e.db.getProfile(prof1).skills === null);

  // (D2) single-call flip + set -> rejected.
  const prof2 = mkProfile(e, "p2", { role: "worker" });
  const r2 = await call("profile_update", { profileId: prof2, patch: { role: "assistant", restrictedTools: true, skills: ["y"] } });
  check("(D2) profile_update: role flip + skills set in ONE call -> REJECTED", typeof r2.error === "string");
  check("(D2) ...the role landed unchanged (still worker)", e.db.getProfile(prof2).role === "worker");

  // (D3) single-call flip + clear -> ALLOWED (the manager-approved shape: flip and clear at once).
  const prof3 = mkProfile(e, "p3", { role: "worker", skills: ["z"] });
  const r3 = await call("profile_update", { profileId: prof3, patch: { role: "assistant", restrictedTools: true, skills: null } });
  check("(D3) profile_update: role flip AND clear skills in the SAME call -> ALLOWED", !r3.error);
  check("(D3) ...role landed", e.db.getProfile(prof3).role === "assistant");
  check("(D3) ...skills landed cleared", e.db.getProfile(prof3).skills === null);

  // (D4) THE TWO-CALL ROLE-FLIP BYPASS the card names: set skills while unlocked (call 1, allowed —
  // unaffected), then flip role in a LATER call that never mentions skills (call 2, must be rejected).
  const prof4 = mkProfile(e, "p4", { role: "worker" });
  const call1 = await call("profile_update", { profileId: prof4, patch: { skills: ["bypass"] } });
  check("(D4) call 1: setting skills while role is unlocked -> ALLOWED (as today)", !call1.error);
  const call2 = await call("profile_update", { profileId: prof4, patch: { role: "assistant", restrictedTools: true } });
  check("(D4) call 2: flipping role to locked, NOT mentioning skills -> REJECTED (the role-flip bypass)",
    typeof call2.error === "string");
  check("(D4) ...the role is still unflipped", e.db.getProfile(prof4).role === "worker");
  check("(D4) ...the subset from call 1 is still there (never silently dropped by the refusal)",
    e.db.getProfile(prof4).skills?.join() === "bypass");

  // (D5) an ORDINARY edit (rename) of an already-locked profile that already carries a (simulated
  // human-set) subset, and never mentions skills -> ALLOWED. Proves the fix doesn't block the Lead's
  // routine edits of a profile that legitimately carries a human-set subset.
  const prof5 = mkProfile(e, "p5", { role: "assistant", skills: ["human-set"] });
  const r5 = await call("profile_update", { profileId: prof5, patch: { name: "Renamed Companion" } });
  check("(D5) profile_update: an unrelated edit (rename) of an already-locked profile -> ALLOWED", !r5.error);
  check("(D5) ...the pre-existing subset survives completely untouched", e.db.getProfile(prof5).skills?.join() === "human-set");
  check("(D5) ...and the rename actually landed", e.db.getProfile(prof5).name === "Renamed Companion");

  // (D6) NEGATIVE CONTROL: ordinary skills update on an unlocked role -> still allowed, unaffected.
  const prof6 = mkProfile(e, "p6", { role: "worker" });
  const r6 = await call("profile_update", { profileId: prof6, patch: { skills: ["w1", "w2"] } });
  check("(D6) NEGATIVE CONTROL: unlocked-role skills update -> ALLOWED (unaffected by this fix)",
    !r6.error && e.db.getProfile(prof6).skills?.join() === "w1,w2");

  cleanup(e);
}

// ===================== (E) mcp/setup.ts — confirms the fix is unreachable in practice =====================
{
  const e = mkDb("setup-defense");
  const client = await mcpClient(new SetupMcpRouter(e.db, {}), "any-caller");
  const call = (name, args) => client.callTool({ name, arguments: args }).then(parseMcp);

  const r1 = await call("profile_create", { profile: { name: "Bad", role: "assistant", restrictedTools: true, skills: ["x"] } });
  check("(E) setup profile_create: a locked role is refused before skills ever matters", typeof r1.error === "string");
  check("(E) ...nothing was created", e.db.listProfiles().length === 0);

  const prof = mkProfile(e, "p-setup", { role: "worker", skills: ["x"] });
  const r2 = await call("profile_update", { profileId: prof, patch: { role: "assistant", restrictedTools: true } });
  check("(E) setup profile_update: a role flip to locked is refused (existing role gate fires first)",
    typeof r2.error === "string");
  check("(E) ...the role is untouched", e.db.getProfile(prof).role === "worker");
  cleanup(e);
}

// ===================== (F) REST stays UNCHANGED — the human path ====================
{
  const e = mkDb("rest-unaffected");
  const app = await mkApp(e);

  const resCreate = await app.inject({
    method: "POST", url: "/api/profiles",
    payload: { name: "Human Companion", role: "assistant", restrictedTools: true, skills: ["human-written"] },
  });
  check("(F) POST /api/profiles: a human can create a locked-role profile WITH a non-empty skills subset",
    resCreate.statusCode === 201);
  check("(F) ...the subset actually landed", JSON.parse(resCreate.payload).skills?.join() === "human-written");

  const prof = mkProfile(e, "p-rest", { role: "worker" });
  const resUpdate = await app.inject({
    method: "PUT", url: `/api/profiles/${prof}`, payload: { role: "assistant", restrictedTools: true, skills: ["rest-set"] },
  });
  check("(F) PUT /api/profiles/:id: a human can flip role to locked AND set skills in ONE call",
    resUpdate.statusCode === 200);
  const updated = JSON.parse(resUpdate.payload);
  check("(F) ...both landed", updated.role === "assistant" && updated.skills?.join() === "rest-set");
  cleanup(e);
}

// ===================== Round 2 (CR finding): the SESSION-role chokepoint =====================
// @decision 509176c8 — the session-role chokepoint (sessionSkillsForRole) is a SEPARATE layer from the
// profile-write guards above (A-F); see record 509176c8 (rounds 4-6) for the full mechanism. This
// section proves it.
//
// Covers:
//   (G) sessionSkillsForRole, pure function: every LOCKED_PROFILE_ROLES member drops a mismatched
//       profile role's non-empty subset; a MATCHING profile role is honoured unchanged (509176c8's own
//       design — this does NOT apply isTrustedForLockedRole to the subset branch); an unlocked session
//       role is never guarded, regardless of profile role.
//   (H) startAuditor (SessionService): a worker-role profile's agent-written subset, bound to an agent,
//       spawned with the EXPLICIT locked "auditor" role (the schedule_create/scheduler AND the REST
//       explicit-role-spawn route both funnel into this exact SessionService call, with no further
//       check on `skills` either way — testing it once covers both) -> the spawned pty's opts.skills is
//       null (dropped) and a `locked_role_skills_dropped` event is filed naming the real agent/profile
//       role pair. NEGATIVE CONTROL: the SAME profile role as the explicit role ("auditor" profile,
//       explicit "auditor") -> the subset is honoured unchanged, no event filed.
//   (I) startPlatformLead: the "flip a locked profile to worker, add skills while unlocked, then an
//       agent bound to it is spawned with an EXPLICIT locked role" variant named in the CR — same
//       mechanism, different concrete role pair (platform instead of auditor).
//   (J) a worker-role EXPLICIT spawn (startNew, role omitted, resolving via a worker-role profile) ->
//       the subset is NEVER guarded (role isn't locked at all) — NEGATIVE CONTROL that this fix doesn't
//       touch the unlocked case resolveAgentSpawn always honoured.
//   (K) resume(), via the codex-forced-fresh-start branch (isForcedRoleFreshStart — avoids needing a
//       real engine transcript): a session ALREADY PINNED (as if from before this fix shipped) with a
//       locked role + a mismatched-profile-role subset -> resume() drops it for THIS spawn AND (round 3)
//       PERSISTS null onto the row itself — see (M) below for why the persist is what actually closes
//       the residual (round 5 alone did not: see the CR round-2 finding this round fixes).
//   (L) forkSession: a source session with the SAME kind of pre-existing mismatch -> the fork inherits
//       the TRUST-RE-VALIDATED value, never the raw pinned one, AND (round 3) the SOURCE row's own
//       subset is also persisted to null.
//   (M) THE RE-MATCH CASE (round 3, the CR round-2 BLOCKING finding): a row already dropped-and-
//       persisted-null by one resume must STAY null even after the agent's profile is later reassigned
//       (or role-flipped) to a profile whose role MATCHES the session's locked role — proving the
//       predicate's role-comparison alone (round 5) was insufficient without the persist (round 3).
//   (M2) THE REAL DEDUPE PROOF (card 34530aad CR round 3 finding 2): resume TWICE with the MISMATCH
//       KEPT (never re-matching) — pre-fix code re-drops and re-files on every resume; post-fix persists
//       null on the first resume, so the second resume's own `normalized == null` guard fires first.
//       (M)'s own re-match scenario files no second event either way regardless of the fix, so it alone
//       never discriminated this — this case is what actually does.
//   (N) the ORDINARY (non-forced) resume() path, with a real engine transcript, also persists the drop.
//   (O) recyclePlatformLead: PERSISTS the drop onto the PREDECESSOR row, not just the fresh successor's.
//   (P) upgradeCompanionCapabilities (the assistant live re-pin): already a FRESH re-resolve (not a
//       carry-forward site), so it writes the trust-filtered value directly — no round-3 fix needed
//       here, but covered for completeness.
//   (Q) fail-closed inputs at a carry-forward site: a deleted agent, a deleted profile, and a sticky
//       `forcedPlain:true` row all resolve `profileRole` to null -> any locked session role mismatches
//       and the subset is dropped, never silently honoured.
{
  const { sessionSkillsForRole } = await import("../dist/profiles/validate.js");

  // ===================== (G) sessionSkillsForRole — pure function =====================
  for (const role of LOCKED_ROLES) {
    const mismatched = role === "worker" ? "manager" : "worker"; // always != role, and != role itself
    const dropRes = sessionSkillsForRole(role, mismatched, ["agent-written"]);
    check(`(G:${role}) locked session role + MISMATCHED profile role -> dropped (skills:null)`,
      dropRes.skills === null && dropRes.dropped === true);
    const keepRes = sessionSkillsForRole(role, role, ["human-set"]);
    check(`(G:${role}) locked session role + MATCHING profile role -> honoured unchanged`,
      keepRes.skills?.join() === "human-set" && keepRes.dropped === false);
  }
  check("(G) unlocked session role (worker) + mismatched profile role -> never guarded",
    sessionSkillsForRole("worker", "manager", ["x"]).skills?.join() === "x"
    && sessionSkillsForRole("worker", "manager", ["x"]).dropped === false);
  check("(G) unlocked session role (manager) + mismatched profile role -> never guarded",
    sessionSkillsForRole("manager", "worker", ["x"]).skills?.join() === "x"
    && sessionSkillsForRole("manager", "worker", ["x"]).dropped === false);
  check("(G) null skills -> never dropped, regardless of role",
    sessionSkillsForRole("auditor", "worker", null).dropped === false);
  check("(G) null session role -> never guarded (role null is never locked)",
    sessionSkillsForRole(null, "worker", ["x"]).skills?.join() === "x");
}

// ===================== SessionService harness (mirrors profile-spawn.mjs's fake-pty seam) =====================
process.env.LOOM_DEV = "1"; // isLoomDev() reads process.env LIVE (paths.ts) — safe to set this late.
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");

// Card ec7983c6: use the SHARED fake-pty fixture (not a local re-derivation — 115 near-duplicates of
// this exact class existed before that card consolidated them) with ONE local addition: a capture array.
class SeamHost extends createSeamHost(PtyHost) {
  constructor(events) { super(events); this.capture = []; }
  createPty(opts) { this.capture.push(opts); return super.createPty(opts); }
}
function mkSvc(e) {
  const events = {
    onEngineSessionId(id, eng) { e.db.setEngineSessionId(id, eng); },
    onBusy(id, busy) { e.db.setBusy(id, busy); },
    onContextStats() {}, onRateLimited() {},
    onExit(id) { e.db.setProcessState(id, "exited"); e.db.setBusy(id, false); },
  };
  const host = new SeamHost(events);
  const svc = new SessionService(e.db, host, new OrchestrationControl());
  return { svc, host, optsFor: (sid) => host.capture.find((o) => o.sessionId === sid) };
}
const mkProject = (e, id, repoPath) => {
  e.db.insertProject({ id, name: id, repoPath, vaultPath: repoPath, config: {}, createdAt: new Date().toISOString(), archivedAt: null });
  return id;
};
const mkAgentFor = (e, id, projectId, profileId) =>
  e.db.insertAgent({ id, projectId, name: id, startupPrompt: "", position: 0, profileId });
// listEvents(managerSessionId) filters by an EXACT manager_session_id — recordSkillsDropped attributes
// its event to the SESSION itself (mirrors recordHarnessRoleForced's own convention), not "" (the global,
// no-owning-session sentinel profile_grant_reach uses) — so query by KIND across every session instead.
const droppedEvents = (e) => e.db.listRecentEventsByKinds(["locked_role_skills_dropped"]);

// ===================== (H) startAuditor: the scheduler/REST explicit-role chain =====================
{
  const e = mkDb("session-auditor");
  const { svc, optsFor } = mkSvc(e);
  const projDir = path.join(tmpHome, "proj-h");
  fs.mkdirSync(projDir, { recursive: true });
  mkProject(e, "proj-h", projDir);
  // A WORKER-role profile carrying an agent-written subset — exactly what A-F's own negative controls
  // (C's "NEGATIVE CONTROL: unlocked role + non-empty skills -> ALLOWED") prove an agent CAN produce today.
  const prof = mkProfile(e, "prof-h-worker", { role: "worker", skills: ["agent-written"] });
  mkAgentFor(e, "agent-h", "proj-h", prof);

  const s = svc.startAuditor("agent-h");
  check("(H) startAuditor: the session's resolved role is \"auditor\" (the explicit role wins)", s.role === "auditor");
  const opts = optsFor(s.id);
  check("(H) ...the spawned pty's skills is DROPPED (null), despite the profile carrying a non-empty subset",
    opts?.skills === null);
  const evs = droppedEvents(e);
  check("(H) ...exactly one locked_role_skills_dropped event is filed", evs.length === 1);
  check("(H) ...naming the real session/profile role pair",
    evs[0]?.detail?.sessionRole === "auditor" && evs[0]?.detail?.profileRole === "worker" && evs[0]?.detail?.profileId === prof);

  // ===== NEGATIVE CONTROL: the profile's OWN role matches the explicit role -> honoured, no event =====
  const profMatch = mkProfile(e, "prof-h-match", { role: "auditor", skills: ["human-set"] });
  mkAgentFor(e, "agent-h2", "proj-h", profMatch);
  const before = droppedEvents(e).length;
  const s2 = svc.startAuditor("agent-h2");
  const opts2 = optsFor(s2.id);
  check("(H) NEGATIVE CONTROL: profile role MATCHES the explicit role -> subset honoured unchanged",
    opts2?.skills?.join() === "human-set");
  check("(H) ...and no new event is filed", droppedEvents(e).length === before);
  cleanup(e);
}

// ===================== (I) startPlatformLead: the "flip to worker, add skills, spawn explicit locked role" variant =====================
{
  const e = mkDb("session-platform");
  const { svc, optsFor } = mkSvc(e);
  const projDir = path.join(tmpHome, "proj-i");
  fs.mkdirSync(projDir, { recursive: true });
  mkProject(e, "proj-i", projDir);
  // Simulates: profile_create{role:"auditor"} (locked, human-reviewed) -> a human/agent later flips it
  // to {role:"worker"} (allowed — A-F never guard a flip OUT of locked) -> now-unlocked, skills freely
  // agent-settable -> an agent sets skills. The CR's own named variant.
  const prof = mkProfile(e, "prof-i-worker", { role: "worker", skills: ["agent-written-via-flip"] });
  mkAgentFor(e, "agent-i", "proj-i", prof);

  const s = svc.startPlatformLead("agent-i", { spawnHumanAuthorized: true });
  check("(I) startPlatformLead: the session's resolved role is \"platform\"", s.role === "platform");
  const opts = optsFor(s.id);
  check("(I) ...the spawned pty's skills is DROPPED (null)", opts?.skills === null);
  const evs = droppedEvents(e);
  check("(I) ...exactly one locked_role_skills_dropped event is filed, naming the mismatch",
    evs.length === 1 && evs[0]?.detail?.sessionRole === "platform" && evs[0]?.detail?.profileRole === "worker");
  cleanup(e);
}

// ===================== (J) NEGATIVE CONTROL: an unlocked (worker) explicit spawn is never guarded =====================
{
  const e = mkDb("session-worker");
  const { svc, optsFor } = mkSvc(e);
  const projDir = path.join(tmpHome, "proj-j");
  fs.mkdirSync(projDir, { recursive: true });
  mkProject(e, "proj-j", projDir);
  const prof = mkProfile(e, "prof-j-worker", { role: "worker", skills: ["agent-written"] });
  mkAgentFor(e, "agent-j", "proj-j", prof);

  const s = svc.startNew("agent-j"); // role-omitted -> resolves to the profile's own "worker" role
  check("(J) startNew: the session's resolved role is \"worker\" (profile-conferred, unlocked)", s.role === "worker");
  const opts = optsFor(s.id);
  check("(J) NEGATIVE CONTROL: the subset is honoured unchanged (role isn't locked at all)",
    opts?.skills?.join() === "agent-written");
  check("(J) ...and no locked_role_skills_dropped event is filed", droppedEvents(e).length === 0);
  cleanup(e);
}

// ===================== (K) resume(): a session PINNED before this fix carries a bad subset =====================
{
  const e = mkDb("session-resume");
  const { svc, optsFor } = mkSvc(e);
  const projDir = path.join(tmpHome, "proj-k");
  fs.mkdirSync(projDir, { recursive: true });
  mkProject(e, "proj-k", projDir);
  // The agent's CURRENT profile is worker-role — the mismatch resume() must re-validate against.
  const prof = mkProfile(e, "prof-k-worker", { role: "worker" });
  mkAgentFor(e, "agent-k", "proj-k", prof);
  const now = new Date().toISOString();
  // A row AS IF pinned before this fix: locked role "auditor" + harness "codex" (isForcedRoleFreshStart,
  // so resume() routes through resumeForcedRoleAsFreshClaude WITHOUT needing a real engine transcript —
  // see this section's own header) + a non-empty subset that no longer matches the CURRENT profile role.
  e.db.insertSession({
    id: "sess-k", projectId: "proj-k", agentId: "agent-k", engineSessionId: null, title: null,
    cwd: projDir, processState: "exited", resumability: "unknown", busy: false,
    createdAt: now, lastActivity: now, lastError: null,
    role: "auditor", harness: "codex", skills: ["stale-agent-written"],
  });

  svc.resume("sess-k");
  check("(K) resume(): the DB row's role is still \"auditor\" (unchanged by the forced-fresh-start)", e.db.getSession("sess-k").role === "auditor");
  const opts = optsFor("sess-k");
  check("(K) ...the spawned pty's skills is DROPPED (null) — the pre-fix-pinned subset is withheld",
    opts?.skills === null);
  check("(K) round 3: the DROP IS PERSISTED onto the row itself via the forced-fresh-start branch too",
    e.db.getSession("sess-k").skills === null);
  const evs = droppedEvents(e);
  check("(K) ...exactly one locked_role_skills_dropped event is filed, trigger \"resume\"",
    evs.length === 1 && evs[0]?.detail?.trigger === "resume" && evs[0]?.detail?.sessionRole === "auditor" && evs[0]?.detail?.profileRole === "worker");
  cleanup(e);
}

// ===================== (L) forkSession(): a source with the same pre-existing mismatch =====================
{
  const e = mkDb("session-fork");
  const { svc, optsFor } = mkSvc(e);
  const projDir = path.join(tmpHome, "proj-l");
  fs.mkdirSync(projDir, { recursive: true });
  mkProject(e, "proj-l", projDir);
  const prof = mkProfile(e, "prof-l-worker", { role: "worker" });
  mkAgentFor(e, "agent-l", "proj-l", prof);
  const now = new Date().toISOString();
  const engId = "sess-l-eng-0000-0000-000000000000";
  e.db.insertSession({
    id: "sess-l", projectId: "proj-l", agentId: "agent-l", engineSessionId: engId, title: null,
    cwd: projDir, processState: "exited", resumability: "unknown", busy: false,
    createdAt: now, lastActivity: now, lastError: null,
    role: "auditor", skills: ["stale-agent-written"],
  });
  // forkSession's engineTranscriptExists guard needs an on-disk transcript — written under the
  // SANDBOXED HOME (never the real ~/.claude), mirroring fork-allow-baseline.mjs's seedSource helper.
  const tpath = engineTranscriptPath(projDir, engId);
  fs.mkdirSync(path.dirname(tpath), { recursive: true });
  fs.writeFileSync(tpath, JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n");

  const forked = svc.forkSession("sess-l");
  check("(L) forkSession: the fork's role is \"auditor\" (carried from the source)", forked.role === "auditor");
  check("(L) ...the fork's OWN row has the subset DROPPED, not the raw source value", e.db.getSession(forked.id).skills === null);
  const opts = optsFor(forked.id);
  check("(L) ...the spawned pty's skills is DROPPED (null) too", opts?.skills === null);
  check("(L) round 3: the SOURCE row's own subset is ALSO persisted to null (never left stale for a later carry-forward)",
    e.db.getSession("sess-l").skills === null);
  cleanup(e);
}

// ===================== (M) THE RE-MATCH CASE (round 3, CR round-2 BLOCKING finding) =====================
// A row dropped-and-persisted-null by one resume must STAY null even after the agent's profile later
// RE-MATCHES the session's locked role (via reassignment or a role flip) — proving the role-comparison
// predicate ALONE (round 5) was insufficient: without persisting the drop onto the row, a later re-match
// would re-arm whatever was still sitting in the row's own `skills` column.
{
  const e = mkDb("session-rematch");
  const { svc, host, optsFor } = mkSvc(e);
  const projDir = path.join(tmpHome, "proj-m");
  fs.mkdirSync(projDir, { recursive: true });
  mkProject(e, "proj-m", projDir);
  const profWorker = mkProfile(e, "prof-m-worker", { role: "worker" });
  mkAgentFor(e, "agent-m", "proj-m", profWorker);
  const now = new Date().toISOString();
  // Pre-fix-shaped row: locked role "auditor" + harness "codex" (forced-fresh-start branch, no real
  // engine transcript needed) + a subset that doesn't match the agent's CURRENT (worker) profile role.
  e.db.insertSession({
    id: "sess-m", projectId: "proj-m", agentId: "agent-m", engineSessionId: null, title: null,
    cwd: projDir, processState: "exited", resumability: "unknown", busy: false,
    createdAt: now, lastActivity: now, lastError: null,
    role: "auditor", harness: "codex", skills: ["stale-agent-written"],
  });

  svc.resume("sess-m");
  check("(M) first resume: pty skills dropped (null)", optsFor("sess-m")?.skills === null);
  check("(M) first resume: the DROP IS PERSISTED onto the row itself, not just this spawn's argv",
    e.db.getSession("sess-m").skills === null);
  const evsAfterFirst = droppedEvents(e).length;
  check("(M) first resume: exactly one locked_role_skills_dropped event filed", evsAfterFirst === 1);

  // The agent is reassigned to a DIFFERENT profile whose OWN role MATCHES the session's locked role —
  // either route the card names (a profile_assign to a matching-role profile, or a same-profile role
  // flip to "auditor" with skills:null, round 4's own allowed shape) converges on the same fact here:
  // profileRole now equals sessionRole.
  const profAuditor = mkProfile(e, "prof-m-auditor", { role: "auditor", skills: null });
  e.db.updateAgent("agent-m", { profileId: profAuditor });

  host.stop("sess-m", "hard"); // flip the fake pty dead so the SECOND resume() doesn't short-circuit on isAlive
  // The FIRST resume's forced-fresh-start branch already flipped harness codex -> claude (undefined), so
  // the SECOND resume() call takes the ORDINARY (non-forced) path, which needs a real engine id + transcript
  // — manufacture both (mirrors (N)'s own setup), simulating the real SessionStart hook the fake pty never fires.
  const engIdM = "sess-m-eng-0000-0000-000000000000";
  e.db.setEngineSessionId("sess-m", engIdM);
  const tpathM = engineTranscriptPath(projDir, engIdM);
  fs.mkdirSync(path.dirname(tpathM), { recursive: true });
  fs.writeFileSync(tpathM, JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n");
  svc.resume("sess-m");
  check("(M) RE-MATCH: the role now matches the profile, but the row's own skills is STILL null — never re-armed",
    optsFor("sess-m")?.skills === null && e.db.getSession("sess-m").skills === null);
  // NOTE: this does NOT by itself prove round 3's persist fixed anything — on a re-MATCH, even PRE-fix
  // code would also file no second event here (sessionSkillsForRole's role-comparison alone already
  // returns dropped:false once profileRole===sessionRole, regardless of what the un-persisted row holds).
  // (M2) below is the scenario that actually discriminates pre-fix from post-fix: the mismatch KEPT.
  check("(M) RE-MATCH: still only the ONE event from the first resume (nothing left on the row to re-drop)",
    droppedEvents(e).length === evsAfterFirst);
  cleanup(e);
}

// ===================== (M2) THE REAL DEDUPE PROOF (card 34530aad CR round 3 finding 2): resume TWICE
// with the MISMATCH KEPT (never re-matching) — this is what actually discriminates pre-fix from
// post-fix code, unlike (M)'s own re-match check above. Pre-fix (no persist): the row still holds the
// stale subset after the first resume, the mismatch is STILL there on the second resume, so
// sessionSkillsForRole drops it AGAIN and recordSkillsDropped files a SECOND event. Post-fix: the first
// resume persists null onto the row, so the second resume's `normalized == null` guard short-circuits
// before any role comparison even runs — no second drop, no second event. ===================
{
  const e = mkDb("session-dedupe");
  const { svc, host, optsFor } = mkSvc(e);
  const projDir = path.join(tmpHome, "proj-m2");
  fs.mkdirSync(projDir, { recursive: true });
  mkProject(e, "proj-m2", projDir);
  // The profile stays worker-role for BOTH resumes — the mismatch against the locked "auditor" session
  // role is never cleared, unlike (M)'s own re-match scenario.
  const prof = mkProfile(e, "prof-m2-worker", { role: "worker" });
  mkAgentFor(e, "agent-m2", "proj-m2", prof);
  const now = new Date().toISOString();
  e.db.insertSession({
    id: "sess-m2", projectId: "proj-m2", agentId: "agent-m2", engineSessionId: null, title: null,
    cwd: projDir, processState: "exited", resumability: "unknown", busy: false,
    createdAt: now, lastActivity: now, lastError: null,
    role: "auditor", harness: "codex", skills: ["stale-agent-written"],
  });

  svc.resume("sess-m2");
  check("(M2) first resume: skills dropped (null) on the row", e.db.getSession("sess-m2").skills === null);
  const eventsForM2 = () => droppedEvents(e).filter((ev) => ev.workerSessionId === "sess-m2");
  check("(M2) first resume: exactly one event filed", eventsForM2().length === 1);

  host.stop("sess-m2", "hard"); // flip the fake pty dead so the SECOND resume() doesn't short-circuit on isAlive
  // The first resume's forced-fresh-start branch already flipped harness codex -> claude, so the SECOND
  // resume() takes the ORDINARY path — manufacture a real engine id + transcript (mirrors (M)/(N)).
  const engIdM2 = "sess-m2-eng-0000-0000-000000000000";
  e.db.setEngineSessionId("sess-m2", engIdM2);
  const tpathM2 = engineTranscriptPath(projDir, engIdM2);
  fs.mkdirSync(path.dirname(tpathM2), { recursive: true });
  fs.writeFileSync(tpathM2, JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n");
  svc.resume("sess-m2"); // the mismatch is STILL present — the profile never changed

  check("(M2) second resume: skills is STILL null on the row (nothing left to re-drop)",
    e.db.getSession("sess-m2").skills === null);
  check("(M2) second resume: STILL exactly one event filed — the real dedupe proof",
    eventsForM2().length === 1);
  cleanup(e);
}

// ===================== (N) the ORDINARY (non-forced) resume() path also persists the drop =====================
{
  const e = mkDb("session-resume-ordinary");
  const { svc, optsFor } = mkSvc(e);
  const projDir = path.join(tmpHome, "proj-n");
  fs.mkdirSync(projDir, { recursive: true });
  mkProject(e, "proj-n", projDir);
  const prof = mkProfile(e, "prof-n-worker", { role: "worker" });
  mkAgentFor(e, "agent-n", "proj-n", prof);
  const now = new Date().toISOString();
  const engId = "sess-n-eng-0000-0000-000000000000";
  e.db.insertSession({
    id: "sess-n", projectId: "proj-n", agentId: "agent-n", engineSessionId: engId, title: null,
    cwd: projDir, processState: "exited", resumability: "unknown", busy: false,
    createdAt: now, lastActivity: now, lastError: null,
    role: "auditor", skills: ["stale-agent-written"], // harness is CLAUDE (no isForcedRoleFreshStart) -> ordinary resume() branch
  });
  const tpath = engineTranscriptPath(projDir, engId);
  fs.mkdirSync(path.dirname(tpath), { recursive: true });
  fs.writeFileSync(tpath, JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n");

  svc.resume("sess-n");
  const opts = optsFor("sess-n");
  check("(N) ordinary resume(): the spawned pty's skills is DROPPED (null)", opts?.skills === null);
  check("(N) ordinary resume(): the drop is PERSISTED onto the row itself", e.db.getSession("sess-n").skills === null);
  check("(N) ordinary resume(): exactly one locked_role_skills_dropped event filed, trigger \"resume\"",
    droppedEvents(e).filter((ev) => ev.workerSessionId === "sess-n").length === 1);
  cleanup(e);
}

// ===================== (O) recyclePlatformLead: persists the drop onto the PREDECESSOR row too =====================
{
  const e = mkDb("session-lead-recycle");
  const { svc, optsFor } = mkSvc(e);
  const projDir = path.join(tmpHome, "proj-o");
  fs.mkdirSync(projDir, { recursive: true });
  mkProject(e, "proj-o", projDir);
  const prof = mkProfile(e, "prof-o-worker", { role: "worker" });
  mkAgentFor(e, "agent-o", "proj-o", prof);
  const now = new Date().toISOString();
  e.db.insertSession({
    id: "sess-o-old", projectId: "proj-o", agentId: "agent-o", engineSessionId: null, title: null,
    cwd: projDir, processState: "live", resumability: "unknown", busy: false,
    createdAt: now, lastActivity: now, lastError: null,
    role: "platform", skills: ["stale-agent-written"],
  });

  const successor = await svc.recyclePlatformLead("sess-o-old", "handoff");
  check("(O) recyclePlatformLead: successor's role is \"platform\"", successor.role === "platform");
  check("(O) ...the successor's OWN row has the subset DROPPED", e.db.getSession(successor.id).skills === null);
  const opts = optsFor(successor.id);
  check("(O) ...the spawned pty's skills is DROPPED (null) too", opts?.skills === null);
  check("(O) round 3: the PREDECESSOR row's own subset is ALSO persisted to null",
    e.db.getSession("sess-o-old").skills === null);
  const evs = droppedEvents(e).filter((ev) => ev.managerSessionId === "sess-o-old" || ev.workerSessionId === successor.id);
  check("(O) ...exactly one locked_role_skills_dropped event filed, trigger \"recycle\"",
    evs.length === 1 && evs[0]?.detail?.trigger === "recycle");
  cleanup(e);
}

// ===================== (P) upgradeCompanionCapabilities (assistant re-pin): a FRESH re-resolve, not a
// carry-forward site — already writes the trust-filtered value directly; covered for completeness =====
{
  const e = mkDb("session-assistant-repin");
  const { svc, optsFor } = mkSvc(e);
  const projDir = path.join(tmpHome, "proj-p");
  fs.mkdirSync(projDir, { recursive: true });
  mkProject(e, "proj-p", projDir);
  // An assistant-role profile (simulated human-set, same shape as (D5)'s mkProfile call) — its OWN role
  // MATCHES the explicit "assistant" role upgradeCompanionCapabilities always resolves, so the subset
  // must be honoured, not dropped (509176c8's own "matching profile role -> honoured" design).
  const prof = mkProfile(e, "prof-p-assistant", { role: "assistant", skills: ["human-set"] });
  mkAgentFor(e, "agent-p", "proj-p", prof);
  const now = new Date().toISOString();
  const engId = "sess-p-eng-0000-0000-000000000000";
  e.db.insertSession({
    id: "sess-p", projectId: "proj-p", agentId: "agent-p", engineSessionId: engId, title: null,
    cwd: projDir, processState: "live", resumability: "unknown", busy: false,
    createdAt: now, lastActivity: now, lastError: null,
    role: "assistant", skills: null,
  });
  const tpathP = engineTranscriptPath(projDir, engId);
  fs.mkdirSync(path.dirname(tpathP), { recursive: true });
  fs.writeFileSync(tpathP, JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n");
  // upgradeCompanionCapabilities re-resolves "assistant" as an EXPLICIT role equal to the profile's own
  // locked role -> NOT a mismatch -> the subset is honoured, proving the fresh re-resolve writes
  // whatever sessionSkillsForRole actually decides (never the stale pre-upgrade row value).
  await svc.upgradeCompanionCapabilities("sess-p");
  check("(P) upgradeCompanionCapabilities: a MATCHING profile role (\"assistant\" profile, \"assistant\" session) -> the subset is honoured, written straight onto the row",
    e.db.getSession("sess-p").skills?.join() === "human-set");
  cleanup(e);
}

// ===================== (Q) fail-closed inputs at a carry-forward site: agent deleted / profile deleted /
// forcePlain all resolve profileRole to null -> any locked session role mismatches and is dropped =======
{
  const e = mkDb("session-fail-closed");
  const { svc, optsFor } = mkSvc(e);
  const projDir = path.join(tmpHome, "proj-q");
  fs.mkdirSync(projDir, { recursive: true });
  mkProject(e, "proj-q", projDir);
  const now = new Date().toISOString();

  // (Q1) agent deleted: the session's agentId no longer resolves -> resolvedSpawn is undefined ->
  // profileRole reads null -> locked role mismatches -> dropped. A session row's agentId is FK-
  // enforced, so a REAL dangling row (agent row gone, session row surviving) needs the SAME ghost-row
  // construction codex-role-force-start-matrix.mjs's own "agent-missing" case uses: insert normally,
  // then drop the agent row directly with FK enforcement OFF (mirroring a real agent_delete that left a
  // stray session behind, e.g. via a race this test isn't exercising) — never left OFF afterward.
  mkAgentFor(e, "agent-q1-ghost", "proj-q", null);
  e.db.insertSession({
    id: "sess-q1", projectId: "proj-q", agentId: "agent-q1-ghost", engineSessionId: null, title: null,
    cwd: projDir, processState: "exited", resumability: "unknown", busy: false,
    createdAt: now, lastActivity: now, lastError: null,
    role: "auditor", harness: "codex", skills: ["stale-agent-written"],
  });
  e.db.db.pragma("foreign_keys = OFF");
  e.db.db.prepare("DELETE FROM agents WHERE id = ?").run("agent-q1-ghost");
  try { svc.resume("sess-q1"); } finally { e.db.db.pragma("foreign_keys = ON"); }
  check("(Q1) agent deleted/missing: fail-closed -> skills dropped on the row", e.db.getSession("sess-q1").skills === null);
  check("(Q1) ...and on the spawned pty", optsFor("sess-q1")?.skills === null);

  // (Q2) profile deleted: the agent still exists, but its bound profileId no longer resolves ->
  // resolveAgentSpawn's resolved profile role collapses to null -> same fail-closed outcome.
  const profQ2 = mkProfile(e, "prof-q2-deleted", { role: "auditor" });
  mkAgentFor(e, "agent-q2", "proj-q", profQ2);
  e.db.deleteProfile(profQ2);
  e.db.insertSession({
    id: "sess-q2", projectId: "proj-q", agentId: "agent-q2", engineSessionId: null, title: null,
    cwd: projDir, processState: "exited", resumability: "unknown", busy: false,
    createdAt: now, lastActivity: now, lastError: null,
    role: "auditor", harness: "codex", skills: ["stale-agent-written"],
  });
  svc.resume("sess-q2");
  check("(Q2) profile deleted: fail-closed -> skills dropped on the row", e.db.getSession("sess-q2").skills === null);
  check("(Q2) ...and on the spawned pty", optsFor("sess-q2")?.skills === null);

  // (Q3) forcedPlain:true (sticky): effectiveForcePlain forces resolveAgentSpawn's profile resolution to
  // plain (role null) regardless of the agent's REAL bound profile role — same fail-closed outcome, even
  // though the real profile's role ("auditor") would otherwise MATCH the session's own locked role.
  const profQ3 = mkProfile(e, "prof-q3-auditor", { role: "auditor" });
  mkAgentFor(e, "agent-q3", "proj-q", profQ3);
  e.db.insertSession({
    id: "sess-q3", projectId: "proj-q", agentId: "agent-q3", engineSessionId: null, title: null,
    cwd: projDir, processState: "exited", resumability: "unknown", busy: false,
    createdAt: now, lastActivity: now, lastError: null,
    role: "auditor", harness: "codex", skills: ["stale-agent-written"], forcedPlain: true,
  });
  svc.resume("sess-q3");
  check("(Q3) forcedPlain:true: fail-closed -> skills dropped on the row even though the REAL profile role would have matched",
    e.db.getSession("sess-q3").skills === null);
  check("(Q3) ...and on the spawned pty", optsFor("sess-q3")?.skills === null);
  cleanup(e);
}

try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — a non-empty explicit skills subset on a locked-role profile is human-only across every agent-facing MCP write path (profile_create, profile_update, and the two-call role-flip bypass) AND at the session-role chokepoint (an explicit-role spawn/resume/fork can never deliver a mismatched-profile subset to a locked session role), clearing is always allowed, unlocked roles stay unaffected, and REST/the Profiles UI are untouched."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
