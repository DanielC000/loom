# 10fd660b — `GateRun`'s BATCHED-merge shape: `branch`/`taskId` are null by design, not a gap

## Narrative

Card 10fd660b: the BATCHED-merge shape (`merge_batch`, card dbc6f660) is one gate run that lands N worker branches together. Such a run legitimately has NO single branch, so `branch`/`taskId` are `null` BY DESIGN (that null pair is the batch signature other readers already key on) and MUST NOT be back-filled with a synthesized value — read `batched`/`branchCount`/`batchBranches` instead. `false`/`null` on every ordinary solo gate, which keeps rendering off `branch` exactly as before.

`branchCount` is the POST-ASSEMBLY LANDED count, NOT the requested one — a batch can drop a branch at assembly (a conflict), so it can be SMALLER than `batchBranches.length` (the trap recorded on card cf0e2e3b): that array is the REQUESTED set, captured before assembly. `null` only on a row/run recorded before the count was stamped.

Card b480dda9: neither field can express a WHOLESALE FORFEIT (main advanced mid-gate) — the gate itself still genuinely passed HERE, in the ACTIVE snapshot, at the instant it settled; the forfeit is a LATER fact (a separate `batch_merge_forfeited` event, decided only once the whole batch either fast-forwards or falls back) that cannot exist yet while this run is still live. This is not a gap in this type — it is inherent to what "active" means. Once the run settles, `GateHistoryRow.batchForfeited` is where that later fact is surfaced.

## Do not

- Do not back-fill `branch`/`taskId` with a synthesized value on a batched run — the null pair IS the batch signature other readers already key on.
- Do not use `batchBranches.length` as the landed branch count — that array is the REQUESTED set captured before assembly; use `branchCount` (the post-assembly landed count), which can be smaller on a dropped conflict.
- Do not treat a missing wholesale-forfeit signal on this ACTIVE-snapshot type as a gap — the forfeit is a later fact that cannot exist yet while the run is still live; see `GateHistoryRow.batchForfeited` once settled.

## Source

Inline comment in `packages/shared/src/types.ts` (`GateRun.batched`/`branchCount`/`batchBranches`'s field doc). Relocated by card 35d90c4e (tranche 1 on `packages/shared/src/types.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
