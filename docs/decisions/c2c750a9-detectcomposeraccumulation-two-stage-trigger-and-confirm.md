# c2c750a9 — `detectComposerAccumulation` uses a two-stage sum-then-hash design, and its coverage limit

## Narrative

Card c2c750a9 — the CONSUMING half of card 736de9c0's hash-confirmed finding: the engine's `UserPromptSubmit` hook can report back the composer's whole accumulated buffer (everything written since the composer last genuinely cleared), not just the current turn's own text, when a clear is silently missed between submissions. `[prompt-echo]` already logs every field this needs on every submission — `detectComposerAccumulation` is the first thing that actually reads it.

TWO STAGES, deliberately kept separate (736de9c0's own counterexample: `A+B+C` and `C+A+B` share length 11105 but hash `1136780e` vs `687d2824` — a sum cannot pin ordering, only a hash can):
- TRIGGER — `reportedLen` equals the SUM of the current write's length plus one-or-more IMMEDIATELY-PRECEDING writes' lengths (a contiguous suffix of `window`, which is oldest-first and always ends with the current submission's own entry).
- CONFIRMATION — `fnv1a32` of those same payloads' TEXT, concatenated in that same gen order, BARE (no separator bytes), equals `reportedHash`. Only a length-AND-order match is a genuine accumulation; a length-only match (same total, different order/content) is refused here — see the reorder counterexample above.

Tries the SMALLEST span first (k=2 upward) and returns the first CONFIRMED (hash-matching) span it finds; if none confirm, returns the smallest span whose SUM matched anyway (`confirmed: false`) so a caller can tell "no candidate at all" apart from "a candidate existed and the hash refused it" — the exact distinction card c2c750a9's DoD requires demonstrating.

COVERAGE LIMIT this function cannot lift (state in any caller's own log/report too, per the card): `[prompt-echo]` fires only at the NEXT write — an accumulation with no SUBSEQUENT submission on that session emits nothing and is structurally invisible here. Scope every claim this produces to "accumulation detectable at the next write", never "duplicates detected" (card 736de9c0's own limit). Also out of scope by construction: this compares SUBMITTED-TURN text (`live.lastPrompt` / `hook.prompt`, already fully decoded), never raw `[pty-write]` byte chunks — so the give-up clear's `BACKSPACE.repeat(N)` false-signature class (content-identical by construction, see `ptyWrite`'s own doc) never reaches this comparison at all; it doesn't need excluding here because it was never included.

Supporting sizing decisions from the same area of the file: `COMPOSER_ACCUM_WINDOW` (how many of the most-recent WRITTEN submissions `Live.recentWrittenTurns` retains per session, oldest-first) is set to 8 — small and bounded, since the hash-confirmed specimen this detector was built from (card 736de9c0) needed only 3 (current + 2 preceding), leaving headroom without letting the ring (and the per-check concatenation cost) grow unbounded. `OFFSET_OMISSION_MAX_TAIL_CHARS` (card 00b5066e) bounds the OMISSION direction of the offset-aware reconciliation check (`intended.startsWith(reported)`) at 2 chars — kept small and deliberate: unbounded, a short `reported` could coincidentally appear as a leading-prefix match of a large `intended` purely by chance, softening the wording for what is actually a genuine large-tail truncation (the card's own explicit hard bound cites the `-41638` gen=4 specimen: `divergesAtChar=7`, a 42,075-char missing tail). The card's own live specimen this bound is sized from had a tail of exactly 1 char (a trailing newline, almost certainly not echoed back) — 2 leaves a little headroom without coming anywhere near a size where coincidence becomes plausible. The INSERTION direction (`reported.includes(intended)`) carries no equivalent risk and is deliberately left unbounded.

## Do not

- Do not report this detector's output as "duplicates detected" — it can only ever say "accumulation detectable at the next write" (card 736de9c0's own limit).
- Do not raise `OFFSET_OMISSION_MAX_TAIL_CHARS` casually — it is deliberately small so a short `reported` can't coincidentally read as a leading-prefix match of a large `intended`, softening what is actually a genuine large-tail truncation.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (`detectComposerAccumulation`'s function doc — this is the record's primary relocated content). The adjacent, shorter `COMPOSER_ACCUM_WINDOW`/`OFFSET_OMISSION_MAX_TAIL_CHARS` constant docs (below the 15-line anchor threshold, not touched by this tranche) are summarized here for context only and remain inline at their own sites, unrelocated. Relocated by card a4818d7a (tranche 1 on `pty/host.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
