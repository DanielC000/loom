import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card a5f98bb4 — the design decision this file exists to prove: the memory_write optimistic-concurrency
// guard MUST compare-and-set on the monotonic `version` INTEGER, never on the `updatedAt` TIMESTAMP.
//
// The rejected alternative (reusing `updatedAt` as the CAS token) has a real hole: two DISTINCT writes
// can legitimately compute the identical millisecond — from OS clock-resolution coarseness, or simply two
// calls landing in the same tick — which would let a writer holding a STALE version, whose `updatedAt`
// happens to collide with the row's current `updatedAt`, sail through a timestamp-equality check and
// silently clobber a newer write. That is the EXACT silent-clobber bug this card exists to close; a
// timestamp-based guard would just move the hole, not close it.
//
// This test doesn't wait for a real clock collision (unreliable to force from real wall-clock timing) —
// it directly manipulates the stored `updated_at` via a SEPARATE raw connection to the SAME sqlite file
// to FORCE a collision deterministically, then proves the version-based guard is completely unaffected:
// it rejects the stale writer on `version` alone, regardless of what `updated_at` says. A structural
// source check backs this up — the guard's comparison never reads `updatedAt` at all.
//
// Run: 1) build (turbo builds shared first), 2) node test/project-memory-version-guard.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-pm-version-guard-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const dbFile = path.join(tmpHome, "version-guard.db");
const { Db } = await import("../dist/db.js");

let db;
try {
  db = new Db(dbFile);
  const now = new Date().toISOString();
  const projId = randomUUID();
  db.insertProject({ id: projId, name: "Version Guard Project", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null });

  // ===== establish the row and its history: version 1 → version 2 =====
  const w1 = db.upsertProjectMemory(projId, { key: "race-note", text: "original text (version 1)" }, 500);
  check("(setup) first write lands at version 1", w1.version === 1);
  const w2 = db.upsertProjectMemory(projId, { key: "race-note", text: "second writer's text (version 2)" }, 500);
  check("(setup) second write bumps to version 2", w2.version === 2 && w2.id === w1.id);
  check("(setup) sanity: w1 and w2 have DIFFERENT text (proves this isn't a no-op)", w1.text !== w2.text);

  // ===== FORCE a clock collision: manually rewrite version-2's stored updated_at back to version-1's
  // timestamp via a SEPARATE raw connection to the SAME file — simulating a coarse/colliding clock where
  // a later write ends up sharing an earlier write's exact timestamp. Neither `version` nor `text` are
  // touched — only `updated_at`, isolating the one variable a timestamp-based guard would have used. =====
  {
    const raw = new Database(dbFile);
    try {
      const changed = raw.prepare("UPDATE project_memory SET updated_at = ? WHERE project_id = ? AND key = ?").run(w1.updatedAt, projId, "race-note").changes;
      check("(collision) the raw connection successfully forced updated_at back to the EARLIER value", changed === 1);
    } finally {
      raw.close();
    }
  }
  const collided = db.getProjectMemoryByKey(projId, "race-note");
  check("(collision) updated_at now reads IDENTICAL to the version-1 write (the forced collision)", collided.updatedAt === w1.updatedAt);
  check("(collision) version is UNCHANGED by the collision (still 2 — the guard's real signal)", collided.version === 2);
  check("(collision) text is STILL version-2's (the collision only touched the timestamp, not the content)", collided.text === w2.text);

  // ===== THE PROOF: a writer holding the STALE version-1 base — whose updatedAt now happens to match the
  // row's CURRENT (colliding) updatedAt — must still be REJECTED. A timestamp-based guard would have let
  // this straight through (base updatedAt === current updatedAt, a "match"); the version-based guard
  // rejects it because 1 !== 2, completely unaffected by the collision. =====
  const staleWriterAttempt = db.upsertProjectMemoryChecked(projId, { key: "race-note", text: "stale writer's clobber attempt" }, 500, w1.version);
  check("(THE FIX) a stale writer (version 1) is REJECTED despite its updatedAt colliding with the current row's updatedAt",
    staleWriterAttempt.ok === false);
  check("(THE FIX) the rejection's `current` still shows version-2's real text (writer 2's work SURVIVES)",
    staleWriterAttempt.ok === false && staleWriterAttempt.current.text === w2.text);
  check("(THE FIX) the stale attempt never actually persisted", db.getProjectMemoryByKey(projId, "race-note").text === w2.text);

  // The CORRECT current version (2) still works normally post-collision — the guard isn't just
  // rejecting everything; it's discriminating correctly on version alone.
  const correctWriterAttempt = db.upsertProjectMemoryChecked(projId, { key: "race-note", text: "writer 2's own follow-up edit" }, 500, w2.version);
  check("(THE FIX) the writer who actually holds the CURRENT version (2) still succeeds post-collision",
    correctWriterAttempt.ok === true && correctWriterAttempt.entry.text === "writer 2's own follow-up edit");
  check("(THE FIX) version advances to 3 normally, unaffected by the earlier timestamp manipulation",
    correctWriterAttempt.ok === true && correctWriterAttempt.entry.version === 3);

  // ===== structural backstop: the guard's comparison must be version-based BY CONSTRUCTION, not by
  // accident of this test's specific inputs — grep the compiled guard for the actual comparison. =====
  const dbSrc = fs.readFileSync(new URL("../dist/db.js", import.meta.url), "utf8");
  // Anchor on the METHOD DEFINITION's exact signature, not the first hit (which is the earlier {@link
  // upsertProjectMemoryChecked} in upsertProjectMemory's own doc comment) — that earlier hit's window
  // would land entirely inside a JSDoc block and never reach the real comparison.
  const defIdx = dbSrc.indexOf("upsertProjectMemoryChecked(projectId, input, maxNotes, baseVersion)");
  const guardBody = dbSrc.slice(defIdx, defIdx + 600);
  check("(structural) upsertProjectMemoryChecked compares on `.version`", /existing\.version\s*!==\s*baseVersion/.test(guardBody));
  check("(structural) upsertProjectMemoryChecked's compare-and-set does NOT reference `.updatedAt` at all (no timestamp CAS hole to regress into)",
    !/existing\.updatedAt/.test(guardBody));
} finally {
  try { db?.close(); } catch { /* ignore */ }
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the memory_write concurrency guard (card a5f98bb4) compares on the monotonic `version` INTEGER, not the `updatedAt` timestamp: a FORCED updated_at collision (simulating a coarse/colliding clock) between a stale write and the current row leaves the version-based guard completely unaffected — the stale writer is still correctly rejected and the current writer's work survives — which a timestamp-based CAS would NOT have caught. Backed by a structural source check that the guard never reads `.updatedAt` at all."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
