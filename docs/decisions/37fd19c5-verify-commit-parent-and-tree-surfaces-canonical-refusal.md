# 37fd19c5 — `verifyCommitParentAndTree` surfaces a caught canonical git refusal instead of swallowing it

Follow-up to `2968815c`'s Code Review (2026-10-28): `verifyCommitParentAndTree` (`git/worktrees.ts`) had a
catch-all `catch { return { ok: false } }` around its own `cat-file -p`/`rev-parse --verify` reads. Either
read can throw a `CanonicalGitRefusal` (`checkCommondirTrust` runs before EVERY canonical git call,
reads included) — the catch-all swallowed that classification entirely. Its two batch callers
(`batch-merge.ts`'s `landBranchCommitsIndividually`, the "plain" per-commit tip check at ~:896 and the
"final" post-loop tip check at ~:1022) then reported ANY `!ok` — refusal or genuine mismatch alike — as
the same fixed "...may have been tampered with" sentence, never routing a real refusal through
`describeGitFailure`/`canonicalFailureMessage` the way every sibling catch in this file already does
(card `2968815c`'s own fix covered the catches immediately AROUND this call — the write-tree capture, the
commit call, the post-commit `rev-parse HEAD` read — but never this function's own internal catch).

## What changed

`verifyCommitParentAndTree`'s catch now returns `{ ok: false, errorDetail: describeGitFailure(e) }` —
captured unconditionally (never gated on `instanceof CanonicalGitRefusal`; an ordinary transient read
failure classifies just as cleanly and costs nothing extra). The three genuine parent/tree MISMATCH
returns (no exception at all — wrong parent count, wrong parent, wrong tree) are unchanged and carry no
`errorDetail`. The function still never throws — `mergeBranchLocked`'s own `verifyLandedAsOwnCommit`
closure (worktrees.ts, the solo squash path) explicitly relies on that contract and is untouched by this
card.

At the two named batch call sites (`batch-merge.ts` ~:896 and ~:1022), `!ok` now branches on
`errorDetail`: present → render `canonicalFailureMessage(errorDetail, errorDetail.text)` (no doubled
"refused:" prefix, per `26084115`'s own rule); absent → the exact pre-existing "...may have been tampered
with" sentence, unchanged. `headMoved: true` is set in BOTH branches — this is a wording-only fix, not a
severity change: either way the batch worktree's own commit identity could not be trusted, and
`043d83d2`'s no-per-candidate-fallback/no-retention treatment for any `headMoved` fact still applies
regardless of cause. `rollback()`/`quarantined`/`transient` are untouched at both sites — neither branch
sets them today and nothing here adds a reason to.

## Named residual: the solo path (caller C) keeps its own, different fail direction

`mergeBranchLocked`'s `verifyLandedAsOwnCommit` closure (worktrees.ts ~:11092) also calls
`verifyCommitParentAndTree` and also never inspects the new `errorDetail` field. Unlike the batch path, a
refusal reaching this closure does NOT abort anything — `classifyLandedVerify` maps `!verify.ok` (refusal
or genuine mismatch, both) to `landedBase: undefined` → `landedVerify: "rejected"`, and the ENCLOSING
`mergeBranchLocked` call still returns `ok: true` (the squash commit itself genuinely landed), only
annotated with the `"rejected"` advisory. This never claims "verified" (fail-closed on the trust
decision — the ledger base is not stamped), but it is also not a refusal of the merge itself, and gets no
refusal-specific rendering of any kind. This asymmetry is pre-existing and deliberately NOT changed by
this card — scoped out by explicit manager ruling at this card's investigate-first checkpoint. A future
card wanting parity would need to decide, independently, whether a mid-verify refusal on the solo path
should become a harder outcome than today's silent "rejected" advisory — not assumed here.

## Code Review follow-up round: the `sessions/service.ts` `batchHeadMoved` fallback tail is now closed

The first round of this card left `sessions/service.ts`'s `batchHeadMoved` fallback tail as a named
residual (decision `45036494`'s own "Do not" explicitly flagged it: "a future change reintroducing a
non-tamper `headMoved` cause must re-examine that tail before trusting it" — this card is such a change).
Code Review on the first round found that residual becomes a REAL self-contradiction the moment it lands
(a tail asserting "may have been tampered with; re-firing is safe" unconditionally, right after a reason
that can now say "do not retry"/"escalate" for a genuine refusal) — closed in this same card, as follow-up
commits, rather than left open.

**(1) The `runFallback` tail (`service.ts` ~:23497) is now CAUSE-NEUTRAL.** It no longer asserts "may
have been tampered with" or "is safe" unconditionally — it states the one fact every cause shares ("could
not be verified as this batch's own commit"), defers the tamper/safety verdict to `result.reason` ("see
the reason above"), and conditions its own "re-firing is safe" clause on that reason NOT saying to
escalate or not to retry. Every other factual clause (the shared, worker-writable `.git`; the worktree
NOT being retained; the durable `batch_merge_head_moved` event surviving) is unchanged. The stale
`45036494` invariant comment immediately above it (its own premise — only a legitimate commit-msg hook
could reach `headMoved` with a non-tamper cause — no longer held once a swallowed refusal could too) is
replaced with a comment stating the new, correct invariant.

**(2) The batch-merge.ts errorDetail branches (~:897, ~:1048) now distinguish refusal from ordinary
failure.** Removing the tail's unconditional tamper assertion meant an ORDINARY (non-refusal) read
failure — a plain ENOENT/timeout, `errorDetail.refusal === false` — would otherwise lose the tamper hint
entirely (nothing in a non-refusal's own `canonicalFailureMessage` rendering says anything cautionary).
Both sites now append the exact pre-existing "...this worktree's HEAD lives in the shared, worker-writable
.git and may have been tampered with" clause when `!errorDetail.refusal`, typed on that boolean — never by
matching `canonicalFailureMessage`'s own output text. A genuine refusal (`errorDetail.refusal === true`)
gets no such append — its own guidance already tells a human what to do.

**(3) Tests added** (`canonical-refusal-guidance-on-every-surface.mjs`'s (O)/(P), `batch-merge-head-
moved.mjs`'s (T)): (O) proves the ordinary-failure tamper-hint append at the unit level; (P) proves
`verifyCommitParentAndTree`'s catch covers its SECOND internal read (`rev-parse --verify ...^{tree}`),
not just the first; (T) drives a real refusal end-to-end through `mergeBatchTracked` → `runFallback` and
asserts on the ACTUAL per-candidate fallback text — the top-level reason, every fallback entry, AND the
tail's own cause-neutral wording. `negative-control --ref a88de053` confirmed RED on exactly (O)'s one
check and (T)'s four tail-specific checks (every other (T) check, already correct from the first round,
stayed green pre-fix) — precisely the diff this round made, nothing more.

## Do not

- Do not gate `verifyCommitParentAndTree`'s `errorDetail` capture on `instanceof CanonicalGitRefusal` — an
  ordinary transient read failure (a timeout, an ENOENT) classifies through `describeGitFailure` just as
  cleanly, and `canonicalFailureMessage` already falls back to the raw text for a non-refusal; gating it
  would leave that class with the misleading tamper wording too, the same defect this card fixes.
- Do not make `verifyCommitParentAndTree` throw instead of returning `errorDetail` — `mergeBranchLocked`'s
  `verifyLandedAsOwnCommit` closure explicitly relies on the "never throws" contract (its own comment says
  so); rethrowing would require auditing and fixing every caller's own catch, not just the two named here.
- Do not change `headMoved`/`rollback`/`quarantined` semantics at either batch call site as part of this
  card — it is wording-only; the same no-fallback, worktree-discarded severity applies to a refusal as to
  a genuine mismatch, because either way the commit's identity could not be trusted.
- Do not treat the solo path's `verifyLandedAsOwnCommit`/`classifyLandedVerify` asymmetry as fixed by this
  card — it is an explicitly scoped-out residual (see above), not an oversight.
- Do not reassert "tampered with"/"safe" as an UNCONDITIONAL verdict in the `runFallback` `noStart` tail
  (`service.ts` ~:23497), even for a seemingly unrelated future edit — defer to `result.reason`, printed
  just above it, which is the only place a real refusal's own guidance lives.
- Do not drop the batch-merge.ts errorDetail branches' tamper-hint append for an ordinary (non-refusal)
  read failure (`!errorDetail.refusal`) — an ordinary failure proves nothing safe about that HEAD, and the
  cause-neutral tail above no longer supplies a fallback caution of its own.
- Do not classify a batch drop's cause by matching `result.reason`'s own text anywhere downstream — per
  `08c36dae`'s own rule, a reason string is for display only; the tamper-hint append above is typed on
  `errorDetail.refusal` for exactly this reason, never on text. A real typed classification for a batch
  drop more generally still needs a field threaded from the producer, which `2968815c`'s own "Known
  residual" section already named as unimplemented (`BatchDroppedBranch` carries only `reason`/
  `conflict`, nothing else from `LandResult`) — unchanged by this card.
