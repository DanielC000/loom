import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// IdleWatcher test (Asleep-at-the-Wheel idle-manager watchdog, Task 3). NO claude — the watcher takes
// an injected pty-slice, so the tick tests use a RECORDING STUB and drive tick() directly. Hermetic
// like context-watcher.mjs: each env gets its OWN temp .db, imports dist/* + @loom/shared, no daemon.
// Covers the FULL trigger predicate (fires iff every clause holds), every SILENT skip path
// (snoozed / suppressed / live-worker / human-paused / idleNudgeMinutes=0 / competing recycle nudge),
// the Task-4 escalate-once-at-cap path (emits ONE idle_escalated + flips policy suppressed; a second
// tick does not re-emit), recordIdleNudge increment, reset-on-activity → 'watching', AND the carried-
// over zod fix (orchestrationOverride now accepts the three idle keys; strictness otherwise intact).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Db } from "../dist/db.js";
import { IdleWatcher } from "../dist/orchestration/idle-watcher.js";
import { OrchestrationControl } from "../dist/orchestration/control.js";
import { validateProjectConfigOverride, validateAgentProjectConfigOverride } from "../dist/mcp/platform.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const NOW = new Date("2026-06-03T12:00:00.000Z");
const minutesAgo = (m) => new Date(NOW.getTime() - m * 60_000).toISOString();

function makeEnv({ recycleRatio = 0.8, projectConfig = {} } = {}) {
  const dbFile = path.join(os.tmpdir(), `loom-idle-w-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Db(dbFile);
  const projId = `ip-${Math.random().toString(36).slice(2, 8)}`;
  const agentId = `it-${Math.random().toString(36).slice(2, 8)}`;
  const now = NOW.toISOString();
  db.insertProject({ id: projId, name: "Idle", repoPath: projId, vaultPath: projId, config: projectConfig, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });
  const alive = new Set();
  const enqueued = [];
  const pty = {
    isAlive: (id) => alive.has(id),
    enqueueStdin: (id, text) => { enqueued.push({ id, text }); return { delivered: true }; },
  };
  const control = new OrchestrationControl();
  const watcher = new IdleWatcher({ db, pty, control, recycleRatio });
  return { dbFile, db, projId, agentId, alive, enqueued, control, watcher };
}

// Seed a manager. Defaults make it eligible to nudge (idle 60m, not busy, no ctx pressure, live).
function seedManager(e, id, { idleMin = 60, busy = false, model = null, ctx = null, live = true } = {}) {
  e.db.insertSession({
    id, projectId: e.projId, agentId: e.agentId, engineSessionId: "eng-" + id, title: null, cwd: e.projId,
    processState: live ? "live" : "exited", resumability: "resumable", busy,
    createdAt: minutesAgo(idleMin), lastActivity: minutesAgo(idleMin), lastError: null, role: "manager",
    ctxInputTokens: ctx, ctxTurns: ctx == null ? null : 1, model,
  });
  if (live) e.alive.add(id);
}
function seedWorker(e, id, parentId, { live = true } = {}) {
  const now = NOW.toISOString();
  e.db.insertSession({
    id, projectId: e.projId, agentId: e.agentId, engineSessionId: "eng-" + id, title: null, cwd: e.projId,
    processState: live ? "live" : "exited", resumability: "resumable", busy: false,
    createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: parentId, taskId: "tk-" + id,
  });
  if (live) e.alive.add(id);
}
function seedTodo(e, n) {
  for (let i = 0; i < n; i++) {
    e.db.insertTask({ id: `tk-todo-${i}-${Math.random().toString(36).slice(2, 6)}`, projectId: e.projId,
      title: `t${i}`, body: "", columnKey: "todo", position: i, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() });
  }
}
// Seed one card in an explicit column key (for the multi-lane actionable-count test).
function seedCard(e, columnKey) {
  e.db.insertTask({ id: `tk-${columnKey}-${Math.random().toString(36).slice(2, 6)}`, projectId: e.projId,
    title: columnKey, body: "", columnKey, position: 0, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() });
}
// Seed one card with an explicit title (for the owner-held/HOLD discount test) and an optional `held` flag.
function seedTitled(e, columnKey, title, held = false) {
  e.db.insertTask({ id: `tk-${columnKey}-${Math.random().toString(36).slice(2, 6)}`, projectId: e.projId,
    title, body: "", columnKey, held, position: 0, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() });
}
function cleanup(e) {
  try { e.db.close(); } catch { /* ignore */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(e.dbFile + ext, { force: true }); } catch { /* ignore */ } }
}

// ============================ (1) FIRES when the full predicate holds ============================
{
  const e = makeEnv();
  seedManager(e, "mgr-idle");
  seedTodo(e, 7);
  e.watcher.tick(NOW);
  check("(1) idle manager (no workers / watching / unpaused / under cap) IS nudged", e.enqueued.length === 1 && e.enqueued[0].id === "mgr-idle");
  check("(1) nudge text asks WHY + steers to idle_report", e.enqueued[0]?.text.includes("idle_report") && /why are you idle/i.test(e.enqueued[0]?.text));
  check("(1) nudge reports the actionable card count", e.enqueued[0]?.text.includes("7 actionable"));
  const s = e.db.getIdleNudgeState("mgr-idle");
  check("(1) recordIdleNudge incremented unanswered 0→1 + stamped last_idle_nudge_at", s?.unanswered === 1 && s?.lastIdleNudgeAt === NOW.toISOString());
  cleanup(e);
}

// ===== (1b) the nudge counts ALL actionable lanes (not just workReady), excluding terminal + humanHold =====
{
  const e = makeEnv();
  seedManager(e, "mgr-multilane");
  // Default board: actionable = every lane EXCEPT done (terminal) + blocked (humanHold).
  seedCard(e, "inbox");        // intake      → actionable
  seedCard(e, "backlog");      // defaultLanding → actionable
  seedCard(e, "todo");         // workReady   → actionable
  seedCard(e, "in_progress");  // active      → actionable
  seedCard(e, "review");       // review      → actionable
  seedCard(e, "waiting");      // parked      → actionable
  seedCard(e, "blocked");      // humanHold   → EXCLUDED
  seedCard(e, "done");         // terminal    → EXCLUDED
  e.watcher.tick(NOW);
  check("(1b) counts ALL actionable lanes (6), excluding the blocked + done lanes",
    e.enqueued.length === 1 && e.enqueued[0].text.includes("6 actionable"));
  cleanup(e);
}

// ===== (1c) owner-gated cards are DISCOUNTED from the actionable count off the STRUCTURED `held` flag =====
// (card 788274a9 — the discount now keys SOLELY off Task.held, NOT an uppercase HOLD/CONFIRM title regex.)
// A held=true card as the SOLE open card → NO nudge (the manager can't action or clear it; `blocked` is the
// sole owner brake). A genuinely-actionable card still nudges.
{
  const e = makeEnv();
  seedManager(e, "mgr-held-only");
  seedTitled(e, "todo", "big owner decision parked here", true); // held=true
  e.watcher.tick(NOW);
  check("(1c) a held=true card as the sole todo → NO idle nudge (discounted, not a deadlock-nag)", e.enqueued.length === 0);
  cleanup(e);
}
{
  // FALSE-POSITIVE GONE: a real, actionable card whose title merely CONTAINS uppercase HOLD/CONFIRM but is
  // held=false IS counted + nudges (the old OWNER_HELD_TITLE_RE would have wrongly discounted it).
  const e = makeEnv();
  seedManager(e, "mgr-confirm-titled");
  seedTitled(e, "todo", "fix(pty): wire run-role — CONFIRM run-role intent first", false); // held=false
  e.watcher.tick(NOW);
  check("(1c) a CONFIRM/HOLD-TITLED but held=false card IS counted + nudges (title false-positive gone)",
    e.enqueued.length === 1 && e.enqueued[0].id === "mgr-confirm-titled" && e.enqueued[0].text.includes("1 actionable"));
  cleanup(e);
}
{
  // A genuinely-actionable card alongside a held one → STILL nudges, and the count EXCLUDES the held card.
  const e = makeEnv();
  seedManager(e, "mgr-mixed");
  seedTitled(e, "todo", "big decision", true);              // held=true → discounted
  seedTitled(e, "todo", "fix(web): real actionable task", false); // held=false → counted
  e.watcher.tick(NOW);
  check("(1c) a held + a genuine card → STILL nudged (genuine work exists)", e.enqueued.length === 1 && e.enqueued[0].id === "mgr-mixed");
  check("(1c) the reported actionable count EXCLUDES the held card (1, not 2)", e.enqueued[0]?.text.includes("1 actionable"));
  cleanup(e);
}
{
  // A genuine held=false card DOES nudge (the third DoD direction, explicit).
  const e = makeEnv();
  seedManager(e, "mgr-genuine-todo");
  seedTitled(e, "todo", "fix(web): ordinary actionable card", false);
  e.watcher.tick(NOW);
  check("(1c) a genuine held=false card DOES nudge", e.enqueued.length === 1 && e.enqueued[0].text.includes("1 actionable"));
  cleanup(e);
}
{
  // A truly EMPTY board (no held cards either) still nudges — the manager should idle_report 'done'.
  const e = makeEnv();
  seedManager(e, "mgr-empty-board");
  e.watcher.tick(NOW);
  check("(1c) an empty board (0 cards, none held) STILL nudges (report 'done' path unchanged)", e.enqueued.length === 1 && e.enqueued[0].text.includes("0 actionable"));
  cleanup(e);
}

// ===== (1d) one-time held backfill seeds the flag from legacy HOLD/CONFIRM titles (card 788274a9) =====
// The transitional path: cards intentionally parked by the OLD title heuristic must keep their discount
// once the flag is authoritative. backfillHeldFromTitlesOnce seeds held=true on matching-titled cards,
// leaves non-matching cards held=false, and is one-shot (a second call is a no-op).
{
  const e = makeEnv();
  seedTitled(e, "todo", "[HOLD — owner go required] big decision");          // matches → seeded held
  seedTitled(e, "todo", "fix(pty): … — CONFIRM run-role intent first");      // matches → seeded held
  seedTitled(e, "todo", "fix(web): ordinary actionable card");               // no match → stays held=false
  seedTitled(e, "todo", "lowercase confirm/hold prose should not match");    // lowercase → no match
  const tasks = () => e.db.listTasks(e.projId);
  check("(1d) precondition: all four cards start held=false", tasks().every((t) => t.held === false));
  const n = e.db.backfillHeldFromTitlesOnce();
  check("(1d) backfill flips exactly the 2 uppercase HOLD/CONFIRM-titled cards", n === 2);
  const heldTitles = tasks().filter((t) => t.held).map((t) => t.title);
  check("(1d) the HOLD-titled card is now held", heldTitles.some((t) => t.includes("[HOLD")));
  check("(1d) the CONFIRM-titled card is now held", heldTitles.some((t) => t.includes("CONFIRM")));
  check("(1d) the ordinary + lowercase cards stay held=false", tasks().filter((t) => !t.held).length === 2);
  // One-shot: a second invocation is a clean no-op (returns 0, flips nothing more).
  check("(1d) a second backfill is a no-op (one-shot marker)", e.db.backfillHeldFromTitlesOnce() === 0);
  cleanup(e);
}

// ============================ (2) SILENT — not idle long enough ============================
{
  const e = makeEnv();
  seedManager(e, "mgr-fresh", { idleMin: 10 }); // < 45 default
  e.watcher.tick(NOW);
  check("(2) manager idle only 10m (< 45) is NOT nudged", e.enqueued.length === 0);
  cleanup(e);
}

// ============================ (3) SILENT — busy ============================
{
  const e = makeEnv();
  seedManager(e, "mgr-busy", { busy: true });
  e.watcher.tick(NOW);
  check("(3) busy (mid-turn) manager is NOT nudged", e.enqueued.length === 0);
  cleanup(e);
}

// ============================ (4) SILENT — snoozed / suppressed ============================
{
  const e = makeEnv();
  seedManager(e, "mgr-snoozed");
  seedManager(e, "mgr-suppressed");
  e.db.setIdleNudgePolicy("mgr-snoozed", "snoozed", minutesAgo(-30)); // snooze until 30m in the FUTURE
  e.db.setIdleNudgePolicy("mgr-suppressed", "suppressed");
  e.watcher.tick(NOW);
  check("(4) snoozed manager is NOT nudged", !e.enqueued.some((x) => x.id === "mgr-snoozed"));
  check("(4) suppressed manager is NOT nudged", !e.enqueued.some((x) => x.id === "mgr-suppressed"));
  cleanup(e);
}
// Timed snooze EXPIRY: a 'snoozed' manager whose snooze_until is in the PAST is re-armed and nudged.
{
  const e = makeEnv();
  seedManager(e, "mgr-snooze-elapsed");
  e.db.setIdleNudgePolicy("mgr-snooze-elapsed", "snoozed", minutesAgo(5)); // snooze elapsed 5m ago
  e.watcher.tick(NOW);
  const s = e.db.getIdleNudgeState("mgr-snooze-elapsed");
  check("(4b) elapsed snooze → re-armed to 'watching' (snooze cleared)", s?.policy === "watching" && s?.snoozeUntil === null);
  check("(4b) elapsed-snooze manager IS nudged this tick", e.enqueued.some((x) => x.id === "mgr-snooze-elapsed"));
  cleanup(e);
}
// 'suppressed' does NOT timed-expire: a past snooze_until must NOT re-arm or nudge it (sticky till Task 4).
{
  const e = makeEnv();
  seedManager(e, "mgr-suppressed-past");
  e.db.setIdleNudgePolicy("mgr-suppressed-past", "suppressed", minutesAgo(5)); // past ts, but suppressed
  e.watcher.tick(NOW);
  const s = e.db.getIdleNudgeState("mgr-suppressed-past");
  check("(4c) suppressed manager with a PAST snooze_until stays 'suppressed' (never timed-expires)", s?.policy === "suppressed");
  check("(4c) suppressed manager is NOT nudged", !e.enqueued.some((x) => x.id === "mgr-suppressed-past"));
  cleanup(e);
}

// ============================ (5) SILENT — has a live worker ============================
{
  const e = makeEnv();
  seedManager(e, "mgr-with-worker");
  seedWorker(e, "wkr-live", "mgr-with-worker", { live: true });
  e.watcher.tick(NOW);
  check("(5) manager WITH a live worker is NOT nudged (legitimately waiting)", e.enqueued.length === 0);
  cleanup(e);
}
// ...but an EXITED worker doesn't shield it.
{
  const e = makeEnv();
  seedManager(e, "mgr-dead-worker");
  seedWorker(e, "wkr-dead", "mgr-dead-worker", { live: false });
  e.watcher.tick(NOW);
  check("(5b) manager whose only worker EXITED is nudged (no live workers)", e.enqueued.length === 1 && e.enqueued[0].id === "mgr-dead-worker");
  cleanup(e);
}

// ============================ (6) SILENT — human-paused (global or own scope) ============================
{
  const e = makeEnv();
  seedManager(e, "mgr-paused-self");
  seedManager(e, "mgr-paused-global");
  e.control.pause("mgr-paused-self");
  e.watcher.tick(NOW);
  check("(6) own-scope-paused manager is NOT nudged", !e.enqueued.some((x) => x.id === "mgr-paused-self"));
  check("(6) sibling (unpaused) manager still nudged", e.enqueued.some((x) => x.id === "mgr-paused-global"));
  // now pause globally → nobody nudged
  const e2 = makeEnv();
  seedManager(e2, "mgr-g1"); seedManager(e2, "mgr-g2");
  e2.control.pause("global");
  e2.watcher.tick(NOW);
  check("(6) global pause silences ALL managers", e2.enqueued.length === 0);
  cleanup(e); cleanup(e2);
}

// ============================ (7) ESCALATE ONCE — unanswered ≥ cap (Task 4) ============================
{
  const e = makeEnv();
  seedManager(e, "mgr-capped");
  // two unanswered nudges stamped in the PAST (so the re-nudge cadence wouldn't itself block) → at cap (2).
  e.db.recordIdleNudge("mgr-capped", minutesAgo(120));
  e.db.recordIdleNudge("mgr-capped", minutesAgo(60));
  check("(7) precondition: unanswered === maxUnansweredNudges (2)", e.db.getIdleNudgeState("mgr-capped")?.unanswered === 2);
  const escalations = () => e.db.listEvents("mgr-capped").filter((ev) => ev.kind === "idle_escalated");
  e.watcher.tick(NOW);
  check("(7) at/over the cap → does NOT enqueue another nudge (the event is the signal, not a nudge)", e.enqueued.length === 0);
  const esc = escalations();
  check("(7) at/over the cap → emits exactly ONE idle_escalated event", esc.length === 1);
  check("(7) idle_escalated detail carries reason=unanswered_cap + the unanswered count", esc[0]?.detail?.reason === "unanswered_cap" && esc[0]?.detail?.unanswered === 2);
  check("(7) escalation flips policy to 'suppressed' (stops nudging + gates re-emit)", e.db.getIdleNudgeState("mgr-capped")?.policy === "suppressed");
  // A SECOND tick must NOT re-emit (suppressed → policy gate skips it; escalate exactly once).
  e.watcher.tick(NOW);
  check("(7) a second tick does NOT re-emit idle_escalated (escalate exactly once)", escalations().length === 1);
  check("(7) a second tick still enqueues no nudge", e.enqueued.length === 0);
  cleanup(e);
}
// Escalation passes the SAME predicate a nudge does: a capped manager that is human-paused is NOT
// escalated (the human already owns it) — no idle_escalated event, policy stays 'watching'.
{
  const e = makeEnv();
  seedManager(e, "mgr-capped-paused");
  e.db.recordIdleNudge("mgr-capped-paused", minutesAgo(120));
  e.db.recordIdleNudge("mgr-capped-paused", minutesAgo(60)); // at cap (2)
  e.control.pause("mgr-capped-paused");
  e.watcher.tick(NOW);
  check("(7b) capped + human-paused → NOT escalated (no idle_escalated event)", e.db.listEvents("mgr-capped-paused").filter((ev) => ev.kind === "idle_escalated").length === 0);
  check("(7b) capped + human-paused → policy unchanged ('watching')", e.db.getIdleNudgeState("mgr-capped-paused")?.policy === "watching");
  cleanup(e);
}
// ...and a capped manager with a LIVE worker is NOT escalated (legitimately waiting on the worker).
{
  const e = makeEnv();
  seedManager(e, "mgr-capped-worker");
  seedWorker(e, "wkr-live-2", "mgr-capped-worker", { live: true });
  e.db.recordIdleNudge("mgr-capped-worker", minutesAgo(120));
  e.db.recordIdleNudge("mgr-capped-worker", minutesAgo(60)); // at cap (2)
  e.watcher.tick(NOW);
  check("(7c) capped + live worker → NOT escalated (no idle_escalated event)", e.db.listEvents("mgr-capped-worker").filter((ev) => ev.kind === "idle_escalated").length === 0);
  check("(7c) capped + live worker → policy unchanged ('watching')", e.db.getIdleNudgeState("mgr-capped-worker")?.policy === "watching");
  cleanup(e);
}

// ============================ (8) SILENT — re-nudge cadence (recently nudged) ============================
{
  const e = makeEnv();
  seedManager(e, "mgr-recent-nudge");
  e.db.recordIdleNudge("mgr-recent-nudge", minutesAgo(10)); // nudged 10m ago (< 45) → wait
  e.watcher.tick(NOW);
  check("(8) a manager nudged 10m ago is NOT re-nudged within the leash window", e.enqueued.length === 0);
  cleanup(e);
}

// ============================ (9) SILENT — idleNudgeMinutes = 0 disables the project ============================
{
  const e = makeEnv({ projectConfig: { orchestration: { idleNudgeMinutes: 0 } } });
  seedManager(e, "mgr-disabled", { idleMin: 999 });
  e.watcher.tick(NOW);
  check("(9) idleNudgeMinutes=0 disables the watcher for that project", e.enqueued.length === 0);
  cleanup(e);
}

// ============================ (10) SILENT — competing recycle nudge pending ============================
{
  const e = makeEnv({ recycleRatio: 0.8 });
  // 900k / 1M Opus window = 0.9 ≥ 0.8 → a recycle nudge is pending; idle defers.
  seedManager(e, "mgr-near-full", { ctx: 900_000, model: "claude-opus-4-8" });
  // and a sibling well under the ratio is still nudged.
  seedManager(e, "mgr-roomy", { ctx: 100_000, model: "claude-opus-4-8" });
  e.watcher.tick(NOW);
  check("(10) near-full manager (recycle pending) is NOT idle-nudged", !e.enqueued.some((x) => x.id === "mgr-near-full"));
  check("(10) manager with context headroom IS nudged", e.enqueued.some((x) => x.id === "mgr-roomy"));
  cleanup(e);
}

// ============================ (11) per-project override honored (idleNudgeMinutes:90) ============================
{
  const e = makeEnv({ projectConfig: { orchestration: { idleNudgeMinutes: 90 } } });
  seedManager(e, "mgr-60", { idleMin: 60 }); // 60 < 90 → not yet
  e.watcher.tick(NOW);
  check("(11) per-project idleNudgeMinutes=90 → 60m-idle manager NOT yet nudged", e.enqueued.length === 0);
  cleanup(e);
}

// ============================ (12) reset-on-activity → back to 'watching' ============================
{
  const e = makeEnv();
  // A manager that WAS nudged (unanswered 1, nudged 30m ago) but has since produced REAL work
  // (spawn_worker 5m ago) and is currently active → reset, and not re-nudged this tick.
  e.db.insertSession({
    id: "mgr-resumed", projectId: e.projId, agentId: e.agentId, engineSessionId: "eng-r", title: null, cwd: e.projId,
    processState: "live", resumability: "resumable", busy: false,
    createdAt: minutesAgo(120), lastActivity: minutesAgo(5), lastError: null, role: "manager",
    ctxInputTokens: null, ctxTurns: null, model: null,
  });
  e.alive.add("mgr-resumed");
  e.db.recordIdleNudge("mgr-resumed", minutesAgo(30)); // unanswered → 1, last_idle_nudge_at = 30m ago
  e.db.appendEvent({ id: randomUUID(), ts: minutesAgo(5), managerSessionId: "mgr-resumed", kind: "spawn_worker", detail: {} });
  e.watcher.tick(NOW);
  const s = e.db.getIdleNudgeState("mgr-resumed");
  check("(12) reset-on-activity: genuine work after last nudge → policy back to 'watching'", s?.policy === "watching");
  check("(12) reset-on-activity: unanswered zeroed", s?.unanswered === 0);
  check("(12) reset-on-activity: a just-active manager is NOT re-nudged this tick", e.enqueued.length === 0);
  cleanup(e);
}
// An idle_report event does NOT count as activity (it's the nudge ANSWER; must not undo the policy).
{
  const e = makeEnv();
  seedManager(e, "mgr-snoozed-then-report");
  e.db.recordIdleNudge("mgr-snoozed-then-report", minutesAgo(60)); // unanswered 1
  e.db.setIdleNudgePolicy("mgr-snoozed-then-report", "snoozed", minutesAgo(-30)); // snoozed into the future
  e.db.appendEvent({ id: randomUUID(), ts: minutesAgo(5), managerSessionId: "mgr-snoozed-then-report", kind: "idle_report", detail: {} });
  e.watcher.tick(NOW);
  const s = e.db.getIdleNudgeState("mgr-snoozed-then-report");
  check("(12b) an idle_report event does NOT trigger reset (stays 'snoozed', silent)", s?.policy === "snoozed" && e.enqueued.length === 0);
  cleanup(e);
}

// ============================ (13) only managers; not live ============================
{
  const e = makeEnv();
  // a plain (roleless) idle live session must be ignored (listLiveManagers is manager-only).
  e.db.insertSession({
    id: "plain-idle", projectId: e.projId, agentId: e.agentId, engineSessionId: "ep", title: null, cwd: e.projId,
    processState: "live", resumability: "resumable", busy: false, createdAt: minutesAgo(99), lastActivity: minutesAgo(99),
    lastError: null, role: null, ctxInputTokens: null, ctxTurns: null, model: null,
  });
  e.alive.add("plain-idle");
  // an EXITED manager is not live → ignored.
  seedManager(e, "mgr-exited", { live: false });
  e.watcher.tick(NOW);
  check("(13) plain (roleless) session ignored; exited manager ignored", e.enqueued.length === 0);
  cleanup(e);
}

// ============================ (14) zod orchestrationOverride accepts the three idle keys ============================
{
  const full = validateProjectConfigOverride({ orchestration: { idleNudgeMinutes: 10, maxUnansweredNudges: 5, idleDefaultSnoozeMinutes: 90 } });
  check("(14) REST validator accepts idleNudgeMinutes/maxUnansweredNudges/idleDefaultSnoozeMinutes", full.ok === true);
  const agent = validateAgentProjectConfigOverride({ orchestration: { idleNudgeMinutes: 10, maxUnansweredNudges: 5, idleDefaultSnoozeMinutes: 90 } });
  check("(14) agent (loom-platform MCP) validator accepts the three idle keys", agent.ok === true);
  // strictness still intact: an unknown orchestration key is rejected.
  const bad = validateProjectConfigOverride({ orchestration: { bogusKey: 1 } });
  check("(14) .strict() still rejects an unknown orchestration key", bad.ok === false);
  // values flow through unchanged.
  check("(14) accepted values round-trip on the parsed value", full.ok && full.value.orchestration?.idleNudgeMinutes === 10 && full.value.orchestration?.maxUnansweredNudges === 5);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — IdleWatcher nudges an idle, worker-free, watching, unpaused, under-cap, context-roomy MANAGER exactly once per leash window (recordIdleNudge increments); is SILENT when busy / fresh / snoozed / suppressed / has-a-live-worker / human-paused / recently-nudged / disabled(0) / recycle-pending; ESCALATES ONCE at the unanswered cap (one idle_escalated event + policy→suppressed, no re-emit on a later tick); honors per-project idleNudgeMinutes; resets to 'watching' on genuine new orchestration activity (ignoring idle_report); and the zod orchestrationOverride now accepts the three idle config keys (strictness intact)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
