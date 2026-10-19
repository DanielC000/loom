import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card c2fc8d84 round 2 (manager CR) — a HELPER-LEVEL test for `removeDirWithCleanRetry` itself
// (git/worktrees.ts), independent of either of its two callers (deleteProjectWorkDir,
// deleteProjectArchives). Exists because the reviewer found that both callers' own tests can go GREEN
// even with the helper's "never retry a killed result" invariant deleted, as long as the test only
// exercises `raceRemoval`'s OUTER timeout branch via a never-settling seam: a REAL `killableRemoveDir`
// facing a genuinely wedged child does NOT reach that branch at all — its OWN internal timer always wins
// the race against `raceRemoval`'s outer one (measured 20/20 on this host), resolving
// `{removed:false, killed:true}` DIRECTLY. The real path a wedge takes is
// `removeDirWithCleanRetry`'s `if (outcome.result.killed)` branch, never the `kind === "timeout"` one.
//
// Pins this at the HELPER level (not just via the two callers) so the invariant has one test that can
// never be satisfied vacuously by either caller's own refusal/warn-wording plumbing.
//
// Run: 1) build (turbo builds shared first), 2) node test/remove-dir-clean-retry.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-rdcr-${Date.now()}-${process.pid}`);
fs.mkdirSync(tmpHome, { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { removeDirWithCleanRetry, raceRemoval, killableRemoveDir } = await import("../dist/git/worktrees.js");

function withWatchdog(promise, ms, label) {
  return Promise.race([
    promise.then((v) => ({ hung: false, v })),
    new Promise((resolve) => setTimeout(() => resolve({ hung: true }), ms)),
  ]).then((r) => {
    if (r.hung) throw new Error(`${label} did not settle within the test watchdog (${ms}ms) — genuinely hung`);
    return r.v;
  });
}

function instantResult(result) {
  const calls = [];
  const fn = (target, timeoutMs) => { calls.push({ target, timeoutMs }); return Promise.resolve(result); };
  fn.calls = calls;
  return fn;
}

function neverSettlingRemoveDir() {
  const calls = [];
  const fn = (target, timeoutMs) => { calls.push({ target, timeoutMs }); return new Promise(() => {}); };
  fn.calls = calls;
  return fn;
}

function rejectingRemoveDir(message) {
  const calls = [];
  const fn = (target, timeoutMs) => { calls.push({ target, timeoutMs }); return Promise.reject(new Error(message)); };
  fn.calls = calls;
  return fn;
}

const DUMMY_DIR = path.join(tmpHome, "dummy-target"); // never actually touched by the fake seams below

try {
  // ── (1) THE CASE THE REVIEWER FOUND MISSING — a removeDir that RESOLVES with killed:true ─────────
  // This is the shape the REAL killableRemoveDir actually produces on a genuine wedge (its own internal
  // timer wins the race against raceRemoval's outer one). Must be attempted EXACTLY ONCE, kind "wedged".
  {
    const removeDir = instantResult({ removed: false, killed: true });
    const outcome = await removeDirWithCleanRetry(DUMMY_DIR, { timeoutMs: 5000, attempts: 3, delayMs: 10, removeDir });
    check("(1) a resolved killed:true result yields kind \"wedged\"", outcome.kind === "wedged");
    check("(1) the seam is attempted EXACTLY ONCE (never retried)", removeDir.calls.length === 1);
    check("(1) the returned result carries killed:true, removed:false", outcome.result.killed === true && outcome.result.removed === false);
    check("(1) rejectionMessage is absent for a wedge (not a rejection)", outcome.rejectionMessage === undefined);
  }

  // ── (2) a removeDir that NEVER settles — the outer raceRemoval timeout branch ──────────────────────
  {
    const removeDir = neverSettlingRemoveDir();
    const timeoutMs = 150;
    const t0 = performance.now();
    const outcome = await withWatchdog(
      removeDirWithCleanRetry(DUMMY_DIR, { timeoutMs, attempts: 3, delayMs: 10, removeDir }),
      timeoutMs * 10, "removeDirWithCleanRetry(never-settling)",
    );
    const elapsed = performance.now() - t0;
    check("(2) a never-settling seam still resolves (bounded, never hangs)", elapsed < timeoutMs * 10);
    check("(2) yields kind \"wedged\" via the OUTER timeout branch too", outcome.kind === "wedged");
    check("(2) attempted EXACTLY ONCE (never retried)", removeDir.calls.length === 1);
  }

  // ── (3) a removeDir that REJECTS (never-started) — distinct kind, never retried, never "wedged" ───
  {
    const removeDir = rejectingRemoveDir("ENOENT: spawn rmdir ENOENT (simulated sync spawn failure)");
    const outcome = await removeDirWithCleanRetry(DUMMY_DIR, { timeoutMs: 5000, attempts: 3, delayMs: 10, removeDir });
    check("(3) a rejected removeDir yields kind \"rejected\" (never \"wedged\")", outcome.kind === "rejected");
    check("(3) attempted EXACTLY ONCE (never retried)", removeDir.calls.length === 1);
    check("(3) carries the real rejection message", outcome.rejectionMessage?.includes("ENOENT: spawn rmdir ENOENT"));
    check("(3) the returned result still carries killed:true (internal non-retry signal)", outcome.result.killed === true);
  }

  // ── (4) a clean (non-killed, non-rejected) failure followed by success — retried, then "removed" ──
  {
    let calls = 0;
    const removeDir = (target, timeoutMs) => {
      calls++;
      if (calls === 1) return Promise.resolve({ removed: false, killed: false });
      return Promise.resolve({ removed: true, killed: false });
    };
    const outcome = await removeDirWithCleanRetry(DUMMY_DIR, { timeoutMs: 5000, attempts: 3, delayMs: 10, removeDir });
    check("(4) a clean failure followed by success yields kind \"removed\"", outcome.kind === "removed");
    check("(4) attempted exactly twice (retried once, not looped further)", calls === 2);
  }

  // ── (5) a clean failure on EVERY attempt — bounded, never loops forever, kind "clean-failure" ─────
  {
    let calls = 0;
    const removeDir = () => { calls++; return Promise.resolve({ removed: false, killed: false }); };
    const outcome = await removeDirWithCleanRetry(DUMMY_DIR, { timeoutMs: 100, attempts: 3, delayMs: 10, removeDir });
    check("(5) a clean failure on every attempt yields kind \"clean-failure\"", outcome.kind === "clean-failure");
    check("(5) attempted a BOUNDED number of times (3), never looped indefinitely", calls === 3);
    check("(5) the returned result carries killed:false (a clean, not a wedged, failure)", outcome.result.killed === false);
  }

  // ── (6) sanity — the REAL killableRemoveDir, against a real dir, actually removes it ──────────────
  {
    fs.mkdirSync(DUMMY_DIR, { recursive: true });
    fs.writeFileSync(path.join(DUMMY_DIR, "f.txt"), "hello");
    check("(6) setup: the real target exists before removal", fs.existsSync(DUMMY_DIR));
    const outcome = await removeDirWithCleanRetry(DUMMY_DIR, { timeoutMs: 20_000, attempts: 3, delayMs: 10, removeDir: (p, ms) => killableRemoveDir(p, ms) });
    check("(6) the real killableRemoveDir path yields kind \"removed\"", outcome.kind === "removed");
    check("(6) the dir is actually gone from disk", !fs.existsSync(DUMMY_DIR));
  }

  // ── (7) raceRemoval itself — the discriminator removeDirWithCleanRetry is built on ────────────────
  {
    const resultOutcome = await raceRemoval(Promise.resolve({ removed: true, killed: false }), 5000);
    check("(7) a resolved promise yields kind \"result\"", resultOutcome.kind === "result" && resultOutcome.result.removed === true);

    const timeoutOutcome = await withWatchdog(raceRemoval(new Promise(() => {}), 100), 2000, "raceRemoval(never-settling)");
    check("(7) a never-settling promise yields kind \"timeout\"", timeoutOutcome.kind === "timeout");

    const rejectedOutcome = await raceRemoval(Promise.reject(new Error("boom")), 5000);
    check("(7) a rejecting promise yields kind \"rejected\" with the real message", rejectedOutcome.kind === "rejected" && rejectedOutcome.message === "boom");
  }
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — removeDirWithCleanRetry's own invariant is pinned at the helper level, independent of either caller: a removeDir that RESOLVES with killed:true (the shape a REAL wedge actually produces, since killableRemoveDir's own internal timer always wins the race against raceRemoval's outer one) is attempted exactly once and yields kind \"wedged\", a never-settling seam (the outer timeout branch) yields the same kind, a rejected (never-started) seam yields a distinct \"rejected\" kind with the real message and is likewise never retried, a clean failure is retried up to a bounded budget before succeeding or giving up as \"clean-failure\", the real killableRemoveDir path genuinely removes a real directory, and raceRemoval itself correctly discriminates result/timeout/rejected."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
