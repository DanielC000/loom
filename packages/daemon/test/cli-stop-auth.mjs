import "./_guard.mjs"; // suite consistency (sets LOOM_TEST=1); this test touches no Db.
// Card 93249b52 (SECURITY): POST /internal/shutdown now requires the SAME loopback-secret bearer
// credential every /api/* write does (gateway/server.ts's `isGuardedInternalWrite`) — this proves the
// SHIPPED CLI (bin/loom.mjs's `loom stop`) actually presents that credential, using the REAL entry as a
// subprocess (never imported/mocked — memory loom-cli-symlinked-global-entry-guard: this file IS the
// shipped entry) against a real stand-in DAEMON PROCESS (a second real subprocess, not an in-test HTTP
// server standing in as a fake "pid" — the earlier draft of this test made that mistake and it's worth
// naming: a fake pid that never actually exits makes `loom stop`'s own final `isAlive(rec.pid)` check
// correctly report failure regardless of the HTTP exchange, which produced a false-negative on this exact
// test before the fix below — a stand-in must actually BEHAVE like the thing it stands in for, exit
// included) that enforces the SAME bearer contract the real gateway guard does, and genuinely EXITS on a
// correctly-authenticated shutdown POST (mirroring the real daemon's own graceful-exit contract). Mirrors
// cli-stop-pid-identity.mjs's own real-subprocess conventions.
//
//   (a) POSITIVE: the secret file holds the real value → `loom stop` presents it as
//       `Authorization: Bearer <secret>` (logged by the stand-in daemon), the stand-in accepts + exits
//       (as a real daemon's graceful shutdown would), and `loom stop` reports a GRACEFUL stop (exit 0).
//   (b) NEGATIVE / RED-PROOF: the secret file is missing (unreadable) → `loom stop` sends no credential →
//       the stand-in 401s (exactly what a guarded real daemon does pre-this-card's CLI fix) and stays
//       alive → `loom stop` falls through to its signal-ladder fallback and the stand-in process actually
//       gets hard-killed (proving the CLI doesn't just silently give up on a 401) — and says so in stderr.
// (b) is also what a PRE-fix bin/loom.mjs would do against a POST-fix guarded daemon in EVERY case (it
// never sent a header at all) — so (a) failing on a pre-fix checkout is the real positive control here:
// with the pre-fix `postShutdown` (no Authorization header ever sent), the stand-in would 401 even with
// the correct secret on file, its own `isAlive` check would still be true, and (a)'s graceful-stop
// assertions would FAIL — confirmed by running this exact test against the pre-fix code (git-stashed) and
// watching the (a) block fail for the RIGHT reason (401 from the stand-in, no graceful exit) before the
// fix was applied.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { useOwnLoomHome, finishAndExit } from "./_tmp-fixture.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, "..", "..", "..", "bin", "loom.mjs"); // packages/daemon/test → repo root

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

// A minimal real HTTP server, running in its OWN real subprocess, standing in for a guarded Loom daemon:
// answers GET /api/version always, and enforces the SAME bearer contract POST /internal/shutdown does in
// gateway/server.ts's real guard (correct secret → 202 then genuinely EXITS, mirroring the real route's
// ack-then-graceful-exit; anything else → 401, stays alive). Logs `AUTH=<header or NONE>` and `PORT=<n>`
// to stdout so the parent can observe both without any IPC beyond stdio.
const STANDIN_DAEMON_SCRIPT = `
const http = require("node:http");
const SECRET = process.env.STANDIN_SECRET;
const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/api/version") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ version: "0.0.0" }));
    return;
  }
  if (req.method === "POST" && req.url === "/internal/shutdown") {
    const auth = req.headers.authorization || "NONE";
    console.log("AUTH=" + auth);
    if (auth === "Bearer " + SECRET) {
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, stopping: true }));
      setTimeout(() => process.exit(0), 50);
    } else {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
    }
    return;
  }
  res.writeHead(404).end();
});
server.listen(0, "127.0.0.1", () => console.log("PORT=" + server.address().port));
`;

function spawnStandInDaemon(secret) {
  const child = spawn(process.execPath, ["-e", STANDIN_DAEMON_SCRIPT], {
    env: { ...process.env, STANDIN_SECRET: secret },
    stdio: ["ignore", "pipe", "ignore"],
  });
  let buf = "";
  let lastAuthHeader = null;
  child.stdout.on("data", (c) => {
    buf += c;
    const authMatch = /AUTH=(.*)/.exec(buf);
    if (authMatch) lastAuthHeader = authMatch[1].trim() === "NONE" ? null : authMatch[1].trim();
  });
  return new Promise((resolve, reject) => {
    const onData = () => {
      const m = /PORT=(\d+)/.exec(buf);
      if (m) { child.stdout.off("data", onData); resolve({ child, port: Number(m[1]), getLastAuthHeader: () => lastAuthHeader }); }
    };
    child.stdout.on("data", onData);
    child.once("error", reject);
    child.once("exit", (code) => { if (!/PORT=\d+/.test(buf)) reject(new Error(`stand-in daemon exited before binding (code ${code})`)); });
  });
}

const home = useOwnLoomHome("loom-stop-auth-");
const SECRET = "test-cli-stop-secret-0123456789abcdef";
const secretPath = path.join(home, "gateway-loopback.key");

let standInA, standInB;
try {
  // ===================== (a) POSITIVE: correct secret on file, stand-in requires it =====================
  fs.writeFileSync(secretPath, SECRET);
  standInA = await spawnStandInDaemon(SECRET);
  fs.writeFileSync(
    path.join(home, "daemon.pid"),
    JSON.stringify({ pid: standInA.child.pid, port: standInA.port, url: `http://127.0.0.1:${standInA.port}`, version: "0.0.0", startedAt: new Date().toISOString() }, null, 2) + "\n",
  );

  const envA = { ...process.env, LOOM_HOME: home, LOOM_TEST: "1" };
  const resultA = await runCli(["stop"], envA);

  check("(a) the CLI presented the CORRECT bearer credential to the stand-in (Authorization: Bearer <secret>)",
    standInA.getLastAuthHeader() === `Bearer ${SECRET}`);
  check("(a) the stand-in daemon actually exited (graceful shutdown really happened, not just an HTTP ack)",
    !isAliveHere(standInA.child.pid));
  check("(a) `loom stop` exits 0", resultA.code === 0);
  check("(a) `loom stop` reports a GRACEFUL stop (the guarded stand-in accepted the credential)",
    /stopped \(graceful\)/i.test(resultA.stdout));
  check("(a) the PID file is cleaned up", !fs.existsSync(path.join(home, "daemon.pid")));

  // ===================== (b) NEGATIVE / RED-PROOF: no readable secret → the stand-in 401s =====================
  fs.rmSync(secretPath, { force: true }); // readLoopbackSecret() now returns null → postShutdown sends NO header
  standInB = await spawnStandInDaemon(SECRET); // same contract: anything but the exact bearer → 401, stays up
  fs.writeFileSync(
    path.join(home, "daemon.pid"),
    JSON.stringify({ pid: standInB.child.pid, port: standInB.port, url: `http://127.0.0.1:${standInB.port}`, version: "0.0.0", startedAt: new Date().toISOString() }, null, 2) + "\n",
  );

  check("(b) stand-in daemon process is alive before stop()", isAliveHere(standInB.child.pid));
  const envB = { ...process.env, LOOM_HOME: home, LOOM_TEST: "1" };
  const resultB = await runCli(["stop"], envB);

  check("(b) the stand-in never received a valid credential (no header presented → 401, stayed alive)",
    standInB.getLastAuthHeader() === null);
  check("(b) `loom stop` reports the 401 rejection and falls back to a signal",
    /rejected our stop credential \(401\)/i.test(resultB.stderr));
  check("(b) the fallback signal ladder ACTUALLY ran: the stand-in daemon is no longer alive",
    !isAliveHere(standInB.child.pid));
  check("(b) `loom stop` still exits 0 (the fallback got the target down, even though it wasn't graceful)",
    resultB.code === 0);
} finally {
  try { standInA?.child.kill("SIGKILL"); } catch { /* already gone */ }
  try { standInB?.child.kill("SIGKILL"); } catch { /* already gone */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — `loom stop` (the REAL shipped CLI entry, run as a subprocess) presents the loopback-secret bearer credential on POST /internal/shutdown, a guarded stand-in daemon accepts it and genuinely exits, and — RED-PROVEN — when no credential is presentable the stand-in 401s and the CLI's existing signal-ladder fallback still gets the target down (with a clear message, not a silent stall)."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
