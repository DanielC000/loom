import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 5eace211 (Code Review, CRITICAL, item e) — CANARY REGRESSION TEST for the hermetic-env fix this
// round of review forced: every test that imports dist/paths.js used to inherit whatever AMBIENT
// `LOOM_PROJECT_WORK_ROOT` a human had set (Decision 2 explicitly recommends setting one), and then
// recursively removed (or created real entries under) that SAME real shared root — the reviewer proved
// this with a canary. The fix has TWO independent layers: (a) every affected test file now explicitly
// clears/pins `LOOM_PROJECT_WORK_ROOT` before importing `dist/paths.js`; (b) `requireHermeticEnv()`
// (`_guard.mjs`) now REFUSES outright if `LOOM_PROJECT_WORK_ROOT` is ambient-set to anything outside the
// OS temp dir. This file proves BOTH layers against a REAL canary file, in REAL child processes (never
// this process's own env, which must never carry a dangerous ambient value itself) — a future regression
// in either layer should turn this file RED.
//
// Proves:
//   (A) THE FIX WORKING: a child process that follows the fixed pattern (clears LOOM_PROJECT_WORK_ROOT,
//       then calls requireHermeticEnv, then does a REAL ensureProjectWorkDir + deleteProjectWorkDir round
//       trip) resolves its OWN PROJECTS_WORK_ROOT as a sibling of ITS OWN LOOM_HOME, NEVER the ambient
//       canary root — and the real canary file under that ambient root survives, byte-for-byte, untouched.
//   (B) THE BACKSTOP FIRING: a child process that does NOT clear LOOM_PROJECT_WORK_ROOT first (the OLD,
//       unfixed pattern), pointed at a path genuinely OUTSIDE the OS temp dir (the shape a real human
//       override takes — (A)'s own temp-dir canary is deliberately NOT reused here, since the guard's
//       own string check would never fire against it), has requireHermeticEnv() itself ABORT (exit 99,
//       naming the problem) before it ever reaches a mutation point — proving the backstop is
//       independently load-bearing, not just theoretically present.
//   (C) assertUnderOsTmpdir (the shared primitive both (a) and (b) above are built on) — pure unit checks:
//       throws for a path outside the OS temp dir, does NOT throw for one genuinely inside it.
//
// Run: 1) build (turbo builds shared first), 2) node test/project-work-root-hermetic-guard.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { assertUnderOsTmpdir } = await import("./_guard.mjs");

// CLAUDE.md gotcha: a bare drive-letter path in a dynamic import() throws ERR_UNSUPPORTED_ESM_URL_SCHEME
// on Windows — pass the file:// URL itself (never fileURLToPath'd) into every probe script's import.
const guardUrl = new URL("./_guard.mjs", import.meta.url).href;
const pathsUrl = new URL("../dist/paths.js", import.meta.url).href;

// The REAL canary — a dir + file standing in for "a human's real PROJECTS_WORK_ROOT, with real shared
// content". Deliberately never touched by THIS process's own env (only ever handed to a CHILD process's
// env object below) — this process's own `_guard.mjs` exit hook must never see it as an ambient value.
const canaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loom-canary-ambient-root-"));
const canaryFile = path.join(canaryRoot, "canary.bin");
const CANARY_CONTENT = "DO-NOT-TOUCH-this-is-a-human-s-real-project-work-root";
fs.writeFileSync(canaryFile, CANARY_CONTENT);

try {
  // ===================== (A) the fixed pattern — canary survives via the PIN =====================
  const probeHomeA = fs.mkdtempSync(path.join(os.tmpdir(), "loom-canary-probe-home-a-"));
  const probeIdA = randomUUID();
  const scriptA =
    `process.env.LOOM_HOME = ${JSON.stringify(probeHomeA)};` +
    // THE FIX every affected test file now applies, verbatim, before importing dist/paths.js.
    `delete process.env.LOOM_PROJECT_WORK_ROOT;` +
    `const { requireHermeticEnv } = await import(${JSON.stringify(guardUrl)});` +
    `requireHermeticEnv();` +
    `const { ensureProjectWorkDir, deleteProjectWorkDir, PROJECTS_WORK_ROOT } = await import(${JSON.stringify(pathsUrl)});` +
    // A REAL round trip (creation + removal) against whatever this process resolves as ITS OWN root —
    // if the fix failed, this would be the exact shape that mutates the real ambient root instead.
    `ensureProjectWorkDir(${JSON.stringify(probeIdA)}, "Canary Probe A");` +
    `await deleteProjectWorkDir(${JSON.stringify(probeIdA)});` +
    `process.stdout.write(PROJECTS_WORK_ROOT);`;
  const outA = execFileSync(process.execPath, ["--input-type=module", "-e", scriptA], {
    env: { ...process.env, LOOM_PROJECT_WORK_ROOT: canaryRoot },
    encoding: "utf8",
  });
  check("(A) the fixed pattern's OWN resolved PROJECTS_WORK_ROOT is NOT the ambient canary root", outA.trim() !== canaryRoot);
  check("(A) that resolved root is a sibling of ITS OWN LOOM_HOME instead",
    path.dirname(outA.trim()) === path.dirname(probeHomeA) && path.basename(outA.trim()) === `${path.basename(probeHomeA)}-projects`);
  check("(A) THE CANARY FILE SURVIVES, byte-for-byte, after a real create+delete round trip under the fixed pattern",
    fs.existsSync(canaryFile) && fs.readFileSync(canaryFile, "utf8") === CANARY_CONTENT);

  // ===================== (B) the UNFIXED pattern — requireHermeticEnv itself refuses =====================
  // Card 5eace211: deliberately NOT `canaryRoot` here — `canaryRoot` is itself created under os.tmpdir()
  // (the only sanctioned place this suite may write), which makes it indistinguishable, BY THE GUARD'S
  // OWN STRING CHECK, from a legitimate test fixture — a REAL human-set override would typically sit
  // OUTSIDE the temp dir, which is exactly the shape that check refuses. `outsideTempForGuard` below is
  // that shape: a string this test NEVER creates or writes through (the refusal is pure string
  // comparison — proven in (C) below — so nothing needs to exist on disk at this path at all), kept
  // distinct from `canaryRoot` precisely so this scenario tests the GUARD, not the (already-proven-safe)
  // temp-dir case (A) already covers.
  const outsideTempForGuard = path.join(os.homedir(), "loom-canary-guard-probe-b-does-not-exist");
  const probeHomeB = fs.mkdtempSync(path.join(os.tmpdir(), "loom-canary-probe-home-b-"));
  const scriptB =
    `process.env.LOOM_HOME = ${JSON.stringify(probeHomeB)};` +
    // Deliberately NO `delete process.env.LOOM_PROJECT_WORK_ROOT` here — this is the OLD, unfixed shape
    // every one of the four CRITICAL-finding files had before this round of review.
    `const { requireHermeticEnv } = await import(${JSON.stringify(guardUrl)});` +
    `requireHermeticEnv();` +
    `process.stdout.write("UNREACHABLE — requireHermeticEnv should have aborted this process already");`;
  let threwB = null;
  try {
    execFileSync(process.execPath, ["--input-type=module", "-e", scriptB], {
      env: { ...process.env, LOOM_PROJECT_WORK_ROOT: outsideTempForGuard },
      encoding: "utf8",
    });
  } catch (e) {
    threwB = e;
  }
  check("(B) THE BACKSTOP FIRES: requireHermeticEnv aborts (exit 99) when LOOM_PROJECT_WORK_ROOT is ambient and un-pinned",
    threwB !== null && threwB.status === 99);
  check("(B) the abort's own stderr names LOOM_PROJECT_WORK_ROOT (not a generic/unrelated failure)",
    /LOOM_PROJECT_WORK_ROOT/.test(threwB?.stderr ?? ""));
  check("(B) the probe NEVER reached its own stdout write (genuinely aborted before any mutation point, not just a slow failure after)",
    !(threwB?.stdout ?? "").includes("UNREACHABLE"));
  check("(B) nothing was ever created at the ambient (would-be-real) root — the abort happened before any I/O point",
    !fs.existsSync(outsideTempForGuard));

  // ===================== (C) assertUnderOsTmpdir — pure unit checks on the shared primitive =====================
  // A path OUTSIDE the OS temp dir — need not exist on disk; the check is pure string containment, not
  // an fs probe. os.homedir() is never itself inside os.tmpdir() on any platform this suite targets.
  const outsideTemp = path.join(os.homedir(), "loom-canary-outside-temp-check-does-not-exist");
  let threwC1 = false;
  try { assertUnderOsTmpdir("test-label", outsideTemp); } catch { threwC1 = true; }
  check("(C) assertUnderOsTmpdir THROWS for a path genuinely outside the OS temp dir", threwC1 === true);
  const insideTemp = fs.mkdtempSync(path.join(os.tmpdir(), "loom-canary-inside-"));
  let threwC2 = false;
  try { assertUnderOsTmpdir("test-label", insideTemp); } catch { threwC2 = true; }
  check("(C) assertUnderOsTmpdir does NOT throw for a path genuinely inside the OS temp dir", threwC2 === false);
  fs.rmSync(insideTemp, { recursive: true, force: true });
} finally {
  fs.rmSync(canaryRoot, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a real canary file standing in for a human's real PROJECTS_WORK_ROOT survives BOTH the fixed pattern's explicit pin (a real ensureProjectWorkDir+deleteProjectWorkDir round trip resolves its OWN sibling-of-LOOM_HOME root, never the ambient canary) AND, independently, requireHermeticEnv's own backstop refusal when a (simulated, pre-fix) test forgets to pin at all — proving both defense-in-depth layers are genuinely load-bearing, not just present in code. assertUnderOsTmpdir, the shared primitive underneath both, throws/doesn't-throw correctly in isolation too."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
