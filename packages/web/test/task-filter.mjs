// Hermetic unit test for Board.tsx's free-text search (card a44894d8).
// Bug: the board search haystack was only `title + body`, so searching a card by its id — the PRIMARY
// handle everyone uses (agents cite ids, the owner copies them from logs) — found nothing. Fix: include
// the id, so a full card id OR any prefix substring-matches (ids are lowercase hex + dashes).
//
// The web package has no test runner, so this is a self-contained node script that imports the pure
// function directly out of src/lib/taskFilter.ts (only `import type` is stripped), mirroring
// test/column-sort.mjs. Board.tsx filters with the SAME function, so the test can't drift from what
// ships. Run it with:
//   node --experimental-strip-types packages/web/test/task-filter.mjs
import assert from "node:assert/strict";
import { taskMatchesSearch } from "../src/lib/taskFilter.ts";

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`ok   ${name}`); };

// A representative card: a real UUID id, a title, and a body. The caller trims + lowercases the query
// once for the whole pass, so every query below is passed already-normalized (as Board.tsx does).
const card = {
  id: "a44894d8-32d4-4e03-bcea-b3184ec101c2",
  title: "fix(web): board search ignores card id",
  body: "the client-side filter's haystack is only title + body",
};

check("empty query matches every card (search is a no-op until the user types)", () => {
  assert.equal(taskMatchesSearch(card, ""), true);
  assert.equal(taskMatchesSearch({ id: "x", title: "y", body: null }, ""), true);
});

check("a full card id matches", () => {
  assert.equal(taskMatchesSearch(card, "a44894d8-32d4-4e03-bcea-b3184ec101c2"), true);
});

check("an 8-char id prefix matches", () => {
  assert.equal(taskMatchesSearch(card, "a44894d8"), true);
});

check("a mid-id substring matches too (any prefix/substring of the id)", () => {
  assert.equal(taskMatchesSearch(card, "4e03"), true);
});

check("title text still matches (unchanged behavior)", () => {
  assert.equal(taskMatchesSearch(card, "board search"), true);
});

check("body text still matches (unchanged behavior)", () => {
  assert.equal(taskMatchesSearch(card, "haystack"), true);
});

check("a query matching nothing does not match", () => {
  assert.equal(taskMatchesSearch(card, "nonexistent-token"), false);
});

check("a null/absent body never throws and doesn't spuriously match", () => {
  const noBody = { id: "deadbeef-0000-0000-0000-000000000000", title: "no body card", body: null };
  assert.equal(taskMatchesSearch(noBody, "deadbeef"), true); // id still matches
  assert.equal(taskMatchesSearch(noBody, "no body"), true);  // title still matches
  assert.equal(taskMatchesSearch(noBody, "haystack"), false);
});

console.log(`\n${pass} passed`);
