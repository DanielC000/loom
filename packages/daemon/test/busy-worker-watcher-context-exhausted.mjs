import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 66ff7321 (part C of 8c7dfc65) — BusyWorkerWatcher's CONTEXT-EXHAUSTION detection, the sibling
// of busy-worker-watcher.mjs's own long-turn advisory test (kept in a SEPARATE file deliberately — a
// distinct detection mechanism with its own fixture shape, not a growth of that file).
//
// Drives the REAL BusyWorkerWatcher.tick() + a RECORDING pty/db stub pair, same shape as
// busy-worker-watcher.mjs, PLUS a transcript fixture file written at the exact path
// resolveTranscriptFile/engineTranscriptPath resolve to (never a hand-constructed path), under a
// sandboxed home (see the @decision anchor below) carrying the real terminal record's shape.
//
// Run: 1) build (turbo builds shared first), 2) node packages/daemon/test/busy-worker-watcher-context-exhausted.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdtempManaged } from "./_tmp-fixture.mjs";

// @decision 668bc52c — sandbox HOME/USERPROFILE to a managed temp dir BEFORE importing dist; never
// write a transcript fixture under the real os.homedir(), and never import dist after the sandbox is
// set but let a module-load-time os.homedir() read slip in before it.
const sandboxHome = mkdtempManaged("loom-busy-ctxexh-home-");
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME
// @decision a92a0913 — also delete an ambient CLAUDE_CONFIG_DIR: claudeConfigHome() reads it ahead of
// os.homedir(), so an inherited value would bypass the HOME/USERPROFILE override above entirely.
delete process.env.CLAUDE_CONFIG_DIR;

const { Db } = await import("../dist/db.js");
const { BusyWorkerWatcher } = await import("../dist/orchestration/busy-worker-watcher.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Round 2: tryReadLastCommitSummary is now ASYNC (execFile, not execFileSync — see that function's
// own doc) and the notice's enqueueStdin call now happens inside its `.then()`, so a notice no longer
// lands synchronously within tick()'s own call frame. Poll for it instead of asserting immediately.
async function waitForCondition(fn, { timeoutMs = 3000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return fn();
}

const NOW = new Date("2026-11-02T21:00:00.000Z");
const RUN_SUFFIX = `${Date.now()}-${process.pid}`;

const REAL_EXHAUSTION_RECORD = {
  type: "assistant",
  message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text: "Prompt is too long" }] },
  error: "invalid_request", isApiErrorMessage: true,
};

// card 5f825506 (item 1) — the SAME shape, but carrying an explicit `timestamp` so a test can place it
// relative to a `busySinceMs` cutoff. REAL_EXHAUSTION_RECORD above stays untouched (no timestamp) so
// every pre-existing test here keeps implicitly exercising the "no timestamp ⇒ never rejected" path.
const exhaustionRecordAt = (isoTimestamp) => ({ ...REAL_EXHAUSTION_RECORD, timestamp: isoTimestamp });

function makeEnv() {
  const dbFile = path.join(os.tmpdir(), `loom-busy-ctxexh-${RUN_SUFFIX}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Db(dbFile);
  const projId = `cxp-${RUN_SUFFIX}`;
  const agentId = `cxa-${RUN_SUFFIX}`;
  const now = NOW.toISOString();
  db.insertProject({ id: projId, name: "CtxExh", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });
  const alive = new Set();
  const enqueued = [];
  const markedExhausted = [];
  // card 5f825506 (item 1) — per-session turn-start stamp, settable per test; defaults to `null` (no
  // cutoff) for every test that doesn't set one, which must stay byte-identical to the pre-card behaviour.
  const busySinceMsById = new Map();
  const pty = {
    isAlive: (id) => alive.has(id),
    enqueueStdin: (id, text) => { enqueued.push({ id, text }); return { delivered: true }; },
    // Mirrors the REAL PtyHost.markContextExhausted end-to-end: it internally calls setBusy(false),
    // which (via events.onBusy -> SessionService.handleBusyEdge) persists db.setBusy(false) — this stub
    // reproduces that same observable DB effect so the test exercises the real downstream contract
    // (busy actually clears) rather than merely recording that the call happened.
    markContextExhausted: (id) => {
      markedExhausted.push(id);
      if (!alive.has(id)) return false;
      db.setBusy(id, false);
      return true;
    },
    busySinceMs: (id) => busySinceMsById.get(id) ?? null,
  };
  const control = new OrchestrationControl();
  const watcher = new BusyWorkerWatcher({ db, pty, control });
  const transcriptFiles = [];
  return { dbFile, db, projId, agentId, alive, enqueued, markedExhausted, busySinceMsById, control, watcher, transcriptFiles };
}

function seedManager(e, id) {
  e.db.insertSession({
    id, projectId: e.projId, agentId: e.agentId, engineSessionId: "eng-" + id, title: null, cwd: e.projId,
    processState: "live", resumability: "resumable", busy: false,
    createdAt: NOW.toISOString(), lastActivity: NOW.toISOString(), lastError: null, role: "manager",
    ctxInputTokens: null, ctxTurns: null, model: null,
  });
  e.alive.add(id);
}

// cwd is unique PER WORKER (RUN_SUFFIX + id) so each worker's transcript resolves to its own
// real-homedir fixture dir — never shared, never colliding across cases in this same run.
function seedWorker(e, id, parentId, { harness } = {}) {
  const cwd = `${e.projId}-${id}`;
  const engineSessionId = `eng-${RUN_SUFFIX}-${id}`;
  e.db.insertSession({
    id, projectId: e.projId, agentId: e.agentId, engineSessionId, title: null, cwd,
    processState: "live", resumability: "resumable", busy: true,
    createdAt: NOW.toISOString(), lastActivity: NOW.toISOString(), lastError: null, role: "worker",
    parentSessionId: parentId, taskId: "tk-" + id, harness,
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

const exhaustedEvents = (e, workerId) => e.db.listEventsForWorker(workerId).filter((ev) => ev.kind === "worker_context_exhausted");

// ============================ (1) DETECTED — busy worker hits the terminal marker ============================
{
  const e = makeEnv();
  seedManager(e, "mgr-1");
  const w = seedWorker(e, "wkr-exh", "mgr-1");
  writeExhaustionFixture(e, w.cwd, w.engineSessionId);

  e.watcher.tick(NOW);

  check("(1) pty.markContextExhausted was called for the worker", e.markedExhausted.includes("wkr-exh"));
  const row = e.db.getSession("wkr-exh");
  check("(1) the worker's DB row busy is now false", row.busy === false);
  check("(1) the worker's DB row contextExhaustedAt is now set", typeof row.contextExhaustedAt === "string" && row.contextExhaustedAt.length > 0);
  check("(1) the worker's lastError names the exhaustion", /context exhausted/i.test(row.lastError ?? ""));

  const events = exhaustedEvents(e, "wkr-exh");
  check("(1) exactly ONE worker_context_exhausted event, filed under the owning manager", events.length === 1 && events[0].managerSessionId === "mgr-1" && events[0].workerSessionId === "wkr-exh" && events[0].taskId === "tk-wkr-exh");
  check("(1) the event's detail.error carries the record's own 'invalid_request' code", events[0].detail?.error === "invalid_request");

  // Round 2: the durable event above is synchronous (proven already); the NOTICE's own enqueueStdin
  // now fires async, inside tryReadLastCommitSummary's `.then()` — wait for it rather than asserting
  // immediately (would read enqueued.length === 0 the instant tick() returns, a false failure, not a
  // true one, caused by the async conversion rather than a real regression).
  await waitForCondition(() => e.enqueued.length > 0);
  check("(1) exactly ONE notice enqueued to the MANAGER", e.enqueued.length === 1 && e.enqueued[0].id === "mgr-1");
  const text = e.enqueued[0]?.text ?? "";
  check("(1) the notice is tagged [loom:worker-context-exhausted]", text.startsWith("[loom:worker-context-exhausted]"));
  check("(1) the notice names the worker + the matched terminal text", text.includes("wkr-exh".slice(0, 8)) && text.includes("Prompt is too long"));
  check("(1) the notice names worker_recycle as the recovery, and that it keeps the worktree/branch", /worker_recycle/.test(text) && /worktree\/branch/i.test(text));
  check("(1) the notice says the queue is HELD, not drained", /HELD/.test(text));
  // e.cwd here is a fake short string, not a real git repo — tryReadLastCommitSummary must fail
  // gracefully (best-effort) and simply omit the "last commit" clause, never throw.
  check("(1) a non-repo cwd gracefully omits the last-commit clause (never throws)", !/last commit/i.test(text));

  // ===== dedupe: a SECOND tick must NOT re-fire — busy is already false, so the top `!w.busy continue`
  // guard skips this worker entirely before the exhaustion check is even reached again. =====
  e.watcher.tick(NOW);
  check("(2) a second tick does NOT re-mark (already busy:false, skipped at the top of the loop)", e.markedExhausted.filter((id) => id === "wkr-exh").length === 1);
  check("(2) a second tick does NOT append a second event", exhaustedEvents(e, "wkr-exh").length === 1);
  check("(2) a second tick does NOT enqueue a second notice", e.enqueued.length === 1);

  cleanup(e);
}

// ============================ (3) NOT DETECTED — ordinary busy worker, no marker in its transcript ============================
{
  const e = makeEnv();
  seedManager(e, "mgr-3");
  const w = seedWorker(e, "wkr-ok", "mgr-3");
  const file = engineTranscriptPath(w.cwd, w.engineSessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ type: "assistant", message: { model: "claude-sonnet-5", role: "assistant", content: [{ type: "text", text: "Working on it." }] } })}\n`);
  e.transcriptFiles.push(file);

  e.watcher.tick(NOW);

  check("(3) an ordinary busy worker with no terminal marker is NOT marked exhausted", !e.markedExhausted.includes("wkr-ok"));
  check("(3) no worker_context_exhausted event", exhaustedEvents(e, "wkr-ok").length === 0);
  const row = e.db.getSession("wkr-ok");
  check("(3) its busy flag is untouched by this detector (still true — the ordinary busy-long path owns it)", row.busy === true);
  check("(3) its contextExhaustedAt stays null", row.contextExhaustedAt === null);

  cleanup(e);
}

// ============================ (4) SKIPPED — codex-harness worker, even with a matching claude-path fixture ============================
{
  const e = makeEnv();
  seedManager(e, "mgr-4");
  const w = seedWorker(e, "wkr-codex", "mgr-4", { harness: "codex" });
  // Write the exhaustion fixture at the CLAUDE-encoded path for this same cwd/engineId — proves the
  // codex guard is a real skip, not merely "no file existed at the codex path anyway".
  writeExhaustionFixture(e, w.cwd, w.engineSessionId);

  e.watcher.tick(NOW);

  check("(4) a codex-harness worker is never marked exhausted, even with a matching claude-path fixture", !e.markedExhausted.includes("wkr-codex"));
  check("(4) no worker_context_exhausted event for the codex worker", exhaustedEvents(e, "wkr-codex").length === 0);

  cleanup(e);
}

// ============================ (5) ORPHAN — no live manager: the worker is still marked exhausted, but
// neither the event nor the notice fires — mirrors the ordinary busy-long path's OWN liveness gate. ============================
{
  const e = makeEnv();
  // No manager seeded at all — parentSessionId points at nothing live.
  const w = seedWorker(e, "wkr-orphan-exh", "mgr-missing");
  writeExhaustionFixture(e, w.cwd, w.engineSessionId);

  e.watcher.tick(NOW);

  check("(5) the worker is still marked exhausted even with no live manager to notify", e.markedExhausted.includes("wkr-orphan-exh"));
  const row = e.db.getSession("wkr-orphan-exh");
  check("(5) its DB row is still stamped contextExhaustedAt (a fact about the worker, not about who's listening)", typeof row.contextExhaustedAt === "string");
  check("(5) its busy flag is still cleared", row.busy === false);
  check("(5) no worker_context_exhausted event (mirrors the ordinary busy-long path's own manager-liveness gate)", exhaustedEvents(e, "wkr-orphan-exh").length === 0);
  check("(5) no notice is enqueued (nobody to send it to)", e.enqueued.length === 0);
  cleanup(e);
}

// ============================ (6) ROUND 2 (CR finding #7): tick() must NEVER block the event loop on
// the last-commit git read, however long that read takes. A fast-failing nonexistent cwd (every case
// above) can't discriminate sync vs async here — git itself fails near-instantly on a bad path either
// way, so a bare before/after timing check on tick() alone would pass for BOTH the pre-fix execFileSync
// and the post-fix execFile (measured: it did). This test PATH-shadows `git` with a script that sleeps
// a real, known duration before failing, so a SYNCHRONOUS git read would force tick() itself to take at
// least that long — only an async one can let tick() return immediately while the read is still
// in flight. ============================
{
  const slowGitDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-busy-ctxexh-slowgit-"));
  const SLOW_GIT_DELAY_MS = 400;
  const isWin = process.platform === "win32";
  const slowGitScript = isWin
    ? `@echo off\r\nnode -e "setTimeout(()=>process.exit(1),${SLOW_GIT_DELAY_MS})"\r\n`
    : `#!/bin/sh\nnode -e 'setTimeout(()=>process.exit(1),${SLOW_GIT_DELAY_MS})'\n`;
  const slowGitPath = path.join(slowGitDir, isWin ? "git.cmd" : "git");
  fs.writeFileSync(slowGitPath, slowGitScript);
  if (!isWin) fs.chmodSync(slowGitPath, 0o755);

  const originalPathKey = Object.keys(process.env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  const originalPath = process.env[originalPathKey];
  try {
    const e = makeEnv();
    seedManager(e, "mgr-6");
    const w = seedWorker(e, "wkr-slowgit", "mgr-6");
    writeExhaustionFixture(e, w.cwd, w.engineSessionId);

    // Prepend the slow fake `git` so execFile's PATH lookup finds it BEFORE the real one. execFile
    // captures process.env at spawn time (synchronous, inside tick()'s own call frame), so restoring
    // PATH right after tick() returns is safe — the already-spawned child keeps its own captured env.
    process.env[originalPathKey] = `${slowGitDir}${path.delimiter}${originalPath}`;
    const tickStart = Date.now();
    e.watcher.tick(NOW);
    const tickElapsedMs = Date.now() - tickStart;
    process.env[originalPathKey] = originalPath;

    check(`(6) tick() returned well BEFORE the fake git's own ${SLOW_GIT_DELAY_MS}ms delay (took ${tickElapsedMs}ms) — proves it did not block on the subprocess`,
      tickElapsedMs < SLOW_GIT_DELAY_MS / 2);
    check("(6) the notice has NOT landed yet right after tick() returns (the slow read is still in flight)", e.enqueued.length === 0);

    await waitForCondition(() => e.enqueued.length > 0, { timeoutMs: SLOW_GIT_DELAY_MS * 4 });
    check("(6) the notice DOES eventually land once the slow async read settles", e.enqueued.length === 1 && e.enqueued[0].id === "mgr-6");
    check("(6) the notice omits the last-commit clause (the fake git exited non-zero — the SAME never-throw contract as a real failure)",
      !/last commit/i.test(e.enqueued[0]?.text ?? ""));

    cleanup(e);
  } finally {
    process.env[originalPathKey] = originalPath;
    try { fs.rmSync(slowGitDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

// ============================ (7) card 5f825506 item 1 — a STALE marker (timestamped BEFORE the
// current turn's own busySinceMs cutoff) is NOT re-marked for a WORKER either — same race as the
// manager/platform path, same fix. ============================
{
  const e = makeEnv();
  seedManager(e, "mgr-7");
  const w = seedWorker(e, "wkr-stale-ignored", "mgr-7");
  const staleTs = "2026-11-02T20:50:00.000Z"; // well before NOW (21:00:00) and before the cutoff below
  writeExhaustionFixture(e, w.cwd, w.engineSessionId, exhaustionRecordAt(staleTs));
  e.busySinceMsById.set("wkr-stale-ignored", Date.parse("2026-11-02T20:55:00.000Z"));

  e.watcher.tick(NOW);

  check("(7) a stale pre-turn marker is NOT re-marked exhausted for a worker", !e.markedExhausted.includes("wkr-stale-ignored"));
  check("(7) the worker's busy stays true (never cleared)", e.db.getSession("wkr-stale-ignored").busy === true);
  check("(7) contextExhaustedAt stays null", e.db.getSession("wkr-stale-ignored").contextExhaustedAt === null);
  check("(7) no worker_context_exhausted event is filed", exhaustedEvents(e, "wkr-stale-ignored").length === 0);
  check("(7) no notice is enqueued", e.enqueued.length === 0);

  cleanup(e);
}

// ============================ (8) POSITIVE CONTROL for (7) — a marker timestamped INSIDE the current
// turn (AFTER busySinceMs) is still detected and marked for a worker, proving (7) isn't vacuous. ====
{
  const e = makeEnv();
  seedManager(e, "mgr-8");
  const w = seedWorker(e, "wkr-current-turn", "mgr-8");
  const currentTs = "2026-11-02T20:59:00.000Z"; // after the cutoff below, inside the current turn
  writeExhaustionFixture(e, w.cwd, w.engineSessionId, exhaustionRecordAt(currentTs));
  e.busySinceMsById.set("wkr-current-turn", Date.parse("2026-11-02T20:55:00.000Z"));

  e.watcher.tick(NOW);

  check("(8) a genuinely current-turn marker IS still marked exhausted for a worker despite a cutoff being supplied",
    e.markedExhausted.includes("wkr-current-turn"));
  check("(8) the worker's busy is now false", e.db.getSession("wkr-current-turn").busy === false);
  check("(8) exactly ONE worker_context_exhausted event is filed", exhaustedEvents(e, "wkr-current-turn").length === 1);

  cleanup(e);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — BusyWorkerWatcher detects the terminal context-exhaustion marker in a busy worker's transcript (tick-based, never a hook), marks it (busy cleared, contextExhaustedAt+lastError stamped), files ONE worker_context_exhausted event + ONE [loom:worker-context-exhausted] notice naming worker_recycle, never re-fires on a later tick, leaves an ordinary busy worker's detection untouched, skips a codex-harness worker even against a matching claude-path fixture, and still marks (without crashing on the missing notify target) a worker whose manager isn't live. Round 2: a PATH-shadowed slow fake git proves tick() returns well before the subprocess settles (never blocking the event loop) and that the notice still lands correctly once the async read completes. Card 5f825506: a marker timestamped BEFORE the supplied busySinceMs cutoff is NOT re-marked for a worker either (7), proven non-vacuous against a positive control where an IDENTICAL setup with the marker inside the current turn still marks exhausted (8)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
