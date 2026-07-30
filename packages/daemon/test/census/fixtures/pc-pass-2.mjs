// Phase 0 positive-control fixture: a second trivial passing test (known-good).
import { test } from "node:test";
import assert from "node:assert";

test("pc-pass-2 trivially passes", () => {
  assert.strictEqual("a" + "b", "ab");
});
