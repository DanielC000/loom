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
// The close-reason CONTRACT itself (card 04314fbc): imported from @loom/shared so the assertions below
// derive the daemon's own reason strings rather than restating them a third time.
const P = await import("@loom/shared");

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

// ── The close CONTRACT is @loom/shared's, not this module's (card 04314fbc) ──────────────────────────
// The checks above pin the literal wire strings, which is what catches a rename on EITHER side. These
// pin the other half: that the browser reads its reasons from the same builder the daemon writes them
// with, so the two copies cannot drift apart silently in the first place.
check("every reason the daemon's own builder produces classifies as a dead credential", () => {
  assert.deepEqual([...P.GATEWAY_TOKEN_CLOSE_CHANGES], ["revoked", "paused", "rotated", "deleted"]);
  for (const change of P.GATEWAY_TOKEN_CLOSE_CHANGES) {
    const reason = P.gatewayTokenCloseReason(change); // EXACTLY what gateway/server.ts passes to closeAll
    const v = S.classifySocketClose({ code: P.WS_CLOSE_POLICY_VIOLATION, reason });
    assert.deepEqual(v, { retry: false, kind: "gateway-token", change }, reason);
    // ...and the parser is the exact inverse of the builder, so neither side can widen alone.
    assert.equal(P.parseGatewayTokenCloseReason(reason), change);
  }
  // The OTHER producer's shared constant must stay on the no-false-alarm side of the split.
  const refused = S.classifySocketClose({ code: 1008, reason: P.SHELL_LOOPBACK_ONLY_CLOSE_REASON });
  assert.deepEqual(refused, { retry: false, kind: "policy", reason: P.SHELL_LOOPBACK_ONLY_CLOSE_REASON });
  // NEGATIVE CONTROL for the parser: it must reject anything the builder cannot have produced, or the
  // round-trip above would pass for a parser that simply says yes.
  for (const bogus of ["", "gateway token", "gateway token expired", "gateway token revoked ",
    "GATEWAY TOKEN REVOKED", P.SHELL_LOOPBACK_ONLY_CLOSE_REASON, null, undefined]) {
    assert.equal(P.parseGatewayTokenCloseReason(bogus), null, `${bogus}`);
  }
  assert.equal(S.WS_CLOSE_POLICY_VIOLATION, P.WS_CLOSE_POLICY_VIOLATION, "one definition of 1008, re-exported");
});

// ── handleSocketClose: the schedule-or-stop decision itself (card 04314fbc) ──────────────────────────
// `onSocketClose` returns a verdict and leaves the decision to the caller, which is how CompanionChat
// came to turn ANY 1008 — including an unrecognised one — into a "token revoked" pill. This unit runs
// exactly ONE named branch, so the collapse is no longer expressible at a call site.
const recorder = () => {
  const ran = [];
  return {
    ran,
    actions: {
      retry: () => ran.push(["retry"]),
      tokenDead: (change) => ran.push(["tokenDead", change]),
      refused: (reason) => ran.push(["refused", reason]),
    },
  };
};

check("a retryable close runs ONLY retry — never a terminal branch", () => {
  for (const code of [1000, 1001, 1006, 1011, 4001]) {
    const r = recorder();
    const v = S.handleSocketClose({ code, reason: "" }, r.actions, () => {});
    assert.deepEqual(r.ran, [["retry"]], `code ${code}`);
    assert.deepEqual(v, { retry: true });
  }
});

check("a gateway-token 1008 runs ONLY tokenDead, carrying the change, and raises the lock", () => {
  for (const change of P.GATEWAY_TOKEN_CLOSE_CHANGES) {
    mem.clear(); G.resetGatewayLockForTest();
    const r = recorder();
    S.handleSocketClose({ code: 1008, reason: P.gatewayTokenCloseReason(change) }, r.actions);
    assert.deepEqual(r.ran, [["tokenDead", change]], change);
    assert.equal(G.gatewayTokenRevoked(), change, "the banner's own state still gets set");
    assert.equal(G.gatewayLock(), true);
  }
});

check("a policy 1008 runs ONLY refused — and must NOT claim the credential is dead", () => {
  for (const reason of [P.SHELL_LOOPBACK_ONLY_CLOSE_REASON, "", "some future policy", "gateway token expired"]) {
    mem.clear(); G.resetGatewayLockForTest();
    const r = recorder();
    S.handleSocketClose({ code: 1008, reason }, r.actions);
    assert.deepEqual(r.ran, [["refused", reason]], reason);
    assert.equal(G.gatewayTokenRevoked(), null, `${reason}: no false revoked claim`);
    assert.equal(G.gatewayLock(), false, `${reason}: no banner`);
  }
});

// ── createRetryLoop: a seed/reseed loop that a terminal close can END (card 04314fbc) ────────────────
// The fleet provider's two seed fetches used to retry on a bare `setTimeout(seed, 1000)` that the
// terminal-close branch never cleared, so a revoke landing while a seed was in flight left a 1 Hz
// guaranteed-401 loop running forever.
const fakeTimers = () => {
  let nextId = 1;
  const armed = new Map();
  return {
    armed,
    deps: {
      setTimer: (fn, ms) => { const id = nextId++; armed.set(id, { fn, ms }); return id; },
      clearTimer: (id) => { armed.delete(id); },
    },
    fire: (id) => { const t = armed.get(id); armed.delete(id); t.fn(); },
    only: () => { assert.equal(armed.size, 1, `expected exactly one armed timer, saw ${armed.size}`); return [...armed.keys()][0]; },
  };
};

check("a retry loop rides the SHARED capped ladder, not a fixed 1s interval", () => {
  const t = fakeTimers();
  const loop = S.createRetryLoop(t.deps);
  const delays = [];
  for (let i = 0; i < 6; i++) { loop.schedule(() => {}); delays.push(loop.pendingDelay()); t.fire(t.only()); }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 10000, 10000],
    "a fixed SOCKET_RECONNECT_MIN_MS retry would read [1000, 1000, 1000, ...]");
  loop.reset();
  loop.schedule(() => {});
  assert.equal(loop.pendingDelay(), 1000, "a successful attempt restarts the ladder");
});

check("stop() cancels the PENDING attempt and refuses every later one — permanently", () => {
  const t = fakeTimers();
  const loop = S.createRetryLoop(t.deps);
  let attempts = 0;
  loop.schedule(() => { attempts++; });
  assert.equal(t.armed.size, 1, "armed");
  assert.equal(loop.stopped(), false);

  loop.stop();
  assert.equal(t.armed.size, 0, "the in-flight timer is CLEARED, not left to fire");
  assert.equal(loop.pendingDelay(), null);
  assert.equal(loop.stopped(), true);

  // The exact shape of the bug: the fetch that was already in flight rejects AFTER the terminal close
  // and asks for one more retry. It must get nothing, now and forever.
  for (let i = 0; i < 50; i++) loop.schedule(() => { attempts++; });
  assert.equal(t.armed.size, 0, "a stopped loop arms no timer at all");
  assert.equal(attempts, 0, "and never runs the attempt");
});

check("an un-stopped loop DOES keep retrying — the positive control for the check above", () => {
  // Without this, "nothing was armed" would pass just as happily for a loop that never arms anything.
  const t = fakeTimers();
  const loop = S.createRetryLoop(t.deps);
  let attempts = 0;
  const attempt = () => { attempts++; loop.schedule(attempt); }; // the real failing-fetch shape
  loop.schedule(attempt);
  for (let i = 0; i < 5; i++) t.fire(t.only());
  assert.equal(attempts, 5, "a live loop re-arms after each attempt");
  assert.equal(t.armed.size, 1, "and is still armed");
});

check("schedule() REPLACES the pending attempt rather than stacking a second timer", () => {
  const t = fakeTimers();
  const loop = S.createRetryLoop(t.deps);
  loop.schedule(() => {});
  loop.schedule(() => {});
  loop.schedule(() => {});
  assert.equal(t.armed.size, 1, "three schedules must never leave three timers armed");
});

check("two retry loops are INDEPENDENT — stopping one must not stop the other", () => {
  const t = fakeTimers();
  const a = S.createRetryLoop(t.deps);
  const b = S.createRetryLoop(t.deps);
  a.schedule(() => {});
  b.schedule(() => {});
  a.stop();
  assert.equal(a.stopped(), true);
  assert.equal(b.stopped(), false, "the module must hold no shared stopped flag");
  assert.equal(t.armed.size, 1, "only a's timer was cleared");
});

console.log(`\n${pass} check(s) passed`);
