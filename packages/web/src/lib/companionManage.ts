// The Companion Manage surface, as data — card e2af6ad7 (Atlas build plan P2-6), closing §J.1 of
// docs/plans/atlas-ui/01-parity-checklist.md. Both layouts are a VIEW over the one list below, so a
// thirteenth section cannot reach one of them and miss the other.
//
// @decision e2af6ad7 — never re-order COMPANION_MANAGE_SECTIONS to match the Atlas grouping: that
// array's order IS the classic page's column order, which must not move before phase 3. The Atlas
// groups are a filter over it, never a re-sort of it.

/** The four Atlas sub-sections. Named for what they govern, not for which component happens to live there. */
export type CompanionManageGroup = "run" | "channels" | "persona" | "trust";

/**
 * One Manage section. `key` is stable (it names the section, not its component) and is what the
 * `?sec=` URL param and the panels' test ids carry.
 */
export type CompanionManageSectionKey =
  | "config" | "home" | "voice"
  | "channels" | "pairing"
  | "persona" | "skills" | "memory" | "reminders"
  | "restricted-tools" | "capabilities" | "delete";

export interface CompanionManageSection {
  key: CompanionManageSectionKey;
  group: CompanionManageGroup;
}

export interface CompanionManageGroupMeta {
  key: CompanionManageGroup;
  label: string;
  /** One line under the sub-tab row saying what this group decides. Orientation, not documentation. */
  blurb: string;
}

// Four groups, in reading order: how it runs, where it can be reached, who it is, what it may do.
//
// `trust` carries the destructive cluster as well as the permission one — restricted tools, capability
// grants (which hosts lead mode) and deleting the companion outright. That is deliberate: they are the
// three controls whose consequences reach outside this page, and the owner reads them in one pass
// rather than meeting "Delete companion" at the bottom of an unrelated column.
// Each blurb is sized to ONE line at the caption's own measure (the test caps it) — a sub-tab row that
// grows a paragraph under it has stopped orienting anyone.
export const COMPANION_MANAGE_GROUPS: CompanionManageGroupMeta[] = [
  { key: "run", label: "Run", blurb: "how it runs — config, where it reports proactively, and voice." },
  { key: "channels", label: "Channels", blurb: "where it can be reached, who may reach it, and how to pair one." },
  { key: "persona", label: "Persona", blurb: "who it is and what it carries — prompt, skills, memory, reminders." },
  { key: "trust", label: "Trust", blurb: "what it is allowed to do, and removing it. Human-only, all of it." },
];

/**
 * The twelve sections, in the CLASSIC page's own column order. Read the `@decision` note at the top of
 * this file before re-ordering anything here. `test/companion-manage-sections.mjs` pins this flat order
 * against an independently written copy of today's column.
 */
export const COMPANION_MANAGE_SECTIONS: CompanionManageSection[] = [
  { key: "config", group: "run" },
  { key: "home", group: "run" },
  { key: "voice", group: "run" },
  { key: "channels", group: "channels" },
  { key: "persona", group: "persona" },
  { key: "skills", group: "persona" },
  { key: "memory", group: "persona" },
  { key: "reminders", group: "persona" },
  { key: "restricted-tools", group: "trust" },
  { key: "capabilities", group: "trust" },
  { key: "pairing", group: "channels" },
  { key: "delete", group: "trust" },
];

/** The section keys in `group`, in this file's declared order. */
export function manageSectionsInGroup(group: CompanionManageGroup): CompanionManageSectionKey[] {
  return COMPANION_MANAGE_SECTIONS.filter((s) => s.group === group).map((s) => s.key);
}

/**
 * A `?sec=` value → the group it names, or the canonical first group when it names nothing (an old link,
 * a hand-typed typo, a cleared param). Spelled as a literal rather than read off `[0]` because an index
 * read is only `undefined`-free under an assertion; `test/companion-manage-sections.mjs` pins it to
 * `COMPANION_MANAGE_GROUPS[0].key` so the two cannot drift.
 */
export function resolveManageGroup(raw: string | null | undefined): CompanionManageGroup {
  return COMPANION_MANAGE_GROUPS.some((g) => g.key === raw) ? (raw as CompanionManageGroup) : "run";
}

// ── The Atlas Companion node's three modes ─────────────────────────────────────────────────────
// The same three the classic page's own `role="tablist"` ModeToggle offers, lifted to the node's `?tab=`
// so a mode is linkable and survives a reload. Chat is canonical, so its URL carries no `tab` at all.

export type CompanionMode = "chat" | "manage" | "terminal";

export const COMPANION_MODES: { key: CompanionMode; label: string }[] = [
  { key: "chat", label: "Chat" },
  { key: "manage", label: "Manage" },
  { key: "terminal", label: "Terminal" },
];

/** A `?tab=` value → the mode it names, falling back to the canonical Chat. */
export function resolveCompanionMode(raw: string | null | undefined): CompanionMode {
  const hit = COMPANION_MODES.find((m) => m.key === raw);
  return hit ? hit.key : "chat";
}
