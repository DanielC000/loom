import type { SessionListItem } from "@loom/shared";
import { TerminalCard } from "./TerminalCard";

// One live Claude-session terminal tile — the SHARED unit used by BOTH the dedicated Terminals page and
// the project Overview's ProjectTerminals grid AND the single-session `/session/:id` view, so the three
// header control surfaces can't drift.
//
// As of the terminal-unification epic (stage 1, `Projects/Loom/Design/Terminal Unification Plan.md`),
// TerminalTile is a thin binding over the shared <TerminalCard> base: it's the FULL-feature reference
// variant, so it enables every capability — Fork (idle-only) + graceful Stop + maximize ⤢ in the header,
// PresetPrompts, and the full sub-panel set (bound-task bar / wakes / queued messages / composer) in the
// body. All the frame/header/maximize/body mechanics live in TerminalCard; the per-session chrome and
// the HUG-vs-FILL height model are carried there unchanged. `showProject` toggles the project name in the
// title (Terminals lists all projects; Overview is project-scoped). The Fork/Stop MUTATIONS still live at
// the call sites (Terminals / Overview / SessionView) and arrive as handler props — de-duping those into
// a shared hook is a later stage of the epic.

// Re-exported from their canonical home (TerminalCard) for existing call sites that import them here.
export { ForkButton, StopButton, TileTitle } from "./TerminalCard";

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
  return (
    <TerminalCard
      session={s}
      height={height}
      showProject={showProject}
      offerFork
      onFork={onFork}
      forkPending={forkPending}
      lifecycle="stop"
      onStop={onStop}
      stopPending={stopPending}
      maximizable
      statusMode="busy"
      subPanels={{ queue: true, wakes: true, taskCard: true }}
    />
  );
}
