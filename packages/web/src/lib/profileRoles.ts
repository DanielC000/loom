import type { SessionRole } from "@loom/shared";

// The Companion's rig is an `assistant`-role Profile (the bundled "Companion" profile every companion
// agent binds to). Companion config now lives ENTIRELY on the Companion → Manage tab, so an assistant-role
// profile is NOT an agent rig and must not appear among the agent Profiles. `agentProfiles` splits the
// profiles list on that role for the Profiles page. `companionProfile` resolves the SHARED rig's own
// (Profile-level, pre-spawn) settings — it is NOT how Manage resolves a SPECIFIC running companion's
// current settings (e.g. restrictedTools): those are pinned per-session on the session row at spawn and
// re-read from there on every resume, so Manage resolves them by sessionId via the companion REST
// surface (gateway/server.ts resolveCompanionAgent), never by picking "the first assistant-role profile".

// Every profile shown on the agent-Profiles page: all NON-assistant (non-companion) rigs, in order.
export function agentProfiles<T extends { role: SessionRole | null }>(profiles: T[]): T[] {
  return profiles.filter((p) => p.role !== "assistant");
}

// The companion's assistant-role rig from the full profiles list (the bundled "Companion" profile). All
// companions share it, so the FIRST assistant-role profile is the companion rig; null when none exists.
export function companionProfile<T extends { role: SessionRole | null }>(profiles: T[]): T | null {
  return profiles.find((p) => p.role === "assistant") ?? null;
}
