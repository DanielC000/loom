# 40f572f7 — accept `isSpawnLevelFailure`'s text-based classification; do not widen 293beb47's spawn guard for this

Split from card `122eb237` (worker `9dbec6de`'s checkpoint, 2026-10-28; lead ruling). That card already
established `isSpawnLevelFailure` (`git/worktrees.ts` ~8400-8402) classifies a git failure as TRANSIENT by
matching `/^Error: spawn /` on message TEXT, because simple-git@3.36.0 discards the real spawn error's
`code`/`syscall`/`errno` before any of its 3 callers ever see it — see `122eb237`'s own record for that
proof. This card investigated whether a guard-verified, non-forgeable marker (generalizing `293beb47`'s
EMFILE/ENFILE spawn guard) is worth building to close the residual forgery gap. **Ruling: no — document
as an accepted residual instead.**

## The 3 callers, and the single consumer they all converge on

`isSpawnLevelFailure` has exactly 3 call sites (verified by grep, no others):

- `findAllLandedTrailerCommits`'s catch (`git/worktrees.ts:8269`) — on a spawn/timeout failure, throws
  `GitTransientReadFailure`; any other failure (including a `CanonicalGitRefusal`) returns `[]`
  (definitive).
- `resolveObjectKind`'s catch (`git/worktrees.ts:8433`) — on spawn/timeout, returns `{kind:"transient"}`;
  else `{kind:"missing"}` (definitive). `resolveObjectKind` (`git/worktrees.ts:8421`) is itself called
  ONLY from `fullTreeEntries` (`git/worktrees.ts:8464`, call at `8467`) and `stampedPathsPlausible`
  (`git/worktrees.ts:8533`, call at `8540`) — verified by grep, no other callers anywhere in the repo.
- `verifyReviewedTipChain`'s catch (`git/worktrees.ts:10170`) — sets
  `{ok:false, reason, transient:true}`.

`findAllLandedTrailerCommits` has exactly ONE caller: `attributeStaleGenerationOwnLanding`
(`sessions/service.ts:27913`, call at `27965`). `fullTreeEntries`/`stampedPathsPlausible` are each called
ONLY from that same function (`service.ts:27979`, `28002`) or from `recordedTipContentLanded`
(`git/worktrees.ts:8586`), itself called ONLY from that same function (`service.ts:27994`).
`verifyReviewedTipChain` has 3 callers: two merge-confirm sites (`service.ts:20378`, `22161`), each
carrying its own `@decision 1e7d6956` comment — read directly, not assumed — stating they deliberately
IGNORE `chain.transient` and refuse on ANY chain failure, transient included (`1e7d6956`'s own "Do not"
confirms this is the correct, conservative behavior there, per `bbccf470`). Only the third call site
(`service.ts:28022`, also inside `attributeStaleGenerationOwnLanding`, read at `28031`) ever reads
`.transient`.

**So every one of the 3 functions' "transient" signals converges on exactly ONE consumer:**
`attributeStaleGenerationOwnLanding` / `resolveStaleGenerationOwnLanding`, the stale-generation
own-landing reconcile path (`05915fc7`'s own family).

## The bounded worst case

Read every `console.warn`/nudge-text call site on that path (`service.ts` ~27775-27886): none of them
ever interpolates the raw caught error's `.message`/`.stack` — only structured fields (worker id prefix,
branch, task id prefix, project name, candidate sha prefixes, attempt count, age-in-days). A wrong
classification here can only ever do one of two things: (1) delay a transient-row's `[loom:merge-orphaned]`
nudge past its real give-up point — still bounded at `staleGenerationTransientEscalateAttempts`/`_Ms` (3
boots / 1 day, `05915fc7`'s own S1), after which it escalates anyway; or (2) cause one *extra* nudge to
fire slightly earlier than it otherwise would on a definitive miss misclassified as transient-then-retried.
**Neither path ever reaches a merge, a deletion, or a trust decision** — it only ever shifts the timing of
a one-shot, self-describing alert to a human. This is a p3 timing nuisance, not a correctness or security
hole with teeth.

## Forgery analysis (required by the card)

Three candidate designs were evaluated for a guard-verified, non-forgeable classification:

### (a) Generalize `293beb47`'s marker beyond EMFILE/ENFILE

`293beb47` (`git/bounded.ts:36-129`) mints a per-process `crypto.randomBytes(16)` marker
(`SPAWN_GUARD_STACK_MARKER`), module-private — verified by grep across `packages/daemon/src`: it is
referenced ONLY inside `bounded.ts`, never exported, never logged anywhere. A listener registered on the
child's `'error'` event, BEFORE simple-git's own listener, appends it to the real spawn error's `.stack`.
simple-git's `GitExecutorChain.onErrorReceived` (verified directly against the installed
`simple-git@3.36.0` ESM build, `node_modules/.pnpm/simple-git@3.36.0/.../dist/esm/index.js`) does
`target.push(Buffer.from(String(err.stack), "ascii"))` — a **byte-value copy** of `.stack`, pushed into a
buffer that eventually becomes the final `GitError.message` once the task settles. The marker survives
as literal text, on a line AFTER the real `"Error: spawn ..."` text (appended with a leading `\n`).

Traced every consumer reachable from the 3 call sites above: none logs the raw multi-line `.message` —
only structured summaries (see "The bounded worst case"). `verifyReviewedTipChain`'s own `reason` text
(the one place `122eb237`'s record says is "shown to a human") is built from
`e.message.split("\n")[0]` — first line only — so even there the marker, which rides a later line, can
never surface.

**One real, but pre-existing and unrelated, leak path:** `onErrorReceived` also calls simple-git's own
internal `debug`-package logger (`logger('[ERROR] child process exception %o', err)`) against the
**original**, unmutated-reference error object — if an operator ever ran the daemon with
`DEBUG=simple-git*` or `DEBUG=*` set, this would print the marker-bearing stack to the daemon's own
stderr (captured into `<LOOM_HOME>/logs/daemon-output.log` per this project's self-hosting docs). Checked:
nothing in this repo sets or enables that `DEBUG` namespace. This is a property `293beb47`'s
*already-shipped* mechanism already has today — generalizing it to more spawn-failure shapes does not
introduce or worsen this; it is named here for completeness, not as a new finding against this card.

Generalizing (a) is mechanically straightforward: detach the marker-tagging `child.once("error", ...)`
listener from the EMFILE/ENFILE-only `stubSpawnFailureStdio` gate so it fires on every spawned child's
`'error'` event unconditionally (leaving the stdio-*stubbing* — the actual crash-prevention fix — gated on
its existing all-four-`undefined` signature check, unchanged), then add a new exported predicate
alongside `classifySpawnResourceExhaustionCode`, e.g.
`isGuardVerifiedSpawnFailure(e): boolean { return message.includes(SPAWN_GUARD_STACK_MARKER) &&
/^Error: spawn /.test(message); }`, for `isSpawnLevelFailure` to delegate to instead of its bare regex.

### (b) A per-process secret nonce never logged

Not a distinct design from (a) — it is the property (a) already has. Adopting (a) is adopting (b); there
is nothing further to evaluate separately.

### (c) An out-of-band `WeakSet` of guard-tagged error objects

**Infeasible — confirmed directly against the installed `simple-git@3.36.0` source, not assumed from any
prior record.** The error reaching `onErrorReceived` is never retained by reference anywhere a `WeakSet`
lookup at a catch site could use: `onErrorReceived`'s callback pushes
`Buffer.from(String(err.stack), "ascii")` — a byte copy, not the object — into a stream/buffer, and the
final `GitError` is constructed from that buffer's concatenated content once the task settles. No code
path hands the ORIGINAL `ChildProcess`-error object (or any reference to it) to anything downstream of
`onErrorReceived`; only a byte-for-byte string snapshot of `.stack` survives. A `WeakSet` keyed on the
original object is therefore unreachable at every one of `isSpawnLevelFailure`'s 3 call sites, which only
ever see the simple-git-constructed `GitError`. (Separately checked `onFatalException`'s
`new GitError(task, e && String(e))` branch — used for a *synchronous* task-handler throw, a different
code path than the deferred async `'error'` case this card is about — it also discards the original
object; same conclusion either way.)

## Ruling: document as accepted, no production change

(a)/(b) together describe a sound, buildable fix. It was **not implemented**, because the fix would widen
`293beb47`'s process-wide spawn guard — crash-prevention code that is merged but **not yet deployed** at
ruling time (card `4e762baf`'s family: the daemon runs from `dist/`, and a merge alone is not a restart) —
by attaching a listener to, and mutating `.stack` on, **every** child spawn in the daemon process, for the
sake of correcting the TIMING of a bounded, one-shot, already-self-describing nudge on a p3 card. That is
too much blast radius on load-bearing, not-yet-live code for what this residual actually costs. The
existing text-match heuristic (`/^Error: spawn /.test(e.message)`, verified locale-independent by
`05915fc7`'s own record) stays as-is.

## The ONE sound route, if this ever actually matters — and the condition that would justify it

If a future consumer of `.transient`/`{kind:"transient"}` from any of these 3 functions ever turns that
signal into a **merge decision, a deletion, or a trust/escalation decision that a human cannot later
reverse by re-running a boot** (as opposed to today's sole consumer, which only ever delays or
duplicate-triggers a one-shot advisory nudge) — THEN, and only then, implement (a)/(b) as scoped above:
generalize `293beb47`'s marker-tagging to every spawn's `'error'` event (not just the EMFILE/ENFILE
signature), export `isGuardVerifiedSpawnFailure` from `git/bounded.ts`, and have `isSpawnLevelFailure`
delegate to it instead of its bare regex. At that point the forgery gap stops being a timing nuisance and
starts being a real integrity hole worth the wider blast radius on the spawn guard.

## Do not

- Do not add a new consumer of `.transient`/`{kind:"transient"}` from `isSpawnLevelFailure`,
  `resolveObjectKind`, or `verifyReviewedTipChain` that feeds a merge, deletion, or trust/escalation
  decision, without first revisiting this record and implementing the marker-based fix above — the
  "accepted residual" ruling here is conditioned entirely on every current consumer being a bounded,
  reversible, one-shot advisory nudge. A new consumer that is NOT that shape reopens this card.
- Do not re-derive the forgery analysis for (a)/(b)/(c) from scratch if this is revisited — re-read this
  record first; the `simple-git@3.36.0` source findings (the by-value buffer copy in `onErrorReceived`,
  the `onFatalException` `String(e)` branch, the inert-unless-`DEBUG`-is-set internal logger call) were
  verified directly against the installed package, not assumed, and do not need re-verifying unless
  simple-git is upgraded past `3.36.0` (see `122eb237`'s own record for the same caveat on its own
  findings).
- Do not treat the `DEBUG=simple-git*`/`DEBUG=*` logger-leak note above as a defect introduced by this
  card — it is a pre-existing property of `293beb47`'s already-shipped marker mechanism, unrelated to
  whether `isSpawnLevelFailure` is ever generalized to use it.
- Do not implement (c) (a `WeakSet` of guard-tagged error objects) under the mistaken belief that a future
  simple-git version might preserve object identity across `onErrorReceived` — re-verify against the
  specific installed version's own source before ever revisiting that option, the same way this record
  did; do not assume the finding transfers across a major version bump without checking.
