# 518e7ff6 — the transient-kill retry's cancel-while-queued path records its own `build_gate_retry` row

## Narrative

SIBLING CAVEAT (card 518e7ff6): the transient-kill retry's own cancel-while-queued path ALSO has an earlier real attempt 1 — but there, attempt 1's `build_gate` row was already written before this retry even started, so nothing needs filling in on IT; instead a separate `build_gate_retry` row (also `cancelled:true`) records the retry's own missing verdict.

## Why this is a different shape than 318ac7b2's own fix, and how to read the resulting rows

This closes the sibling gap `318ac7b2` explicitly left open (see `gate_history`'s own tool doc and `gateOutcomeFromDetail`'s doc in db.ts, both updated alongside this fix). It is NOT the same shape as `318ac7b2`'s fix ([[318ac7b2-single-file-retry-cancel-while-queued-attempt1-not-lost]]). That retry's own `evt("build_gate", ...)` call sits AFTER its retry block, so a cancel there means no row exists yet at all for the op — `318ac7b2` fills that void. THIS retry's sibling `evt("build_gate", ...)` for attempt 1 already ran before this retry was ever queued — attempt 1 genuinely spawned and genuinely failed a retry-eligible (kill/timeout, never "genuine") run, and that row correctly reads `outcome:"reject"`. It is not wrong and is not touched here: `orchestration_events` is append-only (no UPDATE path), and attempt 1's own failure is a true, measured fact worth keeping regardless of what happens to the retry.

What's missing without this fix: a record of what happened to the RETRY itself. Every other way the transient-kill retry can end (a pass, a further failure) reaches its own `evt("build_gate_retry", ...)` — a cancel-while-queued was the one path that skipped it, leaving attempt 1's "reject" as the ONLY row `gate_history` showed for the op — indistinguishable from a definitive, no-second-chance rejection, when the truth was "we don't know: the mechanism built to tell a real bug from a transient kill was itself withdrawn before it could answer."

The fix emits the missing `build_gate_retry` row too: `cancelled:true` (checked FIRST by `gateOutcomeFromDetail` — reads `outcome:"cancelled"`, never "pass"/"reject") and `gateSpawned:false` (this retry's own admission never happened — no process spawned for it, unlike attempt 1's row, which correctly keeps `gateRan:true`); no `passed` field, since fabricating one would claim a verdict this retry never reached.

A consumer computing a rejection rate from `gate_history` must read this PAIRING — a `build_gate` "reject" row immediately followed (same `opId`) by a `build_gate_retry` "cancelled" row — as ONE unresolved op, not a rejection: the retry that could have confirmed or salvaged attempt 1's failure never ran. Counting the reject row alone (ignoring the paired cancellation) reproduces exactly the inflation `318ac7b2` fixed on the sibling path.

## Do not

- Do not conflate the transient-kill retry's cancel-while-queued handling with the single-file retry's (card 318ac7b2) — attempt 1's `build_gate` row is already written before the transient-kill retry starts, so this path instead writes a separate `build_gate_retry` row for the retry's own missing verdict.
- Do not count a `build_gate` "reject" row alone when the SAME `opId` is immediately followed by a `build_gate_retry` "cancelled" row — read the pairing as one unresolved op, not a rejection.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`ConfirmMergeResult.cancelled`, transient-kill-retry caveat): lines 545-560, as of commit `f9caa77e30d5c1a6dd994b6203261968c0dbf94f`. Relocated by card `8f4c8a8f`; no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped. The "different shape / how to read the rows" section above is from the cancel-while-queued catch block in `confirmWorkerMerge`'s TRANSIENT-KILL AUTO-RETRY block (as of this tranche's HEAD). Condensed and reworded, not verbatim.
