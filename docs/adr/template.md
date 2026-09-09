# <card-id> — <Decision title, as a verb phrase>

This is Loom's **frozen** ADR shape — Nygard's template plus exactly two additions, each marked below
as a **deviation from Nygard**. One shape only; do not introduce a variant. See
`docs/adr/92cfc09e-adopt-architecture-decision-records.md` for why this convention exists and how it
relates to `docs/decisions/` and `docs/investigations/`.

Filename: `docs/adr/<cardid>-<verb-phrase>.md` — the board card id that owns this decision, never a
sequential ADR number.

## Status

One of: `proposed` | `accepted` | `superseded` | `deprecated`.

## Context

What is the issue we're seeing that motivates this decision or change?

## Decision

What is the change we're actually proposing or have agreed to?

## Do not *(deviation from Nygard)*

The prohibitions this decision implies — stated as concrete "do not X" lines. This is the section an
inline `// @decision <cardid> — …` source anchor quotes from, so keep each line self-contained and
quotable on its own.

## Consequences

What becomes easier or harder to do because of this change? Include the accepted costs, not only the
benefits.

## Evidence *(deviation from Nygard)*

Every measurement backing this record, labelled by how it was produced:

- **OBSERVED** — you ran a command/check yourself in this session and saw the result.
- **READ-IN-SOURCE** — you read it in a file, tool description, or prior record; you did not execute
  anything to produce it.

Never dress a READ-IN-SOURCE claim as OBSERVED.
