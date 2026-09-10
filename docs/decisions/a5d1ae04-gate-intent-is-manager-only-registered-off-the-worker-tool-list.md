# a5d1ae04 — `gate_intent_declare`/`withdraw` are manager-only, kept off the worker's pinned tool list

⚠️ Spans four decisions under this card: this record (§1, `mcp/orchestration.ts`), `GateIntentEntry`'s
deliberate `sessionId` omission (§2, `sessions/service.ts`), and two more from `gate-intent.ts` itself
(§3 module design, §4 `snapshot()`'s dead-seat check). `resolveRecord` serves one file per id; folded
here rather than left as separate unreachable `a5d1ae04-*.md` files (card `6de8956e`; §3/§4 added by
card `66b04631`).

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

## §3 — `gate-intent.ts` module design: measured ANNOUNCE-letter latency; storage, redeclare, reaping

### Narrative

The ANNOUNCE letter this class replaces had measured delivery latency of 2.0-23.3 min (one outlier at 107 min) — routinely exceeding the 7-15 min coordination floor it exists to protect (full measurement: this card's DoD/PROVENANCE).

ONE LIVE ROW PER SESSION: a redeclare fully replaces the prior row, `declaredAt` included — never preserved. This is why `withdraw()` takes no identifying arg: there is never more than one row to disambiguate.

STORAGE is a bare in-memory `Map`, no persistence, same posture as `GateSemaphore`'s registry — bounded lifetime (`INTENT_MAX_LEAD_MS + INTENT_EXPIRE_GRACE_MS`) means nothing durable is lost on restart; a still-relevant manager redeclares.

REAPING IS LAZY: no `setInterval`/`setTimeout`. Every stale/dead row drops inside `snapshot()`, the one read path — every read is a sweep, no separate schedule to keep in sync, nothing here needs a fixed-wait test to poll for.

### Do not

- Do not add a timer-driven reap, or persist declarations across a restart — both deliberate omissions.

### Source

`gate-intent.ts` module header, lines 1-30 as of commit `edd40205`. Relocated by card `66b04631` (tranche 1).

## §4 — `GateIntentRegistry.snapshot()`: the recycle-notice case behind dead-seat detection

### Narrative

`isSessionLive` in `snapshot()` answers this card's measured 17.7-min-late recycle notice from the letter this class replaced: a declaration is gone on the very next read once `processState` leaves `"live"`, unbounded by either clock-based drop condition — no TTL wait to learn a seat is dead.

### Source

`gate-intent.ts`, `GateIntentRegistry.snapshot`'s doc, lines 127-143 as of commit `edd40205`. Relocated by card `66b04631` (tranche 1).
