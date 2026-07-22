import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Asleep-at-the-Wheel idle-manager watchdog — Task 2 (the `idle_report` manager-surface tool + the
// SessionService.recordIdleReport it calls). Extended by card 98b3725c to also cover platform (Lead)
// sessions — the SAME idle-watchdog coverage a manager gets. HERMETIC like idle-watch-foundation.mjs /
// profiles.mjs: isolated temp DB, imports dist/* + @loom/shared, NO daemon, NO real claude, NO pty. Covers:
//   (S) SERVICE recordIdleReport — each of the 3 states writes the correct P1 idle_nudge_* policy +
//       snooze columns and leaves the unanswered counter at 0:
//         working → policy 'watching'  (reset)
//         waiting → policy 'snoozed', snoozeUntil = now + (explicit minutes) — and, separately,
//                   the per-project idleDefaultSnoozeMinutes FALLBACK when minutes is omitted
//         done    → policy 'suppressed'
//       (The retired `blocked_human` disposition — card fb888d49 — is gone; an agent that needs a
//       human now files a Request via `question_ask` instead.)
//       In ALL cases unanswered ends 0 (pre-seeded with recorded nudges first, to prove it's cleared).
//       Proven for BOTH 'manager' and 'platform' roles — the role gate now accepts both.
//   (T) TOOL SURFACE — `idle_report` is registered on the MANAGER tool surface and NOT on the worker
//       surface (asserted at the McpServer tool-registration seam, where the role gate is applied).
//   (P) PLATFORM ROUTER — `idle_report` is ALSO registered on the Lead's PlatformMcpRouter (mcp/platform.ts)
//       — the critical wiring gap this card closes: a platform session never reaches /mcp/:sessionId at
//       all (resolveRole there gates manager/worker/assistant only), so without this registration a Lead
//       would have no way to ever call idle_report. Driven end-to-end over a real MCP InMemoryTransport,
//       mirroring platform-mgmt-surface.mjs's pattern.
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
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

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
    svc.recordIdleReport(id, "done", { detail: "queue is drained" });
    const evt = db.listEvents(id).find((e) => e.kind === "idle_report");
    check("(S) recordIdleReport appends an 'idle_report' audit event with state + detail",
      !!evt && evt.detail?.state === "done" && evt.detail?.detail === "queue is drained" &&
      evt.detail?.policy === "suppressed");
  }

  // Defense: not-a-manager/platform / unknown session are rejected (the service's role gate).
  {
    db.insertSession({
      id: "wkr", projectId: "p", agentId: "t", engineSessionId: null, title: null, cwd: "/x",
      processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
      lastError: null, role: "worker",
    });
    let threwWorker = false, threwUnknown = false;
    try { svc.recordIdleReport("wkr", "done"); } catch { threwWorker = true; }
    try { svc.recordIdleReport("nope", "done"); } catch { threwUnknown = true; }
    check("(S) recordIdleReport rejects a non-manager/platform session", threwWorker);
    check("(S) recordIdleReport rejects an unknown session", threwUnknown);
  }

  // Card 98b3725c: a PLATFORM session is now ALSO accepted — same 3-state mapping as a manager, proven
  // with a fresh helper mirroring freshManager but role:"platform".
  {
    let p = 0;
    const freshPlatform = () => {
      const id = `plat${++p}`;
      db.insertSession({
        id, projectId: "p", agentId: "t", engineSessionId: null, title: null, cwd: "/x",
        processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
        lastError: null, role: "platform",
      });
      db.recordIdleNudge(id, now); db.recordIdleNudge(id, now);
      return id;
    };

    const idW = freshPlatform();
    const rW = svc.recordIdleReport(idW, "working");
    check("(S-plat) working → policy 'watching', unanswered 0", rW.policy === "watching" && rW.unanswered === 0);

    const idWait = freshPlatform();
    const before = Date.now();
    const rWait = svc.recordIdleReport(idWait, "waiting", { minutes: 15 });
    const after = Date.now();
    const msWait = new Date(rWait.snoozeUntil).getTime();
    check("(S-plat) waiting(15) → policy 'snoozed', snoozeUntil ≈ now + 15m",
      rWait.policy === "snoozed" && msWait >= before + 15 * 60_000 && msWait <= after + 15 * 60_000);

    const idDone = freshPlatform();
    const rDone = svc.recordIdleReport(idDone, "done");
    check("(S-plat) done → policy 'suppressed', unanswered 0", rDone.policy === "suppressed" && rDone.unanswered === 0);
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
  // Anchor the gate: the worker surface is exactly { gate_status, my_context, run_gate, worker_report }
  // (depth-1 tree holds at the surface). my_context is the own-occupancy self-assessment tool available to
  // ANY role (5561afb8 added it to both role branches); worker_report is the worker-coordination tool;
  // run_gate (card 7f96aa09) is the daemon-mediated DoD self-gate; gate_status (card fc243a43) is the
  // read-only, own-op-scoped complement to run_gate — both added since this anchor was first written.
  check("(T) worker surface is exactly { gate_status, my_context, run_gate, worker_report }",
    workerTools.slice().sort().join(",") === "gate_status,my_context,run_gate,worker_report");
  // Sanity: idle_report sits ALONGSIDE its siblings recycle_me / worker_report-less manager tools.
  check("(T) manager surface also carries its siblings (recycle_me, worker_spawn)",
    managerTools.includes("recycle_me") && managerTools.includes("worker_spawn"));

  db.close();
  rmDb(file);
}

// ==================== (P) PLATFORM ROUTER — idle_report reachable + working end-to-end ====================
// Card 98b3725c's critical wiring fix: a platform session never reaches /mcp/:sessionId (OrchestrationMcpRouter's
// resolveRole gates manager/worker/assistant only) — so idle_report must be registered on the SEPARATE
// PlatformMcpRouter (mcp/platform.ts) too, not just have its role-check loosened. Proven end-to-end over a
// real MCP InMemoryTransport (mirrors platform-mgmt-surface.mjs's pattern), driving the SAME recordIdleReport.
{
  const file = tmpDbFile("platform");
  const db = new Db(file);
  const now = new Date().toISOString();
  db.insertProject({ id: "pp", name: "PP", repoPath: "/x", vaultPath: "/x", config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "pt", projectId: "pp", name: "t", startupPrompt: "x", position: 0 });
  db.insertSession({
    id: "PL", projectId: "pp", agentId: "pt", engineSessionId: null, title: null, cwd: "/x",
    processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "platform",
  });
  db.recordIdleNudge("PL", now); db.recordIdleNudge("PL", now); // pre-seed unanswered=2, proves it's cleared

  const svc = new SessionService(db, /* pty */ {}, new OrchestrationControl());
  const router = new PlatformMcpRouter(db, svc);
  const server = router.buildServer("PL"); // callerSessionId — mirrors end_me/recycle_me's self-scoping

  check("(P) idle_report IS registered on the PlatformMcpRouter surface",
    Object.keys(server._registeredTools).includes("idle_report"));

  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "idle-report-platform-test", version: "0" });
  await client.connect(clientT);
  const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

  const r = await call("idle_report", { state: "done", detail: "platform board is drained" });
  check("(P) idle_report('done') via the platform router succeeds (no error), mirrors the manager tool's shape",
    r.recorded === true && r.policy === "suppressed" && r.unanswered === 0);
  const s = db.getIdleNudgeState("PL");
  check("(P) it actually persisted to the caller's OWN session row (self-scoped by callerSessionId, no id to spoof)",
    s.policy === "suppressed" && s.unanswered === 0);

  db.close();
  rmDb(file);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — recordIdleReport maps each state to the correct P1 policy/snooze (explicit minutes vs idleDefaultSnoozeMinutes fallback) and always zeroes the unanswered counter, for BOTH manager and platform roles; idle_report is registered on the manager surface (not the worker surface) AND on the Lead's PlatformMcpRouter, and works end-to-end there."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
