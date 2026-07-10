import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { spawn as spawnProcess } from "node:child_process";
import { spawn, type IPty } from "node-pty";
import type { PermissionPolicy, PtyGeometry, SessionRole, CompanionRoute, CapabilityGrant } from "@loom/shared";
import type { TerminalControl, StopMode } from "@loom/shared";
import { resolveProfileCapabilities } from "@loom/shared";
import { resolveExecutable } from "./resolve-bin.js";
import { writeSessionSettings, writeSessionMcpConfig } from "./claude-settings.js";
import { ensureTrusted } from "./claude-config.js";
import { injectSkills } from "../skills/inject.js";
import { readContextStats, type ContextStats } from "../sessions/context.js";
import { detectUsageLimit, isWeeklyUsageLimitSentinel, rateLimitedUntil } from "../orchestration/usage-limit.js";
import { PORT, LOGS_DIR, ENSURE_OBSIDIAN_SCRIPT, sessionScratchDir, isLoomDev } from "../paths.js";
import { loomVenvBin, ensurePythonPackageAsync } from "../python/venv.js";
import type { EnsurePythonPackageOpts, EnsurePythonResult, ProvisionOutcome } from "../python/venv.js";
import { resolveCapabilityServer, type CapabilityDefRow } from "../capabilities/registry.js";

const RING_CAP_BYTES = 256 * 1024;
/**
 * Gap between writing a turn's text and writing the FIRST Enter (\r) that submits it. A SINGLE
 * `text + "\r"` write does NOT submit a second turn to a running claude v2.1.150 session — the
 * trailing \r is swallowed with the text and no UserPromptSubmit fires (observed; this also
 * explains PR #9's earlier injected-turn finding). Writing Enter as a separate write a beat
 * later submits reliably. (Revises the roadmap's S2 "single raw write" note.)
 *
 * This constant alone is NOT the fix for a swallowed/dropped Enter (card 9549e322) — it is just
 * the initial gap before the FIRST attempt. `pasteSettleExtraMs` scales that initial gap with the
 * paste size, and `sendEnterAndVerify`'s verify-and-retry loop (below) is the real backstop: it
 * re-sends the Enter on a bounded schedule until `UserPromptSubmit` (or a Stop/StopFailure, which
 * implies a turn ran) confirms the turn actually started.
 */
const SUBMIT_ENTER_DELAY_MS = Number(process.env.LOOM_SUBMIT_ENTER_DELAY_MS) || 150;

/** Extra bytes of paste body absorbed per extra ms added to the initial pre-Enter delay — a larger
 * injected message (a worker report, a coalesced multi-message drain) gives claude's TUI more real
 * time to finish ingesting/re-rendering the paste before the first Enter races it. Capped by
 * SUBMIT_ENTER_DELAY_MAX_EXTRA_MS so a huge paste can't stall the first attempt for seconds — the
 * verify-retry loop is what actually guarantees delivery, this is just a better-aimed first shot. */
const SUBMIT_ENTER_DELAY_BYTES_PER_MS = 50;
const SUBMIT_ENTER_DELAY_MAX_EXTRA_MS = 1500;
function pasteSettleExtraMs(textLength: number): number {
  return Math.min(SUBMIT_ENTER_DELAY_MAX_EXTRA_MS, Math.ceil(textLength / SUBMIT_ENTER_DELAY_BYTES_PER_MS));
}

/**
 * How long to wait for `UserPromptSubmit` (or a Stop/StopFailure, either of which proves a turn ran)
 * to confirm a written Enter actually registered, before re-sending it. Bounds the verify-and-retry
 * loop in `sendEnterAndVerify`. Env-overridable so tests can shrink it instead of waiting real seconds.
 */
const SUBMIT_VERIFY_TIMEOUT_MS = Number(process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS) || 900;

/** Total Enter attempts (the first write + retries) before giving up and recovering busy. */
const SUBMIT_MAX_ATTEMPTS = Number(process.env.LOOM_SUBMIT_MAX_ATTEMPTS) || 4;

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
 * The coalescing key for a queued message's route (Loom Companion multi-channel routing). A NO-route
 * message (every non-companion inject — manager→worker direction, nudges, reports) maps to the EMPTY key,
 * so all no-route messages share one key and coalesce ALL-TOGETHER exactly as before. A routed companion
 * inbound keys on channel+chatId (NUL-joined, unambiguous), so a different route breaks the coalescing run.
 */
function routeKeyOf(route?: TurnRoute): string {
  return route ? `${route.channel}\x00${route.chatId}` : "";
}

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

/** One step of the feedback cycler: at the target → stop; out of presses → stop; else press once. */
export type CycleAction = "done" | "press" | "giveup";
/**
 * PURE decision for the mode-convergence loop (cycleToMode, shared by fresh spawn + resume): given the
 * footer mode we just read, the target, and how many Shift+Tabs we've already issued, decide whether to
 * stop (reached the target), give up (hit the bounded press cap — leave the session as-is), or press one
 * more Shift+Tab. Exported so the table-driven hermetic test can assert the press count + stop conditions
 * with no real claude. The loop NEVER presses twice without first observing the footer change (see
 * cycleToMode), so feeding the sequence of observed modes through this function reproduces the exact
 * press sequence.
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
/**
 * Mode-convergence loop (cycleToMode, card f05e4897 / generalized in b99d3d67). Drives the footer to the
 * target ABSOLUTELY for BOTH a fresh spawn and a resume: press one Shift+Tab, then poll the footer until
 * it CHANGES (the press registered) before deciding again — so a laggy repaint can never trick us into
 * overshooting. Polling cadence + the per-press change-wait cap (≈3s) and the total press cap. Sized so
 * the whole loop (worst case ≈ MAX_PRESSES × CHANGE_MAX_POLLS × POLL_MS + settle ≈ 13–14s) finishes
 * COMFORTABLY under READY_FALLBACK_MS (20s) — the readiness fallback must not fire mid-cycle and release
 * queued injections before the mode settles (the 2026-06-03 strand bug). From the acceptEdits boot mode,
 * auto is reached in 2 presses; the cap is headroom (a full period is 4). */
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
 * KICKOFF GUARANTEE (the "start/ready-gating race" — board card guaranteeing worker_spawn drives turn
 * 1). A positional-arg startup/kickoff prompt (buildSpawnArgs) — a fresh worker_spawn, a recycle
 * handoff (recycleWorker/recycleManager/the platform-lead recycle), or a run's startup prompt — rides
 * the CLI as a positional arg; the vendor CLI is responsible for auto-typing + auto-submitting it as
 * turn 1 once its TUI boots. That internal auto-submit can lose the race against Loom's own boot
 * machinery (mode-cycle keystrokes, dialog dismissals) under load and never land as a real turn: the
 * session then sits `ready`+optimistically-`busy` with NO `UserPromptSubmit` ever observed (see
 * Live.firstTurnStarted) and no engine session id captured for context. Grace window AFTER markReady
 * (not after spawn — mode-cycling must finish first) before `scheduleKickoffGuarantee` force-submits the
 * SAME text via the exact reliable path (`submit()`) every later turn — and the §19c-b rate-limit
 * replay — already uses. NOT applicable to resume/fork (they never carry a positional startup prompt —
 * see scheduleKickoffGuarantee's own doc comment). Short relative to READY_FALLBACK_MS/BUSY_STALE_MS: it
 * only needs to outlast the CLI's own submit latency under load, not a missed SessionStart or a
 * genuinely long tool call. Env-overridable so tests don't wait for it.
 */
const STARTUP_PROMPT_GRACE_MS = Number(process.env.LOOM_STARTUP_PROMPT_GRACE_MS) || 10_000;

/**
 * SHORT stale-busy threshold for a session that has NEVER started its first turn (Live.firstTurnStarted
 * still false — see the UserPromptSubmit hook handler). Used by healIfStuck INSTEAD of the full
 * `busyStaleMs` (5min default): there is no such thing as a legitimately long tool call before turn 1 has
 * even started, so a pre-first-turn session with stale pty output is already known-broken and should
 * self-heal to `busy:false` fast — surfacing to the manager via the existing onBusy→notifyManagerOfIdleWorker
 * path (which branches on `engineSessionId` there to distinguish this from a genuine post-turn idle) instead
 * of sitting masked as "busy" for the full 5-minute window. Once a real turn starts, firstTurnStarted flips
 * true and the normal, more generous busyStaleMs applies. Env-overridable for tests.
 */
const FIRST_TURN_STALE_MS = Number(process.env.LOOM_FIRST_TURN_STALE_MS) || 30_000;

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
 * `--output-dir <outputDir>` (when supplied) sets where the MCP writes capture artifacts —
 * `browser_take_screenshot`, traces, downloads. Loom passes a repo-EXTERNAL per-session scratch dir
 * (`sessionScratchDir`) by default so a screenshot taken with NO explicit path can NEVER land inside the
 * project working tree: without it the MCP defaults output to `<cwd>/.playwright-mcp`, and cwd IS the
 * project repo root — a stray-PNG-commit footgun in a self-hosting repo.
 * `outputDir` is ALSO the enforced write boundary, not just the default: an explicit (absolute) caller
 * filename bypasses the JOIN (playwright-core resolves it with `path.resolve(outputDir, fileName)`, which
 * returns the absolute path verbatim) but is then checked by playwright-core's OWN `checkFile` guard,
 * which allows a write only inside `outputDir` OR the MCP subprocess's inherited OS cwd — TWO fixed
 * roots, no configurable extra-roots list in this pinned version, and that cwd is NOT independently
 * settable per MCP server (a `"cwd"` field on the stdio server entry is silently ignored — verified by
 * spawning a real `claude` and observing the child still inherit claude's own cwd). So a caller-absolute
 * path OUTSIDE both roots is DENIED, not just "unaffected" — which is why `buildMcpServers` swaps
 * `outputDir` to the project's `vaultPath` (when set) instead of the scratch dir: that's the only way to
 * grant vault writes without opening `--allow-unrestricted-file-access` (which removes the boundary
 * entirely, including the file:// navigation block). Omit `outputDir` and the flag is absent
 * (byte-identical to the pre-output-dir spawn) — the caller (`buildMcpServers`) always supplies a dir.
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

/**
 * The stdio MCP-config entry for a browserTesting session, or null if the package is unresolvable.
 * `outputDir` (when given) is wired as `--output-dir` so captures default OUTSIDE the repo working tree;
 * omitted ⇒ no flag (byte-identical to the pre-output-dir spawn).
 */
export function playwrightMcpServer(outputDir?: string): { type: "stdio"; command: string; args: string[] } | null {
  const cli = resolvePlaywrightCli();
  if (!cli) return null;
  const args = [cli, "--headless", "--isolated"];
  if (outputDir) args.push("--output-dir", outputDir);
  return { type: "stdio", command: process.execPath, args };
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
/**
 * Mark a WARM-resolved binary as `ready` in the status model — for the two warm branches that resolve the
 * tool WITHOUT a kick (the `LOOM_MARKITDOWN_BIN` override, and a venv binary already present on disk, e.g. a
 * manually-built venv or one boot-pre-warm found already there). Without this the status would sit at `idle`
 * even though document conversion fully works, so GET /api/python/provisioning (the UI card) would falsely
 * read "not ready". Cheap + sync (a plain object assignment) — safe on the hot path, no I/O.
 */
function markMarkitdownReady(bin: string): void {
  markitdownBin = bin;
  markitdownProvisionStatus = { state: "ready", binary: bin, lastAttemptAt: Date.now() };
}
/**
 * Apply a TERMINAL `failed` provisioning outcome — but NEVER downgrade an already-`ready` status. `ready` is a
 * positive terminal that means the venv binary genuinely exists on disk (set by this job's own success, or by a
 * CONCURRENT documentConversion spawn that found the binary already present and called {@link markMarkitdownReady}).
 * A STALE in-flight job that resolves `failed` AFTER such a `ready` must NOT flip the status back to failed — the
 * binary is there and conversion actually works; only GET /api/python/provisioning reads the state, and it must
 * not falsely show "not ready". Returns true when the failure was applied, false when a prior `ready` superseded
 * this (stale) job — so the caller can log honestly. All other transitions (idle/installing → failed) are intact.
 */
function applyMarkitdownFailure(reason: ProvisionOutcome, errorTail: string | undefined, lastAttemptAt: number): boolean {
  if (markitdownProvisionStatus.state === "ready") return false;
  markitdownProvisionStatus = { state: "failed", reason, errorTail, lastAttemptAt };
  return true;
}
function resolveMarkitdownBin(pythonInterpreterPath?: string): string | null {
  if (markitdownBin) return markitdownBin;
  const override = process.env.LOOM_MARKITDOWN_BIN;
  if (override) {
    const resolved = resolveExecutable(override);
    if (path.isAbsolute(resolved)) { markMarkitdownReady(resolved); return resolved; }
    return null; // human pointed the override somewhere unresolvable — respect it, don't auto-provision
  }
  const bin = loomVenvBin("markitdown-mcp");
  if (fs.existsSync(bin)) { markMarkitdownReady(bin); return bin; } // venv warm → use it (cache + status ready)
  kickMarkitdownProvision(pythonInterpreterPath); // cold → provision in the BACKGROUND; skip this spawn
  return null;
}

/**
 * Bound (ms) for the markitdown `pip install`. Much larger than the default pip bound because `markitdown[all]`
 * is a HEAVY first install — it pulls onnxruntime + a long tail of format converters, which on a real/corporate
 * network (or behind a slow proxy) routinely exceeds a few minutes. The old 3-min default killed the download
 * mid-flight and mislabeled it a generic failure. ~15 min gives the heavy first install room while still being
 * KILLED-on-exceed (classified `timeout`), never unbounded. The venv-create/probe bounds stay as-is (fast).
 */
const MARKITDOWN_PIP_TIMEOUT_MS = 900_000;

/**
 * Live markitdown provisioning status — the model the REST/UI layer reads ({@link getMarkitdownProvisionStatus}).
 *   - `idle`       — never attempted (or reset);
 *   - `installing` — a background kick is IN-FLIGHT;
 *   - `ready`      — the venv binary resolved (`binary` set);
 *   - `failed`     — a terminal failure (`reason` = the classified {@link ProvisionOutcome}; `errorTail` = the
 *                    captured stdout/stderr tail when one was produced).
 * `lastAttemptAt` is the epoch-ms of the most recent kick. A failure is NOT sticky — it's retryable (see
 * {@link kickMarkitdownProvision}) — so the UI can show the reason + offer a retry.
 */
export type MarkitdownProvisionState = "idle" | "installing" | "ready" | "failed";
export interface MarkitdownProvisionStatus {
  state: MarkitdownProvisionState;
  reason?: ProvisionOutcome;
  errorTail?: string;
  binary?: string;
  lastAttemptAt?: number;
}
let markitdownProvisionStatus: MarkitdownProvisionStatus = { state: "idle" };

/** A COPY of the live markitdown provisioning status, for the human-only REST surface. Never the live object. */
export function getMarkitdownProvisionStatus(): MarkitdownProvisionStatus {
  return { ...markitdownProvisionStatus };
}

/**
 * The provisioner the kick calls — `ensurePythonPackageAsync` in production, swappable in a hermetic test via
 * {@link __setMarkitdownProvisionerForTest} so the failure-classification / retry / status-transition tests can
 * drive every outcome WITHOUT building a real venv or hitting the network.
 */
type MarkitdownProvisioner = (opts: EnsurePythonPackageOpts) => Promise<EnsurePythonResult>;
let markitdownProvisioner: MarkitdownProvisioner = ensurePythonPackageAsync;

/**
 * Kick BACKGROUND provisioning of the shared venv's markitdown (async `child_process.spawn` under the hood
 * — NEVER `spawnSync`), so the heavy venv-create + pip install runs OFF the event loop.
 *
 * RETRYABLE, not a permanent one-shot: the dedupe guard is ONLY a genuinely IN-FLIGHT install
 * (`markitdownProvisionInFlight`), so concurrent documentConversion spawns never launch parallel pip installs —
 * but after a TERMINAL outcome (ready/failed) the in-flight clears and a fresh kick is allowed. So a
 * profile-save pre-warm, a later spawn, or an explicit `POST /api/python/provisioning/retry` all actually
 * retry (the old PERMANENT `markitdownProvisionTried` flag dead-ended every retry until a daemon restart — the
 * defect this fixes).
 *
 * On success it lands the resolved binary into the `markitdownBin` memo (subsequent spawns inject it) and the
 * status → `ready`; on failure it warn-logs the SPECIFIC classified reason + captured tail and the status →
 * `failed` (documentConversion sessions keep spawning WITHOUT the MCP, best-effort), retryable as above.
 */
let markitdownProvisionInFlight: Promise<void> | null = null;
let markitdownProvisionKicks = 0; // test observability (see __markitdownProvisionKicks)
function kickMarkitdownProvision(pythonInterpreterPath?: string): void {
  if (markitdownProvisionInFlight) return; // dedupe ONLY an in-flight install (retryable after a terminal outcome)
  markitdownProvisionKicks++;
  const attemptAt = Date.now();
  markitdownProvisionStatus = { state: "installing", lastAttemptAt: attemptAt };
  // eslint-disable-next-line no-console
  console.warn("[pty] markitdown venv not ready — provisioning in the BACKGROUND; documentConversion spawns skip the MCP until it's warm.");
  markitdownProvisionInFlight = markitdownProvisioner({
    // markitdown-mcp is the MCP server / console script; markitdown[all] pulls the full
    // PDF/Office/image converters into the SAME shared venv.
    package: ["markitdown-mcp", "markitdown[all]"],
    binary: "markitdown-mcp",
    probeImport: "markitdown_mcp",
    timeoutMs: MARKITDOWN_PIP_TIMEOUT_MS,
    interpreterOverride: pythonInterpreterPath,
  })
    .then((res) => {
      if (res.outcome === "ready" && res.binary) {
        markitdownBin = res.binary;
        markitdownProvisionStatus = { state: "ready", binary: res.binary, lastAttemptAt: attemptAt };
        // eslint-disable-next-line no-console
        console.warn(`[pty] markitdown venv ready (${res.binary}) — documentConversion sessions now spawn with the MCP.`);
      } else if (applyMarkitdownFailure(res.outcome, res.errorTail, attemptAt)) {
        // eslint-disable-next-line no-console
        console.warn(`[pty] markitdown background provisioning FAILED (${res.outcome}) — documentConversion sessions spawn WITHOUT the markitdown MCP. Retryable: re-save the profile or POST /api/python/provisioning/retry (no daemon restart needed).${res.errorTail ? `\n  captured output tail:\n${res.errorTail}` : ""}`);
      } else {
        // eslint-disable-next-line no-console
        console.warn(`[pty] markitdown background provisioning resolved ${res.outcome}, but the venv binary is already present (a concurrent spawn proved it on disk) — status stays 'ready'; this stale job did NOT downgrade it.`);
      }
    })
    .catch(() => {
      // ensurePythonPackageAsync never throws; belt-and-suspenders for an injected test provisioner that might.
      applyMarkitdownFailure("pip-failed", undefined, attemptAt);
    })
    .finally(() => { markitdownProvisionInFlight = null; });
}

/** TEST-ONLY: how many times background markitdown provisioning has been kicked this process. */
export function __markitdownProvisionKicks(): number {
  return markitdownProvisionKicks;
}

/**
 * TEST-ONLY: swap the provisioner the kick calls (pass nothing/undefined to restore the real
 * `ensurePythonPackageAsync`) and reset provisioning module state back to idle (status, the success memo, the
 * kick counter, any in-flight handle). Lets a hermetic test drive every classified outcome + the retry/dedupe
 * semantics with NO real venv or network.
 */
export function __setMarkitdownProvisionerForTest(fn?: MarkitdownProvisioner): void {
  markitdownProvisioner = fn ?? ensurePythonPackageAsync;
  markitdownProvisionInFlight = null;
  markitdownProvisionStatus = { state: "idle" };
  markitdownBin = undefined;
  markitdownProvisionKicks = 0;
}

/**
 * Pre-warm the shared markitdown venv AHEAD of the first documentConversion session — called OFF the spawn
 * hot path (at daemon boot if any profile opts in, and when a profile is SAVED with documentConversion=true,
 * see `python/prewarm.ts`). This closes the provision-on-first-spawn cold-skip window: today the FIRST
 * documentConversion session kicks provisioning and spawns WITHOUT the MCP, and only a LATER spawn picks the
 * tool up once the venv warms (~1.5 min). Pre-warming earlier means the venv is usually warm by the first
 * spawn.
 *
 * Pure delegation to {@link resolveMarkitdownBin} — it REUSES the SAME gating (the `LOOM_MARKITDOWN_BIN`
 * override + the venv-already-warm short-circuits, both of which simply return without kicking) and the SAME
 * in-flight-deduped, RETRYABLE {@link kickMarkitdownProvision} the spawn path uses. So a pre-warm never
 * launches a parallel install (an in-flight job suppresses it), never blocks (the heavy venv-create + pip runs
 * in the EXISTING async background job — best-effort, off the event loop), and — because the guard is no longer
 * a permanent one-shot — a pre-warm AFTER a prior failed attempt actually RE-kicks (so re-saving the profile
 * retries). The resolved path is discarded; the POINT is the background-kick side effect.
 */
export function prewarmMarkitdown(pythonInterpreterPath?: string): void {
  resolveMarkitdownBin(pythonInterpreterPath);
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
 * The stdio MCP-config entry for a dejaCorpus session, or null when `LOOM_DEJA_BIN` is unset or doesn't
 * resolve to an existing absolute file — a CLEAN-SKIP (like the missing-Playwright-package / not-yet-warm
 * markitdown-venv fallbacks above) so an unresolvable Deja install never breaks the spawn. Callers MUST
 * also gate on `isLoomDev()` (see the "deja-corpus" branch in `buildMcpServers` below) — Deja is a
 * PRIVATE product and this resolver alone doesn't know about that gate.
 *
 * `LOOM_DEJA_BIN` is the SAME human-only override the Deja capture relay resolves (`assets/deja-capture.mjs`
 * `resolveDejaBin`), but here it MUST already be an ABSOLUTE path to Deja's `cli.js` — this entry launches it
 * directly via the daemon's own absolute node binary (`process.execPath`) + `["<cli.js>", "mcp"]`, the same
 * node-pty-can't-search-%PATH% lesson as Playwright/markitdown (never a bare `"deja"` command). No venv/
 * provisioning step: unlike markitdown this is a synchronous existence check only — Deja is a daemon
 * dependency the human installs and points `LOOM_DEJA_BIN` at once, not something Loom provisions.
 *
 * `deja mcp` (no extra flags) defaults to the global `~/.deja/store.sqlite` (`os.homedir()`) — the SAME
 * store the dejaCapture PostToolUse hook writes into, so retrieval and capture line up with zero extra
 * config.
 */
export function dejaMcpServer(): { type: "stdio"; command: string; args: string[] } | null {
  const bin = process.env.LOOM_DEJA_BIN;
  if (!bin || !path.isAbsolute(bin) || !fs.existsSync(bin)) return null;
  return { type: "stdio", command: process.execPath, args: [bin, "mcp"] };
}

/**
 * Assemble the `--mcp-config` mcpServers map for a Claude spawn (extracted from createPty as the ONE
 * testable seam for the MCP surface). ALWAYS the project-scoped `loom-tasks` HTTP server; PLUS the
 * role-gated surface (manager/worker → loom-orchestration, platform → loom-platform, auditor → loom-audit,
 * workspace-auditor → loom-user-audit, setup → loom-setup);
 * PLUS — one generalized capability-registry loop (agent-tooling P4) that mounts EVERY resolved
 * registry-capability grant (`resolveProfileCapabilities(o)`, bridging the legacy `browserTesting`/
 * `documentConversion`/`dejaCorpus` booleans + the new `capabilities` array into ONE list). The legacy
 * slugs ("browser-testing"/"document-conversion"/"deja-corpus") are special-cased to their EXISTING,
 * already-hardened resolvers (`playwrightMcpServer`/`markitdownMcpServer`/`dejaMcpServer`, untouched) so
 * this generalization is byte-identical for every caller that still passes the booleans directly (every
 * existing test + call site) — the mounted map keys stay "playwright"/"markitdown"/"deja" exactly as
 * before. Any OTHER slug is an
 * owner-added catalog capability, resolved via the injected `o.capabilityCatalog` + the generic
 * node-package/python-venv/bundled dispatcher (`resolveCapabilityServer`), with its bound connection's
 * secret (if any) resolved via `o.resolveConnectionSecret` and injected ONLY into that server's own `env`
 * — never a CLI argument, never reaching the `claude` process. Fully ADDITIVE: with nothing enabled the
 * map is byte-identical to today's. Pure + deterministic (no pty, no network — `capabilityCatalog`/
 * `resolveConnectionSecret` are plain injected values, never a live db handle), so the spawn-config test
 * can assert inclusion directly, incl. via a FAKE catalog + fake secret resolver (no real DB/venv/network).
 *
 * SECURITY (P5): an "auditor" session gets ONLY loom-tasks + loom-audit — NEVER loom-platform and NEVER
 * loom-orchestration. The restricted loom-audit surface (read transcripts + file findings) is its whole
 * tool world, so a prompt-injection in an audited transcript has no outward/destructive tool to reach.
 */
export function buildMcpServers(o: {
  sessionId: string; port: number; role?: SessionRole; browserTesting?: boolean; documentConversion?: boolean; dejaCorpus?: boolean;
  /**
   * The project's vault path, when it has one — consulted ONLY by the browserTesting/Playwright grant
   * (see the "browser-testing" branch below). Undefined/omitted ⇒ byte-identical to before this param
   * existed (still just the scratch dir).
   */
  vaultPath?: string;
  /** HUMAN-only `python.interpreterPath` (carried via session env) — forwarded to the markitdown venv resolver. */
  pythonInterpreterPath?: string;
  /** Agent-tooling P4: registry-capability grants BEYOND the two legacy booleans above (raw, un-bridged —
   *  see resolveProfileCapabilities). Default []. */
  capabilities?: CapabilityGrant[];
  /** Owner-added capability catalog rows (injected, never a live db handle) — looked up by slug for any
   *  grant that isn't one of the two reserved legacy slugs. Default []. */
  capabilityCatalog?: CapabilityDefRow[];
  /** Resolve a P1 connection id to its DECRYPTED secret (injected callback, never a live db handle) —
   *  consulted only for a grant whose def has `requiresConnection` AND that carries a `connectionId`. */
  resolveConnectionSecret?: (connectionId: string) => string | undefined;
  /** Card C2: the project's raw `codescape.enabled` flag — see the "codescape" mount below. */
  codescapeEnabled?: boolean;
  /** Card C2: the live Codescape supervisor port, or null/undefined when disabled/not running. */
  codescapePort?: number | null;
  /** Card C2: the session's project id (URL scope). */
  projectId?: string;
  /** Card C2: `taskKey(taskId)` for a worktree (worker) session, else null/undefined (non-worktree scope). */
  worktreeId?: string | null;
}): Record<string, unknown> {
  // Agent Runs R2: a `run` session gets ONLY the restricted run surface — NOT even loom-tasks. This is
  // the one path that does not mount loom-tasks (every other role layers ON TOP of it). The early return
  // keeps every non-run spawn byte-identical to today (a run is the only role that reaches this branch).
  if (o.role === "run") {
    return { "loom-run": { type: "http", url: `http://127.0.0.1:${o.port}/mcp-run/${o.sessionId}` } };
  }
  // manager/worker AND the Companion (assistant) mount loom-orchestration — but a role-gated surface:
  // the assistant gets only my_context + the companion-gated chat_reply (buildServer's assistant branch),
  // NEVER the manager spawn/stop/list tools. Additive: byte-identical map for every non-orch role.
  const wantsOrch = o.role === "manager" || o.role === "worker" || o.role === "assistant";
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
  // Agent-tooling P4: ONE generalized loop over every resolved registry-capability grant (the bridged
  // legacy booleans + the new capabilities array). byte-identical-when-none: an empty resolved list is a
  // no-op, so this whole block vanishes for a spawn with nothing enabled — exactly today's map.
  const catalog = o.capabilityCatalog ?? [];
  for (const grant of resolveProfileCapabilities(o)) {
    if (grant.slug === "browser-testing") {
      // The legacy Playwright capability: default capture output to a repo-EXTERNAL per-session scratch
      // dir, so a screenshot taken with no explicit path can never land inside the project working tree.
      // `@playwright/mcp`'s own file-write guard (`checkFile` in playwright-core) recognizes EXACTLY TWO
      // allowed roots for an LLM-targeted absolute path: `--output-dir` and the subprocess's OS cwd (which
      // is NOT independently configurable per MCP server — confirmed by spawning a real `claude` with a
      // `"cwd"` field on a stdio server entry and observing the child inherit claude's own cwd regardless;
      // there is no third "extra roots" list in this pinned version). So an explicit absolute vaultPath
      // target can only be granted by making vaultPath itself the one `--output-dir` root — that's the
      // trade-off here: a vault-bearing session's screenshot root is `vaultPath` (so a milestone shot can
      // land directly in the vault, and a bare filename lands in the vault rather than the repo); a
      // no-vault session is byte-identical to before (still the scratch dir). A null (unresolvable
      // package) is logged + skipped rather than crashing the spawn.
      const pw = playwrightMcpServer(o.vaultPath ?? sessionScratchDir(o.sessionId));
      if (pw) {
        mcpServers["playwright"] = pw;
      } else {
        // eslint-disable-next-line no-console
        console.warn(`[pty] ${o.sessionId} browserTesting set but @playwright/mcp could not be resolved — spawning WITHOUT a browser MCP. Is the daemon dependency installed?`);
      }
      continue;
    }
    if (grant.slug === "document-conversion") {
      // The legacy markitdown capability, UNCHANGED resolution: fast + sync-safe (fs.existsSync on the
      // hot path); a null means the shared venv isn't warm yet — it has kicked BACKGROUND provisioning,
      // so THIS spawn just skips the MCP (logged, never crashes), and a later spawn picks it up once the
      // venv lands. The one-time host setup is just a base Python ≥3.10 (PATH or python.interpreterPath).
      const md = markitdownMcpServer(o.pythonInterpreterPath);
      if (md) {
        mcpServers["markitdown"] = md;
      } else {
        // eslint-disable-next-line no-console
        console.warn(`[pty] ${o.sessionId} documentConversion set but the markitdown venv isn't warm yet — spawning WITHOUT the document MCP (provisioning in the background; a later spawn will pick it up). Needs a base Python >=3.10 on PATH (or python.interpreterPath).`);
      }
      continue;
    }
    if (grant.slug === "deja-corpus") {
      // Deja is a PRIVATE product (Loom itself is public on npm) — never wire its MCP on a non-dev build,
      // even when a profile carries a stored dejaCorpus:true (e.g. from before this gate existed). Same
      // gate as the Platform layer (paths.ts isLoomDev). Silent skip: no warn, since the "missing" reason
      // here is the gate itself, not a misconfigured LOOM_DEJA_BIN.
      if (!isLoomDev()) continue;
      // The Deja mockup-corpus capability: a plain synchronous existence check (no venv/provisioning) — a
      // null means LOOM_DEJA_BIN is unset or unresolvable, so THIS spawn just skips the MCP (logged, never
      // crashes). No background kick: Deja is a daemon-side install the human points LOOM_DEJA_BIN at once.
      const dj = dejaMcpServer();
      if (dj) {
        mcpServers["deja"] = dj;
      } else {
        // eslint-disable-next-line no-console
        console.warn(`[pty] ${o.sessionId} dejaCorpus set but LOOM_DEJA_BIN could not be resolved — spawning WITHOUT the Deja MCP. Is LOOM_DEJA_BIN set to an absolute path to Deja's cli.js?`);
      }
      continue;
    }
    // An owner-added catalog capability: look it up in the injected catalog, resolve its bound
    // connection's secret (if it requiresConnection and a connectionId was granted), and dispatch
    // through the generic node-package/python-venv/bundled resolver. Unknown slug / unresolvable
    // provisioning ⇒ log-and-skip, exactly like the two legacy capabilities above — never crashes the spawn.
    const def = catalog.find((c) => c.slug === grant.slug);
    if (!def) {
      // eslint-disable-next-line no-console
      console.warn(`[pty] ${o.sessionId} capability '${grant.slug}' is enabled but not found in the catalog — spawning without it.`);
      continue;
    }
    const connectionSecret = def.requiresConnection && grant.connectionId ? o.resolveConnectionSecret?.(grant.connectionId) : undefined;
    const server = resolveCapabilityServer(def, {
      scratchDir: def.wantsScratchDir ? sessionScratchDir(o.sessionId) : undefined,
      connectionSecret,
      pythonInterpreterPath: o.pythonInterpreterPath,
    });
    if (server) {
      mcpServers[def.slug] = server;
    } else {
      // eslint-disable-next-line no-console
      console.warn(`[pty] ${o.sessionId} capability '${grant.slug}' could not be resolved — spawning without it (provisioning may be in progress in the background).`);
    }
  }
  // Card C2 (Codescape wiring epic `369dde3c`): a per-PROJECT opt-in (NOT a profile capability grant,
  // hence outside the resolveProfileCapabilities loop above), mirroring the deja-corpus branch's gate
  // shape. `o.codescapeEnabled` is the RAW project flag — isLoomDev() is re-checked HERE (not pre-baked
  // by the caller) so this pure seam can assert the LOOM_DEV-off negative case directly.
  if (o.codescapeEnabled) {
    if (isLoomDev()) {
      const port = o.codescapePort;
      if (port != null) {
        // Q3: a worktree (worker) session scopes to <projectId>/<worktreeId> (3-segment); a non-worktree
        // (manager/plain) session scopes to <projectId> alone (2-segment, no "main" sentinel) — both read
        // the same always-current main graph.
        const scope = o.worktreeId ? `${o.projectId}/${o.worktreeId}` : `${o.projectId}`;
        mcpServers["codescape"] = { type: "http", url: `http://127.0.0.1:${port}/mcp/${scope}` };
      } else {
        // eslint-disable-next-line no-console
        console.warn(`[pty] ${o.sessionId} codescape enabled but the supervisor port is unavailable — spawning WITHOUT the Codescape MCP.`);
      }
    }
    // !isLoomDev(): silent skip, mirroring deja-corpus — the "missing" reason is the gate itself.
  }
  return mcpServers;
}

/**
 * Card C2: the `--allowedTools` contribution for a mounted Codescape MCP entry — ONLY the 7 read tools
 * (list_flows/trace_flow/what_touches/describe_symbol/render_tree/boundary_map/scenario_space), NEVER the
 * 5 control/write tools (focus_flow/highlight/open_view/annotate/show_diff). Read-only "agent orients
 * itself" integration (Q4). Named per-tool (mirrors deja-corpus's 3-tool allow), not the whole `mcp__codescape`
 * server prefix, so the write surface stays unreachable even though the server itself exposes it.
 */
export const CODESCAPE_TOOL_ALLOW: readonly string[] = [
  "mcp__codescape__list_flows",
  "mcp__codescape__trace_flow",
  "mcp__codescape__what_touches",
  "mcp__codescape__describe_symbol",
  "mcp__codescape__render_tree",
  "mcp__codescape__boundary_map",
  "mcp__codescape__scenario_space",
];

/**
 * The `--allowedTools` contribution from every resolved capability grant (agent-tooling P4) — the
 * `createPty` allow-list analog of `buildMcpServers`' mount loop. The two legacy slugs keep their exact
 * hardcoded allow entries; an owner-added capability contributes its own `toolAllowlist` from the catalog.
 * NEVER throws: an unknown slug or malformed `toolAllowlistJson` degrades to "no extra allow for THIS one
 * capability" (buildMcpServers separately log-and-skips its MCP mount) — never crashes the whole spawn.
 * Pure + exported so the hermetic test can assert the malformed-JSON degradation with no real spawn.
 */
export function capabilityToolAllowlist(grants: CapabilityGrant[], catalog: CapabilityDefRow[]): string[] {
  return grants.flatMap((grant) => {
    if (grant.slug === "browser-testing") return ["mcp__playwright"];
    if (grant.slug === "document-conversion") return ["mcp__markitdown__convert_to_markdown"];
    if (grant.slug === "deja-corpus") return ["mcp__deja__find_mockups", "mcp__deja__submit_mockup", "mcp__deja__mark_reused"];
    const def = catalog.find((c) => c.slug === grant.slug);
    if (!def) return [];
    try { return JSON.parse(def.toolAllowlistJson) as string[]; } catch { return []; }
  });
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
/**
 * An originating chat ROUTE pinned to a turn (Loom Companion multi-channel reply routing). An ALIAS of
 * `@loom/shared`'s canonical `CompanionRoute` — importing FROM shared, never from the companion layer, so
 * the pty host takes NO dependency on the companion module (it's a lower-level primitive shared by ALL
 * sessions). Optional on QueuedMessage: a message with NO route is a plain non-companion turn (every
 * existing caller ⇒ undefined ⇒ byte-identical). The route also KEYS drainPending's coalescing so
 * cross-route messages never merge into one turn (see drainPending).
 */
export type TurnRoute = CompanionRoute;
/**
 * Coalescing classification (owner-directed, 2026-07-03): `"warning"` = a Loom operational nudge
 * (idle/context/busy-stuck watchdogs, restart/boot continuation notes, rate-limit/usage nudges,
 * memory-recall injection) — always safe to concatenate with its neighbors into one turn. `"agent"` =
 * a message AUTHORED by an agent or a human TO the recipient (a Lead's `session_message`, a human
 * composer turn, a worker→manager report, a manager→worker direction/redirect, a companion inbound or
 * proactive reminder/heartbeat) — drained ALONE, one-per-turn, UNLESS `coalesceAgentMessages` is on
 * (see drainPending). Defaults to `"warning"` at the `enqueueStdin` call boundary so every pre-existing
 * caller that predates this classification (tests, and any call site this change didn't touch) keeps
 * the old full-coalesce behavior byte-identical; every real production call site is classified
 * explicitly (see host.ts's callers). Bias for anything genuinely ambiguous: `"agent"` — the harm this
 * classification exists to prevent is coalescing agent messages, so a warning wrongly delivered
 * one-per-turn is merely a few extra benign turns.
 */
export type QueuedMessageKind = "warning" | "agent";
/**
 * `questionId` OPTIONALLY tags a queued entry as a decision-inbox answer-push-nudge (card bbc46336
 * follow-up) for the question it announces. Only the answer route sets it; every other caller leaves it
 * undefined. It exists solely so `purgeQueuedByQuestionIds` can find and drop a nudge that's gone stale —
 * `question_pull` consumes ALL of a session's answered questions atomically, so a batch of N answers
 * produces N queued nudges but only the FIRST pull is productive; the rest would otherwise drain as
 * separate turns and each find nothing left to pull.
 */
export type QueuedMessage = { id: string; text: string; source: QueueSource; onDeliver?: (reason?: string) => void; route?: TurnRoute; kind: QueuedMessageKind; questionId?: string; ownerText?: string };
/**
 * Distinguishes `enqueueStdin`'s two `delivered:false` outcomes, which otherwise read identically at a
 * glance: `"session-dead"` = no live pty at all — the text was DROPPED, nothing will ever deliver it.
 * `"held"` = queued FIFO on a live-but-busy/not-ready session — it WILL deliver at the next turn
 * boundary. A caller that only checked `delivered:false` could conflate "dropped" with "queued".
 */
export type EnqueueDeliveryReason = "session-dead" | "held";

interface Live {
  pty: IPty;
  pid: number;
  cwd: string;
  // Discriminates the two pty species sharing this map. "claude" = an interactive Claude session
  // (the full machinery below: readiness gate, hook-driven busy, injection queue, mode-cycles…).
  // "shell" = a plain human-spawned interactive shell (pwsh/cmd/bash) — RAW passthrough only; ALL the
  // Claude-only logic (deliverHook/readiness/drain/reconcile/boot-reconcile) SKIPS it. A shell is NOT a
  // DB Session, so the orchestration watchers (which iterate DB sessions) never see it either.
  // "canned" = a TEST-ONLY no-process entry (seedCanned) that pre-loads the ring with recorded bytes so
  // `/ws/term` attach replays a faithful screen at a pinned geometry with no real spawn (card a53e6bc9).
  // Shares the shell's Claude-only-skip exemptions but is excluded from listShells (not a real terminal).
  kind: "claude" | "shell" | "canned";
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
  rateLimited: boolean; // §19c park: the turn died on a usage cap; the pty is alive but PARKED. SUPPRESS
                        // drain/submit (mirror of `stopping`) so the ~10s reconcile drain can't submit pending
                        // into the capped account and CLOBBER lastPrompt — the killed turn resumeAfterRateLimit
                        // must replay. Set when the StopFailure is detected as rate_limit; cleared on resume.
  lastPrompt: string | null; // the most-recent submitted turn — re-sendable if the cap kills it (§19c-b)
  // True once ANY turn has ever started for this session (the first UserPromptSubmit hook observed).
  // Gates the fresh-spawn kickoff guarantee (scheduleKickoffGuarantee) and healIfStuck's short pre-first-
  // turn stale window (FIRST_TURN_STALE_MS) — see both for why "never started a turn" needs distinct
  // handling from "mid a long turn". Irrelevant for shell/canned entries (seeded true — no kickoff to guarantee).
  firstTurnStarted: boolean;
  // True once the CURRENT outstanding submit()'s Enter is confirmed to have actually started a turn
  // (a `UserPromptSubmit` hook, or a `Stop`/`StopFailure` — either proves a turn ran even if the
  // UserPromptSubmit hook itself was lost). False from the moment submit() writes the paste until
  // confirmed. `sendEnterAndVerify` checks this to decide whether to re-send the Enter or give up (card
  // 9549e322 — the swallowed/dropped lone-Enter bug).
  enterConfirmed: boolean;
  // Bumped by submit() on every call, and by every OUT-OF-BAND busy-clearing path (healIfStuck,
  // interruptForRedirect, stop) — see `sendEnterAndVerify`. `enterConfirmed` ALONE is not enough to
  // scope a verify/retry chain: a fast turn can confirm+Stop (setting enterConfirmed=true) and a NEW
  // submit() can then reset it back to false for the NEXT turn WHILE the FIRST turn's verify timer is
  // still pending (CR-caught, card 9549e322 review) — that stale timer would read the reset false and
  // wrongly retry-Enter into the NEW turn's window, and could even give-up→setBusy(false) mid-turn. Each
  // `sendEnterAndVerify` chain captures the generation it was scheduled under and bails the instant the
  // live value no longer matches, regardless of what `enterConfirmed` currently reads.
  submitGeneration: number;
  // Loom Companion (multi-channel reply routing): the ORIGINATING chat route of the IN-FLIGHT turn, or null
  // when the turn wasn't formed from a companion inbound / proactive-home submit. Set SYNCHRONOUSLY in
  // submit() (both the idle-submit and drain paths), read by getActiveTurnOrigin when the companion's
  // chat_reply fires — so a reply resolves to the EXACT route of the turn it answers (no shared/last-inbound
  // field, no cross-delivery). `lastPromptRoute` mirrors `lastPrompt` so a rate-limit-killed companion turn
  // replays to its ORIGINAL route on resume. Both null on every non-companion turn ⇒ byte-identical.
  activeTurnRoute: TurnRoute | null;
  lastPromptRoute: TurnRoute | null;
  // Companion injection-guard Primitive A (Companion Capability & Permission-Lever Framework §3): the
  // LITERAL authenticated owner inbound bytes forming the IN-FLIGHT turn, or null when the turn wasn't
  // formed from an authorized owner inbound (proactive/heartbeat/reminder/cross-channel-mirror/memory-
  // recall → null). Set alongside activeTurnRoute in submit() but — UNLIKE activeTurnRoute, which simply
  // gets overwritten by the next submit() — is explicitly CLEARED at turn end (the Stop/StopFailure hook):
  // an ACT lever's owner-text attestation must never see a stale prior turn's text. lastPromptOwnerText
  // mirrors lastPromptRoute so a rate-limit-killed companion turn replays with its attestation intact.
  activeTurnOwnerText: string | null;
  lastPromptOwnerText: string | null;
  startupModeCycles: number; // Shift+Tab presses to inject once, after SessionStart, to reach the target mode
  startupCyclesDone: boolean; // guard so the cycle-inject fires at most once per session
  mcpPromptHandled: boolean;  // guard: dismiss the plugin-MCP enable-prompt with Esc at most once per session
  bootScan: string;           // bounded rolling buffer of early boot output, scanned for that prompt
  resumeGateHandled: boolean; // guard: select "as-is" on the resume-from-summary gate at most once per session
  resumeGateScan: string;     // bounded rolling buffer scanned for that gate (separate from bootScan)
  isResume: boolean;          // spawned with --resume (vs a fresh spawn) — for the landed-mode log only
  modeLogged: boolean;        // guard: log the landed permission mode at most once per session (observability)
  // RESUME ONLY: the EXPLICIT permission mode to feedback-cycle the footer to after SessionStart (set by
  // SessionService.resume). null on a fresh spawn — host.ts instead DERIVES the equivalent target from
  // startupModeCycles (see the SessionStart handler); both converge via the same cycleToMode primitive.
  resumeModeTarget: LandedMode | null;
  // The session's role — used ONLY by logLandedMode's auto-heal to know whether ExitPlanMode is
  // disallowed for this session (see disallowedToolsForRole). null for a shell / a role-less spawn.
  role: SessionRole | null;
  // Deja origin_prompt v2 (card d4b48f31): whether THIS session opted into dejaCapture (pinned from
  // SpawnOpts.dejaCapture at spawn) — gates whether the UserPromptSubmit hook case below retains
  // `lastPromptText` at all. False for every session that never set dejaCapture — byte-identical to
  // before this card (lastPromptText stays null forever, nothing is retained).
  dejaCapture: boolean;
  // IN-MEMORY ONLY, MOST-RECENT-TURN ONLY — deliberately NOT a log/array and NEVER persisted to the DB
  // (privacy constraint: Loom is a public product and must not grow an at-rest raw-prompt store).
  // Overwritten on every UserPromptSubmit while dejaCapture is on; null otherwise or before the first
  // turn. Read by getLastPromptText for the /internal/deja-context/:sessionId enrichment (server.ts) —
  // capturing the literal triggering human/agent turn text, distinct from `lastPrompt` above (which is
  // Loom's OWN submitted-turn cache for usage-cap replay, not necessarily what the hook itself reports).
  lastPromptText: string | null;
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
  /** When true (dejaCapture on, card b3bd4841), wires a second opt-in PostToolUse hook that
   *  auto-ingests an agent-written .html mockup into Deja. Default OFF — byte-identical when unset. */
  dejaCapture?: boolean;
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
   * Opt-in Deja mockup-corpus (resolved from the session's Profile, gated). When true, inject a per-session
   * stdio `deja mcp` server so a mockup-generating agent can retrieve prior mockups (find_mockups) and
   * submit the one it just wrote (submit_mockup/mark_reused), and allowlist its tool surface. Default OFF —
   * every existing spawn is byte-identical when unset/false.
   */
  dejaCorpus?: boolean;
  /**
   * Card C2 (Codescape wiring epic `369dde3c`): the project's RAW `codescape.enabled` config flag — NOT
   * yet combined with `isLoomDev()`/the supervisor port (buildMcpServers applies those gates itself,
   * mirroring the deja-corpus branch). Default OFF — every existing spawn is byte-identical when unset.
   */
  codescapeEnabled?: boolean;
  /** Card C2: the live Codescape supervisor port, or null when disabled/not running (see `CodescapeSupervisor.getPort`). */
  codescapePort?: number | null;
  /** Card C2: the session's project id, needed to scope the Codescape MCP URL. */
  projectId?: string;
  /** Card C2: `taskKey(taskId)` for a WORKTREE (worker) session, else null/undefined — see `codescapeWorktreeId`. */
  worktreeId?: string | null;
  /**
   * Agent-tooling P4: registry-capability grants BEYOND the two legacy booleans above (resolved from the
   * session's Profile/row, RAW — see resolveProfileCapabilities). Default [] — every existing spawn is
   * byte-identical when unset/empty. Threaded on EVERY spawn path (fresh/resume/fork/recycle), pinned on
   * the session row like browserTesting so a respawn mounts the same capabilities.
   */
  capabilities?: CapabilityGrant[];
  /**
   * Opt-in RESTRICTED-tools (resolved from the session's Profile, gated; blast-radius control). When true,
   * the curated dangerous native tools ({@link RESTRICTED_NATIVE_TOOLS}) are UNIONed into this spawn's
   * `--disallowedTools` (on top of the role's human-prompt disallow), removing them from the model's tool
   * list. Default OFF — every existing spawn is byte-identical when unset/false (the disallow list stays
   * exactly `disallowedToolsForRole(role)`). Threaded on EVERY spawn path from the pinned session row.
   */
  restrictedTools?: boolean;
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
 * The interactive HUMAN-prompt tools Claude Code exposes that would BLOCK an unattended, Loom-driven
 * session on input that can never come from the human:
 *   - `AskUserQuestion` — surfaces a multiple-choice question to the human and waits on their pick.
 *   - `ExitPlanMode` / `EnterPlanMode` — the plan-mode approval prompts (entering plan mode and asking
 *     the human to approve a plan), both model-callable tools.
 * A Loom-driven session's stdin is owned by Loom (a worker by its manager via worker_message/redirect;
 * an operator by the daemon), so any of these blocks the turn forever waiting on a human who will never
 * answer — AND it's a doctrine violation (a worker's only channel is worker_report UP; it must never
 * address the user). `/worker` doctrine already forbids it, but a model reached for the prompt anyway,
 * so we make it STRUCTURALLY impossible at spawn (board card 8dd1dd1c).
 */
export const HUMAN_PROMPT_TOOLS: readonly string[] = ["AskUserQuestion", "ExitPlanMode", "EnterPlanMode"];

/**
 * The engine's NATIVE task-tracking tools (TaskCreate/TaskGet/TaskList/TaskOutput/TaskStop/TaskUpdate —
 * NOT the `mcp__loom-tasks__tasks_*` board tools, a disjoint namespace). A board-driven role's real task
 * surface IS the loom-tasks board (manager/platform/auditor coordinate via the MCP board, never these),
 * so leaving the native tools registered buys nothing but a recurring "task tools haven't been used
 * recently…" `<system-reminder>` the session reasons past every turn (confirmed live: a manager
 * explicitly dismissed it mid-orchestration). The engine's reminder is gated on the native Task tools
 * being present in the session's tool list (no settings.json flag suppresses it — `claude-settings.ts`
 * has no such knob); removing them from the tool list removes the reminder's trigger condition, mirroring
 * how {@link HUMAN_PROMPT_TOOLS} is removed below rather than merely denied. (Platform card 33f9f181)
 */
export const TASK_TRACKING_TOOLS: readonly string[] = ["TaskCreate", "TaskGet", "TaskList", "TaskOutput", "TaskStop", "TaskUpdate"];

/**
 * The set of roles whose stdin is Loom-driven and which must NEVER block on a human — so they spawn with
 * {@link HUMAN_PROMPT_TOOLS} disallowed:
 *   - `worker`            — driven by its manager (worker_message/redirect); channel up is worker_report.
 *   - `setup`             — the user-facing "Platform" operator; acts on the user's behalf, never blocks.
 *   - `auditor`           — the Platform Auditor (scheduled, read-mostly transcript reviewer).
 *   - `workspace-auditor` — the Workspace Auditor (read-mostly reviewer of the user's own workspace).
 *   - `run`               — a fully autonomous, human-LESS, Loom-driven session; nobody can answer a
 *                           prompt, so a model that called one would block until the hard run-timeout
 *                           reaped it (a wasted full-timeout window + a `timed_out` run).
 *   - `assistant`         — the long-lived Loom Companion; its "human" reaches it over a CHAT channel and
 *                           it answers via `chat_reply`, so its stdin is never a live TUI human — an
 *                           interactive prompt would block on input that never comes.
 * DELIBERATELY EXCLUDED (left byte-identical): `manager`/orchestrator + `platform` (the human-driven
 * Platform Lead) legitimately surface decisions to the human; a plain (role-less) session is out of
 * scope.
 *
 * SEPARATELY, the set of BOARD-DRIVEN roles — `manager`/orchestrator, `platform`, `auditor` — spawn with
 * {@link TASK_TRACKING_TOOLS} disallowed (a disjoint concern from the human-prompt disallow above; `auditor`
 * gets BOTH sets, unioned). `workspace-auditor`/`setup`/`worker`/`run`/`assistant`/plain are left
 * byte-identical on this dimension: their real task surface isn't the loom-tasks board the same way, and
 * scoping narrowly avoids suppressing a signal a role might still find useful.
 *
 * Pure + exported so the spawn-args test asserts the per-role mapping with no real claude. (board card
 * 8dd1dd1c; task-tracking-tools split: Platform card 33f9f181)
 */
export function disallowedToolsForRole(role?: SessionRole | null): string[] {
  const out: string[] = [];
  switch (role) {
    case "worker":
    case "setup":
    case "auditor":
    case "workspace-auditor":
    case "run":
    case "assistant":
      out.push(...HUMAN_PROMPT_TOOLS);
      break;
    default:
      break; // manager / platform / plain — no human-prompt disallow
  }
  switch (role) {
    case "manager":
    case "platform":
    case "auditor":
      out.push(...TASK_TRACKING_TOOLS);
      break;
    default:
      break; // worker / setup / workspace-auditor / run / assistant / plain — no task-tracking disallow
  }
  return out;
}

/**
 * The CURATED, HARDCODED set of dangerous NATIVE tools a `restrictedTools` session spawns WITHOUT —
 * removed from the model's tool list via `--disallowedTools` (blast-radius control for a chat-reachable
 * Companion driven by UNTRUSTED inbound chat; CLAUDE.md load-bearing rule #5). Four categories:
 *
 *  RAW SHELL / HOST-WRITES (the direct-damage surface):
 *   - `Bash`         — arbitrary shell / process execution.
 *   - `Edit` / `Write` / `NotebookEdit` — host filesystem writes (auto-accepted under acceptEdits).
 *   - `MultiEdit`    — the multi-hunk write tool. Included DEFENSIVELY: it is NOT present in the current
 *                      engine's native toolset (Edit's replace_all subsumed it), so disallowing it is a
 *                      harmless no-op today — kept so a future re-introduction can't silently re-open a
 *                      host-write vector.
 *
 *  SUBAGENT DELEGATION (closes the residual BYPASS — the important one):
 *   - `Task` / `Agent` — the subagent-launch tool. Without this a restricted companion could spawn a
 *                      general-purpose subagent that re-acquires Bash/Write, defeating the whole
 *                      restriction (we can't rely on a subagent inheriting the parent's --disallowedTools).
 *                      Removing the delegation tool makes that inheritance question MOOT. BOTH names are
 *                      listed on purpose: the classic Claude Code name is `Task`, but the CURRENT engine
 *                      exposes it as `Agent` — disallowing a non-present name is a harmless no-op, so listing
 *                      both closes the bypass regardless of which name the spawned `claude` registers.
 *
 *  NETWORK EGRESS (exfil / SSRF for an agent reading untrusted chat):
 *   - `WebFetch` / `WebSearch` — outbound network. A companion exposed to untrusted input should not have a
 *                      data-exfiltration / SSRF channel; a companion that genuinely needs web runs with the
 *                      flag OFF (the human widens deliberately).
 *
 * NOT restricted: Read/Glob/Grep (read-only — a companion needs context) and the MCP tools
 * (my_context/chat_reply/skill_*). FIXED by construction — never agent- or free-form-configurable; the
 * human WIDENS by turning the flag OFF. Frozen so a caller can't mutate the shared constant.
 */
export const RESTRICTED_NATIVE_TOOLS: readonly string[] = Object.freeze([
  "Bash", "Edit", "Write", "NotebookEdit", "MultiEdit", "Task", "Agent", "WebFetch", "WebSearch",
]);

/**
 * The FULL `--disallowedTools` list for a spawn: the role's disallow list ({@link disallowedToolsForRole}
 * — the human-prompt tools, the task-tracking tools, or both) UNIONed (de-duped, role tools first) with
 * {@link RESTRICTED_NATIVE_TOOLS} iff `restrictedTools` is on. When OFF this returns EXACTLY
 * `disallowedToolsForRole(role)` — so the flag-off argv is BYTE-IDENTICAL to today (no restricted tokens
 * appended). Pure + exported so the spawn-args test asserts the union + the byte-identical-off invariant
 * with no real claude. (Companion blast-radius card.)
 */
export function disallowedToolsForSpawn(role?: SessionRole | null, restrictedTools?: boolean): string[] {
  const base = disallowedToolsForRole(role);
  if (!restrictedTools) return base; // OFF: exactly the role's disallow list (byte-identical to today)
  const merged = [...base];
  for (const t of RESTRICTED_NATIVE_TOOLS) if (!merged.includes(t)) merged.push(t); // union, de-duped
  return merged;
}

/**
 * Collect every capability secret value riding an assembled mcpServers map's `env` blocks (agent-tooling
 * P4 credential tie — see resolveCapabilityServer). `env` is ONLY ever set by that one path today, so
 * "any server carries an env value" IS "a capability secret is present" — but this reads structurally
 * (any string value under any server's `env`), not by name, so it stays correct even if a future capability
 * kind injects a non-secret env var. Pure, exported for the hermetic test.
 */
export function collectMcpEnvSecrets(mcpServers: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const server of Object.values(mcpServers)) {
    const env = (server as { env?: Record<string, string> } | undefined)?.env;
    if (env) for (const v of Object.values(env)) if (v) out.push(v);
  }
  return out;
}

/** True iff the assembled mcpServers map carries at least one capability secret (see collectMcpEnvSecrets). */
export function mcpConfigHasSecret(mcpServers: Record<string, unknown>): boolean {
  return collectMcpEnvSecrets(mcpServers).length > 0;
}

/** Redact every literal occurrence of each secret in `secrets` from `text`. A no-op for an empty list. */
export function redactSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join("[REDACTED]");
  return out;
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
  /**
   * Agent-tooling P4 credential-tie hardening: when set, `--mcp-config` uses this FILE PATH instead of
   * inlining `o.mcpServers` as JSON — the caller (createPty) sets this ONLY when `mcpConfigHasSecret`
   * is true, so a capability secret never rides the `claude` process's own argv (world-readable via
   * `/proc/PID/cmdline`, `ps`, Windows WMI CommandLine). DELIBERATELY a conditional branch, not a
   * blanket switch to files: every secret-free spawn (every session today, incl. the whole self-hosting
   * orchestration fleet) MUST stay on the byte-identical inline form — this is the load-bearing spawn
   * recipe, and always-file-ing it would risk the resume-after-daemon_restart path for zero benefit on
   * the overwhelmingly common secret-free case. Undefined/omitted ⇒ byte-identical to before this option
   * existed (inline `o.mcpServers` JSON).
   */
  mcpConfigPath?: string;
  startupPrompt?: string;
  /** Profile-pinned model id → `--model <id>`. Undefined/empty ⇒ NO `--model` (byte-identical to today). */
  model?: string;
  /**
   * Role-scoped tools to forbid the model from EVER calling (the interactive human-prompt tools, for a
   * Loom-driven role — see {@link disallowedToolsForRole}). Emitted as `--disallowedTools <name…>` (the
   * documented variadic flag, which REMOVES the tools from the model's tool list, not merely auto-denies).
   * Empty/absent ⇒ NO `--disallowedTools` (byte-identical to today for every out-of-scope role).
   */
  disallowedTools?: string[];
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
  // Role-scoped disallow of the interactive human-prompt tools. Placed BEFORE --strict-mcp-config so its
  // variadic value list is terminated by that flag — keeping the variadic `--mcp-config` the LAST flag,
  // its value sitting right before the `--` separator (the H2 ordering invariant). Emitted ONLY when
  // non-empty, so every out-of-scope role's argv is byte-identical (additive-when-applicable discipline).
  if (o.disallowedTools && o.disallowedTools.length) args.push("--disallowedTools", ...o.disallowedTools);
  // Agent-tooling P4: a secret-bearing spawn passes the FILE PATH (never the JSON, never the secret);
  // every other spawn stays the byte-identical inline JSON form (o.mcpConfigPath undefined).
  args.push("--strict-mcp-config", "--mcp-config", o.mcpConfigPath ?? JSON.stringify({ mcpServers: o.mcpServers }));
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
 * Best-effort reap of any descendant process a torn-down pty's root process leaves behind — the backstop
 * for a child that ESCAPES node-pty's own orphan-free containment (Job Object on Windows / process-group
 * kill on POSIX) by detaching into its own process group/session — e.g. a `pnpm dev` vite dev-server the
 * agent backgrounds via its own Bash tool while verifying UI work (Web-Designer/QA workers), which then
 * outlives the session and walks the port range (board card 621ef252 — six stale vite servers observed).
 *
 * Called from the pty's `onExit` — the ONE chokepoint every exit path shares (a graceful/hard stop, a
 * recycle's predecessor stop, or an unexpected crash) — so it's DURABLE: it runs even when the root
 * process died without going through PtyHost.stop() at all.
 *
 * By the time this runs the root process is ALREADY DEAD (onExit only fires after exit), which rules out
 * `taskkill /T` on Windows — verified empirically that it refuses to walk the descendant tree once the
 * given PID is no longer a running process (it just errors "process not found" and stops). What DOES
 * still work: a process's `ParentProcessId` is stamped at CREATION and stays queryable via WMI/CIM long
 * after the parent has exited (verified). So we enumerate the FULL process list ourselves — Windows via
 * `Get-CimInstance Win32_Process` (CIM, not the deprecated `wmic`), POSIX via `ps -eo pid,ppid` — walk the
 * descendant tree from `rootPid` in-process, and force-kill each survivor directly (each already confirmed
 * a live pid by appearing in the snapshot, so a plain `process.kill` suffices — no further tree tool needed).
 *
 * Fire-and-forget: spawns a helper process asynchronously and never throws or blocks the caller. A missing
 * OS tool, an empty process list, or a pid already gone is a silent no-op. Narrow accepted race: OS PID
 * reuse could in principle attribute an unrelated process's children to a long-dead `rootPid` — the same
 * class of risk already accepted elsewhere in Loom for pid-keyed process tracking. That SAME reuse race
 * can also fabricate a parent-map CYCLE (e.g. `A.ppid=B` and `B.ppid=A`) — impossible in a real process
 * tree but reachable via a reused pid — so the walk below tracks `seen` pids and never revisits one; without
 * it a cycle would spin the `while (stack.length)` loop forever and freeze the daemon's event loop (`sweep`
 * runs synchronously in-process on `cmd`'s `close` event, not in the spawned helper).
 */
export function reapOrphanedDescendants(rootPid: number): void {
  const sweep = (out: string): void => {
    const byParent = new Map<number, number[]>();
    for (const line of out.split("\n")) {
      const m = line.trim().match(/^(\d+)[,\s]+(\d+)$/);
      if (!m) continue;
      const pid = Number(m[1]);
      const ppid = Number(m[2]);
      if (pid === ppid) continue; // guard a malformed/self-referential row
      let list = byParent.get(ppid);
      if (!list) { list = []; byParent.set(ppid, list); }
      list.push(pid);
    }
    const seen = new Set<number>();
    const stack = [rootPid];
    while (stack.length) {
      const p = stack.pop()!;
      if (seen.has(p)) continue; // bounds the walk to each pid at most once — breaks any parent-map cycle
      seen.add(p);
      for (const child of byParent.get(p) ?? []) {
        try { process.kill(child, "SIGKILL"); } catch { /* already gone */ }
        stack.push(child);
      }
    }
  };
  const cmd = process.platform === "win32"
    ? spawnProcess("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-Command",
        "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId),$($_.ParentProcessId)\" }",
      ], { stdio: ["ignore", "pipe", "ignore"] })
    : spawnProcess("ps", ["-eo", "pid,ppid"], { stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  cmd.stdout?.on("data", (d) => { out += d; });
  cmd.on("error", () => { /* helper unavailable — best-effort, never throws */ });
  cmd.on("close", () => sweep(out));
}

/**
 * One live OS process, as far as {@link reapProcessesRootedInWorktree} needs to know about it. Any field
 * the platform can't supply is `null` (e.g. POSIX gives no separate executable-path-vs-cwd distinction for
 * a gone/permission-denied pid; win32's CIM query gives no cwd at all) — the caller ORs across whichever
 * fields ARE populated, so a partial read still matches.
 */
export interface WorktreeProcess {
  pid: number;
  exePath: string | null;
  cwd: string | null;
  commandLine: string | null;
}

/** Injectable process lister for {@link reapProcessesRootedInWorktree} (defaults to the real OS
 *  enumerator). Takes the same `timeoutMs` the caller is bounding by, so an enumerator that itself spawns
 *  a helper process (win32) can bound + kill that helper on timeout rather than merely being raced and
 *  abandoned by an outer wrapper — see {@link enumerateProcessesWin32}. */
export type ProcessEnumerator = (timeoutMs: number) => Promise<WorktreeProcess[]>;
/** Injectable process killer for {@link reapProcessesRootedInWorktree} (defaults to a real OS kill). */
export type ProcessKiller = (pid: number) => void;

/** Normalize a path for substring matching: backslashes → forward slashes, lowercased, no trailing slash. */
function normalizePathForMatch(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
}

/**
 * Is `proc` rooted under `worktreePath` — by executable path, cwd, OR command line? This is the
 * SAFETY-CRITICAL predicate: {@link reapProcessesRootedInWorktree} kills only what this returns true for,
 * so a false positive here would kill an unrelated (possibly live) process. Guards against a PREFIX
 * collision (worktree `…/worktrees/abc` must NOT match a process rooted in a SIBLING `…/worktrees/abcdef`
 * — worktree dirs are keyed by a 12-hex task-hash, so this is a defense-in-depth belt, not a load-bearing
 * assumption) by requiring the match to land on a path-segment boundary: the candidate string must EQUAL
 * the normalized worktree path or contain it immediately followed by `/`. Pure (no I/O) — unit-testable
 * without spawning anything.
 */
export function processRootedInWorktree(proc: WorktreeProcess, worktreePath: string): boolean {
  const target = normalizePathForMatch(worktreePath);
  const targetWithSep = `${target}/`;
  const matches = (s: string | null): boolean => {
    if (!s) return false;
    const n = normalizePathForMatch(s);
    return n === target || n.includes(targetWithSep);
  };
  return matches(proc.exePath) || matches(proc.cwd) || matches(proc.commandLine);
}

/** Real POSIX process enumerator: walk `/proc/<pid>` reading `exe`/`cwd` (symlinks) and `cmdline` (NUL-
 *  joined argv). Any per-pid read failure (permission denied, or the pid exited mid-scan) is swallowed —
 *  that pid is simply reported with whatever fields DID resolve, or omitted if none did. */
async function enumerateProcessesPosix(_timeoutMs: number): Promise<WorktreeProcess[]> {
  let entries: string[];
  try {
    entries = await fs.promises.readdir("/proc");
  } catch {
    return [];
  }
  const procs: WorktreeProcess[] = [];
  await Promise.all(entries.filter((e) => /^\d+$/.test(e)).map(async (pidStr) => {
    let exePath: string | null = null;
    let cwd: string | null = null;
    let commandLine: string | null = null;
    try { exePath = await fs.promises.readlink(`/proc/${pidStr}/exe`); } catch { /* gone/denied */ }
    try { cwd = await fs.promises.readlink(`/proc/${pidStr}/cwd`); } catch { /* gone/denied */ }
    try {
      const raw = await fs.promises.readFile(`/proc/${pidStr}/cmdline`, "utf8");
      const joined = raw.split("\0").filter(Boolean).join(" ");
      if (joined) commandLine = joined;
    } catch { /* gone/denied */ }
    if (exePath || cwd || commandLine) procs.push({ pid: Number(pidStr), exePath, cwd, commandLine });
  }));
  return procs;
}

/** Matches any raw ASCII control character (0x00–0x1F) — built from char codes so the source never embeds
 *  a literal control character itself. See its use in {@link enumerateProcessesWin32}. */
const CONTROL_CHAR_RE = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(31)}]`, "g");

/** Real win32 process enumerator: `Get-CimInstance Win32_Process` for every live process's ExecutablePath
 *  + CommandLine (win32 exposes no per-process cwd via CIM, so `cwd` is always null here — Path +
 *  CommandLine is what the live-evidence investigation found sufficient: the esbuild service's OWN
 *  executable runs FROM inside the worktree, and vite's global node.exe carries the worktree path in its
 *  CommandLine). `@(...)` forces array context so ConvertTo-Json returns a JSON ARRAY even for 0 or 1
 *  processes (bare `ConvertTo-Json` on a single object would otherwise emit a bare object, not `[obj]`).
 *
 *  SELF-BOUNDED: unlike the outer {@link withReapTimeout} race (which only stops the CALLER waiting, the
 *  same limitation `withTimeout` in git/worktrees.ts documents for its own callers), this function arms
 *  its OWN timer and force-kills the `powershell.exe` child it spawned if the query hasn't closed by
 *  `timeoutMs` — so a wedged/slow CIM query (WMI contention, a loaded host) can never leave an orphaned
 *  helper process behind, the same leak class this whole feature exists to prevent. */
function enumerateProcessesWin32(timeoutMs: number): Promise<WorktreeProcess[]> {
  return new Promise((resolve) => {
    const cmd = spawnProcess("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      "@(Get-CimInstance Win32_Process | Select-Object ProcessId,ExecutablePath,CommandLine) | ConvertTo-Json -Compress",
    ], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    let settled = false;
    const finish = (result: WorktreeProcess[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      // Force-kill the query helper itself so a wedged CIM call never leaks an orphaned powershell.exe —
      // mirrors killRemoveChild's win32 posture (taskkill /T /F, then a plain kill as belt-and-suspenders).
      if (cmd.pid) { try { spawnProcess("taskkill", ["/pid", String(cmd.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* best effort */ } }
      try { cmd.kill(); } catch { /* already gone */ }
      finish([]);
    }, timeoutMs);
    // Explicit utf8 decoding — without it a multibyte sequence split across chunk boundaries could
    // corrupt a CommandLine path and MISS a match (fail-safe: under-kill, not over-kill, since the
    // wedge-retry sweep catches a missed process next pass).
    cmd.stdout?.setEncoding("utf8");
    cmd.stdout?.on("data", (d) => { out += d; });
    cmd.on("error", () => finish([]));
    cmd.on("close", () => {
      try {
        // `ConvertTo-Json` can leave a raw, UN-ESCAPED control character inside a `CommandLine` string
        // (observed live against real running processes on this host), which makes strict `JSON.parse`
        // throw on an otherwise well-formed array — silently zeroing out the WHOLE enumeration (the old
        // catch-all below would swallow it and return no processes at all, not just skip the one bad
        // entry). A JSON structural character is never below 0x20, so any raw control character can only
        // ever be sitting inside a string VALUE — safe to blank out without corrupting the JSON shape.
        const sanitized = out.replace(CONTROL_CHAR_RE, " ");
        const parsed = JSON.parse(sanitized || "[]") as unknown;
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        finish(arr.map((r: Record<string, unknown>) => ({
          pid: Number(r["ProcessId"]),
          exePath: (r["ExecutablePath"] as string | null) ?? null,
          cwd: null,
          commandLine: (r["CommandLine"] as string | null) ?? null,
        })));
      } catch {
        finish([]);
      }
    });
  });
}

/** Real process killer: `taskkill /pid <pid> /T /F` on win32 (kills any subtree the survivor itself
 *  spawned too), `SIGKILL` on posix — mirrors {@link killRemoveChild}'s posture (unconditional, immediate,
 *  best-effort — an already-gone pid is a silent no-op). */
function killProcessById(pid: number): void {
  if (process.platform === "win32") {
    try { spawnProcess("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* best effort */ }
  }
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone / no permission */ }
}

/** Reject after `ms` — bounds {@link reapProcessesRootedInWorktree}'s enumerate step so a wedged/slow
 *  helper (a hung `powershell.exe`, an unreadable `/proc`) can never block worktree teardown indefinitely. */
function withReapTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`process enumeration exceeded ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

/**
 * THE PREVENTION for dangling worktrees (task 8e5a7a5e — live evidence 2026-07-03/04): before a worktree
 * dir is removed, kill any OS process still ROOTED in it — by executable path, cwd, or command line (see
 * {@link processRootedInWorktree}) — that {@link reapOrphanedDescendants}'s pty-tree walk MISSES because
 * it detached/re-parented away from the pty's process tree entirely (an esbuild long-lived service
 * process, a backgrounded vite dev-server, a lingering tsserver/watcher). Without this, such a survivor
 * keeps a file handle open inside the worktree and the subsequent `removeWorktree` hits
 * `ERROR_SHARING_VIOLATION` on Windows (the confirmed root cause of the owner's 8 wedged dead-leftover
 * worktrees) — this closes the window BEFORE that removal is even attempted, rather than reacting to it.
 *
 * SAFETY (this function is the one new code path this task's mandatory Code-Reviewer pass exists for): the
 * match is scoped to EXACTLY the one `worktreePath` the caller is about to tear down, at a path-segment
 * boundary ({@link processRootedInWorktree} — no prefix-collision false-positive across sibling worktree
 * dirs). It is the CALLER's responsibility to only ever invoke this with a worktree that is genuinely being
 * removed (never a live/protected one) — every call site in SessionService (gcWorktreeDir, the single
 * removal chokepoint shared by finalizeMerge, boot-reconcile Pass B, and the wedge-retry sweep) already
 * upholds that invariant for `removeWorktree` itself, so wiring this in right before that same call inherits
 * the same guarantee for free, without this function needing to know anything about sessions/liveness itself.
 *
 * BOUNDED + BEST-EFFORT: the enumerate step is time-boxed both by the outer {@link withReapTimeout} race
 * AND, for the real win32 enumerator, by its OWN internal timer that force-kills its spawned helper (see
 * {@link enumerateProcessesWin32}) — so a wedged query can never leak a helper process on top of failing
 * to find its target. ANY failure (a missing OS tool, an enumeration timeout, a kill that errors) is
 * swallowed — this must never throw or block teardown, mirroring every other best-effort helper in the
 * worktree-removal path. Injectable via `deps` (enumerate/kill/timeoutMs) so a test can drive it with a
 * fake process list instead of the real OS.
 *
 * ACCEPTED RISK (both fail-safe / under-kill, not over-kill — reviewed and deliberately kept): (1) the
 * command-line arm of {@link processRootedInWorktree} intentionally over-matches a process that merely
 * NAMES the doomed worktree path in its argv without being rooted there — this is load-bearing, not a
 * bug, because on win32 vite's global node.exe carries the worktree path ONLY in its CommandLine (CIM
 * exposes no per-process cwd), so narrowing the match would miss the exact survivor this function exists
 * to catch. (2) {@link killProcessById}'s win32 path (`taskkill /pid <pid> /T /F`) kills the matched pid's
 * whole subtree, which widens the blast radius past the one matched process — theoretically reaching an
 * ancestor-of-the-daemon if one were ever wrongly rooted in a worktree, though not realistic for a
 * checkout-launched daemon (the daemon's own pid is separately excluded below regardless).
 *
 * SELF-EXCLUSION: the daemon's OWN pid (`process.pid`) is never a kill candidate, regardless of what
 * `processRootedInWorktree` says — a defense-in-depth backstop against the (currently theoretical, but
 * cheap-to-rule-out) case where the daemon's own cwd/exePath/commandLine happens to satisfy the match
 * (e.g. a misconfigured LOOM_HOME nested under the very worktree being torn down). The task's own DoD
 * requires this can never happen; this makes it structurally impossible rather than merely unlikely.
 *
 * `deps.excludePids` (Code Review finding on card 864e79fe): additional pids a caller knows are
 * genuinely rooted in `worktreePath` but must survive anyway — specifically, a worker's OWN claude pty
 * when this is invoked BEFORE that worker has been stopped (confirmWorkerMerge's pre-gate sweep, run
 * while the confirming worker may still be live). Without this, the sweep would kill the worker's own
 * process on every gated confirm — on a subsequent gate FAILURE that would strand a worker meant to
 * survive for re-tasking. This is deliberately separate from the unconditional `process.pid`
 * self-exclusion above: that one is a blanket, always-on backstop for the daemon itself; this one is a
 * caller-supplied, call-site-specific allowance.
 */
export async function reapProcessesRootedInWorktree(
  worktreePath: string,
  deps: { enumerate?: ProcessEnumerator; kill?: ProcessKiller; timeoutMs?: number; excludePids?: number[] } = {},
): Promise<{ killedPids: number[] }> {
  const enumerate = deps.enumerate ?? (process.platform === "win32" ? enumerateProcessesWin32 : enumerateProcessesPosix);
  const kill = deps.kill ?? killProcessById;
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const excluded = new Set(deps.excludePids ?? []);
  try {
    const procs = await withReapTimeout(enumerate(timeoutMs), timeoutMs);
    const killedPids: number[] = [];
    for (const proc of procs) {
      if (proc.pid === process.pid) continue; // NEVER the daemon's own process — see SELF-EXCLUSION above
      if (excluded.has(proc.pid)) continue; // caller-supplied survivor — see excludePids doc above
      if (!processRootedInWorktree(proc, worktreePath)) continue;
      try { kill(proc.pid); killedPids.push(proc.pid); } catch { /* best effort */ }
    }
    return { killedPids };
  } catch {
    return { killedPids: [] }; // enumeration failed/timed out — best-effort, never throw past the caller
  }
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
  /** See PlatformConfig.coalesceAgentMessages (shared). Defaults false (one-per-turn agent delivery);
   *  index.ts overrides with the resolved `platform.coalesceAgentMessages` at boot (BOOT-BOUND). Read
   *  ONCE here (not per-message) by drainPending. */
  private readonly coalesceAgentMessages: boolean;
  /**
   * Agent-tooling P4: read access to the OWNER-ADDED capability catalog + the P1 secret store, wired in
   * by index.ts at boot (it holds `db`; PtyHost deliberately does not). Both default to a harmless no-op
   * (empty catalog / no secret) so a PtyHost built without these opts — every existing hermetic test —
   * behaves byte-identically: the two BUILTIN capabilities never consult either callback.
   */
  private readonly getCapabilityCatalog: () => CapabilityDefRow[];
  private readonly resolveConnectionSecret: (connectionId: string) => string | undefined;
  constructor(
    private events: PtyHostEvents,
    opts?: {
      busyStaleMs?: number; coalesceAgentMessages?: boolean;
      getCapabilityCatalog?: () => CapabilityDefRow[];
      resolveConnectionSecret?: (connectionId: string) => string | undefined;
    },
  ) {
    this.busyStaleMs = opts?.busyStaleMs ?? BUSY_STALE_MS;
    this.coalesceAgentMessages = opts?.coalesceAgentMessages ?? false;
    this.getCapabilityCatalog = opts?.getCapabilityCatalog ?? (() => []);
    this.resolveConnectionSecret = opts?.resolveConnectionSecret ?? (() => undefined);
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
      rateLimited: false,
      // The startup-prompt turn runs from a CLI arg (not submit()), so seed lastPrompt with it —
      // a cap on the FIRST turn must still be re-submittable on resume (§19c-b). It carries NO companion
      // route (a startup turn is never a companion inbound), so the route fields start null.
      lastPrompt: opts.startupPrompt ?? null,
      firstTurnStarted: false, // flips true on the first UserPromptSubmit — see scheduleKickoffGuarantee/healIfStuck
      enterConfirmed: true, // no submit() outstanding yet (the startup turn is a CLI arg, not submit()) — see submit()'s reset
      submitGeneration: 0,
      activeTurnRoute: null,
      lastPromptRoute: null,
      activeTurnOwnerText: null,
      lastPromptOwnerText: null,
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
      role: opts.role ?? null,
      dejaCapture: !!opts.dejaCapture,
      lastPromptText: null,
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
      // Reap any descendant (e.g. a backgrounded `pnpm dev`) that escaped node-pty's own orphan-free
      // containment — the durable backstop for board card 621ef252. Fires on EVERY exit path, including
      // an unexpected crash that never went through stop().
      reapOrphanedDescendants(live.pid);
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
      pending: [], stopping: false, rateLimited: false, lastPrompt: null,
      firstTurnStarted: true, // not applicable (no kickoff to guarantee) — seeded true so the fresh-spawn checks are trivially satisfied
      enterConfirmed: true, // not applicable (deliverHook/submit's verify-retry never runs for a shell/canned kind)
      submitGeneration: 0,
      activeTurnRoute: null, lastPromptRoute: null,
      activeTurnOwnerText: null, lastPromptOwnerText: null,
      startupModeCycles: 0, startupCyclesDone: true,
      mcpPromptHandled: true, bootScan: "",
      resumeGateHandled: true, resumeGateScan: "",
      isResume: false, modeLogged: true, // a shell has no claude footer/permission mode to read
      resumeModeTarget: null, // a shell never cycles a permission mode
      role: null, // a shell has no role; unreachable anyway (modeLogged:true skips the auto-heal read)
      dejaCapture: false, lastPromptText: null, // a shell never fires UserPromptSubmit — inert
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
   * TEST-ONLY (card a53e6bc9): register a no-process "live" entry so `/ws/term` attach replays a pinned
   * geometry + recorded bytes with NO real claude/shell spawn — closing the gap left by the seed
   * endpoint's plain `liveSessions` DB row (card d01311b6), whose WS attach is a genuine no-op (no pty to
   * subscribe to) and so can only prove card CHROME, never faithful terminal RENDERING. `subscribe()`
   * doesn't care that `pty` is a stub — it only reads `ring`/`geometry`/`engineSessionId`/`alive` — so the
   * existing replay-then-stream path (ring replay + a `geometry` control frame on attach) serves the
   * canned bytes verbatim with no new WS code path and no client-side monkeypatching. Nothing ever calls
   * the stub's write/resize/kill (a canned entry outlives the spec; cleanup is `dropCanned`), so it stays
   * static for its whole life.
   */
  seedCanned(opts: { id: string; cwd: string; geometry: PtyGeometry; bytes: Buffer }): void {
    const stub: IPty = {
      pid: -1, cols: opts.geometry.cols, rows: opts.geometry.rows, process: "canned",
      handleFlowControl: false,
      onData: () => ({ dispose: () => {} }),
      onExit: () => ({ dispose: () => {} }),
      resize: () => {}, clear: () => {}, write: () => {}, kill: () => {}, pause: () => {}, resume: () => {},
    };
    const live: Live = {
      pty: stub, pid: stub.pid, cwd: opts.cwd,
      kind: "canned", geometry: opts.geometry,
      role: null, // a canned entry has no role; unreachable anyway (modeLogged:true skips the auto-heal read)
      engineSessionId: null,
      ring: { chunks: [], bytes: 0 },
      subscribers: new Set(),
      alive: true,
      logStream: fs.createWriteStream(path.join(LOGS_DIR, `${opts.id}.log`)),
      busy: false, ready: true, busySince: null,
      lastOutputAt: Date.now(), composerLen: 0,
      pending: [], stopping: false, rateLimited: false, lastPrompt: null,
      firstTurnStarted: true, // not applicable (no kickoff to guarantee) — seeded true so the fresh-spawn checks are trivially satisfied
      enterConfirmed: true, // not applicable (deliverHook/submit's verify-retry never runs for a shell/canned kind)
      submitGeneration: 0,
      activeTurnRoute: null, lastPromptRoute: null,
      activeTurnOwnerText: null, lastPromptOwnerText: null,
      startupModeCycles: 0, startupCyclesDone: true,
      mcpPromptHandled: true, bootScan: "",
      resumeGateHandled: true, resumeGateScan: "",
      isResume: false, modeLogged: true,
      resumeModeTarget: null,
      dejaCapture: false, lastPromptText: null, // a canned entry never fires UserPromptSubmit — inert
    };
    if (opts.bytes.length) this.appendRing(live, opts.bytes);
    this.live.set(opts.id, live);
  }

  /** TEST-ONLY: drop a `seedCanned` entry (no process to kill — just forget the map entry + close its log). */
  dropCanned(id: string): void {
    const live = this.live.get(id);
    if (!live || live.kind !== "canned") return;
    try { live.logStream.end(); } catch { /* ignore */ }
    this.live.delete(id);
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
    // Pre-accept the workspace-trust dialog so warmup never blocks. SYNCHRONOUS on the hot path BY
    // DESIGN — the trust flags MUST be persisted to ~/.claude.json before the pty spawns, else the
    // unattended `claude` blocks on the trust prompt and never reaches SessionStart (the load-bearing
    // trust-before-spawn invariant). This cannot move off the hot path à la markitdown.
    // Why the bounded cross-process lock inside (claude-config withTrustLock) does NOT freeze the event
    // loop on an orchestration fan-out: spawn()→createPty()→ensureTrusted() is a fully synchronous call
    // chain (no await), and JS is single-threaded — so two in-process spawns CANNOT interleave. Each
    // ensureTrusted acquires the O_EXCL lock and releases it (in finally) within one synchronous call
    // stack before the event loop can start the next spawn, so the lock is NEVER contended in-process
    // and the sleepSync wait loop is unreachable from a single daemon's own fan-out. A burst of N
    // first-spawns is N sequential synchronous read-modify-writes (the lock adds only an uncontended
    // openSync(wx)+rmSync each). The contended path (sleepSync up to trustLockMs) is reachable ONLY
    // across processes — a second Loom daemon sharing this home — which is exactly the cross-process
    // clobber the lock exists to prevent; there the bounded 5s best-effort degrade is correct. The
    // already-trusted fast path is lock-free and covers the steady state.
    ensureTrusted(opts.cwd);
    // Mirror Loom's managed skills into <cwd>/.claude/skills (project-local; shadow personal). Never
    // let a skills hiccup block a spawn — a session must boot even if skill delivery fails. The Obsidian
    // signal rides opts.sessionEnv (set by obsidianSessionEnv ONLY when obsidian.autoStart is on) — the
    // local `env` isn't built yet here, so derive it from opts.sessionEnv. Off ⇒ byte-identical injection.
    const obsidianEnabled = opts.sessionEnv?.LOOM_OBSIDIAN_AUTOSTART === "1";
    try { injectSkills(opts.cwd, opts.sessionId, opts.skills ?? null, opts.role, obsidianEnabled); } catch (e) { console.log(`[pty] injectSkills failed (non-fatal): ${(e as Error).message}`); }
    // Both managers AND workers get the orchestration MCP — but a role-gated surface: managers
    // get the full coordination tools, workers get only worker_report + the read-only my_context
    // (resolved server-side). A
    // platform-lead instead gets the loom-platform MCP (project/agent creation, Pillar C). acceptEdits
    // does NOT auto-approve MCP tools (the §9 lesson — why mcp__loom-tasks is in the default allow),
    // so allowlist the role's MCP server too, else the agent hangs on a prompt.
    // manager/worker AND the Companion (assistant) allowlist the loom-orchestration server (acceptEdits
    // doesn't auto-approve MCP tools — the §9 lesson); the assistant's registered surface is just
    // my_context + the companion-gated chat_reply, so the server-level allow is all it needs.
    const wantsOrch = opts.role === "manager" || opts.role === "worker" || opts.role === "assistant";
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
    // Agent-tooling P4: generalize the legacy hardcoded tool-allows into ONE loop over every resolved
    // capability grant (mirrors buildMcpServers' loop) — the legacy slugs keep their exact hardcoded
    // allow entries; an owner-added capability contributes its own `toolAllowlist` from the catalog.
    // ACCEPTED for v1 (code review): this queries the owner-added catalog on EVERY spawn, even one with
    // zero capabilities enabled — a cheap indexed SELECT (capability_defs is expected to stay small), not
    // worth a cache for the read frequency here. Revisit if the catalog ever grows large or spawns get hot.
    const capabilityCatalog = this.getCapabilityCatalog();
    const capabilityAllow = capabilityToolAllowlist(resolveProfileCapabilities(opts), capabilityCatalog);

    // §6 scoping: route by session id in the URL path; daemon derives the project server-side. The
    // mcpServers map (loom-tasks + role surface + opt-in Playwright) is assembled by the testable seam.
    // The HUMAN-only python.interpreterPath rides the session env (config → pythonSessionEnv); read it here
    // and hand it to the shared-venv markitdown resolver (only consulted when documentConversion is on).
    // Computed BEFORE extraAllow (moved up from below) so a mounted "codescape" entry can gate its OWN
    // tool allowlist off the actual mount decision, rather than re-deriving the same isLoomDev()/port/
    // project-enabled condition a second time here.
    const mcpServers = buildMcpServers({
      sessionId: opts.sessionId, port: PORT, role: opts.role, browserTesting: opts.browserTesting, documentConversion: opts.documentConversion, dejaCorpus: opts.dejaCorpus,
      vaultPath: opts.vaultPath,
      pythonInterpreterPath: opts.sessionEnv?.LOOM_PYTHON_INTERPRETER,
      capabilities: opts.capabilities, capabilityCatalog, resolveConnectionSecret: this.resolveConnectionSecret,
      codescapeEnabled: opts.codescapeEnabled, codescapePort: opts.codescapePort, projectId: opts.projectId, worktreeId: opts.worktreeId,
    });
    // Card C2: the Codescape MCP tools ALSO need allowlisting (acceptEdits doesn't auto-approve MCP tools —
    // the §9 lesson), gated on the mcpServers map actually carrying the entry (not re-derived here).
    const extraAllow = [
      ...roleAllow,
      ...capabilityAllow,
      ...(mcpServers.codescape ? CODESCAPE_TOOL_ALLOW : []),
    ];
    const permission = extraAllow.length
      ? { ...opts.permission, allow: [...opts.permission.allow, ...extraAllow] }
      : opts.permission;
    const settingsPath = writeSessionSettings(opts.sessionId, permission, opts.vaultPath, opts.dejaCapture);
    // Role-scoped disallow of the interactive human-prompt tools (AskUserQuestion / Exit|EnterPlanMode):
    // a Loom-driven role (worker/setup/auditor/workspace-auditor) must never block on a human — UNIONed with
    // the curated dangerous native tools when this session's Profile set restrictedTools (Companion
    // blast-radius control). Computed from the session role + pinned flag at the single spawn chokepoint, so
    // EVERY path (fresh/resume/fork/recycle/boot) inherits it; when restrictedTools is off this is exactly
    // disallowedToolsForRole(role) ⇒ byte-identical argv. See disallowedToolsForSpawn.
    const disallowedTools = disallowedToolsForSpawn(opts.role, opts.restrictedTools);
    // Agent-tooling P4 credential-tie hardening: a capability secret must NEVER ride the claude process's
    // own argv. Diverting to a 0600 per-session FILE is CONDITIONAL on the map actually carrying one —
    // every secret-free spawn (every session today) keeps the byte-identical inline --mcp-config <json>
    // form (see buildSpawnArgs' mcpConfigPath doc). The file is rewritten every spawn (fresh/resume/fork/
    // recycle all call createPty, which rebuilds mcpServers fresh each time), mirroring writeSessionSettings.
    const capabilitySecrets = collectMcpEnvSecrets(mcpServers);
    const mcpConfigPath = capabilitySecrets.length ? writeSessionMcpConfig(opts.sessionId, mcpServers) : undefined;
    const args = buildSpawnArgs({ resumeId: opts.resumeId, fork: opts.fork, forkSessionId: opts.forkSessionId, settingsPath, mode: permission.mode, mcpServers, mcpConfigPath, startupPrompt: opts.startupPrompt, model: opts.model, disallowedTools });

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

    // Belt-and-suspenders (agent-tooling P4): redact any capability secret out of the LOGGED argv even
    // though mcpConfigPath should already keep it off `args` itself when present — never log raw secret
    // values under any circumstance. A no-op (capabilitySecrets empty) for every existing spawn.
    const argsLog = capabilitySecrets.length ? redactSecrets(JSON.stringify(args), capabilitySecrets) : JSON.stringify(args);
    // eslint-disable-next-line no-console
    console.log(`[pty] spawn ${opts.sessionId} bin=${bin} cwd=${opts.cwd} resume=${opts.resumeId ?? "none"} args=${argsLog}`);
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
    // UserPromptSubmit carries `prompt` (the literal triggering turn text) — read ONLY when
    // dejaCapture is on (see the UserPromptSubmit case / Live.lastPromptText).
    hook: { hook_event_name?: string; session_id?: string; error?: string; error_details?: unknown; resetsAt?: number; prompt?: string },
  ): void {
    const live = this.live.get(sessionId);
    if (!live) return;
    if (live.kind !== "claude") return; // shells/canned entries have no hook relay; the busy/readiness machine is Claude-only
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
        // restore the persisted mode (probe-verified on 2.1.163; card f05e4897). Both FRESH and RESUME now
        // share ONE strategy — ABSOLUTE feedback cycling (cycleToMode, card b99d3d67): derive the target
        // mode and drive the footer to it by reading it and pressing Shift+Tab until it lands, instead of
        // FRESH's old BLIND relative cycling (a dropped/mistimed press could half-land on `plan` and stay
        // there — a worker has no `ExitPlanMode` tool to self-exit). RESUME already carries an explicit
        // absolute `resumeModeTarget` (set by SessionService.resume); FRESH derives the equivalent target
        // from the SAME `startupModeCycles` config count a blind cycle would have used
        // (modeAfterCyclesFromAcceptEdits — default 2 → auto), so both converge to the identical target a
        // fresh spawn of the config reaches. Bounded + graceful (see cycleToMode); `startupModeCycles:0`
        // means "leave the boot mode" — no cycling at all, straight to ready.
        // The session is marked READY (which releases any queued injection) only AFTER the cycle lands —
        // so a boot-recovery nudge can't interleave with the Shift+Tabs. That interleave was the
        // 2026-06-03 restart bug: the nudge stranded un-submitted in the composer and the mode stuck
        // mid-cycle on plan.
        if (!live.startupCyclesDone) {
          live.startupCyclesDone = true;
          const target = live.resumeModeTarget ?? (live.startupModeCycles > 0 ? modeAfterCyclesFromAcceptEdits(live.startupModeCycles) : null);
          if (target) {
            this.cycleToMode(sessionId, target, () => this.markReady(sessionId));
          } else {
            this.markReady(sessionId);
          }
        } else {
          this.markReady(sessionId); // idempotent: a repeat SessionStart still ensures readiness
        }
        break;
      case "UserPromptSubmit":
        // Observed for EVERY turn, including the fresh-spawn startup-prompt arg — the FIRST one proves a
        // turn actually started, closing scheduleKickoffGuarantee's fallback window and healIfStuck's
        // short pre-first-turn stale window (see both). Idempotent after the first.
        live.firstTurnStarted = true;
        live.enterConfirmed = true; // proof the outstanding submit()'s Enter registered — cancels sendEnterAndVerify's retry loop (card 9549e322)
        this.setBusy(sessionId, true); // rising edge — fires for the startup-prompt arg and injected prompts alike
        // Deja origin_prompt v2 (card d4b48f31): retain ONLY the most-recent turn's literal text, and
        // ONLY when this session opted into dejaCapture — overwritten every turn, never appended, never
        // persisted (see Live.lastPromptText for the privacy rationale).
        if (live.dejaCapture && typeof hook.prompt === "string") live.lastPromptText = hook.prompt;
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
        // A Stop/StopFailure can only fire for a turn that actually ran, so it is itself proof the
        // outstanding submit()'s Enter registered — even on the rare path where UserPromptSubmit's own
        // hook was lost. Neutralize any still-pending verify-retry BEFORE the M2 window below.
        live.enterConfirmed = true;
        this.finalizingTurn = true;
        try {
          this.setBusy(sessionId, false); // falling edge — exactly one Stop per end-of-turn (no per-tool-use)
          // Companion injection-guard Primitive A: CLEAR the just-ended turn's attested owner text here —
          // unlike activeTurnRoute (which persists until the next submit() overwrites it), owner text must
          // never survive past the turn it attests, so a later non-owner-authored turn can't inherit it. A
          // rate-limited park below still replays it via lastPromptOwnerText (resumeAfterRateLimit).
          live.activeTurnOwnerText = null;
          // Refresh context occupancy at the turn boundary — ONE single-pass tail-read of the transcript
          // (card b16320bc review: this used to be read TWICE — once here, once again below for the
          // weekly-cap text sentinel — doubling synchronous parse work of a potentially multi-MB JSONL on
          // this M2-sensitive Stop-hook chokepoint; `stats.lastAssistantText` now comes from this SAME
          // read). Cheap SYNCHRONOUS tail-read; done for EVERY session (the host doesn't know role — a
          // manager's own occupancy matters too, "who recycles the manager"). Keep it sync — see the M2
          // box above before making this (or anything here) async.
          const stats = live.engineSessionId ? readContextStats(live.cwd, live.engineSessionId) : null;
          if (stats) this.events.onContextStats(sessionId, stats);
          // §19c usage-limit park: a StopFailure with error==="rate_limit" means the turn died on the
          // cap. The pty stays alive; we record the resume-at and do NOT drain a new turn into a capped
          // account (the pending queue is held intact for #19c-b's resume). billing_error / a clean Stop
          // fall through to the normal drain. (The `finally` below still clears the tripwire on this break.)
          if (hook.hook_event_name === "StopFailure") {
            const det = detectUsageLimit(hook);
            if (det.limited) {
              const until = rateLimitedUntil(det.resetsAtSeconds);
              // PARK: suppress drain/submit until resume. Skipping the synchronous drain below is not enough —
              // the ~10s reconcile timer (and any incoming enqueueStdin) would otherwise drain pending into the
              // capped account and submit() would CLOBBER lastPrompt, losing the killed turn we must replay.
              live.rateLimited = true;
              this.events.onRateLimited(sessionId, until, { resetsAtSeconds: det.resetsAtSeconds, message: `usage limit — resumes ${until}` });
              break;
            }
          }
          // Weekly/account usage-cap TEXT sentinel fallback (card b16320bc): the interactive CLI answers
          // THAT cap with an ordinary assistant message + a CLEAN Stop, not a StopFailure — so the
          // structured check above never fires and the worker would otherwise stall, replying bare "No
          // response requested" to every later nudge with no visible park. Test the LAST assistant turn's
          // text-only reply (tool_use/tool_result excluded — see ContextStats.lastAssistantText) from the
          // SAME `stats` read above for the sentinel; on a match, park through the EXACT SAME path as the
          // structured detector above (no resetsAtSeconds — plain text carries no machine-readable reset —
          // so rateLimitedUntil falls back to the default backoff / the already-polled usage-window reset,
          // same as a reset-less StopFailure).
          if (stats?.lastAssistantText && isWeeklyUsageLimitSentinel(stats.lastAssistantText)) {
            const until = rateLimitedUntil(undefined);
            live.rateLimited = true;
            this.events.onRateLimited(sessionId, until, { message: `usage limit — resumes ${until}` });
            break;
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
   * Returns whether it went out now, or its 1-based queue position. A `delivered:false` result also
   * carries `reason` (see EnqueueDeliveryReason) so a caller can tell a dead-drop (`"session-dead"` —
   * no live pty, nothing will ever deliver this) apart from a hold (`"held"` — queued FIFO, will
   * deliver at the next turn boundary); both used to read as the same bare `{delivered:false}`.
   *
   * `source` defaults to 'system' so EVERY existing programmatic caller (worker reports, idle/context/
   * busy nudges, resume notes, escalations) stays 'system' unchanged; only the REST composer passes
   * 'human'. A held entry's source is what the human-facing mutators gate on (see QueuedMessage).
   *
   * `kind` defaults to `"warning"` (see QueuedMessageKind) so every caller this change didn't touch
   * keeps today's full-coalesce behavior byte-identical; every production call site that enqueues an
   * agent/human-authored message passes `"agent"` explicitly.
   *
   * `questionId` is an OPTIONAL tail tag (see QueuedMessage.questionId) — undefined for every caller this
   * change didn't touch. Only the decision-inbox answer route sets it, so `purgeQueuedByQuestionIds` can
   * later drop this exact nudge if it goes stale before it drains.
   *
   * `ownerText` (Companion injection-guard Primitive A) is an OPTIONAL trailing arg — appended after the
   * existing params so every positional call site this change didn't touch stays byte-identical. Only the
   * companion inbound submit path (the ONE place an authorized owner's literal chat text forms a turn)
   * passes it; every other caller omits it, leaving Live.activeTurnOwnerText null exactly as before.
   */
  enqueueStdin(sessionId: string, text: string, source: QueueSource = "system", onDeliver?: () => void, route?: TurnRoute, kind: QueuedMessageKind = "warning", questionId?: string, ownerText?: string): { delivered: boolean; position?: number; reason?: EnqueueDeliveryReason } {
    const live = this.live.get(sessionId);
    if (!live?.alive) return { delivered: false, reason: "session-dead" };
    this.healIfStuck(live, sessionId);
    // `ready` gate: a freshly (re)spawned pty is not ready until SessionStart. Submitting before then
    // writes into a still-booting TUI — the Enter is swallowed and the text strands in the composer
    // (the 2026-06-03 restart bug). Hold it FIFO; markReady drains it once the engine is up.
    if (live.ready && !live.busy && !live.stopping && !live.rateLimited && !this.deferForHumanDraft(live)) {
      // M2 GUARD: reaching the idle (busy=false) submit path while a turn is being finalized means an
      // `await` leaked into deliverHook's lower-busy→drain window (see the M2 box there). In correct,
      // synchronous code this is unreachable — enqueueStdin runs as its own event-loop task, never
      // interleaved with deliverHook. Tripping it would mean we're about to race a second turn in.
      if (this.finalizingTurn) {
        throw new Error("M2 invariant violated: enqueueStdin reached the idle-submit path mid turn-finalize — an `await` leaked between setBusy(false) and drainPending in deliverHook (host.ts).");
      }
      this.submit(sessionId, text, route, ownerText);
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
    // Held (busy / not-ready / composer-dirty / rate-limit parked). Carry the optional delivery callback so that when this
    // entry is finally handed to the recipient (drainPending or consumePending), the durable queued
    // message can be marked delivered. Undefined for every existing (non-messaging) caller → a no-op.
    live.pending.push({ id: randomUUID(), text, source, onDeliver, route, kind, questionId, ownerText });
    return { delivered: false, position: live.pending.length, reason: "held" };
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
   * Deja origin_prompt v2 (card d4b48f31): the most-recent UserPromptSubmit turn's literal text for a
   * dejaCapture-on session, or null when dejaCapture is off, no turn has landed yet, or the session is
   * unknown/dead. IN-MEMORY, MOST-RECENT-ONLY — see Live.lastPromptText. Read by
   * GET /internal/deja-context/:sessionId (server.ts) to enrich origin_prompt beyond task title+body.
   */
  getLastPromptText(sessionId: string): string | null {
    return this.live.get(sessionId)?.lastPromptText ?? null;
  }

  /**
   * Loom Companion (multi-channel reply routing): the ORIGINATING route of the session's IN-FLIGHT turn, or
   * null when the current/last turn wasn't formed from a companion inbound / proactive-home submit. The
   * companion's chat_reply reads THIS (via an injected resolver in the gateway) to deliver a reply back to
   * the exact route of the turn it answers. Because turns run serially and the route is pinned when a turn
   * is FORMED (submit/drain) — never when a later inbound is merely queued — an interleaved cross-route
   * inbound can't redirect an in-flight turn's reply. Returns null for an unknown/dead session.
   */
  getActiveTurnOrigin(sessionId: string): TurnRoute | null {
    return this.live.get(sessionId)?.activeTurnRoute ?? null;
  }

  /**
   * Companion injection-guard Primitive A (Companion Capability & Permission-Lever Framework §3): the
   * LITERAL authenticated owner inbound bytes forming the session's IN-FLIGHT turn, or null when the
   * current turn wasn't formed from an authorized owner inbound (proactive/heartbeat/reminder/cross-
   * channel-mirror/memory-recall — none of those pass `ownerText` to submit()/enqueueStdin), or once the
   * turn has ended (cleared at the Stop/StopFailure hook — see the Live.activeTurnOwnerText doc for why
   * this does NOT simply persist like getActiveTurnOrigin's route does). An ACT lever that requires owner
   * text is therefore automatically refused on any turn this returns null for — there is nothing to
   * attest. Returns null for an unknown/dead session.
   */
  getActiveTurnOwnerText(sessionId: string): string | null {
    return this.live.get(sessionId)?.activeTurnOwnerText ?? null;
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
  getPendingEntries(sessionId: string): Array<Pick<QueuedMessage, "id" | "text" | "source">> {
    // Strip the internal `onDeliver` callback — the UI only needs {id,text,source}, and a function must
    // never escape the host (it isn't serializable and is meaningless outside this process).
    return (this.live.get(sessionId)?.pending ?? []).map(({ id, text, source }) => ({ id, text, source }));
  }

  /**
   * Count of currently-queued `kind:"agent"` messages (see QueuedMessageKind) — UNCONSUMED direction
   * (manager redirect/message, a human composer turn, companion inbound), as opposed to `kind:"warning"`
   * operational nudges (idle/context/usage watchdogs, memory-recall), which coalesce and are NOT direction.
   * end_me's inbound-queue safety gate (card 3b015fc7) reads this to REFUSE a self-stop while the caller
   * still holds unconsumed direction — mirrors the worker_report(done) pending-direction guard's intent,
   * generalized from manager-origin-only to every agent-kind sender. Non-mutating (unlike flushPending/
   * consumePending) — a peek, not a drain. Returns 0 for a dead/unknown session.
   */
  pendingAgentCount(sessionId: string): number {
    return (this.live.get(sessionId)?.pending ?? []).filter((m) => m.kind === "agent").length;
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
   * Drop still-queued entries TAGGED to any of the given `questionIds` (see QueuedMessage.questionId) —
   * the decision-inbox's OWN targeted purge (card bbc46336 follow-up), called from `question_pull` right
   * after it atomically consumes those questions: any OTHER queued answer-nudge for a question that same
   * batch just consumed is now obsolete — left queued, it would drain as its own turn and trigger a
   * wasted empty `question_pull`. UNLIKE flushPending (which empties the WHOLE queue for a supersede), this
   * is a SELECTIVE filter: every entry whose `questionId` is not in the set — including unrelated nudges
   * and manager direction — keeps its slot and relative order untouched, exactly like deleteQueued leaves
   * every entry but the one it targets alone.
   *
   * SYNCHRONOUS BY CONSTRUCTION — only splices `live.pending` (no `await`, no submit(), no pty write), so
   * it never enters deliverHook's M2 lower-busy→drain window and can never observe or touch a message
   * that's already mid-drain: drainPending splices its own delivered run OUT of `live.pending` before this
   * could ever run concurrently (there is no interleaving point between them), so an entry is either still
   * here to be purged or already gone to delivery — never both. Returns the removed entries (onDeliver
   * included, mirroring flushPending) so the caller can resolve them; [] for a dead/unknown session, an
   * empty `questionIds`, or when nothing matched.
   */
  purgeQueuedByQuestionIds(sessionId: string, questionIds: readonly string[]): QueuedMessage[] {
    const live = this.live.get(sessionId);
    if (!live?.alive || questionIds.length === 0) return [];
    const ids = new Set(questionIds);
    const removed: QueuedMessage[] = [];
    for (let i = live.pending.length - 1; i >= 0; i--) {
      const m = live.pending[i]!;
      if (m.questionId != null && ids.has(m.questionId)) {
        removed.push(m);
        live.pending.splice(i, 1);
      }
    }
    return removed.reverse(); // restore original FIFO order (the scan walked back-to-front)
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

  /**
   * Clear a phantom 'busy' (busy with no engine output for a stale window) so its queue can drain.
   * A session that has NEVER started its first turn (`!firstTurnStarted`) uses the much SHORTER
   * FIRST_TURN_STALE_MS instead of `busyStaleMs` — there's no such thing as a legitimately long tool
   * call before turn 1 has even started, so stale output there already means broken (a lost kickoff
   * race the STARTUP_PROMPT_GRACE_MS fallback didn't recover, or an engine that never got past boot),
   * and it should surface via the onBusy→notifyManagerOfIdleWorker path fast rather than sit masked as
   * "busy" for the full 5-minute window. Once a real turn starts, the normal, more generous window applies.
   */
  private healIfStuck(live: Live, sessionId: string): void {
    const now = Date.now();
    const staleMs = live.firstTurnStarted ? this.busyStaleMs : FIRST_TURN_STALE_MS;
    if (live.busy && live.busySince != null
      && now - live.busySince > staleMs && now - live.lastOutputAt > staleMs) {
      // An OUT-OF-BAND busy clear (no Stop hook involved) — bump submitGeneration so a still-pending
      // sendEnterAndVerify chain for whatever turn this was recognizes it's stale and bails instead of
      // retry-Enter'ing (or give-up→setBusy(false)'ing) into whatever submits next. See submitGeneration.
      live.submitGeneration++;
      this.setBusy(sessionId, false);
    }
  }

  /**
   * Deliver queued messages when it's safe (idle + composer free). Shared by Stop + reconcile + the
   * markReady / box-free transitions.
   *
   * ONE-PER-TURN for AGENT messages, COALESCE for WARNING messages (owner-directed, 2026-07-03): a
   * queued entry's `kind` (see QueuedMessageKind) decides whether it may share a turn with its
   * neighbors. When `coalesceAgentMessages` is OFF (the default), an `"agent"`-kind head entry drains
   * ALONE — submit() re-arms busy SYNCHRONOUSLY (M1), so the NEXT agent message drains on the next Stop
   * hook (self-chaining); the reconcile timer is the backstop, so nothing is stranded. A `"warning"`-kind
   * head entry still coalesces the leading run of same-route WARNING entries exactly as before — Loom's
   * own operational nudges are safe to concatenate. A run NEVER mixes kinds: it stops at the first
   * differently-kinded entry (in addition to the existing route-key break), so a turn is either all-agent
   * (in practice always exactly one, since agent-kind never coalesces when the toggle is off) or
   * all-warning, never both.
   *
   * When `coalesceAgentMessages` is ON (legacy, opt-in via Settings), `kind` is ignored entirely and the
   * ENTIRE leading same-route run coalesces into ONE concatenated turn — byte-identical to the
   * pre-2026-07 behavior (splice the whole run, join with a visible separator, one submit, one busy
   * re-arm, one `\r`). This was the original motivation for full coalescing: shift()'ing ONE entry per
   * Stop meant 3 superseding manager redirects replayed one-at-a-time. That specific case is now handled
   * upstream by `flushPending` (worker_redirect retires stale queued direction before enqueueing the one
   * authoritative redirect), so at drain time there is normally at most one pending redirect and
   * one-per-turn agent delivery does not regress it.
   *
   * STILL one submit per drain in EITHER mode: the splice + concat + submit are SYNCHRONOUS in one tick,
   * so the load-bearing M1/M2 busy-gate invariants are untouched. Daemon-wide, no role special-casing.
   */
  private drainPending(sessionId: string): void {
    const live = this.live.get(sessionId);
    if (!live?.alive || !live.ready || live.busy || live.pending.length === 0) return;
    // A Stop is in flight → do NOT submit a queued turn. The interrupt lowers busy and fires a Stop
    // hook; draining here would re-arm busy and defeat the stop (the queued turn "fights" the stop —
    // each Ctrl-C just interrupts the freshly-drained turn, so it takes N escalating clicks to land).
    // stop() also clears the queue, so this is belt-and-suspenders for a late enqueue during the stop.
    if (live.stopping) return;
    // PARKED on a usage cap → do NOT drain. The turn died on the rate limit and the pty is held alive for
    // resumeAfterRateLimit to replay lastPrompt; draining here would submit() pending into the still-capped
    // account and OVERWRITE lastPrompt, so the agent would resume with the wrong content and never finish
    // the interrupted turn. The held queue is kept intact and drains normally on the post-resume Stop.
    if (live.rateLimited) return;
    if (this.deferForHumanDraft(live)) return; // HOLD while the human's raw composer is dirty — never land on half-typed text
    const head = live.pending[0]!;
    let drained: QueuedMessage[];
    if (!this.coalesceAgentMessages && head.kind === "agent") {
      // One-per-turn (default): an agent-authored message never shares a turn with anything else.
      drained = live.pending.splice(0, 1);
    } else {
      // ROUTE-KEYED coalescing (Loom Companion multi-channel): coalesce ONLY the LEADING run of pending
      // messages that share the FIRST entry's route key. Messages with NO route (the manager→worker direction
      // path, and every non-companion inject) all share the empty key, so they still coalesce ALL-TOGETHER —
      // byte-identical to the old splice(0). A DIFFERENT route breaks the run: it stays queued and drains as a
      // DISTINCT next turn on the next Stop. So EVERY turn has EXACTLY ONE originating route ⇒ chat_reply
      // resolves it unambiguously and cross-delivery is impossible by construction (no runtime check needed).
      // ALSO bounded to same-KIND entries (never mix a warning and an agent message into one turn) UNLESS
      // coalesceAgentMessages is on, in which case kind is ignored (today's legacy full-coalesce).
      const key = routeKeyOf(head.route);
      let n = 1;
      while (
        n < live.pending.length
        && routeKeyOf(live.pending[n]!.route) === key
        && (this.coalesceAgentMessages || live.pending[n]!.kind === head.kind)
      ) n++;
      drained = live.pending.splice(0, n); // the leading same-route (+ same-kind, unless toggled) run
    }
    this.submit(sessionId, drained.map((m) => m.text).join(DRAIN_SEPARATOR), drained[0]!.route, drained[0]!.ownerText); // one submit, one busy re-arm, FIFO order preserved, ONE route (+ ONE ownerText — the head's, mirroring the route)
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
      if (!live.alive || live.kind !== "claude") continue; // shells/canned entries have no busy/queue to heal or drain
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
   *
   * The Enter itself is NOT fire-and-forget (card 9549e322): a lone `\r` can land mid-ingest of a
   * large/coalesced paste, or get dropped outright by Windows ConPTY (the same class of drop already
   * documented for the boot Esc, card dacb8571) — either way the text strands un-submitted with busy
   * stuck true. `enterConfirmed` is reset to false here and `sendEnterAndVerify` re-sends the Enter on
   * a bounded verify/retry schedule until `UserPromptSubmit` (or a Stop, proving a turn ran) confirms
   * it, or gives up and recovers busy so the session doesn't wedge.
   */
  private submit(sessionId: string, text: string, route?: TurnRoute, ownerText?: string): void {
    const live = this.live.get(sessionId);
    if (!live?.alive) return;
    live.lastPrompt = text; // remember the in-flight turn so a usage-cap kill is recoverable (§19c-b)
    // Pin this turn's ORIGINATING route (Loom Companion), SYNCHRONOUSLY — before the async writeChunked, so
    // it's in place the instant the agent processes the turn and can chat_reply. null for every non-companion
    // turn (route undefined). `lastPromptRoute` mirrors `lastPrompt` so a rate-limit replay keeps the route.
    live.activeTurnRoute = route ?? null;
    live.lastPromptRoute = route ?? null;
    // Companion injection-guard Primitive A: pin the turn's literal owner text the SAME way — undefined for
    // every non-owner-authored caller (proactive/heartbeat/reminder/system inject), so activeTurnOwnerText
    // stays null exactly like activeTurnRoute does today. `lastPromptOwnerText` mirrors lastPromptRoute so a
    // rate-limit-killed companion turn's replay (resumeAfterRateLimit) still attests correctly.
    live.activeTurnOwnerText = ownerText ?? null;
    live.lastPromptOwnerText = ownerText ?? null;
    live.enterConfirmed = false; // this submit's Enter has not landed yet — see sendEnterAndVerify
    // NEW generation for THIS submit — the value sendEnterAndVerify's chain captures and checks on every
    // fire, so a chain left over from a PRIOR turn (already superseded by this fresh submit) recognizes
    // it's stale and bails instead of acting on this turn's `enterConfirmed`/`busy` state (CR-caught
    // overlap, card 9549e322 review — see the field doc on `Live.submitGeneration`).
    const gen = ++live.submitGeneration;
    live.pty.write(BRACKET_PASTE_START);
    // Chunk the text — a long turn (e.g. a worker report) sent as one pty.write is truncated by
    // ConPTY. Close the paste + send Enter only AFTER the last chunk lands, else it submits a partial.
    this.writeChunked(sessionId, text, () => {
      const l = this.live.get(sessionId);
      if (!l?.alive) return;
      l.pty.write(BRACKET_PASTE_END);
      const delay = SUBMIT_ENTER_DELAY_MS + pasteSettleExtraMs(text.length); // scale the first attempt's gap with paste size
      setTimeout(() => this.sendEnterAndVerify(sessionId, 1, gen), delay);
    });
    this.setBusy(sessionId, true); // M1: optimistic, SYNCHRONOUS — see the M1 INVARIANT note above. Keep last; keep sync.
  }

  /**
   * Write ONE Enter attempt, then wait `SUBMIT_VERIFY_TIMEOUT_MS` for confirmation (`enterConfirmed`,
   * set by deliverHook on `UserPromptSubmit`/`Stop`/`StopFailure`) before deciding what's next — the
   * verify-and-retry loop that closes card 9549e322 (a swallowed/dropped lone Enter strands the
   * composer with busy stuck true).
   *
   * `gen` is the `submitGeneration` this chain was scheduled under (captured once in `submit()`, threaded
   * through every recursive retry of the SAME submit). Every fire — the write AND the verify-timeout
   * callback — bails the instant `live.submitGeneration !== gen`: a NEWER submit() (or an out-of-band
   * busy-clear — healIfStuck / interruptForRedirect / stop, which all bump the generation too) means this
   * chain belongs to an ALREADY-SUPERSEDED turn, so its `enterConfirmed`/`busy` reads are meaningless for
   * whatever is live now — checking `enterConfirmed` alone is not enough (a fast turn can confirm+Stop
   * and a brand-new submit can reset `enterConfirmed` back to false WHILE this chain is still waiting,
   * which would otherwise read as "still unconfirmed" and retry-Enter into the new turn's window).
   *
   *  - Confirmed / stale generation / the session died by the time the wait elapses → stop, nothing more.
   *  - Not confirmed and attempts remain → log it (this IS the live validation the merge gate wants:
   *    it proves whether a real drop/swallow happened) and re-send `\r` for the next attempt.
   *  - Not confirmed and out of attempts → give up: log an error and recover busy (setBusy(false)) so
   *    the session is never left busy=true with an unsent composer forever. The composer may still hold
   *    the un-submitted paste in this rare give-up case (there is no way to un-paste it without reading
   *    back the TUI's screen state) — the NEXT turn would then concatenate onto that stray text rather
   *    than a clean composer. This is a deliberate trade-off (recovered-busy now vs. the old permanent
   *    wedge) — NOT auto-cleared here: a blind Ctrl-U could just as easily destroy a genuine, unrelated
   *    HUMAN draft the composer-dirty guard (`deferForHumanDraft`) would otherwise have protected (see
   *    card e1829591 — never destroy a user's uncommitted draft), and give-up doesn't re-check
   *    `composerLen` at the moment it fires. Left as a documented residual risk pending a follow-up.
   *
   * VALIDATED against a real claude engine (v2.1.206, card 9549e322 review item ②): forcing
   * SUBMIT_VERIFY_TIMEOUT_MS well below a normal UserPromptSubmit round-trip (so the retry ALWAYS fires a
   * real second Enter into an already-genuinely-submitted, still-generating turn) still produced exactly
   * ONE UserPromptSubmit + ONE Stop for the one logical turn sent — the redundant bare `\r` landing on the
   * by-then-empty, mid-generation composer is INERT (no stray blank turn, no corruption). A retry firing
   * into a turn that actually already started is therefore harmless; the real risk this loop guards
   * against is a retry NOT firing when the Enter genuinely never registered.
   */
  private sendEnterAndVerify(sessionId: string, attempt: number, gen: number): void {
    const live = this.live.get(sessionId);
    if (!live?.alive || live.enterConfirmed || live.submitGeneration !== gen) return;
    live.pty.write(ENTER);
    // eslint-disable-next-line no-console
    console.log(`[submit] ${sessionId} Enter attempt ${attempt}/${SUBMIT_MAX_ATTEMPTS} written — awaiting confirmation`);
    setTimeout(() => {
      const l = this.live.get(sessionId);
      if (!l?.alive || l.enterConfirmed || l.submitGeneration !== gen) return; // confirmed / stale generation / dead — nothing more to do
      if (attempt < SUBMIT_MAX_ATTEMPTS) {
        // eslint-disable-next-line no-console
        console.log(`[submit] ${sessionId} Enter attempt ${attempt} NOT confirmed within ${SUBMIT_VERIFY_TIMEOUT_MS}ms — retrying`);
        this.sendEnterAndVerify(sessionId, attempt + 1, gen);
      } else {
        // eslint-disable-next-line no-console
        console.error(`[submit] ${sessionId} gave up after ${attempt} Enter attempts — turn never confirmed started; recovering busy so the session doesn't wedge`);
        this.setBusy(sessionId, false);
      }
    }, SUBMIT_VERIFY_TIMEOUT_MS);
  }

  /**
   * §19c-b resume: re-submit the turn the usage cap killed (lastPrompt) once the reset passes. Goes
   * out via submit() (re-arms busy); the held pending queue then drains normally on the next Stop.
   * Returns false if the session isn't live (already stopped/killed → caller does not resume).
   */
  resumeAfterRateLimit(sessionId: string): boolean {
    const live = this.live.get(sessionId);
    if (!live?.alive) return false;
    // UNPARK: drop the suppress flag FIRST so the re-submitted turn (and the post-resume Stop drain of the
    // held queue) can proceed. submit() re-arms busy, so the reconcile drain stays no-op until that turn ends.
    live.rateLimited = false;
    // Replay the killed turn WITH its original route (lastPromptRoute) so a rate-limited companion inbound
    // still replies to the channel it came from after the reset (§19c-b + companion route routing). Also
    // replay its lastPromptOwnerText so Primitive A's attestation survives the kill-and-resume too.
    if (live.lastPrompt != null) this.submit(sessionId, live.lastPrompt, live.lastPromptRoute ?? undefined, live.lastPromptOwnerText ?? undefined);
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

  /** Read the current permission mode off the tail of a session's output ring (the repainted footer). */
  private readFooterMode(live: Live): LandedMode {
    const recent = Buffer.concat(live.ring.chunks).toString("utf8").slice(-8192);
    return detectPermissionMode(recent).mode;
  }

  /**
   * GENERAL permission-mode convergence primitive (card f05e4897, generalized off resume-only in card
   * b99d3d67) — used by BOTH a fresh spawn and a `--resume` to drive the footer to an ABSOLUTE `target`
   * mode. Both boot at the gate-free acceptEdits mode (`--resume` honours `--permission-mode` and does
   * NOT restore the persisted mode; probe-verified on 2.1.163), so both need the SAME climb off that boot
   * default. Rather than cycle a fixed COUNT (unreliable — a dropped/mistimed press half-lands mid-cycle
   * and stays there; that was the FRESH path's old blind `sendModeCycles`, and the resume/summary-gate
   * path's original blind approach before this), drive the footer to `target` ABSOLUTELY: read the mode,
   * and while it isn't the target press ONE Shift+Tab and then WAIT for the footer to actually CHANGE
   * before deciding again — so a laggy repaint can never trick us into over-pressing past the target. The
   * per-step decision is the pure `nextCycleAction`; this method only supplies the timing + the footer
   * reads (the real-claude probe validates the live sequencing).
   *
   * BOUNDED + GRACEFUL — it NEVER infinite-loops and NEVER wedges boot: every terminating branch (reached
   * the target / hit the press cap / footer unreadable / a press didn't move the footer / pty gone) calls
   * `onDone` exactly once (markReady), so queued injections are released only AFTER the mode settles.
   * Total time is sized to finish well under READY_FALLBACK_MS so the readiness fallback can't fire
   * mid-cycle. A give-up branch can, in a rare worst case, leave the session resting in an intermediate
   * mode (incl. `plan`) rather than the target — `logLandedMode`'s role-gated auto-heal is the backstop
   * that catches a Loom-driven role (no `ExitPlanMode` tool) left stranded there; this primitive itself is
   * intentionally unchanged behaviour for the resume caller (do not add path-specific corrections here).
   */
  private cycleToMode(sessionId: string, target: LandedMode, onDone: () => void): void {
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
    this.scheduleKickoffGuarantee(sessionId); // force the kickoff in if the CLI's own auto-submit never lands (no-op for resume/fork — see below)
    this.drainPending(sessionId); // deliver the first queued injection now that the composer is live
    this.logLandedMode(sessionId); // record the landed mode + the role-gated plan auto-heal backstop
  }

  /**
   * KICKOFF GUARANTEE — see the STARTUP_PROMPT_GRACE_MS doc comment for the full race being closed.
   * Called exactly once per session from markReady (which itself only proceeds once, guarded by
   * `live.ready`), so this schedules at most one grace-window check per (re)spawn.
   *
   * Fires for EVERY positional-arg spawn, not just a fresh worker_spawn: `live.lastPrompt` is seeded
   * from `opts.startupPrompt` at spawn (see spawn()), and recycleWorker/recycleManager/the platform-lead
   * recycle ALL pass a real handoff prompt through that SAME positional-arg path (a fresh startup-prompt
   * spawn, deliberately not `--resume`, so the recycled session doesn't drag the old context forward) —
   * so a recycled session's handoff is just as exposed to the CLI's own lost-auto-submit race as a fresh
   * spawn's kickoff, and the guarantee correctly covers it too. A run session's startup prompt
   * (composeRunStartupPrompt) rides the same path and is covered the same way.
   *
   * A no-op ONLY for resume and fork: neither ever passes `opts.startupPrompt` (a resume's continuation
   * is injected via enqueueStdin post-boot, not a CLI-arg turn — and boot-reconcile's resume path is
   * covered by the SAME resume mechanics, not this one), so `lastPrompt` stays null there and this
   * returns immediately, leaving their behavior byte-identical. Also a no-op if the turn already started
   * (firstTurnStarted) by the time markReady lands — the common, healthy case.
   */
  private scheduleKickoffGuarantee(sessionId: string): void {
    const live = this.live.get(sessionId);
    if (!live?.alive || live.lastPrompt == null || live.firstTurnStarted) return;
    const kickoff = live.lastPrompt; // capture NOW — a later unrelated drain must not change what we replay
    setTimeout(() => {
      const l = this.live.get(sessionId);
      if (!l?.alive || l.firstTurnStarted) return; // the CLI's own auto-submit landed in time — no-op
      // eslint-disable-next-line no-console
      console.log(`[pty] ${sessionId} startup-prompt grace elapsed with no turn started — force-submitting the kickoff`);
      this.submit(sessionId, kickoff);
    }, STARTUP_PROMPT_GRACE_MS);
  }

  /**
   * OBSERVABILITY + defense-in-depth plan auto-heal (card f05e4897 / b99d3d67 / 1658fc22) — record, to
   * the daemon log, what permission mode a (re)spawned session actually LANDED in once it settled
   * (mode-cycles/gate handling done + markReady), and — the auto-heal — if a Loom-DRIVEN role with
   * `ExitPlanMode` disallowed (any role `disallowedToolsForRole` disallows it for — worker, setup,
   * auditor, workspace-auditor, run, assistant) is found resting in `plan`, drive it off plan via the
   * SAME feedback-verified `cycleToMode` primitive the main convergence path uses (target `auto`), not a
   * single blind press. `plan` is the one landed mode such a role can NEVER self-exit (its `ExitPlanMode`
   * tool is structurally removed at spawn), so a session stranded there — by either cycleToMode's rare
   * give-up-mid-cycle worst case, or anything else that ever leaves it in plan — would otherwise sit
   * inert forever. A single blind corrective press has the same drop risk as the failure it's healing
   * (card 1658fc22): if IT also drops under load, the session stays stranded with no further retry.
   * Routing through cycleToMode instead reads the footer and retries (bounded) until it's off plan or the
   * pty dies, exactly like the main path — so a dropped press just costs one more poll, not a permanent
   * strand. This is a BACKSTOP, independent of cycleToMode's own convergence logic invoked from the main
   * SessionStart path (which stays unchanged for that caller — see cycleToMode's doc comment): it fires
   * off the mode ACTUALLY read from the footer, regardless of why the session ended up there. A
   * manager/platform session is structurally excluded (`disallowedToolsForRole` never puts `ExitPlanMode`
   * in their list — they may separately carry the task-tracking disallow, which this check ignores), so
   * this never fights a manager's legitimate, human-approved entry into plan mode.
   *
   * Best-effort + bounded: polls the ring (the existing rolling output buffer) a few times to let the
   * footer repaint into its final state, logs as soon as a mode is read (or gives up at the cap, logging
   * mode=unknown — no correction is attempted without a definite read), and corrects at most once per
   * session (modeLogged guard, claimed up front, so a repeat markReady never re-triggers the heal even
   * mid-cycle). Shells are excluded. `cycleToMode` is itself bounded (see its doc comment), so the whole
   * heal — this poll-for-a-read plus the cycle — stays comfortably under READY_FALLBACK_MS.
   */
  private logLandedMode(sessionId: string): void {
    const live = this.live.get(sessionId);
    if (!live || live.kind !== "claude" || live.modeLogged) return;
    live.modeLogged = true; // claim it once, up front — a repeat markReady won't re-schedule this
    const isResume = live.isResume;
    const role = live.role;
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
      if (mode === "plan" && l.alive && disallowedToolsForRole(role).includes("ExitPlanMode")) {
        // eslint-disable-next-line no-console
        console.log(`[resume-mode] ${sessionId} auto-heal: role=${role ?? "-"} landed in plan (ExitPlanMode disallowed) — cycling off plan`);
        this.cycleToMode(sessionId, "auto", () => {});
      }
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
    // Bump the generation so a still-pending sendEnterAndVerify chain from whatever turn was in flight
    // recognizes it's stale and bails — the `alive` guard alone isn't enough during the graceful window
    // (the pty stays alive through escalateGracefulStop), and a stray retry-Enter or give-up→setBusy(false)
    // during a deliberate stop serves no purpose. See Live.submitGeneration.
    live.submitGeneration++;
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
    // We are deliberately abandoning this turn's Enter — bump the generation so a still-pending
    // sendEnterAndVerify chain for it recognizes it's stale and bails (never retry-Enters or
    // give-up→setBusy(false)'s into the cancelled prompt or whatever the redirect submits next). See
    // Live.submitGeneration.
    live.submitGeneration++;
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

  /**
   * Manager-driven ABSOLUTE mode override (worker_set_mode, card 610abe29) — the manual belt-and-suspenders
   * complement to `cycleToMode`'s automatic spawn/resume convergence and `logLandedMode`'s plan auto-heal:
   * lets a manager recover a worker stuck in (or deliberately push it into) a permission mode directly,
   * since a worker can never change its own mode itself (Shift+Tab is a human TUI keystroke; ExitPlanMode/
   * EnterPlanMode are disallowed for a worker). Reuses `cycleToMode` VERBATIM — same press-and-wait-for-
   * change feedback loop, same bounds — so a manual override behaves identically to the automatic paths;
   * this does not hand-roll its own keystroke cycling. Resolves with the FEEDBACK-VERIFIED landed mode read
   * fresh off the footer once the cycle settles (which may differ from `target` if it gave up early — the
   * caller sees the truth, not an assumed success), or "unknown" if the session isn't live.
   */
  setPermissionMode(sessionId: string, target: LandedMode): Promise<LandedMode> {
    return new Promise((resolve) => {
      if (!this.live.get(sessionId)?.alive) { resolve("unknown"); return; }
      this.cycleToMode(sessionId, target, () => {
        const live = this.live.get(sessionId);
        resolve(live?.alive ? this.readFooterMode(live) : "unknown");
      });
    });
  }

  isAlive(sessionId: string): boolean {
    return this.live.get(sessionId)?.alive ?? false;
  }

  /** The OS pid of this session's own pty process, or undefined if it isn't live. Lets a caller that's
   *  about to reap OTHER processes rooted in this session's cwd (e.g. a pre-gate worktree sweep) exclude
   *  the session's own still-live process from that sweep — see {@link reapProcessesRootedInWorktree}'s
   *  `excludePids`. */
  getPid(sessionId: string): number | undefined {
    return this.live.get(sessionId)?.pid;
  }

  /** Epoch ms of this session's last pty OUTPUT chunk (`Live.lastOutputAt`), or undefined if it isn't
   *  live. Distinct from the DB-persisted `lastActivity` (which only moves at turn boundaries — hook
   *  events): this advances on EVERY engine-output chunk, so it keeps moving THROUGH a single long turn
   *  and only goes stale once the engine truly stops producing — already fed to the busy-stale self-heal
   *  (see `healIfStuck`'s use of `lastOutputAt`); this getter just surfaces the same signal to a reader
   *  (worker_list/worker_status) so a manager can tell "busy + progressing" from "possibly wedged" without
   *  spending a worker_transcript pull. */
  getLastOutputAt(sessionId: string): number | undefined {
    return this.live.get(sessionId)?.lastOutputAt;
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
