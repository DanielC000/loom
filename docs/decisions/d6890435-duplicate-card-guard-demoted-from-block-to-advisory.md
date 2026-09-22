# d6890435 — the duplicate-card guard is advisory, never a block

## Narrative

`createProjectTaskChecked`'s cross-channel duplicate-card guard (card `5b221bf2`) used to REFUSE a create outright — `{error}`, nothing written — whenever `findSuspectedDuplicate` flagged an existing task sharing a rare STRONG identifier (a session id, a task id, a Loom branch name) with the candidate. In live usage this produced 4 spurious blocks across two sessions, each costing a manual verify round-trip: two genuinely unrelated cards touching one subsystem can share such an identifier (the module's own doc already names one deliberately-unfixed class — a design/meta document quoting a past incident's identifiers as a worked example) without being duplicates at all.

The two guards this project runs for a similar purpose — this one, and the optimistic-concurrency CAS check on `tasks_update`/`memory_write` — have OPPOSITE-cost false positives. A CAS/version conflict costs the caller a re-read, which is the thing it wanted anyway, and it fails LOUDLY (a 409 the caller must handle). A create-side duplicate block costs a card that never gets filed at all, and it fails SILENTLY — nothing downstream ever learns the finding was dropped. That asymmetry is the reason to tune this specific guard toward false NEGATIVES rather than trying to shrink its false-positive rate further: a missed real duplicate costs a human noticing two similar cards later; a false-positive block costs a finding that vanishes.

## The fix

The guard still runs `findSuspectedDuplicate` exactly as before (same STRONG-identifier-only matching from card `b6eab182`) but no longer refuses the create. A match is instead attached to the successful result as a `related: {taskId, title, sharedIdentifiers}` field — informational, ignorable, and never blocking. `dedupe.allowDuplicate`/`supersedes`/`relatedTo` still skip computing the advisory at all (an explicit relation already says everything the advisory would; `allowDuplicate` is the caller's explicit "don't bother" acknowledgment) — same trigger condition as before, just a different consequence.

## Do not

- Do not delete the detector entirely — the duplicate problem is real (one escalation arriving by two routes has produced two cards, resolved by hand); demote its consequence, don't remove its signal.
- Do not reintroduce a hard refusal for this guard — the whole point of this change is that a lost card is a worse failure mode than an occasional true duplicate slipping through with a visible `related` note attached.
- Do not read a missing `related` field as "definitely not a duplicate" — `findSuspectedDuplicate` only matches on rare STRONG identifiers; two duplicate cards written independently, with no shared session/task id or branch name, will still produce no advisory at all.

## Consequences

A `tasks_create`/`project_task_create` call can no longer be refused for suspected duplication — every well-formed create that isn't blocked by the (unrelated) HTML-entity or conventional-type guards now succeeds, optionally carrying a `related` pointer a caller/reviewer can act on or ignore.

## Source

Board card `d6890435` (Platform), folded into the combined card `975d3c37` — "fix(tasks): make three board-tool signals describe what actually happened".
