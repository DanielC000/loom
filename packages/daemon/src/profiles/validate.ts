import { z } from "zod";
import type { Profile } from "@loom/shared";
import { RESERVED_CAPABILITY_SLUGS } from "../capabilities/registry.js";
import { CODEX_RESTRICTED_TOOLS_REASON, codexStdioCapabilityReason, codexStdioOffenders } from "./codex-compat.js";

/**
 * The ONE spelling of the harness enum's runtime values. Shared by the profile validator below and the
 * default-harness config validators (`mcp/platform.ts`, card 66b1b40d) so a third harness is added once.
 */
export const HARNESS_ID_SCHEMA = z.enum(["claude", "codex"]);

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
    // "setup" IS a valid profile role (the Setup Assistant rig). (End-User Platform tier B1.)
    // "assistant" (the long-lived Loom Companion) is a valid, low-privilege profile role — profile-spawnable
    // like manager/worker. Its surface is NOT just my_context + chat_reply (a stale undercount that
    // propagated into at least one defect report, card 4fc458c1): the unconditional base is
    // my_context + notify_lead, plus (gated on the companion binding/grants) chat_reply, the
    // skill_*/memory_*/wake_*/reminder_*/board_* tools, and the opt-in capability-lever framework
    // (session-status, media-out, session-steer, session-spawn, authored-content-grant) — see
    // mcp/orchestration.ts's buildServer, role === "assistant" branch, for the real registration. The
    // ungated Setup operator still can't mint one (setupRoleError's allowlist omits it) — human REST / dev only.
    // "operator" (Bucket 2b "Elevated Operator") IS a valid, human-mintable profile role too — but the
    // SESSION role it ends up carrying is ALWAYS locked by the explicit caller role at startOperator
    // (resolveAgentSpawn), never by this profile field alone, and the ungated Setup operator still can't
    // mint/assign one (setupRoleError's allowlist omits it, exactly like "platform").
    //
    // @decision 71bcb207 — "auditor"/"workspace-auditor" are in this enum so an edit to an already-
    // existing bundled profile of either role doesn't 400 on its own pre-existing value, but
    // `roleCarryForwardOnlyError` below still rejects any write that MINTS or REASSIGNS either role.
    role: z.enum(["manager", "worker", "platform", "setup", "assistant", "operator", "auditor", "workspace-auditor"]).nullable().optional(),
    description: z.string().optional(),
    allowDelta: z.array(z.string()).optional(),
    skills: z.array(z.string()).nullable().optional(),
    model: z.string().nullable().optional(),
    icon: z.string().nullable().optional(),
    // Opt-in browser-automation capability (default off). Agent MCP write surfaces DO exist for profiles
    // (loom-setup's profile_create/update/agent_update; the LOOM_DEV Platform Lead) and CAN set this field —
    // but both are role-gated away from ever minting/assigning role:"assistant" (setupRoleError's
    // SETUP_ALLOWED_PROFILE_ROLES omits it; only the maximally-trusted Platform Lead can reach it), so the
    // one role that would gain a NEW capability from browserTesting (the untrusted-chat-facing Companion)
    // can only get it via a HUMAN Profiles UI/REST write, never an agent one. The Playwright MCP itself
    // additionally disallows its RCE-equivalent browser_run_code_unsafe tool regardless of who granted this
    // flag — see PLAYWRIGHT_DISALLOWED_TOOLS (pty/host.ts).
    browserTesting: z.boolean().optional(),
    // Opt-in document-conversion capability (default off). Human-gated identically to browserTesting —
    // it launches a host markitdown process, so it is never an agent MCP write surface.
    documentConversion: z.boolean().optional(),
    // Opt-in confined vault-write capability (default off), gates the `vault_write` tool. STRICTER than
    // browserTesting/documentConversion (see AGENT_FORBIDDEN_PROFILE_KEYS below), the SAME posture as
    // connections/capabilities — a write grant into a human-reviewed corpus is exfil/tamper-
    // adjacent, rejected even on the elevated Setup Assistant's/Platform Lead's own profile-writing tools.
    vaultWrite: z.boolean().optional(),
    // Opt-in RESTRICTED-tools (default off). Blast-radius control for a chat-reachable Companion: when on,
    // the curated dangerous native tools (Bash/Edit/Write/NotebookEdit/MultiEdit) are appended to
    // --disallowedTools at spawn. Human-gated identically to browserTesting — it is never a NEW agent MCP
    // write surface; a companion (assistant role) has no profile write tool, so it can never self-widen.
    restrictedTools: z.boolean().optional(),
    // Declared no-commit role (default off). Lifecycle-only flag (no spawn-time host capability) — a
    // 0-commit done auto-retires + skips the forgot-to-commit warning. Human-gated like browserTesting.
    noCommit: z.boolean().optional(),
    // Opt-in authenticated-egress connection-id allowlist (agent-tooling epic P2, default []=no access).
    // STRICTER than browserTesting/documentConversion: this field grants access to REAL external secrets,
    // so it is rejected even on the Setup Assistant's / Platform Lead's own profile-writing MCP tools (see
    // `agentProfileKeyError` below) — the human REST path (POST/PUT /api/profiles) is the ONLY grant path.
    connections: z.array(z.string()).optional(),
    // Registry-capability grants (agent-tooling epic P4, default []=none). Each names a catalog slug plus
    // an OPTIONAL bound P1 connection id. STRICTER than browserTesting/documentConversion, like
    // `connections` above (see AGENT_FORBIDDEN_PROFILE_KEYS): a grant can launch a host process and bind
    // egress, so it is rejected even on the elevated Setup Assistant's/Platform Lead's own profile writers.
    // A grant naming a RESERVED legacy slug (browser-testing/document-conversion) is rejected here too —
    // those are exclusively conferred via the browserTesting/documentConversion booleans (the bridge in
    // resolveProfileCapabilities); a profile-array entry naming one would double-mount it and silently
    // drop any connectionId (the two legacy capabilities never consult a connection).
    // P4↔P5a interaction: a grant naming a `requiresConnection` slug bound to an OAUTH2 connectionId is
    // rejected at bind time by `capabilityGrantBindingError` below (called by the REST handler after this
    // schema passes) — oauth2 connections statically inject nothing (see that function's doc).
    capabilities: z.array(z.object({ slug: z.string(), connectionId: z.string().optional() }))
      .refine((grants) => grants.every((g) => !(RESERVED_CAPABILITY_SLUGS as readonly string[]).includes(g.slug)), {
        message: `capabilities may not name a reserved builtin slug (${RESERVED_CAPABILITY_SLUGS.join(", ")}) — use the browserTesting/documentConversion booleans instead`,
      })
      .optional(),
    // Multi-harness epic (df1f94b0) Phase 1, card 353f6dc4: which vendor CLI a session under this rig
    // spawns as. STRICTER than browserTesting/documentConversion (see AGENT_FORBIDDEN_PROFILE_KEYS
    // below): selecting which BINARY gets spawned is the same trust class as gateCommand, not a
    // sandboxed capability — rejected even on the elevated Setup Assistant's/Platform Lead's own
    // profile-writing MCP tools, human REST is the ONLY grant path.
    harness: HARNESS_ID_SCHEMA.optional(),
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
 * platform.ts) — `connections` grants access to REAL external secrets (P1 credential store), which is
 * categorically more sensitive than a sandboxed capability like `browserTesting`/`documentConversion`.
 * `capabilities` (agent-tooling P4) gets the SAME stricter posture, not the milder `browserTesting`/
 * `documentConversion` one: a capability grant launches a host process and can bind egress via a P1
 * connection, so it is owner-only end-to-end, never delegable to an elevated profile-writing agent.
 *
 * @decision be8be211 — `vaultWrite` gets the SAME stricter posture: a write grant into a
 * human-reviewed vault corpus is exfil/tamper-adjacent.
 *
 * An elevated profile-writing agent must never be able to grant itself (or any other rig) the ability
 * to write vault content a human will later trust as their own.
 *
 * `harness` (multi-harness epic df1f94b0 Phase 1, card 353f6dc4) gets the SAME stricter posture too, per
 * an explicit lead ruling on that card: selecting which vendor BINARY a session spawns is the same trust
 * class as `gateCommand`, not a sandboxed capability like `browserTesting`/`documentConversion` — an
 * elevated profile-writing agent must never be able to switch a rig onto a different CLI unsupervised.
 */
const AGENT_FORBIDDEN_PROFILE_KEYS = ["connections", "capabilities", "vaultWrite", "harness"] as const;

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
        return `${key} may not be set via an agent MCP tool — it grants access to real external secrets (human-only, via the Profiles UI / REST)`;
      }
    }
  }
  return null;
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
export function capabilityGrantBindingError(
  grants: { slug: string; connectionId?: string }[],
  db: CapabilityGrantBindingDbStore,
): string | null {
  for (const g of grants) {
    if (!g.connectionId) continue;
    const def = db.getCapabilityDefBySlug(g.slug);
    if (!def?.requiresConnection) continue; // unknown slug / no static-injection grant ⇒ not this guard's concern
    const conn = db.getConnection(g.connectionId);
    if (conn?.authScheme === "oauth2") {
      return `capability '${g.slug}' is bound to an oauth2 connection, which can't be statically injected at spawn — oauth2 connections refresh on use via the authenticated_request tool instead. Bind an api-key/bearer connection here, or drop the connectionId and use authenticated_request for oauth2 access.`;
    }
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

export function validateProfile(
  raw: unknown,
  opts?: { previousRole?: string | null; patch?: unknown },
): { ok: true; value: Omit<Profile, "id"> } | { ok: false; error: string } {
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
  const codexStdioCapabilityError = codexStdioCapabilityUnsupportedError(d.harness, d.browserTesting, d.documentConversion, d.capabilities);
  if (codexStdioCapabilityError) return { ok: false, error: codexStdioCapabilityError };
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
      connections: d.connections ?? [], // normalize to the stored default (no access)
      capabilities: d.capabilities ?? [], // normalize to the stored default (none)
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
    } satisfies Record<keyof Omit<Profile, "id">, unknown>,
  };
}
