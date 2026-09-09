# 4b7ff996 — Admission-time preflight for a canonical-dirty-tracked-overlap squash that can never land

## Narrative

`detectCanonicalDirtyOverlap` is an ADMISSION-TIME PREFLIGHT: it catches, BEFORE the build/DoD gate ever runs (an ~8-17min cost observed live on this repo), a branch whose squash can structurally never land — because the CANONICAL repo already has unstaged tracked changes on a path the branch itself touches. `git merge --squash` refuses to overwrite unstaged local modifications (it errors instead of silently clobbering them) — `mergeBranchLocked` hits exactly this as a `rawError` deep inside the squash (see its own `dirtyOverlap` signature-detection), but only AFTER a full gate run has already paid for the worktree build/test cost. This preflight asks the SAME question cheaply, up front.

### CR correction: the naive check was too broad

CR correction, first-round review: "any unstaged status on a path in `merge-base..branch`" is BROADER than what `git merge --squash` actually refuses on (`ERROR_NOT_UPTODATE_FILE`, raised only for a path the squash must ACTUALLY WRITE whose worktree content differs from the index) — the naive path-set intersection produced THREE confirmed false refusals against real git 2.47:

1. **ALREADY-LANDED CONTENT** (the worst — card `46ebf16e`'s out-of-band-resolution shape: main independently already carries the branch's exact content, canonical is separately re-dirtied on the SAME path). `--squash` doesn't touch a path at all when applying the branch's diff would be a no-op against CURRENT `HEAD` (verified empirically: "Squash commit — not updating HEAD", 0 staged). Excluded by dropping any candidate whose content is IDENTICAL between CURRENT `HEAD` and the branch tip — deliberately `HEAD`, not `mergeBase`.
2. **UNSTAGED DELETE** (` D`). Not what `--squash` refuses on: git restores it from the index cleanly — reproduced. Excluded by restricting to worktree status `Y === "M"` (a real MODIFICATION), the only value `ERROR_NOT_UPTODATE_FILE` fires for.
3. **SUBMODULE GITLINK** (` M`, mode `160000`). See [[06b5c47f-resetorskip-skips-rather-than-mixed-resets-on-pre-existing-unstaged-dirt]] — a submodule ahead of its recorded pointer is NORMAL, not residue, and this preflight would have REINTRODUCED that regression. `--squash` does not error on it (proven standalone and for this overlap case). Excluded via `git ls-files --stage` mode check.

These three checks run ONLY over the small overlap-candidate set, never the whole repo.

### Scope and siblings

Only UNSTAGED TRACKED overlap is checked here — a STAGED-dirty canonical repo is checked by `detectCanonicalStagedDirt` (same admission preflight), and an UNTRACKED collision by `detectCanonicalUntrackedOverlap` (card `98d6264d`, its own record).

FAILS SAFE like `detectStrandedWork`: any error/timeout returns `{overlap:false, probeFailed:true}` — never blocks a legitimate merge. The `probeFailed` flag + log line make a PERMANENTLY broken probe observable rather than indistinguishable from "genuinely never has an overlap".

## The squash-time backstop, and its regex covering BOTH git wordings

`mergeBranchLocked` still catches the residual race window (the gate can run for minutes between this preflight and the squash, during which canonical can newly go dirty): a `rawError` matching `/would be overwritten by merge/i` is classified `dirtyOverlap:true` rather than a generic failure — the correct remedy is NOT a rebase. ONE regex matches BOTH git wordings ("Your local changes to..." unstaged TRACKED; "The following untracked..." UNTRACKED, deliberately not detected at admission) — the caller-facing wording is generic enough for either. `rawErrorMessage` (naming the specific path) is ALWAYS included even when a cleanup issue is also set — an earlier draft dropped it whenever cleanup was skipped.

## Do not

- Do not widen the check back to "any unstaged status on a path in `merge-base..branch`" — that reproduces the three confirmed false-refusal cases above (already-landed content, unstaged delete, submodule gitlink).
- Do not diff the already-landed-content narrowing against `mergeBase` — it must be `HEAD`, since the question is whether `HEAD` has since independently converged on the branch's content, not what the branch changed relative to its own fork point.
- Do not widen `--untracked-files=no` to catch the untracked case here — that's a separate false-refusal shape handled by the dedicated sibling, `detectCanonicalUntrackedOverlap`; see that function's own record for why it needed its own admission-time hoist.
- Do not let a probe failure block a legitimate merge — any error/timeout must fail safe to `{overlap:false, probeFailed:true}`.
- Do not choose between the two error messages based on `cleanupIssue`'s presence — always include `rawErrorMessage`, the only place the specific overwritten path(s) are named.

## Consequences

A branch whose squash can never land due to canonical-dirty-tracked overlap is now caught in a single cheap up-front probe instead of after paying the full ~8-17min build/DoD gate cost. The probe's own narrowing logic is more intricate than a naive path-set intersection, verified against three specific false-refusal repros on real git 2.47 — a future simplification must re-verify against all three before removing any of the narrowing steps.

## Source

Inline comment in `packages/daemon/src/git/worktrees.ts`, `detectCanonicalDirtyOverlap`'s own doc comment (~line 1533), as of this worktree's HEAD before this extraction. Wrapped source lines joined into a flowing paragraph, `*` comment markers stripped, no wording changed.
