// Core Loom entities. Loom owns four primitives: Project, Agent, Session, Task.
// (Skill loading is delegated to the Claude CLI — Loom builds no skill machinery.)
import type { ProjectConfigOverride } from "./config.js";

export type ProjectId = string;
export type AgentId = string;
export type SessionId = string; // Loom's own id
export type TaskId = string;
export type ProfileId = string;
export type ApiKeyId = string;
export type RunId = string;

/**
 * One WRITABLE repo in a project's multi-repo registry (multi-repo epic 49136451, phase 1) — the
 * writable counterpart to `referenceRepos` (which stays read-only). `key` is a stable, human-chosen
 * slug a `Task.repoKey` targets; `"primary"` is RESERVED (it always means `repoPath`, never a
 * registry entry). `path` is an absolute, existing-git-repo host path, validated by
 * `projects/repos.ts`'s `validateRepoRegistry` — same trust class as `repoPath`. `gateCommand` is
 * this repo's OWN build/test gate — deliberately NOT inherited from the project-level
 * `orchestration.gateCommand` (a Python repo and a Next.js repo need different toolchains); omitted
 * means this repo has no configured gate, which `resolveRepo` surfaces as `gateCommand: undefined`
 * so the SAME "unverified: no gateCommand" merge warning a gateless project gets today applies to a
 * gateless registry repo too, rather than silently inheriting an unrelated project-level command.
 */
export interface RepoRegistryEntry {
  key: string;
  path: string;
  gateCommand?: string;
}

/** A project's two bindings + its config override blob. */
export interface Project {
  id: ProjectId;
  name: string;
  repoPath: string;   // cwd for spawned sessions; source of project-local .claude/skills
  vaultPath: string;  // Obsidian docs folder (auto-committed)
  /**
   * Additional repos a manager + its workers may READ but never own — never a cwd, worktree base,
   * or gate target (repoPath stays the one primary repo for all of that). Absolute host paths.
   * Additive; legacy rows backfill to []. Read by prompt injection (worker-prompt.ts/manager-prompt.ts)
   * and the REST reference-repo git-log view (gateway/server.ts) — NOT "data model only" (that claim
   * was stale from before those phases landed).
   */
  referenceRepos: string[];
  /**
   * N additional WRITABLE repos (multi-repo epic 49136451, phase 1) — `repoPath` stays the ONE
   * primary repo (default target, manager cwd, skills source); a `Task.repoKey` optionally targets
   * one of these instead. See {@link RepoRegistryEntry}. Additive; legacy rows backfill to [].
   * HUMAN-ONLY trust boundary — same class as `repoPath`/`gateCommand` (each entry carries its own
   * `gateCommand`, i.e. host-RCE): settable via the REST create/PATCH `/api/projects` paths and
   * `project_init` ONLY. Every agent-facing write surface (loom-setup, the elevated loom-platform
   * Lead surface) must never declare this key — an agent-passed value is stripped, exactly like
   * `referenceRepos`/`noGateByDesign`/`denyGlobs`.
   */
  repos: RepoRegistryEntry[];
  /** Per-project config overrides; merged over platform defaults. */
  config: ProjectConfigOverride;
  createdAt: string;
  archivedAt: string | null;
  /**
   * Reserved/system project: a Loom-internal project (the seeded "Loom Platform" home for the
   * Platform Lead/Auditor agents) that is HIDDEN from the normal project picker (`db.listProjects`)
   * but still addressable + visible to admin surfaces (Mission Control, the future Platform UI).
   * false on every ordinary user project; only the boot-seeded platform home is true. Additive —
   * legacy rows backfill to false (0).
   */
  reserved: boolean;
  /**
   * Deliberate no-build-gate declaration (card 58b0bb60): when true, the per-merge "unverified: no
   * gateCommand is configured" warning (worker_merge_confirm / confirmWorkerMerge) is SUPPRESSED for
   * this project — a vault/markdown/knowledge project has no buildable code, so that warning is pure
   * noise, not a signal of a missing gate worth asking the owner about. An UNFLAGGED gateless project
   * still warns on every merge (a genuinely missing gate stays surfaced) — this flag opts OUT of the
   * warning, it does not touch gate execution: a project WITH a `gateCommand` configured is unaffected
   * either way (the gate still runs; this flag only silences the no-gate warning path). Default false
   * and fully additive — legacy rows backfill to false (0), byte-identical to today. HUMAN-set only
   * (the REST project create/update surface) — same trust posture as `gateCommand`/`repoPath`: it
   * silences a merge-integrity signal, so no agent MCP tool (setup or the elevated Platform Lead) may
   * set it; those surfaces simply don't declare the field, so an agent-passed value is stripped.
   */
  noGateByDesign: boolean;
  /**
   * Glob patterns (matched against a POSIX, repo-relative path) that flag a WARNING — never a hard
   * block — at `worker_merge` review time when the branch diff ADDS a file under one of them (card
   * d5d3bdc9). Default `["mockups/**"]`: mockup deliverables (HTML/PNG/README) belong in the Obsidian
   * vault, not the code repo, and workers have repeatedly committed them here by accident, caught only
   * as a merge-gate diffstat surprise on a repo that's PUBLIC. An empty array opts a project OUT
   * entirely. Additive; legacy rows backfill to the same default (not `[]`) so the warning applies
   * out of the box. HUMAN-set only via the REST create/update paths — same trust posture as
   * `repoPath`/`referenceRepos`/`noGateByDesign`: no agent MCP tool ever declares this key.
   */
  denyGlobs: string[];
}

/**
 * An **Agent** — the seat + brief inside a project: identity, project-specifics, and the startup
 * prompt injected as the first input of a NEW session. Per-project, many, edited often. An Agent
 * RUNS UNDER a Profile (the reusable rig); the Profile supplies role/model/allow/skills/icon while
 * the injected prompt always comes from the Agent.
 */
export interface Agent {
  id: AgentId;
  projectId: ProjectId;
  name: string;
  /** Injected as the first input ONLY when starting a new session (never on resume). */
  startupPrompt: string;
  position: number;
  /**
   * Optional Profile this agent runs under — the reusable, platform-level "rig" (role + model +
   * allow-delta + skill-subset + icon). Nullable + additive: null = a plain agent, which
   * `resolveProfile` maps to EXACTLY today's behavior. When set, the profile supplies
   * role/allow/skills/model/icon; the injected prompt ALWAYS comes from the agent (a profile no
   * longer carries a prompt — its `description` is a UI-only blurb).
   */
  profileId: ProfileId | null;
  /**
   * Agent Runs R1: marks this agent as *API-exposable* — only an `endpoint=true` agent may be put
   * on a project API key's allowlist (the Agent Runs run-invocation surface, R2+). Default **false**
   * and FULLY ADDITIVE: the flag changes NO spawn behavior in R1 (a session in an endpoint agent
   * spawns byte-identically to one in a non-endpoint agent) — it only gates allowlist eligibility +
   * which agents the future run API may invoke. HUMAN-set only (the agent-edit REST surface); NO
   * agent MCP tool can flip it (same trust-boundary posture as profile role / gateCommand). Legacy
   * rows backfill to false (0). See `[[Agent Runs]]`.
   */
  endpoint: boolean;
  /**
   * Agent Runs R1: an OPTIONAL JSON I/O schema blob describing the agent's expected input/output for
   * runs (advisory in R1 — nothing reads it yet; R2's `submit_result` validates against a
   * caller-supplied-per-call schema, not this one). Nullable + additive (null on every existing /
   * non-endpoint agent). Stored verbatim as a JSON value.
   */
  ioSchema: unknown | null;
}

/** An agent enriched with its project name — for a global "Project / Agent" label map (god-eye pickers). */
export interface AgentListItem extends Agent {
  projectName: string;
}

/**
 * A **Profile** — a reusable, platform-level (cross-project) "rig": the role, model, permission
 * delta, skill-subset, and icon a session adopts. Agents reference one via `profileId`, and
 * `resolveProfile` (sibling of `resolveConfig`) resolves agent + profile into the effective spawn
 * shape. An agent with NO profile resolves to today's plain behavior, so this is fully additive.
 * Platform-level on purpose (like skills + config defaults): a small reusable set, rarely changing,
 * reused across projects rather than re-typed per project. A Profile carries NO injected prompt —
 * `description` is a human-facing blurb shown in the Profiles UI, never injected into a session.
 */
export interface Profile {
  id: ProfileId;
  name: string;
  /** Orchestration role conferred; null = a plain (non-orchestration) session — today's default. */
  role: SessionRole | null;
  /** Human-facing blurb shown in the Profiles UI (what this rig is for). NEVER injected into a
   *  session — the injected startup prompt always comes from the Agent. */
  description: string;
  /** Permission allowlist delta layered onto the resolved config's allow (e.g. extra Bash globs). */
  allowDelta: string[];
  /** Skill-name subset to deliver; null = deliver all (today's behavior). */
  skills: string[] | null;
  /** Model id to spawn with (e.g. "claude-opus-4-8"); null = engine default (no --model emitted). */
  model: string | null;
  /** UI icon (emoji or name); null = none. */
  icon: string | null;
  /**
   * Opt-in browser-automation capability: when true, a session under this rig is spawned with its
   * OWN per-session stdio Playwright MCP (`@playwright/mcp`) so the agent can drive a headless
   * browser. Default OFF (absent/false) and fully additive — a rig without it spawns byte-identically
   * to today. HUMAN-set only (Profiles UI / REST), like role/allow: NEVER exposed via an agent MCP
   * tool (a browser is a navigate-anywhere capability — same capability-gating posture as gateCommand).
   */
  browserTesting?: boolean;
  /**
   * Opt-in document-conversion capability: when true, a session under this rig is spawned with its
   * OWN per-session stdio markitdown MCP (`markitdown-mcp`) so the agent can convert files
   * (PDF/Office/images/HTML/…) to Markdown to save tokens. Default OFF (absent/false) and fully
   * additive — a rig without it spawns byte-identically to today. HUMAN-set only (Profiles UI / REST),
   * like role/allow/browserTesting: NEVER exposed via an agent MCP tool (it launches a host process —
   * same capability-gating posture as browserTesting/gateCommand).
   */
  documentConversion?: boolean;
  /**
   * Opt-in RESTRICTED-tools capability (blast-radius control for a chat-reachable Companion): when true, a
   * session under this rig is spawned with a curated, HARDCODED set of dangerous NATIVE tools (raw shell +
   * host-writes: `Bash`/`Edit`/`Write`/`NotebookEdit`/`MultiEdit`) REMOVED from the model's tool list
   * (appended to `--disallowedTools`, unioned with the role's human-prompt disallow). SUBTRACTIVE — unlike
   * browserTesting/documentConversion it confers no capability, it withdraws one. Default OFF (absent/false)
   * and fully additive — a rig without it spawns byte-identically to today (the disallow list is exactly the
   * role's human-prompt tools). Least-privilege by construction: the tool set is fixed, never agent- or
   * free-form-configurable; the human WIDENS deliberately by turning the flag OFF. HUMAN-set only (Profiles
   * UI / REST), like role/browserTesting: NEVER exposed as an agent MCP setter beyond the profile surface
   * (same capability-gating posture as browserTesting/gateCommand). The counterweight to a companion driven
   * by untrusted inbound chat (a prompt-injection vector).
   */
  restrictedTools?: boolean;
  /**
   * Opt-in "no-commit role" declaration: when true, a worker under this rig is a READ-ONLY / no-commit
   * worker (e.g. a Code Reviewer) whose CORRECT contract is to produce NO commit (`filesChanged:0`).
   * Default OFF (absent/false) and fully additive — a rig without it behaves byte-identically to today.
   * Unlike browserTesting/documentConversion this confers NO spawn-time host capability (no MCP is
   * injected); it is a pure LIFECYCLE flag the worker_report path keys off: a no-commit worker that
   * reports done with 0 commits ahead of base is AUTO-RETIRED (its concurrency slot freed without a
   * manual worker_stop — a read-only worker has no merge step to free it), and the "forgot to commit"
   * guard is SUPPRESSED for it. HUMAN-set only (Profiles UI / REST), like role/browserTesting — it gates
   * orchestration behavior, never an agent MCP write surface. A NORMAL (noCommit-false) 0-commit worker
   * still gets the warning and is NEVER auto-retired (the forgot-to-commit safety net stays intact).
   */
  noCommit?: boolean;
  /**
   * Opt-in authenticated-egress capability (agent-tooling epic P2): the list of P1 credential-store
   * Connection ids a session under this rig may use with the `authenticated_request` tool. Default OFF
   * (absent/empty — UNLIKE `skills`, absent here means NO access, never "all connections") and fully
   * additive — a rig without it spawns byte-identically to today. HUMAN-set only, via the Profiles UI /
   * REST `POST`/`PUT /api/profiles` — stricter than `browserTesting`/`documentConversion`: this field is
   * REJECTED even on the Setup Assistant's and Platform Lead's own profile-writing MCP tools (see
   * `profiles/validate.ts`'s agent-restriction helper), because it grants access to REAL external secrets
   * rather than a sandboxed capability. Never exposed as an agent MCP setter, full stop.
   */
  connections?: string[];
  /**
   * Agent-tooling P4: registry-capability grants for this rig — each names a catalog capability slug
   * plus an OPTIONAL bound P1 connection id when that capability needs a credential (the credential is
   * decrypted server-side at spawn and injected only into the capability's own MCP subprocess env — never
   * the `claude` process, never a tool argument). Default OFF (absent/empty, like `connections`, NOT
   * `skills`) and fully additive. HUMAN-set only: unlike `browserTesting`/`documentConversion`, this field
   * is REJECTED even on the Setup Assistant's/Platform Lead's own profile-writing MCP tools (see
   * `profiles/validate.ts`'s `AGENT_FORBIDDEN_PROFILE_KEYS`) — a capability grant can launch a host
   * process and bind egress, so it gets the SAME stricter posture as `connections`, not the milder one.
   * The legacy `browserTesting`/`documentConversion` booleans above are BRIDGED, not replaced: they stay
   * two permanently-reserved builtin capability slugs ("browser-testing"/"document-conversion") resolved
   * alongside this array (see `resolveProfileCapabilities` in `config.ts`) — every existing profile row
   * keeps working with zero data migration.
   */
  capabilities?: CapabilityGrant[];
  /**
   * Opt-in confined vault-write capability (card be8be211): when true, a session under this rig may call
   * the `vault_write` tool (loom-tasks MCP) to write (create/overwrite) a UTF-8 text note under ITS OWN
   * project's vault root — the friction this solves is a research/Analyst rig whose deliverable IS a
   * vault note, but which runs in an isolated worktree with no vault access otherwise. Default OFF
   * (absent/false) and fully additive — a rig without it spawns byte-identically to today (the tool is
   * OMITTED from tools/list entirely, not merely denied — mirrors the `authenticated_request` gate on
   * `connections`, not the browserTesting/documentConversion stdio-MCP pattern: no host process is
   * launched, so this is never threaded into the spawn recipe). Confinement reuses `vault/writer.ts`'s
   * existing path-traversal guard verbatim; the project is always SERVER-DERIVED from the session, never
   * agent-passed. HUMAN-set only, via the Profiles UI / REST `POST`/`PUT /api/profiles` — the SAME
   * stricter posture as `connections`/`capabilities` (see `profiles/validate.ts`'s
   * `AGENT_FORBIDDEN_PROFILE_KEYS`): a write capability into a human-reviewed corpus is exfil/tamper-
   * adjacent, not a sandboxed read/convert tool, so it is rejected even on the Setup Assistant's / Platform
   * Lead's own profile-writing MCP tools. Write-only by design (no delete) — a note-writer's job is to
   * produce or update a note, not remove vault content.
   */
  vaultWrite?: boolean;
}

/**
 * One profile's grant of a registry capability (agent-tooling P4) — the catalog slug to enable, plus an
 * OPTIONAL bound P1 connection id when the capability needs a credential. See `Profile.capabilities`.
 */
export interface CapabilityGrant {
  slug: string;
  connectionId?: string;
}

/**
 * How a registry capability's MCP server is provisioned (agent-tooling P4). v1 shipped three kinds;
 * `command` followed as a focused follow-on (owner-approved: owner-typed-therefore-trusted, the same
 * trust model as `gateCommand` — trust is about who-can-set, not sandboxing what's set):
 *  - `node-package`  — resolved via `require.resolve` of an already-installed daemon dependency, mirroring
 *                      the Playwright MCP (a bin script sitting beside `package.json`, not in its exports map).
 *  - `python-venv`   — resolved via the shared Loom-managed Python venv (`ensurePythonPackageAsync`),
 *                      mirroring the markitdown MCP — the one kind an owner can realistically point at a
 *                      genuinely NEW capability (any PyPI-published MCP server) without a daemon code change.
 *  - `bundled`       — ships inside Loom's own assets, no install/resolve step.
 *  - `command`       — an owner-typed arbitrary executable + args, resolved to an ABSOLUTE path at
 *                      catalog-save time (`resolveExecutable`); a host process the owner explicitly typed in.
 *  - `github-binary` — a Loom-managed, checksum-verified Go binary downloaded to
 *                      `<LOOM_HOME>/bin/github-mcp-server/<version>/`, mirroring `python-venv`'s
 *                      fs.existsSync-fast-path + background-provision pattern. SEED-ONLY (not owner-typeable
 *                      via `validateCapabilityDefInput`) — today just the bundled "github" capability.
 */
export type CapabilityProvisionKind = "node-package" | "python-venv" | "bundled" | "command" | "github-binary";

/**
 * REST-facing summary of one catalog capability (builtin or owner-added) — never carries the raw
 * provisioning recipe (package names / commands), which stays daemon-internal. What the Settings UI's
 * capability catalog panel and the Profile editor's capability picker read.
 */
export interface CapabilitySummary {
  /** The `capability_defs` row id — present for an owner-added row (DELETE /api/capabilities/:id
   *  target), absent for a builtin (builtins aren't rows and can't be deleted). */
  id?: string;
  slug: string;
  name: string;
  description: string;
  transport: "stdio" | "http";
  kind: CapabilityProvisionKind;
  /** Whether this capability needs a bound P1 connection to function (surfaced as a UI badge). */
  requiresConnection: boolean;
  /** Loom-shipped (catalog seed) vs owner-added via the Settings UI/REST. */
  builtin: boolean;
}

// --- Bundled-profile customization (the profiles analog of skill customization) -------------------
/**
 * One field's three-way view in a profile merge/diff (`mine` = the user's row, `base` = the shipped def
 * at last sync, `shipped` = Loom's current bundled def). The profile analog of a skill's conflict hunk,
 * but FIELD-level (profiles are structured, not text): each entry is one whole mergeable field's value.
 */
export interface ProfileFieldMerge {
  field: string;
  mine: unknown;
  base: unknown;
  shipped: unknown;
}
/**
 * The result of a field-level 3-way merge of a bundled profile (`mergeProfile(base, mine, shipped)`):
 * `clean` ⇔ no field where all three differ; `merged` is the auto-resolved field set (conflict fields
 * left at `mine`, pending the user's per-field choice); `conflicts` lists the fields where all three
 * differ (each a wholesale mine-vs-shipped pick). The structured-data counterpart of SkillMergeResult.
 */
export interface ProfileMergeResult {
  clean: boolean;
  merged: Partial<Profile>;
  conflicts: ProfileFieldMerge[];
}
/**
 * A profile enriched with its computed customization state — the read-model the profile list/get REST
 * returns. `bundled` = the row's name matches a shipped BUNDLED_PROFILES entry; `customized`/`updateAvailable`
 * are present ONLY for bundled-by-name profiles (computed from the three versions, NEVER persisted), exactly
 * like SkillSummary. The profile analog of SkillSummary, carrying the FULL row (profiles ARE DB entities).
 */
export interface ProfileSummary extends Profile {
  bundled: boolean;
  /** Bundled-by-name only: the row (`mine`) differs from the `base` snapshot — the user edited it. */
  customized?: boolean;
  /** Bundled-by-name only: Loom shipped a newer bundled def than the `base` snapshot — an update to adopt. */
  updateAvailable?: boolean;
}

// --- Agent Runs API keys (R1) ---------------------------------------------------------------------
/** A project API key's lifecycle status: active (auths), paused (temporarily blocked), revoked (dead). */
export type ApiKeyStatus = "active" | "paused" | "revoked";

/**
 * Per-key usage ceilings (Agent Runs R1 STORES them; R3/R4 enforce — nothing reads them in R1).
 * `null` on any field = uncapped for that dimension.
 */
export interface ApiKeyCaps {
  /** Max simultaneously-running runs this key may have in flight. */
  maxConcurrentRuns: number | null;
  /** Daily token budget across this key's runs. */
  dailyTokenCap: number | null;
  /** Daily spend budget (USD) across this key's runs. */
  dailySpendCap: number | null;
}

/**
 * A project-scoped API key (Agent Runs R1). The key SECRET is NEVER part of this shape — only a
 * salted hash lives at rest (db-internal); the plaintext token is returned exactly ONCE at creation
 * and at each rotation, never again. This is the public METADATA the human-only key-admin REST
 * surfaces (list/create/rotate/edit) — list must never leak the secret or its hash. The key binds a
 * project to an allowlist of that project's `endpoint=true` agents (R2+ run-invocation scope) plus
 * per-key caps. Human-managed only — no agent MCP tool can mint/rotate/revoke one. See `[[Agent Runs]]`.
 */
export interface ApiKey {
  id: ApiKeyId;
  projectId: ProjectId;
  /** Human label for the key (e.g. "Invest app — prod"). */
  name: string;
  /** Allowlist of endpoint-agent ids this key may invoke; every id is an `endpoint=true` agent in the project. */
  endpointAgentIds: AgentId[];
  caps: ApiKeyCaps;
  status: ApiKeyStatus;
  createdAt: string;
  /** When the secret was last rotated (null = never rotated since creation). */
  rotatedAt: string | null;
}

// --- Access-story gateway token (Phase B, card 56ffe50a) ------------------------------------------
export type GatewayTokenStatus = "active" | "paused" | "revoked";
export type GatewayTokenId = string;

/**
 * The daemon-global gateway token (access-story Phase B) — the credential that authorizes a Tier-1
 * request over a non-loopback remote bind (see gateway/trust-tier.ts). A single token is the v1
 * shape, but the store supports more than one row. Deliberately a DISTINCT kind from `ApiKey` (a
 * project-scoped Run key): a gateway token is not project-scoped, carries no endpoint-agent
 * allowlist or usage caps, and is minted with a DISTINCT `lgw_` prefix so the two credential kinds
 * can never be confused at the parse level — a Run key cannot parse as a gateway token and vice
 * versa (keys/hash.ts `parseGatewayToken`/`parseApiKey`). The SECRET is never part of this shape —
 * only a salted hash lives at rest; the plaintext is returned exactly ONCE at mint/rotate, the same
 * "hashed at rest, plaintext once" contract as `ApiKey`. Human-managed only — no agent MCP tool can
 * mint/rotate/revoke one.
 */
export interface GatewayToken {
  id: GatewayTokenId;
  /** Human label (e.g. "My laptop"). */
  name: string;
  status: GatewayTokenStatus;
  createdAt: string;
  /** When the secret was last rotated (null = never rotated since creation). */
  rotatedAt: string | null;
}

// --- Session FSM (explicit; replaces the predecessor's loose status enum) ---
// 'none' has no TS producer (every insert path stamps "starting"), but it stays: it's the SQL column
// default (`process_state TEXT NOT NULL DEFAULT 'none'` in db.ts) — the structural placeholder for any
// row that lands without an explicit state — and the read-path cast (`r.process_state as ProcessState`)
// plus the backfill/ordering logic (db.ts archived-backfill, web livenessRank) reason about 'none' rows.
export type ProcessState = "none" | "starting" | "live" | "exited";
export type Resumability = "unknown" | "resumable" | "dead";

/**
 * A session's orchestration role (phase-2). Plain phase-1 sessions have no role.
 * - manager / worker: the orchestration spine (loom-orchestration MCP).
 * - platform: a platform-lead — creates/configures projects + agents (loom-platform MCP, Pillar C).
 *   Kept distinct from manager so least-privilege holds: cross-project tools never leak into a
 *   project-scoped manager, and a platform-lead gets no worker-coordination tools.
 * - auditor: the Platform Auditor (Platform Manager P5) — a scheduled, READ-AND-FILE-ONLY transcript
 *   reviewer. A DISTINCT role from `platform` BY DESIGN (the load-bearing security boundary): it
 *   ingests UNTRUSTED transcript content (a prompt-injection surface), so it gets ONLY the restricted
 *   `loom-audit` surface (cross-project transcript reads + file-finding to the Platform backlog) and
 *   NATURALLY 404s on the Lead's elevated `/mcp-platform` (resolveRole gates on role==="platform") AND
 *   on `/mcp-orch` (gates on manager|worker). No agent/MCP path may mint one — only `startAuditor`
 *   (human REST) and the human-configured Scheduler spawn it.
 * - workspace-auditor: the END-USER Auditor (End-User Platform tier, Part B) — the de-privileged,
 *   user-workspace twin of `auditor`: a read-mostly, SUGGEST-ONLY reviewer of the user's OWN
 *   sessions/agents/skills/prompts (board-card + preset suggestions, never auto-apply). A DISTINCT role
 *   from `auditor` BY DESIGN so the two missions are physically separated under LOOM_DEV (where both
 *   exist): it gets ONLY the restricted `loom-user-audit` surface (B3, not built yet) and 404s on every
 *   other MCP surface. Like `auditor` it ingests UNTRUSTED transcript content, so it is caller-set ONLY
 *   by a future `startWorkspaceAuditor` (B5, human REST) — NEVER mintable via a profile
 *   (`profiles/validate.ts`) or by the operator/Setup surface (`setupRoleError`). See
 *   `[[End-User Platform Tier Design]]` Part B. (B1 adds ONLY the role + these guards; the router/skill/
 *   profile/seed/start are B3–B5.)
 * - setup: a Setup Assistant session — the guided onboarding rig that helps a human stand up a project
 *   (see `[[Setup Assistant Design]]`). A first-class role so it can carry its own rig/skills; the
 *   bundled "Setup Assistant" profile sets it and it ships UNGATED (core product, not the dev Platform layer).
 * - run: an EPHEMERAL Agent-Run session (Agent Runs R2) — a curated endpoint agent invoked on one input
 *   to return a structured answer, then torn down. It SUBTRACTS the worker machinery (NO worktree /
 *   branch / merge gate), runs in a disposable read-only snapshot of the project's HEAD, and gets ONLY
 *   the restricted `loom-run` surface (`submit_result`), gated to role==="run" — so it 404s on every
 *   other MCP surface AND does not even mount `loom-tasks`. Runs are NOT resumable (ephemeral by design;
 *   a daemon restart mid-run fails the run clean). Started ONLY by the internal run-starter — no
 *   human/agent session-spawn route mints one (the public keyed trigger is R3). See `[[Agent Runs]]`.
 * - assistant: a long-lived Loom Companion session (Companion epic Phase 1) — ONE persistent, NON-worktree
 *   `claude` session (bound to a project or the platform, like manager/platform/setup — NOT a per-task
 *   worktree) that a human reaches over a CHAT channel (Telegram, etc.) rather than the interactive TUI.
 *   Its "human" never types at its stdin, so it is a Loom-DRIVEN role (spawns with the human-prompt tools
 *   disallowed) and it answers by calling `chat_reply` — its ONLY channel back. It gets a MINIMAL
 *   loom-orchestration surface (my_context + the companion-gated chat_reply), NEVER the manager
 *   spawn/stop/list surface or any writer (least-privilege; the restricted tool profile is a later card).
 *   Profile-spawnable + resume-durable like the other non-worktree persistent roles. See `[[Companion Design]]`.
 * - operator: the Bucket 2b "Elevated Operator" — a per-install, OPT-IN, HUMAN-SPAWNED-ONLY, OWN-WORKSPACE-
 *   CONFINED role sitting between the fail-closed `setup` operator and the LOOM_DEV Platform Lead. Gated
 *   LIVE (not boot-memoized) on the human-only `platform.operatorEnabled` config flag — flipping it off
 *   404s the surface immediately. When on, it gets the `loom-operator` MCP surface: the SAME own-workspace
 *   writers the Lead's P3 block carries (git_checkout/create_branch/commit/push + vault_write, reusing
 *   GitWriter/writeVaultFile VERBATIM) plus bounded own-project reads — but with NO `projectId` argument
 *   on any writer: the target project is resolved SERVER-SIDE from the caller's OWN session, the load-
 *   bearing divergence from the Lead's explicit-projectId cross-project tools. No config-set, no
 *   session_spawn/session_message, no schedule_*, no bundled skill_write, no cross-project reach at all.
 *   Never mintable via a profile role on the `setup` surface (setupRoleError) or via session_spawn on any
 *   agent-facing surface — human-REST (`startOperator`) only. See `[[Bucket 2b — Bounded Elevated Operator (Build Spec)]]`.
 */
export const SESSION_ROLES = ["manager", "worker", "platform", "auditor", "setup", "workspace-auditor", "run", "assistant", "operator"] as const;
export type SessionRole = (typeof SESSION_ROLES)[number];

// --- Agent Runs (R2): the AgentRun primitive ------------------------------------------------------
/**
 * An AgentRun's lifecycle status (Agent Runs R2). queued/starting/running are in-flight; the rest are
 * terminal. completed = `submit_result` recorded a (schema-valid) answer; failed = the run errored or
 * its session exited before submitting (incl. a daemon restart mid-run — runs do NOT resume); timed_out
 * = a hard timeout/cap teardown; cancelled = a deliberate cancel (R3 surfaces the trigger). Terminal
 * runs retain `{result, usage, transcriptRef, error}` on the row for audit.
 */
export type RunStatus = "queued" | "starting" | "running" | "completed" | "failed" | "timed_out" | "cancelled";

/**
 * An **AgentRun** (Agent Runs R2) — one ephemeral invocation of an endpoint agent on a caller `input`,
 * returning a structured `result` via `submit_result`. Distinct from a worker: NO worktree/branch/merge;
 * it runs in a disposable read-only HEAD snapshot of the project repo and tears down on a terminal state.
 *
 * Durable in SQLite (the `runs` table). `sessionId` is the ephemeral `run` session driving it (1:1; null
 * only in the instant before the session is minted). `keyId` is null in R2 (runs are started internally;
 * R3's keyed REST sets it). `schema` is the caller-supplied JSON Schema `submit_result` validates the
 * answer against (null ⇒ freeform accept). `result`/`usage`/`transcriptRef`/`error` are populated at
 * teardown. See `[[Agent Runs]]`.
 */
export interface AgentRun {
  id: RunId;
  projectId: ProjectId;
  agentId: AgentId;
  /** The ephemeral `run` session driving this run (null only before it's minted). */
  sessionId: SessionId | null;
  /** The API key that triggered the run; null in R2 (internal starter) — R3's keyed REST sets it. */
  keyId: ApiKeyId | null;
  status: RunStatus;
  /** The caller's input, treated as DATA (injection hygiene), injected into the run's startup prompt. */
  input: unknown;
  /** Caller-supplied JSON Schema the answer must match; null ⇒ `submit_result` accepts freeform JSON. */
  schema: unknown | null;
  /** The `submit_result` payload (null until completed). */
  result: unknown | null;
  /**
   * Usage snapshot captured at teardown; null until then. Agent Runs #2 made this CUMULATIVE per-run usage
   * `{ inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, turns, model, costUsd }` (summed
   * across all turns + priced via the per-model table). `inputTokens` is cumulative billed input (NOT the
   * old last-turn occupancy). Degrades to the legacy `{ inputTokens, turns, model }` last-turn snapshot
   * only when the transcript was unreadable at teardown.
   */
  usage: unknown | null;
  /** Pointer to the retained transcript snapshot (path under LOOM_HOME); null until captured at teardown. */
  transcriptRef: string | null;
  /** Terminal error detail for a failed/timed-out run; null otherwise. */
  error: string | null;
  /**
   * Caller-supplied webhook URL POSTed the run summary on a terminal transition (Agent Runs R3); null
   * when the caller didn't pass one. Best-effort + bounded — never blocks/wedges teardown.
   */
  webhookUrl: string | null;
  /**
   * Caller-supplied idempotency key (Agent Runs R3) — a per-key exactly-once dispatch token. A retry
   * with the same `(keyId, idempotencyKey)` returns THIS run (no second start, no double-spend). null
   * when the caller didn't pass one (a unique index covers only the non-null pairs).
   */
  idempotencyKey: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
}

/**
 * A run-scoped audit event kind (Agent Runs follow-up #1). `cap_rejected` is the core, genuinely-invisible
 * case: a 429 at POST /api/runs (concurrency or daily-token cap) creates NO run row, so without an explicit
 * audit record a throttled key leaves no trace anywhere. Run LIFECYCLE (status/timestamps) is already on the
 * `runs` row and is deliberately NOT duplicated here.
 */
export type RunEventKind = "cap_rejected";

/**
 * A **RunEvent** (Agent Runs follow-up #1) — a project-scoped audit record for a run-related event that has
 * NO run row of its own. Distinct from {@link OrchestrationEvent}, which is manager-tree shaped
 * (`managerSessionId` is NOT NULL and its readers are session-keyed); a cap-rejection has no session at all,
 * so it needs this separate store. Durable in SQLite (the `run_events` table). `keyId`/`runId` are nullable
 * (a `cap_rejected` carries the throttled `keyId` but NO `runId` — none was created). `detail` is
 * kind-specific JSON (`cap_rejected`: `{ cap: "concurrency"|"daily_token"|"daily_spend", limit, observed, agentId }`).
 * See `[[Agent Runs]]`.
 */
export interface RunEvent {
  id: string;
  projectId: ProjectId;
  /** The API key the event concerns (a cap-rejection is per-key); null if not key-scoped. */
  keyId: ApiKeyId | null;
  /** The run this event concerns; null for a `cap_rejected` (no run row was ever created). */
  runId: RunId | null;
  kind: RunEventKind;
  /** Kind-specific detail JSON (`cap_rejected`: `{ cap, limit, observed, agentId }`); null when none. */
  detail: Record<string, unknown> | null;
  createdAt: string;
}

/**
 * A worker's in-flight (or just-settled) merge-gate op, surfaced read-only onto its session (card
 * 7b7fa6d — the Board merge-gate hairline; `outcome` added by the d1aee5f1 follow-up). This is the
 * shared-type mirror of the daemon's `PendingOpView` subset that `worker_list` already exposes, projected
 * onto `/api/sessions` from the in-memory PendingOpRegistry (NOT a DB column). Non-null while a
 * `worker_merge_confirm` gate is RUNNING, and for a brief RETENTION window after it settles (see
 * PendingOpRegistry's "RETAINED TERMINAL VIEW" doc) — long enough for the Board to render the terminal
 * fill before the field reverts to null and the card falls back to its normal worker-status row.
 * `state` is the raw op state; it alone CANNOT distinguish a merge SUCCESS from a gate REJECTION (both
 * resolve normally to `"done"` — only a genuine exception settles `"failed"`), which is exactly what
 * `outcome` is for.
 */
export interface PendingMerge {
  /** The PendingOpRegistry op id — lets a viewer correlate this to its `worker_merge_confirm`. */
  opId: string;
  /** Raw op state: "running" while the gate is in flight; "done"/"failed" only during the brief
   *  post-settle retention window (see the interface doc), then the field goes null. */
  state: "running" | "done" | "failed";
  /** ISO instant the gate started — drives the live elapsed (M:SS) timer on the Board card. */
  startedAt: string;
  /** Terminal classification, set only once the op has settled (undefined while `state === "running"`):
   *  "merged" (a successful squash-merge), "rejected" (the gate/stranded-work/empty-stage check resolved
   *  `merged:false` — no exception, the merge was refused), or "failed" (the confirm itself threw). This
   *  is what lets the Board distinguish a rejected merge (amber) from a merged one (phosphor) instead of
   *  both reading as green "merged" via `state === "done"`. */
  outcome?: "merged" | "rejected" | "failed";
}

export interface Session {
  id: SessionId;
  projectId: ProjectId;
  agentId: AgentId;
  /** Claude Code's engine session id, captured via the SessionStart hook. */
  engineSessionId: string | null;
  title: string | null; // auto-derived from the first turn, user-overridable
  cwd: string;          // = project repoPath
  processState: ProcessState;
  resumability: Resumability;
  busy: boolean;        // a turn is currently running
  createdAt: string;
  lastActivity: string;
  lastError: string | null;
  // --- phase-2 orchestration lineage + context counters (additive; null/0 on phase-1 sessions) ---
  role?: SessionRole | null;
  parentSessionId?: string | null;  // the manager that spawned this worker
  taskId?: string | null;           // the board task this worker is working (references tasks)
  worktreePath?: string | null;     // a worker's isolated git worktree cwd
  branch?: string | null;           // the worker's branch
  gen?: number;                     // recycle generation (0 = original)
  recycledFrom?: string | null;     // the prior-generation session id this was recycled from
  ctxInputTokens?: number | null;   // measured engine context occupancy (last-assistant usage)
  ctxTurns?: number | null;
  ctxUpdatedAt?: string | null;
  /** Engine model id from the transcript (e.g. "claude-opus-4-8"); sizes the ctx meters. */
  model?: string | null;
  /**
   * §19c usage-limit park: the ISO instant this session may resume after hitting the Claude
   * usage cap (reset+buffer when known, else a default backoff). null = not rate-limited. The
   * pty is NOT killed on a cap; #19c-b re-submits the pending turn at this time. (lastError
   * carries the human "usage limit — resumes X" string.)
   */
  rateLimitedUntil?: string | null;
  /**
   * §19c-b give-up deadline for the active usage-limit recovery episode — set ONCE at the first
   * cap (reset+30min, else now+6h) and kept across re-caps; null when not recovering. Past it
   * without recovery, the watcher abandons auto-resume and marks the session errored (lastError).
   */
  rateLimitDeadline?: string | null;
  /**
   * Opt-in browser-automation capability, resolved from the session's Profile at spawn and PINNED
   * here (mirrors `role`): a per-session stdio Playwright MCP is injected iff this is true. Persisted
   * so EVERY respawn path (resume / fork / recycle) carries the capability forward unchanged — a
   * resumed browser-worker keeps its browser, exactly as role is re-passed. Absent/false on every
   * existing session ⇒ no Playwright MCP, byte-identical spawn.
   */
  browserTesting?: boolean;
  /**
   * Opt-in document-conversion capability, resolved from the session's Profile at spawn and PINNED
   * here (mirrors `browserTesting`): a per-session stdio markitdown MCP is injected iff this is true.
   * Persisted so EVERY respawn path (resume / fork / recycle) carries the capability forward unchanged.
   * Absent/false on every existing session ⇒ no markitdown MCP, byte-identical spawn.
   */
  documentConversion?: boolean;
  /**
   * Restricted-tools capability, resolved from the session's Profile at spawn and PINNED here (mirrors
   * `browserTesting`): when true, the curated dangerous NATIVE tools (Bash/Edit/Write/NotebookEdit/
   * MultiEdit) are appended to this session's `--disallowedTools`. Persisted so EVERY respawn path
   * (resume / fork / recycle / boot) re-applies the restriction — a resumed Companion keeps its locked-down
   * tool surface, exactly as role is re-passed. Absent/false on every existing session ⇒ no restriction,
   * byte-identical spawn.
   */
  restrictedTools?: boolean;
  /**
   * Declared no-commit role, resolved from the session's Profile at spawn and PINNED here (mirrors
   * `browserTesting`): when true, this is a READ-ONLY / no-commit worker. Confers NO spawn-time
   * capability — it is read by the worker_report lifecycle: a 0-commit done auto-retires the session
   * (freeing the concurrency slot) and suppresses the "forgot to commit" warning. Persisted so every
   * respawn path (resume/fork/recycle) carries it. Absent/false on every existing session ⇒ today's
   * behavior (a 0-commit done warns + is not auto-retired).
   */
  noCommit?: boolean;
  /**
   * Profile-resolved skill-name SUBSET to deliver to this session, PINNED here at fresh spawn (mirrors
   * `role`/`browserTesting`): `injectSkills` mirrors ONLY these skills into the session's `.claude/skills`.
   * `null`/absent ⇒ deliver ALL store skills (today's behavior — the regression-guarded default). Pinned
   * (not re-resolved) so EVERY respawn path (resume / fork / recycle / boot) honors the same subset — a
   * profile re-resolution at resume time would be wrong (the profile may have changed). An empty array is
   * normalized to null at the pin sites (no profile subset ⇒ all).
   */
  skills?: string[] | null;
  /**
   * Profile-resolved authenticated-egress connection-id list, PINNED here at fresh spawn (mirrors
   * `browserTesting`, NOT `skills`): the `authenticated_request` tool (loom-tasks MCP) may only be used
   * with a connection id in this list, and is OMITTED from tools/list entirely when this is empty/absent.
   * Absent/empty on every existing session ⇒ no access, byte-identical to today (the secure-default
   * direction — unlike `skills`, empty here does NOT mean "all connections"). Persisted so every respawn
   * path (resume/fork/recycle) carries the same grant forward unchanged; a connection later revoked at
   * the P1 store still fails closed at call time regardless of this pin (getConnectionMetadata/
   * getSecretForUse return undefined for a deleted connection).
   */
  connections?: string[];
  /**
   * Opt-in confined vault-write grant, resolved from the session's Profile at spawn and PINNED here
   * (mirrors `connections`, NOT `browserTesting`): the `vault_write` tool (loom-tasks MCP) is OMITTED
   * from tools/list entirely unless this is true, and is only ever read by the MCP layer at CALL time —
   * like `connections`, never threaded into the spawn recipe (no host process, no `--allowedTools`
   * change). Absent/false on every existing session ⇒ no `vault_write`, byte-identical spawn. Persisted
   * so every respawn path (resume/fork/recycle) carries the same grant forward unchanged.
   */
  vaultWrite?: boolean;
  /**
   * Opt-in Companion "lead mode" (Option B, no guardrails): when true, this companion's
   * `resolveCompanionGrant` reads (companion/capabilities.ts) short-circuit to a SYNTHESIZED full
   * act-scope over EVERY live project (`listAllProjects()`, computed LIVE — a project created after
   * enabling is included on the very next read), superseding this session's own
   * `companion_capability_grants` rows without deleting or mutating them — toggling this back off
   * instantly reverts to those untouched rows. Mirrors `vaultWrite`, NOT `browserTesting`: read LIVE off
   * this row on every `resolveCompanionGrant` call (never threaded into `pty.spawn`, no respawn needed
   * for a toggle to take effect). HUMAN-only REST (`PUT /api/companion/:sessionId/lead-mode`) — like
   * every other companion capability control, there is NO agent MCP write path (an injection-exposed
   * Companion must never widen its own scope). Absent/false on every existing session ⇒ today's
   * per-capability-grant behavior, byte-identical.
   */
  companionLeadMode?: boolean;
  /**
   * Agent-tooling P4: registry-capability grants resolved from the session's Profile at spawn and PINNED
   * here (mirrors `browserTesting`, spawn-time not tool-call-time — UNLIKE `connections`, which is only
   * ever read by the MCP layer at call time and never threaded into the spawn recipe): each enabled
   * capability's MCP server is mounted at spawn per this list. Persisted so EVERY respawn path (resume /
   * fork / recycle) carries the same grants forward unchanged. Absent/empty on every existing session ⇒
   * no registry-capability MCP beyond whatever `browserTesting`/`documentConversion` already mount —
   * byte-identical spawn.
   */
  capabilities?: CapabilityGrant[];
  /**
   * Per-project session Archive: the ISO instant a session was archived (moving a stopped session out
   * of the Workspace rail). null = not archived (every live/normal session). Archived sessions are
   * EXCLUDED from the rail/god-eye lists and surface only in the Archive tab. Mirrors the project
   * soft-archive pattern (`Project.archivedAt`). Set AUTOMATICALLY when a session's pty EXITS
   * (auto-archive-on-exit, index.ts onExit; role==='run' excluded) and cleared on resume(). Per-session,
   * NO cascade — each worker auto-archives independently as it exits (a manager can be archived while a
   * worker is still live).
   */
  archivedAt?: string | null;
  /**
   * A worker's in-flight (or just-settled) merge-gate op (see {@link PendingMerge}). Projected onto
   * `/api/sessions` from the in-memory PendingOpRegistry — non-null while a `worker_merge_confirm` gate
   * is RUNNING, and briefly afterward while the settled op is RETAINED for the Board's benefit; absent/
   * null on every other session, and null again once the retention window lapses (byte-identical to
   * before this existed for a non-merging session). Read-only, never consumed. Drives the Board card's
   * bottom-edge sweep/fill meter + live timer.
   */
  pendingMerge?: PendingMerge | null;
  /**
   * Spawn-origin marker, PINNED at spawn: true iff this manager was booted BY THE CRON SCHEDULER
   * (`Scheduler.tick()` → `startManager(agentId, prompt, {scheduled:true})`), false/absent for every
   * other manager spawn (REST "start manager", a profile-derived generic spawn, the Platform Lead's
   * `session_spawn`). Exists so the Scheduler's own manager-cap budget (`Db.countLiveScheduledManagers`)
   * counts ONLY scheduler-spawned managers, never the standing human/Lead-spawned fleet — mirrors the
   * auditor budget's role-based split, but managers can't be split by role alone (a Lead-spawned manager
   * and a scheduler-spawned one share `role:"manager"`), so this flag is the manager-side equivalent.
   * Carried forward by `recycleManager` (`old.scheduledSpawn ?? false`) so a scheduler-spawned manager
   * can't dodge its own budget by self-recycling. Absent/false on every existing session ⇒ byte-identical
   * spawn (only the Scheduler's own wiring ever sets it true).
   */
  scheduledSpawn?: boolean;
}

/**
 * Routing outcome for an UPWARD report/escalation (worker_report → manager, platform_escalate → Lead).
 * Replaces the old boolean `delivered`, which couldn't tell a durable queue from a genuine drop (the
 * `{delivered:false}` ambiguity — board card fc9a27d5). The caller reads this to know whether to relax
 * (it's durably routed) or act (it was dropped):
 *   • `delivered-live` — a LIVE, idle parent received it as a turn NOW (it's already engaged).
 *   • `queued`         — a LIVE-but-busy/parked parent has it HELD in its FIFO; it drains on the parent's
 *                        next turn boundary (durable for the life of the process; re-driven on restart).
 *   • `boarded`        — no live session to take it, but it is DURABLY PERSISTED (platform_escalate always
 *                        files a board task; a worker_report records its event + a wake trigger so the
 *                        crash-recovery watcher auto-resumes the parent). Surfaces later, never lost.
 *   • `dropped`        — a genuine failure to route: there was no target to reach AND nothing durable will
 *                        surface it (e.g. a parentless worker report). The ONLY value that warrants alarm.
 */
export type DeliveryStatus = "delivered-live" | "queued" | "boarded" | "dropped";

/** Append-only orchestration audit record (the manager↔worker timeline). */
export type OrchestrationEventKind =
  | "spawn_worker" | "message_worker" | "worker_report" | "stop_worker"
  // Manager→worker REDIRECT (orchestration `worker_redirect`): the "land it NOW" escalation — END the
  // worker's CURRENT turn (a single Esc cancel) + flush/SUPERSEDE its queued direction + deliver ONE
  // authoritative instruction as the next turn. Parent-scoped exactly like message_worker/stop_worker.
  // Filed under the owning MANAGER (workerSessionId = the steered worker); `detail` carries whether the
  // redirect delivered live or queued. The flushed durable messages resolve as session_message_delivered
  // with reason "superseded" (so the done-guard + boot-recovery never re-drive them).
  | "redirect_worker"
  | "recycle_begin" | "recycle_complete" | "merge_request" | "merge_done"
  | "merge_rejected" | "build_gate" | "kill_switch" | "schedule_fired"
  // Merge-gate TRANSIENT-KILL auto-retry (card bcba83a1): `build_gate` failed with a retry-eligible
  // classification (an OOM/SIGKILL, or the daemon's own gateTimeoutMs bound) — `build_gate_retry_attempt`
  // marks that the one auto-retry is about to run (`detail.priorClass`), `build_gate_retry` records its
  // outcome (`detail.passed`). A genuine non-zero exit never fires either — see classifyGateFailure.
  | "build_gate_retry_attempt" | "build_gate_retry"
  // A scheduled fire FAILED to spawn (startManager/startAuditor threw). The durable mirror of
  // `schedule_fired`: without it a spawn failure ONLY hit stderr, so a cadence could silently never run
  // with no surfaced reason. Filed under the SCHEDULE id (managerSessionId = the schedule — no session was
  // spawned to key it to); `detail` carries { scheduleId, cron, kind, error }. The slot is already claimed
  // (claim-before-spawn), so this never re-fires; the schedule stays enabled (a transient spawn failure
  // must not permanently disable a cadence — only the deleted-agent case disables).
  | "schedule_fire_failed"
  // A due fire was HELD BACK by a budget gate (manager cap / auditor budget) rather than fired (board
  // card 53edd8d5 — the manager-cap starvation fix). Filed under the SCHEDULE id like
  // `schedule_fire_failed` (managerSessionId = "", no session was spawned); `detail` carries {scheduleId,
  // cron, kind, reason}. Emitted ONLY on a TRANSITION into deferred (first defer, or the reason changing)
  // — never once per tick for a schedule that stays blocked for the SAME reason, which would flood the
  // event log for a schedule starved for hours. The schedule row's own `lastDeferredAt`/
  // `lastDeferredReason` (Db.markDeferred) are the queryable CURRENT-state mirror of this event; both
  // clear on the schedule's next successful fire (Db.markFired). The slot is NOT claimed (unlike a
  // failed spawn) — a deferred schedule stays due and is retried next tick like the pause/usage-limit gates.
  | "schedule_fire_deferred"
  // worker_report(done) PRE-CHECK refusal (board cards 907b9f50, dcb25bd9, 50162e6b): a worker reported
  // done but was refused at the source — `detail.reason` discriminates: "uncommitted" (UNCOMMITTED work
  // in its worktree, + the named files) or "pending-direction" (UNRESOLVED manager direction still
  // queued, + `queued` count, `msgIds` of the still-unresolved queued messages, and `repeat` — whether
  // this is the SAME unconsumed set already named in the worker's last rejection for this task, vs a
  // fresh one). Either way the task is kept in_progress (not moved to review). Composes with the
  // divergent-branch merge_rejected.
  | "worker_report_rejected"
  | "wake_scheduled" | "wake_fired" | "wake_dropped" | "idle_report" | "idle_escalated"
  // Context-recycle ESCALATION (ContextWatcher): a context-heavy manager (over `recycleAtContextRatio`)
  // slept through `maxUnansweredRecycleNudges` consecutive recycle nudges without handing off → the
  // watcher escalates to the human instead of nudging into the void. The context twin of `idle_escalated`:
  // the human-facing signal attention.ts derives an alert from (there is no daemon-side notification).
  // Filed under the MANAGER (managerSessionId = m.id); `detail` carries { reason, unanswered, pct }.
  // Emitted EXACTLY ONCE per session — the manager's nudge policy flips 'watching'→'escalated', which the
  // policy gate skips on the next tick; a recycled successor is a fresh row, so it re-arms naturally.
  | "context_escalated"
  // Busy-worker long-turn advisory (BusyWorkerWatcher): a LIVE worker has been `busy` in a single
  // uninterrupted turn past the `stuckWorkerMinutes` window. Filed under the OWNING MANAGER
  // (managerSessionId) with workerSessionId/taskId set; `detail` carries minutesBusy + reason. A SOFT,
  // informational signal (likely a long build/test gate) — not a hang detector, never a hard kill; the
  // manager decides whether to check on it. Emitted ONCE per episode (re-arms when the worker makes
  // progress, i.e. lastActivity advances).
  | "worker_stuck"
  // A manager self-service management action (assign profile / update agent / update or archive a
  // project / create or update a schedule). `detail.action` discriminates; audit trail for the
  // trust-boundary surface (managers ASSIGN existing capability sets + edit structure, never MINT).
  | "manager_manage"
  // Platform Lead cross-project message delivery (loom-platform `session_message`) — UN-scoped, above
  // the manager/worker tree. `workerSessionId` carries the TARGET session id (delivery only, never spawn).
  | "session_message"
  // Manager→Platform UPWARD escalation (orchestration `platform_escalate`): a discovered Loom bug/friction
  // filed as a durable TASK on the reserved Platform board (the Lead's inbox). `detail` carries the origin
  // project, severity, and the created Platform task id. The ONLY cross-project write a manager may make
  // to the reserved Platform home — see `cross_project_message` below for the LINKED-peer-project channel.
  | "platform_escalate"
  // Manager↔manager cross-project message (orchestration `peer_message`, board card 2349d90c) — a manager
  // messaging a LINKED peer project's LIVE MANAGER (never a worker/platform/auditor session). `detail`
  // carries { originProjectId, targetProjectId, targetSessionId, deliveryStatus }; managerSessionId is the
  // SENDING manager, workerSessionId (reused as the generic "other session" column) is the target manager
  // session when one was live, else empty. Gated server-side on `project_links` (owner-declared, human-only
  // — no MCP path can create a link) — a manager can reach ONLY a project the owner has explicitly linked.
  | "cross_project_message"
  // Platform Auditor finding (loom-audit `audit_file_finding`, P5): a transcript-review finding filed as a
  // durable TASK on the reserved Platform board. `detail` carries the severity, title, and Platform task id.
  // The ONLY write the read-and-file-only Auditor can make (it has no git/vault/config/spawn capability).
  | "audit_finding"
  // End-user Auditor improvement suggestion (loom-user-audit `audit_suggest_improvement`, End-User Platform
  // tier B3): the de-privileged twin of `audit_finding` — a transcript-review SUGGESTION filed as a durable
  // TASK on the USER'S OWN "Getting Started" home inbox (never the dev Platform board). `detail` carries the
  // severity, title, and the user-home task id. One of the workspace-auditor's two inert daemon-local writes.
  | "workspace_audit_suggestion"
  // ── Crash-recovery watchdog (CrashRecoveryWatcher) ─────────────────────────────────────────────
  // A resumable session's pty process died UNEXPECTEDLY while the daemon stayed healthy — i.e. NOT via
  // pty.stop() (graceful/idle/user-stop/recycle/merge-stop) and NOT a whole-daemon restart/crash (those
  // tear down the process, so no JS onExit runs → no event). Recorded at onExit time iff `intended===false`
  // (= the pty's `stopping` flag was unset). This is the DURABLE trigger the watchdog acts on; filed with
  // workerSessionId = the dead session (managerSessionId = its parent for a worker, else its own id).
  | "session_died"
  // A bounded crash-recovery auto-resume attempt. `detail` carries the 1-based attempt number + ok/error.
  // The PERSISTED counter (count of these since the last `session_recovered`) is what bounds the loop —
  // it survives a daemon restart (mirrors busy-worker's once-per-episode mark via the events table).
  | "session_resume_attempt"
  // A crash-recovered session has stayed stably LIVE long enough after a resume → the episode is closed and
  // the attempt counter RESETS (the next death starts fresh). The high-water reset marker for the counter.
  | "session_recovered"
  // CRASH-LOOP SAFETY: after N (crashRecoveryMaxAttempts) re-deaths the watchdog STOPS auto-resuming and
  // escalates LOUDLY instead of looping forever. Filed ONCE per episode; ALSO stamped on the session's
  // lastError so Mission Control surfaces it role-agnostically (a dead manager has no parent to nudge).
  | "session_recovery_abandoned"
  // STRAND BACKSTOP (incident 22a44352): a worker called worker_report while its parent manager had already
  // EXITED (idle-reaped after dispatching its last worker), so the framed report reached NOBODY
  // (`delivered:false`) and the completed branch sat unmerged. This is the durable wake trigger — the SECOND
  // trigger the CrashRecoveryWatcher acts on, keyed on `delivered:false` rather than process-death: it
  // bounded-auto-resumes the exited manager (same attempt-cap/escalation machinery as `session_died`) so it
  // consumes the report and runs review→gate→merge. Filed under the MANAGER (workerSessionId = its id, so
  // listEventsForWorker retrieves it; managerSessionId = its parent or its own id); `detail` carries the
  // reporting worker + task. Recorded by recordUndeliveredReport ONLY when the manager is exited (a
  // live-but-busy manager's queue drains on its next turn — not a strand) and not usage-limit parked.
  | "worker_report_undelivered"
  // EXITED-WITHOUT-REPORT (board card 84151b99): a worker's pty exited UNEXPECTEDLY (intended===false —
  // not a manager-issued worker_stop/recycle/merge) while its task was STILL in_progress, i.e. it never
  // called worker_report at all. The idle nudge (notifyManagerOfIdleWorker) only fires on a busy→false
  // EDGE, but a fast/first worker can exit before that edge ever lands (a pty exit routes through onExit,
  // NOT the onBusy callback) → the manager would see a silent idle (or nothing) and have to self-rescue via
  // worker_transcript. This is the DISTINCT, DURABLE signal that the worker is GONE and will never report:
  // filed under the MANAGER (managerSessionId = the parent, workerSessionId = the dead worker), `detail`
  // carries the worker's branch. Recorded by notifyManagerOfExitedWorker from the onExit hook; paired with
  // a [loom:worker-exited] nudge enqueued to the (live) manager. Sibling of `worker_report_undelivered`
  // (report reached nobody) — this is "no report at all".
  | "worker_exited_without_report"
  // ORPHANED-FLEET STRAND BACKSTOP (card 6cd3ce9e): a manager/platform session EXITED (any cause —
  // a deliberate stop, an interrupt, an unexpected death) while it still owned ≥1 LIVE worker/child
  // session. Auto-archive-on-exit (index.ts onExit) would otherwise silently move it to Archive —
  // off every rail/god's-eye list (listSessions/listWorkers exclude archived rows) — leaving those
  // workers live+busy with NO live parent to review/merge/stop them, invisible until a human happens
  // to notice. This is the durable alert SessionService.archiveOnExit files INSTEAD of archiving in
  // that case (the row stays on the live rail, exited-but-unarchived — still resumable, still
  // visible); `detail` carries { count, workerIds }. The synchronous, already-dead-pty twin of
  // end_me's "live-workers" REFUSAL gate (which blocks a VOLUNTARY self-stop up front) — here the
  // pty is already gone, so there's nothing left to refuse; only the row's visibility can be saved.
  | "manager_exited_with_live_workers"
  // DURABLE QUEUED-MESSAGE INBOX (card 2ca18433): a down/cross-tree message (message_worker /
  // session_message) that could NOT be delivered as a turn at send time — the recipient was busy, so it
  // was HELD in the recipient's in-memory FIFO (`delivered:false`). That FIFO dies with the process, so a
  // sender death or a daemon restart before the recipient's next turn boundary would SILENTLY DROP it
  // (it lost a P1 dispatch twice). This event PERSISTS the held message so it survives both: filed under
  // workerSessionId = the RECIPIENT (managerSessionId = the SENDER), `detail` carries { msgId, text,
  // sender }. Recorded by SessionService's messaging helpers ONLY on the queued (delivered:false) path —
  // an immediately-delivered message is already a live turn and needs no persistence. The boot scan
  // (recoverUndeliveredMessagesOnBoot) re-enqueues every still-unresolved one onto its resumed recipient
  // and surfaces stuck outbound ones to the resumed sender. PAIRED with its resolution marker below.
  | "session_message_queued"
  // The resolution half of `session_message_queued`: the held message was finally HANDED to the recipient
  // — drained as a turn at its next Stop, or consumed via inbox_pull. `detail.msgId` matches the queued
  // event; a queued event with NO matching delivered event is "still undelivered" (the boot scan's work
  // set). Also filed by the boot scan to RETIRE a queued event whose recipient is gone/superseded (carried
  // forward by recycle, or unrecoverable) so the undelivered set can't grow without bound (detail.reason).
  | "session_message_delivered"
  // ── Companion proactive heartbeat (CompanionHeartbeatWatcher, card 9488951e) ───────────────────────
  // A daemon-driven proactive turn was injected into the long-lived companion session: the watcher's
  // cadence came due and the session was LIVE + not rate-limit-parked, so a framed `[loom:heartbeat]`
  // turn was enqueued. Filed under the companion session (managerSessionId = the companion sessionId);
  // `detail` carries { intervalMinutes }. DEFAULT-OFF (no watcher armed unless a cadence is configured).
  | "companion_heartbeat_fired"
  // The heartbeat was DUE but SUPPRESSED rather than fired — `detail.reason` discriminates: "rate-limited"
  // (the session is parked on the usage cap → defer to the reset, never spam) or "pending" (a prior
  // heartbeat is still queued/unconsumed → don't stack a second). No turn is enqueued; the cadence retries
  // next due. The proactive twin of the wake-defer discipline; filed under the companion session.
  | "companion_heartbeat_deferred"
  // ── Companion RECURRING reminders (CompanionReminderWatcher, Companion Memory & Reminders Design
  // Surface 2 s3) ── the N-reminder generalization of companion_heartbeat_fired/deferred: a named cron
  // reminder came due and fired a framed `[loom:reminder]` turn (carrying its own route, or none) into
  // the companion session. `detail` carries { reminderId, cron, label }. Filed under the companion
  // session (managerSessionId = sessionId); also the RESTART-SEED source (seedLastFired reads the most
  // recent one per reminderId so a daemon restart never double-fires).
  | "companion_reminder_fired"
  // The twin of companion_heartbeat_deferred, per-reminder: a due reminder was SUPPRESSED rather than
  // fired — `detail.reason` is "rate-limited" or "pending" (a prior turn for the SAME reminder id is
  // still queued/unconsumed). `detail.reminderId` discriminates which reminder deferred. Emitted at most
  // once per defer streak per reminder (bounded log growth, mirroring the heartbeat).
  | "companion_reminder_deferred"
  // Manager-driven ABSOLUTE permission-mode override (orchestration `worker_set_mode`, card 610abe29) —
  // the manual belt-and-suspenders recovery affordance above the spawn/resume auto-convergence
  // (cycleToMode) and the plan auto-heal (logLandedMode): a worker can never change its own mode
  // (Shift+Tab is a human TUI keystroke; ExitPlanMode/EnterPlanMode are disallowed for a worker), so a
  // manager drives it directly. Parent-scoped exactly like message_worker/stop_worker. `detail` carries
  // { target, landed } — the requested mode and the feedback-VERIFIED mode the cycle actually settled on
  // (may differ from target if the cycle gave up early). Filed under the owning MANAGER.
  | "set_worker_mode"
  // ── Poll-job triggers (agent-tooling epic P3, PollService) ─────────────────────────────────────────
  // A poll job's fetch surfaced item(s) not present in the previous poll's snapshot, and they were
  // delivered as a (wake or spawn) kickoff. Filed under the TRIGGERED session (managerSessionId — the
  // woken session, or the freshly-spawned one); `detail` carries { pollJobId, itemCount, mode }.
  | "poll_fired"
  // A poll's fetch (through the P2 authenticated_request path) THREW — network/auth/rate-limit/timeout.
  // The durable mirror of `schedule_fire_failed`: session-LESS (no session exists to key it to, or the
  // existing one wasn't touched), filed with managerSessionId = "" ; `detail` carries { pollJobId, error,
  // consecutiveFailures }. Never disables the job (a transient failure must not kill a cadence) — backoff
  // instead (next_poll_at pushed out); only a deleted connection disables it.
  | "poll_fire_failed"
  // The FIRST successful poll of a job (cursorJson was null) — seeds the baseline item-id snapshot and
  // deliberately fires NOTHING (a fresh poll job must never replay the whole existing backlog as "new").
  // Session-less like poll_fire_failed; `detail` carries { pollJobId, itemCount }.
  | "poll_baseline_seeded"
  // MISCONFIG GUARD: `idPath` yielded no extractable id for a large fraction of this poll's items (a bad
  // path, or a feed whose items don't carry that field). Firing anyway would re-fire the SAME items every
  // tick forever (no id ⇒ no stable diff). This event marks the poll as SKIPPED (not advanced past
  // baseline) so the misconfiguration is visible instead of silently spamming; `detail` carries
  // { pollJobId, itemCount, withIdCount }. Session-less.
  | "poll_id_guard_tripped"
  // ── Event triggers (Loom Event Triggers subsystem, card f5d07121 — T2, EventTriggerService) ─────────
  // A trigger's watermark scan over `orchestration_events` matched its configured `eventKind` (+ optional
  // `projectId` scope) and the anti-hammer floor allowed it to actually deliver — a wake or spawn fired.
  // Filed under the TRIGGERED session (managerSessionId — the woken session, or the freshly-spawned one);
  // `detail` carries { eventTriggerId, matchedCount, mode }. Mirrors `poll_fired`.
  | "event_trigger_fired"
  // A trigger found matching event(s) this tick but its per-trigger `MIN_EVENT_TRIGGER_INTERVAL_MS` floor
  // (anti-hammer / anti-loop — several allowlisted kinds are self-retriggerable, e.g. a `spawn` on
  // `worker_report` produces a worker that itself emits `worker_report`) had not yet elapsed since
  // `lastFiredAt`. The matched event(s) are consumed (the watermark still advances) WITHOUT firing —
  // deliberately dropped, not queued, so a sustained burst can never build an unbounded backlog to release
  // all at once. Session-less (managerSessionId = ""); `detail` carries { eventTriggerId, matchedCount }.
  | "event_trigger_throttled"
  // ── Self-stop (agent MCP `end_me`, card 3b015fc7) — the no-successor sibling of recycle_me ──────────
  // A self-scoped session called end_me but one of its two safety gates tripped, so Loom REFUSED (did
  // NOT stop it). `detail.reason` discriminates: "queued-inbound" (unconsumed AGENT-kind direction still
  // queued — `detail.pending` is the count) or "live-workers" (a manager/Lead caller with ≥1 live worker/
  // child session — `detail.count` is the count). Filed under the CALLER (managerSessionId = its own id).
  | "end_me_refused"
  // end_me's two gates were both clear: the caller's own session was graceful-stopped (Ctrl-C×2, resumable,
  // no successor). Filed under the CALLER (managerSessionId = its own id) BEFORE the deferred pty.stop.
  | "end_me_complete"
  // ── attention-push signal-source prereqs (Companion attention-push lever, Lead fork 2b) ─────────────
  // A manager asked the human a decision (mcp/orchestration.ts `question_ask`, at its `db.insertQuestion`
  // chokepoint) — the durable, event-emit twin of the question row itself, so a tail-poll watcher (unlike
  // the alert-webhook's single-slot `Db.setEventListener`) can subscribe to "a decision is now pending"
  // without re-deriving it from `listOpenQuestions`. Filed under the ASKING MANAGER (managerSessionId);
  // `detail` carries { questionId, title }.
  | "question_asked"
  // A `held` card was CLEARED (card 9b0373c0, Platform-Audit bb23d15a) — the un-brake audit trail. Emitted
  // from the ONE agent-facing choke point (`updateProjectTask`, mcp/tasks.ts — shared by `tasks_update` AND
  // the Lead's cross-project `project_task_update`) on an agent clearing its OWN agent-set hold (a
  // human-set hold is refused there, never reaches this event), and from the separate human-only REST route
  // (`POST /api/tasks/:id`) on a human clear via the UI. `detail` carries { clearedBy: "human" | "agent",
  // previousHeldBy: "human" | "agent" | null }. Filed under the ACTING session (managerSessionId = its id,
  // whatever role) when one exists, else "" (mirrors `schedule_fire_deferred`'s "no session was spawned"
  // convention) — the human REST route has no session at all.
  | "task_held_cleared"
  // A session's usage-limit PARK was just stamped (index.ts's `onRateLimited` hook, alongside the existing
  // `db.setRateLimitedUntil`/`armRateLimitDeadline` writes) — the event-emit twin of the rate-limit park,
  // for the same tail-poll reason as `question_asked` above (a global `rateLimitedUntil` column change has
  // no event of its own today). Filed under the PARKED session (managerSessionId = its id, worker or
  // manager); `detail` carries { until, deadline } (the resume-at ISO timestamp and the episode give-up
  // deadline, mirroring the two values the session row itself just received).
  | "session_rate_limited"
  // ── Companion attention-push (daemon-owned per-companion watcher — NOT a capability-registry lever;
  // see companion/attention-push.ts) — the push twin of companion_reminder_fired/companion_heartbeat_fired:
  // a subscribed fleet signal (see attention-push.ts's classify()) was pushed to the companion as a framed
  // `[loom:alert]` turn (immediate mode: one per source event; digest mode: one bundled turn covering many
  // sources, but still one `companion_alert_pushed` row PER underlying source event — see its doc). Filed
  // under the companion session (managerSessionId = sessionId); `detail` carries { sourceSeq, alertClass,
  // sourceKind } — sourceSeq is the source event's `orchestration_events.seq` (a never-reused monotonic
  // column, NOT sqlite's own reusable rowid — see db.ts's SCHEMA doc), and is ALSO the watcher's own
  // restart-reseed anchor (seedWatermark reads the max sourceSeq across a session's own
  // companion_alert_pushed events), mirroring companion_reminder_fired's seedLastFired role.
  | "companion_alert_pushed"
  // The push twin of companion_heartbeat_deferred/companion_reminder_deferred: a tick found the companion
  // rate-limit-parked or already carrying an unconsumed `[loom:alert]` turn, so nothing was pushed this
  // tick (the tail-poll watermark does NOT advance — the next non-deferred tick re-scans from the same
  // point). `detail.reason` is "rate-limited" or "pending". Emitted at most once per defer streak (bounded
  // log growth, mirroring the sibling watchers).
  | "companion_alert_deferred"
  // Scoped per-project DEPLOY (orchestration `deploy`, design [[Scoped Per-Project Deploy — Design]]
  // 13235b62): a manager ran its OWN project's HUMAN-configured `orchestration.deployCommand` (the
  // owner's opt-in-once trust decision — no per-deploy confirm). Filed under the CALLING MANAGER
  // (managerSessionId = its own id); `detail` carries { reason, ok, exitCode, signal, timedOut,
  // outputTail } — the manager-supplied reason plus the run outcome (a bounded stdout+stderr tail, same
  // shape as the build/DoD gate's own diagnostic capture). The audit trail for this trust-boundary
  // surface; never fired for a refused (unconfigured / rate-limited) attempt, which returns an error
  // with no host exec and thus nothing to audit.
  | "deploy"
  // Worker self-gate (orchestration `run_gate`, card 7f96aa09 — structural fix B for d5c5ccdf): a worker
  // ran its OWN project's `gateCommand` pre-merge, daemon-mediated and bound by the SAME `GateSemaphore`
  // cap as the merge/deploy gates (instead of an unbounded raw-Bash self-check). Filed under the CALLING
  // WORKER itself (managerSessionId = its own id — there is no separate manager owner for a self-scoped
  // op); `detail` carries { passed }.
  | "worker_gate";

export interface OrchestrationEvent {
  id: string;
  ts: string;
  managerSessionId: string;
  workerSessionId?: string | null;
  taskId?: string | null;
  kind: OrchestrationEventKind;
  detail?: Record<string, unknown>;
}

/** A session enriched with its project/agent names — for the global Live Terminals grid. */
export interface SessionListItem extends Session {
  projectName: string;
  agentName: string;
}

/**
 * An archived session row for the per-project Archive tab — a SessionListItem plus whether a
 * transcript SNAPSHOT was captured on exit (false ⇒ "no transcript captured" — the session was
 * already dead when archived, so its engine JSONL was gone before a snapshot could be taken).
 */
export interface ArchivedSessionListItem extends SessionListItem {
  snapshotExists: boolean;
}

/** A bounded page of archived sessions (both the per-project and cross-project list routes) plus the
 *  TOTAL row count — so a "N of total" / "Load more" list UI can size itself without ever fetching the
 *  full archived set (previously unpaginated: 2137 rows / 2.4MB measured on the live instance). `limit`
 *  is the EFFECTIVE (server-clamped) page size actually used — a caller that requested more than the
 *  server's hard cap must read this back rather than assume its requested limit was honored verbatim,
 *  or a "load more until done" loop can silently dead-end at the cap forever. */
export interface ArchivedSessionsPage {
  items: ArchivedSessionListItem[];
  total: number;
  limit: number;
}

/** One schedule-fire history entry — a durable `orchestration_events` row of kind `schedule_fired` /
 *  `schedule_fire_deferred` / `schedule_fire_failed`, enriched server-side (a single LEFT JOIN over
 *  schedules → agents → projects, NOT a per-row lookup) with the schedule's name and its target agent's
 *  "Project / Agent" label. The enrichment fields are `null` when the schedule (or its agent) was deleted
 *  after the fire — the durable event outlives the schedule row, so history stays truthful about what ran.
 *  There is deliberately no `skipped` outcome and no duration: a paused/usage-limited tick records nothing,
 *  and a fire persists only its start (no end is tracked). */
export interface ScheduleHistoryEntry {
  id: string; // orchestration_events.id
  ts: string; // fired-at, ISO
  kind: "schedule_fired" | "schedule_fire_deferred" | "schedule_fire_failed";
  scheduleId: string;
  scheduleName: string | null; // null if the schedule row was deleted after this fire
  cron: string;
  agentLabel: string | null; // "Project / Agent"; null if the schedule/agent was deleted
  sessionId: string | null; // the spawned manager/auditor session (fired only) — links to /sessions/:id
  reason: string | null; // deferral reason (deferred only), e.g. "manager cap (3) reached"
  error: string | null; // spawn error message (failed only)
}

/** A bounded page of schedule-fire history + the TOTAL (for a "N of total / Load more" UI), newest fire
 *  first. `limit` is the EFFECTIVE server-clamped page size actually used — read it back rather than
 *  assume the requested limit held, or a "load more until done" loop can dead-end at the clamp forever
 *  while `total` keeps claiming more rows exist (same contract as {@link ArchivedSessionsPage}). */
export interface ScheduleHistoryPage {
  items: ScheduleHistoryEntry[];
  total: number;
  limit: number;
}

/**
 * The Gates page (card a1c86452) — a god-eye view of Loom's daemon-executed gates across all projects.
 * Three kinds share ONE daemon-global GateSemaphore (`orchestration.maxConcurrentGates`): a `merge`
 * gate (`confirmWorkerMerge`), a `deploy` gate (`deployOwnProject`), and a `worker` self-check (the
 * `run_gate` tool). These types back the two read-only endpoints the page consumes.
 */
export type GateType = "merge" | "deploy" | "worker";

/** One in-flight gate run in the ACTIVE snapshot — either holding a lane (`running`) or waiting for one
 *  (`queued`). Enriched (server-side) from the live GateSemaphore registry with project/worker/priority. */
export interface GateRun {
  id: string;
  gateType: GateType;
  phase: "running" | "queued";
  projectId: string;
  projectName: string;
  /** The SUBJECT session: the worker for a merge/worker gate, the manager for a deploy. */
  sessionId: string;
  taskId: string | null;
  branch: string | null;
  /** Human label — "<agent> · <short task title>" when resolvable, else null. */
  workerLabel: string | null;
  priority: TaskPriority | null;
  /** ISO anchor for the UI's live elapsed clock: admission time (running) or enqueue time (queued). */
  since: string;
  /** 1-based queue position (running entries: null). */
  queuePosition: number | null;
}

/** The active-gates payload: the semaphore's live occupancy + the per-run detail. `cap` is the resolved
 *  daemon-global `maxConcurrentGates` (default 1) — the number of lanes. */
export interface GatesActive {
  cap: number;
  activeCount: number;
  queuedCount: number;
  gates: GateRun[];
}

/** How a settled gate run ended, derived from its orchestration_event detail. */
export type GateOutcome = "pass" | "reject" | "timeout" | "kill";

/** One settled gate run in the HISTORY table — reconstructed from a gate-related orchestration_event
 *  (`worker_gate` / `build_gate` / `deploy`), enriched via a JOIN to the keyed session's project/task. */
export interface GateHistoryRow {
  id: string;
  gateType: GateType;
  outcome: GateOutcome;
  projectId: string | null;
  projectName: string | null;
  sessionId: string | null;
  taskId: string | null;
  branch: string | null;
  workerLabel: string | null;
  /** Real run time (settle − admission) — null for rows recorded before durationMs was stamped. */
  durationMs: number | null;
  /** ISO timestamp the run settled. */
  endedAt: string;
  failingTest: string | null;
}

/** A bounded page of gate history (mirrors {@link ArchivedSessionsPage}'s {items,total,limit} contract so
 *  a "load more" UI can size itself + tell when its requested limit was server-clamped). */
export interface GateHistoryPage {
  items: GateHistoryRow[];
  total: number;
  limit: number;
}

/** A read-only vault file-tree entry. */
export interface VaultEntry {
  path: string; // relative to the project's vault folder, forward slashes
  type: "file" | "dir";
}

/**
 * A board task's priority: four levels, LOW number = HIGHER priority. Each maps to a theme tone for
 * its card chip (p0 red, p1 amber, p2 cyan/dim, p3 muted). `p2` (Normal) is the DEFAULT — every new
 * task and every backfilled legacy row carries it. Columns order high→low (p0 first) by (priority,
 * position).
 */
export type TaskPriority = "p0" | "p1" | "p2" | "p3";
/** The default priority for a new / un-prioritized task (Normal). */
export const DEFAULT_TASK_PRIORITY: TaskPriority = "p2";

export interface Task {
  id: TaskId;
  projectId: ProjectId;
  title: string;
  body: string;
  columnKey: string; // references a resolved kanban column key
  position: number;  // fractional index for cheap reordering
  priority: TaskPriority; // p0 (critical) → p3 (low); default p2 (normal)
  /**
   * Owner-gated HOLD flag: a card parked in an actionable lane that the OWNER has gated ("don't pick
   * this up — it's parked on a product decision") yet is NOT in the `blocked` brake lane. The idle
   * watchdog DISCOUNTS a held card from its "actionable" count so it never nags a manager to pick up a
   * card it's forbidden to touch. Additive + default false; distinct from `blocked` (the owner's brake
   * lane) — `held` is the "parked-in-todo, owner-gated, don't nag" signal.
   *
   * SET is freely agent-callable (setting a brake is always safe); CLEARING is the dangerous direction —
   * see {@link heldBy}. A human hold (`heldBy:"human"`) can ONLY be cleared via the human-only REST/UI
   * path, never via an agent MCP tool (card 9b0373c0, Platform-Audit bb23d15a) — enforced at
   * `updateProjectTask` (daemon `mcp/tasks.ts`), the one choke point both agent-facing task-update
   * surfaces (`tasks_update` and the Lead's cross-project `project_task_update`) share.
   */
  held?: boolean;
  /**
   * Provenance of the CURRENT `held` value: `"human"` (set via REST/UI), `"agent"` (set via an agent MCP
   * tool), or `null`/absent (never set, or held is currently false). Stamped SERVER-SIDE only — never a
   * client-suppliable field on any agent tool's input schema, so an agent can never forge `"human"` to
   * dodge the clear-refusal above. Meaningful only while `held` is true; a clear resets it to `null`.
   */
  heldBy?: "human" | "agent" | null;
  /**
   * Manager-settable DEFERRED flag: a card the MANAGER is intentionally sequencing behind other work —
   * its own dependency-gating/ordering marker, orthogonal to `held` (the owner's SOLE brake). The idle
   * watchdog discounts a deferred card from its "actionable" count (same treatment as `held`), but
   * UNLIKE `held`, `worker_spawn` never refuses a deferred card — it's not a brake. Additive + default
   * false; manager-settable (NOT owner-gated, unlike `held`) via `tasks_update`.
   */
  deferred?: boolean;
  /**
   * Multi-repo epic 49136451, phase 1: which of the project's registry repos this card targets —
   * a key into `Project.repos`, or `null`/absent (the default) meaning the project's PRIMARY repo
   * (`repoPath`). One task = one repo (cross-repo atomic tasks are deliberately deferred — see the
   * epic). Validated against the project's registry at write time (`mcp/tasks.ts`
   * `createProjectTask`/`updateProjectTask`, the REST task routes) — an unknown key is rejected, so a
   * stored `repoKey` always names a registry entry that existed at write time. It can still go STALE
   * if the registry is later edited to remove that entry; `resolveRepo` treats that as an explicit
   * error, but read paths (`tasks_get`/`tasks_list`) degrade it to the primary repo rather than
   * failing the whole read — see `mcp/tasks.ts` `resolveMergedInfo`. Resolve via `resolveRepo`
   * (`projects/resolve-repo.ts`), never by reading this field directly.
   */
  repoKey?: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * The board LIST projection `GET /api/projects/:id/board` returns (card 4fa2c146 — the 2026-07-16 perf
 * profile found this route shipping every DONE card's full body: 2.79MB / 1263 tasks, polled every 4s).
 * A LIVE (non-terminal-column) task keeps its full `body` — the common edit path pays no extra round
 * trip. A DONE task's `body` is dropped to `hasBody` only; its drawer lazy-fetches the full body on open
 * via `GET /api/tasks/:id`. `hasBody` is always accurate (derived server-side), so a card's "has a
 * description" indicator never depends on whether `body` happens to be present on this row.
 */
export type BoardTask = Omit<Task, "body"> & { body?: string; hasBody: boolean };

/**
 * A project-scoped SHARED memory note (card 2fd9abf9) — durable, fleet-shared project knowledge any
 * worker/manager can write (`memory_write`) and every kickoff can retrieve (pinned always + FTS5-matched
 * "related" notes). `key` is a stable slug: `memory_write` UPSERTS by `(projectId, key)`, so writing the
 * same key again updates the note in place rather than accumulating a duplicate. `pinned` notes ride in
 * full on EVERY kickoff and are NEVER evicted; unpinned notes are subject to the per-project `maxNotes`
 * bounded-store eviction (least-recently-RETRIEVED first — see `evictProjectMemoryOverCap` in db.ts).
 * `lastRetrievedAt`/`retrievalCount` are bumped only when a note is actually included in an injected
 * kickoff (not on every read), so eviction reflects genuine usefulness, not raw age.
 */
export interface ProjectMemoryEntry {
  id: string;
  projectId: ProjectId;
  key: string;
  title: string;
  text: string;
  pinned: boolean;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  lastRetrievedAt: string | null;
  retrievalCount: number;
  /**
   * Monotonic optimistic-concurrency token (card a5f98bb4) — starts at 1, incremented by exactly 1 on
   * every write, atomically in SQL. NOT derived from `updatedAt`: a coarse or colliding clock (same-ms
   * timestamps from two distinct writes — a real risk on some hosts/OSes) would let two writes share an
   * `updatedAt` and defeat a timestamp-based compare-and-set; an integer counter cannot collide this way.
   * This is the field `memory_write`'s `baseVersion` compares against.
   */
  version: number;
}

/**
 * LEGACY owner-gated / HOLD title heuristic — RETAINED ONLY for the one-time boot backfill that seeds the
 * structured `Task.held` flag from pre-existing cards (db.backfillHeldFromTitlesOnce). It is NO LONGER the
 * live idle-watchdog discount signal: that now keys SOLELY off `Task.held` (set explicitly by the owner via
 * the board / tasks_update), so a card titled with uppercase HOLD/CONFIRM is NOT discounted unless flagged.
 *
 * The old brittleness this replaces: a legit card whose title merely contained "HOLD"/"CONFIRM" (e.g.
 * "fix(pty): … — CONFIRM run-role intent first" as a real, actionable task) was silently discounted. The
 * flag makes the gate explicit. Keep this UPPERCASE word-boundary matcher as the backfill seed only — do
 * NOT reintroduce it on the live discount path.
 */
const OWNER_HELD_TITLE_RE = /\b(HOLD|CONFIRM)\b/;
export function isOwnerHeldTaskTitle(title: string): boolean {
  return OWNER_HELD_TITLE_RE.test(title);
}

/**
 * A global "preset prompt" — a programmable terminal action-button (a short `label` + the `prompt`
 * text it sends to a session on click). GLOBAL / daemon-wide: a single shared list with NO project or
 * session scoping. Human/UI-managed over the loopback REST surface (there is intentionally NO MCP path
 * — an agent never reaches it; it is plain user UI data, not a trust-boundary capability). Ordered by
 * `position`; a freshly-created preset appends at the end of the list.
 */
export interface PresetPrompt {
  id: string;
  label: string;   // short button text
  prompt: string;  // the prompt text sent to the session on click
  position: number; // ascending order (append = max+1)
  createdAt: string;
  updatedAt: string;
}

/**
 * A SUGGESTED preset prompt — the "Suggested from your usage" feature. The Platform Auditor (and the
 * human/UI for completeness) proposes a candidate preset (`label` + `prompt`, plus a `rationale` for
 * WHY it was suggested, surfaced in the UI). GLOBAL / daemon-wide, mirroring `PresetPrompt`: a single
 * shared list, NO project/session scoping. Lifecycle: `pending` → `adopted` | `dismissed`. Adopting
 * mints a real `PresetPrompt` from the suggestion's label+prompt; adopted/dismissed rows are KEPT to
 * back the dedupe ("no re-nag"). The write path is dedupe-guarded so a hostile transcript can't spam:
 * a suggestion whose normalized (trimmed) prompt already matches an existing preset OR any existing
 * suggestion (in any status) is a no-op.
 */
export interface PresetPromptSuggestion {
  id: string;
  label: string;   // short button text (the adopted preset's label)
  prompt: string;  // the prompt text the adopted preset would send
  rationale: string | null; // WHY it was suggested (for the UI); nullable
  status: "pending" | "adopted" | "dismissed";
  position: number; // ascending order (append = max+1)
  createdAt: string;
  updatedAt: string;
}

/**
 * A durable Companion session↔chat binding (Companion authorization layer, Phase 1). Persists WHICH
 * chat on WHICH channel is wired to WHICH companion session, PLUS the `scope` that selects the
 * authorization rule the ChatGateway applies to an inbound message (see {@link SessionBinding}):
 *   • "dm"    — a private 1:1 chat. The (channel, chatId) match alone proves the single owner (a
 *               Telegram private chatId IS the user id), so every inbound is authorized — the
 *               single-owner path, unchanged from the env-seeded spike.
 *   • "group" — a shared chat. An inbound is authorized ONLY when the message carries a `sender.id`
 *               that is on this binding's per-binding {@link CompanionAllowedSender} allowlist; a
 *               missing/unlisted sender is HARD-rejected (an unidentifiable speaker in a shared chat
 *               can never be authorized).
 * MULTI-CHANNEL: a session may hold up to ONE binding PER channel (UNIQUE (sessionId, channel)), so an
 * in-app + a Telegram binding coexist for the SAME companion — reachable on both at once. Routing stays
 * unambiguous: at most one binding per (channel, chatId) route (a UNIQUE db index), so a chat still maps
 * to exactly one session. GLOBAL / daemon-wide, like the companion config itself. HUMAN-managed only over
 * the loopback REST surface — there is intentionally NO MCP path: a chat-reachable, injection-exposed
 * agent must NOT be able to authorize senders for itself (same trust posture as the vault/git/api_keys
 * human-only writers). See `[[Companion Design]]`.
 */
export interface CompanionBinding {
  /** The bound companion session id (NON-unique — a session may bind one channel each). */
  sessionId: SessionId;
  /** The chat channel name (e.g. "telegram") — matches the originating ChannelAdapter.name. Unique with
   *  `sessionId` (one binding per session per channel — the upsert key). */
  channel: string;
  /** The bound chat id (stringified platform id). Unique with `channel` (one session per route). */
  chatId: string;
  /** The authorization scope selecting the rule applied to inbound messages on this binding. */
  scope: "dm" | "group";
  createdAt: string;
}

/**
 * A per-binding allowlisted sender (Companion authorization layer, Phase 1) — one identified human who
 * may post to a GROUP-scoped {@link CompanionBinding}. The load-bearing security record for the
 * multi-user (group) case: an inbound group message is authorized ONLY when its `sender.id` matches an
 * allowlist row for the bound session+channel. Unique per (sessionId, channel, senderId). Like the
 * binding above it is GLOBAL / daemon-wide and HUMAN-managed only (loopback REST, NO MCP path — the
 * agent must never allowlist a sender for itself). See `[[Companion Design]]`.
 */
export interface CompanionAllowedSender {
  id: string;
  /** The companion session this sender is allowed to reach. */
  sessionId: SessionId;
  /** The chat channel the sender speaks on (e.g. "telegram"). */
  channel: string;
  /** The platform sender id that is authorized (stringified). */
  senderId: string;
  /** Optional human label for the sender (who this is), UI-only; null when unset. */
  label: string | null;
  createdAt: string;
}

/**
 * One capability GRANT (Companion Capability & Permission-Lever Framework, §1) — the durable row that
 * enables ONE opt-in Companion "lever" (e.g. `session-status`) for ONE companion session, optionally
 * scoped to ONE project. A capability is enabled by the PRESENCE of a row: no grant ⇒ that lever's tools
 * are never registered on the companion's MCP surface (`resolveCompanionGrant`/`registerCompanionCapabilities`,
 * daemon `mcp/orchestration.ts`) — inert + invisible, mirroring the `chat_reply`/`skill_*`/`memory_*`/
 * `reminder_*` per-session companion gate. GLOBAL / daemon-wide, keyed on `sessionId` like
 * {@link CompanionBinding}. HUMAN-managed only over the loopback REST surface (`POST`/`PUT`/
 * `DELETE /api/companion/:sessionId/grants`) — there is INTENTIONALLY NO MCP path: an injection-exposed
 * companion agent must never widen its own capability. See `[[Companion Capability & Permission-Lever
 * Framework]]`.
 */
export interface CompanionCapabilityGrant {
  id: string;
  /** The companion session this grant is scoped to — grants are read PER-SESSION, never globally. */
  sessionId: SessionId;
  /** The lever slug, e.g. "session-status" | "decisions-relay" | "attention-push" | "session-steer" |
   *  "board-reach" | "vault-read" | "media-out". */
  capability: string;
  /** The project this grant scopes to; null = the companion's OWN bound project (the narrow default). A
   *  capability spanning several projects gets one row PER project. */
  projectId: ProjectId | null;
  /** The read-vs-act granularity: a `read` grant never implies `act`; `act` is only ever the explicit
   *  stronger row for the SAME (sessionId, capability, projectId). */
  mode: "read" | "act";
  /** Lever-specific extra scope (decision-class allowlist, alert classes, path roots, …), opaque to the
   *  framework — each lever validates its own shape. NEVER holds a secret. */
  config: Record<string, unknown>;
  createdAt: string;
}

/**
 * A grant-time RISK ADVISORY about a companion session's WHOLE resolved grant set (never one row) — a
 * cross-lever combination that is individually allowed but riskier TOGETHER (Companion Capability &
 * Permission-Lever Framework; owner decision `4c33a1bc`, 2026-07-12). It is a WARNING, never a block: the
 * grant still succeeds. Computed SERVER-SIDE (the single source of truth for the risk model —
 * `computeCoGrantWarnings`, daemon `companion/capabilities.ts`) and returned on the grants GET / POST /
 * PUT responses so the human grant UI can surface it near the grant controls. The `detail` is
 * owner-facing prose authored by the daemon; the web panel only renders it, so the copy never drifts
 * between the two.
 */
export interface CompanionCoGrantWarning {
  /** Stable machine code for the specific risk (e.g. "transcript-steer-launder", "multi-tier-a-window")
   *  — a React key / test anchor, never shown to the owner. */
  code: string;
  /** Short owner-facing headline for the advisory. */
  title: string;
  /** The full owner-facing explanation of the combined risk and why the owner is being told about it. */
  detail: string;
}

/**
 * A per-ROUTE Companion VOICE preference (Companion Voice epic, VOICE-P1 foundation) — the language/voice
 * settings a "/lang"/"/voice" slash-command sets for ONE (session, channel, chatId[, senderId]) route.
 * Keyed like {@link CompanionBinding} but ADDITIONALLY by `senderId` for a GROUP-scoped binding (a DM's
 * chatId already IS the user, so senderId stays null there) — a shared chat's users each get their own
 * language/voice-reply setting. Resolved SERVER-SIDE from the authenticated inbound route, NEVER a
 * body-supplied field (same posture as CompanionBinding). Read at inbound (P2, forces the STT decode
 * language) and outbound (P3, picks the TTS voice) — this card (P1) only stores + resolves it, no
 * STT/TTS model work here. GLOBAL / daemon-wide. HUMAN-managed READ-ONLY over the loopback REST surface
 * (no MCP path — same trust posture as the binding/allowlist writers); the ONLY writer is the "/lang"/
 * "/voice" slash-command router (companion/commands.ts), which resolves the route server-side from the
 * already-authorized inbound. See `[[Companion Voice — STT-TTS Design]]`.
 */
export interface CompanionVoicePref {
  sessionId: SessionId;
  channel: string;
  chatId: string;
  /** Present only for a GROUP-scoped binding (the per-user key within a shared chat); null for DM. */
  senderId: string | null;
  /** Forced STT decode language (P2 consumes this), or null = auto-detect. */
  sttLang: string | null;
  /** TTS output language (P3 consumes this), or null = unset. */
  ttsLang: string | null;
  /** TTS voice selection (P3 consumes this), or null = provider default. */
  ttsVoice: string | null;
  /**
   * The route's voice-reply MODE (VOICE-P4 — the agent-decided tri-state, card edd11203; P1 shipped this
   * as a plain boolean, extended here): `"off"` = always text (the user's opt-out always wins — the agent
   * can NEVER force voice when off); `"on"` = always voice; `"auto"` = the AGENT decides per reply via the
   * `chat_reply` MCP tool's optional `voice` flag (deliverReply speaks IFF the reply set `voice:true`,
   * else text — an omitted flag in auto mode defaults to TEXT, never a surprise voice reply).
   */
  voiceReplies: "on" | "off" | "auto";
  createdAt: string;
  updatedAt: string;
}

/**
 * A persisted CHAT TURN for a companion channel (bug 0f01f234 — the web in-app chat used to lose all
 * history on reload; this is the fix's durable store). Channel-keyed — UNIFIED CROSS-CHANNEL CHAT (card
 * 7d63e200) extended writers from in-app-only to every channel, so a session's Telegram conversation (the
 * owner's messages + the companion's replies, including voice-note transcripts) records here too, tagged
 * with its own channel for the web cockpit's unified stream. `chatId` mirrors {@link CompanionBinding}'s
 * shape; for in-app it always equals `sessionId` (the loopback self-address — see companion/in-app.ts).
 * GLOBAL / daemon-wide, bounded growth (pruned to the most recent ~200 rows per session+channel on every
 * insert — see `Db.insertCompanionMessage`). See `[[Companion Design]]`.
 */
export interface CompanionMessage {
  id: string;
  sessionId: SessionId;
  channel: string;
  chatId: string;
  /** Who authored this turn: the human ("user") or the companion's reply ("companion"). */
  author: "user" | "companion";
  text: string;
  createdAt: string;
  /** True iff this turn's `text` IS (or, for a companion reply, WAS synthesized FROM) audio: an inbound
   *  voice-note STT transcript (card 7d63e200 — e.g. a Telegram voice message), or an outbound reply
   *  actually delivered as a synthesized TTS voice clip (Companion Delivery Introspection) — `text` doubles
   *  as that clip's transcript. Always false for a typed message and for a companion reply sent as plain
   *  text. The web panel renders a small mic indicator alongside a true row. */
  viaVoice: boolean;
  /** Which conversation (per-session, 1-based, monotonic) this turn belongs to — conversation history (card
   *  85f62475). Every "/new"/"/reset" closes the current conversation and opens the next `conversationSeq`;
   *  a message's conversationSeq never changes after insert. See {@link CompanionConversationSummary}. */
  conversationSeq: number;
  /** True iff this turn's underlying pty turn was a daemon-driven PROACTIVE submit — a heartbeat, a fired
   *  recurring reminder, or an attention-push alert — rather than an owner inbound or an ordinary system
   *  inject (proactive event-line producer). Always false for author:"user" (an inbound is never proactive
   *  by definition). The web cockpit renders a `true` row as a distinct amber event line, never a chat
   *  bubble. */
  proactive: boolean;
}

/**
 * ONE conversation's summary for the session's history list (conversation history, card 85f62475) — a
 * conversation is the span of companion_messages between two "/new"/"/reset" boundaries (or session start /
 * "still live"). `endedAt` is `null` for the CURRENT (open, still-accumulating) conversation — exactly one
 * open conversation exists per session at a time. `preview` is the first message's text, truncated + single-
 * lined for a list row (the full text is available via the fetch-one-conversation route). A conversation with
 * zero messages (e.g. two "/new" in a row with nothing sent between) is never surfaced here — see
 * `Db.listCompanionConversations`.
 */
export interface CompanionConversationSummary {
  sessionId: SessionId;
  seq: number;
  startedAt: string;
  endedAt: string | null;
  messageCount: number;
  preview: string | null;
}

/**
 * The MASKED, human-facing view of a durable Companion RUN config (Companion epic Phase 3 — the
 * `companion_config` DB row that says HOW to run a companion: which bot token, cadence, home, enabled).
 * This is the ONLY shape the REST surface ever returns and the web cockpit ever sees — the bot token
 * itself is ENCRYPTED at rest (envelope) and NEVER leaves the daemon: a read exposes `configured:true`
 * plus the last 4 characters only (`tokenLast4`, for human confirmation), never the token. There is
 * intentionally NO MCP path (same human-only trust posture as the binding/allowlist/git/vault writers):
 * a chat-reachable, injection-exposed companion agent must never be able to read or write its own token.
 * See `[[Companion Design]]`.
 */
export interface CompanionConfigMasked {
  /** The bound companion session id this run-config keys on. */
  sessionId: SessionId;
  /** Always true for a returned config (a missing config is a 404 / absent from the list, not `configured:false`). */
  configured: true;
  /**
   * Whether a bot token is stored for this companion (Telegram wired). FALSE for an IN-APP-ONLY companion
   * (the provision default — no external channel), in which case `tokenLast4` is empty. Distinct from
   * `configured` (a config row exists) and from an empty `tokenLast4` on a corrupt/undecryptable blob.
   */
  tokenConfigured: boolean;
  /**
   * Whether THIS endpoint minted the bound session (provision provenance). TRUE ⇒ deleting the companion
   * also RETIRES the session it spawned; FALSE (env bootstrap / a human-bound pre-existing session) ⇒ the
   * session outlives the config on delete. See the provision endpoint.
   */
  provisioned: boolean;
  /** The last 4 characters of the bot token, for human confirmation — NEVER the token itself. */
  tokenLast4: string;
  /** The companion's given (human-friendly) name, or "" when never named. */
  name: string;
  /** The transport channel (e.g. "telegram"). */
  channel: string;
  /** The owner/allowlisted chat id this companion is bootstrapped against. */
  allowedChatId: string;
  /** The boot-binding authorization scope. */
  chatScope: "dm" | "group";
  /** Proactive heartbeat cadence in minutes (0 = off). */
  heartbeatIntervalMinutes: number;
  /** The framed proactive-prompt text used on each heartbeat turn. */
  heartbeatPrompt: string;
  /** The proactive HOME channel target (app_meta-backed, daemon-global), or null when unset. */
  home: CompanionRoute | null;
  /** Whether this config is enabled — a disabled config is treated as OFF at boot. */
  enabled: boolean;
  /**
   * True when a LOOM_COMPANION_* env config is currently set for THIS row's sessionId — i.e. env would
   * OVERRIDE this row on the next daemon restart (the "env wins" bootstrap ruling). A human-visibility
   * flag so the UI can show "pinned by env" rather than silently reverting a REST edit on next boot.
   */
  envPinned: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Auth scheme a stored Connection uses. `oauth2` added in agent-tooling P5a (authorization-code + PKCE). */
export type ConnectionAuthScheme = "api-key" | "bearer" | "oauth2";

/** OAuth2 provider template slug (agent-tooling P5a). "custom" = human supplies auth/token URLs + scopes directly. */
export type OAuthProviderSlug = "google" | "github" | "custom";

/**
 * One read-only Google product scope offered as a checkbox by the turnkey "Google Analytics" connector
 * preset (agent-tooling P5b). Non-secret catalog data — the shared source of truth both the Settings form
 * (renders the checkboxes) and the daemon (routes provider "google" through its existing template) read.
 * The daemon already accepts an explicit `scopes` array on `POST /api/connections/oauth`; these are just
 * the human-facing labels + the exact scope strings a user ticks.
 */
export interface GoogleScopePreset {
  /** Stable key for React lists + form state. */
  key: string;
  /** Human label shown next to the checkbox (e.g. "Analytics Data API"). */
  label: string;
  /** The exact OAuth scope URL sent to Google. */
  scope: string;
  /** One-line explanation of what the scope grants. */
  description: string;
}

/**
 * The read-only per-product scopes the "Google Analytics" connector preset offers. All three are
 * `*.readonly` — this connector reads numbers, it never writes. Ticked scopes populate the oauth2
 * connection's `scopes`; Google's authUrl/tokenUrl come from the daemon's existing "google" template.
 */
export const GOOGLE_ANALYTICS_SCOPE_PRESETS: readonly GoogleScopePreset[] = [
  {
    key: "analytics",
    label: "Analytics Data API",
    scope: "https://www.googleapis.com/auth/analytics.readonly",
    description: "GA4 metrics & reports (properties/<id>:runReport)",
  },
  {
    key: "search-console",
    label: "Search Console",
    scope: "https://www.googleapis.com/auth/webmasters.readonly",
    description: "Search queries, clicks & impressions",
  },
  {
    key: "adsense",
    label: "AdSense",
    scope: "https://www.googleapis.com/auth/adsense.readonly",
    description: "AdSense earnings & report data",
  },
];

/**
 * The MASKED, human-facing view of a stored Connection (owner-controlled encrypted credential store,
 * agent-tooling epic P1, extended in P5a) — metadata ONLY. The secret material is ENCRYPTED at rest
 * (envelope) and NEVER leaves the daemon: no REST read and no MCP tool ever returns it (for an `oauth2`
 * row this includes the access/refresh tokens AND the client secret — the whole token bundle stays
 * server-side). There is intentionally NO MCP path (same human-only trust posture as the vault/git/
 * companion writers): an agent in an ordinary project session must never create, list, or read a
 * connection's secret. `host` is stored metadata only in P1 — request-side host-allowlist ENFORCEMENT
 * belongs to the authenticated-request tool (P2), not this store.
 */
export interface ConnectionMetadata {
  id: string;
  /** Human-chosen label for the connection (e.g. "GitHub personal token"). */
  name: string;
  /** The target host this connection's secret is scoped to (metadata only in P1 — no enforcement here). */
  host: string;
  authScheme: ConnectionAuthScheme;
  /**
   * Project scope (card f2abce7e): `null` = GLOBAL — reachable by any profile that allowlists it, exactly
   * as every connection behaved before this field existed. A project id BOUNDS this connection's blast
   * radius to that one project — a session whose own project doesn't match resolves NOTHING for it, even
   * if its profile allowlists the id (fail-closed; see `connections/store.ts` `isConnectionUsableByProject`).
   */
  projectId: string | null;
  createdAt: string;
  /** `oauth2` rows only — the provider template this connection was registered under. */
  provider?: OAuthProviderSlug;
  /**
   * `oauth2` rows only — the granted scopes, parsed from the stored space-joined column. NON-secret
   * (they ride in the consent URL and are stored plaintext), so surfacing them here is safe and lets the
   * UI show which products a connection covers. Empty array when the row stored no scopes.
   */
  scopes?: string[];
  /** `oauth2` rows only — true once at least one token exchange (initial consent or refresh) has succeeded. */
  connected?: boolean;
  /** `oauth2` rows only — ISO expiry of the current access token, or null before the first exchange. */
  tokenExpiresAt?: string | null;
  /** `oauth2` rows only — true when the refresh token is absent/revoked and consent must be redone. */
  needsReauth?: boolean;
  /**
   * True when this connection was AUTO-PROVISIONED at a credential-answer boundary (credential
   * auto-provisioning v1, card 193de09e) rather than hand-created in the Connections form — derived
   * server-side by checking whether any Question's `provisionConnectionId` points at this row. A display
   * hint only (the Connections page badges it), never a behavioral distinction. Absent/false for a
   * hand-created connection, byte-identical to before this field existed.
   */
  autoProvisioned?: boolean;
}

/**
 * An owner-declared SYMMETRIC link between two projects (board card 2349d90c) — the sole gate for the
 * manager↔manager `peer_message` cross-project channel: a manager may message a peer project's manager
 * ONLY if the owner has linked the two projects here. HUMAN-managed only over the loopback REST surface
 * (`GET/POST /api/project-links`, `DELETE /api/project-links/:id`) — INTENTIONALLY NO MCP path, same
 * trust posture as the connections/capability_defs stores: an agent must never be able to link projects
 * itself and so widen its own cross-project reach. `projectAId`/`projectBId` are stored canonically
 * ordered (lexicographically smaller id first) so a pair is represented exactly once regardless of which
 * side declared it; direction carries no meaning (the link is symmetric).
 */
export interface ProjectLink {
  id: string;
  projectAId: string;
  projectBId: string;
  createdAt: string;
}

/**
 * A cron-triggered schedule (phase-2 Pillar B). On its minute boundary the daemon Scheduler
 * boots a manager session in `agentId` (the agent's startupPrompt is the kickoff), which then
 * runs the Pillar-A loop. `nextFireAt` is recomputed on create/update and after each fire.
 */
export interface Schedule {
  id: string;
  /**
   * Human-facing name, MANDATORY on new creation (validated non-empty at the REST create surface + the
   * Schedules builder). Added after the initial ship (Schedules UI redesign) as a NULLABLE column, so
   * legacy rows that predate names read a derived default (`describeCron(cron)` — e.g. "Every day at
   * 9:00 AM") at the DB boundary rather than an empty string; the agent MCP `schedule_create` derives
   * the same default when a name is omitted (backward-compatible). Always a non-empty string in the
   * model as a result.
   */
  name: string;
  agentId: AgentId;
  cron: string;              // 5-field cron expression
  enabled: boolean;
  nextFireAt: string;        // ISO; the next scheduled fire
  lastFiredAt: string | null;
  createdAt: string;
  /**
   * What a fired schedule spawns (Platform Manager P5):
   * - "manager" (DEFAULT) — boots a manager session that runs the Pillar-A loop (today's behavior).
   * - "auditor" — boots the dev Platform Auditor via `startAuditor` (role locked to "auditor", the
   *   read-and-file-only transcript reviewer). The Scheduler routes by this field.
   * - "workspace-auditor" — boots the END-USER Workspace Auditor via `startWorkspaceAuditor` (role
   *   locked to "workspace-auditor", the de-privileged suggest-only user-workspace reviewer; B6). It
   *   lets a user run "Review my workspace" on a cron, not just on-demand.
   * Additive + idempotent: legacy rows backfill to "manager" (column DEFAULT), so every existing
   * schedule keeps spawning a manager exactly as before.
   */
  kind: "manager" | "auditor" | "workspace-auditor";
  /**
   * Optional per-schedule task description, APPENDED to the agent's own startupPrompt when this
   * schedule fires (agent prompt first, then this as a clearly-delimited block — never clobbers or
   * precedes the agent's identity/doctrine). Settable by humans (Schedules UI/REST) and agents
   * (schedule_create/update MCP tools). Unset ⇒ composition is byte-identical to today.
   */
  prompt?: string | null;
  /**
   * Deferral observability (board card 53edd8d5): the instant this schedule most recently TRANSITIONED
   * into a deferred state — a due fire held back by a budget gate (manager cap / auditor budget) rather
   * than fired. Set (with `lastDeferredReason`) by `Db.markDeferred` ONLY on a transition — first defer,
   * or the reason changing — never on every tick a still-deferred schedule remains blocked for the SAME
   * reason (that would flood the event log every 60s tick; see `schedule_fire_deferred` below). So this
   * reads as "deferred since <the start of the current episode>", not "last tick checked". Cleared to
   * null by `Db.markFired` on the schedule's next successful fire — the badge self-clears once unblocked.
   * null = not currently deferred (never blocked, or the block has since resolved).
   */
  lastDeferredAt?: string | null;
  /** The human-readable reason for the current deferral (e.g. "manager cap (3) reached"), paired with
   *  `lastDeferredAt`. null exactly when `lastDeferredAt` is null. */
  lastDeferredReason?: string | null;
}

/**
 * An originating chat ROUTE — WHICH chat on WHICH channel. THE canonical definition (shared is the
 * dependency leaf and can't import back from the daemon, so this is where the shape has to live).
 * The daemon's `CompanionRoute` (companion/types.ts) and `TurnRoute` (pty/host.ts) both ALIAS this
 * type via `import type { CompanionRoute } from "@loom/shared"` — daemon → shared is an allowed
 * dependency direction — so the two names stay structurally identical by construction, not by
 * convention.
 */
export interface CompanionRoute {
  channel: string;
  chatId: string;
}

/**
 * A one-shot self-scheduled wake-up (the agent-facing `wake_me` primitive). A session schedules
 * one, ends its turn, and goes idle; when `wakeAt` passes the daemon WakeService re-submits `note`
 * as a fresh turn — auto-resuming the session first if it was stopped. Unlike a Schedule it does
 * NOT recur: a fired wake is deleted. `note` is the agent's message-to-its-future-self.
 */
export interface Wake {
  id: string;
  sessionId: SessionId;
  wakeAt: string;            // ISO; when to re-nudge the session
  note: string;
  createdAt: string;
  /**
   * The companion chat route the in-flight turn originated from AT SCHEDULE TIME (captured via
   * `pty.getActiveTurnOrigin`), or undefined for an ordinary (non-companion) wake. SERVER-DERIVED —
   * the agent cannot set or spoof this; the `wake_me` MCP tool never accepts a route input. When
   * present, the WakeService fires the wake back through the SAME per-turn companion route the
   * heartbeat uses, instead of a plain nudge.
   */
  route?: CompanionRoute;
}

/**
 * A local poll job (agent-tooling epic P3): the daemon periodically fetches `path` on `connectionId`
 * (via the SAME server-side P2 `authenticated_request` path an agent uses — the connection's secret is
 * injected/redacted there, never carried by this row or seen by the triggered session) and, on detecting
 * an item not seen on the PREVIOUS poll, either wakes `sessionId` (mode "wake") or spawns a fresh session
 * in `agentId` (mode "spawn") with the new item(s) as its kickoff. `cursorJson` holds the last poll's
 * item-id SNAPSHOT (a JSON string[] — not accumulated across polls, so storage stays O(items-per-poll));
 * `null` means "never successfully polled yet" — the first poll seeds the baseline and fires nothing.
 * `itemsPath`/`idPath` are dot-paths into the fetched JSON (default: root array / "id" per item).
 * Human-configured only (REST, mirrors `schedules`/`connections`) — never an agent MCP tool.
 */
export interface PollJob {
  id: string;
  connectionId: string;
  path: string;
  method: string;
  intervalMs: number;
  nextPollAt: string;
  lastPolledAt: string | null;
  itemsPath: string;
  idPath: string;
  cursorJson: string | null;
  mode: "wake" | "spawn";
  sessionId: string | null;
  agentId: string | null;
  enabled: boolean;
  consecutiveFailures: number;
  lastError: string | null;
  createdAt: string;
}

/**
 * Event Triggers (Loom Event Triggers subsystem, card f5d07121 — T1, the data-layer FOUNDATION; the
 * always-on dispatcher and the human-only REST are deferred follow-on cards). The internal-state
 * counterpart to `PollJob` above: `PollJob` reacts to an EXTERNAL endpoint via a fetch cadence, an
 * `EventTrigger` reacts to an INTERNAL orchestration-lifecycle event already on the durable
 * `orchestration_events` bus.
 *
 * The eligible-kind allowlist below (`EVENT_TRIGGER_EVENT_KINDS`) is the union of attention-push.ts's
 * `classify()` signal sources (companion/attention-push.ts — the closest existing "which lifecycle
 * events matter" vocabulary) plus the scheduler/poll/wake success-fired events, which attention-push
 * doesn't subscribe to but are equally real bus signals. It is the single source of truth the dispatcher
 * and the REST validator (both deferred) will reuse — deliberately excludes card/task-lifecycle kinds
 * (task mutations emit no events today) and companion-internal mechanics (heartbeat/reminder/alert-push
 * — those are the companion's own watchers' output, not general orchestration lifecycle).
 */
export const EVENT_TRIGGER_EVENT_KINDS = [
  "merge_rejected", "merge_request",
  "worker_stuck", "worker_report", "worker_exited_without_report", "session_recovery_abandoned",
  "question_asked",
  "idle_escalated", "idle_report",
  "context_escalated",
  "platform_escalate",
  "session_rate_limited",
  "schedule_fired", "poll_fired", "wake_fired",
] as const satisfies readonly OrchestrationEventKind[];
export type EventTriggerEventKind = (typeof EVENT_TRIGGER_EVENT_KINDS)[number];

/**
 * A local event trigger: when an event whose `kind` is `eventKind` appears on the `orchestration_events`
 * bus (optionally scoped to `projectId` — null means every project), wake `targetSessionId` (mode
 * "wake") or spawn a fresh session in `agentId` (mode "spawn"). `lastSeq` is the watermark cursor into
 * `Db.listEventsSince` — mirrors `AttentionPushWatcher`'s own per-subscriber watermark (a bus POSITION),
 * not `PollJob.cursorJson`'s item-id snapshot (there's no "item" here). `lastFiredAt` is the dedupe/
 * rate-guard column: null until this trigger has actually fired once; the (deferred) dispatcher stamps
 * it on every real wake/spawn delivery and can enforce its own anti-hammer floor off it, mirroring
 * `PollJob`'s `consecutiveFailures`-driven backoff / `MIN_POLL_INTERVAL_MS` anti-hammer floor. Pure data
 * in this card — nothing reads `lastSeq`/`lastFiredAt` forward yet; that's the dispatcher card.
 * Human-configured only (REST, mirrors `poll_jobs`/`schedules`) — never an agent MCP tool.
 */
export interface EventTrigger {
  id: string;
  eventKind: EventTriggerEventKind;
  projectId: string | null;
  mode: "wake" | "spawn";
  targetSessionId: string | null;
  agentId: string | null;
  enabled: boolean;
  lastSeq: number;
  lastFiredAt: string | null;
  createdAt: string;
}

/**
 * Inbound webhook receiver (agent-tooling epic P5b, card 8fbedcac) — the Tier-2 public-ingress sibling of
 * `EventTrigger` above: instead of reacting to Loom's own internal bus, a `WebhookEndpoint` accepts a
 * signed POST from an external provider (GitHub/Stripe/a Standard-Webhooks sender/Loom's own generic
 * scheme) at its own opaque, non-guessable `path`, HMAC-verifies it against the endpoint's own signing
 * secret, and wakes `targetSessionId` (mode "wake") or spawns a fresh session in `agentId` (mode "spawn")
 * with the verified event as kickoff — mirroring `EventTrigger`'s own wake/spawn targeting exactly.
 * `agentId` (spawn mode) is what PINS the endpoint's target project + role: `sessions.startNew` resolves
 * both from the agent's own profile, so no separate projectId/role column is needed here.
 */
export type WebhookSourceType = "github" | "stripe" | "standard" | "generic";
export const WEBHOOK_SOURCE_TYPES: readonly WebhookSourceType[] = ["github", "stripe", "standard", "generic"] as const;

/**
 * The MASKED, human-facing view of a stored WebhookEndpoint — metadata ONLY. The signing secret is
 * ENCRYPTED at rest (envelope, mirrors `ConnectionMetadata`) and NEVER leaves the daemon: no REST read
 * and no MCP tool ever returns it. There is intentionally NO MCP path (same human-only trust posture as
 * `ConnectionMetadata`/`EventTrigger`): an agent in an ordinary project session must never create, list,
 * or read a webhook endpoint or its secret.
 */
export interface WebhookEndpointMetadata {
  id: string;
  /** Opaque, non-guessable path segment this endpoint is mounted at (`POST /hooks/:path`). */
  path: string;
  name: string;
  sourceType: WebhookSourceType;
  mode: "wake" | "spawn";
  targetSessionId: string | null;
  agentId: string | null;
  enabled: boolean;
  createdAt: string;
  lastFiredAt: string | null;
}

// "cancelled" (card feat(orchestration): question_cancel + dismiss) is a FOURTH terminal state reachable
// only from "pending" — never from "answered"/"consumed" (an agent/human can never discard an answer that
// already landed; see Db.cancelQuestion). Two entry points land it: the asking agent's own `question_cancel`
// MCP tool (agent-lineage-scoped — can only cancel its own asks) and the human-only `POST
// /api/questions/:id/dismiss` REST route. Never a hard delete — a cancelled row is retained exactly like an
// answered/consumed one (see Question.cancelledReason/cancelledBy/cancelledAt below), closing the gap where
// a moot/superseded pending ask had no exit besides being answered and sat in the human's inbox forever.
export const QUESTION_STATES = ["pending", "answered", "consumed", "cancelled"] as const;
export type QuestionState = (typeof QUESTION_STATES)[number];

/**
 * The Requests-object type discriminator (card 695ebab0 — generalizes the decision-only inbox below into
 * a durable, typed Requests object; the UI epic beb61d23 rests on top). `decision` is the ORIGINAL shape
 * (card 8701bdbb) and stays the default for backward compat. `input` is a first-class freeform-text ask
 * (no options — previously modeled as a decision with none). `permission` asks the human to authorize/deny
 * an irreversible/outward/spend action — this is an ASK/ANSWER CHANNEL, not a second gate mechanism: it
 * does not itself block anything the way a task's `held`/`blocked` state does (see Task.held above); an
 * agent that wants a permission request to actually STOP work must still park via those existing brakes,
 * then use `permission` only to carry the human's authorize/deny answer. `credential` asks for a secret
 * the agent needs (an API key/token) under a NEVER-ECHO model: the plaintext never round-trips through
 * this object or any agent-readable response — see `credentialEnvVar` below and `Db.answerCredentialQuestion`.
 */
export const QUESTION_TYPES = ["decision", "input", "permission", "credential"] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

/** A `permission` request's requested grant lifetime: `once` (this action only) or `standing` (keep
 *  authorizing this class of action going forward) — the human's answer may grant a narrower scope than
 *  requested; Loom does not enforce the requested scope, it's a hint shown alongside the ask. */
export const PERMISSION_SCOPES = ["once", "standing"] as const;
export type PermissionScope = (typeof PERMISSION_SCOPES)[number];

/** A `permission` request's answer vocabulary — the ONLY two values `chosenOption` may hold for
 *  `type:"permission"` (the human-only REST answer route validates against this; `mcp/questionTool.ts`'s
 *  `questionPullItem` derives its `approved` boolean by comparing against this SAME const) — a single
 *  shared source so the write-side validation and the read-side derivation can never drift apart. */
export const PERMISSION_ANSWERS = ["authorize", "deny"] as const;
export type PermissionAnswer = (typeof PERMISSION_ANSWERS)[number];

/**
 * `type:"credential"`'s optional ask-time provisioning target (card 193de09e, credential auto-provisioning
 * v1) — a superset of the older `envVar` hint. States INTENT only: naming this target never itself grants
 * anything — the human-only answer boundary (`POST /api/questions/:id/answer`) is the sole writer that
 * ever creates/updates a Connection or a pending binding from it. `connection` is deliberately a NESTED
 * object (not flattened onto `Question`) so a later scope (card f2abce7e, project-scoped connections) can
 * add a sibling key here without restructuring. `binding.profileId`, if given, requests that the answered
 * secret's Connection be bound to that profile — but the binding only ever lands as a PENDING record
 * (`Question.provisionBindingState`); it is never auto-applied to `Profile.connections`.
 */
export interface ProvisionTarget {
  connection: { name: string; host: string };
  binding?: { profileId: string };
}

/**
 * A manager→human DECISION INBOX entry (card 8701bdbb, daemon core / child A), generalized (card
 * 695ebab0) into a typed Requests object via the `type` discriminator. A manager/orchestrator hits a
 * mid-flight decision/input/permission/credential need, asks NON-BLOCKING (the ask tool returns
 * immediately — the manager keeps orchestrating the rest of its fleet) and is answered asynchronously in
 * the UI. Lifecycle: "pending" (waiting on the human) → "answered" (the human replied; waiting on the
 * asking manager's pickup) → "consumed" (the manager pulled it). `options`/`recommendation` are
 * `type:"decision"`-only and optional there too — a pure-blocker decision ask (no options) carries only
 * `title`+`body`, and round-trips on `note` alone (`chosenOption` stays null even once answered);
 * `type:"input"` always has null `options` and answers via `note` alone, same as a pure-blocker decision.
 * The `permission*`/`credentialEnvVar` fields are the per-type ASK-TIME payload for their own type and
 * null for every other type. The credential's ANSWER (the envelope-encrypted secret) is deliberately NOT
 * a field here — it never flows through this agent-reachable object; see `Db.answerCredentialQuestion`.
 */
export interface Question {
  id: string;
  /** The asking manager/orchestrator session id — server-derived at ask time, never agent-supplied. */
  sessionId: string;
  projectId: string;
  /** Defaults to "decision" — an existing caller that never passes `type` is byte-identical to before. */
  type: QuestionType;
  title: string;
  body: string;
  /** Nullable — a pure-blocker ask carries no options; always null for a non-"decision" type. */
  options: string[] | null;
  /** Nullable — the asking manager's suggested answer, shown to the human as a nudge, not enforced. */
  recommendation: string | null;
  /** Optional soft link to a board task (card 695ebab0) — deliberately NOT a DB foreign key: a deleted
   *  task must not orphan this request's history row, so a dangling id here just means "the linked task
   *  is gone," never a constraint violation. */
  taskId: string | null;
  /** `type:"permission"` ask-time payload — the action being authorized/denied. Null for every other type. */
  permissionAction: string | null;
  /** `type:"permission"` ask-time payload — the requested grant lifetime. Null for every other type. */
  permissionScope: PermissionScope | null;
  /** `type:"permission"` ask-time payload — an optional ISO expiry for the requested grant. Null for every other type. */
  permissionExpiresAt: string | null;
  /** `type:"credential"` ask-time payload — the env var / config key name the agent expects the secret
   *  under once granted (a display hint, not itself wired to injection — see Question's own doc). Null for
   *  every other type. */
  credentialEnvVar: string | null;
  /** `type:"credential"` ask-time payload (card 193de09e, credential auto-provisioning v1) — the agent
   *  STATING INTENT to auto-provision the answered secret into a named Connection, never a grant: the
   *  human answer boundary is what actually creates/updates the Connection (see `provisionConnectionId`
   *  below). Only settable by manager/platform (lead) roles — see `buildQuestionAsk`'s role gate. Null for
   *  every other type, and null for a plain (non-provisioning) credential ask. */
  provisionTarget: ProvisionTarget | null;
  /** Set by the human answer boundary when `provisionTarget` was requested and provisioning succeeded —
   *  the id of the Connection the secret landed in (created, or updated if one by that name already
   *  existed). Null until answered, and null for a non-provisioning ask. */
  provisionConnectionId: string | null;
  /** Set by the human answer boundary alongside `provisionConnectionId`: "pending" when a profile binding
   *  was requested (`provisionTarget.binding`) but NOT YET applied — auto-binding is deliberately never
   *  done here, a human must confirm it elsewhere (card 12dc7fc9); "applied" is reserved for that future
   *  apply step (never written by the answer boundary itself). "none" when no provisioning was requested,
   *  or a provisioning ask has no binding to apply. */
  provisionBindingState: "none" | "pending" | "applied";
  state: QuestionState;
  /** Set by the human's answer; null for a pure-blocker/input/credential (or before answering). For
   *  `type:"permission"` this is `"authorize"` or `"deny"`. */
  chosenOption: string | null;
  /** Optional human note, set by the answer (freeform — the pure-blocker's only payload). Never set for
   *  `type:"credential"` — its answer is the envelope-encrypted secret, not this field. */
  note: string | null;
  createdAt: string;
  answeredAt: string | null;
  consumedAt: string | null;
  /** Set only when `state === "cancelled"`: the canceller's optional freeform reason (null if none given).
   *  Retained forever alongside the row — never cleared, never overwritten (a question can only be
   *  cancelled once, from "pending"). */
  cancelledReason: string | null;
  /** Set only when `state === "cancelled"`: which side cancelled it — the asking agent's own
   *  `question_cancel` MCP tool, or a human via `POST /api/questions/:id/dismiss`. Null otherwise. */
  cancelledBy: "agent" | "human" | null;
  /** Set only when `state === "cancelled"`: when the cancellation landed. Null otherwise. */
  cancelledAt: string | null;
}

/**
 * A Question enriched with the joined display fields the web decision-inbox surfaces need (card 8701bdbb,
 * child B): the asking manager/agent's display `agentName`, the owning `projectName`, and whether that
 * asking session is still live (`sessionLive` — gates the "jump to live session" / "nudge mgr" affordances).
 * Returned by the human-only read routes GET /api/questions (the global "waiting on me" inbox) and
 * GET /api/questions/:id (the answer page). The write path stays the bare Question (the answer route).
 */
export interface QuestionInboxItem extends Question {
  agentName: string;
  projectName: string;
  sessionLive: boolean;
  /**
   * The asking session is CONFIRMED gone for good — no resume will ever bring it back to consume an
   * answer. True when its row was hard-deleted (a permanent-delete of an archived session) or a resume
   * attempt already proved it unresumable (`resumability === 'dead'`: the engine transcript or worktree
   * is gone). Distinct from merely `!sessionLive`: a stopped/archived/parked/rate-limited session recovers
   * fine on a later resume (the answered-stuck watchdog + question_pull pick it up once it's live again) —
   * only THIS flag means the normal pending→answered→consumed lifecycle can structurally never complete.
   */
  sessionOrphaned: boolean;
}

/**
 * A PENDING profile→connection grant awaiting the owner's deliberate approval (credential
 * auto-provisioning v1 binding UX, card 12dc7fc9 — "Direction B"). Derived, READ-ONLY display model: one
 * per answered credential Question whose `provisionBindingState === "pending"` — i.e. the asking agent
 * requested (at ask time, via `provisionTarget.binding.profileId`) that the just-provisioned Connection be
 * allowlisted onto a Profile, but auto-binding was DELIBERATELY never done. The owner reviews these in the
 * Settings "Pending bindings" queue and grants one only by an explicit Save on the Profile's connection
 * allowlist — the binding is never a side effect of answering. Surfaced by the human-only loopback read
 * `GET /api/pending-bindings`; there is NO write surface here (the grant reuses the existing human-only
 * profile-edit REST — writing `Profile.connections` stays an owner-only trust decision).
 */
export interface PendingBinding {
  /** The answered credential Question this pending binding was recorded on. */
  questionId: string;
  /** The Connection the answered secret was provisioned into (created at the answer boundary). */
  connectionId: string;
  /** The Connection's current name (from the live row; falls back to the ask-time `provisionTarget` name
   *  if the connection was since revoked). */
  connectionName: string;
  /** The Connection's target host, for display; null if the connection row is gone. */
  connectionHost: string | null;
  /** The Profile the grant was requested for (`provisionTarget.binding.profileId`). */
  profileId: string;
  /** That Profile's current name; falls back to the raw id if the profile was since deleted. */
  profileName: string;
  /** True when the connection is ALREADY on the profile's allowlist — the grant is effectively satisfied
   *  and "Review & grant" is a no-op the owner can dismiss (nothing left to Save). */
  alreadyGranted: boolean;
  /** Display name of the agent whose session asked for the credential (who requested the grant); "?" if
   *  the asking session/agent was since hard-deleted. */
  agentName: string;
  /** The owning project's id + name (a credential ask is always project-scoped). */
  projectId: string;
  projectName: string;
  /** When the credential was answered (the moment the binding became pending); falls back to the ask's
   *  createdAt for a legacy row with no answeredAt. */
  requestedAt: string;
}

/**
 * A Loom-managed skill (a SKILL.md playbook in the Loom skill store, ~/.loom/skills/<name>). These
 * are delivered to every session as project-local skills (shadowing the user's personal ones) and
 * are editable in the UI. `bundled` = a same-named skill ships with Loom (so the UI can offer reset).
 */
export interface SkillSummary {
  name: string;
  description: string;
  bundled: boolean;
  /** Bundled skills only: the user's store SKILL.md (`mine`) differs from the `base` snapshot — they edited it. */
  customized?: boolean;
  /** Bundled skills only: Loom shipped a newer asset than the `base` snapshot — an update is available to adopt. */
  updateAvailable?: boolean;
}

// --- Context-window sizing -------------------------------------------------------------------
/** Fallback window for an unknown / not-yet-measured model — the classic Claude context size. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;
/** Fraction of the window at which a ctx meter flips to the amber "getting full" tone. */
export const CONTEXT_WARN_RATIO = 0.6;
// Map a model id to its context window. The transcript reports a BARE model id (e.g.
// "claude-opus-4-8") with no signal of the 1M-context beta, so we size by the model's MAX
// attainable window: Claude 4.x Opus/Sonnet run with the 1M beta in this deployment, and the
// Claude 5 flagship family (Opus/Sonnet/Fable 5) ships with a genuine 1M window natively. An
// explicit "1m" in the id always wins. Unknown models fall back to DEFAULT_CONTEXT_WINDOW.
// Haiku is deliberately excluded (small/fast tier, genuinely 200k). Adjust here if you run a
// 4.x/5.x model pinned to the smaller 200k window.
const CONTEXT_WINDOW_BY_MODEL: { match: RegExp; window: number }[] = [
  { match: /1m/i, window: 1_000_000 },                       // an explicit 1M-context model id
  { match: /opus-4|sonnet-4/i, window: 1_000_000 },          // Claude 4.x Opus/Sonnet — 1M-context beta
  { match: /opus-5|sonnet-5|fable-5/i, window: 1_000_000 },  // Claude 5 flagship family — native 1M
];
/** Resolve a session's context window from its (possibly null) model id. */
export function contextWindowForModel(model?: string | null): number {
  if (!model) return DEFAULT_CONTEXT_WINDOW;
  for (const { match, window } of CONTEXT_WINDOW_BY_MODEL) if (match.test(model)) return window;
  return DEFAULT_CONTEXT_WINDOW;
}
