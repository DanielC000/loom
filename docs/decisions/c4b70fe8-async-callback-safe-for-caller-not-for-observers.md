# c4b70fe8 — an async callback conversion can be safe for its caller and still open a settle-vs-delivery gap for OBSERVERS

## Narrative

Card c4b70fe8 (the fix half of `ccf23ffb`'s diagnosis): commit `691a2184` (card `74716cfb`) converted
`runWorkerGate`'s `onSettledAfterPending` callback from sync to async, documenting the change as safe with
the comment "the caller invokes this fire-and-forget with no `await` of its own … so this changes nothing
about ordering or error handling." That reasoning is TRUE about the CALLER and FALSE about every OBSERVER
of this op's settle state — `PendingOpRegistry.attach` flips the op's `state` to done/failed
SYNCHRONOUSLY, strictly BEFORE this callback body runs, and that part is unchanged. But making the callback
`async` pushed everything after its first `await` (including the `[loom:gate-failed]` nudge push) into a
LATER turn: the push slid from "the same synchronous turn as the settle" to "after an fs read." A caller
polling `pendingOps.peek(key)?.state` (or `gate_status`) can now observe "settled" before the nudge has
actually been enqueued (see project memory `worker-run-gate-scenario-k-async-nudge-race`).

This is Loom's own standing lesson recurring: a comment is a claim, and this one quantified over the wrong
party — it reasoned explicitly and documented the reasoning, it just never asked whether anything besides
the caller was watching the transition.

## The test-side symptom this produced

`worker-run-gate.mjs` scenario (K) used to wait on the op's settle state, on an inline comment asserting the
transition "happens synchronously, in the SAME un-awaited callback turn as the push" — true before
`691a2184`, false after. Under an uncontended host the gap is far under the poll interval and the test
always wins; under real suite contention it can exceed it, producing a `PASS/FAIL/FAIL/FAIL/FAIL/PASS`
signature (the derived-text assertions fail while the first/last, untouched by this race, still pass). Card
`c4b70fe8`'s own fix (commit `ab325cc8`) moved (K) onto the actual nudge-DELIVERY signal instead
(`enqueued.some(isGateFailedMsg)`), and separately re-derived the "exactly one, no duplicate" guarantee the
old state-based wait used to double as, via a three-leg structural argument (the registry invokes this
callback exactly once per settle; the callback reaches at most one `enqueueDurableMessage` per invocation,
since the `cancelled` branch returns before the fall-through; and JS run-to-completion means a same-tick
duplicate is already visible before any poll observes the first).

## Do not

- Do not add a NEW `await` anywhere in `onSettledAfterPending` between two potential nudge-send points (or
  make more than one send reachable from a single invocation) without re-checking
  `worker-run-gate.mjs` scenario (K) — it will NOT fail loudly; it silently degrades to proving only "≥1
  nudge arrived" instead of "=1", and a duplicate nudge can ship undetected.
- Do not trust an in-source "this changes nothing about ordering" claim on an async conversion without
  asking who besides the immediate caller observes the callback's effects — the caller and every other
  observer of the same state can have genuinely different exposure to the same change.
- Do not "fix" a settle-vs-delivery race like this one by widening a test's timing tolerance — that converts
  a real, catchable signal into a silent one.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts`, `runWorkerGate`'s `onSettledAfterPending`
callback declaration (the "⚠️ CORRECTION" and "⚠️ DEPENDENCY" paragraphs, immediately below the original
`74716cfb` "ASYNC (was sync)" doc — see [[74716cfb-deferreduntilevent-never-scanned-from-prose]] for that
sibling decision), commit `ab325cc88687f8854a9e661e4178c370f9e02ff3`, as of this tranche's HEAD.
