import type { ReactNode } from "react";
import { Route, Routes } from "react-router-dom";
import { Badge, Button, Panel, SectionLabel } from "./ui";
import { Logo } from "./Logo";
import { setAtlasUi } from "../lib/atlasUi";
import { color, font } from "../theme";

// The Atlas shell — card 757c80dd (P1-0), the top-level layout the Atlas UI switch gates. What Atlas
// is, and which card builds what: docs/plans/atlas-ui/02-architecture.md + 03-decomposition.md.
//
// At THIS phase it is deliberately an EMPTY FRAME: the entity-tree rail, the breadcrumb bar and the
// node header, with no nodes, no tabs and no pages — the card's whole job is to stand the frame up and
// prove the switch is a true no-op when off. The later phase-1 cards hang the nav destinations
// (src/nav.tsx), the parameterized routes and the legacy redirects off the route table below rather
// than inventing one; read how many of each there are from nav.tsx and the plan, never from a count
// restated here.
//
// Chrome is PASSED IN, never imported: App.tsx mounts the overlays and banners for BOTH shells, so it
// stays the single owner of what the app root renders and this file stays a pure frame. Both slots sit
// OUTSIDE the route table below, matching where the legacy shell mounts them.
export function AtlasShell({ overlays, banners }: { overlays?: ReactNode; banners?: ReactNode }) {
  return (
    <div className="loom-atlas" data-testid="atlas-shell">
      {overlays}
      {/* P1-1, once this holds real nodes: make this a <nav>. It is navigation, and an <aside>
          around a live tree announces as a complementary region instead. It is an aside today
          only because a tree with no nodes navigates nothing. */}
      <aside className="loom-atlas-tree" aria-label="Entity tree" data-testid="atlas-tree">
        <div className="loom-atlas-treehead">
          <Logo size={20} />
        </div>
        <div className="loom-atlas-treebody">
          <SectionLabel style={{ margin: "0 0 6px" }}>Workspace</SectionLabel>
          <p style={{ margin: 0, color: color.textMuted, fontFamily: font.mono, fontSize: 12, lineHeight: 1.6 }}>
            No nodes yet.
          </p>
        </div>
      </aside>

      <div className="loom-atlas-main">
        <header className="loom-atlas-topbar">
          {/* The breadcrumb frame. One crumb today (the workspace root is the only thing that exists);
              a real trail arrives with the tree nodes. Semantic nav/ol so the trail is announced as a
              breadcrumb from the start rather than retrofitted once it has more than one entry. */}
          <div className="loom-atlas-crumbs">
            <nav aria-label="Breadcrumb" data-testid="atlas-breadcrumb" style={{ minWidth: 0 }}>
              <ol style={{ display: "flex", alignItems: "center", gap: 8, listStyle: "none", margin: 0, padding: 0,
                fontFamily: font.mono, fontSize: 11.5, color: color.textMuted }}>
                <li aria-current="page" style={{ color: color.text }}>Workspace</li>
              </ol>
            </nav>
            <span style={{ flex: 1 }} />
            {/* The way back. With the tree empty there is no route to Settings from inside Atlas, so
                without this the switch would be a one-way door for anyone who flipped it — recoverable
                only by clearing site data. It is the one interactive control this phase ships. */}
            <Button data-testid="atlas-leave" onClick={() => setAtlasUi(false)}
              title="Turn the Atlas preview off and return to the classic UI"
              style={{ padding: "5px 12px" }}>
              Switch to the classic UI
            </Button>
          </div>

          <div className="loom-atlas-nodehead">
            <h1 style={{ margin: 0, fontFamily: font.head, fontWeight: 600, fontSize: 17, letterSpacing: "0.02em", color: color.text }}>
              Workspace
            </h1>
            <Badge tone="cyan">preview</Badge>
          </div>
        </header>

        {banners}

        <main className="loom-atlas-content">
          {/* The shell's own route table. One catch-all node today, so every URL lands on the empty
              frame instead of a blank screen; later phase-1 cards add the real node + tab routes here. */}
          <Routes>
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
      {/* Copy stays position-neutral on purpose: the tree rail is dropped below the narrow
          breakpoint (styles/global.css), so "the tree on the left" would be false on a phone. */}
      <p style={{ margin: 0, color: color.textDim, fontFamily: font.mono, fontSize: 13, lineHeight: 1.7 }}>
        The Atlas frame is up: an entity tree, a breadcrumb trail and a node header. The projects, agents,
        boards and sessions that fill them arrive as the preview is built.
      </p>
      <p style={{ margin: "12px 0 0", color: color.textMuted, fontFamily: font.mono, fontSize: 12.5, lineHeight: 1.7 }}>
        Your existing UI is untouched. “Switch to the classic UI”, top right, takes you back to it at any time.
      </p>
    </Panel>
  );
}
