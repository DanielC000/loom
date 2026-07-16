import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Regression guard for card 7a6cc239: a per-session log `fs.WriteStream` (host.ts's `logStream`, 3
// construction sites: spawn/spawnShell/seedCanned) that emits 'error' with NO listener throws it back
// out of `.emit()` — unhandled, that crashes the ENTIRE daemon process (every live manager/worker pty
// lost), not just the one session's logging. Latent in production only because `ensureDirs()` guarantees
// the log dir exists at boot; a disk-full/permission/AV-lock/corrupt-volume write failure bypasses that.
//
// This forces a REAL fs-level stream error (not a synthetic `.emit`) by making the test's `logs` path a
// FILE instead of a directory, so `fs.createWriteStream` genuinely fails to open (ENOTDIR) — a real
// subprocess/stream-boundary failure, exercised through spawnShell's actual createWriteStream call.
// Proves: (a) the 'error' listener is attached SYNCHRONOUSLY (no race with the stream's own always-async
// error emission); (b) the real async open-error is handled, not crashed (no uncaughtException escapes);
// (c) the session/pty itself survives (only its on-disk log goes silent — `live.logBroken` flips true);
// (d) `writeLog` degrades to a genuine no-op afterward — more pty output doesn't re-throw or re-crash.
//
// Exercises the real PtyHost via the createShellPty() seam with a FAKE pty — NO real process, no
// network, no daemon. RUN (after `pnpm build`): node test/pty-log-stream-error.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

async function waitFor(fn, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) { if (fn()) return true; await new Promise((r) => setTimeout(r, 25)); }
  return false;
}

// Hermetic LOOM_HOME, set BEFORE import. Deliberately make `logs` a FILE (not a directory) so the real
// `fs.createWriteStream(path.join(LOGS_DIR, "<id>.log"))` call in spawnShell genuinely fails to open
// (ENOTDIR) — a real OS-level error, standing in for disk-full/permission/AV-lock/corrupt-volume.
const tmpHome = path.join(os.tmpdir(), `loom-logstream-test-${Date.now()}-${process.pid}`);
fs.mkdirSync(tmpHome, { recursive: true });
fs.writeFileSync(path.join(tmpHome, "logs"), "not a directory");
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { PtyHost } = await import("../dist/pty/host.js");

// A fake shell pty: records writes, captures the onData callback so the test can push more fake output
// AFTER the log stream has errored (proving writeLog's no-op guard), and fires onExit on kill().
const fakes = [];
function makeFakeShellPty() {
  const writes = [];
  let dataCb = null;
  let exitCb = null;
  const fake = {
    pid: 8181,
    write: (d) => { writes.push(d); },
    resize: () => {},
    onData: (cb) => { dataCb = cb; return { dispose() { dataCb = null; } }; },
    onExit: (cb) => { exitCb = cb; return { dispose() {} }; },
    kill: () => { if (exitCb) exitCb({ exitCode: 0 }); },
    emitData: (s) => { if (dataCb) dataCb(s); },
    writes,
  };
  fakes.push(fake);
  return fake;
}

class TestPtyHost extends PtyHost {
  createShellPty() { return makeFakeShellPty(); }
}

const events = {
  onEngineSessionId() {}, onBusy() {}, onContextStats() {},
  onRateLimited() {}, onExit() {},
};

// Safety net + detector: if the fix is missing, the stream's unhandled 'error' has zero listeners, so
// Node's EventEmitter throws it out of the (async, nextTick-scheduled) `.emit()` call — with no listener
// here that's a REAL process crash; with this listener installed it becomes an observed, non-fatal
// uncaughtException instead, so the buggy case reads as a clean test FAILURE rather than the whole test
// runner dying.
const uncaught = [];
const onUncaught = (err) => { uncaught.push(err); };
process.on("uncaughtException", onUncaught);

const host = new TestPtyHost(events);
const SID = "logstream-error-test-id";

try {
  host.spawnShell({ id: SID, cwd: tmpHome, command: "pwsh", args: ["-NoLogo"], geometry: { cols: 120, rows: 40 }, label: "demo · shell" });

  // The listener must be attached in the SAME synchronous tick as construction — before any async error
  // from the (genuinely broken) createWriteStream call could possibly land.
  const liveEntry = host.live.get(SID);
  check("log stream has an 'error' listener attached synchronously at construction", !!liveEntry && liveEntry.logStream.listenerCount("error") >= 1);
  check("session starts with logBroken=false", liveEntry.logBroken === false);

  // Wait for the real async ENOTDIR open-error to land and be handled.
  const brokeCleanly = await waitFor(() => host.live.get(SID)?.logBroken === true);
  check("a real log-stream open failure flips logBroken (handled, not thrown)", brokeCleanly);
  check("no uncaughtException escaped — the daemon process survives the log-stream error", uncaught.length === 0);
  check("the session/pty itself is unaffected — still alive after its log broke", host.isAlive(SID) === true);

  // Push more fake pty output AFTER the break: writeLog must silently no-op, never re-attempt/re-throw.
  const fake = fakes[0];
  fake.emitData("more terminal output after the log stream broke\r\n");
  fake.emitData("and some more\r\n");
  await new Promise((r) => setTimeout(r, 100));
  check("writeLog stays a no-op after logBroken (no new uncaughtException from further writes)", uncaught.length === 0);
  check("logBroken stays true (no spurious reset)", host.live.get(SID)?.logBroken === true);
  check("the session is still alive after further post-break output", host.isAlive(SID) === true);

  host.stop(SID, "hard");
  check("the session still exits cleanly (kill -> onExit -> logStream.end()) with no new crash", uncaught.length === 0);
} finally {
  process.off("uncaughtException", onUncaught);
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a broken per-session log stream degrades that session's logging to a no-op instead of crashing the daemon."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
