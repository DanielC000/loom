import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card ced4285e (discovered from 73c16ec8): 73c16ec8 refused MINTING a manager-role agent into a
// reserved/system project (createAgentCore — see reserved-home-manager-agent-guard.mjs). The same
// stranded-row hazard (37e15c26's session-start guard refuses a manager START against a reserved home
// outright) is reachable by FOUR other routes that never go through createAgentCore:
//   (A) agent_update reassigning an EXISTING reserved-project agent's profileId to a manager-role profile.
//   (B) profile_assign doing the same reassignment.
//   (C) profile_update flipping an EXISTING profile's role to "manager" while that profile is already
//       bound to an agent living in a reserved project — a profile is shared/cross-project, so this
//       strands an agent WITHOUT ever touching the agent row.
//   (D) (round 2, Code Review 04e0e82c, MAJOR) template_apply (the Platform Lead's own tool, NOT the
//       setup surface's — see setup-surface.mjs for that one, which already refuses ANY reserved
//       projectId before ever reaching applyWorkflowTemplate) writes agent rows via db.insertAgent
//       directly — never through createAgentCore — so it can mint a manager-role "Orchestrator" into a
//       reserved project via a bundled workflow template (reproduced).
// (A fifth candidate route — moving an existing agent's projectId into a reserved home — was
// investigated and found structurally unreachable: db.updateAgent's patch type, agents/validate.ts's
// AgentPatch/validateAgentPatch, and the manager-surface updateAgentPreset all omit projectId entirely;
// no write path anywhere changes an existing agent's project. See docs/decisions/ced4285e-*.md.)
//
// Fix: reservedProjectManagerProfileError (clone-core.ts) — the SAME predicate createAgentCore now
// calls — is also called from agent_update and profile_assign before writing profileId; and
// reservedProjectAgentBoundToProfile (clone-core.ts) is called from profile_update whenever a role FLIP
// (existing.role !== "manager" && new role === "manager") targets "manager" — round 2 narrowed this from
// the resolved role alone, so an unrelated/same-role patch to an already-manager profile is never
// refused. For (D), reservedProjectManagerProfileError is called INSIDE applyWorkflowTemplate's own
// all-or-nothing pre-flight (setup/templates.ts) for every resolved agent/profile pair — not at either
// MCP call site — skippable only by `humanAuthorized: true` (the human REST template-apply route).
//
// HERMETIC + CLAUDE-FREE + NETWORK-FREE: a REAL Db, the REAL PlatformMcpRouter over an in-process MCP
// InMemoryTransport (no HTTP). sessions is an unused stub (none of agent_update/profile_assign/
// profile_update/template_apply touch SessionService — they only touch db), same pattern as
// platform-agent-update.mjs.
//
// Proves, for EACH of agent_update (A) / profile_assign (B) / profile_update (C) / template_apply (D):
//   - REJECTS the manager-role-into-reserved-project hazard, zero write.
//   - SUCCEEDS for the same reserved project with a non-manager role (control: not a blanket refusal).
//   - SUCCEEDS for a manager-role profile/agent pairing in a NON-reserved project (control: not a
//     blanket ban on manager-role profiles).
// Plus, for (C): an unrelated OR same-role patch to a profile already bound in a reserved project still
// SUCCEEDS (control proving the FLIP gating, round 2).
//
// RED-PROVEN manually before commit: temporarily reverted the three new guard call sites in
// mcp/platform.ts (agent_update/profile_assign/profile_update), rebuilt, and re-ran this file — A1/B1/C1
// all failed (the manager-role reassignment/role-flip unexpectedly succeeded); every control still
// passed. Restored the guards, rebuilt, and re-ran GREEN before committing.
// ROUND 2 RED-PROVEN manually: reverted the new reservedProjectManagerProfileError call inside
// applyWorkflowTemplate's pre-flight (setup/templates.ts), rebuilt, and re-ran — D1 failed (the
// manager-role template apply unexpectedly succeeded, minting "Orchestrator" into the reserved project);
// every other case + control still passed. Restored the guard, rebuilt, re-ran GREEN before committing.
//
// Run: 1) build (turbo builds shared first), 2) node test/reserved-home-manager-agent-reassign-guard.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

import { requireHermeticEnv } from "./_guard.mjs";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

const tmpHome = path.join(os.tmpdir(), `loom-reassign-${Date.now()}-${process.pid}`);
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

db.insertProfile({ id: "profManager", name: "Manager Rig", role: "manager", description: "", allowDelta: [], skills: null, model: null, icon: null });
db.insertProfile({ id: "profWorker", name: "Worker Rig", role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null });

// Agents used by (A) agent_update and (B) profile_assign — distinct agents per tool so writes don't interact.
db.insertAgent({ id: "agentAU_Reserved1", projectId: "pReserved", name: "AU-Reserved-1", startupPrompt: "x", position: 0, profileId: null });
db.insertAgent({ id: "agentAU_Reserved2", projectId: "pReserved", name: "AU-Reserved-2", startupPrompt: "x", position: 1, profileId: null });
db.insertAgent({ id: "agentAU_Ordinary", projectId: "pOrdinary", name: "AU-Ordinary", startupPrompt: "x", position: 2, profileId: null });
db.insertAgent({ id: "agentPA_Reserved1", projectId: "pReserved", name: "PA-Reserved-1", startupPrompt: "x", position: 3, profileId: null });
db.insertAgent({ id: "agentPA_Reserved2", projectId: "pReserved", name: "PA-Reserved-2", startupPrompt: "x", position: 4, profileId: null });
db.insertAgent({ id: "agentPA_Ordinary", projectId: "pOrdinary", name: "PA-Ordinary", startupPrompt: "x", position: 5, profileId: null });

// Profiles used by (C) profile_update's role-flip hazard — one per scenario so flips don't interact.
db.insertProfile({ id: "profFlipReserved", name: "Flip Reserved", role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null });
db.insertProfile({ id: "profFlipOrdinary", name: "Flip Ordinary", role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null });
db.insertProfile({ id: "profFlipUnbound", name: "Flip Unbound", role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null });
db.insertAgent({ id: "agentBoundReserved", projectId: "pReserved", name: "Bound-Reserved", startupPrompt: "x", position: 6, profileId: "profFlipReserved" });
db.insertAgent({ id: "agentBoundOrdinary", projectId: "pOrdinary", name: "Bound-Ordinary", startupPrompt: "x", position: 7, profileId: "profFlipOrdinary" });
// profFlipUnbound has no agent bound to it at all.

// Round 2: a profile ALREADY role "manager", bound (via direct db write — no MCP guard would ever let
// this bind happen live, since reservedProjectManagerProfileError refuses it at assign time) to an agent
// in the reserved project. Proves the (C) guard is gated on a FLIP, never the resolved role: round 1's
// `v.value.role === "manager"` would wrongly re-scan and refuse an UNRELATED patch here, even though no
// flip is happening and the "stranding" was never created through any guarded path.
db.insertProfile({ id: "profAlreadyManager", name: "Already Manager", role: "manager", description: "", allowDelta: [], skills: null, model: null, icon: null });
db.insertAgent({ id: "agentAlreadyManagerBoundReserved", projectId: "pReserved", name: "Already-Manager-Bound", startupPrompt: "x", position: 8, profileId: "profAlreadyManager" });

// Round 2, (D) template_apply: profiles bound by NAME (applyWorkflowTemplate never mints), matching the
// "Solo builder" template's roster exactly — an "Orchestrator" agent bound to a manager-role profile is
// the hazard; "Dev"/"Code Reviewer" are worker/null-role so the template resolves cleanly otherwise.
db.insertProfile({ id: "profTplOrchestrator", name: "Orchestrator", role: "manager", description: "", allowDelta: [], skills: null, model: null, icon: null });
db.insertProfile({ id: "profTplDev", name: "Dev", role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null });
db.insertProfile({ id: "profTplCodeReviewer", name: "Code Reviewer", role: null, description: "", allowDelta: [], skills: null, model: null, icon: null });

const router = new PlatformMcpRouter(db, /* sessions (unused — none of these tools touch it) */ {});
const parse = (res) => JSON.parse(res.content[0].text);

try {
  const server = router.buildServer();
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "reserved-home-manager-agent-reassign-guard-test", version: "0" });
  await client.connect(clientT);
  const call = async (name, args) => parse(await client.callTool({ name, arguments: args }));

  // ===================== (A) agent_update reassignment =====================
  const a1 = await call("agent_update", { agentId: "agentAU_Reserved1", profileId: "profManager" });
  check("(A1) agent_update REJECTS reassigning a manager-role profile onto an agent in a reserved project",
    typeof a1.error === "string" && /manager/i.test(a1.error) && /reserved/i.test(a1.error));
  check("(A1) the rejected agent_update made NO write", db.getAgent("agentAU_Reserved1").profileId === null);

  const a2 = await call("agent_update", { agentId: "agentAU_Reserved2", profileId: "profWorker" });
  check("(A2) agent_update SUCCEEDS reassigning a worker-role profile into the SAME reserved project (control)",
    a2.profileId === "profWorker" && db.getAgent("agentAU_Reserved2").profileId === "profWorker");

  const a3 = await call("agent_update", { agentId: "agentAU_Ordinary", profileId: "profManager" });
  check("(A3) agent_update SUCCEEDS reassigning a manager-role profile into a NON-reserved project (control)",
    a3.profileId === "profManager" && db.getAgent("agentAU_Ordinary").profileId === "profManager");

  // ===================== (B) profile_assign reassignment =====================
  const b1 = await call("profile_assign", { agentId: "agentPA_Reserved1", profileId: "profManager" });
  check("(B1) profile_assign REJECTS assigning a manager-role profile onto an agent in a reserved project",
    typeof b1.error === "string" && /manager/i.test(b1.error) && /reserved/i.test(b1.error));
  check("(B1) the rejected profile_assign made NO write", db.getAgent("agentPA_Reserved1").profileId === null);

  const b2 = await call("profile_assign", { agentId: "agentPA_Reserved2", profileId: "profWorker" });
  check("(B2) profile_assign SUCCEEDS assigning a worker-role profile into the SAME reserved project (control)",
    b2.profileId === "profWorker" && db.getAgent("agentPA_Reserved2").profileId === "profWorker");

  const b3 = await call("profile_assign", { agentId: "agentPA_Ordinary", profileId: "profManager" });
  check("(B3) profile_assign SUCCEEDS assigning a manager-role profile into a NON-reserved project (control)",
    b3.profileId === "profManager" && db.getAgent("agentPA_Ordinary").profileId === "profManager");

  // ===================== (C) profile_update role-flip =====================
  const c1 = await call("profile_update", { profileId: "profFlipReserved", patch: { role: "manager" } });
  check("(C1) profile_update REJECTS flipping role to manager while bound to an agent in a reserved project",
    typeof c1.error === "string" && /manager/i.test(c1.error) && /reserved/i.test(c1.error) &&
    c1.error.includes("agentBoundReserved") && c1.error.includes("pReserved"));
  check("(C1) the rejected role-flip left the profile's role UNCHANGED (still worker)", db.getProfile("profFlipReserved").role === "worker");

  // Control: an UNRELATED patch to the same still-bound-in-reserved profile still succeeds (not a blanket refusal).
  const c1b = await call("profile_update", { profileId: "profFlipReserved", patch: { name: "Flip Reserved Renamed" } });
  check("(C1b) an unrelated patch (name) to the SAME reserved-bound profile still SUCCEEDS (not a blanket refusal)",
    c1b.name === "Flip Reserved Renamed" && c1b.role === "worker");

  const c2 = await call("profile_update", { profileId: "profFlipOrdinary", patch: { role: "manager" } });
  check("(C2) profile_update SUCCEEDS flipping role to manager when bound only to a NON-reserved-project agent (control)",
    c2.role === "manager" && db.getProfile("profFlipOrdinary").role === "manager");

  const c3 = await call("profile_update", { profileId: "profFlipUnbound", patch: { role: "manager" } });
  check("(C3) profile_update SUCCEEDS flipping role to manager for a profile with NO agents bound at all (control)",
    c3.role === "manager" && db.getProfile("profFlipUnbound").role === "manager");

  // Round 2 (MINOR, flip-gating control): an unrelated patch to a profile that is ALREADY "manager" —
  // even one bound to a reserved-project agent via a route no guard would ever permit live — must NOT be
  // refused. This is the case round 1's resolved-role check got wrong (see the fixture comment above).
  const c4 = await call("profile_update", { profileId: "profAlreadyManager", patch: { icon: "🆗" } });
  check("(C4) profile_update: an unrelated patch to an ALREADY-manager profile SUCCEEDS regardless of any reserved-project binding (flip-gating control)",
    c4.icon === "🆗" && c4.role === "manager" && !c4.error);

  // ===================== (D) template_apply (round 2) =====================
  const nAgentsReservedBeforeTpl = db.listAgents("pReserved").length;
  const d1 = await call("template_apply", { projectId: "pReserved", templateName: "Solo builder" });
  check("(D1) template_apply REJECTS applying a template whose roster includes a manager-role agent into a reserved project",
    typeof d1.error === "string" && /manager/i.test(d1.error) && /reserved/i.test(d1.error));
  check("(D1) the rejected template_apply made NO agent", db.listAgents("pReserved").length === nAgentsReservedBeforeTpl);

  const nAgentsOrdinaryBeforeTpl = db.listAgents("pOrdinary").length;
  const d2 = await call("template_apply", { projectId: "pOrdinary", templateName: "Solo builder" });
  check("(D2) template_apply SUCCEEDS applying the SAME template to a NON-reserved project (control)",
    !d2.error && Array.isArray(d2.agents) && d2.agents.length === 3 &&
    db.listAgents("pOrdinary").length === nAgentsOrdinaryBeforeTpl + 3);

  await client.close();
} finally {
  db.close();
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — agent_update + profile_assign refuse reassigning a manager-role profile onto an agent already living in a reserved/system project, profile_update refuses FLIPPING an EXISTING profile's role to manager while it is bound to such an agent (never a same-role/unrelated patch), and template_apply refuses applying a manager-role-roster template into a reserved project — each with a non-manager/non-reserved control proving the refusal is narrow, not a blanket ban."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
