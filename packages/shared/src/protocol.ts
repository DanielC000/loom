// Wire protocol shared by daemon and web.
//
// Terminal WebSocket  (/ws/term/:sessionId):
//   server -> client: BINARY frames = raw pty bytes; TEXT frames = JSON TerminalControl
//   client -> server: TEXT frames = JSON TerminalInput
// No `resize` in phase 1 — the pty is pinned to a fixed geometry; viewers scale by font size.

export type TerminalControl =
  | { type: "sessionId"; id: string }   // engine session id captured/known
  | { type: "reset" }                   // pty respawned (resume) — clear xterm
  | { type: "busy"; busy: boolean }     // a turn started (true) / ended (false) — hook-driven
  | { type: "exit"; code: number | null }
  | { type: "dead" }                    // stored engine id no longer resumable
  // INFO ONLY: the daemon telling a viewer the pinned pty grid so it can size its xterm
  // (resize the grid to match + scale fontSize to fill the tile). This is NOT resize
  // negotiation — the viewer never resizes the pty; the pin stays viewer-independent.
  | { type: "geometry"; cols: number; rows: number };

export type TerminalInput =
  | { type: "stdin"; data: string }
  | { type: "repaint" };                // force Ctrl-L repaint (tearing mitigation)

// REST DTOs (subset; expanded during the build).
export interface SpawnSessionRequest {
  projectId: string;
  agentId: string;
  /** Omit to resume; present to start a NEW session (the agent's startup prompt). */
  startNew: boolean;
}

export interface ResumeSessionRequest {
  sessionId: string;
}

export type StopMode = "graceful" | "hard";
export interface StopSessionRequest {
  sessionId: string;
  mode: StopMode;
}
