import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 347b3584: `requestDaemonRestart`'s own exit sequence does NOT go through `runGracefulTeardown`
// (it has its own `setTimeout(() => { cleanup?.(); exit(75); }, 300)` call, sharing only the
// `flushVaultsAndStopCodescape` cleanup function — see the decision record) — so it needs its OWN
// hard-exit watchdog arm, with `RESTART_EXIT_CODE` (75) as the intended code, or a hung `cleanup?.()`
// call here would strand the process exactly like the incident this card fixes, just on the restart
// path instead of the signal-stop path. This test proves the WIRING (right code, right ordering, the
// test seam threads through) using a FAKE injected watchdog — the watchdog MECHANISM itself (the real
// worker_threads + Atomics.wait + Windows TerminateProcess kill, preserving an exact custom exit code
// even against a genuinely synchronously-blocked process) is proven generically, with full RED/GREEN
// negative controls, in test/graceful-teardown-hard-exit-backstop.mjs — not re-proven here.
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

process.env.LOOM_HOME = mkdtempManaged("loom-restart-watchdog-home-");
process.env.LOOM_SUPERVISED = "1"; // requestDaemonRestart refuses outright when unsupervised

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { clearRestartIntent, RESTART_EXIT_CODE } = await import("../dist/orchestration/restart.js");
const { pollUntil } = await import("./_timing-guard.mjs");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const makeExit = () => { const calls = []; return { calls, fn: (code) => calls.push({ code, at: performance.now() }) }; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeArmFactory(armCalls) {
  return (opts) => {
    const events = [];
    armCalls.push({ opts, events });
    let disarmed = false;
    return {
      // Round 3 finding 5: record budgetMs too (when given), so this test can assert the EXACT value
      // registered via setShutdownCleanup actually threads through to the RESTART arm's own watchdog.step()
      // call (service.ts's `watchdog.step("flushVaultsAndStopCodescape", cleanup?.flushVaultsStepBudgetMs)`),
      // never a copied/default number.
      step(name, budgetMs) { events.push(budgetMs !== undefined ? `step:${name}:budget=${budgetMs}` : `step:${name}`); },
      disarm() { if (disarmed) return; disarmed = true; events.push("disarmed"); },
    };
  };
}

const db = new Db();
const sessions = new SessionService(db, {}, new OrchestrationControl());
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const ids = { projId: `drw-proj-${sfx}`, agentId: `drw-agent-${sfx}`, mgrId: `drw-mgr-${sfx}` };
const now = new Date().toISOString();
const buildDeps = { runStep: async () => ({ code: 0, out: "" }) };
const isSupervisorAlive = async () => ({ alive: true });

try {
  db.insertProject({ id: ids.projId, name: "DRW", repoPath: "/none", vaultPath: "/none", config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: ids.agentId, projectId: ids.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: ids.mgrId, projectId: ids.projId, agentId: ids.agentId, engineSessionId: null, title: null, cwd: "/none", processState: "running", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

  let cleanupRan = false;
  // Round 3 finding 5 — an explicit, distinctive budget (never one that could coincidentally match a
  // real default) so the threading assertion below can tell "the real registered value arrived" apart
  // from "some unrelated default happened to match".
  const testFlushVaultsStepBudgetMs = 123_456;
  sessions.setShutdownCleanup(() => { cleanupRan = true; }, testFlushVaultsStepBudgetMs);

  const armCalls = [];
  const exit = makeExit();
  const r = await sessions.requestDaemonRestart(ids.mgrId, "test watchdog wiring", {
    buildDeps, exit: exit.fn, mergeDangerGraceMs: 500, isSupervisorAlive,
    armHardShutdownWatchdog: fakeArmFactory(armCalls), watchdogHardExitMs: 4242,
  });
  check("restarting:true", r.restarting === true);
  const exitFired = await pollUntil(() => exit.calls.length > 0, { timeoutMs: 2000, intervalMs: 20 });
  check("exit fired within the flush delay", exitFired);

  check("the watchdog was armed exactly once for this restart", armCalls.length === 1);
  check("armed with intendedExitCode === RESTART_EXIT_CODE (75) — never the plain 0 gracefulShutdown uses", armCalls[0]?.opts.intendedExitCode === RESTART_EXIT_CODE && RESTART_EXIT_CODE === 75);
  check("armed with label 'daemon_restart' (distinct from gracefulShutdown's own 'gracefulShutdown' label)", armCalls[0]?.opts.label === "daemon_restart");
  check("the injected hardExitMs override threads through to the arm call", armCalls[0]?.opts.hardExitMs === 4242);
  check("the real cleanup (registered via setShutdownCleanup) actually ran", cleanupRan === true);
  check(
    "the flushVaultsAndStopCodescape step() call carries the EXACT budget registered via setShutdownCleanup (round 3 finding 5 threading proof)",
    armCalls[0]?.events.includes(`step:flushVaultsAndStopCodescape:budget=${testFlushVaultsStepBudgetMs}`),
  );
  check("disarm() was called (cleanup completed, watchdog stood down) before exit() fired", armCalls[0]?.events.includes("disarmed") && exit.calls.length === 1);

  clearRestartIntent();

  // ---------------------------------------------------------------------------------------------------
  // CR b05bf612 (card 7de21027), BLOCKING: the registered cleanup may now be ASYNC (codescapeSupervisor's
  // own bounded SIGTERM→SIGKILL escalation), and that wait is USELESS unless requestDaemonRestart's own
  // exit-flush timer actually `await`s it instead of firing exit(75) the instant the (now-async) cleanup
  // call returns. Pin that directly: a cleanup that returns a held, externally-resolved promise must
  // keep exit(75) from firing for as long as that promise stays pending, and fire it the instant it's
  // released — never before, never indefinitely after.
  // ---------------------------------------------------------------------------------------------------
  {
    const mgrId2 = `drw-mgr2-${sfx}`;
    db.insertSession({ id: mgrId2, projectId: ids.projId, agentId: ids.agentId, engineSessionId: null, title: null, cwd: "/none", processState: "running", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

    let release;
    const held = new Promise((resolve) => { release = resolve; });
    sessions.setShutdownCleanup(() => held, testFlushVaultsStepBudgetMs);

    const armCalls2 = [];
    const exit2 = makeExit();
    const r2 = await sessions.requestDaemonRestart(mgrId2, "test async cleanup is genuinely awaited", {
      buildDeps, exit: exit2.fn, mergeDangerGraceMs: 500, isSupervisorAlive,
      armHardShutdownWatchdog: fakeArmFactory(armCalls2), watchdogHardExitMs: 4242,
    });
    check("[async cleanup pinned] restarting:true", r2.restarting === true);
    // Well past the 300ms exit-flush delay — if the plumbing ever regresses back to fire-and-forget, this
    // is exactly the window exit(75) would have already fired in.
    // TIMING-GUARD-SAFE: sync-early-return — "exit(75) has NOT fired" is not a timing race: `held` is a
    // bare, developer-controlled promise with no timer of its own attached (only `release()`, called
    // nowhere above this line, can ever settle it) — so no amount of real wall-clock waiting can resolve
    // it on its own, deterministically, regardless of this sleep's duration.
    await sleep(600);
    check("[async cleanup pinned] exit(75) has NOT fired while the cleanup's own promise is still held", exit2.calls.length === 0);
    release();
    const exitFired2 = await pollUntil(() => exit2.calls.length > 0, { timeoutMs: 2000, intervalMs: 20 });
    check("[async cleanup pinned] exit(75) fires once the held cleanup promise is finally released", exitFired2);
    check("[async cleanup pinned] the exit code is RESTART_EXIT_CODE (75)", exit2.calls[0]?.code === RESTART_EXIT_CODE);
    check("[async cleanup pinned] disarm() ran before exit() fired", armCalls2[0]?.events.includes("disarmed"));
    clearRestartIntent();
  }

  // ---------------------------------------------------------------------------------------------------
  // CR b05bf612, item 4: a REJECTING async cleanup must still reach disarm()/exit(75) — never an
  // unhandled rejection that silently strands the restart. The async mirror of the sync-throw case
  // `flushVaultsAndStopCodescape`'s own try/catch already covered.
  // ---------------------------------------------------------------------------------------------------
  {
    const mgrId3 = `drw-mgr3-${sfx}`;
    db.insertSession({ id: mgrId3, projectId: ids.projId, agentId: ids.agentId, engineSessionId: null, title: null, cwd: "/none", processState: "running", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

    const unhandledRejections = [];
    const onUnhandled = (err) => unhandledRejections.push(err);
    process.on("unhandledRejection", onUnhandled);
    sessions.setShutdownCleanup(() => Promise.reject(new Error("cleanup boom")), testFlushVaultsStepBudgetMs);

    const armCalls3 = [];
    const exit3 = makeExit();
    const r3 = await sessions.requestDaemonRestart(mgrId3, "test rejecting cleanup still reaches exit", {
      buildDeps, exit: exit3.fn, mergeDangerGraceMs: 500, isSupervisorAlive,
      armHardShutdownWatchdog: fakeArmFactory(armCalls3), watchdogHardExitMs: 4242,
    });
    check("[rejecting cleanup] restarting:true", r3.restarting === true);
    const exitFired3 = await pollUntil(() => exit3.calls.length > 0, { timeoutMs: 2000, intervalMs: 20 });
    process.removeListener("unhandledRejection", onUnhandled);
    check("[rejecting cleanup] exit(75) still fires despite the rejecting cleanup", exitFired3 && exit3.calls[0]?.code === RESTART_EXIT_CODE);
    check("[rejecting cleanup] disarm() still ran", armCalls3[0]?.events.includes("disarmed"));
    check("[rejecting cleanup] no unhandledRejection escaped the process", unhandledRejections.length === 0);
    clearRestartIntent();
  }
} finally {
  db.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS -- requestDaemonRestart arms its OWN hard-exit watchdog (intendedExitCode=75, label=daemon_restart) " +
    "around its cleanup call, independent of runGracefulTeardown, and disarms it before exit()."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
