// Card 3b4e2bbe: dev-proxy-loopback-nonregression.mjs:46 used to `.listen()` directly on
// hermeticPort()'s pid-derived value (`40000 + pid % 20000`), which can land inside a Windows WinNAT/
// Hyper-V reserved port range (`netsh interface ipv4 show excludedportrange protocol=tcp`) — a real bind
// there fails `EACCES`, not `EADDRINUSE`. That is exactly what redded b801bad0's 52-minute full merge
// gate (op 35e702a3): `listen EACCES: permission denied 127.0.0.1:59536`, a pid-dependent, Windows-only
// flake.
//
// This file proves TWO things against the HOST'S REAL, LIVE reserved ranges (not a fixture):
//   (1) RED — binding directly to a port inside one of those ranges really does throw EACCES, so the bug
//       this card fixes is real and reproducible, not hypothetical.
//   (2) GREEN — `reserveHermeticPort()` (the fix: ask the OS for a free ephemeral port via `:0` rather
//       than guessing a number) never lands inside one of those ranges, across many trials, and the port
//       it returns is itself genuinely bindable.
//
// WINDOWS-ONLY: the bug class is WinNAT/Hyper-V port exclusion, which has no equivalent on POSIX — graceful
// WARN SKIP elsewhere (same convention as this suite's real-spawn family: a `WARN  SKIP` line, never a
// bare `SKIP`, so CI/a non-Windows host doesn't silently lose trace that this coverage didn't run).
import "./_guard.mjs";
import net from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { finishAndExit } from "./_tmp-fixture.mjs";
import { reserveHermeticPort } from "./_hermetic-port.mjs";

const execFileAsync = promisify(execFile);
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

if (process.platform !== "win32") {
  console.log("WARN  SKIP  hermetic-port-reserved-range.mjs — Windows-only (WinNAT/Hyper-V port exclusion has no POSIX equivalent); no fixture substitute, real coverage only on win32.");
  process.exit(0);
}

// --- Discover the host's REAL, live excluded ranges (same command CLAUDE.md/the card point at). ----------
const { stdout } = await execFileAsync("netsh", ["interface", "ipv4", "show", "excludedportrange", "protocol=tcp"], { windowsHide: true });
const ranges = [];
for (const line of stdout.split("\n")) {
  const m = line.match(/^\s*(\d+)\s+(\d+)/);
  if (m) ranges.push([Number(m[1]), Number(m[2])]);
}
if (ranges.length === 0) {
  console.log("WARN  SKIP  hermetic-port-reserved-range.mjs — `netsh ... show excludedportrange` returned no ranges on this host; nothing to reproduce against.");
  process.exit(0);
}
const inReservedRange = (port) => ranges.some(([lo, hi]) => port >= lo && port <= hi);

function bind(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", (e) => resolve({ ok: false, code: e.code }));
    srv.listen(port, host, () => srv.close(() => resolve({ ok: true })));
  });
}

// --- (1) RED: a literal port drawn from a live reserved range really does fail with EACCES. ---------------
// This is what `dev-proxy-loopback-nonregression.mjs:46` (pre-fix) did whenever `hermeticPort()`'s
// `40000 + pid % 20000` pick happened to land here — the exact shape of b801bad0's redded gate.
const [reservedLo] = ranges[0];
const reservedPort = reservedLo;
const reservedAttempt = await bind(reservedPort);
check(
  `(1) RED control: binding directly to a live reserved port (${reservedPort}, range ${ranges[0][0]}-${ranges[0][1]}) fails with EACCES — reproducing the old hermeticPort()-direct-.listen() bug`,
  reservedAttempt.ok === false && reservedAttempt.code === "EACCES",
);

// --- (1b) Positive control on the SAME check: an ordinary port OUTSIDE every reserved range binds fine. --
// Proves bind()/the EACCES assertion above discriminates — not just "everything fails on this host".
let ordinaryPort = null;
for (let p = 40000; p < 60000 && ordinaryPort === null; p++) {
  if (!inReservedRange(p)) ordinaryPort = p;
}
const ordinaryAttempt = ordinaryPort === null ? { ok: false } : await bind(ordinaryPort);
check(
  `(1b) CONTROL: an ordinary non-reserved port (${ordinaryPort}) binds fine — proves (1)'s EACCES is specific to the reserved range, not a broken bind() helper`,
  ordinaryAttempt.ok === true,
);

// --- (2) GREEN: reserveHermeticPort() never returns a port inside a reserved range, and what it returns
// is genuinely bindable — run many trials since any single trial passing could be luck. -------------------
const TRIALS = 50;
let allOutsideReserved = true;
let allBindable = true;
let worstOffender = null;
for (let i = 0; i < TRIALS; i++) {
  const port = await reserveHermeticPort();
  if (inReservedRange(port)) {
    allOutsideReserved = false;
    worstOffender = port;
  }
  const rebind = await bind(port);
  if (!rebind.ok) allBindable = false;
}
check(`(2) GREEN: reserveHermeticPort() returned a port outside every live reserved range across ${TRIALS} trials (asked the OS for :0, which structurally excludes these ranges by construction)${worstOffender ? ` — FAILED at port ${worstOffender}` : ""}`, allOutsideReserved);
check(`(2b) GREEN: every reserveHermeticPort()-returned port was still bindable on a fresh rebind across ${TRIALS} trials`, allBindable);

console.log(failures === 0
  ? "\n✅ ALL PASS — reserveHermeticPort() structurally avoids this host's live Windows reserved port ranges; a direct hermeticPort()-style literal bind does not"
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
