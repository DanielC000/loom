# 4e026f35 — the detached-start guard uses an OS-released primitive, never a file lock

## Why not a file lock

An earlier attempt (`bin/lib/start-lock.mjs`, never shipped — see decision `03cc6cae`) went through FOUR
Code Review rounds, each reproducing a double start against the previous round's own fix:

- a bare unlink+create reclaim let two reclaimers both win;
- an atomic rename-claim could still clobber a legitimate new owner;
- a dedicated reclaim MUTEX serializing the whole dance still needed its OWN age-based staleness
  judgement (so a crashed reclaimer didn't wedge every future start forever) — and even that mutex was
  reproduced-broken by a paused holder, a forward clock step, and an empty-content window.

The pattern across all four rounds: any design that reclaims a STALE marker races itself one level up, no
matter how many extra layers of mutex wrap it, because "is this marker stale" is itself a judgement call
made under uncertainty.

## The design actually shipped

`bin/lib/start-guard.mjs` has NO reclaim logic at all. The guard target is a kernel object — a Windows
named pipe or a Linux abstract Unix socket — that ceases to exist the instant its holder dies, by ANY
means (clean exit, crash, SIGKILL, power loss). There is nothing left on disk to go stale and nothing to
ever judge: a second acquire attempt either finds the OS still holding the resource (refused,
deterministically) or finds nothing at all (free, deterministically). No age check, no mutex, no reclaim
step exists in that file — that absence is the point, not an oversight.

## Platform support

- **win32**: a named pipe (`\\.\pipe\loom-start-<key>`). A second `.listen()` on the same pipe name while
  the first is held fails `EADDRINUSE`, deterministically. Empirically verified on a real Windows host
  (this card's design checkpoint) including a hard SIGKILL of the holder — the OS released the pipe name
  immediately, with zero sleep needed before a fresh listen succeeded.
- **linux**: an abstract Unix socket (`\0loom-start-<key>` — the leading NUL is what makes it "abstract":
  no backing file, Node >=20.4). Same zero-residual guarantee as the named pipe, by the same mechanism
  (kernel-tracked, released on process death). NOT independently verified on a real Linux host as part of
  this change (the dev host this was built on is Windows) — sourced from Node's documented abstract-socket
  support, not measured.
  - **Residual (round 3, card 4e026f35):** the abstract socket namespace on Linux is scoped PER NETWORK
    NAMESPACE, not host-wide. Two launchers sharing one `LOOM_HOME` (e.g. a bind-mounted volume) but
    running in DIFFERENT network namespaces — separate containers without `--net=host`, for instance —
    each get their own abstract-socket namespace and therefore never contend on the same guard target,
    even though they're targeting the identical real directory. This is the Linux analogue of the macOS
    gap documented above, not a new mutex opportunity — do not add namespace-detection logic here; the
    same "do not reintroduce a staleness/reclaim judgement" ruling applies to any attempt at closing it.
- **darwin AND any other platform**: a DELIBERATE NO-OP (`acquireStartGuard` always resolves
  `{ acquired: true }`, guards nothing). macOS's AF_UNIX has no abstract namespace — the only equivalent
  there is a path-backed socket FILE, which can go stale on a crash exactly like the rejected file-lock
  did, reopening the same class of bug this module exists to avoid. Per the owner's own decision on this
  card: do not reintroduce a staleness judgement anywhere, even a narrower one. The residual on these
  platforms is exactly today's pre-existing behavior (two near-simultaneous launches CAN both spawn) —
  nothing is made worse by this module's absence there, and the daemon's own port bind still prevents two
  daemons from ever actually SERVING.

## Residual: the guard is held by the LAUNCHER, not by its detached child (round 3, card 4e026f35)

Both `scripts/daemon-supervisor.mjs --detach` and `bin/loom.mjs`'s `startDetached` hold the guard for the
entire readiness wait and release it in a `finally` right before the launcher process itself exits —
whether that exit is a normal "ready" return, a build/spawn failure, or the LAUNCHER being killed/timed
out while its already-spawned detached child keeps running independently (`child.unref()`). A launcher
killed or timed out mid-wait therefore releases the guard EARLY: nothing re-acquires it on the detached
child's behalf, so a second `--detach` racing in right after can proceed and spawn its own daemon — which
can then orphan the first supervisor's own pid record (the second launcher's pid-file write overwrites
it) even though the first supervisor's child is still alive and booting.

This is an accepted residual, not a bug to close here: the daemon's own port bind still prevents two
daemons from ever actually SERVING on the same port (the second one's `httpVersionOk` pre-check, or
failing that its own bind attempt, fails once the first is actually up) — the failure mode is an orphaned
pid record and bookkeeping confusion, not two live daemons. Narrowing the window (re-acquiring from the
detached child itself, a heartbeat, a second guard layer) is explicitly OUT OF SCOPE for this card — see
"Do not" below.

**Round 4 addendum:** the same early-release window also means a second `--detach` admitted through it
runs a SECOND, fully concurrent `turbo build` in the SAME checkout (both launches build before probing
readiness) — wasted CPU/IO and a theoretically racy write to the same `dist/` output, on top of the
pid-record orphaning already described above. The lead ruling (residual accepted, no reclaim/
re-acquisition logic) stands unchanged for this consequence too.

## Guard key derivation under a symlinked ancestor (round 3)

`guardKey` hashes `canonicalLoomHome(loomHome)` so two near-simultaneous invocations spelling the SAME
real directory differently (a symlink, a relative path, differing case on win32) land on the identical
guard target. A bare `fs.realpathSync(loomHome)` throws `ENOENT` on a genuinely first-ever `loom start`
(the home dir doesn't exist yet); the naive fallback there — a plain `path.resolve(loomHome)` — does NOT
resolve any symlink in the path's ANCESTOR chain. If an ancestor (e.g. the user's home directory itself,
or a junction) is itself a symlink, a launcher racing before the dir exists and a launcher racing just
after a sibling's own `mkdir` created it would then compute DIFFERENT canonical keys for the SAME real
directory — the dir existing or not is a timing accident, not a property of identity, and must never
change which guard target two callers land on.

Fixed by realpath-ing the NEAREST EXISTING ancestor and appending the remaining (not-yet-created)
segments verbatim: once the leaf directory is later created (an ordinary plain directory, never itself a
symlink) and a caller realpaths the FULL now-existing path, the result is the same string either way.
Covered by `packages/daemon/test/start-guard-symlinked-ancestor-key.mjs` (a real junction/symlinked
ancestor).

## Test-suite process-scan notes

The teardown/safety-net tests for this card (`daemon-supervisor-start-guard-refused.mjs`,
`cli-start-guard-wiring.mjs`) spawn a real launcher subprocess and must prove no live process survives a
regression. Two mechanisms, deliberately layered (`packages/daemon/test/_process-scan.mjs`):

- **Pid-file-based kill (primary).** A command-line substring scan structurally CANNOT see a leaked
  `--detach` grandchild: its argv is just `[thisFile]` (no flags), and its `LOOM_HOME`/`LOOM_PORT` travel
  via ENV, never argv — so on a slow/cold build such a scan finds 0 and reports clean while that tree (and
  its own `turbo build` / eventual `node dist/index.js`) is still alive and building into the gate
  worktree's own `dist`. `watchPidFileAndKill` instead reads the pid-file RECORD the leaked process itself
  writes (its own durable self-identification) and tree-kills that exact pid — argv/env-independent.
  Before killing, it confirms the live command line actually contains the record's own `entry` field
  (same shape as `daemon-supervisor-stop.mjs`'s `isOurSupervisor`) — a pid is just a number the OS can
  recycle, so a dead record's pid may since have been reused by an unrelated process; no `entry`, or no
  match, REFUSES rather than guessing. After the tree-kill, it polls for the target to actually die
  (`waitUntilDead`) and stops there — it deliberately does NOT follow up with any downward
  `ParentProcessId`-chain sweep; see "Round 5 correction: no downward PPID sweep" below.
- **Command-line scan (secondary, cmdline-scoped).** Kept as an EXTRA net for anything the pid-file-based
  kill didn't name, never the primary coverage — and, since the round 5 correction below, also the
  accepted STRAGGLER CHECK for anything a tree-kill's own snapshot might have missed, rather than a
  follow-up sweep trying to catch it. A bare substring match makes a `LOOM_HOME` like `...\.loom` also
  match `...\.loom-worktrees\...` (every worker's own worktree root) — `.loom` is a strict PREFIX of
  `.loom-worktrees`, not a path component on its own. The scan requires a real boundary on the side where
  that hazard lives: the matched substring must be followed by a path separator, a quote, whitespace (an
  ordinary unquoted `--flag value` argument boundary), or the end of the string — via
  `cmdline-identity.mjs`'s `normalizeCmdlinePath` on both sides (so a home spelled with `\` still matches
  a live command line spelled with `/`), case-insensitive on win32 only.

The host enumeration itself (`Get-CimInstance`/`ps`) timed out once under real gate load
(`ENUM_TIMEOUT_MS=8000`) and crashed the test with an unhandled rejection AFTER every assertion had already
passed — the DB inspection block never ran. Raised to 20s, with ONE retry before failing closed; call
sites wrap the scan in `try/catch` and record a labeled `check()` FAIL rather than letting the rejection
propagate, so the DB inspection always still runs (or is explicitly, visibly skipped).

## Round 5 correction: no downward PPID sweep

A follow-up sweep (`killDescendantsReaching`) once existed here: after the initial identity-confirmed
tree-kill, it walked every live process's `ParentProcessId` chain looking for anything still rooted at
the just-killed pid, to catch a grandchild spawned after `taskkill /T`'s own process-tree snapshot. It
was REMOVED entirely — it was never reviewed before landing (an unreviewed scope addition the lead added
on their own), and the delta Code Review found it unsafe to keep in ANY form: on Windows, a process's
`ParentProcessId` is NOT updated when its parent exits, and pids are recycled — so a long-lived, entirely
unrelated process whose ORIGINAL parent died long ago (its pid since reassigned to something else) still
reports that dead pid as its `ParentProcessId` forever. The sweep's "does this pid's ancestor chain reach
the pid we just killed" walk has no way to tell a genuine descendant of THIS kill apart from an unrelated
long-lived process that merely happens to share a long-dead ancestor pid number. The reviewer measured
this directly on a real, ordinary Windows host: 22 live processes reporting a `ParentProcessId` that
belonged to no currently-live process (19 distinct dead pids), including `Explorer.EXE` — a sweep like
this one could tree-kill the user's own desktop shell as collateral from an otherwise-ordinary test
teardown.

What's kept instead: the identity-confirmed tree-kill plus polling `isAlive` to a bound (see "Test-suite
process-scan notes" above), and the cmdline-scoped secondary net as the accepted straggler check. A
straggler that never references the test's own scratch `LOOM_HOME` substring is an accepted, documented
residual of a test-only teardown, not something this module tries to close.

## `start-guard-race.mjs` timing + cleanup choices (round 3 items 2 and 6; round 4 item 4)

- **Scenario A (round 3 item 2).** Racers used to hold the guard for a fixed 500ms (a timed
  self-release) — on a loaded gate host, spawn skew ALONE can exceed 500ms, so a slower racer's own
  `acquireStartGuard` call could land AFTER a faster racer had already released, making `acquiredCount=2`
  a FALSE exclusion failure rather than a real one. Racers now hold FOREVER (killed only by the test) so
  every spawn attempt is GUARANTEED to overlap in time, however skewed the actual spawn/scheduling —
  there is no window left in which "one released before another even tried" can happen.
- **Scenario A (round 4 item 4).** Holding forever means a rejected racer's promise is dangerous: `Promise.all`
  over the racer batch rejects the WHOLE batch the instant any ONE racer's own promise rejects (e.g. a
  worker that exited with no output), losing the `child` handle of every OTHER already-spawned (and
  therefore still-holding-forever) racer — an immortal leaked holder with nothing left to kill it. Fixed
  with `Promise.allSettled` plus a `finally` that kills every racer whose spawn DID fulfil, regardless of
  any sibling's rejection.
- **Scenario B (round 3 item 6).** Used to pause 11s ("past round 4's >10s age-gate defeat window",
  decision `03cc6cae`) before the second attempt — but THIS module has no age gate at all, not even a read
  of the clock (see the module header), so there is no age threshold to exceed in the first place; an 11s
  idle period proves nothing a few seconds doesn't, and it mostly duplicated scenario D's `whileAlive`
  check (an immediate second attempt against a still-alive holder) at ~22s of extra gate time (the
  scenario runs twice: real-module + noop-control). Shortened to a few seconds accordingly — still a
  genuine idle period, nowhere near scenario D's near-zero gap.

## Do not

- Do not add any reclaim/staleness logic to this module, on any platform — including a narrower one
  scoped only to macOS's path-backed socket fallback. That is the exact class of fix this record exists to
  reject; a macOS gap stays an explicitly documented residual, not a mutex.
- Do not widen the `guardTargetFor` platform dispatch to any platform other than `win32`/`linux` without
  first confirming that platform actually has an OS-released primitive with no backing file (not just "it
  has AF_UNIX" — BSD/Solaris/AIX's AF_UNIX has the same backing-file problem as macOS).
- Do not change the `degraded:true` fail-open behavior (an unexpected, non-`EADDRINUSE` listen error) into
  a refusal — the guard is a safety net on top of behavior that already works without it; it must never
  become a new way to brick a legitimate single `loom start` over an exotic sandbox/permission quirk.
- Do not build child re-acquisition (or any other mechanism to keep the guard held on the detached child's
  behalf past its launcher's own exit) — the "Residual" section above is the accepted answer for this
  card; a future card may revisit it, but starting here reopens the same reclaim-logic class this whole
  module exists to avoid (a dead launcher's "I still mean to hold this" intent is itself a staleness
  judgement under a different name).
- Do not add a downward `ParentProcessId`-chain sweep to the test-only process-scan helpers, in ANY
  form — including one narrowed by process creation time or any other scoping. On Windows,
  `ParentProcessId` is not updated when a parent dies and pids are recycled, so such a sweep cannot
  reliably tell a genuine descendant of a just-killed pid apart from an unrelated long-lived process that
  merely shares a long-dead ancestor pid number — see "Round 5 correction: no downward PPID sweep" above
  (measured: 22 live processes under 19 dead PPIDs on an ordinary host, including `Explorer.EXE`). The
  cmdline-scoped secondary scan is the accepted straggler check instead.
