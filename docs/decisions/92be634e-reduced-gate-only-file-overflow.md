# 92be634e — the reduced gate's `--only=` selection overflows to a file above a safe char threshold

`buildReducedGateCommand` (git/worktrees.ts) builds `pnpm --filter @loom/daemon test:daemon --only=<names>`
with no length bound. Every gate step is spawned via `shell:true` (gate-runner.ts), so on win32 that is
cmd.exe, whose command-line ceiling is ~8191 chars — a reduced gate with a large changed-test/importer set
(the test-importer fold-in, card 72769424, can pull in hundreds of files for a widely-imported module) can
exceed it and fail as a false RED with a misleading "command line too long", never naming the real cause.

Card cee17efe already fixed the identical hazard for the dist-importer check's own `--only=` selection by
adding `--only-file=<path>` to `scripts/test-daemon.mjs` (a newline-separated file, parsed by
`parseOnlyFileNames`). This card reuses that SAME harness-side mechanism for `buildReducedGateCommand`'s
three callers (sessions/service.ts: solo-merge pre-wait, solo-merge admission re-derivation, batch) —
never a second CLI flag or parser.

## Design

- `REDUCED_GATE_ONLY_INLINE_MAX_CHARS` (6000) is a conservative margin under the real ~8191 ceiling,
  leaving headroom for the step's own prefix and cmd.exe's `/d /s /c` wrapper overhead.
- Below the threshold, `buildReducedGateCommand` is byte-identical to before this card — no FS access,
  `opts` fully optional — since every existing call site's list is small and never crosses it.
- Above the threshold, the selection is written (via an injectable `writeOnlyFile`, defaulting to a real
  `fs.writeFileSync`) to a caller-supplied `onlyFilePath`, and the step becomes
  `--only-file=<JSON.stringify(path)>` instead.
- The file lives OUTSIDE the worker's own worktree — `gateOnlyListPath(opId)` (orchestration/gate-spill.ts),
  under the same `GATE_SPILL_DIR` (`LOOM_HOME/gate-output`) the per-op output spill log already uses, keyed
  by opId the same way. Verified: `computeWorktreeGateStamp`'s dirty-tree check (card 975c774b, both the
  pre-gate refusal and the post-settle "uncommitted edits" flag) scopes `git status --porcelain` strictly
  to `worktreePath` — a file under `LOOM_HOME` is structurally invisible to it. This is the OPPOSITE
  placement from the dist-importer check's own only-file (written inside ITS OWN throwaway worktree) —
  safe there only because that worktree is never merge-gated and is discarded whole; unsafe here, where the
  worktree is the worker's live, dirty-checked one.
- All three production callers (service.ts) ALWAYS pass `onlyFilePath: gateOnlyListPath(opId)` — never the
  implicit default-writer path with no explicit path, which exists only so a unit test can exercise the
  real writer without a caller-supplied path.
- Cleanup: a best-effort `fs.rmSync(gateOnlyListPath(opId), { force: true })` runs in each path's own
  `onSettle` hook (solo-merge's `confirmWorkerMergeTracked`, batch's `mergeBatchTracked`) — both fire
  exactly once per genuine settle (pass/fail/cancel/**error**), after any retries within that one attempt,
  so a thrown `ReducedGateOnlyFileError` (or any other throw) still cleans up. The batch path's cleanup
  deliberately does NOT live inside the `runGate` closure's own happy-path tail (that tail is skipped on
  any throw, including the pre-gate catch below) — it must be in the outer `onSettle`, symmetric with solo.
- A boot-time sweep (`sweepStaleGateOnlyFiles`, orchestration/gate-spill.ts, called from
  `reconcileRunsOnBoot` in sessions/service.ts) unconditionally deletes every `*.only.txt` file still
  present at boot — no merge/batch op survives a daemon restart, so anything left is from an owning op
  whose `onSettle` never ran (a crash mid-gate). No "still in use" classification needed, unlike
  `pruneGateSpills`'s retention policy for diagnostic `.log` spills.
- Verified `pruneGateSpills`/`listGateSpillOpIds` (gate-spill.ts) filter strictly on `.endsWith(".log")` —
  a `.only.txt` file in the same `GATE_SPILL_DIR` is structurally invisible to that sweep: never counted,
  never misclassified as a spill, never deleted by it. This is intentional, not a gap: the only-file's
  lifecycle is owned entirely by the `onSettle` cleanup + boot sweep above, never the spill-retention sweep.
- **Never cached — BOTH paths, two separate `classifyOutcome` lambdas.** A write failure is a real,
  resolved fact about THIS attempt's own prep step (a transient host condition), never about the branch's
  content — so it must never be served from either of `PendingOpRegistry`'s caches to a later re-call.
  `ConfirmMergeResult.reducedGateOnlyFileFailed` / `MergeBatchResult.reducedGateOnlyFileFailed` are the
  distinct flags (mirror `ungatedLandingCheckFailed`'s shape exactly) on each path's own result type.
  `confirmWorkerMergeTracked`'s `classifyOutcome` (solo) AND `mergeBatchTracked`'s `classifyOutcome` (batch)
  EACH map their own flag to the outcome string `"reduced-gate-only-file-failed"`, checked before their own
  plain merged-or-rejected / landed-or-rejected fallback — two separate lambdas, so the batch one needed
  its own branch added; it is not inherited from the solo one. That string is in `NEVER_CACHED_OUTCOMES`
  (orchestration/pending-ops.ts), shared by both. **Round-2 correction:** an earlier version of this record
  claimed the batch path "never reaches this cache dimension... already uncached by construction" — false;
  `mergeBatchTracked`'s own `classifyOutcome`/until-superseded cache is a REAL, separate mechanism from the
  solo path's, and without its own branch a batch write failure classified as plain `"rejected"` and WAS
  cached (confirmed: a same-candidates re-fire replayed the stale refusal instead of re-gating).
- **Never a merge-gate RED either — a THIRD, independent dimension from caching.** Caching (above) and
  merge-gate state (`recordMergeGateFailure`/`gateOwed`/the failure ring/the ungated-interval counter) are
  separate concerns with separate guards; fixing one does not fix the other. `isMergeGateRed` (the ONE
  shared rule, card 13571c71, never special-cased itself) would read this failure as a genuine RED on the
  batch path, because `runBatchedMerge`'s own `gateFailed: isMergeGateRed(gate)` has no way to tell "no
  step ever spawned" apart from "a step spawned and failed" — so the override lives one level up, at that
  one construction site: `gateFailed` is forced to `false` specifically when `gate.detail.
  reducedGateOnlyFileFailed` is set, mirroring the `cancelled` override on the very same line. This is NOT
  the same fix as the caching one above — a batch write failure could in principle be correctly classified
  for caching (via `classifyOutcome`) while STILL being wrongly recorded as a merge-gate RED (via
  `gateFailed`) if only one of the two fixes were made; both are required. The solo path never had this
  second problem — `rejectReducedGateOnlyFileFailure` never calls `recordMergeGateFailure` at all.
- **Batch path's write failure is caught pre-gate, inside `runGate` itself.** The catch sits at the exact
  point `buildReducedGateCommand` is called — before any gate step would spawn — and resolves to an
  ordinary `BatchGateResult` (`{ passed: false, reason: ..., detail: { reducedGateOnlyFileFailed: true } }`
  — the `detail` flag is what the `gateFailed` override above and the `MergeBatchResult` threading both
  key on). `runBatchedMerge`'s own `!gate.passed` branch then routes it through the normal per-candidate
  solo fallback (nothing landed in the batch itself) — never left to propagate past `runGate` and be
  classified by the OUTER batch catch as a genuinely unknown post-gate state (that classification is for a
  failure whose effect on what landed is actually unknown; this one isn't — nothing ran yet).

## Do not

- Do not raise `REDUCED_GATE_ONLY_INLINE_MAX_CHARS` toward the real ~8191 ceiling, or shrink its margin,
  without re-deriving both the real ceiling and the step's own prefix length.
- Do not let a production caller omit `onlyFilePath` — `buildReducedGateCommand` throws
  `ReducedGateOnlyFileError` rather than defaulting to an implicit `os.tmpdir()` path nobody tracks.
- Do not swallow a `writeOnlyFile` failure (EACCES, ENOSPC, ...) into a silent fallback onto the
  over-length inline `--only=` — it must surface as a `ReducedGateOnlyFileError` naming the real cause.
- Do not write the only-file inside the worktree being gated — it must live under `GATE_SPILL_DIR`
  (outside every worktree), or it risks tripping the dirty-tree refusal/flag (card 975c774b).
- Do not add the `.only.txt` cleanup to the run_gate self-check or deploy-gate `onSettle` hooks — neither
  ever calls `buildReducedGateCommand`, so neither can ever create this file; only the solo-merge and
  batch settle hooks need it.
- Do not fold `.only.txt` into `pruneGateSpills`'s `.log`-only sweep "for consistency" — its lifecycle is
  owned by the `onSettle` cleanup + boot sweep, never the count/byte-retention policy spill logs use.
- Do not cache or replay a `"reduced-gate-only-file-failed"` outcome, and do not drop it from
  `NEVER_CACHED_OUTCOMES` — a branch-keyed cache key can't see a transient host condition clear.
- Do not let the batch path's write failure escape `runGate`'s own closure uncaught — that is exactly what
  used to land it in the outer "state UNKNOWN" classification instead of an ordinary, already-safe RED.
- Do not skip `writeReducedGateOnlyFileReal`'s own `mkdirSync(dirname, {recursive:true})` — `GATE_SPILL_DIR`
  is never pre-created, so a fresh `LOOM_HOME`'s first overflow would otherwise fail with ENOENT.
- Do not add a `reducedGateOnlyFileFailed` branch to only ONE of the two `classifyOutcome` lambdas
  (`confirmWorkerMergeTracked`'s or `mergeBatchTracked`'s) — they are separate functions over separate
  result types; a fix to one does not reach the other, and the untouched one keeps caching the refusal.
- Do not let a batch write failure set `gateFailed: true` (via a bare `isMergeGateRed(gate)` with no
  override) — that records a real merge-gate RED (`recordMergeGateFailure`, `gateOwed`, the failure ring,
  the ungated-interval counter) for a failure where no gate step ever ran. Do not "fix" this by special-
  casing `isMergeGateRed` itself — it is the one shared rule for both paths (card 13571c71); override at
  the one construction site in `batch-merge.ts` instead, keyed on `gate.detail.reducedGateOnlyFileFailed`.
- Do not move the boot-time `.only.txt` sweep's call site back inside `reconcileRunsOnBoot` (sessions/
  service.ts) — it must be its OWN try block in index.ts, independent of the run-reconcile try above it,
  or an unrelated throw in that earlier logic silently skips the sweep too.
