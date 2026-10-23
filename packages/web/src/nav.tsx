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
import Settings, { WorkspaceSettings } from "./pages/Settings";
import WorkspaceHome from "./pages/WorkspaceHome";
import ProjectHome from "./pages/ProjectHome";
import AgentsNode from "./pages/AgentsNode";

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

// ── The Atlas-only nodes ───────────────────────────────────────────────────────────────────────
// The Workspace root and the project node — card fd99b2d7 (Atlas P2-1) — joined by the Agents node
// (card c6160c7d, P2-2). The ONLY addresses in this file the classic shell does NOT mount; its
// three sibling lists above are both-shells by design.
//
// @decision fd99b2d7 — never add these to LegacyShell's route table, and never re-point `/` or
// `/overview` at them inside AtlasShell: the first shows a half-built preview to a user who never
// opted in, the second breaks phase 1's content-identity contract. Both are P3-switch-over's job.
//
// A node's own tabs are `?tab=` on the SAME path, owned by the page component — not routes, so the
// frame's crumbs and heading stay a function of the node, not of which tab is showing.
export type AtlasHome = {
  /** Stable identity for the tree row's test id and the shell's own address lookup. */
  key: "workspace" | "project" | "agents" | "workspace-settings";
  to: string;
  /** The tree row's label. */
  label: string;
  /** True ⇒ the node hangs under the active project, in the tree and in the crumb trail. */
  scoped: boolean;
  /**
   * True ⇒ this node IS its tier's head, so the trail STOPS at the tier and the heading is the
   * tier's own name (the workspace, or the active project). False ⇒ an ordinary node WITHIN the
   * tier, whose own `label` is the deepest crumb and the heading — exactly as a NAV_PAGES
   * destination's is, because that is exactly what it is to a reader.
   */
  tierHead: boolean;
  element: ReactNode;
};

export const ATLAS_HOMES: AtlasHome[] = [
  { key: "workspace", to: "/home", label: "Home", scoped: false, tierHead: true, element: <WorkspaceHome /> },
  { key: "project", to: "/project", label: "Home", scoped: true, tierHead: true, element: <ProjectHome /> },
  { key: "agents", to: "/agents", label: "Agents", scoped: true, tierHead: false, element: <AgentsNode /> },
  // The Workspace tier's own Settings node (card 595e2a47, P2-12). `/settings` is `scoped` above, so
  // under Atlas it is the PROJECT tier's Settings and carries only the rows that write a project's
  // config; the daemon-global rows need an address on the workspace tier, and this is it. Labelled
  // "Settings" like its project-tier twin — depth says which one, exactly as it does for "Home".
  //
  // Atlas-only, hence ATLAS_HOMES and not NAV_PAGES: a NAV_PAGES entry is mounted by BOTH shells, so
  // it would put a second Settings row in the classic rail for a user who never opted in.
  { key: "workspace-settings", to: "/workspace-settings", label: "Settings", scoped: false, tierHead: false, element: <WorkspaceSettings /> },
];

// ── The Workspace node's tabs ──────────────────────────────────────────────────────────────────
// Card 41eab0eb (Atlas restructure 2 of 11). The approved round-4 V2 design makes every cross-project
// surface a TAB on the Workspace node under one persistent KPI readout (`atlas.js`'s own `ROOT_TABS`),
// never a tree row — so the seven surfaces below leave their addresses and become `?tab=` on `/home`,
// each one's EXISTING component mounted verbatim as the tab body.
//
// A row is just the tab's own key plus the address it is re-homed FROM. The label and the element are
// resolved from that address's own NAV_PAGES / ATLAS_HOMES row (`workspaceNodeTabOf` below), so there
// is exactly one declaration of each and a rename reaches the tab for free. Order IS the tab order,
// and it is the mockup's `ROOT_TABS` order; the node's own `Overview`/`Deck` tabs are prepended by
// pages/WorkspaceHome.tsx, as the mockup's `homeTabs()` prepends them there.
//
// @decision 41eab0eb — `from` must stay a live NAV_PAGES/ATLAS_HOMES address. Removing it re-homes the
// surface out of the CLASSIC shell too, for a user who never opted into Atlas; only the Atlas shell may
// redirect it into the tab.
export type WorkspaceNodeTab = {
  /** The `?tab=` value on `/home`. */
  key: string;
  /** The address this surface owns under the classic shell, and which Atlas redirects into the tab. */
  from: string;
};

export const WORKSPACE_NODE_TABS: WorkspaceNodeTab[] = [
  { key: "inbox", from: "/inbox" },
  { key: "gates", from: "/gates" },
  { key: "automation", from: "/automation" },
  { key: "actors", from: "/actors" },
  { key: "usage", from: "/usage" },
  { key: "companion", from: "/companion" },
  // The Atlas-only workspace Settings node (card 595e2a47) — a `ROOT_TABS` row in the approved design,
  // so it re-homes with the six rail destinations above rather than staying a tree row of its own. Its
  // label is already "Settings", which is the tab label the mockup gives it.
  { key: "settings", from: "/workspace-settings" },
];

/** The tab a given address re-homes into, or `undefined` for an address that is still its own node. */
export function workspaceNodeTabFor(path: string): WorkspaceNodeTab | undefined {
  return WORKSPACE_NODE_TABS.find((t) => t.from === path);
}

/**
 * A tab's label and body, resolved from the ONE declaration of the address it re-homes — NAV_PAGES for
 * the six rail destinations, ATLAS_HOMES for the Atlas-only workspace Settings node. Throws rather
 * than degrading: a `from` naming no declared address is a typo that would otherwise render an empty
 * tab, and the tab row would still look complete.
 */
export function workspaceNodeTabOf(tab: WorkspaceNodeTab): { key: string; label: string; element: ReactNode } {
  const page = NAV_PAGES.find((p) => p.to === tab.from);
  if (page) return { key: tab.key, label: page.label, element: page.element };
  const home = ATLAS_HOMES.find((h) => h.to === tab.from);
  if (home) return { key: tab.key, label: home.label, element: home.element };
  throw new Error(`WORKSPACE_NODE_TABS declares ${tab.from}, which is neither a NAV_PAGES nor an ATLAS_HOMES address`);
}

// ── The project node's tabs ────────────────────────────────────────────────────────────────────
// Card 25c08fba (Atlas restructure 3 of 11). The approved round-4 V2 design puts every
// project-scoped surface on the project NODE, as a tab under its persistent readout, rather than
// leaving each one a full page of its own — `atlas.js`'s `PROJ_TABS`, prepended by `homeTabs("proj")`
// (Overview + Deck), which is exactly the ten rows below in exactly that order.
//
// 🔴 A TAB'S ADDRESS IS THE PATH IT ALREADY HAD. Only the two HOME tabs are `?tab=` on the node's own
// path, because they are two readings of the same home — which is what the mockup's own
// `homeTabs().concat(PROJ_TABS)` split says they are. Every other tab keeps `/board`, `/memory`,
// `/repository` and friends. Three reasons, each load-bearing:
//
//   • A `?tab=` on `/project` would COLLIDE with the page's own `?tab=`. Repository reads `?tab=git`
//     off the query string itself (pages/Repository.tsx), as Actors and Automation do; one query
//     parameter cannot address both the node's tab and the tab body's own sub-tab.
//   • `LEGACY_REDIRECTS` below is mounted by BOTH shells from ONE declaration, so a row pointing
//     `/board` at `/project?tab=board` would redirect the CLASSIC shell too — and this card's DoD is
//     that every old path still renders its classic page untouched with the switch off. The
//     alternative, a second Atlas-only redirect table, is a second list to keep in step for no gain.
//   • Nothing has to be re-pointed. Every `<Link to="/runs">`, every band panel's `action`, every
//     command-palette row and every bookmark already names these paths, so the re-home costs no link
//     churn and no redirect hop — which is also why this card adds no `LEGACY_REDIRECTS` row at all:
//     a redirect needs an address to leave behind, and these addresses did not move.
//
// @decision 25c08fba — never re-address a project tab as `?tab=` on /project. It collides with the
// tab body's own `?tab=`, and a both-shells redirect row would break the switch-OFF contract.
export type ProjectNodeTab = {
  /** The `?tab=` value for a HOME tab, and the `atlas-tab-<key>` testid stem for every tab. */
  key: string;
  /** What the project node calls this surface — the tab's label, and the frame's deepest crumb. */
  label: string;
  /** The tab's own address. A home tab's is the project node's own path. */
  to: string;
};

/** The project node's own path — the one address the two home tabs share. */
export const PROJECT_NODE_PATH = "/project";

export const PROJECT_NODE_TABS: ProjectNodeTab[] = [
  { key: "overview", label: "Overview", to: PROJECT_NODE_PATH },
  { key: "deck", label: "Deck", to: `${PROJECT_NODE_PATH}?tab=deck` },
  { key: "board", label: "Board", to: "/board" },
  // "Sessions", not "Terminals": the only tab here that genuinely CHANGES TIER. /terminals is a
  // god-eye page in the classic rail, and the approved design has it as a PROJECT tab ("Sessions 5"),
  // so under Atlas it moves to project depth and takes the node's own name for it. The classic rail's
  // own label and depth are untouched — NAV_PAGES above still declares it unscoped, because the
  // CLASSIC page still is: it rescopes only through the project filter the Atlas tab pre-selects.
  { key: "sessions", label: "Sessions", to: "/terminals" },
  { key: "agents", label: "Agents", to: "/agents" },
  { key: "repository", label: "Repository", to: "/repository" },
  { key: "memory", label: "Memory", to: "/memory" },
  { key: "runs", label: "Runs", to: "/runs" },
  { key: "archive", label: "Archive", to: "/archive" },
  { key: "settings", label: "Settings", to: "/settings" },
];

/** A tab's address without its query — what the router matches, and what the tree's row points at. */
export function projectTabPath(tab: ProjectNodeTab): string {
  return tab.to.split("?")[0] ?? tab.to;
}

/** True for a tab that brought its OWN address with it, i.e. everything but the two home tabs. */
export function isRehomedProjectTab(tab: ProjectNodeTab): boolean {
  return projectTabPath(tab) !== PROJECT_NODE_PATH;
}

/**
 * Which project tab an address selects, or `undefined` when the address is not on the project node
 * at all. ONE resolver, read by the node (to pick its body), the frame (for its crumbs and heading)
 * and the tree (for a row's label and depth) — so the three can never disagree about which tab a URL
 * means, which is the drift a second copy of this rule would introduce.
 */
export function projectNodeTabAt(pathname: string, search: string): ProjectNodeTab | undefined {
  if (pathname === PROJECT_NODE_PATH) {
    const want = new URLSearchParams(search).get("tab");
    // An unrecognised `?tab=` falls back to the home tab rather than to no tab: the node's own path
    // always shows SOMETHING, and Overview is what it shows.
    return PROJECT_NODE_TABS.find((t) => !isRehomedProjectTab(t) && t.key === want) ?? PROJECT_NODE_TABS[0];
  }
  return PROJECT_NODE_TABS.find((t) => isRehomedProjectTab(t) && projectTabPath(t) === pathname);
}

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
