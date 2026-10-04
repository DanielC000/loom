# 8c3d6c04 — a transient union-merge failure must never be cached as a rejected verdict

Follow-up from 7e5b23e7 (kill-confirm `mergeMainIntoWorktree`'s two mutating merge calls — read that record
first). 7e5b23e7 fixed the UNDERLYING git operation to retry once on a confirmed-kill timeout, but a
timeout that still fails after that retry (or any other transient failure) returned the SAME generic
`{ok:false, reason}` shape as a real content conflict. `classifyOutcome`
(`sessions/service.ts`) had no branch for it, so it fell through to `outcome.value.merged ? "merged" :
"rejected"` — plain `"rejected"`, which is NOT in `NEVER_CACHED_OUTCOMES` (`orchestration/pending-ops.ts`)
and so WAS eligible for `retainVerdictUntilSuperseded` caching, gated only by `verdictIdentity` (a
PRE-forward snapshot of branch head + main tip, resolved BEFORE the union-merge itself runs — see
`currentidentity-is-a-pre-forward-snapshot` in project memory). A union-merge failure that does not move the
branch tip (the ordinary shape of a timeout/kill/spawn-error that did not land) leaves `verdictIdentity`
unchanged, so a re-confirm at the same identity would replay the stale rejection instead of genuinely
re-attempting the merge — even though the underlying host condition may have cleared by then.

Same shape at a second call site: admission-time re-union (`reunionAtAdmission`) throws
`AdmissionReunionFailedError`, whose non-conflict case already carried prose acknowledging it "may be a
transient git/filesystem issue" — but still returned the same generic, cacheable shape.

## The fix

`mergeMainIntoWorktree` (`git/worktrees.ts`) gains a `transient?: boolean` field on its failure return,
set from STRUCTURAL signals already computed inside the function — never by parsing the final
`ConfirmMergeResult.reason`/`detailText` strings at the service.ts layer:
- a confirmed-kill timeout (`TIMEOUT_SHAPED_RE` matching a non-refusal error, the SAME local the
  7e5b23e7 retry already keys on) → transient.
- a Node spawn-error `.code` of `EAGAIN`/`EMFILE`/`ENFILE`/`EBUSY` → transient. `ENOENT`/`EACCES`, and any
  OTHER/unknown code, stay DETERMINISTIC (fail closed toward caching) — a missing/unexecutable git binary
  does not heal on retry.
- a real content conflict (`conflict:true`) or a `CanonicalGitRefusal` → always DETERMINISTIC, never
  `transient` regardless of message text.
- the bare-`withTimeout` "failed to resolve main tip" read, and the owed-landing branch's own bare reads —
  nothing lands from any of them (no ref moves, no working-tree mutation; a `commit-tree` write there only
  creates a dangling, harmless object), so a timeout OR a transient spawn code there is always safe to mark
  transient too. Deliberately NOT kill-confirmed as part of this card — that is a separate gap (a bare
  `withTimeout` can still leak a hung child on this specific read path) better left to its own card.

`ConfirmMergeResult` gains `unionMergeTransient?: boolean`, threaded from `union.transient` /
`reunion.transient` at both call sites. `classifyOutcome` checks it before the generic
`merged`/`rejected` fallback, classifying `"union-merge-transient"` — added to `NEVER_CACHED_OUTCOMES`.
The `[loom:merge-rejected]` nudge text is upgraded from the old blanket hedge to a definite statement
("this looks like a transient git/host condition... a plain re-confirm will retry") whenever `transient`
is structurally known true; the hedge survives unchanged for the remaining, genuinely-unknown non-conflict
case.

A TEST SEAM (`unionMergeGitFactory`, same shape as `soloMergeGitFactory`/`heldProbeGitFactory`) lets a
hermetic test drive the REAL `confirmWorkerMergeTracked` through a fake union-merge failure.

## Round 2 (Code Review 47c5815f of 5045a6ed)

1. The three returns inside `isConfirmedKillTimeout && verifyUnionLanded()` mean the union ALREADY LANDED
   (HEAD moved onto main) — round 1 wrongly set `transient:true` there and the nudge claimed "nothing was
   changed", both false: the branch tip moved, so a re-confirm needs the NEW identity, not a blind retry.
   Fixed: `transient` dropped, wording changed to say the merge landed and point at re-confirming.
2. `residueNote` ("can leave staged, uncommitted merge content… inspect/reset before retrying") and the
   `transient` nudge's "nothing was changed" could both fire together, contradicting each other. Fixed: a
   new `residuePossible?: boolean` field (mirrors `residueNote` exactly) drives a DIFFERENT, honest nudge
   sentence when true, at both the pre-gate and admission-time call sites.
3. Added test coverage for the admission-time threading (`AdmissionReunionFailedError`'s `transient` arg →
   `rejectAdmissionReunionFailure` → `unionMergeTransient` + cause text) via the real "main advances during
   the queue wait" seam, and for the owed-landing branch's own two transient sites. Closed the e2e test's
   `Db` before exit.
4. A union-merge failure from a worktree ALREADY DIRTY before the attempt (ort's "Your local changes …
   would be overwritten") was also classified as plain "rejected" and cached — a human `reset --hard` or
   commit still replayed the stale refusal. Fixed: a NEW `dirtyWorktree?: boolean` field, set from
   `computeWorktreeGateStamp`'s existing, noise-filtered dirt check (never from the git error's stderr
   text) taken BEFORE the merge is attempted. At the service.ts layer this REUSES the existing
   `refuseWorktreeDirty` helper / `gateWorktreeDirty` outcome (`"worktree-dirty"`, already in
   `NEVER_CACHED_OUTCOMES`) rather than inventing a new classification string.

## Round 3 (delta Code Review of 21ee1ef7)

1. Round 2's `dirtyWorktree` check fired unconditionally on `preMergeDirty`, even for a CONFIRMED-KILL
   TIMEOUT — wording a dirty-but-interrupted merge as a plain "commit or discard" refusal is wrong: the
   interrupted attempt may have folded partial, uncommitted merge residue into that same dirt, and a plain
   commit would fold that residue into the branch too. Fixed: `dirtyWorktree` now requires
   `!isConfirmedKillTimeout`; a confirmed-kill timeout on a dirty tree falls through to the ordinary
   residue/transient handling (never `dirtyWorktree`, never "commit" wording) unchanged.
2. The owed-landing `--ff-only` path had no pre-attempt dirt check at all (round 2 only added one to the
   plain-union path). Fixed: a matching `computeWorktreeGateStamp` read before the owed `--ff-only` loop,
   with the SAME `!isConfirmedKillTimeout` gate — `dirtyWorktree:true` on a non-timeout failure against an
   already-dirty tree, unchanged (still transient, not dirty) on a confirmed-kill timeout.
3. A round-2 test comment wrongly claimed a real on-disk edit drove the dirt signal in a fake-gitFactory
   scenario — the fake's own hardcoded `status` response does, not disk state (the real edit was dead
   code). Fixed the comment and added genuinely REAL-git dirty-worktree cases (no factory override at all)
   for both the plain-union and owed-landing paths, proving an actual `ort` refusal classifies correctly
   end to end.

## Scope note: `merge_batch`

`git/batch-merge.ts` has no call to `mergeMainIntoWorktree` and no `union_merge_failed`/`union_conflict`
concept at all (verified: zero matches for either string in that file). A batch candidate the batch's own
dry-run `merge-tree` classification can't resolve cleanly falls back to the solo `confirmWorkerMergeTracked`
path (`sessions/service.ts`, `runFallback`), which this fix already covers. No parallel batch-path fix was
needed.

## Do not

- Do not classify a union-merge failure as transient by parsing `reason`/`detailText` message text at the
  `service.ts` layer — read the structural `transient` field `mergeMainIntoWorktree` already computed from
  its own local signals (confirmed-kill timeout, spawn-error `.code`).
- Do not add a spawn-error code to `TRANSIENT_SPAWN_ERROR_CODES` on a hunch — `ENOENT`/`EACCES` and any
  unlisted code must stay deterministic; the set fails closed toward caching by design.
- Do not set `transient` alongside `conflict` or `quarantined` — a real content conflict is deterministic
  no matter what the underlying git error text looks like, and a quarantine is its own, already-excluded
  classification.
- Do not add kill-confirmation to the "failed to resolve main tip" bare read as part of this card — that
  read's own hung-child-leak exposure is a separate gap for its own card.
- Do not restate the current member list or count of `NEVER_CACHED_OUTCOMES` in a brief or a comment
  elsewhere — read the array in `pending-ops.ts` directly; a copied list rots exactly like `CLAUDE.md`'s
  own "point at a source of truth" rule warns about.
- Do not set `transient:true` on a return inside the `verifyUnionLanded()` branch — the union landed, so
  that word is false there; never re-derive "did it land" from the reason text either, use the branch's own
  gating condition.
- Do not emit "nothing was changed" without checking `residuePossible` first — derive the sentence from it,
  never assume one wording fits every `transient` case.
- Do not invent a second, hand-rolled dirt check for `dirtyWorktree` — reuse `computeWorktreeGateStamp`
  (the same noise-filtered view `run_gate`'s own pre-spawn check uses), and reuse `refuseWorktreeDirty` /
  the `gateWorktreeDirty` outcome at the service.ts layer rather than a new classification string.
- Do not classify `dirtyWorktree` without also checking `!isConfirmedKillTimeout` — a confirmed-kill
  timeout on a dirty tree must fall through to the ordinary residue/transient handling; pre-existing dirt
  plus an interrupted merge is not the same failure as pre-existing dirt alone, and "commit" is the wrong
  advice when residue may need inspecting first.
- Do not add a dirt check to only one of the two merge producers (plain-union, owed-landing `--ff-only`) —
  both can fail on a pre-existing dirty tree and both need the same `computeWorktreeGateStamp` read and the
  same `!isConfirmedKillTimeout` gate.
