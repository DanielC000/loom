import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 66ff7321 (part C of 8c7dfc65) — ContextWatcher's CONTEXT-EXHAUSTION detection, the
// manager/platform twin of busy-worker-watcher-context-exhausted.mjs's own worker-side test. NO
// claude — the watcher takes an injected pty-slice, so the tick tests use a RECORDING STUB and drive
// tick() directly. Hermetic: each env gets its OWN temp .db + a transcript fixture written at the
// path resolveTranscriptFile/engineTranscriptPath resolve to (never a hand-constructed path), under a
// sandboxed home (see the @decision anchor below), cleaned up in a `finally`-equivalent per case.
//
// Also proves the human-attention routing: companion/attention-push.ts's classify() maps
// manager_context_exhausted to the SAME "context-overflow" class its context_escalated/
// context_blind_turn siblings already use — no new push channel, per the manager's own ruling.
//
// Run: 1) build (turbo builds shared first), 2) node packages/daemon/test/context-watcher-context-exhausted.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdtempManaged } from "./_tmp-fixture.mjs";

// @decision 668bc52c — sandbox HOME/USERPROFILE to a managed temp dir BEFORE importing dist; never
// write a transcript fixture under the real os.homedir(), and never import dist after the sandbox is
// set but let a module-load-time os.homedir() read slip in before it.
const sandboxHome = mkdtempManaged("loom-ctxw-ctxexh-home-");
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME
// @decision a92a0913 — also delete an ambient CLAUDE_CONFIG_DIR: claudeConfigHome() reads it ahead of
// os.homedir(), so an inherited value would bypass the HOME/USERPROFILE override above entirely.
delete process.env.CLAUDE_CONFIG_DIR;

const { Db } = await import("../dist/db.js");
const { ContextWatcher } = await import("../dist/orchestration/context-watcher.js");
const { classify } = await import("../dist/companion/attention-push.js");
const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const NOW = new Date("2026-11-02T21:00:00.000Z");
const RUN_SUFFIX = `${Date.now()}-${process.pid}`;

const REAL_EXHAUSTION_RECORD = {
  type: "assistant",
  message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text: "Prompt is too long" }] },
  error: "invalid_request", isApiErrorMessage: true,
};

// card 5f825506 (item 1) — the SAME shape, but carrying an explicit `timestamp` so a test can place it
// relative to a `busySinceMs` cutoff. REAL_EXHAUSTION_RECORD above stays untouched (no timestamp) so
// every pre-existing test keeps exercising the "no timestamp ⇒ cutoff never rejects it" fail-open path
// implicitly, exactly as it did before this card.
const exhaustionRecordAt = (isoTimestamp) => ({ ...REAL_EXHAUSTION_RECORD, timestamp: isoTimestamp });

function makeEnv() {
  const dbFile = path.join(os.tmpdir(), `loom-ctxw-ctxexh-${RUN_SUFFIX}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Db(dbFile);
  const projId = `cwx-${RUN_SUFFIX}`;
  const agentId = `cwa-${RUN_SUFFIX}`;
  const now = NOW.toISOString();
  db.insertProject({ id: projId, name: "CtxWatchExh", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });
  const alive = new Set();
  const enqueued = [];
  const markedExhausted = [];
  // card 5f825506 (item 1) — per-session turn-start stamp, settable per test via e.busySinceMsById;
  // defaults to `null` (no cutoff supplied) for every test that doesn't set one, which must stay
  // byte-identical to the pre-card behaviour.
  const busySinceMsById = new Map();
  const pty = {
    isAlive: (id) => alive.has(id),
    enqueueStdin: (id, text) => { enqueued.push({ id, text }); return { delivered: true, queued: false }; },
    markContextExhausted: (id) => {
      markedExhausted.push(id);
      if (!alive.has(id)) return false;
      db.setBusy(id, false);
      return true;
    },
    busySinceMs: (id) => busySinceMsById.get(id) ?? null,
  };
  const watcher = new ContextWatcher({ db, pty, ratio: 0 }); // ratio 0 = no env force override; not this file's concern
  const transcriptFiles = [];
  return { dbFile, db, projId, agentId, alive, enqueued, markedExhausted, busySinceMsById, pty, watcher, transcriptFiles };
}

function seedSession(e, id, { role }) {
  const cwd = `${e.projId}-${id}`;
  const engineSessionId = `eng-${RUN_SUFFIX}-${id}`;
  e.db.insertSession({
    id, projectId: e.projId, agentId: e.agentId, engineSessionId, title: null, cwd,
    processState: "live", resumability: "resumable", busy: true,
    createdAt: NOW.toISOString(), lastActivity: NOW.toISOString(), lastError: null, role,
    ctxInputTokens: null, ctxTurns: null, model: null,
  });
  e.alive.add(id);
  return { cwd, engineSessionId };
}

function writeExhaustionFixture(e, cwd, engineSessionId, record = REAL_EXHAUSTION_RECORD) {
  const file = engineTranscriptPath(cwd, engineSessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(record)}\n`);
  e.transcriptFiles.push(file);
  return file;
}

function cleanup(e) {
  try { e.db.close(); } catch { /* ignore */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(e.dbFile + ext, { force: true }); } catch { /* ignore */ } }
  for (const file of e.transcriptFiles) { try { fs.rmSync(path.dirname(file), { recursive: true, force: true }); } catch { /* ignore */ } }
}

const exhaustedEvents = (e, id) => e.db.listEvents(id).filter((ev) => ev.kind === "manager_context_exhausted");

// ============================ (1) DETECTED — a busy MANAGER hits the terminal marker ============================
{
  const e = makeEnv();
  const m = seedSession(e, "mgr-exh", { role: "manager" });
  writeExhaustionFixture(e, m.cwd, m.engineSessionId);

  e.watcher.tick(NOW);

  check("(1) pty.markContextExhausted was called for the manager", e.markedExhausted.includes("mgr-exh"));
  const row = e.db.getSession("mgr-exh");
  check("(1) the manager's DB row busy is now false", row.busy === false);
  check("(1) the manager's DB row contextExhaustedAt is now set", typeof row.contextExhaustedAt === "string" && row.contextExhaustedAt.length > 0);
  check("(1) the manager's lastError names the exhaustion", /context exhausted/i.test(row.lastError ?? ""));

  const events = exhaustedEvents(e, "mgr-exh");
  check("(1) exactly ONE manager_context_exhausted event, filed under the session itself (no parent)", events.length === 1 && events[0].managerSessionId === "mgr-exh" && (events[0].workerSessionId == null));
  check("(1) the event's detail.error carries the record's own 'invalid_request' code", events[0].detail?.error === "invalid_request");

  check("(1) NO queued nudge — there's no owning parent to push into; the human-attention surface is lastError + the event", e.enqueued.length === 0);

  check("(1) classify() routes manager_context_exhausted to the SAME \"context-overflow\" class as its context_escalated/context_blind_turn siblings",
    classify("manager_context_exhausted", events[0]?.detail) === "context-overflow");

  // ===== dedupe: a SECOND tick must NOT re-fire (busy already false → skipped by the exhaustion check's
  // own !m.busy guard before it even re-reads the transcript). =====
  e.watcher.tick(NOW);
  check("(2) a second tick does NOT re-mark", e.markedExhausted.filter((id) => id === "mgr-exh").length === 1);
  check("(2) a second tick does NOT append a second event", exhaustedEvents(e, "mgr-exh").length === 1);

  cleanup(e);
}

// ============================ (3) NOT DETECTED — ordinary busy manager, no marker ============================
{
  const e = makeEnv();
  const m = seedSession(e, "mgr-ok", { role: "manager" });
  const file = engineTranscriptPath(m.cwd, m.engineSessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ type: "assistant", message: { model: "claude-sonnet-5", role: "assistant", content: [{ type: "text", text: "Working." }] } })}\n`);
  e.transcriptFiles.push(file);

  e.watcher.tick(NOW);

  check("(3) an ordinary busy manager with no terminal marker is NOT marked exhausted", !e.markedExhausted.includes("mgr-ok"));
  check("(3) its busy flag is untouched (still true — ordinary ctx-nudge logic owns it, not this detector)", e.db.getSession("mgr-ok").busy === true);
  check("(3) its contextExhaustedAt stays null", e.db.getSession("mgr-ok").contextExhaustedAt === null);

  cleanup(e);
}

// ============================ (4) DETECTED — a busy PLATFORM-LEAD session hits the terminal marker ============================
{
  const e = makeEnv();
  const lead = seedSession(e, "lead-exh", { role: "platform" });
  writeExhaustionFixture(e, lead.cwd, lead.engineSessionId);

  e.watcher.tick(NOW);

  check("(4) pty.markContextExhausted was called for the platform lead", e.markedExhausted.includes("lead-exh"));
  const row = e.db.getSession("lead-exh");
  check("(4) the lead's DB row busy is now false", row.busy === false);
  check("(4) the lead's DB row contextExhaustedAt is now set", typeof row.contextExhaustedAt === "string");
  const events = exhaustedEvents(e, "lead-exh");
  check("(4) exactly ONE manager_context_exhausted event, filed under the lead's own id", events.length === 1 && events[0].managerSessionId === "lead-exh");

  cleanup(e);
}

// ============================ (5) IDLE — a non-busy manager is never scanned at all ============================
{
  const e = makeEnv();
  const m = seedSession(e, "mgr-idle", { role: "manager" });
  e.db.setBusy("mgr-idle", false); // idle: not this watchdog's concern
  writeExhaustionFixture(e, m.cwd, m.engineSessionId); // a marker exists, but the manager isn't busy

  e.watcher.tick(NOW);

  check("(5) an idle manager is never marked exhausted, even with a matching fixture on disk", !e.markedExhausted.includes("mgr-idle"));
  check("(5) its contextExhaustedAt stays null", e.db.getSession("mgr-idle").contextExhaustedAt === null);

  cleanup(e);
}

// ============================ (6) ROUND 2 (CR finding, reviewer 6ba057e4): an ALREADY-exhausted
// manager must skip the recycle-ratio nudge, the unanswered-cap escalation, AND the emergency
// interrupt on every LATER tick — not just the tick that marked it. checkContextExhaustion's own
// `!m.busy` guard reads false once busy is already cleared by a PRIOR mark, so without
// isAlreadyContextExhausted's separate check the caller fell through into all three below with a
// now-stale ctxInputTokens reading (none of which can ever reach an engine that will never produce
// another Stop). Seeded at ctxInputTokens=190000 (95% of the default 200k window, model:null) — well
// above BOTH the ordinary ratio threshold (0.80) and the emergency floor (0.90) by construction, so
// an ordinary (non-exhausted) manager at this reading would trip every one of the three signals. ====
{
  const emergencyCalls = [];
  const e = makeEnv();
  // A separate watcher instance (same db/pty) WITH an emergencyInterrupt hook wired, so the emergency
  // path (otherwise a silent no-op without one — see checkEmergencyOccupancy's own doc) is actually
  // exercised, not merely vacuously absent.
  const watcherWithEmergency = new ContextWatcher({
    db: e.db, pty: e.pty, ratio: 0,
    emergencyInterrupt: (sessionId, text) => { emergencyCalls.push({ sessionId, text }); return { fired: true, delivered: true, interrupting: false }; },
  });

  const m = seedSession(e, "mgr-exh-stale", { role: "manager" });
  e.db.setContextCounters("mgr-exh-stale", { ctxInputTokens: 190000, ctxTurns: 5, model: null });
  writeExhaustionFixture(e, m.cwd, m.engineSessionId);

  // Tick 1: the MARKING tick — exhaustion is detected and marked (same as test (1) above).
  watcherWithEmergency.tick(NOW);
  check("(6) setup: tick 1 marks the manager exhausted", e.markedExhausted.includes("mgr-exh-stale"));
  check("(6) setup: busy is now false (the marking tick's own falling edge)", e.db.getSession("mgr-exh-stale").busy === false);
  check("(6) setup: no recycle-ratio nudge, escalation, or emergency interrupt on the MARKING tick itself",
    e.enqueued.length === 0 && e.db.getLatestEventForManagerByKind("mgr-exh-stale", "context_escalated") === undefined && emergencyCalls.length === 0);

  // Tick 2 (and 3, for good measure): LATER ticks — busy is already false, so checkContextExhaustion's
  // own guard returns false (not re-marking), and WITHOUT this round-2 fix the caller would fall
  // through into the ordinary ratio/escalation/emergency logic below using the stale ctxInputTokens.
  watcherWithEmergency.tick(NOW);
  watcherWithEmergency.tick(NOW);

  check("(6) STILL no recycle-ratio nudge queued on any later tick (the manager's queue is held, not drained into anyway — but the nudge must not even be ATTEMPTED)",
    e.enqueued.length === 0);
  check("(6) STILL no context_escalated event (the unanswered-cap escalation never evaluated this manager)",
    e.db.getLatestEventForManagerByKind("mgr-exh-stale", "context_escalated") === undefined);
  check("(6) STILL no emergency interrupt fired, despite ctxInputTokens sitting well above the emergency floor",
    emergencyCalls.length === 0);
  check("(6) the contextExhaustedAt mark itself is untouched across the later ticks (still the same stamp, not re-derived)",
    typeof e.db.getSession("mgr-exh-stale").contextExhaustedAt === "string");

  // Negative control on THIS SAME fixture shape: an OTHERWISE-IDENTICAL manager that was NEVER
  // exhausted DOES trip the ordinary ratio nudge at this exact ctxInputTokens reading — proving the
  // skip above is specific to the exhaustion mark, not a side effect of the ratio/env setup itself.
  const control = seedSession(e, "mgr-control-trips", { role: "manager" });
  e.db.setContextCounters("mgr-control-trips", { ctxInputTokens: 190000, ctxTurns: 5, model: null });
  watcherWithEmergency.tick(NOW);
  check("(6) NEGATIVE CONTROL: an un-exhausted manager at the IDENTICAL reading DOES get the ordinary ratio nudge (proves the skip above isn't vacuous)",
    e.enqueued.some((x) => x.id === "mgr-control-trips"));
  check("(6) NEGATIVE CONTROL: that SAME manager ALSO gets the emergency interrupt at this reading",
    emergencyCalls.some((x) => x.sessionId === "mgr-control-trips"));

  cleanup(e);
}

// ============================ (7) card 5f825506 item 1 — a STALE marker (timestamped BEFORE the
// current turn's own busySinceMs cutoff) is NOT re-marked. Reproduces the race: the DB/in-memory mark
// was already cleared by a rising edge, but the transcript on disk still ends in the OLD terminal
// record because the CLI hasn't yet written a superseding one. ============================
{
  const e = makeEnv();
  const m = seedSession(e, "mgr-stale-ignored", { role: "manager" });
  const staleTs = "2026-11-02T20:50:00.000Z"; // well before NOW (21:00:00) and before the cutoff below
  writeExhaustionFixture(e, m.cwd, m.engineSessionId, exhaustionRecordAt(staleTs));
  // The current turn started AFTER the stale record's own timestamp.
  e.busySinceMsById.set("mgr-stale-ignored", Date.parse("2026-11-02T20:55:00.000Z"));

  e.watcher.tick(NOW);

  check("(7) a stale pre-turn marker is NOT re-marked exhausted", !e.markedExhausted.includes("mgr-stale-ignored"));
  check("(7) busy stays true (never cleared)", e.db.getSession("mgr-stale-ignored").busy === true);
  check("(7) contextExhaustedAt stays null", e.db.getSession("mgr-stale-ignored").contextExhaustedAt === null);
  check("(7) no manager_context_exhausted event is filed", exhaustedEvents(e, "mgr-stale-ignored").length === 0);

  cleanup(e);
}

// ============================ (8) POSITIVE CONTROL for (7) — a marker timestamped INSIDE the current
// turn (AFTER busySinceMs) is still detected and marked, proving (7) isn't vacuously rejecting every
// marker once a cutoff is supplied. ============================
{
  const e = makeEnv();
  const m = seedSession(e, "mgr-current-turn", { role: "manager" });
  const currentTs = "2026-11-02T20:59:00.000Z"; // after the cutoff below, inside the current turn
  writeExhaustionFixture(e, m.cwd, m.engineSessionId, exhaustionRecordAt(currentTs));
  e.busySinceMsById.set("mgr-current-turn", Date.parse("2026-11-02T20:55:00.000Z"));

  e.watcher.tick(NOW);

  check("(8) a genuinely current-turn marker IS still marked exhausted despite a cutoff being supplied",
    e.markedExhausted.includes("mgr-current-turn"));
  check("(8) busy is now false", e.db.getSession("mgr-current-turn").busy === false);
  check("(8) exactly ONE manager_context_exhausted event is filed", exhaustedEvents(e, "mgr-current-turn").length === 1);

  cleanup(e);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — ContextWatcher detects the terminal context-exhaustion marker for a busy manager AND a busy platform-Lead (tick-based, never a hook), marks it (busy cleared, contextExhaustedAt+lastError stamped), files ONE manager_context_exhausted event under the session's own id (no owning parent to notify), never queues a nudge, never re-fires on a later tick, leaves an ordinary busy manager's detection untouched, skips an idle manager outright, and the new event kind routes through companion/attention-push.ts's classify() into the SAME \"context-overflow\" class its context_escalated/context_blind_turn siblings already use — no new push channel. Round 2: an ALREADY-exhausted manager (busy already false from a prior mark) skips the recycle-ratio nudge, the context_escalated escalation, AND the emergency interrupt on every later tick despite a stale ctxInputTokens reading sitting well above both thresholds — proven against a negative control at the IDENTICAL reading that DOES trip all of it when never exhausted. Card 5f825506: a marker timestamped BEFORE the supplied busySinceMs cutoff is NOT re-marked (7), proven non-vacuous against a positive control where an IDENTICAL setup with the marker inside the current turn still marks exhausted (8)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
