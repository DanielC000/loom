import "./_guard.mjs"; // suite consistency (sets LOOM_TEST=1); this test touches no Db.
// `loom stop`'s pid-identity checks (bin/loom.mjs › stop, task a242c747 + card 279c0208). A pid file only
// proves SOME process is alive at that number — OS pids get reused after an unclean exit, so the old code
// could signal a totally unrelated live process (SIGTERM/SIGKILL, and on Windows `taskkill /PID <n> /T
// /F`, which kills that stranger's WHOLE process tree). Scenarios:
//   SCENARIO 1 (a242c747, port-based): a pid file whose recorded pid is alive but whose recorded PORT has
//   nothing listening on it is treated as stale (cleaned, never signalled) — the port is confirmed unheld,
//   so the recorded pid can no longer be the daemon.
//   SCENARIO 2 (279c0208, command-line, no recorded entry): a pid file whose recorded pid IS alive AND
//   holds the recorded port (so the port-based check alone resolves "timeout" — the case the OLD code let
//   straight through to the signal ladder, reasoning "must stay killable") but whose live command line does
//   NOT match a loom process is now ALSO refused, never signalled.
//   SCENARIO 3 (279c0208, PRIMARY mechanism — the recorded `entry` path): same port-held/unresponsive
//   shape, but the pid record carries the EXACT `entry` path the port-holder was actually launched with —
//   proves the preferred, exact-match tier works and a genuinely wedged real daemon (which always carries
//   this field, written at spawn time) stays killable.
//   SCENARIO 3b (279c0208 review, reviewer 679816fc's repro — MUST be RED on eb958016): a LEGACY pid record
//   (no `entry` field, as a pre-279c0208 CLI would have written) whose port-holder's command line merely
//   CONTAINS "dist/index.js" — a foreign Node app's own bundler output, nothing to do with Loom — is now
//   REFUSED, never signalled. The ORIGINAL (bugged) regex matched this unconditionally and hard-killed it.
//   SCENARIO 3c (279c0208 review, legacy fallback positive case): the SAME legacy-record shape, but the
//   port-holder's path IS anchored under a `loomctl` directory (`.../loomctl/dist/index.js` — the real
//   detached-daemon shape a pre-279c0208 CLI would have produced) — still killed, proving the tightened
//   legacy fallback still recognizes a genuinely loom-shaped path, just no longer an unanchored one.
//   SCENARIO 4 (card 03cc6cae, hook.status===404 branch): a REAL HTTP stand-in that 404s
//   `/internal/shutdown` (a daemon predating the hook) but has a non-loom command line and no recorded
//   `entry` is now REFUSED, never signalled — before 03cc6cae this branch had NO identity check at all and
//   any 404 response was treated as identity-confirmed.
//   SCENARIO 5 (card 03cc6cae, hook.status===401 branch): same shape, but the stand-in 401s
//   `/internal/shutdown` unconditionally (a rejected credential) — also now refused rather than killed.
//   SCENARIO 6 (card 03cc6cae, hook.status 202 but waitForDown TIMES OUT): the stand-in ACKs the shutdown
//   POST with 202 but never actually exits (an un-signalled process that merely answered once) — `graceful`
//   stays false, and the now-widened identity check still gates the fall-through even though `hook.status`
//   is DEFINED (202), not `undefined`. Uses LOOM_TEST_STOP_WAIT_FOR_DOWN_MS to keep this fast.
//
// REAL subprocesses, deliberately, per memory real-spawn-smoke-for-subprocess-features (a mocked exec
// impl never exercises the real cross-platform spawn/signal path — a Windows-only no-op would otherwise
// ship green): (1) throwaway dummy child processes standing in for "an unrelated live process that
// inherited the recorded pid", and (2) the ACTUAL shipped CLI entry (bin/loom.mjs), invoked as a
// subprocess exactly as an end user's shell would, never imported/mocked (memory
// loom-cli-symlinked-global-entry-guard: this file IS the shipped entry).
//
// Scope guard (memory worker-host-wide-kill-crashes-daemon): the ONLY processes this test ever signals are
// the dummy children it spawned itself, killed via the handles they were spawned with — never by image
// name or port, and never a pid the test didn't create.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { useOwnLoomHome, mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, "..", "..", "..", "bin", "loom.mjs"); // packages/daemon/test → repo root
const { LEGACY_DAEMON_CMDLINE_RE } = await import(pathToFileURL(BIN).href);

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

// A real node process that BINDS the given ephemeral TCP port, accepts connections, and never writes a
// response — the CLI's HTTP probes (the graceful shutdown hook, then the port-classification probe) both
// connect successfully but time out waiting for a reply, so `classifyPortResponse` resolves "timeout", not
// "refused": the exact shape the OLD code let straight through to the signal ladder on the assumption it
// must be a genuinely wedged real daemon (SCENARIO 1 above already covers "refused" — nothing listening at
// all). `scriptPath`, when given, is where the spawned script is written to and run FROM (any parent dirs
// created as needed) — its own live command line then names that path, letting SCENARIO 2/3/3b/3c below
// control whether it matches a loom process or not. Always plain CommonJS (a `.js` file with no ancestor
// `package.json` defaults to CJS, and `node -e` always runs as CJS too), so one script body covers both
// forms. Resolves once the port is confirmed bound.
const PORT_HOLDER_SCRIPT =
  "const net=require('node:net');" +
  "const srv=net.createServer((s)=>{s.on('error',()=>{});});" +
  "srv.on('error',(e)=>{console.error(e);process.exit(1);});" +
  "srv.listen(0,'127.0.0.1',()=>{console.log(JSON.stringify({port:srv.address().port}));});";
function spawnPortHolder(scriptPath) {
  if (scriptPath) {
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(scriptPath, PORT_HOLDER_SCRIPT);
  }
  const child = spawn(process.execPath, scriptPath ? [scriptPath] : ["-e", PORT_HOLDER_SCRIPT], { stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((resolve, reject) => {
    let buf = "";
    child.stdout.on("data", (c) => {
      if (buf.includes('"port"')) return;
      buf += c;
      const m = buf.match(/\{"port":\d+\}/);
      if (m) resolve({ child, port: JSON.parse(m[0]).port });
    });
    child.once("error", reject);
    child.once("exit", (code) => { if (!buf.includes('"port"')) reject(new Error(`port-holder exited early (code ${code})`)); });
  });
}

// A real HTTP stand-in (card 03cc6cae scenarios 4-6) that answers GET /api/version 200 always, and
// POST /internal/shutdown according to `mode`: "404" (no hook at all), "401" (rejects every credential), or
// "ack-no-exit" (202-acks but never actually exits — simulates a process that answered once but is not
// really the daemon shutting down). Always plain CommonJS (mirrors PORT_HOLDER_SCRIPT's own reasoning).
function standInScriptFor(mode) {
  return (
    "const http=require('node:http');" +
    "const srv=http.createServer((req,res)=>{" +
    "if(req.method==='GET'&&req.url==='/api/version'){res.writeHead(200,{'content-type':'application/json'});res.end('{}');return;}" +
    "if(req.method==='POST'&&req.url==='/internal/shutdown'){" +
    (mode === "404"
      ? "res.writeHead(404).end();"
      : mode === "401"
        ? "res.writeHead(401,{'content-type':'application/json'});res.end('{}');"
        : "res.writeHead(202,{'content-type':'application/json'});res.end('{}');") +
    "return;}" +
    "res.writeHead(404).end();});" +
    "srv.on('error',(e)=>{console.error(e);process.exit(1);});" +
    "srv.listen(0,'127.0.0.1',()=>{console.log(JSON.stringify({port:srv.address().port}));});"
  );
}
function spawnHttpStandIn(scriptPath, mode) {
  if (scriptPath) {
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(scriptPath, standInScriptFor(mode));
  }
  const script = standInScriptFor(mode);
  const child = spawn(process.execPath, scriptPath ? [scriptPath] : ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((resolve, reject) => {
    let buf = "";
    child.stdout.on("data", (c) => {
      if (buf.includes('"port"')) return;
      buf += c;
      const m = buf.match(/\{"port":\d+\}/);
      if (m) resolve({ child, port: JSON.parse(m[0]).port });
    });
    child.once("error", reject);
    child.once("exit", (code) => { if (!buf.includes('"port"')) reject(new Error(`http stand-in exited early (code ${code})`)); });
  });
}

// Writes a pid record for `holder` at `port`, with `entry` set ONLY when `entry` is truthy (a legacy
// record predating card 279c0208's field omits it entirely — matching what a pre-fix CLI actually wrote).
function writeRecordFor(holder, port, entry) {
  const rec = { pid: holder.pid, port, url: `http://127.0.0.1:${port}`, version: "0.0.0", startedAt: new Date().toISOString() };
  if (entry) rec.entry = entry;
  fs.writeFileSync(path.join(home, "daemon.pid"), JSON.stringify(rec, null, 2) + "\n");
}

const home = useOwnLoomHome("loom-stop-identity-");
const env = { ...process.env, LOOM_HOME: home, LOOM_TEST: "1" };

// === SCENARIO 1 (task a242c747): port confirmed UNHELD → stale cleanup, never signalled. =============
{
  // The dummy stand-in: a real process, alive, answering no HTTP at all — indistinguishable from a wedged
  // daemon by pid-liveness alone, which is exactly the gap task a242c747 is about.
  const dummy = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], { stdio: "ignore" });
  await new Promise((resolve) => dummy.once("spawn", resolve));

  try {
    const port = await freePort();
    writeRecordFor(dummy, port, null);

    check("[S1] dummy stand-in process is alive before stop()", isAliveHere(dummy.pid));

    const result = await runCli(["stop"], env);

    // THE POSITIVE CONTROL: against the pre-fix bin/loom.mjs this assertion FAILS — the old code signals
    // the bare pid unconditionally once the graceful hook gets no response, hard-killing (on win32:
    // `taskkill /PID <pid> /T /F`, which kills the WHOLE tree) a process that was never the Loom daemon.
    check("[S1] dummy stand-in process is STILL ALIVE after stop() (never signalled)", isAliveHere(dummy.pid));
    check("[S1] stop() exits 0 (treats the stale pid/port pairing like any other 'not running' case)", result.code === 0);
    check("[S1] stop() explains the PID is treated as stale, not that identity is certain", /treating the pid file as stale/i.test(result.stderr) && result.stderr.includes(String(dummy.pid)));
    check("[S1] stop() reports the still-alive process was NOT signalled (not that it's 'unrelated')", /not signalled/i.test(result.stdout) && !/unrelated/i.test(result.stdout));
    check("[S1] the PID file is cleaned (removed) rather than left pointing at the stranger", !fs.existsSync(path.join(home, "daemon.pid")));
  } finally {
    // Cleanup: kill the dummy stand-in via the handle we spawned it with — never by name/port/rediscovery.
    try { dummy.kill("SIGKILL"); } catch { /* already gone */ }
  }
}

// === SCENARIO 2 (card 279c0208): port HELD + unresponsive ("timeout"), NO recorded `entry` (legacy shape),
// === and a command line that matches NEITHER tier → refused, never signalled. ============================
{
  const { child: holder, port } = await spawnPortHolder(); // plain `node -e <script>` — no "loom" anywhere on its command line
  try {
    writeRecordFor(holder, port, null);

    check("[S2] port-holder process is alive before stop()", isAliveHere(holder.pid));

    const result = await runCli(["stop"], env);

    // THE POSITIVE CONTROL: against pre-279c0208 bin/loom.mjs this assertion FAILS — the old code treats
    // "port held but unresponsive" as proof enough of a genuinely wedged real daemon and hard-kills this
    // pid (on win32: `taskkill /PID <pid> /T /F`, killing the WHOLE tree) with no command-line check at all.
    check("[S2] port-holder process is STILL ALIVE after stop() (never signalled)", isAliveHere(holder.pid));
    check("[S2] stop() exits 1 (refuses rather than guessing)", result.code === 1);
    check("[S2] stop() explains the command line does not confirm the loom daemon", /does not confirm it as the loom daemon/i.test(result.stderr) && result.stderr.includes(String(holder.pid)));
    check("[S2] stop() names the manual fallback command rather than silently doing nothing", /kill -9|taskkill/i.test(result.stderr));
    check("[S2] the PID file is left untouched (this is a refusal, not a resolved stale record)", fs.existsSync(path.join(home, "daemon.pid")));
  } finally {
    try { holder.kill("SIGKILL"); } catch { /* already gone */ }
  }
}

// === SCENARIO 3 (card 279c0208, PRIMARY mechanism): the SAME port-held/unresponsive shape, but the pid ===
// === record carries the EXACT `entry` path the port-holder was launched with → stays killable. ===========
{
  const tmpDir = mkdtempManaged("loom-stop-identity-entry-");
  const scriptPath = path.join(tmpDir, "totally-arbitrary-name.js"); // the exact-match tier doesn't care about shape
  const { child: holder, port } = await spawnPortHolder(scriptPath);
  try {
    writeRecordFor(holder, port, scriptPath);

    check("[S3] port-holder process is alive before stop()", isAliveHere(holder.pid));

    const result = await runCli(["stop"], env);

    check("[S3] port-holder process is stopped (a real wedged daemon, whose record always carries `entry`, must stay killable)", !isAliveHere(holder.pid));
    check("[S3] stop() exits 0", result.code === 0);
    check("[S3] stop() does NOT refuse on a command-line mismatch (the recorded entry matched)", !/does not confirm it as the loom daemon/i.test(result.stderr));
    check("[S3] the PID file is cleaned up", !fs.existsSync(path.join(home, "daemon.pid")));
  } finally {
    try { holder.kill("SIGKILL"); } catch { /* already gone */ }
  }
}

// === SCENARIO 3b (card 279c0208 review — reviewer 679816fc's repro; MUST be RED on commit eb958016): a ===
// === LEGACY record (no `entry`) whose port-holder's path merely CONTAINS "dist/index.js" — a FOREIGN =====
// === Node app's own bundler output, nothing to do with Loom — is refused, never signalled. ================
{
  const tmpDir = mkdtempManaged("loom-stop-identity-foreign-");
  const scriptPath = path.join(tmpDir, "some-other-node-app", "dist", "index.js");
  const { child: holder, port } = await spawnPortHolder(scriptPath);
  try {
    writeRecordFor(holder, port, null); // legacy shape: no `entry` — exactly what a pre-279c0208 CLI wrote

    check("[S3b] foreign port-holder process is alive before stop()", isAliveHere(holder.pid));

    const result = await runCli(["stop"], env);

    // THE POSITIVE CONTROL: against commit eb958016 (the unanchored `dist[\/]index\.js|loom(\.mjs)?`
    // regex) this assertion FAILS — that regex matched ANY `dist/index.js`, so this foreign app got
    // `taskkill /T /F`'d (win32) / SIGKILL'd, exactly the Major the code review reproduced.
    check("[S3b] foreign port-holder process is STILL ALIVE after stop() (never signalled)", isAliveHere(holder.pid));
    check("[S3b] stop() exits 1 (refuses rather than guessing)", result.code === 1);
    check("[S3b] stop() explains the command line does not confirm the loom daemon", /does not confirm it as the loom daemon/i.test(result.stderr) && result.stderr.includes(String(holder.pid)));
    check("[S3b] the PID file is left untouched (this is a refusal, not a resolved stale record)", fs.existsSync(path.join(home, "daemon.pid")));
  } finally {
    try { holder.kill("SIGKILL"); } catch { /* already gone */ }
  }
}

// === SCENARIO 3c (card 279c0208 review, legacy-fallback positive case): the SAME legacy-record shape, ====
// === but the port-holder's path IS anchored under a `loomctl` dir (the real detached-daemon shape a ======
// === pre-279c0208 CLI would have produced) → still killed. ================================================
{
  const tmpDir = mkdtempManaged("loom-stop-identity-legacy-loomctl-");
  const scriptPath = path.join(tmpDir, "loomctl", "dist", "index.js");
  const { child: holder, port } = await spawnPortHolder(scriptPath);
  try {
    writeRecordFor(holder, port, null); // legacy shape: no `entry`

    check("[S3c] loomctl-anchored port-holder process is alive before stop()", isAliveHere(holder.pid));

    const result = await runCli(["stop"], env);

    check("[S3c] loomctl-anchored port-holder process is stopped (legacy fallback still recognizes a genuinely loom-shaped path)", !isAliveHere(holder.pid));
    check("[S3c] stop() exits 0", result.code === 0);
    check("[S3c] stop() does NOT refuse on a command-line mismatch (the legacy fallback matched)", !/does not confirm it as the loom daemon/i.test(result.stderr));
    check("[S3c] the PID file is cleaned up", !fs.existsSync(path.join(home, "daemon.pid")));
  } finally {
    try { holder.kill("SIGKILL"); } catch { /* already gone */ }
  }
}

// === SCENARIO 4 (card 03cc6cae): hook.status===404 (daemon predates the hook), legacy record (no entry), =
// === non-loom command line → refused, never signalled. Before 03cc6cae this branch had NO identity check =
// === at all; any 404 response was treated as identity-confirmed and the pid was signalled unverified. =====
{
  const tmpDir = mkdtempManaged("loom-stop-identity-404-");
  const scriptPath = path.join(tmpDir, "some-other-node-app", "server.js");
  const { child: holder, port } = await spawnHttpStandIn(scriptPath, "404");
  try {
    writeRecordFor(holder, port, null); // legacy shape: no `entry`

    check("[S4] 404 stand-in process is alive before stop()", isAliveHere(holder.pid));

    const result = await runCli(["stop"], env);

    // THE POSITIVE CONTROL: against pre-03cc6cae bin/loom.mjs this assertion FAILS — the old code treats
    // ANY HTTP response (incl. 404) on the recorded port as identity-confirmed and falls straight through
    // to the signal ladder, hard-killing this foreign process.
    check("[S4] 404 stand-in process is STILL ALIVE after stop() (never signalled)", isAliveHere(holder.pid));
    check("[S4] stop() reports the predates-the-hook message before refusing", /predates the graceful-shutdown hook/i.test(result.stderr));
    check("[S4] stop() exits 1 (refuses rather than guessing)", result.code === 1);
    check("[S4] stop() explains the command line does not confirm the loom daemon", /does not confirm it as the loom daemon/i.test(result.stderr) && result.stderr.includes(String(holder.pid)));
    check("[S4] the PID file is left untouched (this is a refusal, not a resolved stale record)", fs.existsSync(path.join(home, "daemon.pid")));
  } finally {
    try { holder.kill("SIGKILL"); } catch { /* already gone */ }
  }
}

// === SCENARIO 5 (card 03cc6cae): hook.status===401 (rejected credential), legacy record (no entry), =======
// === non-loom command line → refused, never signalled. Before 03cc6cae this branch had NO identity check =
// === at all either; any 401 response was treated as identity-confirmed. ====================================
{
  const tmpDir = mkdtempManaged("loom-stop-identity-401-");
  const scriptPath = path.join(tmpDir, "some-other-node-app", "server.js");
  const { child: holder, port } = await spawnHttpStandIn(scriptPath, "401");
  try {
    writeRecordFor(holder, port, null); // legacy shape: no `entry`

    check("[S5] 401 stand-in process is alive before stop()", isAliveHere(holder.pid));

    const result = await runCli(["stop"], env);

    // THE POSITIVE CONTROL: against pre-03cc6cae bin/loom.mjs this assertion FAILS — the old code falls
    // straight through to the signal ladder on a 401 with no command-line check, hard-killing this process.
    check("[S5] 401 stand-in process is STILL ALIVE after stop() (never signalled)", isAliveHere(holder.pid));
    check("[S5] stop() reports the rejected-credential message before refusing", /rejected our stop credential \(401\)/i.test(result.stderr));
    check("[S5] stop() exits 1 (refuses rather than guessing)", result.code === 1);
    check("[S5] stop() explains the command line does not confirm the loom daemon", /does not confirm it as the loom daemon/i.test(result.stderr) && result.stderr.includes(String(holder.pid)));
    check("[S5] the PID file is left untouched (this is a refusal, not a resolved stale record)", fs.existsSync(path.join(home, "daemon.pid")));
  } finally {
    try { holder.kill("SIGKILL"); } catch { /* already gone */ }
  }
}

// === SCENARIO 6 (card 03cc6cae): hook.status===202 (ACKed) but the process never actually exits, so =======
// === waitForDown TIMES OUT and `graceful` stays false — legacy record (no entry), non-loom command line ===
// === → refused, never signalled, even though hook.status is DEFINED (not `undefined`). =====================
{
  const tmpDir = mkdtempManaged("loom-stop-identity-202-timeout-");
  const scriptPath = path.join(tmpDir, "some-other-node-app", "server.js");
  const { child: holder, port } = await spawnHttpStandIn(scriptPath, "ack-no-exit");
  const envFastWait = { ...env, LOOM_TEST_STOP_WAIT_FOR_DOWN_MS: "300" }; // test seam — see bin/loom.mjs
  try {
    writeRecordFor(holder, port, null); // legacy shape: no `entry`

    check("[S6] 202-ack-no-exit stand-in process is alive before stop()", isAliveHere(holder.pid));

    const result = await runCli(["stop"], envFastWait);

    // THE POSITIVE CONTROL: against pre-03cc6cae bin/loom.mjs this assertion FAILS — the old code never
    // checked identity on the hook.status-defined paths at all, so a 202 ack with a timed-out waitForDown
    // fell straight through to the signal ladder and hard-killed this foreign process.
    check("[S6] 202-ack-no-exit stand-in process is STILL ALIVE after stop() (never signalled)", isAliveHere(holder.pid));
    check("[S6] stop() exits 1 (refuses rather than guessing)", result.code === 1);
    check("[S6] stop() explains the command line does not confirm the loom daemon", /does not confirm it as the loom daemon/i.test(result.stderr) && result.stderr.includes(String(holder.pid)));
    check("[S6] the PID file is left untouched (this is a refusal, not a resolved stale record)", fs.existsSync(path.join(home, "daemon.pid")));
  } finally {
    try { holder.kill("SIGKILL"); } catch { /* already gone */ }
  }
}

// === REGEX-LEVEL TABLE TEST (card 279c0208 review): the LEGACY fallback in isolation — the reviewer's ===
// === two named false positives (a `loom`-named path with no `bin` ancestor, nothing to do with the CLI) ==
// === are refused WITHOUT a full real-process spawn per string, alongside positive/negative controls =====
// === proving the pattern still recognizes the genuine shapes it exists for. ================================
{
  const cases = [
    // Reviewer's exact false positives (this review round) — a bare `loom`-named path component.
    { cmd: "vim /home/u/src/loom", expect: false, label: "vim editing an unrelated dir named 'loom'" },
    { cmd: "git -C /home/u/loom status", expect: false, label: "git -C on an unrelated repo named 'loom'" },
    // Genuine POSIX global-symlink shapes this fallback exists for — must still match.
    { cmd: "node /usr/local/bin/loom start --no-open", expect: true, label: "/usr/local/bin/loom (POSIX symlink)" },
    { cmd: "node /home/u/.npm-global/bin/loom start", expect: true, label: "an npm-prefix bin/loom" },
    // Package-anchored shapes — unaffected by this tightening, still matched.
    { cmd: "node /home/u/lib/node_modules/loomctl/dist/index.js", expect: true, label: "loomctl/dist/index.js" },
    { cmd: '"C:\\pkg\\loomctl\\bin\\loom.mjs" start', expect: true, label: "loomctl/bin/loom.mjs (Windows shim)" },
    // The reviewer's OTHER (earlier) repro — a foreign dist/index.js — must still be refused, as a control.
    { cmd: "node /home/u/some-other-app/dist/index.js", expect: false, label: "a foreign dist/index.js" },
  ];
  for (const { cmd, expect, label } of cases) {
    check(`[regex] ${label} → ${expect ? "matches" : "refused"}`, LEGACY_DAEMON_CMDLINE_RE.test(cmd) === expect);
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — `loom stop` never signals a pid unless the port-based check AND a command-line identity check (the recorded exact `entry` path, or a narrow package-anchored fallback for a legacy record) confirm it's actually the loom daemon — never a foreign process whose path merely resembles one, on ANY signalling branch (hook.status undefined, 404, 401, or a 202/200 whose waitForDown timed out) — and a genuinely wedged real daemon stays killable."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
