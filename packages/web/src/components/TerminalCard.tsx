import { type CSSProperties, type ReactNode, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import type { SessionListItem, Wake } from "@loom/shared";
import { api, type QueuedMessage } from "../lib/api";
import { useIsCompanionSession } from "../lib/companionGuard";
import { harnessOf } from "../lib/harnessFields";
import { usePendingDecisionsBySession } from "../lib/attention";
import { WAITING_ON_YOU } from "../lib/fleet";
import { isCompanionSession } from "../lib/sessions";
import { SESSION_NODE_TAB_LABEL, SESSION_NODE_TAB_ORDER, type SessionNodeTab } from "../lib/sessionNodeTabs";
import { NodeTabs } from "./atlasHome";
import { HarnessTag } from "./HarnessPicker";
import { TerminalPane } from "./Terminal";
import { TranscriptPane } from "./TranscriptPane";
import { Composer } from "./Composer";
import { McpActivity } from "./McpActivity";
import { SessionQueue } from "./SessionQueue";
import { SessionWakes } from "./SessionWakes";
import { SessionTaskCard } from "./SessionTaskCard";
import { Panel, Button, SectionLabel, StatusPill } from "./ui";
import { font, color, radius, fs } from "../theme";

// ── <TerminalCard> — the ONE base every live-session terminal card is built on ────────────────────
//
// Stage 1 (FOUNDATION) of the terminal-unification epic (`Projects/Loom/Design/Terminal Unification
// Plan.md`). It owns the parts that were duplicated (and drifted) across the hand-rolled tile wrappers:
//   • the Panel SHELL + its height model (HUG for numeric grid tiles / FILL for string page heights),
//   • the HEADER (identity + status title on the left, the action cluster on the right),
//   • the MAXIMIZE overlay + Esc + backdrop-close,
//   • the session BODY — TerminalPane plus the shared sub-panels (task card / wakes / queue / composer).
// The per-variant divergence is all explicit props. `TerminalTile` is the first (zero-behavior-change)
// migration; `PlatformSessionTile`, the Overview `SessionCockpit`, `ShellTile` and `CompanionTerminal`
// follow in later stages (see the plan).
//
// The `tabs` prop (Terminal + Transcript always, role-scoped Timeline/Diff) is wired as of STAGE 3 — the
// Overview `SessionCockpit` is its first consumer (lifted from its old hand-rolled inline tab bar).
// No-tabs stays byte-identical.
//
// @decision sha:a5544837 — STAGE 4 resolved the non-"busy" status question via a `title` OVERRIDE, never
// by implementing the `statusMode` "static"/"conn" branches — a raw shell / read-only companion isn't a
// DB Session with a live busy signal, so each supplies its own header node instead.
//
// `statusMode` stays typed (the enum keeps call sites shaped) with only the "busy" path implemented; no
// consumer needs the others.

export type TerminalLifecycle = "stop" | "kill" | "none";
export type TerminalStatusMode = "busy" | "static" | "conn";
// Aliased, not re-declared: the SAME union the Atlas frame's crumb trail reads (lib/sessionNodeTabs.ts),
// so a tab added for one surface can never be missing from the other's idea of the set.
export type TerminalTab = SessionNodeTab;

// The base reads only a small subset off `session`: the default `TileTitle` needs the identity/status
// quartet (busy/project/agent/role/id) and the taskCard query needs the project/task ids — never a full
// DB Session. Narrowing to this lets a NON-DB-Session surface (a raw `ShellTile` shell, a `CompanionTerminal`
// watch window) mount the SAME frame by passing just `{ id }`, with its own `title` + `renderBody`, instead
// of faking a `Session` row. Every existing consumer still passes a full `SessionListItem` — structurally
// assignable, so those call sites are byte-identical. `id` is the only field a title-override + renderBody
// consumer actually surfaces; the rest are optional and consumed only by the default title/task paths.
export type TerminalCardSession = Pick<SessionListItem, "id"> &
  Partial<Pick<SessionListItem, "projectId" | "taskId" | "busy" | "role" | "agentName" | "projectName" | "harness">>;

// Optional role-scoped tab bar. When provided, the body gains a Terminal + Transcript tab bar (both
// owned by the base — the shared TerminalPane / TranscriptPane), plus a Timeline and/or Diff tab ONLY
// when the caller passes that panel node (a manager passes `timeline`, a worker passes `diff` — same
// role scoping the inline SessionCockpit had). The extra panels are Overview-specific (orchestration
// events / branch diff), so they arrive as ready-rendered nodes rather than being wired into the base.
export interface TerminalTabs {
  timeline?: ReactNode; // manager-only: the orchestration-events timeline panel
  diff?: ReactNode; // worker-only: the branch-diff panel
}

/**
 * The ATLAS SESSION NODE's presentation of this card — a second SKIN over the same body, never a
 * second body. Absent ⇒ every existing call site renders byte-identically.
 *
 * @decision 525c8ad9 — never rebuild this surface beside TerminalCard: the Composer's session key,
 * the companion watch-only guard and the queue ledger have exactly one mount site, and a parallel
 * session body is a second place for each of them to be forgotten.
 */
export interface TerminalAtlasNode {
  /** Where the header is portaled to — null until the frame's slot element mounts (first paint). */
  headerSlot: HTMLElement | null;
  /** The active tab. An ADDRESS (`?tab=` / `/review/:id`), never local state. */
  tab: TerminalTab;
  /** That tab's own href. */
  hrefFor: (tab: TerminalTab) => string;
  /** Extra content for the tab row's trailing slot (e.g. a Diff tab's file count). */
  tabCount?: Partial<Record<TerminalTab, ReactNode>>;
  /** A standing column beside the tabs, panes and strips — a manager's worker lane rail (card dd5c8724).
   *  Absent ⇒ the node is the single flowing column it always was. On a narrow node it moves ABOVE the
   *  tab row (global.css, `.loom-atlas-sessionsplit`). */
  rail?: ReactNode;
}

export interface TerminalSubPanels {
  queue?: boolean; // SessionQueue strip below the terminal
  wakes?: boolean; // SessionWakes strip below the terminal
  taskCard?: boolean; // slim bound-board-task bar above the terminal
  // Optional pre-fetched data from a caller's shared parent-level bulk query (Overview's
  // ProjectTerminals grid + the Terminals page — see useSessionQueuesBulk/useSessionWakesBulk). When
  // provided, SessionQueue/SessionWakes skip their own per-card poll and read this instead; a caller
  // that doesn't batch (SessionView, Companion, PlatformSessionTile) omits these and each card falls
  // back to its own per-session useQuery, byte-identical to before.
  queueData?: QueuedMessage[];
  wakesData?: Wake[];
  onQueueMutated?: () => void;
  onWakeCancelled?: () => void;
}

// The HUG budget reserve — a FALLBACK estimate (header + composer + panel padding) used ONLY for the
// first paint, before the layout effect measures the ACTUAL chrome. Once measured, the terminal budget is
// derived from the real header + task-card + tab-bar + wakes + queue + composer height (which now varies
// per variant and grows/shrinks as a task binds or messages queue), so the card is truly content-sized.
const CHROME_RESERVE = 112;

// Slack (px) kept between the measured content and the `height` cap. The budget parks the terminal grid a
// few px BELOW `maxHeight` instead of exactly on it, so the panel's border-box never sits on the overflow
// boundary where a 1px overshoot could toggle a scrollbar on an ancestor container — the width change that
// used to feed the font/grid oscillation. 2px of it covers the panel's 1px top+bottom border (not in
// scrollHeight); the rest is genuine off-the-threshold slack.
const BUDGET_SLACK = 6;

// ── Shared header pieces ──────────────────────────────────────────────────────────────────────────
// The action-cluster buttons + the identity/status title. They live here (the base's home) so every
// terminal-card variant renders the same controls; TerminalTile re-exports them for its call sites.

const FORK_BUSY_REASON = "Fork is available when the session is idle.";
const FORK_REASON_MS = 4000;

/**
 * Fork. While the session is busy it is BLOCKED, not `disabled` (card 4f62b5cb): it looks disabled and
 * never forks, but a tap shows the reason in a small note under it for a few seconds. A disabled button
 * swallows the tap and its `title` only ever reaches a mouse, so a touch reader was never told why.
 * The same reason is the button's accessible description throughout.
 */
export function ForkButton({ onFork, busy, pending, style }: {
  onFork: () => void; busy: boolean; pending: boolean;
  /** Layout only (e.g. a cluster's own padding) — never color/background (decision 6cefdf25). */
  style?: CSSProperties;
}) {
  const reasonId = useId();
  const [explain, setExplain] = useState(false);
  const blocked = busy && !pending;
  useEffect(() => {
    if (!explain || !blocked) { if (explain) setExplain(false); return; }
    const t = setTimeout(() => setExplain(false), FORK_REASON_MS);
    return () => clearTimeout(t);
  }, [explain, blocked]);
  return (
    <span className="loom-forkwrap">
      <Button style={{ padding: "0 8px", ...style, ...(blocked ? { cursor: "not-allowed" } : null) }} disabled={pending}
        aria-disabled={blocked || undefined} aria-describedby={blocked ? reasonId : undefined}
        className={blocked ? "loom-btn-blocked" : undefined}
        title={blocked ? undefined : "Fork — branch this conversation into a new divergent session"}
        onClick={(ev) => {
          ev.stopPropagation();
          if (blocked) { setExplain(true); return; }
          onFork();
        }}>Fork</Button>
      {blocked && (
        <span id={reasonId} role="status" data-testid="fork-blocked-reason"
          className={`loom-forkwhy${explain ? " is-open" : ""}`}>{FORK_BUSY_REASON}</span>
      )}
    </span>
  );
}

export function StopButton({ onStop, stopping }: { onStop: () => void; stopping: boolean }) {
  return (
    <Button style={{ padding: "0 8px" }} disabled={stopping}
      title="Stop this session — graceful Ctrl-C, clean and resumable"
      onClick={(ev) => { ev.stopPropagation(); onStop(); }}>Stop</Button>
  );
}

export function TileTitle({ s, showProject }: { s: TerminalCardSession; showProject?: boolean }) {
  // The identity reads `[project · ]agent[ · role] · <short id>`, rendered as TWO nodes rather than one
  // (card ad3157b9): a SHRINKABLE prefix that ellipsises, and a NON-SHRINKING short id. As one node it
  // wrapped to a second line in the ~584px grid tile the moment the CODEX badge claimed its ~55px — the
  // claude row had only ~51px of slack there — costing that tile ~18px of terminal body. Split, the
  // header is structurally one line at ANY tile width: the prefix gives up space first and the short id
  // (the part that actually tells two tiles apart) is the last thing to go. The concatenated text is
  // byte-identical to the old single node, so an `<agent> · <short id>` text matcher still reads one
  // continuous string off the wrapper.
  //   • `minWidth: 0` on BOTH this span and the wrapper is load-bearing: a flex item's default
  //     `min-width: auto` is its min-content width, which for nowrap text is the WHOLE string — the item
  //     would then refuse to shrink and OVERFLOW the header instead of ellipsising.
  //   • the id span keeps its leading " · " under `white-space: pre`, because flex items are blockified
  //     and a block box strips the leading space at the start of its line.
  const prefix = `${showProject ? `${s.projectName} · ` : ""}${s.agentName}${s.role ? ` · ${s.role}` : ""}`;
  const shortId = s.id.slice(0, 8);
  // A session holding a PENDING owner Request it filed reads "waiting on you" (solid attn), the same
  // precedence as fleet's sessionStatus: waiting on you > working > idle.
  const waiting = usePendingDecisionsBySession().has(s.id);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, minWidth: 0, fontSize: fs.sm, color: color.text2 }}>
      {waiting
        ? <StatusPill {...WAITING_ON_YOU} style={{ flexShrink: 0 }} />
        : <StatusPill tone={s.busy ? "work" : "live"} glow={s.busy} label={s.busy ? "working" : "idle"} style={{ flexShrink: 0 }} />}
      {/* Same rule as FleetRow — codex always, claude only in a mixed-harness view.
          @decision b8e52cfe — never badge claude in a single-harness view.

          It sits with the status pill rather than after the identity text so a narrow tile can never
          strand the tag alone on a wrapped second line, and so the two badges read as one cluster. A
          title-override consumer (a raw shell, a companion watch window) never reaches this path, and
          `harness` is optional on TerminalCardSession, so those call sites stay byte-identical. */}
      <HarnessTag harness={harnessOf(s.harness)} />
      <span data-testid="tile-identity" title={`${prefix} · ${shortId}`}
        style={{ display: "inline-flex", alignItems: "center", minWidth: 0 }}>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{prefix}</span>
        <span style={{ flexShrink: 0, whiteSpace: "pre", fontFamily: font.mono }}>{` · ${shortId}`}</span>
      </span>
    </span>
  );
}

export function TerminalCard({
  session,
  height,
  maxWidth,
  capWidthToGrid,
  showProject,
  title,
  readOnly = false,
  resizable = false,
  offerFork = false,
  onFork,
  forkPending = false,
  lifecycle = "stop",
  onStop,
  stopPending = false,
  stopTitle,
  maximizable = true,
  statusMode = "busy",
  subPanels,
  tabs,
  atlasNode,
  renderBody,
  actionsExtra,
}: {
  session: TerminalCardSession;
  height: number | string;
  maxWidth?: number | string;
  /** HUG only (card 80c4e758): `true` caps the card's width to the widest its terminal grid can render
   *  at the height budget, so a wide 1-column card leaves no empty strip right of the grid; heights are
   *  untouched. `false` keeps tracking that width without applying it, so flipping to `true` (a grid
   *  dropping to one track) caps at once. Omitted ⇒ nothing is measured and the card is unchanged. */
  capWidthToGrid?: boolean;
  showProject?: boolean;
  /** Override the default status+identity title node (a variant with a non-busy status source). */
  title?: ReactNode;
  /** Watch-only: the TerminalPane takes no stdin AND the Composer is withheld. */
  readOnly?: boolean;
  /** Fit the pty grid to the pane (plain shells); Claude sessions stay pinned-geometry. */
  resizable?: boolean;
  offerFork?: boolean;
  onFork?: () => void;
  forkPending?: boolean;
  /** The primary lifecycle button: graceful "stop", hard "kill" (caller confirms), or "none". */
  lifecycle?: TerminalLifecycle;
  onStop?: () => void;
  stopPending?: boolean;
  stopTitle?: string;
  maximizable?: boolean;
  statusMode?: TerminalStatusMode;
  subPanels?: TerminalSubPanels;
  /** Add a Terminal + Transcript tab bar (+ role-scoped Timeline/Diff when the panel node is passed). */
  tabs?: TerminalTabs;
  /** Render as the Atlas session node instead of a card (see TerminalAtlasNode). Absent ⇒ unchanged. */
  atlasNode?: TerminalAtlasNode;
  /** Replace the default session body (TerminalPane + sub-panels) — for raw-shell / companion bodies. */
  renderBody?: (ctx: { maximized: boolean; hug: boolean; heightBudget?: number }) => ReactNode;
  /** Extra buttons appended after the standard action cluster. */
  actionsExtra?: ReactNode;
}) {
  void statusMode; // only "busy" is wired; non-busy variants carry a "title" override pill (see header note).
  // COMPANION GUARD (card 5c87f4b6) — the SURFACE half. TerminalPane self-guards its own stdin transport,
  // but the turn-Composer is a SEPARATE inbound surface (it POSTs /api/sessions/:id/input rather than
  // riding the terminal ws), so withholding it is this component's own job — exactly as Companion.tsx has
  // always done explicitly via `readOnly`. Read BOTH ways round on purpose: the store lookup is the
  // fail-closed one (no prop to omit), and the prop-role check answers instantly for the callers that do
  // pass a full session, without waiting on a poll. Neither can fire for a raw shell (no role, no store
  // row), so ShellTile stays writable.
  const isCompanionFromStore = useIsCompanionSession(session.id);
  const watchOnly = readOnly || isCompanionFromStore || isCompanionSession(session);
  const [maximized, setMaximized] = useState(false);

  // HUG (numeric height) vs FILL (string height, e.g. "76vh"). HUG cards hug their content up to a MAX cap
  // (`maxHeight: height`); FILL cards flex to fill a page slot. Declared up here so the height-budget
  // measurement effect below can gate on it.
  const hug = typeof height === "number";

  // Content-dynamic HUG budget. The pinned 120×40 grid scaled to a tile's WIDTH is usually shorter than a
  // fixed pane, and the surrounding chrome (task card / tab bar / wakes / queued turns / composer) grows and
  // shrinks — so a FIXED reserve either leaves dead space or clips the composer. Instead we MEASURE the real
  // chrome (`chrome = panel.scrollHeight − pane.offsetHeight`, invariant to the pane's own height since both
  // move together) and hand the terminal exactly the leftover space, minus `BUDGET_SLACK`, up to the `height`
  // cap. Only `belowRef` (wakes/queue/composer — the chrome that GROWS at runtime without a prop change) is
  // observed; the panel that CONTAINS the pane is deliberately NOT, so the pane resizing itself can never
  // re-fire the measure (that was the ff002d9 oscillation — see the measure effect for the full loop).
  const paneWrapRef = useRef<HTMLDivElement>(null);
  const belowRef = useRef<HTMLDivElement>(null);
  const [measuredBudget, setMeasuredBudget] = useState<number | undefined>(undefined);

  // Direction B — the queued-message "ledger bar" (SessionQueue) must GROW THE CARD, never shrink the
  // terminal. It's the one below-terminal element that grows at runtime (a bar when ≥1 queued, a bounded
  // drawer when expanded), so we measure it separately: its height is SUBTRACTED from the chrome that sets
  // the terminal budget (so the terminal region holds a fixed height across every queue state) and instead
  // ADDED to the HUG height cap (so the card grows by exactly the bar/drawer and the composer rides down
  // with it). `queueChromeH` is that measured height, 0 when the queue is empty (SessionQueue → null). The
  // cap bump carries an extra `BUDGET_SLACK` (mirroring the at-rest headroom the budget already leaves) so
  // the grown content sits a few px BELOW the cap, not ON it — otherwise a height-bound grid's 1px font
  // settle would repeatedly cross the maxHeight clamp boundary and oscillate.
  const queueRef = useRef<HTMLDivElement>(null);
  const [queueChromeH, setQueueChromeH] = useState(0);

  // Card 80c4e758 — the card width at which its terminal grid fills the pane edge to edge: the grid
  // width TerminalPane reports (only once the height axis binds) plus this card's own horizontal chrome
  // (padding + border), measured rather than assumed. A cap may only grow by the report or stay within
  // 1px ABOVE it: a cap even 1px under the grid would make the pane step its font down and shrink the
  // terminal's height, which is exactly what capping exists to avoid.
  const [gridCap, setGridCap] = useState<number | null>(null);
  const onGridWidth = useCallback((px: number | null) => {
    if (px == null) { setGridCap(null); return; }
    const wrap = paneWrapRef.current;
    const panelEl = wrap?.parentElement;
    if (!wrap || !panelEl) return;
    const next = px + (panelEl.offsetWidth - wrap.clientWidth);
    setGridCap((cur) => (cur != null && cur >= next && cur - next <= 1 ? cur : next));
  }, []);

  // Role-scoped tab bar (opt-in via `tabs`). Terminal + Transcript are always offered; Timeline/Diff
  // appear only when the caller supplies that panel node. `activeTab` guards against a stale selection
  // (e.g. the "diff" tab if a caller ever stopped passing a diff node) by falling back to "terminal".
  //
  // The ORDER and the LABELS come from lib/sessionNodeTabs.ts, which is also what the Atlas frame's
  // crumb trail reads — so the row a node renders and the tab the trail names it by cannot drift
  // apart. What stays HERE is the only part this component can answer: which optional panes the
  // CALLER actually supplied. The role rule that decides that lives in that same file
  // (`sessionNodeTabsFor`), read by SessionNode.
  const [tab, setTab] = useState<TerminalTab>("terminal");
  const tabDefs: { key: TerminalTab; label: string }[] = tabs
    ? SESSION_NODE_TAB_ORDER
        .filter((key) => (key === "timeline" ? tabs.timeline != null : key === "diff" ? tabs.diff != null : true))
        .map((key) => ({ key, label: SESSION_NODE_TAB_LABEL[key] }))
    : [];
  // The Atlas node's tab is an ADDRESS, so it supersedes the local state entirely (nothing writes
  // `tab` there — every tab is a Link). The stale-selection fallback is the same either way.
  const wantTab = atlasNode ? atlasNode.tab : tab;
  const activeTab: TerminalTab = tabDefs.some((t) => t.key === wantTab) ? wantTab : "terminal";

  // Resolve the board task this session is bound to and render the slim bar in the body, so every call
  // site shows it without re-wiring. Keyed ["tasks", projectId] (staleTime 4000) so React Query DEDUPES
  // it across a project's tiles — one fetch per project, not per tile. Only fetch for a bound session
  // when the task-card panel is enabled; an id that doesn't resolve leaves `task` undefined → no bar.
  const wantTaskCard = !!subPanels?.taskCard;
  const tasks = useQuery({
    // `?? ""` satisfies the narrowed session type (projectId is optional so a non-DB shell can pass just
    // `{ id }`); it never actually fetches with an empty id because `enabled` also requires a taskId, which
    // only a real project session carries — and such a session always has a projectId.
    queryKey: ["tasks", session.projectId],
    queryFn: ({ signal }) => api.tasks(session.projectId ?? "", signal),
    staleTime: 4000,
    enabled: wantTaskCard && !!session.taskId,
  });
  const task = wantTaskCard && session.taskId ? tasks.data?.find((t) => t.id === session.taskId) : undefined;

  // Esc restores from the maximized overlay (mirrors the backdrop click + the ⤡ toggle). Bound only
  // while maximized so a stray Esc never fires when no overlay is open. This is a BUBBLE-phase window
  // listener on purpose: the Composer's LargeEditor binds its own Esc in the CAPTURE phase
  // (Composer.tsx:172-178) and stopPropagation()s it, so an Esc that closes the large editor is consumed
  // BEFORE it reaches here and never also un-maximizes the card. Do not switch this to capture phase.
  useEffect(() => {
    if (!maximizable || !maximized) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMaximized(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [maximizable, maximized]);

  // Measure the actual non-terminal chrome and derive the terminal's height budget (HUG, non-maximized
  // only — a FILL/string height fills its slot; a maximized card fills the overlay).
  //
  // OSCILLATION FIX (ff002d9 regression): we must NEVER observe an element that contains the terminal pane.
  // The old effect did `ro.observe(panelEl)`, which closed a feedback loop: measure → setMeasuredBudget →
  // TerminalPane.applyFontSize sets the pane's height (`el.style.height = gridH`) → the panel reflows → the
  // ResizeObserver on the panel re-fires → measure. With the budget parked EXACTLY at `maxHeight`, a 1px
  // overshoot could toggle an ancestor scrollbar → the pane's clientWidth shifts → the width-driven font
  // (`min(fitW,fitH)`) and gridH change → it re-crosses the threshold → fast oscillation (acute on Platform:
  // tight 440px + queue/wakes/task chrome). Two independent guards kill it: (1) we observe ONLY `belowRef`
  // (wakes/queue/composer — chrome that grows at runtime and does NOT contain the pane), so the pane's own
  // resize can no longer feed `measure`; and (2) `BUDGET_SLACK` keeps the content off the overflow boundary
  // so no residual width coupling remains. Re-runs on the props that add/remove chrome (header/task/tab
  // heights change only via those, so they need no observer of their own).
  useLayoutEffect(() => {
    if (!hug || maximized) return;
    const measure = () => {
      const pane = paneWrapRef.current;
      const panelEl = pane?.parentElement; // Panel doesn't forward a ref; the pane's parent IS the panel body
      if (!pane || !panelEl) return;
      // scrollHeight reports the FULL content even when the panel's border-box is clamped at maxHeight, so
      // this stays accurate at the cap. chrome includes the panel's padding; BUDGET_SLACK covers the 1px
      // border AND keeps the grid a few px below the cap (see its declaration).
      // The queue ledger grows the CARD, not the terminal (Direction B): subtract its measured height back
      // out of the chrome so the budget stays invariant to queue depth / drawer state, and remember it so
      // the render can bump the HUG height cap by the same amount (the card grows to fit the bar/drawer).
      const queueH = queueRef.current?.offsetHeight ?? 0;
      const chrome = panelEl.scrollHeight - pane.offsetHeight - queueH;
      const next = Math.max(120, (height as number) - chrome - BUDGET_SLACK);
      setMeasuredBudget((cur) => (cur != null && Math.abs(cur - next) <= 1 ? cur : next));
      setQueueChromeH((cur) => (Math.abs(cur - queueH) <= 1 ? cur : queueH));
    };
    measure();
    // Observe ONLY the below-strip — NEVER the panel (which contains the pane) — so the pane resizing itself
    // can never re-trigger measure. A queued turn / opened large editor grows belowRef and re-measures.
    const ro = new ResizeObserver(measure);
    if (belowRef.current) ro.observe(belowRef.current);
    return () => ro.disconnect();
  }, [hug, maximized, height, activeTab, !!task, watchOnly, !!tabs,
      subPanels?.queue, subPanels?.wakes, subPanels?.taskCard]);

  // The ATLAS node's counterpart to Direction B above, inverted (card 4f62b5cb): the node is a flowing
  // column, so a queue that grows pushed the composer below the fold. There the PANE gives up the queue's
  // height instead (`--loom-atlas-queue-h`, read by `.loom-atlas-termbox` / `.loom-atlas-panebox`), so the
  // composer holds one position whatever the queue holds. Observes only the queue wrapper, which never
  // contains the pane, so a pane resize cannot re-fire it.
  const [atlasQueueH, setAtlasQueueH] = useState(0);
  const isAtlasNode = atlasNode != null;
  useLayoutEffect(() => {
    if (!isAtlasNode || maximized) return;
    const el = queueRef.current;
    if (!el) return;
    const measure = () => setAtlasQueueH((cur) => (Math.abs(cur - el.offsetHeight) <= 1 ? cur : el.offsetHeight));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [isAtlasNode, maximized, subPanels?.queue]);

  const lifecycleButton = lifecycle === "kill"
    ? <Button variant="danger" style={{ padding: "0 8px" }} disabled={stopPending}
        title={stopTitle ?? "Kill this session"} onClick={(ev) => { ev.stopPropagation(); onStop?.(); }}>Kill</Button>
    : lifecycle === "stop"
      ? <StopButton onStop={() => onStop?.()} stopping={stopPending} />
      : null;

  const header = (
    <div className={atlasNode ? "loom-atlas-nodehead-row loom-atlas-sessionhead-row" : undefined}
      // A tile's own gap (card eb516fba, audit A-20): with none, the short id butted straight into Fork
      // and read as overlapping it. The Atlas session node's row carries its own gap in global.css.
      style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: atlasNode ? 0 : 4, gap: atlasNode ? undefined : 8 }}>
      {title ?? <TileTitle s={session} showProject={showProject} />}
      {/* Never compresses — the identity prefix beside it is the element that gives up space (ad3157b9). */}
      <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
        {offerFork && <ForkButton onFork={() => onFork?.()} busy={session.busy ?? false} pending={forkPending} />}
        {lifecycleButton}
        {actionsExtra}
        {maximizable && (
          <Button style={{ padding: "0 6px" }} title={maximized ? "Restore terminal (Esc)" : "Maximize terminal"}
            onClick={() => setMaximized((m) => !m)}>{maximized ? "⤡" : "⤢"}</Button>
        )}
      </div>
    </div>
  );

  // HUG (non-maximized, numeric height): the pinned 120×40 grid scaled to a narrow tile's WIDTH is
  // shorter than a fixed pane — which used to leave a large letterbox band between the terminal and the
  // composer. Give the TerminalPane a height BUDGET (the measured leftover space, see above) and let it
  // shrink to the grid it actually renders, so the composer sits flush beneath and the card hugs the
  // terminal. HUG is gated to NUMERIC heights only: a STRING height (e.g. "76vh") is a fill-the-space page
  // terminal that keeps the old `flex:1` + `height` fill (no budget). Maximized always fills.
  // The tab row, in whichever grammar this card wears: the classic button strip, or — for the Atlas
  // session node — the frame's own underline row of real `<Link>` addresses. Shared by BOTH bodies so
  // the maximized overlay can never offer a different tab set (or a different way to switch) than the
  // card it was opened from.
  const tabBarNode = !tabs ? null : atlasNode ? (
    <NodeTabs
      tabs={tabDefs.map((t) => ({ key: t.key, label: t.label, count: atlasNode.tabCount?.[t.key] }))}
      active={activeTab}
      hrefFor={(key) => atlasNode.hrefFor(key as TerminalTab)}
    />
  ) : (
    // Graphite tabs: the same underline grammar as the kit's NavTab (`.loom-navtab`), as real buttons
    // because these switch a pane in place rather than navigate. aria-pressed carries the on state.
    <div className="loom-cardtabs" style={{ marginBottom: 6, display: "flex", gap: 18, flexShrink: 0 }}>
      {tabDefs.map((t) => (
        <button key={t.key} type="button" aria-pressed={activeTab === t.key}
          className={`loom-navtab loom-cardtab${activeTab === t.key ? " is-active" : ""}`}
          onClick={() => setTab(t.key)}>{t.label}</button>
      ))}
    </div>
  );

  // Every pane here unmounts when it is not the active one. That is safe for the SAME-ROUTE switches
  // (`?tab=`), where the node itself stays mounted and the inline strips below — composer, queue —
  // never come down at all.
  //
  // ⚠️ It is NOT the whole story, and an earlier version of this comment claimed it was. The Atlas
  // node's Diff tab is a ROUTE (/review/:workerId), so a Terminal→Diff hop unmounts the ENTIRE node,
  // strips included. Nothing here protects a draft from that; both drafts survive it because they are
  // store-backed instead — lib/composerDrafts.ts and lib/queueDrafts.ts. The Diff pane's own
  // request-changes note needs no such store, because Diff is never the INACTIVE pane of a node the
  // reader is still on.
  const diffPane = !tabs || tabs.diff == null || activeTab !== "diff" ? null
    : atlasNode ? <div data-testid="session-node-pane-diff">{tabs.diff}</div> : tabs.diff;

  // ONE mount site each for the live terminal and the turn Composer, reached from both bodies below.
  // Factored rather than written out twice on purpose: the companion guard (`readOnly={watchOnly}`) and
  // the Composer's `key` are invariants this file is the single owner of, and a second literal of
  // either is a second place for one of them to be forgotten.
  const terminalPane = (heightBudget?: number) => (
    <TerminalPane sessionId={session.id} readOnly={watchOnly} resizable={resizable} heightBudget={heightBudget}
      onGridWidth={capWidthToGrid !== undefined && heightBudget != null ? onGridWidth : undefined} />
  );
  // `key` is LOAD-BEARING, not a list-reconciliation hint (card 14c68c62). The Composer seeds its
  // draft from the per-session store with a LAZY useState initializer, which runs on MOUNT only — so a
  // card that stays mounted while `session.id` changes under it (the /session/:id deep-link route
  // reuses one SessionView element across an id change) would carry session A's unfinished text into
  // session B, write it INTO B's draft on the next keystroke, and Send it to B. Keying on the id makes
  // each session its OWN component instance: A's draft is never rendered under B, and every `setDraft`
  // call is closed over the one id that instance was mounted with, so no keystroke can land under the
  // wrong session mid-transition. This is the ONLY place a Composer is mounted — keeping the key here
  // means no call site can forget it.
  const composerNode = watchOnly ? null : <Composer key={session.id} sessionId={session.id} />;

  // The below-terminal strip — bound task (Atlas only; the card keeps it above the pane), wakes, the
  // queue ledger, the composer. Observed by the budget measurement (belowRef) so a queued turn / opened
  // large editor re-measures even when the card is already at its height cap. flexShrink:0 keeps the
  // composer + strips at natural height — the terminal is the element that gives up space.
  // The session's Loom MCP activity (card a9a7140c): the session page only, so the Overview grid's tiles
  // and the classic cards keep their height. Keyed so a reused node never shows A's filters or open rows
  // under B. A node with a RAIL renders it below the split, full width, instead (see `atlasBody`).
  const mcpSection = atlasNode ? (
    <section className="loom-atlas-nodesec" data-testid="session-node-mcp" aria-label="Loom MCP activity">
      <McpActivity key={session.id} sessionId={session.id} harness={session.harness} busy={!!session.busy} />
    </section>
  ) : null;
  const belowStrip = (withMcp: boolean) => (
    <div ref={belowRef} style={{ flexShrink: 0 }} className={atlasNode ? "loom-atlas-nodesections" : undefined}>
      {atlasNode && task && (
        <section className="loom-atlas-nodesec" data-testid="session-node-task">
          <SectionLabel style={{ margin: 0 }}>Bound task</SectionLabel>
          <SessionTaskCard task={task} />
        </section>
      )}
      {subPanels?.wakes && (
        <SessionWakes sessionId={session.id} wakes={subPanels.wakesData} onCancelled={subPanels.onWakeCancelled} />
      )}
      {/* The queue ledger is measured on its OWN (queueRef) so it can grow the card without shrinking the
          terminal. flex-column so the SessionQueue root's marginTop counts in offsetHeight (a plain block
          wrapper would collapse that margin through its top edge and under-measure the ledger). */}
      {subPanels?.queue && (
        <div ref={queueRef} style={{ display: "flex", flexDirection: "column" }}>
          <SessionQueue sessionId={session.id} pending={subPanels.queueData} onMutated={subPanels.onQueueMutated} />
        </div>
      )}
      {atlasNode && composerNode ? (
        <section className="loom-atlas-nodesec" data-testid="session-node-composer">
          <SectionLabel style={{ margin: 0 }}>Send a turn</SectionLabel>
          {composerNode}
        </section>
      ) : composerNode}
      {withMcp && mcpSection}
    </div>
  );

  const sessionBody = (hugMode: boolean, heightBudget?: number) => (
    <>
      {!atlasNode && task && <SessionTaskCard task={task} />}
      {tabBarNode}
      {/* Terminal (default) OR — with tabs — the active pane. TerminalPane is mounted ONLY on the
          Terminal tab so a card viewing Transcript/Timeline/Diff holds no live pty websocket (single
          live terminal, mirroring the old SessionCockpit). overflow:hidden clips xterm's canvas to the
          pane box — a Composer state change (e.g. toggling Voice) can momentarily overflow the font
          rescale; this guarantees the terminal can NEVER paint over the composer below. xterm scrolls
          via its own .xterm-viewport. */}
      {(!tabs || activeTab === "terminal") && (
        // The terminal well (Graphite): rounded and on the terminal's own dark ground in both themes. Radius
        // and background only, never padding, so the HUG budget measures exactly what it did before.
        <div ref={paneWrapRef} style={{ ...(hugMode ? null : { flex: 1 }), minHeight: 0, overflow: "hidden",
          borderRadius: radius.base, background: color.termBg }}>
          {terminalPane(heightBudget)}
        </div>
      )}
      {tabs && activeTab === "transcript" && (
        // Transcript has no grid to hug: in HUG mode it takes a fixed box (the terminal's budget) and
        // scrolls internally; in FILL mode it flexes like the pane it replaces.
        <div ref={paneWrapRef} style={{ ...(hugMode ? { height: heightBudget } : { flex: 1 }), minHeight: 0, overflow: "hidden" }}>
          <TranscriptPane sessionId={session.id} />
        </div>
      )}
      {tabs && activeTab === "timeline" && tabs.timeline}
      {diffPane}
      {belowStrip(true)}
    </>
  );

  // The ATLAS session node's body (card 525c8ad9). Same leaf components and the same strip, laid out as
  // a FLOWING column instead of a fixed-height card: the Atlas content column is what scrolls, so the
  // terminal takes a bounded box of its own and the review surface below it runs to whatever length the
  // diff actually has, rather than being squeezed into a card's leftover space.
  const atlasMain = () => (
    <>
      {tabBarNode}
      <div className="loom-atlas-nodepanes">
        {(!tabs || activeTab === "terminal") && (
          <div ref={paneWrapRef} className="loom-atlas-termbox" data-testid="session-node-pane-terminal">
            {terminalPane()}
          </div>
        )}
        {tabs && activeTab === "transcript" && (
          <div className="loom-atlas-termbox" data-testid="session-node-pane-transcript">
            <TranscriptPane sessionId={session.id} />
          </div>
        )}
        {/* The same box height as the terminal, so the composer below holds its place on a tab switch
            (card 4f62b5cb). Diff is the exception on purpose: it is its own address (/review/:id) and
            runs to the length of the diff. */}
        {tabs && activeTab === "timeline" && (
          <div className="loom-atlas-panebox" data-testid="session-node-pane-timeline">{tabs.timeline}</div>
        )}
        {diffPane}
      </div>
      {belowStrip(atlasNode?.rail == null)}
    </>
  );
  // With a rail the column above becomes the split's main track. The rail is a sibling, never inside
  // `.loom-atlas-nodepanes`, so it cannot change the pane height the composer is pinned against. The MCP
  // strip leaves the narrowed track and runs full width below the split: squeezed beside a 372px rail it
  // crossed its own 700px container breakpoint and dropped its duration column (card dd5c8724).
  const atlasBody = () => atlasNode?.rail == null ? atlasMain() : (
    <>
      <div className="loom-atlas-sessionsplit">
        <div className="loom-atlas-sessionmain">{atlasMain()}</div>
        <div className="loom-atlas-sessionrail">{atlasNode.rail}</div>
      </div>
      {mcpSection}
    </>
  );

  const body = (maximizedNow: boolean) => {
    const hugMode = !maximizedNow && hug;
    // Prefer the MEASURED leftover space; fall back to the fixed reserve for the first paint (before the
    // layout effect runs). Non-HUG (fill) passes no budget — the pane flexes to fill its slot.
    const heightBudget = hugMode ? (measuredBudget ?? (height as number) - CHROME_RESERVE) : undefined;
    if (renderBody) return renderBody({ maximized: maximizedNow, hug: hugMode, heightBudget });
    // Maximized is a full-viewport CARD even for the Atlas node: the overlay IS a bounded box, so the
    // flowing column has nothing left to flow into and the fill body is the right one.
    return atlasNode && !maximizedNow ? atlasBody() : sessionBody(hugMode, heightBudget);
  };

  if (maximizable && maximized) {
    const overlay: CSSProperties = {
      position: "fixed", inset: 0, background: color.scrim, display: "flex",
      alignItems: "center", justifyContent: "center", zIndex: 50, padding: 16,
    };
    return (
      <div style={overlay} onClick={() => setMaximized(false)}>
        <div onClick={(e) => e.stopPropagation()} style={{ width: "90vw", height: "88vh", maxWidth: 1500 }}>
          <Panel style={{ height: "100%", padding: 6, display: "flex", flexDirection: "column" }}>
            {header}
            {body(true)}
          </Panel>
        </div>
      </div>
    );
  }

  // The ATLAS node is not a card: the frame's crumb bar and `<h1>` are already its chrome, so the Panel
  // keeps only its layout role (a flow column) and gives up its surface, border and height model — the
  // content column is what scrolls. Its header goes to the frame's node head instead of sitting inline
  // one row under the `<h1>` that now carries the same identity. A null slot (the element has not
  // mounted yet, which is the case for exactly one paint) renders nothing rather than falling back
  // inline, so the de-duplication can never flicker a second identity onto the screen.
  if (atlasNode) {
    return (
      <div className={`loom-atlas-sessionnode${atlasNode.rail != null ? " has-rail" : ""}`} data-testid="session-node"
        style={{ "--loom-atlas-queue-h": `${atlasQueueH}px` } as CSSProperties}>
        {atlasNode.headerSlot ? createPortal(header, atlasNode.headerSlot) : null}
        {body(false)}
      </div>
    );
  }

  // The grid cap applies only on the terminal tab of a HUG card (a Transcript pane has no grid to hug).
  const appliedMaxWidth = capWidthToGrid && hug && gridCap != null && (!tabs || activeTab === "terminal") ? gridCap : maxWidth;
  return (
    <Panel style={{ ...(hug ? { maxHeight: (height as number) + (queueChromeH > 0 ? queueChromeH + BUDGET_SLACK : 0) } : { height }), padding: 6, display: "flex", flexDirection: "column", ...(appliedMaxWidth != null ? { maxWidth: appliedMaxWidth } : null) }}>
      {header}
      {body(false)}
    </Panel>
  );
}
