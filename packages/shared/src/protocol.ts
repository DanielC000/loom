// Wire protocol shared by daemon and web.
//
// Terminal WebSocket  (/ws/term/:sessionId):
//   server -> client: BINARY frames = raw pty bytes; TEXT frames = JSON TerminalControl
//   client -> server: TEXT frames = JSON TerminalInput
// No `resize` in phase 1 — the pty is pinned to a fixed geometry; viewers scale by font size.

export type TerminalControl =
  | { type: "sessionId"; id: string }   // engine session id captured/known
  | { type: "reset" }                   // pty respawned (resume) — clear xterm
  | { type: "exit"; code: number | null }
  | { type: "dead" };                   // stored engine id no longer resumable

export type TerminalInput =
  | { type: "stdin"; data: string }
  | { type: "repaint" };                // force Ctrl-L repaint (tearing mitigation)

// REST DTOs (subset; expanded during the build).
export interface SpawnSessionRequest {
  projectId: string;
  topicId: string;
  /** Omit to resume; present to start a NEW session (the topic's startup prompt). */
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
