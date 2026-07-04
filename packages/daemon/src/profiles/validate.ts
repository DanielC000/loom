import { z } from "zod";
import type { Profile } from "@loom/shared";

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
    role: z.enum(["manager", "worker", "platform", "setup", "assistant"]).nullable().optional(),
    description: z.string().optional(),
    allowDelta: z.array(z.string()).optional(),
    skills: z.array(z.string()).nullable().optional(),
    model: z.string().nullable().optional(),
    icon: z.string().nullable().optional(),
    // Opt-in browser-automation capability (default off). Human-set via this REST path only — there is
    // NO agent MCP write surface for profiles, so the capability stays human-gated (like role/allow).
    browserTesting: z.boolean().optional(),
    // Opt-in document-conversion capability (default off). Human-gated identically to browserTesting —
    // it launches a host markitdown process, so it is never an agent MCP write surface.
    documentConversion: z.boolean().optional(),
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
  })
  .strict();

/**
 * Profile keys that must NEVER be settable through an agent MCP tool, even the elevated Setup
 * Assistant / Platform Lead profile writers that otherwise share this same strict validator for every
 * other field. Mirrors `agentOrchestrationOverride`'s omission of `gateCommand`/`alertWebhook` (mcp/
 * platform.ts) — `connections` grants access to REAL external secrets (P1 credential store), which is
 * categorically more sensitive than a sandboxed capability like `browserTesting`/`documentConversion`.
 */
const AGENT_FORBIDDEN_PROFILE_KEYS = ["connections"] as const;

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
      restrictedTools: d.restrictedTools ?? false, // normalize to the stored default (off)
      noCommit: d.noCommit ?? false, // normalize to the stored default (off)
      connections: d.connections ?? [], // normalize to the stored default (no access)
    },
  };
}
