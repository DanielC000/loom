// loom:not-a-test: card fa52f555 — a child-process fixture spawned BY phase0-positive-control.mjs, not a
// standalone test.
// Phase 0 positive-control fixture: a second trivial passing test (known-good).
import { test } from "node:test";
import assert from "node:assert";

test("pc-pass-2 trivially passes", () => {
  assert.strictEqual("a" + "b", "ab");
});
