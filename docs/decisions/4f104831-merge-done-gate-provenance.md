# 4f104831 — gate provenance on `merge_done` and the card read

A landed card's `tasks_get` carries `mergeGate` `{gateRan, skipReason, gateOpId, gatedTip, overrideReason?, redSelfCheckOpId?}`, read from the landing's durable `merge_done` event (`gateProvenance`, nested). `gate_history` rows carry `gatedTip` (a `build_gate` row's `gatedTip`, a `worker_gate` row's `settleHead`).

## Ruling on 9ac3a739

Decision `9ac3a739` says not to add a new sha field on `merge_done`'s `detail` without checking with the manager. The manager cleared `gateProvenance.gatedTip` on this card: it is nested, it is the head the GATE ran on (not the landed sha), it is never a `merge_done` match key, and `landedSha` keeps its attribution-only meaning.

## Do not

- Do not use `gatedTip` to match or identify a landing; match on `mergedSha`.
- Do not read `gateRan:null` as "no gate" (a landing recorded before this stamp: unknown) or `gateRan:false` as a pass.
- Do not set `gatedTip` for a landing where no gate ran; the reused self-check's head is on its own `gate_history` row via `gateOpId`.
