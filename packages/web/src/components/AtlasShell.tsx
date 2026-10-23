import { useState, type ReactNode } from "react";
import { matchPath, Navigate, Route, Routes, useLocation, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { SessionListItem } from "@loom/shared";
import { Badge, Button, Panel, SectionLabel } from "./ui";
import { AtlasTree } from "./AtlasTree";
import { OrchestrationChip, useOrchestrationPaused } from "./fleetControls";
import {
  ATLAS_HOMES, LEGACY_REDIRECTS, NAV_PAGES, PARAM_PAGES, PROJECT_NODE_PATH, PROJECT_NODE_TABS,
  isRehomedProjectTab, projectNodeTabAt, projectTabPath, workspaceNodeTabFor,
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
const BY_SPECIFICITY: NavPage[] = [...NAV_PAGES].sort((a, b) => b.to.length - a.to.length);

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
  // A detail address hangs off a REAL tree node, so that node reads as the landed one even though
  // its own path never matches. A session address has no node in the tree yet (phase 2 gives it
  // one), so nothing is highlighted for it — marking some nearby node instead would be a lie.
  const paramAtlas = paramPage?.page.atlas;
  const activeNodeTo = paramAtlas?.kind === "detail" ? paramAtlas.under : undefined;
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

  return (
    <div className="loom-atlas" data-testid="atlas-shell">
      {overlays}
      <AtlasTree activeTo={activeNodeTo} />

      <div className="loom-atlas-main">
        <header className={`loom-atlas-topbar${orchestrationPaused ? " is-paused" : ""}`}>
          <div className="loom-atlas-crumbs">
            <nav aria-label="Breadcrumb" data-testid="atlas-breadcrumb" style={{ minWidth: 0 }}>
              <ol style={{ display: "flex", alignItems: "center", gap: 8, listStyle: "none", margin: 0, padding: 0,
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
                    <li key={`${i}-${crumb}`} aria-current={last ? "page" : undefined}
                      style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0,
                        flexShrink: last ? 1 : 999,
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
            <Button data-testid="atlas-leave" onClick={() => setAtlasUi(false)}
              title="Turn the Atlas preview off and return to the classic UI"
              style={{ padding: "5px 12px" }}>
              Switch to the classic UI
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
                component is mounted there instead. (The two sets are disjoint: a destination is at
                one depth.) The CLASSIC shell still mounts the page at this same path, unchanged. */}
            {NAV_PAGES.filter((p) => !REHOMED_TAB_PATHS.has(p.to)).map((p) => {
              const tab = workspaceNodeTabFor(p.to);
              return (
                <Route key={p.to} path={p.to}
                  element={tab
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
