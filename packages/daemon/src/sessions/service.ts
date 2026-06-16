import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Ajv } from "ajv";
import {
  resolveConfig, resolveProfile, DEFAULT_TASK_PRIORITY,
  type Session, type StopMode, type OrchestrationEvent, type Task,
  type Agent, type SessionRole, type ResolvedConfig, type PermissionPolicy, type Schedule,
  type AgentRun,
} from "@loom/shared";
import type { Db, IdleNudgePolicy } from "../db.js";
import type { PtyHost } from "../pty/host.js";
import { modeAfterCyclesFromAcceptEdits } from "../pty/host.js";
import { createWorktree, removeWorktree, deleteBranch, diffBranch, mergeBranch, findLandedSquashCommit, worktreeHasWork, detectStrandedWork, precheckWorkerDone, type DiffstatFile } from "../git/worktrees.js";
import { engineTranscriptExists, snapshotTranscript, deleteArchivedTranscript, archivedTranscriptExists, archivedTranscriptPath } from "./transcript.js";
import { readRunUsage, readRunUsageFromFile } from "./context.js";
import { computeRunCostUsd } from "./pricing.js";
import { createRunSnapshot, removeRunSnapshot, sweepAllRunSnapshots } from "../runs/snapshot.js";
import { composeRunStartupPrompt } from "../runs/prompt.js";
import type { OrchestrationControl } from "../orchestration/control.js";
import { isLikelyNearClaudeUsageLimit } from "../orchestration/usage-awareness.js";
import { RESTART_EXIT_CODE, isSupervised, writeRestartIntent, buildDaemon, resumeSetFromIntent, type RestartIntent, type RestartResumeEntry } from "../orchestration/restart.js";
import { resolveBackupConfig, takeBackup } from "../orchestration/db-backup.js";
import { recordUndeliveredReport } from "../orchestration/crash-recovery-watcher.js";
import { nextFireAt } from "../orchestration/cron.js";
import { validateAgentProjectConfigOverride } from "../mcp/platform.js";
import { PLATFORM_PROJECT_NAME } from "../platform/seed.js";

/** Floor (1s) for any threaded git-op timeout — a sub-second misconfig must never make every git op
 *  fail-fast (mirrors GitWriter's GIT_TIMEOUT_FLOOR_MS). Applied where the resolved value is threaded. */
const GIT_TIMEOUT_FLOOR_MS = 1_000;

/** Agent Runs R2: defer a completed run's graceful-stop this long so the `submit_result` {ok:true} tool
 *  response flushes to the agent BEFORE its turn is interrupted (mirrors requestDaemonRestart's
 *  respond-then-teardown 300ms). The run row is already terminal by the time this fires. */
const RUN_TEARDOWN_DELAY_MS = 250;

/**
 * Agent Runs R3: the run-completion webhook (POSTed the run summary on a terminal transition). The
 * network primitive is injectable (tests stub it); the default is a SINGLE bounded fetch. Mirrors the
 * alert-webhook + bounded-git posture EXACTLY: a hard timeout caps a hung/garbage endpoint and ALL
 * errors are swallowed/logged, so a delivery fault can NEVER throw into / wedge the teardown path.
 */
export type RunWebhookPoster = (url: string, body: unknown, timeoutMs: number) => Promise<void>;

/**
 * Agent Runs (capstone fix): fallback hard run-timeout (ms) when the boot-bound `platform.timeouts.runMs`
 * isn't threaded in (the 3-arg test constructor). A run still non-terminal after this is force-marked
 * `timed_out` + torn down — the backstop for an agent that finishes WITHOUT calling submit_result (which
 * otherwise hangs the run `running` + the session live forever). Mirrors the git-timeout module fallback.
 */
const RUN_TIMEOUT_MS = 600_000; // 10 min

/** Per-POST ceiling for a run webhook (bounds a hung endpoint, like GIT_*_TIMEOUT_MS). Test-overridable. */
const RUN_WEBHOOK_TIMEOUT_MS = 5_000;
/** At most this many delivery attempts (best-effort; the design calls for ≤1–2 retries). */
const RUN_WEBHOOK_ATTEMPTS = 2;

/** Default run-webhook poster: one bounded `fetch` POST; the AbortController caps a hung endpoint. */
const defaultRunWebhookPost: RunWebhookPoster = async (url, body, timeoutMs) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
};

/** Ties the session registry (Db) to the PtyHost. Owns new/resume orchestration. */
export class SessionService {
  /**
   * BOOT-BOUND git timeouts (resolved `platform.timeouts.gitOpMs`/`provisionMs`), threaded by index.ts
   * at boot into the bounded-git / provision deps seams at this service's call-sites. `undefined` when
   * not supplied (the 3-arg test constructor), in which case each git fn falls back to its OWN module
   * const — so existing tests are byte-identical. The git-op value is floored to ≥1s here.
   */
  private readonly gitOpMs: number | undefined;
  private readonly provisionMs: number | undefined;
  /** Agent Runs R3 run-webhook delivery (injectable for tests; defaults to a bounded fetch + 5s cap). */
  private readonly runWebhookPost: RunWebhookPoster;
  private readonly runWebhookTimeoutMs: number;
  /**
   * Agent Runs (capstone fix): BOOT-BOUND hard run-timeout (resolved `platform.timeouts.runMs`), threaded
   * by index.ts like the git timeouts; falls back to RUN_TIMEOUT_MS for the 3-arg test constructor. Tests
   * pass a tiny value to exercise the timeout deterministically.
   */
  private readonly runTimeoutMs: number;
  /**
   * Live per-run hard-timeout handles, keyed by runId. Armed in startRun; CLEARED on every terminal
   * transition (submit / cancel / timeout-fire / session-exit) so a timer never fires late or
   * double-tears-down. A run absent from the map has no pending timer (already terminal or never armed).
   */
  private readonly runTimers = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(
    private db: Db, private pty: PtyHost, private control: OrchestrationControl,
    opts?: { gitOpMs?: number; provisionMs?: number; runWebhookPost?: RunWebhookPoster; runWebhookTimeoutMs?: number; runTimeoutMs?: number },
  ) {
    this.gitOpMs = opts?.gitOpMs == null ? undefined : Math.max(GIT_TIMEOUT_FLOOR_MS, opts.gitOpMs);
    this.provisionMs = opts?.provisionMs;
    this.runWebhookPost = opts?.runWebhookPost ?? defaultRunWebhookPost;
    this.runWebhookTimeoutMs = opts?.runWebhookTimeoutMs ?? RUN_WEBHOOK_TIMEOUT_MS;
    this.runTimeoutMs = opts?.runTimeoutMs ?? RUN_TIMEOUT_MS;
  }

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
   * Phase-3 model wiring: the profile's `model` (when non-null) is now threaded through to the spawn
   * recipe as a `--model <id>` arg. When null/absent it is byte-identical to today (no `--model`). This
   * applies to the FRESH-start paths only (startNew/startManager/startPlatformLead/startAuditor) — a
   * `--resume`/`--fork-session` spawn deliberately omits `--model` and inherits the conversation's model
   * from the engine transcript, keeping every resume/fork byte-identical.
   *
   * Phase-3 skills wiring: the profile's `skills` subset is resolved here and PINNED on the session row
   * at fresh spawn (like browserTesting), then read from the row on resume/fork/recycle/boot — NEVER
   * re-resolved (the profile may have changed). injectSkills delivers only the pinned subset; null/empty
   * ⇒ all skills (byte-identical to today). An empty subset is normalized to null at the pin sites.
   *
   * `forcePlain` (P3 spawn override): BYPASS the profile entirely so role + allow resolve via
   * resolveProfile's backstop — i.e. spawn as if the agent had no profile (a vanilla "+New": role null,
   * no allow delta; the injected prompt is the agent's own either way). The web "Spawn → force plain"
   * menu uses this so a manager/platform-profile agent can still start a COHERENT plain session, not one
   * carrying a manager role + allowlist it shouldn't have / can't use.
   */
  private resolveAgentSpawn(
    agent: Agent, config: ResolvedConfig, explicitRole?: SessionRole, forcePlain = false,
  ): { role: SessionRole | undefined; startupPrompt: string | undefined; permission: PermissionPolicy; browserTesting: boolean; model: string | undefined; skills: string[] | null } {
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
      // Opt-in browser capability from the resolved profile (backstop false under forcePlain / no profile).
      browserTesting: resolved.browserTesting,
      // Profile-pinned model → `--model` at spawn; null/absent ⇒ undefined ⇒ no `--model` (byte-identical).
      // `|| undefined` so an empty-string model is treated as "engine default", same coercion as the prompt.
      model: resolved.model || undefined,
      // Profile-pinned skill subset → pinned on the session row + delivered by injectSkills. Normalize an
      // empty array to null ("no subset ⇒ deliver all", today's behavior); backstop null under forcePlain.
      skills: resolved.skills && resolved.skills.length ? resolved.skills : null,
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
    const { role, startupPrompt, permission, browserTesting, model, skills } = this.resolveAgentSpawn(agent, config, undefined, opts.forcePlain ?? false);

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
      browserTesting, // profile-conferred browser opt-in (false ⇒ today's plain spawn)
      skills, // profile-conferred skill subset, pinned (null ⇒ deliver all — today's behavior)
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
      browserTesting,
      model, // profile-pinned model → `--model` (undefined ⇒ no `--model`, byte-identical to today)
      skills, // profile-pinned skill subset → injectSkills delivers only these (null ⇒ all, byte-identical)
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
    const { role, startupPrompt, permission, browserTesting, model, skills } = this.resolveAgentSpawn(agent, config, "manager");

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
      browserTesting,
      skills, // profile-pinned skill subset, pinned on the row (null ⇒ deliver all — today's behavior)
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
      browserTesting,
      model, // profile-pinned model → `--model` (undefined ⇒ no `--model`, byte-identical to today)
      skills, // profile-pinned skill subset → injectSkills delivers only these (null ⇒ all, byte-identical)
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

    // SINGLETON GUARANTEE = "never two LIVE Leads" (NOT "one row ever"). A manual Spawn always gets a
    // FRESH session; the only thing we refuse is minting a SECOND live Lead while one is already running.
    // (Earlier this was RESUME-OR-CREATE — it silently resumed the latest EXITED Lead on a manual Spawn,
    // which the owner reported as "Spawn resumes the old session instead of starting a new one". On-demand
    // resume is now an explicit human action: the Lead/Auditor History "Resume" button → resumeSession.)
    //
    // So: if a platform session is already LIVE, reuse it as-is (its pty outlived the viewer — closing a
    // ws never kills it — so there is nothing to re-spawn, and we must not spawn a duplicate). This is the
    // load-bearing live-precedence guard (the P1 0e40dde fix). Otherwise (none live) FALL THROUGH and
    // INSERT+spawn a brand-new Lead — never resume an exited one here.
    //
    // LIVE-PRECEDENCE (load-bearing): listSessions is ordered by last_activity DESC, so a recently-STOPPED
    // Lead (frozen last_activity) can sort AHEAD of an idle-but-LIVE Lead. We therefore scan for ANY live
    // platform session rather than just inspecting platforms[0] (there should be ≤1; if legacy
    // accumulation left >1, the most-recently-active live one wins).
    //
    // Restart-resume is INDEPENDENT of this path: index.ts → resumeFleetOnBoot resumes captured sessions
    // by id, so a daemon_restart still brings the Lead back. Changing this function does not affect it.
    //
    // Scope: this is the HUMAN platform route only (gateway POST /api/agents/:id/sessions {role:
    // "platform"}); no agent/MCP path reaches here, so "platform sessions are human-created only"
    // stands. The Auditor (startAuditor) is deliberately LEFT create-only — each scheduled fire spawns
    // a fresh ephemeral read-and-file audit session, where a singleton would be wrong.
    // db.liveSessions is the canonical live-over-recency query (filters to LIVE before any .find, so a
    // recently-STOPPED Lead can't sort ahead of an idle-but-LIVE one — see its note + 0e40dde).
    const live = this.db.liveSessions(agentId).find((s) => s.role === "platform");
    if (live) return live; // already attached — reuse, no new row, no spawn (never two LIVE Leads)

    const config = resolveConfig(project.config);
    // Explicit 'platform' role from the caller ALWAYS wins; the profile (if any) only layers its
    // prompt + allowDelta. No profile ⇒ byte-identical to today's platform-lead spawn.
    const { role, startupPrompt, permission, browserTesting, model, skills } = this.resolveAgentSpawn(agent, config, "platform");

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
      browserTesting,
      skills, // profile-pinned skill subset, pinned on the row (null ⇒ deliver all — today's behavior)
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
      browserTesting,
      model, // profile-pinned model → `--model` (undefined ⇒ no `--model`, byte-identical to today)
      skills, // profile-pinned skill subset → injectSkills delivers only these (null ⇒ all, byte-identical)
    });
    return { ...session, processState: "live" };
  }

  /**
   * Start a NEW PLATFORM-AUDITOR session in an agent (Platform Manager P5). Mirrors startPlatformLead,
   * but passes callerRole "auditor" — and because an EXPLICIT caller role ALWAYS wins in
   * resolveAgentSpawn, the session role is LOCKED to "auditor" regardless of the agent's profile role.
   * This is the load-bearing security guarantee: the gate is keyed off the SESSION role, never the
   * profile role, so even a mis-seeded/edited profile can't change what surface an Auditor session gets.
   * An "auditor" session gets ONLY the restricted loom-audit MCP at spawn (buildMcpServers) — it 404s on
   * /mcp-platform (resolveRole gates role==="platform") AND /mcp-orch (gates manager|worker), so a hostile
   * transcript can never turn an audit into an outward/destructive action. Human-REST/scheduler-only
   * (POST /api/agents/:id/sessions {role:"auditor"} + the Scheduler) — no agent/MCP path mints one.
   */
  startAuditor(agentId: string): Session {
    const agent = this.db.getAgent(agentId);
    if (!agent) throw new Error("agent not found");
    const project = this.db.getProject(agent.projectId);
    if (!project) throw new Error("project not found");
    const config = resolveConfig(project.config);
    // Explicit 'auditor' role from the caller ALWAYS wins; the profile (if any) only layers its prompt +
    // allowDelta. The locked role — NOT the profile role — drives the restricted loom-audit surface.
    const { role, startupPrompt, permission, browserTesting, model, skills } = this.resolveAgentSpawn(agent, config, "auditor");

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
      browserTesting,
      skills, // profile-pinned skill subset, pinned on the row (null ⇒ deliver all — today's behavior)
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
      browserTesting,
      model, // profile-pinned model → `--model` (undefined ⇒ no `--model`, byte-identical to today)
      skills, // profile-pinned skill subset → injectSkills delivers only these (null ⇒ all, byte-identical)
    });
    return { ...session, processState: "live" };
  }

  /**
   * Start a NEW SETUP-ASSISTANT session in an agent (Setup Assistant E1-5). Mirrors startPlatformLead
   * EXACTLY — incl. its liveness-not-recency SINGLETON guard — but passes callerRole "setup" so the
   * session is LOCKED to the curated, ungated loom-setup MCP surface (E1-3). Because an EXPLICIT caller
   * role ALWAYS wins in resolveAgentSpawn, the session role is "setup" regardless of the agent's profile
   * role — the gate is keyed off the SESSION role, never the profile role.
   *
   * SINGLETON GUARANTEE = "never two LIVE setup sessions" (NOT "one row ever"), identical to the Lead.
   * If a setup session is already LIVE, reuse it as-is (its pty outlived the viewer) — never mint a 2nd.
   * Otherwise FALL THROUGH and INSERT+spawn a brand-new setup session (never resume an exited one here).
   * Uses db.liveSessions (the canonical live-over-recency query — filters to LIVE before any .find, so a
   * recently-STOPPED setup session can't sort ahead of an idle-but-LIVE one; see its note + 0e40dde).
   *
   * HUMAN-REST only (gateway POST /api/agents/:id/sessions {role:"setup"}) — no agent/MCP path mints one
   * (session_spawn on the setup surface itself REFUSES role "setup", so a setup session can't self-clone).
   * The Setup Assistant agent lives in the reserved "Getting Started" home (E1-4).
   */
  startSetup(agentId: string): Session {
    const agent = this.db.getAgent(agentId);
    if (!agent) throw new Error("agent not found");
    const project = this.db.getProject(agent.projectId);
    if (!project) throw new Error("project not found");

    // Live-precedence singleton: reuse an already-LIVE setup session (never two LIVE), else fall through
    // and INSERT+spawn a fresh one. Identical to startPlatformLead's guard (the P1 0e40dde fix).
    const live = this.db.liveSessions(agentId).find((s) => s.role === "setup");
    if (live) return live; // already attached — reuse, no new row, no spawn (never two LIVE setup sessions)

    const config = resolveConfig(project.config);
    // Explicit 'setup' role from the caller ALWAYS wins; the profile (if any) only layers its prompt +
    // allowDelta. The locked role — NOT the profile role — drives the curated loom-setup surface.
    const { role, startupPrompt, permission, browserTesting, model, skills } = this.resolveAgentSpawn(agent, config, "setup");

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
      browserTesting,
      skills, // profile-pinned skill subset, pinned on the row (null ⇒ deliver all — today's behavior)
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
      browserTesting,
      model, // profile-pinned model → `--model` (undefined ⇒ no `--model`, byte-identical to today)
      skills, // profile-pinned skill subset → injectSkills delivers only these (null ⇒ all, byte-identical)
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
    // Ghost-resume guard: the engine transcript lives under ~/.claude keyed by cwd, so it SURVIVES the
    // worktree's removal — a worker whose task merged + worktree was GC'd still passes the transcript
    // guard above, but a `--resume` spawn into the now-missing cwd dies code=1. Refuse here so the boot
    // fleet-resume path counts it `failed` instead of spawning a doomed pty.
    if (!fs.existsSync(session.cwd)) {
      this.db.setResumability(session.id, "dead");
      throw new Error("session is no longer resumable (worktree/cwd missing)");
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
      // RESUME mode convergence (card f05e4897) — SUPERSEDES Fix A's blind startupModeCycles:0. A
      // `claude --resume` HONOURS `--permission-mode acceptEdits` and boots at acceptEdits — the SAME
      // gate-free mode a fresh spawn boots in (probe-verified on 2.1.163; it does NOT restore the
      // persisted mode, the opposite of Fix A's premise). A fresh spawn then blind-cycles the config's
      // `startupModeCycles` (2) Shift+Tabs to the target (auto). On the resume path a blind count is
      // unreliable (the old blind-2 half-landed on plan on the summary-gate path — the 2026-06-03 strand
      // bug; Fix A's blind-0 left it ONE short, stuck at acceptEdits). So resume converges ABSOLUTELY:
      // pass the target mode and host.ts feedback-cycles the footer to it (bounded + graceful — worst
      // case stays at today's acceptEdits). The target is wherever a FRESH spawn of THIS config lands
      // (modeAfterCyclesFromAcceptEdits of the same startupModeCycles → auto by default), so a resumed
      // session matches a fresh one exactly. startupModeCycles is moot on this path (the feedback cycler,
      // not the blind count, moves the mode) — pin it 0 so the FRESH blind branch stays inert here.
      permission: { ...config.permission, startupModeCycles: 0 },
      resumeModeTarget: modeAfterCyclesFromAcceptEdits(config.permission.startupModeCycles ?? 0),
      geometry: config.pty,
      sessionEnv: config.sessionEnv,
      vaultPath: config.docLint ? project.vaultPath : undefined, // Pillar D: scope the vault-lint hook
      resumeId: session.engineSessionId,
      // Carry the role across resume so a manager/worker/platform session is re-spawned WITH its
      // role-gated MCP surface (loom-orchestration / loom-platform) + allowlist. Without this a
      // resumed manager loses worker_spawn/merge/etc. and a worker loses worker_report.
      role: session.role ?? undefined,
      // Carry the browser capability across resume too (pinned on the row at spawn): a resumed
      // browser-worker must keep its per-session Playwright MCP, exactly as role is re-passed.
      browserTesting: session.browserTesting ?? false,
      // Carry the pinned skill subset across resume from the ROW (never re-resolve the profile) so the
      // resumed session sees the SAME skills it spawned with. null ⇒ all (today's behavior). (Landmine 1.)
      skills: session.skills ?? null,
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
    // A restart is the riskiest moment (a bad merge that just built clean can still wedge boot) — snapshot
    // the DB before we exit, after the green build. Best-effort: takeBackup never throws, so a backup
    // failure can NEVER block the restart.
    const backupCfg = resolveBackupConfig();
    if (backupCfg.enabled) await takeBackup({ reason: "pre-restart", keep: backupCfg.keep });
    // Capture the WHOLE live fleet — the daemon is ONE process for ALL projects, so this restart tears
    // down every project's sessions, not just the requester's. Resuming only the requester (the old
    // behavior) left every OTHER manager/worker/plain session `exited` AND unprotected → the worktree
    // data-loss trigger (P1 17df54c5). We enumerate every LIVE session across all projects, preserving
    // role + manager linkage so boot brings each back the same. A parked (rate-limited) session is still
    // captured — boot brings its pty live (so the rate-limit watcher can recover it) but withholds the
    // continuation nudge, honoring the park (see resumeFleetOnBoot).
    const resume: RestartResumeEntry[] = this.liveFleetResumeSet();
    // Snapshot each resumed session's in-memory pending inbound FIFO so the undelivered queue survives
    // the process death and is replayed on boot (index.ts) — the persisted analogue of recycle's
    // in-process carriedPending. Grab it NOW, while the ptys are still alive (the queue dies with the
    // process on exit). Only non-empty FIFOs are included. Defensive caps keep the intent JSON small:
    // a real FIFO holds a handful of short messages, so clip a pathologically long queue and skip a
    // single absurdly large message rather than bloat the persisted intent.
    const PENDING_MAX_MSGS = 50;
    const PENDING_MAX_MSG_LEN = 100_000;
    const pending: Record<string, string[]> = {};
    for (const { sessionId } of resume) {
      const snap = this.pty
        .getPending(sessionId)
        .filter((m) => m.length <= PENDING_MAX_MSG_LEN)
        .slice(0, PENDING_MAX_MSGS);
      if (snap.length > 0) pending[sessionId] = snap;
    }
    // Crash/shutdown transcript backstop (same as the SIGTERM/SIGINT path): snapshot every LIVE
    // session's engine transcript before we exit. The restart kills every pty; resume re-attaches the
    // SAME engine JSONL so the happy path keeps it, but this is pure insurance for a session that fails
    // to resume. Best-effort + never-throws; runs synchronously BEFORE the intent write so it can never
    // delay or clobber it.
    this.snapshotAllLive();
    writeRestartIntent({
      reason,
      managerSessionId,
      resume,
      requestedAt: new Date().toISOString(),
      ...(Object.keys(pending).length > 0 ? { pending } : {}),
    });
    // Exit AFTER this MCP response flushes; the pty (incl. this manager) dies with the process, the
    // supervisor relaunches the freshly-built daemon, and boot re-resumes us from the intent.
    setTimeout(() => process.exit(RESTART_EXIT_CODE), 300);
    return { restarting: true };
  }

  /**
   * Snapshot every LIVE session across ALL projects into a restart resume set (the capture half of P1
   * 17df54c5). `listAllSessions` is already cross-project and excludes archived rows; we keep only the
   * live ones (a parked/rate-limited session is still `live` — its pty isn't killed on a cap — so it is
   * captured and recovered too). Each entry carries the identity boot needs to re-spawn it unchanged:
   * its role (re-passed so the MCP surface returns) and, for a worker, its manager (parentSessionId).
   * Recycled/exited prior generations are not `live`, so a superseded session is naturally excluded.
   */
  liveFleetResumeSet(): RestartResumeEntry[] {
    return this.db
      .listAllSessions()
      // Exclude ephemeral `run` sessions (Agent Runs R2): runs do NOT resume — a daemon restart fails an
      // in-flight run clean (reconcileRunsOnBoot), so a run must never be captured into the resume set.
      // Belt-and-suspenders for the ghost-resume guard in resume(): also skip a session whose worktree/cwd
      // is already gone at capture time, so a dead-worktree row never even enters the restart intent.
      .filter((s) => s.processState === "live" && s.role !== "run" && fs.existsSync(s.cwd))
      .map((s) => ({ sessionId: s.id, role: s.role ?? null, parentSessionId: s.parentSessionId ?? null }));
  }

  /**
   * Graceful-shutdown transcript backstop (crash / SIGTERM / SIGINT / daemon_restart). The pty `onExit`
   * hook (index.ts) is the PRIMARY snapshot trigger, but a daemon stop kills every LIVE pty WITHOUT
   * firing `onExit` per session — so a long-lived session that never exited on its own would lose its
   * transcript once Claude later prunes the JSONL (a session goes 'dead' BECAUSE its JSONL was deleted).
   * This snapshots EVERY live session that has an `engineSessionId`, while the JSONL still exists, before
   * the process exits — mirroring `onExit`'s snapshot exactly (no run-exclusion: a run with a transcript
   * is preserved too, same as the per-exit path). BOUNDED + best-effort per session: `snapshotTranscript`
   * is idempotent + mtime-guarded + never-throws, and each session is additionally try-guarded so one
   * failure can never block the others or hang shutdown. Returns the count actually snapshotted.
   */
  snapshotAllLive(): number {
    let snapshotted = 0;
    for (const s of this.db.listAllSessions()) {
      if (s.processState !== "live" || !s.engineSessionId) continue;
      try {
        if (snapshotTranscript(s.cwd, s.engineSessionId, s.projectId, s.id)) snapshotted++;
      } catch { /* never let one session block shutdown */ }
    }
    return snapshotted;
  }

  /**
   * Boot-time fleet resume (the resume half of P1 17df54c5) — re-spawn the WHOLE captured fleet after a
   * `daemon_restart`, injecting NOTHING into the resume itself (the resume-injects-nothing invariant;
   * `resume()` passes no startupPrompt and honors the resume hardening — readiness wait, summary-gate
   * dismiss, mode convergence). Continuation NUDGES are post-resume enqueues (a resumed session gets no
   * startup prompt, so without a nudge a worker/manager would sit idle — the stranded-worker hook can't
   * catch a resume's direct setBusy(false)):
   *   - the REQUESTING manager gets its "merged code is now live — continue/verify" re-prompt;
   *   - every other manager/platform gets a neutral "you were resumed, continue orchestrating" note;
   *   - every worker gets the "your worktree WIP is intact, continue your task" nudge;
   *   - a plain (role-null) session is resumed but not nudged (no orchestration loop to re-engage);
   *   - a PARKED (rate-limited) session is resumed live so the rate-limit watcher can recover it, but
   *     its nudge + pending replay are WITHHELD — we never push a held turn back into the cap (honors
   *     the park; a staggered resume via the watcher at reset). Its DB park state is left intact.
   * Best-effort per session: an unresumable one (dead transcript / gone worktree) is skipped + counted.
   * `resumeOne` is injectable for hermetic tests (default drives this.resume); `now` likewise for tests.
   */
  resumeFleetOnBoot(
    intent: RestartIntent,
    opts: { resumeOne?: (id: string) => boolean; now?: Date } = {},
  ): { resumed: string[]; skippedParked: string[]; failed: string[] } {
    const now = opts.now ?? new Date();
    const resumeOne = opts.resumeOne ?? ((id: string): boolean => {
      try { this.resume(id); return true; } catch { return false; }
    });
    const entries = resumeSetFromIntent(intent);
    const reqId = intent.managerSessionId;
    const resumed: string[] = [];
    const skippedParked: string[] = [];
    const failed: string[] = [];

    // Replay a session's pre-restart pending inbound FIFO (snapshotted into the intent) onto the freshly
    // resumed pty, IN ORDER and BEFORE its continuation nudge. These predate the restart, so FIFO order
    // puts them ahead of the boot note. enqueueStdin is ready-gated (host.ts), so they queue until the
    // resumed TUI boots, then drain cleanly.
    const replayPending = (id: string): void => {
      for (const m of intent.pending?.[id] ?? []) this.pty.enqueueStdin(id, m);
    };
    const isParked = (id: string): boolean => {
      const s = this.db.getSession(id);
      return !!s?.rateLimitedUntil && new Date(s.rateLimitedUntil).getTime() > now.getTime();
    };

    const reqWorkers = entries.filter((e) => e.role === "worker" && e.parentSessionId === reqId).map((e) => e.sessionId);

    // Resume everyone EXCEPT the requesting manager first (it gets the last word + its own summary nudge).
    for (const e of entries) {
      if (e.sessionId === reqId) continue;
      const parked = isParked(e.sessionId);
      if (!resumeOne(e.sessionId)) { failed.push(e.sessionId); continue; }
      resumed.push(e.sessionId);
      if (parked) { skippedParked.push(e.sessionId); continue; } // resumed live; honor the park — no nudge/replay
      replayPending(e.sessionId);
      if (e.role === "worker") {
        this.pty.enqueueStdin(
          e.sessionId,
          `[loom:daemon-restarted] The daemon was rebuilt + restarted and you were resumed — your worktree ` +
          `WIP is intact. Continue your assigned task from where you left off. If you had already finished, ` +
          `call worker_report (done/blocked) so your manager isn't left waiting.`,
        );
      } else if (e.role === "manager" || e.role === "platform") {
        this.pty.enqueueStdin(
          e.sessionId,
          `[loom:daemon-restarted] Another manager restarted the daemon (reason: ${intent.reason}) and you + ` +
          `your live workers were resumed — your worktrees are intact. Resume orchestrating from where you ` +
          `left off (re-check your workers' state; some may have just been resumed too).`,
        );
      }
      // role null (plain session): resumed, but no orchestration loop to re-engage → no nudge.
    }

    // The requesting manager last: bring it back with its "your code is live, verify + continue" prompt.
    if (resumeOne(reqId)) {
      resumed.push(reqId);
      if (isParked(reqId)) {
        skippedParked.push(reqId);
      } else {
        replayPending(reqId);
        const reqWorkersResumed = reqWorkers.filter((id) => resumed.includes(id)).length;
        this.pty.enqueueStdin(
          reqId,
          `[loom:daemon-restarted] Rebuild + restart complete — your merged daemon code is now LIVE in the ` +
          `running daemon (reason: ${intent.reason}). ${reqWorkersResumed}/${reqWorkers.length} of your live ` +
          `workers were resumed (the rest of the fleet across all projects was resumed too). You can now ` +
          `end-to-end verify the live behavior. Continue.`,
        );
      }
    } else {
      failed.push(reqId);
    }

    return { resumed, skippedParked, failed };
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
      browserTesting: src.browserTesting ?? false, // a fork inherits the source's browser capability
      skills: src.skills ?? null, // a fork inherits the source's pinned skill subset (null ⇒ all)
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
      browserTesting: src.browserTesting ?? false,
      skills: src.skills ?? null, // carry the pinned subset onto the fork's pty (matches the fork row)
    });
    return { ...session, processState: "live" };
  }

  // ---------------------------------------------------------------------------------------------
  // Agent Runs (R2): the AgentRun primitive — an ephemeral `run` session that reuses the boot recipe
  // VERBATIM but SUBTRACTS the worker machinery (no worktree/branch/merge), runs in a disposable
  // read-only HEAD snapshot, gets ONLY the loom-run `submit_result` surface, and tears down on a
  // terminal state. INTERNAL starter only in R2 (no public REST — that's R3). See [[Agent Runs]].
  // ---------------------------------------------------------------------------------------------

  /**
   * Start an ephemeral AgentRun in `agentId` on `input` (optionally validated against a caller-supplied
   * JSON `schema`). Mints the run row + the `run`-role session, snapshots the project's COMMITTED HEAD
   * into a disposable cwd (NO git worktree/branch), and spawns the SAME gate-free recipe as every other
   * session — the ONLY differences are the composed startup prompt (doctrine + input + schema) and that
   * buildMcpServers mounts ONLY loom-run. `keyId` is null for an R2 internal start (R3's keyed REST sets it).
   * R3 also threads through the caller's `webhook` URL + `idempotencyKey`, persisted on the run row (the
   * webhook fires on teardown; the idempotency key is covered by the db's per-key unique index).
   */
  async startRun(opts: { agentId: string; input: unknown; schema?: unknown | null; keyId?: string | null; webhook?: string | null; idempotencyKey?: string | null }): Promise<{ run: AgentRun; session: Session }> {
    const agent = this.db.getAgent(opts.agentId);
    if (!agent) throw new Error("agent not found");
    // Agent Runs R3 hardening: re-check the LIVE endpoint flag at the choke point — a key authorizes on
    // its allowlist MEMBERSHIP (R1), but un-endpointing an agent (PATCH {endpoint:false}) leaves that
    // stale membership intact, so the allowlist check alone can't stop a run on a now-un-endpointed agent.
    // Gating here (the single path ALL run starts funnel through) keeps the guard on the live flag, not
    // stale auth state. The R3 route ALSO pre-checks this for a clean 4xx; this throw is the invariant.
    if (agent.endpoint !== true) throw new Error("agent is not an endpoint");
    const project = this.db.getProject(agent.projectId);
    if (!project) throw new Error("project not found");
    const config = resolveConfig(project.config);

    const now = new Date().toISOString();
    const sessionId = randomUUID();
    const runId = randomUUID();
    const schema = opts.schema ?? null;

    // Disposable read-only HEAD snapshot as cwd (runs/snapshot.ts — no .git, no branch, no worktree
    // registration). A snapshot failure (e.g. an empty repo with no HEAD) fails the run cleanly BEFORE
    // any session/pty exists — recorded as a failed run for auditability, then surfaced to the caller.
    let snapshotDir: string;
    try {
      snapshotDir = await createRunSnapshot(project.repoPath, sessionId);
    } catch (e) {
      this.db.insertRun({
        id: runId, projectId: project.id, agentId: agent.id, sessionId: null, keyId: opts.keyId ?? null,
        status: "failed", input: opts.input, schema, result: null, usage: null, transcriptRef: null,
        error: `run snapshot failed: ${(e as Error).message}`,
        webhookUrl: opts.webhook ?? null, idempotencyKey: opts.idempotencyKey ?? null,
        createdAt: now, startedAt: null, endedAt: now,
      });
      throw new Error(`could not create run snapshot: ${(e as Error).message}`);
    }

    const run: AgentRun = {
      id: runId, projectId: project.id, agentId: agent.id, sessionId,
      keyId: opts.keyId ?? null, status: "starting",
      input: opts.input, schema, result: null, usage: null, transcriptRef: null, error: null,
      webhookUrl: opts.webhook ?? null, idempotencyKey: opts.idempotencyKey ?? null,
      createdAt: now, startedAt: now, endedAt: null,
    };
    this.db.insertRun(run);

    const session: Session = {
      id: sessionId, projectId: project.id, agentId: agent.id,
      engineSessionId: null, title: null,
      cwd: snapshotDir, // the disposable snapshot — NEVER the live repoPath
      processState: "starting", resumability: "unknown", busy: false,
      createdAt: now, lastActivity: now, lastError: null,
      role: "run", browserTesting: false,
    };
    this.db.insertSession(session);
    // M5: flip to live BEFORE wiring the pty so a fast-failing spawn's onExit ('exited') always wins.
    this.db.setProcessState(session.id, "live");

    const startupPrompt = composeRunStartupPrompt(agent.startupPrompt, opts.input, schema);
    this.pty.spawn({
      sessionId: session.id,
      cwd: snapshotDir,
      permission: config.permission, // VERBATIM boot recipe (acceptEdits) — only prompt + MCP surface differ
      geometry: config.pty,
      sessionEnv: config.sessionEnv,
      vaultPath: config.docLint ? project.vaultPath : undefined, // Pillar D: scope the vault-lint hook
      startupPrompt,
      role: "run", // buildMcpServers mounts ONLY loom-run; createPty allowlists mcp__loom-run
      browserTesting: false,
    });
    this.db.setRunStatus(runId, "running"); // the startup-prompt turn is in flight
    // Arm the hard run-timeout (capstone BUG 2): if the agent finishes WITHOUT submit_result, nothing
    // else makes the run terminal — this backstop force-marks it `timed_out` + tears down. Cleared on any
    // terminal transition. `unref` so a pending timer never keeps the daemon process alive on its own.
    const timer = setTimeout(() => this.onRunTimeout(runId), this.runTimeoutMs);
    timer.unref?.();
    this.runTimers.set(runId, timer);
    return { run: { ...run, status: "running" }, session: { ...session, processState: "live" } };
  }

  /** Clear (and drop) a run's pending hard-timeout handle, if any. Idempotent — safe on an unarmed run. */
  private clearRunTimer(runId: string): void {
    const timer = this.runTimers.get(runId);
    if (timer) { clearTimeout(timer); this.runTimers.delete(runId); }
  }

  /**
   * Hard run-timeout fired (capstone BUG 2): the run sat non-terminal for runTimeoutMs. If a terminal
   * transition already won the race (submit/cancel/exit), do nothing; otherwise force it `timed_out`
   * (terminal BEFORE teardown, mirroring cancelRun) and graceful-stop its session → onRunSessionExit
   * finalizes + fires the webhook with status=timed_out.
   */
  private onRunTimeout(runId: string): void {
    this.runTimers.delete(runId); // the handle has fired; drop it
    const run = this.db.getRun(runId);
    if (!run) return;
    const terminal = run.status === "completed" || run.status === "failed" || run.status === "timed_out" || run.status === "cancelled";
    if (terminal) return; // a terminal transition beat the timer — nothing to do
    this.db.failRun(run.id, `run exceeded the hard timeout (${this.runTimeoutMs}ms) without calling submit_result`, "timed_out");
    if (run.sessionId) this.pty.stop(run.sessionId, "graceful"); // R2 teardown path → onRunSessionExit fires the webhook
  }

  /**
   * The `submit_result` contract (the run MCP's only tool, server-side). Resolve the run by its session
   * id, VALIDATE the payload against the run's caller-supplied JSON Schema, and:
   *   - mismatch → return a STRUCTURED error to the agent (NO teardown) so it self-corrects + retries;
   *   - valid (or no schema → freeform accept) → record the result + mark the run `completed` (terminal)
   *     FIRST, then graceful-stop the pty (teardown). onRunSessionExit then GCs the snapshot dir + retains
   *     usage/transcript once the pty is gone (mark-terminal-first, then best-effort GC).
   * A malformed caller schema degrades to freeform-accept (never crashes; see validateRunPayload).
   */
  submitRunResult(runSessionId: string, payload: unknown): { ok: true } | { ok: false; error: string; errors?: string[] } {
    const run = this.db.getRunBySession(runSessionId);
    if (!run) return { ok: false, error: "no run for this session" };
    if (run.status === "completed" || run.status === "failed" || run.status === "timed_out" || run.status === "cancelled") {
      return { ok: false, error: `run already ${run.status}` };
    }
    const v = this.validateRunPayload(run.schema, payload);
    if (!v.ok) {
      // Capstone BUG 1: when a STRING payload still fails, hint that result should be a JSON value/object,
      // not a stringified JSON string (the common LLM failure that looped a real agent 7×).
      const hint = v.stringHint
        ? " — NOTE: you passed `result` as a STRING; pass it as a JSON object/value matching the schema, NOT a stringified JSON string"
        : "";
      return { ok: false, error: `result did not match the required JSON Schema; correct it and call submit_result again${hint}`, errors: v.errors };
    }
    this.clearRunTimer(run.id); // terminal transition — disarm the hard run-timeout
    this.db.recordRunResult(run.id, v.value); // record the NORMALIZED value (parsed if it was stringified-JSON) — terminal (completed) BEFORE teardown
    // Deferred deterministic graceful-stop: let the {ok:true} tool response flush to the agent first (the
    // Ctrl-C goes to claude's stdin, independent of this HTTP response, but deferring guarantees the agent
    // sees the acceptance before its turn unwinds). onRunSessionExit then GCs the snapshot on the pty exit.
    setTimeout(() => this.pty.stop(runSessionId, "graceful"), RUN_TEARDOWN_DELAY_MS);
    return { ok: true };
  }

  /**
   * Validate a `submit_result` payload against the run's caller-supplied JSON Schema (ajv) and return the
   * NORMALIZED value to record. No schema ⇒ freeform accept. A schema that fails to COMPILE
   * (malformed/garbage caller input) must NEVER crash the daemon AND must not trap the agent in an
   * unsatisfiable retry loop, so it degrades to freeform-accept (logged). `strict:false` tolerates
   * non-strict-mode schemas. Returns precise, agent-readable errors on a real mismatch.
   *
   * Capstone BUG 1 — TOLERATE a stringified-JSON result. The validate-raw-FIRST ordering is the safety
   * guarantee: a result that already matches (incl. a legitimately-string result against {type:"string"})
   * is accepted + recorded VERBATIM. ONLY when the raw payload fails AND it is a string do we attempt
   * `JSON.parse` and re-validate the PARSED value — so the very common LLM habit of stringifying the JSON
   * answer is accepted and the run records the parsed OBJECT, while a real string result is never
   * double-parsed. `stringHint` flags a still-failing string payload so the caller can nudge the agent.
   */
  private validateRunPayload(schema: unknown, payload: unknown):
    | { ok: true; value: unknown }
    | { ok: false; errors: string[]; stringHint: boolean } {
    if (schema == null) return { ok: true, value: payload }; // freeform run — accept any JSON/text
    let validate: ReturnType<Ajv["compile"]>;
    try {
      validate = new Ajv({ allErrors: true, strict: false }).compile(schema as object);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[run] caller schema failed to compile — accepting freeform: ${(e as Error).message}`);
      return { ok: true, value: payload };
    }
    const errorsOf = (v: ReturnType<Ajv["compile"]>): string[] => {
      const errors = (v.errors ?? []).map((er) => `${er.instancePath || "(root)"} ${er.message ?? "invalid"}`.trim());
      return errors.length ? errors : ["payload did not match the schema"];
    };
    // Validate the RAW payload first — a result that already matches (incl. a real string result) is
    // recorded verbatim, NEVER double-parsed.
    if (validate(payload)) return { ok: true, value: payload };
    const rawErrors = errorsOf(validate);
    // Raw failed AND it's a string → try parsing it and validating the parsed value (the stringified-JSON
    // tolerance). On success, accept + record the PARSED value (not the string).
    if (typeof payload === "string") {
      let parsed: unknown;
      try { parsed = JSON.parse(payload); } catch { return { ok: false, errors: rawErrors, stringHint: true }; }
      if (validate(parsed)) return { ok: true, value: parsed };
      return { ok: false, errors: errorsOf(validate), stringHint: true };
    }
    return { ok: false, errors: rawErrors, stringHint: false };
  }

  /**
   * Finalize a `run` session as its pty exits (called from index.ts onExit, AFTER snapshotTranscript).
   * If the session died WITHOUT a completed submit_result (agent crashed / never submitted / hard-stop),
   * the run is terminally FAILED — never left dangling. Then retain the usage snapshot (engine ctx
   * counters captured at the last turn boundary) + the transcript pointer, and best-effort GC the
   * disposable snapshot cwd (handles are released now the pty is gone). Synchronous DB writes first
   * (mark-terminal-first), then a fire-and-forget dir removal that never throws.
   */
  onRunSessionExit(sessionId: string): void {
    const run = this.db.getRunBySession(sessionId);
    if (!run) return;
    this.clearRunTimer(run.id); // catch-all: a session exit is terminal for its run — disarm any pending timer
    const session = this.db.getSession(sessionId);
    if (run.status !== "completed" && run.status !== "cancelled" && run.status !== "timed_out") {
      this.db.failRun(run.id, "run session exited before submit_result");
    }
    const transcriptRef = archivedTranscriptExists(run.projectId, sessionId) ? archivedTranscriptPath(run.projectId, sessionId) : null;
    // Agent Runs #2 — capture CUMULATIVE per-run usage (summed across all turns), then price it. Read from
    // the archived snapshot if it exists (stable; captured just above on this exit), else the still-live
    // engine transcript. `usage.inputTokens` now means cumulative billed input (NOT last-turn occupancy);
    // see readRunUsage + db.sumKeyTokensSince. Degrade gracefully to the old last-turn snapshot if the
    // transcript is unreadable (so the token cap still sees something). costUsd is best-effort: an unknown
    // model → 0 (computeRunCostUsd never throws), so a missing price can't disturb this teardown path.
    const cumulative =
      (transcriptRef ? readRunUsageFromFile(transcriptRef) : null) ??
      (session?.engineSessionId ? readRunUsage(session.cwd, session.engineSessionId) : null);
    const usage = cumulative
      ? {
          inputTokens: cumulative.inputTokens,
          outputTokens: cumulative.outputTokens,
          cacheCreationTokens: cumulative.cacheCreationTokens,
          cacheReadTokens: cumulative.cacheReadTokens,
          turns: cumulative.turns,
          model: cumulative.model,
          costUsd: computeRunCostUsd(cumulative),
        }
      : session && (session.ctxInputTokens != null || session.ctxTurns != null)
        ? { inputTokens: session.ctxInputTokens ?? null, turns: session.ctxTurns ?? null, model: session.model ?? null }
        : null;
    this.db.setRunTeardown(run.id, { usage, transcriptRef });
    void removeRunSnapshot(sessionId); // best-effort; run row already terminal; lingering dir swept on next boot
    // Agent Runs R3: this IS the single LIVE terminal/teardown path (completed via submit_result, cancelled
    // via cancelRun, or failed because the session died first) — fire the run webhook HERE, from the now-final
    // row. Best-effort + bounded (a hung endpoint can't wedge teardown); a run with no webhookUrl is a no-op.
    const finalRun = this.db.getRun(run.id);
    if (finalRun) this.fireRunWebhook(finalRun);
  }

  /**
   * Agent Runs R3: cancel a run. Non-terminal → mark `cancelled` FIRST (mark-terminal-first, mirroring
   * submitRunResult) then graceful-stop its `run` session via the R2 teardown path (the pty exit drives
   * onRunSessionExit, which finalizes + fires the webhook with status=cancelled). Already-terminal → a
   * no-op that returns the run's current state (idempotent). The keyed REST route owns the own-run-scope
   * + existence checks; this trusts a resolved runId.
   */
  cancelRun(runId: string): { status: AgentRun["status"] } {
    const run = this.db.getRun(runId);
    if (!run) throw new Error("run not found");
    const terminal = run.status === "completed" || run.status === "failed" || run.status === "timed_out" || run.status === "cancelled";
    if (terminal) return { status: run.status }; // idempotent no-op on an already-terminal run
    this.db.failRun(run.id, "cancelled by caller", "cancelled"); // terminal BEFORE teardown
    this.clearRunTimer(run.id); // disarm the hard run-timeout
    if (run.sessionId) this.pty.stop(run.sessionId, "graceful"); // R2 teardown path → onRunSessionExit fires the webhook
    return { status: "cancelled" };
  }

  /**
   * Fire the run-completion webhook for a TERMINAL run (Agent Runs R3). Fully error-guarded + bounded —
   * a missing url is a no-op; otherwise it kicks off a fire-and-forget bounded delivery (≤RUN_WEBHOOK_ATTEMPTS
   * tries) whose promise is `.catch`-guarded so a fault NEVER throws into the teardown caller. Mirrors the
   * alert-webhook + bounded-git posture. The returned promise is exposed (already guarded) only so a test
   * can deterministically await delivery.
   * // future: restrict to http(s)/non-internal hosts if Agent Runs ever leaves first-party + loopback.
   */
  fireRunWebhook(run: AgentRun): Promise<void> {
    const url = run.webhookUrl;
    if (!url) return Promise.resolve();
    const payload = { runId: run.id, status: run.status, result: run.result ?? null, error: run.error ?? null };
    return this.deliverRunWebhook(url, payload).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn(`[run-webhook] delivery failed for ${run.id}: ${(err as Error).message}`);
    });
  }

  /** Bounded, best-effort delivery with ≤RUN_WEBHOOK_ATTEMPTS attempts; rethrows only if EVERY attempt failed. */
  private async deliverRunWebhook(url: string, payload: unknown): Promise<void> {
    let lastErr: unknown;
    for (let i = 0; i < RUN_WEBHOOK_ATTEMPTS; i++) {
      try { await this.runWebhookPost(url, payload, this.runWebhookTimeoutMs); return; }
      catch (e) { lastErr = e; }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  /**
   * Boot reconcile for runs (the restart-mid-run → fail-clean invariant). A run is EPHEMERAL and does
   * NOT resume, so any run still in a non-terminal state at boot was interrupted by a crash/restart →
   * mark it `failed`. recoverStaleSessions already flipped its `run` session to `exited`; this fails the
   * run ROW and sweeps every orphaned run-snapshot dir (runs never resume ⇒ any dir at boot is orphaned).
   * Returns how many runs were failed.
   *
   * R3 DECISION (reported up): webhooks fire ONLY on the LIVE teardown path (onRunSessionExit), NOT here.
   * A restart-interrupted run is failed silently and the app learns of it via GET polling + idempotency
   * (the design's "the app retries via the idempotency key"). This keeps a fragile best-effort-only boot
   * free of outbound network. // future: fireRunWebhook(this.db.getRun(r.id)) per failed run would add it
   * (already fully error-guarded) if a webhook-on-restart need appears.
   */
  reconcileRunsOnBoot(): { failed: number } {
    const interrupted = this.db.listInterruptedRuns();
    for (const r of interrupted) {
      this.db.failRun(r.id, "daemon restarted mid-run (runs are ephemeral and do not resume)");
    }
    sweepAllRunSnapshots();
    return { failed: interrupted.length };
  }

  // ---------------------------------------------------------------------------------------------
  // Per-project session Archive (HUMAN-only REST surface, like stop/fork — NEVER an MCP tool). A UI
  // tidy action that moves a dead/exited session (and, for a manager, its workers) out of the
  // Workspace rail + the god-eye views. Snapshot-on-exit (index.ts onExit) already preserved the
  // transcript; these methods only flip the archived_at state + permanent delete.
  // ---------------------------------------------------------------------------------------------

  /**
   * Archive a session out of the rail. EXITED-only (a live session must be stopped first — the UI
   * hides the button while live, and this re-checks server-side). A manager CASCADES to its workers;
   * if ANY group member is still LIVE the whole archive is BLOCKED ("stop the fleet first").
   * Snapshot-on-exit (index.ts onExit) is the primary preservation path, but onExit can be missed
   * (hard-kill / daemon crash) — so re-snapshot each group member here as a backstop BEFORE flipping
   * state, while the JSONL may still exist. snapshotTranscript is idempotent + best-effort + atomic
   * and a no-op when a current snapshot exists or the JSONL is already gone, so this can't regress the
   * happy path; it's pure insurance against a lost transcript. Idempotent: an already-archived session
   * returns { archived: [] }.
   */
  archiveSession(sessionId: string): { archived: string[] } {
    const s = this.db.getSession(sessionId);
    if (!s) throw new Error("session not found");
    if (s.archivedAt) return { archived: [] }; // already archived — idempotent no-op
    // A manager carries its (non-archived) workers; any other session archives alone.
    const group = [s, ...(s.role === "manager" ? this.db.listWorkers(s.id) : [])];
    const live = group.filter((g) => g.processState === "live");
    if (live.length > 0) {
      throw new Error(`cannot archive a live session — stop the fleet first (${live.length} still live)`);
    }
    // Backstop the on-exit snapshot: if onExit never fired, this is the last chance to preserve the
    // transcript before Claude prunes the JSONL. Best-effort + idempotent — never blocks the archive.
    for (const g of group) {
      if (g.engineSessionId) snapshotTranscript(g.cwd, g.engineSessionId, g.projectId, g.id);
    }
    for (const g of group) this.db.archiveSession(g.id);
    return { archived: group.map((g) => g.id) };
  }

  /** Restore an archived session back to the rail (single row — not a cascade). */
  restoreSession(sessionId: string): { restored: string } {
    const s = this.db.getSession(sessionId);
    if (!s) throw new Error("session not found");
    this.db.restoreSession(sessionId);
    return { restored: sessionId };
  }

  /**
   * Permanently delete an archived session: drop its row + transcript snapshot. A manager CASCADES
   * to its archived workers (by the time a manager is archived, archiving already cascaded its
   * workers, so they're archived too). Refuses a non-archived session (archive it first).
   */
  deleteArchivedSession(sessionId: string): { deleted: string[] } {
    const s = this.db.getSession(sessionId);
    if (!s) throw new Error("session not found");
    if (!s.archivedAt) throw new Error("only an archived session can be permanently deleted");
    const ids = [s.id, ...(s.role === "manager" ? this.db.listArchivedWorkers(s.id).map((w) => w.id) : [])];
    for (const id of ids) {
      deleteArchivedTranscript(s.projectId, id); // best-effort snapshot removal
      this.db.deleteSession(id);
    }
    return { deleted: ids };
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

    // The worker runs in the agent the manager NOMINATED — never a silent fallback to the manager's own
    // agent. That fallback (`opts.agentId ?? manager.agentId`) was a footgun: an omitted agentId bound the
    // worker to the manager-role agent, mis-grouping it AND inheriting that agent's browserTesting. The
    // agentId must be an explicit WORKER agent; defend at runtime so the service is robust regardless of
    // caller (the MCP schema also marks it required).
    if (!opts.agentId) throw new Error("worker_spawn requires an explicit worker agentId (a Dev/Bugfix/QA/Docs agent) — never the manager's own agent");
    const workerAgent = this.db.getAgent(opts.agentId);
    if (!workerAgent) throw new Error(`worker_spawn agentId '${opts.agentId}' does not resolve to an existing agent`);
    // Reject a manager/platform-role rig: a worker must run under a worker (or plain) agent, never a
    // coordination agent. The role is the agent's resolved PROFILE role (resolveProfile — the canonical
    // mechanism); a profile-less agent (Dev/Bugfix/Docs/QA today) resolves to null and is allowed.
    const profileRole = resolveProfile(workerAgent, workerAgent.profileId ? this.db.getProfile(workerAgent.profileId) : undefined).role;
    if (profileRole === "manager" || profileRole === "platform" || profileRole === "auditor" || profileRole === "run") {
      throw new Error(`cannot spawn a worker under the '${workerAgent.name}' agent (a ${profileRole}-role profile); pick a worker agent (Dev/Bugfix/QA/Docs)`);
    }
    // Resolve THAT agent's profile for its browser-automation opt-in + skill subset — a manager spawns a
    // QA worker by pointing it at a browserTesting profile (e.g. the bundled "QA Tester"). Explicit role is
    // "worker"; we read browserTesting + skills (permission stays config.permission, byte-identical to
    // today). A worker runs in its OWN worktree (separate cwd), so its subset is delivered EXACTLY.
    const workerSpawn = this.resolveAgentSpawn(workerAgent, config, "worker");
    const browserTesting = workerSpawn.browserTesting;
    const skills = workerSpawn.skills;

    // Safety rails (§17a) — refuse NEW work before any side effect (worktree/pty). In-flight
    // workers are untouched. Pause is global-or-this-manager; the cap counts LIVE children only.
    if (this.control.isPaused(managerSessionId)) throw new Error("orchestration paused");
    // §19c: don't spawn a worker into a known usage-limited account (whole-queue awareness). The recency
    // window is the daemon-global `platform.rateLimit.recencyWindowMs`, resolved LIVE here (db in scope).
    const recencyWindowMs = resolveConfig(undefined, this.db.getPlatformConfig()).platform.rateLimit.recencyWindowMs;
    if (isLikelyNearClaudeUsageLimit(new Date(), recencyWindowMs)) throw new Error("usage limit active");
    const liveWorkers = this.db.listWorkers(managerSessionId).filter((w) => w.processState === "live").length;
    const cap = config.orchestration.maxConcurrentWorkers;
    if (liveWorkers >= cap) throw new Error(`concurrency cap reached (${cap})`);

    const { worktreePath, branch } = await createWorktree(project.repoPath, project.id, opts.taskId, { timeoutMs: this.provisionMs });

    const now = new Date().toISOString();
    const worker: Session = {
      id: randomUUID(),
      projectId: manager.projectId,
      agentId: opts.agentId,
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
      browserTesting, // QA worker (profile opt-in) ⇒ per-session Playwright MCP; else false (plain)
      skills, // profile-pinned skill subset for the worker (null ⇒ all); pinned so resume/recycle honor it
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
      browserTesting, // inject the per-session Playwright MCP iff this worker's profile opted in
      skills, // deliver only the worker profile's skill subset (null ⇒ all)
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
   * Platform-Lead cross-project message delivery (loom-platform `session_message`, P4). UN-scoped: where
   * messageWorker is parent/child-gated, the Lead stands ABOVE the whole manager/worker tree and may
   * message ANY session in ANY project — no parentSessionId check. Reuses the SAME stdin-enqueue channel
   * (submitted as a turn when idle, queued FIFO and drained on the next turn boundary when busy). Framed
   * `[loom:from-platform]` so the receiver knows the source is the platform operator, not its own manager.
   * DELIVERY ONLY — it never spawns anything. Throws (→ the router's error envelope) if the target session
   * is unknown or not live.
   */
  messageSessionAsPlatform(sessionId: string, text: string): { delivered: boolean; position?: number } {
    const session = this.db.getSession(sessionId);
    if (!session) throw new Error("session not found");
    if (session.processState !== "live") throw new Error("session is not live");
    const framed = `[loom:from-platform]\n${text}`;
    const r = this.pty.enqueueStdin(sessionId, framed);
    this.db.appendEvent({
      id: randomUUID(), ts: new Date().toISOString(),
      managerSessionId: "", workerSessionId: sessionId, taskId: session.taskId ?? null, kind: "session_message",
    });
    return r;
  }

  /**
   * Manager→Platform UPWARD escalation (orchestration `platform_escalate`, P4) — the ONE channel a project
   * manager has to report a discovered Loom bug / friction UP to the platform. DURABLE by design: it files
   * a structured TASK onto the reserved "Loom Platform" project's board (the Lead's inbox), so the report
   * survives the common case where no Lead session is live. The target project is HARDCODED to the reserved
   * home (resolved via the `reserved` flag) — a manager may NOT name an arbitrary projectId; this structured
   * escalation is the only cross-project write a manager gets. The body captures origin (project + manager
   * session id), severity, and the detail/evidence so a fix can be scoped. Returns the created task id.
   * Refuses (throws) if — impossibly — no reserved project exists. Manager-only (defense in depth; the tool
   * is also manager-gated at the router).
   */
  platformEscalate(
    managerSessionId: string,
    input: { title: string; detail: string; severity?: string },
  ): { taskId: string; projectId: string; delivered: boolean } {
    const caller = this.db.getSession(managerSessionId);
    if (!caller || caller.role !== "manager") throw new Error("platform_escalate is a manager-only surface");
    // HARDCODED target: the reserved Platform home — never an arbitrary projectId from the manager.
    // NAME-SCOPED: resolve by PLATFORM_PROJECT_NAME, not a bare `.find(reserved)` — a second reserved home
    // (the ungated "Getting Started" setup home) now coexists, so "the one reserved project" is ambiguous
    // and would mis-file the escalation into the wrong home.
    const home = this.db.getReservedProjectByName(PLATFORM_PROJECT_NAME);
    if (!home) throw new Error("no reserved Loom Platform project exists — cannot escalate");

    const origin = this.db.getProject(caller.projectId);
    const originName = origin?.name ?? caller.projectId;
    const severity = (input.severity ?? "").trim() || "unspecified";
    const now = new Date().toISOString();
    const body = [
      "**Escalated by a project manager** (manager→Platform upward channel).",
      "",
      `- **Origin project:** ${originName} (\`${caller.projectId}\`)`,
      `- **Manager session:** \`${managerSessionId}\``,
      `- **Severity:** ${severity}`,
      "",
      "## Detail / evidence",
      "",
      input.detail,
    ].join("\n");
    const task: Task = {
      id: randomUUID(),
      projectId: home.id,
      title: input.title,
      body,
      columnKey: "backlog", // the Platform backlog (matches createProjectTask's default landing column)
      position: Date.now(),
      priority: DEFAULT_TASK_PRIORITY,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insertTask(task);
    this.db.appendEvent({
      id: randomUUID(), ts: now,
      managerSessionId, taskId: task.id, kind: "platform_escalate",
      detail: { originProjectId: caller.projectId, severity, platformProjectId: home.id, title: input.title },
    });

    // Additive best-effort live nudge: if a Lead session happens to be live, push a heads-up via the same
    // enqueue channel — but the board TASK is the durable source of truth (the Lead reads escalations as
    // tasks on its home board). This never builds a fragile live-only inbox; it just saves the Lead a poll.
    let delivered = false;
    const liveLead = this.db.listAllSessions().find((s) => s.role === "platform" && s.processState === "live");
    if (liveLead) {
      const note = `[loom:escalation] ${originName} manager escalated a Loom issue → Platform board task ${task.id}: ${input.title} (severity: ${severity})`;
      try { delivered = this.pty.enqueueStdin(liveLead.id, note).delivered; } catch { /* Lead not live/ready — the board task stands */ }
    }
    return { taskId: task.id, projectId: home.id, delivered };
  }

  /**
   * Platform Auditor finding (loom-audit `audit_file_finding`, P5) — the ONLY write the read-and-file-only
   * Auditor can make. MIRRORS platformEscalate: files a DURABLE, structured TASK onto the reserved "Loom
   * Platform" board (the triage inbox). The target project is HARDCODED to the reserved home (resolved via
   * the `reserved` flag) — the Auditor may NOT name an arbitrary projectId, so this can never become a
   * general cross-project task-write. Caller-role check (defense in depth — the tool is also auditor-gated at
   * the router): refuses anything but an "auditor" session, so even if this method were reachable from
   * elsewhere it can't be used to write findings under another role. NO git/vault/config/spawn — that
   * capability simply doesn't exist on this path. Returns the created task id. Refuses (throws) if — impossibly
   * — no reserved project exists.
   */
  auditFileFinding(
    auditorSessionId: string,
    input: { title: string; detail: string; severity?: string },
  ): { taskId: string; projectId: string } {
    const caller = this.db.getSession(auditorSessionId);
    if (!caller || caller.role !== "auditor") throw new Error("audit_file_finding is an auditor-only surface");
    // HARDCODED target: the reserved Platform home — never an arbitrary projectId from the Auditor.
    // NAME-SCOPED: resolve by PLATFORM_PROJECT_NAME, not a bare `.find(reserved)` — the ungated setup home
    // ("Getting Started") is also reserved now, so the name-agnostic lookup would mis-file the finding.
    const home = this.db.getReservedProjectByName(PLATFORM_PROJECT_NAME);
    if (!home) throw new Error("no reserved Loom Platform project exists — cannot file finding");

    const severity = (input.severity ?? "").trim() || "unspecified";
    const now = new Date().toISOString();
    const body = [
      "**Filed by the Platform Auditor** (scheduled, read-and-file-only transcript review).",
      "",
      `- **Severity:** ${severity}`,
      "",
      "## Finding / evidence",
      "",
      input.detail,
    ].join("\n");
    const task: Task = {
      id: randomUUID(),
      projectId: home.id,
      title: input.title,
      body,
      columnKey: "backlog", // the Platform backlog (matches platformEscalate's landing column)
      position: Date.now(),
      priority: DEFAULT_TASK_PRIORITY,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insertTask(task);
    this.db.appendEvent({
      id: randomUUID(), ts: now,
      managerSessionId: auditorSessionId, taskId: task.id, kind: "audit_finding",
      detail: { severity, platformProjectId: home.id, title: input.title },
    });
    return { taskId: task.id, projectId: home.id };
  }

  /**
   * A worker reports to its manager (phase-2 §A3, the worker→manager direction). Moves the
   * worker's task by status, records the event, and notifies the manager via the busy-gated
   * queue — exactly the predecessor's role:notification semantics: if the manager is mid-turn the report
   * queues behind its running turn and drains on its next Stop. The caller IS the worker
   * (workerSessionId is derived server-side from the URL path), so there's no id to spoof.
   */
  async workerReport(
    workerSessionId: string,
    report: { status: "done" | "blocked" | "progress"; summary: string; prUrl?: string; needs?: string },
  ): Promise<{ reported: boolean; delivered: boolean; refused?: boolean; error?: string; uncommittedFiles?: string[]; warning?: string }> {
    const worker = this.db.getSession(workerSessionId);
    if (!worker) throw new Error("unknown worker session");
    const managerSessionId = worker.parentSessionId ?? null;
    const taskId = worker.taskId ?? null;

    // DONE PRE-CHECK (board card 907b9f50): catch a worker that forgot to commit AT THE SOURCE, before
    // its task is moved to review. The merge gate only ever sees COMMITTED work on the assigned branch,
    // so a "done" with uncommitted work otherwise bounces back a wasted round-trip later. INDEPENDENT of
    // — and composes with — the divergent-branch stranded backstop at the merge gate (reviewWorkerMerge /
    // confirmWorkerMerge). FAILS SAFE: precheckWorkerDone degrades to ALLOW on any git error, so a flaky
    // check can never wedge a legitimate done. Only the AFFIRMATIVE uncommitted signal refuses.
    let warning: string | undefined;
    if (report.status === "done") {
      const project = this.db.getProject(worker.projectId);
      const worktreePath = worker.worktreePath ?? worker.cwd;
      if (project && worktreePath && worker.branch && fs.existsSync(worktreePath)) {
        const precheck = await precheckWorkerDone(project.repoPath, worktreePath, worker.branch, "HEAD", { timeoutMs: this.gitOpMs });
        if (precheck.uncommitted) {
          // REFUSE: do NOT move the task — the worker stays in_progress to commit + re-report. Name the
          // uncommitted files so the worker knows exactly what to commit.
          const error =
            `worker_report(done) REFUSED — your worktree has UNCOMMITTED changes (${precheck.files.length} path(s): ${precheck.files.join(", ")}). ` +
            `The merge gate only sees COMMITTED work on your assigned branch '${worker.branch}', so reporting done now would lose this work. ` +
            `Commit to your assigned branch first (do NOT 'git checkout -b' — commit straight to '${worker.branch}'), then re-report done. Your task stays in_progress.`;
          this.db.appendEvent({
            id: randomUUID(), ts: new Date().toISOString(),
            managerSessionId: managerSessionId ?? "", workerSessionId, taskId, kind: "worker_report_rejected",
            detail: { reason: "uncommitted", files: precheck.files },
          });
          return { reported: false, refused: true, error, uncommittedFiles: precheck.files, delivered: false };
        }
        if (precheck.zeroAhead) {
          // WARN only: a clean worktree on an assigned branch with 0 commits ahead of base. A genuine
          // no-op task can legitimately report done, so this never refuses — it surfaces the warning in
          // the result, the worker_report event, and the manager notification.
          warning =
            `your assigned branch '${worker.branch}' is 0 commits ahead of base — nothing to merge. ` +
            `Allowing the done (a real no-op task can legitimately report done), but if you intended to produce changes you likely forgot to commit them.`;
        }
      }
    }

    // Task move by status: done → review (ready for the manager's diff review), blocked →
    // waiting, progress → no move.
    if (taskId) {
      const col = report.status === "done" ? "review" : report.status === "blocked" ? "waiting" : null;
      if (col) this.db.updateTask(taskId, { columnKey: col });
    }

    this.db.appendEvent({
      id: randomUUID(), ts: new Date().toISOString(),
      managerSessionId: managerSessionId ?? "", workerSessionId, taskId, kind: "worker_report",
      detail: { status: report.status, summary: report.summary, prUrl: report.prUrl, needs: report.needs, ...(warning ? { warning } : {}) },
    });

    let delivered = false;
    if (managerSessionId) {
      let framed = `[loom:worker-report] worker ${workerSessionId} (task ${taskId ?? "none"}) — ${report.status}: ${report.summary}`;
      if (report.prUrl) framed += ` | PR: ${report.prUrl}`;
      if (report.needs) framed += ` | needs: ${report.needs}`;
      if (warning) framed += ` | warning: ${warning}`;
      delivered = this.pty.enqueueStdin(managerSessionId, framed).delivered;
      // STRAND BACKSTOP (incident 22a44352): if the report reached NOBODY because the parent manager has
      // EXITED (it idle-reaped after dispatching its last worker), the completed branch would sit unmerged
      // with no live or boot-time consumer. Record the durable `worker_report_undelivered` wake trigger so
      // the crash-recovery watchdog bounded-auto-resumes the manager to run review→gate→merge. A LIVE-but-
      // busy manager (delivered:false but the message is queued in its FIFO) is NOT orphaned — its queue
      // drains on the next turn — so gate strictly on the manager row being `exited`. Best-effort + never
      // throws: the report itself is already durably recorded above regardless.
      if (!delivered) {
        const mgr = this.db.getSession(managerSessionId);
        if (mgr && mgr.processState === "exited") {
          try { recordUndeliveredReport(this.db, mgr, { reportingWorkerId: workerSessionId, taskId }); }
          catch { /* never let the wake-trigger record disturb the report path */ }
        }
      }
    }
    return warning ? { reported: true, delivered, warning } : { reported: true, delivered };
  }

  /**
   * A manager PULLS its own inbound inbox: returns AND removes every queued (busy-gated, not-yet-
   * delivered) inbound message for the manager's OWN session. The manager's id is derived server-side
   * from the URL path (no id to spoof), so this only ever drains the caller's own queue. Manager-only —
   * mirrors recordIdleReport's role gate.
   *
   * WHY: a worker report enqueued while the manager is mid-turn sits in `live.pending` (delivered:false)
   * and otherwise drains ONE-per-turn-boundary via drainPending. A manager that has already handled the
   * work proactively (it read each worker's transcript directly) would then get those stale queued copies
   * re-surfaced as wasted turns. inbox_pull lets it consume the whole inbox at once and discard/act as it
   * sees fit. The underlying worker_report (and other) events stay recorded in the DB — this only clears
   * the in-memory delivery queue, never the audit log. The auto-drain remains the safety net for a manager
   * that doesn't pull; a pulled message is removed from the same FIFO, so it can't also drain later.
   */
  pullManagerInbox(managerSessionId: string): { messages: string[] } {
    const session = this.db.getSession(managerSessionId);
    if (!session) throw new Error("unknown session");
    if (session.role !== "manager") throw new Error("inbox_pull is a manager-only surface");
    return { messages: this.pty.consumePending(managerSessionId) };
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
      browserTesting: old.browserTesting ?? false, // a recycled QA worker keeps its browser capability
      skills: old.skills ?? null, // a recycled worker keeps its pinned skill subset (null ⇒ all)
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
      browserTesting: old.browserTesting ?? false,
      skills: old.skills ?? null, // carry the pinned skill subset forward across recycle (null ⇒ all)
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
      browserTesting: old.browserTesting ?? false, // carry the capability forward (managers rarely set it)
      skills: old.skills ?? null, // carry the pinned skill subset forward (null ⇒ all)
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
      browserTesting: old.browserTesting ?? false,
      skills: old.skills ?? null, // carry the pinned skill subset forward across recycle (null ⇒ all)
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

  // ---------------------------------------------------------------------------------------------
  // Manager self-service management surface (Task 3de74275, Option B). Each method below backs ONE
  // role-gated loom-orchestration MCP tool (registered ONLY on the manager branch — see
  // mcp/orchestration.ts) and ALSO re-checks the caller's role server-side here (defense in depth,
  // mirroring recordIdleReport's gate). The boundary is Option B: a manager may ASSIGN an existing,
  // human-authored profile and create/edit STRUCTURE (agents, projects, schedules), but may NEVER
  // CREATE/EDIT a profile, skill, allowlist, or gateCommand — the capability-minting monopoly stays
  // with the human REST surface. gateCommand stays REJECTED on this agent path via the shared
  // validateAgentProjectConfigOverride validator; profile assignment can only reference a profile a
  // human already minted (getProfile must resolve), so assignment can't conjure a new capability.
  // ---------------------------------------------------------------------------------------------

  /** Role gate shared by the management methods: the caller must be a live MANAGER session. */
  private requireManager(managerSessionId: string, surface: string): void {
    const session = this.db.getSession(managerSessionId);
    if (!session) throw new Error("unknown session");
    if (session.role !== "manager") throw new Error(`${surface} is a manager-only surface`);
  }

  /** Audit one management action (single kind; detail.action discriminates). */
  private auditManage(managerSessionId: string, action: string, detail: Record<string, unknown>): void {
    this.db.appendEvent({
      id: randomUUID(), ts: new Date().toISOString(),
      managerSessionId, kind: "manager_manage", detail: { action, ...detail },
    });
  }

  /**
   * Assign an EXISTING human-authored profile to an agent (or clear it with `profileId: null`).
   * Option B: profile CREATE/edit stays human-only, so any assignable profileId was minted by a
   * human who intended it assignable — assignment can't escalate beyond what a human already blessed.
   * No ⊆-capabilities check is needed under Option B. A non-null profileId MUST resolve (else reject).
   */
  assignAgentProfile(managerSessionId: string, agentId: string, profileId: string | null): Agent {
    this.requireManager(managerSessionId, "agent_assign_profile");
    const agent = this.db.getAgent(agentId);
    if (!agent) throw new Error("agent not found");
    if (profileId != null && !this.db.getProfile(profileId)) throw new Error("profile not found");
    this.db.updateAgent(agentId, { profileId });
    this.auditManage(managerSessionId, "agent_assign_profile", { agentId, profileId });
    return this.db.getAgent(agentId)!;
  }

  /**
   * Update an agent's structural fields — its name (title) and/or startupPrompt (the injected
   * project-specifics). Capability-conferring fields (the profile) are NOT settable here; profile
   * assignment is the separate, validated assignAgentProfile path.
   */
  updateAgentPreset(
    managerSessionId: string, agentId: string, patch: { name?: string; startupPrompt?: string },
  ): Agent {
    this.requireManager(managerSessionId, "agent_update");
    const agent = this.db.getAgent(agentId);
    if (!agent) throw new Error("agent not found");
    this.db.updateAgent(agentId, { name: patch.name, startupPrompt: patch.startupPrompt });
    this.auditManage(managerSessionId, "agent_update", { agentId, fields: Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined) });
    return this.db.getAgent(agentId)!;
  }

  /**
   * Update a project's STRUCTURAL fields (name / vaultPath) and/or its config override. Config is run
   * through validateAgentProjectConfigOverride — the SAME agent-path validator project_configure uses
   * — so `orchestration.gateCommand` (host-RCE) and any unknown key are REJECTED here, while the
   * human REST PATCH keeps the full validator. repoPath is intentionally not editable (rebinding a
   * live project's repo is out of scope).
   */
  updateProjectStructural(
    managerSessionId: string, projectId: string,
    patch: { name?: string; vaultPath?: string; config?: unknown },
  ): { id: string; name: string; vaultPath: string } {
    this.requireManager(managerSessionId, "project_update");
    const project = this.db.getProject(projectId);
    if (!project) throw new Error("project not found");
    if (patch.config !== undefined) {
      const v = validateAgentProjectConfigOverride(patch.config);
      if (!v.ok) throw new Error(`invalid config: ${v.error}`);
      this.db.setProjectConfig(projectId, v.value);
    }
    this.db.updateProject(projectId, { name: patch.name, vaultPath: patch.vaultPath });
    this.auditManage(managerSessionId, "project_update", {
      projectId, fields: Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined),
    });
    const after = this.db.getProject(projectId)!;
    return { id: after.id, name: after.name, vaultPath: after.vaultPath };
  }

  /** Soft-archive a project (hidden from listProjects; rows + sessions retained). Structural, low-risk. */
  archiveProjectAsManager(managerSessionId: string, projectId: string): { archived: true; projectId: string } {
    this.requireManager(managerSessionId, "project_archive");
    if (!this.db.getProject(projectId)) throw new Error("project not found");
    this.db.archiveProject(projectId);
    this.auditManage(managerSessionId, "project_archive", { projectId });
    return { archived: true, projectId };
  }

  /**
   * Create a cron schedule that boots a manager in `agentId` on each tick (autonomous wake — agents
   * already self-`wake_me`, so this is low-risk). next_fire_at is computed here (strictly-after);
   * an invalid cron expression is rejected.
   */
  createSchedule(
    managerSessionId: string, input: { agentId: string; cron: string; enabled?: boolean },
  ): Schedule {
    this.requireManager(managerSessionId, "schedule_create");
    if (!this.db.getAgent(input.agentId)) throw new Error("agent not found");
    let next: string;
    try { next = nextFireAt(input.cron, new Date()); } catch { throw new Error("invalid cron expression"); }
    const schedule: Schedule = {
      id: randomUUID(), agentId: input.agentId, cron: input.cron,
      enabled: input.enabled ?? true, nextFireAt: next, lastFiredAt: null, createdAt: new Date().toISOString(),
      // A manager's self-service schedule always boots a manager (P5 'auditor' schedules are a
      // platform/human concern — created via the platform tool or REST, never this surface).
      kind: "manager",
    };
    this.db.insertSchedule(schedule);
    this.auditManage(managerSessionId, "schedule_create", { scheduleId: schedule.id, agentId: input.agentId, cron: input.cron });
    return schedule;
  }

  /**
   * Update a schedule's cron and/or enabled flag. A changed cron recomputes next_fire_at (rejected if
   * invalid); enabled toggles the Scheduler on/off for this row.
   */
  updateScheduleAsManager(
    managerSessionId: string, scheduleId: string, patch: { cron?: string; enabled?: boolean },
  ): Schedule {
    this.requireManager(managerSessionId, "schedule_update");
    if (!this.db.getSchedule(scheduleId)) throw new Error("schedule not found");
    const dbPatch: { cron?: string; enabled?: boolean; nextFireAt?: string } = {};
    if (typeof patch.enabled === "boolean") dbPatch.enabled = patch.enabled;
    if (typeof patch.cron === "string") {
      try { dbPatch.nextFireAt = nextFireAt(patch.cron, new Date()); } catch { throw new Error("invalid cron expression"); }
      dbPatch.cron = patch.cron;
    }
    this.db.updateSchedule(scheduleId, dbPatch);
    this.auditManage(managerSessionId, "schedule_update", { scheduleId, cron: patch.cron, enabled: patch.enabled });
    return this.db.getSchedule(scheduleId)!;
  }

  /**
   * Platform-lead cross-project spawn (loom-platform `session_spawn`). Spawns a session into ANY
   * project by explicit projectId + agentId. HARD INVARIANT — role ∈ {manager, plain} ONLY:
   *   - NEVER 'platform' — a platform session is HUMAN-REST-only (startPlatformLead). Letting this
   *     surface mint one would let anything reaching the platform MCP self-elevate to human-equivalent.
   *   - NEVER 'worker' — a worker requires a manager parent + a task + a worktree; spawning one stays
   *     a manager's orchestration job (spawnWorker), never a free-standing platform spawn.
   * The role is narrowed to `"manager" | "plain"` at the TYPE level (the in-service backstop of the
   * invariant the platform router also enforces at runtime). manager → startManager (orchestration
   * surface); plain → startNew(forcePlain) (vanilla, role null — even on a profile agent).
   */
  spawnSessionAsPlatform(projectId: string, agentId: string, role: "manager" | "plain"): Session {
    const project = this.db.getProject(projectId);
    if (!project) throw new Error("project not found");
    const agent = this.db.getAgent(agentId);
    if (!agent) throw new Error("agent not found");
    if (agent.projectId !== projectId) throw new Error("agent does not belong to the given project");
    if (role === "manager") return this.startManager(agentId);
    return this.startNew(agentId, { forcePlain: true });
  }

  /**
   * Stop ANY session by id (loom-platform `session_stop`; the cross-project analogue of
   * POST /api/sessions/:id/stop). graceful (Ctrl-C ×2, clean, default) | hard (pty.kill) — both
   * resumable + orphan-free (node-pty Job Object). Unlike stopWorker this is NOT parent-scoped: the
   * platform-lead is human-equivalent, above the manager/worker tree.
   */
  stopSession(sessionId: string, mode: StopMode): { stopped: true; sessionId: string } {
    if (!this.db.getSession(sessionId)) throw new Error("session not found");
    this.pty.stop(sessionId, mode);
    return { stopped: true, sessionId };
  }

  /**
   * Step 1 of the two-step merge gate (#16): show the manager a worker's branch diff. NO merge
   * happens — this is the review the manager cannot skip (there is no worker-side merge tool).
   */
  async reviewWorkerMerge(
    managerSessionId: string, workerSessionId: string, opts: { includePatch?: boolean } = {},
  ): Promise<{ filesChanged: number; insertions: number; deletions: number; files: DiffstatFile[]; patch?: string; note?: string; warning?: string }> {
    const worker = this.db.getSession(workerSessionId);
    if (!worker || worker.parentSessionId !== managerSessionId) throw new Error("not your worker");
    if (!worker.branch) throw new Error("worker has no branch");
    const project = this.db.getProject(worker.projectId);
    if (!project) throw new Error("project not found");
    // DEFAULT: a bounded diffstat (per-file ± + totals) so step-1 can't overflow the display on a big diff.
    // The full unified patch is opt-in (includePatch) — see the worker_merge tool's `fullDiff` flag.
    const includePatch = opts.includePatch === true;
    const diff = await diffBranch(project.repoPath, worker.branch, "HEAD", { includePatch });
    // BACKSTOP: a worker that committed to a SELF-CREATED branch instead of its assigned `loom/<key>`
    // leaves the assigned branch 0-ahead, so `diff` reads empty and the stranded commits would be
    // silently lost. Surface a WARNING at review time so the manager sees the divergence (only an
    // AFFIRMATIVE stranded signal warns; a check failure fails safe to NOT stranded). The diff fields
    // are returned unchanged.
    const stranded = await detectStrandedWork(project.repoPath, worker.worktreePath ?? worker.cwd, worker.branch, { timeoutMs: this.gitOpMs });
    const warning = stranded.stranded
      ? `STRANDED WORK: worker committed to '${stranded.branch}' (tip ${stranded.commit}, ${stranded.ahead} commit(s) ahead) instead of its assigned branch '${worker.branch}', which is empty. Confirming would merge nothing and LOSE that work. Re-point '${worker.branch}' to ${stranded.commit} (or cherry-pick it) before confirming.`
      : undefined;
    this.db.appendEvent({
      id: randomUUID(), ts: new Date().toISOString(),
      managerSessionId, workerSessionId, taskId: worker.taskId ?? null, kind: "merge_request",
      detail: { branch: worker.branch, filesChanged: diff.filesChanged, ...(warning ? { stranded: stranded.branch } : {}) },
    });
    // Bounded by default: diffstat (files + totals) only. The full patch is included ONLY when requested;
    // otherwise a `note` tells the manager how to pull it.
    return {
      filesChanged: diff.filesChanged,
      insertions: diff.insertions,
      deletions: diff.deletions,
      files: diff.files,
      ...(includePatch
        ? { patch: diff.patch }
        : { note: "Diffstat only — re-call worker_merge with fullDiff:true for the full unified patch." }),
      ...(warning ? { warning } : {}),
    };
  }

  /**
   * Step 2: run the build/DoD gate, and ONLY if green merge the branch as ONE squash commit, remove the
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
    // RESOLVE-LIVE: read the gate command AND its per-project timeout fresh here, so a human PATCH to
    // either takes effect with no daemon restart.
    const orchestration = resolveConfig(project.config).orchestration;
    const gate = orchestration.gateCommand;
    const gateTimeoutMs = orchestration.gateCommandTimeoutMs;
    const evt = (kind: OrchestrationEvent["kind"], detail?: Record<string, unknown>) => this.db.appendEvent({
      id: randomUUID(), ts: new Date().toISOString(), managerSessionId, workerSessionId, taskId, kind, detail,
    });
    const rejectNotify = (msg: string) => { try { this.pty.enqueueStdin(managerSessionId, msg); } catch { /* manager not live */ } };

    // BACKSTOP (BEFORE the gate/merge): refuse if the worker's commits are STRANDED on a self-created
    // branch instead of its assigned `loom/<key>`. The assigned branch is then 0-ahead, so the squash
    // merge below would stage NOTHING and silently DROP the real work (incident: worker 712fd5aa,
    // commit 1309552). Only an AFFIRMATIVE stranded signal refuses — a check error/timeout fails safe
    // to NOT stranded so a flaky check never blocks a legitimate merge. Leaves the repo/worktree
    // untouched so the manager can recover the commit.
    const stranded = await detectStrandedWork(project.repoPath, worktreePath, branch, { timeoutMs: this.gitOpMs });
    if (stranded.stranded) {
      evt("merge_rejected", { reason: "stranded", strandedBranch: stranded.branch, strandedCommit: stranded.commit });
      rejectNotify(`[loom:merge-rejected] worker ${workerSessionId} (task ${taskId ?? "none"}) — STRANDED WORK: commits are on '${stranded.branch}' (tip ${stranded.commit}, ${stranded.ahead} ahead), not the assigned branch '${branch}' (empty). Refusing the empty merge so the work isn't lost; canonical repo untouched, worktree retained. Re-point '${branch}' to ${stranded.commit} (or cherry-pick it), then re-confirm.`);
      return { merged: false, reason: `stranded work on '${stranded.branch}' (tip ${stranded.commit}); assigned branch '${branch}' is empty — re-point or cherry-pick before merging` };
    }

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
      const res = spawnSync(gate, { cwd: worktreePath, shell: true, timeout: gateTimeoutMs, stdio: "ignore" });
      const passed = res.status === 0 && !res.error;
      evt("build_gate", { passed });
      if (!passed) {
        evt("merge_rejected", { reason: "gate" });
        rejectNotify(`[loom:merge-rejected] worker ${workerSessionId} (task ${taskId ?? "none"}) — build gate failed; canonical repo untouched, worktree retained.`);
        return { merged: false, reason: "build gate failed" };
      }
    }

    // Squash-merge as ONE clean commit. The subject comes from the task title (mergeBranch falls back to
    // the branch name); the commit carries the deterministic `Loom-Worker-Branch` trailer used downstream.
    const taskTitle = taskId ? this.db.getTask(taskId)?.title ?? undefined : undefined;
    const merge = await mergeBranch(project.repoPath, branch, taskTitle);
    if (!merge.ok) {
      const why = merge.conflict ? "merge conflict" : (merge.reason ?? "merge failed");
      evt("merge_rejected", { reason: merge.conflict ? "conflict" : "merge_failed" });
      rejectNotify(`[loom:merge-rejected] worker ${workerSessionId} (task ${taskId ?? "none"}) — ${why}; canonical repo untouched, worktree retained. Re-task a rebase.`);
      return { merged: false, reason: why };
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
   * reconcileOrchestrationOnBoot (orphaned-merge recovery): retire the worktree, finish the task,
   * record `merge_done`, then delete the now-merged branch. Factored out so the two callers can't
   * drift. The CALLER guarantees no live pty holds the worktree cwd (confirmWorkerMerge hard-stops
   * the worker first; at boot no pty from a prior run survives). Best-effort + idempotent:
   * removeWorktree has its fs.rm backstop, deleteBranch swallows a missing branch, updateTask is a
   * no-op when the task is already `done`, and a duplicate merge_done is harmless (attention.ts keeps
   * only the latest per worker/task).
   *
   * removeWorktree is BEST-EFFORT and runs FIRST, but its throw must NOT abort the rest: on Windows a
   * just-hard-stopped worker's dir can keep a busy handle (node_modules/native modules, a lingering
   * build) past fs.rm's retry budget, so removeWorktree throws even though the `git merge` already
   * committed. Unguarded, that would skip updateTask/merge_done/deleteBranch and make the interactive
   * merge report an ERROR for an already-landed merge. So we swallow it (warn) and finish the
   * bookkeeping; the leaked dir is GC'd by boot-reconcile's Pass B on the next restart.
   *
   * ORDER IS CRASH-CRITICAL. deleteBranch is the DESTRUCTIVE op — so it MUST run LAST, AFTER the durable
   * terminal bookkeeping (updateTask done + merge_done). Under SQUASH, Pass A keys on the persistent
   * `Loom-Worker-Branch` trailer in main (not the branch ref), so deleting the branch does NOT blind
   * re-detection; idempotency instead comes from Pass A's `task done AND worktree gone → skip` short-circuit
   * plus deleteBranch being a no-op on an already-gone branch. A crash anywhere before deleteBranch leaves
   * the branch present-and-squash-landed, which Pass A idempotently re-finalizes; a crash after it can only
   * happen once merge_done is already durable. This closes the window where a crash between deleteBranch and
   * merge_done lost the terminal event AND pruned the branch, leaving a merge_request dangling forever (the
   * lingering-MERGE-REQUEST-alert root cause).
   */
  private async finalizeMerge(args: {
    managerSessionId: string; workerSessionId: string; taskId: string | null;
    worktreePath: string; branch: string; repoPath: string;
  }): Promise<void> {
    try {
      await removeWorktree(args.repoPath, args.worktreePath, { timeoutMs: this.gitOpMs });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[finalizeMerge] could not remove worktree ${args.worktreePath} (dir busy?); ` +
        `merge already landed — finishing bookkeeping, boot-reconcile Pass B will GC the dir: ${(e as Error).message}`);
    }
    // Terminal bookkeeping BEFORE the destructive deleteBranch (see the ORDER IS CRASH-CRITICAL note).
    if (args.taskId) this.db.updateTask(args.taskId, { columnKey: "done" });
    this.db.appendEvent({
      id: randomUUID(), ts: new Date().toISOString(),
      managerSessionId: args.managerSessionId, workerSessionId: args.workerSessionId,
      taskId: args.taskId, kind: "merge_done", detail: { branch: args.branch },
    });
    await deleteBranch(args.repoPath, args.branch, { timeoutMs: this.gitOpMs });
  }

  /**
   * Boot-time orchestration reconcile (#22 run-2 + audit M4). Run once at daemon boot, AFTER
   * recoverStaleSessions has marked prior-run ptys exited (so nothing live holds a worktree).
   * Three surgical, idempotent passes:
   *
   *  A. Finish orphaned squash-merges. confirmWorkerMerge commits the squash merge BEFORE its bookkeeping
   *     (removeWorktree → updateTask done → merge_done → deleteBranch). If the process dies in
   *     between (e.g. the dev daemon runs from the repo it merged into, so the merge triggers a
   *     `tsx watch` restart), the merge is correct but the task stays in_progress and the
   *     worktree/branch leak. Under SQUASH the worker branch is NOT in main's ancestry, so a landed
   *     merge is detected DETERMINISTICALLY by the `Loom-Worker-Branch` trailer mergeBranch writes
   *     (findLandedSquashCommit — whose re-task guard also rules out a branch re-cut onto a prior
   *     squash). For each worker whose squash landed but whose task isn't done and/or whose worktree
   *     still exists, we run the SAME finalizeMerge. Idempotent: once the task is done AND the worktree
   *     is gone, a re-run short-circuits. NO trailer ⇒ a genuinely-live worker (its uncommitted work
   *     has no trailer in main) ⇒ KEEP — the 2026-06-05 P0 data-loss safety, preserved under squash.
   *
   *  A2. Resolve branch-gone dangling merges (lingering-MERGE-REQUEST-alert root cause). Pass A's
   *     trailer detection finalizes a landed squash even after its branch is pruned, but it CANNOT
   *     reconstruct a PRE-squash-era orphan whose merge predates the trailer and whose
   *     `merge_done` was never recorded — exactly the residual shape (merge landed, branch gone, no
   *     terminal event) that finalizeMerge's crash-safe ordering now prevents going forward but that
   *     pre-existing orphans still carry. Detect it from the EVENT trail instead of git: a worker
   *     with a `merge_request` and NO later `merge_done`/`merge_rejected`, whose task is `done` (so
   *     the merge demonstrably landed), gets a reconciling `merge_done`. NON-DESTRUCTIVE — it emits
   *     the terminal event ONLY, never touching a worktree dir or branch (safe for already-cleared
   *     orphans) — and idempotent: the emitted merge_done makes a re-run find a terminal event and skip.
   *
   *  B. GC orphaned worktrees (M4). For an exited/dead worker whose worktree dir still lingers and
   *     isn't a finished merge handled in (A), prune the DIR ONLY (best-effort) so crashed-worker
   *     worktrees don't accumulate (they otherwise feed the H1 re-task deadlock). We never delete
   *     the branch here — any committed work stays on it and createWorktree re-attaches a fresh
   *     worktree to it on a re-task.
   */
  async reconcileOrchestrationOnBoot(protectedSessionIds: Set<string> = new Set()): Promise<{ mergesFinished: number; mergesFailed: number; staleMergesResolved: number; worktreesPruned: number; worktreesKept: number }> {
    // Include archived sessions: an archived worker whose worktree still lingers must still be GC'd.
    const all = this.db.listAllSessionsIncludingArchived();
    const handledWorktrees = new Set<string>();
    let mergesFinished = 0;
    let mergesFailed = 0;
    let staleMergesResolved = 0;
    let worktreesPruned = 0;
    let worktreesKept = 0;

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
        // SQUASH detection (the CRUX): the worker branch is NOT in main's ancestry, so the old
        // isBranchMerged is always false and worktreeHasWork (branch-ahead) cannot tell a landed-squash
        // orphan from a live worker. findLandedSquashCommit keys on the deterministic `Loom-Worker-Branch`
        // trailer — POSITIVE proof the squash landed — and its re-task guard rejects a branch re-cut onto a
        // PRIOR squash (a re-spawned live worker carrying a historical trailer + NEW work). NO trailer ⇒
        // not landed ⇒ a genuinely-live worker (uncommitted work has no trailer in main) or nothing ⇒ KEEP
        // (skip): the 2026-06-05 P0 data-loss safety, preserved. (Pass B then GCs only a provably-disposable
        // dir via worktreeHasWork.) We deliberately do NOT re-apply the worktreeHasWork guard here — under
        // squash a confirmed-landed branch is STILL ahead-of-base, so that guard would wrongly KEEP a real
        // orphan; the trailer (with its re-task guard) is the correct, deterministic signal.
        const landedSha = await findLandedSquashCommit(project.repoPath, s.branch, "HEAD", { timeoutMs: this.gitOpMs });
        if (!landedSha) continue;
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

    // A2. Resolve branch-gone dangling merges from the EVENT trail (the residual PRE-squash-era shape
    // Pass A's trailer detection can't reconstruct — no trailer was ever written). A worker with a
    // `merge_request` and no later terminal event, whose task is `done`, had its merge land but lost
    // (or never recorded) merge_done
    // → a permanent stale MERGE REQUEST alert. Emit the missing terminal event. Purely additive: no
    // git/fs op, so it never touches a worktree dir or branch (honors the inert-orphan constraint) and
    // is trivially idempotent — once merge_done exists, the next boot sees a terminal event and skips.
    for (const s of all) {
      if (s.role !== "worker" || !s.taskId) continue;
      if (protectedSessionIds.has(s.id)) continue; // about to be resumed — leave its lifecycle intact
      if (this.db.getTask(s.taskId)?.columnKey !== "done") continue; // not a demonstrably-landed merge
      const evts = this.db.listEventsForWorker(s.id);
      const hasMergeRequest = evts.some((e) => e.kind === "merge_request");
      const hasTerminal = evts.some((e) => e.kind === "merge_done" || e.kind === "merge_rejected");
      if (!hasMergeRequest || hasTerminal) continue;
      this.db.appendEvent({
        id: randomUUID(), ts: new Date().toISOString(),
        managerSessionId: s.parentSessionId ?? "", workerSessionId: s.id,
        taskId: s.taskId, kind: "merge_done", detail: { branch: s.branch ?? null, reconciled: true },
      });
      staleMergesResolved++;
    }

    // B. GC orphaned worktrees (exited/dead, dir on disk, not handled in A) — but NEVER one that still
    // holds work. SAFE-TO-DISCARD guard (P0 data-loss fix, 2026-06-05): recoverStaleSessions marks EVERY
    // prior-run session `exited` at boot, so without this the worktree of an UNRELATED manager's live
    // worker (exited here, NOT in protectedSessionIds — only the requesting manager's workers are) was
    // deleted mid-task, pre-commit. We now delete a worktree ONLY when it is provably disposable: no
    // commits ahead of main AND a clean working tree (see worktreeHasWork, which FAILS SAFE → keep on
    // any timeout/error). Anything still holding work is left on disk for a human/next pass. This holds
    // for ALL sessions in Pass B, not just protected ones.
    for (const s of all) {
      const worktreePath = s.worktreePath;
      if (!worktreePath || handledWorktrees.has(worktreePath)) continue;
      if (protectedSessionIds.has(s.id)) continue; // restart-intent worker — keep its worktree to resume into
      if (s.processState !== "exited" && s.resumability !== "dead") continue;
      if (!fs.existsSync(worktreePath)) continue;
      const project = this.db.getProject(s.projectId);
      if (!project) continue;
      handledWorktrees.add(worktreePath); // recycle chains share a worktree → decide once
      // DEAD LEFTOVER: a dir with NO `.git` linkage file is the residue of an already-completed
      // removeWorktree whose Windows fs delete partially failed (node_modules handle-lock) — git dropped
      // the admin entry + the `.git` linkage file, but the directory survived on disk. It has NO
      // recoverable git linkage, so worktreeHasWork's `git status` throws "not a git repository" → the
      // fail-safe `catch { return true }` KEEPS it → the dir leaks (~270M each) and is re-logged "holds
      // unmerged work" every boot forever. The `.git` PRESENCE check is a pure fs stat (NOT a git op), so
      // it can't itself throw/hang: a dir WITHOUT `.git` is a dead leftover we GC here; a dir WITH a valid
      // `.git` falls through to the EXACT fail-safe path below (the 2026-06-05 P0 data-loss guard for real
      // worktrees stays byte-intact). Scope: only the no-`.git` case — NOT the rarer "`.git` exists but
      // gitdir pruned" variant.
      if (!fs.existsSync(path.join(worktreePath, ".git"))) {
        try { await removeWorktree(project.repoPath, worktreePath, { timeoutMs: this.gitOpMs }); } catch { /* best-effort */ }
        worktreesPruned++;
        continue;
      }
      if (await worktreeHasWork(project.repoPath, worktreePath, s.branch ?? null)) {
        // eslint-disable-next-line no-console
        console.warn(`[reconcile] kept worktree ${worktreePath} — holds unmerged/uncommitted work (Pass B)`);
        worktreesKept++;
        continue;
      }
      try { await removeWorktree(project.repoPath, worktreePath, { timeoutMs: this.gitOpMs }); } catch { /* best-effort */ }
      worktreesPruned++;
    }

    return { mergesFinished, mergesFailed, staleMergesResolved, worktreesPruned, worktreesKept };
  }
}
