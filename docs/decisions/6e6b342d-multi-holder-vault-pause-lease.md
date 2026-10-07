# 6e6b342d — multi-holder vault pause lease, taken inside the canonical lock

Follow-up to `87a3c87e`'s Code Review (findings b/c) and `237d1899` (per-op token). Read both first.

## Narrative

**Finding (b), single-token clobber.** The pause lease (`614dfbef`) used to be ONE file holding ONE
`{token, until}` pair, unconditionally overwritten by every `pauseVaultAutoCommit` call. `237d1899` made a
*resume* only clear the lease if its token still matched — but a *pause* still clobbered whatever entry
was already there. Sequence: op A pauses (token M), op B pauses on the SAME repo (token P, overwriting
the file), op B finishes and resumes (token P matches, file deleted) — A's protection is gone even though
A is still mid-surgery, with no way for A to notice.

**Finding (c), TTL vs queue wait.** `mergeBranch`/`fastForwardCanonicalMain`/`GitWriter`'s write ops all
used to call `pauseVaultAutoCommit` BEFORE `withCanonicalIndexLock` admission, with `until` = pause time +
10 min. An op queued behind another lock holder for longer than that could start mutating with an already
-expired lease.

**Why neither is a live correctness bug today.** Card `a09b81a0` (round 3, landed 2026-10-06 — after this
card was filed) independently made `commitVault()` take the SAME `withCanonicalIndexLock`, keyed by the
same `canonicalRepoLockKey`, whenever its vault is merge-eligible (`isCommitPathMergeEligible`) — and that
predicate is true in EVERY case where this lease could reach a vault's auto-commit tick at all (the lease
file and the tick's check both resolve via the same git-toplevel walk; the only commitPath a merge/
GitWriter write op ever pauses is a registered project's own repoPath, which is by definition the one
`isCommitPathMergeEligible` matches). So the tick and the merge/write op always contend for the SAME
mutex regardless of the lease's token/TTL state — real mutation can never interleave. See
`a09b81a0-vault-commit-code-repo-guard.md`'s own "Do not (round 4)" section, which states this explicitly
and assigns the multi-holder fix to THIS card. **This card is lease-bookkeeping honesty — making the
advisory mechanism behave the way its own doc claims for a second concurrent holder — not a corruption
fix.** Re-verified directly against current `main` before implementing (worker plan-checkpoint,
2026-10-07): both mechanisms still reproduce exactly as described.

## Fix

**Lease shape.** `{ leases: [{token, until}, ...] }` — a set of per-op entries, not one pair.
`pauseVaultAutoCommit` reads the existing set (dropping already-expired entries), appends its own new
entry, and writes the result back. `resumeVaultAutoCommit(token)` removes ONLY the entry carrying that
token; any other holder's entry survives untouched. `isVaultAutoCommitPaused` is true iff ANY entry is
unexpired. Calling `resumeVaultAutoCommit` with no token (back-compat / direct test setup only) clears the
WHOLE set unconditionally — unchanged from the pre-`6e6b342d` behavior, so only use it when the caller
knows it's the lease's sole possible holder.

**Atomic write.** Every write (`writeLeaseEntries`, `versioner.ts`) writes to a sibling
`<path>.tmp-<pid>-<uuid>` file first, then `renameSync`'s it over the real path — never a direct
`writeFileSync` to the live path. `fsync` is deliberately skipped (advisory, best-effort; losing the last
few ms of a write on a hard power-cut is acceptable, a torn read by a concurrent reader is not — the
rename is what makes the swap atomic from a reader's point of view). An orphaned `.tmp-*` left by a crash
between the write and the rename is harmless dead weight — nothing ever reads that path.

**Corrupt-file posture — unchanged EXCEPT for one case (round 2, Code Review Nit 2: the first version of
this record over-claimed "deliberately unchanged" without exception).** A missing lease file reads as "no
holders" everywhere. A file that exists but fails to parse (or parses to a non-array `leases`) is CORRUPT.
`isVaultAutoCommitPaused` returns `false` on it (fail-open toward committing, same as the old single-
`until` field read failing its own `JSON.parse`) — unchanged. `pauseVaultAutoCommit` treats a corrupt
existing file as "no entries to carry forward" and overwrites it with a fresh one-entry set — unchanged
(the old code ALSO unconditionally overwrote whatever — possibly corrupt — content was already there on
every pause; this is the same "pause always wins" posture, just appending into a parsed set instead of
blind-overwriting a single pair). **`resumeVaultAutoCommit` is where behavior actually CHANGED:** calling
it WITH a token on a corrupt file is unchanged (a no-op that leaves the file untouched — the old code's
`JSON.parse` throw, reached only via the token-match branch, was caught by the same outer catch that skips
`fs.rmSync`). But calling it WITHOUT a token on a corrupt file is NOT unchanged — old code's no-token path
skipped the match-check (and therefore the `JSON.parse` call) ENTIRELY and went straight to an
unconditional `fs.rmSync`, so a corrupt file WAS deleted by a no-token resume pre-`6e6b342d`. New code
always calls `readLeaseEntries` first regardless of whether a token was given, so a no-token resume on a
corrupt file now ALSO leaves it untouched instead of deleting it. This is a deliberate, accepted
behavior change (no-token resume is back-compat/test-only, never a real production path — see the lease-
shape paragraph above), not a bug, but the record's own claim of "deliberately unchanged" was wrong to
state without this exception.

**I/O errors are a THIRD, separate case (round 2, Minor 3).** A file that EXISTS but can't even be
*read* — a transient Windows EBUSY/EPERM on a file another process briefly holds open, as opposed to a
file that reads fine but parses to garbage — must never be treated the same as content corruption.
`pauseVaultAutoCommit` used to call the SAME catch-and-start-fresh branch for either case, meaning a
purely transient I/O glitch could silently overwrite (and so drop) every real holder's entry — the exact
clobber this card exists to close, just reached through a different door. `readLeaseEntries` now throws a
distinct `LeaseReadIoError` for an I/O-level read failure (anything from `fs.readFileSync` other than
`ENOENT`, which is the ordinary "no file" case); `pauseVaultAutoCommit` catches that specific type and
skips the write entirely — this op's own pause fails open (no lease held for it, token still returned,
best-effort as always) while every existing holder's entry is left completely untouched. A genuine content
parse/shape error still starts fresh, exactly as before. `resumeVaultAutoCommit` needed no equivalent
change — its own existing "any read failure ⇒ no-op, never write" behavior was ALREADY the safe response
to an I/O error, for the same reason a content-corruption no-op is safe there: it only ever REMOVES
entries after a successful read, so any read failure, of either kind, just skips the write.

**Single-process assumption.** All three functions (`pauseVaultAutoCommit`/`resumeVaultAutoCommit`/
`isVaultAutoCommitPaused`) are purely SYNCHRONOUS `fs` calls with no `await` inside, so one call's full
read-modify-write body can never be preempted mid-function by another call on Node's single-threaded event
loop — no OS-level file lock (flock / proper-lockfile) or CAS-retry loop is needed for correctness. This
holds ONLY because every real caller lives inside ONE Node daemon process; the lease file is never exposed
via any CLI/REST surface, so no external process ever writes it. **A second daemon process pointed at the
SAME repo's `.git` directory is explicitly OUT OF SCOPE** — that would reintroduce a genuine cross-process
race (two real `writeFileSync`/`renameSync` sequences from different OS processes), which this design does
not protect against. Loom does not run two daemons against one project's repo; if that assumption is ever
broken, this mechanism needs real file locking, not just the rename trick above.

**Bracket sites moved inside the lock.** `mergeBranch` (`git/worktrees.ts`), `fastForwardCanonicalMain`
(`git/batch-merge.ts`), and `GitWriter.checkout`/`createBranch`/`commit` (via `withVaultPauseLease`,
`git/writer.ts`) now call `pauseVaultAutoCommit` as the FIRST thing inside the `withCanonicalIndexLock`
callback and `resumeVaultAutoCommit` in THAT callback's own `finally` — not before lock admission. A
`RepoQuarantinedError` thrown by the lock itself before the callback ever runs now means the pause is
NEVER taken at all (there is nothing of this op's to resume, and nothing of a foreign holder's gets
touched either) — this is a behavior change from before (which unconditionally paused-then-resumed even on
a pre-admission quarantine refusal, which incidentally cleared any foreign lease present at the time; see
"Does not cover" in `87a3c87e`'s record). **`GitWriter.push()` is the one exception, deliberately left
pausing OUTSIDE any lock** — `push()` never calls `withCanonicalIndexLock` at all (a `git push` doesn't
mutate the local index/working tree, so there's nothing on this repo for it to race; `a09b81a0`'s own
record states this explicitly). `withVaultPauseLease` (the shared pause/resume wrapper) is unchanged and
still used by `push()` for exactly this reason — it was never the thing that needed to move.

**Lock-acquisition order is unchanged.** `pauseVaultAutoCommit`/`resumeVaultAutoCommit` never acquire any
lock of their own (pure sync `fs` calls) — moving them inside the `withCanonicalIndexLock` callback adds no
new lock and does not change when the ONE lock on this path (`withCanonicalIndexLock`, keyed by
`canonicalRepoLockKey`) is acquired or released. No site on this path already holds a second lock before
calling into `mergeBranch`/`fastForwardCanonicalMain`/`GitWriter`, so there is no deadlock to introduce.

## Do not

- Do not go back to a single `{token, until}` pair — a second concurrent pauser must be additive, never
  overwrite.
- Do not add real file locking (flock, proper-lockfile, a CAS retry loop) to these functions — the
  single-daemon-process + all-sync-`fs`-calls property already makes the read-modify-write atomic from
  Node's point of view; a second lock here would be solving a problem that doesn't exist for the one
  process that actually calls these functions, at real complexity cost.
- Do not change `resumeVaultAutoCommit`'s corrupt-file behavior to "clean up" a corrupt file — leaving it
  untouched on a parse failure (with or without a token) is the intended posture; a resume that starts
  WRITING on a parse failure is new, un-audited behavior this card does not intend to add. Note the
  no-token case's own file DID change shape from pre-`6e6b342d` (deletes → leaves untouched) — see the
  "Corrupt-file posture" paragraph above for why that's accepted, not a regression to revert.
- Do not let `pauseVaultAutoCommit` treat a transient I/O error (`LeaseReadIoError`) the same as content
  corruption — only a genuine parse/shape failure may safely overwrite; an I/O error must skip the write
  entirely (see the "I/O errors" paragraph above).
- Do not move `GitWriter.push()`'s pause/resume bracket inside any lock — it has no lock to be inside of,
  and does not need one (nothing it does mutates the local index/tree).
- Do not read a green run of this card's own fix as proof the merge-vs-tick mutation race was ever open at
  HEAD — it wasn't, independent of this fix; see "Why neither is a live correctness bug today" above and
  `a09b81a0`'s own record. This card closes a lease-honesty gap, not a corruption bug.
- Do not assume this design is safe under two daemon processes sharing one repo's `.git` — it is explicitly
  not; see "Single-process assumption" above.

## Tests

**Round 1.** `merge-vault-auto-commit-pause.mjs` scenario 2 and `batch-merge-vault-auto-commit-pause.mjs`
scenario 2 were reworked to prove the resume-after-a-real-failure WITHOUT relying on a foreign-lease
clobber (which the fix deliberately removes). Two new properties added: a foreign holder's own entry
survives another op's resume (`vault-pause-lease-multi-holder.mjs`), and a queued op's lease is taken at
LOCK ADMISSION, not at call time (`vault-pause-lease-admission-timing.mjs`).

**Round 2 (Code Review).** Minor 1: `batch-merge-vault-auto-commit-pause.mjs` scenario 2 now injects a
REAL escaping throw via a fake `gitFactory` (its first call fails synchronously — `batch-merge.ts`'s own
`boundedGit`/`boundedMergeGit` never wrap that call in a try/catch, unlike `worktrees.ts`'s equivalent,
confirmed with a standalone probe) to prove the resume specifically needs the lock callback's own
`finally`, proven with NC3 (temporarily replacing `finally` with a plain post-await resume makes the same
assertion go RED; restoring it goes GREEN, tree confirmed byte-identical). `merge-vault-auto-commit-
pause.mjs`'s own scenario 2 could NOT be given the same proof — verified directly that `mergeBranchLocked`
catches every injected error internally and converts it to a structured `{ok:false,...}` return, never a
real rejection — so its header and check labels now say plainly that it proves resume-after-a-return, not
resume-survives-a-throw, and point at the batch test as the place that property IS proven (same bracket
SHAPE, best available evidence). Minor 2: `vault-pause-lease-multi-holder.mjs`'s "reverse order" block
(which didn't actually reverse pause/resume order relative to the first block, so it silently re-tested
237d1899's own property) was replaced with the card's own literal clobber sequence — M pauses, P pauses
later, P resumes FIRST — asserted both at the file level and behaviorally (`VaultVersioner.commit()` still
skips), proven RED under NC1 (versioner.ts reverted to its pre-`6e6b342d` commit). Minor 3:
`vault-pause-lease.mjs`'s new scenario 10 injects a transient I/O error (monkey-patching the shared
`fs.readFileSync`, confirmed to reach `versioner.ts`'s own calls) and proves a real holder's entry survives
byte-for-byte, with a behavioral corroboration — RED/GREEN proven directly against this same commit. Item
6 (follow-up): `git-writer-pause-admission-timing.mjs` is new — the admission-timing property, applied to
`GitWriter.checkout`/`createBranch`/`commit` (the third bracket-moved site), each holding the canonical
lock externally and sampling strictly inside that hold window.
