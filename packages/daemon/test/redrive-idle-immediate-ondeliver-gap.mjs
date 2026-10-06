import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Regression test for card 0075e20b: a redrive into a LIVE, IDLE, EMPTY-pending recipient takes
// enqueueStdin's IMMEDIATE branch — which (by design, decision 2ca18433) never fires onDeliver — so
// redriveQueuedMessage used to leave the durable `session_message_queued` record UNRESOLVED despite
// genuine delivery, and a later boot's `recoverUndeliveredMessagesOnBoot` would redrive the SAME message
// a SECOND time: a real duplicate delivery.
//
// THE FIX (sessions/service.ts, `redriveQueuedMessage`): the caller now resolves the record itself,
// idempotently, right after a `delivered:true` return — it no longer waits on `onDeliver` to do it. See
// `EnqueueResult`'s own doc (pty/host.ts) for the stated contract, and docs/decisions/2ca18433-…md's
// "Card 0075e20b amendment" section for why this is caller-side rather than a change to the immediate
// branch itself (claude's M1/M2 busy-gate ordering concern is left untouched).
//
// Every existing scenario in queued-message-liveflip-redrive.mjs sets the recipient BUSY before redriving
// (see its own PtyStub.enqueueStdin: idle → immediate, busy → held) — so the idle/immediate branch this
// card is about was never exercised by a redrive before this file.
//
// RAN RED pre-fix (see the worker_report for this card: reverting the `if (r.delivered) { ... }` block
// added to `redriveQueuedMessage` and rebuilding reproduces the two "(R1)"/"(R2)" checks below failing
// exactly as this header describes — the record stayed unresolved and the next boot redrove it again).
//
// Run: 1) build daemon, 2) node test/redrive-idle-immediate-ondeliver-gap.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-ridg-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// Contract-faithful PtyStub, IDENTICAL semantics to queued-message-liveflip-redrive.mjs's own stub: a
// session must be `live` to receive; a `busy`/not-ready recipient QUEUES + stores onDeliver; an IDLE one
// delivers IMMEDIATELY and — exactly like the real host's enqueueStdin — does NOT fire onDeliver. The fix
// under test is caller-side (SessionService), so this stub's own mechanics stay byte-identical to the
// real (unchanged) host contract — only what SessionService does with the returned `delivered:true` changed.
class PtyStub {
  constructor() { this.q = new Map(); this.live = new Set(); this.busy = new Set(); this.immediateDeliveries = []; }
  setLive(id, on = true) { if (on) this.live.add(id); else this.live.delete(id); }
  setBusy(id, on = true) { if (on) this.busy.add(id); else this.busy.delete(id); }
  enqueueStdin(id, text, _source = "system", onDeliver) {
    if (!this.live.has(id)) return { delivered: false };          // not alive → dropped (no position)
    if (!this.busy.has(id)) { this.immediateDeliveries.push(text); return { delivered: true }; } // idle → immediate (onDeliver NOT fired, per decision 2ca18433)
    const a = this.q.get(id) ?? []; a.push({ text, onDeliver }); this.q.set(id, a);
    return { delivered: false, position: a.length };
  }
  drainOne(id) { const a = this.q.get(id) ?? []; const m = a.shift(); if (m?.onDeliver) m.onDeliver(); return m?.text; }
  getPending(id) { return (this.q.get(id) ?? []).map((m) => m.text); }
  flushPending(id) { const a = this.q.get(id) ?? []; this.q.set(id, []); return a; }
  interruptForRedirect() { /* no-op stub — not under test here */ }
}

try {
  const db = new Db();
  const proj = `ridg-proj-${sfx}`, agent = `ridg-ag-${sfx}`;
  db.insertProject({ id: proj, name: proj, repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agent, projectId: proj, name: "t", startupPrompt: "", position: 0 });
  const mkSession = (o) => db.insertSession({
    id: o.id, projectId: proj, agentId: agent, engineSessionId: `eng-${o.id}`, title: null, cwd: os.tmpdir(),
    processState: o.processState ?? "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: o.role ?? null, parentSessionId: o.parentSessionId ?? null, taskId: o.taskId ?? null,
    worktreePath: null, branch: null, recycledFrom: o.recycledFrom ?? null,
  });
  const undelivered = (marker) => db.listUndeliveredQueuedMessages().filter((e) => e.detail.text.includes(marker)).length;

  // ===================== (R1) REDRIVE INTO AN IDLE, EMPTY-QUEUE RECIPIENT — the untested branch =====================
  const pty = new PtyStub();
  const sessions = new SessionService(db, pty, new OrchestrationControl());
  const mgr = `ridg-A-mgr-${sfx}`, wkr = `ridg-A-wkr-${sfx}`;
  mkSession({ id: mgr, role: "manager" });
  mkSession({ id: wkr, role: "worker", parentSessionId: mgr });
  pty.setLive(mgr); pty.setLive(wkr); pty.setBusy(wkr); // recipient BUSY at send time → HELD + persisted
  const r0 = sessions.messageWorker(mgr, wkr, "IDLE REDRIVE TARGET");
  check("(R1) setup: busy recipient → message HELD + persisted", r0.delivered === false && undelivered("IDLE REDRIVE TARGET") === 1);
  // Captured BEFORE the redrive below — once the fix resolves the record, listUndeliveredQueuedMessages
  // no longer returns it, so this is the only point this msgId is still readable off the durable row.
  const heldMsgId = db.listUndeliveredQueuedMessages().find((e) => e.detail.text.includes("IDLE REDRIVE TARGET"))?.detail?.msgId;
  check("(R1) setup: the held record's msgId is captured", typeof heldMsgId === "string");

  // Recipient crashes before draining. On reboot it comes back LIVE, IDLE (not busy), pending EMPTY —
  // the exact condition enqueueStdin's `idleEligible && live.pending.length === 0` immediate branch needs.
  const ptyBoot = new PtyStub();
  const sessionsBoot = new SessionService(db, ptyBoot, new OrchestrationControl());
  db.setProcessState(wkr, "live");
  ptyBoot.setLive(wkr);
  // deliberately do NOT setBusy(wkr) — idle, empty queue.
  sessionsBoot.redriveUndeliveredMessagesForRecipient(wkr);

  check("(R1) the redrive took the IMMEDIATE (idle) branch — text handed straight to the pty",
    ptyBoot.immediateDeliveries.some((t) => t.includes("IDLE REDRIVE TARGET")));
  check("(R1) FIX: the durable record resolves immediately, even though onDeliver never fired (the caller resolved it itself)",
    undelivered("IDLE REDRIVE TARGET") === 0);
  // Card 796221c9 item 2: the SAME `if (r.delivered) { ... }` block also clears the in-flight mark
  // (`clearRedriveInFlight(msgId)`) — distinct from resolving the durable record above. Deleting ONLY
  // that one call leaves this mark stuck forever (nothing else clears it on the immediate branch), while
  // the durable-record check above would still pass unchanged — so it needs its own direct assertion.
  check("(R1) FIX: the in-flight mark is cleared too, not just the durable record (clearRedriveInFlight actually ran)",
    sessionsBoot.redriveInFlightByMsgId.has(heldMsgId) === false);

  // ===================== (R2) THE FIX HOLDS ACROSS A RESTART — no duplicate on the next boot =====================
  // Simulate the recipient's pty exiting (clears this process's in-flight guard, same as cd390610's real
  // exit hook) and a fresh daemon process booting (fresh in-flight Set). Pre-fix, the record was still
  // unresolved at this point, so the one-shot boot scan treated it as never-delivered and redrove it a
  // SECOND time. Post-fix, the record already resolved in (R1), so there is nothing left to redrive.
  sessionsBoot.clearRedriveInFlightForExit(wkr);
  const ptyNext = new PtyStub();
  const sessionsNext = new SessionService(db, ptyNext, new OrchestrationControl());
  db.setProcessState(wkr, "live");
  ptyNext.setLive(wkr); // still idle, empty queue
  const m = sessionsNext.recoverUndeliveredMessagesOnBoot();

  check("(R2) FIX: next boot's scan finds nothing left to redrive (the record already resolved)",
    m.reEnqueued === 0 && ptyNext.immediateDeliveries.length === 0);
  check("(R2) FIX: the recipient received the content EXACTLY ONCE across the whole scenario (no duplicate)",
    ptyBoot.immediateDeliveries.length === 1 && ptyNext.immediateDeliveries.length === 0);

  db.close();
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a redrive into a live/idle/empty-queue recipient now resolves its durable record immediately (card 0075e20b's caller-side fix), even though onDeliver never fires on that branch, so a later boot never redrives (and never duplicates) it."
  : `\n❌ ${failures} FAILURE(S) — card 0075e20b's bug reproduced: the record stayed unresolved and/or the recipient received a duplicate delivery.`);
process.exit(failures === 0 ? 0 : 1);
