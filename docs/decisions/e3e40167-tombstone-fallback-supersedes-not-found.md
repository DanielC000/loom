# e3e40167 — a live-registry miss falls through to the permanent tombstone table, superseding the old "not_found" shape

## Narrative

Card e3e40167 (superseding the original edc1ec12/fc243a43 `"not_found"` shape): a live-registry miss (`GateSemaphore.findByOpId` → `kind:"none"`) is no longer reported as `"not_found"` — it falls through to `Db.findPendingGateOpByOpId`, the SAME scoped id-or-prefix resolution over the PERMANENT `pending_gate_ops` tombstone table (never pruned), and returns that row's OWN terminal state: `"settled"`, `"evicted-dead-owner"`, or `"orphaned-by-restart"`.

This generalizes the tool's terminal-outcome vocabulary to FOUR "not live, not found" outcomes, not three: `"never_existed"` is a POSITIVE assertion the id was NEVER MINTED, provable ONLY over an UNSCOPED full-table/full-registry view (every manager call site — no candidate was ever filtered out, so a miss really does mean gone); `"unknown"` is the honest-ambiguity sink for a SCOPED caller's miss — it covers BOTH "this id genuinely never existed" AND "this id exists but isn't yours", and a scoped caller can never tell those apart (nor should it be able to). An AMBIGUOUS prefix at EITHER layer is a DISTINCT outcome, `state:"ambiguous"` with an `error` naming the matching opIds — it must never collapse into `never_existed`/`unknown` either. See [[edc1ec12-gate-status-is-read-only-with-no-passfail-outcome]] for the full `gate_status` mechanism this fallback is part of.

## Do not

- Do not report a live-registry miss as `"not_found"` — fall through to the durable `pending_gate_ops` tombstone and return its own terminal state.
- Do not collapse a scoped caller's ambiguous-prefix miss into `never_existed`/`unknown` — `"ambiguous"` is a distinct, required outcome.

## Source

JSDoc comment in `packages/daemon/src/sessions/service.ts` (`gateStatus`). Relocated by card `f05ca65c` (tranche 8); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
