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
import { meetsMinVersion } from "./session-name.js";
import { getCachedClaudeVersion } from "../orchestration/usage-status.js";
import { writeSessionSettings, writeSessionMcpConfig } from "./claude-settings.js";
import { ensureTrusted } from "./claude-config.js";
import { injectSkills } from "../skills/inject.js";
import { readContextStats, type ContextStats } from "../sessions/context.js";
import { detectUsageLimit, isWeeklyUsageLimitSentinel, rateLimitedUntil } from "../orchestration/usage-limit.js";
import { detectBarePastePlaceholderTripwire } from "../orchestration/paste-tripwire.js";
import { PORT, LOGS_DIR, ENSURE_OBSIDIAN_SCRIPT, sessionScratchDir, isLoomDev, isCodescapeSupervisorEnabled } from "../paths.js";
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
 * Card 1bd1f045: cheap, non-cryptographic 32-bit FNV-1a content fingerprint for the `[pty-write]` write-
 * sequence log (see `ptyWrite`). O(n) over a SINGLE write call's data — bounded at PTY_WRITE_CHUNK_BYTES
 * for a chunk (a few KB, never the full 15KB+ turn), so it stays cheap on the hot path. Not collision-
 * proof and doesn't need to be: two `[pty-write]` records sharing (len, hash) at distinct `seq` on the
 * same session is a duplicate CANDIDATE for a human/script to correlate, not a courtroom proof — an
 * accidental collision between two genuinely DIFFERENT writes on the same session is astronomically
 * unlikely for real terminal-write content at this volume. Chosen over a head/tail excerpt (this card's
 * first draft) purely for size: fixed 8 hex chars regardless of payload length, versus ~80-90 bytes of
 * quoted excerpt — material at 17 write sites logging on every session's hot path against a rotating,
 * forensically-relied-on daemon-output.log (see ptyWrite's doc for the measured before/after).
 */
function fnv1a32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
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
 * Card 441499ee: how many times a single message may be put back on `live.pending` after a GIVE-UP
 * RECOVERY before it's dropped for real (with a loud log) instead of requeued again. Requeueing converts
 * a silent drop into delayed delivery, but an UNBOUNDED requeue would let a message that keeps hitting a
 * structurally-broken session (not just a transient contention burst) loop forever — worse than the
 * original drop. One requeue is enough to ride out a contention-driven burst (give-ups cluster where the
 * daemon is already busy, per the measurement on this same card) without risking an infinite retry loop.
 */
const GIVE_UP_REQUEUE_LIMIT = Number(process.env.LOOM_GIVE_UP_REQUEUE_LIMIT) || 1;

/**
 * Card b64b3726: bounded poll for the GIVE-UP attempt's own paste-reassert (`BRACKET_PASTE_START +
 * BRACKET_PASTE_END`, written by `sendEnterAndVerify` on every `attempt > 1`) to settle BEFORE writing
 * that attempt's Enter and capturing `enterWrittenAt` — see `awaitReassertSettle`. Mirrors this file's
 * existing `RESUME_MODE_READ_POLL_MS`/`RESUME_MODE_CHANGE_MAX_POLLS` poll-count convention (observe, don't
 * guess, but stay bounded).
 *
 * SIZED FROM A MEASURED DISTRIBUTION, not guessed (real `claude` engine, card b64b3726 probes — see
 * `test/_probe-empty-paste-provocation.mjs` for the base finding). The re-assert alone reliably provokes a
 * deterministic 16-byte TUI response (a keyboard-protocol renegotiation) — but only INTERMITTENTLY at
 * production's actual retry cadence (~900ms between reasserts): a cadence-matched probe found it lands
 * inside its own attempt's verify window in ~13-20% of give-ups, not "always" (an earlier, wider-spaced
 * probe had wrongly suggested "always" — see that finding's own correction note for why probe CADENCE has
 * to match the thing being measured). When it DOES fire, latency across n=10 pooled real-engine samples was
 * bimodal: 8/10 (80%) landed in 1.15-7.65ms, 2/10 (20%) landed at 820.96/1367.94ms. `REASSERT_SETTLE_MAX_POLLS`
 * × `REASSERT_SETTLE_POLL_MS` ≈ 300ms therefore catches the fast majority with wide margin and deliberately
 * accepts the slow tail as a residual — a slow-arriving response can still land after this bound and cause a
 * suppress on THIS attempt, same as before this fix. That residual is acceptable ONLY because `healIfStuck`
 * (card b64b3726 Half 2) backstops the consequence regardless of which vector caused the suppression — if
 * that backstop is ever removed, this bound needs re-deriving against a fuller sample, not just widened.
 * If a future re-measurement shows the fast group is no longer the majority, THIS bound is the wrong one to
 * keep — don't just halve it, re-derive it from a fresh distribution.
 */
const REASSERT_SETTLE_POLL_MS = Number(process.env.LOOM_REASSERT_SETTLE_POLL_MS) || 15;
const REASSERT_SETTLE_MAX_POLLS = Number(process.env.LOOM_REASSERT_SETTLE_MAX_POLLS) || 20;

/**
 * Card 441499ee (hardening against the give-up discriminator's own measured false-negative rate — card
 * 04de8bbf, n=84: ~86% of give-ups that reach this point are followed by a confirming hook, i.e. the turn
 * actually started; only ~14% are genuine drops). A SHORT, bounded, OBSERVED wait for `enterConfirmed` to
 * flip true, inserted right where the output-based discriminator has ALREADY failed to suppress a give-up
 * — see `awaitGiveUpConfirmSettle`. Modeled on `REASSERT_SETTLE_POLL_MS`/`_MAX_POLLS`'s own shape and
 * accept-a-residual philosophy, but kept as an INDEPENDENT constant pair: that one is sized against a
 * measured LOCAL terminal-protocol renegotiation latency (a completely different, much faster mechanism
 * than an actual hook round-trip), so reusing it here would smuggle in an unmeasured assumption.
 *
 * DELIBERATELY NOT sized to cover the full hook-confirmation latency distribution — give-ups are
 * CONTENTION-DRIVEN BURSTS (see SUBMIT_VERIFY_TIMEOUT_MS's own REJECTED ALTERNATIVE note), so a bound wide
 * enough to reliably catch a contention-delayed hook would have to keep growing to chase wherever fleet
 * contention peaks next — the exact anti-pattern this project has reverted twice (cards 595aad10,
 * fea23514). This is a SHORT last-chance check that only claims to catch the FASTEST-confirming subset of
 * the 86% for free (zero requeue, zero purge race, ever, for those); anything slower still falls through to
 * GIVE-UP RECOVERY's existing requeue, with `purgeConfirmedGiveUpRequeue` as the defense-in-depth for a
 * confirmation that arrives later still, before the requeued entry has actually drained. Closing the gap
 * further needs the discriminator itself fixed (04de8bbf), not a bigger constant here.
 */
const GIVE_UP_CONFIRM_SETTLE_POLL_MS = Number(process.env.LOOM_GIVE_UP_CONFIRM_SETTLE_POLL_MS) || 15;
const GIVE_UP_CONFIRM_SETTLE_MAX_POLLS = Number(process.env.LOOM_GIVE_UP_CONFIRM_SETTLE_MAX_POLLS) || 20;

/**
 * A single large `pty.write` is truncated by Windows ConPTY's input buffer — observed as long
 * worker reports and pastes arriving cut off in the receiving session. Split big writes into
 * paced chunks so the console host drains between them. Keystroke-sized writes take one chunk.
 */
// Env-overridable (test-only seam, mirrors STARTUP_PROMPT_GRACE_MS et al. below): a hermetic test can
// shrink the chunk size / widen the delay to make a multi-chunk writeChunked() chain span a wide,
// deterministic window instead of relying on production-sized timing — see pty-restart-nudge-atomicity.mjs.
const PTY_WRITE_CHUNK_BYTES = Number(process.env.LOOM_PTY_WRITE_CHUNK_BYTES) || 1024;
const PTY_WRITE_CHUNK_DELAY_MS = Number(process.env.LOOM_PTY_WRITE_CHUNK_DELAY_MS) || 8;

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
/** Down/Up arrow (CSI B / CSI A) — move the selection in Claude's TUI menus. */
const DOWN_ARROW = "\x1b[B";
const UP_ARROW = "\x1b[A";
const ENTER = "\r";
const ESC_KEY = "\x1b";
/** Backspace/DEL — used to surgically un-type a give-up'd injection char-by-char (see sendEnterAndVerify). */
const BACKSPACE = "\x7f";
/** Strip CSI sequences so the boot-output scan matches the MCP prompt's words across TUI styling. */
const ANSI_CSI = new RegExp(ESC_KEY + "\\[[0-9;?]*[ -/]*[@-~]", "g");
const collapseBoot = (s: string): string => s.replace(ANSI_CSI, "").replace(/\s+/g, "");

/** Settle window before the ONE Down press on the resume-summary gate (let its initial render finish
 *  painting before we read/press anything — mirrors MODE_CYCLE_SETTLE_MS's rationale). */
const RESUME_GATE_SETTLE_MS = 300;
/** Poll cadence + total budget while waiting for the ❯ cursor to confirm the (single) Down landed on
 *  option 2 (resolveResumeGate). Exactly ONE Down is ever written for the confirm loop itself — a retry
 *  that re-presses Down while an earlier, merely-SLOW (not dropped) press is still in flight would
 *  overshoot the cursor 1→2→3, landing on "Don't ask me again" (a code-review catch, card c7353d24
 *  follow-up: persists the gate-disable AND still compacts this turn — worse than the bug this fix
 *  exists to kill). So the budget is GENEROUS (not a tight per-press window) rather than retried —
 *  bounded so a genuinely wedged/garbled gate can't poll forever, but sized to let one slow render land.
 *  Env-overridable so the hermetic test drives the whole confirm loop in milliseconds (mirrors
 *  RESUME_MODE_*). */
const RESUME_GATE_POLL_MS = Number(process.env.LOOM_RESUME_GATE_POLL_MS) || 150;
const RESUME_GATE_MAX_POLLS = Number(process.env.LOOM_RESUME_GATE_MAX_POLLS) || 20;

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
 * Which option the resume-summary gate's ❯ cursor currently sits on — "1" (still the default, "Resume
 * from summary"), "2" (the target, "Resume full session as-is"), "3" ("Don't ask me again"), or `null`
 * if unreadable (the frame hasn't painted the cursor yet, or the gate isn't on screen). PURE + exported
 * for the hermetic test. `collapseBoot` strips ANSI but does NOT insert separators between lines (it
 * collapses whitespace to nothing), so a rendered "❯ 2. Resume full session as-is" flattens to
 * "❯2.Resumefullsessionas-is" — the cursor glyph sits immediately against the option's leading digit.
 *
 * This is what lets `resolveResumeGate` CONFIRM a Down press actually landed before risking Enter,
 * closing the 2026-07-10 incident: the old handler wrote a blind, unverified Down+Enter pair, and under
 * restart load the Down was delayed/reordered past the Enter — which then confirmed the still-default
 * option 1, silently compacting the manager's full context (3-for-3 simultaneously, a systematic race,
 * not a random dropped keystroke).
 *
 * Takes the LAST `❯N.` match, not the first: `resumeGateScan` is a CUMULATIVE rolling buffer (each
 * re-render is appended, not substituted — the TUI repaints via cursor-repositioning escapes that
 * `collapseBoot` strips, leaving every prior frame's text still concatenated in front of the current
 * one), so only the most recent occurrence reflects the gate's current state. Same "last occurrence
 * wins" reasoning as `detectPermissionMode`'s footer-mode `lastIndexOf` scan above.
 */
export function resumeGateCursorOption(flatCollapsed: string): "1" | "2" | "3" | null {
  const matches = [...flatCollapsed.matchAll(/❯(\d)\./g)];
  const digit = matches.at(-1)?.[1];
  return digit === "1" || digit === "2" || digit === "3" ? digit : null;
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
/**
 * The INVERSE of {@link modeAfterCyclesFromAcceptEdits}: how many blind Shift+Tab presses from the
 * gate-free `acceptEdits` boot mode land on `target`. Lets a caller pin a session's boot-cycle target to
 * a SPECIFIC mode (e.g. a worker's structural `auto` default — card 760cd01d) without hand-copying the
 * cycle-order index, so a future change to {@link ACCEPT_EDITS_CYCLE_ORDER} can't silently desync the two.
 * `target` not found in the cycle (e.g. `bypassPermissions`/`unknown`, never reachable by this cycle) ⇒ 0
 * (stay at the gate-free boot mode) rather than throwing — mirrors `modeAfterCyclesFromAcceptEdits`'s own
 * fail-safe `?? "acceptEdits"` fallback.
 */
export function cyclesToReachFromAcceptEdits(target: LandedMode): number {
  const idx = ACCEPT_EDITS_CYCLE_ORDER.indexOf(target);
  return idx === -1 ? 0 : idx;
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
 * `logLandedMode`'s auto-heal trigger set (card 9c03f5a6) — every DEFINITE `LandedMode` reading short of
 * the session's own configured target (`auto` for the platform default). Deliberately an explicit
 * enumeration, not `mode !== target`: the latter would also match `"unknown"` (no footer could be read at
 * all), breaking the heal's load-bearing invariant that no correction is EVER attempted without a
 * definite read. `"unknown"` is excluded by construction here, not by a separate runtime check.
 */
const HEALABLE_MODES: ReadonlySet<LandedMode> = new Set(["plan", "acceptEdits", "default", "bypassPermissions"]);
/**
 * `setPermissionMode` (worker_set_mode) outer retry bound (card 9c03f5a6) — how many FULL cycleToMode
 * passes to attempt, each starting from a fresh footer read, before giving up and reporting the true
 * landed mode. 1 = the raw single-pass behaviour; >1 self-corrects a genuinely dropped keystroke (a press
 * whose footer repaint never registered within one pass's own change-wait cap) without the caller having
 * to notice a miss and retry by hand.
 */
const MODE_OVERRIDE_MAX_ATTEMPTS = Number(process.env.LOOM_MODE_OVERRIDE_MAX_ATTEMPTS) || 3;
/**
 * Readiness fallback. SessionStart normally flips a (re)spawned session to `ready` (after the
 * mode-cycles land). If that hook never arrives, don't strand a queued boot injection forever —
 * mark ready after this grace so the message still drains. Env-overridable so tests don't wait 20s.
 */
const READY_FALLBACK_MS = Number(process.env.LOOM_READY_FALLBACK_MS) || 20_000;

/**
 * Card df5e37e7: bound on waitForMcpSeen — how long a deferred resume-continuation nudge (see
 * sessions/service.ts resumeFleetOnBoot / recoverCrashOrphanedWorkers) waits for the CLI's own
 * loom-orchestration MCP handshake to reach us (markMcpSeen) before giving up and delivering the nudge
 * anyway (today's behavior — the possible "not connected" race, not a wedge). Comfortably under
 * READY_FALLBACK_MS (20s): a normal MCP HTTP handshake is sub-second, so this only needs to absorb
 * fleet-wide restart contention, not stand in as a second readiness fallback. Env-overridable so tests
 * don't wait out the default.
 */
const MCP_READY_TIMEOUT_MS = Number(process.env.LOOM_MCP_READY_TIMEOUT_MS) || 9_000;

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
 * Companion injection-guard Primitive A widening (card 2b26035c): how many RECENT authenticated
 * owner-turns `Live.recentOwnerTurns` retains for a "recent-turns verbatim acceptance" check. Small and
 * bounded on purpose — wide enough to cover a cross-turn correction/re-phrase in the SAME live exchange
 * (owner: "Creative projects…" → owner: "no, creating…") without widening "recent" into "anything the
 * owner ever said in this conversation", which would erode the guard's whole point.
 */
const RECENT_OWNER_TURNS_WINDOW = 5;

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
 * path OUTSIDE both roots is DENIED, not just "unaffected". **A caller-supplied RELATIVE/bare filename is
 * the footgun, not a safe third case**: traced against the pinned `@playwright/mcp@0.0.75` bundle
 * (`playwright-core`'s `Response.resolveClientFile` → `resolveClientFilename` → `context.workspaceFile`),
 * a supplied filename — even a bare one — resolves against `context.options.cwd` (the worktree/repo root),
 * NOT `outputDir`; only the OMIT-filename default path goes through `context.outputFile()`/`outputDir`.
 * So a bare `browser_take_screenshot({ filename: "foo.png" })` silently lands in the repo root, not scratch
 * — `checkFile` allows it (cwd is one of its two roots) rather than denying it. This is baked into
 * playwright-core's bundled classes; no `Config` field or CLI flag redirects it, so it is NOT something
 * Loom's spawn config can fix — omit the filename (auto-names into `outputDir`) or pass an absolute path
 * under `LOOM_SCRATCH_DIR` (see `browserScratchEnv` below) to actually land in scratch. `outputDir` also
 * governs the DEFAULT (implicit,
 * no-filename) artifact for every snapshot-bearing tool response, not just an explicit screenshot — the
 * MCP's default `snapshot.mode` writes the page's ARIA snapshot to `page-{timestamp}.yml` in `outputDir`
 * on essentially every browser tool call, so `outputDir` is a HIGH-FREQUENCY write target, not an
 * occasional one (card 61ab62e3: this is why an earlier `outputDir = vaultPath` default littered the
 * user's Obsidian vault with `page-*.yml` on every browser turn — `buildMcpServers` now always passes the
 * scratch dir, never the vault). Omit `outputDir` and the flag is absent (byte-identical to the
 * pre-output-dir spawn) — the caller (`buildMcpServers`) always supplies a dir.
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
 * Card 088afc94 (P4 wiring) — the streamable-HTTP MCP-config entry for a codescape-enabled session,
 * pointed at the SHARED `codescape serve` process (`/mcp/<codescapeId>` for a manager, or
 * `/mcp/<codescapeId>/<worktreeId>` for a worker tied to a task — codescape confirmed this route is the
 * STABLE long-term interface: it serves the project's main graph today and will serve worktree-adjusted
 * overlay content through this SAME URL once that ships, so this is not a placeholder to "simplify" back
 * to the bare route later). Returns `null` — a CLEAN SKIP, never a stale/absent fallback (Platform Lead
 * ruling on this card: silent staleness was the ORIGINAL defect, and a stdio-snapshot fallback would
 * silently reproduce exactly that) — when `port` is null (serve isn't up: disabled, never started, mid-
 * restart, or gave up) or when `resolveProjectId` can't resolve an id for `repoPath` (never registered).
 * `resolveProjectId` should be the SAME supervisor instance's `resolveProjectId` (its own boot-
 * registration cache first, falling back to the cold manifest read — see codescape/supervisor.ts) — kept
 * as an injected function (not a raw homeDir) so this stays a pure, hermetically-testable seam and so
 * every caller shares the ONE id-resolution strategy in one place.
 *
 * PRIOR-ATTEMPT NOTE: an EARLIER HTTP-mount attempt was abandoned because it scoped by Loom's own
 * project.id, which never matched codescape's OWN path-derived id — the MCP never registered, silently.
 * Resolving via `resolveProjectId` (never a reimplemented hash) is what fixes that class of bug for good.
 */
export function codescapeHttpMcpServer(opts: { repoPath: string; port: number | null; worktreeId?: string | null; resolveProjectId?: (repoPath: string) => string | null }): { type: "http"; url: string } | null {
  if (opts.port == null || !opts.resolveProjectId) return null;
  const id = opts.resolveProjectId(opts.repoPath);
  if (!id) return null;
  const scope = opts.worktreeId ? `${id}/${opts.worktreeId}` : id;
  return { type: "http", url: `http://127.0.0.1:${opts.port}/mcp/${scope}` };
}

/**
 * Assemble the `--mcp-config` mcpServers map for a Claude spawn (extracted from createPty as the ONE
 * testable seam for the MCP surface). ALWAYS the project-scoped `loom-tasks` HTTP server; PLUS the
 * role-gated surface (manager/worker → loom-orchestration, platform → loom-platform, auditor → loom-audit,
 * workspace-auditor → loom-user-audit, setup → loom-setup);
 * PLUS — one generalized capability-registry loop (agent-tooling P4) that mounts EVERY resolved
 * registry-capability grant (`resolveProfileCapabilities(o)`, bridging the legacy `browserTesting`/
 * `documentConversion` booleans + the new `capabilities` array into ONE list). The legacy
 * slugs ("browser-testing"/"document-conversion") are special-cased to their EXISTING,
 * already-hardened resolvers (`playwrightMcpServer`/`markitdownMcpServer`, untouched) so
 * this generalization is byte-identical for every caller that still passes the booleans directly (every
 * existing test + call site) — the mounted map keys stay "playwright"/"markitdown" exactly as
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
  sessionId: string; port: number; role?: SessionRole; browserTesting?: boolean; documentConversion?: boolean;
  /** HUMAN-only `python.interpreterPath` (carried via session env) — forwarded to the markitdown venv resolver. */
  pythonInterpreterPath?: string;
  /** Agent-tooling P4: registry-capability grants BEYOND the two legacy booleans above (raw, un-bridged —
   *  see resolveProfileCapabilities). Default []. */
  capabilities?: CapabilityGrant[];
  /** Owner-added capability catalog rows (injected, never a live db handle) — looked up by slug for any
   *  grant that isn't one of the two reserved legacy slugs. Default []. */
  capabilityCatalog?: CapabilityDefRow[];
  /** Resolve a P1 connection id to its DECRYPTED secret (injected callback, never a live db handle) —
   *  consulted only for a grant whose def has `requiresConnection` AND that carries a `connectionId`.
   *  Passed THIS spawn's own `projectId` (below) so a project-scoped connection (card f2abce7e) only ever
   *  resolves for the project it's bound to — the callback fails closed on a scope mismatch. */
  resolveConnectionSecret?: (connectionId: string, projectId?: string) => string | undefined;
  /** Card C2: the project's raw `codescape.enabled` flag — see the "codescape" mount below. */
  codescapeEnabled?: boolean;
  /** Card C2: the session's project id (non-Codescape uses only, e.g. connection-secret scoping). */
  projectId?: string;
  /**
   * Card 088afc94 (P4 wiring): the project's PRIMARY repo path, `codescapeSupervisor.getPort()`, and
   * `codescapeSupervisor.resolveProjectId` (bound to that instance) — the three ingredients
   * `codescapeHttpMcpServer` needs to resolve codescape's OWN project id and build the streamable-HTTP
   * mount URL. `worktreeId` scopes a worker's mount to its own worktree route; absent for every other
   * role. See SpawnOpts's identical fields for the full doc.
   */
  repoPath?: string;
  codescapePort?: number | null;
  codescapeResolveProjectId?: (repoPath: string) => string | null;
  worktreeId?: string | null;
  /**
   * Card 8dc5ebb9: DB-persisted host-tool integration paths (`PlatformConfigOverride.integrations`) —
   * resolved PER-SPAWN (not boot-bound) via PtyHost's `getIntegrationPaths` seam, consulted ONLY for the
   * daemon-wide `isCodescapeSupervisorEnabled` gate check below (DB path wins, env var falls back). No
   * longer feeds a bin-resolution call — the per-session mount is a URL now, not a spawn.
   */
  integrationPaths?: { codescape?: string };
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
  const wantsOperator = o.role === "operator";
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
  // Bucket 2b Elevated Operator: an "operator" session gets ONLY the curated loom-operator surface (on
  // top of loom-tasks) — NEVER loom-platform/orchestration/audit/setup. A tool not registered there can't
  // be reached. The router ITSELF re-checks platform.operatorEnabled LIVE (isOperatorEnabled) on every
  // request, so this mount alone is not the enforcement point — a flag flip to OFF 404s the surface even
  // though the mount entry (an inert URL) still exists in this session's already-spawned argv.
  if (wantsOperator) {
    mcpServers["loom-operator"] = { type: "http", url: `http://127.0.0.1:${o.port}/mcp-operator/${o.sessionId}` };
  }
  // Agent-tooling P4: ONE generalized loop over every resolved registry-capability grant (the bridged
  // legacy booleans + the new capabilities array). byte-identical-when-none: an empty resolved list is a
  // no-op, so this whole block vanishes for a spawn with nothing enabled — exactly today's map.
  const catalog = o.capabilityCatalog ?? [];
  for (const grant of resolveProfileCapabilities(o)) {
    if (grant.slug === "browser-testing") {
      // The Playwright capability: capture output ALWAYS defaults to a repo/vault-EXTERNAL per-session
      // scratch dir, so a screenshot (or the ARIA `page-*.yml` snapshot the MCP writes by default on
      // essentially every browser tool call) taken with no explicit path can never land inside the project
      // working tree OR the user's Obsidian vault. Card 61ab62e3: an earlier revision pointed `--output-dir`
      // at the project's `vaultPath` when set, meaning every implicit browser turn wrote a `page-*.yml`
      // straight into the vault — the vault got treated as a dumping ground, not just a deliberate
      // milestone-shot target. Always scratch closes that; the trade-off (documented on
      // `playwrightMcpServer` above) is that an agent can no longer target an explicit absolute vault path
      // either, since `@playwright/mcp`'s `checkFile` guard only allows a write inside `outputDir` or the
      // subprocess's inherited cwd — a session that wants a capture preserved as a project artifact should
      // land it in scratch and have it copied into the vault explicitly, not written there directly. A null
      // (unresolvable package) is logged + skipped rather than crashing the spawn.
      const pw = playwrightMcpServer(sessionScratchDir(o.sessionId));
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
    // An owner-added catalog capability: look it up in the injected catalog, resolve its bound
    // connection's secret (if it requiresConnection and a connectionId was granted), and dispatch
    // through the generic node-package/python-venv/bundled resolver. Unknown slug / unresolvable
    // provisioning ⇒ log-and-skip, exactly like the two legacy capabilities above — never crashes the spawn.
    // P4↔P5a: if the bound connection is `oauth2`, `resolveConnectionSecret` resolves to undefined by
    // design (see connections/store.ts getSecretForUse) — this spawn mounts the server with NO env
    // injected, correctly fail-closed. That binding is rejected earlier, at profile-save time
    // (profiles/validate.ts › capabilityGrantBindingError), so reaching a spawn with one bound here would
    // mean an already-existing profile predates the guard — still handled safely, just silently.
    const def = catalog.find((c) => c.slug === grant.slug);
    if (!def) {
      // eslint-disable-next-line no-console
      console.warn(`[pty] ${o.sessionId} capability '${grant.slug}' is enabled but not found in the catalog — spawning without it.`);
      continue;
    }
    const connectionSecret = def.requiresConnection && grant.connectionId ? o.resolveConnectionSecret?.(grant.connectionId, o.projectId) : undefined;
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
  // Card C2 (Codescape wiring epic `369dde3c`), P4 REWRITE (card 088afc94): a per-PROJECT opt-in (NOT a
  // profile capability grant, hence outside the resolveProfileCapabilities loop above). `o.codescapeEnabled`
  // is the RAW project flag — isLoomDev() is re-checked HERE (not pre-baked by the caller) so this pure
  // seam can assert the LOOM_DEV-off negative case directly.
  //
  // GATE ORDERING IS LOAD-BEARING (card 3e429d83) — keep the cheap checks (`o.codescapeEnabled`,
  // `isLoomDev()`) first; don't reorder or hoist them behind `isCodescapeSupervisorEnabled`.
  // `isCodescapeSupervisorEnabled` bottoms out in `resolveExecutable`, a SYNCHRONOUS walk of every PATH
  // dir × PATHEXT extension (measured ~17-20ms on a real Windows PATH) — exactly the kind of blocking
  // work the spawn hot path (`createPty` → `buildMcpServers`) must never do (see CLAUDE.md's "no blocking
  // work on the hot path" invariant).
  //
  // TWO INDEPENDENT LAYERS keep that walk off the hot path for a normal spawn, not one: this outer
  // ordering, AND `isCodescapeSupervisorEnabled` itself re-checking `isLoomDev()` before touching the
  // filesystem (paths.ts). A regression has to defeat BOTH to actually reach `resolveExecutable`.
  //
  // test/pty-hot-path-no-path-walk.mjs guards the INVARIANT — "no PATH walk on the hot path for a normal
  // spawn" — not this specific ordering: it reddens on anything that actually causes the walk (e.g.
  // removing/inlining `isCodescapeSupervisorEnabled`'s own `isLoomDev()` short-circuit, confirmed by
  // fail-first testing), but it will NOT catch a reorder of just this outer gate — the inner short-circuit
  // still prevents the walk, so that alone is harmless and the test correctly stays green. Keep this
  // ordering as defense-in-depth anyway; just don't read the test's silence on a reorder as proof nothing
  // changed.
  //
  // P4: the per-session mount is now a streamable-HTTP entry pointed at the SHARED `codescape serve`
  // process (`codescapeHttpMcpServer`) — no per-session spawn at all. This SUPERSEDES the C2/C3-era
  // per-session stdio `codescape mcp --graph <graph.json>` process (which read a Loom-maintained snapshot
  // file); that mechanism is gone. `isCodescapeSupervisorEnabled(dbPath)` (isLoomDev() AND a codescape CLI
  // actually detected on the host) stays the daemon-wide master switch for the whole Codescape feature.
  // `o.integrationPaths?.codescape` (the DB-persisted path) is passed through so THIS gate check honors
  // the same DB-first precedence the supervisor's own detection uses — a daemon with the DB path set but
  // no LOOM_CODESCAPE_BIN/bare-PATH binary still detects correctly. Ruling (card 088afc94): when serve
  // isn't up (`codescapePort` null) or `resolveCodescapeProjectId` can't resolve an id for this repo,
  // this CLEAN-SKIPS — no stdio-snapshot fallback — a silent stale/absent mount masquerading as fresh is
  // the exact defect this card exists to fix, and a permanent second code path is exactly the "weaker
  // architecture" avoided by not duplicating codescape's own server-side staleness/single-flight machinery.
  if (o.codescapeEnabled && o.repoPath) {
    if (isLoomDev()) {
      if (isCodescapeSupervisorEnabled(o.integrationPaths?.codescape)) {
        const cs = codescapeHttpMcpServer({ repoPath: o.repoPath, port: o.codescapePort ?? null, worktreeId: o.worktreeId, resolveProjectId: o.codescapeResolveProjectId });
        if (cs) {
          mcpServers["codescape"] = cs;
        } else if (o.codescapePort == null) {
          // CR fix: split from the id-unresolved case below — both facts (port vs id) are already in hand
          // here, and `codescapeHttpMcpServer` checks port BEFORE id (see its own body), so a null `cs`
          // with a null port can ONLY be the serve-is-down case. The whole design premise of a clean skip
          // is that it's distinguishable from a silent failure — a merged message defeats that for anyone
          // reading the log, since "serve down" (self-heals once serve restarts) and "id unresolved"
          // (self-heals once this repo is registered/ingested) point at different fixes.
          // eslint-disable-next-line no-console
          console.warn(`[pty] ${o.sessionId} codescape enabled but serve isn't up (port unresolved) for repo ${o.repoPath} — spawning WITHOUT the Codescape MCP. A later spawn will pick it up once serve is back.`);
        } else {
          // eslint-disable-next-line no-console
          console.warn(`[pty] ${o.sessionId} codescape enabled but codescape has no id resolvable for repo ${o.repoPath} (not yet registered/ingested?) — spawning WITHOUT the Codescape MCP. A later spawn will pick it up once ready.`);
        }
      }
      // else: no codescape CLI detected on this host — the benign "feature not present" case; no per-spawn warning.
    }
    // !isLoomDev(): silent skip — the "missing" reason is the gate itself.
  }
  return mcpServers;
}

/**
 * Card C2: the `--allowedTools` contribution for a mounted Codescape MCP entry — ONLY the 7 read tools
 * (list_flows/trace_flow/what_touches/describe_symbol/render_tree/boundary_map/scenario_space), NEVER the
 * 5 control/write tools (focus_flow/highlight/open_view/annotate/show_diff). Read-only "agent orients
 * itself" integration (Q4). Named per-tool, not the whole `mcp__codescape`
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
 * Card C2 hardening (post-hoc CR blocker): the 5 control/write Codescape tools — NEVER allowlisted (see
 * {@link CODESCAPE_TOOL_ALLOW}), but the mounted `codescape` MCP entry still ADVERTISES all 12 to the
 * model regardless. Under `--permission-mode acceptEdits`, a tool that's mounted but not allowlisted is
 * NOT auto-approved — it PROMPTS. A Loom-driven role (worker/setup/auditor/workspace-auditor, stdin owned
 * by its manager, `AskUserQuestion` disallowed) can never answer that prompt, so a stray call wedges the
 * turn until the busy-stuck watchdog fires. These names are unioned into `--disallowedTools` (see
 * {@link disallowedToolsForSpawn}) whenever the codescape MCP is actually mounted, so the write surface is
 * structurally unreachable rather than merely un-allowlisted.
 */
export const CODESCAPE_WRITE_TOOLS: readonly string[] = [
  "mcp__codescape__focus_flow",
  "mcp__codescape__highlight",
  "mcp__codescape__open_view",
  "mcp__codescape__annotate",
  "mcp__codescape__show_diff",
];

/**
 * Security hardening (card 7159466a): `browserTesting`'s `--allowedTools` grant is the WHOLE
 * `mcp__playwright` server (a wildcard — see {@link capabilityToolAllowlist}'s "browser-testing" slug and
 * the direct browserTesting allow at the createPty chokepoint), which includes `browser_run_code_unsafe` —
 * @playwright/mcp's own README calls it "RCE-equivalent" (executes arbitrary JS in the Playwright server
 * process). No legitimate browser-testing workflow needs it (`browser_evaluate` covers in-page JS), and
 * nothing caps it once the wildcard is granted — including a human enabling `browserTesting` on the
 * untrusted-chat-facing companion (assistant) profile. This name is unioned into `--disallowedTools` (see
 * {@link disallowedToolsForSpawn}) whenever the Playwright MCP is actually mounted, so `--disallowedTools`
 * overrides the wildcard `--allowedTools` grant and the tool is structurally unreachable rather than merely
 * un-allowlisted (verified empirically via a real spawn — see the spawn-args test).
 */
export const PLAYWRIGHT_DISALLOWED_TOOLS: readonly string[] = [
  "mcp__playwright__browser_run_code_unsafe",
];

/**
 * Security hardening (card f1609e1a, a residual the Code Reviewer surfaced OUTSIDE card 7159466a's
 * RCE scope): beyond `browser_run_code_unsafe`, `@playwright/mcp`'s default tool set also mounts two
 * tools that take ABSOLUTE HOST FILE PATHS and read them into a page — verified against the installed
 * `@playwright/mcp` README (`browser_file_upload`'s and `browser_drop`'s `paths` params) —
 * `browser_file_upload` and `browser_drop`. (`browser_drag` was checked and excluded: it takes only
 * page-snapshot element refs, no host path.) Combined with `browser_navigate` to an attacker-controlled
 * page, that's a host-secret EXFILTRATION primitive (read `~/.ssh/id_rsa` / `.env`, POST from a
 * cooperating page) — NOT RCE, but the same threat model as PLAYWRIGHT_DISALLOWED_TOOLS: a human
 * enabling `browserTesting` on the untrusted-chat-facing companion (`assistant`) profile.
 *
 * UNLIKE `browser_run_code_unsafe` (which no legitimate workflow needs and is disallowed for EVERY
 * role), these two ARE legitimately needed for upload/drag-drop testing on the worker rigs (QA Tester /
 * Web Designer) — so this set is ROLE-SCOPED: {@link disallowedToolsForSpawn} unions it in ONLY when
 * `role === "assistant"` AND the Playwright MCP is mounted, leaving worker/manager/other roles
 * byte-identical (they keep file_upload/drop). Same posture as `RESTRICTED_NATIVE_TOOLS` — blast-radius
 * control scoped to the chat-reachable companion, not a blanket restriction.
 */
export const ASSISTANT_PLAYWRIGHT_DISALLOWED_TOOLS: readonly string[] = [
  "mcp__playwright__browser_file_upload",
  "mcp__playwright__browser_drop",
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
/**
 * `giveUpRequeues` (card 441499ee) OPTIONALLY counts how many times THIS EXACT message has already been
 * put back on `live.pending` after a submit give-up (see `fireEnterAndVerify`'s GIVE-UP RECOVERY branch
 * and `GIVE_UP_REQUEUE_LIMIT`) — undefined/0 for every message that has never given up. Identity-scoped
 * to the message object itself (never inferred from matching text), so two legitimately identical
 * messages are counted independently and a message that keeps giving up can't requeue forever.
 *
 * `giveUpGen` (card 441499ee, hardening against a false-negative give-up) tags a requeued entry with the
 * `submitGeneration` its ORIGINAL (failed) submit ran under. The give-up discriminator can itself be
 * wrong — a confirming hook can arrive AFTER give-up already fired, proving the original turn actually
 * started (see `purgeConfirmedGiveUpRequeue`) — so this is the correlation a late confirmation uses to
 * find and purge the now-redundant requeued copy before it can ever drain and double-deliver the same
 * text. undefined for every entry that was never requeued.
 */
export type QueuedMessage = { id: string; text: string; source: QueueSource; onDeliver?: (reason?: string) => void; route?: TurnRoute; kind: QueuedMessageKind; questionId?: string; ownerText?: string; proactive?: boolean; senderId?: string | null; giveUpRequeues?: number; giveUpGen?: number };
/**
 * Distinguishes `enqueueStdin`'s `delivered:false` outcomes, which otherwise read identically at a
 * glance: `"session-dead"` = no live pty at all — the text was DROPPED, nothing will ever deliver it.
 * `"held"` = queued FIFO on a live-but-busy/not-ready session — it WILL deliver at the next turn
 * boundary. Card 78a16dc5's shape guard (see `sanitizeLoneSurrogates`/`isUntaggedSystemNudge`)
 * DELIBERATELY never drops a "warning"-kind entry — see those doc comments for why a hard drop was
 * rejected (a Code Reviewer catch: it could silently swallow a real `run_gate` failure nudge, stranding a
 * worker parked on it with no durable pending-op left to recover from) — so there is no "malformed"
 * member here; every `kind:"warning"` entry is either sanitized or logged, never dropped on shape alone.
 * A caller that only checked `delivered:false` could conflate "dropped" with "queued".
 */
export type EnqueueDeliveryReason = "session-dead" | "held";
/**
 * Shape guard (card 78a16dc5) for a `kind:"warning"` entry only (Loom's OWN operational nudges:
 * idle/context/busy-stuck watchdogs, restart/boot continuation notes, rate-limit/usage nudges,
 * memory-recall injection — see `QueuedMessageKind`). An `"agent"`-kind entry (a worker report, a
 * manager's direction, a human composer turn, a replayed kickoff) is legitimately free-form text, so
 * NEITHER check below is ever applied there — not sanitized, not logged, delivered byte-identical.
 *
 * Both tiers SANITIZE-OR-LOG, they NEVER DROP. An earlier version of this guard DROPPED a "warning"
 * entry with a lone surrogate — a Code Reviewer catch on this same card found that a drop there is a
 * real stall hazard, not just defense-in-depth: the async `run_gate` FAILURE nudge (sessions/service.ts,
 * kind:"warning") embeds `gateDetail.stderrTail`, a raw CODE-UNIT slice of captured gate stdout/stderr
 * (gate-runner.ts). If that stderr contains a non-BMP character (an emoji in a test name/assertion/diff)
 * split exactly at the slice boundary, the tail begins with a lone surrogate — and `clearPendingGateOp`
 * runs immediately BEFORE this enqueue, so a dropped nudge here would leave NO durable pending-op for
 * `reconcileOrphanedGateOps` to recover: a worker parked on its gate-completion nudge would stall
 * indefinitely with no path back. That is the exact silent-stall class the `/worker` doctrine warns
 * about, in the very machinery this card exists to harden — so dropping is never an acceptable outcome
 * for this guard, however corrupted the shape. Sanitizing removes the hazard entirely while still fixing
 * the byte-level corruption (the delivered message is always well-formed).
 *
 * `sanitizeLoneSurrogates` — replaces any LONE (unpaired) UTF-16 surrogate (`LONE_SURROGATE_RE`) with
 * U+FFFD (the replacement character): exactly the string-level signature of BYTES that were split mid
 * multi-byte UTF-8 sequence and then decoded/concatenated anyway — the actual corruption this card was
 * filed over (two genuinely different source texts spliced together mid-word). Logs the anomaly (with a
 * short excerpt) and returns the SANITIZED (now well-formed) text; a caller with nothing to sanitize gets
 * the identical string back (cheap to check via `!==`). Equivalent in spirit to the ES2024
 * `String.prototype.isWellFormed()`/`toWellFormed()`, hand-rolled via regex so this doesn't require
 * bumping the repo's shared `lib` target off ES2023 for one call site.
 *
 * `isUntaggedSystemNudge` — LOG-ONLY, never drops or modifies the text. Missing the `[loom:` prefix every
 * REAL call site (resume-nudge.ts, the idle/context watchers, …) happens to use today is NOT itself
 * corruption — it was initially treated as a hard DROP condition, but that turned out to be an invariant
 * the codebase does not actually hold everywhere (a "warning"-kind sender with legitimate untagged text —
 * e.g. the companion persona-reinject path before it was tagged — surfaced immediately once the guard
 * shipped, and a static audit could not prove no OTHER untagged sender exists uncaught). So a missing tag
 * is logged as an anomaly (for someone to go tag the sender properly) but the message is delivered as-is.
 */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
function sanitizeLoneSurrogates(text: string, kind: QueuedMessageKind): { text: string; sanitized: boolean } {
  if (kind !== "warning") return { text, sanitized: false };
  const cleaned = text.replace(LONE_SURROGATE_RE, "�"); // U+FFFD REPLACEMENT CHARACTER
  return { text: cleaned, sanitized: cleaned !== text };
}
function isUntaggedSystemNudge(text: string, kind: QueuedMessageKind): boolean {
  return kind === "warning" && !text.startsWith("[loom:");
}

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
  // Epoch ms when THIS pty process started — set once at creation for every kind. Distinct from the DB
  // session's createdAt (unchanged across a resume/recycle/upgrade): this is the CURRENT live process's
  // own start, so a resume/fork/recycle/companion-upgrade (all through createPty) each get a fresh value.
  // Surfaced via `liveStartedAt` so a reader (e.g. the companion capability panel) can tell whether a
  // grant changed AFTER the running process last (re)read its tool surface — i.e. whether a respawn is
  // still pending to apply it.
  startedAt: number;
  logStream: fs.WriteStream;
  // Flips true the first time logStream emits 'error' (see attachLogErrorGuard) — degrades THIS
  // session's log-writing to a no-op for the rest of its life. A WriteStream auto-destroys on error,
  // so a bare listener alone isn't enough: without this flag, every subsequent .write() to the dead
  // stream would re-emit 'error' (handled, but re-logged/re-thrown-from-emit on every pty data chunk).
  // The pty/session itself is never affected — only its on-disk transcript log goes silent.
  logBroken: boolean;
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
  // Card d88163b7 (CR fix): a CALLER-held drain suppression — SUPPRESS drain/submit (mirrors `stopping`,
  // but is a DISTINCT flag: see `holdDrain`/`releaseDrain`) for a window BEFORE the caller has decided to
  // actually stop the session, so nothing can start a NEW turn (via drainPending's Stop-hook auto-drain
  // or enqueueStdin's idle-submit path) that a later `pty.stop()` would then kill with no recovery.
  // DELIBERATELY NOT `stopping` itself: `onExit` classifies a death as `intended: live.stopping`, so
  // setting `stopping` early (before we've actually decided to interrupt) would misreport a genuine
  // mid-hold crash as an intended stop.
  drainHeld: boolean;
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
  // Card 441499ee: the exact QueuedMessage entry/entries this IN-FLIGHT submit()'s text came from — set
  // in submit(), read ONLY by `fireEnterAndVerify`'s GIVE-UP RECOVERY branch so a give-up can put the
  // ORIGINAL message(s) back on `live.pending` (identity-preserved, never re-derived from text) instead of
  // discarding them after the caller was already told `delivered:true`. null for the two direct submit()
  // callers that don't originate from enqueueStdin (resumeAfterRateLimit's replay, scheduleKickoffGuarantee)
  // — a give-up there has no origin to restore, same as before this card. Overwritten (not appended) by
  // every submit() call; a stale reference from an already-confirmed/superseded turn is harmless because
  // the give-up branch itself bails on `enterConfirmed`/a mismatched `submitGeneration` before ever reading it.
  giveUpOrigin: QueuedMessage[] | null;
  // Card 1bd1f045: monotonic per-session sequence number for the `[pty-write]` byte/call-sequence log —
  // bumped by `ptyWrite()` on every REAL `live.pty.write()` call (see that method's doc). THE load-bearing
  // field: it is what makes a duplicated or replayed emission visible AS SUCH (two records sharing a
  // content signature at distinct seq) rather than reading as plausible traffic — discriminating whether
  // the daemon itself double-wrote (card 9ed20572) or something below it replayed already-consumed bytes
  // (card 3ce3fa39). Observation-only counter; never read for control flow.
  writeSeq: number;
  // Loom Companion (multi-channel reply routing): the ORIGINATING chat route of the IN-FLIGHT turn, or null
  // when the turn wasn't formed from a companion inbound / proactive-home submit. Set SYNCHRONOUSLY in
  // submit() (both the idle-submit and drain paths), read by getActiveTurnOrigin when the companion's
  // chat_reply fires — so a reply resolves to the EXACT route of the turn it answers (no shared/last-inbound
  // field, no cross-delivery). `lastPromptRoute` mirrors `lastPrompt` so a rate-limit-killed companion turn
  // replays to its ORIGINAL route on resume. Both null on every non-companion turn ⇒ byte-identical.
  activeTurnRoute: TurnRoute | null;
  lastPromptRoute: TurnRoute | null;
  // Loom Companion (proactive event-line producer): whether the IN-FLIGHT turn was FORMED from a
  // daemon-driven proactive submit (heartbeat/reminder/attention-push alert) — caller-supplied at
  // enqueueStdin/submit(), never sniffed from the text. Persists like activeTurnRoute (simply overwritten
  // by the next submit(), not cleared at Stop — unlike activeTurnOwnerText). `lastPromptProactive` mirrors
  // `lastPromptRoute` so a rate-limit-killed proactive turn's replay (resumeAfterRateLimit) is still tagged
  // correctly. Read by getActiveTurnIsProactive when the companion's chat_reply fires, so the outbound
  // frame + persisted history row can be tagged for the web chat's amber event-line render.
  activeTurnProactive: boolean;
  lastPromptProactive: boolean;
  // Companion injection-guard Primitive A (Companion Capability & Permission-Lever Framework §3): the
  // LITERAL authenticated owner inbound bytes forming the IN-FLIGHT turn, or null when the turn wasn't
  // formed from an authorized owner inbound (proactive/heartbeat/reminder/cross-channel-mirror/memory-
  // recall → null). Set alongside activeTurnRoute in submit() but — UNLIKE activeTurnRoute, which simply
  // gets overwritten by the next submit() — is explicitly CLEARED at turn end (the Stop/StopFailure hook):
  // an ACT lever's owner-text attestation must never see a stale prior turn's text. lastPromptOwnerText
  // mirrors lastPromptRoute so a rate-limit-killed companion turn replays with its attestation intact.
  activeTurnOwnerText: string | null;
  lastPromptOwnerText: string | null;
  // Companion injection-guard Primitive A WIDENING (card 2b26035c, "recent-turns verbatim acceptance"): a
  // BOUNDED, most-recent-first ring of the last RECENT_OWNER_TURNS_WINDOW authenticated owner-turn texts.
  // Pushed alongside activeTurnOwnerText in submit() whenever a turn carries real ownerText — so it is
  // built from the EXACT SAME server-attested owner inbound bytes as Primitive A, just retained across
  // turn boundaries instead of being cleared at Stop. A proactive/heartbeat/system turn (ownerText
  // undefined) never pushes an entry, so this can never accumulate model-authored or injected text —
  // only the TURN SCOPE widens, never the source. Lets a lever accept a candidate that's a verbatim
  // substring of a RECENT turn (e.g. a cross-turn correction/re-phrase), not just the one in flight.
  // GROUP companion note: in a group-scope route, each turn's ownerText is already whichever ALLOWLISTED
  // sender's message formed it (chat-gateway.ts's per-turn sender-authz gate, unchanged by this card) —
  // so this window can span MULTIPLE allowlisted senders' recent turns, not just one person's. This is
  // intentional, not an escalation: every entry is still an authenticated, authorized-user turn (never
  // model-authored/injected), and a lever committing content still separately requires the COMMITTING
  // turn's own current-turn owner-auth (Primitive A) plus the trust window/confirm round-trip — the
  // widened quote-source never substitutes for either of those.
  recentOwnerTurns: string[];
  // Companion Trust Window (Companion Capability & Permission-Lever Framework, card 0): the AUTHENTICATED
  // sender id of the IN-FLIGHT turn's inbound message, for a GROUP-scope companion route only — null for a
  // DM route (the chatId alone already identifies the single owner, mirroring VoicePrefRoute's own
  // group-only senderId rule) and null for every non-companion-inbound turn. Mirrors activeTurnOwnerText's
  // lifecycle exactly: set alongside it in submit(), CLEARED at the Stop/StopFailure hook (a stale prior
  // turn's sender must never be attributed to a later turn), with lastPromptSenderId mirroring
  // lastPromptOwnerText so a rate-limit-killed companion turn's replay keeps the same sender identity.
  activeTurnSenderId: string | null;
  lastPromptSenderId: string | null;
  startupModeCycles: number; // Shift+Tab presses to inject once, after SessionStart, to reach the target mode
  startupCyclesDone: boolean; // guard so the cycle-inject fires at most once per session
  // Serializes every cycleToMode() invocation for THIS session (the boot convergence, the plan
  // auto-heal, and any manager-driven worker_set_mode override) onto one queue, so no two ever press
  // Shift+Tab or read the footer concurrently — see cycleToMode's doc comment (card 9c03f5a6: an
  // uncoordinated race between the boot cycle and a manual override interleaved their keystrokes/reads
  // and could settle on EITHER cycle's target, observed as worker_set_mode landing on the boot default
  // ("auto") regardless of what was requested). Always resolved (never rejects) so the chain can't wedge.
  modeCycleChain: Promise<void>;
  mcpPromptHandled: boolean;  // guard: dismiss the plugin-MCP enable-prompt with Esc at most once per session
  bootScan: string;           // bounded rolling buffer of early boot output, scanned for that prompt
  resumeGateHandled: boolean; // TERMINAL: true once Enter has actually been sent for the resume-from-summary
                              // gate (confirmed-or-given-up) — see resolveResumeGate. Also gates whether
                              // resumeGateScan keeps accumulating (stays false through the whole verify-retry).
  resumeGateDetected: boolean; // true once the gate text is first recognized — guards the detect→drive
                                // trigger from re-arming on every subsequent chunk while resumeGateHandled
                                // is still false (the verify-retry is in flight).
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
  // Card df5e37e7: whether the daemon has observed at least one HTTP hit on THIS session's
  // loom-orchestration MCP route (/mcp-orch/:sessionId → markMcpSeen) since the CURRENT pty instance
  // was (re)spawned. `ready` (SessionStart) only proves the TUI booted — it says nothing about whether
  // the CLI's own async MCP-client handshake to loom-orchestration has finished, so a resume-continuation
  // nudge submitted right after `ready` can race ahead of it and the model's first tool call hard-fails
  // with "MCP server 'loom-orchestration' is not connected" (observed after a fleet-wide daemon_restart).
  // The daemon's MCP transport is stateless-per-request (see mcp/orchestration.ts), so it has NO other
  // way to observe client-side connection state — "we received a request" is the closest proxy, since the
  // CLI performs its `initialize` handshake unprompted at boot. Reset to false on every (re)spawn (this is
  // a fresh Live object each time). See markMcpSeen/waitForMcpSeen. General-purpose: not loom-orchestration
  // specific by construction — a future caller could mark/wait on this for any per-session MCP route.
  mcpSeen: boolean;
  // Resolvers waiting on `mcpSeen` flipping true (or on this pty dying) — see waitForMcpSeen. Drained
  // (called + emptied) by markMcpSeen on success and by pty.onExit on death, so a waiter never outlives
  // its pty instance.
  mcpSeenWaiters: Array<(seen: boolean) => void>;
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
   * Card C2 (Codescape wiring epic `369dde3c`): the project's RAW `codescape.enabled` config flag — NOT
   * yet combined with `isLoomDev()` (buildMcpServers applies that gate itself). Default OFF — every
   * existing spawn is byte-identical when unset.
   */
  codescapeEnabled?: boolean;
  /** Card C2: the session's project id (used for non-Codescape purposes too, e.g. connection-secret scoping). */
  projectId?: string;
  /**
   * Card 088afc94 (P4 wiring): the project's PRIMARY repo path — used to resolve codescape's OWN project
   * id via its manifest (never Loom's `projectId` above; see `codescapeHttpMcpServer`'s doc for why).
   * ALWAYS the project's main checkout, never a worker's own worktree (codescape indexes one graph per
   * project). Default undefined — every existing spawn is byte-identical (the codescape branch requires
   * this to be present).
   */
  repoPath?: string;
  /**
   * Card 088afc94 (P4 wiring): this session's codescape worktree scope (`codescapeWorktreeId(taskId)`) —
   * present for a worker tied to a task, absent for every other role (and a taskless worker), which fall
   * back to the bare `/mcp/<codescapeId>` project route. Default undefined ⇒ bare route.
   */
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
  /**
   * Card f9b47cd1: the `-n <name>` session name (see pty/session-name.ts) — a legible resume-picker
   * label, computed UPSTREAM by the caller (sessions/service.ts) from role/agent/project/task, exactly
   * like `model`/`startupPrompt`. Threaded on every FRESH-spawn path; omitted on `--resume`/
   * `--fork-session` (the caller never computes one there — see buildSpawnArgs' doc). createPty
   * ADDITIONALLY gates this on the installed claude version (meetsMinVersion) before it ever reaches
   * buildSpawnArgs, so an old claude's argv is byte-identical regardless of what the caller passed.
   */
  sessionName?: string;
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
 * {@link RESTRICTED_NATIVE_TOOLS} iff `restrictedTools` is on, with {@link CODESCAPE_WRITE_TOOLS} iff
 * `codescapeMounted` is true (the mounted Codescape MCP still advertises its 5 write tools even though
 * they're never allowlisted — see CODESCAPE_WRITE_TOOLS's doc for why that alone isn't enough), AND with
 * {@link PLAYWRIGHT_DISALLOWED_TOOLS} iff `playwrightMounted` is true (the mounted Playwright MCP's
 * `--allowedTools` grant is the whole-server wildcard, which includes the RCE-equivalent
 * `browser_run_code_unsafe` — see PLAYWRIGHT_DISALLOWED_TOOLS's doc), AND — ONLY when `role ===
 * "assistant"` — with {@link ASSISTANT_PLAYWRIGHT_DISALLOWED_TOOLS} (the host-file-reading
 * file_upload/drop pair; role-scoped because worker rigs legitimately need them — see that const's
 * doc). When ALL of restrictedTools/codescapeMounted/playwrightMounted are off/falsy this returns
 * EXACTLY `disallowedToolsForRole(role)` — so the flag-off argv is BYTE-IDENTICAL to today (no
 * restricted/codescape/playwright tokens appended). Pure + exported so the spawn-args test asserts the
 * union + the byte-identical-off invariant with no real claude. (Companion blast-radius card; Codescape C2
 * hardening; card 7159466a Playwright hardening; card f1609e1a assistant file_upload/drop hardening.)
 */
export function disallowedToolsForSpawn(role?: SessionRole | null, restrictedTools?: boolean, codescapeMounted?: boolean, playwrightMounted?: boolean): string[] {
  const base = disallowedToolsForRole(role);
  if (!restrictedTools && !codescapeMounted && !playwrightMounted) return base; // OFF: exactly the role's disallow list (byte-identical to today)
  const merged = [...base];
  if (restrictedTools) for (const t of RESTRICTED_NATIVE_TOOLS) if (!merged.includes(t)) merged.push(t); // union, de-duped
  if (codescapeMounted) for (const t of CODESCAPE_WRITE_TOOLS) if (!merged.includes(t)) merged.push(t); // union, de-duped
  if (playwrightMounted) for (const t of PLAYWRIGHT_DISALLOWED_TOOLS) if (!merged.includes(t)) merged.push(t); // union, de-duped
  if (playwrightMounted && role === "assistant") for (const t of ASSISTANT_PLAYWRIGHT_DISALLOWED_TOOLS) if (!merged.includes(t)) merged.push(t); // union, de-duped — role-scoped
  return merged;
}

/**
 * Collect every capability-injected env value riding an assembled mcpServers map's `env` blocks
 * (agent-tooling P4 credential tie — see resolveCapabilityServer). This reads STRUCTURALLY (any string
 * value under any server's `env`), not by name — so it is deliberately NOT "secrets only": a
 * `wantsScratchDir` row's non-secret scratch-dir path (injected via `outputDirEnvVar`, see registry.ts)
 * rides the exact same `env` block and is swept in here too. That's intentional and harmless in both
 * directions this list is used for: `redactSecrets` stripping a value that was never sensitive is a no-op
 * risk-wise, and `mcpConfigHasSecret` treating a scratch-dir-only row as "has a secret" only means that
 * config gets the (strictly safer) file-diversion treatment it would get anyway, never less protection
 * than a config with a real secret. Pure, exported for the hermetic test.
 */
export function collectMcpEnvSecrets(mcpServers: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const server of Object.values(mcpServers)) {
    const env = (server as { env?: Record<string, string> } | undefined)?.env;
    if (env) for (const v of Object.values(env)) if (v) out.push(v);
  }
  return out;
}

/**
 * True iff the assembled mcpServers map carries at least one capability-injected env value (secret OR
 * non-secret, e.g. a `wantsScratchDir` row's output-dir path — see {@link collectMcpEnvSecrets}'s doc for
 * why that over-inclusion is deliberate and harmless).
 */
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
  /**
   * Card f9b47cd1: `-n <name>` — a legible resume-picker label (Claude Code's own session-naming
   * feature). The CALLER (createPty) has ALREADY version-gated this against the installed claude
   * (meetsMinVersion(getCachedClaudeVersion())) before it ever reaches this pure function, so this
   * itself does no gating — it just emits when present. Emitted ONLY when set, so a resume/fork spawn
   * (the caller never computes one there) or a pre-2.1.196 claude (the caller passes undefined) stays
   * byte-identical to before this option existed.
   */
  sessionName?: string;
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
  // Card f9b47cd1 session naming: also BEFORE --strict-mcp-config, so `-n`'s single value can never eat
  // into the variadic `--mcp-config` that follows. Emitted ONLY when present (see this param's doc).
  if (o.sessionName) args.push("-n", o.sessionName);
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
 *
 * Also carries `LOOM_WORKTREE=spawnCwd` — a stable anchor an agent's OWN Bash calls can reference (e.g.
 * `cd "$LOOM_WORKTREE" && …`) to make a cwd-dependent command deterministic regardless of what an
 * earlier call's `cd` left behind. Loom cannot reset the Bash tool's cwd itself (that shell state is
 * internal to the upstream Claude Code CLI process, invisible past its pty), so this is the strongest
 * reachable mitigation: a known-good absolute anchor, not a reset. Uniform across every session kind —
 * for a worker `spawnCwd` is the worktree root; for a manager/companion/plain session it's just that
 * session's own cwd (repo/project root). Set before the sessionEnv merge, like the git-safety vars, so a
 * deliberate override still wins.
 */
export function buildSpawnEnv(
  processEnv: Record<string, string | undefined>,
  sessionEnv: Record<string, string>,
  spawnCwd: string,
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
  env.LOOM_WORKTREE = spawnCwd;
  Object.assign(env, sessionEnv);
  return env;
}

/**
 * The `LOOM_SCRATCH_DIR` env addition for a browser-testing spawn — `@playwright/mcp`'s `checkFile`
 * guard only allows a write inside `--output-dir` (which `buildMcpServers` always points at
 * `sessionScratchDir`) or the subprocess's inherited cwd, so a browser-capable agent needs to be TOLD
 * that path to stage a `browser_file_upload` source file or persist an explicit-path screenshot inside
 * an allowed root — its generic harness scratchpad is neither.
 *
 * Gated on `mcpServers.playwright` itself (the ACTUAL mount decision), not a raw `browserTesting` flag,
 * so this can never disagree with whether the Playwright MCP mounted — a resolution failure (see
 * `playwrightMcpServer`) leaves both the MCP and this var absent. Returns `{}` for every other spawn
 * (fully additive — byte-identical env when off).
 */
export function browserScratchEnv(
  mcpServers: Record<string, unknown>,
  sessionId: string,
): Record<string, string> {
  return mcpServers.playwright ? { LOOM_SCRATCH_DIR: sessionScratchDir(sessionId) } : {};
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
 *  a literal control character itself. Strips ESC (0x1B) among others, which is what neutralizes an
 *  embedded terminal escape sequence — e.g. the bracketed-paste terminator `\x1b[201~` becomes the inert
 *  literal text `[201~` once its leading ESC is gone. See its use in {@link enumerateProcessesWin32}, and
 *  (exported) in sessions/service.ts to sanitize gate output before it's piped through `enqueueStdin`. */
export const CONTROL_CHAR_RE = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(31)}]`, "g");

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
 * Attach the fail-safe 'error' listener every per-session log WriteStream MUST have (card 7a6cc239): a
 * Node writable that emits 'error' with zero listeners throws it back out of `.emit()` — unhandled, that
 * crashes the ENTIRE daemon process (every live manager/worker pty lost), not just this one session's
 * logging. Latent today only because `ensureDirs()` guarantees the log dir exists at boot; a disk-full,
 * a permission change, an AV/indexer lock, or a corrupt volume on an actual write would still hit it.
 * On error this DEGRADES — flips `live.logBroken` so `writeLog` becomes a no-op for the rest of this
 * session's life — rather than rethrow; the pty/session itself is unaffected, only its on-disk log stops.
 * Call once, synchronously, right after constructing each `live` entry (same tick as `createWriteStream`,
 * so there's no race with the stream's own always-async error emission).
 */
function attachLogErrorGuard(sessionId: string, live: Live): void {
  live.logStream.on("error", (err) => {
    if (live.logBroken) return; // already degraded — don't re-log/spam on a re-emitted error
    live.logBroken = true;
    try {
      // eslint-disable-next-line no-console
      console.error(`[pty] ${sessionId} log stream error — disabling this session's on-disk log (session continues): ${err.message}`);
    } catch { /* logging the error must never itself throw */ }
  });
}

/**
 * Write to a session's log stream, guarded against a previously-errored/destroyed stream (see
 * attachLogErrorGuard) — a no-op once `live.logBroken` is set, so a broken log never re-attempts or
 * re-throws. The try/catch is defense in depth (matches this file's existing style around `.end()`);
 * `logBroken` is what actually stops repeat work, not the catch.
 */
function writeLog(live: Live, buf: Buffer): void {
  if (live.logBroken) return;
  try { live.logStream.write(buf); } catch { live.logBroken = true; }
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
  private readonly resolveConnectionSecret: (connectionId: string, projectId?: string) => string | undefined;
  /**
   * Card 8dc5ebb9: read access to the DB-persisted host-tool integration paths
   * (`PlatformConfigOverride.integrations`), wired in by index.ts at boot (it holds `db`; PtyHost
   * deliberately does not — mirrors `getCapabilityCatalog` above). Called PER-SPAWN inside createPty
   * (never boot-bound), so a Settings change reaches the very next new session with no daemon restart.
   * Defaults to a harmless no-op (`{}`) so a PtyHost built without this opt — every existing hermetic
   * test — behaves byte-identically: both resolvers fall back to their env var exactly as before.
   */
  private readonly getIntegrationPaths: () => { codescape?: string };
  /**
   * Card 088afc94 (P4 wiring): read access to the codescape supervisor's live port + its bound
   * `resolveProjectId` (cache-then-manifest — see codescape/supervisor.ts), wired in by index.ts at boot
   * (mirrors `getIntegrationPaths` above — PtyHost stays supervisor-unaware). `port:null` / a
   * `resolveProjectId` that always resolves `null` both clean-skip the codescape MCP mount for every
   * spawn — the byte-identical default for every existing hermetic test that doesn't wire this.
   */
  private readonly getCodescapeSupervisorState: () => { port: number | null; resolveProjectId: (repoPath: string) => string | null };
  constructor(
    private events: PtyHostEvents,
    opts?: {
      busyStaleMs?: number; coalesceAgentMessages?: boolean;
      getCapabilityCatalog?: () => CapabilityDefRow[];
      resolveConnectionSecret?: (connectionId: string, projectId?: string) => string | undefined;
      getIntegrationPaths?: () => { codescape?: string };
      getCodescapeSupervisorState?: () => { port: number | null; resolveProjectId: (repoPath: string) => string | null };
    },
  ) {
    this.busyStaleMs = opts?.busyStaleMs ?? BUSY_STALE_MS;
    this.coalesceAgentMessages = opts?.coalesceAgentMessages ?? false;
    this.getCapabilityCatalog = opts?.getCapabilityCatalog ?? (() => []);
    this.resolveConnectionSecret = opts?.resolveConnectionSecret ?? (() => undefined);
    this.getIntegrationPaths = opts?.getIntegrationPaths ?? (() => ({}));
    this.getCodescapeSupervisorState = opts?.getCodescapeSupervisorState ?? (() => ({ port: null, resolveProjectId: () => null }));
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
      startedAt: Date.now(),
      logStream: fs.createWriteStream(path.join(LOGS_DIR, `${opts.sessionId}.log`)),
      logBroken: false,
      busy: false,
      ready: false, // flipped on the first SessionStart (after mode-cycles) — see Live.ready / markReady
      mcpSeen: false, // flipped on the first observed loom-orchestration MCP hit — see Live.mcpSeen / markMcpSeen
      mcpSeenWaiters: [],
      busySince: null,
      lastOutputAt: Date.now(),
      composerLen: 0,
      pending: [],
      stopping: false,
      drainHeld: false,
      rateLimited: false,
      // The startup-prompt turn runs from a CLI arg (not submit()), so seed lastPrompt with it —
      // a cap on the FIRST turn must still be re-submittable on resume (§19c-b). It carries NO companion
      // route (a startup turn is never a companion inbound), so the route fields start null.
      lastPrompt: opts.startupPrompt ?? null,
      firstTurnStarted: false, // flips true on the first UserPromptSubmit — see scheduleKickoffGuarantee/healIfStuck
      enterConfirmed: true, // no submit() outstanding yet (the startup turn is a CLI arg, not submit()) — see submit()'s reset
      submitGeneration: 0,
      writeSeq: 0,
      giveUpOrigin: null,
      activeTurnRoute: null,
      lastPromptRoute: null,
      activeTurnOwnerText: null,
      lastPromptOwnerText: null,
      recentOwnerTurns: [],
      activeTurnSenderId: null,
      lastPromptSenderId: null,
      activeTurnProactive: false,
      lastPromptProactive: false,
      // Boot is always gate-free (acceptEdits); cycle to the target mode once the TUI is up (SessionStart).
      startupModeCycles: opts.permission.startupModeCycles ?? 0,
      startupCyclesDone: false,
      modeCycleChain: Promise.resolve(),
      mcpPromptHandled: false,
      bootScan: "",
      resumeGateHandled: false,
      resumeGateDetected: false,
      resumeGateScan: "",
      isResume: !!opts.resumeId,
      modeLogged: false,
      resumeModeTarget: opts.resumeModeTarget ?? null,
      role: opts.role ?? null,
    };
    this.live.set(opts.sessionId, live);
    attachLogErrorGuard(opts.sessionId, live);

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
          setTimeout(() => { if (live.alive) this.ptyWrite(opts.sessionId, live, ESC_KEY, "esc-mcp-dismiss"); }, 300);
        }
      }
      // Resuming a large/old session shows a "resume from summary / as-is" gate BEFORE SessionStart
      // whose DEFAULT (option 1) summarizes — silently compacting away the manager's full context — and
      // which blocks the whole resume (mode-cycles + the queued boot nudge never run; the readiness
      // fallback then drains the nudge INTO the gate, selecting that default → the 2026-06-03 incident).
      // PRIMARY prevention is writeSessionSettings' CLAUDE_CODE_RESUME_THRESHOLD_MINUTES/TOKEN_THRESHOLD
      // env override (should keep this gate from ever rendering at all); this is the belt-and-suspenders
      // fallback via resolveResumeGate, which CONFIRMS the cursor actually reached option 2 before Enter
      // (see its doc comment for the 2026-07-10 incident this replaces the old blind Down+Enter for).
      // `resumeGateHandled` stays false — and this scan keeps accumulating — for the WHOLE verify-retry,
      // not just until first detection; `resumeGateDetected` guards the one-shot trigger below instead.
      if (!live.resumeGateHandled) {
        live.resumeGateScan = (live.resumeGateScan + d).slice(-8192);
        if (!live.resumeGateDetected && isResumeSummaryGate(collapseBoot(live.resumeGateScan))) {
          live.resumeGateDetected = true;
          // eslint-disable-next-line no-console
          console.log(`[pty] ${opts.sessionId} resume-summary gate detected → driving cursor to "Resume full session as-is" (verify-retry)`);
          setTimeout(() => this.resolveResumeGate(opts.sessionId), RESUME_GATE_SETTLE_MS);
        }
      }
      this.appendRing(live, buf);
      writeLog(live, buf);
      for (const s of live.subscribers) { try { s.onData(buf); } catch { /* ignore */ } }
    });
    pty.onExit(({ exitCode }) => {
      live.alive = false;
      // The pty is gone → empty the held queue so a stale "Queued (N)" can't linger after exit (the
      // live entry survives in the map with alive=false, and getPending reads live.pending). Covers
      // EVERY exit path — a Stop-initiated stop, a crash, a clean session end — not just stopWorker.
      live.pending.length = 0;
      // A session that died while something was awaiting waitForMcpSeen must resolve that wait NOW
      // (false — it will never connect) rather than leaving the waiter to time out on its own: the
      // waiter's own .then() (enqueueStdin) already no-ops safely on a dead session either way, but
      // resolving immediately here avoids holding the closure for the full MCP_READY_TIMEOUT_MS.
      if (live.mcpSeenWaiters.length > 0) {
        const waiters = live.mcpSeenWaiters;
        live.mcpSeenWaiters = [];
        for (const w of waiters) w(false);
      }
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
    if (opts.startupPrompt) this.setBusy(opts.sessionId, true, "spawn-startup-prompt");

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
      startedAt: Date.now(),
      logStream: fs.createWriteStream(path.join(LOGS_DIR, `${opts.id}.log`)),
      logBroken: false,
      // The Claude-only state below is inert for a shell (nothing reads it once kind:"shell" gates the
      // hook/readiness/drain paths), but the Live shape is shared, so seed neutral values.
      busy: false, ready: true, busySince: null,
      mcpSeen: true, mcpSeenWaiters: [], // a shell/canned entry never mounts loom-orchestration — inert/unreachable, seeded true like ready
      lastOutputAt: Date.now(), composerLen: 0,
      pending: [], stopping: false, drainHeld: false, rateLimited: false, lastPrompt: null,
      firstTurnStarted: true, // not applicable (no kickoff to guarantee) — seeded true so the fresh-spawn checks are trivially satisfied
      enterConfirmed: true, // not applicable (deliverHook/submit's verify-retry never runs for a shell/canned kind)
      submitGeneration: 0,
      writeSeq: 0,
      giveUpOrigin: null,
      activeTurnRoute: null, lastPromptRoute: null,
      activeTurnOwnerText: null, lastPromptOwnerText: null, recentOwnerTurns: [],
      activeTurnSenderId: null, lastPromptSenderId: null,
      activeTurnProactive: false, lastPromptProactive: false,
      startupModeCycles: 0, startupCyclesDone: true,
      modeCycleChain: Promise.resolve(),
      mcpPromptHandled: true, bootScan: "",
      resumeGateHandled: true, resumeGateDetected: true, resumeGateScan: "",
      isResume: false, modeLogged: true, // a shell has no claude footer/permission mode to read
      resumeModeTarget: null, // a shell never cycles a permission mode
      role: null, // a shell has no role; unreachable anyway (modeLogged:true skips the auto-heal read)
    };
    this.live.set(opts.id, live);
    attachLogErrorGuard(opts.id, live);
    // Shell onData is minimal: NO boot-prompt / resume-gate scanning (those are Claude-TUI artifacts).
    pty.onData((d) => {
      const buf = Buffer.from(d, "utf-8");
      live.lastOutputAt = Date.now();
      this.appendRing(live, buf);
      writeLog(live, buf);
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
      startedAt: Date.now(),
      logStream: fs.createWriteStream(path.join(LOGS_DIR, `${opts.id}.log`)),
      logBroken: false,
      busy: false, ready: true, busySince: null,
      mcpSeen: true, mcpSeenWaiters: [], // a shell/canned entry never mounts loom-orchestration — inert/unreachable, seeded true like ready
      lastOutputAt: Date.now(), composerLen: 0,
      pending: [], stopping: false, drainHeld: false, rateLimited: false, lastPrompt: null,
      firstTurnStarted: true, // not applicable (no kickoff to guarantee) — seeded true so the fresh-spawn checks are trivially satisfied
      enterConfirmed: true, // not applicable (deliverHook/submit's verify-retry never runs for a shell/canned kind)
      submitGeneration: 0,
      writeSeq: 0,
      giveUpOrigin: null,
      activeTurnRoute: null, lastPromptRoute: null,
      activeTurnOwnerText: null, lastPromptOwnerText: null, recentOwnerTurns: [],
      activeTurnSenderId: null, lastPromptSenderId: null,
      activeTurnProactive: false, lastPromptProactive: false,
      startupModeCycles: 0, startupCyclesDone: true,
      modeCycleChain: Promise.resolve(),
      mcpPromptHandled: true, bootScan: "",
      resumeGateHandled: true, resumeGateDetected: true, resumeGateScan: "",
      isResume: false, modeLogged: true,
      resumeModeTarget: null,
    };
    if (opts.bytes.length) this.appendRing(live, opts.bytes);
    this.live.set(opts.id, live);
    attachLogErrorGuard(opts.id, live);
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
    const wantsOperator = opts.role === "operator";
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
      : wantsOperator ? ["mcp__loom-operator"]
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
    const codescapeState = this.getCodescapeSupervisorState();
    const mcpServers = buildMcpServers({
      sessionId: opts.sessionId, port: PORT, role: opts.role, browserTesting: opts.browserTesting, documentConversion: opts.documentConversion,
      pythonInterpreterPath: opts.sessionEnv?.LOOM_PYTHON_INTERPRETER,
      capabilities: opts.capabilities, capabilityCatalog, resolveConnectionSecret: this.resolveConnectionSecret,
      codescapeEnabled: opts.codescapeEnabled, projectId: opts.projectId,
      repoPath: opts.repoPath, worktreeId: opts.worktreeId,
      codescapePort: codescapeState.port, codescapeResolveProjectId: codescapeState.resolveProjectId,
      integrationPaths: this.getIntegrationPaths(),
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
    const settingsPath = writeSessionSettings(opts.sessionId, permission, opts.vaultPath);
    // Role-scoped disallow of the interactive human-prompt tools (AskUserQuestion / Exit|EnterPlanMode):
    // a Loom-driven role (worker/setup/auditor/workspace-auditor) must never block on a human — UNIONed with
    // the curated dangerous native tools when this session's Profile set restrictedTools (Companion
    // blast-radius control), with the 5 Codescape write tools when the mcpServers map actually carries a
    // "codescape" entry (a mounted-but-unallowlisted MCP tool still PROMPTS under acceptEdits, which a
    // Loom-driven role can never answer — see CODESCAPE_WRITE_TOOLS), AND with browser_run_code_unsafe when
    // the mcpServers map actually carries a "playwright" entry (its --allowedTools grant is the whole-server
    // wildcard — see PLAYWRIGHT_DISALLOWED_TOOLS), AND — ONLY for the untrusted-chat-facing "assistant" role
    // — with the host-file-reading file_upload/drop pair (see ASSISTANT_PLAYWRIGHT_DISALLOWED_TOOLS).
    // Computed from the session role + pinned flags at the
    // single spawn chokepoint, so EVERY path (fresh/resume/fork/recycle/boot) inherits it; with
    // restrictedTools off and codescape/playwright unmounted this is exactly disallowedToolsForRole(role) ⇒
    // byte-identical argv. See disallowedToolsForSpawn.
    const disallowedTools = disallowedToolsForSpawn(opts.role, opts.restrictedTools, !!mcpServers.codescape, !!mcpServers.playwright);
    // Card f9b47cd1: gate `-n <name>` on the installed claude version HERE (the single spawn chokepoint),
    // NOT in the caller — an older claude REJECTS the unknown flag and would break EVERY spawn (the
    // load-bearing gate-free recipe). getCachedClaudeVersion() is a NON-BLOCKING read (see its doc) —
    // never a fresh `execSync` probe from this hot path. opts.sessionName is already undefined on every
    // resume/fork spawn (the caller never computes one there), so this is the ONLY place version-gating
    // needs to happen.
    const sessionName = opts.sessionName && meetsMinVersion(getCachedClaudeVersion()) ? opts.sessionName : undefined;
    // Agent-tooling P4 credential-tie hardening: a capability secret must NEVER ride the claude process's
    // own argv. Diverting to a 0600 per-session FILE is CONDITIONAL on the map actually carrying one —
    // every secret-free spawn (every session today) keeps the byte-identical inline --mcp-config <json>
    // form (see buildSpawnArgs' mcpConfigPath doc). The file is rewritten every spawn (fresh/resume/fork/
    // recycle all call createPty, which rebuilds mcpServers fresh each time), mirroring writeSessionSettings.
    const capabilitySecrets = collectMcpEnvSecrets(mcpServers);
    const mcpConfigPath = capabilitySecrets.length ? writeSessionMcpConfig(opts.sessionId, mcpServers) : undefined;
    const args = buildSpawnArgs({ resumeId: opts.resumeId, fork: opts.fork, forkSessionId: opts.forkSessionId, settingsPath, mode: permission.mode, mcpServers, mcpConfigPath, startupPrompt: opts.startupPrompt, model: opts.model, disallowedTools, sessionName });

    // Inherited env (CLAUDE_*/CLAUDECODE scrubbed) + sessionEnv merge + the three git-safety vars that
    // keep an unattended worker pty from wedging on a pager / credential prompt, plus LOOM_WORKTREE (the
    // cwd anchor an agent's own Bash calls can reference). See buildSpawnEnv.
    const env = buildSpawnEnv(process.env, opts.sessionEnv, opts.cwd);
    // Obsidian auto-start: when the resolved config turned it on (LOOM_OBSIDIAN_AUTOSTART rode in via
    // sessionEnv → obsidianSessionEnv), hand the vault preflight helper its ABSOLUTE path so a vault skill
    // can `node "$LOOM_OBSIDIAN_PREFLIGHT"`. The asset path is daemon-side (not knowable in browser-pure
    // shared), so it's injected HERE, the single createPty chokepoint. Additive-when-off: with autoStart
    // off the var is absent and every existing spawn's env is byte-identical. A deliberate override wins.
    if (env.LOOM_OBSIDIAN_AUTOSTART === "1" && !env.LOOM_OBSIDIAN_PREFLIGHT) {
      env.LOOM_OBSIDIAN_PREFLIGHT = ENSURE_OBSIDIAN_SCRIPT;
    }
    // LOOM_SCRATCH_DIR: tell a browser-testing agent WHERE its Playwright tools' own write boundary is.
    // See browserScratchEnv for the gating rationale. Ensure the dir actually EXISTS (best-effort) so the
    // agent can Write a file into it immediately (e.g. to stage a browser_file_upload source).
    const scratchEnv = browserScratchEnv(mcpServers, opts.sessionId);
    if (scratchEnv.LOOM_SCRATCH_DIR) {
      try { fs.mkdirSync(scratchEnv.LOOM_SCRATCH_DIR, { recursive: true }); } catch { /* best-effort; never block spawn */ }
      Object.assign(env, scratchEnv);
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
    hook: { hook_event_name?: string; session_id?: string; error?: string; error_details?: unknown; resetsAt?: number },
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
        this.purgeConfirmedGiveUpRequeue(sessionId, live); // card 441499ee — see the method doc
        this.setBusy(sessionId, true, "user-prompt-submit-hook"); // rising edge — fires for the startup-prompt arg and injected prompts alike
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
        this.purgeConfirmedGiveUpRequeue(sessionId, live); // card 441499ee — see the method doc; before any early park-break below on purpose
        this.finalizingTurn = true;
        try {
          this.setBusy(sessionId, false, "stop-hook"); // falling edge — exactly one Stop per end-of-turn (no per-tool-use)
          // Companion injection-guard Primitive A: CLEAR the just-ended turn's attested owner text here —
          // unlike activeTurnRoute (which persists until the next submit() overwrites it), owner text must
          // never survive past the turn it attests, so a later non-owner-authored turn can't inherit it. A
          // rate-limited park below still replays it via lastPromptOwnerText (resumeAfterRateLimit).
          live.activeTurnOwnerText = null;
          // Companion Trust Window: CLEAR the just-ended turn's attested sender id alongside owner text —
          // same "never survive past the turn it attests" rationale. lastPromptSenderId (set in submit())
          // still carries it for a rate-limited replay.
          live.activeTurnSenderId = null;
          // Refresh context occupancy at the turn boundary — ONE single-pass tail-read of the transcript
          // (card b16320bc review: this used to be read TWICE — once here, once again below for the
          // weekly-cap text sentinel — doubling synchronous parse work of a potentially multi-MB JSONL on
          // this M2-sensitive Stop-hook chokepoint; `stats.lastAssistantText` now comes from this SAME
          // read). Cheap SYNCHRONOUS tail-read; done for EVERY session (the host doesn't know role — a
          // manager's own occupancy matters too, "who recycles the manager"). Keep it sync — see the M2
          // box above before making this (or anything here) async.
          const stats = live.engineSessionId ? readContextStats(live.cwd, live.engineSessionId) : null;
          if (stats) this.events.onContextStats(sessionId, stats);
          // Bare-pasted-text-placeholder tripwire (card eef4883c, DETECTION ONLY — see paste-tripwire.ts's
          // doc for the 8a39f544 background). Compares the SUBMITTED turn (`live.lastPrompt`, the exact
          // text submit() sent) against the transcript's recorded turn for that same turn (`stats.
          // lastUserText`, from the SAME single-pass read above — no extra file I/O). A future recurrence
          // of a submitted paste silently collapsing to a bare placeholder is now LOGGED instead of silent.
          if (detectBarePastePlaceholderTripwire(live.lastPrompt, stats?.lastUserText)) {
            // eslint-disable-next-line no-console
            console.warn(`[paste-tripwire] ${sessionId} submitted turn resolved to a bare pasted-text placeholder (engineSessionId=${live.engineSessionId ?? "?"}, claudeVersion=${getCachedClaudeVersion() ?? "?"}) — content may have been lost to an upstream CLI paste-collapse race (see card eef4883c / 8a39f544)`);
          }
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
   *
   * `proactive` (Loom Companion, proactive event-line producer) is an OPTIONAL trailing arg, appended after
   * `ownerText` for the same byte-identical-by-default reason — defaults false. Only the three daemon-owned
   * proactive watchers (CompanionHeartbeatWatcher, CompanionReminderWatcher, AttentionPushWatcher) pass
   * `true`, so their fired turn's `getActiveTurnIsProactive` reads true and the companion's chat_reply can
   * tag its outbound frame + persisted history row for the web chat's amber event-line render.
   */
  enqueueStdin(sessionId: string, text: string, source: QueueSource = "system", onDeliver?: () => void, route?: TurnRoute, kind: QueuedMessageKind = "warning", questionId?: string, ownerText?: string, proactive = false, senderId?: string | null): { delivered: boolean; position?: number; reason?: EnqueueDeliveryReason } {
    const live = this.live.get(sessionId);
    if (!live?.alive) return { delivered: false, reason: "session-dead" };
    // Shape guard (card 78a16dc5) — see the doc comments on both checks for why NEITHER tier drops: a
    // dropped "warning"-kind entry is a real stall hazard (the async run_gate failure nudge can legitimately
    // contain a lone surrogate — see sanitizeLoneSurrogates' doc comment), so this only ever sanitizes or
    // logs, never withholds delivery on shape alone.
    const { text: sanitizedText, sanitized } = sanitizeLoneSurrogates(text, kind);
    if (sanitized) {
      // eslint-disable-next-line no-console
      console.warn(`[pty] ${sessionId} sanitized an invalid (not well-formed UTF-16) system nudge — delivering the cleaned text: ${JSON.stringify(sanitizedText.slice(0, 200))}`);
    }
    text = sanitizedText;
    // LOG-ONLY: missing the [loom:* ] tag is an anomaly worth flagging, NOT proof of corruption — a
    // "warning"-kind sender that legitimately omits the tag (an unaudited call site) must still be
    // DELIVERED, not silently dropped. Falls through to the normal enqueue/deliver path below.
    if (isUntaggedSystemNudge(text, kind)) {
      // eslint-disable-next-line no-console
      console.warn(`[pty] ${sessionId} a "warning"-kind system nudge is missing its [loom:*] tag (delivering anyway — this sender should be tagged): ${JSON.stringify(text.slice(0, 200))}`);
    }
    this.healIfStuck(live, sessionId);
    // `ready` gate: a freshly (re)spawned pty is not ready until SessionStart. Submitting before then
    // writes into a still-booting TUI — the Enter is swallowed and the text strands in the composer
    // (the 2026-06-03 restart bug). Hold it FIFO; markReady drains it once the engine is up.
    if (live.ready && !live.busy && !live.stopping && !live.rateLimited && !live.drainHeld && !this.deferForHumanDraft(live)) {
      // M2 GUARD: reaching the idle (busy=false) submit path while a turn is being finalized means an
      // `await` leaked into deliverHook's lower-busy→drain window (see the M2 box there). In correct,
      // synchronous code this is unreachable — enqueueStdin runs as its own event-loop task, never
      // interleaved with deliverHook. Tripping it would mean we're about to race a second turn in.
      if (this.finalizingTurn) {
        throw new Error("M2 invariant violated: enqueueStdin reached the idle-submit path mid turn-finalize — an `await` leaked between setBusy(false) and drainPending in deliverHook (host.ts).");
      }
      // Card 441499ee: this text was never pushed to `live.pending` (it's going out immediately), so if
      // its submit later GIVES UP, there is nothing else recording what it was. Hand submit() a
      // synthesized origin entry (fresh id — this message was never queued before) carrying every field a
      // held entry would have, so a give-up can restore it onto `live.pending` by identity instead of
      // discarding it after this call already returns `delivered:true`.
      this.submit(sessionId, text, route, ownerText, proactive, senderId, "immediate",
        [{ id: randomUUID(), text, source, onDeliver, route, kind, questionId, ownerText, proactive, senderId }]);
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
    live.pending.push({ id: randomUUID(), text, source, onDeliver, route, kind, questionId, ownerText, proactive, senderId });
    return { delivered: false, position: live.pending.length, reason: "held" };
  }

  /**
   * Card df5e37e7: record that the daemon has received an HTTP request on this session's
   * loom-orchestration MCP route (called from gateway/server.ts's /mcp-orch/:sessionId handler, before
   * dispatching to OrchestrationMcpRouter — so even a request whose handling later errors still counts
   * as "the client reached us"). Idempotent; a no-op for an unknown/dead session or one already marked.
   * Wakes every pending waitForMcpSeen caller. See Live.mcpSeen for why this proxy signal exists.
   */
  markMcpSeen(sessionId: string): void {
    const live = this.live.get(sessionId);
    if (!live?.alive || live.mcpSeen) return;
    live.mcpSeen = true;
    const waiters = live.mcpSeenWaiters;
    live.mcpSeenWaiters = [];
    for (const w of waiters) w(true);
  }

  /**
   * Card df5e37e7: resolve once this session's loom-orchestration MCP route has been hit (markMcpSeen)
   * or `timeoutMs` elapses, whichever first — NEVER rejects, so a caller's `.then()` is always safe to
   * fire unconditionally. Resolves `true` immediately if already seen; `false` immediately for an
   * unknown/dead session (nothing to wait for); `false` if the session dies while waiting (see
   * pty.onExit) or the timeout fires first. Callers must treat `false` as "proceed anyway" (today's
   * behavior), never as an error — this is a best-effort proxy signal, not a guarantee.
   */
  waitForMcpSeen(sessionId: string, timeoutMs: number = MCP_READY_TIMEOUT_MS): Promise<boolean> {
    const live = this.live.get(sessionId);
    if (!live?.alive) return Promise.resolve(false);
    if (live.mcpSeen) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (seen: boolean): void => {
        if (settled) return;
        settled = true;
        resolve(seen);
      };
      live.mcpSeenWaiters.push(done);
      setTimeout(() => done(false), timeoutMs);
    });
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
   * Loom Companion (proactive event-line producer): whether the session's IN-FLIGHT (or most-recently
   * formed) turn was a daemon-driven proactive submit — a heartbeat/reminder/attention-push alert — rather
   * than an owner inbound or an ordinary system/human inject. Mirrors {@link getActiveTurnOrigin} exactly
   * (caller-supplied at submit()/enqueueStdin, persists until the next submit() overwrites it, false for an
   * unknown/dead session). The companion's chat_reply reads this to tag its outbound frame + persisted
   * history row so the web chat renders the amber event line instead of an ordinary bubble.
   */
  getActiveTurnIsProactive(sessionId: string): boolean {
    return this.live.get(sessionId)?.activeTurnProactive ?? false;
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
   * Companion injection-guard Primitive A WIDENING (card 2b26035c, "recent-turns verbatim acceptance") —
   * sibling to {@link getActiveTurnOwnerText}: the bounded, most-recent-first ring of the last
   * {@link RECENT_OWNER_TURNS_WINDOW} authenticated owner-turn texts, so a lever can accept a candidate
   * that's a verbatim substring of a RECENT turn (a cross-turn correction/re-phrase), not just the one
   * currently in flight. UNLIKE `getActiveTurnOwnerText`, this does NOT clear at Stop — that's the whole
   * point (the window must survive past the turn it was formed on). Every entry is still literal,
   * server-attested owner inbound bytes from the SAME source as Primitive A (see Live.recentOwnerTurns'
   * doc) — only the turn scope widens, never the authentication. Empty array for an unknown/dead session
   * or one with no owner-authored turn yet.
   */
  getRecentOwnerTurns(sessionId: string): string[] {
    return this.live.get(sessionId)?.recentOwnerTurns.slice() ?? [];
  }

  /**
   * Companion Trust Window (Companion Capability & Permission-Lever Framework, card 0): the AUTHENTICATED
   * sender id of the session's IN-FLIGHT turn, for a GROUP-scope companion route only — null for a DM
   * route or a non-companion-inbound turn (see Live.activeTurnSenderId). Read by the trust-window/friction
   * helper to key a group route's arm/isWarm window per-sender, so one member's confirm never covers
   * another's acts. Returns null for an unknown/dead session.
   */
  getActiveTurnSenderId(sessionId: string): string | null {
    return this.live.get(sessionId)?.activeTurnSenderId ?? null;
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
   * A copy of a session's queued entries (id + text + source + kind) in FIFO order — for the human-facing
   * UI, which needs the stable id to delete/edit/reorder a SPECIFIC entry (see QueuedMessage), and `source`
   * + `kind` to tell which entries it may mutate (see {@link isHumanMutable}): the human's own composed
   * turns and Loom's own `kind:"warning"` nudges are actionable; an agent-authored `kind:"agent"` entry
   * renders read-only. Returns [] for an unknown session. Entries are shallow-copied so a caller can't
   * mutate the live FIFO through them.
   */
  getPendingEntries(sessionId: string): Array<Pick<QueuedMessage, "id" | "text" | "source" | "kind">> {
    // Strip the internal `onDeliver` callback — the UI only needs {id,text,source,kind}, and a function
    // must never escape the host (it isn't serializable and is meaningless outside this process).
    return (this.live.get(sessionId)?.pending ?? []).map(({ id, text, source, kind }) => ({ id, text, source, kind }));
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
   * Drop still-queued `[loom:worker-idle]` / `[loom:worker-spawn-broken]` nudges for ONE worker from its
   * manager's pending FIFO (auditor finding 2e3a8e6f — delivery-vs-watchdog TIMING race). Mirrors
   * `purgeQueuedByQuestionIds`'s exact mechanics (synchronous splice, no drain/submit boundary crossed) but
   * keys off the nudge's own literal text prefix — these nudges predate `questionId`-style tagging and
   * already embed the workerSessionId in their text (`classifyIdleWorker`'s queued-report guard matches the
   * same way).
   *
   * WHY THIS EXISTS: `notifyManagerOfIdleWorker` classifies and enqueues a nudge the INSTANT a worker goes
   * idle (or on IdleWatcher's periodic re-check) — correct when computed. But if the manager is BUSY at
   * that moment the nudge just QUEUES (delivered:false) and only drains on the manager's NEXT turn
   * boundary. A manager can reply to that very worker (`messageWorker`/`redirectWorker`) LATER IN THE SAME
   * still-in-flight turn — re-engaging it — and only then end its turn, at which point the STALE queued
   * nudge (computed before the reply) drains as if it were fresh, falsely claiming "it IS parked awaiting
   * your reply" to a manager that already replied. Called on the worker's OWN busy(false→true) edge
   * (index.ts's onBusy hook) — an objective, unambiguous "no longer idle" signal, whether that edge came
   * from a manager reply or the worker resuming on its own — so any not-yet-delivered nudge about it is
   * purged the instant it goes stale, before it can ever drain into the manager's turn. A worker that STAYS
   * idle (no busy edge) never has its queued nudge touched, so a genuinely-stranded worker's nudge still
   * fires exactly as before — this only ever removes a nudge whose premise ("still idle") has since become
   * false.
   */
  purgeQueuedWorkerIdleNudges(managerSessionId: string, workerSessionId: string): QueuedMessage[] {
    const live = this.live.get(managerSessionId);
    if (!live?.alive) return [];
    const prefixes = [`[loom:worker-idle] worker ${workerSessionId} `, `[loom:worker-spawn-broken] worker ${workerSessionId}`];
    const removed: QueuedMessage[] = [];
    for (let i = live.pending.length - 1; i >= 0; i--) {
      const m = live.pending[i]!;
      if (prefixes.some((p) => m.text.startsWith(p))) {
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
   * MUTABILITY GATE — delete/reorder use {@link isHumanMutable}: a HUMAN-MUTABLE entry is the human's
   * OWN composed turns (`source:"human"`) OR Loom's OWN operational injections (`kind:"warning"` —
   * idle/context/busy-stuck watchdog nudges, restart/boot continuation notes, rate-limit/memory-recall).
   * EDIT is narrower — it uses {@link isHumanEditable} (`source:"human"` only): a `kind:"warning"` Loom
   * nudge may be deleted or reordered but not rewritten, since its wording is Loom's, not the human's
   * (matches the web UI, `SessionQueue.tsx`'s `isEditable = source === "human"`). Any op aimed at an
   * agent-AUTHORED entry (`source:"system"` + `kind:"agent"` — a worker→manager report, manager→worker
   * direction, a Lead session_message, a companion inbound) is REFUSED — it returns false WITH
   * `refused:true` (the REST layer maps that to a 403) and leaves the entry untouched, so an agent's
   * queued message can never be deleted, rewritten, or reordered out from under it. (A missing id stays
   * a plain false with no `refused` — it's not a boundary violation, just a lost race with the drain.)
   */
  deleteQueued(sessionId: string, id: string): { deleted: boolean; refused?: boolean } {
    const live = this.live.get(sessionId);
    if (!live?.alive) return { deleted: false };
    const i = live.pending.findIndex((m) => m.id === id);
    if (i < 0) return { deleted: false }; // already drained / unknown id — safe no-op
    if (!this.isHumanMutable(live.pending[i]!)) return { deleted: false, refused: true }; // agent-authored — read-only
    live.pending.splice(i, 1);
    return { deleted: true };
  }

  editQueued(sessionId: string, id: string, text: string): { edited: boolean; refused?: boolean } {
    const live = this.live.get(sessionId);
    if (!live?.alive) return { edited: false };
    const m = live.pending.find((m) => m.id === id);
    if (!m) return { edited: false }; // already drained / unknown id — safe no-op
    if (!this.isHumanEditable(m)) return { edited: false, refused: true }; // not the human's own text — read-only
    m.text = text; // identity (id) and FIFO position preserved; only the body changes
    return { edited: true };
  }

  /**
   * Which held entries the HUMAN may DELETE or REORDER. Two classes qualify (owner-directed
   * 2026-07-11 — the human owns the daemon, so both their own and Loom's own queued text are theirs to clear):
   *   • `source:"human"` — the human's OWN composed turns (any kind);
   *   • `kind:"warning"` — Loom's OWN operational injections (idle/context/busy-stuck watchdog nudges like
   *     `[loom:worker-idle]`, restart/boot continuation notes, rate-limit/usage nudges, memory-recall) —
   *     Loom-authored, NOT a message from another agent, so removing/repositioning one harms nobody.
   * The ONE protected class is `source:"system"` + `kind:"agent"` — a message AUTHORED by an agent or a
   * human TO this recipient (worker→manager report, manager→worker direction/redirect, Lead session_message,
   * companion inbound) — which must never be deleted, rewritten, or reordered out from under the running
   * orchestration. (`source:"human"` entries are always `kind:"agent"` in practice, hence the OR, not AND.)
   *
   * NOTE: this is DELETE/REORDER's gate only — EDIT is narrower (see {@link isHumanEditable}): a
   * `kind:"warning"` Loom nudge may be cleared or repositioned, but its wording is Loom's own, not the
   * human's, so it is not rewritable — matches the web UI (`SessionQueue.tsx`'s `isEditable`).
   */
  private isHumanMutable(m: QueuedMessage): boolean {
    return m.source === "human" || m.kind === "warning";
  }

  /**
   * Which held entries the HUMAN may EDIT (rewrite the text of). Narrower than {@link isHumanMutable}:
   * only the human's OWN composed turns (`source:"human"`) qualify — a `kind:"warning"` Loom nudge is
   * deletable/reorderable (see isHumanMutable) but its wording belongs to Loom, not the human, so it is
   * NOT editable. Mirrors the web UI's own gate (`SessionQueue.tsx`'s `isEditable = source === "human"`).
   */
  private isHumanEditable(m: QueuedMessage): boolean {
    return m.source === "human";
  }

  /**
   * Reorder the held FIFO. Only HUMAN-MUTABLE entries (see {@link isHumanMutable}) may move: `orderedIds`
   * is their desired order, and the permutation is applied IN PLACE within the slots those entries
   * currently occupy — every agent-AUTHORED (`source:"system"` + `kind:"agent"`) entry keeps its absolute
   * FIFO position, so a human reorder can never reposition (or jump ahead of) a worker report / manager
   * direction. Reconciled against the CURRENT queue: ids not present are skipped (drained/unknown), and any
   * mutable entry NOT named (e.g. one enqueued after the client's snapshot) is preserved and appended after
   * the named ones in its existing relative order — so a reorder can never silently drop a message. REFUSED
   * (reordered:false, refused:true) if any named id targets an agent-authored entry — the UI never sends
   * one, so this is a guard against a hand-rolled request. Returns reordered:false (no refused) only for a
   * dead/unknown session.
   */
  reorderQueued(sessionId: string, orderedIds: string[]): { reordered: boolean; refused?: boolean } {
    const live = this.live.get(sessionId);
    if (!live?.alive) return { reordered: false };
    const byId = new Map(live.pending.map((m) => [m.id, m] as const));
    // Boundary guard: a named id that resolves to an agent-authored entry is a trust-boundary violation —
    // refuse the whole op rather than silently dropping that id (which would let a caller probe the queue).
    for (const id of orderedIds) {
      const m = byId.get(id);
      if (m && !this.isHumanMutable(m)) return { reordered: false, refused: true };
    }
    // Desired order of the MUTABLE entries: named-first (present, mutable, deduped), then any un-named
    // mutable entries in their existing relative order.
    const seen = new Set<string>();
    const mutableSeq: QueuedMessage[] = [];
    for (const id of orderedIds) {
      const m = byId.get(id);
      if (m && this.isHumanMutable(m) && !seen.has(id)) { mutableSeq.push(m); seen.add(id); }
    }
    for (const m of live.pending) if (this.isHumanMutable(m) && !seen.has(m.id)) { mutableSeq.push(m); seen.add(m.id); }
    // Rebuild in place: agent-authored entries hold their slot; each mutable slot takes the next from mutableSeq.
    let hi = 0;
    const next = live.pending.map((m) => (this.isHumanMutable(m) ? mutableSeq[hi++]! : m));
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
   * PUBLIC read of the same composer-dirty signal (see deferForHumanDraft), for restart-intent capture
   * (SessionService.liveFleetResumeSet): a daemon restart kills this pty — and the uncommitted raw-
   * terminal draft living only in its (and the engine's) in-memory composer state dies with it, with
   * NOTHING to replay (unlike the `pending` FIFO, which is Loom-owned text and survives via the intent
   * snapshot). A draft this size commonly IS a large paste the terminal has collapsed to a
   * "[Pasted text #N]" placeholder — capturing this lets resumeFleetOnBoot tell the resumed agent that
   * loss explicitly instead of leaving it silently unaccounted for. Returns false for an unknown/dead
   * session id (nothing to report) rather than throwing.
   */
  isComposerDirty(sessionId: string): boolean {
    const live = this.live.get(sessionId);
    return !!live && this.deferForHumanDraft(live);
  }

  /**
   * Clear a phantom 'busy' (busy with no engine output for a stale window) so its queue can drain.
   * A session that has NEVER started its first turn (`!firstTurnStarted`) uses the much SHORTER
   * FIRST_TURN_STALE_MS instead of `busyStaleMs` — there's no such thing as a legitimately long tool
   * call before turn 1 has even started, so stale output there already means broken (a lost kickoff
   * race the STARTUP_PROMPT_GRACE_MS fallback didn't recover, or an engine that never got past boot),
   * and it should surface via the onBusy→notifyManagerOfIdleWorker path fast rather than sit masked as
   * "busy" for the full 5-minute window. Once a real turn starts, the normal, more generous window applies.
   *
   * Card b64b3726: also closes the ORPHANED COMPOSER half of a false give-up suppression. sendEnterAndVerify
   * can suppress its own give-up recovery (card 71de1f9c) when it reads output after the final Enter write —
   * but that read can be fooled (our own paste-reassert write provokes a deterministic engine response, or a
   * viewer's repaint() does), and when it is, `live.enterConfirmed` stays false FOREVER: nothing else can ever
   * flip it, because nothing can call submit() again (the sole writer of `lastPrompt`/`enterConfirmed=false`)
   * while `live.busy` stays stuck true — enqueueStdin only submits immediately when `!live.busy`. So a session
   * that reaches THIS stale-busy branch still carrying `enterConfirmed: false` is exactly a give-up that was
   * wrongly suppressed (or any other path that leaves an unconfirmed submit stranded) — the OLD version of
   * this method cleared `busy` but never un-typed the composer, so the stranded injection survived and the
   * NEXT drainPending submit pasted on top of it (reintroducing the exact concatenation card ee082fbb fixed).
   * Reuse that SAME mechanism here — do not invent a second clear path: an exact-count Backspace burst
   * (`live.lastPrompt.length`), gated on `composerLen === 0` (card e1829591 — never touch a real human draft),
   * with `setBusy(false)` threaded through the burst's own completion (writeChunked's `done` callback) so a
   * concurrent enqueueStdin can't interleave a new turn's paste into the still-draining backspaces. This is
   * deliberately UNCONDITIONAL on *why* enterConfirmed is false — robust to vectors nobody has enumerated yet,
   * not just the two this card investigated.
   *
   * A turn that's LEGITIMATELY still confirmed-and-running never reaches this branch at all: UserPromptSubmit
   * sets `enterConfirmed = true` AND re-arms `busySince` (rising edge) the moment the turn actually starts, so
   * a merely-slow-to-confirm turn's staleness clock restarts before `staleMs` can elapse — belt-and-suspenders
   * with the `enterConfirmed` check itself.
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
      if (!live.enterConfirmed && live.composerLen === 0 && live.lastPrompt) {
        // eslint-disable-next-line no-console
        console.log(`[heal] ${sessionId} clearing an orphaned give-up injection (${live.lastPrompt.length} chars, composer otherwise empty) while healing stuck busy`);
        this.writeChunked(sessionId, BACKSPACE.repeat(live.lastPrompt.length), () => this.setBusy(sessionId, false, "heal-if-stuck-clear"));
      } else {
        this.setBusy(sessionId, false, "heal-if-stuck-stale");
      }
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
    // A caller is HOLDING the drain (card d88163b7's `holdDrain`) → do NOT promote a queued message into a
    // turn. The caller is deciding whether to interrupt this session and needs anything that would start a
    // NEW turn to stay in `pending`, recoverable via `flushPending`, instead of vanishing into an active
    // turn the caller's own `pty.stop()` would then kill with no way to recapture it.
    if (live.drainHeld) return;
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
    this.submit(sessionId, drained.map((m) => m.text).join(DRAIN_SEPARATOR), drained[0]!.route, drained[0]!.ownerText, drained[0]!.proactive, drained[0]!.senderId, "drain", drained); // one submit, one busy re-arm, FIFO order preserved, ONE route (+ ONE ownerText/proactive/senderId — the head's, mirroring the route); `drained` doubles as the give-up origin (card 441499ee) — same objects, so identity is preserved for free
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
  /**
   * Card 1bd1f045: the byte/call-sequence log for the ACTUAL `pty.write()` call — called INLINE at every
   * real write site (never a layer above them), so it records what genuinely reached node-pty, not what
   * the daemon merely composed/handed down. That distinction matters: `[submit-write]` (submit()'s own
   * pre-write log) was overclaimed as proof the write path is clean and retracted twice — everything from
   * here down was, until this card, completely uninstrumented in both directions (see 3ce3fa39).
   *
   * Discriminates the two surviving hypotheses for that card's mid-token splice: if the daemon itself
   * double-emits (e.g. `writeChunked`'s `done` callback firing more than once, unguarded by
   * `submitGeneration` — card 9ed20572), TWO `[pty-write]` records with the same content signature at
   * distinct `seq` appear here. If the daemon writes exactly once and corruption still appears at the
   * receiving end, this log shows a single clean record and the fault is BELOW the daemon (ConPTY/
   * node-pty/Windows). Either outcome is a real result.
   *
   * `seq` is the load-bearing field: a monotonic per-session counter (Live.writeSeq) that makes a
   * duplicated or out-of-order emission visible AS a sequence anomaly rather than plausible traffic.
   *
   * RECORD SIZE (card review, 2026-07-23): a head+tail excerpt was the first cut but measured at ~100-150
   * bytes/record — at 17 call sites, some firing per-chunk on every 15KB+ payload, that risked shrinking
   * daemon-output.log's rotation window (the SAME forensic corpus 3ce3fa39/9ed20572 depend on) faster than
   * it fills today, which would make a rare recurrence HARDER to catch, not easier. `fnv1a32` replaces the
   * excerpt with a fixed 8-hex-char content fingerprint — every field the card's DoD names (sessionId, seq,
   * submitGeneration, len, a cheap hash) stays, nothing load-bearing for duplicate/replay detection is
   * dropped, and the record shrinks by roughly half regardless of chunk size. `tag` names WHICH call site
   * wrote (bracket-start/chunk/bracket-end/enter/…) so a reader doesn't have to infer it from content.
   *
   * OBSERVATION ONLY: this is a passthrough. It must never alter what's written, its outcome, or its
   * timing relative to a bare `live.pty.write(data)` call — do not add anything here that could change
   * write behaviour.
   */
  private ptyWrite(sessionId: string, live: Live, data: string, tag: string): void {
    const seq = ++live.writeSeq;
    // eslint-disable-next-line no-console
    console.log(`[pty-write] ${sessionId} seq=${seq} tag=${tag} gen=${live.submitGeneration} len=${data.length} h=${fnv1a32(data)}`);
    live.pty.write(data);
  }

  private submit(sessionId: string, text: string, route?: TurnRoute, ownerText?: string, proactive = false, senderId?: string | null, reason: string = "queue", origin?: QueuedMessage[]): void {
    const live = this.live.get(sessionId);
    if (!live?.alive) return;
    // Card 441499ee: remember the ORIGINAL queued message(s) this turn's text came from — see
    // `Live.giveUpOrigin`'s doc. `origin` is undefined for the two direct submit() callers that don't
    // originate from enqueueStdin (rate-limit replay, kickoff guarantee), so this stays byte-identical
    // (null) for them, exactly like every other per-turn field this change didn't touch.
    live.giveUpOrigin = origin ?? null;
    // DIAGNOSTIC ONLY (card 1f74080a instrumentation, no control-flow change): `reason` names WHICH of the
    // four call sites is writing this turn — the two queue-mediated ones ("immediate"/"drain", both already
    // busy-gated) and the two DIRECT-write bypasses (resumeAfterRateLimit's "rate-limit-replay", and
    // scheduleKickoffGuarantee's "kickoff-guarantee") that write to the pty WITHOUT going through
    // drainPending's queue. `busyBefore` is the alarm signal: a write landing while the daemon already
    // believes the session is busy means either a real double-turn race, or (more likely, per the a3814193
    // incident) that `live.busy` had already gone stale via one of the out-of-band clears (see the `[busy]`
    // log this same instrumentation adds to setBusy) — this line is what lets a future recurrence be
    // diagnosed straight from daemon-output.log instead of requiring an engine-transcript cross-reference.
    // eslint-disable-next-line no-console
    console.log(`[submit-write] ${sessionId} reason=${reason} busyBefore=${live.busy} len=${text.length} head=${JSON.stringify(text.slice(0, 60))}`);
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
    // Companion injection-guard Primitive A widening (card 2b26035c): append this turn's owner text to
    // the bounded recent-turns ring, UNLESS it's undefined (no owner-authored turn — same guard as
    // activeTurnOwnerText above). Unlike activeTurnOwnerText, this is NEVER cleared at Stop — it's meant
    // to persist across the turn boundary so a later turn's lever call can still see it.
    if (ownerText !== undefined) {
      live.recentOwnerTurns.unshift(ownerText);
      if (live.recentOwnerTurns.length > RECENT_OWNER_TURNS_WINDOW) live.recentOwnerTurns.length = RECENT_OWNER_TURNS_WINDOW;
    }
    // Companion Trust Window: pin the turn's authenticated sender id the SAME way — undefined/null for
    // every non-group-companion caller, so activeTurnSenderId stays null exactly like activeTurnOwnerText
    // does for a non-owner-authored turn. lastPromptSenderId mirrors lastPromptOwnerText for replay.
    live.activeTurnSenderId = senderId ?? null;
    live.lastPromptSenderId = senderId ?? null;
    // Loom Companion (proactive event-line producer): pin whether THIS turn is a daemon-driven proactive
    // submit, caller-supplied — false for every existing caller this change didn't touch. Persists like
    // activeTurnRoute (not cleared at Stop); `lastPromptProactive` mirrors lastPromptRoute for replay.
    live.activeTurnProactive = proactive;
    live.lastPromptProactive = proactive;
    live.enterConfirmed = false; // this submit's Enter has not landed yet — see sendEnterAndVerify
    // NEW generation for THIS submit — the value sendEnterAndVerify's chain captures and checks on every
    // fire, so a chain left over from a PRIOR turn (already superseded by this fresh submit) recognizes
    // it's stale and bails instead of acting on this turn's `enterConfirmed`/`busy` state (CR-caught
    // overlap, card 9549e322 review — see the field doc on `Live.submitGeneration`).
    const gen = ++live.submitGeneration;
    this.ptyWrite(sessionId, live, BRACKET_PASTE_START, "bracket-start");
    // Chunk the text — a long turn (e.g. a worker report) sent as one pty.write is truncated by
    // ConPTY. Close the paste + send Enter only AFTER the last chunk lands, else it submits a partial.
    this.writeChunked(sessionId, text, () => {
      const l = this.live.get(sessionId);
      if (!l?.alive) return;
      this.ptyWrite(sessionId, l, BRACKET_PASTE_END, "bracket-end");
      const delay = SUBMIT_ENTER_DELAY_MS + pasteSettleExtraMs(text.length); // scale the first attempt's gap with paste size
      setTimeout(() => this.sendEnterAndVerify(sessionId, 1, gen), delay);
    });
    this.setBusy(sessionId, true, reason); // M1: optimistic, SYNCHRONOUS — see the M1 INVARIANT note above. Keep last; keep sync.
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
   *  - Not confirmed and out of attempts → GIVE-UP SUPPRESSED (card 71de1f9c) if the engine produced any
   *    output after this final Enter write — that's strong evidence the Enter registered and a turn is
   *    actually running, just with a slow-to-confirm hook; do nothing and let the real Stop/UserPromptSubmit
   *    (however late) finalize normally. Otherwise (genuinely no output at all) → GIVE-UP RECOVERY: log an
   *    error, recover busy (setBusy(false)) so the session is never left busy=true with an unsent composer
   *    forever, AND clear the stranded injection
   *    (card ee082fbb) — but ONLY when `composerLen === 0`. `composerLen` tracks ONLY human raw-terminal
   *    keystrokes (never our own `pty.write`), so `===0` proves the composer holds NOTHING but this
   *    give-up'd injection — a human never got a chance to start a draft during the failed retries (if one
   *    did, `composerLen > 0` and we leave the box alone; `deferForHumanDraft`'s existing hold still
   *    protects it — see card e1829591, never destroy a user's uncommitted draft). This is exactly the
   *    HUMAN-DRAFT SAFETY half of the fix; the CLEAR-EFFICACY half (does a clear byte actually empty a
   *    real multi-line composer, or does it truncate/strand a partial remnant?) needed real-engine
   *    validation, not just hermetic bytes-written assertions:
   *
   *    REAL-CLAUDE FINDINGS (claude 2.1.207, card ee082fbb probe — test/_probe-composer-clear{,-2}.mjs):
   *      - The TUI COLLAPSES a multi-line/long bracketed paste into a single "[Pasted text #N +K lines]"
   *        placeholder token — the raw lines are NOT individually editable once pasted.
   *      - A single Esc does NOT clear it — it only ARMS a "Esc again to clear" confirm; a second Esc (or
   *        any other key right after) leaves the composer in an inconsistent, still-dirty state. REJECTED.
   *      - Ctrl-U (kill-line) cleared the COLLAPSED placeholder in one shot (it reads as one "line" to
   *        readline-style kill semantics) — but on a SHORT multi-line paste that stayed under the
   *        placeholder-collapse threshold (rendered as literal editable lines, not a placeholder), Ctrl-U
   *        only killed the CURRENT line and SILENTLY STRANDED the earlier line(s) — confirmed via the
   *        engine's own transcript, which recorded the stranded first line concatenated with the next
   *        turn. Exactly the "partial clear worse than concatenation" risk this card was deferred over.
   *        REJECTED as a general-purpose clear.
   *      - Exact-count Backspace (`\x7f` × the injected text's length) reliably emptied the composer in
   *        EVERY case tested: the collapsed placeholder (backspace #1 deletes the whole atomic token, the
   *        rest floor at 0 and no-op — safe even though the count overshoots the placeholder's own visual
   *        length; a VERSION-PINNED assumption about claude 2.1.207's composer/backspace handling — worth
   *        re-verifying against the probes if a future claude version changes that behavior), a short
   *        un-collapsed multi-line paste (backspace walks back through the embedded newlines exactly like
   *        nextComposerLen's own counting model), and a single-line paste. ADOPTED.
   *    The exact length to un-type is `live.lastPrompt` — already the literal text `submit()` pinned for
   *    THIS turn (line ~3007) — so no new state is needed; give-up walks it back char-by-char via the
   *    same `writeChunked` large-write path submit() itself uses (a giant Backspace burst is just as
   *    subject to ConPTY's write-size limits as a giant paste).
   *
   * VALIDATED against a real claude engine (v2.1.206, card 9549e322 review item ②): forcing
   * SUBMIT_VERIFY_TIMEOUT_MS well below a normal UserPromptSubmit round-trip (so the retry ALWAYS fires a
   * real second Enter into an already-genuinely-submitted, still-generating turn) still produced exactly
   * ONE UserPromptSubmit + ONE Stop for the one logical turn sent — the redundant bare `\r` landing on the
   * by-then-empty, mid-generation composer is INERT (no stray blank turn, no corruption). A retry firing
   * into a turn that actually already started is therefore harmless; the real risk this loop guards
   * against is a retry NOT firing when the Enter genuinely never registered.
   *
   * RETRY re-asserts the paste-close too (card 97558183): `submit()`'s own `BRACKET_PASTE_END` write is
   * JUST as fire-and-forget as the Enter it precedes, and the SAME ConPTY drop class can lose it. When it
   * does, Ink stays mid-paste and swallows every retried `\r` as paste CONTENT (never a submit) — worse,
   * each swallowed byte resets Ink's paste idle-timer, actively preventing self-heal, so the old code's
   * bare-Enter retry could NEVER recover from this and would burn all attempts before giving up. Every
   * retry (attempt > 1; the FIRST attempt follows immediately after submit()'s own END write, so
   * re-asserting there would just be redundant) re-sends a zero-length `START+END` pair — not a bare END
   * — as ONE write, before the `\r`:
   *   - Already closed (the common case — only the Enter dropped, not the END): Ink is idle, sees a fresh
   *     START immediately followed by END, and treats it as an empty paste — a true no-op. A bare END
   *     alone sent while idle is NOT verified safe (Ink may not recognize an out-of-context terminator the
   *     same way a fresh START+END pair is defined to behave either idle or mid-paste — see this file's
   *     own `CONTROL_CHAR_RE` note for the sibling risk of a stripped-ESC CSI turning into literal text).
   *   - Still genuinely open (the bug): the extra bytes fold in as a few stray literal paste-content
   *     characters, but END is found and the paste closes — recovering the turn (submitted with a small
   *     cosmetic tail) instead of losing it entirely after 4 failed attempts.
   * Real-`claude` confirmation of both branches (does an idle START+END truly no-op; does a still-open
   * paste truly close and submit with just a small stray tail) is the Lead's live-verification pass — the
   * fake pty this file's own test drives can't model Ink's paste state machine, only that the BYTES this
   * host writes are exactly what's intended.
   *
   * Card b64b3726 Half 1: on the FINAL attempt only (`attempt === SUBMIT_MAX_ATTEMPTS`), this re-assert is
   * itself a confirmed output source INSIDE the give-up branch's own anchor window (see
   * `REASSERT_SETTLE_POLL_MS`'s doc for the measured evidence) — a Code Reviewer finding on this method's
   * own suppression logic below. The fix is SEQUENCING, not detection: let the re-assert's response (if
   * any) land BEFORE writing this attempt's Enter and capturing `enterWrittenAt`, via `awaitReassertSettle`
   * (bounded, observed not guessed). Intermediate retries (attempt 2/3 here) never consult `lastOutputAt` —
   * only the give-up branch below does — so they skip straight to `fireEnterAndVerify` unchanged; waiting
   * there would tax every retry chain for zero discriminating benefit.
   */
  private sendEnterAndVerify(sessionId: string, attempt: number, gen: number): void {
    const live = this.live.get(sessionId);
    if (!live?.alive || live.enterConfirmed || live.submitGeneration !== gen) return;
    if (attempt > 1) {
      this.ptyWrite(sessionId, live, BRACKET_PASTE_START + BRACKET_PASTE_END, "reassert-paste");
      if (attempt === SUBMIT_MAX_ATTEMPTS) {
        const reassertWrittenAt = Date.now();
        this.awaitReassertSettle(sessionId, gen, reassertWrittenAt, 0, () => this.fireEnterAndVerify(sessionId, attempt, gen));
        return;
      }
    }
    this.fireEnterAndVerify(sessionId, attempt, gen);
  }

  /**
   * Bounded, observed wait for the give-up attempt's own paste-reassert to settle before its Enter is
   * written — see `sendEnterAndVerify`'s doc and `REASSERT_SETTLE_POLL_MS`'s measured-distribution comment
   * for why this exists and how the bound was sized. Re-checks the SAME bail condition as every other link
   * in this chain (`!alive || enterConfirmed || submitGeneration !== gen`) on every poll — a superseded or
   * already-confirmed turn abandons here rather than proceeding to write a now-meaningless Enter.
   */
  private awaitReassertSettle(sessionId: string, gen: number, reassertWrittenAt: number, polls: number, onDone: () => void): void {
    const live = this.live.get(sessionId);
    if (!live?.alive || live.enterConfirmed || live.submitGeneration !== gen) return;
    if (live.lastOutputAt > reassertWrittenAt || polls >= REASSERT_SETTLE_MAX_POLLS) { onDone(); return; }
    setTimeout(() => this.awaitReassertSettle(sessionId, gen, reassertWrittenAt, polls + 1, onDone), REASSERT_SETTLE_POLL_MS);
  }

  /**
   * Card 441499ee: bounded, OBSERVED wait for `enterConfirmed` to flip true — see
   * `GIVE_UP_CONFIRM_SETTLE_POLL_MS`'s doc for why this is short and deliberately does not try to cover
   * the full hook-confirmation latency distribution. Called from the GIVE-UP branch of `fireEnterAndVerify`
   * the instant the OUTPUT discriminator (`lastOutputAt`) has already failed to suppress it — this is a
   * SEPARATE, independent check against a DIFFERENT signal (the hook-set `enterConfirmed`, not inferred
   * output), not a change to that discriminator's own logic.
   *
   * UNLIKE `awaitReassertSettle`, the caller needs to know WHY this settled — `confirmed:true` (a hook
   * arrived; treat exactly like GIVE-UP SUPPRESSED, do nothing else) vs `confirmed:false` (the bound
   * elapsed with no confirmation; proceed to GIVE-UP RECOVERY) lead to entirely different actions — so
   * `onSettled` takes that boolean. Mirrors `awaitReassertSettle`'s bail-silently-without-calling-back
   * shape for the dead/superseded case: if this generation is no longer live or has been superseded by a
   * newer submit(), there is nothing of THIS generation's left to confirm or recover, so it simply stops
   * (the newer submit's own give-up chain, if it ever needs one, runs this same check fresh under its own
   * generation).
   */
  private awaitGiveUpConfirmSettle(sessionId: string, gen: number, polls: number, onSettled: (confirmed: boolean) => void): void {
    const live = this.live.get(sessionId);
    if (!live?.alive || live.submitGeneration !== gen) return; // stale/dead — this generation is moot, nothing to confirm or recover
    if (live.enterConfirmed) { onSettled(true); return; }
    if (polls >= GIVE_UP_CONFIRM_SETTLE_MAX_POLLS) { onSettled(false); return; }
    setTimeout(() => this.awaitGiveUpConfirmSettle(sessionId, gen, polls + 1, onSettled), GIVE_UP_CONFIRM_SETTLE_POLL_MS);
  }

  /** Write this attempt's Enter and arm its verify-timeout — the second half of `sendEnterAndVerify`,
   *  split out so the give-up attempt can route through `awaitReassertSettle` first. */
  private fireEnterAndVerify(sessionId: string, attempt: number, gen: number): void {
    const live = this.live.get(sessionId);
    if (!live?.alive || live.enterConfirmed || live.submitGeneration !== gen) return; // re-check: state may have changed during the settle wait
    this.ptyWrite(sessionId, live, ENTER, "enter");
    // Anchor for the give-up branch's liveness check below — captured for THIS attempt's own Enter write,
    // never an earlier one (each attempt gets its own closure). See the give-up branch's comment for why.
    const enterWrittenAt = Date.now();
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
        // Card 71de1f9c: most give-ups are FALSE NEGATIVES — the Enter genuinely registered and a turn is
        // running, only the confirming hook's round-trip is slow (observed under fleet load: 79% of a
        // measured sample of give-ups WERE followed by a UserPromptSubmit for the same session). Treating
        // every give-up as a real failure is actively harmful, not just imprecise: clearing busy here
        // reopens enqueueStdin's `!live.busy` immediate-submit path, so the NEXT message can land — and get
        // interleaved with — a turn that is actually still generating (the owner-reported "text sitting in
        // the input field, unsent" symptom). Distinguish the two cases with `lastOutputAt` (bumped on every
        // real pty.onData chunk, already used the same way by healIfStuck): if the engine produced ANY
        // output after THIS attempt's own Enter write, the Enter almost certainly reached and registered
        // with the engine — by attempt>1 (always true at give-up in production), the reassert above already
        // guaranteed the paste was closed going into this Enter, so a landed keystroke here can only be a
        // real submit, not paste-content-swallowing. Anchoring on the FINAL Enter write (not on submit()'s
        // own start) is required: the pasted body's own render bumps lastOutputAt within the very first
        // attempt, long before give-up, so anchoring any earlier makes the check vacuously true and useless.
        // Real-engine measurement (not a guess): a claude sitting genuinely idle at the composer emitted
        // ZERO pty output over an 85+ second observation window on this project's own live fleet, while a
        // concurrently-busy session's output stream grew continuously in the same window — confirming idle
        // claude does not emit periodic output (no spinner/repaint chatter) that could make this discriminator
        // misfire on a genuine drop. If this read is ever wrong regardless, healIfStuck's existing stale
        // backstop (busySince AND lastOutputAt both stale) still recovers a truly-wedged session — just not
        // as fast as this branch would have.
        //
        // REJECTED ALTERNATIVE — do not "simplify" this back into a bigger SUBMIT_VERIFY_TIMEOUT_MS. Give-
        // ups are CONTENTION-DRIVEN BURSTS, not uniformly-distributed slow hooks (measured: median gap
        // between consecutive give-ups is 12 log lines vs ~39 expected under a uniform distribution, 34% land
        // within 10 lines of each other, and local [submit]+[hook] log density around a give-up is 54.3 vs
        // 43.7 baseline — give-ups cluster where the daemon is already busy). A larger constant is therefore
        // LOAD-SENSITIVE: it just relocates the threshold to wherever fleet contention happens to peak next,
        // the same anti-pattern this project has hit and reverted repeatedly (cards 595aad10, fea23514,
        // 0fa5beef). Keying on `lastOutputAt` instead is LOAD-TOLERANT — it asks "did the engine actually do
        // something" rather than "did enough wall-clock time pass," so it stays correct regardless of how
        // bad the contention gets.
        if (l.lastOutputAt > enterWrittenAt) {
          // eslint-disable-next-line no-console
          console.log(`[submit] ${sessionId} GIVE-UP SUPPRESSED after ${attempt} Enter attempts — engine produced output after the final Enter write (turn likely already running; hook confirmation just late); leaving busy=true for the real Stop/UserPromptSubmit to finalize`);
          return;
        }
        // Card 441499ee (hardening — card 04de8bbf measured ~86% of give-ups reaching THIS point are
        // followed by a confirming hook, i.e. the OUTPUT discriminator above just missed a turn that
        // actually started): before committing to GIVE-UP RECOVERY — which requeues the text — give
        // `enterConfirmed` one short, bounded, OBSERVED last chance to flip true. This is a SEPARATE check
        // against a DIFFERENT signal than the discriminator above (the hook itself, not inferred output);
        // it does not change that discriminator's own logic. See `awaitGiveUpConfirmSettle`'s doc for why
        // this is short and does not try to cover the full hook-latency distribution — `purgeConfirmedGiveUpRequeue`
        // remains the defense-in-depth for a confirmation that arrives after this window closes.
        this.awaitGiveUpConfirmSettle(sessionId, gen, 0, (confirmed) => {
          if (confirmed) {
            // eslint-disable-next-line no-console
            console.log(`[submit] ${sessionId} GIVE-UP SUPPRESSED after ${attempt} Enter attempts — a confirming hook arrived during the post-give-up settle wait (turn actually started; the output discriminator missed it, but the hook proves it); leaving busy/composer untouched`);
            return;
          }
          const l2 = this.live.get(sessionId);
          if (!l2?.alive || l2.enterConfirmed || l2.submitGeneration !== gen) return; // re-check: state may have changed during the settle wait
          // eslint-disable-next-line no-console
          console.error(`[submit] ${sessionId} GIVE-UP RECOVERY after ${attempt} Enter attempts — no engine output observed since the final Enter write; turn never confirmed started; recovering busy so the session doesn't wedge`);
          // card ee082fbb: clear the stranded injection — ONLY when the composer holds nothing but it (no
          // human draft started during the failed retries; see the class doc above for the composerLen===0
          // safety reasoning and the real-claude findings behind exact-backspace as the clear mechanism).
          //
          // `attempt > 1` (always true at give-up in production — SUBMIT_MAX_ATTEMPTS defaults to 4) is a
          // CHEAP proxy for "the paste bracket is closed": THIS attempt's own `if (attempt > 1)` re-assert
          // above already wrote a fresh START+END pair immediately before ITS Enter (card 97558183's
          // documented behavior — idle → true no-op, still-open → closes it with a small stray tail), so by
          // the time this verify-timeout elapses a paste-close was already attempted for this exact attempt.
          // Skip the clear (fall back to the pre-fix stray-text behavior) when that never happened — a
          // degenerate SUBMIT_MAX_ATTEMPTS=1 (env-only, never true in production) reaches give-up at
          // attempt===1 with NO re-assert ever sent, so paste-open is unverified there; sending raw `\x7f`
          // bytes into a genuinely-still-open paste would fold them in AS PASTE CONTENT (composer becomes
          // `lastPrompt + backspaces` — strictly worse than the documented pre-fix concatenation). Residual
          // risk even when attempt>1: that SAME re-assert write could itself also drop (a second, independent
          // ConPTY drop stacked on the original Enter drop) — not mitigated further here; a paste-markers-
          // then-Backspace sequence was outside the real-claude probe's validated scope (only START+END+Enter
          // was probed), so we don't stack another unverified re-assert on top of the burst.
          if (l2.composerLen === 0 && l2.lastPrompt && attempt > 1) {
            // eslint-disable-next-line no-console
            console.log(`[submit] ${sessionId} clearing the stranded give-up injection (${l2.lastPrompt.length} chars, composer otherwise empty)`);
            // Thread setBusy(false) through the burst's OWN completion, not fired alongside it: writeChunked
            // is only synchronous for text ≤ PTY_WRITE_CHUNK_BYTES — a large lastPrompt (a worker report /
            // manager direction routinely exceeds it) becomes N chunks across event-loop ticks, and busy
            // gates enqueueStdin's immediate-submit path (~this.enqueueStdin's `!live.busy` check). Clearing
            // busy before the burst finishes would reopen that gate mid-burst: an inbound message landing in
            // the window would submit a NEW turn whose own BRACKET_PASTE_START+chunks interleave with our
            // still-draining backspaces on the pty's FIFO — a silent, corrupted/truncated turn. submit() itself
            // follows this same discipline (its own post-write Enter is gated behind writeChunked's `done`).
            this.writeChunked(sessionId, BACKSPACE.repeat(l2.lastPrompt.length), () => {
              this.setBusy(sessionId, false, "give-up-recovery-cleared");
              this.requeueGiveUpOrigin(sessionId, gen); // card 441499ee — see the method doc
            });
          } else {
            this.setBusy(sessionId, false, "give-up-recovery");
            this.requeueGiveUpOrigin(sessionId, gen); // card 441499ee — see the method doc
          }
        });
      }
    }, SUBMIT_VERIFY_TIMEOUT_MS);
  }

  /**
   * Card 441499ee: the second half of GIVE-UP RECOVERY — called AFTER `setBusy(false)` has actually
   * landed (threaded through the backspace-clear's own completion when there is one, exactly like
   * `setBusy` itself, so a still-draining clear burst can't be raced by a promoted turn). Restores
   * `live.giveUpOrigin` (the exact message(s) this failed submit came from — see that field's doc) onto
   * the FRONT of `live.pending` — converting the silent loss into delayed-but-real delivery on the NEXT
   * natural drain trigger (a Stop hook for some other turn, the box-free transition, or the ~10s reconcile
   * tick, which already exists precisely to drain anything a session's own Stop hook can't reach — see
   * `reconcile()`). Deliberately does NOT force an immediate `drainPending` itself: give-up already has no
   * live turn to interleave with, so the ordinary drain triggers are sufficient, and forcing one here would
   * make EVERY give-up (even a lone, otherwise-idle session) immediately re-arm busy and retry a second
   * full attempt cycle in place — which is exactly the behavior the sibling give-up tests
   * (pty-giveup-clear.mjs, pty-giveup-clear-single-attempt.mjs, pty-giveup-false-negative.mjs) correctly
   * assert does NOT happen for their own (single-cycle) scenarios. `unshift` (not push) preserves FIFO
   * order relative to anything that queued WHILE this message was stuck retrying: that message was
   * logically first, so it goes back in front of newer arrivals — and because `live.busy` stayed true for
   * this session's entire failed-retry window, nothing else could have started running, so this can never
   * jump ahead of or interleave with an actual in-flight turn.
   *
   * BOUNDED by `GIVE_UP_REQUEUE_LIMIT`: a message already at its requeue budget is dropped for real here
   * (loudly logged) instead of requeued again — a message that keeps giving up and requeuing forever
   * would be worse than the original silent drop. `giveUpRequeues` is tracked per MESSAGE OBJECT/id, never
   * inferred from matching text, so two legitimately identical messages are bounded independently.
   *
   * SAFETY AGAINST A FALSE-NEGATIVE GIVE-UP (card 04de8bbf's neighbourhood — production measurement found
   * GIVE-UP RECOVERY firing while the turn actually HAD started, zero SUPPRESSED in that sample): the
   * discriminator deciding RECOVERY-vs-SUPPRESSED can itself be wrong, so a requeued entry stamps
   * `giveUpGen: gen` — the generation its failed submit ran under — precisely so `purgeConfirmedGiveUpRequeue`
   * can find and drop it the instant a confirming hook proves that generation's turn actually ran, instead
   * of letting it drain later as a silent duplicate of a message that already landed.
   */
  private requeueGiveUpOrigin(sessionId: string, gen: number): void {
    const live = this.live.get(sessionId);
    if (!live?.alive) return;
    const origin = live.giveUpOrigin;
    live.giveUpOrigin = null;
    if (!origin || origin.length === 0) return;
    const kept: QueuedMessage[] = [];
    for (const m of origin) {
      const requeues = (m.giveUpRequeues ?? 0) + 1;
      if (requeues > GIVE_UP_REQUEUE_LIMIT) {
        // eslint-disable-next-line no-console
        console.error(`[submit] ${sessionId} GIVE-UP RECOVERY: message ${m.id} (${m.text.length} chars) exhausted its requeue budget (${GIVE_UP_REQUEUE_LIMIT}) after repeated give-ups — dropping for real instead of requeuing again`);
        continue;
      }
      kept.push({ ...m, giveUpRequeues: requeues, giveUpGen: gen });
    }
    if (kept.length > 0) {
      live.pending.unshift(...kept);
      // eslint-disable-next-line no-console
      console.log(`[submit] ${sessionId} GIVE-UP RECOVERY: re-queued ${kept.length} message(s) at the front of pending — will drain on the next Stop/reconcile`);
    }
  }

  /**
   * Card 441499ee: safety net for a FALSE-NEGATIVE give-up — production measurement (the card's own
   * neighbourhood, card 04de8bbf) found GIVE-UP RECOVERY firing while the turn had actually started (zero
   * SUPPRESSED in that sample), meaning the discriminator that decides RECOVERY-vs-SUPPRESSED can itself
   * be wrong. If RECOVERY already requeued a duplicate copy of that turn's text (see
   * `requeueGiveUpOrigin`'s `giveUpGen` tag) and were left to drain later, it would silently re-submit a
   * message whose original ALREADY landed — converting a fixed silent-drop bug into a NEW silent-duplicate
   * bug. `UserPromptSubmit` and `Stop`/`StopFailure` are the two hooks that PROVE a turn actually ran
   * (this file's own long-standing convention — either is definitive even if the other was lost), so both
   * call this the instant they fire: any still-pending entry tagged with the CURRENT `submitGeneration` is
   * for the turn that JUST proved it started, so it's purged before it can ever be delivered.
   *
   * Correlation works because `submitGeneration` only advances inside `submit()` — if nothing has
   * resubmitted for this session since the failed attempt gave up, `live.submitGeneration` at hook-arrival
   * time is STILL that same attempt's generation, so this needs no extra bookkeeping beyond the tag already
   * on the entry. Narrower residual (out of THIS card's scope, tracked by 04de8bbf): if a reconcile tick
   * beats a merely-late hook to the punch and resubmits the requeued entry FIRST (bumping the generation
   * before the confirmation arrives), this purge no longer finds anything to remove — the entry is already
   * out being resubmitted under its own new generation. That ordering needs the discriminator itself fixed,
   * not a bigger purge window; this closes the far more common case where the hook (even late) still beats
   * the next drain trigger.
   */
  private purgeConfirmedGiveUpRequeue(sessionId: string, live: Live): void {
    const gen = live.submitGeneration;
    for (let i = live.pending.length - 1; i >= 0; i--) {
      if (live.pending[i]!.giveUpGen === gen) {
        const [dropped] = live.pending.splice(i, 1);
        // eslint-disable-next-line no-console
        console.warn(`[submit] ${sessionId} GIVE-UP RECOVERY was a false negative — a confirming hook proves the original turn actually started; purged the requeued duplicate (${dropped!.text.length} chars) instead of letting it double-deliver`);
      }
    }
  }

  /**
   * §19c-b resume: re-submit the turn the usage cap killed (lastPrompt) once the reset passes. Goes
   * out via submit() (re-arms busy); the held pending queue then drains normally on the next Stop.
   * Returns false if the session isn't live (already stopped/killed → caller does not resume).
   *
   * Card 7edd420b: a PARKED (rateLimited) session is alive-but-idle, not dying — so an UNRELATED stop can
   * overlap it: a plain pty.stop() (live.stopping) or a companion upgrade's holdDrain window
   * (live.drainHeld, see that method's doc) can both be mid-flight the instant this fires (the 60s
   * rate-limit-watcher tick, or a human clearing the park via REST). Pre-fix this method guarded on
   * `alive` only, so it would write the replayed turn straight into that dying/held pty — a write that
   * races the kill, is never recorded in `pending` (so `flushPending` can't recover it), and is simply
   * lost. `blocked` closes that: when either flag is set, route the replay through `enqueueStdin` instead
   * of a direct `submit()` — the SAME queuing primitive `drainPending`'s own turn-starting site already
   * falls back to when it can't submit safely. That HOLDS the prompt in `live.pending` rather than writing
   * it into the pty, and a caller that's actively draining `pending` before the pty actually exits
   * (upgradeCompanionCapabilities's holdDrain loop is exactly this) recovers and redelivers it onto the
   * fresh pty after the respawn — preserving the turn instead of merely declining to lose it noisily. A
   * plain stop() with no such capture (drainHeld never set) still clears `pending` itself before anything
   * can recover it (see stop()), so the prompt CAN still be lost on that narrower path — but only ever as
   * a quietly-dropped queue entry, never by corrupting a dying pty's write.
   *
   * Card 81f9c887 (defense-in-depth, mirrors `enqueueStdin`'s own idle-submit gate re-checking rather than
   * trusting its caller): also guard on `live.busy`. The invariant `rateLimited ⇒ !busy` (rateLimited is
   * only ever set inside the Stop/StopFailure handler AFTER setBusy(false)) means a genuinely parked
   * session is never busy — so hitting this on a BUSY session only happens when a caller invokes it against
   * a session that was never actually parked (e.g. the per-session `POST /rate-limit/clear` REST route has
   * no server-side busy/parked guard of its own, and `live.lastPrompt` is set by ANY submit(), not just a
   * rate-limit kill). That's a caller error, not a real resume — replaying `lastPrompt` there would
   * re-submit it as a SECOND turn on top of the one already in flight (the exact double-turn hazard the
   * M1/M2 busy-gate ordering exists to prevent). Skip the replay entirely rather than queuing it: unlike
   * the stopping/drainHeld case, there is no genuinely-held turn here to preserve — queuing would just
   * deliver the same stale duplicate a moment later instead of on top of the live one.
   */
  resumeAfterRateLimit(sessionId: string): boolean {
    const live = this.live.get(sessionId);
    if (!live?.alive) return false;
    // DIAGNOSTIC ONLY (card 1f74080a instrumentation, no control-flow change): log EVERY invocation,
    // including the branch that ends up doing nothing (lastPrompt null, or busy true) — that silent-skip
    // branch previously left NO trace at all, which is exactly the gap that made the a3814193 incident's
    // caller unconfirmable from the daemon log alone. `wasRateLimited` records whether this call's own
    // precondition (the session was actually parked) held BEFORE we unconditionally clear it below — a
    // call arriving with `wasRateLimited=false` is the exact "caller invoked this on a session that was
    // never actually parked" hazard this function's own doc comment already names.
    // eslint-disable-next-line no-console
    console.log(`[rate-limit-resume] ${sessionId} invoked wasRateLimited=${live.rateLimited} busy=${live.busy} lastPromptLen=${live.lastPrompt?.length ?? 0}`);
    // UNPARK: drop the suppress flag FIRST so the re-submitted turn (and the post-resume Stop drain of the
    // held queue) can proceed. submit() re-arms busy, so the reconcile drain stays no-op until that turn ends.
    live.rateLimited = false;
    // Replay the killed turn WITH its original route (lastPromptRoute) so a rate-limited companion inbound
    // still replies to the channel it came from after the reset (§19c-b + companion route routing). Also
    // replay its lastPromptOwnerText so Primitive A's attestation survives the kill-and-resume too, and its
    // lastPromptProactive so a rate-limited heartbeat/reminder/alert turn's replayed chat_reply is still
    // tagged as proactive.
    if (live.lastPrompt != null && !live.busy) {
      const blocked = live.stopping || live.drainHeld;
      if (blocked) {
        this.enqueueStdin(sessionId, live.lastPrompt, "system", undefined, live.lastPromptRoute ?? undefined, "agent", undefined, live.lastPromptOwnerText ?? undefined, live.lastPromptProactive, live.lastPromptSenderId);
      } else {
        this.submit(sessionId, live.lastPrompt, live.lastPromptRoute ?? undefined, live.lastPromptOwnerText ?? undefined, live.lastPromptProactive, live.lastPromptSenderId, "rate-limit-replay");
      }
    }
    return true;
  }

  /**
   * Persist + broadcast the turn-in-flight flag, and track it locally. Idempotent.
   *
   * `reason` (card 1f74080a instrumentation, DIAGNOSTIC ONLY — no control-flow change) tags WHICH of the
   * several call sites flipped busy, so a future "duplicate delivery" incident can reconstruct the exact
   * busy-window from `[busy]` log lines alone instead of requiring an engine-transcript dig (the ONLY
   * reason the a3814193 incident's mechanism took two people and a JSONL cross-reference to pin down).
   * Every call site below is updated to pass one; there is deliberately no default, so a future new call
   * site can't silently go unlabeled.
   */
  private setBusy(sessionId: string, busy: boolean, reason: string): void {
    const live = this.live.get(sessionId);
    if (!live) return;
    const prevBusySince = live.busySince;
    live.busy = busy;
    live.busySince = busy ? Date.now() : null; // track the rising edge for the stuck-busy heal
    // eslint-disable-next-line no-console
    console.log(`[busy] ${sessionId} -> ${busy ? "true" : "false"} (${reason})${!busy && prevBusySince != null ? ` afterMs=${Date.now() - prevBusySince}` : ""}`);
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
   *
   * SERIALIZED per session (card 9c03f5a6) via `Live.modeCycleChain`: every caller — the boot
   * convergence above, `logLandedMode`'s plan auto-heal, and `setPermissionMode`'s manager-driven
   * override — funnels through this one entry point, which QUEUES onto that chain rather than running
   * immediately. Two `cycleToMode` runs sharing one session's pty/footer would otherwise interleave their
   * Shift+Tab presses and footer reads (each mistaking the OTHER's press for its own registered change),
   * converging to whichever cycle's target happens to win the race — this is exactly how a
   * `worker_set_mode` call issued right after spawn (a natural pattern: push a freshly-spawned worker
   * straight into its working mode) could land on the BOOT cycle's own default target ("auto") instead of
   * the one actually requested. Queueing guarantees each cycle starts from a footer state no other cycle
   * is concurrently mutating.
   */
  private cycleToMode(sessionId: string, target: LandedMode, onDone: () => void): void {
    const live = this.live.get(sessionId);
    if (!live) { onDone(); return; }
    const runQueued = (): Promise<void> => new Promise((resolveChain) => {
      this.runCycleToMode(sessionId, target, () => {
        onDone();
        resolveChain();
      });
    });
    // Chain off whatever is currently in flight for this session (never let a prior link's rejection
    // break the chain — runQueued itself never rejects, but stay defensive for any future caller).
    live.modeCycleChain = live.modeCycleChain.then(runQueued, runQueued);
  }

  /** The actual press-and-verify cycle loop, run EXCLUSIVELY (see cycleToMode's queueing above) — never
   *  call this directly; go through `cycleToMode`. */
  private runCycleToMode(sessionId: string, target: LandedMode, onDone: () => void): void {
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
      this.ptyWrite(sessionId, live, SHIFT_TAB, "shift-tab");
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
   * Resolve the resume-summary gate (see `isResumeSummaryGate`/`resumeGateCursorOption`) by pressing
   * Down EXACTLY ONCE and then CONFIRMING the ❯ cursor actually landed on option 2 "Resume full session
   * as-is" before ever sending Enter — replacing the old blind fire-and-forget Down+(150ms later)Enter
   * pair that caused the 2026-07-10 incident (a delayed/reordered Down under restart load let Enter
   * confirm the still-default option 1 "Resume from summary", silently compacting three managers' full
   * context simultaneously).
   *
   * Code-review catch on the first draft of this fix: a version that RETRIED the Down (re-pressing once
   * the current press's poll window elapsed unconfirmed) reintroduced the exact class of bug it was
   * meant to kill — if Down #1 was merely SLOW to render (not dropped), a retried Down #2 could land
   * right after, overshooting the cursor 1→2→3 and selecting "Don't ask me again" (worse than the
   * original bug: that persists the gate-disable AND still compacts this turn). So this presses Down
   * ONCE and never again for the normal path — the poll BUDGET is generous (RESUME_GATE_MAX_POLLS) rather
   * than the press being retried, which makes a two-Down-in-flight race structurally impossible.
   *
   * Defensive-only (should be unreachable with a single Down ever written): if the cursor is ever read at
   * option 3 anyway, this corrects with exactly ONE Up press (never a second Down) and keeps polling —
   * see the "3" branch below. NO path may confirm/Enter while the cursor reads "3": that would durably
   * persist "don't ask me again" (an ONGOING config change) on top of still compacting this one time,
   * which is a strictly worse outcome than the belt-and-suspenders give-up (still sends Enter — the
   * pre-fix behavior — but only when the cursor is NOT known to be sitting on 3).
   *
   * This is the belt-and-suspenders fallback, not the primary defense — see the caller's doc comment:
   * writeSessionSettings' env override is meant to keep this gate from ever rendering for a Loom-spawned
   * session, so this loop should rarely if ever actually run in production.
   */
  private resolveResumeGate(sessionId: string): void {
    const live = this.live.get(sessionId);
    if (!live?.alive || live.resumeGateHandled) return;
    this.ptyWrite(sessionId, live, DOWN_ARROW, "resume-gate-down");
    this.awaitResumeGateConfirm(sessionId, 0, false);
  }

  /** Poll (read-only — no further Down keypress) for the resume-gate cursor to confirm option 2 after
   *  the one Down press; see resolveResumeGate for the full rationale. `upCorrected` tracks whether the
   *  one-time defensive Up-correction (for an unreachable-in-normal-operation option-3 read) has already
   *  fired, so it can only ever happen once. */
  private awaitResumeGateConfirm(sessionId: string, polls: number, upCorrected: boolean): void {
    setTimeout(() => {
      const live = this.live.get(sessionId);
      if (!live?.alive || live.resumeGateHandled) return;
      const cursor = resumeGateCursorOption(collapseBoot(live.resumeGateScan));
      if (cursor === "2") {
        live.resumeGateHandled = true;
        live.resumeGateScan = "";
        // eslint-disable-next-line no-console
        console.log(`[pty] ${sessionId} resume-summary gate CONFIRMED on "Resume full session as-is" after ${polls} poll(s)${upCorrected ? " (following a defensive Up-correction)" : ""} — Enter`);
        this.ptyWrite(sessionId, live, ENTER, "resume-gate-enter");
        return;
      }
      if (cursor === "3" && !upCorrected) {
        // Should be unreachable — this loop writes exactly one Down and never a second keypress on this
        // path. Correct with exactly ONE Up (not a Down retry) and keep polling; never confirm/Enter here.
        // eslint-disable-next-line no-console
        console.error(`[pty] ${sessionId} resume-summary gate cursor unexpectedly on option 3 ("Don't ask me again") — correcting with a single Up (never confirming on 3)`);
        this.ptyWrite(sessionId, live, UP_ARROW, "resume-gate-up");
        this.awaitResumeGateConfirm(sessionId, 0, true);
        return;
      }
      if (polls < RESUME_GATE_MAX_POLLS) {
        this.awaitResumeGateConfirm(sessionId, polls + 1, upCorrected);
        return;
      }
      // Genuine give-up: the one Down (± the one defensive Up-correction) never confirmed option 2 within
      // a generous budget — a real dropped keystroke (rare; PRIMARY-prevented by the settings env
      // override). NEVER send Enter while still reading option 3 — that would durably persist "don't ask
      // me again" on top of still compacting this turn, strictly worse than leaving the gate on screen.
      // Every other read (1, or unreadable) falls back to the pre-fix behavior (send Enter anyway) rather
      // than stranding an otherwise-recoverable gate forever.
      if (cursor === "3") {
        live.resumeGateHandled = true;
        live.resumeGateScan = "";
        // eslint-disable-next-line no-console
        console.error(`[pty] ${sessionId} resume-summary gate still on option 3 after the give-up budget — NOT sending Enter (would durably persist "don't ask me again"); leaving the gate on screen`);
        return;
      }
      live.resumeGateHandled = true;
      live.resumeGateScan = "";
      // eslint-disable-next-line no-console
      console.error(`[pty] ${sessionId} resume-summary gate cursor NEVER confirmed on option 2 after ${polls} poll(s) — sending Enter anyway (best effort; may resume from a summary)`);
      this.ptyWrite(sessionId, live, ENTER, "resume-gate-enter-giveup");
    }, RESUME_GATE_POLL_MS);
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
      // Card 78a16dc5 (mirrors resumeAfterRateLimit's card-81f9c887 fix): `firstTurnStarted` is set ONLY
      // by the UserPromptSubmit hook, which CAN be lost (see the Stop/StopFailure handler's own comment) —
      // so this can fire while a turn genuinely already ran and its Stop's own drainPending() just started
      // writing a QUEUED message. A direct submit() here would race THAT in-flight writeChunked chain —
      // its own staggered pty.write()s would interleave with this one's, splicing two different messages
      // together mid-word (the observed corruption).
      //
      // `busy` alone is NOT the right signal for "a write is genuinely in flight": it is ALSO true from
      // spawn()'s own OPTIMISTIC set (the common, intended case this guarantee exists for — a spawn whose
      // CLI-arg turn never even attempted to start) with NO submit() ever having run — deferring on bare
      // `busy` would wrongly hold the kickoff in `pending` FOREVER in exactly that case, since nothing will
      // ever fire a Stop to drain it (worker-kickoff-guarantee.mjs's H1a/H1e/H1f pinned this regression).
      // The precise signal is `submitGeneration > 0 && !enterConfirmed`: `submitGeneration` only advances
      // inside submit() itself (never by the spawn-time optimistic setBusy), so `0` means "no submit() has
      // EVER run for this pty" (direct-write is unconditionally safe — nothing to race); `enterConfirmed`
      // is reset false at the TOP of every submit() and only flips true once that turn's Enter is verified
      // (UserPromptSubmit/Stop/StopFailure) — so `>0 && !confirmed` means "the most recent submit's
      // writeChunked chain may still be stepping, or is at least not yet verified done" — the actual
      // interleave hazard. `stopping`/`drainHeld`/`rateLimited` are separate, orthogonal reasons a direct
      // write is unsafe (a dying/held/parked pty) that submit() itself does not check.
      //
      // Either way, route through the SAME serialized primitive every other write uses when a direct write
      // isn't safe RIGHT NOW: enqueueStdin still GUARANTEES delivery (held FIFO, drained atomically at the
      // next safe boundary — never dropped), it just never races an in-flight write. kind:"agent" — this is
      // substantive directed content (the kickoff itself), not a bracket-tagged Loom nudge, so it drains
      // alone (not coalesced) and is exempt from the [loom:*] shape guard below (scoped to "warning" only).
      // Tolerated rare duplicate (CR-noted): if `rateLimited` is what makes this branch unsafe, resumeAfterRateLimit
      // will INDEPENDENTLY replay `lastPrompt` once unparked — and lastPrompt is USUALLY still this exact
      // kickoff (nothing else has submitted yet). That means the kickoff can be delivered TWICE (the
      // enqueued copy below, plus resumeAfterRateLimit's own replay) rather than lost — strictly better
      // than pre-fix (which could interleave/corrupt it), and rare enough (needs a lost UserPromptSubmit
      // hook AND a rate-limit park on the SAME never-confirmed turn) not to special-case further here.
      const submitOutstanding = l.submitGeneration > 0 && !l.enterConfirmed;
      if (submitOutstanding || l.stopping || l.drainHeld || l.rateLimited) {
        // eslint-disable-next-line no-console
        console.log(`[pty] ${sessionId} startup-prompt grace elapsed with no turn started, but unsafe to write directly (submitOutstanding=${submitOutstanding} stopping=${l.stopping} drainHeld=${l.drainHeld} rateLimited=${l.rateLimited}) — queuing the kickoff for atomic delivery instead of racing an in-flight write`);
        this.enqueueStdin(sessionId, kickoff, "system", undefined, undefined, "agent");
        return;
      }
      // eslint-disable-next-line no-console
      console.log(`[pty] ${sessionId} startup-prompt grace elapsed with no turn started — force-submitting the kickoff`);
      this.submit(sessionId, kickoff, undefined, undefined, undefined, undefined, "kickoff-guarantee");
    }, STARTUP_PROMPT_GRACE_MS);
  }

  /**
   * OBSERVABILITY + defense-in-depth landed-mode auto-heal (card f05e4897 / b99d3d67 / 1658fc22 /
   * 9c03f5a6) — record, to the daemon log, what permission mode a (re)spawned session actually LANDED in
   * once it settled (mode-cycles/gate handling done + markReady), and — the auto-heal — if a Loom-DRIVEN
   * role with `ExitPlanMode` disallowed (any role `disallowedToolsForRole` disallows it for — worker,
   * setup, auditor, workspace-auditor, run, assistant) is found resting SOMEWHERE OTHER than its intended
   * boot target, drive it back onto that target via the SAME feedback-verified `cycleToMode` primitive the
   * main convergence path uses, not a single blind press.
   *
   * WIDENED (card 9c03f5a6) from a plan-only trigger to the explicit {@link HEALABLE_MODES} set
   * (plan|acceptEdits|default|bypassPermissions — every definite reading short of `auto`, `"unknown"`
   * excluded by construction): `plan` was always the one landed mode such a role can NEVER self-exit
   * itself (its `ExitPlanMode` tool is structurally removed at spawn, and Claude Code's own permission
   * engine additionally gates ANY non-read-only MCP tool call — incl. the role's own report-up channel —
   * behind an unanswerable "ask" while in plan), but the SAME give-up-mid-cycle worst case that could
   * strand a session in plan can just as easily strand it ONE STEP SHORT of the working target — e.g.
   * resting in `acceptEdits` (the boot cycle's very first press never registers, so `runCycleToMode` gives
   * up at the RAW gate-free boot mode) — which is the OTHER stall the owner named: an unattended role
   * sitting in a mode that hasn't earned an allowlist entry for the command it needs stalls on that
   * permission prompt exactly the same way. The heal's destination is the session's ACTUAL configured
   * target (`healTarget` below — the SAME `resumeModeTarget ?? modeAfterCyclesFromAcceptEdits(...)`
   * expression the main SessionStart convergence path computes), not a hardcoded `auto` — every
   * platform-default (`startupModeCycles:2`) session still converges there, but a project that deliberately
   * sets `startupModeCycles:0` (stay at the gate-free acceptEdits boot mode) is honoured on BOTH fresh
   * spawn and resume instead of resume alone getting force-cycled past its own target. `noCyclingConfigured`
   * below excludes a null-or-acceptEdits target rather than fighting that deliberate choice.
   *
   * A single blind corrective press would have the same drop risk as the failure it's healing (card
   * 1658fc22): if IT also drops under load, the session stays stranded with no further retry. Routing
   * through cycleToMode instead reads the footer and retries (bounded) until it reaches the target or the
   * pty dies, exactly like the main path — so a dropped press just costs one more poll, not a permanent
   * strand. This is a BACKSTOP, independent of cycleToMode's own convergence logic invoked from the main
   * SessionStart path (which stays unchanged for that caller — see cycleToMode's doc comment): it fires
   * off the mode ACTUALLY read from the footer, regardless of why the session ended up there. A
   * manager/platform session is structurally excluded (`disallowedToolsForRole` never puts `ExitPlanMode`
   * in their list — they may separately carry the task-tracking disallow, which this check ignores), so
   * this never fights a manager's legitimate, human-approved entry into plan mode (or any other mode).
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
    // The heal's destination is the session's ACTUAL configured target, not a hardcoded "auto" — the
    // SAME expression the main SessionStart convergence path uses (see the `target` computed there), so
    // a project that deliberately configures NO cycling (startupModeCycles:0) converges to `acceptEdits`
    // on BOTH fresh spawn and resume instead of resume alone getting force-cycled past it to `auto`. A
    // resume always carries a definite `resumeModeTarget` (SessionService.resume derives it from the SAME
    // `startupModeCycles`, so `cycles:0` → `acceptEdits`, never `null`) — the fresh path is the one that
    // can genuinely have no target (`startupModeCycles:0` and no `resumeModeTarget`).
    const healTarget = live.resumeModeTarget ?? (live.startupModeCycles > 0 ? modeAfterCyclesFromAcceptEdits(live.startupModeCycles) : null);
    const noCyclingConfigured = healTarget == null || healTarget === "acceptEdits";
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
      if (!noCyclingConfigured && healTarget != null && HEALABLE_MODES.has(mode) && l.alive && disallowedToolsForRole(role).includes("ExitPlanMode")) {
        // eslint-disable-next-line no-console
        console.log(`[resume-mode] ${sessionId} auto-heal: role=${role ?? "-"} landed in ${mode} (ExitPlanMode disallowed) — cycling to ${healTarget}`);
        this.cycleToMode(sessionId, healTarget, () => {});
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
    // DIAGNOSTIC ONLY (card 1f74080a instrumentation, no control-flow change): this is the ONE write path
    // with NO busy gate at all (by design — a real human must always be able to type) and the ONLY caller
    // is the gateway's raw websocket `{type:"stdin"}` relay (an attached client), so anything landing here
    // is either a genuine keystroke or something upstream mistakenly relaying non-human bytes through the
    // human channel. Threshold-gated (>20 chars) so this doesn't become a per-keystroke firehose — a lone
    // key is a handful of bytes; a pasted paragraph (the shape a stray report replay would take) is not.
    if (live && data.length > 20) {
      // eslint-disable-next-line no-console
      console.log(`[stdin-write] ${sessionId} busy=${live.busy} len=${data.length} head=${JSON.stringify(data.slice(0, 60))}`);
    }
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
      this.ptyWrite(sessionId, l, text.slice(i, i + PTY_WRITE_CHUNK_BYTES), "chunk");
      i += PTY_WRITE_CHUNK_BYTES;
      if (i >= text.length) { done?.(); return; }
      setTimeout(step, PTY_WRITE_CHUNK_DELAY_MS);
    };
    step();
  }

  repaint(sessionId: string): void {
    const live = this.live.get(sessionId);
    if (live?.alive) this.ptyWrite(sessionId, live, "\x0c", "repaint-ctrl-l"); // Ctrl-L
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
    this.ptyWrite(sessionId, live, "\x03", "stop-ctrl-c");
    setTimeout(() => { if (live.alive) this.ptyWrite(sessionId, live, "\x03", "stop-ctrl-c"); }, GRACEFUL_STOP_GAP_MS);
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
      this.ptyWrite(sessionId, live, "\x03", "stop-escalate-ctrl-c");
      setTimeout(() => { if (live.alive) this.ptyWrite(sessionId, live, "\x03", "stop-escalate-ctrl-c"); }, GRACEFUL_STOP_GAP_MS);
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
    if (!live?.alive || live.stopping || !live.ready || !live.busy) {
      // eslint-disable-next-line no-console
      console.log(`[pty] ${sessionId} redirect: Esc NOT sent (nothing in flight to interrupt — alive=${!!live?.alive} stopping=${live?.stopping} ready=${live?.ready} busy=${live?.busy})`);
      return; // nothing in flight to interrupt
    }
    const busySinceAtInterrupt = live.busySince; // snapshot: a NEW turn (re-armed busy) updates this
    // We are deliberately abandoning this turn's Enter — bump the generation so a still-pending
    // sendEnterAndVerify chain for it recognizes it's stale and bails (never retry-Enters or
    // give-up→setBusy(false)'s into the cancelled prompt or whatever the redirect submits next). See
    // Live.submitGeneration.
    live.submitGeneration++;
    this.ptyWrite(sessionId, live, ESC_KEY, "redirect-esc"); // single Esc: cancel the in-flight generation, return to the idle prompt
    // eslint-disable-next-line no-console
    console.log(`[pty] ${sessionId} redirect: Esc sent — settling for ${REDIRECT_SETTLE_MS}ms`);
    setTimeout(() => {
      const l = this.live.get(sessionId);
      if (!l?.alive || l.stopping || !l.ready) {
        // eslint-disable-next-line no-console
        console.log(`[pty] ${sessionId} redirect: settle bailed (died / a real stop won / never readied)`);
        return; // died / a real stop won / never readied → drop the self-clear
      }
      if (!l.busy) {
        // eslint-disable-next-line no-console
        console.log(`[pty] ${sessionId} redirect: settle no-op (a real Stop already cleared busy and drained)`);
        return; // a real Stop already cleared it (and drained) — nothing to heal
      }
      if (l.busySince !== busySinceAtInterrupt) {
        // eslint-disable-next-line no-console
        console.log(`[pty] ${sessionId} redirect: settle bailed (a NEW turn started since the Esc — not clobbering it)`);
        return; // a NEW turn started since the Esc — do NOT clobber its busy
      }
      // No Stop hook fired on the Esc-cancel → clear the stale busy OURSELVES and drain the redirect in the
      // SAME tick (the M2 window: strictly no await between setBusy(false) and drainPending), mirroring the
      // Stop branch. finalizingTurn arms the same tripwire so a future async leak here is caught loudly.
      // eslint-disable-next-line no-console
      console.log(`[pty] ${sessionId} redirect: settled — clearing stale busy and draining the redirect now`);
      this.finalizingTurn = true;
      try {
        this.setBusy(sessionId, false, "interrupt-for-redirect-settle");
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
   * this does not hand-roll its own keystroke cycling. `cycleToMode` itself now QUEUES onto the session's
   * `modeCycleChain` (card 9c03f5a6), so this override can never race the boot convergence / plan
   * auto-heal — it waits its turn and then cycles from an uncontested footer read. On top of that, this
   * wraps a bounded OUTER retry (`cycleToModeWithRetries`): a single cycleToMode pass can still miss the
   * exact target on a genuinely dropped keystroke, and the DoD is to keep retrying rather than accept a
   * neighbor mode on the first miss. Resolves with the FEEDBACK-VERIFIED landed mode read fresh off the
   * footer once cycling settles (which may still differ from `target` if every bounded attempt gave up —
   * the caller sees the truth, not an assumed success), or "unknown" if the session isn't live.
   */
  setPermissionMode(sessionId: string, target: LandedMode): Promise<LandedMode> {
    return this.cycleToModeWithRetries(sessionId, target, MODE_OVERRIDE_MAX_ATTEMPTS)
      .then((landed) => this.escapePlanIfStuck(sessionId, target, landed));
  }

  /**
   * Last-resort safety net (card 9c03f5a6 DoD) — a WORKING-mode request (acceptEdits|auto) must never be
   * reported as having left the worker resting in `plan`: a worker has no `ExitPlanMode` tool to self-exit
   * plan mode, so landing there is a silent STALL (can't edit) that wastes the worker's slot until a human
   * notices. If every bounded attempt in `cycleToModeWithRetries` still could not confirm the EXACT target
   * and the worker is resting in plan, make one more bounded push to `auto` (a single Shift+Tab away from
   * plan in the cycle order) — ANY safe working mode beats reporting "still in plan". A genuine
   * set-to-`plan` request, or a target that was already reached, passes through untouched.
   */
  private escapePlanIfStuck(sessionId: string, target: LandedMode, landed: LandedMode): Promise<LandedMode> {
    if (target === "plan" || landed !== "plan") return Promise.resolve(landed);
    return this.cycleToModeWithRetries(sessionId, "auto", MODE_OVERRIDE_MAX_ATTEMPTS);
  }

  /**
   * `setPermissionMode`'s bounded outer retry loop (card 9c03f5a6). Each attempt runs a full
   * `cycleToMode` pass (itself queued against any concurrent cycle) and re-reads the footer; a miss
   * re-attempts from that FRESH read (never reuses a stale one) until `attemptsLeft` is exhausted, so a
   * one-off dropped keystroke self-corrects instead of surfacing a non-target neighbor on the first try.
   * Stops immediately on an exact match or an "unknown" (dead session — retrying can't help). Bounded, so
   * a genuinely wedged footer still reports the honest landed mode rather than looping forever.
   */
  private cycleToModeWithRetries(sessionId: string, target: LandedMode, attemptsLeft: number): Promise<LandedMode> {
    return new Promise((resolve) => {
      if (!this.live.get(sessionId)?.alive) { resolve("unknown"); return; }
      this.cycleToMode(sessionId, target, () => {
        const live = this.live.get(sessionId);
        const landed: LandedMode = live?.alive ? this.readFooterMode(live) : "unknown";
        if (landed === target || landed === "unknown" || attemptsLeft <= 1) { resolve(landed); return; }
        resolve(this.cycleToModeWithRetries(sessionId, target, attemptsLeft - 1));
      });
    });
  }

  isAlive(sessionId: string): boolean {
    return this.live.get(sessionId)?.alive ?? false;
  }

  /** Whether a session's turn is CURRENTLY in flight — the same in-memory `live.busy` flag `setBusy`
   *  writes on every rising/falling edge (mirrored to the DB via `onBusy`, but read here directly with no
   *  DB round-trip). Card d88163b7: lets a caller that's about to force-interrupt a session (e.g. a
   *  companion capability upgrade) give an active turn a bounded chance to finish naturally first, instead
   *  of always cutting it off mid-generation. Returns false for a dead/unknown session — nothing is "in
   *  flight" there. */
  isBusy(sessionId: string): boolean {
    return this.live.get(sessionId)?.busy ?? false;
  }

  /**
   * Card d88163b7 (CR fix): suppress this session's drain surface — BOTH `drainPending`'s Stop-hook
   * auto-drain and `enqueueStdin`'s idle-submit path — until `releaseDrain` lifts it. For a caller that's
   * deciding WHETHER to interrupt a live session (e.g. a companion capability upgrade waiting out a busy
   * turn): without this, the turn ending (or a new message arriving) DURING that decision window can start
   * a fresh turn the caller's own subsequent `pty.stop()` then kills — invisible to `flushPending`, since
   * neither path ever leaves the message sitting in `pending` for it to recover. Holding the drain forces
   * anything that would start a turn to stay queued instead, exactly where `flushPending` CAN see it.
   *
   * DELIBERATELY a distinct flag from `stopping` (see `Live.drainHeld`) — `stopping` also means "this
   * session is being torn down" (`onExit` reads it to classify the death as intended), which is not yet
   * true here; the caller may still decide NOT to stop. A no-op for a dead/unknown session.
   *
   * The caller MUST pair this with `releaseDrain` — including on an abort/throw path — or this session's
   * drain stays suppressed forever (a worse wedge than the bug this exists to fix). Use try/finally.
   *
   * NOT RE-ENTRANT — `drainHeld` is a bool, not a counter, so an inner `releaseDrain` lifts an OUTER hold
   * wholesale. Safe today only because the sole caller (`CompanionController.upgrade`) serializes on a
   * single global reconcile chain, so two holds on the same session can never overlap. A future caller
   * that could nest holds would need a counter instead — don't add one speculatively; there is no such
   * caller today.
   */
  holdDrain(sessionId: string): void {
    const live = this.live.get(sessionId);
    if (live) live.drainHeld = true;
  }

  /** Lift a `holdDrain` suppression. A no-op for a dead/unknown session (nothing to release) — safe to
   *  call unconditionally, including from a `finally` after the session died mid-hold. Does NOT itself
   *  re-trigger a drain: the caller that held it is expected to `flushPending`/decide next, exactly as
   *  `upgradeCompanionCapabilities` does immediately after releasing. */
  releaseDrain(sessionId: string): void {
    const live = this.live.get(sessionId);
    if (live) live.drainHeld = false;
  }

  /** Epoch ms when this session's CURRENTLY LIVE pty process started, or null if it has no live process
   *  (never spawned, or exited). A resume/fork/recycle/companion-upgrade returns a fresh value (each goes
   *  through createPty). Read by the companion capability panel to decide whether a grant change is still
   *  pending a respawn to take effect (grant created AFTER this ⇒ not yet applied to the running process). */
  liveStartedAt(sessionId: string): number | null {
    const live = this.live.get(sessionId);
    return live && live.alive ? live.startedAt : null;
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
