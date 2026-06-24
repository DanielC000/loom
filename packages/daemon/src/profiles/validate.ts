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
    role: z.enum(["manager", "worker", "platform", "setup"]).nullable().optional(),
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
  })
  .strict();

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
    },
  };
}
