# 7c1487c8 — the pasted-content wrap recognizer accepts `intended.trimEnd()` (the engine composer trims trailing whitespace)

## Narrative

After `isRecognizedPastedContentWrap` shipped (`c9f373eb`), the benign composer wrap still armed `[prompt-mismatch-arm]` for a residual population, all at `lenDelta=+57` (58 is the fixed overhead of a 4-char-id wrap, `50 + 2×len(id)`), independent of message length (intendedLen 87 → 5439).

Root cause (verified against the source and the engine's own transcripts): the wrap itself is intact and Loom's write is byte-exact (`submit()` → bracket-start, `writeChunked(text)`, bracket-end, Enter; the `[pty-write]` chunk lengths equal `writtenLen`). What differs is the wrapped BODY: the engine's composer trims TRAILING whitespace off the pasted text before wrapping it. An `intended` ending in whitespace therefore comes back as `intended.trimEnd()` inside the wrap, one char short, and `m[2] === intended` failed. `PASTED_CONTENT_WRAP_RE` matched every specimen; the earlier "missing trailing `\n` the regex requires" hypothesis was wrong.

Method (reusable): map the loom session id to the engine session id via `[hook] SessionStart` in `daemon-output.log`, read the engine's `<engine-session>.jsonl`, take the user turn whose length equals `reportedLen`, strip the wrap with the same regex, and compare `fnv1a32(inner + candidate)` against the logged `writtenHash` (host.ts's own `fnv1a32`). All 13 `lenDelta=57` mismatches in `daemon-output.log.3` (2026-09-21) reconciled: 12 with a trailing `\n` (manager→worker `[loom:from-manager]` messages whose text ended in a newline; `frameFromManager` appends nothing), 1 with a trailing space (a human-typed message). Population scope: `daemon-output.log{,.1-.5}`, `[prompt-echo] byteIdentical=false`, transcript found, wrap regex matches — 2122 already-recognized (`inner === intended`), those 13 trailing-whitespace, plus a residue of other shapes that was NOT classified (the transcript lookup keys on length only, so the residue may include collisions). The kickoff's "6 arms" was an earlier count; this pass found 13 in `.3`, all `arm=fallback-unrecognized`.

The earlier near-miss diagnostic (`detectPastedContentWrapSingleCharDeficit`, `b1cc4f01`) had attributed the +57 specimens to the engine dropping "one character"; that character was the trailing whitespace.

## Do not

- Do not accept any inner other than `intended` or `intended.trimEnd()`: the recognizer's safety property is that a genuine content loss wrapped in the same framing still notifies. An `intended` with no trailing whitespace whose inner is missing its last non-whitespace char must still decline (test 6r; 6q is the content-mismatch control, 6p the positive cases).
- Do not widen to leading-whitespace or interior normalization: no specimen shows the engine doing either. If the engine trims a narrower set than JS `trimEnd` (e.g. not NBSP) a mismatch just falls through to arming, which fails closed.
- Do not treat the unclassified residue above as explained by this record.

## Source

Card `7c1487c8`, worker investigation 2026-09-28; manager approved `trimEnd()` over a one-char-only rule.
