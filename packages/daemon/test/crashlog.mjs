// Deterministic regression guard for the top-level fatal-exit crash handler (src/crashlog.ts). A real
// daemon crash once left NO log signature at all; this asserts that a fatal now ALWAYS leaves a
// diagnosable crashlog under LOOM_HOME with the required fields — exercised both directly and through
// the real installed process handlers (in a forked child, so the handler's process.exit can run for real).
//
// RUN (no daemon, no real claude): node test/crashlog.mjs
//   Requires the daemon built first (reads ../dist/crashlog.js): from packages/daemon run `pnpm build`.
import "./_guard.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";

const __filename = fileURLToPath(import.meta.url);

// ───────────────────────── CHILD MODE ─────────────────────────
// When CRASH_SCENARIO is set we are a forked child: install the REAL handlers and force the named fatal.
// LOOM_HOME (and thus the crashlog path) is supplied by the parent via env.
const scenario = process.env.CRASH_SCENARIO;
if (scenario) {
  const { installCrashHandlers } = await import("../dist/crashlog.js");
  installCrashHandlers();
  if (scenario === "uncaught") {
    setImmediate(() => { throw new Error("child uncaught boom"); });
  } else if (scenario === "rejection") {
    setImmediate(() => { Promise.reject(new Error("child rejection boom")); });
  } else if (scenario === "exit-nonzero") {
    process.exit(2); // routes through the synchronous `exit` hook backstop
  } else if (scenario === "exit-clean") {
    process.exit(0); // a clean stop is NOT a crash — no crashlog expected
  } else if (scenario === "exit-restart") {
    process.exit(75); // the restart sentinel is intentional — no crashlog expected
  }
  // Keep the event loop alive for the async scenarios until the handler exits the process.
  setTimeout(() => process.exit(0), 5000);
} else {
  // ───────────────────────── PARENT MODE ─────────────────────────
  let failures = 0;
  const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

  const tmpRoots = [];
  const freshHome = (tag) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `loom-crashlog-${tag}-`));
    tmpRoots.push(home);
    return home;
  };

  // Spawn this same file as a child with the given scenario + its own LOOM_HOME; return { code, home }.
  const runChild = (tag, sc) => {
    const home = freshHome(tag);
    const r = spawnSync(process.execPath, [__filename], {
      env: { ...process.env, CRASH_SCENARIO: sc, LOOM_HOME: home },
      encoding: "utf8",
      timeout: 30_000,
    });
    return { code: r.status, home, stderr: r.stderr || "" };
  };
  const readCrashlog = (home) => {
    const p = path.join(home, "crash.log");
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, "utf8");
    return { raw, json: JSON.parse(raw) };
  };

  try {
    // ── A: direct in-process writeCrashlog → a non-empty record with every diagnostic field ─────────
    {
      const home = freshHome("direct");
      process.env.LOOM_HOME = home; // crashlog.js computes CRASHLOG_PATH from LOOM_HOME at import time
      requireHermeticEnv();
      const { writeCrashlog, CRASHLOG_PATH } = await import("../dist/crashlog.js");
      check("direct: CRASHLOG_PATH resolves under the (temp) LOOM_HOME", CRASHLOG_PATH.startsWith(home));
      writeCrashlog({ kind: "uncaughtException", error: new Error("direct boom") });
      const got = readCrashlog(home);
      check("direct: a non-empty crashlog file was written", !!got && got.raw.trim().length > 0);
      const rec = got?.json ?? {};
      check("direct: captured the exception message + stack", rec.error?.message === "direct boom" && typeof rec.error?.stack === "string" && rec.error.stack.length > 0);
      check("direct: kind recorded", rec.kind === "uncaughtException");
      check("direct: active-watcher count field present (number or null)", "activeWatcherCount" in rec && (rec.activeWatcherCount === null || typeof rec.activeWatcherCount === "number"));
      check("direct: active-resource breakdown present", "activeResourceCounts" in rec);
      check("direct: open-FD count field present (number or null)", "openFdCount" in rec && (rec.openFdCount === null || typeof rec.openFdCount === "number"));
      check("direct: memory snapshot present", !!rec.memory && typeof rec.memory.rss === "number");
      check("direct: pid + node version recorded", typeof rec.pid === "number" && typeof rec.nodeVersion === "string");
      // The module's write-once guard means a second call must NOT clobber the first record.
      writeCrashlog({ kind: "exit", error: new Error("second should be ignored") });
      const after = readCrashlog(home);
      check("direct: second writeCrashlog is a no-op (write-once)", after?.json?.error?.message === "direct boom");
    }

    // ── B: real installed handler — an UNCAUGHT EXCEPTION in a child writes the crashlog + exits 1 ──
    {
      const { code, home, stderr } = runChild("uncaught", "uncaught");
      const got = readCrashlog(home);
      check("uncaught: child exited non-zero (1)", code === 1);
      check("uncaught: crashlog written by the real handler", !!got && got.json.kind === "uncaughtException");
      check("uncaught: crashlog captured the message", got?.json?.error?.message === "child uncaught boom");
      // The crashlog COMPLEMENTS the console trace — the stack must still reach stderr (Node's default
      // print is suppressed once a listener is attached, so the handler logs it itself).
      check("uncaught: stack still printed to stderr with the [crashlog] prefix", stderr.includes("[crashlog] fatal uncaughtException:"));
    }

    // ── C: real installed handler — an UNHANDLED REJECTION in a child writes the crashlog + exits 1 ──
    {
      const { code, home, stderr } = runChild("rejection", "rejection");
      const got = readCrashlog(home);
      check("rejection: child exited non-zero (1)", code === 1);
      check("rejection: crashlog written by the real handler", !!got && got.json.kind === "unhandledRejection");
      check("rejection: reason still printed to stderr with the [crashlog] prefix", stderr.includes("[crashlog] fatal unhandledRejection:"));
    }

    // ── D: exit-hook backstop — a stray non-zero process.exit writes a crashlog ──────────────────────
    {
      const { code, home } = runChild("exitnz", "exit-nonzero");
      const got = readCrashlog(home);
      check("exit-nonzero: child exited with the requested code (2)", code === 2);
      check("exit-nonzero: exit-hook backstop wrote a crashlog", !!got && got.json.kind === "exit" && got.json.exitCode === 2);
    }

    // ── E: a CLEAN exit (0) is not a crash — no crashlog ─────────────────────────────────────────────
    {
      const { code, home } = runChild("clean", "exit-clean");
      check("exit-clean: child exited 0", code === 0);
      check("exit-clean: NO crashlog written (clean stop is not a crash)", readCrashlog(home) === null);
    }

    // ── F: the restart sentinel (75) is intentional — no crashlog ────────────────────────────────────
    {
      const { code, home } = runChild("restart", "exit-restart");
      check("exit-restart: child exited 75", code === 75);
      check("exit-restart: NO crashlog written (restart sentinel is not a crash)", readCrashlog(home) === null);
    }

    // ── G: boot-time crash.log rotation (the SHIPPED, supervisor-less daemon path) ────────────────────
    // installCrashHandlers must rotate a PRE-EXISTING crash.log → crash.log.prev at boot, BEFORE any new
    // crash record can be written, so a crash→auto-restart preserves the prior signature.
    // NOTE: crashlog.js caches CRASHLOG_PATH from LOOM_HOME at its FIRST import (section A's home), so a
    // re-import does NOT repoint it — operate against the module's exported paths and clear them first.
    {
      const { rotateCrashlog, CRASHLOG_PATH, CRASHLOG_PREV_PATH } = await import("../dist/crashlog.js");
      fs.rmSync(CRASHLOG_PATH, { force: true });
      fs.rmSync(CRASHLOG_PREV_PATH, { force: true });
      const readPrev = () => (fs.existsSync(CRASHLOG_PREV_PATH) ? fs.readFileSync(CRASHLOG_PREV_PATH, "utf8") : null);

      // No crash.log present → idempotent no-op, never throws, leaves no .prev.
      let threw = false;
      try { rotateCrashlog(); } catch { threw = true; }
      check("rotate: no crash.log → no-op, does not throw", !threw);
      check("rotate: no crash.log → no .prev created", !fs.existsSync(CRASHLOG_PATH) && !fs.existsSync(CRASHLOG_PREV_PATH));

      // A pre-existing crash.log is moved to crash.log.prev (content preserved verbatim).
      fs.mkdirSync(path.dirname(CRASHLOG_PATH), { recursive: true });
      fs.writeFileSync(CRASHLOG_PATH, "FIRST-CRASH");
      rotateCrashlog();
      check("rotate: crash.log moved to crash.log.prev", !fs.existsSync(CRASHLOG_PATH) && readPrev() === "FIRST-CRASH");

      // A second crash.log rotates over the older .prev (keeps the last two, drops the oldest).
      fs.writeFileSync(CRASHLOG_PATH, "SECOND-CRASH");
      rotateCrashlog();
      check("rotate: newer crash.log overwrites older .prev", !fs.existsSync(CRASHLOG_PATH) && readPrev() === "SECOND-CRASH");

      // Idempotent: rotating again with no crash.log is a harmless no-op and does NOT touch the .prev —
      // this is the supervisor-interaction guarantee (supervisor pre-rotated; daemon boot finds no crash.log).
      rotateCrashlog();
      check("rotate: re-run with no crash.log preserves .prev (no double-rotation)", readPrev() === "SECOND-CRASH");
    }

    // ── H: a crash→restart cycle preserves the prior crash as .prev (end-to-end, real handlers) ───────
    // Crash a child (writes crash.log via the real handler), then crash a SECOND child sharing the SAME
    // LOOM_HOME: its installCrashHandlers must rotate the first crash to .prev before writing the second.
    {
      const home = freshHome("cycle");
      const run = (sc) => spawnSync(process.execPath, [__filename], {
        env: { ...process.env, CRASH_SCENARIO: sc, LOOM_HOME: home }, encoding: "utf8", timeout: 30_000,
      });
      run("uncaught"); // first crash → crash.log
      const first = readCrashlog(home);
      check("cycle: first crash wrote crash.log", first?.json?.error?.message === "child uncaught boom");
      run("uncaught"); // second crash → boot rotation moves first to .prev, then writes a fresh crash.log
      const prevPath = path.join(home, "crash.log.prev");
      const prev = fs.existsSync(prevPath) ? JSON.parse(fs.readFileSync(prevPath, "utf8")) : null;
      const current = readCrashlog(home);
      check("cycle: prior crash preserved as crash.log.prev", prev?.error?.message === "child uncaught boom");
      check("cycle: current crash.log still present after rotation", current?.json?.kind === "uncaughtException");
    }
  } finally {
    for (const root of tmpRoots) {
      for (let i = 0; i < 5; i++) { try { fs.rmSync(root, { recursive: true, force: true }); break; } catch { /* retry (Windows WAL/handle) */ } }
    }
  }

  console.log(failures === 0
    ? "\n✅ ALL PASS — a fatal always leaves a diagnosable crashlog; clean/restart exits do not."
    : `\n❌ ${failures} FAILURE(S).`);
  process.exit(failures === 0 ? 0 : 1);
}
