# 8ced1ce2 — `crashlog.ts`'s own fatal-exit handlers reject a bounded vault flush

## Narrative

A bounded flush was considered and rejected in `installCrashHandlers`'s `uncaughtException`/`unhandledRejection` handlers — ⛔ NOT because a bounded `execSync` can hang this handler (project memory `[[execsync-timeout-kills-only-the-shell-on-windows]]` measured the timeout option reliably returning control within its bound: ~511ms observed on a 500ms cap — so that fear is false for a genuinely short bound). The real reason is what that SAME memory measures on the OTHER side: a timed-out `git add -A` does not stop the real `git.exe` child — it ABANDONS it, and the orphan keeps running and holding `.git/index.lock` for the rest of its own duration (one measured case: the orphan's commit landed ~8s after the bound fired). On a large vault `git add -A` reliably exceeds a short bound rather than occasionally (11.6s measured cold on a 20k-file vault vs. a 2-3s cap) — so a short bound here would not merely fail to help sometimes, it would routinely leave a lock behind. The crash paths already accept the deferred-commit cost (no supervisor relaunch to race against — the orphan has as long as it needs to finish and release the lock before a human restarts anything), so adding a flush attempt here would trade a benign wait for a NEW, self-inflicted failure mode with nothing to show for it.

This is a distinct decision from `docs/decisions/d671f1b8-daemon-restart-runs-shared-vault-flush-cleanup-after-the-response-flush.md`: that record covers WHY the exit-75 restart path's shared cleanup runs its flush after (not before) the MCP-response-flush delay; this one covers WHY the crash-exit handlers here don't attempt any bounded flush of their own at all.

## Do not

- Do not add a bounded-timeout flush attempt to `crashlog.ts`'s `uncaughtException`/`unhandledRejection` handlers on the theory that a short `execSync` timeout is safe — the timeout does return control reliably, but the abandoned `git.exe` child keeps holding `.git/index.lock` for the rest of its own duration, and a large vault's `git add -A` reliably exceeds a short bound rather than occasionally.
- Do not treat this as the same decision as `docs/decisions/d671f1b8-daemon-restart-runs-shared-vault-flush-cleanup-after-the-response-flush.md`'s ordering choice — that record is about *when* the shared restart-path cleanup runs its flush; this one is about *whether* the crash-exit path should attempt a flush of its own at all.

## Source

JSDoc comment in `packages/daemon/src/crashlog.ts`, above `installCrashHandlers` (the "A bounded flush was considered and rejected here" paragraph): originally lines 247-259 (tranche 1). Introduced by commit `8ced1ce28f3e87627d1a4ac1e6d4f17779de043f` ("fix(daemon): flush vaults and stop codescape on the restart exit path"). Cites no board card; keyed by commit sha per the extraction program's `sha:` grammar.
