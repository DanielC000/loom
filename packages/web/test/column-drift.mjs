// Hermetic unit test for lib/columnDrift.ts — the staged-rows re-base after a refused (409) column save
// (card d5946e05). The editor's whole-array PUT would otherwise delete a column an agent created meanwhile;
// the daemon now refuses, and this merge decides what the editor shows next. The contract under test is
// "NEITHER side is silently dropped, and nothing is re-created without the human's Save":
//   • an agent-added column appears as an ordinary row (before the terminal lane);
//   • a column removed elsewhere keeps the human's staged row, flagged, with its server identity cut;
//   • every staged edit (label/role/order/new rows) survives.
// ColumnManager.tsx imports the SAME function, so this can't drift from what ships. Run with:
//   node --experimental-strip-types packages/web/test/column-drift.mjs
import assert from "node:assert/strict";
import { mergeDriftedColumns } from "../src/lib/columnDrift.ts";

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`ok   ${name}`); };

const row = (key, extra = {}) => ({ key, label: key.toUpperCase(), originalKey: key, ...extra });
const seed = (c) => ({ key: c.key, label: c.label, role: c.role, originalKey: c.key });
const keys = (rows) => rows.map((r) => r.key).join(",");

const BASE = ["backlog", "doing", "done"];
const staged = () => [
  row("backlog", { role: "defaultLanding" }),
  row("doing", { role: "active", label: "Doing (renamed by the human)" }),
  row("done", { role: "terminal" }),
];

check("an agent-ADDED column is appended just before the terminal lane, as an unmodified server row", () => {
  const server = [{ key: "backlog", label: "BACKLOG", role: "defaultLanding" }, { key: "doing", label: "DOING", role: "active" },
    { key: "done", label: "DONE", role: "terminal" }, { key: "qa", label: "QA" }];
  const m = mergeDriftedColumns(staged(), server, BASE, seed);
  assert.equal(keys(m.rows), "backlog,doing,qa,done");
  assert.equal(m.rows[2].originalKey, "qa", "it is an EXISTING server column, so Save must not treat it as new");
  assert.deepEqual(m.added, ["qa"]);
  assert.deepEqual(m.removed, []);
  assert.deepEqual(m.baseKeys, ["backlog", "doing", "done", "qa"], "the next Save is based on the server's key set");
});

check("the human's staged edits survive the merge (label, role, original row objects)", () => {
  const server = [{ key: "backlog", label: "x", role: "defaultLanding" }, { key: "doing", label: "x", role: "active" },
    { key: "done", label: "x", role: "terminal" }, { key: "qa", label: "QA" }];
  const m = mergeDriftedColumns(staged(), server, BASE, seed);
  assert.equal(m.rows.find((r) => r.key === "doing").label, "Doing (renamed by the human)");
});

check("a column REMOVED elsewhere keeps the staged row, flagged, with originalKey cleared (Save would re-create it)", () => {
  const server = [{ key: "backlog", label: "x", role: "defaultLanding" }, { key: "done", label: "x", role: "terminal" }];
  const m = mergeDriftedColumns(staged(), server, BASE, seed);
  const doing = m.rows.find((r) => r.key === "doing");
  assert.ok(doing, "the human's row must NOT be dropped");
  assert.equal(doing.removedElsewhere, true);
  assert.equal(doing.originalKey, undefined, "no server identity → toDesired will not send a prevKey for a column that is gone");
  assert.equal(doing.label, "Doing (renamed by the human)", "its staged edits are kept");
  assert.deepEqual(m.removed, ["doing"]);
  assert.deepEqual(m.baseKeys, ["backlog", "done"]);
  assert.equal(m.rows.find((r) => r.key === "backlog").removedElsewhere, undefined, "untouched rows are not flagged");
});

check("the human's own staged delete of a column an agent re-keyed: the agent's column shows up, nothing is re-homed here", () => {
  // staged: the human deleted `doing`. The agent renamed doing → wip meanwhile.
  const stagedDeleted = [row("backlog", { role: "defaultLanding" }), row("done", { role: "terminal" })];
  const server = [{ key: "backlog", label: "x", role: "defaultLanding" }, { key: "wip", label: "WIP", role: "active" }, { key: "done", label: "x", role: "terminal" }];
  const m = mergeDriftedColumns(stagedDeleted, server, BASE, seed);
  assert.equal(keys(m.rows), "backlog,wip,done", "the agent's column is back in the editor, so a Save re-sent now would not delete it unseen");
  assert.deepEqual(m.added, ["wip"]);
  assert.deepEqual(m.removed, ["doing"]);
});

check("a staged NEW row with the exact key an agent just created ADOPTS that column (no duplicate key)", () => {
  const withNew = [...staged().slice(0, 2), { key: "qa", label: "My QA", originalKey: undefined }, staged()[2]];
  const server = [{ key: "backlog", label: "x", role: "defaultLanding" }, { key: "doing", label: "x", role: "active" },
    { key: "done", label: "x", role: "terminal" }, { key: "qa", label: "Agent QA" }];
  const m = mergeDriftedColumns(withNew, server, BASE, seed);
  assert.equal(m.rows.filter((r) => r.key === "qa").length, 1);
  const qa = m.rows.find((r) => r.key === "qa");
  assert.equal(qa.originalKey, "qa");
  assert.equal(qa.label, "My QA", "the human's label wins on their own row");
});

check("a staged rename of a column an agent removed is flagged and keeps the NEW key the human typed", () => {
  const renamed = [row("backlog", { role: "defaultLanding" }), { ...row("doing", { role: "active" }), key: "in_flight" }, row("done", { role: "terminal" })];
  const server = [{ key: "backlog", label: "x", role: "defaultLanding" }, { key: "done", label: "x", role: "terminal" }];
  const m = mergeDriftedColumns(renamed, server, BASE, seed);
  const r = m.rows.find((x) => x.key === "in_flight");
  assert.equal(r.removedElsewhere, true);
  assert.equal(r.originalKey, undefined, "else toDesired would send prevKey:'doing' for a column that no longer exists");
});

check("no terminal lane in the editor → added column is appended at the end; empty drift is a no-op re-base", () => {
  const noTerm = [row("a"), row("b")];
  const m = mergeDriftedColumns(noTerm, [{ key: "a", label: "a" }, { key: "b", label: "b" }, { key: "c", label: "c" }], ["a", "b"], seed);
  assert.equal(keys(m.rows), "a,b,c");
  const same = mergeDriftedColumns(noTerm, [{ key: "a", label: "a" }, { key: "b", label: "b" }], ["a", "b"], seed);
  assert.equal(keys(same.rows), "a,b");
  assert.deepEqual([same.added, same.removed], [[], []]);
});

check("NEGATIVE CONTROL: the input rows are not mutated", () => {
  const input = staged();
  const snapshot = JSON.stringify(input);
  mergeDriftedColumns(input, [{ key: "backlog", label: "x", role: "defaultLanding" }, { key: "done", label: "x", role: "terminal" }], BASE, seed);
  assert.equal(JSON.stringify(input), snapshot);
});

console.log(`\n${pass} passed`);
