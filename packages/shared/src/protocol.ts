// Wire protocol shared by daemon and web.
//
// Terminal WebSocket  (/ws/term/:sessionId):
//   server -> client: BINARY frames = raw pty bytes; TEXT frames = JSON TerminalControl
//   client -> server: TEXT frames = JSON TerminalInput
// Claude ptys are pinned to a fixed geometry (viewers scale by font size); only SHELL terminals
// negotiate size — a `resize` from the viewer is honored for shells and ignored for Claude ptys
// (the alt-screen repaint invariant). See ShellTerminal below.

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
  | { type: "repaint" }                 // force Ctrl-L repaint (tearing mitigation)
  | { type: "resize"; cols: number; rows: number }; // SHELL terminals only — fit the pty to the pane

/**
 * A plain interactive SHELL terminal (pwsh/cmd/bash) the HUMAN spawned in a project's repo cwd from
 * the Terminals page — NOT a Claude session (no agent, engine id, role, busy, or resumability). Lives
 * in-memory in PtyHost; this is the listing shape for the web to re-attach after a detach/reload. See
 * the trust-boundary note on POST /api/terminals: spawning a shell is host-RCE-by-design, so it is a
 * HUMAN-ONLY REST endpoint and deliberately NOT exposed as an MCP tool.
 */
export interface ShellTerminal {
  id: string;
  cwd: string;
  command: string;
  label: string;
  alive: boolean;
}

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
