// Hermetic unit test for lib/endpointAllowlist.ts — the key allowlist planner (card 654869e2).
//
// BUG 1 (the original): KeyForm seeded its allowlist from the stored ids verbatim but rendered one
// checkbox per CURRENTLY-eligible agent, so a grant whose agent was un-flagged as an endpoint had no
// control to clear it and db.validateEndpointAllowlist 400'd every save of that key from then on.
//
// BUG 2 (the first fix's own regression, caught in review): filtering the stored ids in a useState
// INITIALIZER reads the eligible set once, at mount. With the agents query unresolved that set is empty,
// so the seed dropped EVERY grant and a save that only renamed the key silently stripped them all. Hence
// the null-vs-empty distinction below: the two states must never collapse.
//
// BUG 3: deriving the SENT set at mount and the DISCLOSED set per render let them disagree — an agent
// un-flagged while the form is open grew the disclosure but left the stale id staged, so the save 400'd
// while the UI claimed the id was dropped. One call per render returns both halves, so they cannot drift.
//
// The web package has no test runner, so this is a self-contained node script importing the pure function
// directly (mirrors test/column-sort.mjs + test/column-desired.mjs). KeyAdmin.tsx imports the SAME
// function, so this can't drift from what ships. Run it with:
//   node --experimental-strip-types packages/web/test/endpoint-allowlist.mjs
import assert from "node:assert/strict";
import { planEndpointAllowlist, ALLOWLIST_NOT_READY } from "../src/lib/endpointAllowlist.ts";

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`ok   ${name}`); };

check("BUG 2 — an UNLOADED eligible list (null) refuses to submit; it NEVER drops grants", () => {
  const plan = planEndpointAllowlist(["a1", "a2"], null);
  assert.equal(plan.ready, false, "an unknown eligible set must fail CLOSED, not filter");
  assert.equal(plan.reason, ALLOWLIST_NOT_READY);
  // The shape itself is the guarantee: there is no `send` to accidentally submit.
  assert.ok(!("send" in plan), "a not-ready plan must expose no sendable set at all");
  assert.ok(!("dropped" in plan));
});

check("BUG 2 — null and an EMPTY SET are different answers, and must not collapse", () => {
  const unloaded = planEndpointAllowlist(["a1"], null);
  const loadedEmpty = planEndpointAllowlist(["a1"], new Set());
  assert.equal(unloaded.ready, false, "not fetched yet");
  assert.equal(loadedEmpty.ready, true, "fetched, and this project genuinely has no endpoint agents");
  // Loaded-and-empty legitimately drops everything — that is a real, intended narrowing.
  assert.deepEqual(loadedEmpty.send, []);
  assert.deepEqual(loadedEmpty.dropped, ["a1"]);
});

check("BUG 1 — an ineligible staged id is dropped, not sent (it would 400)", () => {
  const plan = planEndpointAllowlist(["keep", "gone"], new Set(["keep", "other"]));
  assert.equal(plan.ready, true);
  assert.deepEqual(plan.send, ["keep"]);
  assert.deepEqual(plan.dropped, ["gone"]);
});

check("BUG 3 — send and dropped PARTITION the staged set exactly, with no overlap", () => {
  const staged = ["a", "b", "c", "d"];
  const plan = planEndpointAllowlist(staged, new Set(["a", "c"]));
  assert.equal(plan.ready, true);
  assert.deepEqual([...plan.send, ...plan.dropped].sort(), [...staged].sort(), "nothing invented, nothing lost");
  assert.equal(plan.send.some((id) => plan.dropped.includes(id)), false, "no id may be in both halves");
});

check("an all-eligible allowlist drops nothing (the ordinary, untouched path)", () => {
  const plan = planEndpointAllowlist(["a1", "a2"], new Set(["a1", "a2", "a3"]));
  assert.equal(plan.ready, true);
  assert.deepEqual(plan.send, ["a1", "a2"]);
  assert.deepEqual(plan.dropped, []);
});

check("an empty staged allowlist is ready and sends nothing — a key may grant nothing", () => {
  const plan = planEndpointAllowlist([], new Set(["a1"]));
  assert.equal(plan.ready, true);
  assert.deepEqual(plan.send, []);
  assert.deepEqual(plan.dropped, []);
});

check("it accepts a Set as `staged` (what the component actually passes)", () => {
  const plan = planEndpointAllowlist(new Set(["a1", "bad"]), new Set(["a1"]));
  assert.equal(plan.ready, true);
  assert.deepEqual(plan.send, ["a1"]);
  assert.deepEqual(plan.dropped, ["bad"]);
});

console.log(`\n${pass} passed`);
