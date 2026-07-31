// loom:not-a-test: card fa52f555 — a child-process fixture spawned BY phase0-positive-control.mjs, not a
// standalone test (it exists to deliberately fail).
// Phase 0 positive-control fixture: a DELIBERATE failure (known-bad), to prove the harness can go red.
import { test } from "node:test";
import assert from "node:assert";

test("pc-fail deliberately fails", () => {
  assert.strictEqual(1, 2, "intentional positive-control failure");
});
