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
} finally {
  try { db.close(); } catch { /* ignore */ }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — carryPendingToSuccessor now mints the successor's copy FIRST and resolves the predecessor's old record only once that mint succeeds; a failed mint leaves the old record genuinely unresolved AND re-arms it on the predecessor's own live queue, never silently superseded with nothing left to deliver it — and the sibling record that mints cleanly is unaffected."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
