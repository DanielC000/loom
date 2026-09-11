# e6d270b3 — a project-memory note may link a Request, resolved to a live annotation per read

## Narrative

Card e6d270b3: a project-memory note may link one or more Requests (`ProjectMemoryEntry.requestIds`, set via `memory_write`). Those links are resolved to a live annotation line PER NOTE, PER READ, inside `composeProjectMemoryDigest`'s `annotate` callback (see `project-memory-request-links.ts`) — so a note written in asking voice about a PENDING request self-corrects the moment the owner answers it, instead of freezing that word forever across every future kickoff.

## Do not

- Do not treat a note's frozen `text` wording about a pending request as ground truth — resolve `requestIds` live via the `annotate` callback rather than trusting stale asking-voice text.
- Do not skip re-resolving `requestIds` on a re-read just because the note itself hasn't changed — the Request's own state is what can move.

## Two halves: writing in asking voice (a), resolving live at recall (b)

Half (a) (shipped 2026-07-22) only changed how a note is WRITTEN — asking voice ("PENDING request `<id>` asks the owner to authorize X") instead of decided voice — but a note still froze that state at write time; once the owner answered, the note kept reading PENDING forever. `project-memory-request-links.ts` is half (b), the actual fix: every surface that surfaces a note (kickoff injection, `memory_read`, `memory_list`) re-resolves each linked id fresh, right before the note is shown, so the annotation can never outlive the state it describes.

Three deliberate constraints on that resolution:

- FAIL-VISIBLE on an unknown/deleted id: never silently omitted (a silent omission leaves the note's own stale text standing unchallenged — exactly the failure this card removes).
- PROJECT-SCOPED, server-side: `projectId` is always the CALLER's own project (resolved server-side from the session, same as every other memory tool) — a cross-project id renders "not found in this project" and never leaks the other project's actual state (title, state, anything).
- Reports the RAW `Question.state` literally (pending/answered/consumed/cancelled), uppercased, with zero interpretation — this module reports state, it does not decide anything.

### Do not (2)

- Do not silently omit an annotation line for an unknown/deleted linked request id — render it fail-visibly (`request not found — may be deleted`) rather than dropping it.
- Do not resolve a linked request id against another project's store, or leak that project's title/state on a mismatch — render "not found in this project" instead.
- Do not interpret or reword `Question.state` when annotating a link — report the raw state literally, uppercased.

### Source (2)

JSDoc file-header comment in `packages/daemon/src/sessions/project-memory-request-links.ts`, lines 3-20 as of this tranche's HEAD (the module doc comment above `annotateRequestLink`).

## Source

JSDoc file-header comment in `packages/daemon/src/sessions/project-memory-recall.ts`, lines 37-41 as of tranche 1 on that file (the closing paragraph of the same header block that also cites card 2fd9abf9 — see [[2fd9abf9-project-memory-two-delivery-points-and-coverage]]).
