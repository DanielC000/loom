import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — no Db used below, pure fs+spawn
// Regression guard for card 49c50b80 — `_guard.mjs`'s `exit` hook recursively deleted `${LOOM_HOME}-worktrees`
// (paths.ts's WORKTREES_DIR sibling — every project's live worker worktrees on the host) for ANY LOOM_HOME
// other than the exact real `~/.loom`, with no proof the directory it was looking at was one a TEST
// created. Reachable two ways with no env scrub: `buildReducedGateCommand`'s bare `node <guard>.mjs` steps
// (git/worktrees.ts) and `scripts/run-static-guards.mjs`'s bare `spawnSync` — both inherit the CALLING
// PROCESS's ambient LOOM_HOME. On a daemon with a real, non-default LOOM_HOME (CLAUDE.md documents this as
// first-class: "override LOOM_HOME/LOOM_PORT for two daemons side by side"), a reduced merge gate or a
// `pnpm --filter @loom/daemon guards` run wiped that daemon's ENTIRE fleet of live worker worktrees.
//
// The fix (`isTestCreatedHome` in _guard.mjs): the exit hook now refuses to delete unless `LOOM_HOME`
// resolves to a genuine, strict subdirectory of the OS temp dir — the structural shape of every
// test-created home in this suite (the harness's own `runOne`, `_tmp-fixture.mjs`'s `mkdtempManaged`/
// `useOwnLoomHome`, and 600+ hand-rolled `path.join(os.tmpdir(), ...)` sites), which a real, persistent,
// human-configured second-daemon LOOM_HOME would not be. This needs no per-caller marker file (the DoD's
// rejected alternative — an invariant a new caller could forget); the proof is a property of HOW every
// test-created home is already built.
//
// SAFETY: this test NEVER points LOOM_HOME (or the env vars that drive os.homedir()/os.tmpdir()) at
// anything real. Every child process below has its HOME/USERPROFILE and TEMP/TMP/TMPDIR overridden to
// FAKE, test-owned directories, so `_guard.mjs`'s own REAL_LOOM_HOME/OS_TMPDIR constants (computed from
// those env vars at the child's own module-load time) are themselves fake — this exercises the exit
// hook's REAL decision logic without any risk to the actual `~/.loom` or `~/.loom-worktrees` on this host.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempManaged, cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
// A real, hermetic, static-source-text guard that imports "./_guard.mjs" first — same shape as every
// caller that reaches the exit hook via a bare `node <path>` (buildReducedGateCommand / run-static-guards.mjs).
const GUARD_UNDER_TEST = path.join(TEST_DIR, "human-only-surface-leak-guard.mjs");

// A fake stand-in "user home" and "OS temp dir" — both real, existing directories, but NEITHER is the
// actual host's real home/tmpdir. Overriding HOME/USERPROFILE (os.homedir()) and TEMP/TMP/TMPDIR
// (os.tmpdir()) in the child's env makes `_guard.mjs`'s own REAL_LOOM_HOME/OS_TMPDIR resolve against
// these fakes, not the real host paths.
const fakeUserHome = mkdtempManaged("loom-49c50b80-userhome-");
const fakeOsTmpdir = mkdtempManaged("loom-49c50b80-ostmp-");
const FAKE_REAL_LOOM_HOME = path.join(fakeUserHome, ".loom");

const childEnv = {
  ...process.env,
  HOME: fakeUserHome, USERPROFILE: fakeUserHome, HOMEDRIVE: undefined, HOMEPATH: undefined,
  TEMP: fakeOsTmpdir, TMP: fakeOsTmpdir, TMPDIR: fakeOsTmpdir,
};

/** Runs GUARD_UNDER_TEST as a child with the given LOOM_HOME (undefined ⇒ unset), pre-seeding
 *  `${resolvedHome}-worktrees/marker.txt` first, and returns whether that marker survived the run. */
function runScenario(rawHome) {
  const env = { ...childEnv };
  if (rawHome === undefined) delete env.LOOM_HOME;
  else env.LOOM_HOME = rawHome;

  let worktreesDir = null;
  if (rawHome !== undefined) {
    const resolved = path.resolve(rawHome);
    worktreesDir = `${resolved}-worktrees`;
    fs.mkdirSync(path.join(worktreesDir, "proj", "loom-abc123"), { recursive: true });
    fs.writeFileSync(path.join(worktreesDir, "proj", "loom-abc123", "IMPORTANT.txt"), "important");
  }

  const result = spawnSync(process.execPath, [GUARD_UNDER_TEST], { env, encoding: "utf8" });
  const guardPassed = result.status === 0;
  const survived = worktreesDir === null ? null : fs.existsSync(worktreesDir);
  if (worktreesDir) cleanupPathSync(worktreesDir); // tidy regardless of outcome, before the next scenario
  return { guardPassed, survived, stderr: result.stderr };
}

// ── Scenario A: LOOM_HOME is a genuine, tmp-nested, test-created-shaped home (mirrors every real hermetic
//    test in this suite) — the sibling MUST still be cleaned. This is the guard's actual, unchanged,
//    legitimate purpose (card de7abf0b); the fix must not regress it.
{
  const home = path.join(fakeOsTmpdir, "loom-td-scenario-a-fake123");
  const { guardPassed, survived } = runScenario(home);
  check("(A) the guard itself still passes", guardPassed);
  check("(A) tmp-nested test-created home: sibling -worktrees IS cleaned (unchanged, legitimate)", survived === false);
}

// ── Scenario B — THE FIX: LOOM_HOME is a real-shaped, non-default home OUTSIDE the OS temp dir (mirrors
//    CLAUDE.md's own documented "override LOOM_HOME for a second daemon side by side"). Pre-fix, this was
//    deleted identically to scenario A (only the exact real `~/.loom` was excluded) — the P0 exposure.
{
  const home = path.join(fakeUserHome, "second-daemon-loom-home");
  const { guardPassed, survived } = runScenario(home);
  check("(B) the guard itself still passes", guardPassed);
  check("(B) real non-default, non-tmp-nested LOOM_HOME: sibling -worktrees SURVIVES (the fix)", survived === true);
}

// ── Scenario C — NEGATIVE CONTROL: LOOM_HOME unset entirely. Required alongside (A)/(B)/(D)/(E): without
//    it, "nothing was deleted" is indistinguishable from "the probe never ran" (card 49c50b80 DoD-3).
{
  const { guardPassed, survived } = runScenario(undefined);
  check("(C) the guard itself still passes with LOOM_HOME unset", guardPassed);
  check("(C) negative control: no LOOM_HOME set — survived is N/A (nothing seeded)", survived === null);
}

// ── Scenario D: LOOM_HOME is the (fake) REAL home, exact case — must never be touched (unconditional,
//    behavior unchanged by this fix).
{
  const { guardPassed, survived } = runScenario(FAKE_REAL_LOOM_HOME);
  check("(D) the guard itself still passes", guardPassed);
  check("(D) exact-case (fake) real LOOM_HOME: sibling -worktrees survives", survived === true);
}

// ── Scenario E — DoD-2, the case-compare edge: LOOM_HOME is the (fake) REAL home but DIFFERENTLY CASED.
//    Windows paths are case-insensitive; `path.resolve()` does not normalize case, so a naive `===`
//    compare would miss this and delete the real home's sibling. win32-only (case sensitivity is a
//    platform property, not a portable one to assert elsewhere).
if (process.platform === "win32") {
  const differentlyCased = FAKE_REAL_LOOM_HOME.toUpperCase();
  const { guardPassed, survived } = runScenario(differentlyCased);
  check("(E) the guard itself still passes", guardPassed);
  check("(E) DIFFERENTLY-CASED (fake) real LOOM_HOME: sibling -worktrees survives (DoD-2)", survived === true);
} else {
  console.log("SKIP  (E) case-compare edge is win32-only");
}

console.log(failures === 0 ? "\n✅ ALL PASS" : `\n❌ ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
