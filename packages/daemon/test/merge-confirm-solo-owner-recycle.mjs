import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// SOLO worker_merge_confirm AFTER THE OWNING MANAGER RECYCLED MID-GATE (card 0771da77; sibling of card 2c16447b's
// batch fix). The confirm captures `managerSessionId` up front; the gate runs long enough for the manager to be
// recycled (old session archived, worker reparented to the successor). The post-await finalize must resolve the
// CURRENT lineage owner (resolveLineageOwnerForWorker(...) ?? captured), so:
//   (A) green path: merge_done is attributed to the successor; the queued-worker-report / idle-nudge purges and the
//       cap-queue drain target the successor, not the dead id.
//   (B) STRICT lineage: a worker reparented to an UNRELATED manager falls back to the captured id (never adopted).
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/merge-confirm-solo-owner-recycle.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mcsor-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
registerForCleanup(process.env.LOOM_HOME);

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

const GIT_ID = "-c user.email=mcsor@loom -c user.name=mcsor";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const write = (dir, f, c) => fs.writeFileSync(path.join(dir, f), c);

const repo = path.join(os.tmpdir(), `loom-mcsor-repo-${sfx}`);
fs.mkdirSync(repo, { recursive: true });
registerForCleanup(repo);
write(repo, "README.md", "# mcsor\n");
execSync(`git init -q && git config user.email mcsor@loom && git config user.name mcsor`, { cwd: repo });
commitAll(repo, "init", GIT_ID);

const worktrees = [];
let db;
try {
  db = new Db();
  const P = `mcsor-proj-${sfx}`;
  db.insertProject({ id: P, name: "MCSOR", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "node -e \"process.exit(0)\"" } }, createdAt: now, archivedAt: null });
  const agentId = `${P}-dev`;
  db.insertAgent({ id: agentId, projectId: P, name: "dev", startupPrompt: "", position: 0 });
  const baseSession = (id, role, extra = {}) => ({ id, projectId: P, agentId, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role, ...extra });

  const purges = []; // { kind, managerId }
  const ptyStub = {
    stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: false }; },
    purgeQueuedWorkerIdleNudges(mgr) { purges.push({ kind: "idle", managerId: mgr }); return []; },
    purgeQueuedWorkerReportNudgesForWorker(mgr) { purges.push({ kind: "report", managerId: mgr }); return []; },
  };
  let onGate = null;
  const fakeGate = async () => { if (onGate) await onGate(); return { passed: true }; };
  const svc = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate, gateOpRetainMs: 0 });
  const drains = [];
  const origDrain = svc.maybeDrainCapQueue.bind(svc);
  svc.maybeDrainCapQueue = (id) => { drains.push(id); return origDrain(id); };

  let n = 0;
  async function scenario() {
    const tag = `s${++n}`;
    const mgr1 = `${P}-${tag}-mgr1`;
    db.insertSession(baseSession(mgr1, "manager"));
    const taskId = `mcsor-task-${tag}-${sfx}`;
    const { worktreePath, branch } = await createWorktree(repo, P, taskId);
    worktrees.push(worktreePath);
    write(worktreePath, `${tag}.txt`, `x\n`);
    commitAll(worktreePath, `feat(test): ${tag}`, GIT_ID);
    db.insertTask({ id: taskId, projectId: P, title: `feat(test): ${tag}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    const workerId = `${P}-${tag}-wkr`;
    db.insertSession(baseSession(workerId, "worker", { cwd: worktreePath, processState: "exited", parentSessionId: mgr1, taskId, worktreePath, branch }));
    const mgr2 = `${P}-${tag}-mgr2`;
    const recycle = () => {
      db.insertSession(baseSession(mgr2, "manager", { recycledFrom: mgr1 }));
      db.db.prepare("UPDATE sessions SET process_state='exited' WHERE id=?").run(mgr1);
      db.archiveSession(mgr1);
      db.relinkWorkerToManager(workerId, mgr2);
    };
    return { tag, mgr1, mgr2, workerId, taskId, recycle };
  }
  const reset = () => { purges.length = 0; drains.length = 0; onGate = null; };

  // ── (A) green path across a recycle ──
  {
    reset();
    const s = await scenario();
    onGate = async () => { onGate = null; s.recycle(); };
    const r = await svc.confirmWorkerMerge(s.mgr1, s.workerId);
    check("(A) precondition: solo confirm merged (green, not ALREADY_MERGED)", r.merged === true && r.emptyKind === undefined);
    const done = db.listEventsForWorker(s.workerId).find((e) => e.kind === "merge_done");
    check("(A) merge_done attributed to the successor, not the dead predecessor", !!done && done.managerSessionId === s.mgr2);
    check("(A) queued worker-report nudge purge targeted the successor", purges.some((p) => p.kind === "report" && p.managerId === s.mgr2) && !purges.some((p) => p.kind === "report" && p.managerId === s.mgr1));
    check("(A) queued idle-nudge purge targeted the successor", purges.some((p) => p.kind === "idle" && p.managerId === s.mgr2) && !purges.some((p) => p.kind === "idle" && p.managerId === s.mgr1));
    check("(A) maybeDrainCapQueue targeted the successor", drains.includes(s.mgr2) && !drains.includes(s.mgr1));
  }

  // ── (B) STRICT lineage: worker reparented to an UNRELATED manager → fall back to the captured id ──
  {
    reset();
    const s = await scenario();
    const other = `${P}-${s.tag}-other`;
    db.insertSession(baseSession(other, "manager"));
    onGate = async () => { onGate = null; db.relinkWorkerToManager(s.workerId, other); };
    const r = await svc.confirmWorkerMerge(s.mgr1, s.workerId);
    check("(B) precondition: solo confirm merged", r.merged === true);
    const done = db.listEventsForWorker(s.workerId).find((e) => e.kind === "merge_done");
    check("(B) merge_done NOT attributed to the unrelated manager (captured id kept)", !!done && done.managerSessionId === s.mgr1);
  }
} finally {
  if (db) try { db.close(); } catch { /* ignore */ }
  for (const wt of worktrees) try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
