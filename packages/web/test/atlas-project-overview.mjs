// Hermetic unit test for the project Overview's pure derivations (card 269f46ef) —
// src/lib/atlasProjectOverview.ts, the roster table's rows and cells. No daemon, no React: it
// imports the TS source directly via Node's type stripping and asserts on plain objects, so it
// exercises the REAL shipped helpers and cannot drift from a copy.
//
// Run it standalone with:
//   node --experimental-strip-types packages/web/test/atlas-project-overview.mjs
import assert from "node:assert/strict";
import {
  lastEventBySession, rosterCardLabel, rosterRows, taskTitlesById,
} from "../src/lib/atlasProjectOverview.ts";

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`ok   ${name}`); };

const S = (id, role, extra = {}) => ({ id, role, parentSessionId: null, agentName: id, ...extra });
const E = (id, kind, managerSessionId, workerSessionId = null) => ({ id, kind, ts: id, managerSessionId, workerSessionId });

// ── rosterRows ────────────────────────────────────────────────────────────────────────────────

check("a manager is followed by its own workers, each marked as a child", () => {
  const m = S("m1", "manager");
  const w1 = S("w1", "worker", { parentSessionId: "m1" });
  const w2 = S("w2", "worker", { parentSessionId: "m1" });
  const rows = rosterRows([m], [w1, w2]);
  assert.deepEqual(rows.map((r) => [r.session.id, r.child]), [["m1", false], ["w1", true], ["w2", true]]);
});

check("two managers keep their own workers under themselves, in manager order", () => {
  const rows = rosterRows(
    [S("m1", "manager"), S("m2", "manager")],
    [S("w2", "worker", { parentSessionId: "m2" }), S("w1", "worker", { parentSessionId: "m1" })],
  );
  assert.deepEqual(rows.map((r) => r.session.id), ["m1", "w1", "m2", "w2"]);
});

// The band panel this table replaced listed a parentless worker at the END and unindented; a row
// that silently vanished because nothing claimed it is the regression worth pinning.
check("a worker whose parent is not in the set is listed LAST, and not as a child", () => {
  const rows = rosterRows([S("m1", "manager")], [S("orphan", "worker", { parentSessionId: "gone" })]);
  assert.deepEqual(rows.map((r) => [r.session.id, r.child]), [["m1", false], ["orphan", false]]);
});

check("a worker with a null parent is listed, not dropped", () => {
  const rows = rosterRows([], [S("loose", "worker")]);
  assert.deepEqual(rows.map((r) => r.session.id), ["loose"]);
});

check("no sessions at all yields no rows", () => {
  assert.deepEqual(rosterRows([], []), []);
});

// ── lastEventBySession ────────────────────────────────────────────────────────────────────────

// 🔴 THE LOAD-BEARING ONE. A map keyed only on `workerSessionId` leaves every MANAGER row's "last
// event" cell blank, because a manager files events about its workers rather than about itself.
check("a manager resolves its own filed event, and a worker resolves the event about it", () => {
  const map = lastEventBySession([E("e2", "worker_report", "m1", "w1"), E("e1", "task_updated", "m1")]);
  assert.equal(map.get("m1")?.id, "e2");
  assert.equal(map.get("w1")?.id, "e2");
});

check("the FIRST hit wins, so a newest-first list yields the newest event", () => {
  const map = lastEventBySession([
    E("new", "merge_request", "m1", "w1"),
    E("old", "worker_dispatched", "m1", "w1"),
  ]);
  assert.equal(map.get("w1")?.id, "new");
  assert.equal(map.get("m1")?.id, "new");
});

check("a session nothing was filed about or by is absent, not undefined-valued", () => {
  const map = lastEventBySession([E("e1", "worker_report", "m1", "w1")]);
  assert.equal(map.has("w2"), false);
});

check("an empty event list yields an empty map", () => {
  assert.equal(lastEventBySession([]).size, 0);
});

// ── taskTitlesById + rosterCardLabel ──────────────────────────────────────────────────────────

const TITLES = taskTitlesById([{ id: "t1", title: "fix(web): a real card" }]);

check("a session holding a card shows that card's title, not muted", () => {
  assert.deepEqual(rosterCardLabel({ taskId: "t1" }, TITLES), { text: "fix(web): a real card", muted: false });
});

// A worker ALWAYS carries a taskId. If the board query has not landed (or the card was archived off
// the board) the cell must still say the session is holding something — a blank reads as idle.
check("a held card with no title yet falls back to the short id, muted", () => {
  assert.deepEqual(
    rosterCardLabel({ taskId: "269f46ef-9c12-40f2-bcfd-825dbb56f445" }, TITLES),
    { text: "269f46ef", muted: true },
  );
});

check("a session holding no card shows its generation readout instead", () => {
  assert.deepEqual(rosterCardLabel({ gen: 466, ctxTurns: 318 }, TITLES), { text: "gen 466 · 318 turns", muted: true });
});

check("one turn is singular, and gen 0 is omitted rather than printed", () => {
  assert.deepEqual(rosterCardLabel({ gen: 0, ctxTurns: 1 }, TITLES), { text: "1 turn", muted: true });
});

check("a session with neither a card nor a generation yields null, so the cell draws a dash", () => {
  assert.equal(rosterCardLabel({}, TITLES), null);
});

check("taskTitlesById tolerates an undefined task list", () => {
  assert.equal(taskTitlesById(undefined).size, 0);
});

console.log(`\n${pass} passed`);
