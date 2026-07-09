// The four spawn roles the Platform surface can go-live — a subset of both SessionRole and the
// `api.startSession` role param (so an edition role is assignable to both roleDisplay and startSession).
export type PlatformSpawnRole = "platform" | "auditor" | "setup" | "workspace-auditor";

// The EDITION CONFIG for the unified Platform shell (PlatformView.tsx). The Developer and End-User
// Platform surfaces are ONE shared shell driven by this data-only config — the four genuine behavioral
// forks (multi-Lead vs singleton, list vs single-form auditor schedules, roles/endpoints, layout) stay
// REAL, selected here by config, NOT homogenized (Bucket-2b isn't shipping, so the forks exist on
// purpose — see card 8adccd37 / vault Design/[[Platform Divergence — Unify Up + Thin Local Overlay]]).
//
// JSX-FREE ON PURPOSE: this module holds only data + pure functions (no React, no `api` import, no side
// effects), so the hermetic test (`test/platform-edition.mjs`, run under node --experimental-strip-types)
// can import it directly to assert the gating both ways + the schedule variants — mirroring lib/companion.ts.
//
// HARD INVARIANT it upholds: each edition carries a STATIC role (`operatorRole`/`auditorRole`). The shell
// reads the role from the edition prop, never from the edition-preview toggle in Platform.tsx — so that
// toggle stays a PURE CLIENT-SIDE VIEW SWITCH: it selects WHICH edition mounts and nothing else, and can
// never be read by, passed to, or wired into a spawn/role/stop call. This module holds only static config
// + pure functions; it never touches the toggle's persisted key or browser storage (asserted by the test).

export type PlatformEditionKind = "developer" | "enduser";

// One agent card's copy — the operator (Lead / Platform) and the auditor (Auditor / Workspace Auditor).
// TONE is NOT here (it reads from roleDisplay(role).tone in the shell); only the display LABEL + text.
export interface AgentCardCopy {
  badgeLabel: string; // the product-brand label on the card badge (dev "Lead"/"Auditor"; enduser "Platform"/"Auditor")
  missingLabel: string; // shown when the agent isn't seeded
  spawn: { idle: string; pending: string; live: string }; // the go-live button label per state
  title: { idle: string; live: string }; // the go-live button tooltip per state
  stopTitle: string; // the Stop button tooltip
  inlineError: boolean; // surface a spawn failure on the card, not the global blocking alert
}

// One RunHistory block's copy (operator-role + auditor-role histories).
export interface HistoryCopy {
  title: string; // section title / disclosure title
  hint: string; // the muted descriptive span
  empty: string; // RunHistory emptyLabel
}

export interface PlatformEditionCopy {
  errorText: string; // shown when the reserved home fails to resolve
  header: { mutedSpan: string; paragraph: string };
  agentsLabel: string; // the go-live section label ("Agents" | "Assistants")
  operatorCard: AgentCardCopy;
  auditorCard: AgentCardCopy;
  sessionsLabel: string; // dev grid section label ("Sessions")
  sessionsEmpty: string; // dev grid empty state
  operatorSessionLabel: string; // enduser split section label ("Operator session")
  operatorSessionEmpty: string;
  auditorSessionLabel: string; // enduser split section label ("Auditor session")
  auditorSessionEmpty: string;
  auditorScheduleLabel: string; // dev list section label ("Auditor schedule")
  operatorHistory: HistoryCopy;
  auditorHistory: HistoryCopy;
  board: { label: string; hint: string };
}

export interface PlatformEdition {
  kind: PlatformEditionKind;
  // --- discovery (the shell maps homeQueryKey → api.platformHome/api.setupHome; the config stays api-free) ---
  homeQueryKey: "platformHome" | "setupHome";
  // --- roles (STATIC literals — the invariant: role comes from here, never from the ViewAs toggle) ---
  operatorRole: PlatformSpawnRole; // "platform" (Lead) | "setup" (operator)
  auditorRole: PlatformSpawnRole; // "auditor" | "workspace-auditor"
  // --- agent-resolution fallback names (when no profile resolves the role) ---
  operatorName: string; // "Platform Lead" | "Platform"
  auditorName: string; // "Platform Auditor" | "Workspace Auditor"
  // --- the two crossed gating booleans (see the matrix in operator/auditorSpawnDisabled) ---
  operatorSingleton: boolean; // dev false (multi-Lead) | enduser true (singleton operator)
  auditorCreateOnly: boolean; // dev false (disabled-while-live) | enduser true (fresh run each click)
  // --- layout / variant forks ---
  sessionLayout: "grid" | "split"; // dev grid of all live | enduser two single-session sections
  historyCollapsed: boolean; // dev true (CollapsibleHistory) | enduser false (expanded)
  auditorScheduleVariant: "list" | "single-form"; // dev multi-row list | enduser single edit-cron form
  auditorHistoryShowFindings: boolean; // dev true | enduser false
  copy: PlatformEditionCopy;
}

// ── Pure gating helpers — the singleton-vs-multi decision, exercised BOTH ways by the hermetic test. ──
//
// Gating matrix (preserves today's exact behavior):
//   edition   | operator (Lead/Platform)        | auditor
//   developer | never gated by live (multi-Lead)| disabled while live
//   enduser   | disabled while live (singleton) | never gated (create-only, fresh run each click)
export function operatorSpawnDisabled(edition: PlatformEdition, s: { live: boolean; pending: boolean }): boolean {
  return s.pending || (edition.operatorSingleton && s.live);
}
export function auditorSpawnDisabled(edition: PlatformEdition, s: { live: boolean; pending: boolean }): boolean {
  return s.pending || (!edition.auditorCreateOnly && s.live);
}

// ── The DEV edition — the canonical rendering (the richer surface). ──
export const developerEdition: PlatformEdition = {
  kind: "developer",
  homeQueryKey: "platformHome",
  operatorRole: "platform",
  auditorRole: "auditor",
  operatorName: "Platform Lead",
  auditorName: "Platform Auditor",
  operatorSingleton: false,
  auditorCreateOnly: false,
  sessionLayout: "grid",
  historyCollapsed: true,
  auditorScheduleVariant: "list",
  auditorHistoryShowFindings: true,
  copy: {
    errorText: "No reserved “Loom Platform” project found — the platform layer may not be seeded yet.",
    header: {
      mutedSpan: "the management layer above all projects · hidden from the project picker",
      paragraph:
        "The Platform Lead is the always-available, human-driven operator above all projects; the Auditor is the " +
        "scheduled, read-and-file-only transcript reviewer. Spawning either is a human go-live action — you may run " +
        "several Leads concurrently (they coordinate via the board). Findings + manager escalations land on the " +
        "board below for you to triage.",
    },
    agentsLabel: "Agents",
    operatorCard: {
      badgeLabel: "Lead",
      missingLabel: "Platform Lead agent not seeded",
      spawn: { idle: "Spawn Lead", pending: "Spawning…", live: "Spawn Lead" },
      title: {
        idle: "Spawn the Lead (human go-live)",
        live: "Spawn another Lead — multiple may run concurrently",
      },
      stopTitle: "Stop this session — graceful Ctrl-C, clean and resumable",
      inlineError: false,
    },
    auditorCard: {
      badgeLabel: "Auditor",
      missingLabel: "Platform Auditor agent not seeded",
      spawn: { idle: "Spawn Auditor", pending: "Spawning…", live: "Live" },
      title: {
        idle: "Spawn the Auditor (human go-live)",
        live: "Auditor is already live",
      },
      stopTitle: "Stop this session — graceful Ctrl-C, clean and resumable",
      inlineError: false,
    },
    sessionsLabel: "Sessions",
    sessionsEmpty: "No platform sessions running. Spawn the Lead or Auditor above.",
    operatorSessionLabel: "Operator session",
    operatorSessionEmpty: "",
    auditorSessionLabel: "Auditor session",
    auditorSessionEmpty: "",
    auditorScheduleLabel: "Auditor schedule",
    operatorHistory: {
      title: "Lead history",
      hint: "every Lead session — when it ran, context cost, duration; expand to read the transcript",
      empty: "No Lead sessions yet — the Platform Lead hasn’t run.",
    },
    auditorHistory: {
      title: "Auditor history",
      hint: "every audit session — trigger, context cost, findings filed; expand to read the transcript",
      empty: "No audit sessions yet — the Auditor hasn’t run.",
    },
    board: {
      label: "Board",
      hint: "Auditor findings + manager escalations — triage by dragging cards",
    },
  },
};

// ── The END-USER edition — the shipping surface (and the dev "View as: End-user" preview). ──
export const endUserEdition: PlatformEdition = {
  kind: "enduser",
  homeQueryKey: "setupHome",
  operatorRole: "setup",
  auditorRole: "workspace-auditor",
  operatorName: "Platform",
  auditorName: "Workspace Auditor",
  operatorSingleton: true,
  auditorCreateOnly: true,
  sessionLayout: "split",
  historyCollapsed: false,
  auditorScheduleVariant: "single-form",
  auditorHistoryShowFindings: false,
  copy: {
    errorText: "No reserved “Platform” project found — the home may not be seeded yet.",
    header: {
      mutedSpan: "your workspace operator · hidden from the project picker",
      paragraph:
        "Platform is your friendly, user-facing workspace operator — creating and configuring your projects, " +
        "agents and profiles, choosing which skills each rig enables, and acting on your behalf (confirming big " +
        "or irreversible actions first). Start it below and tell it what you want to build. The Workspace Auditor is a " +
        "read-only reviewer — run it any time and it files improvement suggestions onto your home board.",
    },
    agentsLabel: "Assistants",
    operatorCard: {
      badgeLabel: "Platform",
      missingLabel: "Platform agent not seeded",
      spawn: { idle: "Start Platform", pending: "Starting…", live: "Live" },
      title: {
        idle: "Start Platform",
        live: "Platform is already live",
      },
      stopTitle: "Stop this session — graceful Ctrl-C, clean and resumable",
      inlineError: true,
    },
    auditorCard: {
      badgeLabel: "Auditor",
      missingLabel: "Workspace Auditor not seeded",
      spawn: { idle: "Review my workspace", pending: "Starting…", live: "Review my workspace" },
      title: {
        idle: "Review my workspace — spawns a fresh read-only Auditor run that files improvement suggestions to your home board",
        live: "Review my workspace — spawns a fresh read-only Auditor run that files improvement suggestions to your home board",
      },
      stopTitle: "Stop this Auditor run — graceful Ctrl-C, clean and resumable",
      inlineError: true,
    },
    sessionsLabel: "Sessions",
    sessionsEmpty: "",
    operatorSessionLabel: "Operator session",
    operatorSessionEmpty: "No Platform session running. Start Platform above.",
    auditorSessionLabel: "Auditor session",
    auditorSessionEmpty: "No Auditor run active. Click “Review my workspace” above to start one.",
    auditorScheduleLabel: "Auditor schedule",
    operatorHistory: {
      title: "Operator history",
      hint: "every operator session — when it ran, context cost, duration; expand to read the transcript",
      empty: "No operator sessions yet — Platform hasn’t run.",
    },
    auditorHistory: {
      title: "Auditor history",
      hint: "every workspace review — when it ran, context cost, duration; expand to read the transcript",
      empty: "No reviews yet — click “Review my workspace” above to run one.",
    },
    board: {
      label: "Your board",
      hint: "your setup checklist + Auditor suggestions — triage by dragging cards",
    },
  },
};
