# 98d6264d — Untracked-file collision is a separate admission-time preflight from the tracked case

## Narrative

`detectCanonicalUntrackedOverlap` is the sibling admission-time preflight to `detectCanonicalDirtyOverlap` (card `98d6264d`). That function's probe is `git status --porcelain --untracked-files=no`, DELIBERATELY blind to untracked paths (`--untracked-files=no` is load-bearing there against a DIFFERENT false refusal, so it cannot simply be widened). `git merge --squash` refuses on an untracked collision too, with a DIFFERENT git wording ("The following untracked working tree files would be overwritten by merge") — `mergeBranchLocked` already catches this late, via the SAME `/would be overwritten by merge/i` classifier that also matches the tracked wording, but only AFTER a full build/DoD gate has already run. This hoists the untracked case to admission time too, the identical "ask cheaply, up front" move `detectCanonicalDirtyOverlap` already makes for the tracked case.

### Card premise refuted by direct repro

Card `98d6264d`'s own DoD-3 claimed a "byte-identical untracked collision does not refuse" counter-case, mirroring `detectCanonicalDirtyOverlap`'s narrowing (i) for the TRACKED case — that claim is FALSE for the UNTRACKED case, verified directly against real git `2.47.0.windows.2`: `git merge --squash` refuses on an untracked path collision REGARDLESS of whether the on-disk content is byte-identical to what would be checked out — "error: The following untracked working tree files would be overwritten by merge" fires unconditionally on path presence (tested both with `core.autocrlf` true and explicitly false, ruling out a line-ending artifact). Unlike the tracked case, git does NOT special-case identical untracked content — the tracked narrowing (i) does not transfer here, and a content-identity check would have been WORSE than a no-op: it would have produced a FALSE NEGATIVE (excluding a path git actually refuses on), reintroducing the exact late-failure gap this card exists to close, just for the identical-content subcase. So NO content comparison is performed.

### The narrowing that DOES apply

Verified by a second, separate repro: a candidate the branch's OWN TIP no longer carries — added then removed within the branch's own history, or deleted relative to the merge base — is NOT a genuine collision: the squash writes NOTHING at that path in that case (confirmed: "Squash commit -- not updating HEAD / Automatic merge went well", 0 refusal), so an untracked file merely sitting at that path is never at risk. This mirrors `detectCanonicalDirtyOverlap`'s own reasoning for excluding a path the squash never actually writes to, just via an EXISTENCE check (`git cat-file -e branch:path`) rather than a content comparison, since existence — not content — is what determines whether git refuses here.

Only paths the branch's own commits actually touch (`mergeBase..branch`) are ever candidates — an untracked file elsewhere in the canonical repo is never at risk, matching the tracked-path sibling's own scoping.

FAILS SAFE like `detectCanonicalDirtyOverlap`: any git error or timeout returns `{overlap:false, probeFailed:true}` — a flaky probe must never itself block a legitimate merge; the branch simply proceeds to the real gate/squash, which still catches (and explains) the genuine case via the existing backstop if it's still there by then.

## Do not

- Do not apply the tracked case's identical-content narrowing here — verified false for untracked collisions on real git 2.47; it would produce a false negative and reintroduce the late-failure gap this card closes.
- Do not widen `detectCanonicalDirtyOverlap`'s own probe to cover this case instead of keeping a separate sibling — its `--untracked-files=no` is load-bearing there against a different false refusal.
- Do not let a probe failure block a legitimate merge — any error/timeout must fail safe to `{overlap:false, probeFailed:true}`.

## Consequences

An untracked-file collision that would make a squash refuse late (after the full build/DoD gate) is now caught up front, at the same cheap admission-time preflight point as the tracked-overlap case — at the cost of maintaining two structurally-different probes (existence-based here, content-based there) rather than one shared check.

## Source

Inline comment in `packages/daemon/src/git/worktrees.ts`, `detectCanonicalUntrackedOverlap`'s own doc comment (~line 1666), as of this worktree's HEAD before this extraction. Wrapped source lines joined into a flowing paragraph, `*` comment markers stripped, no wording changed.
