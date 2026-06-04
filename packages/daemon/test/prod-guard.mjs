// Prod-guard regression test — proves the daemon test suite REFUSES to touch prod. Hermetic +
// claude-free + network-free (sets its OWN temp LOOM_HOME; never opens prod, never hits :4317).
//
// Born from the 2026-06-04 incident: a worker ran a daemon test with no env set; it opened the prod
// db (~/.loom/loom.db) and wiped it. These assertions lock the two backstops in place:
//   (1) Db prod-guard: under a test marker (LOOM_TEST=1), `new Db(<real ~/.loom/loom.db>)` THROWS
//       *before* it ever opens the file — so even a stray default-path `new Db()` can't touch prod.
//   (2) Db still opens an ISOLATED temp db fine under the same marker (the guard is surgical).
//   (3) requireHermeticEnv({port:true}) ABORTS (exit 99) on bare env, and PASSES with a temp
//       LOOM_HOME + a non-4317 LOOM_PORT.
// Run: 1) build daemon, 2) node test/prod-guard.mjs
import "./_guard.mjs"; // arms LOOM_TEST=1 for this process
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-guard-${Date.now()}-${process.pid}`);
process.env.LOOM_PORT = "4399";
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const REAL_PROD_DB = path.join(os.homedir(), ".loom", "loom.db");
const { Db } = await import("../dist/db.js");

// (1) Opening the REAL prod db under a test marker must THROW (and never open it).
let threw = null;
try { const d = new Db(REAL_PROD_DB); d.close(); } catch (e) { threw = e; }
check("Db(prod path) under LOOM_TEST=1 throws before opening prod",
  !!threw && /refusing to open the prod DB/i.test(threw.message));

// (2) An isolated temp db opens fine under the same marker (guard is surgical, not blanket).
let opened = false;
try { const d = new Db(path.join(process.env.LOOM_HOME, "iso.db")); d.close(); opened = true; } catch { opened = false; }
check("Db(temp path) under LOOM_TEST=1 opens normally", opened);

// (3) requireHermeticEnv — exercised in child processes (it calls process.exit on failure).
const guardUrl = JSON.stringify(pathToFileURL(path.join(__dirname, "_guard.mjs")).href);
const childCode = `import(${guardUrl}).then(m => { m.requireHermeticEnv({ port: true }); console.log("HERMETIC-OK"); });`;

const bareEnv = { ...process.env };
delete bareEnv.LOOM_HOME;
delete bareEnv.LOOM_PORT;
const bare = spawnSync(process.execPath, ["--input-type=module", "-e", childCode], { env: bareEnv, encoding: "utf8" });
check("requireHermeticEnv({port:true}) aborts on bare env (exit 99)",
  bare.status === 99 && /refusing to run tests against prod/i.test(bare.stderr || ""));

const good = spawnSync(process.execPath, ["--input-type=module", "-e", childCode],
  { env: { ...process.env, LOOM_HOME: process.env.LOOM_HOME, LOOM_PORT: "4399" }, encoding: "utf8" });
check("requireHermeticEnv({port:true}) passes with temp LOOM_HOME + non-4317 LOOM_PORT",
  good.status === 0 && /HERMETIC-OK/.test(good.stdout || ""));

// Also assert LOOM_PORT==4317 is rejected even with a temp LOOM_HOME.
const prodPort = spawnSync(process.execPath, ["--input-type=module", "-e", childCode],
  { env: { ...process.env, LOOM_HOME: process.env.LOOM_HOME, LOOM_PORT: "4317" }, encoding: "utf8" });
check("requireHermeticEnv({port:true}) rejects LOOM_PORT==4317 (the prod daemon)",
  prodPort.status === 99 && /4317/.test(prodPort.stderr || ""));

try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* best-effort (WAL handle) */ }
console.log(failures === 0
  ? "\n✅ ALL PASS — the daemon test suite cannot open prod or target the prod daemon."
  : `\n${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
