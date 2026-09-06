import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Tests for test/_tmp-fixture.mjs (card 995be21f, SCOPE A of a2fdff78) — the shared cleanup-by-
// construction helper. Each scenario below runs the fixture in its OWN child process (not in-process),
// because the whole point is proving PROCESS-LEVEL termination semantics (does cleanup survive a
// process.exit(1)? an uncaught throw? does an EBUSY handle get absorbed without corrupting the child's
// own exit code?) — none of which an in-process call can demonstrate.
//
// RED-FIRST: the (control) block below proves this file's OWN leak-detection method (checking
// fs.existsSync after a child process exits) can see a REAL leak at all, using a fixture that
// deliberately does NOT use the helper — a positive control on the TEST METHOD, run before any of the
// helper's own (expected-green) scenarios.
//
// Run: 1) build daemon (pnpm build), 2) node test/tmp-fixture-cleanup.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { _internal } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "fixtures");

function runChild(script, { timeoutMs = 10_000, env } = {}) {
  const r = spawnSync(process.execPath, [path.join(FIXTURES, script)], {
    encoding: "utf8", timeout: timeoutMs, env: env ? { ...process.env, ...env } : process.env,
  });
  const dirMatch = r.stdout.match(/DIR=(.+)/);
  const checkMatch = r.stdout.match(/CHECK_PASSED=(true|false)/);
  return {
    dir: dirMatch ? dirMatch[1].trim() : null,
    checkPassed: checkMatch ? checkMatch[1] === "true" : null,
    code: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
  };
}

// ============================ (control) RED-FIRST: prove the detection method itself works ============
{
  const r = runChild("_child-noop-leak.mjs");
  check("(control) a bare mkdtemp with NO cleanup genuinely leaks — the test method sees a real positive", !!r.dir && fs.existsSync(r.dir));
  if (r.dir && fs.existsSync(r.dir)) fs.rmSync(r.dir, { recursive: true, force: true }); // our own cleanup, not the helper's
}

// ============================ (1) success path — natural exit, exercises `beforeExit` ==================
{
  const r = runChild("_child-success.mjs");
  check("(success) child created a dir", !!r.dir);
  check("(success) child exited 0", r.code === 0);
  check("(success) helper removed the dir after a natural (non-process.exit) end", !!r.dir && !fs.existsSync(r.dir));
}

// ============================ (2) explicit process.exit(1) — exercises the SYNC backstop ===============
{
  const r = runChild("_child-exit1.mjs");
  check("(exit1) child exited 1 as expected", r.code === 1);
  check("(exit1) helper STILL removed the dir despite an explicit process.exit(1) (beforeExit never fires here)", !!r.dir && !fs.existsSync(r.dir));
}

// ==== (2b) finishAndExit with a LINGERING TIMER — the exact hazard a bare exitCode substitution hangs on
{
  const r = runChild("_child-finishandexit-lingering-timer.mjs", { timeoutMs: 5000 });
  check("(finishAndExit) child with a never-clearing setInterval still exits PROMPTLY (no hang, unlike a bare process.exitCode substitution)", r.code === 0);
  check("(finishAndExit) the dir was still cleaned up via its own awaited async cleanup", !!r.dir && !fs.existsSync(r.dir));
}

// ============================ (3) uncaught throw — closes the failure-path leak shape ===================
{
  const r = runChild("_child-throw.mjs");
  check("(throw) child exited non-zero from the uncaught exception", r.code !== 0 && r.code !== null);
  check("(throw) helper STILL removed the dir on an uncaught throw (the exact gap 25/88 companion files had)", !!r.dir && !fs.existsSync(r.dir));
}

// ============================ (4)+(5) EBUSY, recoverable + exhausted — WINDOWS-ONLY ====================
// Card f33830d1 (main red on Linux since 2026-07-31): both fixtures' own doc comments say the EBUSY they
// reproduce is a WINDOWS-SPECIFIC lock — a live process's CWD sitting inside the managed dir, "verified
// empirically on this host/Node to throw EBUSY on rmdir" (see _child-ebusy-recoverable.mjs's header; a
// plain open file handle does NOT trigger it, since this Node/Windows combo opens files with
// FILE_SHARE_DELETE by default). POSIX permits `rmdir`/`rename` of a directory that is another live
// process's CWD — no error is raised, the process's cwd just becomes a dangling reference — so this
// mechanism cannot be reproduced on Linux/macOS at all: `rmSync` there always succeeds on the FIRST
// attempt, no EBUSY, no retry, ever. Confirmed against real CI (gh run 30947596896): on Linux EVERY
// (ebusy-recoverable) assertion passes anyway (consistent with an immediate, retry-free removal), and
// the ONLY failing assertion in this file is (ebusy-exhausted)'s "helper logged the exhausted-retry
// warning" — which can only fire once retries are genuinely exhausted, and retries are never even
// attempted on POSIX. Skipping (ebusy-recoverable) too, not just the failing (ebusy-exhausted): a POSIX
// pass there is not a real test of the retry path either — it passes only because the hazard it exists
// to exercise never occurs, which is coverage-by-accident, not evidence the retry logic works.
if (process.platform === "win32") {
  // ---- (4) EBUSY, recoverable — the acceptance evidence -----------------------------------------------
  {
    const r = runChild("_child-ebusy-recoverable.mjs", { timeoutMs: 5000 });
    check("(ebusy-recoverable) the managed dir genuinely existed before cleanup was ever triggered", r.checkPassed === true);
    check("(ebusy-recoverable) child STILL exited 0 — the EBUSY hazard during its own cleanup did NOT override its already-passed result", r.code === 0);
    check("(ebusy-recoverable) the dir WAS eventually removed once the holder's CWD lock cleared (bounded retry genuinely worked, not just silently swallowed)", !!r.dir && !fs.existsSync(r.dir));
  }

  // ---- (5) EBUSY, exhausted — the honest complement ----------------------------------------------------
  {
    const r = runChild("_child-ebusy-exhausted.mjs", { timeoutMs: 5000 });
    check("(ebusy-exhausted) the managed dir genuinely existed before cleanup was ever triggered", r.checkPassed === true);
    check("(ebusy-exhausted) child STILL exited 0 — exhausting retries does not throw or corrupt the exit code", r.code === 0);
    check("(ebusy-exhausted) the helper logged the exhausted-retry warning rather than hiding the failure", /\[tmp-fixture\] could not remove/.test(r.stderr));
    // The dir is honestly LEFT BEHIND here (that's the point) — clean it up ourselves once the holder
    // (which runs ~2s past this child's own exit) has actually released its CWD lock, so this test doesn't
    // itself add to the real residue the whole card is about.
    if (r.dir) {
      await new Promise((resolve) => setTimeout(resolve, 2200));
      try { fs.rmSync(r.dir, { recursive: true, force: true }); } catch { /* best-effort, not under test here */ }
    }
  }
} else {
  console.log("SKIP  (ebusy-recoverable) + (ebusy-exhausted) — EBUSY-via-live-process-CWD-inside-the-directory is an NTFS-locking-specific reproduction; POSIX permits rmdir/rename of a directory that is another process's CWD, so no EBUSY is ever raised and the retry path is structurally unreachable here");
}

// ============================ (6) flushStream — the flush algorithm itself, in isolation ================
// Card 4eb6cbc0: exercises `flushStream`'s own ordering + bounded-give-up behavior against SYNTHETIC fake
// streams (not real process.stdout) — this host's real pipes are synchronous by construction (proven
// empirically during this card's investigation: `writableLength` never leaves 0 here even under multi-MB
// real-pipe writes to a parent), so a fake stream with a controllable, artificially delayed `write()` is
// the ONLY way to exercise the "wait for a genuinely pending write" and "give up after a bound" paths on
// THIS host at all. This proves the ALGORITHM is correct, independent of any OS — it does NOT, and
// cannot, prove the fix rescues real POSIX pipe truncation (see (7)'s own honesty note below for that).
{
  const { flushStream } = _internal;

  function fakeStream({ writableLength, writeDelayMs = 0, neverCompletes = false }) {
    return {
      writableLength,
      write(_chunk, cb) {
        if (neverCompletes) return; // deliberately never invokes cb — exercises the timeout give-up path
        setTimeout(cb, writeDelayMs);
      },
    };
  }

  // (6a) fast path: nothing queued (writableLength:0) resolves without ever touching write().
  {
    const s = fakeStream({ writableLength: 0 });
    let writeCalled = false;
    s.write = () => { writeCalled = true; };
    const start = Date.now();
    await flushStream(s, 5000);
    check("(6a) writableLength:0 resolves without ever calling write() (nothing pending to drain)", writeCalled === false);
    check("(6a) writableLength:0 resolves near-instantly", Date.now() - start < 200);
  }

  // (6b) [THE TEST] a genuinely pending write must be WAITED FOR — the promise resolves only after the
  // fake write's own callback fires, not immediately regardless of it.
  {
    const s = fakeStream({ writableLength: 4096, writeDelayMs: 300 });
    const start = Date.now();
    await flushStream(s, 5000);
    const elapsed = Date.now() - start;
    check(`(6b) [THE TEST] a pending write (300ms to complete) is genuinely awaited — elapsed ${elapsed}ms`, elapsed >= 250);
  }

  // (6c) [THE TEST] bounded give-up: a write that NEVER completes must still resolve, bounded by the
  // timeout, not hang forever — the non-negotiable half of this fix.
  {
    const s = fakeStream({ writableLength: 4096, neverCompletes: true });
    const start = Date.now();
    await flushStream(s, 150);
    const elapsed = Date.now() - start;
    check(`(6c) [THE TEST] a write that never completes still resolves, bounded by its 150ms timeout — elapsed ${elapsed}ms`, elapsed >= 130 && elapsed < 2000);
  }

  // (6d) [negative control] proves (6b)'s assertion CAN fail: a naive "flush" that ignores the pending
  // write and resolves immediately regardless must NOT show the same elapsed-time floor (6b) does — if it
  // did, (6b)'s >=250ms assertion would be measuring nothing.
  {
    const naiveFlush = () => Promise.resolve(); // the pre-fix shape: resolves regardless of pending writes
    const start = Date.now();
    await naiveFlush();
    const elapsed = Date.now() - start;
    check(`(6d) [negative control] a naive no-op flush resolves near-instantly despite a pending write — elapsed ${elapsed}ms — proving (6b)'s assertion is a real discriminator, not a vacuous one`, elapsed < 100);
  }
}

// ============================ (7) finishAndExit with an EMPTY registry — the conditional-protection gap =
// Card 4eb6cbc0's own finding: the ~89 files calling `finishAndExit` were only INCIDENTALLY protected from
// the POSIX-async-pipe race when their cleanup registry was non-empty. This fixture calls it with NOTHING
// registered — the exact gap `flushStdoutAndExit` now closes unconditionally.
// ⚠️ HONESTY: this host's real pipes are synchronous by construction (empirically confirmed: writableLength
// never leaves 0 here even under multi-MB writes through a real pipe to a parent) — so this CANNOT
// discriminate whether the fix actually rescues bytes on POSIX; a pre-fix run passes this exact assertion
// too. It is a wiring/regression check (does finishAndExit with an empty registry still exit correctly,
// promptly, with full content, now that it routes through flushStdoutAndExit) — not proof of the POSIX
// mechanism. The POSIX-only assertion that WOULD prove it: reproduce this same empty-registry scenario on
// a real ubuntu-latest run with a payload large enough to force genuine async queuing (comparable to card
// 776750ba's own `test/fixtures/_stderr-sentinel-exit.mjs`, ~500KB+) and confirm zero truncation with the
// fix vs. observable loss without it — out of reach from this host.
{
  const MARKER = "EMPTYREG";
  const LINE_COUNT = 2000;
  const r = runChild("_child-finishandexit-empty-registry-flush.mjs", {
    timeoutMs: 5000,
    env: { LOOM_TEST_MARKER: MARKER, LOOM_TEST_LINE_COUNT: String(LINE_COUNT) },
  });
  check("(7) [wiring] finishAndExit with an EMPTY registry still exits 0", r.code === 0);
  const missing = Array.from({ length: LINE_COUNT }, (_, i) => `${MARKER}-LINE-${i}`).filter((l) => !r.stdout.includes(l));
  check(`(7) [wiring] all ${LINE_COUNT} distinctive lines survive an empty-registry finishAndExit — ${missing.length} missing`, missing.length === 0);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — mkdtempManaged/registerForCleanup clean up on success, on explicit process.exit(1), and on an uncaught throw; a real EBUSY/EPERM handle is absorbed without throwing and without corrupting an already-passed child's exit code, and is logged (not silently hidden) when retries are genuinely exhausted; and (card 4eb6cbc0) flushStream genuinely awaits a pending write and still gives up within its bound if one never completes (proven against synthetic fake streams, with a negative control showing the timing assertion can fail), and finishAndExit with an EMPTY cleanup registry (the conditional-protection gap the investigation found) still exits promptly with its full output intact through the real spawn path."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
