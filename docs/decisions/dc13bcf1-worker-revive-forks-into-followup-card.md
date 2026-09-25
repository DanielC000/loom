# dc13bcf1 — `worker_revive` forks a merged worker's conversation into a NEW follow-up card

Card `dc13bcf1` (owner request: "when an issue with one of the commits is found later the lead could use the resume feature to resume the old worker and instruct the fix").

## Decision

A manager revives a MERGED worker with `worker_revive({workerSessionId, taskId, note})`. Daemon-side it is `SessionService.reviveWorker` → `spawnWorker` with an internal `revive` spec, so cap admission, the live-worker guard, terminal/held-card refusals and `createWorktree` (a fresh worktree/branch cut from current main) are the ordinary spawn path, not a parallel one.

The mechanism was proved by a real-interactive-claude spike (engine 2.1.282, Windows), not assumed: `--resume <id>` is resolved by id across ALL `~/.claude/projects/*` dirs, so `--resume <old> --fork-session --session-id <new>` from a brand-new cwd continues the conversation even with the source's own cwd deleted. The transcript is NOT relocated or copied. The only blocker was Loom's own ghost-resume guard in `resume()` (`fs.existsSync(session.cwd)`), which a revive never goes through because it is a NEW session row that forks.

## Do not

- Do not reuse `resume()` for a merged worker or relax its ghost-resume guard — a revive is a new row + a fork, so the source row stays exited/archived and untouched.
- Do not resume in place (same engine id): two Loom rows would share one engine transcript and the source transcript would be appended to. Fork, so each row owns its own engine id.
- Do not reopen the merged card or auto-create the follow-up card: `taskId` (a NEW card the manager filed) is required, the original merged task id is refused — the card title becomes the fix's squash subject and reopening would overwrite the original's ship-state.
- Do not detect "merged" from the task column, the branch's existence, `resumability` or the archive flags: a `merge_done` event for the worker is the signal (finalizeMerge appends it for every landing path, including a gate-disabled merge).
- Do not file the link as a `recycle_*` event or set a successor marker on the source: `resume()` refuses on `hasSuccessor`/`recycle_successor_retired` (decision `5a56bb0a`). The link is the `worker_revived` event.
- Do not cap-QUEUE a revive: the queue replays a plain fresh spawn, which would silently drop the fork. A full cap refuses plainly.
- Do not degrade a codex source or a missing/rotated transcript to a fresh spawn: refuse and point at `worker_spawn` on the follow-up card with the commit sha (decision `961da6c6`).
- Do not pass `--model` or a `-n` session name on a revive: like `resume()`/`forkSession()`, the fork inherits the transcript's model, and `-n` alongside `--fork-session` is untested.
