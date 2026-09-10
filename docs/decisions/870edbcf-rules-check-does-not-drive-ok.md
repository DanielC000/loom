# 870edbcf — `rulesCheck` deliberately does NOT drive the overall `ok`, unlike `archiveCheck`

## Narrative

DoD-2 decision: `rulesCheck` (the readability report for a supplied `rulesPath` union source) deliberately does NOT drive `checkRotation`'s overall `ok`, unlike `archiveCheck`.

Rejected: folding `rulesCheck` into `ok` the same way `archiveCheck` is — that would flip an otherwise-green result to false purely because an OPTIONAL supplementary verification source was unavailable, even when every marker is still genuinely present in the active doc itself (the union's whole point is that this is a legitimate pass on its own). That would also be a behavior change for any existing caller that passes `rulesPath` speculatively.

Chosen instead: report-only. `rulesCheck` is always present and loud whenever a `rulesPath` was supplied and failed to read — the same "loud field" shape this module already uses for `unconfiguredWarning` on a vacuous `ok:true`. `archiveCheck` stays different on purpose: it validates a required rotation ARTIFACT (the archive this rotation is actually producing), not an optional verification aid — the two fields look symmetric but protect different kinds of guarantee.

See `docs/decisions/e312b207-live-commitments-floor-unioned-with-rules.md` for a later correction to this decision's scope: "not folded into `ok`" does not mean `rulesCheck.ok:false` can never affect `ok` at all — it still can, indirectly, through `liveCommitments`/`missingMarkers`, once the rules-file union is the only remaining place a marker or heading survives.

## Do not

- Do not fold `rulesCheck.ok` directly into the `ok` formula — that would flip a legitimately-passing result to false over an unavailable optional verification aid.
- Do not treat `archiveCheck` and `rulesCheck` as needing the same treatment just because their shapes look similar — `archiveCheck` guards a required artifact, `rulesCheck` an optional supplementary source.
- Do not read this decision as "`rulesCheck.ok:false` can never affect `ok`" — see the linked correction; the indirect path through `liveCommitments` is real.

## Source

Inline comment in `packages/daemon/src/orchestration/rotation-check.ts` (the `ok` computation in `checkRotation`), as of this tranche's HEAD, prior to compression. Extracted by card `1c247269` (tranche 1 on `orchestration/rotation-check.ts`).
