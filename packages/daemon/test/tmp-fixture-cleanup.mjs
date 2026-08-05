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

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "fixtures");

function runChild(script, { timeoutMs = 10_000 } = {}) {
  const r = spawnSync(process.execPath, [path.join(FIXTURES, script)], { encoding: "utf8", timeout: timeoutMs });
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

console.log(failures === 0
  ? "\n✅ ALL PASS — mkdtempManaged/registerForCleanup clean up on success, on explicit process.exit(1), and on an uncaught throw; a real EBUSY/EPERM handle is absorbed without throwing and without corrupting an already-passed child's exit code, and is logged (not silently hidden) when retries are genuinely exhausted."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
