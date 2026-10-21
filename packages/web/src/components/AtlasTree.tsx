// The Atlas entity tree — cards 8cbb2ac2 (P1-1, a node per nav destination) and e47df20a (P1-4, the
// project tier becomes the active-project selector). Visual language: the round-4 V2 mockup's tree
// (Mockups/2026-10-19 UI Overhaul Round 4) — a twist column, an icon, a label, a hairline indent for
// children, a phosphor left-edge on the active node, a live-session marker on a project row. Chrome
// lives in styles/global.css (.loom-atlas-node*): structure here, colour there.
//
// A <nav>, not an <aside>: with real nodes in it this IS the app's primary navigation (P1-0 Code
// Review finding, carried on P1-1). Plain NavLinks in document order rather than a role="tree" with
// roving tabindex — the navigation contract is Tab/Enter, which links give natively, and claiming
// tree semantics without arrow keys would be a worse lie than the <aside> it replaces.
//
// ⛔ Both tiers are DERIVED — destinations from src/nav.tsx, projects from ActiveProjectProvider's
// own list. A hand-copied list shows a node for a page that no longer exists, or silently drops a
// new one; a second Atlas-only idea of which project is active would mis-scope the pages below it.
import { useMemo, type ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { Project } from "@loom/shared";
import { ATLAS_HOMES, useVisibleNavPages, type AtlasHome, type NavPage } from "../nav";
import { AgentsQuickSpawn } from "./atlasAgents";
import { NavIcon } from "./navIcons";
import { Logo } from "./Logo";
import { SectionLabel } from "./ui";
import { useActiveProject } from "../lib/activeProject";
import { api } from "../lib/api";
import { isCompanionSession } from "../lib/sessions";
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
function TreeNode({ page, activeTo }: { page: NavPage; activeTo?: string }) {
  return (
    <li>
      {/* `activeTo` is for an address the ROUTER cannot resolve to this node by path: a detail row
          lives at its own URL (/question/:id under the Inbox node), so NavLink's own isActive is
          false there even though the frame's crumbs and heading both name this node. Without it the
          tree would be the one part of the frame disagreeing about where you are. */}
      <NavLink to={page.to} end={page.end}
        className={({ isActive }) => `loom-atlas-node${isActive || page.to === activeTo ? " is-active" : ""}`}
        data-testid={`atlas-node-${page.to}`}>
        {/* A DESTINATION's twist column is reserved and blank: there is nothing under a destination
            to open, so a triangle here would promise an affordance that isn't there. The width is
            held anyway, so every label sits on one text origin and rows don't step in and out as
            phase-2's branches land. (A PROJECT row does draw one — see ProjectNode: it has children
            and genuinely opens and closes.) */}
        <span className="loom-atlas-twist" aria-hidden />
        <span className="loom-atlas-ico" aria-hidden><NavIcon to={page.to} /></span>
        <span className="loom-atlas-lbl">{page.label}</span>
      </NavLink>
    </li>
  );
}

// An Atlas-only node — a tier's own HOME (the Workspace root and the project node, card fd99b2d7)
// or a node within a tier (the Agents node, card c6160c7d).
//
// A home is a LEAF row, first in its tier, rather than the tier's heading made clickable. The
// heading above ("Workspace" / "Projects") names a GROUP, and the open project row is a SELECTOR
// whose whole contract is that it re-scopes without navigating (card e47df20a) — folding a
// destination into either would give one control two jobs and make "where am I" ambiguous for the
// row that already says "what am I scoped to". One extra row buys both tiers the same, honest shape.
//
// `trailing` rides OUTSIDE the NavLink, as a sibling in the same row: a button nested inside an
// anchor is invalid HTML and unreachable by the keyboard, which is exactly what the quick-spawn `＋`
// must not be.
function HomeNode({ home, trailing }: { home: AtlasHome; trailing?: ReactNode }) {
  return (
    <li className={trailing ? "loom-atlas-noderow" : undefined}>
      <NavLink to={home.to} end={false}
        className={({ isActive }) => `loom-atlas-node${isActive ? " is-active" : ""}`}
        data-testid={`atlas-home-${home.key}`}>
        <span className="loom-atlas-twist" aria-hidden />
        <span className="loom-atlas-ico" aria-hidden><NavIcon to={home.to} /></span>
        <span className="loom-atlas-lbl">{home.label}</span>
      </NavLink>
      {trailing}
    </li>
  );
}

const WORKSPACE_HOME = ATLAS_HOMES.find((h) => h.key === "workspace")!;
const PROJECT_HOME = ATLAS_HOMES.find((h) => h.key === "project")!;
const AGENTS_NODE = ATLAS_HOMES.find((h) => h.key === "agents")!;
const WORKSPACE_SETTINGS = ATLAS_HOMES.find((h) => h.key === "workspace-settings")!;

// Live, non-companion session count per project — the marker on each project row. The rail chip's
// dropdown already showed exactly this (components/Sidebar.tsx › RailProjectControl), and it is the
// one thing a reader would lose when selection moves from a dropdown to the tree, so it comes along
// — derived the SAME way, from the SAME shared ["allSessions"] cache entry ActiveProjectProvider
// already fills, so the tree issues no request of its own and can never disagree with the chip.
function useLiveCountsByProject(): Map<string, number> {
  const sessionsQ = useQuery({ queryKey: ["allSessions"], queryFn: api.allSessions });
  return useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of sessionsQ.data ?? []) {
      if (isCompanionSession(s)) continue;
      if (s.processState !== "live" && s.processState !== "starting") continue;
      counts.set(s.projectId, (counts.get(s.projectId) ?? 0) + 1);
    }
    return counts;
  }, [sessionsQ.data]);
}

// One project row — card e47df20a (P1-4). A real control: clicking it writes the active project to
// the SAME ActiveProjectProvider the rail chip writes and every `scoped` page reads, so a tree
// selection and a chip selection are indistinguishable downstream. There is deliberately no second
// Atlas-only notion of "which project" to keep in step.
//
// A <button>, not a NavLink: selecting a project does not change the address. It re-scopes the page
// you are already on — which is the whole point of "tree selection IS scoping" — so a link would
// promise navigation it never performs. (The project node becomes a destination of its own with
// P2-1's project Deck; until then it only selects.)
// The `＋` rides as a SIBLING of the selector button, inside a flex row — card 318b5a21, the round-4
// mockup's §1 affordance that P2-2 could not carry. A <button> nested inside a <button> is invalid
// HTML: the browser closes the outer one at the inner tag, so the row's own selection handler loses
// the markup under it and the inner control is unreachable by the keyboard. The row therefore gets a
// wrapper element and the two controls sit beside each other, exactly as HomeNode's own `trailing`
// does — the one difference being that a project row ALSO has a child list, which must stay outside
// the flex row or it would be laid out as a third column beside the two buttons.
//
// @decision 318b5a21 — never nest the `＋` inside the selector button. Siblings in a flex row.
function ProjectNode({ project, open, live, onSelect, children }: {
  project: Project;
  open: boolean;
  live: number;
  onSelect: (id: string) => void;
  children?: ReactNode;
}) {
  return (
    <li>
      <div className="loom-atlas-noderow">
        {/* `data-testid` marks only the OPEN row: "the project node you are under" stays a single
            element, so P1-1's own structural assertion keeps meaning what it meant. The other rows are
            addressed by their accessible name (the project's own), which is what a reader clicks. */}
        <button type="button"
          className={`loom-atlas-node is-branch${open ? " is-open" : ""}`}
          data-testid={open ? "atlas-project-node" : undefined}
          aria-current={open ? "true" : undefined}
          title={open ? project.name : `Scope to ${project.name}`}
          onClick={() => onSelect(project.id)}>
          {/* Drawn here, unlike on a destination row: a project row genuinely has children and
              genuinely opens and closes — selecting another project closes this one — so the triangle
              reports a state that exists. It is a single-open set, not an independent collapse
              control, which is why it carries no `aria-expanded`: the row claims selection (what it
              really does), and the nesting below is conveyed by the list structure. */}
          <span className="loom-atlas-twist" aria-hidden>▸</span>
          <span className="loom-atlas-ico" aria-hidden><NavIcon to="/projects" /></span>
          <span className="loom-atlas-lbl">{project.name}</span>
          {live > 0 && (
            <span className="loom-atlas-live" title={`${live} live session${live === 1 ? "" : "s"}`}>
              {live}
              <span className="loom-atlas-livedot" aria-hidden />
            </span>
          )}
        </button>
        {/* On EVERY project row, open or not — spawning into a project you are not scoped to without
            first re-scoping is the whole reach this control adds over the Agents node's own `＋`,
            which only ever sees the open one. It is `projectId`-addressed, never active-project-
            addressed, so a spawn from here lands where the row says it will.
            Its own testid stem (`atlas-project-quickspawn-<id>`): a workspace has many project rows,
            so the Agents node's shared `atlas-quickspawn-open` would resolve N elements. */}
        <AgentsQuickSpawn projectId={project.id} projectName={project.name}
          testId={`atlas-project-quickspawn-${project.id}`} />
      </div>
      {children}
    </li>
  );
}

export function AtlasTree({ activeTo }: { activeTo?: string } = {}) {
  const pages = useVisibleNavPages();
  const { workspace, project } = splitByDepth(pages);
  const { projectId, setProjectId, projects } = useActiveProject();
  const liveByProject = useLiveCountsByProject();

  // Built once and rendered by whichever branch below owns it, so the empty-workspace path and the
  // populated path cannot drift into showing different destination sets. The project HOME leads the
  // list: it is the node itself, and everything after it is a surface within that node.
  //
  // Agents sits directly under it, ahead of the NAV_PAGES destinations: it is the node that answers
  // "what can I start here", which is the first thing a reader wants from a project they have just
  // scoped to, and grouping the Atlas-only nodes together keeps the derived destinations below in
  // their own declaration order (card c6160c7d).
  const scopedNodes = [
    <HomeNode key={PROJECT_HOME.to} home={PROJECT_HOME} />,
    <HomeNode key={AGENTS_NODE.to} home={AGENTS_NODE}
      trailing={projectId
        ? <AgentsQuickSpawn projectId={projectId} projectName={projects.find((p) => p.id === projectId)?.name} />
        : undefined} />,
    ...project.map((p) => <TreeNode key={p.to} page={p} activeTo={activeTo} />),
  ];

  return (
    <nav className="loom-atlas-tree" aria-label="Primary navigation" data-testid="atlas-tree">
      <div className="loom-atlas-treehead">
        <Logo size={20} />
      </div>

      <div className="loom-atlas-treebody">
        <SectionLabel style={{ margin: "0 0 4px", padding: "0 10px" }}>Workspace</SectionLabel>
        <ul className="loom-atlas-nodes">
          <HomeNode home={WORKSPACE_HOME} />
          {workspace.map((p) => <TreeNode key={p.to} page={p} activeTo={activeTo} />)}
          {/* LAST in the tier, and after the derived destinations rather than beside the other
              Atlas-only nodes: the classic rail already pulls Settings out of its grouped nav into a
              footer row, so bottom-of-tier is the position a reader of this app already expects it
              in. Its project-tier twin (`/settings`, a NAV_PAGES destination) is likewise the last
              scoped row, so the two Settings nodes sit at the foot of their own tiers (card 595e2a47). */}
          <HomeNode home={WORKSPACE_SETTINGS} />
        </ul>

        {/* Plural, and plural even at one project: the label names the kind of node under it, the
            way "Workspace" above does, not how many there happen to be today. */}
        <SectionLabel style={{ margin: "18px 0 4px", padding: "0 10px" }}>Projects</SectionLabel>
        {projects.length === 0 ? (
          <>
            {/* Nothing to select, so nothing here pretends to be selectable — the row stays the plain
                label it was before selection existed. The destinations stay reachable beneath it:
                every one of them renders with no project resolved today (each has its own empty
                state), and phase 1's hard rule is that the pages behave exactly as they do now. */}
            <div className="loom-atlas-node is-branch is-open" data-testid="atlas-project-node">
              <span className="loom-atlas-twist" aria-hidden>▸</span>
              <span className="loom-atlas-ico" aria-hidden><NavIcon to="/projects" /></span>
              <span className="loom-atlas-lbl">No project</span>
            </div>
            <ul className="loom-atlas-nodes is-kids">{scopedNodes}</ul>
            {/* Deliberately a HINT, not a gate — see above. */}
            <p style={{ margin: "6px 10px 0", color: color.textMuted, fontFamily: font.mono, fontSize: 11.5, lineHeight: 1.6 }}>
              No project is active yet — these scope to one once a project exists.
            </p>
          </>
        ) : (
          // Source order, never reordered by selection or by liveness: a nav rail whose rows move
          // under the cursor as sessions start and stop is a nav rail you stop trusting to be where
          // you left it. The rail chip sorts live-first because a dropdown is read once per use; a
          // standing tree is read continuously.
          //
          // The open branch is ALWAYS the id ActiveProjectProvider resolved — never a tree-local
          // guess — or the destinations under it would claim a scope the pages themselves don't
          // have. That is total by construction (the provider only yields "" when the workspace
          // holds no projects at all, which is the branch above), and if it ever stopped being,
          // the scoped destinations would vanish from the tree rather than quietly mis-scope —
          // which atlas-tree.spec.ts's node-set parity check fails on, loudly.
          <ul className="loom-atlas-nodes">
            {projects.map((p) => (
              <ProjectNode key={p.id} project={p} open={p.id === projectId}
                live={liveByProject.get(p.id) ?? 0} onSelect={setProjectId}>
                {p.id === projectId && <ul className="loom-atlas-nodes is-kids">{scopedNodes}</ul>}
              </ProjectNode>
            ))}
          </ul>
        )}
      </div>
    </nav>
  );
}
