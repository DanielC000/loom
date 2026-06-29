import { type CSSProperties, useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { SessionListItem } from "@loom/shared";
import { api } from "../lib/api";
import { TerminalPane } from "./Terminal";
import { Composer } from "./Composer";
import { PresetPromptsButton } from "./PresetPrompts";
import { Panel, Button, StatusPill } from "./ui";
import { color, font } from "../theme";

// Hand-rolled platform/operator session tile — the SHARED unit used by ALL THREE Platform session
// surfaces (the DEV view's PlatformSessions grid + the end-user SetupSession / AuditorSession), so the
// header controls (status + PresetPrompts + Stop + maximize) and the maximize behavior can't drift
// across the dev/end-user editions (same rationale as TerminalTile's own extraction).
//
// DELIBERATELY NOT TerminalTile: these are ELEVATED platform/operator sessions (Lead / Auditor /
// operator), so they must NOT expose Fork — forking would mint a second ELEVATED session off-screen,
// bypassing the deliberate human go-live action (the reason these tiles are hand-rolled in the first
// place). Spawning is always an explicit control on the Platform page, never an incidental Fork. (The
// Lead is no longer a singleton — the human may run several — but a fresh Lead is spawned from the
// Agents controls, not forked from a tile.) The per-spot differences are props: tile
// `height`, an optional `maxWidth` (the single-session end-user tiles cap their width), and the Stop
// button's `title` (the Auditor names "this Auditor run").
//
// Maximize opens a full-viewport OVERLAY rather than a full-page takeover: the Platform page is a
// structured multi-section console, so an overlay (dim backdrop, ~90vw×~88vh) reads better than
// swapping the whole page. The TerminalPane REMOUNTS into the overlay and re-attaches over WS — the
// same established pattern Terminals.tsx uses for its maximize (a conditional render that swaps the
// pane location, never a fragile DOM move). The Composer stays mounted under the terminal in both
// states, so it's usable while maximized. Restore via the ⤡ toggle, a backdrop click, or Esc.
export function PlatformSessionTile({
  session, height, maxWidth, stopTitle = "Stop this session — graceful Ctrl-C, clean and resumable",
}: {
  session: SessionListItem;
  height: number | string;
  maxWidth?: number | string;
  stopTitle?: string;
}) {
  const qc = useQueryClient();
  const [maximized, setMaximized] = useState(false);
  const stop = useMutation({
    mutationFn: (id: string) => api.stopSession(id, "graceful"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["allSessions"] }),
  });

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
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontFamily: font.mono, fontSize: 12, color: color.textDim }}>
        <StatusPill tone={session.busy ? "amber" : "phosphor"} glow={session.busy} label={session.busy ? "busy" : "idle"} />
        <span>{session.agentName}{session.role ? ` · ${session.role}` : ""} · {session.id.slice(0, 8)}</span>
      </span>
      <div style={{ display: "flex", gap: 4 }}>
        <PresetPromptsButton sessionId={session.id} />
        {/* No Fork on platform sessions — forking would mint a second ELEVATED session (Lead/Auditor/operator) off-screen, bypassing the human go-live action. Spawn a fresh Lead from the Agents controls instead. */}
        <Button style={{ padding: "0 8px" }} disabled={stop.isPending} title={stopTitle}
          onClick={() => stop.mutate(session.id)}>Stop</Button>
        <Button style={{ padding: "0 6px" }} title={maximized ? "Restore terminal (Esc)" : "Maximize terminal"}
          onClick={() => setMaximized((m) => !m)}>{maximized ? "⤡" : "⤢"}</Button>
      </div>
    </div>
  );
  const body = (
    <>
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}><TerminalPane sessionId={session.id} /></div>
      <Composer sessionId={session.id} />
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
            {body}
          </Panel>
        </div>
      </div>
    );
  }

  return (
    <Panel style={{ height, padding: 6, display: "flex", flexDirection: "column", ...(maxWidth != null ? { maxWidth } : null) }}>
      {header}
      {body}
    </Panel>
  );
}
