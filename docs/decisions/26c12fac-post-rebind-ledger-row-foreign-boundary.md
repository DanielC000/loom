# 26c12fac — keep a post-rebind ledger row from seeding a foreign boundary

From c13666c6's third Code Review (probe4 F, round 4's own "Named residual", tracked separately as this
card). `Db.resetMainlineBaselinesForRepoChange` clears a (project, repoKey) scope's
`mainline_landed_commits` rows and its `gone-branch-ledger-boundary:<projectId>:<repoKey>` `app_meta` key
the moment a repoPath genuinely changes. A confirm/batch that captured its `repoPath` *before* the rebind,
still mid-flight, can finish *after* it and call `Db.recordMainlineLandedCommit` with the OLD repo's shas.
Since the table was just cleared, that late write re-seeds the boundary with a sha that never resolves in
the NEW repo — `resolveGoneBranchLedgerBoundary` returns it forever (write-if-absent, never re-seeded),
and every later gone-branch lookup in the new repo reads `"error"`, never cached, until a human
intervenes.

## Reachability

`checkRepoRebind` (`projects/rebind.ts`) refuses a rebind only while a LIVE worktree session exists,
project-wide (`process_state='live' AND worktree_path IS NOT NULL`). It has no notion of "a merge/confirm
op is in flight" — that tracking exists (`inFlightMergeTaskIds`, decision `641cc62c`) but is consulted
only by spawn/recycle, never by rebind.

Neither ledger-write call site requires its worker session to be LIVE. A worker commonly exits with its
worktree/branch RETAINED while a merge is still pending against it — an already-tested pattern in this
repo (`test/confirmworkermerge-reserved-home-guard.mjs`, `test/project-rebind.mjs` (3b)/(3c), both for the
sibling `37e15c26` bug). Both ledger-write call sites capture their repo path once, early
(`confirmWorkerMerge`'s `repoPath`, `mergeBatchTracked`'s `finalRepoPath`), and never re-read it before the
eventual write — the solo write sits ~500 lines and an unbounded gate-command wait after the capture; the
batch write similarly follows the whole assembly + gate + fast-forward.

So: a worker is stopped after reporting done (routine) → its merge is confirmed later, capturing the
CURRENT repoPath → while mid-flight, a human/Platform-Lead rebinds the project → `checkRepoRebind` sees
zero live sessions project-wide → passes → `resetMainlineBaselinesForRepoChange` clears the scope → the
still-running merge finishes using the captured OLD repoPath's shas → the boundary is re-seeded foreign.

Verified with a real-git, hermetic repro (`test/mainline-ledger-rebind-race.mjs`), injecting the rebind
deterministically mid-flight via the existing `soloMergeGitFactory`/`batchFfGitFactory` test seams (the
same R3 pattern `mainline-watch-race-guards.mjs` uses for the sibling watermark race) — RED on the pre-fix
code (boundary poisoned, row written), GREEN after the fix.

## The fix: a repoPath reconfirmation at the ledger write, mirroring the watermark's own guard

This exact race is already closed for the mainline watermark — `advanceMainlineWatermark` and
`advanceMainlineWatermarkForBatch` (`sessions/service.ts`) each carry a "repoPath reconfirmation against a
rebind mid-flight" guard (decision `c013e8a5`):
```
const project = this.db.getProject(projectId);
if (!project || resolveRepoByKey(project, repoKey).path !== repoPath) return;
```
The ledger write had no equivalent — and, in both confirm paths, the ledger write happens *before* the
watermark advance call, so it could never piggyback on the watermark's own check either.

`SessionService.recordMainlineLedgerEntryIfRepoUnchanged(projectId, repoKey, repoPath, branch, tip, base)`
is now the ONE chokepoint both the solo (`confirmWorkerMerge`, ~21386) and batch (`mergeBatchTracked`,
~23006) callers route through — neither calls `db.recordMainlineLandedCommit` directly. It re-reads the
project fresh and compares, via `literalRepoPathKey` (`git/repo-lock.ts`), against the `repoPath` the
caller captured at its own merge-start; a mismatch skips the write (`console.warn`) instead of seeding a
foreign boundary. No `await` between the fresh read and the write (`better-sqlite3` is synchronous), so
nothing can interleave — the same reasoning that already makes the watermark's version race-free.

**Why `literalRepoPathKey`, not raw `!==` (the watermark's own comparison)?** `resolveRepoByKey` returns
`project.repoPath`/a registry entry's `path` verbatim — neither is normalized at rest. The watermark's
existing guard compares raw strings, so a purely cosmetic difference (win32 case, a trailing separator)
would read as "changed" and skip the advance even though the repo never moved — a real, minor, pre-
existing residual of that guard. Using raw equality here would carry the same risk.
`resetMainlineBaselinesForRepoChange` itself already decides "did this scope's repo change" via
`literalRepoPathKey` (through `repoPathMaps`), so this guard uses the SAME normalized comparison, rather
than a second, independently-drifting notion of it. **The two guards deliberately differ on this one
axis — not an oversight in either.** The watermark's own raw-equality residual is NOT fixed here: it's
pre-existing, independent, lower-severity (fail-open — it only ever misses advancing W, which the next
landing corrects), and out of this card's scope. Named as a candidate follow-up for a human to card.

## The self-heal direction was considered and explicitly skipped

The investigation direction offered an "and/or self-heal when the boundary object definitively doesn't
exist" option. **Skipped per the manager's ruling**: the poisoned state this card's forward fix prevents
can only ever have been produced by `c13666c6`'s own round-3 rebind-cleanup (nothing before it cleared the
ledger/boundary on a rebind at all) — and `c13666c6` landed on main only minutes before this card's own
investigation, not yet reaching a running daemon via a deploy/restart. So no real scope could have been
poisoned by this race before this card's own forward fix landed; there is no existing poisoned state to
recover. The forward-looking guard suffices on its own.

## Do not

- Do not call `db.recordMainlineLandedCommit` directly from a solo or batch landing caller — both must
  route through `recordMainlineLedgerEntryIfRepoUnchanged`, or the reconfirmation is silently bypassed.
- Do not compare the reconfirmation's two paths with raw `!==` — use `literalRepoPathKey`, matching how
  `resetMainlineBaselinesForRepoChange` itself decides whether a scope's path changed; a raw comparison
  reopens the cosmetic (case/trailing-separator) false-mismatch risk this card deliberately avoided.
- Do not read the watermark's own `c013e8a5` raw-equality comparison as fixed by this card — it is
  untouched, deliberately, and still carries that residual; see "Why `literalRepoPathKey`" above first.
- Do not add a self-heal to the boundary-existence probe for this card — considered and ruled out (see
  above): no poisoned state can exist yet to recover. Revisit only if one is ever actually observed.
- Do not widen `checkRepoRebind`/`checkLiveWorktreeSessions` to also refuse while a merge/batch is
  in-flight (e.g. via `inFlightMergeTaskIds`) as a substitute for the write-time guard — considered and
  deliberately not pursued: it would change rebind's own refusal behavior (a broader, separate decision)
  and isn't needed once the write itself is scope-aware.
- Do not treat a dropped (skipped) ledger write as a correctness problem for the landing itself — the
  squash/fast-forward already succeeded for real; only one historical ledger row is lost, which only ever
  makes a FUTURE lookup more conservative (a false "unrecorded"), never less — consistent with this gate's
  existing fail-closed posture (`c13666c6`'s own "Do not" list).

## Tests

`test/mainline-ledger-rebind-race.mjs` — hermetic, real-git where needed, no daemon boot:
- (a) Db-only fast repro calling `recordMainlineLedgerEntryIfRepoUnchanged` directly: seed → rebind → late
  write (stale repoPath) ⇒ boundary stays null, no row written; an unraced control that still records; a
  trailing-slash-only cosmetic-variant control that must still record (`literalRepoPathKey`).
- (b) real-git SOLO and BATCH cases, injecting the rebind deterministically mid-flight via the existing
  `soloMergeGitFactory`/`batchFfGitFactory` test seams (`_late-commit-seam.mjs`, reused for solo) — each
  with an unraced control proving the guard isn't a blanket refusal.
- RED verified on the pre-fix `service.ts` (temporarily reverted, rebuilt, re-tested, then restored and
  rebuilt again): both the solo and batch "FIX:" assertions failed exactly as predicted (boundary
  poisoned, row written) while every setup/control assertion stayed green.
