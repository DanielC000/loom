import { type CSSProperties, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { SessionListItem, Wake } from "@loom/shared";
import { api, type QueuedMessage } from "../lib/api";
import { TerminalPane } from "./Terminal";
import { TranscriptPane } from "./TranscriptPane";
import { Composer } from "./Composer";
import { SessionQueue } from "./SessionQueue";
import { SessionWakes } from "./SessionWakes";
import { SessionTaskCard } from "./SessionTaskCard";
import { Panel, Button, StatusPill } from "./ui";
import { font, color } from "../theme";

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
// STAGE 4 (`ShellTile` + `CompanionTerminal`) resolved the deferred non-"busy" status question in favor
// of the `title` OVERRIDE rather than implementing the `statusMode` "static"/"conn" branches: a raw shell
// and a read-only companion window are not DB Sessions with a live busy signal, so each supplies its own
// header node (a "shell" / "read-only" StatusPill) via `title`. `statusMode` therefore stays typed (the
// enum keeps the call sites shaped) with only the "busy" path implemented; no consumer needs the others.

export type TerminalLifecycle = "stop" | "kill" | "none";
export type TerminalStatusMode = "busy" | "static" | "conn";
export type TerminalTab = "terminal" | "transcript" | "timeline" | "diff";

// The base reads only a small subset off `session`: the default `TileTitle` needs the identity/status
// quartet (busy/project/agent/role/id) and the taskCard query needs the project/task ids — never a full
// DB Session. Narrowing to this lets a NON-DB-Session surface (a raw `ShellTile` shell, a `CompanionTerminal`
// watch window) mount the SAME frame by passing just `{ id }`, with its own `title` + `renderBody`, instead
// of faking a `Session` row. Every existing consumer still passes a full `SessionListItem` — structurally
// assignable, so those call sites are byte-identical. `id` is the only field a title-override + renderBody
// consumer actually surfaces; the rest are optional and consumed only by the default title/task paths.
export type TerminalCardSession = Pick<SessionListItem, "id"> &
  Partial<Pick<SessionListItem, "projectId" | "taskId" | "busy" | "role" | "agentName" | "projectName">>;

// Optional role-scoped tab bar. When provided, the body gains a Terminal + Transcript tab bar (both
// owned by the base — the shared TerminalPane / TranscriptPane), plus a Timeline and/or Diff tab ONLY
// when the caller passes that panel node (a manager passes `timeline`, a worker passes `diff` — same
// role scoping the inline SessionCockpit had). The extra panels are Overview-specific (orchestration
// events / branch diff), so they arrive as ready-rendered nodes rather than being wired into the base.
export interface TerminalTabs {
  timeline?: ReactNode; // manager-only: the orchestration-events timeline panel
  diff?: ReactNode; // worker-only: the branch-diff panel
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

export function ForkButton({ onFork, busy, pending }: { onFork: () => void; busy: boolean; pending: boolean }) {
  return (
    <Button style={{ padding: "0 8px" }} disabled={busy || pending}
      title={busy ? "Fork is available when the session is idle" : "Fork — branch this conversation into a new divergent session"}
      onClick={(ev) => { ev.stopPropagation(); onFork(); }}>Fork</Button>
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
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontFamily: font.mono, fontSize: 12, color: color.textDim }}>
      <StatusPill tone={s.busy ? "amber" : "phosphor"} glow={s.busy} label={s.busy ? "busy" : "idle"} />
      <span>{showProject ? `${s.projectName} · ` : ""}{s.agentName}{s.role ? ` · ${s.role}` : ""} · {s.id.slice(0, 8)}</span>
    </span>
  );
}

export function TerminalCard({
  session,
  height,
  maxWidth,
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
  renderBody,
  actionsExtra,
}: {
  session: TerminalCardSession;
  height: number | string;
  maxWidth?: number | string;
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
  /** Replace the default session body (TerminalPane + sub-panels) — for raw-shell / companion bodies. */
  renderBody?: (ctx: { maximized: boolean; hug: boolean; heightBudget?: number }) => ReactNode;
  /** Extra buttons appended after the standard action cluster. */
  actionsExtra?: ReactNode;
}) {
  void statusMode; // only "busy" is wired; non-busy variants carry a "title" override pill (see header note).
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

  // Role-scoped tab bar (opt-in via `tabs`). Terminal + Transcript are always offered; Timeline/Diff
  // appear only when the caller supplies that panel node. `activeTab` guards against a stale selection
  // (e.g. the "diff" tab if a caller ever stopped passing a diff node) by falling back to "terminal".
  const [tab, setTab] = useState<TerminalTab>("terminal");
  const tabDefs: { key: TerminalTab; label: string }[] = tabs
    ? [
        { key: "terminal", label: "Terminal" },
        { key: "transcript", label: "Transcript" },
        ...(tabs.timeline != null ? ([{ key: "timeline", label: "Timeline" }] as const) : []),
        ...(tabs.diff != null ? ([{ key: "diff", label: "Diff" }] as const) : []),
      ]
    : [];
  const activeTab: TerminalTab = tabDefs.some((t) => t.key === tab) ? tab : "terminal";

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
    queryFn: () => api.tasks(session.projectId ?? ""),
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
  }, [hug, maximized, height, activeTab, !!task, readOnly, !!tabs,
      subPanels?.queue, subPanels?.wakes, subPanels?.taskCard]);

  const lifecycleButton = lifecycle === "kill"
    ? <Button variant="danger" style={{ padding: "0 8px" }} disabled={stopPending}
        title={stopTitle ?? "Kill this session"} onClick={(ev) => { ev.stopPropagation(); onStop?.(); }}>Kill</Button>
    : lifecycle === "stop"
      ? <StopButton onStop={() => onStop?.()} stopping={stopPending} />
      : null;

  const header = (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
      {title ?? <TileTitle s={session} showProject={showProject} />}
      <div style={{ display: "flex", gap: 4 }}>
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
  const sessionBody = (hugMode: boolean, heightBudget?: number) => (
    <>
      {task && <SessionTaskCard task={task} />}
      {tabs && (
        <div style={{ marginBottom: 6, display: "flex", gap: 6, flexShrink: 0 }}>
          {tabDefs.map((t) => (
            <Button key={t.key} variant={activeTab === t.key ? "primary" : "default"}
              onClick={() => setTab(t.key)}>{t.label}</Button>
          ))}
        </div>
      )}
      {/* Terminal (default) OR — with tabs — the active pane. TerminalPane is mounted ONLY on the
          Terminal tab so a card viewing Transcript/Timeline/Diff holds no live pty websocket (single
          live terminal, mirroring the old SessionCockpit). overflow:hidden clips xterm's canvas to the
          pane box — a Composer state change (e.g. toggling Voice) can momentarily overflow the font
          rescale; this guarantees the terminal can NEVER paint over the composer below. xterm scrolls
          via its own .xterm-viewport. */}
      {(!tabs || activeTab === "terminal") && (
        <div ref={paneWrapRef} style={{ ...(hugMode ? null : { flex: 1 }), minHeight: 0, overflow: "hidden" }}>
          <TerminalPane sessionId={session.id} readOnly={readOnly} resizable={resizable} heightBudget={heightBudget} />
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
      {tabs && activeTab === "diff" && tabs.diff}
      {/* Below-terminal strip. Observed by the budget measurement (belowRef) so a queued turn / opened
          large editor re-measures even when the card is already at its height cap. flexShrink:0 keeps the
          composer + strips at natural height — the terminal is the element that gives up space. */}
      <div ref={belowRef} style={{ flexShrink: 0 }}>
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
        {!readOnly && <Composer sessionId={session.id} />}
      </div>
    </>
  );
  const body = (maximizedNow: boolean) => {
    const hugMode = !maximizedNow && hug;
    // Prefer the MEASURED leftover space; fall back to the fixed reserve for the first paint (before the
    // layout effect runs). Non-HUG (fill) passes no budget — the pane flexes to fill its slot.
    const heightBudget = hugMode ? (measuredBudget ?? (height as number) - CHROME_RESERVE) : undefined;
    return renderBody
      ? renderBody({ maximized: maximizedNow, hug: hugMode, heightBudget })
      : sessionBody(hugMode, heightBudget);
  };

  if (maximizable && maximized) {
    const overlay: CSSProperties = {
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.66)", display: "flex",
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

  return (
    <Panel style={{ ...(hug ? { maxHeight: (height as number) + (queueChromeH > 0 ? queueChromeH + BUDGET_SLACK : 0) } : { height }), padding: 6, display: "flex", flexDirection: "column", ...(maxWidth != null ? { maxWidth } : null) }}>
      {header}
      {body(false)}
    </Panel>
  );
}
