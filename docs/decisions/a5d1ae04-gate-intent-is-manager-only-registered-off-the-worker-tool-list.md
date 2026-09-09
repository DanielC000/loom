# a5d1ae04 — `gate_intent_declare`/`withdraw` are manager-only, kept off the worker's pinned tool list

⚠️ Spans two decisions under this card: this record (§1, `mcp/orchestration.ts`) and
`GateIntentEntry`'s deliberate `sessionId` omission (§2, `sessions/service.ts`). `resolveRecord` serves
one file per id; folded here rather than left as a second unreachable `a5d1ae04-*.md` file (card
`6de8956e`).

## §1 — Narrative

Card a5d1ae04 — the structured replacement for a hand-written peer-channel "I'm about to fire a merge gate" letter, whose measured delivery latency routinely exceeded the coordination window it existed to protect. MANAGER-ONLY: registered only from the manager branch of `buildServer`, never from the worker branch — a worker's own gate-firing action is `run_gate` (its own DoD self-check), which has no "I intend to" phase worth declaring, and adding either tool to the worker surface would mean touching that role's tightly pinned depth-1 tool list (see the comment at this file's worker-branch `registerGateQueue` call site) for no actual use case. `gate_queue`'s own `declarations` array (registered on BOTH surfaces, unchanged) is how a WORKER — or a peer manager — reads what a manager declared; only the manager that owns the declaration can create or remove it.

### Do not

- Do not register `gate_intent_declare`/`gate_intent_withdraw` on the worker surface — a worker has no "I intend to fire" phase (its only gate action is `run_gate`), and adding either tool would widen the deliberately-pinned worker depth-1 tool list for no use case.

### Source

Inline comment in `packages/daemon/src/mcp/orchestration.ts`, above `registerGateIntent`. Relocated by card `210cd10c` (tranche 1).

## §2 — `GateIntentEntry` deliberately omits `sessionId`; dead-seat residue is structurally unobservable, not merely tagged

### Narrative

One live declaration in `GateQueueSnapshot.declarations` — the read-side shape of a `GateIntentRow`, with the SAME cross-project redaction posture `GateQueueEntry` already establishes (own-project: full detail; foreign-project: `redacted: true` plus a sparse, deliberately chosen subset — by direct analogy to `GateQueueEntry.taskId`/`branch`/`workerLabel`).

NO `sessionId` FIELD, ON EITHER SIDE OF THE REDACTION BOUNDARY — this is deliberate, not an oversight of this card's own DoD-5 ("the declaring session id is on the record, so a peer can tell a live declaration from a dead seat's residue"): the session id IS on the record — it's the key `GateIntentRegistry` stores each row under, and `gateQueueForManager` uses it to run the dead-seat check (`GateIntentRegistry.snapshot`'s `isSessionLive`) BEFORE this entry is ever built — but it never rides the wire. A dead seat's declaration doesn't get *labelled* dead here, it simply isn't in the array at all by the next read; a peer never needs the raw id to draw that conclusion because the server already drew it for them. This is a STRONGER reading of DoD-5 than literally echoing the id back would be (residue becomes structurally unobservable, not merely tagged) — flagging the substitution explicitly here so a future reader checking DoD-5 against the wire shape alone doesn't conclude it was skipped.

### Do not

- Do not add a `sessionId` field to `GateIntentEntry` to satisfy this card's DoD-5 literally — the dead-seat check already runs server-side before this entry is built, so a dead seat's declaration is structurally absent from the array rather than merely tagged; adding the raw id back would be a WEAKER reading of DoD-5, not a fix for a missing field.

### Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`GateIntentEntry`'s top-of-interface doc): lines 250-266, as of commit `f9caa77e30d5c1a6dd994b6203261968c0dbf94f`. Relocated by card `8f4c8a8f`. Folded into this pre-existing record by card `6de8956e`.
