// Hermetic unit test for the card ↔ worker ↔ review derivations — src/lib/cardWorker.ts, card fa4234ab
// (Atlas audit B finding G-01). No daemon, no browser: it imports the real functions and asserts on
// plain objects shaped like the `["allSessions"]` feed and a manager's `["orchEvents", id]` stream.
//
// Run it with: node --experimental-strip-types packages/web/test/card-worker.mjs
import assert from "node:assert/strict";
import { register } from "node:module";

// cardWorker.ts imports ./fleet extensionless (bundler style), which Node's own resolver cannot follow,
// so the import below is DYNAMIC: a static one would hoist above `register()`.
register("./_tsxLoaderHook.mjs", import.meta.url);

const { hasPendingMergeRequest, mergeRequestCardTitle, mergeRequestRowText, workerReviewPath, workerSessionPath } =
  await import("../src/lib/cardWorker.ts");

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`ok   ${name}`); };

const W = (id, taskId, processState = "live") => ({ id, taskId, processState });
let seq = 0;
const E = (kind, taskId, workerSessionId, extra = {}) =>
  ({ id: `e${++seq}`, kind, taskId, workerSessionId, managerSessionId: "m1", ts: new Date(Date.UTC(2026, 10, 8, 0, 0, seq)).toISOString(), ...extra });

check("routes: one spelling for the session node and the review diff", () => {
  assert.equal(workerSessionPath("abc"), "/session/abc");
  assert.equal(workerReviewPath("abc"), "/review/abc");
});

check("no events, or none yet loaded, is not a pending review", () => {
  assert.equal(hasPendingMergeRequest(undefined, W("w1", "t1")), false);
  assert.equal(hasPendingMergeRequest([], W("w1", "t1")), false);
});

check("a merge_request for this worker's card is pending", () => {
  assert.equal(hasPendingMergeRequest([E("merge_request", "t1", "w1")], W("w1", "t1")), true);
});

check("a later merge_done or merge_rejected retires it", () => {
  assert.equal(hasPendingMergeRequest([E("merge_request", "t1", "w1"), E("merge_done", "t1", "w1")], W("w1", "t1")), false);
  assert.equal(hasPendingMergeRequest([E("merge_request", "t1", "w1"), E("merge_rejected", "t1", "w1")], W("w1", "t1")), false);
});

check("a fresh request after a rejection is pending again (latest wins, whatever the array order)", () => {
  const evs = [E("merge_request", "t1", "w1"), E("merge_rejected", "t1", "w1"), E("merge_request", "t1", "w1")];
  assert.equal(hasPendingMergeRequest([...evs].reverse(), W("w1", "t1")), true);
});

check("a request filed by an EARLIER worker on the same card does not make the current one reviewable", () => {
  assert.equal(hasPendingMergeRequest([E("merge_request", "t1", "w0")], W("w1", "t1")), false);
});

check("another card's request is not this worker's", () => {
  assert.equal(hasPendingMergeRequest([E("merge_request", "t2", "w2")], W("w1", "t1")), false);
});

check("a worker that is no longer running has no live review", () => {
  assert.equal(hasPendingMergeRequest([E("merge_request", "t1", "w1")], W("w1", "t1", "exited")), false);
  assert.equal(hasPendingMergeRequest([E("merge_request", "t1", "w1")], W("w1", "t1", "starting")), true);
});

check("a task-less request still pairs by worker id", () => {
  assert.equal(hasPendingMergeRequest([E("merge_request", null, "w1")], W("w1", null)), true);
});

check("card title: worker → its taskId → the board's title", () => {
  const sessions = [{ id: "w1", taskId: "t1" }, { id: "w2", taskId: null }];
  const titles = new Map([["t1", "Stop double-charging on retry"]]);
  assert.equal(mergeRequestCardTitle("w1", sessions, titles), "Stop double-charging on retry");
  assert.equal(mergeRequestCardTitle("w2", sessions, titles), null, "a worker with no card");
  assert.equal(mergeRequestCardTitle("w9", sessions, titles), null, "an unknown worker");
  assert.equal(mergeRequestCardTitle("w1", undefined, titles), null, "sessions not loaded yet");
  assert.equal(mergeRequestCardTitle("w1", sessions, new Map()), null, "board not loaded yet");
  assert.equal(mergeRequestCardTitle(null, sessions, titles), null);
});

check("row text leads with the card, then the short worker id", () => {
  assert.equal(mergeRequestRowText("Fix it", "0123456789abcdef"), "Fix it · w:01234567 · awaiting review");
});

console.log(`\n${pass} passed`);
