import { type ReactNode } from "react";
import type { SessionListItem } from "@loom/shared";
import { TerminalPane } from "./Terminal";
import { Composer } from "./Composer";
import { SessionQueue } from "./SessionQueue";
import { SessionWakes } from "./SessionWakes";
import { PresetPromptsButton } from "./PresetPrompts";
import { Panel, Button, StatusPill } from "./ui";
import { font, color } from "../theme";

// One live Claude-session terminal tile — the SHARED unit used by BOTH the dedicated Terminals page
// and the project Overview's ProjectTerminals grid, so the two header control surfaces can't drift
// (same rationale as the byCreatedStable comparator extraction). Header controls: Fork (idle-only),
// maximize ⤢ (only when `onMaximize` is given — omitted in the single full-size view), Stop.
// `showProject` toggles the project name in the title (Terminals lists all projects; Overview is
// project-scoped). The `taskCard` slot (above the terminal) lets each surface add its own extras
// without forking the tile. ALL the per-session chrome below the terminal — SessionWakes, the
// QUEUED-messages panel (SessionQueue) and the Composer — lives INSIDE the tile, so EVERY surface
// that renders a tile (the Terminals page AND the Overview grid) shows the identical set and a page
// can't drift. (Wakes + the queue both used to ride a per-page `footer` prop; the Overview grid,
// which passed no footer, silently dropped them — the regression this consolidation prevents.)

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
  s, height, showProject, onFork, forkPending, onStop, stopPending, onMaximize, taskCard,
}: {
  s: SessionListItem;
  height: number | string;
  showProject?: boolean;
  onFork: () => void;
  forkPending: boolean;
  onStop: () => void;
  stopPending: boolean;
  onMaximize?: () => void;   // omit → no ⤢ (the already-maximized single view)
  taskCard?: ReactNode;      // slot rendered above the terminal
}) {
  return (
    <Panel style={{ height, padding: 6, display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <TileTitle s={s} showProject={showProject} />
        <div style={{ display: "flex", gap: 4 }}>
          <PresetPromptsButton sessionId={s.id} />
          <ForkButton onFork={onFork} busy={s.busy} pending={forkPending} />
          <StopButton onStop={onStop} stopping={stopPending} />
          {onMaximize && <Button style={{ padding: "0 6px" }} onClick={onMaximize}>⤢</Button>}
        </div>
      </div>
      {taskCard}
      {/* overflow:hidden clips xterm's canvas to the pane box — when a Composer state change (e.g.
          toggling Voice) resizes the pane, the font rescale can momentarily overflow; this guarantees
          the terminal can NEVER paint over the composer below. xterm scrolls via its own .xterm-viewport. */}
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}><TerminalPane sessionId={s.id} /></div>
      <SessionWakes sessionId={s.id} />
      <SessionQueue sessionId={s.id} />
      <Composer sessionId={s.id} />
    </Panel>
  );
}
