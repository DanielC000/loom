import type { SessionListItem } from "@loom/shared";
import { useStopSession } from "../lib/useSessionActions";
import { TerminalCard } from "./TerminalCard";

// The SHARED tile for ALL THREE Platform session surfaces — the DEV view's PlatformSessions grid + the
// end-user SetupSession / AuditorSession — so their chrome and behavior can't drift across editions.
//
// As of the terminal-unification epic (stage 2, `Projects/Loom/Design/Terminal Unification Plan.md`),
// this is a thin binding over the shared <TerminalCard> base: the frame/header/maximize/body mechanics
// (incl. the full-viewport maximize OVERLAY and the HUG-vs-FILL height model) all live in TerminalCard.
// The Platform tiles gain the full sub-panel set here — PresetPrompts + the wakes / queued-messages /
// bound-task strips — matching TerminalTile, so an operator session shows its queue and wakes like any
// other live session.
//
// DELIBERATELY WITHHELDS Fork (`offerFork={false}`): these are ELEVATED platform/operator sessions
// (Lead / Auditor / operator), and forking would mint a second ELEVATED session off-screen, bypassing
// the deliberate human go-live action. Spawning is always an explicit control on the Platform page,
// never an incidental Fork — a fresh Lead is spawned from the Agents controls, not forked from a tile.
//
// The stop MUTATION stays internal here (both call sites pass only session/height/maxWidth/stopTitle),
// so the DeveloperPlatformView + EndUserPlatformView call sites are unchanged. The per-spot differences
// remain props: tile `height`, an optional `maxWidth` (the single-session end-user tiles cap their
// width), and the Stop button's `title` (the Auditor names "this Auditor run").
export function PlatformSessionTile({
  session, height, maxWidth, stopTitle = "Stop this session — graceful Ctrl-C, clean and resumable",
}: {
  session: SessionListItem;
  height: number | string;
  maxWidth?: number | string;
  stopTitle?: string;
}) {
  const stop = useStopSession();

  return (
    <TerminalCard
      session={session}
      height={height}
      maxWidth={maxWidth}
      offerFork={false}
      lifecycle="stop"
      onStop={() => stop.mutate(session.id)}
      stopPending={stop.isPending}
      stopTitle={stopTitle}
      maximizable
      statusMode="busy"
      subPanels={{ presets: true, queue: true, wakes: true, taskCard: true }}
    />
  );
}
