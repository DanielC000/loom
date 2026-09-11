import { TRUST_DIALOG_MARKER, TRUST_DIALOG_ANSWER, BUSY_STATUS_MARKER, BUSY_TITLE_SPINNER_RE, CODEX_READY_PLACEHOLDER, CODEX_MODEL_LOADED_RE, stripAnsiCsi, normalizeCodexScreenText } from "./codex-doctrine.js";

/**
 * Multi-harness epic (df1f94b0) Phase 1, card 353f6dc4: the PURE, testable decision logic for the codex
 * stateful runtime — trust-dialog detect/answer, busy/idle detection, kickoff-ready detection, and
 * MCP-url→codex-argv translation.
 *
 * @decision 353f6dc4 — this file holds NO state and is never a session's Live/CodexLive entry point; the
 * real, wired runtime lives in pty/host.ts. Do not add state here or make this file the thing a session's
 * Live/CodexLive entry points at — that split is what keeps this out of the ~8,000-line host file.
 */

/** True iff `screen` (a raw pty-output frame, or any accumulated buffer of one) contains the
 *  undocumented first-use-per-directory trust dialog (`codex-doctrine.ts#TRUST_DIALOG_MARKER`) — checked
 *  BEFORE ever writing a real prompt, per the card's own landmine #1.
 *
 *  @decision c0933e57 — matched against {@link normalizeCodexScreenText}'s output, never raw `screen`
 *  directly: codex sometimes renders the marker's inter-word spaces as CSI cursor-forward instead of a
 *  literal space byte, which a raw `.includes()` can never match (see that function's own doc). */
export function isTrustDialogPrompt(screen: string): boolean {
  return normalizeCodexScreenText(screen).includes(TRUST_DIALOG_MARKER);
}

/** The keystroke sequence to write when {@link isTrustDialogPrompt} is true — accepts the highlighted
 *  "1. Yes, continue" option (see `codex-doctrine.ts#TRUST_DIALOG_ANSWER`'s own doc for why this is Enter
 *  on the default option, not a submitted prompt). */
export function trustDialogAnswer(): string {
  return TRUST_DIALOG_ANSWER;
}

/** True iff `screen` shows codex actively working — the status-line marker OR the title-bar spinner
 *  (`codex-doctrine.ts#BUSY_STATUS_MARKER`/`BUSY_TITLE_SPINNER_RE`). Idle is this function's ABSENCE from
 *  the LATEST frame, never the input-placeholder's presence (card's landmine #2 — the placeholder is
 *  static chrome shown during busy too). Callers must re-evaluate this on every fresh frame, not cache a
 *  stale `true`.
 *
 *  @decision c0933e57 — `BUSY_STATUS_MARKER` is tested against {@link normalizeCodexScreenText}'s output
 *  (never raw `screen`) as a defensive hardening against the SAME CSI-cursor-forward-as-space rendering
 *  `isTrustDialogPrompt` was confirmed exposed to — unconfirmed here (no specimen captures codex's real
 *  busy state), but a strict no-op on every currently-passing case, so there is no regression risk. */
export function isCodexBusy(screen: string): boolean {
  return BUSY_STATUS_MARKER.test(normalizeCodexScreenText(screen)) || BUSY_TITLE_SPINNER_RE.test(screen);
}

/**
 * Code Review C1 fix: has codex rendered its main TUI at least once since boot (past the trust dialog, if
 * any, or straight to ready when the directory was already trusted)? Checked against the SAME rolling,
 * multi-chunk `screen` buffer trust-dialog detection uses (a one-time "has this text appeared at all"
 * question, correctly answered by accumulation — unlike {@link isCodexBusy}, which is an ONGOING
 * true/false state and must never be asked this way, see that function's own doc).
 *
 * @decision 448f1b4a — NEVER treat this alone as readiness; combine with isCodexModelLoaded and
 * !live.trustDialogPending — a real merge gate once landed a submit while this alone read true and
 * codex was still genuinely loading.
 */
export function isCodexReadyMarkerPresent(screen: string): boolean {
  return screen.includes(CODEX_READY_PLACEHOLDER);
}

/**
 * Card 448f1b4a fix: has codex's header finished resolving its model — i.e. is it NOT still showing the
 * transient "model: loading" boot-skeleton text (probe findings.md State 1 vs State 3).
 *
 * @decision 448f1b4a — screen MUST be stripAnsiCsi'd before testing, never raw — codex's own CSI styling
 * around the model value can make an unstripped match return true while still loading. The regex must
 * also stay a POSITIVE "model: <resolved>" match, never negated.
 */
export function isCodexModelLoaded(screen: string): boolean {
  return CODEX_MODEL_LOADED_RE.test(stripAnsiCsi(screen));
}

/**
 * Translate an already-built `mcpServers` map (the SAME shape `pty/host.ts#buildMcpServers` returns for
 * claude's `--mcp-config`) into codex's per-invocation `-c mcp_servers.<id>.url=<url>` argv pairs. Only
 * `{type:"http", url}` entries are translated (codex has no stdio-server concept here).
 *
 * @decision 7fa73e2c — an unsupported entry must be REPORTED, never silently skipped: a silent skip here
 * is indistinguishable from a working mount (e.g. browserTesting silently spawning with no Playwright
 * MCP). Report via the companion {@link unsupportedCodexMcpServers}.
 */
export function mcpServersToCodexArgs(mcpServers: Record<string, unknown>): string[] {
  const args: string[] = [];
  for (const [id, entry] of Object.entries(mcpServers)) {
    if (!entry || typeof entry !== "object") continue;
    const { type, url } = entry as { type?: unknown; url?: unknown };
    if (type !== "http" || typeof url !== "string" || !url) {
      // eslint-disable-next-line no-console
      console.warn(`[pty] codex mcp translate: server "${id}" (type=${typeof type === "string" ? type : String(type)}) has no codex equivalent — codex only mounts {type:"http"} servers. Spawning WITHOUT this MCP server.`);
      continue;
    }
    args.push("-c", `mcp_servers.${id}.url=${url}`);
  }
  return args;
}

/**
 * Card `4084fadb` — per-invocation override suppressing codex's own startup "Update available!" dialog,
 * which otherwise blocks unattended boot whenever a newer codex release has been published than what's
 * installed (the dialog is a blocking TUI prompt with no auto-dismiss). MEASURED (this host, codex-cli
 * 0.153.4, real update genuinely pending: 0.153.4 installed vs 0.154.0 published): `check_for_update_on_startup`
 * is a real, recognized top-level boolean config field, not merely a substring found in the binary —
 * `codex --strict-config -c check_for_update_on_startup=false` passes config validation and proceeds to
 * the NEXT processing stage, while the identical invocation with a genuinely-unknown key is rejected at
 * the config-load stage with "unknown configuration field ... in -c/--config override", and a non-boolean
 * value for this SAME key is rejected with "invalid type: string ..., expected a boolean" — both confirm
 * the key's existence and boolean type from the CLI's own validation, not from the card's original binary-
 * strings hypothesis. Deliberately a per-invocation `-c` override, never written into the user's real
 * `~/.codex/config.toml` — see `createCodexPty`'s own call site for why persistence is out of bounds here.
 */
export const CODEX_UPDATE_CHECK_OVERRIDE_ARGS: readonly string[] = ["-c", "check_for_update_on_startup=false"];

/**
 * Card `b987f086`: companion to {@link mcpServersToCodexArgs} — WHICH entries of the SAME `mcpServers` map
 * that function silently (bar the `console.warn` above, into a shared multi-tenant log nobody polls —
 * project memory `shipping-a-detector-is-not-someone-reading-it` measures passive notice at 0-acted-on)
 * drops, so a real caller (`pty/host.ts#createCodexPty`) can turn this into a durable, manager-visible
 * report (`PtyHostEvents.onCodexUnsupportedCapability`) instead of leaving the log line as the only signal.
 * Deliberately a SEPARATE pure function rather than changing `mcpServersToCodexArgs`'s own return shape —
 * every existing call site/test asserting on its plain `string[]` return (codex-host-decisions.mjs) stays
 * byte-identical; this one is called ALONGSIDE it, never instead of it, on the exact same input map.
 */
export function unsupportedCodexMcpServers(mcpServers: Record<string, unknown>): { id: string; type: string }[] {
  const dropped: { id: string; type: string }[] = [];
  for (const [id, entry] of Object.entries(mcpServers)) {
    if (!entry || typeof entry !== "object") {
      dropped.push({ id, type: "unknown" });
      continue;
    }
    const { type, url } = entry as { type?: unknown; url?: unknown };
    if (type !== "http" || typeof url !== "string" || !url) {
      dropped.push({ id, type: typeof type === "string" ? type : String(type) });
    }
  }
  return dropped;
}

/**
 * Card c6ce2804 (DoD-1): decide the resume-related PREFIX of a codex spawn's argv — pure, so the exact
 * fresh-vs-resume-vs-fork decision can be asserted directly (codex-resume-argv.mjs) with no real spawn
 * required, mirroring why `mcpServersToCodexArgs` above lives here rather than inline in `createCodexPty`.
 *
 * @decision c6ce2804 — `resume` MUST lead argv (a clap subcommand, not a flag, so it cannot appear after
 * -a/-s/--no-alt-screen), and fork ALWAYS forces a fresh spawn even if resumeId is set — reusing
 * resume<uuid> for a fork risks two ptys racing writes into one rollout file.
 */
export function buildCodexResumeArgs(opts: { resumeId?: string; fork?: boolean }): string[] {
  return opts.resumeId && !opts.fork ? ["resume", opts.resumeId] : [];
}

/**
 * In-process mutex serializing codex's first-use-per-directory trust-dialog window (parity matrix's
 * "CODEX_HOME" section: every codex worker on a host shares ONE real `~/.codex/config.toml`, so two
 * concurrent fresh spawns answering the dialog at the same instant could race its config write). Bounded
 * to THIS process only — no cross-process/daemon-restart durability, no lockfile protocol; a daemon
 * restart mid-window is not covered (disclosed limitation, not an oversight). A single, module-level
 * instance is intentional: the race is over the ONE shared `config.toml`, not per-session.
 */
export class CodexTrustDialogLock {
  private chain: Promise<void> = Promise.resolve();

  /** Run `fn` once every earlier-queued holder has released — FIFO, never re-entrant (a caller holding
   *  the lock must not call `withLock` again from inside `fn`, or it will deadlock against itself). */
  withLock<T>(fn: () => Promise<T>): Promise<T> {
    const runAfter = this.chain.then(fn, fn);
    // Keep the chain alive regardless of fn's outcome (a rejection must not permanently wedge the lock
    // for every later queued caller) — swallow here, the real result/error still flows to THIS caller's
    // own returned promise via `runAfter`.
    this.chain = runAfter.then(() => undefined, () => undefined);
    return runAfter;
  }
}

/** The single, process-wide lock instance — see {@link CodexTrustDialogLock}'s own doc for why one shared
 *  instance (not per-session) is correct here. */
export const codexTrustDialogLock = new CodexTrustDialogLock();

/**
 * Card 0e83c855 round 4 — the MEASURED root-cause fix (codex-cli's own TUI silently drops some non-ASCII
 * codepoints on direct paste; root cause is Windows conpty's closed-source key-event translation).
 *
 * @decision 0e83c855 — this predicate is exactly as wide as the MEASURED drop class (`\p{L}` and astral
 * pass through) — never widen to a blanket non-ASCII gate; that would corrupt Cyrillic/Greek/CJK/emoji
 * text codex already handles correctly.
 */
const CODEX_LETTER_RE = /\p{L}/u;
export function codexCharNeedsAsciiFold(codepoint: number): boolean {
  if (codepoint <= 0x7f) return false; // ASCII — never in scope; always survives untouched
  if (codepoint > 0xffff) return false; // astral/supplementary-plane — survives regardless of category
  return !CODEX_LETTER_RE.test(String.fromCodePoint(codepoint));
}

/**
 * Code Review Major [2]: codepoints with NO independent meaning of their own (a variation selector, ZWJ,
 * ZWSP, a soft hyphen, a BOM, a directional mark) — Unicode's `Default_Ignorable_Code_Point` property.
 *
 * @decision 0e83c855 — these elide to NOTHING, never a `?` placeholder: a placeholder would double up
 * next to an adjacent fold (e.g. `[!]?` instead of `[!]`) or split a ZWJ emoji sequence apart.
 */
const CODEX_DEFAULT_IGNORABLE_RE = /\p{Default_Ignorable_Code_Point}/u;
function codexIsDefaultIgnorable(ch: string): boolean {
  return CODEX_DEFAULT_IGNORABLE_RE.test(ch);
}

/**
 * Code Review Major [2]: a codepoint whose ONLY role is to be some kind of space — NBSP, ideographic
 * space, narrow NBSP, thin space, ... — folds to a single plain ASCII space rather than the generic `?`
 * fallback. `?` is right for a character that carries real visible content the author put there
 * deliberately; a space is neither visible nor deliberate-looking, and the author never sees it as
 * anything but a gap between words. Folding NBSP to `?` turned *"see the board"* into *"see the?board"* —
 * exactly the kind of corruption this whole fix exists to prevent, just relocated one fallback branch
 * over. Verified in node: `\p{White_Space}` is `true` for NBSP/ideographic/narrow-NBSP/thin space and
 * `false` for ZWSP (a WIDTH-zero separator, correctly handled by {@link codexIsDefaultIgnorable} instead,
 * never as a visible space) and for em dash (a real, visible symbol — must never fold to a space).
 */
const CODEX_WHITE_SPACE_RE = /\p{White_Space}/u;
function codexIsFoldableWhitespace(ch: string): boolean {
  return CODEX_WHITE_SPACE_RE.test(ch);
}

/**
 * A small, curated table of ASCII substitutions for the highest-frequency members of the drop class in
 * THIS project's own doctrine vocabulary (dashes, arrows, checkmarks, warning/no-entry signs, quotes) —
 * chosen for legibility, not exhaustiveness. Every OTHER dropping codepoint (the long tail this table
 * does not name) still folds correctly via {@link codexAsciiFold}'s own generic `?` fallback — this table
 * is a readability improvement over that fallback for common cases, never a correctness requirement; a
 * codepoint missing from it is still ALWAYS folded, never passed through raw.
 */
const CODEX_ASCII_FOLD_MAP: ReadonlyMap<number, string> = new Map([
  [0x2014, "--"], // em dash
  [0x2013, "-"], // en dash
  [0x2018, "'"], [0x2019, "'"], // single quotes
  [0x201c, '"'], [0x201d, '"'], // double quotes
  [0x2026, "..."], // horizontal ellipsis
  [0x2022, "*"], // bullet
  [0x2192, "->"], [0x2190, "<-"], [0x2194, "<->"], // arrows
  [0x21d2, "=>"], // rightwards double arrow ("implies")
  [0x26a0, "[!]"], // warning sign
  [0x26d4, "[X]"], // no entry
  [0x2705, "[ok]"], [0x2713, "[ok]"], // check marks
  [0x274c, "[x]"], // cross mark
  [0x2b50, "[*]"], // star
  // Card 7cbb3298 — box-drawing (U+2500 block): NFKC does NOT decompose these (measured), so without a
  // curated entry every one falls to the generic '?' — a `tree` listing or an ASCII table/diagram in an
  // agent-to-agent message becomes a wall of question marks. Light/heavy/double variants of the same glyph
  // shape collapse to the same ASCII substitute (no ASCII weight distinction exists to preserve).
  [0x2500, "-"], [0x2502, "|"], // horizontal / vertical line
  [0x250c, "+"], [0x2510, "+"], [0x2514, "+"], [0x2518, "+"], // corners
  [0x251c, "+"], [0x2524, "+"], [0x252c, "+"], [0x2534, "+"], [0x253c, "+"], // tees + cross
]);

/**
 * Card 7cbb3298 — the second, general-purpose tier between the curated map and the generic `?` fallback:
 * Unicode NFKC compatibility normalization recovers a real subset of the drop class for free (fullwidth
 * digits/letters, superscript/subscript digits, the "№" numero sign, ...) without hand-curating each one.
 *
 * @decision 7cbb3298 — the "pure ASCII" guard regex MUST use `+` not `*`: a `*` would let a hypothetical
 * empty-string NFKC result slip past the call site's `??` and vanish with no trace — unreachable in a
 * 14,358-codepoint sweep today, but `+` makes that irrelevant even if a future Unicode version changes it.
 */
export function codexNfkcFold(ch: string): string | null {
  const normalized = ch.normalize("NFKC");
  return /^[\x00-\x7f]+$/.test(normalized) ? normalized : null;
}

/**
 * Card 0e83c855 round 4 — THE fix: fold ONLY {@link codexCharNeedsAsciiFold}'s measured drop class to a
 * plain-ASCII substitute (curated map, then default-ignorable elision, then whitespace, then NFKC, then
 * generic `?`) — NEVER silently dropped. Every other codepoint passes through untouched.
 *
 * @decision 0e83c855 — applied ONLY on submitCodex's write (the path Loom authors text on for codex),
 * never on the claude path or anything read back from codex (already holds whatever codex produced).
 *
 * @decision fd799f0f — deliberately NOT applied to writeStdinCodex (a live human's own keystrokes) even
 * though it shares the identical drop-exposed write path: a human watching their own keystrokes can see
 * and retype a corrupted paste within seconds; an unattended agent turn cannot.
 */
export function codexAsciiFold(text: string): string {
  if (!/[^\x00-\x7f]/.test(text)) return text; // pure ASCII — byte-identical, no allocation
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (!codexCharNeedsAsciiFold(cp)) { out += ch; continue; }
    if (codexIsDefaultIgnorable(ch)) continue; // elide — see its own doc
    if (codexIsFoldableWhitespace(ch)) { out += " "; continue; } // fold to a plain space — see its own doc
    out += CODEX_ASCII_FOLD_MAP.get(cp) ?? codexNfkcFold(ch) ?? "?";
  }
  return out;
}
