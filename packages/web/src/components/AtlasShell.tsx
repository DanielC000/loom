import type { ReactNode } from "react";
import { matchPath, Route, Routes, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { SessionListItem } from "@loom/shared";
import { Badge, Button, Panel, SectionLabel } from "./ui";
import { AtlasTree } from "./AtlasTree";
import { LEGACY_REDIRECTS, NAV_PAGES, PARAM_PAGES, type NavPage, type ParamPage } from "../nav";
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
): NodeAddress | undefined {
  const atlas = current?.page.atlas;
  const id = current?.id ?? "";

  const sessions = useQuery({
    queryKey: ["allSessions"], queryFn: api.allSessions,
    enabled: atlas?.kind === "session" && !!id,
  });
  const question = useQuery({
    queryKey: ["question", id], queryFn: () => api.question(id),
    enabled: atlas?.kind === "detail" && !!id, retry: false,
  });

  if (!atlas) return undefined;

  if (atlas.kind === "session") {
    const session = (sessions.data ?? []).find((s) => s.id === id);
    const heading = session ? sessionNodeLabel(session) : `Session ${id.slice(0, 8)}`;
    return {
      crumbs: ["Workspace", ...(session ? [session.projectName] : []), heading, ...(atlas.tab ? [atlas.tab] : [])],
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
  const { pathname } = useLocation();
  const { projectId, projects } = useActiveProject();
  const page = currentPage(pathname);
  const project = projects.find((p) => p.id === projectId);
  const activeProjectName = project?.name ?? "No project";
  const paramPage = currentParamPage(pathname);
  const paramAddress = useParamAddress(paramPage, activeProjectName);
  // A detail address hangs off a REAL tree node, so that node reads as the landed one even though
  // its own path never matches. A session address has no node in the tree yet (phase 2 gives it
  // one), so nothing is highlighted for it — marking some nearby node instead would be a lie.
  const paramAtlas = paramPage?.page.atlas;
  const activeNodeTo = paramAtlas?.kind === "detail" ? paramAtlas.under : undefined;

  // The trail mirrors the tree's own depth rule (AtlasTree's splitByDepth): a god-eye destination
  // hangs off the workspace root, a `scoped` one hangs off the project it is scoped to. So the crumbs
  // read as the path actually taken through the tree, not as a second, independently-maintained idea
  // of the hierarchy.
  const navCrumbs: string[] = ["Workspace"];
  if (page?.scoped) navCrumbs.push(activeProjectName);
  if (page) navCrumbs.push(page.label);

  // A parameterized address wins when one matched: the two matchers are disjoint (a NAV_PAGES `to`
  // is a literal path, and no literal path is also a PARAM_PAGES pattern), so this is a fallback
  // order, not a precedence contest.
  const crumbs = paramAddress?.crumbs ?? navCrumbs;
  const heading = paramAddress?.heading ?? page?.label ?? "Workspace";

  return (
    <div className="loom-atlas" data-testid="atlas-shell">
      {overlays}
      <AtlasTree activeTo={activeNodeTo} />

      <div className="loom-atlas-main">
        <header className="loom-atlas-topbar">
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
            <h1 style={{ margin: 0, fontFamily: font.head, fontWeight: 600, fontSize: 17, letterSpacing: "0.02em", color: color.text }}>
              {heading}
            </h1>
            <Badge tone="cyan">preview</Badge>
          </div>
        </header>

        {banners}

        <main className="loom-atlas-content">
          <Routes>
            {/* Each destination's own component, rendered exactly as the legacy shell renders it. */}
            {NAV_PAGES.map((p) => (
              <Route key={p.to} path={p.to} element={p.element} />
            ))}
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
            {/* Anything not yet mounted (an address phase 2 still owes, a typo) lands on the frame
                with an explanation instead of an empty column. */}
            <Route path="*" element={<AtlasEmptyNode />} />
          </Routes>
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
