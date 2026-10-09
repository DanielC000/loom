# bf58c19c — macOS/POSIX root-creation-time cross-check moves to one clock domain

## Narrative

Card `2897acc4` fixed Linux's creation-time guard (round 4, item 2) to compare boot-relative ticks
captured at spawn against ticks observed at check time — no `Date.now()` on either side, immune to a
wall-clock step. It explicitly left mac/other-POSIX on the OLD shape (`2897acc4`'s own round 7: "Deliberately
NOT applied to mac/other-POSIX" — `87691385`'s win32 capture is win32-only by construction, and routing mac
through it would make guard 2 permanently refuse there). Code Review `9024d16b` (round 5 follow-up of
`2897acc4`) named this as the one remaining defect: `verifyRootDeadOrForceKill`'s mac/POSIX branch
(`pty/host.ts`, now the plain `else` at the bottom of the platform chain) still compares `check.creationTime`
(the OS's own `lstart`, read fresh via `ps` at VERIFY time) against `owner.startedAt` (Loom's own
`Date.now()` at SPAWN time) — two different clocks read at two different instants. An NTP correction or VM
clock step between spawn and check desyncs them for the genuinely-same, still-alive process, producing a
false "mismatch" — `recycleWorker` then proceeds to spawn a successor beside a predecessor that may still be
alive.

## The fix

Mirror win32's own fix (`87691385`/`2897acc4` round 7), not a new mechanism: capture a VERIFIED creation
time at spawn, then compare it against a fresh read of the SAME OS attribute at verify time — never against
`owner.startedAt`.

- **At-spawn capture**: a new single-pid query, `ps -p <pid> -o pid=,ppid=,lstart=`, parsed into the
  existing `OrphanSweepRow` shape (`{pid, ppid, creationTime}`, already generic — imported from
  `win32-root-creation.ts`, not duplicated). Verified via the ALREADY-exported, platform-agnostic
  `resolveVerifiedRootCreationTime` (same function win32 uses): `row.ppid === process.pid` AND
  `row.creationTime <= live.startedAt + slackMs`. `armWin32RootCreationTime` is renamed
  `armRootCreationTime` and now arms on every platform except Linux (which keeps its own tick mechanism);
  `captureRootCreationRow`'s existing seam dispatches to the win32 CIM query or the new POSIX `ps` query by
  platform, so the one test override already in place (`ControllableHost`) covers both for free.
- **At-verify comparison**: the catch-all `else` branch (darwin AND any other non-Linux, non-win32 POSIX —
  same scope the existing buggy code already covered, kept rather than narrowed to a literal `"darwin"`
  check, since the mechanism is equally valid for any `ps`-based POSIX reaching this fallback and narrowing
  would leave a hypothetical other POSIX on the still-defective path for no benefit) compares the verified
  `owner.creationTime` against the fresh `check.creationTime`, exact match
  (`POSIX_CREATION_TIME_MATCH_TOLERANCE_MS = 0`). Either side `null` ⇒ refuse (`identity:"unreadable"`),
  mirroring win32's own null-guard shape; a genuine disagreement ⇒ `identity:"mismatch"`.

## Why exact match is correct here (unlike win32's 1ms)

Win32's `ROOT_CREATION_MATCH_TOLERANCE_MS` (1ms) absorbs a genuine CROSS-source delta: `owner.creationTime`
and `check.creationTime` are read via two DIFFERENT CIM query/conversion shapes (`2897acc4` round 8, item 3).
Here both reads go through the IDENTICAL query shape (`ps -p <pid> -o pid=,ppid=,lstart=` vs. the general
`ps -axwwo pid=,ppid=,lstart=,command=` fallback enumeration — same column, same format) — `lstart` is a
fixed kernel attribute of the process, never re-derived from either side's own `Date.now()`, so two reads of
it for the same still-alive, non-reused pid produce the identical string, hence the identical parsed ms
value. Exact match is therefore the correct tolerance, not an approximation that happens to work.

**This equivalence held only once BOTH reads were forced into the same, deterministic representation:**
`ps` is spawned with `env: {...process.env, TZ: "UTC", LC_ALL: "C"}` for both the single-pid capture and the
general fallback enumeration, and `lstart` is parsed via explicit `Date.UTC(year, monthIdx, day, hh, mm,
ss)` construction (`parsePsLstartTimestamp`) — never `Date.parse` of the bare string, which V8 interprets in
the CALLING process's own local timezone, not the spawned child's `TZ`. Without the forced env, the two
reads could legitimately differ: a bare local-TZ string is ambiguous across a DST transition (a fall-back
hour's wall-clock string can denote either of two real UTC instants) or a host TZ change between the spawn
capture and a later check. With `TZ=UTC`/`LC_ALL=C` and UTC-constructed parsing, `lstart` has no DST and no
locale variance, so "same process ⇒ identical string ⇒ identical ms" genuinely holds.

## The capture-verification slack (1000ms) is NOT the same thing as the comparison tolerance (0ms)

Two different numbers guard two different moments:

- `POSIX_ROOT_CREATION_CAPTURE_SLACK_MS` (1000ms) governs whether the AT-SPAWN capture is trusted at all
  (`resolveVerifiedRootCreationTime`'s `row.creationTime <= startedAt + slackMs` check). `lstart` is only
  SECOND-granular and whether a given `ps` implementation rounds or floors to that second is NOT verified
  here (no macOS host was available while making this fix) — a floor only ever under-reports (always safe
  for a "no later than" check), but a round could over-report by up to ~500ms, which win32's 2ms slack would
  wrongly reject. 1000ms comfortably covers either case. Mistuning this wide only costs more frequent,
  correct-but-unnecessary `identity:"unreadable"` refusals — never a wrong kill.
- `POSIX_CREATION_TIME_MATCH_TOLERANCE_MS` (0ms) governs the AT-VERIFY comparison between two ALREADY-
  VERIFIED-OR-FRESH reads of the exact same attribute — see "why exact match" above.

## The stated residual: same-second pid reuse under the same parent

`lstart` is second-granular. If a pid is freed and reused by the OS, AND the new occupant happens to start
within the same calendar second AND is itself a child of this daemon process (`ppid === process.pid`), the
exact-match comparison (creation time) and the ppid cross-check (added as a follow-up guard — see below)
would both agree by pure coincidence, and `verifyRootDeadOrForceKill` would wrongly treat it as the
predecessor still alive. This is a narrower, rarer version of the general pid-reuse hazard `2897acc4`'s own
guard 1 (`findLiveEntryByPid`) already covers for a LOOM-tracked respawn; the residual here is specifically
an UNTRACKED same-parent child born in the same second. Not closed this round — closing it fully would need
sub-second POSIX process creation time (not available from `ps`/`lstart` on any POSIX system without a
native addon or `/proc`, which is Linux-only and already has its own, finer-grained ticks mechanism). A
future round that wants to close this should look at whether a per-call unique marker (an env var or fd the
spawned root inherits, re-readable from `/proc/<pid>/environ` equivalent) is feasible on POSIX, not at
tightening the second-granular comparison further — it cannot be tightened past what the OS reports.

## Why the whole `else` catch-all, not a literal `"darwin"` check

The `ps -p <pid> -o pid=,ppid=,lstart=` mechanism depends on nothing darwin-specific — `verifyRootDeadOrForceKill`
routes PURELY on `resolveRootReapPlatform()` (ultimately `process.platform`), never on whether an
enumeration actually succeeded, so a Linux host ALWAYS takes the Linux ticks branch regardless of whether
`/proc` itself is reachable — it never falls through to this `else` branch, sandboxed or not. (A Linux host
without `/proc` DOES fall back to the `ps`-based `enumerateProcessesPosixViaPs` for its general
`WorktreeProcess` LISTING, but `verifyRootDeadOrForceKill`'s own platform routing is independent of that —
it would still take the Linux-ticks branch and correctly refuse as "unreadable" there, since the ps fallback
never populates `creationTicks`.) The `else` branch is reached only by a REAL non-Linux, non-win32
`process.platform` — today: darwin, or a hypothetical other BSD-like POSIX. Scoping to literal `"darwin"`
would leave that hypothetical platform on the still-defective `owner.startedAt` comparison for no benefit —
the existing buggy code was never darwin-literal either (it was already the generic `else`).

## Unverified: no macOS host available

Every piece of this fix that depends on real `ps -p <pid> -o pid=,ppid=,lstart=` output/behavior (column
order, whether BSD `ps` rounds or floors `lstart` to the second, whether `-p` + `-o` behaves identically
under `TZ=UTC`/`LC_ALL=C`) is verified only via the pure-function parsers and hermetic, platform-forced
scenarios (`host.platformOverride = "darwin"`) — never against a real macOS process. A real-spawn end-to-end
test (mirroring `pty-root-reap-win32-ticks-real-spawn.mjs`) is included, gated to skip-with-WARN on
non-darwin hosts (same convention that win32 test uses for non-win32) — **it has never actually been run on
a real macOS host as part of this change.** The fail direction if any of these assumptions is wrong is
always toward MORE `identity:"unreadable"` refusals, never toward a wrong kill (every null/parse-failure
path refuses) — but this is a disclosed gap, not a proven one.

**The core premise this whole fix rests on, also unverified**: that darwin's `lstart` is the kernel's own
STORED process-start time (`p_start`, read directly off the process table), never RECOMPUTED from a
boot-time anchor at query time. This fix's entire reasoning — "two reads of the same still-alive pid's
`lstart` are the identical string" — depends on it being a stored, immutable value. If it were instead
recomputed on each `ps` invocation (the way Linux's OLD, now-retired ms-epoch arithmetic recomputed
`creationTime` fresh via `Date.now() - uptime` at every check — see `2897acc4` round 4, item 2, the exact
defect class this whole card family exists to fix), a wall-clock step between the at-spawn capture and the
verify-time read would reproduce the SAME false-mismatch bug this card closes, just one layer down. BSD/
Darwin's `lstart` is understood to be the stored `p_starttime`/`p_start` (a kqueue/sysctl-exposed field, not
derived from boot time + elapsed), consistent with every POSIX `ps` implementation's documented behavior —
but this was never independently confirmed against a real darwin kernel as part of this card.

## Do not

- Do not compare `check.creationTime` (POSIX `ps`'s `lstart`, read fresh at verify time) against
  `owner.startedAt` (Loom's own `Date.now()` at spawn time) for darwin/other non-Linux POSIX — a wall-clock
  step between the two produces a false "mismatch" for the genuinely same, still-alive process. Compare the
  verified at-spawn `owner.creationTime` (captured via `armRootCreationTime`) against the fresh
  `check.creationTime` instead — both are the OS's own `lstart`, no `Date.now()` on either side.
- Do not read a bare `lstart` string with `Date.parse` — it is interpreted in the CALLING process's own
  local timezone, not the spawned `ps` child's `TZ`, and is ambiguous across a DST transition. Always spawn
  `ps` with `TZ=UTC`/`LC_ALL=C` and parse via explicit `Date.UTC(...)` construction
  (`parsePsLstartTimestamp`).
- Do not reuse `ROOT_CREATION_CAPTURE_SLACK_MS` (win32's 2ms) for the POSIX at-spawn capture verification —
  `lstart`'s second granularity (and unknown round-vs-floor behavior) needs `POSIX_ROOT_CREATION_CAPTURE_SLACK_MS`
  (1000ms) instead; reusing the tighter win32 value risks wrongly rejecting a genuine capture.
- Do not reuse `ROOT_CREATION_MATCH_TOLERANCE_MS` (win32's 1ms, for a CROSS-source pair) for the POSIX
  at-verify comparison — both POSIX reads are the SAME source/format once `TZ=UTC`/`LC_ALL=C` is forced, so
  `POSIX_CREATION_TIME_MATCH_TOLERANCE_MS` (0, exact match) is the correct, narrower tolerance.
- Do not narrow the fix to a literal `process.platform === "darwin"` check — apply it to the whole non-Linux,
  non-win32 `else` branch (today's existing scope), since the `ps`-based mechanism has no darwin-specific
  dependency and narrowing would leave any other POSIX on the defective path.
- Do not treat the ppid-equals-`process.pid` cross-check (added alongside the exact-match creationTime
  comparison) as closing the same-second pid-reuse residual completely — it narrows the hazard to "a reused
  pid under the SAME parent, in the same second," it does not eliminate it; see "the stated residual" above.
- Do not claim the real-spawn macOS test (mirroring `pty-root-reap-win32-ticks-real-spawn.mjs`) has been
  verified on real macOS — it has not; no macOS host was available while making this fix. It is gated to
  skip-with-WARN on non-darwin hosts, same convention as the win32 test's own non-win32 skip.
