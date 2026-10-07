# dbbb52db — hardening the real-reaper test tripwire against pid reuse and stray LOOM_TEST

## Narrative

Code Reviewer `bf7350d4`'s review of card `8c8ee0ee` (the structural tripwire itself — see
`docs/decisions/8c8ee0ee-structural-reap-test-tripwire.md`) found 6 non-blocking gaps in
`assertReapTargetIsOwnLiveDescendantUnderTest` and `isDescendantPid` (`pty/host.ts`), and in the tests
that exercise them. This card (`dbbb52db`) fixes them.

## Item 1 — a registry hit no longer accepts a currently-LIVE pid

Before this card, `wasSpawnedByThisTestProcess(pid)` short-circuited acceptance unconditionally, before
any OS enumeration ran. Since the registry (`test/_guard.mjs`'s `__LOOM_TEST_SPAWNED_PIDS__`) never drops
an entry (by design — see `8c8ee0ee`'s "dead-root hole" section), a pid number the OS later reuses for an
UNRELATED, live process would still match the registry and be accepted — and `killProcessById`'s
`taskkill /T /F` would run against that unrelated process's whole subtree.

Fix: the fresh OS enumeration now always runs first. The registry only short-circuits acceptance when the
pid has **no live row** in that enumeration (the dead-root case this registry branch exists for in the
first place). A pid that is currently live — including one this process itself registered — must still
pass the real ancestry walk (`isDescendantPid`); a reused pid number fails that walk (no genuine OS
parent/child chain to `process.pid`) and is refused.

An enumeration FAILURE always refuses outright (fail-closed) and never falls back to a registry-only
accept — this is NOT something the pre-existing code already had; it is this card's own reordering (item
1 above) that makes it true. On `main` before this card, `wasSpawnedByThisTestProcess(pid)` returned
BEFORE the enumeration ever ran, so a REGISTERED pid never reached the enumeration at all — its failure
path was unreachable for exactly the pid that most needed this guarantee. `test/pty-root-reap-test-
tripwire.mjs`'s "(behavioral E)" is that reordering's own RED proof: a pid this test process spawned and
already killed (which the OLD code accepted via the registry with no enumeration at all) is now REFUSED
when the OS process table can't be read, precisely because the enumeration is no longer skippable.

### Accepted residual: a TOCTOU window remains between the enumeration and the kill

`assertReapTargetIsOwnLiveDescendantUnderTest` takes one enumeration snapshot, decides, and returns; the
real kill (`process.kill`/`taskkill`) happens a few lines later in the caller. In the narrow window
between the snapshot and the kill, the OS could in principle reap the verified-legitimate pid and hand the
number to a new, unrelated process, which would then receive the kill instead. This window is not new —
it existed identically before this card and before `8c8ee0ee` — and is not closed by this fix. Accepted as
residual risk: this tripwire is a test-mode-only safety net against a FABRICATED pid a test never had any
legitimate claim to, not a general defense against OS-level pid-reuse races on an otherwise-legitimate
target. Closing the TOCTOU window itself (e.g. holding the target process open, or re-verifying identity
immediately before the kill call) is out of scope for this card.

### Measurement: real-spawn test families are not more prone to an enumeration-timeout-caused refusal

Ran `dev-server-teardown.mjs` and `kickoff-real-spawn.mjs` 3× each after this change landed. All 6 runs
passed; no refusal attributable to an enumeration timeout (`TEST_GUARD_ENUMERATION_TIMEOUT_MS = 5_000`)
was observed in any run's output.

## Item 2 — `isDescendantPid` now requires creation-time monotonicity per hop

A stale `ppid` link (the OS reuses a dead process's pid for the CLAIMED PARENT before the real child's own
reported `ppid` field is updated) used to walk through undetected. `isDescendantPid` now requires, on
every hop where both sides carry a known `creationTime`, that the child's own creation time is not earlier
than the claimed parent's — a genuine child can never have been created before its real parent. Win32 rows
carry `creationTime` (via `WIN32_SWEEP_PS_COMMAND`); POSIX rows never do, so this is a win32-only
tightening — when either side is unknown, the hop is unchanged from before this card.

Proved RED-before/GREEN-after against the real HEAD this card builds on: the new negative unit case
(`isDescendantPid` with the claimed parent's `creationTime` later than the child's own) returned `true`
(wrong) before this card's fix and `false` (correct) after, with the existing positive case (child's own
`creationTime` at/after the parent's) unaffected either way.

**CR `bf7350d4` follow-up:** the two checks above only ever exercise the ANCESTOR-MATCH branch (the child's
hop lands directly on `ancestorPid`, so the check against `ancestorRow`'s own `creationTime` fires) — the
separate MID-HOP branch (the `parentRow` lookup/check, taken when `ppid !== ancestorPid`) was never
independently exercised by any test; deleting its two lines left the whole suite green. Added a 3-hop unit
case (`7→5 (creationTime 3000), 5→1 (creationTime 4000), 1` with `ancestorPid=1`) that forces the mid-hop
branch specifically (pid 7's claimed parent is 5, not the ancestor). Proved RED by deleting
`isDescendantPid`'s `parentRow` declaration + its `if`/`return false` (the real, exact 2-line gate) from
the BUILT `dist/pty/host.js` (snapshotted first via `sha256sum`), rerunning
`pty-root-reap-test-tripwire.mjs`, and confirming exactly the new mid-hop check failed while every other
check in the file — including the ancestor-match-branch creationTime checks and all 4 behavioral
tripwire tests (A–F) — stayed green; restored `dist/pty/host.js` from the snapshot and verified the restore
by `sha256sum` (identical hash before and after) before re-confirming the full file green again.

## Item 3 — a LOOM_TEST process with no test-spawn registry refuses silently, never crashes

`inTestMode()` is true in ANY `LOOM_TEST=1` process — including a `dist/index.js` daemon a test spawns, or
a web e2e fixture daemon — none of which import `test/_guard.mjs` and so never populate
`globalThis.__LOOM_TEST_SPAWNED_PIDS__`. Before this card, a refusal in such a process always THREW; since
the real production call sites (`pty onExit` → `reapExitedDescendants` → `sweepOrphanedDescendants`) don't
wrap that call in a try/catch, the throw escaped and crashed the process via crashlog, skipping the rest
of `onExit`'s own cleanup.

Fix: `assertReapTargetIsOwnLiveDescendantUnderTest` now returns `boolean` (`true` = proceed, `false` =
refused — every caller MUST check it and bail out on `false`). It throws ONLY when a real test-spawn
registry exists (`hasTestSpawnRegistry()` — existence only, never pid membership); this is true for every
existing test in the suite (all of them import `test/_guard.mjs` by convention), so every existing
throw-based assertion keeps working unchanged. With no registry, it instead logs a single, fixed,
greppable tag — `[pty-reap-test-guard] REFUSED (no registry) <label>(pid=<pid>): <reason>` — and returns
`false`, so the caller (`reapOrphanedDescendants`/`killProcessById`/`killSingleProcessById`) returns
early instead of reaching the real kill/enumeration, and instead of letting an exception propagate.

**Consequence, accepted: in a registry-less `LOOM_TEST=1` process, EVERY `onExit` descendant sweep is
refused.** The root pid is always dead by the time `onExit` fires, and such a process never registers
anything (no `test/_guard.mjs`), so neither branch of `assertReapTargetIsOwnLiveDescendantUnderTest`
accepts it — orphan reaping is fully OFF for the whole lifetime of such a process, and each pty exit logs
one `[pty-reap-test-guard] REFUSED (no registry) ...` line instead of actually sweeping. This is acceptable
ONLY because it is test-mode-only (`inTestMode()` gates the whole tripwire; production is unreachable here)
— it is not a regression to fix, just the structural cost of refusing rather than crashing in a process
this card has no way to register pids for.

Proved via `test/pty-root-reap-test-tripwire.mjs`'s "(behavioral F)": a child process with `LOOM_TEST=1`
set and NO registry (it never imports `test/_guard.mjs`) calls `reapOrphanedDescendants(SENTINEL_PID)`
with no try/catch of its own, mirroring the real `onExit` call site. Before this card's fix the child
exits with an uncaught-exception stack trace (non-zero exit). After the fix it exits 0, having logged the
refusal and returned, never throwing.

## Item 4 — `guard-child-process-wrap-fidelity.mjs` now asserts the registry side effect, and node-pty too

The file previously asserted only the WRAP'S PASSTHROUGH FIDELITY (`promisify.custom` survival, callback
shape, `.pid`/IPC) — none of its checks would have gone red if the registry bookkeeping
(`LOOM_TEST_SPAWNED_PIDS.add(result.pid)`) were deleted entirely, since none of them ever read
`globalThis.__LOOM_TEST_SPAWNED_PIDS__`. (C)/(D) now additionally assert
`globalThis.__LOOM_TEST_SPAWNED_PIDS__.has(child.pid)` for `spawn`/`fork`, and a new (E) section imports
`node-pty`'s own `spawn` directly and asserts the same — the file never exercised node-pty's wrap at all
before this card, even though `8c8ee0ee`'s own CR-found real-spawn fix wraps it identically.

Proved RED-before/GREEN-after: temporarily disabled both wrap call sites in `test/_guard.mjs` (guarded by
`if (false)`, never an early return out of the surrounding loop/try — the wrap-calling statements
themselves were neutralized, nothing else in the file's control flow changed), confirmed the 3 new
registry assertions ((C), (D), (E)) went red while every pre-existing fidelity assertion in the same run
stayed green (proving those guarantees hold independently of the registry), then restored `_guard.mjs`
from its pre-mutation state and verified the restore by `sha256sum` before re-running to confirm green
again.

## Item 5 — `promisify(exec)`/`promisify(execFile)` children are NOT registered (fails safe)

`util.promisify.custom`'s own implementation (copied onto the wrapper verbatim by
`wrapSpawnLikeForTestRegistry`, per `8c8ee0ee`'s wrapper-fidelity fix) is Node's own internal
promise-returning implementation of `exec`/`execFile` — it does NOT call back into the wrapped `patched`
function that does the registry bookkeeping; it's a separate code path using the same lower-level
primitives directly. So a child process spawned via `promisify(exec)(...)` or `promisify(execFile)(...)`
is never added to `__LOOM_TEST_SPAWNED_PIDS__`, unlike a plain `exec(...)`/`execFile(...)` callback-style
call, which does go through `patched` and is registered.

This fails SAFE, not unsafe: a test that spawns a process this way and later needs to reap/kill it under
LOOM_TEST will find the tripwire refuses it (a false refusal, since the pid has a legitimate claim the
registry simply never recorded) rather than silently permitting an illegitimate kill. No test in this
suite relies on `promisify(exec/execFile)`'s own child being reaped by the real guarded functions today;
if one ever needs to, it must spawn via the plain callback form, `spawn`, or `fork` instead.

## Item 6 — removed the unfalsifiable "no completion log line" check in (A)

`pty-root-reap-test-tripwire.mjs`'s old "(A) no `[pty-reap]` completion log line for the sentinel pid ever
appeared" check ran synchronously, immediately after the synchronous throw from the tripwire — before the
real sweep's own async `spawnProcess`/`.on("close", ...)` machinery could possibly have produced that line
even if the tripwire were entirely absent, since the throw happens before `reapOrphanedDescendants` ever
reaches its own `spawnProcess` call. It was unfalsifiable in one trial: the exact fixed-wait-negative-
assertion shape this project's own guard (`fixed-wait-negative-guard.mjs`) exists to catch, except here
there wasn't even a wait — the check ran at a point where it could never have observed the bad outcome
either way. Dropped rather than given a bounded wait, since a wait would still race the SAME async
machinery for no real benefit: the synchronous throw already structurally guarantees `reapOrphanedDescendants`
never reaches its spawn call, so there is nothing a wait could ever catch that the throw assertion two
lines above doesn't already prove. The immediately-following "(A, positive control)" block already proves
the capture mechanism genuinely observes a real completion line when one is produced, so no coverage is
lost by the removal.

## Do not

- Do not let a registry hit short-circuit `assertReapTargetIsOwnLiveDescendantUnderTest` for a pid that
  currently has a live OS row — only a DEAD (no live row) registry hit may accept without the ancestry
  walk. A live registry hit must still pass `isDescendantPid`.
- Do not fall back to a registry-only accept when the OS enumeration itself fails — always refuse
  (fail-closed), regardless of whether the pid is registered.
- Do not treat the remaining TOCTOU window (enumeration snapshot vs. the real kill a few lines later) as
  closed by this card — it is an accepted, pre-existing residual, not a regression to fix here.
- Do not revert `isDescendantPid`'s per-hop creation-time check — it is POSIX-inert (creationTime is
  always null there) and only tightens the win32 case; removing it reopens the stale-ppid hole item 2
  closes.
- Do not make `assertReapTargetIsOwnLiveDescendantUnderTest` throw unconditionally again — a LOOM_TEST
  process with no test-spawn registry (a spawned `dist/index.js` daemon, a web e2e fixture daemon) must
  get a logged, silent refusal (return `false`), never an escaping exception; every one of its 3 callers
  must keep checking its return value and bailing out on `false`.
- Do not drop the `(no registry)` tag from the no-registry refusal message, and do not change its fixed
  wording without updating the `(behavioral F)` test's own substring assertion in the same change.
- Do not assume `guard-child-process-wrap-fidelity.mjs`'s pre-existing fidelity checks (promisify shape,
  callback shape, `.pid`) are evidence the registry itself is intact — they are independent properties;
  this card's own RED proof showed all of them staying green with the registry wrap fully disabled.
- Do not assume `promisify(exec)`/`promisify(execFile)`'s own child gets registered — it does not, by a
  structural property of Node's own `util.promisify.custom` implementation, not a gap in this card's
  wrapper. A test needing the reaper/kill tripwire to recognize a spawned pid must use the plain callback
  form, `spawn`, or `fork`.
