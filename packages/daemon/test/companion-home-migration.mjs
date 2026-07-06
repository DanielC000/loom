import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Regression lock for migrateCompanionHomeToPerSession (task e849a487, the multi-companion heartbeat
// cross-delivery fix). PRE-fix, the companion proactive HOME was a single daemon-GLOBAL app_meta key
// ("companion_home"); POST-fix it's per-session ("companion_home:<sessionId>", read by
// db.getCompanionHome(sessionId)). This one-shot migration backfills an upgraded DB's legacy value onto
// the ONE session it can be unambiguously attributed to, and drops it otherwise — cf. db-legacy-boot.mjs /
// companion-name.mjs for the house pattern: seed a pre-migration shape on a RAW better-sqlite3 connection
// (bypassing the Db class, which would only ever write the NEW per-session key), then reopen via
// `new Db(path)` to exercise the real migration path. Fully hermetic: a REAL Db on a temp LOOM_HOME, no
// network, no real claude, no daemon.
//
// Proves the migration's every branch:
//   (a) exactly ONE companion_config row + a legacy key → BACKFILLED onto that session's per-session key
//       (value preserved byte-for-byte), the legacy key is gone.
//   (b) ZERO companion_config rows + a legacy key → DROPPED (no per-session key created anywhere), legacy
//       key gone (a fresh/companion-less DB has no session to attribute it to).
//   (c) TWO companion_config rows + a legacy key → DROPPED (ambiguous attribution — reintroducing the
//       cross-delivery bug by copying it onto BOTH would be worse than losing a since-ambiguous setting),
//       legacy key gone, NEITHER session gets it.
//   (d) a corrupt/wrong-shape legacy blob → DROPPED, no throw (a malformed app_meta value must never crash
//       boot).
//   (e) idempotent: a 2nd `new Db(path)` over an already-migrated file is a clean no-op (the legacy key is
//       already gone, so the migration's own guard short-circuits with nothing to do).
// Run: 1) build (turbo builds shared first), 2) node test/companion-home-migration.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-companion-home-migration-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");

const LEGACY_KEY = "companion_home";
const dbFile = (name) => path.join(tmpHome, name);

/** Create the schema (via a real Db open/close) then seed a PRE-migration shape directly on a raw
 *  better-sqlite3 connection — company_config rows for `sessionIds`, plus the legacy global app_meta key
 *  set to `legacyValue` (a raw string — pass a non-JSON string to simulate a corrupt blob). Bypassing the
 *  Db class for the seed step means the seed can ONLY ever land the LEGACY key (Db's own setCompanionHome
 *  always writes the new per-session key), matching how a real pre-fix DB actually looked on disk. */
function seedLegacyDb(filePath, sessionIds, legacyValue) {
  const boot = new Db(filePath); // creates every table via SCHEMA (a no-op migration pass — no legacy key yet)
  boot.close();
  const raw = new Database(filePath);
  const now = "2020-01-01T00:00:00.000Z";
  for (const sid of sessionIds) {
    raw.prepare(
      `INSERT INTO companion_config (session_id, bot_token_blob, channel, allowed_chat_id, chat_scope,
         heartbeat_interval_minutes, heartbeat_prompt, enabled, provisioned, name, created_at, updated_at)
       VALUES (?, '', 'telegram', 'chat-1', 'dm', 0, NULL, 1, 0, '', ?, ?)`,
    ).run(sid, now, now);
  }
  raw.prepare(
    "INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)",
  ).run(LEGACY_KEY, legacyValue, now);
  raw.close();
}

const dbs = [];
try {
  // =================== (a) exactly ONE session → backfilled, legacy key gone ===================
  {
    const file = dbFile("a-single.db");
    const legacy = { channel: "telegram", chatId: "legacy-home" };
    seedLegacyDb(file, ["solo"], JSON.stringify(legacy));

    const db = new Db(file); dbs.push(db); // reopening runs migrateCompanionHomeToPerSession
    check("(a) the single session's home is backfilled from the legacy value", JSON.stringify(db.getCompanionHome("solo")) === JSON.stringify(legacy));
    check("(a) the legacy global key is gone after migration", db.getMeta(LEGACY_KEY) === undefined);
  }

  // =================== (b) ZERO sessions → dropped, no per-session key anywhere ===================
  {
    const file = dbFile("b-zero.db");
    seedLegacyDb(file, [], JSON.stringify({ channel: "telegram", chatId: "orphan-home" }));

    const db = new Db(file); dbs.push(db);
    check("(b) with no companion_config rows, the legacy value is dropped (unattributable)", db.getCompanionHome("anyone") === null);
    check("(b) the legacy global key is gone", db.getMeta(LEGACY_KEY) === undefined);
  }

  // =================== (c) TWO sessions → ambiguous, dropped for BOTH ===================
  {
    const file = dbFile("c-two.db");
    seedLegacyDb(file, ["A", "B"], JSON.stringify({ channel: "telegram", chatId: "ambiguous-home" }));

    const db = new Db(file); dbs.push(db);
    check("(c) with two companion_config rows, neither session inherits the ambiguous legacy value (A)", db.getCompanionHome("A") === null);
    check("(c) with two companion_config rows, neither session inherits the ambiguous legacy value (B)", db.getCompanionHome("B") === null);
    check("(c) the legacy global key is gone even though it was dropped, not backfilled", db.getMeta(LEGACY_KEY) === undefined);
  }

  // =================== (d) corrupt/wrong-shape legacy blob → dropped, never throws ===================
  {
    const file = dbFile("d-corrupt.db");
    seedLegacyDb(file, ["solo-corrupt"], "not-json-at-all{{{");

    let threw = false, db;
    try { db = new Db(file); dbs.push(db); } catch { threw = true; }
    check("(d) a corrupt legacy blob never crashes boot", threw === false);
    check("(d) a corrupt legacy blob is dropped, not backfilled", db.getCompanionHome("solo-corrupt") === null);
    check("(d) the corrupt legacy key is still cleaned up", db.getMeta(LEGACY_KEY) === undefined);

    // A wrong-SHAPE (valid JSON, but missing channel/chatId) blob behaves the same way.
    const file2 = dbFile("d-wrong-shape.db");
    seedLegacyDb(file2, ["solo-shape"], JSON.stringify({ notChannel: "x" }));
    const db2 = new Db(file2); dbs.push(db2);
    check("(d) a wrong-shape (valid JSON, missing fields) legacy blob is dropped, not backfilled", db2.getCompanionHome("solo-shape") === null);
    check("(d) the wrong-shape legacy key is cleaned up", db2.getMeta(LEGACY_KEY) === undefined);
  }

  // =================== (e) idempotent: re-opening an already-migrated file is a clean no-op ===================
  {
    const file = dbFile("e-idempotent.db");
    const legacy = { channel: "telegram", chatId: "stable-home" };
    seedLegacyDb(file, ["stable"], JSON.stringify(legacy));

    const db1 = new Db(file); dbs.push(db1); // 1st open: migrates
    check("(e) 1st open backfills as expected", JSON.stringify(db1.getCompanionHome("stable")) === JSON.stringify(legacy));

    const db2 = new Db(file); dbs.push(db2); // 2nd open: legacy key already gone — nothing to (re-)do
    check("(e) 2nd open is idempotent: the per-session home is UNCHANGED", JSON.stringify(db2.getCompanionHome("stable")) === JSON.stringify(legacy));
    check("(e) 2nd open never resurrects the legacy key", db2.getMeta(LEGACY_KEY) === undefined);
  }
} finally {
  for (const db of dbs) { try { db.close(); } catch { /* ignore */ } }
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — migrateCompanionHomeToPerSession backfills the legacy daemon-GLOBAL companion_home value onto the ONE pre-existing companion session when attribution is unambiguous, drops it (never throwing, even on a corrupt/wrong-shape blob) when there are zero or several sessions to attribute it to, and is idempotent across repeated boots."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
