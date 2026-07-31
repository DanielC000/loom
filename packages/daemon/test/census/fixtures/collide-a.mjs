// loom:not-a-test: card fa52f555 — a child-process fixture spawned BY phase1-forced-probe.mjs, not a
// standalone test; its node:test shape is deliberately reused to make the probe's harness realistic.
// Phase 1 step 4 fixture: a KNOWN colliding pair (collide-a.mjs / collide-b.mjs) used to positive-control
// the forced-pair probe itself. Both write their own identity to the SAME fixed (non-process-unique) path
// — deliberately violating the per-process-isolation convention every real hermetic test follows — so
// running them concurrently should deterministically clobber one writer's read-back, while running either
// one solo always passes. This proves the probe can catch a real external-resource collision before it's
// trusted to judge real candidate pairs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert";

const SHARED_PATH = path.join(os.tmpdir(), "loom-census-collision-fixture-marker.json");
const ME = "collide-a";

test(`${ME} writes then reads back the shared marker`, async () => {
  fs.writeFileSync(SHARED_PATH, JSON.stringify({ owner: ME }));
  await new Promise((r) => setTimeout(r, 300 + Math.random() * 300));
  const seen = JSON.parse(fs.readFileSync(SHARED_PATH, "utf8"));
  assert.strictEqual(seen.owner, ME, `expected to still own the shared marker, but found "${seen.owner}"`);
});
