import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card cdd10965: idle-watcher.ts's manager/platform loop (tick()) used to log a FIRED nudge/escalation and
// nothing else — a SKIPPED session left zero trace, indistinguishable from "the watchdog never ticked".
// This test proves the fix: `logSkipIfChanged` emits `[idle-watcher] skip <id> reason=<code>` for every
// REACHABLE skip predicate, ONLY on a change of reason (bounding volume to state transitions, not one
// line per tick per live manager — the naive shape would swamp the shared, already-~10MB/rotation log),
// and that the pre-existing `nudged`/escalated lines are byte-identical (a load-bearing grep target this
// card must not perturb).
//
// SCOPE (matches the class's own new doc comment on `lastSkipReason`): this covers the manager/platform
// loop ONLY, not tickIdleWorkers/tickAnsweredStuckQuestions — those already log their own delivery
// failures and are a different loop from the card's specimen.
//
// NOT tested here (and deliberately so — see idle-watcher.ts's own comments at each site): `no-project`,
// `no-idle-state`, `active-snooze` are defensive/TOCTOU branches. By my reading of db.ts:5224-5235,
// `getIdleNudgeState` returns undefined ONLY when the session row itself is missing, and `m` always comes
// from listLiveManagers()/listLivePlatformSessions() moments earlier, so the row necessarily exists —
// I could not construct a case that reaches `no-idle-state` (or `no-project`, or the "watching row with
// an active snoozeUntil" shape `active-snooze` guards) through the watcher's own public surface without
// fabricating an artificial gap between listing and reading. A control that cannot fire proves nothing.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "../dist/db.js";
import { IdleWatcher } from "../dist/orchestration/idle-watcher.js";
import { OrchestrationControl } from "../dist/orchestration/control.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Console.log-override capture (established pattern — see test/mcp-inbound-log.mjs's captureLogs()).
// Real console.log still fires (so PASS/FAIL lines still print); `lines` accumulates everything for
// filtering down to `[idle-watcher] ...` lines in each assertion.
function captureLogs() {
  const lines = [];
  const original = console.log;
  console.log = (...args) => { lines.push(args.map(String).join(" ")); original(...args); };
  return { lines, restore: () => { console.log = original; } };
}
const skipLines = (lines, id) => lines.filter((l) => l.startsWith(`[idle-watcher] skip ${id} `));

const NOW = new Date("2026-09-03T12:00:00.000Z");
const minutesAgo = (m) => new Date(NOW.getTime() - m * 60_000).toISOString();

function makeEnv({ recycleRatio = 0, projectConfig = {} } = {}) {
  const dbFile = path.join(os.tmpdir(), `loom-idle-skiplog-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Db(dbFile);
  const projId = `isp-${Math.random().toString(36).slice(2, 8)}`;
  const agentId = `ist-${Math.random().toString(36).slice(2, 8)}`;
  const now = NOW.toISOString();
  db.insertProject({ id: projId, name: "IdleSkip", repoPath: projId, vaultPath: projId, config: projectConfig, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });
  const alive = new Set();
  const enqueued = [];
  const pty = {
    isAlive: (id) => alive.has(id),
    enqueueStdin: (id, text) => { enqueued.push({ id, text }); return { delivered: true }; },
  };
  const control = new OrchestrationControl();
  const watcher = new IdleWatcher({ db, pty, control, recycleRatio, notifyIdleWorker: () => {}, isWorkerStranded: () => true });
  return { dbFile, db, projId, agentId, alive, enqueued, control, watcher };
}
function seedManager(e, id, { idleMin = 60, busy = false, model = null, ctx = null, aliveInPty = true } = {}) {
  e.db.insertSession({
    id, projectId: e.projId, agentId: e.agentId, engineSessionId: "eng-" + id, title: null, cwd: e.projId,
    processState: "live", resumability: "resumable", busy,
    createdAt: minutesAgo(idleMin), lastActivity: minutesAgo(idleMin), lastError: null, role: "manager",
    ctxInputTokens: ctx, ctxTurns: ctx == null ? null : 1, model,
  });
  if (aliveInPty) e.alive.add(id);
}
function seedWorker(e, id, parentId, { busy = false } = {}) {
  e.db.insertSession({
    id, projectId: e.projId, agentId: e.agentId, engineSessionId: "eng-" + id, title: null, cwd: e.projId,
    processState: "live", resumability: "resumable", busy,
    createdAt: NOW.toISOString(), lastActivity: NOW.toISOString(), lastError: null,
    role: "worker", parentSessionId: parentId, taskId: "tk-" + id,
  });
  e.alive.add(id);
}
function seedTitled(e, columnKey, title, held = false) {
  e.db.insertTask({ id: `tk-${columnKey}-${Math.random().toString(36).slice(2, 6)}`, projectId: e.projId,
    title, body: "", columnKey, held, deferred: false, deferredReason: null,
    position: 0, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() });
}
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

// ============================ (1) disabled (idleNudgeMinutes:0) — fires once, dedups on repeat ============================
{
  const e = makeEnv({ projectConfig: { orchestration: { idleNudgeMinutes: 0 } } });
  seedManager(e, "mgr-disabled", { idleMin: 999 });
  const cap = captureLogs();
  e.watcher.tick(NOW);
  e.watcher.tick(new Date(NOW.getTime() + 60_000)); // repeat tick, same reason
  cap.restore();
  const lines = skipLines(cap.lines, "mgr-disabled");
  check("(1) disabled → exactly one skip line, reason=disabled", lines.length === 1 && lines[0] === "[idle-watcher] skip mgr-disabled reason=disabled");
  cleanup(e);
}

// ============================ (2) busy → under-window transition (the most common real-world flap) ============================
{
  const e = makeEnv();
  seedManager(e, "mgr-busy", { busy: true, idleMin: 1 });
  const cap = captureLogs();
  e.watcher.tick(NOW);
  e.watcher.tick(NOW); // same reason again — must NOT duplicate
  e.db.setBusy("mgr-busy", false); // real transition: busy ends
  e.watcher.tick(new Date()); // idleForMin ~0 (< default 45) → under-window
  cap.restore();
  const lines = skipLines(cap.lines, "mgr-busy");
  check(
    "(2) busy(x2, deduped) then a genuine transition to under-window — exactly 2 lines total",
    lines.length === 2
    && lines[0] === "[idle-watcher] skip mgr-busy reason=busy"
    && lines[1] === "[idle-watcher] skip mgr-busy reason=under-window",
  );
  cleanup(e);
}

// ============================ (3) policy: snoozed / suppressed (specific values, not a generic code) ============================
{
  const e = makeEnv();
  seedManager(e, "mgr-policy", { idleMin: 60 });
  const future = new Date(NOW.getTime() + 3_600_000).toISOString();
  e.db.setIdleNudgePolicy("mgr-policy", "snoozed", future);
  const cap = captureLogs();
  e.watcher.tick(NOW);
  e.db.setIdleNudgePolicy("mgr-policy", "suppressed");
  e.watcher.tick(NOW);
  cap.restore();
  const lines = skipLines(cap.lines, "mgr-policy");
  check(
    "(3) policy value itself is the reason code — snoozed then suppressed, both distinct",
    lines.length === 2
    && lines[0] === "[idle-watcher] skip mgr-policy reason=snoozed"
    && lines[1] === "[idle-watcher] skip mgr-policy reason=suppressed",
  );
  cleanup(e);
}

// ============================ (4) human-paused ============================
{
  const e = makeEnv();
  seedManager(e, "mgr-paused", { idleMin: 60 });
  e.control.pause("mgr-paused");
  const cap = captureLogs();
  e.watcher.tick(NOW);
  cap.restore();
  check("(4) human-paused", skipLines(cap.lines, "mgr-paused").length === 1 && skipLines(cap.lines, "mgr-paused")[0].endsWith("reason=human-paused"));
  cleanup(e);
}

// ============================ (5) live-busy-worker ============================
{
  const e = makeEnv();
  seedManager(e, "mgr-lbw", { idleMin: 60 });
  seedWorker(e, "wkr-lbw", "mgr-lbw", { busy: true });
  const cap = captureLogs();
  e.watcher.tick(NOW);
  cap.restore();
  check("(5) live-busy-worker", skipLines(cap.lines, "mgr-lbw").length === 1 && skipLines(cap.lines, "mgr-lbw")[0].endsWith("reason=live-busy-worker"));
  cleanup(e);
}

// ============================ (6) recycle-pending ============================
{
  const e = makeEnv({ recycleRatio: 0.8 });
  seedManager(e, "mgr-recycle", { idleMin: 60, ctx: 900_000, model: "claude-opus-4-8" }); // 90% ≥ 0.8
  const cap = captureLogs();
  e.watcher.tick(NOW);
  cap.restore();
  check("(6) recycle-pending", skipLines(cap.lines, "mgr-recycle").length === 1 && skipLines(cap.lines, "mgr-recycle")[0].endsWith("reason=recycle-pending"));
  cleanup(e);
}

// ============================ (7) under-window → nudged transition (natural clock advance, no field mutation) ============================
{
  const e = makeEnv();
  seedManager(e, "mgr-window", { idleMin: 0 }); // lastActivity pinned at NOW - 0min
  const lastActivityIso = NOW.toISOString();
  const cap = captureLogs();
  e.watcher.tick(new Date(Date.parse(lastActivityIso) + 40 * 60_000)); // 40m idle, < default 45 → under-window
  e.watcher.tick(new Date(Date.parse(lastActivityIso) + 50 * 60_000)); // 50m idle, ≥ 45 → nudged
  cap.restore();
  const lines = skipLines(cap.lines, "mgr-window");
  const nudgeLine = cap.lines.find((l) => l.startsWith("[idle-watcher] nudged idle manager mgr-window"));
  check(
    "(7) under-window logs once, then a real transition to eligibility produces the EXISTING nudged line (unperturbed)",
    lines.length === 1 && lines[0] === "[idle-watcher] skip mgr-window reason=under-window"
    && nudgeLine === "[idle-watcher] nudged idle manager mgr-window (~50m idle, 0 actionable, unanswered→1)",
  );
  cleanup(e);
}

// ============================ (8) not-alive (DB says live, real pty already gone) ============================
{
  const e = makeEnv();
  seedManager(e, "mgr-dead", { idleMin: 60, aliveInPty: false });
  const cap = captureLogs();
  e.watcher.tick(NOW);
  cap.restore();
  check("(8) not-alive", skipLines(cap.lines, "mgr-dead").length === 1 && skipLines(cap.lines, "mgr-dead")[0].endsWith("reason=not-alive"));
  cleanup(e);
}

// ============================ (9) scan-throttled — floored at THIS manager's idleNudgeMinutes (NOT hardcoded 5min) ============================
{
  // Mirrors idle-watcher.mjs's own (19f): idleNudgeMinutes:2 is BELOW the 5min IDLE_SCAN_THROTTLE_MINUTES
  // default, so Math.min(5, 2) = 2 is the value actually being exercised here — not a coincidence of the
  // unconfigured default (card cdd10965 amendment 2).
  const e = makeEnv({ projectConfig: { orchestration: { idleNudgeMinutes: 2 } } });
  seedManager(e, "mgr-throttle", { idleMin: 3 }); // already past the 2min cadence
  seedTitled(e, "todo", "held only — nothing actionable", true); // nonTerminal.length>0, but 0 actionable
  const cap = captureLogs();
  e.watcher.tick(NOW); // first-ever scan for this manager → runs the scan, concludes nothing-actionable
  e.watcher.tick(new Date(NOW.getTime() + 1 * 60_000)); // +1min, inside the floored 2min window → scan-throttled
  e.watcher.tick(new Date(NOW.getTime() + 1.5 * 60_000)); // still inside the window → must NOT duplicate
  cap.restore();
  const lines = skipLines(cap.lines, "mgr-throttle");
  check(
    "(9) nothing-actionable once, then scan-throttled once (deduped on the repeat within the floored window)",
    lines.length === 2
    && lines[0] === "[idle-watcher] skip mgr-throttle reason=nothing-actionable"
    && lines[1] === "[idle-watcher] skip mgr-throttle reason=scan-throttled",
  );
  cleanup(e);
}

// ============================ (10) nothing-actionable (real cards exist, none dispatchable) ============================
{
  const e = makeEnv();
  seedManager(e, "mgr-nothing", { idleMin: 60 });
  seedTitled(e, "todo", "held only — nothing actionable", true);
  const cap = captureLogs();
  e.watcher.tick(NOW);
  cap.restore();
  check("(10) nothing-actionable", skipLines(cap.lines, "mgr-nothing").length === 1 && skipLines(cap.lines, "mgr-nothing")[0].endsWith("reason=nothing-actionable"));
  cleanup(e);
}

// ============================ (11) own-pending-request — the card's OWN first-party specimen scenario ============================
// A truly-empty board (zero cards at all) parked SOLELY on the session's own pending owner Request
// (taskId:null) — cb56cf80's original carve-out. This is EXACTLY the line the card's specimen needed and
// could not find: "the one thing that would have settled it (a 'skipped: own-pending-Request' line) does
// not exist."
{
  const e = makeEnv();
  seedManager(e, "mgr-own-req", { idleMin: 60 });
  seedQuestion(e, "mgr-own-req", null, "pending");
  const cap = captureLogs();
  e.watcher.tick(NOW);
  cap.restore();
  check(
    "(11) own-pending-request is distinguished from generic nothing-actionable",
    skipLines(cap.lines, "mgr-own-req").length === 1 && skipLines(cap.lines, "mgr-own-req")[0].endsWith("reason=own-pending-request"),
  );
  cleanup(e);
}

// ============================ (12) DoD-4: a NUDGED session's existing line is byte-identical, and no skip line accompanies it ============================
{
  const e = makeEnv();
  seedManager(e, "mgr-nudged", { idleMin: 60 });
  const cap = captureLogs();
  e.watcher.tick(NOW);
  cap.restore();
  check(
    "(12) the pre-existing nudged-manager line format is UNCHANGED",
    cap.lines.includes("[idle-watcher] nudged idle manager mgr-nudged (~60m idle, 0 actionable, unanswered→1)"),
  );
  check("(12) a nudged session emits NO skip line for this tick", skipLines(cap.lines, "mgr-nudged").length === 0);
  cleanup(e);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — idle-watcher.ts's manager/platform loop now logs the SPECIFIC deciding skip reason " +
    "for every reachable predicate, only on a change of reason (bounded volume), while the pre-existing " +
    "nudged/escalated lines stay byte-identical."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
