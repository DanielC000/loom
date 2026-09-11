# bcd3f690 — retire a rotation-gate marker only when the rule it protects is retired in the SAME cut, and land the script first

## Narrative

CUT 2026-09-02 (card `bcd3f690`, step 1 of the owner's "cleanup all bad ceremonies" directive 2026-09-01): three markers retired from `rotation-gate.mjs`'s `MARKERS` list because the rules they protected were retired in the SAME cut — `MY-PEER-SEND-LEDGER` (the per-send ledger is deleted outright), `ANNOUNCE-CANNOT-CARRY-A-SHA` (retired with the merge-announce obligation it qualified), `MGR122-FLOOR` (a floor on an announced number that no longer gets announced). The local marker copy dropped to 11 (later restored to 12 for `MGR122-FLOOR` — see `a681aed5`).

Ordering rule: it is the lead's job, not this card's, to land the matching cut in `Orchestrator Rules.md` §ROTATION-GATE and `Orchestrator Log.md`; this script intentionally lands FIRST so the next rotation's gate doesn't refuse the doc the vault edit is about to produce.

Two markers were deliberately kept despite looking like ceremony: `NO-CLEARANCE-FROM-SILENCE` (protects the repo against inferring authorization from silence, not etiquette) and `QUIET-LANE` (a measurement-honesty rule backing the gate-queue-read-at-fire interlock) — both still required.

This same cut also LOWERED `LIVE_COMMITMENTS_FLOOR` 20 → 12 (removing real numbered LIVE COMMITMENTS items alongside the 3 retired markers, based on the lead's own count of at least 12 surviving items) — see `34a6f07e` for the full floor-value lifecycle (raised 14→20, then lowered 20→12) and why lowering a `>=` floor ahead of the doc shrinking is always safe.

## Do not

- Do not retire a marker/floor entry here without confirming the rule it protects was retired in the SAME cut.
- Do not land the matching vault cut before this script's marker-list cut — the script must land FIRST so a rotation is never refused for a doc edit still in flight.
- Do not treat `NO-CLEARANCE-FROM-SILENCE` or `QUIET-LANE` as ceremony to cut — see the card for why both stayed.

## Source

Condensed/paraphrased from the inline file-header comment ("CUT 2026-09-02") in `packages/daemon/scripts/rotation-gate.mjs`, as of base sha `79bf901d` — this record's wording is NOT a verbatim quote of the source comment. Extracted by card `7a4c54f3` (tranche 1 on `packages/daemon/scripts/rotation-gate.mjs`).
