import "./_guard.mjs"; // suite consistency (sets LOOM_TEST=1); this test touches no Db.
// Card 4e026f35: the WIRING proof for `bin/loom.mjs`'s `startDetached` — a second `loom start --detach`
// must refuse (never spawn, never even call `resolveDaemonEntry()`) while another launcher already holds
// the guard for the SAME (LOOM_HOME, port).
//
// WHY THIS NEEDS NO STUB DAEMON (and no real one either): `startDetached` now acquires the guard as its
// FIRST action, strictly before `resolveDaemonEntry()` — which, in this dev monorepo checkout, would exit
// 1 ("daemon entry not found") because there is no `<repo-root>/dist/index.js` outside a real npm-package
// build (see `resolveDaemonEntry`'s own comment). That absence is exactly what makes this test
// self-certifying rather than a guess: a REFUSED launch exits 0 with the guard's own message and NEVER
// reaches `resolveDaemonEntry()` at all, while a launch that (by a regression) reached past the guard
// would instead hit that exit-1 "package looks incomplete" path — a totally different, easily
// distinguished outcome. There is nothing to mock; the guard-refusal path and the only-other-reachable
// path in this environment are already distinguishable by construction.
//
// SAFETY NET (manager directive, post-incident — see daemon-supervisor-start-guard-refused.mjs's own
// header for the full incident): a regressed guard here is harmless in THIS checkout specifically (no real
// dist/index.js exists, so the only other reachable path is the exit-1 above, never a real boot) — but
// this file still carries the SAME belt-and-suspenders as that one (pre-stamped first-run marker +
// LOOM_SUPPRESS_FIRST_RUN_LAUNCH=1 + a hard bound + a teardown process scan + a db inspection), so the
// protection doesn't silently depend on this checkout never gaining a real top-level dist/index.js (e.g. a
// future packaged-layout test run).
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { reserveHermeticPort } from "./_hermetic-port.mjs";
import { acquireStartGuard } from "../../../bin/lib/start-guard.mjs";
import { prestampFirstRunMarker } from "./_first-run-prestamp.mjs";
import { liveProcessesReferencing, watchPidFileAndKill } from "./_process-scan.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOOM_CLI = path.join(__dirname, "..", "..", "..", "bin", "loom.mjs"); // packages/daemon/test → repo root
const HARD_BOUND_MS = 20_000; // the GREEN refusal exits in well under 1s; this only protects against a hang/regression

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

function runLoomStartDetachBounded(env, port) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [LOOM_CLI, "start", "--detach", "--port", String(port), "--no-open"], { env, stdio: ["ignore", "pipe", "pipe"] });
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

async function killAllReferencing(substring) {
  const found = await liveProcessesReferencing(substring);
  for (const p of found) {
    try { process.kill(p.pid, "SIGKILL"); } catch { /* already gone */ }
  }
  if (found.length > 0) await new Promise((r) => setTimeout(r, 500));
  return { killed: found, remaining: await liveProcessesReferencing(substring) };
}

// Card 4e026f35: mint a FRESH home UNCONDITIONALLY — never `useOwnLoomHome`, which
// keeps an inherited `process.env.LOOM_HOME`. See daemon-supervisor-start-guard-refused.mjs's own comment
// for why: this never reads/writes process.env.LOOM_HOME, only passes `home` into the spawned child's env.
const home = mkdtempManaged("cli-start-guard-wiring-");
const port = await reserveHermeticPort();

// Belt-and-suspenders #1 (see header): pre-stamp before anything is spawned. #2 is set on the child env below.
await prestampFirstRunMarker(home);

// Hold the guard ourselves, via the SAME shared module `bin/loom.mjs` imports — proves the real CLI honors
// this exact module, not a reintroduced duplicate (if it did, our hold here would target a different OS
// primitive and the CLI would proceed, not refuse).
const guard = await acquireStartGuard({ loomHome: home, port });
check("[refused] this test's own acquireStartGuard() (via the shared module) actually acquired", guard.acquired === true);

const DAEMON_PID_FILE = path.join(home, "daemon.pid"); // mirrors bin/loom.mjs's pidFilePath()

try {
  const env = { ...process.env, LOOM_HOME: home, LOOM_TEST: "1", LOOM_SUPPRESS_FIRST_RUN_LAUNCH: "1" };

  // PRIMARY teardown coverage (card 4e026f35 round 3 item 1, same rationale as
  // daemon-supervisor-start-guard-refused.mjs): argv/env-independent, started BEFORE the bounded run so
  // both race concurrently. In THIS checkout a regression here cannot actually reach a real daemon spawn
  // (resolveDaemonEntry() exits 1 first — see the header comment), so this watcher is expected to find
  // nothing either way; it's kept for parity with the supervisor test and as a safety net against this
  // checkout someday gaining a top-level dist/index.js (e.g. a packaged-layout test run).
  const pidWatcher = watchPidFileAndKill(DAEMON_PID_FILE, { maxWaitMs: HARD_BOUND_MS });

  const result = await runLoomStartDetachBounded(env, port);
  pidWatcher.cancel();
  const pidWatch = await pidWatcher.promise;

  check("[refused] loom start --detach exits 0 (refuses rather than erroring or double-starting)", result.code === 0);
  check("[refused] it did not hit the hard bound (no hang/regression)", result.timedOut === false);
  check("[refused] the refusal message says a start is already in progress", /a start for this LOOM_HOME\/port is already in progress/i.test(result.stdout));
  check("[refused] it never reached resolveDaemonEntry() — no 'daemon entry not found' / 'package looks incomplete' text", !/daemon entry not found|package looks incomplete/i.test(result.stderr));
  // Bounded generously but still utterly incompatible with having spawned a real child + waited on its
  // own 30s readiness bound — a regression that let this proceed would take >= 30s (the readiness
  // timeout) at minimum, not this.
  check(`[refused] exited fast (${result.elapsedMs}ms), proving it never reached the spawn/readiness-wait step`, result.elapsedMs < 5_000);
  check(`[refused] the pid-file watcher found nothing to kill (found=${pidWatch.found})`, pidWatch.found === false);
  // If the watcher ever DOES find something (a regression), it must never have killed
  // it without first confirming identity against the record's own `entry` field.
  check(`[refused] if the pid-file watcher found something, it only killed an identity-confirmed pid (identityConfirmed=${pidWatch.identityConfirmed})`, pidWatch.found === false || pidWatch.identityConfirmed === true);
} finally {
  guard.release();
}

// TEARDOWN SAFETY SCAN, SECONDARY (cmdline-scoped — see daemon-supervisor-start-guard-refused.mjs's own
// comment for why this is an EXTRA net, not the primary coverage: a `detached:true` grandchild's own
// command line never carries the scratch LOOM_HOME at all).
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

// DB INSPECTION (manager directive): before the fixture's own auto-cleanup removes the scratch directory,
// check for a lingering 'setup'-role session row — the one thing that would mean a real claude session was
// actually created. NOTE: loom.db always exists by this point because `prestampFirstRunMarker` itself
// creates it (to write the marker) — its mere existence says nothing about whether a real daemon also
// booted against it, so this inspection doesn't gate on existence, only on the session-row content.
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
  ? "\n✅ ALL PASS — `loom start --detach` racing an already-held start guard refuses outright (fast, before even resolving the daemon entry), via the SAME shared guard module this test holds the guard through, leaving no live process referencing the scratch LOOM_HOME and no real Setup session row."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
