import "./_guard.mjs"; // suite consistency (sets LOOM_TEST=1); this test touches no Db.
// Card 4e026f35: the WIRING proof — `scripts/daemon-supervisor.mjs --detach` must refuse (never spawn)
// while another launcher already holds the guard for the SAME (LOOM_HOME, port). Exercises the REAL
// `scripts/daemon-supervisor.mjs` entry as a subprocess (never imported/mocked) — its guard-acquire-and-
// refuse logic runs BEFORE the "already answering" port probe and BEFORE any build step, so this needs no
// actual turbo build to exercise (the refused process exits in well under a second; a real build takes
// minutes — their timings are not confusable).
//
// Also doubles as the "daemon-supervisor.mjs uses the SHARED guard module" proof: this test holds the
// guard via `bin/lib/start-guard.mjs` (imported directly here, the exact same module
// `scripts/daemon-supervisor.mjs` imports by relative path) — if daemon-supervisor.mjs had silently
// reintroduced its own duplicate guard instead of importing the shared one, acquiring the guard here would
// target a DIFFERENT OS primitive, and daemon-supervisor.mjs would then see no guard at all and NOT
// refuse — this test would fail (second launcher also proceeds) rather than passing vacuously.
//
// SAFETY NET (manager directive, post-incident): if the guard itself ever regresses, this test's own
// subprocess would proceed PAST the refusal into a REAL `turbo build` + REAL `dist/index.js` daemon boot
// — confirmed the hard way in an earlier manual RED-proof of this exact file, which also surfaced a
// SECOND, worse risk: a genuinely fresh scratch LOOM_HOME with no first-run marker lets
// `maybeAutoLaunchSetup` (setup/first-run.ts) spawn a REAL node-pty `claude` session on boot, unconditionally,
// unless `LOOM_SUPPRESS_FIRST_RUN_LAUNCH=1` is set. So this file now belt-and-suspenders against that: (1)
// pre-stamps the first-run marker directly in the scratch db BEFORE spawning anything, (2) ALSO sets
// LOOM_SUPPRESS_FIRST_RUN_LAUNCH=1 in the child env, (3) bounds the spawned subprocess instead of waiting
// on it indefinitely, (4) on teardown, scans EVERY live process (not just a known pid) for one whose
// command line references this test's scratch LOOM_HOME and kills any by exact pid, and (5) inspects the
// scratch db for a lingering 'setup' session row before the fixture's own auto-cleanup removes the
// directory. See project memory `red-proof-daemon-supervisor-detach-guard-real-spawn` for the incident.
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
const SUPERVISOR_SCRIPT = path.join(__dirname, "..", "..", "..", "scripts", "daemon-supervisor.mjs"); // packages/daemon/test → repo root
const HARD_BOUND_MS = 20_000; // the GREEN refusal exits in well under 1s; this only protects against a hang/regression

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Spawns the real supervisor subprocess with a HARD BOUND: if it hasn't exited naturally within
// HARD_BOUND_MS, kill it by its EXACT captured pid (never by name) and resolve with timedOut:true rather
// than hang the test indefinitely. This bounds only the TOP-level spawned process — see the teardown scan
// below for why that alone isn't sufficient (a `detached:true` grandchild can outlive it).
function runSupervisorDetachBounded(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SUPERVISOR_SCRIPT, "--detach"], { env, stdio: ["ignore", "pipe", "pipe"] });
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
      resolve({ code, stdout, stderr, elapsedMs: Date.now() - startedAt, pid: child.pid, timedOut: Date.now() - startedAt >= HARD_BOUND_MS });
    });
  });
}

// Kills every process `liveProcessesReferencing(substring)` finds, by exact pid, then re-scans once to
// confirm the population is actually gone — never trusts a bare kill() call without verifying it worked.
async function killAllReferencing(substring) {
  const found = await liveProcessesReferencing(substring);
  for (const p of found) {
    try { process.kill(p.pid, "SIGKILL"); } catch { /* already gone */ }
  }
  if (found.length > 0) await new Promise((r) => setTimeout(r, 500)); // let the OS actually reap them
  return { killed: found, remaining: await liveProcessesReferencing(substring) };
}

// Card 4e026f35: mint a FRESH home UNCONDITIONALLY — never `useOwnLoomHome`, which
// keeps an inherited `process.env.LOOM_HOME`. A bare `node test/x.mjs` run from a shell whose LOOM_HOME
// is already set (e.g. the real ~/.loom) would otherwise watch and tree-kill whatever pid sits in THAT
// home's pid file. This never reads or writes `process.env.LOOM_HOME` at all — `home` below is passed
// explicitly into the spawned child's own env.
const home = mkdtempManaged("daemon-supervisor-start-guard-refused-");
const port = await reserveHermeticPort();

// Belt-and-suspenders #1: pre-stamp the first-run marker directly in the scratch db, before ANYTHING is
// spawned. Belt-and-suspenders #2 (LOOM_SUPPRESS_FIRST_RUN_LAUNCH) is set on the child env below.
await prestampFirstRunMarker(home);

// Hold the guard ourselves (via the SAME shared module daemon-supervisor.mjs imports) — our own pid is
// always alive for the duration of this test, a genuine "another start is in progress" shape.
const guard = await acquireStartGuard({ loomHome: home, port });
check("[refused] this test's own acquireStartGuard() (via the shared module) actually acquired", guard.acquired === true);

const SUPERVISOR_PID_FILE = path.join(home, "daemon-supervisor.pid"); // mirrors scripts/daemon-supervisor.mjs's SUPERVISOR_PID_PATH

try {
  const env = { ...process.env, LOOM_HOME: home, LOOM_PORT: String(port), LOOM_TEST: "1", LOOM_SUPPRESS_FIRST_RUN_LAUNCH: "1" };

  // PRIMARY teardown coverage (card 4e026f35 round 3 item 1): watch for the supervisor's OWN pid-file
  // record and, the instant it appears, TREE-kill that exact pid — argv/env-independent (see
  // _process-scan.mjs's own header for why the command-line scan below can't see this process at all).
  // Started BEFORE the bounded run so both race concurrently: a real supervisor writes this file within
  // milliseconds of spawning its detached child, long before that child's own build (which can take
  // minutes) gets anywhere — so this fires well ahead of HARD_BOUND_MS, not merely before it expires.
  const pidWatcher = watchPidFileAndKill(SUPERVISOR_PID_FILE, { maxWaitMs: HARD_BOUND_MS });

  const result = await runSupervisorDetachBounded(env);
  pidWatcher.cancel(); // the bounded run already settled — stop polling rather than riding out maxWaitMs
  const pidWatch = await pidWatcher.promise;

  check("[refused] daemon-supervisor.mjs --detach exits 0 (refuses rather than double-starting)", result.code === 0);
  check("[refused] it did not hit the hard bound (no hang/regression)", result.timedOut === false);
  check("[refused] the refusal message says a start is already in progress", /a start for this LOOM_HOME\/port is already in progress/i.test(result.stdout));
  check("[refused] no supervisor pid file was written (no second supervisor was ever spawned)", !fs.existsSync(SUPERVISOR_PID_FILE));
  // The refusal happens before ANY build step; a real build takes minutes. A fast exit is itself evidence
  // the build was never reached — bounded generously (10s) to avoid flaking on a loaded CI host while
  // still being utterly incompatible with "it ran a real turbo build".
  check(`[refused] exited fast (${result.elapsedMs}ms), proving it never reached the build step`, result.elapsedMs < 10_000);
  // The pid-watcher itself must have found NOTHING to kill on this (expected) GREEN path — `found:true`
  // here would mean a second supervisor was actually spawned despite every check above reading "refused",
  // which would itself be the regression this teardown exists to catch before a RED run ever reaches it.
  check(`[refused] the pid-file watcher found nothing to kill (found=${pidWatch.found})`, pidWatch.found === false);
  // If the watcher ever DOES find something (a regression), it must never have killed
  // it without first confirming identity against the record's own `entry` field.
  check(`[refused] if the pid-file watcher found something, it only killed an identity-confirmed pid (identityConfirmed=${pidWatch.identityConfirmed})`, pidWatch.found === false || pidWatch.identityConfirmed === true);
} finally {
  guard.release();
}

// TEARDOWN SAFETY SCAN, SECONDARY (cmdline-scoped — card 4e026f35 round 3 item 1): kept as an EXTRA net
// for anything the pid-file-based kill above didn't name, but NOT the primary coverage — a `detached:true`
// grandchild's own command line never carries the scratch LOOM_HOME at all (it travels via ENV, not
// argv; see _process-scan.mjs), so this scan alone would silently pass even with that tree still alive.
// Enumeration can time out under real gate load — wrapped so that failure is a loud,
// labeled check() FAIL rather than an uncaught rejection that would also skip the DB inspection below.
try {
  const scan = await killAllReferencing(home);
  check(`[teardown:cmdline-scoped] no live process (any name — checked claude.exe/node.exe and everything else) references this test's scratch LOOM_HOME in its COMMAND LINE (found ${scan.killed.length} to kill, ${scan.remaining.length} remain after kill+reverify)`, scan.remaining.length === 0);
  for (const k of scan.killed) console.log(`  KILLED (pid ${k.pid}): ${k.commandLine}`);
  for (const r of scan.remaining) console.log(`  STILL ALIVE AFTER KILL (pid ${r.pid}): ${r.commandLine}`);
} catch (err) {
  check(`[teardown:cmdline-scoped] process enumeration failed, could not run this scan: ${err.message}`, false);
}

// DB INSPECTION (manager directive): before the fixture's own auto-cleanup can remove the scratch
// directory, check whether its db ever got a 'setup'-role session row — the one thing that would mean a
// real claude session was actually created. NOTE: loom.db always exists by this point because
// `prestampFirstRunMarker` itself creates it (to write the marker) — its mere existence says nothing
// about whether a real daemon ALSO booted against it and added rows, so this inspection doesn't gate on
// existence, only on the session-row content (if a real daemon did boot — e.g. a regressed guard — this
// is exactly where that would show up).
{
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
  ? "\n✅ ALL PASS — a `--detach` launch racing an already-held start guard refuses outright (fast, before any build step), without spawning a second supervisor, leaving no live process referencing the scratch LOOM_HOME and no real Setup session row; and daemon-supervisor.mjs is confirmed to honor the SAME shared guard module this test holds the guard through, not a reintroduced duplicate."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
