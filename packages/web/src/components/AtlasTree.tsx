// The Atlas entity tree — cards 8cbb2ac2 (P1-1, a node per nav destination), e47df20a (P1-4, the
// project tier becomes the active-project selector) and 0d0c6cee (the tree becomes an ENTITY
// hierarchy: projects, not pages). Visual language: the round-4 V2 mockup's tree
// (Mockups/2026-10-19 UI Overhaul Round 4 — `index.html`'s `<aside class="tree">` markup and
// `atlas.css`'s `.node*` rules). Chrome lives in styles/global.css (.loom-atlas-node*): structure
// here, colour there.

// A <nav>, not an <aside>: with real nodes in it this IS the app's primary navigation (P1-0 Code
// Review finding, carried on P1-1). Plain links in document order rather than a role="tree" with
// roving tabindex — the navigation contract is Tab/Enter, which links give natively, and claiming
// tree semantics without arrow keys would be a worse lie than the <aside> it replaces.

// ⛔ Every tier is DERIVED — projects from ActiveProjectProvider's own list, destinations from
// src/nav.tsx. A hand-copied list shows a node for a page that no longer exists, or silently drops a
// new one; a second Atlas-only idea of which project is active would mis-scope the pages below it.

// @decision 0d0c6cee — expansion is not selection; a non-selected branch's rows are plain <Link>s
// with project-qualified test ids and re-scope BEFORE they navigate; no row metric may add an
// `api.ts` member or a per-project query; the "Not yet re-homed" disclosure is never a tree row.
import { useMemo, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { Project } from "@loom/shared";
import {
  ATLAS_HOMES, PROJECT_NODE_TABS, isRehomedProjectTab, projectTabPath, useVisibleNavPages,
  workspaceNodeTabFor, type AtlasHome, type NavPage,
} from "../nav";
import { AgentsQuickSpawn } from "./atlasAgents";
import { NavIcon } from "./navIcons";
import { Logo } from "./Logo";
import { SectionLabel } from "./ui";
import { useActiveProject } from "../lib/activeProject";
import { useAttention } from "../lib/attention";
import { boardRollup, liveCountsByProject } from "../lib/atlasHome";
import { standingOperators } from "../lib/atlasAgents";
import { api } from "../lib/api";
import { color, font } from "../theme";

// Scope is depth (round 2's rule, kept by the approved round-4 IA): a destination lives at the
// shallowest node that contains everything it spans. `NAV_PAGES[i].scoped` already records exactly
// that distinction — a scoped page rescopes on the active project, an unscoped one is god-eye — so it
// is the only input needed to split the tree into its two levels. Nothing here re-decides placement.
//
// @decision 25c08fba — a row's depth is `scoped` OR named as a re-homed project tab; never the flag
// alone.
//
// Card 25c08fba adds the ONE case the flag cannot answer. `/terminals` is an unscoped, god-eye page
// in the classic rail AND the approved design's project-node "Sessions" tab, so under Atlas it sits
// at project depth even though its own flag says workspace. Depth is therefore `scoped` OR named as a
// re-homed project tab — read off the same PROJECT_NODE_TABS declaration the node and the frame read,
// so the tree cannot put a row at a different depth than the crumbs the row leads to.
//
// The project tier is then ORDERED by that declaration, which is the approved design's own tab order,
// so a reader's eye moves between the branch and the node's tab row without re-sorting. A
// project-scoped page with no tab (today only `/overview`, which P3-switch-over owns) leads, since
// the declaration has no opinion about where it goes.
function splitByDepth(pages: NavPage[]): { workspace: NavPage[]; project: NavPage[] } {
  const tabAt = (to: string) => PROJECT_NODE_TABS.findIndex((t) => isRehomedProjectTab(t) && projectTabPath(t) === to);
  const atProjectDepth = (p: NavPage) => !!p.scoped || tabAt(p.to) >= 0;
  return {
    workspace: pages.filter((p) => !atProjectDepth(p)),
    project: pages.filter(atProjectDepth).sort((a, b) => {
      const ia = tabAt(a.to), ib = tabAt(b.to);
      return (ia < 0 ? -1 : ia) - (ib < 0 ? -1 : ib);
    }),
  };
}

/** What the project node calls a re-homed destination — "Sessions" for `/terminals`, else its own. */
function projectRowLabel(page: NavPage): string {
  const tab = PROJECT_NODE_TABS.find((t) => isRehomedProjectTab(t) && projectTabPath(t) === page.to);
  return tab?.label ?? page.label;
}

// The ONE god-eye destination that stays a WORKSPACE-TIER NODE rather than becoming a tab: the
// reserved Platform home. The mockup pins it directly above the project list (its own `NODES.platform`
// row, `crumbs: ["root"]`) because it is a sibling ENTITY of the projects — a home with its own agents
// — not a surface OF the workspace. Every other unscoped destination is a Workspace-node TAB in the
// mockup (`ROOT_TABS`): card 41eab0eb built seven of them — `WORKSPACE_NODE_TABS` in src/nav.tsx, the
// "which node tab does this become" field card 0d0c6cee could not yet guess — and card 25c08fba took
// `/terminals` down to PROJECT depth as the project node's Sessions tab, so it is no longer an
// unscoped destination this tier places at all. The two still in the escape hatch at the foot of the
// tree belong to card 5afd71bd.
//
// A one-entry literal rather than a `nav.tsx` field of its own: this stays the single placement
// judgement card 0d0c6cee made, and nothing since has needed a second entry.
const WORKSPACE_TIER_NODES = ["/platform"];

/** A right-aligned metric on a row — the mockup's `.node-meta` (muted, 10.5px). */
function NodeMeta({ value, title, tone }: { value: ReactNode; title: string; tone?: "amber" }) {
  return (
    <span className={`loom-atlas-nodemeta${tone === "amber" ? " is-amber" : ""}`} title={title}>{value}</span>
  );
}

/** The mockup's `.node-badge` — an amber attention count, deliberately louder than a plain metric. */
function NodeBadge({ count, title }: { count: number; title: string }) {
  return <span className="loom-atlas-nodebadge" title={title}>{count}</span>;
}

// One leaf node. `end` comes straight from NAV_PAGES so the index route ("/") gets exact-match active
// state, identical to how the Instrument Rail consumes the same flag.
//
// `active` is the PROJECT-tier gate, not a route match: the same scoped destination renders once per
// EXPANDED project (card 0d0c6cee), and only the one under the project you are actually scoped to may
// read as landed. So a row in a non-active branch is a plain <Link> — it still navigates, still
// middle-clicks, but has no isActive of its own and contributes no `aria-current`, which is what keeps
// "exactly one node is active" a true statement however many branches are open.
//
// No scope marker, deliberately, even though the rail puts one on exactly these destinations: the
// rail needs it because it shows one FLAT list where scoped and god-eye rows sit side by side. Here
// depth already says it — a destination under a project node is scoped to that project, and the node
// names which one. Round 2's approved IA retires the scope dot for this exact reason ("tree selection
// IS scoping"); re-adding it would be decoration restating the indent.
function TreeNode({ page, activeTo, active = true, testId, label, metric, onNavigate }: {
  page: NavPage;
  activeTo?: string;
  active?: boolean;
  testId: string;
  /** Overrides the page's own label where the NODE calls the destination something else (card
   *  25c08fba: `/terminals` is the project node's "Sessions"). The classic rail keeps `page.label`. */
  label?: string;
  metric?: ReactNode;
  onNavigate?: () => void;
}) {
  const body = (
    <>
      {/* A DESTINATION's twist column is reserved and blank: there is nothing under a destination to
          open, so a triangle here would promise an affordance that isn't there. The width is held
          anyway, so every label sits on one text origin. (A PROJECT row draws a real one — see
          ProjectNode: it has children and genuinely opens and closes.) */}
      <span className="loom-atlas-twist" aria-hidden />
      <span className="loom-atlas-ico" aria-hidden><NavIcon to={page.to} /></span>
      <span className="loom-atlas-lbl">{label ?? page.label}</span>
      {metric}
    </>
  );
  return (
    <li>
      {active
        ? (
          /* `activeTo` is for an address the ROUTER cannot resolve to this node by path: a detail row
             lives at its own URL (/question/:id under the Inbox node), so NavLink's own isActive is
             false there even though the frame's crumbs and heading both name this node. Without it the
             tree would be the one part of the frame disagreeing about where you are. */
          <NavLink to={page.to} end={page.end} onClick={onNavigate}
            className={({ isActive }) => `loom-atlas-node${isActive || page.to === activeTo ? " is-active" : ""}`}
            data-testid={testId}>
            {body}
          </NavLink>
        )
        : (
          <Link to={page.to} onClick={onNavigate} className="loom-atlas-node" data-testid={testId}>
            {body}
          </Link>
        )}
    </li>
  );
}

// An Atlas-only node — a tier's own HOME (the Workspace root and the project node, card fd99b2d7)
// or a node within a tier (the Agents node, card c6160c7d).
//
// A tier's home is a LEAF row rather than the tier's heading made clickable. The heading above
// ("Workspace" / "Projects") names a GROUP, and a project row is a SELECTOR whose whole contract is
// that it re-scopes without navigating (card e47df20a) — folding a destination into either would give
// one control two jobs and make "where am I" ambiguous for the row that already says "what am I
// scoped to". One extra row buys both tiers the same, honest shape.
//
// `trailing` rides OUTSIDE the link, as a sibling in the same row: a button nested inside an anchor is
// invalid HTML and unreachable by the keyboard, which is exactly what the quick-spawn `＋` must not be.
function HomeNode({ home, testId, active = true, trailing, metric, onNavigate }: {
  home: AtlasHome;
  testId: string;
  active?: boolean;
  trailing?: ReactNode;
  metric?: ReactNode;
  onNavigate?: () => void;
}) {
  const body = (
    <>
      <span className="loom-atlas-twist" aria-hidden />
      <span className="loom-atlas-ico" aria-hidden><NavIcon to={home.to} /></span>
      <span className="loom-atlas-lbl">{home.label}</span>
      {metric}
    </>
  );
  return (
    <li className={trailing ? "loom-atlas-noderow" : undefined}>
      {/* Same active/inactive split, and for the same reason, as TreeNode above. */}
      {active
        ? (
          <NavLink to={home.to} end={false} onClick={onNavigate}
            className={({ isActive }) => `loom-atlas-node${isActive ? " is-active" : ""}`}
            data-testid={testId}>
            {body}
          </NavLink>
        )
        : <Link to={home.to} onClick={onNavigate} className="loom-atlas-node" data-testid={testId}>{body}</Link>}
      {trailing}
    </li>
  );
}

const WORKSPACE_HOME = ATLAS_HOMES.find((h) => h.key === "workspace")!;
const PROJECT_HOME = ATLAS_HOMES.find((h) => h.key === "project")!;
const AGENTS_NODE = ATLAS_HOMES.find((h) => h.key === "agents")!;

// One project row — cards e47df20a (P1-4) and 0d0c6cee. A real control: clicking it writes the active
// project to the SAME ActiveProjectProvider the rail chip writes and every `scoped` page reads, so a
// tree selection and a chip selection are indistinguishable downstream. There is deliberately no
// second Atlas-only notion of "which project" to keep in step.
//
// A <button>, not a link: selecting a project does not change the address. It re-scopes the page you
// are already on — which is the whole point of "tree selection IS scoping" — so a link would promise
// navigation it never performs. (The project node's own page is the `Home` row directly beneath it.)
//
// 🔴 THE TWIST IS ITS OWN BUTTON, and expansion is NOT selection (card 0d0c6cee). Every project is
// expandable whether or not it is active, so a reader can look INTO a project — its agents, its board,
// its repository — without re-scoping the page they are reading. Folding the two into one control is
// what made the old tier a one-open accordion keyed to selection; keeping them apart is what makes
// this a tree. `is-open` on the selector still means SELECTED (exactly one row, ever); `aria-expanded`
// on the twist means OPEN.
//
// The `＋` rides as a SIBLING of the selector button — card 318b5a21, the round-4 mockup's §1
// affordance. A <button> nested inside a <button> is invalid HTML: the browser closes the outer one at
// the inner tag, so the row's own selection handler loses the markup under it and the inner control is
// unreachable by the keyboard. The row therefore gets a wrapper element and the controls sit beside
// each other — the one difference being that a project row ALSO has a child list, which must stay
// outside the flex row or it would be laid out as a further column beside the buttons.
//
// @decision 318b5a21 — never nest the `＋` inside the selector button. Siblings in a flex row.
function ProjectNode({ project, selected, expanded, metrics, onSelect, onToggle, children }: {
  project: Project;
  selected: boolean;
  expanded: boolean;
  metrics?: ReactNode;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  children?: ReactNode;
}) {
  const twistLabel = `${expanded ? "Collapse" : "Expand"} ${project.name}`;
  return (
    <li>
      {/* `is-open` is mirrored onto the ROW as well as the selector: the phosphor edge has to sit at
          the rail's own left edge, and with the twist hoisted out of the button the button no longer
          starts there. The class stays on the button too — that is what "the branch you are inside"
          has meant since P1-4, and what atlas-project-selection.spec.ts reads. */}
      <div className={`loom-atlas-noderow is-branchrow${selected ? " is-open" : ""}`}>
        <button type="button" className={`loom-atlas-twistbtn${expanded ? " is-expanded" : ""}`}
          aria-expanded={expanded} aria-label={twistLabel} title={twistLabel}
          data-testid={`atlas-project-twist-${project.id}`}
          onClick={() => onToggle(project.id)}>
          <span aria-hidden>▸</span>
        </button>
        {/* `data-testid` marks only the SELECTED row: "the project node you are under" stays a single
            element, so P1-1's own structural assertion keeps meaning what it meant. The other rows are
            addressed by their accessible name (the project's own), which is what a reader clicks. */}
        <button type="button"
          className={`loom-atlas-node is-branch${selected ? " is-open" : ""}`}
          data-testid={selected ? "atlas-project-node" : undefined}
          aria-current={selected ? "true" : undefined}
          title={selected ? project.name : `Scope to ${project.name}`}
          onClick={() => onSelect(project.id)}>
          <span className="loom-atlas-ico" aria-hidden><NavIcon to="/projects" /></span>
          <span className="loom-atlas-lbl">{project.name}</span>
          {metrics}
        </button>
        {/* On EVERY project row, selected or not — spawning into a project you are not scoped to
            without first re-scoping is the whole reach this control adds over the Agents node's own
            `＋`, which only ever sees the selected one. It is `projectId`-addressed, never
            active-project-addressed, so a spawn from here lands where the row says it will.
            Its own testid stem (`atlas-project-quickspawn-<id>`): a workspace has many project rows,
            so the Agents node's shared `atlas-quickspawn-open` would resolve N elements. */}
        <AgentsQuickSpawn projectId={project.id} projectName={project.name}
          testId={`atlas-project-quickspawn-${project.id}`} />
      </div>
      {expanded && children}
    </li>
  );
}

/**
 * Every cross-project destination that has LEFT the tree, with its own address kept alive.
 *
 * Card 5afd71bd owns the two that are left — Mission Control and Projects, which the approved design
 * dissolves outright. Card 41eab0eb took seven as Workspace node tabs, and card 25c08fba took
 * Terminals down to project depth as the PROJECT node's Sessions tab. Until the last of them lands,
 * removing these rows without this would strand real surfaces behind ⌘K alone — so they stay
 * reachable, but deliberately NOT as `.loom-atlas-node` rows: a hierarchy with a flat page list
 * bolted to its side is the "worst of both worlds" card 0d0c6cee exists to end. A disclosure, named
 * for what it is, that the last re-homing card deletes.
 *
 * It auto-opens on the destination you are actually looking at, so the tree never goes blank about
 * where you are while these addresses still exist.
 */
function UnhomedDestinations({ pages, activeTo }: { pages: NavPage[]; activeTo?: string }) {
  const { pathname } = useLocation();
  const [overridden, setOverridden] = useState<boolean | null>(null);
  const isHere = (p: NavPage) =>
    p.to === activeTo || (p.end ? pathname === p.to : pathname === p.to || pathname.startsWith(`${p.to}/`));
  const open = overridden ?? pages.some(isHere);
  return (
    <div className="loom-atlas-unhomed">
      <details open={open} data-testid="atlas-unhomed"
        onToggle={(e) => setOverridden(e.currentTarget.open)}>
        <summary className="loom-atlas-unhomed-summary">
          <span className="loom-atlas-unhomed-caret" aria-hidden>▸</span>
          Not yet re-homed
          <span className="loom-atlas-nodemeta">{pages.length}</span>
        </summary>
        <ul className="loom-atlas-unhomed-list">
          {pages.map((p) => (
            <li key={p.to}>
              {/* A plain <Link>, not a NavLink: `a.loom-atlas-node.is-active` is the frame's "you are
                  on this NODE" signal, and these are not nodes. `is-here` is a separate, weaker mark
                  that says only "this address is the one showing". */}
              <Link to={p.to} data-testid={`atlas-unhomed-${p.to}`}
                className={`loom-atlas-unhomed-link${isHere(p) ? " is-here" : ""}`}>
                <span className="loom-atlas-ico" aria-hidden><NavIcon to={p.to} /></span>
                <span className="loom-atlas-lbl">{p.label}</span>
              </Link>
            </li>
          ))}
        </ul>
        {/* Inside the disclosure, not beside it: four lines of muted explanation standing open under
            the hierarchy is exactly the kind of permanent chrome the 244px rail cannot spare. A
            reader who opens the hatch is the one asking why these are here. */}
        <p className="loom-atlas-unhomed-note">
          These move onto the Workspace and project nodes as tabs. Until then they keep their own
          addresses, here and in the command palette.
        </p>
      </details>
    </div>
  );
}

export function AtlasTree({ activeTo }: { activeTo?: string } = {}) {
  const pages = useVisibleNavPages();
  const { workspace, project } = splitByDepth(pages);
  const { projectId, setProjectId, projects } = useActiveProject();

  // Which branches are OPEN. Selection auto-opens its own branch (that is what a reader asked for by
  // scoping to it), so the map holds only the rows a reader has since overridden by hand — an absent
  // entry falls back to "open iff selected" rather than to a blanket default, which is what keeps a
  // freshly-selected project from needing a second click to look into.
  const [openBranches, setOpenBranches] = useState<Record<string, boolean>>({});
  const isExpanded = (id: string) => openBranches[id] ?? id === projectId;
  const toggleBranch = (id: string) =>
    setOpenBranches((prev) => ({ ...prev, [id]: !(prev[id] ?? id === projectId) }));
  const selectProject = (id: string) => {
    setProjectId(id);
    setOpenBranches((prev) => ({ ...prev, [id]: true }));
  };

  // ── Row metrics, all off query keys some other surface already fills ─────────────────────────────
  // `["allSessions"]` is ActiveProjectProvider's own; `useAttention()` is mounted app-wide by App.tsx
  // for BOTH shells; `["agents", id]` and `["board", id]` are what pages/ProjectHome.tsx reads. So the
  // tree adds no poll of its own and can never disagree with the number the page below it shows.
  const sessionsQ = useQuery({ queryKey: ["allSessions"], queryFn: api.allSessions });
  const { items: attention } = useAttention();
  const agentsQ = useQuery({
    queryKey: ["agents", projectId], queryFn: () => api.agents(projectId), enabled: !!projectId,
  });
  const boardQ = useQuery({
    queryKey: ["board", projectId], queryFn: () => api.board(projectId), enabled: !!projectId,
    staleTime: 30_000,
  });

  const liveByProject = useMemo(() => liveCountsByProject(sessionsQ.data), [sessionsQ.data]);
  // The SAME population WorkspaceHome's "needs you" KPI counts (every attention item, notices
  // included), keyed by the item's own authoritative `projectId` — so a project row and that project's
  // own node agree on the figure instead of each applying its own idea of what counts.
  const needsByProject = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of attention) {
      if (!item.projectId) continue;
      counts.set(item.projectId, (counts.get(item.projectId) ?? 0) + 1);
    }
    return counts;
  }, [attention]);
  // Live operators whose lifecycle the Platform node owns — read off the ONE OPERATOR_HOME map in
  // lib/atlasAgents, so "is this the Platform node's business" is answered in exactly one place. A
  // companion is an operator too but is managed from /companion, which is why `home.to` is the filter
  // rather than the role.
  const platformLive = useMemo(
    () => standingOperators(sessionsQ.data).filter((o) => o.home.to === "/platform").length,
    [sessionsQ.data],
  );
  const agentCount = agentsQ.data?.length ?? 0;
  const openCards = useMemo(
    () => boardRollup(boardQ.data?.columns, boardQ.data?.tasks).open,
    [boardQ.data],
  );

  const platformNodes = workspace.filter((p) => WORKSPACE_TIER_NODES.includes(p.to));
  // What is left of the hatch. Card 41eab0eb re-homed seven of card 0d0c6cee's ten as Workspace node
  // tabs — DERIVED by subtracting that declaration rather than by a second list here, so the hatch
  // shrinks on its own as the remaining cards land. Card 25c08fba took Terminals the other way, down
  // to project depth as the PROJECT node's Sessions tab, so `splitByDepth` no longer leaves it in
  // `workspace` for this filter to see at all. Two are still waiting: Mission Control and Projects,
  // which card 5afd71bd retires outright. The disclosure goes with the last of them.
  const unhomed = workspace.filter((p) => !WORKSPACE_TIER_NODES.includes(p.to) && !workspaceNodeTabFor(p.to));

  /**
   * The surfaces WITHIN one project node. Built per project, so a reader can open a branch they are
   * not scoped to and see the real shape of it.
   *
   * Only the SELECTED project's rows carry metrics: every figure here comes from a `projectId`-keyed
   * cache entry the active project's own pages already fill, and widening that to N projects would
   * mean N board reads and N agent reads on every Atlas page — a poll per project per row for counts
   * that cards 25c08fba (project node tabs) and the KPI strip card are about to own anyway. An absent
   * metric is honest; an approximated one is not.
   *
   * Metrics stop at Agents and Board for the same reason: Memory, Runs and Archive have no cache a
   * shell-mounted component already shares, and three more polls for rows card 25c08fba deletes is
   * cost without a reader.
   */
  const scopedNodes = (p: Project, selected: boolean): ReactNode[] => {
    // The SELECTED branch keeps the original, unqualified test ids — every spec in the suite addresses
    // the landed node by them, and "the node you are on" is still exactly one element. A row in
    // another branch is a different element for the same destination, so it gets its own stem, with
    // the project id spliced in where a reader of the id would look for it.
    const nodeId = (to: string) => (selected ? `atlas-node-${to}` : `atlas-node-${p.id}${to}`);
    const homeId = (key: string) => (selected ? `atlas-home-${key}` : `atlas-home-${p.id}-${key}`);
    // Clicking into a branch you are not scoped to re-scopes to it first: the page it lands on reads
    // the ACTIVE project, so navigating without this would render another project's data under a row
    // that named this one. Nothing to do when the row is already the selected branch's.
    const scopeFirst = selected ? undefined : () => selectProject(p.id);
    return [
      <HomeNode key={PROJECT_HOME.to} home={PROJECT_HOME} active={selected} onNavigate={scopeFirst}
        testId={homeId(PROJECT_HOME.key)} />,
      <HomeNode key={AGENTS_NODE.to} home={AGENTS_NODE} active={selected} onNavigate={scopeFirst}
        testId={homeId(AGENTS_NODE.key)}
        metric={selected && agentCount > 0
          ? <NodeMeta value={agentCount} title={`${agentCount} agent${agentCount === 1 ? "" : "s"} defined`} />
          : undefined}
        trailing={selected
          ? <AgentsQuickSpawn projectId={p.id} projectName={p.name} />
          : undefined} />,
      ...project.map((page) => (
        <TreeNode key={page.to} page={page} activeTo={activeTo} active={selected} onNavigate={scopeFirst}
          testId={nodeId(page.to)} label={projectRowLabel(page)}
          metric={selected && page.to === "/board" && openCards > 0
            ? <NodeMeta value={openCards} title={`${openCards} open card${openCards === 1 ? "" : "s"}`} />
            : undefined} />
      )),
    ];
  };

  return (
    <nav className="loom-atlas-tree" aria-label="Primary navigation" data-testid="atlas-tree">
      <div className="loom-atlas-treehead">
        <Logo size={20} />
      </div>

      <div className="loom-atlas-treebody">
        <SectionLabel style={{ margin: "0 0 4px", padding: "0 10px" }}>Workspace</SectionLabel>
        <ul className="loom-atlas-nodes">
          <HomeNode home={WORKSPACE_HOME} testId={`atlas-home-${WORKSPACE_HOME.key}`} />
          {/* Pinned directly above the project list, as the mockup's own note says it is: "the
              reserved Platform home is pinned above the project list in the tree, not inside it". */}
          {platformNodes.map((p) => (
            <TreeNode key={p.to} page={p} activeTo={activeTo} testId={`atlas-node-${p.to}`}
              metric={platformLive > 0
                ? <NodeMeta value={`${platformLive} live`} title={`${platformLive} live operator session${platformLive === 1 ? "" : "s"}`} />
                : undefined} />
          ))}
        </ul>

        {/* Plural, and plural even at one project: the label names the kind of node under it, the way
            "Workspace" above does, not how many there happen to be today. */}
        <SectionLabel style={{ margin: "18px 0 4px", padding: "0 10px" }}>Projects</SectionLabel>
        {projects.length === 0 ? (
          <>
            {/* Nothing to select, so nothing here pretends to be selectable — the row stays the plain
                label it was before selection existed. The surfaces stay reachable beneath it: every one
                renders with no project resolved today (each has its own empty state). */}
            <div className="loom-atlas-node is-branch is-open" data-testid="atlas-project-node">
              <span className="loom-atlas-twist" aria-hidden>▸</span>
              <span className="loom-atlas-ico" aria-hidden><NavIcon to="/projects" /></span>
              <span className="loom-atlas-lbl">No project</span>
            </div>
            <ul className="loom-atlas-nodes is-kids">
              {scopedNodes({ id: "", name: "No project" } as Project, true)}
            </ul>
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
          // The SELECTED branch is ALWAYS the id ActiveProjectProvider resolved — never a tree-local
          // guess — or the rows under it would claim a scope the pages themselves don't have. That is
          // total by construction (the provider only yields "" when the workspace holds no projects at
          // all, which is the branch above).
          <ul className="loom-atlas-nodes">
            {projects.map((p) => {
              const selected = p.id === projectId;
              const live = liveByProject.get(p.id) ?? 0;
              const needs = needsByProject.get(p.id) ?? 0;
              return (
                <ProjectNode key={p.id} project={p} selected={selected} expanded={isExpanded(p.id)}
                  onSelect={selectProject} onToggle={toggleBranch}
                  metrics={
                    <>
                      {needs > 0 && (
                        <NodeBadge count={needs}
                          title={`${needs} item${needs === 1 ? "" : "s"} needing you in ${p.name}`} />
                      )}
                      {/* The rail chip's dropdown already showed exactly this count, and it is the one
                          thing a reader would lose when selection moved from a dropdown to the tree —
                          so it comes along, derived the SAME way from the SAME shared cache entry. */}
                      {live > 0 && (
                        <span className="loom-atlas-live" title={`${live} live session${live === 1 ? "" : "s"}`}>
                          {live}
                          <span className="loom-atlas-livedot" aria-hidden />
                        </span>
                      )}
                    </>
                  }>
                  <ul className="loom-atlas-nodes is-kids">{scopedNodes(p, selected)}</ul>
                </ProjectNode>
              );
            })}
          </ul>
        )}

        <UnhomedDestinations pages={unhomed} activeTo={activeTo} />
      </div>
    </nav>
  );
}
