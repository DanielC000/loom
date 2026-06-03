import fs from "node:fs";
import path from "node:path";
import { spawn, type IPty } from "node-pty";
import type { PermissionPolicy, PtyGeometry, SessionRole } from "@loom/shared";
import type { TerminalControl, StopMode } from "@loom/shared";
import { resolveExecutable } from "./resolve-bin.js";
import { writeSessionSettings } from "./claude-settings.js";
import { ensureTrusted } from "./claude-config.js";
import { injectSkills } from "../skills/inject.js";
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

/**
 * Bracketed-paste delimiters. Programmatic turns (worker reports, queued messages, /input) are
 * wrapped so claude treats the whole block — even multi-line — as ONE paste unit: embedded newlines
 * don't submit partial turns, and the trailing Enter (after the close marker) reliably submits. This
 * is why a worker report no longer "sits in the input box" un-submitted.
 */
const BRACKET_PASTE_START = "\x1b[200~";
const BRACKET_PASTE_END = "\x1b[201~";

/**
 * A session marked busy with NO engine output for this long is treated as STUCK (a turn that never
 * really started, or a missed Stop hook) and self-healed to idle so its queued messages can drain
 * and the UI stops showing a phantom 'busy'. Conservative — a genuinely long, silent tool call is
 * rare — so a false heal can't clobber a live turn. (The robust follow-up is transcript-based.)
 */
const BUSY_STALE_MS = 5 * 60_000;

/**
 * After a human keystroke in the composer, hold any programmatic turn this long before delivering —
 * so a worker report can't be concatenated onto the human's half-typed text (the collision that
 * mangled both messages). The queued report drains once the human submits/clears or this lapses.
 */
const HUMAN_TYPING_GRACE_MS = 6_000;

/** Shift+Tab (CSI Z / back-tab) — Claude's TUI cycles the permission mode on this key. */
const SHIFT_TAB = "\x1b[Z";
const ESC_KEY = "\x1b";
/** Strip CSI sequences so the boot-output scan matches the MCP prompt's words across TUI styling. */
const ANSI_CSI = new RegExp(ESC_KEY + "\\[[0-9;?]*[ -/]*[@-~]", "g");
const collapseBoot = (s: string): string => s.replace(ANSI_CSI, "").replace(/\s+/g, "");
/** Settle window after SessionStart before sending the first mode-cycle keystroke (let the TUI's input attach). */
const MODE_CYCLE_SETTLE_MS = 700;
/** Gap between successive Shift+Tab presses so each cycle registers as a distinct key event. */
const MODE_CYCLE_INTERVAL_MS = 120;
/**
 * Readiness fallback. SessionStart normally flips a (re)spawned session to `ready` (after the
 * mode-cycles land). If that hook never arrives, don't strand a queued boot injection forever —
 * mark ready after this grace so the message still drains. Env-overridable so tests don't wait 20s.
 */
const READY_FALLBACK_MS = Number(process.env.LOOM_READY_FALLBACK_MS) || 20_000;

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
  ready: boolean;       // the TUI has booted (first SessionStart, after mode-cycles) — gate for injection.
                        // DISTINCT from busy: busy="turn in flight", ready="engine up + safe to submit".
                        // A fresh/resumed pty is NOT ready until SessionStart, so a boot-recovery nudge
                        // queues instead of racing the still-booting composer (the 2026-06-03 restart bug).
  busySince: number | null;  // epoch ms when busy rose — for stuck-busy self-heal (BUSY_STALE_MS)
  lastOutputAt: number; // epoch ms of the last pty output — "is the engine actually producing?"
  lastHumanKeyAt: number | null; // epoch ms of the last human composer keystroke (collision guard)
  pending: string[];    // FIFO of messages held while busy / while the human types — drained on Stop + reconcile
  lastPrompt: string | null; // the most-recent submitted turn — re-sendable if the cap kills it (§19c-b)
  startupModeCycles: number; // Shift+Tab presses to inject once, after SessionStart, to reach the target mode
  startupCyclesDone: boolean; // guard so the cycle-inject fires at most once per session
  mcpPromptHandled: boolean;  // guard: dismiss the plugin-MCP enable-prompt with Esc at most once per session
  bootScan: string;           // bounded rolling buffer of early boot output, scanned for that prompt
}

export interface SpawnOpts {
  sessionId: string;          // Loom session id
  cwd: string;                // = project repoPath
  permission: PermissionPolicy;
  geometry: PtyGeometry;
  sessionEnv: Record<string, string>;
  /** New session: the agent startup prompt (injected once). Resume: omit. */
  startupPrompt?: string;
  /** Resume: Claude engine session id. */
  resumeId?: string;
  /** Fork: with resumeId, mint a fresh engine id (--fork-session) so the copy diverges from the source. */
  fork?: boolean;
  /** Fork: the pre-assigned engine session id for the fork (--session-id), persisted up front by the caller. */
  forkSessionId?: string;
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
  fork?: boolean;
  forkSessionId?: string;
  settingsPath: string;
  mode: string;
  mcpServers: Record<string, unknown>;
  startupPrompt?: string;
}): string[] {
  const args: string[] = [];
  if (o.resumeId) args.push("--resume", o.resumeId);
  // Fork: resume the conversation but mint a FRESH engine session id so the copy diverges and the
  // source transcript is untouched. We PRE-ASSIGN that id (--session-id) rather than let claude
  // auto-generate it, because --fork-session mints the new id lazily (on the first turn, not at
  // SessionStart) — so capturing it from the hook would grab the OLD id. Pre-assigning lets us
  // persist the fork's id up front. (Only meaningful alongside --resume.)
  if (o.fork && o.resumeId) {
    args.push("--fork-session");
    if (o.forkSessionId) args.push("--session-id", o.forkSessionId);
  }
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
  /**
   * M2 tripwire: true ONLY while deliverHook is finalizing a turn (between lowering busy and draining
   * the FIFO). deliverHook is fully synchronous, so an external `enqueueStdin` can NEVER observe this
   * as true — unless a future edit introduces an `await` into that window. enqueueStdin asserts on it.
   */
  private finalizingTurn = false;
  constructor(private events: PtyHostEvents) {}

  spawn(opts: SpawnOpts): void {
    const pty = this.createPty(opts);
    const live: Live = {
      pty, pid: pty.pid, cwd: opts.cwd,
      geometry: opts.geometry,
      // A fork carries its PRE-ASSIGNED engine id (forkSessionId); a plain resume reuses resumeId;
      // a brand-new session has none yet (captured on SessionStart).
      engineSessionId: opts.forkSessionId ?? opts.resumeId ?? null,
      ring: { chunks: [], bytes: 0 },
      subscribers: new Set(),
      alive: true,
      logStream: fs.createWriteStream(path.join(LOGS_DIR, `${opts.sessionId}.log`)),
      busy: false,
      ready: false, // flipped on the first SessionStart (after mode-cycles) — see Live.ready / markReady
      busySince: null,
      lastOutputAt: Date.now(),
      lastHumanKeyAt: null,
      pending: [],
      // The startup-prompt turn runs from a CLI arg (not submit()), so seed lastPrompt with it —
      // a cap on the FIRST turn must still be re-submittable on resume (§19c-b).
      lastPrompt: opts.startupPrompt ?? null,
      // Boot is always gate-free (acceptEdits); cycle to the target mode once the TUI is up (SessionStart).
      startupModeCycles: opts.permission.startupModeCycles ?? 0,
      startupCyclesDone: false,
      mcpPromptHandled: false,
      bootScan: "",
    };
    this.live.set(opts.sessionId, live);

    pty.onData((d) => {
      const buf = Buffer.from(d, "utf-8");
      live.lastOutputAt = Date.now(); // engine is producing → not stuck (feeds the BUSY_STALE_MS heal)
      // The official-marketplace plugins surface a per-project "enable docker/sentry MCP?" prompt that
      // blocks the unattended boot BEFORE SessionStart, and is NOT config-suppressible (validated). Scan
      // early boot output and dismiss it once with Esc ("reject all") — Loom sessions get ONLY their
      // injected --mcp-config servers, never the user's personal plugin MCP. Bounded rolling scan.
      if (!live.mcpPromptHandled) {
        live.bootScan = (live.bootScan + d).slice(-8192);
        const flat = collapseBoot(live.bootScan);
        if (/MCPserver/i.test(flat) && /rejectall/i.test(flat)) {
          live.mcpPromptHandled = true;
          live.bootScan = "";
          // eslint-disable-next-line no-console
          console.log(`[pty] ${opts.sessionId} dismissing plugin-MCP enable-prompt (Esc = reject all)`);
          setTimeout(() => { if (live.alive) live.pty.write(ESC_KEY); }, 300);
        }
      }
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

    // Readiness fallback: if SessionStart never arrives (a missed hook), don't strand a queued boot
    // injection forever — mark ready after a grace so it still drains. Bounded; a no-op if already ready.
    setTimeout(() => {
      const l = this.live.get(opts.sessionId);
      if (l?.alive && !l.ready) {
        console.log(`[pty] ${opts.sessionId} readiness fallback (no SessionStart in ${READY_FALLBACK_MS}ms) — marking ready`);
        this.markReady(opts.sessionId);
      }
    }, READY_FALLBACK_MS);
  }

  /**
   * Build the interactive `claude` pty for a session — the spike-validated, gate-free spawn recipe
   * (absolute bin path for the Windows node-pty agent, env scrub of CLAUDECODE/CLAUDE_CODE_*,
   * --strict-mcp-config WITH an explicit --mcp-config so the .mcp.json prompt never blocks,
   * acceptEdits + allowlist, main-screen scrollback). Extracted as the ONE testable seam: the
   * deterministic busy/drain unit test (test/pty-busy-drain.mjs) subclasses PtyHost and overrides
   * this to return a FAKE pty — exercising the M1/M2 state machine with no real claude and no
   * ~/.claude.json trust writes. Production NEVER overrides it; the recipe below is the only real one.
   */
  protected createPty(opts: SpawnOpts): IPty {
    const bin = resolveExecutable(process.env.LOOM_CLAUDE_BIN || "claude");
    ensureTrusted(opts.cwd); // pre-accept the workspace-trust dialog so warmup never blocks
    // Mirror Loom's managed skills into <cwd>/.claude/skills (project-local; shadow personal). Never
    // let a skills hiccup block a spawn — a session must boot even if skill delivery fails.
    try { injectSkills(opts.cwd); } catch (e) { console.log(`[pty] injectSkills failed (non-fatal): ${(e as Error).message}`); }
    // Both managers AND workers get the orchestration MCP — but a role-gated surface: managers
    // get the full coordination tools, workers get only worker_report (resolved server-side). A
    // platform-lead instead gets the loom-platform MCP (project/agent creation, Pillar C). acceptEdits
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
    const args = buildSpawnArgs({ resumeId: opts.resumeId, fork: opts.fork, forkSessionId: opts.forkSessionId, settingsPath, mode: permission.mode, mcpServers, startupPrompt: opts.startupPrompt });

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
    return pty;
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
        // SessionStart only fires once boot is past the (now-dismissed) MCP prompt — stop scanning.
        live.mcpPromptHandled = true; live.bootScan = "";
        // Capture the engine session id once (unchanged from phase 1).
        if (typeof hook.session_id === "string" && !live.engineSessionId) {
          live.engineSessionId = hook.session_id;
          this.events.onEngineSessionId(sessionId, hook.session_id);
          this.broadcastControl(live, { type: "sessionId", id: hook.session_id });
        }
        // Claude is up → cycle the permission mode off the gate-free boot default into the target mode
        // (the human Shift+Tab step), once per (re)spawn. NEEDED ON RESUME TOO: --permission-mode boots
        // back at acceptEdits, so the cycles are what restore the target (e.g. auto) mode. The session
        // is marked READY (which releases any queued injection) only AFTER the cycles land — so a
        // boot-recovery nudge can't interleave with the Shift+Tabs. That interleave was the 2026-06-03
        // restart bug: the nudge stranded un-submitted in the composer and the mode stuck mid-cycle on plan.
        if (!live.startupCyclesDone) {
          live.startupCyclesDone = true;
          if (live.startupModeCycles > 0) {
            this.sendModeCycles(sessionId, live.startupModeCycles, () => this.markReady(sessionId));
          } else {
            this.markReady(sessionId);
          }
        } else {
          this.markReady(sessionId); // idempotent: a repeat SessionStart still ensures readiness
        }
        break;
      case "UserPromptSubmit":
        this.setBusy(sessionId, true); // rising edge — fires for the startup-prompt arg and injected prompts alike
        break;
      case "Stop":
      case "StopFailure": {
        // ┌─ M2 INVARIANT (busy-gate drain ordering) — DO NOT INTRODUCE AN `await` IN THIS BRANCH ─┐
        // │ From the setBusy(false) below to the drainPending below, execution MUST stay strictly  │
        // │ SYNCHRONOUS. The busy-gate works because once the turn ends we lower busy and IMMEDIATELY│
        // │ drain the FIFO head in the same tick — before control returns to the event loop, so no  │
        // │ concurrent enqueueStdin can observe busy=false and submit() its own turn first. If a    │
        // │ future edit `await`s anywhere in this window (e.g. an async context-stats read), an     │
        // │ enqueueStdin scheduled during that yield would slip a second turn in, interleaving two  │
        // │ turns into one session and breaking FIFO serialization. The `finalizingTurn` tripwire    │
        // │ below makes that regression LOUD: enqueueStdin asserts it is never seen true (see there).│
        // └────────────────────────────────────────────────────────────────────────────────────────┘
        this.finalizingTurn = true;
        try {
          this.setBusy(sessionId, false); // falling edge — exactly one Stop per end-of-turn (no per-tool-use)
          // Refresh context occupancy at the turn boundary. Cheap SYNCHRONOUS tail-read; done for EVERY
          // session (the host doesn't know role — a manager's own occupancy matters too, "who recycles
          // the manager"). Keep it sync — see the M2 box above before making this (or anything here) async.
          if (live.engineSessionId) {
            const stats = readContextStats(live.cwd, live.engineSessionId);
            if (stats) this.events.onContextStats(sessionId, stats);
          }
          // §19c usage-limit park: a StopFailure with error==="rate_limit" means the turn died on the
          // cap. The pty stays alive; we record the resume-at and do NOT drain a new turn into a capped
          // account (the pending queue is held intact for #19c-b's resume). billing_error / a clean Stop
          // fall through to the normal drain. (The `finally` below still clears the tripwire on this break.)
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
          this.drainPending(sessionId);
        } finally {
          this.finalizingTurn = false;
        }
        break;
      }
    }
  }

  /**
   * Queue text for submission as a turn. Submits IMMEDIATELY only when the session is idle AND the
   * human isn't mid-compose; otherwise HOLDS it FIFO and `drainPending` (on the next Stop, or the
   * reconcile tick) delivers it. Two reasons not to write now:
   *   - busy: a mid-turn write corrupts the running turn (the original reason for the queue);
   *   - human typing: writing onto half-typed composer text concatenates the two into one garbled
   *     message (the observed manager/worker collision) — so we wait until the box is free.
   * Also self-heals a STUCK-busy session first, so a report can't strand behind a phantom 'busy'.
   * Returns whether it went out now, or its 1-based queue position.
   */
  enqueueStdin(sessionId: string, text: string): { delivered: boolean; position?: number } {
    const live = this.live.get(sessionId);
    if (!live?.alive) return { delivered: false };
    this.healIfStuck(live, sessionId);
    // `ready` gate: a freshly (re)spawned pty is not ready until SessionStart. Submitting before then
    // writes into a still-booting TUI — the Enter is swallowed and the text strands in the composer
    // (the 2026-06-03 restart bug). Hold it FIFO; markReady drains it once the engine is up.
    if (live.ready && !live.busy && !this.humanActivelyTyping(live)) {
      // M2 GUARD: reaching the idle (busy=false) submit path while a turn is being finalized means an
      // `await` leaked into deliverHook's lower-busy→drain window (see the M2 box there). In correct,
      // synchronous code this is unreachable — enqueueStdin runs as its own event-loop task, never
      // interleaved with deliverHook. Tripping it would mean we're about to race a second turn in.
      if (this.finalizingTurn) {
        throw new Error("M2 invariant violated: enqueueStdin reached the idle-submit path mid turn-finalize — an `await` leaked between setBusy(false) and drainPending in deliverHook (host.ts).");
      }
      this.submit(sessionId, text);
      // M1 GUARD: submit() MUST arm busy=true SYNCHRONOUSLY (the optimistic set), so that a concurrent
      // enqueue arriving next sees busy and QUEUES instead of racing this turn's pending `\r`. If busy
      // is still false here, a future refactor deferred the set behind an await/callback — fail loud.
      if (!live.busy) {
        throw new Error("M1 invariant violated: submit() did not arm busy synchronously — the optimistic busy=true was deferred, so a concurrent enqueue could race the pending Enter (host.ts).");
      }
      return { delivered: true };
    }
    live.pending.push(text);
    return { delivered: false, position: live.pending.length };
  }

  /** A copy of a session's queued (not-yet-delivered) messages — for the UI queue display. */
  getPending(sessionId: string): string[] {
    return [...(this.live.get(sessionId)?.pending ?? [])];
  }

  /** True while the human has uncommitted composer text (recent keystroke, no submit/clear since). */
  private humanActivelyTyping(live: Live): boolean {
    return live.lastHumanKeyAt != null && Date.now() - live.lastHumanKeyAt < HUMAN_TYPING_GRACE_MS;
  }

  /** Clear a phantom 'busy' (busy with no engine output for BUSY_STALE_MS) so its queue can drain. */
  private healIfStuck(live: Live, sessionId: string): void {
    const now = Date.now();
    if (live.busy && live.busySince != null
      && now - live.busySince > BUSY_STALE_MS && now - live.lastOutputAt > BUSY_STALE_MS) {
      this.setBusy(sessionId, false);
    }
  }

  /** Deliver the next queued message when it's safe (idle + composer free). Shared by Stop + reconcile. */
  private drainPending(sessionId: string): void {
    const live = this.live.get(sessionId);
    if (!live?.alive || !live.ready || live.busy || live.pending.length === 0) return;
    if (this.humanActivelyTyping(live)) return; // don't land on the human's half-typed text
    this.submit(sessionId, live.pending.shift()!);
  }

  /**
   * Periodic safety net (wired to a timer in index.ts): self-heal stuck-busy sessions and drain any
   * queue that's been waiting (a report queued behind a phantom 'busy', or held while the human typed
   * and has since stopped). Without this, a queued message only ever drains on a Stop hook — which a
   * stuck session never fires.
   */
  reconcile(): void {
    for (const [sessionId, live] of this.live) {
      if (!live.alive) continue;
      this.healIfStuck(live, sessionId);
      this.drainPending(sessionId);
    }
  }

  /**
   * Write text as a turn and arm busy (the immediate path and the Stop-drain share this). The text
   * goes out as a BRACKETED PASTE (start marker, the chunked text, end marker) then Enter a beat
   * later — so claude treats even multi-line content as one paste unit and the trailing Enter
   * reliably submits (no more reports stuck un-submitted in the box). The markers are written on
   * their own so chunking can't split a marker sequence.
   *
   * M1 INVARIANT (optimistic busy): `setBusy(true)` is the LAST statement and runs SYNCHRONOUSLY —
   * before submit() yields to the event loop. The actual Enter (`\r`) is written async, a beat later;
   * the synchronous busy set is what closes the window between "we decided to submit" and "the turn is
   * really in flight". A concurrent enqueueStdin (its own event-loop task) therefore always sees
   * busy=true and QUEUES rather than racing the still-pending `\r`. DO NOT move this set behind an
   * `await`/callback or make submit() async — that would reopen the race. enqueueStdin asserts the set
   * landed synchronously (the M1 GUARD there).
   */
  private submit(sessionId: string, text: string): void {
    const live = this.live.get(sessionId);
    if (!live?.alive) return;
    live.lastPrompt = text; // remember the in-flight turn so a usage-cap kill is recoverable (§19c-b)
    live.pty.write(BRACKET_PASTE_START);
    // Chunk the text — a long turn (e.g. a worker report) sent as one pty.write is truncated by
    // ConPTY. Close the paste + send Enter only AFTER the last chunk lands, else it submits a partial.
    this.writeChunked(sessionId, text, () => {
      const l = this.live.get(sessionId);
      if (!l?.alive) return;
      l.pty.write(BRACKET_PASTE_END);
      setTimeout(() => { const x = this.live.get(sessionId); if (x?.alive) x.pty.write("\r"); }, SUBMIT_ENTER_DELAY_MS);
    });
    this.setBusy(sessionId, true); // M1: optimistic, SYNCHRONOUS — see the M1 INVARIANT note above. Keep last; keep sync.
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
    live.busySince = busy ? Date.now() : null; // track the rising edge for the stuck-busy heal
    this.events.onBusy(sessionId, busy);
    this.broadcastControl(live, { type: "busy", busy });
  }

  /**
   * Inject `count` Shift+Tab presses to cycle the permission mode (the human step), spaced so each
   * registers as a distinct key event. Pure key writes — not turns — so they bypass the busy queue:
   * the mode cycle must land even while the startup-prompt turn is in flight (acceptEdits → target).
   */
  private sendModeCycles(sessionId: string, count: number, onDone?: () => void): void {
    const tick = (i: number): void => {
      const live = this.live.get(sessionId);
      if (!live?.alive) return;            // pty gone → drop the sequence (and onDone); nothing to ready
      if (i >= count) { onDone?.(); return; } // all cycles landed → let the caller proceed (markReady)
      live.pty.write(SHIFT_TAB);
      setTimeout(() => tick(i + 1), MODE_CYCLE_INTERVAL_MS);
    };
    setTimeout(() => tick(0), MODE_CYCLE_SETTLE_MS);
  }

  /**
   * Mark a (re)spawned session READY: its TUI has booted and (on resume) the permission-mode cycles
   * have landed, so injected turns are safe to submit. Releases anything queued during boot — e.g. the
   * daemon-restart continuation nudge that boot-recovery enqueues right after resume(), before the
   * engine is up. Idempotent. See Live.ready: `busy` is "turn in flight", `ready` is "engine booted".
   */
  private markReady(sessionId: string): void {
    const live = this.live.get(sessionId);
    if (!live?.alive || live.ready) return;
    live.ready = true;
    this.drainPending(sessionId); // deliver the first queued injection now that the composer is live
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
    const live = this.live.get(sessionId);
    if (live) {
      // Track the human's composer state so a programmatic turn doesn't land on half-typed text.
      // Enter / Ctrl-C / Esc submit or clear the box (free it); anything else means they're composing.
      live.lastHumanKeyAt = /[\r\x03\x1b]/.test(data) ? null : Date.now();
    }
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
