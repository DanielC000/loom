// Card e2df9f8e root cause, shared by test-daemon-only-file-real-spawn.mjs (R3-7) and
// reduced-gate-only-file-overflow.mjs ((F)) — the two hermetic tests that prove a REAL production
// command string (`pnpm --filter @loom/daemon test:daemon --only-file=...`/`--only=...`) spawns cleanly
// through a real shell, by actually spawning it.
//
// Both tests are themselves discovered and run AS hermetic members of `pnpm --filter @loom/daemon
// test:daemon` — exactly how the real merge/worker/deploy gate always runs this suite (reduced or full).
// pnpm marks "I am currently running script <X> for package <Y>" on that invocation's own env
// (PNPM_SCRIPT_SRC_DIR = the package dir, npm_lifecycle_event = the script name), inherited by every
// `node <test file>.mjs` child `runOne()` spawns and, from there, by anything THAT child spawns in turn —
// including these two tests' own nested spawn of the exact same `@loom/daemon` package + `test:daemon`
// script. pnpm's OWN anti-recursion guard then silently resolves that nested `--filter @loom/daemon`
// selection to the EMPTY set and exits 0 ("None of the selected packages has a \"test:daemon\" script")
// WITHOUT ever reaching test-daemon.mjs's own argument handling — never an error, never a non-zero exit,
// just a quiet no-op standing in for a real run. Measured: a `bare node test/<file>.mjs` run never
// recurses (no pnpm wrapper in that process tree at all), so it never shows this; `pnpm test:daemon
// --only=<these files>` always does, deterministically, 100% of the time these two files are selected.
//
// The REAL production gate command is unaffected: gate-runner.ts spawns it from the DAEMON's own ambient
// env (`{...process.env, ...}`, `orchestration/gate-runner.ts`), and the daemon is never itself a
// descendant of a `pnpm --filter @loom/daemon test:daemon` invocation (it's started via `pnpm daemon`
// (script "dev"), `pnpm daemon:stable` (script "daemon:stable"), or the packaged `loom start` CLI (no
// pnpm wrapper at all) — none of those set PNPM_SCRIPT_SRC_DIR/npm_lifecycle_event to match
// "test:daemon"/packages/daemon). So the production `--only-file=`/`--only=` step, run as the FIRST and
// ONLY top-level `pnpm --filter @loom/daemon test:daemon` invocation in its own process tree, never hits
// pnpm's recursion guard — only a test that is ITSELF already running inside that same invocation, and
// then re-invokes it, can trigger this.
//
// Fix: scrub the recursion markers from THIS spawn's own env so it looks like that fresh, non-recursive
// invocation instead of a nested one — matching what the real gate would actually see. Deletion
// (never a blank override) is required: an explicit `KEY: ""` still satisfies pnpm's "is this var SET"
// check, which is a presence check, not a truthiness check.
//
// Minimal, evidence-isolated cause (binary search over the real env diff, card e2df9f8e investigation):
// PNPM_SCRIPT_SRC_DIR + npm_lifecycle_event together are necessary AND sufficient to reproduce; neither
// alone, nor any other pair tried, reproduces it. npm_lifecycle_script/INIT_CWD/npm_package_name/
// npm_package_version are stripped too, defensively, since they are part of the SAME pnpm-set "currently
// running this script" bookkeeping and carry no value once the two load-bearing keys are gone.
const PNPM_SCRIPT_RECURSION_MARKER_KEYS = [
  "PNPM_SCRIPT_SRC_DIR",
  "npm_lifecycle_event",
  "npm_lifecycle_script",
  "INIT_CWD",
  "npm_package_name",
  "npm_package_version",
];

/**
 * Returns a COPY of `env` (defaults to `process.env`) with pnpm's own script-recursion markers removed,
 * so a nested `pnpm --filter @loom/daemon test:daemon` spawned from inside this already affects this
 * suite's own run behaves like a fresh, non-recursive invocation — see this file's header for why that
 * fix is correct and why the real production gate path never needs it.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {NodeJS.ProcessEnv}
 */
export function envWithoutPnpmScriptRecursionMarkers(env = process.env) {
  const copy = { ...env };
  for (const key of PNPM_SCRIPT_RECURSION_MARKER_KEYS) delete copy[key];
  return copy;
}
