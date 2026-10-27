# 293beb47 — survive an EMFILE/ENFILE spawn failure inside simple-git instead of crashing the daemon

Found by a Code Review of card 05915fc7 (reviewer 087152f2, 2026-10-27), reasoned from Node and simple-git
source. This card reproduced it for real in a scratch process (never the daemon), then implemented the fix.

## The crash mechanism

Node's own EMFILE/ENFILE early-return (`lib/internal/child_process.js`, verified against the real
v22.16.0 source) skips stdio setup entirely when the OS refuses to hand out a new file descriptor —
`pid`/`stdout`/`stderr`/`stdin` all stay `undefined`, and the child only emits `'error'` LATER,
asynchronously, via `process.nextTick`.

simple-git 3.36.0's own `GitExecutorChain.gitResponse` (`dist/esm/index.js` — the build our ESM daemon
actually resolves to, see below) does `spawned.stdout.on("data", ...)` with NO optional chaining, BEFORE
it ever reaches `spawned.on("error", ...)` a few lines later. For this one shape, that line throws (a
`TypeError`, since `stdout` is `undefined`) — and because the throw happens first, simple-git's own
`'error'` listener is never attached. When Node's deferred `'error'` then fires on a child with zero
listeners, Node's own default behavior is to throw it: an uncaught exception. Verified directly in a
scratch process against the real installed package (full stack trace into the real
`simple-git@3.36.0/dist/esm/index.js`), both bare (Node's own "Unhandled 'error' event" default) and with
a `crashlog.ts`-shaped `uncaughtException` handler installed (it does not swallow this — it logs and
calls `process.exit(1)`). The daemon dies either way.

The synchronous `TypeError` from `spawned.stdout.on(...)` itself is NOT the crash — a throw inside a
`new Promise((resolve) => {...})` executor is caught by the Promise constructor and becomes an ordinary
rejection. The actual, unavoidable crash vector is the SEPARATE, deferred `'error'` event Node schedules
independently, which has nothing listening on it because the throw happened one line before the listener
would have been attached.

## Call-path survey

`killableCanonicalRaw`/`spawnCanonicalGitTree` (`git/bounded.ts`) do NOT share this hole. Both of that
function's dispatch paths (`rawViaDirectSpawn`, `rawViaWinJobLauncher`) already use
`child.stdout?.on(...)`/`child.stderr?.on(...)` (optional chaining) before attaching
`child.on("error", ...)` — so the synchronous throw this fix exists to prevent can never happen there.
Verified empirically against the real `spawnCanonicalGitTree` export via its own `spawnImpl` test seam
(not just read from source): feeding it the same EMFILE-shaped fake child rejects cleanly with a
classified `EMFILE` error, zero crash. This fix is scoped to simple-git-constructed instances only.

## Upstream check (no fix exists)

`npm view simple-git versions` lists up to `4.0.2` at the time of this investigation (a major bump past
our `3.36.0`). Downloaded both tarballs via `npm pack` (read-only, never executed) and diffed
`gitResponse`: structurally identical in 4.0.2 — `k.stdout.on("data", ...)` / `k.stderr.on("data", ...)`,
still no optional chaining, still before `k.on("error", ...)`. The hole is present in the current latest
release; a dependency bump would not fix it, and 4.0.0's own breaking changes (ambient env vars no longer
passed to the git child by default, only an explicit allow-list) would add real migration risk across
every one of this codebase's construction-chokepoint callers for no benefit. Not recommended.

## The ESM snapshot-binding finding (the load-bearing part of this fix)

`packages/daemon` is `"type":"module"` (ESM). `import { simpleGit, ... } from "simple-git"` resolves,
via simple-git's own `package.json` `exports["."]["import"]` condition, to `dist/esm/index.js`, which does
`import { spawn } from "child_process"` — a STATIC named import. The CJS build (`dist/cjs/index.js`,
what `require("simple-git")` resolves to) instead does `import_child_process = require("child_process")`
once, then calls `(0, import_child_process.spawn)(...)` — a property access at call time, so mutating
`child_process.spawn`'s property is observed there.

Verified empirically, twice, that the ESM build's `spawn` binding is a fixed snapshot, NOT a live getter
over the builtin module's current `spawn` property:

1. Imported both the default export (`cp`) and the named `spawn` binding from the same specifier in one
   file, mutated `cp.spawn`, then called the ORIGINAL imported binding directly — the mutation was not
   observed.
2. To rule out "maybe it's just capture-order, and patching strictly BEFORE simple-git's module is ever
   evaluated would work": built a dedicated guard module whose only job was the patch, statically
   imported it FIRST in a harness (so its top-level body runs to completion, per ES module evaluation
   order, before anything else in the harness), THEN dynamically `await import()`ed simple-git's real
   ESM build only afterward. Still not observed — the ESM build's own `spawn` binding never saw the
   patch, even though the patch provably completed before simple-git's module was ever linked/evaluated.

Conclusion: for Node's builtin `child_process` module specifically, the ESM named-export binding is not
derived from a live read of the underlying exports object at import-link time — it is fixed independently
of ordering. There is no legal JS-level workaround for this from the consuming side alone.

### The fix: `node:module`'s `syncBuiltinESMExports()`

Node's own API for exactly this case. After mutating `child_process.spawn`, calling
`syncBuiltinESMExports()` re-syncs every live ESM named-import binding derived from a Node builtin module
to that module's CURRENT exports. Verified empirically (real ESM `dist/esm/index.js`, real `git.raw()`
call) that this works, and — separately verified — that it works regardless of whether it is called
before or after simple-git's own import was evaluated (i.e. it is not order-sensitive the way the raw
mutation alone is). This is why `installEmfileEnfileSpawnGuard()` can be called from inside
`boundedSimpleGit()` itself (idempotent, first call only) rather than needing a special placement relative
to the file's own `import { simpleGit, ... }` — ordering relative to that import does not matter.

## Why this is necessarily process-wide

There is no simple-git plugin hook or construction option that runs before, or in place of, its internal
`spawn()` call — `_plugins.exec("spawn.after", ...)` only ever runs AFTER the vulnerable code already
executed. The only available interception point is the actual Node builtin `child_process` module simple-
git calls into, which means this guard patches `child_process.spawn` for the WHOLE daemon process, not
merely calls originating from `git/bounded.ts`. There is no narrower chokepoint available.

This was judged an acceptable scope because:
- `node-pty` (every agent-session pty) does not go through `child_process.spawn` at all — it is a
  separate native binding — so it is entirely unaffected.
- The guard's detection signature (`pid`/`stdout`/`stderr`/`stdin` ALL `undefined`) can only ever fire for
  the genuine EMFILE/ENFILE early-return shape. Verified against three real, unmocked shapes: a real
  ENOENT (binary not found) spawn's `pid` is ALSO `undefined`, but its `stdout`/`stderr`/`stdin` are real
  stream objects, so the all-four check correctly leaves it untouched; a real successful spawn obviously
  has all four populated. So every OTHER spawn call site in the daemon (gate-runner, worktree dep-
  provisioning, the win-job-launcher dispatch itself, markitdown/playwright MCP spawns, python venv
  provisioning) is unaffected in the ordinary case, and would only ever be touched by this guard in the
  one scenario where it was already about to crash the daemon the same way simple-git would have.

## The `.code` reclassification layer

simple-git's own `GitError` wrapping DISCARDS the original spawn error's `.code`/`.errno`/`.syscall`
entirely: for the 'error'-event-received shape this guard exists to prevent crashing on, simple-git sets
the thrown error's `.message` to the ORIGINAL error's `.stack` string (verified empirically — `e.message`
is literally `"Error: spawn EMFILE\n    at ..."`, and `e.code`/`e.errno` are `undefined` on the resulting
`GitError`). So a caller checking `.code` on a rejection needs a reclassification layer; simple-git does
not provide one. `classifySpawnResourceExhaustionCode()` matches Node's own long-stable `ErrnoException`
message format (`"spawn <file>"` with the OS-level `code`) against the first line of that embedded stack.

This is applied via `withSpawnFailureClassification()`, a Proxy wrapping EVERY method of a constructed
`SimpleGit` instance (not just `.raw()`) — grepped `packages/daemon/src` and found several callers invoke
`.commit()`/`.status()`/`.revparse()`/`.log()`/`.diff()`/`.init()` directly on a
`boundedSimpleGit`/`canonicalGit`-constructed instance, none of them chained/fluent (every call site
awaits a single direct method call), so a narrower `.raw()`-only wrap would have missed those. A non-
promise return (e.g. simple-git's own synchronous `.env()`, which returns `this`) passes through
untouched — only a thenable result is ever `.catch()`-wrapped.

## Rejected alternatives

- **`pnpm patchedDependencies` patch of simple-git itself.** Rejected: it would not ship to
  `npm i -g loomctl` end users, whose install resolves `simple-git` unpatched from the public registry —
  `patchedDependencies` only rewrites the dependency inside THIS workspace's own `pnpm-lock.yaml`.
- **A `createRequire` pivot of `git/bounded.ts`'s own `simple-git` import, forcing Node to resolve the
  CJS build instead.** Considered first (the CJS build's property-access `spawn` lookup is directly
  patchable with no ESM wrinkle at all), and would have been a clean, single-file change (grep confirmed
  `git/bounded.ts` is the ONLY file in `packages/daemon/src` importing the simple-git VALUE — every other
  construction-chokepoint caller imports only `import type { SimpleGit, ... }`, erased at compile time).
  Rejected once `syncBuiltinESMExports()` was found to work: it keeps the ESM import untouched, which is
  simpler and carries zero risk of a `GitError`/`GitResponseError`/etc. `instanceof` mismatch between two
  different loaded instances of the same package (a risk that was audited for the CJS-pivot plan and
  found to be moot here, since `instanceof` checks against simple-git's own error classes were not found
  anywhere in `packages/daemon/src` or `test/`, and the ESM-untouched fix never introduces a second loaded
  module instance of simple-git in the first place).

## Round 2 — Code Review NOT-SHIP on commit 949fdb0e (B1/B2/S3), then fixed

The round-1 regression test used a hand-rolled `EventEmitter` to fake the EMFILE-shaped child, driven by a
manual `process.nextTick(() => { child.emit("error", ...); child.emit("close", ...); })`. That fake was
never a real `ChildProcess`, so it never exercised Node's REAL internal `onexit`/`onErrorNT` code path —
the test (and the author) were blind to two real defects the review caught by driving a genuine
`new cp.ChildProcess()` whose `_handle.spawn` is overridden to return `process.binding("uv").UV_EMFILE`
directly (Node's own real `ChildProcess.prototype.spawn` then runs its real, unmodified internal logic
from that return value onward).

- **B1 (Critical, reproduced):** Node's real `_handle.onexit` (`node:internal/child_process` ~:277) does
  `if (this.stdin) this.stdin.destroy()` BEFORE it emits `'error'`. The round-1 stub's `stdin` was a plain
  `EventEmitter` with no `.destroy` — that call threw a `TypeError` inside the `process.nextTick` callback,
  which is itself an UNCAUGHT exception (the exact crash this guard exists to prevent), and because the
  throw happened before `'error'` could even be emitted, `simple-git`'s `gitResponse` promise never
  settled either — `await git.raw(...)` hung. Reproduced directly against commit 949fdb0e with a real
  `ChildProcess` fixture: `UNCAUGHT: TypeError: this.stdin.destroy is not a function` plus a
  "Detected unsettled top-level await" exit. Fixed: the stubs are now real `stream.PassThrough` instances
  (`stubSpawnFailureStdio()`) — `.destroy()`/`.pipe()`/`.setEncoding()`/`.resume()` all work correctly on
  them, for simple-git and for any other process-wide caller of this guard. `stdout`/`stderr` are ended
  immediately (no data will ever arrive); `stdin` is NOT pre-ended, so a caller's own synchronous write
  right after spawn doesn't hit "write after end" — but it is NOT durably open either (round 3, N1
  correction below): Node's own real `onexit` destroys it one tick later regardless.
- **B2 (Major, reproduced):** `SPAWN_RESOURCE_EXHAUSTION_RE` was anchored to a bare `"spawn EMFILE"`, but
  Node's real syscall is `"spawn " + spawnfile` — the real message is `"spawn git EMFILE"` (confirmed via
  the same real-`ChildProcess` fixture), or, in win32 production, `"spawn C:\Program Files\Git\cmd\git.exe
  EMFILE"` (spaces and all). The round-1 regex never matched production's real shape. Fixed:
  `/^Error: spawn.* (EMFILE|ENFILE)$/m` — matches the first line ending in the code, regardless of what
  (if anything) sits between `"spawn"` and the code.
- **S3 (Major, test defect):** the round-1 test reset its `uncaughtException` flag to `null` at the START
  of each scenario block and checked it immediately after that scenario's own `await`. Under a sync-
  ablation (removing just `syncBuiltinESMExports()`), the actual crashes fired LATE enough that they were
  attributed to the WRONG (later) scenario, and the per-scenario reset erased evidence of the real
  failures — every "(B)/(C)/(D) no uncaughtException" check read PASS even though the fix was broken.
  Fixed: a single cumulative `uncaughtExceptions` array that is NEVER reset across the whole file, each
  scenario records the array's length before/after and explicitly drains with
  `await new Promise((r) => setImmediate(r))` before checking the delta — `setImmediate` anchors to the
  event loop's own "check" phase boundary (after Node's nextTick queue, where the real crash path runs,
  has fully drained), not an arbitrary time duration, so this is not the fixed-wait-guarding-a-negative-
  assertion shape `fixed-wait-negative-guard.mjs` polices.
- **4:** the guard's `console.warn` text started with `"[git]"`, misleadingly implying git-specific scope
  for a guard that is honestly process-wide — renamed to `"[spawn-guard]"`.
- **5:** this file's own doc comment on `installEmfileEnfileSpawnGuard` claimed it installs "at module
  load time" — it does not; it installs lazily, on the process's first `boundedSimpleGit()` call. Fixed.

## Round 3 — Code Review NOT-SHIP on commit 4eb8916f (B-a), then fixed

The round-2 fix made the crash mechanism itself sound (confirmed: 10/10 real-`ChildProcess` EMFILE/ENFILE
cases reject in 1-9ms with the right `.code`, one warning, zero uncaught), but introduced a NEW hole:
`classifySpawnResourceExhaustionCode` could misclassify a genuinely DETERMINISTIC git failure as transient
fd exhaustion, if that failure's own message happened to contain an EMFILE/ENFILE-shaped line anywhere.

- **B-a (reproduced):** `SPAWN_RESOURCE_EXHAUSTION_RE` used `/m`, so `^`/`$` matched at ANY line, not just
  the first. Reproduced directly: a throwaway repo with a `pre-commit` hook that fails the commit (exit 1)
  while printing `Error: spawn npx EMFILE` on stderr line 2 (simulating a hook's own `npx` subprocess
  genuinely hitting EMFILE, unrelated to git itself) made `boundedSimpleGit(...).commit(...)` reject with
  `.code === "EMFILE"` and ZERO guard warnings — a real, deterministic git failure (a lint hook refusing
  the commit) silently reclassified as the TRANSIENT shape this whole card exists to recover from. Before
  this card, simple-git's `GitError` never carried `.code` at all, and `isTransientSpawnErrorCode`
  (`git/worktrees.ts`) is documented as a STRUCTURED check, never message text — this card's own `.code`
  reclassification layer was the thing that newly made a message-text match flow into
  `mergeMainIntoWorktree`'s `transient:true` path, telling a manager "nothing was changed, re-confirm will
  retry" for a failure that will never resolve on retry. The shared `.git` is worker-writable, so the hook
  text is forgeable by anything with write access to it — this is a real, not merely theoretical, attack
  surface. Fixed, both layers:
  1. **A structural tag, not a text pattern.** `stubSpawnFailureStdio`'s `'error'` listener (registered
     BEFORE simple-git's own, so it runs first on the SAME event and its mutation is visible to every
     listener after it) appends a per-process, cryptographically random marker
     (`` `[loom-spawn-guard:${crypto.randomBytes(16).toString("hex")}]` ``, minted once at module load as
     `SPAWN_GUARD_STACK_MARKER`) to `err.stack` — confirmed by reading simple-git's own `onErrorReceived`
     (`dist/esm/index.js`): it does `target.push(Buffer.from(String(err.stack), "ascii"))` at the moment
     the `'error'` listener runs, which is exactly when the mutation is already in place.
     `classifySpawnResourceExhaustionCode` now REQUIRES this exact marker to be present in the message
     before it will classify anything at all — text planted on git's own stderr by anything outside this
     module can never contain it, at any line, since nothing outside this process can read a value that
     exists only in this process's own memory.
  2. **Also dropped `/m` and anchored at the message start:** `/^Error: spawn[^\n]* (EMFILE|ENFILE)(?:\n|$)/`
     — belt-and-suspenders on top of (1), since a message-start anchor alone doesn't close the forgeable-
     text hole (a hook could still forge line 1), but combined with (1) neither layer alone is load-bearing
     in a way the other can't also catch. NOTE: the reviewer's own suggested literal had a space between
     `spawn` and `[^\n]*` (`"spawn [^\n]*"`) — that requires TWO spaces between `spawn` and the code, which
     the real no-spawnfile message (`"Error: spawn EMFILE"`, exactly one space) can never satisfy. Caught
     by this card's own unit test for that exact edge case; fixed to `spawn[^\n]*` (no space before the
     `[^\n]*`), matching the same shape round 2's own (correct) `spawn.* ` already used.
  Verified: the hook-repro above now returns `code=undefined` and the classifier call on the exact forged
  text returns `undefined`; the real-`ChildProcess` EMFILE/ENFILE suite still returns the correct `.code`
  for every case. `tagErrorWithSpawnGuardMarkerForTest()` (exported, TEST-ONLY) lets a unit test exercise
  the shape-matching regex without a full `ChildProcess` fixture, by appending the same real marker to a
  plain `Error`'s `.message` directly.
- **N1 (wording):** the comment and this record both said stdin "is deliberately left OPEN" — reproduced
  that Node's own real `onexit` destroys it ONE TICK LATER regardless (confirmed: `stdinDestroyed=true`
  shortly after the 'error'/'close' sequence settles, independent of anything this guard does). The real,
  narrower property being protected is only that a caller's own SYNCHRONOUS `.write()`/`.end()` right
  after spawn doesn't immediately hit "write after end" — not that stdin stays open durably. Wording fixed
  in both the source comment and this record; no behavior change (still a `PassThrough`, still not
  pre-ended here).
- **N2 (no change):** scenario (D)'s `close(0)`-after-`'error'` override is unreachable on any real Node
  code path (real EMFILE/ENFILE always closes with a negative errno — see (B)/(C)) — it is defense-in-
  depth for a synthetic shape only. The guard code itself needed no change; the test now labels (D)'s own
  checks explicitly as covering a synthetic-only shape, so a future reader doesn't mistake it for another
  real-Node reproduction like (B)/(C).

## Do not

- Do not stub EMFILE/ENFILE stdio with a plain `EventEmitter` again — see "Round 2" B1 above; Node's real
  `onexit` calls `.destroy()` on `stdin` before emitting `'error'`, and a plain EventEmitter doesn't have
  one. Use `stream.PassThrough`, as `stubSpawnFailureStdio()` does.
- Do not remove or skip the `syncBuiltinESMExports()` call after mutating `child_process.spawn` — without
  it, the mutation only ever reaches a `require("simple-git")`-shaped (CJS) consumer, which this codebase
  does not have, and does nothing for the real ESM-resolved production path. The regression test for this
  file must FAIL if that call is removed — that is the control proving the test reaches production's path.
- Do not narrow the detection signature to `pid` alone, or widen it to any proper subset of
  `{pid, stdout, stderr, stdin}` — a real ENOENT spawn's `pid` is ALSO `undefined` with real stdio, so
  only the all-four-`undefined` check stays false-positive-free.
- Do not anchor `SPAWN_RESOURCE_EXHAUSTION_RE` to a bare `"spawn EMFILE"` again — see "Round 2" B2 above;
  Node's real syscall always includes the spawnfile, which can itself contain spaces (an absolute win32
  git.exe path). Match the end of the first line, never a fixed literal.
- Do not classify on message text alone, ever again, even with the message-start anchor from B2/B-a
  combined — see "Round 3" B-a above; a worker-writable shared `.git` can plant a matching line on git's
  OWN stderr. `classifySpawnResourceExhaustionCode` must always require `SPAWN_GUARD_STACK_MARKER` first.
- Do not remove the `child.once("error", ...)` stack-tagging in `stubSpawnFailureStdio`, and do not
  register it AFTER anything that might itself attach a listener to the same child — it must run FIRST on
  the `'error'` event so simple-git's own listener (registered later) observes the already-tagged `.stack`.
- Do not say stdin is "deliberately left open" again — see "Round 3" N1 above; Node's own real `onexit`
  destroys it one tick later regardless. The real property is only "a caller's synchronous write right
  after spawn doesn't immediately fail", not durable openness.
- Do not assume the stubbed EMFILE/ENFILE child can resolve as a false SUCCESS — a REALISTIC fake must
  emit `'close'` with the real negative libuv errno as its exit code (NOT `0`, and NOT `null` — a `null`
  exit code was tried during this card's own test-writing and made simple-git resolve the call as if it
  had succeeded; verified against Node's own source that a real EMFILE/ENFILE `'close'` fires with
  `(exitCode, signalCode) = (<negative errno>, null)`, never `(null, null)`). The guard itself does not
  rely on this being true forever: it tracks whether `'error'` fired on the stubbed child and, if so,
  forces any later `'close'` on that SAME child to a non-zero code — verified directly with an adversarial
  fixture that emits `'error'` then `'close'` with code `0` (a shape real Node never actually produces)
  and still gets a rejection, never a resolve. Do not remove that forcing — it is defense-in-depth against
  a shape that cannot occur in production today, not dead code.
- Do not rely on simple-git's own `GitError`/`GitResponseError` to carry `.code`/`.errno` — it does not;
  use `classifySpawnResourceExhaustionCode()` (message-based) instead of adding a second, independent
  classifier elsewhere.
- Do not add a blanket `process.on("uncaughtException", ...)` swallow as an alternative to this fix — the
  daemon's existing `crashlog.ts` handler is correct to log-and-exit for a genuinely uncaught error; this
  fix instead prevents the error from ever becoming uncaught for this one classified, recoverable shape.
- Do not test this with a hand-rolled `EventEmitter` fake standing in for the whole EMFILE/ENFILE child
  again (round 1's own defect) — drive a REAL `new cp.ChildProcess()` with `_handle.spawn` overridden to
  return `process.binding("uv").UV_EMFILE`/`UV_ENFILE`, so Node's real internal `onexit`/`onErrorNT` code
  actually runs. A hand-rolled fake is acceptable ONLY for a scenario that is deliberately testing an
  impossible-in-real-Node shape (e.g. the adversarial close(0)-after-error case), never for the primary
  EMFILE/ENFILE reproduction itself.
- Do not reset a cumulative crash-tracking flag per scenario in a test that shares one process across
  several scenarios — see "Round 2" S3 above; keep one array that only ever grows, and explicitly drain
  the event loop (`setImmediate`, not a fixed `setTimeout`) before reading the per-scenario delta.
