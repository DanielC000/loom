# 3aec1df6 — CORRECTION: a settled `"merge"` row now carries a verdict too, and `gate_history.opId` is the full-diagnostic reach

## Narrative

Card 3aec1df6 corrects stale wording that used to claim "the 'merge' kind is UNCHANGED: `gate_status` on a settled merge op still never reports pass/fail/rejected" — that stopped being true the moment card 9f6598dd shipped (see [[9f6598dd-mergeverdict-derivation-closes-the-settled-merge-gap]]) and the comment was never updated to say so. A settled `"merge"` row gets the SAME verdict spread as a `"gate"` row, via `deriveMergeGateVerdict` (`confirmWorkerMergeTracked`'s own `onSettle`) — `gate_status(opId)` on a rejected merge DOES carry `gateDetail.failingTest`/`gateDetail.stderrTail`/`outputTail` today.

This is the surface `gate_history`'s own `opId` field (card 3aec1df6) exists to let a caller reach for the FULL diagnostic — `stderrTail`/`outputTail`/`phase`/`exitCode`/`signal`/`timedOut` still live only here, never on a `gate_history` row.

## Do not

- Do not assume a settled `"merge"` row never reports pass/fail — that claim is stale as of card 9f6598dd; `gate_status` on it carries the same verdict spread a `"gate"` row does.
- Do not duplicate `stderrTail`/`outputTail`/`phase`/`exitCode`/`signal`/`timedOut` onto a `gate_history` row — a caller needing them reaches for `gate_status(opId)` via the id `gate_history` already carries.

## Source

JSDoc comment in `packages/daemon/src/sessions/service.ts` (`gateStatus`). Relocated by card `f05ca65c` (tranche 8); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
