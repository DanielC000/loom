# 867e64f1 — `directiveByMsgId` re-checks a SPECIFIC older root msgId after a newer directive supersedes it in the "latest wins" projection

## Narrative

Card 867e64f1 DoD-3 — the manager-facing per-message consumed/not-consumed read, keyed to a SPECIFIC `msgId` rather than "whichever directive is most recent" (`staleDirectiveProjection`'s own `directive` field). Both `staleDirectiveProjection` and the worker-facing `directive_status` tool already resolve a chain via `resolveDirectiveOutcome`; what neither offers is a way to re-check an OLDER root msgId once a NEWER worker_message/worker_redirect has become "the tracked directive" — `staleDirectiveProjection` scans backward and keeps only the LATEST `message_worker`/`redirect_worker` event by design (see its own "latest wins" doc), so an earlier directive's own resolution is invisible there the moment a second one is sent, even though its OWN durable event chain (give-up/re-mint/park/confirmed-after-park) keeps existing and keeps resolving independently. That is exactly the incident shape this card measured: a manager sent directive #2 before directive #1 had resolved, and had no way — while #2 was outstanding — to re-ask "did #1 specifically land?"

`msgId` here is the ROOT msgId a manager's own worker_message/worker_redirect call returned to it — the SAME id `resolveDirectiveOutcome`'s callers already key on (a mid-chain remint id is never handed to the sender and would be meaningless to query). `found:false` means this worker has no `message_worker`/`redirect_worker` event carrying that exact root msgId at all — a distinct signal from `state:null` on a msgId that WAS sent but has no further resolution (there is no such case: every found root either resolves via `resolveDirectiveOutcome` or is defensively `pending`).

Card 3c39be30: now takes `db` + `workerSessionId` rather than a pre-fetched `events` array — the caller at `worker_status` used to build that array itself (`db.listEventsForWorker(w.id)`); it now can't, which is the point (see the 3c39be30 `DirectiveEventStream` record for why a freehand-built array is the exact defect class this closes).

## Do not

- Do not conflate `found:false` (no event carrying this root msgId exists) with `state:null` on a found root — the latter case never actually occurs (every found root resolves via `resolveDirectiveOutcome` or defensively reads `pending`).

## Source

JSDoc comment in `packages/daemon/src/mcp/orchestration.ts`, above `directiveByMsgId`. Relocated by card 210cd10c (tranche 1 on `mcp/orchestration.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
