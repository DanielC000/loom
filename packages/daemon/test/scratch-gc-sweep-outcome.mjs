import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 1a686bad — the boot scratch-GC sweep's own OUTCOME, made observable on `served_status`.
//
// THE DEFECT THIS CLOSES: `reconcileRunsOnBoot` used to fire `sweepUnresumableScratchDirs` as a bare
// `void ….catch(...)` and discard the returned `ScratchGcResult`. A sweep that scanned N dirs and reaped 0
// was byte-identical, on every observable surface, to one that threw on its first statement and was
// swallowed by that `.catch`, or to one that never ran at all — a reader of `scratchRootOverCeiling:true`
// had no way to tell "GC working, nothing qualifies" from "GC broken". `runBootScratchGcSweep` +
// `getBootScratchGcSweepOutcome` (scratch-gc.ts) fix this by recording a four-state outcome
// (not-started / in-progress / completed / failed) that `buildServedStatus` now surfaces as
// `scratchGcSweep`.
//
// HERMETIC, NO claude, NO real spawn/merge — same shape as scratch-gc-boot-sweep.mjs: a real Db (temp
// LOOM_HOME) + injected `transcriptIds`/`codexTranscriptExists`/`removeDir` seams, never a real
// `~/.claude/projects` or `~/.codex/sessions` scan.
//
// Proves:
//   1. a fresh module import (before any boot sweep) reports "not-started";
//   2. calling runBootScratchGcSweep synchronously records "in-progress" BEFORE the async sweep settles —
//      never a fabricated completed/zero while genuinely still running;
//   3. a sweep that reaps N dirs settles to "completed" with reaped === N;
//   4. a sweep that reaps 0 dirs settles to "completed" with reaped === 0 — and is DISTINGUISHABLE (a
//      different `state`) from a sweep that threw;
//   5. a sweep whose predicate throws settles to "failed" with the error message, never silently
//      swallowed into looking like a clean empty sweep;
//   6. `buildServedStatus` (served-status.ts) surfaces whatever `getBootScratchGcSweepOutcome()` currently
//      holds, beside `scratchRootBytes`/`scratchRootOverCeiling`.
//
// Run: 1) build (turbo builds shared first), 2) node test/scratch-gc-sweep-outcome.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-scgc-outcome-${Date.now()}-${process.pid}`);
fs.mkdirSync(tmpHome, { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const {
  runBootScratchGcSweep,
  getBootScratchGcSweepOutcome,
  __resetScratchGcSweepOutcomeForTest,
} = await import("../dist/sessions/scratch-gc.js");
const { SCRATCH_ROOT_DIR } = await import("../dist/paths.js");
const { buildServedStatus } = await import("../dist/served-status.js");

fs.mkdirSync(SCRATCH_ROOT_DIR, { recursive: true });

const db = new Db();
const now = new Date().toISOString();
db.insertProject({ id: "proj1", name: "P", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: "agent1", projectId: "proj1", name: "A", startupPrompt: "", position: 0 });

const DAY_MS = 24 * 60 * 60 * 1000;
const nowMs = Date.now();
const oldIso = new Date(nowMs - 8 * DAY_MS).toISOString(); // past the 7-day grace

function mkScratchDir(id) {
  const dir = path.join(SCRATCH_ROOT_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "spill.json"), "{}");
  return dir;
}

function insertSessionRow({ id, engineSessionId, processState, lastActivity, harness }) {
  db.insertSession({
    id, projectId: "proj1", agentId: "agent1", engineSessionId: engineSessionId ?? null, title: null,
    cwd: tmpHome, processState, resumability: "resumable", busy: false,
    createdAt: lastActivity, lastActivity, lastError: null, role: "worker", parentSessionId: null,
    harness,
  });
}

// Poll for the sweep to leave its transient states — this is a POSITIVE wait for an observable event
// (the outcome record settling to "completed"/"failed"), never a fixed sleep guarding a negative
// assertion (see CLAUDE.md's fixed-wait-witness-guard note): the bound below is a failure timeout, not
// the thing being asserted.
async function waitForSettle(timeoutMs = 5000) {
  const start = performance.now();
  for (;;) {
    const outcome = getBootScratchGcSweepOutcome();
    if (outcome.state === "completed" || outcome.state === "failed") return outcome;
    if (performance.now() - start > timeoutMs) throw new Error(`timed out waiting for sweep to settle (still "${outcome.state}")`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ============================== 1. fresh module state is "not-started" ==============================
{
  __resetScratchGcSweepOutcomeForTest();
  const outcome = getBootScratchGcSweepOutcome();
  check('1 a freshly-reset outcome record reports state "not-started"', outcome.state === "not-started");
}

// ============================== 2. "in-progress" is recorded SYNCHRONOUSLY, before the sweep settles ==============================
{
  __resetScratchGcSweepOutcomeForTest();
  let releaseRemoveDir;
  const heldRemoveDir = () => new Promise((resolve) => { releaseRemoveDir = () => resolve({ removed: true, killed: false }); });

  const id = randomUUID();
  const engineId = randomUUID();
  mkScratchDir(id);
  insertSessionRow({ id, engineSessionId: engineId, processState: "exited", lastActivity: oldIso });

  runBootScratchGcSweep(db, { transcriptIds: new Set(), nowMs, removeDir: heldRemoveDir });
  const midFlight = getBootScratchGcSweepOutcome();
  check('2 immediately after the (synchronous, fire-and-forget) call, state is "in-progress" — never a fabricated completed/zero while genuinely still running', midFlight.state === "in-progress");
  check("2 the in-progress record carries a startedAt timestamp", midFlight.state === "in-progress" && typeof midFlight.startedAt === "string" && midFlight.startedAt.length > 0);

  releaseRemoveDir();
  const settled = await waitForSettle();
  check('2 it later settles to "completed" once the held removal resolves', settled.state === "completed");
  fs.rmSync(path.join(SCRATCH_ROOT_DIR, id), { recursive: true, force: true });
}

// ============================== 3. a sweep that reaps N dirs settles "completed" with reaped === N ==============================
{
  __resetScratchGcSweepOutcomeForTest();
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  for (const id of ids) {
    const engineId = randomUUID();
    mkScratchDir(id);
    insertSessionRow({ id, engineSessionId: engineId, processState: "exited", lastActivity: oldIso });
  }

  runBootScratchGcSweep(db, { transcriptIds: new Set(), nowMs });
  const outcome = await waitForSettle();
  check('3 settles to state "completed"', outcome.state === "completed");
  check(`3 reaped === ${ids.length} (all ${ids.length} candidates were genuinely removed from disk)`, outcome.state === "completed" && outcome.reaped === ids.length);
  check(`3 scanned === ${ids.length}`, outcome.state === "completed" && outcome.scanned === ids.length);
  check("3 wedged === 0", outcome.state === "completed" && outcome.wedged === 0);
  check("3 carries startedAt and completedAt timestamps", outcome.state === "completed" && typeof outcome.startedAt === "string" && typeof outcome.completedAt === "string");
  for (const id of ids) check(`3 ${id} actually removed from disk`, !fs.existsSync(path.join(SCRATCH_ROOT_DIR, id)));
}

// ============================== 4. a sweep that reaps 0 is "completed" (reaped:0), DISTINCT from a threw sweep ==============================
{
  __resetScratchGcSweepOutcomeForTest();
  // No candidates at all (empty scratch root beyond whatever the earlier cases already cleaned up) —
  // scanned:0, reaped:0, the legitimate "nothing qualified" case.
  runBootScratchGcSweep(db, { transcriptIds: new Set(), nowMs });
  const emptyOutcome = await waitForSettle();
  check('4 an empty sweep settles to state "completed" (not "failed")', emptyOutcome.state === "completed");
  check("4 reaped === 0 for the empty sweep", emptyOutcome.state === "completed" && emptyOutcome.reaped === 0);

  // Now force a genuine throw: a "codex" row whose injected codexTranscriptExists seam throws mid-scan —
  // sweepUnresumableScratchDirs's own scan loop is NOT wrapped in a try/catch, so this propagates and
  // rejects the promise runBootScratchGcSweep awaits.
  __resetScratchGcSweepOutcomeForTest();
  const deadId = randomUUID();
  const engineId = randomUUID();
  mkScratchDir(deadId);
  insertSessionRow({ id: deadId, engineSessionId: engineId, processState: "exited", lastActivity: oldIso, harness: "codex" });
  const codexTranscriptExists = () => { throw new Error("injected predicate failure (card 1a686bad negative case)"); };

  runBootScratchGcSweep(db, { transcriptIds: new Set(), nowMs, codexTranscriptExists });
  const threwOutcome = await waitForSettle();
  check('4 a sweep whose predicate throws settles to state "failed" — NEVER swallowed into looking like a clean empty sweep', threwOutcome.state === "failed");
  check("4 the failed record carries the real error message", threwOutcome.state === "failed" && threwOutcome.error.includes("injected predicate failure"));
  check(
    '4 "reaped 0" and "threw" are DISTINGUISHABLE states (different `state` values, not the same shape with different numbers)',
    emptyOutcome.state !== threwOutcome.state,
  );
  fs.rmSync(path.join(SCRATCH_ROOT_DIR, deadId), { recursive: true, force: true });
}

// ============================== 5. buildServedStatus surfaces whatever the outcome record currently holds ==============================
{
  __resetScratchGcSweepOutcomeForTest();
  const notStartedStatus = buildServedStatus(db);
  check('5 served_status.scratchGcSweep reflects "not-started" before any boot sweep has run', notStartedStatus.scratchGcSweep.state === "not-started");
  check("5 served_status still carries scratchRootBytes/scratchRootOverCeiling alongside it (unchanged, additive)", typeof notStartedStatus.scratchRootBytes === "number" && typeof notStartedStatus.scratchRootOverCeiling === "boolean");

  const id = randomUUID();
  const engineId = randomUUID();
  mkScratchDir(id);
  insertSessionRow({ id, engineSessionId: engineId, processState: "exited", lastActivity: oldIso });
  runBootScratchGcSweep(db, { transcriptIds: new Set(), nowMs });
  await waitForSettle();

  const completedStatus = buildServedStatus(db);
  check('5 after a real sweep settles, served_status.scratchGcSweep reflects state "completed"', completedStatus.scratchGcSweep.state === "completed");
  check("5 with the same reaped count the sweep itself reported", completedStatus.scratchGcSweep.state === "completed" && completedStatus.scratchGcSweep.reaped === 1);
}

db.close();
fs.rmSync(tmpHome, { recursive: true, force: true });

console.log(failures === 0
  ? "\n✅ ALL PASS — the boot scratch-GC sweep's own outcome is recorded as a four-state record (not-started/in-progress/completed/failed), stays honestly \"in-progress\" while the async sweep is genuinely still running, distinguishes a 0-reap sweep from one whose predicate threw, and is surfaced end-to-end on buildServedStatus's scratchGcSweep field."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
