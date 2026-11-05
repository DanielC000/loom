import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 2ef54430 — schema-upgrade guard for the two new `codex_provider` columns (profiles + sessions). Same
// discipline as cut-base-sha-migration.mjs: a migrate*()-added column is the class that shipped a real P0 boot
// crash when only tested against a FRESH DB (`CREATE TABLE IF NOT EXISTS` no-ops on an old-shaped table).
//
// SYNTHETIC fixture only — a blank temp DB holding hand-derived `profiles`/`sessions` tables whose CREATE TABLE SQL
// is read off a reference DB's own sqlite_master with just the codex_provider column line stripped. Never opens or
// copies the real ~/.loom DB.
//
// Proves:
//   (1) the constructor does NOT throw opening a DB that predates both columns.
//   (2) both columns exist post-open (PRAGMA table_info), and a pre-existing profile + session row survive
//       with the new field reading back absent (no endpoint), not a crash.
//   (3) a fresh profile + session on the migrated DB round-trips a real codexProvider.
//   (4) a third open is idempotent (each column exactly once).
//   (5) statement-scoped: no CREATE INDEX/TRIGGER/VIEW in db.ts's SCHEMA text references codex_provider.
//
// Run: 1) build, 2) node test/codex-provider-migration.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-cpm-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");

const now = new Date().toISOString();
const PROVIDER = { id: "myhost", baseUrl: "https://api.example.com/v1", connectionId: "conn-1" };

// ===== Derive the REAL CREATE TABLE SQL from a reference DB, then strip ONLY the codex_provider line =====
const refFile = path.join(tmpHome, "ref.db");
let projectsSql, agentsSql, profilesReal, sessionsReal;
{
  const refDb = new Db(refFile);
  refDb.close();
  const refRaw = new Database(refFile, { readonly: true });
  const sqlOf = (t) => refRaw.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(t).sql;
  projectsSql = sqlOf("projects"); agentsSql = sqlOf("agents"); profilesReal = sqlOf("profiles"); sessionsReal = sqlOf("sessions");
  refRaw.close();
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(refFile + ext, { force: true }); } catch { /* ignore */ } }
}
// Strip every line that mentions the column; the column's neighbour may be a comma-led migrated column or `)`, so
// also drop the comma left dangling in front of a following `,` / `)`.
const strip = (sql) => sql.replace(/[^\n]*codex_provider[^\n]*\n/g, "").replace(/,((?:[ \t]*\r?\n)*(?:[ \t]*--[^\n]*\n)*[ \t]*\r?\n?[ \t]*)(?=[,)])/g, "$1");
const profilesLegacy = strip(profilesReal);
const sessionsLegacy = strip(sessionsReal);
check("(setup) the real schema HAS codex_provider on both tables before stripping", profilesReal.includes("codex_provider") && sessionsReal.includes("codex_provider"));
check("(setup) the stripped SQL no longer mentions the column on either table", !profilesLegacy.includes("codex_provider") && !sessionsLegacy.includes("codex_provider"));
check("(setup) NEGATIVE CONTROL: stripping a bogus column name removes nothing", profilesReal.replace(/[^\n]*zz_no_such_col[^\n]*\n/g, "") === profilesReal);

const dbFile = path.join(tmpHome, "cpm.db");
const legacySessionId = "legacy-cpm-session";
const legacyProfileId = "legacy-cpm-profile";
{
  const raw = new Database(dbFile);
  raw.pragma("foreign_keys = OFF");
  raw.exec(`${projectsSql};\n${agentsSql};\n${profilesLegacy};\n${sessionsLegacy}`);
  const has = (t, c) => raw.prepare(`PRAGMA table_info(${t})`).all().some((x) => x.name === c);
  check("(precondition) legacy DB has NEITHER profiles.codex_provider NOR sessions.codex_provider", !has("profiles", "codex_provider") && !has("sessions", "codex_provider"));
  check("(precondition) legacy profiles still has its older sibling `harness` column", has("profiles", "harness"));

  const fillRequired = (tableName, id, extra = {}) => {
    const reqCols = raw.prepare(`PRAGMA table_info(${tableName})`).all()
      .filter((c) => c.notnull === 1 && c.dflt_value === null && c.name !== "id").map((c) => c.name);
    const vals = reqCols.map((c) => (c in extra ? extra[c] : /_at$/.test(c) ? now : `cpm-${c}`));
    raw.prepare(`INSERT INTO ${tableName} (id, ${reqCols.join(",")}) VALUES (?, ${reqCols.map(() => "?").join(",")})`).run(id, ...vals);
  };
  fillRequired("projects", "cpm");
  fillRequired("agents", "cpm");
  fillRequired("profiles", legacyProfileId, { role: "worker" });
  fillRequired("sessions", legacySessionId, { project_id: "cpm", agent_id: "cpm", cwd: "/host/cpm", role: "worker" });
  check("(precondition) legacy profile + session rows landed", raw.prepare("SELECT count(*) AS c FROM profiles").get().c === 1 && raw.prepare("SELECT count(*) AS c FROM sessions").get().c === 1);
  raw.close();
}

// ===== (1)/(2) reopen with the real Db =====
{
  let db; let threw = null;
  try { db = new Db(dbFile); } catch (e) { threw = e; }
  check("(1) opening a pre-migration DB does NOT throw", threw === null);

  const raw = new Database(dbFile, { readonly: true });
  const has = (t, c) => raw.prepare(`PRAGMA table_info(${t})`).all().some((x) => x.name === c);
  check("(2) profiles.codex_provider exists post-migration", has("profiles", "codex_provider"));
  check("(2) sessions.codex_provider exists post-migration", has("sessions", "codex_provider"));
  raw.close();

  const legacyProfile = db.getProfile(legacyProfileId);
  check("(2) the legacy profile survived and reads back with NO codexProvider", legacyProfile?.id === legacyProfileId && !legacyProfile.codexProvider);
  const legacySession = db.getSession(legacySessionId);
  check("(2) the legacy session survived and reads back with NO codexProvider", legacySession?.id === legacySessionId && !legacySession.codexProvider);

  // ===== (3) fresh writes round-trip =====
  db.insertProfile({ id: "fresh-cpm-profile", name: "fresh", role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null, harness: "codex", codexProvider: PROVIDER });
  const fp = db.getProfile("fresh-cpm-profile");
  check("(3) a fresh profile's codexProvider round-trips", JSON.stringify(fp?.codexProvider) === JSON.stringify(PROVIDER));
  db.insertSession({
    id: "fresh-cpm-session", projectId: "cpm", agentId: "cpm", engineSessionId: null, title: null, cwd: "/host/cpm2",
    processState: "starting", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
    role: "worker", harness: "codex", codexProvider: PROVIDER,
  });
  check("(3) a fresh session's codexProvider round-trips", JSON.stringify(db.getSession("fresh-cpm-session")?.codexProvider) === JSON.stringify(PROVIDER));
  db.close();
}

// ===== (4) idempotent third open =====
{
  let threw = null; let db;
  try { db = new Db(dbFile); } catch (e) { threw = e; }
  check("(4) a further re-open is idempotent — does not throw", threw === null);
  db.close();
  const raw = new Database(dbFile, { readonly: true });
  const count = (t) => raw.prepare(`PRAGMA table_info(${t})`).all().filter((c) => c.name === "codex_provider").length;
  check("(4) each column is there EXACTLY once", count("profiles") === 1 && count("sessions") === 1);
  raw.close();
}

// ===== (5) statement-scoped static guard =====
{
  const dbTsPath = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "src", "db.ts");
  const src = fs.readFileSync(dbTsPath, "utf8");
  const startMarker = "const SCHEMA = `";
  const startIdx = src.indexOf(startMarker);
  check("(5) sanity: the SCHEMA template literal's start marker was found", startIdx !== -1);
  const schemaStart = startIdx + startMarker.length;
  const schemaEnd = src.indexOf("`;", schemaStart);
  check("(5) sanity: the SCHEMA template literal's closing marker was found", schemaEnd !== -1);
  const ddl = src.slice(schemaStart, schemaEnd).split(";").filter((s) => /CREATE\s+(UNIQUE\s+)?(INDEX|TRIGGER|VIEW)\b/i.test(s));
  check("(5) negative control: the scan finds real CREATE INDEX/TRIGGER/VIEW statements", ddl.length > 0);
  check("(5) NO CREATE INDEX/TRIGGER/VIEW statement references codex_provider", ddl.filter((s) => s.includes("codex_provider")).length === 0);
}

cleanupPathSync(tmpHome);

console.log(failures === 0
  ? "\n✅ ALL PASS — both codex_provider columns migrate additively onto a synthetic pre-card profiles/sessions fixture (existing rows read back, fresh writes round-trip, re-open idempotent, no SCHEMA index references them)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
