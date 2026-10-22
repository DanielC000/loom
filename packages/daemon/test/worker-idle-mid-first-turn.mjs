import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 2ff893f3 (p2): classifyIdleWorker's `mid-first-turn` discriminator — see
// docs/decisions/2ff893f3-mid-first-turn-discriminator.md for the full mechanism and tradeoff.
//
// ROOT CAUSE: a busy:false worker row with turnSeq still 0 is NOT proof a turn ever finished (turnSeq
// only increments on a real Stop/StopFailure); a give-up path (fireEnterAndVerify's GIVE-UP RECOVERY, or
// submit()'s no-write ownership-mismatch branch) can clear `busy` with NO confirming hook ever landing,
// while the real engine is still alive and genuinely mid its first turn. classifyIdleWorker's fallthrough
// used to unconditionally read this as "finished a turn and is idle", firing [loom:worker-idle] repeatedly
// while the worker was actually still working.
//
// THE FIX: before falling through to `stranded`, check `turnSeq===0` AND a genuinely-unconfirmed current
// generation (`pty.getPendingConfirmMs` non-null) AND fresh real engine output (`pty.getLastOutputAt`
// within MID_FIRST_TURN_FRESH_OUTPUT_MS) AND that unconfirmed generation is still younger than this
// project's `stuckWorkerMinutes` (read via resolveConfig, parity with BusyWorkerWatcher) — if all four
// hold, classify `mid-first-turn` instead and suppress the notice. `getPendingConfirmMs` (not
// turnSeq-increment ordering) is the race-proof signal: a REAL Stop sets `enterConfirmed` true (making
// getPendingConfirmMs read null) strictly BEFORE it clears busy, so this never misfires against a genuine
// first-turn end even though turnSeq is still 0 at that exact instant (see test (1) below, which drives
// the REAL Stop path to prove this).
//
// CR ROUND 2 (two Majors, both fixed below):
// 1. The pre-round-2 version suppressed UNBOUNDED — `getLastOutputAt` counts every pty byte (spinner/
//    repaint included) and `getPendingConfirmMs` never ages out on its own, so a hung/looping turn with
//    a ticking spinner was suppressed FOREVER (strictly worse than pre-card: the manager used to at
//    least get an overclaiming notice). Fixed by bounding the suppression on `stuckWorkerMinutes`; past
//    it, a REAL, honestly-worded `mid-first-turn-stale` notice fires and re-paces at the ordinary idle
//    cadence — see (E)/(F) below.
// 2. Test (1) (pre-round-2) could never fail: it never called submit(), so `currentGenFirstWrittenAt`
//    stayed null and `getPendingConfirmMs` was null regardless of anything this fix does — a Code
//    Reviewer proved this by deleting BOTH `live.enterConfirmed = true` sites from dist and watching all
//    six checks still pass. Fixed by driving a REAL submit() (see test (1) below) plus a manually-run
//    negative control (move the Stop case's `enterConfirmed = true` to AFTER `setBusy(false,...)`,
//    rebuild, confirm test (1) goes RED, restore) — not automated in this file; see the card's own
//    verification log.
//
// (A) POSITIVE — the exact bug shape: turnSeq 0, genuinely unconfirmed, fresh output, WITHIN the
//     stuckWorkerMinutes bound → SUPPRESSED.
// (B) THE DISCRIMINATOR — identical to (A) except output has gone STALE → notice STILL fires (proves this
//     is not a blanket turnSeq===0 suppression; a genuinely-stalled first-turn worker is still caught).
//     Output-staleness is checked BEFORE the bound, so this scenario is unaffected by round 2 at all.
// (C) REGRESSION GUARD — turnSeq>0 (an ordinary, already-reported-once worker going idle again) with the
//     SAME unconfirmed+fresh-output shape → notice STILL fires (per card 2ff893f3 condition #5: this fix
//     is deliberately scoped to turnSeq===0 only; the turnSeq>0 residual is carded separately).
// (D) NARROWING PIN — `notifyManagerOfIdleWorker` returns a DISTINCT "suppressed-mid-first-turn" outcome,
//     never plain "none"; tickIdleWorkers' stamp-skip is keyed to that exact value only. A pre-existing
//     "none" kind (not-stranded via rate-limit) must keep its OLD unconditional pacing stamp — widening
//     the skip to every suppressed outcome would re-classify a week-long-rate-limited worker on every
//     60s tick instead of once per idleWorkerMinutes, with no corresponding benefit.
// (E) THE BOUND, under it — fresh output + unconfirmedAgeMs comfortably under `stuckWorkerMinutes` →
//     still suppressed, same as (A). No real clock involved: unconfirmedAgeMs is a canned fake-pty value.
// (F) THE BOUND, past it — fresh output + unconfirmedAgeMs PAST `stuckWorkerMinutes` → a real,
//     honestly-worded `sent-other` notice fires (never "finished a turn", never silence forever).
// (1) THE RACE, driven against the REAL PtyHost Stop-hook path (no fake pty stub), via a REAL submit() —
//     proves the fix does NOT depend on turnSeq-increment ordering relative to the busy falling edge.
// (G) CR round 3 M1 — flushComposer must NOT reset the bound's clock: driven against the REAL PtyHost,
//     proves `getUnconfirmedGenerationAgeMs` (what the bound reads) never resets across a real
//     `flushComposer()` call, even though `getPendingConfirmMs` (latency-logging's own, unchanged field)
//     is free to.
// (H) CR round 3 M3 — `stuckWorkerMinutes:0` means NO suppression at all (fail toward notifying), and
//     the reported minutes figure never reads "~0min" (floored to at least 1).
// (2) SUPPRESSION DOES NOT CONSUME — via the REAL IdleWatcher.tickIdleWorkers: a suppressed tick never
//     stamps `lastIdleNudgeAt`, so a LATER tick (once output reads stale) re-classifies from scratch and
//     still fires — not a one-shot dedup that would miss a worker that later genuinely stalls.
//
// No fixed-wait anywhere in this file — every "fresh"/"stale"/bound-straddling input is a canned
// `getUnconfirmedGenerationAgeMs`/`getLastOutputAt` return value compared against the REAL `Date.now()`
// the production code itself reads, never a real sleep guarding a negative assertion. Tests (1)/(G)'s
// `waitUntil` polls (never a blind sleep) wait on OBSERVABLE conditions (a real async write landing).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("worker-idle-mid-first-turn-"); // see idle-worker-watcher.mjs's own note: usage-awareness reads LOOM_HOME at module load
// Test (1) drives a REAL submit() through PtyHost's chunked-write pipeline (writeNewTurn/writeChunked)
// to make `currentGenFirstWrittenAt`/getPendingConfirmMs genuinely non-null — these two module-load-time
// constants must be zeroed BEFORE the dynamic import below, or the test waits out real 150ms/8ms delays
// for no behavioral reason. Harmless for every other scenario in this file (none of them touch submit()).
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = "0";
process.env.LOOM_PTY_WRITE_CHUNK_DELAY_MS = "0";
// Test (1) also needs a REAL on-disk transcript (readTranscript resolves off os.homedir() — see
// sessions/transcript.ts) to reach classifyIdleWorker's mid-first-turn code at all: with UserPromptSubmit
// deliberately never delivered, `hasFirstTurnStarted` stays false, so classifyIdleWorker's EARLIER
// broken-spawn gate (`!hasFirstTurnStarted && !everReported && emptyTranscript`) would otherwise catch it
// first — exactly the real incident's own shape ("turnSeq=0... while its transcript shows continuous
// tool calls"), where a NON-EMPTY transcript is what lets it fall through past that gate. Sandbox
// HOME/USERPROFILE BEFORE any dynamic import, mirroring worker-idle-spawn-broken-contradiction.mjs's own
// convention, so this never touches the real ~/.claude/projects.
const mft1TmpHome = path.join(os.tmpdir(), `loom-mft-race-home-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
const mft1SandboxHome = path.join(mft1TmpHome, "home");
fs.mkdirSync(mft1SandboxHome, { recursive: true });
process.env.USERPROFILE = mft1SandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = mft1SandboxHome;        // POSIX: os.homedir() reads HOME

/** Writes a real transcript JSONL to the (sandboxed) ~/.claude/projects/... path readTranscript
 *  resolves — mirrors worker-idle-spawn-broken-contradiction.mjs's own writeLiveTranscript fixture. */
function writeLiveTranscript(cwd, engineSessionId, turnTexts) {
  const file = engineTranscriptPath(cwd, engineSessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, turnTexts.map((t, i) =>
    JSON.stringify({ type: i % 2 === 0 ? "user" : "assistant", message: { content: [{ type: "text", text: t }] } })
  ).join("\n") + "\n");
}
const Database = (await import("better-sqlite3")).default; // test (D)'s raw-connection backdate — mirrors all-archived-sessions.mjs's own pattern
const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { IdleWatcher } = await import("../dist/orchestration/idle-watcher.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

/** Bounded poll for an OBSERVABLE condition (never a blind sleep) — used only by test (1), to wait for
 *  the real chunked-write pipeline to reach fireEnterAndVerify's attempt-1 stamp. Throws on timeout so a
 *  genuine regression fails loud instead of silently asserting against a still-null precondition. */
async function waitUntil(fn, { timeoutMs = 2000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (fn()) return;
    if (Date.now() >= deadline) throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const now = new Date().toISOString();

function makeEnv() {
  const dbFile = path.join(os.tmpdir(), `loom-mft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Db(dbFile);
  const projId = `mft-${sfx}-${Math.random().toString(36).slice(2, 6)}`;
  const agentId = `mft-ag-${sfx}`;
  db.insertProject({ id: projId, name: "MidFirstTurn", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });

  const enqueued = [];
  const firstTurnStarted = new Set();
  // Card 2ff893f3 round 3 (M1): classifyIdleWorker reads getUnconfirmedGenerationAgeMs, NEVER
  // getPendingConfirmMs, for the bound/gate — this canned map simulates THAT getter directly.
  const unconfirmedAgeMs = new Map(); // id -> number (unconfirmed) — absent/undefined means "confirmed/nothing outstanding"
  const lastOutputAt = new Map(); // id -> epoch ms
  const pty = {
    isAlive: () => true,
    enqueueStdin: (id, text) => { enqueued.push({ id, text }); return { delivered: true }; },
    getPendingEntries: () => [],
    hasFirstTurnStarted: (id) => firstTurnStarted.has(id),
    getUnconfirmedGenerationAgeMs: (id) => (unconfirmedAgeMs.has(id) ? unconfirmedAgeMs.get(id) : null),
    getLastOutputAt: (id) => lastOutputAt.get(id),
  };
  const sessions = new SessionService(db, pty, new OrchestrationControl());
  return { dbFile, db, projId, agentId, enqueued, firstTurnStarted, unconfirmedAgeMs, lastOutputAt, sessions, pty };
}
function seedWorker(e, id, parentId, taskId, { idleMin = 0 } = {}) {
  const activityAt = idleMin > 0 ? new Date(Date.now() - idleMin * 60_000).toISOString() : now;
  e.db.insertSession({
    id, projectId: e.projId, agentId: e.agentId, engineSessionId: "eng-" + id, title: null, cwd: e.projId,
    processState: "live", resumability: "resumable", busy: false,
    createdAt: activityAt, lastActivity: activityAt, lastError: null, role: "worker",
    parentSessionId: parentId, taskId, ctxInputTokens: null, ctxTurns: null, model: null,
  });
}
function seedManager(e, id) {
  e.db.insertSession({
    id, projectId: e.projId, agentId: e.agentId, engineSessionId: "eng-" + id, title: null, cwd: e.projId,
    processState: "live", resumability: "resumable", busy: false,
    createdAt: now, lastActivity: now, lastError: null, role: "manager",
    ctxInputTokens: null, ctxTurns: null, model: null,
  });
}
function seedTask(e, id) {
  e.db.insertTask({ id, projectId: e.projId, title: "T-" + id, body: "", columnKey: "in_progress", position: 0, createdAt: now, updatedAt: now });
}
function cleanup(e) {
  try { e.db.close(); } catch { /* ignore */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(e.dbFile + ext, { force: true }); } catch { /* ignore */ } }
}

// ============ (A) POSITIVE — turnSeq 0, unconfirmed, FRESH output → SUPPRESSED =========================
{
  const e = makeEnv();
  seedManager(e, "mgr-a"); seedTask(e, "tk-a"); seedWorker(e, "wkr-a", "mgr-a", "tk-a");
  e.firstTurnStarted.add("wkr-a"); // genuinely started its first turn
  e.unconfirmedAgeMs.set("wkr-a", 5_000); // the current generation's Enter write is still unconfirmed
  e.lastOutputAt.set("wkr-a", Date.now()); // the engine emitted output just now

  const outcomeA = e.sessions.notifyManagerOfIdleWorker("wkr-a");

  check("(A) turnSeq really is 0 for this specimen (the condition under test)", e.db.getSession("wkr-a").turnSeq === 0);
  check("(A) SUPPRESSED: no [loom:worker-idle] fires for a genuinely mid-first-turn worker", e.enqueued.length === 0);
  check("(A) the outcome is the DISTINCT 'suppressed-mid-first-turn' value, never plain 'none'", outcomeA === "suppressed-mid-first-turn");
  cleanup(e);
}

// ============ (B) THE DISCRIMINATOR — identical to (A) but output has gone STALE → still fires ==========
{
  const e = makeEnv();
  seedManager(e, "mgr-b"); seedTask(e, "tk-b"); seedWorker(e, "wkr-b", "mgr-b", "tk-b");
  e.firstTurnStarted.add("wkr-b");
  e.unconfirmedAgeMs.set("wkr-b", 5_000); // same unconfirmed shape as (A)
  e.lastOutputAt.set("wkr-b", Date.now() - 60_000); // but output stopped 60s ago — past the 30s window

  e.sessions.notifyManagerOfIdleWorker("wkr-b");

  const idle = e.enqueued.filter((x) => x.id === "mgr-b" && x.text.includes("[loom:worker-idle]"));
  check("(B) DISCRIMINATOR: a genuinely-stale mid-first-turn worker STILL gets [loom:worker-idle]", idle.length === 1);
  check("(B) wording is the pre-existing 'did NOT call worker_report' shape (content untouched)",
    idle[0]?.text.includes("did NOT call worker_report") ?? false);
  cleanup(e);
}

// ============ (C) REGRESSION GUARD — turnSeq>0, SAME unconfirmed+fresh shape → still fires ===============
{
  const e = makeEnv();
  seedManager(e, "mgr-c"); seedTask(e, "tk-c"); seedWorker(e, "wkr-c", "mgr-c", "tk-c");
  e.firstTurnStarted.add("wkr-c");
  e.db.incrementTurnSeq("wkr-c"); e.db.incrementTurnSeq("wkr-c"); // turnSeq -> 2: an ordinary, already-turned worker
  e.unconfirmedAgeMs.set("wkr-c", 5_000); // deliberately the SAME give-up shape as (A) — proves the GATE is turnSeq, not this signal
  e.lastOutputAt.set("wkr-c", Date.now()); // deliberately the SAME fresh output as (A)

  e.sessions.notifyManagerOfIdleWorker("wkr-c");

  check("(C) setup: turnSeq really is >0 for this specimen", e.db.getSession("wkr-c").turnSeq === 2);
  const idle = e.enqueued.filter((x) => x.id === "mgr-c" && x.text.includes("[loom:worker-idle]"));
  check("(C) REGRESSION GUARD: turnSeq>0 is UNAFFECTED by this fix — [loom:worker-idle] still fires", idle.length === 1);
  cleanup(e);
}

// ============ (D) NARROWING PIN — a PRE-EXISTING "none" kind (not-stranded, rate-limited) keeps its =======
// ============     OLD unconditional stamp via tickIdleWorkers — this card's stamp-skip must NOT widen =====
// ============     to every suppressed outcome, only to "suppressed-mid-first-turn" ==========================
{
  const e = makeEnv();
  seedManager(e, "mgr-d"); seedTask(e, "tk-d");
  seedWorker(e, "wkr-d", "mgr-d", "tk-d", { idleMin: 60 }); // past idleWorkerMinutes, so tickIdleWorkers evaluates it
  e.db.setRateLimitedUntil("wkr-d", new Date(Date.now() + 60 * 60_000).toISOString(), "simulated weekly cap");
  // setRateLimitedUntil ALSO bumps last_activity to "now" (db.ts's own doc: "so the UI shows
  // parked-not-dead") — undoing the idleMin:60 backdating above. Re-backdate it via a raw connection to
  // the SAME file (mirrors all-archived-sessions.mjs's own raw-Database pattern) so idleForMin still
  // clears tickIdleWorkers' own pacing gate, isolating this test to the stamp-skip narrowing it targets.
  {
    const raw = new Database(e.dbFile);
    raw.prepare("UPDATE sessions SET last_activity = ? WHERE id = ?").run(new Date(Date.now() - 60 * 60_000).toISOString(), "wkr-d");
    raw.close();
  }
  check("(D) setup: the worker is actually rate-limited (precondition for this test)",
    (() => { const s = e.db.getSession("wkr-d"); return !!s.rateLimitedUntil && Date.parse(s.rateLimitedUntil) > Date.now(); })());
  check("(D) setup: the worker reads idle past idleWorkerMinutes despite the rate-limit bump (precondition)",
    (() => { const s = e.db.getSession("wkr-d"); return (Date.now() - Date.parse(s.lastActivity)) / 60_000 >= 45; })());

  const watcher = new IdleWatcher({
    db: e.db, pty: e.pty, control: new OrchestrationControl(), recycleRatio: 0,
    notifyIdleWorker: (id) => e.sessions.notifyManagerOfIdleWorker(id),
    isWorkerStranded: (id) => e.sessions.isWorkerGenuinelyStranded(id),
  });

  const stateBefore = e.db.getIdleNudgeState("wkr-d");
  watcher.tick(new Date());
  const idleD = e.enqueued.filter((x) => x.id === "mgr-d" && x.text.includes("[loom:worker-idle]"));
  check("(D) rate-limited worker still correctly gets NO notice (not-stranded → none, unaffected)", idleD.length === 0);
  check("(D) NARROWING PIN: a plain 'none' kind STILL stamps lastIdleNudgeAt unconditionally (old behavior preserved)",
    !!e.db.getIdleNudgeState("wkr-d")?.lastIdleNudgeAt && e.db.getIdleNudgeState("wkr-d")?.lastIdleNudgeAt !== stateBefore?.lastIdleNudgeAt);
  cleanup(e);
}

// ============ (E) THE BOUND, under it — fresh output + pendingConfirmMs UNDER stuckWorkerMinutes ========
// ============     → still suppressed (CR Major round 2's fix must not suppress unconditionally forever,==
// ============     but it must still suppress WITHIN the bound, same as (A)) ===============================
{
  const e = makeEnv();
  seedManager(e, "mgr-e"); seedTask(e, "tk-e"); seedWorker(e, "wkr-e", "mgr-e", "tk-e");
  e.firstTurnStarted.add("wkr-e");
  // makeEnv's project config is {} → PLATFORM_DEFAULTS.orchestration.stuckWorkerMinutes = 60 (3_600_000ms).
  // No fixed wait anywhere here — pendingConfirmMs is a CANNED value on the fake pty, never a real clock.
  e.unconfirmedAgeMs.set("wkr-e", 10_000); // 10s unconfirmed — comfortably under the 60min bound
  e.lastOutputAt.set("wkr-e", Date.now()); // fresh

  const outcomeE = e.sessions.notifyManagerOfIdleWorker("wkr-e");

  check("(E) setup: turnSeq is 0", e.db.getSession("wkr-e").turnSeq === 0);
  check("(E) UNDER THE BOUND: still suppressed (mid-first-turn), never forever-unbounded", e.enqueued.length === 0);
  check("(E) the outcome is the suppressed value", outcomeE === "suppressed-mid-first-turn");
  cleanup(e);
}

// ============ (F) THE BOUND, past it — fresh output + pendingConfirmMs PAST stuckWorkerMinutes ===========
// ============     → a REAL, honestly-worded notice fires (never the old "finished a turn" claim, ========
// ============     never silence forever — CR Major round 2's whole point) =================================
{
  const e = makeEnv();
  seedManager(e, "mgr-f"); seedTask(e, "tk-f"); seedWorker(e, "wkr-f", "mgr-f", "tk-f");
  e.firstTurnStarted.add("wkr-f");
  e.unconfirmedAgeMs.set("wkr-f", 70 * 60_000); // 70min unconfirmed — past the 60min default bound
  e.lastOutputAt.set("wkr-f", Date.now()); // STILL fresh — this is exactly the "hung but spinning" shape

  const outcomeF = e.sessions.notifyManagerOfIdleWorker("wkr-f");

  check("(F) setup: turnSeq is 0", e.db.getSession("wkr-f").turnSeq === 0);
  const idleF = e.enqueued.filter((x) => x.id === "mgr-f" && x.text.includes("[loom:worker-idle]"));
  check("(F) PAST THE BOUND: a real notice fires despite output STILL being fresh", idleF.length === 1);
  check("(F) the outcome is a normal 'sent-other', never the suppressed value (paces at the ordinary cadence)", outcomeF === "sent-other");
  check("(F) does NOT claim 'finished a turn' (turnSeq is still 0 — that claim stays false)",
    !!idleF[0] && !idleF[0].text.includes("finished a turn"));
  check("(F) honestly states the minutes-unconfirmed figure", !!idleF[0] && /~70min/.test(idleF[0].text));
  check("(F) honestly names the busy-desync mechanism (no UserPromptSubmit/Stop landed)", !!idleF[0] && /busy desync/.test(idleF[0].text));
  check("(F) points at worker_transcript and worker_flush, not worker_report/worker_merge (no turn to review)",
    !!idleF[0] && idleF[0].text.includes("worker_transcript") && idleF[0].text.includes("worker_flush"));
  cleanup(e);
}

// ============ (1) THE RACE — driven against the REAL PtyHost Stop-hook path, no fake stub ================
{
  class TestPtyHost extends createSeamHost(PtyHost) {}
  const dbFile = path.join(os.tmpdir(), `loom-mft-race-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Db(dbFile);
  const projId = `mftr-${sfx}`, agentId = `mftr-ag-${sfx}`;
  db.insertProject({ id: projId, name: "MidFirstTurnRace", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  const mgrId = "mftr-mgr", wkrId = "mftr-wkr", taskId = "mftr-tk";
  db.insertSession({
    id: mgrId, projectId: projId, agentId, engineSessionId: `eng-${mgrId}`, title: null, cwd: projId,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager",
  });
  db.insertTask({ id: taskId, projectId: projId, title: "T-" + taskId, body: "", columnKey: "in_progress", position: 0, createdAt: now, updatedAt: now });
  db.insertSession({
    id: wkrId, projectId: projId, agentId, engineSessionId: `eng-${wkrId}`, title: null, cwd: projId,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "worker", parentSessionId: mgrId, taskId,
  });

  let sessions;
  const events = {
    onEngineSessionId() {}, onContextStats() {}, onRateLimited() {}, onExit() {},
    onBusy: (sessionId, busy) => sessions.handleBusyEdge(sessionId, busy),
    // Mirrors index.ts's real wiring (card 343441bd) — needed so `turnSeq` actually increments on this
    // test's real Stop delivery, which is the exact ordering (increment happens AFTER the busy falling
    // edge already ran) this test exists to drive against.
    onTurnCompleted: (sessionId) => db.incrementTurnSeq(sessionId),
  };
  const host = new TestPtyHost(events);
  sessions = new SessionService(db, host, new OrchestrationControl());

  // Reuses the module-scope mft1TmpHome (its own sandboxed HOME/USERPROFILE is what readTranscript below
  // actually needs to resolve against) rather than a second, unrelated tmp dir.
  const tmpHome = mft1TmpHome;
  fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
  try {
    function spawnReady(sessionId) {
      host.spawn({
        sessionId, cwd: tmpHome,
        permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
        geometry: { cols: 120, rows: 40 }, sessionEnv: {},
      });
      host.deliverHook(sessionId, { hook_event_name: "SessionStart" });
    }
    spawnReady(mgrId);
    spawnReady(wkrId);

    // Arm the manager busy (mirrors pty-handlebusyedge-db-failure-notify.mjs's own technique) so the
    // worker's falling-edge nudge below QUEUES (inspectable via getPendingEntries) instead of delivering
    // live, where it would write straight to the manager's pty with nothing left in the queue to assert on.
    host.deliverHook(mgrId, { hook_event_name: "UserPromptSubmit" });
    check("(1) setup: the manager is busy (so the worker's nudge below queues, not delivers live)", db.getSession(mgrId).busy === true);

    // CR Major (round 2): drive a REAL submit() through the chunked-write pipeline — the worker's own
    // falling-edge check reads `pty.getPendingConfirmMs`, which stays null until `currentGenFirstWrittenAt`
    // is stamped by fireEnterAndVerify's attempt-1 write (host.ts ~12349), reachable ONLY via a real
    // submit(), never by a bare UserPromptSubmit hook delivery alone. Deliberately SKIP UserPromptSubmit
    // (simulating the exact "kickoff Enter landed but the confirming hook got lost" shape) — Stop below is
    // this worker's ONLY confirming hook, which is the race this test exists to drive against.
    host.enqueueStdin(wkrId, "simulated first-turn kickoff text");
    await waitUntil(() => host.getPendingConfirmMs(wkrId) != null);
    check("(1) setup: the worker is genuinely busy after its own submit()", db.getSession(wkrId).busy === true);
    check("(1) setup: turnSeq is still 0 before any Stop (nothing completed yet)", db.getSession(wkrId).turnSeq === 0);
    check("(1) setup: the generation is genuinely unconfirmed (getPendingConfirmMs non-null) — the exact precondition classifyIdleWorker's bug-era code would have misread as 'mid-first-turn'", host.getPendingConfirmMs(wkrId) != null);
    check("(1) setup: getUnconfirmedGenerationAgeMs ALSO reads non-null — the getter classifyIdleWorker actually reads now (M1)", host.getUnconfirmedGenerationAgeMs(wkrId) != null);

    // A REAL on-disk transcript — otherwise `hasFirstTurnStarted:false` (never set; UserPromptSubmit is
    // never delivered below) routes classifyIdleWorker through its EARLIER broken-spawn gate instead of
    // ever reaching mid-first-turn/stranded at all. Matches the real incident's own shape: "transcript
    // shows continuous tool calls" despite turnSeq still reading 0.
    writeLiveTranscript(tmpHome, `eng-${wkrId}`, ["kickoff: do the thing", "working on it — running a tool"]);

    // The worker's REAL first turn ends (Stop) — NEVER calling worker_report, and UserPromptSubmit was
    // never delivered. This is the exact race: Stop sets enterConfirmed=true and clears busy (cascading
    // synchronously into notifyManagerOfIdleWorker) strictly BEFORE turnSeq is incremented later in the
    // SAME Stop-case handler — and strictly BEFORE this falling edge's own getPendingConfirmMs read.
    host.deliverHook(wkrId, { hook_event_name: "Stop" });

    check("(1) turnSeq DID increment (confirms the ordering this fix is race-proof against)", db.getSession(wkrId).turnSeq === 1);
    check("(1) getPendingConfirmMs is NOW null (Stop's own enterConfirmed=true resolved it)", host.getPendingConfirmMs(wkrId) == null);
    check("(1) getUnconfirmedGenerationAgeMs is ALSO NOW null (same enterConfirmed=true resolves both)", host.getUnconfirmedGenerationAgeMs(wkrId) == null);
    const idle = host.getPendingEntries(mgrId).filter((x) => x.text.startsWith(`[loom:worker-idle] worker ${wkrId} `));
    check("(1) THE RACE: a genuine first-turn end STILL fires [loom:worker-idle] AT THE EDGE, not suppressed", idle.length === 1);
    check("(1) wording is the pre-existing 'did NOT call worker_report' shape", idle[0]?.text.includes("did NOT call worker_report") ?? false);
  } finally {
    try { db.close(); } catch { /* ignore */ }
    for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* ignore */ } }
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ============ (G) M1 — flushComposer must NOT reset the bound's clock ====================================
// ============     (CR round 3): getPendingConfirmMs's clock DOES reset on a flush (pre-existing, =========
// ============     unchanged behavior for the latency-logging reader); getUnconfirmedGenerationAgeMs =====
// ============     — what classifyIdleWorker's bound actually reads — must NOT. ============================
{
  class TestPtyHost extends createSeamHost(PtyHost) {}
  const dbFile = path.join(os.tmpdir(), `loom-mft-flush-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Db(dbFile);
  const projId = `mftg-${sfx}`, agentId = `mftg-ag-${sfx}`;
  db.insertProject({ id: projId, name: "MidFirstTurnFlush", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  const wkrId = "mftg-wkr";
  const gTmpHome = path.join(os.tmpdir(), `loom-mft-flush-home-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(path.join(gTmpHome, "logs"), { recursive: true });
  db.insertSession({
    id: wkrId, projectId: projId, agentId, engineSessionId: `eng-${wkrId}`, title: null, cwd: gTmpHome,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "worker",
  });
  const events = { onEngineSessionId() {}, onContextStats() {}, onRateLimited() {}, onExit() {}, onBusy() {}, onTurnCompleted() {} };
  const host = new TestPtyHost(events);
  try {
    host.spawn({
      sessionId: wkrId, cwd: gTmpHome,
      permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
      geometry: { cols: 120, rows: 40 }, sessionEnv: {},
    });
    host.deliverHook(wkrId, { hook_event_name: "SessionStart" });

    host.enqueueStdin(wkrId, "simulated first-turn kickoff text");
    // Wait for the ORIGINAL submit()'s own natural Enter write to land FIRST (both getters non-null) —
    // calling flushComposer before that lands would race it against this same submit()'s own in-flight
    // attempt-1 write, an unrealistic double-write this test doesn't intend to exercise.
    await waitUntil(() => host.getPendingConfirmMs(wkrId) != null && host.getUnconfirmedGenerationAgeMs(wkrId) != null);
    const pendingBefore = host.getPendingConfirmMs(wkrId);
    const ageBefore = host.getUnconfirmedGenerationAgeMs(wkrId);
    check("(G) setup: both getters read non-null before any flush", pendingBefore != null && ageBefore != null);

    // Await the FULL flushComposer() call (its own internally-bounded settle wait) rather than racing
    // its async attempt:1 re-entry via a second, independently-timed poll — simpler and just as decisive:
    // whatever flushComposer did internally, THIS field must never have gone backwards by the time it
    // returns.
    await host.flushComposer(wkrId);
    const pendingAfter = host.getPendingConfirmMs(wkrId);
    const ageAfter = host.getUnconfirmedGenerationAgeMs(wkrId);
    check("(G) M1 FIX: getUnconfirmedGenerationAgeMs did NOT reset across the flush — it only ever grows",
      ageAfter == null || ageAfter >= ageBefore);
    // Informational, not the load-bearing claim: getPendingConfirmMs's OWN pre-existing (unchanged)
    // behavior — it's allowed to reset (that's the bug this fix routes AROUND, not fixes directly).
    console.log(`[(G) info] pendingBefore=${pendingBefore} pendingAfter=${pendingAfter} ageBefore=${ageBefore} ageAfter=${ageAfter}`);
  } finally {
    try { db.close(); } catch { /* ignore */ }
    for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* ignore */ } }
    try { fs.rmSync(gTmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ============ (H) M3 — stuckWorkerMinutes===0 means NO suppression at all (fail toward notifying) =======
{
  const e = makeEnv();
  // A per-project override: stuckWorkerMinutes:0 — resolveConfig reads this, never a hard-coded value.
  const projId2 = `mft-h-${sfx}`;
  e.db.insertProject({ id: projId2, name: "MidFirstTurnZeroBound", repoPath: projId2, vaultPath: projId2, config: { orchestration: { stuckWorkerMinutes: 0 } }, createdAt: now, archivedAt: null });
  e.db.insertAgent({ id: `mft-h-ag-${sfx}`, projectId: projId2, name: "t", startupPrompt: "orchestrate", position: 0 });
  e.db.insertTask({ id: "tk-h", projectId: projId2, title: "T-tk-h", body: "", columnKey: "in_progress", position: 0, createdAt: now, updatedAt: now });
  e.db.insertSession({
    id: "mgr-h", projectId: projId2, agentId: `mft-h-ag-${sfx}`, engineSessionId: "eng-mgr-h", title: null, cwd: projId2,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager",
    ctxInputTokens: null, ctxTurns: null, model: null,
  });
  e.db.insertSession({
    id: "wkr-h", projectId: projId2, agentId: `mft-h-ag-${sfx}`, engineSessionId: "eng-wkr-h", title: null, cwd: projId2,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker",
    parentSessionId: "mgr-h", taskId: "tk-h", ctxInputTokens: null, ctxTurns: null, model: null,
  });
  e.firstTurnStarted.add("wkr-h");
  e.unconfirmedAgeMs.set("wkr-h", 5_000); // only 5s unconfirmed — would be WELL under any normal bound
  e.lastOutputAt.set("wkr-h", Date.now()); // fresh

  const outcomeH = e.sessions.notifyManagerOfIdleWorker("wkr-h");

  const idleH = e.enqueued.filter((x) => x.id === "mgr-h" && x.text.includes("[loom:worker-idle]"));
  check("(H) stuckWorkerMinutes=0: NEVER suppresses, even at only 5s unconfirmed", idleH.length === 1 && outcomeH === "sent-other");
  check("(H) never emits the misleading '~0min' (floored to at least 1)", !!idleH[0] && !/~0min/.test(idleH[0].text));
  cleanup(e);
}

// ============ (2) SUPPRESSION DOES NOT CONSUME — via the REAL IdleWatcher.tickIdleWorkers ================
{
  const e = makeEnv();
  seedManager(e, "mgr-2"); seedTask(e, "tk-2");
  // Idle 60 min ago — past the default idleWorkerMinutes (45) so tickIdleWorkers' own pacing gate doesn't
  // itself skip evaluating this worker on either tick (isolating the assertion to THIS fix's discriminator).
  seedWorker(e, "wkr-2", "mgr-2", "tk-2", { idleMin: 60 });
  e.firstTurnStarted.add("wkr-2");
  e.unconfirmedAgeMs.set("wkr-2", 5_000);
  const watcher = new IdleWatcher({
    db: e.db, pty: e.pty, control: new OrchestrationControl(), recycleRatio: 0,
    notifyIdleWorker: (id) => e.sessions.notifyManagerOfIdleWorker(id),
    isWorkerStranded: (id) => e.sessions.isWorkerGenuinelyStranded(id),
  });

  e.lastOutputAt.set("wkr-2", Date.now()); // tick 1: fresh — expect suppression
  const stateBefore = e.db.getIdleNudgeState("wkr-2");
  watcher.tick(new Date());
  const idleAfterTick1 = e.enqueued.filter((x) => x.id === "mgr-2" && x.text.includes("[loom:worker-idle]"));
  const stateAfterTick1 = e.db.getIdleNudgeState("wkr-2");
  check("(2) tick 1 (fresh output): suppressed, no nudge enqueued", idleAfterTick1.length === 0);
  check("(2) tick 1: suppression did NOT stamp lastIdleNudgeAt (not consumed/deduped)",
    stateAfterTick1?.lastIdleNudgeAt === stateBefore?.lastIdleNudgeAt);

  e.lastOutputAt.set("wkr-2", Date.now() - 60_000); // tick 2: the SAME worker, output now stale
  watcher.tick(new Date());
  const idleAfterTick2 = e.enqueued.filter((x) => x.id === "mgr-2" && x.text.includes("[loom:worker-idle]"));
  check("(2) tick 2 (output now stale): re-classified from scratch and FIRES", idleAfterTick2.length === 1);
  check("(2) tick 2: lastIdleNudgeAt is NOW stamped (the real re-nudge-pacing path ran)",
    !!e.db.getIdleNudgeState("wkr-2")?.lastIdleNudgeAt);
  cleanup(e);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card 2ff893f3: classifyIdleWorker's mid-first-turn discriminator suppresses the false "
    + "'finished a turn' notice for a genuinely-still-working, unconfirmed turnSeq===0 worker within the "
    + "stuckWorkerMinutes bound (A), while still catching a genuinely-stalled one once output goes stale "
    + "(B) and leaving every turnSeq>0 worker fully unaffected (C). The stamp-skip is narrowly keyed to the "
    + "DISTINCT 'suppressed-mid-first-turn' outcome — a pre-existing 'none' kind (rate-limited not-stranded) "
    + "keeps its old unconditional pacing stamp, unwidened (D). CR round 2: the suppression is bounded by "
    + "stuckWorkerMinutes (parity with BusyWorkerWatcher) rather than unbounded (E under the bound still "
    + "suppresses; F past it fires a real, honestly-worded notice instead of silence forever). The REAL "
    + "Stop-hook path, via a REAL submit(), proves the fix is race-proof against turnSeq-increment ordering "
    + "(1). CR round 3: the bound reads a flush-resistant clock, proven against the REAL PtyHost — a real "
    + "flushComposer() call never resets it (G) — and stuckWorkerMinutes:0 means no suppression at all, "
    + "never a misleading '~0min' (H). Suppression never consumes/dedupes THIS kind's own notice — a later "
    + "tick re-classifies from scratch and still fires once output genuinely goes stale (2)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
