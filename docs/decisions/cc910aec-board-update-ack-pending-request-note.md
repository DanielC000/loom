# cc910aec — surface `pendingRequestWarning` through the companion `board_update` ack

## Narrative

Card `cc910aec`: `board_update`'s success ack (packages/daemon/src/companion/capabilities.ts) projects `updateProjectTask`'s result to a fixed `{id,title,columnKey,priority,held,projectId}` field set (see the `task: {...}` literals at its two call sites). That projection PREDATES `pendingRequestWarning` — it was written in commit `9fac5bbd`, two months before card `c4355598` added the field — and no doc anywhere states an intent to withhold it. It was a stale gap, not a deliberate disclosure boundary: `title` itself (arbitrary card text) is already echoed through this same ack with no narrower-surface treatment, so there was no existing precedent of withholding Task content here for trust reasons.

The owner is the one person a companion chat can put a pending Request in front of who can actually answer it, so a terminal move made THROUGH the companion is the single highest-value place for this warning to fire — yet, before this card, it was the one place it silently did not.

**Fix:** `pendingRequestWarningNote` formats the SAME additive `pendingRequestWarning` that `updateProjectTask` already computes (never a raw `{id,title}[]` dump — the companion model relays this text into chat, so pre-formatting it in human-readable prose here means it renders consistently instead of depending on the model's own paraphrase) into one optional `pendingRequestNote` string, spread into the ack only when non-empty (mirrors `updateProjectTask`'s own additive-only convention for the field itself). Returns `{}` (never a key with an empty/undefined value) so `JSON.stringify` never emits a stray `pendingRequestNote: undefined`.

## Do not

- Do not let this note turn a success into an error — it can only ever ADD a field to an already-successful ack, inheriting card `c4355598`'s hard constraint that this warning can never block the write it decorates.

## Source

Inline comment in `packages/daemon/src/companion/capabilities.ts` (`pendingRequestWarningNote`'s top-of-function doc): lines 906-927, as of this tranche's HEAD. Relocated by card `2e703a3d` (tranche on `companion/capabilities.ts`); no wording changed beyond joining wrapped source lines into a flowing paragraph.
