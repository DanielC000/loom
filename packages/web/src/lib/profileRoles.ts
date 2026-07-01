import { SESSION_ROLES, type SessionRole } from "@loom/shared";

// The Profiles role <Select>'s full option set: the blank "no role" default (rendered "— (plain)")
// plus every SessionRole, derived from the shared union so the dropdown can never hand-duplicate it
// and silently drop a role (the bug this guards against: `assistant` was missing, so opening the
// seeded Companion profile rendered "(plain)" and saving clobbered its real role to plain).
export const PROFILE_ROLE_OPTIONS: readonly (SessionRole | "")[] = ["", ...SESSION_ROLES];
