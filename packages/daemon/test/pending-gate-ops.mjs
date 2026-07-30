import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// pending_gate_ops durable TOMBSTONE (card edc1ec12, Platform-Audit finding 7afa6ea9 — the restart-orphan-
// signaling gap; generalized by card e3e40167 into a permanent, queryable record). PendingOpRegistry is
// purely in-memory and is wiped by a real daemon process death; this is the DURABLE complement that
// survives it, AND (since e3e40167) the thing that lets a settled op's opId stay distinguishable from one
// that never existed, even long after PendingOpRegistry itself has evicted it. Proves:
//   (1a) SCHEMA CREATE (the EASY case, owner's schema-change discipline: exercise against a real
//        pre-existing DB, not just a fresh one): pending_gate_ops is created on an EXISTING (pre-card) DB
//        at open — not just a fresh install — confirmed against a real on-disk DB that genuinely lacks the
//        table entirely.
//   (1b) SCHEMA UPGRADE (the HARD case — the one that actually bites): a pre-existing DB that ALREADY HAS
//        pending_gate_ops in its ORIGINAL 7-column shape (op_id/kind/key/owner_session_id/task_id/branch/
//        started_at — no project_id/state/surfaced_pending) gains the three added columns via ALTER TABLE
//        on open, with the correct backfill: state='pending', surfaced_pending=1 (NOT 0 — see the schema
//        doc for why a legacy row's mere pre-existence must read as "surfaced pending" under the new
//        column), project_id=NULL. `CREATE TABLE IF NOT EXISTS` alone is a silent no-op against this shape
//        (per project memory verify-schema-change-against-upgraded-db) — this is the case that would ship
//        green without the explicit migratePendingGateOps() ALTER.
//   (2) CRUD: insertPendingGateOp/markPendingGateOpSurfaced/settlePendingGateOp/evictPendingGateOpDeadOwner/
//       markPendingGateOpOrphaned/listPendingGateOps/listSurfacedPendingGateOps/findPendingGateOpByOpId all
//       round-trip correctly; re-inserting the SAME op_id upserts in place rather than duplicating; every
//       terminal transition UPDATES the row (never deletes it) — the row survives its own terminal state.
//   (3) reconcileOrphanedGateOps: a row that is BOTH surfaced_pending AND still state='pending' pushes the
//       correct synthetic terminal nudge to its owning session and is marked 'orphaned-by-restart' (NOT
//       deleted) — for BOTH "gate" (to the worker) and "merge" (to the manager) kinds. A row that already
//       settled (state='settled') before the simulated crash is correctly EXCLUDED from the sweep and gets
//       NO synthetic failure nudge — the exact inversion of card edc1ec12's signal that mint-on-create would
//       cause if the sweep selected every surviving row instead of only the surfaced+pending ones.
//   (4) END-TO-END via the REAL runWorkerGate (not just the generic PendingOpRegistry hook in
//       pending-ops-registry.mjs — this proves the actual service.ts wiring): a durable row EXISTS (state
//       'pending', surfaced_pending true) while the op is genuinely pending, and moves to state='settled'
//       (never deleted) the moment the op settles normally — proving a normal completion leaves a
//       positively-queryable "this op existed and settled" record, not a hole indistinguishable from
//       "never existed".
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/pending-gate-ops.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import Database from "better-sqlite3";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(predicate, timeoutMs, intervalMs = 200) {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    if (predicate()) return true;
    await sleep(intervalMs);
  }
  return predicate();
}

const tmpHome = path.join(os.tmpdir(), `loom-pgo-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree, removeWorktree } = await import("../dist/git/worktrees.js");

const GIT_ID = "-c user.email=pgo@loom -c user.name=pgo";
const now = new Date().toISOString();

class SeamHost extends PtyHost {
  createPty() { return { pid: 4242, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} }; }
}
class SpyHost extends SeamHost {
  enqueueCalls = [];
  enqueueStdin(sessionId, text, source, onDeliver, route, kind, questionId) {
    this.enqueueCalls.push({ sessionId, text, kind });
    return super.enqueueStdin(sessionId, text, source, onDeliver, route, kind, questionId);
  }
}

// ===== (1a) SCHEMA CREATE: a pre-existing DB with NO pending_gate_ops table at all gains it on open =====
const createDbFile = path.join(tmpHome, "create.db");
{
  const raw = new Database(createDbFile);
  raw.pragma("journal_mode = WAL");
  // A minimal but real pre-existing DB shape — sessions/projects/agents only, no pending_gate_ops
  // whatsoever (mirrors any real DB from before card edc1ec12 ever shipped).
  raw.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_path TEXT NOT NULL, vault_path TEXT NOT NULL, config_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, archived_at TEXT);
    CREATE TABLE agents (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), name TEXT NOT NULL, startup_prompt TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), agent_id TEXT NOT NULL REFERENCES agents(id), engine_session_id TEXT, title TEXT, cwd TEXT NOT NULL, process_state TEXT NOT NULL DEFAULT 'none', resumability TEXT NOT NULL DEFAULT 'unknown', busy INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, last_activity TEXT NOT NULL, last_error TEXT, role TEXT);
  `);
  const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  check("(1a) precondition: the legacy DB genuinely has NO pending_gate_ops table", !tables.includes("pending_gate_ops"));
  raw.close();
}
{
  let ctorError = null;
  let createdDb;
  try { createdDb = new Db(createDbFile); } catch (err) { ctorError = err; }
  check("(1a) constructing Db against the table-less pre-existing DB does not throw", ctorError === null);
  if (!ctorError) {
    const raw2 = new Database(createDbFile, { readonly: true });
    const tables = raw2.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    check("(1a) pending_gate_ops now exists on the upgraded (table-less) DB", tables.includes("pending_gate_ops"));
    const cols = raw2.prepare("PRAGMA table_info(pending_gate_ops)").all().map((c) => c.name);
    check("(1a) the FRESH table has all 10 columns, including the three added ones", ["project_id", "state", "surfaced_pending"].every((c) => cols.includes(c)));
    raw2.close();
  }
  try { createdDb?.close(); } catch { /* ignore */ }
}

// ===== (1b) SCHEMA UPGRADE, the HARD case: a pre-existing DB with the ORIGINAL 7-column pending_gate_ops
// table (no project_id/state/surfaced_pending) — the shape CREATE TABLE IF NOT EXISTS cannot fix. Per
// project memory verify-schema-change-against-upgraded-db: boot-test against a copy of a real
// pre-migration table shape, not just a table-less DB (that's the easy case proven in (1a) above). =====
const upgradeDbFile = path.join(tmpHome, "upgrade.db");
{
  const raw = new Database(upgradeDbFile);
  raw.pragma("journal_mode = WAL");
  raw.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_path TEXT NOT NULL, vault_path TEXT NOT NULL, config_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, archived_at TEXT);
    CREATE TABLE agents (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), name TEXT NOT NULL, startup_prompt TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), agent_id TEXT NOT NULL REFERENCES agents(id), engine_session_id TEXT, title TEXT, cwd TEXT NOT NULL, process_state TEXT NOT NULL DEFAULT 'none', resumability TEXT NOT NULL DEFAULT 'unknown', busy INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, last_activity TEXT NOT NULL, last_error TEXT, role TEXT);
    CREATE TABLE pending_gate_ops (
      op_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      key TEXT NOT NULL,
      owner_session_id TEXT NOT NULL,
      task_id TEXT,
      branch TEXT,
      started_at TEXT NOT NULL
    );
  `);
  // A leftover row from BEFORE this card — under the OLD semantics its mere existence meant "surfaced
  // pending"; there is no state/surfaced_pending/project_id column to read at all yet.
  raw.prepare(
    "INSERT INTO pending_gate_ops (op_id,kind,key,owner_session_id,task_id,branch,started_at) VALUES (?,?,?,?,?,?,?)",
  ).run("legacy-op-1", "gate", "gate:legacy-worker", "legacy-worker", "legacy-task", "loom/legacy-task", now);
  const cols = raw.prepare("PRAGMA table_info(pending_gate_ops)").all().map((c) => c.name);
  check("(1b) precondition: the pre-existing table genuinely has ONLY the original 7 columns", cols.length === 7 && !cols.includes("state") && !cols.includes("project_id") && !cols.includes("surfaced_pending"));
  raw.close();
}
{
  let ctorError = null;
  let upgradedDb;
  try { upgradedDb = new Db(upgradeDbFile); } catch (err) { ctorError = err; }
  check("(1b) constructing Db against the 7-column pre-existing DB does not throw", ctorError === null);
  if (!ctorError) {
    const raw2 = new Database(upgradeDbFile, { readonly: true });
    const cols = raw2.prepare("PRAGMA table_info(pending_gate_ops)").all().map((c) => c.name);
    check("(1b) the ALTER added all three new columns to the EXISTING table (not silently skipped)", ["project_id", "state", "surfaced_pending"].every((c) => cols.includes(c)));
    raw2.close();

    const legacyRows = upgradedDb.listPendingGateOps();
    check("(1b) the pre-existing row survives the ALTER (data preserved)", legacyRows.length === 1 && legacyRows[0].opId === "legacy-op-1");
    const legacy = legacyRows[0];
    check("(1b) the legacy row backfills state='pending' (not yet reconciled)", legacy.state === "pending");
    check("(1b) the legacy row backfills surfacedPending=true — under the OLD shape, mere existence meant surfaced-pending", legacy.surfacedPending === true);
    check("(1b) the legacy row backfills projectId=null — no honest default exists for a pre-existing row", legacy.projectId === null);
    // The whole POINT of the surfaced_pending backfill: a legacy leftover row must still be swept by
    // reconcileOrphanedGateOps on the very next boot after this migration, exactly as it would have been
    // under the old row-existence-means-pending semantics.
    check("(1b) the legacy row is picked up by listSurfacedPendingGateOps (still reconcilable)", upgradedDb.listSurfacedPendingGateOps().some((r) => r.opId === "legacy-op-1"));
  }
  try { upgradedDb?.close(); } catch { /* ignore */ }
}

// ===== (2) CRUD against a fresh Db instance =====
{
  const db = new Db(path.join(tmpHome, "crud.db"));
  db.insertPendingGateOp({ opId: "op-a", kind: "gate", key: "gate:s1", ownerSessionId: "s1", projectId: "proj-1", taskId: "t1", branch: "loom/t1", startedAt: now, state: "pending", surfacedPending: false });
  let rows = db.listPendingGateOps();
  check("(2) insertPendingGateOp + listPendingGateOps round-trips", rows.length === 1 && rows[0].opId === "op-a" && rows[0].kind === "gate" && rows[0].ownerSessionId === "s1" && rows[0].projectId === "proj-1");
  check("(2) a freshly-minted row starts state='pending', surfacedPending=false", rows[0].state === "pending" && rows[0].surfacedPending === false);
  // Upsert: re-inserting the SAME op_id overwrites the row in place, never a duplicate.
  db.insertPendingGateOp({ opId: "op-a", kind: "gate", key: "gate:s1", ownerSessionId: "s1", projectId: "proj-1", taskId: "t1-updated", branch: "loom/t1", startedAt: now, state: "pending", surfacedPending: false });
  rows = db.listPendingGateOps();
  check("(2) re-inserting the SAME opId upserts in place — no duplicate row", rows.length === 1 && rows[0].taskId === "t1-updated");

  db.markPendingGateOpSurfaced("op-a");
  check("(2) markPendingGateOpSurfaced flips surfacedPending true without touching state", db.listPendingGateOps()[0].surfacedPending === true && db.listPendingGateOps()[0].state === "pending");
  check("(2) it is now selected by listSurfacedPendingGateOps", db.listSurfacedPendingGateOps().some((r) => r.opId === "op-a"));

  db.settlePendingGateOp("op-a");
  check("(2) settlePendingGateOp marks state='settled'", db.listPendingGateOps()[0].state === "settled");
  check("(2) the row is NEVER deleted by settling — it survives its own terminal state", db.listPendingGateOps().length === 1);
  check("(2) a settled row drops out of listSurfacedPendingGateOps (no longer 'pending')", !db.listSurfacedPendingGateOps().some((r) => r.opId === "op-a"));

  db.insertPendingGateOp({ opId: "op-b", kind: "merge", key: "merge:s2", ownerSessionId: "s2", projectId: "proj-1", taskId: null, branch: null, startedAt: now, state: "pending", surfacedPending: false });
  db.evictPendingGateOpDeadOwner("op-b");
  check("(2) evictPendingGateOpDeadOwner marks state='evicted-dead-owner'", db.listPendingGateOps().find((r) => r.opId === "op-b").state === "evicted-dead-owner");

  db.insertPendingGateOp({ opId: "op-c", kind: "gate", key: "gate:s3", ownerSessionId: "s3", projectId: "proj-1", taskId: null, branch: null, startedAt: now, state: "pending", surfacedPending: true });
  db.markPendingGateOpOrphaned("op-c");
  check("(2) markPendingGateOpOrphaned marks state='orphaned-by-restart'", db.listPendingGateOps().find((r) => r.opId === "op-c").state === "orphaned-by-restart");

  // findPendingGateOpByOpId: full id, 8-char prefix, ambiguous prefix, no match at all — real-shaped
  // (UUID-length) opIds this time, so the 8-char MIN_ID_PREFIX_LEN floor is actually exercised (a short
  // literal id like "op-a" IS its own full match at any slice length, which would silently defeat this).
  const byFull = db.findPendingGateOpByOpId("op-a");
  check("(2) findPendingGateOpByOpId resolves the FULL id", byFull.kind === "found" && byFull.record.opId === "op-a");
  const OP_PREFIX_A = "aaaaaaaa-0001-0000-0000-000000000000";
  const OP_PREFIX_B = "aaaaaaaa-0002-0000-0000-000000000000";
  db.insertPendingGateOp({ opId: OP_PREFIX_A, kind: "gate", key: "gate:s5", ownerSessionId: "s5", projectId: "proj-1", taskId: null, branch: null, startedAt: now, state: "pending", surfacedPending: false });
  db.insertPendingGateOp({ opId: OP_PREFIX_B, kind: "gate", key: "gate:s6", ownerSessionId: "s6", projectId: "proj-1", taskId: null, branch: null, startedAt: now, state: "pending", surfacedPending: false });
  const byUniquePrefix = db.findPendingGateOpByOpId(OP_PREFIX_A.slice(0, 13));
  check("(2) an unambiguous 13-char prefix resolves the SAME row", byUniquePrefix.kind === "found" && byUniquePrefix.record.opId === OP_PREFIX_A);
  const byAmbiguousPrefix = db.findPendingGateOpByOpId("aaaaaaaa");
  check("(2) a prefix matching multiple rows is ambiguous, naming all matches", byAmbiguousPrefix.kind === "ambiguous" && byAmbiguousPrefix.ids.includes(OP_PREFIX_A) && byAmbiguousPrefix.ids.includes(OP_PREFIX_B));
  const tooShort = db.findPendingGateOpByOpId(OP_PREFIX_A.slice(0, 4));
  check("(2) a ref shorter than the 8-char floor never matches, even against a real row", tooShort.kind === "none");
  const noMatch = db.findPendingGateOpByOpId("does-not-exist-at-all-00000000");
  check("(2) an id with no match at all resolves 'none'", noMatch.kind === "none");
  // scopeSessionId / scopeProjectId — candidate-set filters BEFORE resolution.
  const scopedToOwner = db.findPendingGateOpByOpId("op-a", "s1");
  check("(2) scopeSessionId=owner still resolves the row", scopedToOwner.kind === "found" && scopedToOwner.record.opId === "op-a");
  const scopedToStranger = db.findPendingGateOpByOpId("op-a", "s2");
  check("(2) scopeSessionId=non-owner resolves 'none' for someone else's row — never 'found'", scopedToStranger.kind === "none");
  const scopedToProject = db.findPendingGateOpByOpId("op-a", undefined, "proj-1");
  check("(2) scopeProjectId=own project still resolves the row", scopedToProject.kind === "found");
  const scopedToOtherProject = db.findPendingGateOpByOpId("op-a", undefined, "proj-other");
  check("(2) scopeProjectId=a different project resolves 'none' — never leaks a foreign row", scopedToOtherProject.kind === "none");

  db.close();
}

// ===== (3) reconcileOrphanedGateOps: selects ONLY surfaced_pending+state='pending' rows, pushes the right
// synthetic nudge, and marks them 'orphaned-by-restart' (never deletes) =====
{
  const P = "pgo-reconcile";
  const db = new Db(path.join(tmpHome, "reconcile.db"));
  const host = new SpyHost({
    onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
    onBusy(id, busy) { db.setBusy(id, busy); },
    onContextStats() {}, onRateLimited() {},
    onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
  });
  const sessions = new SessionService(db, host, new OrchestrationControl());

  db.insertProject({ id: P, name: "PGO", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `${P}-mgr`, projectId: P, name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
  db.insertAgent({ id: `${P}-dev`, projectId: P, name: "Dev", startupPrompt: "DEV", position: 1, profileId: null });
  const mgrId = `${P}-mgr1`, workerId = `${P}-wkr`;
  db.insertSession({ id: mgrId, projectId: P, agentId: `${P}-mgr`, engineSessionId: null, title: null, cwd: tmpHome, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({ id: workerId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: tmpHome, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: null });

  // Simulate: the daemon died before either op's own settle callback ever ran — both were surfaced
  // pending and never resolved.
  db.insertPendingGateOp({ opId: "orphan-gate-1", kind: "gate", key: `gate:${workerId}`, ownerSessionId: workerId, projectId: P, taskId: null, branch: null, startedAt: now, state: "pending", surfacedPending: true });
  db.insertPendingGateOp({ opId: "orphan-merge-1", kind: "merge", key: `merge:${workerId}`, ownerSessionId: mgrId, projectId: P, taskId: null, branch: null, startedAt: now, state: "pending", surfacedPending: true });
  // A THIRD op that settled CLEANLY before the crash (fast-path, never even surfaced pending) — must be
  // completely excluded from the sweep: no nudge, and its row is left at state='settled' untouched. This
  // is the exact false-positive card e3e40167 exists to prevent (mint-on-create inverting edc1ec12's
  // "surviving row == owed a nudge" signal).
  db.insertPendingGateOp({ opId: "already-settled-1", kind: "gate", key: `gate:${workerId}-other`, ownerSessionId: workerId, projectId: P, taskId: null, branch: null, startedAt: now, state: "pending", surfacedPending: false });
  db.settlePendingGateOp("already-settled-1");
  // A FOURTH op that WAS surfaced pending but has ALREADY settled (a real race: settled between being
  // surfaced and the crash) — also excluded, since state is no longer 'pending'.
  db.insertPendingGateOp({ opId: "surfaced-then-settled-1", kind: "gate", key: `gate:${workerId}-third`, ownerSessionId: workerId, projectId: P, taskId: null, branch: null, startedAt: now, state: "pending", surfacedPending: false });
  db.markPendingGateOpSurfaced("surfaced-then-settled-1");
  db.settlePendingGateOp("surfaced-then-settled-1");

  const cleared = sessions.reconcileOrphanedGateOps();
  check("(3) reconcileOrphanedGateOps reports exactly 2 reconciled (not 4)", cleared === 2);

  const rowsAfter = db.listPendingGateOps();
  check("(3) all 4 rows STILL EXIST afterward — nothing is ever deleted from this table", rowsAfter.length === 4);
  check("(3) the two genuinely-orphaned rows are marked 'orphaned-by-restart'", rowsAfter.find((r) => r.opId === "orphan-gate-1").state === "orphaned-by-restart" && rowsAfter.find((r) => r.opId === "orphan-merge-1").state === "orphaned-by-restart");
  check("(3) the already-settled row is UNTOUCHED at state='settled'", rowsAfter.find((r) => r.opId === "already-settled-1").state === "settled");
  check("(3) the surfaced-then-settled row is UNTOUCHED at state='settled'", rowsAfter.find((r) => r.opId === "surfaced-then-settled-1").state === "settled");

  const gateNudge = host.enqueueCalls.find((c) => c.sessionId === workerId && /\[loom:gate-failed\]/.test(c.text));
  check("(3) the 'gate' row pushed [loom:gate-failed] to the WORKER (the owning session)", gateNudge !== undefined);
  check("(3) it names the restart cause and tells the worker to re-run", gateNudge && /restart/i.test(gateNudge.text) && /re-run `run_gate`/.test(gateNudge.text));
  check("(3) pushed with kind:\"warning\"", gateNudge && gateNudge.kind === "warning");

  const mergeNudge = host.enqueueCalls.find((c) => c.sessionId === mgrId && /\[loom:merge-failed\]/.test(c.text));
  check("(3) the 'merge' row pushed [loom:merge-failed] to the MANAGER (the owning session)", mergeNudge !== undefined);
  check("(3) it names the restart cause and tells the manager to re-confirm", mergeNudge && /restart/i.test(mergeNudge.text) && /re-run `worker_merge_confirm`/.test(mergeNudge.text));

  // The false-positive check: neither settled row's opId should appear in ANY pushed nudge text at all.
  const anyFalseNudge = host.enqueueCalls.some((c) => /already-settled-1|surfaced-then-settled-1/.test(c.text));
  check("(3) NEITHER already-settled op appears in ANY pushed nudge — no false [loom:gate-failed] for a fast op that passed before the crash", !anyFalseNudge);

  // Re-running the sweep with nothing left in 'pending' state is a harmless no-op — boot calls this
  // unconditionally on every start, restart-triggered or not.
  const clearedAgain = sessions.reconcileOrphanedGateOps();
  check("(3) re-running the sweep with nothing left to reconcile is a harmless no-op", clearedAgain === 0);

  db.close();
}

// ===== (4) END-TO-END via the REAL runWorkerGate: the row exists (state 'pending') while pending, and
// moves to state='settled' (never deleted) on normal settle =====
const worktrees = [];
try {
  const P = "pgo-e2e";
  const repo = path.join(os.tmpdir(), `loom-pgo-repo-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# pgo\n");
  execSync(`git init -q && git config user.email pgo@loom && git config user.name pgo && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });
  const { worktreePath, branch } = await createWorktree(repo, P, "t1");
  worktrees.push([repo, worktreePath]);

  const db = new Db(path.join(tmpHome, "e2e.db"));
  const host = new SpyHost({
    onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
    onBusy(id, busy) { db.setBusy(id, busy); },
    onContextStats() {}, onRateLimited() {},
    onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
  });
  const sessions = new SessionService(db, host, new OrchestrationControl());

  db.insertProject({ id: P, name: "PGO-E2E", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: `node -e "setTimeout(()=>process.exit(0), 13000)"` } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `${P}-dev`, projectId: P, name: "Dev", startupPrompt: "DEV", position: 0, profileId: null });
  const workerId = `${P}-wkr`;
  db.insertSession({ id: workerId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", worktreePath, branch });

  const first = await sessions.runWorkerGate(workerId);
  check("(4) degrades to pending past the sync-wait budget", first.settled === false);
  const opId = first.op.opId;

  const rowsWhilePending = db.listPendingGateOps();
  check("(4) a durable row exists WHILE the op is genuinely pending", rowsWhilePending.length === 1 && rowsWhilePending[0].opId === opId && rowsWhilePending[0].kind === "gate" && rowsWhilePending[0].ownerSessionId === workerId);
  check("(4) it carries projectId + surfacedPending=true + state='pending' while genuinely in flight", rowsWhilePending[0].projectId === P && rowsWhilePending[0].surfacedPending === true && rowsWhilePending[0].state === "pending");

  await waitUntil(() => host.enqueueCalls.some((c) => c.sessionId === workerId && /\[loom:gate-(done|failed)\]/.test(c.text)), 20_000);
  const rowsAfterSettle = db.listPendingGateOps();
  check("(4) the durable row STILL EXISTS once the op settles — never deleted", rowsAfterSettle.length === 1 && rowsAfterSettle[0].opId === opId);
  check("(4) it is marked state='settled' — positively distinguishable from a never-minted opId, not a hole", rowsAfterSettle[0].state === "settled");

  db.close();
} finally {
  for (const [repo, wt] of worktrees) { if (wt) { try { await removeWorktree(repo, wt); } catch { /* best-effort */ } } }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — pending_gate_ops is created on a table-less pre-existing DB AND correctly ALTERs an existing 7-column pre-e3e40167 table (backfilling state='pending', surfacedPending=true, projectId=null) — not just a fresh install; the full CRUD surface (insert/markSurfaced/settle/evictDeadOwner/markOrphaned/list/listSurfaced/findByOpIdOrPrefix, with session/project scoping) round-trips correctly and NEVER deletes a row on any terminal transition; reconcileOrphanedGateOps selects ONLY surfaced_pending+state='pending' rows (never a row that already settled, fast-path or otherwise) and marks them 'orphaned-by-restart' rather than deleting them; and the REAL runWorkerGate wiring writes a durable 'pending' row exactly while pending and moves it to 'settled' (never deletes it) on a normal settle, so the opId stays positively queryable long after PendingOpRegistry itself has forgotten it."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
