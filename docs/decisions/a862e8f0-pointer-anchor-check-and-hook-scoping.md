# a862e8f0 — the pointerAnchors check: shipped report-only, then scoped for the per-file hook

## Narrative — why the check exists, and why it shipped report-only

The convention (`CLAUDE.md` comment taxonomy, `docs/extraction-program.md`) requires an
`@decision <id>` anchor's own text to carry the prohibition/consequence directly — the record is
reached by resolving the id, never by a "See docs/…" tail typed into the comment. Before this
card, a large share of this repo's own extraction-tranche anchors did exactly that: compress the
rule to a short pointer phrase instead of stating it. Card `a862e8f0` added `pointerAnchors` (check
10 in `comment-anchor-lint.mjs`) to detect it: it flags an anchor SITE whose own text window
contains a pointer phrase ("see docs/", "docs/adr/", "docs/decisions/", "docs/investigations/",
"see the linked record", or "see the record") instead of stating the rule inline. It runs in BOTH
the CLI scan and the per-file PostToolUse hook — a per-site check needs no whole-corpus dependency,
so a worker sees it live at authoring time.

This check itself was **sent back by lead review 7 times across two seats before it existed** (see
project memory `shipping-a-detector-is-not-someone-reading-it`) — recognized repeatedly with no
mechanical check ever landing to catch it, until this card shipped one.

**MEASURED at ship time** (`node packages/daemon/assets/comment-anchor-lint.mjs .` ->
`.pointerAnchors.count`, commit `6c86927a`): 562 of 1027 anchor sites flagged, across 328 files.
Phrase breakdown: "docs/decisions/" 378, "see docs/" 158, "see the record" 24, "docs/adr/" 2.
Spot-checked (e.g. `codescape/supervisor.ts` lines 13-14, 21-23) — genuine violations, not false
positives: a style common across many prior extraction tranches before this check existed.

**Decision: REPORT-ONLY, not a `guards` failure.** ~55% of the corpus was flagged at ship time —
too many pre-existing hits to gate on without a separate cleanup effort first (out of this card's
scope, which only built the detector). `docs/extraction-program.md`'s tranche DoD tells a worker to
check `pointerAnchors.items` filtered to their OWN file before reporting done — not the corpus
count, and not a blocking gate. Making this a blocking `STATIC_GUARD` later needs that cleanup
first — re-measure fresh rather than trusting any number recorded here.

## Narrative — the hook-advisory flooding incident, and its fix

The per-file PostToolUse hook injects `pointerAnchors` into the agent's own advisory on every
Write/Edit, same as every other per-file check. Lead review caught that a file already carrying
many pre-existing pointer anchors (measured: up to 197 sites in one file) would have its ENTIRE
`pointerAnchors` list injected into the agent's context on EVERY single edit to that file,
regardless of relevance to what was actually just written — a routine one-line edit would flood the
advisory with nearly two hundred unrelated pre-existing findings.

The fix scopes the HOOK's own advisory (never `computeFileReport`/`computeReport` themselves, which
always return the file's complete, unscoped list) down to the site(s) the triggering edit actually
just wrote:
- `extractWrittenText` reads the PostToolUse payload's `tool_input` for the known Write/Edit/
  MultiEdit tool schemas Claude Code actually invokes these tools with — `Write`'s `content` is the
  whole new file (an accepted, narrow over-inclusion for a full rewrite of an existing file, since
  `Write` on an existing file is rare here by convention); `Edit`'s `new_string` is the one
  replacement snippet; `MultiEdit`'s `edits[].new_string` entries are joined. Returns `null` (never
  `""`) when the shape doesn't match any known tool/field — a caller must treat `null` as "cannot
  determine what was written" (fall back to a bounded cap), never as "nothing was written" (which
  would wrongly suppress a real finding).
- `scopeHookPointerAnchors` keeps a site IFF its own (trimmed) anchor line text is a substring of
  the written text — a SUBSTRING test, not a diff, so it can theoretically false-KEEP a
  pre-existing site whose anchor line happens to be reproduced verbatim inside an unrelated large
  `new_string`/`content`. Accepted: a false keep only ever costs a little extra advisory text, never
  a missed real one — the failure mode this fix exists to prevent is the opposite (silently
  dropping a site the agent DID just write).
- `HOOK_POINTER_ANCHOR_CAP` (5) is a belt-and-suspenders bound on top of the scoping, independent
  of it: it covers the one case scoping-by-written-text can still over-include (a `Write` of a
  genuinely large brand-new file carrying many real, freshly-authored pointer anchors all at once —
  every one of them legitimately "just written", so scoping alone wouldn't trim them), and the
  fallback path when the payload shape can't be read at all (`writtenText === null`).

The CLI scan always has the complete, uncapped list; only what the hook chooses to SURFACE in its
advisory is narrowed by this fix.

## Do not

- Do not make `pointerAnchors` a blocking `STATIC_GUARD` without cleaning the pre-existing corpus
  first — it was ~55% of all anchor sites at ship time.
- Do not widen the hook's advisory scoping back to the file's full unscoped list "to be safe" — that
  is the exact flooding failure (up to 197 sites on one edit) this fix exists to prevent.
- Do not read a `null` from `extractWrittenText` as "nothing was written" — it means "cannot
  determine what was written", and must fall back to the capped, unscoped slice, never to silence.

## Source

`packages/daemon/assets/comment-anchor-lint.mjs` — `findPointerAnchors`, `extractWrittenText`,
`HOOK_POINTER_ANCHOR_CAP`, `scopeHookPointerAnchors`, `runHook` (card `a862e8f0`; window later
widened by card `347d37d2`, recorded separately).
