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

// Arm the Db prod-guard for THIS process (and inherited by spawned daemons) the moment we're imported.
process.env.LOOM_TEST = "1";

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

const REAL_LOOM_HOME = path.resolve(path.join(os.homedir(), ".loom"));
const PROD_PORT = 4317;

/**
 * Abort unless this process is pointed at an isolated test environment — never prod.
 * @param {{ port?: boolean }} opts  port:true also requires LOOM_PORT to be set and != 4317
 *   (use for any test that fetch()es a live daemon).
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
