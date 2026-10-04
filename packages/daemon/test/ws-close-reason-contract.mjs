import "./_guard.mjs";
// Card 04314fbc — pins the WebSocket CLOSE CONTRACT: the exact close CODE and REASON the daemon sends on
// each of its four 1008 producers, and that each one is built from the SHARED helpers in @loom/shared
// rather than from a literal at the call site.
//
// WHY THIS EXISTS. Card f8d2684d made the browser STOP RETRYING on a 1008 and name the revoked token in
// its banner, and it decides which of those two things to do by matching the close REASON (the code alone
// cannot tell a dead credential from a per-socket policy refusal). That made the reason text a real
// cross-process contract — and it shipped with the daemon holding four literals and the browser holding
// its own private regex, with nothing tying them together. A one-word edit on either side would have
// silently downgraded a revoked-credential close to an unrecognised one: the browser still correctly
// declines to retry, but loses the revoke-specific banner copy and shows the generic "this address needs
// a gateway token" instead. No test would have failed.
//
// TWO INSTRUMENTS, deliberately, because they prove different things:
//  (A) a RECORDING GatewayTokenSocketRegistry injected into the real buildServer, driven through the real
//      REST routes a human owner actually uses. This pins the (code, reason) each writer PASSES, exactly,
//      with no dependence on close-frame delivery — `closeAll` calls `terminate()` one line after
//      `close()`, so a transport-level capture is the wrong place to pin an argument.
//  (B) a REAL remote injectWS handshake for the shell refusal, whose close capture reads the code and
//      reason OFF THE WIRE. That one is a bare `socket.close()` with no terminate behind it, and it is
//      the producer no test asserted the reason of at all before this card.
//
// HERMETIC + CLAUDE-FREE + NETWORK-FREE: temp LOOM_HOME, a real Db, app.inject / app.injectWS only.
// Run: node packages/daemon/test/ws-close-reason-contract.mjs
import fs from "node:fs";
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { hermeticPort } from "./_hermetic-port.mjs";
import { waitUntil } from "./_wait.mjs";

const TMP = mkdtempManaged("loom-ws-close-reason-");
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
const {
  GATEWAY_TOKEN_CLOSE_CHANGES,
  SHELL_LOOPBACK_ONLY_CLOSE_REASON,
  WS_CLOSE_POLICY_VIOLATION,
  gatewayTokenCloseReason,
  parseGatewayTokenCloseReason,
} = await import("@loom/shared");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const eq = (label, actual, expected) => {
  const ok = actual === expected;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`}`);
  if (!ok) failures++;
};

const HOST = "loom-ws-close-reason-test.example.com";
const REMOTE = { remoteAddress: "203.0.113.9" };
const SHELL_ID = "shell-under-test";

// ---- (A) the recording registry -----------------------------------------------------------------------
// Same shape as the real GatewayTokenSocketRegistry's call surface; records instead of closing, so each
// writer's (code, reason) is captured verbatim with nothing to race.
const closeAllCalls = [];
const repaints = [];
const registry = {
  register: () => {},
  unregister: () => {},
  closeAll: (tokenId, code, reason) => { closeAllCalls.push({ tokenId, code, reason }); },
  countFor: () => 0,
};

const stub = {};
const ptyStub = {
  subscribe: () => () => {},
  writeStdin: () => {},
  repaint: (id) => { repaints.push(id); },
  resize: () => {},
  listShells: () => [{ id: SHELL_ID, cwd: TMP, command: "pwsh", label: "shell", alive: true }],
};

const db = new Db(path.join(TMP, "loom.db"));
db.setPlatformConfig({ remoteAccess: { enabled: true, bindHost: HOST } });

const app = await buildServer({
  db, pty: ptyStub, sessions: { killAllWorkers: () => 0 }, mcp: stub, orchMcp: stub, platformMcp: stub,
  auditMcp: stub, userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub,
  requestShutdown: () => {},
  verifyGatewayToken: (t) => db.authenticateGatewayToken(t).ok,
  identifyGatewayToken: (t) => { const r = db.authenticateGatewayToken(t); return r.ok ? r.token.id : undefined; },
  gatewayTokenSockets: registry,
  remoteEndpoint: { current: { scheme: "https", port: 4444 } },
});

try {
  await app.ready();

  // ---- (0) the contract itself: builder and parser are exact inverses, and nothing else parses --------
  // Every assertion below DERIVES its expected reason from `gatewayTokenCloseReason`, so this is what
  // stops the whole file from passing vacuously if that helper were to start returning nonsense.
  eq("(0) WS_CLOSE_POLICY_VIOLATION is 1008", WS_CLOSE_POLICY_VIOLATION, 1008);
  check("(0) the four changes are exactly revoked/paused/rotated/deleted",
    [...GATEWAY_TOKEN_CLOSE_CHANGES].join(",") === "revoked,paused,rotated,deleted");
  for (const change of GATEWAY_TOKEN_CLOSE_CHANGES) {
    // The LITERAL wire text, pinned independently of the builder — a rename inside @loom/shared would
    // keep every derived assertion below happy while breaking every already-shipped browser.
    eq(`(0) the wire reason for ${change}`, gatewayTokenCloseReason(change), `gateway token ${change}`);
    eq(`(0) ${change} round-trips through the parser`, parseGatewayTokenCloseReason(gatewayTokenCloseReason(change)), change);
  }
  eq("(0) the shell refusal reason is pinned verbatim", SHELL_LOOPBACK_ONLY_CLOSE_REASON,
    "host shell terminals are loopback-only");
  // NEGATIVE CONTROL: the parser must reject what the builder cannot produce, or "it round-trips" means
  // nothing — a parser that returned the first change for any input would pass the checks above.
  for (const bogus of ["", "gateway token", "gateway token expired", "GATEWAY TOKEN REVOKED",
    "gateway token revoked extra", SHELL_LOOPBACK_ONLY_CLOSE_REASON, null, undefined]) {
    check(`(0) the parser rejects ${JSON.stringify(bogus)}`, parseGatewayTokenCloseReason(bogus) === null);
  }

  // ---- (1) POST /api/gateway-tokens/:id {status} — revoke and pause ----------------------------------
  for (const status of ["revoked", "paused"]) {
    const gw = db.createGatewayToken(`close-reason ${status}`);
    closeAllCalls.length = 0;
    const res = await app.inject({
      method: "POST", url: `/api/gateway-tokens/${gw.token.id}`, payload: { status },
    });
    eq(`(1) ${status}: REST call ok`, res.statusCode, 200);
    eq(`(1) ${status}: exactly one closeAll`, closeAllCalls.length, 1);
    eq(`(1) ${status}: token id`, closeAllCalls[0]?.tokenId, gw.token.id);
    eq(`(1) ${status}: close CODE`, closeAllCalls[0]?.code, WS_CLOSE_POLICY_VIOLATION);
    eq(`(1) ${status}: close REASON`, closeAllCalls[0]?.reason, gatewayTokenCloseReason(status));
  }

  // ---- (2) activating / a name-only edit closes NOTHING -----------------------------------------------
  // The polarity control for (1): the assertions above would read identically if the route closed
  // everything unconditionally.
  {
    const gw = db.createGatewayToken("close-reason untouched");
    closeAllCalls.length = 0;
    const rename = await app.inject({ method: "POST", url: `/api/gateway-tokens/${gw.token.id}`, payload: { name: "renamed" } });
    eq("(2) a name-only edit is accepted", rename.statusCode, 200);
    eq("(2) a name-only edit sends NO close", closeAllCalls.length, 0);
    const activate = await app.inject({ method: "POST", url: `/api/gateway-tokens/${gw.token.id}`, payload: { status: "active" } });
    eq("(2) activating is accepted", activate.statusCode, 200);
    eq("(2) activating sends NO close", closeAllCalls.length, 0);
  }

  // ---- (3) POST /api/gateway-tokens/:id/rotate --------------------------------------------------------
  {
    const gw = db.createGatewayToken("close-reason rotate");
    closeAllCalls.length = 0;
    const res = await app.inject({ method: "POST", url: `/api/gateway-tokens/${gw.token.id}/rotate` });
    eq("(3) rotate: REST call ok", res.statusCode, 200);
    eq("(3) rotate: exactly one closeAll", closeAllCalls.length, 1);
    eq("(3) rotate: close CODE", closeAllCalls[0]?.code, WS_CLOSE_POLICY_VIOLATION);
    eq("(3) rotate: close REASON", closeAllCalls[0]?.reason, gatewayTokenCloseReason("rotated"));
  }

  // ---- (4) DELETE /api/gateway-tokens/:id -------------------------------------------------------------
  {
    const gw = db.createGatewayToken("close-reason delete");
    closeAllCalls.length = 0;
    const res = await app.inject({ method: "DELETE", url: `/api/gateway-tokens/${gw.token.id}` });
    eq("(4) delete: REST call ok", res.statusCode, 200);
    eq("(4) delete: exactly one closeAll", closeAllCalls.length, 1);
    eq("(4) delete: close CODE", closeAllCalls[0]?.code, WS_CLOSE_POLICY_VIOLATION);
    eq("(4) delete: close REASON", closeAllCalls[0]?.reason, gatewayTokenCloseReason("deleted"));
  }

  // ---- (5) the OTHER 1008 producer, read off the real wire --------------------------------------------
  // A remote peer asking for a HOST SHELL terminal (decision 710a34fa). Unlike (1)-(4) this is a direct
  // `socket.close()` in the /ws/term handler with no terminate() behind it, so the close frame is
  // observable end to end — which is the right instrument for the one producer whose reason the browser
  // must NOT read as a dead credential.
  {
    const gw = db.createGatewayToken("close-reason shell");
    const headers = {
      host: HOST,
      origin: `https://${HOST}:4444`,
      "sec-websocket-protocol": `${WS_GENERIC_SUBPROTOCOL}, ${WS_BEARER_PREFIX}${gw.plaintext}`,
    };
    let closeInfo = null;
    // onInit, not a post-resolve listener: the handler closes synchronously on upgrade, so a listener
    // attached after injectWS resolves can miss the frame entirely (project memory: injectws-first-frame-needs-oninit).
    const onInit = (ws) => { ws.on("close", (code, reason) => { closeInfo = { code, reason: reason?.toString() ?? "" }; }); };
    await app.injectWS(`/ws/term/${SHELL_ID}`, { headers, socket: REMOTE }, { onInit });
    // The shared poll helper, not a fixed sleep: it returns the instant the frame lands and its expiry is
    // a diagnostic, so the assertions below read the captured event rather than a timer's say-so.
    try { await waitUntil(() => closeInfo !== null, { timeoutMs: 2000, label: "shell refusal close frame" }); }
    catch { /* the checks below report it; a throw here would hide the other producers' results */ }

    check("(5) shell refusal: the remote socket was closed", closeInfo !== null);
    eq("(5) shell refusal: close CODE", closeInfo?.code, WS_CLOSE_POLICY_VIOLATION);
    eq("(5) shell refusal: close REASON", closeInfo?.reason, SHELL_LOOPBACK_ONLY_CLOSE_REASON);
    // AND the browser-side split this reason exists to drive: it must NOT parse as a token change, or
    // the whole page would raise a "your token was revoked" banner over a healthy credential.
    check("(5) shell refusal: NOT parsed as a gateway-token change",
      parseGatewayTokenCloseReason(closeInfo?.reason ?? "") === null);
  }

  // ---- (6) an AGENT session on the same route is NOT refused ------------------------------------------
  // Polarity control for (5): the capture above proves nothing about the reason being SPECIFIC to a shell
  // if the route simply closed every remote peer. A remote peer does get an agent terminal (read-only,
  // decision 710a34fa — stdin dropped, a repaint honoured).
  //
  // Proven AFFIRMATIVELY, never by a fixed wait that no close arrived in: a timer that expires before a
  // close would have landed is indistinguishable from the socket being healthy (the same reasoning
  // gateway-token-socket-close.mjs's `proveAlive` is built on). So send a real `repaint` and poll for its
  // SERVER-OBSERVED effect — a round-trip through the live handler.
  {
    const gw = db.createGatewayToken("close-reason agent");
    const AGENT_ID = "not-a-shell-session";
    const headers = {
      host: HOST,
      origin: `https://${HOST}:4444`,
      "sec-websocket-protocol": `${WS_GENERIC_SUBPROTOCOL}, ${WS_BEARER_PREFIX}${gw.plaintext}`,
    };
    const sock = await app.injectWS(`/ws/term/${AGENT_ID}`, { headers, socket: REMOTE });
    sock.send(JSON.stringify({ type: "repaint" }));
    try { await waitUntil(() => repaints.includes(AGENT_ID), { timeoutMs: 2000, label: "agent repaint round-trip" }); }
    catch { /* reported by the check below */ }
    check("(6) a remote peer's AGENT terminal stays open and served (repaint round-trips)",
      repaints.includes(AGENT_ID));
    try { sock.terminate?.(); } catch { /* best effort */ }
  }

  await app.close();
  db.close();
} catch (err) {
  console.log("FAIL  unexpected error");
  console.log(err?.stack ?? String(err));
  failures++;
  try { await app.close(); } catch { /* ignore */ }
  try { db.close(); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — every daemon 1008 close carries code 1008 and the reason @loom/shared builds for it; the four token-status reasons parse back to their change, the shell refusal does NOT, and a name-only edit/activation closes nothing."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
