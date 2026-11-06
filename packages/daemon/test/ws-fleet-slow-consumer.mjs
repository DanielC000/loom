import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card cfd1fe04: FleetHub.broadcast/broadcastEvent never checked `socket.bufferedAmount`, so a loopback
// /ws/fleet client that connects and never reads made `ws` buffer every frame in daemon memory without bound.
// Proves, with stub sockets driving the real FleetHub (no network, no Db):
//   1. A socket over MAX_FLEET_SOCKET_BUFFERED_BYTES is closed with 1013, gets NO send, and leaves the hub.
//   2. A healthy socket in the SAME broadcast still gets the frame (one slow consumer can't starve others).
//   3. Same for broadcastEvent (subscribed slow socket closed, subscribed healthy one served).
//   4. A socket exactly AT the threshold is not closed (strictly-over boundary).
//   5. The close log carries no frame content.
import fs from "node:fs";
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

const TMP = mkdtempManaged("loom-ws-fleet-slow-");
process.env.LOOM_HOME = TMP;
const sandboxHome = path.join(TMP, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
requireHermeticEnv();

const { FleetHub, MAX_FLEET_SOCKET_BUFFERED_BYTES } = await import("../dist/gateway/fleet-hub.js");

let failures = 0;
function check(label, ok) {
  console.log(`${ok ? "  ok" : "FAIL"} ${label}`);
  if (!ok) failures++;
}

function stub(bufferedAmount) {
  return {
    OPEN: 1,
    readyState: 1,
    bufferedAmount,
    sent: [],
    closed: [],
    send(d) { this.sent.push(d); },
    close(code, reason) { this.closed.push({ code, reason }); this.readyState = 3; },
  };
}

const logs = [];
const origWarn = console.warn;
console.warn = (...a) => { logs.push(a.join(" ")); };

try {
  const SECRET = "SECRET-FRAME-CONTENT-xyz";
  const hub = new FleetHub();
  const slow = stub(MAX_FLEET_SOCKET_BUFFERED_BYTES + 1);
  const healthy = stub(0);
  const atLimit = stub(MAX_FLEET_SOCKET_BUFFERED_BYTES);
  for (const s of [slow, healthy, atLimit]) hub.add(s);

  hub.broadcast({ t: "session:remove", id: SECRET });
  check("(1) over-threshold socket is closed with 1013", slow.closed.length === 1 && slow.closed[0].code === 1013);
  check("(1) over-threshold socket received no send", slow.sent.length === 0);
  check("(1) over-threshold socket left the hub", hub.size === 2 && hub.subscriptionsFor(slow) === undefined);
  check("(2) healthy socket in the same broadcast got the frame", healthy.sent.length === 1 && healthy.sent[0].includes(SECRET));
  check("(4) socket exactly AT the threshold is not closed and is served", atLimit.closed.length === 0 && atLimit.sent.length === 1);
  check("(5) close log names no frame content", logs.length === 1 && !logs.join("\n").includes(SECRET));

  hub.broadcast({ t: "session:remove", id: "again" });
  check("(1) closed socket receives no further sends", slow.sent.length === 0 && slow.closed.length === 1);

  // broadcastEvent path
  const hub2 = new FleetHub();
  const slow2 = stub(MAX_FLEET_SOCKET_BUFFERED_BYTES * 2);
  const healthy2 = stub(10);
  const unsub = stub(MAX_FLEET_SOCKET_BUFFERED_BYTES * 2);
  for (const s of [slow2, healthy2, unsub]) hub2.add(s);
  hub2.subscribeEvents(slow2, "mgr", 0);
  hub2.subscribeEvents(healthy2, "mgr", 0);
  hub2.broadcastEvent("mgr", { t: "session:remove", id: "e1" });
  check("(3) broadcastEvent closes the slow subscribed socket, no send", slow2.closed.length === 1 && slow2.closed[0].code === 1013 && slow2.sent.length === 0);
  check("(3) broadcastEvent still serves the healthy subscribed socket", healthy2.sent.length === 1);
  check("(3) a non-subscribed socket is untouched by broadcastEvent", unsub.closed.length === 0 && unsub.sent.length === 0);
} finally {
  console.warn = origWarn;
}

console.log(failures === 0
  ? "\n✅ ALL PASS — FleetHub closes (1013) a socket over the buffered-bytes bound instead of sending, and serves healthy sockets."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
