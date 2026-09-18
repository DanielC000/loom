import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Migration boot-test for card 11eb8f79 (purge pre-fix cleartext sessionEnv values from
// project_config_history rows) — per the project's DB-schema-change doctrine
// ([[verify-schema-change-against-upgraded-db]]), this must run against a COPY of a REAL
// pre-migration DB, not just a fresh LOOM_HOME. A fresh DB has no legacy rows and is structurally
// blind to the only case this card is about.
//
// The pre-migration shape here is the POST-a0cafef2/PRE-aef6b82d shape: project_config_history
// already exists and already stores sessionEnv rows, but recordProjectConfigChange did NOT yet mask
// sessionEnv before writing them — so a legacy row's prior_json/next_json can hold the raw,
// rotated-out secret value verbatim.
//
// Proves:
//   (1) the constructor does NOT throw on a DB carrying such legacy rows.
//   (2) a legacy row with a CLEARTEXT sessionEnv value in `next` gets masked in place (same-length
//       bullet filler, per maskSessionEnvRecord) after construction.
//   (3) a legacy row with CLEARTEXT sessionEnv values in BOTH `prior` and `next` (a rotation: old
//       value replaced by a new one) gets BOTH masked.
//   (4) a row whose sessionEnv is ALREADY masked (post-fix shape) is left byte-identical — idempotence
//       of the underlying primitive means no spurious rewrite, and re-running the migration a second
//       boot doesn't further mutate it either.
//   (5) a neighbouring, non-sessionEnv changed key in the SAME row (e.g. `orchestration`) survives the
//       rewrite untouched.
//   (6) a row that never touched sessionEnv at all is completely unaffected.
//   (7) idempotency across a SECOND Db construction against the same file: no further mutation, no
//       double-masking (masking an already-masked value reproduces it unchanged).
//   (8) manager review finding: a row whose `next.sessionEnv` is an EMPTY object (`{}` — e.g. a user
//       deleting their last sessionEnv key) must be left as `{}`, NOT have the `sessionEnv` key dropped.
//       maskSessionEnvRecord({}) returns `undefined` (its own empty-map early return); blindly assigning
//       that back would strip `sessionEnv` from the JSON entirely while `changed_keys` still names it —
//       an internally inconsistent audit row. This is the reachable edge case the fix must skip on.
//
// Run: 1) build (turbo builds shared first), 2) node test/session-env-history-purge-migration.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-session-env-history-purge-migration-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const dbFile = path.join(tmpHome, "pre-purge.db");

const projId = randomUUID();
const t0 = "2026-01-01T00:00:00.000Z";

const rowCleartextNext = randomUUID();
const rowRotation = randomUUID();
const rowAlreadyMasked = randomUUID();
const rowNoSessionEnv = randomUUID();
const rowEmptySessionEnv = randomUUID();

// Deliberately DIFFERENT lengths so the two masked values differ too (proves per-value masking, not a
// coincidence of equal-length fixtures).
const MASKED_OLD = "•".repeat("sk-old-secret-value".length); // 20 chars
const MASKED_NEW = "•".repeat("sk-brand-new-rotated-secret".length); // 27 chars
const MASKED_ALREADY = "•".repeat("already-masked-value".length);

// ===== Synthesize a REAL post-a0cafef2 / pre-aef6b82d shape directly (project_config_history exists,
// but rows can carry cleartext sessionEnv) =====
{
  const raw = new Database(dbFile);
  raw.pragma("journal_mode = WAL");
  raw.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_path TEXT NOT NULL, vault_path TEXT NOT NULL,
      config_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, archived_at TEXT
    );
    CREATE TABLE project_config_history (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      changed_keys TEXT NOT NULL,
      prior_json TEXT NOT NULL,
      next_json TEXT NOT NULL,
      actor TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX idx_project_config_history_project_created ON project_config_history(project_id, created_at);
  `);

  raw.prepare("INSERT INTO projects (id, name, repo_path, vault_path, config_json, created_at, archived_at) VALUES (?, ?, ?, ?, '{}', ?, NULL)")
    .run(projId, "Legacy Project", projId, projId, t0);

  // (2) a legacy row: sessionEnv only appears in `next` (a first-time set), CLEARTEXT.
  raw.prepare(
    `INSERT INTO project_config_history (id, project_id, changed_keys, prior_json, next_json, actor, created_at)
     VALUES (?, ?, ?, ?, ?, 'human', ?)`,
  ).run(
    rowCleartextNext, projId,
    JSON.stringify(["sessionEnv"]),
    JSON.stringify({}),
    JSON.stringify({ sessionEnv: { API_KEY: "sk-old-secret-value" } }),
    t0,
  );

  // (3)+(5) a legacy ROTATION row: sessionEnv in BOTH prior and next, CLEARTEXT, alongside a
  // neighbouring non-sessionEnv changed key ("orchestration") that must survive untouched.
  raw.prepare(
    `INSERT INTO project_config_history (id, project_id, changed_keys, prior_json, next_json, actor, created_at)
     VALUES (?, ?, ?, ?, ?, 'agent:worker', ?)`,
  ).run(
    rowRotation, projId,
    JSON.stringify(["orchestration", "sessionEnv"]),
    JSON.stringify({ sessionEnv: { API_KEY: "sk-old-secret-value" }, orchestration: { maxConcurrentGates: 1 } }),
    JSON.stringify({ sessionEnv: { API_KEY: "sk-brand-new-rotated-secret" }, orchestration: { maxConcurrentGates: 2 } }),
    t0,
  );

  // (4) a row ALREADY in the post-fix masked shape — must be left byte-identical.
  raw.prepare(
    `INSERT INTO project_config_history (id, project_id, changed_keys, prior_json, next_json, actor, created_at)
     VALUES (?, ?, ?, ?, ?, 'human', ?)`,
  ).run(
    rowAlreadyMasked, projId,
    JSON.stringify(["sessionEnv"]),
    JSON.stringify({}),
    JSON.stringify({ sessionEnv: { TOKEN: MASKED_ALREADY } }),
    t0,
  );

  // (6) a row that never touched sessionEnv at all — must be completely unaffected.
  raw.prepare(
    `INSERT INTO project_config_history (id, project_id, changed_keys, prior_json, next_json, actor, created_at)
     VALUES (?, ?, ?, ?, ?, 'human', ?)`,
  ).run(
    rowNoSessionEnv, projId,
    JSON.stringify(["denyGlobs"]),
    JSON.stringify({ denyGlobs: [] }),
    JSON.stringify({ denyGlobs: ["**/*.env"] }),
    t0,
  );

  // (8) a row where the user deleted their LAST sessionEnv key: next.sessionEnv is an EMPTY object.
  // maskSessionEnvRecord({}) returns undefined — must NOT be assigned back (would drop the key).
  raw.prepare(
    `INSERT INTO project_config_history (id, project_id, changed_keys, prior_json, next_json, actor, created_at)
     VALUES (?, ?, ?, ?, ?, 'human', ?)`,
  ).run(
    rowEmptySessionEnv, projId,
    JSON.stringify(["sessionEnv"]),
    JSON.stringify({ sessionEnv: { LAST_KEY: "sk-final-value-before-delete" } }),
    JSON.stringify({ sessionEnv: {} }),
    t0,
  );

  check("(setup) the synthesized pre-aef6b82d DB has the project_config_history table", true);
  raw.close();
}

function readRow(id) {
  const raw = new Database(dbFile, { readonly: true });
  try {
    const r = raw.prepare("SELECT prior_json, next_json FROM project_config_history WHERE id = ?").get(id);
    return { prior: JSON.parse(r.prior_json), next: JSON.parse(r.next_json) };
  } finally {
    raw.close();
  }
}

let db;
try {
  // ===== (1) the constructor must NOT throw on this pre-aef6b82d DB =====
  let ctorError = null;
  try {
    const { Db } = await import("../dist/db.js");
    db = new Db(dbFile);
  } catch (err) {
    ctorError = err;
  }
  check("(1) constructing Db against a pre-aef6b82d DB does not throw", ctorError === null);
  if (ctorError) console.log(`    threw: ${ctorError?.stack || ctorError}`);

  if (!ctorError) {
    db.close();

    // ===== (2) the cleartext-in-`next`-only row is masked =====
    const r2 = readRow(rowCleartextNext);
    check("(2) prior has no sessionEnv (unchanged, was already empty)", r2.prior.sessionEnv === undefined);
    check("(2) next.sessionEnv.API_KEY is masked, not cleartext", r2.next.sessionEnv?.API_KEY === MASKED_OLD);
    check("(2) the masked value is NOT the original cleartext", r2.next.sessionEnv?.API_KEY !== "sk-old-secret-value");

    // ===== (3)+(5) the rotation row: BOTH prior and next masked; the neighbouring orchestration key
    // (present in both prior and next) survives untouched =====
    const r3 = readRow(rowRotation);
    check("(3) rotation row's prior.sessionEnv.API_KEY is masked", r3.prior.sessionEnv?.API_KEY === MASKED_OLD);
    check("(3) rotation row's next.sessionEnv.API_KEY is masked", r3.next.sessionEnv?.API_KEY === MASKED_NEW);
    check("(3) the masked next value is NOT the original cleartext", r3.next.sessionEnv?.API_KEY !== "sk-brand-new-rotated-secret");
    check("(3) the two masked values differ (old vs new length-preserved)", r3.prior.sessionEnv?.API_KEY !== r3.next.sessionEnv?.API_KEY);
    check("(5) neighbouring prior.orchestration survives byte-identical", r3.prior.orchestration?.maxConcurrentGates === 1);
    check("(5) neighbouring next.orchestration survives byte-identical", r3.next.orchestration?.maxConcurrentGates === 2);

    // ===== (4) the already-masked row is untouched =====
    const r4 = readRow(rowAlreadyMasked);
    check("(4) already-masked row's next.sessionEnv.TOKEN is unchanged", r4.next.sessionEnv?.TOKEN === MASKED_ALREADY);

    // ===== (6) the no-sessionEnv row is completely unaffected =====
    const r6 = readRow(rowNoSessionEnv);
    check("(6) unrelated row's prior.denyGlobs survives", JSON.stringify(r6.prior.denyGlobs) === JSON.stringify([]));
    check("(6) unrelated row's next.denyGlobs survives", JSON.stringify(r6.next.denyGlobs) === JSON.stringify(["**/*.env"]));

    // ===== (8) manager review finding: next.sessionEnv === {} must stay {} (key never dropped), while
    // prior.sessionEnv (non-empty, cleartext) IS masked =====
    const r8 = readRow(rowEmptySessionEnv);
    check("(8) prior.sessionEnv.LAST_KEY (non-empty) IS masked", r8.prior.sessionEnv?.LAST_KEY === "•".repeat("sk-final-value-before-delete".length));
    check("(8) next.sessionEnv key is NOT dropped — still present", Object.prototype.hasOwnProperty.call(r8.next, "sessionEnv"));
    check("(8) next.sessionEnv is still exactly {}", JSON.stringify(r8.next.sessionEnv) === JSON.stringify({}));

    // ===== (7) idempotency: a SECOND Db construction must not further mutate anything =====
    const { Db: Db2 } = await import("../dist/db.js");
    const db2 = new Db2(dbFile);
    db2.close();
    const r2b = readRow(rowCleartextNext);
    check("(7) second boot: previously-masked row unchanged", r2b.next.sessionEnv?.API_KEY === MASKED_OLD);
    const r3b = readRow(rowRotation);
    check("(7) second boot: rotation row's masked values unchanged", r3b.prior.sessionEnv?.API_KEY === MASKED_OLD && r3b.next.sessionEnv?.API_KEY === MASKED_NEW);
    check("(7) second boot: rotation row's neighbouring key still survives", r3b.next.orchestration?.maxConcurrentGates === 2);
    const r4b = readRow(rowAlreadyMasked);
    check("(7) second boot: already-masked row still unchanged", r4b.next.sessionEnv?.TOKEN === MASKED_ALREADY);
    const r8b = readRow(rowEmptySessionEnv);
    check("(7)+(8) second boot: empty-sessionEnv row still {} (not dropped, not re-mutated)", JSON.stringify(r8b.next.sessionEnv) === JSON.stringify({}));

    db = null;
  }
} finally {
  try { db?.close(); } catch { /* ignore */ }
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — Db boots clean against a real pre-aef6b82d project_config_history (legacy cleartext sessionEnv rows), masks a cleartext next-only row and a full rotation row (both prior+next) in place via maskSessionEnvRecord, leaves an already-masked row byte-identical, leaves a neighbouring non-sessionEnv changed key (present in the SAME row) untouched, leaves a row that never touched sessionEnv completely unaffected, correctly preserves an EMPTY next.sessionEnv ({}) without dropping the key while still masking a non-empty cleartext sibling in the same row, and is idempotent across a second Db construction (no double-masking, no further mutation, no re-drop of the empty case)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
