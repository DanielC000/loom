import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card c90e9525 — a MANUAL deferral (deferred:true, no deferredUntilTaskId) was a stored verdict with no
// reason, no start date, no release condition: a legitimately-parked epic and a forgotten card were
// byte-identical in the field. Fix: `updateProjectTask` (mcp/tasks.ts) now REFUSES a write that would
// leave a card manually-deferred with no `deferredReason` recorded either before or after the patch, and
// stamps a server-side `deferredAt` (never caller-suppliable) the first time real provenance lands. A
// route-(a) deferral (deferredUntilTaskId set — its own release condition is the named blocker task) is
// UNTOUCHED by this guard — that's card 93669813's concern, not this one.
//
// HERMETIC: a real Db (better-sqlite3), driving the built business logic directly (dist/db.js +
// dist/mcp/tasks.js) — no daemon, no real claude, no git needed (this card never touches merged-state
// resolution).
//
// Card 57f346e6 — the guard above evaluated the RESULTING state (isManualDeferral) unconditionally, so
// it re-rejected a patch that never touched deferred/deferredUntilTaskId/deferredReason at all, the
// moment it landed on a card that already WAS a manual deferral with no reason (any pre-c90e9525 legacy
// row). That made every such row reject EVERY future patch forever — including a bare columnKey move —
// since no patch that omits deferredReason could ever supply the missing reason. Fix: the guard (and its
// deferredAt-backfill sibling) now fires only when the patch actually TOUCHES one of the three deferral
// fields. Scenarios (10)-(11) below are this card's own regression coverage, additive to (1)-(9) above
// (which prove the real c90e9525 case survives untouched).
//
// Proves:
//   (1) a FRESH manual deferral (deferred:true, no deferredUntilTaskId, no deferredReason) is REFUSED —
//       whole patch rejected, nothing written (deferred stays false).
//   (2) the SAME call WITH a deferredReason succeeds: deferred:true, deferredReason stored (trimmed),
//       and deferredAt is stamped to a fresh, recent timestamp — never caller-suppliable (deferredAt is
//       not even in the patch type).
//   (3) re-affirming deferred:true on an ALREADY-manually-deferred+reasoned card, with NO deferredReason
//       in the patch, succeeds WITHOUT re-stamping deferredAt (the start time is the start of the
//       episode, not of every touch) and without clobbering the existing reason.
//   (4) editing ONLY deferredReason (deferred omitted, already true) updates the reason and leaves
//       deferredAt untouched (it was already set).
//   (5) deferred:false (an explicit manual clear) resets BOTH deferredAt and deferredReason to null.
//   (6) a manual deferral with a WHITESPACE-ONLY deferredReason is treated as no reason — REFUSED.
//   (7) a route-(a) deferral (deferredUntilTaskId set) needs NO reason — succeeds with BOTH
//       deferredReason and deferredAt staying null (scoped deliberately to the manual path only — route
//       (a) already carries its own self-explaining release condition, the named blocker task).
//   (8) a LEGACY row (deferred:true already, both deferredAt/deferredReason null — simulating a row that
//       predates this card, written directly at the DB layer, bypassing the guard) gets a reason added
//       via a later tasks_update — deferredAt stamps NOW (the first real provenance), never a fabricated
//       backdate; the raw DB row confirms the persist.
//   (9) omitting deferred/deferredReason entirely on an unrelated field-only patch (e.g. priority) never
//       touches deferredAt/deferredReason (PATCH semantics, not clobber).
//
// Run: 1) build (turbo builds shared first), 2) node test/task-manual-deferral-reason.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { Db } = await import("../dist/db.js");
const { createProjectTask, updateProjectTask } = await import("../dist/mcp/tasks.js");

const file = path.join(os.tmpdir(), `loom-manual-defer-reason-${Date.now()}-${process.pid}.db`);
const db = new Db(file);
const now = new Date().toISOString();

try {
  db.insertProject({ id: "pRepo", name: "Repo Project", repoPath: "C:/nope", vaultPath: "C:/nope", config: {}, createdAt: now, archivedAt: null });

  // ===== (1) a FRESH manual deferral with NO reason is REFUSED =====
  const c1 = createProjectTask(db, "pRepo", { title: "no reason given" });
  const r1 = await updateProjectTask(db, "pRepo", c1.id, { deferred: true });
  check("(1) a manual deferral with no reason is REFUSED", "error" in r1);
  check("(1) the error names what's missing", /reason/i.test(r1.error || ""));
  const raw1 = db.getTask(c1.id);
  check("(1) NOTHING was written — deferred stays false", raw1.deferred === false);
  check("(1) deferredAt/deferredReason both stay null", raw1.deferredAt === null && raw1.deferredReason === null);

  // ===== (2) the SAME call WITH a reason succeeds; deferredAt stamps fresh =====
  const before2 = Date.now();
  const r2 = await updateProjectTask(db, "pRepo", c1.id, { deferred: true, deferredReason: "  owner-gated: awaiting design review  " });
  check("(2) succeeds (no error)", !("error" in r2));
  check("(2) deferred:true in the response", r2.deferred === true);
  check("(2) deferredReason is TRIMMED in the response", r2.deferredReason === "owner-gated: awaiting design review");
  check("(2) deferredAt is a fresh, recent ISO timestamp", typeof r2.deferredAt === "string" && Date.parse(r2.deferredAt) >= before2 && Date.parse(r2.deferredAt) <= Date.now());
  const raw2 = db.getTask(c1.id);
  check("(2) raw DB row: deferred=true, reason persisted, deferredAt persisted", raw2.deferred === true && raw2.deferredReason === "owner-gated: awaiting design review" && raw2.deferredAt === r2.deferredAt);

  // ===== (3) re-affirming deferred:true (no new reason) does NOT re-stamp deferredAt or clobber the reason =====
  // DETERMINISTIC, no wall-clock dependence (fixed-wait-negative-guard.mjs: a fixed sleep followed by a
  // negative assertion is unfalsifiable in one trial — a too-short sleep, or a slow machine, lets a
  // genuine re-stamp land AFTER the check and still read as "unchanged"; it would also pass if
  // deferredAt were never written at all). Seed a KNOWN, distant sentinel directly at the DB layer
  // (bypassing updateProjectTask), then assert the post-edit value is BYTE-IDENTICAL to that sentinel —
  // a genuine re-stamp would produce TODAY's timestamp, unmistakably different from a 2020 date, so this
  // fails loudly with zero timing dependence.
  const sentinelDeferredAt = "2020-01-01T00:00:00.000Z";
  db.updateTask(c1.id, { deferredAt: sentinelDeferredAt });
  check("(3) setup: sentinel deferredAt seeded directly at the DB layer", db.getTask(c1.id).deferredAt === sentinelDeferredAt);
  const r3 = await updateProjectTask(db, "pRepo", c1.id, { deferred: true });
  check("(3) re-affirming deferred:true with no new reason succeeds (existing reason still covers it)", !("error" in r3));
  check("(3) deferredAt is UNCHANGED — still the sentinel, not re-stamped to today", r3.deferredAt === sentinelDeferredAt);
  check("(3) the existing reason is UNCHANGED", r3.deferredReason === "owner-gated: awaiting design review");

  // ===== (4) editing ONLY deferredReason (deferred omitted) updates the reason, leaves deferredAt put =====
  const deferredAtBefore4 = db.getTask(c1.id).deferredAt;
  const r4 = await updateProjectTask(db, "pRepo", c1.id, { deferredReason: "owner-gated: design review DONE, now awaiting infra" });
  check("(4) succeeds", !("error" in r4));
  check("(4) the reason is updated", r4.deferredReason === "owner-gated: design review DONE, now awaiting infra");
  check("(4) deferred stays true (untouched)", r4.deferred === true);
  check("(4) deferredAt is STILL unchanged (only the reason text moved)", r4.deferredAt === deferredAtBefore4);

  // ===== (5) deferred:false (explicit manual clear) resets BOTH fields to null =====
  const r5 = await updateProjectTask(db, "pRepo", c1.id, { deferred: false });
  check("(5) clear succeeds", !("error" in r5));
  check("(5) deferred:false in the response", r5.deferred === false);
  check("(5) deferredReason reset to null", r5.deferredReason === null);
  check("(5) deferredAt reset to null", r5.deferredAt === null);
  const raw5 = db.getTask(c1.id);
  check("(5) raw DB row confirms both reset to null", raw5.deferredReason === null && raw5.deferredAt === null);

  // ===== (6) a WHITESPACE-ONLY reason is treated as no reason — REFUSED =====
  const c6 = createProjectTask(db, "pRepo", { title: "whitespace reason" });
  const r6 = await updateProjectTask(db, "pRepo", c6.id, { deferred: true, deferredReason: "   " });
  check("(6) a whitespace-only reason is REFUSED (same as omitted)", "error" in r6);
  const raw6 = db.getTask(c6.id);
  check("(6) nothing written", raw6.deferred === false && raw6.deferredReason === null);

  // ===== (7) a route-(a) deferral (deferredUntilTaskId set) needs NO reason =====
  const blocker7 = createProjectTask(db, "pRepo", { title: "blocker" });
  const c7 = createProjectTask(db, "pRepo", { title: "route-a deferral, no reason needed" });
  const r7 = await updateProjectTask(db, "pRepo", c7.id, { deferred: true, deferredUntilTaskId: blocker7.id });
  check("(7) a route-(a) deferral with NO reason succeeds", !("error" in r7));
  check("(7) deferred:true, deferredUntilTaskId set", r7.deferred === true && r7.deferredUntilTaskId === blocker7.id);
  check("(7) deferredReason stays null (never required for route-a)", r7.deferredReason === null);
  check("(7) deferredAt ALSO stays null for route-a (scoped to the manual path only — see this file's own doc)", r7.deferredAt === null);

  // ===== (8) a LEGACY row (predates this card — written directly at the DB layer, bypassing the guard) =====
  const c8Id = "legacy-manual-defer-1";
  db.insertTask({ id: c8Id, projectId: "pRepo", title: "legacy deferred, no reason", body: "", columnKey: "backlog",
    position: 0, deferred: true, deferredUntilTaskId: null, deferredAt: null, deferredReason: null, createdAt: now, updatedAt: now });
  const legacyBefore = db.getTask(c8Id);
  check("(8) precondition: legacy row is deferred:true with NO reason/date (the exact byte-identical defect)",
    legacyBefore.deferred === true && legacyBefore.deferredReason === null && legacyBefore.deferredAt === null);
  const before8 = Date.now();
  const r8 = await updateProjectTask(db, "pRepo", c8Id, { deferredReason: "backfilled: this was always an owner-gated epic" });
  check("(8) adding a reason to the legacy row succeeds", !("error" in r8));
  check("(8) deferredAt stamps NOW (never a fabricated backdate)", typeof r8.deferredAt === "string" && Date.parse(r8.deferredAt) >= before8);
  const raw8 = db.getTask(c8Id);
  check("(8) raw DB row confirms both persisted", raw8.deferredReason === "backfilled: this was always an owner-gated epic" && raw8.deferredAt === r8.deferredAt);

  // ===== (9) an unrelated field-only patch never touches deferredAt/deferredReason (PATCH semantics) =====
  const beforePatch9 = db.getTask(c8Id);
  const r9 = await updateProjectTask(db, "pRepo", c8Id, { priority: "p0" });
  check("(9) succeeds", !("error" in r9));
  check("(9) priority applied", r9.priority === "p0");
  check("(9) deferredAt/deferredReason UNTOUCHED by an unrelated field-only patch",
    r9.deferredAt === beforePatch9.deferredAt && r9.deferredReason === beforePatch9.deferredReason);

  // ===== (10) DELTA vs RESULTING STATE (card 57f346e6) — a legacy no-reason deferred row must pass an
  // unrelated field-only patch UNCHANGED, not reject it forever =====
  const c10Id = "legacy-manual-defer-2";
  db.insertTask({ id: c10Id, projectId: "pRepo", title: "legacy deferred, no reason, positive control", body: "", columnKey: "backlog",
    position: 0, deferred: true, deferredUntilTaskId: null, deferredAt: null, deferredReason: null, createdAt: now, updatedAt: now });
  // Positive control: confirm this EXACT shape (deferred:true, no reason, no deferredUntilTaskId) still
  // trips the guard when the patch DOES touch a deferral field — proves the check can fire at all before
  // trusting a later "unchanged" result as meaningful, not just a check that never engages.
  const r10control = await updateProjectTask(db, "pRepo", c10Id, { deferred: true });
  check("(10) positive control: touching `deferred` on this exact legacy row still trips the guard", "error" in r10control);
  // The real regression: a patch touching ONLY columnKey (never deferred/deferredUntilTaskId/deferredReason)
  // must succeed, and must leave every deferral field byte-identical — not just avoid an error, but avoid
  // silently fabricating a deferredAt as a side effect of an unrelated write.
  const r10 = await updateProjectTask(db, "pRepo", c10Id, { columnKey: "in_progress" });
  check("(10) a columnKey-only patch on a legacy no-reason deferred row SUCCEEDS (was: refused forever)", !("error" in r10));
  check("(10) columnKey actually applied", r10.columnKey === "in_progress");
  check("(10) deferred/deferredReason/deferredAt pass through UNCHANGED (true/null/null)",
    r10.deferred === true && r10.deferredReason === null && r10.deferredAt === null);
  const raw10 = db.getTask(c10Id);
  check("(10) raw DB row confirms: no deferredAt fabricated as a side effect of the columnKey move",
    raw10.deferred === true && raw10.deferredReason === null && raw10.deferredAt === null && raw10.columnKey === "in_progress");

  // ===== (11) NEGATIVE CONTROL — the same legacy row still refuses a write that DOES touch a deferral
  // field and would still leave it manually-deferred-with-no-reason (the real c90e9525 case, unaffected
  // by the delta fix) =====
  const r11 = await updateProjectTask(db, "pRepo", c10Id, { deferredUntilTaskId: null });
  check("(11) explicitly touching deferredUntilTaskId (still resulting in manual, no reason) is REFUSED", "error" in r11);
  const raw11 = db.getTask(c10Id);
  check("(11) nothing written by the refused call — columnKey from (10) still stands",
    raw11.columnKey === "in_progress" && raw11.deferredReason === null);

  db.close();
} finally {
  fs.rmSync(file, { force: true });
  fs.rmSync(`${file}-wal`, { force: true });
  fs.rmSync(`${file}-shm`, { force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a manual deferral (no deferredUntilTaskId) is refused with no reason recorded either before or after the write, deferredAt stamps once at the start of the episode (or the first time a reason lands on a legacy row) and never re-stamps on a later edit, both fields reset on an explicit clear, a whitespace-only reason is treated as none, a route-(a) deferral needs neither field (its own release condition is the named blocker task), an unrelated field-only patch never touches either field, and (card 57f346e6) a legacy no-reason-deferred row now accepts a patch that never touches a deferral field — unchanged — while a patch that DOES touch one and would still leave it manually-deferred-with-no-reason still refuses."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
