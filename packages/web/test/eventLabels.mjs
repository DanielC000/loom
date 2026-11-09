// Hermetic unit test for src/lib/eventLabels.ts (card 99b98864): the plain-English labels the Timeline,
// Pulse and Replay rows show in place of raw event kinds. No daemon, no React: imports the TS source via
// Node's type stripping. Run standalone with:
//   node --experimental-strip-types packages/web/test/eventLabels.mjs
import assert from "node:assert/strict";
import { eventKindLabel, humanizeKind } from "../src/lib/eventLabels.ts";

// Hand-written labels for the kinds the audit named.
assert.equal(eventKindLabel("spawn_worker"), "Started worker");
assert.equal(eventKindLabel("merge_request"), "Merge requested");
assert.equal(eventKindLabel("worker_context_high"), "Worker context high");

// worker_report folds its status in; an unknown or missing status keeps the generic wording.
assert.equal(eventKindLabel("worker_report", { status: "done" }), "Worker done");
assert.equal(eventKindLabel("worker_report", { status: "blocked" }), "Worker blocked");
assert.equal(eventKindLabel("worker_report", { status: "weird" }), "Worker reported");
assert.equal(eventKindLabel("worker_report"), "Worker reported");
assert.equal(eventKindLabel("worker_report", null), "Worker reported");

// deploy reads its outcome; only an explicit ok:false is a failure.
assert.equal(eventKindLabel("deploy", { ok: false }), "Deploy failed");
assert.equal(eventKindLabel("deploy", { ok: true }), "Deployed");
assert.equal(eventKindLabel("deploy"), "Deployed");

// Any kind without a hand-written label still reads as words, never blank and never snake_case.
assert.equal(eventKindLabel("recycle_fleet_stranded_across_restart"), "Recycle fleet stranded across restart");
assert.equal(humanizeKind("a__b"), "A b");
assert.equal(humanizeKind(""), "");
for (const k of ["spawn_worker", "worker_report", "some_future_kind", "x"]) {
  const label = eventKindLabel(k);
  assert.ok(label.length > 0, `${k} produced an empty label`);
  assert.ok(!label.includes("_"), `${k} label still has an underscore: ${label}`);
}

console.log("eventLabels: ok");
