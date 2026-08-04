// REAL-SPAWN regression guard for card 03016805 (LOOM_PTY_USE_CONPTY_DLL / useConptyDll).
//
// THE MECHANISM (verified independently at source against the actual installed node-pty@1.1.0, a 3rd
// time this card): node_modules/.pnpm/node-pty@1.1.0/node_modules/node-pty/lib/windowsPtyAgent.js's
// `WindowsPtyAgent.prototype.kill` forks `conpty_console_list_agent` (whose top-level
// `getConsoleProcessList(shellPid)` is the exact call that throws `AttachConsole failed`) ONLY inside its
// `useConpty && !useConptyDll` branch. spawn/connect/resize/clear never touch it, and the
// `useConptyDll:true` branch takes a structurally different path (`_inSocket.destroy()` + native kill, no
// fork at all). This file proves BOTH halves of that claim against a REAL node-pty, a REAL OS process
// tree, and a REAL kill() — no mock (memory `real-spawn-smoke-for-subprocess-features`: a mocked exec
// proves nothing for a host-subprocess behavior change; we have shipped a Windows-only no-op green off a
// mocked exec before).
//
// ⚠️ THE BASELINE ARMS (hard AND graceful) DELIBERATELY EXERCISE THE KNOWN-CRASHY PATH — READ THIS BEFORE
// TOUCHING THE FILE.
// Each baseline trial (LOOM_PTY_USE_CONPTY_DLL unset, i.e. today's production default) calls a REAL
// kill() that forks the REAL conpty_console_list_agent, and — per memory
// `attachconsole-crash-trigger-is-kill-not-spawn-depth` (confirmed 2/2 in isolation, depth-1/concurrency-1
// is SUFFICIENT) — that forked helper is expected to throw `Error: AttachConsole failed` INSIDE ITS OWN
// SEPARATE OS PROCESS. This is EXPECTED AND CONFIRMING for a baseline arm, not a defect: it is direct
// evidence the crash surface really is live today, which is exactly what makes the matching DLL arm's
// absence of it meaningful (memory `positive-control-your-searches-empty-is-not-evidence` — a "0 forks"
// result only means something once we've shown the same detector, under the SAME stop mode, reports "≥1
// fork" against the known-bad case — hard and graceful each need their OWN baseline, since the graceful
// path's real kill() is timer-deferred rather than synchronous; see the fork-spy note below). A FUTURE RED
// IN EITHER BASELINE ARM'S FORK-COUNT CHECK is a real regression (node-pty's kill() no longer takes the
// branch we think it does) — a red anywhere ELSE in this file while investigating that is not
// automatically the same defect; check which assertion actually failed.
//
// Why this is safe to run: the forked child's own uncaught exception is CONTAINED to its own OS process —
// node-pty's kill() never `await`s or `.catch()`es the `_getConsoleProcessList()` promise it fires
// (fire-and-forget), so a crash inside the forked child cannot raise a JS exception or a rejected promise
// in THIS test process. Our own fork-detection assertion is recorded SYNCHRONOUSLY, the instant kill()
// calls `child_process.fork(...)` (a Promise executor runs synchronously) — BEFORE the forked child has
// had any chance to load its native module or throw — so the assertion never depends on the crash
// actually completing, hanging, or racing anything. We still wrap each baseline kill in a scoped
// uncaughtException/unhandledRejection guard as defense in depth (never trusting analysis alone over a
// direct check — memory `a-rule-stored-next-to-an-artifact-does-not-check-it`), but do NOT fail the run on
// anything it catches in a baseline arm specifically; only a DLL arm (which should never touch this path
// at all) treats a caught exception as a failure.
//
// ⚠️ THE SPY/GUARD WINDOW MUST COVER THE FULL TEARDOWN WAIT, NOT JUST THE SYNCHRONOUS stop() CALL (CODE
// REVIEW CATCH, card 03016805). For a graceful stop, host.stop() only writes Ctrl-C and starts
// escalateGracefulStop — the real `live.pty.kill()` (and therefore any fork) fires later, from stage 3's
// `setTimeout(..., GRACEFUL_STOP_KILL_MS)`, IF the process is still alive by then. An earlier draft armed
// the fork spy + uncaught guard only around the synchronous `host.stop()` call and restored them
// immediately after — closing the window ~GRACEFUL_STOP_KILL_MS (default 6000ms) before the real kill
// under test ever ran, so both graceful-arm assertions passed vacuously regardless of the flag. `runTrial`
// now keeps both installed through the teardown `waitUntil` calls too — see its own comment.
//
// WINDOWS-ONLY: useConptyDll and the AttachConsole crash surface are Windows/ConPTY-specific; this file
// skips (not silently passes) on any other platform.
//
// Every kill in this file is scoped to a PID this file captured itself (from `host.live.get(id).pid`, or
// enumerated as a real child of that exact PID via `Get-CimInstance ... -Filter "ParentProcessId=..."`) —
// never by image name, port, or session/project id. `host.stop()` is the only thing that ever kills these
// processes; this file's own PowerShell calls are read-only queries.
//
// Run (after `pnpm build`): node test/pty-conpty-dll-kill.mjs
import { execFile as execFileCb } from "node:child_process";
import child_process from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { waitUntil } from "./_wait.mjs";

const execFileAsync = promisify(execFileCb);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

if (process.platform !== "win32") {
  console.log("SKIP  pty-conpty-dll-kill.mjs — useConptyDll and the AttachConsole crash surface are Windows-only.");
  process.exit(0);
}

const tmpHome = mkdtempManaged("loom-conptydll-");
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { PtyHost } = await import("../dist/pty/host.js");

// ===================== Real, read-only process-existence helpers (PID-scoped, never by name) =====================
// ASYNC (execFile, not execFileSync) — deliberately: a synchronous subprocess call blocks the WHOLE event
// loop, which would starve the very setTimeout-driven graceful-stop escalation machinery this file is
// trying to observe (discovered the hard way — see git history of this file's own development: a first
// draft using execFileSync delayed stop()'s own Ctrl-C-retry timer past the point its target socket had
// already been torn down, producing an unrelated EAGAIN crash that had nothing to do with the mechanism
// under test).
async function psAlive(pid) {
  try {
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'ALIVE' } else { 'GONE' }`],
      { timeout: 5000 });
    return stdout.trim() === "ALIVE";
  } catch { return false; }
}
async function psChildPids(parentPid) {
  try {
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${parentPid}" | Select-Object -ExpandProperty ProcessId) -join ','`],
      { timeout: 5000 });
    return stdout.trim().split(",").map((s) => s.trim()).filter(Boolean).map(Number);
  } catch { return []; }
}

// Self-check the detector itself BEFORE trusting it anywhere below (memory
// `positive-control-your-searches-empty-is-not-evidence`): a known-alive pid (this very process) must
// read alive, and a pid that (almost certainly) does not exist must read gone.
check("psAlive detector: this test's own process reads ALIVE", await psAlive(process.pid));
check("psAlive detector: an implausible pid reads GONE", !(await psAlive(999_999_999)));

const events = { onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} };
const host = new PtyHost(events);

// child_process is a Node CORE MODULE SINGLETON — node-pty's windowsPtyAgent.js does
// `var child_process_1 = require("child_process"); ... child_process_1.fork(...)`, a PROPERTY LOOKUP at
// call time, not a captured reference — so patching `.fork` here is visible to node-pty's own call site
// without touching node-pty's source at all.
const realFork = child_process.fork;
let forkCalls = [];
function spyFork(modulePath, args, opts) {
  forkCalls.push(modulePath);
  const isAgent = typeof modulePath === "string" && modulePath.includes("conpty_console_list_agent");
  const child = realFork(modulePath, args, opts);
  if (isAgent) {
    // See file header: expected on the baseline arm, contained to the forked child's own process.
    child.on("error", () => { /* expected on the baseline arm */ });
    child.on("exit", () => { /* expected on the baseline arm — short-lived, no orphan */ });
  }
  return child;
}

const stoppedIds = new Set();

// HARD-stop trials: cmd.exe running `ping` as its one `/c` command — a genuine 2-process tree (cmd.exe +
// ping.exe), proven reliable, whose exact Ctrl-C behavior doesn't matter since hard-stop never sends one.
//
// GRACEFUL-stop trials need something DIFFERENT and load-bearing (CODE REVIEW CATCH, card 03016805): the
// FIRST draft reused the same `cmd.exe /c ping` shape for the graceful arms and assumed "cmd.exe survives
// Ctrl-C, only the foregrounded ping dies" — WRONG. Windows' `GenerateConsoleCtrlEvent(CTRL_C_EVENT, ...)`
// broadcasts to the WHOLE console process group by default, and `/c` mode gave both processes no reason to
// survive it — the observed result was BOTH cmd.exe and ping.exe dying from the two Ctrl-C writes alone,
// stage 3's escalation `live.pty.kill()` (the branch under test) NEVER REACHED, and both graceful-arm
// assertions passing/failing VACUOUSLY regardless of the flag (the `[baseline-graceful]` control arm
// caught exactly this: 0 forks, but because no kill() call ever happened at all, not because the DLL
// branch skipped one). Fixed: graceful trials spawn a process that DELIBERATELY treats Ctrl-C as ordinary
// input instead of a termination signal (`[Console]::TreatControlCAsInput = $true` — a standard, documented
// PowerShell technique), so it is GUARANTEED to still be alive when stage 3's timer fires, forcing the
// real escalation-triggered kill() path every time. This trades away the 2-process-tree shape for the
// graceful arms (a single powershell.exe) — the tree-teardown claim stays fully covered by the hard-stop
// arms above; the graceful arms' job is specifically to prove the fork behavior under real escalation.
function spawnSpecFor(mode) {
  if (mode === "hard") {
    return { command: "cmd.exe", args: ["/c", "ping", "-n", "30", "127.0.0.1"], hasChildTree: true };
  }
  return { command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", "[Console]::TreatControlCAsInput = $true; Start-Sleep -Seconds 30"], hasChildTree: false };
}

/**
 * Spawn a real process (see `spawnSpecFor` above), kill it via `host.stop(id, mode)` with the fork-spy + a
 * scoped uncaught-exception guard armed across the FULL teardown wait, and assert: (a) whether
 * `conpty_console_list_agent` was forked (see header — this never waits on the forked child's own
 * outcome), and (b) the process (and, for the hard-stop 2-process-tree arms, its real child too) is
 * genuinely gone afterward, not just that stop() returned.
 */
async function runTrial(label, { useDllFlag, mode, expectForkAtLeastOne, failOnCaught }) {
  if (useDllFlag) process.env.LOOM_PTY_USE_CONPTY_DLL = "1";
  else delete process.env.LOOM_PTY_USE_CONPTY_DLL;

  const id = `conptydll-${label.replace(/[^a-z0-9-]/gi, "")}`;
  const spec = spawnSpecFor(mode);
  host.spawnShell({ id, cwd: tmpHome, command: spec.command, args: spec.args, geometry: { cols: 120, rows: 40 }, label });
  const parentPid = host.live.get(id)?.pid;
  check(`${label} spawnShell produced a real parent pid`, typeof parentPid === "number" && parentPid > 0);

  // node-pty's WindowsTerminal.kill() DEFERS to an internal queue until its own `_isReady` flag flips (on
  // the pty's FIRST 'data' event) — calling stop() before any output has arrived would queue the kill
  // silently instead of running it, and our fork-spy window would close before the deferred kill ever
  // actually fires. Wait for real output first, exactly the same signal node-pty's own readiness gate
  // uses, so the stop() call below runs immediately/synchronously rather than being queued.
  let sawData = "";
  const unsub = host.subscribe(id, { onData: (chunk) => { sawData += chunk.toString("utf8"); }, onControl: () => {} });
  await waitUntil(() => sawData.length > 0, { label: `${label} pty produced real output (node-pty's own readiness gate)`, timeoutMs: 8000, intervalMs: 50 });
  unsub();

  // Positive control: prove the process (and, where applicable, its real child) is genuinely alive BEFORE
  // kill — an absence check after kill means nothing unless presence was first shown detectable (same
  // doctrine as the psAlive self-check above).
  check(`${label} parent pid is alive before kill`, await psAlive(parentPid));
  let childPid = null;
  if (spec.hasChildTree) {
    await waitUntil(async () => {
      const kids = await psChildPids(parentPid);
      if (kids.length) { childPid = kids[0]; return true; }
      return false;
    }, { label: `${label} real child process appears under the parent`, timeoutMs: 8000, intervalMs: 100 });
    check(`${label} child pid is alive before kill`, await psAlive(childPid));
  }

  // ===== the kill under test, with the fork spy + a scoped catch-all armed across the FULL teardown wait =====
  // CODE REVIEW CATCH (card 03016805): for a GRACEFUL stop, host.stop() only WRITES Ctrl-C and calls
  // escalateGracefulStop — the real `live.pty.kill()` (and therefore any fork) doesn't happen until stage
  // 3's `setTimeout(..., GRACEFUL_STOP_KILL_MS)` (6000ms default) fires, IF the process is still alive by
  // then. An earlier draft armed the spy/guard only around the synchronous `host.stop()` call and
  // restored them in a `finally` immediately after — closing the window ~6s before the kill it was meant
  // to observe. That made both graceful-arm assertions vacuously pass (0 forks / nothing caught) no matter
  // what LOOM_PTY_USE_CONPTY_DLL was set to, since the spy was never armed when the real kill ran. Fixed:
  // the spy/guard now stay installed through the WHOLE teardown wait below, for hard and graceful alike —
  // for hard this changes nothing (kill is synchronous), for graceful it now actually covers the deferred
  // kill. Same shape as the readiness-gate bug caught earlier in this file's own development: the
  // observation window closed before the thing being measured happened.
  let caught = null;
  const onUncaught = (e) => { caught = e; };
  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onUncaught);
  forkCalls = [];
  child_process.fork = spyFork;
  try {
    host.stop(id, mode);
    stoppedIds.add(id);

    // ===== teardown: the process (and its real child, where one exists) genuinely gone, not just that
    // stop() returned =====
    await waitUntil(async () => !(await psAlive(parentPid)), { label: `${label} parent pid gone after kill`, timeoutMs: 15000, intervalMs: 200 });
    if (spec.hasChildTree) {
      await waitUntil(async () => !(await psAlive(childPid)), { label: `${label} child pid gone after kill`, timeoutMs: 15000, intervalMs: 200 });
    }
  } finally {
    child_process.fork = realFork;
    process.off("uncaughtException", onUncaught);
    process.off("unhandledRejection", onUncaught);
  }

  const agentForkCount = forkCalls.filter((m) => m.includes("conpty_console_list_agent")).length;
  check(`${label} conpty_console_list_agent fork count is ${expectForkAtLeastOne ? ">=1 (crash surface exercised, as expected)" : "0 (DLL branch skips the fork entirely)"}`,
    expectForkAtLeastOne ? agentForkCount >= 1 : agentForkCount === 0);
  if (failOnCaught) {
    check(`${label} kill() raised nothing into this process (nothing should touch the fork path here)`, caught === null);
  } else if (caught) {
    console.log(`   [expected, baseline arm] a forked-child failure surfaced here too: ${caught?.message || caught}`);
  }

  check(`${label} parent pid confirmed gone (no orphan)`, !(await psAlive(parentPid)));
  if (spec.hasChildTree) {
    check(`${label} child pid confirmed gone (no orphan)`, !(await psAlive(childPid)));
  }
}

try {
  try {
    // ===== 1) BASELINE (today's production default, flag unset) — hard stop =====
    // Proves the detector is not vacuous: the crash surface DOES fire under today's default.
    await runTrial("[baseline-hard]", { useDllFlag: false, mode: "hard", expectForkAtLeastOne: true, failOnCaught: false });

    // ===== 2) THE FIX (flag on) — hard stop =====
    await runTrial("[dll-hard]", { useDllFlag: true, mode: "hard", expectForkAtLeastOne: false, failOnCaught: true });

    // ===== 3) BASELINE (flag unset) — graceful stop =====
    // The KNOWN-PRESENT control for the [dll-graceful] arm below (memory
    // `positive-control-your-searches-empty-is-not-evidence`): without this arm, a "0 forks" result on the
    // DLL side of a graceful stop is indistinguishable from a spy window that simply never covered the
    // real (timer-deferred) kill. cmd.exe does NOT self-exit on Ctrl-C (only the foregrounded `ping`
    // does), so this deterministically forces stop()'s escalateGracefulStop path all the way to its own
    // stage-3 `live.pty.kill()` call, ~GRACEFUL_STOP_KILL_MS (default 6000ms) after stop() is called — no
    // timeout constant touched or overridden, this arm just waits it out for real.
    await runTrial("[baseline-graceful]", { useDllFlag: false, mode: "graceful", expectForkAtLeastOne: true, failOnCaught: false });

    // ===== 4) THE FIX (flag on) — graceful stop =====
    await runTrial("[dll-graceful]", { useDllFlag: true, mode: "graceful", expectForkAtLeastOne: false, failOnCaught: true });
  } finally {
    delete process.env.LOOM_PTY_USE_CONPTY_DLL;
    // Safety net only — every trial above already stops its own session in runTrial's try/finally.
    for (const id of ["conptydll-baseline-hard", "conptydll-dll-hard", "conptydll-baseline-graceful", "conptydll-dll-graceful"]) {
      if (stoppedIds.has(id)) continue;
      try { host.stop(id, "hard"); } catch { /* best-effort cleanup */ }
    }
  }
} catch (err) {
  // Same pattern as kickoff-real-spawn.mjs: catch here, before Node's own (unreliable, per that file's
  // investigation) uncaught-exception path, so a genuine regression fails in milliseconds, not ~120s.
  console.error(`\n💥 UNCAUGHT — ${err?.stack || err}`);
  failures++;
  console.log(`\n❌ ${failures} FAILURE(S) — including the uncaught exception above.`);
  await finishAndExit(1);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — against a REAL node-pty@1.1.0, a REAL 2-process tree (cmd.exe + ping.exe), and REAL kill() calls, with the fork spy + catch-all guard held open across the FULL teardown wait (not just the synchronous stop() call — the graceful path's real kill() is timer-deferred): on BOTH hard and graceful stop, the baseline (flag unset, today's default) forks conpty_console_list_agent as expected, LOOM_PTY_USE_CONPTY_DLL=1 skips that fork entirely, and in every trial the whole process tree is genuinely gone afterward, not just that stop() returned."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
