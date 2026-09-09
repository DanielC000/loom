# fc9a27d5 — `DeliveryStatus` replaces the old boolean `delivered`, which couldn't tell a durable queue from a genuine drop

## Narrative

Board card fc9a27d5: the old boolean `delivered` on an upward report/escalation (worker_report → manager, platform_escalate → Lead) collapsed too many distinct states into one bit — a caller reading `{delivered:false}` could not tell whether the report was durably queued behind a busy parent, durably filed on the board for later pickup, or genuinely dropped with nobody ever going to see it. `DeliveryStatus` replaces it with five distinct values so the caller can tell whether to relax (it's durably routed) or act (it was dropped).

`suppressed-duplicate` (card 066d317c) is the subtlest of the five: a LIVE recipient exists but the live nudge was deliberately withheld because the recipient already saw this same content (today: a `platform_escalate` completion report naming a deploy SHA the Lead was already nudged about). The board task is still filed (same durability floor as `boarded`), but this is DISTINCT from `boarded`: a `boarded` reader can't tell "nobody is watching this" from "someone IS watching but chose to skip your live turn" — collapsing the two would let a sender stand down believing a report was merely durably filed when in fact a live Lead had deliberately been skipped.

## Do not

- Do not collapse `suppressed-duplicate` back into `boarded` — a reader needs to distinguish "nobody is watching this" from "someone is watching but chose to skip your live turn", or a sender can wrongly believe a report was merely durably filed when a live recipient actually saw and skipped it.
- Do not treat any value other than `dropped` as cause for alarm — `delivered-live`/`queued`/`boarded`/`suppressed-duplicate` are all durably routed; only `dropped` means nothing durable will ever surface it.

## Source

Inline comment in `packages/shared/src/types.ts` (`DeliveryStatus`'s type doc). Relocated by card 35d90c4e (tranche 1 on `packages/shared/src/types.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
