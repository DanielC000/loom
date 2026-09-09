# fd9edb87 — `GateRun.gateTimeoutMs` is the per-project RAW ceiling, not the ~2x effective one an auto-extend can reach

## Narrative

Card fd9edb87: the RESOLVED per-project `orchestration.gateCommandTimeoutMs` (ms) for this run's project, read server-side through the SAME `resolveConfig(project.config, platformConfig)` path the gate itself enforces, so a per-project override is reflected rather than the platform default. It exists so a cross-project reader can scale a "this lane has been held a long time" cue to each row's OWN bound: the timeout is per-PROJECT, so two rows in one snapshot can legitimately carry different values, and no single page-level constant can be correct for both.

`null` means the bound is genuinely UNKNOWN for this run — today only when the project row could not be read (deleted while its gate was still in flight), plus any older record predating this field. `null` is NOT a measured zero and NOT a licence to substitute a default: a reader with no bound cannot say whether a run is long, and must not warn on an invented one.

This is the RAW configured value — the HARD ceiling a post-timeout RETRY enforces — never the ~2× effective ceiling a FIRST attempt's one-time output-gated auto-extend can reach. Same convention as `GateProximity.fraction` (daemon `gate-runner.ts`), and for the same reason: that is the ceiling that actually bites. So an elapsed clock measured against this CAN legitimately pass 100% on a run that extended, and that is correct rather than a bug.

## Do not

- Do not substitute a default when `gateTimeoutMs` is `null` — a reader with no bound cannot say whether a run is long, and warning on an invented default is worse than not warning at all.
- Do not read `gateTimeoutMs` as the effective ceiling a first attempt's auto-extend can reach — it is the RAW per-project configured value (the hard ceiling a post-timeout retry enforces), so an elapsed clock measured against it can legitimately exceed 100% on an extended run.
- Do not use a single page-level constant for every row's timeout cue — the bound is per-project, and two rows in one snapshot can legitimately carry different values.

## Source

Inline comment in `packages/shared/src/types.ts` (`GateRun.gateTimeoutMs`'s field doc). Relocated by card 35d90c4e (tranche 1 on `packages/shared/src/types.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
