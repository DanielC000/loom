// The Atlas entity tree — card 8cbb2ac2 (P1-1), the rail that gives every nav destination a node.
// Visual language: the round-4 V2 mockup's tree (Mockups/2026-10-19 UI Overhaul Round 4) — a reserved
// twist column, an icon, a label, a hairline indent for children, a phosphor left-edge on the active
// node. Chrome lives in styles/global.css (.loom-atlas-node*): structure here, colour there.
//
// A <nav>, not an <aside>: with real nodes in it this IS the app's primary navigation (P1-0 Code
// Review finding, carried on this card). Plain NavLinks in document order rather than a role="tree"
// with roving tabindex — the DoD's navigation contract is Tab/Enter, which links give natively, and
// claiming tree semantics without arrow keys would be a worse lie than the <aside> it replaces. A
// real role="tree" belongs with the card that gives the tree genuine entity hierarchy.
//
// ⛔ The node list is DERIVED from src/nav.tsx, never hand-listed: a hand-copied list shows a node
// for a page that no longer exists — or, worse, silently drops a newly added one.
import { NavLink } from "react-router-dom";
import { useVisibleNavPages, type NavPage } from "../nav";
import { NavIcon } from "./navIcons";
import { Logo } from "./Logo";
import { SectionLabel } from "./ui";
import { useActiveProject } from "../lib/activeProject";
import { color, font } from "../theme";

// Scope is depth (round 2's rule, kept by the approved round-4 IA): a destination lives at the
// shallowest node that contains everything it spans. `NAV_PAGES[i].scoped` already records exactly
// that distinction — a scoped page rescopes on the active project, an unscoped one is god-eye — so it
// is the only input needed to split the tree into its two levels. Nothing here re-decides placement.
function splitByDepth(pages: NavPage[]): { workspace: NavPage[]; project: NavPage[] } {
  return {
    workspace: pages.filter((p) => !p.scoped),
    project: pages.filter((p) => p.scoped),
  };
}

// One leaf node. `end` comes straight from NAV_PAGES so the index route ("/") gets exact-match active
// state, identical to how the Instrument Rail consumes the same flag.
//
// No scope marker, deliberately, even though the rail puts one on exactly these destinations: the
// rail needs it because it shows one FLAT list where scoped and god-eye rows sit side by side. Here
// depth already says it — a destination under the project node is scoped to that project, and the
// node names which one. Round 2's approved IA retires the scope dot for this exact reason ("tree
// selection IS scoping"); re-adding it would be decoration restating the indent.
function TreeNode({ page }: { page: NavPage }) {
  return (
    <li>
      <NavLink to={page.to} end={page.end}
        className={({ isActive }) => `loom-atlas-node${isActive ? " is-active" : ""}`}
        data-testid={`atlas-node-${page.to}`}>
        {/* The twist column is RESERVED, never drawn, while nothing in this tree expands. Keeping the
            width holds every label on one text origin (so rows don't step in and out as the phase-2
            branches land); drawing a triangle that collapses nothing would promise an affordance that
            isn't there. The triangle returns with the card that makes nodes genuinely expandable. */}
        <span className="loom-atlas-twist" aria-hidden />
        <span className="loom-atlas-ico" aria-hidden><NavIcon to={page.to} /></span>
        <span className="loom-atlas-lbl">{page.label}</span>
      </NavLink>
    </li>
  );
}

export function AtlasTree() {
  const pages = useVisibleNavPages();
  const { workspace, project } = splitByDepth(pages);
  const { projectId, projects } = useActiveProject();
  const active = projects.find((p) => p.id === projectId);

  return (
    <nav className="loom-atlas-tree" aria-label="Primary navigation" data-testid="atlas-tree">
      <div className="loom-atlas-treehead">
        <Logo size={20} />
      </div>

      <div className="loom-atlas-treebody">
        <SectionLabel style={{ margin: "0 0 4px", padding: "0 10px" }}>Workspace</SectionLabel>
        <ul className="loom-atlas-nodes">
          {workspace.map((p) => <TreeNode key={p.to} page={p} />)}
        </ul>

        <SectionLabel style={{ margin: "18px 0 4px", padding: "0 10px" }}>Project</SectionLabel>
        {/* The project node is a LABEL at this phase, not a control: making tree selection set the
            active project is P1-4's job, and a node that looked clickable but changed nothing would
            be worse than one that plainly doesn't. It reads the SAME ActiveProjectProvider value the
            scoped pages below already read, so what it names is always what they are scoped to. */}
        <div className="loom-atlas-node is-branch" data-testid="atlas-project-node">
          <span className="loom-atlas-twist" aria-hidden />
          <span className="loom-atlas-ico" aria-hidden><NavIcon to="/projects" /></span>
          <span className="loom-atlas-lbl">{active?.name ?? "No project"}</span>
        </div>
        <ul className="loom-atlas-nodes is-kids">
          {project.map((p) => <TreeNode key={p.to} page={p} />)}
        </ul>
        {/* Deliberately a HINT, not a gate. Today every one of these destinations is reachable with no
            project resolved (ActiveProjectProvider only yields "" when the workspace holds no projects
            at all) and each page renders its own empty state; disabling them here would be a real
            behaviour change, and phase 1's one hard rule is that the pages behave exactly as they do
            today. So the dependency is stated, and the pages keep answering for themselves. */}
        {!active && (
          <p style={{ margin: "6px 10px 0", color: color.textMuted, fontFamily: font.mono, fontSize: 11.5, lineHeight: 1.6 }}>
            No project is active yet — these scope to one once a project exists.
          </p>
        )}
      </div>
    </nav>
  );
}
