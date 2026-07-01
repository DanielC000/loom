// Hermetic unit test for Archive.tsx's Restore/Delete invalidation keys (UI-audit finding #12).
// Bug: invalidate() targeted ["allArchived"], but every god-eye archive query (api.allArchivedSessions,
// MissionControl, RunHistory, SessionView) is keyed ["allArchivedSessions"] — so those views never
// refreshed after Restore/Delete until a manual reload. Fix: invalidate the canonical key exactly.
//
// The web package has no test runner, so this is a self-contained node script that imports the pure
// key list directly out of src/lib/archiveInvalidate.ts (only `import type` is stripped; a plain .ts
// with no JSX, since node's type-stripping can't erase .tsx), mirroring test/sessions-order.mjs. Archive.tsx
// imports the same constant, so the test can't drift from what actually ships. Run it with:
//   node --experimental-strip-types packages/web/test/archive-invalidate.mjs
import assert from "node:assert/strict";
import { ARCHIVE_INVALIDATE_KEYS } from "../src/lib/archiveInvalidate.ts";

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`ok   ${name}`); };
const sameKey = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

check("invalidates the canonical god-eye archive key", () => {
  assert.ok(
    ARCHIVE_INVALIDATE_KEYS.some((k) => sameKey(k, ["allArchivedSessions"])),
    "expected [\"allArchivedSessions\"] among the invalidated query keys",
  );
});

check("never invalidates the stale/wrong key", () => {
  assert.ok(
    !ARCHIVE_INVALIDATE_KEYS.some((k) => sameKey(k, ["allArchived"])),
    "[\"allArchived\"] is not the canonical key and must not be invalidated",
  );
});

check("still invalidates the page's own scope + live-session consumers", () => {
  assert.deepEqual(ARCHIVE_INVALIDATE_KEYS.find((k) => k[0] === "archive"), ["archive"]);
  assert.deepEqual(ARCHIVE_INVALIDATE_KEYS.find((k) => k[0] === "allSessions"), ["allSessions"]);
  assert.deepEqual(ARCHIVE_INVALIDATE_KEYS.find((k) => k[0] === "sessions"), ["sessions"]);
});

console.log(`\n${pass} passed`);
