import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card c2fc8d84 — sessions/transcript.ts's `deleteProjectArchives` moved off a SYNCHRONOUS
// `fs.rmSync(LOOM_HOME/archives/<id>, {recursive:true})` (which blocked the EVENT LOOP itself on a
// wedged Windows handle — worse than the libuv-threadpool hazard bd9fc808 fixed) onto `killableRemoveDir`
// via the shared `removeDirWithCleanRetry` (git/worktrees.ts), the exact same shape
// project-work-dir.mjs's own (5c) section already proves for `deleteProjectWorkDir`.
//
// THE CASE THAT MATTERS: a NEVER-SETTLING removal. A test that only covers a removal which eventually
// rejects does not exercise the real bug — see project-work-dir.mjs's own header for the same note.
//
// Run: 1) build (turbo builds shared first), 2) node test/project-archives-remove-bound.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// MONOTONIC (see CLAUDE.md's CI timing-flake note) + slack, so a loaded runner can't flake a lower bound.
const TIMER_SLACK_MS = 80;

const tmpHome = path.join(os.tmpdir(), `loom-pac-${Date.now()}-${process.pid}`);
fs.mkdirSync(tmpHome, { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv(); // confirms LOOM_HOME is isolated

const { deleteProjectArchives } = await import("../dist/sessions/transcript.js");
const { LOOM_HOME } = await import("../dist/paths.js");
const { killableRemoveDir } = await import("../dist/git/worktrees.js");

const archivesRoot = path.join(LOOM_HOME, "archives");

function archivesDir(projectId) {
  return path.join(archivesRoot, projectId);
}

function withWatchdog(promise, ms, label) {
  return Promise.race([
    promise.then((v) => ({ hung: false, v })),
    new Promise((resolve) => setTimeout(() => resolve({ hung: true }), ms)),
  ]).then((r) => {
    if (r.hung) throw new Error(`${label} did not settle within the test watchdog (${ms}ms) — genuinely hung`);
    return r.v;
  });
}

// A `removeDir` seam that NEVER settles — the case that matters: a genuinely wedged removal.
function neverSettlingRemoveDir() {
  const calls = [];
  const fn = (target, timeoutMs) => { calls.push({ target, timeoutMs }); return new Promise(() => {}); };
  fn.calls = calls;
  return fn;
}

// A `removeDir` seam that RESOLVES IMMEDIATELY with a given result — card c2fc8d84 round 2 (manager CR):
// a real `killableRemoveDir` facing a genuinely wedged child does NOT reach `raceRemoval`'s own outer
// timeout branch at all — ITS OWN internal timer always wins that race (measured 20/20), resolving
// `{removed:false, killed:true}` directly. `neverSettlingRemoveDir` above (which never resolves at all)
// only exercises the outer-timeout branch; THIS seam is what exercises the path a real wedge actually
// takes through `removeDirWithCleanRetry`'s `if (outcome.result.killed)` branch.
function instantResult(result) {
  const calls = [];
  const fn = (target, timeoutMs) => { calls.push({ target, timeoutMs }); return Promise.resolve(result); };
  fn.calls = calls;
  return fn;
}

function seedArchives(projectId, bytes = 100) {
  const dir = archivesDir(projectId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "snapshot.jsonl"), Buffer.alloc(bytes, 7));
  return dir;
}

const warned = [];
const origWarn = console.warn;
console.warn = (...a) => warned.push(a.join(" "));

try {
  // ── (1) basic removal — scoped, best-effort, no-throw on missing ─────────────────────────────────
  const idA = "aaaaaaaa-1111-4111-8111-111111111111";
  const idB = "bbbbbbbb-2222-4222-8222-222222222222";
  const dirA = seedArchives(idA);
  const dirB = seedArchives(idB);
  warned.length = 0;
  await deleteProjectArchives(idA);
  check("(1) deleteProjectArchives actually removes the archives dir", !fs.existsSync(dirA));
  check("(1) B's archives dir is untouched by deleting A's (scoped, not root-wide)", fs.existsSync(dirB));
  check("(1) no warn fires on a genuine success", warned.length === 0);

  let threw = false;
  try { await deleteProjectArchives(idA); } catch { threw = true; }
  check("(1) deleting an already-missing project's archives does NOT throw", threw === false);

  // ── (2) never-settling removeDir — THE CASE THAT MATTERS ──────────────────────────────────────────
  const idE = "eeeeeeee-5555-4555-8555-555555555555";
  seedArchives(idE);
  const removeDirWedged = neverSettlingRemoveDir();
  const wedgedTimeoutMs = 150;
  warned.length = 0;
  const t0 = performance.now();
  await withWatchdog(deleteProjectArchives(idE, { removeDir: removeDirWedged, timeoutMs: wedgedTimeoutMs }), wedgedTimeoutMs * 10, "deleteProjectArchives(wedged)");
  const elapsedWedged = performance.now() - t0;
  check("(2-wedged) a never-settling removeDir still resolves (does not hang forever)", elapsedWedged < wedgedTimeoutMs * 10);
  check(`(2-wedged) the outer bound fires ~at timeoutMs (${Math.round(elapsedWedged)}ms >= ${wedgedTimeoutMs}ms)`,
    elapsedWedged >= wedgedTimeoutMs - TIMER_SLACK_MS);
  check("(2-wedged) a killed/wedged result is attempted EXACTLY ONCE (never retried)", removeDirWedged.calls.length === 1);
  check("(2-wedged) the seam was called with THIS project's own archives dir and the configured timeoutMs",
    removeDirWedged.calls[0]?.target === archivesDir(idE) && removeDirWedged.calls[0]?.timeoutMs === wedgedTimeoutMs);
  check("(2-wedged) exactly one warn fires (never zero, never more than one)", warned.length === 1);
  check("(2-wedged) the warn names BOTH the project id and the on-disk path left behind",
    warned[0]?.includes(idE) && warned[0]?.includes(archivesDir(idE)));
  check("(2-wedged) the warn uses the WEDGED wording, never the rejected/'failed to start' wording",
    warned[0]?.includes("genuinely wedged") && !warned[0]?.includes("failed to start"));

  // ── (2b) a removeDir that RESOLVES with killed:true — THE PATH A REAL WEDGE ACTUALLY TAKES ────────
  const idG = "22222222-7777-4777-8777-777777777777";
  seedArchives(idG);
  const removeDirResolvedKilled = instantResult({ removed: false, killed: true });
  warned.length = 0;
  await deleteProjectArchives(idG, { removeDir: removeDirResolvedKilled, timeoutMs: 5000 });
  check("(2b-wedged-resolved) a resolved killed:true result is attempted EXACTLY ONCE (never retried)", removeDirResolvedKilled.calls.length === 1);
  check("(2b-wedged-resolved) exactly one warn fires", warned.length === 1);
  check("(2b-wedged-resolved) the warn uses the WEDGED wording, never the rejected/'failed to start'/'clean failure' wording",
    warned[0]?.includes("genuinely wedged") && !warned[0]?.includes("failed to start") && !warned[0]?.includes("clean failure"));
  check("(2b-wedged-resolved) the archives dir survives untouched", fs.existsSync(archivesDir(idG)));

  // ── (3) rejected (never-started) removeDir — must NEVER be logged as "wedged" ─────────────────────
  const idF = "ffffffff-6666-4666-8666-666666666666";
  seedArchives(idF);
  let rejectedCalls = 0;
  const removeDirRejects = () => { rejectedCalls++; return Promise.reject(new Error("ENOENT: spawn rmdir ENOENT (simulated sync spawn failure)")); };
  warned.length = 0;
  let threwF = false;
  try { await deleteProjectArchives(idF, { removeDir: removeDirRejects, timeoutMs: 5000 }); } catch { threwF = true; }
  check("(3-rejected) a removeDir that REJECTS does NOT throw out of deleteProjectArchives", threwF === false);
  check("(3-rejected) a rejected (never-started) result is attempted EXACTLY ONCE (never retried)", rejectedCalls === 1);
  check("(3-rejected) exactly one warn fires", warned.length === 1);
  check("(3-rejected) the warn uses the 'removal failed to start' wording AND includes the real error message",
    warned[0]?.includes("removal failed to start") && warned[0]?.includes("ENOENT: spawn rmdir ENOENT"));
  check("(3-rejected) the warn NEVER claims 'genuinely wedged' for a rejection that was never a timeout",
    !warned[0]?.includes("genuinely wedged"));

  // ── (4) clean failure, then success — a clean (non-killed) reject IS retried ──────────────────────
  const idC = "cccccccc-3333-4333-8333-333333333333";
  const dirC = seedArchives(idC);
  let flakyCalls = 0;
  const flakyThenRealRemoveDir = (target, timeoutMs) => {
    flakyCalls++;
    if (flakyCalls === 1) return Promise.resolve({ removed: false, killed: false });
    return killableRemoveDir(target, timeoutMs);
  };
  warned.length = 0;
  await deleteProjectArchives(idC, { removeDir: flakyThenRealRemoveDir, timeoutMs: 5000 });
  check("(4-clean-retry) a clean failure followed by success actually removes the dir", !fs.existsSync(dirC));
  check("(4-clean-retry) the seam was called exactly twice (retried once, not looped further)", flakyCalls === 2);
  check("(4-clean-retry) NO warn fires — the final outcome is a genuine success", warned.length === 0);

  // ── (5) clean failure, every attempt — bounded retry, never throws, dir survives ──────────────────
  const idD = "dddddddd-4444-4444-8444-444444444444";
  const dirD = seedArchives(idD);
  let cleanFailCalls = 0;
  const countedAlwaysCleanFail = () => { cleanFailCalls++; return Promise.resolve({ removed: false, killed: false }); };
  warned.length = 0;
  let threwD = false;
  try { await deleteProjectArchives(idD, { removeDir: countedAlwaysCleanFail, timeoutMs: 100 }); } catch { threwD = true; }
  check("(5-clean-exhausted) a clean failure on EVERY attempt does NOT throw", threwD === false);
  check("(5-clean-exhausted) the seam is attempted a bounded number of times (3), never looped indefinitely", cleanFailCalls === 3);
  check("(5-clean-exhausted) ...and logs EXACTLY one warn (never zero, never once per attempt)", warned.length === 1);
  check("(5-clean-exhausted) ...and the dir survives untouched (a failed removal must not partially remove/corrupt it)",
    fs.existsSync(dirD));

  // ── (6) deleteProjectArchives's REFUSAL branch — card c2fc8d84 round 2 (manager CR, PATH SAFETY) ──
  // Pre-fix, `deleteProjectArchives` did `path.join(LOOM_HOME,"archives",projectId)` with NO shape guard
  // at all (unlike deleteProjectWorkDir's own UUID/traversal refusal) — a non-UUID or ".."-shaped id was
  // NEVER refused. A non-UUID id is the lower-severity case (still a single segment, just not a real
  // UUID); the real hazard is the traversal id below, which resolves to LOOM_HOME ITSELF.
  const nonUuidId = "not-a-real-uuid";
  const nonUuidDir = archivesDir(nonUuidId);
  fs.mkdirSync(nonUuidDir, { recursive: true });
  fs.writeFileSync(path.join(nonUuidDir, "canary.bin"), Buffer.alloc(100, 9));
  warned.length = 0;
  await deleteProjectArchives(nonUuidId);
  check("(6) a non-UUID-shaped id is REFUSED — the dir survives untouched", fs.existsSync(nonUuidDir) && fs.existsSync(path.join(nonUuidDir, "canary.bin")));
  check("(6) exactly one refusal warn fires", warned.length === 1);

  // A ".." id — the CRITICAL case: `path.join(archivesRoot, "..")` resolves to LOOM_HOME ITSELF, not
  // merely "outside the archives root". An unguarded deleteProjectArchives("..") would attempt to
  // recursively remove the whole LOOM_HOME tree. Proven against a real canary file placed directly in
  // LOOM_HOME (never merely "nothing happened", which could just as well mean a wrong computed path).
  const traversalId = "..";
  check("(6) precondition — the traversal id's computed path resolves to LOOM_HOME itself", archivesDir(traversalId) === LOOM_HOME);
  const canaryInLoomHome = path.join(LOOM_HOME, "canary.bin");
  fs.writeFileSync(canaryInLoomHome, Buffer.alloc(100, 9));
  warned.length = 0;
  await deleteProjectArchives(traversalId);
  check("(6) a '..' id is REFUSED — LOOM_HOME itself (and the canary inside it) survives untouched",
    fs.existsSync(LOOM_HOME) && fs.existsSync(canaryInLoomHome));
  check("(6) exactly one refusal warn fires for the traversal id too", warned.length === 1);
} finally {
  console.warn = origWarn;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — deleteProjectArchives removes the whole LOOM_HOME/archives/<id> dir scoped and best-effort (async, never throws on a missing dir), and, via its injectable removeDir seam (card c2fc8d84), a never-settling (wedged) removal still resolves bounded and is attempted exactly once with 'genuinely wedged' wording, a removeDir that RESOLVES with killed:true (the path a real wedge actually takes) is likewise attempted exactly once with the same wedged wording, a REJECTED (never-started) removal is likewise attempted exactly once but with distinct 'removal failed to start' wording (each proven absent from the others' warns), a clean failure followed by success retries and actually removes the dir with no warn, a clean failure on every attempt is bounded to 3 attempts and logs exactly one warn naming the project id + path, and a non-UUID or '..'-shaped projectId is REFUSED outright (leaving a real canary, and LOOM_HOME itself, untouched)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
