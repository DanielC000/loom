# 0e83c855 — the measured codex/conpty ASCII-drop boundary

## Narrative — root cause

Card `0e83c855` round 4 is the MEASURED root-cause fix, replacing an earlier reverted file-delivery workaround (see that revert commit's own message). codex-cli's own TUI silently drops SOME non-ASCII codepoints on direct paste. Ruled out, with controls: Loom's `pty.write()`; node-pty/conpty's key synthesis in general; codex's own `paste_burst.rs` (only ever receives already-constructed `char` values); the OpenAI crossterm fork's Windows key-event parser (ordinary printable codepoints pass through unconditionally, no keyboard-layout lookup).

Root cause: Windows conpty's own closed-source translation of the raw VT/UTF-8 byte stream into synthesized `KeyEventRecord`s, ONLY when triggered by a live codex/crossterm-style console-input read (a plain raw-mode-reading child gets the identical bytes intact; `docs/design/multi-harness-parity-matrix.md:152-181` is the determination this paraphrases). Evidenced, not inferred: three pty backends (system conpty, winpty, node-pty's bundled conpty.dll) each drop a DIFFERENT, non-overlapping character class against the identical specimen.

## Narrative — the measured boundary

25/25 against a wide, ground-truthed specimen set (Python `unicodedata`, not memorized categories): a Unicode LETTER codepoint (`\p{L}`: Ll/Lu/Lo/Lt/Lm — Latin, Cyrillic, Greek, CJK, ...) NEVER drops; an ASTRAL codepoint (> U+FFFF, a UTF-16 surrogate pair — most emoji) NEVER drops either. Every OTHER non-ASCII BMP codepoint — punctuation, symbol, space (NBSP), mark (a bare combining accent), number (decimal-digit and superscript/other-number) — DOES drop.

Two prior hypotheses were tested and falsified by direct counter-example: byte-length ("3-byte UTF-8 BMP drops") and East-Asian-Width-ambiguous, each explaining only ~2/3 of the specimen set (U+26D4 is EAW=Wide, not Ambiguous, yet drops; é U+00E9 is EAW=Ambiguous, not narrow, yet survives).

Deliberately NOT a blanket non-ASCII gate (the file-delivery workaround's own choice, needing a scratch-file detour): folding every non-ASCII codepoint would corrupt Cyrillic/Greek/CJK text codex already handles correctly — worse than the bug being fixed. Exactly as wide as the measured drop class, no wider.

Accepted staleness risk, PINNED not silent: a future codex/conpty build could widen the drop class with no signal alone — `codex-prompt-ascii-fold-real-spawn.mjs` is the real-spawn test built to catch that drift at the merge gate. A NARROWING class only folds unnecessarily (harmless) — the asymmetry that makes a too-wide gate safe.

Known, disclosed limit: protects ALPHABETIC scripts fully, but only PARTIALLY for an abugida — a base consonant survives via `\p{L}`, but a dependent vowel-sign/matra is a COMBINING MARK, not a letter, so it falls to `?` (Devanagari "कि" → "क?"). Deliberate: a matra carries real phonetic content, so a visible placeholder is correct.

## Narrative — the two special-cased fallback tiers before the generic `?`

A `Default_Ignorable_Code_Point` (Code Review Major [2]) — no independent meaning (a variation selector, ZWJ, ZWSP, a soft hyphen, a BOM, a directional mark) — elides to NOTHING, not a visible placeholder. Verified in node: `true` for VS1/VS16/ZWJ/ZWSP/SHY/BOM/LRM, `false` for NBSP/a bare combining accent/em dash/CJK. A generic `?` would double up (`[!]?` instead of `[!]` for warning-sign-plus-VS16) or split a ZWJ emoji sequence ("👨‍💻" → "👨?💻" instead of "👨💻"). Subsumes a narrower VS-only carve-out an earlier review round replaced.

A `White_Space` codepoint (same round) — NBSP, ideographic space, narrow NBSP, thin space, ... — folds to a plain space, not `?`: a space isn't deliberate visible content. Folding NBSP to `?` turned *"see the board"* into *"see the?board"* — the exact corruption this fix prevents, one branch over. Verified: `\p{White_Space}` is `true` for NBSP/ideographic/narrow-NBSP/thin space, `false` for ZWSP (handled by the ignorable tier instead) and em dash.

## Narrative — the assembled fold function

`codexAsciiFold` applies, in order: pass-through if no fold needed; elide default-ignorable; plain space for foldable whitespace; else curated map, then (card `7cbb3298`) NFKC if pure ASCII, else generic `?` — never silently dropped.

Applied (Code Review [3]) on the ONE path Loom AUTHORS text on for codex — `submitCodex`'s pty write — never the claude path, never anything read back FROM codex (already holds whatever codex produced).

See `docs/decisions/fd799f0f-*.md` for the separate, distinct-card decision NOT to apply this fold to `writeStdinCodex` (a live human's own raw keystrokes).

## Do not

- Do not widen the fold to a blanket non-ASCII gate — corrupts Cyrillic/Greek/CJK/emoji text codex already handles. Keep it exactly as wide as the measured drop class.
- Do not fold `Default_Ignorable_Code_Point` to `?` — elide to nothing, or a placeholder doubles up next to an adjacent fold.
- Do not fold `White_Space` (NBSP and friends) to `?` — fold to a plain space, or text corrupts silently (`"see the board"` → `"see the?board"`).
- Do not remove or weaken `codex-prompt-ascii-fold-real-spawn.mjs` — the only signal catching conpty/codex widening the drop class.
- Do not "fix" the abugida partial-protection limit by eliding a matra — it carries real phonetic content; a visible `?` is correct.

## Source

Inline comments in `packages/daemon/src/pty/codex-host.ts`: the JSDoc above `codexCharNeedsAsciiFold`, `codexIsDefaultIgnorable`, `codexIsFoldableWhitespace`, and the non-writeStdinCodex portion of `codexAsciiFold`'s own JSDoc, as of commit 41336cdba9e3c80849be6c64c84a8d52c3c06dce. Relocated by card e5ee79bb (tranche 1 on `pty/codex-host.ts`); wrapped source lines joined into flowing paragraphs, `*` markers stripped.
