import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 1baf6fb6: /ws/term's raw pty->viewer send had no bufferedAmount bound. A viewer that stops reading is now
// closed (1013) and detached from the pty's subscriber list; the pty itself is never paused/stopped/written and
// OTHER viewers keep receiving. Real route (buildServer + injectWS) over a recording pty stub whose subscribe()
// hands back the handlers, so the test can emit "pty output" at will.
//
// The slow viewer is made genuinely slow by pausing its client-side raw socket (so the server's writes pile up
// in socket.bufferedAmount). Proves, with a positive control first (a healthy viewer under the SAME volume of
// output is NOT closed), so the closure below is the bound firing and not an artefact of the harness.
import fs from "node:fs";
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { waitUntil } from "./_wait.mjs";
import { hermeticPort } from "./_hermetic-port.mjs";

const TMP = mkdtempManaged("loom-wsterm-slow-");
process.env.LOOM_HOME = TMP;
process.env.LOOM_PORT = String(hermeticPort());
const sandboxHome = path.join(TMP, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer, MAX_TERM_SOCKET_BUFFERED_BYTES } = await import("../dist/gateway/server.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const subscribers = new Set();
const ptyCalls = [];
const ptyStub = {
  subscribe: (_id, h) => { subscribers.add(h); return () => { subscribers.delete(h); }; },
  writeStdin: (...a) => ptyCalls.push(["writeStdin", ...a]), repaint: (...a) => ptyCalls.push(["repaint", ...a]),
  resize: (...a) => ptyCalls.push(["resize", ...a]), stop: (...a) => ptyCalls.push(["stop", ...a]),
  listShells: () => [],
};
const db = new Db(path.join(TMP, "loom.db"));
const app = await buildServer({
  db, pty: ptyStub, sessions: {}, mcp: {}, orchMcp: {}, platformMcp: {}, auditMcp: {}, userAuditMcp: {},
  setupMcp: {}, runMcp: {}, control: {}, usageStatus: {}, requestShutdown: () => {},
});
const emit = (buf) => { for (const h of [...subscribers]) h.onData(buf); };
const CHUNK = Buffer.alloc(1024 * 1024, 0x61);
const open = (onInit) => app.injectWS("/ws/term/s1", { headers: { host: "127.0.0.1" } }, { onInit });

try {
  await app.ready();
  const healthyGot = { bytes: 0, closed: null };
  const healthy = await open((ws) => {
    ws.on("message", (d, isBinary) => { if (isBinary) healthyGot.bytes += d.length; }); // text frames are JSON control (geometry), not pty bytes
    ws.on("close", (code) => { healthyGot.closed = code; });
  });
  const slowInfo = { closed: null };
  let slowRaw;
  const slow = await open((ws) => {
    ws.on("close", (code, reason) => { slowInfo.closed = { code, reason: reason.toString() }; });
  });
  slowRaw = slow._socket; // client-side TCP-like duplex: pausing it stops draining the server's writes
  check("(setup) two viewers subscribed to the pty", subscribers.size === 2);
  slowRaw.pause();
  slow.pause?.();

  // Emit well past the bound in 1 MiB chunks, yielding between chunks so the healthy viewer drains.
  const total = Math.ceil(MAX_TERM_SOCKET_BUFFERED_BYTES / CHUNK.length) * 3;
  for (let i = 0; i < total; i++) { emit(CHUNK); await new Promise((r) => setImmediate(r)); }

  await waitUntil(() => subscribers.size === 1, { timeoutMs: 8000, intervalMs: 20, label: "slow viewer detached" });
  // A frozen-but-alive client that resumes inside the grace window still sees the 1013.
  slowRaw.resume();
  await waitUntil(() => slowInfo.closed !== null, { timeoutMs: 8000, intervalMs: 20, label: "slow viewer closed" });
  check("(1) the non-reading viewer is closed with 1013", slowInfo.closed?.code === 1013);
  check("(2) it was detached from the pty's subscriber list (one viewer left)", subscribers.size === 1);
  check("(3) the healthy viewer under the SAME output was NOT closed (positive control)", healthyGot.closed === null && healthy.readyState === healthy.OPEN);
  await waitUntil(() => healthyGot.bytes >= CHUNK.length * total, { timeoutMs: 8000, intervalMs: 20, label: "healthy got everything" });
  check("(4) the healthy viewer received every byte emitted", healthyGot.bytes === CHUNK.length * total);
  check("(5) the pty was never stopped/written/repainted by the slow-viewer drop", ptyCalls.length === 0);

  // The session keeps running: later output still reaches the remaining viewer.
  const before = healthyGot.bytes;
  emit(Buffer.from("after"));
  await waitUntil(() => healthyGot.bytes === before + 5, { timeoutMs: 3000, intervalMs: 20, label: "post-drop output" });
  check("(6) output after the drop still reaches the remaining viewer", healthyGot.bytes === before + 5);

  healthy.terminate();
  slow.terminate();
} finally {
  await app.close();
  db.close();
}

console.log(failures === 0 ? "\n✅ ALL PASS — a non-reading /ws/term viewer is closed (1013) without touching the pty or other viewers." : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
