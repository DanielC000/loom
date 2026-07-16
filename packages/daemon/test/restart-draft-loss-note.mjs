import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Claude-free regression test (card: pasted-text-attachment-survives-restart).
//
// THE BUG (real-engine probes, _probe-paste-resume.mjs / _probe-paste-stranded-resume.mjs): a pasted-text
// attachment that is part of a SUBMITTED, completed turn is fully durable — the engine resolves the
// "[Pasted text #N]" placeholder to full content before persisting, and `claude --resume` reconstructs it
// correctly every time (verified across three real-engine trials). The ONE genuine gap is a paste (or any
// draft) that was typed/pasted into the raw terminal composer but NEVER SUBMITTED (Enter not pressed) at
// the moment of a daemon restart: it lives only in the now-dead pty's in-memory composer, is not part of
// the transcript at all, and is therefore NOT replayed and NOT recoverable — pre-fix, this loss was
// entirely SILENT (no dangling reference even appears; the resumed agent has zero signal anything was
// lost, which is worse than a dangling ref because it can't even ask about it).
//
// THE FIX: PtyHost.isComposerDirty(id) (public read of the existing composerLen>0 signal) is captured per
// session into RestartResumeEntry.hadUnsentDraft at restart-intent time (liveFleetResumeSet), and
// resumeFleetOnBoot appends/sends an explicit DRAFT_LOSS_NOTE disclosure for any session that had one —
// EVEN for a role/branch that would otherwise resume completely silently — so the resumed agent is told
// the draft (commonly a "[Pasted text #N]"-collapsed paste) did not survive, instead of leaving it
// unaccounted for.
//
// Run: 1) build daemon, 2) node test/restart-draft-loss-note.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-rdln-home-${Date.now()}`);
// PART A spawns real PtyHost sessions (host.spawn()), which open a per-session log under
// $LOOM_HOME/logs (see pty/host.ts) — production always has this dir (index.ts's boot-time
// ensureDirs()), but a hermetic test never runs that, so it must create it itself (mirrors
// mcp-ready-gate.mjs / pty-resume-readiness.mjs). Pre-existing gap here: without it, every spawned
// session's fs.createWriteStream targets a missing directory and — since host.ts attaches no 'error'
// listener to that stream — its async ENOENT can crash the process on an unrelated later tick.
fs.mkdirSync(path.join(process.env.LOOM_HOME, "logs"), { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { PtyHost } = await import("../dist/pty/host.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

const BRACKET_PASTE_START = "\x1b[200~";
const BRACKET_PASTE_END = "\x1b[201~";
const BIG_PASTE = Array.from({ length: 200 }, (_, i) => `payload line ${i}`).join("\n");

// ===================== PART A — PtyHost.isComposerDirty (real state, fake pty) =====================
function makeFakePty() {
  return { pid: 1234, write() {}, onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), kill() {}, resize() {} };
}
class TestPtyHost extends PtyHost { createPty() { return makeFakePty(); } }
const events = { onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} };
const host = new TestPtyHost(events);

function freshSession(id) {
  host.spawn({ sessionId: id, cwd: os.tmpdir(), permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {} });
  host.deliverHook(id, { hook_event_name: "SessionStart" });
}

try {
  check("(A) unknown/never-spawned session id → isComposerDirty is false (never throws)",
    host.isComposerDirty(`rdln-unknown-${sfx}`) === false);

  const clean = `rdln-clean-${sfx}`;
  freshSession(clean);
  check("(A) a freshly-spawned, untouched composer is NOT dirty", host.isComposerDirty(clean) === false);
  host.stop(clean, "hard");

  const dirty = `rdln-dirty-${sfx}`;
  freshSession(dirty);
  // Mimics a REAL human paste landing directly in the raw terminal (gateway forwards ONE ws "stdin"
  // message straight to writeStdin) with Enter NEVER pressed — the exact stranded-draft scenario.
  host.writeStdin(dirty, BRACKET_PASTE_START + BIG_PASTE + BRACKET_PASTE_END);
  check("(A) a large UNSUBMITTED bracketed paste leaves the composer dirty", host.isComposerDirty(dirty) === true);
  host.writeStdin(dirty, "\r"); // human presses Enter → box frees
  check("(A) pressing Enter frees the box → isComposerDirty flips back to false", host.isComposerDirty(dirty) === false);
  host.stop(dirty, "hard");
} finally {
  for (const id of [`rdln-clean-${sfx}`, `rdln-dirty-${sfx}`]) { try { host.stop(id, "hard"); } catch { /* ignore */ } }
}

// ===================== PART B — liveFleetResumeSet() captures hadUnsentDraft end-to-end =====================
class PtyStubDirty {
  constructor(dirtyIds) { this.q = new Map(); this.dirtyIds = dirtyIds; }
  isAlive() { return false; }
  enqueueStdin(id, text) { const a = this.q.get(id) ?? []; a.push(text); this.q.set(id, a); return { delivered: false, position: a.length }; }
  getPending(id) { return [...(this.q.get(id) ?? [])]; }
  isComposerDirty(id) { return this.dirtyIds.has(id); } // stands in for a real dirty raw-terminal composer
}

const mkProject = (id) => db.insertProject({ id, name: id, repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
const mkAgent = (id, projId) => db.insertAgent({ id, projectId: projId, name: "t", startupPrompt: "", position: 0 });
function mkSession(o) {
  db.insertSession({
    id: o.id, projectId: o.projId, agentId: o.agentId, engineSessionId: `eng-${o.id}`,
    title: null, cwd: os.tmpdir(), processState: "live", resumability: "unknown",
    busy: false, createdAt: now, lastActivity: now, lastError: null,
    role: o.role ?? null, parentSessionId: o.parentSessionId ?? null,
    taskId: null, worktreePath: null, branch: null,
  });
}

const db = new Db();
const proj = `rdln-proj-${sfx}`, agent = `rdln-ag-${sfx}`;
mkProject(proj); mkAgent(agent, proj);
const idB = { withDraft: `rdln-withdraft-${sfx}`, clean: `rdln-b-clean-${sfx}` };
mkSession({ id: idB.withDraft, projId: proj, agentId: agent, role: "manager" });
mkSession({ id: idB.clean, projId: proj, agentId: agent, role: "manager" });
const ptyB = new PtyStubDirty(new Set([idB.withDraft]));
const sessionsB = new SessionService(db, ptyB, new OrchestrationControl());

try {
  const fleet = sessionsB.liveFleetResumeSet();
  const withDraftEntry = fleet.find((e) => e.sessionId === idB.withDraft);
  const cleanEntry = fleet.find((e) => e.sessionId === idB.clean);
  check("(B) liveFleetResumeSet captures hadUnsentDraft:true for a dirty-composer session",
    withDraftEntry?.hadUnsentDraft === true);
  check("(B) liveFleetResumeSet captures hadUnsentDraft:false for a clean-composer session",
    cleanEntry?.hadUnsentDraft === false);
} finally {
  db.close();
}

// ===================== PART C — resumeFleetOnBoot: the disclosure fires, INCLUDING where a role would =====================
//                        otherwise resume COMPLETELY SILENTLY (the pre-fix silent-loss case)
class PtyStubC {
  constructor() { this.q = new Map(); }
  enqueueStdin(id, text) { const a = this.q.get(id) ?? []; a.push(text); this.q.set(id, a); return { delivered: false, position: a.length }; }
  getPending(id) { return [...(this.q.get(id) ?? [])]; }
  waitForMcpSeen() { return Promise.resolve(true); } // card df5e37e7 — see mcp-ready-gate.mjs for the primitive's own timing
}
const flushC = () => new Promise((r) => setTimeout(r, 0));
const dbC = new Db();
const projC = `rdln-C-proj-${sfx}`, agentC = `rdln-C-ag-${sfx}`;
try {
  dbC.insertProject({ id: projC, name: projC, repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
  dbC.insertAgent({ id: agentC, projectId: projC, name: "t", startupPrompt: "", position: 0 });
  const mk = (id, o = {}) => dbC.insertSession({
    id, projectId: projC, agentId: agentC, engineSessionId: `eng-${id}`,
    title: null, cwd: os.tmpdir(), processState: "live", resumability: "unknown",
    busy: false, createdAt: now, lastActivity: now, lastError: null,
    role: o.role ?? null, parentSessionId: o.parentSessionId ?? null,
    taskId: null, worktreePath: null, branch: null,
  });
  const id = {
    worker: `rdln-C-worker-${sfx}`,
    silentMgr: `rdln-C-silentmgr-${sfx}`,     // 0 workers, empty board → would OTHERWISE resume SILENTLY
    silentMgrClean: `rdln-C-silentmgrclean-${sfx}`, // control: same shape, no draft
    idleReviewer: `rdln-C-idlerev-${sfx}`,    // idle-at-capture auditor → would OTHERWISE resume SILENTLY
    plain: `rdln-C-plain-${sfx}`,             // role null → NEVER gets a nudge otherwise
    requester: `rdln-C-requester-${sfx}`,
  };
  mk(id.worker, { role: "worker", parentSessionId: id.requester });
  mk(id.silentMgr, { role: "manager" });
  mk(id.silentMgrClean, { role: "manager" });
  mk(id.idleReviewer, { role: "auditor" });
  mk(id.plain, { role: null });
  mk(id.requester, { role: "manager" });

  const pty = new PtyStubC();
  const sessions = new SessionService(dbC, pty, new OrchestrationControl());
  const intent = {
    reason: "routine restart", managerSessionId: id.requester, requestedAt: now,
    resume: [
      { sessionId: id.worker, role: "worker", parentSessionId: id.requester, hadUnsentDraft: true },
      { sessionId: id.silentMgr, role: "manager", parentSessionId: null, hadUnsentDraft: true },
      { sessionId: id.silentMgrClean, role: "manager", parentSessionId: null }, // no hadUnsentDraft at all (old-intent-shaped)
      { sessionId: id.idleReviewer, role: "auditor", parentSessionId: null, busy: false, hadUnsentDraft: true },
      { sessionId: id.plain, role: null, parentSessionId: null, hadUnsentDraft: true },
      { sessionId: id.requester, role: "manager", parentSessionId: null, hadUnsentDraft: true },
    ],
  };
  sessions.resumeFleetOnBoot(intent, { resumeOne: () => true });
  await flushC(); // let every deferred manager/worker nudge settle
  const q = (i) => pty.getPending(i);
  const hasNote = (i) => q(i).some((m) => /UNSENT draft/i.test(m) && /\[Pasted text #N\]/.test(m));

  check("(C) a worker WITH a stranded draft gets the note appended to its normal nudge", hasNote(id.worker) && q(id.worker).length === 1);
  check("(C) a bystander manager that would OTHERWISE resume SILENTLY still gets a minimal note-only turn",
    hasNote(id.silentMgr) && q(id.silentMgr).length === 1);
  check("(C) the control bystander manager (NO stranded draft) resumes truly silently — NO enqueued turn (no regression)",
    q(id.silentMgrClean).length === 0);
  check("(C) an idle-at-capture reviewer that would OTHERWISE resume SILENTLY still gets the note",
    hasNote(id.idleReviewer) && q(id.idleReviewer).length === 1);
  check("(C) a plain (role-null) session that NEVER gets a nudge otherwise still gets the note — the pre-fix silent-loss case",
    hasNote(id.plain) && q(id.plain).length === 1);
  check("(C) the deploy requester's own nudge also carries the note when it had a stranded draft",
    hasNote(id.requester) && q(id.requester).length === 1);
} finally {
  dbC.close();
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — PtyHost.isComposerDirty reflects the real raw-terminal composer state, liveFleetResumeSet " +
    "wires it into RestartResumeEntry.hadUnsentDraft, and resumeFleetOnBoot explicitly discloses a stranded/lost " +
    "draft (commonly a collapsed pasted-text attachment) to the resumed agent — even for roles/branches that " +
    "would otherwise resume completely silently, closing the pre-fix silent-loss gap — while a clean-composer " +
    "session's silent resume is completely unaffected (no regression)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
