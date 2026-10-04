import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — no Db touched below either way
// Hermetic self-test for `_daemon-ready.mjs` (card 2365cc22) — NO real Loom daemon is ever spawned here.
// Proves the helper's three load-bearing behaviors against synthetic stand-ins, each shown capable of
// distinguishing the RIGHT answer from the WRONG one (never just "it didn't throw"):
//   (A) a FOREIGN listener (a plain http server that always 401s our identity probe, simulating a
//       sibling test's daemon that won the ephemeral-port TOCTOU race) is never mistaken for readiness —
//       `waitForOwnDaemon` keeps polling and eventually rejects with a timeout, it never resolves true.
//   (B) a child that exits EARLY (before the identity probe ever succeeds) makes `waitForOwnDaemon`
//       reject FAST — well under a long timeout — naming the captured stderr tail, not after waiting out
//       the whole budget.
//   (C) the HAPPY PATH: once a plain server starts answering our identity probe correctly (the same
//       secret `waitForOwnDaemon` reads from loomHome), it resolves true promptly.
// Run: node test/daemon-ready-helper.mjs (no build needed — imports only test/_daemon-ready.mjs + _wait.mjs)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import http from "node:http";
import { EventEmitter } from "node:events";
import { waitForOwnDaemon, captureStderrTail } from "./_daemon-ready.mjs";
import { reserveHermeticPort } from "./_hermetic-port.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

function mkLoomHome(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// A tiny stand-in gateway: answers DELETE /api/schedules/* with 200 {ok:true} ONLY when the presented
// bearer matches `acceptSecret` exactly (mirrors the real gateway's loopback-secret guard semantics —
// never a Loom process at all, but behaviorally identical for what `waitForOwnDaemon` actually checks).
function startStandInServer(acceptSecret) {
  let requestsSeen = 0;
  const server = http.createServer((req, res) => {
    requestsSeen++;
    const auth = req.headers.authorization;
    const presented = typeof auth === "string" ? /^Bearer\s+(.+)$/i.exec(auth)?.[1] : undefined;
    if (req.method === "DELETE" && presented === acceptSecret) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
    } else {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
    }
  });
  return { server, getRequestsSeen: () => requestsSeen };
}

async function listenOn(server) {
  const port = await reserveHermeticPort("127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return port;
}

// ════════════════════════════════════════ (A) FOREIGN LISTENER ═══════════════════════════════════════
await (async () => {
  const loomHome = mkLoomHome("loom-dr-foreign-");
  fs.writeFileSync(path.join(loomHome, "gateway-loopback.key"), "our-real-secret-aaa");
  const { server, getRequestsSeen } = startStandInServer("some-other-secret-bbb"); // never matches ours
  const port = await listenOn(server);
  const base = `http://127.0.0.1:${port}`;
  // `child` here is a real, long-lived (never-exiting-on-its-own) process — proves the timeout path, not
  // the early-exit path, is what fires. Killed explicitly below.
  const dummyChild = spawn(process.execPath, ["-e", "setInterval(() => {}, 999999)"], { stdio: "ignore" });
  try {
    const t0 = performance.now();
    let threw = null;
    try {
      await waitForOwnDaemon({ child: dummyChild, base, loomHome, timeoutMs: 600, label: "foreign-listener-test" });
    } catch (err) {
      threw = err;
    }
    const elapsed = performance.now() - t0;
    check("(A) a foreign listener that never accepts our secret is NEVER treated as ready (rejects, does not resolve)", threw !== null);
    check("(A) the rejection is timeout-shaped, not an early-exit message", /timed out/i.test(threw?.message ?? ""));
    check("(A) the stand-in server was actually probed at least once (not a vacuous pass)", getRequestsSeen() > 0);
    check(`(A) it waited out roughly the given budget before giving up (elapsed=${elapsed.toFixed(0)}ms, expect >= 600ms)`, elapsed >= 600);
  } finally {
    try { dummyChild.kill(); } catch { /* ignore */ }
    await new Promise((r) => server.close(r));
    fs.rmSync(loomHome, { recursive: true, force: true });
  }
})();

// ════════════════════════════════════════ (B) EARLY CHILD EXIT ═══════════════════════════════════════
await (async () => {
  const loomHome = mkLoomHome("loom-dr-earlyexit-");
  // Deliberately NO gateway-loopback.key written — the identity probe could never succeed on its own even
  // if we waited the full budget, so a FAST rejection here can only be coming from the early-exit path,
  // never from the identity check happening to resolve first.
  const base = "http://127.0.0.1:1"; // deliberately unreachable — nothing to connect to
  const marker = "SIMULATED-EADDRINUSE-" + Math.random().toString(36).slice(2);
  const child = spawn(process.execPath, ["-e", `process.stderr.write(${JSON.stringify(marker)}); process.exit(7)`], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  const getStderrTail = captureStderrTail(child);
  const t0 = performance.now();
  let threw = null;
  try {
    // A deliberately LONG timeout — if the rejection took anywhere close to it, that would mean the
    // early-exit race lost to the ordinary timeout path instead of winning fast, which is the exact
    // defect this helper exists to prevent (profiles-rest.mjs's old stdio:"ignore" hid this).
    await waitForOwnDaemon({ child, base, loomHome, getStderrTail, timeoutMs: 20000, label: "early-exit-test" });
  } catch (err) {
    threw = err;
  }
  const elapsed = performance.now() - t0;
  check("(B) an early-exiting child makes waitForOwnDaemon reject", threw !== null);
  check(`(B) the rejection is FAST, not after waiting out the 20s budget (elapsed=${elapsed.toFixed(0)}ms, expect < 5000ms)`, elapsed < 5000);
  check("(B) the rejection message says the child exited early", /exited early/i.test(threw?.message ?? ""));
  check("(B) the rejection message carries the captured stderr tail", (threw?.message ?? "").includes(marker));
  fs.rmSync(loomHome, { recursive: true, force: true });
})();

// ════════════════════════════════════════ (C) HAPPY PATH ═════════════════════════════════════════════
await (async () => {
  const loomHome = mkLoomHome("loom-dr-happy-");
  const SECRET = "the-one-true-secret-" + Math.random().toString(36).slice(2);
  const { server, getRequestsSeen } = startStandInServer(SECRET);
  const port = await listenOn(server);
  const base = `http://127.0.0.1:${port}`;
  const dummyChild = spawn(process.execPath, ["-e", "setInterval(() => {}, 999999)"], { stdio: "ignore" });
  // Write the secret file AFTER a short delay — also exercises the "file not written yet" retry branch
  // (ENOENT-until-it-exists), not just the already-present case.
  const secretTimer = setTimeout(() => fs.writeFileSync(path.join(loomHome, "gateway-loopback.key"), SECRET), 150);
  try {
    const t0 = performance.now();
    const result = await waitForOwnDaemon({ child: dummyChild, base, loomHome, timeoutMs: 10000, label: "happy-path-test" });
    const elapsed = performance.now() - t0;
    check("(C) a server that correctly matches our secret IS treated as ready (resolves true)", result === true);
    check(`(C) it resolved promptly, not by exhausting the 10s budget (elapsed=${elapsed.toFixed(0)}ms, expect < 5000ms)`, elapsed < 5000);
    check("(C) the identity probe actually reached the stand-in server (not a vacuous pass)", getRequestsSeen() > 0);
  } finally {
    clearTimeout(secretTimer);
    try { dummyChild.kill(); } catch { /* ignore */ }
    await new Promise((r) => server.close(r));
    fs.rmSync(loomHome, { recursive: true, force: true });
  }
})();

// Negative control: `waitForOwnDaemon` must be the thing actually driving the result above, not an
// artifact of EventEmitter quirks — a `child` that is a plain EventEmitter (never spawned, "exit" never
// fired) racing against an always-401 server must still time out exactly like case (A)'s real process did.
await (async () => {
  const loomHome = mkLoomHome("loom-dr-emitter-");
  fs.writeFileSync(path.join(loomHome, "gateway-loopback.key"), "irrelevant");
  const { server } = startStandInServer("never-matches");
  const port = await listenOn(server);
  const base = `http://127.0.0.1:${port}`;
  const fakeChild = new EventEmitter(); // stdio-less stand-in; never emits "exit"/"error"
  let threw = null;
  try {
    await waitForOwnDaemon({ child: fakeChild, base, loomHome, timeoutMs: 400, label: "emitter-stand-in-test" });
  } catch (err) {
    threw = err;
  }
  check("negative control: a bare EventEmitter stand-in for `child` behaves the same as a real never-exiting process (still times out)", threw !== null && /timed out/i.test(threw?.message ?? ""));
  await new Promise((r) => server.close(r));
  fs.rmSync(loomHome, { recursive: true, force: true });
})();

console.log(failures === 0
  ? "\n✅ ALL PASS — waitForOwnDaemon correctly distinguishes a foreign listener (never ready), an early-exiting child (fast reject with stderr), and a genuine identity match (ready)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
