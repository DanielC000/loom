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
//     turn. Card 5d8dea5f REMOVED the old bare-"Continue" disclaimer paragraph: the single nudge IS the
//     authoritative resume context, so it no longer carries a sentence reconciling the engine artifact — we
//     assert that disclaimer is GONE from every resume turn.
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
// waitForMcpSeen resolves TRUE immediately — card df5e37e7's manager/worker nudge defer is exercised for
// its OWN timing in mcp-ready-gate.mjs; this file only needs the eventual coherence/wording semantics.
class PtyStub {
  constructor() { this.q = new Map(); }
  enqueueStdin(id, text) { const a = this.q.get(id) ?? []; a.push(text); this.q.set(id, a); return { delivered: false, position: a.length }; }
  getPending(id) { return [...(this.q.get(id) ?? [])]; }
  waitForMcpSeen() { return Promise.resolve(true); }
}
// Card df5e37e7: flush the deferred-nudge microtask chain after resumeFleetOnBoot before reading getPending.
const flush = () => new Promise((r) => setTimeout(r, 0));

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
  // Project P: a requester manager, a worker under it, a BUSY-at-capture standing reviewer (auditor — busy
  // so it still gets the continuation nudge, per card b5664b5b Problem B), a TRULY-converged no-op bystander
  // manager (empty board + snoozed idle-policy → now the SILENT no-op branch, card b5664b5b A+C1), and a
  // plain session.
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
  db.setIdleNudgePolicy(id.convMgr, "snoozed", future); // 0 workers + empty board ⇒ silent no-op branch
  mkSession({ id: id.plain, projId: P.proj, agentId: P.agent, role: null });

  const intent = {
    reason: "deploy merged daemon code", managerSessionId: id.reqMgr, requestedAt: now,
    resume: [
      { sessionId: id.reqMgr, role: "manager", parentSessionId: null },
      { sessionId: id.worker, role: "worker", parentSessionId: id.reqMgr },
      { sessionId: id.auditor, role: "auditor", parentSessionId: null, busy: true }, // mid-run ⇒ nudged
      { sessionId: id.convMgr, role: "manager", parentSessionId: null },
      { sessionId: id.plain, role: null, parentSessionId: null },
    ],
  };
  const result = sessions.resumeFleetOnBoot(intent, { resumeOne: () => true });
  await flush(); // let every deferred manager/worker nudge settle
  check("(0) all 5 sessions resumed, none failed", result.resumed.length === 5 && result.failed.length === 0);

  // The three NUDGED roles (requester, worker, busy-at-capture reviewer). The converged no-op manager and
  // the plain session are resumed SILENTLY (no orchestration loop / no-op restart) — verified separately.
  const nudged = [
    { who: "requester manager", id: id.reqMgr, extra: /now LIVE/ },
    { who: "worker", id: id.worker, extra: /Continue your assigned task/ },
    { who: "busy auditor (reviewer)", id: id.auditor, extra: /continue your work/i },
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
    // PART 2 (card 5d8dea5f) — the bare-"Continue" disclaimer paragraph is GONE; the single turn no longer
    // mentions the engine artifact at all (no "Continue from where you left off." / "single turn" sentence).
    check(`(2) ${n.who}: the resume turn has NO bare-continue disclaimer (card 5d8dea5f removed it)`,
      !/Continue from where you left off/.test(msg) && !/treat them as a single turn/.test(msg));
  }

  // The plain (role-null) session: resumed but gets NO nudge — so it sees NO daemon turn at all (the
  // single-coherent-turn property is vacuously honoured; the daemon never injects a bare continue here).
  check("(2) plain session received NO daemon turn (no nudge, no bare continue)", pty.getPending(id.plain).length === 0);
  // The truly-converged no-op bystander manager now resumes SILENTLY (card b5664b5b A+C1) — the old
  // "no action needed" FYI was itself a wasted turn, so it gets ZERO daemon turns.
  check("(2) converged no-op manager received NO daemon turn (silent resume, card b5664b5b)", pty.getPending(id.convMgr).length === 0);
} finally {
  db.close();
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a daemon_restart resume delivers ONE coherent turn per session: each nudge NOTEs the file-read tracking reset and carries NO bare-'Continue' disclaimer (card 5d8dea5f); the daemon never enqueues a standalone bare-continue no-op."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
