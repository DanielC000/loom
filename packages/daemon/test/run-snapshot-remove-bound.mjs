import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// card 26c661cd (bd9fc808-shaped fix, the last two surviving sites): runs/snapshot.ts's
// removeRunSnapshot (fire-and-forget teardown, sessions/service.ts:6238) and sweepAllRunSnapshots (the
// SYNCHRONOUS-on-main-thread boot sweep) both used to retry a HUNG `fs.rm`/`fs.rmSync` — the exact
// bd9fc808 shape: a wedged directory handle never lets that call settle, so it occupies a libuv
// threadpool slot (default pool size 4, shared by every fs/DNS/crypto op process-wide) FOREVER, and (for
// the boot sweep) blocks the main thread — hence the whole daemon — for up to the retry budget.
//
// THE CASE THAT MATTERS: a NEVER-SETTLING removal. A test that only covers a removal which eventually
// rejects does not exercise this bug — see the git/worktrees.ts `removeWorktree`/`killableRemoveDir`
// precedent (already tested, already proven) this fix adopts wholesale rather than reinventing.
//
// Hermetic, deterministic, no real claude: exercises runs/snapshot.ts directly against an injected
// `removeDir` seam (mirrors BoundedGitDeps.removeDir / boot-listen-not-blocked.mjs's `neverRemoveDir`)
// — a real OS-level wedged directory handle is not portably simulable, so the seam stands in for it,
// exactly as the codebase's own prior art for this exact bug class does.
//
// Run: 1) build (turbo builds shared first), 2) node test/run-snapshot-remove-bound.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
// MONOTONIC (see CLAUDE.md's CI timing-flake note) + slack, so a loaded runner can't flake a lower bound.
const TIMER_SLACK_MS = 80;

// --- Hermetic LOOM_HOME (set BEFORE importing dist — paths.ts reads it at import time) ---
const tmpHome = path.join(os.tmpdir(), `loom-run-snap-${Date.now()}-${process.pid}`);
fs.mkdirSync(tmpHome, { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { removeRunSnapshot, sweepAllRunSnapshots, runSnapshotDir } = await import("../dist/runs/snapshot.js");
const { RUNS_DIR } = await import("../dist/paths.js");
fs.mkdirSync(RUNS_DIR, { recursive: true });

// A watchdog so a genuinely regressed (hanging) implementation FAILS the test instead of hanging the
// process forever — this is a TEST-harness safety net, never a substitute for the code's own bound.
function withWatchdog(promise, ms, label) {
  return Promise.race([
    promise.then((v) => ({ hung: false, v })),
    new Promise((resolve) => setTimeout(() => resolve({ hung: true }), ms)),
  ]).then((r) => {
    if (r.hung) throw new Error(`${label} did not settle within the test watchdog (${ms}ms) — genuinely hung`);
    return r.v;
  });
}

// A `removeDir` seam that NEVER settles — the never-settling case bd9fc808 missed. Also records whether
// it was actually invoked, so we can positive-control-verify the code under test really routes removal
// through the injectable seam (not e.g. a fallback to real fs.rm that would silently make this vacuous).
function neverSettlingRemoveDir() {
  const calls = [];
  const fn = (target, timeoutMs) => { calls.push({ target, timeoutMs }); return new Promise(() => {}); };
  fn.calls = calls;
  return fn;
}

// A `removeDir` seam that resolves immediately with a given result — the POSITIVE control proving the
// harness can also observe a clean pass (never-settling-only coverage would be as unaudited as a check
// with no negative control run the other way).
function instantRemoveDir(result) {
  const calls = [];
  const fn = (target, timeoutMs) => { calls.push({ target, timeoutMs }); return Promise.resolve(result); };
  fn.calls = calls;
  return fn;
}

// ============================== 1. removeRunSnapshot — never-settling removeDir ==============================
{
  const sessionId = "sess-wedged-1";
  const removeDir = neverSettlingRemoveDir();
  const timeoutMs = 150;
  const t0 = performance.now();
  await withWatchdog(removeRunSnapshot(sessionId, { removeDir, timeoutMs }), timeoutMs * 5, "removeRunSnapshot(wedged)");
  const elapsed = performance.now() - t0;

  check("1 removeRunSnapshot routes through the injected removeDir seam (not a silent fs.rm fallback)", removeDir.calls.length === 1);
  check("1 removeRunSnapshot resolves (does not hang forever) against a never-settling removeDir",
    elapsed < timeoutMs * 5);
  check(`1 removeRunSnapshot's outer bound fires ~at timeoutMs (${Math.round(elapsed)}ms >= ${timeoutMs}ms)`,
    elapsed >= timeoutMs - TIMER_SLACK_MS);
  check("1 removeRunSnapshot NEVER throws even when the removal is genuinely wedged",
    true); // reaching this line without an uncaught rejection above is the proof
}

// ============================== 2. removeRunSnapshot — positive control (clean removal) ==============================
{
  const sessionId = "sess-clean-1";
  const removeDir = instantRemoveDir({ removed: true, killed: false });
  const t0 = performance.now();
  await removeRunSnapshot(sessionId, { removeDir, timeoutMs: 5000 });
  const elapsed = performance.now() - t0;

  check("2 removeRunSnapshot calls removeDir exactly once for a clean removal", removeDir.calls.length === 1);
  check(`2 removeRunSnapshot returns FAST on a clean removal (not waiting out the full timeout) (${Math.round(elapsed)}ms)`,
    elapsed < 2000);
}

// ============================== 3. removeRunSnapshot — REAL removal (no injected seam) actually deletes the dir ==============================
{
  const sessionId = "sess-real-1";
  const dir = runSnapshotDir(sessionId);
  fs.mkdirSync(path.join(dir, "nested"), { recursive: true });
  fs.writeFileSync(path.join(dir, "nested", "file.txt"), "hello");
  check("3 setup: snapshot dir exists before removal", fs.existsSync(dir));

  await withWatchdog(removeRunSnapshot(sessionId), 20_000, "removeRunSnapshot(real)");
  check("3 removeRunSnapshot with the REAL killableRemoveDir actually deletes the directory", !fs.existsSync(dir));
}

// ============================== 4. sweepAllRunSnapshots — never-settling entries stay BOUNDED, not summed ==============================
{
  // Three "stuck" dirs — if this were still a serial/summing bound (N * timeoutMs, the removeWorktree
  // Pass-B shape) this would take ~3x as long; sweepAllRunSnapshots deliberately parallelizes (Promise.all)
  // since — unlike worktree GC — there is no shared git admin record serializing these removals.
  const names = ["stuck-a", "stuck-b", "stuck-c"];
  for (const n of names) fs.mkdirSync(path.join(RUNS_DIR, n), { recursive: true });
  const removeDir = neverSettlingRemoveDir();
  const timeoutMs = 150;
  const t0 = performance.now();
  await withWatchdog(sweepAllRunSnapshots({ removeDir, timeoutMs }), timeoutMs * 5, "sweepAllRunSnapshots(wedged x3)");
  const elapsed = performance.now() - t0;

  check("4 sweepAllRunSnapshots invokes removeDir for every entry under RUNS_DIR", removeDir.calls.length >= names.length);
  check("4 sweepAllRunSnapshots resolves (boot must never hang on a wedged dir)", elapsed < timeoutMs * 5);
  check(`4 sweepAllRunSnapshots bounds PARALLEL, not serial (elapsed ${Math.round(elapsed)}ms ~= ${timeoutMs}ms, not ~= ${names.length * timeoutMs}ms)`,
    elapsed < names.length * timeoutMs - TIMER_SLACK_MS);
  for (const n of names) fs.rmSync(path.join(RUNS_DIR, n), { recursive: true, force: true }); // cleanup: these were never really removed (mocked)
}

// ============================== 5. sweepAllRunSnapshots — REAL removal (boot-sweep path) actually clears entries ==============================
{
  const names = ["real-a", "real-b"];
  for (const n of names) {
    fs.mkdirSync(path.join(RUNS_DIR, n, "x"), { recursive: true });
    fs.writeFileSync(path.join(RUNS_DIR, n, "x", "f.txt"), "y");
  }
  await withWatchdog(sweepAllRunSnapshots(), 20_000, "sweepAllRunSnapshots(real)");
  check("5 sweepAllRunSnapshots with the REAL killableRemoveDir clears every entry under RUNS_DIR",
    names.every((n) => !fs.existsSync(path.join(RUNS_DIR, n))));
}

// ============================== 6. reconcileRunsOnBoot stays SYNCHRONOUS (never awaits the sweep) ==============================
// boot-listen-not-blocked.mjs already proves, from the real src/index.ts AST, that reconcileRunsOnBoot is
// called BEFORE app.listen() and is never itself awaited there. This proves the OTHER half: the function's
// own return value must be a plain object, not a Promise — i.e. it must not have quietly become `async`
// (which would reintroduce exactly the boot-blocking-on-a-wedged-dir bug this card fixes, since an awaited
// async fn's synchronous-looking call site would actually suspend the caller).
{
  const { Db } = await import("../dist/db.js");
  const { PtyHost } = await import("../dist/pty/host.js");
  const { SessionService } = await import("../dist/sessions/service.js");
  const { OrchestrationControl } = await import("../dist/orchestration/control.js");
  const db = new Db();
  const host = new PtyHost({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} });
  const svc = new SessionService(db, host, new OrchestrationControl());
  const result = svc.reconcileRunsOnBoot();
  check("6 reconcileRunsOnBoot returns a PLAIN object synchronously (not a Promise/thenable)",
    result && typeof result === "object" && typeof result.then !== "function" && typeof result.failed === "number");
}

console.log(failures === 0
  ? "\n✅ ALL PASS — removeRunSnapshot/sweepAllRunSnapshots are bounded against a genuinely never-settling removal (never looped, never hang), the real killableRemoveDir path still actually deletes snapshot dirs, the boot sweep bounds in PARALLEL rather than summing per-entry, and reconcileRunsOnBoot stays synchronous (fire-and-forgets the sweep) so a wedged dir can never block boot."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
