# aa4e24ff — the `worker_redirect` advisory triggers on observable hold time, never on message text

## Narrative

Card aa4e24ff, §TRIGGER DECISION: how long a `worker_message` must have sat held behind a busy worker's mid-turn before `messageWorker` appends an advisory pointing the manager at `worker_redirect`. Gated on the observable `busyForMs` the hold already carries — never on the message's own text (a stop/hold phrase list is lexically unbounded and, worse, fires on an immediate delivery to an idle worker where nothing is actually landing late) — so this constant is the entire trigger surface; there is no companion phrase list anywhere in this file.

5 minutes: below it, an ordinary worker turn (a build/test cycle, a routine multi-file edit) can plausibly still end and drain the message soon on its own, so advising interruption would be noise more often than not. Above it, the hold is long enough that a manager who wants the message to land sooner should be told the interrupting alternative exists before they assume it already landed. Trade: a hold of a few minutes never gets the advisory even when a manager would have wanted it — deliberate, so a routine short hold doesn't teach managers to tune the advisory out (the same failure mode a text-trigger would have hit on every single message, per the card's reason 1).

## Do not

- Do not gate the `worker_redirect` advisory on the message's own text (a stop/hold phrase list) — it is lexically unbounded and fires falsely on an immediate delivery to an idle worker.
- Do not lower the 5-minute threshold casually — it is deliberately set so a routine short hold never triggers the advisory, avoiding the "manager tunes it out" failure mode a text-trigger would hit on every message.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (the `worker_redirect` advisory hold-time constant's top-of-block doc): lines 1630-1644, as of this tranche's HEAD. Relocated by card 5dcc1e98 (tranche 6); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.

## `redirectWorker`: why its enqueue-then-interrupt ordering is load-bearing, and its own discard advisory

`redirectWorker` is the "land it NOW" steer, strictly more forceful than `messageWorker` (additive,
non-interrupting): it ENDS the worker's CURRENT turn and REPLACES its pending direction with one
authoritative instruction, delivered as the next turn. No new trust surface — steering your own worker is
strictly LESS than the `stopWorker` process-kill a manager already holds. The order is load-bearing so
the redirect deterministically lands as the next turn: (a) FLUSH the worker's pending FIFO and SUPERSEDE
each flushed durable record (fires its `onDeliver` with reason "superseded", so neither the
`worker_report done` guard nor the boot-recovery scan later re-drives the direction being replaced) — a
plain held nudge carries no callback and is simply dropped; (b) ENQUEUE the authoritative redirect via the
SAME durable channel `messageWorker` uses (a busy worker HOLDS it, now the only entry in the
freshly-flushed queue; an idle worker submits it immediately); (c) ONLY IF it was HELD do we interrupt —
`pty.interruptForRedirect` writes a single Esc to cancel the in-flight turn, then after a bounded settle
clears the stale busy flag and drains, delivering the redirect enqueued in (b). The enqueue is
SYNCHRONOUS and precedes the interrupt's settle timer, so the message is always in the queue before the
settle-drain fires.

`advisory` (card `aa4e24ff`, defect 2's remedy half — no detection question here, it just counts the
queue `deliverRedirect` already flushed): set whenever a redirect discarded ≥1 queued message, naming the
exact count and reminding the manager to re-send them — the same caveat the hold-time advisory above
carries, so a manager who hits either one never has to go discover the other half of the trade.

### Do not (2)

- Do not skip the flush-and-supersede step before enqueueing a redirect — an un-superseded flushed
  record can still be re-driven by the `worker_report done` guard or a boot-recovery scan.
- Do not interrupt (Esc) an idle worker on redirect — only a HELD (busy) delivery needs the interrupt;
  an idle worker already receives the redirect as its next turn with nothing to cancel.

### Source (2)

Inline comment in `packages/daemon/src/sessions/service.ts`, above `redirectWorker`: lines 6707-6736, as
of main `055e96ce`. Relocated by card `c7ca6c08` (tranche 16); no wording changed, wrapped source lines
joined into a flowing paragraph and the `*` comment markers stripped.

## `deliverRedirect`: the shared core extraction, and its return-value shape

`deliverRedirect` is the mechanics shared by `redirectWorker` and `redirectSessionAsCompanion`,
parameterized by the framing (a `frame` function — CR follow-up to `aa4e24ff`: was a raw `tag` string
interpolated here, letting a hand-typed tag drift; callers now supply the whole framing via the SAME
`frameFromManager` helper), the enqueue sender, and the event's `managerSessionId`. Callers pre-resolve
target/scope first — the core never re-derives it. A HELD result overrides the plain
`landsAt:"next-turn-boundary"` to `"after-interrupt"`+`interrupting:true` — reusing the plain shape would
just move this card's tag-drift confusion sideways, relocated to the return value instead of fixed.

### Do not (3)

- Do not let `deliverRedirect` re-derive/re-check scope — callers do that first.
- Do not report a HELD redirect as plain `landsAt:"next-turn-boundary"` — override it so it's
  distinguishable from an ordinary hold.

### Source (3)

Inline comment in `packages/daemon/src/sessions/service.ts`, above `deliverRedirect`: lines 6779-6815,
as of main `fbb3555c`. Relocated by card `1acde858` (tranche 17); wrapped lines joined, `*` markers
stripped.
