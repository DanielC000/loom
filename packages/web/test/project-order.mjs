// Hermetic unit test for the Atlas tree's project ordering — src/lib/projectOrder.ts, card ec1aa18e
// ("Currently running projects should be ordered at the top, ordered alphabetically. Above projects
// that are not currently running."). No daemon, no browser: it imports the real comparator and
// asserts on plain objects, so it cannot drift from a copy.
//
// The `isRunning` predicate is supplied by the caller, which is what makes this testable at all —
// AtlasTree feeds it `liveCountsByProject`, this file feeds it a set of ids.
//
// Run it with: node --experimental-strip-types packages/web/test/project-order.mjs
import assert from "node:assert/strict";
import { sortProjectsRunningFirst } from "../src/lib/projectOrder.ts";

/** A minimal project row — the shape the comparator reads (id, name). */
const p = (id, name) => ({ id, name });
/** Order by id, given the set of ids counted as running. */
const order = (projects, running = []) =>
  sortProjectsRunningFirst(projects, (x) => running.includes(x.id)).map((x) => x.id);

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`ok   ${name}`); };

// 1) The headline claim: a running project leads an idle one that would otherwise sort above it.
check("a running project leads an idle one that is alphabetically earlier", () => {
  const arr = [p("a", "Alpha"), p("z", "Zulu")];
  assert.deepEqual(order(arr, ["z"]), ["z", "a"]);
  // ...and the control: with NOTHING running, the same two rows sort the other way round. Without
  // this the line above would pass against a build that merely reversed the list.
  assert.deepEqual(order(arr, []), ["a", "z"]);
});

// 2) Alphabetical WITHIN each group, both groups at once — so a build that sorted only the running
//    half (or only the idle half) fails here rather than passing on the split alone.
check("each group is alphabetical, and the two groups do not interleave", () => {
  const arr = [p("1", "Delta"), p("2", "Bravo"), p("3", "Echo"), p("4", "Alpha")];
  assert.deepEqual(order(arr, ["1", "3"]), ["1", "3", "4", "2"]); // Delta, Echo | Alpha, Bravo
});

// 3) Input order does not survive: the comparator is a total order, not a stable pass over whatever
//    the provider happened to hand it. Two shuffles of the same rows must agree.
check("the result is independent of input order", () => {
  const rows = [p("a", "Alpha"), p("b", "Bravo"), p("c", "Charlie")];
  const running = ["c"];
  assert.deepEqual(order(rows, running), ["c", "a", "b"]);
  assert.deepEqual(order(rows.slice().reverse(), running), ["c", "a", "b"]);
});

// 4) TIE — two projects sharing a name, in the same group. The id breaks it, so the pair never swaps
//    places between renders. (A comparator returning 0 here would leave the order up to the engine's
//    sort stability and the order the provider's array arrived in.)
check("projects with the SAME name break the tie by id, deterministically", () => {
  const rows = [p("b2", "Loom"), p("a1", "Loom")];
  assert.deepEqual(order(rows, []), ["a1", "b2"]);
  assert.deepEqual(order(rows.slice().reverse(), []), ["a1", "b2"]);
  // Same name, DIFFERENT groups: liveness still wins over the id tiebreak.
  assert.deepEqual(order(rows, ["b2"]), ["b2", "a1"]);
});

// 5) TIE of the other kind — every project running, or none. Both collapse to one alphabetical list.
check("all-running and none-running both give one alphabetical list", () => {
  const rows = [p("c", "Charlie"), p("a", "Alpha"), p("b", "Bravo")];
  assert.deepEqual(order(rows, ["a", "b", "c"]), ["a", "b", "c"]);
  assert.deepEqual(order(rows, []), ["a", "b", "c"]);
});

// 6) Case does not split the alphabet. A raw `<` on UTF-16 code units puts every capitalised name
//    ahead of every lowercase one ("Zulu" before "alpha"), which is not what a reader means by
//    alphabetical — so this asserts the `sensitivity: "base"` collation, not just "it sorted".
check("alphabetical is case-insensitive", () => {
  const rows = [p("z", "Zulu"), p("a", "alpha"), p("m", "Mike")];
  assert.deepEqual(order(rows, []), ["a", "m", "z"]);
});

// 7) EMPTY, and the degenerate single. Neither throws, and the empty case returns an empty array
//    rather than undefined.
check("empty and single-project lists are handled", () => {
  assert.deepEqual(order([], []), []);
  assert.deepEqual(order([], ["nothing-matches"]), []);
  assert.deepEqual(order([p("only", "Only")], []), ["only"]);
  assert.deepEqual(order([p("only", "Only")], ["only"]), ["only"]);
});

// 8) The caller's array is SHARED state (ActiveProjectProvider's own memoised `projects`), so the
//    comparator must not sort it in place — a mutated input would re-order a list other consumers
//    hold a reference to, with no re-render to tell them.
check("the caller's array is not mutated", () => {
  const rows = [p("z", "Zulu"), p("a", "Alpha")];
  const before = rows.map((x) => x.id);
  const out = sortProjectsRunningFirst(rows, (x) => x.id === "z");
  assert.deepEqual(rows.map((x) => x.id), before, "the input array was sorted in place");
  assert.notEqual(out, rows, "the same array instance was returned");
  assert.deepEqual(out.map((x) => x.id), ["z", "a"]);
});

console.log(`\nAll ${pass} checks passed`);
