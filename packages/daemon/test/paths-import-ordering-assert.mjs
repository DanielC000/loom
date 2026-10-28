// Regression test for card 0ee30648 — the runtime assert that catches a test which imported `dist/`
// before setting LOOM_HOME/LOOM_PORT (paths.ts's __LOOM_PATHS_IMPORT_SNAPSHOT__, checked by
// test/_guard.mjs's requireHermeticEnv and test/_tmp-fixture.mjs's useOwnLoomHome — see
// docs/decisions/0ee30648-paths-import-ordering-runtime-assert.md for the full design).
//
// Each scenario below runs in its OWN child `node` process (module-scope consts can't be reset within
// one process) with HOME/USERPROFILE redirected to a throwaway scratch dir, so even a regression that
// fails to abort can never reach the real ~/.loom — this file is itself safe to run bare.
//
// Run: node test/paths-import-ordering-assert.mjs
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "./_guard.mjs"; // suite convention (arms LOOM_TEST=1); this orchestrator never itself touches dist
import { mkdtempManaged } from "./_tmp-fixture.mjs";

const __filename = fileURLToPath(import.meta.url);
const DAEMON_DIR = path.resolve(path.dirname(__filename), "..");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

async function runScenario(name) {
  if (name === "bad-home-port") {
    // A static/hoisted-equivalent dist import, THEN a re-point of BOTH LOOM_HOME and LOOM_PORT — the
    // exact hazard card 6ade208f found: dist loaded first, env fixed too late.
    const { requireHermeticEnv } = await import("./_guard.mjs");
    await import("../dist/paths.js"); // loads with the real default env
    process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-ordering-assert-fake-home-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.LOOM_PORT = "59991";
    requireHermeticEnv({ port: true });
    console.log("DID NOT ABORT");
    return;
  }
  if (name === "harness-preset") {
    // env set BEFORE dist is ever imported — the scripts/test-daemon.mjs harness convention. Never a
    // violation: the frozen snapshot is already non-default.
    process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-ordering-assert-harness-home-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.LOOM_PORT = "59992";
    const { requireHermeticEnv } = await import("./_guard.mjs");
    await import("../dist/paths.js");
    requireHermeticEnv({ port: true });
    console.log("PASSED");
    return;
  }
  if (name === "fresh-subdir-ordered") {
    // the correctly-ordered convention: useOwnLoomHome() before any dist import.
    const { useOwnLoomHome } = await import("./_tmp-fixture.mjs");
    useOwnLoomHome("loom-ordering-assert-fresh-");
    await import("../dist/paths.js");
    console.log("PASSED");
    return;
  }
  if (name === "fresh-subdir-nested") {
    // an ambient, already non-default LOOM_HOME set before dist is imported, THEN
    // useOwnLoomHome({fresh:true}) nests a subdirectory inside it — must not false-positive.
    process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-ordering-assert-ambient-home-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await import("../dist/paths.js");
    const { useOwnLoomHome } = await import("./_tmp-fixture.mjs");
    useOwnLoomHome("loom-ordering-assert-nested-", { fresh: true });
    console.log("PASSED");
    return;
  }
  if (name === "bad-useownloomhome") {
    // the useOwnLoomHome() twin of "bad-home-port" — dist imported first (default env), THEN
    // useOwnLoomHome() tries to re-point. Must throw, never silently proceed.
    await import("../dist/paths.js");
    const { useOwnLoomHome } = await import("./_tmp-fixture.mjs");
    useOwnLoomHome("loom-ordering-assert-bad-");
    console.log("DID NOT THROW");
    return;
  }
  throw new Error(`unknown scenario: ${name}`);
}

if (process.argv[2] === "__scenario__") {
  await runScenario(process.argv[3]);
  process.exit(0); // unreachable for a scenario that aborts/throws on its own (exit 99 / uncaught exception)
}

// --- orchestrator: spawn each scenario as its own child process, assert on the real outcome ---
function spawnScenario(name) {
  return new Promise((resolve) => {
    const scratchHome = mkdtempManaged("loom-ordering-assert-home-");
    const env = { ...process.env, HOME: scratchHome, USERPROFILE: scratchHome };
    delete env.HOMEDRIVE;
    delete env.HOMEPATH;
    delete env.LOOM_HOME;
    delete env.LOOM_PORT;
    const child = spawn(process.execPath, [__filename, "__scenario__", name], { cwd: DAEMON_DIR, env });
    let out = "";
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { out += d.toString(); });
    child.on("exit", (code) => resolve({ code, out }));
  });
}

const HOME_VIOLATION_RE = /dist\/paths\.js was imported while LOOM_HOME was still the real default/;
const PORT_VIOLATION_RE = /dist\/paths\.js was imported while LOOM_PORT was still the real default/;

{
  const r = await spawnScenario("bad-home-port");
  check("bad ordering (dist imported, then re-pointed): requireHermeticEnv aborts with exit 99", r.code === 99);
  check("bad ordering: names the LOOM_HOME violation", HOME_VIOLATION_RE.test(r.out));
  check("bad ordering: ALSO names the LOOM_PORT violation (one bad import exposes both)", PORT_VIOLATION_RE.test(r.out));
}

{
  const r = await spawnScenario("harness-preset");
  check("harness-preset (env set before dist import): passes, assert never fires",
    r.code === 0 && !HOME_VIOLATION_RE.test(r.out) && !PORT_VIOLATION_RE.test(r.out));
}

{
  const r = await spawnScenario("fresh-subdir-ordered");
  check("useOwnLoomHome() before dist import: passes, never throws",
    r.code === 0 && !HOME_VIOLATION_RE.test(r.out));
}

{
  const r = await spawnScenario("fresh-subdir-nested");
  check("useOwnLoomHome({fresh:true}) nesting an already-non-default ambient home: passes, no false positive",
    r.code === 0 && !HOME_VIOLATION_RE.test(r.out));
}

{
  const r = await spawnScenario("bad-useownloomhome");
  check("bad ordering via useOwnLoomHome(): throws (non-zero exit), never silently proceeds",
    r.code !== 0 && HOME_VIOLATION_RE.test(r.out));
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the paths.ts import-ordering assert fires exactly on a real re-point after an early dist import, and only there."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
