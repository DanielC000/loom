import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// ContextWatcher WORKER CONTEXT WARN/INTERRUPT test (card dacc6d9e, part B of epic 8c7dfc65, Triggers
// C/D) — the worker-scoped twins of the manager's ordinary ratio nudge (Trigger C, informational-only,
// pushed to the OWNING MANAGER) and the emergency interrupt (Trigger D, Esc-interrupts the worker
// itself). NO claude, NO SessionService — the watcher takes injected `pty`/`workerContextInterrupt`
// callbacks (exactly like the manager's own emergencyInterrupt stub in context-watcher-emergency.mjs),
// so these tests drive tick() directly against RECORDING STUBS. Hermetic: each env gets its OWN temp .db.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdtempManaged } from "./_tmp-fixture.mjs";

// @decision 668bc52c — sandbox HOME/USERPROFILE to a managed temp dir BEFORE importing dist; never
// write a transcript fixture under the real os.homedir(), and never import dist after the sandbox is
// set but let a module-load-time os.homedir() read slip in before it.
const sandboxHome = mkdtempManaged("loom-ctxw-wratio-home-");
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME
// @decision a92a0913 — also delete an ambient CLAUDE_CONFIG_DIR: claudeConfigHome() reads it ahead of
// os.homedir(), so an inherited value would bypass the HOME/USERPROFILE override above entirely.
delete process.env.CLAUDE_CONFIG_DIR;

const { Db } = await import("../dist/db.js");
const { ContextWatcher } = await import("../dist/orchestration/context-watcher.js");
const { BusyWorkerWatcher } = await import("../dist/orchestration/busy-worker-watcher.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Round 2 (busy-worker-watcher-context-exhausted.mjs's own helper, reused here for scenario 19 below):
// the notice's own enqueueStdin call happens inside tryReadLastCommitSummary's async `.then()`, so it
// never lands synchronously within tick()'s own call frame — poll for it rather than asserting immediately.
async function waitForCondition(fn, { timeoutMs = 3000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return fn();
}

function makeEnv({ projectConfig, workerContextInterruptImpl } = {}) {
  const dbFile = path.join(os.tmpdir(), `loom-ctx-wratio-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Db(dbFile);
  const projId = `wp-${Math.random().toString(36).slice(2, 8)}`;
  const agentId = `wa-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  db.insertProject({ id: projId, name: "WorkerCtxRatios", repoPath: projId, vaultPath: projId, config: projectConfig ?? {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });
  const alive = new Set();
  const enqueued = [];
  const interrupts = [];
  const pty = {
    isAlive: (id) => alive.has(id),
    enqueueStdin: (id, text) => { enqueued.push({ id, text }); return { delivered: false, queued: true }; },
  };
  const deps = { db, pty, ratio: 0 }; // ratio 0 = no env force override; manager-side ratio logic is not this file's concern
  if (workerContextInterruptImpl !== null) { // pass null to test the "hook omitted entirely" case
    deps.workerContextInterrupt = workerContextInterruptImpl ?? ((id, text) => {
      interrupts.push({ id, text });
      return { fired: true, delivered: false, interrupting: true }; // simulates: worker was busy, Esc sent
    });
  }
  const watcher = new ContextWatcher(deps);
  return { dbFile, db, projId, agentId, alive, enqueued, interrupts, watcher, pty };
}

function seedManager(e, id, { live = true } = {}) {
  const now = new Date().toISOString();
  e.db.insertSession({
    id, projectId: e.projId, agentId: e.agentId, engineSessionId: "eng-" + id, title: null, cwd: e.projId,
    processState: live ? "live" : "exited", resumability: "resumable", busy: false,
    createdAt: now, lastActivity: now, lastError: null, role: "manager",
    ctxInputTokens: null, ctxTurns: null, model: null,
  });
  if (live) e.alive.add(id);
}

// `ctxUpdatedAt` (card dacc6d9e, CR round 2): Trigger D refuses unless the reading's OWN timestamp is
// strictly later than `lastActivity` (the stale-reading/recovery-turn rule — see
// ContextWatcher.checkWorkerContextInterrupt's own doc). Every PRE-EXISTING fixture in this file seeds a
// ctx reading with no opinion about its timestamp at all, so the default here stamps a FAR-FUTURE
// `ctxUpdatedAt` (+1h past `lastActivity`) whenever `ctx` is set — safely "fresher than lastActivity" even
// across a later same-test `setBusy(true)` call (test 9's idle→busy transition), which only ever bumps
// `lastActivity` by a few real milliseconds, never a full hour. Pass an explicit `ctxUpdatedAt` (including
// `null`) to override — the new stale/recovery-turn tests below do exactly that, seeding one BEFORE
// `lastActivity` on purpose. `contextExhaustedAt`, when given, stamps the row via `setContextExhausted`
// straight after insert (mirrors every other exhaustion-seeding test in this suite).
function seedWorker(e, id, parentId, { busy = true, ctx, model = "claude-opus-4-8", live = true, harness, rateLimitedUntil = null, ctxUpdatedAt, contextExhaustedAt = null } = {}) {
  const now = new Date().toISOString();
  const resolvedCtxUpdatedAt = ctxUpdatedAt !== undefined ? ctxUpdatedAt : (ctx != null ? new Date(Date.parse(now) + 3_600_000).toISOString() : null);
  e.db.insertSession({
    id, projectId: e.projId, agentId: e.agentId, engineSessionId: "eng-" + id, title: null, cwd: e.projId,
    processState: live ? "live" : "exited", resumability: "resumable", busy,
    createdAt: now, lastActivity: now, lastError: null, role: "worker",
    parentSessionId: parentId, taskId: "tk-" + id,
    ctxInputTokens: ctx, ctxTurns: ctx != null ? 1 : null, ctxUpdatedAt: resolvedCtxUpdatedAt, model, harness: harness ?? null,
    rateLimitedUntil,
  });
  if (live) e.alive.add(id);
  if (contextExhaustedAt) e.db.setContextExhausted(id, contextExhaustedAt, "Context exhausted — test stamp.");
}

function cleanup(e) {
  try { e.db.close(); } catch { /* ignore */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(e.dbFile + ext, { force: true }); } catch { /* ignore */ } }
}

const warnEvents = (e, id) => e.db.listEventsForWorker(id).filter((ev) => ev.kind === "worker_context_high");
const interruptEvents = (e, id) => e.db.listEventsForWorker(id).filter((ev) => ev.kind === "worker_context_interrupt");

// A 1M-window model (claude-opus-4-8). 650_000/1M = 65% — over the 0.60 warn floor, under the 0.85
// interrupt floor. 900_000/1M = 90% — over both.
const WARN_ONLY_CTX = 650_000;
const OVER_BOTH_CTX = 900_000;
const UNDER_WARN_CTX = 500_000; // 50%

// ============================ TRIGGER C: WORKER CONTEXT WARN ============================

// (1) Fires once, pushed to the OWNING MANAGER (not the worker), correct prefix + content.
{
  const e = makeEnv({ projectConfig: { orchestration: { workerContextWarnRatio: 0.60, workerContextInterruptRatio: 0 } } });
  seedManager(e, "mgr-1");
  seedWorker(e, "wkr-1", "mgr-1", { busy: true, ctx: WARN_ONLY_CTX });
  e.watcher.tick();
  check("(1) worker over warn floor → exactly one worker_context_high event, filed under the owning manager", warnEvents(e, "wkr-1").length === 1 && warnEvents(e, "wkr-1")[0].managerSessionId === "mgr-1" && warnEvents(e, "wkr-1")[0].workerSessionId === "wkr-1");
  check("(1) event carries pct ~65", warnEvents(e, "wkr-1")[0]?.detail?.pct === 65);
  const msg = e.enqueued.find((m) => m.id === "mgr-1");
  check("(1) notice enqueued to the MANAGER with the [loom:worker-context-high] prefix, naming the worker", !!msg && msg.text.startsWith("[loom:worker-context-high]") && msg.text.includes("wkr-1".slice(0, 8)));
  check("(1) notice mentions worker_recycle and that auto-compact is off", /worker_recycle/.test(msg.text) && /auto-compact is OFF/.test(msg.text));
  check("(1) warn fires even though the worker is BUSY (unlike the interrupt, warn has no busy gate)", true); // documents the busy:true fixture choice
  cleanup(e);
}

// (2) Does NOT fire under the floor.
{
  const e = makeEnv({ projectConfig: { orchestration: { workerContextWarnRatio: 0.60 } } });
  seedManager(e, "mgr-2");
  seedWorker(e, "wkr-2", "mgr-2", { ctx: UNDER_WARN_CTX });
  e.watcher.tick();
  check("(2) under the warn floor (50% < 60%) → no worker_context_high event", warnEvents(e, "wkr-2").length === 0);
  check("(2) no manager notice either", e.enqueued.length === 0);
  cleanup(e);
}

// (3) Disabled per-project (workerContextWarnRatio:0): no event even when clearly over.
{
  const e = makeEnv({ projectConfig: { orchestration: { workerContextWarnRatio: 0 } } });
  seedManager(e, "mgr-3");
  seedWorker(e, "wkr-3", "mgr-3", { ctx: OVER_BOTH_CTX });
  e.watcher.tick();
  check("(3) workerContextWarnRatio:0 disables the warn notice", warnEvents(e, "wkr-3").length === 0);
  cleanup(e);
}

// (4) DEDUPE: sustained high ctx across many ticks fires exactly once ever — this is the "once per
// crossing" guarantee, resting on the stated premise that ctxInputTokens only grows while a session is
// live (auto-compact owner-disabled), so there is only ever ONE crossing to notice in practice.
{
  const e = makeEnv({ projectConfig: { orchestration: { workerContextWarnRatio: 0.60, workerContextInterruptRatio: 0 } } });
  seedManager(e, "mgr-4");
  seedWorker(e, "wkr-4", "mgr-4", { ctx: WARN_ONLY_CTX });
  for (let i = 0; i < 5; i++) e.watcher.tick();
  check("(4) dedupe: five ticks on sustained high ctx → exactly one worker_context_high event", warnEvents(e, "wkr-4").length === 1);
  check("(4) dedupe: exactly one manager notice, not five", e.enqueued.filter((m) => m.id === "mgr-4").length === 1);
  cleanup(e);
}

// (5) Re-arms via worker_recycle (a fresh session id is a different crossing).
{
  const e = makeEnv({ projectConfig: { orchestration: { workerContextWarnRatio: 0.60, workerContextInterruptRatio: 0 } } });
  seedManager(e, "mgr-5");
  seedWorker(e, "wkr-5-old", "mgr-5", { ctx: WARN_ONLY_CTX });
  e.watcher.tick();
  check("(5) setup: the OLD worker session fires once", warnEvents(e, "wkr-5-old").length === 1);
  seedWorker(e, "wkr-5-new", "mgr-5", { ctx: WARN_ONLY_CTX }); // simulates the recycled successor
  e.watcher.tick();
  check("(5) a DIFFERENT (recycled) worker session id fires its own first notice", warnEvents(e, "wkr-5-new").length === 1);
  check("(5) the old session's own count is untouched", warnEvents(e, "wkr-5-old").length === 1);
  cleanup(e);
}

// (6) Orphaned worker (owning manager missing/not-live): no notice — nothing to surface to.
{
  const e = makeEnv({ projectConfig: { orchestration: { workerContextWarnRatio: 0.60 } } });
  seedWorker(e, "wkr-6", "no-such-manager", { ctx: WARN_ONLY_CTX });
  e.watcher.tick();
  check("(6) no owning manager row at all → no warn notice", warnEvents(e, "wkr-6").length === 0);
  cleanup(e);
}
{
  const e = makeEnv({ projectConfig: { orchestration: { workerContextWarnRatio: 0.60 } } });
  seedManager(e, "mgr-6b", { live: false });
  seedWorker(e, "wkr-6b", "mgr-6b", { ctx: WARN_ONLY_CTX });
  e.watcher.tick();
  check("(6b) owning manager exists but is not live → no warn notice", warnEvents(e, "wkr-6b").length === 0);
  cleanup(e);
}

// (7) codex worker: no ctx telemetry at all, so the whole worker loop skips it before even reading cfg.
{
  const e = makeEnv({ projectConfig: { orchestration: { workerContextWarnRatio: 0.60 } } });
  seedManager(e, "mgr-7");
  seedWorker(e, "wkr-7", "mgr-7", { ctx: OVER_BOTH_CTX, harness: "codex" });
  e.watcher.tick();
  check("(7) codex worker (no ctx telemetry) → never checked, no warn notice", warnEvents(e, "wkr-7").length === 0);
  cleanup(e);
}

// ============================ TRIGGER D: WORKER CONTEXT INTERRUPT ============================

// (8) Fires once while BUSY, over the interrupt floor; manager is notified directly (correction 3).
{
  const e = makeEnv({ projectConfig: { orchestration: { workerContextInterruptRatio: 0.85, workerContextWarnRatio: 0 } } });
  seedManager(e, "mgr-8");
  seedWorker(e, "wkr-8", "mgr-8", { busy: true, ctx: OVER_BOTH_CTX });
  e.watcher.tick();
  check("(8) busy worker over interrupt floor → exactly one worker_context_interrupt event", interruptEvents(e, "wkr-8").length === 1);
  const ev = interruptEvents(e, "wkr-8")[0];
  check("(8) event carries pct/delivered/interrupting (honest EnqueueResult shape)", ev.detail.pct === 90 && ev.detail.delivered === false && ev.detail.interrupting === true);
  check("(8) the daemon-internal hook was called exactly once, with the WORKER's own id", e.interrupts.length === 1 && e.interrupts[0].id === "wkr-8");
  check("(8) the worker-facing text names the pct, auto-compact being off, and the commit/report/stop instruction",
    /~90%/.test(e.interrupts[0].text) && /auto-compact is OFF/.test(e.interrupts[0].text) && /NEW commit \(never amend\)/.test(e.interrupts[0].text) && /STOP and wait for your manager/.test(e.interrupts[0].text));
  check("(8) the mid-edit\\/mid-tool-call caveat is preserved", /mid-edit or mid-tool-call/.test(e.interrupts[0].text));
  const notice = e.enqueued.find((m) => m.id === "mgr-8");
  check("(8) correction 3: the OWNING MANAGER gets a [loom:worker-context-interrupt] notice directly", !!notice && notice.text.startsWith("[loom:worker-context-interrupt]") && notice.text.includes("wkr-8".slice(0, 8)));
  check("(8) the manager notice tells it to recycle once the worker reports", /recycle it once it reports/i.test(notice.text));
  check("(8) exactly ONE manager notice (not duplicated)", e.enqueued.filter((m) => m.id === "mgr-8").length === 1);
  cleanup(e);
}

// (9) NOT fired for an IDLE worker above the floor (correction 1) — and fires once it goes busy.
{
  const e = makeEnv({ projectConfig: { orchestration: { workerContextInterruptRatio: 0.85 } } });
  seedManager(e, "mgr-9");
  seedWorker(e, "wkr-9", "mgr-9", { busy: false, ctx: OVER_BOTH_CTX }); // idle, e.g. awaitingReview
  e.watcher.tick();
  check("(9) idle worker over the floor → NO interrupt (no event, no hook call)", interruptEvents(e, "wkr-9").length === 0 && e.interrupts.length === 0);
  check("(9) a refusal for not-busy records no event, so a later tick can still fire", true);

  e.db.setBusy("wkr-9", true); // the worker later takes a turn
  e.watcher.tick();
  check("(9) once the worker goes busy (still over the floor), the interrupt fires", interruptEvents(e, "wkr-9").length === 1 && e.interrupts.length === 1);
  cleanup(e);
}

// (10) NOT fired while parked on a rate limit (rateLimitedUntil in the future) — fires once it clears.
{
  const e = makeEnv({ projectConfig: { orchestration: { workerContextInterruptRatio: 0.85 } } });
  seedManager(e, "mgr-10");
  const future = new Date(Date.now() + 60 * 60_000).toISOString();
  seedWorker(e, "wkr-10", "mgr-10", { busy: true, ctx: OVER_BOTH_CTX, rateLimitedUntil: future });
  e.watcher.tick();
  check("(10) rate-limited worker (future rateLimitedUntil) → NO interrupt", interruptEvents(e, "wkr-10").length === 0 && e.interrupts.length === 0);

  e.db.clearRateLimit("wkr-10"); // the real rate-limit-recovery path's own clear
  e.watcher.tick();
  check("(10) once the rate limit clears (still over the floor, still busy), the interrupt fires", interruptEvents(e, "wkr-10").length === 1);
  cleanup(e);
}

// (11) Disabled per-project (workerContextInterruptRatio:0): no event even when clearly over.
{
  const e = makeEnv({ projectConfig: { orchestration: { workerContextInterruptRatio: 0 } } });
  seedManager(e, "mgr-11");
  seedWorker(e, "wkr-11", "mgr-11", { busy: true, ctx: OVER_BOTH_CTX });
  e.watcher.tick();
  check("(11) workerContextInterruptRatio:0 disables the interrupt", interruptEvents(e, "wkr-11").length === 0 && e.interrupts.length === 0);
  cleanup(e);
}

// (12) No hook wired at all: safe, permanent no-op — never throws, never records a phantom event.
{
  const e = makeEnv({ projectConfig: { orchestration: { workerContextInterruptRatio: 0.85 } }, workerContextInterruptImpl: null });
  seedManager(e, "mgr-12");
  seedWorker(e, "wkr-12", "mgr-12", { busy: true, ctx: OVER_BOTH_CTX });
  let threw = false;
  try { e.watcher.tick(); } catch { threw = true; }
  check("(12) no workerContextInterrupt hook wired → tick() never throws", !threw);
  check("(12) no workerContextInterrupt hook wired → no event recorded", interruptEvents(e, "wkr-12").length === 0);
  cleanup(e);
}

// (13) Not alive (db says live but the pty is gone): skip — nothing to interrupt.
{
  const e = makeEnv({ projectConfig: { orchestration: { workerContextInterruptRatio: 0.85 } } });
  seedManager(e, "mgr-13");
  seedWorker(e, "wkr-13", "mgr-13", { busy: true, ctx: OVER_BOTH_CTX });
  e.alive.delete("wkr-13");
  e.watcher.tick();
  check("(13) not-alive worker never trips the interrupt", interruptEvents(e, "wkr-13").length === 0);
  cleanup(e);
}

// (14) DEDUPE: sustained high ctx + busy across many ticks fires exactly once ever — the SAME round-4
// fix the manager's emergency interrupt uses (no per-turn re-arm key), proven here as the required
// negative control: an un-deduped implementation would fire on every one of these five ticks.
{
  const e = makeEnv({ projectConfig: { orchestration: { workerContextInterruptRatio: 0.85, workerContextWarnRatio: 0 } } });
  seedManager(e, "mgr-14");
  seedWorker(e, "wkr-14", "mgr-14", { busy: true, ctx: OVER_BOTH_CTX });
  for (let i = 0; i < 5; i++) e.watcher.tick();
  check("(14) dedupe: five ticks, sustained busy+over-floor → exactly one event", interruptEvents(e, "wkr-14").length === 1);
  check("(14) dedupe: exactly one hook call, not five", e.interrupts.length === 1);
  check("(14) dedupe: exactly one manager notice, not five", e.enqueued.filter((m) => m.id === "mgr-14").length === 1);
  cleanup(e);
}

// (15) REFUSAL (e.g. gate-in-flight): a fired:false outcome records NO event, so the very next tick
// retries — exactly the documented policy (never poll inside one tick; refuse and let the next cadence
// retry). The real refusal reason this models is SessionService.redirectWorkerForContextInterrupt's own
// hasLiveGateForSession check (see redirect-worker-context-interrupt.mjs for the end-to-end proof against
// a REAL GateSemaphore) — this file only proves ContextWatcher's own handling of a fired:false outcome.
{
  const e = makeEnv({
    projectConfig: { orchestration: { workerContextInterruptRatio: 0.85 } },
    workerContextInterruptImpl: (() => {
      let calls = 0;
      return (id, text) => {
        calls++;
        if (calls === 1) return { fired: false, reason: "gate-in-flight" };
        return { fired: true, delivered: true, interrupting: false };
      };
    })(),
  });
  seedManager(e, "mgr-15");
  seedWorker(e, "wkr-15", "mgr-15", { busy: true, ctx: OVER_BOTH_CTX });
  e.watcher.tick();
  check("(15) a refused (fired:false, gate-in-flight) attempt records NO event", interruptEvents(e, "wkr-15").length === 0);
  e.watcher.tick();
  check("(15) the very next tick retries and, once it fires, records exactly one event", interruptEvents(e, "wkr-15").length === 1);
  cleanup(e);
}

// (16) CR round 2, finding 1: an ALREADY-EXHAUSTED worker (contextExhaustedAt already stamped, same as a
// manager/platform row would be) fires NEITHER trigger — both Trigger C and Trigger D must skip BEFORE
// ever reading `ctxInputTokens`, exactly like the manager/platform loops' own exhaustion skip. Busy:true +
// well over BOTH floors is deliberate — proves the skip wins even against a reading that would otherwise
// trip both triggers immediately.
{
  const e = makeEnv({ projectConfig: { orchestration: { workerContextWarnRatio: 0.60, workerContextInterruptRatio: 0.85 } } });
  seedManager(e, "mgr-16");
  const exhaustedAt = new Date().toISOString();
  seedWorker(e, "wkr-16", "mgr-16", { busy: true, ctx: OVER_BOTH_CTX, contextExhaustedAt: exhaustedAt });
  e.watcher.tick();
  check("(16) exhausted worker: NO worker_context_high event (Trigger C skipped)", warnEvents(e, "wkr-16").length === 0);
  check("(16) exhausted worker: NO worker_context_interrupt event (Trigger D skipped)", interruptEvents(e, "wkr-16").length === 0);
  check("(16) exhausted worker: the daemon-internal interrupt hook was never called", e.interrupts.length === 0);
  check("(16) exhausted worker: the manager was never pushed a notice for either trigger", e.enqueued.filter((m) => m.id === "mgr-16").length === 0);
  // Sustained across ticks too — the skip holds for as long as the mark stands (mirrors the manager's
  // own `isAlreadyContextExhausted` round-2 fix), not just the first tick.
  e.watcher.tick(); e.watcher.tick();
  check("(16) the skip holds across later ticks too — still neither trigger", warnEvents(e, "wkr-16").length === 0 && interruptEvents(e, "wkr-16").length === 0);
  cleanup(e);
}

// (17) CR round 2, finding 1 (recovery-turn sub-finding): a busy rising edge (e.g. a human composer
// /compact) clears `contextExhaustedAt` but never touches `ctxInputTokens`/`ctxUpdatedAt` — so a RECOVERY
// turn can be busy, carry NO exhaustion flag, and still hold a STALE reading from BEFORE this turn
// started, still over the interrupt floor. Trigger D must NOT fire on that stale reading — only a FRESH
// in-turn sample (ctxUpdatedAt strictly later than lastActivity) may trigger it. workerContextWarnRatio:0
// isolates this to Trigger D alone (Trigger C's own dedupe/staleness posture isn't this test's concern).
{
  const e = makeEnv({ projectConfig: { orchestration: { workerContextInterruptRatio: 0.85, workerContextWarnRatio: 0 } } });
  seedManager(e, "mgr-17");
  const lastActivity = new Date().toISOString();
  const staleCtxUpdatedAt = new Date(Date.parse(lastActivity) - 60_000).toISOString(); // measured a minute BEFORE this turn started
  e.db.insertSession({
    id: "wkr-17", projectId: e.projId, agentId: e.agentId, engineSessionId: "eng-wkr-17", title: null, cwd: e.projId,
    processState: "live", resumability: "resumable", busy: true,
    createdAt: lastActivity, lastActivity, lastError: null, role: "worker",
    parentSessionId: "mgr-17", taskId: "tk-wkr-17",
    ctxInputTokens: OVER_BOTH_CTX, ctxTurns: 1, ctxUpdatedAt: staleCtxUpdatedAt, model: "claude-opus-4-8", harness: null,
  });
  e.alive.add("wkr-17");
  e.watcher.tick();
  check("(17) recovery turn: a STALE pre-turn reading (ctxUpdatedAt before lastActivity) does NOT fire Trigger D", interruptEvents(e, "wkr-17").length === 0 && e.interrupts.length === 0);

  // Once a FRESH in-turn sample lands (ctxUpdatedAt now strictly later than lastActivity, still over the
  // floor), the SAME refusal lifts on the very next tick — mirrors every other refusal's "no event, next
  // tick retries" policy (never a dead end).
  e.db.setContextCounters("wkr-17", { ctxInputTokens: OVER_BOTH_CTX, ctxTurns: 2, model: "claude-opus-4-8" });
  e.watcher.tick();
  check("(17) once a fresh in-turn reading lands (still over the floor), the interrupt fires", interruptEvents(e, "wkr-17").length === 1 && e.interrupts.length === 1);
  cleanup(e);
}

// (18) Positive control for the stale-reading rule above: a FRESH in-turn reading (ctxUpdatedAt strictly
// LATER than lastActivity, measured AFTER this turn's own rising edge — e.g. the mid-turn sampler firing
// early in the turn) over the floor DOES fire Trigger D, same as every ordinary busy-worker case.
{
  const e = makeEnv({ projectConfig: { orchestration: { workerContextInterruptRatio: 0.85, workerContextWarnRatio: 0 } } });
  seedManager(e, "mgr-18");
  const lastActivity = new Date().toISOString();
  const freshCtxUpdatedAt = new Date(Date.parse(lastActivity) + 5_000).toISOString(); // measured 5s INTO this turn
  e.db.insertSession({
    id: "wkr-18", projectId: e.projId, agentId: e.agentId, engineSessionId: "eng-wkr-18", title: null, cwd: e.projId,
    processState: "live", resumability: "resumable", busy: true,
    createdAt: lastActivity, lastActivity, lastError: null, role: "worker",
    parentSessionId: "mgr-18", taskId: "tk-wkr-18",
    ctxInputTokens: OVER_BOTH_CTX, ctxTurns: 1, ctxUpdatedAt: freshCtxUpdatedAt, model: "claude-opus-4-8", harness: null,
  });
  e.alive.add("wkr-18");
  e.watcher.tick();
  check("(18) a fresh in-turn reading (measured after lastActivity) over the floor fires the interrupt", interruptEvents(e, "wkr-18").length === 1 && e.interrupts.length === 1);
  cleanup(e);
}

// (19) CR round 2's blocking MAJOR, round 3 fix: the worker loop's DETECT path (a REAL transcript
// hitting the terminal exhaustion marker for the FIRST time) must stay READ-ONLY —
// `BusyWorkerWatcher`, never `ContextWatcher`, owns marking/notifying for a worker session. Drives a
// REAL `ContextWatcher.tick()` THEN a REAL `BusyWorkerWatcher.tick()` against the SAME Db/pty, mirroring
// the real boot order (index.ts: contextWatcher.start() precedes busyWorkerWatcher.start(), and Node
// fires equal-interval timers in creation order — so this ordering is deterministic, not a race). Before
// round 3's fix, `ContextWatcher`'s own tick (ticking first) called its MARKING method for the worker
// and filed `manager_context_exhausted` under the WORKER's own session id, starving
// `BusyWorkerWatcher`'s own `worker_context_exhausted` event/notice entirely (its own
// `pty.markContextExhausted` found the mark already applied by the time it ran and no-op'd). Scenario
// (16) above only proves the SKIP once a worker is ALREADY marked — it seeds `contextExhaustedAt`
// directly and never exercises this FIRST-detection path at all.
{
  const e = makeEnv({ projectConfig: { orchestration: { workerContextWarnRatio: 0.60, workerContextInterruptRatio: 0.85 } } });
  seedManager(e, "mgr-19");

  const cwd19 = `${e.projId}-wkr-19`;
  const engineSessionId19 = `eng-wkr-19-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now19 = new Date().toISOString();
  e.db.insertSession({
    id: "wkr-19", projectId: e.projId, agentId: e.agentId, engineSessionId: engineSessionId19, title: null, cwd: cwd19,
    processState: "live", resumability: "resumable", busy: true,
    createdAt: now19, lastActivity: now19, lastError: null, role: "worker",
    parentSessionId: "mgr-19", taskId: "tk-wkr-19",
  });
  e.alive.add("wkr-19");

  // A REAL exhaustion transcript fixture, same shape/helper as context-watcher-context-exhausted.mjs and
  // busy-worker-watcher-context-exhausted.mjs — never a hand-constructed path.
  const REAL_EXHAUSTION_RECORD = {
    type: "assistant",
    message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text: "Prompt is too long" }] },
    error: "invalid_request", isApiErrorMessage: true,
  };
  const transcriptFile = engineTranscriptPath(cwd19, engineSessionId19);
  fs.mkdirSync(path.dirname(transcriptFile), { recursive: true });
  fs.writeFileSync(transcriptFile, `${JSON.stringify(REAL_EXHAUSTION_RECORD)}\n`);

  // `e.pty` (from makeEnv() above) has no `markContextExhausted` at all — patched in here so a call to
  // it (which the FIXED worker loop must never make) is recorded rather than throwing "not a function"
  // and masking the real assertion. The SAME object reference `e.watcher` already holds, so mutating it
  // in place is visible to both watchers below.
  const markedByEither = [];
  e.pty.markContextExhausted = (id) => {
    markedByEither.push(id);
    if (!e.alive.has(id)) return false;
    e.db.setBusy(id, false);
    return true;
  };

  try {
    e.watcher.tick(); // the REAL ContextWatcher — must detect-and-skip, never mark or file anything
    check("(19) ContextWatcher's OWN tick never marks the worker (read-only detect-and-skip)", !markedByEither.includes("wkr-19"));
    check("(19) ContextWatcher's OWN tick never files a manager_context_exhausted event under the worker's id",
      e.db.listEventsForWorker("wkr-19").filter((ev) => ev.kind === "manager_context_exhausted").length === 0);
    check("(19) ContextWatcher's OWN tick leaves busy UNCHANGED (still true — it never touched the row)", e.db.getSession("wkr-19").busy === true);
    check("(19) ContextWatcher's OWN tick never queued a notice for this worker's exhaustion", e.enqueued.filter((m) => m.id === "mgr-19").length === 0);

    const busyWorkerWatcher = new BusyWorkerWatcher({ db: e.db, pty: e.pty, control: new OrchestrationControl() });
    busyWorkerWatcher.tick(); // the REAL BusyWorkerWatcher — must be the one to mark + notify

    check("(19) BusyWorkerWatcher's tick marks the worker exhausted (the mark was left available for it)", markedByEither.includes("wkr-19"));
    check("(19) BusyWorkerWatcher's tick clears busy", e.db.getSession("wkr-19").busy === false);
    const workerExhaustedEvents = e.db.listEventsForWorker("wkr-19").filter((ev) => ev.kind === "worker_context_exhausted");
    check("(19) exactly ONE worker_context_exhausted event (never manager_context_exhausted) for this worker",
      workerExhaustedEvents.length === 1 && workerExhaustedEvents[0].managerSessionId === "mgr-19" && workerExhaustedEvents[0].workerSessionId === "wkr-19");
    check("(19) ZERO manager_context_exhausted events exist for this worker's session id",
      e.db.listEventsForWorker("wkr-19").filter((ev) => ev.kind === "manager_context_exhausted").length === 0);
    check("(19) ZERO manager_context_exhausted events exist in the WHOLE db, scoped to this run's worker id",
      e.db.listEvents("wkr-19").filter((ev) => ev.kind === "manager_context_exhausted").length === 0);

    await waitForCondition(() => e.enqueued.some((m) => m.id === "mgr-19"));
    const notice = e.enqueued.find((m) => m.id === "mgr-19");
    check("(19) the owning manager DOES get BusyWorkerWatcher's own rich [loom:worker-context-exhausted] notice",
      !!notice && notice.text.startsWith("[loom:worker-context-exhausted]") && /worker_recycle/.test(notice.text));
  } finally {
    try { fs.rmSync(path.dirname(transcriptFile), { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  cleanup(e);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — ContextWatcher's worker context WARN notice (Trigger C) fires once per worker session id, pushed to the owning manager only, deduped across sustained high ctx, disabled/orphan/codex-skipped correctly; the worker context INTERRUPT (Trigger D) fires once per worker session id ONLY while the worker is busy and not rate-limited, Esc-interrupts the worker directly, tells the owning manager about it, dedupes identically to the manager's own emergency interrupt, and a refusal (e.g. gate-in-flight) records nothing so the next tick retries cleanly. CR round 2: an already-exhausted worker fires NEITHER trigger (reused checkContextExhaustion/isAlreadyContextExhausted, same as the manager/platform loops), a recovery turn's STALE pre-turn reading does NOT fire Trigger D, and a FRESH in-turn reading still does. CR round 3: a REAL ContextWatcher tick followed by a REAL BusyWorkerWatcher tick on the SAME db proves the worker loop's exhaustion DETECT path is now read-only — zero manager_context_exhausted events, exactly one worker_context_exhausted event, and the manager notice delivered."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
