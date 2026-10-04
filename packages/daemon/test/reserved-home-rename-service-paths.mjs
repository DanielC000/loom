import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 5dff8d08 — two of the SessionService call sites named by the card's own conditions:
// `platformEscalate` and the private `nudgeHomeOperator` (exercised via its public caller
// `workspaceAuditHandoff`). Both used to resolve their reserved home with a raw
// `db.getReservedProjectByName(...)`, which goes blind the moment a human renames the reserved project via
// PATCH /api/projects/:id (allowed for `name` — only repoPath rebind/archive/delete are refused for
// p.reserved). After the fix both resolve via the stable app_meta id marker (resolvePlatformHome /
// resolveSetupHome, card a47dd144) instead.
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE — a REAL Db + SessionService driven directly (no MCP layer),
// modeled on platform-escalate-dedup.mjs and user-audit-handoff.mjs.
//
// Proves:
//   (1) platformEscalate: a FIRST call (before any rename) resolves + backfills the stable marker (mirrors
//       what seedPlatformHome already does at boot, long before any manager could call this). AFTER a
//       human rename of the reserved home, a SECOND (distinct-title) call STILL resolves the SAME home —
//       files onto the same project id — instead of throwing "no reserved Loom Platform project exists".
//   (2) workspaceAuditHandoff → nudgeHomeOperator: AFTER a human rename of the reserved setup home, the
//       nudge still reaches the SAME live home operator session (delivered-live), confined to it alone.
//
// Run: 1) build (turbo builds shared first), 2) node test/reserved-home-rename-service-paths.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-resrename-svc-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

const now = new Date().toISOString();

// ===================== (1) platformEscalate survives a rename of the "Loom Platform" home =====================
{
  class SeamHost extends createSeamHost(PtyHost) {
    enqueueStdin() { throw new Error("no live Lead in this test — enqueueStdin should never be reached"); }
  }
  const events = {
    onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
    onBusy(id, busy) { db.setBusy(id, busy); },
    onContextStats() {}, onRateLimited() {},
    onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
  };
  const db = new Db();
  db.insertProject({ id: "pHome", name: "Loom Platform", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: true });
  db.insertProject({ id: "pOrd", name: "Ordinary", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: false });
  db.insertAgent({ id: "agentMgr", projectId: "pOrd", name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
  db.insertSession({
    id: "MGR", projectId: "pOrd", agentId: "agentMgr", engineSessionId: null, title: null, cwd: tmpHome,
    processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
    role: "manager", parentSessionId: null,
  });
  const host = new SeamHost(events);
  const svc = new SessionService(db, host, new OrchestrationControl());

  // A pre-rename call mirrors what seedPlatformHome's own resolvePlatformHome call already does at boot —
  // it resolves by name (no marker yet) and backfills the stable marker.
  const first = svc.platformEscalate("MGR", { title: "First escalation", detail: "before rename" });
  check("(1) pre-rename escalation files onto the reserved home", first.projectId === "pHome");
  check("(1) pre-rename escalation backfilled the stable marker", db.getMeta("platform.homeProjectId") === "pHome");

  // The human rename — the exact write PATCH /api/projects/:id performs on `name`.
  db.updateProject("pHome", { name: "My Renamed Loom Platform" });
  check("(1) the home is genuinely renamed", db.getProject("pHome")?.name === "My Renamed Loom Platform");
  check("(1) fixture sanity: the raw pre-fix name lookup (called directly here, never via production code) " +
    "returns undefined after the rename — confirms this fixture genuinely reproduces the bug",
    db.getReservedProjectByName("Loom Platform") === undefined);

  // A DISTINCT title (never deduped against the first) — AFTER the rename.
  const second = svc.platformEscalate("MGR", { title: "Second, distinct escalation", detail: "after rename" });
  check("(1) POST-rename escalation STILL resolves the SAME reserved home (not a thrown error)", second.projectId === "pHome");
  check("(1) both escalations landed as separate tasks on the same board", first.taskId !== second.taskId);
  db.close();
}

// ===================== (2) workspaceAuditHandoff/nudgeHomeOperator survives a rename of the setup home ====
{
  const db = new Db();
  db.insertProject({ id: "pSetup", name: "Platform", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: true });
  db.insertProject({ id: "pOrd2", name: "Ordinary2", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: false });
  db.insertAgent({ id: "agentOp", projectId: "pSetup", name: "Platform", startupPrompt: "OP", position: 0, profileId: null });
  db.insertAgent({ id: "agentWork", projectId: "pOrd2", name: "Dev", startupPrompt: "WORK", position: 0, profileId: null });
  const seedSession = (id, role, opts = {}) => db.insertSession({
    id, projectId: opts.projectId ?? "pOrd2", agentId: opts.agentId ?? "agentWork", engineSessionId: opts.engineSessionId ?? null,
    title: null, cwd: tmpHome, processState: opts.processState ?? "live", resumability: "unknown", busy: false,
    createdAt: now, lastActivity: now, lastError: null, role, parentSessionId: null,
  });
  seedSession("WSA", "workspace-auditor", { projectId: "pSetup" });
  seedSession("OP", "setup", { projectId: "pSetup", agentId: "agentOp", processState: "live" });

  const enqueued = [];
  const pty = {
    enqueueStdin: (id, text) => {
      enqueued.push({ id, text });
      return db.getSession(id)?.processState === "live" ? { delivered: true } : { delivered: false };
    },
  };
  const svc = new SessionService(db, pty, new OrchestrationControl());

  // Pre-rename call backfills the stable marker (mirrors seedSetupHome's own resolveSetupHome at boot).
  const pre = svc.workspaceAuditHandoff("WSA", { count: 1 });
  check("(2) pre-rename handoff reaches the live operator", pre.deliveryStatus === "delivered-live");
  check("(2) pre-rename handoff backfilled the stable marker", db.getMeta("setup.homeProjectId") === "pSetup");

  db.updateProject("pSetup", { name: "My Renamed Setup Home" });
  check("(2) the setup home is genuinely renamed", db.getProject("pSetup")?.name === "My Renamed Setup Home");
  check("(2) fixture sanity: the raw pre-fix name lookup (called directly here, never via production code) " +
    "returns undefined after the rename — confirms this fixture genuinely reproduces the bug",
    db.getReservedProjectByName("Platform") === undefined);

  enqueued.length = 0;
  const post = svc.workspaceAuditHandoff("WSA", { count: 2 });
  check("(2) POST-rename handoff STILL reaches the SAME live operator (delivered-live)", post.deliveryStatus === "delivered-live");
  check("(2) the nudge reached EXACTLY the operator session (confined)", enqueued.length === 1 && enqueued[0].id === "OP");
  db.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — platformEscalate and workspaceAuditHandoff (nudgeHomeOperator) both keep resolving their " +
    "reserved home via the stable app_meta id marker after a human rename, instead of going blind the way the " +
    "pre-fix raw db.getReservedProjectByName(...) lookup did."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
