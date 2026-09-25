// Hermetic unit test for lib/taskHierarchy.ts — the board-hierarchy read model (card 1ae4f88c, the UI
// half of the owner-directed board hierarchy; the daemon/REST half is card 3df86c87).
//
// The load-bearing property here is GRACEFUL DEGRADATION: this UI has to render against an older daemon
// that sends none of these fields, and it must then draw exactly what the board drew before the card
// existed. That's an ABSENCE behaviour, so it can't be proven by eyeballing the new UI against a new
// daemon — it needs the absent-field case asserted directly, which is what this file is for. The
// tolerance cases below (wrong types, half-built refs) exist for the same reason: a render must not throw
// on a field that came back malformed, and "it didn't throw in my one screenshot" isn't evidence.
//
// The web package has no test runner, so this is a self-contained node script importing the pure module
// directly (only `import type` is stripped), mirroring test/column-sort.mjs. test/run-all.mjs discovers
// it automatically, and `pnpm build` runs that — so this is part of the gate, not an optional extra. Run
// it alone with:
//   node --experimental-strip-types packages/web/test/task-hierarchy.mjs
import assert from "node:assert/strict";
import {
  boardHierarchy, hasBoardHierarchy, taskLinks, hasTaskLinks, splitResolved, resolveParentInput,
  RELATION_KINDS, RESOLVABLE_KINDS,
} from "../src/lib/taskHierarchy.ts";

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`ok   ${name}`); };

// ── Graceful degradation: an OLDER daemon sends none of these fields ──────────────────────────────
check("a board row with no hierarchy fields reads as fully empty and renders nothing", () => {
  const h = boardHierarchy({ id: "t1", title: "plain card" });
  assert.deepEqual(h, { parentId: null, childCount: 0, childDone: 0, blockedByOpen: 0, blockedByFirst: null });
  assert.equal(hasBoardHierarchy(h), false);
});

check("a task read with no hierarchy fields reads as fully empty and renders nothing", () => {
  const l = taskLinks({ id: "t1", title: "plain card" });
  assert.equal(l.parentId, null);
  assert.equal(l.parent, null);
  assert.deepEqual(l.children, { done: 0, total: 0, items: [] });
  for (const k of RELATION_KINDS) assert.deepEqual(l.relations[k], []);
  assert.equal(hasTaskLinks(l), false);
});

check("a null/undefined task (detail still loading) is empty, not a throw", () => {
  for (const t of [null, undefined]) {
    const l = taskLinks(t);
    assert.equal(hasTaskLinks(l), false);
    assert.equal(l.children.total, 0);
  }
});

// ── The populated contract ────────────────────────────────────────────────────────────────────────
check("a board row carries parent, child progress and the first blocker", () => {
  const h = boardHierarchy({
    id: "t1", title: "child card", parentId: "epic-1",
    childCount: 7, childDone: 4, blockedByOpen: 2,
    blockedByFirst: { id: "b1", title: "the blocker" },
  });
  assert.deepEqual(h, {
    parentId: "epic-1", childCount: 7, childDone: 4, blockedByOpen: 2,
    blockedByFirst: { id: "b1", title: "the blocker" },
  });
  assert.equal(hasBoardHierarchy(h), true);
});

check("each hierarchy signal alone is enough to render the card's meta row", () => {
  assert.equal(hasBoardHierarchy(boardHierarchy({ parentId: "p" })), true);
  assert.equal(hasBoardHierarchy(boardHierarchy({ childCount: 1 })), true);
  assert.equal(hasBoardHierarchy(boardHierarchy({ blockedByOpen: 1 })), true);
  // childDone alone cannot happen (it implies children) and must NOT light the row on its own.
  assert.equal(hasBoardHierarchy(boardHierarchy({ childDone: 3 })), false);
});

check("a task read carries parentId, parent, children and all five relation buckets", () => {
  // The FROZEN contract shape (3df86c87 §item 7): `children` is an OBJECT {done,total,items} and there is
  // a top-level `parentId` beside the resolved `parent`.
  const l = taskLinks({
    parentId: "epic-1",
    parent: { id: "epic-1", title: "the epic", columnKey: "in_progress" },
    children: {
      done: 1, total: 2,
      items: [
        { id: "c1", title: "sub one", columnKey: "done" },
        { id: "c2", title: "sub two", columnKey: "todo" },
      ],
    },
    relations: {
      blockedBy: [{ id: "b1", title: "blocker", columnKey: "todo", resolved: false }],
      blocks: [{ id: "b2", title: "blockee", columnKey: "todo", resolved: false }],
      related: [{ id: "r1", title: "sibling", columnKey: "backlog" }],
      discoveredFrom: [{ id: "d1", title: "origin", columnKey: "done" }],
      discoveries: [{ id: "d2", title: "spun out", columnKey: "inbox" }],
    },
  });
  assert.equal(l.parentId, "epic-1");
  assert.equal(l.parent.id, "epic-1");
  assert.equal(l.parent.title, "the epic");
  assert.equal(l.children.items.length, 2);
  assert.equal(l.children.done, 1);
  assert.equal(l.children.total, 2);
  for (const k of RELATION_KINDS) assert.equal(l.relations[k].length, 1, `${k} should carry one edge`);
  assert.equal(hasTaskLinks(l), true);
});

check("parentId falls back to the resolved parent's id, and vice versa is not invented", () => {
  // The write mirrors `parentId`, so the control must still resolve if only `parent` came back…
  assert.equal(taskLinks({ parent: { id: "p1", title: "the epic", columnKey: "todo" } }).parentId, "p1");
  // …and a bare parentId with no resolved parent leaves `parent` null rather than fabricating a title.
  const bare = taskLinks({ parentId: "p1" });
  assert.equal(bare.parentId, "p1");
  assert.equal(bare.parent, null);
});

check("children.total falls back to the item count when the server sent no total", () => {
  const l = taskLinks({ children: { items: [{ id: "c1", title: "a", columnKey: "todo" }, { id: "c2", title: "b", columnKey: "todo" }] } });
  assert.equal(l.children.total, 2);
});

check("an exact children.total LARGER than the capped items list is preserved, not shrunk", () => {
  // The contract caps `items` at 100 while done/total stay exact — so a 140-child epic must still read
  // "n/140". Shrinking to the item count would silently understate a capped epic.
  const items = Array.from({ length: 100 }, (_, i) => ({ id: `c${i}`, title: `sub ${i}`, columnKey: "todo" }));
  const l = taskLinks({ children: { items, done: 90, total: 140 } });
  assert.equal(l.children.items.length, 100);
  assert.equal(l.children.total, 140);
  assert.equal(l.children.done, 90);
});

// ── Tolerance: a malformed field must read as absent, never throw inside a render ─────────────────
check("wrong-typed counts read as 0 rather than rendering NaN/negative progress", () => {
  const h = boardHierarchy({ childCount: "7", childDone: -2, blockedByOpen: 1.5, parentId: "" });
  assert.equal(h.childCount, 0);
  assert.equal(h.childDone, 0);
  assert.equal(h.blockedByOpen, 0);
  assert.equal(h.parentId, null, "an empty-string parentId is no parent, not a parent with a blank id");
  assert.equal(hasBoardHierarchy(h), false);
});

check("a ref missing its id or title is dropped, so no empty clickable row is drawn", () => {
  assert.equal(boardHierarchy({ blockedByFirst: { id: "b1" } }).blockedByFirst, null);
  assert.equal(boardHierarchy({ blockedByFirst: { title: "no id" } }).blockedByFirst, null);
  assert.equal(boardHierarchy({ blockedByFirst: "b1" }).blockedByFirst, null);
  const l = taskLinks({ children: { items: [{ id: "c1", title: "keep", columnKey: "todo" }, { id: "c2" }, null, "c3"] } });
  assert.equal(l.children.items.length, 1);
  assert.equal(l.children.items[0].id, "c1");
});

check("a missing columnKey keeps the link usable, just without a lane chip", () => {
  const l = taskLinks({ parent: { id: "p1", title: "the epic" } });
  assert.equal(l.parent.columnKey, "");
  assert.equal(l.parent.resolved, false);
});

check("a non-object children payload reads as empty rather than throwing", () => {
  for (const children of ["nope", 7, null, []]) {
    const l = taskLinks({ children });
    assert.deepEqual(l.children, { done: 0, total: 0, items: [] }, `children: ${JSON.stringify(children)}`);
  }
});

check("non-object / non-array relation payloads read as empty buckets", () => {
  for (const relations of ["nope", 7, null, [], { blockedBy: "b1", blocks: 3 }]) {
    const l = taskLinks({ relations });
    for (const k of RELATION_KINDS) assert.deepEqual(l.relations[k], [], `${k} should be empty for ${JSON.stringify(relations)}`);
  }
});

// ── Resolved blockers are history, not noise ──────────────────────────────────────────────────────
check("splitResolved separates live blockers from resolved history, keeping both", () => {
  const { open, resolved } = splitResolved([
    { id: "b1", title: "still blocking", columnKey: "todo", resolved: false },
    { id: "b2", title: "was blocking", columnKey: "done", resolved: true },
    { id: "b3", title: "also blocking", columnKey: "todo", resolved: false },
  ]);
  assert.deepEqual(open.map((r) => r.id), ["b1", "b3"]);
  assert.deepEqual(resolved.map((r) => r.id), ["b2"]);
});

check("a `resolved` flag that isn't literally true counts as OPEN (fail-safe: still shown as blocking)", () => {
  // Asserted THROUGH taskLinks, because that's the layer that owns the normalization: splitResolved's
  // input is already-normalized TaskRefs (boolean `resolved`), so feeding it a raw truthy value would
  // test a shape it can never legitimately receive. Reading a truthy-but-not-true value as resolved
  // would HIDE a live blocker in muted history — the expensive direction — so it defaults to open.
  const l = taskLinks({
    relations: {
      blockedBy: [
        { id: "b1", title: "a", columnKey: "todo", resolved: "yes" },
        { id: "b2", title: "b", columnKey: "todo" },
        { id: "b3", title: "c", columnKey: "done", resolved: true },
      ],
    },
  });
  const { open, resolved } = splitResolved(l.relations.blockedBy);
  assert.deepEqual(open.map((r) => r.id), ["b1", "b2"]);
  assert.deepEqual(resolved.map((r) => r.id), ["b3"]);
});

check("BOTH blocks directions carry `resolved`, and only those two buckets do", () => {
  // Frozen contract: "`resolved` is on the edge's BLOCKER side for both `blockedBy` and `blocks`". For
  // `blocks` the blocker is THIS card, so that bucket is all-open or all-resolved together — still read
  // and split the same way, rather than special-cased.
  assert.deepEqual(RESOLVABLE_KINDS, ["blockedBy", "blocks"]);
  const l = taskLinks({
    relations: {
      blocks: [
        { id: "x1", title: "downstream one", columnKey: "todo", resolved: true },
        { id: "x2", title: "downstream two", columnKey: "todo", resolved: true },
      ],
      related: [{ id: "r1", title: "sibling", columnKey: "todo" }],
    },
  });
  const { open, resolved } = splitResolved(l.relations.blocks);
  assert.equal(open.length, 0);
  assert.deepEqual(resolved.map((r) => r.id), ["x1", "x2"]);
  // A bucket with no notion of resolution never claims one.
  assert.equal(l.relations.related[0].resolved, false);
});

check("`released` marks auto-released deferral history and is kept distinct from plain `resolved`", () => {
  // Contract: `released:true` appears ONLY with `resolved:true` and means auto-released DEFERRAL history —
  // display-only, no longer a declared dependency. A merely-resolved edge IS still a declared dependency
  // whose blocker happens to be done. Both are history; the UI must be able to tell them apart.
  const l = taskLinks({
    relations: {
      blockedBy: [
        { id: "b1", title: "still blocking", columnKey: "todo", resolved: false },
        { id: "b2", title: "declared, blocker done", columnKey: "done", resolved: true },
        { id: "b3", title: "auto-released deferral", columnKey: "done", resolved: true, released: true },
      ],
    },
  });
  const { open, resolved } = splitResolved(l.relations.blockedBy);
  assert.deepEqual(open.map((r) => r.id), ["b1"]);
  assert.deepEqual(resolved.map((r) => r.id), ["b2", "b3"]);
  assert.equal(resolved.find((r) => r.id === "b2").released, false, "a plain resolved edge is not released");
  assert.equal(resolved.find((r) => r.id === "b3").released, true);
});

check("`released:true` forces history even if `resolved` didn't come with it", () => {
  // The two defaults fail in OPPOSITE directions, both toward safety: an unrecognised `resolved` leaves an
  // edge OPEN (never hide a live blocker), while an explicit `released:true` moves it to history (never
  // show dead deferral history as still blocking). Contract says the pair always agrees; this pins the
  // behaviour if it ever doesn't.
  const l = taskLinks({ relations: { blockedBy: [{ id: "b1", title: "a", columnKey: "done", released: true }] } });
  assert.equal(l.relations.blockedBy[0].resolved, true);
  assert.equal(l.relations.blockedBy[0].released, true);
  assert.equal(splitResolved(l.relations.blockedBy).open.length, 0);
});

check("a non-true `released` never fabricates history", () => {
  const l = taskLinks({ relations: { blockedBy: [{ id: "b1", title: "a", columnKey: "todo", released: "yes" }] } });
  assert.equal(l.relations.blockedBy[0].released, false);
  assert.equal(l.relations.blockedBy[0].resolved, false);
  assert.equal(splitResolved(l.relations.blockedBy).open.length, 1);
});

// ── The drawer's Parent field: id / prefix resolution ─────────────────────────────────────────────
// The whole point of this resolver is that a WRONG entry can never be mistaken for a CLEAR. Save sends
// `parentId: null` only for a genuinely empty field; every other non-"ok" state blocks the save instead,
// so each failure mode has to come back distinguishable rather than collapsed into one "invalid".
const BOARD = new Map([
  ["1ae4f88c-e3f1-4f0b-9a09-c2b588ebe03f", "the UI card"],
  ["3df86c87-035d-42fd-8e03-466252bc68c2", "the daemon card"],
  ["3df86c99-aaaa-4000-8000-000000000000", "a near-collision card"],
]);
const SELF = "1ae4f88c-e3f1-4f0b-9a09-c2b588ebe03f";

check("an empty field resolves to `empty` — the ONE state that means clear the parent", () => {
  for (const input of ["", "   "]) {
    const r = resolveParentInput(input, SELF, BOARD);
    assert.equal(r.state, "empty");
    assert.equal(r.id, null);
  }
});

check("a full id and an unambiguous prefix both resolve to the same card", () => {
  const full = resolveParentInput("3df86c87-035d-42fd-8e03-466252bc68c2", SELF, BOARD);
  assert.equal(full.state, "ok");
  assert.equal(full.id, "3df86c87-035d-42fd-8e03-466252bc68c2");
  assert.equal(full.title, "the daemon card");
  // 8 chars is the handle used everywhere else in Loom; "3df86c8" is shorter but still unambiguous here.
  for (const prefix of ["3df86c87", "3df86c8"]) {
    const r = resolveParentInput(prefix, SELF, BOARD);
    assert.equal(r.state, "ok", `${prefix} should resolve`);
    assert.equal(r.id, "3df86c87-035d-42fd-8e03-466252bc68c2");
  }
});

check("resolution is case-insensitive and tolerates surrounding whitespace", () => {
  const r = resolveParentInput("  3DF86C87  ", SELF, BOARD);
  assert.equal(r.state, "ok");
  assert.equal(r.id, "3df86c87-035d-42fd-8e03-466252bc68c2");
});

check("a prefix matching several cards is `ambiguous` and reports the TRUE match count", () => {
  // "3df86c" hits both 3df86c87… and 3df86c99… — and the count must be the real number of matches, not a
  // fixed 2 from an early exit, because the message quotes it back to the user.
  const r = resolveParentInput("3df86c", SELF, BOARD);
  assert.equal(r.state, "ambiguous");
  assert.equal(r.id, null);
  assert.equal(r.matches, 2);
});

check("a prefix matching nothing is `unknown`, NOT a clear", () => {
  const r = resolveParentInput("deadbeef", SELF, BOARD);
  assert.equal(r.state, "unknown");
  assert.equal(r.id, null);
});

check("this card's own id (full or prefix) is `self`, never a valid parent", () => {
  for (const input of [SELF, "1ae4f88c"]) {
    const r = resolveParentInput(input, SELF, BOARD);
    assert.equal(r.state, "self", `${input} should be rejected as self-parenting`);
    assert.equal(r.id, null);
  }
});

check("an empty board resolves nothing but still distinguishes empty from unknown", () => {
  const none = new Map();
  assert.equal(resolveParentInput("", SELF, none).state, "empty");
  assert.equal(resolveParentInput("1ae4f88c", SELF, none).state, "unknown");
});

console.log(`\n${pass} passed`);
