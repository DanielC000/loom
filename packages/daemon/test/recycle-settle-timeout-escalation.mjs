import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card ca0111a3 (discovered from 92c20eb9's Code Review, Minor 3) — a predecessor whose recycle
// successor NEVER CONFIRMS reaching SessionStart stays isSupersededByRecycle:true forever (the
// settleRecycleHandoff timeout branch, sessions/service.ts, fires recordUnresolvedRecycleOutcome but
// never stops polling and never un-supersedes the predecessor) — so EVERY fleet-mutating/escalation tool
// stays refused via callerSupersededError() while the stuck successor can't act either (it never reached
// ready). LEAD DECISION (see docs/decisions/92c20eb9-...md's own "card ca0111a3" section for the full
// reasoning): no automatic reclaim — a reclaim here would race settleRecycleHandoff's own ready-branch
// hard-stop (double-stop/split-brain). Instead, a NARROW, durable-row-keyed carve-out opens ONLY
// question_ask, so the stuck predecessor can ask a human to hard-stop the named successor — which routes
// through the EXISTING, already-tested `!pty.isAlive` reclaim branch of that same settle loop.
//
// Proves, end-to-end (the pure-predicate edge cases — halted:true exclusion, stale successor id, the
// durable reachedReadyAt latch — have their OWN dedicated unit coverage in
// recycle-unresolved-settle-predicate.mjs; this file is the real async settle-loop flow):
//   (1) BEFORE the settle-timeout alert fires: question_ask is STILL refused with the ordinary retirement
//       error (negative control — the carve-out must be keyed on the durable recycle_fleet_unresolved
//       event, never on the bare fact of being superseded).
//   (1) AFTER the alert fires: currentUnresolvedSettleSuccessor matches the stuck successor; question_ask
//       SUCCEEDS (a REAL question is filed, not bypassed) and its response carries the actionable hint
//       naming the successor id + the POST /api/sessions/:id/stop route (with its {"mode":"hard"} body) +
//       the conditional phrasing instruction; every OTHER refused tool (gate_cancel, as a representative)
//       STILL refuses outright — the carve-out is question_ask-ONLY — but its refusal text now ALSO
//       carries the same hint (retiredCallerMessage).
//   (1) RESOLVED-LATE (Code Review round 2's main fix): once the successor eventually DOES reach ready,
//       the predecessor is hard-stopped, a recycle_fleet_resolved event supersedes the unresolved one (the
//       carve-out's own predicate must stop matching — no stale match on an old unresolved event), AND the
//       still-pending escalation question filed through the carve-out is CANCELLED (retained history, a
//       reason, never a hard delete) — its content told a human to stop a successor that is now the
//       legitimate fleet owner.
//   (2) RECOVERED negative control: once the successor is instead confirmed DEAD (a human force-stops it,
//       exactly as the hint suggests), settleRecycleHandoff's own existing `!isAlive` branch reclaims the
//       fleet — the predecessor is fully unsuperseded again (not via the carve-out), and
//       currentUnresolvedSettleSuccessor correctly stops matching once a recycle_fleet_recovered event
//       supersedes the unresolved one.
//
// Negative control (behavioural, per DoD): run `pnpm --filter @loom/daemon negative-control` against the
// commit that introduces this file paired with the commit BEFORE the ca0111a3 carve-out landed — every
// check in this file that currently PASSes (the "AFTER the alert fires" / "RECOVERED" question_ask
// successes, the hint text, the gate_cancel-still-refuses-but-now-hinted check, the resolved-late cancel)
// goes RED on that prior commit, since question_ask was unconditionally refused once superseded, with no
// hint text and no cancel anywhere.
//
// FLAKE-RISK FIX (Code Review round 2): the MCP client for m1 is now built BEFORE calling recycleManager
// (not after) — building it is a real async op (router construction + an InMemoryTransport handshake)
// that used to run INSIDE the "before the alert fires" window, competing with the same wall-clock margin
// the alert timer does. Building it first means the "before-alert" check is now a single, already-warm
// round trip with no setup cost left to race.
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE: a REAL Db + SessionService + PtyHost driven against the
// shared fake-pty seam (createSeamHost) — mirrors recycle-refuses-fleet-writes.mjs's own harness. Every
// wait below is on an OBSERVABLE event (an appended orchestration event, a stopped pty id), never a fixed
// sleep standing in for one — see _wait.mjs's own header for why.
//
// Run: 1) build (turbo builds shared first), 2) node test/recycle-settle-timeout-escalation.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-rste-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

// Shrink every settle bound BEFORE importing dist/** (mirrors recycle-refuses-fleet-writes.mjs) — these
// are read ONCE as static class fields at module-load time, so they must be set before the first import.
// FLUSH_DELAY/TIMEOUT give the "before the alert fires" check a real window to run in (now a single
// already-warm MCP round trip, no setup cost — see the FLAKE-RISK FIX note above); SLOW_POLL is also
// shrunk so the loop keeps checking ready/dead quickly AFTER the alert fires too, instead of the
// production 15s cadence.
process.env.LOOM_RECYCLE_SUCCESSOR_SETTLE_FLUSH_DELAY_MS = "30";
process.env.LOOM_RECYCLE_SUCCESSOR_SETTLE_POLL_MS = "20";
process.env.LOOM_RECYCLE_SUCCESSOR_SETTLE_TIMEOUT_MS = "200";
process.env.LOOM_RECYCLE_SUCCESSOR_SETTLE_SLOW_POLL_MS = "20";
process.env.LOOM_MCP_READY_TIMEOUT_MS = "25";

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { isSupersededByRecycle, currentUnresolvedSettleSuccessor } = await import("../dist/orchestration/crash-orphaned-workers.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

class SeamHost extends createSeamHost(PtyHost) {
  stoppedIds = new Set();
  stop(id, mode) { this.stoppedIds.add(id); return super.stop(id, mode); }
}

function makeHarness() {
  const db = new Db();
  const events = {
    onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
    onReady(id) { db.setReachedReady(id); },
    onBusy(id, busy) { db.setBusy(id, busy); },
    onContextStats() {}, onRateLimited() {},
  };
  const host = new SeamHost(events);
  let sessions;
  host.events.onExit = (id, code, info) => {
    db.setProcessState(id, "exited");
    db.setBusy(id, false);
    const exited = db.getSession(id);
    if (exited) sessions.archiveOnExit(exited);
    if (exited) sessions.reconcileNeverStartedRecycleSuccessor(id, info.intended);
  };
  sessions = new SessionService(db, host, new OrchestrationControl());
  return { db, host, sessions };
}

function seedProject(db, id) {
  const now = new Date().toISOString();
  const repo = path.join(tmpHome, `repo-${id}`); // never touched on disk — no worktree is created in this file
  db.insertProject({ id, name: id, repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `${id}-mgr`, projectId: id, name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
  db.setProjectConfig(id, { permission: { startupModeCycles: 0 } }); // markReady synchronously off one SessionStart
}

/** Drives the real registered MCP tool (never the bare service method) for `managerSessionId`. Built on
 *  the UNSTARTED (pre-recycle) session id — this works equally well before or after that session later
 *  recycles, since the router/client pair is keyed by id, not by a liveness snapshot. */
async function mcpClientFor(db, sessions, host, managerSessionId) {
  const router = new OrchestrationMcpRouter(db, sessions, {}, host);
  const server = router.buildServer(managerSessionId, "manager");
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "recycle-settle-timeout-escalation-test", version: "0" });
  await client.connect(clientT);
  const parse = (res) => JSON.parse(res.content[0].text);
  const call = async (name, args) => parse(await client.callTool({ name, arguments: args }));
  return { client, call };
}

const RETIRED_RE = /being retired \(recycled\); your successor ([a-zA-Z0-9-]+) owns the fleet/;
const ESCALATION_HINT_RE = /call question_ask to ask a human to hard-stop it \(POST \/api\/sessions\/([a-zA-Z0-9-]+)\/stop with body \{"mode":"hard"\}/;
const CONDITIONAL_PHRASING_RE = /ONLY IF your successor still shows not-ready/;

const unresolvedTimeoutEvent = (db, id) =>
  db.listEventsForSession(id).some((e) => e.kind === "recycle_fleet_unresolved" && e.detail?.reason === "timeout" && e.detail?.halted !== true);

try {
  // ======================================================================================
  // SCENARIO 1 — successor eventually reaches ready LATE: the carve-out opens at the timeout
  // alert, then closes once recycle_fleet_resolved supersedes it AND the stale escalation
  // question gets cancelled.
  // ======================================================================================
  {
    const { db, host, sessions } = makeHarness();
    const P = "rste-ready-late";
    seedProject(db, P);
    const m1 = sessions.startManager(`${P}-mgr`);

    // FLAKE-RISK FIX: build the MCP client BEFORE recycling, so the "before-alert" check below has no
    // router/transport setup cost left to race against the real flush-delay timer.
    const { call: callAsM1 } = await mcpClientFor(db, sessions, host, m1.id);

    const m2 = await sessions.recycleManager(m1.id, "handoff — settle-timeout escalation test (ready-late)");
    check("(1 setup) ownership transfer succeeded, no halt", !db.listEventsForSession(m2.id).some((e) => e.kind === "recycle_ownership_transfer_failed"));
    check("(1 setup) m1 is superseded (hasSuccessor, not halted)", isSupersededByRecycle(db, m1.id) === true);
    check("(1 setup) the predecessor has NOT been hard-stopped yet", !host.stoppedIds.has(m1.id));

    // ---- BEFORE the settle-timeout alert fires: question_ask must still be refused ----
    // No sleep here by design — this runs essentially instantly (the MCP client is already warm), well
    // inside the >=30ms flush-delay window settleRecycleHandoff is guaranteed to still be suspended on.
    check("(1 before-alert) no unresolved event exists yet", unresolvedTimeoutEvent(db, m1.id) === false);
    check("(1 before-alert) currentUnresolvedSettleSuccessor does not yet match", currentUnresolvedSettleSuccessor(db, m1.id) === undefined);
    const beforeAlert = await callAsM1("question_ask", { title: "too early", body: "too early" });
    check("(1 before-alert) question_ask STILL refuses with the retirement error (carve-out not yet open)",
      typeof beforeAlert.error === "string" && RETIRED_RE.test(beforeAlert.error));

    // ---- wait for the real settle-timeout alert — an OBSERVABLE event, never a fixed sleep ----
    await waitUntil(() => unresolvedTimeoutEvent(db, m1.id), { timeoutMs: 10_000, label: "recycle_fleet_unresolved(reason:timeout) for m1 (scenario 1)" });

    // ---- AFTER the alert: the carve-out is open ----
    const matched = currentUnresolvedSettleSuccessor(db, m1.id);
    check("(1 after-alert) currentUnresolvedSettleSuccessor now matches the stuck successor", matched?.id === m2.id);

    const questionsBefore = db.listQuestionsForSession(m1.id).length;
    const askResult = await callAsM1("question_ask", { title: "please help", body: "my successor is stuck" });
    check("(1 after-alert) question_ask now SUCCEEDS through the carve-out", typeof askResult.questionId === "string" && !askResult.error);
    check("(1 after-alert) a REAL question was filed (not bypassed)", db.listQuestionsForSession(m1.id).length === questionsBefore + 1);
    check("(1 after-alert) the response carries the actionable hint naming the successor + the hard-stop route",
      typeof askResult.note === "string" && ESCALATION_HINT_RE.test(askResult.note) && askResult.note.includes(m2.id));
    check("(1 after-alert) the hint tells P to phrase the ask conditionally (only if still not-ready)",
      typeof askResult.note === "string" && CONDITIONAL_PHRASING_RE.test(askResult.note));

    // ---- every OTHER refused tool STILL refuses outright — the carve-out is question_ask-ONLY —
    // but its refusal text now ALSO carries the same hint (retiredCallerMessage) ----
    const gcResult = await callAsM1("gate_cancel", { opId: "nonexistent-op" });
    check("(1 after-alert) gate_cancel STILL refuses outright", typeof gcResult.error === "string" && RETIRED_RE.test(gcResult.error));
    check("(1 after-alert) its refusal text ALSO carries the same escalation hint",
      ESCALATION_HINT_RE.test(gcResult.error ?? "") && (gcResult.error ?? "").includes(m2.id));

    // ---- the successor eventually reaches ready: the window closes, m1 is retired, AND the stale
    // escalation question is cancelled (Code Review round 2's main behavioural fix) ----
    host.deliverHook(m2.id, { hook_event_name: "SessionStart", session_id: "eng-m2-ready-late" });
    await waitUntil(() => host.stoppedIds.has(m1.id), { timeoutMs: 10_000, label: "predecessor m1 hard-stopped after late ready" });
    await waitUntil(() => db.listEventsForSession(m1.id).some((e) => e.kind === "recycle_fleet_resolved"), { timeoutMs: 10_000, label: "recycle_fleet_resolved for m1" });

    // ---- negative control: a LATER resolved event closes the window — no stale match ----
    check("(1 resolved) currentUnresolvedSettleSuccessor no longer matches (resolved supersedes unresolved)", currentUnresolvedSettleSuccessor(db, m1.id) === undefined);

    // ---- the escalation question filed above is now CANCELLED — retained history, never a hard delete ----
    const cancelled = db.getQuestion(askResult.questionId);
    check("(1 resolved) the stale escalation question still EXISTS (retained history, not a hard delete)", !!cancelled);
    check("(1 resolved) its state is now \"cancelled\"", cancelled?.state === "cancelled");
    check("(1 resolved) it carries a cancellation reason (never silently discarded)", typeof cancelled?.cancelledReason === "string" && cancelled.cancelledReason.length > 0);
    check("(1 resolved) the reason names the successor that just became the legitimate owner", cancelled?.cancelledReason?.includes(m2.id));
  }

  // ======================================================================================
  // SCENARIO 2 — the human force-stops the stuck successor (the hint's own suggested action):
  // the EXISTING !isAlive reclaim branch fires, and the carve-out closes because m1 is fully
  // unsuperseded again, not merely because the carve-out matched something stale.
  // ======================================================================================
  {
    const { db, host, sessions } = makeHarness();
    const P = "rste-successor-dies";
    seedProject(db, P);
    const m1 = sessions.startManager(`${P}-mgr`);
    const { call: callAsM1 } = await mcpClientFor(db, sessions, host, m1.id);

    const m2 = await sessions.recycleManager(m1.id, "handoff — settle-timeout escalation test (successor dies)");
    check("(2 setup) m1 is superseded", isSupersededByRecycle(db, m1.id) === true);

    await waitUntil(() => unresolvedTimeoutEvent(db, m1.id), { timeoutMs: 10_000, label: "recycle_fleet_unresolved(reason:timeout) for m1 (scenario 2)" });
    check("(2 after-alert) currentUnresolvedSettleSuccessor matches the stuck successor", currentUnresolvedSettleSuccessor(db, m1.id)?.id === m2.id);

    const askResult = await callAsM1("question_ask", { title: "help", body: "stuck" });
    check("(2 after-alert) question_ask succeeds through the carve-out", typeof askResult.questionId === "string");

    // ---- the human hard-stops the stuck successor — exactly the escalation hint's own suggested action ----
    host.stop(m2.id, "hard");
    await waitUntil(() => db.listEventsForSession(m1.id).some((e) => e.kind === "recycle_fleet_recovered"), { timeoutMs: 10_000, label: "recycle_fleet_recovered for m1" });

    check("(2 recovered) m1 is no longer superseded at all (fleet fully reclaimed)", isSupersededByRecycle(db, m1.id) === false);
    check("(2 recovered) currentUnresolvedSettleSuccessor no longer matches (recovered supersedes unresolved)", currentUnresolvedSettleSuccessor(db, m1.id) === undefined);

    // ---- unlike scenario 1's resolved-late path, the RECOVERED path never hard-stops m1 — the question
    // asked while stuck remains genuinely P's own live, unresolved ask; it is NOT cancelled ----
    const stillPending = db.getQuestion(askResult.questionId);
    check("(2 recovered) the question asked while stuck is NOT cancelled (m1 itself recovered, nothing to retract)", stillPending?.state === "pending");

    const askAgain = await callAsM1("question_ask", { title: "thanks", body: "fleet is back" });
    check("(2 recovered) question_ask still succeeds — now because m1 is ORDINARY-unsuperseded, not via the carve-out",
      typeof askAgain.questionId === "string" && !askAgain.note);
  }
} finally {
  // best-effort cleanup — a leaked temp LOOM_HOME under os.tmpdir() is harmless but tidy up anyway.
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a predecessor stuck past the recycle settle-timeout can escalate via question_ask ONLY (every other refused tool stays refused, now carrying the same hint), keyed on the durable recycle_fleet_unresolved(reason:timeout) event (never refused before it fires); the carve-out correctly stops matching once a later recycle_fleet_resolved/recovered event supersedes it; and a question filed through it is cancelled (retained history) if the successor later becomes ready, but left alone if the predecessor itself recovers the fleet instead."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
