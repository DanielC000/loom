import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 42e9caf9 — a memory_write carrying a `baseVersion` against a key that was DELETED (e.g. via
// memory_forget) since that version was read must be REJECTED as a conflict, never silently treated as a
// brand-new key and recreated. Pre-fix, `upsertProjectMemoryChecked`'s guard was
// `if (existing && existing.version !== baseVersion)` — when `existing` is undefined (the key is gone),
// that whole condition short-circuits false, so the call falls through to a plain insert and resurrects
// the deleted key at version 1, discarding the fact that it was ever deleted and silently defeating
// whatever curation decision the delete represented.
//
// RED on pre-fix `upsertProjectMemoryChecked`/`writeProjectMemory` (packages/daemon/src/db.ts,
// packages/daemon/src/mcp/memory.ts): every assertion below that expects `ok:false`/`notFound:true`/
// `conflict:true` instead sees `ok:true` and the key silently recreated.
//
// Proves, in order:
//   (1) DB layer: a baseVersion carried from BEFORE a delete is rejected with {ok:false, notFound:true} —
//       not {ok:true} — and the key stays deleted (no resurrection).
//   (2) DB layer: the SAME baseVersion reused with NO delete in between still works normally (sanity: the
//       fix doesn't just reject every baseVersion against a missing row for unrelated reasons).
//   (3) DB layer: a brand-new key with NO baseVersion at all is UNAFFECTED (still a plain, un-conflicted
//       insert) — the new check is scoped to "baseVersion was supplied", not "key doesn't exist".
//   (4) DB layer: an ordinary STALE-but-still-existing-row conflict (the pre-existing behavior) is
//       unaffected by this change — still `{ok:false, current}`, not `{ok:false, notFound:true}`.
//   (5) MCP business-logic layer (writeProjectMemory, mcp/memory.ts): the same deleted-key scenario comes
//       back as `{error, conflict:true, notFound:true}` with NO `current` field (there is nothing to show),
//       distinct in SHAPE from an ordinary edit conflict (which carries `current`).
//
// Run after build: node test/project-memory-baseversion-delete-conflict.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-pm-baseversion-delete-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const dbFile = path.join(tmpHome, "baseversion-delete.db");
const { Db } = await import("../dist/db.js");
const { writeProjectMemory } = await import("../dist/mcp/memory.js");

let db;
try {
  db = new Db(dbFile);
  const now = new Date().toISOString();
  const projId = randomUUID();
  db.insertProject({ id: projId, name: "BaseVersion Delete Project", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null });

  // ===== (1) the resurrection scenario: write, read the version, delete, then write again with the
  // now-stale baseVersion — must be rejected, must NOT resurrect the key. =====
  const w1 = db.upsertProjectMemory(projId, { key: "deleted-note", text: "original text" }, 500);
  check("(setup) first write lands at version 1", w1.version === 1);
  const deleted = db.deleteProjectMemory(projId, "deleted-note");
  check("(setup) the key was actually deleted", deleted === true);
  check("(setup) the key reads back as gone", db.getProjectMemoryByKey(projId, "deleted-note") === undefined);

  const resurrectAttempt = db.upsertProjectMemoryChecked(projId, { key: "deleted-note", text: "a stale writer trying to resurrect it" }, 500, w1.version);
  check("(THE FIX) a baseVersion write against a DELETED key is rejected (ok:false)", resurrectAttempt.ok === false);
  check("(THE FIX) the rejection is specifically `notFound:true`, not a `current`-bearing version conflict",
    resurrectAttempt.ok === false && "notFound" in resurrectAttempt && resurrectAttempt.notFound === true);
  check("(THE FIX) the key was NOT resurrected — it still reads back as gone", db.getProjectMemoryByKey(projId, "deleted-note") === undefined);

  // ===== (2) sanity: the exact same baseVersion, with NO delete in between, still works normally — proves
  // the fix isn't just blanket-rejecting every write that carries a baseVersion. =====
  const w2 = db.upsertProjectMemory(projId, { key: "live-note", text: "original text" }, 500);
  const normalUpdate = db.upsertProjectMemoryChecked(projId, { key: "live-note", text: "a real follow-up edit" }, 500, w2.version);
  check("(sanity) a baseVersion write against a row that's STILL THERE (no delete) succeeds normally",
    normalUpdate.ok === true && normalUpdate.entry.text === "a real follow-up edit" && normalUpdate.entry.version === 2);

  // ===== (3) a brand-new key with NO baseVersion at all is unaffected — the new check only fires when the
  // caller actually supplied a baseVersion. =====
  const freshCreate = db.upsertProjectMemoryChecked(projId, { key: "brand-new-note", text: "never existed before" }, 500, undefined);
  check("(sanity) a brand-new key with no baseVersion still creates normally (ok:true, version 1)",
    freshCreate.ok === true && freshCreate.entry.version === 1);

  // ===== (4) the pre-existing stale-but-EXISTING-row conflict is unaffected — still `{ok:false, current}`,
  // never misreported as `notFound`. =====
  const w3a = db.upsertProjectMemory(projId, { key: "still-here-note", text: "version 1" }, 500);
  db.upsertProjectMemory(projId, { key: "still-here-note", text: "version 2, by someone else" }, 500);
  const staleButExists = db.upsertProjectMemoryChecked(projId, { key: "still-here-note", text: "stale writer's clobber attempt" }, 500, w3a.version);
  check("(sanity) a stale baseVersion against a row that STILL EXISTS is rejected as an ordinary version conflict",
    staleButExists.ok === false && "current" in staleButExists && staleButExists.current.text === "version 2, by someone else");
  check("(sanity) that ordinary conflict is NOT misreported as `notFound`",
    staleButExists.ok === false && !("notFound" in staleButExists));

  // ===== (5) the MCP business-logic layer (writeProjectMemory) surfaces the same deleted-key scenario as
  // {error, conflict:true, notFound:true} with no `current` field — distinct in shape from an ordinary
  // edit conflict. =====
  const w4 = db.upsertProjectMemory(projId, { key: "mcp-deleted-note", text: "original" }, 500);
  db.deleteProjectMemory(projId, "mcp-deleted-note");
  const mcpResult = writeProjectMemory(db, projId, { key: "mcp-deleted-note", text: "resurrection attempt via the MCP layer", baseVersion: w4.version });
  check("(MCP layer) the deleted-key resurrection attempt is rejected with an error", typeof mcpResult.error === "string");
  check("(MCP layer) the rejection carries conflict:true", mcpResult.conflict === true);
  check("(MCP layer) the rejection carries notFound:true", mcpResult.notFound === true);
  check("(MCP layer) the rejection carries NO `current` field (nothing to reconcile against)", !("current" in mcpResult) || mcpResult.current === undefined);
  check("(MCP layer) the key was NOT resurrected", db.getProjectMemoryByKey(projId, "mcp-deleted-note") === undefined);

  // Ordinary edit conflict via the SAME MCP layer, for contrast — still carries `current`, never `notFound`.
  const w5a = db.upsertProjectMemory(projId, { key: "mcp-still-here", text: "version 1" }, 500);
  db.upsertProjectMemory(projId, { key: "mcp-still-here", text: "version 2" }, 500);
  const mcpConflict = writeProjectMemory(db, projId, { key: "mcp-still-here", text: "stale clobber via MCP", baseVersion: w5a.version });
  check("(MCP layer, contrast) an ordinary edit conflict carries `current`, not `notFound`",
    mcpConflict.conflict === true && mcpConflict.current?.text === "version 2" && mcpConflict.notFound === undefined);
} finally {
  try { db?.close(); } catch { /* ignore */ }
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a memory_write baseVersion carried from before a key's deletion is rejected as a `notFound` conflict at both the DB layer (upsertProjectMemoryChecked) and the MCP business-logic layer (writeProjectMemory), and never silently resurrects the deleted key; ordinary stale-but-existing-row conflicts and baseVersion-less fresh creates are both unaffected."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
