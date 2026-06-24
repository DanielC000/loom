import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Daemon-restart resume COHERENCE test (PL Auditor finding #11). NO claude, NO live daemon — drives
// SessionService.resumeFleetOnBoot directly against an isolated LOOM_HOME with a claude-free PtyStub.
// Proves the two halves of the fix:
//
//   PART 1 — FILE-READ TRACKING NOTE. The engine's per-session file-read tracking is in-memory state that
//     `claude --resume` does NOT restore (a post-resume Edit reports "File has not been read yet") and the
//     daemon has no API into it, so it cannot be preserved. The card's accepted fallback: every resume
//     nudge NOTEs the reset so the agent re-Reads intentionally. We assert the note is present on EVERY
//     resumed-and-nudged session's message.
//
//   PART 2 — ONE COHERENT TURN (no bare "Continue" no-op preceding the real nudge). The bare "Continue from
//     where you left off." turn is an engine artifact (auto-continue of an interrupted transcript) — it is
//     NOT a Loom string and the daemon never enqueues it. We prove the DAEMON contributes EXACTLY ONE
//     coherent resume turn per session (the [loom:daemon-restarted] nudge), never a separate bare-continue
//     turn, and that single nudge MERGES/absorbs the engine's bare continue (telling the agent to treat any
//     preceding bare "continue" as the same turn).
//
// Run: 1) build daemon, 2) node test/restart-resume-coherence.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-rrc-home-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const now = new Date().toISOString();
const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// Claude-free pty stub: a resumed pty is not-ready, so every enqueueStdin QUEUES and getPending returns
// the FIFO — exactly what resumeFleetOnBoot's nudges land in.
class PtyStub {
  constructor() { this.q = new Map(); }
  enqueueStdin(id, text) { const a = this.q.get(id) ?? []; a.push(text); this.q.set(id, a); return { delivered: false, position: a.length }; }
  getPending(id) { return [...(this.q.get(id) ?? [])]; }
}

const db = new Db();
const pty = new PtyStub();
const sessions = new SessionService(db, pty, new OrchestrationControl());

const mkProject = (id, repo) => db.insertProject({ id, name: id, repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
const mkAgent = (id, projId) => db.insertAgent({ id, projectId: projId, name: "t", startupPrompt: "", position: 0 });
function mkSession(o) {
  db.insertSession({
    id: o.id, projectId: o.projId, agentId: o.agentId, engineSessionId: `eng-${o.id}`,
    title: null, cwd: o.cwd ?? os.tmpdir(), processState: "live", resumability: "unknown",
    busy: false, createdAt: now, lastActivity: now, lastError: null,
    role: o.role ?? null, parentSessionId: o.parentSessionId ?? null,
    taskId: null, worktreePath: null, branch: null,
  });
}

try {
  // Project P: a requester manager, a worker under it, a standing reviewer (auditor), a TRULY-converged
  // bystander manager (empty board + snoozed idle-policy → the lightweight FYI branch), and a plain session.
  const P = { proj: `rrc-P-${sfx}`, agent: `rrc-P-ag-${sfx}` };
  mkProject(P.proj, "/tmp/rrc-P"); mkAgent(P.agent, P.proj);
  const id = {
    reqMgr: `rrc-reqMgr-${sfx}`, worker: `rrc-wkr-${sfx}`, auditor: `rrc-aud-${sfx}`,
    convMgr: `rrc-conv-${sfx}`, plain: `rrc-plain-${sfx}`,
  };
  mkSession({ id: id.reqMgr, projId: P.proj, agentId: P.agent, role: "manager" });
  mkSession({ id: id.worker, projId: P.proj, agentId: P.agent, role: "worker", parentSessionId: id.reqMgr });
  mkSession({ id: id.auditor, projId: P.proj, agentId: P.agent, role: "auditor" });
  mkSession({ id: id.convMgr, projId: P.proj, agentId: P.agent, role: "manager" });
  db.setIdleNudgePolicy(id.convMgr, "snoozed", future); // 0 workers + empty board ⇒ converged FYI branch
  mkSession({ id: id.plain, projId: P.proj, agentId: P.agent, role: null });

  const intent = {
    reason: "deploy merged daemon code", managerSessionId: id.reqMgr, requestedAt: now,
    resume: [
      { sessionId: id.reqMgr, role: "manager", parentSessionId: null },
      { sessionId: id.worker, role: "worker", parentSessionId: id.reqMgr },
      { sessionId: id.auditor, role: "auditor", parentSessionId: null },
      { sessionId: id.convMgr, role: "manager", parentSessionId: null },
      { sessionId: id.plain, role: null, parentSessionId: null },
    ],
  };
  const result = sessions.resumeFleetOnBoot(intent, { resumeOne: () => true });
  check("(0) all 5 sessions resumed, none failed", result.resumed.length === 5 && result.failed.length === 0);

  // The four NUDGED roles (requester, worker, reviewer, converged manager). The plain session is resumed
  // but never nudged (no orchestration loop) — verified separately below.
  const nudged = [
    { who: "requester manager", id: id.reqMgr, extra: /now LIVE/ },
    { who: "worker", id: id.worker, extra: /Continue your assigned task/ },
    { who: "auditor (reviewer)", id: id.auditor, extra: /continue your work/i },
    { who: "converged manager FYI", id: id.convMgr, extra: /no action is needed/i },
  ];

  for (const n of nudged) {
    const q = pty.getPending(n.id);
    // PART 2 — the daemon contributes EXACTLY ONE turn (never a bare-continue no-op + then the real one).
    check(`(2) ${n.who}: daemon enqueues exactly ONE resume turn`, q.length === 1);
    const msg = q[0] ?? "";
    // The one turn is the coherent [loom:daemon-restarted] nudge with the role-specific body intact.
    check(`(2) ${n.who}: the single turn is the [loom:daemon-restarted] nudge (role body intact)`,
      msg.includes("[loom:daemon-restarted]") && n.extra.test(msg));
    // The daemon NEVER enqueues a standalone bare "Continue from where you left off." turn — any mention
    // is INSIDE the merged nudge (absorption clause), never on its own.
    check(`(2) ${n.who}: no standalone bare-continue turn was enqueued by the daemon`,
      !q.some((m) => /^\s*continue from where you left off\.?\s*$/i.test(m)));

    // PART 1 — the file-read tracking reset NOTE rides on the single turn.
    check(`(1) ${n.who}: nudge NOTEs the file-read tracking reset (re-Read before Edit)`,
      /file-read tracking/i.test(msg) && /Read a file again before you Edit/i.test(msg));
    // PART 2 (merge) — the single turn ABSORBS the engine's bare continue into itself.
    check(`(2) ${n.who}: nudge MERGES the bare 'Continue from where you left off.' into one resume turn`,
      /Continue from where you left off\./.test(msg) && /resume context/i.test(msg) && /single turn/i.test(msg));
  }

  // The plain (role-null) session: resumed but gets NO nudge — so it sees NO daemon turn at all (the
  // single-coherent-turn property is vacuously honoured; the daemon never injects a bare continue here).
  check("(2) plain session received NO daemon turn (no nudge, no bare continue)", pty.getPending(id.plain).length === 0);
} finally {
  db.close();
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a daemon_restart resume delivers ONE coherent turn per session: each nudge NOTEs the file-read tracking reset and absorbs the engine's bare 'Continue from where you left off.' artifact; the daemon never enqueues a standalone bare-continue no-op."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
