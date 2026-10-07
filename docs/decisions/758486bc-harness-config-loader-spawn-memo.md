# 758486bc — fold the harness-config loader's two spawns into one per call (NO cross-call cache)

## Why

Card 758486bc discriminated the emit-compare scan's intermittent event-loop-gap failure (case (I) in
`test/emit-compare-gate-test-importers.mjs`): a reduced gate's merge op `4e3246c5` failed first-attempt
with `max event-loop gap observed during the call: 763ms`, and a prior gated pass (`16b04cd2`) failed the
same way with `1328ms`, both retrying clean in isolation.

Temporary `performance.now()` instrumentation (committed nowhere, reverted after measurement) localized
the gap: it did NOT trace to `scanTestImporterClosureInChildProcess`'s own spawn (consistently small,
11–385ms observed under load) or to the real corpus's directory-walk/file-read work (correctly isolated
off the host loop inside that child, per card fca110cf/72769424's round 4). It traced to
`loadHarnessSetExport`'s own `spawn()` call — observed sync costs from ~10ms up to 947ms under host
contention, with the stall window measured to overlap the spawn's own duration almost exactly.

The mechanism: Node/libuv's `child_process.spawn()` runs Windows `CreateProcess` synchronously on the
calling thread (not the threadpool), so under host contention its duration is variable and can spike into
the hundreds of ms. `computeEmitCompareGate` could issue up to 3 such spawns per diff before this card
(the test-importer scan, `NOT_HERMETIC`, and conditionally `EXCLUDED_DIR_NAMES`) — all inside the daemon's
own process at real merge time, so this was a genuine daemon-wide-stall risk under load, not merely a
test-threshold artifact.

## The fix — CURRENT state (after round 4; see "History" below for what was tried and removed)

1. Fold the two separate `NOT_HERMETIC` / `EXCLUDED_DIR_NAMES` child spawns (`loadHarnessSetExport`,
   called once per export name) into ONE combined spawn (`loadHarnessSetExports`) that evaluates
   the harness script once and reads both exports off the same module object. **Still live, unchanged
   since round 1** — this is the one genuine, durable win this card keeps. (Round 5 collapsed what had
   briefly been two functions here — `loadHarnessSetExportsUncached` plus a trivial `...Combined` forward
   left over from the round 1-4 cache's removal — back into this one function; see "Do not" below.)
2. `computeEmitCompareGate` itself shares that ONE spawn's promise between BOTH its lazy locals
   (`excludedDirNames`/`notHermeticNames`) via its own local `loadHarnessSetExportsOnce` closure (round 4)
   — never by calling the public per-field wrappers (`loadExcludedTestDirNames`/`loadNotHermeticNames`)
   independently, which would each spawn on their own. A diff needing BOTH sets in one call still pays for
   exactly one spawn. **There is no cross-call cache** — every call to `loadHarnessSetExports`
   (directly, or via either per-field wrapper) spawns fresh, unconditionally. A round 2-3 content-hash memo
   sat here between those rounds and round 4; it was found unsound and then dead in practice, and was
   removed rather than patched further — see "History" below for why.
3. The event-loop-gap test itself (`emit-compare-gate-test-importers.mjs` scenario (I)) bounds the probe's
   observed gap against a CONCURRENT baseline-spawn sampler, run in an isolated helper CHILD PROCESS (round
   3) so its own spawn cost never shares this test's event loop with the probe it's bounding:
   `max(500ms, 3 × observed baseline spawn round-trip)`. See "Test power" below for current measurements.

The child-process isolation of the harness-config load itself is NOT removed or weakened by any of this —
the harness file is worker-writable code (card fca110cf), so it must still be evaluated in a killable
child, never in-process or in a worker_thread sharing this process's own V8 heap.

## History — a content-hash memo was tried (rounds 1-3), found unsound then dead, and removed (round 4)

Rounds 1-3 added a content-hash-keyed memo (`loadHarnessSetExportsCombined`) on top of the fold above,
bounded to a tiny LRU, intended to let a REPEATED gate against an unchanged harness source skip the
config-loader spawn entirely. It went through three review rounds before being removed outright — kept
here so nobody re-invents the same approach without first reading why it failed.

**Round 2 — one CRITICAL, one MAJOR, two minor, all fixed at the time:**

- **CRITICAL — the baseline sampler (then still in-process) absorbed the very stall it was meant to
  normalize against**, by timing each sample via a `'close'`-event round-trip instead of the synchronous
  `spawn()` cost alone. Fixed by bracketing only the synchronous call with `performance.now()`.
- **MAJOR — the cache key hashed `test-daemon.mjs` alone, but the script is not a leaf.** It statically
  imports a small closure of sibling files; an entry-only hash served a stale result across a sibling-only
  edit. Fixed (at the time) by walking the real static-import graph and hashing the whole closure, failing
  closed if the closure couldn't be proven complete.
- **Minor — a cached mechanism failure could poison a later healthy call;** fixed by never caching a
  failure. **Minor — concurrent same-key callers shared the first caller's `timeoutMs`;** documented, not
  changed.

**Round 3 — three MAJOR cache-soundness gaps, one TOCTOU minor, all "fixed" at the time (closure-hash
rulings (a)/(b)/(c) and a re-derive-after-settle check) — see round 4 below for why none of this
survived:**

- Ruling (a): a non-relative, non-`node:` specifier was silently skipped rather than failing the hash
  closed.
- Ruling (b): a closure file could reach arbitrary content through `require`/`createRequire`/
  `import.meta.resolve`, none of which are static-import edges the AST walk follows — fixed with a textual
  (not AST) check for those three substrings. **Caught in round 3's own first draft, before review:** the
  check was first written as a bare, case-sensitive `text.includes("require")` —
  `"createRequire".includes("require")` is `false` (capital `R`), so it would have missed its own
  motivating probe. Fixed by lower-casing both sides before comparing.
- Ruling (c): the entry file's exports could be built from something other than a literal `Set` of string
  literals (e.g. reading a JSON file via `fs.readFileSync` — not a static import specifier, so never part
  of the hashed closure); fixed with a dedicated AST precondition requiring both exports to be
  `new Set([<string literals only>])`.
- TOCTOU minor: the closure's files could change between the hash read and the spawn settling; fixed by
  re-deriving the hash after settling and dropping the cache entry if it no longer matched.
- Separately, round 3 moved the event-loop-gap test's baseline sampler into an isolated helper child
  process — this part of round 3 is NOT removed; it is CURRENT (see "The fix" above).

**Round 4 — the whole memo was REMOVED, not patched again, after Code Review found it both unsound and
already dead on the real corpus:**

- **MAJOR 1 — the memo NEVER hit in practice on this repo's own real harness.** Ruling (b)'s
  `includes("require")` text check (even case-fixed) matches ordinary ENGLISH PROSE, not just code: this
  repo's real `packages/daemon/scripts/test-daemon.mjs` contains comments using the words "require"/
  "requires" and references `requireHermeticEnv` — so the hash ALWAYS returned `null` on the real file,
  and the cache layer was dead weight from the moment it shipped. A merge still paid 2 spawns, identical to
  before the card — the "Residual cost" section an earlier version of this record carried (claiming a
  warm-memo saving) was describing a SYNTHETIC-fixture measurement that never reproduced on the real
  corpus, and has been struck rather than corrected in place.
- **MAJOR 2 — even granting a hit, at least 7 MORE shapes would have served a stale result,** none of
  which any AST precondition can close in general: `.add(...)` after a literal init, a shadowing local
  `class Set`, `export let` + later reassignment, a top-level-await-gated `.add(...)`, an import built via
  `new Function(...)`, an `eval(...)`-constructed export, and a `process.env`-driven conditional add. The
  precondition was fighting an open-ended problem, not a closed one.

Given a memo that never actually hit AND still had an open-ended unsoundness surface, round 4's ruling was
to remove the entire mechanism — closure hashing, both AST preconditions, the LRU, the TOCTOU re-hash —
rather than add an eighth patch. The replacement (see "The fix" above) is deliberately simpler: every call
spawns fresh, and the only sharing left is WITHIN one `computeEmitCompareGate` call, between its own two
lazy locals — which needs no cache, no hash, and has no staleness surface to close because nothing is ever
retained past the call that produced it.

Verification for round 4: a spawn-count POSITIVE CONTROL
(`test/harness-config-child-load.mjs` scenario (d)) proves a single `computeEmitCompareGate` call needing
both `EXCLUDED_DIR_NAMES` and `NOT_HERMETIC` still issues exactly one spawn — reproduced RED by reverting
the shared-promise call sites back to two independent per-field loads (confirmed `spawnCount() === 2`),
then restored, verified byte-identical via sha256. A FRESHNESS scenario (b) proves an entry edit, a
sibling edit, and an fs-read-JSON edit are all seen on the very next call — trivially true now, since
nothing is ever cached on any shape.

## Round 4 MINOR 3 — the event-loop-gap sampler's own argv index bug caused a spawn storm

`emit-compare-gate-test-importers.mjs`'s `BASELINE_HELPER_SOURCE` (the round-3 isolated helper process)
read its period argument as `process.argv[2]`. Under `node -e "<code>" arg1 arg2`, argv carries NO
placeholder for the eval string itself — `process.argv` is `[execPath, arg1, arg2, ...]` — so the real
first argument (`BASELINE_PERIOD_MS`) landed at `argv[1]`, not `argv[2]`. Reproduced directly: a bare
`node -e "console.log(JSON.stringify(process.argv))" x` logs `[execPath, "x"]`. The bug read `undefined` ⇒
`Number(undefined)` ⇒ `NaN`, and `setInterval(sample, NaN)` clamps to Node's minimum delay — measured
directly: 66 child spawns in ~2.2s in isolation (vs. the intended ~1-2/sec at the real 1500ms period), and
195-399 samples over a full ~17-23s scenario-(I) run (pre-fix observed range) vs. 11-13 after the fix — a
genuine spawn storm contending with the very scan this sampler exists to measure against, not a quiet
periodic probe. Fixed: read `argv[1]`, and fail loud (non-zero exit, stderr message) if the resolved
period isn't a positive finite number.

⚠️ **CORRECTED (Code Review round 5) — the round-4 version of this paragraph claimed the fail-loud helper
guard alone meant "this exact class of bug can't silently regress again." False: the TEST ITSELF ignored
the helper's stderr and exit code, and never asserted `baselineSamples > 0` — so reverting `argv[1]` back
to `argv[2]` (re-arming the very bug this section describes) still exited the whole file 0, reporting "0
sample(s) … bound = 500ms" as an ordinary, passing run.** A dead/sample-less helper collapses `gapBoundMs`
to the bare 500ms floor, which a healthy-ish real gap can clear by sheer luck — an uninformative PASS, not
a measurement. Fixed: scenario (I) now captures the helper's stderr and real exit code and asserts
`baselineSamples > 0` with no non-zero exit, BEFORE the event-loop gap check — reproduced RED by reverting
to `argv[2]` again (confirmed: 0 samples, helper exit code 1, the new check fails with the captured stderr
folded in), then restored, verified byte-identical via md5. The helper's own guard is necessary (it turns
a silent NaN-storm into a loud, attributable failure) but was never sufficient on its own — the TEST had
to actually look.

## Test power — current measurements (round 4: argv fix + sampler isolation both in effect)

Re-run 3× on this host's ordinary ambient load (not a controlled baseline):

| run | gap (ms) | bound (ms) | baseline samples |
|-----|----------|------------|-------------------|
| 1   | 570      | 3718       | 13                |
| 2   | 415      | 1439       | 11                |
| 3   | 117      | 1322       | 13                |

All 3 pass, with a sane baseline sample count (11-13, matching the ~1500ms period over a ~17-20s scan —
the storm is gone). RED power re-proven by forcing the test-importer scan back in-process in `dist`
(reverting `scanTestImporterClosureInChildProcess` to a direct, in-process `scanTestImporterClosure`
call): gap=16850ms vs. bound=5481ms — a clear, correctly-detected FAIL — then restored, verified
byte-identical via sha256.

⚠️ **Historical note:** earlier measurements in this file's prior revisions (an in-process-sampler round-2
table showing gap/bound pairs like 18635/500, and a round-3 isolated-sampler table showing 677/4725,
97/7017, 999/4040) were taken under the argv-storm bug described above and/or an earlier sampler shape —
they are not directly comparable to the table above and are not repeated here; see git history for that
file's own prior content if the exact superseded figures are ever needed for provenance.

## Do not

- Do not re-add a cross-call cache for the harness-config load (closure hashing, an LRU, a TOCTOU
  re-check, or any AST precondition gating it) without first re-reading "History" above — the exact
  approach was tried for three review rounds, found to NEVER hit in practice on the real corpus (MAJOR 1),
  and still open-ended unsound even when it did hit (MAJOR 2, at least 7 shapes enumerated). Every call
  spawning fresh is the correct, final shape, not a placeholder for a future cache.
- Do not hash or memoize anything keyed on the harness script's content — if a future need for
  cross-call sharing arises, re-derive the justification from scratch against this file's own MAJOR 1/2,
  don't assume a smarter precondition closes the gap.
- Do not call `loadExcludedTestDirNames`/`loadNotHermeticNames` independently from within
  `computeEmitCompareGate` — always route through its own `loadHarnessSetExportsOnce` shared promise, or a
  diff needing both sets pays for two spawns instead of one.
- Do not move the harness-config load in-process or into a `worker_thread` to avoid the spawn cost — the
  child-process isolation is load-bearing (fca110cf) because the harness script is worker-writable code;
  spawn COUNT (fixed by the fold, item 1 above) is the only thing this card ever reduced, never the
  isolation boundary.
- Do not let a load error on the harness script silently resolve to a cached or empty-but-truthy result —
  `loadHarnessSetExports` fails closed to `null` per field on ANY failure (spawn error, timeout,
  non-zero exit, bad JSON); a caller getting `null` must fail the whole diff closed.
- Do not re-split `loadHarnessSetExports` back into a bare spawn function plus a trivial forwarding
  wrapper (round 5 collapsed `loadHarnessSetExportsUncached` + `loadHarnessSetExportsCombined` back into
  this one function) — with no cross-call cache left to layer on top, a second function here only ever
  forwarded its arguments unchanged; it added a name to track, not a behavior.
- Do not measure the event-loop-gap test's baseline spawn sampler (or any future contention proxy) via a
  `'close'`/`'exit'` event round-trip — it can't fire until the host loop is free, so it absorbs exactly
  the stall it's meant to measure against. Bracket only the synchronous `spawn()` call itself with
  `performance.now()`.
- Do not run that baseline sampler in-process alongside the probe it bounds — its own `spawn()` call
  shares the same event loop the probe is watching, so a sample straddling it inflates the printed gap
  with the sampler's own cost, not only production's. It runs in its own isolated helper child process.
- Do not pass that helper's own arguments assuming `node -e`'s argv includes a placeholder for the eval
  string — it does not; the first real argument lands at `argv[1]`. Keep the helper's own fail-loud check
  on a non-finite/non-positive period, but do not rely on that check ALONE (round 5) — the TEST must also
  capture the helper's stderr/exit code and assert `baselineSamples > 0` with no non-zero exit, BEFORE the
  gap check, or a dead/sample-less helper collapses `gapBoundMs` to the bare floor and can still pass by
  luck.
