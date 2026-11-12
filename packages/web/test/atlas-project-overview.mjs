// Hermetic unit test for the project Overview's pure derivations (card 269f46ef) —
// src/lib/atlasProjectOverview.ts, the roster table's rows and cells. No daemon, no React: it
// imports the TS source directly via Node's type stripping and asserts on plain objects, so it
// exercises the REAL shipped helpers and cannot drift from a copy.
//
// Run it standalone with:
//   node --experimental-strip-types packages/web/test/atlas-project-overview.mjs
import assert from "node:assert/strict";
import {
  DEFAULT_ROSTER_SCOPE, filterRosterRows, filterScopedSessions, lastEventBySession, parseRosterScope,
  readRosterScope, rosterCardLabel, rosterRows, rosterScopeStorageKey, scopeAdmitsAgent,
  taskTitlesById, writeRosterScope,
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
  const rows = rosterRows([m], [w1, w2], []);
  assert.deepEqual(rows.map((r) => [r.session.id, r.child]), [["m1", false], ["w1", true], ["w2", true]]);
});

check("two managers keep their own workers under themselves, in manager order", () => {
  const rows = rosterRows(
    [S("m1", "manager"), S("m2", "manager")],
    [S("w2", "worker", { parentSessionId: "m2" }), S("w1", "worker", { parentSessionId: "m1" })],
    [],
  );
  assert.deepEqual(rows.map((r) => r.session.id), ["m1", "w1", "m2", "w2"]);
});

// The band panel this table replaced listed a parentless worker at the END and unindented; a row
// that silently vanished because nothing claimed it is the regression worth pinning.
check("a worker whose parent is not in the set is listed LAST, and not as a child", () => {
  const rows = rosterRows([S("m1", "manager")], [S("orphan", "worker", { parentSessionId: "gone" })], []);
  assert.deepEqual(rows.map((r) => [r.session.id, r.child]), [["m1", false], ["orphan", false]]);
});

check("a worker with a null parent is listed, not dropped", () => {
  const rows = rosterRows([], [S("loose", "worker")], []);
  assert.deepEqual(rows.map((r) => r.session.id), ["loose"]);
});

check("no sessions at all yields no rows", () => {
  assert.deepEqual(rosterRows([], [], []), []);
});

// ── rosterRows' THIRD population (card 6a9cb96a, an owner bug report) ─────────────────────────
//
// 🔴 THE LOAD-BEARING LEG OF THIS CARD. The owner's live `Thought Partner` session was listed in no
// row of the "Work in flight" card, because the page handed this function only its `role ===
// "manager"` and `role === "worker"` sets and an ideation/thought-partner rig runs as `assistant`
// (decision record 2db23c4d). Every other role, and a plain role-less terminal, fell through the
// same two filters. The card's own head counts them all, so the head stated a population its own
// list could not draw — the shape card 9b6be377 was filed against.
//
// Asserted by ROLE here rather than only by id: a fix that happened to list an assistant while
// still dropping a role-less terminal would satisfy the owner's one session and leave the class
// half-closed.

check("a running non-worker session — the Thought Partner's own role — IS listed", () => {
  const tp = S("tp1", "assistant", { agentName: "Thought Partner" });
  const rows = rosterRows([S("m1", "manager")], [], [tp]);
  assert.deepEqual(rows.map((r) => [r.session.id, r.session.role]), [["m1", "manager"], ["tp1", "assistant"]]);
});

check("a role-less plain terminal is listed too, not just the assistant role", () => {
  const rows = rosterRows([], [], [S("plain1", null), S("aud1", "auditor"), S("run1", "run")]);
  assert.deepEqual(rows.map((r) => r.session.id), ["plain1", "aud1", "run1"]);
});

// The tail is appended AFTER the whole manager/worker hierarchy, orphan workers included — the
// card's spine stays contiguous and where every existing reader already found it.
check("the others are appended LAST, after even a parentless worker", () => {
  const rows = rosterRows(
    [S("m1", "manager")],
    [S("w1", "worker", { parentSessionId: "m1" }), S("orphan", "worker", { parentSessionId: "gone" })],
    [S("tp1", "assistant")],
  );
  assert.deepEqual(rows.map((r) => r.session.id), ["m1", "w1", "orphan", "tp1"]);
});

// `child` is "a worker drawn under the manager that owns it". An assistant parented to a manager
// (the relay direction decision record 2db23c4d describes) is still not that, so it must not take
// the indent — which is also what keeps `filterRosterRows`' own demotion rule coherent.
check("an other row is never indented, even when it names a manager as its parent", () => {
  const rows = rosterRows([S("m1", "manager")], [], [S("tp1", "assistant", { parentSessionId: "m1" })]);
  assert.deepEqual(rows.map((r) => [r.session.id, r.child]), [["m1", false], ["tp1", false]]);
});

check("an others-only project still yields rows — no manager is not an empty fleet", () => {
  const rows = rosterRows([], [], [S("tp1", "assistant")]);
  assert.deepEqual(rows.map((r) => [r.session.id, r.child]), [["tp1", false]]);
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

// ── filterRosterRows + the scope preference (card effd47d5) ───────────────────────────────────
//
// The owner's item on this tab: "Optionaly show either only tarminals of spawnable agents or
// teminals of all running agents. Adjustable by user preference."
//
// The fixture is a manager plus two of its workers, each on its OWN agent — so "kept the right
// rows" cannot be satisfied by keeping or dropping the whole set, and the manager/worker nesting
// has something to be wrong about when a parent row is filtered away.
const SCOPE_MGR = S("m1", "manager", { agentId: "a-mgr" });
const SCOPE_W1 = S("w1", "worker", { parentSessionId: "m1", agentId: "a-wkr1" });
const SCOPE_W2 = S("w2", "worker", { parentSessionId: "m1", agentId: "a-wkr2" });
const SCOPE_ROWS = rosterRows([SCOPE_MGR], [SCOPE_W1, SCOPE_W2], []);
/** `splitRoster(...).spawnable` for the ordinary case: the manager's rig, never a worker's. */
const ONLY_MGR = new Set(["a-mgr"]);
const shape = (rows) => rows.map((r) => [r.session.id, r.child]);

check("the fixture itself is the nested shape the filter has to respect", () => {
  assert.deepEqual(shape(SCOPE_ROWS), [["m1", false], ["w1", true], ["w2", true]]);
});

check("scope 'all' keeps every row, with its indent untouched", () => {
  assert.deepEqual(shape(filterRosterRows(SCOPE_ROWS, "all", ONLY_MGR)),
    [["m1", false], ["w1", true], ["w2", true]]);
});

check("scope 'all' hands back a fresh array, never the caller's render state", () => {
  assert.notEqual(filterRosterRows(SCOPE_ROWS, "all", ONLY_MGR), SCOPE_ROWS);
});

check("scope 'spawnable' keeps only the rows whose AGENT is in the spawnable set", () => {
  assert.deepEqual(shape(filterRosterRows(SCOPE_ROWS, "spawnable", ONLY_MGR)), [["m1", false]]);
});

// 🔴 THE LOAD-BEARING ONE. `splitRoster` answers an unloaded agent list with an EMPTY roster, so a
// page that passed that through as the real set would state "no agent you spawn has a session" over
// a fleet that is merely still loading. `null` is how the caller says "not known yet".
check("scope 'spawnable' with a null set lists EVERYTHING — a loading state, never a stated one", () => {
  assert.deepEqual(shape(filterRosterRows(SCOPE_ROWS, "spawnable", null)),
    [["m1", false], ["w1", true], ["w2", true]]);
});

// …and the polarity that proves `null` is not merely "falsy": an EMPTY set is a real answer and must
// filter everything out, which is exactly what makes conflating the two a bug worth a test.
check("scope 'spawnable' with an EMPTY set keeps nothing — empty is an answer, null is not", () => {
  assert.deepEqual(filterRosterRows(SCOPE_ROWS, "spawnable", new Set()), []);
});

check("a kept worker keeps its indent while the manager that owns it is also kept", () => {
  assert.deepEqual(shape(filterRosterRows(SCOPE_ROWS, "spawnable", new Set(["a-mgr", "a-wkr1"]))),
    [["m1", false], ["w1", true]]);
});

// Reachable, not theoretical: an agent re-bound to a non-worker rig after its session started is
// spawnable by `splitRoster`'s definition while the manager that dispatched it is not. An indent
// left behind would then hang off whatever row happens to precede it.
check("a kept worker LOSES its indent when its own manager was filtered away", () => {
  assert.deepEqual(shape(filterRosterRows(SCOPE_ROWS, "spawnable", new Set(["a-wkr1"]))),
    [["w1", false]]);
});

// The set is given w2 FIRST and the rows still come back w1, w2 — the table's order is the one
// `rosterRows` composed, never the order the caller happened to build the set in. (Both lose their
// indent here because their manager is not in this set, which the demotion check above owns.)
check("the surviving rows keep rosterRows' own order, not the set's", () => {
  assert.deepEqual(shape(filterRosterRows(SCOPE_ROWS, "spawnable", new Set(["a-wkr2", "a-wkr1"]))),
    [["w1", false], ["w2", false]]);
});

check("no filter mutates the rows it was handed", () => {
  assert.deepEqual(shape(SCOPE_ROWS), [["m1", false], ["w1", true], ["w2", true]]);
  assert.equal(SCOPE_ROWS.length, 3);
});

check("an empty roster filters to an empty roster in either scope", () => {
  assert.deepEqual(filterRosterRows([], "all", ONLY_MGR), []);
  assert.deepEqual(filterRosterRows([], "spawnable", ONLY_MGR), []);
});

// ── scopeAdmitsAgent + filterScopedSessions (card 0bcfa530) ───────────────────────────────────
//
// The Sessions card's terminal list answers to the SAME preference as the roster above it, over a
// flat session list with no manager/worker indent to repair. These legs are about the one thing that
// would make a second surface under one control a lie: the two disagreeing about what the chosen
// reading means.

check("the predicate admits everything under 'all', and only the spawnable set under 'spawnable'", () => {
  assert.equal(scopeAdmitsAgent("a-wkr1", "all", ONLY_MGR), true);
  assert.equal(scopeAdmitsAgent("a-mgr", "spawnable", ONLY_MGR), true);
  assert.equal(scopeAdmitsAgent("a-wkr1", "spawnable", ONLY_MGR), false);
});

// 🔴 `null` is "the agent/rig reads have not landed" and ADMITS everything; an EMPTY set is the real
//    answer that nothing here is spawnable and admits nothing. Conflating them is the bug, so both
//    polarities are pinned on the predicate itself, not only on its two callers.
check("a null set admits everything and an empty set admits nothing", () => {
  assert.equal(scopeAdmitsAgent("a-wkr1", "spawnable", null), true);
  assert.equal(scopeAdmitsAgent("a-wkr1", "spawnable", new Set()), false);
  assert.equal(scopeAdmitsAgent("a-mgr", "spawnable", new Set()), false);
});

// 🔴 THE LOAD-BEARING ONE. ONE preference drives two surfaces, so for any (scope, set) the two
//    filters must keep the same SESSIONS — the roster's extra work is the indent, never the
//    membership. A drifted second copy of the predicate passes every leg above and fails here.
check("both scoped filters keep exactly the same sessions, in every mode", () => {
  const sessions = [SCOPE_MGR, SCOPE_W1, SCOPE_W2];
  for (const scope of ["all", "spawnable"]) {
    for (const set of [null, new Set(), ONLY_MGR, new Set(["a-wkr1"]), new Set(["a-mgr", "a-wkr2"])]) {
      assert.deepEqual(
        filterScopedSessions(sessions, scope, set).map((s) => s.id),
        filterRosterRows(SCOPE_ROWS, scope, set).map((r) => r.session.id),
        `scope=${scope} set=${set === null ? "null" : `[${[...set].join(",")}]`}`,
      );
    }
  }
});

check("the session filter preserves order and never mutates the caller's array", () => {
  // Deliberately NOT in rosterRows order: the list this filters is the terminal card's own
  // population (manager-first, then newest-first), so the filter must be order-neutral.
  const sessions = [SCOPE_W2, SCOPE_MGR, SCOPE_W1];
  const before = sessions.map((s) => s.id);
  const out = filterScopedSessions(sessions, "spawnable", new Set(["a-wkr2", "a-wkr1"]));
  assert.deepEqual(out.map((s) => s.id), ["w2", "w1"]);
  assert.deepEqual(sessions.map((s) => s.id), before, "the input array was mutated");
  assert.notEqual(out, sessions);
});

check("an empty session list filters to an empty list in either scope", () => {
  assert.deepEqual(filterScopedSessions([], "all", ONLY_MGR), []);
  assert.deepEqual(filterScopedSessions([], "spawnable", ONLY_MGR), []);
});

// ── The preference's default, parse and key ───────────────────────────────────────────────────

// 🔴 Card effd47d5 guessed that "spawnable agents only" was already today's behaviour. It was not:
// the table lists every non-archived manager AND worker. Defaulting to `spawnable` would silently
// hide rows from every existing reader on upgrade, so the filter is opt-in and this pins it.
check("the default scope is 'all' — the behaviour this page already had", () => {
  assert.equal(DEFAULT_ROSTER_SCOPE, "all");
});

check("both scope words parse to themselves", () => {
  assert.equal(parseRosterScope("all"), "all");
  assert.equal(parseRosterScope("spawnable"), "spawnable");
});

check("every unreadable stored value is the default, not a throw", () => {
  for (const raw of [null, undefined, "", " ", "Spawnable", "ALL", "spawnable ", "workers", "1",
    '{"scope":"spawnable"}', "[]"]) {
    assert.equal(parseRosterScope(raw), DEFAULT_ROSTER_SCOPE, `parseRosterScope(${JSON.stringify(raw)})`);
  }
});

check("the storage key is per project, in the same shape as the Sessions tab's layout", () => {
  assert.equal(rosterScopeStorageKey("p1"), "loom.overviewRoster.p1");
  assert.notEqual(rosterScopeStorageKey("p1"), rosterScopeStorageKey("p2"));
});

/** Install an in-memory localStorage for the duration of `fn`, then restore whatever was there. */
function withStorage(impl, fn) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, "localStorage");
  const prev = globalThis.localStorage;
  Object.defineProperty(globalThis, "localStorage", { value: impl, configurable: true, writable: true });
  try { fn(); } finally {
    if (had) Object.defineProperty(globalThis, "localStorage", { value: prev, configurable: true, writable: true });
    else delete globalThis.localStorage;
  }
}

/** A working stub — just the two methods these helpers call. */
function memoryStorage() {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => { map.set(k, String(v)); }, map };
}

check("a written scope reads back, and a second project keeps its own default", () => {
  const store = memoryStorage();
  withStorage(store, () => {
    writeRosterScope("p1", "spawnable");
    assert.equal(readRosterScope("p1"), "spawnable");
    assert.equal(readRosterScope("p2"), DEFAULT_ROSTER_SCOPE);
    assert.equal(store.map.size, 1, "only the written project's key should exist");
  });
});

// Private mode / blocked site data. Neither helper may propagate it: the read answers the default
// and the write is simply lost, because a page the reader is trying to use must still render.
check("a throwing store falls back instead of propagating", () => {
  const throwing = {
    getItem() { throw new Error("SecurityError"); },
    setItem() { throw new Error("QuotaExceededError"); },
  };
  withStorage(throwing, () => {
    assert.equal(readRosterScope("p1"), DEFAULT_ROSTER_SCOPE);
    assert.doesNotThrow(() => writeRosterScope("p1", "spawnable"));
  });
});

// A value corrupted OUT OF BAND (hand-edited in devtools, or left by an older build) reaches the
// page through `readRosterScope`, so the defensive parse has to be on THAT path too — not only on a
// value the page itself wrote.
check("readRosterScope runs the defensive parse, not a bare read", () => {
  const store = memoryStorage();
  withStorage(store, () => {
    store.setItem(rosterScopeStorageKey("p1"), "everything");
    assert.equal(readRosterScope("p1"), DEFAULT_ROSTER_SCOPE);
  });
});

console.log(`\n${pass} passed`);
