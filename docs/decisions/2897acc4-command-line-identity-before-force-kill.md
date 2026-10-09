# 2897acc4 — command-line identity, never a bare pid match, before any force-kill of a "still alive" root

## Narrative

Card `2897acc4`: on an isolated throwaway daemon (Windows), 2 of 6 real worker exits left a live
`claude.exe` behind. `node-pty`'s own exit notification (`live.alive`, flipped only inside `pty.onExit`)
was found to be the sole source of truth, in both directions, for whether a session's OS process is
dead — nothing anywhere independently re-derived that from the OS itself:

- (S1) `pty.onExit` fired `intended=false` for a pid whose real `claude.exe` process was still alive.
  `reapOrphanedDescendants` (`pty/host.ts`) only ever swept DESCENDANTS of the root pid, never the root
  itself, so a false exit signal had nothing downstream to catch it.
- (S2) `stop(sessionId, "hard")` called `live.pty.kill()` and returned — fire-and-forget, with no
  verification the kill actually took effect. A recycled worker's process kept running and making MCP
  calls for 3+ minutes after the hard stop, until an external `taskkill`.

The fix (`verifyRootDeadOrForceKill`, `checkRootSurvival`, `commandLineMatchesSession` — all in
`pty/host.ts`) adds an OS-level liveness + identity re-check, independent of node-pty's own signal, at
every kill/exit path.

## Why identity, not just a pid check

Pids are recycled by the OS. Board card `3216b7f9` ("guard the orphan reap against a recycled root pid")
had already named this exact hazard for `reapOrphanedDescendants`'s own dead-parent tree walk: if a dead
session's pid is reused by an unrelated live process before the reap's own enumeration snapshot, that
unrelated process (and its real children) would be swept as if they were the dead session's orphans. The
same hazard applies here in the opposite direction: finding `rootPid` present and alive in a fresh
process listing does NOT by itself mean it is still the session's own process — it could be an unrelated
process the OS has since handed that same pid number to.

The fix: every real claude/codex spawn's `--settings`/`--mcp-config` file path embeds the session's own
id in its filename (`sessionSettingsPath`/`sessionMcpConfigPath`, `pty/claude-settings.ts`), and that path
is passed on the CLI's own command line (`--settings <path>`, `--mcp-config <path>`). So the session's id
appears verbatim on the real process's command line — a pid the OS has reused onto an unrelated process
will not carry it (a UUID collision is astronomically unlikely). `commandLineMatchesSession` is the one
place this check happens; `checkRootSurvival`/`verifyRootDeadOrForceKill` call it before ever killing a
"still alive" root, and card `3216b7f9`'s hazard is folded into the SAME check rather than guarded
separately — on an identity mismatch, nothing is killed (neither the root nor, by construction, anything
downstream of it), and the event/log make the mismatch observable rather than silently sweeping nothing.

**Round 3 correction (CR dd39877b, M1): the ORIGINAL version of this section, and `commandLineMatchesSession`
itself, matched a BARE sessionId substring anywhere on the command line — WRONG.** Every lifecycle hook
spawns a CHILD process whose own command line also carries the bare sessionId verbatim (`node
hook-relay.mjs <sessionId> <port> <hookToken>`, `claude-settings.ts`'s hook command) — on every real
session, every hook invocation, not a rare edge case — and an agent's own shell command could carry it
too. A bare-substring match therefore confirms "the session id appears somewhere on SOME process's
command line", not "this pid is the session's own ROOT process". The fix (now in `commandLineMatchesSession`)
matches the session's own `--settings <path>` argument (`sessionSettingsPath(sessionId)` — a path whose
FILENAME embeds the id, passed to no process but the real claude root) or, for codex (no `--settings`
flag), its own `-c mcp_servers.<id>.url=.../mcp/<sessionId>` (or `/mcp-run/<sessionId>`) config argument —
neither of which a hook-relay child, or any other process, is ever given.

## Round 2 (Code Review 53d52398): a confirmed command-line match still isn't enough

CR round 2 found that `commandLineMatchesSession` alone has its own, narrower version of the same pid-
reuse hazard: it is a point-in-time check made fresh at verification time, strictly AFTER the kill it is
guarding, with an unbounded gap in between (`ROOT_REAP_KILL_VERIFY_DELAY_MS` plus whatever scheduling
delay got the caller here at all). In that gap, the ORIGINAL session could itself have respawned onto the
very same pid (a resume/recycle that lands before this stale verify finally runs) — a command-line match
would then be genuinely true, and the check would confidently kill the session's own CURRENT, live
process while reporting that it killed the OLD one.

Two independent, additive guards close this, both inside `verifyRootDeadOrForceKill`, checked only AFTER
identity is already confirmed (so neither one ever weakens the identity gate above — they narrow further):

- **Guard 1 (`findLiveEntryByPid`):** scans both `this.live` and `this.liveCodex` for whichever object
  currently owns `rootPid`. If that live object is not the SAME object reference the caller captured as
  `expectedOwner` before the kill, a respawn got there first — reason `pid-now-live-session`, not killed.
  `findLiveEntryByPid` always scans fresh (@decision 2897acc4 at `pty/host.ts`'s own `findLiveEntryByPid`
  doc) — it is never allowed to trust a cached answer, since the whole point is observing a respawn that
  happened *between* calls.
- **Guard 2 (OS creation-time cross-check):** independent signal, for the case a respawn reused the pid
  before `findLiveEntryByPid` could even observe the old `Live`/`CodexLive` object get replaced (e.g. the
  caller's own reference is already the stale one by the time this runs). Win32's `Get-CimInstance`
  query now also projects `CreationDate`; `parseWin32CimDate` decodes its legacy Json.NET
  `"\/Date(<epoch-ms>)\/"` serialization (verified live against a real PowerShell invocation, not
  assumed) into an epoch-ms `creationTime` on `RootSurvivalCheck`. If `creationTime` is newer than the
  owner's own recorded `startedAt` (plus `CREATION_TIME_SLACK_MS` slack for enumeration/clock skew), the
  OS itself is saying this pid's process postdates our spawn — reason `creation-time-mismatch`, not
  killed. POSIX enumeration never populates `creationTime` today (`null`), so this guard is a no-op there
  — guard 1 is the only one covering POSIX.

Both guards are keyed off `expectedOwner` — the specific `Live`/`CodexLive` object captured by the caller
BEFORE the kill, threaded through every call site (`reapExitedDescendants`, `stop`'s hard branch,
`escalateGracefulStop`'s stage 3, `stopCodex`'s mirrors, and the two early-return backstops below), never
re-derived fresh via `findAnyLive(sessionId)` inside `verifyRootDeadOrForceKill` itself — a fresh lookup
at verify time would just find whatever respawned onto that sessionId and call IT the expected owner,
defeating the guard it's supposed to feed.

## Round 2: POSIX `/proc`-less fallback never silently collapses to "all gone"

`enumerateProcessesPosix`'s `/proc` readdir can fail (sandboxed/restricted environment, or a non-Linux
POSIX host with no `/proc` at all — macOS). Before this card, that failure path `return`ed `[]` —
indistinguishable from "enumerated fine, found nothing alive", which upstream callers read as "confirmed
gone" and would have silently cleared a genuine survivor. `enumerateProcessesPosixViaPs` now runs `ps
-axo pid=,command=` as a fallback and REJECTS (not resolves empty) if it parses zero rows, so a total
enumeration failure propagates as `enumerationFailed:true` — `checkRootSurvival`'s existing fail-closed
contract — rather than reading as "nothing survived."

## Round 2: `recycleWorker`'s own interpretation of a non-"dead" verify result (LEAD RULING, finding 8)

`recycleWorker`'s fail-closed refusal (the predecessor's root process could not be confirmed dead after a
hard stop — see the `Do not` below) must refuse ONLY when the predecessor might genuinely still be ITS
OWN process. `verifyRootDeadOrForceKill`'s `identity-unconfirmed` outcome (`dead:false,
identityConfirmed:false`) means the opposite: the pid is alive, but held by an UNRELATED process — the
predecessor's own process is already gone, Loom just didn't find it at the pid it expected. Treating that
outcome as "might still be ours, refuse" (the original round-2 shape, flagged as a LEAD RULING) would
wrongly block every recycle racing an unrelated pid-reuse. The condition is `!verify.dead &&
(verify.checkFailed || verify.identityConfirmed === true)` — refuse on a confirmed same-session survivor
or a failed check (genuinely unknown), never on a confirmed-different-process mismatch.

## Round 2: the predecessor's carried queue must survive a refusal (finding 4)

`recycleWorker` calls `this.pty.flushPending(workerSessionId)` unconditionally, before it even knows
whether the predecessor will be confirmed dead — flushing is what makes the queue safe to hand to a
successor in the success path. On the refusal path above, that flush already happened and the predecessor
is NOT being replaced, so the flushed entries must go back: `for (const msg of carried)
this.pty.requeueQueuedMessage(workerSessionId, msg)`, onto the (still-live, by construction) predecessor.
A terminal `recycle_failed` event is filed under the predecessor's own id (`detail.carriedRequeued`
recording the count) so a stalled `recycle_begin` never goes unresolved.

## Round 2: `stop()`/`stopCodex()`'s early-return still verifies a hard stop (finding 7)

Both methods' `!live.alive` early-return branch used to return immediately with no verification at all —
reachable whenever a hard stop races the pty's own exit event, exactly the condition most likely to mean
the kill's outcome is still unconfirmed. Both now call `scheduleRootVerify(sessionId, live.pid,
"hard-stop", live)` before returning, for `mode === "hard"` only (a graceful-mode early return has no
kill to verify).

## Round 3 (Code Review dd39877b): identity premise correction, TOCTOU-safe kill, and a caller-facing verdict

**M1 — see the corrected "Why identity" section above.** `commandLineMatchesSession` now matches
`sessionSettingsPath(sessionId)` (claude) or `/mcp/<sessionId>`/`/mcp-run/<sessionId>` (codex), never a
bare substring. POSIX's `creationTime` (guard 2) was `null` unconditionally before this round — Linux now
reads `/proc/<pid>/stat`'s `starttime` (converted via a single `/proc/uptime` boot-time read per
enumeration), macOS's `ps` fallback now requests `lstart` — both best-effort, never dropping a row on a
parse failure (degrades that one row's `creationTime` to `null` instead).

**M2 — `verifyRootDeadOrForceKill`'s own kill seam (`killRoot`) now kills ONLY the confirmed root pid**
(`killSingleProcessById`, no `/T`), never the whole subtree `killProcessById` (the worktree reaper's own,
deliberately-accepted-risk kill) takes. A `/T` tree-kill here would blast past what the identity/respawn
guards verified — they check the ROOT pid alone — onto whatever descendant has attached to that pid in
the TOCTOU gap since the identity check ran. **Residual window, stated explicitly (per CR's own
"state it, don't silently accept it" instruction; round 4 reworded this paragraph — the original version
mischaracterized the residual as an uncovered RESPAWN):** the identity check and the kill are still two
separate steps, not one atomic OS call. **Guard 1 (`findLiveEntryByPid`) fully covers a LOOM respawn**
landing in the gap between the last guard check and `killRoot` itself — `spawn()` registers a fresh
`Live`/`CodexLive` object for `rootPid` before anything else can observe it, so any later caller's own
guard-1 check sees that new object and refuses. **The real, uncovered residual is narrower: the OS
reassigning `rootPid` to an UNRELATED, non-Loom process** in the gap between the enumeration SNAPSHOT
(the `probeRootSurvival` call feeding the identity/creation-time guards) and `killRoot` itself — on win32
that gap is on the order of ~1s (the CIM query's own round-trip) — during which guard 1 has nothing to
check such a process against (Loom never tracked it). Closing THAT would mean an atomic
check-then-kill (e.g. a single PowerShell `Get-Process -Id N | Where StartTime -eq $t | Stop-Process`) —
not built this round; a future round that wants a tighter bound should build that instead of further
shrinking `ROOT_REAP_KILL_VERIFY_DELAY_MS`.

**M3 — on win32, an identity-CONFIRMED row with `creationTime: null` now refuses** (reason
`creation-time-missing`, caller-facing `identity: "unreadable"`) rather than silently skipping guard 2 and
proceeding to kill. `parseWin32CimDate` only returns `null` on a malformed/absent `CreationDate` — a real
enumeration anomaly on win32, never legitimate "no data" there. POSIX is UNAFFECTED by this check (gated
on `process.platform === "win32"`) — a per-pid `/proc`/`ps` read can legitimately fail to produce a
`creationTime` for one specific row there even after M1's population fix above, and guard 1
(`findLiveEntryByPid`) alone still covers that narrower, expected gap, exactly as before this round.

**M4 — `findLiveEntryByPid` now requires `l.alive`** — a dead session stays in `this.live`/`this.liveCodex`
with `alive:false` forever (never evicted), so a bare pid-number match used to also match a STALE dead
entry from a past life, wrongly reading as "a respawn got here first" (guard 1) when nothing live actually
owns the pid.

**M5 — `RootReapResult`/the `onProcessSurvivedKill` event both gained a caller-facing `identity: "confirmed"
| "mismatch" | "unreadable"` field.** Before this round, `recycleWorker` derived its own refuse/proceed
decision from `dead`/`identityConfirmed`/`checkFailed`, and its own comment called the
`pid-now-live-session`/`creation-time-mismatch` shapes a "confirmed same-session survivor" — WRONG: both
mean the respawn guards found that something ELSE now owns the pid, i.e. the PREDECESSOR `recycleWorker`
is tracking is already gone, even though the pid itself is occupied. The old boolean gate
(`!verify.dead && (verify.checkFailed || verify.identityConfirmed === true)`) refused on these two shapes
anyway, since both set `identityConfirmed: true`. `identity` now disambiguates them explicitly:
"confirmed" is reserved for the one shape that's genuinely still OUR tracked process
(`force-kill-unconfirmed` — we tried to kill it and it's STILL alive, by object identity); every
"mismatch" shape (an unrelated process, OR a respawn under a different live object/creation time) means
our tracked predecessor is gone, however occupied the pid itself still is. `recycleWorker` gates on
`identity` directly now (`identity === "unreadable" || (identity === "confirmed" && !dead)` refuses;
everything else proceeds) instead of re-deriving a boolean from the lower-level fields by hand.

**M6 — `recycleWorker`'s refusal-path requeue now counts ACTUAL results, not attempts.**
`requeueQueuedMessage` can report `deliveryState: "dropped"` (e.g. the predecessor turns out genuinely
dead by the time the requeue runs); the prior `carriedRequeued` field counted `carried.length` regardless
of outcome. The `recycle_failed` event now carries both `carriedRequeued` (successes only) and
`carriedDropped` (genuine drops), and a drop is logged. The simpler alternative CR also offered — deferring
`flushPending` until after the verify verdict, so there's nothing to give back on the refusal path at all —
was NOT taken: `carried` (the flushed queue) is consumed unconditionally further down `recycleWorker`'s
own SUCCESS path too (the carry-forward-to-successor block), so deferring the flush would mean
restructuring that whole shared path, not just the rare refusal branch — a materially bigger change than
counting results honestly.

**M7 — the POSIX `ps` fallback (`enumerateProcessesPosixViaPs`) is now self-bounded + self-killing on
`timeoutMs`**, mirroring `enumerateProcessesWin32`'s own posture (previously unbounded — a wedged `ps`
could hang `checkRootSurvival`/`reapProcessesRootedInWorktree` indefinitely on whatever POSIX host reaches
this fallback). It also now passes `-ww` (unlimited output width) so BSD `ps`'s (macOS) default
terminal-width truncation can never clip the `command` column.

**B1 (Code Review dd39877b, BLOCKING test hazard) — the free-function OS-wide SIGKILL sweep
(`reapOrphanedDescendants`) that `reapExitedDescendants` calls was split into its own seam
(`sweepOrphanedDescendants`).** `pty-root-reap-call-site-wiring.mjs` used to call the REAL (grandparent)
`reapExitedDescendants` to prove production call-site wiring, which meant also running the real sweep
against its fabricated root pids (40000+/50000+/59034, etc.) — measured by the reviewer to SIGKILL 17 real
live processes on the host in those fake-pid ranges, including the self-hosting daemon's own process. The
new seam lets that test override JUST the sweep to a no-op while the real `reapExitedDescendants` body
(and its real verify-call wiring) still runs for real.

**Round 3, known follow-up (not built this round):** every kill/exit path now pays its own fresh
`checkRootSurvival`/`probeRootSurvival` OS-process enumeration (a `powershell.exe` CIM query on win32),
on top of the pre-existing descendant sweep's own enumeration — a mass stop (many sessions retiring at
once, e.g. a merge batch or a daemon-wide shutdown) can fan out an unbounded number of these concurrently.
CR round 3 flagged this as worth noting, not worth building a fix for in this round — a future round that
wants to bound it should look at a shared concurrency limiter (mirroring the gate's own `GateSemaphore`
shape) around the enumeration helper spawn, not at widening any of this round's timeouts.

## Round 4 (Code Review 526c583b): recycleWorker's own alive-gate, Linux clock-domain, post-kill sweep, and a third guard seam

**Item 1 (MAJOR, blocking) — `recycleWorker`'s verify-or-refuse branch used to run only
`if (this.pty.isAlive(workerSessionId))`, AFTER the ~5s poll.** `isAlive` is node-pty's own `onExit` flag
alone — in the card's own S1 shape (`onExit` fires a false exit, but the real OS process survives),
`isAlive` reads `false`, so the branch was skipped ENTIRELY and recycle proceeded to spawn the successor
into the predecessor's own still-live worktree, with no OS-level check having run at all. Fixed by
capturing the predecessor's pid (`this.pty.getPid`) AND its live-object reference
(`this.pty.captureLiveRef` — a new, narrow public accessor over the private `findAnyLive`, see its own
doc) BEFORE `stop()`, then ALWAYS running `verifyRootDeadOrForceKill` afterward regardless of `isAlive`,
passing that captured reference as `expectedOwner` (previously omitted, falling back to whatever
`findAnyLive` resolved to AT VERIFY TIME — a materially later, less safe capture point). The existing
three-way `identity` gate (round 3, M5) is unchanged; only the gate that used to skip calling it is fixed.

**Item 2 — the Linux `creationTime` cross-check (round 3's own guard 2) derived its ms-epoch value FRESH
at every check** (`bootTimeMs = Date.now() - uptime`, taken at CHECK time) and compared it against
`owner.startedAt` (a `Date.now()` taken at SPAWN time) — two reads of the wall clock at different
instants. A wall-clock step in between (an NTP correction) desyncs them even for the genuinely same,
still-alive process, producing a FALSE "mismatch" that makes `recycleWorker` proceed — the exact survivor
this card exists to catch, defeated by the guard meant to help confirm it. Fixed with a tick-domain
comparison instead: `Live`/`CodexLive` gained `startTicksLinux` (the pid's own boot-relative
`/proc/<pid>/stat` `starttime`, captured ONCE via `armLinuxStartTicks` right after spawn, Linux-only,
best-effort async), `WorktreeProcess`/`RootSurvivalCheck` gained the matching `creationTicks` (populated
unconditionally by `enumerateProcessesPosix`'s Linux branch, independent of whether the ms-epoch
`bootTimeMs` anchor itself resolved). `linuxStartTicksConsistent` (pure, exported) compares the two tick
values directly — no `Date.now()` on either side, so no wall-clock step can desync them. On Linux, this
REPLACES the ms-epoch comparison entirely (never falls back to it); when either side's ticks are
unavailable, it fails toward `identity: "unreadable"` (refuse), never toward a "mismatch" the retired
arithmetic might derive. Win32 and macOS (whose `creationTime` sources — a CIM `CreationDate`, `ps`'s
`lstart` — are both genuine absolute OS timestamps, never re-derived from this process's own `Date.now()`)
are UNCHANGED, still gated on `process.platform !== "linux"`.

**Item 3 — the durable `process_survived_kill` event dropped `identity`** (the caller-facing three-way
verdict round 3, M5 added) even though `PtyHostEvents.onProcessSurvivedKill`'s own payload always carries
it — `SessionService.handleProcessSurvivedKill`'s `info` type and `appendEvent` detail just didn't thread
it through. Fixed; no test pinned the event's key set (grepped), so nothing else needed updating.

**Item 4 — a CONFIRMED force-kill of the root never swept orphaned descendants afterward.** A descendant
spawned in the TOCTOU window between identity confirmation and the kill itself (codex's own `codex.exe`
under its shim, a shell, an MCP child) could survive the root's own death unreaped. Fixed:
`verifyRootDeadOrForceKill` now calls `this.sweepOrphanedDescendants(rootPid)` immediately after
confirming `dead === true` post-kill — through the SAME seam `pty-root-reap-call-site-wiring.mjs` already
no-ops (see B1 above), so a test exercising this never runs the real OS-wide sweep.

**Item 5 — `pty-subclass-reap-seam-guard.mjs` only checked classes `extends PtyHost` (bare) for
`reapExitedDescendants`/`probeRootSurvival` overrides, never a class that bypasses `createSeamHost`'s own
no-op by calling `PtyHost.prototype.reapExitedDescendants` directly** (exactly `SpyHost` in
`pty-root-reap-call-site-wiring.mjs` does, on purpose, to prove production wiring) — such a class must
ALSO override `sweepOrphanedDescendants`, or item 4's new call above runs the real OS-wide sweep against
a fabricated pid. The guard now scans EVERY class in the corpus (heritage-shape-independent) for a
`PtyHost.prototype.reapExitedDescendants` reference (`.call`, `.apply`, or any other use) and requires
`sweepOrphanedDescendants` alongside it; a positive control (an injected offending class) proves it fires.

## Round 5 (Code Review 9024d16b): the sweep seam has a SECOND, unguarded reach path, Linux guard-2 test gaps, and a post-kill stale-pid hazard

**Item 1 — round 4's own `sweepOrphanedDescendants` call (item 4 above) is also reachable WITHOUT ever
touching `reapExitedDescendants` at all.** `verifyRootDeadOrForceKill` calls it directly once it confirms
a force-killed root is dead; a test that drives `verifyRootDeadOrForceKill` by overriding
`probeRootSurvival`/`killRoot` per scenario (`pty-root-reap-identity.mjs`'s own `ControllableHost`) reaches
this call WITHOUT ever overriding `reapExitedDescendants` itself — so round 4's own `sweepOrphanedDescendants`
seam, and the guard meant to enforce it, both missed this second path. Fixed three ways: (a)
`ControllableHost` now overrides `sweepOrphanedDescendants` too (recording, never real); (b)
`test/_seam-host-fixture.mjs`'s shared `createSeamHost` fixture gained the same no-op override, belt-and-
braces, for any future subclass that overrides `probeRootSurvival`/`killRoot` per-scenario without its own
override; (c) `pty-subclass-reap-seam-guard.mjs` is widened — ANY class on a known PtyHost-subclass
heritage shape (bare `PtyHost` or `createSeamHost(PtyHost)`) that declares its own `probeRootSurvival` OR
`killRoot` member must now ALSO override `sweepOrphanedDescendants`, scored independently of the existing
`reapExitedDescendants`-reaching rule (a class can trip either rule, or both). This widening alone found
**57 real test files** whose `SeamHost`/`FakeCodexHost`/`TestPtyHost`/etc. classes declared `probeRootSurvival`
or `killRoot` without `sweepOrphanedDescendants` — none proven to actually reach a confirmed-dead kill in
their own scenarios (grepped: every "re-check after killRoot" in the corpus either stays alive or the class
never reaches a kill at all), but the guard's own posture is deliberately conservative (a static scan
cannot rule out a future scenario addition reaching the kill path), so all 57 were given the same no-op
override rather than individually proven safe. `recycle-refuses-unkillable-predecessor.mjs`'s `SeamHost`
was among them.

**Item 2 — `pty-root-reap-identity.mjs`'s own scenarios 7-9 (CR round 2's live-entry/creation-time guards)
only populated the ms-epoch `creationTime` field, never `startTicksLinux`/`creationTicks`** — so on a REAL
Linux runner, guard 2 takes the ticks-only branch (round 4, item 2) and finds `owner.startTicksLinux`/
`check.creationTicks` both `undefined`, refusing as `"unreadable"` instead of the scenario's own asserted
kill/mismatch outcome. Fixed by populating BOTH signals, consistently, on every owner/check pair in those
three scenarios, so they pass identically whichever real `process.platform` runs them. Separately, a new
`resolveRootReapPlatform()` seam (mirrors `resolveMcpTokenRidesEnv`'s own precedent) lets a test FORCE the
Linux branch on any host; three new scenarios (11-13) exercise it directly: ticks consistent -> kill,
inconsistent -> mismatch (the genuine-respawn shape), missing on either side -> `"unreadable"` (never a
mismatch derived from the retired ms arithmetic). Proven load-bearing, not vacuous: with the override
disabled, scenarios 11 and 12 go RED on this (win32) host, because the control flow genuinely differs.

**Item 3 — the post-kill sweep (item 4 of round 4) is rooted at a pid Windows has just freed, and Windows
never updates a surviving process's own reported parent pid.** A process whose stale parent-pid happens to
equal that just-freed number — because the OS handed that number to an EARLIER, unrelated parent at some
point in the past — would be walked and killed as a "descendant" of a root it was never actually a child
of. Fixed in `reapOrphanedDescendants`/the new pure `computeOrphanSweepPlan`: a candidate child whose own
creation time predates the root's own (both known) is dropped — never killed, never walked into (so a
genuinely unrelated subtree hanging off it is never swept via that bogus link either). The root's own
creation time is threaded through from the FIRST probe (`check.creationTime`, captured before the kill) —
`verifyRootDeadOrForceKill`'s post-kill call now passes it; the pre-existing onExit-triggered sweep
(`reapExitedDescendants`, no probe run yet at that point) always omits it, preserving today's unconditional
walk there exactly. **Scoped to WIN32 ONLY, deliberately**: the win32 sweep's own lightweight enumeration
now also captures each row's `.NET DateTime.Ticks` (parsed by the new `parseWin32SweepTicks`, culture-
invariant) via `Get-CimInstance`; POSIX's `ps -eo pid,ppid` enumeration is UNCHANGED (still two columns),
so every POSIX row's `creationTime` stays `null` and the filter is a permanent no-op there. This is NOT an
oversight — re-deriving a POSIX/Linux creation time the same way this card's own item 2 (round 4) already
found unsafe (`Date.now()` minus an elapsed/uptime quantity, re-read at a DIFFERENT instant than the value
it's compared against) would reopen that exact wall-clock-step hazard for a different call site; a future
round that wants POSIX coverage here should thread Linux's own tick-domain signal through instead, the
same way guard 2 itself does, not ms arithmetic. Tested hermetically via `computeOrphanSweepPlan` directly
(no real process spawn) — a stale-PPID child + its own genuinely-unrelated descendant, a negative control
proving a genuine child/grandchild still gets killed and walked normally, and the two "nothing is known, so
don't filter" preservation cases (`rootCreationTime` unknown; a candidate's own `creationTime` unknown).

**Item 4 (Minor 3, round 4) — `recycleWorker`'s own "no predecessor pid at all" case (`predecessorPid ==
null`) short-circuits straight to a synthetic `dead:true` result, without calling `verifyRootDeadOrForceKill`
at all.** Kept as today's behavior, deliberately: a session with no tracked pid has nothing for an OS-level
check to confirm either way, and the alternative CR named and rejected — scanning the WHOLE process list
for a command-line marker (e.g. the session id) with no pid to anchor the search — is exactly the kind of
unbounded, host-wide sweep this card's own `commandLineMatchesSession` fix (round 3, M1) replaced a bare-
substring version of for being too broad; building a wider, pid-less version of the same idea would be a
regression in spirit, not a fix. No code changed for this item.

**Item 5 (Nit 5, round 4) — a single kill/exit sequence can pay more than one `verifyRootDeadOrForceKill`
call and more than one `sweepOrphanedDescendants` sweep** (e.g. a hard stop's own scheduled verify,
followed by the natural `onExit` -> `reapExitedDescendants` path's own verify + sweep). Noted, not fixed:
each call is independently cheap (one bounded OS enumeration) and idempotent (a second sweep against an
already-dead/already-reaped tree finds nothing), so the duplication is a cost-accounting nit, not a
correctness defect. A future round that wants to collapse this should look at de-duplicating by
`(sessionId, rootPid)` within a short window, not at skipping a verify call that might be the ONLY one to
run for a given exit path.

## Round 6 (Code Review 2547595a): a timezone skew in the win32 stale-pid filter, an unpinned wiring arg, a post-death pid-reuse gap, and the guard's own stated limits

**Item 1 (MAJOR, blocking) — the win32 sweep one-liner's `$_.CreationDate.Ticks` is a LOCAL-kind
`[DateTime]`'s LOCAL ticks, but `parseWin32SweepTicks` subtracts the UTC epoch's own Ticks constant,
assuming a UTC value.** Measured: on this (CEST, UTC+2) host the two enumerations' reported creation times
for the SAME real pid disagreed by exactly 7,200,000ms (2 hours) — a direct, reproduced confirmation, not
an inference. On any UTC-offset host this under/over-reports every row's `creationTime` by the local
offset, which can defeat `computeOrphanSweepPlan`'s stale-pid filter (round 5, item 3) in the direction
that matters: a genuine descendant younger than the root can look "stale" (older) and get wrongly skipped
— the exact orphan-survivor defect this whole card exists to fix. On a UTC host (CI) the skew is zero and
invisible. Fixed: the one-liner now reads `$_.CreationDate.ToUniversalTime().Ticks` — normalizing to UTC
BEFORE reading `.Ticks`, matching the UTC-epoch subtraction on every host regardless of local timezone.
Factored into one module constant (`WIN32_SWEEP_PS_COMMAND`, `pty/host.ts`) shared by both
`reapOrphanedDescendants` (the real sweep) and a new read-only `enumerateWin32SweepRows` export, so a test
can never hand-copy a drifting duplicate of the command. A new win32-only real-spawn test
(`pty-root-reap-win32-ticks-real-spawn.mjs`) cross-checks this enumeration's own reported `creationTime`
against `checkRootSurvival`'s independent one (a DIFFERENT PowerShell query, `ConvertTo-Json`-based,
already verified UTC-correct in round 2) for the SAME real pid (this test's own process) — read-only, kills
nothing. Proven load-bearing: with the bug reintroduced (bare `.Ticks`), the test goes RED with the exact
measured 7,200,000ms delta on this host; with the fix, delta is 0-1ms. The pre-existing hermetic round-trip
unit test for `parseWin32SweepTicks` (`pty-root-reap-identity.mjs`) had its own comment corrected: it used
to claim its round-trip matched "the real PowerShell one-liner's form" while that one-liner still read bare
(LOCAL-kind) `.Ticks` — true only on a UTC-offset-0 host, since `Date.UTC(...)` is inherently a UTC instant.
Now that the real one-liner also normalizes to UTC first, the round-trip genuinely matches it on every host.

**Item 2 — nothing pinned the WIRING of `verifyRootDeadOrForceKill`'s post-kill
`sweepOrphanedDescendants(rootPid, check.creationTime)` call (round 4, item 4; round 5, item 3's own
stale-pid filter depends on this second argument actually carrying the first probe's real value) — only
that a sweep happened at all, never that the CORRECT creationTime reached it.** `pty-root-reap-identity.mjs`'s
`ControllableHost.sweepOrphanedDescendants` override dropped the second argument entirely. Fixed: the
override now records it (`sweptCreationTimes`, parallel to `sweptPids`, default-parameterized the same way
the real method is so a dropped argument reads back as `null` rather than `undefined`); scenarios 2, 7, 9
and 11 each assert `sweptCreationTimes[0]` equals that scenario's own first-probe `creationTime` (scenario
2's first probe gained an explicit non-null sentinel it previously lacked, so this assertion is non-vacuous).
Proven load-bearing: dropping the second argument at the call site turns scenarios 2, 7, and 9 RED (11
stays green, since its own first probe's `creationTime` is `null` on the forced-Linux branch either way —
expected, not a gap in the proof, since that scenario's wiring is still exercised and pinned at the literal
value `null`).

**Item 3 — the post-kill sweep (round 4, item 4; round 5, item 3) is rooted at a pid Windows has just
freed, and Windows never updates a surviving process's own reported parent pid.** The sweep runs at least
`ROOT_REAP_KILL_VERIFY_DELAY_MS` after the kill, plus whatever scheduling/enumeration delay got it here —
long enough for the OS to have handed `rootPid` to an UNRELATED, live process in that window. Round 5's own
stale-pid filter (dropping a child whose `creationTime` predates the root's) does not cover this: a NEW
process's own CHILDREN, created after the new process started, are NOT stale by that filter's own
definition, yet they are not our root's descendants either. Fixed in `computeOrphanSweepPlan`: if the fresh
enumeration contains a LIVE, non-self-referential row (`pid === ppid` is excluded — a malformed-row
artifact, never a genuine live process, per the pre-existing guard) AT `rootPid` itself, the WHOLE walk
aborts (`abortedRootPidLive: true`) rather than killing only the colliding row — every "descendant" found
via a stale root is equally suspect, not just the one occupying the pid. `reapOrphanedDescendants` logs
this once (`[pty-reap] root=...: ABORTED — ...`) and sweeps nothing. Tested hermetically via the pure
planner directly (no real process spawn): a positive case (a live unrelated row at the root pid, plus a row
that would otherwise look like a genuine child — nothing killed), a negative control (no row at the root
pid — proceeds normally), and a discriminator proving the pre-existing self-referential-row test (e) does
NOT trip this new guard.

**Item 4 — the widened `pty-subclass-reap-seam-guard.mjs` (rounds 4-5) is a purely SYNTACTIC AST scan and
cannot be made complete by construction.** None of the following shapes occurs anywhere in today's corpus
(round 5's own 57-file sweep found none), but the guard structurally cannot see any of them: an aliased
import; a local-binding indirection (`const H = PtyHost; class Fake extends H`); a mixin
(`extends Mixin(PtyHost)`); a non-`createSeamHost` factory producing an equivalent no-op-seamed subclass;
namespace-qualified heritage (`extends PtyHostModule.PtyHost`); instance stubbing by assignment outside a
class body; or a direct free-function call with no subclass involved at all. Stated plainly in the guard's
own header rather than attempted — the syntactic scan is deliberately NOT widened to chase these; a
STRUCTURAL RUNTIME tripwire (carded separately by the lead) is the right tool for that gap, not a wider AST
pattern here.

## Round 7 (card 64d7a914): guard 2's win32 branch moves off the cross-source slack onto the verified capture

Card `2897acc4`'s own guard 2 (the ms-arithmetic branch, `CREATION_TIME_SLACK_MS`) compares two DIFFERENT
clock sources — the OS's own `check.creationTime` (read fresh by `probeRootSurvival` at verify time)
against `owner.startedAt` (Loom's own `Date.now()` at the original `spawn()` call) — which is why it needed
a 5-second slack (measured spawn latency 10-950ms under load, card `758486bc`, plus rounding/skew). Card
`87691385` built exactly the SAME-SOURCE capture `verifyRootDeadOrForceKill` itself never consumed: a
verified `live.creationTime`/`CodexLive.creationTime` (win32-only), read via the identical CIM query the
onExit sweep's own agreement check already trusts at 1ms (`ROOT_CREATION_MATCH_TOLERANCE_MS`). This round
retires the cross-source comparison on win32 specifically and replaces it with that tight, same-source one.

**The fix, scoped to `process.platform === "win32"` only** (a new branch in `verifyRootDeadOrForceKill`,
parallel to the pre-existing Linux-ticks branch): compares `check.creationTime` against the verified
`owner.creationTime` via `Math.abs(diff) <= ROOT_CREATION_MATCH_TOLERANCE_MS`, symmetric agreement — never
a one-directional "not later than" check, same posture 87691385's own abort check took. Either side
unknown, or a genuine disagreement, both refuse — never fall through to a kill on an unverified guess.
`CREATION_TIME_SLACK_MS` is UNCHANGED in value, and keeps its other two consumers (the Linux-ticks default,
and — see below — mac/other-POSIX, unaffected by this round).

**Deliberately NOT applied to mac/other-POSIX.** `87691385`'s capture (`armWin32RootCreationTime`) is
win32-only by construction — mac's `live.creationTime` is permanently `null`, so routing mac through the
same tight check would make guard 2 permanently refuse there (never merely stricter — structurally
inoperative), reintroducing the exact S2-shaped defect (`2897acc4`'s own headline incident: a hard stop
whose kill is never confirmed) this card exists to fix, for one platform specifically. Mac/other-POSIX
keeps today's `check.creationTime` vs `owner.startedAt + CREATION_TIME_SLACK_MS` comparison, unchanged —
newly exercised directly by a `platformOverride: "darwin"` test (`pty-root-reap-identity.mjs`, scenario 9d)
that did not exist before this round; scenarios 8/9 in that file previously ran on whatever real platform
the gate happened to execute on (win32, on this project's own gate host) and were the ONLY coverage of this
branch at all — conflating the two platforms' behavior under one untagged test.

**The timing hazard: a kill issued very soon after spawn, before the capture resolves.** `live.creationTime`
is armed fire-and-forget right after `spawn()`/`spawnCodex()` (87691385); reading a still-`null`,
not-yet-resolved value as "permanently unknown" would under-kill a genuine survivor in exactly the window
this capture is still in flight. Fixed: `Live`/`CodexLive` gained `creationTimeReady: Promise<void>` —
resolves once `creationTime` settles (never rejects; a pre-resolved stub at construction everywhere except
the real win32 `armWin32RootCreationTime` path, which replaces it with the real in-flight chain). Guard 2's
win32 branch awaits it, BOUNDED by `ROOT_CREATION_CAPTURE_AWAIT_MS`, before deciding — re-reading
`owner.creationTime` AFTER the await, never the stale value read at entry. Still null after the bound ⇒
refuse (`identity: "unreadable"`, same reason/shape as the pre-existing win32 null-`check.creationTime`
guard above it) — the fail-safe default, never a guessed match.

**The bound's value is measured, not guessed** (same posture as `ROOT_CREATION_CAPTURE_SLACK_MS`'s own
correction in round 3 of `87691385`): real conpty children via `enumerateWin32SweepRowForPid` on this host,
n=12 idle (min=568/p50=590/p90=646/p99=677/max=677ms) and n=8 under 3 concurrent CPU spinners
(min=661/p50=680/p90=1144/p99=1144/max=1144ms). `ROOT_CREATION_CAPTURE_AWAIT_MS` defaults to 3000ms — over
2.6x the single worst sample observed. Env-overridable (`LOOM_ROOT_CREATION_CAPTURE_AWAIT_MS`) for a test
to shrink it, same convention as every other timing constant in this file.

New tests in `pty-root-reap-identity.mjs`: scenario 8 (mismatch, now against the verified capture, not
`startedAt`), scenario 9 (agreement, same), 9b (still null after the bound ⇒ refuse), 9c (resolves within
the bound ⇒ decides on the resolved value, not the stale entry read), 9d (mac/darwin, unchanged 5s path,
both directions — the gap this round found). Scenario 7 (the pre-existing no-respawn negative control) was
updated to populate `creationTime`/`creationTimeReady` on its owner object — it now also reaches the new
win32 branch, where it previously reached the retired generic one.
`pty-root-reap-call-site-wiring.mjs`'s scenario 7 (and its own negative control) needed a `captureRootCreationRow`
override returning a verified row (never a post-spawn side-channel write to `live.creationTime` directly —
that races `armWin32RootCreationTime`'s own pending `.then()` and gets silently clobbered back to `null`;
caught by actually running the fix before writing it this way).

## Round 8 (Code Review 33ae2f8a, round 2): a TOCTOU window, a mislabeled cross-source comparison, a reason split, and an unreachable-but-cheap-to-close gap

**Item 1 (MAJOR) — round 7's own bounded wait ran AFTER the occupant probe, not before, leaving a real
TOCTOU window between the probe and the kill.** The CR measured `identityCheckToKillMs = 1509` with a
single probe: `probeRootSurvival` ran, THEN guard 2 awaited up to `ROOT_CREATION_CAPTURE_AWAIT_MS` (3s) for
an in-flight capture, THEN `killRoot` ran a blind kill keyed off the now-stale probe result — in that
window the OS could have reused or replaced `rootPid`, and the kill would still fire against it. **Fixed:**
the bounded wait moved to run immediately after computing `owner`, BEFORE `probeRootSurvival` is ever
called — nothing awaits between the probe and `killRoot` any more (pure synchronous guard evaluation in
between). Returns immediately when no capture is in flight: off win32, or once `creationTime` has already
settled, the race is skipped outright rather than still allocating and clearing a 3s timer against an
already-resolved promise — so the common-case cost is unchanged. Proven with a dedicated timing test
(`pty-root-reap-identity.mjs`, scenario 9e): the capture resolves only after an observable 50ms delay, and
the test asserts BOTH that `probeRootSurvival` fires only after that delay has elapsed, and that the
probe-to-kill gap itself is tiny (<20ms) — if the ordering regressed back to probe-then-await, the gap
assertion would absorb that 50ms instead, exactly reproducing the CR's own measurement. Re-measured on CR
re-review (33ae2f8a, round 2): `identityCheckToKillMs` down from 1509ms to 0.82ms.

**Item 1c (CR 33ae2f8a round 3 — a regression in the round-2 polish, caught before merge) — the skip-the-
race gate must read `resolveRootReapPlatform()`, never raw `process.platform`.** The round-2 polish pass
(gating the skip on `process.platform === "win32"`, to avoid allocating a timer at all off win32) reopened
the exact Linux-CI-red risk round 8's own item 2 had just closed: scenarios 8/9/9b/9c/9e force
`platformOverride = "win32"` so guard 2's OWN branch below still takes the win32 path on a Linux CI runner
— but the early-wait gate, reading raw `process.platform`, would see `"linux"` there and skip the wait
entirely, leaving `owner.creationTime` read as a stale, never-awaited `null`. 9b, 9c and 9e would fail on
CI; 8/9 would still pass by accident (their owners already carry a resolved `creationTime`, so the skipped
wait never mattered for them). **Fixed:** gate on `this.resolveRootReapPlatform()` instead — the SAME
test-overridable seam guard 2's own branch reads — so the wait and the branch it serves can never disagree
on which platform they think they're running under. `armWin32RootCreationTime`'s own capture-arming gate
is UNCHANGED (still raw `process.platform`) — that one is never test-overridden and never needs to be, by
design (round 7's own text). **Proven, not just fixed:** a temp copy of `pty-root-reap-identity.mjs` faked
`process.platform` to `"linux"` via `Object.defineProperty` before importing dist — ALL PASS against the
`resolveRootReapPlatform()`-gated fix; reverting just that one gate back to raw `process.platform` in
`dist` (nothing else touched) turned exactly 9b/9c/9e red under the same fake, matching the regression's
own predicted shape precisely — restored and sha256-verified after, temp file deleted.

**Latency this intentionally moves elsewhere (CR 33ae2f8a round 2, item 3) — not a hang.** An
exit-reap/hard-stop on a session dying while its own win32 creation-time capture is still in flight now
waits up to `ROOT_CREATION_CAPTURE_AWAIT_MS` (3s) BEFORE reporting "confirmed gone", since the bounded wait
now runs ahead of the probe for every call, not only the ones that reach a kill. Intended: the alternative
is reading a still-in-flight `null` as permanently unknown, which is the exact under-kill risk this
mechanism exists to close.

**Item 1b (nitpick 5, caught implementing item 1) — the bound timer must NEVER be `.unref()`'d.** The first
attempt at moving the wait called `boundTimer.unref?.()` right after creating it (intending only to avoid a
dangling handle) — this stranded the whole await PERMANENTLY in a hermetic test with nothing else keeping
the event loop alive: Node can and did exit the process before an unref'd timer ever fired, leaving the
`Promise.race` — and everything awaiting it up the stack — unsettled forever (reproduced directly: "Detected
unsettled top-level await" on exactly this line). Fixed by never unref'ing the timer at all; `clearTimeout`
after the race resolves is what actually avoids leaving a dangling handle once `creationTimeReady` wins.

**Item 2 (MAJOR, test-only) — scenarios 8, 9, 9b and 9c (round 7) set no `platformOverride`, so on a Linux
CI runner they silently take the Linux-ticks branch instead of the win32 branch they claim to test.** 8, 9
and 9c happened to still pass there (their tick values gave the Linux branch the same high-level
kill/refuse outcome, for the wrong reason); 9b genuinely failed (the Linux branch has no bounded-await
mechanism to time, so the "waited roughly the bound" assertion read `elapsed≈0`). **Fixed:** all four (and
the new 9e) now set `host.platformOverride = "win32"` explicitly, mirroring how scenarios 11-13 already
force `"linux"`. Scenarios 2 and 4 (pre-existing, unrelated to either creation-time guard) needed a
different fix — once an owner became required at all (item 6 below), their newly-added owners needed BOTH
a matching `creationTime` (win32 pair) and a matching `startTicksLinux`/`creationTicks` (Linux pair), same
dual-platform-consistency convention scenario 7 already used, so they stay platform-independent rather than
needing their own forced override. **Proven, not just fixed:** temporarily forcing `ControllableHost`'s own
default platform to `"linux"` (bypassing `process.platform` entirely) reproduced the CR's exact finding
with the overrides removed (8/9/9c passed by accident, 9b and the new 9e genuinely failed) and confirmed
the fix (all pass, overrides restored) — both runs reverted, diffed clean against the pre-mutation file
afterward.

**Item 3 (MINOR) — guard 2's win32 branch is CROSS-source, not same-source, and this record (and the
constant's own inline comment) had claimed otherwise.** The occupant's `check.creationTime` comes from
`checkRootSurvival`'s `/Date(ms)/`-truncated query; the owner's `owner.creationTime` comes from THIS card's
own `.Ticks`-based, `Math.round`-rounded one — two different conversions of the same real OS attribute, not
two reads of the identical query 87691385's own abort check compares. The CR measured Δ ∈ {0, -1}ms,
roughly 50/50, never more than 1ms — independently re-measured here across 15 fresh real conpty children:
{0, +1}ms (opposite subtraction order, same magnitude), 9 zero / 6 one, max 1ms. `ROOT_CREATION_MATCH_TOLERANCE_MS`
is sound at exactly 1ms for this pairing, but with ZERO headroom: a false "mismatch" makes `recycleWorker`
PROCEED to spawn a successor beside a still-live predecessor (`sessions/service.ts`'s own identity gate), the
wrong direction to be wrong in. **Fixed:** corrected this record (above) and the constant's own doc comment
to state the cross-source pairing and the "never tighten below 1ms" rule explicitly, and tightened
`pty-root-reap-win32-ticks-real-spawn.mjs`'s own cross-check from a loose `≤2000ms` to `≤ ROOT_CREATION_MATCH_TOLERANCE_MS`
— that real-spawn test reads exactly this pair (`enumerateWin32SweepRows` vs `checkRootSurvival`, same two
query shapes), so it now actually pins the premise guard 2 depends on, every gate run, rather than merely
ruling out "not a timezone bug" with 2000ms of unrelated slack.

**Item 4 (MINOR) — two gaps closed together: silent capture failures, and one shared reason for two
different unknowns.** `armWin32RootCreationTime` previously left `live.creationTime` null on EITHER a
rejected promise OR a row that failed `resolveVerifiedRootCreationTime`'s own verification (wrong ppid, or
too late), with no log line distinguishing a genuine failure from an unverified-but-received row. Fixed:
both paths now log once, under a new fixed, greppable `[pty-reap-capture]` tag, naming the pid and — for
the unverified case — which specific check failed (no row / ppid mismatch / too late), or the exception
message for a genuine rejection. Separately, guard 2's own null-refusal collapsed TWO independently-unknown
sides onto the SAME `"creation-time-missing"` reason — the OWNER's capture never resolving (or failing
verification) and the OCCUPANT's probe never reporting one are different failure classes, the first new to
this round and specific to the win32-tight-tolerance branch. Fixed: the owner-side null now reports a
distinct `"owner-creation-time-unavailable"` reason; the occupant-side null (reached here only as a
defensive, type-narrowing fallback — on win32 it is already caught earlier by round 3's own M3 null-check,
unconditional on `owner`) keeps `"creation-time-missing"`. Every consumer of this reason string was grepped
first (`sessions/service.ts`, the event writer, no UI consumer exists): none branches on the raw STRING —
`recycleWorker`'s own gate reads the `identity` field (`"unreadable"` vs `"mismatch"` vs `"confirmed"`),
which both reasons already carry as `"unreadable"`, so the new string is handled identically to
`"creation-time-missing"` with no further code change needed. New test: scenario 9b's own reason assertion
now expects the distinct string; a removed `9b2` scenario (deleted after writing it) would have duplicated
round 3's own scenario 10, which already covers the occupant-side case on win32 unconditionally.

**Item 5 (follow-up, closed) — before this round, an `owner`-undefined call skipped every creation-time
guard entirely and fell through to killing on command-line identity alone**, since guard 1 and every guard-2
branch are gated on `owner`. Genuinely unreachable in PRODUCTION (every real call site resolves an owner by
construction — `reapExitedDescendants`/`stop()`/`escalateGracefulStop`/`stopCodex`/`recycleWorker` all pass
or capture one), but several of THIS file's own pre-existing hermetic scenarios (2 and 4) exploited exactly
that gap as a test shortcut, to isolate kill-confirmation mechanics from the identity/creation-time guards
without constructing an owner object. Fixed: a new explicit `if (!owner)` refusal (reason
`"owner-creation-time-unavailable"`, identity `"unreadable"`) sits right after guard 1; scenarios 2 and 4
were given plausible, dual-platform-consistent owners (see item 2) so they keep testing what they always
tested, and a new scenario 9f was added specifically to prove the new refusal itself (no owner, no live
entry, at all) — proven load-bearing via a dist mutation (disabling the `if (!owner)` branch) that turned
only 9f red.

## Do not

- Do not read the win32 sweep's `.Ticks` as already UTC — `CreationDate` is a LOCAL-kind `[DateTime]`;
  bare `.Ticks` is LOCAL ticks, but `parseWin32SweepTicks` subtracts the UTC epoch's own Ticks constant.
  Always call `.ToUniversalTime()` BEFORE reading `.Ticks` in the win32 sweep one-liner
  (`WIN32_SWEEP_PS_COMMAND`) — a UTC-offset host otherwise under/over-reports every row's `creationTime`
  by the local offset, which can defeat `computeOrphanSweepPlan`'s stale-pid filter.
- Do not hand-copy the win32 sweep's PowerShell command string anywhere (a test, a future call site) —
  reuse `WIN32_SWEEP_PS_COMMAND`/`enumerateWin32SweepRows`, or a duplicate can silently drift from the
  real one-liner `reapOrphanedDescendants` actually runs.
- Do not test or assert that `verifyRootDeadOrForceKill`'s post-kill `sweepOrphanedDescendants` call
  happened without ALSO asserting its second argument (`rootCreationTime`) carries the first probe's own
  `check.creationTime` value — a wiring regression that drops the argument is invisible to a check that
  only counts calls.
- Do not assume the post-kill descendant sweep is safe once the stale-pid (creation-time) filter is in
  place — a LIVE, non-self-referential row at `rootPid` itself (an unrelated process the OS has since
  handed the just-freed pid to) must abort the WHOLE sweep, since every "descendant" found via it is
  equally suspect, not merely filtered row-by-row.
- Do not trip the live-root-pid abort on a self-referential row (`pid === ppid`) — that is the
  pre-existing malformed-row guard's own shape, a data artifact, never a genuine live process.
- Do not try to widen `pty-subclass-reap-seam-guard.mjs`'s syntactic AST scan to catch an aliased import,
  a local-binding indirection, a mixin, a non-`createSeamHost` factory, namespace-qualified heritage,
  instance stubbing by assignment, or a direct free-function call — none of these occurs in today's
  corpus, and a syntactic scan cannot be made complete against this class of evasion by construction; a
  structural runtime tripwire is the right tool for that gap, not a wider AST pattern here.

- Do not gate `recycleWorker`'s verify-or-refuse branch on `isAlive()` — `isAlive` is node-pty's own
  `onExit` flag alone and can read `false` (a spontaneous false exit) while the real OS process survives;
  capture the predecessor's pid + live-object reference BEFORE `stop()` and ALWAYS run
  `verifyRootDeadOrForceKill` afterward, passing that captured reference as `expectedOwner`.
- Do not compare Linux's `creationTime` (ms, re-derived from `Date.now()` at check time) against
  `owner.startedAt` (`Date.now()` at spawn time) — a wall-clock step between the two produces a false
  "mismatch" for the genuinely same, still-alive process. Compare `startTicksLinux` (captured at spawn)
  against `creationTicks` (observed at check) via `linuxStartTicksConsistent` instead — both boot-relative,
  neither reads the wall clock. When either side's ticks are unavailable, fail toward `identity:
  "unreadable"`, never toward a "mismatch" derived from the retired ms arithmetic.
- Do not skip `sweepOrphanedDescendants(rootPid)` after `verifyRootDeadOrForceKill` confirms the root
  force-killed and dead — a descendant spawned in the TOCTOU window between identity confirmation and the
  kill itself can otherwise survive unreaped.
- Do not let a class reach `PtyHost.prototype.reapExitedDescendants` directly (`.call`, `.apply`, or any
  other reference) — bare `extends PtyHost` or `extends createSeamHost(PtyHost)` alike — without also
  overriding `sweepOrphanedDescendants`; `pty-subclass-reap-seam-guard.mjs` enforces this across every
  heritage shape, not just a bare `extends PtyHost`.

- Do not force-kill a process found at a pid Loom once owned without first confirming
  `commandLineMatchesSession` (or an equivalent identity check) — a bare pid match is not enough; the OS
  can and does reuse pids.
- Do not treat an enumeration failure (`RootSurvivalCheck.enumerationFailed`) as "confirmed dead" or as
  license to kill — `checkRootSurvival` fails closed (never kills on a failed check) and callers must
  preserve that (see `verifyRootDeadOrForceKill`'s `checkFailed` branch).
- ⛔ RETRACTED (round 3, M1) — do NOT carry forward "the bare id is simpler, equally safe" for
  `commandLineMatchesSession`. It was FALSE: a hook-relay CHILD process's own command line also carries
  the bare sessionId on every real session (`node hook-relay.mjs <sessionId> <port> <hookToken>`), so a
  bare-substring match confirms "the id appears somewhere", not "this is the root". Match
  `sessionSettingsPath(sessionId)` (claude) or `/mcp/<sessionId>`/`/mcp-run/<sessionId>` (codex) instead —
  both root-only markers.
- Do not trust a command-line identity match alone once a kill has already been issued — re-check via
  `findLiveEntryByPid` (object identity, not sessionId) AND the OS creation-time guard; either one alone
  can miss a respawn the other catches.
- Do not re-derive `expectedOwner` inside `verifyRootDeadOrForceKill` via a fresh `findAnyLive` lookup — it
  must be the specific `Live`/`CodexLive` object the caller captured BEFORE the kill, or the respawn guard
  degenerates into confirming whatever respawned.
- Do not let a POSIX enumeration failure (no `/proc`, and the `ps` fallback also failing) resolve as an
  empty process list — that reads identically to "confirmed gone" to every caller; it must reject/propagate
  as `enumerationFailed:true`.
- Do not read `verifyRootDeadOrForceKill`'s `identity-unconfirmed`/`pid-now-live-session`/
  `creation-time-mismatch` outcomes (all `identity: "mismatch"`) as "predecessor might still be ours" in
  `recycleWorker` — every one of them means the predecessor's OWN tracked instance is already gone, even
  when the pid itself is still occupied by something else; only `identity === "confirmed" && !dead`
  (a genuinely still-alive tracked survivor) or `identity === "unreadable"` (genuinely unknown) refuses.
  Gate on `identity` directly — never re-derive a boolean from `dead`/`identityConfirmed`/`checkFailed` by
  hand, which is exactly how this bug (a stale comment calling two "mismatch" shapes a "confirmed
  same-session survivor") happened in round 2.
- Do not let `recycleWorker`'s refusal path drop the predecessor's already-flushed `carried` queue — it
  must be requeued back onto the predecessor via `requeueQueuedMessage`, and the terminal `recycle_failed`
  event must record the ACTUAL outcome: `carriedRequeued` (successes only) and `carriedDropped` (genuine
  `deliveryState: "dropped"` results) — never the raw attempt count for `carriedRequeued`.
- Do not leave `stop()`/`stopCodex()`'s `!live.alive` early-return branch unverified for a `mode==="hard"`
  caller — schedule the same `scheduleRootVerify` call other kill paths already get.
- Do not give `verifyRootDeadOrForceKill`'s own `killRoot` seam a `/T` tree-kill (`killProcessById`) — it
  must kill ONLY the confirmed root pid (`killSingleProcessById`); the guards feeding it verify the root
  alone, never its descendants, and `reapOrphanedDescendants`/`reapExitedDescendants` already own the
  real root's own descendants once it's confirmed gone.
- Do not skip guard 2 silently when `creationTime` is `null` on win32 — that is an enumeration anomaly
  there (never legitimate), and must refuse (`identity: "unreadable"`, reason `creation-time-missing`),
  not fall through to a kill. POSIX is the one platform where a per-pid `null` stays a legitimate no-op.
- Do not match a bare pid number in `findLiveEntryByPid` without also requiring `l.alive` — a dead
  session's stale entry (never evicted, `alive:false` forever) can share a pid number with nothing
  currently live, and that must never read as "a respawn got here first".
- Do not call the real `reapExitedDescendants`/`reapOrphanedDescendants` (the free-function OS-wide
  SIGKILL sweep) against a FABRICATED pid in a test, even indirectly via `PtyHost.prototype.reapExitedDescendants.call(...)`
  — override `sweepOrphanedDescendants` to a no-op instead, which still exercises the real verify-call
  wiring without the real sweep.
- Do not assume overriding `reapExitedDescendants` alone makes a test-local `PtyHost` subclass safe — a
  class that overrides `probeRootSurvival` or `killRoot` directly (to drive `verifyRootDeadOrForceKill`
  itself) can reach its own post-kill `sweepOrphanedDescendants` call WITHOUT ever touching
  `reapExitedDescendants` at all; such a class must ALSO override `sweepOrphanedDescendants`, and
  `pty-subclass-reap-seam-guard.mjs` enforces this independently of the `reapExitedDescendants`-reaching
  rule (round 5, item 1).
- Do not compare Linux's ticks-domain guard against a scenario that only populated the ms-epoch
  `creationTime` field — on a real Linux runner, guard 2 ignores `creationTime` entirely and reads
  `startTicksLinux`/`creationTicks` instead; a test exercising guard 2's outcome must populate BOTH
  signals (or force the branch via `resolveRootReapPlatform`), or it silently refuses as `"unreadable"`
  on Linux while passing on win32/POSIX-ms (round 5, item 2).
- Do not extend `reapOrphanedDescendants`'s stale-pid creation-time filter to POSIX — re-deriving a
  POSIX/Linux creation time via `Date.now()` minus an elapsed/uptime quantity, read at a different instant
  than the value it's compared against, is the exact wall-clock-step hazard round 4's own item 2 already
  found and fixed for guard 2; a future POSIX fix here must thread the tick-domain signal through instead,
  never ms arithmetic (round 5, item 3).
- Do not build a command-line-marker, whole-process-list sweep for `recycleWorker`'s "no predecessor pid
  at all" case — that is a wider, unbounded version of the exact bare-substring hazard `commandLineMatchesSession`
  was fixed to stop being (round 3, M1); keep today's "no pid -> proceed" behavior (round 5, item 4).
- (Round 7) Do not route mac/other-POSIX through guard 2's win32 tight-tolerance branch (`owner.creationTime`
  vs `ROOT_CREATION_MATCH_TOLERANCE_MS`) — `87691385`'s capture is win32-only by construction, so mac's
  `creationTime` is permanently `null`; doing so would make guard 2 permanently refuse on mac, not merely
  stricter. Mac/other-POSIX keeps `check.creationTime` vs `owner.startedAt + CREATION_TIME_SLACK_MS`,
  unchanged, gated on `resolveRootReapPlatform() !== "win32"` (and `!== "linux"`, which has its own branch).
- (Round 7) Do not read a still-`null` `owner.creationTime` at guard-2 entry as "permanently unknown" on
  win32 without first awaiting `owner.creationTimeReady`, bounded by `ROOT_CREATION_CAPTURE_AWAIT_MS` — a
  kill issued very soon after spawn can reach guard 2 before the async capture has resolved; still null
  AFTER the bound is the only point at which "unknown" is a final answer.
- (Round 7) Do not decide guard 2's win32 branch on the value of `owner.creationTime` read BEFORE the
  bounded await — re-read it AFTER awaiting `creationTimeReady`, since the whole point of the await is to
  let a still-in-flight capture land first.
- (Round 7) Do not patch a test's `live.creationTime` directly after `spawn()` as a side channel to force a
  known value — it races `armWin32RootCreationTime`'s own pending `.then()` (which can fire anywhere in the
  microtasks between the patch and the actual `verifyRootDeadOrForceKill` call) and gets silently clobbered
  back to whatever the real capture resolves to. Override `captureRootCreationRow` on the test's own PtyHost
  subclass instead, so the value is produced by (and stays consistent with) the real arm flow.
- (Round 8) Do not await a bounded wait for an in-flight creation-time capture AFTER `probeRootSurvival` —
  await it BEFORE, immediately once `owner` is computed. Probing first and awaiting afterward leaves a real
  TOCTOU window between the probe and `killRoot` (measured at 1509ms) in which the OS can reuse/replace
  `rootPid` and the kill still fires against the stale probe result.
- (Round 8) Do not `.unref()` the bounded-wait timer — an unref'd timer can let the process exit before it
  ever fires if nothing else is scheduled, permanently stranding the `Promise.race` (and everything
  awaiting it) unresolved. Only `clearTimeout` it, after the race settles.
- (Round 8) Do not write a `pty-root-reap-identity.mjs` scenario for guard 2's win32 branch without setting
  `host.platformOverride = "win32"` explicitly, UNLESS the scenario is deliberately dual-platform-consistent
  (matching `creationTime`/`startTicksLinux` pairs, like scenario 7/2/4) — an unforced scenario silently
  takes the Linux-ticks branch on a Linux CI runner, which can pass for the wrong reason or fail outright
  depending on what the scenario's own tick values happen to produce there.
- (Round 8) Do not call guard 2's win32 comparison "same-source" — it is CROSS-source (the occupant via
  `checkRootSurvival`'s `/Date(ms)/` truncation, the owner via this card's own `.Ticks` rounding), measured
  at Δ∈{0,±1}ms with ZERO headroom. Never tighten `ROOT_CREATION_MATCH_TOLERANCE_MS` below 1ms for this
  reason alone — a false "mismatch" makes `recycleWorker` PROCEED beside a live predecessor.
- (Round 8) Do not leave `armWin32RootCreationTime`'s capture failures silent — log once, under the fixed
  `[pty-reap-capture]` tag, naming the pid and the specific reason (no row / ppid mismatch / too late /
  the exception message), on both the verification-failure path and the rejection path.
- (Round 8) Do not collapse the OWNER-side creation-time-unknown case onto the OCCUPANT-side
  `"creation-time-missing"` reason in guard 2's win32 branch — they are different failure classes; the
  owner side gets its own `"owner-creation-time-unavailable"` reason. Before changing either, grep every
  consumer of the reason string (not just `identity`) to confirm nothing branches on the raw text.
- (Round 8) Do not let `verifyRootDeadOrForceKill` reach a kill when `owner` is unresolvable (no
  `expectedOwner`, no live/codexLive entry) — every creation-time guard is gated on `owner`, so without one
  it falls straight through to killing on command-line identity alone. Refuse (`"owner-creation-time-unavailable"`,
  `identity: "unreadable"`) right after guard 1 instead.
- (Round 8, item 1c) Do not gate the early-wait "skip the race" optimization on raw `process.platform` —
  gate it on `this.resolveRootReapPlatform()`, the SAME test-overridable seam guard 2's own branch reads.
  A raw-`process.platform` gate disagrees with a test's `platformOverride` on a non-win32 CI host, silently
  skipping the wait while guard 2's own branch still runs the win32 path it was supposed to feed — this
  exact mistake shipped once and was caught only by re-running the CI-host-simulation proof, not by
  re-reading the diff. `armWin32RootCreationTime`'s OWN arming gate is the one correct exception — it is
  never test-overridden, so raw `process.platform` is right there (round 7's own text).
