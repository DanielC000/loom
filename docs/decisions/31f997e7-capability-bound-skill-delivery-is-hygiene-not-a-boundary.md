# 31f997e7 — capability-bound skill delivery is hygiene, not a security boundary

Card `31f997e7` adds a generic mechanism to `skills/inject.ts`: a bundled skill can be declared bound to
a capability slug (`CAPABILITY_BOUND_SKILLS`, a static map keyed by skill name), and is withheld from the
deliver-all default unless (a) the session's `cwd` is worktree-isolated (`isWorktreeCwd`) AND (b) the
session's resolved capabilities (`resolveProfileCapabilities`) include that slug. An explicit profile
`skills` subset still bypasses BOTH checks entirely, by design — see `509176c8`'s own record for why an
explicit subset is already a deliberate, human-attributable grant that isn't narrowed by any
ambient-default filter.

## CORRECTED (Code Review round 1, reviewer fa43d8a6): the shared-cwd residual was PERMANENT, not concurrent

The original version of this card gated purely on the capability grant, with no cwd check, and this
record originally described the resulting shared-cwd visibility as a benign, accepted residual. The
reviewer reproduced a permanent-orphan sequence that made that framing wrong:

1. Granted manager A injects `bound` into a shared cwd (`project.repoPath`) and claims it in the shared
   manifest.
2. A dies. Ungranted session B spawns at the same cwd; `injectSkills`'s `isSessionLive`-driven prune
   (card `9d73e537`) correctly drops A's now-dead manifest key. `bound` now sits on disk UNCLAIMED by
   anyone (`{"B":[]}`), and the "repo's own" skip (`exists && !myPrev.includes(name) &&
   !otherClaimed.has(name)`) reads it exactly like a pre-existing project-local skill nobody manages —
   because nothing in the manifest claims it anymore.
3. A resumes, still granted. Its own `myPrev` is empty (it's a fresh manifest entry for this generation)
   and `otherClaimed` doesn't have `bound` either — so the SAME "repo's own" skip fires for A too, and
   the stale copy is never re-claimed, never re-copied, never pruned, by ANY future session at that cwd,
   granted or not. The orphan is permanent.

This is reachable the moment `CAPABILITY_BOUND_SKILLS` is non-empty — before this card, deliver-all meant
every shared-cwd session claimed every skill every time, so no skill could ever go unclaimed this way.

## THE ROUND-1 FIX: worktree isolation, not grant alone

`passesCapabilityGate` (`inject.ts`) now additionally requires `isWorktreeCwd(cwd)` — cwd must be nested
under `WORKTREES_DIR`. Per that function's own doc: every worker (tasked or taskless) spawns/resumes/
forks/recycles with `cwd: worktreePath`, always under `WORKTREES_DIR`; every other role shares
`project.repoPath` as cwd, except "run" (a disposable snapshot, moot — a run session's `capabilities` is
hardcoded `[]`). A bound skill is now delivered only into a cwd no OTHER LIVE session can ever share, so
the permanent-orphan sequence above cannot start: step 1 never happens for a shared-cwd role, whatever
its grant.

Pinned in `skills-capability-bound.mjs`: a granted shared-cwd session does not receive a bound skill; a
granted worker in its own worktree does; the reviewer's (a)-(c) sequence is reproduced directly and shown
to never place the skill on disk at any step.

## CORRECTED AGAIN (Code Review round 2, reviewer 3e7c525e): isolation alone still orphans via WORKTREE REUSE

Round 1's framing — "exactly one session can ever own the copy" — was itself wrong. A worktree is not
single-use: `createWorktree` (`git/worktrees.ts`) reuses a RETAINED worktree (after `worker_stop` or a
rejected merge) when the SAME task is re-dispatched, possibly to a DIFFERENT agent with different grants.
`git reset --hard` never removes untracked `.claude/skills`. The reviewer reproduced this with real
`dist` (repro script referenced in the card discussion):

1. Granted worker A injects `bound` on worktree W.
2. A is stopped (W retained). The task is re-dispatched to ungranted worker B on the SAME worktree path
   W. B's own `injectSkills` call prunes A's now-dead manifest key (card `9d73e537`'s mechanism) — `bound`
   sits on disk unclaimed, the manifest reads `{"B":[]}`, and the "repo's own" skip treats it exactly like
   an unmanaged pre-existing dir from here on.
3. B resumes, still ungranted: never pruned, never re-claimed. The orphan is permanent, same shape as
   round 1's finding, just via REUSE of one cwd across sessions instead of concurrent sharing of one.

Fork and recycle were already fine: both reuse a worktree but carry their OWN resolved capabilities
forward (`sessions/service.ts`'s `capabilities: old.capabilities ?? []`), so they never hit this.

## THE ROUND-2 FIX: clean up a dead session's claims in an isolated cwd

When `injectSkills` prunes a dead session's manifest key (the `isSessionLive` mechanism, card `9d73e537`)
AND `cwd` is an isolated worktree, it now also removes that dead session's manifest-claimed dirs that no
LIVE session still claims. Scope, deliberately:

- Applies to ALL skills in that dead session's claim, not just capability-bound ones — a dead session's
  manifest entry is the only record of what IT placed there, bound or not.
- Never touches a dir NOT recorded in the dead session's own manifest entry — a user/repo dir is never in
  any session's manifest (see the "repo's own" skip), so it is never even a CANDIDATE for this cleanup.
  (Round 3, below, adds a SECOND, independent protection for a dir that WAS genuinely claimed.)
- Never applied to a shared cwd — that is card `f4e93dbf`'s harder, data-loss-sensitive scope. (A fork
  shares an isolated cwd with its still-live source, so "isolated" never meant "at most one live session
  — ever"; the SAME `otherClaimed` check that already protects a shared cwd's concurrent sessions
  protects a second live session at an isolated cwd too.)
- Reuses the SAME symlink-escape guard (the function's own early refusal) and the SAME direct-child-only
  `rmSync` discipline the existing stale-prune loop already applies — no new unguarded delete path.

Pinned in `skills-capability-bound.mjs`: the reviewer's exact A→stop→B(different grants, same worktree
path)→B-resume sequence now never places `bound` on disk after step 2; a SUBSEQUENT granted re-dispatch
to the same worktree still receives it, freshly copied; a user/repo dir in the same worktree survives the
whole sequence untouched; and the cleanup is shown firing for an ordinary, never-bound skill too (not
gated on `capabilityBindings` at all).

## CORRECTED AGAIN (Code Review round 3, reviewer 085065b7): "recorded as claimed" ≠ "still safe to delete"

The round-2 fix targeted the right bug, but being claimed is a fact about WHEN Loom placed a dir, not
about what's there NOW. The reviewer's probes (real `dist`, probe script referenced in the card
discussion) showed real destruction:

- (b) A worker hand-edits an injected `SKILL.md` and adds `notes.md` (both uncommitted). A dies; B
  arrives with a subset disjoint from the edited skill. The round-2 code deleted the WHOLE dir — edits
  included — because it was still recorded as A's claim and nothing else claimed it.
- (a2) A worker `git add -f`s an edit to an injected dir (or a merge/rebase brings in a tracked
  same-named skill). The SAME cleanup either deletes it or reverts the tracked content, with no git call
  anywhere in this sync path to notice.

The owner's standing rule is never to destroy a user's unfinished work; this cleanup path (new in round
2) was a genuine instance of exactly that, not a theoretical one.

## THE ROUND-3 FIX: a content fingerprint gates the delete, not the claim alone

1. `fingerprintSkillDir` records a sha256-based content fingerprint (over every file's path + bytes,
   sorted, recursively — never following a symlink/junction child) for every skill a session places,
   computed AFTER any Obsidian-fragment append — i.e. the FINAL bytes Loom actually left on disk.
2. Fingerprints live in a SEPARATE sidecar file, `.loom-skills-fingerprints.json` (`FINGERPRINTS_FILE`,
   `readFingerprintsFile`), never merged into the existing manifest's own on-disk shape — several other
   test files parse that file directly, and this keeps every one of them byte-for-byte unaffected. The
   sidecar needs no legacy-format handling at all (nothing pre-dates it): absent (an old worktree, or one
   this version hasn't written to yet) or corrupt both simply read as "no fingerprint for anything."
3. The round-2 cleanup now deletes a dead session's claimed dir ONLY when `fingerprintSkillDir(target)`
   at delete time matches ANY ONE of the fingerprints recorded by a dead claimant of that name (CR round
   4 — a `Map<string,string>` would have made the outcome depend on manifest key iteration order
   whenever two dead sids claimed the same name with different recorded fingerprints; a `Map<string,
   Set<string>>` of candidate fingerprints is order-independent, equally safe). Any REGULAR-FILE content
   change — a hand edit, an added file — fails that match and SKIPS the delete, logging it: an orphan is
   preferable to data loss. A claim with NO recorded fingerprint (a legacy pre-round-3 claim, or a
   fingerprint computation that itself failed at placement time) SKIPS too — "cannot verify" fails toward
   keeping, never toward deleting.
4. Scope, deliberately NARROW to the round-2 cleanup path only: the two PRE-EXISTING paths
   (copy-over-`myPrev`'s own re-copy, and the `myPrev` stale-prune loop below it) are UNCHANGED by this
   card. The same class of risk exists there too, for a SAME-SESSION resume overwriting its own earlier
   hand edit — a separate, already-filed card, not fixed here.
5. Named residual, honestly, NARROWED (CR round 4 nit — the original wording overclaimed "any
   divergence"): `fingerprintSkillDir` hashes only regular FILE bytes, recursively — it is BLIND to a
   symlink/junction CHILD added inside the dir (never followed, by design) and to an added EMPTY
   subdirectory, neither of which changes any file's content. A dir modified ONLY that way still matches
   its recorded fingerprint and is still deleted; the symlink's own target is never touched either way
   (`fs.rmSync` on a symlink removes the link itself, never follows it). Separately, a TRACKED dir whose
   content happens to be byte-identical to what Loom wrote can also still be deleted — the fingerprint
   matches, so nothing here distinguishes "Loom's own, untouched" from "tracked, but nobody has edited it
   since Loom placed it." Both show up as an unexpected (but git-recoverable, for the tracked case)
   deletion. There is no git call anywhere in this sync path (by design — this is filesystem bookkeeping,
   not a VCS integration), so neither case is, or can be, checked for before deleting.
6. CR round 4 MINOR: the dead-session scan now iterates the UNION of `claims`' and the fingerprints
   sidecar's own sids, not just `claims`' — a sid present only in the sidecar (its manifest key already
   gone some other way) is pruned from there too, instead of leaking in that file forever.

Pinned in `skills-capability-bound.mjs`: the reviewer's probe (b) (hand edit + extra file) survives
untouched; an untouched claim is still cleaned (round 2's own cases stay green); a legacy no-fingerprint
claim is kept; both orders of two dead sids claiming the same name with different fingerprints still
clean correctly (round 4's determinism fix).

## What remains (accurate as of round 4)

1. An EXPLICIT `skills` subset naming a bound skill still bypasses both the grant check and the isolation
   check (unchanged since round 1 — `509176c8`'s existing "an explicit subset is a deliberate,
   human-attributable grant" posture). If a human sets such a subset on a SHARED-cwd role's profile, the
   round-1 permanent-orphan shape can still occur there — the round-2/3/4 cleanup is isolated-cwd-only by
   design and never runs for a shared cwd regardless of subset use.
2. Card `f4e93dbf`'s own scope: the GENERAL dead-session-orphan problem for a SHARED cwd, for every skill
   (not just a capability-bound one). Tracked separately; this card's fixes deliberately do not reach
   into it.
3. The TWO narrowed residuals named above (point 5): a symlink/junction child or empty subdirectory
   added to a claimed dir doesn't change its fingerprint, so such a dir is still deleted; and a TRACKED
   dir whose content happens to be byte-identical to what Loom wrote can also still be deleted. Both
   accepted rather than fixed — closing either would mean adding real content-type/git awareness to a
   sync path that deliberately has neither.
4. The SAME-SESSION-resume class the round-3 fix deliberately did NOT touch (point 4 above) — tracked on
   its own, separately filed card.

There is no longer an isolated-cwd residual for a capability-bound skill from the claim-pruning mechanism
itself: the round-2/3 cleanup applies regardless of whether the current session uses a subset or the
deliver-all default, because it keys on the dead session's own manifest record, not on `want` — and it
now additionally requires the content fingerprint to match before it ever deletes anything.

## Do not

- Do not gate a capability-bound skill on the grant alone — isolation (`isWorktreeCwd`) is required too
  (round 1).
- Do not assume isolation alone is sufficient — a dead session's claim in an isolated, worktree-REUSED
  cwd must also be actively cleaned up, or the SAME permanent-orphan shape returns via reuse (round 2).
- Do not assume "recorded as claimed" is sufficient to delete — a claim is a fact about placement time,
  not about current content. Require a matching content fingerprint, and fail toward KEEPING (not
  deleting) whenever it's absent or doesn't match (round 3).
- Do not extend the round-2/3 cleanup to a shared cwd — that is card `f4e93dbf`'s harder, data-loss-sensitive
  scope, and a shared cwd's "whose dir is this" question is genuinely ambiguous in a way an isolated
  worktree's isn't.
- Do not let the cleanup remove anything not recorded in the DEAD session's own manifest entry, or whose
  current content fingerprint matches none of that claim's recorded fingerprints.
- Do not collapse two dead claimants' fingerprints for the same name into one last-writer-wins value —
  that makes the outcome depend on manifest key iteration order (round 4). Keep the SET.
- Do not touch the two PRE-EXISTING paths (copy-over-`myPrev`, the `myPrev` stale-prune loop) on this
  card — the same hand-edit-destruction class exists there too, for a same-session resume, but it's a
  separate, already-filed card.
- Do not treat a bound skill's presence on disk as proof a session without the grant can act on it. The
  capability's own MCP mount shares the SAME grant source (`resolveProfileCapabilities`) but additionally
  requires a valid catalog row (a missing or first-party-squatting slug is dropped there) — this skill
  gate keys on the raw slug alone. **The capability grant gating the MCP mount is the real gate.** A
  bound skill must never be the only thing standing between an agent and a capability.
- Do not widen the fix search to "stop sharing cwd" as a follow-on to this card — that's a much larger
  change to manager/platform/setup/auditor/plain session architecture, out of scope here.
- Do not fix card `9d73e537`'s or card `f4e93dbf`'s general dead-session-orphan problem for a SHARED cwd,
  or the round-3-named tracked-but-byte-identical / same-session-resume residuals, on this card — all are
  separate, broader findings tracked on their own cards.
