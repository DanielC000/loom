import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// CrashRecoveryWatcher test (bounded auto-resume of an isolated session whose pty died UNEXPECTEDLY while
// the daemon stayed healthy). NO claude: the watcher takes an injected `resume` seam (a RECORDING STUB)
// and we drive tick() directly. Hermetic like busy-worker-watcher.mjs — each env gets its OWN temp .db,
// imports dist/* + @loom/shared, boots no daemon. Proves the DoD:
//   • DISCRIMINATOR (recordUnexpectedExit): an UNEXPECTED death (intended=false) of a resumable session
//     records ONE `session_died`; an INTENDED stop (intended=true) records NOTHING (untouched); a plain/
//     run/auditor/non-resumable/superseded session is out of scope.
//   • UNEXPECTED-DEATH → AUTO-RESUMED: tick resumes the dead session + records `session_resume_attempt`.
//   • INTENDED-EXIT → UNTOUCHED: an exited session with no `session_died` is never resumed.
//   • CAP HOLDS + ESCALATES (crash-loop safety): after N re-deaths the watcher STOPS resuming and emits a
//     single `session_recovery_abandoned` + stamps a `[loom:crash-loop]` lastError — never loops past N.
//   • STABLE RESUME → COUNTER RESETS: a session that stays live past the stability window records
//     `session_recovered`, so a later death starts a fresh episode under the cap again.
//   • Silent skips: disabled (crashRecoveryMaxAttempts=0), human-paused, superseded, out-of-scope role.
//   • zod orchestrationOverride accepts crashRecoveryMaxAttempts (incl. 0; negatives rejected).
//
// CLOCK NOTE: the tick-driven tests seed deaths with the `die()` helper (a session_died at a CONTROLLED
// ts) so every event + tick shares ONE injected clock — deterministic regardless of wall-clock. The
// production helper recordUnexpectedExit (which stamps real time) is exercised directly in test (1), which
// asserts only event COUNTS/fields, never a timing comparison.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Db } from "../dist/db.js";
import { CrashRecoveryWatcher, recordUnexpectedExit, recordUndeliveredReport } from "../dist/orchestration/crash-recovery-watcher.js";
import { RESUME_NUDGE_TAIL } from "../dist/orchestration/resume-nudge.js";
import { OrchestrationControl } from "../dist/orchestration/control.js";
import { validateProjectConfigOverride, validateAgentProjectConfigOverride } from "../dist/mcp/platform.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const NOW = new Date("2026-06-11T12:00:00.000Z");
const STABILITY_MS = 120_000; // 2 min — the injected stability window for these tests
const at = (ms) => new Date(NOW.getTime() + ms);

function makeEnv({ projectConfig = {} } = {}) {
  const dbFile = path.join(os.tmpdir(), `loom-crash-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Db(dbFile);
  const projId = `cp-${Math.random().toString(36).slice(2, 8)}`;
  const agentId = `ca-${Math.random().toString(36).slice(2, 8)}`;
  const now = NOW.toISOString();
  db.insertProject({ id: projId, name: "Crash", repoPath: projId, vaultPath: projId, config: projectConfig, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });
  // Recording resume stub: marks the session live (mirrors sessions.resume's setProcessState live) and
  // records the call. By default a resume "succeeds" (stays live); a test flips it back to exited + adds a
  // new death to simulate a re-death.
  const resumes = [];
  const resume = (id) => { resumes.push(id); db.setProcessState(id, "live"); return true; };
  const enqueued = [];
  const pty = { enqueueStdin: (id, text) => { enqueued.push({ id, text }); return { delivered: true }; } };
  const control = new OrchestrationControl();
  const watcher = new CrashRecoveryWatcher({ db, control, pty, resume, stabilityMs: STABILITY_MS });
  return { dbFile, db, projId, agentId, resumes, enqueued, control, watcher, resume };
}

// Seed a session. Defaults: a resumable, EXITED manager (the recovery target).
function seedSession(e, id, { role = "manager", processState = "exited", engineSessionId = "eng-" + id, resumability = "resumable", parentSessionId = null, taskId = null, lastError = null } = {}) {
  e.db.insertSession({
    id, projectId: e.projId, agentId: e.agentId, engineSessionId, title: null, cwd: e.projId,
    processState, resumability, busy: false,
    createdAt: NOW.toISOString(), lastActivity: NOW.toISOString(), lastError, role,
    parentSessionId, taskId, ctxInputTokens: null, ctxTurns: null, model: null,
  });
}
// Record an UNEXPECTED death at a CONTROLLED ts (same injected clock as tick/attempt events) + mark the
// session exited — the watcher's recovery target. Mirrors what recordUnexpectedExit writes in production.
function die(e, id, when = NOW) {
  const s = e.db.getSession(id);
  e.db.appendEvent({
    id: randomUUID(), ts: when.toISOString(),
    managerSessionId: s.parentSessionId ?? id, workerSessionId: id, taskId: s.taskId ?? null,
    kind: "session_died", detail: { role: s.role },
  });
  e.db.setProcessState(id, "exited");
}
function seedTask(e, id, columnKey = "in_progress") {
  e.db.insertTask({ id, projectId: e.projId, title: "T-" + id, body: "", columnKey, position: 0, priority: "p2", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() });
}
const evKinds = (e, id, kind) => e.db.listEventsForWorker(id).filter((ev) => ev.kind === kind);
function cleanup(e) {
  try { e.db.close(); } catch { /* ignore */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(e.dbFile + ext, { force: true }); } catch { /* ignore */ } }
}

// ============================ (1) DISCRIMINATOR — recordUnexpectedExit ============================
{
  const e = makeEnv();
  seedSession(e, "s-unexpected", { role: "manager" });
  const wrote = recordUnexpectedExit(e.db, "s-unexpected", /*intended*/ false);
  check("(1) unexpected death (intended=false) of a resumable session records ONE session_died", wrote === true && evKinds(e, "s-unexpected", "session_died").length === 1);
  const ev = evKinds(e, "s-unexpected", "session_died")[0];
  check("(1) session_died filed under the session (manager → its own id), carries role", ev.managerSessionId === "s-unexpected" && ev.workerSessionId === "s-unexpected" && ev.detail?.role === "manager");

  seedSession(e, "s-intended", { role: "manager" });
  const wrote2 = recordUnexpectedExit(e.db, "s-intended", /*intended*/ true);
  check("(1) INTENDED stop (intended=true) records NOTHING (untouched)", wrote2 === false && evKinds(e, "s-intended", "session_died").length === 0);

  // A worker files its death under its PARENT manager.
  seedSession(e, "mgr-w", { role: "manager", processState: "live" });
  seedSession(e, "wkr-w", { role: "worker", parentSessionId: "mgr-w", taskId: "tk-1" });
  recordUnexpectedExit(e.db, "wkr-w", false);
  const wev = evKinds(e, "wkr-w", "session_died")[0];
  check("(1) a worker's session_died is filed under its parent manager", wev?.managerSessionId === "mgr-w" && wev?.workerSessionId === "wkr-w" && wev?.taskId === "tk-1");

  // Out-of-scope / non-resumable → no record.
  seedSession(e, "s-plain", { role: null });
  seedSession(e, "s-run", { role: "run" });
  seedSession(e, "s-noengine", { role: "manager", engineSessionId: null });
  seedSession(e, "s-dead", { role: "manager", resumability: "dead" });
  recordUnexpectedExit(e.db, "s-plain", false);
  recordUnexpectedExit(e.db, "s-run", false);
  recordUnexpectedExit(e.db, "s-noengine", false);
  recordUnexpectedExit(e.db, "s-dead", false);
  check("(1) plain/run role + no-engine + dead session are OUT of scope (no session_died)",
    evKinds(e, "s-plain", "session_died").length === 0 && evKinds(e, "s-run", "session_died").length === 0 &&
    evKinds(e, "s-noengine", "session_died").length === 0 && evKinds(e, "s-dead", "session_died").length === 0);
  cleanup(e);
}

// ============================ (2) UNEXPECTED-DEATH → AUTO-RESUMED ============================
{
  const e = makeEnv();
  seedSession(e, "s2", { role: "manager" });
  // card c9e51581: a manager/platform's continuation nudge is now stake-aware (silent when it has NO
  // live workers / stranded board / unconsumed answer) — give s2 a genuine stake (a live worker) so this
  // general-purpose "a continuation nudge is enqueued" test still exercises the nudge path. The dedicated
  // silent-vs-full matrix lives in section (11) below.
  seedSession(e, "s2-wkr", { role: "worker", parentSessionId: "s2", processState: "live" });
  die(e, "s2", NOW);
  e.watcher.tick(at(100));
  check("(2) a dead session with session_died is AUTO-RESUMED on tick", e.resumes.length === 1 && e.resumes[0] === "s2");
  check("(2) the resume attempt is recorded (attempt 1 of 3)", evKinds(e, "s2", "session_resume_attempt").length === 1 && evKinds(e, "s2", "session_resume_attempt")[0].detail?.attempt === 1 && evKinds(e, "s2", "session_resume_attempt")[0].detail?.maxAttempts === 3);
  check("(2) a continuation nudge is enqueued to the recovered session (so it re-engages, not just idle)", e.enqueued.length === 1 && e.enqueued[0].id === "s2" && /auto-recovered/.test(e.enqueued[0].text));
  // PL Auditor #11 consistency follow-up: the watcher's auto-resume nudge carries the SAME shared
  // RESUME_NUDGE_TAIL as resumeFleetOnBoot — a `claude --resume`'d session has the same engine reality
  // (reset file-read tracking + a bare "Continue" turn), so the nudge must NOTE both.
  const nudge = e.enqueued[0].text;
  check("(2) the auto-resume nudge carries the shared RESUME_NUDGE_TAIL (DRY — one source)", nudge.includes(RESUME_NUDGE_TAIL));
  check("(2) the tail's file-read-reset note is present (re-Read before Edit)", /reset your file-read tracking/.test(nudge) && /Read a file again before you Edit/.test(nudge));
  // card 5d8dea5f: the bare-"Continue" disclaimer paragraph was REMOVED from the tail — the daemon's single
  // nudge IS the authoritative resume turn, so it no longer spends a sentence reconciling an engine artifact.
  check("(2) the tail has NO bare-continue disclaimer (card 5d8dea5f removed it)", !/Continue from where you left off/.test(nudge) && !/treat them as a single turn/.test(nudge));
  cleanup(e);
}

// ============================ (3) INTENDED-EXIT → UNTOUCHED ============================
{
  const e = makeEnv();
  seedSession(e, "s3", { role: "manager" }); // exited + resumable, but NO session_died (intended stop)
  e.watcher.tick(at(100));
  check("(3) an exited session with NO session_died is NEVER resumed", e.resumes.length === 0 && evKinds(e, "s3", "session_resume_attempt").length === 0);
  cleanup(e);
}

// ============================ (4) CAP HOLDS + ESCALATES (crash-loop safety) ============================
{
  const e = makeEnv(); // default crashRecoveryMaxAttempts = 3
  seedSession(e, "s4", { role: "manager" });
  // Simulate a crash loop: die → tick resumes (stub → live) → re-die → … five rounds, but the cap is 3.
  for (let i = 1; i <= 5; i++) {
    die(e, "s4", at(i * 1000));          // a (re-)death at a controlled ts; also marks it exited
    e.watcher.tick(at(i * 1000 + 100));  // tick shortly after each death
  }
  check("(4) auto-resume is CAPPED at 3 attempts (never resumes a 4th time)", e.resumes.length === 3);
  check("(4) exactly 3 attempt events recorded", evKinds(e, "s4", "session_resume_attempt").length === 3);
  check("(4) after the cap it ESCALATES once (one session_recovery_abandoned), not loops", evKinds(e, "s4", "session_recovery_abandoned").length === 1);
  const ab = evKinds(e, "s4", "session_recovery_abandoned")[0];
  check("(4) the give-up event carries the attempt count + role", ab.detail?.attempts === 3 && ab.detail?.role === "manager");
  const row = e.db.getSession("s4");
  check("(4) crash-loop banner stamped on lastError (role-agnostic Mission-Control surface)", typeof row.lastError === "string" && row.lastError.startsWith("[loom:crash-loop]"));
  // Further ticks must NOT resume again or re-escalate.
  e.watcher.tick(at(99_000));
  check("(4) a later tick does NOT resume past the cap, nor re-escalate", e.resumes.length === 3 && evKinds(e, "s4", "session_recovery_abandoned").length === 1);
  cleanup(e);
}

// ============================ (5) STABLE RESUME → COUNTER RESETS ============================
{
  const e = makeEnv();
  seedSession(e, "s5", { role: "manager" });
  die(e, "s5", NOW);
  e.watcher.tick(at(100));                     // resume #1 → stub leaves it LIVE
  check("(5) first death → resumed once", e.resumes.length === 1 && evKinds(e, "s5", "session_resume_attempt").length === 1);
  // Before the stability window: a tick on the LIVE session does NOT yet record recovery.
  e.watcher.tick(at(STABILITY_MS - 1000));
  check("(5) before the stability window, no session_recovered yet", evKinds(e, "s5", "session_recovered").length === 0);
  // Past the stability window (measured from the last attempt): the still-live session is recovered.
  e.watcher.tick(at(STABILITY_MS + 1000));
  check("(5) past the stability window, a still-live resume records session_recovered", evKinds(e, "s5", "session_recovered").length === 1);
  const row = e.db.getSession("s5");
  check("(5) recovery clears any crash-loop banner on lastError", row.lastError === null);
  // A NEW, unrelated death now starts a FRESH episode — resumed again under the cap (counter was reset).
  die(e, "s5", at(STABILITY_MS + 1500));
  e.watcher.tick(at(STABILITY_MS + 2000));
  check("(5) after reset, a new death is resumed again (fresh episode)", e.resumes.length === 2 && evKinds(e, "s5", "session_resume_attempt").length === 2);
  check("(5) no premature escalation across the reset boundary", evKinds(e, "s5", "session_recovery_abandoned").length === 0);
  cleanup(e);
}

// ============================ (6) SILENT — disabled (crashRecoveryMaxAttempts = 0) ============================
{
  const e = makeEnv({ projectConfig: { orchestration: { crashRecoveryMaxAttempts: 0 } } });
  seedSession(e, "s6", { role: "manager" });
  die(e, "s6", NOW);
  e.watcher.tick(at(100));
  check("(6) crashRecoveryMaxAttempts=0 disables the watcher for that project", e.resumes.length === 0 && evKinds(e, "s6", "session_resume_attempt").length === 0);
  cleanup(e);
}

// ============================ (7) SILENT — human-paused (own scope, manager scope, global) ============================
{
  const e = makeEnv();
  seedSession(e, "mgr-7", { role: "manager", processState: "live" });
  seedSession(e, "wkr-self", { role: "worker", parentSessionId: "mgr-7" });
  seedSession(e, "wkr-sibling", { role: "worker", parentSessionId: "mgr-7" }); // unpaused → still resumed
  die(e, "wkr-self", NOW);
  die(e, "wkr-sibling", NOW);
  e.control.pause("wkr-self");      // worker's own scope
  e.watcher.tick(at(100));
  check("(7) a worker paused in its OWN scope is not resumed", !e.resumes.includes("wkr-self"));
  check("(7) an unpaused sibling IS still resumed", e.resumes.includes("wkr-sibling"));
  // Pause the manager scope → its dead worker is shielded.
  const e2 = makeEnv();
  seedSession(e2, "mgr-7b", { role: "manager", processState: "live" });
  seedSession(e2, "wkr-7b", { role: "worker", parentSessionId: "mgr-7b" });
  die(e2, "wkr-7b", NOW);
  e2.control.pause("mgr-7b");
  e2.watcher.tick(at(100));
  check("(7) a worker whose MANAGER is paused is not resumed", e2.resumes.length === 0);
  // Global pause silences all.
  const e3 = makeEnv();
  seedSession(e3, "s-7c", { role: "manager" });
  die(e3, "s-7c", NOW);
  e3.control.pause("global");
  e3.watcher.tick(at(100));
  check("(7) global pause silences crash recovery", e3.resumes.length === 0);
  cleanup(e); cleanup(e2); cleanup(e3);
}

// ============================ (8) SILENT — superseded (recycled) session ============================
{
  const e = makeEnv();
  seedSession(e, "old-8", { role: "worker", parentSessionId: "mgr-8" });
  die(e, "old-8", NOW); // died, but…
  // A successor now points back at old-8 (a recycle happened) → it must not be auto-resurrected.
  seedSession(e, "new-8", { role: "worker", parentSessionId: "mgr-8" });
  e.db.setOrchestration("new-8", { recycledFrom: "old-8" });
  e.watcher.tick(at(100));
  check("(8) a recycled/superseded session is NOT auto-resumed (its successor took over)", !e.resumes.includes("old-8") && evKinds(e, "old-8", "session_resume_attempt").length === 0);
  cleanup(e);
}

// ============================ (9) zod orchestrationOverride accepts crashRecoveryMaxAttempts ============================
{
  const full = validateProjectConfigOverride({ orchestration: { crashRecoveryMaxAttempts: 5 } });
  check("(9) REST validator accepts crashRecoveryMaxAttempts", full.ok === true && full.value.orchestration?.crashRecoveryMaxAttempts === 5);
  const agent = validateAgentProjectConfigOverride({ orchestration: { crashRecoveryMaxAttempts: 0 } });
  check("(9) agent (loom-platform MCP) validator accepts crashRecoveryMaxAttempts (incl. 0 = disable)", agent.ok === true && agent.value.orchestration?.crashRecoveryMaxAttempts === 0);
  const bad = validateProjectConfigOverride({ orchestration: { crashRecoveryMaxAttempts: -1 } });
  check("(9) a negative crashRecoveryMaxAttempts is rejected", bad.ok === false);
}

// ============================ (10) ASSISTANT role is RECOVERABLE (card 289586c7) ============================
// An isolated Companion (role assistant) PTY death used to be invisible: RECOVERABLE_ROLES excluded
// "assistant", so recordUnexpectedExit filed no session_died and the watchdog never resumed it — only a
// full daemon restart brought it back. Prove it now behaves exactly like a worker/manager death. Two
// separate envs, matching the file's own CLOCK NOTE: recordUnexpectedExit's real-time event is asserted
// on its own (counts/fields only, like test (1)); the tick-driven auto-resume uses ONLY the controlled-
// clock die() helper (like test (2)), never mixed with a real-time event in the same episode.
{
  const e = makeEnv();
  seedSession(e, "asst-10a", { role: "assistant" });
  const wrote = recordUnexpectedExit(e.db, "asst-10a", /*intended*/ false);
  check("(10) an unexpected assistant death records ONE session_died (assistant is now recoverable)",
    wrote === true && evKinds(e, "asst-10a", "session_died").length === 1);
  cleanup(e);
}
{
  const e = makeEnv();
  seedSession(e, "asst-10b", { role: "assistant" });
  die(e, "asst-10b", NOW);
  e.watcher.tick(at(100));
  check("(10) a dead assistant session IS auto-resumed on tick (Mission Control is no longer dark)", e.resumes.includes("asst-10b"));
  check("(10) the resume attempt is recorded for the assistant session", evKinds(e, "asst-10b", "session_resume_attempt").length === 1);
  const nudge = e.enqueued.find((x) => x.id === "asst-10b");
  check("(10) the assistant gets an auto-recovered continuation nudge tailored to it (not the manager/worker copy)",
    !!nudge && /auto-recovered/.test(nudge.text) && !/re-dispatch|worker_report/.test(nudge.text));
  cleanup(e);
}

// ============================ (11) STAKE-AWARE MANAGER/PLATFORM SILENCING (card c9e51581) ============
// Extends Path A's stake-aware wake classification (61cc91c6, restart-wake-classification.mjs) to Path C
// — an ISOLATED unexpected pty death. Worker/assistant nudges stay unconditional (proven above); only the
// manager/platform decision is now silent-vs-full based on real stake (live workers / stranded board /
// unconsumed answer / a worker_report_undelivered trigger).

// (11a) a genuinely stakeless manager (0 live workers, empty board, no answer) resumes SILENTLY.
{
  const e = makeEnv();
  seedSession(e, "s11a", { role: "manager" });
  die(e, "s11a", NOW);
  e.watcher.tick(at(100));
  check("(11a) a dead manager with NO live workers/board/answer is still AUTO-RESUMED", e.resumes.includes("s11a"));
  check("(11a) but it gets NO continuation nudge (silent — no stake)", e.enqueued.filter((x) => x.id === "s11a").length === 0);
  cleanup(e);
}

// (11b) a manager with a LIVE worker (not itself dead) gets the FULL re-orient nudge.
{
  const e = makeEnv();
  seedSession(e, "s11b", { role: "manager" });
  seedSession(e, "s11b-wkr", { role: "worker", parentSessionId: "s11b", processState: "live" });
  die(e, "s11b", NOW);
  e.watcher.tick(at(100));
  const nudge = e.enqueued.find((x) => x.id === "s11b");
  check("(11b) a manager with a live worker gets the FULL re-orient nudge",
    !!nudge && /auto-recovered/.test(nudge.text) && /re-check your workers/i.test(nudge.text));
  cleanup(e);
}

// (11c) a manager resumed via the worker_report_undelivered trigger gets the FULL nudge even with
// otherwise-zero stake (0 live workers of its own, empty board, no answer) — queuedIoReplayed:1 proof.
{
  const e = makeEnv();
  seedSession(e, "s11c", { role: "manager", processState: "exited" });
  recordUndeliveredReport(e.db, e.db.getSession("s11c"), { reportingWorkerId: "wkr-somewhere-else", taskId: null });
  e.watcher.tick(at(100));
  const nudge = e.enqueued.find((x) => x.id === "s11c");
  check("(11c) a manager resumed via worker_report_undelivered gets the FULL review/merge nudge (queuedIoReplayed stake)",
    !!nudge && /worker_list/.test(nudge.text) && /review/.test(nudge.text));
  cleanup(e);
}

// (11d) a platform (Lead) with ORDINARY pending board work (idle-nudge policy 'watching', watcher active)
// now resumes SILENTLY — card 98b3725c gives platform sessions the SAME IdleWatcher coverage a manager
// gets, so its backlog is independently covered by the idle-watcher's own cadence, exactly like (11a)'s
// manager case. This REPLACES the old behavior, where a platform's board work was a stake UNCONDITIONALLY
// (role-based, not idle-nudge-policy-based) because no watchdog covered it at all.
{
  const e = makeEnv();
  seedSession(e, "s11d", { role: "platform" });
  seedTask(e, "s11d-task");
  die(e, "s11d", NOW);
  e.watcher.tick(at(100));
  const nudge = e.enqueued.find((x) => x.id === "s11d");
  check("(11d) a dead platform (Lead) with ORDINARY pending board work (policy 'watching') now resumes SILENTLY — idle-watcher covers it", !nudge);
  cleanup(e);
}

// (11d2) a platform (Lead) with STRANDED board work (idle-nudge policy 'suppressed' via the escalation
// cap — no natural re-arm) still gets the FULL nudge, exactly like (11e)'s manager case below — genuine
// stake is still honored; only ordinary, independently-covered backlog goes silent.
{
  const e = makeEnv();
  seedSession(e, "s11d2", { role: "platform" });
  seedTask(e, "s11d2-task");
  e.db.appendEvent({ id: randomUUID(), ts: NOW.toISOString(), managerSessionId: "s11d2", kind: "idle_escalated", detail: { reason: "unanswered_cap", unanswered: 2 } });
  e.db.setIdleNudgePolicy("s11d2", "suppressed");
  die(e, "s11d2", NOW);
  e.watcher.tick(at(100));
  const nudge = e.enqueued.find((x) => x.id === "s11d2");
  check("(11d2) a dead platform (Lead) with STRANDED board work (escalated-suppressed policy) still gets the FULL nudge",
    !!nudge && /auto-recovered/.test(nudge.text));
  cleanup(e);
}

// (11e) a manager with STRANDED board work (idle-nudge policy 'suppressed' via the escalation cap — no
// natural re-arm) gets the FULL nudge despite having no live workers of its own.
{
  const e = makeEnv();
  seedSession(e, "s11e", { role: "manager" });
  seedTask(e, "s11e-task");
  e.db.appendEvent({ id: randomUUID(), ts: NOW.toISOString(), managerSessionId: "s11e", kind: "idle_escalated", detail: { reason: "unanswered_cap", unanswered: 2 } });
  e.db.setIdleNudgePolicy("s11e", "suppressed");
  die(e, "s11e", NOW);
  e.watcher.tick(at(100));
  const nudge = e.enqueued.find((x) => x.id === "s11e");
  check("(11e) a manager with STRANDED board work (escalated-suppressed policy) gets the FULL nudge", !!nudge && /re-check your workers/i.test(nudge.text));
  cleanup(e);
}

// (11f) a manager with an unconsumed ANSWERED question (empty board, 0 workers) gets the FULL nudge.
{
  const e = makeEnv();
  seedSession(e, "s11f", { role: "manager" });
  e.db.insertQuestion({
    id: `crw-11f-answered-${Date.now()}`, sessionId: "s11f", projectId: e.projId, type: "decision",
    title: "pick an approach", body: "", state: "answered", chosenOption: "a", createdAt: NOW.toISOString(), answeredAt: NOW.toISOString(),
  });
  die(e, "s11f", NOW);
  e.watcher.tick(at(100));
  const nudge = e.enqueued.find((x) => x.id === "s11f");
  check("(11f) a manager with an unconsumed ANSWERED question gets the FULL nudge despite an empty board", !!nudge);
  cleanup(e);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — CrashRecoveryWatcher records session_died ONLY for an UNEXPECTED death of a resumable coordination/work session (intended stops + out-of-scope roles untouched); bounded-auto-resumes a dead session, CAPS attempts at crashRecoveryMaxAttempts and ESCALATES (one session_recovery_abandoned + a [loom:crash-loop] lastError) instead of looping past the cap; resets the counter on a stable, still-live resume; and is silent when disabled(0) / human-paused / superseded. zod accepts crashRecoveryMaxAttempts (negatives rejected). An `assistant` (Companion) death is now equally recoverable — recorded, auto-resumed, and nudged. A resumed manager/platform's continuation nudge is now STAKE-AWARE (card c9e51581): silent with zero stake, full when it has a live worker, stranded board work, an unconsumed answer, or was resumed via a worker_report_undelivered trigger — worker/assistant nudges stay unconditional."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
