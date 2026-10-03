import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 73c16ec8 (discovered from 37e15c26's manager session-start reserved-home refusal): the Platform
// Lead's agent_create/agent_clone/agent_clone_batch (mcp/platform.ts, all routed through the SHARED
// createAgentCore/cloneAgentCore in agents/clone-core.ts) had NO check against minting a MANAGER-role
// agent into a reserved/system project (the Platform/Setup home). 37e15c26's own session-start guard
// refuses a manager START against a reserved home outright, so such an agent row could never successfully
// spawn — a dangling, confusing row. Unlike the setup surface's OWN blanket "no agent at all in a reserved
// project" refusal (mcp/setup.ts ~474), the Lead legitimately administers non-manager agents in its own
// reserved home (e.g. cloning its own Auditor) — so the fix is NARROWER: refuse ONLY when the resolved
// profile role is "manager" AND the target project is reserved.
//
// This file calls createAgentCore/cloneAgentCore DIRECTLY (bypassing every MCP-layer pre-check), so it
// proves the CORE's own guard, not an agent-surface wrapper. Proves:
//   (a) createAgentCore REJECTS a manager-role profile into a reserved project — zero agent rows created.
//   (b) createAgentCore SUCCEEDS for a non-manager (worker-role) profile into the SAME reserved project —
//       the control showing this is NOT a blanket reserved-project refusal (unlike setup.ts's).
//   (c) createAgentCore SUCCEEDS for a profile-less (profileId omitted) agent into the SAME reserved
//       project — a second control on the same axis.
//   (d) createAgentCore SUCCEEDS for a manager-role profile into a NON-reserved project — proves the
//       refusal is reserved-project-scoped, not a blanket ban on manager-role agents everywhere.
//   (e) cloneAgentCore REJECTS cloning a manager-role SOURCE agent into a reserved TARGET project — the
//       same guard, reached through the clone path (agent_clone/agent_clone_batch's shared chokepoint).
//   (f) cloneAgentCore SUCCEEDS cloning a non-manager (worker-role) SOURCE agent into the SAME reserved
//       target project — the clone-path control.
//
// RED-PROVEN manually before commit: temporarily reverted clone-core.ts's new guard block, rebuilt, and
// re-ran this file — (a) and (e) both failed (the manager-role creates/clones unexpectedly succeeded);
// (b)/(c)/(d)/(f) still passed. Restored the guard, rebuilt, and re-ran GREEN before committing.
//
// Run: 1) build (turbo builds shared first), 2) node test/reserved-home-manager-agent-guard.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-reservedhome-manageragent-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

const { Db } = await import("../dist/db.js");
const { createAgentCore, cloneAgentCore } = await import("../dist/agents/clone-core.js");

try {
  const db = new Db(path.join(tmpHome, "loom.db"));
  const now = new Date().toISOString();
  db.insertProject({ id: "pReserved", name: "Loom Platform", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: true });
  // card d25e4ea7: pOrdinary's repoPath must NOT alias LOOM_HOME itself (unlike pReserved's) — the
  // unified managerSessionBarredFrom predicate now bars a project whose repoPath IS LOOM_HOME regardless
  // of `reserved`, so a project meant to be genuinely "ordinary" needs a repoPath that is neither equal
  // to, nor an ancestor of, LOOM_HOME. A SUBdirectory of tmpHome is fine (isLoomHomeOrAncestor only bars
  // equal-to-or-an-ancestor-of LOOM_HOME, never a descendant — see 37e15c26's "nested project" carve-out).
  const ordinaryRepo = path.join(tmpHome, "ordinary-repo");
  fs.mkdirSync(ordinaryRepo, { recursive: true });
  db.insertProject({ id: "pOrdinary", name: "Ordinary Project", repoPath: ordinaryRepo, vaultPath: ordinaryRepo, config: {}, createdAt: now, archivedAt: null, reserved: false });

  db.insertProfile({ id: "profManager", name: "Manager Rig", role: "manager", description: "", allowDelta: [], skills: null, model: null, icon: null });
  db.insertProfile({ id: "profWorker", name: "Worker Rig", role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null });

  // ===================== (a) createAgentCore REJECTS manager-role into a reserved project =============
  const beforeA = db.listAgents("pReserved").length;
  const resA = createAgentCore(db, { projectId: "pReserved", name: "ManagerIntoReserved", profileId: "profManager" });
  check("(a) createAgentCore REJECTS a manager-role profile into a reserved project",
    resA.ok === false && /manager/i.test(resA.error ?? "") && /reserved/i.test(resA.error ?? ""));
  check("(a) the rejected manager-into-reserved call created NO agent row", db.listAgents("pReserved").length === beforeA);

  // ===================== (b) createAgentCore SUCCEEDS for worker-role into the SAME reserved project ===
  const resB = createAgentCore(db, { projectId: "pReserved", name: "WorkerIntoReserved", profileId: "profWorker" });
  check("(b) createAgentCore SUCCEEDS for a worker-role profile into a reserved project (not a blanket refusal)",
    resB.ok === true && resB.agent.profileId === "profWorker");

  // ===================== (c) createAgentCore SUCCEEDS for a profile-less agent into the SAME reserved project
  const resC = createAgentCore(db, { projectId: "pReserved", name: "ProfilelessIntoReserved" });
  check("(c) createAgentCore SUCCEEDS for a profile-less agent into a reserved project",
    resC.ok === true && resC.agent.profileId === null);

  // ===================== (d) createAgentCore SUCCEEDS for manager-role into a NON-reserved project ======
  const resD = createAgentCore(db, { projectId: "pOrdinary", name: "ManagerIntoOrdinary", profileId: "profManager" });
  check("(d) createAgentCore SUCCEEDS for a manager-role profile into a non-reserved project",
    resD.ok === true && resD.agent.profileId === "profManager");

  // ===================== (e) cloneAgentCore REJECTS cloning a manager-role SOURCE into a reserved TARGET
  db.insertAgent({ id: "agentSourceManager", projectId: "pOrdinary", name: "SourceManager", startupPrompt: "x", position: 0, profileId: "profManager" });
  const beforeE = db.listAgents("pReserved").length;
  const resE = cloneAgentCore(db, "agentSourceManager", "pReserved", {});
  check("(e) cloneAgentCore REJECTS cloning a manager-role source into a reserved target project",
    resE.ok === false && /manager/i.test(resE.error ?? "") && /reserved/i.test(resE.error ?? ""));
  check("(e) the rejected manager-role clone-into-reserved created NO agent row", db.listAgents("pReserved").length === beforeE);

  // ===================== (f) cloneAgentCore SUCCEEDS cloning a worker-role SOURCE into the SAME reserved TARGET
  db.insertAgent({ id: "agentSourceWorker", projectId: "pOrdinary", name: "SourceWorker", startupPrompt: "x", position: 1, profileId: "profWorker" });
  const resF = cloneAgentCore(db, "agentSourceWorker", "pReserved", {});
  check("(f) cloneAgentCore SUCCEEDS cloning a worker-role source into a reserved target project (clone-path control)",
    resF.ok === true && resF.agent.profileId === "profWorker");

  db.close();
} finally {
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — createAgentCore/cloneAgentCore refuse minting/cloning a MANAGER-role agent into a reserved/system project (it could never successfully start there per 37e15c26's session-start guard), while a non-manager or profile-less agent still succeeds into the SAME reserved project (not a blanket refusal), and a manager-role agent still succeeds into a NON-reserved project (not a blanket manager ban)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
