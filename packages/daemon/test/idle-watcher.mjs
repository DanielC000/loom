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

function makeEnv({ recycleRatio = 0.8, projectConfig = {}, isWorkerStranded = () => true } = {}) {
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
  // Recording stub for the idle-WORKER coverage (board card b9d479b0) — a unit-level double, NOT the real
  // SessionService.notifyManagerOfIdleWorker reconciliation (that integration is covered end-to-end in
  // idle-worker-watcher.mjs). Here we only assert the WATCHER's own gating (staleness/cadence/disable/pause).
  const idleWorkerNudges = [];
  const notifyIdleWorker = (id) => { idleWorkerNudges.push(id); };
  // CR blocker #2 fold-in: isWorkerStranded single-sources SessionService.isWorkerGenuinelyStranded for the
  // manager-loop message. Defaults to `true` (every live idle worker counts as stranded) so pre-existing
  // tests that don't care about this narrowing are unaffected; per-test overrides exercise the narrowing
  // itself (see (5d)/(5e) below) — the REAL predicate is exercised end-to-end in idle-worker-watcher.mjs.
  const watcher = new IdleWatcher({ db, pty, control, recycleRatio, notifyIdleWorker, isWorkerStranded });
  return { dbFile, db, projId, agentId, alive, enqueued, control, watcher, idleWorkerNudges };
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
// Seed a platform (Lead) session — SAME shape as seedManager (card 98b3725c: IdleWatcher covers both
// via listLiveManagers + listLivePlatformSessions), just role:"platform". A Lead is never parented to
// (spawnSessionAsPlatform never sets parentSessionId), so db.listWorkers(id) is always [] for it — no
// seedWorker call ever targets a platform id in these tests, by design.
function seedPlatform(e, id, { idleMin = 60, busy = false, live = true } = {}) {
  e.db.insertSession({
    id, projectId: e.projId, agentId: e.agentId, engineSessionId: "eng-" + id, title: null, cwd: e.projId,
    processState: live ? "live" : "exited", resumability: "resumable", busy,
    createdAt: minutesAgo(idleMin), lastActivity: minutesAgo(idleMin), lastError: null, role: "platform",
  });
  if (live) e.alive.add(id);
}
function seedWorker(e, id, parentId, { live = true, busy = false, idleMin = 0 } = {}) {
  e.db.insertSession({
    id, projectId: e.projId, agentId: e.agentId, engineSessionId: "eng-" + id, title: null, cwd: e.projId,
    processState: live ? "live" : "exited", resumability: "resumable", busy,
    createdAt: minutesAgo(idleMin), lastActivity: minutesAgo(idleMin), lastError: null, role: "worker", parentSessionId: parentId, taskId: "tk-" + id,
  });
  if (live) e.alive.add(id);
}
// The active-lane task a worker's idle-nudge pre-filter checks (tickIdleWorkers / notifyManagerOfIdleWorker
// both proxy "did it report" off the task's column). columnKey defaults to the board's active lane.
function seedWorkerTask(e, workerId, columnKey = "in_progress") {
  e.db.insertTask({ id: "tk-" + workerId, projectId: e.projId, title: "t-" + workerId, body: "", columnKey, position: 0, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() });
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
// Seed one card with an explicit title (for the owner-held/HOLD discount test) and optional `held`/
// `deferred` flags (deferred: card 77d33266 — the manager's own sequencing marker, discounted the
// same way as held).
function seedTitled(e, columnKey, title, held = false, deferred = false) {
  e.db.insertTask({ id: `tk-${columnKey}-${Math.random().toString(36).slice(2, 6)}`, projectId: e.projId,
    title, body: "", columnKey, held, deferred, position: 0, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() });
}
// Seed a connected owner Request (question) on a task — the same taskId->questions linkage tasks_get's
// connected-requests summary / task_requests_list use. sessionId must be a live row (FK) — pass the
// manager's own id, mirroring how a manager's own question_ask call would be attributed.
function seedQuestion(e, sessionId, taskId, state = "pending") {
  const id = `q-${Math.random().toString(36).slice(2, 8)}`;
  e.db.insertQuestion({
    id, sessionId, projectId: e.projId, type: "decision", title: "a decision", body: "",
    options: null, recommendation: null, taskId,
    permissionAction: null, permissionScope: null, permissionExpiresAt: null, credentialEnvVar: null,
    state, chosenOption: null, note: null, createdAt: NOW.toISOString(),
    answeredAt: state !== "pending" ? NOW.toISOString() : null, consumedAt: null,
  });
  return id;
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

// ===== (1b) the nudge counts ALL actionable lanes (not just workReady), excluding terminal + review =====
// (Board Hold Model redesign: the `blocked` column / `humanHold` role is retired — there is no longer a
// column-based exclusion for it. A card on ANY non-terminal, non-review lane, including one literally
// keyed "blocked", counts as actionable unless it is explicitly `held` — see (1c) below for the
// held-based exclusion. The REVIEW lane IS a column-based exclusion, role-resolved — see (1f) below.)
{
  const e = makeEnv();
  seedManager(e, "mgr-multilane");
  // Default board: actionable = every lane EXCEPT done (terminal) and review (awaiting merge review).
  seedCard(e, "inbox");        // intake      → actionable
  seedCard(e, "backlog");      // defaultLanding → actionable
  seedCard(e, "todo");         // workReady   → actionable
  seedCard(e, "in_progress");  // active      → actionable
  seedCard(e, "review");       // review      → EXCLUDED (not dispatchable — awaiting merge review)
  seedCard(e, "waiting");      // parked      → actionable
  seedCard(e, "done");         // terminal    → EXCLUDED
  e.watcher.tick(NOW);
  check("(1b) counts actionable lanes (5), excluding the done lane AND the review lane",
    e.enqueued.length === 1 && e.enqueued[0].text.includes("5 actionable"));
  cleanup(e);
}

// ===== (1c) owner-gated cards are DISCOUNTED from the actionable count off the STRUCTURED `held` flag =====
// (card 788274a9 — the discount now keys SOLELY off Task.held, NOT an uppercase HOLD/CONFIRM title regex.)
// A held=true card as the SOLE open card → NO nudge (the manager can't action or clear it; `held` is the
// sole owner brake — Board Hold Model). A genuinely-actionable card still nudges.
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

// ===== (1e) manager-set `deferred` cards are DISCOUNTED from the actionable count, same as `held` =====
// (card 77d33266 — deferred is the MANAGER's own sequencing marker, orthogonal to the owner's `held`
// brake: it must never block worker_spawn, but IS excluded from the idle nag count exactly like held.)
{
  // A deferred=true card as the SOLE open card → NO nudge, same treatment as a held-only card.
  const e = makeEnv();
  seedManager(e, "mgr-deferred-only");
  seedTitled(e, "todo", "manager is sequencing this behind other work", false, true); // deferred=true
  e.watcher.tick(NOW);
  check("(1e) a deferred=true card as the sole todo → NO idle nudge (discounted like held)", e.enqueued.length === 0);
  cleanup(e);
}
{
  // A genuinely-actionable card alongside a deferred one → STILL nudges, and the count EXCLUDES the deferred card.
  const e = makeEnv();
  seedManager(e, "mgr-deferred-mixed");
  seedTitled(e, "todo", "sequenced behind other work", false, true);          // deferred=true → discounted
  seedTitled(e, "todo", "fix(web): real actionable task", false, false);      // neither → counted
  e.watcher.tick(NOW);
  check("(1e) a deferred + a genuine card → STILL nudged (genuine work exists)", e.enqueued.length === 1 && e.enqueued[0].id === "mgr-deferred-mixed");
  check("(1e) the reported actionable count EXCLUDES the deferred card (1, not 2)", e.enqueued[0]?.text.includes("1 actionable"));
  cleanup(e);
}
{
  // held + deferred are BOTH independently discounted — a card carrying only one of the two flags is
  // still excluded, and a board with one held-only + one deferred-only card (both discounted) nudges 0.
  const e = makeEnv();
  seedManager(e, "mgr-held-and-deferred");
  seedTitled(e, "todo", "owner-held card", true, false);      // held=true, deferred=false → discounted
  seedTitled(e, "todo", "manager-deferred card", false, true); // held=false, deferred=true → discounted
  e.watcher.tick(NOW);
  check("(1e) a held-only card AND a deferred-only card together → NO nudge (both discounted independently)", e.enqueued.length === 0);
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

// ===== (1f) REVIEW-lane cards are DISCOUNTED from the actionable TALLY (role-resolved), but a review =====
// ===== card still keeps the nudge ALIVE — merging IS manager-actionable work, unlike held/deferred =====
// (idle-watcher overcount fix): a card sitting in the review lane is awaiting the manager's OWN merge
// review, so it's excluded from the dispatch-facing "N actionable" count (it isn't NEW work to spawn a
// worker onto). But unlike held/deferred/pending-request (genuinely nothing the manager itself can do),
// a review-lane card IS the manager's own next step — so its presence must NOT be treated as "nothing to
// action" and silence the nudge entirely (that would regress the existing done-worker → review-lane →
// idle-nudge coverage: a manager that forgot to merge a shipped worker must still get nagged). Identified
// via columnKeyForRole(cols, "review"), never a hardcoded "review" key, so a project with renamed/
// reordered columns still identifies the right lane.
{
  const e = makeEnv();
  seedManager(e, "mgr-review-only");
  seedCard(e, "review"); // sole open card, sitting in review
  e.watcher.tick(NOW);
  check("(1f) a review-lane card as the sole open card → STILL nudged (go merge it)", e.enqueued.length === 1 && e.enqueued[0].id === "mgr-review-only");
  check("(1f) the reported actionable count EXCLUDES the review card (0, not 1 — it's not new dispatch work)",
    e.enqueued[0]?.text.includes("0 actionable"));
  cleanup(e);
}
{
  // A genuinely-actionable card alongside a review-lane one → STILL nudges; the count EXCLUDES the review card.
  const e = makeEnv();
  seedManager(e, "mgr-review-mixed");
  seedCard(e, "review");                                           // discounted from the tally
  seedTitled(e, "todo", "fix(web): real actionable task", false);  // counted
  e.watcher.tick(NOW);
  check("(1f) a review + a genuine card → STILL nudged (genuine work exists)", e.enqueued.length === 1 && e.enqueued[0].id === "mgr-review-mixed");
  check("(1f) the reported actionable count EXCLUDES the review card (1, not 2)", e.enqueued[0]?.text.includes("1 actionable"));
  cleanup(e);
}
{
  // A project with a CUSTOM review-role column key (not the literal "review" string) is still identified
  // correctly — proves the identification is role-based, not a hardcoded key.
  const e = makeEnv({ projectConfig: { kanbanColumns: [
    { key: "backlog", label: "Backlog", role: "defaultLanding" },
    { key: "doing", label: "Doing", role: "active" },
    { key: "awaiting_merge", label: "Awaiting Merge", role: "review" },
    { key: "shipped", label: "Shipped", role: "terminal" },
  ] } });
  seedManager(e, "mgr-custom-review");
  seedCard(e, "awaiting_merge"); // sole open card, custom-keyed review lane
  e.watcher.tick(NOW);
  check("(1f) a CUSTOM-keyed review-role column is STILL nudged (role-resolved, not hardcoded)", e.enqueued.length === 1 && e.enqueued[0].id === "mgr-custom-review");
  check("(1f) and its tally still excludes that custom-keyed review card (0 actionable)", e.enqueued[0]?.text.includes("0 actionable"));
  cleanup(e);
}

// ===== (1g) cards with a PENDING connected owner Request are DISCOUNTED; ANSWERED ones are NOT =====
// (idle-watcher overcount fix): a card gated on an unanswered owner Request is blocked on the owner, not
// dispatchable by the manager. Reuses the same taskId→questions linkage tasks_get's connected-requests
// summary / task_requests_list use (db.listQuestionsForTask) — a card whose request is already
// answered/consumed is NOT discounted (it's actionable again).
{
  const e = makeEnv();
  seedManager(e, "mgr-pending-request");
  seedCard(e, "todo");
  const task = e.db.listTasks(e.projId)[0];
  seedQuestion(e, "mgr-pending-request", task.id, "pending");
  e.watcher.tick(NOW);
  check("(1g) a card with a PENDING connected owner Request as the sole open card → NO idle nudge (blocked on owner)", e.enqueued.length === 0);
  cleanup(e);
}
{
  const e = makeEnv();
  seedManager(e, "mgr-answered-request");
  seedCard(e, "todo");
  const task = e.db.listTasks(e.projId)[0];
  seedQuestion(e, "mgr-answered-request", task.id, "answered");
  e.watcher.tick(NOW);
  check("(1g) a card whose connected Request is ALREADY ANSWERED is NOT discounted (actionable again)",
    e.enqueued.length === 1 && e.enqueued[0].text.includes("1 actionable"));
  cleanup(e);
}
{
  // Mixed: a pending-request card + a genuine card → still nudges, count excludes only the gated one.
  // The Request is filed by a session under an UNRELATED agent lineage (not "mgr-pending-mixed" itself)
  // so this isolates the per-card discount from the SESSION-level suppression card cb56cf80 added below
  // (18) — that one only fires for a session's OWN pending Request, which would otherwise fully suppress
  // this manager regardless of its other actionable cards, confounding this test's card-count assertion.
  const e = makeEnv();
  seedManager(e, "mgr-pending-mixed");
  seedCard(e, "todo");
  const pendingTask = e.db.listTasks(e.projId)[0];
  const askerAgentId = `it-${Math.random().toString(36).slice(2, 8)}`;
  e.db.insertAgent({ id: askerAgentId, projectId: e.projId, name: "asker", startupPrompt: "orchestrate", position: 1 });
  e.db.insertSession({
    id: "mgr-pending-mixed-asker", projectId: e.projId, agentId: askerAgentId, engineSessionId: "eng-asker", title: null, cwd: e.projId,
    processState: "live", resumability: "resumable", busy: false,
    createdAt: minutesAgo(60), lastActivity: minutesAgo(60), lastError: null, role: "manager",
    ctxInputTokens: null, ctxTurns: null, model: null,
  });
  e.alive.add("mgr-pending-mixed-asker");
  seedQuestion(e, "mgr-pending-mixed-asker", pendingTask.id, "pending");
  seedTitled(e, "todo", "fix(web): real actionable task", false);
  e.watcher.tick(NOW);
  check("(1g) a pending-request card + a genuine card → STILL nudged, count excludes only the gated one",
    e.enqueued.length === 1 && e.enqueued[0].id === "mgr-pending-mixed" && e.enqueued[0].text.includes("1 actionable"));
  cleanup(e);
}

// ===== (1h) a column flagged excludeFromIdleWatchdog (a genuine dead-end/parking lane, e.g. "Dropped") =====
// ===== is DISCOUNTED from the actionable count, same treatment as held/deferred/review (card ab30768a) =====
const DROPPED_BOARD = {
  kanbanColumns: [
    { key: "backlog", label: "Backlog", role: "defaultLanding" },
    { key: "todo", label: "Todo", role: "workReady" },
    { key: "doing", label: "Doing", role: "active" },
    { key: "review", label: "Review", role: "review" },
    { key: "dropped", label: "Dropped", excludeFromIdleWatchdog: true },
    { key: "done", label: "Done", role: "terminal" },
  ],
};
{
  const e = makeEnv({ projectConfig: DROPPED_BOARD });
  seedManager(e, "mgr-dropped-only");
  seedCard(e, "dropped"); // sole open card, sitting in the flagged parking lane
  e.watcher.tick(NOW);
  check("(1h) a card in an excludeFromIdleWatchdog column as the sole open card → NO idle nudge (discounted)", e.enqueued.length === 0);
  cleanup(e);
}
{
  // A genuinely-actionable card alongside a dropped-lane one → STILL nudges; count EXCLUDES the dropped card.
  const e = makeEnv({ projectConfig: DROPPED_BOARD });
  seedManager(e, "mgr-dropped-mixed");
  seedCard(e, "dropped");                                          // discounted (flagged column)
  seedTitled(e, "todo", "fix(web): real actionable task", false);  // counted
  e.watcher.tick(NOW);
  check("(1h) a dropped-lane card + a genuine card → STILL nudged (genuine work exists)", e.enqueued.length === 1 && e.enqueued[0].id === "mgr-dropped-mixed");
  check("(1h) the reported actionable count EXCLUDES the dropped-lane card (1, not 2)", e.enqueued[0]?.text.includes("1 actionable"));
  cleanup(e);
}
{
  // Regression pin: the SAME board shape but WITHOUT the flag on that column → the card IS counted
  // (byte-identical to today — absent/false must not change behavior).
  const UNFLAGGED_BOARD = { kanbanColumns: DROPPED_BOARD.kanbanColumns.map((c) => {
    const { excludeFromIdleWatchdog, ...rest } = c;
    return rest;
  }) };
  const e = makeEnv({ projectConfig: UNFLAGGED_BOARD });
  seedManager(e, "mgr-unflagged");
  seedCard(e, "dropped"); // same column key, but NOT flagged this time
  e.watcher.tick(NOW);
  check("(1h) regression: the SAME column WITHOUT the flag → the card IS counted (unchanged)",
    e.enqueued.length === 1 && e.enqueued[0].id === "mgr-unflagged" && e.enqueued[0].text.includes("1 actionable"));
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

// ============================ (5) SILENT — has a live BUSY worker ============================
{
  const e = makeEnv();
  seedManager(e, "mgr-with-worker");
  seedWorker(e, "wkr-live", "mgr-with-worker", { live: true, busy: true });
  e.watcher.tick(NOW);
  check("(5) manager WITH a live BUSY worker is NOT nudged (legitimately waiting)", e.enqueued.length === 0);
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
// ============ (5c) board card b9d479b0 — a live IDLE worker no longer shields the manager ============
// The two-path asymmetry this card fixes: an idle (busy=false), unreported live worker used to silence
// the manager's OWN idle nudge (it looked "legitimately waiting"), even though nobody else was watching
// that worker either — a silent deadlock. Now the manager is still nudged, and — since it genuinely does
// have a live worker — the message must say so (not falsely claim "no live workers", the exact
// misleading shape board card 99efaab3 flags).
{
  const e = makeEnv();
  seedManager(e, "mgr-idle-stale-worker");
  seedWorker(e, "wkr-idle-stale", "mgr-idle-stale-worker", { live: true, busy: false });
  e.watcher.tick(NOW);
  check("(5c) manager WITH only an IDLE live worker IS still nudged (nobody else is watching it)",
    e.enqueued.some((x) => x.id === "mgr-idle-stale-worker"));
  const msg = e.enqueued.find((x) => x.id === "mgr-idle-stale-worker")?.text ?? "";
  check("(5c) the nudge says its live worker(s) are ALSO idle — does NOT falsely claim 'no live workers'",
    /live worker\(s\) are ALSO idle/.test(msg) && !/no live workers/.test(msg));
  cleanup(e);
}
// ======== (5d) CR blocker #2 — a live but NON-stranded worker draws NO "unreported" claim ========
// A live idle worker that's rate-limited / already reported / parked-ack is NOT stranded — the manager
// still gets its OWN idle nudge (genuine open cards exist), but the message must not allege "unreported —
// nobody else watches this" (board card 99efaab3's exact false-alarm shape) NOR falsely say "no live
// workers" (it has one, just not a stranded one).
{
  const e = makeEnv({ isWorkerStranded: () => false });
  seedManager(e, "mgr-not-stranded");
  seedWorker(e, "wkr-not-stranded", "mgr-not-stranded", { live: true, busy: false });
  seedTodo(e, 1); // a genuine open card → nudged regardless of the worker's stranded-ness
  e.watcher.tick(NOW);
  const msg = e.enqueued.find((x) => x.id === "mgr-not-stranded")?.text ?? "";
  check("(5d) manager IS still nudged (genuine open card)", msg.length > 0);
  check("(5d) the message does NOT claim the worker is 'unreported'/'nobody else watches'", !/unreported/.test(msg) && !/nobody else watches/.test(msg));
  check("(5d) the message does NOT falsely claim 'no live workers' either (it has one, just not stranded)", !/no live workers/.test(msg));
  cleanup(e);
}
// ======== (5e) CR blocker #2 — a live NON-stranded worker does NOT bypass the held/deferred skip ========
// board card b9d479b0's held/deferred-skip bypass exists ONLY because a stranded worker is independently
// actionable. A live worker that ISN'T stranded gives the manager nothing new to act on, so an
// all-held/deferred board (0 genuinely-actionable cards) must still skip silently, exactly as it would
// with no live worker at all.
{
  const e = makeEnv({ isWorkerStranded: () => false });
  seedManager(e, "mgr-not-stranded-held-board");
  seedWorker(e, "wkr-not-stranded-2", "mgr-not-stranded-held-board", { live: true, busy: false });
  seedTitled(e, "todo", "a held-only card", true, false); // held=true → 0 genuinely-actionable cards
  e.watcher.tick(NOW);
  check("(5e) a live NON-stranded worker does NOT bypass the all-held/deferred skip", e.enqueued.length === 0);
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
// ...and a capped manager with a LIVE BUSY worker is NOT escalated (legitimately waiting on the worker).
{
  const e = makeEnv();
  seedManager(e, "mgr-capped-worker");
  seedWorker(e, "wkr-live-2", "mgr-capped-worker", { live: true, busy: true });
  e.db.recordIdleNudge("mgr-capped-worker", minutesAgo(120));
  e.db.recordIdleNudge("mgr-capped-worker", minutesAgo(60)); // at cap (2)
  e.watcher.tick(NOW);
  check("(7c) capped + live BUSY worker → NOT escalated (no idle_escalated event)", e.db.listEvents("mgr-capped-worker").filter((ev) => ev.kind === "idle_escalated").length === 0);
  check("(7c) capped + live BUSY worker → policy unchanged ('watching')", e.db.getIdleNudgeState("mgr-capped-worker")?.policy === "watching");
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

// ================ (10b) recycle precedence uses the PROJECT's OWN recycleAtContextRatio ================
{
  // No env force override (recycleRatio: 0) — a project overriding recycleAtContextRatio to 0.5 should
  // defer idle-nudging a manager at 60% ctx, while a SIBLING project at the 0.8 default does NOT defer
  // (60% is under 0.8) — proving IdleWatcher resolves the recycle threshold per-project, not from a
  // single constructor-injected ratio.
  const e = makeEnv({ recycleRatio: 0, projectConfig: { orchestration: { recycleAtContextRatio: 0.5 } } });
  seedManager(e, "mgr-low-ratio-project", { ctx: 600_000, model: "claude-opus-4-8" }); // 60% of 1M

  const projId2 = `ip-${Math.random().toString(36).slice(2, 8)}`;
  const agentId2 = `it-${Math.random().toString(36).slice(2, 8)}`;
  const now = NOW.toISOString();
  e.db.insertProject({ id: projId2, name: "Idle2", repoPath: projId2, vaultPath: projId2, config: {}, createdAt: now, archivedAt: null });
  e.db.insertAgent({ id: agentId2, projectId: projId2, name: "t2", startupPrompt: "orchestrate", position: 0 });
  e.db.insertSession({
    id: "mgr-default-ratio-project", projectId: projId2, agentId: agentId2, engineSessionId: "eng-mgr-default-ratio-project",
    title: null, cwd: projId2, processState: "live", resumability: "resumable", busy: false,
    createdAt: minutesAgo(60), lastActivity: minutesAgo(60), lastError: null, role: "manager",
    ctxInputTokens: 600_000, ctxTurns: 1, model: "claude-opus-4-8",
  });
  e.alive.add("mgr-default-ratio-project");

  e.watcher.tick(NOW);
  check("(10b) manager in a 0.5-ratio project (60% ctx, over its own threshold) is NOT idle-nudged (recycle pending)",
    !e.enqueued.some((x) => x.id === "mgr-low-ratio-project"));
  check("(10b) sibling manager in a default-0.8-ratio project (same 60% ctx, under its threshold) IS idle-nudged",
    e.enqueued.some((x) => x.id === "mgr-default-ratio-project"));
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

// ============================ (14) zod orchestrationOverride accepts the four idle keys ============================
{
  const full = validateProjectConfigOverride({ orchestration: { idleNudgeMinutes: 10, maxUnansweredNudges: 5, idleDefaultSnoozeMinutes: 90, idleWorkerMinutes: 20 } });
  check("(14) REST validator accepts idleNudgeMinutes/maxUnansweredNudges/idleDefaultSnoozeMinutes/idleWorkerMinutes", full.ok === true);
  const agent = validateAgentProjectConfigOverride({ orchestration: { idleNudgeMinutes: 10, maxUnansweredNudges: 5, idleDefaultSnoozeMinutes: 90, idleWorkerMinutes: 20 } });
  check("(14) agent (loom-platform MCP) validator accepts the four idle keys", agent.ok === true);
  // strictness still intact: an unknown orchestration key is rejected.
  const bad = validateProjectConfigOverride({ orchestration: { bogusKey: 1 } });
  check("(14) .strict() still rejects an unknown orchestration key", bad.ok === false);
  // values flow through unchanged.
  check("(14) accepted values round-trip on the parsed value", full.ok && full.value.orchestration?.idleNudgeMinutes === 10 && full.value.orchestration?.maxUnansweredNudges === 5 && full.value.orchestration?.idleWorkerMinutes === 20);
}

// ============================ (15) idle-WORKER periodic coverage (board card b9d479b0) ============================
{
  const e = makeEnv();
  seedManager(e, "mgr-15", { busy: true }); // busy manager: isolate assertions to the worker-nudge path
  seedWorker(e, "wkr-15", "mgr-15", { live: true, busy: false, idleMin: 50 }); // stale 50m > default 45m window
  seedWorkerTask(e, "wkr-15"); // task tk-wkr-15 stays in the active lane ("in_progress") → unreported
  e.watcher.tick(NOW);
  check("(15) a live, idle, unreported worker stale beyond idleWorkerMinutes IS re-nudged", e.idleWorkerNudges.includes("wkr-15"));
  const s = e.db.getIdleNudgeState("wkr-15");
  check("(15) the nudge stamps last_idle_nudge_at on the WORKER's own row (paces the re-nudge cadence)", s?.lastIdleNudgeAt === NOW.toISOString());
  cleanup(e);
}
// ...not yet — under the window.
{
  const e = makeEnv();
  seedManager(e, "mgr-15b", { busy: true });
  seedWorker(e, "wkr-15b", "mgr-15b", { live: true, busy: false, idleMin: 10 }); // 10m < 45m default
  seedWorkerTask(e, "wkr-15b");
  e.watcher.tick(NOW);
  check("(15b) NOT yet — idle for less than idleWorkerMinutes", e.idleWorkerNudges.length === 0);
  cleanup(e);
}
// ...disabled per project.
{
  const e = makeEnv({ projectConfig: { orchestration: { idleWorkerMinutes: 0 } } });
  seedManager(e, "mgr-15c", { busy: true });
  seedWorker(e, "wkr-15c", "mgr-15c", { live: true, busy: false, idleMin: 999 });
  seedWorkerTask(e, "wkr-15c");
  e.watcher.tick(NOW);
  check("(15c) idleWorkerMinutes=0 disables the idle-worker watcher for that project", e.idleWorkerNudges.length === 0);
  cleanup(e);
}
// ...already reported (task left the active lane) → nothing to nudge.
{
  const e = makeEnv();
  seedManager(e, "mgr-15d", { busy: true });
  seedWorker(e, "wkr-15d", "mgr-15d", { live: true, busy: false, idleMin: 999 });
  seedWorkerTask(e, "wkr-15d", "review"); // already moved off the active lane
  e.watcher.tick(NOW);
  check("(15d) a worker whose task already left the active lane (reported/merged) is NOT re-nudged", e.idleWorkerNudges.length === 0);
  cleanup(e);
}
// ...human-paused (worker's own scope, or its manager's) → not nudged.
{
  const e = makeEnv();
  seedManager(e, "mgr-15e1", { busy: true });
  seedWorker(e, "wkr-15e1", "mgr-15e1", { live: true, busy: false, idleMin: 999 });
  seedWorkerTask(e, "wkr-15e1");
  e.control.pause("wkr-15e1");
  seedManager(e, "mgr-15e2", { busy: true });
  seedWorker(e, "wkr-15e2", "mgr-15e2", { live: true, busy: false, idleMin: 999 });
  seedWorkerTask(e, "wkr-15e2");
  e.control.pause("mgr-15e2");
  e.watcher.tick(NOW);
  check("(15e) a worker paused in its OWN scope is not re-nudged", !e.idleWorkerNudges.includes("wkr-15e1"));
  check("(15e) a worker whose MANAGER is paused is not re-nudged either", !e.idleWorkerNudges.includes("wkr-15e2"));
  cleanup(e);
}
// ...cadence: a worker already re-nudged recently doesn't fire again until another full window.
{
  const e = makeEnv();
  seedManager(e, "mgr-15f", { busy: true });
  seedWorker(e, "wkr-15f", "mgr-15f", { live: true, busy: false, idleMin: 999 }); // long-idle originally
  seedWorkerTask(e, "wkr-15f");
  e.db.recordIdleNudge("wkr-15f", minutesAgo(10)); // re-nudged 10m ago (< 45m window)
  e.watcher.tick(NOW);
  check("(15f) a worker re-nudged 10m ago is NOT re-nudged again within the leash window", e.idleWorkerNudges.length === 0);
  cleanup(e);
}

// ============================ (16) PLATFORM (Lead) coverage — card 98b3725c ============================
// The SAME manager-loop code path now also iterates listLivePlatformSessions() — proving a platform
// session gets the identical full-trigger / silent / escalate behavior a manager does, and that its
// (always-empty) worker set naturally falls into the "no live workers" message branch.
{
  // (16a) full trigger fires for an idle, watching, unpaused, under-cap platform session — same shape as (1).
  const e = makeEnv();
  seedPlatform(e, "plat-idle");
  seedTodo(e, 3);
  e.watcher.tick(NOW);
  check("(16a) idle platform (no workers / watching / unpaused / under cap) IS nudged", e.enqueued.length === 1 && e.enqueued[0].id === "plat-idle");
  check("(16a) nudge steers to idle_report same as a manager's", e.enqueued[0]?.text.includes("idle_report"));
  const s = e.db.getIdleNudgeState("plat-idle");
  check("(16a) recordIdleNudge incremented unanswered 0→1 for the platform session too", s?.unanswered === 1);
  cleanup(e);
}
{
  // (16b) snoozed / suppressed platform sessions are silent — mirrors (4).
  const e = makeEnv();
  seedPlatform(e, "plat-snoozed");
  seedPlatform(e, "plat-suppressed");
  e.db.setIdleNudgePolicy("plat-snoozed", "snoozed", minutesAgo(-30));
  e.db.setIdleNudgePolicy("plat-suppressed", "suppressed");
  e.watcher.tick(NOW);
  check("(16b) snoozed platform session is NOT nudged", !e.enqueued.some((x) => x.id === "plat-snoozed"));
  check("(16b) suppressed platform session is NOT nudged", !e.enqueued.some((x) => x.id === "plat-suppressed"));
  cleanup(e);
}
{
  // (16c) escalate-once-at-cap — mirrors (7) exactly, role:"platform".
  const e = makeEnv();
  seedPlatform(e, "plat-capped");
  e.db.recordIdleNudge("plat-capped", minutesAgo(120));
  e.db.recordIdleNudge("plat-capped", minutesAgo(60)); // at cap (2)
  const escalations = () => e.db.listEvents("plat-capped").filter((ev) => ev.kind === "idle_escalated");
  e.watcher.tick(NOW);
  check("(16c) at/over the cap → does NOT enqueue another nudge", e.enqueued.length === 0);
  check("(16c) at/over the cap → emits exactly ONE idle_escalated event", escalations().length === 1);
  check("(16c) escalation flips policy to 'suppressed'", e.db.getIdleNudgeState("plat-capped")?.policy === "suppressed");
  e.watcher.tick(NOW);
  check("(16c) a second tick does NOT re-emit idle_escalated", escalations().length === 1);
  cleanup(e);
}
{
  // (16d) db.listWorkers(leadId) is always [] (a Lead is never parented-to) — confirms the manager-shaped
  // worker checks (liveBusyWorkers skip, tickIdleWorkers) silently no-op instead of ever engaging for it.
  const e = makeEnv();
  seedPlatform(e, "plat-noworkers");
  seedTodo(e, 1);
  check("(16d) precondition: db.listWorkers(leadId) is empty", e.db.listWorkers("plat-noworkers").length === 0);
  e.watcher.tick(NOW);
  check("(16d) it still nudges normally (empty worker set never blocks the platform-loop predicate)",
    e.enqueued.length === 1 && e.enqueued[0].id === "plat-noworkers");
  cleanup(e);
}
{
  // (16e) manager and platform sessions in the SAME project tick independently in one pass — proves the
  // merged [...listLiveManagers(), ...listLivePlatformSessions()] iteration doesn't drop or double-count.
  const e = makeEnv();
  seedManager(e, "mgr-and-plat");
  seedPlatform(e, "plat-and-mgr");
  seedTodo(e, 2);
  e.watcher.tick(NOW);
  check("(16e) both a manager and a platform session nudge independently in the SAME tick",
    e.enqueued.some((x) => x.id === "mgr-and-plat") && e.enqueued.some((x) => x.id === "plat-and-mgr") && e.enqueued.length === 2);
  cleanup(e);
}

// ==== (17) platform-role idle-nudge COPY diverges from the manager's (card f98f3e43) ====
// The manager copy ("dropped the orchestration loop / pick up the next task NOW / N actionable
// task(s)") pressures a Lead to drain the owner's decision-gated backlog — the exact anti-pattern
// /platform-lead forbids. A platform-role session must get its OWN copy; the manager's stays untouched.
{
  const e = makeEnv();
  seedPlatform(e, "plat-copy");
  seedManager(e, "mgr-copy-same-proj");
  seedTodo(e, 3); // shared board — both sessions see the same 3 actionable cards
  e.watcher.tick(NOW);
  const platMsg = e.enqueued.find((x) => x.id === "plat-copy")?.text ?? "";
  const mgrMsg = e.enqueued.find((x) => x.id === "mgr-copy-same-proj")?.text ?? "";
  check("(17a) platform copy drops the 'orchestration loop' framing", !/orchestration loop/i.test(platMsg));
  check("(17a) platform copy drops 'pick up the next task NOW'", !/pick up the next task/i.test(platMsg));
  check("(17a) platform copy drops the 'N actionable task(s)' framing entirely", !/actionable task/i.test(platMsg));
  check("(17a) platform copy asks it to confirm parked-waiting or converged, matching the Lead's own loop",
    /parked-waiting/i.test(platMsg) && /converged/i.test(platMsg));
  check("(17a) platform copy still steers to idle_report and question_ask", /idle_report/.test(platMsg) && /question_ask/.test(platMsg));
  check("(17b) the MANAGER copy on the identical idle shape stays BYTE-IDENTICAL to today",
    mgrMsg.includes("Why are you idle? If you simply dropped the orchestration loop, pick up the next task NOW.") &&
    mgrMsg.includes("3 actionable"));
  cleanup(e);
}

// ==== (17c) a PARKED-role card (decision-gated / owner-flow work) is discounted from a platform ====
// ==== session's actionable count, but STILL counts as actionable for a manager (card f98f3e43) ====
{
  const e = makeEnv();
  seedPlatform(e, "plat-parked-only");
  seedCard(e, "waiting"); // default board's sole parked-role column — sole open card
  e.watcher.tick(NOW);
  check("(17c) a platform session with ONLY a parked-lane card → NO idle nudge (decision-gated, discounted)",
    e.enqueued.length === 0);
  cleanup(e);
}
{
  // Contrast: the IDENTICAL board shape for a MANAGER still nudges — mirrors (1b), unchanged by this fix.
  const e = makeEnv();
  seedManager(e, "mgr-parked-only");
  seedCard(e, "waiting");
  e.watcher.tick(NOW);
  check("(17c-mgr) the SAME board for a MANAGER still nudges (parked lane counts as actionable — unchanged)",
    e.enqueued.length === 1 && e.enqueued[0].id === "mgr-parked-only" && e.enqueued[0].text.includes("1 actionable"));
  cleanup(e);
}

// ==== (18) session-level suppression on an OWN pending owner Request, lineage-scoped (card cb56cf80) ====
{
  // (18a) an OPEN (pending) owner-facing question_ask FILED BY the session itself — even with taskId:null,
  // invisible to the per-card listQuestionsForTask discount — suppresses the idle nudge for that filer.
  const e = makeEnv();
  seedManager(e, "mgr-own-pending-request");
  seedTodo(e, 5); // genuine actionable board work — would normally nudge
  seedQuestion(e, "mgr-own-pending-request", null, "pending");
  e.watcher.tick(NOW);
  check("(18a) a session with its OWN pending (taskId:null) Request is NOT idle-nudged", e.enqueued.length === 0);
  cleanup(e);
}
{
  // (18b) once that Request is answered, the SAME session resumes idle-nudging normally.
  const e = makeEnv();
  seedManager(e, "mgr-own-answered-request");
  seedTodo(e, 5);
  seedQuestion(e, "mgr-own-answered-request", null, "answered");
  e.watcher.tick(NOW);
  check("(18b) once the OWN Request is answered, the session resumes idle-nudging normally",
    e.enqueued.some((x) => x.id === "mgr-own-answered-request"));
  cleanup(e);
}
{
  // (18c) baseline: a session with no pending own-Request at all still nudges normally (unaffected).
  const e = makeEnv();
  seedManager(e, "mgr-no-own-request");
  seedTodo(e, 5);
  e.watcher.tick(NOW);
  check("(18c) a session with no pending own-Request still nudges normally", e.enqueued.some((x) => x.id === "mgr-no-own-request"));
  cleanup(e);
}
{
  // (18d) lineage-scoped, not global: a PENDING Request filed by an unrelated agent lineage must NOT
  // suppress a different session's own nudge.
  const e = makeEnv();
  seedManager(e, "mgr-unrelated-pending");
  seedTodo(e, 5);
  const otherAgentId = `it-${Math.random().toString(36).slice(2, 8)}`;
  e.db.insertAgent({ id: otherAgentId, projectId: e.projId, name: "other", startupPrompt: "orchestrate", position: 1 });
  e.db.insertSession({
    id: "mgr-other-agent", projectId: e.projId, agentId: otherAgentId, engineSessionId: "eng-other", title: null, cwd: e.projId,
    processState: "live", resumability: "resumable", busy: false,
    createdAt: minutesAgo(60), lastActivity: minutesAgo(60), lastError: null, role: "manager",
    ctxInputTokens: null, ctxTurns: null, model: null,
  });
  e.alive.add("mgr-other-agent");
  seedQuestion(e, "mgr-other-agent", null, "pending");
  e.watcher.tick(NOW);
  check("(18d) a PENDING Request filed by an unrelated agent lineage does NOT suppress this session's nudge",
    e.enqueued.some((x) => x.id === "mgr-unrelated-pending"));
  cleanup(e);
}
{
  // (18e) the same suppression covers a PLATFORM (Lead) session too — the finding explicitly covers "manager/Lead".
  const e = makeEnv();
  seedPlatform(e, "plat-own-pending-request");
  seedTodo(e, 3);
  seedQuestion(e, "plat-own-pending-request", null, "pending");
  e.watcher.tick(NOW);
  check("(18e) a platform (Lead) session with its OWN pending Request is NOT idle-nudged either", e.enqueued.length === 0);
  cleanup(e);
}
{
  // (18f) agent-LINEAGE reachability: a fresh (non-recycle) successor session on the SAME agentId must
  // still see a still-exited predecessor's own pending Request as ITS OWN (mirrors
  // pullAnsweredQuestionsForAgent's reachability definition).
  const e = makeEnv();
  seedManager(e, "mgr-predecessor", { live: false }); // exited, row still present (FK target for the question)
  seedQuestion(e, "mgr-predecessor", null, "pending"); // filed by the (now-exited) predecessor
  seedManager(e, "mgr-successor"); // fresh session, SAME e.agentId
  seedTodo(e, 4);
  e.watcher.tick(NOW);
  check("(18f) a fresh non-recycle successor on the SAME agent lineage is ALSO suppressed by a predecessor's own pending Request",
    e.enqueued.length === 0);
  cleanup(e);
}

// ===== (19) idle-nudge board-SCAN THROTTLE (card a193398f — perf: bound the idle-nudge re-drain) =====
// The expensive part of the manager loop (db.listTasks over the whole project + the pending-request
// discount) used to rerun on EVERY 60s tick once a manager crossed idleNudgeMinutes with NOTHING
// actionable (that outcome never calls recordIdleNudge, so idleForMin never drops back below the
// threshold). Now it's throttled to at most once per IDLE_SCAN_THROTTLE_MINUTES per manager.
{
  const e = makeEnv();
  seedManager(e, "mgr-throttle");
  // A held-only board (mirrors (1c)): nonTerminal.length > 0 but openCards.length === 0, so the "nothing
  // actionable" skip fires WITHOUT calling recordIdleNudge — last_idle_nudge_at never advances, so
  // idleForMin stays >= idleMinutes across every subsequent tick (a truly empty board would instead take
  // the "no cards at all" branch and nudge every time, resetting the baseline and defeating this test).
  seedTitled(e, "todo", "big owner decision parked here", true);
  let listTasksCalls = 0;
  const realListTasks = e.db.listTasks.bind(e.db);
  e.db.listTasks = (...args) => { listTasksCalls++; return realListTasks(...args); };

  e.watcher.tick(NOW);
  check("(19a) the first eligible tick scans the board", listTasksCalls === 1);
  check("(19a) nothing actionable → no nudge fires (0 actionable cards)", e.enqueued.length === 0);

  e.watcher.tick(new Date(NOW.getTime() + 2 * 60_000)); // +2min — inside the throttle window
  check("(19b) a re-tick WITHIN the throttle window does NOT re-scan the board", listTasksCalls === 1);

  e.watcher.tick(new Date(NOW.getTime() + 6 * 60_000)); // +6min — past the throttle window
  check("(19c) a re-tick PAST the throttle window DOES re-scan the board", listTasksCalls === 2);
  cleanup(e);
}
{
  // The throttle only ever SKIPS a re-scan — it never delays a nudge that's genuinely due. With
  // idleNudgeMinutes=45 (default) and IDLE_SCAN_THROTTLE_MINUTES=5, a manager that becomes idle-eligible
  // still gets scanned (and nudged, since there's actionable work) on its very first eligible tick.
  const e = makeEnv();
  seedManager(e, "mgr-throttle-still-nudges");
  seedTodo(e, 2);
  e.watcher.tick(NOW);
  check("(19d) the throttle never blocks a genuinely-due FIRST nudge", e.enqueued.length === 1 && e.enqueued[0].id === "mgr-throttle-still-nudges");
  cleanup(e);
}
{
  // (19e) CR follow-up: a board that GAINS actionable work MID-throttle-window still fires within the
  // throttle bound (≤ IDLE_SCAN_THROTTLE_MINUTES) — the throttle only delays DETECTION by that bounded
  // amount, it never defers a fresh nudge all the way out to the next full idleNudgeMinutes cadence.
  const e = makeEnv();
  seedManager(e, "mgr-throttle-catchup");
  seedTitled(e, "todo", "held only, nothing actionable yet", true); // held=true → 0 actionable initially

  e.watcher.tick(NOW); // first eligible tick — scans, sees nothing actionable, no nudge
  check("(19e) precondition: no nudge on the first scan (nothing actionable yet)", e.enqueued.length === 0);

  // Board gains real work mid-window (+1min — inside the 5min throttle).
  e.watcher.tick(new Date(NOW.getTime() + 1 * 60_000));
  seedTitled(e, "todo", "fix(web): now actionable", false);
  check("(19e) still throttled at +1min — no re-scan yet, so no nudge yet either", e.enqueued.length === 0);

  // By +5min (the throttle bound), the next tick re-scans and catches the new work — a BOUNDED delay,
  // never deferred to the next full idleNudgeMinutes cadence.
  e.watcher.tick(new Date(NOW.getTime() + 5 * 60_000));
  check(
    "(19e) the nudge fires within the throttle bound once the board actually changed",
    e.enqueued.length === 1 && e.enqueued[0].id === "mgr-throttle-catchup" && e.enqueued[0].text.includes("1 actionable"),
  );
  cleanup(e);
}
{
  // (19f) CR follow-up: the effective throttle is floored at THIS manager's own idleNudgeMinutes, so a
  // project configuring it BELOW IDLE_SCAN_THROTTLE_MINUTES never has its re-nudge cadence silently
  // stretched to the (longer) default throttle window — Math.min(IDLE_SCAN_THROTTLE_MINUTES, idleMinutes).
  const e = makeEnv({ projectConfig: { orchestration: { idleNudgeMinutes: 2 } } }); // below the 5min throttle default
  seedManager(e, "mgr-short-cadence", { idleMin: 3 }); // idle 3m — already past this project's 2m cadence
  seedTitled(e, "todo", "held only, nothing actionable yet", true);

  e.watcher.tick(NOW); // first eligible tick — scans, nothing actionable, no nudge
  check("(19f) precondition: no nudge on the first scan (nothing actionable yet)", e.enqueued.length === 0);

  seedTitled(e, "todo", "fix(web): now actionable", false); // board gains work immediately after
  e.watcher.tick(new Date(NOW.getTime() + 2 * 60_000)); // +2min — AT this project's own 2min cadence
  check(
    "(19f) the effective throttle is floored at idleNudgeMinutes(2), not the longer 5min default — re-scans by +2min",
    e.enqueued.length === 1 && e.enqueued[0].id === "mgr-short-cadence",
  );
  cleanup(e);
}

// ===== (20) the per-card pending-request discount is now ONE query, not one-per-card (N+1 fix, card a193398f) =====
{
  const e = makeEnv();
  seedManager(e, "mgr-n-plus-one");
  seedCard(e, "todo"); seedCard(e, "todo"); seedCard(e, "todo"); seedCard(e, "todo"); // 4 non-terminal cards
  let listQuestionsForTaskCalls = 0;
  const realListQFT = e.db.listQuestionsForTask.bind(e.db);
  e.db.listQuestionsForTask = (...args) => { listQuestionsForTaskCalls++; return realListQFT(...args); };
  let listPendingCalls = 0;
  const realListPending = e.db.listPendingQuestionTaskIds.bind(e.db);
  e.db.listPendingQuestionTaskIds = (...args) => { listPendingCalls++; return realListPending(...args); };

  e.watcher.tick(NOW);
  check("(20a) the board scan calls listPendingQuestionTaskIds exactly ONCE regardless of card count", listPendingCalls === 1);
  check("(20b) the per-card N+1 listQuestionsForTask is NEVER called by this scan", listQuestionsForTaskCalls === 0);
  check("(20c) with no pending requests, all 4 cards are still counted actionable", e.enqueued.length === 1 && e.enqueued[0].text.includes("4 actionable"));
  cleanup(e);
}
{
  // Legacy 8-char task_id-PREFIX rows (pre-a3f1319f) — listQuestionsForTask tolerated these; the batched
  // listPendingQuestionTaskIds replacement must discount a card the same way, not just for full-id rows.
  const e = makeEnv();
  seedManager(e, "mgr-legacy-prefix");
  seedCard(e, "todo");
  const task = e.db.listTasks(e.projId)[0];
  seedQuestion(e, "mgr-legacy-prefix", task.id.slice(0, 8), "pending"); // legacy prefix-linked row
  e.watcher.tick(NOW);
  check("(21) a PENDING request linked by a legacy 8-char task_id PREFIX still discounts the card", e.enqueued.length === 0);
  cleanup(e);
}

// ===== (22) the nudge copy carries the bounded-recheck hint (card a193398f) =====
{
  const e = makeEnv();
  seedManager(e, "mgr-hint");
  seedTodo(e, 2);
  e.watcher.tick(NOW);
  check(
    "(22a) a manager idle nudge appends the 'these counts are already current' hint",
    e.enqueued[0]?.text.includes("already current") && e.enqueued[0]?.text.includes("no need to re-pull"),
  );
  cleanup(e);
}
{
  const e = makeEnv();
  seedPlatform(e, "plat-hint");
  seedTodo(e, 2);
  e.watcher.tick(NOW);
  check(
    "(22b) the PLATFORM (Lead) nudge does NOT carry the hint (its copy never cites the counts the hint refers to)",
    !e.enqueued[0]?.text.includes("already current"),
  );
  cleanup(e);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — IdleWatcher nudges an idle, watching, unpaused, under-cap, context-roomy MANAGER (with no live BUSY worker) exactly once per leash window (recordIdleNudge increments); is SILENT when busy / fresh / snoozed / suppressed / has-a-live-BUSY-worker / human-paused / recently-nudged / disabled(0) / recycle-pending; a live IDLE worker no longer shields the manager (board card b9d479b0) and the nudge copy reflects that honestly; ESCALATES ONCE at the unanswered cap (one idle_escalated event + policy→suppressed, no re-emit on a later tick); honors per-project idleNudgeMinutes; resets to 'watching' on genuine new orchestration activity (ignoring idle_report); the zod orchestrationOverride now accepts the four idle config keys (strictness intact); the NEW idle-WORKER periodic coverage re-nudges a live/idle/unreported/stale worker on its own cadence while staying silent when disabled, under the window, already-reported, human-paused, or recently re-nudged; a PLATFORM (Lead) session (card 98b3725c) gets the SAME full-trigger/silent/escalate coverage a manager does, alongside a manager in the same project/tick without interference; a platform-role session now gets its OWN idle-nudge copy (no orchestration-loop/pick-up-next/N-actionable framing) and discounts parked-lane (decision-gated/owner-flow) cards from its actionable count, while the manager's copy and parked-lane counting stay byte-identical (card f98f3e43); and a session's OWN open (pending) owner question_ask — regardless of taskId — suppresses ITS idle nudge lineage-scoped across a fresh non-recycle successor, resuming normally once answered or when there's no pending own-Request, without being fooled by an unrelated agent's pending Request (card cb56cf80)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
