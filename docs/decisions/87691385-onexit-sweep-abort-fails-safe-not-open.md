# 87691385 — the live-root sweep abort fails SAFE (abort by default), never open; a win32 creation-time capture closes the common false-exit case

## Narrative

CR `ac6620bd`'s round-6 review of card `2897acc4` (non-blocking MINOR 1) found that round 6's own live-root
abort in `computeOrphanSweepPlan` — "a LIVE, non-self-referential row at `rootPid` itself aborts the WHOLE
walk" — was built for, and argued for, the POST-KILL sweep only (`verifyRootDeadOrForceKill`'s own call,
which always has a real, probed `rootCreationTime` by the time it reaches a kill). But `computeOrphanSweepPlan`
is shared, and the abort fired unconditionally regardless of whether `rootCreationTime` was ever known — so
it also changed the **onExit** sweep (`reapExitedDescendants` → `sweepOrphanedDescendants(rootPid)`, which
passed no `rootCreationTime` at all, on every call, before this card).

The onExit path hits this far more than the post-kill path: `2897acc4`'s own headline incident was
node-pty's `onExit` firing `intended=false` while the real root process was STILL ALIVE — 2 of 6 real
worker exits, on that incident's own host. In that shape, rootPid was never freed at all (pid reuse is
structurally impossible — the OS can't reuse a pid the original process still holds), so the live row at
`rootPid` is always our own surviving root, never a reused one. Round 6's unconditional abort treated every
one of those as "pid reuse" and silently stopped reaping real orphaned descendants (e.g. a backgrounded
`pnpm dev` server) for the common case, while genuine pid reuse — a root that really died, with the OS
handing the just-freed pid to an unrelated process before the next sweep runs — is comparatively rare.

## The fix: fail-safe, not fail-open

`computeOrphanSweepPlan` now requires **positive evidence** the occupant IS our own surviving root before
proceeding to walk: both `rootCreationTime` and the occupying row's own `creationTime` must be known, AND
agree within `ROOT_CREATION_MATCH_TOLERANCE_MS` (round 2 tightened this from the original draft's
`CREATION_TIME_SLACK_MS` — see below). Every other case — either side unknown, or the occupant's creation
time is outside that tolerance (a later, genuinely different process) — still aborts, exactly as round 6
did unconditionally. This is a deliberate flip from the fix's first draft (which proposed "abort only when
provably reused, otherwise walk") to the opposite default: **abort unless proven safe**, never **walk
unless proven unsafe**. Consequences, each pinned by its own test in `pty-root-reap-identity.mjs`:

- **POSIX keeps round 6's reuse protection, with no regression.** `reapOrphanedDescendants`'s own non-win32
  enumeration is `ps -eo pid,ppid` — no time column, by construction — so a row's `creationTime` is always
  `null` there. "Unknown" always aborts, so POSIX behaves exactly as round 6 left it: no new exposure.
- **A win32 CIM read anomaly (an unreadable `CreationDate` for one row) aborts too — under-kill, the safe
  side** — the same posture `verifyRootDeadOrForceKill`'s own M3 guard already takes for an analogous
  anomaly (round 3 of `2897acc4`).
- **The common win32 false-exit case is fixed**: once `rootCreationTime` is a real, captured value (see
  below) and the occupant is genuinely our own root, both sides agree within slack and the walk proceeds,
  reaping real descendants exactly as it did before round 6 existed.

## Capturing the root's own OS creation time — never `startedAt`

The first draft of this fix proposed threading `Live.startedAt`/`CodexLive.startedAt` (`Date.now()`,
captured in Loom's own process at the moment `spawn()`/`spawnCodex()` runs) into the onExit sweep as
`rootCreationTime`. Rejected: `spawn()` latency on the owner's own host was measured at 10–950ms under load
(card `758486bc`), so the real root's OS-reported creation time can sit well after `startedAt` — a
genuinely-ours root could then disagree with its own occupant row by more than the 5s slack, and comparing
two different wall-clock sources (ours at spawn time, the OS's at sweep time) crosses clock domains the
same way round 4's own Linux ms-epoch retirement (`2897acc4`) found unsafe for an analogous comparison.

Instead: `Live`/`CodexLive` gained a new `creationTime: number | null` field, populated asynchronously,
fire-and-forget, shortly after spawn (`armWin32RootCreationTime`, mirroring `armLinuxStartTicks`'s own
shape) — via the SAME win32 CIM query + `parseWin32SweepTicks` conversion the onExit sweep's own rows use,
so a later comparison is apples-to-apples against the identical OS source, never two different CIM queries'
own rounding. Win32-only (gated on `process.platform === "win32"`, same as `armLinuxStartTicks`'s own Linux
gate); `null` on any failure, including the pid not yet showing up in a fast-enough snapshot — never a
guess. `reapExitedDescendants` threads `liveRef.creationTime` into `this.sweepOrphanedDescendants(rootPid,
...)` unconditionally; a shell/canned `Live` entry is never armed (mirrors `startTicksLinux`'s own
convention) and stays `null` forever, which is correct — neither kind is a `verifyRootDeadOrForceKill`
target anyway. **Round 2 replaced the capture's own trust model entirely — see below.**

## Round 2 (Code Review 376c51de): a capture race, an over-wide tolerance, a cheaper query, a nitpick

**Item 1 (CRITICAL) — the capture itself could be racing a pid reuse.** `armWin32RootCreationTime` ran
shortly after spawn but asynchronously, and node-pty's own `conpty.cc` closes `hShell` — freeing the pid —
*before* JS ever observes the `'exit'` event, which `windowsPtyAgent` itself further delays by
`FLUSH_DATA_INTERVAL` (≥1s). So a root that died (and got its pid reused) in that window could have its
capture silently record the REUSED process's own creation time instead of the real root's — and the onExit
sweep would then treat that reused process's own real descendants as "ours" and walk/kill them. This is a
genuinely NEW kill-exposure the first draft introduced, not merely a correctness nit.

**Fix: `resolveVerifiedRootCreationTime(row, expectedPpid, startedAt, slackMs)`**, a new pure, exported
predicate. A captured row is trusted ONLY when BOTH hold:
- `row.ppid === expectedPpid` (the daemon's own `process.pid`) — **verified empirically first**, per the
  CR's own instruction, via a real `node-pty` conpty spawn on this host: a genuine root's CIM-reported
  `ParentProcessId` IS the daemon process directly, never an intermediary (`conhost.exe`/`OpenConsole.exe`).
- `row.creationTime <= startedAt + ROOT_CREATION_CAPTURE_SLACK_MS` (default 50ms) — the genuine root's OS
  creation time precedes our own `startedAt` stamp (production spawns the real process FIRST, then stamps
  `startedAt` — see `PtyHost.spawn()`'s own ordering); any reuser is necessarily LATER. The real end-to-end
  test (`pty-root-reap-win32-ticks-real-spawn.mjs`) caught a genuine ordering bug in its OWN first draft —
  it stamped `startedAt` BEFORE calling `spawnPty(...)`, the reverse of production's real order, which made
  the genuine root fail its own slack check. Fixed by matching production's exact ordering; a pure unit
  test alone (with fabricated timestamps) could never have caught this — only the real spawn did.

Returns the creationTime only when BOTH checks pass, else `null` — `armWin32RootCreationTime` never trusts
a row partially. Unit-tested (`pty-root-reap-identity.mjs`, pure): a reused row (later creationTime) → null;
wrong ppid → null; unknown row/creationTime → null; the genuine root → the value, at and inside the slack
boundary. Each of the two guard clauses proven independently load-bearing via a "skip one check" RED proof
on the built `dist/pty/host.js` (sha256-snapshotted and restored after each).

**Item 2 (MAJOR) — the live-root-abort agreement check used the wrong, over-wide slack.** The original
draft reused `CREATION_TIME_SLACK_MS` (5s — a cross-source margin, defined for comparing TWO DIFFERENT CIM
query shapes in `verifyRootDeadOrForceKill`'s own guard 2). But the abort's own comparison is between TWO
READS OF THE SAME FIXED OS ATTRIBUTE via the SAME query + conversion (captured once at spawn, re-read by the
sweep) — never two different clock sources. The reviewer measured maxΔ=0ms across 473 real pids read this
way. **Fixed:** a new, dedicated `ROOT_CREATION_MATCH_TOLERANCE_MS` (default 1ms, absorbing only
`Math.round`'s own rounding) replaces `CREATION_TIME_SLACK_MS` in `computeOrphanSweepPlan`'s own comparison.
A new test (`pty-root-reap-identity.mjs`, "root+1000ms") pins an occupant 1000ms later as still aborting —
well within the OLD 5s slack (which would have wrongly accepted it), but correctly rejected under the new
tight tolerance. Proven load-bearing by reverting the comparison to `CREATION_TIME_SLACK_MS` in `dist` (a
"revert the fix" RED proof, same convention as round 6's own UTC-conversion fix) — exactly the boundary and
root+1000ms tests went red, restored and sha256-verified after.

**Item 3 (minor) — the capture used a full-table CIM scan.** `armWin32RootCreationTime` originally called
the existing `enumerateWin32SweepRows()` (every process on the host) and filtered client-side for one pid —
expensive at scale (N resumes each paying a full `Win32_Process` enumeration) and widens the capture window
itself (more OS/PowerShell work between the query firing and the answer landing is more time for the pid to
be freed+reused underneath it). **Fixed:** a new `enumerateWin32SweepRowForPid(pid)`, using a FILTERED CIM
query (`-Filter "ProcessId=<pid>"`), sharing the same `ForEach-Object` conversion body
(`WIN32_SWEEP_FOREACH_BODY`) as the full sweep — one source, never a hand-copied duplicate.

**Item 4 (nitpick) — `pty-root-reap-identity.mjs`'s `WiringHost.reapExitedDescendants` pass-through override**
now carries its own one-line comment stating it is safe only because `sweepOrphanedDescendants` /
`probeRootSurvival` (declared alongside it) are stubbed — not merely implied by the surrounding block
comment.

## Round 3 (Code Review f89d9552): no wiring test for the capture, a shared-fixture cost, two tightenings

**MAJOR — round 2's production logic was verified sound, but `armWin32RootCreationTime` itself had NO
test, and that gap was real.** Round 2's own tests (`resolveVerifiedRootCreationTime`'s pure unit tests,
and the real win32 spawn test) both called the predicate/enumerator DIRECTLY — never `armWin32RootCreationTime`
itself. The reviewer's own mutation (M3 — bypass the predicate entirely: `live.creationTime = row?.creationTime
?? null`) left every test in this file green, silently reopening round 1's CRITICAL kill-exposure with no
test anywhere to notice.

**Fix: the capture's own OS query now sits behind a protected seam, `captureRootCreationRow(pid)`** —
exactly the same injectable-seam pattern as `probeRootSurvival`/`sweepOrphanedDescendants`, defaulting to
the real `enumerateWin32SweepRowForPid(pid)`. `armWin32RootCreationTime` itself became a private `PtyHost`
instance method (previously a free function) that calls `this.captureRootCreationRow(...)`, never the free
function directly — so a test can drive the real `spawn()` path with a FABRICATED row per scenario,
without ever launching a real `powershell.exe`. Three new behavioural tests in `pty-root-reap-identity.mjs`,
each going through the REAL claude `spawn()` call (a `createSeamHost(PtyHost)` subclass overriding only
`captureRootCreationRow`, never `armWin32RootCreationTime` itself): a wrong-ppid row → `live.creationTime
=== null`; a row later than `startedAt + slackMs` → `null`; a genuine row → stored. All three (well, the
two rejecting ones — the genuine-row case is indistinguishable under M3, see below) reproduced the
reviewer's own M3 finding exactly: reverting `armWin32RootCreationTime` to the bypass turned exactly the
wrong-ppid and too-late tests red, while the genuine-row test stayed green (a bypassed predicate happens
to produce the SAME result as the correct one for an already-genuine row) — restored and sha256-verified
after. **These three tests drove ONLY the claude `spawn()` path — round 3's own text here overclaimed
`spawnCodex()` coverage too; round 4, below, closes that gap for real.**

**MINOR 2 — the shared test fixture (`test/_seam-host-fixture.mjs`, ~354 consumers) was paying for this
on every spawn.** `createSeamHost(PtyHost)` didn't override the new seam, so every hermetic test spawning
through it launched a REAL `powershell.exe` CIM query (measured 600-920ms) on win32. Fixed: added
`async captureRootCreationRow(_pid) { return null; }` to the shared fixture, mirroring `probeRootSurvival`'s
own no-op. Measured (this session, `kickoff-readiness-fallback.mjs`, 13 real spawns through this fixture):
10.974s before the stub, 6.170s after — a ~44% reduction for this one file.

**Scope decision: `pty-subclass-reap-seam-guard.mjs`'s `REQUIRED_OVERRIDES` was NOT widened to include
`captureRootCreationRow`.** That guard requires every bare `extends PtyHost` test subclass (outside its
own small exemption list) to override `reapExitedDescendants`/`probeRootSurvival`; ~63 test files define
their own such subclass independently of the shared fixture (`grep -rln "extends PtyHost\b" test/*.mjs`,
excluding `createSeamHost` consumers). Those files pay the SAME real-query cost this item fixes for the
354-file shared-fixture population, and the guard's own stated purpose (structurally preventing a real OS
enumeration during a hermetic test) applies to them too. The CR's own MINOR 2 scoped the fix to the shared
fixture by name; widening the guard would force an edit to all ~63 of those unrelated files, well beyond
this card's scope. **Named here as an explicit, accepted residual** — not closed by this card.

**MINOR 3a — the most reachable reuse shape: our OWN diagnostic helper could BE the reused pid.** Between
deciding to query `pid` and our `powershell.exe` helper actually running, the OS could free `pid` and hand
it straight to that SAME helper process — the CIM query would then find only itself, a row whose `ppid`
(the daemon) and `creationTime` (essentially now) would otherwise sail through BOTH of
`resolveVerifiedRootCreationTime`'s checks. Fixed: `enumerateWin32SweepRowForPid` now checks
`isHelperPidCollision(cmd.pid, pid)` — a new pure, exported predicate — immediately after spawning the
helper, and bails to `null` (killing the helper) on a match. **Tested as the pure predicate directly**
(collision → true; a different helper pid → false) — a real collision cannot be forced deterministically
(neither this card nor a test controls what pid the OS assigns a freshly spawned helper), so the WIRING of
this specific check (that `enumerateWin32SweepRowForPid` actually reaches it, vs. the predicate merely
existing) is NOT independently proven the way items 1-2 above are; the happy (non-colliding) path is
exercised implicitly by every passing real-spawn test in this file. **Accepted, narrowed residual:** this
closes the single MOST REACHABLE reuse shape the reviewer named, not every conceivable one — a sufficiently
adversarial, lower-probability pid-reuse sequence elsewhere in the capture's own window is not structurally
ruled out by this check alone, same accepted-residual posture as `dbbb52db`'s own TOCTOU note.

**MINOR 3b — `ROOT_CREATION_CAPTURE_SLACK_MS` shrunk from 50ms to 2ms.** `CreateProcess` returns before
`startedAt` is ever stamped, so the genuine root's own OS creation time is ALWAYS `<= startedAt`; 50ms was
never a real margin, only an overcautious guess. 2ms (the new default) absorbs rounding only. Tested: the
real win32 spawn test (`pty-root-reap-win32-ticks-real-spawn.mjs`) already exercises this live — it passed
cleanly at both 50ms and 2ms on this host, confirming the claim empirically (the real margin measured well
under 2ms in every run); the pure boundary tests in `pty-root-reap-identity.mjs` read the live exported
constant, so they automatically re-pin whatever value ships.

## Round 4 (Code Review f8d7c90a): the codex spawn path was never actually exercised

Round 3's own text (above) claimed its three behavioural tests drove "the real `spawn()`/`spawnCodex()`
path" — false: all three only ever called `host.spawn(...)` on a CLAUDE-shaped `opts` (no `harness:
"codex"`), so only the claude dispatch inside `spawn()` ever ran. The reviewer proved this concretely:
removing `this.armWin32RootCreationTime(live)` at the CODEX spawn call site (`spawnCodex`'s own body)
left every existing test in this file green.

**Fix: a 4th behavioural scenario, (u), reusing `pty-root-reap-call-site-wiring.mjs`'s own fake-codex-pty
shape** (`createCodexPty` returning a fixed-range fake pid, inert `write`/`onExit`) on the SAME
`CaptureRowHost` from round 3 — `captureRootCreationRow` needs no harness-specific logic, since
`armWin32RootCreationTime` is called identically from both the claude and codex spawn bodies. (u) spawns
via `host.spawn({...,  harness: "codex", startupPrompt: undefined})`, a genuine row, and asserts
`live.creationTime` is stored. Proven load-bearing exactly as the reviewer predicted: removing
`this.armWin32RootCreationTime(live)` at the codex call site in `dist` turned ONLY (u)'s two checks red
— every other scenario in this file (including (r)/(s)/(t), the claude-path tests) stayed green —
restored and sha256-verified after.

**Round 3's own narrative text is corrected in place above** (the "drive the real `spawn()`/`spawnCodex()`
path" claim is now true because of (u), not because it ever was before this round) — this is the
precise wording fix the reviewer asked for, not a new claim invented to satisfy it.

## The LEAD's residual (gen 408 triage note) is OUT OF SCOPE here

The triage note attached to this card named a related residual from CR `470e2d22` (review of `dbbb52db`):
a DEAD REGISTERED root (as in `pty-root-reap-test-tripwire` scenario (B) and `dev-server-teardown.mjs`) is
accepted and swept with `rootCreationTime=null`, so a stale-ppid child left by an EARLIER owner of that pid
number is not filtered by `computeOrphanSweepPlan`'s own creation-time filter (the round-5 item-3
mechanism, separate from this card's abort). The manager's own ruling on pickup: this card's fix does
**not** close that residual — the roots in question are ones a TEST registers and passes DIRECTLY to
`reapOrphanedDescendants`/`sweepOrphanedDescendants`, never a `Live`/`CodexLive` object that flows through
`reapExitedDescendants`, so threading `liveRef.creationTime` through the onExit call site never reaches
them. Left for its own card. The capture mechanism built here (`armWin32RootCreationTime`,
`enumerateWin32SweepRows`-based, win32-only) COULD plausibly be reused there too — e.g. by having the test
registry itself record a captured creation time at registration — but that is a design choice for whoever
picks up that residual, not decided or built by this card.

## Round 5 (card 64d7a914): the capture gets a SECOND consumer — `verifyRootDeadOrForceKill`'s own guard 2

This card's `live.creationTime`/`CodexLive.creationTime` capture was built for exactly ONE consumer —
`computeOrphanSweepPlan`'s live-root-abort check. Card `64d7a914` (see `2897acc4`'s own record, rounds 7-8,
for the full mechanism) adds a second: `verifyRootDeadOrForceKill`'s guard 2, win32-only, retiring that
branch's prior cross-source `CREATION_TIME_SLACK_MS` comparison against `owner.startedAt` in favor of a
DIFFERENT cross-source pairing against this card's own capture (round 2 of the card's review corrected an
early draft's "same-source" framing — `2897acc4`'s own `ROOT_CREATION_MATCH_TOLERANCE_MS` doc has the real
measurement). Two consequences for THIS record specifically:

- `Live`/`CodexLive` gained a sibling field, `creationTimeReady: Promise<void>` — resolves once
  `creationTime` settles, never rejects; a pre-resolved stub everywhere except the real win32
  `armWin32RootCreationTime` path, which replaces it with the real in-flight chain. Guard 2 awaits this
  (bounded) BEFORE ever probing the occupant — not at guard-2 entry, which left a real TOCTOU window
  between the probe and the kill (`2897acc4`'s own record, round 8) — closing a timing gap THIS card's own
  abort check never had to worry about (an onExit sweep runs well after spawn by construction; a
  hard-kill's guard 2 can run very soon after it).
- The shared `createSeamHost` fixture's `captureRootCreationRow` no-op (round 3, MINOR 2) now ALSO
  determines every seam-hosted spawn's `live.creationTime` for guard-2 purposes, not just the sweep's — a
  test exercising guard 2's new win32 branch through a real `spawn()` call needs its own
  `captureRootCreationRow` override (never a direct post-spawn write to `live.creationTime`, which races
  the real arm's pending `.then()`), same requirement this card's own (r)/(s)/(t)/(u) scenarios already had.

## Round 6 (card 64d7a914, CR 33ae2f8a round 2): capture failures were silent

`armWin32RootCreationTime` left `live.creationTime` null on EITHER a rejected promise OR a row that failed
`resolveVerifiedRootCreationTime`'s own verification (wrong ppid, or too late), with nothing logged either
way — a silent null here now also feeds guard 2's own `"owner-creation-time-unavailable"` refusal
(`2897acc4`'s record, round 8), with no way to tell a genuine capture failure from a row the OS simply
never produced. Fixed: both paths log once, under a new fixed, greppable `[pty-reap-capture]` tag, naming
the pid and — for the unverified case — which check failed (no row / ppid mismatch / too late), or the
exception message for a genuine rejection. This card's own (r)/(s) scenarios (a wrong-ppid row; a row later
than `startedAt+slack`) now also exercise this logging path directly.

## Do not

- Do not use `Live.startedAt`/`CodexLive.startedAt` as `computeOrphanSweepPlan`'s `rootCreationTime` — it
  is `Date.now()` at the moment Loom's own `spawn()` call runs, not the OS's own creation timestamp;
  measured spawn latency (10–950ms under load, card `758486bc`) and a wall-clock step can both desync it
  from the value the sweep's own enumeration reports for the same pid.
- Do not flip `computeOrphanSweepPlan`'s abort to "walk unless provably reused" — the correct default is
  "abort unless positively proven to be our own surviving root" (both creation times known, agreeing
  within `ROOT_CREATION_MATCH_TOLERANCE_MS`); every unknown case must still abort, exactly as round 6 did
  unconditionally, so POSIX's existing reuse protection never regresses.
- Do not compare `rootCreationTime` against the occupying row's own `creationTime` with a one-directional
  check (`occupant > root + slack`) — use a symmetric agreement check (`Math.abs(diff) <= tolerance`); the
  two values are meant to represent the SAME instant for a genuinely-ours root, not merely "not later than".
- Do not drop the second argument to `sweepOrphanedDescendants` at the `reapExitedDescendants` call site —
  a dropped argument silently reads back as the default `null`, re-widening every onExit sweep back to
  "rootCreationTime always unknown" (the exact defect this card fixes). `pty-root-reap-identity.mjs`'s own
  "(onExit wiring)" test pins this; a stricter positive-proof test (never a weakened one) is how to prove
  it load-bearing.
- Do not arm `armWin32RootCreationTime` for a shell/canned `Live` entry — neither is ever a
  `verifyRootDeadOrForceKill` target (mirrors `startTicksLinux`'s own convention); its `creationTime` stays
  permanently `null` by design, not an oversight.
- Do not treat this card as closing the LEAD's gen-408 residual (a dead REGISTERED root, as tested
  directly against `reapOrphanedDescendants`, swept with `rootCreationTime=null`) — that root never flows
  through `reapExitedDescendants`/`Live.creationTime` at all; it needs its own card.
- (Round 2) Do not ever let `armWin32RootCreationTime`/`live.creationTime` trust a captured row that hasn't
  passed `resolveVerifiedRootCreationTime` — an unverified capture is a genuinely NEW kill-exposure (the pid
  can be freed-and-reused in the ≥1s window between a root's real death and node-pty's own delayed `'exit'`
  event), not a correctness nit. Both of the predicate's guard clauses (`ppid` match, `creationTime` no
  later than `startedAt + slackMs`) are independently required — do not merge them into one combined
  condition, and do not accept a row on either check alone.
- (Round 2) Do not widen `ROOT_CREATION_MATCH_TOLERANCE_MS` back toward `CREATION_TIME_SLACK_MS` (5s) — the
  live-root-abort comparison reads the SAME OS attribute via the SAME query/conversion twice (measured
  maxΔ=0ms/473 pids); `CREATION_TIME_SLACK_MS` is for a DIFFERENT comparison (two different CIM query
  shapes in `verifyRootDeadOrForceKill`'s guard 2) and reusing it here was the round-1 draft's own mistake.
- (Round 2) Do not capture the at-spawn root creation time via a full `Win32_Process` table scan
  (`enumerateWin32SweepRows`) — use the filtered single-pid `enumerateWin32SweepRowForPid`; a full scan
  both costs more per spawn and widens the exact capture-race window item 1 above exists to shrink.
- (Round 2) Do not stamp a real-spawn test's own `startedAt` BEFORE the real spawn call — production spawns
  the OS process FIRST, then stamps `startedAt` (`PtyHost.spawn()`'s own real ordering); a test that gets
  this backwards will see the genuine root fail its own slack check, exactly the way this card's own first
  draft of `pty-root-reap-win32-ticks-real-spawn.mjs` did until corrected.
- (Round 3) Do not call `enumerateWin32SweepRowForPid` directly from `armWin32RootCreationTime` (or any
  other call site) — route it through the protected `captureRootCreationRow(pid)` seam. Calling the free
  function directly is EXACTLY the shape that let a predicate-bypassing mutation (M3: `live.creationTime =
  row?.creationTime ?? null`) ship with every existing test green — nothing could drive a fabricated row
  through `armWin32RootCreationTime`'s own real `spawn()` path without the seam.
- (Round 3) Do not test `armWin32RootCreationTime`'s wiring by calling `resolveVerifiedRootCreationTime`/
  `enumerateWin32SweepRowForPid` directly — that proves the PREDICATE works, never that
  `armWin32RootCreationTime` actually CALLS it rather than bypassing it (the exact gap CR `f89d9552` found).
  Drive it through the REAL `spawn()`/`spawnCodex()` path, with `captureRootCreationRow` overridden to
  return a controlled, fabricated row — see `pty-root-reap-identity.mjs`'s (r)/(s)/(t) scenarios (claude)
  and (u) (codex, round 4).
- (Round 3) Do not let `test/_seam-host-fixture.mjs`'s shared `createSeamHost(PtyHost)` go without a
  `captureRootCreationRow` no-op override — every one of its ~354 consumers would otherwise pay a real
  `powershell.exe` CIM query (600-920ms) on every single spawn, on win32, regardless of what that test
  is actually about.
- (Round 3) Do not read the `isHelperPidCollision` fix as closing the capture-race completely — it closes
  the single MOST REACHABLE reuse shape (our own helper inheriting the just-freed pid), not every
  conceivable reuse sequence in the capture's own window; treat this as an accepted, narrowed residual,
  not a proof of impossibility.
- (Round 3) Do not widen `ROOT_CREATION_CAPTURE_SLACK_MS` back toward 50ms (or beyond rounding margin) —
  `CreateProcess` returns before `startedAt` is ever stamped, so the genuine root's own creation time is
  ALWAYS `<= startedAt`; a wider slack was never a real margin, only an untested guess the round-3 review
  corrected.
- (Round 3) Do not widen `pty-subclass-reap-seam-guard.mjs`'s `REQUIRED_OVERRIDES` to include
  `captureRootCreationRow` as part of THIS card — doing so would force an edit across ~63 unrelated test
  files that define their own bare `extends PtyHost` subclass outside the shared fixture; that residual is
  named explicitly above, not silently left for a future reader to rediscover, and is a deliberate scope
  decision, not an oversight.
- (Round 4) Do not assume the claude-path tests ((r)/(s)/(t)) also cover the codex spawn dispatch —
  `armWin32RootCreationTime` is called from BOTH `spawn()`'s claude body and its codex body independently;
  removing the call at ONE site leaves the OTHER site's own tests green. A behavioural test exercising this
  wiring must actually spawn through the harness it claims to cover (`harness: "codex"` for the codex
  site), never infer coverage from the sibling path.
- (Round 4) Do not describe a test's coverage in this record more broadly than what it actually spawns —
  round 3's own "drives the real `spawn()`/`spawnCodex()` path" text was written before any codex-path
  test existed; a narrative claim here is only as true as the code it describes, and goes stale exactly
  like inline source comments do.
- (Round 5) Do not assume `captureRootCreationRow`'s no-op in the shared `createSeamHost` fixture only
  affects `computeOrphanSweepPlan`'s own abort check — it now ALSO determines what `verifyRootDeadOrForceKill`'s
  win32 guard-2 branch sees for any seam-hosted spawn (card `64d7a914`); a test exercising that branch needs
  its own override, same as this card's own (r)/(s)/(t)/(u) scenarios.
- (Round 5) Do not write `live.creationTime` directly after a real `spawn()` call as a test shortcut — it
  races `armWin32RootCreationTime`'s own pending `.then()` and gets silently overwritten back to whatever
  the real capture resolves to; override `captureRootCreationRow` on the test's own PtyHost subclass so the
  value flows through the real arm mechanism instead.
- (Round 6) Do not leave a capture failure (a rejected promise, or a row that failed
  `resolveVerifiedRootCreationTime`'s own verification) unlogged — log once, under the fixed
  `[pty-reap-capture]` tag, naming the pid and the specific reason, on both paths.
- (Round 6) Do not call guard 2's win32 comparison "same-source" with THIS card's own abort check — they
  read the same real OS attribute but via two DIFFERENT query/conversion pairs (`checkRootSurvival`'s
  `/Date(ms)/` truncation vs this card's own `.Ticks` rounding); see `2897acc4`'s own record, round 8, for
  the measured cross-source delta and why `ROOT_CREATION_MATCH_TOLERANCE_MS` must never tighten below 1ms.
