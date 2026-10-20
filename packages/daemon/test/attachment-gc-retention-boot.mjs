import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 6f27469b Code Review (items 3 + 4) — the BOOT-WRAPPER layer `attachment-gc.mjs` doesn't cover:
// `runBootAttachmentGcSweep`'s own outcome recording + per-refusal logging, the `attachmentRetentionMsFromDays`
// days->ms conversion, and the REAL `SessionService.reconcileRunsOnBoot()` wiring that resolves
// `attachmentRetentionDays` and threads it through. Mirrors scratch-gc-sweep-outcome.mjs's own shape
// (outcome state machine) and run-snapshot-remove-bound.mjs's own shape (a bare SessionService + stub
// PtyHost driving reconcileRunsOnBoot directly, no live claude).
//
// THE DEFECT THIS CLOSES (item 4): before this fix, `reconcileRunsOnBoot` inlined
// `attachmentRetentionDays * 24 * 60 * 60 * 1000` at the call site with NO test covering the conversion
// or the boot wiring at all — a dropped `*60` (hours instead of days) would have reaped 30-day-old
// attachments after ~12h with every OTHER test in this card still green. Section 6 below drives the REAL
// boot path end-to-end and was shown to fail under a deliberately-reintroduced hours-not-days bug before
// passing against the fix (see the worker's own report for the before/after run).
//
// Proves:
//   1. a fresh module import reports "not-started".
//   2. runBootAttachmentGcSweep records "in-progress" synchronously, before the async sweep settles.
//   3. a sweep with a mix of reaped/refused/alreadyGone settles "completed" with the right counts, logs
//      one console.warn PER refusal naming its id+reason, and one console.log summary line.
//   4. a sweep whose own promise rejects (never a per-item failure) settles "failed" with the error
//      message — distinguishable from "completed".
//   5. attachmentRetentionMsFromDays converts whole days to milliseconds correctly for several values.
//   6. the REAL reconcileRunsOnBoot(), with `attachmentRetentionDays` configured via PlatformConfig,
//      correctly reaps a just-OUTSIDE-the-window candidate and spares a just-INSIDE one — the end-to-end
//      regression test for the conversion + boot wiring together.
//
// Run: 1) build (turbo builds shared first), 2) node test/attachment-gc-retention-boot.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-attgcb-${Date.now()}-${process.pid}`);
fs.mkdirSync(tmpHome, { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const {
  runBootAttachmentGcSweep, getBootAttachmentGcSweepOutcome, __resetAttachmentGcSweepOutcomeForTest,
  attachmentRetentionMsFromDays,
} = await import("../dist/mcp/attachment-gc.js");
const { ATTACHMENTS_DIR, questionAttachmentDir } = await import("../dist/paths.js");

fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });

const warned = [];
const logged = [];
const origWarn = console.warn;
const origLog = console.log;
console.warn = (...a) => { warned.push(a.join(" ")); };
console.log = (...a) => { const line = a.join(" "); logged.push(line); if (!line.startsWith("[attachment-gc]")) origLog(...a); };

const db = new Db();
const now = new Date().toISOString();
db.insertProject({ id: "proj1", name: "P", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: "agent1", projectId: "proj1", name: "A", startupPrompt: "", position: 0 });
db.insertSession({
  id: "mgr1", projectId: "proj1", agentId: "agent1", engineSessionId: null, title: null, cwd: tmpHome,
  processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: "manager",
});

const DAY_MS = 24 * 60 * 60 * 1000;
const nowMs = Date.now();

function mkAttachmentStore(id) {
  const dir = questionAttachmentDir(id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "0-note.txt"), "hello\n");
  return [{ id: "0", label: "note.txt", kind: "other", sizeBytes: 6, imageDimensions: null, storedFilename: "0-note.txt", originalPath: "/src/note.txt", openedAt: null }];
}
function baseQuestion(id, overrides) {
  return {
    id, sessionId: "mgr1", filedBySessionId: "mgr1", projectId: "proj1", type: "decision",
    title: "T", body: "B", options: null, recommendation: null, taskId: null,
    permissionAction: null, permissionScopeHint: null, permissionExpiresAt: null,
    decidedScope: null, decidedExpiresAt: null, credentialEnvVar: null, credentialByteLength: null,
    provisionTarget: null, fulfillmentTarget: null, provisionConnectionId: null, provisionBindingState: "none",
    chosenOption: null, note: null,
    createdAt: overrides.createdAt ?? now, answeredAt: null, consumedAt: overrides.consumedAt ?? null,
    cancelledReason: null, cancelledBy: null, cancelledAt: null,
    escalatedAt: null, acknowledgedUntil: null, readAt: null,
    attachments: [], state: "consumed",
  };
}
function mkCandidate(id, consumedAtIso) {
  const stored = mkAttachmentStore(id);
  db.insertQuestion(baseQuestion(id, { consumedAt: consumedAtIso }), stored);
  return questionAttachmentDir(id);
}

// Positive wait for an observable event (the outcome settling), never a fixed sleep guarding a negative
// assertion — see CLAUDE.md's fixed-wait-witness-guard note.
async function waitForSettle(timeoutMs = 5000) {
  const start = performance.now();
  for (;;) {
    const outcome = getBootAttachmentGcSweepOutcome();
    if (outcome.state === "completed" || outcome.state === "failed") return outcome;
    if (performance.now() - start > timeoutMs) throw new Error(`timed out waiting for sweep to settle (still "${outcome.state}")`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

// Positive wait for another observable event: `release` being armed (set) by the held removeDir seam
// once the sweep's async scan loop actually reaches it. Isolated in its own function, same shape as
// waitForSettle above, so the raw wait idiom is never adjacent to a check() call at any call site.
async function waitForArmed(isArmed, timeoutMs = 5000) {
  const start = performance.now();
  for (;;) {
    if (isArmed()) return;
    if (performance.now() - start > timeoutMs) throw new Error("timed out waiting for the held removeDir to be invoked");
    await new Promise((r) => setTimeout(r, 2));
  }
}

// ============================== 1. fresh module state is "not-started" ==============================
{
  __resetAttachmentGcSweepOutcomeForTest();
  check('1 a freshly-reset outcome record reports state "not-started"', getBootAttachmentGcSweepOutcome().state === "not-started");
}

// ============================== 2. "in-progress" is recorded SYNCHRONOUSLY, before the sweep settles ==============================
{
  __resetAttachmentGcSweepOutcomeForTest();
  let release;
  const heldRemoveDir = () => new Promise((resolve) => { release = () => resolve({ removed: true, killed: false }); });
  const id = randomUUID();
  const dir = mkCandidate(id, new Date(nowMs - 10 * DAY_MS).toISOString());

  runBootAttachmentGcSweep(db, 7 * DAY_MS, { nowMs, removeDir: heldRemoveDir });
  const midFlight = getBootAttachmentGcSweepOutcome();
  check('2 immediately after the (synchronous, fire-and-forget) call, state is "in-progress"', midFlight.state === "in-progress");
  check("2 carries a startedAt timestamp", midFlight.state === "in-progress" && typeof midFlight.startedAt === "string" && midFlight.startedAt.length > 0);

  // Unlike scratch-gc's own candidate scan (fully synchronous, no per-item I/O), this sweep's scan loop
  // awaits a real `fsp.lstat` per candidate BEFORE it ever reaches `removeDir` — so `release` is armed one
  // microtask tier later, not synchronously. waitForArmed is a POSITIVE wait for that observable event.
  await waitForArmed(() => typeof release === "function");
  release();
  const settled = await waitForSettle();
  check('2 later settles to "completed" once the held removal resolves', settled.state === "completed");
  fs.rmSync(dir, { recursive: true, force: true });
}

// ============================== 3. a mixed sweep settles "completed" with correct counts + per-refusal logging ==============================
{
  __resetAttachmentGcSweepOutcomeForTest();
  warned.length = 0; logged.length = 0;

  const reapedId = randomUUID();
  const reapedDir = mkCandidate(reapedId, new Date(nowMs - 10 * DAY_MS).toISOString());

  const refusedId = randomUUID();
  mkCandidate(refusedId, new Date(nowMs - 10 * DAY_MS).toISOString());
  const refusedDir = questionAttachmentDir(refusedId);
  fs.rmSync(refusedDir, { recursive: true, force: true });
  let junctionOk = false;
  try { fs.symlinkSync(tmpHome, refusedDir, process.platform === "win32" ? "junction" : "dir"); junctionOk = true; } catch { /* no link privilege */ }

  const alreadyGoneId = randomUUID();
  mkCandidate(alreadyGoneId, new Date(nowMs - 10 * DAY_MS).toISOString());
  fs.rmSync(questionAttachmentDir(alreadyGoneId), { recursive: true, force: true }); // never existed by sweep time

  runBootAttachmentGcSweep(db, 7 * DAY_MS, { nowMs });
  const outcome = await waitForSettle();

  check('3 settles to state "completed"', outcome.state === "completed");
  check("3 reaped === 1", outcome.state === "completed" && outcome.reaped === 1);
  // >= 1, not === 1: section 2's own candidate (DB row never mutated by design, see the decision record's
  // "do not mutate" rule) is ALSO still eligible and ALSO already-gone-from-disk by this point, so it
  // contributes to this same count — accumulation across sections sharing one db is expected, not a bug.
  check("3 alreadyGone >= 1 (this sweep's own alreadyGoneId, at minimum)", outcome.state === "completed" && outcome.alreadyGone >= 1);
  check("3 the reaped dir is actually gone from disk", !fs.existsSync(reapedDir));
  if (junctionOk) {
    check("3 refused === 1 (the planted junction)", outcome.state === "completed" && outcome.refused === 1);
    check("3 exactly one refusal warn fires, naming the refused id and its reason",
      warned.filter((w) => w.includes(refusedId) && w.includes("symlink/junction")).length === 1);
    fs.unlinkSync(refusedDir);
  } else {
    console.log("SKIP  (3) junction case — could not create a junction/symlink on this host");
  }
  check("3 a summary log line fires naming scanned/reaped/refused/wedged/alreadyGone",
    logged.some((l) => l.startsWith("[attachment-gc] boot sweep: scanned") && l.includes("reaped") && l.includes("refused") && l.includes("wedged") && l.includes("alreadyGone")));
}

// ============================== 4. a sweep whose OWN promise rejects settles "failed", distinct from "completed" ==============================
{
  __resetAttachmentGcSweepOutcomeForTest();
  // NaN retentionMs -> cutoff computation is new Date(NaN).toISOString(), which throws RangeError
  // ("Invalid time value") BEFORE any per-item try/catch in sweepExpiredAttachments ever runs — this is a
  // genuine whole-sweep failure, never a per-item one (those are always caught and reported as refused/wedged).
  runBootAttachmentGcSweep(db, NaN, { nowMs });
  const threwOutcome = await waitForSettle();
  check('4 a sweep whose own promise rejects settles to state "failed"', threwOutcome.state === "failed");
  check("4 the failed record carries a real error message", threwOutcome.state === "failed" && typeof threwOutcome.error === "string" && threwOutcome.error.length > 0);

  __resetAttachmentGcSweepOutcomeForTest();
  runBootAttachmentGcSweep(db, 7 * DAY_MS, { nowMs }); // no candidates left eligible at this exact window -> clean empty sweep
  const emptyOutcome = await waitForSettle();
  check('4 "failed" and a legitimate empty "completed" sweep are DISTINGUISHABLE states', emptyOutcome.state !== threwOutcome.state);
}

// ============================== 5. attachmentRetentionMsFromDays converts correctly ==============================
{
  check("5 1 day -> 86400000ms", attachmentRetentionMsFromDays(1) === 86_400_000);
  check("5 7 days -> 604800000ms", attachmentRetentionMsFromDays(7) === 604_800_000);
  check("5 30 days -> 2592000000ms (NOT 30*60*60*1000 = 108000000, the hours-not-days bug shape)",
    attachmentRetentionMsFromDays(30) === 2_592_000_000 && attachmentRetentionMsFromDays(30) !== 30 * 60 * 60 * 1000);
}

// ============================== 6. the REAL reconcileRunsOnBoot(), end-to-end, with a configured retention ==============================
{
  __resetAttachmentGcSweepOutcomeForTest();
  db.setPlatformConfig({ attachmentRetentionDays: 7 });

  const insideId = randomUUID(); // consumed 6 days ago -> inside the 7-day window -> must survive
  const insideDir = mkCandidate(insideId, new Date(nowMs - 6 * DAY_MS).toISOString());
  const outsideId = randomUUID(); // consumed 8 days ago -> outside the 7-day window -> must be reaped
  const outsideDir = mkCandidate(outsideId, new Date(nowMs - 8 * DAY_MS).toISOString());

  const host = new PtyHost({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} });
  const svc = new SessionService(db, host, new OrchestrationControl());
  const result = svc.reconcileRunsOnBoot();
  check("6 reconcileRunsOnBoot returns synchronously (fire-and-forgets the GC sweep)", result && typeof result === "object" && typeof result.then !== "function");

  const outcome = await waitForSettle();
  check('6 the real boot path settles to "completed"', outcome.state === "completed");
  check("6 a request consumed 6 days ago (inside the configured 7-day window) SURVIVES", fs.existsSync(insideDir));
  check("6 a request consumed 8 days ago (outside the configured 7-day window) IS REAPED", !fs.existsSync(outsideDir));
  check("6 exactly one of the two candidates was reaped this sweep", outcome.state === "completed" && outcome.reaped === 1);
}

console.warn = origWarn;
console.log = origLog;
db.close();
fs.rmSync(tmpHome, { recursive: true, force: true });

console.log(failures === 0
  ? "\n✅ ALL PASS — runBootAttachmentGcSweep records a four-state outcome (not-started/in-progress/completed/failed), logs every refusal individually plus one summary line per sweep, distinguishes a whole-sweep failure from a legitimate empty completion, attachmentRetentionMsFromDays converts whole days to milliseconds correctly (not hours), and the REAL reconcileRunsOnBoot() end-to-end correctly resolves a configured attachmentRetentionDays and reaps/spares exactly the right side of the resulting window."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
