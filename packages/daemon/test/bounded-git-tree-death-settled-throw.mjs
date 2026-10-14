import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
// Board card 495fd320 — a caller-supplied `onTreeDeathSettled` callback (e.g. merge-quarantine's
// in-process auto-clear, `clearMergeQuarantineByToken`) can throw. Every call site inside
// `packages/daemon/src/git/bounded.ts` sits inside a `void`'d async IIFE (`child.on("close", ...)`) with
// no surrounding try/catch of its own — an uncaught throw there becomes an unhandled rejection, and the
// `reject(...)` a few lines below it NEVER runs, so the bounded git promise this callback is nested
// inside never settles AT ALL. That can hang a real merge path indefinitely.
//
// THE FIX: every `onTreeDeathSettled?.(...)` call now routes through `invokeTreeDeathSettledSafely`,
// which try/catches the callback and swallows (never rethrows) whatever it throws — so the surrounding
// IIFE always reaches its own `reject(...)` regardless of what the callback does.
//
// There are THREE real call sites — `rawViaDirectSpawn`'s two branches (the pid-null/win32 unconditional
// confirm, and the posix pid+confirmProcessGroupDead branch) and `rawViaWinJobLauncher`'s one. SCENARIOS
// 1-2 below cover the FIRST of those two, hermetically, via `spawnCanonicalGitTree`'s own `spawnImpl`
// test seam — mirroring `bounded-git-kill-marker-exclusivity.mjs`'s own scenario `[6]`. SCENARIO 3 covers
// the win-job-launcher call site, win32-only, via `setWinJobLauncherOverrideForTest` (test-only seam,
// `git/bounded.ts` — never touches the real `win-job-launcher.exe` the live self-hosting daemon uses) —
// mirroring `win-job-launcher-fallback-branches.mjs`'s own fully-faked-spawn pattern.
//
// CR a45e4011 (round 2 of this card): SCENARIOS 1-2's ORIGINAL form called `spawnCanonicalGitTree`
// without pinning the dispatch, so on a host where `win-job-launcher.exe` IS built (the main checkout
// always has one, since `daemon_restart`'s deploy rebuild runs `build:native` — see CLAUDE.md), dispatch
// silently took the win-job-launcher branch instead of `rawViaDirectSpawn`, and the fake spawnImpl's
// `--signal` child never emitted `close` — the test hung until its own 2000ms timeout fired and FAILED.
// Both scenarios now explicitly pin the dispatch to the fallback via `setWinJobLauncherOverrideForTest(null)`
// (same pattern as `merge-quarantine-batch.mjs`, commit `9b1f09a7`), so they test what they claim on
// every checkout, launcher built or not.
//
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/bounded-git-tree-death-settled-throw.mjs
const {
  spawnCanonicalGitTree, setWinJobLauncherOverrideForTest, treeDeathConfirmed, treeDeathUnconfirmed,
  LAUNCHER_EXIT_CONFIRMED_KILLED, LAUNCHER_EXIT_UNCONFIRMED_KILLED,
} = await import("../dist/git/bounded.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// A promise race against a short, explicit timeout — so a genuine "never settles" regression (the exact
// bug this card fixes) fails this test LOUDLY instead of hanging the whole process forever.
function settledWithinOrTimeout(p, ms, label) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`[${label}] did not settle within ${ms}ms — the bounded git promise is STUCK`)), ms);
  });
  return Promise.race([p.then((v) => ({ settled: "resolved", value: v }), (e) => ({ settled: "rejected", value: e })), timeout])
    .finally(() => clearTimeout(timer));
}

// Captures every `console.error` call made while `fn` runs (still forwarding to the real console.error,
// so the log line remains visible in normal test output too) — used to assert the throwing-callback
// swallow is actually LOGGED, not just silently absorbed.
async function captureConsoleError(fn) {
  const real = console.error;
  const lines = [];
  console.error = (...args) => { lines.push(args.map(String).join(" ")); real(...args); };
  try {
    return { value: await fn(), lines };
  } finally {
    console.error = real;
  }
}

function fakeDirectSpawnChild() {
  const child = new EventEmitter();
  child.pid = null;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

try {
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO 1 — THE REPRO (rawViaDirectSpawn's pid-null/win32 branch). A throwing onTreeDeathSettled
  // must never leave the bounded git promise unsettled. Pinned to the fallback dispatch (CR a45e4011).
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    setWinJobLauncherOverrideForTest(null);
    let settleCalls = 0;
    const throwingSettle = (confirmed) => {
      settleCalls++;
      throw new Error(`injected throwing settle callback (confirmed=${confirmed})`);
    };
    const controller = new AbortController();
    let capturedChild;
    const { raw } = spawnCanonicalGitTree("/fake/repo", undefined, controller.signal, 1000, throwingSettle, () => {
      capturedChild = fakeDirectSpawnChild();
      return capturedChild;
    });
    const p = raw(["status"]);
    controller.abort(); // synchronously fires spawnCanonicalGitTree's own onAbort handler
    capturedChild.emit("close", null); // stand in for the (fake) child actually exiting

    const { value: outcome, lines } = await captureConsoleError(() => settledWithinOrTimeout(p, 2000, "throwing onTreeDeathSettled (direct-spawn)"));
    check("*** THE FIX *** the bounded git promise SETTLES despite the throwing callback (did not time out)", outcome.settled !== undefined);
    check("(repro) the settle callback was actually invoked", settleCalls === 1);
    check("(repro) the promise settles by REJECTING (the real confirmed-kill rejection, never swallowed by the callback's own throw)", outcome.settled === "rejected");
    check("(repro) the real rejection reason survives, unreplaced by the callback's own thrown error", /Abort signal received/.test(outcome.value?.message ?? ""));
    check("(repro) treeDeathConfirmed is true for this rejection", treeDeathConfirmed(outcome.value));
    check("(repro) the swallow is LOGGED", lines.some((l) => l.includes("onTreeDeathSettled callback threw") && l.includes("injected throwing settle callback")));
    setWinJobLauncherOverrideForTest(undefined);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO 2 — NEGATIVE CONTROL — the SAME fixture shape, but a NON-throwing settle callback. Must
  // behave exactly as before this fix: the promise still settles (by rejecting), and the callback is
  // still invoked exactly once with the expected `confirmed` value. Also pinned to the fallback.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    setWinJobLauncherOverrideForTest(null);
    let settleCalls = 0;
    let settleConfirmedArg;
    const quietSettle = (confirmed) => { settleCalls++; settleConfirmedArg = confirmed; };
    const controller = new AbortController();
    let capturedChild;
    const { raw } = spawnCanonicalGitTree("/fake/repo", undefined, controller.signal, 1000, quietSettle, () => {
      capturedChild = fakeDirectSpawnChild();
      return capturedChild;
    });
    const p = raw(["status"]);
    controller.abort();
    capturedChild.emit("close", null);

    const outcome = await settledWithinOrTimeout(p, 2000, "non-throwing onTreeDeathSettled (control, direct-spawn)");
    check("(control) the bounded git promise settles with a non-throwing callback too", outcome.settled !== undefined);
    check("(control) the settle callback was invoked exactly once", settleCalls === 1);
    check("(control) the settle callback received confirmed=true (the pid-null/win32 unconditional-confirm branch)", settleConfirmedArg === true);
    check("(control) the promise settles by rejecting, same shape as the throwing case", outcome.settled === "rejected");
    setWinJobLauncherOverrideForTest(undefined);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO 3 (CR a45e4011) — the THIRD real call site: rawViaWinJobLauncher's own aborted-close branch
  // (bounded.ts ~L763). Win32-only — this dispatch path has no POSIX analogue. Fully hermetic: a fake
  // spawnImpl (mirroring win-job-launcher-fallback-branches.mjs's own pattern) stands in for BOTH the
  // main launcher child and its own "--signal" abort-signaler child, so no real win-job-launcher.exe is
  // ever spawned regardless of whether this host has built one. Covers BOTH the CONFIRMED and
  // UNCONFIRMED launcher exit codes, each with a throwing callback.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  if (process.platform !== "win32") {
    console.log("SKIP  (scenario 3) win-job-launcher dispatch is win32-only; this host is '" + process.platform + "'.");
  } else {
    // A dummy file that merely needs to EXIST for `isWinJobLauncherAvailable()`'s `fs.existsSync` check
    // to pass — the fake spawnImpl below never actually execs it, so its content is irrelevant. Using
    // this test file's own path (always present) needs no extra fixture file or cleanup.
    const dummyLauncherPath = fileURLToPath(import.meta.url);

    function makeFakeLauncherSpawn({ onRun, onSignal }) {
      return function fakeSpawn(cmd, args) {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => {};
        if (cmd === dummyLauncherPath && args[0] === "run") onRun(child, args);
        else if (cmd === dummyLauncherPath && args[0] === "--signal") onSignal(child, args);
        return child;
      };
    }

    async function runLauncherSettleCase(label, launcherExitCode, expectedConfirmed) {
      setWinJobLauncherOverrideForTest(dummyLauncherPath);
      let settleCalls = 0;
      let settleConfirmedArg;
      const throwingSettle = (confirmed) => {
        settleCalls++;
        settleConfirmedArg = confirmed;
        throw new Error(`injected throwing settle callback (launcher, confirmed=${confirmed})`);
      };
      let mainChild;
      const fakeSpawn = makeFakeLauncherSpawn({
        onRun: (child) => { mainChild = child; }, // deliberately never closes on its own
        onSignal: (child) => {
          setImmediate(() => {
            child.emit("close", 0); // signal delivered — resolves signalWinJobLauncherAbort's own promise
            setImmediate(() => mainChild.emit("close", launcherExitCode));
          });
        },
      });
      const controller = new AbortController();
      const { raw } = spawnCanonicalGitTree("C:\\fake\\repo", undefined, controller.signal, 5000, throwingSettle, fakeSpawn);
      const p = raw(["status"]);
      controller.abort(); // synchronously fires onAbort -> signalWinJobLauncherAbort -> spawns the "--signal" child

      const { value: outcome, lines } = await captureConsoleError(() => settledWithinOrTimeout(p, 2000, `throwing onTreeDeathSettled (launcher, ${label})`));
      check(`*** THE FIX *** (launcher, ${label}) the bounded git promise SETTLES despite the throwing callback`, outcome.settled !== undefined);
      check(`(launcher, ${label}) the settle callback was invoked exactly once`, settleCalls === 1);
      check(`(launcher, ${label}) the settle callback received confirmed=${expectedConfirmed}`, settleConfirmedArg === expectedConfirmed);
      check(`(launcher, ${label}) the promise settles by rejecting`, outcome.settled === "rejected");
      check(`(launcher, ${label}) treeDeathConfirmed/treeDeathUnconfirmed match the expected marker`, expectedConfirmed ? treeDeathConfirmed(outcome.value) : treeDeathUnconfirmed(outcome.value));
      check(`(launcher, ${label}) the rejection message matches the expected confirmed/unconfirmed shape`, expectedConfirmed
        ? outcome.value?.message === "Abort signal received"
        : outcome.value?.message === "Abort signal received (process tree not fully confirmed dead)");
      check(`(launcher, ${label}) the swallow is LOGGED`, lines.some((l) => l.includes("onTreeDeathSettled callback threw") && l.includes("injected throwing settle callback")));
      setWinJobLauncherOverrideForTest(undefined);
    }

    await runLauncherSettleCase("confirmed", LAUNCHER_EXIT_CONFIRMED_KILLED, true);
    await runLauncherSettleCase("unconfirmed", LAUNCHER_EXIT_UNCONFIRMED_KILLED, false);
  }
} catch (e) {
  console.error("UNEXPECTED THROW:", e);
  failures++;
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
