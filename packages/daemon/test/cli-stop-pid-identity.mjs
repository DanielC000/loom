import "./_guard.mjs"; // suite consistency (sets LOOM_TEST=1); this test touches no Db.
// `loom stop`'s pid-identity check (bin/loom.mjs › stop, task a242c747). A pid file only proves SOME
// process is alive at that number — OS pids get reused after an unclean exit, so the old code could
// signal a totally unrelated live process (SIGTERM/SIGKILL, and on Windows `taskkill /PID <n> /T /F`,
// which kills that stranger's WHOLE process tree). Proves: a pid file whose recorded pid is alive but
// whose recorded PORT has nothing listening on it is treated as stale (cleaned, never signalled) —
// exactly the case where the port is confirmed unheld and the recorded pid can no longer be the daemon.
//
// REAL subprocesses, deliberately, per memory real-spawn-smoke-for-subprocess-features (a mocked exec
// impl never exercises the real cross-platform spawn/signal path — a Windows-only no-op would otherwise
// ship green): (1) a throwaway dummy child process standing in for "an unrelated live process that
// inherited the recorded pid", and (2) the ACTUAL shipped CLI entry (bin/loom.mjs), invoked as a
// subprocess exactly as an end user's shell would, never imported/mocked (memory
// loom-cli-symlinked-global-entry-guard: this file IS the shipped entry).
//
// Scope guard (memory worker-host-wide-kill-crashes-daemon): the ONLY process this test ever signals is
// the dummy child it spawned itself, killed via the handle it was spawned with — never by image name or
// port, and never a pid the test didn't create.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { useOwnLoomHome, finishAndExit } from "./_tmp-fixture.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, "..", "..", "..", "bin", "loom.mjs"); // packages/daemon/test → repo root

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Mirrors bin/loom.mjs's own `isAlive` (signal 0 probes without delivering) — used here only to OBSERVE
// the dummy's liveness from the test process, never to signal anything else.
function isAliveHere(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === "EPERM"; }
}

// A real, momentarily-bound-then-released loopback port — guaranteed nothing is listening on it once
// this resolves, so the CLI's HTTP probes reliably see ECONNREFUSED (never a flaky "maybe answered").
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
    srv.on("error", reject);
  });
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

const home = useOwnLoomHome("loom-stop-identity-");

// The dummy stand-in: a real process, alive, answering no HTTP at all — indistinguishable from a wedged
// daemon by pid-liveness alone, which is exactly the gap task a242c747 is about.
const dummy = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], { stdio: "ignore" });
await new Promise((resolve) => dummy.once("spawn", resolve));

try {
  const port = await freePort();
  fs.writeFileSync(
    path.join(home, "daemon.pid"),
    JSON.stringify(
      { pid: dummy.pid, port, url: `http://127.0.0.1:${port}`, version: "0.0.0", startedAt: new Date().toISOString() },
      null,
      2,
    ) + "\n",
  );

  check("dummy stand-in process is alive before stop()", isAliveHere(dummy.pid));

  const env = { ...process.env, LOOM_HOME: home, LOOM_TEST: "1" };
  const result = await runCli(["stop"], env);

  // THE POSITIVE CONTROL: against the pre-fix bin/loom.mjs this assertion FAILS — the old code signals
  // the bare pid unconditionally once the graceful hook gets no response, hard-killing (on win32:
  // `taskkill /PID <pid> /T /F`, which kills the WHOLE tree) a process that was never the Loom daemon.
  check("dummy stand-in process is STILL ALIVE after stop() (never signalled)", isAliveHere(dummy.pid));
  check("stop() exits 0 (treats the stale pid/port pairing like any other 'not running' case)", result.code === 0);
  check("stop() explains the PID is treated as stale, not that identity is certain", /treating the pid file as stale/i.test(result.stderr) && result.stderr.includes(String(dummy.pid)));
  check("stop() reports the still-alive process was NOT signalled (not that it's 'unrelated')", /not signalled/i.test(result.stdout) && !/unrelated/i.test(result.stdout));
  check("the PID file is cleaned (removed) rather than left pointing at the stranger", !fs.existsSync(path.join(home, "daemon.pid")));
} finally {
  // Cleanup: kill the dummy stand-in via the handle we spawned it with — never by name/port/rediscovery.
  try { dummy.kill("SIGKILL"); } catch { /* already gone */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — `loom stop` treats a pid whose recorded port has nothing listening as a stale record (cleaned, never signalled) instead of blind-killing whatever process now owns that pid."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
