import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Ajv } from "ajv";
import {
  resolveConfig, resolveProfile, columnKeyForRole, DEFAULT_TASK_PRIORITY,
  type Session, type StopMode, type OrchestrationEvent, type Task,
  type Agent, type SessionRole, type ResolvedConfig, type PermissionPolicy, type Schedule,
  type AgentRun, type ColumnRole, type KanbanColumn, type DeliveryStatus,
} from "@loom/shared";
import type { Db, IdleNudgePolicy } from "../db.js";
import type { PtyHost, QueuedMessage } from "../pty/host.js";
import { modeAfterCyclesFromAcceptEdits } from "../pty/host.js";
import { createWorktree, removeWorktree, deleteBranch, diffBranch, mergeBranch, findLandedSquashCommit, worktreeHasWork, detectStrandedWork, precheckWorkerDone, type DiffstatFile, type MergeEmptyKind } from "../git/worktrees.js";
import { engineTranscriptExists, snapshotTranscript, deleteArchivedTranscript, archivedTranscriptExists, archivedTranscriptPath } from "./transcript.js";
import { readRunUsage, readRunUsageFromFile } from "./context.js";
import { computeRunCostUsd } from "./pricing.js";
import { createRunSnapshot, removeRunSnapshot, sweepAllRunSnapshots } from "../runs/snapshot.js";
import { composeRunStartupPrompt } from "../runs/prompt.js";
import { composeManagerStartupPrompt } from "./manager-prompt.js";
import { composePlatformLeadStartupPrompt, lineageRootId, liveLineageSuccessor, resolvePlatformLeadResumeDocPath } from "./platform-lead-prompt.js";
import { composeWorkerStartupPrompt } from "./worker-prompt.js";
import { composeAssistantStartupPrompt, appendMemoryRecallToStartupPrompt } from "./assistant-prompt.js";
import { listCompanionMemories, readCompanionMemory } from "../skills/companion-memory-store.js";
import { buildFramedMemoryRecall } from "../companion/memory-recall.js";
import type { OrchestrationControl } from "../orchestration/control.js";
import { isLikelyNearClaudeUsageLimit, getClaudeUsageLimitRetryAfter, getClaudeExpectedResetAt, UsageLimitError } from "../orchestration/usage-awareness.js";
import { rateLimitDeadline } from "../orchestration/usage-limit.js";
import { RESTART_EXIT_CODE, isSupervised, writeRestartIntent, buildDaemon, resumeSetFromIntent, isNoOpManagerWake, extractCommitShas, type RestartIntent, type RestartResumeEntry } from "../orchestration/restart.js";
import { resolveBackupConfig, takeBackup } from "../orchestration/db-backup.js";
import { recordUndeliveredReport, isCrashRecoveryEligible } from "../orchestration/crash-recovery-watcher.js";
import { RESUME_NUDGE_TAIL } from "../orchestration/resume-nudge.js";
import { nextFireAt } from "../orchestration/cron.js";
import { validateAgentProjectConfigOverride } from "../mcp/platform.js";
import { PLATFORM_PROJECT_NAME } from "../platform/seed.js";
import { SETUP_PROJECT_NAME } from "../setup/seed.js";
import { planColumnLayout, setProjectConfigSafe, type DesiredColumn } from "../tasks/columns.js";
import { resolveIdPrefix, looksLikeId, MIN_ID_PREFIX_LEN } from "../id-prefix.js";

/** Floor (1s) for any threaded git-op timeout — a sub-second misconfig must never make every git op
 *  fail-fast (mirrors GitWriter's GIT_TIMEOUT_FLOOR_MS). Applied where the resolved value is threaded. */
const GIT_TIMEOUT_FLOOR_MS = 1_000;

/**
 * PL Auditor finding #10: slugify an agent name for the worker_spawn `agentId` name/slug path — lowercase,
 * collapse any run of non-alphanumerics to a single hyphen, trim leading/trailing hyphens. Deterministic +
 * dependency-free. So "QA Tester" ⇄ "qa-tester" both resolve to that agent.
 */
function slugifyAgentName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** worker_spawn agentId resolution outcome: a unique hit, an ambiguous id-PREFIX (the candidate ids), or none. */
type WorkerAgentResolution =
  | { kind: "found"; agent: Agent }
  | { kind: "ambiguous"; ids: string[] }
  | { kind: "none" };

/**
 * PL Auditor finding #10 (+ card f9412b5e): resolve a worker_spawn `agentId` that may be a real agent id, an
 * unambiguous id-PREFIX (the 8-char short id Loom DISPLAYS as the paste-able id — mirrors transcript_read),
 * or a stable agent NAME/SLUG within the manager's project (the project is derived server-side; a client never
 * passes a projectId). Resolution order is deterministic:
 *   1. exact agent id (the historical contract — preserved byte-for-byte, global like db.getAgent);
 *   2. case-insensitive exact NAME within the project;
 *   3. SLUG (slugifyAgentName) within the project;
 *   4. unambiguous id-PREFIX within the project (resolveIdPrefix; exact id already tried, so only the
 *      >=8-char prefix path can match here) — a prefix matching >1 agent returns `ambiguous`, never a pick.
 * COLLISION RULE (name/slug): a name/slug matching multiple agents resolves to the LOWEST-position agent —
 * `listAgents` is `ORDER BY position`, so the first match is the lowest position. Deterministic.
 */
function resolveWorkerAgentRef(db: Db, projectId: string, ref: string): WorkerAgentResolution {
  const byId = db.getAgent(ref);
  if (byId) return { kind: "found", agent: byId };
  const agents = db.listAgents(projectId); // ORDER BY position ⇒ index 0 is the lowest position
  const lower = ref.toLowerCase();
  const byName = agents.find((a) => a.name.toLowerCase() === lower);
  if (byName) return { kind: "found", agent: byName };
  const slug = slugifyAgentName(ref);
  const bySlug = slug ? agents.find((a) => slugifyAgentName(a.name) === slug) : undefined;
  if (bySlug) return { kind: "found", agent: bySlug };
  const pref = resolveIdPrefix(agents, ref);
  if (pref.kind === "found") return { kind: "found", agent: pref.record };
  if (pref.kind === "ambiguous") return { kind: "ambiguous", ids: pref.ids };
  return { kind: "none" };
}

/** Case-insensitive Levenshtein edit distance — dependency-free, deterministic, for the "did you mean" hint. */
function editDistance(a: string, b: string): number {
  const s = a.toLowerCase();
  const t = b.toLowerCase();
  const m = s.length, n = t.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const curr = new Array<number>(n + 1);
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = s.charCodeAt(i - 1) === t.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min((prev[j] ?? 0) + 1, (curr[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    prev = curr;
  }
  return prev[n] ?? 0;
}

/**
 * PL Auditor finding #10: the NEAREST agent name to a bad `agentId`, for the "did you mean '<X>'?" hint —
 * the edit distance is taken to the closer of each agent's NAME or its SLUG (so a near-miss on either form
 * is caught). Deterministic: agents are scanned in position order with a STRICT `<`, so on a distance tie the
 * lowest-position agent wins. Returns undefined when the project has no agents.
 */
function nearestAgentName(agents: Agent[], ref: string): string | undefined {
  let best: string | undefined;
  let bestDist = Infinity;
  for (const a of agents) {
    const d = Math.min(editDistance(ref, a.name), editDistance(ref, slugifyAgentName(a.name)));
    if (d < bestDist) { bestDist = d; best = a.name; }
  }
  return best;
}

/** Max edit distance for an id-SHAPED "did you mean" — an id miss is a typo/truncation (distance 1-2), so a
 *  far "nearest" is no match at all (⇒ NO hint), never a confidently-wrong suggestion of an unrelated agent. */
const ID_SUGGEST_MAX_DIST = 2;

/**
 * card f9412b5e: the NEAREST agent's DISPLAYED 8-char id-PREFIX to an id-SHAPED bad `agentId`, by edit distance
 * to the closer of each agent's full id or its 8-char prefix — but ONLY within ID_SUGGEST_MAX_DIST. Beyond
 * that, returns undefined (⇒ no hint). Deterministic (position order, strict `<`). This replaces the NAME-based
 * hint for id misses: a hex prefix has an arbitrary "nearest" NAME, so the old name hint confidently named an
 * UNRELATED agent for an id typo.
 */
function nearestAgentIdPrefix(agents: Agent[], ref: string): string | undefined {
  let best: string | undefined;
  let bestDist = Infinity;
  for (const a of agents) {
    const prefix = a.id.slice(0, MIN_ID_PREFIX_LEN);
    const d = Math.min(editDistance(ref, a.id), editDistance(ref, prefix));
    if (d < bestDist) { bestDist = d; best = prefix; }
  }
  return bestDist <= ID_SUGGEST_MAX_DIST ? best : undefined;
}

/**
 * card f9412b5e: the "did you mean" hint for a worker_spawn agentId miss, routed by SHAPE — an id-shaped ref
 * (looksLikeId: hex/hyphen, >=8 chars) gets an id-PREFIX hint (or none), a name-shaped ref keeps the NAME hint.
 * Never names an unrelated agent for an id miss.
 */
function suggestAgentRef(agents: Agent[], ref: string): string | undefined {
  return looksLikeId(ref) ? nearestAgentIdPrefix(agents, ref) : nearestAgentName(agents, ref);
}

/**
 * Least-privilege hardening: the ONLY session roles a Profile may confer on a default "+New" spawn.
 * "assistant" (the long-lived Loom Companion — non-worktree, resume-durable) joins manager/worker as
 * profile-spawnable: it holds no elevated/outward capability (its whole orchestration surface is
 * my_context + the companion-gated chat_reply), so a "+New" on an assistant-profile agent may spawn it
 * directly, like a manager/worker rig.
 * The elevated/locked roles — "platform" (loom-platform surface), "auditor" (loom-audit),
 * "workspace-auditor" (loom-user-audit), "setup" (loom-setup) and "run" (internal-only Agent
 * Runs) — must come EXCLUSIVELY from their explicit human spawn paths (startPlatformLead/startAuditor/
 * startSetup/startWorkspaceAuditor) or internal starters, which pass an explicit caller
 * role. A profile role outside this set is dropped to a plain (role-null) spawn in resolveAgentSpawn,
 * so a "normal-looking" agent carrying an elevated profile + a role-omitted REST spawn can never
 * silently elevate. (Note: validateProfile already forbids "auditor"/"workspace-auditor"/"run" on a
 * profile; this is the spawn-side backstop and also covers the still-mintable "platform"/"setup".)
 */
const PROFILE_SPAWNABLE_ROLES: ReadonlySet<SessionRole> = new Set<SessionRole>(["manager", "worker", "assistant"]);

/**
 * The task-board MCP baseline a custom `permission.allow` must never be able to STRIP. Every
 * resolveAgentSpawn-driven session (manager/worker/platform/auditor/workspace-auditor/setup/plain —
 * all roles EXCEPT the run-only Agent Run, which never goes through resolveAgentSpawn) mounts the
 * `loom-tasks` MCP, and acceptEdits does NOT auto-approve MCP tools (the §9 lesson), so without
 * `mcp__loom-tasks` allowlisted the session HANGS on its first tasks_* call. The default config allow
 * already carries it (config.ts), but a per-project `permission.allow` override REPLACES that array
 * wholesale (resolveConfig: `override.permission?.allow ?? d.permission.allow`), so a custom allow that
 * forgets the baseline silently strips a worker's ability to report/coordinate. We UNION it back so a
 * custom allow can ADD to but never REMOVE the baseline. Server-level `mcp__loom-tasks` covers every
 * tasks_* tool (matches the config default's single entry).
 */
const BASELINE_SESSION_ALLOW: readonly string[] = ["mcp__loom-tasks"];

/**
 * Return `permission` with every {@link BASELINE_SESSION_ALLOW} entry guaranteed present in `allow`.
 * Byte-identical (SAME reference) when the baseline is already fully present — so the default-config and
 * profile-delta paths are unchanged; only a custom allow that omitted the baseline gets a NEW object with
 * the missing entries appended (a custom allow ADDS but never REMOVES the baseline).
 */
function withBaselineAllow(permission: PermissionPolicy): PermissionPolicy {
  const missing = BASELINE_SESSION_ALLOW.filter((t) => !permission.allow.includes(t));
  if (!missing.length) return permission;
  return { ...permission, allow: [...permission.allow, ...missing] };
}

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
  /**
   * Completion-escalation de-dup window (card 5907b71e part 2): sessionId → the deploy SHAs a
   * `[loom:daemon-restarted]` wake already delivered to that session (in the restart `reason`), with the
   * delivery time. A later "X COMPLETE + DEPLOYED" `platform_escalate` that names the SAME SHA is then a
   * duplicate of a turn the session already saw — its LIVE nudge is suppressed (the durable board task is
   * still filed). In-memory by design: the deliver (resume on boot) and the read (escalation) both happen
   * in the SAME post-restart daemon process, and a missed dedup is harmless (one extra turn). Pruned by
   * {@link SHA_DEDUP_TTL_MS} so a stale SHA can't suppress a genuinely new, unrelated escalation later.
   */
  private readonly deployShaWindow = new Map<string, { shas: Set<string>; atMs: number }>();
  private static readonly SHA_DEDUP_TTL_MS = 30 * 60_000;
  /**
   * TOCTOU spawn-claim (worker_spawn double-create race): the per-taskId set of worker spawns currently
   * IN FLIGHT — past the liveHolder check but not yet past insertSession + setProcessState('live'). The
   * existing liveHolder guard ({@link Db.liveSessionIdForTask}) is a single NON-atomic SELECT taken
   * synchronously BEFORE the first `await createWorktree`, so two CONCURRENT or RETRIED worker_spawn calls
   * for one taskId both observe liveHolder=null across that await window and both create a worktree+session
   * → TWO live workers sharing ONE branch/worktree (silent work-loss). This in-memory claim closes that
   * window: the winner adds its taskId SYNCHRONOUSLY (before any await), so a racing call's synchronous
   * prefix sees the claim and is rejected before it can createWorktree. The daemon is a SINGLE process and
   * spawnWorker is the only worker-spawn path, so an in-memory Set is sufficient and simplest. Released in a
   * finally once the row is live (the liveHolder guard then owns exclusion) or on any failure.
   */
  private readonly inFlightSpawnTaskIds = new Set<string>();
  /**
   * msgIds of durable queued messages whose RE-DRIVE enqueue is currently HELD in a recipient's pty FIFO
   * — enqueued onto a now-live recipient but not yet drained, so the durable `session_message_queued`
   * record is still unresolved. Guards against a SECOND re-drive of the same held message: the one-shot
   * boot scan (recoverUndeliveredMessagesOnBoot) and the resume/live-flip re-drive
   * (redriveUndeliveredMessagesForRecipient) both run on boot — without this, each would enqueue the SAME
   * text onto the FIFO and the recipient would see it TWICE (onDeliver's delivered-marker idempotency
   * stops double RESOLUTION, not double ENQUEUE). Cleared when the held entry finally drains
   * (resolveQueuedMessage in the onDeliver wrapper). If the holding pty (or the whole daemon) dies before
   * the entry drains, the mark is simply never set again in the next process: the durable record stays
   * unresolved and the next daemon boot's scan re-drives it exactly once (same as the pre-fix baseline —
   * an intra-process pty death just defers recovery to the next boot, it can't lose the message). In-memory
   * + process-local; the durable delivered marker remains the cross-restart idempotency guard.
   */
  private readonly redriveInFlightMsgIds = new Set<string>();
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
    agent: Agent, config: ResolvedConfig, explicitRole?: SessionRole, forcePlain = false, companionName?: string,
  ): { role: SessionRole | undefined; startupPrompt: string | undefined; permission: PermissionPolicy; browserTesting: boolean; documentConversion: boolean; restrictedTools: boolean; noCommit: boolean; model: string | undefined; skills: string[] | null } {
    // forcePlain drops the profile lookup → resolveProfile's backstop yields role null, the agent's
    // own prompt, and NO allow delta (exactly a profile-less agent's "+New").
    const profile = (forcePlain || !agent.profileId) ? undefined : this.db.getProfile(agent.profileId);
    const resolved = resolveProfile(agent, profile);
    // Layer the profile's allowDelta onto the config allow; an empty delta keeps the SAME config
    // permission reference, so a profile-less spawn is byte-identical to today.
    const layered = resolved.allow.length
      ? { ...config.permission, allow: [...config.permission.allow, ...resolved.allow] }
      : config.permission;
    // UNION the task-board baseline a custom allow must never strip (see BASELINE_SESSION_ALLOW). When the
    // baseline is already present (the default config + every profile-delta on top of it), this returns the
    // SAME reference, so the common path stays byte-identical; only a custom allow that dropped it is healed.
    const permission = withBaselineAllow(layered);
    // LEAST-PRIVILEGE backstop: a profile may confer ONLY manager|worker|assistant (or no role). An
    // elevated/locked profile role (platform/auditor/setup/run) is dropped to undefined here, so a role-omitted "+New"
    // spawn yields a plain session, never a silent elevation. An EXPLICIT caller role is untouched and
    // still wins below (`??`), so startPlatformLead/startAuditor/startManager are byte-identical; a
    // manager/worker/null profile role is also unchanged (the common path).
    const profileRole = resolved.role && !PROFILE_SPAWNABLE_ROLES.has(resolved.role) ? undefined : resolved.role;
    // An explicit caller role still wins; then the (clamped) profile role (null under forcePlain), then
    // undefined (today's plain). The force-plain path passes no explicitRole, so it resolves null.
    const role = explicitRole ?? profileRole ?? undefined;
    // Same `|| undefined` empties-to-undefined coercion today's start paths use on the agent prompt.
    const ownPrompt = resolved.startupPrompt || undefined;
    // Companion (epic Phase 1): an "assistant" session gets the server-owned base brief PREPENDED here (the
    // single spawn chokepoint), so the companion identity + untrusted-input posture + chat_reply doctrine
    // ride EVERY assistant spawn regardless of the agent's own (user-editable) prompt — mirroring how the
    // manager/worker briefs are composed, but centralized so a future explicit start path inherits it too.
    // Role-gated ⇒ byte-identical for every other role. On resume() only `.permission` is read from this
    // result, so the composed prompt is harmlessly discarded there (a resume injects nothing). companionName
    // (creation-time only, from startNew's provision caller) bakes a "Your name is <name>." identity line in
    // near the top of the base brief; undefined/blank ⇒ byte-identical to before this param existed.
    const startupPrompt = role === "assistant" ? composeAssistantStartupPrompt(ownPrompt, companionName) : ownPrompt;
    return {
      role,
      startupPrompt,
      permission,
      // Opt-in browser capability from the resolved profile (backstop false under forcePlain / no profile).
      browserTesting: resolved.browserTesting,
      // Opt-in document-conversion capability from the resolved profile (backstop false under forcePlain / no profile).
      documentConversion: resolved.documentConversion,
      // Restricted-tools from the resolved profile (subtractive spawn effect; backstop false). Pinned on the
      // session row so every respawn path re-applies the dangerous-native-tool disallow.
      restrictedTools: resolved.restrictedTools,
      // Declared no-commit role from the resolved profile (lifecycle-only; backstop false). Pinned on the
      // session row so the worker_report path can key off it across resume/fork/recycle.
      noCommit: resolved.noCommit,
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
   * `opts.companionName` (companion provision only) bakes the companion's given name into its startup
   * prompt at creation — see resolveAgentSpawn / composeAssistantStartupPrompt. Harmless on any non-
   * assistant spawn (resolveAgentSpawn only reads it when role === "assistant").
   */
  startNew(agentId: string, opts: { forcePlain?: boolean; companionName?: string } = {}): Session {
    const agent = this.db.getAgent(agentId);
    if (!agent) throw new Error("agent not found");
    const project = this.db.getProject(agent.projectId);
    if (!project) throw new Error("project not found");
    const config = resolveConfig(project.config);
    // Phase-2: an agent with a Profile spawns with the profile's role + allowDelta (the injected
    // prompt is always the agent's own). No caller role here (plain "+New"), so the profile's role
    // applies when present. No profile ⇒ role undefined, the config permission unchanged — today's session.
    // forcePlain (P3) pins role to undefined even on a profile agent (see resolveAgentSpawn).
    const { role, startupPrompt, permission, browserTesting, documentConversion, restrictedTools, noCommit, model, skills } = this.resolveAgentSpawn(agent, config, undefined, opts.forcePlain ?? false, opts.companionName);

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
      documentConversion, // profile-conferred document-conversion opt-in (false ⇒ today's plain spawn)
      restrictedTools, // profile-conferred restricted-tools, pinned (false ⇒ today's plain spawn)
      noCommit, // profile-conferred no-commit role, pinned (lifecycle-only; false ⇒ today's behavior)
      skills, // profile-conferred skill subset, pinned (null ⇒ deliver all — today's behavior)
    };
    this.db.insertSession(session);
    // M5: flip to live BEFORE wiring the pty, so onExit ('exited') from a fast-failing spawn always
    // wins — there is no post-spawn 'live' write left to clobber it back to live.
    this.db.setProcessState(session.id, "live");
    // Companion memory RECALL (fresh half, companion/memory-recall.ts): an assistant session's OWN
    // MEMORY.md store is keyed by ITS session id (companionMemoryDir), so it is normally empty on a truly
    // fresh spawn — but this stays correct for any future path that seeds memory ahead of first spawn.
    // Appended via assistant-prompt.ts so the compose logic lives in one place; null (no memories) ⇒
    // startupPrompt returned byte-identical, so a fresh companion with empty memory is unchanged.
    const finalStartupPrompt = role === "assistant"
      ? appendMemoryRecallToStartupPrompt(startupPrompt!, buildFramedMemoryRecall(listCompanionMemories(session.id), (name) => readCompanionMemory(session.id, name)))
      : startupPrompt;
    this.pty.spawn({
      sessionId: session.id,
      cwd: session.cwd,
      permission,
      geometry: config.pty,
      sessionEnv: config.sessionEnv,
      vaultPath: config.docLint ? project.vaultPath : undefined, // Pillar D: scope the vault-lint hook
      startupPrompt: finalStartupPrompt,
      role,
      browserTesting,
      documentConversion,
      restrictedTools,
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
    const { role, startupPrompt, permission, browserTesting, documentConversion, restrictedTools, noCommit, model, skills } = this.resolveAgentSpawn(agent, config, "manager");

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
      documentConversion,
      restrictedTools,
      noCommit, // declared no-commit role, pinned on the row (lifecycle-only; false ⇒ today's behavior)
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
      // PL Auditor finding #8: MANAGERS ONLY get a "Where things live" pre-block (absolute repo+vault
      // roots) so a cold-boot orchestrator reads its resume doc by absolute path instead of Globbing.
      // vaultPath is passed here UNGATED by docLint — the orchestrator needs the location regardless of
      // whether the vault-lint hook is on. Additive to the manager prompt only; every other spawn path
      // is untouched (byte-identical).
      startupPrompt: composeManagerStartupPrompt(startupPrompt, { repoPath: project.repoPath, vaultPath: project.vaultPath, name: project.name }),
      role,
      browserTesting,
      documentConversion,
      restrictedTools,
      model, // profile-pinned model → `--model` (undefined ⇒ no `--model`, byte-identical to today)
      skills, // profile-pinned skill subset → injectSkills delivers only these (null ⇒ all, byte-identical)
    });
    return { ...session, processState: "live" };
  }

  /**
   * Start a NEW PLATFORM-LEAD session in an agent (phase-2 Pillar C). Mirrors startManager, but
   * role 'platform' (so it gets the loom-platform MCP + allowlist at spawn, NOT orchestration).
   * A platform-lead creates/configures projects + agents; it runs in its host project's repo.
   *
   * CREATE-ONLY (multiple concurrent Leads allowed): a manual Spawn ALWAYS mints a FRESH platform
   * session — exactly like startAuditor below. The owner may run several live Leads at once; they
   * coordinate via the shared Platform board. (The old "never two LIVE Leads" singleton short-circuit
   * — reuse an already-live platform session instead of spawning a second — has been removed.)
   *
   * This is NOT the trust boundary. Platform-spawn is HUMAN-REST only: gateway POST
   * /api/agents/:id/sessions {role:"platform"} reaches here, and an existing Lead's self-recycle
   * (recyclePlatformLead) is the only other spawn surface — session_spawn REFUSES role:"platform", so
   * no agent/MCP path can mint one. The singleton was an operational guarantee, never the boundary.
   *
   * On-demand RESUME of an EXITED Lead stays an explicit human action (the Lead/Auditor History
   * "Resume" button → resumeSession); this path never resumes — it always INSERT+spawns. Restart-resume
   * is independent: index.ts → resumeFleetOnBoot resumes captured live sessions by id on a daemon_restart.
   */
  startPlatformLead(agentId: string): Session {
    const agent = this.db.getAgent(agentId);
    if (!agent) throw new Error("agent not found");
    const project = this.db.getProject(agent.projectId);
    if (!project) throw new Error("project not found");

    const config = resolveConfig(project.config);
    // Explicit 'platform' role from the caller ALWAYS wins; the profile (if any) only layers its
    // prompt + allowDelta. No profile ⇒ byte-identical to today's platform-lead spawn.
    const { role, startupPrompt, permission, browserTesting, documentConversion, restrictedTools, noCommit, model, skills } = this.resolveAgentSpawn(agent, config, "platform");

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
      documentConversion,
      restrictedTools,
      noCommit, // declared no-commit role, pinned on the row (lifecycle-only; false ⇒ today's behavior)
      skills, // profile-pinned skill subset, pinned on the row (null ⇒ deliver all — today's behavior)
    };
    this.db.insertSession(session);
    // M5: flip to live BEFORE wiring the pty so a fast-failing spawn's onExit always wins.
    this.db.setProcessState(session.id, "live");
    // Card 2fed1663: a fresh Spawn always opens a NEW lineage (no recycledFrom yet) — its own id IS the
    // lineageId. Resolve the (base or per-lineage, seeded-if-absent) resume-doc path and inject it as a
    // "Where things live" pre-block, mirroring the manager's composeManagerStartupPrompt seam.
    const leadResumeDocPath = resolvePlatformLeadResumeDocPath(this.db, project.vaultPath, session.id);
    this.pty.spawn({
      sessionId: session.id,
      cwd: session.cwd,
      permission,
      geometry: config.pty,
      sessionEnv: config.sessionEnv,
      vaultPath: config.docLint ? project.vaultPath : undefined, // Pillar D: scope the vault-lint hook
      startupPrompt: composePlatformLeadStartupPrompt(startupPrompt, leadResumeDocPath),
      role,
      browserTesting,
      documentConversion,
      restrictedTools,
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
    const { role, startupPrompt, permission, browserTesting, documentConversion, restrictedTools, noCommit, model, skills } = this.resolveAgentSpawn(agent, config, "auditor");

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
      documentConversion,
      restrictedTools,
      noCommit, // declared no-commit role, pinned on the row (lifecycle-only; false ⇒ today's behavior)
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
      documentConversion,
      restrictedTools,
      model, // profile-pinned model → `--model` (undefined ⇒ no `--model`, byte-identical to today)
      skills, // profile-pinned skill subset → injectSkills delivers only these (null ⇒ all, byte-identical)
    });
    return { ...session, processState: "live" };
  }

  /**
   * Start a NEW END-USER WORKSPACE-AUDITOR session in an agent (End-User Platform tier B5). Mirrors
   * startAuditor EXACTLY — incl. its CREATE-ONLY (NON-singleton) shape — but passes callerRole
   * "workspace-auditor", so the session role is LOCKED to "workspace-auditor" regardless of the agent's
   * profile role (an EXPLICIT caller role always wins in resolveAgentSpawn). The locked role — NOT the
   * profile role — drives the de-privileged loom-user-audit surface (buildMcpServers, B3): a
   * workspace-auditor session gets loom-tasks + loom-user-audit ONLY and 404s on /mcp-platform,
   * /mcp-orch, /mcp-audit and /mcp-setup, so a hostile transcript can never escape the read-and-suggest box.
   *
   * CREATE-ONLY, NOT a singleton (design gotcha #9): each on-demand "Review my workspace" run is a fresh
   * ephemeral read-and-file session, exactly like the dev Auditor (startAuditor). Do NOT copy startSetup's
   * live-reuse guard here — that would attach a repeated Review click to a stale, already-finished run.
   *
   * HUMAN-REST only (gateway POST /api/agents/:id/sessions {role:"workspace-auditor"}) — no agent/MCP path
   * mints one (session_spawn refuses everything but manager|plain; the role is absent from the mintable
   * profile enum + setupRoleError). The Workspace Auditor agent lives in the reserved "Getting Started" home (B4).
   */
  startWorkspaceAuditor(agentId: string): Session {
    const agent = this.db.getAgent(agentId);
    if (!agent) throw new Error("agent not found");
    const project = this.db.getProject(agent.projectId);
    if (!project) throw new Error("project not found");
    const config = resolveConfig(project.config);
    // Explicit 'workspace-auditor' role from the caller ALWAYS wins; the profile (if any) only layers its
    // prompt + allowDelta. The locked role — NOT the profile role — drives the loom-user-audit surface.
    const { role, startupPrompt, permission, browserTesting, documentConversion, restrictedTools, noCommit, model, skills } = this.resolveAgentSpawn(agent, config, "workspace-auditor");

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
      documentConversion,
      restrictedTools,
      noCommit, // declared no-commit role, pinned on the row (lifecycle-only; false ⇒ today's behavior)
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
      documentConversion,
      restrictedTools,
      model, // profile-pinned model → `--model` (undefined ⇒ no `--model`, byte-identical to today)
      skills, // profile-pinned skill subset → injectSkills delivers only these (null ⇒ all, byte-identical)
    });
    return { ...session, processState: "live" };
  }

  /**
   * Start a NEW SETUP-ASSISTANT session in an agent (Setup Assistant E1-5). Shaped like startManager but
   * passes callerRole "setup" so the session is LOCKED to the curated, ungated loom-setup MCP surface
   * (E1-3). Because an EXPLICIT caller role ALWAYS wins in resolveAgentSpawn, the session role is "setup"
   * regardless of the agent's profile role — the gate is keyed off the SESSION role, never the profile role.
   *
   * SINGLETON GUARANTEE = "never two LIVE setup sessions" (NOT "one row ever"). UNLIKE the Platform Lead
   * (startPlatformLead is now create-only — multiple live Leads may coexist), the Setup operator stays a
   * singleton: if a setup session is already LIVE, reuse it as-is (its pty outlived the viewer) — never
   * mint a 2nd. Otherwise FALL THROUGH and INSERT+spawn a brand-new setup session (never resume an exited
   * one here). Uses db.liveSessions (the canonical live-over-recency query — filters to LIVE before any
   * .find, so a recently-STOPPED setup session can't sort ahead of an idle-but-LIVE one; see its note + 0e40dde).
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
    const { role, startupPrompt, permission, browserTesting, documentConversion, restrictedTools, noCommit, model, skills } = this.resolveAgentSpawn(agent, config, "setup");

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
      documentConversion,
      restrictedTools,
      noCommit, // declared no-commit role, pinned on the row (lifecycle-only; false ⇒ today's behavior)
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
      documentConversion,
      restrictedTools,
      model, // profile-pinned model → `--model` (undefined ⇒ no `--model`, byte-identical to today)
      skills, // profile-pinned skill subset → injectSkills delivers only these (null ⇒ all, byte-identical)
    });
    return { ...session, processState: "live" };
  }

  /** Resume an existing session — NO prompt injection. */
  resume(sessionId: string, opts: { allowSuperseded?: boolean } = {}): Session {
    const session = this.db.getSession(sessionId);
    if (!session) throw new Error("session not found");
    // Already-live short-circuit (latent orphan-pty guard): every automatic caller pre-checks liveness
    // today (WakeService gates on !pty.isAlive, crash-recovery only targets exited rows, boot-resume runs
    // post-reconcile) and the manual REST /resume is UI-gated — but resume() itself has no structural
    // backstop. host.spawn() does this.live.set(sessionId, live) and OVERWRITES any existing live entry
    // WITHOUT .kill()-ing the prior pty, so a resume() of an already-live session would orphan the running
    // node-pty (leaked process, no onExit). Short-circuit here: if the pty is already alive, return the
    // current row WITHOUT re-spawning — a no-op that can't double-spawn or clobber the live map. A
    // genuinely exited/dead session (isAlive=false) falls through and resumes normally.
    if (this.pty.isAlive(session.id)) return session;
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
    // Re-resolve the agent's spawn so a resumed session keeps its profile's LAYERED allowlist (allowDelta),
    // not the bare config.permission — a profile-pinned worker/manager loses its allow entries on every
    // resume otherwise. The role is the row's locked role (NOT the profile's, so an explicit-role session
    // resumes byte-identically). Model is DELIBERATELY omitted on resume — `--resume` inherits the
    // transcript's model. Agent-missing (deleted) ⇒ fall back to bare config.permission so the resume still works.
    const agent = this.db.getAgent(session.agentId);
    const resumePermission = agent
      ? this.resolveAgentSpawn(agent, config, session.role ?? undefined).permission
      : config.permission;

    // M5: flip to live BEFORE wiring the pty so a fast-failing spawn's onExit ('exited') always wins.
    this.db.setProcessState(session.id, "live");
    // Auto-archive model (card b37750a4): resuming a stopped session CLEARS archived_at, returning it
    // to the live rail (the inverse of auto-archive-on-exit). Cleared HERE, before pty.spawn — so a
    // fast-failing spawn's onExit re-archives it (the M5 ordering above) rather than this clearing a
    // dead session. restoreSession is the existing archived_at clear (it subsumes the old manual restore).
    this.db.restoreSession(session.id);
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
      permission: { ...resumePermission, startupModeCycles: 0 },
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
      // Carry the document-conversion capability across resume too (pinned on the row at spawn): a
      // resumed document-worker must keep its per-session markitdown MCP, exactly as role is re-passed.
      documentConversion: session.documentConversion ?? false,
      // Carry the restricted-tools flag across resume from the ROW (pinned at spawn): a resumed Companion
      // must keep its dangerous-native-tool disallow, exactly as role/browserTesting are re-passed.
      restrictedTools: session.restrictedTools ?? false,
      // Carry the pinned skill subset across resume from the ROW (never re-resolve the profile) so the
      // resumed session sees the SAME skills it spawned with. null ⇒ all (today's behavior). (Landmine 1.)
      skills: session.skills ?? null,
    });
    // A freshly-resumed session has no turn in flight (resume injects no prompt) — clear any stale
    // busy=true carried in the DB across the restart. Without this the session shows/acts "busy"
    // forever, so enqueued worker reports queue instead of submitting and the idle guard can't fire.
    this.db.setBusy(session.id, false);
    // Companion memory RECALL (resume half, companion/memory-recall.ts) — a DELIBERATE, DOCUMENTED
    // exception to "resume injects no prompt" above: an assistant session's own durable memory
    // (memory_write) would otherwise stay mute on every resume forever, since a long-lived companion may
    // not see a fresh spawn again for months. Enqueued via the ordinary enqueueStdin turn-injection
    // primitive — ready-gated in host.ts, so it becomes the companion's FIRST turn once the resumed engine
    // is ready, ahead of anything queued below (the redelivered messages) or by a caller after resume()
    // returns (e.g. a wake's own note). No extra "recalled once" bookkeeping needed: resume() only reaches
    // this point once per activation (the isAlive short-circuit above skips it on an already-live session),
    // so building + enqueueing inline here is naturally exactly-once. Empty memory ⇒ buildFramedMemoryRecall
    // returns null ⇒ no enqueue — a companion with no memory, and every non-assistant resume (this whole
    // block is role-gated), stay byte-identical to today. The frame itself tells the model to stay SILENT
    // (never chat_reply just because this turn arrived) — see memory-recall.ts.
    if (session.role === "assistant") {
      const recall = buildFramedMemoryRecall(listCompanionMemories(session.id), (name) => readCompanionMemory(session.id, name));
      if (recall) this.pty.enqueueStdin(session.id, recall, "system");
    }
    // Live-flip re-drive (card 225559e5): this recipient just transitioned to live, so re-drive any durable
    // queued messages addressed to it that the ONE-SHOT boot scan couldn't deliver because it wasn't live
    // when that scan ran (a later resume, a wake/crash-recovery resume, or a crash boot with no restart
    // intent). Idempotent with the boot scan via redriveInFlightMsgIds + the durable delivered marker, so a
    // boot that runs BOTH (resumeFleetOnBoot → resume() here, THEN recoverUndeliveredMessagesOnBoot) enqueues
    // each message exactly once. enqueueStdin is ready-gated, so the message holds until the resumed TUI boots.
    this.redriveUndeliveredMessagesForRecipient(session.id);
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
    //   DEDUP (card 2ca18433): use getPersistablePending, NOT getPending — durable-tracked messages
    //   (session_message / message_worker, persisted as `session_message_queued`) are EXCLUDED here
    //   because the boot scan (recoverUndeliveredMessagesOnBoot) is their single re-enqueue owner. Were
    //   they in BOTH stores, a normal daemon_restart would deliver them TWICE. Non-durable held items
    //   (worker reports, idle/resume nudges) carry no callback → stay in the snapshot, replayed as before.
    const PENDING_MAX_MSGS = 50;
    const PENDING_MAX_MSG_LEN = 100_000;
    const pending: Record<string, string[]> = {};
    for (const { sessionId } of resume) {
      const snap = this.pty
        .getPersistablePending(sessionId)
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
      // `busy` snapshots whether the session was mid-turn/mid-run at capture — used by resumeFleetOnBoot to
      // gate the standing-reviewer resume nudge (card b5664b5b, Problem B).
      .map((s) => ({ sessionId: s.id, role: s.role ?? null, parentSessionId: s.parentSessionId ?? null, busy: !!s.busy }));
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
   *   - an AFFECTED manager/platform (workers resumed alongside it, queued I/O replayed to it, or pending
   *     board work) gets the full "re-check your workers" re-orient, prefixed with a one-line classification
   *     of WHAT this restart touched;
   *   - an UNAFFECTED bystander manager/platform (card 5907b71e part 1 — isNoOpManagerWake: non-causal,
   *     0 live workers in the resume set, no queued I/O replayed, AND an empty board) resumes SILENTLY —
   *     NO enqueue at all (card b5664b5b Problems A + C1). The old "lightweight FYI" was still an
   *     enqueueStdin, and an enqueue to an idle session submits as a full TURN, so the FYI burned the very
   *     turn it claimed to save (the Lead, which flows through this same branch, took ~10 such wakes in one
   *     session). Pending board work FORCES the full nudge (the idle-watcher skips a snoozed/suppressed
   *     manager, so the restart re-check is its only re-engagement — a no-op would strand the queue). Impact,
   *     not the stale idle-policy, decides (supersedes the board-AND-policy "converged" gate of card
   *     90058589). The deploy REQUESTER is NEVER short-circuited — it always gets the full "code is live —
   *     continue/verify" nudge;
   *   - every worker gets the "your worktree WIP is intact, continue your task" nudge;
   *   - a standing reviewer (auditor/workspace-auditor/setup) gets a "you were resumed — continue your work"
   *     nudge ONLY if it was BUSY (mid-run) at capture (card b5664b5b Problem B); an already-IDLE reviewer
   *     between scheduled runs resumes SILENTLY (its next due wake/schedule re-engages it via the durable
   *     WakeService/Scheduler tickers, so a nudge to it only burned a wasted turn);
   *   - a plain (role-null) or "run" session is resumed but not nudged (no orchestration loop to re-engage);
   *   - a PARKED (rate-limited) session is resumed live so the rate-limit watcher can recover it, but
   *     its nudge + pending replay are WITHHELD — we never push a held turn back into the cap (honors
   *     the park; a staggered resume via the watcher at reset). Its DB park state is left intact.
   * Each reason-bearing wake (requester + manager/platform) also records the deploy SHA(s) named in the
   * reason against its session (recordDeployShasDelivered), so a later "X COMPLETE + DEPLOYED" completion
   * escalation for the same SHA is recognized as a duplicate turn and its live nudge suppressed (part 2).
   * EVERY continuation nudge carries the shared {@link RESUME_NUDGE_TAIL} (PL Auditor #11): it NOTEs the
   * engine's file-read tracking was reset by the restart (not preservable from the daemon — re-Read before
   * Edit). It is the daemon's ONE coherent resume turn per session (card 5d8dea5f removed the old bare-
   * "Continue" disclaimer; the daemon never enqueues a standalone bare-continue).
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
    // card 5907b71e part 1 (wake cause/impact classification, superseding the older #7 + 90058589
    // "converged" gate): a manager/platform wake is classified by what THIS restart actually touched —
    // workers resumed, queued I/O replayed, the board — not by a (stale) idle-policy. An unaffected
    // bystander no-ops cheaply (isNoOpManagerWake) instead of burning a full re-check turn.
    const liveWorkerCount = (managerId: string): number =>
      entries.filter((e) => e.role === "worker" && e.parentSessionId === managerId).length;
    // Actionable board work: a task whose column is NOT the terminal lane AND is NOT held (every other
    // non-held lane — intake/defaultLanding/workReady/active/review/parked — is pending work a manager
    // should drive; a held card is the owner's brake and never counts, in any column). It FORCES the full
    // nudge: the idle-watcher skips a snoozed/suppressed manager, so the restart re-check is its only
    // re-engagement — a cheap no-op would silently strand the queue.
    const hasPendingBoardWork = (id: string): boolean => {
      try {
        const projectId = this.db.getSession(id)?.projectId;
        if (!projectId) return true; // unknown project → assume pending (a full nudge never stalls)
        const project = this.db.getProject(projectId);
        if (!project) return true;
        const cols = resolveConfig(project.config).kanbanColumns;
        const terminalKey = columnKeyForRole(cols, "terminal");
        return this.db.listTasks(projectId).some(
          (t) => t.columnKey !== terminalKey && !t.held,
        );
      } catch {
        return true; // defensive: a board-read fault must never produce a false "no-op" stall
      }
    };
    // Per-session restart impact, used by isNoOpManagerWake (restart.ts) to pick the cheap FYI vs the full
    // re-check, AND by the classification clause in the nudge text.
    const wakeImpact = (id: string) => ({
      causal: id === reqId,
      liveWorkersResumed: liveWorkerCount(id),
      queuedIoReplayed: (intent.pending?.[id] ?? []).length,
      pendingBoardWork: hasPendingBoardWork(id),
    });

    // Deploy SHAs named in the restart reason — a manager typically stamps the deployed SHA into it. Every
    // reason-bearing wake (requester + manager/platform) records these against its session so a later
    // "X COMPLETE + DEPLOYED" escalation for the same SHA can be de-duped (card 5907b71e part 2).
    const reasonShas = extractCommitShas(intent.reason);

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
          `call worker_report (done/blocked) so your manager isn't left waiting.` + RESUME_NUDGE_TAIL,
        );
      } else if (e.role === "manager" || e.role === "platform") {
        const impact = wakeImpact(e.sessionId);
        // The reason names the SHA — record it so a later completion escalation for the same SHA is a
        // recognized duplicate (part 2). Done for BOTH wake kinds: an unaffected bystander still "saw" it.
        this.recordDeployShasDelivered(e.sessionId, reasonShas);
        if (isNoOpManagerWake(impact)) {
          // card b5664b5b (Problems A + C1): a non-causal bystander this restart did NOT touch (no workers
          // resumed, no queued I/O, empty board) resumes SILENTLY — NO enqueue. The old "lightweight FYI"
          // was still an enqueueStdin, and an enqueue to an idle session is submitted as a full TURN, so the
          // FYI burned the very turn it claimed to save (the Lead took ~10 such wakes in one session). The
          // `!pendingBoardWork` precondition guarantees there's no queue to strand; if actionable work
          // appears later the idle-watcher re-engages normally. This mirrors the plain/run silent-resume
          // path below — and the platform (Lead) flows through this same branch, so a deploy-restart that
          // resumes the Lead with no new causal input (incl. a merely pending owner AskUserQuestion, which
          // is not board work) no longer forces a turn either.
        } else {
          // Affected (workers resumed, queued I/O replayed, or pending board work) → the full re-orient,
          // with a one-line classification of WHAT this restart touched so the manager re-checks precisely.
          const affected = [
            impact.liveWorkersResumed > 0 ? `${impact.liveWorkersResumed} of your live workers were resumed` : null,
            impact.queuedIoReplayed > 0 ? `${impact.queuedIoReplayed} queued message(s) were replayed to you` : null,
            impact.pendingBoardWork ? `your board has pending work` : null,
          ].filter(Boolean).join("; ");
          this.pty.enqueueStdin(
            e.sessionId,
            `[loom:daemon-restarted] Another manager restarted the daemon (reason: ${intent.reason}) and you ` +
            `were resumed — your worktrees are intact (${affected}). Resume orchestrating from where you left ` +
            `off (re-check your workers' state; some may have just been resumed too).` + RESUME_NUDGE_TAIL,
          );
        }
      } else if (e.role === "auditor" || e.role === "workspace-auditor" || e.role === "setup" || e.role === "assistant") {
        // A scheduled/standing role (Platform Auditor, Workspace Auditor, Setup Assistant, Companion) gets
        // no startup prompt on resume, so one that was MID-TURN at the restart would otherwise sit idle
        // until a human re-engages it — it gets the continuation nudge. (For the Companion, "mid-turn" means
        // it was answering a chat message when the daemon went down; an idle Companion falls through to the
        // silent resume below and its next inbound chat message re-engages it.)
        // card b5664b5b (Problem B): but gate it on busy-at-capture. An already-IDLE reviewer (e.g. an
        // Auditor that finished its bounded run between scheduled fires) does NOT need a nudge — its next
        // due wake/schedule re-engages it on its own via the durable WakeService/Scheduler tickers (which
        // fire past-due entries on boot and auto-resume a non-live session), so the old UNCONDITIONAL nudge
        // only burned a wasted turn every restart. Silencing blindly would strand a genuinely mid-run one,
        // so nudge ONLY the busy-at-capture case; the idle case falls through to a silent resume.
        if (e.busy) {
          this.pty.enqueueStdin(
            e.sessionId,
            `[loom:daemon-restarted] The daemon was rebuilt + restarted and you were resumed — continue your ` +
            `work from where you left off.` + RESUME_NUDGE_TAIL,
          );
        }
      }
      // role null (plain session) or "run" (runs don't resume — see shared/types.ts SessionRole):
      // resumed, but no orchestration loop to re-engage → no nudge.
    }

    // The requesting manager last: bring it back with its "your code is live, verify + continue" prompt.
    if (resumeOne(reqId)) {
      resumed.push(reqId);
      if (isParked(reqId)) {
        skippedParked.push(reqId);
      } else {
        replayPending(reqId);
        // The requester's "code is live" nudge names the deployed SHA (in the reason) — record it so its
        // own "X COMPLETE + DEPLOYED" completion escalation for that SHA is de-duped (card 5907b71e part 2).
        this.recordDeployShasDelivered(reqId, reasonShas);
        const reqWorkersResumed = reqWorkers.filter((id) => resumed.includes(id)).length;
        // card 90058589: the deploy REQUESTER is NEVER FYI-short-circuited — initiating a deploy is active
        // work, so it always gets the full "code is live — continue/verify" nudge (even at 0 live workers
        // with a stale done/waiting idle-policy, the case the old converged-FYI branch wrongly stalled).
        this.pty.enqueueStdin(
          reqId,
          `[loom:daemon-restarted] Rebuild + restart complete — your merged daemon code is now LIVE in the ` +
          `running daemon (reason: ${intent.reason}). ${reqWorkersResumed}/${reqWorkers.length} of your live ` +
          `workers were resumed (the rest of the fleet across all projects was resumed too). You can now ` +
          `end-to-end verify the live behavior. Continue.` + RESUME_NUDGE_TAIL,
        );
      }
    } else {
      failed.push(reqId);
    }

    return { resumed, skippedParked, failed };
  }

  /**
   * Durable queued-message recovery (card 2ca18433) — re-drive every still-undelivered `session_message_
   * queued` so a SENDER DEATH (API 529) or a DAEMON RESTART before the recipient's next turn boundary can't
   * have silently dropped a dispatch (it lost a P1 cross-project dispatch twice). Runs ONCE at boot
   * (index.ts), AFTER the fleet is resumed, and is the SINGLE re-enqueue owner for these messages: the
   * daemon_restart intent snapshot now EXCLUDES them (getPersistablePending), so there's no double on a
   * normal restart, and this also covers the crash / OS-service-restart / non-live-recipient paths the
   * intent snapshot never reached. Per still-undelivered message:
   *   • recipient is LIVE → re-enqueue with the SAME msgId (no new queued event), so it drains on the
   *     recipient's next turn and onDeliver resolves it. Delivery is proven at the TURN BOUNDARY, never
   *     assumed at dispatch — a board card moving to in_progress means nothing here.
   *   • recipient is GONE / superseded (recycled) / archived → RETIRE it (a `session_message_delivered`
   *     marker, reason="recipient-gone-or-superseded") so the undelivered set can't grow without bound (a
   *     recycle already carried its FIFO forward in-process; an archived/absent one is unrecoverable).
   *   • recipient EXISTS but isn't live → leave undelivered; a later boot that resumes it re-drives it.
   * Then every STILL-stuck outbound message (recipient not live, not retired) is surfaced to its LIVE
   * SENDER so it can re-send. Best-effort + never throws (must not gate boot). Returns counts for the log.
   */
  recoverUndeliveredMessagesOnBoot(): { reEnqueued: number; retired: number; senderNudges: number } {
    let reEnqueued = 0, retired = 0, senderNudges = 0;
    // recipientId → sender(s) of messages we couldn't re-enqueue (stuck) → surfaced to live senders below.
    const stuckBySender = new Map<string, Set<string>>();
    for (const e of this.db.listUndeliveredQueuedMessages()) {
      const outcome = this.redriveQueuedMessage(e);
      if (outcome === "reEnqueued") { reEnqueued++; continue; }
      if (outcome === "retired") { retired++; continue; }
      if (outcome === "skip") continue; // malformed — can't act on it (and nobody to nudge)
      // Not live (exited / starting) or live-without-pty → stuck; surface to the sender below.
      const recipientId = e.workerSessionId;
      if (!recipientId) continue;
      const sender = typeof e.detail?.sender === "string" ? e.detail.sender : e.managerSessionId;
      const set = stuckBySender.get(sender) ?? new Set<string>();
      set.add(recipientId);
      stuckBySender.set(sender, set);
    }

    // Surface stuck outbound to LIVE senders so they re-send (delivery is never assumed). A sentinel
    // sender ("platform" with no live session, or one since exited) simply has nobody to nudge — the
    // message stays durably undelivered and a later boot re-drives it once its recipient is back.
    for (const [senderId, recipientIds] of stuckBySender) {
      const senderSession = this.db.getSession(senderId);
      if (!senderSession || senderSession.processState !== "live") continue;
      const ids = [...recipientIds];
      const note =
        `[loom:undelivered] ${ids.length} message(s) you sent could NOT be confirmed delivered before the ` +
        `daemon restarted (their recipients aren't live): ${ids.map((i) => i.slice(0, 8)).join(", ")}. ` +
        `Loom will re-deliver automatically once each recipient is resumed, but if any is time-critical, ` +
        `re-send it (or check the recipient's state). Delivery is proven at the recipient's turn boundary, ` +
        `not at dispatch — so don't assume a queued dispatch landed.`;
      try { const nr = this.pty.enqueueStdin(senderId, note); if (nr.delivered || nr.position !== undefined) senderNudges++; } catch { /* sender not ready — the durable record stands */ }
    }
    return { reEnqueued, retired, senderNudges };
  }

  /**
   * Re-drive ONE still-undelivered durable `session_message_queued` event onto its recipient, idempotently.
   * The SINGLE per-message engine shared by the one-shot boot scan (recoverUndeliveredMessagesOnBoot) and
   * the resume/live-flip path (redriveUndeliveredMessagesForRecipient), so the two can NEVER double-deliver:
   *   • malformed (no recipient/msgId/text) → "skip";
   *   • recipient gone / recycled-forward / archived → RETIRE (a delivered marker, reason
   *     "recipient-gone-or-superseded") so the undelivered set can't grow forever → "retired";
   *   • recipient LIVE → re-enqueue with the SAME msgId (no new queued event) so its drain resolves THIS
   *     event; ready-gated in host.ts (a freshly-resumed pty holds it until its TUI boots, then drains) →
   *     "reEnqueued";
   *   • recipient exists but isn't live (exited/starting) or live-without-pty → "stuck" (the caller decides
   *     what to do — the boot scan surfaces it to the live sender; the resume path leaves it for a later flip).
   * IDEMPOTENT two ways: (1) the in-process {@link redriveInFlightMsgIds} guard — a msgId whose previous
   * re-drive is still HELD in a FIFO is reported "reEnqueued" without enqueuing a SECOND copy (the guard the
   * boot-scan↔resume overlap needs, since the held record stays unresolved until it drains); (2) across
   * restarts, the durable `session_message_delivered` marker (the unresolved-set query already excludes
   * resolved ones, and resolveQueuedMessage is a no-op if already marked).
   */
  private redriveQueuedMessage(e: OrchestrationEvent): "reEnqueued" | "retired" | "stuck" | "skip" {
    const recipientId = e.workerSessionId ?? null;
    const msgId = typeof e.detail?.msgId === "string" ? e.detail.msgId : null;
    const text = typeof e.detail?.text === "string" ? e.detail.text : null;
    if (!recipientId || !msgId || text === null) return "skip"; // malformed — can't act on it
    // A prior re-drive of this exact message is already HELD awaiting drain (this boot's other path, or a
    // near-simultaneous live-flip) → don't enqueue a second copy; its onDeliver will resolve the record.
    if (this.redriveInFlightMsgIds.has(msgId)) return "reEnqueued";

    const recipient = this.db.getSession(recipientId);
    if (!recipient || this.db.hasSuccessor(recipientId) || recipient.archivedAt) {
      // Gone / recycled-forward / archived → retire so it never re-scans forever.
      this.resolveQueuedMessage(msgId, { recipientId, reason: "recipient-gone-or-superseded" });
      return "retired";
    }
    if (recipient.processState === "live") {
      // Re-enqueue with the SAME msgId so its drain resolves THIS queued event (no duplicate record). Mark
      // it in-flight FIRST so the overlapping path skips it; the onDeliver wrapper clears the mark AND
      // resolves the durable record the instant the held message is finally handed to the recipient.
      this.redriveInFlightMsgIds.add(msgId);
      const r = this.pty.enqueueStdin(recipientId, text, "system", (reason?: string) => {
        this.redriveInFlightMsgIds.delete(msgId);
        this.resolveQueuedMessage(msgId, { recipientId, reason });
      });
      if (r.delivered || r.position !== undefined) return "reEnqueued";
      // delivered:false with no position ⇒ the host has no live pty for it (DB/host skew) → not actually
      // enqueued; undo the in-flight mark and treat as stuck so a later live-flip can retry it.
      this.redriveInFlightMsgIds.delete(msgId);
    }
    return "stuck"; // not live (exited / starting) or live-without-pty
  }

  /**
   * Re-drive any still-undelivered durable queued messages addressed to a recipient that JUST transitioned
   * to LIVE (the resume/live-flip chokepoint) — the complement to the one-shot boot scan
   * (recoverUndeliveredMessagesOnBoot). It closes the gap where a recipient is NOT live at boot recovery and
   * comes online LATER: a Lead/manager resumed after the boot scan ran (manual REST /resume, a due wake, a
   * crash-recovery resume), or a crash boot with no restart intent (so resumeFleetOnBoot never flipped it
   * live before the scan). Idempotent via {@link redriveQueuedMessage} (the in-flight guard + durable
   * delivered marker), so even when boot recovery ALSO handles the same message it is enqueued exactly once.
   * Best-effort + never throws (a re-drive fault must never disturb the resume it hangs off).
   */
  private redriveUndeliveredMessagesForRecipient(recipientId: string): void {
    try {
      for (const e of this.db.listUnresolvedQueuedMessagesForWorker(recipientId)) {
        this.redriveQueuedMessage(e);
      }
    } catch { /* best-effort — must never gate a resume */ }
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
      documentConversion: src.documentConversion ?? false, // a fork inherits the source's document-conversion capability
      restrictedTools: src.restrictedTools ?? false, // a fork inherits the source's restricted-tools disallow
      noCommit: src.noCommit ?? false, // a fork inherits the source's declared no-commit role
      skills: src.skills ?? null, // a fork inherits the source's pinned skill subset (null ⇒ all)
    };
    this.db.insertSession(session);
    // Re-resolve the agent's spawn so the fork keeps its profile's LAYERED allowlist (baseline
    // mcp__loom-tasks + profile allowDelta), not the bare config.permission — exactly as resume() does.
    // Without this a fork in a project whose custom allow omits the baseline HANGS on its first tasks_*
    // call, and a forked profile-pinned manager/worker silently loses its allowDelta entries. The role
    // is the source row's role (carried onto the fork below). Model is DELIBERATELY omitted — like
    // resume, --fork-session inherits the source transcript's model. Agent-missing (deleted) ⇒ fall back
    // to bare config.permission so the fork still works.
    const agent = this.db.getAgent(session.agentId);
    const forkPermission = agent
      ? this.resolveAgentSpawn(agent, config, src.role ?? undefined).permission
      : config.permission;
    // M5: flip to live BEFORE wiring the pty so a fast-failing spawn's onExit ('exited') always wins.
    this.db.setProcessState(session.id, "live");
    this.pty.spawn({
      sessionId: session.id,
      cwd: session.cwd,
      permission: forkPermission,
      geometry: config.pty,
      sessionEnv: config.sessionEnv,
      vaultPath: config.docLint ? project.vaultPath : undefined, // Pillar D: scope the vault-lint hook
      resumeId: src.engineSessionId, // resume the SOURCE conversation...
      fork: true,                    // ...but fork it (--fork-session)...
      forkSessionId: forkEngineId,   // ...into this pre-assigned id (--session-id).
      role: src.role ?? undefined,
      browserTesting: src.browserTesting ?? false,
      documentConversion: src.documentConversion ?? false,
      restrictedTools: src.restrictedTools ?? false, // carry the restricted-tools disallow onto the fork's pty (matches the fork row)
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
    // Resolve the agent's profile capabilities through the SAME helper every other fresh spawn uses, so a
    // run honors the agent's profile-pinned model + skills — the asymmetry this method had: it hand-rolled
    // its SpawnOpts and DROPPED both (a model-pinned agent ran on the engine default; a skills-pinned agent
    // got ALL store skills). We thread ONLY model + skills; the run's deliberate differences stay: role is
    // hardcoded "run" below (not the profile role), permission is the VERBATIM boot recipe (config.permission,
    // no allowDelta), browserTesting/documentConversion stay false, and buildMcpServers mounts ONLY loom-run.
    const { model, skills } = this.resolveAgentSpawn(agent, config, "run");

    const now = new Date().toISOString();
    const sessionId = randomUUID();
    const runId = randomUUID();
    // Default the run's I/O contract to the agent's declared `ioSchema` when the caller omits one (chose
    // option A). Without this fallback an agent's first-class, human-writable `ioSchema` had ZERO effect —
    // a schemaless start got a freeform run regardless of the declared contract. `startRun` is the single
    // choke point ALL run starts funnel through (R2 internal + R3 keyed REST), so defaulting here covers
    // every entry. An explicit `opts.schema` still OVERRIDES (a null/absent one falls through to ioSchema,
    // then to null ⇒ freeform). submitRunResult validates against this now-defaulted `run.schema`.
    const schema = opts.schema ?? agent.ioSchema ?? null;

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
      role: "run", browserTesting: false, documentConversion: false, restrictedTools: false, noCommit: false,
      skills, // profile-pinned skill subset, pinned on the row (null ⇒ deliver all — today's behavior)
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
      documentConversion: false,
      restrictedTools: false,
      model, // profile-pinned model → `--model` (undefined ⇒ no `--model`, byte-identical to today)
      skills, // profile-pinned skill subset → injectSkills delivers only these (null ⇒ all, byte-identical)
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
  // Per-project session Archive (HUMAN-only REST surface, like stop/fork — NEVER an MCP tool).
  // Archiving is now AUTOMATIC (card b37750a4): a session is auto-archived when its pty exits
  // (index.ts onExit) and auto-restored when it resumes (resume() clears archived_at). There is NO
  // manual "archive a session" action anymore. What remains here is restore (subsumed by resume but
  // kept for the Archive UI's view-only/dead path) + permanent delete (drop the row + snapshot).
  // ---------------------------------------------------------------------------------------------

  /** Restore an archived session back to the rail (single row — not a cascade). */
  restoreSession(sessionId: string): { restored: string } {
    const s = this.db.getSession(sessionId);
    if (!s) throw new Error("session not found");
    this.db.restoreSession(sessionId);
    return { restored: sessionId };
  }

  /**
   * Permanently delete an archived session: drop its row + transcript snapshot. A manager CASCADES
   * to its archived workers — and ONLY those: the cascade set is `listArchivedWorkers` (archived_at
   * NOT NULL), which excludes any still-live worker, so under per-session archiving (no archive-time
   * cascade) deleting an archived manager never reaches a worker that's still running. Refuses a
   * non-archived session (archive it first).
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
    const agentRef = (opts.agentId ?? "").trim();
    if (!agentRef) throw new Error("worker_spawn requires an explicit worker agentId (a Dev/Bugfix/QA/Docs agent) — never the manager's own agent");
    // PL Auditor finding #10 + card f9412b5e (the agentId UX cousin of the taskId guard #1): accept a real agent
    // id, an unambiguous id-PREFIX (the 8-char short id Loom DISPLAYS — mirrors transcript_read), OR a stable
    // agent NAME/SLUG, resolved SERVER-SIDE within this manager's project (the project is derived from the
    // manager; a client never passes a projectId). A hand-copied id with a one-char typo no longer just 404s —
    // it resolves by prefix/name, and failing that the error carries a SHAPE-routed "did you mean" hint (an
    // id-shaped miss never names an unrelated agent). An AMBIGUOUS prefix names the candidate ids, never a pick.
    // Name/slug collisions resolve to the lowest-position agent (see resolveWorkerAgentRef).
    const resolvedAgent = resolveWorkerAgentRef(this.db, manager.projectId, agentRef);
    if (resolvedAgent.kind === "ambiguous") {
      throw new Error(`worker_spawn agentId '${agentRef}' is an ambiguous id-prefix — it matches ${resolvedAgent.ids.join(", ")}; pass more characters or the full id`);
    }
    if (resolvedAgent.kind === "none") {
      const suggestion = suggestAgentRef(this.db.listAgents(manager.projectId), agentRef);
      throw new Error(`worker_spawn agentId '${agentRef}' does not resolve to an existing agent${suggestion ? ` — did you mean '${suggestion}'?` : ""}`);
    }
    const workerAgent = resolvedAgent.agent;
    // Reject a manager/platform-role rig: a worker must run under a worker (or plain) agent, never a
    // coordination agent. The role is the agent's resolved PROFILE role (resolveProfile — the canonical
    // mechanism); a profile-less agent (Dev/Bugfix/Docs/QA today) resolves to null and is allowed.
    const profileRole = resolveProfile(workerAgent, workerAgent.profileId ? this.db.getProfile(workerAgent.profileId) : undefined).role;
    if (profileRole === "manager" || profileRole === "platform" || profileRole === "auditor" || profileRole === "run") {
      throw new Error(`cannot spawn a worker under the '${workerAgent.name}' agent (a ${profileRole}-role profile); pick a worker agent (Dev/Bugfix/QA/Docs)`);
    }
    // Validate the taskId BEFORE any side effect (worktree/session/branch) — mirror the agentId existence
    // guard above. A truncated id WITH a trailing space + a placeholder kickoff once SUCCEEDED, binding a
    // live worker to a bogus task string (a zombie) while the real task stayed in backlog. Trim first (so a
    // pasted id with stray whitespace normalizes), reject an empty/whitespace-only or whitespace-containing
    // id, then require the id to resolve to a REAL, NON-terminal task IN THIS PROJECT — a truncated/malformed/
    // unknown id won't resolve and is rejected with the same "does not resolve" shape the agentId guard uses.
    // A bad id must create NOTHING.
    const taskId = (opts.taskId ?? "").trim();
    if (!taskId || /\s/.test(taskId)) throw new Error(`worker_spawn taskId '${opts.taskId}' is not a valid task id`);
    const task = this.db.getTask(taskId);
    if (!task || task.projectId !== manager.projectId) throw new Error(`worker_spawn taskId '${taskId}' does not resolve to an existing task in this project`);
    const terminalKey = columnKeyForRole(config.kanbanColumns, "terminal");
    if (task.columnKey === terminalKey) throw new Error(`worker_spawn taskId '${taskId}' is in the terminal column ('${task.columnKey}') — pick a non-terminal task`);
    // OWNER-BRAKE (structural): refuse to dispatch onto a HELD card — the owner's SOLE brake, a per-card
    // flag checked in ANY column (Board Hold Model redesign; retires the column-based `blocked`/`humanHold`
    // lane this used to key off). A one-line sibling of the terminal rail, BEFORE any worktree/pty side effect.
    if (task.held === true) {
      throw new Error(`worker_spawn taskId '${taskId}' is HELD (owner brake) — release the hold before dispatching a worker`);
    }
    // DATA-LOSS guard (structural): refuse a SECOND live worker on a task already held by a live one. The
    // worktree path is DETERMINISTIC per task and createWorktree REUSES an existing dir, recutting a 0-ahead
    // branch with `reset --hard mainSha` — designed for re-spawn after a REJECTED merge (a DEAD worker). With a
    // LIVE first worker mid-edit, a second spawn would share its checkout and the reset --hard would silently
    // DESTROY the first's uncommitted work. The lookup is BOARD-WIDE (not the manager-scoped listWorkers — a
    // sibling manager's worker on the same task must be visible), and runs BEFORE any worktree/pty side effect.
    const liveHolder = this.db.liveSessionIdForTask(taskId);
    if (liveHolder) {
      throw new Error(`worker_spawn taskId '${taskId}' already has a live worker (${liveHolder}); stop or recycle it before re-spawning`);
    }
    // Resolve THAT agent's profile for its browser-automation opt-in + skill subset — a manager spawns a
    // QA worker by pointing it at a browserTesting profile (e.g. the bundled "QA Tester"). Explicit role is
    // "worker"; we read browserTesting + skills (permission stays config.permission, byte-identical to
    // today). A worker runs in its OWN worktree (separate cwd), so its subset is delivered EXACTLY.
    const workerSpawn = this.resolveAgentSpawn(workerAgent, config, "worker");
    const browserTesting = workerSpawn.browserTesting;
    const documentConversion = workerSpawn.documentConversion;
    const restrictedTools = workerSpawn.restrictedTools; // curated dangerous-native-tool disallow (blast-radius control)
    const noCommit = workerSpawn.noCommit; // declared no-commit role (e.g. a Code Reviewer rig) — lifecycle-only
    const skills = workerSpawn.skills;

    // Safety rails (§17a) — refuse NEW work before any side effect (worktree/pty). In-flight
    // workers are untouched. Pause is global-or-this-manager. (The concurrency cap is admitted
    // atomically with the per-taskId claim below — see that block.)
    if (this.control.isPaused(managerSessionId)) throw new Error("orchestration paused");
    // §19c: don't spawn a worker into a known usage-limited account (whole-queue awareness). The recency
    // window is the daemon-global `platform.rateLimit.recencyWindowMs`, resolved LIVE here (db in scope).
    const rl = resolveConfig(undefined, this.db.getPlatformConfig()).platform.rateLimit;
    const recencyWindowMs = rl.recencyWindowMs;
    const usageNow = new Date();
    if (isLikelyNearClaudeUsageLimit(usageNow, recencyWindowMs)) {
      // STRUCTURED retry-after + AUTO-WAKE wiring (PL Auditor finding #7). The old bare
      // `throw new Error("usage limit active")` left a spawn-blocked manager with no deadline (→ guesswork)
      // and no auto-wake (→ the repro: THREE human "retry" pokes to clear one transient limit).
      // (1) Derive the retry-after deadline from the SAME awareness boundary the check above used.
      const retryAfter = getClaudeUsageLimitRetryAfter(usageNow, recencyWindowMs)?.toISOString();
      // (2) Register THIS manager into the EXISTING rate-limit park machinery so it is AUTO-WOKEN on
      // hold-clear with no human poke — NOT a parallel mechanism: the clear-usage-hold cascade
      // (gateway `/api/usage/clear-hold` → db.listRateLimited → pty.resumeAfterRateLimit) wakes it on a
      // manual clear, and the RateLimitWatcher (db.listRateLimitEpisodes, deadline-armed) auto-resumes it
      // once the reset passes. setRateLimitedUntil stamps the resume-at (so the watcher waits, not resumes,
      // until then); armRateLimitDeadline COALESCEs (a live StopFailure episode's give-up deadline wins).
      // Skip the park if the limit raced to clear (retryAfter undefined) — nothing to wait for.
      if (retryAfter) {
        const knownReset = getClaudeExpectedResetAt(usageNow);
        const giveUp = rateLimitDeadline(knownReset ? Math.floor(knownReset.getTime() / 1000) : undefined, usageNow, rl);
        this.db.setRateLimitedUntil(managerSessionId, retryAfter, `usage limit active — worker_spawn deferred; resumes ${retryAfter}`);
        this.db.armRateLimitDeadline(managerSessionId, giveUp);
      }
      throw new UsageLimitError(retryAfter);
    }

    // ATOMIC per-taskId spawn claim (the real fix — NOT merely a narrowed TOCTOU window). liveSessionIdForTask
    // is a single NON-atomic SELECT taken BEFORE the `await createWorktree` below, and the row is inserted only
    // AFTER it; so two CONCURRENT or RETRIED worker_spawn calls for one taskId both observe liveHolder=null
    // across that await gap and both create a worktree+session → TWO live workers sharing ONE branch (silent
    // work-loss). The claim below is a TRUE MUTEX, not just a tighter check:
    //
    //   ATOMICITY PROOF. Node runs each turn to completion on a single thread; a turn yields ONLY at an `await`
    //   (or return). The test-and-set here — `if (has(taskId)) throw; add(taskId)` — contains NO `await`
    //   between the .has() and the .add(), so it executes as one INDIVISIBLE step: no other call can be
    //   scheduled in between. Calling `spawnWorker(...)` runs its synchronous prefix immediately up to the
    //   FIRST await (this method's first await is `createWorktree`, BELOW this claim). Therefore for two
    //   racing calls A and B on one taskId, whichever's synchronous prefix runs first reaches `.add(taskId)`
    //   and only THEN yields at createWorktree; the other's prefix then runs with the claim already present
    //   and is rejected before it can createWorktree. They cannot interleave inside the check-and-claim, so
    //   at most one ever proceeds. (Single-process-sufficient: the daemon is ONE process and spawnWorker is
    //   the only worker-spawn path — boot-resume resumes by id, never inserts — so an in-memory Set needs no
    //   cross-process lock; a DB unique index would be equivalently strong but would have to thread the
    //   legitimate multi-row-per-task history of exited/recycled rows, which this avoids.)
    //
    // We claim BEFORE createWorktree, so the LOSER never creates an orphan worktree/branch at all — nothing to
    // clean up. Released in the finally once the row is live (the liveHolder guard then owns exclusion) or on failure.
    if (this.inFlightSpawnTaskIds.has(taskId)) {
      throw new Error(`worker_spawn taskId '${taskId}' already has a spawn in flight; wait for it to finish before re-spawning`);
    }
    // ATOMIC concurrency-cap admit — co-located with the per-taskId claim so the cap decision and the
    // reservation share ONE no-await window (same TOCTOU class as the per-taskId race above, on the cap axis).
    // The old check `liveWorkers >= cap` counted only LIVE DB rows and ran BEFORE `await createWorktree`, but a
    // worker row is inserted only AFTER that await. So N concurrent worker_spawn calls for DIFFERENT taskIds each
    // observed liveWorkers unchanged (none had inserted yet) and all admitted → the fleet overshot
    // maxConcurrentWorkers by up to N-1. Counting the in-flight claims (each WILL become a live worker) closes
    // it: by the same ATOMICITY PROOF above, each racing call runs its synchronous prefix to completion — through
    // this admit AND the `.add()` — before the next call's prefix is scheduled (the first await is createWorktree,
    // BELOW), so call K observes the (K-1) prior claims already in the set. Checked BEFORE `.add()`, so `size`
    // excludes self: with cap C and L live workers, exactly C-L calls admit and the rest are rejected with the
    // existing message — each BEFORE createWorktree, so a rejected spawn leaves no orphan worktree/branch.
    // (Conservative across managers: inFlightSpawnTaskIds is daemon-global while the live count is THIS manager's,
    // so a sibling manager's in-flight spawn can only make this check reject EARLIER — never let the fleet overshoot.)
    const liveWorkers = this.db.listWorkers(managerSessionId).filter((w) => w.processState === "live").length;
    const cap = config.orchestration.maxConcurrentWorkers;
    if (liveWorkers + this.inFlightSpawnTaskIds.size >= cap) throw new Error(`concurrency cap reached (${cap})`);
    this.inFlightSpawnTaskIds.add(taskId);
    try {
      const { worktreePath, branch } = await createWorktree(project.repoPath, project.id, taskId, { timeoutMs: this.provisionMs });

      const now = new Date().toISOString();
      const worker: Session = {
        id: randomUUID(),
        projectId: manager.projectId,
        agentId: workerAgent.id, // the RESOLVED agent (opts.agentId may have been a name/slug — bind to the real id)
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
        documentConversion, // document worker (profile opt-in) ⇒ per-session markitdown MCP; else false (plain)
        restrictedTools, // restricted-tools worker (profile opt-in) ⇒ dangerous native tools disallowed; else false (plain)
        noCommit, // declared no-commit role (e.g. Code Reviewer) ⇒ 0-commit done auto-retires + skips the warning
        skills, // profile-pinned skill subset for the worker (null ⇒ all); pinned so resume/recycle honor it
        parentSessionId: managerSessionId,
        taskId,
        worktreePath,
        branch,
      };
      this.db.insertSession(worker);
      // M5: flip to live BEFORE wiring the pty so a fast-failing spawn's onExit ('exited') always wins.
      this.db.setProcessState(worker.id, "live");
      this.pty.spawn({
        sessionId: worker.id,
        cwd: worktreePath,
        permission: workerSpawn.permission, // layered allowDelta from the worker profile (was bare config.permission — dropped the profile allowlist)
        geometry: config.pty,
        sessionEnv: config.sessionEnv,
        vaultPath: config.docLint ? project.vaultPath : undefined, // Pillar D: scope the vault-lint hook
        // Compose the worker's opening: a worktree LOCATION block first (names this worktree as the edit
        // dir so the worker can't leak edits into the main checkout), then its agent BASE BRIEF (Dev/Bugfix/
        // etc. doctrine — run `/worker`, CLAUDE.md is law), then the manager's kickoff. An empty brief
        // degrades to the block + kickoff. Without this, the agent brief was dead config for workers.
        startupPrompt: composeWorkerStartupPrompt(workerAgent.startupPrompt, opts.kickoffPrompt, worktreePath),
        role: "worker", // gives the worker the orchestration surface (worker_report only)
        browserTesting, // inject the per-session Playwright MCP iff this worker's profile opted in
        documentConversion, // inject the per-session markitdown MCP iff this worker's profile opted in
        restrictedTools, // union the dangerous-native-tool disallow into --disallowedTools iff this worker's profile opted in
        model: workerSpawn.model, // profile-pinned model → `--model` (undefined ⇒ no `--model`); was dropped — workers never honored a profile model pin
        skills, // deliver only the worker profile's skill subset (null ⇒ all)
      });
      // Move the task into the `active` lane (role-resolved off the manager-project config, not the
      // hardcoded "in_progress" key). If the board has no active lane, leave the card where it is rather
      // than inventing a key — the invariant: a move never points a task at a non-existent column.
      const activeKey = columnKeyForRole(config.kanbanColumns, "active");
      if (activeKey) this.db.updateTask(taskId, { columnKey: activeKey });
      this.db.appendEvent({
        id: randomUUID(), ts: new Date().toISOString(),
        managerSessionId, workerSessionId: worker.id, taskId, kind: "spawn_worker",
      });
      return { ...worker, processState: "live" };
    } finally {
      // Release the per-taskId claim. By here the row is either live (liveHolder now rejects re-spawns) or
      // the spawn threw before any persistent state — either way the next spawn must be free to proceed.
      this.inFlightSpawnTaskIds.delete(taskId);
    }
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
    // Durable-tracked: if the worker is busy the message is HELD in its FIFO and persisted as
    // `session_message_queued` so a sender death / daemon restart can't drop it (card 2ca18433).
    const r = this.enqueueDurableMessage(workerSessionId, framed, { sender: managerSessionId, taskId: worker.taskId ?? null });
    this.db.appendEvent({
      id: randomUUID(), ts: new Date().toISOString(),
      managerSessionId, workerSessionId, taskId: worker.taskId ?? null, kind: "message_worker",
    });
    return r;
  }

  /**
   * REDIRECT one of a manager's workers (parent-scoped) — the "land it NOW" steer, strictly more forceful
   * than messageWorker (additive, non-interrupting): END the worker's CURRENT turn and REPLACE its pending
   * direction with this single authoritative instruction, delivered as the next turn. NO new trust surface —
   * steering your own worker is strictly LESS than the stopWorker process-kill the manager already holds.
   *
   * ORDER IS LOAD-BEARING (so the redirect deterministically lands as the next turn):
   *   (a) FLUSH the worker's pending FIFO and SUPERSEDE each flushed durable record (fire its onDeliver with
   *       reason "superseded" → a session_message_delivered marker), so the worker_report done-guard and the
   *       boot-recovery scan never later re-drive the direction we're replacing. Plain (non-durable) held
   *       nudges carry no callback and are simply dropped — the redirect supersedes them too.
   *   (b) ENQUEUE the authoritative redirect (framed `[loom:from-manager:redirect]`) via the SAME durable
   *       channel as messageWorker: a busy worker HOLDS it (delivered:false, persisted) — it is now the only
   *       entry in the freshly-flushed queue; an idle worker submits it immediately (delivered:true).
   *   (c) ONLY IF it was HELD (delivered:false ⇒ the worker was busy) do we interrupt: pty.interruptForRedirect
   *       writes a single Esc to cancel the in-flight turn, then after a bounded settle clears the (stale) busy
   *       and drains — delivering the redirect we enqueued in (b). The enqueue is SYNCHRONOUS and precedes the
   *       interrupt's settle timer, so the message is always in the queue before the settle-drain fires (if it
   *       were idle there's no turn to cancel, so we skip the Esc and the redirect already went out as a turn).
   *
   * Returns the enqueue status ({delivered, position?}). Throws "not your worker" for a non-child (mirrors
   * messageWorker/stopWorker's parent gate).
   */
  redirectWorker(
    managerSessionId: string, workerSessionId: string, text: string,
  ): { delivered: boolean; position?: number } {
    const worker = this.db.getSession(workerSessionId);
    if (!worker || worker.parentSessionId !== managerSessionId) throw new Error("not your worker");
    // (a) FLUSH + SUPERSEDE the worker's queued direction before the authoritative redirect lands.
    const flushed = this.pty.flushPending(workerSessionId);
    for (const m of flushed) {
      if (m.onDeliver) { try { m.onDeliver("superseded"); } catch { /* a resolution fault must never block the redirect */ } }
    }
    // (b) ENQUEUE the authoritative redirect (durable-tracked like messageWorker). Distinctly framed so the
    // worker knows this REPLACED its pending direction and may have interrupted it mid-edit.
    const framed = `[loom:from-manager:redirect]\n${text}`;
    const r = this.enqueueDurableMessage(workerSessionId, framed, { sender: managerSessionId, taskId: worker.taskId ?? null });
    // (c) Interrupt ONLY when the redirect was HELD (the worker was busy). For an idle worker the redirect
    // already went out as a turn (delivered:true) — there is nothing to cancel, and an Esc would wrongly
    // cancel that very turn.
    if (!r.delivered) this.pty.interruptForRedirect(workerSessionId);
    this.db.appendEvent({
      id: randomUUID(), ts: new Date().toISOString(),
      managerSessionId, workerSessionId, taskId: worker.taskId ?? null, kind: "redirect_worker",
      detail: { delivered: r.delivered, superseded: flushed.length },
    });
    return r;
  }

  /**
   * Durable down/cross-tree message send (card 2ca18433). Wraps pty.enqueueStdin: if the recipient is
   * idle the message goes out as a turn now (delivered:true, nothing persisted — it's already live); if
   * it's BUSY the message is HELD in the recipient's in-memory FIFO (delivered:false) AND persisted as a
   * `session_message_queued` event, so a sender death (API 529) or a daemon restart before the
   * recipient's next turn boundary can no longer SILENTLY DROP it (it lost a P1 dispatch twice). The
   * onDeliver callback resolves the durable event the instant the held message is finally handed to the
   * recipient — drained at its next Stop or pulled via inbox_pull. The boot scan
   * (recoverUndeliveredMessagesOnBoot) re-drives any that a process death interrupted before delivery.
   */
  private enqueueDurableMessage(
    recipientId: string, framedText: string, ctx: { sender: string; taskId?: string | null },
  ): { delivered: boolean; position?: number } {
    const msgId = randomUUID();
    // onDeliver carries an OPTIONAL reason: the normal drain/pull paths fire it with no arg (a plain
    // delivery); a flush/SUPERSEDE caller (redirectWorker) passes "superseded" so the resolution event
    // records WHY the durable record closed without being delivered as a turn.
    const r = this.pty.enqueueStdin(recipientId, framedText, "system", (reason?: string) => this.resolveQueuedMessage(msgId, { recipientId, reason }));
    if (!r.delivered) {
      // Held (busy / not-ready) — persist the durable inbox record. delivered:false with no position also
      // means "recipient not live": we still record it, so the boot scan re-drives it once the recipient
      // is resumed (never silently lost), and surfaces it to the sender if it stays stuck.
      this.db.appendEvent({
        id: randomUUID(), ts: new Date().toISOString(),
        managerSessionId: ctx.sender, workerSessionId: recipientId, taskId: ctx.taskId ?? null,
        kind: "session_message_queued", detail: { msgId, text: framedText, sender: ctx.sender },
      });
    }
    return r;
  }

  /**
   * Mark a durable queued message DELIVERED (idempotent) — the resolution half of `session_message_queued`.
   * Fired by the host the instant a held message is handed to the recipient (drainPending / consumePending),
   * and by the boot scan to RETIRE a message whose recipient is gone/superseded (`reason`). Idempotent via
   * the delivered-marker check, and NEVER throws (a delivery-marking fault must not disturb the host drain
   * or gate boot). A msgId that was never persisted (immediate delivery) simply records a harmless marker
   * with no queued counterpart — but onDeliver is only ever attached to a HELD entry, so that can't occur.
   */
  private resolveQueuedMessage(msgId: string, opts: { recipientId?: string; reason?: string } = {}): void {
    try {
      if (this.db.isQueuedMessageDelivered(msgId)) return; // already resolved — idempotent no-op
      this.db.appendEvent({
        id: randomUUID(), ts: new Date().toISOString(),
        managerSessionId: "", workerSessionId: opts.recipientId ?? null, taskId: null,
        kind: "session_message_delivered", detail: opts.reason ? { msgId, reason: opts.reason } : { msgId },
      });
    } catch { /* delivery-marking must never disturb the host drain or boot */ }
  }

  /**
   * Re-drive a recycled predecessor's held inbound queue onto its FRESH successor, preserving BOTH the
   * source classification AND durable crash-survival. `flushed` is the predecessor's spliced FIFO (from
   * pty.flushPending — onDeliver + source intact); `durableRecords` is a snapshot of its unresolved
   * `session_message_queued` records taken BEFORE this runs (the durable inbox).
   *
   * Why not the old `getPending` + bare `enqueueStdin` (text only):
   *  - SOURCE — a held 'human' turn re-enqueued with the default 'system' source would be silently
   *    reclassified, so the human-only queue mutators could no longer touch it. We carry m.source.
   *  - CRASH-SURVIVAL — a durable message's record still names the OLD recipient; on the next boot the
   *    recovery scan RETIRES it as superseded (the predecessor hasSuccessor), so a bare carry that drops
   *    the durable channel loses the message if the daemon restarts before the successor drains it.
   *
   * So, exactly like `redirectWorker`: SUPERSEDE each carried durable record (fire its onDeliver with
   * "superseded" — resolves the old record so the boot scan + done-guard never re-drive it), then re-MINT
   * it onto the successor via `enqueueDurableMessage` (a NEW record naming the successor as recipient,
   * carrying the ORIGINAL sender/taskId so an undelivered re-mint still surfaces to its sender on boot).
   * Non-durable entries (idle/resume nudges, raw human turns) carry across with their source preserved.
   */
  private carryPendingToSuccessor(
    oldId: string, successorId: string, flushed: QueuedMessage[], durableRecords: OrchestrationEvent[],
  ): void {
    for (const m of flushed) {
      if (m.onDeliver) {
        // Durable entry — its record is re-minted from `durableRecords` below; resolve the OLD record now.
        try { m.onDeliver("superseded"); } catch { /* a resolution fault must never block the recycle */ }
      } else {
        // Non-durable (nudge / raw human turn): carry the text AND its source so a 'human' entry stays human.
        this.pty.enqueueStdin(successorId, m.text, m.source);
      }
    }
    // Re-mint each unresolved durable record onto the successor (recipient ← successor), so crash-survival
    // follows the recycle chain instead of dead-ending at the retired predecessor.
    for (const rec of durableRecords) {
      const text = typeof rec.detail?.text === "string" ? rec.detail.text : null;
      if (text === null) continue; // malformed — nothing to re-drive
      const sender = (typeof rec.detail?.sender === "string" && rec.detail.sender) ? rec.detail.sender : rec.managerSessionId;
      this.enqueueDurableMessage(successorId, text, { sender, taskId: rec.taskId ?? null });
    }
  }

  /**
   * Platform-Lead cross-project message delivery (loom-platform `session_message`, P4). UN-scoped: where
   * messageWorker is parent/child-gated, the Lead stands ABOVE the whole manager/worker tree and may
   * message ANY session in ANY project — no parentSessionId check. Reuses the SAME stdin-enqueue channel
   * (submitted as a turn when idle, queued FIFO and drained on the next turn boundary when busy). Framed
   * `[loom:from-platform]` so the receiver knows the source is the platform operator, not its own manager.
   * DELIVERY ONLY — it never spawns anything. Throws (→ the router's error envelope) ONLY if the target
   * session is UNKNOWN.
   *
   * Returns a `deliveryStatus` (delivered-live | queued | boarded) so the Lead gets an HONEST outcome:
   *  - LIVE target → the durable stdin-enqueue channel (submitted as a turn if idle = delivered-live;
   *    held FIFO if busy = queued).
   *  - NOT-LIVE target whose recycle lineage has a LIVE successor (card 5519559c) → route to the successor
   *    via the SAME durable channel instead of boarding: the target id was superseded, not gone, so the
   *    Lead's message reaches whoever is actually doing the work now. `routedTo` names the successor so
   *    the caller can see the redirect. This is DISTINCT from card 2ca18433 (a still-live recipient that
   *    recycles AFTER a message is already queued) — here the target is already dead at send time.
   *  - NOT-LIVE target with NO live successor anywhere in its lineage → it has no PTY to take a turn, so
   *    instead of THROWING (which silently dropped the Lead's message), we BOARD a durable note onto the
   *    target's OWN project board — the same durable-board fallback platformEscalate uses for an offline
   *    Lead — and return `boarded`. The message is never lost.
   */
  messageSessionAsPlatform(
    sessionId: string, text: string, senderSessionId?: string,
  ): { deliveryStatus: DeliveryStatus; position?: number; taskId?: string; routedTo?: string } {
    const session = this.db.getSession(sessionId);
    if (!session) throw new Error("session not found");
    const framed = `[loom:from-platform]\n${text}`;
    const deliverLive = (target: typeof session) => {
      // Durable-tracked (card 2ca18433): a busy recipient holds it FIFO + we persist it, so the Lead's
      // cross-project dispatch survives a sender death / daemon restart before the recipient's next turn.
      // The sender is the Lead's own session id (threaded from the router) so an undelivered dispatch can be
      // surfaced back to it on resume; "platform" is a sentinel fallback if no caller id was provided.
      const r = this.enqueueDurableMessage(target.id, framed, { sender: senderSessionId ?? "platform", taskId: target.taskId ?? null });
      this.db.appendEvent({
        id: randomUUID(), ts: new Date().toISOString(),
        managerSessionId: "", workerSessionId: target.id, taskId: target.taskId ?? null, kind: "session_message",
      });
      return { deliveryStatus: this.deliveryStatusFor(r), position: r.position };
    };
    if (session.processState === "live") return deliverLive(session);

    // NOT LIVE: before boarding, resolve to the live end of the target's recycle lineage — the target may
    // simply have been recycled, with a successor already doing the work under a new session id.
    const successor = liveLineageSuccessor(this.db, sessionId);
    if (successor) return { ...deliverLive(successor), routedTo: successor.id };

    // No live successor anywhere in the lineage: board a durable note onto the target's project board
    // (mirrors platformEscalate's structured board task). The card is the durable source of truth, so the
    // message survives until someone reads it.
    const now = new Date().toISOString();
    const body = [
      "**Message from the Platform Lead** (boarded because the target session was not live).",
      "",
      `- **Target session:** \`${sessionId}\``,
      senderSessionId ? `- **From (Lead session):** \`${senderSessionId}\`` : "- **From:** Platform Lead",
      "",
      "## Message",
      "",
      text,
    ].join("\n");
    const task: Task = {
      id: randomUUID(),
      projectId: session.projectId,
      title: `[Platform message] for session ${sessionId.slice(0, 8)}`,
      body,
      // The target project's default-landing lane (role-resolved, matches platformEscalate's landing).
      columnKey: this.columnKeyForProjectRole(session.projectId, "defaultLanding") ?? "backlog",
      position: Date.now(),
      priority: DEFAULT_TASK_PRIORITY,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insertTask(task);
    this.db.appendEvent({
      id: randomUUID(), ts: now,
      managerSessionId: senderSessionId ?? "", workerSessionId: sessionId, taskId: task.id, kind: "session_message",
      detail: { boarded: true, projectId: session.projectId },
    });
    return { deliveryStatus: "boarded", taskId: task.id };
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
  ): { taskId: string; projectId: string; deliveryStatus: DeliveryStatus } {
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
      // The Platform home's default-landing lane (role-resolved, matches createProjectTask's landing).
      columnKey: this.columnKeyForProjectRole(home.id, "defaultLanding") ?? "backlog",
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
    // The board task is always created above, so the FLOOR is `boarded` (durably persisted, no live taker);
    // a live Lead upgrades it to `delivered-live` (idle, took the turn) or `queued` (busy, held FIFO).
    let deliveryStatus: DeliveryStatus = "boarded";
    const liveLead = this.db.listAllSessions().find((s) => s.role === "platform" && s.processState === "live");
    if (liveLead) {
      // Completion-escalation de-dup (card 5907b71e part 2): a "X COMPLETE + DEPLOYED" escalation naming a
      // SHA the Lead already saw via a recent `[loom:daemon-restarted]` deploy wake is a duplicate turn —
      // suppress the LIVE nudge (one completion = one turn). The durable board task above is ALWAYS filed,
      // so nothing is lost; deliveryStatus stays `boarded` (the Lead reads it as a board task). A SHA the
      // Lead has NOT seen is a legitimate, un-suppressed escalation (no regression).
      const escShas = extractCommitShas(`${input.title} ${input.detail}`);
      if (this.deployShaAlreadyDelivered(liveLead.id, escShas)) {
        // eslint-disable-next-line no-console
        console.log(`[escalation] suppressed live completion nudge to Lead ${liveLead.id} — SHA already delivered by a deploy restart (task ${task.id} still filed)`);
      } else {
        const note = `[loom:escalation] ${originName} manager escalated a Loom issue → Platform board task ${task.id}: ${input.title} (severity: ${severity})`;
        try { deliveryStatus = this.deliveryStatusFor(this.pty.enqueueStdin(liveLead.id, note)); } catch { /* Lead not live/ready — `boarded` stands */ }
      }
    }
    return { taskId: task.id, projectId: home.id, deliveryStatus };
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
  ): { taskId: string; projectId: string; deduped?: boolean } {
    const caller = this.db.getSession(auditorSessionId);
    if (!caller || caller.role !== "auditor") throw new Error("audit_file_finding is an auditor-only surface");
    // HARDCODED target: the reserved Platform home — never an arbitrary projectId from the Auditor.
    // NAME-SCOPED: resolve by PLATFORM_PROJECT_NAME, not a bare `.find(reserved)` — the ungated setup home
    // ("Getting Started") is also reserved now, so the name-agnostic lookup would mis-file the finding.
    const home = this.db.getReservedProjectByName(PLATFORM_PROJECT_NAME);
    if (!home) throw new Error("no reserved Loom Platform project exists — cannot file finding");

    // SERVER-SIDE DEDUPE (makes the trust-boundary "dedupe-guarded" claim TRUE, mirrors suggestPresetPrompt):
    // a finding whose NORMALIZED title already sits on the Platform board is a NO-OP — re-filing the same
    // issue every scheduled run can't spam the backlog (a hostile/looping transcript can't either). The
    // auditor doctrine still asks it to dedupe before filing; this is the structural backstop under it.
    const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
    const key = norm(input.title);
    const dup = this.db.listTasks(home.id).find((t) => norm(t.title) === key);
    if (dup) return { taskId: dup.id, projectId: home.id, deduped: true };

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
      // The Platform home's default-landing lane (role-resolved, matches platformEscalate's landing).
      columnKey: this.columnKeyForProjectRole(home.id, "defaultLanding") ?? "backlog",
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
   * END-USER Auditor improvement suggestion (loom-user-audit `audit_suggest_improvement`, End-User Platform
   * tier B3 — WRITE A) — the de-privileged, user-workspace twin of auditFileFinding. MIRRORS its shape but
   * files to the USER'S OWN reserved home — the "Getting Started" setup home (NAME-SCOPED via
   * getReservedProjectByName(SETUP_PROJECT_NAME)), NOT the dev "Loom Platform" home — onto its `inbox`
   * column with an `[Auditor]` title prefix, so a suggestion lands where the user already looks. The target
   * is HARDCODED server-side (the caller passes NO projectId), so this can never become a general
   * cross-project task-write and can never target Loom Platform or an arbitrary id. Caller-role check
   * (defense in depth — the tool is also workspace-auditor-gated at the router): refuses anything but a
   * "workspace-auditor" session. NO git/vault/config/spawn — that capability doesn't exist on this path.
   * SAFE when the reserved home is absent: returns {error} (no throw-crash of the surface) rather than
   * filing anywhere else. Returns {taskId, projectId, deliveryStatus} on a genuine file.
   *
   * HANDOFF (board card 5eb8438a — the owner's #1 complaint: the auditor could SUGGEST but never reach an
   * actor to ACTION its findings): after filing, it does a CONFINED best-effort live nudge to the user's
   * home operator (nudgeHomeOperator) — mirroring platformEscalate's Lead nudge. The board card is the
   * DURABLE source of truth, so the FLOOR is `boarded` (no live operator); a live operator upgrades it to
   * delivered-live/queued. This is NOT the generic harness SendMessage (which has no Loom routing — the
   * very reason the auditor's "message Platform" attempts failed "not addressable"); it can reach ONLY the
   * home operator, never arbitrary cross-session messaging.
   */
  workspaceAuditSuggest(
    auditorSessionId: string,
    input: { title: string; detail: string; severity?: string },
  ): { taskId: string; projectId: string; deliveryStatus: DeliveryStatus } | { error: string } {
    const caller = this.db.getSession(auditorSessionId);
    if (!caller || caller.role !== "workspace-auditor") return { error: "audit_suggest_improvement is a workspace-auditor-only surface" };
    // HARDCODED target: the user's OWN reserved "Getting Started" home — NAME-SCOPED so it is NEVER the dev
    // "Loom Platform" home and NEVER an arbitrary caller-supplied id. Absent home ⇒ no-op safely (the
    // surface stays alive; the suggestion is simply not filed).
    const home = this.db.getReservedProjectByName(SETUP_PROJECT_NAME);
    if (!home) return { error: "no reserved \"Platform\" home exists — cannot file the suggestion" };

    const severity = (input.severity ?? "").trim() || "unspecified";
    const now = new Date().toISOString();
    const body = [
      "**Filed by your Auditor** (read-mostly review of your own workspace — a suggestion to consider, never an auto-applied change).",
      "",
      `- **Severity:** ${severity}`,
      "",
      "## Suggested improvement / evidence",
      "",
      input.detail,
    ].join("\n");
    const task: Task = {
      id: randomUUID(),
      projectId: home.id,
      title: `[Auditor] ${input.title}`,
      body,
      // The user's home `intake` lane (role-resolved) — where they already triage, not a hidden backlog.
      // Falls back to the default-landing lane, then the literal "inbox", so a suggestion always lands.
      columnKey: this.columnKeyForProjectRole(home.id, "intake")
        ?? this.columnKeyForProjectRole(home.id, "defaultLanding") ?? "inbox",
      position: Date.now(),
      priority: DEFAULT_TASK_PRIORITY,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insertTask(task);
    // CONFINED best-effort live nudge to the user's home operator so a filed suggestion actually reaches an
    // actor (the owner's #1 complaint). The card above is durable, so this never loses the suggestion.
    const note = `[loom:from-auditor] new workspace suggestion on your home board — "${input.title}" — please review/apply`;
    const deliveryStatus = this.nudgeHomeOperator(note);
    this.db.appendEvent({
      id: randomUUID(), ts: now,
      managerSessionId: auditorSessionId, taskId: task.id, kind: "workspace_audit_suggestion",
      detail: { severity, homeProjectId: home.id, title: input.title, deliveryStatus },
    });
    return { taskId: task.id, projectId: home.id, deliveryStatus };
  }

  /**
   * END-USER Auditor explicit HANDOFF (loom-user-audit `audit_handoff`, board card 5eb8438a) — a CONFINED,
   * inert "I'm done filing, please review/apply the batch" nudge to the user's home operator. The auditor's
   * one outward signal: it carries NO arbitrary target and NO arbitrary payload — the target is server-
   * resolved (ONLY the live home operator) and the note is server-composed (a framed [loom:from-auditor]
   * heads-up). Best-effort + non-durable by design: the DURABLE record is the suggestion cards already on
   * the home board, so a missed nudge loses nothing (the FLOOR is `boarded`). Caller-role check (defense in
   * depth — the tool is also workspace-auditor-gated at the router): refuses anything but a "workspace-
   * auditor" session. Returns {deliveryStatus}.
   */
  workspaceAuditHandoff(
    auditorSessionId: string,
    input: { count?: number },
  ): { deliveryStatus: DeliveryStatus } | { error: string } {
    const caller = this.db.getSession(auditorSessionId);
    if (!caller || caller.role !== "workspace-auditor") return { error: "audit_handoff is a workspace-auditor-only surface" };
    const n = input.count !== undefined && Number.isFinite(input.count) && input.count > 0 ? Math.floor(input.count) : null;
    const summary = n ? `${n} workspace suggestion${n === 1 ? "" : "s"} on your home board` : "workspace suggestions on your home board";
    // 100% server-composed: count is a bounded integer only. NO caller-supplied free-form text reaches
    // the home operator's stdin — the workspace-auditor ingests untrusted, prompt-injectable transcripts,
    // so it is the LAST place to widen an injection path into another session's terminal.
    const note = `[loom:from-auditor] ${summary} — please review/apply`;
    return { deliveryStatus: this.nudgeHomeOperator(note) };
  }

  /**
   * The CONFINED messaging primitive behind both workspace-auditor handoffs (board card 5eb8438a). It can
   * reach EXACTLY ONE session: the LIVE operator of the user's OWN reserved "Getting Started" home (role
   * "setup" — the singleton Platform operator, SETUP_AGENT_NAME — IN that home, NAME-SCOPED so it is never
   * the dev "Loom Platform" Lead and never an arbitrary id). The caller passes NO target; this resolves it
   * server-side, so the auditor can never address any other session (no arbitrary cross-session messaging —
   * the load-bearing containment). Best-effort, mirroring platformEscalate's Lead nudge: returns `boarded`
   * if no home / no live operator (the suggestion cards are the durable inbox), else the live `enqueueStdin`
   * outcome classified (delivered-live | queued). NEVER throws.
   */
  private nudgeHomeOperator(note: string): DeliveryStatus {
    const home = this.db.getReservedProjectByName(SETUP_PROJECT_NAME);
    if (!home) return "boarded";
    const operator = this.db
      .listAllSessions()
      .find((s) => s.role === "setup" && s.projectId === home.id && s.processState === "live");
    if (!operator) return "boarded"; // no live operator — the cards sit on the now-visible home board
    try { return this.deliveryStatusFor(this.pty.enqueueStdin(operator.id, note)); }
    catch { return "boarded"; } // operator not ready/live — `boarded` stands
  }

  /**
   * Resolve the column KEY a lifecycle ROLE maps to on a project's board (role-resolved, never a
   * hardcoded key — task B). Looks up the project's resolved config and delegates to the shared
   * `columnKeyForRole` (which keeps the documented fallbacks: terminal→last column, defaultLanding→first
   * column, any other absent role→undefined). Returns undefined for an unknown project or an absent
   * non-required role, in which case the caller leaves the card in its current (valid) column — so a
   * board edit can never make a move orphan a card onto a non-existent key.
   */
  private columnKeyForProjectRole(projectId: string, role: ColumnRole): string | undefined {
    return columnKeyForRole(resolveConfig(this.db.getProject(projectId)?.config).kanbanColumns, role);
  }

  /**
   * Atomic safe board-column layout change (task B) — the NEW mutation behind the column editor (card C),
   * NOT the blind config PATCH. Diffs the DESIRED layout against the project's current resolved columns
   * (planColumnLayout, pure), HARD-rejects a guard violation (no defaultLanding/terminal, ≥1-column floor,
   * bad rename source, …), then executes the plan in ONE DB transaction (db.applyBoardColumnLayout):
   * renamed columns' cards follow old→new, removed columns' cards land in the desired defaultLanding lane,
   * and a backstop sweep + assertion guarantee NO task is left on a non-existent column. Soft warnings
   * (e.g. dropping a non-required role lane) are returned, not blocking. Returns the stored columns +
   * warnings on success, or {error} on a hard reject / unknown project.
   */
  updateBoardColumns(
    projectId: string, desired: DesiredColumn[],
  ): { ok: true; columns: KanbanColumn[]; warnings: string[] } | { ok: false; error: string } {
    const project = this.db.getProject(projectId);
    if (!project) return { ok: false, error: "project not found" };
    const current = resolveConfig(project.config).kanbanColumns;
    const plan = planColumnLayout(current, desired);
    if (!plan.ok || !plan.columns || !plan.rekeys || !plan.defaultLandingKey) {
      return { ok: false, error: plan.error ?? "invalid column layout" };
    }
    this.db.applyBoardColumnLayout(projectId, plan.columns, plan.rekeys, plan.defaultLandingKey);
    return { ok: true, columns: plan.columns, warnings: plan.warnings };
  }

  /**
   * Classify an `enqueueStdin` outcome into the DeliveryStatus enum (board card fc9a27d5). The host's
   * three return shapes map 1:1 to the live-routing cases — `{delivered:true}` (idle, submitted now),
   * `{delivered:false, position:N}` (live-but-busy/parked/not-ready, held FIFO), and `{delivered:false}`
   * with NO position (the pty isn't alive at all). The not-alive case is `boarded` here: every caller of
   * this helper persists a DURABLE record (a board task, or a worker_report event + wake trigger) before
   * relying on it, so "no live taker" still means "durably routed, surfaces later", never lost.
   */
  private deliveryStatusFor(r: { delivered: boolean; position?: number }): DeliveryStatus {
    if (r.delivered) return "delivered-live";
    if (r.position !== undefined) return "queued";
    return "boarded";
  }

  /**
   * Record that a `[loom:daemon-restarted]` wake delivered these deploy SHAs to a session (card 5907b71e
   * part 2). Called from resumeFleetOnBoot for every reason-bearing nudge, so a later completion escalation
   * naming the same SHA can be recognized as a turn the session already saw. Merges into an existing
   * non-stale window for the session; otherwise starts a fresh one. No-op for an empty SHA set. `nowMs`
   * is injectable for the hermetic test.
   */
  recordDeployShasDelivered(sessionId: string, shas: string[], nowMs: number = Date.now()): void {
    if (shas.length === 0) return;
    const entry = this.deployShaWindow.get(sessionId);
    if (entry && nowMs - entry.atMs < SessionService.SHA_DEDUP_TTL_MS) {
      for (const s of shas) entry.shas.add(s);
      entry.atMs = nowMs;
    } else {
      this.deployShaWindow.set(sessionId, { shas: new Set(shas), atMs: nowMs });
    }
  }

  /**
   * True iff a still-fresh `[loom:daemon-restarted]` wake already delivered ANY of these SHAs to the
   * session — i.e. a completion escalation for one of them would be a duplicate turn. Prunes (and reports
   * false for) a window past the TTL, so an old deploy can never suppress a genuinely new escalation.
   * `nowMs` is injectable for the hermetic test.
   */
  private deployShaAlreadyDelivered(sessionId: string, shas: string[], nowMs: number = Date.now()): boolean {
    if (shas.length === 0) return false;
    const entry = this.deployShaWindow.get(sessionId);
    if (!entry) return false;
    if (nowMs - entry.atMs >= SessionService.SHA_DEDUP_TTL_MS) { this.deployShaWindow.delete(sessionId); return false; }
    return shas.some((s) => entry.shas.has(s));
  }

  /**
   * Parked-parent wake (board card fc9a27d5, the live repro): a manager that idle_reported `waiting`
   * (→ idle policy `snoozed`) or `done`/`blocked_human` (→ `suppressed`) is SILENCED on the idle path —
   * the Asleep-at-the-Wheel watcher won't re-engage it until the snooze window elapses. So a fresh worker
   * report would otherwise only flip the derived `awaitingReview` flag and sit there until the manager
   * happened to poll. RE-ARM it ('watching', snooze cleared, unanswered 0) so the idle path wakes it
   * promptly to run the review→gate→merge it now has waiting — wiring the report into the SAME idle/wake
   * machinery the manager parked itself with. No-op for an already-`watching` (or missing) manager, so a
   * non-parked manager's byte-stream is unchanged. Pure DB + never throws (must not disturb the report).
   */
  private wakeParkedManagerOnReport(managerSessionId: string): void {
    try {
      const state = this.db.getIdleNudgeState(managerSessionId);
      if (state && state.policy !== "watching") this.db.resetIdleNudgeState(managerSessionId);
    } catch { /* never let the parked-wake disturb the report path */ }
  }

  /**
   * A worker reports to its manager (phase-2 §A3, the worker→manager direction). Moves the
   * worker's task by status, records the event, and notifies the manager via the busy-gated
   * queue — exactly the predecessor's role:notification semantics: if the manager is mid-turn the report
   * queues behind its running turn and drains on its next Stop. The caller IS the worker
   * (workerSessionId is derived server-side from the URL path), so there's no id to spoof.
   *
   * Returns a `deliveryStatus` enum (board card fc9a27d5) — `delivered-live` | `queued` | `boarded` |
   * `dropped` — so the worker (and any consumer) can tell a durable route from a genuine drop, replacing
   * the old ambiguous boolean `delivered`. It ALSO wakes a parked/snoozed manager (wakeParkedManagerOnReport)
   * so the report reaches it instead of only flagging awaitingReview.
   */
  async workerReport(
    workerSessionId: string,
    report: { status: "done" | "blocked" | "progress"; summary: string; prUrl?: string; needs?: string },
  ): Promise<{ reported: boolean; deliveryStatus: DeliveryStatus; refused?: boolean; error?: string; uncommittedFiles?: string[]; warning?: string; autoRetired?: boolean }> {
    const worker = this.db.getSession(workerSessionId);
    if (!worker) throw new Error("unknown worker session");
    const managerSessionId = worker.parentSessionId ?? null;
    const taskId = worker.taskId ?? null;

    // AUTO-RECOVERY RE-CONFIRMATION DEDUPE (card 289586c7): the crash-recovery resume nudge invites a
    // recovered worker to "call worker_report (done/blocked) if you had already finished" — so a worker
    // that crash-loops N times can call worker_report N times with BYTE-IDENTICAL content (incident:
    // worker a1c71a86 filed the SAME done report 3× after 3 auto-recovery resumes, each re-nudging the
    // manager). Collapse to the FIRST: if the LAST recorded worker_report for this task is identical to
    // THIS one, AND a session_resume_attempt happened in between (so this is a stale post-recovery
    // re-confirmation, not fresh work), ack it WITHOUT re-recording the event or re-nudging the manager.
    if (taskId) {
      const history = this.db.listEventsForWorker(workerSessionId);
      let lastReport: OrchestrationEvent | undefined;
      let resumedSince = false;
      for (let i = history.length - 1; i >= 0; i--) {
        const e = history[i]!;
        if (e.kind === "session_resume_attempt") resumedSince = true;
        else if (e.kind === "worker_report" && e.taskId === taskId) { lastReport = e; break; }
      }
      if (lastReport && resumedSince) {
        const d = lastReport.detail as { status?: string; summary?: string; prUrl?: string; needs?: string } | undefined;
        const identical =
          d?.status === report.status && d?.summary === report.summary &&
          (d?.prUrl ?? undefined) === report.prUrl && (d?.needs ?? undefined) === report.needs;
        if (identical) return { reported: true, deliveryStatus: "dropped" };
      }
    }

    // DONE PRE-CHECK (board card 907b9f50): catch a worker that forgot to commit AT THE SOURCE, before
    // its task is moved to review. The merge gate only ever sees COMMITTED work on the assigned branch,
    // so a "done" with uncommitted work otherwise bounces back a wasted round-trip later. INDEPENDENT of
    // — and composes with — the divergent-branch stranded backstop at the merge gate (reviewWorkerMerge /
    // confirmWorkerMerge). FAILS SAFE: precheckWorkerDone degrades to ALLOW on any git error, so a flaky
    // check can never wedge a legitimate done. Only the AFFIRMATIVE uncommitted signal refuses.
    let warning: string | undefined;
    // AUTO-RETIRE a declared no-commit worker (card 14434d6b): a read-only / no-commit worker (e.g. the
    // Code Reviewer rig, profile noCommit=true → pinned on the row) has NO merge step, so unlike a normal
    // worker — whose concurrency slot frees via worker_merge_confirm — its slot would only free on a manual
    // worker_stop. Set when this is a DECLARED no-commit role reporting done with 0 commits ahead (its
    // CORRECT contract), so we free its cap slot below + suppress the forgot-to-commit warning. Keyed
    // STRICTLY off the pinned noCommit flag (NOT name-matching, NOT "0 commits" alone): a NORMAL 0-commit
    // worker still gets the warning and is NEVER auto-retired — the forgot-to-commit safety net is intact.
    let autoRetireNoCommit = false;
    if (report.status === "done") {
      // PENDING-DIRECTION PRE-CHECK (board card dcb25bd9): REFUSE a done-report while the worker still has
      // UNRESOLVED manager direction queued. The real incident: a worker raced to `done` on a SUPERSEDED
      // design and committed it BEFORE consuming the manager's queued redirects — "finishing" the wrong
      // thing. We gate on MANAGER-origin direction only (detail.sender === the worker's own manager), read
      // from the durable `session_message_queued` events: origin-accurate, because watcher/system nudges go
      // out via the non-durable enqueue and never create these. A message held mid-turn is unresolved
      // precisely DURING the racing turn (it only resolves once the worker ends a turn and the FIFO drains),
      // so refusing here forces the worker to end its turn, drain the (coalesced) direction into its next
      // turn, act on it, THEN re-report. Mirrors the uncommitted-files refusal shape exactly (task NOT moved).
      if (managerSessionId) {
        const pending = this.db
          .listUnresolvedQueuedMessagesForWorker(workerSessionId)
          .filter((e) => e.detail?.sender === managerSessionId);
        if (pending.length > 0) {
          const error =
            `worker_report(done) REFUSED — you have ${pending.length} UNRESOLVED instruction(s) queued from your manager that you have NOT consumed yet. ` +
            `These may SUPERSEDE the work you're about to report (the incident this guards: a worker committed a superseded design before reading the manager's redirect). ` +
            `End this turn so the queued manager direction drains into your next turn, act on it, THEN re-report done. Your task stays in_progress.`;
          this.db.appendEvent({
            id: randomUUID(), ts: new Date().toISOString(),
            managerSessionId, workerSessionId, taskId, kind: "worker_report_rejected",
            detail: { reason: "pending-direction", queued: pending.length },
          });
          // `dropped`: nothing routed, the task was NOT moved (stays in_progress to drain + re-report).
          return { reported: false, refused: true, error, deliveryStatus: "dropped" };
        }
      }
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
          // `dropped`: nothing was routed and the task was NOT moved (it stays in_progress to re-report) —
          // there is no durable report to surface, so this is a genuine non-delivery, not a queue.
          return { reported: false, refused: true, error, uncommittedFiles: precheck.files, deliveryStatus: "dropped" };
        }
        if (precheck.zeroAhead) {
          if (worker.noCommit) {
            // DECLARED no-commit role (e.g. the Code Reviewer rig): 0 commits ahead is its CORRECT
            // contract (filesChanged:0), NOT a forgot-to-commit mistake. So (a) SUPPRESS the warning
            // entirely, and (b) flag the session for AUTO-RETIRE below — a read-only worker has no merge
            // step to free its concurrency slot, so without this its slot frees only on a manual
            // worker_stop. Conjoined with zeroAhead on purpose: a "no-commit" worker that DID produce
            // commits is treated like any normal worker (real work to merge — never auto-retired here).
            autoRetireNoCommit = true;
          } else {
            // WARN only: a clean worktree on an assigned branch with 0 commits ahead of base. A genuine
            // no-op task can legitimately report done, so this never refuses — it surfaces the warning in
            // the result, the worker_report event, and the manager notification. (The forgot-to-commit
            // safety net for a NORMAL worker — unchanged.)
            warning =
              `your assigned branch '${worker.branch}' is 0 commits ahead of base — nothing to merge. ` +
              `Allowing the done (a real no-op task can legitimately report done), but if you intended to produce changes you likely forgot to commit them.`;
          }
        }
      }
    }

    // Task move by status: done → the `review` lane (ready for the manager's diff review), blocked →
    // the `parked` lane, progress → no move. Role-resolved off the worker-project config (never the
    // hardcoded "review"/"waiting" keys); an absent lane leaves the card put (no orphaning move).
    if (taskId) {
      const role: ColumnRole | null = report.status === "done" ? "review" : report.status === "blocked" ? "parked" : null;
      const col = role ? this.columnKeyForProjectRole(worker.projectId, role) : undefined;
      if (col) this.db.updateTask(taskId, { columnKey: col });
    }

    this.db.appendEvent({
      id: randomUUID(), ts: new Date().toISOString(),
      managerSessionId: managerSessionId ?? "", workerSessionId, taskId, kind: "worker_report",
      detail: { status: report.status, summary: report.summary, prUrl: report.prUrl, needs: report.needs, ...(warning ? { warning } : {}) },
    });

    // No parent to route to (a parentless worker — practically impossible, but if it happens the report
    // reaches nobody and nothing will auto-resume a non-existent manager): a genuine `dropped`. The event
    // + task move above still stand as the audit trail; the status just tells the caller it wasn't routed.
    let deliveryStatus: DeliveryStatus = "dropped";
    if (managerSessionId) {
      let framed = `[loom:worker-report] worker ${workerSessionId} (task ${taskId ?? "none"}) — ${report.status}: ${report.summary}`;
      if (report.prUrl) framed += ` | PR: ${report.prUrl}`;
      if (report.needs) framed += ` | needs: ${report.needs}`;
      if (warning) framed += ` | warning: ${warning}`;
      if (autoRetireNoCommit) framed += ` | auto-retired (declared no-commit role, 0 commits ahead — its concurrency slot is freed, no worker_stop needed)`;
      const r = this.pty.enqueueStdin(managerSessionId, framed);
      deliveryStatus = this.deliveryStatusFor(r);
      // STRAND BACKSTOP (incident 22a44352, broadened by card fc9a27d5): if the report reached no LIVE
      // FIFO at all — `delivered:false` with NO queue position (the manager's pty isn't alive: it idle-
      // reaped after dispatching its last worker, or its pty is otherwise gone while the row lags `live`) —
      // the completed branch would sit unmerged with no consumer. Record the durable
      // `worker_report_undelivered` wake trigger so the crash-recovery watchdog bounded-auto-resumes the
      // manager to run review→gate→merge once its row is exited. A LIVE-but-busy/parked manager (`queued`,
      // position set) is NOT orphaned — its FIFO drains on the next turn — so we gate on `boarded` (no
      // position), NOT on the DB processState (which can lag the pty). recordUndeliveredReport's own guards
      // (recoverable+resumable role, not superseded, not usage-parked) keep it from firing where it
      // shouldn't. Best-effort + never throws: the report itself is already durably recorded above.
      if (deliveryStatus === "boarded") {
        const mgr = this.db.getSession(managerSessionId);
        if (mgr) {
          try { recordUndeliveredReport(this.db, mgr, { reportingWorkerId: workerSessionId, taskId }); }
          catch { /* never let the wake-trigger record disturb the report path */ }
        }
      }
      // PARKED-PARENT WAKE (card fc9a27d5): re-arm a snoozed/suppressed manager so the idle path wakes it
      // to review the work it now has waiting — instead of only flipping its derived awaitingReview flag.
      this.wakeParkedManagerOnReport(managerSessionId);
    }

    // AUTO-RETIRE the declared no-commit worker (card 14434d6b) — AFTER the report is durably recorded +
    // the manager notified, so none of that is lost. Free its concurrency slot the way a manual worker_stop
    // would: graceful-stop the pty AND immediately retire the DB row (processState exited + clear busy), so
    // the maxConcurrentWorkers count (which reads processState === "live") drops NOW, deterministically,
    // independent of the async onExit — exactly the sibling-retirement shape (retireSiblingSessionsForTask).
    // A stop_worker event records it (reason discriminates the auto-retire from a manual stop). The worktree
    // is RETAINED (identical to a manual worker_stop; boot-reconcile GCs a leaked one) — scope stays minimal.
    // Best-effort + never throws: the report above already stands; auto-retire must not disturb it.
    if (autoRetireNoCommit) {
      try {
        // Free the slot in the DB FIRST (the deterministic, cap-relevant retire — the cap reads
        // processState === "live"), record the event, THEN best-effort graceful-stop the pty. DB-first
        // ordering so a pty-stop hiccup can never leave the row stuck "live" with its slot still claimed.
        this.db.setProcessState(workerSessionId, "exited");
        this.db.setBusy(workerSessionId, false);
        this.db.appendEvent({
          id: randomUUID(), ts: new Date().toISOString(),
          managerSessionId: managerSessionId ?? "", workerSessionId, taskId, kind: "stop_worker",
          detail: { reason: "no-commit-auto-retire" },
        });
        this.pty.stop(workerSessionId, "graceful");
      } catch { /* never let auto-retire disturb the already-recorded report */ }
    }

    if (warning) return { reported: true, deliveryStatus, warning };
    if (autoRetireNoCommit) return { reported: true, deliveryStatus, autoRetired: true };
    return { reported: true, deliveryStatus };
  }

  /**
   * A manager PULLS its own inbound inbox: returns AND removes every queued (busy-gated, not-yet-
   * delivered) inbound message for the manager's OWN session. The manager's id is derived server-side
   * from the URL path (no id to spoof), so this only ever drains the caller's own queue. Manager-only —
   * mirrors recordIdleReport's role gate.
   *
   * WHY: a worker report enqueued while the manager is mid-turn sits in `live.pending` (delivered:false)
   * and otherwise drains on the next turn boundary via drainPending (coalesced — the whole queue lands as
   * one turn). A manager that has already handled the work proactively (it read each worker's transcript
   * directly) would then get those stale queued copies re-surfaced as a wasted turn. inbox_pull lets it
   * consume the whole inbox at once and discard/act as it
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
   *
   * SPURIOUS-NUDGE GUARD (card 6101d7f7): `redirectWorker` on a BUSY worker enqueues its redirect into
   * `live.pending` FIRST, then — in the SAME tick — clears busy and drains it. That clear fires this
   * method synchronously, BEFORE the drain hands the redirect over, so at this instant the worker looks
   * stranded even though it has authoritative direction about to land as its very next turn. If the
   * worker still has queued direction sitting in its pending FIFO, it is not stranded — skip the nudge.
   */
  notifyManagerOfIdleWorker(workerSessionId: string): void {
    const w = this.db.getSession(workerSessionId);
    if (!w || w.role !== "worker" || !w.parentSessionId || !w.taskId) return;
    if (this.pty.getPendingEntries(workerSessionId).length > 0) return; // direction queued, about to drain
    const task = this.db.getTask(w.taskId);
    // Still sitting in the `active` lane ⇒ hasn't reported (worker_report would have moved it out).
    const activeKey = this.columnKeyForProjectRole(w.projectId, "active");
    if (!task || task.columnKey !== activeKey) return; // reported done/blocked, already merged, or no active lane
    const msg = `[loom:worker-idle] worker ${workerSessionId} (task ${w.taskId}) finished a turn and is idle but did NOT call worker_report (its task is still in_progress). It may be done-but-unreported or stalled — pull it: worker_transcript ${workerSessionId} to see what it did, then worker_merge ${workerSessionId} to review, or worker_message it.`;
    try { this.pty.enqueueStdin(w.parentSessionId, msg); } catch { /* manager not live */ }
  }

  /**
   * Exited-without-report guard (board card 84151b99). A worker's ONLY channel up is worker_report's
   * push, and the idle nudge above (notifyManagerOfIdleWorker) fires on a busy→false EDGE — but a
   * fast/first worker can EXIT before that edge ever lands: a pty exit routes through the onExit hook,
   * NOT the onBusy callback, so notifyManagerOfIdleWorker is never called on exit. The manager — which
   * has no idle/exit signal for its children — would then see a silent idle (or nothing) and have to
   * self-rescue via worker_transcript (incident: a session, turns 80-86). Recurrence of the strand
   * family but a DISTINCT mechanism: no report fires AT ALL (vs. worker_report_undelivered, where a
   * report fired but reached an exited manager).
   *
   * Called from the pty onExit hook (index.ts), AFTER the row is marked `exited`. If an UNEXPECTEDLY-
   * exited worker (intended===false — NOT a manager-issued worker_stop/recycle/merge stop, which set the
   * pty's `stopping` flag) left its task STILL in_progress (worker_report would have moved it to
   * review/waiting), record a DISTINCT, DURABLE `worker_exited_without_report` event AND push a
   * [loom:worker-exited] nudge to the manager — the worker is GONE and will never report, so the manager
   * must review its branch or re-dispatch. No-op for non-workers, parentless/taskless sessions, an
   * intended stop, a recycled/superseded worker (its successor took over — intended), or a worker that
   * already reported (its task moved out of in_progress).
   *
   * CRASH-RECOVERY COORDINATION (card 289586c7): worker ∈ RECOVERABLE_ROLES, so the CrashRecoveryWatcher
   * may ALSO be about to auto-resume this exact exit — firing the definitive "will NOT come back,
   * re-dispatch" nudge here would be actively WRONG in that case and races the resume (incident: worker
   * a1c71a86 got the false nudge immediately before three auto-recovery re-confirmation worker_reports
   * from that SAME worker). So when the worker is still crash-recovery ELIGIBLE (isCrashRecoveryEligible),
   * this rewords to a provisional heads-up instead — the definitive "will NOT come back" nudge is left to
   * the watchdog itself, fired ONLY once it actually gives up (session_recovery_abandoned; see
   * crash-recovery-watcher's own pty.enqueueStdin at that point).
   */
  notifyManagerOfExitedWorker(workerSessionId: string, intended: boolean): void {
    if (intended) return; // a deliberate Loom stop() (worker_stop / recycle / merge-stop) — not a strand
    const w = this.db.getSession(workerSessionId);
    if (!w || w.role !== "worker" || !w.parentSessionId || !w.taskId) return;
    if (this.db.hasSuccessor(workerSessionId)) return; // recycled/superseded — its successor owns the task
    const task = this.db.getTask(w.taskId);
    // Still in the `active` lane ⇒ never reported (worker_report would have moved it out).
    const activeKey = this.columnKeyForProjectRole(w.projectId, "active");
    if (!task || task.columnKey !== activeKey) return; // already reported done/blocked, merged, or no active lane
    // DURABLE first: record the distinct event regardless of whether the manager is live to receive the
    // nudge — so it's auditable and not lost if the manager is mid-turn or momentarily down. Distinct
    // kind from both worker_report (a real report) and the in-memory [loom:worker-idle] nudge (which is
    // never recorded), so the manager (or a later boot scan) can tell "the worker is GONE" from "it's
    // just idle and may still be working".
    this.db.appendEvent({
      id: randomUUID(), ts: new Date().toISOString(),
      managerSessionId: w.parentSessionId, workerSessionId, taskId: w.taskId,
      kind: "worker_exited_without_report", detail: { branch: w.branch ?? null },
    });
    const eligible = isCrashRecoveryEligible(this.db, this.control, w);
    const msg = eligible
      ? `[loom:worker-exited] worker ${workerSessionId} (task ${w.taskId}) died unexpectedly — its task is still in_progress. Loom's crash-recovery watchdog will attempt to auto-resume it; no action needed yet. Its worktree/branch (${w.branch ?? "(unknown)"}) is intact — if recovery is later abandoned you'll get a follow-up nudge.`
      : `[loom:worker-exited] worker ${workerSessionId} (task ${w.taskId}) EXITED without ever calling worker_report — its task is still in_progress and it will NOT come back on its own. Any work it committed is on branch ${w.branch ?? "(unknown)"}. Pull it: worker_transcript ${workerSessionId} to see what it did, then worker_merge ${workerSessionId} to review/merge any committed work, or re-dispatch the task.`;
    try { this.pty.enqueueStdin(w.parentSessionId, msg); } catch { /* manager not live — the durable event stands */ }
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
    // FAIL SAFE before any teardown: a blank/whitespace handoff would close the predecessor (hard stop
    // below) and seed an empty successor — destroying the only carrier of intent. Reject up front, so the
    // old worker stays alive and the manager can re-issue a real handoff (mirrors recycleManager).
    if (!handoffSummary || !handoffSummary.trim()) throw new Error("handoffSummary must not be blank");
    const worktreePath = old.worktreePath ?? old.cwd; // worker cwd === its worktree
    const branch = old.branch ?? null;
    const taskId = old.taskId ?? null;
    const project = this.db.getProject(old.projectId);
    if (!project) throw new Error("project not found");
    const config = resolveConfig(project.config);
    const agent = this.db.getAgent(old.agentId); // the worker's agent — for its base brief in the handoff opening
    // Re-resolve the worker's spawn so the recycled successor keeps the profile's LAYERED allowlist +
    // model pin (the fresh-spawn paths thread these; recycle used to drop them to bare config.permission /
    // no model). Re-resolve from the agent rather than carrying old.* — the agent is already in scope and
    // a profile edit between generations is picked up, no session-row schema migration needed. Agent-missing
    // (deleted) ⇒ bare config.permission + no model, mirroring the resume fallback.
    const workerSpawn = agent ? this.resolveAgentSpawn(agent, config, "worker") : undefined;
    const newGen = (old.gen ?? 0) + 1;

    this.db.appendEvent({
      id: randomUUID(), ts: new Date().toISOString(),
      managerSessionId, workerSessionId, taskId, kind: "recycle_begin",
    });

    // Carry the old worker's in-flight inbound queue (manager messages held while it was busy) onto
    // the fresh worker — same task + worktree, so they're still valid. FLUSH it (not getPending) NOW,
    // while the old pty is still alive, so each entry's source + durable onDeliver come with it (the old
    // pty's queue, and any text-only snapshot of it, dies on exit). The durable records are re-driven onto
    // the fresh worker below — see carryPendingToSuccessor. Wakes are moved below too.
    const carried = this.pty.flushPending(workerSessionId);
    const carriedDurable = this.db.listUnresolvedQueuedMessagesForWorker(workerSessionId);
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
    // SIBLING SWEEP (incident 35fc823f): the fresh successor reuses this SAME worktree, so retire any OTHER
    // live session bound to the task before respawning — else a stray sibling would run concurrently with
    // the successor on the shared worktree/branch (the zombie end of the 2-workers-on-one-branch bug). The
    // keep is the old worker being recycled (just hard-stopped above). No-op when there are no siblings.
    await this.retireSiblingSessionsForTask(taskId, workerSessionId);

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
      documentConversion: old.documentConversion ?? false, // a recycled document worker keeps its conversion capability
      restrictedTools: old.restrictedTools ?? false, // a recycled worker keeps its restricted-tools disallow
      noCommit: old.noCommit ?? false, // a recycled reviewer keeps its declared no-commit role
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
      permission: workerSpawn?.permission ?? config.permission, // re-resolved layered allowlist (was bare config.permission)
      geometry: config.pty,
      sessionEnv: config.sessionEnv,
      vaultPath: config.docLint ? project.vaultPath : undefined, // Pillar D: scope the vault-lint hook
      // Lead with the worktree LOCATION block (same worktree — a recycled worker is equally at risk of
      // leaking edits to the main checkout), then the worker's agent base brief, then the handoff
      // (mirrors spawnWorker + the manager recycle warm-up). Empty brief ⇒ the block + handoff.
      startupPrompt: composeWorkerStartupPrompt(agent?.startupPrompt, framed, worktreePath),
      role: "worker",
      browserTesting: old.browserTesting ?? false,
      documentConversion: old.documentConversion ?? false,
      restrictedTools: old.restrictedTools ?? false, // carry the restricted-tools disallow forward across recycle
      model: workerSpawn?.model, // re-resolved profile model pin (undefined if agent gone ⇒ no `--model`); was dropped
      skills: old.skills ?? null, // carry the pinned skill subset forward across recycle (null ⇒ all)
    });
    // Hand the carried queue + scheduled wakes to the successor: re-point the old worker's wakes (so a
    // due wake can't resurrect the retired worker) and re-drive the held messages onto the fresh worker
    // (busy-gated; they drain on its first turn boundary, after its handoff turn).
    this.db.reparentWakes(workerSessionId, fresh.id);
    this.carryPendingToSuccessor(workerSessionId, fresh.id, carried, carriedDurable);
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
    // FAIL SAFE before any teardown/spawn: a blank/whitespace continuation would seed an empty successor
    // and (via the deferred stop below) retire the predecessor — losing the handoff entirely. Reject up
    // front so the predecessor stays live and the manager can re-issue a real continuation.
    if (!continuationPrompt || !continuationPrompt.trim()) throw new Error("continuationPrompt must not be blank");
    const agent = this.db.getAgent(old.agentId);
    const project = this.db.getProject(old.projectId);
    if (!project) throw new Error("project not found");
    const config = resolveConfig(project.config);
    // Re-resolve the manager's spawn so the recycled successor keeps the profile's LAYERED allowlist +
    // model pin (mirrors recycleWorker; recycle used to drop them to bare config.permission / no model).
    // Agent-missing ⇒ bare config.permission + no model.
    const managerSpawn = agent ? this.resolveAgentSpawn(agent, config, "manager") : undefined;
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
      documentConversion: old.documentConversion ?? false, // carry the capability forward (managers rarely set it)
      restrictedTools: old.restrictedTools ?? false, // carry the restricted-tools disallow forward
      noCommit: old.noCommit ?? false, // carry the declared no-commit role forward
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
      permission: managerSpawn?.permission ?? config.permission, // re-resolved layered allowlist (was bare config.permission)
      geometry: config.pty,
      sessionEnv: config.sessionEnv,
      vaultPath: config.docLint ? project.vaultPath : undefined, // Pillar D: scope the vault-lint hook
      startupPrompt,
      role: "manager", // successor keeps the orchestration surface
      browserTesting: old.browserTesting ?? false,
      documentConversion: old.documentConversion ?? false,
      restrictedTools: old.restrictedTools ?? false, // carry the restricted-tools disallow forward across recycle
      model: managerSpawn?.model, // re-resolved profile model pin (undefined if agent gone ⇒ no `--model`); was dropped
      skills: old.skills ?? null, // carry the pinned skill subset forward across recycle (null ⇒ all)
    });

    // Re-parent live workers onto the successor BEFORE closing the old manager, so they're never
    // orphaned (worker_report routes by parent_session_id; the successor sees them via worker_list).
    const reparented = this.db.reparentLiveWorkers(oldManagerId, fresh.id);
    // Carry the old manager's scheduled wakes + its in-flight inbound queue (worker reports / human
    // turns held while it was busy, plus any durable cross-tree platform message) onto the successor — it
    // owns the fleet now, so these are its to handle. Re-pointing the wakes also guarantees nothing fires
    // at the retired manager (which would zombie-resurrect it). FLUSH the queue (not getPending) while the
    // old pty is still alive (its 3s deferred stop is below) so each entry's source + durable onDeliver
    // come with it; durable records are re-minted onto the successor — see carryPendingToSuccessor.
    this.db.reparentWakes(oldManagerId, fresh.id);
    const carried = this.pty.flushPending(oldManagerId);
    const carriedDurable = this.db.listUnresolvedQueuedMessagesForWorker(oldManagerId);
    this.carryPendingToSuccessor(oldManagerId, fresh.id, carried, carriedDurable);

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
   * Recycle the PLATFORM LEAD near its context limit (the platform-surface `recycle_me` flow) — the
   * platform analogue of recycleManager. The Lead has already run /session-end and written
   * `continuationPrompt`; Loom boots a FRESH successor Lead seeded with the agent warm-up + that
   * continuation (NOT --resume — fresh context, intent carried), carries the predecessor's wakes +
   * in-flight inbound queue onto it, then closes the predecessor (deferred, so this call's tool
   * response flushes first). gen+1; recycledFrom = old. There is NO worker re-parenting: the Lead's
   * spawned sessions are independent (not parented to it), unlike a manager's workers.
   *
   * PER-LINEAGE REPLACEMENT (1 recycle → 1 successor, NOT a global singleton). Multiple live Leads may
   * coexist (startPlatformLead is create-only); recycle replaces ONLY the calling Lead's lineage. The
   * predecessor is ITSELF a LIVE platform session, so we retire it in the DB *BEFORE* the successor is
   * marked live and run retire → insert → flip-live SYNCHRONOUSLY with NO await between. This keeps the
   * transition atomic on Node's single-threaded loop — the predecessor and its successor are never both
   * live at once (no double-counted lineage, no zombie) — even though OTHER unrelated Leads stay live
   * throughout. The predecessor's pty is then hard-stopped on a 3s defer (response-flush); because the
   * successor carries `recycledFrom = old.id`, `hasSuccessor(old.id)` is true, so the crash-recovery
   * watchdog never resurrects the retired predecessor (recordUnexpectedExit + the tick both skip a
   * superseded session) — no orphan, no zombie.
   *
   * This is one of two sanctioned paths that spawn a platform session (the other is the human-REST
   * startPlatformLead): it is reachable ONLY by an existing platform Lead (the platform MCP router gates
   * role === "platform", and this method re-asserts old.role === "platform"), and it mints exactly one
   * successor of the same role. session_spawn still refuses role "platform" — no general agent-facing
   * platform-spawn path is opened.
   */
  async recyclePlatformLead(oldLeadId: string, continuationPrompt: string): Promise<Session> {
    const old = this.db.getSession(oldLeadId);
    if (!old || old.role !== "platform") throw new Error("not a platform session");
    // FAIL SAFE before any teardown/spawn: a blank/whitespace continuation would seed an empty
    // successor and (via the deferred stop below) retire the predecessor — losing the handoff. Reject
    // up front so the predecessor stays live and the Lead can re-issue a real continuation (mirrors
    // recycleManager).
    if (!continuationPrompt || !continuationPrompt.trim()) throw new Error("continuationPrompt must not be blank");
    // IDEMPOTENCY / anti-double-recycle: a Lead may be recycled at MOST once. A SECOND recycle_me on the
    // same predecessor (e.g. a double tool-call in one turn) would retire the already-exited predecessor
    // again and spawn a SECOND successor for the SAME lineage (a duplicate, not just another Lead). Refuse
    // if a successor already exists (mirrors resume()'s superseded-session refusal). The whole pre-spawn
    // block runs synchronously, so this check + the retire/spawn below are one atomic guard on the event loop.
    if (this.db.hasSuccessor(oldLeadId)) throw new Error("this Lead has already been recycled — its successor is live");
    const agent = this.db.getAgent(old.agentId);
    const project = this.db.getProject(old.projectId);
    if (!project) throw new Error("project not found");
    const config = resolveConfig(project.config);
    // Re-resolve the Lead's spawn so the successor keeps the profile's LAYERED allowlist + model pin
    // (mirrors recycleManager). Agent-missing ⇒ bare config.permission + no model.
    const leadSpawn = agent ? this.resolveAgentSpawn(agent, config, "platform") : undefined;
    const newGen = (old.gen ?? 0) + 1;

    this.db.appendEvent({
      id: randomUUID(), ts: new Date().toISOString(),
      managerSessionId: oldLeadId, kind: "recycle_begin", detail: { kind: "platform", gen: newGen },
    });

    const warmup = agent?.startupPrompt?.trim();
    const continuation =
      (warmup ? warmup + "\n\n---\n" : "") +
      `[loom:continuation] You are the successor to a previous Platform Lead session that recycled as it neared its ` +
      `context limit. Continue its cross-project work from this handoff — read your living resume doc + the platform ` +
      `board to re-orient (a normal pickup). Predecessor's handoff:\n\n${continuationPrompt}`;
    // Card 2fed1663: the successor inherits its PREDECESSOR's lineage (walk old's recycledFrom chain to
    // the root), so it resolves to the SAME resume-doc path the lineage has always used — never a fresh
    // one, and never another lineage's file.
    const leadResumeDocPath = resolvePlatformLeadResumeDocPath(this.db, project.vaultPath, lineageRootId(this.db, old));
    const startupPrompt = composePlatformLeadStartupPrompt(continuation, leadResumeDocPath);

    const now = new Date().toISOString();
    const fresh: Session = {
      id: randomUUID(),
      projectId: old.projectId,
      agentId: old.agentId,
      engineSessionId: null,
      title: null,
      cwd: old.cwd, // the Lead works in the platform-home repo (same cwd)
      processState: "starting",
      resumability: "unknown",
      busy: false,
      createdAt: now,
      lastActivity: now,
      lastError: null,
      role: "platform", // successor keeps the elevated platform surface
      browserTesting: old.browserTesting ?? false,
      documentConversion: old.documentConversion ?? false,
      restrictedTools: old.restrictedTools ?? false, // carry the restricted-tools disallow forward
      noCommit: old.noCommit ?? false, // carry the declared no-commit role forward
      skills: old.skills ?? null, // carry the pinned skill subset forward (null ⇒ all)
      gen: newGen,
      recycledFrom: old.id,
    };

    // === ATOMIC LINEAGE HANDOFF (synchronous — NO await) — predecessor + successor never both live. ===
    // Retire the predecessor in the DB FIRST, THEN insert + flip the successor live. With no await between,
    // no concurrent watcher tick can interleave to observe BOTH rows of this lineage live at once (the
    // crash-recovery/superseded checks key off this). Other unrelated Leads stay live throughout — this is
    // a per-lineage replacement, not a global singleton.
    this.db.setProcessState(old.id, "exited");
    this.db.insertSession(fresh);
    // M5: flip to live BEFORE wiring the pty so a fast-failing spawn's onExit ('exited') always wins.
    this.db.setProcessState(fresh.id, "live");
    this.pty.spawn({
      sessionId: fresh.id,
      cwd: fresh.cwd,
      permission: leadSpawn?.permission ?? config.permission, // re-resolved layered allowlist
      geometry: config.pty,
      sessionEnv: config.sessionEnv,
      vaultPath: config.docLint ? project.vaultPath : undefined, // Pillar D: scope the vault-lint hook
      startupPrompt,
      role: "platform", // successor keeps the platform surface
      browserTesting: old.browserTesting ?? false,
      documentConversion: old.documentConversion ?? false,
      restrictedTools: old.restrictedTools ?? false, // carry the restricted-tools disallow forward across recycle
      model: leadSpawn?.model, // re-resolved profile model pin (undefined if agent gone ⇒ no `--model`)
      skills: old.skills ?? null, // carry the pinned skill subset forward across recycle (null ⇒ all)
    });
    // === END ATOMIC LINEAGE HANDOFF ===============================================================

    // Carry the predecessor's scheduled wakes + in-flight inbound queue (durable cross-tree platform
    // messages + held human turns) onto the successor — it owns the platform now. Re-pointing the wakes
    // also guarantees nothing fires at the retired predecessor (which would zombie-resurrect it). FLUSH
    // the queue while the old pty is still alive (its 3s deferred stop is below) so each entry's source
    // + durable onDeliver come with it; durable records are re-minted onto the successor — see
    // carryPendingToSuccessor. Mirrors recycleManager, minus the worker re-parent (the Lead has none).
    this.db.reparentWakes(oldLeadId, fresh.id);
    const carried = this.pty.flushPending(oldLeadId);
    const carriedDurable = this.db.listUnresolvedQueuedMessagesForWorker(oldLeadId);
    this.carryPendingToSuccessor(oldLeadId, fresh.id, carried, carriedDurable);

    this.db.appendEvent({
      id: randomUUID(), ts: new Date().toISOString(),
      managerSessionId: fresh.id, kind: "recycle_complete",
      detail: { kind: "platform", recycledFrom: old.id, gen: newGen },
    });

    // Close the predecessor AFTER a short delay so the recycle_me tool response (the old Lead's own MCP
    // call) flushes before its pty is killed. Its row is already `exited` (above), so this only tears
    // down the lingering pty; hasSuccessor(old.id) keeps crash-recovery from resurrecting it.
    setTimeout(() => { try { this.pty.stop(oldLeadId, "hard"); } catch { /* already gone */ } }, 3000);

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

  /**
   * The OWN-PROJECT containment boundary for every manager self-service write. A manager's self-service
   * tools (project_update/_archive, agent_update/_assign_profile, schedule_create/_update) take a target
   * id as a param; without this guard a prompt-injected/confused manager could reconfigure or archive ANY
   * project — including the reserved Loom Platform home — breaking the documented invariant that
   * platform_escalate is the manager's ONE cross-project write. Each method derives the target's project
   * via this helper and REJECTS a target outside the caller's own project. Throws (→ the router's error
   * envelope) on a session with no project, so a write can never escape its scope.
   */
  private requireOwnProject(managerSessionId: string, targetProjectId: string | undefined, surface: string): void {
    const own = this.db.getSession(managerSessionId)?.projectId;
    if (!own) throw new Error("no project for this session");
    if (targetProjectId !== own) throw new Error(`${surface}: target is outside your project`);
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
    this.requireOwnProject(managerSessionId, agent.projectId, "agent_assign_profile");
    if (profileId != null && !this.db.getProfile(profileId)) throw new Error("profile not found");
    this.db.updateAgent(agentId, { profileId });
    this.auditManage(managerSessionId, "agent_assign_profile", { agentId, profileId });
    return this.db.getAgent(agentId)!;
  }

  /**
   * Update an agent's structural fields — its name (title) and/or startupPrompt (the injected
   * project-specifics). Capability-conferring fields (the profile) are NOT settable here; profile
   * assignment is the separate, validated assignAgentProfile path.
   *
   * `startupPrompt` REPLACES the whole prompt (the original contract, unchanged). `appendToStartupPrompt`
   * is the additive alternative (GAP 1): it CONCATENATES onto the agent's EXISTING prompt (joined with a
   * blank line — or used bare when the existing prompt is empty) so a manager never has to round-trip the
   * full text for a small addition. Passing BOTH is rejected — mutually exclusive, checked before any write.
   */
  updateAgentPreset(
    managerSessionId: string, agentId: string,
    patch: { name?: string; startupPrompt?: string; appendToStartupPrompt?: string },
  ): Agent {
    this.requireManager(managerSessionId, "agent_update");
    const agent = this.db.getAgent(agentId);
    if (!agent) throw new Error("agent not found");
    this.requireOwnProject(managerSessionId, agent.projectId, "agent_update");
    if (patch.startupPrompt !== undefined && patch.appendToStartupPrompt !== undefined) {
      throw new Error("agent_update: pass startupPrompt (full replace) OR appendToStartupPrompt (append), not both");
    }
    const startupPrompt = patch.appendToStartupPrompt !== undefined
      ? (agent.startupPrompt ? `${agent.startupPrompt}\n\n${patch.appendToStartupPrompt}` : patch.appendToStartupPrompt)
      : patch.startupPrompt;
    this.db.updateAgent(agentId, { name: patch.name, startupPrompt });
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
    this.requireOwnProject(managerSessionId, projectId, "project_update");
    const project = this.db.getProject(projectId);
    if (!project) throw new Error("project not found");
    if (patch.config !== undefined) {
      const v = validateAgentProjectConfigOverride(patch.config);
      if (!v.ok) throw new Error(`invalid config: ${v.error}`);
      // SAFE writer (not a blind setProjectConfig): a kanbanColumns key-set change re-keys orphaned cards
      // to the landing lane instead of orphaning them on a non-existent column; a non-column patch stays
      // byte-identical to the blind path. (tasks/columns.ts — mirrors the platform/REST config-PATCH path.)
      const wrote = setProjectConfigSafe(this.db, projectId, v.value);
      if (!wrote.ok) throw new Error(wrote.error);
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
    this.requireOwnProject(managerSessionId, projectId, "project_archive");
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
    const targetAgent = this.db.getAgent(input.agentId);
    if (!targetAgent) throw new Error("agent not found");
    this.requireOwnProject(managerSessionId, targetAgent.projectId, "schedule_create");
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
    const schedule = this.db.getSchedule(scheduleId);
    if (!schedule) throw new Error("schedule not found");
    // Resolve the schedule → its agent → that agent's project; reject a schedule outside the caller's
    // project (a missing agent can never match own, so it's rejected too).
    this.requireOwnProject(managerSessionId, this.db.getAgent(schedule.agentId)?.projectId, "schedule_update");
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
   * Did this worker REPORT work complete/changes (a `worker_report` done|blocked)? The merge gate uses
   * this to tell the orphaned-commit-to-main case (0-ahead branch WHILE the worker claimed work) from a
   * genuine empty no-op (0-ahead, never reported). Reads the MOST-RECENT `worker_report` event, skipping
   * the `merge_request`/other events reviewWorkerMerge appends AFTER the report (so it isn't fooled by a
   * non-report latest event); a trailing `progress` report is not a completion claim → null. FAILS SAFE
   * to null on any read error (treated as "not reported" → the soft no-op path, never a false hard error).
   */
  private workerReportedComplete(workerSessionId: string): "done" | "blocked" | null {
    try {
      const events = this.db.listEventsForWorker(workerSessionId);
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i]!.kind !== "worker_report") continue;
        const status = events[i]!.detail?.status as string | undefined;
        return status === "done" || status === "blocked" ? status : null;
      }
    } catch { /* no events / read error → treat as not reported */ }
    return null;
  }

  /**
   * Step 2: run the build/DoD gate, and ONLY if green merge the branch as ONE squash commit, remove the
   * worktree, and move the task to done. FAIL-CLOSED — a failed gate or a merge conflict leaves
   * the canonical repo UNTOUCHED and the worktree RETAINED (so the manager can re-task a fix).
   * Merge is daemon-executed; workers have no merge tool.
   *
   * IDEMPOTENT (board card 2eddf573): the staged set is re-derived inside {@link mergeBranch} at confirm
   * time (never trusted from the review-step snapshot), so a stale-index "nothing staged" on a valid
   * +N-commit branch no longer happens — the merge lands on the FIRST call. When there is GENUINELY
   * nothing to stage, the result is DISTINGUISHABLE via `emptyKind`:
   *   - `ALREADY_MERGED`   — the branch already landed in main → treated as a successful idempotent
   *                          completion: the worktree is retired and the task finished (`merged:true`).
   *   - `STAGE_EMPTY_RETRY` — no diff to merge → fail-closed (`merged:false`), worktree RETAINED so the
   *                          manager can investigate why the worker produced no change. SPLIT by whether the
   *                          worker REPORTED work (PL Auditor finding #2, card 1550eb87): a 0-ahead branch
   *                          WHILE the worker reported done/blocked is the orphaned-commit-to-main signature
   *                          (the reported work landed on main, not the branch; a later sync can orphan it) →
   *                          HARD error (`hardError:true`, `reportedState`), loud refusal so the manager
   *                          recovers the commit. A 0-ahead branch with NO report stays the gentle soft retry.
   */
  async confirmWorkerMerge(
    managerSessionId: string, workerSessionId: string,
  ): Promise<{ merged: boolean; reason?: string; emptyKind?: MergeEmptyKind; hardError?: boolean; reportedState?: "done" | "blocked" }> {
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
    // GENUINE no-op (nothing staged): the staged set was re-derived from a clean index, so this is NOT a
    // stale-state false negative — it is a true empty merge. Distinguish the two kinds for the manager:
    if (merge.noop) {
      if (merge.emptyKind === "STAGE_EMPTY_RETRY") {
        // No diff to merge. SPLIT on whether the worker REPORTED work (PL Auditor finding #2, card
        // 1550eb87 — silent work loss). A 0-ahead assigned branch WHILE the worker reported done/blocked
        // is the orphaned-commit-to-main signature: the reported work was committed somewhere OTHER than
        // the branch (almost always straight to main — incident: commit 28ae791), so the branch is empty
        // and a later main sync can ORPHAN that commit and lose it silently. That is a HARD error — a loud
        // refusal requiring the manager to recover the commit, NOT the soft pass-through that let the
        // orphaned done sail through before.
        const reported = this.workerReportedComplete(workerSessionId);
        if (reported) {
          evt("merge_rejected", { reason: "orphaned_zero_ahead", reportedState: reported });
          rejectNotify(`[loom:merge-rejected] worker ${workerSessionId} (task ${taskId ?? "none"}) — ORPHANED WORK (HARD): your worker REPORTED ${reported} but its assigned branch '${branch}' is 0 commits ahead of main — there is NOTHING on the branch to merge. The reported work was almost certainly committed to MAIN directly (or another branch); a later main sync can ORPHAN it and lose it silently. Refusing the empty merge. RECOVER it: 'git --no-pager log main' to find the commit, cherry-pick it onto '${branch}', then re-confirm — or if the report was mistaken, re-task. (Workers must NEVER commit to main — commit only to the assigned branch.)`);
          return {
            merged: false,
            reason: `orphaned work: assigned branch '${branch}' is 0 commits ahead of main but the worker reported ${reported} — the committed work is not on the branch (likely committed straight to main); recover the commit onto '${branch}' before merging`,
            emptyKind: "STAGE_EMPTY_RETRY",
            hardError: true,
            reportedState: reported,
          };
        }
        // No report of work → a genuine empty no-op. Fail-closed (worktree retained so the manager can see
        // why the worker produced no change, task stays in review) but soft — no alarm.
        evt("merge_rejected", { reason: "stage_empty" });
        rejectNotify(`[loom:merge-rejected] worker ${workerSessionId} (task ${taskId ?? "none"}) — STAGE_EMPTY_RETRY: the branch has no diff to merge; canonical repo + worktree untouched. The worker committed nothing that differs from main — re-task or close the task by hand.`);
        return { merged: false, reason: "no diff to merge (STAGE_EMPTY_RETRY)", emptyKind: "STAGE_EMPTY_RETRY" };
      }
      // ALREADY_MERGED: the branch's work is already in main (a prior squash with its trailer). Finish the
      // bookkeeping idempotently — retire the worktree + mark the task done — and report it distinguishably.
      rejectNotify(`[loom:already-merged] worker ${workerSessionId} (task ${taskId ?? "none"}) — ALREADY_MERGED: the branch's work was already in main; finishing the worktree cleanup + task without a new commit.`);
      this.pty.stop(workerSessionId, "hard");
      for (let i = 0; i < 50 && this.pty.isAlive(workerSessionId); i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      await this.finalizeMerge({ managerSessionId, workerSessionId, taskId, worktreePath, branch, repoPath: project.repoPath });
      return { merged: true, emptyKind: "ALREADY_MERGED" };
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
   * Sibling-retirement sweep — the DEFENSIVE guard at the OTHER end of the 2-workers-on-one-branch
   * incident (35fc823f). The spawn-race that could CREATE a second live session on one task/worktree is
   * fixed UPSTREAM (the atomic per-taskId claim in spawnWorker); this is belt-and-suspenders at retirement
   * time. Before a task's shared worktree is REMOVED (confirmWorkerMerge → finalizeMerge) or REUSED
   * (recycleWorker), graceful-stop and retire EVERY OTHER live session bound to the task, so none is left
   * running ("zombie") in a now-deleted / repurposed cwd.
   *
   * `keepSessionId` is the session being merged/recycled — it is EXCLUDED (its own hard-stop handles it).
   * For each sibling: graceful-stop the pty AND retire its DB row IMMEDIATELY (setProcessState exited +
   * clear busy) — mirroring recycleManager's explicit predecessor retirement, so the row never lingers
   * 'live' pointing at a path that's about to vanish, independent of the async onExit. Then wait (bounded,
   * mirroring the primary worker hard-stop wait) for any live sibling pty to actually die, so the caller's
   * removeWorktree isn't blocked by a live process's cwd handle on Windows. Best-effort + idempotent:
   * a no-op when the task has no siblings (the normal single-worker case), pty.stop is a no-op on a row
   * with no live pty, and setProcessState/setBusy are idempotent. taskId null ⇒ nothing to enumerate.
   */
  private async retireSiblingSessionsForTask(taskId: string | null, keepSessionId: string): Promise<void> {
    if (!taskId) return;
    const siblings = this.db.listLiveSessionsForTask(taskId).filter((s) => s.id !== keepSessionId);
    if (siblings.length === 0) return;
    for (const sib of siblings) {
      // eslint-disable-next-line no-console
      console.warn(`[sibling-sweep] retiring stray live session ${sib.id} bound to task ${taskId} (keeping ${keepSessionId}) before its shared worktree is removed/reused — zombie guard (incident 35fc823f)`);
      this.pty.stop(sib.id, "graceful");
      this.db.setProcessState(sib.id, "exited");
      this.db.setBusy(sib.id, false);
    }
    for (let i = 0; i < 50 && siblings.some((s) => this.pty.isAlive(s.id)); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
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
    // SIBLING SWEEP first (incident 35fc823f): retire any OTHER live session bound to this task before the
    // worktree is removed, so no zombie is left running in the about-to-be-deleted cwd. The keep is the
    // worker being merged (already hard-stopped by the caller). Covers BOTH confirmWorkerMerge paths
    // (ALREADY_MERGED + Green) here once, so they can't drift; at boot-reconcile it's a no-op (recoverStale-
    // Sessions has already marked prior-run ptys exited, so the task has no live siblings).
    await this.retireSiblingSessionsForTask(args.taskId, args.workerSessionId);
    try {
      await removeWorktree(args.repoPath, args.worktreePath, { timeoutMs: this.gitOpMs });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[finalizeMerge] could not remove worktree ${args.worktreePath} (dir busy?); ` +
        `merge already landed — finishing bookkeeping, boot-reconcile Pass B will GC the dir: ${(e as Error).message}`);
    }
    // Terminal bookkeeping BEFORE the destructive deleteBranch (see the ORDER IS CRASH-CRITICAL note).
    // Land the task in the `terminal` lane (role-resolved off its project, last-column fallback) — not the
    // hardcoded "done" key. A merge always has a terminal lane (the role is required + falls back to last).
    if (args.taskId) {
      const task = this.db.getTask(args.taskId);
      const terminalKey = task ? this.columnKeyForProjectRole(task.projectId, "terminal") : undefined;
      if (terminalKey) this.db.updateTask(args.taskId, { columnKey: terminalKey });
    }
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
        const terminalKey = this.columnKeyForProjectRole(s.projectId, "terminal");
        const taskDone = this.db.getTask(s.taskId)?.columnKey === terminalKey;
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
      const terminalKey = this.columnKeyForProjectRole(s.projectId, "terminal");
      if (this.db.getTask(s.taskId)?.columnKey !== terminalKey) continue; // not a demonstrably-landed merge
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
      if (await worktreeHasWork(project.repoPath, worktreePath, s.branch ?? null, "HEAD", { timeoutMs: this.gitOpMs })) {
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
