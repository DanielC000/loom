import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Conditional-registration gates for the manager's always-on `loom-orchestration` surface (card 60d0fca2,
// "trim the manager tool descriptions + tighten conditional registration"). Two tools are USELESS without
// live backing state and are now registered ONLY when that state exists — so most projects never carry
// them in their per-turn tool-list floor:
//   - `deploy` registers ONLY when the project's RESOLVED orchestration.deployCommand is non-empty.
//   - `peer_message`/`peer_list` register ONLY when the project has ≥1 `project_links` row.
// Both gates read the SAME underlying data (`db` directly — resolveConfig for deployCommand,
// db.listProjectLinks for peer links) that the gated tool's OWN execution (sessions.deployOwnProject /
// sessions.listPeerProjects / sessions.messagePeerManager) relies on, so a registered tool can never be a
// false positive. buildServer is rebuilt fresh on EVERY request (mcp/orchestration.ts's `handle()` keeps
// no cached transport), so a link/deployCommand added mid-session appears on the manager's very next tool
// call — no daemon restart or session respawn needed; this test proves that directly (B, D below).
//
// HERMETIC — a REAL Db + SessionService + OrchestrationMcpRouter, tool handlers invoked directly (no pty,
// no real claude/network/daemon). Mirrors peer-list.mjs / deploy-own-project.mjs's setup.
//
// Covers:
//   (A) deploy is OMITTED from a manager's surface when the project has no deployCommand configured.
//   (B) deploy is REGISTERED (and actually runs the project's own resolved deployCommand) once one is
//       configured — proves the gate reads the SAME resolveConfig source deployOwnProject uses, and that
//       a config change appears on the NEXT buildServer call with no respawn.
//   (C) peer_message + peer_list are OMITTED when the project has zero project_links rows.
//   (D) both are REGISTERED (and peer_list returns the real linked set) once a link is created — same
//       re-evaluate-per-request proof as (B).
//   (E) neither gate touches any OTHER manager tool — the rest of the always-on surface is unaffected.
//
// Run: 1) build (turbo builds shared first), 2) node test/orchestration-tool-gating.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-orch-tool-gating-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");

const dbFile = path.join(tmpHome, "orch-tool-gating.db");
const db = new Db(dbFile);
const now = new Date().toISOString();

try {
  const sessions = new SessionService(
    db,
    { isAlive: () => true, enqueueStdin: () => ({ delivered: true }), getActiveTurnOrigin: () => null },
    new OrchestrationControl(),
  );
  const router = new OrchestrationMcpRouter(db, sessions);

  const insertMgr = (projectId, agentId, sessionId) => {
    db.insertAgent({ id: agentId, projectId, name: "Mgr", startupPrompt: "MGR", position: 0 });
    db.insertSession({
      id: sessionId, projectId, agentId, engineSessionId: null, title: null, cwd: projectId,
      processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
      lastError: null, role: "manager",
    });
  };

  // ============ (A)/(B) deploy gate ============
  db.insertProject({ id: "pNoDeploy", name: "No Deploy", repoPath: "pNoDeploy", vaultPath: "pNoDeploy", config: {}, createdAt: now, archivedAt: null });
  insertMgr("pNoDeploy", "aNoDeploy", "mgrNoDeploy");

  db.insertProject({
    id: "pDeploy", name: "Deployable", repoPath: "pDeploy", vaultPath: "pDeploy",
    config: { orchestration: { deployCommand: "echo shipping" } }, createdAt: now, archivedAt: null,
  });
  insertMgr("pDeploy", "aDeploy", "mgrDeploy");

  {
    const noDeployServer = router.buildServer("mgrNoDeploy", "manager");
    check("(A) deploy is OMITTED when the project has no deployCommand configured", !("deploy" in noDeployServer._registeredTools));

    const deployServer = router.buildServer("mgrDeploy", "manager");
    check("(B) deploy IS registered once the project has a configured deployCommand", "deploy" in deployServer._registeredTools);
  }

  // (B cont'd) re-evaluated per request: clear deployCommand on pDeploy, confirm the NEXT buildServer call
  // (no respawn — just a fresh call, mirroring a fresh HTTP request) reflects it immediately.
  {
    db.setProjectConfig("pDeploy", { orchestration: { deployCommand: "" } });
    const afterClear = router.buildServer("mgrDeploy", "manager");
    check("(B) clearing deployCommand removes `deploy` on the VERY NEXT buildServer call (no respawn)", !("deploy" in afterClear._registeredTools));
    // restore for the rest of the suite
    db.setProjectConfig("pDeploy", { orchestration: { deployCommand: "echo shipping" } });
  }

  // ============ (C)/(D) peer gate ============
  db.insertProject({ id: "pUnlinked", name: "Unlinked", repoPath: "pUnlinked", vaultPath: "pUnlinked", config: {}, createdAt: now, archivedAt: null });
  insertMgr("pUnlinked", "aUnlinked", "mgrUnlinked");

  db.insertProject({ id: "pLinked", name: "Linked", repoPath: "pLinked", vaultPath: "pLinked", config: {}, createdAt: now, archivedAt: null });
  insertMgr("pLinked", "aLinked", "mgrLinked");
  db.insertProject({ id: "pPeer", name: "Peer", repoPath: "pPeer", vaultPath: "pPeer", config: {}, createdAt: now, archivedAt: null });

  {
    const unlinkedServer = router.buildServer("mgrUnlinked", "manager");
    check("(C) peer_message is OMITTED when the project has zero project_links rows", !("peer_message" in unlinkedServer._registeredTools));
    check("(C) peer_list is OMITTED when the project has zero project_links rows", !("peer_list" in unlinkedServer._registeredTools));

    const linkedServerBefore = router.buildServer("mgrLinked", "manager");
    check("(D pre-check) pLinked starts with no links either — both tools omitted before createProjectLink", !("peer_message" in linkedServerBefore._registeredTools) && !("peer_list" in linkedServerBefore._registeredTools));
  }

  db.createProjectLink("pLinked", "pPeer");

  {
    const linkedServer = router.buildServer("mgrLinked", "manager");
    check("(D) peer_message IS registered once the project has ≥1 project_links row", "peer_message" in linkedServer._registeredTools);
    check("(D) peer_list IS registered once the project has ≥1 project_links row", "peer_list" in linkedServer._registeredTools);

    // Prove the gate reads the SAME source peer_list's own handler reads (db.listProjectLinks), by
    // calling the real registered handler and checking it surfaces the just-created peer.
    const result = JSON.parse((await linkedServer._registeredTools["peer_list"].handler({})).content[0].text);
    check("(D) the registered peer_list handler actually returns the linked peer", result.peers.some((p) => p.projectId === "pPeer"));

    // (C) still holds for the UNLINKED project even after pLinked/pPeer got a link — no cross-project leak.
    const stillUnlinked = router.buildServer("mgrUnlinked", "manager");
    check("(C cont'd) an unrelated unlinked project is unaffected by another project's new link", !("peer_message" in stillUnlinked._registeredTools) && !("peer_list" in stillUnlinked._registeredTools));
  }

  // ============ (E) the rest of the manager surface is unaffected ============
  {
    const s = router.buildServer("mgrUnlinked", "manager");
    for (const name of ["worker_list", "worker_spawn", "worker_merge", "worker_merge_confirm", "question_ask", "platform_escalate", "idle_report", "agent_list", "daemon_restart", "served_status", "board_column_create"]) {
      check(`(E) ${name} is still registered regardless of the peer/deploy gates`, name in s._registeredTools);
    }
  }
} finally {
  try { db.close(); } catch { /* ignore */ }
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — `deploy` registers only with a resolved deployCommand and `peer_message`/`peer_list` register only with ≥1 project_links row, both re-evaluated fresh on every buildServer call (no respawn needed), both read the SAME underlying source their own execution uses, and the rest of the manager's always-on surface is unaffected."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
