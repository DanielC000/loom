import { requireHermeticEnv } from "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// MCP-silence watchdog (card d1521fca) — a LIVE, non-recycled session whose MCP traffic has gone
// quiet, either one-sidedly (ASYMMETRIC: one router stale while a sibling router stays recent — the
// Klokk worker b5668822 incident) or entirely (ALL-SILENT: every established router stale at once —
// the a7c072c4 orchestrator incident, where both its routes went dark together and recovered only on a
// daemon restart). Code Review round (see docs/decisions/d1521fca-*.md): replayed against the real
// 2026-10-18 log, the classifier false-positived on the first tick after a host stall — fixed by
// tick-lag detection + a two-evaluation confirmation ladder + a robust (max-of-N-gaps) cadence
// estimate; also excludes codex sessions from the ALL-SILENT shape (no evidence codex's MCP client
// sends a keepalive at all). NO claude — IdleWatcher takes an injected pty-slice, so this drives
// tick() directly against a RECORDING STUB, deterministic clock, hermetic temp DB. Mirrors
// idle-watcher.mjs's own harness shape (makeEnv/seedManager/seedWorker/seedPlatform), scoped to just
// this one feature so it doesn't bloat that already-large file.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("idle-watcher-mcp-silence-");
requireHermeticEnv();
const { Db } = await import("../dist/db.js");
const { IdleWatcher, MCP_SILENCE_STALE_FLOOR_MS, MCP_SILENCE_STALE_MULTIPLIER, MCP_SILENCE_LAG_MULTIPLIER } = await import("../dist/orchestration/idle-watcher.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const NOW = new Date("2026-10-18T15:00:00.000Z").getTime();
const minutesAgo = (m) => new Date(NOW - m * 60_000).toISOString();
const INTERVAL_MS = 60_000;
// The real production constant (imported above, not restated as a magic number) PLUS a small buffer so
// a test's "confirm" tick is unambiguously past the >= boundary, never exactly on it.
const CONFIRM_GAP_MS = MCP_SILENCE_STALE_FLOOR_MS + 1_000;

/**
 * Ticks `watcher` at every `stepMs` (default the production `INTERVAL_MS`) from `fromMs` through
 * `toMs` inclusive — mirrors how `setInterval` actually drives `tick()` in production, where
 * consecutive calls are always `INTERVAL_MS` apart. Calling `tick()` only twice, far apart, would
 * itself read as a TICK LAG (the exact mechanism this card's own fix detects) and wrongly clear
 * `mcpSilencePending` / arm a grace window — the false alarm this helper exists to avoid introducing
 * into the test itself. Test (5) is the one deliberate exception: it calls `tick()` sparsely ON
 * PURPOSE, because a genuine multi-minute gap between ticks IS the scenario under test there.
 */
function tickThrough(watcher, fromMs, toMs, stepMs = INTERVAL_MS) {
  for (let t = fromMs; t <= toMs; t += stepMs) watcher.tick(new Date(t));
}

/**
 * A fully-controllable stand-in for PtyHost's real per-router cadence tracking
 * (recordMcpRouterSeen/getMcpRouterLastSeen/getMcpRouterCadenceMs/getMcpRoutersSeen) — mirrors the
 * REAL shape exactly (a bounded window of recent inter-arrival GAPS, cadence = their MAX, never the
 * single last gap — see PtyHost.getMcpRouterCadenceMs's own doc for why), so a test seeds "sightings
 * over time" the same way the real gateway would, rather than hand-crafting a divergent fixture shape.
 */
function makeMcpCadenceStore() {
  const CADENCE_WINDOW = 5;
  const bySession = new Map(); // sessionId -> Map<router, {lastAt, gaps:number[]}>
  return {
    record(sessionId, router, atMs) {
      const forSession = bySession.get(sessionId) ?? new Map();
      const prior = forSession.get(router);
      const gaps = prior ? [...prior.gaps, atMs - prior.lastAt] : [];
      if (gaps.length > CADENCE_WINDOW) gaps.shift();
      forSession.set(router, { lastAt: atMs, gaps });
      bySession.set(sessionId, forSession);
    },
    getMcpRouterLastSeen(sessionId, router) { return bySession.get(sessionId)?.get(router)?.lastAt; },
    getMcpRouterCadenceMs(sessionId, router) {
      const e = bySession.get(sessionId)?.get(router);
      if (!e || e.gaps.length === 0) return undefined;
      return Math.max(...e.gaps);
    },
    getMcpRoutersSeen(sessionId) { return [...(bySession.get(sessionId)?.keys() ?? [])]; },
  };
}

function makeEnv() {
  const dbFile = path.join(os.tmpdir(), `loom-idle-mcpsilence-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Db(dbFile);
  const projId = `ip-${Math.random().toString(36).slice(2, 8)}`;
  const agentId = `it-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date(NOW).toISOString();
  db.insertProject({ id: projId, name: "McpSilence", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });

  const alive = new Set();
  const cadence = makeMcpCadenceStore();
  const parentNudges = []; // { parentSessionId, text, taskId }
  const leadNudges = []; // { sessionId, text }
  // Recording stubs return the SAME shape the real SessionService methods do (Code Review round) —
  // IdleWatcher reads these return values to populate the durable event's detail.
  let nextLeadBoardTaskId = 0;
  const pty = {
    isAlive: (id) => alive.has(id),
    enqueueStdin: () => ({ delivered: true }), // not exercised by this feature; present to satisfy IdlePty's other callers
    getMcpRouterLastSeen: (id, r) => cadence.getMcpRouterLastSeen(id, r),
    getMcpRouterCadenceMs: (id, r) => cadence.getMcpRouterCadenceMs(id, r),
    getMcpRoutersSeen: (id) => cadence.getMcpRoutersSeen(id),
  };
  const control = new OrchestrationControl();
  const watcher = new IdleWatcher({
    db, pty, control, recycleRatio: 0.8, intervalMs: INTERVAL_MS,
    notifyIdleWorker: () => {}, isWorkerStranded: () => true,
    notifyMcpSilenceParent: (parentSessionId, text, taskId) => {
      parentNudges.push({ parentSessionId, text, taskId });
      return { notifiedParent: true };
    },
    notifyMcpSilenceLead: (sessionId, text) => {
      const leadBoardTaskId = `lead-task-${nextLeadBoardTaskId++}`;
      leadNudges.push({ sessionId, text, leadBoardTaskId });
      return { leadNotified: true, leadBoardTaskId };
    },
  });
  return { dbFile, db, projId, agentId, alive, cadence, parentNudges, leadNudges, watcher };
}

function seedManager(e, id, { lastActivityMin = 0, role = "manager", harness } = {}) {
  e.db.insertSession({
    id, projectId: e.projId, agentId: e.agentId, engineSessionId: "eng-" + id, title: null, cwd: e.projId,
    processState: "live", resumability: "resumable", busy: false,
    createdAt: minutesAgo(lastActivityMin), lastActivity: minutesAgo(lastActivityMin), lastError: null, role,
    ...(harness ? { harness } : {}),
  });
  e.alive.add(id);
}
function seedWorker(e, id, parentId, { lastActivityMin = 0, harness } = {}) {
  e.db.insertSession({
    id, projectId: e.projId, agentId: e.agentId, engineSessionId: "eng-" + id, title: null, cwd: e.projId,
    processState: "live", resumability: "resumable", busy: false,
    createdAt: minutesAgo(lastActivityMin), lastActivity: minutesAgo(lastActivityMin), lastError: null,
    role: "worker", parentSessionId: parentId, taskId: "tk-" + id,
    ...(harness ? { harness } : {}),
  });
  e.db.insertTask({ id: "tk-" + id, projectId: e.projId, title: "t-" + id, body: "", columnKey: "in_progress", position: 0, createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString() });
  e.alive.add(id);
}

// Seeds a router with a realistic ~6-minute cadence (matches both real incidents — "7,938 gaps in 5-6
// min buckets over 2 days" per the Code Review replay) up to `lastSeenMinAgo` minutes before NOW —
// establishes a cadence from the last TWO sightings (lastSeenMinAgo and lastSeenMinAgo+6).
function seedCadenceRouter(e, sessionId, router, lastSeenMinAgo) {
  e.cadence.record(sessionId, router, NOW - (lastSeenMinAgo + 6) * 60_000);
  e.cadence.record(sessionId, router, NOW - lastSeenMinAgo * 60_000);
}
// Null-safe stringify for a JSON-shaped field that may be absent on a FAIL path — lets a check() report
// false cleanly instead of throwing when the surrounding assertion's premise (e.g. "an event exists")
// already failed (Code Review round, card d1521fca nit).
const safeIncludes = (value, needle) => JSON.stringify(value ?? "").includes(needle);

// ============================ (0) a session's FIRST stale observation does NOT fire by itself ============================
{
  const e = makeEnv();
  seedManager(e, "M0");
  seedWorker(e, "W0", "M0");
  seedCadenceRouter(e, "W0", "task", 1); // fresh
  seedCadenceRouter(e, "W0", "orchestration", 25); // stale (> 18min threshold)

  e.watcher.tick(new Date(NOW));
  check("(0) the FIRST stale observation does not notify by itself", e.parentNudges.length === 0);

  // Still inside the confirmation window (< one keepalive period since the first sighting) — must
  // stay silent even though it's STILL stale. Dense ticking (never a lone sparse jump) so this phase
  // is never itself misread as a tick lag.
  tickThrough(e.watcher, NOW + INTERVAL_MS, NOW + MCP_SILENCE_STALE_FLOOR_MS - 1_000);
  check("(0) still silent just BEFORE the confirmation gap elapses", e.parentNudges.length === 0);

  // Past the confirmation gap, still stale — NOW it notifies.
  tickThrough(e.watcher, NOW + MCP_SILENCE_STALE_FLOOR_MS, NOW + CONFIRM_GAP_MS);
  check("(0) notifies once the confirmation gap has elapsed and it's STILL stale", e.parentNudges.length === 1);
}

// ============================ (1) ASYMMETRIC shape fires (once confirmed) — the b5668822 shape ============================
{
  const e = makeEnv();
  seedManager(e, "M1");
  seedWorker(e, "W1", "M1");
  seedCadenceRouter(e, "W1", "task", 1); // fresh: last task sighting 1 min ago, ~6min cadence
  seedCadenceRouter(e, "W1", "orchestration", 25); // stale: last sighting 25 min ago (> 18min threshold)

  tickThrough(e.watcher, NOW, NOW + CONFIRM_GAP_MS); // first sighting pending, then confirmed

  check("(1) fires exactly once to the worker's parent manager", e.parentNudges.length === 1);
  check("(1) never notifies the Lead for a worker", e.leadNudges.length === 0);
  const n = e.parentNudges[0];
  check("(1) addressed to the real parent (M1)", n?.parentSessionId === "M1");
  check("(1) names the task id", n?.taskId === "tk-W1");
  check("(1) text names the stale router (orchestration)", n?.text.includes("orchestration"));
  check("(1) text names the fresh sibling router (task)", n?.text.includes("task"));
  check("(1) text names the worker's own session id", n?.text.includes("W1"));
  const ev = e.db.listEvents("M1").find((x) => x.kind === "mcp_silence_detected");
  check("(1) a durable event was recorded at all", ev !== undefined);
  check("(1) durable event recorded, shape=asymmetric", ev?.detail?.shape === "asymmetric");
  check("(1) durable event names the stale router", safeIncludes(ev?.detail?.staleRouters, "orchestration"));
  check("(1) durable event carries workerSessionId=W1 (worker_stuck convention)", ev?.workerSessionId === "W1");
  check("(1) durable event records notifiedParent:true (Code Review round)", ev?.detail?.notifiedParent === true);
  check("(1) durable event carries NO leadBoardTaskId (worker shape never files one)", ev?.detail?.leadBoardTaskId === undefined);
}

// ============================ (2) ALL-SILENT shape fires (once confirmed) — the a7c072c4 shape ============================
{
  const e = makeEnv();
  seedManager(e, "M2", { lastActivityMin: 20 }); // was active ~20min ago, well inside the dormant floor
  seedCadenceRouter(e, "M2", "task", 20);
  seedCadenceRouter(e, "M2", "orchestration", 20);

  tickThrough(e.watcher, NOW, NOW + CONFIRM_GAP_MS);

  check("(2) fires exactly once to the Platform Lead (no parent to nudge)", e.leadNudges.length === 1);
  check("(2) never misroutes a manager/Lead notice to a 'parent'", e.parentNudges.length === 0);
  const n = e.leadNudges[0];
  check("(2) names the silent session itself", n?.sessionId === "M2");
  check("(2) text mentions BOTH routers going silent together", n?.text.includes("task") && n?.text.includes("orchestration"));
  const ev = e.db.listEvents("M2").find((x) => x.kind === "mcp_silence_detected");
  check("(2) a durable event was recorded at all", ev !== undefined);
  check("(2) durable event recorded, shape=all-silent", ev?.detail?.shape === "all-silent");
  check("(2) durable event carries managerSessionId=M2, no workerSessionId (worker_stuck convention)",
    ev?.managerSessionId === "M2" && ev?.workerSessionId == null); // DB round-trip reads absent as null, not undefined
  check("(2) durable event records leadNotified:true + the real leadBoardTaskId (Code Review round)",
    ev?.detail?.leadNotified === true && ev?.detail?.leadBoardTaskId === n?.leadBoardTaskId);
}

// ============================ (3) an idle/dormant session does NOT fire ============================
{
  // (3a) Long-dormant manager: both routers stale, but lastActivity is far older than the dormant
  // floor — "simply idle with no turns", not the a7c072c4 shape.
  const e = makeEnv();
  seedManager(e, "M3", { lastActivityMin: 300 }); // 5h dormant, well past the 120min floor
  seedCadenceRouter(e, "M3", "task", 300);
  seedCadenceRouter(e, "M3", "orchestration", 300);
  tickThrough(e.watcher, NOW, NOW + CONFIRM_GAP_MS);
  check("(3a) a long-dormant manager (no turns) does NOT fire", e.leadNudges.length === 0 && e.parentNudges.length === 0);
}
{
  // (3b) A brand-new worker with only ONE sighting per router — no established cadence to compare, so
  // nothing is judged stale at all (even though, by wall-clock alone, it "looks" quiet).
  const e = makeEnv();
  seedManager(e, "M4");
  seedWorker(e, "W4", "M4");
  e.cadence.record("W4", "task", NOW - 1 * 60_000); // single sighting — no cadence yet
  e.cadence.record("W4", "orchestration", NOW - 25 * 60_000); // single sighting — no cadence yet
  tickThrough(e.watcher, NOW, NOW + CONFIRM_GAP_MS);
  check("(3b) a session with no established per-router cadence does NOT fire", e.parentNudges.length === 0 && e.leadNudges.length === 0);
}

// ============================ (4) a recovered session clears the episode, then re-fires on recurrence ============================
{
  const e = makeEnv();
  seedManager(e, "M5");
  seedWorker(e, "W5", "M5");
  seedCadenceRouter(e, "W5", "task", 1);
  seedCadenceRouter(e, "W5", "orchestration", 25); // stale

  // One continuous dense-tick timeline (never a lone sparse jump — see tickThrough's own doc) driven
  // by a single advancing cursor `t`, so every phase below ticks at the real production cadence.
  let t = NOW;
  const tickTo = (targetMs) => { for (; t <= targetMs; t += INTERVAL_MS) e.watcher.tick(new Date(t)); };

  tickTo(NOW + CONFIRM_GAP_MS);
  check("(4) first confirmed episode fires once", e.parentNudges.length === 1);

  // Same episode, no change, a later tick must NOT re-fire (not per-sweep).
  tickTo(t + 60_000);
  check("(4) an unchanged episode does not re-fire on a later sweep", e.parentNudges.length === 1);

  // Recovery: repeated fresh orchestration sightings at a normal ~6min cadence restore a healthy
  // baseline. ONE sighting right after the long gap would record a single huge inter-arrival gap (the
  // whole stale duration) into its cadence window — recovery needs enough FURTHER normal-cadence
  // sightings afterward to age that one spike back out of the bounded MCP_ROUTER_CADENCE_WINDOW (5),
  // the same way a real reconnect's cadence baseline only genuinely heals after several normal
  // keepalives, not the very first one. Also keep feeding "task" at the same cadence throughout, so
  // the recurrence below stays unambiguously ASYMMETRIC (only orchestration stale) rather than
  // drifting into all-silent as task's own, separately seeded baseline ages out.
  const RECOVERY_SIGHTINGS = 6; // comfortably more than the 5-wide window needs to evict the one spike
  for (let i = 0; i < RECOVERY_SIGHTINGS; i++) {
    e.cadence.record("W5", "orchestration", t);
    e.cadence.record("W5", "task", t);
    tickTo(t + 6 * 60_000);
  }
  const cleanRecoveredAt = t - 6 * 60_000; // the LAST recovery sighting's own timestamp
  check("(4) recovery does not itself fire a notice", e.parentNudges.length === 1);

  // Recurrence: orchestration gets NO further sightings from here (so it ages back past its restored
  // ~18min threshold on its own) while task keeps getting fresh ones — a NEW episode must notify again
  // (after its own first-sighting + confirmation-gap delay), proving the episode was genuinely cleared
  // on recovery rather than left sticky. Feed task every ~6min throughout so it never itself goes stale.
  const recurrenceDeadline = cleanRecoveredAt + MCP_SILENCE_STALE_FLOOR_MS * MCP_SILENCE_STALE_MULTIPLIER + CONFIRM_GAP_MS + 60_000;
  while (t <= recurrenceDeadline) {
    if ((t - cleanRecoveredAt) % (6 * 60_000) < INTERVAL_MS) e.cadence.record("W5", "task", t);
    e.watcher.tick(new Date(t));
    t += INTERVAL_MS;
  }
  check("(4) a recurrence fires a SECOND, distinct notice once confirmed, proving the episode was cleared on recovery",
    e.parentNudges.length === 2);
}

// ============================ (5) the load-bearing case lag detection UNIQUELY prevents: a worsening ====
// ============================ that's ALREADY VISIBLE on the very first post-stall tick, whose catch-up ==
// ============================ traffic arrives slowly (the real 10feb23f specimen) =======================
// Round-3 Code Review correction (card d1521fca): an EARLIER version of this test made the stall only
// 12min long against a task router whose own threshold was 18min — so "task" didn't actually read
// stale until SEVERAL ticks after the stall ended, by which point the confirmation ladder alone (item
// B) already protects it, with or without lag detection (deleting the lag block left it green — it
// never exercised the mechanism it claimed to). Lag detection is load-bearing ONLY when the worsening
// is already visible on tick 1 after the stall — i.e. the stall itself is longer than the router's own
// per-router staleness threshold. Then: WITHOUT lag detection, the confirmation ladder's own clock
// starts right there (stallEnd) and would confirm FLOOR_MS later. WITH lag detection, the entire
// post-stall grace window (also FLOOR_MS) is skipped first, so the ladder's clock doesn't start until
// grace ends — confirming only a further FLOOR_MS after THAT. Catch-up traffic landing in the gap
// between those two points (after the no-lag confirm time, before the with-lag one) is exactly the
// real `10feb23f` shape: slow reconnection traffic arriving well inside two confirmation windows of the
// stall, but outside one.
{
  const e = makeEnv();
  seedManager(e, "M6");
  seedWorker(e, "W6", "M6");
  seedCadenceRouter(e, "W6", "task", 1); // fresh, ~6min cadence -> 18min threshold
  seedCadenceRouter(e, "W6", "orchestration", 25); // already stale (25 > 18min threshold) — the PRE-stall baseline

  tickThrough(e.watcher, NOW, NOW + CONFIRM_GAP_MS); // confirms the baseline ASYMMETRIC episode (orchestration stale, task fresh)
  check("(5) (setup) a confirmed asymmetric episode exists before the stall", e.parentNudges.length === 1);

  // The stall: no ticks fire and no new MCP traffic is recorded for either router, for long enough that
  // "task" (last real sighting at NOW-1min, 18min threshold) is ALREADY past its own threshold the
  // instant ticking resumes — so the all-silent worsening is visible on tick 1, not discovered several
  // ticks later. 20min comfortably exceeds both task's 18min threshold (age 21min at stallEnd) and the
  // lag multiplier's own 3min floor.
  const stallEnd = NOW + 20 * 60_000;
  e.watcher.tick(new Date(stallEnd)); // the first (lagged) tick to run since the stall
  check("(5) the lagged tick itself does not flag a second notice", e.parentNudges.length === 1);

  // The point a clock started immediately AT stallEnd (no lag protection) would confirm — and, with lag
  // protection, the point grace ends and the ladder's own clock FIRST gets a chance to start (both land
  // on the same stallEnd + FLOOR_MS, since lag's grace window is itself sized to FLOOR_MS).
  const noLagConfirmAt = stallEnd + MCP_SILENCE_STALE_FLOOR_MS;
  // Catch-up lands after that point (so an unprotected clock has already falsely confirmed) but well
  // before a grace-delayed clock's OWN confirm point (noLagConfirmAt + FLOOR_MS) — the real shape:
  // reconnection traffic slow enough to defeat the ladder alone, fast enough that lag's extra grace
  // window covers it.
  const catchupAt = noLagConfirmAt + 2 * 60_000;

  tickThrough(e.watcher, stallEnd + INTERVAL_MS, catchupAt - INTERVAL_MS);
  e.cadence.record("W6", "task", catchupAt);
  tickThrough(e.watcher, catchupAt, catchupAt + 4 * INTERVAL_MS);

  check("(5) still only the ORIGINAL notice — no false ALL-SILENT re-notify survives the stall + slow catch-up",
    e.parentNudges.length === 1 && e.leadNudges.length === 0);
}

// ============================ (6) real incidents still fire well within their own real durations ============================
// Both checks below drive the SAME real tick sequence every other test in this file uses (first
// sighting at the real onset, confirming tick one keepalive period later) and assert against the
// ACTUAL elapsed wall-clock time that sequence represents — never a separately-derived worst-case
// formula, which could pass or fail independent of what the watcher really just did.
{
  // a7c072c4: ~7.5h (450min) total-silence outage. Its onset-to-confirm window (one stale-threshold
  // crossing, ~18min here, plus one ~10min confirmation gap) is a small fraction of 450min.
  const e = makeEnv();
  seedManager(e, "M9");
  seedCadenceRouter(e, "M9", "task", 20);
  seedCadenceRouter(e, "M9", "orchestration", 20);
  tickThrough(e.watcher, NOW, NOW + CONFIRM_GAP_MS);
  check("(6) a7c072c4-shaped outage fires, and its confirm window is a small fraction of its real 450min duration",
    e.leadNudges.length === 1 && CONFIRM_GAP_MS < 450 * 60_000);
}
{
  // b5668822: ~40min total outage before recycling. Confirm detection completes comfortably inside it.
  const e = makeEnv();
  seedManager(e, "M10");
  seedWorker(e, "W10", "M10");
  seedCadenceRouter(e, "W10", "task", 1);
  seedCadenceRouter(e, "W10", "orchestration", 25);
  tickThrough(e.watcher, NOW, NOW + CONFIRM_GAP_MS);
  check("(6) b5668822-shaped outage fires well within its real 40min duration",
    e.parentNudges.length === 1 && CONFIRM_GAP_MS < 40 * 60_000);
}

// ============================ (7) codex: ALL-SILENT excluded, ASYMMETRIC unaffected ============================
{
  const e = makeEnv();
  seedManager(e, "M11", { lastActivityMin: 20, harness: "codex" });
  seedCadenceRouter(e, "M11", "task", 20);
  seedCadenceRouter(e, "M11", "orchestration", 20);
  tickThrough(e.watcher, NOW, NOW + CONFIRM_GAP_MS);
  check("(7) a codex session's ALL-SILENT shape never fires (no keepalive evidence for codex)",
    e.leadNudges.length === 0 && e.parentNudges.length === 0);
}
{
  const e = makeEnv();
  seedManager(e, "M12", { harness: "codex" });
  seedWorker(e, "W12", "M12", { harness: "codex" });
  seedCadenceRouter(e, "W12", "task", 1); // fresh
  seedCadenceRouter(e, "W12", "orchestration", 25); // stale
  tickThrough(e.watcher, NOW, NOW + CONFIRM_GAP_MS);
  check("(7) a codex session's ASYMMETRIC shape still fires normally (a fresh sibling router is real evidence)",
    e.parentNudges.length === 1);
}

// ============================ (8) a GENUINE worsening on an OPEN episode still goes through the ladder ===
// Code Review round 3 correction: the PRIOR version of this test asserted an immediate re-notify on a
// shape change — that was itself the bug item B fixes (a blip, or a stall artifact, could announce a
// brand-new episode with no chance to resolve first). A worsening beyond the confirmed baseline is now
// treated EXACTLY like a fresh session's first stale observation: pending, then confirmed one keepalive
// period later — never immediate.
{
  const e = makeEnv();
  seedManager(e, "M13");
  seedWorker(e, "W13", "M13");
  seedCadenceRouter(e, "W13", "task", 1); // fresh
  seedCadenceRouter(e, "W13", "orchestration", 25); // stale
  tickThrough(e.watcher, NOW, NOW + CONFIRM_GAP_MS); // confirmed asymmetric episode
  check("(8) baseline confirmed episode fired once", e.parentNudges.length === 1);

  // While the episode is STILL open (never recovered), task ALSO goes stale — the shape worsens to
  // all-silent. Task's own last REAL sighting was `seedCadenceRouter(..., "task", 1)`'s (NOW - 1min);
  // feed it NO further sightings and keep ticking (never record a new one) until it naturally ages past
  // its own ~18min threshold, around NOW+17min — then stop just short of a full confirmation gap past
  // that first sighting, to prove it does NOT notify yet.
  tickThrough(e.watcher, NOW + CONFIRM_GAP_MS + INTERVAL_MS, NOW + 18 * 60_000);
  check("(8) the worsening does NOT re-notify on its first sighting — it must sit pending first",
    e.parentNudges.length === 1);

  // One more confirmation gap later, STILL worse (no task sighting ever arrived) — now it notifies.
  tickThrough(e.watcher, NOW + 18 * 60_000 + INTERVAL_MS, NOW + 18 * 60_000 + CONFIRM_GAP_MS);
  check("(8) the worsening notifies once CONFIRMED, as a second, distinct notice", e.parentNudges.length === 2);
  const events = e.db.listEvents("M13").filter((x) => x.kind === "mcp_silence_detected");
  check("(8) the second event's shape is all-silent (the confirmed worsening)", events[1]?.detail?.shape === "all-silent");
}

// ============================ (9) a PARTIAL RECOVERY (subset of the confirmed baseline) never notifies ===
{
  const e = makeEnv();
  seedManager(e, "M14");
  seedCadenceRouter(e, "M14", "task", 20);
  seedCadenceRouter(e, "M14", "orchestration", 20);
  tickThrough(e.watcher, NOW, NOW + CONFIRM_GAP_MS); // confirmed ALL-SILENT episode (both routers stale)
  check("(9) (setup) confirmed all-silent episode fired once", e.leadNudges.length === 1);

  // "task" recovers (a fresh sighting arrives) while "orchestration" stays stale — the stale set
  // SHRINKS from {task, orchestration} to {orchestration}, a SUBSET of the confirmed baseline. This
  // must NEVER be announced — a partial recovery is not new silence.
  let t = NOW + CONFIRM_GAP_MS + INTERVAL_MS;
  e.cadence.record("M14", "task", t);
  e.watcher.tick(new Date(t));
  check("(9) a partial recovery (subset of the confirmed set) does not notify", e.leadNudges.length === 1);

  // Keep "task" fresh for a while (steady asymmetric state) — DENSE ticking throughout (never a lone
  // sparse jump — see tickThrough's own doc) so this phase is never itself misread as a tick lag; still
  // no second notice. Recording's own FIRST post-recovery gap (vs. task's last pre-shrink sighting,
  // ~31min earlier) is itself a cadence SPIKE (same mechanism test (4)'s own recovery phase documents)
  // — 6 further normal-cadence sightings (comfortably more than MCP_ROUTER_CADENCE_WINDOW(5) needs) age
  // it back out of the bounded window before this test relies on a clean ~6min cadence below.
  for (let i = 0; i < 6; i++) {
    const next = t + 6 * 60_000;
    tickThrough(e.watcher, t + INTERVAL_MS, next);
    e.cadence.record("M14", "task", next);
    t = next;
  }
  check("(9) the recovered (now asymmetric) state stays quiet on its own", e.leadNudges.length === 1);

  // Now "task" goes stale AGAIN (no further sightings) — growing BACK to the original full set must go
  // through its OWN fresh confirmation ladder (never an immediate re-notify just because this exact set
  // was seen once before) — proving the shrink genuinely updated the confirmed bookkeeping rather than
  // leaving the original full set silently remembered as "already confirmed". Task's cadence is now a
  // clean ~6min (the 6 recovery sightings above aged the recovery-gap spike out), so its own threshold
  // is max(FLOOR, 3x6min) = 18min — the crossing point this test ticks just past, THEN separately past
  // one more confirmation gap.
  const staleAgainAt = t + 18 * 60_000 + INTERVAL_MS;
  tickThrough(e.watcher, t + INTERVAL_MS, staleAgainAt);
  check("(9) task re-going-stale does not re-notify on its first sighting either", e.leadNudges.length === 1);
  tickThrough(e.watcher, staleAgainAt + INTERVAL_MS, staleAgainAt + CONFIRM_GAP_MS);
  check("(9) it DOES notify again once that recurrence is confirmed — the shrink was genuinely tracked, not sticky",
    e.leadNudges.length === 2);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the MCP-silence watchdog fires on both shapes only once confirmed across two keepalive-spaced evaluations (uniformly, whether a fresh candidate or a worsening of an already-confirmed episode), never false-positives on a post-stall tick (confirmation) or on a stall-induced shape-change re-notify with slow catch-up traffic (tick-lag detection — the load-bearing case), never announces a partial recovery as new silence, excludes codex from ALL-SILENT, and clears+re-fires across a recover/recur cycle."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
