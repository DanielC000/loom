import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1)
// Card 01160ae3, Code Review round 2 — service-level coverage of `SessionService.handleClaudeBootDialogStuck`
// (sessions/service.ts). NO real claude/pty, NO live daemon — same in-process Db + SessionService +
// hermetic PtyStub technique as worker-message-codex-boot-stuck-advisory.mjs.
//
// THE DEFECT THIS CLOSES (MAJOR, blocking at Code Review 2c44891b): the pre-fix handler also enqueued a
// nudge to the STUCK session itself. That text would be DRAINED and TYPED into the pty by the ordinary
// delivery pipeline — and `claude`'s drain gate (`live.ready`) is already forced true by READY_FALLBACK
// well before this detector's own (much longer) timeout fires, with `busy` independently clearable by
// give-up recovery / heal-if-stuck. So the self-nudge's trailing Enter would land on the live dialog and
// CONFIRM its highlighted option — exactly what "detect + notify only, never auto-answer" forbids. Fixed
// by dropping that call entirely; see docs/decisions/01160ae3-no-self-nudge-to-stuck-session.md.
//
// Proves:
//   (A) A durable `claude_boot_dialog_stuck` event is always recorded, with `role` now included in detail
//       (Code Review item 3).
//   (B) When a parent exists, the PARENT gets exactly one enqueueStdin call naming the session/signature —
//       and the STUCK SESSION ITSELF gets ZERO enqueueStdin calls (the self-nudge is gone).
//   (C) When there is NO parent, nothing is enqueued to ANYONE (event only) — not even the stuck session.
//   (D) Card 850eb55c: the parent shares the self-nudge hazard — when the parent itself is LIVE but has
//       NOT observed SessionStart/any hook (still pre-boot on the same repo-keyed dialog), it gets ZERO
//       enqueueStdin calls; the durable event still records (with `detail.parentNudged: false`), but
//       nothing is typed into a parent that might itself be sitting on a live, unanswered dialog.
//   (E) Card 850eb55c round 2 (item 5): an ABSENT parent (not currently live at all — e.g. not yet
//       re-spawned after a restart) is NOT the same hazard as (D) — there is no live pty to type into, so
//       it must go through the ORDINARY durable enqueue path (one enqueueStdin call, `parentNudged:true`),
//       not be silently withheld the way (D)'s live-and-stuck parent correctly is.
//   (M1)-(M5) Card e2a3c613: a stuck MANAGER has no parentSessionId at all, so (B)-(E) above never apply
//       to it — NEW coverage for the Platform-Lead escalation `notifyLeadOfStuckManager` adds (labeled
//       M1-M5, not F-J, to avoid colliding with the UNRELATED (F)/(G)/(H) labels the real-PtyHost block
//       at the end of this file already uses). (M1) LOOM_DEV off: no-op, event-only. (M2) LOOM_DEV on,
//       no live Lead: a durable board task still files (mirrors `platformEscalate`'s durable-first
//       design) but no live nudge. (M3) a live, past-boot Lead: ONE enqueueStdin call to the Lead (never
//       to the stuck manager — the self-nudge rule is unaffected) plus the board task. (M4) the Lead is
//       ITSELF live-and-pre-boot: suppress the live nudge (same hazard (D) guards for a manager parent)
//       but the board task still files. (M5) a SECOND stuck episode for the SAME session id reuses the
//       EXISTING board task (never a duplicate `insertTask`), while the live-nudge-to-Lead itself is NOT
//       deduped (fires once per episode).
//   (M6) Card e2a3c613 round 3 (item 3): notifyLeadOfStuckManager's prior-task lookup used a plain
//       .find() over listEventsForWorker's ts-ASC order, which returns the OLDEST matching event, not
//       the latest. Three episodes: ep1 files T1 (open); T1 is then manually closed (terminal column); ep2
//       correctly files a FRESH T2 (T1 is terminal) — this alone doesn't distinguish .find() from
//       .findLast(), since there's still only one candidate event. ep3 is the real differentiator: there
//       are now TWO leadBoardTaskId-carrying events (ep1 -> T1 terminal, ep2 -> T2 open) — the buggy
//       .find() would return ep1 (oldest), see T1 terminal, and wrongly file a THIRD task even though T2
//       is open and should be reused; .findLast() returns ep2 (latest), sees T2 open, correctly reuses it.
//
// RED-BEFORE-GREEN (this project's own standing verification posture): run against the PRE-FIX
// sessions/service.ts (`git show b3f908fd:packages/daemon/src/sessions/service.ts`, the round-1 tip) —
// (B)'s "stuck session gets ZERO enqueueStdin calls" assertion fails (the old code enqueues exactly one
// nudge to the stuck session too). (A) and (C) already pass unchanged (event recording and the no-parent
// branch were never the defect). (E) is NEW in round 2 and has no pre-fix baseline of its own to compare
// against — see the separate real-PtyHost block at the end of this file for round 2's own red-before-green
// proof (isLiveAndPreBoot's `live.alive` check, run against a reverted copy that drops it).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-cbdsns-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// Minimal hermetic PtyStub — records every enqueueStdin call by recipient id so the test can assert
// EXACTLY who got written to, not just that "something" was enqueued somewhere. Card 850eb55c round 2
// (item 5): models `isLiveAndPreBoot` directly (live AND NOT past-boot) rather than the old
// `hasObservedSessionStartOrAnyHook` (past-boot alone) — an id that is simply never marked `live` (never
// added to `this.live`) now correctly reads `false` here too, matching real `PtyHost`'s own semantics for
// an unknown/absent session.
class PtyStub {
  constructor() {
    this.live = new Set();
    this.pastBoot = new Set(); // card 850eb55c: sessionStartObserved||anyHookObserved, per id
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
const proj = `cbdsns-proj-${sfx}`, agent = `cbdsns-ag-${sfx}`;
db.insertProject({ id: proj, name: proj, repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agent, projectId: proj, name: "t", startupPrompt: "", position: 0 });
const mkSession = (o) => db.insertSession({
  id: o.id, projectId: proj, agentId: agent, engineSessionId: `eng-${o.id}`, title: null, cwd: os.tmpdir(),
  processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: o.role ?? null, parentSessionId: o.parentSessionId ?? null, taskId: o.taskId ?? null,
  worktreePath: null, branch: null,
});

try {
  // ===================== (A) + (B): a worker with a manager — event recorded, parent nudged, stuck session untouched =====================
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `cbdsns-ab-mgr-${sfx}`, wkr = `cbdsns-ab-wkr-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: wkr, role: "worker", parentSessionId: mgr });
    pty.setLive(mgr); pty.setLive(wkr);
    pty.setPastBoot(mgr); // the ordinary case: the manager is long past its own SessionStart

    sessions.handleClaudeBootDialogStuck(wkr, { timeoutMs: 150_000, signatureName: "external-imports", role: "worker" });

    const events = db.listEventsForWorker(wkr).filter((e) => e.kind === "claude_boot_dialog_stuck");
    check("(A) exactly one durable claude_boot_dialog_stuck event recorded", events.length === 1);
    check("(A) event detail carries timeoutMs/signatureName/role", events[0]?.detail?.timeoutMs === 150_000 && events[0]?.detail?.signatureName === "external-imports" && events[0]?.detail?.role === "worker");
    check("(A) event is filed under the parent manager", events[0]?.managerSessionId === mgr);
    check("(A) event detail records parentNudged:true when the parent is past boot", events[0]?.detail?.parentNudged === true);

    const toStuck = pty.enqueueCalls.filter((c) => c.id === wkr);
    const toParent = pty.enqueueCalls.filter((c) => c.id === mgr);
    check("(B) ZERO enqueueStdin calls to the stuck session itself — the self-nudge is gone", toStuck.length === 0);
    check("(B) exactly ONE enqueueStdin call to the parent manager", toParent.length === 1);
    check("(B) the parent's nudge names the signature and the stuck session", /external-imports/.test(toParent[0]?.text ?? "") && new RegExp(wkr).test(toParent[0]?.text ?? ""));
  }

  // ===================== (D) Card 850eb55c: parent exists but is ITSELF still pre-SessionStart — event =====================
  // =====================     only, the parent gets ZERO enqueueStdin calls (shares the self-nudge hazard) =====================
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `cbdsns-d-mgr-${sfx}`, wkr = `cbdsns-d-wkr-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: wkr, role: "worker", parentSessionId: mgr });
    pty.setLive(mgr); pty.setLive(wkr);
    // Deliberately do NOT call pty.setPastBoot(mgr) — the manager is itself stuck pre-SessionStart.

    sessions.handleClaudeBootDialogStuck(wkr, { timeoutMs: 150_000, signatureName: "workspace-trust", role: "worker" });

    const events = db.listEventsForWorker(wkr).filter((e) => e.kind === "claude_boot_dialog_stuck");
    check("(D) the durable event still fires even though the parent can't safely be nudged", events.length === 1);
    check("(D) event detail records parentNudged:false", events[0]?.detail?.parentNudged === false);
    check("(D) ZERO enqueueStdin calls to the parent manager — it may itself be stuck on the same dialog", pty.enqueueCalls.filter((c) => c.id === mgr).length === 0);
    check("(D) ZERO enqueueStdin calls to the stuck worker either — the self-nudge rule still holds", pty.enqueueCalls.filter((c) => c.id === wkr).length === 0);
    check("(D) nothing was enqueued to ANYONE", pty.enqueueCalls.length === 0);
  }

  // ===================== (C) No parent: event only, nothing enqueued to anyone (not even the stuck session) =====================
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const standalone = `cbdsns-c-standalone-${sfx}`;
    mkSession({ id: standalone, role: "worker" }); // no parentSessionId
    pty.setLive(standalone);

    sessions.handleClaudeBootDialogStuck(standalone, { timeoutMs: 150_000, signatureName: null, role: "worker" });

    const events = db.listEventsForWorker(standalone).filter((e) => e.kind === "claude_boot_dialog_stuck");
    check("(C) the durable event still fires with no parent", events.length === 1);
    check("(C) a null signatureName is recorded honestly (none recognized), never fabricated", events[0]?.detail?.signatureName === null);
    check("(C) ZERO enqueueStdin calls anywhere — no parent to notify, and the stuck session itself is still never nudged", pty.enqueueCalls.length === 0);
    check("(C) event detail records parentNudged:false (no parent to nudge)", events[0]?.detail?.parentNudged === false);
  }

  // ===================== (E) Card 850eb55c round 2 (item 5): parent exists but is ABSENT from PtyHost's ===
  // =====================     own live map entirely (never marked live here — e.g. not yet re-spawned ======
  // =====================     after a restart) — NOT the same hazard as (D): there is no live pty to type ==
  // =====================     into, so the ordinary durable enqueue path must still run. ====================
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `cbdsns-e-mgr-${sfx}`, wkr = `cbdsns-e-wkr-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: wkr, role: "worker", parentSessionId: mgr });
    pty.setLive(wkr); // the worker is live; the manager is deliberately NEVER marked live at all

    sessions.handleClaudeBootDialogStuck(wkr, { timeoutMs: 150_000, signatureName: "external-imports", role: "worker" });

    const events = db.listEventsForWorker(wkr).filter((e) => e.kind === "claude_boot_dialog_stuck");
    check("(E) the durable event fires for an absent parent", events.length === 1);
    check("(E) event detail records parentNudged:true — absent is NOT the same as live-and-stuck", events[0]?.detail?.parentNudged === true);
    const toParent = pty.enqueueCalls.filter((c) => c.id === mgr);
    check("(E) exactly ONE enqueueStdin call reaches the absent parent (the ordinary durable-enqueue path, not suppressed)", toParent.length === 1);
    check("(E) the stuck worker itself still gets ZERO enqueueStdin calls — the self-nudge rule is unaffected", pty.enqueueCalls.filter((c) => c.id === wkr).length === 0);
  }

  // ===================== Card e2a3c613 — a stuck MANAGER has no parentSessionId at all, so the parent- ===
  // =====================     nudge branch never fires for it (parentNudged is always false); this is ======
  // =====================     NEW coverage: the Platform-Lead escalation + owner-attention routing. ========
  const home = `cbdsns-platform-home-${sfx}`;
  db.insertProject({ id: home, name: "Loom Platform", repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null, reserved: true });

  // ===================== (M1) manager, LOOM_DEV OFF: no Lead escalation attempted at all (notifyLeadOf- =
  // =====================      StuckManager is a no-op pre-isLoomDev-check) — event-only, parentNudged: ===
  // =====================      false, leadNotified:false, no board task, ZERO enqueueStdin calls anywhere.
  {
    delete process.env.LOOM_DEV;
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `cbdsns-m1-mgr-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    pty.setLive(mgr);

    sessions.handleClaudeBootDialogStuck(mgr, { timeoutMs: 150_000, signatureName: "workspace-trust", role: "manager" });

    const events = db.listEventsForWorker(mgr).filter((e) => e.kind === "claude_boot_dialog_stuck");
    check("(M1) the durable event fires for a stuck manager even with LOOM_DEV off", events.length === 1);
    check("(M1) event detail records parentNudged:false — a manager never has a parentSessionId", events[0]?.detail?.parentNudged === false);
    check("(M1) event detail records leadNotified:false — LOOM_DEV is off, no Lead escalation attempted", events[0]?.detail?.leadNotified === false);
    check("(M1) event detail carries no leadBoardTaskId — no board task was filed", events[0]?.detail?.leadBoardTaskId === undefined);
    check("(M1) ZERO enqueueStdin calls anywhere — no parent, no Lead, and the self-nudge rule still holds", pty.enqueueCalls.length === 0);
    check("(M1) zero tasks filed on the Platform home", db.listTasks(home).length === 0);
  }

  // ===================== (M2) manager, LOOM_DEV ON but NO live Lead: a durable board task IS filed on ===
  // =====================      the Platform home (so an offline Lead sees it later), but leadNotified =====
  // =====================      stays false (nobody live to nudge) — mirrors platformEscalate's own ========
  // =====================      durable-first design. ========================================================
  {
    process.env.LOOM_DEV = "1";
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `cbdsns-m2-mgr-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    pty.setLive(mgr);

    sessions.handleClaudeBootDialogStuck(mgr, { timeoutMs: 150_000, signatureName: "workspace-trust", role: "manager" });

    const events = db.listEventsForWorker(mgr).filter((e) => e.kind === "claude_boot_dialog_stuck");
    check("(M2) event detail records leadNotified:false — LOOM_DEV is on but no Lead is live", events[0]?.detail?.leadNotified === false);
    const taskId = events[0]?.detail?.leadBoardTaskId;
    check("(M2) event detail carries a leadBoardTaskId — a durable task WAS filed despite no live Lead", typeof taskId === "string");
    const task = typeof taskId === "string" ? db.getTask(taskId) : undefined;
    check("(M2) the filed task lives on the reserved Platform home project", task?.projectId === home);
    check("(M2) the filed task names the stuck manager session and signature", !!task && task.body.includes(mgr) && task.body.includes("workspace-trust"));
    check("(M2) ZERO enqueueStdin calls anywhere — no Lead is live to receive one", pty.enqueueCalls.length === 0);
  }

  // ===================== (M3) manager, LOOM_DEV ON, a LIVE + past-boot Lead exists: best-effort live- ====
  // =====================      nudge the Lead (ONE enqueueStdin call, never to the stuck manager itself), =
  // =====================      AND file the durable board task — leadNotified:true. ==========================
  {
    process.env.LOOM_DEV = "1";
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `cbdsns-m3-mgr-${sfx}`, lead = `cbdsns-m3-lead-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: lead, role: "platform" });
    pty.setLive(mgr); pty.setLive(lead); pty.setPastBoot(lead); // the Lead is live and NOT itself stuck

    sessions.handleClaudeBootDialogStuck(mgr, { timeoutMs: 150_000, signatureName: "external-imports", role: "manager" });

    const events = db.listEventsForWorker(mgr).filter((e) => e.kind === "claude_boot_dialog_stuck");
    check("(M3) event detail records leadNotified:true — a live, past-boot Lead was nudged", events[0]?.detail?.leadNotified === true);
    check("(M3) event detail still carries a leadBoardTaskId", typeof events[0]?.detail?.leadBoardTaskId === "string");
    const toLead = pty.enqueueCalls.filter((c) => c.id === lead);
    check("(M3) exactly ONE enqueueStdin call reaches the Lead", toLead.length === 1);
    check("(M3) the Lead's nudge names the stuck manager session", new RegExp(mgr).test(toLead[0]?.text ?? ""));
    check("(M3) the stuck manager itself still gets ZERO enqueueStdin calls — the self-nudge rule is unaffected for managers too", pty.enqueueCalls.filter((c) => c.id === mgr).length === 0);
    // This file shares ONE `db` across every (M1)-(M5) scenario (same pattern (A)-(E) already use) — retire
    // this scenario's OWN Lead row so the NEXT scenario's `listAllSessions().find(role==="platform"&&live)`
    // lookup can never pick up a stale lead from an earlier scenario instead of its own fresh one.
    db.setProcessState(lead, "exited");
  }

  // ===================== (M4) manager, LOOM_DEV ON, a LIVE Lead that is ITSELF still pre-SessionStart on =
  // =====================      the SAME dialog family: suppress the live nudge (mirrors 850eb55c's =========
  // =====================      manager-parent suppression, card D above) — but the board task still files.
  {
    process.env.LOOM_DEV = "1";
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `cbdsns-m4-mgr-${sfx}`, lead = `cbdsns-m4-lead-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: lead, role: "platform" });
    pty.setLive(mgr); pty.setLive(lead); // deliberately do NOT setPastBoot(lead) — it is itself stuck

    sessions.handleClaudeBootDialogStuck(mgr, { timeoutMs: 150_000, signatureName: "external-imports", role: "manager" });

    const events = db.listEventsForWorker(mgr).filter((e) => e.kind === "claude_boot_dialog_stuck");
    check("(M4) event detail records leadNotified:false — the Lead is itself live-and-pre-boot, may be stuck on the same dialog", events[0]?.detail?.leadNotified === false);
    check("(M4) event detail still carries a leadBoardTaskId — the durable task is unaffected by the live-nudge suppression", typeof events[0]?.detail?.leadBoardTaskId === "string");
    check("(M4) ZERO enqueueStdin calls to the Lead — it may itself be stuck on the same dialog", pty.enqueueCalls.filter((c) => c.id === lead).length === 0);
    check("(M4) the stuck manager itself still gets ZERO enqueueStdin calls", pty.enqueueCalls.filter((c) => c.id === mgr).length === 0);
    db.setProcessState(lead, "exited"); // see (M3)'s own comment on why this matters for the NEXT scenario
  }

  // ===================== (M5) dedup: a SECOND stuck episode for the SAME manager session id reuses the ==
  // =====================      EXISTING board task — never a second insertTask — while the live nudge =====
  // =====================      (not deduped) still fires again each time. ====================================
  {
    process.env.LOOM_DEV = "1";
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `cbdsns-m5-mgr-${sfx}`, lead = `cbdsns-m5-lead-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: lead, role: "platform" });
    pty.setLive(mgr); pty.setLive(lead); pty.setPastBoot(lead);

    const tasksBefore = db.listTasks(home).length;
    sessions.handleClaudeBootDialogStuck(mgr, { timeoutMs: 150_000, signatureName: "external-imports", role: "manager" });
    const firstTaskId = db.listEventsForWorker(mgr).find((e) => e.kind === "claude_boot_dialog_stuck")?.detail?.leadBoardTaskId;
    check("(M5) (setup) the first stuck episode filed exactly one new task", db.listTasks(home).length === tasksBefore + 1);

    // A second stuck episode for the SAME session id (e.g. the session was resumed and got stuck again).
    sessions.handleClaudeBootDialogStuck(mgr, { timeoutMs: 150_000, signatureName: "external-imports", role: "manager" });
    const secondEvents = db.listEventsForWorker(mgr).filter((e) => e.kind === "claude_boot_dialog_stuck");
    check("(M5) exactly TWO durable events now exist for this session id (one per episode — never deduped)", secondEvents.length === 2);
    const secondTaskId = secondEvents[secondEvents.length - 1]?.detail?.leadBoardTaskId;
    check("(M5) the SECOND episode's event carries the SAME leadBoardTaskId as the first — reused, not re-filed", secondTaskId === firstTaskId);
    check("(M5) NO new task was filed on the Platform home for the second episode (still exactly tasksBefore+1)", db.listTasks(home).length === tasksBefore + 1);
    const toLead = pty.enqueueCalls.filter((c) => c.id === lead);
    check("(M5) the live-nudge-to-Lead itself is NOT deduped — it fires once per episode (TWO calls total)", toLead.length === 2);
    db.setProcessState(lead, "exited"); // hygiene — see (M3)'s own comment
  }

  // ===================== (M6) Card e2a3c613 round 3 (item 3): notifyLeadOfStuckManager must reuse the ====
  // =====================      LATEST leadBoardTaskId-carrying event, never the oldest — see this file's ===
  // =====================      own header doc for why ep3 below is the real differentiator. ==================
  {
    process.env.LOOM_DEV = "1";
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `cbdsns-m6-mgr-${sfx}`, lead = `cbdsns-m6-lead-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: lead, role: "platform" });
    pty.setLive(mgr); pty.setLive(lead); pty.setPastBoot(lead);

    // ep1: no prior task ⇒ files a fresh T1.
    sessions.handleClaudeBootDialogStuck(mgr, { timeoutMs: 150_000, signatureName: "external-imports", role: "manager" });
    const ep1 = db.listEventsForWorker(mgr).filter((e) => e.kind === "claude_boot_dialog_stuck");
    const t1 = ep1[0]?.detail?.leadBoardTaskId;
    check("(M6) (setup) ep1 filed a task", typeof t1 === "string");

    // Manually close T1 (move it to the terminal "done" column — the default kanbanColumns terminal key).
    db.updateTask(t1, { columnKey: "done" });

    // ep2: the only prior leadBoardTaskId-carrying event (ep1) now points at a TERMINAL task ⇒ files a
    // FRESH T2. This alone is satisfied by either .find() or .findLast() (only one candidate exists).
    sessions.handleClaudeBootDialogStuck(mgr, { timeoutMs: 150_000, signatureName: "external-imports", role: "manager" });
    const ep2 = db.listEventsForWorker(mgr).filter((e) => e.kind === "claude_boot_dialog_stuck");
    const t2 = ep2[ep2.length - 1]?.detail?.leadBoardTaskId;
    check("(M6) ep2 (prior task T1 is terminal) files a DIFFERENT, fresh task T2", typeof t2 === "string" && t2 !== t1);
    check("(M6) T2 is NOT itself terminal (freshly filed onto the default landing column)", db.getTask(t2)?.columnKey !== "done");

    // ep3: now TWO leadBoardTaskId-carrying events exist (ep1→T1 terminal, ep2→T2 open). The buggy
    // `.find()` (oldest-first) would resolve to ep1/T1, see it terminal, and wrongly file a THIRD task —
    // `.findLast()` (latest-first) resolves to ep2/T2, sees it still open, and correctly reuses it.
    const tasksBeforeEp3 = db.listTasks(home).length;
    sessions.handleClaudeBootDialogStuck(mgr, { timeoutMs: 150_000, signatureName: "external-imports", role: "manager" });
    const ep3 = db.listEventsForWorker(mgr).filter((e) => e.kind === "claude_boot_dialog_stuck");
    const t3 = ep3[ep3.length - 1]?.detail?.leadBoardTaskId;
    check("(M6) ep3 reuses T2 (the LATEST open prior task), not T1 (the oldest, terminal one)", t3 === t2);
    check("(M6) no new task was filed for ep3 — T2 was correctly recognized as still open", db.listTasks(home).length === tasksBeforeEp3);
    db.setProcessState(lead, "exited"); // hygiene — see (M3)'s own comment
  }
  delete process.env.LOOM_DEV;

  db.close();
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ===================== REAL PtyHost: isLiveAndPreBoot discriminates unknown / dead-but-mapped / live-pre- =
// =====================     boot, against the ACTUAL implementation (not just the PtyStub's own model of ==
// =====================     the contract above). Card 850eb55c round 2 (item 5): `handleClaudeBootDialogStuck`'s
// =====================     correctness depends on this — a claude session's `Live` entry is NEVER removed =
// =====================     from `this.live` on exit (host.ts's own onExit doc comment: "dead-but-present"), =
// =====================     so an id that merely EXITED must read the SAME as one that was NEVER spawned, ===
// =====================     never as "still live and stuck". No DB/SessionService involved — this is a ======
// =====================     direct unit check of the PtyHost method itself. ================================
{
  const { PtyHost } = await import("../dist/pty/host.js");
  const { createSeamHost } = await import("./_seam-host-fixture.mjs");
  const events = { onEngineSessionId() {}, onContextStats() {}, onRateLimited() {}, onExit() {}, onBusy() {} };
  const host = new (createSeamHost(PtyHost))(events);

  const neverSpawned = `cbdsns-real-unknown-${sfx}`;
  check("(F) an id NEVER spawned at all: isLiveAndPreBoot reads false (no live pty to type into)", host.isLiveAndPreBoot(neverSpawned) === false);

  const G = `cbdsns-real-dead-but-mapped-${sfx}`;
  try {
    host.spawn({
      sessionId: G, cwd: tmpHome, role: "manager",
      permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
      geometry: { cols: 120, rows: 40 }, sessionEnv: {},
    });
    check("(G) a freshly-spawned, still pre-SessionStart session: isLiveAndPreBoot reads true", host.isLiveAndPreBoot(G) === true);

    host.stop(G, "hard"); // the seam fixture's fake pty.kill() fires onExit SYNCHRONOUSLY (live.alive -> false); the Live entry itself is never removed from the map for kind:"claude" (see onExit's own "dead-but-present" comment)
    check("(H) the SAME id, now DEAD-BUT-MAPPED (killed, entry still present with alive:false): isLiveAndPreBoot reads false — same as an unknown id, NOT the same as (G)'s live-preboot reading", host.isLiveAndPreBoot(G) === false);
  } finally {
    try { host.stop(G, "hard"); } catch { /* already dead — ignore */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — handleClaudeBootDialogStuck always records the durable event (role + parentNudged included), notifies the parent manager only when it is LIVE and itself past boot, and never writes anything to the stuck session itself (the self-nudge that could confirm a live dialog is gone); a parent that is live but still pre-SessionStart, and the no-parent branch, are both event-only; an ABSENT parent (round 2 item 5) correctly goes through the ordinary durable enqueue instead of being silently withheld; and the real PtyHost.isLiveAndPreBoot correctly reads an unknown id and a dead-but-mapped id the same way (both false), never conflating either with a genuinely live, still-booting session."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
