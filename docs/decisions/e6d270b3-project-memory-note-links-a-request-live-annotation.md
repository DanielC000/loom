# e6d270b3 — a project-memory note may link a Request, resolved to a live annotation per read

## Narrative

Card e6d270b3: a project-memory note may link one or more Requests (`ProjectMemoryEntry.requestIds`, set via `memory_write`). Those links are resolved to a live annotation line PER NOTE, PER READ, inside `composeProjectMemoryDigest`'s `annotate` callback (see `project-memory-request-links.ts`) — so a note written in asking voice about a PENDING request self-corrects the moment the owner answers it, instead of freezing that word forever across every future kickoff.

## Do not

- Do not treat a note's frozen `text` wording about a pending request as ground truth — resolve `requestIds` live via the `annotate` callback rather than trusting stale asking-voice text.
- Do not skip re-resolving `requestIds` on a re-read just because the note itself hasn't changed — the Request's own state is what can move.

## Source

JSDoc file-header comment in `packages/daemon/src/sessions/project-memory-recall.ts`, lines 37-41 as of tranche 1 on that file (the closing paragraph of the same header block that also cites card 2fd9abf9 — see [[2fd9abf9-project-memory-two-delivery-points-and-coverage]]).
