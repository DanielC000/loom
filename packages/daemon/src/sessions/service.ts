import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  resolveConfig, resolveProfile,
  type Session, type StopMode, type OrchestrationEvent,
  type Agent, type SessionRole, type ResolvedConfig, type PermissionPolicy,
} from "@loom/shared";
import type { Db, IdleNudgePolicy } from "../db.js";
import type { PtyHost } from "../pty/host.js";
import { createWorktree, removeWorktree, deleteBranch, diffBranch, mergeBranch, isBranchMerged } from "../git/worktrees.js";
import { engineTranscriptExists } from "./transcript.js";
import type { OrchestrationControl } from "../orchestration/control.js";
import { isLikelyNearClaudeUsageLimit } from "../orchestration/usage-awareness.js";
import { RESTART_EXIT_CODE, isSupervised, writeRestartIntent, buildDaemon } from "../orchestration/restart.js";

/** Ties the session registry (Db) to the PtyHost. Owns new/resume orchestration. */
export class SessionService {
  constructor(private db: Db, private pty: PtyHost, private control: OrchestrationControl) {}

  /**
   * Phase-2 profile-driven spawn (Agents→Profiles P2): resolve an agent's OPTIONAL Profile into
   * the effective spawn shape the "start a session in an agent" paths read — the role it confers, the
   * startup prompt to inject, and the permission policy (config allow + the profile's allowDelta).
   *
   * Fully ADDITIVE — an agent with `profileId === null` (every agent today) resolves to EXACTLY
   * today's behavior: role straight from the caller, the agent's OWN prompt, and the config's
   * permission object UNCHANGED (same reference — no allow delta layered), so every existing spawn is
   * byte-identical when no profile is involved.
   *
   * Role composition (the load-bearing rule): an EXPLICIT caller role — worker_spawn → worker,
   * REST/scheduler → manager/platform — ALWAYS wins; the profile supplies role ONLY when the caller
   * didn't specify one (the plain "+New" path) AND the agent has a profile.
   *
   * DEFERRED to a later phase (NOT wired here): the profile's `model` (no `--model` emitted) and its
   * `skills` subset (all skills still delivered). This wires ONLY role + startupPrompt + allow.
   *
   * `forcePlain` (P3 spawn override): BYPASS the profile entirely so role + allow resolve via
   * resolveProfile's backstop — i.e. spawn as if the agent had no profile (a vanilla "+New": role null,
   * no allow delta; the injected prompt is the agent's own either way). The web "Spawn → force plain"
   * menu uses this so a manager/platform-profile agent can still start a COHERENT plain session, not one
   * carrying a manager role + allowlist it shouldn't have / can't use.
   */
  private resolveAgentSpawn(
    agent: Agent, config: ResolvedConfig, explicitRole?: SessionRole, forcePlain = false,
  ): { role: SessionRole | undefined; startupPrompt: string | undefined; permission: PermissionPolicy } {
    // forcePlain drops the profile lookup → resolveProfile's backstop yields role null, the agent's
    // own prompt, and NO allow delta (exactly a profile-less agent's "+New").
    const profile = (forcePlain || !agent.profileId) ? undefined : this.db.getProfile(agent.profileId);
    const resolved = resolveProfile(agent, profile);
    // Layer the profile's allowDelta onto the config allow; an empty delta keeps the SAME config
    // permission reference, so a profile-less spawn is byte-identical to today.
    const permission = resolved.allow.length
      ? { ...config.permission, allow: [...config.permission.allow, ...resolved.allow] }
      : config.permission;
    return {
      // An explicit caller role still wins; then the profile's role (null under forcePlain), then
      // undefined (today's plain). The force-plain path passes no explicitRole, so it resolves null.
      role: explicitRole ?? resolved.role ?? undefined,
      // Same `|| undefined` empties-to-undefined coercion today's start paths use on the agent prompt.
      startupPrompt: resolved.startupPrompt || undefined,
      permission,
    };
  }

  /**
   * Start a NEW session in an agent — injects the agent startup prompt once. `opts.forcePlain` (P3
   * web "Spawn → force plain") overrides any profile-conferred role to spawn a role-null session.
   */
  startNew(agentId: string, opts: { forcePlain?: boolean } = {}): Session {
    const agent = this.db.getAgent(agentId);
    if (!agent) throw new Error("agent not found");
    const project = this.db.getProject(agent.projectId);
    if (!project) throw new Error("project not found");
    const config = resolveConfig(project.config);
    // Phase-2: an agent with a Profile spawns with the profile's role + allowDelta (the injected
    // prompt is always the agent's own). No caller role here (plain "+New"), so the profile's role
    // applies when present. No profile ⇒ role undefined, the config permission unchanged — today's session.
    // forcePlain (P3) pins role to undefined even on a profile agent (see resolveAgentSpawn).
    const { role, startupPrompt, permission } = this.resolveAgentSpawn(agent, config, undefined, opts.forcePlain ?? false);

    const now = new Date().toISOString();
    const session: Session = {
      id: randomUUID(),
      projectId: project.id,
      agentId,
      engineSessionId: null,
      title: null,
      cwd: project.repoPath,
      processState: "starting",
      resumability: "unknown",
      busy: false,
      createdAt: now,
      lastActivity: now,
      lastError: null,
      role, // phase-2: profile-conferred role (undefined ⇒ today's plain, role-null session)
    };
    this.db.insertSession(session);
    // M5: flip to live BEFORE wiring the pty, so onExit ('exited') from a fast-failing spawn always
    // wins — there is no post-spawn 'live' write left to clobber it back to live.
    this.db.setProcessState(session.id, "live");
    this.pty.spawn({
      sessionId: session.id,
      cwd: session.cwd,
      permission,
      geometry: config.pty,
      sessionEnv: config.sessionEnv,
      vaultPath: config.docLint ? project.vaultPath : undefined, // Pillar D: scope the vault-lint hook
      startupPrompt,
      role,
    });
    return { ...session, processState: "live" };
  }

  /**
   * Start a NEW MANAGER session in an agent (phase-2 §A2). Mirrors startNew, but marks the
   * session role 'manager' (so it gets the loom-orchestration MCP + allowlist at spawn) and
   * runs in the project repo, NOT a worktree (managers coordinate; workers get the worktrees).
   */
  startManager(agentId: string): Session {
    const agent = this.db.getAgent(agentId);
    if (!agent) throw new Error("agent not found");
    const project = this.db.getProject(agent.projectId);
    if (!project) throw new Error("project not found");
    const config = resolveConfig(project.config);
    // Explicit 'manager' role from the caller (scheduler/REST) ALWAYS wins; the profile (if any) only
    // layers its prompt + allowDelta. No profile ⇒ byte-identical to today's manager spawn.
    const { role, startupPrompt, permission } = this.resolveAgentSpawn(agent, config, "manager");

    const now = new Date().toISOString();
    const session: Session = {
      id: randomUUID(),
      projectId: project.id,
      agentId,
      engineSessionId: null,
      title: null,
      cwd: project.repoPath, // a manager works in the repo, not a worktree
      processState: "starting",
      resumability: "unknown",
      busy: false,
      createdAt: now,
      lastActivity: now,
      lastError: null,
      role,
    };
    this.db.insertSession(session);
    // M5: flip to live BEFORE wiring the pty so a fast-failing spawn's onExit always wins.
    this.db.setProcessState(session.id, "live");
    this.pty.spawn({
      sessionId: session.id,
      cwd: session.cwd,
      permission,
      geometry: config.pty,
      sessionEnv: config.sessionEnv,
      vaultPath: config.docLint ? project.vaultPath : undefined, // Pillar D: scope the vault-lint hook
      startupPrompt,
      role,
    });
    return { ...session, processState: "live" };
  }

  /**
   * Start a NEW PLATFORM-LEAD session in an agent (phase-2 Pillar C). Mirrors startManager, but
   * role 'platform' (so it gets the loom-platform MCP + allowlist at spawn, NOT orchestration).
   * A platform-lead creates/configures projects + agents; it runs in its host project's repo.
   */
  startPlatformLead(agentId: string): Session {
    const agent = this.db.getAgent(agentId);
    if (!agent) throw new Error("agent not found");
    const project = this.db.getProject(agent.projectId);
    if (!project) throw new Error("project not found");
    const config = resolveConfig(project.config);
    // Explicit 'platform' role from the caller ALWAYS wins; the profile (if any) only layers its
    // prompt + allowDelta. No profile ⇒ byte-identical to today's platform-lead spawn.
    const { role, startupPrompt, permission } = this.resolveAgentSpawn(agent, config, "platform");

    const now = new Date().toISOString();
    const session: Session = {
      id: randomUUID(),
      projectId: project.id,
      agentId,
      engineSessionId: null,
      title: null,
      cwd: project.repoPath,
      processState: "starting",
      resumability: "unknown",
      busy: false,
      createdAt: now,
      lastActivity: now,
      lastError: null,
      role,
    };
    this.db.insertSession(session);
    // M5: flip to live BEFORE wiring the pty so a fast-failing spawn's onExit always wins.
    this.db.setProcessState(session.id, "live");
    this.pty.spawn({
      sessionId: session.id,
      cwd: session.cwd,
      permission,
      geometry: config.pty,
      sessionEnv: config.sessionEnv,
      vaultPath: config.docLint ? project.vaultPath : undefined, // Pillar D: scope the vault-lint hook
      startupPrompt,
      role,
    });
    return { ...session, processState: "live" };
  }

  /** Resume an existing session — NO prompt injection. */
  resume(sessionId: string, opts: { allowSuperseded?: boolean } = {}): Session {
    const session = this.db.getSession(sessionId);
    if (!session) throw new Error("session not found");
    if (!session.engineSessionId) throw new Error("session has no engine id to resume");
    // Backstop dead-ID detection: if the engine transcript is gone, this id is unresumable.
    if (!engineTranscriptExists(session.cwd, session.engineSessionId)) {
      this.db.setResumability(session.id, "dead");
      throw new Error("session is no longer resumable (engine transcript missing)");
    }
    // A RECYCLED session has a successor that took over its work + fleet (and inherited its wakes +
    // queued messages). Block AUTOMATIC resurrection — a due wake, a rate-limit resume, or boot-resume
    // would otherwise zombie it ALONGSIDE its successor (two managers on one agent). A HUMAN can still
    // force it: the manual /resume endpoint passes allowSuperseded — a deliberate escape hatch to
    // inspect or recover a retired session. (recycle_me reparents the wakes/queue, so the automatic
    // paths never NEED a recycled session anyway.)
    if (!opts.allowSuperseded && this.db.hasSuccessor(sessionId)) {
      throw new Error("session was recycled — a successor exists; only a manual (human) resume may force it");
    }
    const project = this.db.getProject(session.projectId);
    if (!project) throw new Error("project not found");
    const config = resolveConfig(project.config);

    // M5: flip to live BEFORE wiring the pty so a fast-failing spawn's onExit ('exited') always wins.
    this.db.setProcessState(session.id, "live");
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
    // A freshly-resumed session has no turn in flight (resume injects no prompt) — clear any stale
    // busy=true carried in the DB across the restart. Without this the session shows/acts "busy"
    // forever, so enqueued worker reports queue instead of submitting and the idle guard can't fire.
    this.db.setBusy(session.id, false);
    return { ...session, processState: "live", busy: false };
  }

  /**
   * Manager-triggered daemon restart (the `daemon_restart` tool) — for SELF-HOSTING (orchestrating
   * Loom WITH Loom). After a manager merges daemon-`src` worker branches, the new code isn't running
   * until the daemon is rebuilt + restarted; this does that and brings the manager (+ its live
   * workers) back on the other side via the restart-intent file (consumed in index.ts boot).
   *
   * Safety: (1) refuses unless under the supervisor (LOOM_SUPERVISED) — otherwise nothing relaunches
   * the daemon; (2) REBUILDS FIRST while still alive, so a broken build aborts the restart and leaves
   * the manager running to fix it, instead of exiting into a daemon that won't boot. On a green build
   * it records intent and exits with RESTART_EXIT_CODE; the supervisor relaunches.
   */
  async requestDaemonRestart(managerSessionId: string, reason: string): Promise<{ restarting: boolean; error?: string }> {
    const mgr = this.db.getSession(managerSessionId);
    if (!mgr || mgr.role !== "manager") throw new Error("only a manager can restart the daemon");
    if (!isSupervised()) {
      return { restarting: false, error: "daemon is not running under the restart supervisor (pnpm daemon:stable) — cannot self-restart. Flag that the human must restart for your merged code to go live." };
    }
    const build = await buildDaemon();
    if (build.code !== 0) {
      return { restarting: false, error: `daemon build failed — NOT restarting (your code stays un-deployed but the daemon stays up). Fix and retry:\n${build.tail}` };
    }
    const workerSessionIds = this.db
      .listWorkers(managerSessionId)
      .filter((w) => w.processState === "live")
      .map((w) => w.id);
    // Snapshot each resumed session's in-memory pending inbound FIFO so the undelivered queue survives
    // the process death and is replayed on boot (index.ts) — the persisted analogue of recycle's
    // in-process carriedPending. Grab it NOW, while the pty is still alive (the queue dies with the
    // process on exit). Only non-empty FIFOs are included. Defensive caps keep the intent JSON small:
    // a real FIFO holds a handful of short messages, so clip a pathologically long queue and skip a
    // single absurdly large message rather than bloat the persisted intent.
    const PENDING_MAX_MSGS = 50;
    const PENDING_MAX_MSG_LEN = 100_000;
    const pending: Record<string, string[]> = {};
    for (const id of [managerSessionId, ...workerSessionIds]) {
      const snap = this.pty
        .getPending(id)
        .filter((m) => m.length <= PENDING_MAX_MSG_LEN)
        .slice(0, PENDING_MAX_MSGS);
      if (snap.length > 0) pending[id] = snap;
    }
    writeRestartIntent({
      reason,
      managerSessionId,
      workerSessionIds,
      requestedAt: new Date().toISOString(),
      ...(Object.keys(pending).length > 0 ? { pending } : {}),
    });
    // Exit AFTER this MCP response flushes; the pty (incl. this manager) dies with the process, the
    // supervisor relaunches the freshly-built daemon, and boot re-resumes us from the intent.
    setTimeout(() => process.exit(RESTART_EXIT_CODE), 300);
    return { restarting: true };
  }

  /**
   * Fork an IDLE session: spawn a NEW Loom session that resumes the source's engine conversation
   * with --fork-session (a FRESH engine id), so it inherits the full context but then diverges
   * independently — the source's transcript is left untouched. Same cwd + role (so a forked manager
   * keeps its orchestration surface); orchestration lineage (parent/task/worktree) is NOT carried —
   * a fork is a conversation branch, not a worker. engineSessionId starts null: the fork's NEW id is
   * captured on its own SessionStart (same as a brand-new session). Idle-only: forking a busy session
   * could branch a half-written turn.
   */
  forkSession(sourceId: string): Session {
    const src = this.db.getSession(sourceId);
    if (!src) throw new Error("session not found");
    if (!src.engineSessionId) throw new Error("session has no engine context to fork (it never started)");
    if (src.busy) throw new Error("cannot fork a busy session — wait until it's idle");
    // The fork reads the source's transcript; if it's gone there's nothing to branch from.
    if (!engineTranscriptExists(src.cwd, src.engineSessionId)) {
      throw new Error("source conversation transcript is missing — nothing to fork");
    }
    const project = this.db.getProject(src.projectId);
    if (!project) throw new Error("project not found");
    const config = resolveConfig(project.config);

    // Pre-assign the fork's engine id (--session-id) and persist it up front. --fork-session mints
    // the new id lazily (on the fork's first turn), so the SessionStart hook would report the SOURCE
    // id — capturing it would be wrong. Assigning the id ourselves makes the fork's transcript known.
    const forkEngineId = randomUUID();
    const now = new Date().toISOString();
    const session: Session = {
      id: randomUUID(),
      projectId: src.projectId,
      agentId: src.agentId,
      engineSessionId: forkEngineId, // the fork's own (new) engine transcript id
      title: null,
      cwd: src.cwd, // fork in the same workspace as the source
      processState: "starting",
      resumability: "unknown",
      busy: false,
      createdAt: now,
      lastActivity: now,
      lastError: null,
      role: src.role ?? undefined, // a forked manager stays a manager (keeps its MCP surface)
    };
    this.db.insertSession(session);
    // M5: flip to live BEFORE wiring the pty so a fast-failing spawn's onExit ('exited') always wins.
    this.db.setProcessState(session.id, "live");
    this.pty.spawn({
      sessionId: session.id,
      cwd: session.cwd,
      permission: config.permission,
      geometry: config.pty,
      sessionEnv: config.sessionEnv,
      vaultPath: config.docLint ? project.vaultPath : undefined, // Pillar D: scope the vault-lint hook
      resumeId: src.engineSessionId, // resume the SOURCE conversation...
      fork: true,                    // ...but fork it (--fork-session)...
      forkSessionId: forkEngineId,   // ...into this pre-assigned id (--session-id).
      role: src.role ?? undefined,
    });
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
    opts: { taskId: string; agentId?: string; kickoffPrompt: string },
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
      agentId: opts.agentId ?? manager.agentId,
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
    // M5: flip to live BEFORE wiring the pty so a fast-failing spawn's onExit ('exited') always wins.
    this.db.setProcessState(worker.id, "live");
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

    // Carry the old worker's in-flight inbound queue (manager messages held while it was busy) onto
    // the fresh worker — same task + worktree, so they're still valid. Grab it NOW, while the old pty
    // is still alive (its live entry, and the queue with it, is dropped on exit). Wakes are moved below.
    const carriedPending = this.pty.getPending(workerSessionId);
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
      agentId: old.agentId,
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
    // M5: flip to live BEFORE wiring the pty so a fast-failing spawn's onExit ('exited') always wins.
    this.db.setProcessState(fresh.id, "live");
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
    // Hand the carried queue + scheduled wakes to the successor: re-point the old worker's wakes (so a
    // due wake can't resurrect the retired worker) and re-enqueue the held messages (busy-gated; they
    // drain on the fresh worker's first turn boundary, after its handoff turn).
    this.db.reparentWakes(workerSessionId, fresh.id);
    for (const m of carriedPending) this.pty.enqueueStdin(fresh.id, m);
    this.db.appendEvent({
      id: randomUUID(), ts: new Date().toISOString(),
      managerSessionId, workerSessionId: fresh.id, taskId, kind: "recycle_complete",
      detail: { recycledFrom: old.id, gen: newGen },
    });
    return { ...fresh, processState: "live" };
  }

  /**
   * Recycle a MANAGER near its context limit (the `recycle_me` flow). The manager has already run
   * /session-end and written `continuationPrompt`; here Loom boots a FRESH successor manager seeded
   * with the agent warm-up prompt + that continuation (NOT --resume — fresh context, intent carried),
   * RE-PARENTS the old manager's live workers onto the successor so the fleet survives, then closes
   * the old manager (deferred, so this call's tool response flushes first). gen+1; recycledFrom = old.
   */
  async recycleManager(oldManagerId: string, continuationPrompt: string): Promise<Session> {
    const old = this.db.getSession(oldManagerId);
    if (!old || old.role !== "manager") throw new Error("not a manager session");
    const agent = this.db.getAgent(old.agentId);
    const project = this.db.getProject(old.projectId);
    if (!project) throw new Error("project not found");
    const config = resolveConfig(project.config);
    const newGen = (old.gen ?? 0) + 1;

    this.db.appendEvent({
      id: randomUUID(), ts: new Date().toISOString(),
      managerSessionId: oldManagerId, kind: "recycle_begin", detail: { kind: "manager", gen: newGen },
    });

    const warmup = agent?.startupPrompt?.trim();
    const startupPrompt =
      (warmup ? warmup + "\n\n---\n" : "") +
      `[loom:continuation] You are the successor to a previous manager session that recycled as it neared its ` +
      `context limit. Continue its work from this handoff — your predecessor's live workers have been re-parented ` +
      `to you (run worker_list to see them). Predecessor's handoff:\n\n${continuationPrompt}`;

    const now = new Date().toISOString();
    const fresh: Session = {
      id: randomUUID(),
      projectId: old.projectId,
      agentId: old.agentId,
      engineSessionId: null,
      title: null,
      cwd: old.cwd, // a manager works in the project repo (same cwd)
      processState: "starting",
      resumability: "unknown",
      busy: false,
      createdAt: now,
      lastActivity: now,
      lastError: null,
      role: "manager",
      gen: newGen,
      recycledFrom: old.id,
    };
    this.db.insertSession(fresh);
    // M5: flip to live BEFORE wiring the pty so a fast-failing spawn's onExit ('exited') always wins.
    this.db.setProcessState(fresh.id, "live");
    this.pty.spawn({
      sessionId: fresh.id,
      cwd: fresh.cwd,
      permission: config.permission,
      geometry: config.pty,
      sessionEnv: config.sessionEnv,
      vaultPath: config.docLint ? project.vaultPath : undefined, // Pillar D: scope the vault-lint hook
      startupPrompt,
      role: "manager", // successor keeps the orchestration surface
    });

    // Re-parent live workers onto the successor BEFORE closing the old manager, so they're never
    // orphaned (worker_report routes by parent_session_id; the successor sees them via worker_list).
    const reparented = this.db.reparentLiveWorkers(oldManagerId, fresh.id);
    // Carry the old manager's scheduled wakes + its in-flight inbound queue (worker reports / human
    // turns held while it was busy) onto the successor — it owns the fleet now, so these are its to
    // handle. Re-pointing the wakes also guarantees nothing fires at the retired manager (which would
    // zombie-resurrect it). Grab pending while the old pty is still alive (its 3s deferred stop is below).
    this.db.reparentWakes(oldManagerId, fresh.id);
    for (const m of this.pty.getPending(oldManagerId)) this.pty.enqueueStdin(fresh.id, m);

    this.db.appendEvent({
      id: randomUUID(), ts: new Date().toISOString(),
      managerSessionId: fresh.id, kind: "recycle_complete",
      detail: { recycledFrom: old.id, gen: newGen, reparentedWorkers: reparented },
    });

    // Close the predecessor AFTER a short delay so the recycle_me tool response (it's the old manager's
    // own MCP call) flushes before its pty is killed.
    setTimeout(() => { try { this.pty.stop(oldManagerId, "hard"); } catch { /* already gone */ } }, 3000);

    return { ...fresh, processState: "live" };
  }

  /**
   * The manager-surface `idle_report` handler (Asleep-at-the-Wheel watchdog, §3 state→action table).
   * A manager self-reports its idle disposition so the watchdog stops nudging it (or, later, knows to
   * alert the human). Maps the reported state to a nudge policy on the P1 idle_nudge_* columns and, in
   * EVERY case, leaves the unanswered-nudge counter at 0 (the manager engaged, so the escalation clock
   * resets). resetIdleNudgeState clears policy+snooze+unanswered to the watching baseline; for
   * snoozed/suppressed we reset FIRST (to zero the counter) then layer the target policy on — so we
   * only ever touch the P1 accessors and never leave a stale count behind.
   *
   * NOTE: the `blocked_human`/`done` HUMAN-FACING alert is Task 4 — here we only set policy + audit the
   * detail; we do NOT raise a notification. The nudge ticker that drives this is Task 3.
   */
  recordIdleReport(
    sessionId: string,
    state: "working" | "waiting" | "blocked_human" | "done",
    opts: { detail?: string; minutes?: number } = {},
  ): { recorded: boolean; state: string; policy: IdleNudgePolicy; snoozeUntil: string | null; unanswered: number } {
    const session = this.db.getSession(sessionId);
    if (!session) throw new Error("unknown session");
    if (session.role !== "manager") throw new Error("idle_report is a manager-only surface");
    const project = this.db.getProject(session.projectId);
    if (!project) throw new Error("project not found");

    let policy: IdleNudgePolicy;
    let snoozeUntil: string | null = null;
    // working → back at work: drop straight to the watching baseline (policy/snooze/unanswered all clear).
    // waiting → snooze for `minutes` (or the per-project default) — silent until then.
    // blocked_human / done → suppress (the human-facing alert is Task 4; here we just stop nudging).
    if (state === "working") {
      this.db.resetIdleNudgeState(sessionId);
      policy = "watching";
    } else if (state === "waiting") {
      const mins = opts.minutes ?? resolveConfig(project.config).orchestration.idleDefaultSnoozeMinutes;
      snoozeUntil = new Date(Date.now() + mins * 60_000).toISOString();
      this.db.resetIdleNudgeState(sessionId); // zero the unanswered counter first (P1 setIdleNudgePolicy doesn't)
      this.db.setIdleNudgePolicy(sessionId, "snoozed", snoozeUntil);
      policy = "snoozed";
    } else {
      // blocked_human | done
      this.db.resetIdleNudgeState(sessionId); // zero the unanswered counter first
      this.db.setIdleNudgePolicy(sessionId, "suppressed");
      policy = "suppressed";
    }

    this.db.appendEvent({
      id: randomUUID(), ts: new Date().toISOString(),
      managerSessionId: sessionId, kind: "idle_report",
      detail: { state, detail: opts.detail, minutes: opts.minutes, policy, snoozeUntil },
    });

    // resetIdleNudgeState always zeros the counter and we never re-bump it here ⇒ unanswered === 0.
    return { recorded: true, state, policy, snoozeUntil, unanswered: 0 };
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
    //
    // ⚠️ TRUST BOUNDARY — HOST RCE BY DESIGN. `gate` is `orchestration.gateCommand` from the project
    // config and is executed here as an arbitrary HOST shell command (`shell: true`). `shell:true` is
    // intentional: real gates need it (e.g. `pnpm build && pnpm test`). This makes gateCommand
    // host-RCE-capable, so it is TRUSTED / HUMAN-SET ONLY and MUST NEVER be agent-writable. The
    // agent-facing loom-platform MCP path (project_create / project_configure) validates config with
    // `validateAgentProjectConfigOverride`, which REJECTS `orchestration.gateCommand` (see
    // mcp/platform.ts). Only the human/trusted REST path (PATCH /api/projects/:id/config) may set it.
    // If you add another config-write surface reachable by an agent, it MUST use the agent validator.
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
    await this.finalizeMerge({ managerSessionId, workerSessionId, taskId, worktreePath, branch, repoPath: project.repoPath });
    return { merged: true };
  }

  /**
   * The post-merge bookkeeping shared by confirmWorkerMerge (the interactive merge path) and
   * reconcileOrchestrationOnBoot (orphaned-merge recovery): retire the worktree, delete the
   * now-merged branch, finish the task, and record `merge_done`. Factored out so the two callers
   * can't drift. The CALLER guarantees no live pty holds the worktree cwd (confirmWorkerMerge
   * hard-stops the worker first; at boot no pty from a prior run survives). Best-effort + idempotent:
   * removeWorktree has its fs.rm backstop, deleteBranch swallows a missing branch, and updateTask is
   * a no-op when the task is already `done`.
   *
   * removeWorktree is BEST-EFFORT and runs FIRST, but its throw must NOT abort the rest: on Windows a
   * just-hard-stopped worker's dir can keep a busy handle (node_modules/native modules, a lingering
   * build) past fs.rm's retry budget, so removeWorktree throws even though the `git merge` already
   * committed. Unguarded, that would skip deleteBranch/updateTask/merge_done and make the interactive
   * merge report an ERROR for an already-landed merge. So we swallow it (warn) and finish the
   * bookkeeping; the leaked dir is GC'd by boot-reconcile's Pass B on the next restart.
   */
  private async finalizeMerge(args: {
    managerSessionId: string; workerSessionId: string; taskId: string | null;
    worktreePath: string; branch: string; repoPath: string;
  }): Promise<void> {
    try {
      await removeWorktree(args.repoPath, args.worktreePath);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[finalizeMerge] could not remove worktree ${args.worktreePath} (dir busy?); ` +
        `merge already landed — finishing bookkeeping, boot-reconcile Pass B will GC the dir: ${(e as Error).message}`);
    }
    await deleteBranch(args.repoPath, args.branch);
    if (args.taskId) this.db.updateTask(args.taskId, { columnKey: "done" });
    this.db.appendEvent({
      id: randomUUID(), ts: new Date().toISOString(),
      managerSessionId: args.managerSessionId, workerSessionId: args.workerSessionId,
      taskId: args.taskId, kind: "merge_done", detail: { branch: args.branch },
    });
  }

  /**
   * Boot-time orchestration reconcile (#22 run-2 + audit M4). Run once at daemon boot, AFTER
   * recoverStaleSessions has marked prior-run ptys exited (so nothing live holds a worktree).
   * Two surgical, idempotent passes:
   *
   *  A. Finish orphaned merges. confirmWorkerMerge commits the `git merge` BEFORE its bookkeeping
   *     (removeWorktree → deleteBranch → updateTask done → merge_done). If the process dies in
   *     between (e.g. the dev daemon runs from the repo it merged into, so the merge triggers a
   *     `tsx watch` restart), the merge is correct but the task stays in_progress and the
   *     worktree/branch leak. For each worker whose branch is ALREADY merged into the canonical
   *     branch but whose task isn't done and/or whose worktree still exists, we run the SAME
   *     finalizeMerge. Idempotent: deleteBranch makes the branch vanish, so a re-run no longer
   *     detects it as merged.
   *
   *  B. GC orphaned worktrees (M4). For an exited/dead worker whose worktree dir still lingers and
   *     isn't a finished merge handled in (A), prune the DIR ONLY (best-effort) so crashed-worker
   *     worktrees don't accumulate (they otherwise feed the H1 re-task deadlock). We never delete
   *     the branch here — any committed work stays on it and createWorktree re-attaches a fresh
   *     worktree to it on a re-task.
   */
  async reconcileOrchestrationOnBoot(protectedSessionIds: Set<string> = new Set()): Promise<{ mergesFinished: number; mergesFailed: number; worktreesPruned: number }> {
    const all = this.db.listAllSessions();
    const handledWorktrees = new Set<string>();
    let mergesFinished = 0;
    let mergesFailed = 0;
    let worktreesPruned = 0;

    // A. Finish orphaned merges. Best-effort PER SESSION: finalizeMerge now swallows a removeWorktree
    // throw internally (so a busy dir won't even abort the per-session finalize), but the try/catch
    // here still guards the rest of finalizeMerge (deleteBranch/updateTask/db). This runs over EVERY
    // session from every past run at boot — one throw must not abort the whole reconcile (or, since
    // merging this branch self-restarts the dev daemon, crash-loop the boot). So a failed session is
    // warned, counted, and skipped; the next boot retries it.
    for (const s of all) {
      if (s.role !== "worker" || !s.branch || !s.taskId) continue;
      if (protectedSessionIds.has(s.id)) continue; // about to be resumed (restart-intent) — leave it intact
      const project = this.db.getProject(s.projectId);
      if (!project) continue;
      try {
        if (!(await isBranchMerged(project.repoPath, s.branch))) continue;
        const worktreePath = s.worktreePath ?? s.cwd;
        const worktreeOnDisk = !!worktreePath && fs.existsSync(worktreePath);
        const taskDone = this.db.getTask(s.taskId)?.columnKey === "done";
        if (taskDone && !worktreeOnDisk) continue; // already fully reconciled — nothing to finish
        await this.finalizeMerge({
          managerSessionId: s.parentSessionId ?? "", workerSessionId: s.id, taskId: s.taskId,
          worktreePath, branch: s.branch, repoPath: project.repoPath,
        });
        handledWorktrees.add(worktreePath);
        mergesFinished++;
      } catch (e) {
        mergesFailed++;
        // eslint-disable-next-line no-console
        console.warn(`[reconcile] could not finish merge for worker ${s.id} (branch ${s.branch}): ${(e as Error).message}`);
      }
    }

    // B. GC orphaned worktrees (exited/dead, dir on disk, not handled in A).
    for (const s of all) {
      const worktreePath = s.worktreePath;
      if (!worktreePath || handledWorktrees.has(worktreePath)) continue;
      if (protectedSessionIds.has(s.id)) continue; // restart-intent worker — keep its worktree to resume into
      if (s.processState !== "exited" && s.resumability !== "dead") continue;
      if (!fs.existsSync(worktreePath)) continue;
      const project = this.db.getProject(s.projectId);
      if (!project) continue;
      try { await removeWorktree(project.repoPath, worktreePath); } catch { /* best-effort */ }
      handledWorktrees.add(worktreePath); // recycle chains share a worktree → prune once
      worktreesPruned++;
    }

    return { mergesFinished, mergesFailed, worktreesPruned };
  }
}
