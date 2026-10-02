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
//
// RED-BEFORE-GREEN (this project's own standing verification posture): run against the PRE-FIX
// sessions/service.ts (`git show b3f908fd:packages/daemon/src/sessions/service.ts`, the round-1 tip) —
// (B)'s "stuck session gets ZERO enqueueStdin calls" assertion fails (the old code enqueues exactly one
// nudge to the stuck session too). (A) and (C) already pass unchanged (event recording and the no-parent
// branch were never the defect).
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
// EXACTLY who got written to, not just that "something" was enqueued somewhere.
class PtyStub {
  constructor() {
    this.live = new Set();
    this.enqueueCalls = []; // { id, text }
  }
  setLive(id, on = true) { if (on) this.live.add(id); else this.live.delete(id); }
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

    sessions.handleClaudeBootDialogStuck(wkr, { timeoutMs: 150_000, signatureName: "external-imports", role: "worker" });

    const events = db.listEventsForWorker(wkr).filter((e) => e.kind === "claude_boot_dialog_stuck");
    check("(A) exactly one durable claude_boot_dialog_stuck event recorded", events.length === 1);
    check("(A) event detail carries timeoutMs/signatureName/role", events[0]?.detail?.timeoutMs === 150_000 && events[0]?.detail?.signatureName === "external-imports" && events[0]?.detail?.role === "worker");
    check("(A) event is filed under the parent manager", events[0]?.managerSessionId === mgr);

    const toStuck = pty.enqueueCalls.filter((c) => c.id === wkr);
    const toParent = pty.enqueueCalls.filter((c) => c.id === mgr);
    check("(B) ZERO enqueueStdin calls to the stuck session itself — the self-nudge is gone", toStuck.length === 0);
    check("(B) exactly ONE enqueueStdin call to the parent manager", toParent.length === 1);
    check("(B) the parent's nudge names the signature and the stuck session", /external-imports/.test(toParent[0]?.text ?? "") && new RegExp(wkr).test(toParent[0]?.text ?? ""));
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
  }

  db.close();
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — handleClaudeBootDialogStuck always records the durable event (role included), notifies ONLY the parent manager when one exists, and never writes anything to the stuck session itself (the self-nudge that could confirm a live dialog is gone); the no-parent branch is event-only."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
