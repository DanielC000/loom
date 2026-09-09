# 8701bdbb — move a manager's decision-inbox questions to its recycle successor, every state, unconditionally

## Narrative

Card 8701bdbb: `reparentQuestions` moves a manager's decision-inbox questions to its recycle successor — the same recycle-changes-session-id class card `93609ef3` fixed for worker reads (there via lineage-walking; here, consistent with `reparentWakes`, by moving the row itself). It moves EVERY state (pending/answered/consumed) unconditionally, exactly like `reparentWakes` — a still-`'pending'` question's eventual answer must also nudge the successor, not the retired predecessor's dead pty.

This is a FAST PATH, not the only mechanism (card `f88e91f0`): `pullAnsweredQuestionsForAgent`/`getLiveSessionForAgent` read by agent lineage, so a question is reachable even when this never ran (a manual stop + fresh, non-recycle spawn). Keeping this means the recycle path still gets an immediate, explicit handoff rather than relying solely on the lineage read.

## Do not

- Do not scope this move to only `'pending'` questions — an already-`'answered'`/`'consumed'` question must move too, or its history desyncs from the successor that now owns the conversation.
- Do not rely solely on the lineage read (`getLiveSessionForAgent`) as a substitute for this fast path — the two are deliberately both kept, so the recycle path gets an immediate explicit handoff.

## Source

Inline comment in `packages/daemon/src/db.ts` (`reparentQuestions`, minus the class-A `filed_by_session_id` immutability guard left inline): lines 5709-5725, as of this tranche's HEAD.
