import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Agent REBIND blast radius (card 8b236b22, from the Code Review of be447b3f).
//
// be447b3f extended `profile_grant_reach` to role/restrictedTools on every PROFILE-field-edit write
// path, but explicitly carved agent REBIND out of scope: moving an already-bound agent onto a
// DIFFERENT, already-existing profile (agent_update(profileId)/profile_assign on setup+platform,
// agent_assign_profile on manager, POST /api/agents/:id on REST) widens what that ONE agent can do
// without ever touching either profile's own fields — profileWideningsOf applied to a single profile
// sees nothing, since the profile itself never changes. This is the REBIND twin: a new
// `agent_profile_rebind` event (recordAgentProfileRebindReach, profiles/grantReach.ts) + a `rebindReach`
// response field, on all four surfaces, plus a restrictedTools-removal GUARD on the ONE surface with no
// interactive confirm and genuinely no redundant field-edit path (Manager) — see the decision record
// (docs/decisions/8b236b22-agent-profile-rebind-widening-audit.md) for the full per-surface reasoning,
// including the round-2 revision: Setup's OWN guard (round 1) was removed because Setup can already
// reach the identical widening via profile_update (agent-writable, audit-only per 8c27ae8e) or via
// profile_create->profile_assign, so gating only the rebind route was bypassable friction.
//
// Covers:
//   (0) agentRebindRestrictedToolsWideningError: the pure guard predicate, positive + negative.
//   (A) Setup agent_update: restrictedTools true->false ALLOWED + audited (no guard, round-2 revision);
//       role->manager ALLOWED + audited; EACH widening has its own NEGATIVE CONTROL (a same-shape rebind
//       fires nothing); clearing profileId:null off a restrictedTools:true profile is ALSO audited (no
//       refusal) — widens against the backstop like a delete would.
//   (B) Setup profile_assign: same two axes, abbreviated.
//   (C) Platform agent_update + profile_assign: restrictedTools removal and a role flip into an
//       elevated/reserved-home role are BOTH allowed (no guard) and audited with the real roleChange;
//       NEGATIVE CONTROL fires nothing.
//   (D) Manager assignAgentProfile (direct SessionService call, same harness shape as
//       agent-assignable-profile-guard.mjs): restrictedTools removal REFUSED, no write (manager's ONLY
//       route to this axis — no profile_update/profile_create tool exists on this surface); role->manager
//       ALLOWED + audited; NEGATIVE CONTROL (clean rebind) fires nothing; a DANGLING current profileId
//       (its profile was deleted, so "before" resolves to the backstop) still computes correctly; clearing
//       to null (profileId: null) off a restrictedTools:true profile is ALSO REFUSED, same as a rebind.
//   (E) REST POST /api/agents/:id: restrictedTools removal AND a rebind onto a LOCKED elevated-role
//       profile both ALLOWED (human-only, no guard anywhere) and audited; NEGATIVE CONTROLS (rename-only
//       with profileId omitted, and profileId resent unchanged) fire nothing.
//   (F) Durability: the event survives deleteAgent's cascade — VERIFIED as INERT-but-harmless (the row
//       is managerSessionId:"" so the session-keyed cascade can never reach it either way; see the
//       decision record's own correction of this point).
//   (G) card acd3c688 round 3: `resetScheduleProvenanceOnAgentRebind` (orchestration/scheduler.ts),
//       called from every AGENT-surface rebind site (Setup agent_update/profile_assign, Platform
//       agent_update/profile_assign, Manager assignAgentProfile) — never from REST. A createdBy:"human"
//       schedule TARGETING the rebound agent is reset to createdBy:"agent" on each of the five; a sibling
//       human-created schedule targeting a DIFFERENT agent is untouched; REST POST /api/agents/:id leaves
//       a human-created schedule's provenance alone (human intent stays human intent). See
//       docs/decisions/acd3c688-explicit-role-grant-carryover.md.
//   (H) RED-FIRST: before trusting any GREEN above, this file's own header documents the manual revert
//       proof (see the worker's done-report) — the specific checks here were confirmed to FAIL against
//       the pre-fix call sites (no refusal, no rebindReach, no event) before the fix landed. Section (G)'s
//       own RED-first proof is separate (see its own comment) since it was added in round 3.
//
// Run: 1) build (turbo builds shared first), 2) node test/agent-profile-rebind-reach.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-rebind-reach-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
const { cleanupPathSync } = await import("./_tmp-fixture.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { SetupMcpRouter } = await import("../dist/mcp/setup.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { agentRebindRestrictedToolsWideningError } = await import("../dist/profiles/validate.js");

// ===================== (0) the pure guard predicate =====================
{
  const BARE = { role: null, restrictedTools: false };
  check("(0) true->false (removing the restriction) is REFUSED",
    typeof agentRebindRestrictedToolsWideningError({ ...BARE, restrictedTools: true }, { ...BARE, restrictedTools: false }) === "string");
  check("(0) the refusal names the axis and the human route",
    /restrictedTools/.test(agentRebindRestrictedToolsWideningError({ ...BARE, restrictedTools: true }, BARE))
    && /Profiles UI/.test(agentRebindRestrictedToolsWideningError({ ...BARE, restrictedTools: true }, BARE)));
  check("(0) NEGATIVE CONTROL: false->true (adding it) is NOT refused",
    agentRebindRestrictedToolsWideningError(BARE, { ...BARE, restrictedTools: true }) === null);
  check("(0) NEGATIVE CONTROL: true->true (unchanged) is NOT refused",
    agentRebindRestrictedToolsWideningError({ ...BARE, restrictedTools: true }, { ...BARE, restrictedTools: true }) === null);
  check("(0) NEGATIVE CONTROL: false->false (unchanged) is NOT refused",
    agentRebindRestrictedToolsWideningError(BARE, BARE) === null);
}

// ===================== fixtures =====================
function mkDb(name) {
  const dbFile = path.join(tmpHome, `${name}.db`);
  const db = new Db(dbFile);
  const now = new Date().toISOString();
  return { dbFile, db, now, projects: new Set() };
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
const ensureProject = (e, projectId, projectName, over = {}) => {
  if (!e.projects.has(projectId)) {
    e.db.insertProject({ id: projectId, name: projectName, repoPath: projectId, vaultPath: projectId, config: {}, createdAt: e.now, archivedAt: null, ...over });
    e.projects.add(projectId);
  }
};
const mkAgent = (e, id, projectId, projectName, profileId, over = {}) => {
  ensureProject(e, projectId, projectName);
  e.db.insertAgent({ id, projectId, name: id, startupPrompt: "", position: 0, profileId, ...over });
};
const rebindEvents = (e) => e.db.listEvents("").filter((x) => x.kind === "agent_profile_rebind");

async function mcpClient(router, sessionId) {
  const server = router.buildServer(sessionId);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "agent-profile-rebind-reach-test", version: "0" });
  await client.connect(clientT);
  return client;
}
const parseMcp = (res) => JSON.parse(res.content[0].text);

// ===================== (A) Setup agent_update =====================
{
  const e = mkDb("setup-agent-update");
  const client = await mcpClient(new SetupMcpRouter(e.db, {}), "any-caller");
  const call = (name, args) => client.callTool({ name, arguments: args }).then(parseMcp);

  const restricted = mkProfile(e, "prof-su-restricted", { role: "worker", restrictedTools: true });
  const unrestricted = mkProfile(e, "prof-su-unrestricted", { role: "worker", restrictedTools: false });
  const managerProf = mkProfile(e, "prof-su-manager", { role: "manager", restrictedTools: true });
  mkAgent(e, "agent-su-1", "proj-su", "SetupUpdate", restricted);

  // --- restrictedTools removal: ALLOWED + audited, no guard (round-2 revision — see decision record) ---
  const widenedRT = await call("agent_update", { agentId: "agent-su-1", profileId: unrestricted });
  check("(A) agent_update ALLOWS a restrictedTools removal via rebind (no guard, round-2 revision)", !widenedRT.error);
  check("(A) ...the write landed", e.db.getAgent("agent-su-1").profileId === unrestricted);
  check("(A) ...the response carries rebindReach naming restrictedTools", widenedRT.rebindReach?.addedKeys?.join() === "restrictedTools");
  const evsRT = rebindEvents(e);
  check("(A) exactly one durable event filed, source \"setup\"", evsRT.length === 1 && evsRT[0]?.detail?.source === "setup");

  // --- NEGATIVE CONTROL for the restrictedTools case: a same-shape rebind fires nothing ---
  const unrestricted2 = mkProfile(e, "prof-su-unrestricted-2", { role: "worker", restrictedTools: false });
  const beforeRT = rebindEvents(e).length;
  const plainRT = await call("agent_update", { agentId: "agent-su-1", profileId: unrestricted2 });
  check("(A) NEGATIVE CONTROL (restrictedTools): a same-shape rebind applies with no error", !plainRT.error);
  check("(A) ...returns NO rebindReach", plainRT.rebindReach === undefined);
  check("(A) ...and files NO new event", rebindEvents(e).length === beforeRT);

  // --- role widen to manager: ALLOWED, audited ---
  mkAgent(e, "agent-su-1b", "proj-su", "SetupUpdate", restricted);
  const widened = await call("agent_update", { agentId: "agent-su-1b", profileId: managerProf });
  check("(A) agent_update ALLOWS a role widen to manager via rebind (no error)", !widened.error);
  check("(A) ...the write actually landed", e.db.getAgent("agent-su-1b").profileId === managerProf);
  check("(A) ...the response carries rebindReach", !!widened.rebindReach);
  check("(A) ...naming the role widening", widened.rebindReach?.addedKeys?.join() === "role");
  check("(A) ...with the real from/to", widened.rebindReach?.roleChange?.from === "worker" && widened.rebindReach?.roleChange?.to === "manager");
  const evs1 = rebindEvents(e);
  check("(A) exactly one NEW durable event filed for the role widen", evs1.length === 2);
  check("(A) ...naming the agent + its project", evs1[1]?.detail?.agentId === "agent-su-1b" && evs1[1]?.detail?.projectId === "proj-su");

  // --- NEGATIVE CONTROL for the role case: a same-shape rebind (manager -> a DIFFERENT manager-role, same-restrictedTools profile) fires nothing ---
  const managerProf2 = mkProfile(e, "prof-su-manager-2", { role: "manager", restrictedTools: true });
  const before = rebindEvents(e).length;
  const plain = await call("agent_update", { agentId: "agent-su-1b", profileId: managerProf2 });
  check("(A) NEGATIVE CONTROL (role): a same-shape rebind applies with no error", !plain.error);
  check("(A) ...returns NO rebindReach", plain.rebindReach === undefined);
  check("(A) ...and files NO new event", rebindEvents(e).length === before);

  // --- clearing profileId:null off a restrictedTools:true profile is ALSO audited, never refused ---
  mkAgent(e, "agent-su-2", "proj-su", "SetupUpdate", restricted);
  const beforeClear = rebindEvents(e).length;
  const cleared = await call("agent_update", { agentId: "agent-su-2", profileId: null });
  check("(A) clearing profileId to null off a restrictedTools:true profile is ALLOWED (audit-only)", !cleared.error && e.db.getAgent("agent-su-2").profileId === null);
  // clearing a worker/restrictedTools:true profile widens BOTH axes against the backstop (role:null, restrictedTools:false).
  check("(A) ...the response carries rebindReach naming BOTH widened axes (the backstop widens role too)", cleared.rebindReach?.addedKeys?.join() === "role,restrictedTools");
  check("(A) ...and files a new event", rebindEvents(e).length === beforeClear + 1);

  // --- a patch with NO profileId key at all never even computes/fires anything ---
  const beforeNoKey = rebindEvents(e).length;
  const renameOnly = await call("agent_update", { agentId: "agent-su-2", name: "Renamed" });
  check("(A) a patch omitting profileId entirely applies cleanly", !renameOnly.error && renameOnly.name === "Renamed");
  check("(A) ...and files NO event (profileId was never a patch key)", rebindEvents(e).length === beforeNoKey);

  cleanup(e);
}

// ===================== (B) Setup profile_assign =====================
{
  const e = mkDb("setup-profile-assign");
  const client = await mcpClient(new SetupMcpRouter(e.db, {}), "any-caller");
  const call = (name, args) => client.callTool({ name, arguments: args }).then(parseMcp);

  const restricted = mkProfile(e, "prof-sa-restricted", { role: "worker", restrictedTools: true });
  const unrestricted = mkProfile(e, "prof-sa-unrestricted", { role: "worker", restrictedTools: false });
  const unrestricted2 = mkProfile(e, "prof-sa-unrestricted-2", { role: "worker", restrictedTools: false });
  const managerProf = mkProfile(e, "prof-sa-manager", { role: "manager", restrictedTools: true });
  const managerProf2 = mkProfile(e, "prof-sa-manager-2", { role: "manager", restrictedTools: true });
  mkAgent(e, "agent-sa-1", "proj-sa", "SetupAssign", restricted);

  // restrictedTools removal: ALLOWED + audited, no guard (round-2 revision).
  const widenedRT = await call("profile_assign", { agentId: "agent-sa-1", profileId: unrestricted });
  check("(B) profile_assign ALLOWS a restrictedTools removal via rebind (no guard, round-2 revision)",
    !widenedRT.error && e.db.getAgent("agent-sa-1").profileId === unrestricted);
  check("(B) ...the response carries rebindReach naming restrictedTools", widenedRT.rebindReach?.addedKeys?.join() === "restrictedTools");
  const evsRT = rebindEvents(e);
  check("(B) exactly one durable event filed, source \"setup\"", evsRT.length === 1 && evsRT[0]?.detail?.source === "setup");
  // NEGATIVE CONTROL: a same-shape rebind fires nothing.
  const beforeRT = rebindEvents(e).length;
  const plainRT = await call("profile_assign", { agentId: "agent-sa-1", profileId: unrestricted2 });
  check("(B) NEGATIVE CONTROL (restrictedTools): a same-shape rebind applies with no error", !plainRT.error);
  check("(B) ...returns NO rebindReach and files NO new event", plainRT.rebindReach === undefined && rebindEvents(e).length === beforeRT);

  // role widen to manager: ALLOWED + audited.
  mkAgent(e, "agent-sa-1b", "proj-sa", "SetupAssign", restricted);
  const widened = await call("profile_assign", { agentId: "agent-sa-1b", profileId: managerProf });
  check("(B) profile_assign ALLOWS a role widen to manager via rebind", !widened.error && e.db.getAgent("agent-sa-1b").profileId === managerProf);
  check("(B) ...the response carries rebindReach naming the role widening", widened.rebindReach?.addedKeys?.join() === "role");
  const evs = rebindEvents(e);
  check("(B) exactly one NEW durable event filed, source \"setup\"", evs.length === 2 && evs[1]?.detail?.source === "setup");
  // NEGATIVE CONTROL: a same-shape rebind fires nothing.
  const before = rebindEvents(e).length;
  const plain = await call("profile_assign", { agentId: "agent-sa-1b", profileId: managerProf2 });
  check("(B) NEGATIVE CONTROL (role): a same-shape rebind applies with no error", !plain.error);
  check("(B) ...returns NO rebindReach and files NO new event", plain.rebindReach === undefined && rebindEvents(e).length === before);

  cleanup(e);
}

// ===================== (C) Platform agent_update + profile_assign: audit-only, no guard =====================
{
  const e = mkDb("platform-rebind");
  const client = await mcpClient(new PlatformMcpRouter(e.db, {}), "any-caller");
  const call = (name, args) => client.callTool({ name, arguments: args }).then(parseMcp);

  // Reserved home — elevated roles are only legitimately bound here (ad098631).
  ensureProject(e, "proj-reserved", "Reserved", { reserved: true });
  const restricted = mkProfile(e, "prof-pl-restricted", { role: "worker", restrictedTools: true });
  const assistantProf = mkProfile(e, "prof-pl-assistant", { role: "assistant", restrictedTools: false });
  mkAgent(e, "agent-pl-1", "proj-reserved", "Reserved", restricted);

  // restrictedTools removal AND a role flip into an elevated role, in ONE rebind — BOTH allowed, no guard.
  const res = await call("agent_update", { agentId: "agent-pl-1", profileId: assistantProf });
  check("(C) agent_update ALLOWS a restrictedTools removal + elevated-role rebind (no error)", !res.error);
  check("(C) ...the write landed", e.db.getAgent("agent-pl-1").profileId === assistantProf);
  check("(C) ...the response carries rebindReach", !!res.rebindReach);
  check("(C) ...naming BOTH widened axes, role before restrictedTools", res.rebindReach?.addedKeys?.join() === "role,restrictedTools");
  check("(C) ...with the real roleChange", res.rebindReach?.roleChange?.from === "worker" && res.rebindReach?.roleChange?.to === "assistant");
  const evs = rebindEvents(e);
  check("(C) exactly one durable event filed, source \"platform\"", evs.length === 1 && evs[0]?.detail?.source === "platform");

  // NEGATIVE CONTROL: an unrelated rename-only patch fires nothing.
  const before = rebindEvents(e).length;
  const plain = await call("agent_update", { agentId: "agent-pl-1", name: "Renamed" });
  check("(C) NEGATIVE CONTROL: a rename-only patch applies cleanly", !plain.error && plain.name === "Renamed");
  check("(C) ...returns NO rebindReach", plain.rebindReach === undefined);
  check("(C) ...and files NO new event", rebindEvents(e).length === before);

  // profile_assign: same mechanism, different tool.
  const restricted2 = mkProfile(e, "prof-pl-restricted-2", { role: "worker", restrictedTools: true });
  mkAgent(e, "agent-pl-2", "proj-reserved", "Reserved", restricted2);
  const res2 = await call("profile_assign", { agentId: "agent-pl-2", profileId: assistantProf });
  check("(C) profile_assign ALLOWS the same widening, no guard", !res2.error && !!res2.rebindReach);
  check("(C) ...files its own event, source \"platform\"", rebindEvents(e).length === 2);

  cleanup(e);
}

// ===================== (D) Manager assignAgentProfile (direct SessionService call) =====================
{
  const e = mkDb("manager-rebind");
  const now = e.now;
  ensureProject(e, "pMine", "Mine", { reserved: false });
  const restricted = mkProfile(e, "prof-mgr-restricted", { role: "worker", restrictedTools: true });
  const unrestricted = mkProfile(e, "prof-mgr-unrestricted", { role: "worker", restrictedTools: false });
  const managerProf = mkProfile(e, "prof-mgr-manager", { role: "manager", restrictedTools: true });
  mkAgent(e, "agent-mgr-1", "pMine", "Mine", restricted);
  e.db.insertSession({
    id: "M", projectId: "pMine", agentId: "agent-mgr-1", engineSessionId: null, title: null, cwd: tmpHome,
    processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager", parentSessionId: null,
  });
  const pty = { enqueueStdin: () => ({ delivered: false }) };
  const svc = new SessionService(e.db, pty, new OrchestrationControl());

  // --- restrictedTools removal: REFUSED, no write (manager's ONLY route to this axis) ---
  let threw = null;
  try { svc.assignAgentProfile("M", "agent-mgr-1", unrestricted); } catch (err) { threw = err; }
  check("(D) assignAgentProfile REFUSES a restrictedTools removal via rebind", threw !== null && /restrictedTools/.test(threw.message));
  check("(D) ...the refusal names the human route", /Profiles UI/.test(threw.message));
  check("(D) ...no write: still bound to the restricted profile", e.db.getAgent("agent-mgr-1").profileId === restricted);
  check("(D) ...and NO event was filed for the refused attempt", rebindEvents(e).length === 0);

  // --- role widen to manager: ALLOWED + audited (ced4285e's own ruling) ---
  const widened = svc.assignAgentProfile("M", "agent-mgr-1", managerProf);
  check("(D) assignAgentProfile ALLOWS a role widen to manager", widened.profileId === managerProf && e.db.getAgent("agent-mgr-1").profileId === managerProf);
  check("(D) ...the return value carries rebindReach", !!widened.rebindReach);
  check("(D) ...naming the role widening", widened.rebindReach?.addedKeys?.join() === "role");
  const evs = rebindEvents(e);
  check("(D) exactly one durable event filed, source \"manager\"", evs.length === 1 && evs[0]?.detail?.source === "manager");
  // manager_manage is filed under the REAL managerSessionId ("M"), unlike agent_profile_rebind's "".
  check("(D) ...the existing manager_manage audit row is STILL filed too (dual-event, unchanged precedent)",
    e.db.listEvents("M").some((x) => x.kind === "manager_manage" && x.detail?.action === "agent_assign_profile"));
  check("(D) ...the manager_manage row does NOT embed the reach (one source of truth)",
    e.db.listEvents("M").find((x) => x.kind === "manager_manage" && x.detail?.action === "agent_assign_profile")?.detail?.rebindReach === undefined);

  // --- NEGATIVE CONTROL: a same-shape rebind (manager -> a different manager-role, non-restricted profile) fires nothing ---
  const managerProf2 = mkProfile(e, "prof-mgr-manager-2", { role: "manager", restrictedTools: true });
  const before = rebindEvents(e).length;
  const plain = svc.assignAgentProfile("M", "agent-mgr-1", managerProf2);
  check("(D) NEGATIVE CONTROL: a same-shape rebind applies with no error", plain.profileId === managerProf2);
  check("(D) ...returns NO rebindReach", plain.rebindReach === undefined);
  check("(D) ...and files NO new event", rebindEvents(e).length === before);

  // --- Code Review round 2, test gap (3a): the agent's CURRENT profileId DANGLES (its profile was
  // deleted) — "before" must resolve to the backstop (role:null, restrictedTools:false), exactly like
  // profile_delete's own backstop widening, not throw or silently skip the computation. ---
  const danglingTarget = mkProfile(e, "prof-mgr-dangling-target", { role: "worker" });
  mkAgent(e, "agent-mgr-dangling", "pMine", "Mine", danglingTarget);
  e.db.updateAgent("agent-mgr-dangling", { profileId: "does-not-exist-anymore" });
  check("(D) precondition: the agent's profileId now dangles", e.db.getAgent("agent-mgr-dangling").profileId === "does-not-exist-anymore"
    && e.db.getProfile("does-not-exist-anymore") === undefined);
  const fromDangling = svc.assignAgentProfile("M", "agent-mgr-dangling", managerProf2);
  check("(D) a rebind off a DANGLING current profileId still computes (no throw)", fromDangling.profileId === managerProf2);
  check("(D) ...the backstop (role:null) is what widened, not the stale/missing profile's own fields",
    fromDangling.rebindReach?.roleChange?.from === null && fromDangling.rebindReach?.roleChange?.to === "manager");

  // --- Code Review round 2, test gap (3b): assignAgentProfile(..., null) off a restrictedTools:true
  // profile must be REFUSED too — clearing is a rebind onto the backstop (restrictedTools:false), the
  // SAME widening a rebind onto any other unrestricted profile would be. ---
  mkAgent(e, "agent-mgr-clear", "pMine", "Mine", restricted);
  let clearThrew = null;
  try { svc.assignAgentProfile("M", "agent-mgr-clear", null); } catch (err) { clearThrew = err; }
  check("(D) assignAgentProfile(..., null) off a restrictedTools:true profile is ALSO REFUSED",
    clearThrew !== null && /restrictedTools/.test(clearThrew.message));
  check("(D) ...no write: still bound to the restricted profile", e.db.getAgent("agent-mgr-clear").profileId === restricted);

  cleanup(e);
}

// ===================== (E) REST POST /api/agents/:id =====================
{
  const e = mkDb("rest-rebind");
  const app = await mkApp(e);
  const restricted = mkProfile(e, "prof-rest-restricted", { role: "worker", restrictedTools: true });
  const elevatedUnrestricted = mkProfile(e, "prof-rest-elevated", { role: "platform", restrictedTools: false });
  mkAgent(e, "agent-rest-1", "proj-rest", "RestRebind", restricted);

  // A human can rebind onto an ELEVATED/locked role AND remove restrictedTools, in one call — no guard
  // anywhere on this surface (humanAuthorized posture), but it's still AUDITED.
  const res = await app.inject({ method: "POST", url: "/api/agents/agent-rest-1", payload: { profileId: elevatedUnrestricted } });
  check("(E) POST -> 200", res.statusCode === 200);
  const body = JSON.parse(res.payload);
  check("(E) the rebind onto an elevated, unrestricted profile is ALLOWED (human-only, no guard)", e.db.getAgent("agent-rest-1").profileId === elevatedUnrestricted);
  check("(E) ...the response carries rebindReach", !!body.rebindReach);
  check("(E) ...naming BOTH widened axes", body.rebindReach?.addedKeys?.join() === "role,restrictedTools");
  check("(E) ...with the real roleChange", body.rebindReach?.roleChange?.from === "worker" && body.rebindReach?.roleChange?.to === "platform");
  const evs = rebindEvents(e);
  check("(E) exactly one durable event filed, source \"rest\"", evs.length === 1 && evs[0]?.detail?.source === "rest");

  // NEGATIVE CONTROL: a rename-only PATCH (profileId omitted entirely) fires nothing.
  const before = rebindEvents(e).length;
  const renameOnly = await app.inject({ method: "POST", url: "/api/agents/agent-rest-1", payload: { name: "Renamed" } });
  check("(E) NEGATIVE CONTROL: a rename-only PATCH -> 200", renameOnly.statusCode === 200);
  check("(E) ...returns NO rebindReach", JSON.parse(renameOnly.payload).rebindReach === undefined);
  check("(E) ...and files NO new event", rebindEvents(e).length === before);

  // NEGATIVE CONTROL: profileId resent as the SAME, already-current value fires nothing (no actual widening).
  const beforeResend = rebindEvents(e).length;
  const resend = await app.inject({ method: "POST", url: "/api/agents/agent-rest-1", payload: { profileId: elevatedUnrestricted } });
  check("(E) NEGATIVE CONTROL: resending the SAME profileId -> 200", resend.statusCode === 200);
  check("(E) ...returns NO rebindReach", JSON.parse(resend.payload).rebindReach === undefined);
  check("(E) ...and files NO new event", rebindEvents(e).length === beforeResend);

  cleanup(e);
}

// ===================== (F) durability: survives deleteAgent's cascade =====================
{
  const e = mkDb("durability");
  const now = e.now;
  ensureProject(e, "pDur", "Dur", { reserved: false });
  const restricted = mkProfile(e, "prof-dur-restricted", { role: "worker", restrictedTools: true });
  const managerProf = mkProfile(e, "prof-dur-manager", { role: "manager", restrictedTools: true });
  mkAgent(e, "agent-dur-1", "pDur", "Dur", restricted);
  e.db.insertSession({
    id: "MD", projectId: "pDur", agentId: "agent-dur-1", engineSessionId: null, title: null, cwd: tmpHome,
    processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager", parentSessionId: null,
  });
  const svc = new SessionService(e.db, { enqueueStdin: () => ({ delivered: false }) }, new OrchestrationControl());
  svc.assignAgentProfile("MD", "agent-dur-1", managerProf);
  check("(F) precondition: the rebind event was filed", rebindEvents(e).length === 1);
  const eventId = rebindEvents(e)[0].id;

  e.db.deleteAgent("agent-dur-1");
  check("(F) the agent is really gone", !e.db.getAgent("agent-dur-1"));
  const survivors = rebindEvents(e);
  check("(F) the agent_profile_rebind event SURVIVES deleteAgent's cascade", survivors.some((x) => x.id === eventId));
  // See the decision record: survival here is NOT caused by DURABLE_AUDIT_EVENT_KINDS membership (which
  // is a no-op for this event) — it's caused by the row being managerSessionId:"" (never session-keyed),
  // the SAME structural reason profile_grant_reach survives while staying OUT of that set. Confirm that
  // structural premise directly, so this test can't pass for the wrong reason:
  check("(F) ...and the row IS managerSessionId:\"\" (the real reason it was never reachable by the cascade)",
    survivors.find((x) => x.id === eventId)?.managerSessionId === "");

  cleanup(e);
}

// ===================== (G) card acd3c688 round 3: schedule provenance reset on AGENT-surface rebind ======
const mkHumanSchedule = (e, id, agentId) => {
  e.db.insertSchedule({ id, name: id, agentId, cron: "0 9 * * *", enabled: true, nextFireAt: new Date(Date.now() + 86400000).toISOString(), lastFiredAt: null, createdAt: e.now, kind: "manager", prompt: null, createdBy: "human" });
};

// ---- (G-A) Setup agent_update ----
{
  const e = mkDb("sched-setup-agent-update");
  const client = await mcpClient(new SetupMcpRouter(e.db, {}), "any-caller");
  const call = (name, args) => client.callTool({ name, arguments: args }).then(parseMcp);
  const prof1 = mkProfile(e, "prof-gsa-1", { role: "worker" });
  const prof2 = mkProfile(e, "prof-gsa-2", { role: "worker" });
  mkAgent(e, "agent-gsa-target", "proj-gsa", "GSA", prof1);
  mkAgent(e, "agent-gsa-other", "proj-gsa", "GSA", prof1);
  mkHumanSchedule(e, "sched-gsa-target", "agent-gsa-target");
  mkHumanSchedule(e, "sched-gsa-other", "agent-gsa-other");

  const res = await call("agent_update", { agentId: "agent-gsa-target", profileId: prof2 });
  check("(G-A) Setup agent_update: the rebind itself applies with no error", !res.error);
  check("(G-A) a createdBy:human schedule TARGETING the rebound agent is RESET to createdBy:agent", e.db.getSchedule("sched-gsa-target")?.createdBy === "agent");
  check("(G-A) a sibling human-created schedule targeting a DIFFERENT agent is UNTOUCHED", e.db.getSchedule("sched-gsa-other")?.createdBy === "human");
  cleanup(e);
}

// ---- (G-B) Setup profile_assign ----
{
  const e = mkDb("sched-setup-profile-assign");
  const client = await mcpClient(new SetupMcpRouter(e.db, {}), "any-caller");
  const call = (name, args) => client.callTool({ name, arguments: args }).then(parseMcp);
  const prof1 = mkProfile(e, "prof-gsb-1", { role: "worker" });
  const prof2 = mkProfile(e, "prof-gsb-2", { role: "worker" });
  mkAgent(e, "agent-gsb-target", "proj-gsb", "GSB", prof1);
  mkAgent(e, "agent-gsb-other", "proj-gsb", "GSB", prof1);
  mkHumanSchedule(e, "sched-gsb-target", "agent-gsb-target");
  mkHumanSchedule(e, "sched-gsb-other", "agent-gsb-other");

  const res = await call("profile_assign", { agentId: "agent-gsb-target", profileId: prof2 });
  check("(G-B) Setup profile_assign: the rebind itself applies with no error", !res.error);
  check("(G-B) a createdBy:human schedule TARGETING the rebound agent is RESET to createdBy:agent", e.db.getSchedule("sched-gsb-target")?.createdBy === "agent");
  check("(G-B) a sibling human-created schedule targeting a DIFFERENT agent is UNTOUCHED", e.db.getSchedule("sched-gsb-other")?.createdBy === "human");
  cleanup(e);
}

// ---- (G-C) Platform agent_update + profile_assign ----
{
  const e = mkDb("sched-platform-rebind");
  const client = await mcpClient(new PlatformMcpRouter(e.db, {}), "any-caller");
  const call = (name, args) => client.callTool({ name, arguments: args }).then(parseMcp);
  const prof1 = mkProfile(e, "prof-gpc-1", { role: "worker" });
  const prof2 = mkProfile(e, "prof-gpc-2", { role: "worker" });
  const prof3 = mkProfile(e, "prof-gpc-3", { role: "worker" });
  mkAgent(e, "agent-gpc-update", "proj-gpc", "GPC", prof1);
  mkAgent(e, "agent-gpc-assign", "proj-gpc", "GPC", prof1);
  mkAgent(e, "agent-gpc-other", "proj-gpc", "GPC", prof1);
  mkHumanSchedule(e, "sched-gpc-update", "agent-gpc-update");
  mkHumanSchedule(e, "sched-gpc-assign", "agent-gpc-assign");
  mkHumanSchedule(e, "sched-gpc-other", "agent-gpc-other");

  const resU = await call("agent_update", { agentId: "agent-gpc-update", profileId: prof2 });
  check("(G-C) Platform agent_update: the rebind itself applies with no error", !resU.error);
  check("(G-C) agent_update: a createdBy:human schedule TARGETING the rebound agent is RESET to createdBy:agent", e.db.getSchedule("sched-gpc-update")?.createdBy === "agent");

  const resA = await call("profile_assign", { agentId: "agent-gpc-assign", profileId: prof3 });
  check("(G-C) Platform profile_assign: the rebind itself applies with no error", !resA.error);
  check("(G-C) profile_assign: a createdBy:human schedule TARGETING the rebound agent is RESET to createdBy:agent", e.db.getSchedule("sched-gpc-assign")?.createdBy === "agent");

  check("(G-C) a sibling human-created schedule targeting a DIFFERENT (never-rebound) agent is UNTOUCHED", e.db.getSchedule("sched-gpc-other")?.createdBy === "human");
  cleanup(e);
}

// ---- (G-D) Manager assignAgentProfile (direct SessionService call) ----
{
  const e = mkDb("sched-manager-rebind");
  const now = e.now;
  ensureProject(e, "pGSD", "GSD", { reserved: false });
  const prof1 = mkProfile(e, "prof-gsd-1", { role: "worker" });
  const prof2 = mkProfile(e, "prof-gsd-2", { role: "worker" });
  mkAgent(e, "agent-gsd-target", "pGSD", "GSD", prof1);
  mkAgent(e, "agent-gsd-other", "pGSD", "GSD", prof1);
  mkHumanSchedule(e, "sched-gsd-target", "agent-gsd-target");
  mkHumanSchedule(e, "sched-gsd-other", "agent-gsd-other");
  e.db.insertSession({
    id: "MGSD", projectId: "pGSD", agentId: "agent-gsd-target", engineSessionId: null, title: null, cwd: tmpHome,
    processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager", parentSessionId: null,
  });
  const svc = new SessionService(e.db, { enqueueStdin: () => ({ delivered: false }) }, new OrchestrationControl());

  svc.assignAgentProfile("MGSD", "agent-gsd-target", prof2);
  check("(G-D) Manager assignAgentProfile: a createdBy:human schedule TARGETING the rebound agent is RESET to createdBy:agent", e.db.getSchedule("sched-gsd-target")?.createdBy === "agent");
  check("(G-D) a sibling human-created schedule targeting a DIFFERENT agent is UNTOUCHED", e.db.getSchedule("sched-gsd-other")?.createdBy === "human");
  cleanup(e);
}

// ---- (G-E) REST POST /api/agents/:id — NEGATIVE: a human rebind leaves provenance ALONE ----
{
  const e = mkDb("sched-rest-rebind");
  const app = await mkApp(e);
  const prof1 = mkProfile(e, "prof-gse-1", { role: "worker" });
  const prof2 = mkProfile(e, "prof-gse-2", { role: "worker" });
  mkAgent(e, "agent-gse-target", "proj-gse", "GSE", prof1);
  mkHumanSchedule(e, "sched-gse-target", "agent-gse-target");

  const res = await app.inject({ method: "POST", url: "/api/agents/agent-gse-target", payload: { profileId: prof2 } });
  check("(G-E) REST POST -> 200", res.statusCode === 200);
  check("(G-E) the rebind itself applied", e.db.getAgent("agent-gse-target").profileId === prof2);
  check("(G-E) a HUMAN REST rebind leaves a createdBy:human schedule's provenance UNTOUCHED (human intent stays human intent)",
    e.db.getSchedule("sched-gse-target")?.createdBy === "human");
  cleanup(e);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — an agent REBIND onto a different, already-existing profile now files an agent_profile_rebind audit event (with a rebindReach response field) on every surface (setup/platform/manager/REST); the manager's agent_assign_profile REFUSES a restrictedTools removal via rebind with no write (its ONLY route to that axis), while Setup/Platform/REST stay audit-only by design (Setup's own round-1 guard was reversed — it was bypassable via profile_update); the event survives deleteAgent's cascade; and (round 3, card acd3c688) every AGENT-surface rebind resets a createdBy:human schedule targeting that agent to createdBy:agent, never touching a sibling schedule on a different agent or a HUMAN REST rebind — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
cleanupPathSync(tmpHome);
process.exit(failures === 0 ? 0 : 1);
