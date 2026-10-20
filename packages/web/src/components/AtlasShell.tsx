import type { ReactNode } from "react";
import { matchPath, Route, Routes, useLocation } from "react-router-dom";
import { Badge, Button, Panel, SectionLabel } from "./ui";
import { AtlasTree } from "./AtlasTree";
import { NAV_PAGES, type NavPage } from "../nav";
import { setAtlasUi } from "../lib/atlasUi";
import { useActiveProject } from "../lib/activeProject";
import { color, font } from "../theme";

// The Atlas shell — cards 757c80dd (P1-0, the frame) and 8cbb2ac2 (P1-1, the nodes). What Atlas is,
// and which card builds what: docs/plans/atlas-ui/02-architecture.md + 03-decomposition.md.
//
// P1-1 fills the frame: the entity tree (components/AtlasTree.tsx) holds a node per nav destination,
// and the route table below mounts each destination's EXISTING component from src/nav.tsx verbatim.
// Nothing about a page changes because it was reached through a node — the whole promise of phase 1.
//
// Routes, crumbs and the node heading are all DERIVED from NAV_PAGES. Never hand-list them: a path
// copied into this file drifts invisibly the moment someone edits nav.tsx. Still unmounted, each on
// its own card: the parameterized routes (P1-2), the legacy redirects (P1-3), tree-selection-scoping
// (P1-4) — the catch-all below keeps those URLs on the frame until then.
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

export function AtlasShell({ overlays, banners }: { overlays?: ReactNode; banners?: ReactNode }) {
  const { pathname } = useLocation();
  const { projectId, projects } = useActiveProject();
  const page = currentPage(pathname);
  const project = projects.find((p) => p.id === projectId);

  // The trail mirrors the tree's own depth rule (AtlasTree's splitByDepth): a god-eye destination
  // hangs off the workspace root, a `scoped` one hangs off the project it is scoped to. So the crumbs
  // read as the path actually taken through the tree, not as a second, independently-maintained idea
  // of the hierarchy.
  const crumbs: string[] = ["Workspace"];
  if (page?.scoped) crumbs.push(project?.name ?? "No project");
  if (page) crumbs.push(page.label);

  return (
    <div className="loom-atlas" data-testid="atlas-shell">
      {overlays}
      <AtlasTree />

      <div className="loom-atlas-main">
        <header className="loom-atlas-topbar">
          <div className="loom-atlas-crumbs">
            <nav aria-label="Breadcrumb" data-testid="atlas-breadcrumb" style={{ minWidth: 0 }}>
              <ol style={{ display: "flex", alignItems: "center", gap: 8, listStyle: "none", margin: 0, padding: 0,
                fontFamily: font.mono, fontSize: 11.5, color: color.textMuted }}>
                {crumbs.map((crumb, i) => {
                  const last = i === crumbs.length - 1;
                  return (
                    <li key={`${i}-${crumb}`} aria-current={last ? "page" : undefined}
                      style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0,
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
              {page?.label ?? "Workspace"}
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
            {/* Anything not yet mounted (the parameterized routes, the legacy redirects, a typo) lands
                on the frame with an explanation instead of an empty column. */}
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
