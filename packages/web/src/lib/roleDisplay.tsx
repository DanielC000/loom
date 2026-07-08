import type { SessionRole } from "@loom/shared";
import { Badge } from "../components/ui";
import { sessionRoleTone, tone as toneVar, type Tone } from "../theme";

// The ONE role presentation map — the single source of truth for how a session/profile ROLE is shown
// across the app (the Profiles role picker, the RoleBadge, the Developer/EndUser Platform views, and
// every session/agent list). It replaces the scattered per-page `role ?? "plain"` relabeling + ad-hoc
// ternaries so a role's label, sigil, tone and powers can never drift between surfaces.
//
// PRESENTATION ONLY. The enum strings ("worker", "manager", "setup", "platform", "auditor", …) are the
// load-bearing identifiers — they gate the daemon tool surface (resolveRole), are DB-persisted + pinned
// on every session row, and are the term of art across skills + docs. Nothing here renames them; this is
// a display layer ON TOP, keyed BY those identifiers. Visual identity builds on the existing
// `sessionRoleTone` (theme.ts) — no palette is invented here.
//
// The `powers` copy is verified against the real daemon gates, NOT guessed:
//   • plain (null) → resolveRole returns null ⇒ 404: no orchestration surface at all (mcp/orchestration.ts).
//   • worker/setup/auditor → disallowedToolsForRole removes the human-prompt tools (pty/host.ts); worker
//     gets its own worktree + branch and reports up via worker_report (depth-1: no spawn, no merge).
//   • manager/platform → NOT in the human-prompt disallow (they legitimately surface decisions); manager
//     spawns + controls workers, reviews + merges via the gate, files decisions to the human.
//   • setup → the curated, fail-closed loom-setup surface (create/configure projects, agents, profiles).
//   • platform/auditor → dev-layer (LOOM_DEV): platform is the only agent-facing git/vault write surface;
//     auditor is read-mostly transcript review with two narrow daemon-local writes.

export type RoleKey = "plain" | SessionRole;

// Trust tier — orders the roles by capability breadth and drives the card's visual weight.
export type RoleTier = "none" | "scoped" | "operator" | "elevated" | "admin" | "readonly";

// Whether a profile may CONFER this role from the ordinary Profiles editor:
//   user   → selectable. The selectable set (plain/worker/manager/setup) is exactly what setupRoleError
//            allows and what validateProfile accepts.
//   dev    → shown LOCKED, never assignable. Locking platform/auditor is DELIBERATELY tighter than
//            validateProfile (which actually ACCEPTS "platform") — there is no UI path to confer a
//            dev-layer rig; those are core-seeded, not UI-created. setupRoleError also rejects them.
//   hidden → display-only (badges/lists); caller-set-only roles that never appear in the picker.
export type RoleConfer = "user" | "dev" | "hidden";

export interface RolePower {
  text: string;
  // true = a capability this role HAS (affirmative mark); false = a boundary it does NOT cross.
  has: boolean;
}

export interface RoleDisplay {
  key: RoleKey;
  role: SessionRole | null; // null for the plain (no-role) session
  label: string; // full display label — used on cards
  short: string; // compact label — used in badges / lists
  sigil: string; // single-glyph identity mark (mono)
  tone: Tone; // from sessionRoleTone — the role's signal color
  tier: RoleTier;
  tierLabel: string; // human tier caption, e.g. "scoped"
  description: string; // one-line "what this role is"
  powers: RolePower[];
  confer: RoleConfer;
}

export const ROLE_DISPLAY: Record<RoleKey, RoleDisplay> = {
  plain: {
    key: "plain",
    role: null,
    label: "Plain",
    short: "Plain",
    sigil: "○",
    tone: "muted",
    tier: "none",
    tierLabel: "baseline",
    description: "Just Claude Code in this project — no orchestration.",
    powers: [
      { text: "Reads & edits project files", has: true },
      { text: "Runs allowlisted commands", has: true },
      { text: "No worktree · no board writes", has: false },
    ],
    confer: "user",
  },
  worker: {
    key: "worker",
    role: "worker",
    label: "Worker",
    short: "Worker",
    sigil: "▸",
    tone: sessionRoleTone.worker,
    tier: "scoped",
    tierLabel: "scoped",
    description: "Implements one assigned task on an isolated worktree branch.",
    powers: [
      { text: "Own git worktree + branch, commits", has: true },
      { text: "Reports up via worker_report", has: true },
      { text: "Can't merge or spawn (depth-1)", has: false },
    ],
    confer: "user",
  },
  manager: {
    key: "manager",
    role: "manager",
    label: "Manager",
    short: "Manager",
    sigil: "◆",
    tone: sessionRoleTone.manager,
    tier: "elevated",
    tierLabel: "elevated",
    description: "Plans, delegates, reviews and merges a fleet of workers.",
    powers: [
      { text: "Spawns & controls workers", has: true },
      { text: "Reviews & merges via the gate", has: true },
      { text: "Files decisions to the human", has: true },
    ],
    confer: "user",
  },
  setup: {
    key: "setup",
    role: "setup",
    label: "Platform operator",
    short: "Operator",
    sigil: "⚙",
    tone: sessionRoleTone.setup,
    tier: "operator",
    tierLabel: "operator",
    description: "Sets up & maintains the workspace on your behalf.",
    powers: [
      { text: "Creates & configures projects", has: true },
      { text: "Creates / updates agents & profiles", has: true },
      { text: "Curated, fail-closed — no writers", has: false },
    ],
    confer: "user",
  },
  platform: {
    key: "platform",
    role: "platform",
    label: "Platform Lead",
    short: "Lead",
    sigil: "★",
    tone: sessionRoleTone.platform,
    tier: "admin",
    tierLabel: "admin",
    description: "Cross-project admin, above all projects.",
    powers: [
      { text: "git & vault writes", has: true },
      { text: "Cross-project session control", has: true },
      { text: "Gated behind LOOM_DEV", has: false },
    ],
    confer: "dev",
  },
  auditor: {
    key: "auditor",
    role: "auditor",
    label: "Platform Auditor",
    short: "Auditor",
    sigil: "◎",
    tone: sessionRoleTone.auditor,
    tier: "readonly",
    tierLabel: "read-only",
    description: "Scheduled, read-mostly transcript review.",
    powers: [
      { text: "Reads transcripts across projects", has: true },
      { text: "Files findings + preset suggestions", has: true },
      { text: "Two narrow daemon-local writes only", has: false },
    ],
    confer: "dev",
  },
  // --- Display-only (caller-set-only) roles: never offered in the picker, but rendered by badges/lists. ---
  "workspace-auditor": {
    key: "workspace-auditor",
    role: "workspace-auditor",
    label: "Workspace Auditor",
    short: "Auditor",
    sigil: "◍",
    tone: sessionRoleTone["workspace-auditor"],
    tier: "readonly",
    tierLabel: "read-only",
    description: "Read-only review of your workspace; files improvement suggestions.",
    powers: [
      { text: "Reads your session transcripts", has: true },
      { text: "Files suggestions to your home board", has: true },
      { text: "Suggest-only — no writes", has: false },
    ],
    confer: "hidden",
  },
  run: {
    key: "run",
    role: "run",
    label: "Run",
    short: "Run",
    sigil: "◦",
    tone: sessionRoleTone.run,
    tier: "none",
    tierLabel: "baseline",
    description: "A plain, caller-set run — no orchestration surface.",
    powers: [
      { text: "Reads & edits project files", has: true },
      { text: "Runs allowlisted commands", has: true },
      { text: "No orchestration tools", has: false },
    ],
    confer: "hidden",
  },
  assistant: {
    key: "assistant",
    role: "assistant",
    label: "Companion",
    short: "Companion",
    sigil: "✦",
    tone: sessionRoleTone.assistant,
    tier: "scoped",
    tierLabel: "companion",
    description: "The long-lived Loom Companion chat rig.",
    powers: [
      { text: "Chats back via chat_reply", has: true },
      { text: "Reads its own context", has: true },
      { text: "No orchestration / spawn tools", has: false },
    ],
    confer: "hidden",
  },
};

// Resolve a session/profile role (null ⇒ plain) to its display record. Never throws; an unknown role
// (a future SESSION_ROLES addition not yet in the map) falls back to the plain record.
export function roleDisplay(role: SessionRole | null | undefined): RoleDisplay {
  return ROLE_DISPLAY[(role ?? "plain") as RoleKey] ?? ROLE_DISPLAY.plain;
}

// Picker card DISPLAY order — baseline → the common user rigs → operator → dev-layer. This matches the
// owner-approved mockup; it ONLY orders the derived PICKER_ROLES (membership comes from `confer`, below).
const TIER_DISPLAY_ORDER: Record<RoleTier, number> = {
  none: 0, scoped: 1, elevated: 2, operator: 3, admin: 4, readonly: 5,
};

// The roles the Profiles picker renders — DERIVED from the map so membership can never drift from each
// entry's `confer`: every non-`hidden` role (USER = selectable, DEV = shown locked), ordered for display
// by TIER_DISPLAY_ORDER. A future conferrable role added to the map can't silently vanish from the picker
// (the previous hand-listed array could fall out of sync). `hidden` roles stay excluded — caller-set-only.
export const PICKER_ROLES: readonly RoleKey[] = (Object.keys(ROLE_DISPLAY) as RoleKey[])
  .filter((k) => ROLE_DISPLAY[k].confer !== "hidden")
  .sort((a, b) => TIER_DISPLAY_ORDER[ROLE_DISPLAY[a].tier] - TIER_DISPLAY_ORDER[ROLE_DISPLAY[b].tier]);

// A role as a colored pill (sigil + label), read from the ONE map — so the badge agrees everywhere it's
// shown. `sigil` defaults on; pass `sigil={false}` for a text-only badge.
export function RoleBadge({ role, sigil = true }: { role: SessionRole | null; sigil?: boolean }) {
  const d = roleDisplay(role);
  return <Badge tone={d.tone}>{sigil ? `${d.sigil} ` : ""}{d.short}</Badge>;
}

// The role's signal color as a CSS value (for compact non-Badge renders, e.g. a list's role text).
export function roleColor(role: SessionRole | null | undefined): string {
  return toneVar[roleDisplay(role).tone];
}
