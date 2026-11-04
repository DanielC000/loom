// Hermetic unit test for lib/taskRelationsEdit.ts — the board card dialog's relation EDITOR logic
// (card 03d9db6e; the read-side twin is lib/taskHierarchy, tested in task-hierarchy.mjs).
//
// What actually needs proving here is not "the helpers return something". It is the two asymmetries
// that make a whole-set-replace write dangerous, and that no screenshot can show:
//
//   · a `released:true` item must NEVER reach a write (it would re-declare dead deferral history as a
//     live dependency), AND must not be collaterally destroyed by an unrelated edit to the same kind;
//   · a merely `resolved` item is the OPPOSITE case and must ALWAYS be carried, since it is a declared
//     edge whose blocker simply landed — dropping it deletes a real link the user never touched.
//
// Both are invisible in the UI: the staged chips look right either way, and the damage only shows up on
// the next read of a different card. So they are asserted directly, in both directions.
//
// Same harness shape as task-hierarchy.mjs: a self-contained node script importing the pure module
// (only `import type` is stripped). test/run-all.mjs discovers it, and `pnpm build` runs that, so this
// is part of the gate. Run it alone with:
//   node --experimental-strip-types packages/web/test/task-relations-edit.mjs
import assert from "node:assert/strict";
import {
  EDITABLE_RELATION_KINDS, SINGLE_VALUE_KINDS, addRelation, emptyRelationDraft, isSingleValueKind,
  refById, relationBaseline, relationErrorTarget, relationPatch, relationsDirty, releasedHistory,
  removeRelation, searchCards,
} from "../src/lib/taskRelationsEdit.ts";
import { taskLinks } from "../src/lib/taskHierarchy.ts";

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`ok   ${name}`); };

const SELF = "03d9db6e-1c50-4a31-a690-0871a18c8929";
const ref = (id, title, extra = {}) => ({ id, title, columnKey: "todo", ...extra });

// A served task read, built through the REAL `taskLinks` reader rather than hand-shaped, so these
// fixtures can't drift from what the UI actually consumes.
const links = (relations) => taskLinks({ id: SELF, title: "the card under edit", relations });

// ── The kind surface ──────────────────────────────────────────────────────────────────────────────
check("`discoveries` is NOT editable — no field on this card's write body can change it", () => {
  assert.ok(!EDITABLE_RELATION_KINDS.includes("discoveries"));
  assert.deepEqual(EDITABLE_RELATION_KINDS, ["blockedBy", "blocks", "related", "discoveredFrom"]);
  // The patch builder must have no way to emit it either, whatever a caller stages.
  const patch = relationPatch({ ...emptyRelationDraft(), discoveries: ["x"] }, emptyRelationDraft());
  assert.ok(!("discoveries" in patch));
});

check("only `discoveredFrom` is single-valued, matching the REST field's `string | null`", () => {
  assert.deepEqual(SINGLE_VALUE_KINDS, ["discoveredFrom"]);
  assert.equal(isSingleValueKind("discoveredFrom"), true);
  for (const k of ["blockedBy", "blocks", "related"]) assert.equal(isSingleValueKind(k), false);
});

// ── released:true — the whole reason this module exists ───────────────────────────────────────────
check("a released:true blocker is EXCLUDED from the baseline (never sent back as a live edge)", () => {
  const l = links({ blockedBy: [ref("live-1", "live blocker"), ref("rel-1", "released history", { resolved: true, released: true })] });
  const base = relationBaseline(l);
  assert.deepEqual(base.blockedBy, ["live-1"]);
  // And it is still READABLE, so the UI can show it as history rather than losing the record.
  assert.deepEqual(releasedHistory(l, "blockedBy").map((r) => r.id), ["rel-1"]);
});

check("adding a blocker alongside released history sends the live set WITHOUT the released id", () => {
  const l = links({ blockedBy: [ref("live-1", "live blocker"), ref("rel-1", "released", { resolved: true, released: true })] });
  const base = relationBaseline(l);
  const next = addRelation(base, "blockedBy", "new-1", SELF);
  const patch = relationPatch(next, base);
  assert.deepEqual(patch.blockedBy, ["live-1", "new-1"]);
  assert.ok(!patch.blockedBy.includes("rel-1"), "a released edge must never ride along on an unrelated add");
});

check("removing the ONLY live blocker clears the kind without resurrecting released history", () => {
  const l = links({ blockedBy: [ref("live-1", "live"), ref("rel-1", "released", { resolved: true, released: true })] });
  const base = relationBaseline(l);
  const patch = relationPatch(removeRelation(base, "blockedBy", "live-1"), base);
  assert.deepEqual(patch.blockedBy, []);
});

check("a released edge on an UNTOUCHED kind produces no patch field at all", () => {
  // The structural protection: an omitted kind is never replaced, so the released edge cannot be
  // re-declared as a side effect of editing something else on the card.
  const l = links({
    blockedBy: [ref("rel-1", "released", { resolved: true, released: true })],
    related: [ref("r-1", "a related card")],
  });
  const base = relationBaseline(l);
  const patch = relationPatch(addRelation(base, "related", "r-2", SELF), base);
  assert.deepEqual(Object.keys(patch), ["related"]);
  assert.ok(!("blockedBy" in patch));
});

check("released items are excluded on the `blocks` side too, not just `blockedBy`", () => {
  const l = links({ blocks: [ref("b-1", "live"), ref("b-2", "released", { resolved: true, released: true })] });
  assert.deepEqual(relationBaseline(l).blocks, ["b-1"]);
});

// ── resolved:true — the symmetric trap, in the OPPOSITE direction ─────────────────────────────────
check("a RESOLVED (but declared) blocker IS carried — dropping it would delete a real edge", () => {
  const l = links({ blockedBy: [ref("open-1", "still open"), ref("done-1", "blocker landed", { resolved: true })] });
  const base = relationBaseline(l);
  assert.deepEqual(base.blockedBy, ["open-1", "done-1"]);
  const patch = relationPatch(addRelation(base, "blockedBy", "new-1", SELF), base);
  assert.deepEqual(patch.blockedBy, ["open-1", "done-1", "new-1"]);
});

check("resolved and released are distinguishable on the same kind at the same time", () => {
  const l = links({ blockedBy: [
    ref("open-1", "open"),
    ref("done-1", "resolved", { resolved: true }),
    ref("rel-1", "released", { resolved: true, released: true }),
  ] });
  assert.deepEqual(relationBaseline(l).blockedBy, ["open-1", "done-1"]);
  assert.deepEqual(releasedHistory(l, "blockedBy").map((r) => r.id), ["rel-1"]);
  assert.equal(refById(l, "blockedBy", "done-1").resolved, true);
  assert.equal(refById(l, "blockedBy", "done-1").released, false);
  assert.equal(refById(l, "blockedBy", "nope"), null);
});

// ── staging: add / remove ─────────────────────────────────────────────────────────────────────────
check("a card can never be staged as its own relation", () => {
  const base = emptyRelationDraft();
  for (const kind of EDITABLE_RELATION_KINDS) {
    assert.equal(addRelation(base, kind, SELF, SELF), base, `${kind} must refuse self`);
  }
  assert.equal(addRelation(base, "related", "", SELF), base, "an empty id is not a card");
});

check("adding the same id twice is a no-op, and returns the SAME object (no spurious dirty)", () => {
  const once = addRelation(emptyRelationDraft(), "related", "r-1", SELF);
  const twice = addRelation(once, "related", "r-1", SELF);
  assert.equal(twice, once);
  assert.deepEqual(once.related, ["r-1"]);
});

check("a single-value kind REPLACES rather than appends, and re-picking the same id is a no-op", () => {
  const one = addRelation(emptyRelationDraft(), "discoveredFrom", "d-1", SELF);
  const two = addRelation(one, "discoveredFrom", "d-2", SELF);
  assert.deepEqual(two.discoveredFrom, ["d-2"]);
  assert.equal(addRelation(two, "discoveredFrom", "d-2", SELF), two);
});

check("removing an id that isn't staged is a no-op", () => {
  const d = addRelation(emptyRelationDraft(), "blocks", "b-1", SELF);
  assert.equal(removeRelation(d, "blocks", "nope"), d);
  assert.deepEqual(removeRelation(d, "blocks", "b-1").blocks, []);
});

check("staging never mutates the draft it was handed", () => {
  const base = relationBaseline(links({ related: [ref("r-1", "one")] }));
  const after = addRelation(base, "related", "r-2", SELF);
  assert.deepEqual(base.related, ["r-1"], "the input draft must be untouched");
  assert.deepEqual(after.related, ["r-1", "r-2"]);
});

// ── the patch: only what changed ──────────────────────────────────────────────────────────────────
check("an untouched draft produces an EMPTY patch and is not dirty", () => {
  const base = relationBaseline(links({
    blockedBy: [ref("b-1", "x")], blocks: [ref("b-2", "y")],
    related: [ref("r-1", "z")], discoveredFrom: [ref("d-1", "w")],
  }));
  assert.deepEqual(relationPatch(base, base), {});
  assert.equal(relationsDirty(base, base), false);
});

check("a REORDER is not an edit — the server returns its own order", () => {
  const base = relationBaseline(links({ blockedBy: [ref("b-1", "one"), ref("b-2", "two")] }));
  const reordered = { ...base, blockedBy: ["b-2", "b-1"] };
  assert.deepEqual(relationPatch(reordered, base), {});
  assert.equal(relationsDirty(reordered, base), false);
});

check("clearing a single-value kind sends null, not an empty array", () => {
  const base = relationBaseline(links({ discoveredFrom: [ref("d-1", "origin")] }));
  const patch = relationPatch(removeRelation(base, "discoveredFrom", "d-1"), base);
  assert.equal(patch.discoveredFrom, null);
});

check("setting a single-value kind sends the bare id", () => {
  const base = emptyRelationDraft();
  const patch = relationPatch(addRelation(base, "discoveredFrom", "d-9", SELF), base);
  assert.equal(patch.discoveredFrom, "d-9");
});

check("two kinds edited at once both ride; the other two stay absent", () => {
  const base = relationBaseline(links({ blockedBy: [ref("b-1", "x")] }));
  const next = addRelation(addRelation(base, "blockedBy", "b-2", SELF), "related", "r-1", SELF);
  const patch = relationPatch(next, base);
  assert.deepEqual(patch.blockedBy, ["b-1", "b-2"]);
  assert.deepEqual(patch.related, ["r-1"]);
  assert.ok(!("blocks" in patch) && !("discoveredFrom" in patch));
  assert.equal(relationsDirty(next, base), true);
});

check("a task read with NO relations at all is an empty baseline, not a throw", () => {
  const base = relationBaseline(taskLinks(null));
  assert.deepEqual(base, emptyRelationDraft());
  assert.equal(relationsDirty(base, base), false);
  for (const kind of EDITABLE_RELATION_KINDS) assert.deepEqual(releasedHistory(taskLinks(null), kind), []);
});

// ── the picker's search ───────────────────────────────────────────────────────────────────────────
const CARDS = [
  { id: "aaaa1111-0000-0000-0000-000000000000", title: "Zebra: fix the gate", columnKey: "todo" },
  { id: "bbbb2222-0000-0000-0000-000000000000", title: "Alpha: ship the thing", columnKey: "done" },
  { id: "cccc3333-0000-0000-0000-000000000000", title: "Middle gate work", columnKey: "in_progress" },
  { id: SELF, title: "the card under edit", columnKey: "in_progress" },
];
const search = (q, opts = {}) => searchCards(CARDS, q, { selfId: SELF, excludeIds: [], limit: 10, ...opts });

check("the card itself is never offered as a link target", () => {
  const { matches, total } = search("");
  assert.equal(total, 3);
  assert.ok(!matches.some((c) => c.id === SELF));
});

check("already-staged ids are excluded so a card can't be linked twice", () => {
  const { matches, total } = search("", { excludeIds: ["aaaa1111-0000-0000-0000-000000000000"] });
  assert.equal(total, 2);
  assert.ok(!matches.some((c) => c.id.startsWith("aaaa")));
});

check("an ID PREFIX matches, and ranks ahead of a title hit", () => {
  const { matches } = search("aaaa1111");
  assert.equal(matches.length, 1);
  assert.ok(matches[0].id.startsWith("aaaa1111"));
  // "gate" hits two titles; prefixing the id of one puts that card first even though its title sorts last.
  const both = searchCards(
    [...CARDS, { id: "gate0000-0000-0000-0000-000000000000", title: "Zzz last alphabetically", columnKey: "todo" }],
    "gate", { selfId: SELF, excludeIds: [], limit: 10 },
  );
  assert.equal(both.matches[0].id.slice(0, 4), "gate", "an id-prefix hit outranks every title hit");
  assert.equal(both.total, 3);
});

check("a TITLE SUBSTRING matches case-insensitively, ranked by where the match lands", () => {
  const { matches, total } = search("GATE");
  assert.equal(total, 2);
  // "Middle gate work" matches at index 7; "Zebra: fix the gate" at index 15 — earlier wins.
  assert.deepEqual(matches.map((c) => c.title), ["Middle gate work", "Zebra: fix the gate"]);
});

check("an empty query lists every candidate (the picker is useful before you type)", () => {
  const { matches, total } = search("");
  assert.equal(matches.length, 3);
  assert.equal(total, 3);
  assert.deepEqual(matches.map((c) => c.title), ["Alpha: ship the thing", "Middle gate work", "Zebra: fix the gate"]);
});

check("no match is an empty list, not a fallback to everything", () => {
  const { matches, total } = search("nothing-here-matches");
  assert.deepEqual(matches, []);
  assert.equal(total, 0);
});

check("`total` reports the TRUE candidate count past the limit, so a capped list says so", () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ id: `id${i}`.padEnd(8, "0"), title: `card ${i}`, columnKey: "todo" }));
  const { matches, total } = searchCards(many, "card", { selfId: SELF, excludeIds: [], limit: 8 });
  assert.equal(matches.length, 8);
  assert.equal(total, 25);
  // limit:0 must return nothing rather than negative-slicing the tail off the end.
  assert.deepEqual(searchCards(many, "card", { selfId: SELF, excludeIds: [], limit: 0 }).matches, []);
});

// ── server-error placement ────────────────────────────────────────────────────────────────────────
check("a field-scoped refusal is routed to its own row, and `blockedBy` is not shadowed by `blocks`", () => {
  assert.deepEqual(relationErrorTarget("blockedBy: task 'zz' not found in this project — check the id"),
    { scope: "kind", kind: "blockedBy" });
  assert.deepEqual(relationErrorTarget("blocks cannot include the card itself — list other cards"),
    { scope: "kind", kind: "blocks" });
  assert.deepEqual(relationErrorTarget("related: ambiguous task id-prefix 'ab'"), { scope: "kind", kind: "related" });
  assert.deepEqual(relationErrorTarget("discoveredFrom: task 'q' is on another project's board"),
    { scope: "kind", kind: "discoveredFrom" });
});

check("a blocks CYCLE is section-wide (it names edges on both sides), and parentId is its own control", () => {
  assert.deepEqual(relationErrorTarget("blocks cycle (abcd1234 → ef567890 → abcd1234) — drop one of the edges"),
    { scope: "graph" });
  assert.deepEqual(relationErrorTarget("parentId: too deep — 1ae4f88c sits 1 level(s) below its top card"),
    { scope: "parent" });
});

check("an unrecognised message is NOT claimed, so it still reaches the generic line beside Save", () => {
  for (const m of [null, undefined, "", "priority must be one of p0|p1|p2|p3", "/api/tasks/x -> 500",
    "this card's title/body changed since you loaded it"]) {
    assert.equal(relationErrorTarget(m), null, `must not claim: ${m}`);
  }
});

console.log(`\n${pass} passed`);
