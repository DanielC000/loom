# 2b7df434 — a hung `/proc` read no longer pins a new libuv thread per enumeration

## Narrative

Code Review `bc3a1445` on `6d484a46` named a pre-existing (not a regression) gap: `withReapTimeout`
bounds the enumeration SLOT, not the WORK. On POSIX, `enumerateProcessesPosix` reads `/proc/<pid>/*` via
`fs.promises`, which have no timer of their own. A read that hangs (e.g. `cmdline` of a D-state process)
holds a libuv threadpool thread forever — `withReapTimeout` frees the *caller's* slot after
`totalBudgetMs`, but the abandoned inner `Promise.all` keeps running. The next enumeration (from ANY of
`checkRootSurvival`, `reapProcessesRootedInWorktree`, or `attributeProcessesToWorktree` — all three
default to `enumerateProcessesPosix` on POSIX) starts a FRESH `Promise.all` over every pid, hits the same
hung pid, and pins ANOTHER thread. With the default `UV_THREADPOOL_SIZE` of 4, a handful of enumerations
against the same stuck pid exhausts the pool daemon-wide (same class as memory note
`worktree-gc-threadpool-leak`).

`attributeProcessesToWorktree` was not named in the card body but has the identical exposure (same
default enumerator, same `enumerateWithRetry`/`withReapTimeout` wrapping) — covered by this fix with no
extra code since the fix lives inside the shared `enumerateProcessesPosix`.

`reapOrphanedDescendants` and `enumerateProcessesPosixViaPs` (the macOS/no-`/proc` fallback) are NOT
exposed — both spawn a real child process with a self-contained timer that force-kills the helper, never
an uncancellable `fs.promises` read.

## Round 1 (f12af7c3): skip-on-outstanding — CORRECT for a hang, a regression for mere overlap

A module-level `Set<string>` (`posixOutstandingPidReads`) marked a pid "in flight" the instant its read
started, and ANY later enumeration that found a pid already marked skipped it outright, reporting a
synthetic placeholder row instead of starting a second read.

**Round-2 Code Review `bdd12be5` found this was a regression against main.** `Promise.all` marks EVERY
pid "in flight" the instant two enumerations merely OVERLAP in time — not only when one is genuinely
hung. This is routine on a healthy host: `checkRootSurvival` runs up to
`ROOT_REAP_ENUMERATION_CONCURRENCY`-wide, and `reapProcessesRootedInWorktree`/`attributeProcessesToWorktree`
aren't semaphored at all. Measured: 200 healthy pids at 20ms each — a concurrent `checkRootSurvival` came
back `enumerationFailed`, and a concurrent `reapProcessesRootedInWorktree` killed 0 of 200. On Linux this
meant spurious recycle refusals, missed force-kills, false `force-kill-unconfirmed`, and leaked worktree
strays on ANY overlapping enumeration — not just a genuinely hung one.

## Round 2 (111e9fb8): dedupe-and-join, bounded per caller

Replaced the `Set` with `posixInFlightPidReads: Map<string, Promise<PosixPidRecord>>` — the value is the
SHARED in-flight promise for a pid's real read. A caller for a pid already being read (whether it is the
first caller or a later one makes no difference — see below) JOINS that shared promise rather than
starting a second read, racing it against a per-caller bound (round 2's own version of this bound — a
fraction of `timeoutMs`, computed fresh per pid — was itself superseded by round 3 below; the mechanics
described in this section are otherwise unchanged):

- If the shared read settles within that bound, the caller gets the REAL record — however many callers
  join it, ALL of them get real data once it resolves, and the pid's reader was invoked exactly once.
- If the bound fires first (the read is genuinely hung, or merely slower than this caller's own budget),
  the caller gets a conservative `readUnverified:true` placeholder for its own result — the SHARED read
  keeps running unaffected in the background for anyone still waiting on it.
- The map entry is removed the instant the shared read settles, on EITHER outcome (success or rejection)
  — never by a timer/cap. A rejection therefore never poisons a later, fresh attempt (the entry is simply
  gone, so the next caller starts over), and a genuine success frees the pid for the next enumeration to
  read current data rather than something stale.

Because EVERY caller — including the one that happens to start the real read — races the shared promise
against its own bound, no caller can ever block forever on a single pid (a side benefit over round 1,
where the originating caller had no bound of its own at the `enumerateProcessesPosix` level). The
underlying real `fs.promises` call itself still has no timer and may run forever if genuinely hung — that
part is unchanged and is the accepted, pre-existing shape this card's own narrative above describes.

This still bounds total outstanding REAL reads for any one pid at exactly 1, no matter how many callers
join or how many enumerations overlap — satisfying the original card's DoD — while no longer confusing
"merely overlapping" with "genuinely hung."

**Memory bound, disclosed, not closed**: bounded by the count of DISTINCT genuinely-stuck pids over the
daemon's lifetime, not by enumeration-call count. No TTL/cap on a map entry — evicting one while its read
is still genuinely outstanding would let a later call start a SECOND real read for it, defeating the fix.
In the realistic failure mode (one, or a few, D-state processes) this is negligible; a pathological host
with many distinct, never-resolving hung pids over a long uptime would still grow the map slowly, but each
such entry already corresponds to a real, permanently-consumed OS/libuv resource, so the map's own cost
never exceeds that already-real leak.

## Round 3 (re-CR d25075d5): one shared deadline per call, not a fraction per pid

Round 2's `POSIX_DEDUP_JOIN_FRACTION` (0.5) was computed FRESH, per pid, from that pid's own call's
`timeoutMs` — e.g. `timeoutMs * 0.5`. Since every pid in one `Promise.all` starts its own join-wait at
roughly the SAME instant, that fraction effectively became the WHOLE enumeration's own deadline: a
`checkRootSurvival` call (`timeoutMs=5000`) could only ever wait ~2.5s for a joined read to produce real
data, ~4× tighter than main's own prior effective ceiling for "how long a single slow-but-recovering read
gets before this call gives up on it." Under real contention (a loaded host where reads are merely slow,
not hung) this meant MORE false `readUnverified` results than necessary — spurious recycle refusals,
missed force-kills, and leaked worktree strays, the same failure shapes round 1's regression produced, now
from "too impatient" rather than "always skips."

**Fixed**: `enumerateProcessesPosix` computes ONE `deadline` (`Date.now() + timeoutMs`) at its own entry,
before any `await` — shared by every pid it enumerates. Each pid's join-wait now races the REMAINING time
to that SAME deadline (`deadline - Date.now()`, computed fresh per pid to account for any time already
spent, but against the one shared endpoint, never a fresh per-pid duration). This restores the caller's
full `timeoutMs` as the effective ceiling for "does a joined read produce real data," matching the
magnitude the pre-round-2 code implicitly offered via the outer `totalBudgetMs`/`withReapTimeout` wrapper,
while still bounding any ONE pid's real outstanding read count at 1 (round 1's original DoD) and still
never confusing "merely overlapping" with "genuinely hung" (round 2's fix).

Not independently re-measured against a real loaded host as part of this round either; a future round
that wants to tune the deadline further should measure first, per this project's own "re-derive from the
live value" posture, rather than retuning it from assumption again.

## Test seam

`enumerateProcessesPosix` is exported and takes an optional `PosixEnumerationDeps` (`listProcPids`,
`readBootTimeMs`, `readPidRecord`) so a test can simulate one pid's read hanging, rejecting, or resolving
slowly (and others resolving normally) with zero real filesystem access — OS-independent by construction,
so it needs no platform-override mechanism (a real wedged `/proc` read can't be manufactured
safely/portably in CI anyway, and `checkRootSurvival`/`reapProcessesRootedInWorktree`/
`attributeProcessesToWorktree` select their enumerator via a raw `process.platform` check with no override
hook of their own). `packages/daemon/test/pty-posix-enumeration-hung-pid.mjs` covers: two overlapping
enumerations of N healthy pids both getting real data (the round-2 regression repro, RED against f12af7c3,
GREEN after round 2); a genuinely hung pid still yielding `readUnverified` after the bound, with its
reader invoked exactly once across 5 successive calls; the single-pid join-while-outstanding case plus a
negative control (a call after settlement reads fresh again); a rejecting read degrading to
`readUnverified` without poisoning a later attempt; the full lifecycle after an unverified timeout — an
abandoned-but-not-actually-hung read later resolving, the map entry clearing, and a LATER call reading
that pid genuinely fresh (reader invoked exactly twice: once for the abandoned read, once for the fresh
one); and the three consumers' fail-closed handling
(`checkRootSurvival`/`reapProcessesRootedInWorktree`/`attributeProcessesToWorktree`). Every potentially-
hanging call is wrapped in a test-level bounded race so a future regression prints a named FAIL instead of
hanging the whole file or exiting with an opaque code.

## Consumer check (per manager's required checkpoint, re-verified under round 2's field names)

**`checkRootSurvival`'s only consumer is `probeRootSurvival`, called only from `verifyRootDeadOrForceKill`
(pre-kill check and post-kill recheck).** A naive placeholder (`foundAlive:true, identityConfirmed:false`)
would fall through to the "STILL ALIVE but identity NOT confirmed" branch, producing `identity:"mismatch"`.
That DIFFERS from a real enumeration failure's shape (`identity:"unreadable"`, `reason:"check-failed"`) in
a load-bearing way: `recycleWorker` gates `predecessorMightStillBeOurs = verify.identity === "unreadable"
|| (verify.identity === "confirmed" && !verify.dead)` — "mismatch" does NOT trip this guard, so recycle
would PROCEED to spawn a successor into the same worktree believing the predecessor was accounted for, in
exactly the scenario (an unverified read) where the predecessor is most likely to still genuinely be
alive. **Fixed**: `checkRootSurvival` special-cases a `readUnverified` row for the queried pid to return
the byte-identical shape its own `catch` block already returns for a real enumeration failure
(`{foundAlive:false, identityConfirmed:false, enumerationFailed:true, creationTime:null,
creationTicks:null, ppid:null}`), so `verifyRootDeadOrForceKill`'s existing `check.enumerationFailed`
branch handles it unchanged, and `recycleWorker`'s refusal gate fires exactly as it does today.

**`reapProcessesRootedInWorktree`'s 6 call sites** (`sweepWorktreeStrays`, `reapSessionStraysCore` via
`reapWorkerStrays`/`reapSessionStrays`, `confirmWorkerMerge`'s pre-gate sweep, the post-gate-timeout
sweep, `gcWorktreeDir` — the actual worktree-removal chokepoint — and `reclaimStaleWorktreeLeftover`) all
call `reap(...)` inside a `try { await reap(...) } catch { /* best-effort */ }` and never inspect the
resolved value's `enumerationFailed` flag at all — the removal/retain decision is made on OTHER grounds
(nested-repo scan, uncommitted-file state, quarantine, claim checks), never on "the reap returned cleanly
⇒ confirmed nothing left". So no existing caller newly misreads an unverified-pid round as "cleanup
complete" — that assumption simply isn't made today. `skippedUnverifiedPids` is surfaced on the return
value anyway (non-empty array when any pid could not be verified) so the information isn't silently
dropped, and any future caller that DOES want to gate on completeness can.

**Round-3 follow-up: `skippedUnverifiedPids` had no reader anywhere in the repo** — a silent field nobody
looks at is exactly the `shipping-a-detector-is-not-someone-reading-it` shape (project memory), so both
`reapProcessesRootedInWorktree` and `attributeProcessesToWorktree` now also `console.error` once per
cycle when the array is non-empty, mirroring the existing total-failure `catch` block's own logging
convention — a human watching the daemon's log sees this even if nothing in-process ever reads the field.

**`attributeProcessesToWorktree`'s only caller anywhere in the repo is**
**`packages/daemon/scripts/host-attribution-check.mjs`**, a manual, human-run diagnostic that prints the
raw JSON result (`{worktreePath, ...result}`) and makes no automated decision at all. The
`skippedUnverifiedPids` field shows up in that printed output automatically — no script change needed.
(`readWholeBoxLoadPercent`, matching decision `3ab5c540`'s existing caveat that `matched: []` is never
evidence of an idle host/project, already applies to this field by the same logic.)

## Do not

- Do not go back to unconditionally SKIPPING a pid merely because it is "in flight" — two enumerations
  that genuinely overlap in time on a healthy host is routine, not a sign of a hang; that was round 1's
  own regression. Join the shared in-flight promise instead, bounded by this call's own deadline.
- Do not go back to a per-pid FRACTION of `timeoutMs`, computed fresh per pid, as the join bound — since
  every pid in one `Promise.all` starts at roughly the same instant, a fraction acts as the whole call's
  effective deadline (round 2's own regression, ~4× tighter than the caller's real budget). Compute ONE
  `deadline` at entry to `enumerateProcessesPosix`, shared by every pid, and race the REMAINING time to it.
- Do not push a `readUnverified` placeholder conditionally (mirroring the real per-pid "only push if some
  field resolved" rule) — it must be unconditional, or an unverified pid silently vanishes from the
  result, which `checkRootSurvival` would read as "gone".
- Do not let a `readUnverified` row for the pid `checkRootSurvival` was actually asked about fall through
  to the ordinary `foundAlive`/`identityConfirmed` branches — it must produce the SAME shape as a real
  enumeration failure (`enumerationFailed:true`), or `recycleWorker`'s `identity==="unreadable"` refusal
  silently stops covering this one failure mode.
- Do not add a TTL or size cap to `posixInFlightPidReads` while a pid's read is still genuinely
  outstanding — that would let a later caller start a SECOND real read for the same pid, defeating the
  fix. The map already clears correctly (and promptly) on a genuine settlement, success or rejection.
- Do not let a rejected shared read leave a stale entry behind — clear on EITHER settlement, not just
  success, or a later caller would wait out its own join bound against a promise that already rejected,
  then (worse) find the SAME dead entry still there on its next attempt.
- Do not widen this fix to the non-per-pid reads inside `enumerateProcessesPosix` (`readdir("/proc")`,
  `readFile("/proc/uptime")`) — a hang there is a different, rarer, whole-call hazard with no pid key to
  track against; explicitly out of scope for this card (the manager boarded it separately).
- Do not leave `skippedUnverifiedPids` as a silent, unlogged field in `reapProcessesRootedInWorktree`/
  `attributeProcessesToWorktree` — a field nobody in-process reads still needs a loud log line (mirroring
  the existing total-failure `catch` block's own convention) so a human watching the daemon's log can
  actually see it; a field alone is not the same as someone looking at it.
