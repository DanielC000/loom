// Hermetic unit test for the per-project Usage tab's roll-up derivations — src/lib/projectUsage.ts,
// card 30266229 (the owner's Atlas feedback item: `Add new per project "Usage" tab. - Breakdown usage by
// tasks and related tasks too.`). No daemon, no browser: it imports the real functions and asserts on
// plain objects, so it cannot drift from a copy of their rules.
//
// The three claims the card's DoD names, each with a control that would FAIL on the obvious wrong
// implementation:
//   1. A CHILD IS SUMMED ONCE. Asserted on a two-level tree whose every node carries a DISTINCT cost,
//      so a double-count lands on a number no correct sum can produce (equal costs would make
//      double-counting a node indistinguishable from summing a sibling).
//   2. A RELATION IS NEVER MERGED. The related card's own figure is returned on its OWN row, and the
//      viewed task's rolled total is required to be unchanged by the relation existing at all.
//   3. THE THREE BUCKETS SUM TO `totals`. Plus the unbalanced case, since a residual that is computed
//      but never non-zero in any test is a check nobody has shown can fire.
//
// Record: docs/decisions/30266229-per-project-usage-by-task.md
//
// Run it with: node --experimental-strip-types packages/web/test/project-usage.mjs
import assert from "node:assert/strict";
import { register } from "node:module";

// projectUsage.ts imports ./taskHierarchy (for its TaskRef/RelationKind types) written extensionless in
// the bundler style the app uses, which Node's own resolver cannot follow. `_tsxLoaderHook.mjs` exists
// for exactly that — and registering it means the import below must be DYNAMIC, since a static one
// would be hoisted and resolved before `register()` ever ran.
register("./_tsxLoaderHook.mjs", import.meta.url);

const {
  addTotals, buildTaskUsageTree, flattenTree, relationRows, rolledByTaskId, sortTree,
  taskTotalTokens, usagePartition, zeroTotals, USAGE_RELATION_KINDS,
} = await import("../src/lib/projectUsage.ts");

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`ok   ${name}`); };

/**
 * A `byTask` row. Every token class is set from ONE `n` so a row's magnitude is predictable, but the
 * four classes carry DIFFERENT multiples of it — a derivation that summed the wrong column, or summed
 * one column into another, cannot pass by coincidence.
 */
const task = (id, n, over = {}) => ({
  taskId: id,
  taskTitle: over.taskTitle !== undefined ? over.taskTitle : `card ${id}`,
  taskColumnKey: over.taskColumnKey !== undefined ? over.taskColumnKey : "in_progress",
  samples: over.samples ?? 1,
  inputTokens: n,
  outputTokens: n * 2,
  cacheCreationTokens: n * 3,
  cacheReadTokens: n * 4,
  costUsd: over.costUsd ?? n / 100,
  cacheHitRatio: null,
});

/** A board card, as the tab reads it off the board list. */
const meta = (id, parentId = null) => ({ id, title: `card ${id}`, columnKey: "todo", parentId });

const totalsOf = (t) => ({ tok: taskTotalTokens(t), cost: t.costUsd, samples: t.samples });
const byId = (nodes) => new Map(flattenTree(nodes).map((n) => [n.taskId, n]));

// ── 1. CHILDREN ROLL UP, EACH COUNTED EXACTLY ONCE ───────────────────────────────────────────────
check("a parent's rolled total is its own usage plus every descendant's, each counted once", () => {
  // epic → two children, one of which has a child of its own. Four DISTINCT costs (see `task`'s doc):
  // 1.00 + 2.00 + 4.00 + 8.00 — every subset sums to a different number, so any double-count or
  // omission produces an impossible total.
  const rows = [task("epic", 100), task("kidA", 200), task("kidB", 400), task("grand", 800)];
  const cards = [meta("epic"), meta("kidA", "epic"), meta("kidB", "epic"), meta("grand", "kidA")];
  const roots = buildTaskUsageTree(rows, cards);

  assert.equal(roots.length, 1, "the epic is the only root");
  const n = byId(roots);
  assert.deepEqual(totalsOf(n.get("epic").own), { tok: 1000, cost: 1, samples: 1 }, "the epic's OWN usage is only its own row");
  // 100+200+400+800 = 1500 input, ×10 across the four token classes.
  assert.deepEqual(totalsOf(n.get("epic").rolled), { tok: 15000, cost: 15, samples: 4 },
    "the epic's ROLLED total is all four cards, summed once each");
  assert.deepEqual(totalsOf(n.get("kidA").rolled), { tok: 10000, cost: 10, samples: 2 },
    "the middle card rolls up only ITS own subtree (itself + the grandchild)");
  assert.deepEqual(totalsOf(n.get("kidB").rolled), totalsOf(n.get("kidB").own), "a leaf's rolled total IS its own");
  assert.equal(n.get("epic").descendantsWithUsage, 3, "the epic reports how many cards it rolled up");
  assert.equal(n.get("kidB").descendantsWithUsage, 0, "a leaf rolls up nothing");
});

check("Σ roots.rolled is exactly Σ byTask — the tree neither loses nor duplicates a row", () => {
  const rows = [task("epic", 100), task("kidA", 200), task("grand", 800), task("solo", 1600)];
  const cards = [meta("epic"), meta("kidA", "epic"), meta("grand", "kidA"), meta("solo")];
  const roots = buildTaskUsageTree(rows, cards);
  const treeSum = addTotals(roots.map((r) => r.rolled));
  const flatSum = addTotals(rows);
  assert.deepEqual(totalsOf(treeSum), totalsOf(flatSum));
  // POSITIVE CONTROL on the comparison itself: it is not vacuously comparing two zeroed rows.
  assert.ok(flatSum.costUsd > 0 && flatSum.samples === 4, "the fixture really carries usage");
});

check("a parent with NO usage of its own still appears, carrying its children's total", () => {
  // The epic has no byTask row at all — only its child does. Dropping it would hide the child's usage
  // from the top level entirely (the child is not a root), which is the defect this guards.
  const roots = buildTaskUsageTree([task("kid", 500)], [meta("epic"), meta("kid", "epic")]);
  assert.deepEqual(roots.map((r) => r.taskId), ["epic"]);
  assert.equal(roots[0].own.samples, 0, "the synthesized parent claims no usage of its own");
  assert.deepEqual(totalsOf(roots[0].rolled), { tok: 5000, cost: 5, samples: 1 });
  assert.equal(roots[0].title, "card epic", "its name comes off the board row, since it has no usage row");
});

check("a card whose parent is NOT on the board stays a root rather than being dropped", () => {
  // The parent card was deleted (or simply is not loaded). Its usage must still be reachable.
  const roots = buildTaskUsageTree([task("orphan", 300)], [meta("orphan", "gone-parent")]);
  assert.deepEqual(roots.map((r) => r.taskId), ["orphan"]);
  assert.deepEqual(totalsOf(roots[0].rolled), { tok: 3000, cost: 3, samples: 1 });
});

check("a usage row for a DELETED card keeps its figures and loses only its name", () => {
  const roots = buildTaskUsageTree([task("ghost", 700, { taskTitle: null, taskColumnKey: null })], []);
  assert.equal(roots[0].title, null, "a null title is passed through for the UI to label");
  assert.deepEqual(totalsOf(roots[0].rolled), { tok: 7000, cost: 7, samples: 1 });
});

check("a parentId cycle is broken, not followed — every row stays reachable exactly once", () => {
  // Corruption, not a hierarchy (the board caps real depth at two levels). The guard's claim is that
  // this RETURNS — and that every row's usage is still counted exactly once.
  const rows = [task("a", 100), task("b", 200)];
  const cards = [meta("a", "b"), meta("b", "a")];
  const roots = buildTaskUsageTree(rows, cards);
  assert.deepEqual(totalsOf(addTotals(roots.map((r) => r.rolled))), totalsOf(addTotals(rows)),
    "a cycle must not duplicate or lose usage");
  assert.equal(flattenTree(roots).length, 2, "both cards are reachable exactly once");
});

check("a self-parent is treated as no parent", () => {
  const roots = buildTaskUsageTree([task("self", 100)], [meta("self", "self")]);
  assert.deepEqual(roots.map((r) => r.taskId), ["self"]);
});

// ── 2. A RELATION IS NEVER MERGED INTO THE VIEWED TASK'S NUMBER ──────────────────────────────────
check("a relation edge is a row of its own and changes the viewed task's total by nothing", () => {
  const rows = [task("mine", 100), task("theirs", 900)];
  const roots = buildTaskUsageTree(rows, [meta("mine"), meta("theirs")]);
  const rolled = rolledByTaskId(roots);
  const mine = byId(roots).get("mine");

  const relations = {
    blockedBy: [{ id: "theirs", title: "card theirs", columnKey: "done", resolved: true, released: false }],
    blocks: [], related: [], discoveredFrom: [], discoveries: [],
  };
  const rels = relationRows("mine", relations, rolled);

  assert.equal(rels.length, 1);
  assert.equal(rels[0].kind, "blockedBy");
  assert.deepEqual(totalsOf(rels[0].totals), { tok: 9000, cost: 9, samples: 1 },
    "the relation row carries the OTHER card's own total");
  // THE CLAIM: the viewed task's own figure is untouched by the edge.
  assert.deepEqual(totalsOf(mine.rolled), { tok: 1000, cost: 1, samples: 1 });
  assert.equal(mine.children.length, 0, "a relation never becomes a child");
  // And the related card is still its own top-level row — not consumed by the card that points at it.
  assert.deepEqual(roots.map((r) => r.taskId).sort(), ["mine", "theirs"]);
});

check("every relation kind is drawn, and none of them is a containment edge", () => {
  const rows = [task("mine", 100), ...USAGE_RELATION_KINDS.map((k, i) => task(`rel-${k}`, (i + 1) * 100))];
  const roots = buildTaskUsageTree(rows, rows.map((r) => meta(r.taskId)));
  const rolled = rolledByTaskId(roots);
  const relations = Object.fromEntries(USAGE_RELATION_KINDS.map((k) => [
    k, [{ id: `rel-${k}`, title: `card rel-${k}`, columnKey: "todo", resolved: false, released: false }],
  ]));
  const rels = relationRows("mine", relations, rolled);
  assert.deepEqual(rels.map((r) => r.kind), USAGE_RELATION_KINDS, "all five kinds, in declaration order");
  for (const r of rels) {
    assert.ok(r.totals.samples > 0, `${r.kind} row resolved its own usage`);
  }
  assert.deepEqual(totalsOf(byId(roots).get("mine").rolled), { tok: 1000, cost: 1, samples: 1 },
    "five relation edges still add nothing to the viewed card");
});

check("a self-edge and a duplicate edge of one kind each draw once, or not at all", () => {
  const rows = [task("mine", 100), task("dup", 200)];
  const roots = buildTaskUsageTree(rows, [meta("mine"), meta("dup")]);
  const rolled = rolledByTaskId(roots);
  const ref = (id) => ({ id, title: `card ${id}`, columnKey: "todo", resolved: false, released: false });
  const rels = relationRows("mine", {
    blockedBy: [ref("mine"), ref("dup"), ref("dup")],
    blocks: [ref("dup")], related: [], discoveredFrom: [], discoveries: [],
  }, rolled);
  assert.deepEqual(rels.map((r) => `${r.kind}:${r.ref.id}`), ["blockedBy:dup", "blocks:dup"],
    "the self-edge is dropped, the duplicate within a kind is collapsed, and the same card under a DIFFERENT kind keeps its own row");
});

check("a related card with no usage in the window reads as zero, not as missing", () => {
  const roots = buildTaskUsageTree([task("mine", 100)], [meta("mine"), meta("quiet")]);
  const rels = relationRows("mine", {
    blockedBy: [{ id: "quiet", title: "card quiet", columnKey: "todo", resolved: false, released: false }],
    blocks: [], related: [], discoveredFrom: [], discoveries: [],
  }, rolledByTaskId(roots));
  assert.equal(rels.length, 1, "the edge is still shown");
  assert.deepEqual(totalsOf(rels[0].totals), { tok: 0, cost: 0, samples: 0 });
});

// ── 3. THE THREE BUCKETS SUM TO `totals` ─────────────────────────────────────────────────────────
const history = (over = {}) => {
  const byTask = over.byTask ?? [task("t1", 100), task("t2", 200)];
  const overhead = over.orchestrationOverhead ?? { ...zeroTotals(), samples: 3, inputTokens: 50, costUsd: 0.5 };
  const unattributed = over.unattributed ?? { ...zeroTotals(), samples: 2, inputTokens: 25, costUsd: 0.25 };
  const totals = over.totals ?? addTotals([...byTask, overhead, unattributed]);
  return { since: "2026-01-01T00:00:00.000Z", projectId: "p1", totals, byProject: [], byAgent: [], byDay: [], bySession: [], byTask, orchestrationOverhead: overhead, unattributed };
};

check("byTask + orchestrationOverhead + unattributed sum exactly to totals", () => {
  const p = usagePartition(history());
  assert.equal(p.present, true);
  assert.equal(p.balanced, true, "a healthy response balances");
  assert.deepEqual(totalsOf(p.residual), { tok: 0, cost: 0, samples: 0 });
  assert.deepEqual(
    totalsOf(addTotals([p.tasks, p.overhead, p.unattributed])),
    totalsOf(p.total),
    "the three buckets reconstruct the grand total",
  );
  // POSITIVE CONTROL: all three buckets are genuinely non-zero, so "they sum" is not a statement about
  // three empty rows.
  assert.ok(p.tasks.samples > 0 && p.overhead.samples > 0 && p.unattributed.samples > 0);
});

check("a response whose buckets DO NOT sum reports an unbalanced residual", () => {
  // The control for the check above: a residual that is computed but never once non-zero is a check
  // nobody has shown can fire. Here the grand total carries 10 samples the three buckets do not.
  const h = history();
  const inflated = { ...h, totals: addTotals([h.totals, { ...zeroTotals(), samples: 10, inputTokens: 1000, costUsd: 7 }]) };
  const p = usagePartition(inflated);
  assert.equal(p.balanced, false);
  assert.equal(p.residual.samples, 10);
  assert.equal(p.residual.inputTokens, 1000);
  assert.equal(p.residual.costUsd, 7);
});

check("a float-rounding cost residual under half a cent still reads as balanced", () => {
  // Three float sums will not re-add to the fourth bit-for-bit; the UI renders cents, so the residual is
  // snapped to cents. Without this, a correct response would accuse itself of being incomplete.
  const byTask = [task("t1", 100, { costUsd: 0.1 }), task("t2", 200, { costUsd: 0.2 })];
  const h = history({ byTask });
  const drifted = { ...h, totals: { ...h.totals, costUsd: h.totals.costUsd + 1e-9 } };
  assert.equal(usagePartition(drifted).balanced, true);
});

check("a response with NO task breakdown reports present:false rather than a false-balanced partition", () => {
  // The route omits all three together for an unscoped/unknown project. Reporting that as a balanced
  // partition of zeroes would make the tab claim its rows add up when it has no rows.
  const h = history();
  const bare = { ...h, byTask: undefined, orchestrationOverhead: undefined, unattributed: undefined };
  const p = usagePartition(bare);
  assert.equal(p.present, false);
  assert.equal(p.balanced, false, "totals carry usage none of the three buckets accounts for");
  assert.equal(usagePartition(undefined).present, false, "an unresolved query is not a partition either");
  assert.equal(usagePartition(undefined).total.samples, 0);
});

// ── Ranking + cache-hit recomputation ────────────────────────────────────────────────────────────
check("sortTree ranks every level by the chosen measure, not just the roots", () => {
  const rows = [task("epic", 1), task("small", 100), task("big", 900), task("mid", 400)];
  const cards = [meta("epic"), meta("small", "epic"), meta("big", "epic"), meta("mid", "epic")];
  const byCost = sortTree(buildTaskUsageTree(rows, cards), "cost");
  assert.deepEqual(byCost[0].children.map((c) => c.taskId), ["big", "mid", "small"],
    "children are ranked too, descending");
  const byTokens = sortTree(buildTaskUsageTree(rows, cards), "tokens");
  assert.deepEqual(byTokens[0].children.map((c) => c.taskId), ["big", "mid", "small"]);
  // A cost/token DISAGREEMENT proves the key is actually read: `cheap` has the most tokens and the
  // least cost, so the two orders must differ.
  const split = [task("cheap", 1000, { costUsd: 0.01 }), task("pricey", 10, { costUsd: 50 })];
  const splitCards = [meta("cheap"), meta("pricey")];
  assert.deepEqual(sortTree(buildTaskUsageTree(split, splitCards), "cost").map((n) => n.taskId), ["pricey", "cheap"]);
  assert.deepEqual(sortTree(buildTaskUsageTree(split, splitCards), "tokens").map((n) => n.taskId), ["cheap", "pricey"]);
});

check("a rolled cacheHitRatio is recomputed from the summed columns, never averaged", () => {
  // kid is 100% cache-read; parent is 0%. A mean of the two ratios would be 0.5; the correct answer is
  // weighted by volume: 900 read / (900 read + 100 input) = 0.9.
  const parent = { ...zeroTotals(), taskId: "p", taskTitle: "p", taskColumnKey: "todo", samples: 1, inputTokens: 100, cacheHitRatio: 0 };
  const kid = { ...zeroTotals(), taskId: "k", taskTitle: "k", taskColumnKey: "todo", samples: 1, cacheReadTokens: 900, cacheHitRatio: 1 };
  const roots = buildTaskUsageTree([parent, kid], [meta("p"), meta("k", "p")]);
  assert.equal(roots[0].rolled.cacheHitRatio, 0.9);
  assert.equal(zeroTotals().cacheHitRatio, null, "nothing to divide by reads as null, never a misleading 0");
  assert.equal(addTotals([]).cacheHitRatio, null);
});

console.log(`\n${pass} passed`);
