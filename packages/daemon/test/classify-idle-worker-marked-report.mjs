// Regression test for card 78e4b3f2 — `classifyIdleWorker`'s "is a worker-report already queued for the
// manager" guard (sessions/service.ts, ~:7478) must still recognize a `[loom:worker-report]` notification
// once it carries a leading possible-duplicate tag, not just its own bare prefix.
//
// WHY THIS IS REACHABLE: `workerReport()` delivers via `enqueueDurableMessage` (kind:"agent"), so a
// worker-report notification is subject to the SAME give-up/cross-remint machinery as any other durable
// message — if it exhausts its in-session budget, `handleGiveUpExhausted`'s remint call frames the text
// with `[loom:possible-duplicate root:...]` AHEAD of `[loom:worker-report]`, baked in at the moment the
// re-mint is CREATED (unlike a plain in-session requeue, which stays pristine until actual redrain — see
// framePossibleDuplicate's own doc, pty/host.ts). Missing this would let `classifyIdleWorker` conclude
// "no report is pending" for a worker whose report genuinely IS queued (just tagged) — falsely classifying
// it `stranded` and prompting a manager nudge for work that's already in flight.
//
// Reuses the lightweight fake-pty + real Db + real SessionService pattern from
// worker-idle-background-park.mjs (no real PtyHost/daemon needed) — `getPendingEntries` is made
// configurable per-recipient so this test can construct the exact marked-queue shape without driving a
// full give-up cycle (already covered by the give-up-family suite).
//
// RUN (no daemon needed): node test/classify-idle-worker-marked-report.mjs
//   Requires the daemon built first (reads ../dist/*.js): from packages/daemon, run `pnpm build`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "../dist/db.js";
import { SessionService } from "../dist/sessions/service.js";
import { OrchestrationControl } from "../dist/orchestration/control.js";
import { framePossibleDuplicate } from "../dist/pty/host.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const NOW = new Date("2026-08-01T12:00:00.000Z");

function makeEnv() {
  const dbFile = path.join(os.tmpdir(), `loom-ciw-marked-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Db(dbFile);
  const projId = `ciwm-${Math.random().toString(36).slice(2, 8)}`;
  const agentId = `ciwma-${Math.random().toString(36).slice(2, 8)}`;
  const now = NOW.toISOString();
  db.insertProject({ id: projId, name: "ClassifyMarked", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });

  const alive = new Set();
  const enqueued = [];
  const pendingByRecipient = new Map();
  const pty = {
    isAlive: (id) => alive.has(id),
    enqueueStdin: (id, text) => {
      enqueued.push({ id, text });
      const s = db.getSession(id);
      return s?.processState === "live" ? { delivered: true } : { delivered: false, position: 1 };
    },
    getPendingEntries: (id) => pendingByRecipient.get(id) ?? [],
  };
  const control = new OrchestrationControl();
  const sessions = new SessionService(db, pty, control);
  return { dbFile, db, projId, agentId, alive, enqueued, sessions, pendingByRecipient };
}

function seedManager(e, id) {
  e.db.insertSession({
    id, projectId: e.projId, agentId: e.agentId, engineSessionId: "eng-" + id, title: null, cwd: e.projId,
    processState: "live", resumability: "resumable", busy: false,
    createdAt: NOW.toISOString(), lastActivity: NOW.toISOString(), lastError: null, role: "manager",
    ctxInputTokens: null, ctxTurns: null, model: null,
  });
  e.alive.add(id);
}
function seedWorker(e, id, parentId, taskId) {
  e.db.insertSession({
    id, projectId: e.projId, agentId: e.agentId, engineSessionId: "eng-" + id, title: null, cwd: e.projId,
    processState: "live", resumability: "resumable", busy: false,
    createdAt: NOW.toISOString(), lastActivity: NOW.toISOString(), lastError: null, role: "worker",
    parentSessionId: parentId, taskId, ctxInputTokens: null, ctxTurns: null, model: null,
  });
  e.alive.add(id);
}
function seedTask(e, id, columnKey = "in_progress") {
  e.db.insertTask({ id, projectId: e.projId, title: "T-" + id, body: "", columnKey, position: 0, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() });
}
function cleanup(e) {
  try { e.db.close(); } catch { /* ignore */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(e.dbFile + ext, { force: true }); } catch { /* ignore */ } }
}

// ============ (1) THE FIX: a MARKED worker-report notification is still recognized as pending ==========
{
  const e = makeEnv();
  seedManager(e, "mgr-1");
  seedTask(e, "tk-1", "in_progress");
  seedWorker(e, "wkr-1", "mgr-1", "tk-1");

  const plainReport = `[loom:worker-report] worker wkr-1 (task tk-1) — done: shipped the fix`;
  const markedReport = framePossibleDuplicate(plainReport, "deadbeef-fake-root");
  check("setup: the marked report genuinely carries the tag ahead of its own prefix",
    markedReport.startsWith("[loom:possible-duplicate root:") && !markedReport.startsWith("[loom:worker-report]"));
  e.pendingByRecipient.set("mgr-1", [{ text: markedReport }]);

  const cls = e.sessions.classifyIdleWorker("wkr-1");
  check("(1) THE FIX: a MARKED pending worker-report is recognized — classified not-stranded, never a false strand",
    cls.kind === "not-stranded");
  cleanup(e);
}

// ============ (2) POSITIVE CONTROL: with NOTHING queued, the SAME worker genuinely IS stranded ==========
// (proves check (1) isn't vacuously true regardless of queue contents)
{
  const e = makeEnv();
  seedManager(e, "mgr-2");
  seedTask(e, "tk-2", "in_progress");
  seedWorker(e, "wkr-2", "mgr-2", "tk-2");
  // pendingByRecipient left empty for mgr-2 — nothing queued, no report event, no wake.

  const cls = e.sessions.classifyIdleWorker("wkr-2");
  check("(2) POSITIVE CONTROL: with nothing queued and no report/wake, the worker IS genuinely stranded",
    cls.kind === "stranded");
  cleanup(e);
}

// ============ (3) UNCHANGED: an UNMARKED worker-report notification is still recognized (unaffected) =====
{
  const e = makeEnv();
  seedManager(e, "mgr-3");
  seedTask(e, "tk-3", "in_progress");
  seedWorker(e, "wkr-3", "mgr-3", "tk-3");
  const plainReport = `[loom:worker-report] worker wkr-3 (task tk-3) — done: shipped the fix`;
  e.pendingByRecipient.set("mgr-3", [{ text: plainReport }]);

  const cls = e.sessions.classifyIdleWorker("wkr-3");
  check("(3) UNCHANGED: an unmarked pending worker-report is still recognized — not-stranded (byte-identical to before this card)",
    cls.kind === "not-stranded");
  cleanup(e);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — classifyIdleWorker's pending-worker-report guard recognizes a possible-duplicate-tagged notification (card 78e4b3f2's marking feature does not defeat the guard it would otherwise silently break), a genuinely empty queue still correctly classifies stranded (the check isn't vacuous), and the pre-existing unmarked case is unregressed."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
