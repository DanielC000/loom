/**
 * Shared validator + PATCH normalizer for an agent-preset edit — the body of the human REST
 * `POST /api/agents/:id` AND the elevated loom-platform `agent_update` MCP tool. ONE function so
 * the two write paths CANNOT diverge (mirrors profiles/validate.ts › validateProfile, which the
 * REST + platform-MCP profile paths share).
 *
 * PATCH semantics: only keys PRESENT in `raw` reach the returned patch; an omitted key is left out,
 * so `db.updateAgent` leaves that column as-is. A `profileId: null` is PRESENT (it CLEARS the
 * assignment — the agent falls back to the plain backstop).
 *
 * Field gating differs by caller, expressed via `allowEndpointFlags`:
 *   - `endpoint`/`ioSchema` (Agent Runs R1) are a HUMAN-only trust-boundary surface — publishing an
 *     agent as an API endpoint is exposed ONLY on the loopback REST, NEVER via an MCP tool (so an
 *     agent can never self-publish; see the gateway POST /api/agents/:id comment). The REST path
 *     passes `allowEndpointFlags:true`; the platform MCP path passes false (those keys are simply
 *     absent from its inputSchema, so they never reach here — the flag is a belt-and-suspenders).
 *
 * `hasProfile` is the existence check (db.getProfile-backed) injected so this module stays Db-free.
 * `kind` lets the REST path map a failure to the SAME status it always returned: a bad profileId is
 * `notFound` (→ 404), any type/shape problem is `invalid` (→ 400).
 */
export type AgentPatch = {
  name?: string;
  startupPrompt?: string;
  profileId?: string | null;
  endpoint?: boolean;
  ioSchema?: unknown | null;
};

export function validateAgentPatch(
  raw: unknown,
  hasProfile: (id: string) => boolean,
  opts: { allowEndpointFlags: boolean } = { allowEndpointFlags: false },
): { ok: true; patch: AgentPatch } | { ok: false; kind: "invalid" | "notFound"; error: string } {
  const b = (raw ?? {}) as Record<string, unknown>;
  const patch: AgentPatch = {};

  if ("name" in b) {
    if (typeof b.name !== "string") return { ok: false, kind: "invalid", error: "name must be a string" };
    patch.name = b.name;
  }
  if ("startupPrompt" in b) {
    if (typeof b.startupPrompt !== "string") return { ok: false, kind: "invalid", error: "startupPrompt must be a string" };
    patch.startupPrompt = b.startupPrompt;
  }
  if ("profileId" in b) {
    const pid = b.profileId;
    if (pid !== null && typeof pid !== "string") return { ok: false, kind: "invalid", error: "profileId must be a string or null" };
    // A non-null profileId MUST reference a real profile (null CLEARS). Same rule the REST path applied.
    if (pid != null && !hasProfile(pid)) return { ok: false, kind: "notFound", error: "profile not found" };
    patch.profileId = pid as string | null;
  }
  // endpoint/ioSchema — only honored on the human REST path (allowEndpointFlags). On the MCP path
  // these keys can't arrive (not in the inputSchema), so the guard never fires there.
  if (opts.allowEndpointFlags) {
    if ("endpoint" in b) {
      if (typeof b.endpoint !== "boolean") return { ok: false, kind: "invalid", error: "endpoint must be a boolean" };
      patch.endpoint = b.endpoint;
    }
    if ("ioSchema" in b) {
      patch.ioSchema = b.ioSchema ?? null;
    }
  }

  return { ok: true, patch };
}
