import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card ad098631 (checkpoint-investigated, manager-approved before any edit): decision 3de74275 lets the
// Platform Lead's agent_create/agent_update/profile_assign bind an elevated/locked-role profile
// (platform/auditor/workspace-auditor/operator/setup — LOCKED_PROFILE_ROLES minus "assistant") via
// allowElevatedRoles, framed as "administering its own home's standing agents" — but nothing confined
// such a bind to a reserved/system project. FIVE reachable write sites (only 3 named by the original
// card; 2 more found by reading the actual guards, not trusting the card body):
//   (A) agent_create -> createAgentCore (clone-core.ts).
//   (B) agent_update's profileId-reassignment branch (mcp/platform.ts).
//   (C) profile_assign (mcp/platform.ts).
//   (D) profile_update's role-flip branch (mcp/platform.ts) — only ever checked a flip INTO "manager"
//       (ced4285e); a flip into any OTHER locked role was completely unchecked.
//   (E) agent_clone/agent_clone_batch -> cloneAgentCore -> clonedProfileRoleError (clone-core.ts) — that
//       role check only ever covered "operator" and isPlatformProfile ("platform"/"auditor"); "setup"
//       and "workspace-auditor" were never checked at all, so cloning one of those cross-project was
//       completely unguarded.
//
// Fix: ONE new shared predicate, nonReservedElevatedProfileError(project, profile) (clone-core.ts) — the
// structural inverse of reservedProjectManagerProfileError: refuses when profile.role is in
// LOCKED_PROFILE_ROLES, is NOT "assistant", and the target project's `reserved` flag is not true. Wired
// UNCONDITIONALLY inside createAgentCore (closing (A) AND (E) with one placement, since cloneAgentCore
// forwards into createAgentCore), plus at (B)/(C)'s existing reservedErr call sites. A new reverse-scan,
// nonReservedAgentBoundToProfile(db, profileId) (the structural inverse of
// reservedProjectAgentBoundToProfile), is wired into (D)'s role-flip branch. "assistant" is excluded BY
// CONSTRUCTION (createAgentCore is also the companion auto-clone's own create path, which legitimately
// mints "assistant"-role agents into ordinary projects) — see docs/decisions/ad098631 for the full
// write-site list and the "which reserved project" limitation left open.
//
// HERMETIC + CLAUDE-FREE + NETWORK-FREE: a REAL Db, the REAL PlatformMcpRouter over an in-process MCP
// InMemoryTransport (no HTTP) — same harness shape as reserved-home-manager-agent-reassign-guard.mjs and
// platform-agent-clone.mjs. sessions is an unused stub (none of these tools touch SessionService).
//
// Proves, for EACH of agent_create (A) / agent_update (B) / profile_assign (C) / profile_update (D) /
// agent_clone+agent_clone_batch (E):
//   - REJECTS binding/cloning a locked-role (non-"assistant") profile into/onto an agent in a
//     NON-reserved project, zero write.
//   - SUCCEEDS for the SAME locked role into/onto the SAME reserved project (control: not a blanket ban
//     on the role).
//   - SUCCEEDS for role "assistant" into a NON-reserved project (control: the structural carve-out still
//     works — this is the companion-provisioning shape).
//   - SUCCEEDS for an ordinary (non-locked) role into a NON-reserved project (control: not a blanket ban
//     on binding/cloning at all).
// Plus (D): an unrelated patch (D1b, its OWN independent profile/agent, never D1's) still SUCCEEDS
// (not a blanket refusal); an unrelated patch to a profile ALREADY in a locked role (setup), legacy-bound
// in a non-reserved project (D3a — a state no guarded write path could create, simulating a pre-existing
// row), still SUCCEEDS (flip-gating control, pins the `v.value.role !== existing.role` gate, mirroring
// ced4285e round 2's MINOR fix for the same shape); and a locked->locked flip (assistant->setup) while
// bound in a non-reserved project is REFUSED (D3b — proves the flip check fires off the NEW role
// regardless of whether the OLD role was itself locked).
//
// RED-PROVEN manually before commit, TWO rounds:
// (1) changed both predicates' own match-branch `return` (the error string / the found {agent,project})
//     to `return null` in place — condition logic untouched, so narrowing stays valid — rebuilt, and
//     re-ran this file: every REJECTS case (A1/B1/C1/D1/E1/E3/E5) flipped to FAIL; every control
//     (A2-4/B2-3/C2-3/D1b/D2/D3a/D3b/E2/E4) stayed PASS unaffected. Restored, rebuilt, re-ran GREEN.
// (2) Code Review follow-up: dropped the `v.value.role !== existing.role` clause from (D)'s role-flip
//     condition (mcp/platform.ts), rebuilt, and re-ran — D3a alone flipped to FAIL (the unrelated patch
//     to the already-"setup" legacy profile was now wrongly refused), every other case/control
//     unaffected. Restored the clause, rebuilt, re-ran GREEN before committing.
//
// Run: 1) build (turbo builds shared first), 2) node test/reserved-home-elevated-bind-guard.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

import { requireHermeticEnv } from "./_guard.mjs";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

const tmpHome = path.join(os.tmpdir(), `loom-elevbind-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
requireHermeticEnv();

const repo = path.join(tmpHome, "repo");
fs.mkdirSync(repo, { recursive: true });

const { Db } = await import("../dist/db.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pReserved", name: "Loom Platform", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: true });
db.insertProject({ id: "pOrdinary", name: "Ordinary Project", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false });

db.insertProfile({ id: "profPlatform", name: "Platform Rig", role: "platform", description: "", allowDelta: [], skills: null, model: null, icon: null });
db.insertProfile({ id: "profSetup", name: "Setup Rig", role: "setup", description: "", allowDelta: [], skills: null, model: null, icon: null });
db.insertProfile({ id: "profWorkspaceAuditor", name: "WS Auditor Rig", role: "workspace-auditor", description: "", allowDelta: [], skills: null, model: null, icon: null });
db.insertProfile({ id: "profAssistant", name: "Assistant Rig", role: "assistant", description: "", allowDelta: [], skills: null, model: null, icon: null });
db.insertProfile({ id: "profWorker", name: "Worker Rig", role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null });

const router = new PlatformMcpRouter(db, /* sessions (unused — none of these tools touch it) */ {});
const parse = (res) => JSON.parse(res.content[0].text);

try {
  const server = router.buildServer();
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "reserved-home-elevated-bind-guard-test", version: "0" });
  await client.connect(clientT);
  const call = async (name, args) => parse(await client.callTool({ name, arguments: args }));

  // ===================== (A) agent_create -> createAgentCore =====================
  const a1 = await call("agent_create", { projectId: "pOrdinary", name: "A1", profileId: "profPlatform" });
  check("(A1) agent_create REJECTS binding a platform-role profile into a NON-reserved project",
    typeof a1.error === "string" && /reserved/i.test(a1.error) && !a1.id);

  const a2 = await call("agent_create", { projectId: "pReserved", name: "A2", profileId: "profPlatform" });
  check("(A2) agent_create SUCCEEDS binding the SAME platform-role profile into a reserved project (control)",
    a2.profileId === "profPlatform" && !a2.error);

  const a3 = await call("agent_create", { projectId: "pOrdinary", name: "A3", profileId: "profAssistant" });
  check("(A3) agent_create SUCCEEDS binding an assistant-role profile into a NON-reserved project (structural carve-out control)",
    a3.profileId === "profAssistant" && !a3.error);

  const a4 = await call("agent_create", { projectId: "pOrdinary", name: "A4", profileId: "profWorker" });
  check("(A4) agent_create SUCCEEDS binding an ordinary (non-locked) profile into a NON-reserved project (control: not a blanket ban)",
    a4.profileId === "profWorker" && !a4.error);

  // ===================== (B) agent_update reassignment =====================
  const agentB_Ordinary = await call("agent_create", { projectId: "pOrdinary", name: "B-target-ordinary" });
  const agentB_Reserved = await call("agent_create", { projectId: "pReserved", name: "B-target-reserved" });

  const b1 = await call("agent_update", { agentId: agentB_Ordinary.id, profileId: "profSetup" });
  check("(B1) agent_update REJECTS reassigning a setup-role profile onto an agent in a NON-reserved project",
    typeof b1.error === "string" && /reserved/i.test(b1.error));
  check("(B1) the rejected agent_update made NO write", db.getAgent(agentB_Ordinary.id).profileId === null);

  const b2 = await call("agent_update", { agentId: agentB_Reserved.id, profileId: "profSetup" });
  check("(B2) agent_update SUCCEEDS reassigning the SAME setup-role profile onto an agent in a reserved project (control)",
    b2.profileId === "profSetup" && db.getAgent(agentB_Reserved.id).profileId === "profSetup");

  const b3 = await call("agent_update", { agentId: agentB_Ordinary.id, profileId: "profAssistant" });
  check("(B3) agent_update SUCCEEDS reassigning an assistant-role profile onto an agent in a NON-reserved project (carve-out control)",
    b3.profileId === "profAssistant" && !b3.error);

  // ===================== (C) profile_assign reassignment =====================
  const agentC_Ordinary = await call("agent_create", { projectId: "pOrdinary", name: "C-target-ordinary" });
  const agentC_Reserved = await call("agent_create", { projectId: "pReserved", name: "C-target-reserved" });

  const c1 = await call("profile_assign", { agentId: agentC_Ordinary.id, profileId: "profWorkspaceAuditor" });
  check("(C1) profile_assign REJECTS assigning a workspace-auditor-role profile onto an agent in a NON-reserved project",
    typeof c1.error === "string" && /reserved/i.test(c1.error));
  check("(C1) the rejected profile_assign made NO write", db.getAgent(agentC_Ordinary.id).profileId === null);

  const c2 = await call("profile_assign", { agentId: agentC_Reserved.id, profileId: "profWorkspaceAuditor" });
  check("(C2) profile_assign SUCCEEDS assigning the SAME workspace-auditor-role profile onto an agent in a reserved project (control)",
    c2.profileId === "profWorkspaceAuditor" && db.getAgent(agentC_Reserved.id).profileId === "profWorkspaceAuditor");

  const c3 = await call("profile_assign", { agentId: agentC_Ordinary.id, profileId: "profWorker" });
  check("(C3) profile_assign SUCCEEDS assigning an ordinary (non-locked) profile onto an agent in a NON-reserved project (control)",
    c3.profileId === "profWorker" && !c3.error);

  // ===================== (D) profile_update role-flip =====================
  db.insertProfile({ id: "profFlipOrdinary", name: "Flip Ordinary", role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null });
  db.insertProfile({ id: "profFlipOrdinaryUnrelated", name: "Flip Ordinary Unrelated", role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null });
  db.insertProfile({ id: "profFlipReserved", name: "Flip Reserved", role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null });
  db.insertProfile({ id: "profFlipAssistant", name: "Flip Assistant", role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null });
  db.insertAgent({ id: "agentFlipBoundOrdinary", projectId: "pOrdinary", name: "Flip-Bound-Ordinary", startupPrompt: "x", position: 0, profileId: "profFlipOrdinary" });
  db.insertAgent({ id: "agentFlipBoundOrdinaryUnrelated", projectId: "pOrdinary", name: "Flip-Bound-Ordinary-Unrelated", startupPrompt: "x", position: 7, profileId: "profFlipOrdinaryUnrelated" });
  db.insertAgent({ id: "agentFlipBoundReserved", projectId: "pReserved", name: "Flip-Bound-Reserved", startupPrompt: "x", position: 1, profileId: "profFlipReserved" });
  db.insertAgent({ id: "agentFlipBoundAssistant", projectId: "pOrdinary", name: "Flip-Bound-Assistant", startupPrompt: "x", position: 2, profileId: "profFlipAssistant" });

  const d1 = await call("profile_update", { profileId: "profFlipOrdinary", patch: { role: "operator" } });
  check("(D1) profile_update REJECTS flipping role to operator while bound to an agent in a NON-reserved project",
    typeof d1.error === "string" && /operator/i.test(d1.error) && /reserved/i.test(d1.error) &&
    d1.error.includes("agentFlipBoundOrdinary") && d1.error.includes("pOrdinary"));
  check("(D1) the rejected role-flip left the profile's role UNCHANGED (still worker)", db.getProfile("profFlipOrdinary").role === "worker");

  // Control: an UNRELATED patch to a DIFFERENT (not D1's) ordinary-bound profile still succeeds (not a
  // blanket refusal) — its own fresh profile/agent, so this is an independent control, never a cascade
  // off D1's outcome (D1 is itself rejected, so profFlipOrdinary never actually changes role either way,
  // but a distinct fixture removes any doubt).
  const d1b = await call("profile_update", { profileId: "profFlipOrdinaryUnrelated", patch: { name: "Flip Ordinary Renamed" } });
  check("(D1b) an unrelated patch (name) to a DIFFERENT ordinary-bound profile still SUCCEEDS (not a blanket refusal, independent of D1)",
    d1b.name === "Flip Ordinary Renamed" && d1b.role === "worker");

  const d2 = await call("profile_update", { profileId: "profFlipReserved", patch: { role: "operator" } });
  check("(D2) profile_update SUCCEEDS flipping role to operator when bound only to an agent in a reserved project (control)",
    d2.role === "operator" && db.getProfile("profFlipReserved").role === "operator");

  // Code Review follow-up: a profile ALREADY in a locked role (not "assistant"), bound to an agent in a
  // NON-reserved project through a route this guard never covers (a direct db write — simulating a row
  // that predates this card, or one no guarded write path could ever legitimately create), getting an
  // UNRELATED patch (rename, no role field in the patch at all). Must SUCCEED — pins the
  // `v.value.role !== existing.role` gate (mcp/platform.ts ~2075): the new check fires ONLY on an actual
  // FLIP, never a same-role edit, even when the existing state is already "non-compliant".
  db.insertProfile({ id: "profLegacySetup", name: "Legacy Setup", role: "setup", description: "", allowDelta: [], skills: null, model: null, icon: null });
  db.insertAgent({ id: "agentLegacySetupBoundOrdinary", projectId: "pOrdinary", name: "Legacy-Setup-Bound-Ordinary", startupPrompt: "x", position: 8, profileId: "profLegacySetup" });
  const d3a = await call("profile_update", { profileId: "profLegacySetup", patch: { name: "Legacy Setup Renamed" } });
  check("(D3a) profile_update: an UNRELATED patch to an ALREADY-locked-role (setup) profile bound in a NON-reserved project SUCCEEDS (flip-gating control, pins v.value.role !== existing.role)",
    d3a.name === "Legacy Setup Renamed" && d3a.role === "setup" && !d3a.error);

  // Code Review follow-up: a locked->locked flip (assistant -> setup) while bound to an agent in a
  // NON-reserved project must be REFUSED — proves the flip check fires off the NEW role regardless of
  // whether the OLD role was itself locked (not just when the old role was an ordinary "worker").
  db.insertProfile({ id: "profFlipLockedToLocked", name: "Flip Locked To Locked", role: "assistant", description: "", allowDelta: [], skills: null, model: null, icon: null, restrictedTools: true });
  db.insertAgent({ id: "agentFlipLockedToLockedBoundOrdinary", projectId: "pOrdinary", name: "Flip-Locked-Bound-Ordinary", startupPrompt: "x", position: 9, profileId: "profFlipLockedToLocked" });
  const d3b = await call("profile_update", { profileId: "profFlipLockedToLocked", patch: { role: "setup" } });
  check("(D3b) profile_update REJECTS a locked->locked flip (assistant->setup) while bound to an agent in a NON-reserved project",
    typeof d3b.error === "string" && /setup/i.test(d3b.error) && /reserved/i.test(d3b.error));
  check("(D3b) the rejected locked->locked flip left the profile's role UNCHANGED (still assistant)",
    db.getProfile("profFlipLockedToLocked").role === "assistant");

  const d3 = await call("profile_update", { profileId: "profFlipAssistant", patch: { role: "assistant", restrictedTools: true } });
  check("(D3) profile_update SUCCEEDS flipping role to assistant while bound to an agent in a NON-reserved project (carve-out control)",
    d3.role === "assistant" && !d3.error);

  // ===================== (E) agent_clone / agent_clone_batch =====================
  const sourceSetup = await call("agent_create", { projectId: "pReserved", name: "Source-Setup", profileId: "profSetup" });
  const sourceWsAuditor = await call("agent_create", { projectId: "pReserved", name: "Source-WsAuditor", profileId: "profWorkspaceAuditor" });
  const sourceAssistant = await call("agent_create", { projectId: "pReserved", name: "Source-Assistant", profileId: "profAssistant" });

  const e1 = await call("agent_clone", { sourceAgentId: sourceSetup.id, targetProjectId: "pOrdinary" });
  check("(E1) agent_clone REJECTS cloning a setup-role profiled agent into a NON-reserved project (createAgentCore backstop)",
    typeof e1.error === "string" && /reserved/i.test(e1.error) && !e1.id);

  const e2 = await call("agent_clone", { sourceAgentId: sourceSetup.id, targetProjectId: "pReserved" });
  check("(E2) agent_clone SUCCEEDS cloning the SAME setup-role profiled agent into a reserved project (control)",
    e2.profileId === "profSetup" && !e2.error);

  const e3 = await call("agent_clone", { sourceAgentId: sourceWsAuditor.id, targetProjectId: "pOrdinary" });
  check("(E3) agent_clone REJECTS cloning a workspace-auditor-role profiled agent into a NON-reserved project (createAgentCore backstop)",
    typeof e3.error === "string" && /reserved/i.test(e3.error) && !e3.id);

  const e4 = await call("agent_clone", { sourceAgentId: sourceAssistant.id, targetProjectId: "pOrdinary" });
  check("(E4) agent_clone SUCCEEDS cloning an assistant-role profiled agent into a NON-reserved project (companion-provisioning shape, carve-out control)",
    e4.profileId === "profAssistant" && !e4.error);

  const nAgentsOrdinaryBeforeBatch = db.listAgents("pOrdinary").length;
  const e5 = await call("agent_clone_batch", {
    sourceAgentId: sourceWsAuditor.id,
    targets: [{ targetProjectId: "pOrdinary" }, { targetProjectId: "pReserved" }],
  });
  check("(E5) agent_clone_batch: the NON-reserved target is REJECTED, the reserved target SUCCEEDS, per-entry independent",
    typeof e5[0].error === "string" && /reserved/i.test(e5[0].error) && !e5[0].agent &&
    e5[1].agent?.profileId === "profWorkspaceAuditor" && !e5[1].error);
  check("(E5) the rejected batch entry made NO agent in pOrdinary", db.listAgents("pOrdinary").length === nAgentsOrdinaryBeforeBatch);

  await client.close();
} finally {
  db.close();
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — agent_create/agent_update/profile_assign/agent_clone+agent_clone_batch all refuse binding or cloning an elevated/locked-role profile (other than \"assistant\") into/onto a NON-reserved project, profile_update refuses FLIPPING a profile's role into one of those roles while it is bound to such an agent (never an unrelated/same-role patch) — each with a reserved-project control (not a blanket ban on the role) and an assistant/non-locked-role control (not a blanket ban on binding/cloning at all)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
