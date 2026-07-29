import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1)
// Regression test for card f25bf3bf — "three carry paths replay a held give-up requeue without its hold"
// (the recycle-path half of what 9e27f4d2 deliberately left open when it fixed the daemon-restart path).
//
// DECISION UNDER TEST: SessionService.carryPendingToSuccessor (the shared carry behind recycleWorker/
// recycleManager/recyclePlatformLead) deliberately does NOT carry `giveUpHeldUntil` onto its successor —
// see the method's own doc comment for the full reasoning. In short: a recycle spawns its successor
// FRESH, with NO `--resume`, so the successor's conversation never saw whatever the predecessor's engine
// may have already done with a still-held entry's text — there is no shared transcript for a re-delivered
// duplicate to confuse. And the hold's purge could never fire on a fresh successor either way (its own
// `giveUpConfirmQueue` starts empty, exactly like a post-restart session), so preserving the hold would
// only ever stall the successor's first real instruction with zero chance of ever being purged instead of
// delivered. This test proves that DELIVER verdict actually reaches `pty.enqueueStdin`: a still-held entry
// on the predecessor lands on the successor with NO `giveUpHeldUntil`, ready to drain on the successor's
// very next turn boundary rather than sitting needlessly held.
//
// Uses the SAME PtyStub-based service-level harness as recycle-pending-carry.mjs (no real claude, no live
// daemon — the recycle.mjs integration test covers the real-claude end-to-end), extended to carry
// `kind`/`giveUpHeldUntil` through `enqueueStdin`/`flushPending` exactly like host.ts's real QueuedMessage,
// so the fix's decision is observable at this seam without needing a real hold-window timer.
//
// Run: 1) build daemon, 2) node test/recycle-giveup-hold.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Hermetic LOOM_HOME BEFORE importing db.js (paths.ts reads it at import time).
const tmpHome = path.join(os.tmpdir(), `loom-rgh2-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// Mirrors recycle-pending-carry.mjs's PtyStub, extended to carry `kind`/`giveUpHeldUntil` through exactly
// like host.ts's real QueuedMessage (flushPending returns the full held entry, onDeliver included).
class PtyStub {
  constructor() { this.q = new Map(); this.live = new Set(); this.busy = new Set(); }
  setLive(id, on = true) { if (on) this.live.add(id); else { this.live.delete(id); this.busy.delete(id); } }
  setBusy(id, on = true) { if (on) this.busy.add(id); else this.busy.delete(id); }
  enqueueStdin(id, text, source = "system", onDeliver, route, kind, questionId, ownerText, proactive, senderId, giveUpHeldUntil) {
    if (!this.live.has(id)) return { delivered: false };
    if (!this.busy.has(id)) { const a = this.q.get(id) ?? []; a.push({ id: `d-${a.length}`, text, source, delivered: true }); this.q.set(id, a); return { delivered: true }; }
    const a = this.q.get(id) ?? []; a.push({ id: `qm-${a.length}`, text, source, onDeliver, kind, giveUpHeldUntil }); this.q.set(id, a);
    return { delivered: false, position: a.length };
  }
  flushPending(id) { const a = (this.q.get(id) ?? []).filter((m) => !m.delivered); this.q.set(id, []); return a; }
  getPending(id) { return (this.q.get(id) ?? []).map((m) => m.text); }
  pendingEntries(id) { return this.q.get(id) ?? []; }
  spawn(opts) { this.setLive(opts.sessionId); this.setBusy(opts.sessionId); }
  stop(id) { this.setLive(id, false); }
  isAlive(id) { return this.live.has(id); }
}

const db = new Db();
const proj = `rgh2-proj-${sfx}`, agent = `rgh2-ag-${sfx}`;
db.insertProject({ id: proj, name: proj, repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agent, projectId: proj, name: "t", startupPrompt: "BRIEF", position: 0 });
const mkSession = (o) => db.insertSession({
  id: o.id, projectId: proj, agentId: agent, engineSessionId: `eng-${o.id}`, title: null, cwd: os.tmpdir(),
  processState: o.processState ?? "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: o.role ?? null, parentSessionId: o.parentSessionId ?? null, taskId: o.taskId ?? null,
  worktreePath: o.worktreePath ?? null, branch: o.branch ?? null, recycledFrom: o.recycledFrom ?? null, gen: o.gen ?? 0,
});

try {
  const pty = new PtyStub();
  const sessions = new SessionService(db, pty, new OrchestrationControl());
  const mgr = `rgh2-mgr-${sfx}`, wkr = `rgh2-wkr-${sfx}`, task = `rgh2-task-${sfx}`;
  mkSession({ id: mgr, role: "manager" });
  mkSession({ id: wkr, role: "worker", parentSessionId: mgr, taskId: task, worktreePath: os.tmpdir(), branch: "loom/x" });
  pty.setLive(mgr); pty.setLive(wkr); pty.setBusy(wkr); // worker is mid-turn (holds)

  // A still-held give-up requeue sitting on the predecessor — exactly the shape `requeueGiveUpOrigin`
  // (host.ts) stamps: a future `giveUpHeldUntil` deadline, `kind:"agent"` (a real turn, not a nudge).
  const HELD_TEXT = "HELD_GIVE_UP_REQUEUE_ON_PREDECESSOR";
  const held = pty.enqueueStdin(wkr, HELD_TEXT, "system", undefined, undefined, "agent", undefined, undefined, undefined, undefined, Date.now() + 60_000);
  check("setup: the give-up-held entry queues on the busy predecessor", held.delivered === false);
  check("setup: the predecessor's own queued entry DOES carry the hold (sanity: the stub round-trips it)", pty.pendingEntries(wkr)[0]?.giveUpHeldUntil > Date.now());

  // An ordinary (never-held) entry sits behind it, for contrast — both should carry across; only the hold
  // itself is the thing under test.
  const PLAIN_TEXT = "ORDINARY_QUEUED_NUDGE";
  pty.enqueueStdin(wkr, PLAIN_TEXT, "system", undefined, undefined, "agent");

  const fresh = await sessions.recycleWorker(mgr, wkr, "continue building X; the held entry should land unheld");

  const successorEntries = pty.pendingEntries(fresh.id);
  const successorHeld = successorEntries.find((m) => m.text === HELD_TEXT);
  const successorPlain = successorEntries.find((m) => m.text === PLAIN_TEXT);

  check("DELIVER, not hold: the carried entry reaches the successor", !!successorHeld);
  check(
    "DELIVER, not hold: the successor's copy carries NO giveUpHeldUntil — carryPendingToSuccessor deliberately drops it (card f25bf3bf)",
    successorHeld?.giveUpHeldUntil === undefined,
  );
  check("DELIVER, not hold: the kind classification still carries across (only the hold is dropped)", successorHeld?.kind === "agent");
  check("the ordinary entry behind it carries across too, unaffected", !!successorPlain && successorPlain.giveUpHeldUntil === undefined);
  check("the predecessor's queue was FLUSHED (empty)", pty.getPending(wkr).length === 0);

  db.close();
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — recycleWorker's carry (SessionService.carryPendingToSuccessor) delivers a still-held give-up requeue onto the fresh successor WITHOUT its hold — deliberate (card f25bf3bf): a recycle successor never shares the predecessor's transcript, so there is no duplicate for a held entry to confuse, and the hold's purge could never fire on a fresh successor anyway."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
