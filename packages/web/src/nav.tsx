import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import ReviewPanel from "./pages/ReviewPanel";
import QuestionAnswer from "./pages/QuestionAnswer";
import SessionView from "./pages/SessionView";
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
import { mergeRedirectQuery } from "./lib/redirectQuery";
import WorkspaceHome from "./pages/WorkspaceHome";
import WorkspaceTerminals from "./pages/WorkspaceTerminals";
import ProjectHome from "./pages/ProjectHome";
import AgentsNode from "./pages/AgentsNode";

export type NavPage = {
  /** Full name — the tree row, the node heading and the Command Palette row. */
  label: string;
  to: string;
  /** Exact-match active state. */
  end?: boolean;
  element: ReactNode;
  /** Rescopes on the active project ⇒ the destination sits at PROJECT depth in the Atlas tree. */
  scoped?: boolean;
};

// Single source of truth for the app's destinations that keep an address of their own. The Atlas shell's
// route table, its crumbs and node heading (components/AtlasShell.tsx), the tree's workspace tier
// (components/AtlasTree.tsx) and the Command Palette page list all derive from this array, so they can
// never drift out of sync. The parameterized routes are not destinations (nothing can link to
// /session/:id without an id), so they live in PARAM_PAGES below instead.
//
// Card acbb6df6 made Atlas the ONLY shell, so Mission Control (`/`), Projects (`/projects`) and the
// classic project Overview (`/overview`) are gone from here: their surfaces live on the Workspace node, the
// project node and the Agents node, and their old addresses are plain LEGACY_REDIRECTS rows below.
//
// `scoped` was VERIFIED per page (does switching the active project actually rescope it?): Board, Memory
// (its project_memory read is enabled:!!projectId), Runs, Archive (its archived-sessions query is keyed on
// + enabled:!!projectId), Repository (both its Files/Git panes rescope), Settings (edits the active
// project's config override). Automation is god-eye (both its tables span every project) so NOT `scoped`,
// even though its Time builder's own agent picker is active-project-scoped — a builder-internal scope.
export const NAV_PAGES: NavPage[] = [
  // The single "Platform" section — ONE node, ONE /platform route. The page itself picks which surface to
  // render by EDITION (the reserved "Loom Platform" home existing): dev gets the Loom Platform home
  // (Lead/Auditor + findings board) plus a client-only "View as" toggle previewing the end-user surface;
  // shipping gets the end-user "Platform" operator + Workspace Auditor only. Deliberately `scoped` OFF.
  { label: "Platform", to: "/platform", element: <Platform /> },
  { label: "Terminals", to: "/terminals", element: <Terminals /> },
  { label: "Board", to: "/board", element: <Board />, scoped: true },
  // Memory — the read-only, per-project window into project_memory (the durable knowledge the fleet writes
  // + recalls via the `memory` MCP). `scoped: true`: its one read, api.projectMemory, is
  // `enabled: !!projectId`.
  { label: "Memory", to: "/memory", element: <Memory />, scoped: true },
  // The GLOBAL manager→human Inbox (card 695ebab0, generalizing the decision inbox 8701bdbb; renamed from
  // "Requests" by card 59fa6403) — a cross-project "waiting on me" + FYI queue of typed Requests (decision ·
  // input · permission · credential · notice), deliberately NOT project-scoped. The label is "Inbox"; the
  // route (`/inbox`) and the component/module names (RequestsPage, components/requests.tsx) deliberately
  // did NOT change — see docs/decisions/59fa6403-requests-to-inbox.md §(f) for why.
  { label: "Inbox", to: "/inbox", element: <RequestsPage /> },
  // Gates — the god-eye view of Loom's daemon-executed gates (merge, worker run_gate, deploy) across every
  // project, with its OWN per-project filter (default ALL), so deliberately NOT `scoped`.
  { label: "Gates", to: "/gates", element: <Gates /> },
  // Repository — the consolidated Vault + Git surface (IA merge #3): a Files | Git segmented switch above
  // the two panes (see pages/Repository.tsx). Both panes rescope on the active project, so it IS `scoped`.
  { label: "Repository", to: "/repository", element: <Repository />, scoped: true },
  { label: "Runs", to: "/runs", element: <Runs />, scoped: true },
  { label: "Archive", to: "/archive", element: <Archive />, scoped: true },
  // Actors — the consolidated Profiles + Skills surface (IA merge #1), both daemon-global + human-only.
  { label: "Actors", to: "/actors", element: <Actors /> },
  // Companion management is daemon-GLOBAL (one companion config store, not project-scoped).
  { label: "Companion", to: "/companion", element: <Companion /> },
  // Automation — the consolidated Schedules + Event Triggers surface (IA merge #2). Both tables span every
  // project, so deliberately NOT `scoped` (each builder scopes its OWN picker).
  { label: "Automation", to: "/automation", element: <Automation /> },
  { label: "Usage", to: "/usage", element: <Usage /> },
  { label: "Settings", to: "/settings", element: <Settings />, scoped: true },
];

// ── The parameterized routes ───────────────────────────────────────────────────────────────────
// Where a parameterized address lives in the Atlas tree. Only the frame reads this; the page
// component underneath neither knows nor cares, which is phase 1's one hard rule
// (docs/plans/archive/atlas-ui/02-architecture.md).
//
// Two shapes, because the three routes genuinely are two shapes. A SESSION address names an entity
// the tree holds a node for in its own right — the node hangs off that session's OWN project, which
// is not necessarily the active one — optionally with a node tab below it. A DETAIL address names a
// row WITHIN an existing nav destination, so the node stays that destination and the row is the last
// crumb. Homes assigned by `docs/plans/archive/atlas-ui/01-parity-checklist.md` §A, not re-decided here.
export type AtlasAddress =
  /** `param` names a SESSION: the node IS that session, under its own project node, `tab` below it. */
  | { kind: "session"; param: string; tab?: string }
  /** `param` names a detail row inside the NAV_PAGES destination whose `to` is `under`. */
  | { kind: "detail"; under: string; param: string };

export type ParamPage = {
  /** The route pattern. */
  to: string;
  element: ReactNode;
  atlas: AtlasAddress;
};

// Declared HERE rather than inline in the shell because the frame reads the `atlas` address too
// (components/AtlasShell.tsx's crumbs and heading), so a route and its tree position stay one row.
export const PARAM_PAGES: ParamPage[] = [
  { to: "/review/:workerId", element: <ReviewPanel />, atlas: { kind: "session", param: "workerId", tab: "Diff" } },
  { to: "/question/:id", element: <QuestionAnswer />, atlas: { kind: "detail", under: "/inbox", param: "id" } },
  { to: "/session/:id", element: <SessionView />, atlas: { kind: "session", param: "id" } },
];

// ── The Atlas-only nodes ───────────────────────────────────────────────────────────────────────
// The Workspace root and the project node — card fd99b2d7 (Atlas P2-1) — joined by the Agents node
// (card c6160c7d, P2-2). Addresses that never had a destination of their own before Atlas, which is
// why they are a list apart from NAV_PAGES: a NAV_PAGES row is a destination the tree derives a row or
// a tab for, and these are the nodes themselves.
//
// @decision fd99b2d7 — `/` and `/overview` now REDIRECT to these nodes (card acbb6df6, the owner's
// 2026-11-11 "remove the old UI" directive); never bring a page back at either address.
//
// A node's own tabs are `?tab=` on the SAME path, owned by the page component — not routes, so the
// frame's crumbs and heading stay a function of the node, not of which tab is showing.
export type AtlasHome = {
  /** Stable identity for the tree row's test id and the shell's own address lookup. */
  key: "workspace" | "project" | "agents" | "workspace-settings" | "workspace-terminals";
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
  { key: "workspace-settings", to: "/workspace-settings", label: "Settings", scoped: false, tierHead: false, element: <WorkspaceSettings /> },
  // The Workspace tier's own Terminals node (card b439c2dc, owner intake). `/terminals` cannot serve
  // here: card 25c08fba took that address down to PROJECT depth as the project node's Sessions tab,
  // so a workspace-tier row pointing at it would land on the project node — and a second <Route> on
  // one literal path is the precedence contest AtlasShell's REHOMED_TAB_PATHS note forbids.
  { key: "workspace-terminals", to: "/workspace-terminals", label: "Terminals", scoped: false, tierHead: false, element: <WorkspaceTerminals /> },
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
// @decision 41eab0eb — `from` must stay a NAV_PAGES/ATLAS_HOMES address: the tab's label and body are
// resolved from that row, and the shell redirects the old address into the tab from it.
export type WorkspaceNodeTab = {
  /** The `?tab=` value on `/home`. */
  key: string;
  /** The surface's own pre-Atlas address, which the shell redirects into the tab. */
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

/** A Workspace node tab's own address. Never the node's bare path: that is Overview's. Shared by the
 *  shell's redirect into a tab and the tree's Inbox / Gates rows (card 291cc8aa), so a row and the tab it
 *  opens can never name two different addresses. */
export const workspaceTabHref = (key: string) => `/home?tab=${key}`;

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
// leaving each one a full page of its own — `atlas.js`'s `PROJ_TABS`, prepended by `homeTabs("proj")`.
// That prefix was Overview + Deck; card 44f725fe unified the two into ONE home tab, and card 30266229
// added the owner's per-project Usage tab after them — so the rows below are TEN, in that order. Read
// the count off this array, never off this sentence.
//
// 🔴 A TAB'S ADDRESS IS THE PATH IT ALREADY HAD. Only the HOME tab is `?tab=` on the node's own path
// (and in practice it is the bare path, since it is the default) — every other tab keeps `/board`,
// `/memory`, `/repository` and friends. Two reasons, each load-bearing:
//
//   • A `?tab=` on `/project` would COLLIDE with the page's own `?tab=`. Repository reads `?tab=git`
//     off the query string itself (pages/Repository.tsx), as Actors and Automation do; one query
//     parameter cannot address both the node's tab and the tab body's own sub-tab.
//   • Nothing has to be re-pointed. Every `<Link to="/runs">`, every band panel's `action`, every
//     command-palette row and every bookmark already names these paths, so the re-home costs no link
//     churn and no redirect hop — which is also why this card adds no `LEGACY_REDIRECTS` row at all:
//     a redirect needs an address to leave behind, and these addresses did not move.
//
// @decision 25c08fba — never re-address a project tab as `?tab=` on /project. It collides with the
// tab body's own `?tab=`, and it would put a redirect hop in front of every existing link.
export type ProjectNodeTab = {
  /** The `?tab=` value for a HOME tab, and the `atlas-tab-<key>` testid stem for every tab. */
  key: string;
  /** What the project node calls this surface — the tab's label, and the frame's deepest crumb. */
  label: string;
  /** The tab's own address. A home tab's is the project node's own path. */
  to: string;
};

/** The project node's own path — the HOME tab's own address. */
export const PROJECT_NODE_PATH = "/project";

export const PROJECT_NODE_TABS: ProjectNodeTab[] = [
  { key: "overview", label: "Overview", to: PROJECT_NODE_PATH },
  // ⛔ There is no second HOME tab here, and `deck` must not come back as one (card 44f725fe). The
  // owner read the two as redundant and he was right at the level of the code — see ProjectHome.tsx's
  // own header. A legacy `?tab=deck` needs no row and no LEGACY_REDIRECTS entry either: it is an
  // unrecognised home tab, which `projectNodeTabAt` below already resolves to Overview.
  { key: "board", label: "Board", to: "/board" },
  // "Sessions", not "Terminals": the only tab here that genuinely CHANGES TIER. /terminals was a
  // god-eye page before Atlas, and the approved design has it as a PROJECT tab ("Sessions 5"), so it
  // sits at project depth and takes the node's own name for it. NAV_PAGES above still declares it
  // unscoped because the page itself is: it rescopes only through the project filter the tab pre-selects.
  { key: "sessions", label: "Sessions", to: "/terminals" },
  { key: "agents", label: "Agents", to: "/agents" },
  { key: "repository", label: "Repository", to: "/repository" },
  { key: "memory", label: "Memory", to: "/memory" },
  { key: "runs", label: "Runs", to: "/runs" },
  { key: "archive", label: "Archive", to: "/archive" },
  // Usage — the owner's own feedback item (card 30266229): per-project consumption broken down BY TASK.
  // The one project tab that is NOT re-homed from an existing address and is NOT the home tab: it is a
  // SECOND `?tab=` on the node's own path, Atlas-only by construction, because `/usage` is already the
  // WORKSPACE node's own cross-project tab (WORKSPACE_NODE_TABS above) and a project-depth slice of a
  // god-eye page is a different surface, not a re-home of it. That makes `?tab=` correct here rather
  // than a violation of the anchor below: this body owns no `?tab=` of its own to collide with, and
  // there is no pre-Atlas address to leave behind — so no LEGACY_REDIRECTS row and no NAV_PAGES entry.
  { key: "usage", label: "Usage", to: `${PROJECT_NODE_PATH}?tab=usage` },
  { key: "settings", label: "Settings", to: "/settings" },
];

/** A tab's address without its query — what the router matches, and what the tree's row points at. */
export function projectTabPath(tab: ProjectNodeTab): string {
  return tab.to.split("?")[0] ?? tab.to;
}

/** True for a tab that brought its OWN address with it, i.e. everything but the HOME tab. */
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
// Old URLs kept working after an IA merge, a rename or a retirement. Each one's `to` is the destination's
// CURRENT address, including the `?tab=` that picks its sub-tab, so a bookmark or a link in an old message
// still lands somewhere real instead of the shell's "nothing here" node. Every row goes straight to its
// final address — never through another row — so no deep link pays two hops.
export type LegacyRedirect = {
  /** The old path. */
  from: string;
  /** Where it lands — a NAV_PAGES / ATLAS_HOMES `to`, plus the `?tab=` that selects its sub-tab. */
  to: string;
  element: ReactNode;
};

/**
 * A redirect that carries the INCOMING query through to `to`, so a deep link issued at a renamed
 * address still arrives with its params.
 *
 * @decision 260fb29a — on a key collision the ROW'S OWN target wins, replaced whole: never let an
 * incoming query re-point a redirect at a sub-tab the old address never named. A component, never a
 * precomputed element — the incoming search is only knowable at render time.
 */
export function QueryPreservingRedirect({ to }: { to: string }) {
  const { search } = useLocation();
  return <Navigate to={mergeRedirectQuery(to, search)} replace />;
}

// The redirect element is built HERE, once per row, rather than in the shell's route table: `replace`
// (keep the dead URL out of the history stack, so Back leaves the page rather than bouncing through
// the redirect) is part of the redirect's behaviour, so it belongs with the row.
function redirect(from: string, to: string): LegacyRedirect {
  return { from, to, element: <QueryPreservingRedirect to={to} /> };
}

export const LEGACY_REDIRECTS: LegacyRedirect[] = [
  // The three pre-Atlas destinations card acbb6df6 deleted with the classic shell (the owner's 2026-11-11
  // "remove the old UI" directive). Each lands on the node that absorbed it — the SHALLOWEST node holding
  // the pane a reader came for, the same "scope is depth" rule the tree follows.
  //
  // @decision 5afd71bd — `/` and `/projects` are ordinary redirects now; never bring a page back at
  // either. Mission Control's surfaces are all on the Workspace node (status strip and fleet controls,
  // KPI deck, Needs-you band, plan usage, the Pulse band, the Replay tab).
  redirect("/", "/home"),
  // Projects' panes: the project list is the tree's project tier plus the Workspace node's Projects grid;
  // lifecycle is the project Settings tab (c9b78d80), the archived tier the Workspace Settings tab
  // (baca1835), agent definition the Agents node (318b5a21), creation the Platform node's guided setup.
  redirect("/projects", "/home"),
  // /workspace was renamed to /projects (card 274f9ba9), which is itself retired above — so it goes
  // straight to the final address rather than chaining through that row.
  redirect("/workspace", "/home"),
  // The classic project Overview → the project node, which carries every one of its panes (card
  // 102bc915's parity record): the board as the Board tab, terminals as Sessions, agents as Agents.
  // @decision 4a0ad464 — this is the retirement that record deferred to the owner; acbb6df6 made it.
  redirect("/overview", "/project"),
  // /setup was the old end-user Platform route — now consolidated into /platform. Catches lingering
  // links/bookmarks and the first-run welcome's historical target.
  redirect("/setup", "/platform"),
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

// What the tree's workspace tier and the Command Palette LIST (both call this). Kept as a hook (rather
// than exporting NAV_PAGES to consumers directly) so its return stays a stable seam those two + tests
// reference.
export function useVisibleNavPages(): NavPage[] {
  return NAV_PAGES;
}
