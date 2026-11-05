import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 6baaa83d — the restrictedTools axis of the agent-row credential-grant guard (decision caca806c).
// DETERMINISTIC, CLAUDE-FREE, NETWORK-FREE: a REAL Db + SessionService over a FAKE pty, the REAL Setup and
// Platform routers over in-process MCP transports, and the manager's SessionService methods called directly.
//
// Proves, per agent-facing path (Setup profile_update/agent_update/profile_assign; Platform profile_update/
// profile_delete/agent_update/profile_assign; manager profile_delete + the already-guarded
// agent_assign_profile), for an agent carrying its OWN connections grant bound to a restrictedTools:true profile:
//   - the widening write is REFUSED, and the END STATE is asserted through the spawn resolver itself
//     (SessionService.resolveAgentSpawn): the agent still resolves restrictedTools:true + keeps its grant;
//     the unfixed code lands role-null + restrictedTools:false + the same agent-row connection.
//   - controls: a grant-free agent may still do the same thing; false->true (narrowing) and an unrelated
//     patch are still allowed; a role-bearing restricted profile is guarded too (restrictedTools only).
// Human REST routes are exempt by design and asserted BEHAVIOURALLY (real buildServer + app.inject: a human
// DELETE /api/profiles/:id and a human agent rebind to profileId:null both succeed on a grant-carrying fixture).
// NOT covered here (named): a test-level tie between the agent-row grant fields and the guard's key list
// (AGENT_CREDENTIAL_GRANT_REASONS is module-private), and a runtime check of the real spawn argv (resolveAgentSpawn is the resolver).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";
import { requireHermeticEnv } from "./_guard.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

useOwnLoomHome("agrt-");
delete process.env.LOOM_PROJECT_WORK_ROOT;
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { SetupMcpRouter } = await import("../dist/mcp/setup.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { resolveConfig } = await import("@loom/shared");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const repo = path.join(os.tmpdir(), `agrt-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# agrt\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", "-c user.email=a@loom -c user.name=a");

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pOrd", name: "Ordinary", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertAgent({ id: "agentHost", projectId: "pOrd", name: "Host", startupPrompt: "H", position: 0, profileId: null });
const seedSession = (id, role) => db.insertSession({
  id, projectId: "pOrd", agentId: "agentHost", engineSessionId: null, title: null, cwd: repo,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
  role, parentSessionId: null,
});
seedSession("SETUP", "setup");
seedSession("PL", "platform");
seedSession("M", "manager");

class SeamHost extends createSeamHost(PtyHost) {
  constructor(events) { super(events); }
  stop() {}
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const svc = new SessionService(db, new SeamHost(events), new OrchestrationControl());
const setupRouter = new SetupMcpRouter(db, svc);
const platformRouter = new PlatformMcpRouter(db, svc);
const parse = (res) => JSON.parse(res.content[0].text);

async function connect(server, name) {
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  const client = new Client({ name, version: "0" });
  await client.connect(c);
  return async (tool, args) => parse(await client.callTool({ name: tool, arguments: args }));
}

// The END STATE, read through the spawn resolver itself (what the agent's next non-plain session gets).
const endState = (agentId) => {
  const agent = db.getAgent(agentId);
  const r = svc.resolveAgentSpawn(agent, resolveConfig(db.getProject(agent.projectId).config), undefined, false, undefined, { skipGrantCarryoverCheck: true });
  return { role: r.profileRole ?? r.role ?? null, restrictedTools: r.restrictedTools, connections: r.connections };
};
const holdsGrantRestricted = (agentId, conn) => {
  const s = endState(agentId);
  return s.role === null && s.restrictedTools === true && s.connections.includes(conn);
};
const widened = (agentId, conn) => {
  const s = endState(agentId);
  return s.role === null && s.restrictedTools === false && s.connections.includes(conn);
};

let seq = 0;
// A restricted profile + a bound agent. grant=false => the agent carries no agent-row grant.
function fixture({ role = null, grant = true } = {}) {
  const n = ++seq;
  const profileId = `prof${n}`;
  const agentId = `agent${n}`;
  const conn = `conn${n}`;
  db.insertProfile({ id: profileId, name: `Rig${n}`, role, description: "", allowDelta: [], skills: null, model: null, icon: null, restrictedTools: true });
  db.insertAgent({ id: agentId, projectId: "pOrd", name: `Agent${n}`, startupPrompt: "x", position: n, profileId, ...(grant ? { connections: [conn] } : {}) });
  return { profileId, agentId, conn };
}
db.insertProfile({ id: "profOpen", name: "OpenRig", role: null, description: "", allowDelta: [], skills: null, model: null, icon: null, restrictedTools: false });

try {
  const setupCall = await connect(setupRouter.buildServer("SETUP"), "agrt-setup");
  const platCall = await connect(platformRouter.buildServer(), "agrt-platform");

  // Sanity: the fixture itself resolves to the "before" state (so a later change is a real transition).
  const base = fixture();
  check("fixture: bound agent resolves role-null + restrictedTools:true + its agent-row grant", holdsGrantRestricted(base.agentId, base.conn));

  for (const [label, call] of [["setup", setupCall], ["platform", platCall]]) {
    // --- profile_update: restrictedTools true->false ---
    const a = fixture();
    const upd = await call("profile_update", { profileId: a.profileId, patch: { restrictedTools: false } });
    check(`${label} profile_update: REFUSES restrictedTools true->false while a bound agent carries its own grant`,
      typeof upd.error === "string" && /connections/i.test(upd.error) && /restrictedTools/.test(upd.error) && /Profiles UI/.test(upd.error));
    check(`${label} profile_update: END STATE unchanged — agent still resolves restricted + keeps its grant`, holdsGrantRestricted(a.agentId, a.conn));
    check(`${label} profile_update: the profile row still has restrictedTools:true`, db.getProfile(a.profileId)?.restrictedTools === true);

    // controls
    const free = fixture({ grant: false });
    const updFree = await call("profile_update", { profileId: free.profileId, patch: { restrictedTools: false } });
    check(`${label} profile_update control: a GRANT-FREE bound agent -> the same relax still succeeds`, !updFree.error && db.getProfile(free.profileId)?.restrictedTools === false);
    const unrelated = await call("profile_update", { profileId: a.profileId, patch: { description: "renamed" } });
    check(`${label} profile_update control: an unrelated patch on the grant-carrying agent's profile still succeeds`, !unrelated.error && unrelated.description === "renamed");
    const narrow = fixture();
    db.updateProfile(narrow.profileId, { ...(({ id, ...r }) => r)(db.getProfile(narrow.profileId)), restrictedTools: false });
    const narrowRes = await call("profile_update", { profileId: narrow.profileId, patch: { restrictedTools: true } });
    check(`${label} profile_update control: false->true (narrowing) with a grant-carrying agent still succeeds`, !narrowRes.error && db.getProfile(narrow.profileId)?.restrictedTools === true);
    const roled = fixture({ role: "worker" });
    const roledRes = await call("profile_update", { profileId: roled.profileId, patch: { restrictedTools: false } });
    check(`${label} profile_update: a ROLE-BEARING restricted profile is guarded on this axis too (role unchanged)`,
      typeof roledRes.error === "string" && /restrictedTools/.test(roledRes.error) && db.getProfile(roled.profileId)?.restrictedTools === true);

    // --- agent_update(profileId) rebind onto an unrestricted profile ---
    const b = fixture();
    const reb = await call("agent_update", { agentId: b.agentId, profileId: "profOpen" });
    check(`${label} agent_update: REFUSES a rebind onto an unrestricted profile for a grant-carrying agent`,
      typeof reb.error === "string" && /restrictedTools/.test(reb.error));
    check(`${label} agent_update: END STATE unchanged (profile binding + resolved restricted + grant)`, db.getAgent(b.agentId)?.profileId === b.profileId && holdsGrantRestricted(b.agentId, b.conn));
    // --- agent_update(profileId: null) clear ---
    const c = fixture();
    const clr = await call("agent_update", { agentId: c.agentId, profileId: null });
    check(`${label} agent_update: REFUSES clearing profileId (backstop is unrestricted) for a grant-carrying agent`,
      typeof clr.error === "string" && /restrictedTools/.test(clr.error));
    check(`${label} agent_update: clear refused — END STATE unchanged`, db.getAgent(c.agentId)?.profileId === c.profileId && holdsGrantRestricted(c.agentId, c.conn));
    // --- profile_assign ---
    const d = fixture();
    const asg = await call("profile_assign", { agentId: d.agentId, profileId: "profOpen" });
    check(`${label} profile_assign: REFUSES assigning an unrestricted profile to a grant-carrying agent`,
      typeof asg.error === "string" && /restrictedTools/.test(asg.error));
    check(`${label} profile_assign: END STATE unchanged`, db.getAgent(d.agentId)?.profileId === d.profileId && holdsGrantRestricted(d.agentId, d.conn));
    // controls: grant-free agent can rebind / clear freely
    const e = fixture({ grant: false });
    const asgFree = await call("profile_assign", { agentId: e.agentId, profileId: "profOpen" });
    check(`${label} profile_assign control: a GRANT-FREE agent can still be rebound onto an unrestricted profile`, !asgFree.error && db.getAgent(e.agentId)?.profileId === "profOpen");
    const f = fixture({ grant: false });
    const clrFree = await call("agent_update", { agentId: f.agentId, profileId: null });
    check(`${label} agent_update control: a GRANT-FREE agent can still clear its profile`, !clrFree.error && db.getAgent(f.agentId)?.profileId === null);
  }

  // --- Platform profile_delete (the card's headline case) ---
  const g = fixture();
  const del = await platCall("profile_delete", { profileId: g.profileId });
  check("platform profile_delete: REFUSES deleting a role-null restricted profile whose bound agent carries its own grant",
    typeof del.error === "string" && /restrictedTools/.test(del.error) && /connections/i.test(del.error));
  check("platform profile_delete: END STATE unchanged — profile survives, agent still restricted + keeps its grant", !!db.getProfile(g.profileId) && holdsGrantRestricted(g.agentId, g.conn));
  const gFree = fixture({ grant: false });
  const delFree = await platCall("profile_delete", { profileId: gFree.profileId });
  check("platform profile_delete control: a GRANT-FREE bound agent -> delete still succeeds", delFree.deleted === true && !db.getProfile(gFree.profileId));
  const gOpen = (() => { const n = ++seq; db.insertProfile({ id: `prof${n}`, name: `Open${n}`, role: null, description: "", allowDelta: [], skills: null, model: null, icon: null, restrictedTools: false }); db.insertAgent({ id: `agent${n}`, projectId: "pOrd", name: `A${n}`, startupPrompt: "x", position: n, profileId: `prof${n}`, connections: [`conn${n}`] }); return { profileId: `prof${n}` }; })();
  const delOpen = await platCall("profile_delete", { profileId: gOpen.profileId });
  check("platform profile_delete control: an UNRESTRICTED role-null profile with a grant-carrying agent still deletes (nothing widens)", delOpen.deleted === true);
  const gRole = fixture({ role: "worker" });
  const delRole = await platCall("profile_delete", { profileId: gRole.profileId });
  check("platform profile_delete: the pre-existing role-axis refusal still fires for a role-bearing profile", typeof delRole.error === "string" && /connections/i.test(delRole.error) && !!db.getProfile(gRole.profileId));

  // --- Manager: profile_delete + agent_assign_profile (regression) ---
  const h = fixture();
  let mgrDelErr = null;
  try { svc.deleteProfileAsManager("M", h.profileId); } catch (e) { mgrDelErr = e.message; }
  check("manager profile_delete: REFUSES deleting a role-null restricted profile whose bound agent carries its own grant",
    typeof mgrDelErr === "string" && /restrictedTools/.test(mgrDelErr));
  check("manager profile_delete: END STATE unchanged — profile survives, agent still restricted + keeps its grant", !!db.getProfile(h.profileId) && holdsGrantRestricted(h.agentId, h.conn));
  const hFree = fixture({ grant: false });
  let mgrFreeErr = null;
  try { svc.deleteProfileAsManager("M", hFree.profileId); } catch (e) { mgrFreeErr = e.message; }
  check("manager profile_delete control: a GRANT-FREE bound agent -> delete still succeeds", mgrFreeErr === null && !db.getProfile(hFree.profileId));
  const i = fixture();
  let mgrAsgErr = null;
  try { svc.assignAgentProfile("M", i.agentId, "profOpen"); } catch (e) { mgrAsgErr = e.message; }
  check("manager agent_assign_profile (regression, untouched predicate): still refuses a restrictedTools removal", typeof mgrAsgErr === "string" && /restrictedTools/.test(mgrAsgErr) && holdsGrantRestricted(i.agentId, i.conn));

  // --- Capabilities-only grant (no connections) is guarded too: Platform profile_update ---
  const capOnly = fixture({ grant: false });
  db.updateAgent(capOnly.agentId, { capabilities: [{ slug: "some-cap" }] });
  const capUpd = await platCall("profile_update", { profileId: capOnly.profileId, patch: { restrictedTools: false } });
  check("capabilities-only agent: platform profile_update REFUSES restrictedTools true->false",
    typeof capUpd.error === "string" && /capabilities/i.test(capUpd.error) && db.getProfile(capOnly.profileId)?.restrictedTools === true);

  // --- A profileId that ALREADY dangles before the write: resolves to the plain backstop, nothing to widen ---
  const dn = ++seq;
  db.insertAgent({ id: `agent${dn}`, projectId: "pOrd", name: `Dangling${dn}`, startupPrompt: "x", position: dn, profileId: `ghost${dn}`, connections: [`conn${dn}`] });
  const dangRes = await platCall("agent_update", { agentId: `agent${dn}`, profileId: "profOpen" });
  check("dangling profileId before the write: rebind onto an unrestricted profile is not refused by the restrictedTools axis",
    !dangRes.error && db.getAgent(`agent${dn}`)?.profileId === "profOpen");

  // --- Human REST stays exempt (BEHAVIOURAL): real buildServer + app.inject, same harness as agent-credential-grant-write.mjs ---
  const { buildServer } = await import("../dist/gateway/server.js");
  const stub = {};
  const app = await buildServer({
    db, pty: { enqueueStdin: () => ({ delivered: true }) }, sessions: stub, mcp: stub, orchMcp: stub,
    platformMcp: stub, auditMcp: stub, userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub,
  });
  const rd = fixture();
  const delRes = await app.inject({ method: "DELETE", url: `/api/profiles/${rd.profileId}` });
  check("human REST DELETE /api/profiles/:id on a grant-carrying restricted fixture SUCCEEDS (exempt)", delRes.statusCode === 200 && !db.getProfile(rd.profileId));
  check("human REST delete: the agent keeps its grant (human relaxed it knowingly)", db.getAgent(rd.agentId)?.connections?.includes(rd.conn));
  const rb = fixture();
  const rbRes = await app.inject({ method: "POST", url: `/api/agents/${rb.agentId}`, payload: { profileId: null } });
  check("human REST agent rebind to profileId:null on a grant-carrying restricted fixture SUCCEEDS (exempt)", rbRes.statusCode === 200 && db.getAgent(rb.agentId)?.profileId === null);
  await app.close?.();
} finally {
  db.close();
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0 ? "\n✅ ALL PASS" : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
