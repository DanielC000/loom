# Mid-line `/* ... */` comment stripping, and the backtick-template regression it introduced

Card `2c215ede` (follow-up from `868e0135`'s CR2, session `512b338b`).

## The original gap

`_strip-comments.mjs` only recognized a **line-leading** block comment (trimmed text starts with `/*`).
A **mid-line** one (opens after real code, e.g. `catch { /* no origin remote — ... doesn't apply */ }`)
survived the strip verbatim.

That matters because several consumers do their **own** `'`/`"` quote-state tracking across the whole
stripped file (or a multi-line slice), with no per-line reset. A surviving mid-line comment with an odd
number of `'`/`"` chars (e.g. `"doesn't"`) opens a phantom quote that never closes — everything scanned
after, including later lines, reads as "inside a string" until an unrelated quote coincidentally closes
it. Real, measured false-green in `bare-ref-positional-argv-guard.mjs` (fixed independently, `868e0135`
round 3); closed here for two more:

- `createworktree-loom-home-guard.mjs`'s `depthAt` — decides whether a `../dist/` import is top-level
  (depth 0) or deferred. Proven: on `` if (false) { /* it's never taken */ }\nawait import("../dist/...") ``
  it returned depth `1` for a genuinely top-level import — the phantom quote swallowed the if-block's `}`.
- `mcp-project-fields-chokepoint-guard.mjs`'s `isInsideQuotedRegion(line, idx)` — called with a
  **multi-line** `ok(...)` payload. Proven: `note: "fine", /* it's just a note */\nleak: p,` read the
  bare, unsafe `p` on the later line as "inside a string" — would have gone unflagged as a leak.

`bare-ref-positional-argv-guard.mjs` was excluded from this card's edits (card `a4145c7a` concurrently
rewrote it onto a TS AST) — before/after output confirmed byte-identical.

## The fix

`stripLineComments` also removes a mid-line `/* ... */` span, quote-aware (a `/*` inside an open `"`/`'`
string, e.g. `"mockups/**"`, is never a comment opener). Two shapes: **closes on the same line** (13/13
specimens in `packages/daemon/src` at card time — re-count, don't trust this number) — dropped, scanning
continues on the rest of the line; **does not close before EOL** (3 specimens, e.g.
`catch { /* null OpenProcess handle, ... */ }` spanning two lines) — a `midlineBlock` flag carries into
the next line(s), dropping them whole until `*/`, then **resumes** scanning whatever follows `*/` (never
drops the closing line, unlike the pre-existing line-leading path, which already does — out of scope).

Still not fixed, same reason as before (no lexer/parser context without one): a `/*`-looking byte
sequence from a regex literal, and the cross-line template-literal gap documented earlier in the file's
header (built, tested, reverted before this card).

## The regression this fix introduced, and how it was caught

The first version read a `/**` glob **inside a backtick template** — e.g. `` `Edit(${glob}/**)` `` — as an
**unclosed** comment opener (backtick wasn't tracked at all), silently dropping the rest of the file in
two consumers: `loom-home-write-deny.mjs` (30016 → 7687 chars) and `mcp-config-secret-lifecycle.mjs` (559
→ 352 lines). The exact catastrophic failure this card exists to prevent — introduced by the fix meant to
close it. Caught by the card's own required before/after corpus diff (a line-count/length diff, not
inspection) — both affected guards reported `EXIT=0`/"ALL PASS" before AND after, since neither asserts an
exact tally; only the raw text diff revealed it.

**Fix:** track backtick too, but only as a **per-line** toggle (`inTemplate`, reset every call), gating
only the mid-line `/*` detection — the pre-existing backtick-blind trailing-`//` cut is untouched, so this
is additive, not a reopening of the file's own reverted **cross-line** backtick-parity attempt (which
corrupted every line after one odd-backtick regex literal, anywhere). A per-line toggle can only misread
backtick content on the SAME line — `src/companion/tts.ts`'s `` /`([^`]+)`/g `` carries no `/*`/`//` on
that line (verified by `git grep`), unaffected either way.

## A residual, named but not fully closed: `/*` from a regex literal

Same category as the file's own existing gap (a) (a `//` from a regex literal), for `/*`: an escaped
slash followed by a `*` quantifier (`/\/*$/`, `/a\/*b/`) was misread as unclosed, dropping the rest of the
file — reproduced directly, no corpus specimen. Mitigated: a `/*` whose `/` is immediately preceded by `\`
is never a comment opener. **Not** closed: an unescaped `/` adjacent to `*` inside a character class
(`/[/*]/`, valid JS) still triggers the same swallow — checked by hand, no corpus specimen either. Needs
the same lexer/parser context gap (a) needs; not attempted, for the same reason.

## Do not

- Revert the per-line `inTemplate` toggle, or the `raw[i-1] !== "\\"` guard on `/*`, without re-running the
  full before/after real-corpus diff — each closes a real catastrophic-swallow regression.
- Widen `inTemplate` to the trailing-`//` cut "for consistency" without checking every backtick-containing
  regex literal in the corpus first.
- Add a `TEST_TIMEOUT_OVERRIDES` entry for any file this card touched — all three run under a second solo.
