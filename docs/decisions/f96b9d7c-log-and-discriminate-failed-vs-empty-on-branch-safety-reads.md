# f96b9d7c — Log the real cause on a failed safety read, and discriminate "failed" from "genuinely empty"

## Narrative

Two read paths that gate destructive branch cleanup — `resolveMainlineBranch`'s origin/HEAD read and `listMergedLoomBranches`'s bulk `--merged` sweep — used to catch their error SILENTLY and just return `null` / `{branches: []}`. That made a repo with genuinely NO resolvable mainline (the expected, permanent case for a `git init`-only repo with no remote) indistinguishable from a TRANSIENT read failure (a timeout under boot-time load, a real git error): both produced the same empty-looking result with zero log output.

The fix is two-part. First, log the real cause at the point of catch (repoPath + the underlying error message) before failing safe — the caller's behavior is unchanged (both cases still skip the repo / delete nothing), but the reason is now visible instead of silently swallowed. Second, `listMergedLoomBranches`'s return carries a `failed` discriminator, so a caller can tell "the read genuinely found 0 merged branches" (`failed:false, branches:[]`) apart from "the read errored/timed out, so we don't actually know" (`failed:true, branches:[]`). `failed` does not change the safety contract — both fail safe to an empty branches array, so nothing is ever deleted on uncertainty — it only restores visibility into which of the two previously-identical-looking cases actually happened.

## Round 2 — a start-of-pass log line, for a fourth silent-failure shape neither counter above covers

A manager sampling the log a couple of minutes into boot — before boot-reconcile's Pass C (which runs after Passes A/B walk every session) had even started — saw no reclaim/no-origin/skip line and concluded the sweep had silently done nothing. That is a FOURTH silent-failure shape none of the round-1 counters above cover: "hasn't run yet" was indistinguishable from "ran and found nothing" and from "ran and failed." A start-of-pass log line now fires the moment Pass C begins, so its absence unambiguously means "still waiting on Passes A/B," never "the sweep is broken."

## Do not

- Do not restore the old silent catch — a transient read failure must log its cause, not disappear into an empty result indistinguishable from the permanent no-mainline case.
- Do not read `failed:true` as license to change the safe-empty behavior — it is purely a visibility signal for whoever's debugging "why didn't my branches get cleaned up," not a new decision point.
- Do not treat the round-1 `failed` discriminator as covering the "hasn't run yet" case — that gap needed its own start-of-pass log line, not a reading of `failed`.

## Consequences

A repo whose branch-safety reads are failing (timeout, git error) now shows up in the logs distinctly from a repo that legitimately has nothing to reclaim — closing a real debugging gap without changing what either case does. A manager sampling the log mid-boot can now also tell "Pass C hasn't started yet" apart from "Pass C ran and found nothing to reclaim."

## Source

Inline comments in `packages/daemon/src/git/worktrees.ts`: `resolveMainlineBranch`'s catch block (~line 1230) and `listMergedLoomBranches`'s own doc comment (~line 1248), as of this worktree's HEAD before this extraction. Wrapped source lines joined into a flowing paragraph, `*` comment markers stripped, no wording changed.

Round 2 also cited in `packages/daemon/src/sessions/service.ts`, boot-reconcile Pass C's own comment (~line 17157), as of this worktree's HEAD before this extraction (tranche 64); wrapped source lines joined into a flowing paragraph, comment markers stripped, no wording changed.
