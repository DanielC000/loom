import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card d1521fca, Code Review round — service-level coverage of SessionService.notifyMcpSilenceParent /
// notifyMcpSilenceLead (sessions/service.ts). NO real claude/pty, NO live daemon — same in-process Db +
// SessionService + hermetic PtyStub technique claude-boot-dialog-stuck-no-self-nudge.mjs already uses
// for notifyLeadOfStuckManager, which notifyMcpSilenceLead deliberately mirrors.
//
// Covers:
//   (1) notifyMcpSilenceParent: a durable nudge reaches a LIVE parent; returns {notifiedParent:true}.
//   (2) notifyMcpSilenceLead, NO platform-tier home exists at all: no-op — {leadNotified:false}, no
//       leadBoardTaskId, zero tasks filed, zero enqueueStdin calls anywhere.
//   (3) notifyMcpSilenceLead, home exists but NO live Lead: a durable board task IS filed (so an
//       offline Lead sees it later), leadNotified:false, zero enqueueStdin calls.
//   (4) notifyMcpSilenceLead, a LIVE + past-boot Lead: the task is filed AND the Lead gets exactly one
//       enqueueStdin call; leadNotified:true.
//   (5) Task reuse: a SECOND call for the SAME silent session, where a PRIOR mcp_silence_detected event
//       already carries a leadBoardTaskId for a still-OPEN task, reuses that task — never files a
//       second one. (This models what a real shape-change re-notify from IdleWatcher looks like: the
//       event-appending itself is IdleWatcher's job, not this method's — see idle-watcher.ts's own
//       evaluateMcpSilence — so this test hand-seeds the prior event exactly the way IdleWatcher's own
//       db.appendEvent call already does.)
//   (6) Self-Lead skip: when the SILENT session IS the live Lead itself, the self-nudge is skipped
//       (zero enqueueStdin calls to it) but the board task still files normally.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-notify-mcp-silence-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// Minimal hermetic PtyStub — mirrors claude-boot-dialog-stuck-no-self-nudge.mjs's own.
class PtyStub {
  constructor() {
    this.live = new Set();
    this.pastBoot = new Set();
    this.enqueueCalls = []; // { id, text }
  }
  setLive(id, on = true) { if (on) this.live.add(id); else this.live.delete(id); }
  setPastBoot(id, on = true) { if (on) this.pastBoot.add(id); else this.pastBoot.delete(id); }
  isLiveAndPreBoot(id) { return this.live.has(id) && !this.pastBoot.has(id); }
  enqueueStdin(id, text) {
    this.enqueueCalls.push({ id, text });
    if (!this.live.has(id)) return { delivered: false, deliveryState: "dropped" };
    return { delivered: false, queued: true, deliveryState: "queued" };
  }
}

const db = new Db();
const proj = `nms-proj-${sfx}`, agent = `nms-ag-${sfx}`;
db.insertProject({ id: proj, name: proj, repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agent, projectId: proj, name: "t", startupPrompt: "", position: 0 });
const mkSession = (o) => db.insertSession({
  id: o.id, projectId: proj, agentId: agent, engineSessionId: `eng-${o.id}`, title: null, cwd: os.tmpdir(),
  processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: o.role ?? null, parentSessionId: o.parentSessionId ?? null, taskId: o.taskId ?? null,
  worktreePath: null, branch: null,
});

try {
  // ============================ (1) notifyMcpSilenceParent reaches a LIVE parent ============================
  {
    delete process.env.LOOM_DEV;
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `nms-1-mgr-${sfx}`, wkr = `nms-1-wkr-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: wkr, role: "worker", parentSessionId: mgr, taskId: "tk-1" });
    pty.setLive(mgr);

    const result = sessions.notifyMcpSilenceParent(mgr, `[loom:mcp-silence] worker ${wkr}: test`, "tk-1");
    check("(1) returns notifiedParent:true for a live parent", result.notifiedParent === true);
    const toParent = pty.enqueueCalls.filter((c) => c.id === mgr);
    check("(1) exactly ONE enqueueStdin call reaches the parent", toParent.length === 1);
    check("(1) the nudge names the silent worker", toParent[0]?.text.includes(wkr));
  }

  // ============================ (2) notifyMcpSilenceLead: NO platform-tier home at all ============================
  {
    delete process.env.LOOM_DEV;
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `nms-2-mgr-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    pty.setLive(mgr);

    const tasksBefore = db.listTasks(mgr).length; // scoped to a project id that doesn't even exist as a home — always 0
    const result = sessions.notifyMcpSilenceLead(mgr, `[loom:mcp-silence] session ${mgr}: test`);
    check("(2) returns leadNotified:false when no platform-tier home resolves", result.leadNotified === false);
    check("(2) returns no leadBoardTaskId — nothing was filed", result.leadBoardTaskId === undefined);
    check("(2) zero enqueueStdin calls anywhere", pty.enqueueCalls.length === 0);
  }

  // The dev "Loom Platform" reserved home — inserted here (after (2), which deliberately has none).
  const home = `nms-platform-home-${sfx}`;
  db.insertProject({ id: home, name: "Loom Platform", repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null, reserved: true });

  // ============================ (3) home exists, NO live Lead: durable task filed, leadNotified:false ============================
  let taskFromScenario3;
  {
    process.env.LOOM_DEV = "1";
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `nms-3-mgr-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    pty.setLive(mgr);

    const result = sessions.notifyMcpSilenceLead(mgr, `[loom:mcp-silence] session ${mgr}: test`);
    check("(3) returns leadNotified:false — no Lead is live", result.leadNotified === false);
    check("(3) returns a real leadBoardTaskId — a durable task WAS filed", typeof result.leadBoardTaskId === "string");
    const task = db.getTask(result.leadBoardTaskId);
    check("(3) the filed task lives on the reserved Platform home project", task?.projectId === home);
    check("(3) the filed task names the silent session", !!task && task.body.includes(mgr));
    check("(3) zero enqueueStdin calls anywhere — no Lead is live to receive one", pty.enqueueCalls.length === 0);
    taskFromScenario3 = { mgr, taskId: result.leadBoardTaskId };
  }

  // ============================ (4) a LIVE + past-boot Lead: task filed AND exactly one nudge to the Lead ============================
  {
    process.env.LOOM_DEV = "1";
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `nms-4-mgr-${sfx}`, lead = `nms-4-lead-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: lead, role: "platform" });
    pty.setLive(mgr); pty.setLive(lead); pty.setPastBoot(lead);

    const result = sessions.notifyMcpSilenceLead(mgr, `[loom:mcp-silence] session ${mgr}: test`);
    check("(4) returns leadNotified:true — a live, past-boot Lead was nudged", result.leadNotified === true);
    check("(4) returns a real leadBoardTaskId", typeof result.leadBoardTaskId === "string");
    const toLead = pty.enqueueCalls.filter((c) => c.id === lead);
    check("(4) exactly ONE enqueueStdin call reaches the Lead", toLead.length === 1);
    check("(4) the Lead's nudge names the silent session and the filed task id",
      toLead[0]?.text.includes(mgr) && toLead[0]?.text.includes(result.leadBoardTaskId));
    check("(4) the silent manager itself gets ZERO enqueueStdin calls", pty.enqueueCalls.filter((c) => c.id === mgr).length === 0);
    db.setProcessState(lead, "exited"); // hygiene — a later scenario's listAllSessions().find(live Lead) must not pick this up
  }

  // ============================ (5) task reuse: a prior mcp_silence_detected event's OPEN task is reused ============================
  {
    process.env.LOOM_DEV = "1";
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = taskFromScenario3.mgr; // reuse (3)'s own silent session + its already-filed task
    const priorTaskId = taskFromScenario3.taskId;
    pty.setLive(mgr);

    // Hand-seed the durable event IdleWatcher itself would have appended after (3)'s own call — this
    // method never appends the event itself (evaluateMcpSilence, orchestration/idle-watcher.ts, does).
    db.appendEvent({
      id: randomUUID(), ts: now, managerSessionId: mgr, taskId: null,
      kind: "mcp_silence_detected",
      detail: { shape: "all-silent", staleRouters: ["task", "orchestration"], freshRouters: [], staleForMs: 1_000_000, leadNotified: false, leadBoardTaskId: priorTaskId },
    });

    const tasksBefore = db.listTasks(home).length;
    const result = sessions.notifyMcpSilenceLead(mgr, `[loom:mcp-silence] session ${mgr}: shape worsened`);
    check("(5) reuses the SAME prior task id — never files a second one", result.leadBoardTaskId === priorTaskId);
    check("(5) no new task was filed on the Platform home", db.listTasks(home).length === tasksBefore);
  }

  // ============================ (5b) reuse does NOT apply once the prior task is already terminal/resolved ============================
  {
    process.env.LOOM_DEV = "1";
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `nms-5b-mgr-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    pty.setLive(mgr);

    const first = sessions.notifyMcpSilenceLead(mgr, `[loom:mcp-silence] session ${mgr}: first`);
    db.appendEvent({
      id: randomUUID(), ts: now, managerSessionId: mgr, taskId: null,
      kind: "mcp_silence_detected",
      detail: { shape: "asymmetric", staleRouters: ["orchestration"], freshRouters: ["task"], staleForMs: 1_000_000, leadNotified: false, leadBoardTaskId: first.leadBoardTaskId },
    });
    db.updateTask(first.leadBoardTaskId, { columnKey: "done" }); // manually resolved/closed by the Lead

    const second = sessions.notifyMcpSilenceLead(mgr, `[loom:mcp-silence] session ${mgr}: recurrence`);
    check("(5b) a TERMINAL prior task is never reused — a fresh one is filed instead",
      typeof second.leadBoardTaskId === "string" && second.leadBoardTaskId !== first.leadBoardTaskId);
  }

  // ============================ (6) self-Lead skip: the silent session IS the live Lead itself ============================
  {
    process.env.LOOM_DEV = "1";
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const lead = `nms-6-lead-${sfx}`;
    mkSession({ id: lead, role: "platform" });
    pty.setLive(lead); pty.setPastBoot(lead);

    const result = sessions.notifyMcpSilenceLead(lead, `[loom:mcp-silence] session ${lead}: test`);
    check("(6) returns leadNotified:false — self-nudge is skipped", result.leadNotified === false);
    check("(6) a board task is STILL filed", typeof result.leadBoardTaskId === "string");
    check("(6) ZERO enqueueStdin calls to the Lead itself — a self-nudge is meaningless", pty.enqueueCalls.filter((c) => c.id === lead).length === 0);
    db.setProcessState(lead, "exited");
  }

  delete process.env.LOOM_DEV;
  db.close();
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — notifyMcpSilenceParent durably nudges a live parent; notifyMcpSilenceLead no-ops with no platform-tier home, files a durable task even with no live Lead, best-effort-nudges a live past-boot Lead, reuses a prior OPEN task (never a terminal one) for the same session, and skips the self-nudge when the silent session is the Lead itself while still filing its board task."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
