// Regression guard for card 3fba0cd2 — a REAL daemon has crashed twice on an `EPIPE` when its stdout
// pipe was severed (once from a live node-pty event handler, nowhere near shutdown). Node treats an
// unhandled `"error"` event on an EventEmitter as fatal, so it reaches `uncaughtException` and kills the
// whole process. `installEpipeTolerantStdio` (src/crashlog.ts) guards against this.
//
// ⚠️ WHY THIS FILE USES A REAL SEVERED PIPE, NOT A `process.stdout.write = () => { throw }` OVERRIDE:
// an earlier draft of this fix used that override technique and it is a FALSE POSITIVE — Node's global
// `console.log()` swallows a throw from a plain overridden `write` property UNCONDITIONALLY (regardless
// of error code, with or without the fix installed), so a test built on it can never actually exercise
// the real code path and would report a false "PASS" no matter what. The card's own accepted analysis
// also claimed the observed crash was a SYNCHRONOUS throw out of `Writable.write`, and therefore that a
// `.on("error")` listener "would NOT have caught the real failure" — that claim was checked against a
// REAL severed pipe (spawn a child, `child.stdout.destroy()` the read end from the parent, have the
// child `console.log()`) and is WRONG: against a real `net.Socket`-backed stdout, `.write()` returns
// normally and the failure surfaces later as an ASYNC `"error"` event — the write-wrapper alone does NOT
// prevent the crash; the `.on("error")` listener is the half that actually fires. See
// docs/decisions/3fba0cd2-epipe-tolerant-stdio-wraps-write-not-console.md for the full corrective record.
// This file's "real-pipe" scenarios reproduce the ACTUAL production crash shape end to end, including an
// ablation (write-wrapper only) that pins that finding down as a regression guard, not just a narrative.
//
// RUN (no daemon, no real claude): node test/epipe-tolerant-stdio.mjs
//   Requires the daemon built first (reads ../dist/crashlog.js, ../dist/index.js).
import "./_guard.mjs";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

const __filename = fileURLToPath(import.meta.url);

const realPipeScenario = process.env.EPIPE_REAL_SCENARIO; // "none" | "write-wrapper" | "both"
const errEventScenario = process.env.EPIPE_ERR_EVENT_SCENARIO; // "epipe" | "non-epipe"

if (realPipeScenario) {
  // ───────────────────────── CHILD MODE (real severed pipe) ─────────────────────────
  // Local re-implementation of the two guards (not imported from dist) so each can be installed in
  // ISOLATION for the ablation below — the real export always installs both together.
  function installWriteWrapperOnly() {
    for (const stream of [process.stdout, process.stderr]) {
      const original = stream.write.bind(stream);
      stream.write = (...args) => {
        try { return original(...args); }
        catch (err) { if (err?.code === "EPIPE") return false; throw err; }
      };
    }
  }

  const marker = process.env.LOOM_HOME_MARKER;
  if (realPipeScenario === "both") {
    const { installEpipeTolerantStdio } = await import("../dist/crashlog.js");
    installEpipeTolerantStdio();
  } else if (realPipeScenario === "write-wrapper") {
    installWriteWrapperOnly();
  } // "none" installs nothing

  // Poll for the "go" marker — the parent writes it only AFTER destroying our stdout pipe's read end, so
  // this is an anchored wait on a real precondition, not a fixed sleep standing in for one.
  while (!fs.existsSync(marker)) {
    await new Promise((r) => setTimeout(r, 20));
  }
  for (let i = 0; i < 15; i++) {
    console.log(`iteration ${i}`);
    fs.writeFileSync(`${marker}.ok${i}`, "1");
    await new Promise((r) => setTimeout(r, 15));
  }
  fs.writeFileSync(`${marker}.done`, "1");
  process.exit(0);
} else if (errEventScenario) {
  // ───────────────────────── CHILD MODE (synthetic error-event negative control) ─────────────────────────
  // A REAL non-EPIPE OS write failure on stdout isn't reproducible on demand, so this scenario drives the
  // installed `.on("error")` listener directly via a synthetic `stream.emit("error", …)` — clearly a
  // controlled unit check on the listener's error-CODE scoping, not a claim of reproducing a real fault.
  const { installCrashHandlers, installEpipeTolerantStdio } = await import("../dist/crashlog.js");
  installEpipeTolerantStdio();
  installCrashHandlers();
  const home = process.env.LOOM_HOME;
  const sentinel = path.join(home, "after-emit.marker");
  setImmediate(() => {
    const err = new Error(errEventScenario === "epipe" ? "EPIPE: broken pipe, write" : "boom: not an EPIPE");
    err.code = errEventScenario === "epipe" ? "EPIPE" : "EBOOM";
    process.stdout.emit("error", err);
    fs.writeFileSync(sentinel, "1");
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000);
} else {
  // ───────────────────────── PARENT MODE ─────────────────────────
  let failures = 0;
  const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

  // Spawns this file as a child with its stdout PIPED, then destroys the read end of that pipe
  // IMMEDIATELY (before the child does anything) — a real severed pipe, matching both production
  // specimens' exact crash stack, not a synthetic write override.
  async function runRealPipe(tag, mode) {
    const dir = mkdtempManaged(`loom-epipe-realpipe-${tag}-`);
    const marker = path.join(dir, "go");
    const child = spawn(process.execPath, [__filename], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, EPIPE_REAL_SCENARIO: mode, LOOM_HOME_MARKER: marker },
    });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    const exitPromise = new Promise((resolve) => {
      let info = null;
      child.on("exit", (code, signal) => { info = { code, signal }; });
      child.on("close", () => resolve(info));
    });
    child.stdout.destroy(); // sever the read end — the child's next write(s) will fail
    fs.writeFileSync(marker, "1"); // now let the child proceed
    const exitInfo = await exitPromise;
    const okCount = fs.readdirSync(dir).filter((f) => /\.ok\d+$/.test(f)).length;
    const done = fs.existsSync(`${marker}.done`);
    return { ...exitInfo, okCount, done, stderr };
  }

  const runErrEvent = (tag, sc) => {
    const home = mkdtempManaged(`loom-epipe-errevt-${tag}-`);
    const r = spawnSync(process.execPath, [__filename], {
      env: { ...process.env, EPIPE_ERR_EVENT_SCENARIO: sc, LOOM_HOME: home },
      encoding: "utf8",
      timeout: 30_000,
    });
    return {
      code: r.status,
      sentinelWritten: fs.existsSync(path.join(home, "after-emit.marker")),
      crashLog: fs.existsSync(path.join(home, "crash.log")),
    };
  };

  // ════════ (RED) real-pipe, no fix: the identical severed pipe IS fatal ════════
  {
    const r = await runRealPipe("red", "none");
    check("(RED) real-pipe/none: child crashes (exit !== 0) — proves this harness CAN fail", r.code !== 0);
    check("(RED) real-pipe/none: fewer than all 15 iterations completed", r.okCount < 15);
    check("(RED) real-pipe/none: reproduces the real crash's exact stack shape",
      /Socket\._write/.test(r.stderr) && /Writable\.write/.test(r.stderr) && /console\.log/.test(r.stderr) && /EPIPE/.test(r.stderr));
  }

  // ════════ real-pipe, write-wrapper ALONE: still fatal — pins the corrected finding down ════════
  {
    const r = await runRealPipe("wrapper-only", "write-wrapper");
    check("real-pipe/write-wrapper-only: STILL crashes against a real severed pipe (regression guard for the corrected finding)", r.code !== 0);
    check("real-pipe/write-wrapper-only: fewer than all 15 iterations completed", r.okCount < 15);
    // Not just "it crashed" — it crashed for the SAME reason this test exists to pin down (an unrelated
    // typo in the local wrapper copy above would also crash, and would also satisfy the two checks above).
    check("real-pipe/write-wrapper-only: crashed via the same EPIPE / Socket._write stack as the no-guard arm",
      /Socket\._write/.test(r.stderr) && /Writable\.write/.test(r.stderr) && /console\.log/.test(r.stderr) && /EPIPE/.test(r.stderr));
  }

  // ════════ (GREEN) real-pipe, both guards (the shipped fix): survives ════════
  {
    const r = await runRealPipe("green", "both");
    check("(GREEN) real-pipe/both: child exits cleanly (0)", r.code === 0);
    check("(GREEN) real-pipe/both: ALL 15 iterations completed despite the severed pipe", r.okCount === 15 && r.done);
    check("(GREEN) real-pipe/both: nothing escaped to stderr as an uncaught exception", !/uncaughtException/i.test(r.stderr));
  }

  // ════════ error-event negative control: the listener's swallow is EPIPE-specific ════════
  {
    const r = runErrEvent("epipe", "epipe");
    check("error-event/epipe: child exits cleanly (0)", r.code === 0);
    check("error-event/epipe: code after the emit DID run", r.sentinelWritten === true);
    check("error-event/epipe: NO crash.log written", r.crashLog === false);
  }
  {
    const r = runErrEvent("nonepipe", "non-epipe");
    check("error-event/non-epipe: child still crashes (exit 1) — the swallow does not widen past EPIPE", r.code === 1);
    check("error-event/non-epipe: code after the emit never ran", r.sentinelWritten === false);
    check("error-event/non-epipe: a crash.log records the non-EPIPE error", r.crashLog === true);
  }

  // ════════ wiring: the REAL built main() calls installEpipeTolerantStdio() before installCrashHandlers() ════════
  {
    const indexJs = fs.readFileSync(new URL("../dist/index.js", import.meta.url), "utf8");
    const wrapperIdx = indexJs.indexOf("installEpipeTolerantStdio(");
    const handlersCallIdx = indexJs.indexOf("installCrashHandlers();");
    check("wiring: dist/index.js calls installEpipeTolerantStdio()", wrapperIdx !== -1);
    check("wiring: dist/index.js calls installCrashHandlers()", handlersCallIdx !== -1);
    check("wiring: installEpipeTolerantStdio() runs BEFORE the installCrashHandlers() call", wrapperIdx !== -1 && handlersCallIdx !== -1 && wrapperIdx < handlersCallIdx);
  }

  console.log(failures === 0
    ? "\n✅ ALL PASS — a real severed stdout pipe is fatal without the fix, STILL fatal with only the write-wrapper half, and survives with both guards installed; the listener's swallow stays EPIPE-specific; the real build wires the fix before the crash handlers."
    : `\n❌ ${failures} FAILURE(S).`);
  await finishAndExit(failures === 0 ? 0 : 1);
}
