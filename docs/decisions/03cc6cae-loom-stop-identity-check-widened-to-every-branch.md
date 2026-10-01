# 03cc6cae — `loom stop`'s command-line identity check now runs on every signalling branch

Follow-up from `279c0208` (worker `15383b57`'s triage, confirmed by the lead and separately by reviewer
`679816fc`).

**Scope note (round 5, 2026-10-01):** this card originally also carried a `loom start --detach` /
`daemon-supervisor.mjs --detach` double-start LOCK. That lock has been cut from this branch entirely and
moved to its own design-first card, `4e026f35`, after four review rounds each found a new way to reproduce
a double start against the previous round's fix — see "The start lock moved to its own card" near the end
of this record. Everything else below (the `loom stop` command-line identity check: rounds 1 through 4's
identity-check items, not the lock items) is unaffected and ships on this branch.

## The gap

`279c0208` added `isOurDaemon(rec)` — a command-line identity check — but scoped it to exactly one branch:
the `hook.status === undefined` path, reached only when `POST /internal/shutdown` got no HTTP response at
all. On every OTHER path that can still reach the signal ladder — `hook.status` 200/202 whose
`waitForDown` timed out, 404 (a daemon predating the shutdown hook), or 401 (a rejected credential) — `loom
stop` treated "we got SOME HTTP response on the recorded port" as identity-confirmed and signalled
`rec.pid` unverified.

That's not actually an identity check: a stale pid record whose pid was reused by an unrelated process
that happens to also run an HTTP server on that port (even one that just 404s or 401s everything) passes
every one of those branches and gets `SIGTERM`/`SIGKILL`/`taskkill /T /F`'d exactly like a real wedged
daemon would. `taskkill /T /F` takes the bystander's WHOLE process tree.

## The fix

`isOurDaemon(rec)` now runs once, unconditionally, on every path that can still fall through to the signal
ladder (`stop()`'s `if (!graceful) { … }` block) — not just the port-probe's `timeout` outcome. The
port-probe's own three-way classification (`refused` / `other-error` / `timeout`-or-`answered`) is
unchanged and still runs first, but only to decide whether to probe at all: it is needed exclusively for
the `hook.status === undefined` case, where there's no HTTP response yet to prove anything is listening.
Once any evidence exists that something answers on the recorded port — whether from the hook itself or
from the port probe — `isOurDaemon(rec)` gates the fall-through, every time.

A real wedged or unresponsive daemon's live command line is readable regardless of HTTP responsiveness, and
every pid record this CLI writes carries `entry` (the exact path it was launched with — see `279c0208`'s own
record for that mechanism, unchanged here). So a genuinely wedged daemon never becomes harder to stop; only
a pid recycled into an unrelated process does — **but see "Code Review round 2" below: the match itself is
NOT automatically trivial just because `entry` is present**, which cost a real regression before this
record's second round of fixes.

## This supersedes `279c0208`'s own "Do not"

`279c0208` explicitly prohibited this exact widening, reasoning that it would re-break
`cli-stop-auth.mjs`'s guarded-401 scenario (test (b)), whose stand-in daemon was a bare `node -e <script>`
process with no loom-shaped command line. That reasoning held only as long as the fixture stayed
non-loom-shaped — reversing the prohibition made the fixture need fixing, not the other way round.

**Fixed instead: `cli-stop-auth.mjs`'s stand-in daemon now carries a recorded `entry`.** The stand-in script
is written to a real temp `.mjs` file (rather than passed inline via `node -e`) and spawned as
`node <scriptPath>`; the test's own hand-written `daemon.pid` record sets `entry: scriptPath` for both the
(a) and (b) cases, exactly mirroring what `writeForegroundPidRecord`/`startDetached` do for a real daemon.
`isOurDaemon`'s tier-1 exact-match check then passes because the live command line genuinely contains the
recorded entry path — not because the check was loosened. (b)'s 401-then-hard-kill assertions are otherwise
unchanged.

## Code Review round 2 (reviewer `a16f3209`, commit `5b7a15aa`)

Found a Critical regression in the identity check, plus (not reproduced here — see the lock-scope note
above) two reclaim/lock-duration follow-ups that lived in this same round and have moved to `4e026f35`.

### Critical: a Windows npm cmd-shim broke the recorded-`entry` match

A real foreground daemon launched through the shipped npm global `loom.cmd` shim could no longer be
stopped: `loom stop`/`loom update`/`loom restart` all refused it as "unverified" on the 401/404/
200-202-timeout branches. Root cause, verified by manual repro on the dev host: a cmd-shim's own `%~dp0`
prefix already ends in a path separator, so the shim template's own concatenation (`"%~dp0\target.mjs"`)
DOUBLES that separator in the live command line (`...\\target.mjs`), while `writeForegroundPidRecord`'s
recorded `entry` (`process.argv[1]`, which Node itself reports NORMALIZED) has only one (`...\target.mjs`).
`normalizeCmdlinePath`'s old backslash-to-forward-slash swap never collapsed the doubled run, so
`cmd.includes(entry)` was false for a perfectly real daemon.

**Fix**: `bin/lib/cmdline-identity.mjs` (new, shared — see below) collapses RUNS of separators
(`[\\/]+` → `/`) on both sides before comparing, on every platform (POSIX tolerates `//` as `/` too, so
this is safe there as well), not just swapping backslashes. Regression test:
`cli-stop-cmdshim-separator.mjs` — a REAL `.cmd` shim launches a real stand-in daemon, and the test asserts
(as a sanity check, not just the outcome) that the live command line genuinely carries the doubled
separator before asserting `loom stop` still identifies and stops it. RED-proven against the pre-fix
`normalizeCmdlinePath` (and the pre-item-5 bare-substring match). Windows-only (cmd shims don't exist on
POSIX); a clean no-op skip elsewhere.

### Item 5: anchor the match to an actual argument position

The old tier-1 check was `cmd.includes(entry)` — an ANYWHERE substring. A process whose live command line
merely CONTAINS the recorded entry path somewhere else (an editor with that same file open as one of its
own arguments) would also satisfy it. `cmdlineHasEntryArgument` now splits the command line into real
arguments (honoring double-quoted segments) and requires an EXACT, normalized match against one whole
token — never a substring anywhere. Covered by the existing `cli-stop-pid-identity.mjs`/
`daemon-supervisor-stop-identity.mjs` scenarios (all still pass unchanged) plus the cmd-shim test above,
which exercises both fixes (separator-collapse AND argument-position anchoring) together.

### Item 4: shared module extraction

`bin/lib/cmdline-identity.mjs` is the ONE copy of the identity-matching primitives, imported by BOTH
`bin/loom.mjs` (which ships) and `scripts/daemon-supervisor-stop.mjs` (dev-only, doesn't ship) — packaging
allows this because the WHOLE `bin/` directory is copied wholesale into the npm package
(`scripts/build-npm-package.mjs`), so a `bin/lib/*.mjs` file ships automatically, while `scripts/` can still
reach it at DEV TIME via a relative import, same-repo-checkout. No more duplicated fix sites to drift apart
(exactly what happened to the separator-doubling bug living unfixed in two places before this file
existed).

## Code Review round 4, identity-check items (reviewer-REPRODUCED, delta on 57e24add/fc2021e8)

This round's headline finding (a reproduced start-lock double-win) and its own items 1/3 belong entirely to
the lock and have moved to `4e026f35` — see the scope note at the top. Three items in this same round were
genuine identity-check fixes and ship here:

### Item 2: POSIX space paths broke `isOurDaemon`/`isOurSupervisor`'s recorded-`entry` match

`ps -p N -o command=` does not quote its output at all, so a recorded `entry` containing a space could
never be found as a distinct argument via ANY string-splitting scheme applied to that output — a real
daemon launched from a space-containing path was refused by `loom stop`/`update`/`restart` (fail-safe, but
broken). Fix, in the shared `bin/lib/cmdline-identity.mjs` (`commandLineOf`/`matchesRecordedEntry`):
Linux now reads `/proc/<pid>/cmdline` directly — exact, NUL-separated argv, no reconstruction needed at
all — instead of shelling out to `ps`. Elsewhere on POSIX (no `/proc`, e.g. macOS/BSD), `ps` is still the
only option, so a NEW primitive, `cmdlineHasEntryArgumentBoundary`, accepts a whole-ARGUMENT occurrence by
POSITION on the separator-normalized raw string (preceded by start-of-string or a space, followed by a
space or end-of-string) — still not a bare substring: `/a/b/index.js` does not match a command line
containing only `/a/b/index.jsx` or `/a/b/index.js.bak` (no boundary immediately follows the match in
either). `commandLineOf` now returns `{ raw, argv }` — `argv` populated only when exact (win32's quoted
CommandLine, split by the existing `splitCommandLineTokens`; Linux's `/proc` read) — and
`matchesRecordedEntry` dispatches to the exact per-token match when `argv` is present, else the boundary
match on `raw`, else refuses. `bin/loom.mjs`'s and `scripts/daemon-supervisor-stop.mjs`'s own previously
duplicated `commandLineOf` functions are now deleted in favor of this one shared implementation (closing a
pre-existing small duplication, consistent with this record's own "no duplicated fix sites" posture).

**Round 5 follow-up (this record's own pass):** that same non-`/proc` POSIX `ps` call was still subject to
`ps`'s own output-width truncation — on macOS/BSD, `ps -o command=` truncates a long command line to the
controlling terminal's width even when stdout isn't a terminal, which could silently cut off a long
`entry` path and permanently fail the match for a genuinely-ours daemon. Fixed by adding `-ww` (unlimited
width) to that one `ps` invocation in `bin/lib/cmdline-identity.mjs`'s `commandLineOf` — Linux is
unaffected (it never reaches `ps`; see the `/proc` branch above), and win32 doesn't use `ps` at all.

**Test**: `packages/daemon/test/cmdline-identity-posix.mjs` — function-level (this suite runs on the
owner's Windows host, so there is no live Linux `/proc` or POSIX `ps` to spawn a real stand-in against
here; the real win32 spawn path stays covered end to end by `cli-stop-pid-identity.mjs`/
`cli-stop-cmdshim-separator.mjs`). Covers a space-containing entry matching correctly in BOTH the exact-
argv shape and the boundary-match shape, the `/a/b/index.js` vs `/a/b/index.jsx`/`/a/b/index.js.bak`
negative (plus its positive companion and start/end-of-string edge cases), and `matchesRecordedEntry`'s
own dispatch across all four `{raw, argv}` combinations. The `-ww` flag itself is not exercised by a real
macOS/BSD spawn in this suite (no such host here) — it's a one-line, narrowly-scoped flag addition verified
by direct code read, the same posture this record already uses for a Windows-only fix with no POSIX host
to run it on.

### Item 4: tier 1's match is not position-anchored to "the entry script handed to node"

`matchesRecordedEntry`/`argvHasEntryArgument`/`cmdlineHasEntryArgumentBoundary` confirm `entry` appears as
SOME argument on the pid's command line — not specifically as the script path node was invoked with. A
foreign process that happens to pass the same absolute path as some OTHER argument (`node other.js
<entry>`, or an editor with that file open) would also satisfy tier 1. Anchoring to "the first
non-option argument after the node executable" was considered and rejected: it would need its own
per-shape parsing rules layered on top of the three shapes this file already carries (win32's quoted
CommandLine, Linux's exact `/proc` argv, POSIX's unquoted boundary match), risking a false NEGATIVE
(refusing a genuine daemon whose launcher inserts a flag — or a wrapper's own extra token — before the
entry path) in exchange for closing an already-narrow, practically safe false-positive surface: a pid
record's `entry` is this specific install's own absolute path, not a generic name another process would
plausibly also carry as an argument. **Decision: narrow the doc comment to state what tier 1 actually
guarantees, rather than implement the narrower, riskier anchoring.** `isOurDaemon`'s own doc comment in
`bin/loom.mjs` now says this plainly.

### Item 5: `cli-stop-cmdshim-separator.mjs`'s cleanup left the real stand-in daemon running on failure

`standinProc` is the `cmd.exe` shim WRAPPER (`spawn("cmd.exe", ["/c", shimPath], ...)`); the actual
stand-in daemon is a separate GRANDCHILD node.exe process (its own self-reported `process.pid`, captured
as `info.pid`/`standinInfo.pid`). Windows gives no automatic process-tree kill for a plain `.kill()` on a
non-ancestor-tracked handle, so on an assertion failure (before `loom stop` ever reached it), the real
node.exe stand-in survived as a leaked orphan — the reviewer found one left over from an earlier run.
Fixed: the `finally` block now also kills `standinInfo.pid` directly (guarded by an `isAliveHere` check),
scoped to this exact pid captured at spawn, never a sweep by name or port.

## The start lock moved to its own card (`4e026f35`)

Four review rounds on this branch each reproduced a double start in `bin/lib/start-lock.mjs` against the
previous round's own fix — a worse signal than any individual bug: the SHAPE of the failure (a new TOCTOU
window one layer further in) kept recurring, not just the count. Round 5's own review (the one that
triggered this scope cut) reproduced a fifth: the age-staled reclaim mutex from round 4 is itself defeated
by (1) a live-but-paused holder observed stale after sitting idle past its own staleness window (>10s) —
not dead, just slow; (2) a forward system-clock step, which can age-stale a mutex that is neither slow nor
dead; (3) a window where the mutex file exists but is still empty (read between its `wx`-create and its
content write landing); and (4) an unconditional mutex release in a caller path that does not itself
re-verify it still owns the mutex before releasing it, letting a release meant for one cycle discard a
different, later reclaimer's own in-flight hold.

That is a correctness-primitive problem (file-based mutual exclusion for a slow-starting, crash-prone,
possibly-clock-skewed process), not a bug-fixing problem — the lock needs an OS-released primitive (e.g. an
OS-level file lock/advisory lock held for the process's actual lifetime, released automatically on
process exit including a crash, rather than a `wx`-created marker file an app-level TTL has to guess the
staleness of) designed up front, not patched round over round. `4e026f35` is that design-first card. Until
it lands, `loom start --detach` / `pnpm daemon:stable --detach` have NO lock against a near-simultaneous
double invocation — exactly main's own pre-`03cc6cae` behavior, not a new regression introduced by this
cut.

**Removed from this branch**: `bin/lib/start-lock.mjs`, its three call sites (`bin/loom.mjs`'s
`startDetached`/`startLockPath`/`acquireStartLock`/`releaseStartLock` re-exports, and
`scripts/daemon-supervisor.mjs`'s `--detach` branch), and its dedicated tests
(`packages/daemon/test/cli-start-lock.mjs`, `packages/daemon/test/start-lock-toctou-race.mjs`,
`packages/daemon/test/daemon-supervisor-start-lock-refused.mjs`,
`packages/daemon/test/fixtures/start-lock-pre-round4.mjs`). `bin/loom.mjs`'s `startDetached` readiness wait
is back to its original 30s (it had been raised to 240s specifically to match the lock's required hold
duration — see the superseded "Do not" below — so with the lock gone that reason no longer applies);
`LOOM_TEST_START_READY_MS` is removed with it. `scripts/daemon-supervisor.mjs`'s own 240s readiness wait is
untouched: that one was never lock-related (it's sized for this launch path's own full build, independent
of any lock), and this card never changed it.

**Kept**: `scripts/daemon-supervisor.mjs` still records `entry: thisFile` on its pid-file write — that's an
identity-check fact (so `daemon-supervisor-stop.mjs`'s `isOurSupervisor` can confirm identity by exact
match), unrelated to the lock, and ships with everything else in this record.

## Do not

- Do not re-narrow `isOurDaemon`'s call site back to only the `hook.status === undefined` branch — that
  reopens exactly the "any HTTP response on the recorded port is treated as identity-confirmed" gap this
  record exists to close.
- Do not make a test's stand-in daemon pass this check by loosening `isOurDaemon`/`LEGACY_DAEMON_CMDLINE_RE`
  — fix the fixture to present a genuine recorded `entry` (or a package-anchored legacy-shaped command
  line) instead, the way `cli-stop-auth.mjs` now does. `279c0208`'s own "Do not" on never un-anchoring those
  regexes still stands, untouched by this record.
- Do not drop the port-probe's `refused`/`other-error` classification for the `hook.status === undefined`
  case — it still runs first there, and still short-circuits with no signal at all (refused) or a refusal
  to guess (other-error), exactly as `279c0208` shipped it. Only the fall-through at the end of that branch
  now shares the same `isOurDaemon` gate every other branch uses.
- Do not revert `normalizeCmdlinePath` to a bare backslash-to-slash swap with no separator-run collapse —
  that reopens the Windows npm cmd-shim regression (Code Review round 2) that broke stopping a real
  foreground daemon.
- Do not revert `cmdlineHasEntryArgument` back to an anywhere-substring match (`cmd.includes(entry)`) — an
  unrelated process whose command line merely contains the entry path elsewhere (e.g. an editor with that
  file open) must not satisfy this; match a whole argument token only.
- Do not duplicate `bin/lib/cmdline-identity.mjs` back into `scripts/daemon-supervisor-stop.mjs` — import
  the shared module by relative path; a second copy is exactly how the separator-doubling bug went unfixed
  in one of the two sites before this extraction.
- Do not revert to a bare whitespace split (or `cmd.includes(entry)`) for a POSIX `ps`-shaped raw command
  line — use `cmdlineHasEntryArgumentBoundary` (whole-argument, position-anchored), never a plain split,
  which shatters a space-containing `entry` into bogus tokens and never matches at all.
- Do not make Linux read command lines via `ps` again — `/proc/<pid>/cmdline` gives exact argv with zero
  reconstruction ambiguity; re-introducing a `ps`-based read there reopens the space-path bug for no reason
  (Linux has the exact mechanism available and should always prefer it).
- Do not drop the `-ww` flag from the macOS/BSD `ps` fallback in `commandLineOf` — without it, `ps`'s own
  output-width truncation can silently cut off a long recorded `entry` path and permanently refuse a
  genuinely-ours daemon.
- Do not re-duplicate `commandLineOf` back into `bin/loom.mjs` or `scripts/daemon-supervisor-stop.mjs` —
  it now lives once in `bin/lib/cmdline-identity.mjs`, imported by both.
- Do not reintroduce `bin/lib/start-lock.mjs` (or an equivalent app-level `wx`-marker-file lock) on this
  card — four review rounds each found a new TOCTOU window in that shape; the replacement is being designed
  on `4e026f35` around an OS-released primitive instead. A future fix belongs on that card, not this one.
- ~~Do not shorten `startDetached`'s readiness-wait bound back toward 30s without also reconsidering the
  start-lock hold duration~~ **MOOT as of the scope cut above — there is no lock on this branch to couple
  the readiness wait to, and `startDetached` is back to its original 30s.** If `4e026f35` reintroduces a
  lock, re-derive this coupling fresh against whatever hold-duration semantics that design actually has —
  don't assume 240s still applies.
