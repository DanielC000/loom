// Hermetic unit test for the Workspace node's `needs you` split — src/lib/needsYouSplit.ts, card 73b41b5d
// (Atlas audit A-15: "Needs you 13" beside "Inbox 10" with nothing saying why). No daemon, no browser.
//
// Run it with: node --experimental-strip-types packages/web/test/needs-you-split.mjs
import assert from "node:assert/strict";
import { needsYouSplit, needsYouSummary } from "../src/lib/needsYouSplit.ts";

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`ok   ${name}`); };

const req = (id) => ({ kind: "DECISION NEEDED", questionId: id });
const notice = (id) => ({ kind: "NOTICE", questionId: id, isNotice: true });
const merge = { kind: "MERGE REQUEST", questionId: null };
const alert = (kind) => ({ kind });

// 1) The audit's own shape: requests plus non-request items, each named.
check("requests, merges, notices and alerts are counted apart", () => {
  const items = [req("a"), req("b"), req("c"), merge, notice("n"), alert("STUCK-BUSY"), alert("RATE-LIMITED")];
  assert.deepEqual(needsYouSplit(items), { requests: 3, merges: 1, notices: 1, alerts: 2 });
  assert.equal(needsYouSummary(needsYouSplit(items)), "3 requests · 1 merge · 1 notice · 2 alerts");
});

// 2) The parts always add back up to the tile's own figure, so the sub-line can never contradict it.
check("the parts sum to the item count", () => {
  const items = [req("a"), merge, merge, notice("n"), alert("X"), req("b")];
  const s = needsYouSplit(items);
  assert.equal(s.requests + s.merges + s.notices + s.alerts, items.length);
});

// 3) A notice carries a questionId but is NOT a request — the Inbox count leaves it out, so must this.
//    Control: the same row without `isNotice` IS a request.
check("a notice is not counted as a request", () => {
  assert.deepEqual(needsYouSplit([notice("n")]), { requests: 0, merges: 0, notices: 1, alerts: 0 });
  assert.deepEqual(needsYouSplit([{ ...notice("n"), isNotice: false }]), { requests: 1, merges: 0, notices: 0, alerts: 0 });
});

// 4) Zero parts are dropped, singulars are singular, and empty reads as a phrase rather than "".
check("summary wording", () => {
  assert.equal(needsYouSummary(needsYouSplit([req("a")])), "1 request");
  assert.equal(needsYouSummary(needsYouSplit([alert("X"), alert("Y")])), "2 alerts");
  assert.equal(needsYouSummary(needsYouSplit([])), "nothing waiting");
});

console.log(`\n${pass} checks passed`);
