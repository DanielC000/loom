// loom:not-a-test: card fa52f555 — a child-process fixture spawned BY phase1-forced-probe.mjs, see
// collide-a.mjs's marker for the reasoning.
// Phase 1 step 4 fixture: see collide-a.mjs's header — this is its deliberate colliding twin.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert";

const SHARED_PATH = path.join(os.tmpdir(), "loom-census-collision-fixture-marker.json");
const ME = "collide-b";

test(`${ME} writes then reads back the shared marker`, async () => {
  fs.writeFileSync(SHARED_PATH, JSON.stringify({ owner: ME }));
  await new Promise((r) => setTimeout(r, 300 + Math.random() * 300));
  const seen = JSON.parse(fs.readFileSync(SHARED_PATH, "utf8"));
  assert.strictEqual(seen.owner, ME, `expected to still own the shared marker, but found "${seen.owner}"`);
});
