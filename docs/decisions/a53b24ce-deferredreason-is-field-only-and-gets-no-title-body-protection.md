# a53b24ce — `deferredReason` gets none of `title`/`body`'s protection, yet carries a card's decision surface

## Narrative

`deferredReason` is a field-only patch (no `baseVersion` gate the way `title`/`body` get), so unlike
those two fields it gets NEITHER the optimistic-concurrency protection NOR (before this card) any
truncation protection — yet it routinely carries a card's entire decision surface.

The specimen: a Lead wrote a one-word placeholder into `deferredReason` just to read the update ack's
`version` back, silently destroying a multi-thousand-character reason with no undo.

This mirrors the sibling `body`-truncation guard (card `09d68835`) exactly — same `allowTruncate`
override, same whole-patch-reject convention, same `MIN_SUBSTANTIAL_BODY_CHARS`/`MAX_SURVIVING_FRACTION`
thresholds, reused rather than duplicated (one destructive-replace shape, one set of numbers, regardless
of which field it fires on).

## Do not

- Do not assume a field-only patch (no baseVersion gate) is safe from destructive truncation just because
  it isn't versioned — `deferredReason` proved otherwise: a one-word placeholder written just to read
  back an ack's `version` silently destroyed a multi-thousand-character value.

## Source

Inline comment in `packages/daemon/src/mcp/tasks.ts` (`updateProjectTask`, lines 1378-1385 as of this
tranche's HEAD).
