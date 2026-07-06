// Deterministic regression guard for the shutdown-reason marker (src/shutdown-marker.ts). A signal-driven
// daemon stop (SIGINT/SIGTERM/SIGHUP) used to leave NO trace at all — crash.log only fires on a fatal, and
// a signal stop exits 0 (clean, by design) — so it was indistinguishable from a hard crash after the fact.
// This asserts the marker-writer always leaves a diagnosable record, distinguishes an unexpected signal
// from an intentional (owner-initiated) stop, never throws, and never touches crash.log / restart-intent.json.
//
// RUN (no daemon, no real claude): node test/shutdown-marker.mjs
//   Requires the daemon built first (reads ../dist/shutdown-marker.js): from packages/daemon run `pnpm build`.
import "./_guard.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";

const __filename = fileURLToPath(import.meta.url);

// ───────────────────────── CHILD MODE ─────────────────────────
// shutdown-marker.js caches LAST_SHUTDOWN_PATH from LOOM_HOME at its FIRST import (mirrors crashlog.ts's
// own CRASHLOG_PATH caching — see crashlog.mjs section G's note), so exercising it against a FRESH,
// per-scenario LOOM_HOME needs a fresh process, not a re-import in the same one.
const scenario = process.env.MARKER_SCENARIO;
if (scenario) {
  const { writeShutdownMarker } = await import("../dist/shutdown-marker.js");
  if (scenario === "signal") {
    writeShutdownMarker({ kind: "signal", reason: "SIGINT", signal: "SIGINT" });
  } else if (scenario === "intentional") {
    writeShutdownMarker({ kind: "intentional", reason: "POST /internal/shutdown", signal: null });
  } else if (scenario === "overwrite") {
    writeShutdownMarker({ kind: "signal", reason: "SIGTERM", signal: "SIGTERM" });
    writeShutdownMarker({ kind: "intentional", reason: "POST /internal/shutdown", signal: null });
  } else if (scenario === "unwritable") {
    // LOOM_HOME (env, set by the parent) points under a FILE, not a dir — mkdirSync(recursive) must fail;
    // the writer must swallow it, and this child must still exit 0 (never throw/crash).
    writeShutdownMarker({ kind: "signal", reason: "SIGHUP", signal: "SIGHUP" });
  } else if (scenario === "no-clobber") {
    writeShutdownMarker({ kind: "signal", reason: "SIGTERM", signal: "SIGTERM" });
  }
  process.exit(0);
} else {
  // ───────────────────────── PARENT MODE ─────────────────────────
  let failures = 0;
  const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

  const tmpRoots = [];
  const freshHome = (tag) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `loom-shutdownmarker-${tag}-`));
    tmpRoots.push(home);
    return home;
  };
  const runChild = (tag, sc, homeOverride) => {
    const home = homeOverride ?? freshHome(tag);
    const r = spawnSync(process.execPath, [__filename], {
      env: { ...process.env, MARKER_SCENARIO: sc, LOOM_HOME: home },
      encoding: "utf8",
      timeout: 30_000,
    });
    return { code: r.status, home, stderr: r.stderr || "" };
  };
  const readMarker = (home) => {
    const p = path.join(home, "last-shutdown.json");
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  };

  try {
    // ── A: direct in-process writeShutdownMarker → a well-formed "signal" record ─────────────────────
    {
      const home = freshHome("direct");
      process.env.LOOM_HOME = home; // shutdown-marker.js computes LAST_SHUTDOWN_PATH from LOOM_HOME at import time
      requireHermeticEnv();
      const { writeShutdownMarker, LAST_SHUTDOWN_PATH } = await import("../dist/shutdown-marker.js");
      check("direct: LAST_SHUTDOWN_PATH resolves under the (temp) LOOM_HOME", LAST_SHUTDOWN_PATH.startsWith(home));
      writeShutdownMarker({ kind: "signal", reason: "SIGINT", signal: "SIGINT" });
      const rec = readMarker(home);
      check("direct: marker file was written", !!rec);
      check("direct: reason recorded as 'signal'", rec?.reason === "signal");
      check("direct: signal name recorded", rec?.signal === "SIGINT");
      check("direct: detail carries the raw reason string", rec?.detail === "SIGINT");
      check("direct: a valid ISO timestamp is present", typeof rec?.at === "string" && !Number.isNaN(Date.parse(rec.at)));
      check("direct: pid recorded", typeof rec?.pid === "number");
    }

    // ── B: real child process — an unexpected OS signal writes a "signal" marker ────────────────────
    {
      const { code, home } = runChild("signal", "signal");
      const rec = readMarker(home);
      check("signal: child exited cleanly (0)", code === 0);
      check("signal: reason recorded as 'signal'", rec?.reason === "signal");
      check("signal: signal name recorded", rec?.signal === "SIGINT");
    }

    // ── C: real child process — an intentional owner-initiated stop is recorded distinctly ──────────
    {
      const { code, home } = runChild("intentional", "intentional");
      const rec = readMarker(home);
      check("intentional: child exited cleanly (0)", code === 0);
      check("intentional: reason recorded as 'intentional', NOT 'signal'", rec?.reason === "intentional");
      check("intentional: no signal name recorded", rec?.signal === null);
      check("intentional: detail carries the raw reason string", rec?.detail === "POST /internal/shutdown");
    }

    // ── D: the marker is overwritten by the MOST RECENT call (no write-once guard, unlike crashlog) ──
    {
      const { code, home } = runChild("overwrite", "overwrite");
      const rec = readMarker(home);
      check("overwrite: child exited cleanly (0)", code === 0);
      check("overwrite: the SECOND call's record wins (most-recent-shutdown semantics)", rec?.reason === "intentional" && rec?.signal === null);
    }

    // ── E: the writer never throws, even when the directory cannot be created ───────────────────────
    {
      const home = freshHome("unwritable-outer");
      const blockerFile = path.join(home, "blocker");
      fs.writeFileSync(blockerFile, "not a directory");
      const badHome = path.join(blockerFile, "loom-home-under-a-file");
      const { code, stderr } = runChild("unwritable", "unwritable", badHome);
      check("unwritable: child still exits cleanly (0) — writeShutdownMarker swallowed the mkdir failure", code === 0);
      check("unwritable: no uncaught exception surfaced on stderr", !stderr.includes("Error"));
    }

    // ── F: writing the shutdown marker never creates/touches crash.log or restart-intent.json ───────
    {
      const home = freshHome("no-clobber");
      // Pre-seed crash.log + restart-intent.json BEFORE the marker write, so we can assert both that the
      // marker doesn't create them fresh (a clean home) and doesn't clobber pre-existing ones.
      fs.writeFileSync(path.join(home, "crash.log"), "PRE-EXISTING-CRASH");
      fs.writeFileSync(path.join(home, "restart-intent.json"), "PRE-EXISTING-INTENT");
      const { code } = runChild("no-clobber", "no-clobber", home);
      check("no-clobber: child exited cleanly (0)", code === 0);
      check("no-clobber: pre-existing crash.log is untouched", fs.readFileSync(path.join(home, "crash.log"), "utf8") === "PRE-EXISTING-CRASH");
      check("no-clobber: pre-existing restart-intent.json is untouched", fs.readFileSync(path.join(home, "restart-intent.json"), "utf8") === "PRE-EXISTING-INTENT");
      check("no-clobber: the shutdown marker itself lives at last-shutdown.json", fs.existsSync(path.join(home, "last-shutdown.json")));
    }
  } finally {
    for (const root of tmpRoots) {
      for (let i = 0; i < 5; i++) { try { fs.rmSync(root, { recursive: true, force: true }); break; } catch { /* retry (Windows WAL/handle) */ } }
    }
  }

  console.log(failures === 0
    ? "\n✅ ALL PASS — a signal/intentional stop always leaves a diagnosable shutdown marker; crash.log/restart-intent.json are untouched."
    : `\n❌ ${failures} FAILURE(S).`);
  process.exit(failures === 0 ? 0 : 1);
}
