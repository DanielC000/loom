import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card c36bac53: the [loom:worker-idle] nudge used to flatly assert "it IS parked awaiting your reply"
// for EVERY worker_report(progress)-then-idle worker with no pending wake — wrong whenever the worker
// actually parked on a backgrounded command/sub-agent (the standard pattern for a gate that exceeds the
// worker's foreground budget) rather than on the manager. The daemon has NO API into the engine's
// background-task registry (see orchestration/resume-nudge.ts's RESUME_NUDGE_TAIL doc — a `--resume`
// silently kills any in-flight `run_in_background` shell for exactly this reason: Loom cannot see it),
// so unlike the wake case (a real `wakes` row Loom itself scheduled) there is no way to INFER a
// background park from daemon state. The fix: `worker_report` grows an optional `awaiting` hint
// ("manager" | "background") the worker sets on itself; classifyIdleWorker reads it back and gives a
// self-attributed background park the SAME "no reply owed" honest wording as a scheduled-wake park,
// instead of the flat awaiting-your-reply assertion.
//
// Round 2 (Code Reviewer + manager, same card): two blocking Majors found in round 1's shipped fix.
//   MAJOR — `parked-background` was an unbounded, self-reinforcing dead state: unlike `parked-wake`
//   (backed + bounded by a real, self-deleting `wakes` row), a bare `awaiting:"background"` flag never
//   expires — if the background task dies silently and the worker never re-engages, the daemon would
//   promise "no reply owed; it will continue on its own" FOREVER, holding a concurrency slot with the
//   manager affirmatively told to stand down. Fixed: the flag now DECAYS past
//   BACKGROUND_PARK_STALE_MINUTES since the flagged report into an actionable `parked-background-stale`
//   nudge. Also: a pending wake (Loom's OWN verifiable, bounded signal) now wins PRIORITY over the bare
//   self-attributed flag when both are present (inverted from round 1's "flag wins").
//   MAJOR — the auto-recovery re-confirmation dedupe's `awaiting` term had zero test coverage; a re-report
//   after a simulated crash/resume that ONLY flips `awaiting` must not be collapsed as a pure echo.
//
// Exercises all branches through the REAL sessions.workerReport() call (not just a hand-appended event)
// where feasible, so the `awaiting` param's full path — MCP arg -> workerReport -> event detail ->
// classifyIdleWorker -> notifyManagerOfIdleWorker's wording — is covered end to end:
//   (1) awaiting-manager (the TRUE POSITIVE, default/omitted `awaiting`) — still says "awaiting your
//       reply". Regression guard: this is the one case the fix must NOT touch.
//   (2) scheduled-wake (`wake_me`, no `awaiting` set) — unchanged "no reply owed … scheduled wake" wording.
//   (3) background-task, FRESH (`awaiting: "background"`, no wake, report just now) — NEW "no reply owed
//       … backgrounded task" wording, not the false awaiting-your-reply claim.
//   (4) priority — a pending wake WINS over an also-set background flag (the wake is backed + bounded).
//   (5) background-task, STALE (report older than BACKGROUND_PARK_STALE_MINUTES, no wake, no ack) — the
//       flag DECAYS to the actionable `parked-background-stale` wording; neither "no reply owed" nor
//       "awaiting your reply" is claimed. Hand-appends the event (mirrors worker-idle-wake-parked.mjs's
//       house style) so the report timestamp can be backdated past the threshold deterministically.
//   (6) dedupe — a re-report after a simulated crash/resume that changes ONLY `awaiting` (same status/
//       summary) must NOT be collapsed as a pure re-confirmation echo.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Db } from "../dist/db.js";
import { SessionService } from "../dist/sessions/service.js";
import { OrchestrationControl } from "../dist/orchestration/control.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const NOW = new Date("2026-07-17T12:00:00.000Z");
const minutesAgo = (m) => new Date(NOW.getTime() - m * 60_000).toISOString();

function makeEnv() {
  const dbFile = path.join(os.tmpdir(), `loom-idle-bg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Db(dbFile);
  const projId = `ibp-${Math.random().toString(36).slice(2, 8)}`;
  const agentId = `ibpa-${Math.random().toString(36).slice(2, 8)}`;
  const now = NOW.toISOString();
  db.insertProject({ id: projId, name: "IdleBgPark", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });

  const alive = new Set();
  const enqueued = [];
  const pty = {
    isAlive: (id) => alive.has(id),
    enqueueStdin: (id, text) => {
      enqueued.push({ id, text });
      const s = db.getSession(id);
      return s?.processState === "live" ? { delivered: true } : { delivered: false, position: 1 };
    },
    getPendingEntries: () => [],
  };
  const control = new OrchestrationControl();
  const sessions = new SessionService(db, pty, control);
  return { dbFile, db, projId, agentId, alive, enqueued, sessions };
}

function seedManager(e, id, { idleMin = 60 } = {}) {
  e.db.insertSession({
    id, projectId: e.projId, agentId: e.agentId, engineSessionId: "eng-" + id, title: null, cwd: e.projId,
    processState: "live", resumability: "resumable", busy: false,
    createdAt: minutesAgo(idleMin), lastActivity: minutesAgo(idleMin), lastError: null, role: "manager",
    ctxInputTokens: null, ctxTurns: null, model: null,
  });
  e.alive.add(id);
}
function seedWorker(e, id, parentId, taskId, { idleMin = 60 } = {}) {
  e.db.insertSession({
    id, projectId: e.projId, agentId: e.agentId, engineSessionId: "eng-" + id, title: null, cwd: e.projId,
    processState: "live", resumability: "resumable", busy: false,
    createdAt: minutesAgo(idleMin), lastActivity: minutesAgo(idleMin), lastError: null, role: "worker",
    parentSessionId: parentId, taskId, ctxInputTokens: null, ctxTurns: null, model: null,
  });
  e.alive.add(id);
}
function seedTask(e, id, columnKey = "in_progress") {
  e.db.insertTask({ id, projectId: e.projId, title: "T-" + id, body: "", columnKey, position: 0, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() });
}
function cleanup(e) {
  try { e.db.close(); } catch { /* ignore */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(e.dbFile + ext, { force: true }); } catch { /* ignore */ } }
}

// ============ (1) awaiting-manager TRUE POSITIVE — default `awaiting`, no wake ====================
{
  const e = makeEnv();
  seedManager(e, "mgr-1");
  seedTask(e, "tk-1", "in_progress");
  seedWorker(e, "wkr-1", "mgr-1", "tk-1", { idleMin: 60 });

  const r = await e.sessions.workerReport("wkr-1", { status: "progress", summary: "investigated, here's what I found" });
  check("(1) workerReport with no `awaiting` succeeds", r.reported === true);

  e.sessions.notifyManagerOfIdleWorker("wkr-1");
  const nudge = e.enqueued.find((x) => x.id === "mgr-1" && /worker-idle/.test(x.text));
  check("(1) a [loom:worker-idle] nudge IS sent", !!nudge);
  check("(1) TRUE POSITIVE preserved: it still says the worker IS parked awaiting the manager's reply",
    !!nudge && /it IS parked awaiting your reply/.test(nudge.text));
  check("(1) it recommends worker_message as the way to reply (this park IS attributable)",
    !!nudge && /worker_message/.test(nudge.text));
  cleanup(e);
}

// ============ (2) scheduled-wake — unaffected by the `awaiting` param existing =====================
{
  const e = makeEnv();
  seedManager(e, "mgr-2");
  seedTask(e, "tk-2", "in_progress");
  seedWorker(e, "wkr-2", "mgr-2", "tk-2", { idleMin: 60 });

  await e.sessions.workerReport("wkr-2", { status: "progress", summary: "kicked off a long build via wake_me" });
  const wakeAt = new Date(NOW.getTime() + 15 * 60_000).toISOString();
  e.db.insertWake({ id: "wake-2", sessionId: "wkr-2", wakeAt, note: "check the build", createdAt: NOW.toISOString() });

  e.sessions.notifyManagerOfIdleWorker("wkr-2");
  const nudge = e.enqueued.find((x) => x.id === "mgr-2" && /worker-idle/.test(x.text));
  check("(2) a [loom:worker-idle] nudge IS sent", !!nudge);
  check("(2) does NOT claim awaiting-your-reply", !!nudge && !/awaiting your reply/.test(nudge.text));
  check("(2) explains the scheduled-wake self-resume ('no reply owed' + 'OWN scheduled wake')",
    !!nudge && /no reply owed/.test(nudge.text) && /OWN scheduled wake/.test(nudge.text));
  cleanup(e);
}

// ============ (3) background-task — the CARD'S actual bug: awaiting:"background", no wake ==========
{
  const e = makeEnv();
  seedManager(e, "mgr-3");
  seedTask(e, "tk-3", "in_progress");
  seedWorker(e, "wkr-3", "mgr-3", "tk-3", { idleMin: 60 });

  const r = await e.sessions.workerReport("wkr-3", {
    status: "progress",
    summary: "kicked off the gate via run_in_background, waiting on it",
    awaiting: "background",
  });
  check("(3) workerReport with awaiting:\"background\" succeeds", r.reported === true);

  e.sessions.notifyManagerOfIdleWorker("wkr-3");
  const nudge = e.enqueued.find((x) => x.id === "mgr-3" && /worker-idle/.test(x.text));
  check("(3) a [loom:worker-idle] nudge IS sent (not silently suppressed)", !!nudge);
  check("(3) does NOT claim the worker IS parked awaiting the manager's reply (THE BUG)",
    !!nudge && !/it IS parked awaiting your reply/.test(nudge.text) && !/awaiting your reply/.test(nudge.text));
  check("(3) honestly attributes the park to its OWN backgrounded task, 'no reply owed'",
    !!nudge && /no reply owed/.test(nudge.text) && /OWN backgrounded task/.test(nudge.text));
  cleanup(e);
}

// ============ (4) priority — a PENDING WAKE wins over an also-set background flag ===================
// Round-2 CR fix: a wake is Loom's OWN verifiable, bounded resume signal (it drives the actual resume and
// names a concrete wakeAt) — prefer it over the worker's bare, unbacked self-attribution when both exist.
{
  const e = makeEnv();
  seedManager(e, "mgr-4");
  seedTask(e, "tk-4", "in_progress");
  seedWorker(e, "wkr-4", "mgr-4", "tk-4", { idleMin: 60 });

  await e.sessions.workerReport("wkr-4", {
    status: "progress", summary: "backgrounded + also set a belt-and-suspenders wake",
    awaiting: "background",
  });
  const wakeAt = new Date(NOW.getTime() + 15 * 60_000).toISOString();
  e.db.insertWake({ id: "wake-4", sessionId: "wkr-4", wakeAt, note: "just in case", createdAt: NOW.toISOString() });

  e.sessions.notifyManagerOfIdleWorker("wkr-4");
  const nudge = e.enqueued.find((x) => x.id === "mgr-4" && /worker-idle/.test(x.text));
  check("(4) the BACKED, BOUNDED scheduled-wake wording wins over the bare background self-attribution",
    !!nudge && /OWN scheduled wake/.test(nudge.text) && !/OWN backgrounded task/.test(nudge.text));
  cleanup(e);
}

// ============ (5) background-task, STALE — the flag DECAYS instead of promising forever ============
// The Major this round: a bare `awaiting:"background"` flag has no backing row and no expiry. If the
// worker never re-engages (its background task died silently), classifyIdleWorker must NOT keep asserting
// "no reply owed; it will continue on its own" indefinitely — that would be a SILENT, PERMANENT false
// negative (worse than the original bug, which was at least noisy and self-healing). Hand-append the
// report event with a backdated `ts` (mirrors worker-idle-wake-parked.mjs's house style) so the elapsed
// time is deterministic rather than depending on real wall-clock sleeps.
{
  const e = makeEnv();
  seedManager(e, "mgr-5");
  seedTask(e, "tk-5", "in_progress");
  seedWorker(e, "wkr-5", "mgr-5", "tk-5", { idleMin: 60 });
  e.db.appendEvent({
    id: "evt-5", ts: minutesAgo(25), managerSessionId: "mgr-5", workerSessionId: "wkr-5", taskId: "tk-5",
    kind: "worker_report",
    detail: { status: "progress", summary: "kicked off the gate via run_in_background", awaiting: "background" },
  });

  e.sessions.notifyManagerOfIdleWorker("wkr-5");
  const nudge = e.enqueued.find((x) => x.id === "mgr-5" && /worker-idle/.test(x.text));
  check("(5) a [loom:worker-idle] nudge IS sent (not silently suppressed)", !!nudge);
  check("(5) does NOT promise 'no reply owed' / 'will continue on its own' for a stale, unbacked flag",
    !!nudge && !/no reply owed/.test(nudge.text) && !/will continue on its own/.test(nudge.text));
  check("(5) does NOT fall back to the false 'awaiting your reply' claim either",
    !!nudge && !/it IS parked awaiting your reply/.test(nudge.text));
  check("(5) names the staleness explicitly and points at worker_transcript to check what actually happened",
    !!nudge && /stale/.test(nudge.text) && /worker_transcript/.test(nudge.text));
  cleanup(e);
}

// ============ (6) dedupe — a re-report that ONLY flips `awaiting` is NOT collapsed as a pure echo =====
// The auto-recovery re-confirmation dedupe (card 289586c7) collapses a re-report with byte-identical
// status/summary/prUrl/needs/noChanges into a `dropped` no-op — but `awaiting` must be part of that
// identity check too, or a worker that flips its disposition (e.g. first checkpoint had no `awaiting`,
// then it crashed, resumed, and re-reports flagging `awaiting:"background"` this time) would be silently
// swallowed instead of updating its classification.
{
  const e = makeEnv();
  seedManager(e, "mgr-6");
  seedTask(e, "tk-6", "in_progress");
  seedWorker(e, "wkr-6", "mgr-6", "tk-6", { idleMin: 60 });

  const SAME_SUMMARY = "kicked off the gate, waiting on it";
  const first = await e.sessions.workerReport("wkr-6", { status: "progress", summary: SAME_SUMMARY });
  check("(6 setup) first report succeeds", first.reported === true);
  e.db.appendEvent({
    id: randomUUID(), ts: new Date().toISOString(),
    managerSessionId: "mgr-6", workerSessionId: "wkr-6", taskId: "tk-6",
    kind: "session_resume_attempt", detail: { attempt: 1, maxAttempts: 3 },
  });
  const second = await e.sessions.workerReport("wkr-6", { status: "progress", summary: SAME_SUMMARY, awaiting: "background" });
  check("(6) re-report that ONLY flips `awaiting` is NOT deduped as an echo (reported:true, not dropped)",
    second.reported === true && second.deliveryStatus !== "dropped");
  check("(6) BOTH worker_report events landed (the second was not silently swallowed)",
    e.db.listEventsForWorker("wkr-6").filter((ev) => ev.kind === "worker_report").length === 2);

  e.sessions.notifyManagerOfIdleWorker("wkr-6");
  const nudge = e.enqueued.find((x) => x.id === "mgr-6" && /worker-idle/.test(x.text));
  check("(6) the FRESH background classification took effect (the flip was actually applied)",
    !!nudge && /OWN backgrounded task/.test(nudge.text));
  cleanup(e);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a worker_report(progress) with no `awaiting` still correctly reads as awaiting-the-manager " +
    "(true positive preserved); a scheduled-wake park is unchanged and wins priority over a bare background " +
    "flag; a FRESH self-attributed background-task park gets honest 'no reply owed' wording instead of the " +
    "false 'awaiting your reply' claim; a STALE one decays to an actionable 'may be stale' nudge instead of " +
    "promising self-resume forever; and the auto-recovery dedupe correctly treats an `awaiting`-only flip as " +
    "a genuine re-report, not an echo."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
