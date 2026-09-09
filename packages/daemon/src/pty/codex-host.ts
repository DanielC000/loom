import { TRUST_DIALOG_MARKER, TRUST_DIALOG_ANSWER, BUSY_STATUS_MARKER, BUSY_TITLE_SPINNER_RE, CODEX_READY_PLACEHOLDER, CODEX_MODEL_LOADED_RE, stripAnsiCsi } from "./codex-doctrine.js";

/**
 * Multi-harness epic (df1f94b0) Phase 1, card 353f6dc4: the PURE, testable decision logic for the codex
 * stateful runtime — trust-dialog detect/answer, busy/idle detection, kickoff-ready detection, and
 * MCP-url→codex-argv translation.
 *
 * ⚠️ HISTORY, READ BEFORE EXTENDING THIS FILE: lead ruling #3 originally approved wiring this INTO
 * `pty/host.ts` via a `spawnCodexProcess` method that builds a minimal `Live`-shaped entry in the SAME
 * `this.live` map. Building that entry turned out to require either (a) populating ~60 required `Live`
 * fields (composer-drift/give-up/mismatch-detection bookkeeping — Maps, Sets, arrays of structured
 * records, each with real invariants read/written across ~8,000 lines) with sentinel values, or (b)
 * making those fields optional on `Live`, which cascades into every one of the many internal call sites
 * that reads them without an `undefined` guard. BOTH exceeded the card's own cap ("pty/host.ts edits are
 * capped at the minimum dispatch hunk; if that minimum grows beyond a small hunk, STOP and report") — this
 * was reported up rather than built unilaterally. **Lead ruling #5 superseded ruling #3's shape**: a codex
 * session now lives in its OWN, separate `CodexLive`/`liveCodex` map (`pty/host.ts`, see that interface's
 * own doc), and `PtyHost#spawnCodexProcess`/`submitCodex`/`enqueueStdinCodex`/`drainCodexPending`/
 * `stopCodex`/`interruptForRedirectCodex` are the REAL, WIRED stateful runtime — built and real-spawn
 * tested against an actual installed codex CLI. This file ships ONLY the pure decision logic those
 * methods delegate to (proven by direct unit tests, `test/codex-host-decisions.mjs`, plus the scripted
 * fake-pty queue/turn-state-machine test, `test/codex-queue-state-machine.mjs`) — it holds no state of its
 * own and is never itself what a real session's `Live`/`CodexLive` entry points at.
 */

/** True iff `screen` (a raw pty-output frame, or any accumulated buffer of one) contains the literal,
 *  undocumented first-use-per-directory trust dialog (`codex-doctrine.ts#TRUST_DIALOG_MARKER`) — checked
 *  BEFORE ever writing a real prompt, per the card's own landmine #1. */
export function isTrustDialogPrompt(screen: string): boolean {
  return screen.includes(TRUST_DIALOG_MARKER);
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
 *  stale `true`. */
export function isCodexBusy(screen: string): boolean {
  return BUSY_STATUS_MARKER.test(screen) || BUSY_TITLE_SPINNER_RE.test(screen);
}

/**
 * Code Review C1 fix: has codex rendered its main TUI at least once since boot (past the trust dialog, if
 * any, or straight to ready when the directory was already trusted)? Checked against the SAME rolling,
 * multi-chunk `screen` buffer trust-dialog detection uses (a one-time "has this text appeared at all"
 * question, correctly answered by accumulation — unlike {@link isCodexBusy}, which is an ONGOING
 * true/false state and must never be asked this way, see that function's own doc).
 *
 * ⚠️ CARD 448f1b4a: this function ALONE answers a WEAKER question than "is codex ready for a submit," and
 * being a safe one-time latch does not change that. `CODEX_READY_PLACEHOLDER`'s own doc names the two
 * DISTINCT traps its text sits in — this function is correctly built to be immune to ONE of them (State 4:
 * the placeholder is present during busy too, "landmine #2" — never re-evaluated as an ongoing idle
 * signal, so that trap cannot fire here) but says NOTHING about the OTHER (State 1: the SAME placeholder
 * also renders in the very first boot frame while the header still reads `model: loading`). A real merge
 * gate (op 43cd9ec1) captured exactly that: this function alone returned true while codex was still
 * genuinely loading, and a submit landed on it. See {@link isCodexModelLoaded}'s own doc for the
 * complementary check that closes State 1 — `pty/host.ts#spawnCodexProcess`'s onData handler combines
 * BOTH of these with `!live.trustDialogPending` into the full boot-readiness composite (`live.bootReady`)
 * that gates the one-time kickoff delivery AND every other submit — never this function alone.
 */
export function isCodexReadyMarkerPresent(screen: string): boolean {
  return screen.includes(CODEX_READY_PLACEHOLDER);
}

/**
 * Card 448f1b4a fix: has codex's header finished resolving its model — i.e. is it NOT still showing the
 * transient "model: loading" boot-skeleton text (probe findings.md State 1 vs State 3; see
 * {@link CODEX_MODEL_LOADED_RE}'s own doc for why this must be a POSITIVE match, not a negated one, to
 * stay safe against the accumulating scan buffer both this and {@link isCodexReadyMarkerPresent} read).
 * `isCodexReadyMarkerPresent` ALONE is not a readiness signal — a real merge gate (op 43cd9ec1) captured
 * it rendering true while this function would have returned false, and the harness submitted into that
 * gap. `pty/host.ts#spawnCodexProcess`'s onData handler combines this with `isCodexReadyMarkerPresent` and
 * `!live.trustDialogPending` into the full boot-readiness composite (`live.bootReady`) that
 * `enqueueStdinCodex`/`drainCodexPending` now structurally gate every submit on — see that method's own
 * doc for the full state machine.
 *
 * 🔴 `screen` is stripped via {@link stripAnsiCsi} BEFORE testing — never tested raw. Confirmed against
 * gate `43cd9ec1`'s own real captured bytes (`stripAnsiCsi`'s own doc has the `od -c` verification): codex
 * styles the `model:` line's VALUE token with its own CSI span, separate from the label, and the UNSTRIPPED
 * pattern demonstrably swallows that escape sequence as part of its own `\S+` match — returning TRUE while
 * the model is still genuinely loading, i.e. silently reintroducing this exact card's own defect through
 * the fix meant to close it. This is not a hypothetical: it was reproduced against the real bytes before
 * this strip was added. See `codex-queue-state-machine.mjs`'s own ANSI-bearing fixture for the regression
 * guard.
 */
export function isCodexModelLoaded(screen: string): boolean {
  return CODEX_MODEL_LOADED_RE.test(stripAnsiCsi(screen));
}

/**
 * Translate an already-built `mcpServers` map (the SAME shape `pty/host.ts#buildMcpServers` returns for
 * claude's `--mcp-config`) into codex's per-invocation `-c mcp_servers.<id>.url=<url>` argv pairs —
 * measured TRANSIENT (never touches `config.toml`), see the parity matrix's "MCP wiring" section for the
 * real-pty-driven evidence this shape is reachable. Deliberately takes the ALREADY-RESOLVED map rather
 * than re-deriving role→server routing itself, so there is exactly ONE place (`buildMcpServers`) that
 * decides which servers a given role mounts — this can never drift from claude's own routing table.
 * Only `{type:"http", url}` entries are translated (codex has no stdio-server concept here); any other
 * shape is skipped — REPORTED (card `7fa73e2c`), never silently, since a skip here is otherwise
 * indistinguishable from a working mount: a profile whose UI reads e.g. `browserTesting:true` would
 * silently spawn with no Playwright MCP at all (Playwright/markitdown both resolve to `{type:"stdio"}`).
 * `id` is codex-config-key-safe as long as the caller's server ids are (LOOM_TASKS_SERVER_ID/
 * LOOM_ORCHESTRATION_SERVER_ID/etc. are all plain `[a-z-]+` literals).
 *
 * ⚠️ Card `b987f086`: the `console.warn` above is a shared-log-only signal — see
 * {@link unsupportedCodexMcpServers} for the companion pure function `createCodexPty` calls on this SAME
 * input to turn a real drop into a durable, manager-visible report instead.
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
 * `codex resume <uuid>` is a genuine top-level subcommand (probe findings.md State 6 / point 2: codex
 * itself prints this exact command, unprompted, on the clean exit of a session with in-flight state), so
 * a resume spawn's argv must LEAD with `["resume", <uuid>]` — a clap subcommand token, not a flag; it
 * cannot appear after `-a`/`-s`/`--no-alt-screen` the way `createCodexPty` builds the rest of the argv.
 *
 * Deliberately returns `[]` (a fresh spawn) when `fork` is true, EVEN IF `resumeId` is also set: unlike
 * claude, codex has no discovered `--fork-session`/`--session-id`-shaped equivalent (checked against both
 * probe passes' fetched docs and `--help` output). Reusing `resume <uuid>` for a fork would attach a
 * SECOND live pty to the SAME engine-session id the source may still be running under — a real
 * correctness risk (two processes racing writes into one rollout file), not a cosmetic parity gap. See
 * `createCodexPty`'s own doc for the full reasoning and the disclosed `console.warn` this triggers there.
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
 * Card 0e83c855 round 4 — the MEASURED root-cause fix, replacing the file-delivery workaround (reverted;
 * see that revert commit's own message for the full elimination chain). codex-cli's own TUI silently
 * drops SOME non-ASCII codepoints on direct paste — not Loom's `pty.write()`, not node-pty/conpty's key
 * synthesis in general (ruled out with controls), not codex's own `paste_burst.rs` (structurally cannot
 * be the site — it only ever receives already-constructed `char` values), not the OpenAI crossterm fork's
 * Windows key-event parser (same reason — ordinary printable codepoints pass through unconditionally,
 * with no keyboard-layout lookup). The loss happens inside Windows conpty's own closed-source translation
 * of the raw VT/UTF-8 byte stream into synthesized `KeyEventRecord`s — but only the translation triggered
 * by a live codex/crossterm-style console-input read requesting those records, ⛔ not conpty use in
 * general: a plain raw-mode-reading child process receiving the identical bytes via the identical conpty
 * sees them intact (docs/design/multi-harness-parity-matrix.md:152-181 is the actual determination this
 * paraphrases). Evidenced, not merely inferred, by three independently-implemented pty backends (system
 * conpty, winpty, node-pty's bundled conpty.dll) each dropping a DIFFERENT, non-overlapping character
 * class when swapped against the identical specimen.
 *
 * THE MEASURED BOUNDARY (25/25 against a wide, ground-truthed specimen set — Python `unicodedata`, not
 * memorized categories): a Unicode LETTER codepoint (`\p{L}`: Ll/Lu/Lo/Lt/Lm — covers Latin, Cyrillic,
 * Greek, CJK, ...) NEVER drops. An ASTRAL/supplementary-plane codepoint (> U+FFFF, a UTF-16 surrogate
 * pair — most emoji) NEVER drops either, regardless of category. Every OTHER non-ASCII BMP codepoint —
 * punctuation (dashes, quotes), symbol (arrows, checkmarks, warning/no-entry signs), space (NBSP), mark
 * (a bare combining accent), number (both decimal-digit and superscript/other-number categories) — DOES
 * drop. Two prior hypotheses were tested and falsified by direct counter-example before this one was
 * found: byte-length ("3-byte UTF-8 BMP drops") and East-Asian-Width-ambiguous both explained only
 * roughly 2/3 of the wide specimen set (⛔ U+26D4 is EAW=Wide, not Ambiguous, yet drops; é U+00E9 is
 * EAW=Ambiguous, not narrow, yet survives).
 *
 * ⛔ Deliberately NOT a blanket non-ASCII gate (that was the file-delivery workaround's own choice, and
 * is why it needed a whole scratch-file detour): folding every non-ASCII codepoint would silently corrupt
 * Cyrillic/Greek/CJK text that codex's TUI already handles correctly today, which is a strictly WORSE
 * outcome than the bug being fixed. This gate is exactly as wide as the measured drop class and no wider.
 *
 * ⚠️ Accepted staleness risk, PINNED rather than silent: if a future codex/conpty build widens the drop
 * class beyond what this predicate folds, that text would arrive corrupted again with no signal from this
 * function alone — see `codex-prompt-ascii-fold-real-spawn.mjs`'s own doc for the real-spawn test that
 * exists specifically to catch that drift at the merge gate, converting a silent hazard into a loud one.
 * If the drop class ever NARROWS instead, this only folds something unnecessarily (harmless, still
 * legible) — the asymmetry that makes a slightly-too-wide gate safe to ship.
 *
 * ⚠️ KNOWN LIMIT, disclosed rather than silently accepted: this fold protects ALPHABETIC scripts (Latin,
 * Cyrillic, Greek, CJK, ...) fully, but only PARTIALLY for an abugida (Devanagari and similar scripts
 * where a base consonant letter survives via `\p{L}` but a dependent vowel-sign/matra is a COMBINING MARK,
 * not a letter, and so still falls to the generic `?` fallback below — e.g. Devanagari "कि" folds to
 * "क?", losing the vowel sign). This is deliberate, not an oversight: a matra carries real phonetic
 * content the way a bare combining accent does, so a visible placeholder is the correct degradation there
 * (see {@link codexIsDefaultIgnorable}'s own doc for the contrasting case — a codepoint that carries NO
 * content of its own, which elides instead).
 */
const CODEX_LETTER_RE = /\p{L}/u;
export function codexCharNeedsAsciiFold(codepoint: number): boolean {
  if (codepoint <= 0x7f) return false; // ASCII — never in scope; always survives untouched
  if (codepoint > 0xffff) return false; // astral/supplementary-plane — survives regardless of category
  return !CODEX_LETTER_RE.test(String.fromCodePoint(codepoint));
}

/**
 * Code Review Major [2]: codepoints with NO independent meaning of their own — each one only modifies or
 * requests a presentation style for an ADJACENT codepoint (a variation selector), or joins/separates two
 * adjacent codepoints without being visible content itself (ZWJ in an emoji sequence, ZWSP, a soft
 * hyphen, a BOM, a directional mark). Unicode's own `Default_Ignorable_Code_Point` property is exactly
 * this set — verified in node against VS1/VS16/ZWJ/ZWSP/SHY/BOM/LRM (all `true`) and against NBSP/a bare
 * combining accent/em dash/CJK (all `false`, so none of THOSE are accidentally swept in here). Eliding one
 * is not losing content the way eliding a real symbol is, so it folds to NOTHING rather than a visible
 * placeholder — the alternative (a generic `?` fallback) would double up right after an adjacent
 * character's own fold, e.g. producing `[!]?` instead of `[!]` for warning-sign-plus-VS16, or splitting a
 * ZWJ emoji sequence like "👨‍💻" into "👨?💻" instead of the correct "👨💻" (both base emoji are astral and
 * already survive on their own; only the joiner between them needs to disappear cleanly).
 *
 * Subsumes the narrower VS-only carve-out this replaced (Code Review Major [2] on this card) — every VS1/
 * VS16 case that carve-out covered is still covered, plus ZWJ/ZWSP/SHY/BOM/LRM it never named.
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
 * **The "result is pure ASCII" guard is the load-bearing part** — NFKC on an arbitrary codepoint can just
 * as easily normalize to ANOTHER non-ASCII codepoint (or to itself, unchanged), and that must still fall
 * through to `?` rather than emit non-ASCII text, which is exactly the failure mode this whole fold exists
 * to prevent. MEASURED (node, this codepoint set): fullwidth "１" -> "1", superscript "²" -> "2", "№" ->
 * "No" all normalize to pure ASCII; section sign "§", degree "°", em dash "—", "≤", and the arabic-indic
 * digits do NOT decompose under NFKC at all (normalize to themselves) and correctly return `null` here —
 * they keep falling to the generic `?`, unchanged from before this tier existed.
 *
 * ⚠️ Code Review follow-up: the guard regex uses `+` (one-or-more), not `*` (zero-or-more), DELIBERATELY.
 * With `*`, a hypothetical codepoint whose NFKC form is the EMPTY string would pass the "pure ASCII" test
 * and return `""` — and since the call site composes this with `??` (nullish coalescing), an empty string
 * is NOT nullish, so it would NOT fall through to `?`; the character would vanish with no trace, exactly
 * the silent-loss outcome this whole fold exists to prevent. MEASURED this is currently UNREACHABLE: swept
 * every BMP codepoint above U+007F that is non-letter (fails `\p{L}`), non-`Default_Ignorable_Code_Point`,
 * and non-`White_Space` (i.e. the full population that can ever reach this function through
 * {@link codexAsciiFold}'s call chain, a strict superset of the curated-map-covered subset) — 14,358
 * codepoints, excluding the UTF-16 surrogate range — and confirmed NONE of them normalizes to `""` under
 * NFKC. `+` turns that measured-but-reverifiable-by-nobody property into a structural guarantee instead:
 * even if some future Unicode version introduced such a codepoint, `+` rejects an empty `normalized`
 * outright (falls through to `?`) rather than silently emitting it, at zero cost.
 */
export function codexNfkcFold(ch: string): string | null {
  const normalized = ch.normalize("NFKC");
  return /^[\x00-\x7f]+$/.test(normalized) ? normalized : null;
}

/**
 * Card 0e83c855 round 4 — THE fix: fold ONLY {@link codexCharNeedsAsciiFold}'s measured drop class to a
 * plain-ASCII substitute — curated where {@link CODEX_ASCII_FOLD_MAP} names one; elided to nothing for a
 * {@link codexIsDefaultIgnorable} codepoint (carries no content of its own); folded to a plain space for
 * a {@link codexIsFoldableWhitespace} codepoint (NBSP and friends — a space is not "content" the way a
 * visible symbol is, so a `?` there would corrupt running text worse than the bug being fixed); else
 * (card 7cbb3298) an NFKC-normalized substitute via {@link codexNfkcFold} IF that normalization happens to
 * land on pure ASCII (fullwidth digits, superscripts, "№", ...); else a generic `?` — NEVER silently
 * dropped, mirroring the file-delivery workaround's own now-reverted preview convention: a visible
 * placeholder beats a character vanishing with no trace. Every other codepoint —
 * plain ASCII, any Unicode letter, any astral codepoint — passes through completely untouched, so this
 * can never corrupt Cyrillic/Greek/CJK text or emoji that codex's TUI already delivers correctly (see
 * {@link codexCharNeedsAsciiFold}'s own doc for the one disclosed exception: an abugida's combining
 * vowel-sign still folds to `?`, deliberately, since it carries real phonetic content).
 *
 * Code Review [3]: applied on the one path Loom AUTHORS text on for codex — `submitCodex`'s write to the
 * pty — never on the claude path, which this module has nothing to do with, and never on anything read
 * back FROM codex (a transcript, a file codex wrote) — those already hold whatever codex itself produced,
 * unrelated to what Loom typed into it. Deliberately NOT applied to `writeStdinCodex` (`pty/host.ts`) —
 * the raw relay for a live human typing directly into a codex terminal tile — even though that path
 * writes through the identical `live.pty.write()` -> conpty -> TUI composer and is just as exposed to the
 * same drop. Left alone on purpose: a human watching their own keystrokes land sees the corruption
 * immediately and can react (retype, paste differently); a Loom-authored agent turn is unattended and
 * would otherwise ship silently wrong with nobody watching, which is the actual defect this fold exists
 * to close. Folding a human's own live keystrokes without their input is a different, PRODUCT-level
 * decision, deliberately left undecided here.
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
