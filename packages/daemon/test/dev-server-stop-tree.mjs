import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 1f654c91: the bundled dev-server helper's `stop` must leave nothing of the launched server
// behind, verify the recorded port is free, and never kill a pid that is no longer the supervisor it
// launched. REAL-spawn test: the actual dev-server.mjs CLI is run as a child process against real
// wrapper -> listener process trees (the `pnpm -> vite` shape); no exec seam is mocked.
//
// Proves:
//   (a) a wrapper that spawns a child LISTENER and stays alive (the pnpm -> vite shape): after `stop` the
//       listener is dead and its port is free, and `stop` says so ("Verified: port N is free").
//       CONTROL, not a regression proof: the pre-fix helper already tree-kills this shape.
//   (b) pid reuse: a tracking file whose pid is alive but is NOT the supervisor launched for that dir
//       (a real unrelated process) — `stop` REFUSES (nonzero) and that process survives.
//       Fails on the pre-fix helper, which killed whatever pid the file named.
//   (c) an orphaned listener (its launcher exited, so the tracked pid's tree no longer reaches it): `stop`
//       must NOT claim success — nonzero exit + "STILL IN USE" — and must not kill it by port. The test
//       kills that listener itself, by the pid the listener printed.
//       Fails on the pre-fix helper, which printed "Stopped" and exited 0 with the port still bound.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { waitUntil } from "./_wait.mjs";

const HELPER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../assets/skills/orchestrate/scripts/dev-server.mjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "loom-devserver-stoptree-"));
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const cleanupPids = [];

// Listener prints a Vite-style banner + its own pid; prints nothing else.
fs.writeFileSync(path.join(root, "listener.cjs"), `
const s = require("http").createServer((q, r) => r.end("ok"));
s.listen(0, "127.0.0.1", () => { console.log("LISTENER_PID=" + process.pid); console.log("  Local: http://localhost:" + s.address().port + "/"); });
`);
// Wrapper spawns the listener; mode "stay" keeps the wrapper alive (pnpm -> vite), "exit" exits after the
// listener is up, leaving it orphaned (a launcher that daemonizes its server).
fs.writeFileSync(path.join(root, "wrapper.cjs"), `
const c = require("child_process").spawn(process.execPath, [process.argv[2]], { stdio: "inherit", detached: process.argv[3] === "exit" });
if (process.argv[3] === "exit") { c.unref(); setTimeout(() => process.exit(0), 1500); } else { setInterval(() => {}, 1000); }
`);

const helper = (...args) => spawnSync(process.execPath, [HELPER, ...args], { encoding: "utf8", timeout: 60000, env: { ...process.env, LOOM_DEV_SERVER_PORT_TIMEOUT_MS: "15000" } });
const trackingFor = (dir) => JSON.parse(fs.readFileSync(path.join(os.tmpdir(), `loom-dev-server-${crypto_hash(dir)}.json`), "utf8"));
import crypto from "node:crypto";
function crypto_hash(d) { return crypto.createHash("sha256").update(d).digest("hex").slice(0, 16); }
const portHeld = (port) => new Promise((resolve) => {
  const s = net.connect({ port, host: "127.0.0.1" });
  s.once("connect", () => { s.destroy(); resolve(true); });
  s.once("error", () => resolve(false));
});
const listenerPidFromLog = (logFile) => Number(/LISTENER_PID=(\d+)/.exec(fs.readFileSync(logFile, "utf8"))?.[1]);
const newDir = (name) => { const d = path.join(root, name); fs.mkdirSync(d); return d; };

try {
  // (a) wrapper stays alive
  {
    const dir = newDir("a");
    const st = helper("start", dir, "--", process.execPath, path.join(root, "wrapper.cjs"), path.join(root, "listener.cjs"), "stay");
    const rec = trackingFor(dir);
    const lpid = listenerPidFromLog(rec.logFile);
    cleanupPids.push(lpid);
    check("(a) start recorded a bound port and the listener is up", st.status === 0 && typeof rec.port === "number" && isAlive(lpid) && await portHeld(rec.port));
    const stop = helper("stop", dir);
    await waitUntil(() => !isAlive(lpid), { timeoutMs: 10000, label: "(a) listener dead" }).catch(() => {});
    check("(a) after stop the listener process is dead", !isAlive(lpid));
    check("(a) after stop the port is free, and stop said so", !(await portHeld(rec.port)) && stop.status === 0 && /Verified: port \d+ is free/.test(stop.stdout));
  }
  // (b) pid reuse: tracking file names a live, unrelated process
  {
    const dir = newDir("b");
    const bystander = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    cleanupPids.push(bystander.pid);
    fs.writeFileSync(path.join(os.tmpdir(), `loom-dev-server-${crypto_hash(dir)}.json`), JSON.stringify({ pid: bystander.pid, command: ["x"], dir, startedAt: new Date().toISOString(), logFile: path.join(root, "b-never-launched.log"), port: null, host: null, url: null }));
    const stop = helper("stop", dir);
    check("(b) stop REFUSED (nonzero) for a pid that is not the launched supervisor", stop.status !== 0 && /REFUSED/.test(stop.stderr));
    check("(b) the unrelated process survived", isAlive(bystander.pid));
  }
  // (c) orphaned listener
  {
    const dir = newDir("c");
    const st = helper("start", dir, "--", process.execPath, path.join(root, "wrapper.cjs"), path.join(root, "listener.cjs"), "exit");
    const rec = trackingFor(dir);
    const lpid = listenerPidFromLog(rec.logFile);
    cleanupPids.push(lpid);
    await waitUntil(() => !isAlive(rec.pid), { timeoutMs: 15000, label: "(c) supervisor exited with its launcher" }).catch(() => {});
    check("(c) fixture is the orphan shape: listener alive on the recorded port, tracked pid gone", st.status === 0 && isAlive(lpid) && !isAlive(rec.pid) && await portHeld(rec.port));
    const stop = helper("stop", dir);
    check("(c) stop does NOT claim success while the port is still held (nonzero + STILL IN USE)", stop.status !== 0 && /STILL IN USE/.test(stop.stderr));
    check("(c) stop did not kill the orphan by port", isAlive(lpid));
  }
} finally {
  for (const pid of cleanupPids) { try { if (pid && isAlive(pid)) process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  await new Promise((r) => setTimeout(r, 500)); // let killed processes release their cwd handles
  for (const d of ["a", "b", "c"]) { try { fs.unlinkSync(path.join(os.tmpdir(), `loom-dev-server-${crypto_hash(path.join(root, d))}.json`)); } catch { /* absent */ } }
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* best-effort temp cleanup */ }
}
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
