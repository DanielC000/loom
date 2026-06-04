import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Asleep-at-the-Wheel idle-manager watchdog — Task 2 (the `idle_report` manager-surface tool + the
// SessionService.recordIdleReport it calls). HERMETIC like idle-watch-foundation.mjs / profiles.mjs:
// isolated temp DB, imports dist/* + @loom/shared, NO daemon, NO real claude, NO pty. Covers:
//   (S) SERVICE recordIdleReport — each of the 4 states writes the correct P1 idle_nudge_* policy +
//       snooze columns and leaves the unanswered counter at 0:
//         working       → policy 'watching'  (reset)
//         waiting       → policy 'snoozed', snoozeUntil = now + (explicit minutes) — and, separately,
//                         the per-project idleDefaultSnoozeMinutes FALLBACK when minutes is omitted
//         blocked_human → policy 'suppressed'
//         done          → policy 'suppressed'
//       In ALL cases unanswered ends 0 (pre-seeded with recorded nudges first, to prove it's cleared).
//   (T) TOOL SURFACE — `idle_report` is registered on the MANAGER tool surface and NOT on the worker
//       surface (asserted at the McpServer tool-registration seam, where the role gate is applied).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

function tmpDbFile(tag) {
  return path.join(os.tmpdir(), `loom-idlereport-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
}
function rmDb(file) { for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(file + ext, { force: true }); } catch { /* ignore */ } } }

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");

// ============================ (S) SERVICE: recordIdleReport ============================
{
  const file = tmpDbFile("svc");
  const db = new Db(file);
  const now = new Date().toISOString();

  // recordIdleReport touches ONLY db (+ resolveConfig from the project) — never pty/control — so we can
  // drive it with stub deps. (Mirrors how the foundation test drives the db layer with no daemon.)
  const svc = new SessionService(db, /* pty */ {}, /* control */ {});

  // A project whose per-project override sets a DISTINCT idleDefaultSnoozeMinutes (90), so the
  // fallback-vs-explicit-minutes branch is unambiguous (90 ≠ the platform default 30, ≠ explicit 15).
  db.insertProject({
    id: "p", name: "P", repoPath: "/x", vaultPath: "/x",
    config: { orchestration: { idleDefaultSnoozeMinutes: 90 } }, createdAt: now, archivedAt: null,
  });
  db.insertAgent({ id: "t", projectId: "p", name: "t", startupPrompt: "x", position: 0 });

  // Helper: a fresh MANAGER session pre-seeded with 2 recorded nudges (unanswered=2) so we can prove
  // every state path clears the counter back to 0 (not merely leaves an already-0 count).
  let n = 0;
  const freshManager = () => {
    const id = `mgr${++n}`;
    db.insertSession({
      id, projectId: "p", agentId: "t", engineSessionId: null, title: null, cwd: "/x",
      processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
      lastError: null, role: "manager",
    });
    db.recordIdleNudge(id, now); db.recordIdleNudge(id, now);
    if (db.getIdleNudgeState(id).unanswered !== 2) throw new Error("seed precondition failed");
    return id;
  };

  // working → policy 'watching', snooze cleared, unanswered 0.
  {
    const id = freshManager();
    const r = svc.recordIdleReport(id, "working");
    const s = db.getIdleNudgeState(id);
    check("(S) working → policy 'watching'", s.policy === "watching");
    check("(S) working → snoozeUntil null", s.snoozeUntil === null);
    check("(S) working → unanswered 0", s.unanswered === 0);
    check("(S) working → return mirrors the columns", r.policy === "watching" && r.snoozeUntil === null && r.unanswered === 0);
  }

  // waiting + EXPLICIT minutes → policy 'snoozed', snoozeUntil = now + 15m (NOT the project's 90).
  {
    const id = freshManager();
    const before = Date.now();
    const r = svc.recordIdleReport(id, "waiting", { minutes: 15 });
    const after = Date.now();
    const s = db.getIdleNudgeState(id);
    check("(S) waiting(15) → policy 'snoozed'", s.policy === "snoozed");
    check("(S) waiting(15) → unanswered 0", s.unanswered === 0);
    const ms = new Date(s.snoozeUntil).getTime();
    check("(S) waiting(15) → snoozeUntil ≈ now + 15m (explicit wins over project default)",
      ms >= before + 15 * 60_000 && ms <= after + 15 * 60_000);
    check("(S) waiting(15) → return snoozeUntil matches the column", r.snoozeUntil === s.snoozeUntil);
  }

  // waiting WITHOUT minutes → falls back to the project's idleDefaultSnoozeMinutes (90), not 15/30.
  {
    const id = freshManager();
    const before = Date.now();
    svc.recordIdleReport(id, "waiting");
    const after = Date.now();
    const s = db.getIdleNudgeState(id);
    const ms = new Date(s.snoozeUntil).getTime();
    check("(S) waiting() → policy 'snoozed'", s.policy === "snoozed");
    check("(S) waiting() → snoozeUntil ≈ now + 90m (idleDefaultSnoozeMinutes fallback)",
      ms >= before + 90 * 60_000 && ms <= after + 90 * 60_000);
    check("(S) waiting() → unanswered 0", s.unanswered === 0);
  }

  // blocked_human → policy 'suppressed', snooze cleared, unanswered 0 (no human alert built — Task 4).
  {
    const id = freshManager();
    svc.recordIdleReport(id, "blocked_human", { detail: "need a decision on the API shape" });
    const s = db.getIdleNudgeState(id);
    check("(S) blocked_human → policy 'suppressed'", s.policy === "suppressed");
    check("(S) blocked_human → snoozeUntil null", s.snoozeUntil === null);
    check("(S) blocked_human → unanswered 0", s.unanswered === 0);
  }

  // done → policy 'suppressed', snooze cleared, unanswered 0.
  {
    const id = freshManager();
    svc.recordIdleReport(id, "done");
    const s = db.getIdleNudgeState(id);
    check("(S) done → policy 'suppressed'", s.policy === "suppressed");
    check("(S) done → snoozeUntil null", s.snoozeUntil === null);
    check("(S) done → unanswered 0", s.unanswered === 0);
  }

  // The detail/state is audited to the orchestration timeline (so Task 4 can surface the 'why').
  {
    const id = freshManager();
    svc.recordIdleReport(id, "blocked_human", { detail: "waiting on prod creds" });
    const evt = db.listEvents(id).find((e) => e.kind === "idle_report");
    check("(S) recordIdleReport appends an 'idle_report' audit event with state + detail",
      !!evt && evt.detail?.state === "blocked_human" && evt.detail?.detail === "waiting on prod creds" &&
      evt.detail?.policy === "suppressed");
  }

  // Defense: not-a-manager / unknown session are rejected (the service mirrors the manager-only gate).
  {
    db.insertSession({
      id: "wkr", projectId: "p", agentId: "t", engineSessionId: null, title: null, cwd: "/x",
      processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
      lastError: null, role: "worker",
    });
    let threwWorker = false, threwUnknown = false;
    try { svc.recordIdleReport("wkr", "done"); } catch { threwWorker = true; }
    try { svc.recordIdleReport("nope", "done"); } catch { threwUnknown = true; }
    check("(S) recordIdleReport rejects a non-manager session", threwWorker);
    check("(S) recordIdleReport rejects an unknown session", threwUnknown);
  }

  db.close();
  rmDb(file);
}

// ============================ (T) TOOL SURFACE: registration seam ============================
{
  const file = tmpDbFile("surface");
  const db = new Db(file);
  // recordRole-gated registration is what buildServer does; it reads only the role arg at registration
  // time (the db/sessions refs are captured into tool callbacks, never invoked here), so a real Db + a
  // bare sessions stub suffices. _registeredTools is the SDK's tool-name map — the registration seam
  // that tools/list itself is built from, i.e. exactly the surface the depth-1 role gate shapes.
  const router = new OrchestrationMcpRouter(db, {});
  const toolNames = (role) => Object.keys(router.buildServer("sid", role)._registeredTools);

  const managerTools = toolNames("manager");
  const workerTools = toolNames("worker");

  check("(T) idle_report IS registered on the MANAGER surface", managerTools.includes("idle_report"));
  check("(T) idle_report is NOT on the worker surface", !workerTools.includes("idle_report"));
  // Anchor the gate: the worker surface is exactly { my_context, worker_report } (depth-1 tree holds at
  // the surface). my_context is the own-occupancy self-assessment tool available to ANY role (5561afb8
  // added it to both role branches); worker_report is the only worker-coordination tool.
  check("(T) worker surface is exactly { my_context, worker_report }",
    workerTools.slice().sort().join(",") === "my_context,worker_report");
  // Sanity: idle_report sits ALONGSIDE its siblings recycle_me / worker_report-less manager tools.
  check("(T) manager surface also carries its siblings (recycle_me, worker_spawn)",
    managerTools.includes("recycle_me") && managerTools.includes("worker_spawn"));

  db.close();
  rmDb(file);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — recordIdleReport maps each state to the correct P1 policy/snooze (explicit minutes vs idleDefaultSnoozeMinutes fallback) and always zeroes the unanswered counter; idle_report is registered MANAGER-only, never on the worker surface."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
