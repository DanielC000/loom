# 0bc86798 — the root-creation capture retries a transient INFRA failure; a VERDICT is never retried

## Narrative

Card `0d8270b2` found `armRootCreationTime`'s own capture (`PtyHost.captureRootCreationRow`, dispatching
to `enumerateWin32SweepRowForPid`/`enumeratePosixSweepRowForPid`) could fail transiently — a spawn/CIM
error, or the leaf's own internal timeout — and, pre-fix, that single attempt was the session's ONLY
chance: a rejected promise left `live.creationTime` null for the session's WHOLE lifetime, degrading
`verifyRootDeadOrForceKill`'s guard 2 and `computeOrphanSweepPlan`'s live-root-abort to their fail-safe
(under-kill) branch for that session, permanently. That card built a TEST-only retry helper
(`armWitnessWithFreshRetry`, `test/_guard.mjs`) to reproduce/diagnose the issue, deliberately scoped to
test-only; this card ports the same retry shape into PRODUCTION.

## Settled-decision check (card `16b2fb68`'s objection does not transfer)

A sibling card, `16b2fb68` ("retry a transient git timeout in `deploy-staleness`"), was closed WON'T-DO
for a retry in a different subsystem. Its binding objection (project memory
`deploy-staleness-git-timeout-1s-tight-on-windows`, settled, v3) is explicit: *"THE BINDING REASON IS NOT
MARGIN — IT IS THAT [the git calls] BLOCK THE EVENT LOOP"* — `deploy-staleness.ts` issues synchronous
`execFileSync` calls, and a retry there multiplies real daemon-wide freeze time (every session, every
HTTP/WS request, stalls for up to `N × GIT_TIMEOUT_MS`).

That objection is **refuted** for the root-creation capture: both leaf implementations
(`enumerateWin32SweepRowForPid`, `win32-root-creation.ts`; `enumeratePosixSweepRowForPid`, `pty/host.ts`)
spawn via `node:child_process`'s async `spawn` (never `execSync`/`execFileSync`) — fully event-driven
(`.on('data')`/`.on('close')`/`.on('error')`, a `setTimeout`-based bound), returning a `Promise`.
`armRootCreationTime` was already fire-and-forget (`.then()/.catch()`, never awaited on the spawn hot
path) before this card. A retry loop built the same way — `await`ing the promise, `setTimeout`-based
sleep between attempts — adds zero event-loop blocking; it only delays when `live.creationTimeReady`
settles. No other settled decision (87691385/0d8270b2/bf58c19c/b1ea823d/85ae7768) prohibits a production
retry here — `0d8270b2` built the test-only helper precisely because production had none, never ruling
one out.

## The fix

`armRootCreationTime` (`pty/host.ts`) now calls `armRootCreationTimeWithRetry(live, slackMs)`, an async
loop (up to `ROOT_CREATION_CAPTURE_RETRY_ATTEMPTS` attempts, default 5) that retries ONLY a genuine INFRA
failure — `captureRootCreationRow` itself REJECTING (spawn/CIM error, the leaf's own timeout) — with a
bounded, logged backoff (`ROOT_CREATION_CAPTURE_RETRY_BACKOFF_MS`, `[250, 500, 1000, 2000]`ms) between
attempts. A RESOLVED row (even a no-row `null`) is verified exactly ONCE via the pre-existing
`resolveVerifiedRootCreationTime`, and the loop returns immediately regardless of attempts remaining —
"no row", "ppid mismatch", and "slack margin" are all VERDICTs, never retried: retrying a slack-margin
miss would mask a future regression of card `0d8270b2`'s own 20ms-slack fix, and
ppid-mismatch/no-row are already the genuine pid-reuse-adjacent signals this mechanism exists to catch
loudly. This exactly mirrors the test helper's own "only infra retries" design (its own doc, pre-dating
this card).

`live.creationTimeReady` is assigned ONCE, to the whole loop's own `Promise<void>` — never reassigned
mid-loop — so both existing consumers (`reapExitedDescendants`'s onExit path, `verifyRootDeadOrForceKill`
guard 2) keep racing it against their existing bound unchanged. The loop itself never rejects: every exit
path (success, hard reject, exhaustion) resolves, preserving `creationTimeReady`'s documented "never
rejects" contract (`@decision 2897acc4` — the field's own doc comment at its declaration, `Live.
creationTimeReady`/`CodexLive.creationTimeReady`; round 1 of this record wrongly cited `64d7a914` for
this — CR `5518e77c` item 4 caught it and it's corrected here).

**Logging:** each INFRA attempt gets its own bounded line — `attempt n/N` plus the error's name/message
— and a distinct final line on exhaustion ("capture GAVE UP after N attempts, all infra failures"),
under the same pre-existing `[pty-reap-capture]` tag. A VERDICT hard-reject keeps its pre-existing
single-line form (no row / ppid mismatch / slack margin), unchanged from before this card.

**Shared ladder:** `ROOT_CREATION_CAPTURE_RETRY_ATTEMPTS`/`ROOT_CREATION_CAPTURE_RETRY_BACKOFF_MS` now
live in `pty/win32-root-creation.ts` (the side-effect-free leaf, `@decision 85ae7768`) — the one module
already reachable by BOTH production (`pty/host.ts` imports + re-exports it) and the test helper
(`test/_guard.mjs`'s own `loadWin32RootCreationLeaf()` dynamic import, which it already used for
`enumerateWin32SweepRowForPid`/`resolveVerifiedRootCreationTime`). `armWitnessWithFreshRetry`'s own local
`INFRA_RETRY_BACKOFF_MS` const and hardcoded `attempts = 5` default are removed; it now reads both from
the leaf (an explicit `attempts` argument still overrides, for a test that wants a smaller/larger budget).
One source for the ladder, never two copies to drift.

## The accepted residual: total backoff can exceed the consumers' own bound

`ROOT_CREATION_CAPTURE_AWAIT_MS` (3000ms, `pty/host.ts`) is the bound BOTH `reapExitedDescendants` and
`verifyRootDeadOrForceKill` guard 2 race `creationTimeReady` against before proceeding with a null
`creationTime` (fail-safe abort/refuse, `@decision 87691385`). The retry's own total backoff budget — up
to ~3.75s across the default 5 attempts, before even counting each attempt's own CIM-call time — can
exceed that 3000ms bound.

**Consequence:** a session that exits within ~3s of spawn AND whose first capture attempt is a genuine
infra failure still takes today's existing safe-abort path (`creationTime` stays null at the bound) —
identical to the pre-retry single-attempt behavior for that exact window, never worse. This is the SAME
residual already named in `docs/decisions/b1ea823d-test-only-reap-guard-survive-gate-load.md`'s "Do not"
section, residual (iii): *"a capture genuinely slower than `ROOT_CREATION_CAPTURE_AWAIT_MS`."* This card
widens the set of inputs that can land in that residual (an infra failure that would have resolved fast
enough pre-retry can now still be mid-backoff at the 3s mark) — but it never makes an already-null-at-the-
bound outcome worse, since the existing behavior for that exact window was already "null at the bound."
The retry only ever helps: every session that lives past the retry window (the overwhelming majority of
real sessions) now recovers from a transient infra failure instead of losing `creationTime` for its whole
lifetime, which is this card's entire point.

## Round 2 (Code Review `5518e77c`): a CIM failure wasn't actually retried; no structural never-rejects
## backstop; an unvalidated env override; the real worst-case window was never stated

**Item 1 (MAJOR) — a genuine CIM query failure was NOT retried; it silently read as the "no row" VERDICT.**
Round 1's win32 leaf (`enumerateWin32SweepRowForPid`) never checked the spawned `powershell.exe`'s exit
code at all — it resolved unconditionally on `close`, regardless of what the exit code actually was.

**Nit 3 (CR `c44dc616`) — the pre-fix mechanism, re-measured rather than assumed.** Round 1's text here
claimed a `Get-CimInstance` error is "non-terminating by default," producing "empty stdout + exit 0."
Re-running the reviewer's own one-liner against the OLD, UNWRAPPED shape (`powershell -NoProfile
-NonInteractive -Command 'Get-CimInstance Win32_Process -Filter "ProcessId=NaN" | ForEach-Object {1}'`,
no try/catch, no `-ErrorAction Stop`) on this host: **it already exits 1** — PowerShell's own `-Command`
host sets the process exit code on a written error record even though the error is non-terminating to
the pipeline itself (the pipeline continues; the HOST still signals failure via its exit code). **The
pre-fix defect was never "it exits 0 so there's nothing to check" — it is that the old `close` handler
never read the exit code at all, so this already-failing exit was silently discarded either way,** and
the (empty, since the error prevented any row from being emitted) stdout was treated as a clean "no row"
result.

**Fixed:** `win32SweepFilteredCommand` now wraps the query in `try { ... -ErrorAction Stop ... } catch
{ ...; exit 1 }` — not to MAKE the failure exit non-zero (it already did, at least for this induced
failure shape), but to make that exit code EXPLICIT and ROBUST rather than relying on whatever implicit
exit-code behavior PowerShell's host happens to apply for a given error's type/severity, which is not
something this investigation verified holds for every possible CIM failure mode (WMI service down, a
DCOM/RPC error, a permissions failure — only the induced "invalid filter" shape was actually measured).
`enumerateWin32SweepRowForPid` now ALSO checks the exit code — the real fix, since that check never
existed before — non-zero REJECTS (with the captured stderr in the message), exit 0 still resolves (null
on a clean no-row result, a row when one matches). Both leaf doc comments are corrected to match this
measured mechanism, not the originally-assumed one.

**The POSIX leaf (`enumeratePosixSweepRowForPid`) is DELIBERATELY left UNCHANGED in this one respect —
round 2, nit 2 (CR `c44dc616`) corrected an overstatement in round 1's own text here.** A spawn `error`
(the `ps` binary missing, etc.) and the leaf's own internal timeout ALREADY reject today, exactly like
win32 — both are already retried as INFRA failures by the production loop, with no change needed. The
ONE thing left as-is is narrower: `cmd.on("close", …)` never checks the exit code, so a non-zero `ps`
exit (which legitimately happens for "no such pid", but could in principle also mean a genuine `ps`-level
failure) still folds into the same "no row" VERDICT as a clean, matching exit-0-with-no-row result. There
is no reliable way to tell those two non-zero-exit cases apart by exit code alone without a real POSIX
host to characterize the exit-code space (the same disclosed gap as `docs/decisions/bf58c19c-*.md`'s own
"Unverified: no macOS host available" section). Guessing that split without that evidence risks masking a
genuine VERDICT (treating "no such pid" as retryable) or giving up on a transient real failure that
should have retried (treating it as "no such pid") — either direction is worse than today's single,
uniform "fold a non-zero exit into no-row" behavior. Left for a future round with real POSIX access to
characterize against.

**Item 2 (MAJOR) — no structural never-rejects backstop.** Round 1's `armRootCreationTimeWithRetry` never
threw in practice (every path inside it returns rather than throws), but nothing PROVED that structurally
— a future edit adding a throwing call inside the loop would silently break `creationTimeReady`'s
documented contract with no test catching it until a real crash. **Fixed:** `armRootCreationTime` now
attaches `.catch((err) => { live.creationTime = null; ...log...; })` at the single assignment site,
independent of the loop's own internal try/catch — a structural backstop, not a correctness fix for an
observed bug.

**Item 3 (MINOR-to-MEDIUM) — the env override was unvalidated, and the backoff array could hand back a
zero/null backoff past its own length.** Two independent fixes, same item:
- `LOOM_ROOT_CREATION_CAPTURE_RETRY_ATTEMPTS` is now resolved through `resolveRootCreationCaptureRetryAttempts`
  (pure, exported, takes the raw string so a test can drive it without an env var or module reload) —
  clamps to an integer in `[1, 10]`, logging once (at module load, naturally "once per process") when the
  raw value needed any correction (out of range, or merely non-integer).
- `resolveRootCreationCaptureBackoffMs(attempt)` replaces the old raw index into
  `ROOT_CREATION_CAPTURE_RETRY_BACKOFF_MS` — it repeats the ladder's LAST slot for any attempt past the
  ladder's own length (so a raised `ROOT_CREATION_CAPTURE_RETRY_ATTEMPTS` past 4 never retries with a
  zero/null backoff), and applies **+/-25% jitter** to every computed value — the reviewer's own concern:
  many sessions arming their capture near-simultaneously (a fleet-wide boot-reconcile resume, card
  `b1ea823d`'s own crash-recovery path) would otherwise retry in exact lockstep, each one re-hitting the
  CIM/powershell resource at the identical moment. Shared by BOTH production and the test helper
  `armWitnessWithFreshRetry` (one source, same as the attempts/backoff ladder itself).

**Item 3's third sub-fix from the FIRST re-review (bail on `live.alive === false`) is REVERSED here, in
this SAME round, by a second re-review (CR `c44dc616`) of the first re-review's own output.** That first
re-review had the loop check `live.alive` at the top of every attempt and bail immediately if it had gone
false, reasoning that nothing would ever read `creationTime` for an already-dead session. **That reasoning
is wrong — `@decision 2897acc4`'s own S1 finding, from the ORIGINAL card this whole mechanism descends
from, is that node-pty's `onExit` can fire while the real root process is STILL ALIVE.** `live.alive` is
therefore NOT a reliable "nothing left to protect" signal: both consumers that actually read `creationTime`
(`reapExitedDescendants`'s onExit path, `verifyRootDeadOrForceKill`'s guard 2 at `trigger=exit-reap`) read
it AFTER `onExit` has already flipped `alive` to `false` — bailing at that point would leak exactly the
survivor class `2897acc4` exists to catch, for a session whose root is genuinely still running. **The bail
is REMOVED, with nothing put in its place** (no elapsed-since-exit variant, no grace window) — the bounded
`ROOT_CREATION_CAPTURE_RETRY_ATTEMPTS` already caps the cost a post-exit retry can incur: one more query,
resolving no-row or rejecting, never more than the existing attempts budget allows.

**Item 4 (the real worst-case window, and a disclosed latency change).** The leaf's own default
`timeoutMs` is 10 000ms; at the default 5 attempts, the true worst case is **5 × 10s (leaf timeout) +
~3.75s (nominal backoff, before jitter) ≈ 54s** before the retry loop gives up — NOT the "~3.75s of
backoff" round 1's own record emphasized, which covered only the backoff gaps and never stated the much
larger per-attempt timeout budget stacked on top.

**At the CLAMP CEILING (`LOOM_ROOT_CREATION_CAPTURE_RETRY_ATTEMPTS` set to the max, 10 attempts, CR
`c44dc616` nit 4): 10 × 10s (leaf timeout) + ~13.75s (nominal backoff: the four real ladder slots —
250+500+1000+2000ms — plus the last slot, 2000ms, repeated for the remaining 5 gaps) ≈ 114s, or ≈ 117s
accounting for the backoff's own +/-25% jitter ceiling at its worst.** Both figures (the ~54s default and
the ~117s ceiling) describe the SAME mechanism at two different `ROOT_CREATION_CAPTURE_RETRY_ATTEMPTS`
values — cite the one that matches whatever value is actually configured, never the default figure for a
host that has raised the env override.

**The two existing consumers (`reapExitedDescendants`, `verifyRootDeadOrForceKill` guard 2) stay bounded
at `ROOT_CREATION_CAPTURE_AWAIT_MS` (3000ms) regardless of either figure above** — neither ever waits
anywhere close to the full worst case; both give up at 3s and proceed with whatever `creationTime` holds
at that moment (fail-safe, `@decision 87691385`), exactly as before this card.

**The latency change this card DOES introduce, disclosed plainly:** pre-retry, a genuine spawn/CIM error
settled `creationTimeReady` almost immediately (one failed attempt, no backoff). Post-retry, the SAME
spawn-error case now keeps `creationTimeReady` unresolved while it retries — so `reapExitedDescendants`/
guard 2 racing against it will now ALWAYS consume the FULL `ROOT_CREATION_CAPTURE_AWAIT_MS` (3s) wait
before giving up, where pre-fix they would have returned almost instantly. This is a real, if small,
latency cost on the onExit-reap and recycle-verify paths specifically for a session whose FIRST capture
attempt happens to hit a genuine infra failure — traded for the much larger benefit of that session
actually recovering a `creationTime` at all once the retry succeeds (which it usually will, well before
the session's own eventual exit, for any session living more than a few seconds).

**Item 5 — test gaps closed.** (a) Two new scenarios, (w2b)/(w2c), pin the no-row and slack-margin
VERDICTs each making exactly ONE capture call (mirroring (w2)'s existing ppid-mismatch coverage) — RED-
proven via a deliberate dist mutation that made a resolved-but-unverified row ALSO retry (simulating
exactly the regression these tests exist to catch), restored and sha256-verified after. (c) The whole
`(w...)` block no longer gates on `process.platform === "win32"` — it forces `resolveRootReapPlatform()`
-> `"win32"` the same way the pre-existing (v)/(v negative control) darwin-forcing scenarios already do,
so it runs on ubuntu CI too (the retry loop itself is platform-agnostic — it wraps `captureRootCreationRow`,
never a win32-specific code path, so there was never a real reason to gate it to a real win32 host). A
new (w4) scenario proves the OPPOSITE of what the first re-review's own (w4) draft checked, per the
bail-removal above: attempt 1 is a genuine INFRA failure, `live.alive` flips false (simulating `onExit`
firing) DURING the backoff before attempt 2, and attempt 2 still runs and lands a genuine `creationTime`
— never bailed, never skipped. The new leaf-rejection test (item 1) adds
its own RED/GREEN proof, done the same way — a real, induced CIM failure through the REAL leaf function
(never a `captureRootCreationRow` override), with a negative control (a syntactically valid filter that
simply matches nothing) proving the exit-code check doesn't also swallow a genuine clean "no row" result.
A separate pure-function test block drives `resolveRootCreationCaptureRetryAttempts`'s clamp directly
(every input shape — unset, non-numeric, in-range, zero, negative, over-ceiling, at-the-ceiling, non-
integer, empty-string) and `resolveRootCreationCaptureBackoffMs`'s repeat-last-slot + jitter behavior.

## Do not

- Do not retry a VERDICT (no-row / ppid-mismatch / slack-margin) — only a genuine INFRA failure (a
  REJECTED `captureRootCreationRow` call) retries. Retrying a slack-margin miss would mask a future
  regression of card `0d8270b2`'s 20ms slack fix; ppid-mismatch/no-row are already the real pid-reuse-
  adjacent signals this whole mechanism exists to catch loudly.
- Do not make the capture synchronous (`execSync`/`execFileSync`) to "simplify" the retry — that is
  exactly card `16b2fb68`'s rejected shape, and it would block the daemon's event loop for every session,
  every HTTP/WS request, for the duration of each attempt. The capture must stay on `node:child_process`'s
  async `spawn`, with the retry loop `await`ing it and sleeping via `setTimeout`, never a blocking call.
- Do not let `armRootCreationTimeWithRetry` ever reject — `live.creationTimeReady`'s documented contract
  (`@decision 2897acc4`, the field's own declaration-site doc comment) is "resolves once creationTime
  settles, never rejects"; every loop exit (success, hard reject, exhaustion) must resolve, AND the
  structural `.catch()` at `armRootCreationTime`'s own assignment site (round 2, item 2) must stay in
  place as a backstop independent of the loop's own internal try/catch.
- Do not reassign `live.creationTimeReady` more than once per arm — it is set ONCE, to the whole retry
  loop's own promise (wrapped in the structural `.catch()`), so both existing consumers' `Promise.race`
  against it keeps working unchanged.
- Do not duplicate `ROOT_CREATION_CAPTURE_RETRY_ATTEMPTS`/`_BACKOFF_MS` as a second, local constant
  anywhere (production or test) — both read the one pair exported from `pty/win32-root-creation.ts`, and
  both compute an actual backoff value through `resolveRootCreationCaptureBackoffMs`, never a raw array
  index — that function is what repeats the last slot past the ladder's length and applies jitter.
- Do not read this card as closing the `b1ea823d` residual (iii) — it widens the set of attempts that can
  land in it (an infra failure now has up to ~54s worst-case before full exhaustion, not one immediate
  failure), but a session that exits inside `ROOT_CREATION_CAPTURE_AWAIT_MS` with its first attempt still
  failing was ALREADY null at the bound before this card; this card does not make that case worse, and
  does not make the bound itself any tighter or looser.
- Do not widen `ROOT_CREATION_CAPTURE_AWAIT_MS` to "cover" the new retry budget without re-measuring —
  that is a separate design call (how much exit-path latency to accept for a wider safety window), not
  decided by this card.
- (Round 2) Do not resolve a non-zero `powershell.exe` exit code to `null` in the win32 leaf — that is
  EXACTLY the regression this round closes (a real CIM failure silently reading as "no row"). A non-zero
  exit must REJECT; only a clean exit-0 (with or without a matching row) may resolve.
- (Round 2, corrected) Do not claim the POSIX leaf "resolves null on ANY failure" — a spawn `error` and
  the leaf's own timeout already REJECT (retried as INFRA, same as win32). The one thing left as-is, and
  the one a future round needs real POSIX access to split safely, is narrower: a non-zero `ps` exit still
  folds into the "no row" VERDICT, since there is no reliable way to tell a legitimate "no such pid" exit
  from a genuine `ps`-level failure by exit code alone without that evidence.
- (Round 2) Do not cite "~3.75s of backoff" as this mechanism's worst-case window — that figure covers
  only the gaps BETWEEN attempts, never each attempt's own (much larger) `timeoutMs` budget stacked on
  top. The real worst case is ~54s at the default 5 attempts, ~117s at the clamp ceiling (10 attempts,
  accounting for jitter). State the figure matching the ACTUAL configured attempts count, never the
  backoff alone, when describing how long this loop can run before giving up.
- (Round 2) Do not describe this card as latency-neutral — a session whose FIRST capture attempt hits a
  genuine infra failure now holds the onExit-reap / recycle-verify wait for the FULL
  `ROOT_CREATION_CAPTURE_AWAIT_MS` bound (3s) instead of settling almost instantly, pre-fix. Disclose this
  real, if small, latency cost rather than only describing the (much larger) recovery benefit.
- (Round 2, REVERSED within round 2 — CR `c44dc616`) Do not bail the loop on `live.alive === false`. An
  earlier draft of this round added exactly that check and this bullet originally defended it; both are
  wrong. `@decision 2897acc4` S1: node-pty's `onExit` can fire while the real root process is STILL
  ALIVE, so `alive` going false is not proof nothing will ever read `creationTime` again — bailing on it
  leaks exactly the survivor class this whole card exists to catch. Do not replace the bail with an
  elapsed-since-exit variant either; the bounded attempts budget already caps the cost.
