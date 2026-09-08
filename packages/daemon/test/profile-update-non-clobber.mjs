import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 1306bdcb — pins as a HERMETIC regression test what card 0808c721 only OBSERVED live: db.ts's
// `updateProfile` treats an OMITTED (`undefined`) `harness` key on a patch as "leave the column as-is",
// never as "clear it". Before this test, that guarantee was RENTED from a single mutable production row
// (profile 94ffc653, harness="codex") — unset that row (or re-seed it) and the coverage evaporates
// silently; nothing would fail, the check would simply become impossible again, exactly as it already was
// for the weeks 0-of-25 profiles had harness set. This test owns its own fixture profile instead.
//
// Exercises the REAL `db.updateProfile()` binding path (db.ts:4783), not a re-implementation of its
// `patch.harness === undefined ? undefined : patch.harness ?? null` ternary — a test that re-states the
// filter's own logic would pass whether or not the shipped writer is correct (memory
// `a-control-inherits-the-equivalence-you-assumed-building-it`).
//
// DoD-5 (does insertProfile warrant the same coverage?): NO — insertProfile has no "leave existing
// value as-is" semantics to protect in the first place. It always INSERTs a brand-new row and
// unconditionally binds every column (`harness: p.harness ?? null`, db.ts:4773) via a single
// `satisfies Record<keyof Profile, unknown>` literal — there is no pre-existing column value on that row
// for an omitted field to accidentally clobber, so the clobber bug class this card guards against is
// structurally impossible on the insert path. See db.ts:4756-4780.
//
// RED-before-GREEN (verified by hand, not by this file): patched db.ts's `harness` binding to
// `patch.harness ?? null` (dropping the `=== undefined` guard), rebuilt, and confirmed this test's check
// (2) failed — the clobbered patch overwrote "codex" with null. Reverted via diff-patch + rebuild (not
// git stash) and confirmed it passes again.
//
// Run: 1) build (turbo builds shared first), 2) node test/profile-update-non-clobber.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-pupdate-${Date.now()}-${process.pid}`);
fs.mkdirSync(tmpHome, { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");

const db = new Db();

// ===================== fixture — a profile of our own, never a live/shared row =====================
db.insertProfile({
  id: "pClobberFixture", name: "Clobber Fixture", role: "worker", description: "orig",
  allowDelta: [], skills: null, model: null, icon: null, harness: "codex",
});
const before = db.getProfile("pClobberFixture");
check("(setup) fixture profile created with harness set", before.harness === "codex");

// ===================== (1) an UNRELATED patch (no harness key) must NOT clobber it =====================
db.updateProfile("pClobberFixture", { description: "patched, no harness key at all" });
const afterUnrelated = db.getProfile("pClobberFixture");
check("(1) unrelated patch applied (description changed)", afterUnrelated.description === "patched, no harness key at all");
check("(2) unrelated patch did NOT clobber harness — still \"codex\"", afterUnrelated.harness === "codex");

// ===================== (3) an EXPLICIT harness patch still writes through (the guard isn't a no-op) =====================
db.updateProfile("pClobberFixture", { harness: "claude" });
check("(3) an explicit harness patch DOES write through", db.getProfile("pClobberFixture").harness === "claude");

// ===================== (4) an explicit null clears it (distinct from omission) =====================
// db.ts's toProfile() maps a NULL harness column to `undefined` unconditionally (harness: (r.harness as
// ...) ?? undefined, db.ts:7972 — "NULL ⇒ undefined = claude", the same read-side coercion
// profile-harness-read.mjs's own SCOPE control documents). So an explicit `harness: null` patch reads
// back via db.getProfile() as `undefined`, NOT `null` — asserting `=== null` here would be wrong, not the
// writer. The meaningful assertion is that the clear actually took effect: harness moved OFF "claude".
db.updateProfile("pClobberFixture", { harness: null });
check("(4) an explicit null patch clears harness (reads back undefined, off \"claude\" — NULL's documented read-side coercion)",
  db.getProfile("pClobberFixture").harness === undefined);

// ===================== (5) omission after a clear still leaves it alone (not re-clobbered, not resurrected) =====================
db.updateProfile("pClobberFixture", { description: "second unrelated patch" });
check("(5) a later unrelated patch leaves the now-cleared harness untouched (still undefined, not resurrected)",
  db.getProfile("pClobberFixture").harness === undefined);

db.close(); // free the WAL handle before removing the temp dir (Windows)
try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — updateProfile never clobbers an omitted harness key on a hermetic fixture profile (own row, not a live one)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
