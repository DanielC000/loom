// Phase 0 positive-control fixture: a trivial passing test (known-good).
import { test } from "node:test";
import assert from "node:assert";

test("pc-pass-1 trivially passes", () => {
  assert.strictEqual(1 + 1, 2);
});
