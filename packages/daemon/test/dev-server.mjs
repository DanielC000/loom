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
//   (f) card 177b9e7f — CONTENDED-PORT positive control: `start` records the port the child ACTUALLY
//       bound, never the one it was configured/asked for. A decoy listener holds the configured port
//       first, so the fixture (mimicking a dev server that steps to the next free port under contention,
//       e.g. Vite) is FORCED to bind one higher; the recorded port must differ from the held one, must be
//       genuinely accepting connections (not just a text match), and must survive a completely separate
//       `stop` invocation re-reading it fresh from the tracking file (not just echoed once by `start`).
//   (g) card 1494d3d9 — the `0.0.0.0` mapping: a server bound to ALL interfaces isn't reachable AT
//       `0.0.0.0` itself, so the recorded url must map it to a concrete loopback host (`127.0.0.1`).
//   (h) card 1494d3d9 — THE POSITIVE CONTROL: a REAL single-stack (IPv6-loopback-ONLY) fixture proves the
//       recorded url connects where a naively-rebuilt `127.0.0.1` guess does not, against the SAME live,
//       healthy server — the exact failure class measured on this box against this repo's own `pnpm web`
//       (Vite bound `[::1]` only; `127.0.0.1` got ECONNREFUSED against a perfectly healthy server). A
//       dual-stack fixture would prove nothing here — either guess would connect.
//   (i) card 1494d3d9 DoD-5 — backward compatibility: `stop` tolerates a hand-authored OLD-shape tracking
//       file (port only, no host/url) without crashing.
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { observeOnce, assertNeverWithControl } from "./_timing-guard.mjs";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";

requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HELPER = path.join(__dirname, "..", "assets", "skills", "orchestrate", "scripts", "dev-server.mjs");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

check("(0) dev-server helper exists", fs.existsSync(HELPER));

const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
// Retrofitted onto the shared _wait.mjs waitUntil (card a19e4c02): same timeoutMs/stepMs budget, still
// returns true/false — a thrown predicate is a real bug and should propagate, not fold into false.
const waitUntil = async (predicate, timeoutMs = 5000, stepMs = 50) => {
  try {
    return !!(await sharedWaitUntil(predicate, { timeoutMs, intervalMs: stepMs, label: "dev-server: predicate" }));
  } catch (err) {
    if (!/waitUntil: timed out/.test(err?.message ?? "")) throw err;
    return false;
  }
};

// A tiny heartbeat fixture: writes the current time to `outFile` on an interval, forever, until killed.
// Its liveness is externally observable via both process.kill(pid,0) and the heartbeat file's mtime
// advancing — two independent signals a mis-scoped or no-op kill would fail to reproduce.
const heartbeatSrc = "const f=process.argv[2];setInterval(()=>{try{require('fs').writeFileSync(f,String(Date.now()))}catch{}},100);";
const fixtureDir = mkdtempManaged("loom-dev-server-fixture-");
const heartbeatScript = path.join(fixtureDir, "heartbeat.cjs");
fs.writeFileSync(heartbeatScript, heartbeatSrc);

const workDir = mkdtempManaged("loom-dev-server-work-");
const otherWorkDir = mkdtempManaged("loom-dev-server-other-");
const heartbeatOut = path.join(workDir, "heartbeat.txt");
const controlOut = path.join(otherWorkDir, "control.txt");

let trackedPid = null;
let controlChild = null;

// The heartbeat fixture never prints a port banner, so `start`'s own bounded port-detection wait would
// otherwise run to its full default (15000ms) on every call below — override it short so this section
// stays fast; the timeout mechanism itself is exercised for real by section (f)'s port fixture instead.
const FAST_PORT_TIMEOUT_ENV = { ...process.env, LOOM_DEV_SERVER_PORT_TIMEOUT_MS: "300" };

try {
  // (a) start: spawns the fixture, prints the pid, and the helper invocation itself exits promptly.
  const startResult = spawnSync(process.execPath, [HELPER, "start", workDir, "--", process.execPath, heartbeatScript, heartbeatOut], { encoding: "utf8", timeout: 10_000, env: FAST_PORT_TIMEOUT_ENV });
  check("(a) start exits 0", startResult.status === 0);
  check("(a) start prints the log path", /^Log: /m.test(startResult.stdout || ""));
  check("(a) start reports the binding as not detected (the fixture never announces one)", /Bound host:port not detected/.test(startResult.stdout || ""));
  const startMatch = /\(pid (\d+)\)/.exec(startResult.stdout || "");
  check("(a) start prints a pid", !!startMatch);
  trackedPid = startMatch ? Number(startMatch[1]) : null;

  check("(a) tracked pid is alive", trackedPid != null && isAlive(trackedPid));
  const heartbeatAdvanced = trackedPid != null && await waitUntil(() => fs.existsSync(heartbeatOut) && Date.now() - fs.statSync(heartbeatOut).mtimeMs < 2000);
  check("(a) fixture is actually running (heartbeat file advancing)", heartbeatAdvanced);

  // (e) a second start over the same still-alive dir must refuse, not spawn a second untracked process.
  const doubleStart = spawnSync(process.execPath, [HELPER, "start", workDir, "--", process.execPath, heartbeatScript, heartbeatOut], { encoding: "utf8", timeout: 10_000, env: FAST_PORT_TIMEOUT_ENV });
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
  const HEARTBEAT_INTERVAL_MS = 100; // the fixture's own write cadence (heartbeatSrc's setInterval, above)
  const mtimeOf = (f) => (fs.existsSync(f) ? fs.statSync(f).mtimeMs : 0);
  const heartbeatMtimeAfterKill = mtimeOf(heartbeatOut);
  const heartbeatStillFrozen = await assertNeverWithControl({
    label: "(b) fixture's heartbeat file stops advancing after stop()",
    check: () => mtimeOf(heartbeatOut) !== heartbeatMtimeAfterKill,
    windowMs: HEARTBEAT_INTERVAL_MS * 5, // several write intervals' worth — derived, not guessed
    positiveControl: async () => {
      // Prove the SAME sampling mechanism CAN observe advancement: the control process (never stopped)
      // is still writing its own heartbeat on the identical cadence — sample IT and confirm "advanced".
      const controlBaseline = mtimeOf(controlOut);
      return observeOnce({
        check: () => mtimeOf(controlOut) !== controlBaseline,
        windowMs: HEARTBEAT_INTERVAL_MS * 5,
      });
    },
  });
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
  // fixtureDir/workDir/otherWorkDir's own trailing cleanup loop removed here: mkdtempManaged already
  // registered each one for guaranteed cleanup at process exit (card 995be21f).
}

// (f) card 177b9e7f — contended-port positive control. A fixture that mimics a dev server stepping to
// the next free port under contention (e.g. Vite): it tries to bind its DESIRED port, and on EADDRINUSE
// retries the next one up, printing a Vite-shaped banner once it actually binds. It ALSO writes its own
// actual bound port to a sentinel file (argv[3]) — a GROUND TRUTH independent of both the helper's own
// extraction and of network probing, so this test's own verification can't be fooled by a coincidental
// listener elsewhere on a busy host answering on the wrong port (a live risk: this box runs plenty of
// other node processes at any given time).
//
// The fixture ALSO prints a DECOY host:port line (argv[4]) BEFORE its real banner — reproducing, byte
// for byte in shape, this repo's own `pnpm web`: `packages/web/vite.config.ts`'s `logProxyTarget` plugin
// prints "[web] proxying → http://127.0.0.1:<daemon port>" during `configureServer()`, which runs BEFORE
// Vite's own "Local: http://localhost:<port>/" ready banner — verified against a REAL captured `pnpm
// web` log, not assumed. A naive first-match extraction records the daemon's port, not the dev server's
// own; the manager review that caught this could not have been caught by a synthetic fixture that only
// ever emits one clean banner (project memory `a-control-inherits-the-equivalence-you-assumed-building-
// it`: a control is only as good as the corpus it runs against). The real banner ALSO has its port digits
// wrapped in ANSI color codes (`\x1b[1m5317\x1b[22m`) — reproduced here too, since an SGR code commonly
// contains a digit itself (bold is `\x1b[1m`) and that digit can land inside the port regex's own
// "non-digit gap" and silently break the match; this fixture's banner is byte-for-byte the real captured
// Vite line, not a hand-simplified stand-in.
const portFixtureSrc = [
  "const net = require('net');",
  "const fs = require('fs');",
  "const desired = Number(process.argv[2]);",
  "const sentinelFile = process.argv[3];",
  "const decoyProxyPort = Number(process.argv[4]);",
  "console.log('[fixture] proxying \\u2192 http://127.0.0.1:' + decoyProxyPort);",
  "function tryListen(port) {",
  "  const srv = net.createServer(() => {});",
  "  srv.once('error', (e) => {",
  "    if (e && e.code === 'EADDRINUSE') { tryListen(port + 1); }",
  "    else { console.error(String(e)); process.exit(1); }",
  "  });",
  "  srv.listen(port, '127.0.0.1', () => {",
  "    const actual = srv.address().port;",
  "    fs.writeFileSync(sentinelFile, String(actual));",
  "    console.log('  \\u001b[32m\\u2192\\u001b[39m  \\u001b[1mLocal\\u001b[22m:   \\u001b[36mhttp://localhost:\\u001b[1m' + actual + '\\u001b[22m/\\u001b[39m');",
  "  });",
  "}",
  "tryListen(desired);",
].join("\n");
const portFixtureScript = path.join(fixtureDir, "port-server.cjs");
fs.writeFileSync(portFixtureScript, portFixtureSrc);
const portSentinelFile = path.join(fixtureDir, "port-server-actual.txt");

function canConnect(port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port, timeout: timeoutMs });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
  });
}

// Like canConnect, but against an ARBITRARY host (not just 127.0.0.1) — needed for sections (g)/(h)
// below, which must prove a connection succeeds or fails against a SPECIFIC host string (a URL's own
// `.hostname`, which for an IPv6 literal the WHATWG URL parser keeps BRACKETED, e.g. "[::1]" — a
// socket connect needs the unbracketed literal, so strip a surrounding "[...]" here before connecting.
// Confirmed on real Linux (node:22-bookworm): a bracketed "[::1]" host fails ENOTFOUND, while the
// unbracketed "::1" connects — Windows silently tolerates the bracketed form, which is why this only
// ever showed up in CI, not the (Windows) merge gate.
function canConnectHost(host, port, timeoutMs = 2000) {
  const unbracketed = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: unbracketed, port, timeout: timeoutMs });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
  });
}

const portWorkDir = mkdtempManaged("loom-dev-server-port-");
let portTrackedPid = null;
let decoyServer = null;

try {
  // Hold a port first (the decoy) so the fixture's OWN first bind attempt is forced to fail and step —
  // port contention is the entire failure mode this control exists to catch (a test on an uncontended
  // port would prove nothing).
  decoyServer = net.createServer(() => {});
  const decoyPort = await new Promise((resolve, reject) => {
    decoyServer.once("error", reject);
    decoyServer.listen(0, "127.0.0.1", () => resolve(decoyServer.address().port));
  });

  // decoyPort does DOUBLE duty, deliberately: it's both the port the fixture must find contended and
  // step around (argv[2]), AND the port named in its pre-banner decoy "proxying" line (argv[4]) — one
  // number, playing the two roles the real `pnpm web` log conflates (the daemon's port is both a real,
  // live thing on the host AND the value a naive extraction would wrongly record).
  const startResult = spawnSync(
    process.execPath,
    [HELPER, "start", portWorkDir, "--", process.execPath, portFixtureScript, String(decoyPort), portSentinelFile, String(decoyPort)],
    { encoding: "utf8", timeout: 15_000, env: { ...process.env, LOOM_DEV_SERVER_PORT_TIMEOUT_MS: "5000" } },
  );
  check("(f) start (contended port) exits 0", startResult.status === 0);
  const portStartMatch = /\(pid (\d+)\)/.exec(startResult.stdout || "");
  portTrackedPid = portStartMatch ? Number(portStartMatch[1]) : null;

  const boundMatch = /Bound: (\S+) \(recorded/.exec(startResult.stdout || "");
  check("(f) start prints a Bound: url line", !!boundMatch);
  const boundUrl = boundMatch ? boundMatch[1] : null;
  let boundParsed = null;
  try { boundParsed = boundUrl ? new URL(boundUrl) : null; } catch { /* leave null — checked below */ }
  check("(f) start's bound url parses and carries the ACTUAL bound port", boundParsed != null);
  check("(f) recorded host is the banner's own token (localhost), captured alongside the port", boundParsed != null && boundParsed.hostname === "localhost");
  const recordedPort = boundParsed ? Number(boundParsed.port) : null;

  check(
    "(f) recorded port differs from the configured/decoy-proxy-line port — proves it's neither echoing " +
      "the config NOR picking up the pre-banner decoy line's port",
    recordedPort != null && recordedPort !== decoyPort,
  );

  // GROUND TRUTH: the fixture wrote its own actual bound port straight to a sentinel file, independent
  // of the helper's extraction logic and of any network probing. This is the check that can't be fooled
  // by a coincidental listener elsewhere on the host answering on the wrong port.
  const actualPort = fs.existsSync(portSentinelFile) ? Number(fs.readFileSync(portSentinelFile, "utf8")) : null;
  check("(f) fixture wrote its own ground-truth actual-port sentinel", actualPort != null && !Number.isNaN(actualPort));
  check(
    "(f) helper's recorded port EXACTLY matches the fixture's own ground-truth actual port",
    recordedPort != null && actualPort != null && recordedPort === actualPort,
  );

  const reallyBound = recordedPort != null && await canConnect(recordedPort);
  check("(f) the recorded port is genuinely accepting connections (not a hallucinated value)", reallyBound);

  // Independent re-verification: `stop` is a SEPARATE process invocation that must re-read the port from
  // the tracking file on disk — proving DoD-1 (the port is the tracking file's, not just something
  // `start` printed once and held in memory).
  const stopResult = spawnSync(process.execPath, [HELPER, "stop", portWorkDir], { encoding: "utf8", timeout: 10_000 });
  check("(f) stop exits 0", stopResult.status === 0);
  const stopPortMatch = /\(port (\d+)\)/.exec(stopResult.stdout || "");
  check(
    "(f) stop's own fresh re-read of the tracking file reports the SAME actual bound port",
    !!stopPortMatch && recordedPort != null && Number(stopPortMatch[1]) === recordedPort,
  );

  const portGone = recordedPort != null && await waitUntil(async () => !(await canConnect(recordedPort)), 5000);
  check("(f) the port is freed after stop()", portGone);
} catch (e) {
  console.log(`FAIL  unexpected error (contended-port control): ${(e && e.stack) || e}`);
  failures++;
} finally {
  if (portTrackedPid != null && isAlive(portTrackedPid)) { try { process.kill(portTrackedPid, "SIGKILL"); } catch { /* best effort */ } }
  if (decoyServer) { try { decoyServer.close(); } catch { /* best effort */ } }
}

// (g) card 1494d3d9 DoD-2 — the `0.0.0.0` mapping. A server bound to ALL interfaces isn't reachable AT
// `0.0.0.0` itself (that's a BIND address, not something anything can CONNECT to) — the helper must map
// it to a concrete loopback host (`127.0.0.1`) rather than emitting an unusable url verbatim.
const anyIfaceFixtureSrc = [
  "const net = require('net');",
  "const srv = net.createServer(() => {});",
  "srv.listen(0, '0.0.0.0', () => {",
  "  const actual = srv.address().port;",
  "  console.log('  \\u001b[32m\\u2192\\u001b[39m  \\u001b[1mLocal\\u001b[22m:   \\u001b[36mhttp://0.0.0.0:\\u001b[1m' + actual + '\\u001b[22m/\\u001b[39m');",
  "});",
].join("\n");
const anyIfaceScript = path.join(fixtureDir, "any-iface-server.cjs");
fs.writeFileSync(anyIfaceScript, anyIfaceFixtureSrc);
const anyIfaceWorkDir = mkdtempManaged("loom-dev-server-anyiface-");
let anyIfaceTrackedPid = null;

try {
  const startResult = spawnSync(
    process.execPath,
    [HELPER, "start", anyIfaceWorkDir, "--", process.execPath, anyIfaceScript],
    { encoding: "utf8", timeout: 15_000, env: { ...process.env, LOOM_DEV_SERVER_PORT_TIMEOUT_MS: "5000" } },
  );
  check("(g) start (0.0.0.0 bind) exits 0", startResult.status === 0);
  const anyIfaceStartMatch = /\(pid (\d+)\)/.exec(startResult.stdout || "");
  anyIfaceTrackedPid = anyIfaceStartMatch ? Number(anyIfaceStartMatch[1]) : null;

  const boundMatch = /Bound: (\S+) \(recorded/.exec(startResult.stdout || "");
  check("(g) start prints a Bound: url line", !!boundMatch);
  const boundUrl = boundMatch ? boundMatch[1] : null;
  let parsed = null;
  try { parsed = boundUrl ? new URL(boundUrl) : null; } catch { /* leave null — checked below */ }
  check(
    "(g) 0.0.0.0 is mapped to a concrete loopback host (127.0.0.1), never emitted verbatim as an " +
      "unreachable bind address",
    parsed != null && parsed.hostname === "127.0.0.1",
  );

  const reallyBound = parsed != null && await canConnectHost(parsed.hostname, Number(parsed.port));
  check("(g) the mapped 127.0.0.1 url genuinely connects to the 0.0.0.0-bound server", reallyBound);

  // Tear down via the helper's OWN `stop` (taskkill /T on win32) — the tracked pid is the SUPERVISOR
  // (see dev-server.mjs's own SUPERVISOR note); a bare SIGKILL on just that pid leaves its real child
  // (the actual net server holding this section's cwd) alive as an orphan, which then blocks this temp
  // dir's own cleanup at process exit (EBUSY) — `stop` is what correctly kills the whole subtree.
  spawnSync(process.execPath, [HELPER, "stop", anyIfaceWorkDir], { encoding: "utf8", timeout: 10_000 });
} catch (e) {
  console.log(`FAIL  unexpected error (0.0.0.0 mapping control): ${(e && e.stack) || e}`);
  failures++;
} finally {
  if (anyIfaceTrackedPid != null && isAlive(anyIfaceTrackedPid)) { try { process.kill(anyIfaceTrackedPid, "SIGKILL"); } catch { /* best effort */ } }
}

// (h) card 1494d3d9 DoD-4 — THE POSITIVE CONTROL. Measured on this box against this repo's own real
// `pnpm web` (Vite): the dev server bound `[::1]` ONLY — `http://localhost:5317/` (equivalently
// `http://[::1]:5317/`) connected, `http://127.0.0.1:5317/` got ECONNREFUSED against a perfectly healthy
// server. A DUAL-STACK fixture would prove nothing here — either guess would connect, which is exactly
// why this fixture binds IPv6 LOOPBACK ONLY: a genuine single-stack specimen, not a synthetic stand-in
// that happens to pass either way.
const ipv6OnlyFixtureSrc = [
  "const net = require('net');",
  "const srv = net.createServer(() => {});",
  "srv.listen(0, '::1', () => {",
  "  const actual = srv.address().port;",
  "  console.log('  \\u001b[32m\\u2192\\u001b[39m  \\u001b[1mLocal\\u001b[22m:   \\u001b[36mhttp://[::1]:\\u001b[1m' + actual + '\\u001b[22m/\\u001b[39m');",
  "});",
].join("\n");
const ipv6OnlyScript = path.join(fixtureDir, "ipv6-only-server.cjs");
fs.writeFileSync(ipv6OnlyScript, ipv6OnlyFixtureSrc);
const ipv6WorkDir = mkdtempManaged("loom-dev-server-ipv6only-");
let ipv6TrackedPid = null;

try {
  // Confirm THIS host can actually bind IPv6 loopback before trusting the rest of this section — if it
  // can't, `start` would fail for an environment reason unrelated to the code under test, and every
  // downstream check here would be meaningless. Logged explicitly (never a silent skip) so a genuine
  // gap in coverage on some future host is visible, not mistaken for a pass.
  const probeSrv = net.createServer(() => {});
  const canBindV6 = await new Promise((resolve) => {
    probeSrv.once("error", () => resolve(false));
    probeSrv.listen(0, "::1", () => resolve(true));
  });
  if (canBindV6) await new Promise((r) => probeSrv.close(r));

  if (!canBindV6) {
    console.log("SKIP  (h) IPv6-loopback positive control — this host cannot bind ::1, so the single-stack specimen this card requires can't be reproduced here");
  } else {
    const startResult = spawnSync(
      process.execPath,
      [HELPER, "start", ipv6WorkDir, "--", process.execPath, ipv6OnlyScript],
      { encoding: "utf8", timeout: 15_000, env: { ...process.env, LOOM_DEV_SERVER_PORT_TIMEOUT_MS: "5000" } },
    );
    check("(h) start (IPv6-loopback-only bind) exits 0", startResult.status === 0);
    const ipv6StartMatch = /\(pid (\d+)\)/.exec(startResult.stdout || "");
    ipv6TrackedPid = ipv6StartMatch ? Number(ipv6StartMatch[1]) : null;

    const boundMatch = /Bound: (\S+) \(recorded/.exec(startResult.stdout || "");
    check("(h) start prints a Bound: url line", !!boundMatch);
    const boundUrl = boundMatch ? boundMatch[1] : null;
    let parsed = null;
    try { parsed = boundUrl ? new URL(boundUrl) : null; } catch { /* leave null — checked below */ }
    // Node's URL parser keeps an IPv6 hostname bracketed (`u.hostname === "[::1]"`, not `"::1"`) — verify
    // against that real behavior rather than the unbracketed form.
    check("(h) recorded host is the banner's own [::1] token, not a guessed default", parsed != null && parsed.hostname === "[::1]");

    // THE CONTROL, part 1: the RECORDED url connects to the real IPv6-only server.
    const recordedConnects = parsed != null && await canConnectHost(parsed.hostname, Number(parsed.port));
    check("(h) the recorded url connects to the real IPv6-only server", recordedConnects);

    // THE CONTROL, part 2: a NAIVELY-REBUILT url — the exact guess a port-only tracking file would force
    // a consumer to make — does NOT connect, against the SAME live, healthy server on the SAME port; only
    // the host differs. This is the proof the card's DoD demands: the recorded url succeeds precisely
    // where a port-only guess fails, on a genuine single-stack specimen (not a dual-stack server that
    // would let either guess through).
    const naiveConnects = parsed != null && await canConnectHost("127.0.0.1", Number(parsed.port));
    check(
      "(h) THE POSITIVE CONTROL: a naively-rebuilt 127.0.0.1 url refuses against this SAME healthy " +
        "server — proving the recorded url connects precisely where a port-only guess fails",
      naiveConnects === false,
    );

    // Tear down via the helper's OWN `stop` — see the matching note in section (g): a bare SIGKILL on
    // just the tracked (supervisor) pid leaves its real child (the net server holding this section's
    // cwd) alive as an orphan.
    spawnSync(process.execPath, [HELPER, "stop", ipv6WorkDir], { encoding: "utf8", timeout: 10_000 });
  }
} catch (e) {
  console.log(`FAIL  unexpected error (IPv6-only positive control): ${(e && e.stack) || e}`);
  failures++;
} finally {
  if (ipv6TrackedPid != null && isAlive(ipv6TrackedPid)) { try { process.kill(ipv6TrackedPid, "SIGKILL"); } catch { /* best effort */ } }
}

// (i) card 1494d3d9 DoD-5 — backward compatibility. A tracking file written by the OLDER helper (before
// this card) has no `url`/`host`, only `port`. CONSUMER CHECKED: this file's own `stop()` — it reads
// `tracked.port` defensively (`typeof tracked.port === "number"`) and never assumes `host`/`url` exist,
// so it must tolerate the old shape rather than crash. Exercised against a HAND-AUTHORED old-shape
// tracking file (not the current writer's own output), so this genuinely tests tolerance of a shape the
// current code no longer produces, rather than restating what `start` already writes.
const oldShapeWorkDir = mkdtempManaged("loom-dev-server-oldshape-");
try {
  const oldShapeAbsDir = path.resolve(oldShapeWorkDir);
  const oldShapeHash = crypto.createHash("sha256").update(oldShapeAbsDir).digest("hex").slice(0, 16);
  const oldShapeTrackFile = path.join(os.tmpdir(), `loom-dev-server-${oldShapeHash}.json`);
  // A pid that is definitely NOT alive, so killTracked's best-effort kill is a genuine no-op — this
  // section is about SHAPE tolerance, not process lifecycle (already covered by sections a/b/e).
  const deadPid = 999999;
  check("(i) chosen dead pid is genuinely not alive (test precondition)", !isAlive(deadPid));
  fs.writeFileSync(oldShapeTrackFile, JSON.stringify({
    pid: deadPid, command: ["old-helper-fixture"], dir: oldShapeAbsDir,
    startedAt: new Date().toISOString(), logFile: "/nonexistent", port: 4321,
    // deliberately NO host/url fields — this IS the pre-fix shape under test.
  }), "utf8");

  const stopResult = spawnSync(process.execPath, [HELPER, "stop", oldShapeWorkDir], { encoding: "utf8", timeout: 10_000 });
  check("(i) stop on an OLD-shape (no url/host) tracking file exits 0, doesn't crash", stopResult.status === 0);
  check("(i) stop still reports the old record's port", /\(port 4321\)/.test(stopResult.stdout || ""));
  check(
    "(i) stop's output carries no literal 'undefined' from an unguarded host/url read",
    !/undefined/.test(stopResult.stdout || ""),
  );
} catch (e) {
  console.log(`FAIL  unexpected error (old-shape tracking file tolerance): ${(e && e.stack) || e}`);
  failures++;
}

// (j) card 7d0eceab — THE POSITIVE CONTROL, the whole point of this card: the LAUNCHER used to read the
// log for the FIRST time before the DETACHED supervisor had truncated it (that truncation happens inside
// the supervisor's own just-spawned node process, which is still booting). A leftover, PARSEABLE, AFFIRMED
// banner from a PREVIOUS run at the same <dir> was read as if it were this run's — a test with no
// pre-existing log cannot exercise this at all, which is exactly what every prior fix in this area
// (6cfbc55, 942abd6f) lacked. This plants a stale, affirmed banner naming port A at the dir's tracking log
// BEFORE calling `start`, then launches a REAL fixture that binds a different, OS-chosen port B, and
// asserts the recorded port is B — never A.
const staleRaceFixtureSrc = [
  "const net = require('net');",
  "const fs = require('fs');",
  "const sentinelFile = process.argv[2];",
  "const srv = net.createServer(() => {});",
  "srv.listen(0, '127.0.0.1', () => {",
  "  const actual = srv.address().port;",
  "  fs.writeFileSync(sentinelFile, String(actual));",
  "  console.log('  \\u001b[32m\\u2192\\u001b[39m  \\u001b[1mLocal\\u001b[22m:   \\u001b[36mhttp://localhost:\\u001b[1m' + actual + '\\u001b[22m/\\u001b[39m');",
  "});",
].join("\n");
const staleRaceFixtureScript = path.join(fixtureDir, "stale-race-server.cjs");
fs.writeFileSync(staleRaceFixtureScript, staleRaceFixtureSrc);
const staleRaceSentinelFile = path.join(fixtureDir, "stale-race-actual.txt");

// Re-derive the helper's own pathHash/logFilePath so this test can plant a log at the EXACT path `start`
// will read from for a given <dir> — outside the ephemeral OS-assigned range (Linux ~32768-60999, Windows
// default dynamic range starts at 49152) so it can never coincidentally collide with the fixture's own
// OS-chosen bound port.
function pathHashForTest(absDir) {
  return crypto.createHash("sha256").update(absDir).digest("hex").slice(0, 16);
}
const STALE_PORT = 22222;
const staleRaceWorkDir = mkdtempManaged("loom-dev-server-stalerace-");
const staleRaceAbsDir = path.resolve(staleRaceWorkDir);
const staleRaceLogPath = path.join(os.tmpdir(), `loom-dev-server-${pathHashForTest(staleRaceAbsDir)}.log`);
let staleRaceTrackedPid = null;

try {
  // Plant the stale, PARSEABLE, AFFIRMED banner — a genuine "previous run's" log — BEFORE `start` is ever
  // invoked for this dir.
  fs.writeFileSync(
    staleRaceLogPath,
    `  \x1b[32m\u2192\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m${STALE_PORT}\x1b[22m/\x1b[39m\n`,
    "utf8",
  );
  check("(j) stale log planted at the dir's tracking log path (test precondition)", fs.existsSync(staleRaceLogPath));

  const startResult = spawnSync(
    process.execPath,
    [HELPER, "start", staleRaceWorkDir, "--", process.execPath, staleRaceFixtureScript, staleRaceSentinelFile],
    { encoding: "utf8", timeout: 15_000, env: { ...process.env, LOOM_DEV_SERVER_PORT_TIMEOUT_MS: "5000" } },
  );
  check("(j) start (stale-log race control) exits 0", startResult.status === 0);
  const staleRaceStartMatch = /\(pid (\d+)\)/.exec(startResult.stdout || "");
  staleRaceTrackedPid = staleRaceStartMatch ? Number(staleRaceStartMatch[1]) : null;

  const boundMatch = /Bound: (\S+) \(recorded/.exec(startResult.stdout || "");
  check("(j) start prints a Bound: url line", !!boundMatch);
  const boundUrl = boundMatch ? boundMatch[1] : null;
  let boundParsed = null;
  try { boundParsed = boundUrl ? new URL(boundUrl) : null; } catch { /* leave null — checked below */ }
  const recordedPort = boundParsed ? Number(boundParsed.port) : null;

  // GROUND TRUTH: the fixture wrote its own actual bound port straight to a sentinel file, independent of
  // both the helper's extraction and of the planted stale content.
  const actualPort = fs.existsSync(staleRaceSentinelFile) ? Number(fs.readFileSync(staleRaceSentinelFile, "utf8")) : null;
  check("(j) fixture wrote its own ground-truth actual-port sentinel", actualPort != null && !Number.isNaN(actualPort));

  check(
    "(j) THE POSITIVE CONTROL: recorded port is the NEW run's actual bound port, never the stale planted one",
    recordedPort != null && recordedPort !== STALE_PORT && actualPort != null && recordedPort === actualPort,
  );

  // Independent re-verification: `stop` is a SEPARATE process invocation that must re-read the (correct)
  // port from the tracking file on disk, not just echo what `start` printed once in-process.
  const stopResult = spawnSync(process.execPath, [HELPER, "stop", staleRaceWorkDir], { encoding: "utf8", timeout: 10_000 });
  check("(j) stop exits 0", stopResult.status === 0);
  const stopPortMatch = /\(port (\d+)\)/.exec(stopResult.stdout || "");
  check(
    "(j) stop's own fresh re-read of the tracking file also reports the NEW port, never the stale one",
    !!stopPortMatch && recordedPort != null && Number(stopPortMatch[1]) === recordedPort,
  );
} catch (e) {
  console.log(`FAIL  unexpected error (stale-log race control): ${(e && e.stack) || e}`);
  failures++;
} finally {
  if (staleRaceTrackedPid != null && isAlive(staleRaceTrackedPid)) { try { process.kill(staleRaceTrackedPid, "SIGKILL"); } catch { /* best effort */ } }
}

// (k) card eb503d1f — cwd-relative keying. `dir` used to be resolved via a bare `path.resolve(dir)`,
// which for a RELATIVE <dir> depends on THIS PROCESS's own cwd at call time — invisible to a reader of
// the command and easy to get wrong when a session's shell cwd drifts between a `start` and a later
// `stop` for what the caller still believes is "the same worktree" (the worker doctrine's own "a Bash cd
// leaks into every later call" warning, applied to this helper). Pre-fix this let `start .` (cwd at the
// worktree root) succeed and track a real pid, then a LATER `stop .` issued after the cwd drifted to a
// subdirectory resolve to a DIFFERENT tracking file, report "nothing to do", and leave the real tracked
// process ORPHANED. The fix requires an absolute <dir> and refuses a relative one loudly, in BOTH start
// and stop, so the ambiguity can never silently arise.
//
// RED-PROOF (run manually to confirm this section fails against the pre-fix helper; not part of this
// file's own execution — same convention as clock-path-regression-guard.mjs's own manual positive
// control):
//   1. git diff -- packages/daemon/assets/skills/orchestrate/scripts/dev-server.mjs > /tmp/eb503d1f.patch
//   2. git checkout HEAD -- packages/daemon/assets/skills/orchestrate/scripts/dev-server.mjs
//   3. node packages/daemon/test/dev-server.mjs → section (k)'s refusal checks FAIL: `start .` (cwd at
//      the worktree root) exits 0 and tracks a real pid instead of refusing; a later `stop .` (cwd at a
//      drifted subdirectory) exits 0 reporting "nothing to do" instead of refusing, and the real tracked
//      process is left alive.
//   4. git apply /tmp/eb503d1f.patch (restores the fix) → section (k) PASSES again.
const cwdBugWorktree = mkdtempManaged("loom-dev-server-cwdbug-");
const cwdBugSubdir = path.join(cwdBugWorktree, "subdir");
fs.mkdirSync(cwdBugSubdir);
const cwdBugHeartbeatOut = path.join(cwdBugWorktree, "hb.txt");
const cwdBugTrackFile = path.join(os.tmpdir(), `loom-dev-server-${pathHashForTest(path.resolve(cwdBugWorktree))}.json`);
let cwdBugAbsTrackedPid = null;

try {
  // `start`, invoked with the process cwd AT the worktree root and a RELATIVE "." — a plausible, natural
  // way to invoke this (cd into the worktree, then pass ".").
  const relStart = spawnSync(
    process.execPath,
    [HELPER, "start", ".", "--", process.execPath, heartbeatScript, cwdBugHeartbeatOut],
    { encoding: "utf8", timeout: 10_000, cwd: cwdBugWorktree, env: FAST_PORT_TIMEOUT_ENV },
  );
  check("(k) start refuses a relative <dir> (nonzero exit) — the ambiguity is foreclosed before any tracking file is written", relStart.status !== 0);
  check("(k) start's refusal names the problem, not a silent no-op", /must be an absolute path/.test(relStart.stderr || ""));
  check("(k) a refused start wrote no tracking file at all", !fs.existsSync(cwdBugTrackFile));

  // stop is refused the same way, from a DIFFERENT cwd (the subdir) — the drifted-cwd half of the same
  // scenario, proving the guard isn't order- or cwd-dependent.
  const relStop = spawnSync(process.execPath, [HELPER, "stop", "."], { encoding: "utf8", timeout: 10_000, cwd: cwdBugSubdir });
  check("(k) stop ALSO refuses a relative <dir>, from a different (drifted) cwd (nonzero exit)", relStop.status !== 0);
  check("(k) stop's refusal names the problem too", /must be an absolute path/.test(relStop.stderr || ""));

  // The sanctioned calling convention (absolute <dir>) is unaffected by the invoking process's own cwd:
  // start from one cwd, stop from a DIFFERENT cwd again, both using the SAME absolute <dir> — must find
  // and stop the SAME tracked process. This is the "one file, two cwds" positive proof DoD-5 asks for,
  // cashed out against the design this fix chose (require absolute, don't invent a stable anchor).
  const absStart = spawnSync(
    process.execPath,
    [HELPER, "start", cwdBugWorktree, "--", process.execPath, heartbeatScript, cwdBugHeartbeatOut],
    { encoding: "utf8", timeout: 10_000, cwd: cwdBugSubdir, env: FAST_PORT_TIMEOUT_ENV }, // deliberately NOT cwdBugWorktree
  );
  check("(k) start with an ABSOLUTE <dir> succeeds regardless of the invoking process's own cwd", absStart.status === 0);
  const absStartMatch = /\(pid (\d+)\)/.exec(absStart.stdout || "");
  cwdBugAbsTrackedPid = absStartMatch ? Number(absStartMatch[1]) : null;
  check("(k) tracked pid is alive", cwdBugAbsTrackedPid != null && isAlive(cwdBugAbsTrackedPid));

  const absStop = spawnSync(process.execPath, [HELPER, "stop", cwdBugWorktree], { encoding: "utf8", timeout: 10_000, cwd: os.tmpdir() }); // yet ANOTHER cwd
  check(
    "(k) stop with the SAME absolute <dir>, from a THIRD different cwd, finds and reports the same tracked pid",
    cwdBugAbsTrackedPid != null && absStop.stdout.includes(String(cwdBugAbsTrackedPid)),
  );
  const absGone = cwdBugAbsTrackedPid != null && await waitUntil(() => !isAlive(cwdBugAbsTrackedPid), 5000);
  check("(k) the absolute-<dir> tracked process is actually stopped", absGone);
} catch (e) {
  console.log(`FAIL  unexpected error (cwd-relative keying guard): ${(e && e.stack) || e}`);
  failures++;
} finally {
  if (cwdBugAbsTrackedPid != null && isAlive(cwdBugAbsTrackedPid)) { try { process.kill(cwdBugAbsTrackedPid, "SIGKILL"); } catch { /* best effort */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — dev-server.mjs starts a tracked dev-server and tears it down by its exact pid, leaving unrelated processes untouched, records the ACTUAL bound port (not the configured one) even under port contention, records a directly-usable url alongside the port (mapping 0.0.0.0 to a concrete loopback host), that recorded url connects on a real single-stack server where a naively-rebuilt one refuses, and requires an absolute <dir> — refusing a relative one loudly rather than silently keying off the invoking process's own cwd."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
