import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { spawn, type IPty } from "node-pty";
import type { PermissionPolicy, PtyGeometry, SessionRole } from "@loom/shared";
import type { TerminalControl, StopMode } from "@loom/shared";
import { resolveExecutable } from "./resolve-bin.js";
import { writeSessionSettings } from "./claude-settings.js";
import { ensureTrusted } from "./claude-config.js";
import { injectSkills } from "../skills/inject.js";
import { readContextStats, type ContextStats } from "../sessions/context.js";
import { detectUsageLimit, rateLimitedUntil } from "../orchestration/usage-limit.js";
import { PORT, LOGS_DIR, ENSURE_OBSIDIAN_SCRIPT } from "../paths.js";
import { loomVenvBin, ensurePythonPackageAsync } from "../python/venv.js";

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
 * Visible separator between coalesced queued messages when drainPending delivers the WHOLE pending FIFO
 * as ONE turn. Each queued entry is already independently framed (e.g. `[loom:from-manager]\n…`); this
 * rule keeps consecutive messages legible as distinct items within the single concatenated turn, in
 * FIFO order (so e.g. 3 superseding manager redirects arrive together, newest last, not one-per-Stop).
 */
const DRAIN_SEPARATOR = "\n\n────────\n\n";

/**
 * A session marked busy with NO engine output for this long is treated as STUCK (a turn that never
 * really started, or a missed Stop hook) and self-healed to idle so its queued messages can drain
 * and the UI stops showing a phantom 'busy'. Conservative — a genuinely long, silent tool call is
 * rare — so a false heal can't clobber a live turn. (The robust follow-up is transcript-based.)
 *
 * DAEMON-GLOBAL tunable: this const is the default / test seam; the live value is `platform.timeouts.busyStaleMs`,
 * threaded in via the PtyHost constructor opt (index.ts passes the resolved number at boot — BOOT-BOUND).
 */
const BUSY_STALE_MS = 5 * 60_000;

/** Shift+Tab (CSI Z / back-tab) — Claude's TUI cycles the permission mode on this key. */
const SHIFT_TAB = "\x1b[Z";
/** Down arrow (CSI B) — moves the selection in Claude's TUI menus. */
const DOWN_ARROW = "\x1b[B";
const ENTER = "\r";
const ESC_KEY = "\x1b";
/** Strip CSI sequences so the boot-output scan matches the MCP prompt's words across TUI styling. */
const ANSI_CSI = new RegExp(ESC_KEY + "\\[[0-9;?]*[ -/]*[@-~]", "g");
const collapseBoot = (s: string): string => s.replace(ANSI_CSI, "").replace(/\s+/g, "");

/**
 * Recompute the human's RAW-terminal composer draft length from ONE input chunk, given the prior
 * length. PURE + exported for the hermetic test. "Composer-dirty" is simply `len > 0`; while dirty,
 * a programmatic turn is HELD (never delivered onto the half-typed text) — see deferForHumanDraft.
 * We track LENGTH, not a bool, only so a human who BACKSPACES the whole line back to empty also
 * releases the hold (a bare bool couldn't tell that from a still-dirty box).
 *
 * Classification of the chunk:
 *  - A LONE Esc (\x1b) dismisses/clears the box → 0.
 *  - Otherwise walk the chunk in a single pass, tracking whether we're INSIDE a `\x1b[200~ … \x1b[201~`
 *    bracketed-paste span:
 *      - A BARE box-FREEING control encountered OUTSIDE a paste span — Enter (\r/\n), Ctrl-C (\x03),
 *        or kill-line (Ctrl-U \x15) — means the human submitted/interrupted/killed the line → 0.
 *        (We can't whole-chunk short-circuit on these: a MULTI-LINE paste body carries \r/\n that is
 *        draft CONTENT, not a free — that would wrongly zero a held paste and let a queued turn drain
 *        onto it.) Inside a span, \r/\n is counted as one draft char.
 *      - backspace/DEL (\x7f/\b) decrements (floored at 0).
 *      - printable chars (>= 0x20) increment.
 *      - an escape sequence (arrow keys / navigation / the bracketed-paste markers) is skipped to its
 *        final byte so its parameter bytes aren't miscounted as printable; the \x1b[200~ / \x1b[201~
 *        markers toggle the paste flag. Other C0 controls (Tab, etc.) are ignored.
 *
 * Best-effort BY DESIGN — it can't perfectly mirror Claude's Ink editor (e.g. cursor-mid-line edits),
 * but it only ever errs toward HOLDING a delivery, never toward clobbering the human's text.
 */
export function nextComposerLen(prevLen: number, data: string): number {
  if (data === ESC_KEY) return 0;                 // a lone Esc dismisses/clears the box
  let len = prevLen;
  let inPaste = false;                            // inside a \x1b[200~ … \x1b[201~ bracketed-paste span
  for (let i = 0; i < data.length; i++) {
    const c = data.charCodeAt(i);
    if (c === 0x1b) {
      // Escape/CSI/SS3 sequence (arrow keys, Home/End, bracketed-paste \x1b[200~ markers, …). The paste
      // markers toggle inPaste; any other sequence is skipped to its final byte so its param bytes
      // (e.g. the "200" in \x1b[200~) aren't counted. The paste BODY between the markers is counted by
      // the normal printable/newline path on later iterations.
      if (data.startsWith(BRACKET_PASTE_START, i)) { inPaste = true; i += BRACKET_PASTE_START.length - 1; continue; }
      if (data.startsWith(BRACKET_PASTE_END, i)) { inPaste = false; i += BRACKET_PASTE_END.length - 1; continue; }
      const next = data[i + 1];
      if (next === "[" || next === "O") {
        i += 2;
        while (i < data.length && !/[A-Za-z~]/.test(data[i]!)) i++;
      } else {
        i += 1; // a lone/unknown ESC inside a larger chunk — skip just the ESC byte
      }
      continue;
    }
    if (c === 0x7f || c === 0x08) { len = Math.max(0, len - 1); continue; } // backspace / DEL
    if (c === 0x0d || c === 0x0a || c === 0x03 || c === 0x15) {
      // Enter (\r/\n) / Ctrl-C / kill-line. OUTSIDE a paste these FREE the box (real submit/interrupt/
      // clear). INSIDE a bracketed paste a newline is pasted draft content, so count \r/\n toward length
      // and ignore the (vanishingly rare) other controls.
      if (!inPaste) return 0;
      if (c === 0x0d || c === 0x0a) len++;
      continue;
    }
    if (c >= 0x20) len++;                          // printable → one more draft char
    // other C0 controls (Tab, etc.) — ignore for length
  }
  return len;
}

/**
 * Detect Claude Code's "resume from summary / as-is" gate, which appears BEFORE SessionStart when
 * resuming a large/old session (e.g. "This session is 1h 16m old and 435k tokens. Resuming the full
 * session will consume a substantial portion of your usage limits. We recommend resuming from a
 * summary." → ❯ 1. Resume from summary (recommended) / 2. Resume full session as-is / 3. Don't ask
 * me again). It blocks unattended resume: the DEFAULT is option 1 "from summary", which triggers a
 * SUMMARIZATION (compaction) and silently drops the manager's full context. Loom always wants option 2
 * (full as-is). Input is collapseBoot()'d output (ANSI + whitespace stripped). Exported for testing.
 */
export function isResumeSummaryGate(flatCollapsed: string): boolean {
  return /resumefromsummary/i.test(flatCollapsed) && /resumefullsession/i.test(flatCollapsed);
}

/**
 * The permission mode a spawned/resumed `claude` actually LANDED in, read from the TUI footer.
 * "default" = the unlabeled normal mode (footer shows the Shift+Tab cycle hint but no "<x> on" label);
 * "unknown" = no footer could be read (still booting / no output). OBSERVABILITY ONLY — see logLandedMode.
 */
export type LandedMode = "acceptEdits" | "plan" | "auto" | "bypassPermissions" | "default" | "unknown";

/** Charset-designation (ESC ( B …) + keypad-mode (ESC = / ESC >) escapes — not CSI, so ANSI_CSI misses them. */
const ANSI_OTHER = new RegExp(ESC_KEY + "[()][0-9A-Za-z]|" + ESC_KEY + "[=>]", "g");
/** Strip ALL TUI escapes and collapse whitespace. The footer is laid out with cursor-position escapes,
 *  so after stripping the mode words run together ("accept edits on" → "accepteditson"). */
const collapseFooter = (s: string): string => s.replace(ANSI_CSI, "").replace(ANSI_OTHER, "").replace(/\s+/g, "");

/** Footer mode labels (collapsed, lowercase) → mode. acceptEdits/auto share the ⏵⏵ glyph; plan uses ⏸. */
const MODE_TOKENS: { mode: LandedMode; token: string }[] = [
  { mode: "plan", token: "planmodeon" },
  { mode: "acceptEdits", token: "accepteditson" },
  { mode: "auto", token: "automodeon" },
  { mode: "bypassPermissions", token: "bypasspermissionson" },
];

/**
 * Classify the permission mode from recent pty output by the LAST occurrence of a footer mode label
 * (the footer is repainted continuously, so the last label is the current mode). Empirically mapped
 * against real `claude` 2.1.163 (board card f05e4897; see test/_probe-resume-mode.mjs). PURE +
 * exported for the hermetic regression test. Never throws.
 *  - a labeled mode ("accept edits on"/"plan mode on"/"auto mode on"/"bypass permissions on") → that mode
 *  - no label but the Shift+Tab cycle hint is present → "default" (the unlabeled normal mode)
 *  - no footer readable at all → "unknown"
 */
export function detectPermissionMode(recentOutput: string): { mode: LandedMode; matchedToken: string | null } {
  const flat = collapseFooter(recentOutput).toLowerCase();
  let best: { mode: LandedMode; idx: number; token: string } | null = null;
  for (const { mode, token } of MODE_TOKENS) {
    const idx = flat.lastIndexOf(token);
    if (idx >= 0 && (best === null || idx > best.idx)) best = { mode, idx, token };
  }
  if (best) return { mode: best.mode, matchedToken: best.token };
  // No labeled mode. The cycle hint (tolerant of a char dropped across a line-wrap, e.g. "tabocycle")
  // means we DID read a footer in the unlabeled default mode; otherwise we couldn't read a footer.
  if (/shift\+tab[a-z]{0,3}cycle/.test(flat)) return { mode: "default", matchedToken: null };
  return { mode: "unknown", matchedToken: null };
}

/**
 * The cycle order Shift+Tab walks from the gate-free `acceptEdits` boot mode (claude 2.1.163; mapped by
 * the probe — board card f05e4897 / test/_probe-resume-mode.mjs):
 *   acceptEdits →(+1) plan →(+2) auto →(+3) default →(+4) acceptEdits   (period 4).
 */
const ACCEPT_EDITS_CYCLE_ORDER: LandedMode[] = ["acceptEdits", "plan", "auto", "default"];
/**
 * The permission mode reached after `cycles` Shift+Tab presses from the gate-free acceptEdits boot mode.
 * Used to derive a RESUME's TARGET mode from the SAME `startupModeCycles` a fresh spawn uses, so a
 * resumed session converges to exactly where a fresh spawn lands (default config: 2 → auto). PURE +
 * exported for the hermetic test. (Both fresh AND `--resume` boot at acceptEdits — `--resume` honours
 * `--permission-mode`, probe-verified; it does NOT restore the persisted mode — so this single map is
 * correct for both.)
 */
export function modeAfterCyclesFromAcceptEdits(cycles: number): LandedMode {
  const n = Math.trunc(cycles);
  // The index is always in [0,4) so this is always defined; the ?? keeps the type non-optional.
  return ACCEPT_EDITS_CYCLE_ORDER[(((n % 4) + 4) % 4)] ?? "acceptEdits";
}

/** One step of the resume feedback cycler: at the target → stop; out of presses → stop; else press once. */
export type CycleAction = "done" | "press" | "giveup";
/**
 * PURE decision for the RESUME mode-convergence loop (cycleResumeToMode): given the footer mode we just
 * read, the target, and how many Shift+Tabs we've already issued, decide whether to stop (reached the
 * target), give up (hit the bounded press cap — leave the session as-is), or press one more Shift+Tab.
 * Exported so the table-driven hermetic test can assert the press count + stop conditions with no real
 * claude. The loop NEVER presses twice without first observing the footer change (see cycleResumeToMode),
 * so feeding the sequence of observed modes through this function reproduces the exact press sequence.
 */
export function nextCycleAction(o: { current: LandedMode; target: LandedMode; presses: number; maxPresses: number }): CycleAction {
  if (o.current === o.target) return "done";
  if (o.presses >= o.maxPresses) return "giveup";
  return "press";
}

/** Settle window after SessionStart before sending the first mode-cycle keystroke (let the TUI's input attach). */
const MODE_CYCLE_SETTLE_MS = 700;
/**
 * OBSERVABILITY (card f05e4897): after a session settles (markReady), poll the footer a few times
 * (until a mode is read or this cap) and log the landed permission mode. Read-only — see logLandedMode.
 */
const MODE_LOG_POLL_MS = 500;
const MODE_LOG_MAX_ATTEMPTS = 8; // ≤ ~4s of best-effort polling, then log whatever we have
/** Gap between successive Shift+Tab presses so each cycle registers as a distinct key event. */
const MODE_CYCLE_INTERVAL_MS = 120;
/**
 * RESUME mode-convergence loop (cycleResumeToMode, card f05e4897). Unlike the FRESH path's blind
 * relative cycling, RESUME drives the footer to the target ABSOLUTELY: press one Shift+Tab, then poll
 * the footer until it CHANGES (the press registered) before deciding again — so a laggy repaint can
 * never trick us into overshooting. Polling cadence + the per-press change-wait cap (≈3s) and the total
 * press cap. Sized so the whole loop (worst case ≈ MAX_PRESSES × CHANGE_MAX_POLLS × POLL_MS + settle ≈
 * 13–14s) finishes COMFORTABLY under READY_FALLBACK_MS (20s) — the readiness fallback must not fire
 * mid-cycle and release queued injections before the mode settles (the 2026-06-03 strand bug). From the
 * acceptEdits boot mode, auto is reached in 2 presses; the cap is headroom (a full period is 4). */
const RESUME_MODE_READ_POLL_MS = Number(process.env.LOOM_RESUME_MODE_POLL_MS) || 200;
const RESUME_MODE_CHANGE_MAX_POLLS = Number(process.env.LOOM_RESUME_MODE_MAX_POLLS) || 15;
const RESUME_MODE_MAX_PRESSES = Number(process.env.LOOM_RESUME_MODE_MAX_PRESSES) || 4;
/**
 * Readiness fallback. SessionStart normally flips a (re)spawned session to `ready` (after the
 * mode-cycles land). If that hook never arrives, don't strand a queued boot injection forever —
 * mark ready after this grace so the message still drains. Env-overridable so tests don't wait 20s.
 */
const READY_FALLBACK_MS = Number(process.env.LOOM_READY_FALLBACK_MS) || 20_000;

/**
 * Graceful-stop escalation — makes a graceful stop ALWAYS terminate the session (the deterministic-stop
 * fix). A double Ctrl-C EXITS an IDLE `claude` (the second press exits from an empty prompt), but on a
 * session that's mid-turn the two Ctrl-Cs only INTERRUPT the running turn — the pty stays alive at a (now)
 * idle prompt and, because no Stop hook fires after the interrupt, the busy flag stays stale. So the
 * operator sees a "stopped" session that's actually still live+busy (the board bug). Fix: after the
 * initial interrupt sequence, if the pty is STILL alive, RE-SEND the exit sequence (the turn has since
 * unwound to an idle prompt, where the double Ctrl-C exits); and if it STILL refuses to exit within a hard
 * bound (a wedged TUI / a tool call that swallows Ctrl-C), ESCALATE to a hard `pty.kill()` (node-pty Job
 * Object — orphan-free, kills the tree). An IDLE session exits on the very FIRST sequence, so the escalation
 * timers always find `!alive` and are pure no-ops — its graceful stop is unchanged. All three are
 * env-overridable so the hermetic test drives the whole escalation in milliseconds (default unset =
 * production behaviour: the first two Ctrl-Cs keep their original 600ms gap).
 *   GAP   — gap between the two Ctrl-Cs of one exit sequence (was the inline 600ms literal)
 *   RETRY — re-send the exit sequence at this point if the session is still live after the interrupt
 *   KILL  — hard bound after which an un-exited pty is killed (RETRY+GAP < KILL, so the re-send gets a
 *           full window to land before the kill)
 */
const GRACEFUL_STOP_GAP_MS = Number(process.env.LOOM_GRACEFUL_GAP_MS) || 600;
const GRACEFUL_STOP_RETRY_MS = Number(process.env.LOOM_GRACEFUL_RETRY_MS) || 2_000;
const GRACEFUL_STOP_KILL_MS = Number(process.env.LOOM_GRACEFUL_KILL_MS) || 6_000;

/**
 * Settle window for `interruptForRedirect`: after writing the single Esc that cancels a busy worker's
 * in-flight generation, wait this long for the engine to unwind back to an idle prompt before we
 * SYNCHRONOUSLY clear the (now stale) busy and drain the freshly-enqueued redirect as the next turn. An
 * Esc-cancel fires NO Stop hook (same as the Ctrl-C interrupt), so nothing else lowers busy — this timer
 * is what does. Env-overridable so the hermetic test drives it in milliseconds (mirrors GRACEFUL_STOP_*);
 * default unset = production behaviour (a beat for the cancel to land). Sized well under BUSY_STALE_MS so
 * it always wins the self-heal race.
 */
const REDIRECT_SETTLE_MS = Number(process.env.LOOM_REDIRECT_SETTLE_MS) || 1_500;

/**
 * Resolve the per-session Playwright MCP (`@playwright/mcp`) stdio server entry, injected at spawn
 * ONLY for a browserTesting session (opt-in, gated). Built with ABSOLUTE paths — the same lesson as
 * the absolute-claude-path invariant: node-pty's Windows agent does NOT search %PATH%, and a bare
 * `command: "npx"`/`"playwright-mcp"` would not launch. So:
 *   - command = `process.execPath` (the daemon's own absolute node binary), and
 *   - args[0] = the absolute path to the package's `cli.js`.
 * `cli.js` isn't in the package's `exports` map (only `.` and `./package.json` are), so we resolve
 * `@playwright/mcp/package.json` and join `cli.js` (its `bin` target) beside it — robust under both
 * the source (tsx) and the built `dist/` daemon. Memoized: the resolution is constant per process.
 *
 * `--headless` (unattended; no visible window) + `--isolated` (profile kept in memory — no on-disk
 * profile lock, so PARALLEL browser-workers never collide and nothing persists between runs, matching
 * the "own isolated browser, no shared state/auth" design). Chromium is launched LAZILY by the MCP on
 * the first browser tool call, so an idle browser-capable worker boots no Chromium. If the Chromium
 * binaries are absent the FIRST tool call fails inside the MCP with Playwright's own actionable
 * "run `npx playwright install chromium`" message (the one-time host provisioning step).
 *
 * Returns null if the package can't be resolved (it's a pinned daemon dependency, so this is a
 * should-never-happen guard) — the caller then simply omits the server, leaving the spawn otherwise
 * intact rather than crashing it.
 */
let playwrightCliPathCache: string | null | undefined;
function resolvePlaywrightCli(): string | null {
  if (playwrightCliPathCache !== undefined) return playwrightCliPathCache;
  try {
    const require = createRequire(import.meta.url);
    const pkgJson = require.resolve("@playwright/mcp/package.json");
    playwrightCliPathCache = path.join(path.dirname(pkgJson), "cli.js");
  } catch {
    playwrightCliPathCache = null;
  }
  return playwrightCliPathCache;
}

/** The stdio MCP-config entry for a browserTesting session, or null if the package is unresolvable. */
export function playwrightMcpServer(): { type: "stdio"; command: string; args: string[] } | null {
  const cli = resolvePlaywrightCli();
  if (!cli) return null;
  return { type: "stdio", command: process.execPath, args: [cli, "--headless", "--isolated"] };
}

/**
 * Resolve the Microsoft markitdown MCP (`markitdown-mcp`) console script to an ABSOLUTE path, for the
 * per-session document-conversion server injected ONLY for a documentConversion session (opt-in, gated).
 *
 * markitdown is a PYTHON tool, NOT a node_modules dependency, so it can't be resolved off `require`. Loom
 * owns ONE shared Python venv under `<LOOM_HOME>/python/venv` and pip-installs markitdown into it.
 *
 * EVENT-LOOP SAFETY (the load-bearing rule): this runs on the SYNCHRONOUS spawn hot path (`createPty` →
 * `buildMcpServers`), so it must do NO blocking work. Creating the venv + `pip install markitdown[all]`
 * takes minutes — running that via `spawnSync` here would FREEZE the whole daemon (every spawn/resume, the
 * web UI, all HTTP/MCP) for the entire install. So the hot path is fast + sync-safe only:
 *   (a) a HUMAN-only override via `LOOM_MARKITDOWN_BIN` — host-set, NEVER an agent MCP parameter (identical
 *       trust posture + mechanism to `LOOM_CLAUDE_BIN`). Resolved through `resolveExecutable` (fast, no
 *       child process); it's the TEST seam too (a fake binary, so CI never builds a venv). Checked FIRST.
 *   (b) else a single `fs.existsSync(loomVenvBin('markitdown-mcp'))` (instant): if the venv binary is
 *       present → inject it; if NOT → return null (this spawn skips the MCP, exactly like Playwright's
 *       missing-cli fallback) AND kick BACKGROUND provisioning ({@link kickMarkitdownProvision}) so the
 *       venv warms up off the event loop. A later spawn picks it up once the async job lands the binary.
 *
 * CACHE: memoize ONLY a resolved absolute path (success) — never memoize `null`, or a pre-warm skip would
 * stick forever. The not-ready case re-checks `fs.existsSync` cheaply on every spawn until it flips ready.
 */
let markitdownBin: string | undefined; // success memo (stable once resolved); never holds null
function resolveMarkitdownBin(pythonInterpreterPath?: string): string | null {
  if (markitdownBin) return markitdownBin;
  const override = process.env.LOOM_MARKITDOWN_BIN;
  if (override) {
    const resolved = resolveExecutable(override);
    if (path.isAbsolute(resolved)) { markitdownBin = resolved; return resolved; }
    return null; // human pointed the override somewhere unresolvable — respect it, don't auto-provision
  }
  const bin = loomVenvBin("markitdown-mcp");
  if (fs.existsSync(bin)) { markitdownBin = bin; return bin; } // venv warm → use it (and cache)
  kickMarkitdownProvision(pythonInterpreterPath); // cold → provision in the BACKGROUND; skip this spawn
  return null;
}

/**
 * Kick BACKGROUND provisioning of the shared venv's markitdown (async `child_process.spawn` under the hood
 * — NEVER `spawnSync`), so the heavy venv-create + pip install runs OFF the event loop. One-shot per daemon
 * process and deduped: an in-flight job or a prior attempt suppresses re-kicks, so concurrent documentConversion
 * spawns never launch parallel pip installs. On success it lands the resolved binary into the `markitdownBin`
 * memo (subsequent spawns inject it); on failure it warn-logs and documentConversion sessions keep spawning
 * WITHOUT the MCP until the daemon restarts (best-effort, the worktree-provisioning discipline).
 */
let markitdownProvisionInFlight: Promise<void> | null = null;
let markitdownProvisionTried = false;
let markitdownProvisionKicks = 0; // test observability (see __markitdownProvisionKicks)
function kickMarkitdownProvision(pythonInterpreterPath?: string): void {
  if (markitdownProvisionInFlight || markitdownProvisionTried) return; // dedupe + one-shot
  markitdownProvisionTried = true;
  markitdownProvisionKicks++;
  // eslint-disable-next-line no-console
  console.warn("[pty] markitdown venv not ready — provisioning in the BACKGROUND; documentConversion spawns skip the MCP until it's warm.");
  markitdownProvisionInFlight = ensurePythonPackageAsync({
    // markitdown-mcp is the MCP server / console script; markitdown[all] pulls the full
    // PDF/Office/image converters into the SAME shared venv.
    package: ["markitdown-mcp", "markitdown[all]"],
    binary: "markitdown-mcp",
    probeImport: "markitdown_mcp",
    interpreterOverride: pythonInterpreterPath,
  })
    .then((bin) => {
      if (bin) {
        markitdownBin = bin;
        // eslint-disable-next-line no-console
        console.warn(`[pty] markitdown venv ready (${bin}) — documentConversion sessions now spawn with the MCP.`);
      } else {
        // eslint-disable-next-line no-console
        console.warn("[pty] markitdown background provisioning did not complete (no base Python >=3.10, or venv/pip failed) — documentConversion sessions spawn WITHOUT the markitdown MCP. Install a base Python (or set python.interpreterPath) and restart.");
      }
    })
    .catch(() => { /* ensurePythonPackageAsync never throws; belt-and-suspenders */ })
    .finally(() => { markitdownProvisionInFlight = null; });
}

/** TEST-ONLY: how many times background markitdown provisioning has been kicked this process. */
export function __markitdownProvisionKicks(): number {
  return markitdownProvisionKicks;
}

/**
 * The stdio MCP-config entry for a documentConversion session, or null if markitdown can't be resolved
 * (no base Python / venv or pip failure). `markitdown-mcp` speaks STDIO by default and needs NO args (the
 * one tool, `convert_to_markdown(uri)`, accepts file:/http(s):/data: URIs) — the args difference from
 * Playwright. `pythonInterpreterPath` is the HUMAN-only `python.interpreterPath` (carried via session env).
 */
export function markitdownMcpServer(pythonInterpreterPath?: string): { type: "stdio"; command: string; args: string[] } | null {
  const bin = resolveMarkitdownBin(pythonInterpreterPath);
  if (!bin) return null;
  return { type: "stdio", command: bin, args: [] };
}

/**
 * Assemble the `--mcp-config` mcpServers map for a Claude spawn (extracted from createPty as the ONE
 * testable seam for the MCP surface). ALWAYS the project-scoped `loom-tasks` HTTP server; PLUS the
 * role-gated surface (manager/worker → loom-orchestration, platform → loom-platform, auditor → loom-audit,
 * workspace-auditor → loom-user-audit, setup → loom-setup);
 * PLUS — only when `browserTesting` is set — the per-session stdio Playwright MCP. The browser server is
 * fully ADDITIVE: with the flag off the map is byte-identical to today's. Pure + deterministic (no pty, no
 * network), so the spawn-config test can assert the iff-browserTesting inclusion directly.
 *
 * SECURITY (P5): an "auditor" session gets ONLY loom-tasks + loom-audit — NEVER loom-platform and NEVER
 * loom-orchestration. The restricted loom-audit surface (read transcripts + file findings) is its whole
 * tool world, so a prompt-injection in an audited transcript has no outward/destructive tool to reach.
 */
export function buildMcpServers(o: {
  sessionId: string; port: number; role?: SessionRole; browserTesting?: boolean; documentConversion?: boolean;
  /** HUMAN-only `python.interpreterPath` (carried via session env) — forwarded to the markitdown venv resolver. */
  pythonInterpreterPath?: string;
}): Record<string, unknown> {
  // Agent Runs R2: a `run` session gets ONLY the restricted run surface — NOT even loom-tasks. This is
  // the one path that does not mount loom-tasks (every other role layers ON TOP of it). The early return
  // keeps every non-run spawn byte-identical to today (a run is the only role that reaches this branch).
  if (o.role === "run") {
    return { "loom-run": { type: "http", url: `http://127.0.0.1:${o.port}/mcp-run/${o.sessionId}` } };
  }
  const wantsOrch = o.role === "manager" || o.role === "worker";
  const wantsPlatform = o.role === "platform";
  const wantsAudit = o.role === "auditor";
  const wantsUserAudit = o.role === "workspace-auditor";
  const wantsSetup = o.role === "setup";
  const mcpServers: Record<string, unknown> = {
    "loom-tasks": { type: "http", url: `http://127.0.0.1:${o.port}/mcp/${o.sessionId}` },
  };
  if (wantsOrch) {
    mcpServers["loom-orchestration"] = { type: "http", url: `http://127.0.0.1:${o.port}/mcp-orch/${o.sessionId}` };
  }
  if (wantsPlatform) {
    mcpServers["loom-platform"] = { type: "http", url: `http://127.0.0.1:${o.port}/mcp-platform/${o.sessionId}` };
  }
  if (wantsAudit) {
    mcpServers["loom-audit"] = { type: "http", url: `http://127.0.0.1:${o.port}/mcp-audit/${o.sessionId}` };
  }
  // End-User Platform tier B3: a "workspace-auditor" session gets ONLY the curated loom-user-audit surface
  // (on top of loom-tasks) — NEVER loom-platform/orchestration/audit/setup. A tool not registered there
  // can't be reached (its whole tool world is 2 reads + 2 inert daemon-local suggest-writes).
  if (wantsUserAudit) {
    mcpServers["loom-user-audit"] = { type: "http", url: `http://127.0.0.1:${o.port}/mcp-user-audit/${o.sessionId}` };
  }
  // Setup Assistant (E1-3): a "setup" session gets ONLY the curated loom-setup surface (on top of
  // loom-tasks) — NEVER loom-platform/orchestration/audit. A tool not registered there can't be reached.
  if (wantsSetup) {
    mcpServers["loom-setup"] = { type: "http", url: `http://127.0.0.1:${o.port}/mcp-setup/${o.sessionId}` };
  }
  // Opt-in: a per-session stdio Playwright MCP for a browser-testing worker (each gets its OWN
  // isolated headless browser — parallelizable, no shared extension/auth/state). Omitted for every
  // non-browser spawn, so the map is byte-identical to today when the flag is off. A null (unresolvable
  // package) is logged + skipped rather than crashing the spawn.
  if (o.browserTesting) {
    const pw = playwrightMcpServer();
    if (pw) {
      mcpServers["playwright"] = pw;
    } else {
      // eslint-disable-next-line no-console
      console.warn(`[pty] ${o.sessionId} browserTesting set but @playwright/mcp could not be resolved — spawning WITHOUT a browser MCP. Is the daemon dependency installed?`);
    }
  }
  // Opt-in: a per-session stdio markitdown MCP for a document-conversion session, so the agent can
  // convert files (PDF/Office/images/HTML/…) to Markdown to save tokens. Same additive discipline as
  // the Playwright server above: omitted for every non-documentConversion spawn (byte-identical map when
  // off). `markitdownMcpServer` is fast + sync-safe (fs.existsSync on the hot path); a null means the
  // shared venv isn't warm yet — it has kicked BACKGROUND provisioning, so THIS spawn just skips the MCP
  // (logged, never crashes), and a later spawn picks it up once the venv lands. The one-time host setup is
  // just a base Python ≥3.10 (PATH or python.interpreterPath); Loom provisions the venv.
  if (o.documentConversion) {
    const md = markitdownMcpServer(o.pythonInterpreterPath);
    if (md) {
      mcpServers["markitdown"] = md;
    } else {
      // eslint-disable-next-line no-console
      console.warn(`[pty] ${o.sessionId} documentConversion set but the markitdown venv isn't warm yet — spawning WITHOUT the document MCP (provisioning in the background; a later spawn will pick it up). Needs a base Python >=3.10 on PATH (or python.interpreterPath).`);
    }
  }
  return mcpServers;
}

interface Subscriber {
  onData: (b: Buffer) => void;
  onControl: (e: TerminalControl) => void;
}

/**
 * One entry in a session's busy-gated inbound FIFO. The `id` is a stable, server-minted handle (set
 * at enqueue) so the human-facing UI can delete / edit / reorder a SPECIFIC queued entry: the FIFO
 * head drains autonomously between the UI's poll and a click, so addressing by array index would hit
 * the wrong (shifted) entry — an id op instead targets exactly one message and is a safe no-op once
 * that message has drained. Internal to the host; the queue is in-memory and dies with the pty.
 *
 * `source` records who enqueued it: 'human' (only the REST composer, POST /input) or 'system'
 * (everything programmatic — worker reports, idle/context/busy nudges, resume notes, escalations).
 * It is the trust boundary the human-facing mutators enforce: delete/edit/reorder may only touch a
 * 'human' entry, so an agent's queued report can never be rewritten or reordered out from under it.
 *
 * `onDeliver` is an OPTIONAL, additive delivery callback (card 2ca18433): set ONLY by SessionService's
 * durable-message helpers, it fires the instant this held entry is actually HANDED to the recipient — at
 * the next Stop drain (drainPending) or via inbox_pull (consumePending) — so the durable queued-message
 * event can be marked delivered. It is NEVER invoked on the immediate idle-submit path (that returns
 * delivered:true synchronously and persists nothing), so the load-bearing M1/M2 busy-gate ordering is
 * untouched; for every existing (non-messaging) entry it is undefined → a no-op. Internal to the host
 * (stripped from getPendingEntries, never persisted), the callback dies with the pty like the queue.
 *
 * It takes an OPTIONAL `reason`: the drain/pull paths call it with NO arg (a plain delivery), while a
 * caller that RETIRES a held entry rather than delivering it — `flushPending`'s consumer (worker_redirect)
 * — passes a reason ("superseded") so the resolution event records WHY. Back-compatible: every existing
 * no-arg call leaves reason undefined (unchanged behaviour).
 */
export type QueueSource = "human" | "system";
export type QueuedMessage = { id: string; text: string; source: QueueSource; onDeliver?: (reason?: string) => void };

interface Live {
  pty: IPty;
  pid: number;
  cwd: string;
  // Discriminates the two pty species sharing this map. "claude" = an interactive Claude session
  // (the full machinery below: readiness gate, hook-driven busy, injection queue, mode-cycles…).
  // "shell" = a plain human-spawned interactive shell (pwsh/cmd/bash) — RAW passthrough only; ALL the
  // Claude-only logic (deliverHook/readiness/drain/reconcile/boot-reconcile) SKIPS it. A shell is NOT a
  // DB Session, so the orchestration watchers (which iterate DB sessions) never see it either.
  kind: "claude" | "shell";
  command?: string;   // shell only: the executable spawned (for GET /api/terminals)
  label?: string;     // shell only: human label for the tile
  geometry: PtyGeometry; // claude: the pinned grid (info only, never resized). shell: current size, resizable.
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
  composerLen: number;  // best-effort length of the human's UNCOMMITTED raw-terminal draft. >0 ("composer-dirty")
                        // HOLDS programmatic delivery so a queued turn can never land ON the human's half-typed
                        // text; reset to 0 by a box-freeing key (Enter/Ctrl-C/Esc/kill-line) or backspace-to-empty.
                        // The PRECISE collision signal (supersedes the old keystroke time-grace). Tracked in writeStdin.
  pending: QueuedMessage[]; // FIFO of messages held while busy / while the human types — drained on Stop + reconcile. Each carries a stable id so the UI can delete/edit/reorder a specific entry safely (an id op is a no-op once that entry has drained).
  stopping: boolean;    // a Stop is in flight — SUPPRESS drain/submit so a queued turn can't re-arm busy past it
  lastPrompt: string | null; // the most-recent submitted turn — re-sendable if the cap kills it (§19c-b)
  startupModeCycles: number; // Shift+Tab presses to inject once, after SessionStart, to reach the target mode
  startupCyclesDone: boolean; // guard so the cycle-inject fires at most once per session
  mcpPromptHandled: boolean;  // guard: dismiss the plugin-MCP enable-prompt with Esc at most once per session
  bootScan: string;           // bounded rolling buffer of early boot output, scanned for that prompt
  resumeGateHandled: boolean; // guard: select "as-is" on the resume-from-summary gate at most once per session
  resumeGateScan: string;     // bounded rolling buffer scanned for that gate (separate from bootScan)
  isResume: boolean;          // spawned with --resume (vs a fresh spawn) — for the landed-mode log only
  modeLogged: boolean;        // guard: log the landed permission mode at most once per session (observability)
  // RESUME ONLY: the permission mode to feedback-cycle the footer to after SessionStart (the mode a
  // fresh spawn of this config reaches — default auto). null = the FRESH path (blind startupModeCycles).
  resumeModeTarget: LandedMode | null;
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
  /**
   * Profile-pinned model id (resolved from the session's Profile, e.g. "claude-opus-4-8"). When set,
   * emit `--model <id>` into the spawn recipe. Undefined/absent ⇒ NO `--model` — byte-identical to
   * today (the engine default). Threaded ONLY by the fresh-start paths; a `--resume`/`--fork-session`
   * spawn omits it and inherits the conversation's model from the engine transcript.
   */
  model?: string;
  /** When set (docLint on), wires the vault-lint PostToolUse hook scoped to this vault (Pillar D). */
  vaultPath?: string;
  /**
   * Opt-in browser-automation (resolved from the session's Profile, gated). When true, inject a
   * per-session stdio Playwright MCP (@playwright/mcp) so the agent can drive a headless browser, and
   * allowlist its tool surface. Default OFF — every existing spawn is byte-identical when unset/false.
   */
  browserTesting?: boolean;
  /**
   * Opt-in document-conversion (resolved from the session's Profile, gated). When true, inject a
   * per-session stdio markitdown MCP (`markitdown-mcp`) so the agent can convert files to Markdown, and
   * allowlist its tool surface. Default OFF — every existing spawn is byte-identical when unset/false.
   */
  documentConversion?: boolean;
  /**
   * Profile-resolved skill-name SUBSET pinned on the session row (mirrors browserTesting): injectSkills
   * delivers ONLY these skills. null/empty/absent ⇒ ALL store skills (byte-identical to today). Threaded
   * on EVERY spawn path (fresh/resume/fork/recycle/boot) — read from the row, never re-resolved — so the
   * subset survives a respawn. Keyed per session so a concurrent session sharing the cwd is never stripped.
   */
  skills?: string[] | null;
  /**
   * RESUME ONLY (card f05e4897). The permission mode the resumed session must land in — the mode a
   * FRESH spawn of this config reaches (default `auto`). When set, host.ts feedback-cycles the footer
   * to it after SessionStart (bounded + graceful), instead of the FRESH path's blind `startupModeCycles`
   * presses. A `--resume` boots at the gate-free acceptEdits mode (probe-verified — `--resume` honours
   * `--permission-mode`, it does NOT restore the persisted mode), so without this nudge it would stay
   * one short of auto. Omit for fresh/fork/recycle spawns (they use the blind relative count and work).
   */
  resumeModeTarget?: LandedMode;
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
  /**
   * The pty exited. `intended` distinguishes a DELIBERATE Loom termination (any pty.stop() — graceful/
   * idle/user-stop/recycle/merge-stop/run-teardown, which set `live.stopping`) from an UNEXPECTED process
   * death (the process died without a stop() — a crash / clean self-exit). It is the load-bearing
   * discriminator the crash-recovery watchdog keys off (recorded at onExit time; a whole-daemon
   * restart/crash never reaches here, so those are excluded for free). See PtyHost.stop / Live.stopping.
   */
  onExit(sessionId: string, code: number | null, info: { intended: boolean }): void;
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
  /** Profile-pinned model id → `--model <id>`. Undefined/empty ⇒ NO `--model` (byte-identical to today). */
  model?: string;
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
  // Profile-pinned model: a real flag (precedes `--`). Emitted ONLY when set, so a profile-less /
  // model-null / resume / fork spawn is byte-identical (no `--model`) and inherits the engine default
  // (or, on resume, the conversation's own model from the transcript).
  if (o.model) args.push("--model", o.model);
  args.push("--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: o.mcpServers }));
  if (o.startupPrompt) args.push("--", o.startupPrompt);
  return args;
}

/**
 * Assemble the environment for a `claude` worker pty — extracted as a PURE, testable seam mirroring
 * buildMcpServers / buildSpawnArgs. Behavior-preserving for the INHERITED env: the CLAUDECODE/CLAUDE_CODE_*
 * scrub (those vars would make the nested `claude` believe it is running inside another claude) and the
 * sessionEnv merge are unchanged — PLUS three git-safety vars that close the "git wedges the UNATTENDED
 * worker pty" class:
 *   - GIT_PAGER=cat / PAGER=cat — git (and other pager-using tools) can never launch `less` and block
 *     forever on `q`. Without this a worker's post-commit `git diff`/`git log` could page and never
 *     return, freezing the turn at busy → a FALSE [loom:worker-stuck] trip + its worker_report queued
 *     undelivered (the bug this fixes).
 *   - GIT_TERMINAL_PROMPT=0 — git FAILS FAST on an auth/credential prompt instead of hanging on it
 *     (mirrors git/writer.ts; same unattended-wedge class as the pager).
 * The three are set BEFORE the sessionEnv merge, so a project that deliberately overrides any of them via
 * config.sessionEnv still wins (no capability regression). Every other byte of the env is identical to
 * before. Exported so the hermetic spawn-env test asserts the vars, the scrub, and the override.
 */
export function buildSpawnEnv(
  processEnv: Record<string, string | undefined>,
  sessionEnv: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(processEnv)) {
    if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) continue;
    if (v !== undefined) env[k] = v;
  }
  // Git-safety vars for the unattended worker pty (close the "git blocks the pty" wedge class). Set
  // BEFORE the sessionEnv merge so a project's deliberate override still wins.
  env.GIT_PAGER = "cat";
  env.PAGER = "cat";
  env.GIT_TERMINAL_PROMPT = "0";
  Object.assign(env, sessionEnv);
  return env;
}

/**
 * The host's default interactive shell, used to PREFILL the "+ Shell" modal (the human can override).
 * Windows: prefer PowerShell 7 (pwsh), else Windows PowerShell, else cmd — returned as an ABSOLUTE path
 * (node-pty's Windows agent doesn't search %PATH%). Unix: $SHELL, else /bin/bash. This is a convenience
 * default only — it confers no privilege; the spawn is still gated to the human REST path.
 */
export function detectDefaultShell(): string {
  if (process.platform === "win32") {
    for (const c of ["pwsh.exe", "powershell.exe", "cmd.exe"]) {
      const abs = resolveExecutable(c);
      if (abs !== c) return abs; // resolveExecutable returns the name unchanged when not found on PATH
    }
    return resolveExecutable("cmd.exe"); // System32 is always on PATH, so this resolves
  }
  return process.env.SHELL || "/bin/bash";
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
  /** Stuck-busy self-heal threshold (ms). Defaults to BUSY_STALE_MS; index.ts overrides with the
   *  resolved `platform.timeouts.busyStaleMs` at boot (BOOT-BOUND). */
  private readonly busyStaleMs: number;
  constructor(private events: PtyHostEvents, opts?: { busyStaleMs?: number }) {
    this.busyStaleMs = opts?.busyStaleMs ?? BUSY_STALE_MS;
  }

  spawn(opts: SpawnOpts): void {
    const pty = this.createPty(opts);
    const live: Live = {
      pty, pid: pty.pid, cwd: opts.cwd,
      kind: "claude",
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
      composerLen: 0,
      pending: [],
      stopping: false,
      // The startup-prompt turn runs from a CLI arg (not submit()), so seed lastPrompt with it —
      // a cap on the FIRST turn must still be re-submittable on resume (§19c-b).
      lastPrompt: opts.startupPrompt ?? null,
      // Boot is always gate-free (acceptEdits); cycle to the target mode once the TUI is up (SessionStart).
      startupModeCycles: opts.permission.startupModeCycles ?? 0,
      startupCyclesDone: false,
      mcpPromptHandled: false,
      bootScan: "",
      resumeGateHandled: false,
      resumeGateScan: "",
      isResume: !!opts.resumeId,
      modeLogged: false,
      resumeModeTarget: opts.resumeModeTarget ?? null,
    };
    this.live.set(opts.sessionId, live);

    pty.onData((d) => {
      const buf = Buffer.from(d, "utf-8");
      live.lastOutputAt = Date.now(); // engine is producing → not stuck (feeds the BUSY_STALE_MS heal)
      // A per-project "N new MCP servers found — enable?" prompt (e.g. docker/sentry, inherited from
      // ~/.mcp.json up-tree) can block the unattended boot BEFORE SessionStart. The PRIMARY fix now
      // pre-decides those servers in ~/.claude.json (ensureTrusted → disabledMcpjsonServers) so the
      // prompt never appears. This Esc scan is the BELT-AND-SUSPENDERS fallback for anything not
      // pre-decided (e.g. a plugin-provided server not in any .mcp.json): dismiss it once with Esc
      // ("reject all"). NOTE: the single fire-and-forget Esc can intermittently drop on Windows ConPTY
      // (card dacb8571) — that's why prevention, not this dismissal, is the real fix. Bounded rolling scan.
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
      // Resuming a large/old session shows a "resume from summary / as-is" gate BEFORE SessionStart
      // whose DEFAULT (option 1) summarizes — silently compacting away the manager's full context — and
      // which blocks the whole resume (mode-cycles + the queued boot nudge never run; the readiness
      // fallback then drains the nudge INTO the gate, selecting that default → the 2026-06-03 incident).
      // Always pick option 2 "Resume full session as-is": one Down then Enter (moves ❯ off option 1).
      if (!live.resumeGateHandled) {
        live.resumeGateScan = (live.resumeGateScan + d).slice(-8192);
        if (isResumeSummaryGate(collapseBoot(live.resumeGateScan))) {
          live.resumeGateHandled = true;
          live.resumeGateScan = "";
          // eslint-disable-next-line no-console
          console.log(`[pty] ${opts.sessionId} resume-summary gate → selecting "Resume full session as-is" (Down, Enter)`);
          setTimeout(() => {
            if (!live.alive) return;
            live.pty.write(DOWN_ARROW);
            setTimeout(() => { if (live.alive) live.pty.write(ENTER); }, 150);
          }, 300);
        }
      }
      this.appendRing(live, buf);
      live.logStream.write(buf);
      for (const s of live.subscribers) { try { s.onData(buf); } catch { /* ignore */ } }
    });
    pty.onExit(({ exitCode }) => {
      live.alive = false;
      // The pty is gone → empty the held queue so a stale "Queued (N)" can't linger after exit (the
      // live entry survives in the map with alive=false, and getPending reads live.pending). Covers
      // EVERY exit path — a Stop-initiated stop, a crash, a clean session end — not just stopWorker.
      live.pending.length = 0;
      // eslint-disable-next-line no-console
      console.log(`[pty] exit ${opts.sessionId} code=${exitCode} intended=${live.stopping}`);
      try { live.logStream.end(); } catch { /* ignore */ }
      this.broadcastControl(live, { type: "exit", code: exitCode });
      // `intended` = a deliberate Loom stop() was issued (live.stopping). An UNEXPECTED death never went
      // through stop(), so stopping stays false — the signal the crash-recovery watchdog keys off.
      this.events.onExit(opts.sessionId, exitCode, { intended: live.stopping });
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
   * Spawn a PLAIN interactive shell (pwsh/cmd/bash/…) in a project's repo cwd — the human's "open a
   * terminal in this repo" path, a sibling to spawn() that bypasses ALL the Claude-only machinery.
   * Bare node-pty spawn with inherited env (no CLAUDE_* scrub, no settings/MCP/skills/trust wiring),
   * registered in the `live` map with kind:"shell" so deliverHook/readiness/drain/reconcile skip it and
   * the orchestration watchers (which iterate DB Sessions, not this map) never see it.
   *
   * ╔═ TRUST BOUNDARY — HUMAN-ONLY ════════════════════════════════════════════════════════════════╗
   * ║ `command` is an arbitrary host executable path = HOST RCE BY DESIGN — the same hazard class as ║
   * ║ orchestration.gateCommand (which is rejected by the agent-facing config validator for exactly  ║
   * ║ this reason). spawnShell is therefore reachable ONLY from the HUMAN REST endpoint              ║
   * ║ POST /api/terminals (loopback-only) and is DELIBERATELY NOT exposed as any MCP tool. If a       ║
   * ║ manager/worker agent could spawn an arbitrary shell it would escape the acceptEdits sandbox →   ║
   * ║ full host compromise. Do NOT add a loom-orchestration / loom-platform / loom-tasks tool for it. ║
   * ╚═════════════════════════════════════════════════════════════════════════════════════════════════╝
   */
  spawnShell(opts: { id: string; cwd: string; command: string; args: string[]; geometry: PtyGeometry; label: string }): void {
    const pty = this.createShellPty(opts);
    const live: Live = {
      pty, pid: pty.pid, cwd: opts.cwd,
      kind: "shell", command: opts.command, label: opts.label,
      geometry: opts.geometry,
      engineSessionId: null,
      ring: { chunks: [], bytes: 0 },
      subscribers: new Set(),
      alive: true,
      logStream: fs.createWriteStream(path.join(LOGS_DIR, `${opts.id}.log`)),
      // The Claude-only state below is inert for a shell (nothing reads it once kind:"shell" gates the
      // hook/readiness/drain paths), but the Live shape is shared, so seed neutral values.
      busy: false, ready: true, busySince: null,
      lastOutputAt: Date.now(), composerLen: 0,
      pending: [], stopping: false, lastPrompt: null,
      startupModeCycles: 0, startupCyclesDone: true,
      mcpPromptHandled: true, bootScan: "",
      resumeGateHandled: true, resumeGateScan: "",
      isResume: false, modeLogged: true, // a shell has no claude footer/permission mode to read
      resumeModeTarget: null, // a shell never cycles a permission mode
    };
    this.live.set(opts.id, live);
    // Shell onData is minimal: NO boot-prompt / resume-gate scanning (those are Claude-TUI artifacts).
    pty.onData((d) => {
      const buf = Buffer.from(d, "utf-8");
      live.lastOutputAt = Date.now();
      this.appendRing(live, buf);
      live.logStream.write(buf);
      for (const s of live.subscribers) { try { s.onData(buf); } catch { /* ignore */ } }
    });
    pty.onExit(({ exitCode }) => {
      live.alive = false;
      // eslint-disable-next-line no-console
      console.log(`[pty] shell exit ${opts.id} code=${exitCode}`);
      try { live.logStream.end(); } catch { /* ignore */ }
      this.broadcastControl(live, { type: "exit", code: exitCode });
      // A shell is NOT a DB Session — do NOT call events.onExit (which persists Session/MCP state). It is
      // ephemeral with no resumable state, so just drop it from the live map; the web's list refetch
      // then removes its tile. (Explicitly excluded from boot-reconcile / restart-intent for the same reason.)
      this.live.delete(opts.id);
    });
  }

  /**
   * Resize a SHELL terminal's pty to fit the viewer's pane. Enabled for shells only — Claude ptys are
   * pinned (the fixed 120×40 / no-resize invariant exists for alt-screen repaint; a resize would garble
   * the Ink TUI), so this is a no-op for kind:"claude". Idempotent and best-effort.
   */
  resize(sessionId: string, cols: number, rows: number): void {
    const live = this.live.get(sessionId);
    if (!live?.alive || live.kind !== "shell") return;
    if (cols <= 0 || rows <= 0) return;
    try { live.pty.resize(cols, rows); } catch { /* ignore */ }
    live.geometry = { cols, rows };
  }

  /** List live shell terminals (for GET /api/terminals — the web re-attaches after a detach/reload). */
  listShells(): { id: string; cwd: string; command: string; label: string; alive: boolean }[] {
    const out: { id: string; cwd: string; command: string; label: string; alive: boolean }[] = [];
    for (const [id, live] of this.live) {
      if (live.kind !== "shell") continue;
      out.push({ id, cwd: live.cwd, command: live.command ?? "", label: live.label ?? "", alive: live.alive });
    }
    return out;
  }

  /**
   * Bare node-pty spawn for a shell — the ONE testable seam for spawnShell (mirrors createPty for the
   * Claude path): the claude-free shell test (test/shell-terminal.mjs) subclasses PtyHost and overrides
   * this to return a FAKE pty, so it exercises the kind:"shell" registration + Claude-only-skip logic
   * with no real process. Production NEVER overrides it. Resolves the command to an ABSOLUTE path
   * (node-pty's Windows agent doesn't search %PATH%) and inherits the daemon's env wholesale — a plain
   * shell behaves like the host's (no CLAUDE_* scrub: that exists only to boot a nested `claude`).
   */
  protected createShellPty(opts: { id: string; cwd: string; command: string; args: string[]; geometry: PtyGeometry }): IPty {
    const bin = resolveExecutable(opts.command);
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    // eslint-disable-next-line no-console
    console.log(`[pty] spawnShell ${opts.id} bin=${bin} cwd=${opts.cwd}`);
    return spawn(bin, opts.args, {
      name: "xterm-256color",
      cols: opts.geometry.cols,
      rows: opts.geometry.rows,
      cwd: opts.cwd,
      env,
    });
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
    try { injectSkills(opts.cwd, opts.sessionId, opts.skills ?? null); } catch (e) { console.log(`[pty] injectSkills failed (non-fatal): ${(e as Error).message}`); }
    // Both managers AND workers get the orchestration MCP — but a role-gated surface: managers
    // get the full coordination tools, workers get only worker_report (resolved server-side). A
    // platform-lead instead gets the loom-platform MCP (project/agent creation, Pillar C). acceptEdits
    // does NOT auto-approve MCP tools (the §9 lesson — why mcp__loom-tasks is in the default allow),
    // so allowlist the role's MCP server too, else the agent hangs on a prompt.
    const wantsOrch = opts.role === "manager" || opts.role === "worker";
    const wantsPlatform = opts.role === "platform";
    const wantsAudit = opts.role === "auditor";
    const wantsUserAudit = opts.role === "workspace-auditor";
    const wantsSetup = opts.role === "setup";
    const wantsRun = opts.role === "run";
    // A browser-testing session ALSO needs its Playwright MCP tools allowlisted — acceptEdits doesn't
    // auto-approve MCP tools (the §9 lesson), so without this the worker would hang on a permission
    // prompt the first time it calls a browser tool. Orthogonal to role (a browser session is a worker),
    // so it layers ON TOP of the role surface rather than replacing it. (P5: auditor → loom-audit only;
    // R2: run → loom-run only — acceptEdits doesn't auto-approve submit_result either, so allowlist it.)
    const roleAllow = wantsOrch ? ["mcp__loom-orchestration"]
      : wantsPlatform ? ["mcp__loom-platform"]
      : wantsAudit ? ["mcp__loom-audit"]
      : wantsUserAudit ? ["mcp__loom-user-audit"]
      : wantsSetup ? ["mcp__loom-setup"]
      : wantsRun ? ["mcp__loom-run"]
      : [];
    // A document-conversion session ALSO needs its markitdown MCP tool allowlisted (acceptEdits doesn't
    // auto-approve MCP tools — the §9 lesson), so it layers ON TOP of the role surface like browserTesting.
    const extraAllow = [
      ...roleAllow,
      ...(opts.browserTesting ? ["mcp__playwright"] : []),
      ...(opts.documentConversion ? ["mcp__markitdown__convert_to_markdown"] : []),
    ];
    const permission = extraAllow.length
      ? { ...opts.permission, allow: [...opts.permission.allow, ...extraAllow] }
      : opts.permission;
    const settingsPath = writeSessionSettings(opts.sessionId, permission, opts.vaultPath);

    // §6 scoping: route by session id in the URL path; daemon derives the project server-side. The
    // mcpServers map (loom-tasks + role surface + opt-in Playwright) is assembled by the testable seam.
    // The HUMAN-only python.interpreterPath rides the session env (config → pythonSessionEnv); read it here
    // and hand it to the shared-venv markitdown resolver (only consulted when documentConversion is on).
    const mcpServers = buildMcpServers({ sessionId: opts.sessionId, port: PORT, role: opts.role, browserTesting: opts.browserTesting, documentConversion: opts.documentConversion, pythonInterpreterPath: opts.sessionEnv?.LOOM_PYTHON_INTERPRETER });
    const args = buildSpawnArgs({ resumeId: opts.resumeId, fork: opts.fork, forkSessionId: opts.forkSessionId, settingsPath, mode: permission.mode, mcpServers, startupPrompt: opts.startupPrompt, model: opts.model });

    // Inherited env (CLAUDE_*/CLAUDECODE scrubbed) + sessionEnv merge + the three git-safety vars that
    // keep an unattended worker pty from wedging on a pager / credential prompt. See buildSpawnEnv.
    const env = buildSpawnEnv(process.env, opts.sessionEnv);
    // Obsidian auto-start: when the resolved config turned it on (LOOM_OBSIDIAN_AUTOSTART rode in via
    // sessionEnv → obsidianSessionEnv), hand the vault preflight helper its ABSOLUTE path so a vault skill
    // can `node "$LOOM_OBSIDIAN_PREFLIGHT"`. The asset path is daemon-side (not knowable in browser-pure
    // shared), so it's injected HERE, the single createPty chokepoint. Additive-when-off: with autoStart
    // off the var is absent and every existing spawn's env is byte-identical. A deliberate override wins.
    if (env.LOOM_OBSIDIAN_AUTOSTART === "1" && !env.LOOM_OBSIDIAN_PREFLIGHT) {
      env.LOOM_OBSIDIAN_PREFLIGHT = ENSURE_OBSIDIAN_SCRIPT;
    }

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
    if (live.kind === "shell") return; // shells have no hook relay; the busy/readiness machine is Claude-only
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
        // (the human Shift+Tab step), once per (re)spawn. BOTH a fresh spawn and a `--resume` boot at the
        // gate-free `mode` (acceptEdits) — `claude --resume` HONOURS `--permission-mode` and does NOT
        // restore the persisted mode (probe-verified on 2.1.163; card f05e4897). Two strategies:
        //   • FRESH spawn → BLIND relative cycling: the config's `startupModeCycles` (default 2) Shift+Tabs
        //     step acceptEdits → … → target (auto). Proven, byte-identical to before.
        //   • RESUME (resumeModeTarget set) → ABSOLUTE feedback cycling: drive the footer to the target
        //     mode by reading it and pressing Shift+Tab until it lands (cycleResumeToMode). A blind count
        //     is unreliable on the resume/summary-gate path (the old blind-2 half-landed on plan — the
        //     2026-06-03 strand bug; Fix A's blind-0 left it one short, stuck at acceptEdits), so resume
        //     converges by feedback instead. Bounded + graceful (worst case stays at acceptEdits).
        // The session is marked READY (which releases any queued injection) only AFTER the cycles land —
        // so a boot-recovery nudge can't interleave with the Shift+Tabs. That interleave was the
        // 2026-06-03 restart bug: the nudge stranded un-submitted in the composer and the mode stuck
        // mid-cycle on plan.
        if (!live.startupCyclesDone) {
          live.startupCyclesDone = true;
          if (live.resumeModeTarget) {
            this.cycleResumeToMode(sessionId, live.resumeModeTarget, () => this.markReady(sessionId));
          } else if (live.startupModeCycles > 0) {
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
   * human's raw composer is clean; otherwise HOLDS it FIFO and `drainPending` (on the next Stop, the
   * box-free transition, or the reconcile tick) delivers it. Two reasons not to write now:
   *   - busy: a mid-turn write corrupts the running turn (the original reason for the queue);
   *   - composer-dirty: writing onto the human's half-typed raw-terminal text concatenates the two
   *     into one garbled message (the observed manager/worker collision) — so we HOLD until the human
   *     frees their box (Enter/Ctrl-C/Esc/kill-line, or backspaces it empty). See deferForHumanDraft.
   * Also self-heals a STUCK-busy session first, so a report can't strand behind a phantom 'busy'.
   * Returns whether it went out now, or its 1-based queue position.
   *
   * `source` defaults to 'system' so EVERY existing programmatic caller (worker reports, idle/context/
   * busy nudges, resume notes, escalations) stays 'system' unchanged; only the REST composer passes
   * 'human'. A held entry's source is what the human-facing mutators gate on (see QueuedMessage).
   */
  enqueueStdin(sessionId: string, text: string, source: QueueSource = "system", onDeliver?: () => void): { delivered: boolean; position?: number } {
    const live = this.live.get(sessionId);
    if (!live?.alive) return { delivered: false };
    this.healIfStuck(live, sessionId);
    // `ready` gate: a freshly (re)spawned pty is not ready until SessionStart. Submitting before then
    // writes into a still-booting TUI — the Enter is swallowed and the text strands in the composer
    // (the 2026-06-03 restart bug). Hold it FIFO; markReady drains it once the engine is up.
    if (live.ready && !live.busy && !live.stopping && !this.deferForHumanDraft(live)) {
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
      // Immediate idle-submit: this IS the delivery, but we do NOT invoke onDeliver here — a message
      // delivered straight as a turn is never persisted as `session_message_queued` (the caller only
      // records the durable event on the delivered:false path below), so there's nothing to resolve. This
      // also keeps the load-bearing M1/M2 window byte-identical: no extra work on the synchronous submit.
      return { delivered: true };
    }
    // Held (busy / not-ready / composer-dirty). Carry the optional delivery callback so that when this
    // entry is finally handed to the recipient (drainPending or consumePending), the durable queued
    // message can be marked delivered. Undefined for every existing (non-messaging) caller → a no-op.
    live.pending.push({ id: randomUUID(), text, source, onDeliver });
    return { delivered: false, position: live.pending.length };
  }

  /**
   * A copy of a session's queued message TEXTS in FIFO order — the back-compat string view. This is
   * the contract service.ts relies on (restart snapshot, recycle carry) and any caller that only needs
   * the text; it is deliberately unchanged by the id-bearing data model. The UI uses getPendingEntries()
   * to get the stable ids it needs to address a specific entry.
   */
  getPending(sessionId: string): string[] {
    return (this.live.get(sessionId)?.pending ?? []).map((m) => m.text);
  }

  /**
   * Like getPending, but EXCLUDES durable-tracked messages (those carrying an `onDeliver` callback —
   * the down/cross-tree session_message/message_worker entries persisted as `session_message_queued`).
   * The daemon_restart intent snapshot uses THIS (card 2ca18433): the durable boot scan
   * (recoverUndeliveredMessagesOnBoot) owns re-enqueueing those on boot, so snapshotting them into
   * intent.pending too would deliver them TWICE on a normal restart. Non-durable held items (worker
   * reports, idle/resume nudges) carry no callback and stay in the snapshot, replayed exactly as before.
   */
  getPersistablePending(sessionId: string): string[] {
    return (this.live.get(sessionId)?.pending ?? []).filter((m) => !m.onDeliver).map((m) => m.text);
  }

  /**
   * A copy of a session's queued entries (id + text) in FIFO order — for the human-facing UI, which
   * needs the stable id to delete/edit/reorder a SPECIFIC entry (see QueuedMessage). Returns [] for an
   * unknown session. Entries are shallow-copied so a caller can't mutate the live FIFO through them.
   */
  getPendingEntries(sessionId: string): QueuedMessage[] {
    // Strip the internal `onDeliver` callback — the UI only needs {id,text,source}, and a function must
    // never escape the host (it isn't serializable and is meaningless outside this process).
    return (this.live.get(sessionId)?.pending ?? []).map(({ id, text, source }) => ({ id, text, source }));
  }

  /**
   * CONSUME a session's queued (not-yet-delivered) inbound messages: return them in FIFO order AND
   * CLEAR the queue, so they will NOT also drain later as injected turns. This is the manager's
   * pull-its-own-inbox path (the inbox_pull tool) — strictly better than waiting for drainPending,
   * which only releases ONE per turn boundary. A manager that read its reports proactively (via
   * worker_transcript) can pull-and-discard the redundant queued copies in one shot instead of each
   * draining as a wasted turn.
   *
   * SYNCHRONOUS by construction — it only detaches `live.pending` (no `await`, no submit()), so it
   * never enters deliverHook's M2 lower-busy→drain window and the M2 invariant is untouched. It also
   * adds NO "drain while busy" path: it removes messages, never writes them to the pty. Returns [] for
   * an unknown session. The auto-drain (drainPending/reconcile) safety net is unaffected — a manager
   * that never pulls still gets every message delivered the normal way; a pulled message is gone from
   * the same `live.pending`, so it can't also drain.
   */
  consumePending(sessionId: string): string[] {
    const live = this.live.get(sessionId);
    if (!live?.alive) return []; // dead/unknown session: nothing to consume (don't hand back a stale queue)
    const removed = live.pending.splice(0); // empty the queue in place AND keep the removed entries
    // inbox_pull HANDS these to the recipient (it returns them to the agent) — that's delivery, so fire
    // each entry's optional delivery callback (durable-message resolution) so a pulled message is marked
    // delivered and won't be re-enqueued on a later boot. Guarded; undefined for non-messaging entries.
    for (const m of removed) { if (m.onDeliver) { try { m.onDeliver(); } catch { /* never break the pull */ } } }
    return removed.map((m) => m.text); // string contract unchanged
  }

  /**
   * Splice and RETURN a session's entire pending FIFO as its raw id-bearing entries (onDeliver INCLUDED —
   * unlike getPendingEntries, which strips it for the UI). The redirect path (SessionService.redirectWorker)
   * uses this to SUPERSEDE a busy worker's queued direction before enqueueing the one authoritative redirect:
   * it RETIRES the flushed entries rather than delivering them, firing each durable entry's onDeliver with a
   * "superseded" reason so the boot-recovery scan + the worker_report done-guard never re-drive them.
   *
   * DISTINCT from consumePending: this neither delivers nor fires onDeliver itself — the caller decides the
   * fate of each entry (consumePending = "I delivered these"; flushPending = "I'm discarding these, here they
   * are so you can resolve them how you see fit"). SYNCHRONOUS (array splice only — no await, no submit, no
   * pty write), so it never enters deliverHook's M2 lower-busy→drain window. Returns [] for a dead/unknown
   * session. Internal to the host (called by SessionService), never exposed to the UI or an agent.
   */
  flushPending(sessionId: string): QueuedMessage[] {
    const live = this.live.get(sessionId);
    if (!live?.alive) return [];
    return live.pending.splice(0); // empty the queue in place AND hand the removed entries (with onDeliver) back
  }

  /**
   * The three human-facing queue mutators (delete / edit / reorder a queued entry). All are addressed
   * by the stable QueuedMessage.id and are SYNCHRONOUS BY CONSTRUCTION — they only touch the
   * `live.pending` array (no `await`, no submit(), never a pty write), exactly like consumePending. So
   * they never enter deliverHook's lower-busy→drain window, the M1/M2 busy-gate invariants are
   * untouched, and they are safe to call at ANY time (busy, idle, or mid turn-finalize): editing or
   * removing a HELD message can't corrupt the running turn because nothing is written to the engine.
   * An op whose id is no longer present (the entry already drained, or a stale client id) is a graceful
   * no-op returning false — the whole reason ids exist (an index would silently hit the wrong, shifted
   * entry). The auto-drain (drainPending/reconcile) safety net is unaffected.
   *
   * SOURCE GATE: a mutator may only touch a 'human' entry. An op aimed at a 'system' entry (a worker
   * report / nudge) is REFUSED — it returns false WITH `refused:true` (the REST layer maps that to a
   * 403) and leaves the entry untouched, so an agent's queued report can never be deleted, rewritten,
   * or reordered out from under it. (A missing id stays a plain false with no `refused` — it's not a
   * boundary violation, just a lost race with the drain.)
   */
  deleteQueued(sessionId: string, id: string): { deleted: boolean; refused?: boolean } {
    const live = this.live.get(sessionId);
    if (!live?.alive) return { deleted: false };
    const i = live.pending.findIndex((m) => m.id === id);
    if (i < 0) return { deleted: false }; // already drained / unknown id — safe no-op
    if (live.pending[i]!.source !== "human") return { deleted: false, refused: true }; // system entry — read-only
    live.pending.splice(i, 1);
    return { deleted: true };
  }

  editQueued(sessionId: string, id: string, text: string): { edited: boolean; refused?: boolean } {
    const live = this.live.get(sessionId);
    if (!live?.alive) return { edited: false };
    const m = live.pending.find((m) => m.id === id);
    if (!m) return { edited: false }; // already drained / unknown id — safe no-op
    if (m.source !== "human") return { edited: false, refused: true }; // system entry — read-only
    m.text = text; // identity (id) and FIFO position preserved; only the body changes
    return { edited: true };
  }

  /**
   * Reorder the held FIFO. Only HUMAN entries may move: `orderedIds` is the human entries' desired
   * order, and the permutation is applied IN PLACE within the slots human entries currently occupy —
   * every 'system' entry keeps its absolute FIFO position, so a human reorder can never reposition (or
   * jump ahead of) a worker report. Reconciled against the CURRENT queue: ids not present are skipped
   * (drained/unknown), and any human entry NOT named (e.g. one enqueued after the client's snapshot) is
   * preserved and appended after the named ones in its existing relative order — so a reorder can never
   * silently drop a message. REFUSED (reordered:false, refused:true) if any named id targets a 'system'
   * entry — the UI never sends one, so this is a guard against a hand-rolled request. Returns
   * reordered:false (no refused) only for a dead/unknown session.
   */
  reorderQueued(sessionId: string, orderedIds: string[]): { reordered: boolean; refused?: boolean } {
    const live = this.live.get(sessionId);
    if (!live?.alive) return { reordered: false };
    const byId = new Map(live.pending.map((m) => [m.id, m] as const));
    // Boundary guard: a named id that resolves to a system entry is a trust-boundary violation — refuse
    // the whole op rather than silently dropping that id (which would let a caller probe the queue).
    for (const id of orderedIds) {
      const m = byId.get(id);
      if (m && m.source !== "human") return { reordered: false, refused: true };
    }
    // Desired order of the HUMAN entries: named-first (present, human, deduped), then any un-named human
    // entries in their existing relative order.
    const seen = new Set<string>();
    const humanSeq: QueuedMessage[] = [];
    for (const id of orderedIds) {
      const m = byId.get(id);
      if (m && m.source === "human" && !seen.has(id)) { humanSeq.push(m); seen.add(id); }
    }
    for (const m of live.pending) if (m.source === "human" && !seen.has(m.id)) { humanSeq.push(m); seen.add(m.id); }
    // Rebuild in place: system entries hold their slot; each human slot takes the next from humanSeq.
    let hi = 0;
    const next = live.pending.map((m) => (m.source === "human" ? humanSeq[hi++]! : m));
    live.pending.splice(0, live.pending.length, ...next);
    return { reordered: true };
  }

  /**
   * True while a programmatic turn must be HELD rather than delivered, because the human has an
   * uncommitted RAW-terminal draft that delivery would land on top of (the concatenation bug). The
   * signal is composer-dirty (`composerLen > 0`) — precise: it holds for exactly as long as a draft
   * exists and releases the instant the box is freed/emptied (writeStdin drains on that transition).
   * It SUPERSEDES the old keystroke time-grace, which couldn't tell a held-then-backspaced-empty box
   * from a still-dirty one. Conservative by construction: it only ever causes us to WAIT, never to
   * touch the human's bytes.
   */
  private deferForHumanDraft(live: Live): boolean {
    return live.composerLen > 0;
  }

  /** Clear a phantom 'busy' (busy with no engine output for BUSY_STALE_MS) so its queue can drain. */
  private healIfStuck(live: Live, sessionId: string): void {
    const now = Date.now();
    if (live.busy && live.busySince != null
      && now - live.busySince > this.busyStaleMs && now - live.lastOutputAt > this.busyStaleMs) {
      this.setBusy(sessionId, false);
    }
  }

  /**
   * Deliver ALL queued messages when it's safe (idle + composer free), COALESCED into ONE turn. Shared
   * by Stop + reconcile + the markReady / box-free transitions.
   *
   * COALESCE (mirror consumePending's splice-all): we drain the ENTIRE pending FIFO as one concatenated,
   * framed turn — splice the whole queue, join the texts in FIFO order with a visible separator, do
   * exactly ONE submit() (one busy re-arm, one `\r`), and fire EVERY spliced entry's onDeliver so every
   * durable session_message_queued record resolves. Previously this shift()'d ONE entry then submit()'d,
   * and submit() re-arms busy SYNCHRONOUSLY (M1), so the rest couldn't drain until the NEXT Stop hook —
   * that one-per-turn asymmetry (a worker had no consumePending equivalent) let 3 superseding manager
   * redirects replay one-at-a-time. Now all pending direction reaches the recipient in a single turn.
   *
   * STILL one submit per drain: the splice + concat + submit are SYNCHRONOUS in one tick, so the
   * load-bearing M1/M2 busy-gate invariants are untouched (the Stop branch still lowers busy and drains
   * in the same tick; this just hands over the whole FIFO instead of its head). Daemon-wide, no role
   * special-casing — managers benefit too.
   */
  private drainPending(sessionId: string): void {
    const live = this.live.get(sessionId);
    if (!live?.alive || !live.ready || live.busy || live.pending.length === 0) return;
    // A Stop is in flight → do NOT submit a queued turn. The interrupt lowers busy and fires a Stop
    // hook; draining here would re-arm busy and defeat the stop (the queued turn "fights" the stop —
    // each Ctrl-C just interrupts the freshly-drained turn, so it takes N escalating clicks to land).
    // stop() also clears the queue, so this is belt-and-suspenders for a late enqueue during the stop.
    if (live.stopping) return;
    if (this.deferForHumanDraft(live)) return; // HOLD while the human's raw composer is dirty — never land on half-typed text
    const drained = live.pending.splice(0); // splice the WHOLE FIFO (mirror consumePending) — coalesce all into one turn
    this.submit(sessionId, drained.map((m) => m.text).join(DRAIN_SEPARATOR)); // one submit, one busy re-arm, FIFO order preserved
    // ADDITIVE delivery hook (card 2ca18433): every drained entry was just handed to the recipient as
    // part of this turn — fire each callback (durable-message resolution) AFTER submit, outside the
    // M1/M2 ordering. Guarded so a faulty callback can never disturb the drain. Undefined for every
    // non-messaging entry → a no-op.
    for (const msg of drained) { if (msg.onDeliver) { try { msg.onDeliver(); } catch { /* a delivery-marking fault never breaks the drain */ } } }
  }

  /**
   * Periodic safety net (wired to a timer in index.ts): self-heal stuck-busy sessions and drain any
   * queue that's been waiting (a report queued behind a phantom 'busy', or held while the human typed
   * and has since stopped). Without this, a queued message only ever drains on a Stop hook — which a
   * stuck session never fires.
   */
  reconcile(): void {
    for (const [sessionId, live] of this.live) {
      if (!live.alive || live.kind === "shell") continue; // shells have no busy/queue to heal or drain
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

  /** Read the current permission mode off the tail of a session's output ring (the repainted footer). */
  private readFooterMode(live: Live): LandedMode {
    const recent = Buffer.concat(live.ring.chunks).toString("utf8").slice(-8192);
    return detectPermissionMode(recent).mode;
  }

  /**
   * RESUME-path permission-mode convergence (card f05e4897) — supersedes Fix A's blind startupModeCycles:0.
   * A `--resume` boots at the gate-free acceptEdits mode (it honours --permission-mode; probe-verified on
   * 2.1.163), so it lands ONE Shift+Tab short of where a fresh manager lands (auto). Rather than cycle a
   * fixed COUNT (unreliable on the resume/summary-gate path), drive the footer to `target` ABSOLUTELY:
   * read the mode, and while it isn't the target press ONE Shift+Tab and then WAIT for the footer to
   * actually CHANGE before deciding again — so a laggy repaint can never trick us into over-pressing past
   * the target. The per-step decision is the pure `nextCycleAction`; this method only supplies the timing
   * + the footer reads (the real-claude probe validates the live sequencing).
   *
   * BOUNDED + GRACEFUL — it NEVER infinite-loops and NEVER wedges boot: every terminating branch (reached
   * the target / hit the press cap / footer unreadable / a press didn't move the footer / pty gone) calls
   * `onDone` exactly once (markReady), so queued injections are released only AFTER the mode settles, and
   * the worst case simply leaves the session at its acceptEdits boot mode (today's behaviour). Total time
   * is sized to finish well under READY_FALLBACK_MS so the readiness fallback can't fire mid-cycle.
   */
  private cycleResumeToMode(sessionId: string, target: LandedMode, onDone: () => void): void {
    let presses = 0;
    let finished = false;
    const finish = (reason: string, mode: LandedMode): void => {
      if (finished) return;
      finished = true;
      // eslint-disable-next-line no-console
      console.log(`[resume-mode] ${sessionId} cycle→${target}: ${reason} after ${presses} press(es) (mode=${mode})`);
      onDone();
    };
    // Decide on a freshly-read, settled mode: at the target → stop; out of presses → stop (leave as-is);
    // else press one Shift+Tab and wait for the footer to change before the next decision.
    const decide = (cur: LandedMode): void => {
      const live = this.live.get(sessionId);
      if (!live?.alive) { finish("pty-gone", cur); return; }
      const action = nextCycleAction({ current: cur, target, presses, maxPresses: RESUME_MODE_MAX_PRESSES });
      if (action === "done") { finish("reached", cur); return; }
      if (action === "giveup") { finish("press-cap", cur); return; }
      presses++;
      live.pty.write(SHIFT_TAB);
      setTimeout(() => awaitChange(cur, 0), RESUME_MODE_READ_POLL_MS);
    };
    // After a press, poll until the footer reads a definite mode DIFFERENT from `prev` (the press
    // registered), then re-decide. If it never changes within the cap, stop gracefully (don't risk an
    // overshoot by pressing again on a stale read).
    const awaitChange = (prev: LandedMode, polls: number): void => {
      const live = this.live.get(sessionId);
      if (!live?.alive) { finish("pty-gone", prev); return; }
      const cur = this.readFooterMode(live);
      if (cur !== "unknown" && cur !== prev) { decide(cur); return; }
      if (polls < RESUME_MODE_CHANGE_MAX_POLLS) { setTimeout(() => awaitChange(prev, polls + 1), RESUME_MODE_READ_POLL_MS); return; }
      finish("footer-unchanged", cur);
    };
    // Initial: the footer may still be painting when SessionStart fires — poll until it's readable, then
    // make the first decision off the real boot mode (never press blindly on an "unknown" read).
    const awaitReadable = (polls: number): void => {
      const live = this.live.get(sessionId);
      if (!live?.alive) { finish("pty-gone", "unknown"); return; }
      const cur = this.readFooterMode(live);
      if (cur !== "unknown") { decide(cur); return; }
      if (polls < RESUME_MODE_CHANGE_MAX_POLLS) { setTimeout(() => awaitReadable(polls + 1), RESUME_MODE_READ_POLL_MS); return; }
      finish("footer-unreadable", "unknown");
    };
    setTimeout(() => awaitReadable(0), MODE_CYCLE_SETTLE_MS);
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
    this.logLandedMode(sessionId); // OBSERVABILITY: record what permission mode we actually landed in
  }

  /**
   * OBSERVABILITY ONLY (card f05e4897) — record, to the daemon log, what permission mode a (re)spawned
   * session actually LANDED in once it settled (mode-cycles/gate handling done + markReady). PURELY a
   * READ + LOG: it never writes to the pty, never cycles or changes the mode, and never touches the
   * readiness/busy/drain/gate machinery — boot behavior is byte-identical with or without it. It exists
   * so a real prod `--resume` (esp. the large-session summary-gate path) gives ground truth on whether
   * the session lands in plan vs acceptEdits/auto, instead of us guessing.
   *
   * Best-effort + bounded: polls the ring (the existing rolling output buffer) a few times to let the
   * footer repaint into its final state, logs as soon as a mode is read, and gives up after a short cap
   * (logging mode=unknown). Fires at most once per session (modeLogged guard). Shells are excluded.
   */
  private logLandedMode(sessionId: string): void {
    const live = this.live.get(sessionId);
    if (!live || live.kind !== "claude" || live.modeLogged) return;
    live.modeLogged = true; // claim it once, up front — a repeat markReady won't re-schedule this
    const isResume = live.isResume;
    let attempts = 0;
    const tryRead = (): void => {
      const l = this.live.get(sessionId);
      if (!l) return;
      attempts++;
      const recent = Buffer.concat(l.ring.chunks).toString("utf8").slice(-8192);
      const { mode, matchedToken } = detectPermissionMode(recent);
      // Keep polling only while we still can't read a footer at all (still booting). A definite read —
      // incl. the unlabeled "default" — is final. Stop at the cap or once the pty is gone.
      if (mode === "unknown" && attempts < MODE_LOG_MAX_ATTEMPTS && l.alive) {
        setTimeout(tryRead, MODE_LOG_POLL_MS);
        return;
      }
      const snippet = collapseFooter(recent).slice(-160); // short, ANSI-free evidence for the log
      // eslint-disable-next-line no-console
      console.log(`[resume-mode] ${sessionId} kind=${isResume ? "resume" : "fresh"} mode=${mode} matched=${matchedToken ?? "-"} footer=${JSON.stringify(snippet)}`);
    };
    setTimeout(tryRead, MODE_LOG_POLL_MS);
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
    // Write the human's bytes to the pty FIRST — they must stay AHEAD of any held programmatic turn in
    // the pty's FIFO input stream. A box-freeing key (e.g. Enter) is a tiny chunk written synchronously
    // here, so the subsequent drain below submits its paste strictly behind that Enter → claude processes
    // the human's line first, then the held turn lands on the now-empty composer (no concatenation).
    this.writeChunked(sessionId, data);
    if (live) {
      // Track the human's UNCOMMITTED raw-terminal draft (composer-dirty) so a programmatic turn never
      // lands on half-typed text. We NEVER touch the human's bytes — we only HOLD delivery while dirty.
      const wasDirty = live.composerLen > 0;
      live.composerLen = nextComposerLen(live.composerLen, data);
      // Box-free transition (submitted / cleared / backspaced-to-empty): drain the held queue PROMPTLY
      // — don't wait for the reconcile tick — so a held programmatic turn delivers right after the
      // human frees their box. drainPending is fully guarded (no-op if busy/stopping/empty/not-ready).
      if (wasDirty && live.composerLen === 0) this.drainPending(sessionId);
    }
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
    // A Stop intent must NOT be defeated by a queued inbound turn re-arming busy. Mark the session
    // STOPPING (drainPending/enqueueStdin then refuse to submit a new turn) and CLEAR the held queue,
    // so a queued composer turn ("sends when turn ends") can't be drained by the very Stop hook the
    // interrupt fires — which used to re-arm busy and make stop take ~3 escalating clicks. Synchronous
    // field writes only (no await) → the M2 lower-busy→drain window in deliverHook is untouched.
    live.stopping = true;
    live.pending.length = 0;
    if (mode === "hard") {
      live.pty.kill(); // TerminateProcess on Windows; node-pty Job Object kills the tree (no orphans)
      return;
    }
    // graceful: double Ctrl-C exits an IDLE claude (resumable, clean) — and for an idle session this is
    // the whole story (it exits here; the escalation below is a no-op). A BUSY/mid-turn session instead
    // has its turn INTERRUPTED by the two Ctrl-Cs and stays alive at an idle prompt (no Stop hook fires,
    // so busy stays stale) — escalateGracefulStop is what then drives it deterministically to exit.
    live.pty.write("\x03");
    setTimeout(() => { if (live.alive) live.pty.write("\x03"); }, GRACEFUL_STOP_GAP_MS);
    this.escalateGracefulStop(sessionId, live);
  }

  /**
   * Deterministic graceful-stop escalation (see GRACEFUL_STOP_* for the why). Drives a BUSY/mid-turn
   * session — whose turn the initial double Ctrl-C only INTERRUPTED, leaving the pty alive — the rest of
   * the way to `exited`, so a graceful stop ALWAYS terminates and never leaves a "stopped" session live.
   *   • Stage 2 (RETRY): still alive → the turn has unwound to an idle prompt; re-send the exit sequence.
   *   • Stage 3 (KILL): STILL alive at the hard bound → a wedged turn that ignores Ctrl-C; hard-kill the
   *     pty (Job Object, orphan-free). This is the backstop that makes "graceful" deterministic.
   * Every timer captures the SAME `live` and guards on `live.alive`, so once the pty exits (or its Live is
   * REPLACED by a resume's fresh spawn — the old object keeps alive=false forever) each timer is an inert
   * no-op. It therefore can NEVER kill a resumed session, and an IDLE stop (exited on stage 1) runs neither
   * stage — its behaviour is unchanged. The pty.kill goes through the same orphan-free path as a hard stop.
   */
  private escalateGracefulStop(sessionId: string, live: Live): void {
    // Stage 2: the interrupt didn't exit the process → re-send the exit sequence from the idle prompt.
    setTimeout(() => {
      if (!live.alive) return; // idle session already exited on the first sequence — nothing to escalate
      // eslint-disable-next-line no-console
      console.log(`[pty] ${sessionId} graceful stop: still live after interrupt — re-sending exit sequence`);
      live.pty.write("\x03");
      setTimeout(() => { if (live.alive) live.pty.write("\x03"); }, GRACEFUL_STOP_GAP_MS);
    }, GRACEFUL_STOP_RETRY_MS);
    // Stage 3: a turn that ignores Ctrl-C entirely must still die — bounded hard-kill escalation.
    setTimeout(() => {
      if (!live.alive) return;
      // eslint-disable-next-line no-console
      console.log(`[pty] ${sessionId} graceful stop: still live after ${GRACEFUL_STOP_KILL_MS}ms — escalating to hard kill`);
      live.pty.kill();
    }, GRACEFUL_STOP_KILL_MS);
  }

  /**
   * REDIRECT interrupt (worker_redirect, the "land it NOW" steer): END a BUSY worker's current turn so a
   * freshly-enqueued redirect drains as the very next turn. Writes a SINGLE Esc — "stop generating, return
   * to the prompt" — GENTLER than stop()'s Ctrl-C×2 (which EXITS the process). Like the Ctrl-C interrupt,
   * an Esc-cancel fires NO Stop hook, so `busy` would go STALE (the same gap healIfStuck/escalateGracefulStop
   * cover); after a BOUNDED settle we SYNCHRONOUSLY setBusy(false) + drainPending in the SAME tick — exactly
   * like deliverHook's Stop branch (respecting the M2 window: NO await between the two) — so the redirect
   * that redirectWorker enqueued before calling us is delivered (coalesced) as the next turn.
   *
   * NO-OP unless there's a live, in-flight turn to interrupt: a dead/unknown session, a session already
   * `stopping` (a real stop must win — never fight it / re-arm busy past it), or an idle (busy=false) one
   * (nothing to cancel — redirectWorker submits the redirect as a normal turn for the idle case and only
   * calls us when the redirect was HELD, i.e. the worker was busy).
   *
   * The settle callback SNAPSHOTS busySince at interrupt time and bails if it changed — guarding the narrow
   * race where the worker's real turn ends NATURALLY (a real Stop drains the redirect and the worker starts
   * acting on it, re-arming busy with a NEW busySince) within the settle window: we must NOT then clobber
   * that live turn's busy. If it ended and stayed idle, our setBusy(false) is a harmless idempotent repeat.
   */
  interruptForRedirect(sessionId: string): void {
    const live = this.live.get(sessionId);
    if (!live?.alive || live.stopping || !live.ready || !live.busy) return; // nothing in flight to interrupt
    const busySinceAtInterrupt = live.busySince; // snapshot: a NEW turn (re-armed busy) updates this
    live.pty.write(ESC_KEY); // single Esc: cancel the in-flight generation, return to the idle prompt
    setTimeout(() => {
      const l = this.live.get(sessionId);
      if (!l?.alive || l.stopping || !l.ready) return; // died / a real stop won / never readied → drop the self-clear
      if (!l.busy) return;                              // a real Stop already cleared it (and drained) — nothing to heal
      if (l.busySince !== busySinceAtInterrupt) return; // a NEW turn started since the Esc — do NOT clobber its busy
      // No Stop hook fired on the Esc-cancel → clear the stale busy OURSELVES and drain the redirect in the
      // SAME tick (the M2 window: strictly no await between setBusy(false) and drainPending), mirroring the
      // Stop branch. finalizingTurn arms the same tripwire so a future async leak here is caught loudly.
      this.finalizingTurn = true;
      try {
        this.setBusy(sessionId, false);
        this.drainPending(sessionId);
      } finally {
        this.finalizingTurn = false;
      }
    }, REDIRECT_SETTLE_MS);
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
