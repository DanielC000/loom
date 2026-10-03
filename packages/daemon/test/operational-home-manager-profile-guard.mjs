import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card d25e4ea7 — the "under-protection" divergence direction named in docs/decisions/ced4285e's
// "Predicate divergence" section: an ORDINARY (non-reserved) project whose `repoPath` is `LOOM_HOME`
// itself or an ANCESTOR of it. Before this card, `reservedProjectManagerProfileError` /
// `reservedProjectAgentBoundToProfile` (agents/clone-core.ts) keyed on `project.reserved` ALONE, so none
// of them fired for such a project — while `37e15c26`'s session-start guard (`isLoomHomeOrAncestor`
// alone) WOULD still refuse a manager session there. A manager-role agent/profile could be freely minted
// or reassigned into a project that could never actually host a manager — the exact stranded-row hazard
// `ced4285e` closed for `project.reserved`, reopened through the path door.
//
// Fix: both predicates (and the manager surface's `agent_assign_profile`, below) now go through the
// unified `managerSessionBarredFrom` (`project.reserved === true || isLoomHomeOrAncestor(repoPath)`),
// so an operational-home-PATH project is barred too. See
// docs/decisions/d25e4ea7-unify-reserved-and-operational-home-manager-predicates.md.
//
// Proves, mirroring reserved-home-manager-agent-reassign-guard.mjs's routes A-D, against `pOpHome`
// (reserved:false, repoPath === an ANCESTOR of LOOM_HOME):
//   (A) agent_update REFUSES reassigning a manager-role profile.
//   (B) profile_assign REFUSES the same.
//   (C) profile_update REFUSES flipping an existing bound profile's role to "manager".
//   (D) template_apply REFUSES a manager-role-roster template.
// Each paired with a control proving it still succeeds against a genuinely ORDINARY project (`pOrdinary`,
// unrelated to LOOM_HOME), and a non-manager control against `pOpHome` itself (not a blanket refusal).
//
// Plus (E): the manager surface's `agent_assign_profile` (SessionService.assignAgentProfile, the card's
// "Added scope") — REFUSED when the calling manager's own project is `pOpHome`, ALLOWED when it's
// `pOrdinary`. Not reachable via a live spawn today (a manager can never itself run inside a barred
// project — see startmanager-reserved-home-refusal.mjs), so the manager session row here is inserted
// directly (bypassing the spawn guard), same hermetic-unit-test shape as agent-assignable-profile-guard.mjs.
//
// HERMETIC + CLAUDE-FREE + NETWORK-FREE: a REAL Db, the REAL PlatformMcpRouter over an in-process MCP
// InMemoryTransport (no HTTP) for (A)-(D); a REAL SessionService against a no-op pty for (E).
//
// RED-PROVEN manually before commit: temporarily reverted `managerSessionBarredFrom`'s OR-combination
// (clone-core.ts) back to `project.reserved` alone, rebuilt, and re-ran this file — A1/B1/C1/D1/E1 all
// failed (the manager-role reassignment/flip/template/assign unexpectedly succeeded against pOpHome);
// every control still passed. Restored the fix, rebuilt, re-ran GREEN before committing.
//
// Run: 1) build (turbo builds shared first), 2) node test/operational-home-manager-profile-guard.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

import { requireHermeticEnv } from "./_guard.mjs";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

// --- Hermetic LOOM_HOME + sandboxed HOME, set BEFORE importing dist (paths.ts reads LOOM_HOME at import
// time). pOpHome's repoPath is the PARENT of this tmpHome — an ANCESTOR of LOOM_HOME. ---
const tmpHome = path.join(os.tmpdir(), `loom-ophome-mgrguard-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
requireHermeticEnv();

const ancestorOfLoomHome = path.dirname(tmpHome); // an ANCESTOR of LOOM_HOME — never written to
const ordinaryRepo = path.join(tmpHome, "ordinary-repo"); // a SUBdirectory of tmpHome — NOT barred
fs.mkdirSync(ordinaryRepo, { recursive: true });

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pOpHome", name: "Operational Home Path (not reserved)", repoPath: ancestorOfLoomHome, vaultPath: ancestorOfLoomHome, config: {}, createdAt: now, archivedAt: null, reserved: false });
// Card d25e4ea7 review follow-up (6fff4ba4): the exact-match form of the path half — repoPath === LOOM_HOME
// itself, not merely an ancestor of it — was never separately asserted. isLoomHomeOrAncestor matches both
// shapes, but nothing proved the EXACT-match branch independent of the ancestor one.
db.insertProject({ id: "pOpHomeExact", name: "Operational Home Path (exact, not reserved)", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertProject({ id: "pOrdinary", name: "Ordinary Project", repoPath: ordinaryRepo, vaultPath: ordinaryRepo, config: {}, createdAt: now, archivedAt: null, reserved: false });

db.insertProfile({ id: "profManager", name: "Manager Rig", role: "manager", description: "", allowDelta: [], skills: null, model: null, icon: null });
db.insertProfile({ id: "profWorker", name: "Worker Rig", role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null });

// (A)/(B) fixtures.
db.insertAgent({ id: "agentAU_OpHome", projectId: "pOpHome", name: "AU-OpHome", startupPrompt: "x", position: 0, profileId: null });
db.insertAgent({ id: "agentAU_OpHomeControl", projectId: "pOpHome", name: "AU-OpHome-Control", startupPrompt: "x", position: 1, profileId: null });
db.insertAgent({ id: "agentAU_Ordinary", projectId: "pOrdinary", name: "AU-Ordinary", startupPrompt: "x", position: 2, profileId: null });
db.insertAgent({ id: "agentAU_OpHomeExact", projectId: "pOpHomeExact", name: "AU-OpHomeExact", startupPrompt: "x", position: 10, profileId: null });
db.insertAgent({ id: "agentPA_OpHome", projectId: "pOpHome", name: "PA-OpHome", startupPrompt: "x", position: 3, profileId: null });
db.insertAgent({ id: "agentPA_OpHomeControl", projectId: "pOpHome", name: "PA-OpHome-Control", startupPrompt: "x", position: 4, profileId: null });
db.insertAgent({ id: "agentPA_Ordinary", projectId: "pOrdinary", name: "PA-Ordinary", startupPrompt: "x", position: 5, profileId: null });

// (C) fixtures.
db.insertProfile({ id: "profFlipOpHome", name: "Flip OpHome", role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null });
db.insertProfile({ id: "profFlipOrdinary", name: "Flip Ordinary", role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null });
db.insertAgent({ id: "agentBoundOpHome", projectId: "pOpHome", name: "Bound-OpHome", startupPrompt: "x", position: 6, profileId: "profFlipOpHome" });
db.insertAgent({ id: "agentBoundOrdinary", projectId: "pOrdinary", name: "Bound-Ordinary", startupPrompt: "x", position: 7, profileId: "profFlipOrdinary" });

// (D) fixtures — profiles bound by NAME (applyWorkflowTemplate never mints), matching "Solo builder"'s
// roster exactly (same shape as reserved-home-manager-agent-reassign-guard.mjs's (D) fixtures).
db.insertProfile({ id: "profTplOrchestrator", name: "Orchestrator", role: "manager", description: "", allowDelta: [], skills: null, model: null, icon: null });
db.insertProfile({ id: "profTplDev", name: "Dev", role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null });
db.insertProfile({ id: "profTplCodeReviewer", name: "Code Reviewer", role: null, description: "", allowDelta: [], skills: null, model: null, icon: null });

// (E) fixtures — a manager session row bound to each project, inserted directly (bypassing the spawn
// guard — see the file header for why that's the correct hermetic-unit-test shape here).
db.insertAgent({ id: "agentForMgrOpHome", projectId: "pOpHome", name: "Mgr-OpHome", startupPrompt: "x", position: 8, profileId: null });
db.insertAgent({ id: "agentForMgrOrdinary", projectId: "pOrdinary", name: "Mgr-Ordinary", startupPrompt: "x", position: 9, profileId: null });
db.insertSession({
  id: "M_OpHome", projectId: "pOpHome", agentId: "agentForMgrOpHome", engineSessionId: null, title: null, cwd: ordinaryRepo,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: "manager", parentSessionId: null,
});
db.insertSession({
  id: "M_Ordinary", projectId: "pOrdinary", agentId: "agentForMgrOrdinary", engineSessionId: null, title: null, cwd: ordinaryRepo,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: "manager", parentSessionId: null,
});

const router = new PlatformMcpRouter(db, /* sessions (unused — none of A-D touch it) */ {});
const parse = (res) => JSON.parse(res.content[0].text);

class SeamHost extends createSeamHost(PtyHost) {
  stop() {}
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const svc = new SessionService(db, new SeamHost(events), new OrchestrationControl());

try {
  const server = router.buildServer();
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "operational-home-manager-profile-guard-test", version: "0" });
  await client.connect(clientT);
  const call = async (name, args) => parse(await client.callTool({ name, arguments: args }));

  // ===================== (A) agent_update reassignment =====================
  const a1 = await call("agent_update", { agentId: "agentAU_OpHome", profileId: "profManager" });
  check("(A1) agent_update REFUSES reassigning a manager-role profile onto an agent in a non-reserved, operational-home-path project",
    typeof a1.error === "string" && /manager/i.test(a1.error));
  check("(A1) the refused agent_update made NO write", db.getAgent("agentAU_OpHome").profileId === null);

  const a2 = await call("agent_update", { agentId: "agentAU_OpHomeControl", profileId: "profWorker" });
  check("(A2) agent_update SUCCEEDS reassigning a worker-role profile into the SAME operational-home-path project (control)",
    a2.profileId === "profWorker" && db.getAgent("agentAU_OpHomeControl").profileId === "profWorker");

  const a3 = await call("agent_update", { agentId: "agentAU_Ordinary", profileId: "profManager" });
  check("(A3) agent_update SUCCEEDS reassigning a manager-role profile into a GENUINELY ordinary project (control)",
    a3.profileId === "profManager" && db.getAgent("agentAU_Ordinary").profileId === "profManager");

  // (A1-exact) the EXACT-match path form: a non-reserved project whose repoPath IS LOOM_HOME itself
  // (not merely an ancestor of it) must be refused too — isLoomHomeOrAncestor matches both shapes, but
  // only the ancestor shape was previously exercised here.
  const aExact = await call("agent_update", { agentId: "agentAU_OpHomeExact", profileId: "profManager" });
  check("(A1-exact) agent_update REFUSES reassigning a manager-role profile onto an agent in a non-reserved project whose repoPath IS LOOM_HOME exactly",
    typeof aExact.error === "string" && /manager/i.test(aExact.error));
  check("(A1-exact) the refused agent_update made NO write", db.getAgent("agentAU_OpHomeExact").profileId === null);

  // ===================== (B) profile_assign reassignment =====================
  const b1 = await call("profile_assign", { agentId: "agentPA_OpHome", profileId: "profManager" });
  check("(B1) profile_assign REFUSES assigning a manager-role profile onto an agent in the operational-home-path project",
    typeof b1.error === "string" && /manager/i.test(b1.error));
  check("(B1) the refused profile_assign made NO write", db.getAgent("agentPA_OpHome").profileId === null);

  const b2 = await call("profile_assign", { agentId: "agentPA_OpHomeControl", profileId: "profWorker" });
  check("(B2) profile_assign SUCCEEDS assigning a worker-role profile into the SAME operational-home-path project (control)",
    b2.profileId === "profWorker" && db.getAgent("agentPA_OpHomeControl").profileId === "profWorker");

  const b3 = await call("profile_assign", { agentId: "agentPA_Ordinary", profileId: "profManager" });
  check("(B3) profile_assign SUCCEEDS assigning a manager-role profile into a GENUINELY ordinary project (control)",
    b3.profileId === "profManager" && db.getAgent("agentPA_Ordinary").profileId === "profManager");

  // ===================== (C) profile_update role-flip =====================
  const c1 = await call("profile_update", { profileId: "profFlipOpHome", patch: { role: "manager" } });
  check("(C1) profile_update REFUSES flipping role to manager while bound to an agent in the operational-home-path project",
    typeof c1.error === "string" && /manager/i.test(c1.error) &&
    c1.error.includes("agentBoundOpHome") && c1.error.includes("pOpHome"));
  check("(C1) the refused role-flip left the profile's role UNCHANGED (still worker)", db.getProfile("profFlipOpHome").role === "worker");

  const c2 = await call("profile_update", { profileId: "profFlipOrdinary", patch: { role: "manager" } });
  check("(C2) profile_update SUCCEEDS flipping role to manager when bound only to a GENUINELY ordinary project's agent (control)",
    c2.role === "manager" && db.getProfile("profFlipOrdinary").role === "manager");

  // ===================== (D) template_apply =====================
  const nAgentsOpHomeBeforeTpl = db.listAgents("pOpHome").length;
  const d1 = await call("template_apply", { projectId: "pOpHome", templateName: "Solo builder" });
  check("(D1) template_apply REFUSES a manager-role-roster template into the operational-home-path project",
    typeof d1.error === "string" && /manager/i.test(d1.error));
  check("(D1) the refused template_apply made NO agent", db.listAgents("pOpHome").length === nAgentsOpHomeBeforeTpl);

  const nAgentsOrdinaryBeforeTpl = db.listAgents("pOrdinary").length;
  const d2 = await call("template_apply", { projectId: "pOrdinary", templateName: "Solo builder" });
  check("(D2) template_apply SUCCEEDS applying the SAME template to a GENUINELY ordinary project (control)",
    !d2.error && Array.isArray(d2.agents) && d2.agents.length === 3 &&
    db.listAgents("pOrdinary").length === nAgentsOrdinaryBeforeTpl + 3);

  await client.close();

  // ===================== (E) manager surface's agent_assign_profile (assignAgentProfile) =====================
  let threwE1 = null;
  try { svc.assignAgentProfile("M_OpHome", "agentForMgrOpHome", "profManager"); } catch (e) { threwE1 = e; }
  check("(E1) assignAgentProfile REFUSES a manager-role profile when the calling manager's own project is the operational-home-path project",
    threwE1 instanceof Error && /manager/i.test(threwE1.message));
  check("(E1) the refused assignAgentProfile made NO write", db.getAgent("agentForMgrOpHome").profileId === null);

  let threwE2 = null;
  let assignedE2 = null;
  try { assignedE2 = svc.assignAgentProfile("M_Ordinary", "agentForMgrOrdinary", "profManager"); } catch (e) { threwE2 = e; }
  check("(E2) assignAgentProfile SUCCEEDS with the SAME manager-role profile when the calling manager's own project is GENUINELY ordinary (control)",
    threwE2 === null && assignedE2?.profileId === "profManager" && db.getAgent("agentForMgrOrdinary").profileId === "profManager");
} finally {
  db.close();
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — agent_update/profile_assign/profile_update/template_apply (clone-core's reservedProjectManagerProfileError/reservedProjectAgentBoundToProfile) and the manager surface's agent_assign_profile all now refuse a manager-role profile/agent landing in a NON-reserved project whose repoPath is an ANCESTOR of LOOM_HOME, exactly as they already did for a reserved project — with a non-manager control (not a blanket refusal) and a genuinely-ordinary-project control (not a blanket manager ban) on every route."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
