// Hermetic unit test for the web-side session comparators in src/lib/sessions.ts — the FLAT
// live-terminal grid order used by Overview (ProjectTerminals) and the Terminals page. No daemon,
// no claude, no fs/db: it imports the pure comparator directly and asserts on plain objects.
//
// The web package has no test runner, so this is a self-contained node script. It imports the TS
// source via Node's type stripping (only `import type` from @loom/shared is erased), so the test
// exercises the REAL shipped comparator and can't drift from a copy. Run it with:
//   node --experimental-strip-types packages/web/test/sessions-order.mjs
import assert from "node:assert/strict";
import { byManagerThenCreated, byCreatedStable } from "../src/lib/sessions.ts";

// A minimal session row — the shape byManagerThenCreated/byCreatedStable read (id, role, createdAt).
const s = (id, role, createdAt) => ({ id, role, createdAt });
const order = (arr) => arr.slice().sort(byManagerThenCreated).map((x) => x.id);

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`ok   ${name}`); };

// 1) Managers always sort before workers (the bug: the oldest manager used to sink last).
check("managers rank before workers regardless of age", () => {
  const arr = [
    s("w-new", "worker", "2026-06-15T05:00:00Z"),
    s("m-old", "manager", "2026-06-15T01:00:00Z"), // oldest, yet must lead
    s("w-mid", "worker", "2026-06-15T03:00:00Z"),
  ];
  assert.deepEqual(order(arr), ["m-old", "w-new", "w-mid"]);
});

// 2) Within the manager bucket: newest-first (createdAt DESC).
check("multiple managers sort newest-first, then all workers", () => {
  const arr = [
    s("w1", "worker", "2026-06-15T02:00:00Z"),
    s("m-old", "manager", "2026-06-15T01:00:00Z"),
    s("w2", "worker", "2026-06-15T03:00:00Z"),
    s("m-new", "manager", "2026-06-15T04:00:00Z"),
  ];
  assert.deepEqual(order(arr), ["m-new", "m-old", "w2", "w1"]);
});

// 3) Within a bucket, equal createdAt falls back to the id tiebreak (stable, deterministic).
check("equal createdAt breaks ties by id (ascending)", () => {
  const arr = [
    s("b", "worker", "2026-06-15T02:00:00Z"),
    s("a", "worker", "2026-06-15T02:00:00Z"),
    s("c", "worker", "2026-06-15T02:00:00Z"),
  ];
  assert.deepEqual(order(arr), ["a", "b", "c"]);
});

// 4) null / undefined role is NOT a manager — it sorts into the non-manager bucket.
check("null/undefined role is treated as non-manager", () => {
  const arr = [
    s("plain", null, "2026-06-15T05:00:00Z"),
    s("undef", undefined, "2026-06-15T06:00:00Z"),
    s("mgr", "manager", "2026-06-15T01:00:00Z"),
  ];
  // manager leads; the two roleless rows follow, newest-first among themselves.
  assert.deepEqual(order(arr), ["mgr", "undef", "plain"]);
});

// 5) STABLE key: the order is independent of input order (immutable createdAt/id), so a 3s poll
//    that re-fetches the same rows in any order never reshuffles the grid.
check("order is independent of input ordering (no poll reshuffle)", () => {
  const rows = [
    s("m1", "manager", "2026-06-15T01:00:00Z"),
    s("m2", "manager", "2026-06-15T02:00:00Z"),
    s("w1", "worker", "2026-06-15T03:00:00Z"),
    s("w2", "worker", "2026-06-15T04:00:00Z"),
  ];
  const expected = ["m2", "m1", "w2", "w1"];
  assert.deepEqual(order(rows), expected);
  assert.deepEqual(order(rows.slice().reverse()), expected);
  assert.deepEqual(order([rows[2], rows[0], rows[3], rows[1]]), expected);
});

// 6) Within a single role-bucket, byManagerThenCreated matches byCreatedStable (newest-first, id
//    tiebreak) — the manager rule only kicks in across buckets, never changes intra-bucket order.
check("intra-bucket order matches byCreatedStable", () => {
  const workers = [
    s("w-a", "worker", "2026-06-15T03:00:00Z"),
    s("w-b", "worker", "2026-06-15T01:00:00Z"),
    s("w-c", "worker", "2026-06-15T02:00:00Z"),
  ];
  const viaManager = workers.slice().sort(byManagerThenCreated).map((x) => x.id);
  const viaCreated = workers.slice().sort(byCreatedStable).map((x) => x.id);
  assert.deepEqual(viaManager, viaCreated);
});

console.log(`\n${pass} passed`);
