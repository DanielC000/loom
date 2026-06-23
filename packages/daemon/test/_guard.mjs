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
import os from "node:os";
import path from "node:path";

// Arm the Db prod-guard for THIS process (and inherited by spawned daemons) the moment we're imported.
process.env.LOOM_TEST = "1";

// Strip GIT_PAGER/PAGER from the test process env. The suite exercises the daemon's simple-git, which
// REFUSES to run with GIT_PAGER set ("Use of GIT_PAGER is not permitted without enabling allowUnsafePager").
// In production that simple-git always runs in the supervisor-spawned daemon process — NEVER the
// worker/manager pty's GIT_PAGER=cat shell-git backstop env (set in buildSpawnEnv, the actual wedge fix).
// But when this suite is run FROM a session pty (e.g. a worker gating on `pnpm test`), it inherits that
// GIT_PAGER=cat/PAGER=cat and 6 simple-git tests fail. Stripping these makes a session-spawned test run
// faithful to the production daemon env + satisfies simple-git's allowUnsafePager guard.
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
