import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card (orchestrate manager-eyeball dev-server teardown): a manager's OWN Playwright eyeball dev-server
// left running against a worker's worktree holds the dir open, so worker_merge_confirm's
// `git worktree remove` fails on Windows. Today the manager hand-hunts locale-fragile `netstat` output
// + `taskkill` — brittle, and a name/port kill can reach a process it never spawned. Fix: a bundled
// helper (dev-server.mjs, sibling to serve-static.mjs) that launches a dev-server, RECORDS the exact
// child pid it spawned, and tears it down by that exact pid on demand — never a name/port search.
//
// REAL-SPAWN test (per the repo's "mocking the exec impl never exercises the actual cross-platform
// spawn/kill" rule): this test invokes the actual dev-server.mjs CLI as a real child process against a
// real fixture child it starts, and confirms teardown kills THAT exact process by its tracked pid.
//
// Proves:
//   (a) `start` spawns the command, prints the pid, and returns immediately (the fixture keeps running);
//   (b) `stop` kills the exact tracked pid — the fixture process is confirmably gone afterward;
//   (c) a SEPARATE, unrelated process (started outside the helper, not tracked for this dir) survives
//       `stop` untouched — proving the kill is scoped to the tracked pid, never a bare/wrong pid, never
//       a broader name/port sweep;
//   (d) `stop` on a directory with no tracked server is a safe no-op (exit 0, no error);
//   (e) `start` refuses to double-track a still-alive server for the same dir.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";

requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HELPER = path.join(__dirname, "..", "assets", "skills", "orchestrate", "scripts", "dev-server.mjs");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

check("(0) dev-server helper exists", fs.existsSync(HELPER));

const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitUntil = async (predicate, timeoutMs = 5000, stepMs = 50) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
};

// A tiny heartbeat fixture: writes the current time to `outFile` on an interval, forever, until killed.
// Its liveness is externally observable via both process.kill(pid,0) and the heartbeat file's mtime
// advancing — two independent signals a mis-scoped or no-op kill would fail to reproduce.
const heartbeatSrc = "const f=process.argv[2];setInterval(()=>{try{require('fs').writeFileSync(f,String(Date.now()))}catch{}},100);";
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-dev-server-fixture-"));
const heartbeatScript = path.join(fixtureDir, "heartbeat.cjs");
fs.writeFileSync(heartbeatScript, heartbeatSrc);

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-dev-server-work-"));
const otherWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-dev-server-other-"));
const heartbeatOut = path.join(workDir, "heartbeat.txt");
const controlOut = path.join(otherWorkDir, "control.txt");

let trackedPid = null;
let controlChild = null;

try {
  // (a) start: spawns the fixture, prints the pid, and the helper invocation itself exits promptly.
  const startResult = spawnSync(process.execPath, [HELPER, "start", workDir, "--", process.execPath, heartbeatScript, heartbeatOut], { encoding: "utf8", timeout: 10_000 });
  check("(a) start exits 0", startResult.status === 0);
  const startMatch = /\(pid (\d+)\)/.exec(startResult.stdout || "");
  check("(a) start prints a pid", !!startMatch);
  trackedPid = startMatch ? Number(startMatch[1]) : null;

  check("(a) tracked pid is alive", trackedPid != null && isAlive(trackedPid));
  const heartbeatAdvanced = trackedPid != null && await waitUntil(() => fs.existsSync(heartbeatOut) && Date.now() - fs.statSync(heartbeatOut).mtimeMs < 2000);
  check("(a) fixture is actually running (heartbeat file advancing)", heartbeatAdvanced);

  // (e) a second start over the same still-alive dir must refuse, not spawn a second untracked process.
  const doubleStart = spawnSync(process.execPath, [HELPER, "start", workDir, "--", process.execPath, heartbeatScript, heartbeatOut], { encoding: "utf8", timeout: 10_000 });
  check("(e) double-start over a live tracked dir refuses (nonzero exit)", doubleStart.status !== 0);

  // (c) an unrelated control process, never registered with the helper, must survive the coming stop().
  controlChild = spawn(process.execPath, [heartbeatScript, controlOut], { stdio: "ignore" });
  const controlUp = await waitUntil(() => fs.existsSync(controlOut) && Date.now() - fs.statSync(controlOut).mtimeMs < 2000);
  check("(c) control process is running before stop()", controlUp && isAlive(controlChild.pid));

  // (b) stop: kills exactly the tracked pid.
  const stopResult = spawnSync(process.execPath, [HELPER, "stop", workDir], { encoding: "utf8", timeout: 10_000 });
  check("(b) stop exits 0", stopResult.status === 0);
  check("(b) stop reports the tracked pid", trackedPid != null && stopResult.stdout.includes(String(trackedPid)));

  const trackedGone = trackedPid != null && await waitUntil(() => !isAlive(trackedPid), 5000);
  check("(b) tracked pid is gone after stop()", trackedGone);
  const heartbeatMtimeAfterKill = fs.existsSync(heartbeatOut) ? fs.statSync(heartbeatOut).mtimeMs : 0;
  await new Promise((r) => setTimeout(r, 400));
  const heartbeatStillFrozen = !fs.existsSync(heartbeatOut) || fs.statSync(heartbeatOut).mtimeMs === heartbeatMtimeAfterKill;
  check("(b) fixture's heartbeat file stops advancing after stop()", heartbeatStillFrozen);

  // (c) the unrelated control process is UNAFFECTED — this is the "never a bare/wrong pid" proof: if
  // stop() had swept by name/port instead of the tracked pid, this sibling node process would be dead too.
  check("(c) unrelated control process survives stop() untouched", isAlive(controlChild.pid));

  // (d) stop on a dir with nothing tracked is a safe no-op.
  const noopStop = spawnSync(process.execPath, [HELPER, "stop", otherWorkDir], { encoding: "utf8", timeout: 10_000 });
  check("(d) stop with no tracked server exits 0", noopStop.status === 0);
  check("(d) stop with no tracked server says so, not an error", /nothing to do/.test(noopStop.stdout || ""));
} catch (e) {
  console.log(`FAIL  unexpected error: ${(e && e.stack) || e}`);
  failures++;
} finally {
  if (trackedPid != null && isAlive(trackedPid)) { try { process.kill(trackedPid, "SIGKILL"); } catch { /* best effort */ } }
  if (controlChild) { try { controlChild.kill("SIGKILL"); } catch { /* best effort */ } }
  for (const d of [fixtureDir, workDir, otherWorkDir]) {
    for (let i = 0; i < 5; i++) { try { fs.rmSync(d, { recursive: true, force: true }); break; } catch { /* retry */ } }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — dev-server.mjs starts a tracked dev-server and tears it down by its exact pid, leaving unrelated processes untouched."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
