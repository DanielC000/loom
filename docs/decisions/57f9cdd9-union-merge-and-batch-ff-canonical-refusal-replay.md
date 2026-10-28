# 57f9cdd9 — never cache a union-merge (solo) or batch fast-forward canonical refusal as a rejection

From an UNVERIFIED question raised in card `2968815c`'s Code Review (2026-10-28): does the pre-gate
union-merge's own bare-refusal fallthrough suffer the same replay bug card `08c36dae` already fixed for
the POST-squash sites (`mergeBranchLocked`/`resetOrSkip`, `git/worktrees.ts`)?

Confirmed yes, via a hermetic reproduction (temp `LOOM_HOME`, real git, a `unionMergeGitFactory` test
seam that throws a real `CanonicalGitRefusal` then "repairs" itself) before any production code was
touched: the pre-gate union-merge's main-tip read, identity-fallback probe, and the `git merge --no-edit`
call itself (`mergeMainIntoWorktree`, `git/worktrees.ts`) each had a bare-fallthrough catch that returned
`{ok:false, reason}` with no distinguishing flag on a structural `CanonicalGitRefusal` (a commondir
redirect / pin mismatch, thrown BEFORE any git process runs, so nothing is mutated). `classifyOutcome`
(`sessions/service.ts`) has no arm for this shape, so it fell through to the generic `merged ? "merged" :
"rejected"` tail — `"rejected"` is NOT in `NEVER_CACHED_OUTCOMES` (`orchestration/pending-ops.ts`), and is
eligible for `retainVerdictUntilSuperseded` caching, keyed on `verdictIdentity` (branch tip + main tip),
resolved BEFORE the union-merge ever runs — i.e. with zero dependency on the canonical repo's trust
state. A re-confirm at the same (branch tip, main tip) identity after a human repaired the canonical
repo (cleared the commondir redirect / fixed the pin) was served the stale cached rejection verbatim,
with the real union-merge never re-attempted.

The SAME bare-fallthrough shape existed at the batch fast-forward's own `--ff-only` refusal
(`fastForwardCanonicalMain`, `git/batch-merge.ts` — card `3a5c5d4a`'s own comment there already notes "a
CanonicalGitRefusal is thrown BEFORE any git process runs... never fall through to it", but the RETURN
VALUE itself carried no flag), feeding `mergeBatchTracked`'s own `classifyOutcome` (`sessions/service.ts`),
which likewise had no arm for it and fell to `outcome.value.ok ? "landed" : "rejected"`.

## The fix

Both sites now set `canonicalTrustRefusal: true` on the bare-refusal return, and both callers classify it
via the EXISTING post-squash `canonicalTrustRefusal` / `"canonical-trust-refusal"` outcome (card `08c36dae`),
already `NEVER_CACHED_OUTCOMES` — no new outcome string, no new `NEVER_CACHED_OUTCOMES` entry. Checked:
the ONE consumer outside `classifyOutcome`/`NEVER_CACHED_OUTCOMES` that reads this field directly
(`confirmWorkerMerge`'s own post-squash `merge.canonicalTrustRefusal` branch, `sessions/service.ts`) is a
SEPARATE, later code path operating on a different local variable (`merge`, the squash step's own result)
— reusing the field name on the union-merge/batch-ff return values does not collide with it; each site
constructs its own dedicated wording (`mirroring` the post-squash branch's "nothing was squashed...
canonical repo and worktree are untouched... TRUST refusal" framing, substituting this step's own
"squash phase never reached" / "nothing was mutated" phrasing, since the generic claim is equally true
here and is what every sibling branch at these two call sites already asserts).

`deriveMergeGateVerdict`/`MergeBatchResult`'s settle-nudge wording were checked and do NOT switch on the
`classifyOutcome` string at all (only on `ConfirmMergeResult.merged`/`cancelled`/etc.) — so reusing the
classification string could not have broken either projection. No `gate_status`/`gate_history`/web Gates
page consumer switches on this outcome string either (grepped, zero hits outside `sessions/service.ts`
and `orchestration/pending-ops.ts`).

## Batch path — confirmed same bug, same fix

`mergeBatchTracked`'s own fast-forward refusal handling (`sessions/service.ts`) had dedicated branches for
`quarantined`/`indexLockPresent`/`canonicalRepoShallow`/`batchHeadMoved`/`branchDiverted`/`unverified`, but
NONE for a bare `CanonicalGitRefusal` from `fastForwardCanonicalMain`'s own `--ff-only` call — it fell to
the generic `!result.ok` branch, which (a) started a per-candidate solo fallback (wrong: the refusal
describes the CANONICAL CHECKOUT, not any candidate — a fallback would just re-hit the identical refusal
at each candidate's own solo confirm) and (b) classified `"rejected"` (cacheable), reproducing the SAME
replay bug one level up. Fixed with the identical reuse: `FastForwardResult.canonicalTrustRefusal` →
`RunBatchedMergeResult.canonicalTrustRefusal` → `MergeBatchResult.canonicalTrustRefusal`, a dedicated
no-fallback branch (mirroring `quarantined`), and a `classifyOutcome` arm reusing
`"canonical-trust-refusal"`.

## Do not

- Do not mint a new outcome string/flag for this shape at either site — `canonicalTrustRefusal` /
  `"canonical-trust-refusal"` (card `08c36dae`) already says exactly the right thing ("nothing was
  mutated, not an ordinary merge failure, a rebase won't fix it, never cache") and is already wired into
  `NEVER_CACHED_OUTCOMES`; a second string would just be the same fact under a different name.
- Do not classify this flag by matching `reason`/message text at either site — always
  `describeGitFailure(e).refusal` (worktrees.ts: `mainTipFailure.refusal` / `identityProbeFailure.refusal`
  / `mergeRefused`, which IS that same field) or `ffFailure.refusal` (batch-merge.ts) — never a string
  match, for the same forgeable-stderr reason card `08c36dae` already states.
- Do not route the batch fast-forward's `canonicalTrustRefusal` through a per-candidate solo fallback —
  the refusal is about the CANONICAL CHECKOUT, not any resolved candidate; every candidate would just
  re-hit the identical refusal. Same no-fallback posture as `quarantined`/`indexLockPresent`.
- Do not assume `assembleBatchBranches`'s own per-candidate `CanonicalGitRefusal` exposure needs the same
  fix — a per-candidate refusal there is pushed to `dropped` and the candidate falls back to a REAL solo
  confirm (already covered by this card's solo-path fix, since that fallback goes through
  `confirmWorkerMergeTracked`), never cached at the batch level at all. Only the batch's OWN
  `fastForwardCanonicalMain` call (and the solo path's `mergeMainIntoWorktree`) had the bare-fallthrough
  gap — verified by reading every `describeGitFailure`/`CanonicalGitRefusal` site in both files, not
  assumed from the shape alone.
- Do not trust a `tr -dc '\r'`/`tr -dc '\n'` EOL check's `CR==LF` pass condition on a file you just
  `Write`-created without first confirming its `git check-attr text eol` pin — this project's default
  `text=auto` pin is what makes `CR==LF` correct; a `Write`-created `.mjs` test file lands bare LF and
  needs the `git rm --cached` + `git checkout HEAD --` repair (commit first if not yet committed) before
  it passes `working-tree-eol-guard.mjs`.

## Verification

Hermetic repro (temp `LOOM_HOME`, real git, both solo via a real commondir-trust-pin-mismatch fault at the
union-merge's identity probe, and batch via a bare `CanonicalGitRefusal` thrown at the `--ff-only` call)
proved the replay pre-fix: op 2, after the fault cleared with branch/main tips unchanged, returned the
IDENTICAL opId/reason/detailText as op 1 with `cacheHit` set and zero new git attempts. Permanent test:
`packages/daemon/test/merge-confirm-verdict-cache-union-merge-refusal.mjs` — RED-proofed via
`negative-control` against the pre-fix code (10 failures reverted, 0 after restore, clean tree). Re-ran
the two sibling verdict-cache tests (`merge-confirm-verdict-cache-union-merge-transient.mjs`,
`merge-confirm-verdict-cache-main-advance.mjs`) green, confirming no regression to the existing transient/
main-advance classification logic.
