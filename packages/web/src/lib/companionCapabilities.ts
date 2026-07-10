// The Companion capability-grant CATALOG + pure helpers, for the Manage-tab "Capabilities" panel
// (pages/Companion.tsx › CapabilityGrantsSection). A capability ("lever") is enabled by the PRESENCE of a
// `companion_capability_grants` row (default-OFF); the panel toggles those rows over the human-only grants
// REST (api.companionGrants / upsertCompanionGrant / deleteCompanionGrant) and applies them with the
// conversation-preserving respawn (api.upgradeCompanionSession).
//
// This catalog MIRRORS the daemon's own source of truth (packages/daemon/src/companion/capabilities.ts —
// COMPANION_CAPABILITIES / DECISION_CLASSES, and attention-push.ts — ATTENTION_ALERT_CLASSES). The daemon's
// grants validator (gateway/server.ts › parseGrantBody) is authoritative and REJECTS an unknown slug /
// class / bad config shape, so this file must stay in step with it — it never widens what the server
// accepts, it only presents it. Kept a metadata table (not per-lever bespoke UI) so a new built lever is a
// row here, not a new code path.

import type { CompanionCapabilityGrant } from "@loom/shared";

export type CapabilitySlug =
  | "session-status" | "decisions-relay" | "attention-push"
  | "session-steer" | "board-reach" | "vault-read" | "media-out";

export type GrantMode = "read" | "act";

// How a lever reads on the panel: a read-only lever is low-risk; an act-capable lever gains a guarded
// write half when granted `act`; an ELEVATED lever is act-only and among Loom's most powerful — the panel
// flags it distinctly so the owner grants it deliberately (task DoD: sensitive ACT levers visually flagged).
export type LeverTier = "read" | "act-capable" | "elevated";

// The per-lever extra scope shape (opaque to the framework; each lever validates its own). "none" = no
// config; the rest name the ONE config key the daemon validates for that slug.
export type LeverConfigKind = "none" | "decisionClasses" | "roots" | "roleFilter" | "alertClasses";

export interface LeverMeta {
  slug: CapabilitySlug;
  /** Human label shown on the card (the tool slug itself is shown as a mono sub-label). */
  name: string;
  /** One-line plain-language summary of what granting it lets the companion do. */
  summary: string;
  /** Supported grant modes, in display order. `["read"]` = read-only (no mode picker); `["read","act"]`
   *  = a mode picker; `["act"]` = act-only (no picker — always the stronger, elevated mode). */
  modes: GrantMode[];
  tier: LeverTier;
  configKind: LeverConfigKind;
  /** For an ELEVATED lever only: the plain-language action the companion gains, woven into the dedicated
   *  initial-grant confirmation ("… will be able to <elevatedAction> in <project> …"). Undefined for every
   *  non-elevated lever (which grants without a confirm). */
  elevatedAction?: string;
  /** True iff a grant change arms/disarms LIVE with no respawn — only `attention-push` today (it has a
   *  daemon watcher `reconcile()` re-arms; every OTHER lever's MCP tool surface is fixed at OS-process
   *  start, so a change needs the companion respawned to take effect). Drives the panel's "restart to
   *  apply" state: an appliesLive change never sets it. */
  appliesLive: boolean;
}

// Mirrors DECISION_CLASSES (daemon companion/capabilities.ts) — decisions-relay's act half admits ONLY the
// classes in this allowlist (conservative default: an empty allowlist resolves nothing). The daemon
// rejects an unknown class, so this list must match it.
export const DECISION_CLASSES = ["general", "deploy", "irreversible"] as const;

// Mirrors ATTENTION_ALERT_CLASSES (daemon companion/attention-push.ts) — the alert kinds attention-push can
// proactively push. Same source-of-truth caveat as DECISION_CLASSES.
export const ATTENTION_ALERT_CLASSES = [
  "merge-gate", "worker-blocked", "worker-crashed", "decision-pending",
  "manager-idle", "context-overflow", "escalation", "usage-limit",
] as const;

// The panel's lever order: the owner's immediate need first (fleet status + decisions relay), then the
// other read/informational levers, with the two ELEVATED act-only levers grouped LAST so the sensitive
// surface reads as a deliberate, separated section.
export const COMPANION_LEVERS: readonly LeverMeta[] = [
  {
    slug: "session-status",
    name: "Fleet status",
    summary: "Read-only view of live sessions across granted projects — which are running, busy, and what task they're on.",
    modes: ["read"],
    tier: "read",
    configKind: "none",
    appliesLive: false,
  },
  {
    slug: "decisions-relay",
    name: "Decisions relay",
    summary: "List pending decisions in granted projects — and, with act, resolve one on your behalf (owner-confirmed, per the allowed classes).",
    modes: ["read", "act"],
    tier: "act-capable",
    configKind: "decisionClasses",
    appliesLive: false,
  },
  {
    slug: "board-reach",
    name: "Board reach",
    summary: "List board cards in granted projects — and, with act, create or update a card on your behalf (owner-confirmed).",
    modes: ["read", "act"],
    tier: "act-capable",
    configKind: "none",
    appliesLive: false,
  },
  {
    slug: "vault-read",
    name: "Vault lookup",
    summary: "Search granted projects' Obsidian notes and answer from real docs. Read-only; secret-shaped files are never returned.",
    modes: ["read"],
    tier: "read",
    configKind: "none",
    appliesLive: false,
  },
  {
    slug: "attention-push",
    name: "Attention push",
    summary: "Proactively ping you when something needs attention (a merge gate, a blocked or crashed worker, a pending decision, …). Applies immediately — no restart.",
    modes: ["read"],
    tier: "read",
    configKind: "alertClasses",
    appliesLive: true,
  },
  {
    slug: "media-out",
    name: "Send media",
    summary: "Deliver a file — a mockup, a screenshot — from allowlisted source roots to your chat. Nothing is deliverable until you add at least one root.",
    modes: ["act"],
    tier: "elevated",
    configKind: "roots",
    appliesLive: false,
    elevatedAction: "deliver files from your allowlisted roots to your chat",
  },
  {
    slug: "session-steer",
    name: "Session control",
    summary: "Message, steer, stop and resume sessions in granted projects on your behalf — Loom's most powerful lever. Optionally restrict which session roles it can touch.",
    modes: ["act"],
    tier: "elevated",
    configKind: "roleFilter",
    appliesLive: false,
    elevatedAction: "message, steer, stop and resume sessions on your behalf",
  },
];

/** This lever's grant rows (one per granted project), from the flat per-session grant list. */
export function grantsForLever(grants: CompanionCapabilityGrant[], slug: string): CompanionCapabilityGrant[] {
  return grants.filter((g) => g.capability === slug);
}

/** A grant's config array for `key` (decisionClasses / roots / roleFilter / alertClasses), defensively
 *  narrowed to strings — the config is opaque `Record<string, unknown>`, so a malformed value reads empty. */
export function configStringArray(config: Record<string, unknown>, key: string): string[] {
  const v = config[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** A grant's numeric config value for `key` (attention-push digestMinutes), or undefined if unset/malformed. */
export function configNumber(config: Record<string, unknown>, key: string): number | undefined {
  const v = config[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** The default mode for a NEW grant on this lever: an act-only lever must be created `act` (its whole
 *  surface is the act half); everything else starts at the least-privilege `read`. */
export function defaultGrantMode(meta: LeverMeta): GrantMode {
  return meta.modes.length === 1 && meta.modes[0] === "act" ? "act" : "read";
}
