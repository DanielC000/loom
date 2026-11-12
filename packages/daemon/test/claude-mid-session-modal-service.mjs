import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1)
// Card 20ff76de — service-level coverage of the MID-SESSION phase of SessionService.handleClaudeBootDialogStuck
// (sessions/service.ts) and its downstream wording. NO real claude/pty, NO live daemon: in-process Db +
// SessionService + a hermetic PtyStub (same technique as claude-boot-dialog-stuck-no-self-nudge.mjs).
//
// Proves:
//   (A) a mid-session event records phase:"mid-session"; the parent nudge says UNCONFIRMED delivery, never
//       "never reached SessionStart"; the held session itself is never written to.
//   (B) the owner ESCALATION files ONE parentNudged:false mid-session event (what the web alert + companion push
//       derive from) and nudges nobody; a second escalation adds nothing (latest event is already owner-visible).
//   (C) a parentless manager's initial event is already owner-visible, so an escalation adds nothing.
//   (D) a mid-session Lead card is NEVER silently reused from an open BOOT-stuck card (phase-keyed reuse), and says so.
//   (E) the companion attention push words a mid-session episode as a held prompt, never a boot failure.
//   (F) deliverRedirect refuses a held target with the manager-readable reason BEFORE enqueueing anything
//       (positive control: an unheld target proceeds past the refusal); system redirects opt out.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-cmms-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_DEV = "1";

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { alertLine } = await import("../dist/companion/attention-push.js");

const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

class PtyStub {
  constructor() { this.live = new Set(); this.pastBoot = new Set(); this.enqueueCalls = []; this.refusal = null; this.flushed = false; }
  setLive(id) { this.live.add(id); }
  setPastBoot(id) { this.pastBoot.add(id); }
  isLiveAndPreBoot(id) { return this.live.has(id) && !this.pastBoot.has(id); }
  enqueueStdin(id, text) {
    this.enqueueCalls.push({ id, text });
    return this.live.has(id) ? { delivered: false, queued: true, deliveryState: "queued" } : { delivered: false, deliveryState: "dropped" };
  }
  modalHoldRefusal(id) { return this.refusal && this.refusal.id === id ? this.refusal.reason : null; }
  flushPending() { this.flushed = true; throw new Error("REACHED-flushPending"); }
}

const db = new Db();
const proj = `cmms-proj-${sfx}`, agent = `cmms-ag-${sfx}`, home = `cmms-home-${sfx}`;
db.insertProject({ id: proj, name: proj, repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agent, projectId: proj, name: "t", startupPrompt: "", position: 0 });
db.insertProject({ id: home, name: "Loom Platform", repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null, reserved: true });
const mkSession = (o) => db.insertSession({
  id: o.id, projectId: proj, agentId: agent, engineSessionId: `eng-${o.id}`, title: null, cwd: os.tmpdir(),
  processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: o.role ?? null, parentSessionId: o.parentSessionId ?? null, taskId: o.taskId ?? null,
  worktreePath: null, branch: null,
});
const stuckEvents = (id) => db.listEventsForWorker(id).filter((e) => e.kind === "claude_boot_dialog_stuck");

try {
  // ===== (A) + (B): worker with a live, past-boot manager =====
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `cmms-a-mgr-${sfx}`, wkr = `cmms-a-wkr-${sfx}`;
    mkSession({ id: mgr, role: "manager" }); mkSession({ id: wkr, role: "worker", parentSessionId: mgr });
    pty.setLive(mgr); pty.setLive(wkr); pty.setPastBoot(mgr);

    sessions.handleClaudeBootDialogStuck(wkr, { timeoutMs: 0, signatureName: "unknown-modal", role: "worker", phase: "mid-session" });
    const ev = stuckEvents(wkr);
    check("(A) one durable event with phase:'mid-session' and parentNudged:true", ev.length === 1 && ev[0].detail.phase === "mid-session" && ev[0].detail.parentNudged === true);
    const nudge = pty.enqueueCalls.filter((c) => c.id === mgr);
    check("(A) the parent gets exactly one nudge naming the held prompt", nudge.length === 1 && /UNCONFIRMED delivery/.test(nudge[0].text) && /unknown-modal/.test(nudge[0].text));
    check("(A) the nudge never says 'never reached SessionStart' and the held session itself is never written to",
      !/never reached SessionStart/.test(nudge[0].text) && pty.enqueueCalls.filter((c) => c.id === wkr).length === 0);

    const callsBefore = pty.enqueueCalls.length;
    sessions.handleClaudeBootDialogStuck(wkr, { timeoutMs: 180_000, signatureName: "unknown-modal", role: "worker", phase: "mid-session", escalation: true });
    const ev2 = stuckEvents(wkr);
    check("(B) escalation files ONE more event: parentNudged:false (owner-visible), phase mid-session, escalated:true",
      ev2.length === 2 && ev2[1].detail.parentNudged === false && ev2[1].detail.phase === "mid-session" && ev2[1].detail.escalated === true);
    check("(B) escalation nudges nobody", pty.enqueueCalls.length === callsBefore);
    sessions.handleClaudeBootDialogStuck(wkr, { timeoutMs: 360_000, signatureName: "unknown-modal", role: "worker", phase: "mid-session", escalation: true });
    check("(B) a second escalation adds nothing (the latest event is already owner-visible)", stuckEvents(wkr).length === 2);
    // a resolved episode then a NEW escalation files again (new episode)
    sessions.handleClaudeBootDialogResolved(wkr);
    sessions.handleClaudeBootDialogStuck(wkr, { timeoutMs: 180_000, signatureName: "unknown-modal", role: "worker", phase: "mid-session", escalation: true });
    check("(B) after a resolved pairing, an escalation files again (per-episode, not once ever)", stuckEvents(wkr).length === 3);
  }

  // ===== (C) parentless manager: the initial event is already owner-visible =====
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `cmms-c-mgr-${sfx}`;
    mkSession({ id: mgr, role: "manager" }); pty.setLive(mgr); pty.setPastBoot(mgr);
    sessions.handleClaudeBootDialogStuck(mgr, { timeoutMs: 0, signatureName: "unknown-modal", role: "manager", phase: "mid-session" });
    check("(C) a parentless manager's initial mid-session event is owner-visible (parentNudged:false)", stuckEvents(mgr).length === 1 && stuckEvents(mgr)[0].detail.parentNudged === false && stuckEvents(mgr)[0].detail.phase === "mid-session");
    sessions.handleClaudeBootDialogStuck(mgr, { timeoutMs: 180_000, signatureName: "unknown-modal", role: "manager", phase: "mid-session", escalation: true });
    check("(C) its escalation adds nothing (would double the owner alert)", stuckEvents(mgr).length === 1);
  }

  // ===== (D) Lead card: phase-keyed reuse, mid-session wording =====
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `cmms-d-mgr-${sfx}`;
    mkSession({ id: mgr, role: "manager" }); pty.setLive(mgr); pty.setPastBoot(mgr);
    sessions.handleClaudeBootDialogStuck(mgr, { timeoutMs: 150_000, signatureName: "workspace-trust", role: "manager" }); // BOOT episode first
    const bootTask = stuckEvents(mgr)[0]?.detail?.leadBoardTaskId;
    sessions.handleClaudeBootDialogStuck(mgr, { timeoutMs: 0, signatureName: "unknown-modal", role: "manager", phase: "mid-session" });
    const midTask = stuckEvents(mgr)[1]?.detail?.leadBoardTaskId;
    check("(D) both episodes filed a Lead board card", typeof bootTask === "string" && typeof midTask === "string");
    check("(D) the mid-session episode did NOT silently reuse the open BOOT card", bootTask !== midTask);
    const t = db.getTask(midTask);
    check("(D) the mid-session card is titled/worded as a held prompt, never a boot failure",
      /held on prompt/i.test(t?.title ?? "") && !/boot stuck/i.test(t?.title ?? "") && /HELD on an unrecognized on-screen prompt/.test(t?.body ?? "") && !/Timeout:/.test(t?.body ?? "") && !/never reached SessionStart/.test(t?.body ?? ""));
    sessions.handleClaudeBootDialogStuck(mgr, { timeoutMs: 0, signatureName: "unknown-modal", role: "manager", phase: "mid-session" });
    check("(D) a SECOND mid-session episode reuses the open mid-session card (reuse still works within a phase)", stuckEvents(mgr)[2]?.detail?.leadBoardTaskId === midTask);
  }

  // ===== (E) companion attention push wording =====
  {
    const base = { id: "e1", ts: now, managerSessionId: "m1", workerSessionId: "w1", taskId: null, kind: "claude_boot_dialog_stuck" };
    const mid = alertLine({ ...base, detail: { phase: "mid-session", signatureName: "unknown-modal", role: "manager", parentNudged: false } }, "escalation", "ProjX");
    const boot = alertLine({ ...base, detail: { signatureName: "workspace-trust", role: "worker", parentNudged: false } }, "escalation", "ProjX");
    check("(E) mid-session push: 'held on an unrecognized on-screen prompt', no boot wording", /held on an unrecognized on-screen prompt/.test(mid) && !/never reached SessionStart/.test(mid));
    check("(E) negative control: a BOOT episode still reads 'never reached SessionStart'", /never reached SessionStart/.test(boot));
  }

  // ===== (F) deliverRedirect refusal =====
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const tgt = `cmms-f-wkr-${sfx}`;
    mkSession({ id: tgt, role: "worker" });
    const target = db.getSession(tgt);
    const opts = { frame: (t) => t, enqueueSender: "system", eventManagerId: "m" };
    pty.refusal = { id: tgt, reason: "session is held on an unrecognized on-screen prompt; resolve the prompt in the terminal, then press Resume deliveries" };
    let msg = null;
    try { sessions.deliverRedirect(target, "do X", opts); } catch (e) { msg = e.message; }
    check("(F) a held target refuses with the manager-readable reason before any enqueue/flush", msg === pty.refusal.reason && pty.flushed === false);
    msg = null;
    try { sessions.deliverRedirect(target, "do X", { ...opts, refuseWhenModalHeld: false }); } catch (e) { msg = e.message; }
    check("(F) positive control: with the refusal opted out (system redirect) the call proceeds PAST it", msg === "REACHED-flushPending" && pty.flushed === true);
    pty.flushed = false; pty.refusal = null;
    msg = null;
    try { sessions.deliverRedirect(target, "do X", opts); } catch (e) { msg = e.message; }
    check("(F) positive control: an UNHELD target also proceeds past the refusal check", msg === "REACHED-flushPending" && pty.flushed === true);
  }

  // ===== (G) card f951417c: a modal-blocked boot mode-cycle's mismatch is a DURABLE, owner-visible event =====
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `cmms-g-mgr-${sfx}`, wkr = `cmms-g-wkr-${sfx}`;
    mkSession({ id: mgr, role: "manager" }); mkSession({ id: wkr, role: "worker", parentSessionId: mgr });
    pty.setLive(mgr); pty.setLive(wkr); pty.setPastBoot(mgr);
    sessions.handleClaudeBootDialogStuck(wkr, { timeoutMs: 0, signatureName: "unknown-modal", role: "worker", phase: "mid-session", modeMismatch: { target: "default", landed: "acceptEdits" } });
    const ev = stuckEvents(wkr);
    check("(G) one durable event naming target + landed mode, owner-visible (parentNudged:false), phase mid-session",
      ev.length === 1 && ev[0].detail.modeMismatch?.target === "default" && ev[0].detail.modeMismatch?.landed === "acceptEdits" && ev[0].detail.parentNudged === false && ev[0].detail.phase === "mid-session");
    check("(G) nobody is written to (the stuck session itself never; the parent is not nudged either)", pty.enqueueCalls.length === 0);
  }
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0 ? "\n✅ ALL PASS — mid-session modal service wiring (card 20ff76de)" : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
