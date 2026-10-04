// Hermetic unit test for the SHARED socket reconnect policy (card f8d2684d) — src/lib/socketReconnect.ts,
// the one place that decides whether a closed WebSocket is retried and how long the next attempt waits.
// Before this helper, Terminal.tsx / CompanionChat.tsx / FleetSocketProvider.tsx each carried their own
// copy of the backoff ladder and none of them read the close CODE at all, so card 3c205fb5's 1008 (a
// revoked/paused/rotated/deleted gateway token) reconnected forever behind "connection lost". Run:
//   node --experimental-strip-types packages/web/test/socket-reconnect.mjs
import assert from "node:assert/strict";
import { register } from "node:module";

// socketReconnect.ts has a REAL runtime import of ./gatewayCredential, written extensionless in the
// bundler style the app uses, which Node's own resolver cannot follow. `_tsxLoaderHook.mjs` exists for
// exactly that; registering it means the imports below must be DYNAMIC, since a static one in this same
// file would be hoisted and resolved before `register()` ever runs.
register("./_tsxLoaderHook.mjs", import.meta.url);

// The module reaches gatewayCredential, which guards `window` but reads localStorage through it.
const mem = new Map();
globalThis.window = {
  localStorage: { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)); } },
  location: { hostname: "box.tail1.ts.net", href: "https://box.tail1.ts.net:8443/board" },
  history: { replaceState: () => {} },
};

const S = await import("../src/lib/socketReconnect.ts");
const G = await import("../src/lib/gatewayCredential.ts");

let pass = 0;
const check = (name, fn) => { mem.clear(); G.resetGatewayLockForTest(); fn(); pass++; console.log(`ok   ${name}`); };

// ── classifySocketClose: the pure half ───────────────────────────────────────────────────────────────
check("1008 is the ONLY terminal code — every other code the daemon or network can send keeps retrying", () => {
  // 1008 is terminal...
  assert.equal(S.classifySocketClose({ code: 1008, reason: "gateway token revoked" }).retry, false);
  // ...and nothing else is. 1000 = normal, 1001 = going away (daemon restart), 1006 = abnormal (the code a
  // browser reports when the close frame never arrived — e.g. a bare terminate()), 1011 = server error,
  // 1012/1013 = restart/try-again, 4000 = an app-defined code nobody sends today.
  for (const code of [1000, 1001, 1002, 1003, 1005, 1006, 1011, 1012, 1013, 1015, 4000]) {
    assert.equal(S.classifySocketClose({ code, reason: "" }).retry, true, `code ${code} must retry`);
  }
  // A 1008 reason is NOT what makes it terminal — the code is. Even an empty reason stops.
  assert.equal(S.classifySocketClose({ code: 1008, reason: "" }).retry, false);
  assert.equal(S.classifySocketClose({ code: 1008 }).retry, false, "a missing reason must not crash or retry");
  // ...and conversely a gateway-token reason on a NON-1008 code is still an ordinary disconnect.
  assert.equal(S.classifySocketClose({ code: 1006, reason: "gateway token revoked" }).retry, true);
});

check("each of the daemon's four gateway-token close reasons is classified as the credential being dead", () => {
  // These four strings are exactly what gateway/server.ts passes to GatewayTokenSocketRegistry.closeAll.
  for (const change of ["revoked", "paused", "rotated", "deleted"]) {
    const v = S.classifySocketClose({ code: 1008, reason: `gateway token ${change}` });
    assert.deepEqual(v, { retry: false, kind: "gateway-token", change }, change);
  }
});

check("the OTHER 1008 producer is a per-socket refusal, NOT a credential alarm", () => {
  // gateway/server.ts's /ws/term handler (card 710a34fa) refuses a remote peer a host shell with the SAME
  // code. The credential is fine there, so this must never raise the revoked banner.
  const v = S.classifySocketClose({ code: 1008, reason: "host shell terminals are loopback-only" });
  assert.deepEqual(v, { retry: false, kind: "policy", reason: "host shell terminals are loopback-only" });
});

check("an UNRECOGNISED 1008 reason fails toward 'policy', never toward a false revoked claim", () => {
  for (const reason of ["", "some future policy", "gateway token", "gateway token expired", "GATEWAY TOKEN REVOKED",
    "gateway token revoked extra", "x gateway token revoked"]) {
    const v = S.classifySocketClose({ code: 1008, reason });
    assert.equal(v.retry, false, `${reason}: still terminal`);
    assert.equal(v.kind, "policy", `${reason}: must NOT be read as a gateway-token change`);
  }
});

// ── onSocketClose: classification + the side effect ──────────────────────────────────────────────────
check("onSocketClose notes the revoked state (and raises the banner's lock) ONLY for a gateway-token 1008", () => {
  assert.equal(G.gatewayTokenRevoked(), null, "clean start");
  assert.equal(G.gatewayLock(), false);

  // A retryable close touches nothing.
  assert.equal(S.onSocketClose({ code: 1006, reason: "" }).retry, true);
  assert.equal(G.gatewayTokenRevoked(), null);
  assert.equal(G.gatewayLock(), false, "an ordinary disconnect must never raise the gateway banner");

  // A per-socket policy 1008 is terminal but still raises nothing.
  assert.equal(S.onSocketClose({ code: 1008, reason: "host shell terminals are loopback-only" }).retry, false);
  assert.equal(G.gatewayTokenRevoked(), null, "a shell refusal is not evidence about the credential");
  assert.equal(G.gatewayLock(), false);

  // The real thing: state recorded with the specific change, and the lock raised so the banner mounts.
  S.onSocketClose({ code: 1008, reason: "gateway token rotated" });
  assert.equal(G.gatewayTokenRevoked(), "rotated");
  assert.equal(G.gatewayLock(), true, "the banner (and its paste field) is the re-entry surface");
});

check("a successful re-entry clears the revoked state — no caller has to remember to", () => {
  S.onSocketClose({ code: 1008, reason: "gateway token deleted" });
  assert.equal(G.gatewayTokenRevoked(), "deleted");
  G.clearGatewayLock(); // what GatewayTokenBanner calls once a pasted token verifies
  assert.equal(G.gatewayTokenRevoked(), null, "a stale 'was deleted' headline must not survive a good paste");
  assert.equal(G.gatewayLock(), false);
});

check("subscribers see the revoked change, and a repeat of the SAME change does not re-notify", () => {
  const seen = [];
  const unsub = G.subscribeGatewayTokenRevoked((c) => seen.push(c));
  S.onSocketClose({ code: 1008, reason: "gateway token paused" });
  S.onSocketClose({ code: 1008, reason: "gateway token paused" }); // a second socket closing for the same reason
  assert.deepEqual(seen, ["paused"], "three sockets closing together must not storm the banner with re-renders");
  S.onSocketClose({ code: 1008, reason: "gateway token revoked" }); // a genuinely different change
  assert.deepEqual(seen, ["paused", "revoked"]);
  G.clearGatewayLock();
  assert.deepEqual(seen, ["paused", "revoked", null]);
  unsub();
  S.onSocketClose({ code: 1008, reason: "gateway token deleted" });
  assert.deepEqual(seen, ["paused", "revoked", null], "unsubscribe stops delivery");
});

check("the injected note hook is what production relies on — proving the wiring, not just the classifier", () => {
  const calls = [];
  const v = S.onSocketClose({ code: 1008, reason: "gateway token revoked" }, (c) => calls.push(c));
  assert.deepEqual(calls, ["revoked"]);
  assert.equal(v.retry, false);
  // NEGATIVE CONTROL for the same hook: a retryable close must not call it at all, so the assertion above
  // is not passing merely because the hook fires unconditionally.
  const other = [];
  S.onSocketClose({ code: 1001, reason: "gateway token revoked" }, (c) => other.push(c));
  assert.deepEqual(other, []);
});

// ── createReconnectBackoff: the one ladder all three sockets share ───────────────────────────────────
check("the ladder is 1s doubling to a 10s cap, and reset() returns to the minimum", () => {
  assert.equal(S.SOCKET_RECONNECT_MIN_MS, 1000);
  assert.equal(S.SOCKET_RECONNECT_MAX_MS, 10000);
  const b = S.createReconnectBackoff();
  // next() returns the delay to wait NOW, then doubles — so the first attempt waits the minimum.
  assert.deepEqual([b.next(), b.next(), b.next(), b.next(), b.next(), b.next()], [1000, 2000, 4000, 8000, 10000, 10000]);
  b.reset();
  assert.equal(b.next(), 1000, "a socket that opened then dropped later starts the ladder over");
  assert.equal(b.next(), 2000);
});

check("two backoffs are INDEPENDENT — one socket's retries never advance another's ladder", () => {
  const a = S.createReconnectBackoff();
  const b = S.createReconnectBackoff();
  a.next(); a.next(); a.next();
  assert.equal(b.next(), 1000, "the module must hold no shared mutable delay");
  assert.equal(a.next(), 8000);
});

check("WS_CLOSE_POLICY_VIOLATION is the real 1008 constant, not a renamed local", () => {
  assert.equal(S.WS_CLOSE_POLICY_VIOLATION, 1008);
});

console.log(`\n${pass} check(s) passed`);
