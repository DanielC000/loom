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

/**
 * PURE resolver for the three mutually-exclusive ways an `agent_update`-shaped call can touch
 * `startupPrompt` — `startupPrompt` (full replace), `appendToStartupPrompt` (concatenate onto the
 * existing prompt, blank-line joined), `replaceInStartupPrompt` (edit ONE clause mid-document; `old`
 * must occur EXACTLY ONCE in `current` — 0 or 2+ occurrences is REJECTED with no result). Deliberately
 * has NO db access, NO session/auth lookup, and NO projectId: it is shared across three MCP surfaces
 * (`orchestration.ts`'s manager-scoped `agent_update`, `platform.ts`'s LOOM_DEV-gated cross-project
 * `agent_update`, `setup.ts`'s least-privilege cross-project `agent_update`) with THREE DIFFERENT
 * privilege models — each caller keeps its OWN auth/scoping checks around this call. Passing a session
 * or projectId in here would leak a trust boundary into shared code; if a caller ever needs one, that's
 * a sign this function has grown beyond pure text resolution and should be reconsidered, not extended.
 * Returns the resolved `startupPrompt` (or `undefined` if none of the three modes were given — PATCH
 * semantics: caller leaves the field untouched). Throws (never resolves) on: more than one mode given,
 * `replaceInStartupPrompt.old === ""`, `old` not found in `current` (0 occurrences), or `old` ambiguous
 * (2+ occurrences) — every thrown message names the exact reason, no write should ever follow a throw.
 */
export function resolveStartupPromptEdit(
  current: string | null | undefined,
  patch: { startupPrompt?: string; appendToStartupPrompt?: string; replaceInStartupPrompt?: { old: string; new: string } },
): string | undefined {
  const modesGiven = [patch.startupPrompt !== undefined, patch.appendToStartupPrompt !== undefined, patch.replaceInStartupPrompt !== undefined]
    .filter(Boolean).length;
  if (modesGiven > 1) {
    throw new Error("agent_update: pass at most ONE of startupPrompt (full replace), appendToStartupPrompt (append), or replaceInStartupPrompt (mid-document edit)");
  }
  if (patch.appendToStartupPrompt !== undefined) {
    return current ? `${current}\n\n${patch.appendToStartupPrompt}` : patch.appendToStartupPrompt;
  }
  if (patch.replaceInStartupPrompt !== undefined) {
    const { old: oldStr, new: newStr } = patch.replaceInStartupPrompt;
    if (oldStr === "") throw new Error("agent_update: replaceInStartupPrompt.old must not be empty");
    const cur = current ?? "";
    const firstIdx = cur.indexOf(oldStr);
    if (firstIdx === -1) {
      throw new Error("agent_update: replaceInStartupPrompt.old was not found in the agent's current startupPrompt (0 occurrences) — no write made");
    }
    const secondIdx = cur.indexOf(oldStr, firstIdx + oldStr.length);
    if (secondIdx !== -1) {
      throw new Error("agent_update: replaceInStartupPrompt.old is not unique — it occurs more than once in the current startupPrompt; supply more surrounding context so it matches exactly once — no write made");
    }
    return cur.slice(0, firstIdx) + newStr + cur.slice(firstIdx + oldStr.length);
  }
  return patch.startupPrompt;
}

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
