import { randomUUID } from "node:crypto";
import { resolveConfig, type Session } from "@loom/shared";
import type { Db } from "../db.js";
import type { PtyHost } from "../pty/host.js";
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
}
