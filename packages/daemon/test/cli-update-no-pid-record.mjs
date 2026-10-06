import "./_guard.mjs"; // suite consistency (sets LOOM_TEST=1); this test touches no Db.
// `loom update` must never reach `npm i -g` while its target daemon is still live (card 0da5a3f7).
//
// THE ORIGINAL BUG (current main, before this card): `writePidFile` was called ONLY from `startDetached`
// — a foreground (bare `loom`/`loom start`) or OS-service (`loom start --no-open`) daemon never had a PID
// record. `stop()` returns 0 ("no PID file") the instant `readPidFile()` is null, *without ever
// attempting the graceful POST /internal/shutdown hook* — so `update()`'s "stop first" step treated that
// false "already stopped" as license to run `npm i -g` UNDER a still-live daemon.
//
// THE FIX under test here (bin/loom.mjs's update()): a USABLE pid record (rec && isAlive(rec.pid)) still
// goes through stop()'s full ladder; anything else (no record at all — this file's scenario) skips
// straight to stopViaLoopbackOnly, which NEVER signals (there's no pid to identify) and REFUSES the
// update outright unless the port is confirmed down within a bounded wait.
//
// NO REAL NPM, EVER (this file's scenarios, both RED-shaped and GREEN-shaped): the real `npm i -g
// loomctl@...` step is replaced end-to-end by LOOM_TEST_NPM_INSTALL_CMD (only active under LOOM_TEST=1),
// pointed at fixtures/fake-npm-install.mjs, which just drops a marker file instead of touching the real
// global npm registry. This is REAL-SPAWN testing of the actual shipped CLI (bin/loom.mjs run as a
// subprocess, never imported/mocked — memory loom-cli-symlinked-global-entry-guard), with only the
// daemon backend (a stand-in HTTP server) and the npm step faked — mirrors cli-stop-auth.mjs's own
// stand-in-daemon convention.
//
// RED/GREEN PROOF (recorded here, not re-run automatically every pass — see this file's own report):
// temporarily reverting update()'s `if (rec && isAlive(rec.pid)) { … } else { … }` branch back to an
// unconditional `const rc = await stop(); if (rc !== 0) { … }` (current main's shape) while KEEPING this
// file's fake-npm seam intact reproduces the exact bug: SCENARIO B below (a daemon that never honors the
// shutdown hook, no pid record) then FALSELY writes the fake-npm marker (proceeds to "install" a still-live
// daemon) and exits 0 instead of refusing — confirmed by hand before restoring the fix; GREEN afterward.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { useOwnLoomHome, finishAndExit } from "./_tmp-fixture.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, "..", "..", "..", "bin", "loom.mjs");
const FAKE_NPM = path.join(__dirname, "fixtures", "fake-npm-install.mjs");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

function isAliveHere(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === "EPERM"; }
}

function runCli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

// A minimal real HTTP server, in its own real subprocess, standing in for a live Loom daemon that has NO
// pid record on disk (exactly the bug's precondition). `behavior: "gracefulStop"` answers the shutdown
// hook and genuinely exits (mirrors a real daemon's graceful teardown); `"neverStops"` 404s the hook and
// stays alive forever (mirrors an old daemon predating the hook, or any daemon that just won't go down).
const STANDIN_SCRIPT = `
const http = require("node:http");
const behavior = process.env.STANDIN_BEHAVIOR;
const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/api/version") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ version: "0.0.0" }));
    return;
  }
  if (req.method === "POST" && req.url === "/internal/shutdown") {
    if (behavior === "gracefulStop") {
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, stopping: true }));
      setTimeout(() => process.exit(0), 50);
    } else {
      res.writeHead(404).end(); // never honors it — stays alive
    }
    return;
  }
  res.writeHead(404).end();
});
server.listen(0, "127.0.0.1", () => console.log("PORT=" + server.address().port));
`;

function spawnStandIn(behavior) {
  const child = spawn(process.execPath, ["-e", STANDIN_SCRIPT], {
    env: { ...process.env, STANDIN_BEHAVIOR: behavior },
    stdio: ["ignore", "pipe", "ignore"],
  });
  let buf = "";
  return new Promise((resolve, reject) => {
    const onData = () => {
      const m = /PORT=(\d+)/.exec(buf);
      if (m) { child.stdout.off("data", onData); resolve({ child, port: Number(m[1]) }); }
    };
    child.stdout.on("data", (c) => { buf += c; onData(); });
    child.once("error", reject);
    child.once("exit", (code) => { if (!/PORT=\d+/.test(buf)) reject(new Error(`stand-in exited before binding (code ${code})`)); });
  });
}

// Card 8378984b: {fresh:true} — scenarios (A)/(B) both assert "no PID file exists in this LOOM_HOME"
// before anything in this file has written one; that only holds under a genuinely pristine home.
const home = useOwnLoomHome("loom-update-no-pid-", { fresh: true });
let standInA, standInB;
try {
  // ===================== SCENARIO A: gracefully-stoppable daemon, NO pid record =====================
  // update() must stop it via the loopback hook alone (no signal — there's no pid to signal) and reach
  // the (faked) npm install step.
  {
    standInA = await spawnStandIn("gracefulStop");
    check("(A) no PID file exists in this LOOM_HOME", !fs.existsSync(path.join(home, "daemon.pid")));

    const markerA = path.join(home, "fake-npm-marker-a.json");
    const env = {
      ...process.env, LOOM_HOME: home, LOOM_TEST: "1", LOOM_PORT: String(standInA.port),
      LOOM_TEST_NPM_INSTALL_CMD: JSON.stringify([process.execPath, FAKE_NPM]),
      FAKE_NPM_MARKER: markerA,
    };
    const result = await runCli(["update"], env);

    check("(A) the stand-in daemon actually exited (gracefully stopped via the loopback hook)", !isAliveHere(standInA.child.pid));
    check("(A) update() reports the no-pid-record graceful stop", /no PID record/i.test(result.stdout) && /stopped \(graceful, no PID record\)/i.test(result.stdout));
    check("(A) update() reached the (fake) npm install step", fs.existsSync(markerA));
    if (fs.existsSync(markerA)) {
      const marker = JSON.parse(fs.readFileSync(markerA, "utf8"));
      check("(A) the fake npm was invoked with the resolved install spec", marker.argv.some((a) => /^loomctl@/.test(a)));
    }
    // NOT asserted: the final exit code / step-4 restart. update() unconditionally tries startDetached()
    // afterward (wasRunning was true), which needs a real <pkgRoot>/dist/index.js — absent in this
    // monorepo checkout (bin/loom.mjs's own header: it's not meant to run from the source tree). That's a
    // test-environment limitation of exercising step 4, not a property of the stop→install behavior this
    // scenario targets, so this file deliberately stops asserting once the install step is confirmed reached.
  }

  // ===================== SCENARIO B: daemon that never honors the hook, NO pid record ================
  // THE REGRESSION PROOF: update() must REFUSE — never reach npm install, never claim success.
  {
    standInB = await spawnStandIn("neverStops");
    check("(B) no PID file exists in this LOOM_HOME", !fs.existsSync(path.join(home, "daemon.pid")));
    check("(B) stand-in daemon is alive before update()", isAliveHere(standInB.child.pid));

    const markerB = path.join(home, "fake-npm-marker-b.json");
    const env = {
      ...process.env, LOOM_HOME: home, LOOM_TEST: "1", LOOM_PORT: String(standInB.port),
      LOOM_TEST_NPM_INSTALL_CMD: JSON.stringify([process.execPath, FAKE_NPM]),
      FAKE_NPM_MARKER: markerB,
    };
    const result = await runCli(["update"], env);

    check("(B) update() exits non-zero (refuses)", result.code === 1);
    check("(B) update() explains it's refusing, naming the still-live daemon", /refusing to update/i.test(result.stderr) && /still running/i.test(result.stderr));
    check("(B) update() NEVER reached the (fake) npm install step", !fs.existsSync(markerB));
    check("(B) the stand-in daemon was never signalled — still alive, untouched", isAliveHere(standInB.child.pid));
  }
} finally {
  try { standInA?.child.kill("SIGKILL"); } catch { /* already gone or self-exited */ }
  try { standInB?.child.kill("SIGKILL"); } catch { /* already gone */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — `loom update` (the REAL shipped CLI, run as a subprocess) never lets npm install proceed against a still-live daemon that has no usable PID record: it stops one that honors the graceful hook (no signal — there's nothing to signal), and REFUSES outright (never touching npm) when the hook is never honored."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
