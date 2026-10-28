# 57f9cdd9 — never cache a union-merge/batch-ff canonical refusal as a rejection

From an UNVERIFIED question in card `2968815c`'s Code Review: does the pre-gate union-merge's own
bare-refusal fallthrough suffer the same replay bug card `08c36dae` fixed for the POST-squash sites?

Confirmed yes, via hermetic repro: `mergeMainIntoWorktree`'s main-tip read, identity probe, and `git
merge --no-edit` call (`git/worktrees.ts`) each had a bare-fallthrough catch returning `{ok:false,
reason}` with no flag on a structural `CanonicalGitRefusal` (thrown BEFORE any git process runs, nothing
mutated). `classifyOutcome` (`sessions/service.ts`) has no arm for this, falling to `merged ? "merged" :
"rejected"` — `"rejected"` is NOT `NEVER_CACHED_OUTCOMES`, and is cached under `verdictIdentity` (branch
tip + main tip), resolved BEFORE the union-merge runs, with zero dependency on canonical trust state. A
re-confirm after repair replayed the stale rejection, never re-attempting. Same shape at the batch
fast-forward's `--ff-only` refusal (`fastForwardCanonicalMain`, `git/batch-merge.ts`).

## The fix (Round 1)

Both sites set `canonicalTrustRefusal: true`, classified via the EXISTING `"canonical-trust-refusal"`
outcome (card `08c36dae`), already `NEVER_CACHED_OUTCOMES` — no new string. No `gate_status`/
`gate_history`/web-Gates consumer switches on the `classifyOutcome` string itself. Batch:
`FastForwardResult` → `RunBatchedMergeResult` → `MergeBatchResult.canonicalTrustRefusal`, a dedicated
no-fallback branch (mirroring `quarantined`).

## Round 2 (Code Review of 5913bfdf) — two more MAJOR drift sites, found by review not by me

**(1) The admission-time re-union dropped the flag too.** `AdmissionReunionFailedError`/
`rejectAdmissionReunionFailure` (and the inert-reclassify re-union, a THIRD `mergeMainIntoWorktree`
caller) each hand-copied `worktreeMissing`/`quarantined`/`dirtyWorktree` — exactly why
`canonicalTrustRefusal` silently drifted at both. Fixed STRUCTURALLY: extracted ONE shared
`classifyUnionMergeFailureKind(union)` (service.ts) all THREE callers now switch on, so a future flag is
added once, never re-derived per caller. `AdmissionReunionFailedError` gained a `canonicalTrustRefusal`
field + a `canonical_trust_refusal_at_admission` failReason; `rejectAdmissionReunionFailure` checks it
before the generic branch (whose "may be a transient git/filesystem issue" wording was FALSE for a
structural refusal — fixed by the early return, not a text edit). The inert-reclassify site now returns
the SAME shape immediately (mirroring its own `quarantined` early-return), never falling through.

**(2) The batch's own pre-ff read swallowed the refusal.** `fastForwardCanonicalMain` calls
`readHeadShaAndBranch` BEFORE `--ff-only`; that function's "never throws" contract swallows ANY raw error
to `null`, so a real refusal there was indistinguishable from an ordinary read failure. Fixed by passing
its existing `onRawError` hook, capturing `describeGitFailure(e).refusal`, returning
`canonicalTrustRefusal:true` from THAT read too.

**(3) Tool description + wording.** `merge_batch`'s description names the outcome + its
`[loom:merge-batch-trust-refusal]` nudge tag alongside the other no-fallback outcomes
(`agent-prompt-lint-surface-drift.mjs`/`agent-prompt-lint.mjs` re-run clean). The batch nudge's "Nothing
was mutated" was corrected to "Canonical repo untouched" (the house wording).

## Known residual (confirmed, NOT fixed — per explicit instruction to stop rather than widen)

When EVERY candidate drops during batch ASSEMBLY, `runBatchedMerge` returns the bare
`{ok:false, reason:"nothing landed cleanly into the batch — every candidate was dropped"}`
(`git/batch-merge.ts`, the `landed.length === 0` branch) — no flag at all, so `classifyOutcome` ALSO falls
to cacheable `"rejected"`. DIFFERENT from the fixed cases: each candidate's own drop already routes to a
REAL per-candidate solo fallback (`runFallback`, started:true) — content isn't stuck; a human can always
`worker_merge_confirm` each one directly. The residual is narrower: a `merge_batch` RE-FIRE with the SAME
unchanged candidate set, after repair, can replay this stale "nothing landed" verdict instead of
re-assembling — confirmed by observation (debugging this round's own (B1) fixture, before it was
corrected to isolate the fault to the ff-phase only). Not fixed per instruction.

## Do not

- Do not mint a new outcome string/flag for this shape anywhere in this family — reuse
  `canonicalTrustRefusal`/`"canonical-trust-refusal"`, already `NEVER_CACHED_OUTCOMES`.
- Do not classify by matching `reason`/message text — always `describeGitFailure(e).refusal`, never a
  string match (forgeable stderr, card `08c36dae`).
- Do not hand-copy `classifyUnionMergeFailureKind`'s if-chain at a FOURTH `mergeMainIntoWorktree` caller
  if one is ever added — call the shared function; that is the whole point of Round 2's extraction.
- Do not route the batch fast-forward's `canonicalTrustRefusal` through a per-candidate solo fallback —
  the refusal is about the CANONICAL CHECKOUT, not any candidate. Same no-fallback posture as
  `quarantined`.
- Do not conflate a per-CANDIDATE assembly drop (routes to a real solo fallback, fine) with an
  ALL-candidates-drop batch outcome (cacheable "rejected" — the Known Residual above).
- Do not forget the EOL repair on a freshly `Write`-created file: `git rm --cached` + `git checkout HEAD
  --` (commit first if uncommitted) before `working-tree-eol-guard.mjs` runs.
- Do not design an admission-time "never cached" test with an op-2 cache-replay check — the SAME
  main-advance that triggers that code path also moves `verdictIdentity` (captured at confirm-START,
  before it), so a fresh op-2 is a real identity MISS regardless of caching correctness (card `08c36dae`'s
  "don't build a vacuous discrimination test" trap). Prove the RESULT SHAPE only there; the never-cached
  PROPERTY is proven once, generically, by the plain pre-gate scenarios.

## Verification

Permanent test `packages/daemon/test/merge-confirm-verdict-cache-union-merge-refusal.mjs`: (A1) solo
identity probe (real commondir-pin-mismatch fault), (A2) solo main-tip read, (A3) solo merge call, (A4)
solo admission-time re-union (result-shape only, see "Do not"), (B1) batch pre-ff read (real fault, the
swallowed-refusal gap), (B2) batch `--ff-only`. RED-proofed via `negative-control --ref 5913bfdf` both
rounds (Round 1: 10→0; Round 2: 7→0, clean tree both times). Re-ran the `-transient`/main-advance
siblings green. The inert-reclassify route (main moving during the brief repo-guard-only wait, before
full admission) was verified by code reading only — shares the identical `classifyUnionMergeFailureKind`
call and an early-return shape identical to its own `quarantined` branch — not independently
timing-repro'd; disclosed rather than assumed covered.
