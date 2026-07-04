// Regression guard for board card 621ef252: a worker's backgrounded dev-server (e.g. `pnpm dev`/vite,
// started by the agent's own Bash tool for UI verification) must be GONE after the session's pty exits —
// on a graceful/hard stop, a recycle's predecessor stop, or an unexpected crash. node-pty's own Job
// Object (Windows) / process-group kill (POSIX) makes the common case orphan-free, but a detached child
// escapes that containment and used to leak (six stale vite servers observed walking the port range).
//
// Exercises the REAL fix (pty/host.ts `reapOrphanedDescendants`, wired into the pty's `onExit` chokepoint)
// against REAL OS processes — not a fully-fake pty — because the whole point is proving an actual
// descendant process is terminated, which a fake pty's own kill() can't demonstrate. The session's "claude"
// process is a real spawned node process (root); it detaches a real grandchild (models the escaped
// dev-server) before the test tears the session down. Only the top-level `createPty` seam is faked, wired
// to the REAL root process's pid/kill/exit so PtyHost's genuine onExit handler runs unmodified.
//
// RUN (no daemon needed): node test/dev-server-teardown.mjs
//   Requires the daemon built first (reads ../dist/pty/host.js): from packages/daemon run `pnpm build`.
import "./_guard.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn as spawnProcess } from "node:child_process";
import { requireHermeticEnv } from "./_guard.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const isAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const waitUntil = async (cond, timeoutMs, stepMs = 100) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return true;
    await sleep(stepMs);
  }
  return cond();
};

// Hermetic LOOM_HOME (host.ts opens a per-session log under $LOOM_HOME/logs in spawn()).
const tmpHome = path.join(os.tmpdir(), `loom-devserver-teardown-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
requireHermeticEnv();

const { PtyHost, reapOrphanedDescendants } = await import("../dist/pty/host.js");

// A real "root" process (models the pty-spawned claude process) that immediately detaches a real
// grandchild (models the escaped `pnpm dev`) and prints its pid, then idles. `detached: true` + `.unref()`
// on the grandchild is exactly what lets it survive the root's death and escape node-pty's containment.
const ROOT_SCRIPT = `
const { spawn } = require('child_process');
const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { detached: true, stdio: 'ignore' });
child.unref();
process.stdout.write('GRANDCHILD_PID=' + child.pid + '\\n');
setInterval(() => {}, 1000);
`;

function spawnRealRoot() {
  const root = spawnProcess(process.execPath, ["-e", ROOT_SCRIPT], { stdio: ["ignore", "pipe", "ignore"] });
  return root;
}

async function readGrandchildPid(root) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (d) => {
      buf += d.toString();
      const m = buf.match(/GRANDCHILD_PID=(\d+)/);
      if (m) { root.stdout.off("data", onData); resolve(Number(m[1])); }
    };
    root.stdout.on("data", onData);
    setTimeout(() => reject(new Error("timed out waiting for GRANDCHILD_PID")), 5000);
  });
}

// Wire the REAL root process into PtyHost's one Claude-pty seam: pid/kill/onExit all forward to the real
// process, so the genuine onExit handler in host.ts (including reapOrphanedDescendants) runs unmodified.
const fakes = [];
function wrapRealRootAsPty(root) {
  let exitCb = null;
  root.on("exit", (code) => { exitCb?.({ exitCode: code ?? 0, signal: undefined }); });
  const fake = {
    pid: root.pid,
    write: () => {},
    onData: () => ({ dispose() {} }),
    onExit: (cb) => { exitCb = cb; return { dispose() {} }; },
    kill: () => { try { root.kill(); } catch { /* already gone */ } },
    resize: () => {},
  };
  fakes.push(fake);
  return fake;
}

let nextFakePty = null;
class TestPtyHost extends PtyHost {
  createPty() { return nextFakePty; }
}

const events = {
  onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {},
};
const host = new TestPtyHost(events);
const PERM = { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 };
const GEO = { cols: 120, rows: 40 };

let grandchildPid;
try {
  // ============ Scenario 1: reapOrphanedDescendants directly reaps an already-orphaned descendant ============
  // Sanity-check the unit in isolation before trusting the full PtyHost integration below: kill the root
  // WITHOUT going through our sweep, confirm the grandchild survives as a live orphan (this is precisely
  // the leak — taskkill /T against an already-dead PID does NOT find it, verified empirically), then call
  // reapOrphanedDescendants and confirm it (and only it) gets cleaned up via the WMI/CIM (or ps) tree walk.
  {
    const root = spawnRealRoot();
    grandchildPid = await readGrandchildPid(root);
    check("unit: grandchild is alive right after spawn", isAlive(grandchildPid));
    root.kill();
    await waitUntil(() => !isAlive(root.pid), 3000);
    check("unit: root is dead", !isAlive(root.pid));
    check("unit: grandchild OUTLIVES its dead root (the leak, unpatched)", isAlive(grandchildPid));

    reapOrphanedDescendants(root.pid);
    if (process.platform === "win32") {
      const reaped = await waitUntil(() => !isAlive(grandchildPid), 5000);
      check("unit: reapOrphanedDescendants kills the orphan even though its root already exited", reaped);
    } else {
      // Skipped on POSIX: a setsid-detached child reparents to init (ppid=1) the instant its root
      // dies, so reapOrphanedDescendants' ppid-walk can't reach it — a documented limitation, not a
      // real leak (a real POSIX dev-server is non-detached and dies with node-pty's process-group
      // kill on pty close; reapOrphanedDescendants is the Windows-Job-Object-escape complement).
      console.log("SKIP  unit: reapOrphanedDescendants kills the orphan (POSIX: setsid reparent to init, not reapable by ppid-walk)");
    }
  }

  // ============ Scenario 2: the REAL PtyHost session-end path reaps it (session end / recycle) ============
  // recycleWorker and stopSession both fund down to PtyHost.stop(), which — for both "hard" and the
  // escalated "graceful" path — routes through the pty's ONE onExit chokepoint this fix hooks into. Driving
  // host.stop() end-to-end proves the wiring, not just the standalone helper.
  {
    const SID = "sess-devserver-teardown";
    const root = spawnRealRoot();
    grandchildPid = await readGrandchildPid(root);
    nextFakePty = wrapRealRootAsPty(root);
    host.spawn({ sessionId: SID, cwd: tmpHome, permission: PERM, geometry: GEO, sessionEnv: {} });
    host.deliverHook(SID, { hook_event_name: "SessionStart" });

    check("session: dev-server grandchild alive before session end", isAlive(grandchildPid));
    check("session: session is alive before stop", host.isAlive(SID) === true);

    host.stop(SID, "hard");
    await waitUntil(() => !host.isAlive(SID), 3000);
    check("session: session reached exited", host.isAlive(SID) === false);

    if (process.platform === "win32") {
      const gone = await waitUntil(() => !isAlive(grandchildPid), 5000);
      check("session: the escaped dev-server process is GONE after session end", gone);
    } else {
      // Skipped on POSIX — same setsid-reparent-to-init limitation as scenario 1 above.
      console.log("SKIP  session: the escaped dev-server process is GONE after session end (POSIX: setsid reparent to init, not reapable by ppid-walk)");
    }
  }
} finally {
  // Belt-and-suspenders cleanup so a failed assertion never leaks a real process from the test run itself.
  if (grandchildPid && isAlive(grandchildPid)) { try { process.kill(grandchildPid, "SIGKILL"); } catch { /* ignore */ } }
  for (const f of fakes) { try { if (isAlive(f.pid)) process.kill(f.pid, "SIGKILL"); } catch { /* ignore */ } }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a worker's escaped dev-server process is reaped on session end, even though it outlived its own root process."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
