import "./_guard.mjs"; // suite consistency (sets LOOM_TEST=1); this test touches no Db.
// `scripts/daemon-supervisor-stop.mjs`'s pid-identity check (`isOurSupervisor`, card 03cc6cae). The
// original check was a bare `/daemon-supervisor\.mjs/i` substring match against the pid's live command
// line — matching ANY path containing that filename, including an unrelated project's own identically-
// named script. Now mirrors bin/loom.mjs's `isOurDaemon`: a recorded `entry` (the exact absolute path the
// detached child was spawned with) is checked first, falling back to a `scripts/`-anchored regex for a pid
// record predating that field.
//
// Scenarios (all via the real HARD-KILL fallback path — the recorded `port` is a freed loopback port with
// nothing listening, so `postShutdown`'s graceful hook unconditionally fails and `main()` falls straight to
// the identity-gated kill at the bottom, without needing an HTTP stand-in daemon at all):
//   SCENARIO 1 (recorded `entry`, exact match): a dummy process spawned FROM a given script path, with that
//   exact path recorded as `entry` — confirmed and hard-killed, proving the preferred exact-match tier.
//   SCENARIO 2 (legacy fallback, anchored, positive): no recorded `entry`, but the dummy's own path is
//   anchored under `scripts/daemon-supervisor.mjs` (the real self-hosting shape) — still confirmed and
//   killed, proving the tightened legacy fallback still recognizes a genuinely loom-shaped path.
//   SCENARIO 3 (legacy fallback, unanchored, negative — THE FIX): no recorded `entry`, and the dummy's path
//   merely CONTAINS the filename `daemon-supervisor.mjs` elsewhere (e.g. an unrelated project's own script
//   of the same name, not under a `scripts/` dir) — refused, never killed. The ORIGINAL bare regex matched
//   this unconditionally.
//
// REAL subprocesses throughout, per memory real-spawn-smoke-for-subprocess-features: a mocked exec impl
// never exercises the real cross-platform spawn/signal path. Scope guard (memory
// worker-host-wide-kill-crashes-daemon): the ONLY processes this test ever signals are the dummy children
// it spawned itself, killed via the handles they were spawned with — never by image name or port.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { useOwnLoomHome, mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STOP_SCRIPT = path.join(__dirname, "..", "..", "..", "scripts", "daemon-supervisor-stop.mjs"); // packages/daemon/test → repo root

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

function isAliveHere(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === "EPERM"; }
}

// A real, momentarily-bound-then-released loopback port — guaranteed nothing is listening on it, so the
// script's graceful hook reliably fails and falls straight to the identity-gated hard-kill section.
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

function runStopScript(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [STOP_SCRIPT], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

// A real, long-lived dummy process, spawned FROM `scriptPath` so its own live command line names that
// path — standing in for "the supervisor" (or an unrelated process whose path happens to resemble one).
function spawnDummyAt(scriptPath) {
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, "setInterval(() => {}, 60000);");
  const child = spawn(process.execPath, [scriptPath], { stdio: "ignore" });
  return new Promise((resolve) => child.once("spawn", () => resolve(child)));
}

function writeSupervisorPidRecord(home, pid, port, entry) {
  const rec = { pid, port, supervisorStartedAt: new Date().toISOString() };
  if (entry) rec.entry = entry;
  fs.writeFileSync(path.join(home, "daemon-supervisor.pid"), JSON.stringify(rec, null, 2) + "\n");
}

// === SCENARIO 1: recorded `entry` matches exactly → confirmed, hard-killed. =================================
{
  const tmpDir = mkdtempManaged("supervisor-stop-identity-entry-");
  const scriptPath = path.join(tmpDir, "totally-arbitrary-name.js"); // the exact-match tier doesn't care about shape
  const dummy = await spawnDummyAt(scriptPath);
  const home = useOwnLoomHome("supervisor-stop-identity-s1-");
  const port = await freePort();
  try {
    writeSupervisorPidRecord(home, dummy.pid, port, scriptPath);
    check("[S1] dummy process is alive before the stop script runs", isAliveHere(dummy.pid));

    const result = await runStopScript({ ...process.env, LOOM_HOME: home });

    check("[S1] dummy process is stopped (a real supervisor, whose record always carries `entry`, must stay killable)", !isAliveHere(dummy.pid));
    check("[S1] the stop script exits 0", result.code === 0);
    check("[S1] the stop script does NOT refuse on a command-line mismatch (the recorded entry matched)", !/does not confirm it as our supervisor/i.test(result.stderr));
    check("[S1] the pid file is cleaned up", !fs.existsSync(path.join(home, "daemon-supervisor.pid")));
  } finally {
    try { dummy.kill("SIGKILL"); } catch { /* already gone */ }
  }
}

// === SCENARIO 2: legacy record (no entry), path anchored under scripts/daemon-supervisor.mjs → confirmed, ==
// === hard-killed (the tightened legacy fallback still recognizes a genuinely loom-shaped path). ============
{
  const tmpDir = mkdtempManaged("supervisor-stop-identity-legacy-anchored-");
  const scriptPath = path.join(tmpDir, "scripts", "daemon-supervisor.mjs");
  const dummy = await spawnDummyAt(scriptPath);
  const home = useOwnLoomHome("supervisor-stop-identity-s2-");
  const port = await freePort();
  try {
    writeSupervisorPidRecord(home, dummy.pid, port, null); // legacy shape: no `entry`
    check("[S2] dummy process is alive before the stop script runs", isAliveHere(dummy.pid));

    const result = await runStopScript({ ...process.env, LOOM_HOME: home });

    check("[S2] dummy process is stopped (legacy fallback still recognizes a genuinely loom-shaped path)", !isAliveHere(dummy.pid));
    check("[S2] the stop script exits 0", result.code === 0);
    check("[S2] the stop script does NOT refuse on a command-line mismatch (the legacy fallback matched)", !/does not confirm it as our supervisor/i.test(result.stderr));
    check("[S2] the pid file is cleaned up", !fs.existsSync(path.join(home, "daemon-supervisor.pid")));
  } finally {
    try { dummy.kill("SIGKILL"); } catch { /* already gone */ }
  }
}

// === SCENARIO 3 (THE FIX): legacy record (no entry), path merely CONTAINS "daemon-supervisor.mjs" ==========
// === elsewhere (an unrelated project's own identically-named script, NOT under scripts/) → refused, =========
// === never killed. The ORIGINAL bare `/daemon-supervisor\.mjs/i` regex matched this unconditionally. ========
{
  const tmpDir = mkdtempManaged("supervisor-stop-identity-foreign-");
  const scriptPath = path.join(tmpDir, "some-other-project", "daemon-supervisor.mjs"); // no `scripts/` ancestor
  const dummy = await spawnDummyAt(scriptPath);
  const home = useOwnLoomHome("supervisor-stop-identity-s3-");
  const port = await freePort();
  try {
    writeSupervisorPidRecord(home, dummy.pid, port, null); // legacy shape: no `entry`
    check("[S3] foreign dummy process is alive before the stop script runs", isAliveHere(dummy.pid));

    const result = await runStopScript({ ...process.env, LOOM_HOME: home });

    // THE POSITIVE CONTROL: against the pre-03cc6cae bare regex this assertion FAILS — any path containing
    // the filename "daemon-supervisor.mjs" matched unconditionally and this foreign process was hard-killed.
    check("[S3] foreign dummy process is STILL ALIVE after the stop script runs (never signalled)", isAliveHere(dummy.pid));
    check("[S3] the stop script exits 1 (refuses rather than guessing)", result.code === 1);
    check("[S3] the stop script explains the command line does not confirm our supervisor", /does not confirm it as our supervisor/i.test(result.stderr) && result.stderr.includes(String(dummy.pid)));
    check("[S3] the pid file is left untouched (this is a refusal, not a resolved stale record)", fs.existsSync(path.join(home, "daemon-supervisor.pid")));
  } finally {
    try { dummy.kill("SIGKILL"); } catch { /* already gone */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — daemon-supervisor-stop.mjs never hard-kills a pid unless its command line is confirmed ours (the recorded exact `entry` path, or a narrow scripts/-anchored fallback for a legacy record) — never a foreign process whose path merely contains the same filename."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
