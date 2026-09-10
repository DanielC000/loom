# d09d58e7 — `reportEventId` joins the persisted redrive field list, or a reconstruction goes unpurgeable

## Narrative

Card d09d58e7 extends card 129efe74's persisted-field list (see
`docs/decisions/129efe74-redrive-reads-back-persisted-kind-hold-chain-legacy-defaults.md`, and
`docs/decisions/61a012ce-redrive-persists-route-as-a-fifth-legacy-defaulted-field.md` for the field
before it) with a sixth field: `reportEventId`. Before this fix it was IN-MEMORY-ONLY — never persisted
on the `session_message_queued` record — so any reconstruction of the record (a give-up re-mint, a
recycle carry, a boot/resume redrive) silently produced an UNTAGGED entry
`purgeQueuedByReportEventIds` (see
`docs/decisions/60b26261-reporteventid-purges-a-report-the-manager-already-read.md`) can never match,
leaving a since-read report's queued nudge undead — never purged even after the manager already read it
via `worker_report_get`.

`undefined` (every non-`workerReport` caller) is dropped by JSON serialization exactly like `route`, so
this is additive-only — a caller that never set `reportEventId` is byte-identical to before this field
existed.

## Do not

- Do not reconstruct a `session_message_queued` record (re-mint, recycle carry, redrive) without
  carrying its `reportEventId` forward — an untagged reconstruction can never be matched by
  `purgeQueuedByReportEventIds`, leaving a since-read report's queued nudge stuck forever.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`enqueueDurableMessage`'s held-record
branch): lines 7105-7109, as of main `a1c91ab66ab74e401387ad5f6336eae21175ec45`. Relocated by card
`34cbd17a` (tranche 18).

## Related

- `docs/decisions/129efe74-redrive-reads-back-persisted-kind-hold-chain-legacy-defaults.md` — the
  original persisted-field list.
- `docs/decisions/60b26261-reporteventid-purges-a-report-the-manager-already-read.md` — what
  `reportEventId` is for and why it can't key on worker id.
