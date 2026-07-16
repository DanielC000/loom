import { z } from "zod";
import type { Profile } from "@loom/shared";
import { RESERVED_CAPABILITY_SLUGS } from "../capabilities/registry.js";

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
    // NB: "auditor" AND "workspace-auditor" are deliberately NOT mintable here — both are caller-set via
    // their start* paths (startAuditor / the future startWorkspaceAuditor — the security boundary), so a
    // profile must never confer either. They're absent from this enum, so validateProfile REJECTS them by
    // construction. "setup" IS a valid profile role (the Setup Assistant rig). (End-User Platform tier B1.)
    // "assistant" (the long-lived Loom Companion) is a valid, low-privilege profile role — profile-spawnable
    // like manager/worker (its whole surface is my_context + the companion-gated chat_reply). The ungated
    // Setup operator still can't mint one (setupRoleError's allowlist omits it) — human REST / dev only.
    // "operator" (Bucket 2b "Elevated Operator") IS a valid, human-mintable profile role too — but the
    // SESSION role it ends up carrying is ALWAYS locked by the explicit caller role at startOperator
    // (resolveAgentSpawn), never by this profile field alone, and the ungated Setup operator still can't
    // mint/assign one (setupRoleError's allowlist omits it, exactly like "platform").
    role: z.enum(["manager", "worker", "platform", "setup", "assistant", "operator"]).nullable().optional(),
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
    // Opt-in Open Design (OD) capability (default off): injects a per-session OD MCP server (see
    // pty/host.ts's openDesignMcpServer) so a design/mockup-generating rig can use OD's design tooling.
    // STRICTER than browserTesting/documentConversion (see AGENT_FORBIDDEN_PROFILE_KEYS below) — an
    // MCP-server injection is an exfil-class grant, rejected even on the elevated Setup Assistant's/
    // Platform Lead's own profile-writing MCP tools. OD is a public OSS capability (not gated by
    // isLoomDev() at spawn time) — but the GRANT itself stays human-only regardless.
    openDesign: z.boolean().optional(),
    // Opt-in confined vault-write capability (default off), gates the `vault_write` tool. STRICTER than
    // browserTesting/documentConversion (see AGENT_FORBIDDEN_PROFILE_KEYS below), the SAME posture as
    // openDesign/connections/capabilities — a write grant into a human-reviewed corpus is exfil/tamper-
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
  })
  .strict();

/**
 * Profile keys that must NEVER be settable through an agent MCP tool, even the elevated Setup
 * Assistant / Platform Lead profile writers that otherwise share this same strict validator for every
 * other field. Mirrors `agentOrchestrationOverride`'s omission of `gateCommand`/`alertWebhook` (mcp/
 * platform.ts) — `connections` grants access to REAL external secrets (P1 credential store), which is
 * categorically more sensitive than a sandboxed capability like `browserTesting`/`documentConversion`.
 * `capabilities` (agent-tooling P4) gets the SAME stricter posture, not the milder `browserTesting`/
 * `documentConversion` one: a capability grant launches a host process and can bind egress via a P1
 * connection, so it is owner-only end-to-end, never delegable to an elevated profile-writing agent.
 * `openDesign` gets the SAME stricter posture too: an MCP-server injection is an exfil-class grant, not
 * the milder `browserTesting`/`documentConversion` posture. `vaultWrite` (card be8be211) gets the SAME
 * stricter posture as well: a write grant into a human-reviewed vault corpus is exfil/tamper-adjacent,
 * not a sandboxed capability — an elevated profile-writing agent must never be able to grant itself (or
 * any other rig) the ability to write vault content a human will later trust as their own.
 */
const AGENT_FORBIDDEN_PROFILE_KEYS = ["connections", "capabilities", "openDesign", "vaultWrite"] as const;

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
 * Guard the P4 capability-grant ↔ P1 connection binding at bind time — the human-facing REST surface
 * (POST/PUT /api/profiles, gateway/server.ts), called AFTER `validateProfile` on its already-normalized
 * `capabilities` array. A `requiresConnection` capability injects its bound connection's secret as a
 * STATIC env var at spawn (`capabilities/registry.ts` › `resolveCapabilityServer`) — but an `oauth2`
 * connection's secret never resolves that way: `getSecretForUse` (`connections/store.ts`) returns
 * undefined for an `oauth2` row BY DESIGN, since oauth2 must flow through refresh-on-use via the P2
 * `authenticated_request` tool, never a static token that would go stale with no refresh path
 * (`resolveConnectionSecret` in `index.ts` / the grant loop in `pty/host.ts` › `buildMcpServers` then
 * correctly omit the env injection — that fail-closed runtime behavior is UNCHANGED by this guard).
 * Without this check, binding an oauth2 connection to such a grant would save successfully and then
 * silently spawn every session under that profile credential-less. Rejects at bind time instead — safe
 * here because this is a human-only config action, never an agent-writable path. Returns an error string
 * for the FIRST offending grant, or null when every grant's binding is sound.
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

export function validateProfile(
  raw: unknown,
): { ok: true; value: Omit<Profile, "id"> } | { ok: false; error: string } {
  const r = profileSchema.safeParse(raw ?? {});
  if (!r.success) {
    const msg = r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    return { ok: false, error: msg };
  }
  const d = r.data;
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
      openDesign: d.openDesign ?? false, // normalize to the stored default (off)
      vaultWrite: d.vaultWrite ?? false, // normalize to the stored default (off)
      restrictedTools: d.restrictedTools ?? false, // normalize to the stored default (off)
      noCommit: d.noCommit ?? false, // normalize to the stored default (off)
      connections: d.connections ?? [], // normalize to the stored default (no access)
      capabilities: d.capabilities ?? [], // normalize to the stored default (none)
    },
  };
}
