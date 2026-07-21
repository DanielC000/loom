import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { Ajv } from "ajv";
import {
  resolveConfig, resolveProfile, columnKeyForRole, DEFAULT_TASK_PRIORITY,
  type Session, type StopMode, type OrchestrationEvent, type Task,
  type Agent, type SessionRole, type ResolvedConfig, type PermissionPolicy, type Schedule,
  type AgentRun, type ColumnRole, type KanbanColumn, type DeliveryStatus, type CapabilityGrant,
} from "@loom/shared";
import type { Db, IdleNudgePolicy } from "../db.js";
import type { PtyHost, QueuedMessage, LandedMode, EnqueueDeliveryReason } from "../pty/host.js";
import { modeAfterCyclesFromAcceptEdits, cyclesToReachFromAcceptEdits, reapProcessesRootedInWorktree, CONTROL_CHAR_RE, disallowedToolsForRole } from "../pty/host.js";
import { composeRoleSessionName, composeWorkerSessionName, PLATFORM_LEAD_SESSION_NAME } from "../pty/session-name.js";
import { createWorktree, removeWorktree, deleteBranch, diffBranch, mergeBranch, mergeMainIntoWorktree, findLandedSquashCommit, findNestedGitRepos, worktreeHasWork, detectStrandedWork, precheckWorkerDone, toConventionalSubject, codescapeWorktreeId, type DiffstatFile, type MergeEmptyKind, type ReusedDirtyWorktreeInfo } from "../git/worktrees.js";
import { GitReader } from "../git/reader.js";
import { sessionScratchDir, isCodescapeEnabled, codescapeGraphPath } from "../paths.js";
import { engineTranscriptExists, snapshotTranscript, deleteArchivedTranscript, archivedTranscriptExists, archivedTranscriptPath } from "./transcript.js";
import { deleteAgentCore } from "./delete-agent-core.js";
import { readRunUsage, readRunUsageFromFile } from "./context.js";
import { computeRunCostUsd } from "./pricing.js";
import { createRunSnapshot, removeRunSnapshot, sweepAllRunSnapshots } from "../runs/snapshot.js";
import { composeRunStartupPrompt } from "../runs/prompt.js";
import { composeManagerStartupPrompt, appendScheduledPrompt } from "./manager-prompt.js";
import { composePlatformLeadStartupPrompt, composeResumeDocOperationalNotes, lineageRootId, liveLineageSuccessor, resolvePlatformLeadResumeDocPath } from "./platform-lead-prompt.js";
import { composeWorkerStartupPrompt } from "./worker-prompt.js";
import { composeAssistantStartupPrompt, appendMemoryRecallToStartupPrompt } from "./assistant-prompt.js";
import { listCompanionMemories, readCompanionMemory } from "../skills/companion-memory-store.js";
import { buildFramedMemoryRecall } from "../companion/memory-recall.js";
import { retrieveProjectMemoryForKickoff } from "./project-memory-recall.js";
import type { OrchestrationControl } from "../orchestration/control.js";
import type { CodescapeSupervisor } from "../codescape/supervisor.js";
import { isLikelyNearClaudeUsageLimit, getClaudeUsageLimitRetryAfter, getClaudeExpectedResetAt, UsageLimitError } from "../orchestration/usage-awareness.js";
import { rateLimitDeadline } from "../orchestration/usage-limit.js";
import { RESTART_EXIT_CODE, isSupervised, writeRestartIntent, buildDaemon, resumeSetFromIntent, isNoOpManagerWake, extractCommitShas, supervisorScriptChangedSince, SUPERVISOR_CHANGED_WARNING, type RestartIntent, type RestartResumeEntry } from "../orchestration/restart.js";
import { computeWakeImpact } from "../orchestration/wake-impact.js";
import { resolveBackupConfig, takeBackup } from "../orchestration/db-backup.js";
import { recordUndeliveredReport, isCrashRecoveryEligible } from "../orchestration/crash-recovery-watcher.js";
import type { CrashOrphanedWorker } from "../orchestration/crash-orphaned-workers.js";
import { RESUME_NUDGE_TAIL, DRAFT_LOSS_NOTE } from "../orchestration/resume-nudge.js";
import type { ShutdownMarkerRecord } from "../shutdown-marker.js";
import { nextFireAt } from "../orchestration/cron.js";
import { runGateSequential, classifyGatePhase, extractFailingTest, classifyGateFailure, GATE_RETRY_ENABLED, GATE_RETRY_SETTLE_MS, type GateSequentialResult, type GateStepRunner } from "../orchestration/gate-runner.js";
import { GateSemaphore } from "../orchestration/gate-semaphore.js";
import { checkDeployRateLimit, DEPLOY_RATE_LIMIT_MAX, DEPLOY_RATE_LIMIT_WINDOW_MS } from "../orchestration/deploy.js";
import { PendingOpRegistry, SYNC_ATTACH_BUDGET_MS, type AttachResult, type PendingOpView } from "../orchestration/pending-ops.js";
import { CapQueueRegistry, CapQueueRejectedError, type CapQueuedSpawn } from "../orchestration/cap-queue.js";
import { validateAgentProjectConfigOverride } from "../mcp/platform.js";
import { PLATFORM_PROJECT_NAME } from "../platform/seed.js";
import { SETUP_PROJECT_NAME } from "../setup/seed.js";
import { checkPeerMessageRateLimit } from "./peer-message-guard.js";
import { planColumnLayout, setProjectConfigSafe, type DesiredColumn } from "../tasks/columns.js";
import { resolveIdPrefix, looksLikeId, MIN_ID_PREFIX_LEN } from "../id-prefix.js";

/** Floor (1s) for any threaded git-op timeout — a sub-second misconfig must never make every git op
 *  fail-fast (mirrors GitWriter's GIT_TIMEOUT_FLOOR_MS). Applied where the resolved value is threaded. */
const GIT_TIMEOUT_FLOOR_MS = 1_000;

/** {@link SessionService.confirmWorkerMerge}'s settled result shape — named so it can be threaded
 *  through {@link PendingOpRegistry} (card fb8df559 Part 1) without repeating the inline object type.
 *  `notified` (card 9eea3901, widened by 187f5b76): true iff a `[loom:merge-*]` nudge was ALREADY pushed
 *  directly to the manager during this call — on a rejection (`merged:false`) that's `!suppressed` from
 *  the return's own `rejectNotify` call (the rich `[loom:merge-rejected]`); on an ALREADY_MERGED success
 *  (`merged:true`, via {@link finishAlreadyMerged}) it's unconditionally `true` — that path OWNS the
 *  `[loom:already-merged]` announcement for its outcome, whether or not this particular call actually
 *  fired it (see finishAlreadyMerged's own stale-redelivery guard). {@link confirmWorkerMergeTracked}'s
 *  completion callback reads it to skip the redundant generic `[loom:merge-done]`/`[loom:merge-failed]`
 *  echo when the manager was already told. Left `undefined` only on the plain GREEN merge return — that
 *  path sends no direct nudge of its own, so the tracked wrapper's generic echo is the sole signal.
 *  `opId` (card 369d8824): the correlation stamp threaded from {@link PendingOpRegistry.attach} (or
 *  minted fresh for a caller outside that registry, e.g. the human REST merge route) — carried on every
 *  return so a manager juggling several concurrent merges can match this outcome back to the specific
 *  `worker_merge_confirm` call that produced it. */
/** Diagnostic detail for a `reason:"gate"` rejection (card 4b8f2b6e) — populated ONLY when a configured
 *  gateCommand step actually failed, so a manager can tell a real test failure apart from an fs teardown
 *  flake or a self-wiped node_modules TS2688 without re-running the gate blind. `signal`/`timedOut` are
 *  carried through (not yet acted on) so a later change (card bcba83a1) can classify an OOM/SIGKILL kill
 *  distinctly from a genuine failure. */
type GateRejectionDetail = {
  phase?: "typecheck" | "test" | "build";
  failedStep?: string;
  failingTest?: string;
  stderrTail?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  timedOut?: boolean;
};

type ConfirmMergeResult = { merged: boolean; reason?: string; emptyKind?: MergeEmptyKind; hardError?: boolean; reportedState?: "done" | "blocked"; warning?: string; notified?: boolean; gateDetail?: GateRejectionDetail; opId: string };

/** How long a settled merge op stays `peek()`-able (as a RETAINED terminal view — see
 *  PendingOpRegistry's doc) after {@link SessionService.confirmWorkerMergeTracked} settles it — long
 *  enough for the Board's polling `/api/sessions` fetch to catch the terminal fill at least once before
 *  it reverts, short enough that a stale merged/rejected/failed card doesn't linger. */
const MERGE_OP_RETAIN_MS = 5_000;

/** {@link SessionService.runWorkerGate}'s result (card 7f96aa09 — structural fix B for d5c5ccdf: route the
 *  worker DoD self-gate through the daemon GateSemaphore). `ran:false` means no gate command is configured
 *  for this project at all (the caller should fall back to a raw self-check, pinning `LOOM_TEST_CONCURRENCY=1`
 *  itself); `ran:true` always means the SAME `orchestration.gateCommand` the merge gate itself runs was
 *  actually executed, in the worker's own worktree. Reuses `GateRejectionDetail`'s shape on a failure — the
 *  same diagnostic enrichment (phase/failedStep/failingTest/stderrTail/exitCode/signal/timedOut) the merge
 *  gate's own rejection carries — but this is a single run: unlike `confirmWorkerMerge`, a transient-kill
 *  classification is NOT auto-retried here (the worker can just re-call run_gate itself). */
type WorkerGateResult = { ran: boolean; passed?: boolean; reason?: string; gateDetail?: GateRejectionDetail; opId?: string };

/** Forced onto the worker self-gate's OWN spawned child (card 7f96aa09, revised by 68920f5b), additive to
 *  whatever env the worker's shell already has — pins the daemon test runner's own internal test-lane pool
 *  to TWO lanes per gate invocation, matching the merge gate's own unpinned default (`DEFAULT_CONCURRENCY`
 *  in `scripts/test-daemon.mjs`). Owner decision 68920f5b (request 3d73c2a8): `run_gate` was running the
 *  SAME suite at HALF the merge gate's parallelism against the SAME `gateCommandTimeoutMs`, making it
 *  structurally more timeout-prone than the merge gate it feeds — a `run_gate` timeout did not predict a
 *  merge rejection. Raising this to 2 removes that asymmetry.
 *
 *  Still safe: `orchestration.maxConcurrentGates` (default 1) admits gate RUNS — merge, deploy, AND
 *  run_gate — through the SAME `gateSemaphore`, so at the default config at most one gate runs at a time
 *  and a 2-lane `run_gate` peaks at the SAME 2 lanes a merge gate already reaches today. The 2026-07-15
 *  8-lane incident was ONE gate's pool defaulting to full core count (no `LOOM_TEST_CONCURRENCY` pin at
 *  all), not concurrent gates — this override still pins a bound, just 2 instead of 1. The real
 *  host-load budget is `maxConcurrentGates × 2` (same formula the merge gate already implies); that only
 *  changes if someone raises `maxConcurrentGates` above 1, which carries the identical exposure for the
 *  merge gate too — no new risk class.
 *
 *  This is DELIBERATELY DIFFERENT from the raw-Bash fallback pin (still `LOOM_TEST_CONCURRENCY=1`,
 *  documented below and in CLAUDE.md): a raw self-check run via Bash is OUTSIDE the semaphore entirely —
 *  N concurrent raw gates is N × lanes with no structural bound, so its pin stays conservative at 1. This
 *  override is admitted through the semaphore, so it can safely match the merge gate's 2. */
const WORKER_GATE_ENV_OVERRIDE: NodeJS.ProcessEnv = { LOOM_TEST_CONCURRENCY: "2" };

/** {@link SessionService.gcWorktreeDir}'s result. `nestedRepoPaths`/`scanTruncated` are only ever set
 *  alongside `outcome: "nested-repo-blocked"` — see that outcome's doc on gcWorktreeDir. */
type GcOutcomeResult = {
  outcome: "removed" | "wedged" | "left-on-disk" | "needs-human-skip" | "nested-repo-blocked";
  nestedRepoPaths?: string[];
  scanTruncated?: boolean;
};

/** The manager-facing `warning` text for a `worker_merge_confirm` whose worktree removal was blocked by
 *  the nested-repo guard (card b6d41db1) — shared by the Green path and the ALREADY_MERGED path
 *  ({@link SessionService.finishAlreadyMerged}) so the two can't drift. A TRUNCATED scan (inconclusive,
 *  not a confirmed finding) gets its own wording — never phrased as if specific paths were found. */
function nestedRepoBlockWarning(block: { paths: string[]; truncated: boolean }): string {
  return block.truncated
    ? "worktree retained — the nested-repo scan was INCONCLUSIVE (truncated, or the scan itself failed) " +
      "and could not confirm the worktree is clean, so it was NOT removed. Verify manually for a nested " +
      "clone, then remove it yourself, or re-run worker_merge_confirm with forceRemoveWorktree:true to force removal."
    : `worktree retained — nested git repo(s) found and NOT removed: ${block.paths.join(", ")}. ` +
      "Move/push that content out of the worktree yourself, then remove it, or re-run worker_merge_confirm with forceRemoveWorktree:true to force removal.";
}

/**
 * worker_set_mode's mode ALLOWLIST (card 610abe29) — the security boundary for `setWorkerMode`.
 * DELIBERATELY excludes `bypassPermissions` (disables the acceptEdits+allowlist sandbox a worker is
 * spawned into — an agent must never be able to escalate a worker out of it) and `default`/`unknown`.
 */
type WorkerSettableMode = "acceptEdits" | "auto" | "plan";
const WORKER_SETTABLE_MODES: ReadonlySet<string> = new Set<WorkerSettableMode>(["acceptEdits", "auto", "plan"]);

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
 * "workspace-auditor" (loom-user-audit), "setup" (loom-setup), "operator" (loom-operator, Bucket 2b) and
 * "run" (internal-only Agent Runs) — must come EXCLUSIVELY from their explicit human spawn paths
 * (startPlatformLead/startAuditor/startSetup/startWorkspaceAuditor/startOperator) or internal starters,
 * which pass an explicit caller role. A profile role outside this set is dropped to a plain (role-null)
 * spawn in resolveAgentSpawn,
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

/** A tasked worker_spawn's advisory "already shipped?" match — the card's title, normalized the SAME
 *  way the squash-merge path normalizes a commit subject ({@link toConventionalSubject}), already
 *  appears verbatim as a commit subject on the project's mainline. */
export interface ShippedCardMatch {
  sha: string;
  subject: string;
  mainBranch: string;
}

/** One escalation's manager-facing status (orchestration `escalation_status`) — a compact, honest read of
 *  a `platform_escalate` task's CURRENT state; never the Platform task's full body. */
export interface EscalationStatusItem {
  taskId: string;
  /** The task's CURRENT title — the Lead may have refined it, itself a signal it was seen. Falls back to
   *  the originally-filed title once the task is `closed` (deleted/archived — no live row to read). */
  title: string;
  status: "pending" | "in_progress" | "resolved" | "closed";
  columnKey: string | null;
  updatedAt: string;
}

/** Bounded scan window for {@link findShippedCardMatch} — recent mainline history only, not a full-repo
 *  grep. 200 commits comfortably covers "did this land recently" without an unbounded git log read. */
const SHIPPED_MATCH_SCAN_LIMIT = 200;

/**
 * worker_spawn wasted-dispatch guard (Platform card 7b5944fc): before dispatching a TASKED worker, check
 * whether the card's title already shipped — i.e. its title, coerced to a commit subject the same way a
 * squash-merge coerces a card title ({@link toConventionalSubject}), already appears EXACTLY as a commit
 * subject within the last {@link SHIPPED_MATCH_SCAN_LIMIT} commits on the project's mainline (the
 * canonical repo's currently-checked-out branch — workers never check main out anywhere else). Advisory
 * ONLY: flags a likely-already-done dispatch for the manager to verify, never auto-closes the card and
 * never blocks/fails the spawn. Read-only (GitReader) — no shell-out, no git write. Exact-match only (no
 * fuzzy title matching — fuzzy would produce false warnings); best-effort (any git-read failure yields no
 * match rather than surfacing an error to a spawn that would otherwise succeed).
 */
async function findShippedCardMatch(repoPath: string, cardTitle: string): Promise<ShippedCardMatch | null> {
  try {
    const reader = new GitReader(repoPath);
    const normalizedTitle = toConventionalSubject(cardTitle);
    const [log, branches] = await Promise.all([reader.log(SHIPPED_MATCH_SCAN_LIMIT), reader.branches()]);
    for (const commit of log) {
      if (toConventionalSubject(commit.message) === normalizedTitle) {
        return { sha: commit.hash, subject: commit.message, mainBranch: branches.current ?? "" };
      }
    }
    return null;
  } catch {
    return null;
  }
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

/**
 * Char cap for INLINING a worker_merge full patch in the JSON tool response. Above this, the patch is
 * instead spilled to a scratch file (see {@link SessionService.spillMergePatch}) — comfortably under the
 * transcript pager's own ~48KB page budget (`TRANSCRIPT_PAGE_CHAR_BUDGET`), and well below the real-world
 * overflow (a 74,658-char patch, auditor finding 8a942a95) that this cap is meant to catch BEFORE the MCP
 * tool-result cap does, so Loom controls the spill format instead of the client's own broken one-line spill.
 */
const MERGE_PATCH_INLINE_CAP = 40_000;

/** Bounded wait `upgradeCompanionCapabilities` gives a BUSY companion turn to finish naturally before
 *  force-interrupting it (card d88163b7). NOT a free knob (CR round 2 correction of an earlier "the wait
 *  is loss-free, so raise it freely" claim): `holdDrain` (see that method's comment) only protects
 *  messages QUEUED during the wait — it does NOTHING for the busy turn itself. A turn still busy when this
 *  bound expires is STILL force-interrupted and its in-flight reply STILL lost, exactly as pre-fix. So
 *  this is a genuine trade — longer catches more real turns before they're cut off, at the cost of a
 *  longer human-facing REST "Save" hang — kept at ~3s for REST responsiveness (a human-facing Settings
 *  save hanging 10s is bad UX; this only bites when someone saves mid-turn; it's env-overridable if that
 *  trade needs revisiting). Measured on a MONOTONIC clock (`performance.now()`), not an iteration count,
 *  so it's a genuine wall-clock bound even if an individual 100ms poll tick runs long under event-loop
 *  load. Env-overridable (mirrors pty/host.ts's LOOM_GRACEFUL_*_MS seams) so a test can shrink it instead
 *  of waiting out the real bound. */
const UPGRADE_BUSY_WAIT_MS = Number(process.env.LOOM_UPGRADE_BUSY_WAIT_MS) || 3_000;

/**
 * classifyIdleWorker's `parked-background` decay window (card c36bac53 round-2 CR Major): how long a
 * worker's self-attributed `worker_report({awaiting:"background"})` is trusted at face value before
 * classification falls through to the actionable `parked-background-stale` kind. A DOCUMENTED constant,
 * not a per-project config knob (this is a daemon-internal staleness bound, not a tunable orchestration
 * policy) — chosen to sit comfortably above a real gate's plausible run time (this repo's own daemon test
 * gate legitimately runs ~8-10 minutes) so it never resurrects the false alarms this card fixes, while
 * still being well short of `idleWorkerMinutes`'s 45-minute default periodic-recheck cadence so a
 * genuinely dead background park surfaces within roughly one more tick instead of sitting silently
 * "no reply owed" indefinitely.
 */
const BACKGROUND_PARK_STALE_MINUTES = 20;

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
  /**
   * Test-only seam for {@link removeWorktree}'s killable-removal backstop (task dea6728e). `undefined` in
   * production ⇒ removeWorktree falls back to its own real {@link killableRemoveDir}. Lets a test drive
   * gcWorktreeDir/finalizeMerge through a deterministic CLEAN-reject or genuinely-WEDGED (killed) outcome
   * without needing a real busy OS handle (which the new child-process removal — unlike the old
   * `fs.promises.rm` — can no longer be faked into by monkeypatching a Node fs API).
   */
  private readonly removeDirOverride: ((target: string, timeoutMs: number) => Promise<{ removed: boolean; killed: boolean }>) | undefined;
  /**
   * Injectable seam for {@link reapProcessesRootedInWorktree} (task 8e5a7a5e — the dangling-worktree
   * PREVENTION: kill an escaped build/dev-server process rooted in the worktree BEFORE the removal below
   * even attempts to run). `undefined` in production ⇒ {@link gcWorktreeDir} falls back to the real OS
   * process-enumerate-and-kill. Lets a test drive a deterministic fake process list through gcWorktreeDir
   * without touching real OS processes. The optional second-arg `excludePids` lets confirmWorkerMerge's
   * pre-gate sweep (run BEFORE the confirming worker is stopped) exclude that worker's own still-live pty
   * pid from the kill set — see the pre-gate call site's doc comment.
   */
  private readonly reapWorktreeProcesses: ((worktreePath: string, opts?: { excludePids?: number[] }) => Promise<{ killedPids: number[] }>) | undefined;
  /**
   * Test-only seam for {@link findNestedGitRepos} (card b6d41db1's follow-up — the shared-chokepoint
   * fix). `undefined` in production ⇒ {@link gcWorktreeDir} falls back to the real scan. Lets a test
   * drive a deterministic TRUNCATED result (`{repos:[],truncated:true}`) through gcWorktreeDir's
   * fail-safe path without needing to actually create tens of thousands of files to trip the real cap.
   */
  private readonly findNestedGitReposOverride: ((worktreePath: string) => Promise<{ repos: string[]; truncated: boolean }>) | undefined;
  /**
   * Injectable seam for {@link runGateSequential} (card bcba83a1 — the merge gate's kill-classification +
   * auto-retry). `undefined` in production ⇒ {@link confirmWorkerMerge} falls back to the real
   * `runGateSequential`, which spawns real processes. Lets a hermetic test drive a deterministic
   * signal/timedOut sequence — including one that differs between the first call and a retry — without
   * needing a real cross-platform OOM/SIGKILL (signal delivery on `close` is not reliably fakeable via a
   * real spawn on every OS this daemon runs on).
   */
  private readonly runGate:
    | ((gate: string, cwd: string, timeoutMs: number, runStep?: GateStepRunner, envOverride?: NodeJS.ProcessEnv) => Promise<GateSequentialResult>)
    | undefined;
  /**
   * SLOW-retry policy for a wedged worktree (task dea6728e — the owner-directed refinement: "quarantine"
   * must not mean "dangles forever"). A wedge is usually eventually-resolvable (a held OS-indexer/
   * Defender-scan handle releases, or a pnpm-junction structure `rmdir` succeeds where `fs.rm` choked), so
   * SessionService keeps retrying it — once per boot (Pass B) plus this low-frequency in-session sweep —
   * rather than skipping it forever. Safe at ANY cadence because every retry is the SAME killable removal
   * (never a threadpool op, never able to hang a thread) — this is NOT bd9fc808's reverted 30s loop, both
   * because the removal itself can't leak AND because the cadence here is ~1000x slower. Only past
   * {@link wedgeGiveUpAttempts} attempts OR {@link wedgeGiveUpMs} elapsed — WHICHEVER trips first; the
   * default attempt count can be reached in well under the default 7-day window on a heavy restart
   * cadence — does a dir flip to `needsHuman` and stop retrying. All three are test-overridable (opts) so
   * a test can prove the give-up bound without real days/attempts.
   */
  private readonly wedgeSweepIntervalMs: number;
  private readonly wedgeGiveUpAttempts: number;
  private readonly wedgeGiveUpMs: number;
  private static readonly DEFAULT_WEDGE_SWEEP_INTERVAL_MS = 45 * 60_000; // 45min — inside the owner's 30-60min band
  private static readonly DEFAULT_WEDGE_GIVE_UP_ATTEMPTS = 50;
  private static readonly DEFAULT_WEDGE_GIVE_UP_MS = 7 * 24 * 60 * 60_000; // 7 days
  /** The armed background sweep timer, or null when nothing is currently wedged (self-arms/disarms). */
  private wedgeSweepTimer: ReturnType<typeof setInterval> | null = null;
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
   * Deliver-once window for the Platform→manager `[loom:from-platform]` route (card c17291c3, the live
   * repro: a directive arrived at a manager as two duplicated turns / a doubled prefix line). Keyed on a
   * content hash of (recipient, normalized directive text) so a RETRIED or DUPLICATED `session_message`
   * call for the SAME directive collapses to a single injected turn — no caller-supplied id required, and
   * a genuinely-DIFFERENT directive (different text) always gets its own fresh key. In-memory by design,
   * exactly like {@link deployShaWindow}: the send and the retry both happen within the same daemon
   * process's short retry window, and a missed dedup (e.g. across a daemon restart) is harmless — one
   * extra turn, not a lost one. Pruned by {@link PLATFORM_MESSAGE_DEDUP_TTL_MS}.
   */
  private readonly platformMessageDedupe = new Map<string, { result: { deliveryStatus: DeliveryStatus; position?: number; taskId?: string; routedTo?: string }; atMs: number }>();
  private static readonly PLATFORM_MESSAGE_DEDUP_TTL_MS = 5 * 60_000;
  /**
   * Resume-half project-memory dedup gate (card ea648f89): sessionId → the sha256 hex digest of the LAST
   * framed project-memory block this session was actually handed by resume() (or `null` when the last
   * resume had nothing to inject). resume() re-retrieves on EVERY resume (idle-nudge resumes, wakes, and
   * crash/restart recovery all call it) with no change-detection otherwise — re-injecting the IDENTICAL
   * framed block verbatim every time (observed live as 3 consecutive identical injections, flagged
   * unprompted as noise by the resumed manager). In-memory by design, exactly like {@link deployShaWindow}/
   * {@link platformMessageDedupe} above: the FREQUENT resumes this fixes (idle-nudge/wake/crash-recovery)
   * all happen within the SAME daemon process as the injection they're deduping against, so a plain Map
   * catches every one of them with zero schema cost. The only case it can't dedupe is the very FIRST resume
   * after a daemon RESTART (the map itself doesn't survive process exit) — but that's harmless, not merely
   * tolerable: the resumed engine's own transcript already carries the prior injection from before the
   * restart, so this is one redundant-but-correct re-inject on a rare event, not a persistent regression.
   * Not persisted to the `sessions` table on purpose — this is a noise-reduction cache, not durable state;
   * a core-table column + migration would be the wrong tool for a problem an in-memory map fully solves.
   * Cleaned up on session deletion (see the deleteSession call site) so a long-lived daemon doesn't grow
   * this map forever as sessions churn.
   */
  private readonly lastProjectMemoryDigest = new Map<string, string | null>();
  /**
   * Stamp {@link lastProjectMemoryDigest} for a session's FRESH-spawn project-memory injection (the
   * `retrieveProjectMemoryForKickoff` result already appended to its startup prompt by the caller) — so the
   * session's very FIRST resume dedups against the block the spawn kickoff already showed it, rather than
   * treating the map as empty and redundantly re-injecting the same content resume() would otherwise
   * recompute identically. Called by every fresh-spawn path that injects project memory (startNew,
   * startManager, spawnWorker, recycleWorker — the same v1 coverage project-memory-recall.ts documents);
   * resume() sets the SAME map directly (its own comment above explains the hashing). A fresh spawn whose
   * kickoff/task search text differs from what its first resume will search (e.g. spawnWorker matches the
   * manager's kickoff prompt, but resume matches the bound task's title+body once one exists) may still
   * compute a DIFFERENT digest at that first resume — correctly triggering a real (not redundant) inject,
   * since the matched notes genuinely differ; this stamp only dedupes the common case where they agree.
   */
  private stampProjectMemoryDigest(sessionId: string, framed: string | null): void {
    this.lastProjectMemoryDigest.set(sessionId, framed ? createHash("sha256").update(framed).digest("hex") : null);
  }
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
   * BOUNDED record of a worker_spawn REJECTED purely because the concurrency cap was at capacity (a
   * distinct failure mode from {@link inFlightSpawnTaskIds}, which guards a live in-flight spawn against a
   * same-taskId race — this records an intent that never even started). See {@link CapQueueRegistry} for
   * the full contract; surfaced via {@link listCapQueuedSpawns} as a worker_list placeholder row, and
   * auto-drained by {@link maybeDrainCapQueue} whenever a concurrency slot actually frees (card 81b7e346)
   * — a manager can still re-drive an entry by hand via worker_spawn, but no longer has to.
   */
  private readonly capQueue = new CapQueueRegistry();
  /**
   * Per-manager REFCOUNTED suppression for {@link maybeDrainCapQueue} — guards the ONE retirement path
   * that reuses a just-freed slot for a session it inserts DIRECTLY, bypassing spawnWorker's own cap-admit
   * entirely: {@link recycleWorker} hard-stops the predecessor, then (up to ~5s later, after its own
   * bounded wait for the pty to actually die) unconditionally `insertSession`s the successor as a 1:1
   * swap. If the predecessor's exit fired an auto-drain in that window, a queued entry could steal the
   * "freed" slot and the successor's own insert would then push the manager one OVER cap — the ONE place
   * in the whole retirement surface where a slot-free is followed by an uncapped re-claim of it (every
   * other retirement path listed in maybeDrainCapQueue's doc is a genuine, final free with nothing behind
   * it). Refcounted (not a boolean) so two overlapping recycles on the SAME manager can't have the first's
   * cleanup prematurely un-suppress the second's still-in-flight window.
   */
  private readonly recycleDrainSuppressed = new Map<string, number>();

  private suppressCapQueueDrain(managerSessionId: string): void {
    this.recycleDrainSuppressed.set(managerSessionId, (this.recycleDrainSuppressed.get(managerSessionId) ?? 0) + 1);
  }

  private unsuppressCapQueueDrain(managerSessionId: string): void {
    const n = (this.recycleDrainSuppressed.get(managerSessionId) ?? 0) - 1;
    if (n > 0) this.recycleDrainSuppressed.set(managerSessionId, n);
    else this.recycleDrainSuppressed.delete(managerSessionId);
  }
  /**
   * CLIENT-TIMEOUT RESILIENCE registry (card fb8df559 Part 1) — a THIN OUTER layer around
   * spawnWorker/confirmWorkerMerge (via {@link spawnWorkerTracked}/{@link confirmWorkerMergeTracked}),
   * NOT a replacement for {@link inFlightSpawnTaskIds}/the merge gate's own internals, which stay
   * completely untouched (so the existing hermetic tests that call spawnWorker/confirmWorkerMerge
   * in-process keep working byte-identically). This registry only changes how the MCP tools
   * worker_spawn/worker_merge_confirm DELIVER a result: a fast op still resolves synchronously; a slow
   * one (a real multi-minute gate — Auditor b9515beb) degrades to a pending handle instead of the caller
   * timing out with no way to tell whether it landed, and a RETRY attaches to the same in-flight op
   * instead of racing a second real invocation. Keyed `spawn:${taskId}` (raw, as given by the caller —
   * NOT prefix-resolved; a genuine retry replays the identical taskId string) / `merge:${workerSessionId}`.
   */
  private readonly pendingOps = new PendingOpRegistry();
  /**
   * HOST-LOAD guard (card 301d8c01): caps how many daemon-executed heavy gate runs (the merge-confirm
   * gate + the scoped-deploy gate — both spawn a human-set build/test command via `runGateSequential`)
   * may run AT ONCE across every project. Default cap 1 (`orchestration.maxConcurrentGates`,
   * daemon-global) — a second concurrent gate QUEUES instead of running alongside the first, so
   * concurrent merges/deploys can no longer pile up host load unbounded. See {@link GateSemaphore}.
   */
  private readonly gateSemaphore = new GateSemaphore();
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
  /**
   * Codescape fleet-daemon wiring (card C1, epic `369dde3c`): the daemon-singleton supervisor handle,
   * injected like every other boot-owned dependency here. C2's per-session stdio MCP mount
   * (`codescapeMcpServer`) reads the project's graph FILE directly (no supervisor call); C3
   * (`fireCodescapeEnsureGraph`/`fireCodescapeReingest`/`fireCodescapeDrop`) fires `ingestToGraph` off
   * this handle at worktree-spawn/merge time to keep that file fresh — every call gated
   * `isCodescapeEnabled(config)` (folds in `isLoomDev()`), so a non-dev or Codescape-disabled project
   * calls none of its methods.
   * `undefined` in every existing test constructor (3-arg or opts-less) ⇒ byte-identical (`this.codescape?.`
   * everywhere, never a bare `this.codescape.`).
   */
  private readonly codescape: CodescapeSupervisor | undefined;
  constructor(
    private db: Db, private pty: PtyHost, private control: OrchestrationControl,
    opts?: {
      gitOpMs?: number; provisionMs?: number; runWebhookPost?: RunWebhookPoster; runWebhookTimeoutMs?: number; runTimeoutMs?: number;
      removeDir?: (target: string, timeoutMs: number) => Promise<{ removed: boolean; killed: boolean }>;
      reapWorktreeProcesses?: (worktreePath: string, opts?: { excludePids?: number[] }) => Promise<{ killedPids: number[] }>;
      findNestedGitRepos?: (worktreePath: string) => Promise<{ repos: string[]; truncated: boolean }>;
      runGate?: (gate: string, cwd: string, timeoutMs: number, runStep?: GateStepRunner, envOverride?: NodeJS.ProcessEnv) => Promise<GateSequentialResult>;
      wedgeSweepIntervalMs?: number; wedgeGiveUpAttempts?: number; wedgeGiveUpMs?: number;
      codescape?: CodescapeSupervisor;
    },
  ) {
    this.gitOpMs = opts?.gitOpMs == null ? undefined : Math.max(GIT_TIMEOUT_FLOOR_MS, opts.gitOpMs);
    this.provisionMs = opts?.provisionMs;
    this.removeDirOverride = opts?.removeDir;
    this.reapWorktreeProcesses = opts?.reapWorktreeProcesses;
    this.findNestedGitReposOverride = opts?.findNestedGitRepos;
    this.runGate = opts?.runGate;
    this.wedgeSweepIntervalMs = opts?.wedgeSweepIntervalMs ?? SessionService.DEFAULT_WEDGE_SWEEP_INTERVAL_MS;
    this.wedgeGiveUpAttempts = opts?.wedgeGiveUpAttempts ?? SessionService.DEFAULT_WEDGE_GIVE_UP_ATTEMPTS;
    this.wedgeGiveUpMs = opts?.wedgeGiveUpMs ?? SessionService.DEFAULT_WEDGE_GIVE_UP_MS;
    this.runWebhookPost = opts?.runWebhookPost ?? defaultRunWebhookPost;
    this.runWebhookTimeoutMs = opts?.runWebhookTimeoutMs ?? RUN_WEBHOOK_TIMEOUT_MS;
    this.runTimeoutMs = opts?.runTimeoutMs ?? RUN_TIMEOUT_MS;
    this.codescape = opts?.codescape;
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
  ): { role: SessionRole | undefined; startupPrompt: string | undefined; permission: PermissionPolicy; browserTesting: boolean; documentConversion: boolean; capabilities: CapabilityGrant[]; restrictedTools: boolean; noCommit: boolean; model: string | undefined; skills: string[] | null; connections: string[]; vaultWrite: boolean } {
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
    const baselinePermission = withBaselineAllow(layered);
    // LEAST-PRIVILEGE backstop: a profile may confer ONLY manager|worker|assistant (or no role). An
    // elevated/locked profile role (platform/auditor/setup/run) is dropped to undefined here, so a role-omitted "+New"
    // spawn yields a plain session, never a silent elevation. An EXPLICIT caller role is untouched and
    // still wins below (`??`), so startPlatformLead/startAuditor/startManager are byte-identical; a
    // manager/worker/null profile role is also unchanged (the common path).
    const profileRole = resolved.role && !PROFILE_SPAWNABLE_ROLES.has(resolved.role) ? undefined : resolved.role;
    // An explicit caller role still wins; then the (clamped) profile role (null under forcePlain), then
    // undefined (today's plain). The force-plain path passes no explicitRole, so it resolves null.
    const role = explicitRole ?? profileRole ?? undefined;
    // WORKER structural default (audit finding 760cd01d, sev medium): `acceptEdits` auto-approves file
    // edits ONLY — Bash/`gh`/build/test and non-allowlisted MCP calls still prompt, and a spawned worker
    // has no human at its TUI to answer, so it stalls (the owner had to manually worker_set_mode('auto')
    // twice before this fix). Pin a WORKER's boot-cycle target to `auto` INDEPENDENT of the shared
    // `config.permission.startupModeCycles` knob, so a project-level cycles customization (made for
    // manager/other-role reasons) can never silently leave a worker un-cycled. Every OTHER role keeps
    // config's startupModeCycles verbatim — byte-identical to before this change. A manager can still pin
    // a specific worker to the rare edits-only `acceptEdits` mode after spawn via `worker_set_mode`.
    const permission = role === "worker"
      ? { ...baselinePermission, startupModeCycles: cyclesToReachFromAcceptEdits("auto") }
      : baselinePermission;
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
      // Agent-tooling P4: registry-capability grants BEYOND the two booleans above, RAW passthrough
      // (backstop [] under forcePlain / no profile).
      capabilities: resolved.capabilities,
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
      // Profile-pinned authenticated-egress connection-id allowlist (backstop [] under forcePlain / no
      // profile / an unset field) — UNLIKE skills, [] here always means "no access", never "all".
      connections: resolved.connections,
      // Profile-pinned confined vault-write grant (backstop false under forcePlain / no profile / an
      // unset field) — mirrors connections: read LIVE by TaskMcpRouter, never threaded to pty.spawn.
      vaultWrite: resolved.vaultWrite,
    };
  }

  /**
   * Compose the fresh-spawn-EQUIVALENT persona+recall prompt for an already-live companion session — the
   * "/new" reinject (chat-gateway.ts's `resetConversation`, companion-persona-after-clear card). COMPOSE-ONLY
   * / side-effect-free: reuses `resolveAgentSpawn` purely to extract the composed startup-prompt STRING
   * (that method only READS `db.getProfile`, no writes) and appends the SAME memory-recall digest a fresh
   * spawn/resume gets (`buildFramedMemoryRecall`/`appendMemoryRecallToStartupPrompt`) — this NEVER spawns,
   * writes, or re-arms anything; it is called from a raw-enqueue reinject path, never a spawn path. Returns
   * undefined for anything that isn't a live, still-assistant-role companion session (nothing to reinject).
   *
   * `companionName` — baked into the ORIGINAL startup prompt at creation-time only (startNew's
   * `opts.companionName`) and never stored on the session/agent row — is re-sourced here from the durable
   * `companion_config.name` column (the provision endpoint persists it there, gateway/server.ts) rather than
   * threaded through some new session-row field, so a re-inject years after provisioning still gets the same
   * name. `explicitRole:"assistant"` is passed (not re-resolved from the agent's CURRENT profile) mirroring
   * resume()'s "carry session.role forward" pattern — a profile edited after this companion was created must
   * not change what a reinject composes for it.
   */
  composeCompanionReinjectPrompt(sessionId: string): string | undefined {
    const session = this.db.getSession(sessionId);
    if (!session || session.role !== "assistant") return undefined;
    const agent = this.db.getAgent(session.agentId);
    if (!agent) return undefined;
    const project = this.db.getProject(agent.projectId);
    if (!project) return undefined;
    const config = resolveConfig(project.config);
    const companionName = this.db.getCompanionConfig(sessionId)?.name || undefined;
    const { startupPrompt } = this.resolveAgentSpawn(agent, config, "assistant", false, companionName);
    if (!startupPrompt) return undefined;
    return appendMemoryRecallToStartupPrompt(
      startupPrompt,
      buildFramedMemoryRecall(listCompanionMemories(sessionId), (name) => readCompanionMemory(sessionId, name)),
    );
  }

  /**
   * Start a NEW session in an agent — injects the agent startup prompt once. `opts.forcePlain` (P3
   * web "Spawn → force plain") overrides any profile-conferred role to spawn a role-null session.
   * `opts.companionName` (companion provision only) bakes the companion's given name into its startup
   * prompt at creation — see resolveAgentSpawn / composeAssistantStartupPrompt. Harmless on any non-
   * assistant spawn (resolveAgentSpawn only reads it when role === "assistant"). `opts.kickoffPrompt`
   * (poll-triggered spawns, agent-tooling epic P3) appends a dynamic part AFTER the agent's own resolved
   * prompt via `composeWorkerStartupPrompt`'s brief+"---"+dynamicPart shape (reused verbatim, no new
   * compose path) — omitted ⇒ byte-identical to today.
   */
  startNew(agentId: string, opts: { forcePlain?: boolean; companionName?: string; kickoffPrompt?: string } = {}): Session {
    const agent = this.db.getAgent(agentId);
    if (!agent) throw new Error("agent not found");
    const project = this.db.getProject(agent.projectId);
    if (!project) throw new Error("project not found");
    const config = resolveConfig(project.config);
    // Phase-2: an agent with a Profile spawns with the profile's role + allowDelta (the injected
    // prompt is always the agent's own). No caller role here (plain "+New"), so the profile's role
    // applies when present. No profile ⇒ role undefined, the config permission unchanged — today's session.
    // forcePlain (P3) pins role to undefined even on a profile agent (see resolveAgentSpawn).
    const { role, startupPrompt, permission, browserTesting, documentConversion, capabilities, restrictedTools, noCommit, model, skills, connections, vaultWrite } = this.resolveAgentSpawn(agent, config, undefined, opts.forcePlain ?? false, opts.companionName);

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
      capabilities, // profile-conferred registry-capability grants, pinned ([] ⇒ today's plain spawn)
      restrictedTools, // profile-conferred restricted-tools, pinned (false ⇒ today's plain spawn)
      noCommit, // profile-conferred no-commit role, pinned (lifecycle-only; false ⇒ today's behavior)
      skills, // profile-conferred skill subset, pinned (null ⇒ deliver all — today's behavior)
      connections, // profile-conferred authenticated-egress allowlist, pinned ([] ⇒ no access — today's behavior)
      vaultWrite, // profile-conferred confined vault-write grant, pinned (false ⇒ no access — today's behavior)
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
    // PL Auditor finding #8, fresh-boot gap: a role-omitted "+New"/"Spawn from profile" call can still
    // resolve role==="manager" (a profile confers it — see PROFILE_SPAWNABLE_ROLES), but this generic
    // path used to skip composeManagerStartupPrompt entirely (only the EXPLICIT role:"manager" path,
    // startManager, applied it) — so the default "Spawn from profile" button on a manager-profiled agent
    // cold-booted with no "Where things live" block and Globbed its home dir for the resume doc. Mirror
    // startManager/recycleManager here so every manager boot, explicit or profile-derived, gets the block.
    const finalStartupPrompt = role === "assistant"
      ? appendMemoryRecallToStartupPrompt(startupPrompt!, buildFramedMemoryRecall(listCompanionMemories(session.id), (name) => readCompanionMemory(session.id, name)))
      : role === "manager"
      ? composeManagerStartupPrompt(startupPrompt, { repoPath: project.repoPath, vaultPath: project.vaultPath, name: project.name, referenceRepos: project.referenceRepos, resumeDocFilename: config.orchestration.resumeDocFilename })
      : startupPrompt;
    // Poll-triggered spawn (P3): append the untrusted-framed kickoff AFTER the agent's own resolved
    // prompt — reuses composeWorkerStartupPrompt's brief+"---"+dynamicPart shape verbatim (no new
    // compose path). Omitted (every other caller) ⇒ finalStartupPrompt unchanged, byte-identical.
    const composedStartupPrompt = opts.kickoffPrompt
      ? composeWorkerStartupPrompt(finalStartupPrompt, opts.kickoffPrompt)
      : finalStartupPrompt;
    // Project memory (card 2fd9abf9, fresh-spawn half): pinned + FTS5-related notes, appended LAST (after
    // any role/kickoff composition above) via the SAME generic append primitive the companion recall
    // reuses. Search text is the kickoff prompt when present (a poll-triggered spawn), else the agent's
    // own prompt — both empty ⇒ pinned-only. null (no project memory notes) ⇒ composedStartupPrompt is
    // passed through UNCHANGED (incl. `undefined`, a plain agent with no prompt) — fully byte-identical.
    const projectMemoryFramed = retrieveProjectMemoryForKickoff(this.db, project.id, opts.kickoffPrompt ?? startupPrompt ?? "");
    const withProjectMemory = projectMemoryFramed
      ? appendMemoryRecallToStartupPrompt(composedStartupPrompt ?? "", projectMemoryFramed)
      : composedStartupPrompt;
    // Card ea648f89: stamp the dedup map so this session's FIRST resume compares against what this fresh
    // spawn just showed it, instead of treating "no prior digest" as license to redundantly re-inject.
    this.stampProjectMemoryDigest(session.id, projectMemoryFramed);
    // Card f9b47cd1: a profile can confer role "worker" here too (PROFILE_SPAWNABLE_ROLES) — this path
    // never runs in a worktree/has a task, so it names as a TASKLESS worker ("adhoc" segment); every
    // other role (incl. undefined ⇒ "Plain/run") uses the fixed per-role tag.
    const sessionName = role === "worker"
      ? composeWorkerSessionName(project.name, agent.name, null, session.id)
      : composeRoleSessionName(role, project.name);
    this.pty.spawn({
      sessionId: session.id,
      cwd: session.cwd,
      permission,
      geometry: config.pty,
      sessionEnv: config.sessionEnv,
      vaultPath: config.docLint ? project.vaultPath : undefined, // Pillar D: scope the vault-lint hook
      codescapeEnabled: config.codescape.enabled, // card C2: Codescape MCP wiring, per-project opt-in
      projectId: project.id,
      startupPrompt: withProjectMemory,
      role,
      browserTesting,
      documentConversion,
      capabilities, // agent-tooling P4: registry-capability grants beyond the two booleans above
      restrictedTools,
      model, // profile-pinned model → `--model` (undefined ⇒ no `--model`, byte-identical to today)
      skills, // profile-pinned skill subset → injectSkills delivers only these (null ⇒ all, byte-identical)
      sessionName, // card f9b47cd1: `-n <name>` resume-picker label (version-gated at createPty)
    });
    return { ...session, processState: "live" };
  }

  /**
   * Start a NEW MANAGER session in an agent (phase-2 §A2). Mirrors startNew, but marks the
   * session role 'manager' (so it gets the loom-orchestration MCP + allowlist at spawn) and
   * runs in the project repo, NOT a worktree (managers coordinate; workers get the worktrees).
   *
   * `prompt` is an OPTIONAL per-schedule custom task description (the Scheduler passes a fired
   * schedule's own `prompt` here) — appended via `appendScheduledPrompt` AFTER the composed manager
   * prompt (identity/doctrine + "Where things live" block). Undefined/null (every non-scheduled caller,
   * and every schedule with no prompt set) ⇒ byte-identical to today.
   *
   * `opts.scheduled` (card 53edd8d5) — true ONLY when index.ts's Scheduler wiring calls this; every
   * other caller (REST "start manager", the generic profile-derived dispatch) omits `opts`, so the
   * session's `scheduledSpawn` pins false and this is byte-identical to before the flag existed. Read
   * back by `Db.countLiveScheduledManagers` — the Scheduler's OWN manager-cap budget, separate from the
   * standing human/Lead-spawned fleet.
   */
  startManager(agentId: string, prompt?: string | null, opts?: { scheduled?: boolean }): Session {
    const agent = this.db.getAgent(agentId);
    if (!agent) throw new Error("agent not found");
    const project = this.db.getProject(agent.projectId);
    if (!project) throw new Error("project not found");
    const config = resolveConfig(project.config);
    // Explicit 'manager' role from the caller (scheduler/REST) ALWAYS wins; the profile (if any) only
    // layers its prompt + allowDelta. No profile ⇒ byte-identical to today's manager spawn.
    const { role, startupPrompt, permission, browserTesting, documentConversion, capabilities, restrictedTools, noCommit, model, skills, connections, vaultWrite } = this.resolveAgentSpawn(agent, config, "manager");

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
      capabilities, // profile-pinned registry-capability grants, pinned on the row ([] ⇒ today's behavior)
      restrictedTools,
      noCommit, // declared no-commit role, pinned on the row (lifecycle-only; false ⇒ today's behavior)
      skills, // profile-pinned skill subset, pinned on the row (null ⇒ deliver all — today's behavior)
      connections, // profile-pinned authenticated-egress allowlist, pinned on the row ([] ⇒ no access)
      vaultWrite, // profile-pinned confined vault-write grant, pinned on the row (false ⇒ no access)
      scheduledSpawn: !!opts?.scheduled, // card 53edd8d5: true ONLY for the Scheduler's own spawn call
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
      codescapeEnabled: config.codescape.enabled, // card C2: Codescape MCP wiring, per-project opt-in
      projectId: project.id,
      // PL Auditor finding #8: MANAGERS ONLY get a "Where things live" pre-block (absolute repo+vault
      // roots) so a cold-boot orchestrator reads its resume doc by absolute path instead of Globbing.
      // vaultPath is passed here UNGATED by docLint — the orchestrator needs the location regardless of
      // whether the vault-lint hook is on. Additive to the manager prompt only; every other spawn path
      // is untouched (byte-identical).
      // Project memory (card 2fd9abf9, fresh-spawn half) appended LAST, after the scheduled-prompt
      // composition — search text is the schedule's own prompt when present, else the agent's own
      // startup prompt (both empty ⇒ pinned-only). null (no notes) ⇒ the scheduled prompt is passed
      // through UNCHANGED — byte-identical to today.
      startupPrompt: ((): string | undefined => {
        const scheduled = appendScheduledPrompt(
          composeManagerStartupPrompt(startupPrompt, { repoPath: project.repoPath, vaultPath: project.vaultPath, name: project.name, referenceRepos: project.referenceRepos, resumeDocFilename: config.orchestration.resumeDocFilename }),
          prompt,
        );
        const projectMemoryFramed = retrieveProjectMemoryForKickoff(this.db, project.id, prompt ?? startupPrompt ?? "");
        // Card ea648f89: stamp the dedup map so this manager's FIRST resume compares against what this
        // fresh spawn just showed it (see stampProjectMemoryDigest's own doc).
        this.stampProjectMemoryDigest(session.id, projectMemoryFramed);
        return projectMemoryFramed ? appendMemoryRecallToStartupPrompt(scheduled ?? "", projectMemoryFramed) : scheduled;
      })(),
      role,
      browserTesting,
      documentConversion,
      capabilities, // agent-tooling P4: registry-capability grants beyond the two booleans above
      restrictedTools,
      model, // profile-pinned model → `--model` (undefined ⇒ no `--model`, byte-identical to today)
      skills, // profile-pinned skill subset → injectSkills delivers only these (null ⇒ all, byte-identical)
      sessionName: composeRoleSessionName("manager", project.name), // card f9b47cd1: `loom-<project>-mgr`
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
    const { role, startupPrompt, permission, browserTesting, documentConversion, capabilities, restrictedTools, noCommit, model, skills, connections, vaultWrite } = this.resolveAgentSpawn(agent, config, "platform");

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
      capabilities, // profile-pinned registry-capability grants, pinned on the row ([] ⇒ today's behavior)
      restrictedTools,
      noCommit, // declared no-commit role, pinned on the row (lifecycle-only; false ⇒ today's behavior)
      skills, // profile-pinned skill subset, pinned on the row (null ⇒ deliver all — today's behavior)
      connections, // profile-pinned authenticated-egress allowlist, pinned on the row ([] ⇒ no access)
      vaultWrite, // profile-pinned confined vault-write grant, pinned on the row (false ⇒ no access)
    };
    this.db.insertSession(session);
    // M5: flip to live BEFORE wiring the pty so a fast-failing spawn's onExit always wins.
    this.db.setProcessState(session.id, "live");
    // Card 2fed1663: a fresh Spawn always opens a NEW lineage (no recycledFrom yet) — its own id IS the
    // lineageId. Resolve the (base or per-lineage, seeded-if-absent) resume-doc path and inject it as a
    // "Where things live" pre-block, mirroring the manager's composeManagerStartupPrompt seam.
    const leadResumeDocPath = resolvePlatformLeadResumeDocPath(this.db, project.vaultPath, session.id);
    const resumeDocNotes = composeResumeDocOperationalNotes(project.vaultPath, leadResumeDocPath);
    this.pty.spawn({
      sessionId: session.id,
      cwd: session.cwd,
      permission,
      geometry: config.pty,
      sessionEnv: config.sessionEnv,
      vaultPath: config.docLint ? project.vaultPath : undefined, // Pillar D: scope the vault-lint hook
      codescapeEnabled: config.codescape.enabled, // card C2: Codescape MCP wiring, per-project opt-in
      projectId: project.id,
      startupPrompt: composePlatformLeadStartupPrompt(startupPrompt, leadResumeDocPath, resumeDocNotes),
      role,
      browserTesting,
      documentConversion,
      capabilities, // agent-tooling P4: registry-capability grants beyond the two booleans above
      restrictedTools,
      model, // profile-pinned model → `--model` (undefined ⇒ no `--model`, byte-identical to today)
      skills, // profile-pinned skill subset → injectSkills delivers only these (null ⇒ all, byte-identical)
      sessionName: PLATFORM_LEAD_SESSION_NAME, // card f9b47cd1: "loom-lead" — no project segment
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
   *
   * `prompt` is an OPTIONAL per-schedule custom task description (mirrors startManager) — appended via
   * `appendScheduledPrompt` AFTER the agent's own startupPrompt. Undefined/null ⇒ byte-identical to today.
   */
  startAuditor(agentId: string, prompt?: string | null): Session {
    const agent = this.db.getAgent(agentId);
    if (!agent) throw new Error("agent not found");
    const project = this.db.getProject(agent.projectId);
    if (!project) throw new Error("project not found");
    const config = resolveConfig(project.config);
    // Explicit 'auditor' role from the caller ALWAYS wins; the profile (if any) only layers its prompt +
    // allowDelta. The locked role — NOT the profile role — drives the restricted loom-audit surface.
    const { role, startupPrompt, permission, browserTesting, documentConversion, capabilities, restrictedTools, noCommit, model, skills, connections, vaultWrite } = this.resolveAgentSpawn(agent, config, "auditor");
    const codescapeEnabled = config.codescape.enabled; // card C2: Codescape MCP wiring, per-project opt-in

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
      capabilities, // profile-pinned registry-capability grants, pinned on the row ([] ⇒ today's behavior)
      restrictedTools,
      noCommit, // declared no-commit role, pinned on the row (lifecycle-only; false ⇒ today's behavior)
      skills, // profile-pinned skill subset, pinned on the row (null ⇒ deliver all — today's behavior)
      connections, // profile-pinned authenticated-egress allowlist, pinned on the row ([] ⇒ no access)
      vaultWrite, // profile-pinned confined vault-write grant, pinned on the row (false ⇒ no access)
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
      codescapeEnabled, projectId: project.id, // card C2: Codescape MCP wiring
      startupPrompt: appendScheduledPrompt(startupPrompt, prompt),
      role,
      browserTesting,
      documentConversion,
      capabilities, // agent-tooling P4: registry-capability grants beyond the two booleans above
      restrictedTools,
      model, // profile-pinned model → `--model` (undefined ⇒ no `--model`, byte-identical to today)
      skills, // profile-pinned skill subset → injectSkills delivers only these (null ⇒ all, byte-identical)
      sessionName: composeRoleSessionName("auditor", project.name), // card f9b47cd1: `loom-<project>-audit`
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
   *
   * `prompt` is an OPTIONAL per-schedule custom task description (mirrors startManager/startAuditor) —
   * appended via `appendScheduledPrompt` AFTER the agent's own startupPrompt. Undefined/null ⇒
   * byte-identical to today.
   */
  startWorkspaceAuditor(agentId: string, prompt?: string | null): Session {
    const agent = this.db.getAgent(agentId);
    if (!agent) throw new Error("agent not found");
    const project = this.db.getProject(agent.projectId);
    if (!project) throw new Error("project not found");
    const config = resolveConfig(project.config);
    // Explicit 'workspace-auditor' role from the caller ALWAYS wins; the profile (if any) only layers its
    // prompt + allowDelta. The locked role — NOT the profile role — drives the loom-user-audit surface.
    const { role, startupPrompt, permission, browserTesting, documentConversion, capabilities, restrictedTools, noCommit, model, skills, connections, vaultWrite } = this.resolveAgentSpawn(agent, config, "workspace-auditor");
    const codescapeEnabled = config.codescape.enabled; // card C2: Codescape MCP wiring, per-project opt-in

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
      capabilities, // profile-pinned registry-capability grants, pinned on the row ([] ⇒ today's behavior)
      restrictedTools,
      noCommit, // declared no-commit role, pinned on the row (lifecycle-only; false ⇒ today's behavior)
      skills, // profile-pinned skill subset, pinned on the row (null ⇒ deliver all — today's behavior)
      connections, // profile-pinned authenticated-egress allowlist, pinned on the row ([] ⇒ no access)
      vaultWrite, // profile-pinned confined vault-write grant, pinned on the row (false ⇒ no access)
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
      codescapeEnabled, projectId: project.id, // card C2: Codescape MCP wiring
      startupPrompt: appendScheduledPrompt(startupPrompt, prompt),
      role,
      browserTesting,
      documentConversion,
      capabilities, // agent-tooling P4: registry-capability grants beyond the two booleans above
      restrictedTools,
      model, // profile-pinned model → `--model` (undefined ⇒ no `--model`, byte-identical to today)
      skills, // profile-pinned skill subset → injectSkills delivers only these (null ⇒ all, byte-identical)
      sessionName: composeRoleSessionName("workspace-auditor", project.name), // card f9b47cd1: `loom-<project>-wsaudit`
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
    const { role, startupPrompt, permission, browserTesting, documentConversion, capabilities, restrictedTools, noCommit, model, skills, connections, vaultWrite } = this.resolveAgentSpawn(agent, config, "setup");

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
      capabilities, // profile-pinned registry-capability grants, pinned on the row ([] ⇒ today's behavior)
      restrictedTools,
      noCommit, // declared no-commit role, pinned on the row (lifecycle-only; false ⇒ today's behavior)
      skills, // profile-pinned skill subset, pinned on the row (null ⇒ deliver all — today's behavior)
      connections, // profile-pinned authenticated-egress allowlist, pinned on the row ([] ⇒ no access)
      vaultWrite, // profile-pinned confined vault-write grant, pinned on the row (false ⇒ no access)
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
      codescapeEnabled: config.codescape.enabled, projectId: project.id, // card C2
      startupPrompt,
      role,
      browserTesting,
      documentConversion,
      capabilities, // agent-tooling P4: registry-capability grants beyond the two booleans above
      restrictedTools,
      model, // profile-pinned model → `--model` (undefined ⇒ no `--model`, byte-identical to today)
      skills, // profile-pinned skill subset → injectSkills delivers only these (null ⇒ all, byte-identical)
      sessionName: composeRoleSessionName("setup", project.name), // card f9b47cd1: `loom-<project>-setup`
    });
    return { ...session, processState: "live" };
  }

  /**
   * Start a NEW ELEVATED OPERATOR session in an agent (Bucket 2b "Bounded Elevated Operator"). Shaped like
   * startSetup but passes callerRole "operator" so the session is LOCKED to the curated, own-workspace-
   * confined loom-operator MCP surface. Because an EXPLICIT caller role ALWAYS wins in resolveAgentSpawn,
   * the session role is "operator" regardless of the agent's profile role — the gate is keyed off the
   * SESSION role (+ the LIVE platform.operatorEnabled flag, re-checked by the router itself on every
   * request), never the profile role.
   *
   * CREATE-ONLY, NOT a singleton (mirrors startWorkspaceAuditor's shape, deliberately NOT startSetup's
   * live-reuse guard): an operator is a bounded, human-invoked tool session, not a standing assistant — the
   * human may want several independent operator sessions live in the same agent (e.g. one per task), so
   * this never collapses a fresh spawn into an already-live row.
   *
   * FLAG-GATED at the CALLER (gateway REST — see isOperatorEnabled), not here: this method itself does NOT
   * re-check platform.operatorEnabled, mirroring startWorkspaceAuditor/startSetup (neither re-checks their
   * own gating condition internally either — the REST route is the single enforcement point for "may this
   * spawn happen at all"; the router's resolveRole is the SEPARATE, LIVE-read enforcement point for "may
   * this session's surface be reached right now").
   *
   * HUMAN-REST only (gateway POST /api/agents/:id/sessions {role:"operator"}, flag-gated 403 when off) —
   * no agent/MCP path mints one (session_spawn on every agent-facing surface refuses role "operator";
   * setupRoleError excludes it from the mintable profile-role allowlist). The Elevated Operator agent lives
   * wherever the human creates it (own-workspace-confined — NOT restricted to a reserved home, unlike
   * setup/workspace-auditor, since an operator is meant to act on an ORDINARY project's own tree).
   */
  startOperator(agentId: string): Session {
    const agent = this.db.getAgent(agentId);
    if (!agent) throw new Error("agent not found");
    const project = this.db.getProject(agent.projectId);
    if (!project) throw new Error("project not found");

    const config = resolveConfig(project.config);
    // Explicit 'operator' role from the caller ALWAYS wins; the profile (if any) only layers its prompt +
    // allowDelta. The locked role — NOT the profile role — drives the curated loom-operator surface.
    const { role, startupPrompt, permission, browserTesting, documentConversion, capabilities, restrictedTools, noCommit, model, skills, connections, vaultWrite } = this.resolveAgentSpawn(agent, config, "operator");

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
      capabilities, // profile-pinned registry-capability grants, pinned on the row ([] ⇒ today's behavior)
      restrictedTools,
      noCommit, // declared no-commit role, pinned on the row (lifecycle-only; false ⇒ today's behavior)
      skills, // profile-pinned skill subset, pinned on the row (null ⇒ deliver all — today's behavior)
      connections, // profile-pinned authenticated-egress allowlist, pinned on the row ([] ⇒ no access)
      vaultWrite, // profile-pinned confined vault-write grant, pinned on the row (false ⇒ no access)
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
      codescapeEnabled: config.codescape.enabled, projectId: project.id, // card C2
      startupPrompt,
      role,
      browserTesting,
      documentConversion,
      capabilities, // agent-tooling P4: registry-capability grants beyond the two booleans above
      restrictedTools,
      model, // profile-pinned model → `--model` (undefined ⇒ no `--model`, byte-identical to today)
      skills, // profile-pinned skill subset → injectSkills delivers only these (null ⇒ all, byte-identical)
      sessionName: composeRoleSessionName("operator", project.name), // card f9b47cd1: `loom-<project>-operator`
    });
    return { ...session, processState: "live" };
  }

  /** Resume an existing session — NO prompt injection. Also reused, unmodified, as the RESUME half of
   *  the companion session-control ACT lever (card 305a54fb, `session_resume`) — called with default opts
   *  (`allowSuperseded` stays false), matching every other AUTOMATIC resume caller: a companion-triggered
   *  resume never force-resurrects a recycled session out from under its live successor. Scope/roleFilter/
   *  Primitive-A enforcement live entirely in the lever (companion/capabilities.ts). */
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
      // RESUME mode convergence (card f05e4897, generalized to fresh spawns too by b99d3d67) —
      // SUPERSEDES Fix A's blind startupModeCycles:0. A `claude --resume` HONOURS `--permission-mode
      // acceptEdits` and boots at acceptEdits — the SAME gate-free mode a fresh spawn boots in
      // (probe-verified on 2.1.163; it does NOT restore the persisted mode, the opposite of Fix A's
      // premise). Both a fresh spawn AND a resume now converge via the SAME feedback-verified cycler
      // (cycleToMode in host.ts): read the footer and press Shift+Tab until it lands on the target,
      // instead of a fixed blind press count (the old blind-2 half-landed on plan on the summary-gate
      // path — the 2026-06-03 strand bug; Fix A's blind-0 left it ONE short, stuck at acceptEdits). Resume
      // passes its target here EXPLICITLY via `resumeModeTarget` — wherever a FRESH spawn of THIS config
      // lands (modeAfterCyclesFromAcceptEdits of the same startupModeCycles → auto by default), so a
      // resumed session matches a fresh one exactly. `startupModeCycles` itself is moot on this path:
      // host.ts prefers `resumeModeTarget` when set (`??`), so pin it 0 here defensively rather than
      // relying on that precedence. Read off `resumePermission` (resolveAgentSpawn's ROLE-AWARE result),
      // not the bare `config.permission` — a worker's startupModeCycles is pinned to reach `auto`
      // independent of the project's own knob (see resolveAgentSpawn), and this must match so a resumed
      // worker converges to the exact same target its fresh spawn did.
      permission: { ...resumePermission, startupModeCycles: 0 },
      resumeModeTarget: modeAfterCyclesFromAcceptEdits(resumePermission.startupModeCycles ?? 0),
      geometry: config.pty,
      sessionEnv: config.sessionEnv,
      vaultPath: config.docLint ? project.vaultPath : undefined, // Pillar D: scope the vault-lint hook
      codescapeEnabled: config.codescape.enabled, // card C2: Codescape MCP wiring, per-project opt-in
      projectId: project.id,
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
      // Carry the registry-capability grants across resume too (pinned on the row at spawn, agent-tooling
      // P4): a resumed session mounts the SAME capability MCPs, exactly as browserTesting is re-passed.
      capabilities: session.capabilities ?? [],
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
    // Project memory (card 2fd9abf9, resume half) — a DELIBERATE, DOCUMENTED exception to "resume
    // injects no prompt", exactly like the companion recall above but generalized to EVERY role (not
    // assistant-only): a long-lived worker/manager resumed after a restart would otherwise never see
    // project notes written since its last fresh spawn. Enqueued via the SAME ordinary enqueueStdin
    // turn-injection primitive — kind defaults to "warning" (operational/coalescible, never direction).
    // Search text is the resumed session's own task (title+body) when it has one bound (the richest
    // match source), else the agent's own startup prompt; both empty ⇒ pinned-only. null (no project
    // memory notes match) ⇒ no enqueue, byte-identical to today.
    //
    // Dedup gate (card ea648f89): resume() re-retrieves on EVERY resume (idle-nudge resumes, wakes, and
    // crash/restart recovery all call it), and with no change-detection that re-injected the FULL framed
    // block verbatim even when byte-identical to what this same session was already handed — observed
    // live as 3 consecutive identical injections, flagged unprompted by the resumed manager as noise.
    // Fix: hash the framed block and compare against the digest held in {@link lastProjectMemoryDigest}
    // (the in-memory dedup map, not a DB column — see its own doc comment for why); skip the enqueue when
    // unchanged. This still preserves the "sees notes written since last spawn" intent — a genuinely
    // new/edited note changes the digest and is injected — it just stops re-blasting identical content
    // every resume within the SAME daemon process.
    {
      const boundTask = session.taskId ? this.db.getTask(session.taskId) : undefined;
      const kickoffText = boundTask ? `${boundTask.title}\n${boundTask.body}` : (agent?.startupPrompt ?? "");
      const projectRecall = retrieveProjectMemoryForKickoff(this.db, session.projectId, kickoffText);
      const digest = projectRecall ? createHash("sha256").update(projectRecall).digest("hex") : null;
      if (digest !== this.lastProjectMemoryDigest.get(session.id)) {
        if (projectRecall) this.pty.enqueueStdin(session.id, projectRecall, "system");
        this.lastProjectMemoryDigest.set(session.id, digest);
      }
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
   * Companion-specific CONVERSATION-PRESERVING respawn (Companion Capability & Permission-Lever Framework
   * §6). `OrchestrationMcpRouter.buildServer` is stateless per MCP request — it re-resolves the companion's
   * grants fresh on every tool call, so a revoke/downgrade is already live with no respawn needed. What
   * ISN'T live without one is a newly-GRANTED tool-bearing lever (`sessions_status`/`decisions_list`/
   * `board_list`/`vault_lookup`, and future ACT tools): the running companion PROCESS fetched `tools/list`
   * only once, at OS-process-start (the SAME invariant `resume()`'s own comment documents —
   * `resolveAgentSpawn` runs only inside `createPty`, only from `PtyHost.spawn()`), so it has no way to
   * discover a tool it never asked for. This closes that gap WITHOUT losing the conversation: re-resolve the agent's CURRENT profile-driven
   * capability surface (the exact shape a fresh spawn would resolve), re-pin it on the session ROW, stop
   * the old OS process, then `resume(sessionId)` — which reads those SAME row fields (never re-resolving
   * the Profile — see `resume()`'s own comment) and passes `--resume <engineSessionId>` to `pty.spawn`, so
   * the SAME conversation transcript continues under the NEW tool surface.
   *
   * This is a DELIBERATE, human-triggered escape hatch (REST `POST /api/companion/:sessionId/upgrade`,
   * NEVER auto-fired from a grant write) — it does NOT change `resume()`'s general pin-forward semantics:
   * every OTHER resume/fork/recycle path still carries the row's EXISTING values forward untouched, exactly
   * as before this method existed. Re-pinning here happens BEFORE the old pty is stopped (a pure DB write
   * has no live effect on an already-running process — mirrors `setRestrictedTools`), so if an inbound chat
   * message races the stop→respawn gap and trips `withCompanionSelfHeal`'s own auto-resume
   * (companion/revive.ts, wired to this SAME `resume()`), that resume ALSO reads the already-updated row —
   * whichever resume wins (this one or the self-heal's), the outcome is identical.
   *
   * IN-FLIGHT-TURN PRESERVATION (card d88163b7): if the companion is BUSY (mid-turn) when this runs, its
   * drain surface is HELD (`pty.holdDrain`/`releaseDrain`) and it gets a short bounded wait
   * (`UPGRADE_BUSY_WAIT_MS`, on a monotonic clock) to go idle on its own before `pty.stop` is called — see
   * the wait loop's own comment below. Before this fix, a busy companion's turn was ALWAYS force-
   * interrupted immediately, silently discarding whatever it hadn't yet delivered (including an in-flight
   * `chat_reply` MCP call) with no recovery path — the AVAILABILITY-GAP fix above only ever covered a NEW
   * message racing the stop, never one the pty was already mid-reply to. A first pass at this fix (waiting
   * without holding the drain) reopened exactly that gap: the busy turn ending DURING the wait would let
   * `drainPending`'s Stop-hook auto-drain (or `enqueueStdin`'s idle-submit path) promote a queued message
   * into a fresh turn our own `pty.stop()` would then kill, uncapturable by `flushPending` since it was no
   * longer sitting in `pending` by the time we called it (CR-caught). `holdDrain` closes that: while held,
   * anything that would start a turn queues instead, so `drain()` below can always recover it.
   *
   * SCOPE (CR round 2 correction — read precisely): `holdDrain` protects MESSAGES, not the turn itself. It
   * guarantees anything QUEUED or arriving during the wait is recoverable regardless of outcome. It does
   * NOT guarantee the busy turn survives — a turn STILL busy when `UPGRADE_BUSY_WAIT_MS` expires is STILL
   * force-interrupted below, and its own in-flight reply is STILL lost, same as pre-fix. The wait only
   * helps when the turn finishes naturally within the bound; see the wait loop's own comment for that
   * trade.
   *
   * AVAILABILITY-GAP MESSAGE PRESERVATION (CR fix): `pty.stop("graceful")` marks the pty `stopping` but
   * leaves it alive for up to several seconds while it winds down — an inbound chat message that lands in
   * that window is NOT treated as "session dead" (so `withCompanionSelfHeal` never fires), it's HELD in the
   * pty's in-memory FIFO instead. Left alone, the old process's own exit unconditionally WIPES that FIFO
   * (`pty/host.ts`'s `onExit`), silently losing the message — this mirrors `recycleWorker`'s own
   * `flushPending`-before-stop pattern (same file), except the recipient session id is UNCHANGED here (a
   * respawn, not a new session), so the captured entries are simply re-submitted onto the SAME session once
   * it's live again. `flushPending` is drained repeatedly through the wait loop (not just once up front) so
   * a message that arrives WHILE the pty is stopping-but-still-alive is caught too — bounding the genuinely
   * unrecoverable loss window to under one poll tick (~100ms, immediately before the process actually
   * exits) instead of the full multi-second graceful/hard-stop wait. A durable recipient message (one
   * carrying `onDeliver` — e.g. a Platform Lead `session_message` mid-flight) is deliberately SKIPPED on
   * redelivery: `resume()`'s own `redriveUndeliveredMessagesForRecipient` already re-delivers it, so
   * redelivering it here too would double it (mirrors `getPersistablePending`'s dedup reasoning). If the pty
   * never dies in time and this method aborts, `carried` is pushed BACK onto the still-alive old pty (every
   * entry, durable or not — resume() never ran, so nothing else will redeliver them) rather than dropped.
   *
   * SELF-HEAL RACE (CR fix): `isAlive(sessionId)` is LATCHED, not re-read, once observed false. A fresh
   * self-heal (companion/revive.ts's `withCompanionSelfHeal`, wired to this SAME `resume()`) runs OUTSIDE
   * this controller's serialization and can respawn a NEW pty for this session the instant the OLD one dies
   * — re-reading `isAlive()` afterward would see that fresh pty and wrongly conclude "still alive, needs a
   * hard stop," killing it out from under an in-flight reply and respawning a THIRD time. Once `died` is
   * latched true, every later decision (the hard-stop escalation, the "didn't stop in time" abort) is gated
   * on that latch alone — never on another `isAlive()` call — so a concurrent self-heal is simply absorbed:
   * our own `resume()` below short-circuits on ITS OWN isAlive check (service.ts's resume(), "already-live"
   * guard) and returns the self-healed session as-is. That's what makes "whichever resume wins, identical
   * outcome" (above) actually hold.
   */
  async upgradeCompanionCapabilities(sessionId: string): Promise<Session> {
    const session = this.db.getSession(sessionId);
    if (!session) throw new Error("session not found");
    if (session.role !== "assistant") throw new Error("only a companion (assistant-role) session can be live-upgraded");
    if (!session.engineSessionId) throw new Error("session has no engine id to resume — it has never completed a fresh spawn");
    const project = this.db.getProject(session.projectId);
    if (!project) throw new Error("project not found");
    const agent = this.db.getAgent(session.agentId);
    if (!agent) throw new Error("agent not found");
    const config = resolveConfig(project.config);
    // Force role "assistant" (the row's own, immutable role) rather than trusting session.role blindly —
    // mirrors composeCompanionReinjectPrompt's explicitRole pattern. Model/prompt are discarded here (only
    // the capability surface matters); resume() below never threads --model or injects a startup prompt.
    // `connections`/`vaultWrite` ARE re-pinned in the row write below (card 1a048349), same as every other
    // field here — but for a DIFFERENT reason than the rest of the surface. Every other field is a
    // spawn-time property (argv/`--allowedTools`) that needs the RESPAWN below to take live effect.
    // `connections`/`vaultWrite` are the opposite: `mcp/server.ts`'s TaskMcpRouter is stateless and
    // re-resolves them off THIS ROW fresh on every request, never threading either through `pty.spawn` or
    // `resume()` at all — so the row write alone already takes effect on the companion's very next tool
    // call, respawn or not. They're written here anyway (not via a separate live-effect-only path) purely
    // because this is the one place that re-pins the whole surface from a single `resolveAgentSpawn` call —
    // sourced from the human-set Profile, never from agent input, same as every other field here.
    const { browserTesting, documentConversion, capabilities, restrictedTools, noCommit, skills, connections, vaultWrite } =
      this.resolveAgentSpawn(agent, config, "assistant");
    this.db.setSessionCapabilitySurface(sessionId, { browserTesting, documentConversion, capabilities, restrictedTools, noCommit, skills, connections, vaultWrite });
    const carried: QueuedMessage[] = [];
    const drain = (): void => { carried.push(...this.pty.flushPending(sessionId)); };
    if (this.pty.isAlive(sessionId)) {
      // Card d88163b7 (CR fix): HOLD the drain surface for this session's ENTIRE stop sequence below —
      // BEFORE the busy-wait even starts. Without this, the wait could observe the ACTIVE turn end
      // mid-wait: the Stop hook's `drainPending` runs SYNCHRONOUSLY (the M2 invariant) and would splice a
      // QUEUED message OUT of `live.pending` and submit it as a fresh turn before our next poll even runs —
      // invisible to `flushPending`/`drain()` below (it's no longer in `pending`), and then killed by
      // `pty.stop()` anyway. Worse, a brand-new inbound message arriving during the wait's momentarily-idle
      // gap would hit `enqueueStdin`'s idle-submit path and become a turn WITHOUT ever entering `pending`
      // at all. `holdDrain` forces BOTH paths to queue instead — exactly where `drain()` below can recover
      // them. Released in `finally` — including on the "didn't stop in time" abort/throw path below, or
      // this session's drain stays wedged shut forever (a worse bug than the one this fixes).
      this.pty.holdDrain(sessionId);
      try {
        // Give an ACTIVE turn a short bounded window to finish naturally before we force-interrupt it. A
        // companion mid-turn — possibly with a `chat_reply` MCP call already dispatched — that gets
        // Ctrl-C'd below loses that turn outright: nothing recaptures it, since `flushPending` only
        // recovers messages still QUEUED, never one already handed to the pty as a turn in progress (see
        // the AVAILABILITY-GAP comment above — it's scoped to a NEW inbound message racing the stop, not
        // an ALREADY-IN-FLIGHT one). Most real turns settle within a couple seconds of a tool call; if
        // this one does too, `pty.stop` below lands on an already-IDLE session — the clean, no-interrupt
        // exit `stop()`'s own comment describes ("double Ctrl-C exits an IDLE claude"). If it's still busy
        // past the bound — a genuinely long turn, OR a STALE busy that only the multi-minute self-heal
        // watchdog (`healIfStuck`) would otherwise clear — fall through to the SAME forced interrupt this
        // method has always done. HONEST SCOPE OF WHAT `holdDrain` FIXES (CR round 2 correction — do not
        // read this as "the wait is loss-free, so raise the bound freely"): `holdDrain` only protects
        // MESSAGES QUEUED (or arriving) DURING the wait — those are captured by `drain()` below and never
        // silently dropped, regardless of whether the bound is hit. It does NOT protect the busy turn
        // ITSELF — a turn STILL busy when the bound expires is STILL force-interrupted here exactly as
        // before this fix, and its in-flight reply (e.g. a dispatched-but-unfinished `chat_reply`) is
        // STILL lost. So `UPGRADE_BUSY_WAIT_MS` is a genuine trade: a longer bound catches more real
        // in-flight turns before they're cut off, at the cost of a longer REST "Save" hang; it is NOT a
        // free knob now that queuing is safe. Kept at ~3s for REST responsiveness — see the constant's own
        // doc for the full rationale. Either way (interrupted or not), the REST caller is never blocked
        // longer than this bound and an upgrade can never be permanently refused. Bounded on a MONOTONIC
        // clock, not an iteration count — under event-loop load (e.g. the Stop hook's own synchronous
        // multi-MB JSONL tail-read) a 100ms `setTimeout` can run long, and counting iterations as if each
        // were exactly 100ms would silently overshoot the intended wall-clock bound.
        const waitDeadline = performance.now() + UPGRADE_BUSY_WAIT_MS;
        while (this.pty.isBusy(sessionId) && performance.now() < waitDeadline) {
          await new Promise((r) => setTimeout(r, 100));
          if (!this.pty.isAlive(sessionId)) break; // died on its own mid-wait — nothing left to interrupt
        }
        drain(); // anything queued (incl. anything the hold kept OUT of a fresh turn) before we stop
        this.pty.stop(sessionId, "graceful");
        let died = false;
        for (let i = 0; i < 80 && !died; i++) {
          if (!this.pty.isAlive(sessionId)) { died = true; break; } // LATCH — never re-derive from a later read
          drain(); // anything enqueued while the pty is "stopping" (held, not treated as dead — see above)
          await new Promise((r) => setTimeout(r, 100));
        }
        drain();
        if (!died) {
          // eslint-disable-next-line no-console
          console.warn(`[companion] upgrade ${sessionId}: still alive ~8s after a graceful stop — forcing a hard stop before resume`);
          this.pty.stop(sessionId, "hard");
          for (let i = 0; i < 20 && !died; i++) {
            if (!this.pty.isAlive(sessionId)) { died = true; break; } // same latch, same reasoning
            drain();
            await new Promise((r) => setTimeout(r, 100));
          }
          drain();
        }
        if (!died) {
          // The pty is STILL alive — push everything we drained OUT of its FIFO back onto it before aborting
          // (nothing else will redeliver them; resume() below never runs on this path). The capability re-pin
          // above already landed durably — a later manual restart/resume picks it up.
          for (const msg of carried) this.pty.enqueueStdin(sessionId, msg.text, msg.source, msg.onDeliver, msg.route, msg.kind, msg.questionId, msg.ownerText);
          throw new Error("companion process did not stop in time — upgrade aborted (capability changes are saved and will apply on the next successful resume)");
        }
      } finally {
        this.pty.releaseDrain(sessionId);
      }
    }
    const resumed = this.resume(sessionId);
    // Redeliver anything captured above onto the FRESH process, in order — the old process is gone and its
    // FIFO was wiped, so without this the captured entries would simply vanish despite being "queued". A
    // durable entry (onDeliver set) is SKIPPED — resume()'s own redrive (just above) already re-delivers it;
    // redelivering it here too would double it.
    for (const msg of carried) {
      if (msg.onDeliver) continue;
      this.pty.enqueueStdin(sessionId, msg.text, msg.source, msg.onDeliver, msg.route, msg.kind, msg.questionId, msg.ownerText);
    }
    return resumed;
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
  async requestDaemonRestart(managerSessionId: string, reason: string): Promise<{ restarting: boolean; error?: string; supervisorChanged?: boolean; supervisorWarning?: string }> {
    const mgr = this.db.getSession(managerSessionId);
    if (!mgr || mgr.role !== "manager") throw new Error("only a manager can restart the daemon");
    if (!isSupervised()) {
      return { restarting: false, error: "daemon is not running under the restart supervisor (pnpm daemon:stable) — cannot self-restart. Flag that the human must restart for your merged code to go live." };
    }
    const build = await buildDaemon();
    if (build.code !== 0) {
      return { restarting: false, error: `daemon build failed — NOT restarting (your code stays un-deployed but the daemon stays up). Fix and retry:\n${build.tail}` };
    }
    // Best-effort advisory: does the diff going live touch the outer supervisor script? daemon_restart
    // re-execs only the daemon process, never the supervisor that spawned it, so a change there is
    // silently inert until a manual `pnpm daemon:stable` — flag it now so an agent never reports the
    // deploy fully live when part of it isn't. A detection failure (git unavailable/timeout) degrades
    // to `false`, never blocking the restart itself.
    const bootTime = new Date(Date.now() - process.uptime() * 1000);
    const supervisorChanged = await supervisorScriptChangedSince(bootTime);
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
    return supervisorChanged
      ? { restarting: true, supervisorChanged: true, supervisorWarning: SUPERVISOR_CHANGED_WARNING }
      : { restarting: true };
  }

  /**
   * Scoped per-project DEPLOY (the `deploy` orchestration tool; design [[Scoped Per-Project Deploy —
   * Design]], 13235b62): a manager can deploy/push its OWN project without being promoted to a
   * cross-project Lead. Mirrors `gateCommand`'s trust posture exactly:
   *
   *   - OWN-PROJECT ONLY, STRUCTURALLY: the caller passes no projectId/host/branch/repo — the project is
   *     derived server-side from the caller's OWN session (`db.getSession(managerSessionId).projectId`),
   *     so a manager can never deploy another project or an arbitrary host.
   *   - HUMAN-ONLY TO ENABLE: `deployCommand` is settable only via the human REST config path (the
   *     agent-facing validator REJECTS it — see `agentOrchestrationOverride` in mcp/platform.ts). Its
   *     presence on the resolved project config IS the owner's opt-in-once trust decision; there is no
   *     further per-deploy confirm gate here.
   *   - SHIPS INERT: no `deployCommand` configured → refuses, no host exec.
   *   - FIXED COMMAND, NO AGENT-SUPPLIED ARGS: `reason` is free text for the audit trail only; it is
   *     NEVER interpolated into the shell command that runs.
   *   - BOUNDED + NON-INTERACTIVE: runs via the SAME `runGateSequential` executor the merge gate uses
   *     (spawn, shell:true, capped at `deployCommandTimeoutMs`), in the project's own `repoPath` — never
   *     a worker worktree.
   *   - RATE-LIMITED: a per-manager-session sliding-window cap (`checkDeployRateLimit`) so a looping/
   *     compromised agent can't hammer the deploy command.
   *
   * ⚠️ TRUST BOUNDARY — HOST RCE BY DESIGN, same as confirmWorkerMerge's `gateCommand` run above:
   * `deployCommand` is an arbitrary HOST shell command run with `shell:true`. That is intentional (a real
   * deploy needs it — `git push`, a deploy script, a webhook curl) and is why it is HUMAN-set only.
   *
   * Every attempt that actually reaches host exec (i.e. wasn't refused for being unconfigured/rate-
   * limited) emits a durable `deploy` audit event under the calling manager, carrying the outcome.
   */
  async deployOwnProject(
    managerSessionId: string, reason: string,
  ): Promise<{ deployed: boolean; reason?: string; exitCode?: number | null; outputTail?: string }> {
    this.requireManager(managerSessionId, "deploy");
    const session = this.db.getSession(managerSessionId);
    const project = session ? this.db.getProject(session.projectId) : undefined;
    if (!project) throw new Error("project not found for this session");

    // RESOLVE-LIVE: read the deploy command AND its per-project timeout fresh here, so a human PATCH to
    // either takes effect with no daemon restart (mirrors confirmWorkerMerge's gate resolution). Also
    // threads the daemon-global platform override so `orchestration.maxConcurrentGates` (host-load guard,
    // card 301d8c01) resolves correctly below — that field has no per-project layer (like schedulerEnabled).
    const orchestration = resolveConfig(project.config, this.db.getPlatformConfig()).orchestration;
    const deployCommand = orchestration.deployCommand;
    if (!deployCommand) {
      return { deployed: false, reason: "no deployCommand configured for this project — ask the owner to set orchestration.deployCommand" };
    }

    if (!checkDeployRateLimit(managerSessionId, Date.now())) {
      return {
        deployed: false,
        reason: `deploy rate limit exceeded (max ${DEPLOY_RATE_LIMIT_MAX} per ${Math.round(DEPLOY_RATE_LIMIT_WINDOW_MS / 60_000)}min) — wait for the window to clear`,
      };
    }

    const runGateSeq = this.runGate ?? runGateSequential;
    // HOST-LOAD guard (card 301d8c01): queue behind any other in-flight daemon-executed heavy gate
    // rather than running alongside it unbounded. See GateSemaphore's class doc.
    const result = await this.gateSemaphore.runExclusive(
      orchestration.maxConcurrentGates, () => runGateSeq(deployCommand, project.repoPath, orchestration.deployCommandTimeoutMs),
    );
    this.db.appendEvent({
      id: randomUUID(), ts: new Date().toISOString(), managerSessionId, kind: "deploy",
      detail: {
        reason, ok: result.passed,
        ...(result.passed ? {} : {
          exitCode: result.failedStatus ?? null,
          signal: result.failedSignal ?? null,
          timedOut: result.failedTimedOut ?? false,
        }),
        ...(result.outputTail ? { outputTail: result.outputTail } : {}),
      },
    });
    return result.passed
      ? { deployed: true }
      : { deployed: false, reason: "deploy command failed", exitCode: result.failedStatus ?? null, outputTail: result.outputTail };
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
      // gate the standing-reviewer resume nudge (card b5664b5b, Problem B). `hadUnsentDraft` snapshots
      // whether its raw-terminal composer held an unsent human draft (PtyHost.isComposerDirty) — that
      // draft dies with the pty and resumeFleetOnBoot uses this to disclose the loss explicitly.
      .map((s) => ({
        sessionId: s.id, role: s.role ?? null, parentSessionId: s.parentSessionId ?? null, busy: !!s.busy,
        hadUnsentDraft: this.pty.isComposerDirty(s.id),
      }));
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
   * Card df5e37e7: shared by BOTH post-restart continuation-nudge paths (resumeFleetOnBoot's
   * daemon_restart resume AND recoverCrashOrphanedWorkers' crash-recovery resume) — each injects a
   * "continue where you left off" turn right after a resume, whose FIRST action is typically an
   * immediate loom-orchestration tool call (worker_spawn/worker_report/…). `ready` (SessionStart,
   * host.ts) only proves the TUI booted — it says nothing about whether the CLI's own async MCP-client
   * handshake to loom-orchestration has finished, so submitting the nudge the moment the session becomes
   * ready can race ahead of it and hard-fail with "MCP server 'loom-orchestration' is not connected"
   * (observed after a fleet-wide daemon_restart, where many sessions' MCP handshakes contend at once).
   * Delays only the STDIN DELIVERY of the nudge via PtyHost.waitForMcpSeen — bounded + NEVER-rejecting,
   * so `.then()` firing unconditionally is always safe; the `.catch` here is belt-and-suspenders against
   * enqueueStdin itself throwing (the M1/M2 invariant guards) rather than against the wait ever rejecting.
   * A session that died mid-wait resolves the wait `false` (host.ts pty.onExit) and enqueueStdin then
   * no-ops safely on the dead session (`!live?.alive` check) — no throw either way. Callers that already
   * ran `resumeOne()`/`replayPending()` synchronously before calling this keep their ordering: those ran
   * BEFORE this fires, so the pending-replay-before-nudge guarantee holds regardless of how long the wait
   * takes. Never blocks its caller's own synchronous return.
   */
  private deferredNudge(id: string, text: string): void {
    void this.pty.waitForMcpSeen(id).then(() => this.pty.enqueueStdin(id, text)).catch((e: unknown) => {
      console.warn(`[resume] deferred nudge to ${id.slice(0, 8)} failed unexpectedly: ${(e as Error)?.message ?? e}`);
    });
  }

  /**
   * Only manager/worker/assistant(Companion) sessions mount the loom-orchestration MCP server
   * (pty/host.ts buildMcpServers' `wantsOrch`) — platform/auditor/workspace-auditor/setup use their OWN
   * separate per-role MCP routers, not wired to markMcpSeen in this v1 (scoped to loom-orchestration, the
   * router implicated by the observed failure + the one carrying the state-mutating tools). Mirrors
   * buildMcpServers' role gate exactly so a future role change to either side is easy to keep in sync.
   */
  private usesOrchestrationMcp(role: SessionRole | null): boolean {
    return role === "manager" || role === "worker" || role === "assistant";
  }

  /**
   * Route a post-resume continuation nudge: deferred (see {@link deferredNudge}) for a role that mounts
   * loom-orchestration, delivered immediately (today's behavior, unchanged) for every other role — a
   * platform/auditor/workspace-auditor/setup/plain/run session would otherwise wait out the full
   * MCP_READY_TIMEOUT_MS for a `markMcpSeen` signal its own MCP route never produces.
   */
  private enqueueNudge(id: string, role: SessionRole | null, text: string): void {
    if (this.usesOrchestrationMcp(role)) this.deferredNudge(id, text);
    else this.pty.enqueueStdin(id, text);
  }

  /**
   * Boot-time fleet resume (the resume half of P1 17df54c5) — re-spawn the WHOLE captured fleet after a
   * `daemon_restart`, injecting NOTHING into the resume itself (the resume-injects-nothing invariant;
   * `resume()` passes no startupPrompt and honors the resume hardening — readiness wait, summary-gate
   * dismiss, mode convergence). Continuation NUDGES are post-resume enqueues (a resumed session gets no
   * startup prompt, so without a nudge a worker/manager would sit idle — the stranded-worker hook can't
   * catch a resume's direct setBusy(false)):
   *   - the REQUESTING manager gets its "merged code is now live — continue/verify" re-prompt;
   *   - an AFFECTED manager/platform (workers resumed alongside it, queued I/O replayed to it, an unconsumed
   *     answered question, or STRANDED board work — see strandedBoardWork) gets the full "re-check your
   *     workers" re-orient, prefixed with a one-line classification of WHAT this restart touched;
   *   - an UNAFFECTED bystander manager/platform (card 5907b71e part 1 — isNoOpManagerWake: non-causal,
   *     0 live workers in the resume set, no queued I/O replayed, no unconsumed answer, AND no stranded
   *     board work) resumes SILENTLY — NO enqueue at all (card b5664b5b Problems A + C1). The old
   *     "lightweight FYI" was still an enqueueStdin, and an enqueue to an idle session submits as a full
   *     TURN, so the FYI burned the very turn it claimed to save (the Lead, which flows through this same
   *     branch, took ~10 such wakes in one session). 61cc91c6 further narrowed "pending board work": raw
   *     backlog no longer forces the full nudge by itself — a 'watching' or 'snoozed' manager's ordinary
   *     backlog is ALREADY independently covered by the idle-watcher's own cadence regardless of this
   *     restart, so re-forcing it here was pure duplication (this was the dominant source of the reported
   *     waste — see strandedBoardWork's doc for the full per-role/per-policy breakdown; a platform/Lead
   *     session now gets the SAME IdleWatcher coverage a manager does — card 98b3725c — so it's classified
   *     identically, no more unconditional carve-out). Only board work NOTHING ELSE will ever re-surface (a
   *     'suppressed'-via-escalation manager OR platform/Lead) still forces the full nudge — a no-op there
   *     would strand the queue. The deploy
   *     REQUESTER is NEVER short-circuited — it always gets the full "code is live — continue/verify" nudge;
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
    //
    // kind: "agent" — the snapshot (getPersistablePending) carries only TEXT, not each entry's original
    // warning/agent classification (it predates that discriminator), and this replayed set can be a mix
    // of worker reports / manager direction (agent) and idle/resume nudges (warning) that were pending at
    // restart. Ambiguous ⇒ bias to "agent" per the classification's own rule — a warning wrongly replayed
    // one-per-turn is a few extra benign turns, never a coalesced-away agent message.
    const replayPending = (id: string): void => {
      for (const m of intent.pending?.[id] ?? []) this.pty.enqueueStdin(id, m, "system", undefined, undefined, "agent");
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
    // Per-session restart impact, used by isNoOpManagerWake (restart.ts) to pick the cheap FYI vs the full
    // re-check, AND by the classification clause in the nudge text. The board/answer classification
    // (hasPendingBoardWork/hasUnconsumedAnswer/isEscalatedSuppression/isWatcherActiveForSession/
    // strandedBoardWork) is shared with Paths B/C (crash recovery) via orchestration/wake-impact.ts —
    // card c9e51581. Path A's own `causal`/`liveWorkersResumed`/`queuedIoReplayed` derivation (this
    // closure) stays local — it's specific to the RestartIntent resume-set shape.
    const wakeImpact = (id: string, role: SessionRole | null) => computeWakeImpact(this.db, id, role, {
      causal: id === reqId,
      liveWorkersResumed: liveWorkerCount(id),
      queuedIoReplayed: (intent.pending?.[id] ?? []).length,
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
      // The composer-dirty disclosure (see DRAFT_LOSS_NOTE) is ADDITIVE to whatever nudge a role already
      // gets — appended when one is enqueued below, or sent standalone when a role's classification would
      // otherwise stay silent (a lost draft is new, actionable information distinct from board-impact
      // classification, so it is never suppressed by the no-op/idle/no-nudge branches below).
      const draftNote = e.hadUnsentDraft ? DRAFT_LOSS_NOTE : "";
      if (e.role === "worker") {
        this.enqueueNudge(
          e.sessionId, e.role,
          `[loom:daemon-restarted] The daemon was rebuilt + restarted and you were resumed — your worktree ` +
          `WIP is intact. Continue your assigned task from where you left off. If you had already finished, ` +
          `call worker_report (done/blocked) so your manager isn't left waiting.` + RESUME_NUDGE_TAIL + draftNote,
        );
      } else if (e.role === "manager" || e.role === "platform") {
        const impact = wakeImpact(e.sessionId, e.role);
        // The reason names the SHA — record it so a later completion escalation for the same SHA is a
        // recognized duplicate (part 2). Done for BOTH wake kinds: an unaffected bystander still "saw" it.
        this.recordDeployShasDelivered(e.sessionId, reasonShas);
        if (isNoOpManagerWake(impact)) {
          // card b5664b5b (Problems A + C1), narrowed further by 61cc91c6: a non-causal bystander this
          // restart did NOT touch (no workers resumed, no queued I/O, no unconsumed answer, no STRANDED
          // board work) resumes SILENTLY — NO enqueue. The old "lightweight FYI" was still an enqueueStdin,
          // and an enqueue to an idle session is submitted as a full TURN, so the FYI burned the very turn
          // it claimed to save (the Lead took ~10 such wakes in one session). `!strandedBoardWork` no
          // longer requires an EMPTY board — a 'watching'/'snoozed' manager's ordinary backlog is already
          // covered by the idle-watcher's own cadence regardless of this restart, so forcing a turn for it
          // here is pure duplication; only board work NOTHING ELSE will re-surface (a 'suppressed'-via-
          // escalation manager, or any platform/Lead — see strandedBoardWork) still forces it. A merely
          // PENDING (unanswered) owner question still never forces a turn either — only an ANSWERED,
          // not-yet-pulled one does (hasUnconsumedAnswer), since that's genuinely new for this session.
          // EXCEPT a lost draft: that's actionable regardless of impact, so it still gets a minimal turn.
          if (draftNote) this.enqueueNudge(e.sessionId, e.role, `[loom:daemon-restarted] You were resumed.${draftNote}`);
        } else {
          // Affected (workers resumed, queued I/O replayed, an unconsumed answer, or stranded board work)
          // → the full re-orient, with a one-line classification of WHAT this restart touched so the
          // manager re-checks precisely.
          const affected = [
            impact.liveWorkersResumed > 0 ? `${impact.liveWorkersResumed} of your live workers were resumed` : null,
            impact.queuedIoReplayed > 0 ? `${impact.queuedIoReplayed} queued message(s) were replayed to you` : null,
            impact.hasUnconsumedAnswer ? `you have an answered question awaiting question_pull` : null,
            impact.strandedBoardWork ? `your board has pending work` : null,
          ].filter(Boolean).join("; ");
          if (e.role === "platform") {
            // Lead-appropriate text: a Platform Lead has no worktrees and no workers, so the manager-shaped
            // "your worktrees are intact / resume orchestrating your workers" phrasing is nonsense it has to
            // reason away on EVERY restart. A Lead now gets the SAME IdleWatcher coverage a manager does
            // (card 98b3725c) — `strandedBoardWork` is no longer unconditionally true for platform sessions,
            // so this branch is reached only when the Lead genuinely has a stake in this restart, exactly
            // like a manager. Re-orient it from the board + its own living resume doc instead of the
            // manager-shaped worktree/worker phrasing.
            this.enqueueNudge(
              e.sessionId, e.role,
              `[loom:daemon-restarted] Another manager restarted the daemon (reason: ${intent.reason}) and you ` +
              `were resumed (${affected}). Re-orient from your home board and your living resume doc, then ` +
              `continue your platform work from where you left off.` + RESUME_NUDGE_TAIL + draftNote,
            );
          } else {
            this.enqueueNudge(
              e.sessionId, e.role,
              `[loom:daemon-restarted] Another manager restarted the daemon (reason: ${intent.reason}) and you ` +
              `were resumed — your worktrees are intact (${affected}). Resume orchestrating from where you left ` +
              `off (re-check your workers' state; some may have just been resumed too).` + RESUME_NUDGE_TAIL + draftNote,
            );
          }
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
          this.enqueueNudge(
            e.sessionId, e.role,
            `[loom:daemon-restarted] The daemon was rebuilt + restarted and you were resumed — continue your ` +
            `work from where you left off.` + RESUME_NUDGE_TAIL + draftNote,
          );
        } else if (draftNote) {
          // Idle-at-capture normally resumes silently (its schedule re-engages it) — but a lost draft is
          // new, actionable information a silent resume would otherwise never surface at all.
          this.enqueueNudge(e.sessionId, e.role, `[loom:daemon-restarted] You were resumed.${draftNote}`);
        }
      } else if (draftNote) {
        // role null (plain session) or "run": normally no nudge at all (no orchestration loop to re-engage)
        // — but a lost draft still needs surfacing, since nothing else will ever tell this session about it.
        // enqueueNudge's role gate never defers here (null/"run" don't mount loom-orchestration) — same as
        // today's immediate enqueueStdin.
        this.enqueueNudge(e.sessionId, e.role, `[loom:daemon-restarted] You were resumed.${draftNote}`);
      }
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
        const reqDraftNote = entries.find((e) => e.sessionId === reqId)?.hadUnsentDraft ? DRAFT_LOSS_NOTE : "";
        // card 90058589: the deploy REQUESTER is NEVER FYI-short-circuited — initiating a deploy is active
        // work, so it always gets the full "code is live — continue/verify" nudge (even at 0 live workers
        // with a stale done/waiting idle-policy, the case the old converged-FYI branch wrongly stalled).
        // The requester (RestartIntent.managerSessionId) is always a manager — mounts loom-orchestration,
        // so this nudge is deferred exactly like any other manager's (see this.deferredNudge below).
        this.deferredNudge(
          reqId,
          `[loom:daemon-restarted] Rebuild + restart complete — your merged daemon code is now LIVE in the ` +
          `running daemon (reason: ${intent.reason}). ${reqWorkersResumed}/${reqWorkers.length} of your live ` +
          `workers were resumed (the rest of the fleet across all projects was resumed too). You can now ` +
          `end-to-end verify the live behavior. Continue.` + RESUME_NUDGE_TAIL + reqDraftNote,
        );
      }
    } else {
      failed.push(reqId);
    }

    return { resumed, skippedParked, failed };
  }

  /**
   * Boot-time crash recovery ACTION (card 9fc41af5) — resumes the candidates
   * `deriveCrashOrphanedWorkers` (orchestration/crash-orphaned-workers.ts) derived from the pre-archive
   * `recoverStaleSessions()` snapshot. The caller invokes this ONLY when no RestartIntent was captured
   * this boot — the exit-75 path already recovers its own fleet (incl. these same workers) via
   * resumeFleetOnBoot, so running both would double-nudge the same sessions.
   *
   * Resumes each candidate's MANAGER first (`resume()` no-ops if already alive) — a worker whose manager
   * can't be resumed (dead transcript, gone worktree, superseded) is left UNTOUCHED in its clean
   * exited/archived state rather than half-resumed into an orphan with no live parent to see it. Once the
   * manager is live, resuming the worker itself un-archives it via the SAME `db.restoreSession()` side
   * effect `resume()` already performs — `listWorkers` (what `worker_list` reads) filters only
   * `archived_at IS NULL`, so that's the whole "re-parent": parentSessionId was never touched.
   *
   * A worker that had already reported `done` (`reportedDone`) is recovered for VISIBILITY (it reappears
   * in worker_list so the manager notices it's awaiting merge review) but does NOT get the "continue your
   * task" nudge — it isn't mid-work. Every other recovered worker gets the same "worktree WIP intact,
   * continue" nudge resumeFleetOnBoot sends. A PARKED (rate-limited) manager or worker is resumed live
   * (so the rate-limit watcher can recover it in its own time) but its nudge is WITHHELD — mirrors
   * resumeFleetOnBoot's `isParked`/`skippedParked` handling; a crash must never push a held turn back
   * into a usage-limit cap. Each affected (non-parked) manager gets ONE summary nudge naming how many of
   * its candidate workers were recovered (and how many of those are awaiting review, and how many
   * couldn't be resumed at all) — sent even when EVERY candidate worker failed to resume, so the manager
   * (already silently resumed with no other signal) still learns a crash happened and its workers didn't
   * come back, rather than sitting there with no orientation at all.
   *
   * `opts.shutdownMarker` (card be79aea2): the caller reads+consumes `last-shutdown.json` ONCE per boot,
   * unconditionally, and passes the result here. When it's a fresh clean-stop record (an OS signal or an
   * intentional `loom stop`), the preceding stop was NOT a crash — this boot only reached the crash branch
   * because a signal/service-manager stop raced ahead of a graceful session snapshot, not because anything
   * actually broke. Every `[loom:crash-recovered]` nudge below is swapped for a `[loom:daemon-restarted]`
   * clean-stop nudge in that case; `shutdownMarker` null (no marker, or the caller determined this boot
   * really is unclassified) leaves the original crash phrasing untouched.
   */
  recoverCrashOrphanedWorkers(
    candidates: CrashOrphanedWorker[],
    opts: { resumeOne?: (id: string) => boolean; now?: Date; soloManagerIds?: string[]; shutdownMarker?: ShutdownMarkerRecord | null } = {},
  ): { resumed: string[]; skippedParked: string[]; failed: string[]; managersFailed: string[] } {
    const now = opts.now ?? new Date();
    const cleanStop = !!opts.shutdownMarker; // fresh marker present ⇒ the preceding stop was NOT a crash
    // Default resumeOne LOGS the real thrown reason (dead transcript / gone worktree / recycled/…) on
    // failure instead of silently collapsing it to a bare boolean — a resume that doesn't happen must
    // never be a silent no-op (board evidence: a session was "marked dead-and-skipped" with nothing in
    // the log explaining why).
    const resumeOne = opts.resumeOne ?? ((id: string): boolean => {
      try { this.resume(id); return true; }
      catch (e) {
        console.warn(`[crash-recovery] resume(${id.slice(0, 8)}) failed: ${(e as Error).message}`);
        return false;
      }
    });
    const isParked = (id: string): boolean => {
      const s = this.db.getSession(id);
      return !!s?.rateLimitedUntil && new Date(s.rateLimitedUntil).getTime() > now.getTime();
    };
    const resumed: string[] = [];
    const skippedParked: string[] = [];
    const failed: string[] = [];
    const managersFailed: string[] = [];
    const byManager = new Map<string, CrashOrphanedWorker[]>();
    for (const c of candidates) {
      const list = byManager.get(c.managerSessionId) ?? [];
      list.push(c);
      byManager.set(c.managerSessionId, list);
    }
    // A manager whose ENTIRE worker set was excluded (legitimately terminal/recycled, or previously a
    // stale-dead worker before the derive-time fix) never appears as a `candidates` key above — seed it
    // here so it still gets ONE independent resume attempt, not silence (crash-orphaned-workers.ts ›
    // deriveCrashOrphanedManagers).
    for (const soloId of opts.soloManagerIds ?? []) {
      if (!byManager.has(soloId)) byManager.set(soloId, []);
    }
    for (const [managerId, workers] of byManager) {
      const managerParked = isParked(managerId); // read BEFORE resume — resume() never touches the park fields
      if (!resumeOne(managerId)) {
        failed.push(...workers.map((w) => w.workerSessionId));
        managersFailed.push(managerId);
        continue;
      }
      let recoveredCount = 0;
      let awaitingReviewCount = 0;
      let failedCount = 0;
      for (const w of workers) {
        const workerParked = isParked(w.workerSessionId);
        if (!resumeOne(w.workerSessionId)) { failed.push(w.workerSessionId); failedCount++; continue; }
        resumed.push(w.workerSessionId);
        recoveredCount++;
        if (workerParked) { skippedParked.push(w.workerSessionId); continue; } // resumed live; honor the park — no nudge
        if (w.reportedDone) {
          awaitingReviewCount++;
        } else {
          // Card df5e37e7: deferred (this.enqueueNudge — worker role always mounts loom-orchestration),
          // same race guard as resumeFleetOnBoot's worker nudge. Wrapped in try/catch defensively:
          // enqueueNudge's own synchronous branch (the non-deferred immediate-enqueue path for a
          // non-orchestration role) never applies here, but the deferred branch's promise chain already
          // has its own internal .catch — this try/catch is belt-and-suspenders against a synchronous
          // throw from the call itself.
          try {
            this.enqueueNudge(
              w.workerSessionId, "worker",
              cleanStop
                ? `[loom:daemon-restarted] The daemon was stopped and restarted (not a crash) — your worktree ` +
                  `WIP is intact. Continue your assigned task from where you left off. If you had already ` +
                  `finished, call worker_report (done/blocked) so your manager isn't left waiting.` + RESUME_NUDGE_TAIL
                : `[loom:crash-recovered] The daemon crashed and Loom auto-resumed you on relaunch — your ` +
                  `worktree WIP is intact. Continue your assigned task from where you left off. If you had ` +
                  `already finished, call worker_report (done/blocked) so your manager isn't left waiting.` + RESUME_NUDGE_TAIL,
            );
          } catch { /* not ready yet — the resume stands */ }
        }
      }
      if (managerParked) continue; // resumed live; honor the park — no summary nudge
      // card c9e51581 (Path B extension of 61cc91c6): a manager/platform with NO stake in this crash —
      // no crash-orphaned worker candidates (recovered or failed) alongside it, no stranded board work,
      // no unconsumed answer — resumes SILENTLY instead of burning the unconditional summary nudge below.
      // `causal:false` (a crash isn't self-requested) and `queuedIoReplayed:0` (no pre-crash FIFO snapshot
      // exists on this path — recoverUndeliveredMessagesOnBoot is the separate mechanism that covers real
      // queued messages, running independently after fleet resume). `liveWorkersResumed: workers.length`
      // (recovered + failed, not recoveredCount-only) — ANY crash-orphaned candidate at all is real stake
      // requiring the manager to re-check worker_list, even one that ultimately couldn't be resumed (using
      // recoveredCount-only would silently drop the "your workers are gone, check logs" visibility for the
      // all-failed case).
      const managerRole = this.db.getSession(managerId)?.role ?? null;
      const impact = computeWakeImpact(this.db, managerId, managerRole, {
        causal: false,
        liveWorkersResumed: workers.length,
        queuedIoReplayed: 0,
      });
      if (isNoOpManagerWake(impact)) continue;
      const tag = cleanStop ? "[loom:daemon-restarted]" : "[loom:crash-recovered]";
      const lead = cleanStop
        ? "The daemon was stopped and restarted (not a crash) and Loom resumed"
        : "The daemon crashed and Loom auto-resumed";
      const isPlatform = managerRole === "platform";
      // A solo manager (no candidate workers at all) gets a plain heads-up instead of the "0 of your 0
      // in-flight worker(s)" phrasing the per-worker summary below would otherwise produce.
      const note = workers.length === 0
        ? isPlatform
          ? `${tag} ${lead} you — re-orient from your home board and your living resume doc, then continue ` +
            `your platform work.` + RESUME_NUDGE_TAIL
          : `${tag} ${lead} you — re-check your state and continue orchestrating.` + RESUME_NUDGE_TAIL
        : (() => {
          const parts = [
            recoveredCount > 0
              ? `${recoveredCount} of your ${workers.length} in-flight worker(s) were recovered and are back in worker_list`
              : `none of your ${workers.length} in-flight worker(s) could be recovered`,
            awaitingReviewCount > 0 ? `${awaitingReviewCount} of those already reported done and are awaiting your review/merge` : null,
            failedCount > 0 ? `${failedCount} could not be resumed (check worker_list / logs)` : null,
          ].filter(Boolean).join("; ");
          return isPlatform
            ? `${tag} ${lead} it — ${parts}. Re-orient from your home board and your living resume doc, then ` +
              `continue your platform work.` + RESUME_NUDGE_TAIL
            : `${tag} ${lead} it — ${parts}. Re-check their state and continue orchestrating.` + RESUME_NUDGE_TAIL;
        })();
      // Card df5e37e7: deferred for a manager (mounts loom-orchestration); a platform manager's role
      // (managerRole === "platform") routes through enqueueNudge's non-deferred branch, unchanged.
      try {
        this.enqueueNudge(managerId, managerRole, note);
      } catch { /* not ready yet — the resume stands */ }
    }
    return { resumed, skippedParked, failed, managersFailed };
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
      // Re-driving a `session_message_queued` record — every such record originated from
      // enqueueDurableMessage's kind:"agent" enqueue, so the redrive preserves that classification.
      const r = this.pty.enqueueStdin(recipientId, text, "system", (reason?: string) => {
        this.redriveInFlightMsgIds.delete(msgId);
        this.resolveQueuedMessage(msgId, { recipientId, reason });
      }, undefined, "agent");
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
      capabilities: src.capabilities ?? [], // a fork inherits the source's registry-capability grants
      restrictedTools: src.restrictedTools ?? false, // a fork inherits the source's restricted-tools disallow
      noCommit: src.noCommit ?? false, // a fork inherits the source's declared no-commit role
      skills: src.skills ?? null, // a fork inherits the source's pinned skill subset (null ⇒ all)
      connections: src.connections ?? [], // a fork inherits the source's authenticated-egress allowlist
      vaultWrite: src.vaultWrite ?? false, // a fork inherits the source's confined vault-write grant
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
      codescapeEnabled: config.codescape.enabled, // card C2: Codescape MCP wiring, per-project opt-in
      projectId: project.id,
      resumeId: src.engineSessionId, // resume the SOURCE conversation...
      fork: true,                    // ...but fork it (--fork-session)...
      forkSessionId: forkEngineId,   // ...into this pre-assigned id (--session-id).
      role: src.role ?? undefined,
      browserTesting: src.browserTesting ?? false,
      documentConversion: src.documentConversion ?? false,
      capabilities: src.capabilities ?? [], // carry the registry-capability grants onto the fork's pty (matches the fork row)
      restrictedTools: src.restrictedTools ?? false, // carry the restricted-tools disallow onto the fork's pty (matches the fork row)
      skills: src.skills ?? null, // carry the pinned subset onto the fork's pty (matches the fork row)
    });
    // Project memory (card 2fd9abf9, fork half): --fork-session carries the SOURCE transcript forward
    // with NO startup prompt of its own (mirrors resume()'s "resume injects nothing" invariant), so
    // without this a fork would never see project notes the way resume()'s own inject already does for
    // every role. Enqueued via the SAME ordinary enqueueStdin turn-injection primitive resume() uses
    // (kind defaults to "warning", ready-gated in host.ts). Search text mirrors resume()'s own kickoffText
    // derivation — the SOURCE session's bound task (title+body), else the agent's startup prompt — since
    // the fork's own row deliberately carries no taskId (see the Session literal above; unrelated to this
    // feature, left untouched). Stamp the dedup map (card ea648f89) so this fork's OWN first resume
    // compares against what this fork spawn just showed it, exactly as recycleWorker/spawnWorker already
    // do for their fresh spawns. null (no notes match) ⇒ no enqueue, byte-identical to today.
    const forkBoundTask = src.taskId ? this.db.getTask(src.taskId) : undefined;
    const forkKickoffText = forkBoundTask ? `${forkBoundTask.title}\n${forkBoundTask.body}` : (agent?.startupPrompt ?? "");
    const forkProjectMemoryFramed = retrieveProjectMemoryForKickoff(this.db, project.id, forkKickoffText);
    if (forkProjectMemoryFramed) this.pty.enqueueStdin(session.id, forkProjectMemoryFramed, "system");
    this.stampProjectMemoryDigest(session.id, forkProjectMemoryFramed);
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
      role: "run", browserTesting: false, documentConversion: false, capabilities: [], restrictedTools: false, noCommit: false,
      skills, // profile-pinned skill subset, pinned on the row (null ⇒ deliver all — today's behavior)
      connections: [], // a run never mounts loom-tasks (buildMcpServers: ONLY loom-run), so this is moot
      vaultWrite: false, // a run never mounts loom-tasks (buildMcpServers: ONLY loom-run), so this is moot
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
      capabilities: [],
      restrictedTools: false,
      model, // profile-pinned model → `--model` (undefined ⇒ no `--model`, byte-identical to today)
      skills, // profile-pinned skill subset → injectSkills delivers only these (null ⇒ all, byte-identical)
      sessionName: composeRoleSessionName("run", project.name), // card f9b47cd1: `loom-<project>-run`
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

  /**
   * Restore an archived session back to the rail (single row — not a cascade). A session already
   * confirmed `resumability === "dead"` has nothing to resume — a pure view-only un-archive, matching
   * the Archive UI's documented "Restore (view-only)" affordance. Anything else — including a session
   * that's never been probed (the common case for a day-old archived session) — routes through the SAME
   * atomic `resume()` the live rail's Resume button uses: it validates the engine is actually alive
   * BEFORE touching `archived_at`, so a session that turns out unresumable (an expired/missing engine
   * transcript, a GC'd worktree) gets flagged dead and its `archived_at` is left untouched — it stays
   * safely IN the Archive instead of being cleared unconditionally and orphaned off both the Archive
   * (no longer archived) and the live rail (never actually resumed) — the 2026-07-15 "restore vanished
   * the session" bug. `allowSuperseded` mirrors the manual REST /resume endpoint: a human restoring from
   * the Archive may deliberately force-resurrect a recycled predecessor.
   */
  restoreSession(sessionId: string): { restored: string } {
    const s = this.db.getSession(sessionId);
    if (!s) throw new Error("session not found");
    if (s.resumability === "dead") {
      this.db.restoreSession(sessionId);
      return { restored: sessionId };
    }
    this.resume(sessionId, { allowSuperseded: true });
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
      this.lastProjectMemoryDigest.delete(id); // bound the resume-dedup map's growth (card ea648f89)
    }
    return { deleted: ids };
  }

  /**
   * Card f9b47cd1: the session names THIS manager's LIVE worker siblings would compute to (RECOMPUTED
   * fresh each call, never stored — see composeWorkerSessionName's doc) — consulted ONLY to detect a
   * naming collision before a fresh/recycled worker's own `-n` name is finalized ("if two live cards
   * slugify identically, append the 4-char task-id" per the card). Scoped to the SAME manager (not
   * project-wide): the manager's own fleet is where a same-agent, similarly-titled dispatch is most
   * likely, and `listWorkers(managerSessionId)` is the exact query spawnWorker already runs for its
   * concurrency-cap check.
   *
   * `excludeIds` MUST include the CALLER'S OWN fresh session id — spawnWorker/recycleWorker both insert +
   * flip their fresh row `live` BEFORE computing the collision set (M5: flip-live-before-pty is load-
   * bearing elsewhere too), so `listWorkers` already returns that fresh row by the time this runs; without
   * excluding it explicitly, a worker always "collides with itself" and every worker gets a spurious
   * suffix (code review finding on the first cut of this — the fresh id was left to be implicitly excluded
   * by insert-ordering, which insert-ordering doesn't actually guarantee). recycleWorker additionally
   * excludes the PREDECESSOR (its row can still show `live` mid-teardown) — its name must never count
   * as its own successor's collision either.
   */
  private siblingWorkerSessionNames(managerSessionId: string, projectName: string, excludeIds: ReadonlySet<string>): Set<string> {
    const names = new Set<string>();
    for (const w of this.db.listWorkers(managerSessionId)) {
      if (w.processState !== "live" || excludeIds.has(w.id)) continue;
      const wAgent = this.db.getAgent(w.agentId);
      if (!wAgent) continue;
      const wTask = w.taskId ? this.db.getTask(w.taskId) : null;
      names.add(composeWorkerSessionName(projectName, wAgent.name, wTask?.title ?? null, w.id));
    }
    return names;
  }

  /**
   * Spawn a WORKER for a manager (phase-2 §A2/§A5): create an isolated git worktree+branch,
   * start a real worker `claude` in it (the existing spawn path — workers get loom-tasks scoped
   * to their own session→project, NOT the orchestration surface), and move the task to
   * in_progress. The worktree's lifecycle is owned by merge/recycle, not stop.
   */
  async spawnWorker(
    managerSessionId: string,
    opts: { taskId?: string; agentId?: string; kickoffPrompt: string },
    /** INTERNAL — set ONLY by {@link maybeDrainCapQueue}'s own re-call of this method. `skipCapQueueRecord`
     *  suppresses the normal cap-reject `record()` call (see {@link CapQueueRejectedError}'s doc for why:
     *  the drain already holds the original popped entry and re-queues THAT itself, preserving its opId/
     *  FIFO position instead of letting a fresh `record()` mint a new one at the back). Every OTHER caller
     *  (worker_spawn/spawnWorkerTracked) omits this — byte-identical cap-reject behavior for them. */
    internal?: { skipCapQueueRecord?: boolean },
  ): Promise<Session & { shippedMatch: ShippedCardMatch | null; reusedDirtyWorktree?: ReusedDirtyWorktreeInfo }> {
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
    // pasted id with stray whitespace normalizes), reject a whitespace-containing id, then require the id to
    // resolve to a REAL, NON-terminal task IN THIS PROJECT — a truncated/malformed/unknown id won't resolve
    // and is rejected with the same "does not resolve" shape the agentId guard uses. A bad id must create
    // NOTHING.
    // card 3e9e1d9f: taskId accepts EITHER a full id or an unambiguous 8-char id-PREFIX (resolveIdPrefix) —
    // the same UX the agentId path above already has. An exact match still wins first (the common case
    // avoids materializing the project's task list); a miss falls back to prefix-scanning THIS manager's
    // OWN project's tasks (db.listTasks(manager.projectId)), so a cross-project id can never match. An
    // ambiguous prefix names the candidate ids and spawns nothing, mirroring the agentId ambiguity error.
    //
    // TASKLESS SPAWN (card 2514e6e1 / 72ee0bcf): an EMPTY/omitted taskId is no longer rejected — it opts
    // INTO a taskless worker instead (an ad-hoc spike/no-commit-review spawn with no board card to
    // falsify or hijack). `taskId` stays `null` for the rest of this method in that case, which every
    // downstream taskId-gated step below (terminal/held/live-holder guards, the board move, the event's
    // taskId) already treats as "no task" — this is the ONLY branch point; nothing downstream needs its
    // own taskless special-case beyond the `if (taskId)` guards already in place.
    const taskRef = (opts.taskId ?? "").trim();
    let taskId: string | null = null;
    let taskTitle: string | null = null; // captured for the shipped-card advisory check below (tasked spawns only)
    if (taskRef) {
      if (/\s/.test(taskRef)) throw new Error(`worker_spawn taskId '${opts.taskId}' is not a valid task id`);
      const exactTask = this.db.getTask(taskRef);
      let task = exactTask && exactTask.projectId === manager.projectId ? exactTask : undefined;
      if (!task) {
        const resolvedTask = resolveIdPrefix(this.db.listTasks(manager.projectId), taskRef);
        if (resolvedTask.kind === "ambiguous") {
          throw new Error(`worker_spawn taskId '${taskRef}' is an ambiguous id-prefix — it matches ${resolvedTask.ids.join(", ")}; pass more characters or the full id`);
        }
        if (resolvedTask.kind === "found") task = resolvedTask.record;
      }
      if (!task) throw new Error(`worker_spawn taskId '${taskRef}' does not resolve to an existing task in this project`);
      taskId = task.id;
      taskTitle = task.title;
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
      // ONLY reached for a REAL taskId — a taskless spawn (this whole `if` skipped) never competes for this
      // guard at all, so it can never be used to bypass it for a committing worker (the guard stays fully
      // intact for every normal tasked spawn). A read-only reviewer that wants to look at a live author's
      // branch spawns TASKLESS instead (its kickoff names the author's branch; it gets its OWN fresh worktree
      // below, so it can never share/clobber the author's checkout) rather than attaching to the author's
      // taskId, which is what used to force minting a throwaway vehicle card.
      const liveHolder = this.db.liveSessionIdForTask(taskId);
      if (liveHolder) {
        throw new Error(`worker_spawn taskId '${taskId}' already has a live worker (${liveHolder}); stop or recycle it before re-spawning`);
      }
    }
    // Resolve THAT agent's profile for its browser-automation opt-in + skill subset — a manager spawns a
    // QA worker by pointing it at a browserTesting profile (e.g. the bundled "QA Tester"). Explicit role is
    // "worker"; we read browserTesting + skills (permission stays config.permission, byte-identical to
    // today). A worker runs in its OWN worktree (separate cwd), so its subset is delivered EXACTLY.
    const workerSpawn = this.resolveAgentSpawn(workerAgent, config, "worker");
    const browserTesting = workerSpawn.browserTesting;
    const documentConversion = workerSpawn.documentConversion;
    const capabilities = workerSpawn.capabilities; // registry-capability grants (profile-pinned; [] ⇒ none)
    const restrictedTools = workerSpawn.restrictedTools; // curated dangerous-native-tool disallow (blast-radius control)
    const noCommit = workerSpawn.noCommit; // declared no-commit role (e.g. a Code Reviewer rig) — lifecycle-only
    const skills = workerSpawn.skills;
    const connections = workerSpawn.connections; // authenticated-egress allowlist (profile-pinned; [] ⇒ no access)
    const vaultWrite = workerSpawn.vaultWrite; // confined vault-write grant (profile-pinned; false ⇒ no access)

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
    //
    // TASKLESS CLAIM KEY: a taskless spawn (taskId null) has no real task to claim mutual exclusion over —
    // and shouldn't: distinct taskless spawns (two spikes, or a CR reviewing branch A while another reviews
    // branch B) must be free to run CONCURRENTLY, each in its own worktree, never serialized against each
    // other the way two spawns racing for the SAME task must be. So a taskless spawn claims a FRESH
    // per-call id instead of `taskId` — `.has()` on a fresh randomUUID() is always false (never falsely
    // rejects), while `.add()`/`.size` still reserve it for the concurrency-cap admit below, so an in-flight
    // taskless spawn still counts against the cap exactly like a tasked one. A real taskId's claimKey is
    // just `taskId` itself — BYTE-IDENTICAL to the pre-taskless-spawn behavior for every tasked call.
    const claimKey = taskId ?? randomUUID();
    if (this.inFlightSpawnTaskIds.has(claimKey)) {
      throw new Error(`worker_spawn taskId '${claimKey}' already has a spawn in flight; wait for it to finish before re-spawning`);
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
    if (liveWorkers + this.inFlightSpawnTaskIds.size >= cap) {
      // internal.skipCapQueueRecord (maybeDrainCapQueue's own re-call): the caller already holds the
      // ORIGINAL popped entry and re-queues THAT at the front itself — record()-ing a fresh one here would
      // mint a new opId at the BACK of the queue, demoting it behind younger entries and invalidating any
      // worker_stop({opId}) already held for it (see CapQueueRejectedError's doc).
      if (internal?.skipCapQueueRecord) throw new CapQueueRejectedError(cap);
      // Record the rejected intent so it stays VISIBLE via worker_list instead of silently
      // disappearing — see CapQueueRegistry's class doc. Purely additive: the thrown error's
      // `.message` is byte-identical to before; only CapQueueRejectedError.capQueued is new.
      const capQueued = this.capQueue.record(managerSessionId, workerAgent.id, taskId, opts.kickoffPrompt);
      throw new CapQueueRejectedError(cap, capQueued);
    }
    this.inFlightSpawnTaskIds.add(claimKey);
    try {
      // A noCommit/read-only rig (Code Reviewer, Docs & Vault, …) never runs a build gate, so skip the
      // monorepo BUILD phase for it — install still runs (it still needs node_modules to run/read).
      // WORKTREE KEY: a tasked spawn keys its (deterministic, reused-on-re-spawn) worktree/branch off
      // `taskId` exactly as before. A taskless spawn has no stable id to key off, and must NEVER reuse
      // another spawn's worktree — so it keys off `claimKey` (this call's own fresh randomUUID()),
      // guaranteeing its own ISOLATED worktree/branch that can never collide with a task's worktree or
      // with another taskless spawn's (this is also how a read-only reviewer avoids ever sharing the
      // author's worktree — see the guard note above).
      const { worktreePath, branch, reusedDirtyWorktree } = await createWorktree(project.repoPath, project.id, taskId ?? claimKey, { timeoutMs: this.provisionMs, runBuild: !noCommit });
      // Codescape C3: ensure the project's graph.json exists yet (lazily, on first worker spawn) —
      // fire-and-forget, NEVER blocks the spawn (isCodescapeEnabled folds in isLoomDev(), so a non-dev/
      // disabled daemon fires nothing; a graph that already exists is a no-op — see
      // fireCodescapeEnsureGraph's doc). Ingests the project's MAIN repo, not this new worktree — every
      // session on the project reads the SAME project-wide graph.
      this.fireCodescapeEnsureGraph(project.id, config, project.repoPath);

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
        capabilities, // registry-capability grants (profile opt-in) ⇒ their own MCP(s); else [] (plain)
        restrictedTools, // restricted-tools worker (profile opt-in) ⇒ dangerous native tools disallowed; else false (plain)
        noCommit, // declared no-commit role (e.g. Code Reviewer) ⇒ 0-commit done auto-retires + skips the warning
        skills, // profile-pinned skill subset for the worker (null ⇒ all); pinned so resume/recycle honor it
        connections, // profile-pinned authenticated-egress allowlist for the worker ([] ⇒ no access)
        vaultWrite, // profile-pinned confined vault-write grant for the worker (false ⇒ no access)
        parentSessionId: managerSessionId,
        taskId,
        worktreePath,
        branch,
      };
      this.db.insertSession(worker);
      // M5: flip to live BEFORE wiring the pty so a fast-failing spawn's onExit ('exited') always wins.
      this.db.setProcessState(worker.id, "live");
      // Project memory (card 2fd9abf9, fresh-spawn half) appended LAST, searched against the manager's
      // own kickoff text (which typically carries the task description — the richest match source of any
      // spawn path); null (no notes) ⇒ byte-identical to today. Card ea648f89: stamp the dedup map so this
      // worker's FIRST resume compares against what this fresh spawn just showed it.
      const workerProjectMemoryFramed = retrieveProjectMemoryForKickoff(this.db, project.id, opts.kickoffPrompt);
      this.stampProjectMemoryDigest(worker.id, workerProjectMemoryFramed);
      this.pty.spawn({
        sessionId: worker.id,
        cwd: worktreePath,
        permission: workerSpawn.permission, // layered allowDelta from the worker profile (was bare config.permission — dropped the profile allowlist)
        geometry: config.pty,
        sessionEnv: config.sessionEnv,
        vaultPath: config.docLint ? project.vaultPath : undefined, // Pillar D: scope the vault-lint hook
        codescapeEnabled: config.codescape.enabled, // card C2: Codescape MCP wiring, per-project opt-in
        projectId: project.id,
        // Compose the worker's opening: a worktree LOCATION block first (names this worktree as the edit
        // dir so the worker can't leak edits into the main checkout), then its agent BASE BRIEF (Dev/Bugfix/
        // etc. doctrine — run `/worker`, CLAUDE.md is law), then the manager's kickoff. An empty brief
        // degrades to the block + kickoff. Without this, the agent brief was dead config for workers.
        startupPrompt: appendMemoryRecallToStartupPrompt(
          composeWorkerStartupPrompt(workerAgent.startupPrompt, opts.kickoffPrompt, worktreePath, project.referenceRepos, reusedDirtyWorktree),
          workerProjectMemoryFramed,
        ),
        role: "worker", // gives the worker the orchestration surface (worker_report only)
        browserTesting, // inject the per-session Playwright MCP iff this worker's profile opted in
        documentConversion, // inject the per-session markitdown MCP iff this worker's profile opted in
        capabilities, // inject any registry-capability MCP(s) iff this worker's profile opted in
        restrictedTools, // union the dangerous-native-tool disallow into --disallowedTools iff this worker's profile opted in
        model: workerSpawn.model, // profile-pinned model → `--model` (undefined ⇒ no `--model`); was dropped — workers never honored a profile model pin
        skills, // deliver only the worker profile's skill subset (null ⇒ all)
        // Card f9b47cd1: `loom-<project>-<agent>-<taskslug>` (or "-adhoc" for a taskless spawn), collision
        // suffix appended only if it matches a currently-live sibling worker under this same manager.
        // EXCLUDE worker.id itself — the row is already inserted+live by this point (M5 ordering above),
        // so listWorkers would otherwise see this very spawn as its own "collision" (code review fix).
        sessionName: composeWorkerSessionName(project.name, workerAgent.name, taskTitle, worker.id, this.siblingWorkerSessionNames(managerSessionId, project.name, new Set([worker.id]))),
      });
      // Move the task into the `active` lane (role-resolved off the manager-project config, not the
      // hardcoded "in_progress" key). If the board has no active lane, leave the card where it is rather
      // than inventing a key — the invariant: a move never points a task at a non-existent column. A
      // taskless spawn (taskId null) has no card to move — skip entirely, nothing to leave stale.
      if (taskId) {
        const activeKey = columnKeyForRole(config.kanbanColumns, "active");
        if (activeKey) this.db.updateTask(taskId, { columnKey: activeKey });
      }
      this.db.appendEvent({
        id: randomUUID(), ts: new Date().toISOString(),
        managerSessionId, workerSessionId: worker.id, taskId, kind: "spawn_worker",
      });
      // Wasted-dispatch advisory (card 7b5944fc): runs AFTER pty.spawn so it never delays the worker's
      // actual start — only the point at which this call's result resolves. Tasked spawns only; taskless
      // has no card title to check against.
      const shippedMatch = taskId && taskTitle ? await findShippedCardMatch(project.repoPath, taskTitle) : null;
      // The "I re-drove it" signal: a successful spawn clears any cap-queued marker for
      // the same taskId (tasked) or the same agentId (taskless, no stable per-call key) so the
      // worker_list placeholder doesn't linger alongside the now-real worker row.
      if (taskId) this.capQueue.clearForTask(taskId);
      else this.capQueue.clearTasklessForAgent(managerSessionId, workerAgent.id);
      return { ...worker, processState: "live", shippedMatch, reusedDirtyWorktree };
    } finally {
      // Release the per-taskId (or taskless per-call) claim. By here the row is either live (liveHolder now
      // rejects re-spawns for a real task) or the spawn threw before any persistent state — either way the
      // next spawn must be free to proceed.
      this.inFlightSpawnTaskIds.delete(claimKey);
    }
  }

  /**
   * CLIENT-TIMEOUT-RESILIENT entry point for the `worker_spawn` MCP tool (card fb8df559 Part 1) — the
   * ONLY caller-visible change is at this outer layer; {@link spawnWorker} itself (worktree provisioning,
   * the per-taskId mutex, the concurrency cap) is completely untouched. Keyed on the RAW (trimmed)
   * `opts.taskId` string the caller passed — not the resolved/prefix-matched task id — so a genuine retry
   * (which replays the identical args) attaches to the SAME in-flight op; two calls using two DIFFERENT
   * prefix strings for the same underlying task simply don't dedupe against each other at THIS layer, but
   * `spawnWorker`'s own mutex still prevents a double-spawn (the second gets that mutex's existing
   * "already has a spawn in flight" error, unchanged) — no correctness regression, only a narrower
   * dedup-by-string-identity than a full task-id resolution would give.
   *
   * TASKLESS SPAWN (card 2514e6e1): an empty/omitted taskId gets a FRESH per-call key
   * (`spawn:taskless:<uuid>`) instead of the degenerate `spawn:` every taskless call would otherwise
   * share — two DISTINCT taskless spawns (two spikes, or two read-only reviewers on two different
   * author branches) must never attach to each other's in-flight op. The cost: a client-timeout retry of
   * a taskless spawn can't dedupe against its own prior attempt (no stable identity to key off without a
   * real taskId) and may start a second taskless worker instead of attaching — a strictly lesser failure
   * than the alternative (unrelated taskless spawns colliding), and one the manager can resolve with an
   * ordinary worker_stop. A tasked spawn's key is BYTE-IDENTICAL to before.
   */
  async spawnWorkerTracked(
    managerSessionId: string,
    opts: { taskId?: string; agentId?: string; kickoffPrompt: string },
  ): Promise<AttachResult<Session & { shippedMatch: ShippedCardMatch | null; reusedDirtyWorktree?: ReusedDirtyWorktreeInfo }>> {
    const taskRef = (opts.taskId ?? "").trim();
    const key = taskRef ? `spawn:${taskRef}` : `spawn:taskless:${randomUUID()}`;
    return this.pendingOps.attach<Session & { shippedMatch: ShippedCardMatch | null; reusedDirtyWorktree?: ReusedDirtyWorktreeInfo }>(
      key, "spawn", managerSessionId, SYNC_ATTACH_BUDGET_MS,
      () => this.spawnWorker(managerSessionId, opts),
    );
  }

  /** Read-only pending-merge lookup for worker_list's `pendingMerge` field (card fb8df559 Part 1) — never
   *  consumes; only confirmWorkerMergeTracked's own attach() call consumes a settled op. */
  peekPendingMerge(workerSessionId: string): PendingOpView | undefined {
    return this.pendingOps.peek(`merge:${workerSessionId}`);
  }

  /** Read-only pending-spawn listing for worker_list's placeholder rows (card fb8df559 Part 1) — a
   *  pending spawn has no worker row yet (it's inserted only once createWorktree resolves), so it's
   *  surfaced by manager rather than hung off a per-worker `peek()`. A taskless spawn's key
   *  (`spawn:taskless:<uuid>`, see spawnWorkerTracked) decodes to `taskId: null` here — never the raw
   *  synthetic uuid, which is an internal dedup token, not a real task id. */
  listPendingSpawns(managerSessionId: string): Array<PendingOpView & { taskId: string | null }> {
    return this.pendingOps.listByManager(managerSessionId, "spawn").map((op) => {
      const raw = op.key.slice("spawn:".length);
      return { ...op, taskId: raw.startsWith("taskless:") ? null : raw };
    });
  }

  /** DEAD-OWNER CHECK (card 27ea069e): a manager session is "dead" for pending-merge-op purposes when it
   *  no longer exists, has exited, or has been archived — none of these can ever come back to observe a
   *  pending op's outcome through the normal attach()/settle path. Deliberately conservative: a session
   *  mid-`starting` (e.g. a boot-time resume attempt still in flight) is NOT dead — only a definitively
   *  gone session is, so a legitimately-resuming manager's own in-flight op is never touched. */
  private isManagerSessionDead(managerSessionId: string): boolean {
    const mgr = this.db.getSession(managerSessionId);
    return !mgr || mgr.processState === "exited" || !!mgr.archivedAt;
  }

  /**
   * Boot-time (and generally callable) dead-owner sweep for orphaned MERGE ops (card 27ea069e — a daemon
   * restart mid-merge used to leave `worker_merge_confirm` dedup-attaching to a zombie op forever, keyed
   * `merge:${workerSessionId}`, because nothing ever reconciled/expired an entry whose owning manager
   * session was gone). Evicts any RUNNING merge op whose `managerSessionId` is {@link isManagerSessionDead}
   * — never a live/still-resuming owner's op, so the healthy case (a manager legitimately mid-merge, or
   * one still being resumed at boot) is completely untouched. This registry is in-memory (reset on an
   * actual process restart), so in production this sweep is usually a no-op the moment it runs — its real
   * value is BELT-AND-SUSPENDERS for any orphaned-owner shape the per-call defensive check in
   * {@link confirmWorkerMergeTracked} doesn't itself observe (e.g. nobody re-calls `worker_merge_confirm`
   * for that worker before some other reconcile pass wants to know). Returns the number evicted, for a
   * boot-log line; never throws.
   */
  reconcileDeadOwnerMergeOps(): number {
    let cleared = 0;
    for (const op of this.pendingOps.listAllOfKind("merge")) {
      if (!this.isManagerSessionDead(op.managerSessionId)) continue;
      if (this.pendingOps.evictDeadOwner(op.key)) {
        cleared++;
        console.warn(`[orchestration] merge op ${op.opId} (${op.key}) had a dead owner (manager ${op.managerSessionId.slice(0, 8)}) — evicted so a fresh worker_merge_confirm can proceed`);
      }
    }
    return cleared;
  }

  /** Read-only listing of cap-rejected spawn intents for worker_list's cap-queued placeholder rows —
   *  see {@link CapQueueRegistry}. Distinct from {@link listPendingSpawns}: a pending spawn is
   *  IN-FLIGHT (still provisioning); a cap-queued entry never started at all. */
  listCapQueuedSpawns(managerSessionId: string): CapQueuedSpawn[] {
    return this.capQueue.listByManager(managerSessionId);
  }

  /**
   * Withdraw ONE cap-queued entry (card 81b7e346's cancellation half) — the counterpart to
   * {@link stopWorker} for an intent that never got a real session/pty at all (a queued entry's
   * `sessionId` is null, so `stopWorker` has nothing to stop). Ownership-scoped exactly like every other
   * worker_* write (a manager can only cancel its OWN queued entries — enforced inside
   * {@link CapQueueRegistry.cancel}). Returns whether an entry was actually found+removed; false is not an
   * error — the entry may already have auto-fired or TTL-reaped, which the caller should treat as "nothing
   * left to cancel," not a failure.
   */
  cancelCapQueuedSpawn(managerSessionId: string, opId: string): boolean {
    return this.capQueue.cancel(managerSessionId, opId);
  }

  /**
   * Drain this manager's cap-queue: while a concurrency slot is free and an entry is queued, pop the
   * OLDEST one (FIFO) and replay it through the SAME {@link spawnWorker} a manual worker_spawn call uses —
   * so the atomic per-taskId claim and the atomic cap-admit (both proven race-free there) apply to an
   * auto-fired spawn exactly as they do to a manual one; nothing here re-implements either guarantee, and
   * a drain can never race a concurrent fresh worker_spawn past the cap because they share that one
   * admission chokepoint. Called from every point a worker's slot actually frees: the pty `onExit` hook
   * (index.ts — the default path: manual worker_stop, confirmWorkerMerge's own hard-stop of the merged
   * worker, a crash), the no-commit auto-retire block, {@link retireSiblingSessionsForTask}, and the end of
   * `finalizeMerge`. Fire-and-forget by every caller (never awaited) — a real spawn (worktree + pty) is as
   * slow as a manual one, and none of those retirement paths should block on it. Never throws.
   *
   * SUPPRESSED while {@link recycleDrainSuppressed} holds this manager (see its own doc): recycleWorker is
   * the one retirement path that re-claims its own just-freed slot directly, bypassing spawnWorker's
   * cap-admit — an auto-drain racing into that window could push the manager over cap.
   *
   * Bounded by construction: each loop iteration either returns (queue empty, cap genuinely full again, or
   * the manager is paused) or permanently disposes of exactly one popped entry (a successful spawn, a
   * transient-condition requeue-and-stop, or a dropped+notified failure) — so it can't wedge or loop
   * forever on a broken entry, and a repeatedly-failing entry costs at most one attempt per drain call.
   */
  async maybeDrainCapQueue(managerSessionId: string): Promise<void> {
    if ((this.recycleDrainSuppressed.get(managerSessionId) ?? 0) > 0) return;
    for (;;) {
      // Checked BEFORE popping (not caught after) so a paused manager's queue is left completely
      // untouched — e.g. killAllWorkers pauses THEN hard-stops every worker, and every one of those exits
      // would otherwise reach here; without this check each queued entry would be mistaken for a genuinely
      // broken spawn and dropped, which is exactly wrong for an emergency stop-everything.
      if (this.control.isPaused(managerSessionId)) return;
      const entry = this.capQueue.takeOldest(managerSessionId);
      if (!entry) return;
      try {
        await this.spawnWorker(managerSessionId, {
          taskId: entry.taskId ?? undefined,
          agentId: entry.agentId,
          kickoffPrompt: entry.kickoffPrompt, // the FULL prompt — never the truncated kickoffLabel
        }, { skipCapQueueRecord: true }); // WE re-queue on a cap-race ourselves — see the catch branch below
        // Success: loop again in case more than one slot is free (e.g. two workers retired back-to-back).
      } catch (e) {
        if (e instanceof CapQueueRejectedError) {
          // Raced back to cap-full (a concurrent fresh worker_spawn won the slot first). skipCapQueueRecord
          // means spawnWorker did NOT record a fresh entry — put the ORIGINAL popped entry back at the
          // front ourselves, preserving its opId and FIFO position (a record()'d replacement would mint a
          // new opId at the BACK, demoting it behind younger entries and invalidating any
          // worker_stop({opId}) a caller already holds for it).
          this.capQueue.requeueFront(entry);
          return;
        }
        if (e instanceof UsageLimitError) {
          // Transient/recoverable — the manager itself just got parked on a usage cap, not a broken entry.
          // Put it back at the front so it isn't dropped or reshuffled behind newer arrivals.
          this.capQueue.requeueFront(entry);
          return;
        }
        // A genuine failure (worktree create failed, the task went terminal/held, its agent was deleted,
        // …) — the entry is already popped; don't retry it forever (that's the wedge this method must
        // avoid). Notify the manager with enough to re-drive it by hand, then keep draining the rest.
        try {
          this.pty.enqueueStdin(
            managerSessionId,
            `[loom:cap-queue-autofire-failed] queued spawn (opId ${entry.opId}, task ${entry.taskId ?? "taskless"}, agent ${entry.agentId}) failed to auto-fire: ${(e as Error).message} — dropped from the queue; re-call worker_spawn yourself if it's still needed.`,
            "system", undefined, undefined, "agent",
          );
        } catch { /* best-effort — never let the notification disturb the drain */ }
      }
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
  ): { delivered: boolean; position?: number; reason?: EnqueueDeliveryReason } {
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
    return this.deliverRedirect(worker, text, {
      tag: "loom:from-manager:redirect",
      enqueueSender: managerSessionId,
      eventManagerId: managerSessionId,
    });
  }

  /**
   * Companion session-control ACT lever's STEER half (card 305a54fb, `session_steer`) — interrupt +
   * redirect ANY session in scope; the SCOPED analogue of {@link redirectWorker} minus its
   * parentSessionId gate (a companion is never the target's manager). Mirrors `redirectWorker`'s exact
   * mechanics via the shared {@link deliverRedirect} core: flush + supersede any queued direction first,
   * enqueue the authoritative redirect as a durable cross-session message (framed
   * `[loom:from-owner-via-companion:redirect]` so the receiver knows this replaced its pending direction
   * and may have interrupted it mid-turn), then interrupt ONLY when it was held (the target was busy) — an
   * idle target already received it as a fresh turn, so an Esc would wrongly cancel that very turn.
   * Scope/roleFilter/Primitive-A enforcement all live in the lever (companion/capabilities.ts) — this
   * method assumes the caller already validated them, exactly like `stopSession`/`resume` are thin
   * mechanical wrappers for the stop/resume halves of the same lever. Throws ONLY if the target session is
   * UNKNOWN.
   */
  redirectSessionAsCompanion(sessionId: string, text: string, senderSessionId?: string): { delivered: boolean; position?: number } {
    const target = this.db.getSession(sessionId);
    if (!target) throw new Error("session not found");
    return this.deliverRedirect(target, text, {
      tag: "loom:from-owner-via-companion:redirect",
      enqueueSender: senderSessionId ?? "companion",
      eventManagerId: senderSessionId ?? "",
      extraDetail: { via: "companion" },
    });
  }

  /**
   * Shared redirect core for {@link redirectWorker} and {@link redirectSessionAsCompanion} — the mechanics
   * common to BOTH (see redirectWorker's original doc comment, preserved below, for the full ordering
   * rationale). Parameterized by exactly what differs between the two callers: the wire framing tag, the
   * durable-enqueue sender attribution, the `redirect_worker` event's `managerSessionId` attribution, and
   * any extra event detail (the companion path stamps `via: "companion"`). Callers pre-resolve the target
   * session and any parent-scope gate (redirectWorker's "not your worker" check) BEFORE calling this — this
   * core never re-derives or re-checks scope.
   *
   * ORDER IS LOAD-BEARING (so the redirect deterministically lands as the next turn):
   *   (a) FLUSH the target's pending FIFO and SUPERSEDE each flushed durable record (fire its onDeliver
   *       with reason "superseded" → a session_message_delivered marker), so the worker_report done-guard
   *       and the boot-recovery scan never later re-drive the direction we're replacing. Plain
   *       (non-durable) held nudges carry no callback and are simply dropped — the redirect supersedes
   *       them too.
   *   (b) ENQUEUE the authoritative redirect (framed per `opts.tag`) via the SAME durable channel as
   *       messageWorker: a busy target HOLDS it (delivered:false, persisted) — it is now the only entry in
   *       the freshly-flushed queue; an idle target submits it immediately (delivered:true).
   *   (c) ONLY IF it was HELD (delivered:false ⇒ the target was busy) do we interrupt: pty.interruptForRedirect
   *       writes a single Esc to cancel the in-flight turn, then after a bounded settle clears the (stale)
   *       busy and drains — delivering the redirect we enqueued in (b). The enqueue is SYNCHRONOUS and
   *       precedes the interrupt's settle timer, so the message is always in the queue before the
   *       settle-drain fires (if it were idle there's no turn to cancel, so we skip the Esc and the
   *       redirect already went out as a turn).
   *
   * Returns the enqueue status ({delivered, position?}).
   */
  private deliverRedirect(
    target: Session, text: string,
    opts: { tag: string; enqueueSender: string; eventManagerId: string; extraDetail?: Record<string, unknown> },
  ): { delivered: boolean; position?: number } {
    // (a) FLUSH + SUPERSEDE the target's queued direction before the authoritative redirect lands.
    const flushed = this.pty.flushPending(target.id);
    for (const m of flushed) {
      if (m.onDeliver) { try { m.onDeliver("superseded"); } catch { /* a resolution fault must never block the redirect */ } }
    }
    // (b) ENQUEUE the authoritative redirect (durable-tracked like messageWorker). Distinctly framed so the
    // receiver knows this REPLACED its pending direction and may have interrupted it mid-edit.
    const framed = `[${opts.tag}]\n${text}`;
    const r = this.enqueueDurableMessage(target.id, framed, { sender: opts.enqueueSender, taskId: target.taskId ?? null });
    // (c) Interrupt ONLY when the redirect was HELD (the target was busy). For an idle target the redirect
    // already went out as a turn (delivered:true) — there is nothing to cancel, and an Esc would wrongly
    // cancel that very turn.
    if (!r.delivered) this.pty.interruptForRedirect(target.id);
    this.db.appendEvent({
      id: randomUUID(), ts: new Date().toISOString(),
      managerSessionId: opts.eventManagerId, workerSessionId: target.id, taskId: target.taskId ?? null, kind: "redirect_worker",
      detail: { delivered: r.delivered, superseded: flushed.length, ...opts.extraDetail },
    });
    return r;
  }

  /**
   * Purge now-stale decision-inbox answer-nudges from a session's OWN pty queue (card bbc46336 follow-up
   * to the decision inbox). `question_pull` calls this right after `db.pullAnsweredQuestions` atomically
   * consumes a batch of answered questions — every OTHER queued push-nudge tagged to one of those same
   * question ids is now obsolete (the manager already has the answer via this very pull), so left queued
   * it would drain as its own turn and find nothing left to pull. Thin wrapper over
   * `pty.purgeQueuedByQuestionIds` (see there for the selective-splice contract); the only caller today,
   * the answer route (gateway/server.ts), never attaches an `onDeliver` to these nudges, so there is
   * nothing to resolve — but any future durable-tracked entry sharing a `questionId` would still need
   * resolving, so resolve defensively (mirrors redirectWorker's flushed-entry loop above).
   */
  purgeAnsweredQuestionNudges(sessionId: string, questionIds: readonly string[]): void {
    const removed = this.pty.purgeQueuedByQuestionIds(sessionId, questionIds);
    for (const m of removed) {
      if (m.onDeliver) { try { m.onDeliver("obsolete"); } catch { /* purge must never fail the pull */ } }
    }
  }

  /**
   * Manager-driven ABSOLUTE permission-mode override (worker_set_mode, card 610abe29) — the manual
   * recovery affordance for a worker landed in (or pushed into) a bad mode: a worker can never change its
   * own mode (Shift+Tab is a human TUI keystroke; ExitPlanMode/EnterPlanMode are disallowed for a worker —
   * see disallowedToolsForRole), so mode changes must be daemon-driven. Parent-scoped exactly like
   * stopWorker/messageWorker/redirectWorker (mirrors their "not your worker" gate).
   *
   * SECURITY BOUNDARY — fails closed: `mode` must be one of `WORKER_SETTABLE_MODES`
   * (acceptEdits|auto|plan) or this throws before touching the pty. In particular `bypassPermissions` must
   * NEVER reach `pty.setPermissionMode` — it disables the acceptEdits+allowlist sandbox a worker is spawned
   * into, and an agent (a manager calling this tool) must never be able to escalate a worker out of that
   * sandbox. `default`/`unknown`/any other string is rejected the same way.
   *
   * SECOND BOUNDARY (card 9c03f5a6) — `plan` is further rejected for a role that CANNOT self-exit it: a
   * Loom-driven role with `ExitPlanMode` disallowed (`disallowedToolsForRole(worker.role).includes(
   * "ExitPlanMode")` — the SAME predicate `buildSpawnArgs` uses to strip the human-prompt tools at spawn,
   * reused here so the two can never drift) has no tool to leave plan mode and no human on its stdin to
   * answer the "not this tool" TUI nudge either. Worse: Claude Code's own permission engine gates ANY
   * non-read-only MCP tool call while in plan mode behind an interactive "ask" — including the worker's
   * OWN `worker_report` escape hatch — so a worker pushed into plan can neither act nor report up; it
   * silently occupies a concurrency slot until a human notices and intervenes by hand. A manager that
   * wants "investigate first" gets it via the kickoff prompt, never by parking a worker in a mode it can't
   * leave. (`manager`/`platform`/plain sessions are unaffected — that predicate never disallows
   * ExitPlanMode for them, so a human legitimately Shift+Tabbing one of THOSE into plan is untouched.)
   *
   * Drives the footer via `pty.setPermissionMode`, which reuses the SAME feedback-verified `cycleToMode`
   * primitive the spawn/resume convergence uses (press Shift+Tab, wait for the footer to actually change) —
   * pure keystroke injection, bypassing the busy/turn queue (~0 worker tokens). Returns the FEEDBACK-
   * VERIFIED landed mode, which may differ from `mode` if the cycle gave up early (the caller sees the
   * truth, not an assumed success).
   */
  async setWorkerMode(managerSessionId: string, workerSessionId: string, mode: string): Promise<LandedMode> {
    if (!WORKER_SETTABLE_MODES.has(mode)) {
      throw new Error(`mode must be one of acceptEdits|auto|plan (got "${mode}")`);
    }
    const worker = this.db.getSession(workerSessionId);
    if (!worker || worker.parentSessionId !== managerSessionId) throw new Error("not your worker");
    if (mode === "plan" && disallowedToolsForRole(worker.role).includes("ExitPlanMode")) {
      throw new Error(
        `plan mode is not permitted for a Loom-driven '${worker.role}' session — it cannot self-exit plan ` +
          `mode (ExitPlanMode is disallowed) and has no human on its stdin to answer the resulting ` +
          `permission prompts, incl. its own worker_report escape hatch; use a kickoff instruction instead`,
      );
    }
    const landed = await this.pty.setPermissionMode(workerSessionId, mode as WorkerSettableMode);
    this.db.appendEvent({
      id: randomUUID(), ts: new Date().toISOString(),
      managerSessionId, workerSessionId, taskId: worker.taskId ?? null, kind: "set_worker_mode",
      detail: { target: mode, landed },
    });
    return landed;
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
   *
   * Every caller of this helper enqueues an agent/human-authored, cross-session message (messageWorker,
   * redirectWorker, messageSessionAsPlatform, the recycle carry-forward of a durable record) — always
   * `kind: "agent"` (one-per-turn unless `coalesceAgentMessages` is on).
   */
  private enqueueDurableMessage(
    recipientId: string, framedText: string, ctx: { sender: string; taskId?: string | null },
  ): { delivered: boolean; position?: number; reason?: EnqueueDeliveryReason } {
    const msgId = randomUUID();
    // onDeliver carries an OPTIONAL reason: the normal drain/pull paths fire it with no arg (a plain
    // delivery); a flush/SUPERSEDE caller (redirectWorker) passes "superseded" so the resolution event
    // records WHY the durable record closed without being delivered as a turn.
    const r = this.pty.enqueueStdin(recipientId, framedText, "system", (reason?: string) => this.resolveQueuedMessage(msgId, { recipientId, reason }), undefined, "agent");
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
   * Non-durable entries (idle/resume nudges, raw human turns) carry across with their source AND their
   * warning/agent classification preserved.
   */
  private carryPendingToSuccessor(
    oldId: string, successorId: string, flushed: QueuedMessage[], durableRecords: OrchestrationEvent[],
  ): void {
    for (const m of flushed) {
      if (m.onDeliver) {
        // Durable entry — its record is re-minted from `durableRecords` below; resolve the OLD record now.
        try { m.onDeliver("superseded"); } catch { /* a resolution fault must never block the recycle */ }
      } else {
        // Non-durable (nudge / raw human turn): carry the text, source, AND kind so a 'human'/'agent' entry
        // stays classified exactly as it was (a warning nudge doesn't become one-per-turn, an agent message
        // doesn't start coalescing).
        this.pty.enqueueStdin(successorId, m.text, m.source, undefined, undefined, m.kind);
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

  /** Per-caller framing for {@link deliverSessionMessage} — the ONLY thing that differs between the
   *  Platform Lead's `session_message` and the Companion session-control lever's own `session_message`
   *  (card 305a54fb): the `[loom:from-…]` tag a live receiver sees, the sentinel sender fallback, and the
   *  board note's wording when the target isn't live. Everything else (durable delivery, recycle-lineage
   *  routing, board fallback) is shared. */
  private static readonly PLATFORM_MESSAGE_FRAMING = {
    tag: "loom:from-platform",
    senderFallback: "platform",
    boardHeading: "**Message from the Platform Lead** (boarded because the target session was not live).",
    boardFromLine: (s?: string) => (s ? `- **From (Lead session):** \`${s}\`` : "- **From:** Platform Lead"),
    boardTitlePrefix: "[Platform message]",
  };
  private static readonly COMPANION_MESSAGE_FRAMING = {
    tag: "loom:from-owner-via-companion",
    senderFallback: "companion",
    boardHeading: "**Message from the owner** (relayed via companion; boarded because the target session was not live).",
    boardFromLine: (s?: string) => (s ? `- **From (companion session):** \`${s}\`` : "- **From:** the owner (via companion)"),
    boardTitlePrefix: "[Companion message]",
  };

  /**
   * Shared cross-project message-delivery mechanics for {@link messageSessionAsPlatform} and
   * {@link messageSessionAsCompanion} — UN-scoped (no parentSessionId check; the caller stands above the
   * manager/worker tree). Reuses the SAME stdin-enqueue channel (submitted as a turn when idle, queued
   * FIFO and drained on the next turn boundary when busy), framed per `framing.tag` so the receiver knows
   * the source. DELIVERY ONLY — it never spawns anything. Throws (→ the router's error envelope) ONLY if
   * the target session is UNKNOWN.
   *
   * Returns a `deliveryStatus` (delivered-live | queued | boarded) so the caller gets an HONEST outcome:
   *  - LIVE target → the durable stdin-enqueue channel (submitted as a turn if idle = delivered-live;
   *    held FIFO if busy = queued).
   *  - NOT-LIVE target whose recycle lineage has a LIVE successor (card 5519559c) → route to the successor
   *    via the SAME durable channel instead of boarding: the target id was superseded, not gone, so the
   *    message reaches whoever is actually doing the work now. `routedTo` names the successor so the
   *    caller can see the redirect. This is DISTINCT from card 2ca18433 (a still-live recipient that
   *    recycles AFTER a message is already queued) — here the target is already dead at send time.
   *  - NOT-LIVE target with NO live successor anywhere in its lineage → it has no PTY to take a turn, so
   *    instead of THROWING (which silently drops the message), we BOARD a durable note onto the target's
   *    OWN project board — the same durable-board fallback platformEscalate uses for an offline Lead —
   *    and return `boarded`. The message is never lost.
   */
  private deliverSessionMessage(
    sessionId: string, text: string, senderSessionId: string | undefined,
    framing: { tag: string; senderFallback: string; boardHeading: string; boardFromLine: (s?: string) => string; boardTitlePrefix: string },
  ): { deliveryStatus: DeliveryStatus; position?: number; taskId?: string; routedTo?: string } {
    const session = this.db.getSession(sessionId);
    if (!session) throw new Error("session not found");
    const framed = `[${framing.tag}]\n${text}`;
    const deliverLive = (target: typeof session) => {
      // Durable-tracked (card 2ca18433): a busy recipient holds it FIFO + we persist it, so a
      // cross-project dispatch survives a sender death / daemon restart before the recipient's next turn.
      // The sender is the caller's own session id (threaded from the router) so an undelivered dispatch
      // can be surfaced back to it on resume; `senderFallback` is a sentinel if no caller id was provided.
      const r = this.enqueueDurableMessage(target.id, framed, { sender: senderSessionId ?? framing.senderFallback, taskId: target.taskId ?? null });
      this.db.appendEvent({
        id: randomUUID(), ts: new Date().toISOString(),
        managerSessionId: "", workerSessionId: target.id, taskId: target.taskId ?? null, kind: "session_message",
      });
      return { deliveryStatus: this.deliveryStatusFor(r), position: r.position };
    };
    if (session.processState === "live") return deliverLive(session);

    // NOT LIVE: before boarding, resolve to the live end of the target's recycle lineage — the target may
    // simply have been recycled, with a successor already doing the work under a new session id.
    //
    // ROLE-FILTER ASSUMPTION: for a companion-originated call, the ORIGINAL `sessionId` already passed
    // `resolveControlTarget`'s roleFilter check (companion/capabilities.ts) before this method was ever
    // reached — the successor's role is NOT re-checked here. This is safe today only because recycle
    // PRESERVES role (a manager recycles to a manager, a worker to a worker), so successor.role ===
    // session.role and the roleFilter guarantee still holds transitively. If recycle ever starts crossing
    // roles, a roleFilter allowlist could admit a target whose successor lands outside it — revisit this
    // routing point (or re-validate the successor's role against the filter) if that invariant changes.
    const successor = liveLineageSuccessor(this.db, sessionId);
    if (successor) return { ...deliverLive(successor), routedTo: successor.id };

    // No live successor anywhere in the lineage: board a durable note onto the target's project board
    // (mirrors platformEscalate's structured board task). The card is the durable source of truth, so the
    // message survives until someone reads it.
    const now = new Date().toISOString();
    const body = [
      framing.boardHeading,
      "",
      `- **Target session:** \`${sessionId}\``,
      framing.boardFromLine(senderSessionId),
      "",
      "## Message",
      "",
      text,
    ].join("\n");
    const task: Task = {
      id: randomUUID(),
      projectId: session.projectId,
      title: `${framing.boardTitlePrefix} for session ${sessionId.slice(0, 8)}`,
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
   * Platform-Lead cross-project message delivery (loom-platform `session_message`, P4). Framed
   * `[loom:from-platform]` so the receiver knows the source is the platform operator, not its own
   * manager. See {@link deliverSessionMessage} for the shared delivery/routing/boarding mechanics.
   *
   * DELIVER-ONCE (card c17291c3): two distinct manifestations of the same root gap — no delivered-once
   * guard on this route — showed up in the wild: (a) a retried/duplicated call for the SAME directive
   * landing as two full duplicate turns, and (b) the directive text itself already carrying a
   * `[loom:from-platform]` line (e.g. copied from a prior framed message) so this method's own wrap
   * doubled it. Both are closed here, BEFORE the shared `deliverSessionMessage` ever sees the text:
   *  1. `stripLeadingPlatformTag` normalizes away any leading `[loom:from-platform]` line(s) already in
   *     `text`, so the frame this method applies is always the ONLY one, however the caller wrote it.
   *  2. The normalized (recipient, text) pair is hashed into a short-TTL dedupe key
   *     ({@link platformMessageDedupe}); a resend of the SAME directive within the window returns the
   *     ORIGINAL delivery result (marked `duplicate:true`) with NO new enqueue — deliver-once. A
   *     genuinely different directive (different text, or a different recipient) always gets a fresh key
   *     and delivers normally.
   */
  messageSessionAsPlatform(
    sessionId: string, text: string, senderSessionId?: string,
  ): { deliveryStatus: DeliveryStatus; position?: number; taskId?: string; routedTo?: string; duplicate?: boolean } {
    const normalizedText = SessionService.stripLeadingPlatformTag(text);
    const dedupeKey = createHash("sha256").update(sessionId).update(" ").update(normalizedText).digest("hex");
    const now = Date.now();
    this.prunePlatformMessageDedupe(now);
    const prior = this.platformMessageDedupe.get(dedupeKey);
    if (prior) return { ...prior.result, duplicate: true };
    const result = this.deliverSessionMessage(sessionId, normalizedText, senderSessionId, SessionService.PLATFORM_MESSAGE_FRAMING);
    this.platformMessageDedupe.set(dedupeKey, { result, atMs: now });
    return result;
  }

  /** Strip any leading `[loom:from-platform]` line(s) from directive text — see {@link messageSessionAsPlatform}. */
  private static stripLeadingPlatformTag(text: string): string {
    const prefix = `[${SessionService.PLATFORM_MESSAGE_FRAMING.tag}]`;
    let t = text;
    while (t.startsWith(prefix)) {
      t = t.slice(prefix.length);
      if (t.startsWith("\n")) t = t.slice(1);
    }
    return t;
  }

  /** Sweep expired entries out of {@link platformMessageDedupe} — called on every write so the map never
   *  grows past the live TTL window's worth of distinct directives. */
  private prunePlatformMessageDedupe(nowMs: number): void {
    for (const [key, entry] of this.platformMessageDedupe) {
      if (nowMs - entry.atMs >= SessionService.PLATFORM_MESSAGE_DEDUP_TTL_MS) this.platformMessageDedupe.delete(key);
    }
  }

  /**
   * Companion session-control ACT lever's MESSAGE half (card 305a54fb, `session_message`) — the SCOPED
   * analogue of `messageSessionAsPlatform`: same UN-scoped delivery mechanics (the companion is not the
   * target's manager, so no parentSessionId gate applies here either), but framed
   * `[loom:from-owner-via-companion]` so a live receiver can tell the direction came via the owner's
   * companion, not its own manager or the Platform Lead. Scope/roleFilter/Primitive-A enforcement all live
   * in the lever (companion/capabilities.ts) — this method is a thin mechanical wrapper around the SAME
   * shared delivery helper `messageSessionAsPlatform` uses, exactly like `stopSession`/`resume` are for
   * the stop/resume halves of the same lever.
   */
  messageSessionAsCompanion(
    sessionId: string, text: string, senderSessionId?: string,
  ): { deliveryStatus: DeliveryStatus; position?: number; taskId?: string; routedTo?: string } {
    return this.deliverSessionMessage(sessionId, text, senderSessionId, SessionService.COMPANION_MESSAGE_FRAMING);
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
  ): { taskId: string; projectId: string; deliveryStatus: DeliveryStatus; deduped?: boolean } {
    const caller = this.db.getSession(managerSessionId);
    if (!caller || caller.role !== "manager") throw new Error("platform_escalate is a manager-only surface");
    // HARDCODED target: the reserved Platform home — never an arbitrary projectId from the manager.
    // NAME-SCOPED: resolve by PLATFORM_PROJECT_NAME, not a bare `.find(reserved)` — a second reserved home
    // (the ungated "Getting Started" setup home) now coexists, so "the one reserved project" is ambiguous
    // and would mis-file the escalation into the wrong home.
    const home = this.db.getReservedProjectByName(PLATFORM_PROJECT_NAME);
    if (!home) throw new Error("no reserved Loom Platform project exists — cannot escalate");

    // SERVER-SIDE DEDUPE: a manager re-escalating the SAME issue every cycle while nobody has picked it up
    // yet floods the Companion's attention-push alert (companion/attention-push.ts) with zero new
    // owner-facing value — each re-file is a fresh orchestration_event, so attention-push's watermark
    // treats it as genuinely new and re-pushes "escalated to platform" every time, whether or not a Lead
    // is live to act on it. If THIS origin project already has a still-PENDING escalation (never picked up
    // — still sitting in the Platform board's landing lane) with the same normalized title, reuse it
    // instead of filing a duplicate task/event: no new orchestration_event ⇒ no new attention-push alert,
    // and no redundant live-nudge either. Once the Lead moves/resolves it (status advances past pending), a
    // repeat with the same title is treated as a genuinely new occurrence and files fresh — mirrors
    // auditFileFinding's title-normalized dedupe, but scoped to "still unclaimed" rather than "ever filed"
    // (an escalation, unlike an audit finding, can legitimately recur after resolution).
    const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
    const key = norm(input.title);
    for (const e of this.db.listEscalationsForProject(caller.projectId)) {
      const filedTitle = (e.detail?.title as string | undefined) ?? "";
      if (!e.taskId || norm(filedTitle) !== key) continue;
      const existingTask = this.db.getTask(e.taskId);
      if (existingTask && this.classifyEscalationStatus(home.id, existingTask.columnKey) === "pending") {
        return { taskId: existingTask.id, projectId: home.id, deliveryStatus: "boarded", deduped: true };
      }
    }

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
        try { deliveryStatus = this.deliveryStatusFor(this.pty.enqueueStdin(liveLead.id, note, "system", undefined, undefined, "agent")); } catch { /* Lead not live/ready — `boarded` stands */ }
      }
    }
    return { taskId: task.id, projectId: home.id, deliveryStatus };
  }

  /**
   * Manager↔manager cross-project channel (orchestration `peer_message`, board card 2349d90c) — a manager
   * addressing a message to a LINKED peer project's LIVE manager. This is the manager's SECOND (and only
   * other) structured cross-project write, alongside `platformEscalate`; unlike that hardcoded-target
   * escalation, the target here is caller-chosen but gated server-side on `project_links` (owner-declared,
   * human-only — no MCP path can create a link), so a manager can reach ONLY a project the owner has
   * explicitly linked to its own. Trust invariants:
   *   - LINK gate: `db.areProjectsLinked` — an unlinked (or nonexistent) target project is REJECTED.
   *   - self/same-project target REJECTED (use your own project's board instead).
   *   - a soft-archived target (`project.archivedAt` set) is REJECTED — `getProject` returns archived
   *     rows too, so without this check a linked-but-archived target would fall through to the board
   *     fallback below and dead-letter a card onto a board nobody watches.
   *   - manager↔manager ONLY: resolves the target project's LIVE session with role==="manager" — a live
   *     worker/platform/auditor session in that project is never matched (mirrors session_spawn's
   *     manager|plain-only invariant), so the message can never land on the wrong kind of session.
   *   - NO privilege travels: delivered via the SAME `enqueueDurableMessage` channel worker_message/
   *     session_message use — a framed, `kind:"agent"` DATA message (one-per-turn) that grants the
   *     recipient nothing beyond an inbound turn it acts on WITHIN ITS OWN project.
   *   - rate-limited per ORIGIN manager session (`checkPeerMessageRateLimit`) so a compromised/confused
   *     manager can't turn this into a cross-project spam/probe vector.
   *   - REPLY-ABLE: the frame stamps the ORIGIN `projectId` + sending manager's `sessionId` alongside its
   *     human-readable name, so the recipient manager can `peer_message` back with `targetProjectId` set
   *     to the stamped id — without this, a recipient sees only a project NAME (peer_message requires an
   *     id, and nothing else exposes a linked project's id), so it could never reply without a full human
   *     relay, defeating this channel's whole no-human-relay premise (board gap, see fix commit).
   * When the target project has NO live manager, mirrors `deliverSessionMessage`'s offline path: rather
   * than dropping the message or erroring, it boards a durable card on the target project's OWN board (the
   * message is never lost — the peer's manager picks it up as a normal task on its next boot/attach).
   * Audited both directions via a single `cross_project_message` event (this method's caller is the ONLY
   * place that appends it, so origin/target are always recorded together).
   */
  messagePeerManager(
    managerSessionId: string,
    targetProjectId: string,
    text: string,
  ): { deliveryStatus: DeliveryStatus; position?: number; taskId?: string; targetSessionId?: string } {
    this.requireManager(managerSessionId, "peer_message");
    const caller = this.db.getSession(managerSessionId)!;
    const originProjectId = caller.projectId;
    if (!originProjectId) throw new Error("no project for this session");
    if (targetProjectId === originProjectId) throw new Error("peer_message: cannot target your own project — use your own board instead");
    const targetProject = this.db.getProject(targetProjectId);
    if (!targetProject) throw new Error("peer_message: target project not found");
    if (targetProject.archivedAt) throw new Error("peer_message: target project is archived");
    if (!this.db.areProjectsLinked(originProjectId, targetProjectId)) {
      throw new Error("peer_message: target project is not linked to yours — ask the owner to link the projects first");
    }
    if (!checkPeerMessageRateLimit(managerSessionId)) {
      throw new Error("peer_message: rate limit exceeded — slow down and try again shortly");
    }

    const originProject = this.db.getProject(originProjectId);
    const originName = originProject?.name ?? originProjectId;
    // Stamp the origin projectId + sending manager sessionId onto the frame: nothing else exposes a
    // linked peer's project id to the recipient, so without this a recipient manager could never reply
    // via peer_message (which requires a targetProjectId) without a full human relay.
    const framed = `[loom:from-manager · ${originName} · projectId:${originProjectId} · sessionId:${managerSessionId}]\n${text}`;

    // manager↔manager ONLY: match role==="manager" explicitly — a live worker/platform/auditor session in
    // the target project must never be matched, even if it's the only live session there.
    const targetManager = this.db.listAllSessions().find(
      (s) => s.projectId === targetProjectId && s.role === "manager" && s.processState === "live",
    );

    const now = new Date().toISOString();
    let result: { deliveryStatus: DeliveryStatus; position?: number; taskId?: string; targetSessionId?: string };
    if (targetManager) {
      const r = this.enqueueDurableMessage(targetManager.id, framed, { sender: managerSessionId, taskId: targetManager.taskId ?? null });
      result = { deliveryStatus: this.deliveryStatusFor(r), position: r.position, targetSessionId: targetManager.id };
    } else {
      // No live manager in the target project: board a durable card on ITS OWN board (mirrors
      // deliverSessionMessage's "no live successor" fallback) — the message survives until its manager
      // next attaches, instead of being silently dropped or the call erroring for a legitimate offline peer.
      const body = [
        "**Message from a linked project's manager** (boarded because no manager session was live).",
        "",
        `- **From project:** ${originName} (\`${originProjectId}\`)`,
        `- **From (manager session):** \`${managerSessionId}\``,
        "",
        "## Message",
        "",
        text,
      ].join("\n");
      const task: Task = {
        id: randomUUID(),
        projectId: targetProjectId,
        title: `[Peer message] from ${originName}`,
        body,
        columnKey: this.columnKeyForProjectRole(targetProjectId, "defaultLanding") ?? "backlog",
        position: Date.now(),
        priority: DEFAULT_TASK_PRIORITY,
        createdAt: now,
        updatedAt: now,
      };
      this.db.insertTask(task);
      result = { deliveryStatus: "boarded", taskId: task.id };
    }

    this.db.appendEvent({
      id: randomUUID(), ts: now,
      managerSessionId, workerSessionId: result.targetSessionId ?? "", taskId: result.taskId ?? null,
      kind: "cross_project_message",
      detail: { originProjectId, targetProjectId, targetSessionId: result.targetSessionId ?? null, text, deliveryStatus: result.deliveryStatus },
    });

    return result;
  }

  /**
   * Manager↔manager peer discovery (orchestration `peer_list`) — a NON-MUTATING read letting a manager
   * enumerate its OWN project's owner-linked peers before it has heard from any of them, so it can
   * INITIATE a `peer_message` instead of only ever replying to one. Reuses the exact same link table
   * `messagePeerManager` gates on (`db.listProjectLinks`, filtered to rows touching this project) — so
   * this returns PRECISELY the target set `peer_message` would accept, never a superset. Scoped
   * SERVER-SIDE to the caller's own project (derived from `managerSessionId`, mirrors `requests_list`) —
   * no projectId param, so a manager can never enumerate another project's links. An archived peer is
   * excluded (mirrors `messagePeerManager`'s archived-target rejection) so a listed peer is always one
   * `peer_message` would actually accept right now.
   */
  listPeerProjects(managerSessionId: string): { projectId: string; name: string }[] {
    this.requireManager(managerSessionId, "peer_list");
    const caller = this.db.getSession(managerSessionId)!;
    const originProjectId = caller.projectId;
    if (!originProjectId) throw new Error("no project for this session");
    return this.db.listProjectLinks()
      .map((link) => (link.projectAId === originProjectId ? link.projectBId : link.projectBId === originProjectId ? link.projectAId : null))
      .filter((peerId): peerId is string => peerId !== null)
      .map((peerId) => this.db.getProject(peerId))
      .filter((p): p is NonNullable<typeof p> => p !== undefined && !p.archivedAt)
      .map((p) => ({ projectId: p.id, name: p.name }));
  }

  /**
   * Manager→Platform escalation READ (orchestration `escalation_status`) — closes the gap where a manager
   * has no way to tell whether a `platform_escalate` it filed was ever picked up, so it re-escalates work
   * the Lead already claimed. READ-ONLY, origin-project-scoped: the candidate set is derived SERVER-SIDE
   * from `platform_escalate` events whose `detail.originProjectId` equals the CALLER'S OWN project (never
   * a client-supplied projectId) — scoped by origin project, not by managerSessionId, so a recycled
   * successor manager in the same project still sees escalations its predecessor filed. A `taskId` outside
   * that set — whether it belongs to another project's escalation or is simply unknown — returns
   * `{ found: false }` uniformly; it never confirms or denies that a given Platform task exists, so a
   * manager can't use this to probe another project's escalations.
   *
   * `taskId` accepts EITHER a full id or an unambiguous id-PREFIX (reuses the shared `resolveIdPrefix`
   * helper, card e63874e9) — the SAME paste-able 8-char short id every other `*_get`-shaped read already
   * accepts. Resolution is scoped STRICTLY to `events` (already origin-project-scoped above) — never
   * `db.listTasks()`/`getTask`, which would leak whether an out-of-scope id exists. An ambiguous prefix
   * names the candidate ids (still project-scoped); a true miss — unknown OR simply out-of-scope — still
   * returns `{ found: false }` uniformly, unchanged.
   *
   * LIST MODE (no `taskId`) is bounded to OPEN escalations by default — `pending`/`in_progress` only —
   * so a manager checking in isn't handed every escalation ever filed, most of it days-stale `resolved`/
   * `closed` history it didn't ask for (card 107b595b: a manager paid ~44KB of stale history twice when
   * it only needed the open ones). Pass `includeResolved:true` to opt back into the full unfiltered
   * history. The single-`taskId` lookup above is unaffected either way — it's already cheap.
   */
  escalationStatus(
    managerSessionId: string,
    input: { taskId?: string; includeResolved?: boolean },
  ): { found: false } | { found: true; escalation: EscalationStatusItem } | { found: true; escalations: EscalationStatusItem[] } | { error: string } {
    const caller = this.db.getSession(managerSessionId);
    if (!caller || caller.role !== "manager") throw new Error("escalation_status is a manager-only surface");

    const events = this.db.listEscalationsForProject(caller.projectId);
    if (input.taskId) {
      const ref = input.taskId;
      // platform_escalate always sets taskId (service method above), but the field is nullable on the
      // shared OrchestrationEvent type — filter defensively so resolveIdPrefix's candidates are always
      // real strings rather than coercing a null/undefined into a matchable "" prefix.
      const withId = events.filter((e): e is typeof e & { taskId: string } => typeof e.taskId === "string");
      const r = resolveIdPrefix(withId.map((e) => ({ id: e.taskId, event: e })), ref);
      if (r.kind === "ambiguous") {
        return { error: `ambiguous escalation id-prefix '${ref}' — it matches ${r.ids.join(", ")}; pass more characters or the full id` };
      }
      if (r.kind === "none") return { found: false };
      return { found: true, escalation: this.describeEscalation(r.record.event) };
    }
    const all = events.map((e) => this.describeEscalation(e));
    const scoped = input.includeResolved ? all : all.filter((it) => it.status === "pending" || it.status === "in_progress");
    return { found: true, escalations: scoped };
  }

  /** One `platform_escalate` event → its current escalation status, read fresh off the live Platform task
   *  (its title/column may have moved since filing — a refined title is itself a signal the Lead saw it). */
  private describeEscalation(event: OrchestrationEvent): EscalationStatusItem {
    const taskId = event.taskId ?? "";
    const filedTitle = (event.detail?.title as string | undefined) ?? "";
    const platformProjectId = (event.detail?.platformProjectId as string | undefined) ?? "";
    const task = this.db.getTask(taskId);
    if (!task) return { taskId, title: filedTitle, status: "closed", columnKey: null, updatedAt: event.ts };
    return { taskId, title: task.title, status: this.classifyEscalationStatus(platformProjectId, task.columnKey), columnKey: task.columnKey, updatedAt: task.updatedAt };
  }

  /** Column → escalation status, role-resolved against the Platform project's OWN column roles (never a
   *  hardcoded "inbox"/"backlog"/"done" key) — mirrors the landing-lane fallback `platformEscalate` files
   *  new escalations into, so a task still sitting in that exact lane reads back as "pending". */
  private classifyEscalationStatus(platformProjectId: string, columnKey: string): "resolved" | "pending" | "in_progress" {
    const terminalKey = this.columnKeyForProjectRole(platformProjectId, "terminal");
    if (terminalKey !== undefined && columnKey === terminalKey) return "resolved";
    const landingKey = this.columnKeyForProjectRole(platformProjectId, "defaultLanding") ?? "backlog";
    if (columnKey === landingKey) return "pending";
    return "in_progress";
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
    // kind:"agent" — a specific, actionable auditor heads-up naming a concrete suggestion, not a Loom
    // operational nudge; it must reach the operator as its own turn, never mashed with anything else.
    try { return this.deliveryStatusFor(this.pty.enqueueStdin(operator.id, note, "system", undefined, undefined, "agent")); }
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
   * (→ idle policy `snoozed`) or `done` (→ `suppressed`) is SILENCED on the idle path —
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
    report: { status: "done" | "blocked" | "progress"; summary: string; prUrl?: string; needs?: string; noChanges?: boolean; awaiting?: "manager" | "background" },
  ): Promise<{ reported: boolean; deliveryStatus: DeliveryStatus; refused?: boolean; error?: string; uncommittedFiles?: string[]; warning?: string; autoRetired?: boolean }> {
    const worker = this.db.getSession(workerSessionId);
    if (!worker) throw new Error("unknown worker session");
    const managerSessionId = worker.parentSessionId ?? null;
    const taskId = worker.taskId ?? null;

    // AUTO-RECOVERY RE-CONFIRMATION DEDUPE (card 289586c7, bounded p2 0b795bf4): the crash-recovery resume
    // nudge invites a recovered worker to "call worker_report (done/blocked) if you had already finished" —
    // so a worker that crash-loops N times can call worker_report N times with BYTE-IDENTICAL content
    // (incident: worker a1c71a86 filed the SAME done report 3× after 3 auto-recovery resumes, each
    // re-nudging the manager). Collapse to the FIRST ONLY when this is a PURE re-confirmation: the LAST
    // recorded worker_report for this task is identical to THIS one, a session_resume_attempt happened in
    // between, AND no manager direction (message_worker / redirect_worker) landed in between either. That
    // last guard is load-bearing — without it a genuine strand slips through: worker reports done (delivered)
    // → manager sends new direction (worker_message/worker_redirect) → worker crashes → auto-resume →
    // worker re-reports the SAME "done" text (because the report itself didn't change) → the dedupe would
    // otherwise drop it, and the manager never learns the worker is back. So ANY direction-bearing event
    // since the prior identical report makes this a genuine re-report, not a stale post-recovery echo — ack
    // it and re-nudge the manager like normal.
    if (taskId) {
      const history = this.db.listEventsForWorker(workerSessionId);
      let lastReport: OrchestrationEvent | undefined;
      let resumedSince = false;
      let directionSince = false;
      for (let i = history.length - 1; i >= 0; i--) {
        const e = history[i]!;
        if (e.kind === "session_resume_attempt") resumedSince = true;
        else if (e.kind === "message_worker" || e.kind === "redirect_worker") directionSince = true;
        else if (e.kind === "worker_report" && e.taskId === taskId) { lastReport = e; break; }
      }
      if (lastReport && resumedSince && !directionSince) {
        const d = lastReport.detail as { status?: string; summary?: string; prUrl?: string; needs?: string; noChanges?: boolean; awaiting?: string } | undefined;
        // noChanges is included in the identity check (card ccf0bbfe follow-up): a worker that reports
        // done with an IDENTICAL summary but a DIFFERENT noChanges value (e.g. it crashed right after an
        // un-flagged done, auto-resumed, and re-reports with noChanges:true this time) must NOT be
        // collapsed as a pure re-confirmation echo — that would silently skip the auto-retire this report
        // is trying to trigger, leaving the worker stranded live needing a manual stop. Normalize
        // undefined/false together (both mean "no declared-intent signal") so an old pre-feature event
        // (no noChanges key at all) still compares equal to a fresh `false`. `awaiting` gets the same
        // normalize-then-compare treatment (default "manager") so a re-report that only changes its
        // idle-watchdog disposition still counts as a genuine re-report, not a dropped echo.
        const identical =
          d?.status === report.status && d?.summary === report.summary &&
          (d?.prUrl ?? undefined) === report.prUrl && (d?.needs ?? undefined) === report.needs &&
          (d?.noChanges ?? false) === (report.noChanges ?? false) &&
          (d?.awaiting ?? "manager") === (report.awaiting ?? "manager");
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
    // AUTO-RETIRE a declared no-commit worker (card 14434d6b), GENERALIZED to a per-report declared-intent
    // signal (card ccf0bbfe): a read-only / no-commit worker (e.g. the Code Reviewer rig, profile
    // noCommit=true → pinned on the row) has NO merge step, so unlike a normal worker — whose concurrency
    // slot frees via worker_merge_confirm — its slot would only free on a manual worker_stop. The SAME gap
    // hits an ordinary worker with a legitimate one-off no-op done (a review, an investigation that found
    // nothing to change, a mockup/report delivered outside the repo) — it isn't a noCommit ROLE, so it used
    // to get the misleading "forgot to commit" warning and never auto-retired. `report.noChanges` (set by
    // the worker on a `done` report) is the PER-REPORT declared-intent analog of the pinned role flag: set
    // when EITHER trigger fires reporting done with 0 commits ahead (the CORRECT contract for both), so we
    // free the cap slot below + suppress the forgot-to-commit warning. Keyed STRICTLY off the pinned
    // noCommit flag OR the explicit `noChanges` signal (NOT name-matching, NOT "0 commits" alone): a NORMAL
    // 0-commit worker that did NOT declare intent still gets the warning and is NEVER auto-retired — the
    // forgot-to-commit safety net for the ACCIDENTAL case is intact.
    let autoRetireNoCommit = false;
    let autoRetireTrigger: "no-commit-role" | "declared-no-op" | undefined;
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
          // Board card 50162e6b: name the queued instruction TEXT (not just a count) so the worker can
          // judge for itself whether this is a genuine superseding redirect or a redundant nudge it
          // already saw — without burning a full turn just to drain and read it. Truncate defensively;
          // a queued message is agent/human-authored text, never a length we control.
          const pendingList = pending
            .map((e, i) => {
              const text = typeof e.detail?.text === "string" ? e.detail.text : "(no text captured)";
              const truncated = text.length > 500 ? `${text.slice(0, 500)}…` : text;
              return `  ${i + 1}. ${truncated}`;
            })
            .join("\n");
          const currentMsgIds = pending.map((e) => e.detail?.msgId).filter((id): id is string => typeof id === "string").sort();
          // REPEAT check: was this EXACT still-unconsumed set already named in the worker's last rejection
          // for this task? If so, nothing new has arrived since — this is the `e554d4f4` shape (a worker
          // re-reporting `done` against a redundant nudge it was already refused on), not a fresh supersede.
          // Soften the tone (still refused — the hard guard for genuinely-unconsumed direction is unchanged)
          // to point the worker at RECONCILING (act on it or confirm it's already satisfied) rather than
          // re-alarming it with "may supersede" language it has already read once.
          const priorRejection = this.db
            .listEventsForWorker(workerSessionId)
            .filter((e) => e.kind === "worker_report_rejected" && e.taskId === taskId && e.detail?.reason === "pending-direction")
            .at(-1);
          const priorMsgIds = Array.isArray(priorRejection?.detail?.msgIds)
            ? [...(priorRejection.detail.msgIds as unknown[])].filter((id): id is string => typeof id === "string").sort()
            : null;
          const isRepeat = priorMsgIds !== null
            && priorMsgIds.length === currentMsgIds.length
            && priorMsgIds.every((id, i) => id === currentMsgIds[i]);
          const error = isRepeat
            ? `worker_report(done) REFUSED (again) — the SAME ${pending.length} instruction(s) from your manager are still unconsumed (unchanged since your last refusal):\n${pendingList}\n` +
              `Nothing NEW has arrived, so this doesn't look like a fresh supersede — RECONCILE against it (act on it, or if your work already satisfies it, say so) THEN re-report done. Your task stays in_progress.`
            : `worker_report(done) REFUSED — you have ${pending.length} UNRESOLVED instruction(s) queued from your manager that you have NOT consumed yet:\n${pendingList}\n` +
              `These may SUPERSEDE the work you're about to report (the incident this guards: a worker committed a superseded design before reading the manager's redirect). ` +
              `End this turn so the queued manager direction drains into your next turn, act on it, THEN re-report done. Your task stays in_progress.`;
          this.db.appendEvent({
            id: randomUUID(), ts: new Date().toISOString(),
            managerSessionId, workerSessionId, taskId, kind: "worker_report_rejected",
            detail: { reason: "pending-direction", queued: pending.length, msgIds: currentMsgIds, repeat: isRepeat },
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
            autoRetireTrigger = "no-commit-role";
          } else if (report.noChanges) {
            // DECLARED no-op done (card ccf0bbfe): the worker itself is asserting — for THIS report only —
            // that 0 commits ahead is correct, not accidental. Same treatment as the pinned-role case:
            // suppress the warning and auto-retire so its concurrency slot frees without a manual
            // worker_stop. A worker that DID produce commits ignores this flag entirely (zeroAhead is
            // false, so this branch never runs) — the signal only ever matters at 0-commits-ahead.
            autoRetireNoCommit = true;
            autoRetireTrigger = "declared-no-op";
          } else {
            // WARN only: a clean worktree on an assigned branch with 0 commits ahead of base, with no
            // declared-intent signal. A genuine no-op task can legitimately report done, so this never
            // refuses — it surfaces the warning in the result, the worker_report event, and the manager
            // notification. (The forgot-to-commit safety net for a NORMAL worker — unchanged.)
            warning =
              `your assigned branch '${worker.branch}' is 0 commits ahead of base — nothing to merge. ` +
              `Allowing the done (a real no-op task can legitimately report done), but if you intended to produce changes you likely forgot to commit them. ` +
              `If a future done is a legitimate no-op (a review, an investigation with nothing to change, an out-of-repo deliverable), pass noChanges:true to suppress this warning and auto-retire cleanly.`;
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
      // noChanges recorded ONLY when true (additive, forensics completeness — CR follow-up): also what the
      // auto-recovery re-confirmation dedupe above reads back via lastReport.detail.noChanges. `awaiting`
      // recorded ONLY when it's the non-default "background" (card c36bac53) — classifyIdleWorker below
      // reads it back to tell a self-attributed background-task park apart from a genuine awaiting-manager
      // checkpoint; an absent key means "manager" (the default), same normalize-on-read shape as noChanges.
      detail: { status: report.status, summary: report.summary, prUrl: report.prUrl, needs: report.needs, ...(warning ? { warning } : {}), ...(report.noChanges ? { noChanges: true } : {}), ...(report.awaiting === "background" ? { awaiting: "background" } : {}) },
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
      if (autoRetireNoCommit) {
        const why = autoRetireTrigger === "declared-no-op" ? "declared no-op done (noChanges)" : "declared no-commit role";
        framed += ` | auto-retired (${why}, 0 commits ahead — its concurrency slot is freed, no worker_stop needed)`;
      }
      // kind:"agent" — a worker→manager report is a distinct directive the manager must individually
      // process, never mashed with a sibling worker's report into one wall of text.
      const r = this.pty.enqueueStdin(managerSessionId, framed, "system", undefined, undefined, "agent");
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
        // The slot just freed DETERMINISTICALLY (see the comment above) — drain now rather than waiting
        // for the deferred pty.stop below to actually exit and reach the generic onExit-driven drain
        // several seconds later. Fire-and-forget (card 81b7e346); never disturbs this report path.
        if (managerSessionId) void this.maybeDrainCapQueue(managerSessionId);
        this.db.appendEvent({
          id: randomUUID(), ts: new Date().toISOString(),
          managerSessionId: managerSessionId ?? "", workerSessionId, taskId, kind: "stop_worker",
          detail: { reason: "no-commit-auto-retire", trigger: autoRetireTrigger },
        });
        // Deferred so THIS tool call's own MCP response (worker_report's reply, still in flight over the
        // MCP transport back to the worker's CLI) flushes BEFORE the pty's Ctrl-C×2 lands — mirrors
        // endMe's / recycleManager's close-after-delay (:4285 / :3765). Undeferred, the graceful-stop's
        // immediate \x03 raced the in-flight tool response and could interrupt the worker's OWN
        // worker_report turn, surfacing a false "[Request interrupted]" on a report that already
        // succeeded (card f46f4b0d). The DB retire above stays synchronous — the concurrency slot still
        // frees deterministically; only the pty write is delayed.
        setTimeout(() => { try { this.pty.stop(workerSessionId, "graceful"); } catch { /* already gone */ } }, 3000);
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
   * SINGLE-SOURCED idle-worker classification (CR fold-in on board card b9d479b0/99efaab3): both
   * notifyManagerOfIdleWorker (the busy→false edge nudge) AND IdleWatcher's periodic caller +
   * manager-loop message (via isWorkerGenuinelyStranded below) key off this ONE reconciliation — a
   * second, drifted copy is exactly how 99efaab3's false-alarm class reappears (a rate-limited worker
   * re-nagged for the length of its cap; a message asserting "unreported" for a worker that's actually
   * done-awaiting-merge or parked awaiting an ack).
   *
   * - `not-evaluable` — SPURIOUS-NUDGE GUARD (card 6101d7f7): `redirectWorker` on a BUSY worker enqueues
   *   its redirect into `live.pending` FIRST, then — in the SAME tick — clears busy and drains it. That
   *   clear fires the caller synchronously, BEFORE the drain hands the redirect over, so at this instant
   *   the worker looks stranded even though it has authoritative direction about to land as its very
   *   next turn. Also covers a non-worker/parentless/taskless session (nothing to classify).
   * - `not-stranded` — legitimately NOT a strand:
   *     • RATE-LIMIT GUARD (CR blocker) — a usage-capped worker goes `busy=false` (setBusy(false) fires
   *       BEFORE the rate-limit park) with its task still active; it never failed to report, it's
   *       waiting out the cap and will auto-resume itself. Without this, a PERIODIC caller would re-nag
   *       for the entire cap window (up to a week on the weekly cap).
   *     • already reported/merged — its task left the `active` lane.
   *     • QUEUED-REPORT GUARD (card a1f06bcc) — the task-column check above is a PROXY for "did the
   *       worker report", blind to two real gaps: a board missing the active/review role mapping
   *       (workerReport's move is a no-op, so the task never leaves `active` even though the report
   *       fired), and a report whose manager-facing framed message is still sitting UNDELIVERED in the
   *       manager's own pending FIFO (deliveryStatus "queued", manager mid-turn). Either way the report
   *       is REAL. Detected directly off the manager's OWN pending queue — the exact
   *       `[loom:worker-report] worker <id> …` text workerReport() enqueues (prefixed with THIS worker's
   *       id, so it can only match its own report).
   *     • WAKE GUARD (card dfa87343) — a worker that self-parked via `wake_me` (its task stays in the
   *       `active` lane, no fresh `worker_report`) looks identical to a genuine strand. `listWakesForSession`
   *       only ever returns wakes that are PENDING — a fired or cancelled wake is deleted (claim-first
   *       tick, `wake_cancel`) — so any row present means a not-yet-fired wake will resume this worker on
   *       its own; it never failed to report, it's deliberately waiting. Narrow by construction: a worker
   *       with no pending wake falls straight through to the stranded check below.
   * - `broken-spawn` — `busy` fell to false WITHOUT the worker ever running a turn (the fresh-spawn
   *   kickoff race — host.ts's scheduleKickoffGuarantee / the short pre-first-turn healIfStuck window).
   *   `engineSessionId` is captured ONLY on the engine's own SessionStart hook, so `null` here is
   *   definitive proof no turn — not even the kickoff — ever started. A DISTINCT failure, not a "did not
   *   report" stall.
   * - `parked-ack` — its LATEST `worker_report` (status `progress`, `done`, OR `blocked` — CR fold-in: a
   *   `done` report on a board with no review-role column never moves the task off `active`, so it looks
   *   identical to a progress-park; a `blocked` report is the same shape — the worker correctly stopped
   *   and is waiting on its manager, not stalled) has had no `message_worker`/`redirect_worker` event
   *   land since (the manager hasn't replied yet) — a healthy await-ack park, not a stall. Once the
   *   manager DOES reply and the worker goes idle again without a fresh report, this no longer holds — a
   *   real stall still classifies `stranded`, so an acked-then-stalled worker is never silently missed.
   * - `parked-wake` — SAME reported-and-unacked shape as `parked-ack`, but the worker ALSO has a PENDING
   *   self-scheduled wake (card 95b2abb3, follow-up to the WAKE GUARD below): it reported `progress`/
   *   `done`/`blocked` and then parked itself on its OWN `wake_me`, not on the manager. The manager owes
   *   it NO reply — it resumes itself when the wake fires — so this is reported with distinct wording
   *   rather than folded into `parked-ack`'s "awaiting your reply" phrasing, which would be false here.
   * - `parked-background` — card c36bac53: the worker's report itself SELF-ATTRIBUTED the park via
   *   `worker_report({..., awaiting: "background"})` — it kicked off a backgrounded command/sub-agent and
   *   is relying on ITS OWN completion (or the harness's on-completion re-invoke) to resume, not the
   *   manager. This is genuinely UNDETECTABLE from any daemon-observable state otherwise: the daemon has
   *   no API into the engine's background-task registry (confirmed in orchestration/resume-nudge.ts — a
   *   `claude --resume` kills any in-flight `run_in_background` shell precisely because Loom has no
   *   visibility into it, only the OS process tree), and the hook surface wired up for every session
   *   (SessionStart/UserPromptSubmit/Stop/StopFailure, plus PostToolUse only for the vault-lint matcher)
   *   captures no per-tool-call signal that could infer a live background job. UNLIKE `parked-wake`, this
   *   flag is a bare, self-reported claim with NO backing row and NO expiry of its own — checked AFTER the
   *   wake lookup now (round-2 CR fix): a pending wake is Loom's OWN verifiable, bounded resume signal (it
   *   drives the actual resume and names a concrete `wakeAt`), so it wins over the worker's unbacked
   *   self-attribution whenever both are present, not the other way around.
   * - `parked-background-stale` — round-2 CR Major: `parked-background` alone would let the flag promise
   *   "no reply owed; it will continue on its own" FOREVER if the background task dies silently and the
   *   worker never re-engages (no fresh report, no `wake_me`, nothing to decay it) — a SILENT, PERMANENT
   *   false negative, worse than the flat-assertion bug this card fixes (that one was at least noisy and
   *   self-healing: `worker_message` → `ackedSince` → next idle reclassifies `stranded`). So the flag is
   *   BOUNDED here: once `BACKGROUND_PARK_STALE_MINUTES` has elapsed since the flagged report with no
   *   ack/re-report, classification falls through to this actionable kind instead of repeating the "no
   *   reply owed" promise — nothing backs or bounds a bare self-attribution past that window.
   * - `stranded` — genuinely finished a turn, never (usefully) reported, and none of the above apply.
   */
  private classifyIdleWorker(workerSessionId: string):
    | { kind: "not-evaluable" | "not-stranded" | "broken-spawn" | "stranded" }
    | { kind: "parked-ack"; status: string }
    | { kind: "parked-wake"; status: string; wakeAt: string }
    | { kind: "parked-background"; status: string }
    | { kind: "parked-background-stale"; status: string; minutesSinceReport: number } {
    // TASKLESS is intentionally out of scope for THIS classifier (CR-flagged asymmetry, card 2514e6e1-
    // follow-up): every kind below `broken-spawn` reconciles via BOARD-COLUMN state (a task's active/
    // review/parked lane) — meaningless for a worker with no card. A taskless worker's OWN broken-spawn
    // coverage (the one kind here that needs no board state at all) is handled directly in
    // notifyManagerOfIdleWorker instead, WITHOUT routing through this classifier — see its comment.
    const w = this.db.getSession(workerSessionId);
    // ROLE-LESS children (role IS NULL, e.g. a role-less consultation worker) are exactly as evaluable as
    // role='worker' here — only an unrelated role (manager/platform/etc, which never has this manager as
    // its parent in practice) is excluded. Card df48366b: this used to hard-require role==='worker',
    // excluding a role-less child from ANY reconciliation.
    if (!w || (w.role !== "worker" && w.role !== null) || !w.parentSessionId || !w.taskId) return { kind: "not-evaluable" };
    if (this.pty.getPendingEntries(workerSessionId).length > 0) return { kind: "not-evaluable" }; // direction queued, about to drain

    if (w.rateLimitedUntil && Date.parse(w.rateLimitedUntil) > Date.now()) return { kind: "not-stranded" };

    // WAKE GUARD (card dfa87343): read the worker's pending self-scheduled wakes now, but DON'T branch on
    // them yet — a pending wake means different things depending on whether the worker also reported (see
    // the `parked-wake` vs the bare `not-stranded` return at the bottom of this function).
    const pendingWakes = this.db.listWakesForSession(workerSessionId);

    const task = this.db.getTask(w.taskId);
    const activeKey = this.columnKeyForProjectRole(w.projectId, "active");
    if (!task || task.columnKey !== activeKey) return { kind: "not-stranded" }; // reported/merged, or no active lane

    if (!w.engineSessionId) return { kind: "broken-spawn" };

    if (this.pty.getPendingEntries(w.parentSessionId).some((e) => e.text.startsWith(`[loom:worker-report] worker ${workerSessionId} `))) {
      return { kind: "not-stranded" };
    }

    const events = this.db.listEventsForWorker(workerSessionId);
    const lastReportIdx = events.findLastIndex((e) => e.kind === "worker_report");
    const lastReport = lastReportIdx !== -1 ? events[lastReportIdx] : undefined;
    const status = lastReport?.detail?.status as string | undefined;
    const ackedSince = !!lastReport && events.slice(lastReportIdx + 1).some((e) => e.kind === "message_worker" || e.kind === "redirect_worker");
    if (lastReport && (status === "progress" || status === "done" || status === "blocked") && !ackedSince) {
      // Reported AND has a pending self-scheduled wake → it's parked on its OWN gate, not the manager's
      // reply (card 95b2abb3) — checked FIRST (round-2 CR fix): a pending wake is Loom's OWN verifiable,
      // BOUNDED resume signal (a real `wakes` row, decays to `not-stranded`/`parked-ack` the moment it
      // fires or is cancelled), so it's strictly more trustworthy than the worker's own unbacked
      // `awaiting:"background"` self-attribution below when both happen to be present.
      const nextWake = pendingWakes[0];
      if (nextWake) return { kind: "parked-wake", status: status!, wakeAt: nextWake.wakeAt };
      // SELF-ATTRIBUTED background park (card c36bac53): the worker told us directly it's not awaiting a
      // reply — the ONLY way the daemon can know that at all (see the class doc). But unlike a wake, this
      // flag has no backing row and no expiry, so it must DECAY: past BACKGROUND_PARK_STALE_MINUTES since
      // the flagged report with no ack/re-report, it's no longer trustworthy on its own — fall through to
      // the actionable `parked-background-stale` kind instead of repeating "no reply owed" forever.
      const reportedAwaiting = (lastReport.detail as { awaiting?: string } | undefined)?.awaiting;
      if (reportedAwaiting === "background") {
        const minutesSinceReport = (Date.now() - Date.parse(lastReport.ts)) / 60_000;
        if (minutesSinceReport >= BACKGROUND_PARK_STALE_MINUTES) {
          return { kind: "parked-background-stale", status: status!, minutesSinceReport: Math.round(minutesSinceReport) };
        }
        return { kind: "parked-background", status: status! };
      }
      return { kind: "parked-ack", status: status! };
    }
    // No usable report to explain the idle state — a pending wake still means it'll resume on its own
    // (the ORIGINAL WAKE GUARD case: e.g. never reported at all, but self-parked anyway), so it's not a
    // stall the manager needs to act on; a worker with no report AND no wake is genuinely stranded.
    if (pendingWakes.length > 0) return { kind: "not-stranded" };
    return { kind: "stranded" };
  }

  /**
   * True when a live, idle worker is GENUINELY stranded (unreported and not legitimately parked). Exposes
   * classifyIdleWorker's reconciliation as a pure predicate so a caller that only needs "is this worker
   * worth calling unreported" (IdleWatcher's manager-loop message) single-sources the SAME check instead
   * of re-deriving a narrower/drifted copy — see classifyIdleWorker's doc for the false-alarm history
   * that guards against. A broken-spawn worker counts as stranded too (it genuinely never reported, just
   * for a distinct reason).
   */
  isWorkerGenuinelyStranded(workerSessionId: string): boolean {
    const cls = this.classifyIdleWorker(workerSessionId);
    return cls.kind === "stranded" || cls.kind === "broken-spawn";
  }

  /**
   * Stranded-worker guard. A worker only reaches its manager via worker_report's push; a worker
   * that ends its turn WITHOUT reporting goes idle silently and the manager — which has no
   * idle/exit signal for its children — waits forever. Called on every session's busy->false edge (and,
   * periodically, by IdleWatcher's tickIdleWorkers for a worker that's still idle later): classifies via
   * classifyIdleWorker and pushes the matching [loom:worker-idle] (or [loom:worker-spawn-broken]) nudge
   * to its manager. No-op for a non-strand (already reported/merged, rate-limited, queued report, or
   * legitimately parked awaiting an ack).
   *
   * TASKLESS (CR-flagged asymmetry on card 2514e6e1's taskless worker_spawn, widened by card df48366b): a
   * taskless worker (an ad-hoc spike, or a read-only Code Reviewer with no vehicle card) has no board card
   * for classifyIdleWorker's column-based reconciliation (parked-ack/queued-report need a task's lane) —
   * that classifier stays entry-gated on taskId and out of scope here (see its own comment). But two
   * things need no board state at all and are exactly as safety-critical for a taskless worker as a tasked
   * one: (1) "did the engine ever start a turn at all" (broken-spawn) and (2) "did it finish a turn and go
   * idle without EVER calling worker_report" (silent-finish) — a taskless worker that engaged, ran, and
   * went idle used to get NEITHER signal (this branch returned unconditionally once past the broken-spawn
   * check), leaving it just as silently stranded as the role-less case below. Handled directly here,
   * BEFORE delegating to classifyIdleWorker, with the SAME pending-direction race guard that classifier
   * applies (card 6101d7f7) and the busy-worker-watcher.ts `w.taskId ? ... : ""` taskId-optional message
   * shape. Reconciliation beyond "ever reported at all" (parked-ack wording, re-ack tracking) is
   * intentionally NOT extended to taskless — the manager that spawned it is expected to actively await +
   * worker_stop it directly once nudged.
   *
   * ROLE-LESS CHILDREN (card df48366b): a session with `role: null` parented to a manager (e.g. a
   * role-less consultation worker) is exactly as much this manager's responsibility as a role='worker'
   * child — the entry gate below used to hard-require `role === "worker"`, so a role-less child got NO
   * nudge whatsoever, tasked or not (the ONLY signal that could ever reach its manager on a silent finish).
   */
  notifyManagerOfIdleWorker(workerSessionId: string): void {
    const w = this.db.getSession(workerSessionId);
    if (!w || (w.role !== "worker" && w.role !== null) || !w.parentSessionId) return;

    const brokenSpawnMsg = `[loom:worker-spawn-broken] worker ${workerSessionId}${w.taskId ? ` (task ${w.taskId})` : ""} went idle WITHOUT ever starting a turn — its spawn kickoff never ran (no engine session was ever established). This is NOT a benign idle park; it will not resolve on its own. Re-drive it: worker_message it with the task direction, or worker_recycle/re-spawn if it stays stuck.`;

    if (!w.taskId) {
      if (this.pty.getPendingEntries(workerSessionId).length > 0) return; // direction queued, about to drain
      if (!w.engineSessionId) {
        try { this.pty.enqueueStdin(w.parentSessionId, brokenSpawnMsg); } catch { /* manager not live */ }
        return;
      }
      // It DID start a turn — has it EVER called worker_report? If not, it finished silently with no
      // board state to reconcile against, so this is the only signal available (no parked-ack/re-ack
      // nuance — that needs a report to compare against, which by definition doesn't exist yet).
      const everReported = this.db.listEventsForWorker(workerSessionId).some((e) => e.kind === "worker_report");
      if (!everReported) {
        const silentFinishMsg = `[loom:worker-idle] worker ${workerSessionId} finished a turn and is idle but has never called worker_report (taskless — no board card to check). It may be done-but-unreported or stalled — pull it: worker_transcript ${workerSessionId} to see what it did, then worker_message it or worker_stop it once reviewed.`;
        try { this.pty.enqueueStdin(w.parentSessionId, silentFinishMsg); } catch { /* manager not live */ }
      }
      return; // nothing else to classify without a task
    }

    const cls = this.classifyIdleWorker(workerSessionId);
    if (cls.kind === "not-evaluable" || cls.kind === "not-stranded") return;

    if (cls.kind === "broken-spawn") {
      try { this.pty.enqueueStdin(w.parentSessionId, brokenSpawnMsg); } catch { /* manager not live */ }
      return;
    }

    const msg = cls.kind === "parked-wake"
      ? `[loom:worker-idle] worker ${workerSessionId} (task ${w.taskId}) reported worker_report(${cls.status}) and is parked on its OWN scheduled wake (self-resumes at ${cls.wakeAt}) — no reply owed; it will continue on its own. Only step in if you want to redirect it: worker_transcript ${workerSessionId} to check on it, or worker_message it.`
      : cls.kind === "parked-background"
      ? `[loom:worker-idle] worker ${workerSessionId} (task ${w.taskId}) reported worker_report(${cls.status}) and flagged it's parked on its OWN backgrounded task (not you) — no reply owed; it will continue on its own once that finishes. Only step in if you want to redirect it: worker_transcript ${workerSessionId} to check on it, or worker_message it.`
      : cls.kind === "parked-background-stale"
      ? `[loom:worker-idle] worker ${workerSessionId} (task ${w.taskId}) flagged worker_report(${cls.status}) as parked on its OWN backgrounded task ~${cls.minutesSinceReport} min ago and still hasn't re-engaged — that flag has no expiry of its own and this is now stale, so it may be dead rather than genuinely still running. Pull it: worker_transcript ${workerSessionId} to check what actually happened, then worker_message it or worker_stop/worker_recycle it if the background task is gone.`
      : cls.kind === "parked-ack"
      ? `[loom:worker-idle] worker ${workerSessionId} (task ${w.taskId}) is idle after calling worker_report(${cls.status}) — it IS parked awaiting your reply, not stalled. If you haven't replied yet, worker_message it with direction; if it looks stuck anyway, pull it first: worker_transcript ${workerSessionId}.`
      : `[loom:worker-idle] worker ${workerSessionId} (task ${w.taskId}) finished a turn and is idle but did NOT call worker_report (its task is still in_progress). It may be done-but-unreported or stalled — pull it: worker_transcript ${workerSessionId} to see what it did, then worker_merge ${workerSessionId} to review, or worker_message it.`;
    try { this.pty.enqueueStdin(w.parentSessionId, msg); } catch { /* manager not live */ }
  }

  /**
   * Fire-time correctness guard for the idle-worker watchdog (auditor finding 2e3a8e6f — a delivery-vs-
   * watchdog TIMING race, distinct from the progress-vs-blocked guard on 5d41fc8a). Called on a WORKER's
   * OWN busy(false→true) edge (index.ts's onBusy hook) — the instant it re-engages, whether because its
   * manager replied (`worker_message`/`worker_redirect`) or it resumed on its own for any other reason.
   *
   * WHY: `notifyManagerOfIdleWorker` (above) classifies and enqueues its nudge the MOMENT a worker goes
   * idle (or on IdleWatcher's periodic re-check) — correct when computed. But if the manager is busy right
   * then, the nudge only QUEUES in its pending FIFO and drains on the manager's NEXT turn boundary. A
   * manager can reply to that very worker LATER IN THE SAME still-in-flight turn and only end its turn
   * afterward — at which point the STALE queued nudge (computed before the reply) drains as if fresh,
   * falsely telling an already-responded manager "it IS parked awaiting your reply". Purging on THIS edge
   * removes any such nudge before it can ever reach the manager. A worker that STAYS idle (no busy edge)
   * never has its queued nudge touched — this can only remove a nudge whose "still idle" premise has since
   * become false, so a genuinely-stranded worker with no reply is never silenced.
   */
  purgeStaleIdleNudgeForReengagedWorker(workerSessionId: string): void {
    const w = this.db.getSession(workerSessionId);
    // Mirrors notifyManagerOfIdleWorker's role gate (card df48366b) — a role-less child can now have a
    // nudge enqueued for it, so its re-engage edge must be able to purge a now-stale one too.
    if (!w || (w.role !== "worker" && w.role !== null) || !w.parentSessionId) return;
    try { this.pty.purgeQueuedWorkerIdleNudges(w.parentSessionId, workerSessionId); } catch { /* manager not live */ }
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
    // TASKLESS intentionally skipped here (CR-flagged asymmetry, card 2514e6e1-follow-up): this whole
    // guard's "still worth a nudge" test is "the task never left the active lane" — meaningless for a
    // worker with no card. Unlike the broken-spawn nudge above, an EXITED taskless worker isn't a distinct
    // hazard worth its own signal: the manager that spawned it is expected to actively await its report
    // and worker_stop it directly (worker_list already shows it as no-longer-live), and any taskless
    // commits worth recovering land the same way a tasked worker's do (worker_merge_confirm doesn't
    // require a task) — so there's no silent, unrecoverable loss this watchdog needs to catch here.
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
    // SUPPRESS auto-drain for this manager from the moment the old worker's slot MIGHT free (its hard-stop,
    // below) until the fresh successor's row is itself live again — recycleWorker re-claims that freed
    // slot directly (insertSession + setProcessState below is a 1:1 swap, never routed through spawnWorker's
    // own cap-admit), so a drain sneaking into this window could hand the "freed" slot to a queued entry
    // and then this method's own insert would push the manager one OVER cap. See recycleDrainSuppressed's
    // class doc. Lifted in a finally so a throw anywhere in this window can never leave it stuck suppressed.
    this.suppressCapQueueDrain(managerSessionId);
    try {
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
        capabilities: old.capabilities ?? [], // a recycled worker keeps its registry-capability grants
        restrictedTools: old.restrictedTools ?? false, // a recycled worker keeps its restricted-tools disallow
        noCommit: old.noCommit ?? false, // a recycled reviewer keeps its declared no-commit role
        skills: old.skills ?? null, // a recycled worker keeps its pinned skill subset (null ⇒ all)
        connections: old.connections ?? [], // a recycled worker keeps its authenticated-egress allowlist
        vaultWrite: old.vaultWrite ?? false, // a recycled worker keeps its confined vault-write grant
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
      // Project memory (card 2fd9abf9): a recycle spawns FRESH (no --resume), so — unlike resume(), which
      // injects for every role — a recycled worker would otherwise lose project notes its predecessor saw.
      // Same one-liner as spawnWorker, searched against the predecessor's handoff (the richest match text
      // available here); null (no notes) ⇒ byte-identical to today. Card ea648f89: stamp the dedup map so
      // this recycled worker's FIRST resume compares against what this fresh spawn just showed it.
      const recycleProjectMemoryFramed = retrieveProjectMemoryForKickoff(this.db, project.id, framed);
      this.stampProjectMemoryDigest(fresh.id, recycleProjectMemoryFramed);
      this.pty.spawn({
        sessionId: fresh.id,
        cwd: worktreePath,
        permission: workerSpawn?.permission ?? config.permission, // re-resolved layered allowlist (was bare config.permission)
        geometry: config.pty,
        sessionEnv: config.sessionEnv,
        vaultPath: config.docLint ? project.vaultPath : undefined, // Pillar D: scope the vault-lint hook
        codescapeEnabled: config.codescape.enabled, // card C2: Codescape MCP wiring, per-project opt-in
        projectId: project.id,
        // Lead with the worktree LOCATION block (same worktree — a recycled worker is equally at risk of
        // leaking edits to the main checkout), then the worker's agent base brief, then the handoff
        // (mirrors spawnWorker + the manager recycle warm-up). Empty brief ⇒ the block + handoff.
        startupPrompt: appendMemoryRecallToStartupPrompt(
          composeWorkerStartupPrompt(agent?.startupPrompt, framed, worktreePath, project.referenceRepos),
          recycleProjectMemoryFramed,
        ),
        role: "worker",
        browserTesting: old.browserTesting ?? false,
        documentConversion: old.documentConversion ?? false,
        capabilities: old.capabilities ?? [], // carry the registry-capability grants forward across recycle
        restrictedTools: old.restrictedTools ?? false, // carry the restricted-tools disallow forward across recycle
        model: workerSpawn?.model, // re-resolved profile model pin (undefined if agent gone ⇒ no `--model`); was dropped
        skills: old.skills ?? null, // carry the pinned skill subset forward across recycle (null ⇒ all)
        // Card f9b47cd1: RECOMPUTED (not carried from `old`) from the CURRENT agent name + task title, so a
        // recycled worker "keeps its name" for free as long as neither changed — the same agent/task pair
        // always slugs identically. EXCLUDE both fresh.id (already inserted+live by this point — the row
        // would otherwise "collide with itself", code review fix) and workerSessionId (the predecessor,
        // which can still show `live` mid-teardown and must never count as its successor's collision).
        sessionName: composeWorkerSessionName(
          project.name, agent?.name ?? "worker", taskId ? this.db.getTask(taskId)?.title ?? null : null, fresh.id,
          this.siblingWorkerSessionNames(managerSessionId, project.name, new Set([fresh.id, workerSessionId])),
        ),
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
    } finally {
      this.unsuppressCapQueueDrain(managerSessionId);
      // A drain suppressed during the window above may have left real headroom on the table (e.g. the
      // manager's cap was raised mid-recycle, or another slot freed independently while suppressed) — catch
      // up now that the swap is settled. Fire-and-forget, never blocks the caller.
      void this.maybeDrainCapQueue(managerSessionId);
    }
  }

  /**
   * Recycle a MANAGER near its context limit (the `recycle_me` flow). The manager has already run
   * /loom-session-end and written `continuationPrompt`; here Loom boots a FRESH successor manager seeded
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
    // PL Auditor finding #8 parity: a recycle-successor manager is a "fresh boot" exactly like
    // startManager's first spawn — it needs the SAME "Where things live" pre-block (absolute repo+vault
    // roots + the resolved resume-doc path), or it cold-boots into the same Glob-timeout trap a fresh
    // manager used to hit. Without this, the successor only ever saw the continuation handoff text and
    // had to guess/reconstruct its own resume-doc path.
    const startupPrompt = composeManagerStartupPrompt(
      (warmup ? warmup + "\n\n---\n" : "") +
        `[loom:continuation] You are the successor to a previous manager session that recycled as it neared its ` +
        `context limit. Continue its work from this handoff — your predecessor's live workers have been re-parented ` +
        `to you (run worker_list to see them). Predecessor's handoff:\n\n${continuationPrompt}`,
      { repoPath: project.repoPath, vaultPath: project.vaultPath, name: project.name, referenceRepos: project.referenceRepos, resumeDocFilename: config.orchestration.resumeDocFilename },
    );

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
      capabilities: old.capabilities ?? [], // carry the registry-capability grants forward (managers rarely set them)
      restrictedTools: old.restrictedTools ?? false, // carry the restricted-tools disallow forward
      noCommit: old.noCommit ?? false, // carry the declared no-commit role forward
      skills: old.skills ?? null, // carry the pinned skill subset forward (null ⇒ all)
      connections: old.connections ?? [], // carry the authenticated-egress allowlist forward
      vaultWrite: old.vaultWrite ?? false, // carry the confined vault-write grant forward
      scheduledSpawn: old.scheduledSpawn ?? false, // card 53edd8d5: a scheduler-spawned manager can't
      // dodge its own manager-cap budget by self-recycling — the successor still counts against it.
      gen: newGen,
      recycledFrom: old.id,
    };
    this.db.insertSession(fresh);
    // M5: flip to live BEFORE wiring the pty so a fast-failing spawn's onExit ('exited') always wins.
    this.db.setProcessState(fresh.id, "live");
    // Project memory (card 2fd9abf9): a manager recycle spawns FRESH (no --resume), so — unlike resume(),
    // which injects for every role — a recycled manager would otherwise lose project notes its
    // predecessor saw. Same one-liner as recycleWorker/spawnWorker, searched against the predecessor's
    // continuation handoff (the richest match text available here); null (no notes) ⇒ byte-identical to
    // today. Stamp the dedup map (card ea648f89) so this recycled manager's FIRST resume compares against
    // what this fresh spawn just showed it.
    const recycleManagerProjectMemoryFramed = retrieveProjectMemoryForKickoff(this.db, project.id, continuationPrompt);
    this.stampProjectMemoryDigest(fresh.id, recycleManagerProjectMemoryFramed);
    this.pty.spawn({
      sessionId: fresh.id,
      cwd: fresh.cwd,
      permission: managerSpawn?.permission ?? config.permission, // re-resolved layered allowlist (was bare config.permission)
      geometry: config.pty,
      sessionEnv: config.sessionEnv,
      vaultPath: config.docLint ? project.vaultPath : undefined, // Pillar D: scope the vault-lint hook
      codescapeEnabled: config.codescape.enabled, projectId: project.id, // card C2
      startupPrompt: appendMemoryRecallToStartupPrompt(startupPrompt, recycleManagerProjectMemoryFramed),
      role: "manager", // successor keeps the orchestration surface
      browserTesting: old.browserTesting ?? false,
      documentConversion: old.documentConversion ?? false,
      capabilities: old.capabilities ?? [], // carry the registry-capability grants forward across recycle
      restrictedTools: old.restrictedTools ?? false, // carry the restricted-tools disallow forward across recycle
      model: managerSpawn?.model, // re-resolved profile model pin (undefined if agent gone ⇒ no `--model`); was dropped
      skills: old.skills ?? null, // carry the pinned skill subset forward across recycle (null ⇒ all)
      sessionName: composeRoleSessionName("manager", project.name), // card f9b47cd1: unchanged across recycle
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
    // Card 8701bdbb: move the predecessor's decision-inbox questions onto the successor too — otherwise
    // question_pull's exact-session_id scoping strands an 'answered' (or still-'pending') question the
    // predecessor asked, unreachable from the successor's own session id.
    this.db.reparentQuestions(oldManagerId, fresh.id);
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
   * platform analogue of recycleManager. The Lead has already run /loom-session-end and written
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
    const resumeDocNotes = composeResumeDocOperationalNotes(project.vaultPath, leadResumeDocPath);
    const startupPrompt = composePlatformLeadStartupPrompt(continuation, leadResumeDocPath, resumeDocNotes);

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
      capabilities: old.capabilities ?? [], // carry the registry-capability grants forward across recycle
      restrictedTools: old.restrictedTools ?? false, // carry the restricted-tools disallow forward
      noCommit: old.noCommit ?? false, // carry the declared no-commit role forward
      skills: old.skills ?? null, // carry the pinned skill subset forward (null ⇒ all)
      connections: old.connections ?? [], // carry the authenticated-egress allowlist forward
      vaultWrite: old.vaultWrite ?? false, // carry the confined vault-write grant forward
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
      codescapeEnabled: config.codescape.enabled, projectId: project.id, // card C2
      startupPrompt,
      role: "platform", // successor keeps the platform surface
      browserTesting: old.browserTesting ?? false,
      documentConversion: old.documentConversion ?? false,
      capabilities: old.capabilities ?? [], // carry the registry-capability grants forward across recycle
      restrictedTools: old.restrictedTools ?? false, // carry the restricted-tools disallow forward across recycle
      model: leadSpawn?.model, // re-resolved profile model pin (undefined if agent gone ⇒ no `--model`)
      skills: old.skills ?? null, // carry the pinned skill subset forward across recycle (null ⇒ all)
      sessionName: PLATFORM_LEAD_SESSION_NAME, // card f9b47cd1: "loom-lead" — unchanged across recycle
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
   * The manager/platform-surface `idle_report` handler (Asleep-at-the-Wheel watchdog, §3 state→action
   * table; platform coverage added by card 98b3725c). A manager or Lead self-reports its idle
   * disposition so the watchdog stops nudging it (or, later, knows to alert the human). Maps the
   * reported state to a nudge policy on the P1 idle_nudge_* columns and, in
   * EVERY case, leaves the unanswered-nudge counter at 0 (the manager engaged, so the escalation clock
   * resets). resetIdleNudgeState clears policy+snooze+unanswered to the watching baseline; for
   * snoozed/suppressed we reset FIRST (to zero the counter) then layer the target policy on — so we
   * only ever touch the P1 accessors and never leave a stale count behind.
   *
   * NOTE: `done` suppresses the watchdog but does not itself raise a human-facing notification — here we
   * only set policy + audit the detail. The nudge ticker that drives this is Task 3.
   */
  recordIdleReport(
    sessionId: string,
    state: "working" | "waiting" | "done",
    opts: { detail?: string; minutes?: number } = {},
  ): { recorded: boolean; state: string; policy: IdleNudgePolicy; snoozeUntil: string | null; unanswered: number } {
    const session = this.db.getSession(sessionId);
    if (!session) throw new Error("unknown session");
    if (session.role !== "manager" && session.role !== "platform") throw new Error("idle_report is a manager/platform-only surface");
    const project = this.db.getProject(session.projectId);
    if (!project) throw new Error("project not found");

    let policy: IdleNudgePolicy;
    let snoozeUntil: string | null = null;
    // working → back at work: drop straight to the watching baseline (policy/snooze/unanswered all clear).
    // waiting → snooze for `minutes` (or the per-project default) — silent until then.
    // done → suppress (nothing left for this manager to do; here we just stop nudging).
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
      // done
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

  /** Role gate for {@link runWorkerGate} (card 7f96aa09): the caller must be a live WORKER session —
   *  defense in depth mirroring `requireManager` above, on TOP of `run_gate` only ever being REGISTERED
   *  on the `role==="worker"` MCP branch in the first place (mcp/orchestration.ts). Rejects a plain/run
   *  session outright (wrong role); a TASKLESS (ad-hoc) worker is fine — run_gate needs a worktree, not a
   *  task. */
  private requireWorker(sessionId: string, surface: string): void {
    const session = this.db.getSession(sessionId);
    if (!session) throw new Error("unknown session");
    if (session.role !== "worker") throw new Error(`${surface} is a worker-only surface`);
  }

  /**
   * The OWN-PROJECT containment boundary for every manager self-service write. A manager's self-service
   * tools (project_update/_archive, agent_update/_assign_profile, schedule_create/_update) take a target
   * id as a param; without this guard a prompt-injected/confused manager could reconfigure or archive ANY
   * project — including the reserved Loom Platform home — breaking the documented invariant that
   * platform_escalate (the hardcoded Platform-board escalation) and peer_message (the project_links-gated
   * manager↔manager channel, board card 2349d90c) are the manager's ONLY two structured cross-project
   * writes. Each method derives the target's project via this helper and REJECTS a target outside the
   * caller's own project. Throws (→ the router's error envelope) on a session with no project, so a write
   * can never escape its scope.
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
   * card (agent_get/agent_update prefix asymmetry): resolve an agentId ref for a manager-surface agent
   * WRITE exactly like agent_get resolves it for a READ — full id first (a real cross-project id still
   * hits this and falls through to requireOwnProject's more informative "outside your project" error),
   * else an unambiguous 8-char id-PREFIX scoped to the manager's OWN project only (listAgents(ownProjectId)
   * — mirrors agent_get's own-project scoping, so a prefix can never discover a cross-project agent's
   * existence). Ambiguous/none surface the SAME error shape agent_get gives.
   */
  private resolveManagerAgentRef(managerSessionId: string, ref: string): Agent {
    const exact = this.db.getAgent(ref);
    if (exact) return exact;
    const ownProjectId = this.db.getSession(managerSessionId)?.projectId;
    if (!ownProjectId) throw new Error("no project for this session");
    const r = resolveIdPrefix(this.db.listAgents(ownProjectId), ref);
    if (r.kind === "found") return r.record;
    if (r.kind === "ambiguous") {
      throw new Error(`ambiguous agent id-prefix '${ref}' — it matches ${r.ids.join(", ")}; pass more characters or the full id`);
    }
    throw new Error("agent not found");
  }

  /**
   * Assign an EXISTING human-authored profile to an agent (or clear it with `profileId: null`).
   * Option B: profile CREATE/edit stays human-only, so any assignable profileId was minted by a
   * human who intended it assignable — assignment can't escalate beyond what a human already blessed.
   * No ⊆-capabilities check is needed under Option B. A non-null profileId MUST resolve (else reject).
   */
  assignAgentProfile(managerSessionId: string, agentId: string, profileId: string | null): Agent {
    this.requireManager(managerSessionId, "agent_assign_profile");
    const agent = this.resolveManagerAgentRef(managerSessionId, agentId);
    this.requireOwnProject(managerSessionId, agent.projectId, "agent_assign_profile");
    if (profileId != null && !this.db.getProfile(profileId)) throw new Error("profile not found");
    this.db.updateAgent(agent.id, { profileId });
    this.auditManage(managerSessionId, "agent_assign_profile", { agentId: agent.id, profileId });
    return this.db.getAgent(agent.id)!;
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
    const agent = this.resolveManagerAgentRef(managerSessionId, agentId);
    this.requireOwnProject(managerSessionId, agent.projectId, "agent_update");
    if (patch.startupPrompt !== undefined && patch.appendToStartupPrompt !== undefined) {
      throw new Error("agent_update: pass startupPrompt (full replace) OR appendToStartupPrompt (append), not both");
    }
    const startupPrompt = patch.appendToStartupPrompt !== undefined
      ? (agent.startupPrompt ? `${agent.startupPrompt}\n\n${patch.appendToStartupPrompt}` : patch.appendToStartupPrompt)
      : patch.startupPrompt;
    this.db.updateAgent(agent.id, { name: patch.name, startupPrompt });
    this.auditManage(managerSessionId, "agent_update", { agentId: agent.id, fields: Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined) });
    return this.db.getAgent(agent.id)!;
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
   * PERMANENTLY delete one of the manager's OWN-project agents — layers requireOwnProject (rejects a
   * target outside the caller's project BEFORE any write; a manager has no cross-project reach) and
   * auditManage on top of the shared deleteAgentCore (delete-agent-core.ts — also reused by the human
   * REST handler and the Platform Lead's agent_delete tool).
   */
  deleteAgentAsManager(managerSessionId: string, agentId: string): { deleted: true; agentId: string; sessions: number } {
    this.requireManager(managerSessionId, "agent_delete");
    const agent = this.db.getAgent(agentId);
    if (!agent) throw new Error("agent not found");
    this.requireOwnProject(managerSessionId, agent.projectId, "agent_delete");
    const result = deleteAgentCore(this.db, agentId);
    this.auditManage(managerSessionId, "agent_delete", { agentId, sessions: result.sessions });
    return result;
  }

  /**
   * PERMANENTLY delete a cross-project Profile (rig) — but ONLY if no agent OUTSIDE the caller's own
   * project references it. Profiles are shared/global (unlike agents), so a single-project manager could
   * otherwise delete a rig another project depends on; this guard is ADDITIVE on top of the human/Lead
   * path (which has NO in-use guard at all — db.deleteProfile is a blind, safe-by-design delete, since a
   * dangling profileId just resolves to the plain backstop). A reference confined to the caller's OWN
   * project is fine (mirrors the human path's cascade-to-null for those agents) and does not block delete.
   *
   * The external-project scan covers BOTH live (listAllProjects) AND archived (listArchivedProjects)
   * projects — archived is a soft, RESTORABLE state (not gone), so an agent in an archived foreign
   * project still counts as an external reference; skipping it would let a manager delete a rig that
   * silently dangles the instant that project is restored.
   */
  deleteProfileAsManager(managerSessionId: string, profileId: string): { deleted: true; profileId: string } {
    this.requireManager(managerSessionId, "profile_delete");
    if (!this.db.getProfile(profileId)) throw new Error("profile not found");
    const ownProjectId = this.db.getSession(managerSessionId)?.projectId;
    if (!ownProjectId) throw new Error("no project for this session");
    const external = [...this.db.listAllProjects(), ...this.db.listArchivedProjects()]
      .filter((p) => p.id !== ownProjectId)
      .flatMap((p) => this.db.listAgents(p.id).filter((a) => a.profileId === profileId).map((a) => ({ agent: a, project: p })));
    if (external.length > 0) {
      const blockers = external.map(({ agent, project }) => `${agent.name} (${agent.id}) in project ${project.name} (${project.id})`).join(", ");
      throw new Error(`profile_delete: profile is still referenced by agents outside your project — ${blockers}`);
    }
    this.db.deleteProfile(profileId);
    this.auditManage(managerSessionId, "profile_delete", { profileId });
    return { deleted: true, profileId };
  }

  /**
   * Create a cron schedule that boots a manager in `agentId` on each tick (autonomous wake — agents
   * already self-`wake_me`, so this is low-risk). next_fire_at is computed here (strictly-after);
   * an invalid cron expression is rejected.
   */
  createSchedule(
    managerSessionId: string, input: { agentId: string; cron: string; enabled?: boolean; prompt?: string | null; name?: string },
  ): Schedule {
    this.requireManager(managerSessionId, "schedule_create");
    const targetAgent = this.db.getAgent(input.agentId);
    if (!targetAgent) throw new Error("agent not found");
    this.requireOwnProject(managerSessionId, targetAgent.projectId, "schedule_create");
    let next: string;
    try { next = nextFireAt(input.cron, new Date()); } catch { throw new Error("invalid cron expression"); }
    const schedule: Schedule = {
      id: randomUUID(),
      // The agent surface makes a name OPTIONAL (unlike the human REST/builder, which requires it): a
      // blank/omitted name derives a friendly default from the cron at the DB write path (describeCron),
      // so an existing agent caller stays backward-compatible.
      name: (input.name ?? "").trim(),
      agentId: input.agentId, cron: input.cron,
      enabled: input.enabled ?? true, nextFireAt: next, lastFiredAt: null, createdAt: new Date().toISOString(),
      // A manager's self-service schedule always boots a manager (P5 'auditor' schedules are a
      // platform/human concern — created via the platform tool or REST, never this surface).
      kind: "manager",
      prompt: input.prompt ?? null,
    };
    this.db.insertSchedule(schedule);
    this.auditManage(managerSessionId, "schedule_create", { scheduleId: schedule.id, agentId: input.agentId, cron: input.cron });
    return schedule;
  }

  /**
   * Update a schedule's cron, enabled flag, and/or custom prompt. A changed cron recomputes
   * next_fire_at (rejected if invalid); enabled toggles the Scheduler on/off for this row.
   */
  updateScheduleAsManager(
    managerSessionId: string, scheduleId: string, patch: { cron?: string; enabled?: boolean; prompt?: string | null; name?: string },
  ): Schedule {
    this.requireManager(managerSessionId, "schedule_update");
    const schedule = this.db.getSchedule(scheduleId);
    if (!schedule) throw new Error("schedule not found");
    // Resolve the schedule → its agent → that agent's project; reject a schedule outside the caller's
    // project (a missing agent can never match own, so it's rejected too).
    this.requireOwnProject(managerSessionId, this.db.getAgent(schedule.agentId)?.projectId, "schedule_update");
    const dbPatch: { name?: string; cron?: string; enabled?: boolean; nextFireAt?: string; prompt?: string | null } = {};
    // A blank rename is ignored at the DB write path (normalizeScheduleName), so an agent can't wipe a name.
    if (typeof patch.name === "string") dbPatch.name = patch.name;
    if (typeof patch.enabled === "boolean") dbPatch.enabled = patch.enabled;
    if (patch.prompt !== undefined) dbPatch.prompt = patch.prompt;
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
   * platform-lead is human-equivalent, above the manager/worker tree. Also reused, unmodified, as the
   * STOP half of the companion session-control ACT lever (card 305a54fb, `session_stop`) —
   * scope/roleFilter/Primitive-A enforcement live entirely in the lever (companion/capabilities.ts); this
   * method needs no companion-specific variant since it carries no framed text to differentiate.
   */
  stopSession(sessionId: string, mode: StopMode): { stopped: true; sessionId: string } {
    if (!this.db.getSession(sessionId)) throw new Error("session not found");
    this.pty.stop(sessionId, mode);
    return { stopped: true, sessionId };
  }

  /**
   * Self-scoped terminal exit (agent MCP `end_me`, card 3b015fc7) — the no-successor sibling of
   * recycle_me. NO target arg: every registered surface binds this to the URL-path/caller session id,
   * so a session can end ONLY itself (least-privilege — the whole safety story). Two gates; either
   * REFUSES (does not stop, does not throw — a structured result the agent can act on):
   *   1. INBOUND QUEUE — unconsumed `kind:"agent"` messages still queued (manager direction, a human
   *      composer turn, companion inbound; see pty/host.ts QueuedMessageKind). Mirrors the intent of the
   *      worker_report(done) pending-direction guard above (generalized to every agent-kind sender, not
   *      just manager-origin). Operational `kind:"warning"` nudges (idle/context/usage watchdogs,
   *      memory-recall) do NOT block — they coalesce, they aren't direction.
   *   2. LIVE WORKERS — a manager (or platform Lead) caller with ≥1 LIVE worker/child session, so a
   *      self-end can't strand a live fleet under a dead parent. Non-manager/non-platform roles skip
   *      this gate. (A platform Lead's spawned sessions are never parented to it — recyclePlatformLead's
   *      doc above — so listWorkers is naturally empty for a Lead and this gate is a structural no-op
   *      for that role; the SAME check still runs, it just never trips, matching the architecture.)
   * On pass: graceful-stops the caller's OWN pty (same path as stopSession(id,"graceful") — Ctrl-C×2,
   * clean, resumable — the row lands on Archive), DEFERRED so this tool call's own MCP response flushes
   * before the pty dies (mirrors recycleManager's close-after-delay above).
   */
  endMe(sessionId: string): { stopped: boolean; reason?: "queued-inbound" | "live-workers"; pending?: number; count?: number; message?: string } {
    const session = this.db.getSession(sessionId);
    if (!session) throw new Error("session not found");

    const pending = this.pty.pendingAgentCount(sessionId);
    if (pending > 0) {
      this.db.appendEvent({
        id: randomUUID(), ts: new Date().toISOString(),
        managerSessionId: sessionId, kind: "end_me_refused", detail: { reason: "queued-inbound", pending },
      });
      return {
        stopped: false, reason: "queued-inbound", pending,
        message: `end_me REFUSED — you have ${pending} unconsumed inbound message(s) queued (manager direction / a human turn / companion inbound). End this turn so they drain into your next turn, act on them, THEN re-call end_me.`,
      };
    }

    if (session.role === "manager" || session.role === "platform") {
      const count = this.db.listWorkers(sessionId).filter((w) => w.processState === "live").length;
      if (count > 0) {
        this.db.appendEvent({
          id: randomUUID(), ts: new Date().toISOString(),
          managerSessionId: sessionId, kind: "end_me_refused", detail: { reason: "live-workers", count },
        });
        return {
          stopped: false, reason: "live-workers", count,
          message: `end_me REFUSED — you have ${count} live worker(s)/child session(s). Recycle or stop the wave first, then re-call end_me.`,
        };
      }
    }

    this.db.appendEvent({
      id: randomUUID(), ts: new Date().toISOString(),
      managerSessionId: sessionId, kind: "end_me_complete", detail: {},
    });
    // Deferred so THIS tool call's own MCP response flushes before the pty dies (mirrors recycleManager's
    // close-after-delay at :3765 / recyclePlatformLead's below).
    setTimeout(() => { try { this.pty.stop(sessionId, "graceful"); } catch { /* already gone */ } }, 3000);
    return { stopped: true };
  }

  /**
   * Auto-archive-on-exit gate (card 6cd3ce9e — the orphaned-fleet strand). index.ts's onExit archives
   * EVERY exited non-run session by default (every "stopped" session leaves the live rail for Archive).
   * That default is wrong for a manager/platform that still owns ≥1 LIVE worker/child session at the
   * instant it exits — ANY exit cause (a deliberate human Stop, an interrupt, an unexpected death):
   * archiving would silently strand the fleet, since Archive drops the row off every rail/god's-eye list
   * (listSessions/listWorkers exclude archived rows) while its children stay live+busy with no live
   * parent to review/merge/stop them — invisible until a human happens to notice.
   *
   * This is the after-the-fact twin of `endMe`'s "live-workers" gate: that one REFUSES a VOLUNTARY
   * self-stop up front (the pty is still alive, so the stop itself can be blocked); here the pty is
   * ALREADY DEAD by the time onExit runs, so there's nothing left to refuse — the only lever is what
   * happens to the ROW. So: skip the archive (leave it exited-but-unarchived — still on the live rail,
   * still resumable via the normal resume flow, which un-archives regardless) and file a DISTINCT durable
   * `manager_exited_with_live_workers` event naming the stranded count — the audit-trail record (mirrors
   * the strand-family events `worker_report_undelivered`/`worker_exited_without_report`), retrievable via
   * listEventsForSession/a Lead's audit sweep. useAttention (web) only polls orchestration events for LIVE
   * managers, so a dead manager's event alone would never reach Mission Control — the SAME `lastError`
   * banner ALSO stamped here (`[loom:orphaned-fleet]`) is what actually surfaces it: web/src/lib/
   * attention.ts's `isOrphanedFleet` reads this role-agnostic session-row signal exactly like the existing
   * `isCrashLooped`/`[loom:crash-loop]` pair, turning it into a red "ORPHANED FLEET" attention item + shell
   * bell regardless of role/liveness.
   *
   * Deliberately does NOT change auto-resume policy: an INTENDED stop is still never auto-resumed by the
   * crash-recovery watchdog (recordUnexpectedExit's `intended` gate is untouched) — this only keeps the
   * row (and its orphaned children) VISIBLE so a human (or a resumed successor) can act. A manager/
   * platform with NO live children — the overwhelming common case — archives exactly as before, and every
   * non-manager/platform role (worker/run/assistant/etc.) is byte-identical to the old unconditional call.
   */
  archiveOnExit(session: Session): void {
    if (session.role === "manager" || session.role === "platform") {
      const liveWorkers = this.db.listWorkers(session.id).filter((w) => w.processState === "live");
      if (liveWorkers.length > 0) {
        this.db.appendEvent({
          id: randomUUID(), ts: new Date().toISOString(),
          // Filed with workerSessionId = the exited manager itself (the SUBJECT), managerSessionId = its
          // OWN parent if any else its own id — mirrors session_died/session_recovery_abandoned so
          // listEventsForWorker(session.id) retrieves it regardless of role (a manager has no "worker id"
          // of its own otherwise).
          managerSessionId: session.parentSessionId ?? session.id, workerSessionId: session.id,
          kind: "manager_exited_with_live_workers",
          detail: { count: liveWorkers.length, workerIds: liveWorkers.map((w) => w.id) },
        });
        this.db.setLastError(
          session.id,
          `[loom:orphaned-fleet] This ${session.role} exited while ${liveWorkers.length} worker(s)/child ` +
          `session(s) were still live — they are now parentless. Resume this session (it will re-adopt ` +
          `them) or reparent/stop them via a sibling manager. Loom did NOT auto-archive so this stays visible.`,
        );
        return; // do NOT archive — stay on the live rail, visible + resumable
      }
    }
    this.db.archiveSession(session.id);
  }

  /**
   * Step 1 of the two-step merge gate (#16): show the manager a worker's branch diff. NO merge
   * happens — this is the review the manager cannot skip (there is no worker-side merge tool).
   */
  async reviewWorkerMerge(
    managerSessionId: string, workerSessionId: string,
    opts: { includePatch?: boolean; files?: string[]; pathGlob?: string } = {},
  ): Promise<{
    filesChanged: number; insertions: number; deletions: number; files: DiffstatFile[];
    patch?: string; patchFile?: string; patchChars?: number; note?: string; warning?: string; hint?: string;
  }> {
    const worker = this.db.getSession(workerSessionId);
    if (!worker || worker.parentSessionId !== managerSessionId) throw new Error("not your worker");
    if (!worker.branch) throw new Error("worker has no branch");
    const project = this.db.getProject(worker.projectId);
    if (!project) throw new Error("project not found");
    // DEFAULT: a bounded diffstat (per-file ± + totals) so step-1 can't overflow the display on a big diff.
    // The full unified patch is opt-in (includePatch) — see the worker_merge tool's `fullDiff` flag. An
    // OPTIONAL files/pathGlob filter (additive — see diffBranch) further scopes BOTH the diffstat and the
    // patch to matching file(s), so a manager can pull one file's hunk at a time instead of the whole patch.
    const includePatch = opts.includePatch === true;
    const diff = await diffBranch(project.repoPath, worker.branch, "HEAD", { includePatch, files: opts.files, pathGlob: opts.pathGlob });
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
    // otherwise a `note` tells the manager how to pull it. A requested patch that's still too large to
    // safely inline (it would round-trip through JSON.stringify, whose `\n` -> `\n`-escape collapse left a
    // spilled patch as ONE giant unpaginatable, non-UTF8-safe line — auditor finding 8a942a95) is instead
    // written straight to a scratch file (real line breaks, explicit UTF-8) and the response carries
    // patchFile/patchChars + a note instead of the inline patch.
    return {
      filesChanged: diff.filesChanged,
      insertions: diff.insertions,
      deletions: diff.deletions,
      files: diff.files,
      ...(includePatch
        ? (diff.patch.length > MERGE_PATCH_INLINE_CAP
          ? (() => {
            const patchFile = this.spillMergePatch(managerSessionId, workerSessionId, diff.patch);
            return {
              patchFile,
              patchChars: diff.patch.length,
              note: `Full patch is ${diff.patch.length} chars — too large to inline safely, so it was written to ` +
                `${patchFile} (UTF-8, real line breaks). Page it with Read (offset/limit are LINE-based), or ` +
                `re-call worker_merge with a files/pathGlob filter to scope the diff to fewer files.`,
            };
          })()
          : { patch: diff.patch })
        : { note: "Diffstat only — re-call worker_merge with fullDiff:true for the full unified patch." }),
      ...(warning ? { warning } : {}),
      ...(diff.hint ? { hint: diff.hint } : {}),
    };
  }

  /**
   * Persist an oversized worker_merge patch to the manager's scratch dir, NEWLINE-DELIMITED (the raw git
   * diff text already carries real `\n`s — writing it directly, rather than embedding it in a JSON tool
   * response, is what keeps them real instead of collapsing into the JSON string escape `\n`) and
   * EXPLICITLY UTF-8 encoded, so `Read` can page it with offset/limit and a non-UTF8-aware fallback (e.g. a
   * Windows cp1252 python read()) doesn't choke on box-drawing/Unicode diff content. Deterministic path
   * (keyed by workerSessionId, not a fresh name per call) so repeated fullDiff pulls don't accumulate
   * garbage in the scratch dir — each overwrites the prior spill.
   */
  private spillMergePatch(managerSessionId: string, workerSessionId: string, patch: string): string {
    const dir = path.join(sessionScratchDir(managerSessionId), "merge-diffs");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${workerSessionId}.patch`);
    fs.writeFileSync(file, patch, "utf8");
    return file;
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
   * RECONCILE-BEFORE-NOTIFY (Auditor finding 8fb05b2d): a `[loom:merge-rejected]` pty notification can
   * otherwise fire long after the situation it describes has resolved out-of-band — e.g. a client-timeout
   * on `worker_merge_confirm` leaves the manager to manually squash-merge the task itself, then the
   * ORIGINAL confirmWorkerMerge run (or a retry that re-invoked it from scratch once the pendingOps entry
   * had already settled+evicted) finishes and delivers a stale "build gate failed" — burning the manager's
   * turns confirming an echo of something already resolved. Suppress the NOTIFY only (never the caller's
   * `merged:false`/`reason` return, nor the `merge_rejected` event — those stay accurate bookkeeping) when:
   *  - the task's card is already in its project's terminal lane (Done) — the situation resolved another
   *    way, or
   *  - the branch's work is already reachable from main — reuses the SAME ancestry check the ALREADY_MERGED
   *    path derives from ({@link findLandedSquashCommit}'s deterministic `Loom-Worker-Branch` trailer scan),
   *    not a second one, or
   *  - an IDENTICAL rejection (same worker + reason) was already recorded for this task — de-dupe, so a
   *    stale re-run reproducing the same failure doesn't notify twice.
   * FAILS SAFE throughout: any read/git error is treated as "not resolved yet" (never suppress a genuine
   * first notification on a flaky check).
   */
  private async shouldSuppressMergeReject(
    workerSessionId: string, taskId: string | null, branch: string, repoPath: string, reason: string,
  ): Promise<boolean> {
    if (taskId) {
      const task = this.db.getTask(taskId);
      if (task) {
        const terminalKey = this.columnKeyForProjectRole(task.projectId, "terminal");
        if (terminalKey && task.columnKey === terminalKey) return true;
      }
    }
    if (await findLandedSquashCommit(repoPath, branch, "HEAD", { timeoutMs: this.gitOpMs })) return true;
    try {
      const already = this.db.listEventsForWorker(workerSessionId)
        .some((e) => e.kind === "merge_rejected" && e.detail?.reason === reason);
      if (already) return true;
    } catch { /* fail safe: a dedupe-read error must not suppress a genuine first notification */ }
    return false;
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
    managerSessionId: string, workerSessionId: string, opId?: string, forceRemoveWorktree?: boolean,
  ): Promise<ConfirmMergeResult> {
    // CORRELATION STAMP (card 369d8824): threaded from PendingOpRegistry.attach (the SAME opId a caller
    // routed through confirmWorkerMergeTracked was already handed in its own `{status:"pending",opId}`
    // response) so every `[loom:merge-*]` nudge this call emits can be matched back to the confirm that
    // produced it. A caller OUTSIDE that registry (the human REST merge route) passes none — mint one
    // fresh so its signals/return are stamped just as consistently, even though nothing else correlates to it.
    const thisOpId = opId ?? randomUUID();
    const worker = this.db.getSession(workerSessionId);
    if (!worker || worker.parentSessionId !== managerSessionId) throw new Error("not your worker");
    if (!worker.branch) throw new Error("worker has no branch");
    const project = this.db.getProject(worker.projectId);
    if (!project) throw new Error("project not found");
    const worktreePath = worker.worktreePath ?? worker.cwd;
    const taskId = worker.taskId ?? null;
    const branch = worker.branch;
    // RESOLVE-LIVE: read the gate command AND its per-project timeout fresh here, so a human PATCH to
    // either takes effect with no daemon restart. Also threads the daemon-global platform override so
    // `orchestration.maxConcurrentGates` (host-load guard, card 301d8c01) resolves correctly below —
    // that field has no per-project layer (like schedulerEnabled).
    const orchestration = resolveConfig(project.config, this.db.getPlatformConfig()).orchestration;
    const gate = orchestration.gateCommand;
    const gateTimeoutMs = orchestration.gateCommandTimeoutMs;

    // EARLY IDEMPOTENCY (finding 864e79fe — false-negative "build gate failed" after a SUCCESSFUL merge;
    // widened by the re-poll terminal-result-read fix below): a stale confirm retry (e.g. a client-timeout
    // on the FIRST call — see confirmWorkerMergeTracked — followed by a re-call that lands after the
    // pending-op entry already settled+evicted) re-invokes this method for real, but a PRIOR call may have
    // already merged + finalized this exact worker: worktree removed, branch deleted, task moved to done.
    // Running the gate below against that now-gone worktreePath used to make the gate fail (its cwd doesn't
    // exist) and falsely report a build-gate failure for a merge that had already SUCCEEDED.
    //
    // WORKTREE-GONE is not the only proof of "this daemon already finished." removeWorktree's dir removal
    // is best-effort (a Windows handle-release race — see its doc — can outlast its own bounded retries),
    // so finalizeMerge can complete the ENTIRE merge (branch deleted, task moved to done) while the worktree
    // DIRECTORY itself lingers on disk, leaked for a later GC pass. A stale retry landing in exactly that
    // window used to see `fs.existsSync(worktreePath) === true`, skip this whole idempotency block, and
    // re-run the gate against that leaked/de-registered worktree — which can genuinely fail (broken git
    // state) and misreport "build gate failed" for a worker that had already merged successfully. So the
    // worktree-existence check is widened with an OR: the task ALREADY being in its terminal (done) lane is
    // an equally authoritative "this daemon's own finalizeMerge already ran for this worker" signal.
    //
    // Gated on BOTH signals, not just one — worktree gone (or task done) AND the branch's landing itself
    // independently proven:
    //  - worktreePath is GONE from disk, OR the task is already in its terminal lane — cheap, checked
    //    first; a branch that's landed but whose worktree is still genuinely present AND whose task is NOT
    //    yet terminal (e.g. merge-reject-notify-suppress.mjs scenario B: an out-of-band manual squash-merge
    //    racing a daemon confirm whose gate is STILL failing for its own real reason) must keep running the
    //    gate/report the real failure — only the manager-facing NOTIFY is reconciled away there
    //    (shouldSuppressMergeReject), never the return value or the gate itself skipped.
    //  - the branch's work is reachable from main via the deterministic `Loom-Worker-Branch` trailer
    //    (findLandedSquashCommit — same signal mergeBranch's own ALREADY_MERGED classification uses, incl.
    //    its re-task guard: a branch RE-CUT onto a prior squash with genuine NEW work returns null, so a
    //    live re-task is never short-circuited here). This is what keeps merge-reject-notify-suppress.mjs
    //    scenario C (task already Done for an UNRELATED reason, gate genuinely still fails, branch never
    //    actually merged) reporting the real failure: task-done alone never short-circuits without this
    //    independent landing proof.
    // Only when (the worktree is gone OR the task is already done) AND the landing is proven do we finish
    // idempotently without touching the gate or any git state that's already been retired.
    const taskAlreadyTerminal = taskId != null && (() => {
      const task = this.db.getTask(taskId);
      const terminalKey = task ? this.columnKeyForProjectRole(task.projectId, "terminal") : undefined;
      return !!task && !!terminalKey && task.columnKey === terminalKey;
    })();
    if (!fs.existsSync(worktreePath) || taskAlreadyTerminal) {
      const alreadyLanded = await findLandedSquashCommit(project.repoPath, branch, "HEAD", { timeoutMs: this.gitOpMs });
      if (alreadyLanded) {
        return this.finishAlreadyMerged({ managerSessionId, workerSessionId, taskId, worktreePath, branch, repoPath: project.repoPath, projectId: project.id, opId: thisOpId, forceRemoveWorktree });
      }
    }

    const evt = (kind: OrchestrationEvent["kind"], detail?: Record<string, unknown>) => this.db.appendEvent({
      id: randomUUID(), ts: new Date().toISOString(), managerSessionId, workerSessionId, taskId, kind, detail,
    });
    // kind:"agent" — a merge-rejection result names a specific worker/task and requires distinct manager
    // action (recover a commit, re-task, rebase); it must never be mashed with an unrelated turn.
    // RECONCILE-BEFORE-NOTIFY (shouldSuppressMergeReject): called with the SAME `reason` the sibling evt()
    // call records, and BEFORE that evt() call runs, so the dedupe check only ever sees PRIOR invocations'
    // events — never its own about-to-be-appended one (which would otherwise self-suppress the very first
    // notification).
    const rejectNotify = async (reason: string, msg: string) => {
      const suppressed = await this.shouldSuppressMergeReject(workerSessionId, taskId, branch, project.repoPath, reason);
      if (!suppressed) { try { this.pty.enqueueStdin(managerSessionId, msg, "system", undefined, undefined, "agent"); } catch { /* manager not live */ } }
      return suppressed;
    };

    // BACKSTOP (BEFORE the gate/merge): refuse if the worker's commits are STRANDED on a self-created
    // branch instead of its assigned `loom/<key>`. The assigned branch is then 0-ahead, so the squash
    // merge below would stage NOTHING and silently DROP the real work (incident: worker 712fd5aa,
    // commit 1309552). Only an AFFIRMATIVE stranded signal refuses — a check error/timeout fails safe
    // to NOT stranded so a flaky check never blocks a legitimate merge. Leaves the repo/worktree
    // untouched so the manager can recover the commit.
    const stranded = await detectStrandedWork(project.repoPath, worktreePath, branch, { timeoutMs: this.gitOpMs });
    if (stranded.stranded) {
      const suppressed = await rejectNotify("stranded", `[loom:merge-rejected] worker ${workerSessionId} (task ${taskId ?? "none"}) [op ${thisOpId}] — STRANDED WORK: commits are on '${stranded.branch}' (tip ${stranded.commit}, ${stranded.ahead} ahead), not the assigned branch '${branch}' (empty). Refusing the empty merge so the work isn't lost; canonical repo untouched, worktree retained. Re-point '${branch}' to ${stranded.commit} (or cherry-pick it), then re-confirm.`);
      evt("merge_rejected", { reason: "stranded", strandedBranch: stranded.branch, strandedCommit: stranded.commit, ...(suppressed ? { suppressed: true } : {}) });
      return { merged: false, reason: `stranded work on '${stranded.branch}' (tip ${stranded.commit}); assigned branch '${branch}' is empty — re-point or cherry-pick before merging`, notified: !suppressed, opId: thisOpId };
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
    //
    // Run as SEPARATE sequential processes (runGateSequential), NOT one `&&`-chained spawnSync — a
    // shared memory footprint across lint+test+build was OOM-killing a worker's gate (exit 137,
    // Auditor finding b9515beb). Same fail-closed short-circuit semantics as the old `&&` chain: the
    // first non-zero step stops the run.
    if (gate) {
      // PRE-GATE CLEANUP (finding c21487e8 — Windows EPERM): a lingering dev-server/build process the
      // worker left running (an escaped vite/esbuild that detached from the pty's process tree) can hold
      // a lock on this worktree's node_modules, making the gate's own install/build step fail with a
      // spurious EPERM/sharing-violation even though the code is fine. Reap it BEFORE running the gate —
      // reusing the EXACT SAME worktree-scoped predicate {@link reapProcessesRootedInWorktree} already
      // uses to clear a worktree right before removal (task 8e5a7a5e, wired via the same injectable
      // `reapWorktreeProcesses` seam as gcWorktreeDir): matched STRICTLY by executable path / cwd /
      // command line rooted under THIS worker's OWN `worktreePath`, at a path-segment boundary (never a
      // bare image-name or port match — see that function's SAFETY doc for the full scoping proof), and
      // never the daemon's own pid. No new kill logic is introduced here — this is the identical, already
      // safety-reviewed helper applied at an earlier point in the same lifecycle.
      //
      // WORKER SELF-EXCLUSION (Code Review finding on card 864e79fe): unlike gcWorktreeDir's reap — which
      // only ever runs AFTER the confirming worker has already been hard-stopped (finalizeMerge stops it
      // before this method retires the worktree) — THIS sweep runs BEFORE that stop. The worker's own
      // claude pty is genuinely rooted in `worktreePath` (cwd==worktreePath on Linux; the worktree path
      // appears in its own spawn argv on Windows) and would otherwise match and get killed here. That's
      // wrong: on a subsequent real gate FAILURE this method fails closed and RETAINS the worktree for
      // re-tasking — but a worker killed here can't be re-tasked, it can only be resumed (losing its
      // in-context reasoning). The worker's own pty does not hold the node_modules lock this sweep exists
      // to clear (that's always an escaped/detached build child, e.g. vite/esbuild) — so excluding it costs
      // nothing. Do NOT instead hard-stop the worker before this sweep: that would break the fail-closed
      // retain-for-re-task contract on a genuine gate failure.
      //
      // RUNS BEFORE THE UNION-MERGE TOO (Code Review finding on card c0aeb5b2): the union-merge below
      // WRITES tracked files in the worktree, so it is at least as lock-sensitive as the gate this reap
      // was built for — an escaped watcher holding a handle on a tracked file main also touched would
      // make the merge's file-write fail with a spurious EPERM, misreported as `union_merge_failed`
      // rather than the lock issue it actually is. Reaping first clears that before either step runs.
      const workerPid = this.pty.getPid?.(workerSessionId);
      const reap = this.reapWorktreeProcesses ?? ((p: string, o?: { excludePids?: number[] }) => reapProcessesRootedInWorktree(p, { excludePids: o?.excludePids }));
      try {
        await reap(worktreePath, { excludePids: workerPid == null ? [] : [workerPid] });
      } catch {
        // Best-effort by construction, mirroring gcWorktreeDir's identical guard: an injected/broken seam
        // must never abort the gate/merge it's only meant to help along.
      }

      // UNION-MERGE (card c0aeb5b2 — the post-merge union hole): merge canonical main's CURRENT tip INTO
      // the worktree, IN the worktree, IMMEDIATELY BEFORE the gate below — so the gate validates the
      // actual POST-MERGE union rather than the branch's stale pre-merge state, and a hard textual
      // conflict against a main that advanced since the branch was cut is caught HERE, fail-closed,
      // before any squash is attempted (worktree retained, canonical repo untouched — see
      // mergeMainIntoWorktree's doc for why the later squash still lands only the branch's own net
      // changes after this). Scoped to `if (gate)`: with no gate configured, nothing downstream reads the
      // worktree's content before the squash below (which operates on `repoPath`, not `worktreePath`),
      // so union-merging into a worktree with no gate to validate it would only add risk (and touch
      // `worktreePath` as a git cwd) for zero benefit — the existing "unverified: no gateCommand" warning
      // already flags that case as unchecked.
      //
      // SKIPPED when this exact branch has ALREADY landed on main (a stale confirm racing a prior —
      // possibly out-of-band — merge; see the early-idempotency doc above, and
      // merge-reject-notify-suppress.mjs scenario B: worktree still present, branch already squashed into
      // main). Merging main's own landed squash back into such a worktree would make the branch descend
      // from its own `Loom-Worker-Branch` trailer commit — indistinguishable from a RE-CUT branch carrying
      // genuinely new work, which is exactly what `findLandedSquashCommit`'s re-task guard (below, via
      // `mergeBranch`'s own noop classification) exists to detect. That would misclassify a legitimate
      // ALREADY_MERGED re-confirm as STAGE_EMPTY_RETRY. `mergeBranch`'s own noop/ALREADY_MERGED handling
      // already covers this case correctly, untouched.
      const preLanded = await findLandedSquashCommit(project.repoPath, branch, "HEAD", { timeoutMs: this.gitOpMs });
      if (!preLanded) {
        const union = await mergeMainIntoWorktree(project.repoPath, worktreePath, { timeoutMs: this.gitOpMs });
        if (!union.ok) {
          const why = union.conflict ? "branch conflicts with current main — rebase/resolve before merge" : (union.reason ?? "union merge failed");
          const failReason = union.conflict ? "union_conflict" : "union_merge_failed";
          const suppressed = await rejectNotify(failReason, `[loom:merge-rejected] worker ${workerSessionId} (task ${taskId ?? "none"}) [op ${thisOpId}] — ${why}; canonical repo untouched, worktree retained.`);
          evt("merge_rejected", { reason: failReason, ...(suppressed ? { suppressed: true } : {}) });
          return { merged: false, reason: why, notified: !suppressed, opId: thisOpId };
        }
      }

      const runGateSeq = this.runGate ?? runGateSequential;
      // HOST-LOAD guard (card 301d8c01): queue behind any other in-flight daemon-executed heavy gate
      // rather than running alongside it unbounded. See GateSemaphore's class doc. Held only across the
      // actual gate spawn (and its retry below), not the surrounding git/notify bookkeeping.
      const gateCap = orchestration.maxConcurrentGates;
      let gateResult = await this.gateSemaphore.runExclusive(gateCap, () => runGateSeq(gate, worktreePath, gateTimeoutMs));
      evt("build_gate", { passed: gateResult.passed });
      // TRANSIENT-KILL AUTO-RETRY (card bcba83a1 — the gate "lies" under memory pressure): an OOM/SIGKILL
      // (or our OWN gateTimeoutMs bound) killing a step used to surface identically to a genuine test/build
      // failure as the flat "build gate failed" — managers learned not to trust it under load and hand-
      // rolled `git merge --squash --no-verify`, defeating the review/merge safety rail entirely. On a
      // retry-eligible classification ONLY (never a clean non-zero exit — see classifyGateFailure), settle
      // briefly then re-run the SAME gate ONCE before reporting anything. A pass here is absorbed silently:
      // the manager never even sees that a transient kill happened, and execution falls through to the
      // normal squash-merge below exactly as if the gate had been green the first time.
      let gateRetried = false;
      if (!gateResult.passed && GATE_RETRY_ENABLED && classifyGateFailure(gateResult) !== "genuine") {
        gateRetried = true;
        evt("build_gate_retry_attempt", { priorClass: classifyGateFailure(gateResult) });
        await new Promise((resolve) => setTimeout(resolve, GATE_RETRY_SETTLE_MS));
        gateResult = await this.gateSemaphore.runExclusive(gateCap, () => runGateSeq(gate, worktreePath, gateTimeoutMs));
        evt("build_gate_retry", { passed: gateResult.passed });
      }
      if (!gateResult.passed) {
        // DIAGNOSTIC DETAIL (card 4b8f2b6e): the old bare "build gate failed" string discarded the
        // failing phase/step, the first failing test/assertion, and the child's own output — a manager
        // burned whole cycles blind-diagnosing (a real test failure vs. an fs.rmSync teardown flake vs.
        // a self-wiped node_modules TS2688 all looked identical). Enrich BOTH the sync result and the
        // `[loom:merge-rejected]` signal text with the same detail.
        //
        // KILL CLASSIFICATION (card bcba83a1): `reason`/the headline now vary for a retry-eligible
        // classification — "gate killed by <signal> [(possibly OOM/resource)] — <retry outcome>" / "gate
        // timed out (possibly resource-starved under load) — <retry outcome>" instead of the flat "build
        // gate failed" — but ONLY for those two classes; a genuine clean non-zero exit keeps the exact
        // bare "build gate failed" string, so the existing back-compat contract for a real test/build
        // failure (merge-gate-diagnostic.mjs case A) is untouched. The "kill" headline names the ACTUAL
        // signal rather than asserting OOM outright (CR follow-up on bcba83a1): a SIGSEGV/SIGABRT from a
        // broken native addon is a genuine deterministic crash, not memory pressure, and mislabeling it
        // "likely OOM" would misdirect a manager diagnosing a real bug. The "(possibly OOM/resource)" hint
        // is appended ONLY for SIGKILL — the signal an OOM-killer/cgroup limit actually sends.
        const finalClass = classifyGateFailure(gateResult);
        const retryOutcome = gateRetried
          ? "retried once, still failed"
          : (finalClass !== "genuine" ? "auto-retry disabled" : undefined);
        const headline = finalClass === "kill"
          ? `gate killed by ${gateResult.failedSignal}${gateResult.failedSignal === "SIGKILL" ? " (possibly OOM/resource)" : ""} — ${retryOutcome}`
          : finalClass === "timeout"
            ? `gate timed out (possibly resource-starved under load) — ${retryOutcome}`
            : "build gate failed";
        const phase = classifyGatePhase(gateResult.failedStep);
        // INJECTION HYGIENE (CR e926d258 Minor, folded in on card bcba83a1): strip C0 control chars incl.
        // ESC from the output tail + extracted failing-test line BEFORE they're embedded into the
        // `[loom:merge-rejected]` pty text — this is the first flow that pipes RAW process bytes through
        // enqueueStdin, and a colorized test runner's ANSI (or a tail that happened to literally contain
        // the bracketed-paste terminator `\x1b[201~`) would otherwise inject noise — or, worse, break OUT
        // of bracketed paste — into the MANAGER's TUI. Reuses pty/host.ts's own CONTROL_CHAR_RE rather than
        // inventing a new regex. Sanitized once and reused for both the pty text and the sync gateDetail so
        // the two never disagree.
        const outputTail = gateResult.outputTail ? gateResult.outputTail.replace(CONTROL_CHAR_RE, "") : undefined;
        const rawFailingTest = outputTail ? extractFailingTest(outputTail) : undefined;
        const failingTest = rawFailingTest ? rawFailingTest.replace(CONTROL_CHAR_RE, "") : undefined;
        const killNote = gateResult.failedTimedOut
          ? `timed out after ${gateTimeoutMs}ms`
          : gateResult.failedSignal
            ? `killed by ${gateResult.failedSignal}`
            : gateResult.failedStatus != null
              ? `exit ${gateResult.failedStatus}`
              : undefined;
        const detailBits = [
          gateResult.failedStep ? `step: ${gateResult.failedStep}` : undefined,
          phase ? `phase: ${phase}` : undefined,
          killNote,
          gateRetried ? `retried once (settled ${GATE_RETRY_SETTLE_MS}ms)` : undefined,
          failingTest ? `failing: ${failingTest}` : undefined,
        ].filter(Boolean).join("; ");
        const tailBlock = outputTail ? `\n--- gate output tail ---\n${outputTail}` : "";
        const suppressed = await rejectNotify("gate", `[loom:merge-rejected] worker ${workerSessionId} (task ${taskId ?? "none"}) [op ${thisOpId}] — ${headline}${detailBits ? ` (${detailBits})` : ""}; canonical repo untouched, worktree retained.${tailBlock}`);
        evt("merge_rejected", {
          reason: "gate", phase, failedStep: gateResult.failedStep, failingTest,
          exitCode: gateResult.failedStatus, signal: gateResult.failedSignal, timedOut: gateResult.failedTimedOut,
          killClass: finalClass, retried: gateRetried,
          ...(suppressed ? { suppressed: true } : {}),
        });
        return {
          merged: false,
          reason: headline,
          gateDetail: {
            phase, failedStep: gateResult.failedStep, failingTest, stderrTail: outputTail,
            exitCode: gateResult.failedStatus, signal: gateResult.failedSignal, timedOut: gateResult.failedTimedOut,
          },
          notified: !suppressed,
          opId: thisOpId,
        };
      }
    }

    // Squash-merge as ONE clean commit. The subject comes from the task title (mergeBranch falls back to
    // the branch name); the commit carries the deterministic `Loom-Worker-Branch` trailer used downstream.
    const taskTitle = taskId ? this.db.getTask(taskId)?.title ?? undefined : undefined;
    const merge = await mergeBranch(project.repoPath, branch, taskTitle);
    if (!merge.ok) {
      const why = merge.conflict ? "merge conflict" : (merge.reason ?? "merge failed");
      const failReason = merge.conflict ? "conflict" : "merge_failed";
      const suppressed = await rejectNotify(failReason, `[loom:merge-rejected] worker ${workerSessionId} (task ${taskId ?? "none"}) [op ${thisOpId}] — ${why}; canonical repo untouched, worktree retained. Re-task a rebase.`);
      evt("merge_rejected", { reason: failReason, ...(suppressed ? { suppressed: true } : {}) });
      return { merged: false, reason: why, notified: !suppressed, opId: thisOpId };
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
          const suppressed = await rejectNotify("orphaned_zero_ahead", `[loom:merge-rejected] worker ${workerSessionId} (task ${taskId ?? "none"}) [op ${thisOpId}] — ORPHANED WORK (HARD): your worker REPORTED ${reported} but its assigned branch '${branch}' is 0 commits ahead of main — there is NOTHING on the branch to merge. The reported work was almost certainly committed to MAIN directly (or another branch); a later main sync can ORPHAN it and lose it silently. Refusing the empty merge. RECOVER it: 'git --no-pager log main' to find the commit, cherry-pick it onto '${branch}', then re-confirm — or if the report was mistaken, re-task. (Workers must NEVER commit to main — commit only to the assigned branch.)`);
          evt("merge_rejected", { reason: "orphaned_zero_ahead", reportedState: reported, ...(suppressed ? { suppressed: true } : {}) });
          return {
            merged: false,
            reason: `orphaned work: assigned branch '${branch}' is 0 commits ahead of main but the worker reported ${reported} — the committed work is not on the branch (likely committed straight to main); recover the commit onto '${branch}' before merging`,
            emptyKind: "STAGE_EMPTY_RETRY",
            hardError: true,
            reportedState: reported,
            notified: !suppressed,
            opId: thisOpId,
          };
        }
        // No report of work → a genuine empty no-op. Fail-closed (worktree retained so the manager can see
        // why the worker produced no change, task stays in review) but soft — no alarm.
        const suppressed = await rejectNotify("stage_empty", `[loom:merge-rejected] worker ${workerSessionId} (task ${taskId ?? "none"}) [op ${thisOpId}] — STAGE_EMPTY_RETRY: the branch has no diff to merge; canonical repo + worktree untouched. The worker committed nothing that differs from main — re-task or close the task by hand.`);
        evt("merge_rejected", { reason: "stage_empty", ...(suppressed ? { suppressed: true } : {}) });
        return { merged: false, reason: "no diff to merge (STAGE_EMPTY_RETRY)", emptyKind: "STAGE_EMPTY_RETRY", notified: !suppressed, opId: thisOpId };
      }
      // ALREADY_MERGED: the branch's work is already in main (a prior squash with its trailer). Finish the
      // bookkeeping idempotently via the SAME helper the early-idempotency check above uses.
      return this.finishAlreadyMerged({ managerSessionId, workerSessionId, taskId, worktreePath, branch, repoPath: project.repoPath, projectId: project.id, opId: thisOpId, forceRemoveWorktree });
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
    const finalizeResult = await this.finalizeMerge({ managerSessionId, workerSessionId, taskId, worktreePath, branch, repoPath: project.repoPath, projectId: project.id, forceRemoveWorktree });
    // NESTED-REPO WARNING (card b6d41db1): the worktree was retained (not force-removed) because it holds
    // an unrecoverable nested clone (or the scan couldn't confirm it was clean) — surface it so the
    // manager knows cleanup is on it.
    const nestedWarning = finalizeResult.nestedRepoBlock ? nestedRepoBlockWarning(finalizeResult.nestedRepoBlock) : undefined;
    // NO-GATE WARNING (finding 8363e602): with no gateCommand configured, the branch above merges
    // unconditionally — carry that forward explicitly so the manager knows this merge was NOT verified by
    // any build/DoD check, rather than silently rubber-stamping it with no signal either way. `notified`
    // is left undefined here (unlike every other branch): the GREEN path sends no direct nudge of its
    // own, so confirmWorkerMergeTracked's generic `[loom:merge-done]` echo is the sole terminal signal.
    // SUPPRESSED when the project is flagged `noGateByDesign` (card 58b0bb60) — a deliberately gateless
    // project (vault/markdown/knowledge, no buildable code) opted OUT of this signal; an UNFLAGGED
    // gateless project still warns, so a genuinely missing gate stays surfaced.
    const gateWarning = gate || project.noGateByDesign
      ? undefined
      : "unverified: no gateCommand is configured for this project — the merge was NOT checked by any build/DoD gate";
    const warning = [nestedWarning, gateWarning].filter((w): w is string => !!w).join(" ") || undefined;
    return warning ? { merged: true, opId: thisOpId, warning } : { merged: true, opId: thisOpId };
  }

  /**
   * Shared finish for the ALREADY_MERGED case (the branch's work is already reachable from main) —
   * reached either EARLY, before the gate/stranded-check/merge even run (a stale confirm retry landing
   * after a PRIOR call already merged + finalized this worker), or from {@link mergeBranch}'s own
   * noop/ALREADY_MERGED classification (a duplicate confirm that races the squash itself). Idempotent:
   * retires the worktree + branch and marks the task done without a new commit. NOT routed through
   * rejectNotify/shouldSuppressMergeReject: this is a SUCCESS announcement (not a rejection) and the
   * caller only ever reaches this on an already-confirmed-landed branch, so the ancestry check would
   * suppress it unconditionally.
   *
   * STALE-REDELIVERY GUARD (card 369d8824, the "already consumed" facet): the EARLY entry above can be
   * reached again by a genuinely stale retry — a manager re-calling `worker_merge_confirm` (documented
   * idempotent-retryable) AFTER a PRIOR call already fully finalized this exact worker. That prior call's
   * OWN `finalizeMerge` already appended a `merge_done` event for it, so this call's own path resolves
   * via the FAST early-idempotency branch (before the gate even runs) — the manager gets its answer
   * synchronously from ITS OWN tool call return, needs no async push, and a second `[loom:already-merged]`
   * would just be a duplicate echo of something it already knows. So: skip the direct push (only) when a
   * `merge_done` event already exists for this worker; still always finish the (idempotent, best-effort)
   * cleanup below. `notified` on the return is unconditionally `true` regardless — this path OWNS the
   * announcement for an ALREADY_MERGED outcome, whether THIS call fired it or a prior one already did, so
   * confirmWorkerMergeTracked's generic echo must stay suppressed either way.
   */
  private async finishAlreadyMerged(args: {
    managerSessionId: string; workerSessionId: string; taskId: string | null;
    worktreePath: string; branch: string; repoPath: string; projectId: string; opId: string;
    forceRemoveWorktree?: boolean;
  }): Promise<ConfirmMergeResult> {
    const alreadyFinalized = this.db.listEventsForWorker(args.workerSessionId).some((e) => e.kind === "merge_done");
    if (!alreadyFinalized) {
      try { this.pty.enqueueStdin(args.managerSessionId, `[loom:already-merged] worker ${args.workerSessionId} (task ${args.taskId ?? "none"}) [op ${args.opId}] — ALREADY_MERGED: the branch's work was already in main; finishing the worktree cleanup + task without a new commit.`, "system", undefined, undefined, "agent"); } catch { /* manager not live */ }
    }
    this.pty.stop(args.workerSessionId, "hard");
    for (let i = 0; i < 50 && this.pty.isAlive(args.workerSessionId); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const finalizeResult = await this.finalizeMerge(args);
    const warning = finalizeResult.nestedRepoBlock ? nestedRepoBlockWarning(finalizeResult.nestedRepoBlock) : undefined;
    return warning
      ? { merged: true, emptyKind: "ALREADY_MERGED", opId: args.opId, notified: true, warning }
      : { merged: true, emptyKind: "ALREADY_MERGED", opId: args.opId, notified: true };
  }

  /**
   * CLIENT-TIMEOUT-RESILIENT entry point for the `worker_merge_confirm` MCP tool (card fb8df559 Part 1) —
   * the ONLY caller-visible change is at this outer layer; {@link confirmWorkerMerge} itself (the
   * stranded-work backstop, the gate, the squash-merge, the ALREADY_MERGED/STAGE_EMPTY_RETRY idempotency)
   * is unchanged BY THIS card — confirmWorkerMerge now also short-circuits an already-landed branch
   * EARLY (before the gate), which only makes a stale retry through this same registry cheaper and
   * correct, without changing this outer layer's own contract at all. Keyed `merge:${workerSessionId}` —
   * unambiguous, no prefix-resolution involved, so unlike spawn there is no "different string, same
   * target" edge case here at all.
   *
   * A stale retry that lands AFTER the op has settled+been consumed just re-invokes confirmWorkerMerge for
   * real — safe because that method's OWN ALREADY_MERGED re-derive-from-clean-index already handles a
   * duplicate confirm idempotently (card 2eddf573); this registry adds no new merge-side idempotency of
   * its own, it only changes how/when the result is DELIVERED to the caller.
   *
   * COMPLETION NUDGE (card fb8df559 Part 2, widened by 369d8824/187f5b76): when this degrades to the
   * pending path, the asking manager is left to spin-poll (re-call this tool / `worker_list.pendingMerge`)
   * to learn the outcome. `pendingOps.attach`'s `onSettledAfterPending` fires exactly once, only for a key
   * that was actually surfaced pending, straight from the op's terminal settle — so a manager that went
   * off and did something else instead of polling still gets pushed a turn the moment the gate/merge
   * actually finishes. `kind:"warning"` because this is a Loom operational nudge (same-route coalescing is
   * correct), mirroring the decision-inbox answer nudge / answered-stuck watchdog's use of the same
   * `enqueueStdin` rail. The FAST (already-fast) path never reaches this callback at all — that caller
   * already has the outcome inline via its own return value.
   *
   * EXACTLY-ONE-SIGNAL (card 187f5b76): `outcome.value.notified`/the `opId` param are threaded from the
   * SAME single {@link confirmWorkerMerge} invocation this callback is reporting on, so this generic echo
   * and any rich direct push (rejectNotify's `[loom:merge-rejected]`, finishAlreadyMerged's
   * `[loom:already-merged]`) can never both land for one op — see `notified`'s doc on {@link
   * ConfirmMergeResult} for exactly which branches set it. `opId` is echoed on EVERY branch (including the
   * synchronously-thrown-error branch, which has no `outcome.value` of its own to carry one) so a manager
   * running several concurrent merges can always match this nudge back to the `worker_merge_confirm` call
   * that produced it.
   */
  async confirmWorkerMergeTracked(
    managerSessionId: string, workerSessionId: string, forceRemoveWorktree?: boolean,
  ): Promise<AttachResult<ConfirmMergeResult>> {
    const key = `merge:${workerSessionId}`;
    // DEAD-OWNER RECOVERY (card 27ea069e): an existing RUNNING op for this key whose owning manager
    // session is gone (exited/archived/missing — see isManagerSessionDead) can never settle for a LIVE
    // caller again — its original manager, the only session that could ever have been pushed its
    // outcome, no longer exists. Without this check, attach() below would dedup-attach THIS fresh call to
    // that zombie op forever ({status:"pending"} on every retry, no gate ever actually running — the
    // exact incident this card fixes). Evict it so this call starts a genuinely fresh confirm instead.
    // SCOPED TO A CONFIRMED-DEAD OWNER ONLY: a live (or still-resuming) owner's op is left completely
    // alone, so the healthy path — two managers/retries racing a genuinely in-flight merge — is
    // byte-identical to before this card.
    //
    // NOTE (card 33172f01): `existing` here can ALSO be a settled RETAINED view (peek() surfaces both
    // shapes — see pending-ops.ts). `evictDeadOwner` only ever removes a RUNNING entry, so it's correctly a
    // no-op for a retained one regardless of whose manager owned the op that produced it — a retained
    // result is a FINISHED answer, not a stuck zombie, so there is nothing to evict; `attach()` below will
    // short-circuit to that cached outcome for ANY caller within the retention window, which is exactly
    // right (the merge already happened; ownership of the op that ran it doesn't change the answer).
    const existing = this.pendingOps.peek(key);
    if (existing && this.isManagerSessionDead(existing.managerSessionId)) {
      // MINOR A (CR finding, card 33172f01): `evictDeadOwner` only ever removes a RUNNING entry (a no-op
      // for a settled RETAINED view, per the NOTE above) — so only log the "evicting so this confirm can
      // proceed fresh" claim when it's actually TRUE. Logging it unconditionally used to lie for a
      // dead-owner'd retained view: nothing gets evicted and this confirm does NOT proceed fresh, it
      // dedupe-hits the cache instead — a correct outcome, but a misleading operator-facing log line.
      if (this.pendingOps.evictDeadOwner(key)) {
        console.warn(`[orchestration] merge op ${existing.opId} (${key}) had a dead owner (manager ${existing.managerSessionId.slice(0, 8)}) — evicting so this confirm can proceed fresh`);
      }
    }
    const taskId = this.db.getSession(workerSessionId)?.taskId ?? null;
    const who = (opId: string) => `worker ${workerSessionId} (task ${taskId ?? "none"}) [op ${opId}]`;
    return this.pendingOps.attach<ConfirmMergeResult>(
      key, "merge", managerSessionId, SYNC_ATTACH_BUDGET_MS,
      (opId) => this.confirmWorkerMerge(managerSessionId, workerSessionId, opId, forceRemoveWorktree),
      (outcome, opId) => {
        // DOUBLE-NOTIFY FIX (card 9eea3901, widened by 187f5b76 to cover the ALREADY_MERGED success path
        // too): a branch that already sent its own rich/direct push (`outcome.value.notified` — the
        // `[loom:merge-rejected]` rejection path OR the `[loom:already-merged]` success path) needs no
        // generic echo here — sending both wastes a manager turn on the SAME event and, for a manager
        // running several merges concurrently, is genuinely ambiguous about which op just settled. Only
        // send this generic nudge for: a plain green merge (no direct push of its own), or a rejection the
        // rich path did NOT already announce (`!notified` — either shouldSuppressMergeReject reconciled it
        // away, or an unexpected error means rejectNotify never ran at all) — so the manager still gets
        // exactly one terminal signal per async confirm.
        if (outcome.ok && outcome.value.notified) return;
        const msg = outcome.ok
          ? (outcome.value.merged
            ? `[loom:merge-done] ${who(opId)} merged.`
            : `[loom:merge-failed] ${who(opId)} — ${outcome.value.reason ?? "merge did not complete"}`)
          : `[loom:merge-failed] ${who(opId)} — merge confirm errored: ${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}`;
        try { this.pty.enqueueStdin(managerSessionId, msg, "system", undefined, undefined, "warning"); } catch { /* manager not live — best-effort, mirrors every other completion nudge */ }
      },
      {
        // RETAIN + CLASSIFY (card d1aee5f1 follow-up): keep the settled op briefly `peek()`-able (see
        // PendingOpRegistry's "RETAINED TERMINAL VIEW" doc) with a distinct terminal outcome, so the Board
        // card's merge-gate hairline can render merged/rejected/failed instead of reverting the instant the
        // gate settles. `merged:true` → "merged"; a RESOLVED `merged:false` (the gate/stranded-work/empty-
        // stage rejection paths — none of these throw) → "rejected"; only a genuinely THROWN error (a real
        // exception, not a rejection result) → "failed". Mirrors `mergeDisplay`'s Board-side classification.
        retainMs: MERGE_OP_RETAIN_MS,
        classifyOutcome: (outcome) => (!outcome.ok ? "failed" : outcome.value.merged ? "merged" : "rejected"),
        // BYPASS THE RETAINED CACHE ON AN EXPLICIT FORCE (CR BLOCKER 1, card 33172f01): the retention-window
        // dedupe (see PendingOpRegistry.attach's `opts.bypassRetained` doc) is keyed ONLY on
        // `workerSessionId`, not on `forceRemoveWorktree` — so without this, a manager that read a
        // nested-repo-guard warning telling it to "re-run worker_merge_confirm with forceRemoveWorktree:true"
        // and did EXACTLY that within the retention window would get back the IDENTICAL cached (unforced)
        // warning, `confirmWorkerMerge` never re-entered, the worktree never actually removed, and no signal
        // that the flag was silently ignored. `forceRemoveWorktree` is an explicit one-shot escalation from
        // the caller — it must never be served from a cache built by an earlier, non-forced call.
        bypassRetained: forceRemoveWorktree === true,
      },
    );
  }

  /**
   * Worker self-gate (orchestration `run_gate`, card 7f96aa09 — structural fix B for d5c5ccdf): run THIS
   * project's OWN configured `gateCommand` in the CALLING worker's own worktree, daemon-mediated and bound
   * by the SAME `gateSemaphore`/`maxConcurrentGates` cap the merge/deploy gates already share — so N
   * parallel workers self-gating can no longer structurally exceed the total-lane budget, regardless of
   * whether each worker remembers the `LOOM_TEST_CONCURRENCY=1` convention (fix A, d5c5ccdf — which stays
   * documented as the fallback for a project with no `gateCommand` configured at all, or an ad-hoc local
   * run outside `run_gate`).
   *
   * REUSES `gateCommand` rather than a second "worker DoD command" config field — `gateCommand` already
   * runs in the worker's own worktree at merge-confirm time (after main is merged into it); calling
   * `run_gate` pre-merge just previews the SAME command a little earlier, on the branch's own pre-merge
   * state. This avoids a divergence footgun where a worker's self-check and the actual merge gate could
   * silently differ.
   *
   * A SINGLE run — unlike `confirmWorkerMerge`, no transient-kill auto-retry (the caller can just re-call
   * `run_gate` itself), no union-merge, no stranded-work check, no squash/finalize: this is a preview/
   * rehearsal, not the merge gate itself.
   *
   * LONG-RUNNING (mirrors `confirmWorkerMergeTracked`): wrapped in `PendingOpRegistry.attach` under kind
   * "gate", key `gate:${workerSessionId}` — a fast run (under `SYNC_ATTACH_BUDGET_MS`) returns inline; a
   * genuinely slow one degrades to `{settled:false, op}` and, on its eventual settle, pushes a
   * `[loom:gate-done]`/`[loom:gate-failed]` nudge straight to the WORKER's own session (not a manager — the
   * caller and the beneficiary are the same session here) via `pty.enqueueStdin`. The key is single-flight
   * per worker and needs no dead-owner eviction: unlike the "merge" kind (owned by a manager distinct from
   * the worker being confirmed), a "gate" op's only possible caller IS the session named by its own key.
   *
   * CRASH-SAFETY: the gate's child process is spawned by the DAEMON (`runGateStep`), never the worker's own
   * pty — `gateSemaphore.runExclusive`'s `finally{release()}` fires on the child's own close/error/timeout
   * regardless of whether the calling worker session is still alive, so a worker dying mid-gate cannot leak
   * a held semaphore slot. A worker that dies before ever consuming a `{status:"pending"}` result just
   * wastes one gate run — harmless.
   */
  async runWorkerGate(workerSessionId: string): Promise<AttachResult<WorkerGateResult>> {
    this.requireWorker(workerSessionId, "run_gate");
    const worker = this.db.getSession(workerSessionId);
    if (!worker) throw new Error("unknown session");
    const worktreePath = worker.worktreePath ?? worker.cwd;
    const project = this.db.getProject(worker.projectId);
    if (!project) throw new Error("project not found");
    // RESOLVE-LIVE (mirrors confirmWorkerMerge): read fresh so a human PATCH to gateCommand/its timeout/
    // maxConcurrentGates takes effect on the very next call with no daemon restart.
    const orchestration = resolveConfig(project.config, this.db.getPlatformConfig()).orchestration;
    const gate = orchestration.gateCommand;
    if (!gate) {
      return {
        settled: true, ok: true,
        value: {
          ran: false,
          reason: "no gateCommand configured for this project — ask the owner to set orchestration.gateCommand, or fall back to a raw self-check (pin LOOM_TEST_CONCURRENCY=1 yourself)",
        },
      };
    }
    const gateTimeoutMs = orchestration.gateCommandTimeoutMs;
    const gateCap = orchestration.maxConcurrentGates;
    const runGateSeq = this.runGate ?? runGateSequential;
    const key = `gate:${workerSessionId}`;
    return this.pendingOps.attach<WorkerGateResult>(
      key, "gate", workerSessionId, SYNC_ATTACH_BUDGET_MS,
      async (opId) => {
        const evt = (detail: Record<string, unknown>) => this.db.appendEvent({
          id: randomUUID(), ts: new Date().toISOString(), managerSessionId: workerSessionId, workerSessionId,
          taskId: worker.taskId ?? null, kind: "worker_gate", detail,
        });
        let gateResult: GateSequentialResult;
        try {
          gateResult = await this.gateSemaphore.runExclusive(
            gateCap, () => runGateSeq(gate, worktreePath, gateTimeoutMs, undefined, WORKER_GATE_ENV_OVERRIDE),
          );
        } catch (err) {
          // AUDIT-ON-ERROR (CR follow-up, card 7f96aa09): an unexpected throw (a genuine runner exception,
          // not an ordinary gate FAILURE) used to leave NO audit trail at all — appendEvent was only ever
          // reached after a normal settle. Record it here, then rethrow unchanged: this closure's own
          // caller (PendingOpRegistry.attach) already turns a rejection into a normal {ok:false} outcome —
          // this audit write adds a durable record, it does not change that error-handling behavior.
          evt({ passed: false, error: err instanceof Error ? err.message : String(err) });
          throw err;
        }
        if (gateResult.passed) {
          evt({ passed: true });
          return { ran: true, passed: true, opId };
        }
        const finalClass = classifyGateFailure(gateResult);
        const phase = classifyGatePhase(gateResult.failedStep);
        // Same INJECTION HYGIENE as confirmWorkerMerge's own rejection path: strip C0 control chars before
        // this raw process output is embedded into the `[loom:gate-failed]` pty text.
        const outputTail = gateResult.outputTail ? gateResult.outputTail.replace(CONTROL_CHAR_RE, "") : undefined;
        const rawFailingTest = outputTail ? extractFailingTest(outputTail) : undefined;
        const failingTest = rawFailingTest ? rawFailingTest.replace(CONTROL_CHAR_RE, "") : undefined;
        const headline = finalClass === "kill"
          ? `gate killed by ${gateResult.failedSignal}${gateResult.failedSignal === "SIGKILL" ? " (possibly OOM/resource)" : ""}`
          : finalClass === "timeout"
            ? "gate timed out (possibly resource-starved under load)"
            : "build gate failed";
        // AUDIT ENRICHMENT (CR follow-up): carry the same failure detail the sibling `deploy` event records
        // (exitCode/signal/timedOut/outputTail) PLUS phase/failedStep/failingTest — we already compute all
        // of this for the nudge/return value below, so the durable event shouldn't be a flatter `{passed}`.
        evt({
          passed: false, phase: phase ?? null, failedStep: gateResult.failedStep ?? null, failingTest: failingTest ?? null,
          exitCode: gateResult.failedStatus ?? null, signal: gateResult.failedSignal ?? null, timedOut: gateResult.failedTimedOut ?? false,
          ...(outputTail ? { outputTail } : {}),
        });
        return {
          ran: true, passed: false, reason: headline, opId,
          gateDetail: {
            phase, failedStep: gateResult.failedStep, failingTest, stderrTail: outputTail,
            exitCode: gateResult.failedStatus, signal: gateResult.failedSignal, timedOut: gateResult.failedTimedOut,
          },
        };
      },
      (outcome, opId) => {
        const msg = outcome.ok
          ? (outcome.value.passed
            ? `[loom:gate-done] op ${opId} — gate passed.`
            : `[loom:gate-failed] op ${opId} — ${outcome.value.reason ?? "gate did not pass"}${outcome.value.gateDetail?.stderrTail ? `\n--- gate output tail ---\n${outcome.value.gateDetail.stderrTail}` : ""}`)
          : `[loom:gate-failed] op ${opId} — gate errored: ${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}`;
        try { this.pty.enqueueStdin(workerSessionId, msg, "system", undefined, undefined, "warning"); } catch { /* worker not live — best-effort, mirrors every other completion nudge */ }
      },
    );
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
    // Each sibling's slot just freed DETERMINISTICALLY (same reasoning as the no-commit auto-retire path)
    // — drain now rather than waiting for the graceful stop above to actually land and reach the generic
    // onExit-driven drain later. A sibling can belong to a DIFFERENT manager than this call's caller (this
    // lookup is board-wide — see the class doc), so drain each one's OWN parentSessionId, deduped; a
    // manager mid-recycleWorker is protected by maybeDrainCapQueue's own recycleDrainSuppressed check —
    // this call doesn't need to know which caller (finalizeMerge vs. recycleWorker) it's running under.
    // Fire-and-forget: never blocks the caller's own worktree-removal/wait below.
    for (const managerId of new Set(siblings.map((s) => s.parentSessionId).filter((id): id is string => !!id))) {
      void this.maybeDrainCapQueue(managerId);
    }
    for (let i = 0; i < 50 && siblings.some((s) => this.pty.isAlive(s.id)); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /**
   * Codescape C3 REWRITE (`369dde3c`, card e068a2ab) — ensure the project's graph.json exists yet, firing
   * a `codescape ingest --out` on first need (lazily, at worker-spawn time) rather than blocking any spawn
   * on it. Fire-and-forget: called synchronously (not awaited by the caller) so a Codescape hiccup can
   * never delay a worker spawn. Gated on `isCodescapeEnabled(config)` (folds in `isLoomDev()` — a non-dev
   * or Codescape-disabled project fires nothing). Skips the ingest entirely when the graph file ALREADY
   * exists — an ingest can take up to ~2 minutes on a big repo, and re-running it on every single worker
   * spawn would be wasteful; the merge-triggered {@link fireCodescapeReingest} is what keeps it fresh
   * thereafter. `repoPath` is the project's MAIN checkout (not the new worker's own worktree) — every
   * session on a project reads the SAME project-wide graph (see `codescapeGraphPath`'s doc).
   */
  private fireCodescapeEnsureGraph(projectId: string, config: ResolvedConfig, repoPath: string): void {
    if (!isCodescapeEnabled(config)) return;
    const graphPath = codescapeGraphPath(projectId);
    if (fs.existsSync(graphPath)) return;
    void this.codescape?.ingestToGraph(repoPath, graphPath)
      .then((res) => {
        if (!res.ok) console.warn(`[codescape] ensure-graph ingest failed for project ${projectId}: ${res.errorTail ?? res.outcome}`);
      })
      .catch((err) => console.warn(`[codescape] ensure-graph ingest errored for project ${projectId}: ${(err as Error).message}`));
  }

  /**
   * Codescape C3 — reingest main's current working tree after a merge lands (both the Green and
   * ALREADY_MERGED paths converge in {@link finalizeMerge}, which calls this once at the end), REFRESHING
   * the project's graph.json (`codescape ingest --out`, unconditional — unlike {@link
   * fireCodescapeEnsureGraph}'s existence-gated first-ingest, a merge landing is exactly the signal that
   * the graph is now STALE). Resolves the project's config LIVE (mirrors the gate-command re-resolve
   * elsewhere) so a human toggling the per-project `codescape.enabled` flag takes effect with no daemon
   * restart. Fire-and-forget: a big-repo ingest can take up to ~2 minutes — awaiting it here would hold
   * the merge caller for that whole window, which the contract explicitly forbids.
   *
   * The whole body is wrapped: this is the LAST statement of {@link finalizeMerge}, called AFTER the
   * merge has already landed — a synchronous throw here (a closed db mid-shutdown, a malformed config)
   * must never surface as finalizeMerge REJECTING a merge that already fully succeeded (which would give
   * the manager a spurious merge-failed for a task that's actually done). Best-effort by construction,
   * never propagates.
   */
  private fireCodescapeReingest(projectId: string, repoPath: string): void {
    try {
      const project = this.db.getProject(projectId);
      if (!project) return;
      const config = resolveConfig(project.config);
      if (!isCodescapeEnabled(config)) return;
      const graphPath = codescapeGraphPath(projectId);
      void this.codescape?.ingestToGraph(repoPath, graphPath)
        .then((res) => {
          if (!res.ok) console.warn(`[codescape] reingest failed for project ${projectId}: ${res.errorTail ?? res.outcome}`);
        })
        .catch((err) => console.warn(`[codescape] reingest errored for project ${projectId}: ${(err as Error).message}`));
    } catch (err) {
      console.warn(`[codescape] reingest setup errored for project ${projectId} (merge already landed, unaffected): ${(err as Error).message}`);
    }
  }

  /**
   * Codescape C3 REWRITE — a NO-OP kept for call-site compatibility. Pre-rewrite this deregistered a
   * worktree from the shared `serve`'s per-worktree overlay state; the C2/C3 rewrite (card e068a2ab)
   * moved the agent read path to ONE project-wide graph.json (no per-worktree registration exists to
   * drop — see `codescapeGraphPath`'s doc). Left in place (rather than ripped out of every
   * {@link gcWorktreeDir} caller) so a future C4 human-canvas overlay — which WOULD still track
   * per-worktree state against the optional shared `serve` — has an obvious hook to fill back in.
   */
  private fireCodescapeDrop(_ctx?: { projectId: string; worktreeId: string | null }): void {
    // Intentional no-op — see doc above.
  }

  /**
   * Slow-retry-aware wrapper around {@link removeWorktree} — the single removal chokepoint shared by
   * finalizeMerge, boot-reconcile Pass B's two GC sites, and the background wedge sweep (task dea6728e,
   * widened by card b6d41db1's follow-up to be the ONE place the nested-repo guard below lives, so all
   * four callers inherit it — a guard planted only in finalizeMerge left the other three force-removing
   * past a nested clone with no scan at all, the exact same data-loss shape via a sibling path). A
   * worktree that's given up on (`needsHuman`, past the long give-up bound) is SKIPPED entirely — no
   * removal is even attempted. Everything else ALWAYS attempts the removal: most wedges are eventually
   * resolvable (a held OS-indexer/Defender-scan handle releases on its own, or a pnpm-junction structure
   * `rmdir` succeeds where the old `fs.rm` choked), so a dir that was wedged before is NOT skipped here —
   * it's retried, safely, because every attempt is the same killable removal (never a threadpool op).
   * On success, any wedge tracking for the path is cleared. On a fresh/repeat wedge, the attempt is
   * recorded and — past {@link wedgeGiveUpAttempts}/{@link wedgeGiveUpMs} (whichever of the two trips
   * FIRST — a heavy restart cadence can rack up the attempt bound long before the elapsed-time one) —
   * flipped to `needsHuman` and loudly surfaced; short of that bound it's surfaced as "still wedged,
   * retrying slowly" and the low-frequency background sweep is armed so it keeps getting retried even
   * between boots.
   *
   * NESTED-REPO GUARD (card b6d41db1 — the incident): `git worktree remove --force` happily deletes
   * EVERYTHING under the worktree, including a repo a manager (or, on the boot-reconcile paths below, an
   * orphaned pre-merge crash) left cloned in a gitignored subdirectory with unpushed work — silently,
   * unrecoverably. `findNestedGitRepos` scans for that BEFORE any removal is attempted; a hit (or an
   * inconclusive TRUNCATED scan — see its own doc for why that must fail safe too) returns
   * `"nested-repo-blocked"` and skips the removal entirely, RETAINING the worktree intact. Skippable via
   * `opts.forceRemoveWorktree` — but ONLY finalizeMerge's manager-facing caller ever sets that; boot-
   * reconcile Pass B's two GC sites and the background wedge sweep have no manager to warn and no
   * override to pass, so they NEVER set it and always fail safe on a hit (a retained orphaned worktree is
   * recoverable; a destroyed one is not).
   *
   * BEFORE every removal attempt (guard included), sweeps and kills any OS process still ROOTED in
   * `worktreePath` (task 8e5a7a5e — the dangling-worktree PREVENTION: an escaped esbuild service / vite
   * dev-server holds a file handle open inside the dir and would make the removal below fail with
   * `ERROR_SHARING_VIOLATION`, the confirmed root cause). See {@link reapProcessesRootedInWorktree} for
   * the safety scoping — it only ever matches THIS `worktreePath`, so a caller that only ever reaches
   * this method with a worktree it has already decided to discard (every call site here does) can never
   * sweep a live/protected one.
   */
  private async gcWorktreeDir(
    repoPath: string,
    worktreePath: string,
    codescapeCtx?: { projectId: string; worktreeId: string | null },
    opts?: { forceRemoveWorktree?: boolean },
  ): Promise<GcOutcomeResult> {
    if (this.db.getWedgedWorktree(worktreePath)?.needsHuman) return { outcome: "needs-human-skip" };
    if (!opts?.forceRemoveWorktree) {
      const scanFn = this.findNestedGitReposOverride ?? findNestedGitRepos;
      // FAIL SAFE on a scan REJECTION too (a pathologically deep tree, a throwing test seam, …) — this is
      // NOT the per-directory readdir glitch findNestedGitRepos already swallows internally; it's the scan
      // never producing a result at all. Treating that as "confirmed clean" would proceed straight to
      // force-remove on an INCONCLUSIVE result, contradicting this whole guard's thesis (CR follow-up on
      // card b6d41db1: the truncated-cap path already fails safe this way — a thrown scan must too).
      // Routes into the SAME `scan.truncated` blocked branch below, not a special case.
      const scan = await scanFn(worktreePath).catch((): { repos: string[]; truncated: boolean } => ({ repos: [], truncated: true }));
      if (scan.truncated) {
        // eslint-disable-next-line no-console
        console.warn(`[worktree] nested-repo scan of ${worktreePath} was INCONCLUSIVE (truncated, or the ` +
          `scan itself failed) — treating as BLOCKED to fail safe rather than trusting a partial/absent ` +
          `"nothing found." Worktree RETAINED. Verify manually for a nested clone, then remove it, or ` +
          `re-run with forceRemoveWorktree:true.`);
        return { outcome: "nested-repo-blocked", scanTruncated: true };
      }
      if (scan.repos.length > 0) {
        // eslint-disable-next-line no-console
        console.warn(`[worktree] ${worktreePath} RETAINED — nested git repo(s) found and NOT removed: ` +
          `${scan.repos.join(", ")}. Move/push that content out of the worktree, then remove it, or re-run with forceRemoveWorktree:true.`);
        return { outcome: "nested-repo-blocked", nestedRepoPaths: scan.repos };
      }
    }
    const reap = this.reapWorktreeProcesses ?? ((p: string) => reapProcessesRootedInWorktree(p));
    try {
      await reap(worktreePath);
    } catch {
      // Best-effort by construction (reapProcessesRootedInWorktree never throws), but stay defensive:
      // an injected/broken seam must never abort the removal it's only meant to help along.
    }
    const { removed, wedged } = await removeWorktree(repoPath, worktreePath, { timeoutMs: this.gitOpMs, removeDir: this.removeDirOverride });
    if (removed) {
      this.db.clearWedgedWorktree(worktreePath);
      // Codescape C3: this worktree is GENUINELY gone (never fired for recycleWorker reuse — that path
      // never calls gcWorktreeDir at all) — deregister it. Fire-and-forget, best-effort.
      this.fireCodescapeDrop(codescapeCtx);
      return { outcome: "removed" };
    }
    if (wedged) {
      const entry = this.db.recordWorktreeWedgeAttempt(worktreePath, repoPath, "killable removal was force-killed on timeout (handle still held)");
      const ageMs = Date.now() - new Date(entry.firstWedgedAt).getTime();
      if (entry.attempts >= this.wedgeGiveUpAttempts || ageMs >= this.wedgeGiveUpMs) {
        this.db.markWorktreeNeedsHuman(worktreePath);
        // eslint-disable-next-line no-console
        console.warn(`[worktree] ${worktreePath} has been wedged for ${Math.round(ageMs / 86_400_000)} day(s) across ${entry.attempts} attempt(s) — ` +
          `giving up automatic retry. Needs a human to investigate (reboot to force-release a stuck handle) and delete it manually.`);
        // This IS the pass that crossed the give-up bound — report it as the give-up outcome directly
        // (not "wedged") so the caller's aggregate counts it as a give-up on the SAME pass it happened,
        // rather than under-counting it as one more ordinary retry.
        return { outcome: "needs-human-skip" };
      }
      // eslint-disable-next-line no-console
      console.warn(`[worktree] ${worktreePath} still wedged (attempt ${entry.attempts}) — retrying slowly ` +
        `(next: a later boot, or the background sweep in ≤${Math.round(this.wedgeSweepIntervalMs / 60_000)}min). Not abandoned.`);
      this.armWedgeSweep();
      return { outcome: "wedged" };
    }
    return { outcome: "left-on-disk" };
  }

  /** Arm the low-frequency background wedge-retry sweep if it isn't already running. Self-disarms (see
   *  {@link sweepWedgedWorktreesOnce}) once nothing remains to retry, so an idle daemon (the common case)
   *  never pays for a standing timer. `.unref()`'d so it can never keep the process alive on its own. */
  private armWedgeSweep(): void {
    if (this.wedgeSweepTimer) return;
    const timer = setInterval(() => { void this.sweepWedgedWorktreesOnce(); }, this.wedgeSweepIntervalMs);
    timer.unref?.();
    this.wedgeSweepTimer = timer;
  }

  /**
   * One retry pass over every currently-wedged, not-yet-given-up worktree. SLOW cadence in production
   * (~45min default, always in the owner-directed 30-60min band) — safe at ANY cadence because each
   * attempt is the SAME killable removal used everywhere else (a separate OS process, force-killed on
   * timeout — never a threadpool op, never able to leak/stick the daemon). This is explicitly NOT
   * bd9fc808's reverted 30s loop: the cadence here is ~1000x slower AND the removal itself can no longer
   * hang a thread even if retried far more often than this. Exposed (not private) so a test can drive a
   * sweep deterministically instead of waiting on a real timer.
   */
  async sweepWedgedWorktreesOnce(): Promise<void> {
    const pending = this.db.listWedgedWorktrees().filter((e) => !e.needsHuman);
    for (const entry of pending) {
      // Codescape C3: a wedge entry carries no projectId/taskId (WedgedWorktreeEntry is repoPath +
      // worktreePath only) — the drop hook is skipped for a retry that succeeds via THIS path. Advisory
      // metadata only (never correctness-critical, same as baseRef), so a stale registration lingering a
      // bit longer here is an accepted gap, not a bug.
      await this.gcWorktreeDir(entry.repoPath, entry.worktreePath);
    }
    const stillPending = this.db.listWedgedWorktrees().some((e) => !e.needsHuman);
    if (!stillPending && this.wedgeSweepTimer) {
      clearInterval(this.wedgeSweepTimer);
      this.wedgeSweepTimer = null;
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
    worktreePath: string; branch: string; repoPath: string; projectId: string;
    /**
     * Skip the nested-git-repo guard below and force the removal through regardless (card b6d41db1's
     * override) — for a manager that has confirmed the worktree's untracked content is disposable.
     * Default OFF (safe): a nested repo is retained unless this is explicitly set.
     */
    forceRemoveWorktree?: boolean;
  }): Promise<{ nestedRepoBlock?: { paths: string[]; truncated: boolean } }> {
    // SIBLING SWEEP first (incident 35fc823f): retire any OTHER live session bound to this task before the
    // worktree is removed, so no zombie is left running in the about-to-be-deleted cwd. The keep is the
    // worker being merged (already hard-stopped by the caller). Covers BOTH confirmWorkerMerge paths
    // (ALREADY_MERGED + Green) here once, so they can't drift; at boot-reconcile it's a no-op (recoverStale-
    // Sessions has already marked prior-run ptys exited, so the task has no live siblings).
    await this.retireSiblingSessionsForTask(args.taskId, args.workerSessionId);
    let nestedRepoBlock: { paths: string[]; truncated: boolean } | undefined;
    try {
      // The nested-git-repo guard (card b6d41db1) lives IN gcWorktreeDir — the single removal
      // chokepoint every caller (this, boot-reconcile Pass B's two GC sites, the wedge sweep) shares —
      // so it can never be bypassed via a sibling path. `forceRemoveWorktree` is threaded through ONLY
      // from this manager-facing caller; see gcWorktreeDir's own doc for why the automatic paths never
      // set it.
      const result = await this.gcWorktreeDir(args.repoPath, args.worktreePath, {
        projectId: args.projectId,
        worktreeId: codescapeWorktreeId(args.taskId),
      }, { forceRemoveWorktree: args.forceRemoveWorktree });
      if (result.outcome === "nested-repo-blocked") {
        nestedRepoBlock = { paths: result.nestedRepoPaths ?? [], truncated: !!result.scanTruncated };
        // eslint-disable-next-line no-console
        console.warn(`[finalizeMerge] worktree ${args.worktreePath} RETAINED (nested-repo-blocked) — ` +
          `merge already landed, only the worktree cleanup is deferred.`);
      } else if (result.outcome !== "removed") {
        // eslint-disable-next-line no-console
        console.warn(`[finalizeMerge] worktree ${args.worktreePath} not removed (${result.outcome}); ` +
          `merge already landed — finishing bookkeeping regardless.`);
      }
    } catch (e) {
      // gcWorktreeDir/removeWorktree are themselves best-effort and should never throw; stay defensive
      // anyway so an unexpected throw can't abort the rest of finalizeMerge's bookkeeping.
      // eslint-disable-next-line no-console
      console.warn(`[finalizeMerge] could not remove worktree ${args.worktreePath} (dir busy?); ` +
        `merge already landed — finishing bookkeeping, boot-reconcile Pass B will GC the dir: ${(e as Error).message}`);
    }
    // Terminal bookkeeping BEFORE the destructive deleteBranch (see the ORDER IS CRASH-CRITICAL note).
    // Land the task in the `mergeLanding` lane if the project has one configured, else the `terminal`
    // lane (role-resolved off its project, last-column fallback) — not the hardcoded "done" key. A
    // project with no `mergeLanding` column resolves `undefined` here and falls through to `terminal`
    // exactly as before this role existed. A merge always has a terminal lane (the role is required +
    // falls back to last).
    // ONLY on the FIRST finalize for this worker (no prior merge_done event) — a REPLAY (an idempotent
    // worktree-GC retry, or a reconnect/boot reconciliation re-run finding the merge already landed) must
    // never force the column back over a manual move a human made AFTER the merge landed. That
    // clobber was the bug: a card the manager moved to a non-terminal "ready for owner review" lane got
    // silently reset to the terminal column on the next reconnect/boot reconcile, which then made
    // worker_spawn wrongly refuse it as a terminal-column task.
    const alreadyFinalized = args.taskId != null &&
      this.db.listEventsForWorker(args.workerSessionId).some((e) => e.kind === "merge_done");
    if (args.taskId && !alreadyFinalized) {
      const task = this.db.getTask(args.taskId);
      const landingKey = task
        ? (this.columnKeyForProjectRole(task.projectId, "mergeLanding") ??
          this.columnKeyForProjectRole(task.projectId, "terminal"))
        : undefined;
      if (landingKey) this.db.updateTask(args.taskId, { columnKey: landingKey });
    }
    this.db.appendEvent({
      id: randomUUID(), ts: new Date().toISOString(),
      managerSessionId: args.managerSessionId, workerSessionId: args.workerSessionId,
      taskId: args.taskId, kind: "merge_done", detail: { branch: args.branch },
    });
    // A retained worktree (nested-repo guard above, hit OR inconclusively truncated) is still checked
    // out on `branch` — `git branch -D` would only fail ("checked out at ...") and warn for a reason we
    // already know, so skip it; the branch is deleted on a later confirm once the worktree is actually gone.
    if (!nestedRepoBlock) await deleteBranch(args.repoPath, args.branch, { timeoutMs: this.gitOpMs });
    // Codescape C3: reingest main's CURRENT working tree AFTER it's been checked out above (both the
    // Green path and the ALREADY_MERGED path converge here) — fire-and-forget, NEVER awaited inline: a
    // big-repo ingest can take up to ~2 minutes, so awaiting it here would hold the merge caller for that
    // whole window. Best-effort by construction.
    this.fireCodescapeReingest(args.projectId, args.repoPath);
    // The merged worker's slot is now genuinely, finally free — nothing else claims it afterward (unlike
    // recycleWorker's own predecessor exit), so drain here rather than waiting for the caller's own
    // hard-stop of the merged worker to reach the generic onExit-driven drain. Fire-and-forget; a
    // redundant second drain from that later onExit is harmless (idempotent — the queue is either already
    // empty or still genuinely has room). Safe on the idempotent ALREADY_MERGED replay path too.
    void this.maybeDrainCapQueue(args.managerSessionId);
    return nestedRepoBlock ? { nestedRepoBlock } : {};
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
  async reconcileOrchestrationOnBoot(protectedSessionIds: Set<string> = new Set()): Promise<{ mergesFinished: number; mergesFailed: number; staleMergesResolved: number; worktreesPruned: number; worktreesKept: number; worktreesNeedsHuman: number; worktreesStillWedged: number }> {
    // Include archived sessions: an archived worker whose worktree still lingers must still be GC'd.
    const all = this.db.listAllSessionsIncludingArchived();
    const handledWorktrees = new Set<string>();
    let mergesFinished = 0;
    let mergesFailed = 0;
    let staleMergesResolved = 0;
    let worktreesPruned = 0;
    let worktreesKept = 0;
    let worktreesNeedsHuman = 0;

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
        // "Already reconciled" is an EVENT signal (a recorded merge_done), not the task's CURRENT column —
        // a human can freely move a merged card OFF the terminal column afterward (e.g. into a review lane)
        // without that meaning "the merge needs re-finishing." Keying this off columnKey used to make
        // exactly that manual move look unreconciled on every future boot, re-running finalizeMerge and (pre
        // the finalizeMerge guard above) forcing the column back to terminal each time.
        const alreadyFinalized = this.db.listEventsForWorker(s.id).some((e) => e.kind === "merge_done");
        if (alreadyFinalized && !worktreeOnDisk) continue; // already fully reconciled — nothing to finish
        await this.finalizeMerge({
          managerSessionId: s.parentSessionId ?? "", workerSessionId: s.id, taskId: s.taskId,
          worktreePath, branch: s.branch, repoPath: project.repoPath, projectId: project.id,
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
        // gcWorktreeDir's nested-repo guard applies here too (card b6d41db1 follow-up) — a partially-
        // deleted worktree (no root `.git` linkage left) can still hold a live nested clone; NO override
        // is ever passed on this automatic path, so a hit is always retained + logged, never destroyed.
        const { outcome } = await this.gcWorktreeDir(project.repoPath, worktreePath, {
          projectId: project.id,
          worktreeId: codescapeWorktreeId(s.taskId),
        }).catch(() => ({ outcome: "left-on-disk" as const }));
        // Only an ACTUAL removal counts as pruned — "wedged"/"left-on-disk"/"nested-repo-blocked" is a
        // retry-pending (or human-recoverable) attempt, not a completed prune, and double-counting it
        // here overstated the aggregate.
        if (outcome === "needs-human-skip") worktreesNeedsHuman++;
        else if (outcome === "removed") worktreesPruned++;
        continue;
      }
      if (await worktreeHasWork(project.repoPath, worktreePath, s.branch ?? null, "HEAD", { timeoutMs: this.gitOpMs })) {
        // eslint-disable-next-line no-console
        console.warn(`[reconcile] kept worktree ${worktreePath} — holds unmerged/uncommitted work (Pass B)`);
        worktreesKept++;
        continue;
      }
      // Same nested-repo guard, same "never override on an automatic path" rule as above — this is the
      // OTHER Pass B GC site (a provably-disposable worktree per worktreeHasWork), and it's the incident's
      // worse real trigger: a pre-merge crash orphans a worktree whose nested clone is GITIGNORED, so
      // `git status --porcelain`/worktreeHasWork are both blind to it and would otherwise force-remove
      // straight through.
      const { outcome } = await this.gcWorktreeDir(project.repoPath, worktreePath, {
        projectId: project.id,
        worktreeId: codescapeWorktreeId(s.taskId),
      }).catch(() => ({ outcome: "left-on-disk" as const }));
      // Only an ACTUAL removal counts as pruned — see the identical comment on the dead-leftover branch above.
      if (outcome === "needs-human-skip") worktreesNeedsHuman++;
      else if (outcome === "removed") worktreesPruned++;
    }

    // Surface what's still wedged-but-retryable (armWedgeSweep already fired per-entry above; this is the
    // aggregate boot-level visibility) and what's been given up on entirely — both logged, never silent.
    const stillWedged = this.db.listWedgedWorktrees().filter((e) => !e.needsHuman);
    if (stillWedged.length > 0) {
      this.armWedgeSweep(); // belt-and-suspenders: guarantees the sweep is armed after every boot that leaves work pending
      // eslint-disable-next-line no-console
      console.warn(`[reconcile] ${stillWedged.length} worktree(s) still wedged, retrying slowly (next boot + background sweep) — ` +
        `not abandoned. Paths: ${stillWedged.map((e) => e.worktreePath).join(", ")}`);
    }
    if (worktreesNeedsHuman > 0) {
      const paths = this.db.listWedgedWorktrees().filter((e) => e.needsHuman).map((e) => e.worktreePath);
      // eslint-disable-next-line no-console
      console.warn(`[reconcile] ${paths.length} worktree(s) gave up automatic retry (wedged too long) — ` +
        `needs a human to investigate + delete manually. Paths: ${paths.join(", ")}`);
    }

    // Surfaced separately from worktreesPruned (task 8e5a7a5e nit fix: pruned now counts only an ACTUAL
    // removal) so a boot pass whose only activity is retrying an already-wedged worktree — pruned=0,
    // kept=0, needsHuman=0, no merges — doesn't read as "nothing happened" to a caller's summary log; see
    // index.ts's boot-reconcile summary line, which gates on this alongside the other counters.
    return { mergesFinished, mergesFailed, staleMergesResolved, worktreesPruned, worktreesKept, worktreesNeedsHuman, worktreesStillWedged: stillWedged.length };
  }
}
