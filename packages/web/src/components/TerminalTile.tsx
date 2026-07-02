import { type CSSProperties, useEffect, useState } from "react";
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

// One live Claude-session terminal tile — the SHARED unit used by BOTH the dedicated Terminals page
// and the project Overview's ProjectTerminals grid, so the two header control surfaces can't drift
// (same rationale as the byCreatedStable comparator extraction). Header controls: Fork (idle-only),
// Stop, and maximize ⤢. `showProject` toggles the project name in the title (Terminals lists all
// projects; Overview is project-scoped). The slim bound-task bar above the terminal (which board card
// the session is on) is fetched HERE for the tile's own session, so EVERY surface that renders a tile
// (Terminals AND the Overview grid) shows it automatically — it can't be dropped at a call site the way
// it was when Overview migrated onto the shared tile without re-wiring the old `taskCard` prop. ALL the
// per-session chrome below the terminal —
// SessionWakes, the QUEUED-messages panel (SessionQueue) and the Composer — lives INSIDE the tile, so
// EVERY surface that renders a tile (the Terminals page AND the Overview grid) shows the identical set
// and a page can't drift. (Wakes + the queue both used to ride a per-page `footer` prop; the Overview
// grid, which passed no footer, silently dropped them — the regression this consolidation prevents.)
//
// Maximize is SELF-CONTAINED here (mirroring PlatformSessionTile): the ⤢ opens a full-viewport OVERLAY
// — a dim backdrop with the tile floating centered at ~90vw×88vh — rather than the old in-page swap
// that replaced the whole grid with one 84vh tile + a "← back to grid" button. The TerminalPane
// REMOUNTS into the overlay and re-attaches over WS (the proven conditional-render pattern, never a
// fragile DOM move). Restore via the ⤡ toggle, a backdrop click, or Esc. Owning the state here means
// the parent pages (Terminals + Overview) carry NO maximize wiring — a stopped session just unmounts
// its tile and the overlay closes with it.

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

export function TerminalTile({
  s, height, showProject, onFork, forkPending, onStop, stopPending,
}: {
  s: SessionListItem;
  height: number | string;
  showProject?: boolean;
  onFork: () => void;
  forkPending: boolean;
  onStop: () => void;
  stopPending: boolean;
}) {
  const [maximized, setMaximized] = useState(false);

  // Resolve the board task this session is bound to and render the slim bar HERE, so every call site
  // shows it without re-wiring (Overview used to pass nothing → blank). Same query as the Terminals page
  // (keyed ["tasks", projectId], staleTime 4000), so React Query DEDUPES it across the project's tiles —
  // one fetch per project, not one per tile. Only fetch for a bound session; an id that doesn't resolve
  // (deleted task, not yet loaded) leaves `task` undefined → no bar (graceful, byte-identical to before).
  const tasks = useQuery({
    queryKey: ["tasks", s.projectId],
    queryFn: () => api.tasks(s.projectId),
    staleTime: 4000,
    enabled: !!s.taskId,
  });
  const task = s.taskId ? tasks.data?.find((t) => t.id === s.taskId) : undefined;

  // Esc restores from the maximized overlay (mirrors the backdrop click + the ⤡ toggle). Bound only
  // while maximized so a stray Esc never fires when no overlay is open.
  useEffect(() => {
    if (!maximized) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMaximized(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [maximized]);

  const header = (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
      <TileTitle s={s} showProject={showProject} />
      <div style={{ display: "flex", gap: 4 }}>
        <PresetPromptsButton sessionId={s.id} />
        <ForkButton onFork={onFork} busy={s.busy} pending={forkPending} />
        <StopButton onStop={onStop} stopping={stopPending} />
        <Button style={{ padding: "0 6px" }} title={maximized ? "Restore terminal (Esc)" : "Maximize terminal"}
          onClick={() => setMaximized((m) => !m)}>{maximized ? "⤡" : "⤢"}</Button>
      </div>
    </div>
  );
  // HUG (non-maximized): the pinned 120×40 grid, scaled to fit a narrow tile's WIDTH, is shorter than a
  // fixed pane — which used to leave a large letterbox band between the terminal and the composer (owner
  // report). Instead of a fixed-height pane, give the TerminalPane a height BUDGET and let it shrink to
  // the grid it actually renders, so the composer sits flush beneath and the card hugs the terminal. The
  // budget = the tile height minus the header + composer/footer chrome, so the card never grows past its
  // old height and same-width tiles keep equal heights. Maximized keeps the fill-the-overlay behavior.
  //
  // HUG is gated to NUMERIC heights only — the small grid tiles (Overview + /terminals, `height` 520/540)
  // that actually have the gap. A STRING height (e.g. `/session/:id` passes "76vh") is a fill-the-space
  // page terminal that MUST keep the old `flex:1` + `height` fill (no budget) — clamping it to a fixed
  // px budget would shrink it (the regression this guard prevents).
  const hug = typeof height === "number";
  const CHROME_RESERVE = 112; // header + composer + status line + panel padding (approx, generous)
  const renderBody = (hugMode: boolean) => (
    <>
      {task && <SessionTaskCard task={task} />}
      {/* overflow:hidden clips xterm's canvas to the pane box — when a Composer state change (e.g.
          toggling Voice) resizes the pane, the font rescale can momentarily overflow; this guarantees
          the terminal can NEVER paint over the composer below. xterm scrolls via its own .xterm-viewport. */}
      <div style={{ ...(hugMode ? null : { flex: 1 }), minHeight: 0, overflow: "hidden" }}>
        <TerminalPane sessionId={s.id} heightBudget={hugMode ? (height as number) - CHROME_RESERVE : undefined} />
      </div>
      <SessionWakes sessionId={s.id} />
      <SessionQueue sessionId={s.id} />
      <Composer sessionId={s.id} />
    </>
  );

  if (maximized) {
    const overlay: CSSProperties = {
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.66)", display: "flex",
      alignItems: "center", justifyContent: "center", zIndex: 50, padding: 16,
    };
    return (
      <div style={overlay} onClick={() => setMaximized(false)}>
        <div onClick={(e) => e.stopPropagation()} style={{ width: "90vw", height: "88vh", maxWidth: 1500 }}>
          <Panel style={{ height: "100%", padding: 6, display: "flex", flexDirection: "column" }}>
            {header}
            {renderBody(false)}
          </Panel>
        </div>
      </div>
    );
  }

  return (
    <Panel style={{ ...(hug ? { maxHeight: height } : { height }), padding: 6, display: "flex", flexDirection: "column" }}>
      {header}
      {renderBody(hug)}
    </Panel>
  );
}
