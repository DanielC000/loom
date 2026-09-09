# 9f010283 — a role filter on the cross-project archive page must apply BEFORE limit/offset

## Narrative

Card 9f010283: `listAllArchivedSessionsPage`'s optional `role` filter scopes the page to one `SessionRole` (e.g. `manager`) BEFORE the limit/offset apply, so a role-scoped caller (MissionControl's Run Replay picker, which only ever shows managers) spends its whole page budget on rows it actually wants, instead of the bound being diluted by unrelated worker/setup/etc. rows that share the same cross-project `archived_at` ordering. The bug this fixes: an archived manager older than the newest 300 archived sessions GLOBALLY was unreachable in the picker even though far fewer than 300 managers existed — the unfiltered page was being consumed entirely by non-manager rows before a role-scoped caller ever saw the manager it wanted. Omitted `role` is unfiltered, byte-identical to the pre-filter behavior.

## Do not

- Do not apply a role filter client-side over an already-paginated, unfiltered result — that reintroduces the exact "budget consumed by rows the caller doesn't want" bug this card fixes; filter server-side, before limit/offset.

## Source

Inline comment in `packages/daemon/src/db.ts` (`listAllArchivedSessionsPage`): lines 5055-5071, as of this tranche's HEAD.
