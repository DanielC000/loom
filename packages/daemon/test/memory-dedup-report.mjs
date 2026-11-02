import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

// Card 446d97f0 — "report likely-duplicate memory notes on a schedule, no LLM": the periodic sweep that
// reuses b1f34988's write-time near-duplicate signal, paired over the WHOLE corpus, filing/updating ONE
// board card per project for a human/lead to review. See docs/decisions/446d97f0-periodic-duplicate-report-
// sweep.md for the measured chunking cost + full design. Never auto-merges/deletes/rewrites a note.
//
// Covers (manager-reviewed DoD, card 446d97f0):
//   (1) chunked yielding — a multi-chunk sweep gives the event loop control back repeatedly, not once at
//       the very end (the event loop is never blocked for the WHOLE sweep).
//   (2) single-flight — a project already mid-sweep is skipped by a later tick, never swept concurrently
//       with itself.
//   (3) card create-then-update-in-place — the SAME card (same id) is reused across sweeps while open.
//   (4) a pair is "reviewed" (excluded) once its card is moved to a terminal column, and RESURFACES once
//       either note's version advances.
//   (5) duplicateReportIntervalHours:0 disables the sweep entirely for that project.
//   (6) no card is filed when a sweep finds zero candidate pairs.
//   (7) card 57a91801 follow-up — a pair is NEVER reported while either of its two notes is currently
//       expired, even though it still clears the exact same score+coverage gate.
//
// Run: 1) build (turbo builds shared first), 2) node test/memory-dedup-report.mjs

useOwnLoomHome("loom-mem-dedup-");

const { Db } = await import("../dist/db.js");
const { writeProjectMemory } = await import("../dist/mcp/memory.js");
const {
  findDuplicateReportCandidates, sweepProjectMemoryDuplicates,
  reportCardMetaKey, lastSweepMetaKey, REPORT_CARD_TITLE,
} = await import("../dist/sessions/project-memory-dedup-report.js");
const { MemoryDedupWatcher } = await import("../dist/orchestration/memory-dedup-watcher.js");
const { resolveConfig, columnKeyForRole } = await import("@loom/shared");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const db = new Db();
const now = new Date().toISOString();

// Shared vocab so bm25's IDF degenerates the same way the real corpus's does (mirrors b1f34988's own test
// fixture + the investigate-first benchmark) — filler notes alone must never false-fire.
function fillerNotes(db, projId, n) {
  for (let i = 0; i < n; i++) {
    writeProjectMemory(db, projId, {
      key: `filler-note-${i}`,
      text: `filler note number ${i} discusses completely unrelated matters about topic number ${i} ` +
        "with generic words like apple banana cherry date elderberry fig grape honeydew",
    });
  }
}

// Two DISJOINT-vocabulary templates (never just a swapped topic noun on a shared boilerplate — a prior
// version of this fixture did exactly that, and the shared generic words alone ["rollback", "deployment",
// "service", "config", "version", "restart script"] still cleared the near-duplicate gate ACROSS the two
// supposedly-independent pairs, exactly the "unusually dense, homogeneous... heavy shared vocabulary"
// hazard b1f34988's own decision record measured on the real corpus). Each template's own two notes (base
// + "-v2") share nearly all their wording with EACH OTHER and nothing load-bearing with the other template.
function writeNearDupPairFoo(db, projId, baseKey) {
  writeProjectMemory(db, projId, {
    key: `${baseKey}-rollback-procedure`,
    title: "Foo widget rollback procedure",
    text: "To roll back the foo widget deployment, stop the foo widget service, revert the foo widget " +
      "config file to the previous foo widget version, and restart the foo widget service using the foo " +
      "widget restart script.",
  });
  writeProjectMemory(db, projId, {
    key: `${baseKey}-rollback-procedure-v2`,
    text: "To roll back the foo widget deployment: stop the foo widget service, revert the foo widget " +
      "config file to the previous foo widget version, then restart the foo widget service with the foo " +
      "widget restart script.",
  });
  return [`${baseKey}-rollback-procedure`, `${baseKey}-rollback-procedure-v2`];
}

function writeNearDupPairBar(db, projId, baseKey) {
  writeProjectMemory(db, projId, {
    key: `${baseKey}-snapshot-restore`,
    title: "Bar widget snapshot restore",
    text: "To restore the bar widget database snapshot, pause the bar widget writer process, copy the " +
      "bar widget backup archive onto the live bar widget data volume, then resume the bar widget writer " +
      "process.",
  });
  writeProjectMemory(db, projId, {
    key: `${baseKey}-snapshot-restore-v2`,
    text: "To restore the bar widget database snapshot: pause the bar widget writer process, copy the " +
      "bar widget backup archive onto the live bar widget data volume, resume the bar widget writer " +
      "process afterward.",
  });
  return [`${baseKey}-snapshot-restore`, `${baseKey}-snapshot-restore-v2`];
}

try {
  // ===================== (6) no card when there are no candidates =====================
  {
    const projId = "proj-no-candidates";
    db.insertProject({ id: projId, name: "No Candidates", repoPath: now, vaultPath: now, config: {}, createdAt: now, archivedAt: null });
    fillerNotes(db, projId, 25);

    await sweepProjectMemoryDuplicates(db, projId, () => false, new Date());

    check("(6) no report card id is recorded for a project with zero candidates", db.getMeta(reportCardMetaKey(projId)) === undefined);
    check("(6) no task titled the report card title exists on the board",
      !db.listTasks(projId).some((t) => t.title === REPORT_CARD_TITLE));
    check("(6) the sweep still stamps lastSweep (it genuinely ran, just found nothing)", db.getMeta(lastSweepMetaKey(projId)) !== undefined);
  }

  // ===================== (7) card 57a91801 — an expired note's pair is never reported =====================
  {
    const projId = "proj-expired-pair";
    db.insertProject({ id: projId, name: "Expired Pair", repoPath: now, vaultPath: now, config: {}, createdAt: now, archivedAt: null });
    fillerNotes(db, projId, 25);
    const [keyA, keyB] = writeNearDupPairFoo(db, projId, "expiring-widget");

    // Sanity: BEFORE expiring anything, this pair genuinely clears the gate (positive control — proves the
    // exclusion below is about expiry, not about this fixture failing to pair at all).
    const { pairs: beforePairs } = await findDuplicateReportCandidates(db, projId, () => false, new Date());
    check("(7, positive control) the pair clears the near-duplicate gate BEFORE either note expires",
      beforePairs.some((p) => (p.keyA === keyA || p.keyA === keyB) && (p.keyB === keyA || p.keyB === keyB)));

    // Expire ONE of the two notes (a past date) via an ordinary update — the OTHER note is untouched.
    const expired = writeProjectMemory(db, projId, { key: keyB, baseVersion: 1, expiresAt: "2020-01-01" });
    check("(7, setup) the expiry update itself succeeds", !("error" in expired));

    await sweepProjectMemoryDuplicates(db, projId, () => false, new Date());
    check("(7) no report card is filed — the pair's only candidate involves a now-expired note",
      db.getMeta(reportCardMetaKey(projId)) === undefined);

    // Negative control, inverse direction: a FUTURE expiresAt must NOT exclude the pair — only an already-
    // PAST one does. Same shape, same baseVersion bump, different project so it starts from a clean slate.
    const projId2 = "proj-future-expiry-pair";
    db.insertProject({ id: projId2, name: "Future Expiry Pair", repoPath: now, vaultPath: now, config: {}, createdAt: now, archivedAt: null });
    fillerNotes(db, projId2, 25);
    const [keyC, keyD] = writeNearDupPairFoo(db, projId2, "future-widget");
    writeProjectMemory(db, projId2, { key: keyD, baseVersion: 1, expiresAt: "2099-01-01" });
    await sweepProjectMemoryDuplicates(db, projId2, () => false, new Date());
    const futureCardId = db.getMeta(reportCardMetaKey(projId2));
    check("(7, negative control) a FUTURE expiresAt does NOT exclude the pair — a report card IS filed",
      futureCardId !== undefined);
    check("(7, negative control) that card names both notes of the not-yet-expired pair",
      db.getTask(futureCardId).body.includes(keyC) && db.getTask(futureCardId).body.includes(keyD));
  }

  // ===================== (3) card create-then-update-in-place =====================
  let createThenUpdateProjId;
  let firstCardId;
  {
    const projId = "proj-create-then-update";
    createThenUpdateProjId = projId;
    db.insertProject({ id: projId, name: "Create Then Update", repoPath: now, vaultPath: now, config: {}, createdAt: now, archivedAt: null });
    fillerNotes(db, projId, 25);
    const [keyA, keyB] = writeNearDupPairFoo(db, projId, "foo-widget");

    await sweepProjectMemoryDuplicates(db, projId, () => false, new Date());
    const cardId1 = db.getMeta(reportCardMetaKey(projId));
    check("(3) a report card id is recorded after the first sweep finds a candidate pair", cardId1 !== undefined);
    const card1 = cardId1 ? db.getTask(cardId1) : undefined;
    check("(3) the card exists on the board with the conventional title", card1?.title === REPORT_CARD_TITLE);
    check("(3) the card body names both notes of the discovered pair", !!card1?.body.includes(keyA) && !!card1?.body.includes(keyB));
    firstCardId = cardId1;

    // A SECOND sweep, same project, card still open (no human has touched it) — a NEW, unrelated near-dup
    // pair appears. The SAME card id must be reused (updated in place), never a second card.
    const [keyC, keyD] = writeNearDupPairBar(db, projId, "bar-widget");
    await sweepProjectMemoryDuplicates(db, projId, () => false, new Date());
    const cardId2 = db.getMeta(reportCardMetaKey(projId));
    check("(3) a second sweep against the SAME still-open card reuses the SAME card id (updated in place, never a new card)",
      cardId2 === cardId1);
    const card2 = db.getTask(cardId2);
    check("(3) the updated-in-place body now ALSO names the newly-discovered second pair",
      card2.body.includes(keyC) && card2.body.includes(keyD));
    check("(3) the updated-in-place body STILL names the original pair (never discarded on update)",
      card2.body.includes(keyA) && card2.body.includes(keyB));
    check("(3) exactly ONE task exists on this project's board (never one card per run)",
      db.listTasks(projId).filter((t) => t.title === REPORT_CARD_TITLE).length === 1);
  }

  // ===================== (4) reviewed-until-version-bump =====================
  {
    const projId = createThenUpdateProjId; // reuse (3)'s project — its card already lists foo-widget's pair
    const cols = resolveConfig(db.getProject(projId).config).kanbanColumns;
    const terminalKey = columnKeyForRole(cols, "terminal");
    const openCardId = db.getMeta(reportCardMetaKey(projId));

    // A human reviews + closes the card (moves it to the terminal column) WITHOUT changing any note.
    db.updateTask(openCardId, { columnKey: terminalKey });

    // A sweep with NOTHING changed: both pairs are now "reviewed" (closed card, versions match) — no
    // new/updated card should appear at all.
    await sweepProjectMemoryDuplicates(db, projId, () => false, new Date());
    check("(4) after the card is closed with no note changes, the tracked card id is left untouched (no new card filed)",
      db.getMeta(reportCardMetaKey(projId)) === openCardId);
    const closedCard = db.getTask(openCardId);
    check("(4) the closed card itself is never rewritten by a later sweep", closedCard.columnKey === terminalKey);

    // Now bump ONE of the foo-widget pair's two notes' version (an ordinary content edit) and sweep again —
    // that specific pair must resurface because its stored version no longer matches.
    const edited = writeProjectMemory(db, projId, {
      key: "foo-widget-rollback-procedure-v2",
      text: "To roll back the foo widget deployment (EDITED): stop the foo widget service, revert the foo " +
        "widget config file to the previous foo widget version, then restart the foo widget service with " +
        "the foo widget restart script.",
      baseVersion: 1,
    });
    check("(4, setup) the edit itself succeeds and bumps the note's version", !("error" in edited) && edited.version > 1);

    await sweepProjectMemoryDuplicates(db, projId, () => false, new Date());
    const afterEditCardId = db.getMeta(reportCardMetaKey(projId));
    check("(4) a version bump on one note of a reviewed pair re-points to a FRESH card (the old one stays closed)",
      afterEditCardId !== openCardId);
    const freshCard = db.getTask(afterEditCardId);
    check("(4) the fresh card names the resurfaced (version-bumped) pair",
      freshCard.body.includes("foo-widget-rollback-procedure") && freshCard.body.includes("foo-widget-rollback-procedure-v2"));
    check("(4) the fresh card does NOT re-list the OTHER pair (bar-widget), which is still genuinely reviewed",
      !freshCard.body.includes("bar-widget-snapshot-restore"));
  }

  // ===================== (5) duplicateReportIntervalHours:0 disables the sweep entirely =====================
  {
    const projId = "proj-interval-off";
    db.insertProject({
      id: projId, name: "Interval Off", repoPath: now, vaultPath: now,
      config: { memory: { duplicateReportIntervalHours: 0 } }, createdAt: now, archivedAt: null,
    });
    fillerNotes(db, projId, 5);
    writeNearDupPairFoo(db, projId, "disabled-widget");

    const watcher = new MemoryDedupWatcher({ db });
    await watcher.tick(new Date());

    check("(5) a project with duplicateReportIntervalHours:0 is never swept by the watcher's own tick",
      db.getMeta(lastSweepMetaKey(projId)) === undefined);
    check("(5) ...and so never gets a report card either, despite a real candidate pair existing",
      db.getMeta(reportCardMetaKey(projId)) === undefined);
  }

  // ===================== (2) single-flight — a project already in-flight is skipped =====================
  {
    const dueProjId = "proj-single-flight-due";
    db.insertProject({
      id: dueProjId, name: "Single Flight Due", repoPath: now, vaultPath: now,
      config: { memory: { duplicateReportIntervalHours: 1 } }, createdAt: now, archivedAt: null,
    });
    fillerNotes(db, dueProjId, 5);

    // Baseline (no pre-existing in-flight marker): a genuinely due project IS swept by tick().
    const watcherBaseline = new MemoryDedupWatcher({ db, intervalMs: 999_999_999 });
    await watcherBaseline.tick(new Date());
    check("(2, baseline) a due project with no in-flight sweep IS swept by tick()",
      db.getMeta(lastSweepMetaKey(dueProjId)) !== undefined);

    const guardedProjId = "proj-single-flight-guarded";
    db.insertProject({
      id: guardedProjId, name: "Single Flight Guarded", repoPath: now, vaultPath: now,
      config: { memory: { duplicateReportIntervalHours: 1 } }, createdAt: now, archivedAt: null,
    });
    fillerNotes(db, guardedProjId, 5);

    // Simulate "already mid-sweep" by pre-populating the watcher's own in-flight set (TS `private` is
    // erased at runtime — this is the SAME established pattern this project's tests already use to reach
    // an internal field directly, e.g. db.db.prepare in the investigate-first benchmark).
    const watcherGuarded = new MemoryDedupWatcher({ db, intervalMs: 999_999_999 });
    watcherGuarded.inFlight.add(guardedProjId);
    await watcherGuarded.tick(new Date());
    check("(2) a project already marked in-flight is SKIPPED by tick() — never swept concurrently with itself",
      db.getMeta(lastSweepMetaKey(guardedProjId)) === undefined);
  }

  // ===================== (1) chunked yielding — the event loop is never blocked for the WHOLE sweep =====================
  {
    const projId = "proj-chunked-yield";
    db.insertProject({ id: projId, name: "Chunked Yield", repoPath: now, vaultPath: now, config: {}, createdAt: now, archivedAt: null });
    // Dense enough (shared-vocab-heavy, like the real corpus — see b1f34988's own decision record) and
    // numerous enough that the sweep spans multiple CHUNK_BUDGET_MS windows, not one synchronous burst.
    const SHARED = ["gate", "worker", "manager", "evidence", "measured", "verify", "control", "merge",
      "branch", "report", "session", "card", "project", "memory", "scope", "claim", "fact", "check"];
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let i = 0; i < 180; i++) {
      const words = [];
      while (words.join(" ").length < 500) words.push(SHARED[Math.floor(rnd() * SHARED.length)] + (i % 5));
      writeProjectMemory(db, projId, { key: `dense-note-${i}`, text: words.join(" ") });
    }

    let yieldCount = 0;
    let sweeping = true;
    const countYields = () => { yieldCount++; if (sweeping) setImmediate(countYields); };
    setImmediate(countYields);

    const sweepStart = performance.now();
    const { stopped } = await findDuplicateReportCandidates(db, projId, () => false);
    const sweepMs = performance.now() - sweepStart;
    sweeping = false;

    check("(1, setup) the sweep over a dense 180-note corpus completed without being stopped", stopped === false);
    check(`(1) the event loop regained control MULTIPLE times during the sweep (yieldCount=${yieldCount}, sweepMs=${sweepMs.toFixed(0)}) — not blocked for the whole duration`,
      yieldCount > 1);
  }
} catch (err) {
  console.error(err);
  failures++;
} finally {
  db.close();
}

if (failures > 0) {
  console.log(`\n❌ ${failures} FAILURE(S)`);
} else {
  console.log(
    "\n✅ ALL PASS — the periodic duplicate-report sweep (card 446d97f0) chunks its O(N) pairing pass off " +
    "the event loop (proven via a real multi-chunk yield count, not a fixed wait), enforces per-project " +
    "single-flight, creates ONE board card then updates it in place across sweeps while open, excludes a " +
    "pair only once its card is closed AND re-surfaces it the moment either note's version advances, " +
    "honors duplicateReportIntervalHours:0 as a hard off-switch, and files no card at all when a sweep " +
    "finds zero candidates. Against the REAL compiled db.ts + mcp/memory.ts + " +
    "sessions/project-memory-dedup-report.ts + orchestration/memory-dedup-watcher.ts, claude-free, network-free.",
  );
}
process.exit(failures === 0 ? 0 : 1);
