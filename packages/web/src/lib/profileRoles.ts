import { SESSION_ROLES, type SessionRole } from "@loom/shared";

// The Profiles role <Select>'s full option set: the blank "no role" default (rendered "— (plain)")
// plus every SessionRole, derived from the shared union so the dropdown can never hand-duplicate it
// and silently drop a role (the bug this guards against: `assistant` was missing, so opening the
// seeded Companion profile rendered "(plain)" and saving clobbered its real role to plain).
export const PROFILE_ROLE_OPTIONS: readonly (SessionRole | "")[] = ["", ...SESSION_ROLES];

// The Companion's rig is an `assistant`-role Profile (the bundled "Companion" profile every companion
// agent binds to). Companion config now lives ENTIRELY on the Companion → Manage tab, so an assistant-role
// profile is NOT an agent rig and must not appear among the agent Profiles. These two pure, order-preserving
// helpers split the profiles list on that role: the Profiles page shows `agentProfiles`, while Manage
// resolves the companion's inline restricted-tools toggle from `companionProfile`.

// Every profile shown on the agent-Profiles page: all NON-assistant (non-companion) rigs, in order.
export function agentProfiles<T extends { role: SessionRole | null }>(profiles: T[]): T[] {
  return profiles.filter((p) => p.role !== "assistant");
}

// The companion's assistant-role rig from the full profiles list (the bundled "Companion" profile). All
// companions share it, so the FIRST assistant-role profile is the companion rig; null when none exists.
export function companionProfile<T extends { role: SessionRole | null }>(profiles: T[]): T | null {
  return profiles.find((p) => p.role === "assistant") ?? null;
}
