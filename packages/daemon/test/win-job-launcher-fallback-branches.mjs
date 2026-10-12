import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 1718416d, round 2 (MINOR b) — Node-level coverage for three bounded.ts branches that the real-exe
// matrix (win-job-launcher-spawn.mjs etc.) doesn't reach directly: the single refusal-code fallback, the
// aborted-but-not-confirmed branch (a non-CONFIRMED close code while aborted), and a REAL spawn error
// against the launcher path (exe present but unspawnable — Smart App Control/AppLocker/WDAC/AV/corrupt).
//
// UNLIKE the real-exe matrix, this file needs NO `build:native` — the first two cases drive
// `spawnCanonicalGitTree`'s own `spawnImpl` test seam with a fully-faked child process (no real process
// is ever spawned for the "launcher"), and the third points `setWinJobLauncherOverrideForTest` at a
// genuine non-executable file so Node's REAL spawn machinery produces a real spawn error — no built exe
// required for any of the three. Still WINDOWS-ONLY: `spawnCanonicalGitTree`'s win-job-launcher dispatch
// is itself gated on `process.platform === "win32"`, so on POSIX this mechanism is simply never reached
// regardless of what `isWinJobLauncherAvailable()` reports.
//
// Full mechanism: docs/decisions/1718416d-win-job-launcher-containment.md.
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtempManaged } from "./_tmp-fixture.mjs";

if (process.platform !== "win32") {
  console.log("SKIP  win-job-launcher-fallback-branches — win32-only (this host is '" + process.platform + "'); the win-job-launcher dispatch has no POSIX analogue.");
  process.exit(0);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const {
  spawnCanonicalGitTree, killableCanonicalRaw, treeDeathConfirmed, treeDeathUnconfirmed,
  setWinJobLauncherOverrideForTest, isWinJobLauncherAvailable,
  // round 3 (optional item): import the REAL exit-code constants rather than keeping hand-copied
  // literals — see native/win-job-launcher/launcher.cs's own file-header doc for the authoritative def.
  LAUNCHER_EXIT_UNCONFIRMED_KILLED, LAUNCHER_EXIT_REFUSED,
} = await import(pathToFileURL(path.join(distGitDir, "bounded.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

/** A minimal fake ChildProcess: an EventEmitter with `.stdout`/`.stderr` sub-emitters and a no-op
 *  `.kill()` — enough to satisfy every access `bounded.ts` makes (`.stdout?.on`, `.stderr?.on`,
 *  `.on("error"|"close", ...)`, `.kill()`), with NO real OS process ever spawned. */
function fakeChild() {
  const ee = new EventEmitter();
  ee.stdout = new EventEmitter();
  ee.stderr = new EventEmitter();
  ee.kill = () => {};
  return ee;
}

/** Discriminates by which binary bounded.ts asked to spawn: the dummy launcher path in "run" mode, the
 *  same path in "--signal" mode, or a literal "git" for the direct-spawn fallback — exactly the three
 *  shapes `rawViaWinJobLauncher`/`signalWinJobLauncherAbort`/`rawViaDirectSpawn` produce. */
function makeFakeSpawn(launcherPath, { onLauncherRun, onLauncherSignal, onGit } = {}) {
  return function fakeSpawn(cmd, args) {
    const child = fakeChild();
    if (cmd === launcherPath && args[0] === "run") onLauncherRun?.(child, args);
    else if (cmd === launcherPath && args[0] === "--signal") onLauncherSignal?.(child, args);
    else if (cmd === "git") onGit?.(child, args);
    return child;
  };
}

async function run() {
  // A dummy file that merely needs to EXIST for `isWinJobLauncherAvailable()`'s `fs.existsSync` check to
  // pass — the fake `spawnImpl` below never actually execs it, so its content is irrelevant.
  const dummyLauncherPath = fileURLToPath(import.meta.url);

  try {
    // Case 1: the launcher refuses this call (its single refusal code) — must fall back to a direct git
    // spawn for THIS call, and resolve with THAT fallback's own output.
    {
      setWinJobLauncherOverrideForTest(dummyLauncherPath);
      const calls = [];
      const fakeSpawn = makeFakeSpawn(dummyLauncherPath, {
        onLauncherRun: (child) => {
          calls.push("launcher-run");
          setImmediate(() => child.emit("close", LAUNCHER_EXIT_REFUSED));
        },
        onGit: (child) => {
          calls.push("git");
          setImmediate(() => {
            child.stdout.emit("data", Buffer.from("fake git output"));
            child.emit("close", 0);
          });
        },
      });
      const controller = new AbortController();
      const { raw } = spawnCanonicalGitTree("C:\\fake\\repo", undefined, controller.signal, 5000, undefined, fakeSpawn);
      const out = await raw(["commit", "--allow-empty", "-m", "refusal fallback case"]);
      check("refusal-code fallback: resolves with the direct-spawn fallback's own output", out === "fake git output");
      check("refusal-code fallback: ran the launcher once, then fell back to a direct git spawn once", calls.join(",") === "launcher-run,git");
    }

    // Case 2: abort fires; the signal is delivered successfully (code 0) but the MAIN launcher's own
    // close code is NOT the confirmed-kill code — must reject tagged unconfirmed, never confirmed.
    {
      setWinJobLauncherOverrideForTest(dummyLauncherPath);
      let mainChild = null;
      const fakeSpawn = makeFakeSpawn(dummyLauncherPath, {
        onLauncherRun: (child) => { mainChild = child; }, // deliberately never closes on its own
        onLauncherSignal: (child) => {
          setImmediate(() => {
            child.emit("close", 0); // signal delivered — resolves signalWinJobLauncherAbort's own promise
            setImmediate(() => mainChild.emit("close", LAUNCHER_EXIT_UNCONFIRMED_KILLED));
          });
        },
      });
      const controller = new AbortController();
      const { raw } = spawnCanonicalGitTree("C:\\fake\\repo", undefined, controller.signal, 5000, undefined, fakeSpawn);
      const p = raw(["commit", "--allow-empty", "-m", "aborted unconfirmed case"]);
      controller.abort();
      let threw = null;
      try { await p; } catch (e) { threw = e; }
      check("aborted-but-not-confirmed: rejects", threw !== null);
      check("aborted-but-not-confirmed: treeDeathUnconfirmed", threw !== null && treeDeathUnconfirmed(threw));
      check("aborted-but-not-confirmed: NOT treeDeathConfirmed", threw !== null && !treeDeathConfirmed(threw));
    }

    // Case 3: a REAL spawn attempt against a genuine non-executable file — no fake spawnImpl here, the
    // default real `spawn` is used, so Node's own OS-level spawn failure drives this, not a simulation.
    {
      // mkdtempManaged's own fs.mkdtempSync-backed uniqueness (never a hand-rolled Date.now()/pid
      // suffix — clock-path-regression-guard.mjs flags that shape as Tier-B-candidate) also registers
      // the dir for auto-cleanup, so no separate fs.rmSync is needed here.
      const bogusDir = mkdtempManaged("loom-wjl-bogus-");
      const bogusPath = path.join(bogusDir, "bogus.exe");
      fs.writeFileSync(bogusPath, "not a real executable\n");
      setWinJobLauncherOverrideForTest(bogusPath);
      const repo = mkdtempManaged("loom-wjl-spawnerr-");
      execFileSync("git", ["init", "-q"], { cwd: repo });
      execFileSync("git", ["config", "user.email", "wjl@loom"], { cwd: repo });
      execFileSync("git", ["config", "user.name", "wjl"], { cwd: repo });
      const out = await killableCanonicalRaw(repo, ["commit", "--allow-empty", "-m", "spawn-error fallback case"], 10000, "wjl-spawn-error");
      check("spawn-error fallback: resolves (the fallback's own real git call ran)", typeof out === "string");
      const log = execFileSync("git", ["log", "-1", "--format=%s"], { cwd: repo, encoding: "utf8" }).trim();
      check("spawn-error fallback: commit actually landed via the fallback", log === "spawn-error fallback case");
      check("spawn-error fallback: availability cache flipped to false after the real spawn error", isWinJobLauncherAvailable() === false);
    }

    // Case 4 (round 3, MINOR-3): a fake-spawn ASYNC "error" that fires BEFORE the child ever reaches
    // "spawn" — the never-truly-ran shape MAJOR 3 covers, but via the async event path rather than a
    // synchronous spawnImpl throw (Case 3 above already covers that one, with a REAL spawn error).
    {
      setWinJobLauncherOverrideForTest(dummyLauncherPath);
      const calls = [];
      const fakeSpawn = makeFakeSpawn(dummyLauncherPath, {
        onLauncherRun: (child) => {
          calls.push("launcher-run");
          setImmediate(() => child.emit("error", Object.assign(new Error("simulated ENOENT before spawn"), { code: "ENOENT" })));
        },
        onGit: (child) => {
          calls.push("git");
          setImmediate(() => {
            child.stdout.emit("data", Buffer.from("fake git output (case4)"));
            child.emit("close", 0);
          });
        },
      });
      const controller = new AbortController();
      const { raw } = spawnCanonicalGitTree("C:\\fake\\repo", undefined, controller.signal, 5000, undefined, fakeSpawn);
      const out = await raw(["commit", "--allow-empty", "-m", "error-before-spawn case"]);
      check("error-before-spawn: resolves with the direct-spawn fallback's own output", out === "fake git output (case4)");
      check("error-before-spawn: ran the launcher once, then fell back to a direct git spawn exactly once", calls.join(",") === "launcher-run,git");
    }

    // Case 5 (round 3, MAJOR-A + MINOR-3): a fake-spawn ASYNC "error" that fires AFTER the child reached
    // "spawn" — e.g. a failed .kill() on a still-running process (EPERM). Falling back here would start
    // a SECOND, non-idempotent git while the first may still be alive — must reject unconfirmed, spawn
    // NO fallback git at all, and leave the memoized availability untouched.
    //
    // ⭐ Verified this goes RED against the pre-fix code before trusting the GREEN below: temporarily
    // reverted rawViaWinJobLauncher's error handler to the round-2 shape (always markWinJobLauncherSpawnFailed
    // + fall back, with no spawnedOk gate at all) and re-ran this exact case — it genuinely failed on
    // both "no fallback git spawn" (the fallback DID run, calls became "launcher-run,git") and
    // "availability cache is UNCHANGED" (it flipped to false), proving this case is a real behavioral
    // test and not a vacuous one. Restored the real fix immediately after and re-confirmed GREEN.
    {
      setWinJobLauncherOverrideForTest(dummyLauncherPath);
      const calls = [];
      const fakeSpawn = makeFakeSpawn(dummyLauncherPath, {
        onLauncherRun: (child) => {
          calls.push("launcher-run");
          setImmediate(() => {
            child.emit("spawn"); // the process genuinely started
            setImmediate(() => child.emit("error", Object.assign(new Error("simulated EPERM on kill"), { code: "EPERM" })));
          });
        },
        onGit: (child) => {
          calls.push("git"); // must NEVER fire — asserted below
          setImmediate(() => child.emit("close", 0));
        },
      });
      const controller = new AbortController();
      const { raw } = spawnCanonicalGitTree("C:\\fake\\repo", undefined, controller.signal, 5000, undefined, fakeSpawn);
      const availabilityBefore = isWinJobLauncherAvailable();
      let threw = null;
      try { await raw(["commit", "--allow-empty", "-m", "error-after-spawn case"]); } catch (e) { threw = e; }
      check("error-after-spawn: rejects", threw !== null);
      check("error-after-spawn: treeDeathUnconfirmed", threw !== null && treeDeathUnconfirmed(threw));
      check("error-after-spawn: NOT treeDeathConfirmed", threw !== null && !treeDeathConfirmed(threw));
      check("error-after-spawn: exactly one spawn call (the launcher) — NO fallback git spawn", calls.join(",") === "launcher-run");
      check("error-after-spawn: availability cache is UNCHANGED (never flipped for a post-spawn error)", isWinJobLauncherAvailable() === availabilityBefore);
    }
  } finally {
    setWinJobLauncherOverrideForTest(undefined); // clear the override — resumes checking the real path
  }

  console.log(failures === 0 ? "\n✅ ALL PASS" : `\n❌ ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

run();
