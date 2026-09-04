import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 4d9f7471: `carryPendingToSuccessor` (sessions/service.ts) drops fields on BOTH its carry loops.
//
//   (Q) NON-DURABLE loop (the `flushed` loop, `m.onDeliver` unset): re-enqueues each held entry onto the
//       successor via a bare `pty.enqueueStdin(...)` call that hardcoded `questionId` to `undefined`, even
//       though `m.questionId` exists on the carried `QueuedMessage`. A still-queued answered-question nudge
//       that survives to a recycle silently lost its tag, so `purgeQueuedByQuestionIds` could never match
//       it on the successor.
//
//   (K)/(R) DURABLE loop (the `durableRecords` loop): re-mints each unresolved `session_message_queued`
//       record via `enqueueDurableMessage`, which defaults `kind` to "agent" and self-roots `rootMsgId`/
//       `chainDepth` to 0 whenever its `ctx` doesn't supply them — and this loop never read them back off
//       `rec.detail`, even though `enqueueDurableMessage`'s own persistence (and the `session_message_gave_up`
//       link event a few lines below THIS exact loop) already reads/writes those same fields. A still-
//       unresolved `kind:"warning"` durable record (settle/watchdog/give-up nudges) silently flipped to
//       one-per-turn "agent" delivery on the successor (K); a re-minted record's give-up-chain lineage was
//       severed, self-rooted at depth 0, breaking `resolveDirectiveOutcome`'s chain-walk (R).
//
// Two distinct harms per the card's own DoD-6 — asserted as THREE separate RED-before-GREEN checks below:
// (Q) delivery-shape (questionId), (K) delivery-shape (kind), (R) identity/audit (rootMsgId/chainDepth).
// `chainDepth` is carried VERBATIM (not `+1` like a give-up re-mint) — a recycle is a lifecycle event, not
// a delivery failure, so it must not spend the give-up budget (see service.ts's own comment at the fix).
//
// HERMETIC — a REAL PtyHost (fake pty backend) driving a REAL Db + SessionService, mirroring
// worker-report-nudge-purge.mjs's own recycle-carry specimen. No real claude, no network, no live daemon.
//
// Run: 1) build (turbo builds shared first), 2) node test/carry-pending-to-successor-dropped-fields.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Hermetic LOOM_HOME (host.ts opens a per-session log under $LOOM_HOME/logs in spawn()) — set BEFORE
// importing host.js, since paths.ts reads LOOM_HOME at import time.
const tmpHome = path.join(os.tmpdir(), `loom-carry-dropped-fields-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

const fakes = [];
class TestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    const base = super.createPty(opts);
    const writes = [];
    const fake = { ...base, write: (d) => { writes.push(d); }, writes };
    fakes.push(fake);
    return fake;
  }
}
const events = { onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} };

const dbFile = path.join(tmpHome, "cpdf.db");
const db = new Db(dbFile);
const now = new Date().toISOString();
const projId = "cpdf-proj", agentId = "cpdf-agent";
db.insertProject({ id: projId, name: "CPDF", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agentId, projectId: projId, name: "Manager", startupPrompt: "", position: 0 });

function insertSession(id, opts) {
  db.insertSession({
    id, projectId: projId, agentId, engineSessionId: `eng-${id}`, title: null, cwd: projId,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, ...opts,
  });
}

const host = new TestPtyHost(events);
function spawnReady(sessionId) {
  host.spawn({
    sessionId, cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  host.deliverHook(sessionId, { hook_event_name: "SessionStart" }); // mark ready (startupModeCycles:0 -> synchronous)
}

const sessions = new SessionService(db, host, new OrchestrationControl());

try {
  // ============================ (Q) NON-DURABLE loop: questionId survives the recycle carry ============================
  {
    const mgrId = "q-mgr";
    insertSession(mgrId, { role: "manager" });
    spawnReady(mgrId);

    const primer = host.enqueueStdin(mgrId, "PRIMER"); // idle -> delivers now, arms busy so the rest QUEUE
    check("(Q) setup: primer delivered + armed busy", primer.delivered === true);

    // A decision-inbox answer-push nudge — mirrors gateway/server.ts:5514's real shape exactly (bare
    // enqueueStdin, questionId in the 7th positional, no onDeliver -> non-durable).
    const qid = "q-answered-question-1";
    const held = host.enqueueStdin(mgrId, "ANSWERED-Q-NUDGE", "human", undefined, undefined, "agent", qid);
    check("(Q) setup: the questionId nudge is HELD (busy), not delivered now", held.delivered === false);
    check("(Q) setup: it sits in the predecessor's live pending queue before recycle", host.getPending(mgrId).some((t) => t.includes("ANSWERED-Q-NUDGE")));

    const fresh = await sessions.recycleManager(mgrId, "successor: drain the queue");
    check("(Q) setup: the carried nudge lands on the successor's live queue", host.getPending(fresh.id).some((t) => t.includes("ANSWERED-Q-NUDGE")));

    // THE FIX: if `m.questionId` survived the carry, purgeQueuedByQuestionIds can find and drop it by that
    // id on the SUCCESSOR — before the fix this returns [] (nothing tagged `qid` exists there) and the
    // nudge would still be sitting in the queue afterward, exactly the wasted-turn defect the card reports.
    const purged = host.purgeQueuedByQuestionIds(fresh.id, [qid]);
    check("(Q) THE FIX: purgeQueuedByQuestionIds matches the carried entry by its ORIGINAL questionId", purged.length === 1 && purged[0].text.includes("ANSWERED-Q-NUDGE"));
    check("(Q) THE FIX: the carried nudge is now gone from the successor's queue", !host.getPending(fresh.id).some((t) => t.includes("ANSWERED-Q-NUDGE")));
  }

  // ============================ (K) DURABLE loop: kind:"warning" survives the recycle re-mint ============================
  {
    const mgrId = "k-mgr";
    insertSession(mgrId, { role: "manager" });
    spawnReady(mgrId);

    // Seed a durable `session_message_queued` record exactly as `enqueueDurableMessage`'s own persistence
    // would (service.ts ~8656-8661) — a still-unresolved kind:"warning" settle/watchdog-style nudge held
    // for this manager, with no session_message_delivered marker yet.
    const msgId = randomUUID();
    db.appendEvent({
      id: randomUUID(), ts: now, managerSessionId: "system", workerSessionId: mgrId, taskId: null,
      kind: "session_message_queued",
      detail: { msgId, text: "KIND-WARNING-SURVIVOR", sender: "system", kind: "warning", rootMsgId: msgId, chainDepth: 0 },
    });
    check("(K) setup: the warning-kind durable record is unresolved before recycle", db.listUnresolvedQueuedMessagesForWorker(mgrId).some((e) => e.detail?.msgId === msgId));

    const fresh = await sessions.recycleManager(mgrId, "successor: drain the durable queue");

    // THE FIX: the re-minted record on the successor must still carry kind:"warning" — before the fix,
    // `enqueueDurableMessage`'s own default (`ctx.kind ?? "agent"`) silently reclassifies it to "agent".
    const remintedRec = db.listUnresolvedQueuedMessagesForWorker(fresh.id).find((e) => e.detail?.text === "KIND-WARNING-SURVIVOR");
    check("(K) THE FIX: a re-minted durable record exists on the successor", !!remintedRec);
    check("(K) THE FIX: it is STILL kind:\"warning\", not silently reclassified to \"agent\"", remintedRec?.detail?.kind === "warning");
  }

  // ============================ (R) DURABLE loop: rootMsgId/chainDepth survive the recycle re-mint (verbatim) ============
  {
    const mgrId = "r-mgr2";
    insertSession(mgrId, { role: "manager" });
    spawnReady(mgrId);

    // A give-up chain already TWO re-mints deep (chainDepth:2) before this recycle — its lineage is the
    // thing `resolveDirectiveOutcome`'s chain-walk must still be able to hop through afterward.
    const originalRootMsgId = "root-of-a-give-up-chain";
    const msgId = randomUUID();
    db.appendEvent({
      id: randomUUID(), ts: now, managerSessionId: "system", workerSessionId: mgrId, taskId: null,
      kind: "session_message_queued",
      detail: { msgId, text: "CHAIN-LINEAGE-SURVIVOR", sender: "system", kind: "agent", rootMsgId: originalRootMsgId, chainDepth: 2 },
    });
    check("(R) setup: the depth-2 durable record is unresolved before recycle", db.listUnresolvedQueuedMessagesForWorker(mgrId).some((e) => e.detail?.msgId === msgId));

    const fresh = await sessions.recycleManager(mgrId, "successor: drain the durable queue");

    // THE FIX: the re-minted record must carry the SAME rootMsgId and chainDepth (VERBATIM, not +1) —
    // before the fix, `enqueueDurableMessage`'s own default self-roots at THIS msgId (a fresh chain) and
    // resets chainDepth to 0, severing the lineage and silently refilling the give-up budget.
    const remintedRec = db.listUnresolvedQueuedMessagesForWorker(fresh.id).find((e) => e.detail?.text === "CHAIN-LINEAGE-SURVIVOR");
    check("(R) THE FIX: a re-minted durable record exists on the successor", !!remintedRec);
    check("(R) THE FIX: rootMsgId is carried VERBATIM (chain lineage intact)", remintedRec?.detail?.rootMsgId === originalRootMsgId);
    check("(R) THE FIX: chainDepth is carried VERBATIM at 2, not reset to 0 and not bumped to 3", remintedRec?.detail?.chainDepth === 2);
  }
} finally {
  try { db.close(); } catch { /* ignore */ }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — carryPendingToSuccessor's non-durable loop now carries `m.questionId` through its bare enqueueStdin re-enqueue (an answered-question nudge survives a recycle taggable), and its durable loop now reads `kind`/`rootMsgId`/`chainDepth` back off the superseded record before re-minting (a warning-kind nudge stays warning-kind; a give-up chain's lineage and remaining budget survive a recycle intact, verbatim, never bumped)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
