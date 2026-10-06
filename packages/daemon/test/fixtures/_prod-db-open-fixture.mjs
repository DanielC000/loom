// Fixture for prod-db-default-refuse.mjs — NOT a standalone test, and doubly excluded from suite
// discovery: it lives under `fixtures/` (an excluded-container directory the discovery walk never
// descends into) AND its own basename is underscore-prefixed. Same shape/location precedent as
// `_bare-default-db-open.mjs` (prod-guard-structural.mjs's own fixture).
//
// Parametrized via env vars so one fixture file exercises every branch of card 0a03059e's
// `assertProdDbOpenAllowed` guard from a REAL child process (never in-process, so each case sees
// exactly the env/argv a genuine invocation of that shape would see):
//   LOOM_FIXTURE_DECLARE_DAEMON=1       -> calls declareDaemonProcess() before constructing Db
//   LOOM_FIXTURE_ALLOW_PROD_DB_OPT=1    -> passes { allowProdDb: true } to the Db constructor (the CODE
//                                          option, distinct from the daemon reading LOOM_ALLOW_PROD_DB
//                                          itself out of its own env, which needs no fixture support)
//   LOOM_FIXTURE_DB_FILE                -> overrides the path passed to `new Db(...)` (defaults to the
//                                          class's own default path when unset, i.e. a bare `new Db()`)
//
// The parent harness points HOME/USERPROFILE at a disposable decoy directory before spawning this file,
// so even if a guard failed to fire, this would only create a throwaway db under that decoy — never the
// real developer's actual ~/.loom.
import { pathToFileURL } from "node:url";

const dbModulePath = process.env.LOOM_FIXTURE_DB_MODULE;
if (!dbModulePath) {
  console.error("LOOM_FIXTURE_DB_MODULE not set");
  process.exit(2);
}

const { Db, declareDaemonProcess } = await import(pathToFileURL(dbModulePath).href);

if (process.env.LOOM_FIXTURE_DECLARE_DAEMON === "1") declareDaemonProcess();

const file = process.env.LOOM_FIXTURE_DB_FILE;
const opts = process.env.LOOM_FIXTURE_ALLOW_PROD_DB_OPT === "1" ? { allowProdDb: true } : undefined;

try {
  const d = file !== undefined ? new Db(file, opts) : new Db(undefined, opts);
  d.close();
  console.log("OPENED");
} catch (e) {
  console.log(`THREW:${e.message}`);
  process.exitCode = 1;
}
