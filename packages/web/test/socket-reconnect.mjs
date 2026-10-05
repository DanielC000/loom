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

check("disarm() cancels the pending attempt WITHOUT permanently refusing later ones", () => {
  // @decision 04314fbc round 2 — FleetSocketProvider's onopen re-seeds directly. Without this, a retry
  // armed by a seed failure from BEFORE the drop fires later and runs a SECOND, concurrent seed under the
  // fresh one onopen just started — the exact defect disarm() exists to close.
  const t = fakeTimers();
  const loop = S.createRetryLoop(t.deps);
  let attempts = 0;
  loop.schedule(() => { attempts++; });
  assert.equal(t.armed.size, 1, "armed");

  loop.disarm();
  assert.equal(t.armed.size, 0, "the pending attempt is cleared");
  assert.equal(loop.pendingDelay(), null);
  assert.equal(loop.stopped(), false, "disarm must NOT be permanent — stop() is the permanent one");

  // The loop must still be genuinely usable afterwards: a LATER failure can re-arm and run it.
  loop.schedule(() => { attempts++; });
  assert.equal(t.armed.size, 1, "schedule() after disarm() still arms a timer");
  t.fire(t.only());
  assert.equal(attempts, 1, "and the later attempt actually runs — disarm() didn't silently kill it");
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

// The episode checks below are ASYNC. The sync `check` above would call fn(), ignore the promise
// and count the case green before any assertion inside it ran, so they get their own awaited
// harness — the same split gateway-credential.mjs makes for its own async cases.
const acheck = async (name, fn) => {
  mem.clear(); G.resetGatewayLockForTest();
  await fn(); pass++; console.log(`ok   ${name}`);
};

// ── createRefusalEpisode (card a6d7bf36): the bound on a guaranteed-401 reconnect ladder ──────────
// A remote page holding a DEAD gateway token never sees the 1008 contract above: the upgrade 401s, so no
// socket ever opens and the browser reports a bare 1006. classifySocketClose therefore says retry (and
// must), which is how the pane came to retry a request that can only ever 401, forever, at the 10s cap.
// The episode is the one HTTP question allowed per run of failures, and only a real refusal stops it.
//
// The probe is injected here, so these assert the EPISODE's algebra, not the probe's — the probe's own
// three outcomes are covered in gateway-credential.mjs against the real module.
const episode = (outcomes, maxUnknown) => {
  const asked = [];
  const queue = [...outcomes];
  const e = S.createRefusalEpisode(async () => {
    const next = queue.length > 1 ? queue.shift() : queue[0];
    asked.push(next);
    return next;
  }, maxUnknown);
  return { e, asked };
};

await acheck("an `invalid` probe runs onDead ONCE and settles the episode", async () => {
  const { e, asked } = episode(["invalid"]);
  let dead = 0;
  e.check(() => { dead += 1; });
  // The probe is async, so the close handler has already returned and scheduled its next attempt by the
  // time this resolves. That ordering is the point: the ladder keeps running until an answer arrives.
  assert.equal(dead, 0, "the stop must not be synchronous with the close");
  await Promise.resolve(); await Promise.resolve();
  assert.equal(dead, 1);
  assert.equal(e.settled(), true);
  e.check(() => { dead += 1; });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(dead, 1, "a settled episode asks nothing and fires nothing again");
  assert.deepEqual(asked, ["invalid"], "exactly ONE probe per episode");
});

await acheck("`valid` and `none` settle the episode WITHOUT stopping the ladder", async () => {
  for (const outcome of ["valid", "none"]) {
    const { e, asked } = episode([outcome]);
    let dead = 0;
    e.check(() => { dead += 1; });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(dead, 0, outcome + " is not a refusal, so the retry ladder must keep running");
    assert.equal(e.settled(), true, outcome + " answers the question, so stop asking");
    e.check(() => { dead += 1; });
    await Promise.resolve(); await Promise.resolve();
    assert.deepEqual(asked, [outcome], "and it never asks twice");
  }
});

await acheck("`unknown` learned NOTHING, so it may re-ask — but a bounded number of times", async () => {
  // The asymmetry is deliberate. An unknown is a dropped request or an intermediary's answer, so asking
  // again is legitimate; an unbounded re-ask is the loop this mechanism exists to bound, and each ask
  // spends the same shared failed-auth budget. Past the cap the episode gives up on LEARNING and the
  // socket keeps its pre-existing unbounded retry — never a lock on an unobserved refusal.
  const { e, asked } = episode(["unknown"], 3);
  let dead = 0;
  for (let i = 0; i < 10; i += 1) {
    e.check(() => { dead += 1; });
    await Promise.resolve(); await Promise.resolve();
  }
  assert.equal(dead, 0, "an unknown must NEVER stop the ladder: that would lock a page on a restarting daemon");
  assert.equal(asked.length, 3, "re-asks are capped, not unlimited (saw " + asked.length + ")");
  assert.equal(e.settled(), true);
});

await acheck("the PRODUCTION default re-ask cap is finite — the constant is what reaches a real pane", async () => {
  // The case above injects its own cap, so it proves the mechanism and NOT that production is
  // bounded. A default of Infinity would pass it identically. This is the one that would not.
  assert.ok(Number.isInteger(S.REFUSAL_EPISODE_MAX_UNKNOWN) && S.REFUSAL_EPISODE_MAX_UNKNOWN > 0
    && S.REFUSAL_EPISODE_MAX_UNKNOWN <= 10, `the cap must be a small positive integer, saw ${S.REFUSAL_EPISODE_MAX_UNKNOWN}`);
  let asked = 0;
  const e = S.createRefusalEpisode(async () => { asked += 1; return "unknown"; });
  for (let i = 0; i < S.REFUSAL_EPISODE_MAX_UNKNOWN + 5; i += 1) {
    e.check(() => { throw new Error("an unknown must never stop the ladder"); });
    await Promise.resolve(); await Promise.resolve();
  }
  assert.equal(asked, S.REFUSAL_EPISODE_MAX_UNKNOWN, "the default cap must actually bind");
});

await acheck("an `unknown` that later turns `invalid` still stops the ladder, inside the cap", async () => {
  const { e, asked } = episode(["unknown", "invalid"], 3);
  let dead = 0;
  e.check(() => { dead += 1; });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(dead, 0);
  e.check(() => { dead += 1; });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(dead, 1);
  assert.deepEqual(asked, ["unknown", "invalid"]);
});

await acheck("reset() re-opens the episode — a socket that OPENED ends the run of failures", async () => {
  const { e, asked } = episode(["valid"]);
  e.check(() => {});
  await Promise.resolve(); await Promise.resolve();
  assert.equal(e.settled(), true);
  e.reset();
  assert.equal(e.settled(), false);
  e.check(() => {});
  await Promise.resolve(); await Promise.resolve();
  assert.equal(asked.length, 2, "the next run of failures gets its own probe");
});

await acheck("at most ONE probe is in flight, however many closes land while it is pending", async () => {
  let asked = 0;
  let release;
  const e = S.createRefusalEpisode(() => new Promise((r) => { asked += 1; release = r; }));
  for (let i = 0; i < 5; i += 1) e.check(() => {});
  assert.equal(asked, 1, "five closes during one pending probe must not fire five requests");
  release("valid");
  await Promise.resolve(); await Promise.resolve();
  assert.equal(e.settled(), true);
});

await acheck("a probe IN FLIGHT when reset() lands cannot touch the NEW episode", async () => {
  // `reset()` ends one run of failures; it cannot cancel an HTTP request already out. The real ordering
  // is unremarkable: a socket OPENS (so `reset()` runs), and the probe issued by the run of failures
  // BEFORE it answers only afterwards, describing credential state that is no longer current. Without a
  // generation fence that late `"invalid"` stops a ladder whose socket just demonstrably worked —
  // reproduced on the first pass of card a6d7bf36.
  let release;
  let asked = 0;
  const e = S.createRefusalEpisode(() => new Promise((r) => { asked += 1; release = r; }));
  let dead = 0;
  e.check(() => { dead += 1; });
  assert.equal(asked, 1);
  e.reset();          // a socket opened
  release("invalid"); // ...and only now does the superseded probe answer
  await Promise.resolve(); await Promise.resolve();
  assert.equal(dead, 0, "a superseded probe must never stop the new episode's ladder");
  assert.equal(e.settled(), false, "nor settle it — a new run of failures keeps its own question");

  // ...and the new episode is genuinely usable afterwards: its OWN probe is the one that counts.
  e.check(() => { dead += 1; });
  assert.equal(asked, 2, "reset() must leave the episode able to ask again");
  release("invalid");
  await Promise.resolve(); await Promise.resolve();
  assert.equal(dead, 1);
  assert.equal(e.settled(), true);
});

await acheck("a superseded `unknown` does not spend the NEW episode's re-ask budget", async () => {
  // The quieter half of the same fence. An `"unknown"` is not a stop, so a missing fence does not show
  // up as a dead pane here — it silently charges the stale answer to the new episode's cap, which then
  // gives up on learning early and leaves a genuinely dead credential un-probed.
  const releases = [];
  let asked = 0;
  const e = S.createRefusalEpisode(() => new Promise((r) => { asked += 1; releases.push(r); }), 2);
  e.check(() => {}); // episode 1's probe, deliberately left in flight
  e.reset();
  releases[0]("unknown");
  await Promise.resolve(); await Promise.resolve();
  // Episode 2 must now get its FULL cap of re-asks.
  for (let i = 0; i < 2; i += 1) {
    e.check(() => { throw new Error("an unknown must never stop the ladder"); });
    releases[releases.length - 1]("unknown");
    await Promise.resolve(); await Promise.resolve();
  }
  assert.equal(asked, 3, "one superseded probe plus the new episode's own two (a charged stale answer reads 2)");
  assert.equal(e.settled(), true, "and the cap binds on the new episode's own asks");
});

await acheck("a probe that THROWS settles rather than becoming a second unbounded loop", async () => {
  let asked = 0;
  const e = S.createRefusalEpisode(async () => { asked += 1; throw new Error("unexpected"); });
  let dead = 0;
  for (let i = 0; i < 5; i += 1) {
    e.check(() => { dead += 1; });
    await Promise.resolve(); await Promise.resolve();
  }
  assert.equal(asked, 1);
  assert.equal(dead, 0, "a thrown probe observed nothing, so it must not stop the ladder either");
  assert.equal(e.settled(), true);
});

console.log(`\n${pass} check(s) passed`);
