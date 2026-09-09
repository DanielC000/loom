# a5d1ae04 — `GateIntentEntry` deliberately omits `sessionId`; dead-seat residue is structurally unobservable, not merely tagged

## Narrative

One live declaration in `GateQueueSnapshot.declarations` (card a5d1ae04) — the read-side shape of a `GateIntentRow`, with the SAME cross-project redaction posture `GateQueueEntry` already establishes (own-project: full detail; foreign-project: `redacted: true` plus a sparse, deliberately chosen subset — see the field docs below for exactly which fields fall on which side, by direct analogy to `GateQueueEntry.taskId`/`branch`/`workerLabel`).

NO `sessionId` FIELD, ON EITHER SIDE OF THE REDACTION BOUNDARY — this is deliberate, not an oversight of card a5d1ae04's own DoD-5 ("the declaring session id is on the record, so a peer can tell a live declaration from a dead seat's residue"): the session id IS on the record — it's the key `GateIntentRegistry` stores each row under, and `gateQueueForManager` uses it to run the dead-seat check (`GateIntentRegistry.snapshot`'s `isSessionLive`) BEFORE this entry is ever built — but it never rides the wire. A dead seat's declaration doesn't get *labelled* dead here, it simply isn't in the array at all by the next read; a peer never needs the raw id to draw that conclusion because the server already drew it for them. This is a STRONGER reading of DoD-5 than literally echoing the id back would be (residue becomes structurally unobservable, not merely tagged) — flagging the substitution explicitly here so a future reader checking DoD-5 against the wire shape alone doesn't conclude it was skipped.

## Do not

- Do not add a `sessionId` field to `GateIntentEntry` to satisfy card a5d1ae04's DoD-5 literally — the dead-seat check already runs server-side before this entry is built, so a dead seat's declaration is structurally absent from the array rather than merely tagged; adding the raw id back would be a WEAKER reading of DoD-5, not a fix for a missing field.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`GateIntentEntry`'s top-of-interface doc): lines 250-266, as of commit `f9caa77e30d5c1a6dd994b6203261968c0dbf94f`. Relocated by card `8f4c8a8f`; no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
