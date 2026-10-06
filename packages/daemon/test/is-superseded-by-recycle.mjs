import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 386e4eb5 — unit-level test for the shared `currentHaltedSuccessor`/`isSupersededByRecycle`
// predicate (orchestration/crash-orphaned-workers.ts), independent of the full
// Db+PtyHost+SessionService harness used by recycle-manager-halted-successor-dies.mjs. Hermetic: a plain
// Db, no git repo, no claude, no pty.
//
// Proves, directly against the exported functions:
//   (1) ORDINARY (never recycled) session — not superseded.
//   (2) ORDINARY recycled session (hasSuccessor true, no halt event) — superseded (unchanged baseline).
//   (3) HALTED + MATCHING — current successor is exactly the latest halt event's named id+gen — NOT
//       superseded (the new carve-out).
//   (4) DIFFERENT SUCCESSOR — current successor's id differs from the halt event's (an id mismatch, via a
//       clean re-recycle to a brand-new successor) — superseded.
//   (5) STALE GENERATION — same successor id, but a DIFFERENT gen — superseded.
//   (6) LEGACY/MALFORMED EVENT — halt event has no detail.gen at all — FAILS CLOSED (superseded), proving
//       the comparison does not treat `undefined === undefined` as a match.
//   (7) ORDER — two halt events inserted OUT of chronological order (the real/matching one inserted FIRST
//       with a LATER ts; a stale/non-matching one inserted SECOND with an EARLIER ts) — the predicate must
//       still pick the ts-LATEST event, proving reliance on `listEventsForSession`'s `ORDER BY ts, rowid`
//       rather than insertion/rowid order.
//   (8) CARD dfc3b014 — RESOLVED: a `recycle_ownership_transfer_resolved` event chronologically latest for
//       the session makes a lineage read superseded (ordinary retired-predecessor semantics) even though
//       `hasSuccessor` stays true and `recycled_from` is untouched — the one halt-resolution path that
//       does NOT null `recycled_from`.
//   (9) CARD dfc3b014 — PURE TS-ORDERING UNIT CHECK (Code Review NIT: this exact shape — a halt
//       chronologically AFTER a resolved event for the SAME id+gen — is unreachable in production, since
//       `recycle_reattempt` only ever files the resolved kind once a lineage has gone clean; it exists
//       solely to prove the predicate picks "latest by ts", not "latest *_failed", independent of kind).
//
// Run: 1) build (turbo builds shared first), 2) node test/is-superseded-by-recycle.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Db } from "../dist/db.js";
import { isSupersededByRecycle, currentHaltedSuccessor } from "../dist/orchestration/crash-orphaned-workers.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

function makeDb() {
  const dbFile = path.join(os.tmpdir(), `loom-issr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Db(dbFile);
  const projId = `p-${Math.random().toString(36).slice(2, 8)}`;
  const agentId = `a-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  db.insertProject({ id: projId, name: "ISSR", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "mgr", position: 0 });
  return { dbFile, db, projId, agentId };
}

function seedSession(e, id, { role = "manager", gen, recycledFrom = null } = {}) {
  e.db.insertSession({
    id, projectId: e.projId, agentId: e.agentId, engineSessionId: "eng-" + id, title: null, cwd: e.projId,
    processState: "live", resumability: "resumable", busy: false,
    createdAt: new Date().toISOString(), lastActivity: new Date().toISOString(), lastError: null, role,
    parentSessionId: null, taskId: null, ctxInputTokens: null, ctxTurns: null, model: null,
    gen, recycledFrom,
  });
}

function haltEvent(predecessorId, successorId, { gen, ts, detailOverride } = {}) {
  return {
    id: randomUUID(), ts: ts ?? new Date().toISOString(),
    managerSessionId: successorId, workerSessionId: predecessorId, taskId: null,
    kind: "recycle_ownership_transfer_failed",
    detail: detailOverride !== undefined ? detailOverride : { recycledFrom: predecessorId, gen, failedSteps: ["wakes"] },
  };
}

// Card dfc3b014's resolution marker — same identity shape as haltEvent above.
function resolvedEvent(predecessorId, successorId, { gen, ts } = {}) {
  return {
    id: randomUUID(), ts: ts ?? new Date().toISOString(),
    managerSessionId: successorId, workerSessionId: predecessorId, taskId: null,
    kind: "recycle_ownership_transfer_resolved",
    detail: { successorId, gen },
  };
}

const dbFiles = [];

try {
  // ==================== (1) ORDINARY — never recycled ====================
  {
    const e = makeDb(); dbFiles.push(e.dbFile);
    seedSession(e, "m1-1");
    check("(1) a never-recycled session is NOT superseded", isSupersededByRecycle(e.db, "m1-1") === false);
    check("(1) currentHaltedSuccessor is undefined", currentHaltedSuccessor(e.db, "m1-1") === undefined);
  }

  // ==================== (2) ORDINARY recycled — no halt event ====================
  {
    const e = makeDb(); dbFiles.push(e.dbFile);
    seedSession(e, "m2-old");
    seedSession(e, "m2-new", { gen: 1, recycledFrom: "m2-old" });
    check("(2) an ordinary recycled predecessor (no halt event) IS superseded", isSupersededByRecycle(e.db, "m2-old") === true);
    check("(2) currentHaltedSuccessor is undefined (no halt event at all)", currentHaltedSuccessor(e.db, "m2-old") === undefined);
  }

  // ==================== (3) HALTED + MATCHING — the new carve-out ====================
  {
    const e = makeDb(); dbFiles.push(e.dbFile);
    seedSession(e, "m3-old");
    seedSession(e, "m3-new", { gen: 1, recycledFrom: "m3-old" });
    e.db.appendEvent(haltEvent("m3-old", "m3-new", { gen: 1 }));
    check("(3) FIX 386e4eb5: a halted predecessor whose current successor matches its latest halt (id+gen) is NOT superseded", isSupersededByRecycle(e.db, "m3-old") === false);
    check("(3) currentHaltedSuccessor returns the matching successor", currentHaltedSuccessor(e.db, "m3-old")?.id === "m3-new");
  }

  // ==================== (4) DIFFERENT SUCCESSOR — id mismatch via a clean re-recycle ====================
  {
    const e = makeDb(); dbFiles.push(e.dbFile);
    seedSession(e, "m4-old");
    seedSession(e, "m4-s1"); // the halted successor the event names
    e.db.appendEvent(haltEvent("m4-old", "m4-s1", { gen: 1 }));
    // Clean re-recycle to a BRAND NEW successor — current successor is now m4-s2, not m4-s1.
    seedSession(e, "m4-s2", { gen: 2, recycledFrom: "m4-old" });
    check("(4) different successor (id mismatch): STILL superseded", isSupersededByRecycle(e.db, "m4-old") === true);
    check("(4) currentHaltedSuccessor is undefined (current successor doesn't match the halt event)", currentHaltedSuccessor(e.db, "m4-old") === undefined);
  }

  // ==================== (5) STALE GENERATION — same successor id, different gen ====================
  {
    const e = makeDb(); dbFiles.push(e.dbFile);
    seedSession(e, "m5-old");
    seedSession(e, "m5-new", { gen: 2, recycledFrom: "m5-old" }); // CURRENT gen is 2
    e.db.appendEvent(haltEvent("m5-old", "m5-new", { gen: 1 })); // halt event names the SAME id, but gen 1
    check("(5) stale generation (same id, mismatched gen): STILL superseded", isSupersededByRecycle(e.db, "m5-old") === true);
    check("(5) currentHaltedSuccessor is undefined", currentHaltedSuccessor(e.db, "m5-old") === undefined);
  }

  // ==================== (6) LEGACY/MALFORMED — no detail.gen — FAILS CLOSED ====================
  {
    const e = makeDb(); dbFiles.push(e.dbFile);
    seedSession(e, "m6-old");
    seedSession(e, "m6-new", { gen: 1, recycledFrom: "m6-old" });
    e.db.appendEvent(haltEvent("m6-old", "m6-new", { detailOverride: { recycledFrom: "m6-old", failedSteps: ["wakes"] } })); // no gen field
    check("(6) FIX: a halt event with no detail.gen fails CLOSED — still superseded", isSupersededByRecycle(e.db, "m6-old") === true);
    check("(6) currentHaltedSuccessor is undefined (never matches on a missing gen)", currentHaltedSuccessor(e.db, "m6-old") === undefined);
  }

  // ==================== (6b) LEGACY — fresh.gen also undefined must NOT be treated as a match ====================
  {
    const e = makeDb(); dbFiles.push(e.dbFile);
    seedSession(e, "m6b-old");
    seedSession(e, "m6b-new", { recycledFrom: "m6b-old" }); // gen left undefined on the successor row too
    e.db.appendEvent(haltEvent("m6b-old", "m6b-new", { detailOverride: { recycledFrom: "m6b-old", failedSteps: ["wakes"] } })); // no gen field either
    check("(6b) FIX: undefined-vs-undefined gen is NOT treated as equal — still superseded", isSupersededByRecycle(e.db, "m6b-old") === true);
  }

  // ==================== (7) ORDER — two halt events inserted OUT of chronological order ====================
  {
    const e = makeDb(); dbFiles.push(e.dbFile);
    seedSession(e, "m7-old");
    seedSession(e, "m7-stale"); // named by the EARLIER (by ts) halt event
    seedSession(e, "m7-new", { gen: 2, recycledFrom: "m7-old" }); // the CURRENT, real successor
    // Insert the REAL/matching event FIRST (lower rowid) with a LATER ts; insert the STALE/non-matching
    // event SECOND (higher rowid) with an EARLIER ts. If the predicate (or listEventsForSession) picked
    // "latest" by insertion/rowid order rather than `ts`, .at(-1) would wrongly return the stale event.
    e.db.appendEvent(haltEvent("m7-old", "m7-new", { gen: 2, ts: "2026-01-02T00:00:00.000Z" }));
    e.db.appendEvent(haltEvent("m7-old", "m7-stale", { gen: 1, ts: "2026-01-01T00:00:00.000Z" }));
    check("(7) FIX verified at source: events are returned ORDER BY ts (not insertion order)",
      e.db.listEventsForSession("m7-old").at(-1)?.managerSessionId === "m7-new");
    check("(7) the predicate correctly follows ts-order, not insertion order: NOT superseded", isSupersededByRecycle(e.db, "m7-old") === false);
    check("(7) currentHaltedSuccessor returns the ts-latest (real, current) successor", currentHaltedSuccessor(e.db, "m7-old")?.id === "m7-new");
  }

  // ==================== (8) CARD dfc3b014 — RESOLVED: recycled_from untouched, still not superseded ====
  {
    const e = makeDb(); dbFiles.push(e.dbFile);
    seedSession(e, "m8-old");
    seedSession(e, "m8-new", { gen: 1, recycledFrom: "m8-old" }); // recycled_from stays SET throughout
    e.db.appendEvent(haltEvent("m8-old", "m8-new", { gen: 1 }));
    check("(8) before resolution: halted + matching, NOT superseded (sanity, mirrors case (3))", isSupersededByRecycle(e.db, "m8-old") === false);
    e.db.appendEvent(resolvedEvent("m8-old", "m8-new", { gen: 1 }));
    check("(8) FIX dfc3b014: a resolved event chronologically latest makes the lineage superseded again (ordinary retired-predecessor semantics)", isSupersededByRecycle(e.db, "m8-old") === true);
    check("(8) currentHaltedSuccessor is undefined once resolved", currentHaltedSuccessor(e.db, "m8-old") === undefined);
    check("(8) recycled_from was NEVER nulled — hasSuccessor still true (the resolved marker is what carries the signal, not an unlink)", e.db.hasSuccessor("m8-old") === true);
  }

  // ========== (9) CARD dfc3b014 — PURE TS-ORDERING UNIT CHECK (unreachable in production, see header) ====
  {
    const e = makeDb(); dbFiles.push(e.dbFile);
    seedSession(e, "m9-old");
    seedSession(e, "m9-new", { gen: 1, recycledFrom: "m9-old" });
    // Synthetic ONLY: an EARLIER (by ts) resolved event for this exact id+gen, then a LATER halt event
    // re-asserting the SAME id+gen — `recycle_reattempt` never actually produces this shape (it only files
    // the resolved kind once clean, and a predecessor that's genuinely resolved is retired, never halted
    // again against the same successor), but the predicate's own ts-ordering mechanism must still be
    // proven independent of kind, not just independent of insertion order (case (7) above).
    e.db.appendEvent(resolvedEvent("m9-old", "m9-new", { gen: 1, ts: "2026-01-01T00:00:00.000Z" }));
    e.db.appendEvent(haltEvent("m9-old", "m9-new", { gen: 1, ts: "2026-01-02T00:00:00.000Z" }));
    check("(9) FIX dfc3b014: a chronologically-LATER halt wins over an earlier resolved event for the SAME id+gen — NOT superseded",
      isSupersededByRecycle(e.db, "m9-old") === false);
    check("(9) currentHaltedSuccessor returns the matching successor (the later halt, not the earlier resolve, is authoritative)",
      currentHaltedSuccessor(e.db, "m9-old")?.id === "m9-new");
  }
} finally {
  for (const f of dbFiles) { try { fs.rmSync(f, { force: true }); } catch { /* best-effort */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — currentHaltedSuccessor/isSupersededByRecycle match exactly (id+gen) on the latest recycle_ownership_transfer_failed event, fail closed on a missing gen, and honor ts-order over insertion order."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
