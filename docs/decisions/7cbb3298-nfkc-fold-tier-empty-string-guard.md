# 7cbb3298 — the NFKC fold tier, and why its "pure ASCII" guard uses `+` not `*`

## Narrative

`codexNfkcFold` is the second, general-purpose tier between the curated `CODEX_ASCII_FOLD_MAP` and the generic `?` fallback in the codex ASCII fold: Unicode NFKC compatibility normalization recovers a real subset of the drop class for free (fullwidth digits/letters, superscript/subscript digits, the "№" numero sign, ...) without hand-curating each one.

The "result is pure ASCII" guard is the load-bearing part — NFKC on an arbitrary codepoint can just as easily normalize to ANOTHER non-ASCII codepoint (or to itself, unchanged), and that must still fall through to `?` rather than emit non-ASCII text, which is exactly the failure mode this whole fold exists to prevent. MEASURED (node, this codepoint set): fullwidth "１" -> "1", superscript "²" -> "2", "№" -> "No" all normalize to pure ASCII; section sign "§", degree "°", em dash "—", "≤", and the arabic-indic digits do NOT decompose under NFKC at all (normalize to themselves) and correctly return `null` — they keep falling to the generic `?`, unchanged from before this tier existed.

Code Review follow-up: the guard regex uses `+` (one-or-more), not `*` (zero-or-more), DELIBERATELY. With `*`, a hypothetical codepoint whose NFKC form is the EMPTY string would pass the "pure ASCII" test and return `""` — and since the call site composes this with `??` (nullish coalescing), an empty string is NOT nullish, so it would NOT fall through to `?`; the character would vanish with no trace, exactly the silent-loss outcome this whole fold exists to prevent.

MEASURED this is currently UNREACHABLE: swept every BMP codepoint above U+007F that is non-letter (fails `\p{L}`), non-`Default_Ignorable_Code_Point`, and non-`White_Space` (the full population that can ever reach this function through `codexAsciiFold`'s call chain, a strict superset of the curated-map-covered subset) — 14,358 codepoints, excluding the UTF-16 surrogate range — and confirmed NONE of them normalizes to `""` under NFKC. `+` turns that measured-but-reverifiable-by-nobody property into a structural guarantee instead: even if some future Unicode version introduced such a codepoint, `+` rejects an empty `normalized` outright (falls through to `?`) rather than silently emitting it, at zero cost.

## Do not

- Do not change the guard regex from `+` to `*` — a `*` would let a hypothetical empty-string NFKC normalization slip past the `??` nullish-coalescing call site and vanish with no trace, the exact silent-loss outcome this fold exists to prevent.
- Do not assume this scenario is purely hypothetical and therefore safe to relax — the 14,358-codepoint sweep only shows it is UNREACHABLE for the CURRENT Unicode version, not impossible for a future one; the `+` guard is what makes that irrelevant either way.

## Source

Inline comment in `packages/daemon/src/pty/codex-host.ts` (the JSDoc above `codexNfkcFold`), as of commit 41336cdba9e3c80849be6c64c84a8d52c3c06dce. Relocated by card e5ee79bb (tranche 1 on `pty/codex-host.ts`); no wording changed beyond joining wrapped source lines into flowing paragraphs and stripping `*` comment markers. The ASCII `->` arrows in the measured examples above are preserved verbatim from source, not normalized to `→`.
