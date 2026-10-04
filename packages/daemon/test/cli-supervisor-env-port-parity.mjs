import "./_guard.mjs"; // suite consistency (sets LOOM_TEST=1); this test touches no Db beyond the first-run prestamp.
// Card d1c87a06: `bin/loom.mjs`'s `resolvePort` used to ignore `<LOOM_HOME>/.env` entirely — only
// `scripts/daemon-supervisor.mjs` read it — so with `LOOM_PORT` set ONLY via that file (never the real
// shell env), `loom start --detach` and `daemon:stable:detach` computed DIFFERENT (home, port)
// start-guard keys and never serialized against each other, defeating the guard's whole purpose for
// exactly that combination.
//
// This test proves both CLIs now resolve the IDENTICAL port from the SAME `<LOOM_HOME>/.env` file — not
// by reading each CLI's internals, but by observing the one externally-visible effect that port value
// has: which start-guard target each one's `acquireStartGuard` call reaches. Real subprocesses, no
// --port flag, no LOOM_PORT in the child's own env — the ONLY way either process can learn its port is
// by reading `.env`.
//
// DELIBERATELY REFUSAL-ONLY (never exercises the "guard acquired, proceeds" branch for EITHER CLI): for
// `scripts/daemon-supervisor.mjs`, that branch spawns a REAL detached child that runs a REAL `turbo
// build` and boots a REAL daemon — exactly the real-spawn risk this project's hermetic test doctrine
// forbids (see this card's own kickoff: "No *-real-spawn* files, ... Never start the real launcher").
// `bin/loom.mjs`'s equivalent branch is comparatively safe in THIS dev checkout (it fails fast at
// `resolveDaemonEntry()`, per cli-start-guard-wiring.mjs's own header), but exercising it here anyway
// would make the two CLIs' coverage asymmetric for no real gain — the refusal case alone already proves
// parity (see below), so this file never needs it from the supervisor either.
//
// The refusal case alone IS the proof, and it's also RED on the old `bin/loom.mjs` (card d1c87a06's own
// bug): the OLD `resolvePort` ignored `.env` and fell back to `DEFAULT_PORT` (4317) — a fixed, far-away
// value a hermetic ephemeral port essentially never equals — so it would NOT be refused by a guard held
// at the `.env`-named port; it would instead proceed past the guard entirely (into the resolveDaemonEntry
// exit-1 path). This test's own RED proof (see the manual revert run performed before committing this
// file) confirms exactly that failure shape.
//
// Discrimination (the refusal isn't the guard unconditionally refusing) is covered SEPARATELY and
// risk-free: a plain in-process `acquireStartGuard` call for a DIFFERENT port on the SAME home, with no
// subprocess involved at all — start-guard-race.mjs's case E already covers this mechanism generally;
// this file's own copy just keeps this file self-certifying without relying on another file staying green.
//
// SAFETY NET: same belt-and-suspenders as cli-start-guard-wiring.mjs / daemon-supervisor-start-guard-
// refused.mjs — pre-stamped first-run marker + LOOM_SUPPRESS_FIRST_RUN_LAUNCH=1 + a hard bound + a
// teardown process scan + a db inspection. See daemon-supervisor-start-guard-refused.mjs's own header for
// the full incident this guards against.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { reserveHermeticPort } from "./_hermetic-port.mjs";
import { acquireStartGuard } from "../../../bin/lib/start-guard.mjs";
import { prestampFirstRunMarker } from "./_first-run-prestamp.mjs";
import { liveProcessesReferencing, watchPidFileAndKill } from "./_process-scan.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOOM_CLI = path.join(__dirname, "..", "..", "..", "bin", "loom.mjs");
const SUPERVISOR_SCRIPT = path.join(__dirname, "..", "..", "..", "scripts", "daemon-supervisor.mjs");
const HARD_BOUND_MS = 20_000; // the GREEN refusal exits in well under 1s; this only guards a hang/regression

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

function runBounded(script, args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", settled = false;
    const startedAt = Date.now();
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const timer = setTimeout(() => {
      if (settled) return;
      try { process.kill(child.pid, "SIGKILL"); } catch { /* already gone */ }
    }, HARD_BOUND_MS);
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, elapsedMs: Date.now() - startedAt, timedOut: Date.now() - startedAt >= HARD_BOUND_MS });
    });
  });
}

async function killAllReferencing(substring) {
  const found = await liveProcessesReferencing(substring);
  for (const p of found) {
    try { process.kill(p.pid, "SIGKILL"); } catch { /* already gone */ }
  }
  if (found.length > 0) await new Promise((r) => setTimeout(r, 500));
  return { killed: found, remaining: await liveProcessesReferencing(substring) };
}

// Card 4e026f35 / d1c87a06: mint a FRESH home UNCONDITIONALLY — never `useOwnLoomHome`. This never
// reads/writes `process.env.LOOM_HOME`, only passes `home` into each spawned child's own env.
const home = mkdtempManaged("cli-supervisor-env-port-parity-");
const portFromEnvFile = await reserveHermeticPort();
const otherPort = await reserveHermeticPort();

await prestampFirstRunMarker(home);

fs.writeFileSync(path.join(home, ".env"), `LOOM_PORT=${portFromEnvFile}\n`);

const DAEMON_PID_FILE = path.join(home, "daemon.pid"); // bin/loom.mjs's pidFilePath()
const SUPERVISOR_PID_FILE = path.join(home, "daemon-supervisor.pid"); // scripts/daemon-supervisor.mjs's SUPERVISOR_PID_PATH

// Deliberately NO --port flag and NO LOOM_PORT in the child env anywhere below — the ONLY source either
// process has for its port is this home's `.env` file. `childEnv()` builds each child's env explicitly
// and DELETES any inherited `LOOM_PORT` rather than trusting it to be absent: this file's own test RUNNER
// process can itself inherit `LOOM_PORT` from WHATEVER launched it (e.g. under `run_gate`, the gate child
// inherits the daemon's own env, which sets `LOOM_PORT`) — spreading that straight through via `...
// process.env` would let `bin/lib/env-file.mjs`'s `fillEnvDefaults` see the key already present and skip
// filling it from `.env` (it only fills keys the target does NOT already have), so the child would
// resolve the inherited var and never touch `.env` at all, masking the exact bug this test exists to
// catch. The precondition below asserts on the BUILT child env, not the runner's own `process.env` — the
// runner's own env is allowed to carry `LOOM_PORT` (that's the whole point of scrubbing it), so asserting
// on the runner's env directly would make this precondition spuriously fail under exactly the gate
// environment it needs to keep passing in.
function childEnv() {
  const env = { ...process.env, LOOM_HOME: home, LOOM_TEST: "1", LOOM_SUPPRESS_FIRST_RUN_LAUNCH: "1" };
  delete env.LOOM_PORT;
  return env;
}
check("[precondition] the built child env does not carry LOOM_PORT (would mask the .env source)", childEnv().LOOM_PORT === undefined);

// Discrimination, risk-free: the guard mechanism itself does distinguish by port (so the refusals below
// are real signal, not an unconditionally-refusing guard) — a plain in-process call, no subprocess.
{
  const holder = await acquireStartGuard({ loomHome: home, port: portFromEnvFile });
  check("[discrimination] holder acquires at the .env-named port", holder.acquired === true);
  const other = await acquireStartGuard({ loomHome: home, port: otherPort });
  check("[discrimination] a DIFFERENT port on the same home acquires independently (guard is not unconditional)", other.acquired === true);
  other.release();
  holder.release();
}

async function caseFor(label, script, args, pidFile) {
  const guard = await acquireStartGuard({ loomHome: home, port: portFromEnvFile });
  check(`[${label}] holder acquires for the .env-named port`, guard.acquired === true);
  try {
    const pidWatcher = watchPidFileAndKill(pidFile, { maxWaitMs: HARD_BOUND_MS });
    const result = await runBounded(script, args, childEnv());
    pidWatcher.cancel();
    const pidWatch = await pidWatcher.promise;
    check(`[${label}] refused when the .env-named port is held (exit 0, no hang)`, result.code === 0 && result.timedOut === false);
    check(`[${label}] refusal message present — proves it resolved the SAME port we're holding, sourced only from .env`, /a start for this LOOM_HOME\/port is already in progress/i.test(result.stdout));
    check(`[${label}] exited fast (${result.elapsedMs}ms) — never reached a real spawn/build step`, result.elapsedMs < 10_000);
    check(`[${label}] no pid file was written (no second process ever spawned)`, !fs.existsSync(pidFile));
    check(`[${label}] pid-file watcher found nothing to kill`, pidWatch.found === false);
  } finally {
    guard.release();
  }
}

try {
  await caseFor("loom", LOOM_CLI, ["start", "--detach", "--no-open"], DAEMON_PID_FILE);
  await caseFor("daemon-supervisor", SUPERVISOR_SCRIPT, ["--detach"], SUPERVISOR_PID_FILE);
} finally {
  // TEARDOWN SAFETY SCAN (see daemon-supervisor-start-guard-refused.mjs's own header for why this is an
  // EXTRA net, not primary coverage).
  try {
    const scan = await killAllReferencing(home);
    check(`[teardown:cmdline-scoped] no live process references this test's scratch LOOM_HOME in its COMMAND LINE (found ${scan.killed.length} to kill, ${scan.remaining.length} remain after kill+reverify)`, scan.remaining.length === 0);
    for (const k of scan.killed) console.log(`  KILLED (pid ${k.pid}): ${k.commandLine}`);
    for (const r of scan.remaining) console.log(`  STILL ALIVE AFTER KILL (pid ${r.pid}): ${r.commandLine}`);
  } catch (err) {
    check(`[teardown:cmdline-scoped] process enumeration failed, could not run this scan: ${err.message}`, false);
  }

  const dbPath = path.join(home, "loom.db");
  const { Db } = await import("../dist/db.js");
  const { SETUP_PROJECT_NAME } = await import("../dist/setup/seed.js");
  const db = new Db(dbPath);
  try {
    const setupHome = db.getReservedProjectByName(SETUP_PROJECT_NAME);
    const setupAgent = setupHome ? db.listAgents(setupHome.id)[0] : undefined;
    const setupSessions = setupAgent ? db.listSessions(setupAgent.id).filter((s) => s.role === "setup") : [];
    check(`[db] no 'setup' session row exists in the scratch db (found ${setupSessions.length})`, setupSessions.length === 0);
  } finally {
    db.close();
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — `loom start --detach` and `daemon-supervisor.mjs --detach` resolve the IDENTICAL port from the SAME `<LOOM_HOME>/.env` file (never set via the real shell env), computing the same start-guard (home, port) key."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
