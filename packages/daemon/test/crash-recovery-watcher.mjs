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
import { RESUME_NUDGE_TAIL, buildBlockedResumeNudgeBody } from "../dist/orchestration/resume-nudge.js";
import { OrchestrationControl } from "../dist/orchestration/control.js";
import { validateProjectConfigOverride, validateAgentProjectConfigOverride } from "../dist/mcp/platform.js";
import { SESSION_ROLES } from "@loom/shared";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const NOW = new Date("2026-06-11T12:00:00.000Z");
const STABILITY_MS = 120_000; // 2 min — the injected stability window for these tests
const at = (ms) => new Date(NOW.getTime() + ms);

function makeEnv({ projectConfig = {}, enqueueDurableNudge } = {}) {
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
  const watcher = new CrashRecoveryWatcher({ db, control, pty, resume, stabilityMs: STABILITY_MS, enqueueDurableNudge });
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
  // Card b25ed05a #1: the dropped parenthetical asserted CURRENT board state ("the task is already in
  // 'review'") from this historical trigger event alone — nothing live gated it, even though a live
  // db.listWorkers read sits right above it in the same code path. RED-proofed by reverting the fix and
  // re-running (see worker_report). Bounded even before the fix (the nudge already says "Call
  // worker_list"), so dropping it only shortens the notice.
  check("(11c) the nudge does NOT assert current board state from the historical trigger alone",
    !!nudge && !/task is already in 'review'/.test(nudge.text));
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
  // card 2ed72a24 (Finding 1): Path C now mirrors Path A's role==='platform' copy branch — no
  // manager-shaped "your workers'/worktrees" phrasing for a Lead; it points at the board + resume doc.
  check("(11d2) the Lead nudge has NO manager-shaped 'workers'/'worktrees' text",
    !!nudge && !/re-check your workers|your worktrees are intact/i.test(nudge.text));
  check("(11d2) the Lead nudge instead points at the home board + living resume doc",
    !!nudge && /home board/i.test(nudge.text) && /resume doc/i.test(nudge.text));
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

// (11g) card 547fcaaa: neither the worker nor the manager/platform auto-recovered nudge asserts an
// unconditional worktree-integrity claim any more — "your worktree WIP is intact" / "your worktrees are
// intact" were hardcoded literals nothing ever checked. The fix removes the false claim (rather than
// softening its wording) and points at re-checking instead, matching the shape card 40b63f1c landed for
// the sibling [loom:daemon-restarted] notice in sessions/service.ts.
{
  const e = makeEnv();
  seedSession(e, "s11g-wkr", { role: "worker", parentSessionId: "mgr-11g" });
  die(e, "s11g-wkr", NOW);
  e.watcher.tick(at(100));
  const wnudge = e.enqueued.find((x) => x.id === "s11g-wkr");
  check("(11g) the worker auto-recovered nudge does NOT assert worktree integrity",
    !!wnudge && !/your worktree WIP is intact/i.test(wnudge.text));
  check("(11g) it instead points the worker at re-checking its worktree's state",
    !!wnudge && /re-check your worktree's state/i.test(wnudge.text));

  // Reuse (11e)'s STRANDED-manager setup to exercise the generic manager/platform branch's copy.
  seedSession(e, "s11g-mgr", { role: "manager" });
  seedTask(e, "s11g-mgr-task");
  e.db.appendEvent({ id: randomUUID(), ts: NOW.toISOString(), managerSessionId: "s11g-mgr", kind: "idle_escalated", detail: { reason: "unanswered_cap", unanswered: 2 } });
  e.db.setIdleNudgePolicy("s11g-mgr", "suppressed");
  die(e, "s11g-mgr", NOW);
  e.watcher.tick(at(200));
  const mnudge = e.enqueued.find((x) => x.id === "s11g-mgr");
  check("(11g) the manager/platform auto-recovered nudge does NOT assert worktree integrity",
    !!mnudge && !/your worktrees are intact/i.test(mnudge.text));
  check("(11g) it instead tells the manager to re-check workers' state AND worktrees",
    !!mnudge && /re-check your workers' state AND worktrees/i.test(mnudge.text));
  cleanup(e);
}

// ============================ (12) O(N) → O(triggered) CANDIDATE DERIVATION (card bf0b902c) ============
// The watcher used to iterate db.listResumeCandidates() — EVERY resumable session in the fleet — calling
// listEventsForWorker (an unindexed full-table SCAN pre-fix) on each just to check whether it ever had a
// trigger. On a real fleet (2559 sessions) that was ~8s of synchronous event-loop blocking per 60s tick.
// It now derives its candidate set from ONE indexed query over the trigger kinds FIRST, so
// listEventsForWorker is called only for sessions that actually ever recorded one. Prove that directly by
// counting calls: a fixture with many resumable-but-never-died sessions plus a FEW that did must issue
// listEventsForWorker calls bounded by the triggered count, not the fleet size — the old code would have
// called it once per resumable session regardless.
{
  const e = makeEnv();
  const N = 60; // a fixture-sized fleet; large enough that an O(N) regression is unmistakable against 3.
  for (let i = 0; i < N; i++) {
    seedSession(e, `crw12-${i}`, { role: i % 2 === 0 ? "manager" : "worker", parentSessionId: i % 2 === 0 ? null : "crw12-mgr" });
  }
  seedSession(e, "crw12-mgr", { role: "manager", processState: "live" }); // parent for the odd (worker) ones
  // Only 3 of the N ever record a recovery trigger.
  die(e, "crw12-0", NOW);
  die(e, "crw12-1", NOW);
  die(e, "crw12-2", NOW);

  let calls = 0;
  const origListEventsForWorker = e.db.listEventsForWorker.bind(e.db);
  e.db.listEventsForWorker = (id) => { calls++; return origListEventsForWorker(id); };

  e.watcher.tick(at(100));

  check(`(12) listEventsForWorker is called ONLY for the triggered sessions (3), not the whole fleet (${N})`,
    calls === 3);
  check("(12) the 3 triggered sessions are still correctly auto-resumed (behavior unchanged, just cheaper)",
    e.resumes.includes("crw12-0") && e.resumes.includes("crw12-1") && e.resumes.includes("crw12-2") && e.resumes.length === 3);
  check(`(12) the other ${N - 3} never-died sessions were never touched (no resume attempt)`,
    evKinds(e, "crw12-3", "session_resume_attempt").length === 0 && evKinds(e, "crw12-59", "session_resume_attempt").length === 0);
  cleanup(e);
}

// ============================ (13) OPERATOR role is RECOVERABLE (card a933613e) ============================
// Same shape as (10)'s assistant fix: RECOVERABLE_ROLES excluded "operator" with no comment ever
// mentioning it — it was added to SESSION_ROLES a month after this list was authored, and the array type
// (SessionRole[]) permitted the now-stale subset with zero diagnostics. Prove it now behaves exactly like
// a worker/manager/assistant death, PLUS gets its own nudge copy — not the manager/platform "continue
// orchestrating" branch, which would misroute (an operator has no workers and isn't an orchestrator).
{
  const e = makeEnv();
  seedSession(e, "op-13a", { role: "operator" });
  const wrote = recordUnexpectedExit(e.db, "op-13a", /*intended*/ false);
  check("(13) an unexpected operator death records ONE session_died (operator is now recoverable)",
    wrote === true && evKinds(e, "op-13a", "session_died").length === 1);
  cleanup(e);
}
{
  const e = makeEnv();
  seedSession(e, "op-13b", { role: "operator" });
  die(e, "op-13b", NOW);
  e.watcher.tick(at(100));
  check("(13) a dead operator session IS auto-resumed on tick", e.resumes.includes("op-13b"));
  check("(13) the resume attempt is recorded for the operator session", evKinds(e, "op-13b", "session_resume_attempt").length === 1);
  const nudge = e.enqueued.find((x) => x.id === "op-13b");
  check("(13) the operator gets its OWN auto-recovered nudge, not the manager/platform 'continue orchestrating' copy",
    !!nudge && /auto-recovered/.test(nudge.text) && !/re-check your workers|continue orchestrating/i.test(nudge.text));
  cleanup(e);
}

// ==================== (14) EVERY SessionRole has an EXPLICIT, ASSERTED disposition (card a933613e) ========
// The structural guard (RECOVERABLE_ROLE_MAP, a Record<SessionRole, boolean> in the source) is enforced by
// the TS COMPILER at build time — a future SESSION_ROLES member with no entry fails to compile. This test
// is the runtime complement: it drives the REAL SESSION_ROLES array (imported from @loom/shared, not a
// hand-copied list, so it tracks the source of truth) through recordUnexpectedExit and asserts each role's
// recorded outcome against an independently hand-authored expected table — so a role's EXCLUSION is proven
// absent BY ASSERTION, not by "the query happened to return nothing" (the polarity trap: a broken check
// that always returns false would pass a bare negative-only test). The included roles are checked at the
// SAME polarity that matters (a present role recording an event) — tests (1)/(10)/(13) already prove that
// positive case for manager/run/assistant/operator individually; this loop re-derives it for every role in
// one place so the full table (not just the roles this card happened to touch) stays pinned.
{
  const EXPECTED_RECOVERABLE = {
    manager: true, worker: true, platform: true, assistant: true, operator: true,
    auditor: false, setup: false, "workspace-auditor": false, run: false,
  };
  check("(14) EXPECTED_RECOVERABLE covers every current SESSION_ROLES member (fixture itself is complete, not stale)",
    SESSION_ROLES.every((r) => r in EXPECTED_RECOVERABLE) && SESSION_ROLES.length === Object.keys(EXPECTED_RECOVERABLE).length);
  const e = makeEnv();
  for (const role of SESSION_ROLES) {
    seedSession(e, `role-${role}`, { role });
    const wrote = recordUnexpectedExit(e.db, `role-${role}`, false);
    check(`(14) role "${role}" recoverability is exactly ${EXPECTED_RECOVERABLE[role]} (by assertion)`, wrote === EXPECTED_RECOVERABLE[role]);
  }
  cleanup(e);
}

// ============================ (15) TIE — card bcdea586: sweep of the e2b6c434 same-millisecond mechanism ==
// ============================ applied to the "is this episode already RESOLVED" gate =======================
// e2b6c434 proved raw `.ts` STRING comparisons between two independently-clocked writers can silently
// misread a same-millisecond tie. This sweeps that mechanism to `lastRecovered.ts >= lastTrigger.ts`
// (crash-recovery-watcher.ts:278) — the highest-consequence candidate on that card: a tie here SKIPS a
// genuine crash recovery, exactly the incident (a dead manager left unresumed) this watcher exists to
// prevent. `lastRecovered` and `lastTrigger` both come from ONE `listEventsForWorker` call (line 272) —
// the SAME clean provenance e2b6c434 exploited — so the fix compares ARRAY POSITION, not `.ts`.
{
  // (15a) POSITIVE CONTROL: a genuinely LATER recovery (by position, not merely a bigger ts) still
  // resolves the episode and is NOT resumed — proves the fix didn't break the ordinary, non-tied case.
  const e = makeEnv();
  seedSession(e, "s15a", { role: "manager" });
  die(e, "s15a", at(0));
  e.db.appendEvent({ id: randomUUID(), ts: at(1000).toISOString(), managerSessionId: "s15a", workerSessionId: "s15a", taskId: null, kind: "session_recovered", detail: { afterAttempts: 1 } });
  e.watcher.tick(at(1100));
  check("(15a) CONTROL: a genuinely-resolved episode (recovery strictly after the trigger) is NOT resumed", !e.resumes.includes("s15a"));
  cleanup(e);

  // (15b) THE TIE: a NEW trigger landing at the IDENTICAL ts as the PRIOR episode's own recovery marker,
  // but genuinely LATER by insertion (rowid) — appended after it, mirroring what `ORDER BY ts, rowid`
  // treats as later — must still read as unresolved and get auto-resumed, never silently skipped.
  const e2 = makeEnv();
  seedSession(e2, "s15b", { role: "manager" });
  const tieTs = at(500).toISOString();
  e2.db.appendEvent({ id: randomUUID(), ts: tieTs, managerSessionId: "s15b", workerSessionId: "s15b", taskId: null, kind: "session_recovered", detail: { afterAttempts: 1 } });
  e2.db.appendEvent({ id: randomUUID(), ts: tieTs, managerSessionId: "s15b", workerSessionId: "s15b", taskId: null, kind: "session_died", detail: { role: "manager" } });
  e2.db.setProcessState("s15b", "exited");
  e2.watcher.tick(at(600));
  check("(15b) TIE: a same-millisecond NEW trigger (genuinely later by rowid) is STILL auto-resumed, not skipped", e2.resumes.includes("s15b"));
  check("(15b) TIE: the new episode records its own resume attempt", evKinds(e2, "s15b", "session_resume_attempt").length === 1);
  cleanup(e2);
}

// ============================ (16) WORKER awaitingReview reaches the RUNTIME watcher too (card 24ed1edc) ===
// The BOOT-time crash-recovery path (crash-orphaned-workers.mjs, deriveCrashOrphanedWorkers +
// recoverCrashOrphanedWorkers) already applies db05e657's ruling 2: a blocked-and-unresolved worker must
// not be told "continue your assigned task" (test (15) there), and a done-and-awaiting-review worker gets
// no continue-nudge either (test (14b) there). CrashRecoveryWatcher — the CONTINUOUS runtime auto-resume,
// a THIRD path entirely (it runs on every boot, not just the two mutually-exclusive BOOT branches
// resumeFleetOnBoot/recoverCrashOrphanedWorkers) — never consulted report state at all before this fix:
// RED under the pre-fix code, this branch sent the unconditional "continue your assigned task" nudge
// regardless of report state, telling a blocked-and-unresolved worker to continue the task it structurally
// cannot continue.

// (16a) BLOCKED, unresolved: must NOT get "continue your assigned task"; must get the distinct
// "re-state your blocker" nudge instead (mirrors crash-orphaned-workers.mjs test (15)).
{
  const e = makeEnv();
  seedSession(e, "mgr-16a", { role: "manager", processState: "live" });
  seedSession(e, "wkr-16a", { role: "worker", parentSessionId: "mgr-16a", taskId: "t16a" });
  e.db.appendEvent({ id: randomUUID(), ts: NOW.toISOString(), managerSessionId: "mgr-16a", workerSessionId: "wkr-16a", taskId: "t16a", kind: "worker_report", detail: { status: "blocked", summary: "need creds", needs: "API key" } });
  die(e, "wkr-16a", at(1000));
  e.watcher.tick(at(1100));
  const nudge = e.enqueued.find((x) => x.id === "wkr-16a");
  check("(16a) a blocked-and-unresolved worker does NOT get the generic continue-your-task nudge", !nudge || !/continue your assigned task/i.test(nudge.text));
  check("(16a) it DOES get a distinct nudge naming its blocked report and telling it to re-state its blocker",
    !!nudge && /blocked/i.test(nudge.text) && /re-state your blocker/i.test(nudge.text));
  // card cfffeda6 (DoD-3): a loose /re-state your blocker/i match cannot detect wording DRIFT between the
  // four call sites that build this sentence — pin the SHARED CONSTANT itself, so a divergent copy (one
  // that reworded this path without going through buildBlockedResumeNudgeBody, or without updating it)
  // fails this exact-text check even though it would still pass the loose regex above.
  const expectedBody = buildBlockedResumeNudgeBody(
    "[loom:auto-recovered] Your session died unexpectedly and Loom auto-resumed it.",
  );
  check("(16a) the nudge body is BYTE-IDENTICAL to buildBlockedResumeNudgeBody's output (not just regex-shaped)",
    !!nudge && nudge.text === expectedBody + RESUME_NUDGE_TAIL);
  cleanup(e);
}

// (16b) DONE, awaiting review: NAMED DECISION (the card requires this be explicit) — SILENCE, matching the
// boot path's identical case (crash-orphaned-workers.mjs test (14b) — that worker gets no continue-nudge
// either, only its manager's summary line changes).
{
  const e = makeEnv();
  seedSession(e, "mgr-16b", { role: "manager", processState: "live" });
  seedSession(e, "wkr-16b", { role: "worker", parentSessionId: "mgr-16b", taskId: "t16b" });
  e.db.appendEvent({ id: randomUUID(), ts: NOW.toISOString(), managerSessionId: "mgr-16b", workerSessionId: "wkr-16b", taskId: "t16b", kind: "worker_report", detail: { status: "done" } });
  die(e, "wkr-16b", at(1000));
  e.watcher.tick(at(1100));
  const nudge = e.enqueued.find((x) => x.id === "wkr-16b");
  check("(16b) a done-and-awaiting-review worker gets NO nudge at all (silence, matching the boot path)", !nudge);
  cleanup(e);
}

// (16c) POSITIVE CONTROL — polarity pair for (16a)/(16b)'s absence assertions: an ordinary worker with NO
// report at all (the common case) still gets the unconditional continue-nudge. Proves the absences above
// aren't from a blanket suppression that swallowed every worker nudge on this path.
{
  const e = makeEnv();
  seedSession(e, "mgr-16c", { role: "manager", processState: "live" });
  seedSession(e, "wkr-16c", { role: "worker", parentSessionId: "mgr-16c", taskId: "t16c" });
  die(e, "wkr-16c", at(1000));
  e.watcher.tick(at(1100));
  const nudge = e.enqueued.find((x) => x.id === "wkr-16c");
  check("(16c) CONTROL: an ordinary worker with no report at all still gets the continue-nudge", !!nudge && /continue your assigned task/i.test(nudge.text));
  cleanup(e);
}

// (16d) CONSUMED report: a blocked report followed by a message_worker (the manager already answered) must
// read as NOT awaitingReview — the worker gets the ordinary continue-nudge, not the "re-state your blocker"
// one (mirrors crash-orphaned-workers.mjs test (14a)'s consumed-report shape, applied to `blocked` here).
{
  const e = makeEnv();
  seedSession(e, "mgr-16d", { role: "manager", processState: "live" });
  seedSession(e, "wkr-16d", { role: "worker", parentSessionId: "mgr-16d", taskId: "t16d" });
  e.db.appendEvent({ id: randomUUID(), ts: NOW.toISOString(), managerSessionId: "mgr-16d", workerSessionId: "wkr-16d", taskId: "t16d", kind: "worker_report", detail: { status: "blocked", summary: "need creds", needs: "API key" } });
  e.db.appendEvent({ id: randomUUID(), ts: NOW.toISOString(), managerSessionId: "mgr-16d", workerSessionId: "wkr-16d", taskId: "t16d", kind: "message_worker", detail: { text: "here's the key" } });
  die(e, "wkr-16d", at(1000));
  e.watcher.tick(at(1100));
  const nudge = e.enqueued.find((x) => x.id === "wkr-16d");
  check("(16d) a CONSUMED blocked report (a manager reply already sent) gets the ordinary continue-nudge, not the re-state-your-blocker one",
    !!nudge && /continue your assigned task/i.test(nudge.text) && !/re-state your blocker/i.test(nudge.text));
  cleanup(e);
}

// (17a) Card 9f7c59f1: when `enqueueDurableNudge` IS wired (production shape — index.ts passes
// sessions.enqueueDurableNudge.bind(sessions)), a worker continuation nudge routes through IT, not the raw
// `pty.enqueueStdin` this tick used to call directly (no MCP-seen gate, no durable give-up record). RED
// under pre-9f7c59f1 code: `enqueueDurableNudge` would never be provided at all (the dep didn't exist), so
// this call would have gone straight to `pty.enqueueStdin` regardless of what's wired here.
{
  const durableCalls = [];
  const e = makeEnv({ enqueueDurableNudge: (id, role, text, taskId) => { durableCalls.push({ id, role, text, taskId }); } });
  seedSession(e, "mgr-17a", { role: "manager", processState: "live" });
  seedSession(e, "wkr-17a", { role: "worker", parentSessionId: "mgr-17a", taskId: "t17a" });
  die(e, "wkr-17a", at(1000));
  e.watcher.tick(at(1100));
  check("(17a) the worker nudge routes through enqueueDurableNudge, not raw pty.enqueueStdin",
    durableCalls.length === 1 && durableCalls[0].id === "wkr-17a" && durableCalls[0].role === "worker" && durableCalls[0].taskId === "t17a" && /continue your assigned task/i.test(durableCalls[0].text));
  check("(17a) raw pty.enqueueStdin is NOT also called for this same nudge (no double-dispatch)",
    e.enqueued.length === 0);
  cleanup(e);
}

// (17b) Same routing for the manager/platform re-orient nudge (the OTHER call site converted by 9f7c59f1).
// Mirrors (11b)'s shape: a dead manager with a live worker has real stake, so the full nudge fires.
{
  const durableCalls = [];
  const e = makeEnv({ enqueueDurableNudge: (id, role, text, taskId) => { durableCalls.push({ id, role, text, taskId }); } });
  seedSession(e, "mgr-17b", { role: "manager" });
  seedSession(e, "mgr-17b-wkr", { role: "worker", parentSessionId: "mgr-17b", processState: "live" });
  die(e, "mgr-17b", NOW);
  e.watcher.tick(at(100));
  const nudge = durableCalls.find((x) => x.id === "mgr-17b");
  check("(17b) the manager re-orient nudge ALSO routes through enqueueDurableNudge",
    !!nudge && nudge.role === "manager" && /auto-recovered/i.test(nudge.text) && /re-check your workers/i.test(nudge.text));
  check("(17b) raw pty.enqueueStdin is NOT also called for the manager nudge",
    !e.enqueued.some((x) => x.id === "mgr-17b"));
  cleanup(e);
}

// (17c) REGRESSION GUARD: with NO `enqueueDurableNudge` dep (every pre-existing hermetic test double,
// throughout this whole file, above) the watcher falls back to the pre-9f7c59f1 raw `pty.enqueueStdin`
// dispatch, byte-identical — this is what keeps every test (1)-(16d) above passing unmodified.
{
  const e = makeEnv(); // no enqueueDurableNudge — the default every other test in this file already uses
  seedSession(e, "mgr-17c", { role: "manager", processState: "live" });
  seedSession(e, "wkr-17c", { role: "worker", parentSessionId: "mgr-17c", taskId: "t17c" });
  die(e, "wkr-17c", at(1000));
  e.watcher.tick(at(1100));
  const nudge = e.enqueued.find((x) => x.id === "wkr-17c");
  check("(17c) with no enqueueDurableNudge dep, the nudge still lands via raw pty.enqueueStdin (fallback)",
    !!nudge && /continue your assigned task/i.test(nudge.text));
  cleanup(e);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — CrashRecoveryWatcher records session_died ONLY for an UNEXPECTED death of a resumable coordination/work session (intended stops + out-of-scope roles untouched); bounded-auto-resumes a dead session, CAPS attempts at crashRecoveryMaxAttempts and ESCALATES (one session_recovery_abandoned + a [loom:crash-loop] lastError) instead of looping past the cap; resets the counter on a stable, still-live resume; and is silent when disabled(0) / human-paused / superseded. zod accepts crashRecoveryMaxAttempts (negatives rejected). An `assistant` (Companion) death is now equally recoverable — recorded, auto-resumed, and nudged. A resumed manager/platform's continuation nudge is now STAKE-AWARE (card c9e51581): silent with zero stake, full when it has a live worker, stranded board work, an unconsumed answer, or was resumed via a worker_report_undelivered trigger — worker/assistant nudges stay unconditional w.r.t. that stake-aware silencing. A resumed WORKER's nudge is now report-state-aware too (card 24ed1edc, applying db05e657's ruling 2 to this runtime path): a blocked-and-unresolved worker gets a distinct 're-state your blocker' nudge instead of the generic continue-nudge it structurally can't act on, and a done-and-awaiting-review worker gets NO nudge at all (silence, matching the boot path's identical case) — an ordinary worker with no unresolved report still gets the unconditional continue-nudge. Its per-tick candidate set is now derived from ONE indexed trigger-kind query (bf0b902c) — listEventsForWorker is called only for sessions that ever actually recorded a trigger, not every resumable session in the fleet. `operator` (card a933613e) is now equally recoverable — RECOVERABLE_ROLES is now a compiler-checked Record<SessionRole, boolean> so a future SESSION_ROLES addition can't silently go undecided again — and every role's disposition is pinned by an explicit runtime assertion, not an absence-shaped default."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
