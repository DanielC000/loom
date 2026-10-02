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
  lastError: null, role: o.role ?? null, parentSessionId: o.parentSessionId ?? null, taskId: null,
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
