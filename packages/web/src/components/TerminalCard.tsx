import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { SessionListItem } from "@loom/shared";
import { api } from "../lib/api";
import { TerminalPane } from "./Terminal";
import { Composer } from "./Composer";
import { SessionQueue } from "./SessionQueue";
import { SessionWakes } from "./SessionWakes";
import { SessionTaskCard } from "./SessionTaskCard";
import { PresetPromptsButton } from "./PresetPrompts";
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
// DEFERRED from the plan's full prop surface, by design, to the stages that actually exercise them (so
// stage 1 ships no untested branches): `tabs` (terminal+transcript, role-scoped timeline/diff — only
// SessionCockpit has these today; land with stage 3) and the `statusMode` variants beyond "busy"
// ("static"/"conn" — land with the Shell/Companion stage 4). The enums are typed here so the downstream
// call sites are already shaped; only the "busy" path is implemented. Reported up in the stage-1 note.

export type TerminalLifecycle = "stop" | "kill" | "none";
export type TerminalStatusMode = "busy" | "static" | "conn";

export interface TerminalSubPanels {
  presets?: boolean; // PresetPrompts button in the header action cluster
  queue?: boolean; // SessionQueue strip below the terminal
  wakes?: boolean; // SessionWakes strip below the terminal
  taskCard?: boolean; // slim bound-board-task bar above the terminal
}

// header + composer + status line + panel padding (approx, generous) — the HUG budget reserve.
const CHROME_RESERVE = 112;

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

export function TileTitle({ s, showProject }: { s: SessionListItem; showProject?: boolean }) {
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
  renderBody,
  actionsExtra,
}: {
  session: SessionListItem;
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
  /** Replace the default session body (TerminalPane + sub-panels) — for raw-shell / companion bodies. */
  renderBody?: (ctx: { maximized: boolean; hug: boolean; heightBudget?: number }) => ReactNode;
  /** Extra buttons appended after the standard action cluster. */
  actionsExtra?: ReactNode;
}) {
  void statusMode; // only "busy" is wired in stage 1 (title carries the pill); see header note above.
  const [maximized, setMaximized] = useState(false);

  // Resolve the board task this session is bound to and render the slim bar in the body, so every call
  // site shows it without re-wiring. Keyed ["tasks", projectId] (staleTime 4000) so React Query DEDUPES
  // it across a project's tiles — one fetch per project, not per tile. Only fetch for a bound session
  // when the task-card panel is enabled; an id that doesn't resolve leaves `task` undefined → no bar.
  const wantTaskCard = !!subPanels?.taskCard;
  const tasks = useQuery({
    queryKey: ["tasks", session.projectId],
    queryFn: () => api.tasks(session.projectId),
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
        {subPanels?.presets && <PresetPromptsButton sessionId={session.id} />}
        {offerFork && <ForkButton onFork={() => onFork?.()} busy={session.busy} pending={forkPending} />}
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
  // composer. Give the TerminalPane a height BUDGET and let it shrink to the grid it actually renders,
  // so the composer sits flush beneath and the card hugs the terminal. HUG is gated to NUMERIC heights
  // only: a STRING height (e.g. "76vh") is a fill-the-space page terminal that keeps the old `flex:1` +
  // `height` fill (no budget) — clamping it to a fixed px budget would shrink it. Maximized always fills.
  const hug = typeof height === "number";
  const sessionBody = (hugMode: boolean, heightBudget?: number) => (
    <>
      {task && <SessionTaskCard task={task} />}
      {/* overflow:hidden clips xterm's canvas to the pane box — when a Composer state change (e.g.
          toggling Voice) resizes the pane, the font rescale can momentarily overflow; this guarantees
          the terminal can NEVER paint over the composer below. xterm scrolls via its own .xterm-viewport. */}
      <div style={{ ...(hugMode ? null : { flex: 1 }), minHeight: 0, overflow: "hidden" }}>
        <TerminalPane sessionId={session.id} readOnly={readOnly} resizable={resizable} heightBudget={heightBudget} />
      </div>
      {subPanels?.wakes && <SessionWakes sessionId={session.id} />}
      {subPanels?.queue && <SessionQueue sessionId={session.id} />}
      {!readOnly && <Composer sessionId={session.id} />}
    </>
  );
  const body = (maximizedNow: boolean) => {
    const hugMode = !maximizedNow && hug;
    const heightBudget = hugMode ? (height as number) - CHROME_RESERVE : undefined;
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
    <Panel style={{ ...(hug ? { maxHeight: height } : { height }), padding: 6, display: "flex", flexDirection: "column", ...(maxWidth != null ? { maxWidth } : null) }}>
      {header}
      {body(false)}
    </Panel>
  );
}
