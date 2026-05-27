import { randomUUID } from "node:crypto";
import { resolveConfig, type Session, type StopMode } from "@loom/shared";
import type { Db } from "../db.js";
import type { PtyHost } from "../pty/host.js";
import { createWorktree } from "../git/worktrees.js";
import { engineTranscriptExists } from "./transcript.js";

/** Ties the session registry (Db) to the PtyHost. Owns new/resume orchestration. */
export class SessionService {
  constructor(private db: Db, private pty: PtyHost) {}

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
      startupPrompt: topic.startupPrompt || undefined,
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
      resumeId: session.engineSessionId,
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
      startupPrompt: opts.kickoffPrompt,
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
}
