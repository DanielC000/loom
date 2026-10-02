// SHARED TEST HELPER (card 0e63034a) — a LOOM_PORT that is VERIFIED unreachable, for codex real-spawn fixtures.
//
// WHY: a codex real-spawn fixture that drives a real `PtyHost.spawn({harness:"codex"})` gets the Loom MCP
// servers (loom-tasks, loom-orchestration, ...) embedded in codex's argv at `http://127.0.0.1:${PORT}`,
// where `PORT` (paths.ts) is `Number(process.env.LOOM_PORT || 4317)`. Under `scripts/test-daemon.mjs` that
// is an OS-reserved port (`reserveHermeticPort`, card fc53ea74), where normally nothing listens — but if
// anything on that port ACCEPTS and never responds, codex waits out the whole MCP handshake and boot-ready
// slips to ~34s, past the fixtures' own boot budget. A refused connection or a 404 is a fast failure and
// harmless; only an accept-and-stay-silent listener hurts. Pinning LOOM_PORT to a port a live TCP probe
// has just shown refuses/blackholes makes the fixture independent of whatever the host (or a sibling
// invocation) has on the port `test-daemon.mjs` happened to reserve for it.
//
// The probe counts a port as REACHABLE only on a successful TCP connect — exactly the accept-but-silent
// shape above — so an accepting listener is rejected here regardless of whether it ever answers.
//
// Must be called BEFORE the first import of `../dist/paths.js` (directly or via `../dist/pty/host.js`):
// `PORT` is a module-load-time constant read once.
import net from "node:net";

function isReachable(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port, timeout: 300 });
    sock.on("connect", () => { sock.destroy(); resolve(true); });
    sock.on("error", () => resolve(false));
    sock.on("timeout", () => { sock.destroy(); resolve(false); });
  });
}

/** Picks a random port in 41000-49999 and returns the first one a live TCP probe shows unreachable. */
export async function findUnreachablePort() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = 41000 + Math.floor(Math.random() * 9000);
    if (!(await isReachable(candidate))) return candidate;
  }
  throw new Error("could not find an unreachable port after 20 attempts");
}

/** Sets `process.env.LOOM_PORT` to a verified-unreachable port and returns it. */
export async function pinUnreachableLoomPort() {
  const port = await findUnreachablePort();
  process.env.LOOM_PORT = String(port);
  return port;
}
