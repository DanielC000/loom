# 57f9cdd9 — never cache a union-merge/batch-ff canonical refusal as a rejection

From an UNVERIFIED question raised in card `2968815c`'s Code Review (2026-10-28): does the pre-gate
union-merge's own bare-refusal fallthrough suffer the same replay bug card `08c36dae` already fixed for
the POST-squash sites (`mergeBranchLocked`/`resetOrSkip`, `git/worktrees.ts`)?

Confirmed yes, via a hermetic reproduction (temp `LOOM_HOME`, real git, a `unionMergeGitFactory` test
seam throwing a real `CanonicalGitRefusal` then "repairing" itself) before any production code was
touched: the pre-gate union-merge's main-tip read, identity-fallback probe, and `git merge --no-edit`
call (`mergeMainIntoWorktree`, `git/worktrees.ts`) each had a bare-fallthrough catch returning
`{ok:false, reason}` with no distinguishing flag on a structural `CanonicalGitRefusal` (thrown BEFORE any
git process runs, so nothing is mutated). `classifyOutcome` (`sessions/service.ts`) has no arm for this
shape, falling to the generic `merged ? "merged" : "rejected"` tail — `"rejected"` is NOT in
`NEVER_CACHED_OUTCOMES`, and IS eligible for `retainVerdictUntilSuperseded` caching keyed on
`verdictIdentity` (branch tip + main tip), resolved BEFORE the union-merge ever runs — zero dependency on
the canonical repo's trust state. A re-confirm at the same identity after a human repaired the canonical
repo (cleared the commondir redirect / fixed the pin) was served the stale cached rejection verbatim,
with the real union-merge never re-attempted.

The SAME bare-fallthrough shape existed at the batch fast-forward's own `--ff-only` refusal
(`fastForwardCanonicalMain`, `git/batch-merge.ts` — card `3a5c5d4a`'s own comment there already notes the
refusal mutates nothing, but the RETURN VALUE carried no flag), feeding `mergeBatchTracked`'s own
`classifyOutcome`, which likewise fell to `outcome.value.ok ? "landed" : "rejected"`.

## The fix

Both sites now set `canonicalTrustRefusal: true` on the bare-refusal return, and both callers classify it
via the EXISTING post-squash `canonicalTrustRefusal` / `"canonical-trust-refusal"` outcome (card `08c36dae`),
already `NEVER_CACHED_OUTCOMES` — no new outcome string or entry needed. The ONE other consumer of this
field (`confirmWorkerMerge`'s post-squash `merge.canonicalTrustRefusal` branch) operates on a different,
later local variable, so reuse here doesn't collide; each new site writes its own wording ("squash phase
never reached" / "nothing was mutated", matching its own siblings, never copying the post-squash text).

Confirmed: no `gate_status`/`gate_history`/web-Gates consumer switches on the `classifyOutcome` string
itself — reusing the string could not have broken either projection.

## Batch path — confirmed same bug, same fix

`mergeBatchTracked`'s fast-forward refusal handling had dedicated branches for `quarantined`/
`indexLockPresent`/`canonicalRepoShallow`/`batchHeadMoved`/`branchDiverted`/`unverified`, but none for a
bare `CanonicalGitRefusal` from `fastForwardCanonicalMain`'s `--ff-only` call — it fell to the generic
`!result.ok` branch, which (a) wrongly started a per-candidate solo fallback (the refusal describes the
CANONICAL CHECKOUT, not any candidate — every fallback would just re-hit the identical refusal) and (b)
classified `"rejected"` (cacheable), reproducing the same replay bug one level up. Fixed identically:
`FastForwardResult` → `RunBatchedMergeResult` → `MergeBatchResult.canonicalTrustRefusal`, a dedicated
no-fallback branch (mirroring `quarantined`), and a `classifyOutcome` arm reusing
`"canonical-trust-refusal"`.

## Do not

- Do not mint a new outcome string/flag for this shape at either site — `canonicalTrustRefusal` /
  `"canonical-trust-refusal"` (card `08c36dae`) already says exactly the right thing and is already in
  `NEVER_CACHED_OUTCOMES`; a second string would just be the same fact under a different name.
- Do not classify this flag by matching `reason`/message text — always `describeGitFailure(e).refusal`
  (`mainTipFailure.refusal` / `identityProbeFailure.refusal` / `mergeRefused`, worktrees.ts;
  `ffFailure.refusal`, batch-merge.ts) — never a string match (forgeable stderr, card `08c36dae`).
- Do not route the batch fast-forward's `canonicalTrustRefusal` through a per-candidate solo fallback —
  the refusal is about the CANONICAL CHECKOUT, not any candidate; every candidate would just re-hit the
  identical refusal. Same no-fallback posture as `quarantined`/`indexLockPresent`.
- Do not assume `assembleBatchBranches`'s own per-candidate `CanonicalGitRefusal` exposure needs this fix
  too — a per-candidate refusal there is pushed to `dropped`, and that candidate falls back to a REAL
  solo confirm (already covered by the solo-path fix above), never cached at the batch level at all. Only
  `fastForwardCanonicalMain`/`mergeMainIntoWorktree` had the bare-fallthrough gap — verified by reading
  every `describeGitFailure`/`CanonicalGitRefusal` site in both files, not assumed from the shape alone.
- Do not forget the EOL repair on a freshly `Write`-created file (bare LF): `git rm --cached` + `git
  checkout HEAD --` (commit first if uncommitted) before `working-tree-eol-guard.mjs` runs.

## Verification

Hermetic repro (temp `LOOM_HOME`, real git; solo via a real commondir-trust-pin-mismatch fault at the
union-merge's identity probe, batch via a bare `CanonicalGitRefusal` at `--ff-only`) proved the replay
pre-fix: op 2, fault cleared with branch/main tips unchanged, returned the identical opId/reason/
detailText as op 1 with `cacheHit` set and zero new git attempts. Permanent test:
`packages/daemon/test/merge-confirm-verdict-cache-union-merge-refusal.mjs` — RED-proofed via
`negative-control` against the pre-fix code (10 failures reverted, 0 after restore, clean tree). Re-ran
the `-transient`/main-advance sibling verdict-cache tests green — no regression.
