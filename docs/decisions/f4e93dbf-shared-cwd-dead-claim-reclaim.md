# f4e93dbf — re-claim an unclaimed store skill orphaned in a shared cwd

## The bug

A session injects Loom-managed skills into a SHARED cwd — `project.repoPath`, used by manager/platform/
setup/auditor/plain sessions (never a worker, which always gets its own isolated worktree). The session
dies. The next session to spawn/resume at that cwd prunes the dead session's manifest key (card
`9d73e537`'s `isSessionLive` mechanism) — but `injectSkills`'s existing dead-claim cleanup (card
`31f997e7` rounds 2-4) only ever ran for an ISOLATED worktree cwd. For a shared cwd, once the dead
session's claim was pruned, the now-unclaimed dir read exactly like a genuine, unmanaged repo-local skill
(the `exists && !myPrev.includes(name) && !otherClaimed.has(name)` skip in the `want` loop) and was never
refreshed again — not when the store itself moved on, not ever, for any future session at that cwd. The
`31f997e7` decision record named this as its own deferred scope (see its "Do not" list: "never extend the
round-2/3 cleanup to a shared cwd — that is card `f4e93dbf`'s harder, data-loss-sensitive scope").

Reproduced against current main (pre-fix sha `58e92e13`) with a scratch probe before any edit: dead
session places `loom-x` v1 into a shared cwd, dies, store moves to v2, a successor's `injectSkills` call
prunes the dead claim — and the on-disk copy stays v1 forever across every later call.

## Investigate-first checkpoint (before any edit)

Reported `blocked` with: the reproduction above; the reviewer's framing ("an unclaimed dir whose name is
in the store is Loom-owned, reclaim it") shown to be NECESSARY but NOT SUFFICIENT — a repo CAN commit its
own `.claude/skills/<name>` sharing a store skill's exact name (this repo's own convention of renaming
personal skills, e.g. `pickup` vs the bundled `loom-pickup`, exists specifically to avoid such a
collision, which only makes sense if the collision is otherwise possible); and the disjoint relationship
to card `6db94dfe` (same-session resume paths) and card `015fdb23`'s `claimedFingerprints` (the cwd-skill
permission scan's trust registry, downstream of and unaffected by this card).

## The fix shape (approved)

Widen the EXISTING, already-reviewed dead-claim fingerprint-verified cleanup (`31f997e7` round 3) to a
shared (non-worktree) cwd too — but never by deleting. The worktree path is UNCHANGED: it still
unconditionally `fs.rmSync`s a verified dead claim (safe there because the subsequent `want` loop, in the
SAME call, immediately re-copies it fresh — no second session can share that cwd).

For a shared cwd, bare name-matching is never trusted alone. A dead claimant's own recorded placement
fingerprint (`fingerprintSkillDir`, already shipped) must still match the dir's CURRENT on-disk content —
this is the SAME check `31f997e7` round 3 already uses, reused verbatim, never a second copy. This alone
rules out a hand-edited dir and a legacy claim with no recorded fingerprint (both fail toward "keep,
don't touch" — the same posture `31f997e7` round 3 and `6db94dfe`'s own DoD both already settled on).

## ASYNC COMPUTES THE FACT, SYNC ACTS ON IT

`injectSkills` runs synchronously on the spawn hot path (`createPty`, itself non-async, called from a
non-async `spawn()` — there is no `await` boundary anywhere in that chain) and must never run a git
subprocess itself. This was confirmed, not assumed: a second `blocked` checkpoint was filed specifically
to verify this before building the git-tracked guard the manager asked for, citing the three existing
precedents in this codebase that already settled "never block the hot spawn path" for an analogous
problem (worktree dep-provisioning, the shared Python venv, the cached claude-version probe) — all three
explicitly reject a synchronous/blocking call for exactly the reason a synchronous `git ls-files` here
would too: a daemon-wide event-loop freeze, however rarely it fires, is strictly worse than the staleness
bug being fixed.

The approved shape:

1. The SYNCHRONOUS dead-claim check verifies a dead claimant's recorded fingerprint still matches current
   content, and that no live session still claims the name (`otherClaimed`). If it passes, in a
   NON-worktree cwd the dir is **not touched this call**. Instead:
   - if `cwd` is clearly not a git repository at all (`anyGitDirUpTree` — a pure, cheap `fs.existsSync`
     ancestor walk, no subprocess, same cost class as `fingerprintSkillDir`'s own recursive file hashing
     already called synchronously here) — there is no tracked-file risk to check at all, so the name is
     reclaimed **immediately, synchronously, in the same call**;
   - otherwise, a bounded (10s), fire-and-forget, deduped-per-(cwd,name) async check is kicked via
     `canonicalGit(cwd, …).raw(["ls-files", "--", pathspec])` (`kickUntrackedCheck`). Any error, timeout,
     or non-empty output (something IS tracked) caches nothing — the fail-closed default a later call
     reads is always "do not reclaim."
2. The async result lives ONLY in an in-memory, bounded (`UNTRACKED_CACHE_MAX_ENTRIES`), short-TTL
   (`UNTRACKED_CACHE_TTL_MS`, 60s) cache (`verifiedUntrackedCache`) keyed on `${cwd}\u0000${name}`. It
   writes nothing to disk and touches no manifest.
3. The NEXT sync `injectSkills` call at that cwd (Pass 1, independent of that call's own `deadClaimed` —
   by the time the async check resolves, the dead session's manifest key is typically long gone, so
   `deadClaimed` can't rediscover the name a second time) consumes a ready cache entry: if the on-disk
   fingerprint STILL matches the recorded one (closing the race against an edit/commit landing between
   the check and this call) and no live session now claims it, the name is added to `reclaimableNow` and
   flows through the EXISTING `want`-loop `copySkillAtomic` path, exactly like any other normal
   refresh — never a separate delete. There is no delete-then-recopy window: `copySkillAtomic` already
   performs its own atomic tmp-copy + swap over an existing dest.
4. A mismatch at consume time (Pass 1) drops the cache entry silently — never deletes, never overwrites.
5. `__awaitPendingSkillTrackChecks()` is a narrowly-named, TEST-ONLY export to await in-flight checks
   deterministically; production never calls it (that would reintroduce the exact block this design
   avoids).

## Named residuals

- **Pre-fix orphans.** This fix only heals a dead claim whose owning session dies and gets pruned AFTER
  it ships — the dead claimant's fingerprint is only ever available in the SAME call that performs the
  prune (card `9d73e537`'s mechanism deletes the manifest key AND its fingerprints-sidecar entry
  together). A dir already orphaned, with no surviving fingerprint record, before this fix landed is not
  retroactively healed — it stays exactly as unmanaged as it is today.
- **The post-check commit window.** The re-verify at consume time (Pass 1) only re-checks the
  FINGERPRINT, never git-tracked status again — doing so would reintroduce the blocking call this whole
  design exists to avoid. Committing a file changes nothing about its bytes, so if a user commits the
  dir's EXACT already-placed content (untouched otherwise) in the window between the async check
  resolving "untracked" and a later call consuming the cache entry, the fingerprint still matches at
  consume time and the repair call will wrongly replace a now-tracked dir. This is a genuine, accepted
  residual — not eliminated, only bounded by the cache's TTL (60s): the narrower that window, the less
  often a commit can land inside it.

## Interaction with card `6db94dfe`

No contradiction — disjoint name-sets by construction. `6db94dfe`'s scope is the SAME-SESSION resume
paths (`copySkillAtomic` overwriting the CURRENT session's own `myPrev`, and the `myPrev`-vs-`want` stale
prune loop) — protecting a session's own earlier placement on ITS OWN resume. This card's fix only ever
acts on `deadClaimed` (names claimed by an OTHER session the live-predicate says is dead); a dead
session's sid is, by construction, never the current `sessionId`, so a name can never be in both
`myPrev` and `deadClaimed` in the same call. `6db94dfe`'s own body asks for "ONE shared helper used by
all three Loom write/delete paths" — this card's fix reuses the IDENTICAL fingerprint-compare already
coded in the (now-widened) dead-claim loop rather than inventing a second copy, so it folds cleanly into
that future shared helper instead of diverging from it.

## Interaction with card `015fdb23`'s `claimedFingerprints`

Downstream and unaffected. A name this fix successfully reclaims flows through the EXISTING
`copySkillAtomic` → `recordLoomPlacedFingerprint` path, so it is correctly registered in the daemon-side
`loomPlacedFingerprintsByCwd` registry and included in `claimedFingerprints` for that call exactly as any
fresh placement would be — the cwd-skill permission scan (`015fdb23`) sees it as Loom's own, freshly
verified, with no special-casing needed.

## Do not

- Do not trust bare name-matching ("the name is in the store") as sufficient to reclaim an unclaimed dir
  in a shared cwd — a repo can commit its own dir under the exact same name; the content fingerprint
  against the dead claimant's own recorded placement is the required disambiguator.
- Do not run `canonicalGit` (or any git call) synchronously inside `injectSkills` or anywhere in its
  call chain up through `createPty`/`spawn` — there is no await boundary there, and a blocking git call
  would freeze the whole daemon's event loop, however rarely the reclaim branch fires.
- Do not delete a verified-reclaimable shared-cwd orphan as a SEPARATE step before copying the
  replacement — reuse `copySkillAtomic` (via `reclaimableNow`) so the new copy is always FULLY BUILT
  before the old one is removed. `copySkillAtomic` is NOT a single atomic replace with no delete step —
  it rm's `dest` then renames a tmp dir into place, with a real (if brief) window where `dest` is simply
  missing; see round 2's "Do not" item below for the full correction.
- Do not re-run the git-tracked check at consume time (Pass 1) — only the fingerprint is re-verified
  there; re-checking git-tracked status would reintroduce the exact blocking call this design avoids. The
  post-check commit window is an accepted, TTL-bounded residual, not a bug to close here.
- Do not extend this card's reclaim to the worktree-cwd path, or change its existing unconditional-delete
  behavior — that path is single-session-exclusive (a fork's `otherClaimed` check already protects a live
  sibling) and stays exactly as `31f997e7` shipped it.
- Do not hardcode a `.claude/skills` literal anywhere in `inject.ts` outside `claudeSkillsDir` (the one
  adapter-owned source of that path, in `pty/claude-doctrine.ts`) — `harness-adapter-claude-literal-guard.mjs`
  enforces this; derive any relative pathspec from `claudeSkillsDir(cwd)` instead.

## Round 2 (Code Review of round 1 — ANOTHER-ROUND, not REJECTED)

Round 1 (above) shipped a real mechanism, but the reviewer found it INERT in practice rather than a
data-loss bug: the only thing that ever remembered an orphan was the in-memory, 60s-TTL
`verifiedUntrackedCache` — and that cache is only ever CONSUMED by a later `injectSkills` call at the
SAME cwd. Shared-cwd sessions (manager/platform/setup/auditor/plain) spawn/resume minutes to hours apart,
not seconds, so in practice no call ever lands inside the 60s window and the discovered orphan is silently
dropped on the floor the moment the cache entry expires — forever, since `deadClaimed` cannot rediscover
the same name a second time (the dead session's manifest key is already gone after the FIRST prune).

### Fix 1 (MAJOR) — a persisted, un-TTL'd "pending reclaim" record

Split "remember the orphan exists" from "the verified-untracked FACT." The fact keeps its 60s TTL
(`verifiedUntrackedCache`, unchanged); the orphan's EXISTENCE is now ALSO persisted in the EXISTING
`.loom-skills-fingerprints.json` sidecar, under one reserved top-level key (`__pendingReclaim`, never a
real session id) holding `{ [name]: { deadFingerprints: string[], firstSeenAt: number } }`. This record
survives the 60s TTL — it is read back and merged on every later call at that cwd, so a call that finds
no fresh verified fact simply RE-KICKS the bounded async check instead of giving up. It resolves (is
removed) four ways, each handled in the one resolve loop in `injectSkills`'s shared-cwd branch: reclaimed;
current content no longer matches ANY of its recorded `deadFingerprints` (edited — dropped, never acted
on again); a live session now claims the name (`otherClaimed`); or the dir is simply gone. Bounded two
ways, defensively (practically never hit in a real project): `PENDING_RECLAIM_MAX_PER_CWD` (a per-cwd cap
— the oldest entries, by `firstSeenAt`, are dropped first) and `PENDING_RECLAIM_MAX_AGE_MS` (an age
limit — an entry unresolved this long is given up on and dropped, never acted on again). Proven via
`skills-dead-claim-reclaim-shared-cwd-core.mjs`'s own second scenario: discover → await → monkeypatch the
global `Date.now` (this codebase's own test-clock convention, e.g. `temp-path-collision-guard.mjs`) 61s
past the TTL → a later call RE-KICKS rather than giving up → await → the next call repairs. Verified RED
via `negative-control` at both `--ref 6e8e1dfa` (round 1's own tip) and `--ref 58e92e13` (the original
pre-fix baseline), GREEN restored.

### Fix 2 (MINOR) — consume/reclaim is gated on `want`

Round 1's Pass 1 consumed (deleted) a ready cache entry UNCONDITIONALLY, regardless of whether the
CURRENT caller's own `want` set included the name — so a narrow-subset or locked-role session that
didn't even want the skill could still silently destroy the one fact a LATER, actually-wanting session
needed. Round 2's resolve loop checks `want.includes(name)` before EVER consuming a verified fact or
performing the no-repo immediate reclaim; a non-wanting call leaves the cache entry (if still valid) and
the pending record exactly as they were, for a later caller. A STALE or fingerprint-mismatched cache
entry is still dropped regardless of `want` — that's a correctness concern (never serve a wrong fact to
anyone), not a consumption-rights concern. Proven in `skills-dead-claim-reclaim-shared-cwd.mjs` section 10.

### Fix 3 (MINOR) — walk from the target skill dir, check the INNERMOST repo

Round 1's `anyGitDirUpTree`/`kickUntrackedCheck` both started from `cwd`, assuming `cwd`'s own repo is
the only one that could matter. A git repo nested BELOW `cwd` (e.g. someone `git init`s `.claude` or
`.claude/skills` directly) is invisible from the OUTER repo's own `git ls-files` — git treats a directory
holding its own `.git` as a repo boundary the outer repo never descends into — so a dir tracked ONLY in
that inner repo would have been wrongly reported as untracked and reclaimed. Fixed: `innermostGitRepoRoot`
walks UP from the TARGET skill dir (not `cwd`), and `kickUntrackedCheck` now runs `canonicalGit` against
whatever repo root that walk finds, with the pathspec computed relative to THAT root. A repo root that
`canonicalGit` can't actually use (refused by the canonical-git trust boundary, or any other error) still
fails closed exactly as before — nothing new needed there, the existing try/catch around the whole check
already treats any failure as "never reclaim." Proven in `skills-dead-claim-reclaim-shared-cwd.mjs`
section 11 (a nested `.claude/.git` with the skill committed there — never replaced).

**Named residual (new):** a repository configured purely via `GIT_DIR`/`GIT_WORK_TREE` environment
variables, with NO on-disk `.git` entry anywhere up the tree from the target at all, is invisible to this
pure-fs walk — such a target still reads as "no repo" and is reclaimed immediately even if it is
genuinely tracked through that external configuration. Loom's own session cwds are always ordinary
checkouts, never `GIT_DIR`-redirected; accepted as out of scope rather than fixed here.

### Fix 4 (MINOR, doc accuracy) — `copySkillAtomic` is rm-then-rename, not a single atomic replace

Both this record (the original "Do not" list, corrected above) and `inject.ts`'s own comments overclaimed
`copySkillAtomic` as an atomic replace with "never a separate delete first." It is not: it builds the new
copy in a sibling tmp dir, THEN `fs.rmSync(dest, ...)`, THEN `fs.renameSync(tmp, dest)` — there is a real,
if brief, window between the rm and the rename where `dest` does not exist on disk at all. The correctness
property that DOES hold or already held: the new copy is always FULLY built before the old one is ever
removed, so a FAILED copy never leaves a half-written or merged `dest` — only a successful one has this
existence gap, and only for as long as the rename takes. Corrected in both this file and `inject.ts`'s own
doc comments; not otherwise changed — the optional "rename old aside, rename new in, remove the aside"
hardening this card's kickoff floated is NOT implemented here (it would widen scope beyond THIS card's
actual bug, which is the shared-cwd reclaim mechanism, not `copySkillAtomic`'s general delivery path used
by every skill, reclaimed or not) — named as a residual, not fixed.

## Do not (round 2 additions)

- Do not consume a verified-untracked fact, or perform the no-repo immediate reclaim, for a name `want`
  does not include — leave the cache entry / pending record for a later caller that does want it. A
  STALE or fingerprint-mismatched entry is still dropped regardless of `want` (a wrong fact is never
  worth keeping for anyone).
- Do not walk `anyGitDirUpTree`/`innermostGitRepoRoot` from `cwd` — walk from the TARGET skill dir. A
  nested repo below `cwd` is otherwise invisible, and the tracked-file check would run against the wrong
  repository even when `cwd` itself is one.
- Do not describe `copySkillAtomic` as a single atomic replace with no delete step, here or in
  `inject.ts` — it rm's `dest` then renames, with a real window where `dest` is simply missing.
- Do not re-derive the pending-reclaim record's bound constants (`PENDING_RECLAIM_MAX_PER_CWD`/
  `PENDING_RECLAIM_MAX_AGE_MS`) elsewhere — read them at their one definition in `inject.ts`.
- Do not treat `__pendingReclaim` as a real session id anywhere this file's reclaim code iterates
  `Object.keys`/`Object.entries` of the fingerprints sidecar's session map — it is a reserved top-level
  key, parsed and written separately from every real session's own fingerprint record.
