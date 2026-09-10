# 51522f05 — Deploy build invokes turbo via absolute node + absolute turbo JS, no shell

## Narrative

Card 51522f05 (done, owner, 2026-06-03, commit `b3a89d9`): the old `daemon_restart`/`buildDaemon` build step ran turbo through a shell (`pnpm exec turbo …`). Inside the daemon's own spawned-process environment, that form failed with EMPTY captured output — no useful error, nothing to debug from. The owner hit this 3× during a deploy before diagnosing it: the earlier "empty error" failures were actually the OLD shell-based `buildDaemon` still running in the not-yet-restarted daemon, since the fix existed on main but hadn't been deployed yet — a reminder that a fix landing on main is not the same as a fix being LIVE in a running daemon (see `CLAUDE.md`'s own "merged ≠ deployed" guidance).

The fix: invoke turbo via `node <absolute-path-to-turbo/bin/turbo>` directly — `shell: false`, so `runBuildStep` execs the child with `args` and no shell, no `PATH` reliance at all (`turboBin()` resolves the absolute path via `require.resolve("turbo/bin/turbo")`, falling back to the conventional `node_modules` path). This is also why `deployBuildSteps`'s `BuildStep` interface carries an explicit `shell: boolean` per step — STEP 1 (`install`) still needs `shell: true` to `PATH`-resolve `pnpm`, but STEP 2 (`build`) deliberately does not.

## Do not

- Do not revert the "build" step back to a shell-invoked `pnpm exec turbo …` form — inside the daemon's own spawned-process env this produced no captured output at all, making a real build failure look like an empty, undebuggable error.

## Source

Inline comment in `packages/daemon/src/orchestration/restart.ts` (`deployBuildSteps`, STEP 2), as of commit `779f3ce7`. Relocated by card `0a525ae1` ("restart.ts, tranche 1"); no wording changed, `//`-prefixed lines joined into a flowing paragraph.
