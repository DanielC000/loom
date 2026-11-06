import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 38ef3d5f (part 2): `inbox_pull` (PtyHost.consumePending) used to splice an owner-authored queued
// message out of live.pending WITHOUT attributing its ownerText, so a later `question_resolve` quoted the
// PREVIOUS owner turn (real incident: the owner's reply was handed to the manager by inbox_pull; the
// resolve recorded the owner's earlier message). consumePending now attributes each pulled owner entry in
// FIFO order (active + recent ring) exactly like a normal drain, skipping an entry whose rank is strictly
// older than the turn already attributed (2400d0bc / 270b963c).
//
// HERMETIC, claude-free: a real PtyHost over the seam-host fake pty; the codex block registers a
// CodexLive-shaped object in `liveCodex` (the technique pty-codex-agnostic-methods.mjs documents).
// Run: build first, then `node test/inbox-pull-owner-attribution.mjs`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-inbox-owner-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { PtyHost } = await import("../dist/pty/host.js");
const { resolveOwnerTextForQuestionResolve } = await import("../dist/mcp/questionTool.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

class TestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    const base = super.createPty(opts);
    return { ...base, write: () => {} };
  }
}
const events = { onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} };
const host = new TestPtyHost(events);

// enqueueStdin(sessionId, text, source, onDeliver, route, kind, questionId, ownerText, proactive, senderId, tail)
const enqueueOwner = (sid, text, ownerText, tail) =>
  host.enqueueStdin(sid, text, undefined, undefined, undefined, "agent", undefined, ownerText, false, "owner-composer", tail);
const resolved = (sid) => resolveOwnerTextForQuestionResolve(host, sid).ownerText;

function spawnBusy(sid) {
  host.spawn({
    sessionId: sid, cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  host.deliverHook(sid, { hook_event_name: "SessionStart" });
}

try {
  // ---------- (1) the incident: earlier owner turn A attributed, reply B queued while busy, then inbox_pull ----------
  {
    const SID = "mgr-1";
    spawnBusy(SID);
    const a = enqueueOwner(SID, "OWNER_A_TURN", "owner message A");           // idle → submitted, attributed
    check("(1) precondition: owner turn A was submitted (not queued)", a.delivered === true);
    check("(1) precondition: A is the resolved owner text before any pull", resolved(SID) === "owner message A");
    const b = enqueueOwner(SID, "OWNER_B_REPLY", "owner message B");          // busy → queued with its ownerText
    check("(1) precondition: owner reply B queued busy-gated", b.delivered === false && host.getPending(SID).length === 1);
    check("(1) precondition: B is NOT yet visible to question_resolve (still A)", resolved(SID) === "owner message A");
    const pulled = host.consumePending(SID);
    check("(1) the pull still returns B's text", JSON.stringify(pulled) === JSON.stringify(["OWNER_B_REPLY"]));
    check("(1) FIX: after the pull, question_resolve's owner text is B (the reply the agent just received), not A", resolved(SID) === "owner message B");
    check("(1) active turn owner text is B too", host.getActiveTurnOwnerText(SID) === "owner message B");
    check("(1) ring is [B, A]", JSON.stringify(host.getRecentOwnerTurns(SID)) === JSON.stringify(["owner message B", "owner message A"]));
    host.deliverHook(SID, { hook_event_name: "Stop" });
    check("(1) Stop clears the active text but the ring still resolves B", host.getActiveTurnOwnerText(SID) === null && resolved(SID) === "owner message B");
  }

  // ---------- (2) two owner entries pulled → FIFO attribution: the NEWEST is active and ring[0] ----------
  {
    const SID = "mgr-2";
    spawnBusy(SID);
    enqueueOwner(SID, "T0", "owner turn 0");
    enqueueOwner(SID, "T1", "owner turn 1");
    enqueueOwner(SID, "T2", "owner turn 2");
    host.consumePending(SID);
    check("(2) two pulled owner entries: the NEWEST (turn 2) is the resolved/active text", resolved(SID) === "owner turn 2" && host.getActiveTurnOwnerText(SID) === "owner turn 2");
    check("(2) ring is [2, 1, 0] (FIFO attribution order)", JSON.stringify(host.getRecentOwnerTurns(SID)) === JSON.stringify(["owner turn 2", "owner turn 1", "owner turn 0"]));
  }

  // ---------- (3) negative control: a non-owner queued entry changes nothing ----------
  {
    const SID = "mgr-3";
    spawnBusy(SID);
    enqueueOwner(SID, "T0", "owner turn 0");
    host.enqueueStdin(SID, "[loom:worker-report] worker W done"); // no ownerText
    const before = JSON.stringify(host.getRecentOwnerTurns(SID));
    host.consumePending(SID);
    check("(3) a pulled NON-owner entry leaves the ring untouched", JSON.stringify(host.getRecentOwnerTurns(SID)) === before && resolved(SID) === "owner turn 0");
  }

  // ---------- (4) rank guard (2400d0bc / 270b963c): an OLDER pulled entry never overwrites a newer attributed turn ----------
  {
    const SID = "mgr-4";
    spawnBusy(SID);
    enqueueOwner(SID, "NEWER", "newer owner turn");                                   // minted rank 1, attributed
    enqueueOwner(SID, "STALE", "stale owner turn", { ownerTextSeq: 0 });              // explicit OLDER rank, queued
    host.consumePending(SID);
    check("(4) a pulled entry with a strictly OLDER rank does NOT overwrite the newer attributed turn", resolved(SID) === "newer owner turn" && host.getActiveTurnOwnerText(SID) === "newer owner turn");
    check("(4) …and does not enter the ring", JSON.stringify(host.getRecentOwnerTurns(SID)) === JSON.stringify(["newer owner turn"]));
  }

  // ---------- (6) the pull happens MID-TURN: it must not touch the lastPrompt* replay mirror ----------
  // A rate-limit park of the in-flight NON-owner turn (a worker report) then resumes via the blocked branch,
  // which re-queues lastPrompt carrying lastPromptOwnerText under lastPromptSenderId. If the pull had rewritten
  // lastPromptOwnerText, the re-queued worker-report would carry the pulled owner text (the f286919e split).
  {
    const SID = "mgr-6";
    spawnBusy(SID);
    const REPORT = "[loom:worker-report] worker W done";
    host.enqueueStdin(SID, REPORT, undefined, undefined, undefined, "agent", undefined, undefined, false, "worker-W"); // non-owner turn in flight
    enqueueOwner(SID, "OWNER_B_REPLY", "owner message B");                                                       // queued while busy
    host.consumePending(SID);
    check("(6) the pulled owner text is active for question_resolve", host.getActiveTurnOwnerText(SID) === "owner message B" && resolved(SID) === "owner message B");
    host.deliverHook(SID, { hook_event_name: "StopFailure", error: "rate_limit" }); // the worker-report turn dies to a rate limit and parks
    host.holdDrain(SID);                                                            // BLOCKED branch → enqueueStdin of lastPrompt
    check("(6) resume reports success while blocked", host.resumeAfterRateLimit(SID) === true);
    const replay = host.flushPending(SID).find((m) => m.text.includes("[loom:worker-report]"));
    check("(6) the worker-report replay entry was re-queued", !!replay);
    check("(6) …and carries NO owner text (the pull did not write lastPromptOwnerText)", replay && replay.ownerText === undefined);
    check("(6) …under the worker's own sender id, not an owner-attested one", replay && replay.senderId === "worker-W");
  }

  // ---------- (7) the rank baseline survives an intervening NON-owner turn (lastPromptOwnerTextSeq is nulled by it) ----------
  {
    const SID = "mgr-7";
    spawnBusy(SID);
    enqueueOwner(SID, "T5", "owner rank five", { ownerTextSeq: 5 });                  // idle → submitted, rank 5 attributed
    host.deliverHook(SID, { hook_event_name: "Stop" });
    host.enqueueStdin(SID, "[loom:worker-report] worker W done");                      // non-owner turn: nulls lastPromptOwnerTextSeq
    enqueueOwner(SID, "T4", "owner rank four", { ownerTextSeq: 4 });                  // older rank, queued busy
    host.consumePending(SID);
    check("(7) an older-ranked (4) pulled entry does NOT overwrite the recorded rank-5 owner turn", resolved(SID) === "owner rank five");
    check("(7) …nor become the active text during the non-owner turn", host.getActiveTurnOwnerText(SID) === null);
    check("(7) …ring is just [five]", JSON.stringify(host.getRecentOwnerTurns(SID)) === JSON.stringify(["owner rank five"]));
  }

  // ---------- (5) codex Live is reachable through findAnyLive → mirrored (active + ring, FIFO) ----------
  {
    const SID = "codex-1";
    const fakePty = { pid: 424243, write() {}, kill() {}, resize() {}, onData(cb) { this._onData = cb; }, onExit(cb) { this._onExit = cb; } };
    const live = {
      kind: "codex", pty: fakePty, pid: fakePty.pid, cwd: tmpHome, geometry: { cols: 120, rows: 40 }, hookToken: "",
      engineSessionId: "eng", ring: { chunks: [], bytes: 0 }, subscribers: new Set(), alive: true, killed: false,
      startedAt: Date.now(), logStream: { write() {}, end() {}, on() {} }, logBroken: false, busy: true, pending: [],
      stopping: false, drainHeld: false, role: "manager", mcpSeen: false, mcpSeenWaiters: [],
      activeTurnRoute: null, lastPromptRoute: null, activeTurnProactive: false, lastPromptProactive: false,
      activeTurnOwnerText: null, lastPromptOwnerText: null, recentOwnerTurns: ["codex earlier"],
      activeTurnSenderId: null, lastPromptSenderId: null, trustDialogAnswered: true, screenScan: "", firstTurnStarted: false,
    };
    host.liveCodex.set(SID, live);
    live.pending.push(
      { id: "c1", text: "X1", source: "system", kind: "agent", logicalId: "c1", ownerText: "codex owner 1" },
      { id: "c2", text: "no-owner", source: "system", kind: "warning", logicalId: "c2" },
      { id: "c3", text: "X3", source: "system", kind: "agent", logicalId: "c3", ownerText: "codex owner 3" },
    );
    host.consumePending(SID);
    check("(5) codex: newest pulled owner entry is active", live.activeTurnOwnerText === "codex owner 3");
    check("(5) codex: ring is [3, 1, earlier]; the non-owner entry is skipped", JSON.stringify(live.recentOwnerTurns) === JSON.stringify(["codex owner 3", "codex owner 1", "codex earlier"]));
    host.liveCodex.delete(SID);
  }
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0 ? "\n✅ ALL PASS — inbox_pull attributes pulled owner text" : `\n❌ ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
