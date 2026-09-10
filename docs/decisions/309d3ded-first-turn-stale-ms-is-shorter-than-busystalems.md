# sha:309d3ded — a session's FIRST turn uses a much shorter stale-busy threshold than every later turn

## Narrative

`healIfStuck`'s stale-busy clear uses `FIRST_TURN_STALE_MS` instead of the normal, much larger
`busyStaleMs` for a session that has never started its first turn (`!firstTurnStarted`). There's no such
thing as a legitimately long tool call before turn 1 has even started, so stale output at that point already
means something is broken — either the kickoff delivery (`scheduleKickoffGuarantee`) didn't actually reach
the engine, or the engine never got past boot. That failure should surface via the
`onBusy` → `notifyManagerOfIdleWorker` path fast, rather than sit masked as ordinary "busy" for the full
multi-minute window a genuinely long tool call is allowed. Once a real turn has started, the normal, more
generous window applies — the short threshold is deliberately scoped to the pre-first-turn window only.

## Do not

- Do not use `busyStaleMs` for the pre-first-turn window — a session that hasn't started its first turn yet
  can never be legitimately busy for that long, so the normal window would mask a genuinely broken kickoff
  for minutes instead of surfacing it fast.

## Source

Inline JSDoc in `packages/daemon/src/pty/host.ts` (`healIfStuck`'s doc comment, the `FIRST_TURN_STALE_MS`
paragraph). No board card cites this text anywhere in the file or its introducing commits — sourced via
`git blame`, which resolves the paragraph's origin to commit `309d3dedaf5927650fdb92be6d677f7c7752a963`
("fix(orchestration): worker_spawn kickoff doesn't reliably drive the worker's first engine turn — session
sits live with engineSessionId:null until manually nudged"), a real feature/fix commit, not a bulk move or
reformat. A later commit `b4fa85a421ea920a6470fe9839e43e51793c12b5` ("feat(pty): deliver the startup prompt
off argv to remove the Windows command-line ceiling") touched two of the paragraph's lines in a later
rewording pass. Extracted tranche 28.
