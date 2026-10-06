import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card ca0111a3 — unit-level test for `currentUnresolvedSettleSuccessor`
// (orchestration/crash-orphaned-workers.ts), independent of the full Db+PtyHost+SessionService harness
// used by recycle-settle-timeout-escalation.mjs. Hermetic: a plain Db, no git repo, no claude, no pty.
// Mirrors is-superseded-by-recycle.mjs's own hermetic seedSession pattern for the sibling
// currentHaltedSuccessor predicate — same style, a DIFFERENT predicate (386e4eb5's own "Do not" keeps
// the two separate; see this file's own scenario (4) for the explicit cross-contamination check).
//
// Proves, directly against the exported function:
//   (1) ORDINARY (never recycled) session — undefined.
//   (2) ORDINARY recycled session (hasSuccessor true, no recycle_fleet_* event at all) — undefined.
//   (3) UNRESOLVED + MATCHING — the baseline positive case: latest event is recycle_fleet_unresolved,
//       reason:"timeout", no halted flag, deadSuccessorId matches the CURRENT successor, no ready latch.
//   (4) HALTED:true EXCLUSION (Code Review round 1 finding, zero coverage before this card) — the SAME
//       event kind, but `detail.halted:true` (watchHaltedRecycleSuccessor's own alert shape, a totally
//       different scenario that happens to share the event kind string) — undefined.
//   (5) REASON MISMATCH — `reason:"successor-died"` (recoverFleetAfterFailedRecycleSuccessor's
//       oldStillLive:false branch) — undefined; this predicate is timeout-specific.
//   (6) STALE/FOREIGN SUCCESSOR ID (Code Review round 1 finding, zero coverage before this card) — an
//       unresolved event names an OLD successor that is no longer the current one (the predecessor was
//       reclaimed and clean-re-recycled to a brand-new successor since) — undefined.
//   (7) THE DURABLE READY LATCH (Code Review round 2, the MAIN fix this round) — the latest event is
//       STILL recycle_fleet_unresolved (no recycle_fleet_resolved/recovered has been filed — simulating
//       the real gap between the successor's `onReady` hook latching `reachedReadyAt` and
//       settleRecycleHandoff's own NEXT poll ever observing it and filing the superseding event, or a
//       restart whose deferred-success reconcile files no event at all) — but `reachedReadyAt` is already
//       set on the successor row — undefined. Before this round's fix, this case wrongly matched.
//   (8) RESOLVED event supersedes — undefined.
//   (9) RECOVERED event supersedes — undefined.
//   (10) ORDER — two recycle_fleet_unresolved-family events inserted OUT of chronological order — the
//        predicate must still pick the ts-LATEST, proving reliance on `listEventsForSession`'s
//        `ORDER BY ts, rowid` rather than insertion/rowid order (mirrors is-superseded-by-recycle.mjs's
//        own case (7) for the sibling predicate).
//   (11) STRANDED supersedes (card eddb768a) — mirrors (8)/(9): a chronologically-later
//        recycle_fleet_stranded_across_restart must ALSO stop a prior unresolved alert from matching,
//        even though stampStranded never unlinks the dead successor (so neither of the predicate's two
//        short-circuits — !fresh / reachedReadyAt — fire on their own here).
//   (12) SHARED HELPER PARITY (card eddb768a) — latestMatchingUnresolvedSettleEvent (the extracted
//        event-only half) agrees with currentUnresolvedSettleSuccessor on the same fixtures.
//
// Run: 1) build (turbo builds shared first), 2) node test/recycle-unresolved-settle-predicate.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Db } from "../dist/db.js";
import { currentUnresolvedSettleSuccessor, currentHaltedSuccessor, latestMatchingUnresolvedSettleEvent } from "../dist/orchestration/crash-orphaned-workers.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

function makeDb() {
  const dbFile = path.join(os.tmpdir(), `loom-rusp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Db(dbFile);
  const projId = `p-${Math.random().toString(36).slice(2, 8)}`;
  const agentId = `a-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  db.insertProject({ id: projId, name: "RUSP", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
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

function unresolvedEvent(predecessorId, deadSuccessorId, { ts, reason = "timeout", halted, oldStillLive = true } = {}) {
  const detail = { deadSuccessorId, oldStillLive, reason };
  if (halted !== undefined) detail.halted = halted;
  return { id: randomUUID(), ts: ts ?? new Date().toISOString(), managerSessionId: predecessorId, kind: "recycle_fleet_unresolved", detail };
}
function resolvedEvent(predecessorId, successorId, { ts } = {}) {
  return { id: randomUUID(), ts: ts ?? new Date().toISOString(), managerSessionId: predecessorId, kind: "recycle_fleet_resolved", detail: { successorId } };
}
function recoveredEvent(predecessorId, deadSuccessorId, { ts, reparentedWorkers = 0 } = {}) {
  return { id: randomUUID(), ts: ts ?? new Date().toISOString(), managerSessionId: predecessorId, kind: "recycle_fleet_recovered", detail: { deadSuccessorId, oldStillLive: true, reparentedWorkers } };
}
function strandedEvent(predecessorId, deadSuccessorId, { ts } = {}) {
  return { id: randomUUID(), ts: ts ?? new Date().toISOString(), managerSessionId: predecessorId, kind: "recycle_fleet_stranded_across_restart", detail: { deadSuccessorId } };
}

const dbFiles = [];

try {
  // ==================== (1) ORDINARY — never recycled ====================
  {
    const e = makeDb(); dbFiles.push(e.dbFile);
    seedSession(e, "m1-1");
    check("(1) a never-recycled session: undefined", currentUnresolvedSettleSuccessor(e.db, "m1-1") === undefined);
  }

  // ==================== (2) ORDINARY recycled — no recycle_fleet_* event at all ====================
  {
    const e = makeDb(); dbFiles.push(e.dbFile);
    seedSession(e, "m2-old");
    seedSession(e, "m2-new", { gen: 1, recycledFrom: "m2-old" });
    check("(2) recycled but no recycle_fleet_* event: undefined", currentUnresolvedSettleSuccessor(e.db, "m2-old") === undefined);
  }

  // ==================== (3) UNRESOLVED + MATCHING — the positive baseline ====================
  {
    const e = makeDb(); dbFiles.push(e.dbFile);
    seedSession(e, "m3-old");
    seedSession(e, "m3-new", { gen: 1, recycledFrom: "m3-old" });
    e.db.appendEvent(unresolvedEvent("m3-old", "m3-new"));
    check("(3) unresolved(reason:timeout) naming the CURRENT successor: matches", currentUnresolvedSettleSuccessor(e.db, "m3-old")?.id === "m3-new");
    check("(3) currentHaltedSuccessor stays undefined (disjoint predicate, no cross-match)", currentHaltedSuccessor(e.db, "m3-old") === undefined);
  }

  // ==================== (4) HALTED:true EXCLUSION — zero coverage before this card ====================
  {
    const e = makeDb(); dbFiles.push(e.dbFile);
    seedSession(e, "m4-old");
    seedSession(e, "m4-new", { gen: 1, recycledFrom: "m4-old" });
    e.db.appendEvent(unresolvedEvent("m4-old", "m4-new", { halted: true })); // watchHaltedRecycleSuccessor's own shape
    check("(4) FIX: a halted:true unresolved event (the UNRELATED halted-watch alert) does NOT match: undefined",
      currentUnresolvedSettleSuccessor(e.db, "m4-old") === undefined);
  }

  // ==================== (5) REASON MISMATCH — "successor-died", not "timeout" ====================
  {
    const e = makeDb(); dbFiles.push(e.dbFile);
    seedSession(e, "m5-old");
    seedSession(e, "m5-new", { gen: 1, recycledFrom: "m5-old" });
    e.db.appendEvent(unresolvedEvent("m5-old", "m5-new", { reason: "successor-died", oldStillLive: false }));
    check("(5) reason:\"successor-died\" does NOT match (this predicate is timeout-specific): undefined",
      currentUnresolvedSettleSuccessor(e.db, "m5-old") === undefined);
  }

  // ==================== (6) STALE/FOREIGN SUCCESSOR ID — zero coverage before this card ====================
  {
    const e = makeDb(); dbFiles.push(e.dbFile);
    seedSession(e, "m6-old");
    seedSession(e, "m6-stale-successor"); // the successor the OLD unresolved event names
    e.db.appendEvent(unresolvedEvent("m6-old", "m6-stale-successor"));
    // The predecessor was reclaimed (recycled_from was nulled, then re-linked) onto a BRAND-NEW successor —
    // current successor is now m6-new, not the one the stale event names.
    seedSession(e, "m6-new", { gen: 2, recycledFrom: "m6-old" });
    check("(6) FIX: an unresolved event naming a successor that is NO LONGER current does NOT match: undefined",
      currentUnresolvedSettleSuccessor(e.db, "m6-old") === undefined);
  }

  // ==================== (7) THE DURABLE READY LATCH — Code Review round 2's main fix ====================
  {
    const e = makeDb(); dbFiles.push(e.dbFile);
    seedSession(e, "m7-old");
    seedSession(e, "m7-new", { gen: 1, recycledFrom: "m7-old" });
    e.db.appendEvent(unresolvedEvent("m7-old", "m7-new"));
    check("(7 setup) before the latch: matches (sanity, mirrors case (3))", currentUnresolvedSettleSuccessor(e.db, "m7-old")?.id === "m7-new");
    // The successor's onReady hook fires (Db.setReachedReady — the SAME durable write the real pty host
    // event handler makes) BEFORE settleRecycleHandoff's own next poll ever observes it and files
    // recycle_fleet_resolved. No superseding event exists yet — only the durable latch distinguishes this
    // from case (3).
    e.db.setReachedReady("m7-new");
    check("(7) FIX: once reachedReadyAt is set, the predicate is undefined EVEN WITH NO superseding event yet",
      currentUnresolvedSettleSuccessor(e.db, "m7-old") === undefined);
  }

  // ==================== (8) RESOLVED supersedes ====================
  {
    const e = makeDb(); dbFiles.push(e.dbFile);
    seedSession(e, "m8-old");
    seedSession(e, "m8-new", { gen: 1, recycledFrom: "m8-old" });
    e.db.appendEvent(unresolvedEvent("m8-old", "m8-new"));
    check("(8 setup) before resolution: matches", currentUnresolvedSettleSuccessor(e.db, "m8-old")?.id === "m8-new");
    e.db.appendEvent(resolvedEvent("m8-old", "m8-new"));
    check("(8) a chronologically-later recycle_fleet_resolved supersedes the unresolved alert: undefined",
      currentUnresolvedSettleSuccessor(e.db, "m8-old") === undefined);
  }

  // ==================== (9) RECOVERED supersedes ====================
  {
    const e = makeDb(); dbFiles.push(e.dbFile);
    seedSession(e, "m9-old");
    seedSession(e, "m9-new", { gen: 1, recycledFrom: "m9-old" });
    e.db.appendEvent(unresolvedEvent("m9-old", "m9-new"));
    check("(9 setup) before recovery: matches", currentUnresolvedSettleSuccessor(e.db, "m9-old")?.id === "m9-new");
    e.db.appendEvent(recoveredEvent("m9-old", "m9-new"));
    check("(9) a chronologically-later recycle_fleet_recovered supersedes the unresolved alert: undefined",
      currentUnresolvedSettleSuccessor(e.db, "m9-old") === undefined);
  }

  // ==================== (10) ORDER — events inserted OUT of chronological order ====================
  {
    const e = makeDb(); dbFiles.push(e.dbFile);
    seedSession(e, "m10-old");
    seedSession(e, "m10-new", { gen: 1, recycledFrom: "m10-old" });
    // Insert the RESOLVED (superseding) event FIRST (lower rowid) with an EARLIER ts; insert the
    // UNRESOLVED event SECOND (higher rowid) with a LATER ts. If the predicate (or listEventsForSession)
    // picked "latest" by insertion/rowid order rather than `ts`, .at(-1) would wrongly return the resolved
    // event and the predicate would wrongly match.
    e.db.appendEvent(resolvedEvent("m10-old", "m10-new", { ts: "2026-01-01T00:00:00.000Z" }));
    e.db.appendEvent(unresolvedEvent("m10-old", "m10-new", { ts: "2026-01-02T00:00:00.000Z" }));
    check("(10) FIX verified at source: events are returned ORDER BY ts (not insertion order)",
      e.db.listEventsForSession("m10-old").at(-1)?.kind === "recycle_fleet_unresolved");
    check("(10) the predicate correctly follows ts-order, not insertion order: matches",
      currentUnresolvedSettleSuccessor(e.db, "m10-old")?.id === "m10-new");
  }

  // ==================== (11) STRANDED supersedes ====================
  {
    const e = makeDb(); dbFiles.push(e.dbFile);
    seedSession(e, "m11-old");
    seedSession(e, "m11-new", { gen: 1, recycledFrom: "m11-old" });
    e.db.appendEvent(unresolvedEvent("m11-old", "m11-new"));
    check("(11 setup) before stranding: matches", currentUnresolvedSettleSuccessor(e.db, "m11-old")?.id === "m11-new");
    e.db.appendEvent(strandedEvent("m11-old", "m11-new"));
    check("(11) FIX: a chronologically-later recycle_fleet_stranded_across_restart supersedes the unresolved alert: undefined",
      currentUnresolvedSettleSuccessor(e.db, "m11-old") === undefined);
  }

  // ==================== (12) SHARED HELPER PARITY ====================
  {
    const e = makeDb(); dbFiles.push(e.dbFile);
    seedSession(e, "m12-old");
    seedSession(e, "m12-new", { gen: 1, recycledFrom: "m12-old" });
    e.db.appendEvent(unresolvedEvent("m12-old", "m12-new"));
    check("(12) latestMatchingUnresolvedSettleEvent matches the unresolved event on the positive baseline",
      latestMatchingUnresolvedSettleEvent(e.db, "m12-old", "m12-new")?.kind === "recycle_fleet_unresolved");
    check("(12) currentUnresolvedSettleSuccessor agrees (positive)", currentUnresolvedSettleSuccessor(e.db, "m12-old")?.id === "m12-new");
    e.db.appendEvent(resolvedEvent("m12-old", "m12-new"));
    check("(12) latestMatchingUnresolvedSettleEvent is undefined once resolved supersedes it",
      latestMatchingUnresolvedSettleEvent(e.db, "m12-old", "m12-new") === undefined);
    check("(12) currentUnresolvedSettleSuccessor agrees (superseded)", currentUnresolvedSettleSuccessor(e.db, "m12-old") === undefined);
  }
} finally {
  for (const f of dbFiles) { try { fs.rmSync(f, { force: true }); } catch { /* best-effort */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — currentUnresolvedSettleSuccessor matches only a timeout-reason, non-halted, current-successor-id recycle_fleet_unresolved event, stays undefined once a durable reachedReadyAt latch is set (even with no superseding event yet) or once a resolved/recovered/stranded event supersedes it, honors ts-order over insertion order, and the extracted latestMatchingUnresolvedSettleEvent helper agrees with it."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
