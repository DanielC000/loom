# dbc6f660 — `batch_merge_forfeited` is the ONE failure mode batching makes strictly worse than solo merges

## Narrative

Card dbc6f660: the batch-merge-gate FORFEIT case — canonical main advanced between a batch worktree being cut and its post-gate fast-forward, so the batch's single gate never validated main's real current tree. The batch is abandoned (never landed) and every candidate falls back to its own individual gate, exactly like today.

`detail` carries `{ opId, repoPath, baseMainSha, currentMainSha, reason, branches: [{ workerSessionId, taskId, branch }] }`. `currentMainSha` is the canonical HEAD `fastForwardCanonicalMain` observed instead of `baseMainSha`; it is typed optional (mirroring `RunBatchedMergeResult`) but in practice is ALWAYS present whenever this event fires, since `forfeited` and `currentMainSha` are only ever set together — an absent value would be OMITTED from `detail` (not emitted as `null` or `"undefined"`), matching how `appendEvent` (db.ts) already drops any undefined-valued key on `JSON.stringify`.

The per-branch identity list is what keeps "which branches did this one batch opId cover" recoverable (`LOOM_GATE_OP_ID` is a cross-project contract read by Codescape's gate child; batching re-means its per-run unit from "one branch" to "up to maxWorkers branches" without renaming/dropping it — see `gateOpIdEnvOverride`'s own doc in `sessions/service.ts`). This is the ONE failure mode batching makes strictly worse than today (1 branch's gate wasted → up to K), so it is instrumented distinctly from an ordinary `merge_rejected`/`build_gate` failure rather than folded into either.

### The overall design

Owner-specified design (see the task card + `.loom/research/batched-merge-gate-feasibility-2026-09-03.md`
for the full study): cut a dedicated batch worktree `B` from canonical main's current tip, land each ready
branch into `B` in turn (see card `6801c0a1` — individually, not squashed), gate `B` ONCE, and on green
fast-forward canonical main to `B`'s tip. Canonical main is mutated exactly once, at that fast-forward —
the forfeit case above is what protects that single mutation from landing on stale ground.

## A second, deeper defect fixed by this same card: `repoPath` vs `worktreePath` for `computeEmitCompareGate`

`computeEmitCompareGate` runs on the ALREADY-ASSEMBLED, FROZEN batch worktree — `gateBaseMainSha..HEAD`,
the UNION of every landed branch's own changes — reusing the SAME predicate `confirmWorkerMergeTracked`
already reuses for a solo merge, never a second one. `mergeBatchTracked`'s own call used to pass CANONICAL
`finalRepoPath` as that predicate's `repoPath` while resolving the literal ref `"HEAD"` — meaning
CANONICAL's own checked-out HEAD, not the batch worktree's, and (canonical hadn't advanced past
`gateBaseMainSha` yet) always diffed `gateBaseMainSha..gateBaseMainSha` — an EMPTY diff, unconditionally.
This — not merely "a batch's union is unlikely to qualify" — is the real reason every historical batched
`gate_history` row read `emitCompareReduced:null`: the predicate was structurally unable to ever decide a
batch. Confirmed against a real fixture batch before this fix landed. Passing `worktreePath` as BOTH the
`repoPath` and `worktreePath` arguments fixes it — a linked worktree shares its parent's object database,
so `gateBaseMainSha` still resolves fine; only "HEAD" now means what it should.

`buildReducedGateCommand`'s smaller command is substituted for `gateCommand` on a batch too WHEN THE
ASSEMBLED UNION PROVES ELIGIBLE, exactly as the solo path already does for one branch (card `d422e279`) — a
DIFFERENT decision from this card's own "keep the assembler dumb" SELECTION ruling above: that one is about
whether an individually-reduced-eligible branch should be excluded from a batch, which the Lead's own
measurement found doesn't pay AT THIS K (a reduced-eligible branch riding an already-full batch costs
nothing marginal) — and says nothing about a batch whose EVERY constituent branch is reduction-eligible,
where the assembled tree's own diff still proves inert and running the full ~15-20min suite buys zero
additional verification over the reduced command (observed in production: a K=2 batch of two test-only
branches ran full for over 11 minutes past the reduced band). `chosen` membership stays as dumb as decided;
only the ONE resulting gate run's OWN command can now reduce. Card `67030bb9`'s existing bounded
single/multi-file retry — the same generic failure-classification path the solo side already exercises
after its own reduced runs — applies unchanged to whichever command ran.

## Do not

- Do not fold a batch forfeit into an ordinary `merge_rejected`/`build_gate` failure kind — it is instrumented distinctly because it is the one failure mode batching makes strictly worse than a solo merge (up to K branches' gates wasted, not just 1).
- Do not emit `currentMainSha` as `null`/`"undefined"` when absent — omit the key entirely, matching `appendEvent`'s existing `JSON.stringify` behavior.
- Do not pass canonical `finalRepoPath` as `repoPath` while resolving `HEAD` for a batch's `computeEmitCompareGate` call.
- Do not conflate batch SELECTION with gate-COMMAND reduction — different decisions.
- Do not design a new retry mechanism for a batch's gate command — `67030bb9`'s bounded retry already covers it.

## Source

Inline comment in `packages/shared/src/types.ts` (`OrchestrationEventKind`'s `batch_merge_forfeited` case doc). Relocated by card 35d90c4e (tranche 1 on `packages/shared/src/types.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `//` comment markers stripped.

### Source (2)

Inline comment in `packages/daemon/src/sessions/service.ts`, `mergeBatchTracked`'s own JSDoc header, as of
this tranche's HEAD.
