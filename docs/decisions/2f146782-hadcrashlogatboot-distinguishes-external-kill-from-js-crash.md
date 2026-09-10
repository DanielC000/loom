# 2f146782 — `opts.hadCrashLogAtBoot` distinguishes an external kill from a real JS crash

## Narrative

Card 2f146782 (commit `96686a2a2`, "fix(daemon): decouple the self-host daemon from its launching terminal") was filed after the self-hosted daemon died twice in one day because `daemon:stable` ran in the foreground of a hosting terminal: a `powershell.exe` 5.1 PSReadLine `ReadKey`-thread crash, a sleep/reboot, or an unrelated console close killed the daemon mid-execution with NO chance to run any graceful-shutdown or crash handler — taking down every project's live managers/workers with it (see `CLAUDE.md`'s "Self-hosting" section for the fix that made `daemon:stable:detach` the actual remedy for this exposure).

`opts.hadCrashLogAtBoot` records whether `crash.log` already existed the moment this boot started, captured by the caller BEFORE `installCrashHandlers()` rotates it away — i.e. whether the PRECEDING run actually wrote a JS-level fatal record. When `shutdownMarker` is absent (not a clean stop, per `be79aea2`) and this is `false`, the preceding process was killed from outside mid-execution with no chance to run any handler (an OS-level kill, a host sleep/reboot, a crashed hosting terminal) — the `[loom:crash-recovered]` nudge says so ("was killed from outside (no crash record was written)") instead of claiming a JS "crash" that never happened. Omitted (defaults to `true`) preserves the original "crashed" phrasing for every caller that doesn't pass it.

## The supervised-path half: `env.LOOM_PRIOR_CRASHLOG`

`crashlog.ts`'s own `hadCrashLogAtBoot()` — the function that actually computes the boolean above — is `fs.existsSync(CRASHLOG_PATH) || env.LOOM_PRIOR_CRASHLOG === "1"`. `env.LOOM_PRIOR_CRASHLOG` (Code Review finding #2 on this card) covers the SUPERVISED path (`daemon:stable`), where `fs.existsSync` alone is NOT enough: `scripts/daemon-supervisor.mjs`'s own `rotateCrashlog()` already rotates crash.log→.prev immediately before EVERY daemon launch — so by the time this process could check, a real prior crash's record is already gone regardless of whether this boot is a crash-recovery boot at all. The supervisor sets this env var ONLY when its own rotation genuinely moved a file, so on that path it is the sole source of truth — never asserted speculatively. `fs.existsSync(CRASHLOG_PATH)` alone remains correct only on the UNSUPERVISED (shipped, supervisor-less) path, where THIS boot's own rotation is the only thing that will ever move the file.

## Do not

- Do not claim a JS "crash" happened when no `crash.log` was written and there's no clean-stop marker either — say the process was killed from outside instead; the distinction tells a manager whether to look for a stack trace or a host-level cause.
- Do not read `hadCrashLogAtBoot` after `installCrashHandlers()` has run — it rotates `crash.log` away, and the flag must reflect the state as this boot started, not after boot-time handler installation.
- Do not trust `fs.existsSync(CRASHLOG_PATH)` alone on the SUPERVISED (`daemon:stable`) path — the supervisor's own pre-launch rotation already moved the file by the time this process could check; use `env.LOOM_PRIOR_CRASHLOG` there instead.

## Source

JSDoc comment in `packages/daemon/src/sessions/service.ts`, above `recoverCrashOrphanedWorkers`: lines 4868-4874 as of this tranche's HEAD (tranche 14). Introduced by commit `96686a2a2`. Second site: JSDoc comment in `packages/daemon/src/crashlog.ts`, above `hadCrashLogAtBoot`: originally lines 21-35 (tranche 1 on `crashlog.ts`). Same introducing commit `96686a2a2`.
