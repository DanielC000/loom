// Hermetic unit test for the Sessions tab's tile-layout preference — src/lib/terminalLayout.ts, card
// ac0cfe91 ("Provide user with terminal ordering and gridding features"). No daemon, no browser: it
// imports the real derivation and asserts on plain objects, so it cannot drift from a copy. Record:
// docs/decisions/ac0cfe91-atlas-sessions-terminal-order-and-grid.md
//
// The two storage helpers ARE covered, against an in-memory localStorage stub installed on globalThis
// (node has none) — including the throwing case, because "storage is unavailable" is the one branch a
// browser reaches on its own (private mode, blocked site data) and the one a reader would never see
// reported if it threw instead of falling back.
//
// Run it with: node --experimental-strip-types packages/web/test/terminal-layout.mjs
import assert from "node:assert/strict";
import {
  AUTO_GRID_TEMPLATE, DEFAULT_TILE_LAYOUT, GRID_COLUMN_CHOICES, MIN_READABLE_FONT_PX, applyTileOrder, autoGridTemplate,
  gridTemplateColumns, moveTileInOrder, parseTileLayout, readTileLayout, readableTileFloorPx, tileLayoutStorageKey, writeTileLayout,
} from "../src/lib/terminalLayout.ts";

/** A minimal tile — the shape the derivation reads (an id, and nothing else). */
const t = (id) => ({ id });
/** Order by id, so an assertion reads as the sequence on screen. */
const ids = (list) => list.map((x) => x.id);

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`ok   ${name}`); };

// ── gridTemplateColumns ───────────────────────────────────────────────────────────────────────────

// 1) The headline claim: an explicit count shares the row out into exactly that many EQUAL parts (so
//    it resolves to N tracks wherever each part clears the floor), and `auto` produces the pre-card
//    template verbatim — the god-eye page's byte-identical contract rests on that second half.
check("an explicit count shares the row N ways; auto gives the unchanged auto-fill template", () => {
  assert.equal(gridTemplateColumns("1"), "repeat(auto-fill, minmax(min(100%, max(320px, calc((100% - 0px) / 1))), 1fr))");
  assert.equal(gridTemplateColumns("2"), "repeat(auto-fill, minmax(min(100%, max(320px, calc((100% - 12px) / 2))), 1fr))");
  assert.equal(gridTemplateColumns("3"), "repeat(auto-fill, minmax(min(100%, max(320px, calc((100% - 24px) / 3))), 1fr))");
  // The control: `auto` is NOT a count, so it must not come out of the same template.
  assert.equal(gridTemplateColumns("auto"), AUTO_GRID_TEMPLATE);
  // `auto` keeps its OWN 560px wrap floor and none of the explicit form's share arithmetic. (Not
  // matched on `max(` — `minmax(` contains it, which would make the check pass for the wrong reason.)
  assert.match(AUTO_GRID_TEMPLATE, /minmax\(min\(100%, 560px\), 1fr\)/);
  assert.doesNotMatch(AUTO_GRID_TEMPLATE, /320px|calc\(/);
});

// 1b) Card eb516fba (audit B-23): `auto` keeps a tile READABLE for a wide pinned grid. At the default
//     80 columns nothing changes; at 120 the floor rises past 560px so two tiles no longer share a row
//     too narrow to read; and with no geometry reported yet `auto` is exactly its old template.
check("auto raises its tile floor for a wide pinned grid, and only then", () => {
  assert.equal(gridTemplateColumns("auto", undefined), AUTO_GRID_TEMPLATE, "no geometry yet: unchanged");
  assert.equal(gridTemplateColumns("auto", 80), AUTO_GRID_TEMPLATE, "the default 80 columns: unchanged");
  assert.equal(readableTileFloorPx(80), 80 * 6 + 22);
  const wide = gridTemplateColumns("auto", 120);
  assert.equal(readableTileFloorPx(120), 742);
  assert.equal(wide, "repeat(auto-fill, minmax(min(100%, 742px), 1fr))");
  // The positive control for the arithmetic: 742px at a 10px floor means the font a 742px tile solves to
  // for 120 columns is at least MIN_READABLE_FONT_PX (chrome off first, 0.6 cell width per px of font).
  assert.ok((742 - 22) / (120 * 0.6) >= MIN_READABLE_FONT_PX);
  // An explicit count is the reader's own choice and is never overridden by the pinned grid.
  assert.equal(gridTemplateColumns("2", 120), gridTemplateColumns("2"));
  // Junk geometry is treated as "not reported", never as a floor of NaN/0.
  for (const bad of [0, -1, Number.NaN]) assert.equal(autoGridTemplate(bad), AUTO_GRID_TEMPLATE);
});

// 2) THE GAP ALLOWANCE SCALES WITH N. The share has to subtract the (N-1) gaps BETWEEN the tracks
//    before dividing, or the N parts plus their gaps add up to more than the row and `auto-fill` fits
//    one fewer — "3 columns" would then draw 2 at every width. A fixed allowance would satisfy a
//    single-N assertion, so all three are read, and their subtrahends must differ.
check("the share subtracts one gap per boundary, not a fixed amount", () => {
  const subtrahend = (c) => gridTemplateColumns(c).match(/100% - (\d+)px/)[1];
  assert.deepEqual(["1", "2", "3"].map(subtrahend), ["0", "12", "24"]);
});

// 3) EVERY explicit count carries BOTH guards: the floor that keeps a tile wide enough for the shared
//    card to draw, and the `min(100%, …)` that stops that floor becoming a sideways scrollbar on a
//    container narrower than it. A build with the floor and not the clamp passes a floor-only check.
check("every explicit count carries both the floor and the 100% clamp", () => {
  for (const c of GRID_COLUMN_CHOICES.filter((x) => x !== "auto")) {
    assert.match(gridTemplateColumns(c), /max\(320px,/, `${c} must carry the tile floor`);
    assert.match(gridTemplateColumns(c), /minmax\(min\(100%,/, `${c} must clamp the floor to the container`);
  }
});

// 3b) Card 41a933d4: `auto` carries the same clamp at EVERY pinned width — the default template (no
//     geometry yet, 80 columns) as well as the raised readable floor — so a phone-width container gets
//     one full-width tile instead of a sideways scrollbar. The floor inside the clamp is still the
//     readable one, so eb516fba's rule holds wherever the row has room for it.
check("auto clamps its tile floor to the container at every pinned width", () => {
  for (const cols of [undefined, 80, 120, 200]) {
    const t = gridTemplateColumns("auto", cols);
    assert.match(t, /^repeat\(auto-fill, minmax\(min\(100%, \d+px\), 1fr\)\)$/, `auto @ ${cols} must clamp: ${t}`);
    const floor = Number(t.match(/min\(100%, (\d+)px\)/)[1]);
    assert.equal(floor, Math.max(560, readableTileFloorPx(cols) ?? 0), `auto @ ${cols} keeps its floor inside the clamp`);
  }
});

// ── parseTileLayout ───────────────────────────────────────────────────────────────────────────────

// 3) A round trip, which is the only thing the page ever asks of the pair in practice.
check("a layout the page wrote reads back identical", () => {
  const layout = { columns: "3", order: ["a", "b", "c"] };
  assert.deepEqual(parseTileLayout(JSON.stringify(layout)), layout);
});

// 4) EVERY unreadable shape falls back, and none of them throws. A browser-storage value can be
//    hand-edited, left by an older build, or written by a newer one; a page a reader is trying to use
//    must not fail to render over any of that.
check("an unreadable stored value falls back to the default instead of throwing", () => {
  for (const raw of [null, undefined, "", "not json", "[1,2,3]", "42", '"a string"', "null", "true"]) {
    assert.deepEqual(parseTileLayout(raw), DEFAULT_TILE_LAYOUT, `raw=${JSON.stringify(raw)}`);
  }
});

// 5) The fields fall back INDEPENDENTLY — one corrupt field never discards a good one. Without this,
//    an unknown column count (a value a newer build might write) would also wipe the reader's order.
check("one corrupt field does not discard the other", () => {
  assert.deepEqual(parseTileLayout('{"columns":"7","order":["a","b"]}'), { columns: "auto", order: ["a", "b"] });
  assert.deepEqual(parseTileLayout('{"columns":"2","order":"not an array"}'), { columns: "2", order: [] });
  assert.deepEqual(parseTileLayout('{"columns":2,"order":["a"]}'), { columns: "auto", order: ["a"] });
  // …and the control: with BOTH fields good, neither is touched.
  assert.deepEqual(parseTileLayout('{"columns":"2","order":["a","b"]}'), { columns: "2", order: ["a", "b"] });
});

// 6) The order is sanitised member-by-member: a non-string, an empty id and a duplicate are each
//    dropped, and the survivors keep their relative order. A duplicate matters beyond tidiness — it is
//    a second rank for one id, and the FIRST is the one `applyTileOrder` would honour anyway.
check("the stored order drops non-strings, empties and duplicates, keeping the rest in order", () => {
  assert.deepEqual(
    parseTileLayout('{"order":["b",null,"a","",3,"b",{"id":"c"},"c"]}').order,
    ["b", "a", "c"],
  );
});

// 7) The parsed default is a FRESH object each call — the page holds it as state and spreads over it,
//    so a shared mutable `order` array would leak one project's edits into the next project's default.
check("each parse returns its own arrays, never the shared default", () => {
  const a = parseTileLayout(null);
  const b = parseTileLayout("not json");
  assert.notEqual(a, DEFAULT_TILE_LAYOUT);
  assert.notEqual(a.order, b.order);
  a.order.push("leaked");
  assert.deepEqual(DEFAULT_TILE_LAYOUT.order, []);
  assert.deepEqual(b.order, []);
});

// ── applyTileOrder ────────────────────────────────────────────────────────────────────────────────

// 8) The headline claim: a saved order puts the tiles in it, and the DERIVED order is what stands
//    when there is none. The second half is the first's control — without it, a build that always
//    reversed the list would satisfy the first.
check("a saved order ranks the tiles it names; an empty order leaves the derived order alone", () => {
  const list = [t("a"), t("b"), t("c")];
  assert.deepEqual(ids(applyTileOrder(list, ["c", "a", "b"])), ["c", "a", "b"]);
  assert.deepEqual(ids(applyTileOrder(list, [])), ["a", "b", "c"]);
});

// 9) An id the order does NOT name keeps its derived position, AFTER every ranked tile — the decision
//    record's "a reader who placed four tiles keeps those four places". Both halves: the ranked ones
//    are in SAVED order, the rest in DERIVED order, and the two groups do not interleave.
check("unranked tiles follow the ranked ones, in their own derived order", () => {
  const list = [t("new1"), t("a"), t("new2"), t("b")]; // derived: newest-first
  assert.deepEqual(ids(applyTileOrder(list, ["b", "a"])), ["b", "a", "new1", "new2"]);
});

// 10) An id in the order that is no longer present is simply absent — the decay case, which is the
//     normal state of a stored order (session ids are ephemeral). It must not leave a hole, duplicate
//     a neighbour, or throw.
check("ids no longer present are skipped, not resurrected", () => {
  const list = [t("a"), t("b")];
  assert.deepEqual(ids(applyTileOrder(list, ["gone", "b", "also-gone", "a"])), ["b", "a"]);
  assert.deepEqual(ids(applyTileOrder(list, ["gone"])), ["a", "b"]);
  assert.deepEqual(applyTileOrder([], ["a", "b"]), []);
});

// 11) THE PINNED MANAGER. It leads its row whatever the order says — including an order that explicitly
//     ranks it last, which is the state a move control can never produce but a hand-edited or
//     older-build value can. The contrast case (no `pinnedFirstId`) is what proves slot 0 is the pin
//     acting and not the order coincidentally agreeing.
check("the pinned id leads its row even when the order ranks it last", () => {
  const list = [t("mgr"), t("w1"), t("w2")];
  assert.deepEqual(ids(applyTileOrder(list, ["w2", "w1", "mgr"], { pinnedFirstId: "mgr" })), ["mgr", "w2", "w1"]);
  // Same list, same order, NO pin: "mgr" sinks to last, so the line above is the pin, not the order.
  assert.deepEqual(ids(applyTileOrder(list, ["w2", "w1", "mgr"])), ["w2", "w1", "mgr"]);
  // A pin with an empty order still leads, and the rest keep their derived order.
  assert.deepEqual(ids(applyTileOrder(list, [], { pinnedFirstId: "mgr" })), ["mgr", "w1", "w2"]);
});

// 12) A `pinnedFirstId` naming a tile that is NOT in the list (a manager that exited between the
//     grouping and this call) is inert — no injected member, no thrown lookup, no dropped tile.
check("a pinned id that is absent from the list changes nothing", () => {
  const list = [t("a"), t("b")];
  assert.deepEqual(ids(applyTileOrder(list, ["b", "a"], { pinnedFirstId: "gone" })), ["b", "a"]);
  assert.deepEqual(ids(applyTileOrder(list, [], { pinnedFirstId: "gone" })), ["a", "b"]);
});

// 13) The caller's array is memoised render state shared with the bulk queue/wakes poll that keys off
//     it, so sorting it in place would re-order a list other consumers hold a reference to with no
//     re-render to tell them.
check("the caller's array is not mutated", () => {
  const list = [t("a"), t("b"), t("c")];
  const before = ids(list);
  const out = applyTileOrder(list, ["c", "b", "a"]);
  assert.deepEqual(ids(list), before, "the input array was reordered in place");
  assert.notEqual(out, list, "the same array instance was returned");
  assert.deepEqual(ids(out), ["c", "b", "a"]);
});

// ── moveTileInOrder ───────────────────────────────────────────────────────────────────────────────

// 14) The headline claim, both directions — one step earlier is a swap with the previous slot, one step
//     later with the next. Asserted on a three-element list so a build that merely reversed the pair at
//     the head would fail on the middle element.
check("a move swaps a tile with its neighbour, in both directions", () => {
  assert.deepEqual(moveTileInOrder(["a", "b", "c"], "c", -1), ["a", "c", "b"]);
  assert.deepEqual(moveTileInOrder(["a", "b", "c"], "a", 1), ["b", "a", "c"]);
  assert.deepEqual(moveTileInOrder(["a", "b", "c"], "b", -1), ["b", "a", "c"]);
  assert.deepEqual(moveTileInOrder(["a", "b", "c"], "b", 1), ["a", "c", "b"]);
});

// 15) EVERY no-op still returns the list unchanged rather than throwing or dropping a member — the
//     caller writes the result back unconditionally, so "nothing moved" has to be a valid answer.
check("a move off either end, an absent id and a zero delta are all no-ops", () => {
  const list = ["a", "b", "c"];
  assert.deepEqual(moveTileInOrder(list, "a", -1), list); // already first
  assert.deepEqual(moveTileInOrder(list, "c", 1), list);  // already last
  assert.deepEqual(moveTileInOrder(list, "nope", -1), list);
  assert.deepEqual(moveTileInOrder(list, "b", 0), list);
  assert.deepEqual(moveTileInOrder([], "a", 1), []);
  assert.deepEqual(moveTileInOrder(["only"], "only", 1), ["only"]);
  assert.deepEqual(moveTileInOrder(["only"], "only", -1), ["only"]);
});

// 16) A no-op returns a COPY, not the caller's array — the result is written straight into React state,
//     and handing back the same instance would make a later in-place edit mutate state invisibly.
check("even a no-op returns a new array", () => {
  const list = ["a", "b"];
  assert.notEqual(moveTileInOrder(list, "a", -1), list);
  assert.notEqual(moveTileInOrder(list, "a", 1), list);
  assert.deepEqual(list, ["a", "b"]);
});

// 17) A multi-slot delta moves rather than swaps (remove-then-insert), so the tiles it passes close up
//     behind it. The page only ever sends ±1 today; this pins the behaviour so a future control that
//     sends more does not silently get a different one.
check("a multi-slot move re-inserts rather than swapping", () => {
  assert.deepEqual(moveTileInOrder(["a", "b", "c", "d"], "a", 2), ["b", "c", "a", "d"]);
  assert.deepEqual(moveTileInOrder(["a", "b", "c", "d"], "d", -3), ["d", "a", "b", "c"]);
  // Past the end is still a no-op, not a clamp — the page's own controls are what refuse the press.
  assert.deepEqual(moveTileInOrder(["a", "b", "c"], "a", 3), ["a", "b", "c"]);
});

// ── the composition the page actually performs ────────────────────────────────────────────────────

// 18) A move and the re-read that follows it, end to end: move a tile, write the whole rendered
//     sequence back, apply it to the same list, and the moved tile is where it was put. This is the
//     claim the e2e exercises in a browser; here it is pinned without one.
check("a move survives the write-back and re-apply the page performs", () => {
  const row = [t("mgr"), t("w1"), t("w2"), t("w3")];
  const pinned = "mgr";
  const movable = row.filter((s) => s.id !== pinned).map((s) => s.id);
  const saved = [pinned, ...moveTileInOrder(movable, "w3", -1)];
  assert.deepEqual(ids(applyTileOrder(row, saved, { pinnedFirstId: pinned })), ["mgr", "w1", "w3", "w2"]);
  // And it is STABLE under re-application — re-applying the same saved order does not drift.
  const again = applyTileOrder(applyTileOrder(row, saved, { pinnedFirstId: pinned }), saved, { pinnedFirstId: pinned });
  assert.deepEqual(ids(again), ["mgr", "w1", "w3", "w2"]);
});

// ── the storage helpers ───────────────────────────────────────────────────────────────────────────

// 19) The key is per project — the whole reason the preference is gated on one. Two projects must not
//     collide, and the shape is the one the Overview fleet accordion already stores under.
check("the storage key is scoped to one project", () => {
  assert.equal(tileLayoutStorageKey("p1"), "loom.sessionsLayout.p1");
  assert.notEqual(tileLayoutStorageKey("p1"), tileLayoutStorageKey("p2"));
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

// 20) A write then a read, through the real helpers, under a working store — and the isolation claim:
//     a second project reads its OWN default, not the first project's layout.
check("a written layout reads back, and a second project is unaffected", () => {
  const store = memoryStorage();
  withStorage(store, () => {
    writeTileLayout("p1", { columns: "3", order: ["x", "y"] });
    assert.deepEqual(readTileLayout("p1"), { columns: "3", order: ["x", "y"] });
    assert.deepEqual(readTileLayout("p2"), DEFAULT_TILE_LAYOUT);
    assert.equal(store.map.size, 1, "only the written project's key should exist");
  });
});

// 21) A store that THROWS on both methods — private mode, blocked site data. Neither helper may
//     propagate it; the read answers the default and the write is simply lost. A page a reader is
//     trying to use must still render.
check("a throwing store falls back instead of propagating", () => {
  const throwing = {
    getItem() { throw new Error("SecurityError"); },
    setItem() { throw new Error("QuotaExceededError"); },
  };
  withStorage(throwing, () => {
    assert.deepEqual(readTileLayout("p1"), DEFAULT_TILE_LAYOUT);
    assert.doesNotThrow(() => writeTileLayout("p1", { columns: "2", order: ["a"] }));
  });
});

// 22) A stored value corrupted OUT OF BAND (hand-edited, or an older build's shape) reaches the page
//     through `readTileLayout`, so the defensive parse above has to be on THAT path too — not only on
//     a value the page itself wrote.
check("readTileLayout runs the defensive parse, not a bare JSON.parse", () => {
  const store = memoryStorage();
  withStorage(store, () => {
    store.setItem(tileLayoutStorageKey("p1"), "{ not json");
    assert.deepEqual(readTileLayout("p1"), DEFAULT_TILE_LAYOUT);
    store.setItem(tileLayoutStorageKey("p1"), '{"columns":"9","order":["a","a"]}');
    assert.deepEqual(readTileLayout("p1"), { columns: "auto", order: ["a"] });
  });
});

console.log(`\nAll ${pass} checks passed`);
