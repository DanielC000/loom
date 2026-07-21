import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// pending_gate_ops durable persistence + boot-time orphan reconcile (card edc1ec12, Platform-Audit finding
// 7afa6ea9 — the restart-orphan-signaling gap). PendingOpRegistry is purely in-memory and is wiped by a
// real daemon process death; this is the DURABLE complement that survives it. Proves:
//   (1) SCHEMA UPGRADE (owner's schema-change discipline: exercise against a real pre-existing DB, not
//       just a fresh one): pending_gate_ops is created on an EXISTING (pre-this-card) DB at open — not
//       just a fresh install — confirmed against a real on-disk DB that genuinely lacks the table.
//   (2) CRUD: recordPendingGateOp/listPendingGateOps/clearPendingGateOp round-trip correctly, and an
//       upsert (same op_id) overwrites the row in place rather than duplicating it.
//   (3) reconcileOrphanedGateOps: a surviving row (simulating "the daemon died before this op's own
//       settle callback ever ran") pushes the correct synthetic terminal nudge to its owning session and
//       clears the row — for BOTH "gate" (to the worker) and "merge" (to the manager) kinds.
//   (4) END-TO-END via the REAL runWorkerGate (not just the generic PendingOpRegistry hook in
//       pending-ops-registry.mjs — this proves the actual service.ts wiring): a durable row EXISTS while
//       the op is genuinely pending, and is CLEARED the moment the op settles normally — proving a normal
//       completion never leaves a stale row behind for a later boot to misread as restart-orphaned.
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

// ===== (1) SCHEMA UPGRADE: a pre-existing DB with NO pending_gate_ops table gains it on open =====
const upgradeDbFile = path.join(tmpHome, "upgrade.db");
{
  const raw = new Database(upgradeDbFile);
  raw.pragma("journal_mode = WAL");
  // A minimal but real pre-existing DB shape — sessions/projects/agents only, no pending_gate_ops
  // whatsoever (mirrors any real DB from before this card).
  raw.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_path TEXT NOT NULL, vault_path TEXT NOT NULL, config_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, archived_at TEXT);
    CREATE TABLE agents (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), name TEXT NOT NULL, startup_prompt TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), agent_id TEXT NOT NULL REFERENCES agents(id), engine_session_id TEXT, title TEXT, cwd TEXT NOT NULL, process_state TEXT NOT NULL DEFAULT 'none', resumability TEXT NOT NULL DEFAULT 'unknown', busy INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, last_activity TEXT NOT NULL, last_error TEXT, role TEXT);
  `);
  const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  check("(1) precondition: the legacy DB genuinely has NO pending_gate_ops table", !tables.includes("pending_gate_ops"));
  raw.close();
}
{
  let ctorError = null;
  let upgradedDb;
  try { upgradedDb = new Db(upgradeDbFile); } catch (err) { ctorError = err; }
  check("(1) constructing Db against the pre-existing DB does not throw", ctorError === null);
  if (!ctorError) {
    const raw2 = new Database(upgradeDbFile, { readonly: true });
    const tables = raw2.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    check("(1) pending_gate_ops now exists on the upgraded (pre-existing) DB", tables.includes("pending_gate_ops"));
    raw2.close();

    // ===== (2) CRUD against this SAME upgraded Db instance =====
    upgradedDb.recordPendingGateOp({ opId: "op-a", kind: "gate", key: "gate:s1", ownerSessionId: "s1", taskId: "t1", branch: "loom/t1", startedAt: now });
    let rows = upgradedDb.listPendingGateOps();
    check("(2) recordPendingGateOp + listPendingGateOps round-trips", rows.length === 1 && rows[0].opId === "op-a" && rows[0].kind === "gate" && rows[0].ownerSessionId === "s1");
    // Upsert: re-recording the SAME op_id overwrites the row in place, never a duplicate.
    upgradedDb.recordPendingGateOp({ opId: "op-a", kind: "gate", key: "gate:s1", ownerSessionId: "s1", taskId: "t1-updated", branch: "loom/t1", startedAt: now });
    rows = upgradedDb.listPendingGateOps();
    check("(2) re-recording the SAME opId upserts in place — no duplicate row", rows.length === 1 && rows[0].taskId === "t1-updated");
    upgradedDb.clearPendingGateOp("op-a");
    check("(2) clearPendingGateOp removes the row", upgradedDb.listPendingGateOps().length === 0);
  }
  try { upgradedDb?.close(); } catch { /* ignore */ }
}

// ===== (3) reconcileOrphanedGateOps: a surviving row pushes the right synthetic nudge + clears =====
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

  // Simulate: the daemon died before either op's own onSettledAfterPending callback ever ran.
  db.recordPendingGateOp({ opId: "orphan-gate-1", kind: "gate", key: `gate:${workerId}`, ownerSessionId: workerId, taskId: null, branch: null, startedAt: now });
  db.recordPendingGateOp({ opId: "orphan-merge-1", kind: "merge", key: `merge:${workerId}`, ownerSessionId: mgrId, taskId: null, branch: null, startedAt: now });

  const cleared = sessions.reconcileOrphanedGateOps();
  check("(3) reconcileOrphanedGateOps reports 2 reconciled", cleared === 2);
  check("(3) both durable rows are gone afterward", db.listPendingGateOps().length === 0);

  const gateNudge = host.enqueueCalls.find((c) => c.sessionId === workerId && /\[loom:gate-failed\]/.test(c.text));
  check("(3) the 'gate' row pushed [loom:gate-failed] to the WORKER (the owning session)", gateNudge !== undefined);
  check("(3) it names the restart cause and tells the worker to re-run", gateNudge && /restart/i.test(gateNudge.text) && /re-run `run_gate`/.test(gateNudge.text));
  check("(3) pushed with kind:\"warning\"", gateNudge && gateNudge.kind === "warning");

  const mergeNudge = host.enqueueCalls.find((c) => c.sessionId === mgrId && /\[loom:merge-failed\]/.test(c.text));
  check("(3) the 'merge' row pushed [loom:merge-failed] to the MANAGER (the owning session)", mergeNudge !== undefined);
  check("(3) it names the restart cause and tells the manager to re-confirm", mergeNudge && /restart/i.test(mergeNudge.text) && /re-run `worker_merge_confirm`/.test(mergeNudge.text));

  // Re-running the sweep on an already-clean table is a harmless no-op — boot calls this unconditionally
  // on every start, restart-triggered or not.
  const clearedAgain = sessions.reconcileOrphanedGateOps();
  check("(3) re-running the sweep with nothing left to reconcile is a harmless no-op", clearedAgain === 0);

  db.close();
}

// ===== (4) END-TO-END via the REAL runWorkerGate: the row exists while pending, clears on normal settle =====
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

  await waitUntil(() => host.enqueueCalls.some((c) => c.sessionId === workerId && /\[loom:gate-(done|failed)\]/.test(c.text)), 20_000);
  check("(4) the durable row is CLEARED once the op settles normally — no stale row for a later boot to misread", db.listPendingGateOps().length === 0);

  db.close();
} finally {
  for (const [repo, wt] of worktrees) { if (wt) { try { await removeWorktree(repo, wt); } catch { /* best-effort */ } } }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — pending_gate_ops is created on a real pre-existing (upgraded) DB, not just a fresh install; recordPendingGateOp/listPendingGateOps/clearPendingGateOp round-trip and upsert-in-place correctly; reconcileOrphanedGateOps pushes the correct synthetic [loom:gate-failed]/[loom:merge-failed] nudge to the owning session (worker/manager respectively) for a restart-orphaned row and clears it, and is a harmless no-op once nothing is left; and the REAL runWorkerGate wiring writes a durable row exactly while pending and clears it on a normal settle, so only a genuine process death ever leaves one behind."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
