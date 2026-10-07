# 8c8ee0ee — the real reaper refuses a non-descendant pid under test; a structural runtime tripwire

## Narrative

Card `2897acc4` (predecessor, landed as `fe1cdf10`) shipped a syntactic AST scan
(`pty-subclass-reap-seam-guard.mjs`) to catch a test-local `PtyHost` subclass that forgets to no-op the
real reaper/kill seams. That guard's own review (Code Review `2547595a`, round 6) found it cannot be made
complete by construction: twice in that one card (rounds 2 and 4), a test ran the REAL OS-wide
reaper/kill against a FABRICATED pid and swept/killed real, unrelated processes on the owner's host,
including the live self-hosting daemon. This card builds the structural backstop the syntactic scan's own
header says it needs: a runtime tripwire inside the real kill/enumeration functions themselves, so the
hazard is closed regardless of HOW a test reaches them — subclass override, direct free-function call, or
any future evasion shape the AST scan can't see.

## The chokepoint

`assertReapTargetIsOwnLiveDescendantUnderTest(pid, label)` (`pty/host.ts`) is called as the FIRST
statement in the 3 free functions that ever reach a real OS kill/enumeration against a caller-supplied pid
NUMBER: `reapOrphanedDescendants`, `killProcessById`, `killSingleProcessById`. The 2 protected methods
(`sweepOrphanedDescendants`, `killRoot`) are not separately guarded — both unconditionally delegate to one
of these three with no logic in between, so they inherit the tripwire transitively. One chokepoint, not
five copies.

Production (`inTestMode()` false) is a single early-return and nothing else — byte-identical cost to
before this card. Under `LOOM_TEST=1` it refuses (loud `console.error` + throw) any pid that is neither:

- (a) a LIVE descendant of `process.pid` right now, proven by a fresh, bounded OS pid→ppid enumeration
  (reusing `WIN32_SWEEP_PS_COMMAND` verbatim on win32, `ps -eo pid,ppid` on POSIX) fed through the pure,
  exported `isDescendantPid`; or
- (b) a pid THIS test process itself handed to `node:child_process` spawn/fork/exec/execFile, even if
  it has since exited.

A fabricated pid is neither, and is refused.

## Why (a) alone is not enough — the dead-root hole

`dev-server-teardown.mjs`'s own real pattern: spawn a root, kill it, confirm it's dead, THEN call
`reapOrphanedDescendants(root.pid)` — the function is routinely called with an ALREADY-DEAD root. A dead
process's row is simply ABSENT from a fresh OS enumeration (verified empirically on this host: spawned a
child, confirmed its pid present in a `Get-CimInstance Win32_Process` listing, killed it, waited, confirmed
`process.kill(pid, 0)` throws, re-enumerated — the row was gone). An ancestry walk over that snapshot can
never recognize the dead root as "ours," and would wrongly refuse this legitimate call. Branch (b) — the
test-spawn registry — is what covers it: `root.pid` was recorded the instant it was spawned and stays in
the registry after it dies.

## The registry mechanism (branch b)

`test/_guard.mjs` (imported first by every daemon test, by convention) monkeypatches the shared
`node:child_process` module object's `spawn`/`fork`/`exec`/`execFile` via `createRequire` + reassignment,
then calls `module.syncBuiltinESMExports()` so a named ESM import (`import { spawn } from
"node:child_process"`, exactly what `pty/host.ts` itself uses) sees the patch too — verified empirically
with a standalone prototype covering both the direct case (consumer imports the wrapper first, then does
`import { spawn }`) and the harder case this card's own files actually use (the wrapper is a STATIC
import, the consumer module is a DYNAMIC `import()` that happens afterward, mirroring `await
import("../dist/pty/host.js")`) — both proved the patched function visible with no special-casing needed.
Every spawned pid is recorded into `globalThis.__LOOM_TEST_SPAWNED_PIDS__`, read by `pty/host.ts` via
`globalThis` rather than an import — `pty/host.ts` is PRODUCTION source and must never import from
`packages/daemon/test/`; the global is simply absent (and the read is behind `inTestMode()` anyway) in a
real daemon process.

This is deliberately NOT a per-test-author opt-in: no test file does anything differently, the registry
populates structurally for every test that follows the existing `import "./_guard.mjs"` convention.

**CRITICAL FIX (card 8c8ee0ee, CR round 2): `node:child_process` is NOT the only real spawn path —
`pty/host.ts`'s OWN `createPty`/`createCodexPty`/`createShellPty` call `node-pty`'s own `spawn` export
(a completely separate module, native-backed, never going through `node:child_process` at all).** The
registry originally covered only `node:child_process`, so EVERY "real-spawn" test (one whose PtyHost
subclass deliberately delegates to the real `createPty` et al. — `mcp-config-secret-lifecycle.mjs` and
every `codex-*-real-spawn.mjs`/`kickoff-real-spawn.mjs` file, which spawn a REAL claude/codex/fake-claude
process to prove something against it) had its own root pid completely untracked: once that root
naturally died (the ordinary, ALWAYS-fires onExit reap — not something the test opted into), NEITHER
branch could recognize it (dead ⇒ no live-enumeration row; never-tracked ⇒ not in the registry either),
and the tripwire wrongly REFUSED the test's own, previously-safe, pre-existing real-spawn pattern — a
real regression discovered only by running `run_gate` (full suite), where ~10 real-spawn test files threw
an identical uncaught `AttachConsole failed`-adjacent crash. Fixed by ALSO wrapping `node-pty`'s own
`spawn` export, via the SAME `wrapSpawnLikeForTestRegistry` helper. `syncBuiltinESMExports()` does NOT
apply here (builtins only) — but it turns out not to be needed: verified empirically that Node's
CJS/ESM interop already gives a named import of an ordinary (non-builtin) CJS package a LIVE-BINDING
getter onto its `module.exports`, so patching `require("node-pty").spawn` before `pty/host.ts`'s own
`import { spawn } from "node-pty"` is ever evaluated is sufficient with no special-casing. Wrapped in its
own try/catch — a native module that fails to load in some environment must never break every OTHER
test's import of this file. **Lesson: when auditing "what's the complete set of real spawn paths",
grep the PRODUCTION code's own imports, not just the one builtin module a fix happens to already touch.**

**Scope decision: the `*Sync` variants (`spawnSync`/`execSync`/`execFileSync`) are deliberately NOT
wrapped.** By the time a sync call returns, its child has already run to completion and exited — there is
no live window in which recording its pid would help a later ancestry check either (the whole reason
branch (b) exists is to cover a pid that's dead by the time it's reaped, and a sync-spawned pid is dead
from the moment its own call returns). A test that needs to reap/kill a pid it created would need to use
one of the 4 wrapped async functions; a pid that only ever existed via a `*Sync` call and is later handed
to a guarded function will correctly fail BOTH branches and be refused, same as any other untracked dead
pid — this is accepted, not a gap, since no committed test does this.

**Wrapper fidelity (card 8c8ee0ee, CR round 1): a bare function reassignment drops the original's own
properties/symbols — `exec`/`execFile` carry `util.promisify.custom`, so `promisify(exec)` would silently
resolve the WRONG shape (not `{stdout, stderr}`) for every caller in the whole suite, since this wrapper
sits under every test file.** Fixed: the wrapper copies every own key (`Reflect.ownKeys`, string AND
symbol) from the original onto itself via `Object.defineProperty`, individually try/caught (skips
`arguments`/`caller`, which throw on access for a strict-mode function, and anything genuinely
non-configurable). The registry bookkeeping itself (`Set.add`) is also wrapped in its own try/catch so a
registry failure can never prevent the real spawn's result from reaching the real caller. Proven
load-bearing with a dedicated test (`guard-child-process-wrap-fidelity.mjs`) — reverting just the
property-copy loop (restoring the bare reassignment) turns `promisify(exec)`/`promisify(execFile)`'s own
checks RED (confirmed: both resolve `undefined.stdout`/`undefined.stderr` instead of the real content),
while the plain callback forms and `spawn`/`fork` stay GREEN either way — this file is kept in the suite
specifically to guard the WHOLE-HARNESS blast radius of a regression here, not just this one card's own
tests.

## The real kill-path grep (verifying the 3 functions are the only ones reachable from a fabricated pid)

Grepped `packages/daemon/src` for every `taskkill`, `process.kill(`, and `.kill(` site. Every OTHER site
in the codebase kills via a CHILD PROCESS OBJECT REFERENCE this exact code spawned moments earlier (a
timeout handler killing its own spawned helper, a git/gate/codescape child's own teardown, `live.pty.kill()`
on the pty THIS session's own node-pty spawned) — never a bare pid NUMBER supplied by a distant caller. A
test cannot fabricate a reference to an unrelated process the way it can fabricate a pid number; that
structural difference is what makes the 3 guarded functions (plus the per-descendant `process.kill()` loop
*inside* `reapOrphanedDescendants`, protected transitively because it only ever walks the REAL OS tree
rooted at an already-verified-legitimate `rootPid`) the complete risk surface for this hazard.

## The behavioral RED proof (per guarded function, in dist — not a missing-export RED)

Running the project's `negative-control` tool (reverting the whole `pty/host.ts` source) only proves the
mechanism is NEW — it fails at import time (`isDescendantPid is not a function`) before ever reaching a
behavioral assertion, which is NOT evidence the tripwire itself refuses anything. The real proof:
snapshot the BUILT `dist/pty/host.js`, then — one function at a time — comment out just that one
function's own `assertReapTargetIsOwnLiveDescendantUnderTest(...)` call (leaving the other two intact),
rerun `pty-root-reap-test-tripwire.mjs`, restore from the snapshot before touching the next function.
Result, confirmed for all three: disabling ONLY `reapOrphanedDescendants`'s call turns exactly its own
"(A)" checks red (and the real `[pty-reap] root=2147483647: found=0 killed=0...` log line appears —
proof the real sweep genuinely ran) while "(C)"/"(D)" (`killProcessById`/`killSingleProcessById`) stay
green; disabling ONLY `killProcessById`'s call turns exactly "(C)" red (`killedPids` now genuinely
includes the sentinel) while "(A)"/"(D)" stay green; disabling ONLY `killSingleProcessById`'s call turns
exactly "(D)" red (`verifyRootDeadOrForceKill` resolves instead of rejecting) while "(A)"/"(C)" stay
green. Each is independent — no function's own check depends on another's call still being present.

## Do not

- Do not treat a live OS ancestry walk (`isDescendantPid`) as sufficient on its own — a target this test
  legitimately spawned but has ALREADY killed before reaping it has NO row in a live enumeration at all;
  the test-spawn registry (branch b) is required, not optional.
- Do not add a per-test opt-in for the registry — it must stay structural, populated by `test/_guard.mjs`'s
  own `child_process` wrap, so a future test author gets coverage without doing anything.
- Do not let `pty/host.ts` import anything from `packages/daemon/test/` to reach the registry — read it
  via `globalThis.__LOOM_TEST_SPAWNED_PIDS__`, which is simply absent (and unread, behind `inTestMode()`)
  in production.
- Do not use an unsafe sentinel pid in any test exercising the RED (tripwire-absent) leg of this
  mechanism — a "very large" pid is not enough: it can still be a REAL live pid on the host, and the real
  `reapOrphanedDescendants`/`killProcessById` kill by platform-native mechanisms (`taskkill` on win32,
  not `process.kill`) that a `process.kill` spy cannot observe or intercept. Use a pid provably
  impossible on every OS — `2147483647` (odd, and Windows pids/tids are always multiples of 4; also above
  Linux's `pid_max` ceiling of `2^22`) — and have the test itself assert `sentinel % 4 !== 0 && sentinel >
  4_194_304` so a later edit can't silently swap in an unsafe value. Apply this to every fabricated pid in
  a test file that exercises these functions with the tripwire reverted or bypassed.
- Do not widen `reapOrphanedDescendants`'s stale-pid/creation-time filtering logic to double as this
  tripwire, or vice versa — they are independent: the creation-time filter (card `2897acc4`) decides which
  DISCOVERED descendant is safe to kill once a sweep is already running; this tripwire decides whether the
  sweep (or a single-pid kill) should ever start at all, given the CALLER's own target pid.
- Do not remove the `REAP_ENUMERATION_TIMEOUT_MS` bound added to `reapOrphanedDescendants`'s own
  enumeration spawn (10s, mirroring `enumerateWin32SweepRows`'s existing default) — before this card that
  spawn had no timeout at all, and a wedged helper could hang the sweep indefinitely, in production too.
- Do not reassign `cp.spawn`/`cp.fork`/`cp.exec`/`cp.execFile` in `test/_guard.mjs` with a bare function
  value again — copy every own key (`Reflect.ownKeys`, string AND symbol) from the original onto the
  wrapper first. `exec`/`execFile` carry `util.promisify.custom`; dropping it silently breaks
  `promisify(exec)`/`promisify(execFile)` for every test (and any production code path that happens to
  promisify these) in the whole suite, with no error pointing at the cause.
- Do not let the registry's own bookkeeping (`Set.add`) inside the `test/_guard.mjs` wrapper run
  unguarded — wrap it in its own try/catch so a bookkeeping failure can never prevent the real spawn's
  result from reaching the real caller.
- Do not accept a "missing export" RED (e.g. `negative-control` against the whole source file) as proof
  the tripwire itself refuses anything — it only proves the mechanism is new. Prove it BEHAVIORALLY: edit
  the BUILT `dist/pty/host.js` to disable one guarded function's own call at a time, confirm only that
  function's own checks go red while the other two stay green, then restore from a snapshot before the
  next function — see "The behavioral RED proof" above.
- Do not assume `node:child_process` is the only real spawn path the registry needs to cover —
  `pty/host.ts`'s own real root-process spawn (`createPty`/`createCodexPty`/`createShellPty`) goes
  through `node-pty`'s OWN `spawn` export, never `node:child_process`. Missing this broke every
  real-spawn test in the suite (the tripwire wrongly refused their own legitimate root pid once it died)
  — caught only by running the full `run_gate` suite, never by any narrower/targeted run. Before trusting
  "the registry covers every real spawn", grep the PRODUCTION code's own imports for every module that
  can create an OS process, not just the one already fixed.
