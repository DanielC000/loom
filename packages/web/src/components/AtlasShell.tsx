import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { matchPath, Navigate, Route, Routes, useLocation, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { SessionListItem } from "@loom/shared";
import { Badge, Button, Panel, SectionLabel } from "./ui";
import { ATLAS_TREE_ID, AtlasTree } from "./AtlasTree";
import { OrchestrationChip, useOrchestrationPaused } from "./fleetControls";
import {
  ATLAS_HOMES, LEGACY_REDIRECTS, NAV_PAGES, PARAM_PAGES, PROJECT_NODE_PATH, PROJECT_NODE_TABS,
  QueryPreservingRedirect, atlasRetirementFor, isRehomedProjectTab, projectNodeTabAt, projectTabPath,
  workspaceNodeTabFor,
  type AtlasHome, type NavPage, type ParamPage,
} from "../nav";
import { AtlasNodeHeadContext } from "../lib/atlasNodeHead";
import { activeSessionNodeTab, SESSION_NODE_TAB_LABEL } from "../lib/sessionNodeTabs";
import { useLatchedSession } from "../lib/useLatchedSession";
import { setAtlasUi } from "../lib/atlasUi";
import { useActiveProject } from "../lib/activeProject";
import { api } from "../lib/api";
import { color, font } from "../theme";

// The Atlas shell — cards 757c80dd (P1-0, the frame) and 8cbb2ac2 (P1-1, the nodes). What Atlas is,
// and which card builds what: docs/plans/atlas-ui/02-architecture.md + 03-decomposition.md.
//
// Phase 1 MOUNTS, it does not redesign: the tree (components/AtlasTree.tsx) holds a node per nav
// destination, and every route below renders that destination's EXISTING component verbatim — the
// nav destinations, the three parameterized addresses, and the legacy-URL redirects, each from the
// one declaration in src/nav.tsx that the classic shell maps too. Only the frame's crumbs and
// heading learn where an address sits in the tree.
//
// Routes, crumbs and the node heading are all DERIVED from those declarations. Never hand-list them:
// a path copied into this file drifts invisibly the moment someone edits nav.tsx.
//
// Chrome is PASSED IN, never imported: App.tsx mounts the overlays and banners for BOTH shells and
// stays their single owner. Both slots sit OUTSIDE the route table, as in the legacy shell.


// Longest path first, so a specific destination always beats a shorter prefix (and "/" — which must
// match exactly, hence `end` straight off the page — never swallows everything). `end` is the same
// flag the Instrument Rail's NavLinks and the tree's own nodes consume, so all three agree on which
// destination a URL belongs to by construction.
//
// A RETIRED destination (card 5afd71bd) is excluded, so the frame never NAMES one. Its route below
// redirects, but a redirect is a navigation the router performs on the first render AFTER this match
// — so leaving it in would put "Mission Control" in the node head and the crumb trail for that one
// frame, naming a node the tree no longer holds. The tree drops the row and the frame drops the name
// together, from the same declaration.
const BY_SPECIFICITY: NavPage[] = [...NAV_PAGES]
  .filter((p) => !atlasRetirementFor(p.to))
  .sort((a, b) => b.to.length - a.to.length);

function currentPage(pathname: string): NavPage | undefined {
  return BY_SPECIFICITY.find((p) => matchPath({ path: p.to, end: p.end ?? false }, pathname));
}

// An Atlas-only home node (card fd99b2d7). Its `to` is a literal path disjoint from every NAV_PAGES
// `to`, so this is a plain lookup, not a precedence contest with `currentPage` above.
function currentHome(pathname: string): AtlasHome | undefined {
  return ATLAS_HOMES.find((h) => matchPath({ path: h.to, end: true }, pathname));
}

// ── The project node's re-homed tabs (card 25c08fba) ───────────────────────────────────────────
// The eight project-scoped surfaces that are now TABS on the project node rather than pages of their
// own. Each keeps the address it already had (see PROJECT_NODE_TABS in src/nav.tsx for why), so the
// only thing that changes here is WHICH element the address renders: the project node, with that tab
// selected, instead of the bare page.
//
// The paths are therefore REMOVED from the NAV_PAGES / ATLAS_HOMES mounts below and re-added pointing
// at the node — never mounted twice. Two <Route>s on one literal path is a precedence contest with no
// stated winner, and the one that lost would be invisible.
const REHOMED_TAB_PATHS = new Set(
  PROJECT_NODE_TABS.filter(isRehomedProjectTab).map(projectTabPath),
);

// The project node's own element, resolved from the SAME declaration that mounts `/project` — so a
// re-homed address and the node's own path can never render two different components.
const PROJECT_NODE_ELEMENT = ATLAS_HOMES.find((h) => h.to === PROJECT_NODE_PATH)?.element;

// No specificity sort for these: each pattern's FIRST segment is a distinct literal, so at most one
// can ever match a given path and the iteration order cannot change the answer.
function currentParamPage(pathname: string): { page: ParamPage; id: string } | undefined {
  for (const page of PARAM_PAGES) {
    const match = matchPath({ path: page.to, end: true }, pathname);
    if (match) return { page, id: match.params[page.atlas.param] ?? "" };
  }
  return undefined;
}

/** Where the frame says you are: the trail THROUGH the tree, and the node it ends at. */
type NodeAddress = { crumbs: string[]; heading: string };

/** The crumb trail's own id, so its narrow-width disclosure can `aria-controls` it. */
const ATLAS_CRUMB_LIST_ID = "loom-atlas-crumblist";

/**
 * A re-homed cross-project address, redirected into its Workspace node tab — card 41eab0eb.
 *
 * ATLAS-ONLY, deliberately: the `from` path stays a live NAV_PAGES/ATLAS_HOMES route that the CLASSIC
 * shell mounts verbatim, so a user who never opted in is untouched. That is why this is not a
 * LEGACY_REDIRECTS row — those carry ONE target for both shells by design (src/nav.tsx), and this is
 * the one case where the two shells must genuinely differ.
 *
 * An incoming `?tab=` is TRANSLATED to the host's sub-key rather than dropped: `/actors?tab=skills` is
 * a real address today — it is `/skills`'s own legacy target — and chaining it into the tab without
 * this would silently land on Profiles. Every other incoming param is carried as-is; anything the
 * guest does not read is inert.
 */
function RehomedToNodeTab({ to, subKey }: { to: string; subKey: string }) {
  const [params] = useSearchParams();
  const next = new URLSearchParams(params);
  const sub = next.get("tab");
  next.delete("tab");
  if (sub) next.set(subKey, sub);
  const query = next.toString();
  return <Navigate to={query ? `${to}&${query}` : to} replace />;
}

/** The host's sub-key, mirroring pages/WorkspaceHome.tsx's own `SUB_KEY`. */
const WORKSPACE_SUB_KEY = "sub";

/** A re-homed destination's address on the Workspace node. Never the node's bare path: every tab this
 *  redirects into is one of the seven, and the bare path is Overview's. */
const workspaceTabHref = (key: string) => `/home?tab=${key}`;

// A session's node label, in the app's OWN identity grammar — TileTitle (components/TerminalCard.tsx)
// renders `[project · ]agent[ · role] · <short id>` on every terminal header. The project half is
// dropped here because it is already the crumb directly above; the short id stays, because it is the
// part that actually tells two sessions of the same agent apart.
function sessionNodeLabel(s: Pick<SessionListItem, "agentName" | "role" | "id">): string {
  return `${s.agentName}${s.role ? ` · ${s.role}` : ""} · ${s.id.slice(0, 8)}`;
}

// The crumbs + heading for a PARAMETERIZED address (P1-2). Both reads here reuse the EXACT query key
// and fetcher the page below already uses — ["allSessions"] in SessionView/ReviewPanel, ["question",
// id] in RequestDetail — so the crumb shares that cache entry instead of issuing a second request,
// and can never name a different entity than the page is showing. `enabled` keeps each read off
// every OTHER Atlas route: subscribing shell-wide would add a poll the classic shell never makes, on
// pages that read neither.
//
// Unresolved degrades honestly rather than guessing. An id that resolves to nothing has no project
// to hang under, so the project crumb is OMITTED instead of borrowing the ACTIVE project's name —
// which would assert a tree position the data never established. The page under it renders its own
// not-found state exactly as it does under the classic shell.
function useParamAddress(
  current: { page: ParamPage; id: string } | undefined,
  activeProjectName: string,
  search: string,
): NodeAddress | undefined {
  const atlas = current?.page.atlas;
  const id = current?.id ?? "";

  // LATCHED (card 525c8ad9 review round 2), not a bare lookup: a merge archives its worker out of
  // `["allSessions"]` the moment it succeeds, and an un-latched read would drop the heading of the node
  // the reader is still looking at back to "Session a666fb31" mid-review. Same shared cache entry, so
  // it still costs no request; `enabled` keeps it off every non-session route exactly as before.
  const session = useLatchedSession(atlas?.kind === "session" && id ? id : "");
  const question = useQuery({
    queryKey: ["question", id], queryFn: () => api.question(id),
    enabled: atlas?.kind === "detail" && !!id, retry: false,
  });

  if (!atlas) return undefined;

  if (atlas.kind === "session") {
    const heading = session ? sessionNodeLabel(session) : `Session ${id.slice(0, 8)}`;
    // The tab crumb is appended ONLY when a tab row is actually going to render under it (card
    // 525c8ad9 review round 2). Two ways that is true, and one way it is not:
    //   • the declaration PINS a tab — /review/:workerId IS the worker node's Diff tab, and that
    //     address renders the node whatever state the session is in (see pages/ReviewPanel.tsx);
    //   • /session/:id with a LIVE-or-STARTING row, which is the gate SessionView applies before it
    //     renders the node at all;
    //   • an exited, archived or unresolved session on /session/:id renders SessionView's ended /
    //     not-found panel — no tabs — so naming one would be the trail claiming a control that is not
    //     on the page.
    const liveish = session?.processState === "live" || session?.processState === "starting";
    const tab = atlas.tab
      ?? (liveish
        ? SESSION_NODE_TAB_LABEL[activeSessionNodeTab(session?.role, new URLSearchParams(search).get("tab"))]
        : undefined);
    return {
      crumbs: ["Workspace", ...(session ? [session.projectName] : []), heading, ...(tab ? [tab] : [])],
      heading,
    };
  }

  // A detail row: the NODE stays the nav destination it belongs to, and the row is the last crumb.
  // Its depth comes from that destination's own `scoped` flag — the SAME rule a plain node crumb
  // follows below — so a detail address can never sit at a different depth than its own node.
  const node = NAV_PAGES.find((p) => p.to === atlas.under);
  const heading = node?.label ?? atlas.under;
  return {
    crumbs: [
      "Workspace",
      ...(node?.scoped ? [activeProjectName] : []),
      heading,
      question.data?.title ?? `Request ${id.slice(0, 8)}`,
    ],
    heading,
  };
}

export function AtlasShell({ overlays, banners }: { overlays?: ReactNode; banners?: ReactNode }) {
  const { pathname, search } = useLocation();
  const { projectId, projects } = useActiveProject();
  const page = currentPage(pathname);
  const project = projects.find((p) => p.id === projectId);
  const activeProjectName = project?.name ?? "No project";
  const home = currentHome(pathname);
  const paramPage = currentParamPage(pathname);
  const paramAddress = useParamAddress(paramPage, activeProjectName, search);
  // The node head's own slot — see lib/atlasNodeHead.ts. Held as state (not a ref) because the node
  // portaling into it has to RE-RENDER once the element exists; a ref would leave it pointing at null
  // for the lifetime of the page.
  const [nodeHeadSlot, setNodeHeadSlot] = useState<HTMLElement | null>(null);

  // ── The tree as a drawer below the narrow breakpoint (card 49e883a9) ───────────────────────────
  // State only. WHICH widths this state is allowed to mean anything at is entirely CSS's call (see
  // `.loom-atlas-tree.is-open` in styles/global.css): no JS media query, no resize listener, so a
  // reader who opens the drawer and then rotates to landscape gets the persistent rail back with
  // nothing to reconcile, and the wide shell is byte-identical to before this card whatever this
  // boolean holds.
  //
  // @decision 49e883a9 — the drawer OVERLAYS: never express it by unmounting the tree, the content
  // column or a page panel, and never read its state with `toHaveCount(0)` or a one-shot
  // getComputedStyle right after `aria-expanded` flips.
  //
  // Unmounting the content would discard a half-typed composer or card draft (the owner's standing
  // rule), and unmounting the TREE would throw away its own expansion state, so a reader who opened
  // three branches would find them shut on the next open.
  const [treeDrawerOpen, setTreeDrawerOpen] = useState(false);
  const drawerToggleRef = useRef<HTMLButtonElement | null>(null);
  // Every close path — the toggle, Escape, the scrim, a tree row — returns focus to the toggle,
  // because every one of them removes the element the focus was on (or could be on) from view.
  const closeTreeDrawer = useCallback(() => {
    setTreeDrawerOpen(false);
    drawerToggleRef.current?.focus();
  }, []);
  useEffect(() => {
    if (!treeDrawerOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeTreeDrawer(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [treeDrawerOpen, closeTreeDrawer]);
  // A detail address hangs off a REAL tree node, so that node reads as the landed one even though
  // its own path never matches.
  //
  // A SESSION address now has a real node too (card 3b563642 hung live sessions in the tree), and it
  // is the same node for both of its addresses: `/review/:workerId` IS that worker node's Diff tab,
  // so the row it marks is the worker's own `/session/<id>` row. On `/session/:id` the row's NavLink
  // already matches by path and this is simply redundant; on `/review/:workerId` it is the only
  // thing that stops the tree being the one part of the frame disagreeing about where you are.
  // A session with no row — one that has exited, which `/review/:workerId` deliberately still
  // renders — marks nothing, which stays the honest answer.
  const paramAtlas = paramPage?.page.atlas;
  const activeNodeTo = paramAtlas?.kind === "detail"
    ? paramAtlas.under
    : paramAtlas?.kind === "session" && paramPage?.id
      ? `/session/${paramPage.id}`
      : undefined;
  // The peripheral half of the fleet-controls chip (card 7b893d54): a paused fleet changes what every
  // other node's emptiness MEANS, so the frame itself carries a marker rather than leaving the state to
  // a chip the reader has to look at. Same shared `["orchStatus"]` entry the chip reads — one
  // derivation (useOrchestrationPaused), so the bar and the chip cannot disagree on one screen.
  const orchestrationPaused = useOrchestrationPaused();

  // The trail mirrors the tree's own depth rule (AtlasTree's splitByDepth): a god-eye destination
  // hangs off the workspace root, a `scoped` one hangs off the project it is scoped to. So the crumbs
  // read as the path actually taken through the tree, not as a second, independently-maintained idea
  // of the hierarchy.
  //
  // A TIER-HEAD node is the tier itself, so its trail STOPS there: the Workspace home's deepest
  // crumb is "Workspace", the project home's is the project's own name. Appending the row's "Home"
  // label would add a fourth word naming a node that is already the crumb before it. An Atlas-only
  // node that is NOT its tier's head (the Agents node, card c6160c7d) names itself last, exactly as
  // a NAV_PAGES destination at the same depth does.
  // @decision 25c08fba — a re-homed project tab's depth and label come from the tab declaration,
  // never from the page's own `scoped` flag.
  //
  // It takes them from that declaration
  // rather than from the page's own `scoped` flag — ONE resolver, shared with the node and the tree,
  // so the three cannot disagree about which tab an address means or how deep it sits.
  //
  // For seven of the eight this reproduces exactly what the `scoped` flag already said. The eighth is
  // `/terminals`, which genuinely CHANGED TIER: the classic rail still carries it as the god-eye
  // "Terminals", and under Atlas it is the project node's "Sessions". Deriving it from the flag would
  // put the project node's own tab at workspace depth, naming the wrong tier and the wrong label.
  //
  // The two HOME tabs are excluded: the project node is its tier's head, so its trail stops at the
  // project's name and never appends "Overview" (the same rule ATLAS_HOMES' `tierHead` states).
  const projectTab = projectNodeTabAt(pathname, search);
  const rehomedTab = projectTab && isRehomedProjectTab(projectTab) ? projectTab : undefined;

  const navCrumbs: string[] = ["Workspace"];
  if (rehomedTab) {
    navCrumbs.push(activeProjectName, rehomedTab.label);
  } else if (home) {
    if (home.scoped) navCrumbs.push(activeProjectName);
    if (!home.tierHead) navCrumbs.push(home.label);
  } else {
    if (page?.scoped) navCrumbs.push(activeProjectName);
    if (page) navCrumbs.push(page.label);
  }

  // A parameterized address wins when one matched: the two matchers are disjoint (a NAV_PAGES `to`
  // is a literal path, and no literal path is also a PARAM_PAGES pattern), so this is a fallback
  // order, not a precedence contest.
  const crumbs = paramAddress?.crumbs ?? navCrumbs;
  const heading = paramAddress?.heading
    ?? rehomedTab?.label
    ?? (home
      ? (home.tierHead ? (home.scoped ? activeProjectName : "Workspace") : home.label)
      : page?.label)
    ?? "Workspace";

  // ── A four-segment trail at phone width (card 9477a5ed) ────────────────────────────────────────
  // Below the narrow breakpoint the LEADING ancestors collapse behind this disclosure and the trail
  // renders its deepest two segments; the control reveals the rest in place. Decision 1d3192dc's
  // lopsided shrink still governs whatever remains rendered — it decides how a DEFICIT is shared out,
  // and cannot help once the deficit exceeds the row, which is the state a four-segment trail reaches
  // at 420px (measured: the project crumb painted its separator and no characters at all). So the
  // fix reduces the segment COUNT and leaves that ratio untouched rather than changing it.
  //
  // Which widths this happens at is CSS's call alone (`.loom-atlas-crumblist.is-collapsible` in
  // styles/global.css) — no media query and no box measurement here, exactly like the drawer above.
  // The frame's other overflow control, the node tab row's More menu, has to measure because a tab's
  // width is not knowable without rendering it; a trail's segment count is known at render time, so
  // paying that cost here would buy nothing and inherit the remeasure hazard (card 485d67b4, where a
  // re-measure tore the open menu's DOM down and stranded the reader's focus on <body>).
  //
  // @decision 9477a5ed — never derive this collapse by measuring rendered boxes, and never express it
  // as a width cap on a segment.
  const collapsibleTrail = crumbs.length > 3;
  const [trailOpen, setTrailOpen] = useState(false);
  // Re-collapses on every address change: "what is above me" is a question about THIS node, so an
  // expanded trail carried into the next one would be answering it where it was not asked again.
  const trailKey = crumbs.join("\u0000");
  useEffect(() => { setTrailOpen(false); }, [trailKey]);

  return (
    <div className="loom-atlas" data-testid="atlas-shell">
      {overlays}
      <AtlasTree activeTo={activeNodeTo} open={treeDrawerOpen} onNavigate={closeTreeDrawer} />
      {/* The scrim is the drawer's own dismiss surface, and it is deliberately NOT a modal backdrop:
          it sits at z-index 44, under the 50-and-up every dialog in the app already uses, so a board
          card opened from the tree still arrives as the centred dialog on top of it rather than being
          trapped behind navigation chrome. `display: none` outside the breakpoint, so a drawer left
          open while the viewport grows cannot leave a dead sheet over the wide shell. */}
      {treeDrawerOpen && (
        <div className="loom-atlas-scrim" data-testid="atlas-tree-scrim" aria-hidden
          onClick={closeTreeDrawer} />
      )}

      <div className="loom-atlas-main">
        <header className={`loom-atlas-topbar${orchestrationPaused ? " is-paused" : ""}`}>
          <div className="loom-atlas-crumbs">
            {/* Hidden above the breakpoint, so the wide shell gains no control. It carries an icon and
                no text node ON PURPOSE: every Atlas nav label is already a live page-wide exact-text
                match in both shells, and a worded button here would be one more string for an
                unrelated spec's text locator to collide with. The name is the aria-label. */}
            <button type="button" ref={drawerToggleRef}
              className={`loom-atlas-drawerbtn${treeDrawerOpen ? " is-open" : ""}`}
              data-testid="atlas-tree-toggle"
              aria-expanded={treeDrawerOpen} aria-controls={ATLAS_TREE_ID}
              aria-label={treeDrawerOpen ? "Close the navigation tree" : "Open the navigation tree"}
              title={treeDrawerOpen ? "Close the navigation tree" : "Open the navigation tree"}
              onClick={() => (treeDrawerOpen ? closeTreeDrawer() : setTreeDrawerOpen(true))}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor"
                strokeWidth="1.5" strokeLinecap="round" aria-hidden focusable="false">
                {treeDrawerOpen
                  ? <path d="M4 4l8 8M12 4l-8 8" />
                  : <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />}
              </svg>
            </button>
            <nav aria-label="Breadcrumb" data-testid="atlas-breadcrumb" className="loom-atlas-crumbnav">
              {/* The disclosure sits OUTSIDE the <ol> deliberately: five specs read the trail as
                  `[...nav.querySelectorAll("li")]`, so an <li> holding a control rather than a segment
                  would enter every one of those trails as an empty string — at EVERY width, including
                  the wide one this card does not touch. Its accessible name is generic and stable
                  (the path itself is the `title`, and activating it renders the real segments): a name
                  carrying the project or session name would be one more live page-wide text match for
                  an unrelated spec's by-name locator to collide with, the trap card c6160c7d hit. */}
              {collapsibleTrail && (
                <button type="button" className="loom-atlas-crumbmore" data-testid="atlas-crumb-more"
                  aria-expanded={trailOpen} aria-controls={ATLAS_CRUMB_LIST_ID}
                  aria-label={trailOpen ? "Hide the full path" : "Show the full path"}
                  title={trailOpen ? "Hide the full path" : `Show the full path: ${crumbs.join(" / ")}`}
                  onClick={() => setTrailOpen((open) => !open)}>
                  <span aria-hidden>…</span>
                </button>
              )}
              <ol id={ATLAS_CRUMB_LIST_ID}
                className={`loom-atlas-crumblist${collapsibleTrail ? " is-collapsible" : ""}`
                  + `${trailOpen ? " is-open" : ""}`}
                style={{ display: "flex", alignItems: "center", listStyle: "none", margin: 0, padding: 0,
                  overflow: "hidden", fontFamily: font.mono, fontSize: 11.5, color: color.textMuted }}>
                {crumbs.map((crumb, i) => {
                  const last = i === crumbs.length - 1;
                  return (
                    // The DEEPEST crumb is the one that says where you are, so it gives up width LAST —
                    // the same priority TileTitle (components/TerminalCard.tsx) gives a session's short
                    // id. Without it every crumb shrinks equally and a four-segment trail at phone width
                    // clips the part that matters most ("Diff" rendered as "D." at 420px).
                    //
                    // @decision 1d3192dc — never express this as a width CAP on the deepest crumb (a
                    // `ch` count or a percentage). Both clip a long detail label on a row that had the
                    // room for it; the lopsided shrink ratio is what makes the ancestors give way first.
                    // Only what VARIES per segment stays inline. `display`/`align-items`/`min-width`
                    // moved to `.loom-atlas-crumblist > li` because inline beats class: an inline
                    // `display: flex` silently shadowed the narrow-width collapse rule, which showed
                    // up as every segment still rendering at 420px with the disclosure beside them.
                    <li key={`${i}-${crumb}`} aria-current={last ? "page" : undefined}
                      style={{ flexShrink: last ? 1 : 999,
                        color: last ? color.text : color.textMuted }}>
                      {i > 0 && <span aria-hidden style={{ color: color.border }}>/</span>}
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{crumb}</span>
                    </li>
                  );
                })}
              </ol>
            </nav>
            <span style={{ flex: 1 }} />
            {/* The daemon-global fleet state, on EVERY node, and the controls behind it (card
                7b893d54). The Workspace root carries the same cluster as a full-width bar; this is the
                mount that makes a paused fleet discoverable without navigating to the root. */}
            <OrchestrationChip />
            {/* The way back. Settings is a tree node now, so this is no longer the ONLY exit — but it
                stays: it is one click from anywhere, and a preview whose exit is buried in a settings
                page is a preview people stop trying. */}
            {/* THREE renderings, ONE accessible name. At 420px the full wording was eating the crumb
                row. Card 49e883a9 took the first cut at that, shortening the wording to "Classic"
                and freeing ~110px. That was not enough for a four-segment trail (measured:
                the nav reached 184px of a 420px row, and 83px of what remained was still this
                button), so below the breakpoint it now drops its word entirely and renders as an
                icon the same size as the drawer toggle opposite it — ~49px more for the trail, and
                the one control in this row whose meaning a reader can recover from its tooltip.
                The `aria-label` is stated so the name does NOT change with the breakpoint: a control
                whose accessible name depends on viewport width is a different control to a screen
                reader at every size, and every by-name locator would have to know which width it is
                at.

                Its padding is `.loom-atlas-leave`'s, NOT inline: inline beats class, so a `style`
                here would shadow the square icon-sized padding the narrow rule needs. */}
            <Button data-testid="atlas-leave" onClick={() => setAtlasUi(false)}
              aria-label="Switch to the classic UI"
              title="Turn the Atlas preview off and return to the classic UI"
              className="loom-atlas-leave">
              <span className="loom-atlas-leave-full">Switch to the classic UI</span>
              <span className="loom-atlas-leave-short" aria-hidden>Classic</span>
              <svg className="loom-atlas-leave-icon" width="16" height="16" viewBox="0 0 16 16"
                fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
                strokeLinejoin="round" aria-hidden focusable="false">
                <path d="M6.5 2.5H3.5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h3" />
                <path d="M10 5.5 13 8l-3 2.5M13 8H6" />
              </svg>
            </Button>
          </div>

          <div className="loom-atlas-nodehead">
            <h1 style={{ margin: 0, fontFamily: font.head, fontWeight: 600, fontSize: 17, letterSpacing: "0.02em",
              color: color.text, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {heading}
            </h1>
            <Badge tone="cyan">preview</Badge>
            {/* A node with live state and lifecycle controls fills this; every other node leaves it
                empty, and `:empty` hides it so it costs no gap. */}
            <div className="loom-atlas-nodehead-extras" data-testid="atlas-nodehead-extras" ref={setNodeHeadSlot} />
          </div>
        </header>

        {banners}

        <main className="loom-atlas-content">
          <AtlasNodeHeadContext.Provider value={nodeHeadSlot}>
          <Routes>
            {/* Each destination's own component, rendered exactly as the legacy shell renders it —
                minus the eight card 25c08fba re-homed onto the PROJECT node, which are mounted at the
                bottom of this table pointing at the node instead — and unless card 41eab0eb re-homed
                it as a WORKSPACE node tab, in which case this address redirects into that tab and the
                component is mounted there instead — or unless card 5afd71bd RETIRED it, in which case
                the address redirects to the node that absorbed it and the component is not mounted by
                this shell at all. (The three sets are disjoint: a destination is at one depth, and a
                retired one is at none.) The CLASSIC shell still mounts the page at this same path,
                unchanged — which is why the path is still a <Route> here rather than simply absent:
                dropping it would hand the address to the catch-all, and "Nothing here yet" is a worse
                answer than the node that actually holds what the reader came for. */}
            {NAV_PAGES.filter((p) => !REHOMED_TAB_PATHS.has(p.to)).map((p) => {
              const tab = workspaceNodeTabFor(p.to);
              const retired = atlasRetirementFor(p.to);
              return (
                <Route key={p.to} path={p.to}
                  element={retired
                    // Query-preserving (card 260fb29a) because one LEGACY_REDIRECTS row chains THROUGH
                    // a retirement: /workspace → /projects → /home. A plain <Navigate> here would drop
                    // the query this second hop inherited, so that row's deep link would survive the
                    // classic shell's single hop and die on Atlas's two — a per-shell divergence in the
                    // one place both shells are meant to agree.
                    ? <QueryPreservingRedirect to={retired.to} />
                    : tab
                      ? <RehomedToNodeTab to={workspaceTabHref(tab.key)} subKey={WORKSPACE_SUB_KEY} />
                      : p.element} />
              );
            })}
            {/* The parameterized addresses (P1-2), from the SAME declaration LegacyShell mounts —
                the identical element, so the page is byte-for-byte the one the old URL rendered. */}
            {PARAM_PAGES.map((p) => (
              <Route key={p.to} path={p.to} element={p.element} />
            ))}
            {/* The legacy-URL redirects (P1-3), from the SAME declaration LegacyShell mounts. They
                need nothing Atlas-specific: each lands on a NAV_PAGES address that is already a node
                above, so the crumbs, the heading and the tree's active node all derive themselves
                from the destination exactly as a direct visit to it would. */}
            {LEGACY_REDIRECTS.map((r) => (
              <Route key={r.from} path={r.from} element={r.element} />
            ))}
            {/* The Atlas-only nodes (P2-1's two home nodes, P2-2's Agents node). The classic shell
                deliberately does NOT mount these; see ATLAS_HOMES' own anchor in src/nav.tsx for
                why, and why `/` and `/overview` must not be re-pointed at them. */}
            {ATLAS_HOMES.filter((h) => !REHOMED_TAB_PATHS.has(h.to)).map((h) => {
              const tab = workspaceNodeTabFor(h.to);
              return (
                <Route key={h.to} path={h.to}
                  element={tab
                    ? <RehomedToNodeTab to={workspaceTabHref(tab.key)} subKey={WORKSPACE_SUB_KEY} />
                    : h.element} />
              );
            })}
            {/* The re-homed project tabs (card 25c08fba). Every one renders the project NODE, which
                reads the address back through the same `projectNodeTabAt` resolver this frame uses and
                shows that tab. The old page is still what renders — as the node's tab body. */}
            {[...REHOMED_TAB_PATHS].map((to) => (
              <Route key={to} path={to} element={PROJECT_NODE_ELEMENT} />
            ))}
            {/* Anything not yet mounted (an address phase 2 still owes, a typo) lands on the frame
                with an explanation instead of an empty column. */}
            <Route path="*" element={<AtlasEmptyNode />} />
          </Routes>
          </AtlasNodeHeadContext.Provider>
        </main>
      </div>
    </div>
  );
}

function AtlasEmptyNode() {
  return (
    <Panel data-testid="atlas-empty" style={{ maxWidth: 560, padding: "18px 20px" }}>
      <SectionLabel style={{ margin: "0 0 10px" }}>Nothing here yet</SectionLabel>
      {/* Copy stays position-neutral on purpose: the tree rail moves above the content below the
          narrow breakpoint (styles/global.css), so "the tree on the left" would be false on a phone. */}
      <p style={{ margin: 0, color: color.textDim, fontFamily: font.mono, fontSize: 13, lineHeight: 1.7 }}>
        This address has no node in the Atlas preview yet. Pick a destination from the entity tree, or
        switch back to the classic UI for anything the preview has not reached.
      </p>
    </Panel>
  );
}
