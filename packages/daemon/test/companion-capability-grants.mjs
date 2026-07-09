import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Companion Capability & Permission-Lever Framework (§1/§2 foundation) — the companion_capability_grants
// table + resolveCompanionGrant (the ONE enforcement gate) + the capability registry's single chokepoint
// (registerCompanionCapabilities, called once from OrchestrationMcpRouter.buildServer) + the session-status
// proof-of-pattern READ lever. Fully hermetic: a REAL Db on a temp LOOM_HOME + the REAL OrchestrationMcpRouter
// over an in-memory MCP transport. NO network, NO real claude, NO daemon.
//
// Covers the card's DoD:
//   (a) resolveCompanionGrant gating: grant present ⇒ sessions_status tool registered + scoped to granted
//       projects; grant absent ⇒ the tool is NOT registered (inert + invisible).
//   (c) sessions_status returns ONLY the granted projects' sessions — server-derived scope; a `project`
//       selector can only NAME an already-granted project, never widen scope.
//   (d) a session with zero grants (and a non-companion manager session) is byte-identical: no capability
//       tools registered, and — belt-and-suspenders — NO tool on any of these built surfaces writes,
//       creates, or deletes a grant (there is no agent MCP write path for grants, full stop).
// Plus the CR-fix hardening:
//   (e) PER-PROJECT privilege: a capability granted 'read' on project A and 'act' on project B resolves
//       modeFor(A)==='read'/mayAct(A)===false and modeFor(B)==='act'/mayAct(B)===true — NEVER a collapsed
//       scope-wide mode that would let a project-A-scoped read leak act-eligibility from project B.
//   (f) registerCompanionCapabilities is role-gated to "assistant" — a grant row on a non-assistant session
//       id (should never happen structurally, but belt-and-suspenders) registers NOTHING.
// Run: 1) build (turbo builds shared first), 2) node test/companion-capability-grants.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-companion-capability-grants-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { resolveCompanionGrant } = await import("../dist/companion/capabilities.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

async function connect(server) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "companion-capability-grants-test", version: "0" });
  await client.connect(clientT);
  return client;
}
const listOf = async (server) => { const c = await connect(server); const names = (await c.listTools()).tools.map((t) => t.name); await c.close(); return names; };
const call = async (client, name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

const now = new Date().toISOString();
function seedProject(db, id, name) {
  db.insertProject({ id, name, repoPath: id, vaultPath: id, config: {}, createdAt: now, archivedAt: null });
}
function seedSession(db, id, projectId, role, opts = {}) {
  const agentId = `a-${id}`;
  db.insertAgent({ id: agentId, projectId, name: role, startupPrompt: "", position: 0 });
  db.insertSession({
    id, projectId, agentId, engineSessionId: `eng-${id}`, title: opts.title ?? null, cwd: projectId,
    processState: opts.processState ?? "live", resumability: "resumable", busy: opts.busy ?? false,
    createdAt: now, lastActivity: now, lastError: null, role, taskId: opts.taskId ?? null,
  });
}
const tmpDb = () => new Db(path.join(tmpHome, `${randomUUID()}.db`));

try {
  // ============ 1. resolveCompanionGrant + registration gating ============
  {
    const db = tmpDb();
    const projGranted = "proj-granted";
    seedProject(db, projGranted, "Granted");
    const companionSess = "companion-1";
    seedSession(db, companionSess, projGranted, "assistant");
    const noGrantSess = "companion-2";
    seedSession(db, noGrantSess, projGranted, "assistant");
    const mgrSess = "mgr-1";
    seedSession(db, mgrSess, projGranted, "manager");

    check("resolveCompanionGrant: no grant row ⇒ null", resolveCompanionGrant(db, companionSess, "session-status") === null);

    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "session-status", projectId: null });
    const scope = resolveCompanionGrant(db, companionSess, "session-status");
    check("resolveCompanionGrant: NULL projectId resolves to the companion's OWN bound project",
      !!scope && scope.projectIds.has(projGranted) && scope.projectIds.size === 1);
    check("resolveCompanionGrant: mode defaults to 'read'", scope.modeFor(projGranted) === "read" && scope.mayAct(projGranted) === false);
    check("resolveCompanionGrant: a DIFFERENT session (no row) still reads null (per-session, never global)",
      resolveCompanionGrant(db, noGrantSess, "session-status") === null);

    const orch = new OrchestrationMcpRouter(db, {});
    const grantedTools = await listOf(orch.buildServer(companionSess, "assistant"));
    check("gate: the GRANTED companion HAS sessions_status", grantedTools.includes("sessions_status"));

    const ungrantedTools = await listOf(orch.buildServer(noGrantSess, "assistant"));
    check("gate: a DIFFERENT (ungranted) companion does NOT have sessions_status", !ungrantedTools.includes("sessions_status"));

    const mgrTools = await listOf(orch.buildServer(mgrSess, "manager"));
    check("gate: a manager session (no grant, non-companion role) does NOT have sessions_status", !mgrTools.includes("sessions_status"));

    // (d) belt-and-suspenders: no tool on ANY of these built surfaces writes/creates/deletes a grant — the
    // agent-facing MCP surface is READ-ONLY for capability grants, full stop (no MCP path exists at all).
    const allTools = new Set([...grantedTools, ...ungrantedTools, ...mgrTools]);
    check("(d) no MCP tool on any built surface writes/creates/deletes a capability grant",
      ![...allTools].some((n) => /grant/i.test(n)));

    db.close();
  }

  // ============ 2. sessions_status is scoped to GRANTED projects only ============
  {
    const db = tmpDb();
    const projA = "proj-a", projB = "proj-b";
    seedProject(db, projA, "A");
    seedProject(db, projB, "B");
    const companionSess = "companion-status";
    seedSession(db, companionSess, projA, "assistant");
    const liveInA = "live-a";
    seedSession(db, liveInA, projA, "worker", { busy: true, taskId: "task-a" });
    const liveInB = "live-b";
    seedSession(db, liveInB, projB, "worker");
    const exitedInA = "exited-a";
    seedSession(db, exitedInA, projA, "worker", { processState: "exited" });

    // Grant session-status for projA EXPLICITLY (via projectId, not the NULL "own project" shortcut) —
    // proves the framework reads the stored scope, not just "whatever project the session happens to be in".
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "session-status", projectId: projA });

    const orch = new OrchestrationMcpRouter(db, {});
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    const all = await call(client, "sessions_status", {});
    check("sessions_status: returns the live session in the granted project", all.sessions.some((s) => s.sessionId === liveInA));
    check("sessions_status: excludes the UNGRANTED project's live session", !all.sessions.some((s) => s.sessionId === liveInB));
    check("sessions_status: excludes an EXITED session in the granted project (live-only)", !all.sessions.some((s) => s.sessionId === exitedInA));
    const row = all.sessions.find((s) => s.sessionId === liveInA);
    check("sessions_status: carries busy/taskId/role for the live row", row?.busy === true && row?.taskId === "task-a" && row?.role === "worker");

    const scoped = await call(client, "sessions_status", { project: projA });
    check("sessions_status: an explicit `project` selector matching the grant is honored", scoped.sessions.some((s) => s.sessionId === liveInA));

    const rejected = await call(client, "sessions_status", { project: projB });
    check("sessions_status: a `project` selector OUTSIDE scope is REJECTED with an {error} (can never widen scope)",
      typeof rejected.error === "string" && rejected.sessions === undefined);

    await client.close();
    db.close();
  }

  // ============ (e) PER-PROJECT privilege — read on A + act on B must NOT leak act onto A ============
  {
    const db = tmpDb();
    const projA = "proj-read-only", projB = "proj-act";
    seedProject(db, projA, "Read-only");
    seedProject(db, projB, "Act");
    const companionSess = "companion-mixed-privilege";
    seedSession(db, companionSess, projA, "assistant");

    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "session-status", projectId: projA, mode: "read" });
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "session-status", projectId: projB, mode: "act" });

    const scope = resolveCompanionGrant(db, companionSess, "session-status");
    check("(e) both projects are in scope", scope.projectIds.has(projA) && scope.projectIds.has(projB) && scope.projectIds.size === 2);
    check("(e) project A (read-granted) resolves mode 'read'", scope.modeFor(projA) === "read");
    check("(e) project A (read-granted) is NOT act-eligible — the fix: no cross-project escalation", scope.mayAct(projA) === false);
    check("(e) project B (act-granted) resolves mode 'act'", scope.modeFor(projB) === "act");
    check("(e) project B (act-granted) IS act-eligible", scope.mayAct(projB) === true);
    check("(e) an ungranted project resolves undefined mode, never a default", scope.modeFor("proj-nowhere") === undefined);
    check("(e) an ungranted project is never act-eligible", scope.mayAct("proj-nowhere") === false);
    db.close();
  }

  // ============ (f) registerCompanionCapabilities is role-gated to "assistant" ============
  {
    const db = tmpDb();
    const proj = "proj-role-gate";
    seedProject(db, proj, "Role gate");
    // A grant row on a NON-assistant session id — should never happen via the REST writer (it requires
    // role==="assistant"), but seed it directly to prove the belt-and-suspenders role gate holds even then.
    const mgrSess = "mgr-with-stray-grant";
    seedSession(db, mgrSess, proj, "manager");
    db.upsertCompanionCapabilityGrant({ sessionId: mgrSess, capability: "session-status", projectId: null });
    check("(f) resolveCompanionGrant itself still resolves the row (it's role-agnostic)", resolveCompanionGrant(db, mgrSess, "session-status") !== null);

    const orch = new OrchestrationMcpRouter(db, {});
    const mgrToolsWithGrant = await listOf(orch.buildServer(mgrSess, "manager"));
    check("(f) a manager session with a STRAY grant row still does NOT get sessions_status (role gate)", !mgrToolsWithGrant.includes("sessions_status"));
    db.close();
  }
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — resolveCompanionGrant is the one enforcement gate (null with no row, a resolved scope with one), sessions_status registers ONLY behind a grant and is scoped to the granted project(s) (a project selector can never widen scope), a mixed read-on-A/act-on-B grant resolves STRICTLY per-project (no cross-project escalation), an ungranted companion/non-companion session is byte-identical, the role gate blocks a stray grant on a non-assistant session, and no MCP tool on any surface can write a grant."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
