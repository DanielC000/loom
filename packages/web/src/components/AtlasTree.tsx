// The Atlas entity tree — cards 8cbb2ac2 (P1-1, a node per nav destination), e47df20a (P1-4, the
// project tier becomes the active-project selector) and 0d0c6cee (the tree becomes an ENTITY
// hierarchy: projects, not pages). Visual language: the round-4 V2 mockup's tree
// (Mockups/2026-10-19 UI Overhaul Round 4 — `index.html`'s `<aside class="tree">` markup and
// `atlas.css`'s `.node*` rules). Chrome lives in styles/global.css (.loom-atlas-node*): structure
// here, colour there.

// A <nav>, not an <aside>: with real nodes in it this IS the app's primary navigation (P1-0 Code
// Review finding, carried on P1-1).
//
// Keyboard (card fa8a2887): the tree is ONE Tab stop with the tree-view arrow keys, the same
// roving-tabindex approach as the board (lib/boardFocus.ts, card 591fe6ed). Every row control is
// marked `data-atlas-tree-item` and the order is read off the DOM at keypress time, so it can never
// disagree with what is rendered. ↑↓ move, Home/End jump, → expands then steps into the first child,
// ← collapses then steps out to the parent, Enter activates the row natively. The twists leave the
// Tab order (→← replace them); a project row's `＋` stays reachable, but only on the row holding the
// stop. Rows keep their native link/button roles: specs and screen readers both address them that way.
//
// @decision fa8a2887 — one Tab stop for the whole tree; never put a twist or a non-current `＋` back
// in the Tab order, or the stop count grows with the project count again.

// ⛔ Every tier is DERIVED — projects from ActiveProjectProvider's own list, destinations from
// src/nav.tsx. A hand-copied list shows a node for a page that no longer exists, or silently drops a
// new one; a second Atlas-only idea of which project is active would mis-scope the pages below it.

// @decision 0d0c6cee — expansion is not selection; a non-selected branch's rows are plain <Link>s
// with project-qualified test ids and re-scope BEFORE they navigate; no row metric may add an
// `api.ts` member or a per-project query.

// @decision 3b563642 — a session ENTITY row carries `data-atlas-entity` and is never a destination;
// each sub-tier owns its own expansion state, never `openBranches`.

// @decision ec1aa18e — a declared PROJECT_NODE_TABS destination is never a tree row; the project's
// Home row carries the landed mark for all of them, as the Workspace home does for its own tabs. The
// project tier is ordered running-first, alphabetical within each group (lib/projectOrder).
import {
  createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type FocusEvent, type KeyboardEvent, type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { useQueries, useQuery } from "@tanstack/react-query";
import { CONTEXT_WARN_RATIO, contextWindowForModel, type Project, type QuestionInboxItem, type SessionListItem } from "@loom/shared";
import {
  ATLAS_HOMES, PROJECT_NODE_PATH, PROJECT_NODE_TABS, isRehomedProjectTab, projectNodeTabAt,
  WORKSPACE_NODE_TABS, projectTabPath, useVisibleNavPages, workspaceNodeTabOf, workspaceTabHref,
  type AtlasHome, type NavPage,
} from "../nav";
import { AgentsQuickSpawn } from "./atlasAgents";
import { GatePair } from "./atlasHome";
import { SetupWizard } from "./SetupWizard";
import { NavIcon } from "./navIcons";
import { Logo } from "./Logo";
import { SectionLabel } from "./ui";
import { useActiveProject } from "../lib/activeProject";
import { useAttention } from "../lib/attention";
import { gateLanes, gatePairWords, isLiveSession, liveCountsByProject, useGatesActive } from "../lib/atlasHome";
import { sortProjectsRunningFirst } from "../lib/projectOrder";
import { standingOperators } from "../lib/atlasAgents";
import { groupSessionRows, isCompanionSession, sessionRowSuffixes } from "../lib/sessions";
import { workspaceRunningSessions } from "../lib/workspaceSessions";
import { api } from "../lib/api";
import { color, fs } from "../theme";

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
// re-homed project tab — read off the same PROJECT_NODE_TABS declaration the node and the frame read.
//
// 🔴 NO DESTINATION AT PROJECT DEPTH IS A TREE ROW ANY MORE (card 4a0ad464). Card ec1aa18e took the
// rows for the destinations the project node carries as TABS — the sidebar would otherwise be a
// second copy of the tab row one click away — and left two page rows standing: `Home` (the node's own
// address) and `Overview`. The owner read BOTH as the same redundancy, verbatim: "projects tree on
// the sidebar show the pages instead of the running agent. We have the pages as tabs now. I doubt we
// need to have the tabs for each project in the sidebar too." So a project branch now holds ONLY what
// is RUNNING in it, and this function keeps the one job it still has: which destinations belong to
// the WORKSPACE tier. The depth test is unchanged — it is still what keeps `/terminals` (an unscoped
// page the project node carries as its Sessions tab) out of that tier.
//
// ⚠️ `/overview` is left with no Atlas NAVIGATION at all — neither a tab nor a row. It is now just a
// redirect (card acbb6df6 made Atlas the only shell). Why it was not retired onto
// the project node instead, and what that would cost, is in card 4a0ad464's record.
//
// @decision 4a0ad464 — a project branch holds entities, never pages. Don't re-add a row for a
// project-depth destination; put the surface on the node's tab row instead.
function workspaceTierPages(pages: NavPage[]): NavPage[] {
  const isProjectTab = (to: string) =>
    PROJECT_NODE_TABS.some((t) => isRehomedProjectTab(t) && projectTabPath(t) === to);
  const atProjectDepth = (p: NavPage) => !!p.scoped || isProjectTab(p.to);
  return pages.filter((p) => !atProjectDepth(p));
}

// The ONE god-eye destination that stays a WORKSPACE-TIER NODE rather than becoming a tab: the
// reserved Platform home. The mockup pins it directly above the project list (its own `NODES.platform`
// row, `crumbs: ["root"]`) because it is a sibling ENTITY of the projects — a home with its own agents
// — not a surface OF the workspace. Every other unscoped destination is a Workspace-node TAB in the
// mockup (`ROOT_TABS`): card 41eab0eb built seven of them — `WORKSPACE_NODE_TABS` in src/nav.tsx, the
// "which node tab does this become" field card 0d0c6cee could not yet guess — and card 25c08fba took
// `/terminals` down to PROJECT depth as the project node's Sessions tab, so it is no longer an
// unscoped destination this tier places at all. The last two, Mission Control and Projects, are
// RETIRED (card 5afd71bd, `ATLAS_RETIREMENTS` in src/nav.tsx), so this list plus the tier's two
// ATLAS_HOMES rows — the Workspace home and card b439c2dc's Terminals node — is the whole tier, and
// card 0d0c6cee's "Not yet re-homed" escape hatch is gone with them.
//
// A one-entry literal rather than a `nav.tsx` field of its own: this stays the single placement
// judgement card 0d0c6cee made, and nothing since has needed a second entry. ⚠️ An ATLAS_HOMES row
// at this tier is NOT reachable through here — this list filters NAV_PAGES, and an Atlas-only
// address has no NAV_PAGES row to find. `WORKSPACE_TERMINALS` below is resolved the way
// `WORKSPACE_HOME` is instead; don't add such an address here expecting a row.
//
// @decision 5afd71bd — the hatch is gone, so an unscoped destination named in none of this list,
// `WORKSPACE_NODE_TABS` or `ATLAS_RETIREMENTS` is simply ABSENT from the tree. Decide its placement in
// one of the three; never re-add a fallback row.
const WORKSPACE_TIER_NODES = ["/platform"];

/** A right-aligned metric on a row — the mockup's `.node-meta` (muted, 10.5px). */
function NodeMeta({ value, title, tone }: { value: ReactNode; title: string; tone?: "attn" }) {
  return (
    <span className={`loom-atlas-nodemeta${tone === "attn" ? " is-attn" : ""}`} title={title}>{value}</span>
  );
}

/** The mockup's `.node-badge` — an amber attention count, deliberately louder than a plain metric. */
function NodeBadge({ count, title }: { count: number; title: string }) {
  return (
    <>
      <span className="loom-atlas-nodebadge" title={title} aria-hidden>{count}</span>
      <SrPart>{`${count} need${count === 1 ? "s" : ""} you`}</SrPart>
    </>
  );
}

/**
 * A badge's words for a screen reader, with the comma that separates it from the row's name (card
 * 73b41b5d, Atlas audit A-19). A row's badges sit INSIDE its button, so their text joins the button's
 * accessible name, and bare digits read as part of the name ("AUDIT-Alpha Storefront32"). The badge
 * itself goes aria-hidden; this sibling carries what it means. An `aria-label` on the badge would not do
 * it: a plain span has no role that takes one.
 */
function SrPart({ children }: { children: string }) {
  return <span className="loom-sr-only">{`, ${children}`}</span>;
}

// ── Roving focus (card fa8a2887) ─────────────────────────────────────────────────────────────────
// The id of the ONE row holding the tree's Tab stop. AtlasTree resolves it against the rendered DOM
// after every render (see `useLayoutEffect` there); each row only asks "is it me".
const TREE_ITEM_ATTR = "data-atlas-tree-item";
const TreeStopContext = createContext<string | null>(null);

/** The props that make one row control a roving-tabindex item. */
function useTreeItem(id: string) {
  const stop = useContext(TreeStopContext);
  return { [TREE_ITEM_ATTR]: id, tabIndex: stop === id ? 0 : -1 } as const;
}

/** Every row control the tree renders, in document (= visual) order. */
function treeItems(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(`[${TREE_ITEM_ATTR}]`)];
}

/** The twist that opens and closes a row, when it has one: its sibling in the same flex row. */
function rowTwist(item: HTMLElement): HTMLButtonElement | null {
  const row = item.parentElement;
  if (!row?.classList.contains("loom-atlas-noderow")) return null;
  return row.querySelector<HTMLButtonElement>(":scope > .loom-atlas-twistbtn");
}

const TREE_KEYS: ReadonlySet<string> = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"]);

/** What a row needs to draw a working twist. `fallback` is its state before anyone has touched it. */
interface Twist {
  expanded: boolean;
  onToggle: () => void;
  /** The accessible name — "Expand X" / "Collapse X", so the control says what it will do. */
  label: string;
  testId: string;
}

// The twist on a row whose link is an <a> — a manager with workers, the Board with cards.
//
// It is a SIBLING of the anchor, never a child: a <button> inside an <a> is invalid HTML, the
// browser closes the anchor at the inner tag, and the control is unreachable by the keyboard
// (card 318b5a21's rule, anchored on ProjectNode below — the same one, one tier up).
//
// But unlike that one it is laid out OVER the anchor's own reserved twist column rather than hoisted
// out in front of it. The project row could afford to restructure: it is a <button> whose "you are
// inside this branch" edge belongs at the rail's left edge anyway. An entity or destination row is
// an <a> that must keep its own 2px left border — that border IS the phosphor landed edge, and it
// has to sit at the same x as every sibling row's. Overlaying keeps the anchor structurally
// identical to a childless row (so every label in the tier stays on one text origin) and still
// leaves the button a real sibling. It is out of the Tab order (card fa8a2887): → and ← on the row do
// its job from the keyboard.
function TwistButton({ twist }: { twist: Twist }) {
  return (
    <button type="button" tabIndex={-1} className={`loom-atlas-twistbtn${twist.expanded ? " is-expanded" : ""}`}
      aria-expanded={twist.expanded} aria-label={twist.label} title={twist.label}
      data-testid={twist.testId} onClick={twist.onToggle}>
      <span aria-hidden>▸</span>
    </button>
  );
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
function TreeNode({ page, activeTo, active = true, testId, metric, onNavigate, children }: {
  page: NavPage;
  activeTo?: string;
  active?: boolean;
  testId: string;
  metric?: ReactNode;
  onNavigate?: () => void;
  children?: ReactNode;
}) {
  const item = useTreeItem(`node:${testId}`);
  const body = (
    <>
      {/* A DESTINATION's twist column is reserved and blank: there is nothing under a destination to
          open, so a triangle here would promise an affordance that isn't there. The width is held
          anyway, so every label sits on one text origin. (A PROJECT row draws a real one — see
          ProjectNode: it has children and genuinely opens and closes; so does a manager session row,
          whose own button is laid OVER this column rather than replacing it.) */}
      <span className="loom-atlas-twist" aria-hidden />
      <span className="loom-atlas-ico" aria-hidden><NavIcon to={page.to} /></span>
      <span className="loom-atlas-lbl">{page.label}</span>
      {metric}
    </>
  );
  const link = active
    ? (
      /* `activeTo` is for an address the ROUTER cannot resolve to this node by path: a detail row
         lives at its own URL (/question/:id under the Inbox node), so NavLink's own isActive is
         false there even though the frame's crumbs and heading both name this node. Without it the
         tree would be the one part of the frame disagreeing about where you are. */
      <NavLink to={page.to} end={page.end} onClick={onNavigate}
        className={({ isActive }) => `loom-atlas-node${isActive || page.to === activeTo ? " is-active" : ""}`}
        data-testid={testId} {...item}>
        {body}
      </NavLink>
    )
    : (
      <Link to={page.to} onClick={onNavigate} className="loom-atlas-node" data-testid={testId} {...item}>
        {body}
      </Link>
    );
  return (
    <li>
      {link}
      {children}
    </li>
  );
}

// ── The ENTITY tier (card 3b563642) ──────────────────────────────────────────────────────────────
// The approved round-4 design's tree is four levels deep, and its fourth level is not a page: it is
// an ENTITY. `atlas.js`'s own tree reads `Loom › Orchestrator › (Web Designer, Dev, Bugfix, QA
// Tester)` — a worker session under the manager that dispatched it.
//
// Its sibling tier, an open board card under the Board row, went with the Board's own row (card
// ec1aa18e) — the cards live on the node's Board tab now.
//
// An entity row is marked `data-atlas-entity` because it is NOT a destination, and three specs
// police the tree's destination set by partitioning every `src/nav.tsx` address into node / hatch /
// node tab. An address minted per ROW is in none of those three, so without the mark those
// collectors would have to grow a per-session exemption list — which is exactly the kind of
// hand-named list that goes stale. The attribute lets them keep asking their own question.

/**
 * One entity row. Structurally the same anchor a destination row renders — same reserved twist
 * column, same icon slot, same label and metric — so a session lands on the identical text origin as
 * the `Home` row above it and the tier reads as one list.
 *
 * The icon slot takes a STATUS DOT rather than a nav glyph, which is the mockup's own treatment
 * (`● Web Designer 10%`): a destination is a place and has a shape, an entity is a thing and has a
 * state.
 */
function EntityRow({ entity, to, testId, label, sub, title, dot, metric, active, activeTo, twist, onNavigate, children }: {
  entity: "session";
  to: string;
  testId: string;
  label: string;
  /** What tells this row apart from a same-named sibling (lib/sessions' `sessionRowSuffixes`), muted. */
  sub?: string;
  /** The row's full identity on hover — the rail ellipsises hard at 244px. */
  title: string;
  dot: ReactNode;
  metric?: ReactNode;
  active?: boolean;
  activeTo?: string;
  twist?: Twist;
  onNavigate?: () => void;
  children?: ReactNode;
}) {
  const item = useTreeItem(`node:${testId}`);
  const body = (
    <>
      <span className="loom-atlas-twist" aria-hidden />
      <span className="loom-atlas-ico" aria-hidden>{dot}</span>
      {/* The suffix rides INSIDE the label so the one ellipsis truncates the pair as a phrase, and it
          is part of the link's accessible name — a screen reader needs the difference as much as an eye. */}
      <span className="loom-atlas-lbl">{label}{sub && <span className="loom-atlas-lblsub"> · {sub}</span>}</span>
      {metric}
    </>
  );
  const link = active
    ? (
      <NavLink to={to} end onClick={onNavigate} title={title} data-testid={testId} data-atlas-entity={entity}
        className={({ isActive }) => `loom-atlas-node${isActive || to === activeTo ? " is-active" : ""}`} {...item}>
        {body}
      </NavLink>
    )
    : (
      <Link to={to} onClick={onNavigate} title={title} data-testid={testId} data-atlas-entity={entity}
        className="loom-atlas-node" {...item}>
        {body}
      </Link>
    );
  return (
    <li>
      {twist ? <div className="loom-atlas-noderow is-twistrow"><TwistButton twist={twist} />{link}</div> : link}
      {children}
    </li>
  );
}

/**
 * A session row's status dot: amber = taking a turn right now, phosphor = live and idle, muted =
 * neither. Three tones because three is what a reader is actually asking of a fleet — and the same
 * three the rest of the app already answers it with (`StatusPill` on the session node head, the
 * live dot on a project row).
 */
function SessionDot({ s }: { s: SessionListItem }) {
  return <span className={`loom-atlas-entdot is-${s.busy ? "work" : isLiveSession(s) ? "live" : "idle"}`} aria-hidden />;
}

/**
 * A session row's metric: context occupancy, and only that.
 *
 * The mockup reads `gen 412` on its manager row and `10% / 71% / 28%` on its workers, which is two
 * rules for one column. One is enough, and this is the one: the generation now sits on the session
 * NODE HEAD (card 5968d7e0's `gen · turns` pill), so a 244px rail that repeated it would spend its
 * single metric column restating what the node already says. Context is the scarce resource — it is
 * what decides which session gets recycled next — and it is the figure the mockup itself puts on
 * four of its five session rows.
 *
 * Amber at the same `CONTEXT_WARN_RATIO` the node head's own meter turns on, so the rail and the
 * node can never disagree about when a session is getting heavy.
 */
function sessionMetric(s: SessionListItem): ReactNode {
  const ctx = s.ctxInputTokens ?? 0;
  const window = contextWindowForModel(s.model);
  if (ctx <= 0 || window <= 0) return undefined;
  const pct = Math.round((ctx / window) * 100);
  return (
    <NodeMeta value={`${pct}%`} tone={ctx > window * CONTEXT_WARN_RATIO ? "attn" : undefined}
      title={`${(ctx / 1000).toFixed(1)}k of ${Math.round(window / 1000)}k context used`} />
  );
}

// An Atlas-only node — a tier's own HOME. The WORKSPACE root is the only one left: it is a LEAF row
// rather than the "Workspace" heading made clickable, because that heading names a GROUP (card
// fd99b2d7). The PROJECT tier no longer has one — card 4a0ad464 removed its `Home` row as a page row
// the node's own tab row already carries, and gave the project row itself the node's address, which
// is exactly the "one control, two jobs" card e47df20a avoided. The owner asked for the row to go
// anyway, so the two jobs are now deliberate and `selectAndOpenProject` is where they are reconciled.
//
// `trailing` rides OUTSIDE the link, as a sibling in the same row: a button nested inside an anchor is
// invalid HTML and unreachable by the keyboard, which is exactly what the quick-spawn `＋` must not be.
function HomeNode({ home, testId, active = true, landed, trailing, metric, onNavigate }: {
  home: AtlasHome;
  testId: string;
  active?: boolean;
  /** Overrides the path match. The Workspace home needs it since card 291cc8aa: `/home?tab=inbox` is
   *  the Inbox ROW's address, and a path-only match would mark Home as landed there too. */
  landed?: boolean;
  trailing?: ReactNode;
  metric?: ReactNode;
  onNavigate?: () => void;
}) {
  const item = useTreeItem(`node:${testId}`);
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
      {/* A plain <Link> under an override, never a NavLink with a forced class: NavLink writes its own
          `aria-current="page"` from the path match, which the class alone cannot take back. */}
      {active && landed !== undefined
        ? (
          <Link to={home.to} onClick={onNavigate} className={`loom-atlas-node${landed ? " is-active" : ""}`}
            aria-current={landed ? "page" : undefined} data-testid={testId} {...item}>
            {body}
          </Link>
        )
        : active
        ? (
          <NavLink to={home.to} end={false} onClick={onNavigate}
            className={({ isActive }) => `loom-atlas-node${isActive ? " is-active" : ""}`}
            data-testid={testId} {...item}>
            {body}
          </NavLink>
        )
        : <Link to={home.to} onClick={onNavigate} className="loom-atlas-node" data-testid={testId} {...item}>{body}</Link>}
      {trailing}
    </li>
  );
}

const WORKSPACE_HOME = ATLAS_HOMES.find((h) => h.key === "workspace")!;

/**
 * The Workspace node tabs that ALSO get a row in the tree's Workspace group — card 291cc8aa, the
 * owner: "make inbox and gates pages own menu points under Workspace." Keys into WORKSPACE_NODE_TABS,
 * so the label and the source address come from that one declaration.
 *
 * A row here is a SHORTCUT to the tab, not a second placement of the destination: its href is the
 * tab's own `/home?tab=<key>` address, and the tab stays on the Workspace node. That is why
 * atlas-tree.spec.ts's one-placement partition (it collects tree rows by PATHNAME) still holds.
 */
const WORKSPACE_TAB_ROWS = ["inbox", "gates"] as const;

/** One Workspace-tab row. The same anchor body every destination row draws, so its label sits on the
 *  tier's one text origin. Landed when the address IS its tab, or a detail row hangs under its source
 *  address (`/question/:id` is "under /inbox"), which no path match can see. */
function WorkspaceTabNode({ to, icon, label, landed, testId, metric }: {
  to: string;
  icon: string;
  label: string;
  landed: boolean;
  testId: string;
  metric?: ReactNode;
}) {
  const item = useTreeItem(`node:${testId}`);
  return (
    <li>
      <Link to={to} className={`loom-atlas-node${landed ? " is-active" : ""}`}
        aria-current={landed ? "page" : undefined} data-testid={testId} {...item}>
        <span className="loom-atlas-twist" aria-hidden />
        <span className="loom-atlas-ico" aria-hidden><NavIcon to={icon} /></span>
        <span className="loom-atlas-lbl">{label}</span>
        {metric}
      </Link>
    </li>
  );
}

/**
 * The Workspace tier's Terminals node — card b439c2dc, the owner's own placement: "In the left
 * sidebar place it between home and Platform."
 *
 * A SECOND Atlas-only home row at this tier, which `WORKSPACE_TIER_NODES` above cannot carry: that
 * list filters NAV_PAGES, and this address is an ATLAS_HOMES row (there is no classic-rail twin to
 * filter — the classic rail keeps its own `/terminals`). So it is resolved the way the Workspace
 * home itself is, from the one declaration in src/nav.tsx, and rendered between the two.
 */
const WORKSPACE_TERMINALS = ATLAS_HOMES.find((h) => h.key === "workspace-terminals")!;

// One project row — cards e47df20a (P1-4) and 0d0c6cee. A real control: clicking it writes the active
// project to the SAME ActiveProjectProvider the rail chip writes and every `scoped` page reads, so a
// tree selection and a chip selection are indistinguishable downstream. There is deliberately no
// second Atlas-only notion of "which project" to keep in step.
//
// Still a <button>, not a link, though card 4a0ad464 made it navigate as well as scope. Two reasons
// it stays a button: it does NOT always navigate (on one of the node's own tabs it only re-scopes —
// see `selectAndOpenProject`), so an href would promise a destination it sometimes declines to go to;
// and SCOPING, not navigation, is still the job it is named for — `aria-current` and `is-open` are
// what "the branch you are inside" has meant since P1-4 and both still mean it.
//
// @decision 4a0ad464 — this row is the project node's ONLY address in the tree now. Don't take the
// navigation back out without putting a `Home` row back, and don't make it unconditional.
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
/**
 * The project name wins width over the row's counts (card eb516fba, audit B-22): a project row whose
 * name the counts would clip goes `is-compact`, where the live count shows its dot alone and the
 * "needs you" badge becomes a small attention dot. The numbers are never lost — both stay in the
 * row's screen-reader text and each mark's own `title`.
 *
 * Measured, not guessed, and one-way per input: the row is drawn in FULL mode, and only if its label
 * is then clipped does it flip to compact. It is re-measured (from full) only when its name, its counts
 * or the BUTTON's width change — and the button's width does not depend on the mode, so going compact
 * can never feed back into the measurement that chose it.
 */
function useNameWinsWidth(name: string, metricsKey: string) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState(0);
  const [compactFor, setCompactFor] = useState<string | null>(null);
  const key = `${name}|${metricsKey}|${width}`;
  useEffect(() => {
    const el = buttonRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setWidth(Math.round(el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (compactFor === key) return;
    const lbl = labelRef.current;
    if (!lbl || width === 0) return;
    if (lbl.scrollWidth > lbl.clientWidth + 1) setCompactFor(key);
  }, [key, compactFor, width]);
  return { buttonRef, labelRef, on: compactFor === key };
}

function ProjectNode({ project, selected, expanded, metrics, metricsKey = "", onSelect, onToggle, children }: {
  project: Project;
  selected: boolean;
  expanded: boolean;
  metrics?: ReactNode;
  /** What the counts in `metrics` currently say — a change re-measures whether the name still fits. */
  metricsKey?: string;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  children?: ReactNode;
}) {
  const twistLabel = `${expanded ? "Collapse" : "Expand"} ${project.name}`;
  const item = useTreeItem(`project:${project.id}`);
  const compact = useNameWinsWidth(project.name, metricsKey);
  return (
    <li>
      {/* `is-open` is mirrored onto the ROW as well as the selector: the phosphor edge has to sit at
          the rail's own left edge, and with the twist hoisted out of the button the button no longer
          starts there. The class stays on the button too — that is what "the branch you are inside"
          has meant since P1-4, and what atlas-project-selection.spec.ts reads. */}
      <div className={`loom-atlas-noderow is-branchrow${selected ? " is-open" : ""}`}>
        <button type="button" tabIndex={-1} className={`loom-atlas-twistbtn${expanded ? " is-expanded" : ""}`}
          aria-expanded={expanded} aria-label={twistLabel} title={twistLabel}
          data-testid={`atlas-project-twist-${project.id}`}
          onClick={() => onToggle(project.id)}>
          <span aria-hidden>▸</span>
        </button>
        {/* `data-testid` marks only the SELECTED row: "the project node you are under" stays a single
            element, so P1-1's own structural assertion keeps meaning what it meant. The other rows are
            addressed by their accessible name (the project's own), which is what a reader clicks. */}
        <button type="button" ref={compact.buttonRef}
          className={`loom-atlas-node is-branch${selected ? " is-open" : ""}${compact.on ? " is-compact" : ""}`}
          data-testid={selected ? "atlas-project-node" : undefined}
          aria-current={selected ? "true" : undefined}
          title={selected ? `${project.name} · active project` : `Scope to ${project.name}`}
          onClick={() => onSelect(project.id)} {...item}>
          <span className="loom-atlas-ico" aria-hidden><NavIcon to="/projects" /></span>
          <span className="loom-atlas-lbl" ref={compact.labelRef}>{project.name}</span>
          {metrics}
        </button>
        {/* On EVERY project row, selected or not — spawning into a project you are not scoped to
            without first re-scoping is the whole reach this control adds over the Agents node's own
            `＋`, which only ever sees the selected one. It is `projectId`-addressed, never
            active-project-addressed, so a spawn from here lands where the row says it will.
            Its own testid stem (`atlas-project-quickspawn-<id>`): a workspace has many project rows,
            so the Agents node's shared `atlas-quickspawn-open` would resolve N elements.
            In the Tab order only while this row holds the tree's stop (card fa8a2887), so the tree
            costs at most two stops however many projects there are. */}
        <AgentsQuickSpawn projectId={project.id} projectName={project.name}
          testId={`atlas-project-quickspawn-${project.id}`} tabIndex={item.tabIndex} />
      </div>
      {expanded && children}
    </li>
  );
}

/**
 * The Projects heading's "New project" `＋` (card 291cc8aa). It wears the project rows' own
 * `.loom-atlas-plus`, so it reads as the control the rows below already teach.
 *
 * A roving tree ITEM, in document order between the Workspace group and the first project: the tree
 * holds ONE Tab stop however many controls it draws (card fa8a2887), and a heading control with a
 * stop of its own would be a second one. ↑/↓ reach it; Enter and Space press it, as on any button.
 */
function NewProjectButton({ onOpen }: { onOpen: () => void }) {
  const item = useTreeItem("new-project");
  return (
    <button type="button" className="loom-atlas-plus" data-testid="atlas-new-project"
      aria-label="New project" title="New project" aria-haspopup="dialog" onClick={onOpen} {...item}>+</button>
  );
}

/** The id AtlasShell's drawer toggle points `aria-controls` at — one constant, so the two can't drift. */
export const ATLAS_TREE_ID = "atlas-tree-drawer";

export function AtlasTree({ activeTo, open = false, onNavigate }: {
  activeTo?: string;
  /** Narrow-viewport drawer state (card 49e883a9). Above the breakpoint the CSS ignores it entirely. */
  open?: boolean;
  /** Called when a click inside the tree actually NAVIGATES — see the delegated handler on the <nav>. */
  onNavigate?: () => void;
} = {}) {
  const pages = useVisibleNavPages();
  const workspace = workspaceTierPages(pages);
  const { projectId, setProjectId, projects } = useActiveProject();
  const navigate = useNavigate();

  // Which project tab the current address selects, if any. ONE resolver (src/nav.tsx's
  // `projectNodeTabAt`), shared with the node and the frame, so the tree cannot disagree with the
  // crumbs about which node an address is on. Read HERE, above the row handlers, because
  // `selectAndOpenProject` below decides whether to navigate from it.
  const { pathname, search } = useLocation();
  const onProjectNodeTab = !!projectNodeTabAt(pathname, search);

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
  /**
   * Clicking a project ROW: scope to it, and — since card 4a0ad464 removed the branch's `Home` row —
   * take the reader to its node, which this row is now the tree's only address for.
   *
   * The rule, stated positively: the row takes you to the project node, EXCEPT where clicking it has
   * real work of its own to do (re-scoping one of the node's own tabs, which is project-agnostic and
   * reads the ACTIVE project). Both halves are asserted in atlas-tree-hierarchy.spec.ts.
   *
   * @decision 4a0ad464 — don't take the navigation out without putting a `Home` row back, and don't
   * make it unconditional: clicking your own row from one of its tabs would then do nothing at all.
   */
  const selectAndOpenProject = (id: string) => {
    const rescopesATabInPlace = onProjectNodeTab && id !== projectId;
    selectProject(id);
    if (rescopesATabInPlace) return;
    navigate(PROJECT_NODE_PATH);
    // A navigation inside the drawer closes it, exactly as an anchor click does. The <nav>'s own
    // delegated handler is gated on `closest("a")` so a BUTTON never closes it — which is correct
    // for the twist and the quick-spawn `＋`, and wrong for a row that now navigates.
    onNavigate?.();
  };

  // The ENTITY tier's own expansion, deliberately a SECOND map (card 3b563642). "Expansion is not
  // selection" holds one level down too: opening a manager to see its workers must not re-scope
  // anything — and a sub-branch keyed into `openBranches` would collide with a project id and make a
  // manager's twist close the project it lives in. It defaults OPEN: a live worker you cannot see is
  // a worker you forget is running.
  const [openSubBranches, setOpenSubBranches] = useState<Record<string, boolean>>({});

  // Opening the drawer moves focus INTO it and brings the landed node into view (card 49e883a9). The
  // second half is the other thing backlog card 9477a5ed asked for: the old narrow strip was capped at
  // 33dvh and ranked projects above sessions, so on a phone the row you were looking at was usually
  // scrolled out of it. A full-height drawer has the room, but only if something actually scrolls to it.
  // `preventScroll` on the focus so the nav does not also yank the page — the scrollIntoView below is
  // the ONE deliberate scroll, and it is scoped to the treebody by `nearest`.
  const navRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const nav = navRef.current;
    if (!nav) return;
    nav.focus({ preventScroll: true });
    nav.querySelector(".loom-atlas-node.is-active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [open]);

  // ── Roving focus (card fa8a2887) ─────────────────────────────────────────────────────────────────
  // `focusId` is the row the user last focused (keyboard or pointer, via the nav's delegated onFocus);
  // `stopId` is that row resolved against what is actually rendered, falling back to the landed row and
  // then the first. Resolved in a LAYOUT effect so a stop whose row just left the DOM moves before paint.
  const [focusId, setFocusId] = useState<string | null>(null);
  const [stopId, setStopId] = useState<string | null>(null);
  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const ids = treeItems(nav).map((el) => el.getAttribute(TREE_ITEM_ATTR)!);
    const landed = nav.querySelector<HTMLElement>(
      `[${TREE_ITEM_ATTR}].is-active, [${TREE_ITEM_ATTR}][aria-current="true"]`)?.getAttribute(TREE_ITEM_ATTR);
    const want = focusId !== null && ids.includes(focusId) ? focusId : landed ?? ids[0] ?? null;
    if (want !== stopId) setStopId(want);
  });
  const stopElement = () => navRef.current?.querySelector<HTMLElement>(`[${TREE_ITEM_ATTR}][tabindex="0"]`) ?? null;
  const onTreeFocus = (e: FocusEvent<HTMLElement>) => {
    const id = (e.target as HTMLElement).getAttribute(TREE_ITEM_ATTR);
    if (id !== null && id !== focusId) setFocusId(id);
  };
  // A focused row that is REMOVED (its session ended, its branch was collapsed by pointer) drops focus to
  // <body>. Put it back on the stop, but only for a removal: a row still in the DOM lost focus because
  // the user went somewhere else on purpose.
  const onTreeBlur = (e: FocusEvent<HTMLElement>) => {
    const from = e.target as HTMLElement;
    if (e.relatedTarget !== null || !from.hasAttribute(TREE_ITEM_ATTR)) return;
    requestAnimationFrame(() => {
      if (!from.isConnected && (document.activeElement === null || document.activeElement === document.body)) {
        stopElement()?.focus();
      }
    });
  };
  const onTreeKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (!TREE_KEYS.has(e.key) || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const nav = navRef.current;
    if (!nav) return;
    const target = e.target as HTMLElement;
    // The drawer focuses the <nav> itself on open; any tree key from there goes to the stop.
    if (target === nav) { e.preventDefault(); stopElement()?.focus(); return; }
    if (!target.hasAttribute(TREE_ITEM_ATTR)) return; // a `＋` keeps its own keys
    const items = treeItems(nav);
    const at = items.indexOf(target);
    const twist = rowTwist(target);
    const expanded = twist?.getAttribute("aria-expanded") === "true";
    let next: HTMLElement | undefined;
    switch (e.key) {
      case "ArrowDown": next = items[at + 1]; break;
      case "ArrowUp": next = items[at - 1]; break;
      case "Home": next = items[0]; break;
      case "End": next = items[items.length - 1]; break;
      case "ArrowRight":
        if (twist && !expanded) twist.click();
        else if (expanded) {
          const child = items[at + 1];
          if (child && target.closest("li")?.contains(child)) next = child;
        }
        break;
      case "ArrowLeft":
        if (twist && expanded) twist.click();
        else next = target.closest("li")?.parentElement?.closest("li")
          ?.querySelector<HTMLElement>(`[${TREE_ITEM_ATTR}]`) ?? undefined;
        break;
    }
    e.preventDefault();
    next?.focus();
  };

  const isSubOpen =(key: string, fallback: boolean) => openSubBranches[key] ?? fallback;
  const toggleSub = (key: string, fallback: boolean) =>
    setOpenSubBranches((prev) => ({ ...prev, [key]: !(prev[key] ?? fallback) }));

  // ── Row metrics, all off query keys some other surface already fills ─────────────────────────────
  // `["allSessions"]` is ActiveProjectProvider's own and `useAttention()` is mounted app-wide by
  // App.tsx for BOTH shells, so these add no poll of their own and can never disagree with the
  // number the page below it shows. The Gates row's `["gates-active"]` is the one exception (card
  // 291cc8aa, below). (Card ec1aa18e dropped the `["agents", id]` and `["board", id]`
  // reads along with the rows that carried their counts — those figures are on the project node's own
  // tab row now, which is where the owner's feedback moved a reader's eye for them.)
  const sessionsQ = useQuery({ queryKey: ["allSessions"], queryFn: ({ signal }) => api.allSessions(signal) });
  const { items: attention } = useAttention();

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
  // The Terminals node's own metric (card b439c2dc): how many sessions that node lists BEFORE the
  // reader narrows it. Derived through `workspaceRunningSessions` — the one predicate
  // pages/WorkspaceTerminals.tsx and the Workspace node's Sessions card both read — rather than a
  // fourth hand-rolled "is it running" test in this file. Same cache entry, so it costs no request.
  //
  // ⚠️ It is the UNFILTERED count on purpose, so it does NOT track that page's own head count once
  // a project filter is applied (5 here, "RUNNING 2" there). That is correct, not a drift: a rail
  // metric describes the WORKSPACE, and one that fell to 2 because of a filter set on the page it
  // leads to would misreport the fleet to a reader who is looking at the rail precisely to find out
  // what else is running. The two agree at rest, which is the only state where they are claims
  // about the same population.
  const terminalsLive = useMemo(() => workspaceRunningSessions(sessionsQ.data).length, [sessionsQ.data]);
  // The Inbox and Gates rows' figures (card 291cc8aa) — the SAME numbers the Workspace node's own tab
  // row shows, off the SAME keys: `["openQuestions"]` (kept warm app-wide by useAttention, no poll) with
  // notices excluded, exactly as WorkspaceHome's `inboxCount` is; and `["gates-active"]`. That second
  // one is the one read this tree adds: it shares the node's cache entry, but it now polls on every
  // page rather than only on the home nodes. It is the in-memory gate snapshot, so the cost is small.
  const questionsQ = useQuery<QuestionInboxItem[]>({ queryKey: ["openQuestions"], queryFn: ({ signal }) => api.openQuestions(false, signal) });
  const inboxWaiting = questionsQ.data?.filter((q) => q.state !== "notice").length ?? 0;
  const lanes = gateLanes(useGatesActive().data);

  // Which Workspace tab the address is on, if it is one the tree carries as a row. The Home row stays
  // landed on every OTHER tab of its node, as it always has.
  const homeTab = pathname === WORKSPACE_HOME.to ? new URLSearchParams(search).get("tab") : null;
  const tabRows = WORKSPACE_TAB_ROWS.map((key) => {
    const tab = WORKSPACE_NODE_TABS.find((t) => t.key === key)!;
    return { key, from: tab.from, label: workspaceNodeTabOf(tab).label, landed: homeTab === key || activeTo === tab.from };
  });
  const homeLanded = pathname === WORKSPACE_HOME.to && !tabRows.some((r) => r.landed);
  const tabMetric = (key: (typeof WORKSPACE_TAB_ROWS)[number]): ReactNode => {
    if (key === "inbox") {
      return inboxWaiting > 0
        ? <NodeBadge count={inboxWaiting} title={`${inboxWaiting} request${inboxWaiting === 1 ? "" : "s"} waiting on you`} />
        : undefined;
    }
    return lanes.running + lanes.queued > 0
      ? <NodeMeta value={<GatePair lanes={lanes} />} title={gatePairWords(lanes)} />
      : undefined;
  };

  // The "New project" `＋` beside the Projects heading (card 291cc8aa) opens the SAME guided setup
  // wizard the Platform node's launcher does — never a second flow (card 5afd71bd: project creation's
  // home is that wizard). Portalled to <body>: below the drawer breakpoint this tree is a translated
  // drawer, and a transformed ancestor would trap the wizard's `position: fixed` overlay inside it.
  const [wizardOpen, setWizardOpen] = useState(false);
  const openNewProject = () => {
    setWizardOpen(true);
    // On a phone the drawer would otherwise still be standing over the page when the wizard closes.
    onNavigate?.();
  };
  // EVERY project's live sessions — not just the selected one, and NOT companion-filtered here: the
  // only predicate below is `isLiveSession`, so an assistant-role (companion) session IS in this map.
  // Companions are dropped downstream, at the render site, by `groupSessionRows` (see `sessionRows`
  // below and lib/sessions' own note) — don't read this map as pre-filtered. Sibling `liveByProject`
  // (lib/atlasHome' `liveCountsByProject`) is the one that DOES exclude them, which is why the row's
  // live chip and this list can legitimately differ by a companion.
  // `["allSessions"]` is ONE cross-project cache entry that is already being polled, so a session row
  // costs the same whichever branch it is in. That is what makes card ec1aa18e's "the branch lists
  // what is RUNNING" affordable for every project at once rather than only for the one you are scoped to.
  const liveByProjectId = useMemo(() => {
    const byId = new Map<string, SessionListItem[]>();
    for (const s of sessionsQ.data ?? []) {
      if (!isLiveSession(s)) continue;
      const list = byId.get(s.projectId);
      if (list) list.push(s); else byId.set(s.projectId, [s]);
    }
    return byId;
  }, [sessionsQ.data]);

  // Running-first, alphabetical within each group (card ec1aa18e). "Running" is `liveByProject` —
  // the SAME count the row's own live chip shows and the same one WorkspaceHome's fleet figures use
  // — so a project can never be sorted into the running group while its row reads no live sessions.
  // Companion sessions are excluded at that helper's source, as they are everywhere else.
  const orderedProjects = useMemo(
    () => sortProjectsRunningFirst(projects, (p) => (liveByProject.get(p.id) ?? 0) > 0),
    [projects, liveByProject],
  );

  // Two rows of one agent ("Dev", "Dev") get a suffix that tells them apart (card eb516fba, audit
  // B-22) — preferably the title of the card each one is working. Those titles are read ONLY for an
  // OPEN branch that actually has such a pair, through the same `["tasks", projectId]` entry the
  // terminal tiles' bound-task bar already reads, so a workspace of distinct agents costs no request.
  const companionFree = (pid: string) => (liveByProjectId.get(pid) ?? []).filter((s) => !isCompanionSession(s));
  const titleProjectIds = orderedProjects
    .filter((p) => isExpanded(p.id) && companionFree(p.id).some((s, _i, all) =>
      !!s.taskId && all.some((o) => o.id !== s.id && o.agentName === s.agentName)))
    .map((p) => p.id);
  const cardTitleQs = useQueries({
    queries: titleProjectIds.map((pid) => ({
      queryKey: ["tasks", pid], queryFn: ({ signal }: { signal: AbortSignal }) => api.tasks(pid, signal), staleTime: 30_000,
    })),
  });
  const cardTitles = new Map<string, string>();
  for (const q of cardTitleQs) for (const t of q.data ?? []) cardTitles.set(t.id, t.title);

  const platformNodes = workspace.filter((p) => WORKSPACE_TIER_NODES.includes(p.to));

  /**
   * What hangs under ONE project node: ONLY what is RUNNING in it. Built per project, so a reader can
   * open a branch they are not scoped to and see the real shape of it, which is the whole point of a
   * branch that lists live work. No row carries a count: the two that did (Agents, Board) read
   * `projectId`-keyed caches only the SELECTED project's pages fill, and both are tabs now.
   *
   * @decision 4a0ad464 — a project branch holds entities, never pages. The owner read the `Home` and
   * `Overview` rows as duplicating the node's own tab row; don't re-add either, or any other.
   */
  const scopedNodes = (p: Project, selected: boolean): ReactNode[] => {
    // Clicking into a branch you are not scoped to re-scopes to it first: the page it lands on reads
    // the ACTIVE project, so navigating without this would render another project's data under a row
    // that named this one. Nothing to do when the row is already the selected branch's.
    const scopeFirst = selected ? undefined : () => selectProject(p.id);
    // A session's own ids are unique across the whole workspace and it belongs to exactly ONE
    // project, so an entity row needs no `<projectId>-` stem to stay a single element the way a
    // DESTINATION row does — the same destination is what renders once per open branch, and an
    // entity never is. The qualification rule is kept where its reason holds, and dropped where it
    // does not, rather than applied as a ritual that would make every spec carry a project id it
    // has no use for.
    const suffixes = sessionRowSuffixes(companionFree(p.id), cardTitles);
    const sessionRow = (s: SessionListItem, twist?: Twist, children?: ReactNode) => (
      <EntityRow key={s.id} entity="session" to={`/session/${s.id}`} testId={`atlas-session-${s.id}`}
        label={s.agentName} sub={suffixes.get(s.id)}
        title={`${s.agentName}${s.role ? ` · ${s.role}` : ""} · ${s.id.slice(0, 8)}${s.taskId && cardTitles.get(s.taskId) ? `\n${cardTitles.get(s.taskId)}` : ""}`}
        dot={<SessionDot s={s} />} metric={sessionMetric(s)}
        active={selected} activeTo={activeTo} onNavigate={scopeFirst} twist={twist}>
        {children}
      </EntityRow>
    );
    // Managers first with their own workers nested, then the sessions no live manager owns — the
    // SAME partition the Terminals grid already draws (lib/sessions' `groupSessionRows`), reused
    // rather than re-spelled so the rail and that grid can never disagree about who dispatched whom.
    // It drops companion sessions at the source, which is a load-bearing exclusion, not a filter
    // this row happens to want: a companion is driven only from /companion.
    const sessionRows = groupSessionRows(liveByProjectId.get(p.id) ?? []).flatMap((group) => {
      if (group.kind !== "manager") return group.list.map((s) => sessionRow(s));
      const [manager, ...workers] = group.list;
      if (!manager) return [];
      if (workers.length === 0) return [sessionRow(manager)];
      const key = `mgr:${manager.id}`;
      const expanded = isSubOpen(key, true);
      return [sessionRow(manager, {
        expanded,
        onToggle: () => toggleSub(key, true),
        label: `${expanded ? "Collapse" : "Expand"} ${manager.agentName}'s workers`,
        testId: `atlas-session-twist-${manager.id}`,
      }, expanded
        ? <ul className="loom-atlas-nodes is-kids">{workers.map((w) => sessionRow(w))}</ul>
        : undefined)];
    });

    // A branch with nothing running is now EMPTY, where before this card it still held two page
    // rows — so expanding an idle project would open onto nothing at all and read as a broken twist
    // rather than as an answer. One muted, non-interactive line says the answer instead. Not a link:
    // the row above it is already the way into the project, and a second one here would be the page
    // row this card just removed wearing a different label.
    if (sessionRows.length === 0) {
      return [
        <li key="idle" className="loom-atlas-idle" data-testid={`atlas-branch-idle-${p.id}`}>
          {/* The same two leading spacers every row in this rail carries, so the line's text starts
              exactly where a sibling session row's LABEL does rather than at a second origin derived
              by hand from the paddings. */}
          <span className="loom-atlas-twist" aria-hidden />
          <span className="loom-atlas-ico" aria-hidden />
          <span>Nothing running</span>
        </li>,
      ];
    }
    return sessionRows;
  };

  return (
    // The drawer's close-on-navigate is ONE delegated handler, not an `onNavigate` threaded through
    // every row factory: a later card that adds a row would have to remember to thread it, and a row
    // that forgot would leave the drawer standing over the page it just navigated to. Gated on an
    // ANCHOR so the controls that are not navigation — a twist, the project selector, the quick-spawn
    // `＋` — leave the drawer open, which is the whole point of card 0d0c6cee's expansion-is-not-
    // selection split: a reader must be able to open a branch and look before committing to a row.
    // `tabIndex={-1}` makes the nav itself the focus target when the drawer opens; it is never in the
    // tab order, so nothing changes above the breakpoint.
    <TreeStopContext.Provider value={stopId}>
    <nav id={ATLAS_TREE_ID} ref={navRef} tabIndex={-1}
      className={`loom-atlas-tree${open ? " is-open" : ""}`}
      onClick={onNavigate ? (e) => { if ((e.target as HTMLElement).closest("a")) onNavigate(); } : undefined}
      onFocus={onTreeFocus} onBlur={onTreeBlur} onKeyDown={onTreeKeyDown}
      aria-label="Primary navigation" data-testid="atlas-tree">
      <div className="loom-atlas-treehead">
        <Logo size={20} />
      </div>

      <div className="loom-atlas-treebody">
        <SectionLabel style={{ margin: "0 0 4px", padding: "0 10px" }}>Workspace</SectionLabel>
        <ul className="loom-atlas-nodes">
          <HomeNode home={WORKSPACE_HOME} testId={`atlas-home-${WORKSPACE_HOME.key}`} landed={homeLanded} />
          {/* Between Home and Platform — the owner's own placement (card b439c2dc). Its metric is
              the UNFILTERED count of what that node lists; see `terminalsLive` above for why it
              deliberately does not follow the page's own project filter. */}
          <HomeNode home={WORKSPACE_TERMINALS} testId={`atlas-home-${WORKSPACE_TERMINALS.key}`}
            metric={terminalsLive > 0
              ? <NodeMeta value={`${terminalsLive} live`} title={`${terminalsLive} running session${terminalsLive === 1 ? "" : "s"} across the workspace`} />
              : undefined} />
          {/* Inbox and Gates — card 291cc8aa, the owner's "own menu points under Workspace". After
              Terminals and before Platform, which stays pinned directly above the project list. */}
          {tabRows.map((r) => (
            <WorkspaceTabNode key={r.key} to={workspaceTabHref(r.key)} icon={r.from} label={r.label}
              landed={r.landed} testId={`atlas-workspace-tab-${r.key}`} metric={tabMetric(r.key)} />
          ))}
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
        <div className="loom-atlas-grouphead">
          <SectionLabel style={{ margin: 0, flex: "1 1 auto", minWidth: 0 }}>Projects</SectionLabel>
          <NewProjectButton onOpen={openNewProject} />
        </div>
        {projects.length === 0 ? (
          <>
            {/* Nothing to select, so nothing here pretends to be selectable — the row stays the plain
                label it was before selection existed. */}
            <div className="loom-atlas-node is-branch is-open" data-testid="atlas-project-node">
              <span className="loom-atlas-twist" aria-hidden>▸</span>
              <span className="loom-atlas-ico" aria-hidden><NavIcon to="/projects" /></span>
              <span className="loom-atlas-lbl">No project</span>
            </div>
            <ul className="loom-atlas-nodes is-kids">
              {scopedNodes({ id: "", name: "No project" } as Project, true)}
            </ul>
            {/* Deliberately a HINT, not a gate — see above. The branch below it holds only what is
                RUNNING since card 4a0ad464, and with no project there is nothing to run, so the hint
                is what the empty branch means rather than a caveat on a list of surfaces. */}
            <p style={{ margin: "6px 10px 0", color: color.text3, fontSize: fs.sm, lineHeight: 1.6 }}>
              No project yet. Create one on the Platform node and its agents appear here.
            </p>
          </>
        ) : (
          // RUNNING FIRST, alphabetical within each group — the owner's own instruction (card
          // ec1aa18e), overruling this tier's previous "source order, never reordered by liveness"
          // rule. That rule argued a row must stay where you left it; the owner's answer is that a
          // workspace of idle projects buries the two that are actually working, and finding those
          // is what the rail is opened for. The movement is real and accepted, not overlooked.
          //
          // The SELECTED branch is ALWAYS the id ActiveProjectProvider resolved — never a tree-local
          // guess — or the rows under it would claim a scope the pages themselves don't have. That is
          // total by construction (the provider only yields "" when the workspace holds no projects at
          // all, which is the branch above), and re-ordering the list cannot change it.
          <ul className="loom-atlas-nodes">
            {orderedProjects.map((p) => {
              const selected = p.id === projectId;
              const live = liveByProject.get(p.id) ?? 0;
              const needs = needsByProject.get(p.id) ?? 0;
              return (
                <ProjectNode key={p.id} project={p} selected={selected} expanded={isExpanded(p.id)}
                  onSelect={selectAndOpenProject} onToggle={toggleBranch}
                  metricsKey={`${needs}|${live}`}
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
                        <>
                          <span className="loom-atlas-live" title={`${live} live session${live === 1 ? "" : "s"}`} aria-hidden>
                            <span className="loom-atlas-livenum">{live}</span>
                            <span className="loom-atlas-livedot" aria-hidden />
                          </span>
                          <SrPart>{`${live} live`}</SrPart>
                        </>
                      )}
                    </>
                  }>
                  <ul className="loom-atlas-nodes is-kids">{scopedNodes(p, selected)}</ul>
                </ProjectNode>
              );
            })}
          </ul>
        )}
      </div>
    </nav>
    {/* OUTSIDE the <nav>: a portal still bubbles React events to its React parent, and the nav's
        delegated click and roving-key handlers have no business seeing the wizard's. */}
    {wizardOpen && createPortal(<SetupWizard open onClose={() => setWizardOpen(false)} />, document.body)}
    </TreeStopContext.Provider>
  );
}
