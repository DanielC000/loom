import { z } from "zod";
import type { Profile, ProfileWideningFields, SessionRole } from "@loom/shared";
import { AGENT_FORBIDDEN_PROFILE_KEYS, RETIRED_PROFILE_CREDENTIAL_KEYS } from "@loom/shared";
import { CODEX_RESTRICTED_TOOLS_REASON, codexStdioCapabilityReason, codexStdioOffenders, TRANSCRIPT_ROOT_DENY_ROLES, codexTranscriptRoleUnsupportedReason } from "./codex-compat.js";
import { codexProviderShapeError } from "./codex-provider.js";

/**
 * The ONE spelling of the harness enum's runtime values. Shared by the profile validator below and the
 * default-harness config validators (`mcp/platform.ts`, card 66b1b40d) so a third harness is added once.
 */
export const HARNESS_ID_SCHEMA = z.enum(["claude", "codex"]);

/**
 * The ONE spelling of the Profile role enum's runtime values. Exported so a caller that needs "every
 * role" (e.g. `mcp/setup.ts`'s `SETUP_LOCKED_ROLES`, deriving "every role except manager/worker") reads
 * it from here via `.options` rather than hand-copying the list — a hand-copy is exactly how a future
 * role addition silently stays OFF such a derived set instead of failing closed onto it.
 */
// "setup" IS a valid profile role (the Setup Assistant rig). (End-User Platform tier B1.)
// "assistant" (the long-lived Loom Companion) is a valid, low-privilege profile role — profile-spawnable
// like manager/worker. Its surface is NOT just my_context + chat_reply (a stale undercount that
// propagated into at least one defect report, card 4fc458c1): the unconditional base is
// my_context + notify_lead, plus (gated on the companion binding/grants) chat_reply, the
// skill_*/memory_*/wake_*/reminder_*/board_* tools, and the opt-in capability-lever framework
// (session-status, media-out, session-steer, session-spawn, authored-content-grant) — see
// mcp/orchestration.ts's buildServer, role === "assistant" branch, for the real registration. The
// ungated Setup operator still can't mint one (setupRoleError's allowlist omits it) — human REST / dev only.
// (The former "operator" role was retired by card 7f6c1cbb; a stored one is migrated to null at boot.)
//
// @decision 71bcb207 — "auditor"/"workspace-auditor" are in this enum so an edit to an already-
// existing bundled profile of either role doesn't 400 on its own pre-existing value, but
// `roleCarryForwardOnlyError` below still rejects any write that MINTS or REASSIGNS either role.
export const PROFILE_ROLE_SCHEMA = z.enum(["manager", "worker", "platform", "setup", "assistant", "auditor", "workspace-auditor"]);

/**
 * Every profile role except manager/worker — "locked" in the 4d70cc06 sense: an elevated or
 * untrusted-input-driven rig. Two consumers share this ONE set (never hand-copy it):
 *  - `mcp/setup.ts`'s `SETUP_LOCKED_ROLES` — roles the ungated setup surface may never rebind/clear/
 *    rewrite once assigned (card 4d70cc06).
 *  - `skills/inject.ts` — roles whose session must never ambiently receive an AGENT-authored user-store
 *    skill under the deliver-all default (card 509176c8); a human-authored one, or an explicit
 *    human-set profile subset, still flows.
 * Derived from `PROFILE_ROLE_SCHEMA.options` so a role added to the enum later is locked here
 * automatically, never silently left touchable/open until someone remembers to add it by hand.
 */
export const LOCKED_PROFILE_ROLES = new Set<string>(PROFILE_ROLE_SCHEMA.options.filter((r) => r !== "manager" && r !== "worker"));

/**
 * Strict zod validator for a Profile's WRITABLE shape (everything but the server-assigned id),
 * mirroring validateProjectConfigOverride (mcp/platform.ts): `.strict()` rejects unknown keys (typo
 * guard) and types are checked. ONE validator the future write paths (P3 REST + platform-MCP) share.
 * Optional fields are normalized to their stored defaults, so the result is directly insertable once
 * an id is attached. (Phase-1 ships the validator with the model; nothing wires it to a tool yet.)
 */
const profileSchema = z
  .object({
    name: z.string().min(1),
    role: PROFILE_ROLE_SCHEMA.nullable().optional(),
    description: z.string().optional(),
    // @decision 8c27ae8e — human-only (AGENT_FORBIDDEN_PROFILE_KEYS below); an unreviewed allowDelta
    // entry (e.g. "Bash(*)") widens a rig's spawn permission allowlist, same trust class as gateCommand.
    allowDelta: z.array(z.string()).optional(),
    skills: z.array(z.string()).nullable().optional(),
    model: z.string().nullable().optional(),
    icon: z.string().nullable().optional(),
    // @decision 8c27ae8e — browserTesting is human-only (AGENT_FORBIDDEN_PROFILE_KEYS below).
    //
    // Opt-in browser-automation capability (default off). The Playwright MCP itself additionally
    // disallows its RCE-equivalent browser_run_code_unsafe tool regardless of who granted this flag —
    // see PLAYWRIGHT_DISALLOWED_TOOLS (pty/host.ts).
    browserTesting: z.boolean().optional(),
    // @decision 8c27ae8e — documentConversion is human-only (AGENT_FORBIDDEN_PROFILE_KEYS below).
    //
    // Opt-in document-conversion capability (default off): launches a host markitdown process.
    documentConversion: z.boolean().optional(),
    // @decision be8be211 — vaultWrite is human-only (AGENT_FORBIDDEN_PROFILE_KEYS below).
    //
    // Opt-in confined vault-write capability (default off), gates the `vault_write` tool. A write grant
    // into a human-reviewed corpus is exfil/tamper-adjacent, rejected even on the elevated Setup
    // Assistant's/Platform Lead's own profile-writing tools.
    vaultWrite: z.boolean().optional(),
    // @decision 8c27ae8e — restrictedTools stays OUT of AGENT_FORBIDDEN_PROFILE_KEYS below: it only
    // RESTRICTS a rig's own tool surface rather than granting a new one, so it remains settable via the
    // Setup Assistant's/Platform Lead's own profile-writing tools.
    //
    // Opt-in RESTRICTED-tools (default off). Blast-radius control for a chat-reachable Companion: when on,
    // the curated dangerous native tools (Bash/Edit/Write/NotebookEdit/MultiEdit) are appended to
    // --disallowedTools at spawn. A companion (assistant role) has no profile write tool of its own
    // either way, so it can never self-widen.
    restrictedTools: z.boolean().optional(),
    // @decision 8c27ae8e — noCommit stays OUT of AGENT_FORBIDDEN_PROFILE_KEYS below: it only declares
    // lifecycle behavior rather than granting a new capability, so it remains settable via the Setup
    // Assistant's/Platform Lead's own profile-writing tools.
    //
    // Declared no-commit role (default off). Lifecycle-only flag (no spawn-time host capability) — a
    // 0-commit done auto-retires + skips the forgot-to-commit warning.
    noCommit: z.boolean().optional(),
    // @decision afe1bc90 — `connections`/`capabilities` are NOT profile fields any more: credential
    // grants live on the AGENT row only. A payload naming either is rejected by
    // `retiredProfileCredentialKeysError` (named error), and `.strict()` would reject it anyway.
    // Multi-harness epic (df1f94b0) Phase 1, card 353f6dc4: which vendor CLI a session under this rig
    // spawns as. Human-only (AGENT_FORBIDDEN_PROFILE_KEYS below): selecting which BINARY gets spawned
    // is the same trust class as gateCommand — rejected even on the elevated Setup Assistant's/Platform
    // Lead's own profile-writing MCP tools, human REST is the ONLY grant path.
    harness: HARNESS_ID_SCHEMA.optional(),
    // Card 2ef54430: opt-in custom codex model-provider endpoint. Human-only (AGENT_FORBIDDEN_PROFILE_KEYS):
    // it bills the key in the referenced Connection. Shape rules live in `codexProviderShapeError`; the
    // connection binding is checked by the REST handlers (`codexProviderBindingError`), like capabilities.
    codexProvider: z.object({
      id: z.string(),
      baseUrl: z.string().optional(),
      connectionId: z.string().optional(),
    }).strict().nullable().optional(), // null = clear (updateProfile: undefined leaves the column, null clears it)
  })
  .strict();

/**
 * The profile validator's field-name enumeration, DERIVED from `profileSchema.shape` — never
 * hand-copied — so a future field added to the schema above is picked up automatically by any
 * consumer that enumerates this list (card d34dd208: `profile-field-consumer-guard.mjs` uses this
 * to detect a validator-accepted field with no registered per-harness consumption declaration).
 * A hand-copied list would drift the exact way `STATIC_GUARD_REPO_PATHS`'s own folk-recipe drifted
 * (CLAUDE.md's "ENUMERATE, NOT COUNT" discipline) — this can't, since it reads the schema itself.
 */
export const PROFILE_FIELD_NAMES = Object.keys(profileSchema.shape) as (keyof z.infer<typeof profileSchema>)[];

/**
 * Profile keys that must NEVER be settable through an agent MCP tool, even the elevated Setup
 * Assistant / Platform Lead profile writers that otherwise share this same strict validator for every
 * other field. Mirrors `agentOrchestrationOverride`'s omission of `gateCommand`/`alertWebhook` (mcp/
 * platform.ts) — `connections` grants access to REAL external secrets (P1 credential store); `capabilities`
 * (agent-tooling P4) gets the same posture, since a grant launches a host process and can bind egress via
 * a P1 connection, owner-only end-to-end.
 *
 * @decision be8be211 — `vaultWrite`: a write grant into a human-reviewed vault corpus is
 * exfil/tamper-adjacent.
 *
 * `harness` (multi-harness epic df1f94b0 Phase 1, card 353f6dc4): selecting which vendor BINARY a
 * session spawns is the same trust class as `gateCommand`, per an explicit lead ruling on that card.
 *
 * @decision 8c27ae8e — `browserTesting`/`documentConversion`/`allowDelta` must never be settable by an
 * elevated profile-writing agent (previously writable here by omission, not decision); `allowDelta` is
 * the same trust class as `gateCommand` — an unreviewed entry (e.g. `Bash(*)`) widens the spawn allowlist.
 *
 * An elevated profile-writing agent must never be able to grant itself (or any other rig) one of these
 * capabilities.
 *
 * ⚠️ THE ARRAY ITSELF NOW LIVES IN `@loom/shared` (`shared/src/profileGrants.ts`, card `3c4e0df6`) and is
 * re-exported here so every existing daemon-side reader is untouched. It moved because the Profiles
 * EDITOR has to decide, before it sends a save, whether that save widens one of these — and a web-side
 * re-spelling of this list would drift silently (nothing on this side type-checks it). Add a key THERE;
 * the two exhaustive Records below, and `addedProfileGrants`'s own, all fail to compile until it is
 * handled in each.
 *
 * Imported, not re-exported: this module's own public surface is unchanged by the move.
 */

/**
 * @decision 8c27ae8e — each forbidden key's rejection message must name ITS OWN reason, not one generic
 * "grants access to real external secrets" line: that was only ever true of connections/capabilities,
 * and was misleading for harness/vaultWrite/browserTesting/documentConversion/allowDelta.
 */
const AGENT_FORBIDDEN_PROFILE_KEY_REASONS: Record<(typeof AGENT_FORBIDDEN_PROFILE_KEYS)[number], string> = {
  vaultWrite: "it grants write access into a human-reviewed vault corpus",
  harness: "it selects which vendor CLI binary a session spawns — the same trust class as gateCommand",
  browserTesting: "it launches a per-session browser-automation capability (arbitrary web navigation)",
  documentConversion: "it launches a host subprocess (markitdown) capability",
  allowDelta: "an unreviewed entry (e.g. \"Bash(*)\") widens a rig's spawn permission allowlist — the same trust class as gateCommand",
  codexProvider: "it points the codex harness at a model endpoint billed to a stored Connection's API key — a spend surface",
};

/**
 * Reject a RAW create/patch payload (BEFORE any merge with an existing profile) that tries to set a
 * human-only key. Callers (setup.ts / platform.ts profile_create/profile_update) run this on the
 * caller-supplied input alone — never on a merged whole — so an unrelated patch to a profile that
 * ALREADY has `connections` set (via human REST) passes through untouched: the forbidden key is only
 * rejected when the AGENT's own payload tries to introduce/change it. Returns an error string, or null
 * when the payload is clean.
 */
export function agentProfileKeyError(raw: unknown): string | null {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const key of AGENT_FORBIDDEN_PROFILE_KEYS) {
      if (key in (raw as Record<string, unknown>)) {
        return `${key} may not be set via an agent MCP tool — ${AGENT_FORBIDDEN_PROFILE_KEY_REASONS[key]} (human-only, via the Profiles UI / REST)`;
      }
    }
  }
  return null;
}

/**
 * Per-key "is this human-set capability actually carried" predicate for the carry-over check below. An
 * EXHAUSTIVE Record keyed off `AGENT_FORBIDDEN_PROFILE_KEYS` (card 05153988 round 2) — not a hand-rolled
 * if-chain re-listing the keys — so a key added to that array without a matching entry here fails to
 * compile, rather than silently never being checked by `roleChangeCapabilityCarryoverError`.
 */
const AGENT_FORBIDDEN_PROFILE_KEY_CARRIED: Record<
  (typeof AGENT_FORBIDDEN_PROFILE_KEYS)[number],
  (existing: Pick<Profile, (typeof AGENT_FORBIDDEN_PROFILE_KEYS)[number]>) => boolean
> = {
  vaultWrite: (existing) => !!existing.vaultWrite,
  harness: (existing) => existing.harness != null && existing.harness !== "claude",
  browserTesting: (existing) => !!existing.browserTesting,
  documentConversion: (existing) => !!existing.documentConversion,
  allowDelta: (existing) => existing.allowDelta.length > 0,
  codexProvider: (existing) => !!existing.codexProvider,
};

/**
 * Shared by {@link roleChangeCapabilityCarryoverError} and {@link explicitRoleGrantCarryoverError} —
 * which forbidden-key grants `existing` actually carries, in `AGENT_FORBIDDEN_PROFILE_KEYS` order.
 */
function carriedForbiddenGrants(
  existing: Pick<Profile, (typeof AGENT_FORBIDDEN_PROFILE_KEYS)[number]>,
): (typeof AGENT_FORBIDDEN_PROFILE_KEYS)[number][] {
  return AGENT_FORBIDDEN_PROFILE_KEYS.filter((key) => AGENT_FORBIDDEN_PROFILE_KEY_CARRIED[key](existing));
}

/** Human-readable `key (reason), key (reason), …` for a `carriedForbiddenGrants` result. */
function describeCarriedGrants(carried: (typeof AGENT_FORBIDDEN_PROFILE_KEYS)[number][]): string {
  return carried.map((k) => `${k} (${AGENT_FORBIDDEN_PROFILE_KEY_REASONS[k]})`).join(", ");
}

/**
 * @decision 05153988 — refuses an AGENT `profile_update` role CHANGE when the stored profile carries a
 * human-set capability; deliberately includes `browserTesting`, unlike the assign-time checks below.
 */
export function roleChangeCapabilityCarryoverError(
  previousRole: string | null | undefined,
  newRole: string | null | undefined,
  existing: Pick<Profile, (typeof AGENT_FORBIDDEN_PROFILE_KEYS)[number]>,
): string | null {
  if ((previousRole ?? null) === (newRole ?? null)) return null; // not a role change
  const carried = carriedForbiddenGrants(existing);
  if (carried.length === 0) return null;
  return `cannot change role: this profile carries human-set ${describeCarriedGrants(carried)} — ask the human to change the role in the Profiles UI`;
}

/**
 * @decision 509176c8 — do not let an agent-facing profile write set a non-empty explicit `skills`
 * subset on a LOCKED-role profile — it bypasses `isTrustedForLockedRole`'s deliver-all filter. Checked
 * own-key-present on the RAW payload/patch, mirroring `agentProfileKeyError`; clearing (null/[]) stays allowed.
 */
export function agentLockedRoleSkillsError(raw: unknown, resolvedRole: string | null | undefined): string | null {
  if (resolvedRole == null || !LOCKED_PROFILE_ROLES.has(resolvedRole)) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !("skills" in (raw as Record<string, unknown>))) return null;
  const skills = (raw as Record<string, unknown>).skills;
  if (!Array.isArray(skills) || skills.length === 0) return null; // clearing/omitting is a reduction, always allowed
  return `skills may not be set to a non-empty subset via an agent MCP tool on a profile whose role is "${resolvedRole}" (elevated/locked) — an explicit subset bypasses the locked-role skill-trust filter (record 509176c8), so a non-empty subset is human-only here too (via the Profiles UI / REST); clearing it (null/[]) is allowed`;
}

/**
 * @decision 509176c8 — do not let a role-change patch that never mentions `skills` carry a stored
 * non-empty subset onto a newly-locked role (the two-call bypass of {@link agentLockedRoleSkillsError}).
 * Checked against the MERGED (post-patch) `skills`, not the stored value — a same-call clear is allowed.
 */
export function roleChangeLockedSkillsCarryoverError(
  previousRole: string | null | undefined,
  newRole: string | null | undefined,
  mergedSkills: string[] | null | undefined,
): string | null {
  if ((previousRole ?? null) === (newRole ?? null)) return null; // not a role change
  if (newRole == null || !LOCKED_PROFILE_ROLES.has(newRole)) return null; // only guards a flip INTO a locked role
  if (!mergedSkills || mergedSkills.length === 0) return null;
  return `cannot change role to "${newRole}": the resulting profile would carry a non-empty skills subset — that is human-only to set on an elevated/locked role (record 509176c8) — ask the human to change the role in the Profiles UI, or clear skills in the same patch`;
}

/**
 * @decision 509176c8 — do not let a locked SESSION role inject a skills subset that came from a profile
 * whose OWN role differs (an explicit-role divergence) — drop it, falling back to injectSkills' own
 * trust-filtered deliver-all. Pure; pair with `SessionService.recordSkillsDropped` for the audit trail.
 */
export function sessionSkillsForRole(
  sessionRole: SessionRole | null | undefined,
  profileRole: SessionRole | null | undefined,
  skills: string[] | null | undefined,
): { skills: string[] | null; dropped: boolean } {
  const normalized = skills && skills.length ? skills : null;
  if (normalized == null) return { skills: null, dropped: false };
  if (sessionRole == null || !LOCKED_PROFILE_ROLES.has(sessionRole)) return { skills: normalized, dropped: false };
  if ((profileRole ?? null) === sessionRole) return { skills: normalized, dropped: false };
  return { skills: null, dropped: true };
}

/** Human-readable reason for a `sessionSkillsForRole` drop — shared by every `recordSkillsDropped` caller. */
export function lockedRoleSkillsDroppedReason(sessionRole: SessionRole, profileRole: SessionRole | null): string {
  return `an explicit-role divergence (session role "${sessionRole}" vs the bound profile's own role "${profileRole ?? "null"}") dropped this session's skills subset — it fell back to the locked-role trust-filtered deliver-all (record 509176c8)`;
}

/**
 * @decision acd3c688 — the spawn-time sibling of `roleChangeCapabilityCarryoverError`: refuses an
 * explicit-role session MINT whose bound profile's own role differs and carries a forbidden-key grant.
 * `harness` and null→worker are both exempted below — see the decision record for why.
 */
export function explicitRoleGrantCarryoverError(
  profileRole: SessionRole | null | undefined,
  explicitRole: SessionRole | undefined,
  existing: Pick<Profile, (typeof AGENT_FORBIDDEN_PROFILE_KEYS)[number]>,
  agentOwnGrants: { connections?: string[] | null; capabilities?: { slug: string; connectionId?: string }[] | null },
  /** Provenance of grants fanned out from a role:null profile (`Db.getFanoutExemption`); exempts ONLY the null→worker leg. */
  fanoutExempt?: { connections: string[]; capabilities: string[] },
): string | null {
  if (explicitRole === undefined) return null; // no explicit role ⇒ nothing to diverge from; forcePlain drops BOTH the profile's and the agent row's grants upstream (resolveAgentSpawn), so it carries none
  if ((profileRole ?? null) === explicitRole) return null; // no divergence
  if (profileRole == null && explicitRole === "worker") {
    // @decision caca806c (round 3) — keys on the AGENT ROW's OWN connections/capabilities, regardless of
    // whether a profile is bound at all; a BOUND role-less profile's own grant stays fully exempt
    // (acd3c688) because it is never folded into `agentOwnGrants` here — only the agent row's raw fields are.
    // @decision afe1bc90 — grants fanned out from a role:null profile keep the exemption they had before the
    // migration; anything else on the agent row (caca806c-era own grants, later human grants) is still refused.
    const carriedByAgent = agentCarriedCredentialGrants({
      connections: (agentOwnGrants.connections ?? []).filter((id) => !fanoutExempt?.connections.includes(id)),
      capabilities: (agentOwnGrants.capabilities ?? []).filter((g) => !fanoutExempt?.capabilities.includes(g.slug)),
    });
    if (carriedByAgent.length > 0) {
      return `cannot spawn as role "worker": this agent carries its own human-set ${carriedByAgent.map((k) => `${k} (${AGENT_CREDENTIAL_GRANT_REASONS[k]})`).join(", ")} — ask the human to authorize this spawn, or remove the agent-level grant`;
    }
    return null;
  }
  const carried = carriedForbiddenGrants(existing).filter(
    (key) => !(key === "harness" && TRANSCRIPT_ROOT_DENY_ROLES.has(explicitRole)),
  );
  // Card afe1bc90: credential grants are agent-only now, so the diverging-role leg must read the AGENT
  // ROW's own grants too (the profile can no longer carry them) — same non-empty check, same wording.
  const agentCarried = agentCarriedCredentialGrants(agentOwnGrants);
  if (carried.length === 0 && agentCarried.length === 0) return null;
  const described = [
    ...agentCarried.map((k) => `${k} (${AGENT_CREDENTIAL_GRANT_REASONS[k]})`),
    ...(carried.length > 0 ? [describeCarriedGrants(carried)] : []),
  ].join(", ");
  return `cannot spawn as role "${explicitRole}": the bound profile's own role is "${profileRole ?? "null"}" and it (or this agent) carries human-set ${described} — ask the human to authorize this spawn, or rebind a profile without them`;
}

/** Reasons for the two AGENT-ROW credential grants (card afe1bc90: the only home of these grants now). */
const AGENT_CREDENTIAL_GRANT_REASONS = {
  connections: "it grants access to real external secrets",
  capabilities: "a grant can launch a host process and bind egress via a P1 connection",
} as const;

/** Which of the two agent-row credential grants `grants` actually carries (non-empty). */
function agentCarriedCredentialGrants(
  grants: { connections?: string[] | null; capabilities?: { slug: string; connectionId?: string }[] | null },
): (keyof typeof AGENT_CREDENTIAL_GRANT_REASONS)[] {
  const out: (keyof typeof AGENT_CREDENTIAL_GRANT_REASONS)[] = [];
  if (grants.connections && grants.connections.length > 0) out.push("connections");
  if (grants.capabilities && grants.capabilities.length > 0) out.push("capabilities");
  return out;
}

/**
 * @decision afe1bc90 — REJECTS (never silently drops) a profile create/update payload naming
 * `connections` or `capabilities`: credential grants moved onto the AGENT row, and the profile columns
 * are dormant. Checked on the RAW payload by `validateProfile` (so every REST + MCP profile writer gets
 * it) and names the agent endpoint so the caller knows where the grant now goes.
 */
export function retiredProfileCredentialKeysError(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const hit = RETIRED_PROFILE_CREDENTIAL_KEYS.filter((k) => k in (raw as Record<string, unknown>));
  if (hit.length === 0) return null;
  return `${hit.join("/")} are no longer profile fields — credential grants are per-AGENT now: set them on the agent via POST /api/agents/:id (human-only, in the agent editor), not on the profile`;
}

/**
 * @decision afe1bc90 — an agent-level `capabilities` grant is stdio-shaped like a profile's was; codex
 * mounts no stdio server, so a codex-profiled agent must not carry one (it would silently do nothing).
 */
export function agentCapabilitiesCodexProfileError(
  agentCapabilities: readonly { slug: string; connectionId?: string }[] | null | undefined,
  boundProfileHarness: string | null | undefined,
): string | null {
  if (boundProfileHarness !== "codex") return null;
  if (!agentCapabilities || agentCapabilities.length === 0) return null;
  const offending = codexStdioOffenders({ capabilities: [...agentCapabilities] });
  return offending.length === 0 ? null : `cannot grant capabilities to this agent: its bound profile runs the codex harness — ${codexStdioCapabilityReason(offending)}`;
}

/**
 * Role/harness flip leg: refuses a profile_update that flips a profile onto codex while ANY bound agent
 * carries its own capabilities (same helper shape as {@link boundAgentCredentialGrantRoleChangeError}).
 */
export function boundAgentCapabilitiesCodexFlipError(
  boundAgents: readonly { capabilities?: { slug: string; connectionId?: string }[] | null }[],
  previousHarness: string | null | undefined,
  newHarness: string | null | undefined,
): string | null {
  if (newHarness !== "codex" || previousHarness === "codex") return null;
  if (!boundAgents.some((a) => a.capabilities && a.capabilities.length > 0)) return null;
  return "cannot switch this profile to the codex harness: at least one agent bound to it carries its own capabilities grant, and codex mounts no stdio capability servers — remove the agent-level capabilities first (agent editor)";
}

/** The two profile axes that, changed under an agent carrying its own grant, put that grant in a different trust context. */
export type AgentGrantWideningAxisFields = { role?: string | null; restrictedTools?: boolean | null };

/**
 * @decision caca806c — the ONE discriminator behind both agent-grant guards below; never add a parallel check.
 * Callers pass resolved fields (unbind/deleted profile = `PROFILE_DELETE_BACKSTOP_FIELDS`); restrictedTools: true→false only.
 */
export function agentGrantWideningAxes(
  before: AgentGrantWideningAxisFields,
  after: AgentGrantWideningAxisFields,
): ("role" | "restrictedTools")[] {
  const axes: ("role" | "restrictedTools")[] = [];
  if ((before.role ?? null) !== (after.role ?? null)) axes.push("role");
  if (before.restrictedTools && !after.restrictedTools) axes.push("restrictedTools");
  return axes;
}

function widenedContextClause(axes: readonly ("role" | "restrictedTools")[], before: AgentGrantWideningAxisFields, after: AgentGrantWideningAxisFields): string {
  const parts: string[] = [];
  if (axes.includes("role")) parts.push(`change its resolved role from "${before.role ?? "null"}" to "${after.role ?? "null"}"`);
  if (axes.includes("restrictedTools")) parts.push("remove its tool restriction (restrictedTools)");
  return parts.join(" and ");
}

/**
 * @decision caca806c — an agent-facing REBIND refuses when the AGENT ROW carries a grant and the resolved
 * role changes or restrictedTools is removed; reads the agent's own grants, not the profile's.
 */
export function agentCredentialGrantRoleChangeOnRebindError(
  agentGrants: { connections?: string[] | null; capabilities?: { slug: string; connectionId?: string }[] | null },
  before: AgentGrantWideningAxisFields,
  after: AgentGrantWideningAxisFields,
): string | null {
  const axes = agentGrantWideningAxes(before, after);
  if (axes.length === 0) return null;
  const carried = agentCarriedCredentialGrants(agentGrants);
  if (carried.length === 0) return null;
  return `cannot rebind: this agent carries its own ${carried.join(", ")} grant, and this rebind would ${widenedContextClause(axes, before, after)} — ask the human to rebind this agent's profile in the Profiles/Agents UI`;
}

/**
 * @decision caca806c — shared by every profile_update/profile_delete handler: refuses a role change or
 * restrictedTools removal while ANY bound agent carries its own grant. A delete passes (existing, backstop).
 */
export function boundAgentCredentialGrantRoleChangeError(
  boundAgents: readonly { connections?: string[] | null; capabilities?: { slug: string; connectionId?: string }[] | null }[],
  before: AgentGrantWideningAxisFields,
  after: AgentGrantWideningAxisFields,
): string | null {
  const axes = agentGrantWideningAxes(before, after);
  if (axes.length === 0) return null;
  const offending = boundAgents.some((a) => agentCarriedCredentialGrants(a).length > 0);
  if (!offending) return null;
  return `cannot ${axes.includes("role") ? "change role" : "remove the tool restriction"}: at least one agent bound to this profile carries its own human-set connections/capabilities grant, and this change would ${widenedContextClause(axes, before, after)} — ask the human to do it in the Profiles UI`;
}

/**
 * @decision 3de74275 — do not skip this at an assignment call site believing `agentProfileKeyError` at
 * mint time already covers it: a human-minted profile can independently carry `connections`/
 * `capabilities`/`vaultWrite`, and BINDING an existing such profile was never checked anywhere.
 *
 * Two DISTINCT reasons a caller may want the role branch skipped — kept as separate options rather than
 * one overloaded flag (fix round, card `a06650d2`: the clone path's old reuse of `allowElevatedRoles` to
 * mean "skip, it's handled elsewhere" was byte-identical to Platform Lead's real-widening use of the same
 * flag, which made the two impossible to tell apart at a call site):
 *  - `allowElevatedRoles: true` — genuine widening. ONLY the Platform Lead's direct `profile_assign`/
 *    `agent_update`/`agent_create` (administering its own elevated rigs is its job).
 *  - `skipRoleCheck: true` — the role axis is being checked by the CALLER's own narrower mechanism
 *    instead (e.g. clone's `operator`/`isPlatformProfile` check, below) — never widens WHO may bind an
 *    elevated role, only avoids double-checking a role that was already vetted a different way.
 * Neither option ever lifts the field checks below (this function's own human-only-field list) — ONLY
 * `humanAuthorized: true` does that, and ONLY the field checks: see the delta-review ruling on card
 * `a06650d2` (the 3de74275 record's "Fix round" section) for why the field axis is fail-CLOSED by
 * default in every CORE (`createAgentCore`/`cloneAgentCore`, `applyWorkflowTemplate`) and needs this
 * explicit opt-out, set ONLY by the two bearer-guarded human-only REST routes that call those cores
 * directly (`gateway/server.ts`'s `/api/companion/provision` auto-clone and `/api/setup/templates/apply`)
 * — never by an agent-facing MCP tool. `humanAuthorized` never affects the ROLE branch above, which stays
 * unconditional for every caller (role eligibility on a template/clone predates this card entirely and
 * was never meant to be REST-exempt).
 *
 * Returns an error string, or null when the profile is safe to bind via an agent-facing tool, OR (with
 * `humanAuthorized`) via one of the two named human-only REST routes.
 *
 * @decision 3de74275 — card `1f52bc75` extended the field axis to documentConversion/harness("codex")/
 * non-empty allowDelta; browserTesting stays deliberately unchecked. See the decision record for why.
 */
export function agentAssignableProfileError(
  profile: Pick<Profile, "role" | "vaultWrite" | "documentConversion" | "harness" | "allowDelta"> & Partial<Pick<Profile, "codexProvider">>,
  opts?: { allowElevatedRoles?: boolean; skipRoleCheck?: boolean; humanAuthorized?: boolean },
): string | null {
  if (!opts?.allowElevatedRoles && !opts?.skipRoleCheck && profile.role != null && LOCKED_PROFILE_ROLES.has(profile.role)) {
    return `cannot assign profile: role "${profile.role}" is elevated/locked — it may not be bound via this tool (human-only, via the Profiles UI / REST)`;
  }
  if (opts?.humanAuthorized) return null; // field checks below are the agent-surface-only axis; skip for the two named REST routes
  if (profile.vaultWrite) {
    return "cannot assign profile: it carries vaultWrite (write access into a human-reviewed vault corpus) — human-only, via the Profiles UI / REST";
  }
  if (profile.documentConversion) {
    return "cannot assign profile: it carries documentConversion (launches a host markitdown subprocess) — human-only, via the Profiles UI / REST";
  }
  if (profile.harness != null && profile.harness !== "claude") {
    return `cannot assign profile: it carries harness "${profile.harness}" (selects a different vendor CLI binary — the same trust class as gateCommand) — human-only, via the Profiles UI / REST`;
  }
  // Card 2ef54430: transitively covered by the harness check above (a provider requires harness "codex"), but
  // named on its own so this predicate stays correct if that coupling is ever relaxed.
  if (profile.codexProvider) {
    return "cannot assign profile: it carries a codexProvider (a model endpoint billed to a stored connection's key) — human-only, via the Profiles UI / REST";
  }
  if (profile.allowDelta && profile.allowDelta.length > 0) {
    return "cannot assign profile: it carries a non-empty allowDelta (widens the rig's spawn permission allowlist — the same trust class as gateCommand) — human-only, via the Profiles UI / REST";
  }
  return null;
}

/**
 * @decision 8b236b22 — a rebind can silently strip `restrictedTools` without touching either
 * profile's own fields; refuse only that widening direction, only on Setup + manager's
 * `agent_assign_profile`. See the decision record for why Platform/REST are exempt.
 */
export function agentRebindRestrictedToolsWideningError(
  before: ProfileWideningFields,
  after: ProfileWideningFields,
): string | null {
  if (!before.restrictedTools || after.restrictedTools) return null;
  return "rebinding would remove this agent's tool restriction (restrictedTools); ask the human to do it in the Profiles UI";
}

/** The narrow db surface `capabilityGrantBindingError` needs — mirrors the read-only slice of
 *  CapabilitiesDbStore/ConnectionsDbStore (capabilities/registry.ts, connections/store.ts) it consults. */
export interface CapabilityGrantBindingDbStore {
  getCapabilityDefBySlug(slug: string): { requiresConnection: boolean } | undefined;
  getConnection(id: string): { authScheme: string } | undefined;
}

/**
 * @decision sha:8fbb634c — an oauth2 connection's secret can never resolve as a static env var, so
 * binding one to a `requiresConnection` capability grant must be rejected here, not left to silently
 * spawn a session credential-less.
 *
 * Called AFTER `validateProfile`, on its already-normalized `capabilities` array — human-only (the REST
 * surface POST/PUT /api/profiles, gateway/server.ts), never an agent-writable path. Returns an error
 * string for the FIRST offending grant, or null when every grant's binding is sound.
 */
/** The ONLY auth schemes a `requiresConnection` capability grant may bind to — an ALLOWLIST, mirroring
 *  `connections/store.ts`'s `RAW_SECRET_AUTH_SCHEMES` (card f9972a3d, Code Review round 2): a denylist of
 *  the schemes known to need their own seam fails OPEN the moment a new scheme is added and nobody
 *  remembers to add it here too; this allowlist fails CLOSED for that same future scheme by construction. */
const STATICALLY_INJECTABLE_AUTH_SCHEMES = new Set(["api-key", "bearer"]);

export function capabilityGrantBindingError(
  grants: { slug: string; connectionId?: string }[],
  db: CapabilityGrantBindingDbStore,
): string | null {
  for (const g of grants) {
    if (!g.connectionId) continue;
    const def = db.getCapabilityDefBySlug(g.slug);
    if (!def?.requiresConnection) continue; // unknown slug / no static-injection grant ⇒ not this guard's concern
    const conn = db.getConnection(g.connectionId);
    if (!conn || STATICALLY_INJECTABLE_AUTH_SCHEMES.has(conn.authScheme)) continue;
    if (conn.authScheme === "oauth2") {
      return `capability '${g.slug}' is bound to an oauth2 connection, which can't be statically injected at spawn — oauth2 connections refresh on use via the authenticated_request tool instead. Bind an api-key/bearer connection here, or drop the connectionId and use authenticated_request for oauth2 access.`;
    }
    // @decision a3d5c7f4 — an ssh connection's secret is a private key, never a header-injectable static
    // secret; binding one here would try to inject it into a spawned process's env (never-echo violation).
    if (conn.authScheme === "ssh") {
      return `capability '${g.slug}' is bound to an ssh connection, which can't be statically injected at spawn — ssh connections are dispatched by Loom itself at call time, never a static env var. Bind an api-key/bearer connection here, or drop the connectionId.`;
    }
    return `capability '${g.slug}' is bound to a connection whose auth scheme ('${conn.authScheme}') can't be statically injected at spawn. Bind an api-key/bearer connection here, or drop the connectionId.`;
  }
  return null;
}

/**
 * @decision 8feb55b8 — `restrictedTools` must never resolve to `false` for an assistant-role profile by
 * silent omission (must be a RECORDED decision), and deliberately does NOT enforce `true` either — the
 * owner explicitly declined that (Request `34923f42`); only requiring a stated value is correct.
 *
 * Fires when the profile is BECOMING assistant-role for the first time — a fresh CREATE, or an UPDATE
 * whose patch transitions `role` INTO "assistant" from something else — and the caller's OWN submission
 * (the create payload, or the raw UN-MERGED patch on update) doesn't state `restrictedTools` as an own
 * key. It does NOT fire on an unrelated edit to an ALREADY-assistant profile (`previousRole ===
 * "assistant"`): every update call site (gateway/server.ts PUT, setup.ts, mcp/platform.ts
 * profile_update) validates `{ ...existingProfile, ...patch }`, so that case already carries a
 * previously-decided `restrictedTools` forward — re-forcing it on every unrelated save would be a
 * refusal with nothing new to decide, not a recorded choice.
 *
 * `submittedPatch` must be the CALLER'S raw, UN-MERGED input — never the merged `{ ...base, ...patch }`
 * object also passed as `validateProfile`'s first argument, which (once a base row exists) always shows
 * `restrictedTools` as "present" via the base row's own concrete value and could never distinguish a
 * genuine restatement from silent inheritance. `validateProfile` defaults this to its own `raw` param
 * when the caller passes no `opts.patch` (the CREATE shape, where raw already IS the full unmerged
 * submission).
 */
/**
 * Roles a profile write can never NEWLY confer — caller-set only via their dedicated start* path
 * (startAuditor / the future startWorkspaceAuditor, the real security boundary). Both are accepted by the
 * `role` enum above so an edit to an already-existing bundled profile of either role can still validate,
 * but this gate rejects the RESOLVED role whenever it names one of these two values AND differs from
 * `opts.previousRole`: a CREATE (no previousRole to match) or an UPDATE patch that changes role into or
 * out of either value. An UPDATE that leaves the role unchanged (the common case — an unrelated field
 * edit on an already-auditor/workspace-auditor profile) passes untouched.
 */
const ROLE_CARRY_FORWARD_ONLY = ["auditor", "workspace-auditor"] as const;

function roleCarryForwardOnlyError(
  resolvedRole: string | null | undefined,
  previousRole: string | null | undefined,
): string | null {
  const touchesRestricted =
    (resolvedRole != null && (ROLE_CARRY_FORWARD_ONLY as readonly string[]).includes(resolvedRole)) ||
    (previousRole != null && (ROLE_CARRY_FORWARD_ONLY as readonly string[]).includes(previousRole));
  if (!touchesRestricted) return null;
  if (resolvedRole === previousRole) return null; // unchanged carry-forward, not a new assignment
  return `role "${resolvedRole ?? "null"}" may not be set here — "auditor"/"workspace-auditor" are caller-set only via their dedicated start* path, never conferred by a profile write. An existing profile already carrying one of these roles may still be edited (other fields), just not have its role reassigned into or out of it through this validator.`;
}

function assistantRestrictedToolsOmittedError(
  resolvedRole: string | null | undefined,
  previousRole: string | null | undefined,
  submittedPatch: unknown,
): string | null {
  if (resolvedRole !== "assistant") return null;
  if (previousRole === "assistant") return null; // already decided; not this gate's concern
  const hasOwnKey =
    submittedPatch != null && typeof submittedPatch === "object" && !Array.isArray(submittedPatch) && "restrictedTools" in (submittedPatch as Record<string, unknown>);
  if (hasOwnKey) return null;
  return "restrictedTools must be stated explicitly (true or false) when a profile becomes assistant-role (create, or a role change into assistant) — a chat-reachable companion's blast radius is a deliberate choice, not a default. Set it to true (least-privilege, dangerous native tools withdrawn) or false (accept the risk) and resubmit.";
}

/**
 * Card `0770d916` (field-consumers.ts `restrictedTools` gap, `remedy: "no-mechanism-reject-or-warn"`):
 * codex's ENTIRE permission model is two coarse, session-wide levers (`sandbox_mode`/`approval_policy`) —
 * verified against the real OBSERVED pty probe (`docs/investigations/049e4a7b-codex-cli-capability-probe/
 * findings.md`), not assumed from docs. There is NO per-native-tool disallow concept for `restrictedTools`
 * to bind to on that harness, so silently accepting `harness:"codex"` + `restrictedTools:true` would leave
 * a profile that reads blast-radius-restricted in the UI while running with codex's full default
 * shell/file-write access — FAIL-OPEN for a safety-scoped field. Per this card's own DoD ("prefer
 * rejecting where the human is looking over failing silently at spawn"), reject the combination here,
 * where the human editing the profile sees it, rather than dropping it silently in createCodexPty.
 */
function codexRestrictedToolsUnsupportedError(harness: string | undefined, restrictedTools: boolean | undefined): string | null {
  if (harness === "codex" && restrictedTools === true) {
    return CODEX_RESTRICTED_TOOLS_REASON;
  }
  return null;
}

/**
 * Sibling of card `0770d916`'s `restrictedTools` fix above, same remedy shape:
 * "no-mechanism-reject-or-warn".
 *
 * @decision 7fa73e2c — `browserTesting`/`documentConversion`/`capabilities` are unconditionally
 * incompatible with `harness:"codex"` (all resolve to stdio; codex mounts only {type:"http"}) — reject
 * at validation time, where the human editing the profile sees it, never let it reach spawn silently.
 */
function codexStdioCapabilityUnsupportedError(
  harness: string | undefined,
  browserTesting: boolean | undefined,
  documentConversion: boolean | undefined,
  capabilities: { slug: string; connectionId?: string }[] | undefined,
): string | null {
  if (harness !== "codex") return null;
  const offending = codexStdioOffenders({ browserTesting, documentConversion, capabilities });
  if (offending.length === 0) return null;
  return codexStdioCapabilityReason(offending);
}

/**
 * @decision 7955458e — HARD-REJECTS an explicit `harness:"codex"` profile whose role is in
 * `TRANSCRIPT_ROOT_DENY_ROLES` (fresh OR carry-forward), at save time. This is the early UX error for the
 * common case ONLY — it is bypassable by an explicit-role start, and never the only guard.
 */
function codexTranscriptRoleUnsupportedError(harness: string | undefined, role: string | null | undefined): string | null {
  if (harness !== "codex") return null;
  if (!role || !TRANSCRIPT_ROOT_DENY_ROLES.has(role as SessionRole)) return null;
  return codexTranscriptRoleUnsupportedReason(role as SessionRole);
}

export function validateProfile(
  raw: unknown,
  opts?: { previousRole?: string | null; patch?: unknown },
): { ok: true; value: Omit<Profile, "id"> } | { ok: false; error: string } {
  const retiredKeysError = retiredProfileCredentialKeysError(raw);
  if (retiredKeysError) return { ok: false, error: retiredKeysError };
  const r = profileSchema.safeParse(raw ?? {});
  if (!r.success) {
    const msg = r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    return { ok: false, error: msg };
  }
  const d = r.data;
  const roleCarryForwardError = roleCarryForwardOnlyError(d.role, opts?.previousRole);
  if (roleCarryForwardError) return { ok: false, error: roleCarryForwardError };
  const restrictedToolsError = assistantRestrictedToolsOmittedError(d.role, opts?.previousRole, opts?.patch ?? raw);
  if (restrictedToolsError) return { ok: false, error: restrictedToolsError };
  const codexRestrictedToolsError = codexRestrictedToolsUnsupportedError(d.harness, d.restrictedTools);
  if (codexRestrictedToolsError) return { ok: false, error: codexRestrictedToolsError };
  const codexStdioCapabilityError = codexStdioCapabilityUnsupportedError(d.harness, d.browserTesting, d.documentConversion, undefined);
  if (codexStdioCapabilityError) return { ok: false, error: codexStdioCapabilityError };
  const codexTranscriptRoleError = codexTranscriptRoleUnsupportedError(d.harness, d.role);
  if (codexTranscriptRoleError) return { ok: false, error: codexTranscriptRoleError };
  // Card 2ef54430: a provider is codex-only (claude never reads it) and must be well-formed.
  if (d.codexProvider) {
    if (d.harness !== "codex") return { ok: false, error: 'codexProvider requires harness "codex" — the claude harness never reads a codex model-provider endpoint' };
    const providerError = codexProviderShapeError(d.codexProvider);
    if (providerError) return { ok: false, error: providerError };
  }
  // COMPILE-TIME FIELD TOTALITY (card 1059b3b9): the `satisfies Record<keyof Omit<Profile,"id">,
  // unknown>` below forces every key of Omit<Profile,"id"> to be named in this literal — the write-path
  // counterpart of entityRowFields.ts's `PROFILE_FIELDS: Record<keyof Profile, 1>` on the READ path. A
  // future optional field added to `Profile` that this literal forgets to mention now fails the BUILD
  // instead of silently shipping a `200 OK` that drops it — the bug that shipped on `harness` (fixed by
  // card fa2277b6, before this check existed).
  //
  // THE ONE SANCTIONED ESCAPE, if a field genuinely should never be persisted by this literal: narrow
  // the `satisfies` target itself, e.g. `Record<keyof Omit<Profile, "id" | "thatField">, unknown>`, WITH
  // a comment at the narrowing explaining why. That is a deliberate, reviewed decision — never widen the
  // target just to make a compile error go away. TypeScript has no way to enforce this by itself; only
  // this comment stands between a future red build and someone silencing it the fast way.
  return {
    ok: true,
    value: {
      name: d.name,
      role: d.role ?? null,
      description: d.description ?? "",
      allowDelta: d.allowDelta ?? [],
      skills: d.skills ?? null,
      model: d.model ?? null,
      icon: d.icon ?? null,
      browserTesting: d.browserTesting ?? false, // normalize to the stored default (off)
      documentConversion: d.documentConversion ?? false, // normalize to the stored default (off)
      vaultWrite: d.vaultWrite ?? false, // normalize to the stored default (off)
      restrictedTools: d.restrictedTools ?? false, // normalize to the stored default (off)
      noCommit: d.noCommit ?? false, // normalize to the stored default (off)
      // Multi-harness epic (df1f94b0) Phase 1. DELIBERATELY not normalized like every sibling above:
      // `Profile.harness` is `?: "claude" | "codex"` with NO null member, so absence — not a null — is
      // how "claude" (the default) is expressed, and `d.harness` already carries exactly that type.
      // Both writers handle the undefined correctly by their own route: insertProfile coerces
      // `p.harness ?? null` BEFORE binding its named params, and updateProfile filters undefined out of
      // its column map entirely (undefined = "leave this column as-is", its documented partial-edit
      // semantics) — so no undefined is ever handed to better-sqlite3, which would throw.
      //
      // Omitting this line is the bug this fixes (card fa2277b6): the zod schema accepted `harness` and
      // AGENT_FORBIDDEN_PROFILE_KEYS rejected it on the agent path, but it was absent from THIS literal
      // — and both REST handlers persist `v.value`, never `req.body`. So no route could set it at all,
      // while a db-layer grep still read green because insertProfile/updateProfile do bind the column.
      harness: d.harness,
      // Card 2ef54430: normalized to null (not undefined) so an explicit clear reaches updateProfile, whose
      // undefined means "leave the column as-is"; toProfile maps a stored NULL back to absent.
      codexProvider: d.codexProvider ?? null,
    } satisfies Record<keyof Omit<Profile, "id">, unknown>,
  };
}
