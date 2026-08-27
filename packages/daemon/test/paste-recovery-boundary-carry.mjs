import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1)
// Regression test for card 1c47454b — "a redelivery frame asserts 'you have not seen this' — false for
// ANY consumed message, EITHER direction, to workers AND managers".
//
// DoD-1 established (proof by construction, not a probe): a still-pending `[loom:paste-recovery]` notice
// CAN reach a session across BOTH a `worker_recycle`/`recycleManager` AND a `daemon_restart` — but at
// BOTH boundaries, the CARRY call site silently drops the notice's age evidence:
//   - `SessionService.carryPendingToSuccessor`'s non-durable branch re-enqueues onto the successor with
//     only {text, source, kind} — `mintedAtGen` never threaded through.
//   - The restart replay (`SessionService.resumeFleetOnBoot`'s `replayPending`) re-enqueues via
//     `getPersistablePendingSnapshot`, which was a deliberately bare `{texts, holds}` — no age field at
//     all.
//
// THE FIX carries a DIFFERENT field across the boundary than the one that was missing, because
// `mintedAtGen` itself is UNIT-INCOMPATIBLE across a session boundary: `Live.submitGeneration` restarts
// at 0 for every fresh `Live` (a recycle successor, a restarted-and-resumed session), so a predecessor's
// generation count (e.g. 47) compared against a successor's own counter (0) is not "47 generations ago"
// — it's a unit error that (if threaded verbatim) reads as "nothing to disclose yet" and silently
// reproduces the EXACT bug this card exists to close. The fix instead carries `mintedAtWallClock` (an
// absolute `Date.now()`, stamped alongside `mintedAtGen` at mint time) across the boundary, and
// DELIBERATELY OMITS `mintedAtGen` when doing so — see `QueuedMessage.mintedAtGen`/`mintedAtWallClock`'s
// own docs (pty/host.ts) for the full reasoning.
//
// THIS FILE proves the CARRY PLUMBING at all three sites threads `mintedAtWallClock` through and OMITS
// `mintedAtGen` — i.e. that `carryPendingToSuccessor`/`replayPending` produce EXACTLY the parameter shape
// `annotatePasteRecoveryAge` needs to render its cross-boundary disclosure (proven separately, against the
// REAL PtyHost's rendering, in paste-recovery-boundary-annotation.mjs — that file constructs the identical
// post-carry shape this one proves is what actually gets produced, and shows the annotation is ABSENT
// before this fix and PRESENT after).
//
// (1) recycleWorker — the manager→worker direction (Instance 1 of card 1c47454b: the notice sat in a
//     WORKER's own queue, carrying an INSTRUCTION). Uses the SAME PtyStub-based service-level harness as
//     recycle-giveup-hold.mjs (contract-faithful up through `mintedAtGen`/`mintedAtWallClock`, the two new
//     positional params) — the recycle.mjs integration test covers the real-claude end-to-end.
// (2) recycleManager — the worker→manager direction (Instance 2: the notice sat in a MANAGER's own queue,
//     carrying a worker REPORT). SAME PtyStub harness, SAME shared `carryPendingToSuccessor` code path —
//     proven with its OWN explicit scenario per this card's own instinct not to assume "same function ⇒
//     same behavior" for the two directions.
// (3) daemon restart — role-agnostic (any live session). Round-trips through the REAL on-disk intent file
//     (writeRestartIntent/readRestartIntent, not a hand-rolled JSON.stringify) and the REAL
//     resumeFleetOnBoot replay path, mirroring restart-giveup-hold.mjs's proven pattern.
//
// Run: 1) build daemon, 2) node test/paste-recovery-boundary-carry.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-prbc-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const restart = await import("../dist/orchestration/restart.js");
const { buildPasteRecoveryText, PASTE_RECOVERY_TAG } = await import("../dist/orchestration/paste-tripwire.js");
const { CLEAN_STALENESS } = await import("./_deploy-staleness-fixture.mjs");

const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// The real 0-vs-47 case, per manager directive: the predecessor minted at a HIGH generation; any
// successor's own `submitGeneration` (recycle: 0; restart-resumed: 0) is always LOWER — that mismatch is
// exactly why `mintedAtGen` must never be the field that crosses.
const PREDECESSOR_MINTED_GEN = 47;

// Mirrors recycle-giveup-hold.mjs's PtyStub, extended to also record `mintedAtGen`/`mintedAtWallClock`
// (the two new trailing positional params `enqueueStdin` grew for this card) through exactly like
// host.ts's real QueuedMessage — flushPending returns the full held entry, onDeliver included.
class PtyStub {
  constructor() { this.q = new Map(); this.live = new Set(); this.busy = new Set(); }
  setLive(id, on = true) { if (on) this.live.add(id); else { this.live.delete(id); this.busy.delete(id); } }
  setBusy(id, on = true) { if (on) this.busy.add(id); else this.busy.delete(id); }
  // Card 3f09f9ce: position 11 also accepts the real enqueueStdin's options-object tail overload
  // (production's `carryPendingToSuccessor` migrated to it) — discriminate by shape, same as the real
  // implementation, so BOTH this file's own old-style positional setup calls (still valid — the overload
  // is additive) and the production-driven options-object call land `mintedAtGen`/`mintedAtWallClock`
  // correctly below (the only two tail fields this stub's delivery logic actually reads).
  enqueueStdin(id, text, source = "system", onDeliver, route, kind, questionId, ownerText, proactive, senderId, tail, _onGiveUpExhausted, _logicalId, mintedAtGenPositional, mintedAtWallClockPositional) {
    const isTailObject = typeof tail === "object" && tail !== null;
    const mintedAtGen = isTailObject ? tail.mintedAtGen : mintedAtGenPositional;
    const mintedAtWallClock = isTailObject ? tail.mintedAtWallClock : mintedAtWallClockPositional;
    if (!this.live.has(id)) return { delivered: false };
    if (!this.busy.has(id)) { const a = this.q.get(id) ?? []; a.push({ id: `d-${a.length}`, text, source, delivered: true }); this.q.set(id, a); return { delivered: true }; }
    const a = this.q.get(id) ?? []; a.push({ id: `qm-${a.length}`, text, source, onDeliver, kind, mintedAtGen, mintedAtWallClock }); this.q.set(id, a);
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
const proj = `prbc-proj-${sfx}`, agent = `prbc-ag-${sfx}`;
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

  // ===================== (1) recycleWorker — manager→worker direction ===================================
  {
    const mgr = `prbc-mgr1-${sfx}`, wkr = `prbc-wkr1-${sfx}`, task = `prbc-task1-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: wkr, role: "worker", parentSessionId: mgr, taskId: task, worktreePath: os.tmpdir(), branch: "loom/x" });
    pty.setLive(mgr); pty.setLive(wkr); pty.setBusy(wkr); // worker is mid-turn (holds)

    const RECOVERY_TEXT = buildPasteRecoveryText("the lost instruction content");
    const MINTED_WALLCLOCK = Date.now() - 5 * 60_000; // minted 5 minutes ago, on the predecessor
    const held = pty.enqueueStdin(
      wkr, RECOVERY_TEXT, "system", undefined, undefined, "agent",
      undefined, undefined, undefined, undefined, undefined, undefined, randomUUID(),
      PREDECESSOR_MINTED_GEN, MINTED_WALLCLOCK,
    );
    check("(1) setup: the paste-recovery notice queues on the busy predecessor worker", held.delivered === false);
    check("(1) setup: the predecessor's own queued entry carries BOTH mintedAtGen and mintedAtWallClock (sanity: the stub round-trips them)",
      pty.pendingEntries(wkr)[0]?.mintedAtGen === PREDECESSOR_MINTED_GEN && pty.pendingEntries(wkr)[0]?.mintedAtWallClock === MINTED_WALLCLOCK);

    const fresh = await sessions.recycleWorker(mgr, wkr, "continue building X; the recovery notice should carry its age evidence");
    const carried = pty.pendingEntries(fresh.id).find((m) => m.text === RECOVERY_TEXT);

    check("(1) THE FIX: the carried entry reaches the successor worker", !!carried);
    check("(1) THE FIX: mintedAtWallClock SURVIVES the carry, unchanged", carried?.mintedAtWallClock === MINTED_WALLCLOCK);
    check("(1) THE FIX: mintedAtGen is DELIBERATELY DROPPED (a successor's own generation counter restarts at 0 — carrying 47 across would be a unit error, not evidence)",
      carried?.mintedAtGen === undefined);
    check("(1) the predecessor's queue was flushed (empty)", pty.getPending(wkr).length === 0);
  }

  // ===================== (2) recycleManager — worker→manager direction ===================================
  {
    const mgr = `prbc-mgr2-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    pty.setLive(mgr); pty.setBusy(mgr); // manager is mid-turn (holds)

    const RECOVERY_TEXT = buildPasteRecoveryText("the lost worker-report content");
    const MINTED_WALLCLOCK = Date.now() - 12 * 60_000; // minted 12 minutes ago, on the predecessor manager
    const held = pty.enqueueStdin(
      mgr, RECOVERY_TEXT, "system", undefined, undefined, "agent",
      undefined, undefined, undefined, undefined, undefined, undefined, randomUUID(),
      PREDECESSOR_MINTED_GEN, MINTED_WALLCLOCK,
    );
    check("(2) setup: the paste-recovery notice queues on the busy predecessor manager", held.delivered === false);

    const fresh = await sessions.recycleManager(mgr, "continuing the fleet; the recovery notice should carry its age evidence");
    const carried = pty.pendingEntries(fresh.id).find((m) => m.text === RECOVERY_TEXT);

    check("(2) THE FIX: the carried entry reaches the successor manager (SAME shared carryPendingToSuccessor as (1), proven with its own explicit scenario rather than assumed)",
      !!carried);
    check("(2) THE FIX: mintedAtWallClock SURVIVES the carry, unchanged", carried?.mintedAtWallClock === MINTED_WALLCLOCK);
    check("(2) THE FIX: mintedAtGen is DELIBERATELY DROPPED, same reasoning as (1)", carried?.mintedAtGen === undefined);
    check("(2) the predecessor's queue was flushed (empty)", pty.getPending(mgr).length === 0);
  }

  db.close();
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ===================== (3) daemon restart — role-agnostic, via the REAL on-disk intent + real ============
// ===================== resumeFleetOnBoot replay path (mirrors restart-giveup-hold.mjs) =====================
{
  const tmpHome3 = path.join(os.tmpdir(), `loom-prbc3-${Date.now()}-${process.pid}`);
  fs.mkdirSync(path.join(tmpHome3, "logs"), { recursive: true });
  process.env.LOOM_HOME = tmpHome3;

  try {
    const fakesPre = [];
    function decorateSilentFakePty(base, fakes) {
      const writes = [];
      const fake = { ...base, write: (d) => { writes.push(d); }, writes };
      fakes.push(fake);
      return fake;
    }
    class PreHost extends createSeamHost(PtyHost) { createPty(opts) { return decorateSilentFakePty(super.createPty(opts), fakesPre); } }
    const hostPre = new PreHost({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} });

    const SID3 = `prbc3-sess-${sfx}`;
    const RECOVERY_TEXT = buildPasteRecoveryText("the lost content, surviving a daemon restart");
    const MINTED_WALLCLOCK = Date.now() - 8 * 60_000;

    hostPre.spawn({
      sessionId: SID3, cwd: tmpHome3,
      permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
      geometry: { cols: 120, rows: 40 }, sessionEnv: {},
    });
    hostPre.deliverHook(SID3, { hook_event_name: "SessionStart" });
    hostPre.enqueueStdin(SID3, "[loom:test] setup turn"); // idle immediate-submit; occupies the session
    const held = hostPre.enqueueStdin(
      SID3, RECOVERY_TEXT, "system", undefined, undefined, "agent",
      undefined, undefined, undefined, undefined, undefined, undefined, randomUUID(),
      PREDECESSOR_MINTED_GEN, MINTED_WALLCLOCK,
    );
    check("(3) setup: the recovery notice queues (HELD) behind the in-flight setup turn", held.delivered === false && held.queued === true);

    // ------- getPersistablePendingSnapshot's THIRD field: mintedAt, additive alongside holds -------
    // The setup turn delivered IMMEDIATELY (idle, first enqueue) — it's already an in-flight turn, never
    // queued, so it does NOT appear in `texts` at all (getPersistablePendingSnapshot only ever sees
    // `live.pending`, not what's already been handed to submit()). The recovery notice is the ONLY
    // queued entry, at index 0.
    const { texts: rawTexts, holds: rawHolds, mintedAt: rawMintedAt } = hostPre.getPersistablePendingSnapshot(SID3);
    check("(3) getPersistablePendingSnapshot: texts carries the one still-queued entry (the recovery notice)",
      rawTexts.length === 1 && rawTexts[0] === RECOVERY_TEXT);
    check("(3) getPersistablePendingSnapshot: mintedAt keys the recovery notice's index (0) with its wall-clock stamp",
      rawMintedAt[0] === MINTED_WALLCLOCK && Object.keys(rawMintedAt).length === 1);
    check("(3) getPersistablePendingSnapshot: holds is untouched by this fix (nothing give-up-held here)",
      Object.keys(rawHolds).length === 0);

    // ------- round-trip through the REAL on-disk intent file -------
    const mgrId3 = `prbc3-mgr-${sfx}`;
    restart.writeRestartIntent({
      reason: "deploy merged daemon code", managerSessionId: mgrId3, requestedAt: now,
      resume: [{ sessionId: mgrId3, role: "auditor", parentSessionId: null }, { sessionId: SID3, role: "auditor", parentSessionId: null }],
      pending: { [SID3]: rawTexts },
      pendingHolds: { [SID3]: rawHolds },
      pendingMintedAt: { [SID3]: rawMintedAt },
    });
    const onDisk = restart.readRestartIntent();
    check("(3) on-disk pendingMintedAt round-trips, same index/value", onDisk.pendingMintedAt[SID3][0] === MINTED_WALLCLOCK);
    restart.clearRestartIntent();

    try { hostPre.stop(SID3, "hard"); } catch { /* ignore */ }

    // ------- THE FIX, through the REAL resumeFleetOnBoot replay path -------
    const fakesPost = [];
    class PostHost extends createSeamHost(PtyHost) { createPty(opts) { return decorateSilentFakePty(super.createPty(opts), fakesPost); } }
    const hostPost = new PostHost({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} });

    const db3 = new Db();
    const proj3 = `prbc3-proj-${sfx}`, agent3 = `prbc3-ag-${sfx}`;
    db3.insertProject({ id: proj3, name: proj3, repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
    db3.insertAgent({ id: agent3, projectId: proj3, name: "t", startupPrompt: "", position: 0 });
    db3.insertSession({ id: mgrId3, projectId: proj3, agentId: agent3, engineSessionId: null, title: null, cwd: os.tmpdir(), processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "auditor", parentSessionId: null });
    db3.insertSession({ id: SID3, projectId: proj3, agentId: agent3, engineSessionId: null, title: null, cwd: os.tmpdir(), processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "auditor", parentSessionId: null });

    const sessions3 = new SessionService(db3, hostPost, new OrchestrationControl());
    const intent = {
      reason: "deploy merged daemon code", managerSessionId: mgrId3, requestedAt: now,
      resume: [
        { sessionId: mgrId3, role: "auditor", parentSessionId: null, busy: false },
        { sessionId: SID3, role: "auditor", parentSessionId: null, busy: false },
      ],
      pending: { [SID3]: rawTexts },
      pendingMintedAt: { [SID3]: rawMintedAt },
    };
    hostPost.spawn({
      sessionId: SID3, cwd: tmpHome3,
      permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
      geometry: { cols: 120, rows: 40 }, sessionEnv: {},
    }); // NOT ready yet — mirrors a freshly re-spawned, not-yet-booted resumed pty

    const result = sessions3.resumeFleetOnBoot(intent, { resumeOne: () => true, deployStaleness: CLEAN_STALENESS });
    check("(3) setup: both sessions resumed, none failed", result.resumed.length === 2 && result.failed.length === 0);

    const replayed = hostPost.getPendingEntries(SID3).find((m) => m.text === RECOVERY_TEXT);
    check("(3) THE FIX: the replayed recovery entry carries mintedAtWallClock across the restart", replayed?.mintedAtWallClock === MINTED_WALLCLOCK);
    check("(3) THE FIX: mintedAtGen is DELIBERATELY DROPPED across a restart too (the resumed session's own submitGeneration restarts at 0)",
      replayed?.mintedAtGen === undefined);

    try { hostPost.stop(SID3, "hard"); } catch { /* ignore */ }
    db3.close();
  } finally {
    try { fs.rmSync(tmpHome3, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a still-pending paste-recovery notice's mintedAtWallClock survives all three carry sites (recycleWorker's manager→worker direction, recycleManager's worker→manager direction, and a daemon_restart round-tripped through the real on-disk intent + resumeFleetOnBoot replay), while mintedAtGen is deliberately dropped at every one of them — a predecessor's generation count would be a unit error against a fresh successor's own counter, which always restarts at 0."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
