# d671f1b8 — `daemon_restart` runs the shared vault-flush/codescape-stop cleanup, deliberately AFTER the response-flush delay

## Narrative

The same bare `process.exit()` gap that motivated `docs/decisions/f05e5a06-daemon-restart-awaits-merge-danger-window-since-exit-emits-no-signal.md` also meant this path never ran `gracefulShutdown`'s vault-flush / codescape-stop cleanup (`setShutdownCleanup`) — a vault edit still inside its debounce window at restart time was silently dropped from git (recoverable on the NEXT edit to that vault, but not before). Fixed by invoking that same shared cleanup from inside the exit-flush timer, deliberately AFTER the 300ms MCP-response-flush delay rather than before it: the cleanup's vault half runs a bounded-but-potentially-multi-minute `execSync` git flush (`VaultVersioner.flushSync`, bounded at `VAULT_FLUSH_WORKING_TREE_TIMEOUT_MS` = 5min for the working-tree-scale calls), and running it BEFORE `setTimeout` would delay the MCP response itself by however long that flush takes. Running it AFTER means the caller's response is unaffected; only the actual process exit (which nobody is waiting synchronously on) is delayed by however long the flush takes — same trade `gracefulShutdown` already accepts for a manual `loom stop`. `shutdownCleanup` is `undefined` until `index.ts` registers it post-boot — a restart requested in that brief window skips the flush, but there's nothing to flush yet either way (the vault watcher isn't running), so this degrades to the pre-fix behavior, never worse.

## Residual risk (accepted, documented, not eliminated)

A timed-out `git add -A`/`git commit` inside `flushSync` does not stop the real `git.exe` child — it ABANDONS it, and the orphan keeps running and holding `.git/index.lock` for the rest of its own duration (project memory `[[execsync-timeout-kills-only-the-shell-on-windows]]`: one measured case landed its commit ~8s after the bound fired). This path is the one place that risk is sharpest: the supervisor relaunches almost immediately on exit 75, so a fresh daemon could boot straight into a lock an orphan from the PREVIOUS process still holds — unlike a crash exit (`crashlog.ts`'s handlers, deliberately excluded from this same cleanup for exactly this reason) or a graceful `loom stop`, neither of which triggers an immediate relaunch to race against. Judged low rather than zero: this needs `git add -A` to exceed `VAULT_FLUSH_WORKING_TREE_TIMEOUT_MS` (5min), which steady-state measurements put at ~100ms — only a pathological vault reaches it. No guard added: `flushSync`'s own try/catch already degrades a lock-contention failure to a logged warn + `false` (never a throw or a hang) if a fresh boot's own flush attempt collides with a still-held lock.

## Do not

- Do not run the shared cleanup's vault-flush half BEFORE the 300ms MCP-response-flush timer — it must run inside/after that timer, or a multi-minute git flush delays the response itself.
- Do not add a guard against the residual orphan-lock risk here — `flushSync`'s own try/catch already degrades lock contention to a logged warn, never a throw or hang; the risk is judged low, not zero, and accepted as documented.
- Do not run this cleanup from `crashlog.ts`'s crash-exit handlers — they deliberately exclude it, since a crash doesn't trigger an immediate relaunch to race against.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`requestDaemonRestart`'s top-of-function doc, the "Card d671f1b8" + residual-risk paragraphs): originally lines 3471-3499, as of this tranche's HEAD. Relocated by card `9f4f8e5a` (tranche 7); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
