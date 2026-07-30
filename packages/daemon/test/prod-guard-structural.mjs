// Structural prod-guard regression test — card eb29e410. `prod-guard.mjs` already proves the Db
// guard fires WHEN LOOM_TEST=1 is already set. This test proves the gap that card closes: the
// 2026-06-04 incident ran with NO env set at ALL, so `inTestMode()` alone (LOOM_TEST/NODE_ENV=test)
// would have said no — the guard back then only helped a test that already remembered to arm it.
//
// `db.ts`'s `looksLikeDirectTestInvocation()` (added by this card) detects "this process's own entry
// script resolves inside packages/daemon/test/" from `process.argv[1]` alone, independent of any env
// var — so it fires even for a completely bare `node test/<file>.mjs` invocation. These are the
// controls for that fix, run via REAL child processes (never in-process) so the env each one sees is
// exactly what a bare `node test/<file>.mjs` run would see:
//
//   (A) POSITIVE CONTROL — a `new Db()` fixture, invoked bare (no LOOM_TEST/LOOM_HOME/LOOM_PORT) with
//       its entry INSIDE test/, must ABORT before ever opening a db file.
//   (B) NEGATIVE CONTROL — the exact same fixture, invoked bare, with its entry OUTSIDE test/ (the
//       production-boot shape: no test marker, not under test/) must OPEN NORMALLY — proving the fix
//       does not touch the real daemon's own boot path.
//   (C) SURGICAL CHECK — the fixture invoked from INSIDE test/ again, but this time with a properly
//       isolated LOOM_HOME, must also OPEN NORMALLY — proving the structural check only blocks the
//       real prod path, not every invocation from inside test/.
//
// Every case runs against a disposable decoy HOME/USERPROFILE, never the real developer's ~/.loom —
// so even a guard FAILURE here would only create a throwaway db under a decoy, never touch prod.
// Run: 1) build daemon, 2) node test/prod-guard-structural.mjs
import "./_guard.mjs"; // arms LOOM_TEST=1 for THIS orchestrating process (belt-and-suspenders)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-guard-structural-${Date.now()}-${process.pid}`);
process.env.LOOM_PORT = "4398";
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const dbModulePath = path.join(__dirname, "..", "dist", "db.js");
const fixtureInsideTestDir = path.join(__dirname, "fixtures", "_bare-default-db-open.mjs");

function makeDecoyHome(withLoomDir) {
  const home = mkdtempManaged("loom-guard-decoy-");
  if (withLoomDir) fs.mkdirSync(path.join(home, ".loom"), { recursive: true });
  return home;
}

// A bare env: strip every marker a real bare `node test/<file>.mjs` invocation would never have set,
// then point HOME/USERPROFILE at the decoy so `os.homedir()` (and thus REAL_PROD_DB / the default
// LOOM_HOME fallback) resolves to a harmless throwaway directory instead of the real user profile.
function bareEnv(decoyHome, extra = {}) {
  const env = { ...process.env, LOOM_FIXTURE_DB_MODULE: dbModulePath };
  delete env.LOOM_TEST;
  delete env.NODE_ENV;
  delete env.LOOM_HOME;
  delete env.LOOM_PORT;
  env.HOME = decoyHome;
  env.USERPROFILE = decoyHome;
  Object.assign(env, extra); // applied LAST so e.g. an explicit LOOM_HOME override survives the deletes above
  return env;
}

// --- (A) POSITIVE CONTROL: bare invocation, entry INSIDE test/ -> must abort, must create nothing ---
// `.loom/` is pre-created (like case B) so that IF the guard failed to fire, `new Database(file)`
// would actually succeed and write a real db file here — proving the assertion below is checking the
// guard itself, not accidentally protected by a missing directory throwing its own unrelated ENOENT.
{
  const decoyHome = makeDecoyHome(true);
  const result = spawnSync(process.execPath, [fixtureInsideTestDir], { env: bareEnv(decoyHome), encoding: "utf8" });
  const dbFile = path.join(decoyHome, ".loom", "loom.db");
  check("(A) bare `node test/<file>.mjs` (entry inside test/) aborts instead of opening prod",
    result.status === 1 && /THREW:refusing to open the prod DB/.test(result.stdout || ""));
  check("(A) no db file was ever created under the decoy home", !fs.existsSync(dbFile));
}

// --- (B) NEGATIVE CONTROL: bare invocation, entry OUTSIDE test/ -> must open normally (prod-boot shape) ---
{
  const decoyHome = makeDecoyHome(true);
  const outsideCopy = path.join(mkdtempManaged("loom-guard-outside-"), "bare-default-db-open.mjs");
  fs.copyFileSync(fixtureInsideTestDir, outsideCopy);
  const result = spawnSync(process.execPath, [outsideCopy], { env: bareEnv(decoyHome), encoding: "utf8" });
  const dbFile = path.join(decoyHome, ".loom", "loom.db");
  check("(B) the SAME bare invocation, entry OUTSIDE test/, opens normally (no test marker, not under test/)",
    result.status === 0 && /^OPENED/m.test(result.stdout || ""));
  check("(B) a real db file WAS created (proves the production-boot path is unaffected by this fix)",
    fs.existsSync(dbFile));
}

// --- (C) SURGICAL CHECK: entry INSIDE test/ again, but properly isolated (own LOOM_HOME) -> opens fine ---
{
  const isolatedHome = makeDecoyHome(false);
  const result = spawnSync(process.execPath, [fixtureInsideTestDir], {
    env: bareEnv(makeDecoyHome(false), { LOOM_HOME: isolatedHome }),
    encoding: "utf8",
  });
  check("(C) entry inside test/ WITH its own isolated LOOM_HOME still opens fine (guard is surgical)",
    result.status === 0 && /^OPENED/m.test(result.stdout || ""));
}

// process.env.LOOM_HOME is a manually-named dir (not one of the mkdtempManaged sites above), so its
// cleanup stays a separate best-effort call rather than going through the registry.
try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* best-effort */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — a completely bare `node test/*.mjs` invocation (no env at all) can no longer open prod; the real (non-test) boot path is unaffected."
  : `\n${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
