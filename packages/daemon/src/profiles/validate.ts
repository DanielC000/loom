import { z } from "zod";
import type { Profile } from "@loom/shared";

/**
 * Strict zod validator for an Agent Profile's WRITABLE shape (everything but the server-assigned id),
 * mirroring validateProjectConfigOverride (mcp/platform.ts): `.strict()` rejects unknown keys (typo
 * guard) and types are checked. ONE validator the future write paths (P3 REST + platform-MCP) share.
 * Optional fields are normalized to their stored defaults, so the result is directly insertable once
 * an id is attached. (Phase-1 ships the validator with the model; nothing wires it to a tool yet.)
 */
const profileSchema = z
  .object({
    name: z.string().min(1),
    role: z.enum(["manager", "worker", "platform"]).nullable().optional(),
    startupPrompt: z.string().optional(),
    allowDelta: z.array(z.string()).optional(),
    skills: z.array(z.string()).nullable().optional(),
    model: z.string().nullable().optional(),
    icon: z.string().nullable().optional(),
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
      startupPrompt: d.startupPrompt ?? "",
      allowDelta: d.allowDelta ?? [],
      skills: d.skills ?? null,
      model: d.model ?? null,
      icon: d.icon ?? null,
    },
  };
}
