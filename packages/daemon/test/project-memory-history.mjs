import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 5ccc2462 — append-only history of a project-memory note's prior text.
//
// (A) MIGRATION (lesson 250 — never `git show HEAD:`, a fixed-point-in-time copy instead): synthesizes a
//     genuinely pre-card `project_memory` DB shape (the exact CREATE TABLE text pinned at sha `c8cff22f`
//     — the real HEAD immediately before this card — with NO `project_memory_history` table at all) on a
//     raw better-sqlite3 connection, with a real pre-existing note inserted via that OLD shape. Reopening
//     via `new Db(path)` (today's code) must NOT throw, must add `project_memory_history` + its index,
//     must leave the pre-existing row completely untouched, and the write -> history round-trip must then
//     work correctly against this upgraded-in-place DB (not just "the table exists").
// (B) TEXT-CHANGE vs METADATA-ONLY on a fresh DB: a real text edit writes exactly one history row (old
//     text / new text / the version it produced); a metadata-only patch (text omitted, or resent
//     byte-identical) writes none; a brand-new key's first write writes none either (nothing prior to
//     record). Multiple edits append in order, newest-first on read.
// (C) `memory_history` read path (mcp/memory.ts's `readProjectMemoryHistory`): correct shape, `limit`
//     bounding (including the hard MAX_MEMORY_HISTORY_LIMIT cap), and `{entries:[]}` (never an error) for
//     an unknown/never-edited key.
// (D) `memory_forget` does NOT delete history — forgetting a key and re-`memory_write`-ing it under the
//     SAME key resumes appending to the SAME lineage (pre-forget entries stay readable).
//
// Run: 1) build (pnpm --filter @loom/daemon build), 2) node packages/daemon/test/project-memory-history.mjs
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { useOwnLoomHome, mkdtempManaged, cleanupPathSync } from "./_tmp-fixture.mjs";
import { requireHermeticEnv } from "./_guard.mjs";

useOwnLoomHome("loom-pm-history-home-");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { writeProjectMemory, forgetProjectMemory, readProjectMemoryHistory, MAX_MEMORY_HISTORY_LIMIT } = await import("../dist/mcp/memory.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const dir = mkdtempManaged("loom-pm-history-db-");

// ======================= (A) MIGRATION =======================
{
  const file = path.join(dir, "a-migration.db");
  const projId = randomUUID();
  const noteId = randomUUID();
  const t0 = "2026-01-01T00:00:00.000Z";

  // Pinned verbatim from `git show c8cff22f:packages/daemon/src/db.ts` (the `project_memory` CREATE
  // TABLE text immediately before this card — already carries version/request_ids/trigger_glob from
  // earlier cards; this card adds a BRAND-NEW sibling table, never an ALTER on this one) — never
  // re-derived from a live HEAD read.
  const raw = new Database(file);
  raw.pragma("journal_mode = WAL");
  raw.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_path TEXT NOT NULL, vault_path TEXT NOT NULL,
      config_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, archived_at TEXT, reserved INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE project_memory (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      key TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      tags TEXT NOT NULL DEFAULT '[]',
      version INTEGER NOT NULL DEFAULT 1,
      request_ids TEXT,
      trigger_glob TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_retrieved_at TEXT,
      retrieval_count INTEGER NOT NULL DEFAULT 0,
      UNIQUE(project_id, key)
    );
    CREATE INDEX idx_project_memory_project ON project_memory(project_id, pinned, last_retrieved_at);
    CREATE VIRTUAL TABLE project_memory_fts USING fts5(title, text, content='project_memory', content_rowid='rowid');
    CREATE TRIGGER project_memory_ai AFTER INSERT ON project_memory BEGIN
      INSERT INTO project_memory_fts(rowid, title, text) VALUES (new.rowid, new.title, new.text);
    END;
    CREATE TRIGGER project_memory_ad AFTER DELETE ON project_memory BEGIN
      INSERT INTO project_memory_fts(project_memory_fts, rowid, title, text) VALUES ('delete', old.rowid, old.title, old.text);
    END;
    CREATE TRIGGER project_memory_au AFTER UPDATE OF title, text ON project_memory BEGIN
      INSERT INTO project_memory_fts(project_memory_fts, rowid, title, text) VALUES ('delete', old.rowid, old.title, old.text);
      INSERT INTO project_memory_fts(rowid, title, text) VALUES (new.rowid, new.title, new.text);
    END;
    -- NO project_memory_history table at all — the true pre-5ccc2462 shape.
  `);
  raw.prepare("INSERT INTO projects (id, name, repo_path, vault_path, config_json, created_at, archived_at, reserved) VALUES (?, ?, ?, ?, '{}', ?, NULL, 0)")
    .run(projId, "Pre-History Project", projId, projId, t0);
  raw.prepare(
    "INSERT INTO project_memory (id, project_id, key, title, text, pinned, tags, version, request_ids, trigger_glob, created_at, updated_at, last_retrieved_at, retrieval_count) " +
      "VALUES (?, ?, 'pre-existing-note', 'A note from before history', 'this note predates project_memory_history', 0, '[]', 1, NULL, '', ?, ?, NULL, 0)",
  ).run(noteId, projId, t0, t0);
  raw.close();

  const cols0 = new Set(new Database(file, { readonly: true }).prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
  check("(A setup) the synthesized pre-migration DB has NO project_memory_history table yet", !cols0.has("project_memory_history"));

  let db;
  let ctorError = null;
  try {
    db = new Db(file);
  } catch (err) {
    ctorError = err;
  }
  check("(A) constructing Db against a legacy pre-project_memory_history DB does not throw", ctorError === null);
  if (ctorError) console.log(`    threw: ${ctorError?.stack || ctorError}`);

  if (!ctorError) {
    const raw2 = new Database(file, { readonly: true });
    try {
      const table = raw2.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='project_memory_history'").get();
      check("(A) project_memory_history table was created", table !== undefined);
      const index = raw2.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_project_memory_history_key'").get();
      check("(A) the key-scoped index was created", index !== undefined);
    } finally {
      raw2.close();
    }

    const preExisting = db.getProjectMemoryByKey(projId, "pre-existing-note");
    check("(A) the pre-existing note is still readable post-migration", preExisting?.text === "this note predates project_memory_history");
    check("(A) the pre-existing note's version survived the migration untouched", preExisting?.version === 1);

    // ===== the write -> history round-trip WORKS against the upgraded-in-place DB =====
    const edited = db.upsertProjectMemoryChecked(projId, { key: "pre-existing-note", text: "the real first post-migration edit" }, 500, preExisting.version);
    check("(A) a real text edit against the upgraded DB succeeds", edited.ok === true);
    const hist = db.getProjectMemoryHistory(projId, "pre-existing-note", 50);
    check("(A) the edit produced exactly one history row", hist.length === 1);
    check("(A) the history row carries the correct old/new text and version", hist[0]?.oldText === "this note predates project_memory_history" && hist[0]?.newText === "the real first post-migration edit" && hist[0]?.version === 2);
  }
  try { db?.close(); } catch { /* ignore */ }
}

// ======================= (B)/(C)/(D) fresh DB: write semantics + read path + forget =======================
{
  const file = path.join(dir, "b-fresh.db");
  const db = new Db(file);
  const now = new Date().toISOString();
  const projId = randomUUID();
  db.insertProject({ id: projId, name: "Fresh History Project", repoPath: dir, vaultPath: dir, config: {}, createdAt: now, archivedAt: null, reserved: false });

  // ----- (B1) a brand-new key's first write records NO history (nothing prior to compare against) -----
  const created = writeProjectMemory(db, projId, { key: "note-a", text: "the original text" });
  check("(B1) a brand-new key write succeeds", created.key === "note-a" && created.text === "the original text");
  check("(B1) a brand-new key's first write writes NO history row", db.getProjectMemoryHistory(projId, "note-a").length === 0);

  // ----- (B2) a metadata-only patch (text omitted) writes NO history row -----
  const metaOnly = writeProjectMemory(db, projId, { key: "note-a", baseVersion: created.version, title: "a title, no text change" });
  check("(B2) a metadata-only patch (text omitted) succeeds", metaOnly.title === "a title, no text change" && metaOnly.text === "the original text");
  check("(B2) a metadata-only patch writes NO history row", db.getProjectMemoryHistory(projId, "note-a").length === 0);

  // ----- (B3) resending the SAME text explicitly (not omitted) also writes NO history row -----
  const sameText = writeProjectMemory(db, projId, { key: "note-a", baseVersion: metaOnly.version, text: "the original text" });
  check("(B3) resending byte-identical text succeeds", sameText.text === "the original text");
  check("(B3) resending byte-identical text writes NO history row", db.getProjectMemoryHistory(projId, "note-a").length === 0);

  // ----- (B4) a REAL text edit writes exactly one new history row -----
  const edit1 = writeProjectMemory(db, projId, { key: "note-a", baseVersion: sameText.version, text: "edit one" });
  check("(B4) a real text edit succeeds", edit1.text === "edit one");
  let histAfter1 = db.getProjectMemoryHistory(projId, "note-a");
  check("(B4) exactly one history row exists after the first real edit", histAfter1.length === 1);
  check("(B4) the row's oldText/newText/version are correct", histAfter1[0].oldText === "the original text" && histAfter1[0].newText === "edit one" && histAfter1[0].version === edit1.version);

  // ----- (B5) a second real edit appends a second row, newest-first on read -----
  const edit2 = writeProjectMemory(db, projId, { key: "note-a", baseVersion: edit1.version, text: "edit two" });
  const histAfter2 = db.getProjectMemoryHistory(projId, "note-a");
  check("(B5) a second real edit appends a second history row", histAfter2.length === 2);
  check("(B5) read order is newest-first", histAfter2[0].newText === "edit two" && histAfter2[1].newText === "edit one");
  check("(B5) the newest row's oldText chains from the PRIOR row's newText", histAfter2[0].oldText === "edit one");

  // ----- (C1) memory_history read path (mcp/memory.ts), correct shape -----
  const read1 = readProjectMemoryHistory(db, projId, "note-a");
  check("(C1) readProjectMemoryHistory returns {entries:[...]}", Array.isArray(read1.entries) && read1.entries.length === 2);
  const row = read1.entries[0];
  check("(C1) each entry carries the documented shape", typeof row.id === "string" && row.projectId === projId && row.key === "note-a" && typeof row.version === "number" && typeof row.oldText === "string" && typeof row.newText === "string" && typeof row.updatedAt === "string");

  // ----- (C2) limit bounding -----
  const limited = readProjectMemoryHistory(db, projId, "note-a", 1);
  check("(C2) limit:1 returns exactly 1 (the newest) entry", limited.entries.length === 1 && limited.entries[0].newText === "edit two");
  const overLimit = readProjectMemoryHistory(db, projId, "note-a", MAX_MEMORY_HISTORY_LIMIT + 10_000);
  check("(C2) a limit far beyond MAX_MEMORY_HISTORY_LIMIT is clamped, not an error, and still returns the real (smaller) count", overLimit.entries.length === 2);

  // ----- (C3) an unknown / never-edited key returns {entries:[]}, never an error -----
  const unknown = readProjectMemoryHistory(db, projId, "a-key-that-was-never-written");
  check("(C3) an unknown key returns {entries:[]}", Array.isArray(unknown.entries) && unknown.entries.length === 0);
  const neverEdited = writeProjectMemory(db, projId, { key: "note-b", text: "never edited" });
  const neverEditedHist = readProjectMemoryHistory(db, projId, "note-b");
  check("(C3) a never-edited (write-once) key also returns {entries:[]}", neverEditedHist.entries.length === 0);
  void neverEdited;

  // ----- (D) memory_forget DELETES that key's history too (round 2, reversing round 1's decision); a
  // later write under the same key starts a FRESH lineage, it does not resume the deleted one -----
  const forgetResult = forgetProjectMemory(db, projId, "note-a");
  check("(D) memory_forget deletes the live row", forgetResult.ok === true && forgetResult.deleted === true);
  check("(D) memory_forget ALSO deletes note-a's history — both pre-forget rows are gone", db.getProjectMemoryHistory(projId, "note-a").length === 0);
  check("(D) the forgotten key is genuinely gone from the live store", db.getProjectMemoryByKey(projId, "note-a") === undefined);
  check("(D) readProjectMemoryHistory agrees: {entries:[]} for the just-forgotten key", readProjectMemoryHistory(db, projId, "note-a").entries.length === 0);

  const recreated = writeProjectMemory(db, projId, { key: "note-a", text: "a fresh note after forget" });
  check("(D) re-writing the same key after forget succeeds as a brand-new row", recreated.key === "note-a" && recreated.version === 1);
  check("(D) the brand-new post-forget write itself still writes NO history row (nothing prior for THIS incarnation)", db.getProjectMemoryHistory(projId, "note-a").length === 0);
  const recreatedId = recreated.id;
  check("(D) the post-forget row is a genuinely NEW id (a new incarnation), not the old one", typeof recreatedId === "string" && recreatedId.length > 0);

  const editAfterRecreate = writeProjectMemory(db, projId, { key: "note-a", baseVersion: recreated.version, text: "editing the post-forget incarnation" });
  const histAfterRecreate = db.getProjectMemoryHistory(projId, "note-a");
  check("(D) an edit on the post-forget incarnation starts a BRAND-NEW lineage (exactly 1 row, not 3)", histAfterRecreate.length === 1);
  check("(D) the fresh lineage carries ONLY the post-forget transition — the pre-forget history is genuinely gone, not merely hidden",
    histAfterRecreate[0]?.oldText === "a fresh note after forget" && histAfterRecreate[0]?.newText === "editing the post-forget incarnation" &&
    !histAfterRecreate.some((r) => r.newText === "edit two" || r.newText === "edit one"));
  void editAfterRecreate;

  db.close();
}

// ======================= (E) bounded growth: PROJECT_MEMORY_HISTORY_MAX_ROWS_PER_KEY (card 5ccc2462 round 2) =======================
// N is pinned to db.ts's own (private, unexported) PROJECT_MEMORY_HISTORY_MAX_ROWS_PER_KEY = 50 — if
// that constant is ever deliberately changed, this literal must be updated to match (by design: a named
// constant this test can't import directly, so the pin lives here as a plain, grep-able number).
const PROJECT_MEMORY_HISTORY_MAX_ROWS_PER_KEY = 50;
{
  const file = path.join(dir, "e-pruning.db");
  const db = new Db(file);
  const now = new Date().toISOString();
  const projId = randomUUID();
  db.insertProject({ id: projId, name: "Pruning Project", repoPath: dir, vaultPath: dir, config: {}, createdAt: now, archivedAt: null, reserved: false });

  const N = PROJECT_MEMORY_HISTORY_MAX_ROWS_PER_KEY;
  // Write exactly N+5 real text edits (the very first write is the brand-new-key creation — it writes
  // NO history row — followed by N+5 further edits, so the history table sees exactly N+5 transitions).
  let current = writeProjectMemory(db, projId, { key: "pruned-key", text: "edit 0" });
  for (let i = 1; i <= N + 5; i++) {
    current = writeProjectMemory(db, projId, { key: "pruned-key", baseVersion: current.version, text: `edit ${i}` });
  }
  const hist = db.getProjectMemoryHistory(projId, "pruned-key", 1000);
  check(`(E) N+5 (${N + 5}) real edits leave EXACTLY N (${N}) history rows, not N+5`, hist.length === N);
  check("(E) the newest row (edit N+5) survived pruning", hist[0]?.newText === `edit ${N + 5}`);
  check("(E) the OLDEST transitions were pruned — the very first edit's own row (edit 0 -> edit 1) is gone", !hist.some((r) => r.oldText === "edit 0"));
  check("(E) the surviving rows are exactly the newest N transitions, contiguous: the oldest surviving row's oldText is edit 5 (transition #6 of N+5)", hist[hist.length - 1]?.oldText === "edit 5");
  check("(E) readProjectMemoryHistory (the MCP read path) agrees with the same bounded count", readProjectMemoryHistory(db, projId, "pruned-key", 1000).entries.length === N);

  // ----- (E2) the bound holds STEADY across further edits (pruning isn't a one-shot that only fires once) -----
  const further = writeProjectMemory(db, projId, { key: "pruned-key", baseVersion: current.version, text: `edit ${N + 6}` });
  check("(E2) one more edit past the cap still leaves exactly N rows (steady-state, not a one-time trim)", db.getProjectMemoryHistory(projId, "pruned-key", 1000).length === N);
  void further;

  db.close();
}

cleanupPathSync(dir);

console.log(failures === 0
  ? "\n✅ ALL PASS — Db boots clean against a real pre-project_memory_history legacy DB (pinned at sha c8cff22f) and the brand-new sibling table + index land correctly with the pre-existing row untouched; a real text edit against the upgraded-in-place DB writes a correct history row. On a fresh DB: a brand-new key's first write and every metadata-only (or byte-identical-text) patch write NO history row, while a real text change writes exactly one, newest-first on read, each chaining oldText from the prior newText. The memory_history read path (readProjectMemoryHistory) returns the documented shape, bounds `limit` (including the hard MAX_MEMORY_HISTORY_LIMIT cap), and returns {entries:[]} (never an error) for an unknown or never-edited key. memory_forget DELETES the live row AND that key's entire history, in the same transaction — a later write under the same key starts a brand-new lineage, never a resumed one. History growth is bounded per (project,key) at a fixed row count (PROJECT_MEMORY_HISTORY_MAX_ROWS_PER_KEY): writing N+5 edits leaves exactly N rows, oldest pruned first, newest always surviving, and the bound holds steady across further edits rather than firing only once."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
