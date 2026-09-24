import "./_guard.mjs";
// Card 710a34fa — a NON-loopback caller holding a valid Tier-1 gateway token must NOT be able to write stdin
// over /ws/term to (a) an agent session pty or (b) attach to a HOST SHELL made by POST /api/terminals; it may
// still READ an agent session (subscribe) and ask for a repaint. Loopback (with the loopback secret) is unchanged.
// HERMETIC + CLAUDE-FREE + NETWORK-FREE: buildServer + injectWS with a `socket:{remoteAddress}` override and a
// recording pty stub. The stub cannot tell a shell from a session (neither can the real handler — one `live` map).
import fs from "node:fs";
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { hermeticPort } from "./_hermetic-port.mjs";

const TMP = mkdtempManaged("loom-wsterm-remote-");
process.env.LOOM_HOME = TMP;
process.env.LOOM_PORT = String(hermeticPort());
const sandboxHome = path.join(TMP, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { WS_GENERIC_SUBPROTOCOL, WS_BEARER_PREFIX } = await import("../dist/gateway/trust-tier.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const HOST = "loom-remote-test.example.com";
const TOKEN = "test-valid-gateway-token";
const LOOPBACK_SECRET = "loopback-secret-xyz";
const REMOTE = { remoteAddress: "203.0.113.7" };
const writes = [];
const shells = new Map();
const subs = [], repaints = [], resizes = [];
const ptyStub = {
  subscribe: (id) => { subs.push(id); return () => {}; },
  writeStdin: (id, data) => { writes.push({ id, data }); },
  repaint: (id) => { repaints.push(id); }, resize: (id) => { resizes.push(id); },
  listShells: () => [...shells.values()],
  spawnShell: (o) => { shells.set(o.id, { id: o.id, alive: true }); },
  stop: () => {},
};
const stub = {};
const db = new Db(path.join(TMP, "loom.db"));
db.insertProject({ id: "p1", name: "P1", repoPath: TMP, vaultPath: TMP, config: {}, createdAt: new Date().toISOString(), archivedAt: null });
db.setPlatformConfig({ remoteAccess: { enabled: true, bindHost: HOST } });
const app = await buildServer({
  db, pty: ptyStub, sessions: { killAllWorkers: () => 0 }, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub,
  userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub, requestShutdown: () => {},
  verifyGatewayToken: (t) => t === TOKEN, loopbackSecret: LOOPBACK_SECRET,
});
const H = { host: HOST, origin: `https://${HOST}` };
const proto = (t) => `${WS_GENERIC_SUBPROTOCOL}, ${WS_BEARER_PREFIX}${t}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms = 2000) { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await sleep(20); } return pred(); }

// Card 5c14fa6b — the daemon must TELL a remote viewer its pane is inert, so the pane can disable its own
// keyboard instead of silently swallowing keystrokes. Records every TEXT (JSON control) frame the server
// pushes onto one socket; binary pty bytes are not control frames and are ignored.
//
// ⚠️ The loopback leg below is an ABSENCE claim ("no readOnly frame"), and a collector that records
// NOTHING returns exactly the same empty array. The remote leg is its POSITIVE CONTROL: it runs FIRST,
// through this same recorder, and proves a frame pushed on an injectWS socket really is observed here —
// so the loopback zero is a measured zero.
//
// ⛔ The listener MUST be wired through injectWS's `onInit` hook (called synchronously before the
// handshake starts), NOT by `.on("message", …)` after `await injectWS` resolves. The route sends this
// frame the instant the socket opens, and on @fastify/websocket's in-memory duplex transport 'open' and
// that first 'message' land in the SAME synchronous flush — a post-resolve listener is attached too late
// and reads zero, which is indistinguishable from the frame never being sent. Measured here, not assumed:
// the post-resolve form was written first and FAILED this file's remote leg while the loopback leg passed.
// ws-fleet.mjs's `makeInbox` documents the same race for the same reason.
function controlRecorder() {
  const frames = [];
  const onInit = (ws) => {
    ws.on("message", (raw, isBinary) => {
      if (isBinary) return; // binary frames are raw pty bytes, never control
      try { frames.push(JSON.parse(raw.toString())); } catch { /* not a JSON control frame */ }
    });
  };
  return { onInit, frames };
}
const readOnlyFrames = (frames) => frames.filter((f) => f?.type === "readOnly");

try {
  // Create the host shell the way the owner's UI does: over LOOPBACK (with the loopback secret).
  const created = await app.inject({
    method: "POST", url: "/api/terminals", remoteAddress: "127.0.0.1",
    headers: { host: "127.0.0.1", origin: "http://127.0.0.1", "content-type": "application/json", authorization: `Bearer ${LOOPBACK_SECRET}` },
    payload: { projectId: "p1", command: "sh" },
  });
  const shellId = created.json().id;
  check("setup: shell created via loopback POST /api/terminals (201)", created.statusCode === 201 && !!shellId);

  const remotePost = await app.inject({
    method: "POST", url: "/api/terminals", remoteAddress: REMOTE.remoteAddress,
    headers: { ...H, "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, payload: { projectId: "p1", command: "sh" },
  });
  check("control: a remote token holder CANNOT create a shell (POST /api/terminals → 403, Tier 0)", remotePost.statusCode === 403);

  let denied = false;
  try { (await app.injectWS(`/ws/term/${shellId}`, { headers: H, socket: REMOTE })).close(); } catch { denied = true; }
  check("control: remote WITHOUT a token cannot open /ws/term (rejected)", denied);

  const LOOP = { remoteAddress: "127.0.0.1" };
  const LH = { host: "127.0.0.1", origin: "http://127.0.0.1" };
  // (b) host shell: remote token holder is refused outright (closed, never subscribed, no write)
  let shellClosed = false;
  try {
    const ws = await app.injectWS(`/ws/term/${shellId}`, { headers: { ...H, "sec-websocket-protocol": proto(TOKEN) }, socket: REMOTE });
    ws.on("close", () => { shellClosed = true; });
    try { ws.send(JSON.stringify({ type: "stdin", data: "echo pwned" })); } catch { /* closed */ }
    await waitFor(() => shellClosed);
  } catch { shellClosed = true; }
  check("(b) remote Tier-1 token: host shell socket is CLOSED", shellClosed);
  check("(b) remote Tier-1 token: NO stdin reached the host shell pty", !writes.some((w) => w.id === shellId));
  check("(b) remote Tier-1 token: never subscribed to the host shell (no read either)", !subs.includes(shellId));

  // (a) agent session: remote may READ + repaint, may NOT write stdin or resize
  const remoteRec = controlRecorder();
  const wsSess = await app.injectWS("/ws/term/agent-session-1", { headers: { ...H, "sec-websocket-protocol": proto(TOKEN) }, socket: REMOTE }, { onInit: remoteRec.onInit });
  const remoteFrames = remoteRec.frames;
  check("(a) remote Tier-1 token: READ of an agent session still works (subscribed)", subs.includes("agent-session-1"));
  // (c) card 5c14fa6b: the attach announces the pane is view-only. This is ALSO the positive control for
  // the loopback absence assertion further down — same helper, same socket shape.
  check("(c) remote Tier-1 token: attach pushes exactly one {type:'readOnly', reason:'remote'} frame",
    await waitFor(() => readOnlyFrames(remoteFrames).length === 1 && readOnlyFrames(remoteFrames)[0].reason === "remote"));
  wsSess.send(JSON.stringify({ type: "stdin", data: "hi" }));
  wsSess.send(JSON.stringify({ type: "resize", cols: 10, rows: 10 }));
  wsSess.send(JSON.stringify({ type: "repaint" }));
  check("(a) remote repaint is still honored (positive control for the message path)", await waitFor(() => repaints.includes("agent-session-1")));
  check("(a) remote Tier-1 token: stdin to an agent session pty is DROPPED", !writes.some((w) => w.id === "agent-session-1"));
  check("(a) remote Tier-1 token: resize is dropped", !resizes.includes("agent-session-1"));
  wsSess.close();

  // Card 5b4ddca5: a FLOOD of remote repaints on one socket yields a bounded number of pty repaints. Frames
  // on one socket are processed in order, so the follow-up probe below (sent after the limiter window) being
  // honored proves every flood frame was already processed — the count is then anchored, not a fixed wait.
  const wsFlood = await app.injectWS("/ws/term/agent-session-flood", { headers: { ...H, "sec-websocket-protocol": proto(TOKEN) }, socket: REMOTE });
  const floodCount = () => repaints.filter((r) => r === "agent-session-flood").length;
  for (let i = 0; i < 50; i++) wsFlood.send(JSON.stringify({ type: "repaint" }));
  check("(flood) first remote repaint honored", await waitFor(() => floodCount() >= 1));
  const probeEnd = Date.now() + 5000;
  while (floodCount() < 2 && Date.now() < probeEnd) { wsFlood.send(JSON.stringify({ type: "repaint" })); await waitFor(() => floodCount() >= 2, 100); }
  check("(flood) 50-frame flood + later probe → exactly 2 pty repaints (flood bounded to 1, probe honored after the window)", floodCount() === 2);
  wsFlood.close();

  // loopback controls (with the loopback secret): write to both an agent session and the shell still works
  const lp = (t) => ({ ...LH, "sec-websocket-protocol": proto(t) });
  const loopRec = controlRecorder();
  const lpS = await app.injectWS("/ws/term/agent-session-2", { headers: lp(LOOPBACK_SECRET), socket: LOOP }, { onInit: loopRec.onInit });
  const loopFrames = loopRec.frames;
  lpS.send(JSON.stringify({ type: "stdin", data: "loop-a" }));
  check("(ctl) loopback: stdin to an agent session still works", await waitFor(() => writes.some((w) => w.id === "agent-session-2" && w.data === "loop-a")));
  // (c) card 5c14fa6b: a LOCAL pane is writable, so it must be told nothing at all — no frame, no note,
  // byte-identical to before this card. The round trip above already gave a frame that WOULD be sent
  // ample time to land, and the remote leg above proved this collector records.
  check("(c) loopback: NO readOnly frame is sent (a local pane stays writable, unchanged)", readOnlyFrames(loopFrames).length === 0);
  lpS.close();
  const lpH = await app.injectWS(`/ws/term/${shellId}`, { headers: lp(LOOPBACK_SECRET), socket: LOOP });
  lpH.send(JSON.stringify({ type: "stdin", data: "loop-b" }));
  check("(ctl) loopback: stdin to the host shell still works", await waitFor(() => writes.some((w) => w.id === shellId && w.data === "loop-b")));
  lpH.close();

  // empty/undeterminable peer address fails CLOSED: no attach to the shell, no stdin, even with a valid token
  // and even with the loopback secret (the loopback guard 401s it; the handler would treat it as remote anyway)
  for (const [label, hdrs] of [["token", proto(TOKEN)], ["loopback secret", proto(LOOPBACK_SECRET)]]) {
    let refused = false;
    try {
      const ws = await app.injectWS(`/ws/term/${shellId}`, { headers: { ...H, "sec-websocket-protocol": hdrs }, socket: {} });
      ws.on("close", () => { refused = true; });
      try { ws.send(JSON.stringify({ type: "stdin", data: `empty-${label}` })); } catch { /* closed */ }
      await waitFor(() => refused);
    } catch { refused = true; }
    check(`(fail-closed) empty remoteAddress + ${label}: shell attach refused`, refused);
    check(`(fail-closed) empty remoteAddress + ${label}: no stdin reached the shell`, !writes.some((w) => w.data === `empty-${label}`));
  }
  const emptyRec = controlRecorder();
  const wsEmptySess = await app.injectWS("/ws/term/agent-session-3", { headers: { ...H, "sec-websocket-protocol": proto(TOKEN) }, socket: {} }, { onInit: emptyRec.onInit }).catch(() => null);
  if (wsEmptySess) {
    const emptyFrames = emptyRec.frames;
    wsEmptySess.send(JSON.stringify({ type: "stdin", data: "empty-sess" }));
    wsEmptySess.send(JSON.stringify({ type: "repaint" }));
    await waitFor(() => repaints.includes("agent-session-3"));
    check("(fail-closed) empty remoteAddress: stdin to an agent session is dropped (repaint sentinel proves ordering)", repaints.includes("agent-session-3") && !writes.some((w) => w.data === "empty-sess"));
    // (c) card 5c14fa6b: the NOTICE must fail closed with the DROP it describes. An undeterminable peer is
    // treated as remote for the stdin drop, so it must also be TOLD — otherwise the one case Loom is least
    // sure about is the one case it leaves typing into the void.
    check("(c) empty remoteAddress: told view-only too (the notice follows the drop, not the token)",
      readOnlyFrames(emptyFrames).length === 1 && readOnlyFrames(emptyFrames)[0].reason === "remote");
    wsEmptySess.close();
  } else check("(fail-closed) empty remoteAddress: agent-session upgrade itself refused", true);

  // loopback spellings other than 127.0.0.1 stay writable (host shell + session)
  for (const addr of ["::1", "::ffff:127.0.0.1"]) {
    const w = await app.injectWS(`/ws/term/${shellId}`, { headers: lp(LOOPBACK_SECRET), socket: { remoteAddress: addr } });
    w.send(JSON.stringify({ type: "stdin", data: `loop-${addr}` }));
    check(`(ctl) loopback ${addr}: stdin to the host shell still works`, await waitFor(() => writes.some((x) => x.id === shellId && x.data === `loop-${addr}`)));
    w.close();
  }
} finally {
  await app.close();
  db.close();
}
await finishAndExit(failures === 0 ? 0 : 1);
