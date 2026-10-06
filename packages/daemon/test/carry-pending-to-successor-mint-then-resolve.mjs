import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card f1969787 (Code Review of 2fd55955, landed as 82b68e28): `carryPendingToSuccessor`'s durable
// re-mint loop used to resolve EVERY flushed durable entry "superseded" in its OWN earlier pass (the
// `flushed` loop, firing `m.onDeliver("superseded")` unconditionally) BEFORE the re-mint loop (driven by
// `durableRecords`) ever ran. So a record whose re-mint onto the successor then failed still had its OLD
// copy marked resolved, with no live successor copy to replace it — a genuine, silent loss: the old
// record reads "delivered" (superseded), the new one was never minted, and nothing anywhere still owns
// the message.
//
// Proves, for a durable record whose re-mint onto the successor THROWS:
//   (1) NO copy lands on the successor (a half-failed mint never produces a phantom successor record).
//   (2) the OLD record on the PREDECESSOR is NOT marked superseded/resolved — it stays genuinely
//       unresolved (`listUnresolvedQueuedMessagesForWorker` still returns it).
//   (3) it is RE-ARMED directly on the predecessor's own live pty queue — "unresolved" alone is not
//       "deliverable" unless something is actually driving its delivery; this is that something.
//   (4) `carryPendingToSuccessor`'s own `failedRefs` names the real msgId that didn't make it.
//   (5) a SIBLING record (no injected failure) still re-mints + supersedes normally — the fix does not
//       regress the ordinary case.
//   (6) `recycleManager` (the real caller) never throws over this partial failure, and correctly HALTS
//       (per this card's own halt-not-retire branch) rather than retiring the predecessor, since a
//       message genuinely failed to transfer.
//
// A SECOND scenario (card 796221c9 item 1) covers the catch block's OWN untested branch: a re-mint
// failure's rearm, `if (rRearm.delivered) this.resolveQueuedMessage(oldMsgId, ...)`, when the predecessor
// is live, IDLE, and has an EMPTY queue at that exact moment — rather than BUSY throughout, as above. The
// rearm then takes enqueueStdin's IMMEDIATE branch, which (decision 2ca18433) never fires `onDeliver`, so
// the fix must resolve the old record itself; RAN RED (deleting that one `if` line reproduces the old
// record staying unresolved forever) before this scenario was added — see the worker_report for this card.
//
// HERMETIC — a REAL PtyHost (fake pty backend) driving a REAL Db + SessionService, mirroring
// carry-pending-to-successor-dropped-fields.mjs's own established harness. No real claude, no network,
// no live daemon.
//
// Run: 1) build (turbo builds shared first), 2) node test/carry-pending-to-successor-mint-then-resolve.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-cpmtr-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

class TestPtyHost extends createSeamHost(PtyHost) {}
const events = { onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} };

const dbFile = path.join(tmpHome, "cpmtr.db");
const db = new Db(dbFile);
const now = new Date().toISOString();
const projId = "cpmtr-proj", agentId = "cpmtr-agent";
db.insertProject({ id: projId, name: "CPMTR", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
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
  const mgrId = "mtr-mgr";
  insertSession(mgrId, { role: "manager" });
  spawnReady(mgrId);

  // Idle -> delivers immediately and arms busy, so every subsequent enqueue HOLDS (both in-memory AND,
  // via enqueueDurableMessage, a durable session_message_queued record) — the exact dual shape the
  // original defect needs: present in BOTH the `flushed` in-memory loop AND the `durableRecords` DB loop.
  const primer = host.enqueueStdin(mgrId, "PRIMER");
  check("setup: primer delivered immediately + armed busy", primer.delivered === true);

  const controlMint = sessions.enqueueDurableMessage(mgrId, "CONTROL-SHOULD-REMINT", { sender: "system" });
  check("setup: the CONTROL durable message is HELD (busy), not delivered now", controlMint.delivered === false);
  const failMint = sessions.enqueueDurableMessage(mgrId, "FAIL-TO-REMINT-TARGET", { sender: "system" });
  check("setup: the TARGET durable message is HELD (busy), not delivered now", failMint.delivered === false);
  check("setup: both sit UNRESOLVED on the predecessor before recycle",
    db.listUnresolvedQueuedMessagesForWorker(mgrId).filter((e) => ["CONTROL-SHOULD-REMINT", "FAIL-TO-REMINT-TARGET"].includes(e.detail?.text)).length === 2);

  // Inject the re-mint failure AFTER seeding (so the seed calls above use the REAL, unpatched method) —
  // only the TARGET text throws; the CONTROL and the halt branch's own two nudges go through untouched.
  const originalEnqueueDurableMessage = SessionService.prototype.enqueueDurableMessage;
  let armed = true;
  SessionService.prototype.enqueueDurableMessage = function (recipientId, framedText, ctx) {
    if (armed && framedText === "FAIL-TO-REMINT-TARGET") throw new Error("injected re-mint failure (mint-then-resolve test)");
    return originalEnqueueDurableMessage.apply(this, arguments);
  };

  let fresh, thrown;
  try {
    try {
      fresh = await sessions.recycleManager(mgrId, "continuation — forcing one durable record's re-mint to fail");
    } catch (e) { thrown = e; }
    armed = false; // the halt branch's own two correction nudges (below) must re-mint normally

    check("(6) recycleManager does NOT throw over a partial carry failure", !thrown && !!fresh);

    // (1) no phantom copy on the successor for the one that failed to mint. (No deferred-dispatch wait
    // needed here — unlike the halt-scenario sibling test, this file never asserts on nudge TEXT content;
    // every check below reads state carryPendingToSuccessor/appendEvent already wrote SYNCHRONOUSLY
    // inside the awaited recycleManager call above.)
    const successorUnresolved = db.listUnresolvedQueuedMessagesForWorker(fresh.id);
    check("(1) the FAILED record never produced a copy on the successor",
      !successorUnresolved.some((e) => e.detail?.text === "FAIL-TO-REMINT-TARGET"));

    // (5) the sibling (control) record DID re-mint + supersede normally — no regression.
    check("(5) the CONTROL record's copy DOES exist on the successor (ordinary case unaffected)",
      successorUnresolved.some((e) => e.detail?.text === "CONTROL-SHOULD-REMINT"));
    const predecessorUnresolved = db.listUnresolvedQueuedMessagesForWorker(mgrId);
    check("(5) the CONTROL record's OLD copy IS resolved (superseded) on the predecessor",
      !predecessorUnresolved.some((e) => e.detail?.text === "CONTROL-SHOULD-REMINT"));

    // (2) THE FIX ITSELF: the FAILED record's old copy is NOT marked superseded — it stays unresolved.
    check("(2) THE FIX: the FAILED record's OLD copy on the predecessor is STILL UNRESOLVED, not wrongly superseded",
      predecessorUnresolved.some((e) => e.detail?.text === "FAIL-TO-REMINT-TARGET"));

    // (3) THE FIX: it was re-armed on the predecessor's own live pty — not just an inert DB row.
    check("(3) THE FIX: the FAILED record is RE-ARMED on the predecessor's own live pending queue (actually deliverable)",
      host.getPending(mgrId).some((t) => t.includes("FAIL-TO-REMINT-TARGET")));

    // (4) failedRefs names it — re-derive directly (recycleManager's own halt detail carries it too).
    const failedEvent = db.listEventsForSession(fresh.id).find((e) => e.kind === "recycle_ownership_transfer_failed");
    check("(4) recycle_ownership_transfer_failed.detail.failedMessageRefs names the real msgId that didn't transfer",
      Array.isArray(failedEvent?.detail?.failedMessageRefs) && failedEvent.detail.failedMessageRefs.length === 1
      && failedEvent.detail.failedMessageRefs[0] === predecessorUnresolved.find((e) => e.detail?.text === "FAIL-TO-REMINT-TARGET")?.detail?.msgId);
    check("(4) recycle_ownership_transfer_failed.detail.failedSteps names pendingQueueCarry",
      Array.isArray(failedEvent?.detail?.failedSteps) && failedEvent.detail.failedSteps.includes("pendingQueueCarry"));

    // (6) the predecessor was correctly HALTED, not retired, over this partial carry failure.
    check("(6) the predecessor stays genuinely live (halted, not retired)", db.getSession(mgrId)?.processState === "live");
  } finally {
    SessionService.prototype.enqueueDurableMessage = originalEnqueueDurableMessage;
  }

  // ===================== SECOND SCENARIO (card 796221c9 item 1): the re-mint fails while the predecessor
  // ===================== is live, IDLE, with an EMPTY queue — the untested branch of the catch block's own
  // ===================== `if (rRearm.delivered) this.resolveQueuedMessage(...)` rearm (service.ts, just
  // ===================== after the failed `enqueueDurableMessage` call above). The scenario above keeps the
  // ===================== predecessor BUSY throughout, so its rearm always HOLDS (`rRearm.delivered` is
  // ===================== false) — this drives it to genuinely idle first, so the rearm takes enqueueStdin's
  // ===================== IMMEDIATE branch instead, which (decision 2ca18433) never fires `onDeliver` — the
  // ===================== fix must resolve the old record itself, right there, or it would stay unresolved
  // ===================== forever despite having genuinely been handed off.
  {
    const mgrId2 = "mtr-mgr-idle";
    insertSession(mgrId2, { role: "manager" });
    spawnReady(mgrId2);

    const primer2 = host.enqueueStdin(mgrId2, "PRIMER2");
    check("(idle-rearm) setup: primer delivered immediately + arms busy", primer2.delivered === true && host.isBusy(mgrId2));

    const failMint2 = sessions.enqueueDurableMessage(mgrId2, "FAIL-TO-REMINT-IDLE-TARGET", { sender: "system" });
    check("(idle-rearm) setup: the TARGET durable message is HELD (busy), not delivered now", failMint2.delivered === false);
    const targetMsgId2 = db.listUnresolvedQueuedMessagesForWorker(mgrId2).find((e) => e.detail?.text === "FAIL-TO-REMINT-IDLE-TARGET")?.detail?.msgId;
    check("(idle-rearm) setup: the target's durable record is unresolved and its msgId is captured", typeof targetMsgId2 === "string");

    // Drain the live in-memory copy out of the queue WITHOUT delivering it — exactly what
    // attemptPendingQueueCarry's own flushLiveQueue does ahead of carryPendingToSuccessor. The durable
    // record stays unresolved in the DB since nothing has actually delivered it yet.
    host.flushPending(mgrId2);
    check("(idle-rearm) setup: the live queue is now empty (flushed, not drained)", host.getPending(mgrId2).length === 0);

    // Complete the primer's own turn: with the queue already empty, drainPending finds nothing eligible to
    // drain, so busy genuinely clears and the predecessor goes idle — unlike the scenario above, which
    // never ends the primer's turn at all.
    host.deliverHook(mgrId2, { hook_event_name: "UserPromptSubmit" });
    host.deliverHook(mgrId2, { hook_event_name: "Stop" });
    check("(idle-rearm) setup: the predecessor is now LIVE, IDLE, with an EMPTY queue",
      !host.isBusy(mgrId2) && host.getPending(mgrId2).length === 0);
    check("(idle-rearm) setup: the target's durable record is STILL unresolved (nothing has delivered it yet)",
      db.listUnresolvedQueuedMessagesForWorker(mgrId2).some((e) => e.detail?.text === "FAIL-TO-REMINT-IDLE-TARGET"));

    let armed2 = true;
    SessionService.prototype.enqueueDurableMessage = function (recipientId, framedText, ctx) {
      if (armed2 && framedText === "FAIL-TO-REMINT-IDLE-TARGET") throw new Error("injected re-mint failure (idle-rearm test)");
      return originalEnqueueDurableMessage.apply(this, arguments);
    };
    let fresh2, thrown2;
    try {
      try {
        fresh2 = await sessions.recycleManager(mgrId2, "continuation — forcing the idle predecessor's re-mint to fail");
      } catch (e) { thrown2 = e; }
      armed2 = false;

      check("(idle-rearm) recycleManager does NOT throw over a partial carry failure", !thrown2 && !!fresh2);

      // THE FIX ITSELF: the re-mint failed, the catch block's rearm onto the now-idle predecessor took the
      // IMMEDIATE branch (rRearm.delivered === true) — and that immediate delivery must resolve the OLD
      // record right there, since the immediate branch never fires onDeliver (decision 2ca18433).
      check("(idle-rearm) THE FIX: the old record resolves even though it was rearmed via the IMMEDIATE (idle) branch",
        db.isQueuedMessageDelivered(targetMsgId2) === true);
      check("(idle-rearm) ... and listUnresolvedQueuedMessagesForWorker agrees — nothing left unresolved for this predecessor",
        !db.listUnresolvedQueuedMessagesForWorker(mgrId2).some((e) => e.detail?.text === "FAIL-TO-REMINT-IDLE-TARGET"));
      // Corroborates the rearm genuinely took the immediate branch (a fresh turn started), not the held
      // branch: busy is armed again for that fresh turn, and nothing sits in the live queue.
      check("(idle-rearm) ... corroborated: the rearm started a fresh turn (busy re-armed), nothing queued",
        host.isBusy(mgrId2) === true && host.getPending(mgrId2).length === 0);

      // No regression: the failed record never produced a phantom successor copy, and failedRefs still
      // names it — same shape as the busy-predecessor scenario above.
      const successorUnresolved2 = db.listUnresolvedQueuedMessagesForWorker(fresh2.id);
      check("(idle-rearm) the FAILED record never produced a copy on the successor",
        !successorUnresolved2.some((e) => e.detail?.text === "FAIL-TO-REMINT-IDLE-TARGET"));
      const failedEvent2 = db.listEventsForSession(fresh2.id).find((e) => e.kind === "recycle_ownership_transfer_failed");
      check("(idle-rearm) recycle_ownership_transfer_failed.detail.failedMessageRefs names the real msgId",
        Array.isArray(failedEvent2?.detail?.failedMessageRefs) && failedEvent2.detail.failedMessageRefs.includes(targetMsgId2));
    } finally {
      SessionService.prototype.enqueueDurableMessage = originalEnqueueDurableMessage;
    }
  }
} finally {
  try { db.close(); } catch { /* ignore */ }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — carryPendingToSuccessor now mints the successor's copy FIRST and resolves the predecessor's old record only once that mint succeeds; a failed mint leaves the old record genuinely unresolved AND re-arms it on the predecessor's own live queue, never silently superseded with nothing left to deliver it — and the sibling record that mints cleanly is unaffected. The idle-rearm scenario additionally proves that when the rearm lands on a now-idle, empty-queue predecessor (the immediate branch, which never fires onDeliver), the catch block resolves the old record itself rather than leaving it stuck."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
