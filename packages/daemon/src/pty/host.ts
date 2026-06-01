import fs from "node:fs";
import path from "node:path";
import { spawn, type IPty } from "node-pty";
import type { PermissionPolicy, PtyGeometry, SessionRole } from "@loom/shared";
import type { TerminalControl, StopMode } from "@loom/shared";
import { resolveExecutable } from "./resolve-bin.js";
import { writeSessionSettings } from "./claude-settings.js";
import { ensureTrusted } from "./claude-config.js";
import { readContextStats, type ContextStats } from "../sessions/context.js";
import { detectUsageLimit, rateLimitedUntil } from "../orchestration/usage-limit.js";
import { PORT, LOGS_DIR } from "../paths.js";

const RING_CAP_BYTES = 256 * 1024;
/**
 * Gap between writing a turn's text and writing the Enter (\r) that submits it. A SINGLE
 * `text + "\r"` write does NOT submit a second turn to a running claude v2.1.150 session — the
 * trailing \r is swallowed with the text and no UserPromptSubmit fires (observed; this also
 * explains PR #9's earlier injected-turn finding). Writing Enter as a separate write a beat
 * later submits reliably. (Revises the roadmap's S2 "single raw write" note.)
 */
const SUBMIT_ENTER_DELAY_MS = 150;

/**
 * A single large `pty.write` is truncated by Windows ConPTY's input buffer — observed as long
 * worker reports and pastes arriving cut off in the receiving session. Split big writes into
 * paced chunks so the console host drains between them. Keystroke-sized writes take one chunk.
 */
const PTY_WRITE_CHUNK_BYTES = 1024;
const PTY_WRITE_CHUNK_DELAY_MS = 8;

/** Shift+Tab (CSI Z / back-tab) — Claude's TUI cycles the permission mode on this key. */
const SHIFT_TAB = "\x1b[Z";
/** Settle window after SessionStart before sending the first mode-cycle keystroke (let the TUI's input attach). */
const MODE_CYCLE_SETTLE_MS = 700;
/** Gap between successive Shift+Tab presses so each cycle registers as a distinct key event. */
const MODE_CYCLE_INTERVAL_MS = 120;

interface Subscriber {
  onData: (b: Buffer) => void;
  onControl: (e: TerminalControl) => void;
}

interface Live {
  pty: IPty;
  pid: number;
  cwd: string;
  geometry: PtyGeometry; // the pinned grid — sent to each new subscriber (info only, never resized)
  engineSessionId: string | null;
  ring: { chunks: Buffer[]; bytes: number };
  subscribers: Set<Subscriber>;
  alive: boolean;
  logStream: fs.WriteStream;
  busy: boolean;        // a turn is in flight (locally tracked; mirrored to DB via onBusy)
  pending: string[];    // FIFO of messages held while busy — drained one-per-Stop
  lastPrompt: string | null; // the most-recent submitted turn — re-sendable if the cap kills it (§19c-b)
  startupModeCycles: number; // Shift+Tab presses to inject once, after SessionStart, to reach the target mode
  startupCyclesDone: boolean; // guard so the cycle-inject fires at most once per session
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
  /** Role decides the extra MCP surface at spawn: manager/worker → loom-orchestration, platform →
   *  loom-platform (each with its allowlist); plain sessions get only loom-tasks. */
  role?: SessionRole;
  /** When set (docLint on), wires the vault-lint PostToolUse hook scoped to this vault (Pillar D). */
  vaultPath?: string;
}

export interface PtyHostEvents {
  onEngineSessionId(sessionId: string, engineId: string): void;
  /** Persist the turn-in-flight flag (rising on UserPromptSubmit, falling on Stop/StopFailure). */
  onBusy(sessionId: string, busy: boolean): void;
  /** Persist measured engine-context occupancy, refreshed at each turn boundary (Stop). */
  onContextStats(sessionId: string, stats: ContextStats): void;
  /**
   * §19c: the turn ended in a usage-limit StopFailure. `until` is the ISO resume instant; the
   * pty is left ALIVE (a cap doesn't kill it). Wired to persist the park + record global awareness.
   */
  onRateLimited(sessionId: string, until: string, detail: { resetsAtSeconds?: number; message: string }): void;
  onExit(sessionId: string, code: number | null): void;
}

/**
 * Assemble the `claude` argv (extracted so the ordering is unit-testable). The startup/kickoff
 * prompt is positional and goes LAST, behind a `--` end-of-options separator (H2): a manager
 * controls kickoffPrompt, and a prompt beginning with `-`/`--` would otherwise be parsed as a flag.
 * `--` also terminates the variadic `--mcp-config`, so the prompt isn't swallowed as another config
 * value (the reason the prompt used to be placed before --mcp-config). All real flags precede `--`.
 */
export function buildSpawnArgs(o: {
  resumeId?: string;
  settingsPath: string;
  mode: string;
  mcpServers: Record<string, unknown>;
  startupPrompt?: string;
}): string[] {
  const args: string[] = [];
  if (o.resumeId) args.push("--resume", o.resumeId);
  args.push("--settings", o.settingsPath);
  args.push("--permission-mode", o.mode);
  args.push("--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: o.mcpServers }));
  if (o.startupPrompt) args.push("--", o.startupPrompt);
  return args;
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
    // Both managers AND workers get the orchestration MCP — but a role-gated surface: managers
    // get the full coordination tools, workers get only worker_report (resolved server-side). A
    // platform-lead instead gets the loom-platform MCP (project/topic creation, Pillar C). acceptEdits
    // does NOT auto-approve MCP tools (the §9 lesson — why mcp__loom-tasks is in the default allow),
    // so allowlist the role's MCP server too, else the agent hangs on a prompt.
    const wantsOrch = opts.role === "manager" || opts.role === "worker";
    const wantsPlatform = opts.role === "platform";
    const extraAllow = wantsOrch ? ["mcp__loom-orchestration"] : wantsPlatform ? ["mcp__loom-platform"] : [];
    const permission = extraAllow.length
      ? { ...opts.permission, allow: [...opts.permission.allow, ...extraAllow] }
      : opts.permission;
    const settingsPath = writeSessionSettings(opts.sessionId, permission, opts.vaultPath);

    // §6 scoping: route by session id in the URL path; daemon derives the project server-side.
    const mcpServers: Record<string, unknown> = {
      "loom-tasks": { type: "http", url: `http://127.0.0.1:${PORT}/mcp/${opts.sessionId}` },
    };
    if (wantsOrch) {
      mcpServers["loom-orchestration"] = { type: "http", url: `http://127.0.0.1:${PORT}/mcp-orch/${opts.sessionId}` };
    }
    if (wantsPlatform) {
      mcpServers["loom-platform"] = { type: "http", url: `http://127.0.0.1:${PORT}/mcp-platform/${opts.sessionId}` };
    }
    const args = buildSpawnArgs({ resumeId: opts.resumeId, settingsPath, mode: permission.mode, mcpServers, startupPrompt: opts.startupPrompt });

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
      geometry: opts.geometry,
      engineSessionId: opts.resumeId ?? null,
      ring: { chunks: [], bytes: 0 },
      subscribers: new Set(),
      alive: true,
      logStream: fs.createWriteStream(path.join(LOGS_DIR, `${opts.sessionId}.log`)),
      busy: false,
      pending: [],
      // The startup-prompt turn runs from a CLI arg (not submit()), so seed lastPrompt with it —
      // a cap on the FIRST turn must still be re-submittable on resume (§19c-b).
      lastPrompt: opts.startupPrompt ?? null,
      // Boot is always gate-free (acceptEdits); cycle to the target mode once the TUI is up (SessionStart).
      startupModeCycles: opts.permission.startupModeCycles ?? 0,
      startupCyclesDone: false,
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
  deliverHook(
    sessionId: string,
    // StopFailure also carries error/error_details (and a future claude may carry resetsAt) — the
    // relay + /internal/hook forward the whole hook object; we read them for §19c usage-limit detect.
    hook: { hook_event_name?: string; session_id?: string; error?: string; error_details?: unknown; resetsAt?: number },
  ): void {
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
        // Claude is up → cycle the permission mode off the gate-free boot default into the target
        // mode (the human Shift+Tab step), once per session. Fire-and-forget; never blocks the turn.
        if (live.startupModeCycles > 0 && !live.startupCyclesDone) {
          live.startupCyclesDone = true;
          this.sendModeCycles(sessionId, live.startupModeCycles);
        }
        break;
      case "UserPromptSubmit":
        this.setBusy(sessionId, true); // rising edge — fires for the startup-prompt arg and injected prompts alike
        break;
      case "Stop":
      case "StopFailure": {
        this.setBusy(sessionId, false); // falling edge — exactly one Stop per end-of-turn (no per-tool-use)
        // Refresh context occupancy at the turn boundary. Cheap tail-read; done for EVERY session
        // (the host doesn't know role — a manager's own occupancy matters too, "who recycles the manager").
        if (live.engineSessionId) {
          const stats = readContextStats(live.cwd, live.engineSessionId);
          if (stats) this.events.onContextStats(sessionId, stats);
        }
        // §19c usage-limit park: a StopFailure with error==="rate_limit" means the turn died on the
        // cap. The pty stays alive; we record the resume-at and do NOT drain a new turn into a capped
        // account (the pending queue is held intact for #19c-b's resume). billing_error / a clean Stop
        // fall through to the normal drain.
        if (hook.hook_event_name === "StopFailure") {
          const det = detectUsageLimit(hook);
          if (det.limited) {
            const until = rateLimitedUntil(det.resetsAtSeconds);
            this.events.onRateLimited(sessionId, until, { resetsAtSeconds: det.resetsAtSeconds, message: `usage limit — resumes ${until}` });
            break;
          }
        }
        // The turn ended → safe to write. Drain ONE queued message (FIFO), re-arming busy so the
        // next Stop releases the next: strict per-session serialization. Writing only at the turn
        // boundary is what keeps a running turn from being corrupted by a mid-turn write.
        if (live.pending.length > 0) this.submit(sessionId, live.pending.shift()!);
        break;
      }
    }
  }

  /**
   * Queue text for submission as a turn (text + "\r"). Submits immediately when the session is
   * IDLE (arming busy); when a turn is in flight, HOLDS it FIFO and the next Stop drains one.
   * Returns whether it went out now, or its 1-based queue position. Never writes while busy —
   * a mid-turn write corrupts the running turn (the whole reason for the queue).
   */
  enqueueStdin(sessionId: string, text: string): { delivered: boolean; position?: number } {
    const live = this.live.get(sessionId);
    if (!live?.alive) return { delivered: false };
    if (!live.busy) {
      this.submit(sessionId, text);
      return { delivered: true };
    }
    live.pending.push(text);
    return { delivered: false, position: live.pending.length };
  }

  /**
   * Write text as a turn and arm busy (the immediate path and the Stop-drain share this).
   * Two writes: the text, then Enter (\r) a beat later — see SUBMIT_ENTER_DELAY_MS. busy is
   * armed synchronously, so a concurrent enqueueStdin for this session queues rather than
   * racing the pending \r.
   */
  private submit(sessionId: string, text: string): void {
    const live = this.live.get(sessionId);
    if (!live?.alive) return;
    live.lastPrompt = text; // remember the in-flight turn so a usage-cap kill is recoverable (§19c-b)
    // Chunk the write — a long turn (e.g. a worker report) sent as one pty.write is truncated by
    // ConPTY. Send the Enter only AFTER the last chunk lands, else it submits a partial turn.
    this.writeChunked(sessionId, text, () => {
      setTimeout(() => { const l = this.live.get(sessionId); if (l?.alive) l.pty.write("\r"); }, SUBMIT_ENTER_DELAY_MS);
    });
    this.setBusy(sessionId, true);
  }

  /**
   * §19c-b resume: re-submit the turn the usage cap killed (lastPrompt) once the reset passes. Goes
   * out via submit() (re-arms busy); the held pending queue then drains normally on the next Stop.
   * Returns false if the session isn't live (already stopped/killed → caller does not resume).
   */
  resumeAfterRateLimit(sessionId: string): boolean {
    const live = this.live.get(sessionId);
    if (!live?.alive) return false;
    if (live.lastPrompt != null) this.submit(sessionId, live.lastPrompt);
    return true;
  }

  /** Persist + broadcast the turn-in-flight flag, and track it locally. Idempotent. */
  private setBusy(sessionId: string, busy: boolean): void {
    const live = this.live.get(sessionId);
    if (!live) return;
    live.busy = busy;
    this.events.onBusy(sessionId, busy);
    this.broadcastControl(live, { type: "busy", busy });
  }

  /**
   * Inject `count` Shift+Tab presses to cycle the permission mode (the human step), spaced so each
   * registers as a distinct key event. Pure key writes — not turns — so they bypass the busy queue:
   * the mode cycle must land even while the startup-prompt turn is in flight (acceptEdits → target).
   */
  private sendModeCycles(sessionId: string, count: number): void {
    const tick = (i: number): void => {
      const live = this.live.get(sessionId);
      if (!live?.alive || i >= count) return;
      live.pty.write(SHIFT_TAB);
      setTimeout(() => tick(i + 1), MODE_CYCLE_INTERVAL_MS);
    };
    setTimeout(() => tick(0), MODE_CYCLE_SETTLE_MS);
  }

  subscribe(sessionId: string, sub: Subscriber): () => void {
    const live = this.live.get(sessionId);
    if (!live) return () => {};
    // Replay ring so a LATE attach sees a coherent screen, then stream live.
    const sb = Buffer.concat(live.ring.chunks);
    if (sb.length) sub.onData(sb);
    if (live.engineSessionId) sub.onControl({ type: "sessionId", id: live.engineSessionId });
    // Tell the new viewer the pinned grid so it sizes its xterm to match (info only — never resizes the pty).
    sub.onControl({ type: "geometry", cols: live.geometry.cols, rows: live.geometry.rows });
    if (!live.alive) sub.onControl({ type: "exit", code: null });
    live.subscribers.add(sub);
    return () => { live.subscribers.delete(sub); };
  }

  writeStdin(sessionId: string, data: string): void {
    this.writeChunked(sessionId, data);
  }

  /**
   * Write `text` to the pty in paced chunks. One big `pty.write` is truncated by Windows ConPTY's
   * input buffer (long worker reports / pastes arrived cut off), so split large writes and let the
   * console host drain between them. Keystroke-sized writes go in a single chunk; `done` fires
   * after the last chunk (submit() uses it to send Enter only once the whole turn has landed).
   */
  private writeChunked(sessionId: string, text: string, done?: () => void): void {
    const live = this.live.get(sessionId);
    if (!live?.alive) return;
    if (text.length === 0) { done?.(); return; }
    let i = 0;
    const step = (): void => {
      const l = this.live.get(sessionId);
      if (!l?.alive) return;
      l.pty.write(text.slice(i, i + PTY_WRITE_CHUNK_BYTES));
      i += PTY_WRITE_CHUNK_BYTES;
      if (i >= text.length) { done?.(); return; }
      setTimeout(step, PTY_WRITE_CHUNK_DELAY_MS);
    };
    step();
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
