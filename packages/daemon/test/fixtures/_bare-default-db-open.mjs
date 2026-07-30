// Fixture for prod-guard-structural.mjs — NOT a standalone test, and doubly excluded from suite
// discovery: it lives under `fixtures/` (an excluded-container directory the discovery walk never
// descends into) AND its own basename is underscore-prefixed (excluded even if that directory rule
// ever changes). Same shape/location as f876e099's `fixtures/_child-*.mjs` — follow that precedent,
// not a bespoke `_fixtures/` dir (which is NOT on the exclusion list and would be picked up as a
// candidate by a recursive walk, then rejected for having no assertion marker — a real gate failure).
//
// Simulates a brand-new daemon test that forgot to import `_guard.mjs` and was invoked directly
// (`node test/<file>.mjs`) with NO env set at all — no LOOM_TEST, no NODE_ENV, no LOOM_HOME, no
// LOOM_PORT. Deliberately imports nothing that would arm any marker; just opens `new Db()` at its
// default path, exactly like the 2026-06-04 incident's bare test file did.
//
// The parent harness points HOME/USERPROFILE at a disposable decoy directory before spawning this
// file (see prod-guard-structural.mjs), so even if the structural guard failed to fire, this would
// only create a throwaway db under that decoy — never the real developer's actual ~/.loom.
import { pathToFileURL } from "node:url";

const dbModulePath = process.env.LOOM_FIXTURE_DB_MODULE;
if (!dbModulePath) {
  console.error("LOOM_FIXTURE_DB_MODULE not set");
  process.exit(2);
}

const { Db } = await import(pathToFileURL(dbModulePath).href);
try {
  const d = new Db();
  d.close();
  console.log("OPENED");
} catch (e) {
  console.log(`THREW:${e.message}`);
  process.exitCode = 1;
}
