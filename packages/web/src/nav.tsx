import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import ReviewPanel from "./pages/ReviewPanel";
import QuestionAnswer from "./pages/QuestionAnswer";
import SessionView from "./pages/SessionView";
import MissionControl from "./pages/MissionControl";
import Projects from "./pages/Projects";
import Overview from "./pages/Overview";
import Archive from "./pages/Archive";
import Terminals from "./pages/Terminals";
import RequestsPage from "./pages/RequestsPage";
import Board from "./pages/Board";
import Memory from "./pages/Memory";
import Runs from "./pages/Runs";
import Gates from "./pages/Gates";
import Repository from "./pages/Repository";
import Actors from "./pages/Actors";
import Companion from "./pages/Companion";
import Automation from "./pages/Automation";
import Usage from "./pages/Usage";
import Platform from "./pages/Platform";
import Settings from "./pages/Settings";

// The four nav sections. Every destination is grouped under one of these in the Instrument Rail's
// grouped nav (components/Sidebar.tsx), with hairline separators between groups. Also used to bucket
// the route table (App.tsx) and the Command Palette page list.
export type NavGroup = "operate" | "project" | "config" | "system";

export type NavPage = {
  /** Full name — used by the Command Palette. */
  label: string;
  /** Short header-tab text when it differs from `label`. */
  nav?: string;
  to: string;
  /** Exact-match active state (for the index route). */
  end?: boolean;
  element: ReactNode;
  /** Which nav section this page falls under — its group in the rail. */
  group: NavGroup;
  /** Responds to the active-project picker — gets a scope-marker dot in the nav. */
  scoped?: boolean;
};

// Single source of truth for the nav destinations. The Instrument Rail's grouped nav
// (components/Sidebar.tsx), the route table (App.tsx), and the Command Palette page list
// (CommandPalette.tsx) all derive from this array, so they can never drift out of sync.
// Add a new destination here only — tag it with a `group`, and `scoped` as needed.
// (The parameterized routes are not nav destinations — nothing can link to /session/:id without an
// id — so they live in PARAM_PAGES at the bottom of this file instead.)
//
// The rail re-groups by `group`, so a destination's placement in this array only sets its order
// WITHIN its group; the section dividers below are for reading, not display order.
//
// `scoped` was determined from `git grep -l useActiveProject packages/web/src/pages` and then
// VERIFIED per page (does switching the active project actually rescope it?): Overview, Board,
// Memory (its project_memory read is enabled:!!projectId), Runs, Archive (its archived-sessions query
// is keyed on + enabled:!!projectId — it lists ONLY the active project's stopped sessions), Repository
// (both its Files/Git panes rescope), Settings (edits the active project's config override). Projects
// has its OWN project rail (which writes the active project) so it is intentionally NOT scoped.
// Automation is god-eye (both its tables span every project) so NOT `scoped`, even though its Time
// builder's own agent picker is active-project-scoped — a builder-internal scope, not a page-level
// rescope.
export const NAV_PAGES: NavPage[] = [
  // ── Formerly the "primary" header tabs — now ordinary rail destinations, grouped by `group` ──
  // The god-eye home. Grouped under Operate so it heads the sidebar's Operate section (the first
  // destination in the rail).
  { label: "Mission Control", nav: "Mission", to: "/", end: true, element: <MissionControl />, group: "operate" },
  // The project-scoped Overview — the analog of the Platform page for the header's active project
  // (identity + fleet + go-live + board + schedules + attention/activity + archive count, all rescoped
  // when you switch the active project). Composes the shared fleet widgets off existing endpoints.
  { label: "Overview", to: "/overview", element: <Overview />, group: "project", scoped: true },
  // The single "Platform" section — ONE tab, ONE /platform route. The page itself picks which surface to
  // render by EDITION (the reserved "Loom Platform" home existing): dev gets the Loom Platform home
  // (Lead/Auditor + findings board) plus a client-only "View as" toggle previewing the end-user surface;
  // shipping gets the end-user "Platform" operator + Workspace Auditor only. A top-level surface
  // SEPARATE from the project picker (both reserved homes stay out of the ordinary list). Deliberately
  // `scoped` OFF. The edition logic lives IN Platform.tsx, so there is no nav-level gating anymore.
  // /setup redirects to /platform (App.tsx) for any lingering links.
  { label: "Platform", to: "/platform", element: <Platform />, group: "system" },
  { label: "Terminals", to: "/terminals", element: <Terminals />, group: "operate" },
  { label: "Board", to: "/board", element: <Board />, group: "project", scoped: true },
  // Memory — the read-only, per-project window into project_memory (the durable knowledge the fleet writes
  // + recalls via the `memory` MCP). A flagship, project-scoped surface in the Project group (alongside
  // Overview + Board). `scoped: true`: it rescopes on the active-project picker (its one read,
  // api.projectMemory, is `enabled: !!projectId`).
  { label: "Memory", to: "/memory", element: <Memory />, group: "project", scoped: true },
  // ── Operate group (cont.) ────────────────────────────────────────────────────
  // The GLOBAL manager→human Inbox (card 695ebab0, generalizing the decision inbox 8701bdbb; renamed from
  // "Requests" by card 59fa6403) — a cross-project "waiting on me" + FYI queue of typed Requests (decision ·
  // input · permission · credential · notice), a god-eye destination like Mission Control (deliberately
  // NOT project-scoped). The bell/toast/⌘K + the Mission Control attention queue are the primary surfacing;
  // this is the fuller "see them all, filter by type/project" view + the consumed-history tab. The label is
  // "Inbox"; the route (`/inbox`) and the component/module names (RequestsPage, components/requests.tsx)
  // deliberately did NOT change — see docs/decisions/59fa6403-requests-to-inbox.md §(f) for why.
  { label: "Inbox", to: "/inbox", element: <RequestsPage />, group: "operate" },
  // Gates — the god-eye view of Loom's daemon-executed gates (merge, worker run_gate, deploy) across every
  // project, all serialized through one GateSemaphore. Active lane-hero (running + queued) on top, settled
  // history below, with its OWN per-project filter (default ALL) — so it's a cross-project god-eye view like
  // Mission Control, deliberately NOT `scoped` to the header picker.
  { label: "Gates", to: "/gates", element: <Gates />, group: "operate" },
  // ── Project group (cont.) ────────────────────────────────────────────────────
  // Repository — the consolidated Vault + Git surface (IA merge #3). One destination with a Files | Git
  // segmented switch above the two verbatim-lifted panes (Files = the vault tree + type-aware viewer;
  // Git = branches + commit-log + human-only write actions) — see pages/Repository.tsx. UNLIKE Automation,
  // this IS `scoped`: both panes are project-scoped (enabled:!!projectId) and rescope on the active-project
  // picker, so it keeps the scope dot. The old /vault and /git routes redirect here (App.tsx).
  { label: "Repository", to: "/repository", element: <Repository />, group: "project", scoped: true },
  // Runs and Archive moved here from Operate (card fc65729d, owner request): both are per-project surfaces
  // (scoped: true — see the `scoped` provenance note above) and read more naturally alongside Overview /
  // Board / Memory / Repository than among the god-eye Operate destinations. Routes/behavior unchanged.
  { label: "Runs", to: "/runs", element: <Runs />, group: "project", scoped: true },
  { label: "Archive", to: "/archive", element: <Archive />, group: "project", scoped: true },
  // ── Config group ─────────────────────────────────────────────────────────────
  // Projects — the definition/config layer: create/manage projects + define their agents (assign a
  // Profile, edit the startup prompt). Renamed + repositioned from the old "Workspace" page (card
  // 274f9ba9): it's config, not operate — it touches NO live sessions — so it sits with the other
  // "define your actors" surfaces (Actors). Its own project rail writes the active project,
  // so it is deliberately NOT `scoped`. /workspace redirects here (App.tsx) for lingering links.
  { label: "Projects", to: "/projects", element: <Projects />, group: "config" },
  // Actors — the consolidated Profiles + Skills surface (IA merge #1). One destination with a Profiles |
  // Skills segmented switch above the shared list→editor shell (see pages/Actors.tsx). Both are
  // daemon-global + human-only. The old /profiles and /skills routes redirect here (App.tsx).
  { label: "Actors", to: "/actors", element: <Actors />, group: "config" },
  // Companion management is daemon-GLOBAL (one companion config store, not project-scoped) — deliberately
  // not `scoped`. Declared here under Config alongside Profiles (the companion's restricted-tools toggle is
  // there), and always reachable in the rail's Config group whether or not a companion is active. (A
  // vestigial `useVisibleNavPages` runtime "promotion" that once flipped a `primary` flag when a companion
  // was active was removed with that flag — the rail renders every destination, so nothing consumed it.)
  { label: "Companion", to: "/companion", element: <Companion />, group: "config" },
  // Automation — the consolidated Schedules + Event Triggers surface (IA merge #2). One destination with a
  // Time (cron) | Events segmented switch above the shared trigger-table + builder-modal shell (see
  // pages/Automation.tsx). Both tables are god-eye — they span every project — so deliberately NOT `scoped`
  // (each builder scopes its OWN picker: the Time builder's target agent stays limited to the active
  // project). The old /schedules and /event-triggers routes redirect here (App.tsx).
  { label: "Automation", to: "/automation", element: <Automation />, group: "config" },
  // The standalone Orchestration page (its manager→worker→diff drill-down) was REMOVED (card bde7957f):
  // its two unique views — the per-manager orchestration_events timeline + the worker branch-diff — now
  // live as role-scoped tabs in the Overview fleet-card expansion (FleetAccordion → SessionCockpit), so
  // the drill-down is reached from the fleet card rather than a duplicate top-level destination.
  // ── System group ─────────────────────────────────────────────────────────────
  { label: "Usage", to: "/usage", element: <Usage />, group: "system" },
  { label: "Settings", to: "/settings", element: <Settings />, group: "system", scoped: true },
];

// ── The parameterized routes ───────────────────────────────────────────────────────────────────
// Where a parameterized address lives in the Atlas tree. Only the frame reads this; the page
// component underneath neither knows nor cares, which is phase 1's one hard rule
// (docs/plans/atlas-ui/02-architecture.md).
//
// Two shapes, because the three routes genuinely are two shapes. A SESSION address names an entity
// the tree holds a node for in its own right — the node hangs off that session's OWN project, which
// is not necessarily the active one — optionally with a node tab below it. A DETAIL address names a
// row WITHIN an existing nav destination, so the node stays that destination and the row is the last
// crumb. Homes assigned by `docs/plans/atlas-ui/01-parity-checklist.md` §A, not re-decided here.
export type AtlasAddress =
  /** `param` names a SESSION: the node IS that session, under its own project node, `tab` below it. */
  | { kind: "session"; param: string; tab?: string }
  /** `param` names a detail row inside the NAV_PAGES destination whose `to` is `under`. */
  | { kind: "detail"; under: string; param: string };

export type ParamPage = {
  /** The route pattern, mounted verbatim by both shells. */
  to: string;
  element: ReactNode;
  atlas: AtlasAddress;
};

// Declared HERE rather than inline in a shell because BOTH shells mount them (App.tsx's LegacyShell
// and components/AtlasShell.tsx). A path/element pair copied into two route tables drifts the moment
// one of them is edited — and the drift is silent, since each shell renders only when its own switch
// state is live, so a test exercising one can never notice the other went stale.
export const PARAM_PAGES: ParamPage[] = [
  { to: "/review/:workerId", element: <ReviewPanel />, atlas: { kind: "session", param: "workerId", tab: "Diff" } },
  { to: "/question/:id", element: <QuestionAnswer />, atlas: { kind: "detail", under: "/inbox", param: "id" } },
  { to: "/session/:id", element: <SessionView />, atlas: { kind: "session", param: "id" } },
];

// ── The legacy redirects ───────────────────────────────────────────────────────────────────────
// Old URLs kept working after an IA merge or a rename. Each one's `to` is the destination's CURRENT
// address — including the `?tab=` that picks its sub-tab — which under phase 1 is also its ATLAS
// node+tab address, because both shells mount every NAV_PAGES destination at its own path. So there
// is ONE `to` per row and not an Atlas/classic pair: a second target would be a second thing to keep
// in step, and since each shell renders only under its own switch state, a test exercising one could
// never see the other go stale. If phase 2 ever moves a destination's real address, change `to`
// here and BOTH shells follow.
export type LegacyRedirect = {
  /** The old path, mounted verbatim by both shells. */
  from: string;
  /** Where it lands — a NAV_PAGES `to`, plus the `?tab=` that selects its sub-tab where one applies. */
  to: string;
  element: ReactNode;
};

// The `<Navigate>` is built HERE, once per row, rather than in each shell's route table: `replace`
// (keep the dead URL out of the history stack, so Back leaves the page rather than bouncing through
// the redirect) is part of the redirect's behaviour, and a flag spelled out in two route tables is a
// flag that can end up spelled differently in two route tables.
//
// `to` is a plain path string, so react-router resolves it as given: the INCOMING query and hash are
// dropped, and a target's own `?tab=` always wins. That is exactly what these redirects have always
// done — carrying a stale page's query onto a different page is not parity, and nothing links to
// these paths WITH a query — so it stays the behaviour under both shells.
function redirect(from: string, to: string): LegacyRedirect {
  return { from, to, element: <Navigate to={to} replace /> };
}

export const LEGACY_REDIRECTS: LegacyRedirect[] = [
  // /setup was the old end-user Platform route — now consolidated into /platform. Catches lingering
  // links/bookmarks and the first-run welcome's historical target.
  redirect("/setup", "/platform"),
  // /workspace was renamed + repositioned to /projects (card 274f9ba9).
  redirect("/workspace", "/projects"),
  // /profiles + /skills were consolidated into the single /actors page (IA merge #1).
  redirect("/profiles", "/actors"),
  redirect("/skills", "/actors?tab=skills"),
  // /schedules + /event-triggers were consolidated into the single /automation page (IA merge #2).
  redirect("/schedules", "/automation"),
  redirect("/event-triggers", "/automation?tab=events"),
  // /vault + /git were consolidated into the single /repository page (IA merge #3).
  redirect("/vault", "/repository"),
  redirect("/git", "/repository?tab=git"),
];

// The source of truth for what the rail nav (Sidebar) and the Command Palette LIST show (both call this).
// Every nav page is always listed and always reachable in the rail's grouped nav — there is no runtime nav
// gating left. (The dev-vs-shipping edition split that used to hide a second "Platform" tab now lives
// INSIDE the single Platform page, which picks its surface by edition; and Companion's old `primary`
// promotion was vestigial once the rail shipped — the rail renders every destination grouped — so it was
// removed with the `primary` flag.) Kept as a hook (rather than exporting NAV_PAGES to consumers directly)
// so its return stays a stable seam the Command Palette + tests reference.
export function useVisibleNavPages(): NavPage[] {
  return NAV_PAGES;
}
