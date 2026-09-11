# eb96f3e4 — the SessionQueue ledger bar's constant footprint is a chosen direction, not a default

Source: commit eb96f3e481, no board card

## Narrative

The queued-message UI went through an explicit direction choice — "Direction B", owner-approved 2026-07-06 (vault `Projects/Loom/Design/Queue Redesign.md`) — rather than an obvious alternative (an inline list that grows/shrinks with backlog depth). Direction B renders the queue as ONE constant-height "ledger bar" directly under the terminal whenever ≥1 message is held (session busy / human mid-compose): an amber tick, "QUEUED (n)", a one-line peek of the next-up message, and a chevron. The bar's footprint never changes with backlog depth — a card with 1 queued message and a card with 50 look identical at rest. Clicking it expands a bounded, internally-scrollable drawer listing every queued message with its full affordances; collapsing returns to the one-liner. It renders nothing when the queue is empty.

In `TerminalCard`'s HUG height model, the bar GROWS THE CARD rather than shrinking the terminal region: `TerminalCard` excludes this element from the terminal's own height budget, so the terminal holds a fixed height in every queue state (1 queued or 50).

## Do not

- Do not let the ledger bar's footprint grow or shrink with queue depth — the constant-height bar is the chosen direction (Direction B, owner-approved), not an incidental default that's safe to "improve" back into a growing list.
- Do not fold the bar into the terminal's own height budget — it must grow the card, never shrink the terminal region, or a busy session's terminal would compress every time a message queues.

## Source

Inline comment in `packages/web/src/components/SessionQueue.tsx` (the module's top-of-file banner doc), lines 7-17, as of commit `eb96f3e481e691a129bf9e80047880b9074b21f8` (`feat(web): wire the "Ledger Bar" queued-messages pattern into terminal cards (all Loom pages)`). Extracted by card `7071275f`; wording condensed, no substantive detail dropped.
