import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 9c8e256e: the [loom:idle] nudge carries no delta digest — every park cycle forced a full board
// re-read to conclude nothing changed. FIX: idle-watcher.ts now appends a board-read.ts delta digest to
// EVERY nudge variant, anchored to the RECIPIENT'S OWN last genuine tasks_list read (recorded via
// app_meta — no db.ts schema change; see board-read.ts) rather than a wall-clock window.
//
// HERMETIC, CLAUDE-FREE: mirrors idle-watcher.mjs's harness — a recording pty stub, tick() driven
// directly, a REAL Db (temp file). recordBoardRead/computeBoardDelta are called directly (the SAME
// functions mcp/server.ts's tasks_list handler calls on a real read — see
// tasks-list-records-board-read.mjs for that wiring) to stand in for "the manager called tasks_list".
//
// Proves, in POSITIVE-then-NEGATIVE order (per /worker doctrine: prove the instrument can say something
// non-empty before trusting an empty result):
//   (1) NOT-COMPUTED: no snapshot recorded yet ⇒ the nudge says so explicitly, and NEVER in wording that
//       could be mistaken for a measured "0 changes" (DoD-3).
//   (2) NON-EMPTY (positive control): after a snapshot, mutate the board (1 create, 1 move, 1
//       re-prioritize) ⇒ the nudge names all three kinds, each with its card's id.
//   (3) EMPTY-COMPUTED: re-snapshot against the now-current board, tick again with no further changes ⇒
//       "0 changes" — a MEASURED zero, textually distinct from case (1)'s "not computed".
//   (4) Anchored to the RECIPIENT'S OWN last read, not a wall-clock window: two managers on the SAME
//       project, snapshotted at different moments, get DIFFERENT deltas for the SAME live board.
//   (5) Task.updatedAt is NOT how a move/re-prioritization is detected — Db.updateTask (db.ts) bumps
//       updatedAt on EVERY patch (held/deferred/repoKey/merged* writes included), so "updatedAt changed"
//       can't tell you WHICH field changed. An unrelated field write (held) that bumps updatedAt but
//       touches neither columnKey nor priority must NOT be misreported as a move or re-prioritization.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "../dist/db.js";
import { IdleWatcher } from "../dist/orchestration/idle-watcher.js";
import { OrchestrationControl } from "../dist/orchestration/control.js";
import { recordBoardRead } from "../dist/orchestration/board-read.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const NOW = new Date("2026-08-25T12:00:00.000Z");
const minutesAgo = (m) => new Date(NOW.getTime() - m * 60_000).toISOString();

function makeEnv() {
  const dbFile = path.join(os.tmpdir(), `loom-idle-bd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Db(dbFile);
  const projId = `ip-${Math.random().toString(36).slice(2, 8)}`;
  const agentId = `it-${Math.random().toString(36).slice(2, 8)}`;
  const now = NOW.toISOString();
  db.insertProject({ id: projId, name: "BD", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });
  const alive = new Set();
  const enqueued = [];
  const pty = {
    isAlive: (id) => alive.has(id),
    enqueueStdin: (id, text) => { enqueued.push({ id, text }); return { delivered: true }; },
  };
  const control = new OrchestrationControl();
  const watcher = new IdleWatcher({
    db, pty, control, recycleRatio: 0.8,
    notifyIdleWorker: () => {}, isWorkerStranded: () => true,
  });
  return { dbFile, db, projId, agentId, alive, enqueued, control, watcher };
}

function seedManager(e, id, { idleMin = 60 } = {}) {
  e.db.insertSession({
    id, projectId: e.projId, agentId: e.agentId, engineSessionId: "eng-" + id, title: null, cwd: e.projId,
    processState: "live", resumability: "resumable", busy: false,
    createdAt: minutesAgo(idleMin), lastActivity: minutesAgo(idleMin), lastError: null, role: "manager",
  });
  e.alive.add(id);
}

function seedCard(e, id, columnKey, priority = "p2", title = id) {
  e.db.insertTask({ id, projectId: e.projId, title, body: "", columnKey, priority, position: 0, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() });
}

function cleanup(e) {
  try { e.db.close(); } catch { /* ignore */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(e.dbFile + ext, { force: true }); } catch { /* ignore */ } }
}

function digestOf(e, mgrId) {
  const nudge = e.enqueued.find((m) => m.id === mgrId);
  const m = nudge?.text.match(/\[loom:board-delta\].*?(?=\s*\[loom:idle-nudge-bounded\]|$)/s);
  return m ? m[0] : nudge?.text;
}

// ============================ (1) NOT-COMPUTED — no snapshot recorded yet ============================
{
  const e = makeEnv();
  seedManager(e, "mgr-never-read");
  seedCard(e, "tk-a", "todo");
  e.watcher.tick(NOW);
  const digest = digestOf(e, "mgr-never-read");
  check("(1) nudge fired", e.enqueued.length === 1);
  check("(1) digest says NOT COMPUTED", /not computed/i.test(digest ?? ""));
  check("(1) NOT-COMPUTED text never reads as a measured zero", !/0 changes/i.test(digest ?? ""));
  cleanup(e);
}

// ======================= (2) POSITIVE CONTROL — a real, non-empty delta ================================
{
  const e = makeEnv();
  seedManager(e, "mgr-changes");
  seedCard(e, "tk-keep", "todo", "p2");     // untouched after the snapshot
  seedCard(e, "tk-move", "todo", "p2");     // will MOVE column
  seedCard(e, "tk-repr", "todo", "p1");     // will be RE-PRIORITIZED
  recordBoardRead(e.db, "mgr-changes", e.projId, minutesAgo(30));

  seedCard(e, "tk-new", "todo");                          // CREATED since the read
  e.db.updateTask("tk-move", { columnKey: "in_progress" }); // MOVED
  e.db.updateTask("tk-repr", { priority: "p0" });           // RE-PRIORITIZED

  e.watcher.tick(NOW);
  const digest = digestOf(e, "mgr-changes") ?? "";
  check("(2) nudge fired", e.enqueued.length === 1);
  check("(2) digest names the created card", /1 created/.test(digest) && digest.includes("tk-new".slice(0, 8)));
  check("(2) digest names the moved card", /1 moved/.test(digest) && digest.includes("tk-move".slice(0, 8)));
  check("(2) digest names the re-prioritised card", /1 re-prioritised/.test(digest) && digest.includes("tk-repr".slice(0, 8)));
  check("(2) the untouched card is NOT listed as changed", !digest.includes("tk-keep".slice(0, 8)));
  cleanup(e);
}

// =========================== (3) EMPTY-COMPUTED — a genuine, measured zero =============================
{
  const e = makeEnv();
  seedManager(e, "mgr-quiet");
  seedCard(e, "tk-a", "todo");
  seedCard(e, "tk-b", "in_progress", "p1");
  recordBoardRead(e.db, "mgr-quiet", e.projId, minutesAgo(5)); // snapshot AFTER seeding, board now unchanged

  e.watcher.tick(NOW);
  const digest = digestOf(e, "mgr-quiet") ?? "";
  check("(3) nudge fired", e.enqueued.length === 1);
  check("(3) digest reports a MEASURED zero", /0 changes/i.test(digest));
  check("(3) empty-computed text is NOT phrased as not-computed", !/not computed/i.test(digest));
  cleanup(e);
}

// ============ (4) anchored to the RECIPIENT'S OWN last read, never a wall-clock window ==================
{
  const e = makeEnv();
  seedManager(e, "mgr-early-reader");
  seedManager(e, "mgr-late-reader");
  seedCard(e, "tk-shared", "todo", "p2");

  // Early reader snapshots BEFORE the move; late reader snapshots AFTER it. Same live board, same instant.
  recordBoardRead(e.db, "mgr-early-reader", e.projId, minutesAgo(20));
  e.db.updateTask("tk-shared", { columnKey: "in_progress" });
  recordBoardRead(e.db, "mgr-late-reader", e.projId, minutesAgo(5));

  e.watcher.tick(NOW);
  const early = digestOf(e, "mgr-early-reader") ?? "";
  const late = digestOf(e, "mgr-late-reader") ?? "";
  check("(4) the early reader (missed the move) sees it as a delta", /1 moved/.test(early));
  check("(4) the late reader (already saw the move) sees a clean 0-change delta for the SAME board", /0 changes/i.test(late));
  cleanup(e);
}

// === (5) an unrelated field write (held) bumps updatedAt too — must NOT be misreported as a move/re-prio ===
{
  const e = makeEnv();
  seedManager(e, "mgr-unrelated-touch");
  seedCard(e, "tk-y", "todo", "p2");
  seedCard(e, "tk-other", "in_progress", "p2"); // keeps the board actionable even once tk-y is held
  recordBoardRead(e.db, "mgr-unrelated-touch", e.projId, minutesAgo(15));
  const before = e.db.getTask("tk-y");
  e.db.updateTask("tk-y", { held: true }); // unrelated field — same columnKey, same priority
  const after = e.db.getTask("tk-y");
  check("(5) sanity: an UNRELATED field write also bumps updatedAt (confirms updatedAt can't discriminate WHICH field changed)",
    before.updatedAt !== after.updatedAt);

  e.watcher.tick(NOW);
  const digest = digestOf(e, "mgr-unrelated-touch") ?? "";
  check("(5) the digest reports a clean 0-change delta despite updatedAt having ticked for an unrelated field",
    /0 changes/i.test(digest) && !digest.includes("tk-y"));
  cleanup(e);
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
