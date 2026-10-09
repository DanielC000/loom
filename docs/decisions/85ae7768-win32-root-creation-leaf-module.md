# 85ae7768 — a side-effect-free leaf module for the win32 root-creation-time primitives

## Narrative

Card `85ae7768` needed `test/_guard.mjs` (imported FIRST by every daemon test, before a test sets its own
`LOOM_HOME`) to reuse `enumerateWin32SweepRowForPid` + `resolveVerifiedRootCreationTime` — the exact,
already-6-review-rounds-vetted predicate `87691385` built — to verify a test-registered root's own OS
creation time, rather than inventing a second, unreviewed capture path.

The LEAD's own review of the first draft of this card rejected importing the full `../dist/pty/host.js`
from `_guard.mjs` for this: `host.ts`'s own transitive imports (`paths.js`/config/db) read/derive
`LOOM_HOME`-adjacent values at MODULE-LOAD time, and a test that spawns before it has set its own
`LOOM_HOME` would freeze the wrong (ambient) paths into that chain the moment `_guard.mjs` first triggers
the import — a silent cross-test hazard, not merely a style preference.

Fix: `enumerateWin32SweepRowForPid`, `resolveVerifiedRootCreationTime`, and their own transitive
dependencies (`isHelperPidCollision`, `parseOrphanSweepLine`/`parseWin32SweepTicks`,
`WIN32_SWEEP_FOREACH_BODY`/`WIN32_SWEEP_PS_COMMAND`, `win32SweepFilteredCommand`,
`enumerateWin32SweepRows`, `ROOT_CREATION_CAPTURE_SLACK_MS`, the `OrphanSweepRow` type) were MOVED
verbatim — not rewritten — into `pty/win32-root-creation.ts`. Its only import is `node:child_process`'s
own `spawn`; no `paths.js`, no config, no db, nothing that reads `LOOM_HOME` or project config at module
scope. `pty/host.ts` re-exports every one of these names from the leaf, so every existing consumer
(production code, and every test that does `const { ... } = await import("../dist/pty/host.js")`) sees a
byte-identical public surface — only the physical file each name is defined in changed.

`computeOrphanSweepPlan` and `ROOT_CREATION_MATCH_TOLERANCE_MS` stayed in `host.ts` — neither is needed by
`_guard.mjs`'s own capture, and moving them would have widened the leaf's surface for no reason.

## The capture itself is OPT-IN, not spawn-kind-narrowed alone

The first draft narrowed the capture to ONE spawn kind (`node:child_process`'s own `spawn` — the only kind
this suite ever hands directly to `reapOrphanedDescendants` as a registered root; never `fork`/`exec`/
`execFile`/node-pty's spawn). That narrowing is necessary but not sufficient: `simple-git` (and most test
helpers) ALSO spawn real processes via that exact same primitive, so EVERY win32 test that spawns anything
via `cp.spawn` — not just the 3 reaper-root files — paid the real capture latency per spawn. **Correction
(CR 85360986): the real single-capture latency is ~560-630ms measured on this host (the filtered-single-pid
CIM query + the helper spawn itself) — NOT the ~100ms this record originally stated.** That ~100ms figure
was a THROUGHPUT artifact (total added wall-clock ÷ spawn count on a file whose many captures overlap
concurrently), not the true per-capture LATENCY — a distinction that matters a great deal here, since
conflating them is exactly what let the MAJOR finding below ship undetected: ~100ms looks small enough to
assume a capture "basically always" lands before a test's own very next line of code; ~560-630ms makes it
obvious it usually does not. Measured on `test/worktrees.mjs` (532 real `cp.spawn` calls, mostly git):
85.7s with always-on capture vs 39.2s with the mechanism absent entirely — a >2x slowdown for one file,
which would cost real minutes across the corpus.

Fixed: the capture is OFF by default, gated by a module-level `rootCreationCaptureEnabled` flag a test
flips via the exported `enableRootCreationCapture()`. Re-measured `worktrees.mjs` with the gate off:
~37.6-41.5s, back in line with the no-mechanism baseline.

**The rule for WHICH tests opt in is not "does this test's own assertion read `creationTime`" — it is:
opt in any test that hands a REGISTERED root to the real reaper.** The card's protection exists FOR
those tests — a dead root a test registers and passes directly to `reapOrphanedDescendants` (no injected
`deps.enumerate`) is exactly the shape that can sweep a real stale-ppid stranger when the root dies, same
as production. Whether the test's own `check(...)` calls happen to assert on `creationTime` is beside the
point; the safety comes from the filter being ARMED during the real sweep, not from the test verifying
it. The first draft of this fix got this wrong — it left `dev-server-teardown.mjs` and
`pty-exit-reap-seam.mjs` opted OUT on the reasoning "their own assertions don't depend on a real
`creationTime`", which left the card's bug live in precisely the files it exists to protect. All three
files that hand a registered root to the real reaper with no injected enumerate
(`dev-server-teardown.mjs`, `pty-exit-reap-seam.mjs`, and `pty-root-reap-test-tripwire.mjs`'s scenarios
(A)/(B)) now call `enableRootCreationCapture()` before their first such spawn. A test that only ever
exercises the WIRING via `deps.enumerate` with fabricated rows and a directly-`.set()` registry entry
(`pty-root-reap-test-tripwire.mjs`'s own (B2)/(B3)) never hands a root to a REAL sweep and stays
unaffected either way — opting in costs it nothing, but it wouldn't need to.

Measured cost of opting the three real-sweep files in (3 runs each, before/after):
`dev-server-teardown.mjs` (5 real `cp.spawn` calls) ~3.08s → ~3.30s (+~0.2s);
`pty-exit-reap-seam.mjs` (1 real `cp.spawn` call) ~1.64s → ~1.71s (+~0.08s);
`pty-root-reap-test-tripwire.mjs` (~4 real `cp.spawn` calls) no measurable overhead above this file's own
multi-second run-to-run noise. Small because these files spawn few processes directly — the >2x
`worktrees.mjs` cost came specifically from `simple-git`'s own high spawn volume, which stays un-opted-in.

## MAJOR (CR 85360986): the capture must be AWAITED and the registry ASSERTED, or the filter is never actually armed

Opting a test in (above) is necessary but not sufficient. `captureTestRegistryCreationTime` is
fire-and-forget ASYNC (~560-630ms real latency); `reapOrphanedDescendants` reads the companion registry
SYNCHRONOUSLY, at the instant it's called. A test that spawns a root and immediately kills/reaps it — the
EXACT shape every real-sweep test used, pre-fix — races that ~560-630ms window and loses almost every
time: the capture settles well AFTER the sweep has already run with `rootCreationTime=null`, and settles
SILENTLY — no thrown error, `CAPTURE_STATS.failed` stays 0 (the capture just finds nothing new to say,
since by then the dead pid has no live row either). `pty-root-reap-test-tripwire.mjs`'s scenario (B) — the
card's OWN primary dead-registered-root case — never actually armed the filter it claimed to exercise.

Fix: `test/_guard.mjs` exports `awaitRootCreationCapture(pid, timeoutMs?)`, backed by a `PENDING_CAPTURES`
map (pid -> the capture's own settlement promise, kept separate from the already-existing
`LOOM_TEST_SPAWNED_PID_CREATION_TIMES` registry so a caller can wait for "has this settled" without
polling). It resolves to `null` IMMEDIATELY (no wait at all) when no capture was ever started for `pid`
(disabled, POSIX, or never registered) — and REJECTS, never resolves `null`, on a real timeout (generous,
10s default — bounds a genuinely wedged capture, not tuned to the common-case latency), so a wedge is an
observable failure, never silently indistinguishable from a legitimate null result.

Every real-sweep call site now: spawns the root, `await`s `awaitRootCreationCapture(pid)` BEFORE anything
else happens to it (BEFORE reading a grandchild pid, BEFORE killing it, BEFORE `host.stop()`), and ASSERTS
the registry holds a positive value for that pid (`dev-server-teardown.mjs`'s two scenarios,
`pty-exit-reap-seam.mjs`'s witness, `pty-root-reap-test-tripwire.mjs`'s (A)/(B)) — win32-gated, since
`awaitRootCreationCapture` correctly resolves `null` on POSIX with no wait. `pty-exit-reap-seam.mjs`'s
witness also had its own lifetime (`setTimeout(() => {}, 50)`) raised to 5s — at 50ms it would have died
of natural causes before the ~560-630ms await ever settled, silently flipping it from "a LIVE registered
root" into "a dead one" and changing which branch of the real tripwire/filter the test actually exercises.

Proved RED->GREEN, re-measured on the tip that also carries (B4) below (CR 165cf2fa, item 3 — the counts
below are the TRUE, re-verified ones, not the pre-(B4) figures an earlier pass of this record quoted):
commenting out `enableRootCreationCapture()` in each real-sweep file turns red exactly `dev-server-
teardown.mjs`: 2 (its own two "...is armed..." assertions), `pty-exit-reap-seam.mjs`: 1 (its witness's
"...is armed..." assertion), `pty-root-reap-test-tripwire.mjs`: **5** — its own (A)/(B) "...is armed..."
assertions (2) PLUS (B4)'s own "the live root's own creationTime is armed" AND both of (B4a)'s checks ("is
NOT aborted" / "the fabricated child WAS recorded as swept") — (B4a) depends on the SAME armed value to
prove the live-root-abort-into-walk transition, so disabling the capture cascades into (B4a) going red
too, on top of the "armed" check itself; (B4b) stays green either way, since aborting is the fail-safe
default a missing capture coincidentally also produces. Restored and confirmed green after, each verified
by sha256 against the pre-mutation file.

## MINOR 2 (CR 85360986): the live-root-abort -> walk transition, both directions

Added `pty-root-reap-test-tripwire.mjs`'s (B4): against a REAL live descendant, `deps.enumerate` supplies
a fabricated occupant row AT the root pid whose `creationTime` either AGREES with the root's own real
captured value (own root proven -> the walk proceeds, a fabricated child IS swept) or DISAGREES (still
aborts, nothing swept) — proving `computeOrphanSweepPlan`'s fail-safe AGREEMENT check specifically, not
merely that a non-null `rootCreationTime` reaches it. `creationTimeFromTestSpawnRegistry`'s own doc
comment (`pty/host.ts`) was reworded to match: it narrows the stale-child filter, and may turn a live-root
abort into a walk ONLY for a pid+creationTime-PROVEN own root — never "never widens" stated bare, which
invited exactly this transition to go unexamined.

## MINOR 3 (CR 85360986): cross-check against an independent read; a ppid/too-late negative case

`pty-root-reap-win32-ticks-real-spawn.mjs`'s own capture section now cross-checks the captured value
against `checkRootSurvival`'s independent CIM-ConvertTo-Json read for the SAME pid (within
`ROOT_CREATION_MATCH_TOLERANCE_MS`), not just internal self-consistency within the capture's own code —
snapshotting the re-entrancy stats BEFORE this cross-check, since `checkRootSurvival` spawns its own real
helper through the same wrapped `cp.spawn` and would otherwise inflate `started` with a second, legitimate
(non-recursive) capture attempt. Also added a `startedAt`-too-late negative case alongside the pre-existing
wrong-ppid one (the predicate's OTHER independently-required check), and an explicit assertion that a row
failing either check is correspondingly absent from the companion registry.

## Round 2 (CR 165cf2fa): a stale inline comment, a pid-reuse write race, a mislabeled check

**Item 1 — two inline comments in `test/_guard.mjs` and `pty-root-reap-win32-ticks-real-spawn.mjs` had
gone stale** against the opt-in RULE correction above (both still said, or implied, "only
`pty-root-reap-win32-ticks-real-spawn.mjs` opts in" and quoted the retracted ~100ms figure) — fixed in
place to state the real rule and point at this record, rather than re-asserting the WHAT a second time.

**Item 2 (the one with real behavioral weight) — only the LATEST capture for a given pid may write the
companion registry.** `captureTestRegistryCreationTime`'s own `.then()` used to write unconditionally. A
pid CAN be reused within one test process's own lifetime (a child dies, the OS hands its number to a
brand-new spawn) — `captureTestRegistryCreationTime` then runs TWICE for the SAME pid, as two independent
promise chains that do not settle in start order. An OLDER capture settling AFTER a NEWER one could
overwrite the newer, correct value with its own stale one — which is exactly what made
`awaitRootCreationCapture`'s own doc claim ("resolves to the SAME value the registry ends up holding")
false in that scenario. Fixed: `PENDING_CAPTURES.set(pid, capturePromise)` already records whichever
capture started MOST RECENTLY for a pid; each capture's own settle handler now checks
`PENDING_CAPTURES.get(pid) === capturePromise` (comparing against its OWN promise, captured by closure)
before touching the registry at all — a superseded capture's result is discarded outright, never written
NOR used to delete. A NEWER capture settling `null` (unverified) additionally DELETES any value an older
capture may have already written, rather than leaving it to squat — the most recent truth about a pid is
"unverified", so an older, possibly-for-a-different-process value must not survive it.

**No dedicated test was added for item 2** — real OS pid reuse within one short-lived test process cannot
be forced deterministically (the same accepted-residual shape as `isHelperPidCollision`'s own un-forceable
collision, `87691385`'s record, round 3 MINOR 3a), and the internal `PENDING_CAPTURES` map/`capturePromise`
closure aren't exposed for a test to simulate it without adding new test-only surface beyond this fix's own
scope. Corrected via the doc/comment fix above instead, per this card's own standing instruction for
exactly this case.

**Item 4 — `pty-root-reap-win32-ticks-real-spawn.mjs`'s own registry-absence check was mislabeled** as if
it tested the PREDICATE's ppid rejection ("a row failing the ppid check is correspondingly NOT stored") —
but the absence it actually proves is already fully guaranteed by a DIFFERENT, independent fact (this pid
is node-pty-spawned, so the cp.spawn-only capture was never even attempted for it), not by the predicate
rejection demonstrated two checks earlier. Relabeled to `[companion registry] a never-captured
(node-pty-spawned) pid has no companion-registry entry` — a registry-absence fact, named as one.

## Do not

- Do not let a capture's own settle handler write (or delete) the companion registry without first
  checking `PENDING_CAPTURES.get(pid) === capturePromise` (this exact call's own promise) — a pid reused
  within one test process's lifetime runs two independent capture chains that don't settle in start
  order, and an older one settling after a newer one must never be allowed to clobber it.
- Do not label a check by what it SOUNDS like it tests rather than what it actually isolates — a
  registry-absence fact proven by "this pid was never fed through the capture pipeline at all" is a
  different claim than "the predicate rejected it", even when both happen to be true for the same pid.
- Do not trust a test that opted in (`enableRootCreationCapture()`) to have actually ARMED the filter —
  the capture is async (~560-630ms); `reapOrphanedDescendants` reads the registry synchronously. A test
  that kills/reaps its root immediately after spawning it races that window and loses almost every time,
  silently (no error, `CAPTURE_STATS.failed` stays 0). `await awaitRootCreationCapture(pid)` and ASSERT
  the registry holds a positive value, BEFORE anything else happens to the pid — every single time.
- Do not give a real-sweep test's own witness/root process a lifetime shorter than the capture's own real
  latency (~560-630ms) — a witness that dies of natural causes before the await settles silently flips
  from "a LIVE registered root" into "a dead one," changing which branch of the filter the test exercises
  (`pty-exit-reap-seam.mjs`'s witness went from 50ms to 5s for exactly this reason).
- Do not opt a test in or out based on whether its OWN assertions read a captured `creationTime` — opt in
  based on whether it hands a REGISTERED root to the real reaper (no injected `deps.enumerate`); that is
  what the filter protects, regardless of what the test happens to check afterward.
- Do not remove the `rootCreationCaptureEnabled` opt-in gate, or widen it to default `true` — the
  spawn-kind narrowing ALONE does not bound the cost (`simple-git` and most test helpers spawn through the
  SAME `cp.spawn` primitive); re-measure a git-heavy file (e.g. `worktrees.mjs`) before ever changing this
  default.
- Do not assume a scenario that only ever exercises the FALLBACK WIRING via injected `deps.enumerate` +
  a fabricated row (e.g. `pty-root-reap-test-tripwire.mjs`'s (B2)/(B3)) needs `enableRootCreationCapture()`
  for ITS OWN sake — set `globalThis.__LOOM_TEST_SPAWNED_PID_CREATION_TIMES__` directly instead, which is
  both platform-agnostic and free. (The gate may still be enabled in that same file for an EARLIER,
  real-sweep scenario sharing it — that's fine; a (B2)/(B3)-shaped scenario is simply indifferent to it
  either way, never harmed by it being on.)

- Do not import `pty/host.ts` (or `../dist/pty/host.js`) from `test/_guard.mjs` to reach these functions —
  that reintroduces the exact LOOM_HOME-capture-at-import-time hazard this card's split exists to avoid.
  Import `pty/win32-root-creation.ts` (or its compiled `dist` path) directly instead.
- Do not add a `paths.js`/config/db import (or anything that reads `LOOM_HOME`/project config at module
  scope) to `pty/win32-root-creation.ts` — its entire reason to exist is staying side-effect-free so a
  test can safely import it before setting its own `LOOM_HOME`.
- Do not duplicate `enumerateWin32SweepRowForPid`/`resolveVerifiedRootCreationTime`'s logic anywhere
  else (e.g. directly inside `test/_guard.mjs`) instead of importing this leaf — a duplicate is exactly
  the "new, unreviewed capture path" this card was explicitly told not to build.
- Do not widen this leaf's exports to include `computeOrphanSweepPlan`/`ROOT_CREATION_MATCH_TOLERANCE_MS`
  or anything else not actually needed by a side-effect-free consumer — keep its surface minimal.
