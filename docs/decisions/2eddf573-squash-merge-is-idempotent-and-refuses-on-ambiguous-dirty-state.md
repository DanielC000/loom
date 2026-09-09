# 2eddf573 — `mergeBranchLocked`: idempotent squash merge, distinguishing already-landed from real no-op

## Narrative

`mergeBranchLocked` merges a worker's branch into the repo's current branch as a SINGLE SQUASH COMMIT — `git merge --squash` stages the combined diff WITHOUT committing, then a plain `git commit` lands it as ONE commit, so each task = one clean commit on main. Returns the new squash commit's SHA plus the exact `subject` it was committed with. FAIL-CLOSED. The commit message is a clean subject (task title, falling back to the branch name) plus a deterministic `Loom-Worker-Branch: <branch>` trailer — the SAME marker `findLandedSquashCommit` keys on to reconstruct a squashed merge whose branch is NOT in main's ancestry. Identity is a PLAIN `git commit` — no `-c user.*` overrides, no Co-Authored-By.

CONFLICT handling differs from `--no-ff`: `--squash` leaves NO `MERGE_HEAD`, so `merge --abort` won't work, and simple-git's `raw()` doesn't reliably reject on a conflict — detected EXPLICITLY via unmerged index entries, cleaned up with `git reset --hard HEAD`. A failed cleanup reset is SURFACED in `reason`, never swallowed.

## Idempotent, and distinguishing already-landed from a real no-op

The staged set is RE-DERIVED at merge time from a clean index — never trusted from a review-time snapshot. Stale in-progress-merge residue used to make the FIRST `--squash` abort and stage NOTHING, so the old code returned "nothing staged" on a valid branch and only a byte-identical RETRY merged. Any affirmative residue is now CLEARED up front. When the index is GENUINELY empty after a clean squash, `emptyKind` distinguishes why: `"ALREADY_MERGED"` (a prior squash's trailer is reachable from HEAD) vs `"STAGE_EMPTY_RETRY"` (no diff to merge at all).

## Refuses on ANY dirty tracked state at entry (card `9e77050f`)

Even after the MERGE_HEAD/unmerged clear, that clear only sees an AFFIRMATIVE in-progress real-merge signal — a `--squash` that staged a diff and died before its commit step (a daemon restart mid-merge) sets neither `MERGE_HEAD` nor an unmerged entry, surviving that clear invisibly, and disjoint-path content from an unrelated LATER squash can land on top of it silently under that branch's own subject/trailer. Whatever is dirty at entry is indistinguishable from a human's own uncommitted work in this self-hosting checkout — `reset --hard` cannot tell the two apart, and guessing wrong destroys real work. So this refuses loudly instead: `ok:false`, safe and idempotently retryable, never a silent absorption of someone else's content.

## The residue clear itself: `--merge`, not `--hard` (card `c78cbf5f`)

An affirmative MERGE_HEAD/unmerged signal licenses clearing THAT merge state only, not unrelated unstaged work elsewhere in the tree. `git reset --merge <commit>` is the mechanism `git merge --abort` uses, generalized to run whether or not MERGE_HEAD is set (`--squash` never sets it, so the bare-unmerged case needs the same clear, and plain `merge --abort` can't do that). Verified empirically: resetting to CURRENT HEAD makes every unmerged/conflicted path resettable, while an unstaged edit outside the conflict is never part of that delta and is left untouched — where `--hard` would discard it regardless. The two probes (`ls-files --unmerged`, `rev-parse MERGE_HEAD`) are INDEPENDENT, each in its own try/catch.

## Staged residue is a SECOND, non-concurrent trigger for the same corruption (card `9e77050f`)

The in-process mutex closes the CONCURRENT version of this hazard; this residue OUTLIVES the process. A `--squash` that stages a diff and never reaches its commit step (the daemon dying between them) leaves the canonical index dirty WITHOUT MERGE_HEAD and WITHOUT an unmerged entry — invisible to the clear above. Whatever is STAGED is therefore either that dead squash's own leftover, or a human's own staged WIP in this SAME checkout (this repo self-hosts from it — no worktree isolation). Git state alone can't distinguish the two, so ANY staged tracked state REFUSES LOUDLY: `ok:false`, safe and idempotently retryable.

⚠️ Deliberately SCOPED TO THE INDEX (card `06b5c47f`, correcting an earlier draft that refused on ANY dirty state, staged OR unstaged): only staged content produces this corruption — `--squash` commits the INDEX, so unstaged edits are never committed by it. The earlier broad check refused 4-for-4 on real repos whose only dirt was UNSTAGED (ordinary WIP, or a submodule gitlink ahead of its recorded pointer — normal, not residue), which could block a legitimately-configured repo's merges PERMANENTLY. That narrowing does NOT license the `reset --hard` calls further down — those get their OWN guard, `hadUnstagedDirtAtEntry`.

## Do not

- Do not trust a staged-set snapshot taken at review time — always re-derive at merge time from a clean index.
- Do not treat "nothing staged" as an ambiguous no-op — resolve `emptyKind` to distinguish `ALREADY_MERGED` from `STAGE_EMPTY_RETRY`.
- Do not attempt `reset --hard` on dirty tracked state found at entry — it cannot distinguish stranded merge residue from a human's real uncommitted work in this self-hosting checkout; refuse instead.
- Do not swallow a failed cleanup reset — surface it in `reason`.

## Consequences

A retry of a stranded squash-merge attempt now lands correctly on its first real call instead of requiring a byte-identical retry, and a genuinely ambiguous dirty-state case refuses loudly (safe, retryable) rather than risking silent data loss or misattributed content.

## Source

Inline comment in `packages/daemon/src/git/worktrees.ts`, `mergeBranchLocked`'s own doc comment (preceding `MergeEmptyKind`), as of this worktree's HEAD before this extraction. Wrapped source lines joined into a flowing paragraph, `*` comment markers stripped, no wording changed.
