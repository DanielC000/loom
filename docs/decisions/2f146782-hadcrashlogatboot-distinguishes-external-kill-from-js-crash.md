# 2f146782 — `opts.hadCrashLogAtBoot` distinguishes an external kill from a real JS crash

## Narrative

Card 2f146782 (commit `96686a2a2`, "fix(daemon): decouple the self-host daemon from its launching terminal") was filed after the self-hosted daemon died twice in one day because `daemon:stable` ran in the foreground of a hosting terminal: a `powershell.exe` 5.1 PSReadLine `ReadKey`-thread crash, a sleep/reboot, or an unrelated console close killed the daemon mid-execution with NO chance to run any graceful-shutdown or crash handler — taking down every project's live managers/workers with it (see `CLAUDE.md`'s "Self-hosting" section for the fix that made `daemon:stable:detach` the actual remedy for this exposure).

`opts.hadCrashLogAtBoot` records whether `crash.log` already existed the moment this boot started, captured by the caller BEFORE `installCrashHandlers()` rotates it away — i.e. whether the PRECEDING run actually wrote a JS-level fatal record. When `shutdownMarker` is absent (not a clean stop, per `be79aea2`) and this is `false`, the preceding process was killed from outside mid-execution with no chance to run any handler (an OS-level kill, a host sleep/reboot, a crashed hosting terminal) — the `[loom:crash-recovered]` nudge says so ("was killed from outside (no crash record was written)") instead of claiming a JS "crash" that never happened. Omitted (defaults to `true`) preserves the original "crashed" phrasing for every caller that doesn't pass it.

## Do not

- Do not claim a JS "crash" happened when no `crash.log` was written and there's no clean-stop marker either — say the process was killed from outside instead; the distinction tells a manager whether to look for a stack trace or a host-level cause.
- Do not read `hadCrashLogAtBoot` after `installCrashHandlers()` has run — it rotates `crash.log` away, and the flag must reflect the state as this boot started, not after boot-time handler installation.

## Source

JSDoc comment in `packages/daemon/src/sessions/service.ts`, above `recoverCrashOrphanedWorkers`: lines 4868-4874 as of this tranche's HEAD (tranche 14). Introduced by commit `96686a2a2`.
