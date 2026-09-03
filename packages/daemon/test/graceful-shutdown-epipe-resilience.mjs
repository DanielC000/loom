// Fail-first regression test for card 7f9444f3 — a REAL crash on this host showed the LAST console.log
// inside gracefulShutdown (index.ts), the line immediately before the merge-danger-aware exit board card
// 5a7692a4 added, throwing "EPIPE: broken pipe, write" (a destroyed stdout — Node emits SIGHUP for the
// Windows-console-close case, which is exactly when stdout is already gone). That throw:
//   (a) skipped `waitForMergeDangerWindowsToClear()` entirely — reopening the ~92s-margin mid-canonical-
//       merge-squash hazard card 5a7692a4 exists to prevent, and
//   (b) escaped as an `uncaughtException`, turning a clean signal-driven stop into a fatal crash that
//       writes a phantom crash.log (misread by the next boot as `[loom:crash-recovered]`).
//
// Verified against `git show HEAD` BEFORE this card's fix landed: the pre-fix `gracefulShutdown` body had
// exactly `console.log(...)` immediately followed by (only a comment, then)
// `void waitForMergeDangerWindowsToClear().finally(() => { process.exit(0); ... })`, with NO try/catch
// anywhere around either — i.e. the "legacy-unguarded" scenario below is not a strawman, it is that real
// shape, reproduced with a REAL `console.Console` over a writable that throws EPIPE on `.write()` (so the
// throw comes from an actual `console.log()` call, not a hand-rolled `throw`).
//
// This file proves BOTH directions:
//   (RED)   "legacy-unguarded" mirrors the pre-fix shape and demonstrably fails DoD-1/DoD-2: the
//           merge-danger wait is never invoked, and a real crash.log gets written for what should read
//           as a clean stop.
//   (GREEN) "fixed" drives the ACTUAL shipped fix (`runGracefulTeardown`, dist/graceful-teardown.js)
//           through the identical throwing write and shows both properties now hold.
// A structural check then confirms the REAL built `gracefulShutdown` in dist/index.js actually delegates
// to `runGracefulTeardown` — so this isn't just proving the isolated helper works, it's proving
// production code is wired to it.
//
// RUN (no daemon, no real claude): node test/graceful-shutdown-epipe-resilience.mjs
//   Requires the daemon built first (reads ../dist/graceful-teardown.js, ../dist/crashlog.js, ../dist/index.js).
import "./_guard.mjs";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { gracefulShutdownRegion } from "./_graceful-region.mjs";

const __filename = fileURLToPath(import.meta.url);

// A `console.Console` over a writable whose `write()` throws — so calling `.log()` on it produces a REAL
// synchronous throw from inside `console.log`'s own machinery, exactly like the real crash's stack frame
// (`at console.value ... at console.log ... at gracefulShutdown`), not a hand-rolled `throw` standing in
// for it.
function makeEpipeConsole() {
  const throwingStream = {
    write() {
      throw new Error("EPIPE: broken pipe, write");
    },
  };
  return new console.Console(throwingStream, throwingStream);
}

const scenario = process.env.GT_SCENARIO;
if (scenario) {
  // ───────────────────────── CHILD MODE ─────────────────────────
  // installCrashHandlers wires the REAL uncaughtException/unhandledRejection/exit handlers (dist/crashlog.js)
  // — the same ones the real daemon installs at boot — so an escaped throw in this child behaves exactly
  // like it would in production: a written crash.log and exit(1).
  const { installCrashHandlers } = await import("../dist/crashlog.js");
  installCrashHandlers();

  const home = process.env.LOOM_HOME;
  const waitSentinel = path.join(home, "wait-invoked.marker");
  const exitSentinel = path.join(home, "exit-invoked.marker");

  // Both sentinels are written synchronously the instant each fn is CALLED (not when its promise
  // settles), so even a process death immediately afterward still leaves the marker on disk — sentinel
  // presence proves "was invoked", never "ran to completion".
  const waitFn = () => {
    fs.writeFileSync(waitSentinel, "1");
    return Promise.resolve();
  };
  const exitFn = () => {
    fs.writeFileSync(exitSentinel, "1");
    process.exit(0);
  };

  if (scenario === "legacy-unguarded") {
    // Mirrors the REAL pre-fix gracefulShutdown shape (see file header): an unguarded console.log
    // immediately followed by the merge-danger-aware exit, no try/catch anywhere. Dispatched via
    // setImmediate so the throw becomes a genuine ASYNC uncaught exception — exactly like a real signal
    // handler's callback throwing — rather than a synchronous throw this file's own top-level await
    // chain could happen to swallow.
    setImmediate(() => {
      const epipeConsole = makeEpipeConsole();
      epipeConsole.log("[shutdown] graceful stop (test)"); // throws EPIPE — the real crash's exact site
      void waitFn().finally(() => exitFn()); // never reached if the line above throws
    });
  } else if (scenario === "fixed") {
    const { runGracefulTeardown } = await import("../dist/graceful-teardown.js");
    const epipeConsole = makeEpipeConsole();
    runGracefulTeardown(
      () => {
        epipeConsole.log("[shutdown] graceful stop (test)"); // identical throwing site as legacy above
      },
      exitFn,
      waitFn,
    );
  } else {
    throw new Error(`unknown GT_SCENARIO: ${scenario}`);
  }
} else {
  // ───────────────────────── PARENT MODE ─────────────────────────
  let failures = 0;
  const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

  const runChild = (sc) => {
    const home = mkdtempManaged(`loom-gt-epipe-${sc}-`);
    const r = spawnSync(process.execPath, [__filename], {
      env: { ...process.env, GT_SCENARIO: sc, LOOM_HOME: home },
      encoding: "utf8",
      timeout: 30_000,
    });
    return {
      code: r.status,
      stderr: r.stderr || "",
      stdout: r.stdout || "",
      waitInvoked: fs.existsSync(path.join(home, "wait-invoked.marker")),
      exitInvoked: fs.existsSync(path.join(home, "exit-invoked.marker")),
      crashLogExists: fs.existsSync(path.join(home, "crash.log")),
    };
  };

  // ════════ (RED) legacy-unguarded: the pre-fix shape fails BOTH properties under EPIPE ════════
  {
    const r = runChild("legacy-unguarded");
    check("(RED) legacy-unguarded: the EPIPE throw is fatal (child does NOT exit 0)", r.code !== 0);
    check("(RED) legacy-unguarded: the merge-danger wait is NEVER invoked when the write throws (DoD-1 violated)",
      r.waitInvoked === false);
    check("(RED) legacy-unguarded: exit() is never reached either", r.exitInvoked === false);
    check("(RED) legacy-unguarded: a crash.log record IS written for what should be a clean stop (DoD-2 violated)",
      r.crashLogExists === true);
  }

  // ════════ (GREEN) fixed: the real runGracefulTeardown survives the identical throwing write ════════
  {
    const r = runChild("fixed");
    check("(GREEN) fixed: child exits cleanly (0)", r.code === 0);
    check("(a) fixed: the merge-danger wait IS invoked despite the teardown step throwing (DoD-1)",
      r.waitInvoked === true);
    check("(GREEN) fixed: exit() is reached after the wait settles", r.exitInvoked === true);
    check("(b) fixed: NO crash record is written for the EPIPE (DoD-2)", r.crashLogExists === false);
    check("(GREEN) fixed: nothing escapes to stderr as an uncaught exception",
      !/uncaughtException/i.test(r.stderr) && !/EPIPE/.test(r.stderr));
  }

  // ════════ wiring: the REAL built gracefulShutdown delegates to runGracefulTeardown ════════
  {
    const indexJs = fs.readFileSync(new URL("../dist/index.js", import.meta.url), "utf8");
    const region = gracefulShutdownRegion(indexJs);
    check("wiring: dist/index.js imports runGracefulTeardown", /runGracefulTeardown/.test(indexJs));
    check("wiring: the built gracefulShutdown body actually CALLS runGracefulTeardown (not just imports it)",
      /runGracefulTeardown\s*\(/.test(region));
    // The teardown steps (marker write, snapshot, vault flush, watcher .stop() calls, the final log) must
    // sit INSIDE the callback passed to runGracefulTeardown — i.e. before the region's clean-stop exit —
    // so they are actually covered by its try/catch, mirroring shutdown-snapshot.mjs's own ordering check.
    check("wiring: the final '[shutdown] graceful stop' log runs before the region's clean-stop exit",
      region.indexOf("[shutdown] graceful stop") < region.indexOf("process.exit(0)"));
  }

  console.log(failures === 0
    ? "\n✅ ALL PASS — the pre-fix shape (legacy-unguarded) demonstrably skips the merge-danger wait and writes a phantom crash.log under EPIPE; the shipped fix (runGracefulTeardown) survives the identical throwing write, always invokes the wait, always exits cleanly, and never writes a crash record — and the real built daemon is wired to that fix."
    : `\n❌ ${failures} FAILURE(S).`);
  await finishAndExit(failures === 0 ? 0 : 1);
}
