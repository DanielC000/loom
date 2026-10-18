# c30952c1 — a missing worktree + an unconfirmed already-landed lookup refuses cleanly instead of crashing uncaught

## Narrative

`findLandedSquashCommit` fails SAFE to `null` on ANY error, including a timeout (its own catch-all —
`git/worktrees.ts`'s `@decision 6ee48e4d`). A `null` here is structurally indistinguishable from
"genuinely not landed" — the caller cannot tell the two apart.

That ambiguity is harmless when the worker's worktree directory still exists: `mergeBranchLocked`'s own
squash against the canonical checkout correctly stages nothing for already-landed content and reports
`STAGE_EMPTY_RETRY` (confirmed empirically — see the investigation below, scenario E). It is NOT harmless
when the worktree is ALSO gone: `confirmWorkerMerge`'s `if (gate)` block falls through `preLanded` being
null into `mergeMainIntoWorktree(repoPath, worktreePath, ...)`, whose very first line
(`makeGit(worktreePath, timeoutMs)` → `canonicalGit` → simple-git's constructor) throws a synchronous,
uncaught `GitConstructError: Cannot use simple-git on a directory that does not exist` — before any
try/catch in that function, before any mutation.

**Why this reaches the operator almost bare of context.** `confirmWorkerMergeTracked`'s own
catch-recovery wrapper (service.ts, around `confirmGatedIdentity`) re-runs `findLandedSquashCommit` once
more before giving up — but it is the SAME repo state, so it ALSO returns `null` and rethrows unchanged.
`PendingOpRegistry.attach()` catches that rethrow and settles the op `ok:false`. Because the crash is
synchronous with no I/O before it, the op settles well inside `syncAttachBudgetMs` — it never "surfaces
pending" — so the richer async settle-nudge text (`[loom:merge-unknown] ... this is NOT a confirmed
failure — do not re-dispatch or re-merge without checking first`) never fires; that text only fires via
`onSettledAfterPending`, gated on `fresh.surfacedPending`. The `worker_merge_confirm` MCP tool's
synchronous return for a fast `ok:false` settle is just `{error: r.error.message}` — here, literally
`{"error": "Cannot use simple-git on a directory that does not exist"}`, with zero orchestration events
recorded (the crash happens before any `evt("merge_landing_started"/"merge_rejected", ...)` call is
reached).

**Scope — verified empirically which paths are actually exposed.** A project with NO `gateCommand`
configured never enters the `if (gate)` block at all; its squash runs directly against the canonical
checkout (never the worktree), so a gone worktree is harmless there regardless of what the lookup
returns (scenarios A/B). A project WITH a `gateCommand` configured enters `if (gate)` — and therefore
risks this crash — whether or not THIS landing's gate is actually spawned: `gate` (the project having a
gateCommand) and `gateDisabled`/interval-skip (whether this confirm spawns it) are independent, so a
gate-off or gate-interval-skipped landing is exposed identically to a fully-gated one. The early
`!fs.existsSync(worktreePath) || taskAlreadyTerminal` short-circuit (`finishSoloAlreadyLanded`, card
864e79fe) already attempts the SAME lookup once before any of this — when that attempt also returns
null and falls through, this is the second, independent attempt at the lookup inside `if (gate)`
(`preLanded`); THIS card's fix retries once more, right where the worktree is actually needed, rather
than adding a third copy of the early check's own logic.

**The fix.** Checked fresh, immediately before `mergeMainIntoWorktree` — the first call on this path that
assumes the worktree exists — not from a value captured earlier (lesson: check existence at the point of
use). When `preLanded` is null and the worktree is missing, retry `findLandedSquashCommit` once (same
bounded `gitOpMs`, no extra timeout budget). If the retry finds the landing, `preLanded` is now set and
the EXISTING `if (preLanded)` branch below runs unchanged — no duplicated finalize logic. If it is still
null, refuse with a distinct reason (`worktree_gone_landing_unconfirmed`) naming plainly: the worktree is
gone; whether the branch landed could not be confirmed (not "timed out" — the code does not know that);
nothing was touched; re-confirm to retry (self-heals if the null was a transient glitch), or
recreate/re-task if the worktree is permanently gone. An orchestration `merge_rejected` event is recorded
(mirroring every sibling pre-squash refusal), closing the "zero events" gap the crash left. Because
`owedBase` (a HELD branch) already forces `preLanded` null unconditionally, a HELD branch with a gone
worktree takes the SAME refusal immediately on the first check (its own late-range landing needs the
worktree too, via `mergeMainIntoWorktree`'s `owedBase` branch, which crashes identically) — no special
case needed.

**Investigation (card c30952c1, hermetic seam tests, no claude, real git on temp repos) — findings that
shaped this fix:**
- Scenario E (worktree present, task forced terminal, lookup null): real gate ran, squash correctly
  staged nothing → `STAGE_EMPTY_RETRY`, zero data loss. Confirms the early short-circuit's "safe" framing
  — but only for the branch that is actually reached when the worktree exists.
- Scenarios C/D (worktree removed from disk, gate configured, lookup null — whether because the content
  was genuinely never landed, or landed out-of-band with no `Loom-Worker-Branch` trailer so the lookup
  can never find it): identical `GitConstructError` crash, confirming the failure is general to "worktree
  gone + lookup null", not specific to one cause of the null.
- Scenarios A/B (worktree removed, NO gate configured): no crash either way — the squash runs against the
  canonical checkout only.

Test: `packages/daemon/test/worktree-gone-landing-unconfirmed.mjs` turns scenarios C/D into the
regression guard for the refusal (named reason, unchanged main/branch/column, a recorded event, never
cached — a second confirm re-runs for real) and scenario E into the regression guard for the unaffected
worktree-present path.

## Code Review round 2 — a MAJOR and a MINOR the first pass missed

**MAJOR.** The retry above can make `preLanded` end up truthy with the worktree STILL gone (first lookup
succeeds, or the retry does) — and the EXISTING `if (preLanded)` finalize shortcut this record's own
"Do not" #5 pointed at was itself broken for that case: it gated on
`computeWorktreeGateStamp(worktreePath).head !== null`, which is ALWAYS `null` for a missing directory,
so it fell through into the ordinary gate path and mislabelled the result as `gate_worktree_dirty`
("uncommitted changes") about a worktree that has none — leaving the task stuck `in_progress`. Fixed by
skipping the stamp entirely when the worktree is missing and finishing directly (no stamp needed — the
same shortcut the early `!fs.existsSync` check already uses). Pinned by scenarios F (first-lookup-success)
and G (retry-success) in the test file, via a new, narrowly-scoped test seam
(`preLandedLookupGitFactory`) threaded ONLY into the `if (gate)` block's own two `findLandedSquashCommit`
calls.

**MINOR 1.** `mergeMainIntoWorktree` is ALSO called for admission-time re-union — after a gate-queue wait
of possibly minutes — and used to construct its worktree git handle OUTSIDE any try, so a worktree that
vanished DURING that wait threw the same uncaught `GitConstructError` there too. Fixed: that construction
now lives inside `mergeMainIntoWorktree`'s own try, returning `{ok:false, worktreeMissing:true, reason}`
instead of throwing; the admission-time caller maps it to a distinct, never-cached reason
(`worktree_missing_at_admission` / `worktreeMissingAtAdmission`) — NEVER the landing-lookup reason above,
since this path never touches landedness at all (it fires on the ordinary, non-preLanded union-merge
producer). Pinned by scenario H, seam-driven via the EXISTING `unionMergeGitFactory` test seam.

## Do not

- Do not treat a `null` already-landed lookup as proof the branch is unlanded when the worktree is also
  gone — refuse; never finalize as landed on an unverified lookup, and never let the fall-through reach a
  worktree-assuming git call either — including the `if (preLanded)` finalize shortcut's OWN stamp read
  when `preLanded` ends up truthy: a missing worktree needs no stamp, not a stamp that reads "dirty".
- Do not assume `mergeMainIntoWorktree`'s worktree-gone protection covers every caller just because it's
  shared — every caller must ALSO map the `worktreeMissing` result to its own sensible, never-cached
  reason (the landing-lookup reason above fits the pre-gate/preLanded producers only; the admission-time
  re-union producer, which never touches landedness, gets its own distinct reason instead).
- Do not add a new timeout budget for the retry — it reuses the SAME `gitOpMs` the first attempt used; a
  genuinely wedged git process gets no larger a window just because this is attempt 2.
- Do not word the refusal as "timed out" — the code does not know that the lookup actually timed out
  (it could have been a real, unresolvable git error); say only that the lookup found no landing.
- Do not cache this outcome (`NEVER_CACHED_OUTCOMES`, classified `"worktree-gone-landing-unconfirmed"`) —
  a transient cause clearing between confirms must let a re-call genuinely re-run, exactly like
  `stale-base`/`worktree-dirty`.
- Do not duplicate `finishSoloAlreadyLanded`'s finalize sequence for the case where the retry succeeds —
  let the existing `if (preLanded)` branch below handle it; this fix only decides whether `preLanded` gets
  a second chance to be set. (Code Review round 2: this is still correct, but it is NOT by itself
  sufficient — see the MAJOR finding above; the branch it hands off to had its own bug.)
