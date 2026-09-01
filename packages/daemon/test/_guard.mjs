// SHARED TEST PROD-GUARD — import this FIRST in every daemon test.
//
// WHY THIS EXISTS (HIGH-severity incident, 2026-06-04 ~03:39): a worker ran a daemon integration
// test with NO env set. The test's `BASE` defaulted to the PROD daemon on :4317 and a bare `new Db()`
// opened the PROD database `~/.loom/loom.db`, and the test then DELETE'd sessions/agents/projects/
// tasks — wiping the real 14 projects / 197 tasks (recovered only by luck from a WAL checkpoint).
//
// DEFENSE IN DEPTH — this module gives the test suite two protections:
//   1. Importing it sets `process.env.LOOM_TEST = "1"` (inherited by any daemon this test spawns),
//      which arms the Db prod-guard in `src/db.ts` — a stray default-path `new Db()` then THROWS
//      instead of opening `~/.loom/loom.db`.
//   2. `requireHermeticEnv()` ABORTS the process unless it is pointed at an isolated test environment:
//      LOOM_HOME must be a temp dir (NOT the real ~/.loom) and — for tests that talk to a live daemon
//      over HTTP — LOOM_PORT must be set and != 4317 (NOT the prod daemon).
//
// USAGE:
//   • In-process / self-isolating tests (they set their OWN LOOM_HOME=<temp> before importing dist):
//         import "./_guard.mjs";              // arms the Db backstop (LOOM_TEST=1)
//         process.env.LOOM_HOME = <temp>;
//         requireHermeticEnv();               // confirms LOOM_HOME is the temp dir
//   • Live-BASE tests (they fetch a running daemon — the prod-killers):
//         import { requireHermeticEnv } from "./_guard.mjs";
//         requireHermeticEnv({ port: true }); // FIRST executable line — aborts on bare env
//
// TIMING ASSERTIONS: never sample timing-dependent state right after a blind `sleep(N)` and assert
// against it — that's a guess about how long some other async operation takes, and it passes on an idle
// host and fails under load (card 0fa5beef — four real merge gates redded by exactly this shape in one
// day). Poll for the real state instead: see `./_wait.mjs` (`waitUntil`/`deferred`) for the shared
// helper and the full writeup of the anti-pattern and its two corollaries.
import os from "node:os";
import path from "node:path";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

const REAL_LOOM_HOME = path.resolve(path.join(os.homedir(), ".loom"));
const OS_TMPDIR = path.resolve(os.tmpdir());

// Windows paths are case-insensitive, so a differently-cased LOOM_HOME (`c:\users\danie\.loom` vs the
// canonical `C:\Users\danie\.loom`) must not defeat a comparison against it — path.resolve() does NOT
// normalize case. Both comparisons below (the real-home exclusion and the tmpdir-scoped proof) go
// through this (card 49c50b80 DoD-2).
function normalizeForCompare(p) {
  return process.platform === "win32" ? p.toLowerCase() : p;
}

// Card 49c50b80: a LOOM_HOME this hook may safely clean up (i.e. whose `-worktrees` sibling it deletes)
// MUST be a genuine, strict subdirectory of the OS temp dir — that is the structural proof it's a
// throwaway home a TEST created (`fs.mkdtempSync(path.join(os.tmpdir(), ...))`, the shape every test in
// this suite uses — the harness's own `runOne`, `_tmp-fixture.mjs`'s `mkdtempManaged`/`useOwnLoomHome`,
// and 600+ hand-rolled per-file `tmpHome` variables all satisfy this by construction), never a REAL
// non-default LOOM_HOME a human pointed a second daemon at (`CLAUDE.md`: "override LOOM_HOME/LOOM_PORT
// for two daemons side by side") — which is exactly the exposure this card fixed: the old code deleted
// `<LOOM_HOME>-worktrees` for ANY LOOM_HOME other than the real one, with no proof it was test-created.
// This needs no per-caller marker file (the DoD's alternative (a) — "restores an invariant each new
// caller must remember", per the card) because the proof is a property of HOW every test-created home is
// already built, not something a new caller could forget to add.
function isTestCreatedHome(resolved) {
  const home = normalizeForCompare(resolved);
  const tmp = normalizeForCompare(OS_TMPDIR);
  return home !== tmp && home.startsWith(tmp + path.sep);
}

// Arm the Db prod-guard for THIS process (and inherited by spawned daemons) the moment we're imported.
process.env.LOOM_TEST = "1";

// LOOM_HOME-derived WORKTREES_DIR leak (card de7abf0b): `paths.ts` defines `WORKTREES_DIR` as a SIBLING
// of LOOM_HOME (`<dirname>/<basename>-worktrees`), never a child of it. Every hermetic test that sets its
// own temp LOOM_HOME (the near-universal pattern in this suite — see that file's own header) and then
// touches `createWorktree` leaves this sibling behind: cleanup code everywhere targets LOOM_HOME itself
// (or individual leaf worktree paths), never this derived path, so the per-project parent directories
// `createWorktree` creates under it — and sometimes real worktree content, if a test's own cleanup never
// ran — accumulate forever. Measured: a single run of worker-noop-done.mjs alone left a fresh
// `<LOOM_HOME>-worktrees` dir with 6 empty per-project leftovers.
// This hook is the ONE chokepoint: `_guard.mjs` is imported FIRST by every test in this convention
// (measured 612/714 non-underscore files, 2026-08-07), so fixing it here needs no per-file edit. It must
// be LAZY (read `process.env.LOOM_HOME` only when the hook actually fires) because every test sets its
// OWN LOOM_HOME AFTER this import — `paths.ts` reads LOOM_HOME at module load, so the override always
// happens later in the file. `exit` (not `beforeExit`) mirrors `_tmp-fixture.mjs`'s own reasoning: nearly
// every file in this suite ends with an explicit `process.exit(N)`, which only `exit` fires for.
// KNOWN NON-COVERAGE, STATED NOT FIXED: the ~14% of files that don't import `_guard.mjs` at all get none
// of this (they predate, or opted out of, the shared prod-guard convention) — same class of gap as
// `_tmp-fixture.mjs`'s own SIGKILL/`taskkill /F` caveat, not papered over here either.
// CLEAN-ON-PASS-VS-RETAIN-ON-FAIL (card de7abf0b DoD-2): deliberately UNCONDITIONAL, not gated on the
// exit code. A retained LOOM_HOME can be real post-mortem evidence (its db/logs/event history) — but
// this cleans up a DIFFERENT thing, the WORKTREES_DIR sibling (git worktree checkouts), whose diagnostic
// value on a failure is already covered by the runner's captured stdout/stderr (printed on FAIL — see
// `runOne` in scripts/test-daemon.mjs) and by git history, not by an on-disk checkout. Every existing
// per-file LOOM_HOME/worktree cleanup in this suite (600+ sites) is ALSO unconditional (a bare `finally`,
// no pass/fail branch) — matching that established convention here avoids a new, surprising asymmetry
// where this ONE derived path survives a failure and nothing else does.
process.on("exit", () => {
  const home = process.env.LOOM_HOME;
  if (!home) return;
  const resolved = path.resolve(home);
  if (normalizeForCompare(resolved) === normalizeForCompare(REAL_LOOM_HOME)) return; // never touch the real ~/.loom-worktrees
  // Card 49c50b80: refuse unless `resolved` is provably a test-created temp home (see isTestCreatedHome
  // above) — this hook is reachable from a bare `node <guard-file>.mjs` invocation (both
  // buildReducedGateCommand's reduced merge-gate steps and `pnpm --filter @loom/daemon guards`), which
  // inherits the CALLER's ambient LOOM_HOME with no scrub. Before this fix, ANY non-real LOOM_HOME —
  // including a real, non-default one a human pointed a second daemon at — had its `-worktrees` sibling
  // (every project's live worker worktrees on that daemon) deleted unconditionally.
  if (!isTestCreatedHome(resolved)) return;
  cleanupPathSync(`${resolved}-worktrees`);
});

// Strip GIT_PAGER/PAGER from the test process env. This USED to be the only defense — card 42544916
// proved the assumption behind it wrong: "production only runs in the supervisor-spawned daemon
// process, never the worker/manager pty's GIT_PAGER=cat" ignored that the supervisor itself inherits
// whatever env the HUMAN's own launching shell has, and a real end user with GIT_PAGER/PAGER set in
// their own shell profile (an ordinary personal git config) hit the exact same 500 in production — not
// just in a worker-spawned test run. The REAL fix now lives at the source: `nonInteractiveEnv()`
// (git/writer.ts) strips GIT_PAGER/PAGER (and EDITOR/GIT_EXTERNAL_DIFF alongside the pre-existing
// GIT_EDITOR/GIT_SEQUENCE_EDITOR) itself, so GitReader/GitWriter are immune regardless of ambient env —
// see its own comment for the full enumeration of what's stripped vs. deliberately still blocked. This
// strip stays here only for parity with a bare test process that imports simple-git directly without
// going through nonInteractiveEnv(); it is no longer load-bearing for the daemon's own git reads/writes.
delete process.env.GIT_PAGER;
delete process.env.PAGER;

const PROD_PORT = 4317;

/**
 * Abort unless this process is pointed at an isolated test environment — never prod.
 * @param {{ port?: boolean }} opts  port:true also requires LOOM_PORT to be set and != 4317
 *   (use for any test that fetch()es a live daemon).
 *
 * SCOPE, NARROWER THAN IT LOOKS (card 7a5948bd): this only proves `LOOM_HOME` (and, with `port:true`,
 * `LOOM_PORT`) are isolated — it does NOT mean this process can't reach real `~/.loom` by any route.
 * Since card d1e10795, every test child spawned by `scripts/test-daemon.mjs` also carries a SEPARATE,
 * ADDITIVE `LOOM_REAL_HOME` env var (the harness's own real home, for durable diagnostic telemetry) that
 * this function never inspects and never could — a test reading `process.env.LOOM_REAL_HOME` and writing
 * through it reaches prod with this guard passing the whole time. That's a real, narrower gap, closed not
 * here but by `real-home-scope-guard.mjs`, which allowlists+shape-checks every such read instead.
 */
export function requireHermeticEnv({ port = false } = {}) {
  const problems = [];

  const home = process.env.LOOM_HOME;
  if (!home) problems.push("LOOM_HOME is unset (would default to the real ~/.loom)");
  else if (path.resolve(home) === REAL_LOOM_HOME)
    problems.push(`LOOM_HOME resolves to the real ~/.loom (${path.resolve(home)})`);

  if (port) {
    const p = process.env.LOOM_PORT;
    if (!p) problems.push("LOOM_PORT is unset (would default to the prod daemon on 4317)");
    else if (Number(p) === PROD_PORT) problems.push("LOOM_PORT == 4317 (the prod daemon)");
  }

  if (problems.length) {
    console.error(
      "\n🛑 refusing to run tests against prod — set LOOM_HOME=<temp> and LOOM_PORT=<non-4317>.\n" +
        problems.map((p) => "  - " + p).join("\n") +
        "\n",
    );
    process.exit(99);
  }
}
