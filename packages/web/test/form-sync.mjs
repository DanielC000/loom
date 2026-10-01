// Hermetic unit test for lib/formSync.ts — the three-way field reconcile behind card 65aa951c
// (Settings / ProfileEditor / AgentEditor no longer revert a concurrent agent write on Save).
//
// ⚠️ SCOPE, stated up front: this covers the ALGEBRA only. The defect these functions exist to fix is a
// `useState` initializer sampling the server record once at mount, and a pure test structurally cannot
// see WHEN its caller samples state (the 654869e2 lesson). The WIRING — that each form actually seeds,
// re-syncs and narrows its payload through these — is proved by packages/web/e2e/concurrent-agent-write.spec.ts
// against a real daemon. Neither test substitutes for the other.
//
// The web package has no test runner, so this is a self-contained node script importing the pure module
// directly (only `import type` is stripped), mirroring test/column-sort.mjs. Run it with:
//   node --experimental-strip-types packages/web/test/form-sync.mjs
import assert from "node:assert/strict";
import { changedFields, reconcileSeed, retainConflicts, sameFieldValue } from "../src/lib/formSync.ts";

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`ok   ${name}`); };

// A stand-in for a real form's value shape: a scalar, a boolean, a list and a record.
const seedOf = (over = {}) => ({ name: "rig", enabled: false, skills: ["a", "b"], caps: [{ slug: "x" }], ...over });

check("an untouched form reports no changed fields", () => {
  const seed = seedOf();
  assert.deepEqual(changedFields(seed, seedOf()), []);
});

check("changedFields compares by VALUE, not identity — a rebuilt array is not an edit", () => {
  // The forms hold arrays in state and rebuild them on every render; identity would read dirty forever.
  assert.deepEqual(changedFields(seedOf(), seedOf({ skills: ["a", "b"], caps: [{ slug: "x" }] })), []);
  assert.deepEqual(changedFields(seedOf(), seedOf({ skills: ["a"] })), ["skills"]);
  assert.deepEqual(changedFields(seedOf(), seedOf({ caps: [{ slug: "x" }, { slug: "y" }] })), ["caps"]);
});

check("changedFields names every changed field, and only those", () => {
  const changed = changedFields(seedOf(), seedOf({ name: "other", enabled: true }));
  assert.deepEqual([...changed].sort(), ["enabled", "name"]);
});

check("a per-field comparer overrides the default — order-insensitive and trimmed fields", () => {
  const sorted = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  const trimmed = (a, b) => a.trim() === b.trim();
  const comparers = { skills: sorted, name: trimmed };
  assert.deepEqual(changedFields(seedOf(), seedOf({ skills: ["b", "a"], name: " rig " }), comparers), []);
  // ...and the same comparers still see a REAL change, so the override is not just blanket-equal.
  assert.deepEqual(changedFields(seedOf(), seedOf({ skills: ["b", "c"] }), comparers), ["skills"]);
});

check("changedFields iterates the SEED's keys — a key only on local is not reported", () => {
  assert.deepEqual(changedFields({ a: 1 }, { a: 1, b: 2 }), []);
});

// ── reconcileSeed ───────────────────────────────────────────────────────────────────────────────────

check("an UNTOUCHED field adopts the record's new value", () => {
  // THE CARD'S DEFECT, in one assertion: the human never chose "rig", so the agent's write stands.
  const r = reconcileSeed(seedOf(), seedOf(), seedOf({ name: "agent-wrote-this" }));
  assert.equal(r.values.name, "agent-wrote-this");
  assert.deepEqual(r.adopted, ["name"]);
  assert.deepEqual(r.conflicts, []);
});

check("a TOUCHED field keeps the human's edit and is reported as a conflict", () => {
  const r = reconcileSeed(seedOf(), seedOf({ name: "human-typed" }), seedOf({ name: "agent-wrote" }));
  assert.equal(r.values.name, "human-typed");
  assert.deepEqual(r.adopted, []);
  assert.deepEqual(r.conflicts, ["name"]);
});

check("a field whose record value moved TO what the human holds is NOT a conflict", () => {
  // The routine case: this form's own save lands, the record refetches carrying what we just sent.
  // Reporting that as a conflict would make every successful save accuse itself.
  const r = reconcileSeed(seedOf(), seedOf({ name: "saved" }), seedOf({ name: "saved" }));
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(r.adopted, []);
  assert.equal(r.values.name, "saved");
});

check("a field the record did not move is left completely alone", () => {
  const r = reconcileSeed(seedOf(), seedOf({ name: "half-typed" }), seedOf());
  assert.equal(r.values.name, "half-typed");
  assert.deepEqual(r.adopted, []);
  assert.deepEqual(r.conflicts, []);
});

check("adoption and conflict are decided per field, in one pass", () => {
  const r = reconcileSeed(
    seedOf(),
    seedOf({ name: "human-typed" }),                       // touched
    seedOf({ name: "agent-wrote", enabled: true }),        // record moved BOTH
  );
  assert.equal(r.values.name, "human-typed");
  assert.equal(r.values.enabled, true);
  assert.deepEqual(r.adopted, ["enabled"]);
  assert.deepEqual(r.conflicts, ["name"]);
});

check("reconcileSeed does not mutate its inputs", () => {
  const seed = seedOf();
  const local = seedOf();
  const next = seedOf({ name: "moved" });
  reconcileSeed(seed, local, next);
  assert.equal(local.name, "rig");
  assert.equal(seed.name, "rig");
  assert.equal(next.name, "moved");
});

check("advancing the seed wholesale clears the conflict on the NEXT pass", () => {
  // The documented caller contract: after reconciling, store `next` as the new seed — including for a
  // conflicting field — so a held edit is measured against the record as it is now, not forever.
  const seed = seedOf();
  const local = seedOf({ name: "human-typed" });
  const next = seedOf({ name: "agent-wrote" });
  assert.deepEqual(reconcileSeed(seed, local, next).conflicts, ["name"]);
  // seed := next; the record then moves again, on a DIFFERENT field.
  const again = reconcileSeed(next, local, seedOf({ name: "agent-wrote", enabled: true }));
  assert.deepEqual(again.conflicts, []);
  assert.deepEqual(again.adopted, ["enabled"]);
  assert.equal(again.values.name, "human-typed"); // the human's edit is still held
});

check("sameFieldValue treats structurally-equal records as equal and distinguishes real changes", () => {
  assert.equal(sameFieldValue({ a: 1 }, { a: 1 }), true);
  assert.equal(sameFieldValue({ a: 1 }, { a: 2 }), false);
  assert.equal(sameFieldValue(undefined, undefined), true);
  assert.equal(sameFieldValue(undefined, false), false);
  assert.equal(sameFieldValue("", null), false);
});

// ── retainConflicts — the conflict list's own algebra (card 65aa951c round 2) ─────────────────────────
//
// Three forms each kept this list by hand and two of them never cleared it, so after a human saved their
// own version a later re-edit of that same field accused them of overwriting a write they had just
// deliberately replaced. The render-time "is this field still changed" filter hid it at rest, which is
// why only a RE-EDIT exposes it — and why these cases are about what survives a reconcile, not about
// what a single pass reports.

check("a field that has stopped diverging is dropped — the post-save case", () => {
  // local === row ⇒ nothing left to overwrite. This is the refetch after the form's OWN save.
  assert.deepEqual(retainConflicts(["name"], [], seedOf(), seedOf(), undefined), []);
});

check("a field still diverging is KEPT across a reconcile that reported nothing new", () => {
  // The human is holding "mine" against a row that says "rig": the notice must survive.
  assert.deepEqual(retainConflicts(["name"], [], seedOf({ name: "mine" }), seedOf(), undefined), ["name"]);
});

check("one field settling does not erase a live conflict on another", () => {
  // THE REASON THIS IS NOT A BLANKET CLEAR. `name` converged, `skills` has not.
  const local = seedOf({ skills: ["a"] });
  assert.deepEqual(retainConflicts(["name", "skills"], [], local, seedOf(), undefined), ["skills"]);
});

check("newly-reported conflicts are added, and the result never duplicates", () => {
  const local = seedOf({ name: "mine", enabled: true });
  const out = retainConflicts(["name"], ["name", "enabled"], local, seedOf(), undefined);
  assert.deepEqual([...out].sort(), ["enabled", "name"]);
});

check("a newly-reported conflict is added even when the comparer calls it converged", () => {
  // `added` is the reconcile's own verdict and is authoritative — the divergence filter applies only to
  // the ACCUMULATED list, never to what this pass just decided.
  assert.deepEqual(retainConflicts([], ["name"], seedOf(), seedOf(), undefined), ["name"]);
});

check("retainConflicts honours a per-field comparer, in both polarities", () => {
  const sorted = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  const comparers = { skills: sorted };
  // Order-only difference ⇒ CONVERGED under the comparer, so the stale notice retires…
  assert.deepEqual(
    retainConflicts(["skills"], [], seedOf({ skills: ["b", "a"] }), seedOf({ skills: ["a", "b"] }), comparers),
    [],
  );
  // …and a real membership difference is still held. Without the comparer the first case would keep a
  // notice alive against a field the form itself considers settled (`changedFields` uses the same one).
  assert.deepEqual(
    retainConflicts(["skills"], [], seedOf({ skills: ["a"] }), seedOf({ skills: ["a", "b"] }), comparers),
    ["skills"],
  );
});

check("retainConflicts does not mutate its inputs", () => {
  const prev = ["name"];
  const added = ["enabled"];
  retainConflicts(prev, added, seedOf({ name: "mine", enabled: true }), seedOf(), undefined);
  assert.deepEqual(prev, ["name"]);
  assert.deepEqual(added, ["enabled"]);
});

console.log(`\n${pass} passed`);
