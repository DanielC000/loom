import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Orphaned-fleet strand guard (card 6cd3ce9e, HIGH-severity Auditor finding). Incident: a manager's
// transcript ended "[Request interrupted by user]" → its pty exited → index.ts's onExit archived it
// UNCONDITIONALLY (the old `if (exited && exited.role !== "run") db.archiveSession(sessionId)`), while
// its three workers stayed processState:"live", busy:true, archivedAt:null — no other live manager for
// the project. Archiving drops a row off every rail/god's-eye list (listSessions/listWorkers exclude
// archived rows), so the fleet went invisible, live+busy, with no parent able to review/merge/stop it,
// until a human happened to notice. Fix: SessionService.archiveOnExit — a manager/platform with ≥1 LIVE
// worker/child session at exit is NOT archived (stays on the live rail, visible + resumable) and instead
// files a DISTINCT durable `manager_exited_with_live_workers` alert (+ a role-agnostic lastError banner,
// mirroring the crash-loop pattern). Every other case (no live children, or a non-manager/platform role)
// archives exactly as before — byte-identical. Proven HERMETICALLY (no claude, no daemon) — own temp
// .db, the method driven directly, like worker-exited-without-report.mjs.
//
// Asserts:
//   (a) MANAGER WITH LIVE CHILDREN — NOT archived; a DISTINCT manager_exited_with_live_workers event
//       fires with the correct count + workerIds; lastError carries the [loom:orphaned-fleet] banner.
//   (b) MANAGER WITH NO CHILDREN — archives normally (regression: the common case is unaffected).
//   (c) MANAGER WHOSE ONLY CHILDREN ARE EXITED (not live) — archives normally (only LIVE counts).
//   (d) MANAGER WHOSE ONLY CHILD IS ALREADY ARCHIVED — archives normally (listWorkers excludes archived
//       rows, so an already-archived "live" row can't fake a strand).
//   (e) PLATFORM ROLE WITH LIVE CHILDREN — same guard applies (role parity with manager).
//   (f) NON-MANAGER ROLE (worker) — archives unconditionally regardless of any child rows (out of scope
//       for the gate; byte-identical to the old behavior).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "../dist/db.js";
import { SessionService } from "../dist/sessions/service.js";
import { OrchestrationControl } from "../dist/orchestration/control.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const NOW = new Date();

function makeEnv() {
  const dbFile = path.join(os.tmpdir(), `loom-archexit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Db(dbFile);
  const projId = `ep-${Math.random().toString(36).slice(2, 8)}`;
  const agentId = `ea-${Math.random().toString(36).slice(2, 8)}`;
  const now = NOW.toISOString();
  db.insertProject({ id: projId, name: "ArchiveOnExit", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });
  const pty = { enqueueStdin: () => ({ delivered: false }), getPendingEntries: () => [] };
  const sessions = new SessionService(db, pty, new OrchestrationControl());
  return { dbFile, db, projId, agentId, sessions };
}

function seedSession(e, id, { role = "worker", processState = "exited", parentSessionId = null, archivedAt = null } = {}) {
  e.db.insertSession({
    id, projectId: e.projId, agentId: e.agentId, engineSessionId: "eng-" + id, title: null, cwd: e.projId,
    processState, resumability: "resumable", busy: false,
    createdAt: NOW.toISOString(), lastActivity: NOW.toISOString(), lastError: null, role,
    parentSessionId, taskId: null, ctxInputTokens: null, ctxTurns: null, model: null,
    worktreePath: null, branch: null, recycledFrom: null,
  });
  if (archivedAt) e.db.archiveSession(id);
}
const evKinds = (e, id, kind) => e.db.listEventsForWorker(id).filter((ev) => ev.kind === kind);

function cleanup(e) {
  try { e.db.close(); } catch { /* ignore */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(e.dbFile + ext, { force: true }); } catch { /* ignore */ } }
}

// ============================ (a) MANAGER WITH LIVE CHILDREN → NOT archived, alerted ============================
{
  const e = makeEnv();
  seedSession(e, "mgr-a", { role: "manager", processState: "exited" }); // already exited (onExit already ran setProcessState)
  seedSession(e, "wkr-a1", { role: "worker", processState: "live", parentSessionId: "mgr-a" });
  seedSession(e, "wkr-a2", { role: "worker", processState: "live", parentSessionId: "mgr-a" });

  e.sessions.archiveOnExit(e.db.getSession("mgr-a"));

  check("(a) the manager is NOT archived (stays on the live rail)", e.db.getSession("mgr-a").archivedAt == null);
  const ev = evKinds(e, "mgr-a", "manager_exited_with_live_workers");
  check("(a) exactly one manager_exited_with_live_workers event fires", ev.length === 1);
  check("(a) it carries the correct live count", ev[0]?.detail?.count === 2);
  check("(a) it carries both worker ids", Array.isArray(ev[0]?.detail?.workerIds)
    && ev[0].detail.workerIds.includes("wkr-a1") && ev[0].detail.workerIds.includes("wkr-a2"));
  const err = e.db.getSession("mgr-a").lastError;
  check("(a) lastError carries the [loom:orphaned-fleet] banner naming the stranded count",
    !!err && err.startsWith("[loom:orphaned-fleet]") && /2 worker/.test(err));
  cleanup(e);
}

// ============================ (b) MANAGER WITH NO CHILDREN → archives normally ============================
{
  const e = makeEnv();
  seedSession(e, "mgr-b", { role: "manager", processState: "exited" });

  e.sessions.archiveOnExit(e.db.getSession("mgr-b"));

  check("(b) a childless manager IS archived (regression: common case unaffected)", e.db.getSession("mgr-b").archivedAt != null);
  check("(b) no manager_exited_with_live_workers event fires", evKinds(e, "mgr-b", "manager_exited_with_live_workers").length === 0);
  cleanup(e);
}

// ============================ (c) MANAGER WHOSE ONLY CHILDREN ARE EXITED (not live) → archives normally ======
{
  const e = makeEnv();
  seedSession(e, "mgr-c", { role: "manager", processState: "exited" });
  seedSession(e, "wkr-c1", { role: "worker", processState: "exited", parentSessionId: "mgr-c" });

  e.sessions.archiveOnExit(e.db.getSession("mgr-c"));

  check("(c) a manager whose only children are exited (not live) IS archived", e.db.getSession("mgr-c").archivedAt != null);
  check("(c) no alert fires — an exited child is not a strand", evKinds(e, "mgr-c", "manager_exited_with_live_workers").length === 0);
  cleanup(e);
}

// ============================ (d) MANAGER WHOSE ONLY CHILD IS ALREADY ARCHIVED → archives normally =========
{
  const e = makeEnv();
  seedSession(e, "mgr-d", { role: "manager", processState: "exited" });
  // Marked "live" in process_state but ALREADY archived — listWorkers excludes archived rows outright.
  seedSession(e, "wkr-d1", { role: "worker", processState: "live", parentSessionId: "mgr-d", archivedAt: true });

  e.sessions.archiveOnExit(e.db.getSession("mgr-d"));

  check("(d) a manager whose only 'live' child is already archived IS archived (no false strand)", e.db.getSession("mgr-d").archivedAt != null);
  check("(d) no alert fires", evKinds(e, "mgr-d", "manager_exited_with_live_workers").length === 0);
  cleanup(e);
}

// ============================ (e) PLATFORM ROLE WITH LIVE CHILDREN → same guard applies ============================
{
  const e = makeEnv();
  seedSession(e, "plat-e", { role: "platform", processState: "exited" });
  seedSession(e, "wkr-e1", { role: "worker", processState: "live", parentSessionId: "plat-e" });

  e.sessions.archiveOnExit(e.db.getSession("plat-e"));

  check("(e) a platform session with a live child is NOT archived (role parity with manager)", e.db.getSession("plat-e").archivedAt == null);
  check("(e) it fires the same alert", evKinds(e, "plat-e", "manager_exited_with_live_workers").length === 1);
  cleanup(e);
}

// ============================ (f) NON-MANAGER ROLE → archives unconditionally (out of scope for the gate) ====
{
  const e = makeEnv();
  seedSession(e, "wkr-f", { role: "worker", processState: "exited" });

  e.sessions.archiveOnExit(e.db.getSession("wkr-f"));

  check("(f) a worker session archives unconditionally (byte-identical to the old behavior)", e.db.getSession("wkr-f").archivedAt != null);
  check("(f) no alert fires (the gate is manager/platform-only)", evKinds(e, "wkr-f", "manager_exited_with_live_workers").length === 0);
  cleanup(e);
}

// ============================ (g) EVENT FILING: managerSessionId honors a present parentSessionId ==========
// The event is filed with `managerSessionId: session.parentSessionId ?? session.id` (mirrors session_died/
// session_recovery_abandoned). Scenario (a) above only exercised the `?? session.id` fallback (no parent);
// this proves the OTHER branch — when the exiting session itself carries a parentSessionId — files under
// that parent instead of its own id, while workerSessionId (the SUBJECT, read by evKinds/listEventsForWorker
// elsewhere in this file) is always the exiting session regardless.
{
  const e = makeEnv();
  seedSession(e, "grandparent-g", { role: "manager", processState: "live" });
  seedSession(e, "mgr-g", { role: "manager", processState: "exited", parentSessionId: "grandparent-g" });
  seedSession(e, "wkr-g1", { role: "worker", processState: "live", parentSessionId: "mgr-g" });

  e.sessions.archiveOnExit(e.db.getSession("mgr-g"));

  const ev = evKinds(e, "mgr-g", "manager_exited_with_live_workers");
  check("(g) the event is still filed with workerSessionId = the exiting manager", ev.length === 1);
  check("(g) managerSessionId honors the exiting session's OWN parentSessionId (not its own id)",
    ev[0]?.managerSessionId === "grandparent-g");
  cleanup(e);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a manager/platform session that exits while it still owns ≥1 LIVE worker/child session is NOT silently archived-and-stranded: the row stays on the live rail (visible + resumable) and a distinct manager_exited_with_live_workers alert + lastError banner fires naming the stranded count; a manager with no live children (none, only-exited, or only-already-archived) archives exactly as before, and a non-manager/platform role is untouched."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
