// Hermetic unit test for lib/columnDesired.ts — the board-column layout projection (card 654869e2).
//
// BUG: ColumnManager's toDesired enumerated the KanbanColumn fields it knew about
// (key/label/role/accentColor/wipLimit/prevKey). The atomic PUT /api/projects/:id/columns REPLACES the
// whole array and the daemon's planner (tasks/columns.ts) keeps a field only when the request carried it,
// so every field the web UI does not model was STRIPPED on any human column edit. That hit
// `excludeFromIdleWatchdog` — written only by the manager-side board_column_* MCP tools, with no web
// control at all — and losing it re-armed the idle watcher / pending-request gate / wake-impact on a lane
// deliberately marked a dead end.
//
// The web package has no test runner, so this is a self-contained node script importing the pure function
// directly (mirrors test/column-sort.mjs). ColumnManager.tsx imports the SAME function, so this can't
// drift from what ships. Run it with:
//   node --experimental-strip-types packages/web/test/column-desired.mjs
import assert from "node:assert/strict";
import { carriedColumnFields, toDesired, EDITED_COLUMN_FIELDS } from "../src/lib/columnDesired.ts";

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`ok   ${name}`); };

// A row as ColumnManager seeds it from a server column.
const seed = (c) => ({
  key: c.key, label: c.label, role: c.role, accentColor: c.accentColor, wipLimit: c.wipLimit,
  carried: carriedColumnFields(c), originalKey: c.key,
});

check("THE REGRESSION: a daemon-owned field survives a LABEL rename of that same column", () => {
  const server = { key: "dropped", label: "Dropped", role: "parked", excludeFromIdleWatchdog: true };
  const row = seed(server);
  row.label = "Abandoned"; // the human renames the label, nothing else
  const [d] = toDesired([row]);
  assert.equal(d.excludeFromIdleWatchdog, true, "the agent-set exclusion flag must be re-sent, not dropped");
  assert.equal(d.label, "Abandoned");
  assert.equal(d.key, "dropped");
  assert.equal(d.prevKey, undefined, "a label-only edit is not a key rename");
});

check("THE REGRESSION: it survives an edit to a DIFFERENT column in the same layout", () => {
  const rows = [
    seed({ key: "todo", label: "To do", role: "defaultLanding" }),
    seed({ key: "dropped", label: "Dropped", excludeFromIdleWatchdog: true }),
    seed({ key: "done", label: "Done", role: "terminal" }),
  ];
  rows[0].label = "Backlog"; // the whole array is PUT, so an untouched column must still round-trip
  const out = toDesired(rows);
  assert.equal(out[1].excludeFromIdleWatchdog, true);
  assert.equal(out[1].label, "Dropped");
});

check("it survives a KEY rename, and prevKey is set alongside it", () => {
  const row = seed({ key: "dropped", label: "Dropped", excludeFromIdleWatchdog: true });
  row.key = "abandoned";
  const [d] = toDesired([row]);
  assert.equal(d.excludeFromIdleWatchdog, true);
  assert.equal(d.key, "abandoned");
  assert.equal(d.prevKey, "dropped");
});

check("a FALSE daemon-owned value round-trips as false, never collapsed to absent", () => {
  // `false` and absent resolve the same today, but the planner distinguishes them (`!== undefined`), so
  // collapsing one into the other would be the UI silently rewriting stored state.
  const [d] = toDesired([seed({ key: "dropped", label: "Dropped", excludeFromIdleWatchdog: false })]);
  assert.equal(d.excludeFromIdleWatchdog, false);
  assert.ok("excludeFromIdleWatchdog" in d);
});

check("an ABSENT daemon-owned field stays absent — no undefined-injection", () => {
  const [d] = toDesired([seed({ key: "todo", label: "To do", role: "intake" })]);
  assert.deepEqual(Object.keys(d).sort(), ["key", "label", "role"]);
});

check("carriedColumnFields carries ONLY the unmodelled remainder", () => {
  const carried = carriedColumnFields({
    key: "dropped", label: "Dropped", role: "parked", accentColor: "#6b8afd", wipLimit: 3,
    excludeFromIdleWatchdog: true,
  });
  assert.deepEqual(carried, { excludeFromIdleWatchdog: true });
  for (const f of EDITED_COLUMN_FIELDS) assert.ok(!(f in carried), `${f} is editor-owned, must not be carried`);
});

check("a modelled field WINS over a stale carried copy of itself", () => {
  // Defense in depth: carried should never hold a modelled field, but if it somehow did, the live row
  // state is authoritative — the spread order is what guarantees that.
  const row = {
    key: "dropped", label: "Dropped", accentColor: "#ff0000",
    carried: { label: "STALE", accentColor: "#000000", excludeFromIdleWatchdog: true },
    originalKey: "dropped",
  };
  const [d] = toDesired([row]);
  assert.equal(d.label, "Dropped");
  assert.equal(d.accentColor, "#ff0000");
  assert.equal(d.excludeFromIdleWatchdog, true);
});

check("a freshly-added column has no carried remainder and no prevKey", () => {
  const [d] = toDesired([{ key: " new_lane ", label: " New column ", carried: undefined }]);
  assert.deepEqual(d, { key: "new_lane", label: "New column" }, "key/label are trimmed");
});

check("accentColor and wipLimit still round-trip untouched (the pre-existing guarantee)", () => {
  const [d] = toDesired([seed({ key: "review", label: "Review", role: "review", accentColor: "#6b8afd", wipLimit: 2 })]);
  assert.equal(d.accentColor, "#6b8afd");
  assert.equal(d.wipLimit, 2);
});

console.log(`\n${pass} passed`);
