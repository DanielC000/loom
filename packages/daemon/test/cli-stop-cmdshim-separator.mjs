import "./_guard.mjs"; // suite consistency (sets LOOM_TEST=1); this test touches no Db.
// Code Review of 5b7a15aa (reviewer a16f3209) REPRODUCED a Critical regression: a REAL Windows npm cmd-shim
// invocation of the foreground daemon broke `isOurDaemon`'s recorded-`entry` match. A cmd-shim's own
// `%~dp0`-style prefix already ends in a path separator, so concatenating a leading-separator-relative path
// in the shim template DOUBLES that separator in the LIVE command line — while the Node-normalized recorded
// `entry` (`writeForegroundPidRecord`'s `process.argv[1]`) has only ONE. The old `normalizeCmdlinePath`
// only swapped `\` → `/`, never collapsed the doubled run, so `cmd.includes(entry)` was FALSE and `loom
// stop`/`loom update`/`loom restart` all refused to signal a perfectly real foreground daemon on 401/404/
// 200-202-timeout.
//
// VERIFIED MECHANISM (manual repro, same host, same technique used here): a `node target.mjs` launched via
// a real `.cmd` shim whose body is `"node"  "%~dp0\target.mjs" %*` reports `process.argv[1]` INSIDE that
// process as `...\target.mjs` (single backslash) while `Get-CimInstance Win32_Process.CommandLine` for that
// SAME live process shows `...\\target.mjs` (doubled) — confirmed byte-for-byte on this exact host before
// writing this test.
//
// This test reproduces the REAL end-to-end failure: a stand-in "foreground daemon" process, launched
// through a genuine `.cmd` shim shaped exactly like the npm-generated one, writes ITS OWN pid record (via
// its own `process.argv[1]`, mirroring `writeForegroundPidRecord` exactly) and serves a 401-always
// `/internal/shutdown` (so `stop()` must fall through the identity-gated signal ladder, never the graceful
// hook). `loom stop` must still identify and stop it.
//
// WINDOWS-ONLY: cmd shims (and the separator-doubling bug) only exist on Windows; this test is a clean,
// explicit no-op elsewhere (the fix itself — `cmdlineHasEntryArgument`'s separator-collapse — is
// platform-agnostic and already covered on every OS by cli-stop-pid-identity.mjs's other scenarios).
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { useOwnLoomHome, mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, "..", "..", "..", "bin", "loom.mjs"); // packages/daemon/test → repo root

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

if (process.platform !== "win32") {
  console.log("ℹ SKIPPED on this platform — cmd-shim separator-doubling is a Windows-only shape (POSIX shims use a different mechanism entirely). The underlying fix (cmdlineHasEntryArgument's separator-collapse) is exercised on every OS by cli-stop-pid-identity.mjs's other scenarios.");
  await finishAndExit(0);
}

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

// A real stand-in "foreground daemon": binds an ephemeral port, always 401s /internal/shutdown (forcing
// `stop()` into the identity-gated signal ladder, never the graceful hook), 200s /api/version, and writes
// its OWN pid record exactly the way `writeForegroundPidRecord` does — `entry: process.argv[1]`, read from
// WITHIN this process (so it reflects whatever Node itself reports, mirroring the real code path exactly).
const STANDIN_SCRIPT = `
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const home = process.env.LOOM_HOME;
const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/api/version") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ version: "0.0.0" }));
    return;
  }
  if (req.method === "POST" && req.url === "/internal/shutdown") {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }
  res.writeHead(404).end();
});
server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  fs.writeFileSync(
    path.join(home, "daemon.pid"),
    JSON.stringify({ pid: process.pid, port, url: "http://127.0.0.1:" + port, entry: process.argv[1], version: "0.0.0", startedAt: new Date().toISOString() }, null, 2) + "\\n",
  );
  console.log("READY=" + JSON.stringify({ port, pid: process.pid, argv1: process.argv[1] }));
});
`;

const tmpDir = mkdtempManaged("cli-stop-cmdshim-separator-");
const standinPath = path.join(tmpDir, "standin.cjs");
fs.writeFileSync(standinPath, STANDIN_SCRIPT);

// The shim's own `%~dp0` already ends in `\` (tmpDir's own trailing separator) — concatenating a
// leading-separator-relative path doubles it, exactly like a real npm cmd-shim template does.
const shimPath = path.join(tmpDir, "loom-standin-shim.cmd");
fs.writeFileSync(shimPath, `@ECHO off\r\n"node"  "%~dp0\\standin.cjs" %*\r\n`);

const home = useOwnLoomHome("cli-stop-cmdshim-separator-");

let standinProc;
let standinInfo;
try {
  const standinResult = await new Promise((resolve, reject) => {
    const child = spawn("cmd.exe", ["/c", shimPath], {
      env: { ...process.env, LOOM_HOME: home },
      stdio: ["ignore", "pipe", "ignore"],
    });
    let buf = "";
    child.stdout.on("data", (c) => {
      buf += c;
      const m = /READY=(\{.*\})/.exec(buf);
      if (m) resolve({ child, info: JSON.parse(m[1]) });
    });
    child.once("error", reject);
    child.once("exit", (code) => { if (!/READY=/.test(buf)) reject(new Error(`stand-in exited before ready (code ${code})`)); });
  });
  standinProc = standinResult.child;
  const { info } = standinResult;
  standinInfo = info;

  check("[cmdshim] stand-in daemon is alive before stop()", isAliveHere(info.pid));

  // Sanity: confirm the LIVE command line genuinely carries the doubled separator this bug is about —
  // without this, a passing test downstream would prove nothing about the actual regression.
  const psProbe = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${info.pid}").CommandLine`], { stdio: ["ignore", "pipe", "ignore"] });
  const liveCmdLine = await new Promise((resolve) => {
    let buf = "";
    psProbe.stdout.on("data", (c) => (buf += c));
    psProbe.on("exit", () => resolve(buf.trim()));
  });
  check("[cmdshim] sanity: the live command line genuinely contains a DOUBLED separator around the shim's own dir (the exact shape this bug is about)", /\\\\standin\.cjs/i.test(liveCmdLine));
  check("[cmdshim] sanity: the recorded entry (process.argv[1], Node-normalized) has only a SINGLE separator there", /argv1/.test(JSON.stringify(info)) && !/\\\\standin\.cjs/i.test(info.argv1));

  const env = { ...process.env, LOOM_HOME: home, LOOM_TEST: "1" };
  const result = await runCli(["stop"], env);

  // THE POSITIVE CONTROL: against the pre-fix `normalizeCmdlinePath` (backslash-to-slash swap only, no
  // separator-run collapse) this assertion FAILS — `cmd.includes(entry)` is false because the live command
  // line has an EXTRA separator the recorded entry doesn't, so `stop()` refuses a perfectly real daemon.
  check("[cmdshim] `loom stop` identifies the cmd-shim-launched stand-in and signals it (not refused as unverified)", !/does not confirm it as the loom daemon/i.test(result.stderr));
  check("[cmdshim] the stand-in process is actually stopped", !isAliveHere(info.pid));
  check("[cmdshim] `loom stop` reports the 401 rejection and falls back to a signal", /rejected our stop credential \(401\)/i.test(result.stderr));
  check("[cmdshim] `loom stop` exits 0 (the fallback got the target down)", result.code === 0);
} finally {
  try { standinProc?.kill("SIGKILL"); } catch { /* already gone */ }
  // `standinProc` is the cmd.exe SHIM wrapper, not an ancestor Windows auto-kills a tree for on plain
  // `.kill()` — the real stand-in daemon is a SEPARATE grandchild node.exe process (`standinInfo.pid`,
  // captured from its own self-reported `process.pid`). On an assertion failure above, `loom stop` may
  // never have reached it, so kill it directly too — scoped to this exact pid captured at spawn.
  if (typeof standinInfo?.pid === "number" && isAliveHere(standinInfo.pid)) {
    try { process.kill(standinInfo.pid, "SIGKILL"); } catch { /* already gone */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — `loom stop` correctly identifies and stops a foreground daemon launched through a REAL Windows npm-cmd-shim-shaped invocation, even though the shim's own `%~dp0` concatenation doubles a path separator in the live command line relative to the Node-normalized recorded `entry`."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
