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
} finally {
  db.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS -- requestDaemonRestart arms its OWN hard-exit watchdog (intendedExitCode=75, label=daemon_restart) " +
    "around its cleanup call, independent of runGracefulTeardown, and disarms it before exit()."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
