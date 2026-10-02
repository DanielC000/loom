import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Migration boot-test for card 5a5d7312 (purge pre-fix cleartext `orchestration.alertWebhook.url`
// values from project_config_history rows) — per the project's DB-schema-change doctrine
// ([[verify-schema-change-against-upgraded-db]]), this must run against a COPY of a REAL
// pre-migration DB, not just a fresh LOOM_HOME. A fresh DB has no legacy rows and is structurally
// blind to the only case this card is about. (A boot-test against an actual copy of this project's
// real production ~/.loom/loom.db was ALSO run by hand for this card — see the worker_report for the
// before/after row counts; that real DB has 0 rows that ever set alertWebhook.url at all, so it boots
// clean and loses no rows, but it is structurally blind to the masking transform itself, which is why
// this synthesized-legacy-shape test exists to prove that half.)
//
// The pre-migration shape here is the shape BEFORE card 5a5d7312: project_config_history already
// exists and already stores `orchestration` rows (including `alertWebhook.url`), but
// `recordProjectConfigChange` did NOT yet mask that leaf before writing — so a legacy row's
// prior_json/next_json can hold the raw, rotated-out webhook URL verbatim. One row also simulates the
// round-1 (eccd874c) mask shape, which kept the HOST (`<scheme>//<host>/***`) rather than round 2's
// scheme-only form (`<scheme>//***`) — the migration must converge that to the CURRENT mask too, not
// just a bare cleartext value.
//
// Proves:
//   (1) the constructor does NOT throw on a DB carrying such legacy rows.
//   (2) a legacy row with a CLEARTEXT alertWebhook.url in `next` gets masked to `<scheme>//***` after
//       construction.
//   (3) a legacy row with CLEARTEXT urls in BOTH `prior` and `next` (a rotation: old url replaced by a
//       new one, different schemes so the masked forms are distinguishable) gets BOTH masked, while a
//       neighbouring orchestration field (gateCommand) in the SAME nested object survives untouched.
//   (4) a row whose url is ALREADY in the current round-2 masked form is left byte-identical —
//       idempotence of the underlying primitive means no spurious rewrite.
//   (4b) a row whose url is in the OLDER round-1 masked form (host preserved) gets CONVERGED to the
//        current round-2 form — a legacy row isn't just "cleartext or not", it can also predate a later
//        mask-strength tightening.
//   (5) a neighbouring, non-orchestration changed key in the SAME row (`sessionEnv`) is independently
//       masked by its OWN sibling migration (card 11eb8f79) — undisturbed, neither skipped nor
//       double-masked, by this card's alertWebhook fix running in the same boot.
//   (6) a row that never touched `orchestration` at all is completely unaffected.
//   (7) idempotency across a SECOND Db construction against the same file: no further mutation.
//   (8) a row whose `orchestration` changed but carries NO `alertWebhook` key at all (e.g. only
//       `gateCommand` changed) is left completely untouched — the migration must not synthesize or
//       disturb a field that was never there.
//   (9) a row whose `alertWebhook.url` is an empty string (corrupt/legacy edge data) is left as-is,
//       mirroring `redactAlertWebhookInConfig`'s own `!url` early return — never crashes, never masks
//       an empty string into something else.
//
// Run: 1) build (turbo builds shared first), 2) node test/alertwebhook-history-purge-migration.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-alertwebhook-history-purge-migration-${Date.now()}-${process.pid}`);
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
const rowRound1Masked = randomUUID();
const rowNoAlertWebhook = randomUUID();
const rowNoOrchestration = randomUUID();
const rowEmptyUrl = randomUUID();

const CLEARTEXT_NEXT_URL = "https://hooks.example.com/services/T000/B111/leaked-secret-xyz789";
const MASKED_NEXT = "https://***";
const OLD_CLEARTEXT = "http://old.example.com/old-token-bbb"; // deliberately http:// so its mask differs from the https:// one below
const NEW_CLEARTEXT = "https://new.example.com/new-token-ccc";
const MASKED_OLD = "http://***";
const MASKED_NEW = "https://***";
const ROUND1_MASKED = "https://hooks.example.com/***"; // round-1 (eccd874c) form: host preserved

// ===== Synthesize a REAL pre-5a5d7312 shape directly (project_config_history exists, but rows can
// carry cleartext/round-1-masked orchestration.alertWebhook.url) =====
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

  // (2) a legacy row: alertWebhook.url only appears in `next` (a first-time set), CLEARTEXT.
  raw.prepare(
    `INSERT INTO project_config_history (id, project_id, changed_keys, prior_json, next_json, actor, created_at)
     VALUES (?, ?, ?, ?, ?, 'human', ?)`,
  ).run(
    rowCleartextNext, projId,
    JSON.stringify(["orchestration"]),
    JSON.stringify({}),
    JSON.stringify({ orchestration: { alertWebhook: { url: CLEARTEXT_NEXT_URL, events: ["merge_done"] } } }),
    t0,
  );

  // (3)+(5) a legacy ROTATION row: alertWebhook.url in BOTH prior and next, CLEARTEXT, alongside a
  // neighbouring orchestration field (gateCommand) that must survive, AND a neighbouring top-level
  // changed key (sessionEnv) in the same row — which the SIBLING `migratePurgeLegacySessionEnvHistory`
  // migration independently masks (card 11eb8f79); distinct lengths here prove the two migrations don't
  // interfere with each other rather than claiming sessionEnv stays raw, which it deliberately does not.
  raw.prepare(
    `INSERT INTO project_config_history (id, project_id, changed_keys, prior_json, next_json, actor, created_at)
     VALUES (?, ?, ?, ?, ?, 'agent:worker', ?)`,
  ).run(
    rowRotation, projId,
    JSON.stringify(["orchestration", "sessionEnv"]),
    JSON.stringify({ orchestration: { alertWebhook: { url: OLD_CLEARTEXT, events: ["merge_done"] }, gateCommand: "npm test" }, sessionEnv: { A: "aa" } }),
    JSON.stringify({ orchestration: { alertWebhook: { url: NEW_CLEARTEXT, events: ["merge_rejected"] }, gateCommand: "pnpm test" }, sessionEnv: { A: "bbb" } }),
    t0,
  );

  // (4) a row ALREADY in the current round-2 masked shape — must be left byte-identical.
  raw.prepare(
    `INSERT INTO project_config_history (id, project_id, changed_keys, prior_json, next_json, actor, created_at)
     VALUES (?, ?, ?, ?, ?, 'human', ?)`,
  ).run(
    rowAlreadyMasked, projId,
    JSON.stringify(["orchestration"]),
    JSON.stringify({}),
    JSON.stringify({ orchestration: { alertWebhook: { url: MASKED_NEXT, events: [] } } }),
    t0,
  );

  // (4b) a row in the OLDER round-1 (eccd874c) masked shape — host preserved — must CONVERGE to round 2.
  raw.prepare(
    `INSERT INTO project_config_history (id, project_id, changed_keys, prior_json, next_json, actor, created_at)
     VALUES (?, ?, ?, ?, ?, 'human', ?)`,
  ).run(
    rowRound1Masked, projId,
    JSON.stringify(["orchestration"]),
    JSON.stringify({}),
    JSON.stringify({ orchestration: { alertWebhook: { url: ROUND1_MASKED, events: [] } } }),
    t0,
  );

  // (8) a row whose orchestration changed but has NO alertWebhook key at all — must be untouched.
  raw.prepare(
    `INSERT INTO project_config_history (id, project_id, changed_keys, prior_json, next_json, actor, created_at)
     VALUES (?, ?, ?, ?, ?, 'human', ?)`,
  ).run(
    rowNoAlertWebhook, projId,
    JSON.stringify(["orchestration"]),
    JSON.stringify({ orchestration: { gateCommand: "npm test" } }),
    JSON.stringify({ orchestration: { gateCommand: "pnpm test" } }),
    t0,
  );

  // (6) a row that never touched orchestration at all — must be completely unaffected.
  raw.prepare(
    `INSERT INTO project_config_history (id, project_id, changed_keys, prior_json, next_json, actor, created_at)
     VALUES (?, ?, ?, ?, ?, 'human', ?)`,
  ).run(
    rowNoOrchestration, projId,
    JSON.stringify(["denyGlobs"]),
    JSON.stringify({ denyGlobs: [] }),
    JSON.stringify({ denyGlobs: ["**/*.env"] }),
    t0,
  );

  // (9) a row whose alertWebhook.url is an EMPTY STRING (corrupt/legacy edge data) — must be left as-is.
  raw.prepare(
    `INSERT INTO project_config_history (id, project_id, changed_keys, prior_json, next_json, actor, created_at)
     VALUES (?, ?, ?, ?, ?, 'human', ?)`,
  ).run(
    rowEmptyUrl, projId,
    JSON.stringify(["orchestration"]),
    JSON.stringify({}),
    JSON.stringify({ orchestration: { alertWebhook: { url: "", events: [] } } }),
    t0,
  );

  check("(setup) the synthesized pre-5a5d7312 DB has the project_config_history table", true);
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
  // ===== (1) the constructor must NOT throw on this pre-5a5d7312 DB =====
  let ctorError = null;
  try {
    const { Db } = await import("../dist/db.js");
    db = new Db(dbFile);
  } catch (err) {
    ctorError = err;
  }
  check("(1) constructing Db against a pre-5a5d7312 DB does not throw", ctorError === null);
  if (ctorError) console.log(`    threw: ${ctorError?.stack || ctorError}`);

  if (!ctorError) {
    db.close();

    // ===== (2) the cleartext-in-`next`-only row is masked =====
    const r2 = readRow(rowCleartextNext);
    check("(2) prior has no orchestration (unchanged, was already empty)", r2.prior.orchestration === undefined);
    check("(2) next.orchestration.alertWebhook.url is masked, not cleartext", r2.next.orchestration?.alertWebhook?.url === MASKED_NEXT);
    check("(2) the masked value is NOT the original cleartext", r2.next.orchestration?.alertWebhook?.url !== CLEARTEXT_NEXT_URL);
    check("(2) the sibling `events` array survives", JSON.stringify(r2.next.orchestration?.alertWebhook?.events) === JSON.stringify(["merge_done"]));

    // ===== (3)+(5) the rotation row: BOTH prior and next masked (distinguishably); the neighbouring
    // orchestration.gateCommand survives, and the neighbouring TOP-LEVEL sessionEnv key survives =====
    const r3 = readRow(rowRotation);
    check("(3) rotation row's prior url is masked", r3.prior.orchestration?.alertWebhook?.url === MASKED_OLD);
    check("(3) rotation row's next url is masked", r3.next.orchestration?.alertWebhook?.url === MASKED_NEW);
    check("(3) the masked next value is NOT the original cleartext", r3.next.orchestration?.alertWebhook?.url !== NEW_CLEARTEXT);
    check("(3) the two masked values differ (distinguishable old vs new)", r3.prior.orchestration?.alertWebhook?.url !== r3.next.orchestration?.alertWebhook?.url);
    check("(5) neighbouring prior.orchestration.gateCommand survives byte-identical", r3.prior.orchestration?.gateCommand === "npm test");
    check("(5) neighbouring next.orchestration.gateCommand survives byte-identical", r3.next.orchestration?.gateCommand === "pnpm test");
    // sessionEnv is masked by the SIBLING migration (card 11eb8f79), independently of this card's fix —
    // this proves the two migrations coexist on the same row without interfering with each other.
    check("(5) neighbouring TOP-LEVEL sessionEnv (prior) is masked by its own sibling migration, undisturbed by this one", r3.prior.sessionEnv?.A === "•".repeat(2));
    check("(5) neighbouring TOP-LEVEL sessionEnv (next) is masked by its own sibling migration, undisturbed by this one", r3.next.sessionEnv?.A === "•".repeat(3));
    check("(3) the rotation row's events arrays also survive per-side", r3.prior.orchestration?.alertWebhook?.events?.[0] === "merge_done" && r3.next.orchestration?.alertWebhook?.events?.[0] === "merge_rejected");

    // ===== (4) the already-round-2-masked row is untouched =====
    const r4 = readRow(rowAlreadyMasked);
    check("(4) already-masked row's url is unchanged", r4.next.orchestration?.alertWebhook?.url === MASKED_NEXT);

    // ===== (4b) the round-1-masked row CONVERGES to the round-2 form =====
    const r4b = readRow(rowRound1Masked);
    check("(4b) round-1-masked url converges to round-2 form", r4b.next.orchestration?.alertWebhook?.url === MASKED_NEXT);
    check("(4b) the converged value is not the stale round-1 form", r4b.next.orchestration?.alertWebhook?.url !== ROUND1_MASKED);

    // ===== (8) a row with orchestration changed but no alertWebhook key is untouched =====
    const r8 = readRow(rowNoAlertWebhook);
    check("(8) no-alertWebhook row's prior.gateCommand survives", r8.prior.orchestration?.gateCommand === "npm test");
    check("(8) no-alertWebhook row's next.gateCommand survives", r8.next.orchestration?.gateCommand === "pnpm test");
    check("(8) no-alertWebhook row never gained an alertWebhook key", !("alertWebhook" in (r8.next.orchestration ?? {})));

    // ===== (6) the no-orchestration row is completely unaffected =====
    const r6 = readRow(rowNoOrchestration);
    check("(6) unrelated row's prior.denyGlobs survives", JSON.stringify(r6.prior.denyGlobs) === JSON.stringify([]));
    check("(6) unrelated row's next.denyGlobs survives", JSON.stringify(r6.next.denyGlobs) === JSON.stringify(["**/*.env"]));

    // ===== (9) the empty-url row is left as-is (never crashes, never mutates an empty string) =====
    const r9 = readRow(rowEmptyUrl);
    check("(9) empty-url row's url stays an empty string (not masked into '***' or similar)", r9.next.orchestration?.alertWebhook?.url === "");

    // ===== (7) idempotency: a SECOND Db construction must not further mutate anything =====
    const { Db: Db2 } = await import("../dist/db.js");
    const db2 = new Db2(dbFile);
    db2.close();
    const r2b = readRow(rowCleartextNext);
    check("(7) second boot: previously-masked row unchanged", r2b.next.orchestration?.alertWebhook?.url === MASKED_NEXT);
    const r3b = readRow(rowRotation);
    check("(7) second boot: rotation row's masked values unchanged", r3b.prior.orchestration?.alertWebhook?.url === MASKED_OLD && r3b.next.orchestration?.alertWebhook?.url === MASKED_NEW);
    check("(7) second boot: rotation row's neighbouring gateCommand still survives", r3b.next.orchestration?.gateCommand === "pnpm test");
    const r4b2 = readRow(rowRound1Masked);
    check("(7) second boot: converged round-1 row still converged, not re-mutated", r4b2.next.orchestration?.alertWebhook?.url === MASKED_NEXT);
    const r9b = readRow(rowEmptyUrl);
    check("(7)+(9) second boot: empty-url row still empty string", r9b.next.orchestration?.alertWebhook?.url === "");

    db = null;
  }
} finally {
  try { db?.close(); } catch { /* ignore */ }
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — Db boots clean against a real pre-5a5d7312 project_config_history (legacy cleartext and round-1-masked orchestration.alertWebhook.url rows), masks a cleartext next-only row and a full rotation row (both prior+next, distinguishably) in place via redactAlertWebhookInConfig, converges a stale round-1-masked row to the current round-2 form, leaves an already-round-2-masked row byte-identical, leaves neighbouring orchestration fields (gateCommand) untouched and coexists cleanly with the sibling sessionEnv migration acting on the SAME row, leaves a row with no alertWebhook key and a row that never touched orchestration completely unaffected, never crashes or mutates a corrupt empty-string url, and is idempotent across a second Db construction."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
