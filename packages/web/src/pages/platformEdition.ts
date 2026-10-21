// The four spawn roles the Platform surface can go-live — a subset of both SessionRole and the
// `api.startSession` role param (so an edition role is assignable to both roleDisplay and startSession).
export type PlatformSpawnRole = "platform" | "auditor" | "setup" | "workspace-auditor";

// The EDITION CONFIG for the unified Platform shell (PlatformView.tsx). The Developer and End-User
// Platform surfaces are ONE shared shell driven by this data-only config.
//
// @decision 8adccd37 — the four genuine behavioral forks (multi-Lead vs singleton, list vs single-form
// auditor schedules, roles/endpoints, layout) stay REAL, selected here by config, and are never
// homogenized: Bucket-2b (the operator's elevated surface) isn't shipping to end users.
//
// JSX-FREE ON PURPOSE: this module holds only data + pure functions (no React, no `api` import, no side
// effects), so the hermetic test (`test/platform-edition.mjs`, run under node --experimental-strip-types)
// can import it directly to assert the gating both ways + the schedule variants — mirroring lib/companion.ts.
//
// HARD INVARIANT it upholds: each edition carries a STATIC default role (`operatorRole`/`auditorRole`),
// read from the edition prop, NEVER from the edition-preview toggle in Platform.tsx — so that toggle
// stays a PURE CLIENT-SIDE VIEW SWITCH: it selects WHICH edition mounts and nothing else, and can never
// be read by, passed to, or wired into a spawn/role/stop call. (The shell separately refines the
// OPERATOR's actual spawn role from the live agent's bound profile — f437d4e9 C5 round 2, item 1b — but
// that reads profile data, never the toggle, so this invariant is untouched.) This module holds only
// static config + pure functions; it never touches the toggle's persisted key or browser storage
// (asserted by the test).

export type PlatformEditionKind = "developer" | "enduser";

// The orchestration-event kind each edition's auditor files its findings as. These are the daemon's OWN
// two emit sites (sessions/service.ts): the Platform Auditor files `audit_finding` onto the reserved
// Platform board, and the de-privileged workspace auditor files `workspace_audit_suggestion` onto the
// user's own home. So the KIND already scopes a findings read to the right reserved home — a consumer
// never has to join the events against a session list to keep one edition's findings out of the other's.
// Spelled as a local literal union rather than importing OrchestrationEventKind, to keep this module's
// "no imports at all" property (see the JSX-FREE note above); both members are real kinds, which
// TypeScript checks at the api.orchestrationEventsByKinds call site.
export type PlatformFindingKind = "audit_finding" | "workspace_audit_suggestion";

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
  // The findings readout's own copy. Only the Atlas Platform node renders a dedicated findings surface
  // (the classic layout shows findings inline on each auditor run row — RunHistory's `showFindings`), so
  // this pack is read there; it lives here with the rest of the copy so neither layout owns a second
  // vocabulary for the same data.
  findings: { label: string; hint: string; empty: string };
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
  findingEventKind: PlatformFindingKind; // dev "audit_finding" | enduser "workspace_audit_suggestion"
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

// ── The operator's DYNAMIC spawn role (f437d4e9 C5 round 3, M2/M4d) — card be9cb999. ──
//
// Mirrors first-run.ts's own resolution (profile role "platform" ⇒ "platform", else "setup"), but with
// ONE extra state first-run.ts doesn't need: while the profiles query hasn't loaded yet, the operator's
// REAL role is genuinely UNKNOWN — never guess "setup" (a click in that window would wrongly mint a
// setup session on what is likely the real platform-role Lead agent). `spawnDisabled:true` is the
// signal callers must use to hold the spawn button, not a fallback role value (the `role` returned in
// that case is just the edition's static default, for rendering only — never meant to be spawned with).
export function resolveOperatorSpawnRole(params: {
  hasOperator: boolean;
  profilesLoaded: boolean;
  operatorProfileRole: string | null;
  fallbackRole: PlatformSpawnRole;
}): { role: PlatformSpawnRole; spawnDisabled: boolean } {
  const { hasOperator, profilesLoaded, operatorProfileRole, fallbackRole } = params;
  if (!hasOperator) return { role: fallbackRole, spawnDisabled: false }; // no agent to spawn at all — the "missing" card handles this
  if (!profilesLoaded) return { role: fallbackRole, spawnDisabled: true }; // unknown — never guess, never spawn
  return { role: operatorProfileRole === "platform" ? "platform" : "setup", spawnDisabled: false };
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
  findingEventKind: "audit_finding",
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
    findings: {
      label: "Auditor findings",
      hint: "every finding the Auditor has filed, newest first — open one to triage it on the board",
      empty: "No findings filed yet — the Auditor hasn’t found anything to report.",
    },
  },
};

// ── The END-USER edition — the shipping surface (and the dev "View as: End-user" preview). ──
export const endUserEdition: PlatformEdition = {
  kind: "enduser",
  homeQueryKey: "setupHome",
  // f437d4e9 C5: the shipping end-user operator now runs as the full Platform Lead (role "platform"),
  // not the narrower Setup Assistant — matches the daemon's seed/migration (setup/seed.ts). On a DEV
  // install's "View as: End-user" preview, the underlying Getting-Started agent is deliberately NEVER
  // upgraded (§1c) and stays role "setup", so Platform.tsx passes `previewOnly`.
  //
  // @decision b472645a — that flag holds EVERY write the shell renders, not just the spawn button this
  // comment used to name. The preview is read-only; do not describe it as a spawn-only hold.
  operatorRole: "platform",
  auditorRole: "workspace-auditor",
  operatorName: "Platform",
  auditorName: "Workspace Auditor",
  operatorSingleton: true,
  auditorCreateOnly: true,
  sessionLayout: "split",
  historyCollapsed: false,
  auditorScheduleVariant: "single-form",
  auditorHistoryShowFindings: false,
  findingEventKind: "workspace_audit_suggestion",
  copy: {
    errorText: "No reserved “Platform” project found — the home may not be seeded yet.",
    header: {
      mutedSpan: "your cross-project workspace agent · hidden from the project picker",
      // Wording tracks the fact-checked README/site copy (commit 06267d94) — the capability list and the
      // "acts on its own … built to confirm first" phrasing are deliberate: confirm-first is DOCTRINE the
      // agent follows, NOT a gate Loom enforces, so never phrase it as "it confirms" (owner Request
      // cfbdef3d). Keep the three in sync when any of them changes.
      paragraph:
        "Platform is your friendly, cross-project workspace agent — it creates and configures your projects, " +
        "agents and profiles, spawns and oversees sessions, and triages your board. It acts on its own for " +
        "ordinary admin and is built to confirm first for anything irreversible or outward-facing, like pushing " +
        "to a shared repo. Start it below and tell it what you want to build. The Workspace Auditor is a " +
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
    findings: {
      label: "Workspace suggestions",
      hint: "every improvement the Auditor has suggested, newest first — open one to act on it on your board",
      empty: "No suggestions yet — run a workspace review and they’ll land here.",
    },
  },
};
