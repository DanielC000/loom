import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Fresh-spawn KICKOFF GUARANTEE + BROKEN-SPAWN SIGNAL (task c0a6e611).
//
// THE BUG: a `worker_spawn` kickoff rides the CLI as a positional arg (buildSpawnArgs) — the vendor
// `claude` CLI is responsible for auto-typing + auto-submitting it as turn 1 once its TUI boots. That
// internal auto-submit can lose the race against Loom's own boot machinery (mode-cycle keystrokes,
// dialog dismissals) under load and never land as a real turn: the worker sits `live` with
// `engineSessionId:null`, no transcript, no lastError — and the manager gets the BENIGN
// `[loom:worker-idle]` nudge ("finished a turn and is idle but did NOT call worker_report"), which
// masks a broken spawn as a normal park.
//
// THE FIX, two parts, both in pty/host.ts + sessions/service.ts:
//   (H1) scheduleKickoffGuarantee — once a positional-arg spawn reaches `ready` (markReady), if no turn
//        has started within STARTUP_PROMPT_GRACE_MS, force-submit the SAME kickoff text via the exact
//        reliable path (submit()) every later turn uses. Fires for EVERY positional-arg spawn — a fresh
//        worker_spawn, a recycle handoff (recycleWorker/recycleManager/platform-lead recycle all pass a
//        real startupPrompt through this same path), and a run's startup prompt. A no-op ONLY for resume
//        and fork (neither ever passes a positional startupPrompt — lastPrompt stays null there) and a
//        no-op once the CLI's own auto-submit lands in time.
//   (H2) healIfStuck's SHORT pre-first-turn stale window (FIRST_TURN_STALE_MS) — a session that never
//        started turn 1 can't legitimately be "mid a long tool call", so it self-heals busy:false on a
//        much shorter window than the general busyStaleMs (5min), surfacing the broken spawn to the
//        manager fast instead of sitting masked as "busy" for the full window.
//   (S1) notifyManagerOfIdleWorker branches on `engineSessionId` — `null` means no turn (not even the
//        kickoff) EVER started, so it fires a DISTINCT `[loom:worker-spawn-broken]` signal instead of
//        the generic `[loom:worker-idle]` "did NOT call worker_report" copy (which is literally false
//        for a worker that never ran at all). This is a THIRD, distinct signal — NOT a duplicate of the
//        existing `[loom:worker-exited]` (notifyManagerOfExitedWorker, fired on pty EXIT) or the benign
//        `[loom:worker-idle]` (fired when a turn genuinely finished and no report followed).
//
// HERMETIC, claude-free — two layers:
//   (H) HOST — PtyHost driven against a FAKE pty (mirrors pty-resume-readiness.mjs): no real claude.
//   (S) SVC  — SessionService.notifyManagerOfIdleWorker driven directly against a temp .db + a
//              recording stub PtyHost (mirrors worker-exited-without-report.mjs / inbox-pull.mjs).
//
// RUN: pnpm build (from packages/daemon) then `node test/worker-kickoff-guarantee.mjs`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Hermetic LOOM_HOME (host.ts opens a per-session log under $LOOM_HOME/logs in spawn). Grace/stale
// windows are read at MODULE IMPORT time — set them BEFORE importing host.js, short enough for a fast
// test but with FIRST_TURN_STALE_MS comfortably > STARTUP_PROMPT_GRACE_MS (mirrors production's
// grace(10s) < stale(30s) ordering) so the two mechanisms don't race each other inside this test.
const tmpHome = path.join(os.tmpdir(), `loom-kickoff-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_STARTUP_PROMPT_GRACE_MS = "150";
process.env.LOOM_FIRST_TURN_STALE_MS = "450";
process.env.LOOM_READY_FALLBACK_MS = "5000"; // long enough it never fires inside these tests' own windows
process.env.LOOM_RESUME_MODE_POLL_MS = "20"; // fast footer polling for the mode-cycle scenario (H1e)

const { PtyHost } = await import("../dist/pty/host.js");

const PASTE_START = "\x1b[200~";
const SHIFT_TAB = "\x1b[Z";

const fakes = [];
function makeFakePty() {
  const writes = [];
  let dataCb = null;
  const fake = {
    pid: 4242, write: (d) => writes.push(d),
    onData: (cb) => { dataCb = cb; return { dispose() {} }; },
    onExit: () => ({ dispose() {} }), kill: () => {}, resize: () => {},
    writes, feed: (s) => { if (dataCb) dataCb(s); },
  };
  fakes.push(fake);
  return fake;
}
class TestPtyHost extends PtyHost { createPty() { return makeFakePty(); } }
const busyById = {};
const events = {
  onEngineSessionId() {}, onContextStats() {}, onRateLimited() {}, onExit() {},
  onBusy(id, b) { (busyById[id] ??= []).push(b); },
};
const host = new TestPtyHost(events);

const writtenOf = (fake) => fake.writes.join("");
const countIn = (fake, marker) => writtenOf(fake).split(marker).length - 1;
const lastFake = () => fakes[fakes.length - 1];

try {
  // ============ (H1a) LOST RACE: SessionStart fires, the CLI's own auto-submit NEVER lands ============
  // → after STARTUP_PROMPT_GRACE_MS, the kickoff is force-submitted exactly once with the ORIGINAL text.
  {
    const A = "kick-A";
    const KICKOFF = "orchestrate task tk-A";
    host.spawn({
      sessionId: A, cwd: tmpHome, startupPrompt: KICKOFF,
      permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
      geometry: { cols: 120, rows: 40 }, sessionEnv: {},
    });
    const fa = lastFake();
    host.deliverHook(A, { hook_event_name: "SessionStart" }); // ready — no mode-cycles, no UserPromptSubmit ever
    check("(H1a) NOT force-submitted immediately at ready — grace window not yet elapsed", countIn(fa, PASTE_START) === 0);
    await sleep(250); // > STARTUP_PROMPT_GRACE_MS(150) + slack
    check("(H1a) the kickoff was force-submitted exactly once after the grace window", countIn(fa, PASTE_START) === 1);
    check("(H1a) the force-submitted text is the ORIGINAL kickoff", writtenOf(fa).includes(KICKOFF));
    check("(H1a) busy was (re)armed true by the forced submit", busyById[A]?.[busyById[A].length - 1] === true);
    await sleep(200);
    check("(H1a) still exactly ONE forced submit (no repeat firing)", countIn(fa, PASTE_START) === 1);
  }

  // ============ (H1b) WON RACE: the CLI's own auto-submit lands BEFORE the grace elapses ============
  // → simulated by a real UserPromptSubmit hook shortly after SessionStart. No forced duplicate ever.
  {
    const B = "kick-B";
    const KICKOFF = "orchestrate task tk-B";
    host.spawn({
      sessionId: B, cwd: tmpHome, startupPrompt: KICKOFF,
      permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
      geometry: { cols: 120, rows: 40 }, sessionEnv: {},
    });
    const fb = lastFake();
    host.deliverHook(B, { hook_event_name: "SessionStart" }); // ready — grace timer armed
    await sleep(30); // well within the 150ms grace — the CLI's own turn starts on its own
    host.deliverHook(B, { hook_event_name: "UserPromptSubmit" }); // the vendor CLI's auto-submit landed
    host.deliverHook(B, { hook_event_name: "Stop" }); // the turn completes normally
    await sleep(250); // > grace(150) + slack — the fallback window fully elapses
    check("(H1b) NO forced submit — nothing was ever written to the pty by Loom's own submit()", countIn(fb, PASTE_START) === 0);
  }

  // ============ (H1c) ORDERING: the enqueue (real turn start) can race EITHER side of ready ============
  // (c1) turn starts strictly AFTER ready is reached (the common shape, covered by H1a/H1b above).
  // (c2) turn starts BEFORE ready is ever reached (UserPromptSubmit observed pre-SessionStart) — an
  //      artificial ordering this test drives directly to prove scheduleKickoffGuarantee's guard
  //      (`!live.firstTurnStarted`) is checked at SCHEDULE time, not just inside the timeout callback,
  //      so a turn that started early is never redundantly replayed once ready is later reached.
  {
    const C = "kick-C";
    const KICKOFF = "orchestrate task tk-C";
    host.spawn({
      sessionId: C, cwd: tmpHome, startupPrompt: KICKOFF,
      permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
      geometry: { cols: 120, rows: 40 }, sessionEnv: {},
    });
    const fc = lastFake();
    host.deliverHook(C, { hook_event_name: "UserPromptSubmit" }); // "the enqueue" fires BEFORE ready
    host.deliverHook(C, { hook_event_name: "SessionStart" });     // ready reached AFTER the turn already started
    await sleep(250); // > grace(150) + slack
    check("(H1c) ready-after-enqueue: no forced submit — the turn had already started when ready landed", countIn(fc, PASTE_START) === 0);
  }

  // ============ (H1d) NO-OP for resume/fork ONLY (no startupPrompt → lastPrompt stays null) ============
  {
    const D = "kick-D";
    host.spawn({
      sessionId: D, cwd: tmpHome, resumeId: "engine-D", // resume: no startupPrompt passed
      permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
      geometry: { cols: 120, rows: 40 }, sessionEnv: {},
    });
    const fd = lastFake();
    host.deliverHook(D, { hook_event_name: "SessionStart" });
    await sleep(250); // > grace(150) + slack
    check("(H1d) resume path: NEVER force-submits (no kickoff was ever passed)", countIn(fd, PASTE_START) === 0);
  }

  // ============ (H1f) RECYCLE-SHAPED spawn: the guarantee DOES fire (a recycled session's handoff ======
  // rides the SAME positional-arg path as a fresh worker_spawn — recycleWorker/recycleManager/the
  // platform-lead recycle all call pty.spawn with a real startupPrompt (the handoff text), never
  // `--resume` — so it is exposed to the identical lost-CLI-auto-submit race and must be guaranteed too.
  // Same shape as H1a's lost-race case, just framed as a recycle handoff to prove the guarantee isn't
  // fresh-spawn-only.
  {
    const G = "kick-G";
    const HANDOFF = "[loom:handoff] You are continuing a task in an existing git worktree on branch loom/tk-G. Continue from here.";
    host.spawn({
      sessionId: G, cwd: tmpHome, startupPrompt: HANDOFF, // recycleWorker's spawn shape: a real prompt, no resumeId
      permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
      geometry: { cols: 120, rows: 40 }, sessionEnv: {},
    });
    const fg = lastFake();
    host.deliverHook(G, { hook_event_name: "SessionStart" }); // ready — the CLI's own auto-submit never lands
    check("(H1f) recycle handoff: NOT force-submitted immediately at ready — grace window not yet elapsed", countIn(fg, PASTE_START) === 0);
    await sleep(250); // > grace(150) + slack
    check("(H1f) recycle handoff: force-submitted exactly once after the grace window (the guarantee is NOT fresh-spawn-only)", countIn(fg, PASTE_START) === 1);
    check("(H1f) recycle handoff: the force-submitted text is the ORIGINAL handoff", writtenOf(fg).includes(HANDOFF));
  }

  // ============ (H1e) mode-cycling still lands BEFORE the forced kickoff (ordering preserved) =========
  {
    const E = "kick-E";
    const KICKOFF = "orchestrate task tk-E";
    host.spawn({
      sessionId: E, cwd: tmpHome, startupPrompt: KICKOFF,
      permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 2 },
      geometry: { cols: 120, rows: 40 }, sessionEnv: {},
    });
    const fe = lastFake();
    fe.feed("accept edits on (shift+tab to cycle)"); // boot footer painted before SessionStart
    host.deliverHook(E, { hook_event_name: "SessionStart" }); // starts the feedback mode-cycle
    await sleep(750); // > MODE_CYCLE_SETTLE_MS(700) — first footer read → press #1
    fe.feed("plan mode on (shift+tab to cycle)");
    await sleep(150); // > overridden poll (20ms) × several ticks — the change is observed → press #2
    fe.feed("auto mode on (shift+tab to cycle)"); // press #2 lands the target → markReady fires
    await sleep(150);
    check("(H1e) both Shift+Tab presses landed before any forced submit", countIn(fe, PASTE_START) === 0);
    await sleep(250); // > grace(150) + slack, now counted from markReady (post-cycle)
    check("(H1e) the kickoff was eventually force-submitted", countIn(fe, PASTE_START) === 1);
    check("(H1e) ORDERING — the Shift+Tabs were written BEFORE the forced kickoff paste",
      writtenOf(fe).indexOf(SHIFT_TAB) >= 0 && writtenOf(fe).indexOf(SHIFT_TAB) < writtenOf(fe).indexOf(PASTE_START));
  }

  // ============ (H2) healIfStuck: SHORT pre-first-turn stale window self-heals busy fast =================
  // A worker that never starts turn 1 (its forced submit at H1a's grace also never "lands" here, since
  // the fake pty never echoes engine output back) must self-heal busy:false via FIRST_TURN_STALE_MS
  // (450ms) — WAY under the 5-minute default busyStaleMs a real turn would tolerate — proving the SHORT
  // branch fired, not the general one. reconcile() is the real production trigger (index.ts's timer); the
  // test drives it directly.
  {
    const F = "kick-F";
    host.spawn({
      sessionId: F, cwd: tmpHome, startupPrompt: "orchestrate task tk-F",
      permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
      geometry: { cols: 120, rows: 40 }, sessionEnv: {},
    });
    host.deliverHook(F, { hook_event_name: "SessionStart" }); // ready; grace timer armed; never fires UserPromptSubmit
    check("(H2) busy immediately after spawn (optimistic set)", busyById[F]?.[0] === true);
    await sleep(700); // > grace(150, force-submits and resets busySince) + stale(450) + slack
    host.reconcile(); // the real production self-heal trigger
    check("(H2) busy self-healed to false on the SHORT pre-first-turn window (well under the 5min default)",
      busyById[F]?.[busyById[F].length - 1] === false);
  }
} finally {
  for (const id of ["kick-A", "kick-B", "kick-C", "kick-D", "kick-E", "kick-F", "kick-G"]) { try { host.stop(id, "hard"); } catch { /* ignore */ } }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ============================================================================================
// (S) SVC — SessionService.notifyManagerOfIdleWorker: the broken-spawn branch, distinct from BOTH
// the benign worker-idle nudge AND the existing worker_exited_without_report/[loom:worker-exited]
// mechanism (notifyManagerOfExitedWorker — a completely separate function, fired on pty EXIT, untouched
// here). Mirrors worker-exited-without-report.mjs's harness.
// ============================================================================================
{
  const { Db } = await import("../dist/db.js");
  const { SessionService } = await import("../dist/sessions/service.js");
  const { OrchestrationControl } = await import("../dist/orchestration/control.js");

  const NOW = new Date();

  function makeEnv() {
    const dbFile = path.join(os.tmpdir(), `loom-kickoff-svc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
    const db = new Db(dbFile);
    const projId = `kp-${Math.random().toString(36).slice(2, 8)}`;
    const agentId = `ka-${Math.random().toString(36).slice(2, 8)}`;
    const now = NOW.toISOString();
    db.insertProject({ id: projId, name: "Kickoff", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
    db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });
    const enqueued = [];
    const pendingBySession = new Map();
    const pty = {
      enqueueStdin: (id, text) => {
        enqueued.push({ id, text });
        const s = db.getSession(id);
        return s?.processState === "live" ? { delivered: true } : { delivered: false, position: 1 };
      },
      getPendingEntries: (id) => pendingBySession.get(id) ?? [],
    };
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    return { dbFile, db, projId, agentId, enqueued, sessions, pendingBySession };
  }
  function seedSession(e, id, { role = "worker", processState = "live", parentSessionId = null, taskId = null, branch = null, engineSessionId = "eng-" + id } = {}) {
    e.db.insertSession({
      id, projectId: e.projId, agentId: e.agentId, engineSessionId, title: null, cwd: e.projId,
      processState, resumability: "resumable", busy: false,
      createdAt: NOW.toISOString(), lastActivity: NOW.toISOString(), lastError: null, role,
      parentSessionId, taskId, ctxInputTokens: null, ctxTurns: null, model: null, worktreePath: null, branch,
    });
  }
  function seedTask(e, id, columnKey = "in_progress") {
    e.db.insertTask({ id, projectId: e.projId, title: "T-" + id, body: "", columnKey, position: 0, priority: "p2", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() });
  }
  function cleanup(e) {
    try { e.db.close(); } catch { /* ignore */ }
    for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(e.dbFile + ext, { force: true }); } catch { /* ignore */ } }
  }

  // (S1) engineSessionId:null → the DISTINCT [loom:worker-spawn-broken] signal, not the benign idle copy.
  {
    const e = makeEnv();
    seedSession(e, "mgr-s1", { role: "manager" });
    seedTask(e, "tk-s1");
    seedSession(e, "wkr-s1", { taskId: "tk-s1", parentSessionId: "mgr-s1", branch: "loom/tk-s1", engineSessionId: null });

    e.sessions.notifyManagerOfIdleWorker("wkr-s1");
    const broken = e.enqueued.find((x) => x.id === "mgr-s1" && /worker-spawn-broken/.test(x.text));
    check("(S1) engineSessionId:null → a [loom:worker-spawn-broken] nudge is pushed", !!broken);
    check("(S1) the broken-spawn nudge names the worker + task + points at re-drive (worker_message/recycle)",
      !!broken && broken.text.includes("wkr-s1") && broken.text.includes("tk-s1") && /worker_message/.test(broken.text));
    check("(S1) the broken-spawn nudge does NOT use the benign worker-idle framing", !!broken && !/worker-idle/.test(broken.text));
    check("(S1) the broken-spawn nudge is explicit this is NOT benign", !!broken && /NOT a benign/i.test(broken.text));
    check("(S1) exactly ONE nudge fires (no double-signal)", e.enqueued.filter((x) => x.id === "mgr-s1").length === 1);
    cleanup(e);
  }

  // (S2) engineSessionId SET (a real turn ran) → the EXISTING benign idle nudge, unchanged — regression guard.
  {
    const e = makeEnv();
    seedSession(e, "mgr-s2", { role: "manager" });
    seedTask(e, "tk-s2");
    seedSession(e, "wkr-s2", { taskId: "tk-s2", parentSessionId: "mgr-s2", branch: "loom/tk-s2", engineSessionId: "eng-wkr-s2" });

    e.sessions.notifyManagerOfIdleWorker("wkr-s2");
    const idle = e.enqueued.find((x) => x.id === "mgr-s2" && /worker-idle/.test(x.text));
    check("(S2) engineSessionId set → the NORMAL [loom:worker-idle] \"did NOT call worker_report\" nudge fires", !!idle && /did NOT call worker_report/.test(idle.text));
    check("(S2) NOT mis-flagged as a broken spawn", !e.enqueued.some((x) => /worker-spawn-broken/.test(x.text)));
    cleanup(e);
  }

  // (S3) engineSessionId:null AND pending direction already queued → still SKIPS entirely (the existing
  // redirectWorker-race guard runs BEFORE the new branch — no regression to that guard's precedence).
  {
    const e = makeEnv();
    seedSession(e, "mgr-s3", { role: "manager" });
    seedTask(e, "tk-s3");
    seedSession(e, "wkr-s3", { taskId: "tk-s3", parentSessionId: "mgr-s3", branch: "loom/tk-s3", engineSessionId: null });
    e.pendingBySession.set("wkr-s3", [{ id: "m1", text: "[loom:from-manager:redirect]\ndo X instead", source: "system" }]);

    e.sessions.notifyManagerOfIdleWorker("wkr-s3");
    check("(S3) pending direction still suppresses ANY nudge, even for a broken (engineSessionId:null) spawn", e.enqueued.length === 0);
    cleanup(e);
  }

  // (S4) DISTINCT from the existing worker_exited/worker-exited mechanism — that path is a totally
  // separate function (notifyManagerOfExitedWorker, fired on pty exit) and is untouched by this change;
  // confirm the new broken-spawn nudge never collides with its event kind or nudge text.
  {
    const e = makeEnv();
    seedSession(e, "mgr-s4", { role: "manager" });
    seedTask(e, "tk-s4");
    seedSession(e, "wkr-s4", { taskId: "tk-s4", parentSessionId: "mgr-s4", branch: "loom/tk-s4", engineSessionId: null });

    e.sessions.notifyManagerOfIdleWorker("wkr-s4");
    check("(S4) no worker_exited_without_report event is recorded by the idle-watchdog path (separate mechanism)",
      e.db.listEventsForWorker("wkr-s4").filter((ev) => ev.kind === "worker_exited_without_report").length === 0);
    check("(S4) no [loom:worker-exited] text ever appears from this path", !e.enqueued.some((x) => /worker-exited\]/.test(x.text)));
    cleanup(e);
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — kickoff guarantee: a lost CLI auto-submit race is force-submitted exactly once after a short grace window (original text, busy re-armed); a won race never double-submits regardless of which side of `ready` the turn started on; resume/fork are byte-identical no-ops; a RECYCLE-shaped handoff (the same positional-arg path recycleWorker/recycleManager use) IS guaranteed too, not just a fresh worker_spawn; mode-cycle ordering is preserved. healIfStuck self-heals a never-started turn on a short window, well under the 5min default. notifyManagerOfIdleWorker branches on engineSessionId: null → a distinct [loom:worker-spawn-broken] signal (not the benign idle copy, not a duplicate of the existing worker-exited mechanism, still suppressed by the redirect-race pending guard); set → the existing benign nudge, unchanged."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
