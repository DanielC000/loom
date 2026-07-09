import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Deja capture STATUS test (card 1c0c1a2c): the count read that turns a silently-empty dejaCapture
// toggle into a self-explaining state (an "0 mockups seen yet" empty-state line vs a "N mockups
// captured" heartbeat, rendered by the web Settings page). Fully hermetic — no claude, no live
// daemon process, no real `deja` binary: HOME/USERPROFILE are sandboxed to a temp dir BEFORE
// importing dist, so getDejaCaptureCount()'s os.homedir()-derived path never touches the real
// ~/.deja/store.sqlite, and the store is synthesized directly with better-sqlite3 using Deja's
// REAL `mockups` table shape (id/created_at/project/source_path/... — see the real `deja` repo's
// src/store.ts) — not a stand-in schema, so this proves the daemon's read lines up with what Deja
// itself actually writes.
//
// Proves:
//   (1) resolveDejaStorePath() resolves to <sandboxed home>/.deja/store.sqlite (os.homedir()-based,
//       matching the deja-capture.mjs relay's own resolveDejaDbPath()).
//   (2) getDejaCaptureCount(): no store file at all -> 0 (never throws — dejaCapture just turned on,
//       nothing captured yet).
//   (3) getDejaCaptureCount(): a store with N real `mockups` rows -> N.
//   (4) getDejaCaptureCount(): a store file that exists but isn't a valid sqlite db (or lacks the
//       `mockups` table) -> 0, never throws (best-effort degrade).
//   (5) GET /api/deja/capture-status: 403 on a non-dev build (Deja is LOOM_DEV-gated, mirrors the
//       /api/skills/:name/publish gate) even though a store with rows exists.
//   (6) GET /api/deja/capture-status: 200 { count } once LOOM_DEV=1, reflecting the SAME live count.
//
// Run: 1) build (turbo builds shared first), 2) node test/deja-capture-status.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Sandbox HOME/USERPROFILE BEFORE importing dist — getDejaCaptureCount/resolveDejaStorePath derive
// the store path from os.homedir() at CALL time, but setting this up front mirrors the other deja
// tests' discipline and rules out any accidental early read of the real ~/.deja.
const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), "loom-deja-status-home-"));
process.env.HOME = sandboxHome;
process.env.USERPROFILE = sandboxHome;

const { getDejaCaptureCount, resolveDejaStorePath } = await import("../dist/deja/store.js");
const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");

const storePath = path.join(sandboxHome, ".deja", "store.sqlite");

try {
  // ===== (1) resolveDejaStorePath =====
  check("resolveDejaStorePath: <home>/.deja/store.sqlite under the sandboxed HOME", resolveDejaStorePath() === storePath);

  // ===== (2) no store file at all -> 0, never throws =====
  check("getDejaCaptureCount: no store file -> 0", getDejaCaptureCount() === 0);

  // ===== (3) a store with Deja's REAL `mockups` table shape (mirrors the deja repo's src/store.ts
  // BASE_SCHEMA verbatim, minus the columns added by its own later migrations — a fresh v1 store is
  // exactly what a brand-new ~/.deja/store.sqlite looks like) and N rows -> N =====
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  {
    const raw = new Database(storePath);
    raw.exec(`
      CREATE TABLE IF NOT EXISTS mockups (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        project TEXT NOT NULL,
        source_path TEXT NOT NULL,
        files_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        lineage_id TEXT NOT NULL,
        stack TEXT NOT NULL,
        extracted_text TEXT NOT NULL,
        origin_prompt TEXT,
        title TEXT,
        description TEXT,
        page_type TEXT,
        patterns_json TEXT NOT NULL,
        theme TEXT,
        density TEXT,
        embedding_json TEXT,
        embedding_prompt_json TEXT,
        reuse_count INTEGER NOT NULL DEFAULT 0,
        kept INTEGER
      );
    `);
    const insert = raw.prepare(
      `INSERT INTO mockups (id, created_at, project, source_path, files_json, content_hash, lineage_id, stack, extracted_text, patterns_json)
       VALUES (?, ?, ?, ?, '[]', ?, ?, 'html', 'some text', '[]')`,
    );
    for (let i = 0; i < 3; i++) {
      insert.run(`mockup-${i}`, new Date().toISOString(), "Fire Studio", `/tmp/mockup-${i}.html`, `hash-${i}`, `lineage-${i}`);
    }
    raw.close();
  }
  check("getDejaCaptureCount: a store with 3 real mockups rows -> 3", getDejaCaptureCount() === 3);

  // A fourth capture lands (mirrors an agent writing another mockup mid-session) -> the count moves,
  // proving this is a live read, not a cached/stale snapshot.
  {
    const raw = new Database(storePath);
    raw.prepare(
      `INSERT INTO mockups (id, created_at, project, source_path, files_json, content_hash, lineage_id, stack, extracted_text, patterns_json)
       VALUES (?, ?, ?, ?, '[]', ?, ?, 'html', 'more text', '[]')`,
    ).run("mockup-3", new Date().toISOString(), "Fire Studio", "/tmp/mockup-3.html", "hash-3", "lineage-3");
    raw.close();
  }
  check("getDejaCaptureCount: a live read reflects a capture that landed after the first read -> 4", getDejaCaptureCount() === 4);

  // ===== (4) a store FILE that exists but is garbage (not a valid sqlite db) -> 0, never throws =====
  const garbagePath = path.join(sandboxHome, "garbage-store", "store.sqlite");
  fs.mkdirSync(path.dirname(garbagePath), { recursive: true });
  fs.writeFileSync(garbagePath, "not a sqlite file");
  process.env.HOME = path.dirname(garbagePath);
  process.env.USERPROFILE = path.dirname(garbagePath);
  check("getDejaCaptureCount: a corrupt/non-sqlite store file -> 0, never throws", getDejaCaptureCount() === 0);
  // Restore the real sandbox home with the 4-row store for the route checks below.
  process.env.HOME = sandboxHome;
  process.env.USERPROFILE = sandboxHome;

  // ===== (5)/(6) GET /api/deja/capture-status: LOOM_DEV-gated, then reflects the live count =====
  delete process.env.LOOM_DEV; // the TRUE default-off state, mirroring deja-capture.mjs's gate check
  const dbFile = path.join(sandboxHome, "route-test.db");
  const db = new Db(dbFile);
  const stub = {};
  const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, runMcp: stub, control: stub, usageStatus: stub });
  try {
    const nonDev = await app.inject({ method: "GET", url: "/api/deja/capture-status", remoteAddress: "127.0.0.1" });
    check("route: non-dev build -> 403 (Deja is LOOM_DEV-gated, never widens to a regular loomctl user)", nonDev.statusCode === 403);

    process.env.LOOM_DEV = "1";
    const devOk = await app.inject({ method: "GET", url: "/api/deja/capture-status", remoteAddress: "127.0.0.1" });
    check("route: LOOM_DEV=1 -> 200", devOk.statusCode === 200);
    check("route: LOOM_DEV=1 -> { count } reflects the real store's live count (4)", devOk.json().count === 4);
  } finally {
    try { await app.close(); } catch { /* ignore */ }
    db.close();
    delete process.env.LOOM_DEV;
  }
} finally {
  delete process.env.HOME;
  delete process.env.USERPROFILE;
  for (let i = 0; i < 5; i++) { try { fs.rmSync(sandboxHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — getDejaCaptureCount reads Deja's real `mockups` table shape live (0 with no store, N with N rows, always degrading to 0 rather than throwing on a missing/corrupt store), and GET /api/deja/capture-status is LOOM_DEV-gated (403 off, 200 { count } on) and reflects the same live count."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
