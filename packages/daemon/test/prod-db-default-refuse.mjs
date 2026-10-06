// Prod-DB default-refuse regression test — card 0a03059e (docs/decisions/0a03059e-prod-db-default-refuse.md).
//
// 2026-10-03: an uncommitted, ad-hoc script ran OUTSIDE packages/daemon/test/ with no LOOM_TEST marker
// set, called `new Db()` at its default path with no LOOM_HOME override, and silently wrote a project row
// into the real ~/.loom/loom.db. The pre-existing prod-guard (prod-guard.mjs, prod-guard-structural.mjs)
// only refused the real prod DB under a test marker OR an entry script resolving inside
// packages/daemon/test/ — a script that is NEITHER sailed straight through with no throw.
//
// This proves the fix: the real prod DB now refuses by default unless the daemon explicitly declared
// itself (`declareDaemonProcess()`) or a caller explicitly opted in (`{ allowProdDb: true }` on the Db
// constructor — deliberately NO env-var opt-in; see the record). Every case runs a REAL child process
// (never in-process) against a disposable decoy HOME/USERPROFILE, never the real developer's actual
// ~/.loom — so even a guard FAILURE here would only create a throwaway db under the decoy.
//
// Run: 1) build daemon, 2) node test/prod-db-default-refuse.mjs
import "./_guard.mjs"; // arms LOOM_TEST=1 for THIS orchestrating process (belt-and-suspenders)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const dbModulePath = path.join(__dirname, "..", "dist", "db.js");
const fixtureInsideTestDir = path.join(__dirname, "fixtures", "_prod-db-open-fixture.mjs");
// A copy OUTSIDE test/ so `looksLikeDirectTestInvocation()` is false for it (the shape of the real
// incident — a script that is neither under test/ nor carries any marker).
const outsideDir = mkdtempManaged("loom-proddb-outside-");
const fixtureOutsideTestDir = path.join(outsideDir, "prod-db-open-fixture.mjs");
fs.copyFileSync(fixtureInsideTestDir, fixtureOutsideTestDir);

function makeDecoyHome() {
  const home = mkdtempManaged("loom-proddb-decoy-");
  fs.mkdirSync(path.join(home, ".loom"), { recursive: true }); // pre-create so a guard failure would really open a file
  return home;
}

// Strip every marker a genuine bare invocation would never have set, then point HOME/USERPROFILE at a
// decoy so os.homedir() (and thus REAL_PROD_DB / the default LOOM_HOME fallback) resolves to a harmless
// throwaway directory instead of the real user profile.
function bareEnv(decoyHome, extra = {}) {
  const env = { ...process.env, LOOM_FIXTURE_DB_MODULE: dbModulePath };
  delete env.LOOM_TEST;
  delete env.NODE_ENV;
  delete env.LOOM_HOME;
  delete env.LOOM_PORT;
  // LOOM_ALLOW_PROD_DB is deliberately deleted here (not just never set) — card 45fba6cf removed this
  // env var entirely; (8) below proves setting it to anything, including "1", is now a pure no-op.
  delete env.LOOM_ALLOW_PROD_DB;
  delete env.LOOM_FIXTURE_DECLARE_DAEMON;
  delete env.LOOM_FIXTURE_ALLOW_PROD_DB_OPT;
  delete env.LOOM_FIXTURE_DB_FILE;
  env.HOME = decoyHome;
  env.USERPROFILE = decoyHome;
  Object.assign(env, extra); // applied LAST so an override survives the deletes above
  return env;
}

function run(entryPath, decoyHome, extra = {}) {
  return spawnSync(process.execPath, [entryPath], { env: bareEnv(decoyHome, extra), encoding: "utf8" });
}

// --- (1) No declaration, no opt-in, entry OUTSIDE test/, bare env -> REFUSES by default ---
// This is the exact incident shape: not under test/ (so looksLikeDirectTestInvocation() is false), no
// LOOM_TEST/NODE_ENV (so inTestMode() is false), no declaration, no opt-in.
{
  const decoyHome = makeDecoyHome();
  const result = run(fixtureOutsideTestDir, decoyHome);
  const dbFile = path.join(decoyHome, ".loom", "loom.db");
  check("(1) bare script outside test/, no declare/opt-in -> refuses, names the escape hatch",
    result.status === 1 && /THREW:refusing to open the prod DB/.test(result.stdout || "")
      && /declareDaemonProcess/.test(result.stdout || "") && /allowProdDb/.test(result.stdout || ""));
  check("(1) the refusal never mentions a now-removed env var", !/LOOM_ALLOW_PROD_DB/.test(result.stdout || ""));
  check("(1) no db file was ever created under the decoy home", !fs.existsSync(dbFile));
}

// --- (2) The daemon's own declaration -> OPENS (simulates the real index.ts boot path) ---
{
  const decoyHome = makeDecoyHome();
  const result = run(fixtureOutsideTestDir, decoyHome, { LOOM_FIXTURE_DECLARE_DAEMON: "1" });
  check("(2) declareDaemonProcess() called first -> opens normally", result.status === 0 && /^OPENED/m.test(result.stdout || ""));
}

// --- (3) Explicit opt-in via the Db constructor option -> OPENS ---
{
  const decoyHome = makeDecoyHome();
  const result = run(fixtureOutsideTestDir, decoyHome, { LOOM_FIXTURE_ALLOW_PROD_DB_OPT: "1" });
  check("(3) { allowProdDb: true } passed to the Db constructor -> opens normally", result.status === 0 && /^OPENED/m.test(result.stdout || ""));
}

// --- (5) Non-default LOOM_HOME -> entirely unaffected, no declare/opt-in needed ---
{
  const decoyHome = makeDecoyHome();
  const isolatedHome = mkdtempManaged("loom-proddb-isolated-");
  const result = run(fixtureOutsideTestDir, decoyHome, { LOOM_HOME: isolatedHome });
  check("(5) a non-default LOOM_HOME opens fine with no declare/opt-in at all (every hermetic test is this shape)",
    result.status === 0 && /^OPENED/m.test(result.stdout || ""));
}

// --- (6) NEGATIVE CONTROL: a test marker vetoes declare+opt-in both at once (defense in depth) ---
// Entry OUTSIDE test/ this time (isolates this assertion from looksLikeDirectTestInvocation()), but with
// LOOM_TEST=1 AND both the declaration and the opt-in set — must still refuse, with the TEST-marker
// wording, never the default-refuse wording.
{
  const decoyHome = makeDecoyHome();
  const result = run(fixtureOutsideTestDir, decoyHome, {
    LOOM_TEST: "1", LOOM_FIXTURE_DECLARE_DAEMON: "1", LOOM_FIXTURE_ALLOW_PROD_DB_OPT: "1",
  });
  check("(6) a test marker refuses even with declare+opt-in both set (never relaxed)",
    result.status === 1 && /THREW:refusing to open the prod DB \(~\/\.loom\/loom\.db\) from a daemon test/.test(result.stdout || ""));
}

// --- (7) NEGATIVE CONTROL: entry INSIDE test/ (bare, no LOOM_TEST) still refuses even with declare+opt-in ---
// Proves looksLikeDirectTestInvocation() alone (no env marker at all) ALSO vetoes declare/opt-in, not just
// an explicit LOOM_TEST marker (case 6 above).
{
  const decoyHome = makeDecoyHome();
  const result = run(fixtureInsideTestDir, decoyHome, { LOOM_FIXTURE_DECLARE_DAEMON: "1", LOOM_FIXTURE_ALLOW_PROD_DB_OPT: "1" });
  check("(7) entry inside test/, bare env, still refuses even with declare+opt-in set",
    result.status === 1 && /THREW:refusing to open the prod DB \(~\/\.loom\/loom\.db\) from a daemon test/.test(result.stdout || ""));
}

// --- (8) NEGATIVE CONTROL: LOOM_ALLOW_PROD_DB is GONE — setting it, to ANY value including "1", is a
// pure no-op (card 45fba6cf removed the env-var opt-in entirely: <LOOM_HOME>/.env loads into the daemon's
// own env, and every spawned agent session inherits process.env, so an env var would let one operator
// setting it once re-expose the real DB to every ad-hoc script in every agent session). ---
{
  const decoyHome = makeDecoyHome();
  for (const value of ["1", "0", "yes", "true", "TRUE", ""]) {
    const result = run(fixtureOutsideTestDir, decoyHome, { LOOM_ALLOW_PROD_DB: value });
    check(`(8) LOOM_ALLOW_PROD_DB=${JSON.stringify(value)} is a no-op (env var removed) -> still refuses`,
      result.status === 1 && /THREW:refusing to open the prod DB/.test(result.stdout || ""));
  }
}

// --- (9) CASE-INSENSITIVITY: an explicit path to the same real prod DB, typed in a DIFFERENT case,
// still refuses (card 45fba6cf's Code Review finding — a bare path.resolve string compare is
// case-SENSITIVE, but Windows paths are not). HOME/USERPROFILE stay at the decoy's own exact case;
// only the FILE argument passed to `new Db(...)` is case-flipped. ---
{
  const decoyHome = makeDecoyHome();
  const realFile = path.join(decoyHome, ".loom", "loom.db");
  const differentlyCasedFile = realFile === realFile.toUpperCase() ? realFile.toLowerCase() : realFile.toUpperCase();
  const result = run(fixtureOutsideTestDir, decoyHome, { LOOM_FIXTURE_DB_FILE: differentlyCasedFile });
  check("(9) a differently-cased explicit path to the same real prod db still refuses (no declare/opt-in)",
    result.status === 1 && /THREW:refusing to open the prod DB/.test(result.stdout || ""));
}

// --- (10) CASE-INSENSITIVITY + TEST MARKER: the same differently-cased path, now with LOOM_TEST=1 ---
// Proves normalization happens BEFORE the test-marker branch even engages — if case-folding failed, the
// path would never be recognized as prod at all, and this would open instead of hitting the test-marker
// wording specifically.
{
  const decoyHome = makeDecoyHome();
  const realFile = path.join(decoyHome, ".loom", "loom.db");
  const differentlyCasedFile = realFile === realFile.toUpperCase() ? realFile.toLowerCase() : realFile.toUpperCase();
  const result = run(fixtureOutsideTestDir, decoyHome, { LOOM_TEST: "1", LOOM_FIXTURE_DB_FILE: differentlyCasedFile });
  check("(10) a differently-cased path is STILL vetoed under LOOM_TEST (test-marker wording, not default-refuse)",
    result.status === 1 && /THREW:refusing to open the prod DB \(~\/\.loom\/loom\.db\) from a daemon test/.test(result.stdout || ""));
}

// --- (11) JUNCTION ALIAS: the same real prod DB, reached through a directory junction pointing at the
// decoy home, still refuses (realpathSync.native resolves the junction to its real target before the
// comparison). Junctions need no elevation on Windows; skips cleanly if creation fails for any reason.
// NOTE: realpathSync.native needs the FINAL path component to actually exist to resolve a junction in
// its ancestry (card 45fba6cf's own fallback — "realpathSync.native when the file exists, else
// path.resolve" — is plain path.resolve otherwise, which does NOT see through a junction). A real,
// already-booted-at-least-once prod DB always has a loom.db file on disk, so this pre-creates one to
// match that realistic shape, rather than the much rarer "brand new empty home reached via a junction
// on its very first boot" corner this card's fix does not claim to close. ---
{
  const decoyHome = makeDecoyHome();
  fs.writeFileSync(path.join(decoyHome, ".loom", "loom.db"), ""); // placeholder so realpath can resolve it
  const junctionParent = mkdtempManaged("loom-proddb-junction-parent-");
  const junctionAlias = path.join(junctionParent, "alias-home");
  let junctionOk = true;
  try {
    fs.symlinkSync(decoyHome, junctionAlias, "junction");
  } catch (e) {
    junctionOk = false;
    console.log(`(11) SKIP — could not create a junction hermetically on this host: ${e.message}`);
  }
  if (junctionOk) {
    const aliasedFile = path.join(junctionAlias, ".loom", "loom.db");
    const result = run(fixtureOutsideTestDir, decoyHome, { LOOM_FIXTURE_DB_FILE: aliasedFile });
    check("(11) a junction-aliased path to the same real prod db still refuses (no declare/opt-in)",
      result.status === 1 && /THREW:refusing to open the prod DB/.test(result.stdout || ""));
    // Belt-and-suspenders: confirm removing the junction never recursed into its real target.
    fs.rmSync(junctionAlias, { recursive: true, force: true });
    check("(11) removing the junction alias left the real decoy home untouched", fs.existsSync(decoyHome));
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the real prod DB refuses by default; only an explicit daemon declaration or opt-in (never a test marker) opens it."
  : `\n${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
