// Card 9623e943 — shared hermetic fixture for the card-policy enforcement tests. REAL git on a temp repo, a
// stub pty (merge paths) and a SeamHost fake pty (spawn paths); NO claude, NO daemon. The importing test MUST
// set a temp LOOM_HOME (useOwnLoomHome + requireHermeticEnv) BEFORE importing this module, because it
// dynamic-imports ../dist at load.
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempManaged, useOwnLoomHome } from "./_tmp-fixture.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { commitAll } from "./_git-commit.mjs";
import { createSeamHost } from "./_seam-host-fixture.mjs";

// createWorktree( is called below: a temp LOOM_HOME must be in force BEFORE the dist import (WORKTREES_DIR is a
// sibling of LOOM_HOME). The importing test normally set one already; this keeps a bare import hermetic too.
useOwnLoomHome("cpf-home-");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");
const { PtyHost } = await import("../dist/pty/host.js");

export const GIT_ID = "-c user.email=cpf@loom -c user.name=cpf";
const GATE = 'node -e "process.exit(0)"';

// A real solo merge (worktree + git squash) can outlast the production 12s sync-attach budget on a loaded host; the
// call then returns {settled:false} and every `merged === true` check reads it as "not merged". Default to a generous
// per-instance budget (the DI seam, never the production constant); a test that WANTS the degrade passes its own.
const DEFAULT_SYNC_ATTACH_BUDGET_MS = 60_000;

export async function makeEnv({ policies, syncAttachBudgetMs = DEFAULT_SYNC_ATTACH_BUDGET_MS } = {}) {
  const now = new Date().toISOString();
  const sfx = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const repo = mkdtempManaged("cpf-repo-");
  fs.writeFileSync(path.join(repo, "README.md"), "# cpf\n");
  execSync(`git init -q && git config user.email cpf@loom && git config user.name cpf`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  const projId = `cpf-p-${sfx}`, agentId = `cpf-a-${sfx}`, mgrId = `cpf-m-${sfx}`;
  const db = new Db();
  const cfg = (p) => ({ orchestration: { gateCommand: GATE, maxConcurrentWorkers: 50, ...(p !== undefined ? { cardPolicies: p } : {}) } });
  db.insertProject({ id: projId, name: "CPF", repoPath: repo, vaultPath: repo, config: cfg(policies), createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "dev", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: true }; } };
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs });
  class SeamHost extends createSeamHost(PtyHost) {
    constructor(events) { super(events); this.capture = []; }
    createPty(opts) { this.capture.push(opts); return super.createPty(opts); }
  }
  const seamEvents = {
    onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
    onBusy(id, busy) { db.setBusy(id, busy); },
    onContextStats() {}, onRateLimited() {},
    onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
  };
  const spawnHost = new SeamHost(seamEvents);
  const sessionsSpawn = new SessionService(db, spawnHost, new OrchestrationControl());
  const optsFor = (sid) => spawnHost.capture.find((o) => o.sessionId === sid);
  const git = (cwd, args) => execSync(`git ${args}`, { cwd, encoding: "utf8" }).trim();
  const env = {
    db, sessions, sessionsSpawn, optsFor, repo, projId, agentId, mgrId, now, sfx, git,
    setPolicies(p) { db.setProjectConfig(projId, cfg(p)); },
    /** A card (no worker). */
    addTask(label, title) {
      const taskId = `cpf-t-${label}-${sfx}`;
      db.insertTask({ id: taskId, projectId: projId, title: title ?? `feat(cpf): ${label}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
      return taskId;
    },
    /** A card + real worktree/branch with one commit + an exited worker session row bound to it. */
    async makeWorker(label, { title, commit = true, taskId: existingTaskId } = {}) {
      const taskId = existingTaskId ?? env.addTask(label, title); // `taskId`: a SECOND worker on an existing card (e.g. one moved back out of done)
      const cutBaseSha = git(repo, "rev-parse HEAD");
      const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
      if (commit) { fs.writeFileSync(path.join(worktreePath, `${label}.txt`), `work ${label}\n`); commitAll(worktreePath, `feat(cpf): ${label}`, GIT_ID); }
      const workerId = `cpf-w-${label}-${sfx}`;
      db.insertSession({ id: workerId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch, cutBaseSha });
      return { taskId, workerId, worktreePath, branch, label, tip: () => git(repo, `rev-parse refs/heads/${branch}`) };
    },
    /** A Request linked to the card. */
    fileRequest({ taskId, type = "permission", state = "answered", chosenOption = "authorize", decidedExpiresAt = null, answeredVia = "human" }) {
      const id = `cpf-q-${randomUUID().slice(0, 8)}`;
      // Inserted PENDING, then answered through the SAME db.answerQuestion write the real routes use, so `answeredVia` is the real stamp
      // (the human REST routes pass "human"; question_resolve / question_amend / companion decision_resolve pass nothing => null), never a hand-set column.
      db.insertQuestion({ id, sessionId: mgrId, projectId: projId, title: `req ${id}`, body: "b", type, options: type === "decision" ? ["approve", "reject"] : null, recommendation: null, taskId, state: "pending", chosenOption: null, note: null, createdAt: now, answeredAt: null, consumedAt: null });
      if (state !== "pending") {
        db.answerQuestion(id, { chosenOption, note: "n", answeredAt: now, decidedExpiresAt, ...(answeredVia ? { answeredVia } : {}) });
        if (state === "consumed") db.db.prepare("UPDATE questions SET state = 'consumed', consumed_at = ? WHERE id = ?").run(now, id);
      }
      return id;
    },
    /** A review session of the card (taskless, reviewOfTaskId set) with a worker_report of `status`. */
    fileReview({ taskId, baseSha, status = "done" }) {
      const id = `cpf-r-${randomUUID().slice(0, 8)}`;
      db.insertSession({ id, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: null, reviewBaseSha: baseSha, reviewOfTaskId: taskId });
      if (status) env.fileReport(id, status, new Date().toISOString(), null);
      return id;
    },
    /** A worker_report event for a worker session at `ts`. */
    fileReport(workerSessionId, status, ts, taskId = null) {
      db.appendEvent({ id: randomUUID(), ts, managerSessionId: mgrId, workerSessionId, taskId, kind: "worker_report", detail: { status, summary: "s" } });
    },
    /** True when `file` is tracked at the repo's current HEAD (i.e. a squash landed it). */
    landed(file) { return git(repo, "ls-tree -r HEAD --name-only").split("\n").includes(file); },
  };
  openEnvs.push(env);
  return env;
}

const openEnvs = [];
/** Close every Db this fixture opened so the temp LOOM_HOME can be removed (an open sqlite handle EBUSYs the cleanup on Windows). */
export function closeAll() {
  for (const e of openEnvs) { try { e.db.close(); } catch { /* already closed */ } }
}

export function policy(over = {}) {
  return { id: "p1", name: "Feat policy", match: { types: ["feat"] }, require: [{ kind: "code-review-report" }], ...over };
}
