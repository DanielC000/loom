# 92cfc09e — Adopt Architecture Decision Records for decisions currently living only in CLAUDE.md prose

## Status

accepted

## Context

Several of Loom's strongest architectural decisions are not records anywhere in the repo — they exist
only as prose in `CLAUDE.md` (or in operating docs outside this repo), where they are neither versioned
as decisions nor discoverable as such. `CLAUDE.md`'s own "Comment taxonomy" section already names a
two-register split for relocated class-B comments (`docs/adr/` immutable vs `docs/decisions/` mutable)
and a `// @decision <cardid> — …` anchor format, but until this card landed no record existed in either
register — the split was specified, not populated. Writing the first real ADR into a freshly-specified,
never-exercised rule risked an agent silently flattening it the moment new information arrived, since the
shipped doc-hygiene skill's default is rewrite-in-place; that was closed first by a narrow carve-out
(card `7beba83f`), which this card was blocked on.

## Decision

Adopt Nygard's ADR template, frozen to one shape (see `docs/adr/template.md`), with two additions — a
`Do not` section and an `Evidence` section, each marked as a deviation from Nygard. File each record as
`docs/adr/<cardid>-<verb-phrase>.md`, keyed on the board card id that owns the decision — never a
sequential number, since that would create a second id space competing with the card ids already cited
thousands of times in source comments. Status vocabulary stays deliberately small:
`proposed | accepted | superseded | deprecated` — `superseded` is the one carrying real weight, since it
is the mechanism this repo currently lacks for a retracted premise. `docs/adr/` is immutable (amend or
supersede, never edit in place); `docs/decisions/` stays the separate, mutable register for local
implementation decisions and incident findings; `docs/investigations/` remains a third, distinct register
for raw investigation findings, untouched by this decision.

## Do not

- Do not introduce sequential ADR numbering, or any id space for a record other than the board card id
  that owns it.
- Do not edit a landed `docs/adr/**` record in place to reflect new information — supersede it with a new
  record (status `superseded`) instead, per the doc-hygiene exception in card `7beba83f`.
- Do not add a second Nygard template variant — exactly one frozen shape, `docs/adr/template.md`.
- Do not relocate or delete prose out of a source file while seeding a record under this convention —
  that is the separate extraction work (cards `3c50eae9`/`5329a9af`), sequenced behind the decision-records
  injection hook going live.

## Consequences

- Easier: a decision like "the kickoff prompt never rides argv" is now a discoverable, versioned record
  instead of prose an agent might silently flatten on an unrelated edit.
- Easier: a retracted premise has a real mechanism (`superseded`) instead of living only in edit history
  nobody reads.
- Harder: every future architecturally-significant decision now needs a seeded ADR, not just a
  `CLAUDE.md` paragraph — an accepted maintenance cost, not a side effect.
- The doc-hygiene skill's rewrite-in-place rule needed a narrow carve-out (`7beba83f`) for this register
  specifically; every other doc class keeps rewrite-in-place unchanged.
- This card is scoped **additive only** — new files under `docs/adr/`, plus `<=3`-line anchors at natural
  source sites — because the decision-records injection hook (card `661b7d46`) that makes an anchor's
  target actually surface to an agent is merged but not yet live on this daemon. Removing or relocating
  prose out of a source file is out of scope here by design, not an oversight.

## Evidence

- OBSERVED: `git merge-base --is-ancestor 7beba83f HEAD` exits 0 on this branch — the doc-hygiene
  exemption commit is an ancestor of this worktree's HEAD (this worktree, 2026-09-09).
- OBSERVED: `git show --stat 7beba83f` shows a 2-line addition to
  `packages/daemon/assets/skills/loom-doc-hygiene/SKILL.md` adding the `docs/adr/**` carve-out (this
  worktree, 2026-09-09).
- READ-IN-SOURCE: `CLAUDE.md`'s "Comment taxonomy — the source-vs-record split" section (current `main`,
  read via this worktree's checkout) states the two-register split, the `docs/adr/`/`docs/decisions/`
  distinction, and the `// @decision <cardid> — …` anchor format this record's convention reuses verbatim.
