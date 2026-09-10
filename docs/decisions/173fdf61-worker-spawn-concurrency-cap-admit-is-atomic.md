# sha:173fdf61 — the concurrency-cap admit is atomic, co-located with the per-taskId claim

## Narrative

The concurrency-cap admit is co-located with the per-taskId claim (see the sibling `sha:93a496a0`
record) so the cap decision and the reservation share ONE no-`await` window — same TOCTOU class as the
per-taskId race, on the cap axis instead. The old check `liveWorkers >= cap` counted only LIVE DB rows
and ran BEFORE `await createWorktree`, but a worker row is inserted only AFTER that await. So N
concurrent `worker_spawn` calls for DIFFERENT taskIds each observed `liveWorkers` unchanged (none had
inserted yet) and all admitted — the fleet overshot `maxConcurrentWorkers` by up to N-1.

Counting the in-flight claims (each WILL become a live worker) closes it: by the same ATOMICITY PROOF as
the per-taskId claim, each racing call runs its synchronous prefix to completion — through this admit AND
the `.add()` — before the next call's prefix is scheduled (the first `await` is `createWorktree`, below),
so call K observes the (K-1) prior claims already in the set. Checked BEFORE `.add()`, so `size` excludes
self: with cap C and L live workers, exactly C-L calls admit and the rest are rejected with the existing
message — each BEFORE `createWorktree`, so a rejected spawn leaves no orphan worktree/branch.

## Do not

- Do not check the concurrency cap against only live DB rows — count in-flight claims too, or N
  concurrent spawns for different taskIds can all observe the same stale `liveWorkers` and overshoot the
  cap by up to N-1.
- Do not check the cap AFTER `.add()` — check before, so `size` excludes the caller's own claim and the
  arithmetic (`cap - liveWorkers` admits) stays correct.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`worker_spawn`'s concurrency-cap admit,
opening paragraphs): lines 6033-6043, as of commit `173fdf61997710dd4933423b059de234a0677510`
(`fix(orchestration): make the concurrency-cap check atomic so concurrent spawns for different tasks
can't overshoot maxConcurrentWorkers`). No board card cited anywhere in the block or the introducing
commit — sha-keyed per `CLAUDE.md`'s comment taxonomy, verified with `git cat-file -t 173fdf61` (a real
commit). Relocated by card `61632c05` (tranche 15); no wording changed, wrapped source lines joined into
a flowing paragraph and the `//` comment markers stripped.
