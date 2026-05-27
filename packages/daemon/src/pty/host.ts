import fs from "node:fs";
import path from "node:path";
import { spawn, type IPty } from "node-pty";
import type { PermissionPolicy, PtyGeometry, SessionRole } from "@loom/shared";
import type { TerminalControl, StopMode } from "@loom/shared";
import { resolveExecutable } from "./resolve-bin.js";
import { writeSessionSettings } from "./claude-settings.js";
import { ensureTrusted } from "./claude-config.js";
import { readContextStats, type ContextStats } from "../sessions/context.js";
import { PORT, LOGS_DIR } from "../paths.js";

const RING_CAP_BYTES = 256 * 1024;

interface Subscriber {
  onData: (b: Buffer) => void;
  onControl: (e: TerminalControl) => void;
}

interface Live {
  pty: IPty;
  pid: number;
  cwd: string;
  engineSessionId: string | null;
  ring: { chunks: Buffer[]; bytes: number };
  subscribers: Set<Subscriber>;
  alive: boolean;
  logStream: fs.WriteStream;
}

export interface SpawnOpts {
  sessionId: string;          // Loom session id
  cwd: string;                // = project repoPath
  permission: PermissionPolicy;
  geometry: PtyGeometry;
  sessionEnv: Record<string, string>;
  /** New session: the topic startup prompt (injected once). Resume: omit. */
  startupPrompt?: string;
  /** Resume: Claude engine session id. */
  resumeId?: string;
  /** A manager also gets the loom-orchestration MCP (+ its allowlist); workers/plain do not. */
  role?: SessionRole;
}

export interface PtyHostEvents {
  onEngineSessionId(sessionId: string, engineId: string): void;
  /** Persist the turn-in-flight flag (rising on UserPromptSubmit, falling on Stop/StopFailure). */
  onBusy(sessionId: string, busy: boolean): void;
  /** Persist measured engine-context occupancy, refreshed at each turn boundary (Stop). */
  onContextStats(sessionId: string, stats: ContextStats): void;
  onExit(sessionId: string, code: number | null): void;
}

/**
 * Owns all interactive `claude` ptys. Independent of any browser — sessions live here.
 * Implements the spike-validated gate-free spawn recipe (acceptEdits + allowlist,
 * --strict-mcp-config WITH an explicit --mcp-config so the .mcp.json prompt never blocks,
 * absolute bin path for the Windows node-pty agent, env scrub + main-screen scrollback).
 */
export class PtyHost {
  private live = new Map<string, Live>();
  constructor(private events: PtyHostEvents) {}

  spawn(opts: SpawnOpts): void {
    const bin = resolveExecutable(process.env.LOOM_CLAUDE_BIN || "claude");
    ensureTrusted(opts.cwd); // pre-accept the workspace-trust dialog so warmup never blocks
    const isManager = opts.role === "manager";
    // A manager also gets the orchestration MCP. acceptEdits does NOT auto-approve MCP tools
    // (the §9 lesson — that's why mcp__loom-tasks is in the default allow), so allowlist
    // mcp__loom-orchestration too, else the manager hangs on a permission prompt calling worker_*.
    const permission = isManager
      ? { ...opts.permission, allow: [...opts.permission.allow, "mcp__loom-orchestration"] }
      : opts.permission;
    const settingsPath = writeSessionSettings(opts.sessionId, permission);

    const args: string[] = [];
    if (opts.resumeId) args.push("--resume", opts.resumeId);
    if (opts.startupPrompt) args.push(opts.startupPrompt); // positional MUST precede variadic --mcp-config
    args.push("--settings", settingsPath);
    args.push("--permission-mode", permission.mode);
    // §6 scoping: route by session id in the URL path; daemon derives the project server-side.
    const mcpServers: Record<string, unknown> = {
      "loom-tasks": { type: "http", url: `http://127.0.0.1:${PORT}/mcp/${opts.sessionId}` },
    };
    if (isManager) {
      mcpServers["loom-orchestration"] = { type: "http", url: `http://127.0.0.1:${PORT}/mcp-orch/${opts.sessionId}` };
    }
    args.push("--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers }));

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) continue;
      if (v !== undefined) env[k] = v;
    }
    Object.assign(env, opts.sessionEnv);

    // eslint-disable-next-line no-console
    console.log(`[pty] spawn ${opts.sessionId} bin=${bin} cwd=${opts.cwd} resume=${opts.resumeId ?? "none"} args=${JSON.stringify(args)}`);
    const pty = spawn(bin, args, {
      name: "xterm-256color",
      cols: opts.geometry.cols,
      rows: opts.geometry.rows,
      cwd: opts.cwd,
      env,
    });

    const live: Live = {
      pty, pid: pty.pid, cwd: opts.cwd,
      engineSessionId: opts.resumeId ?? null,
      ring: { chunks: [], bytes: 0 },
      subscribers: new Set(),
      alive: true,
      logStream: fs.createWriteStream(path.join(LOGS_DIR, `${opts.sessionId}.log`)),
    };
    this.live.set(opts.sessionId, live);

    pty.onData((d) => {
      const buf = Buffer.from(d, "utf-8");
      this.appendRing(live, buf);
      live.logStream.write(buf);
      for (const s of live.subscribers) { try { s.onData(buf); } catch { /* ignore */ } }
    });
    pty.onExit(({ exitCode }) => {
      live.alive = false;
      // eslint-disable-next-line no-console
      console.log(`[pty] exit ${opts.sessionId} code=${exitCode}`);
      try { live.logStream.end(); } catch { /* ignore */ }
      this.broadcastControl(live, { type: "exit", code: exitCode });
      this.events.onExit(opts.sessionId, exitCode);
    });

    // A new session runs its startup-prompt turn immediately. Set busy optimistically so
    // GET /api/sessions is correct within the ~250ms before the UserPromptSubmit hook lands;
    // the hook then re-asserts the same value (idempotent). Resume injects no prompt, so no set.
    if (opts.startupPrompt) this.setBusy(opts.sessionId, true);
  }

  /** Called by the hook endpoint when a relayed hook arrives. Routes the busy state machine. */
  deliverHook(sessionId: string, hook: { hook_event_name?: string; session_id?: string }): void {
    const live = this.live.get(sessionId);
    if (!live) return;
    // eslint-disable-next-line no-console
    console.log(`[hook] ${sessionId} ${hook.hook_event_name ?? "?"} session_id=${hook.session_id ?? "-"}`);
    switch (hook.hook_event_name) {
      case "SessionStart":
        // Capture the engine session id once (unchanged from phase 1).
        if (typeof hook.session_id === "string" && !live.engineSessionId) {
          live.engineSessionId = hook.session_id;
          this.events.onEngineSessionId(sessionId, hook.session_id);
          this.broadcastControl(live, { type: "sessionId", id: hook.session_id });
        }
        break;
      case "UserPromptSubmit":
        this.setBusy(sessionId, true); // rising edge — fires for the startup-prompt arg and injected prompts alike
        break;
      case "Stop":
      case "StopFailure":
        this.setBusy(sessionId, false); // falling edge — exactly one Stop per end-of-turn (no per-tool-use)
        // Refresh context occupancy at the turn boundary. Cheap tail-read; done for EVERY session
        // (the host doesn't know role — a manager's own occupancy matters too, "who recycles the manager").
        if (live.engineSessionId) {
          const stats = readContextStats(live.cwd, live.engineSessionId);
          if (stats) this.events.onContextStats(sessionId, stats);
        }
        break;
    }
  }

  /** Persist + broadcast the turn-in-flight flag. Idempotent; safe to call repeatedly. */
  private setBusy(sessionId: string, busy: boolean): void {
    const live = this.live.get(sessionId);
    if (!live) return;
    this.events.onBusy(sessionId, busy);
    this.broadcastControl(live, { type: "busy", busy });
  }

  subscribe(sessionId: string, sub: Subscriber): () => void {
    const live = this.live.get(sessionId);
    if (!live) return () => {};
    // Replay ring so a LATE attach sees a coherent screen, then stream live.
    const sb = Buffer.concat(live.ring.chunks);
    if (sb.length) sub.onData(sb);
    if (live.engineSessionId) sub.onControl({ type: "sessionId", id: live.engineSessionId });
    if (!live.alive) sub.onControl({ type: "exit", code: null });
    live.subscribers.add(sub);
    return () => { live.subscribers.delete(sub); };
  }

  writeStdin(sessionId: string, data: string): void {
    const live = this.live.get(sessionId);
    if (live?.alive) live.pty.write(data);
  }

  repaint(sessionId: string): void {
    const live = this.live.get(sessionId);
    if (live?.alive) live.pty.write("\x0c"); // Ctrl-L
  }

  stop(sessionId: string, mode: StopMode): void {
    const live = this.live.get(sessionId);
    if (!live?.alive) return;
    if (mode === "hard") {
      live.pty.kill(); // TerminateProcess on Windows; node-pty Job Object kills the tree (no orphans)
      return;
    }
    // graceful: double Ctrl-C, leaves the session resumable
    live.pty.write("\x03");
    setTimeout(() => { if (live.alive) live.pty.write("\x03"); }, 600);
  }

  isAlive(sessionId: string): boolean {
    return this.live.get(sessionId)?.alive ?? false;
  }

  private appendRing(live: Live, buf: Buffer): void {
    live.ring.chunks.push(buf);
    live.ring.bytes += buf.length;
    while (live.ring.bytes > RING_CAP_BYTES && live.ring.chunks.length > 1) {
      live.ring.bytes -= live.ring.chunks.shift()!.length;
    }
  }

  private broadcastControl(live: Live, e: TerminalControl): void {
    for (const s of live.subscribers) { try { s.onControl(e); } catch { /* ignore */ } }
  }
}
