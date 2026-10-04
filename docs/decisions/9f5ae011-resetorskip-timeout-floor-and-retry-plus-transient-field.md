# 9f5ae011 — `resetOrSkip` gets a timeout floor + a guarded retry, and `mergeBranch` gains a `transient`/`residuePossible` field for when that still isn't enough

Follow-up from 8d8fa497 (`quarantined:true` on the solo-merge result) and 8c3d6c04 (the same
`transient`/`residuePossible` shape, one layer earlier, on the UNION-merge producer) — read both first.

A later gated landing (op `c91e5339`) hit `merge-hang-does-not-wedge-queue.mjs` failing in a NEW way: op1
(scenario B) settled with a CONFIRMED (not quarantined) kill, yet op2 was refused right after with a
verbatim STAGED-DIRT entry-check refusal — a confirmed-kill squash was leaving real residue in the
canonical git index.

Root cause: `resetOrSkip`'s own cleanup (`git reset --hard HEAD`, restoring the canonical index after a
failed squash/commit) is itself a mutating, kill-confirmed canonical call — but it shared the failed
commit's own (possibly tiny) `timeoutMs` budget and gave up after one attempt with no structural signal
for "cleanup also confirmed-killed, residue may remain." `mergeMainIntoWorktree` (the sibling union-merge
producer) already closed this exact gap for itself (8c3d6c04); `mergeBranchLocked`'s cleanup never got it.

Deterministically reproduced via the `gitFactory` seam: a fake `raw()` throwing a plain, unflagged `Error`
on both the squash's `commit` call and the cleanup's `reset --hard` call (confirmed per
`treeDeathConfirmed`'s own test-seam message-regex fallback — the message carries the exact
`(git child killed): Abort signal received` shape that fallback matches, never inferred from
`!treeDeathUnconfirmed`) drives `resetOrSkip` to give up with the index still carrying the squash's staged
content — no real hung hook or host load needed.

## ⚠️ ROUND 2 CORRECTION (manager ruling, CR 905669e4 of round 1's commit 82c7038d)

Round 1's own Tests section below (half (b)) and `merge-confirm-verdict-cache-solo-merge-transient.mjs`'s
header claimed the pre-fix defect included a CACHED verdict — it did not. `squashRefusedResult` →
`"squash-refused"` is already in `NEVER_CACHED_OUTCOMES` (@decision fb525c31), and pre-fix this exact
shape (a confirmed-killed cleanup with no structural signal) fell through `mergeBranchLocked`'s generic
conflict/merge-failed branch straight into `squashRefusedResult` — ALREADY never-cached. The real delta
round 1 made was the CLASSIFICATION (a distinct `"solo-merge-transient"` outcome with accurate wording,
instead of the generic squash-refused bucket) and the retry mechanism — never caching. See the Tests
section below for how half (a)/(b) are now labeled to match.

## The fix

**A) `resetOrSkip` (`mergeBranchLocked`, `git/worktrees.ts`):** its `reset --hard` now runs with a floor
of `Math.max(timeoutMs, GIT_OP_TIMEOUT_MS)`. **This only matters when the caller's own `timeoutMs` (from
the resolved `timeouts.gitOpMs` config) is BELOW `GIT_OP_TIMEOUT_MS` (15000ms)** — `timeouts.gitOpMs` can
be configured anywhere from `GIT_TIMEOUT_FLOOR_MS` (1000ms, `sessions/service.ts`) upward, and when it is
at or above `GIT_OP_TIMEOUT_MS` the floor is a no-op (`Math.max` picks the caller's own value). **This
narrows the window where the cleanup itself starves under load; it does not eliminate it** — a
sufficiently loaded host can still confirmed-kill the cleanup at the floor.

**B) THE RETRY, round 2 (manager-approved Option B over dropping it — CR 905669e4):** round 1 retried on
"any non-quarantine, non-unconfirmed error" — over-broad (it also retried an UNRELATED git failure that
was never a kill at all) and, even for a genuine confirmed kill, pointless: a confirmed-killed reset
leaks a real `.git/index.lock` (reproduced via `taskkill /T /F` on Windows), so a bare retry fails at once
against that same lock. The fix is two layered pieces, both in `git/bounded.ts`/`git/worktrees.ts`:

1. **A TYPED confirmed-kill marker**, `CONFIRMED_KILL` (`git/bounded.ts`), the positive twin of the
   existing `UNCONFIRMED_KILL` marker — set ONLY at `spawnCanonicalGitTree`'s two `confirmed:true` sites
   (win32's unconditional confirmation, POSIX's `confirmProcessGroupDead` success) and propagated by
   `withTimeoutKillingChild` alongside the unconfirmed one. `treeDeathConfirmed(e)` (exported) checks this
   marker first, falling back to a `$`-anchored message-regex ONLY for a `gitFactory` test-seam call
   (bypasses the real kill machinery and its markers entirely). Mutually exclusive with
   `treeDeathUnconfirmed` by construction (disjoint if/else at every marking site) —
   `test/bounded-git-kill-marker-exclusivity.mjs` pins this across every reachable shape. `resetOrSkip`'s
   retry now gates on `treeDeathConfirmed(e)` directly, never on a negation of `treeDeathUnconfirmed`.
2. **`removeLeakedCanonicalIndexLockIfSafe`** (`git/worktrees.ts`): removes the leaked `.git/index.lock`
   before retrying, but ONLY when (a) the triggering error is confirmed-kill-shaped per (1) above, (b) the
   lock file's own mtime is NOT older than this reset attempt's own wall-clock start (so a long-lived,
   unrelated lock is never touched), and (c) the canonical-index mutex is still held — true BY CONSTRUCTION
   (this is only ever reached from inside `withCanonicalIndexLock`, never otherwise), but this is an
   IN-PROCESS guard ONLY: it excludes a concurrent call from elsewhere in THIS daemon, never a foreign OS
   process (an IDE, a human shell, a second daemon) that never acquires our mutex at all — see the ROUND 3
   section below for the two guards added to actually narrow that gap. Any failed guard skips the retry
   entirely and gives up — a retry against a lock still present fails identically, so there is nothing to
   gain by trying anyway.

Retried AT MOST ONCE, and only after a successful removal. Safe because the content is Loom's OWN squash
output, not unknown pre-existing state (unlike decision `2eddf573`'s entry-time refusal of unknown staged
dirt, which never auto-clears), and because the lock being removed is the SAME confirmed-dead child's own
— never a live process a retry could race. When the guards hold, recovery is now GENUINE: the real retried
reset actually runs and the canonical repo ends up with no residue at all (no `transient` flag set). When
they don't, the give-up text and `worker_merge_confirm`'s tool description both name the leaked
`.git/index.lock` as the likely cause and say plainly that later merges on that repo will refuse at the
entry-time staged-dirt check until a human cleans up.

**C) `mergeBranch`/`mergeBranchLocked`'s return gains `transient?: boolean` and `residuePossible?:
boolean`** (same shape as `mergeMainIntoWorktree`'s own 8c3d6c04 fields), set only when the cleanup gives
up — never alongside `quarantined`, its own separate terminal signal, and never when the guarded retry
above actually succeeds. Threaded through `sessions/service.ts`: `ConfirmMergeResult` gains
`soloMergeTransient?: boolean`; `confirmWorkerMergeTracked` checks `merge.transient` before the generic
rejected fallback (mirrors `union.transient`), rejecting as `"solo_merge_transient"` with a `detailText`
naming the EXACT check an operator needs (`git diff --cached` in the canonical checkout) — never claiming
"nothing was changed" when `residuePossible` is true; `classifyOutcome` gains a `soloMergeTransient` →
`"solo-merge-transient"` branch in the same position as `"union-merge-transient"`; that string is added to
`NEVER_CACHED_OUTCOMES`; `worker_merge_confirm`'s tool description documents it as "A FOURTH DELIBERATE
EXCEPTION" beside the existing quarantine one.

**D) The title-entity path's stale claim (round 2, CR item 4):** the `checkTitleHtmlEntities` refusal
(`mergeBranchLocked`) used to append "canonical repo restored to its pre-merge state" UNCONDITIONALLY,
even when `resetOrSkip`'s own cleanup was skipped/quarantined/transient/failed — i.e. NOT restored. The
content cause (the HTML entity) stays the lead `reason` either way; only the restoration claim is now
conditioned on `cleanup` being `null` (full success).

## Tests

- `merge-confirm-verdict-cache-solo-merge-transient.mjs`: proves the retry-gating fix end-to-end through
  the real `confirmWorkerMergeTracked`, via a `soloMergeGitFactory` and a REAL `.git/index.lock` file on
  disk (never a real kill) across four scenarios: a confirmed kill + a fresh leaked lock (removed, retried,
  genuine recovery — no residue at all); an unrelated non-kill-shaped failure (never retried, any lock left
  untouched); a confirmed kill + a lock PREDATING the attempt (guard refuses, never retried,
  `soloMergeTransient:true`); and an unconfirmed kill (quarantined, never retried, lock untouched). Also
  discriminates the `GIT_OP_TIMEOUT_MS` floor directly (the fake factory receives the actual `blockTimeoutMs`
  argument and the test asserts it equals the floored value, never the small configured `gitOpMs`).
  ⚠️ ROUND 2 relabels round 1's two halves (see the correction above, this was reviewed and found
  mislabeled): (a) is NOT "proof of a historical residue bug" — it only confirms the test's OWN fault
  injection actually left the real squash's staged content in the index, i.e. that the fixture behaves as
  claimed; (b) is NOT "proof a cached verdict used to replay" — it's a REGRESSION GUARD on
  `"solo-merge-transient"` staying in `NEVER_CACHED_OUTCOMES` going forward. RED on `HEAD` (pre-round-2),
  GREEN after, via `pnpm --filter @loom/daemon negative-control`.
- `bounded-git-kill-marker-exclusivity.mjs` (new, round 2): hermetic unit test pinning
  `treeDeathConfirmed`/`treeDeathUnconfirmed` mutual exclusivity across the real give-up marker path (via
  `withTimeoutKillingChild`, no real spawn) and every message-shape-fallback shape, including the exact
  unrelated-failure shape round 1's over-broad gate wrongly treated as a confirmed kill.
- `merge-hang-does-not-wedge-queue.mjs`: the op1/op2 branch selector in scenarios A and B carries a THIRD
  shape — `op1Result?.transient === true` → op2 refused by the entry-time STAGED-DIRT check, never a
  quarantine — keyed on the structural field, never refusal text. `checkOp1Op2QuarantineAgreement` (keyed
  on `op1.quarantined`, 8d8fa497) is unaffected: `transient`/`quarantined` are mutually exclusive. **Round
  2 (CR item 6):** this shape's own check used to claim "refused by the STAGED-DIRT entry check" while only
  asserting "refused, and not by quarantine" — true of ANY other non-quarantine failure too. It now matches
  `STAGED_DIRT_RE`, the exact verbatim prefix `stagedCanonicalDirtRefusalMessage` emits (same regex
  `sessions/service.ts`'s own `isStagedCanonicalRefusal` already uses), structurally proving which refusal
  actually fired rather than merely ruling out quarantine.

## ⚠️ ROUND 3 (delta CR 994e01f4 of round 2's commit 8c445d34)

Round 2's guards (confirmed-kill shape, fresh mtime, mutex held) exclude an IN-PROCESS race but not a
FOREIGN one: an IDE's own git refresh, an owner's manual shell, or a second daemon on the same repo could
create a lock inside round 2's own narrow window and have round 2 delete it out from under a live
operation. Two new guards in `removeLeakedCanonicalIndexLockIfSafe` narrow that gap:

**(1) An upper bound.** The caller (`resetOrSkip`'s catch block) now captures `killConfirmedAt =
Date.now()` FIRST, before calling the removal helper at all — the instant OUR OWN kill was confirmed dead.
A lock whose mtime is newer than that can only belong to a DIFFERENT, still-live git process: our own
child cannot have written it any later than its own confirmed death. Combined with round 2's existing
lower bound (mtime not older than `attemptStartedAt`), the lock must fall inside the EXACT window our own
attempt ran in.

**(2) A persistence check.** Even inside that window, the helper now re-stats the lock after a short,
BOUNDED delay (`LOCK_PERSISTENCE_CHECK_DELAY_MS`, 1.5s) and requires IDENTICAL mtime + size before
removing it. This is a WITNESSED wait, not a disguised fixed one — the delay exists only to give a real,
still-live writer time to finish and rename/rewrite its lock (git renames `index.lock` onto `index` the
instant a real operation completes); the actual proof is the re-stat comparison afterward, not the delay
itself. A lock that changes or disappears during the delay is live, not abandoned, and is left untouched.

**Clock skew (found by this round's own test-writing, not theorized):** `fs.statSync(...).mtimeMs` and
`Date.now()` are NOT the same clock — measured on the dev host, a file's `mtimeMs` can read up to ~2ms
AHEAD of a `Date.now()` sample taken immediately after the write that produced it (and, symmetrically, a
`Date.now()` sample taken immediately BEFORE a write can read ~1-2ms ahead of that write's own mtime).
Without a tolerance, the upper-bound AND lower-bound checks could each spuriously refuse OUR OWN
just-written lock from clock noise alone — not a hypothetical, it reproduced immediately in this round's
own direct unit test before the fix. `LOCK_MTIME_CLOCK_SKEW_TOLERANCE_MS` (50ms, generous over the
measured ~2ms) widens BOTH bounds symmetrically.

**(3) The "no-lock" ruling.** A confirmed kill that left NO lock behind at all has nothing for these guards
to reason about — `reasonCode: "no-lock"` is not a failure of guard (1)/(2), it's the absence of anything
to guard. `resetOrSkip` now retries in this case too: nothing to remove, and the retried `reset --hard`
takes its own lock, so there's no guaranteed-repeat-failure risk the way a present-but-unremovable lock
has. Proven in `merge-confirm-verdict-cache-solo-merge-transient.mjs`'s new `[NO-LOCK]` scenario.

**(4) Give-up wording.** The give-up message is now generated by `describeLockGiveUp`, branching on
`removal.reasonCode` — it never claims "left a leaked .git/index.lock" when the lock has in fact vanished
(the `"disappeared"` case) or was never resolvable (`"unresolved-git-dir"`), and for every "may not be
ours" shape (`predates-attempt`/`postdates-confirmation`/`unstable`) it tells the human to check whether a
git process is still running against the repo before removing the lock by hand.

**(5) `spawnCanonicalGitTree` is now EXPORTED with an injectable `spawnImpl`** (`git/bounded.ts`, default
the real `spawn`) — a test seam reaching the REAL `markConfirmedKill` application site (previously
reachable only via a real kill) hermetically: a fake child whose `pid` is `null` takes the function's own
unconditional-confirm branch with zero real OS process involved. `bounded-git-kill-marker-exclusivity.mjs`'s
`[confirmed marker (real seam, no real spawn)]` case uses it; deleting `markConfirmedKill` from that branch
turns it RED (verified: a manual dist-level revert of that one line reproduced the failure, then was
restored from a pre-edit backup — never committed).

**(6) `treeDeathConfirmed`'s regex guard.** simple-git's OWN `abortPlugin` throws a bare, unprefixed,
unmarked `"Abort signal received"` on ANY caller's own aborted call anywhere (verified against
`node_modules/simple-git/dist/cjs/index.js`) — a completely different, weaker event than this file's own
kill-confirmation. `bounded-git-kill-marker-exclusivity.mjs`'s `[bare simple-git abort message]` case pins
that this bare shape is classified `false` by `treeDeathConfirmed`, since the regex requires the
`(git child killed): ` prefix our own wrapping adds, never just the trailing text. It does NOT (and
cannot) prove every possible future wrapping stays `false` — the real backstop remains tagging the REAL
confirmation site with the typed marker, never growing this regex.

### Round 3 tests

- `bounded-git-lock-removal-guards.mjs` (new): hermetic unit test calling `removeLeakedCanonicalIndexLockIfSafe`
  directly (exported, same precedent as `GIT_OP_TIMEOUT_MS`) against a bare `.git` directory fixture — no
  real git init needed. Covers `no-lock` (fast path, no persistence delay), `predates-attempt`,
  `postdates-confirmation` (the round-3 upper bound, with a 300ms margin — well past the 50ms clock-skew
  tolerance, deliberately so the result isn't noise), `unstable` and `disappeared` (the persistence check,
  each forcing a real filesystem mutation mid-delay via a plain `setTimeout` callback — not an
  `await`-blocking wait, so it's not itself a fixed-wait-adjacent-to-check candidate), and the success path.
  Run 5x clean on this host.
- `merge-confirm-verdict-cache-solo-merge-transient.mjs` gains `[NO-LOCK]`: confirmed-kill with no lock ever
  written — retried anyway, genuine recovery. The existing `[POSITIVE]` scenario now also crosses the new
  persistence delay (adds ~1.5s wall-clock; nothing else about it changes).
- `bounded-git-kill-marker-exclusivity.mjs` gains `[6]` (the real `CONFIRMED_KILL` marker via the
  `spawnCanonicalGitTree` seam) and `[7]` (the bare simple-git abort message guard) — see (5)/(6) above.

## ⚠️ ROUND 4 (delta CR of round 3's commit `6455dd74`)

**(1) `describeLockGiveUp` wording.** The caller's own sentence ("reset --hard (ctx) was confirmed-killed
and " + `describeLockGiveUp(...)`) combined with the old wrapper text ("left"/"briefly held" a lock) to
produce a self-contradiction for 4 of the 7 `reasonCode`s: claiming OUR OWN cleanup left/held a lock in the
same breath as saying that lock "may not be ours", and (for `"disappeared"`) doubling "not our own leaked
lock" against `removal.reason`'s own identical clause. Fixed by making the wrapper ownership-neutral
("found", never "left"/"held") and trimming the now-redundant trailing clauses from the `reason` strings
for `predates-attempt`/`postdates-confirmation`/`unstable`/`disappeared` — the wrapper is now the only place
that states the "may not be ours" conclusion. `describeLockGiveUp` is now exported (same precedent as
`removeLeakedCanonicalIndexLockIfSafe`) so its wording is tested directly, exhaustively, per `reasonCode`.

**(2) Retry-loop regression guard.** The retry gate is `!isRetry && treeDeathConfirmed(e)`; dropping
`!isRetry` would let the RETRY's own confirmed kill re-enter the lock-removal-and-retry branch and loop
instead of giving up after one retry. No test previously drove the RETRY's own attempt into a confirmed
kill (every prior scenario's retry either succeeded or was never reached) — added.

**(3) Doc corrections.** The doc comment's "narrow (b) window" claim was false — window (b) spans the
reset attempt's actual duration (≈ `resetTimeoutMs`, ≥15s at the floor), not narrow; what actually limits
the risk there is git's own `O_EXCL` lock-creation semantics (a second process cannot create the same
`index.lock` while ours exists), and it's guard (c) — the 1.5s persistence check — that genuinely narrows.
Also corrected a Do-not bullet that attributed the round-3 upper-bound/persistence guards to testing — they
came from CR analysis; only the clock-skew tolerance was found by testing (see its own test file).

**(4) Design note — why `"disappeared"` gives up but `"no-lock"` retries.** Both leave nothing to remove,
but they are opposite evidence: `"no-lock"` means nothing ever raced us. `"disappeared"` means something
WAS there and then vanished mid-persistence-check — positive evidence of a still-live foreign process whose
own git operation just completed (git renames `index.lock` onto `index` on completion). Retrying into that
would race whatever that foreign operation does next; giving up is the only safe response to evidence of a
live competitor, whereas no evidence of one at all is exactly the case the round-3 ruling (above) says is
safe to retry into.

## Do not

- Do not give `resetOrSkip`'s cleanup reset the caller's own `timeoutMs` unmodified — floor it at
  `Math.max(timeoutMs, GIT_OP_TIMEOUT_MS)`. No-op whenever the caller's own value is already
  `>= GIT_OP_TIMEOUT_MS` — don't claim it "always" narrows the window; only below 15000ms.
- Do not claim the floor+retry ELIMINATES the residue window — it only narrows it; a loaded host can still
  confirmed-kill the cleanup even at the floor, which is why `transient`/`residuePossible` exist.
- Do not gate the retry on "not quarantined and not unconfirmed" — check `treeDeathConfirmed(e)` directly;
  that negation also matches an unrelated non-kill failure, the exact over-broad gate round 2 replaced.
- Do not retry without first removing a confirmed kill's leaked `.git/index.lock` via
  `removeLeakedCanonicalIndexLockIfSafe`, and do not remove it unless ALL of its guards hold: confirmed-kill
  shape, fresh mtime (not older than the attempt's own start), mutex held by construction, (round 3) the
  mtime also not POSTDATING `killConfirmedAt`, and (round 3) the lock PERSISTS unchanged across the
  witnessed `LOCK_PERSISTENCE_CHECK_DELAY_MS` wait. The upper-bound and persistence guards came from CR
  analysis, not from testing — only the clock-skew tolerance below was found by testing. A retry against a
  lock still present fails identically; an unguarded removal risks deleting a lock that isn't ours.
- Do not retry more than once, even after a successful removal — a quarantine or unconfirmed kill are their
  own, more severe, terminal outcomes and return immediately regardless. The gate is `!isRetry &&
  treeDeathConfirmed(e)` — dropping `!isRetry` lets the RETRY's own confirmed kill re-enter this branch and
  loop (round 4; guarded by the `[ALWAYS-CONFIRMED]` test).
- Do not widen this retry to `resetOrSkip`'s unknown-pre-existing-dirt skip path (`2eddf573`) — that case is
  deliberately NEVER auto-cleared; this retry is safe only because the content is Loom's OWN squash output.
- Do not set `transient`/`residuePossible` alongside `quarantined` (mutually exclusive outcomes of the same
  catch block), and not at all when the guarded retry actually succeeds (genuine recovery, no residue).
- Do not emit "nothing was changed" in the `solo_merge_transient` text when `residuePossible` is true — name
  the exact check (`git diff --cached`), mirroring `union.residuePossible`'s own wording.
- Do not state "canonical repo restored to its pre-merge state" unconditionally in the title-entity refusal
  — only when `resetOrSkip`'s own `cleanup` is `null`; otherwise defer to `cleanup.message`.
- Do not key `merge-hang-does-not-wedge-queue.mjs`'s op1/op2 selector off `op2Result?.ok` or loose refusal
  text — key off op1's own structural `transient` field; if you do check refusal text, match
  `STAGED_DIRT_RE`'s exact verbatim prefix, not merely "not a quarantine".
- Do not restate `NEVER_CACHED_OUTCOMES`'s member list/count outside `orchestration/pending-ops.ts` — read it.
- Do not claim this card's pre-fix shape involved a CACHED verdict — `"squash-refused"` was already
  never-cached; see the round 2 correction above.
- Do not infer "confirmed" from `!treeDeathUnconfirmed(e)` anywhere — it also matches an unrelated non-kill
  failure; state a confirmed-kill shape as matching `treeDeathConfirmed` directly.
- Do not compare a lock's `mtimeMs` against `Date.now()` with a bare `<`/`>` — widen both bounds by
  `LOCK_MTIME_CLOCK_SKEW_TOLERANCE_MS` (found-by-testing: the two clocks measurably disagree by ~1-2ms).
- Do not give up on `reasonCode: "no-lock"` — nothing to remove, so retry anyway.
- Do not treat `"disappeared"` the same as `"no-lock"` even though both leave nothing to remove: a lock that
  EXISTED then vanished mid-persistence-check is positive evidence of a still-live foreign process (so
  `resetOrSkip` gives up); a lock that was NEVER THERE AT ALL is simply nothing having raced us (so it
  retries). Collapsing the two would retry straight into whatever made the first lock disappear.
- Do not phrase `describeLockGiveUp`'s wording (round 4) as "left"/"held" a lock that "may not be ours" —
  the caller's own sentence already says the reset "was confirmed-killed", so claiming we left/held it is a
  direct contradiction; say "found" instead, and never repeat a clause `removal.reason` already states.
- Do not grow `treeDeathConfirmed`'s message-regex fallback to match a bare, unprefixed simple-git
  `abortPlugin` message (fires on ANY aborted call anywhere) — tag the real confirmation site instead.
