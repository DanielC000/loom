# sha:e1c6ef65 — `WORKTREES_DIR` is a sibling of `LOOM_HOME`, never nested inside it

## Narrative

Per-worker git worktrees live outside the PROJECT repo (share its object store; don't clutter it) — AND outside `LOOM_HOME` itself. `LOOM_HOME` (`~/.loom`) is a plain state dir for most users, but in the self-hosting setup it IS a git repo of its own (cross-agent state: skill sources, resume docs, `restart-intent.json`, …). Nesting `worktrees/` inside it (the pre-2026-07-07 layout) meant a worker whose Bash cwd sits under its worktree could `cd ..` up into that repo and a stray `git` command there would mutate the daemon home's live working tree — this actually happened (a worker's `cd .. && git stash` swept up another agent's uncommitted WIP). So the base is a SIBLING of `LOOM_HOME` — `<LOOM_HOME>-worktrees` — derived from it (still isolated per-`LOOM_HOME`, so side-by-side daemons with different `LOOM_HOME` stay isolated) but with no `.git` ancestor of its own between it and the filesystem root (`LOOM_HOME`'s parent — the user's home dir — is not a git repo). `path.dirname`/`path.basename` (not string concatenation) so a trailing separator on `LOOM_HOME` can't produce a malformed sibling path.

Existing worktrees created under the OLD `LOOM_HOME/worktrees` layout keep working (tracked by absolute path in the DB) until they're individually removed — going-forward relocation only, no migration.

## Do not

- Do not nest `worktrees/` back inside `LOOM_HOME` — a worker's relative `cd ..` + git op would again be able to mutate the daemon home's own live working tree in the self-hosting setup, which actually happened once.
- Do not derive the sibling path via string concatenation — use `path.dirname`/`path.basename` so a trailing separator on `LOOM_HOME` can't produce a malformed path.

## Source

Inline comment in `packages/daemon/src/paths.ts` (`WORKTREES_DIR`'s doc): originally lines 89-104, as of this tranche's HEAD (paths.ts tranche 1). Introducing commit `e1c6ef6582987f207e0df4a23543cde47026bec6` ("fix(worker-isolation): worker worktrees nest INSIDE the live LOOM_HOME git tree — a stray relative `cd ..`+git op corrupts cross-agent state"), 2026-07-07 — no board card id anywhere in the block, the file, or that commit's message/body, so keyed by commit sha per the `sha:` grammar (`git cat-file -t e1c6ef65` confirms it resolves as a commit).
