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
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

const __filename = fileURLToPath(import.meta.url);

// Code Review (card 43b232ff): a REAL throw inside node-pty's own windowsPtyAgent module, used to derive
// the "nodepty-race*" scenarios' stack FRAME — never a hand-typed frame literal, which would assert our
// own chosen string against itself and could never fail under a source-map-rewriting runtime.
// `argsToCommandLine(undefined)` throws from `arg[0]` on an undefined arg — same established deep-require
// technique as test/node-pty-quoting-parity.mjs (card 9fea4196: node-pty's package.json has no `exports`
// field, so this resolves). Returns just the ONE frame line naming the module, in WHICHEVER filename the
// CURRENT runtime rendered (windowsPtyAgent.js under plain node, .ts under --enable-source-maps/tsx) — so
// the same scenario code is automatically correct under both without duplicating scenarios per runtime.
function realNodePtyFrame() {
  const require = createRequire(import.meta.url);
  const { argsToCommandLine } = require("node-pty/lib/windowsPtyAgent.js");
  try {
    argsToCommandLine(undefined);
  } catch (e) {
    const line = (e.stack ?? "").split("\n").find((l) => l.includes("windowsPtyAgent"));
    if (!line) throw new Error("realNodePtyFrame: no windowsPtyAgent frame in node-pty's own thrown stack — node-pty's internals changed, update this helper");
    return line;
  }
  throw new Error("realNodePtyFrame: argsToCommandLine(undefined) did not throw — node-pty's internals changed, update this helper");
}

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
  } else if (scenario === "nodepty-race") {
    // The EXACT tolerated shape. BOTH conditions are positive-controlled against REAL runtime output —
    // never a hand-typed literal on either axis (Code Review Major/Minor #2: the stack frame used to be
    // a hand-typed literal, which passed on every runtime including one where the real frame's filename
    // has been rewritten — see realNodePtyFrame's own doc). MESSAGE: `undefined.forEach(...)` — V8
    // authors it. STACK FRAME: node-pty's OWN `argsToCommandLine(undefined)` genuinely throws from
    // inside its windowsPtyAgent module; we lift just that one real frame line — in WHICHEVER filename
    // the CURRENT runtime rendered it — and graft it onto our genuinely-thrown message error. Run this
    // same scenario under plain node AND under --enable-source-maps (see the parent's "srcmaps" check):
    // the derived frame is automatically the right shape for each, no scenario duplication needed. If
    // tolerated, the child must still be ALIVE when the process.exit(0) fallback below fires — that IS
    // the assertion (no crashlog, no early exit).
    setImmediate(() => {
      let err;
      try {
        undefined.forEach(() => {});
      } catch (e) {
        err = e;
      }
      err.stack += "\n" + realNodePtyFrame();
      Promise.reject(err);
    });
    setTimeout(() => process.exit(0), 1500); // survives → exits 0 quickly; overrides the 5s fallback below
  } else if (scenario === "nodepty-race-wrong-message") {
    // NEAR MISS #1 — stack has a real node-pty frame but the message does NOT match. Must still crash:
    // the stack alone is not a safe match (some OTHER exception in that same node-pty module must stay
    // fatal). Genuinely thrown on both axes — a different undefined property read for the message, and
    // the same real node-pty frame-lifting technique as "nodepty-race" for the stack.
    setImmediate(() => {
      let err;
      try {
        let x;
        void x.somethingElse;
      } catch (e) {
        err = e;
      }
      err.stack += "\n" + realNodePtyFrame();
      Promise.reject(err);
    });
  } else if (scenario === "nodepty-race-wrong-stack") {
    // NEAR MISS #2 — message matches exactly but the stack does NOT name node-pty at all. Must still
    // crash: the message alone is not a safe match (an unrelated bug in OUR code with this exact message
    // must stay fatal). Genuinely thrown, stack left UNTOUCHED (it already points at this test file, not
    // node-pty — the most honest version of this control, no fabrication needed at all).
    setImmediate(() => {
      try {
        undefined.forEach(() => {});
      } catch (e) {
        Promise.reject(e);
        return;
      }
    });
  } else if (scenario === "nodepty-race-message-mentions-file") {
    // NEAR MISS #3 (Code Review Minor #1's literal counter-example) — the MESSAGE TEXT ITSELF contains
    // "windowsPtyAgent.js" (so a bare `.stack.includes("windowsPtyAgent")` substring search would
    // wrongly self-satisfy on the stack's own first line, which IS the message — `err.stack`'s line 0 is
    // always `${name}: ${message}`), but there is NO real stack FRAME naming node-pty anywhere below it.
    // Must still crash: proves the fixed regex requires an actual "at ..." frame line, not merely the
    // substring appearing anywhere in `.stack` — i.e. the message and stack conditions stay INDEPENDENT.
    // Deliberately a literal here (not a real throw): the whole point is a message CRAFTED to collide
    // with the file name, which a real throw could never produce without contrivance.
    setImmediate(() => {
      const err = new TypeError("loading windowsPtyAgent.js failed: Cannot read properties of undefined (reading 'forEach')");
      Promise.reject(err);
    });
  } else if (scenario === "fswatch-crash") {
    // card 34744200: open a REAL fs.watch (what fs.watch()/chokidar surface as `FSEventWrap`, not the
    // `FSWatcher`/`StatWatcher` the old predicate matched), then force a fatal so the crashlog's resource
    // snapshot captures it live — proves activeFsWatcherCount actually counts it, not just
    // fs.watchFile()'s StatWatcher.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-crashlog-fswatch-"));
    fs.watch(dir, () => {});
    setImmediate(() => { throw new Error("fswatch crash"); });
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

  const freshHome = (tag) => mkdtempManaged(`loom-crashlog-${tag}-`);

  // Spawn this same file as a child with the given scenario + its own LOOM_HOME + optional extra node
  // flags (e.g. --enable-source-maps); return { code, home, stderr }.
  const runChildWithFlags = (tag, sc, nodeFlags = []) => {
    const home = freshHome(tag);
    const r = spawnSync(process.execPath, [...nodeFlags, __filename], {
      env: { ...process.env, CRASH_SCENARIO: sc, LOOM_HOME: home },
      encoding: "utf8",
      timeout: 30_000,
    });
    return { code: r.status, home, stderr: r.stderr || "" };
  };
  const runChild = (tag, sc) => runChildWithFlags(tag, sc);
  const readCrashlog = (home) => {
    const p = path.join(home, "crash.log");
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, "utf8");
    return { raw, json: JSON.parse(raw) };
  };

  {
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
      check("direct: active-watcher count field present (number or null)", "activeFsWatcherCount" in rec && (rec.activeFsWatcherCount === null || typeof rec.activeFsWatcherCount === "number"));
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

    // ── B2: card 34744200 — a REAL fs.watch (FSEventWrap) must be counted by activeFsWatcherCount ──────
    // Regression guard for the false-zero: before the fix, the predicate only matched
    // FSWatcher/StatWatcher, so this assertion FAILED (activeFsWatcherCount stayed 0 against a live
    // fs.watch) — run fail-first against pre-fix code to confirm this check can actually go red.
    {
      const { code, home } = runChild("fswatch", "fswatch-crash");
      const got = readCrashlog(home);
      check("fswatch: child crashed as expected (exit 1)", code === 1);
      check(
        "fswatch: a live fs.watch is counted in activeFsWatcherCount",
        !!got && typeof got.json.activeFsWatcherCount === "number" && got.json.activeFsWatcherCount >= 1,
      );
      check(
        "fswatch: FSEventWrap present in the raw breakdown",
        !!got && (got.json.activeResourceCounts?.FSEventWrap ?? 0) >= 1,
      );
    }

    // ── C: real installed handler — an UNHANDLED REJECTION in a child writes the crashlog + exits 1 ──
    {
      const { code, home, stderr } = runChild("rejection", "rejection");
      const got = readCrashlog(home);
      check("rejection: child exited non-zero (1)", code === 1);
      check("rejection: crashlog written by the real handler", !!got && got.json.kind === "unhandledRejection");
      check("rejection: reason still printed to stderr with the [crashlog] prefix", stderr.includes("[crashlog] fatal unhandledRejection:"));
    }

    // ── C2: card 43b232ff — the node-pty ConPTY kill() race is TOLERATED, not fatal ──────────────────
    // Control (a): the exact classified shape survives — no crashlog, no non-zero exit, process keeps
    // running long enough to reach its own clean process.exit(0) fallback.
    {
      const { code, home, stderr } = runChild("nodepty-race", "nodepty-race");
      const got = readCrashlog(home);
      check("nodepty-race: child SURVIVED (exited 0 via its own fallback, not the handler)", code === 0);
      check("nodepty-race: NO crashlog written (tolerated, not a crash)", got === null);
      check("nodepty-race: tolerance still logged loudly to stderr", stderr.includes("[crashlog] tolerated known node-pty ConPTY kill() race"));
    }
    // Control (b), near-miss #1: stack matches node-pty's file but the MESSAGE does not — an unrelated
    // exception in that same module must stay fatal. RED-proofs that the match isn't stack-alone.
    {
      const { code, home, stderr } = runChild("nodepty-race-wrong-message", "nodepty-race-wrong-message");
      const got = readCrashlog(home);
      check("nodepty-race-wrong-message: child still CRASHED (exit 1)", code === 1);
      check("nodepty-race-wrong-message: crashlog written like any other unhandledRejection", !!got && got.json.kind === "unhandledRejection");
      check("nodepty-race-wrong-message: NOT classified as tolerated", !stderr.includes("tolerated known node-pty"));
    }
    // Control (b), near-miss #2: MESSAGE matches exactly but the stack does not name node-pty — an
    // unrelated bug in OUR OWN code with this exact message must stay fatal. RED-proofs that the match
    // isn't message-alone — this is the control that matters most (over-broad matching is the real risk).
    {
      const { code, home, stderr } = runChild("nodepty-race-wrong-stack", "nodepty-race-wrong-stack");
      const got = readCrashlog(home);
      check("nodepty-race-wrong-stack: child still CRASHED (exit 1)", code === 1);
      check("nodepty-race-wrong-stack: crashlog written like any other unhandledRejection", !!got && got.json.kind === "unhandledRejection");
      check("nodepty-race-wrong-stack: NOT classified as tolerated", !stderr.includes("tolerated known node-pty"));
    }
    // Control (b), near-miss #3 (Code Review Minor #1's literal counter-example): the MESSAGE text
    // itself contains "windowsPtyAgent.js" with no real stack frame naming node-pty anywhere. Must still
    // crash: proves the fixed regex requires an actual "at ..." frame line, not a bare substring search
    // over the whole .stack (which trivially includes the message on line 0) — i.e. the message and
    // stack conditions are genuinely independent, not just independently-worded.
    {
      const { code, home, stderr } = runChild("nodepty-race-message-mentions-file", "nodepty-race-message-mentions-file");
      const got = readCrashlog(home);
      check("nodepty-race-message-mentions-file: child still CRASHED (exit 1)", code === 1);
      check("nodepty-race-message-mentions-file: crashlog written like any other unhandledRejection", !!got && got.json.kind === "unhandledRejection");
      check("nodepty-race-message-mentions-file: NOT classified as tolerated", !stderr.includes("tolerated known node-pty"));
    }
    // Control (c), Code Review MAJOR: the EXACT same "nodepty-race" scenario run under
    // --enable-source-maps. node-pty ships a source map for windowsPtyAgent.js (sources:
    // ["../src/windowsPtyAgent.ts"]), so under this flag (and under `tsx`, `pnpm daemon`'s own dev
    // runner) the SAME real frame renders with a `.ts` filename instead of `.js`. A regex anchored to
    // the `.js` extension matches under plain node but SILENTLY never matches here — this is the
    // scenario that would have caught the "does nothing under `pnpm daemon`" defect before merge.
    {
      const { code, home, stderr } = runChildWithFlags("nodepty-race-srcmaps", "nodepty-race", ["--enable-source-maps"]);
      const got = readCrashlog(home);
      check("nodepty-race (--enable-source-maps): child SURVIVED (exited 0 via its own fallback)", code === 0);
      check("nodepty-race (--enable-source-maps): NO crashlog written (tolerated, not a crash)", got === null);
      check("nodepty-race (--enable-source-maps): tolerance still logged loudly to stderr", stderr.includes("[crashlog] tolerated known node-pty ConPTY kill() race"));
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

    // ── G: boot-time crash.log rotation (numbered generations, card 9c8ce2b2) ─────────────────────────
    // installCrashHandlers must rotate a PRE-EXISTING crash.log through numbered generations
    // (crash.log.1 newest .. crash.log.N oldest) at boot, BEFORE any new crash record can be written, so
    // a crash→auto-restart preserves the last N prior signatures, not just one (the old crash.log.prev
    // swap could only ever hold one — the exact gap this card fixes, see the card body for the incident).
    // NOTE: crashlog.js caches CRASHLOG_PATH from LOOM_HOME at its FIRST import (section A's home), so a
    // re-import does NOT repoint it — operate against the module's exported paths and clear them first.
    {
      const { rotateCrashlog, CRASHLOG_PATH, CRASHLOG_MAX_GENERATIONS, crashlogGenerationPath } =
        await import("../dist/crashlog.js");
      const clearAll = () => {
        fs.rmSync(CRASHLOG_PATH, { force: true });
        for (let g = 1; g <= CRASHLOG_MAX_GENERATIONS + 2; g++) {
          fs.rmSync(crashlogGenerationPath(g), { force: true, recursive: true });
        }
      };
      const readGen = (g) => (fs.existsSync(crashlogGenerationPath(g)) ? fs.readFileSync(crashlogGenerationPath(g), "utf8") : null);
      clearAll();

      check("rotate: CRASHLOG_MAX_GENERATIONS is 5 (card 9c8ce2b2's accepted N)", CRASHLOG_MAX_GENERATIONS === 5);

      // Cold start: no crash.log, no generations at all → idempotent no-op, never throws, creates nothing.
      let threw = false;
      try { rotateCrashlog(); } catch { threw = true; }
      check("rotate: cold start (no crash.log, no generations) → no-op, does not throw", !threw);
      let createdOnColdStart = false;
      for (let g = 1; g <= CRASHLOG_MAX_GENERATIONS; g++) if (fs.existsSync(crashlogGenerationPath(g))) createdOnColdStart = true;
      check("rotate: cold start creates no generation files", !createdOnColdStart);

      // Rotate N+2 crashes through — must retain exactly the last N, in newest-first order, oldest 2 dropped.
      fs.mkdirSync(path.dirname(CRASHLOG_PATH), { recursive: true });
      const totalCrashes = CRASHLOG_MAX_GENERATIONS + 2;
      for (let i = 1; i <= totalCrashes; i++) {
        fs.writeFileSync(CRASHLOG_PATH, `CRASH-${i}`);
        rotateCrashlog();
      }
      check("rotate: crash.log itself is gone after rotation (promoted to generation 1)", !fs.existsSync(CRASHLOG_PATH));
      let generationsOk = true;
      for (let g = 1; g <= CRASHLOG_MAX_GENERATIONS; g++) {
        if (readGen(g) !== `CRASH-${totalCrashes - g + 1}`) generationsOk = false;
      }
      check(`rotate: retains exactly the last ${CRASHLOG_MAX_GENERATIONS} generations, newest-first (crash.log.1=newest)`, generationsOk);
      check("rotate: the two oldest crashes beyond N are dropped — no stray generation N+1 file", !fs.existsSync(crashlogGenerationPath(CRASHLOG_MAX_GENERATIONS + 1)));

      // Idempotent: re-running with no crash.log present is a harmless no-op — the supervisor-interaction
      // guarantee (supervisor pre-rotated; daemon boot finds no crash.log left to rotate).
      const beforeGen1 = readGen(1);
      rotateCrashlog();
      check("rotate: re-run with no crash.log preserves existing generations (no double-rotation)", readGen(1) === beforeGen1);

      // A REAL rotation failure must never throw — engineer one that is NOT just `force:true`-tolerated
      // ENOENT: make generation-1's slot an actual directory, so the rmSync clearing it before the final
      // rename throws ERR_FS_EISDIR (verified: force:true does NOT suppress this, only ENOENT).
      clearAll();
      fs.writeFileSync(CRASHLOG_PATH, "WILL-FAIL");
      fs.mkdirSync(crashlogGenerationPath(1));
      let failThrew = false;
      try { rotateCrashlog(); } catch { failThrew = true; }
      check("rotate: a genuine rotation failure (EISDIR clearing generation 1) does not throw", !failThrew);
      clearAll();
    }

    // ── H: a crash→restart cycle preserves prior crashes across numbered generations (real handlers) ──
    // Crash three children sharing the SAME LOOM_HOME: each installCrashHandlers boot-time rotation must
    // shift the prior generations down before writing the newest crash.log — proving the end-to-end path
    // (not just the unit-level rotateCrashlog above) actually retains more than one prior crash.
    {
      const home = freshHome("cycle");
      const run = (sc) => spawnSync(process.execPath, [__filename], {
        env: { ...process.env, CRASH_SCENARIO: sc, LOOM_HOME: home }, encoding: "utf8", timeout: 30_000,
      });
      const readGenAt = (home, g) => {
        const p = path.join(home, `crash.log.${g}`);
        return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
      };
      run("uncaught"); // crash #1 → crash.log
      const first = readCrashlog(home);
      check("cycle: first crash wrote crash.log", first?.json?.error?.message === "child uncaught boom");
      run("rejection"); // crash #2 → boot rotation moves #1 to generation 1, writes a fresh crash.log
      const afterSecond = readGenAt(home, 1);
      check("cycle: after 2nd crash, generation 1 holds the FIRST crash", afterSecond?.error?.message === "child uncaught boom");
      check("cycle: current crash.log holds the SECOND crash", readCrashlog(home)?.json?.kind === "unhandledRejection");
      run("uncaught"); // crash #3 → both priors shift down one generation
      const gen1 = readGenAt(home, 1);
      const gen2 = readGenAt(home, 2);
      check("cycle: after 3rd crash, generation 1 holds the SECOND crash (most recent prior)", gen1?.kind === "unhandledRejection");
      check("cycle: after 3rd crash, generation 2 still holds the FIRST crash (not lost — the whole point of this card)", gen2?.error?.message === "child uncaught boom");
      check("cycle: current crash.log holds the THIRD crash", readCrashlog(home)?.json?.error?.message === "child uncaught boom");
    }

    // ── I: hadCrashLogAtBoot() — the env-transport handoff (Code Review finding #2 on card 2f146782) ────
    // Verifies the boot-time signal the crash-recovered nudge relies on: fs.existsSync alone (the
    // unsupervised/packaged path) AND the LOOM_PRIOR_CRASHLOG env override (the supervised daemon:stable
    // path, where scripts/daemon-supervisor.mjs's OWN rotation already moved crash.log away before THIS
    // process could ever see it — see hadCrashLogAtBoot's own doc for why fs.existsSync alone is silently
    // always-false there). This is the case that got through un-tested the first time: the OLD test only
    // ever asserted the NUDGE WORDING given an already-supplied boolean; it could not see where that
    // boolean came from.
    {
      const { hadCrashLogAtBoot, CRASHLOG_PATH } = await import("../dist/crashlog.js");
      fs.rmSync(CRASHLOG_PATH, { force: true }); // start from a clean "no crash.log" state

      check("hadCrashLogAtBoot: no file, no env override → false", hadCrashLogAtBoot({}) === false);
      check("hadCrashLogAtBoot: no file, LOOM_PRIOR_CRASHLOG unset/other value → false", hadCrashLogAtBoot({ LOOM_PRIOR_CRASHLOG: "0" }) === false);

      // THE FIX: a supervised boot following a real crash — the supervisor already rotated the file away
      // (fs.existsSync(CRASHLOG_PATH) is false), but LOOM_PRIOR_CRASHLOG="1" (set only when a real
      // rotation happened) must still yield true.
      check("hadCrashLogAtBoot: no file present BUT LOOM_PRIOR_CRASHLOG=1 (the supervisor-rotated case) → true", hadCrashLogAtBoot({ LOOM_PRIOR_CRASHLOG: "1" }) === true);

      // The unsupervised/packaged path — the file itself is still present at the check point — is
      // unaffected (a regression guard for the pre-existing behavior, independent of the env var).
      fs.mkdirSync(path.dirname(CRASHLOG_PATH), { recursive: true });
      fs.writeFileSync(CRASHLOG_PATH, "SOME-CRASH");
      check("hadCrashLogAtBoot: file present, no env override → true (unsupervised path, unchanged)", hadCrashLogAtBoot({}) === true);
      fs.rmSync(CRASHLOG_PATH, { force: true }); // leave clean for anything added after this section
    }
  }
  // per-tag homes' own trailing cleanup loop removed here: freshHome now creates via mkdtempManaged,
  // which already registered each one for guaranteed cleanup (card 995be21f).

  console.log(failures === 0
    ? "\n✅ ALL PASS — a fatal always leaves a diagnosable crashlog; clean/restart exits do not."
    : `\n❌ ${failures} FAILURE(S).`);
  await finishAndExit(failures === 0 ? 0 : 1);
}
