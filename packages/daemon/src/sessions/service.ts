import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolveConfig, type Session, type StopMode, type OrchestrationEvent } from "@loom/shared";
import type { Db } from "../db.js";
import type { PtyHost } from "../pty/host.js";
import { createWorktree, removeWorktree, deleteBranch, diffBranch, mergeBranch } from "../git/worktrees.js";
import { engineTranscriptExists } from "./transcript.js";
import type { OrchestrationControl } from "../orchestration/control.js";
import { isLikelyNearClaudeUsageLimit } from "../orchestration/usage-awareness.js";

/** Ties the session registry (Db) to the PtyHost. Owns new/resume orchestration. */
export class SessionService {
  constructor(private db: Db, private pty: PtyHost, private control: OrchestrationControl) {}

  /** Start a NEW session in a topic — injects the topic startup prompt once. */
  startNew(topicId: string): Session {
    const topic = this.db.getTopic(topicId);
    if (!topic) throw new Error("topic not found");
    const project = this.db.getProject(topic.projectId);
    if (!project) throw new Error("project not found");
    const config = resolveConfig(project.config);

    const now = new Date().toISOString();
    const session: Session = {
      id: randomUUID(),
      projectId: project.id,
      topicId,
      engineSessionId: null,
      title: null,
      cwd: project.repoPath,
      processState: "starting",
      resumability: "unknown",
      busy: false,
      createdAt: now,
      lastActivity: now,
      lastError: null,
    };
    this.db.insertSession(session);
    this.pty.spawn({
      sessionId: session.id,
      cwd: session.cwd,
      permission: config.permission,
      geometry: config.pty,
      sessionEnv: config.sessionEnv,
      vaultPath: config.docLint ? project.vaultPath : undefined, // Pillar D: scope the vault-lint hook
      startupPrompt: topic.startupPrompt || undefined,
    });
    this.db.setProcessState(session.id, "live");
    return { ...session, processState: "live" };
  }

  /**
   * Start a NEW MANAGER session in a topic (phase-2 §A2). Mirrors startNew, but marks the
   * session role 'manager' (so it gets the loom-orchestration MCP + allowlist at spawn) and
   * runs in the project repo, NOT a worktree (managers coordinate; workers get the worktrees).
   */
  startManager(topicId: string): Session {
    const topic = this.db.getTopic(topicId);
    if (!topic) throw new Error("topic not found");
    const project = this.db.getProject(topic.projectId);
    if (!project) throw new Error("project not found");
    const config = resolveConfig(project.config);

    const now = new Date().toISOString();
    const session: Session = {
      id: randomUUID(),
      projectId: project.id,
      topicId,
      engineSessionId: null,
      title: null,
      cwd: project.repoPath, // a manager works in the repo, not a worktree
      processState: "starting",
      resumability: "unknown",
      busy: false,
      createdAt: now,
      lastActivity: now,
      lastError: null,
      role: "manager",
    };
    this.db.insertSession(session);
    this.pty.spawn({
      sessionId: session.id,
      cwd: session.cwd,
      permission: config.permission,
      geometry: config.pty,
      sessionEnv: config.sessionEnv,
      vaultPath: config.docLint ? project.vaultPath : undefined, // Pillar D: scope the vault-lint hook
      startupPrompt: topic.startupPrompt || undefined,
      role: "manager",
    });
    this.db.setProcessState(session.id, "live");
    return { ...session, processState: "live" };
  }

  /**
   * Start a NEW PLATFORM-LEAD session in a topic (phase-2 Pillar C). Mirrors startManager, but
   * role 'platform' (so it gets the loom-platform MCP + allowlist at spawn, NOT orchestration).
   * A platform-lead creates/configures projects + topics; it runs in its host project's repo.
   */
  startPlatformLead(topicId: string): Session {
    const topic = this.db.getTopic(topicId);
    if (!topic) throw new Error("topic not found");
    const project = this.db.getProject(topic.projectId);
    if (!project) throw new Error("project not found");
    const config = resolveConfig(project.config);

    const now = new Date().toISOString();
    const session: Session = {
      id: randomUUID(),
      projectId: project.id,
      topicId,
      engineSessionId: null,
      title: null,
      cwd: project.repoPath,
      processState: "starting",
      resumability: "unknown",
      busy: false,
      createdAt: now,
      lastActivity: now,
      lastError: null,
      role: "platform",
    };
    this.db.insertSession(session);
    this.pty.spawn({
      sessionId: session.id,
      cwd: session.cwd,
      permission: config.permission,
      geometry: config.pty,
      sessionEnv: config.sessionEnv,
      vaultPath: config.docLint ? project.vaultPath : undefined, // Pillar D: scope the vault-lint hook
      startupPrompt: topic.startupPrompt || undefined,
      role: "platform",
    });
    this.db.setProcessState(session.id, "live");
    return { ...session, processState: "live" };
  }

  /** Resume an existing session — NO prompt injection. */
  resume(sessionId: string): Session {
    const session = this.db.getSession(sessionId);
    if (!session) throw new Error("session not found");
    if (!session.engineSessionId) throw new Error("session has no engine id to resume");
    // Backstop dead-ID detection: if the engine transcript is gone, this id is unresumable.
    if (!engineTranscriptExists(session.cwd, session.engineSessionId)) {
      this.db.setResumability(session.id, "dead");
      throw new Error("session is no longer resumable (engine transcript missing)");
    }
    const project = this.db.getProject(session.projectId);
    if (!project) throw new Error("project not found");
    const config = resolveConfig(project.config);

    this.pty.spawn({
      sessionId: session.id,
      cwd: session.cwd, // SAME cwd — Claude keys sessions to the project dir
      permission: config.permission,
      geometry: config.pty,
      sessionEnv: config.sessionEnv,
      vaultPath: config.docLint ? project.vaultPath : undefined, // Pillar D: scope the vault-lint hook
      resumeId: session.engineSessionId,
      // Carry the role across resume so a manager/worker/platform session is re-spawned WITH its
      // role-gated MCP surface (loom-orchestration / loom-platform) + allowlist. Without this a
      // resumed manager loses worker_spawn/merge/etc. and a worker loses worker_report.
      role: session.role ?? undefined,
    });
    this.db.setProcessState(session.id, "live");
    return { ...session, processState: "live" };
  }

  /**
   * Spawn a WORKER for a manager (phase-2 §A2/§A5): create an isolated git worktree+branch,
   * start a real worker `claude` in it (the existing spawn path — workers get loom-tasks scoped
   * to their own session→project, NOT the orchestration surface), and move the task to
   * in_progress. The worktree's lifecycle is owned by merge/recycle, not stop.
   */
  async spawnWorker(
    managerSessionId: string,
    opts: { taskId: string; topicId?: string; kickoffPrompt: string },
  ): Promise<Session> {
    const manager = this.db.getSession(managerSessionId);
    if (!manager || manager.role !== "manager") throw new Error("not a manager session");
    const project = this.db.getProject(manager.projectId);
    if (!project) throw new Error("project not found");
    const config = resolveConfig(project.config);

    // Safety rails (§17a) — refuse NEW work before any side effect (worktree/pty). In-flight
    // workers are untouched. Pause is global-or-this-manager; the cap counts LIVE children only.
    if (this.control.isPaused(managerSessionId)) throw new Error("orchestration paused");
    // §19c: don't spawn a worker into a known usage-limited account (whole-queue awareness).
    if (isLikelyNearClaudeUsageLimit()) throw new Error("usage limit active");
    const liveWorkers = this.db.listWorkers(managerSessionId).filter((w) => w.processState === "live").length;
    const cap = config.orchestration.maxConcurrentWorkers;
    if (liveWorkers >= cap) throw new Error(`concurrency cap reached (${cap})`);

    const { worktreePath, branch } = await createWorktree(project.repoPath, project.id, opts.taskId);

    const now = new Date().toISOString();
    const worker: Session = {
      id: randomUUID(),
      projectId: manager.projectId,
      topicId: opts.topicId ?? manager.topicId,
      engineSessionId: null,
      title: null,
      cwd: worktreePath, // worker runs IN its worktree (parallel-worker isolation)
      processState: "starting",
      resumability: "unknown",
      busy: false,
      createdAt: now,
      lastActivity: now,
      lastError: null,
      role: "worker",
      parentSessionId: managerSessionId,
      taskId: opts.taskId,
      worktreePath,
      branch,
    };
    this.db.insertSession(worker);
    this.pty.spawn({
      sessionId: worker.id,
      cwd: worktreePath,
      permission: config.permission,
      geometry: config.pty,
      sessionEnv: config.sessionEnv,
      vaultPath: config.docLint ? project.vaultPath : undefined, // Pillar D: scope the vault-lint hook
      startupPrompt: opts.kickoffPrompt,
      role: "worker", // gives the worker the orchestration surface (worker_report only)
    });
    this.db.setProcessState(worker.id, "live");
    this.db.updateTask(opts.taskId, { columnKey: "in_progress" });
    this.db.appendEvent({
      id: randomUUID(), ts: new Date().toISOString(),
      managerSessionId, workerSessionId: worker.id, taskId: opts.taskId, kind: "spawn_worker",
    });
    return { ...worker, processState: "live" };
  }

  /** Stop one of a manager's workers (parent-scoped). Worktree is RETAINED (merge/recycle own it). */
  stopWorker(managerSessionId: string, workerSessionId: string, mode: StopMode): void {
    const worker = this.db.getSession(workerSessionId);
    if (!worker || worker.parentSessionId !== managerSessionId) throw new Error("not your worker");
    this.pty.stop(workerSessionId, mode);
    this.db.appendEvent({
      id: randomUUID(), ts: new Date().toISOString(),
      managerSessionId, workerSessionId, taskId: worker.taskId ?? null, kind: "stop_worker",
    });
  }

  /**
   * Emergency kill switch (§17a): HARD-stop every live worker pty across ALL managers, then latch
   * the global pause so nothing new spawns until an explicit resume. "Stop everything now" — the
   * distinct sibling of pause ("stop taking on more"). onExit reconciles each pty to processState
   * 'exited'. Returns the number of live workers we issued a hard stop to.
   */
  killAllWorkers(): number {
    const live = this.db.listAllSessions().filter((s) => s.role === "worker" && s.processState === "live");
    for (const w of live) this.pty.stop(w.id, "hard");
    this.control.pause("global");
    return live.length;
  }

  /**
   * Send a framed message to one of a manager's workers (parent-scoped). Submitted as a turn
   * when the worker is idle, or queued FIFO (busy-gated) and drained on the worker's next Stop.
   */
  messageWorker(
    managerSessionId: string, workerSessionId: string, text: string,
  ): { delivered: boolean; position?: number } {
    const worker = this.db.getSession(workerSessionId);
    if (!worker || worker.parentSessionId !== managerSessionId) throw new Error("not your worker");
    const framed = `[loom:from-manager]\n${text}`;
    const r = this.pty.enqueueStdin(workerSessionId, framed);
    this.db.appendEvent({
      id: randomUUID(), ts: new Date().toISOString(),
      managerSessionId, workerSessionId, taskId: worker.taskId ?? null, kind: "message_worker",
    });
    return r;
  }

  /**
   * A worker reports to its manager (phase-2 §A3, the worker→manager direction). Moves the
   * worker's task by status, records the event, and notifies the manager via the busy-gated
   * queue — exactly Jinn's role:notification semantics: if the manager is mid-turn the report
   * queues behind its running turn and drains on its next Stop. The caller IS the worker
   * (workerSessionId is derived server-side from the URL path), so there's no id to spoof.
   */
  workerReport(
    workerSessionId: string,
    report: { status: "done" | "blocked" | "progress"; summary: string; prUrl?: string; needs?: string },
  ): { reported: boolean; delivered: boolean } {
    const worker = this.db.getSession(workerSessionId);
    if (!worker) throw new Error("unknown worker session");
    const managerSessionId = worker.parentSessionId ?? null;
    const taskId = worker.taskId ?? null;

    // Task move by status: done → review (ready for the manager's diff review), blocked →
    // waiting, progress → no move.
    if (taskId) {
      const col = report.status === "done" ? "review" : report.status === "blocked" ? "waiting" : null;
      if (col) this.db.updateTask(taskId, { columnKey: col });
    }

    this.db.appendEvent({
      id: randomUUID(), ts: new Date().toISOString(),
      managerSessionId: managerSessionId ?? "", workerSessionId, taskId, kind: "worker_report",
      detail: { status: report.status, summary: report.summary, prUrl: report.prUrl, needs: report.needs },
    });

    let delivered = false;
    if (managerSessionId) {
      let framed = `[loom:worker-report] worker ${workerSessionId} (task ${taskId ?? "none"}) — ${report.status}: ${report.summary}`;
      if (report.prUrl) framed += ` | PR: ${report.prUrl}`;
      if (report.needs) framed += ` | needs: ${report.needs}`;
      delivered = this.pty.enqueueStdin(managerSessionId, framed).delivered;
    }
    return { reported: true, delivered };
  }

  /**
   * Stranded-worker guard. A worker only reaches its manager via worker_report's push; a worker
   * that ends its turn WITHOUT reporting goes idle silently and the manager — which has no
   * idle/exit signal for its children — waits forever. Called on every session's busy->false edge:
   * if this is a worker still sitting in `in_progress` (worker_report would have moved it to
   * review/waiting), push a [loom:worker-idle] nudge to its manager via the same enqueue channel.
   * No-op for non-workers, parentless sessions, or workers that already reported/merged.
   */
  notifyManagerOfIdleWorker(workerSessionId: string): void {
    const w = this.db.getSession(workerSessionId);
    if (!w || w.role !== "worker" || !w.parentSessionId || !w.taskId) return;
    const task = this.db.getTask(w.taskId);
    if (!task || task.columnKey !== "in_progress") return; // reported done/blocked, or already merged
    const msg = `[loom:worker-idle] worker ${workerSessionId} (task ${w.taskId}) finished a turn and is idle but did NOT call worker_report (its task is still in_progress). It may be done-but-unreported or stalled — pull it: worker_transcript ${workerSessionId} to see what it did, then worker_merge ${workerSessionId} to review, or worker_message it.`;
    try { this.pty.enqueueStdin(w.parentSessionId, msg); } catch { /* manager not live */ }
  }

  /**
   * Recycle a worker whose context has grown too large (phase-2 §A4). Close the old worker and
   * spawn a FRESH one in the SAME retained worktree, seeded with the manager-supplied handoff:
   * the worktree carries CODE state forward, the handoff carries INTENT — and we spawn fresh
   * (never --resume), so the bloated context is dropped rather than carried on. Same task/branch;
   * gen+1; recycledFrom = the old session. The task is NOT moved (work continues, in_progress).
   */
  async recycleWorker(
    managerSessionId: string, workerSessionId: string, handoffSummary: string,
  ): Promise<Session> {
    const old = this.db.getSession(workerSessionId);
    if (!old || old.parentSessionId !== managerSessionId) throw new Error("not your worker");
    const worktreePath = old.worktreePath ?? old.cwd; // worker cwd === its worktree
    const branch = old.branch ?? null;
    const taskId = old.taskId ?? null;
    const project = this.db.getProject(old.projectId);
    if (!project) throw new Error("project not found");
    const config = resolveConfig(project.config);
    const newGen = (old.gen ?? 0) + 1;

    this.db.appendEvent({
      id: randomUUID(), ts: new Date().toISOString(),
      managerSessionId, workerSessionId, taskId, kind: "recycle_begin",
    });

    // Close the old worker HARD: reliable, and we spawn fresh (never resume) so a clean graceful
    // exit isn't needed. Wait until the pty is actually gone before reusing the worktree.
    this.pty.stop(workerSessionId, "hard");
    for (let i = 0; i < 50 && this.pty.isAlive(workerSessionId); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (this.pty.isAlive(workerSessionId)) {
      // eslint-disable-next-line no-console
      console.warn(`[recycle] old worker ${workerSessionId} still alive after ~5s; proceeding`);
    }

    const now = new Date().toISOString();
    const fresh: Session = {
      id: randomUUID(),
      projectId: old.projectId,
      topicId: old.topicId,
      engineSessionId: null,
      title: null,
      cwd: worktreePath, // SAME worktree — code state persists
      processState: "starting",
      resumability: "unknown",
      busy: false,
      createdAt: now,
      lastActivity: now,
      lastError: null,
      role: "worker",
      parentSessionId: managerSessionId,
      taskId,
      worktreePath,
      branch,
      gen: newGen,
      recycledFrom: old.id,
    };
    this.db.insertSession(fresh);
    // The handoff is the fresh worker's startup prompt (the proven positional-arg path, run on
    // boot) — NOT --resume, which would carry the old context forward and defeat the recycle.
    const framed =
      `[loom:handoff] You are continuing a task in an existing git worktree on branch ${branch ?? "(unknown)"}. ` +
      `Your predecessor's handoff:\n\n${handoffSummary}\n\nContinue from here.`;
    this.pty.spawn({
      sessionId: fresh.id,
      cwd: worktreePath,
      permission: config.permission,
      geometry: config.pty,
      sessionEnv: config.sessionEnv,
      vaultPath: config.docLint ? project.vaultPath : undefined, // Pillar D: scope the vault-lint hook
      startupPrompt: framed,
      role: "worker",
    });
    this.db.setProcessState(fresh.id, "live");
    this.db.appendEvent({
      id: randomUUID(), ts: new Date().toISOString(),
      managerSessionId, workerSessionId: fresh.id, taskId, kind: "recycle_complete",
      detail: { recycledFrom: old.id, gen: newGen },
    });
    return { ...fresh, processState: "live" };
  }

  /**
   * Step 1 of the two-step merge gate (#16): show the manager a worker's branch diff. NO merge
   * happens — this is the review the manager cannot skip (there is no worker-side merge tool).
   */
  async reviewWorkerMerge(
    managerSessionId: string, workerSessionId: string,
  ): Promise<{ filesChanged: number; insertions: number; deletions: number; patch: string }> {
    const worker = this.db.getSession(workerSessionId);
    if (!worker || worker.parentSessionId !== managerSessionId) throw new Error("not your worker");
    if (!worker.branch) throw new Error("worker has no branch");
    const project = this.db.getProject(worker.projectId);
    if (!project) throw new Error("project not found");
    const diff = await diffBranch(project.repoPath, worker.branch);
    this.db.appendEvent({
      id: randomUUID(), ts: new Date().toISOString(),
      managerSessionId, workerSessionId, taskId: worker.taskId ?? null, kind: "merge_request",
      detail: { branch: worker.branch, filesChanged: diff.filesChanged },
    });
    return diff;
  }

  /**
   * Step 2: run the build/DoD gate, and ONLY if green merge the branch --no-ff, remove the
   * worktree, and move the task to done. FAIL-CLOSED — a failed gate or a merge conflict leaves
   * the canonical repo UNTOUCHED and the worktree RETAINED (so the manager can re-task a fix).
   * Merge is daemon-executed; workers have no merge tool.
   */
  async confirmWorkerMerge(
    managerSessionId: string, workerSessionId: string,
  ): Promise<{ merged: boolean; reason?: string }> {
    const worker = this.db.getSession(workerSessionId);
    if (!worker || worker.parentSessionId !== managerSessionId) throw new Error("not your worker");
    if (!worker.branch) throw new Error("worker has no branch");
    const project = this.db.getProject(worker.projectId);
    if (!project) throw new Error("project not found");
    const worktreePath = worker.worktreePath ?? worker.cwd;
    const taskId = worker.taskId ?? null;
    const branch = worker.branch;
    const gate = resolveConfig(project.config).orchestration.gateCommand;
    const evt = (kind: OrchestrationEvent["kind"], detail?: Record<string, unknown>) => this.db.appendEvent({
      id: randomUUID(), ts: new Date().toISOString(), managerSessionId, workerSessionId, taskId, kind, detail,
    });
    const rejectNotify = (msg: string) => { try { this.pty.enqueueStdin(managerSessionId, msg); } catch { /* manager not live */ } };

    // Build/DoD gate (fail-closed): run the configured command in the WORKTREE; non-zero rejects.
    if (gate) {
      const res = spawnSync(gate, { cwd: worktreePath, shell: true, timeout: 120_000, stdio: "ignore" });
      const passed = res.status === 0 && !res.error;
      evt("build_gate", { passed });
      if (!passed) {
        evt("merge_rejected", { reason: "gate" });
        rejectNotify(`[loom:merge-rejected] worker ${workerSessionId} (task ${taskId ?? "none"}) — build gate failed; canonical repo untouched, worktree retained.`);
        return { merged: false, reason: "build gate failed" };
      }
    }

    const merge = await mergeBranch(project.repoPath, branch);
    if (!merge.ok) {
      evt("merge_rejected", { reason: "conflict" });
      rejectNotify(`[loom:merge-rejected] worker ${workerSessionId} (task ${taskId ?? "none"}) — merge conflict; canonical repo untouched, worktree retained. Re-task a rebase.`);
      return { merged: false, reason: "merge conflict" };
    }

    // Green: the branch is on the canonical repo. The worker (which reported 'done' but is still
    // alive) holds the worktree as its pty cwd — on Windows `git worktree remove` fails while the
    // dir is a live process's cwd. So hard-stop the worker and wait for the pty to die BEFORE
    // removing the worktree (recycleWorker does the same before reusing one). A no-pty worker row
    // (e.g. merge-gate's seed) is already !isAlive, so this is a no-op there.
    this.pty.stop(workerSessionId, "hard");
    for (let i = 0; i < 50 && this.pty.isAlive(workerSessionId); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    // Retire the worktree, delete the now-merged branch (so a later worker on this task — or any
    // id8-colliding task — doesn't hit "branch already exists"), and finish the task. The rejected
    // paths above return early WITHOUT deleting, so a re-task keeps its retained worktree + branch.
    await removeWorktree(project.repoPath, worktreePath);
    await deleteBranch(project.repoPath, branch);
    if (taskId) this.db.updateTask(taskId, { columnKey: "done" });
    evt("merge_done", { branch });
    return { merged: true };
  }
}
