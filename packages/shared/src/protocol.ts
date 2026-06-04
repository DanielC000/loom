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

// ── Plan-usage status (GET /api/usage/limits) ──────────────────────────────────
// The user's REAL Claude *account/plan* usage (rate-limit headroom), fetched daemon-side from the
// undocumented OAuth usage endpoint and cached. DISTINCT from Loom's /usage page (context occupancy
// per session). Camel-cased here to match the rest of the REST DTOs; the raw endpoint is snake_case.

/** One usage window: `utilization` is 0–100; `resetsAt` is an ISO-8601 instant or null (no active reset). */
export interface UsageWindow {
  utilization: number;
  resetsAt: string | null;
}

/** Extra-usage (paid overflow) balance — only meaningful when `isEnabled`. */
export interface UsageExtra {
  isEnabled: boolean;
  monthlyLimit: number | null;
  usedCredits: number | null;
  utilization: number | null; // 0–100, null when not yet metered
}

/**
 * The parsed, cached plan-usage status. `available:false` is the graceful-degrade state (no token,
 * expired, network/HTTP error, schema drift) — Mission Control renders a muted note, never an error.
 */
export type UsageLimitsStatus =
  | {
      available: true;
      fetchedAt: string; // ISO — when this snapshot was fetched
      fiveHour: UsageWindow;
      sevenDay: UsageWindow;
      sevenDayOpus: UsageWindow | null;
      sevenDaySonnet: UsageWindow | null;
      extraUsage: UsageExtra | null;
    }
  | {
      available: false;
      reason: string;
      fetchedAt: string | null; // ISO of the last attempt, null if never tried
    };
