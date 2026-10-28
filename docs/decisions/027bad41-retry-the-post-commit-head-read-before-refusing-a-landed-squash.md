# 027bad41 — retry the post-commit HEAD read once before refusing a landed squash; the ALREADY_MERGED path stays a named, accepted residual

From card 08c36dae's Code Review (reviewer 26e224a0, 2026-10-27), reproduced with a throwaway 3-worker
script. Builds on `08c36dae` (honest `squashLandedUnread`/`headMovedUnverified` wording) and `5958c149`
(the `worker_landed_tip` ledger column) — both already landed; this card closes the trust-freeze exposure
`08c36dae` named but deliberately left open.

## The bug

1. w1 lands normally; mainline trust = A.
2. w2's squash commit lands for real, but the immediately-following confirmatory `git rev-parse HEAD`
   read throws — `squashLandedUnread`. `recordMainlineLedgerEntryIfRepoUnchanged` and
   `advanceMainlineWatermark` both skip (gated on `merge.ok`, which is `false` here).
3. w2's re-confirm resolves `ALREADY_MERGED` (a content-verified noop, via `findLandedSquashCommit`). That
   path ALSO skips the ledger/advance calls (gated on `merge.ok && !merge.noop`).
4. w3 lands normally. Its `advanceMainlineWatermark` sees `checkedTip` = w2's own commit, which has no
   ledger row, so it FREEZES trust at A and files a HIGH `mainline_moved_outside_loom` alert
   (`source:"landing-trust-freeze"`) naming Loom's own commit as if it were foreign.

## Two candidate fix points, and why only one is safe

**(a) Ledger from the `ALREADY_MERGED` re-confirm (`!staged` branch, `git/worktrees.ts` ~L10968-10981 →
`finishAlreadyMerged`).** The ONLY evidence available there is `findLandedSquashCommit`'s
`branchContentLandedInCommit` — a content/tree EQUIVALENCE check against the branch's current diff, never
an identity check against anything Loom captured synchronously before a commit. `preCommitHead`/
`stagedTree` (the values `verifyLandedAsOwnCommit` checks against) are captured strictly AFTER the
`!staged` early return — they are never computed at all on this path, and whatever the ORIGINAL failed
attempt captured was never persisted anywhere, by a now-finished, possibly different process.

**Rejected as unsafe.** An attacker with `.git` write access to the shared canonical repo (every worker
worktree shares it) can, at ANY time — no narrow live-race window required, unlike every existing accepted
residual (round 22/23 of `2a6a292a`'s "racer-chosen trailers"/"index tampering" residuals both require
racing a live landing within milliseconds) — read the worker's own worktree, build a commit whose tree is
content-identical to what the real squash would produce, and forge the `Loom-Worker-Branch`/
`Loom-Landed-Tip` trailers to name that branch. `findLandedSquashCommit`'s content check passes it as
"ALREADY_MERGED" regardless. Ledgering on that basis is exactly the "content equality alone" the owning
card forbids, and is structurally EASIER to pull off than any already-accepted forgery residual. **The
only way to close (a) soundly would be a NEW durable pre-commit capture** — write `preCommitHead`+
`stagedTree` to a durable table BEFORE the commit attempt, independent of whether the confirmatory read
ever succeeds, so a LATER `ALREADY_MERGED` re-confirm (even across a crash/restart) could consult it. That
is a materially bigger redesign (a new write on the hot per-repo-locked squash path, its own retention/
cleanup, its own crash-window analysis) than this card's scope — not attempted here, and not carded yet
(owner ruling, gen 451: not carding it now). **This residual stays, named and accepted, fail-closed
exactly as before this card** — see "Residual" below.

**(b) Retry the confirmatory read itself (`git/worktrees.ts` ~L11200-11213, inside `mergeBranchLocked`).**
The commit ITSELF already succeeded here; only the immediately-following `git rev-parse HEAD` read throws.
`preCommitHead`/`stagedTree` were ALREADY captured synchronously, in-process, under the per-repo exclusive
squash lock, by THIS SAME invocation — exactly the "only Loom's own process could have produced it"
evidence a ledger/trust decision needs. **Fixed, this card:** retry that one read once (mirrors
`attemptCodexAutoCommit`'s own one-retry precedent for the identical post-commit-read shape,
`git/worktrees.ts` ~L3365, "a bare rev-parse HEAD is cheap and a single transient failure... shouldn't be
enough to declare the state permanently unknown") before falling into the `squashLandedUnread` catch. No
delay between attempts — same reasoning as that precedent: the read is cheap and local, and the SAME
per-repo exclusive lock the commit itself just ran under means no IN-PROCESS Loom writer can land anything
on this repo between the two attempts. An OUT-OF-PROCESS actor (a racer with `.git` write access, outside
Loom's own lock entirely) still can — that is exactly the (UNIT-FORGE) scenario below, and
`verifyLandedAsOwnCommit` is what rejects it, not the lock; the lock only rules out a SECOND Loom op.

## Forgery analysis for (b)

The retry changes nothing about WHAT counts as verified — it only gives the existing, unchanged
`verifyLandedAsOwnCommit`/`classifyLandedVerify` (hardened through `2a6a292a` rounds 19-23: parent+tree+
single-parent+exact-trailer, read via `git cat-file -p` to defeat grafts/replace-refs) more chances to run
against a genuinely-successful commit's own sha before giving up. A racer moving HEAD during the retry
window (same threat model as round 21's FORGE-RACE) produces a sha whose parent/tree/trailer doesn't match
`preCommitHead`/`stagedTree`/branch — `verifyLandedAsOwnCommit` returns `landedBase: undefined` →
`landedVerify: "rejected"` → not ledgered, exactly as today. Net forgery exposure is unchanged from the
already-accepted round 19-23 posture; no new surface is introduced.

## Code Review fix round — never retry a refusal or a timeout

The first version of this fix retried on ANY caught error, including a `CanonicalGitRefusal` (a durable,
definitive fact — nothing else in this file ever retries one either) and a `WithTimeoutExpiry` (retrying
would hold the canonical lock for a SECOND attempt on top of a child `withTimeout` already left running
unconfirmed — see `withTimeout`'s own doc, `git/bounded.ts`, for why it settles independent of its child).
Fixed: the retry loop now checks `e instanceof CanonicalGitRefusal || isWithTimeoutExpiry(e)` and rethrows
immediately for either, past the loop, straight into the existing outer catch — the SAME single-attempt
path that ran before this card existed, byte-for-byte. Only a genuinely transient, non-refusal,
non-timeout failure gets the second attempt. Because a refusal/timeout is never queued for a retry in the
first place, the exhausted-both-attempts case (`squashLandedUnread`'s `reason` text) can never be built
from a masked first-attempt refusal — the error it surfaces is always either a lone refusal/timeout
(immediate, one attempt) or the SECOND attempt's own plain transient error (two attempts, neither a
refusal) — never a mix. When the retry DOES fire (a transient, non-refusal, non-timeout failure on attempt
1), that first failure is logged via `console.warn` (`[git] mergeBranchLocked: post-commit HEAD read
failed (attempt 1/2), retrying once: <message>`) before the second attempt runs — so a recovered retry
still leaves a trace, even though the function's own return value shows no sign one ever happened.

## Residual — named, not papered over (candidate (a), permanently, until a future card)

A genuinely exhausted retry (both reads fail) still falls into `squashLandedUnread`'s refusal, and its
later `ALREADY_MERGED` re-confirm still cannot enter the ledger — per the forgery analysis above, this is
the `2a6a292a`-round-20-shaped residual this card deliberately leaves standing. `08c36dae`'s existing
wording for both the `squashLandedUnread` refusal and the later-landing trust-freeze alert remains accurate
for this narrower (now much rarer) population — no wording change was needed. The only way to close it is
the durable pre-commit capture sketched above; that redesign is not carded.

## Tests

- `mainline-watch-squash-landed-unread-retry.mjs` (new, UNIT-level, calls `mergeBranch` directly, isolated
  from the service layer): (UNIT-RECOVER) a one-shot confirmatory-read failure recovers, `landedBase`/
  `landedVerify` exactly as a first-attempt success. (UNIT-FORGE) — **the real forge case**: a racer
  sharing the real commit's own PARENT but a DIFFERENT tree (same construction as
  `mainline-watch-own-commit-verify.mjs`'s own `installForgingPostCommitHook`, planted directly inside the
  fault factory's throw, not via a `.git/hooks` hook, since it must fire specifically BETWEEN the two
  confirmatory reads) replaces `refs/heads/main` during the retry window — the retry picks up the racer's
  sha, `verifyLandedAsOwnCommit` rejects it (`landedBase:undefined`/`landedVerify:"rejected"`), never
  ledgered. (UNIT-EXHAUSTED) every attempt failing still falls through to `squashLandedUnread`, unchanged.
  (UNIT-REFUSAL-NOT-RETRIED)/(UNIT-TIMEOUT-NOT-RETRIED) (Code Review fix) — a `CanonicalGitRefusal`/
  `WithTimeoutExpiry` on attempt 1 is asserted NEVER retried (exactly one read call made, via a mutated
  `stats.attempts` counter) and surfaces as the SAME `squashLandedUnread` a single un-retried attempt
  always produced. (UNIT-RETRY-LOGS-ATTEMPT-1) (Code Review fix) — a recovered one-shot failure is proven
  to log attempt 1's own error exactly once, via a captured `console.warn`.
- `merge-confirm-squash-landed-unread-recovered.mjs` (new, end-to-end, via `confirmWorkerMerge`):
  reproduces the card's exact 3-worker sequence with a ONE-SHOT confirmatory-read failure for w2's squash
  — no forge case here (that lives in the UNIT file above); this file's own job is proving the FULL
  service-layer chain (ledger write, `worker_landed_tip` stamp, watermark advance, freeze suppression)
  reacts correctly to a recovered landing. RED-then-GREEN verified by temporarily reverting the retry loop
  (captured via `git diff` outside the repo, restored via `git apply`, never `git stash`) against a FIXED
  pre-recorded sha, rebuilding, and confirming the fix-dependent assertions fail, then restoring and
  confirming green again: before the fix, w1 lands, w2 hits `squashLandedUnread`+no ledger row, w3's
  landing files exactly one HIGH `mainline_moved_outside_loom` freeze naming w2's commit, trust stays
  frozen at w1's tip. After the fix: the retry recovers on attempt 2, w2's `confirmWorkerMerge` reports
  `merged:true`, its ledger row's own `worker_landed_tip` column is asserted equal to w2's WORKER BRANCH
  head sha (`db.ts`'s own `tip`-vs-`worker_landed_tip` distinction, ~L1541-1542 — NOT the squash commit's
  own sha on main, which is what `tip` already covers), w3 lands with ZERO freeze events, trust advances
  to w3's own tip. The same file's (EXHAUSTED) scenario proves the residual (candidate (a), never fixed)
  byte-for-byte: w2's refusal, its ALREADY_MERGED re-confirm, and w3's eventual HIGH freeze all behave
  exactly as before this card.
- `merge-confirm-squash-landed-unread.mjs` (existing, updated): the fault-injection factory
  (`postCommitReadFailFactory`) is widened from one-shot to PERSISTENT (every post-commit `rev-parse HEAD`
  call during op1 now throws, not just the first) so this file keeps exercising the genuinely-exhausted-
  retries path its assertions were written for — a one-shot fault is no longer enough to reach
  `squashLandedUnread` once the retry exists. Every existing assertion in this file (the flag/wording in
  part A, the double-land check in part B, the never-cached reasoning in part C) is unchanged and stays
  green — only the fault's PERSISTENCE changed, not what it proves.
- `mainline-watch-landing-trust-freeze.mjs` — untouched by this card's change (it drives
  `advanceMainlineWatermark` directly, never through `mergeBranchLocked`'s own confirmatory read); re-run
  to confirm it is unaffected.
- Guards (`pnpm --filter @loom/daemon guards`) plus the canonical-git-path scanners named in this
  project's `CLAUDE.md` (`canonical-git-helper-guard.mjs`, `canonical-git-isolation.mjs`,
  `bare-ref-positional-argv-guard.mjs`) since this touches a canonical-merge-path git call.

## Do not

- Do not ledger a commit from the `ALREADY_MERGED` re-confirm path on `findLandedSquashCommit`'s content
  check alone — see the forgery analysis above; it is structurally weaker than `verifyLandedAsOwnCommit`
  and has no narrow-race-window precondition, unlike every other accepted forgery residual in this area.
- Do not add a durable pre-commit capture to close that residual without its own card — it needs its own
  write-path, retention, and crash-window analysis; this card deliberately does not attempt it.
- Do not add a delay between the two `rev-parse HEAD` attempts — the read is cheap and local; see "(b)"
  above for why that holds despite an out-of-process racer still being possible in the window.
- Do not trust the retried read's sha on its own — it must go through the unchanged
  `verifyLandedOnMainline`/`verifyLandedAsOwnCommit` checks exactly like a first-attempt success would.
- Do not revert `merge-confirm-squash-landed-unread.mjs`'s fault-injection factory back to one-shot — once
  the retry exists, a one-shot fault no longer reaches `squashLandedUnread` at all (see the new sibling
  test for that recovered shape); this file's own contract is specifically the exhausted-retries case.
- Do not retry on `instanceof CanonicalGitRefusal` or `isWithTimeoutExpiry(e)` — a refusal is a durable,
  definitive fact everywhere else in this file too, and retrying a timeout holds the canonical lock a
  second time on top of a child `withTimeout` already left running unconfirmed. Rethrow immediately, past
  the retry loop, into the existing outer catch.
- Do not classify a refusal/timeout by matching `.message` text — always `instanceof`/`isWithTimeoutExpiry`
  at the point this card's own loop catches the error, same posture as every other classifier in this file.
- Do not drop the attempt-1 `console.warn` when the retry recovers — it is the only trace a genuine
  transient failure happened at all, since the function's own return value shows no sign of it.

Related: `docs/decisions/08c36dae-honest-wording-for-canonical-trust-and-unverified-head-squash-refusals.md`,
`docs/decisions/5958c149-read-the-landed-tip-pin-from-the-producer-ledger-first.md`,
`docs/decisions/2a6a292a-mainline-watermark-branch-change-only-on-a-trusted-signal.md`.
