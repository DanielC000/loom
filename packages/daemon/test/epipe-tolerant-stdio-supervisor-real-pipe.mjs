// Regression guard for card 175a7eb2 — scripts/daemon-supervisor.mjs had NO EPIPE guard: it mirrors the
// daemon child's output via process.stdout.write/process.stderr.write and console.log's its own
// restart-loop lines, so a supervisor whose hosting console has died could crash on its next write —
// possibly the exact "[supervisor] daemon requested restart…" line it needs to print to relaunch the
// daemon. scripts/lib/epipe-tolerant-stdio.mjs (installed as the first statement in
// daemon-supervisor.mjs) guards against this — same shape as the daemon's own already-proven
// installEpipeTolerantStdio (packages/daemon/src/crashlog.ts, card 3fba0cd2), duplicated locally because
// the supervisor runs before the daemon package is even built.
//
// Same technique and same three-arm shape as packages/daemon/test/epipe-tolerant-stdio.mjs (see that
// file's own header for why a REAL severed pipe is used rather than a `process.stdout.write = () => {
// throw }` override — the override is a proven false positive, since Node's console.log() swallows a
// throw from a plain overridden write property unconditionally). This is a NEW file wiring a NEW guard
// into a NEW entrypoint, so the write-wrapper-only ablation arm is kept here too rather than relying
// solely on the parity test's text comparison to the already-ablation-tested daemon copy — it re-proves,
// against THIS copy, that the `.on("error")` listener (not the write-wrapper alone) is what's load-
// bearing.
//
// This file is NOT registered on either emit-compare reduced-gate scanner list: it spawns and imports
// scripts/lib/epipe-tolerant-stdio.mjs rather than raw-scanning its TEXT for a comment-flippable
// pattern, so a comment-only change there can't silently defeat this test the way the parity test's
// string-matching approach could.
//
// RUN (no daemon, no real claude): node test/epipe-tolerant-stdio-supervisor-real-pipe.mjs
// Hermetic and platform-independent: pure spawn + destroy-the-piped-read-end, the same technique
// test/epipe-tolerant-stdio.mjs already runs under both Windows and ubuntu-latest CI (not in
// scripts/test-daemon.mjs's NOT_HERMETIC set).
import "./_guard.mjs";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

const __filename = fileURLToPath(import.meta.url);
const libUrl = pathToFileURL(
  path.join(path.dirname(__filename), "..", "..", "..", "scripts", "lib", "epipe-tolerant-stdio.mjs"),
).href;

const scenario = process.env.EPIPE_SUPERVISOR_SCENARIO; // "none" | "write-wrapper" | "both"

if (scenario) {
  // ───────────────────────── CHILD MODE (real severed pipe) ─────────────────────────
  // Local write-wrapper-only re-implementation (not imported) so it can be installed in ISOLATION for
  // the ablation arm — the real export always installs both guards together.
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
  if (scenario === "both") {
    const { installEpipeTolerantStdio } = await import(libUrl);
    installEpipeTolerantStdio();
  } else if (scenario === "write-wrapper") {
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
} else {
  // ───────────────────────── PARENT MODE ─────────────────────────
  let failures = 0;
  const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

  // Spawns this file as a child with its stdout PIPED, then destroys the read end of that pipe
  // IMMEDIATELY (before the child does anything) — a real severed pipe, matching the daemon's own
  // production crash shape (test/epipe-tolerant-stdio.mjs), not a synthetic write override.
  async function runRealPipe(tag, mode) {
    const dir = mkdtempManaged(`loom-epipe-supervisor-realpipe-${tag}-`);
    const marker = path.join(dir, "go");
    const child = spawn(process.execPath, [__filename], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, EPIPE_SUPERVISOR_SCENARIO: mode, LOOM_HOME_MARKER: marker },
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

  // ════════ (RED) real-pipe, no guard: the severed pipe IS fatal — proves the harness CAN fail ════════
  {
    const r = await runRealPipe("red", "none");
    check("(RED) real-pipe/none: child crashes (exit !== 0) — proves this harness CAN fail", r.code !== 0);
    check("(RED) real-pipe/none: fewer than all 15 iterations completed", r.okCount < 15);
  }

  // ════════ real-pipe, write-wrapper ALONE: still fatal — pins the same corrected finding down for
  // THIS copy (not just inherited via the parity test's text comparison to the daemon's) ════════
  {
    const r = await runRealPipe("wrapper-only", "write-wrapper");
    check("real-pipe/write-wrapper-only: STILL crashes against a real severed pipe (the .on(\"error\") listener is the load-bearing half)", r.code !== 0);
    check("real-pipe/write-wrapper-only: fewer than all 15 iterations completed", r.okCount < 15);
  }

  // ════════ (GREEN) real-pipe, both guards (the shipped fix): survives ════════
  {
    const r = await runRealPipe("green", "both");
    check("(GREEN) real-pipe/both: child exits cleanly (0)", r.code === 0);
    check("(GREEN) real-pipe/both: ALL 15 iterations completed despite the severed pipe", r.okCount === 15 && r.done);
    check("(GREEN) real-pipe/both: nothing escaped to stderr as an uncaught exception", !/uncaughtException/i.test(r.stderr));
  }

  console.log(failures === 0
    ? "\n✅ ALL PASS — a real severed stdout pipe is fatal to the supervisor's write path without the fix, " +
      "STILL fatal with only the write-wrapper half, and survives with both guards installed."
    : `\n❌ ${failures} FAILURE(S).`);
  await finishAndExit(failures === 0 ? 0 : 1);
}
