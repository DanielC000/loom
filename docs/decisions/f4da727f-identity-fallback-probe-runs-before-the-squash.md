# f4da727f — the identity-fallback probe runs BEFORE the squash, not cleaned up after it

Follow-up to card 8336b903 (`fix(git): pass the solo squash commit message by file, not -m`) — its
Code Review (reviewer 4ebe6aba) found this same pre-existing asymmetry one step earlier in
`mergeBranchLocked` (`packages/daemon/src/git/worktrees.ts`): the identity-fallback probe
(`resolveGitIdentityFallbackArgs`) ran AFTER `git merge --squash` had already staged the canonical
index, and its failure returned `{ok:false, reason:"identity-fallback probe: …"}` with no cleanup,
leaving the staged diff behind until a human reset the canonical index by hand.

## Round 1 (superseded) and why it wasn't enough

Round 1 routed the post-stage refusal through `resetOrSkip`, mirroring every sibling post-stage refusal
in this function. That fix was reviewed and shipped (commit 674110e4), but a focused Code Review (round
2) found it rarely helps in production: `resolveGitIdentityFallbackArgs`'s own probe (`probeGitIdentResolvable`,
`git/bounded.ts` ~83-94) swallows every thrown value EXCEPT a `CanonicalGitRefusal` — so in practice this
catch only ever fires for a commondir-trust refusal (a pinMismatch/redirect/unpinned kind). `resetOrSkip`'s
own `reset --hard` goes through the exact SAME `checkCommondirTrust` check (every `canonicalGit`-mediated
call re-checks it, not just once at construction). If the trust condition is persistent rather than a
one-shot transient flip, the cleanup's own reset is refused by the identical condition that failed the
probe — the residue survives anyway, now with no `quarantined`/`transient` flag to even signal it (a
plain, unflagged "reset --hard failed" fallback). Reproduced directly (reviewer's own repro, re-run by the
round-2 worker): against round 1's code, a persisting commondir-trust mismatch leaves `STAGED_AFTER` with
the worker's file still staged, and the reason text embeds the SECOND failed reset attempt.

## Round 2 (current): move the probe before the squash

The probe is READ-ONLY (two `git var` calls) and depends only on `repoPath`/env — never on the staged
index. Moved to run BEFORE `git merge --squash` (and before `enterMergeDangerWindow`), its result
(`identityEnv`) is captured in an outer-scope variable and threaded forward to the commit call later in
the function. A probe failure now returns the SAME reason text as before (`identity-fallback probe:
${canonicalFailureMessage(...)}`) with no `resetOrSkip` call at all — there is nothing staged yet to
clean up, so "refused, nothing changed" (the pinMismatch kind's own wording) is now literally true. If
the trust condition flips AFTER the probe succeeds but before/during the squash, the squash's own trust
check (the `squashRefusalDetail` branch, pre-existing) refuses cleanly in exactly the same "nothing was
squashed" shape.

`c862f14c`'s load-bearing adjacency rule (no git call between the pathset capture and the commit) is
unaffected — the probe sits well before that capture now, not between it and the commit.

Verdict-cache note (unchanged from round 1, still read not changed by either round): this refusal sets no
distinguishing field, so it falls through `confirmWorkerMergeTracked`'s classification chain
(`sessions/service.ts`) to the generic fallthrough, which wraps it via `squashRefusedResult`
(`squashRefused:true`) — already in `NEVER_CACHED_OUTCOMES` (`orchestration/pending-ops.ts`). A
re-confirm already retries for real.

## Round 3 (current): a small pre-merge cleanup round

A focused re-review of round 2 (commit 27725ba5) found one dead-but-risky guard and two restored
anchors:

- The round-2 code still declared `identityEnv: Record<string, string> | undefined` and kept a runtime
  `if (identityEnv === undefined) return {ok:false, reason: ...}` guard right before the commit call —
  AFTER the squash had already staged the index, with no `resetOrSkip`. Dead in practice (every path
  that reaches it already assigned `identityEnv`), but its SHAPE is exactly the post-stage-residue
  pattern `8336b903`'s Do-not forbids, and a future edit that made it reachable would reintroduce this
  card's own bug. Fixed by dropping `| undefined` from the type — TypeScript's definite-assignment
  analysis (confirmed by `tsc`) now makes "assigned on every path that reaches here" a compile-time
  guarantee, with no runtime guard to go stale.
- Moving the probe earlier dropped two decision anchors that belonged to the `resolveGitIdentityFallbackArgs`
  CALL ARGUMENTS themselves (not to its old post-stage position) — `2267e8fa` (per-role env overrides) and
  `3a5c5d4a` (thread the resolved TOPLEVEL as `trustedMainRoot`, never bare `repoPath` — a real past
  regression). Restored beside the new `f4da727f round 2` anchor at the probe's new call site.

## Do not

- Do not reintroduce a post-stage `resetOrSkip` call for this site — the probe must stay BEFORE the
  squash. A post-stage cleanup for THIS specific refusal is provably insufficient: the production failure
  mode (a commondir-trust refusal) and the cleanup's own `reset --hard` share the identical trust check,
  so a persisting condition defeats the cleanup too.
- Do not add a `git config` write, or any other call that could change what `git var` reports, anywhere
  between the (now early) probe call and the commit call that consumes its result — the whole point of
  hoisting `identityEnv` is that it stays valid unchanged across that gap. That gap now includes `git
  merge --squash` itself, whose post-merge hook (or a smudge filter) COULD write repo-local `user.*`
  config — a trusted-hook residual, attribution only, same deliberately-unhardened posture `356538ef`
  already takes toward every other worker-writable hook on the shared canonical `.git`; not a new gap
  this card introduces or closes.
- Do not treat the generic fallthrough's "squash was attempted but never committed... Re-task a rebase"
  wording (`sessions/service.ts`, confirmWorkerMergeTracked) as fixed by this card for a flagless trust
  refusal at this site, or for the OTHER excluded post-stage site below — that wording is now actively
  wrong for a refusal that happens BEFORE any squash is attempted. Tracked as a separate follow-up (F1/F2);
  not fixed here.
- Do not apply resetOrSkip (or any reset) to the OTHER post-stage site in `mergeBranchLocked` that also
  skips cleanup without a documented quarantine reason — the branch where, after a failed `git commit`,
  HEAD is observed to have moved to a sha that `verifyLandedAsOwnCommit` could NOT verify as this
  attempt's own commit (parent/tree mismatch, or a forged trailer). That sha may be a genuinely foreign
  write that slipped past the per-repo merge mutex; `resetOrSkip`'s `git reset --hard HEAD` there would
  reset against that UNVERIFIED HEAD, and if it really is someone else's uncommitted work landed in the
  interim, a hard reset could destroy it. This is exactly what that branch's own "canonical repo needs
  manual inspection" wording already protects — leave it as-is. (Owner/manager ruling, 2026-10-27, on card
  f4da727f.)

## Residual, flagged but not fixed here

The excluded "HEAD moved to an unverified sha" branch raises NO quarantine (`enterMergeQuarantine` is not
called) and files no dedicated human-facing alert (no `mainline_moved_outside_loom`-style event) — its
only downstream signal is the generic `[loom:merge-rejected]` push to the owning MANAGER session via the
same `squashRefusedResult` fallthrough every ordinary squash failure uses, with no framing that a
concurrent/foreign write may be involved. Whether that is enough signal, or whether this branch deserves
its own quarantine/alert treatment, is a separate decision for whoever picks this up next.

The generic fallthrough's false "canonical repo untouched... Re-task a rebase" wording for a flagless
trust refusal (this site, post round-2) and for the excluded unverified-HEAD site above is tracked
separately (F1/F2) — not addressed by this card.
