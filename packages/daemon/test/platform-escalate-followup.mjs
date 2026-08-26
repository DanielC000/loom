import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 8636f761 (DoD-4) — `platform_escalate`'s explicit "follow up on <taskId>" affordance.
//
// BACKGROUND: same-title matching is a best-effort heuristic (title + severity + still-open-per-
// column) that silently STOPS matching the instant a Lead moves the target card to the terminal
// column — the automatic dedupe scan explicitly excludes a "resolved" (terminal-column) task
// (service.ts's `columnEscalationStatus(...) !== "resolved"` gate). The 2026-08-24 incident: a
// manager stated in writing "same title deliberately, so it lands on the existing thread" and still
// got a forked, unlinked card, because the Lead had closed the original two minutes earlier.
//
// `followUpOn` is the fix: an EXPLICIT taskId reference that appends UNCONDITIONALLY — even to a
// terminal-column target — and always tells the caller which outcome occurred via `outcome`/
// `followedUp`/`targetWasTerminal`, so same-title is never load-bearing again.
//
// Proves:
//   (1) ⭐ THE POSITIVE CONTROL THAT MATTERS: a same-title re-escalation with NO followUpOn, against a
//       TERMINAL-column target, still FORKS (documents the known heuristic limitation `followUpOn`
//       exists to route around — a regression here would silently "fix" the heuristic in a way the
//       tool description no longer describes).
//   (2) `followUpOn` against that SAME terminal-column target APPENDS instead of forking — the actual
//       fix — and reports outcome:"appended", followedUp:true, targetWasTerminal:true.
//   (3) `followUpOn` against a STILL-OPEN target also appends, with targetWasTerminal absent/false.
//   (4) an unknown/foreign-project `followUpOn` id is REJECTED with an error, nothing written.
//   (5) Card 772d15bd — `targetWasTerminal`'s downstream durability, on the exact no-live-Lead
//       (`deliveryStatus:"boarded"`) path this whole harness runs (SeamHost throws if enqueueStdin is
//       ever reached — there is no live Lead anywhere in this file): the `orchestration_event` detail
//       carries `followedUp`/`targetWasTerminal`, and the card body section heading for a reopened
//       CLOSED thread is textually distinguishable from the heading for the SAME append onto a
//       still-open thread. A test that only exercised a live-Lead nudge could never catch this — the
//       defect is specifically about what survives when nobody is listening, and this harness has
//       nobody listening throughout.
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE — a REAL Db + SessionService driven directly (no MCP
// layer), mirroring platform-escalate-append.mjs's harness exactly.
//
// Run: 1) build (turbo builds shared first), 2) node test/platform-escalate-followup.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-escfollowup-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

// No live Lead in this test — mirrors platform-escalate-append.mjs; append/outcome behavior is
// independent of whether a Lead is live to be nudged.
class SeamHost extends createSeamHost(PtyHost) {
  enqueueStdin() { throw new Error("no live Lead in this test — enqueueStdin should never be reached"); }
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pHome", name: "Loom Platform", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: true });
db.insertProject({ id: "pOrd", name: "Ordinary", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertProject({ id: "pOther", name: "Other", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertAgent({ id: "agentMgr", projectId: "pOrd", name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
db.insertSession({
  id: "MGR", projectId: "pOrd", agentId: "agentMgr", engineSessionId: null, title: null, cwd: tmpHome,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
  role: "manager", parentSessionId: null,
});
db.insertAgent({ id: "agentMgr2", projectId: "pOther", name: "Mgr2", startupPrompt: "MGR2", position: 0, profileId: null });
db.insertSession({
  id: "MGR2", projectId: "pOther", agentId: "agentMgr2", engineSessionId: null, title: null, cwd: tmpHome,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
  role: "manager", parentSessionId: null,
});

const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());

try {
  // ===================== (1) SAME title, no followUpOn, terminal target: STILL FORKS =====================
  const TITLE = "gate lane starves under a slow build";
  const escA = svc.platformEscalate("MGR", { title: TITLE, detail: "A: first sighting, 3 stuck workers.", severity: "medium" });
  check("(setup) 1st escalation files a fresh task", !!escA.taskId && escA.created === true && escA.outcome === "created");

  db.updateTask(escA.taskId, { columnKey: "done" }); // Lead closes the thread
  const escB = svc.platformEscalate("MGR", { title: TITLE, detail: "B: same title, no followUpOn.", severity: "medium" });
  check("(1) ⭐ KNOWN LIMITATION, documented not fixed: same title against a TERMINAL target still forks",
    escB.taskId !== escA.taskId && escB.created === true && escB.outcome === "created");
  check("(1) the fork carries no link back to the closed original", escB.linkedTaskId === undefined);

  // ===================== (2) followUpOn against the SAME terminal target: APPENDS =====================
  const escC = svc.platformEscalate("MGR", { title: "unrelated title entirely", detail: "C: explicit follow-up on the closed thread.", severity: "medium", followUpOn: escA.taskId });
  check("(2) followUpOn reuses the CLOSED original's taskId, not the title-matched fork", escC.taskId === escA.taskId);
  check("(2) outcome:\"appended\" — unambiguous, no inference from title needed", escC.outcome === "appended");
  check("(2) followedUp:true — the caller can tell this was an explicit follow-up", escC.followedUp === true);
  check("(2) targetWasTerminal:true — the caller can tell the Lead had already closed this", escC.targetWasTerminal === true);
  const bodyA = db.getTask(escA.taskId).body;
  check("(2) the ORIGINAL detail is still on the reopened card", bodyA.includes("A: first sighting, 3 stuck workers."));
  check("(2) the NEW explicit-follow-up detail is appended", bodyA.includes("C: explicit follow-up on the closed thread."));
  const events2 = db.listEscalationsForProject("pOrd").filter((e) => e.taskId === escA.taskId);
  check("(2) a FRESH orchestration_event is always filed for an explicit follow-up (never suppressed like a same-severity auto-dedup)", events2.length >= 2);

  // ===================== (3) followUpOn against a STILL-OPEN target =====================
  const escD = svc.platformEscalate("MGR", { title: "a fresh still-open finding", detail: "D: original.", severity: "low" });
  check("(setup) 2nd finding files fresh", !!escD.taskId && escD.created === true);
  const escE = svc.platformEscalate("MGR", { title: "irrelevant title", detail: "E: explicit follow-up on an OPEN thread.", severity: "low", followUpOn: escD.taskId });
  check("(3) followUpOn against a still-open target appends", escE.taskId === escD.taskId && escE.outcome === "appended" && escE.followedUp === true);
  check("(3) targetWasTerminal is NOT set for a still-open target", !escE.targetWasTerminal);
  const bodyD = db.getTask(escD.taskId).body;
  check("(3) both the original and follow-up detail are present", bodyD.includes("D: original.") && bodyD.includes("E: explicit follow-up on an OPEN thread."));

  // ===== (5) card 772d15bd — targetWasTerminal must survive the no-live-Lead ("boarded") path =====
  // escC (from (2) above) is the followUpOn append onto escA, a TERMINAL target; escE (from (3)) is the
  // followUpOn append onto escD, a STILL-OPEN target. Neither call above ever touched a live Lead
  // (SeamHost.enqueueStdin throws if reached), so both already exercised the exact `deliveryStatus:
  // "boarded"` path the card's DoD-4 requires — this section just reads what that path left behind.
  const eventsA = db.listEscalationsForProject("pOrd").filter((e) => e.taskId === escA.taskId);
  const followupEventA = eventsA.find((e) => e.detail?.followedUp === true);
  check("(5) the orchestration_event for the TERMINAL-target follow-up carries followedUp:true", followupEventA?.detail?.followedUp === true);
  check("(5) …and targetWasTerminal:true — durable, not just returned to the caller and dropped", followupEventA?.detail?.targetWasTerminal === true);

  const eventsD = db.listEscalationsForProject("pOrd").filter((e) => e.taskId === escD.taskId);
  const followupEventD = eventsD.find((e) => e.detail?.followedUp === true);
  check("(5) the orchestration_event for the STILL-OPEN-target follow-up carries followedUp:true", followupEventD?.detail?.followedUp === true);
  check("(5) …but targetWasTerminal is absent (never stamped false) for a still-open target", followupEventD?.detail?.targetWasTerminal === undefined);

  check("(5) the TERMINAL-target card body marks the section as a reopened-closed-thread",
    bodyA.includes("## Re-escalation (thread was closed) —"));
  check("(5) …and the STILL-OPEN-target card body uses the ORDINARY heading, not the reopened one",
    bodyD.includes("## Re-escalation —") && !bodyD.includes("## Re-escalation (thread was closed) —"));
  check("(5) the two headings are textually distinguishable from one another",
    bodyA.includes("## Re-escalation (thread was closed) —") && !bodyD.includes("(thread was closed)"));

  check("(5) DoD-3: the reopened TERMINAL target is DELIBERATELY left in its terminal column — a follow-up never auto-moves the card",
    db.getTask(escA.taskId).columnKey === "done");

  // ===================== (4) rejected: unknown / foreign-project followUpOn =====================
  let threwUnknown = false;
  try { svc.platformEscalate("MGR", { title: "x", detail: "y", followUpOn: "00000000-0000-0000-0000-000000000000" }); }
  catch (e) { threwUnknown = /not found/i.test(e.message); }
  check("(4) an unknown followUpOn id is rejected", threwUnknown);

  const escForeign = svc.platformEscalate("MGR2", { title: "a different project's own escalation", detail: "foreign detail", severity: "low" });
  const foreignBodyBefore = db.getTask(escForeign.taskId).body;
  let threwForeign = false;
  try { svc.platformEscalate("MGR", { title: "x", detail: "an attempted cross-project append", followUpOn: escForeign.taskId }); }
  catch (e) { threwForeign = /not found/i.test(e.message); }
  check("(4) a followUpOn id belonging to a DIFFERENT origin project is rejected, not silently honored", threwForeign);
  const foreignBodyAfter = db.getTask(escForeign.taskId).body;
  check("(4) the foreign card's body is byte-identical after the rejected attempt", foreignBodyAfter === foreignBodyBefore);
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — same-title matching still forks against a terminal-column target (the documented heuristic limit), while the explicit followUpOn affordance appends to that SAME closed thread unconditionally, reports outcome/followedUp/targetWasTerminal so the caller never has to infer what happened, and rejects an id that isn't one of the caller's own project's filed escalations."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
