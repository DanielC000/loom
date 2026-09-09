# b6d41db1 — Scan a worker worktree for nested git repos before it's force-removed, and fail safe on a partial scan

## Narrative

`findNestedGitRepos` (card `b6d41db1`) finds nested git repositories inside a worker worktree — a subdirectory carrying its OWN `.git` (dir or file), distinct from the worktree's own root git linkage. Every worker worktree ALWAYS has expected ephemeral untracked content (`node_modules`, `dist`, `.turbo`, …) — that's WHY `removeWorktree` force-removes it — but a nested `.git` marks something else: a cloned repo, which can hold real unrecoverable work (unpushed branches). This is the precise signal that distinguishes that valuable class from ordinary build/dep noise.

The scan is ASYNC + BOUNDED: it walks with `fs.promises.readdir` (never a synchronous recursive walk that could block the event loop) and stops after `NESTED_REPO_SCAN_MAX_ENTRIES` visited entries, signalling `truncated:true` when it does, so a caller can distinguish "confirmed clean" from "gave up partway". A card `b6d41db1` follow-up (a Code Review finding) fixed a gap where a cap that silently returns a partial `repos` list lets a wide enough build-output sibling exhaust the budget before the walk ever reaches a real nested repo — re-opening the exact data-loss hole this scan exists to close. The scan never descends into the known build/dep noise dirs in `NESTED_REPO_SCAN_SKIP_DIRS` (bulk of most trees, never a legitimate nested-repo location) or into a repo it just found (no need to look inside a clone for further clones), and it fails OPEN on a read error for any one directory (permissions, a race with concurrent cleanup) — a scan glitch on ONE subdirectory must never itself block a legitimate merge; it simply skips what it couldn't read, distinct from hitting the entry cap, which DOES signal `truncated`.

## Do not

- Do not treat a `truncated:true` result's `repos` list as a complete/clean answer — a caller must fail safe (treat the worktree as if a nested repo were found) rather than trust an empty or partial `repos` as "confirmed clean".
- Do not use a synchronous recursive walk here — the scan must never block the daemon's event loop.
- Do not let hitting `NESTED_REPO_SCAN_MAX_ENTRIES` on a wide, ordinary build-output sibling silently pass as clean — that was the exact gap the follow-up fixed.

## Source

Inline comment in `packages/daemon/src/git/worktrees.ts`, `findNestedGitRepos`'s own doc comment (~line 1339), as of commit `f8d18a2cbc315a3020b962ac7e85cf2194ca09ba`. Relocated by card `5b001dde`; wrapped source lines joined into a flowing paragraph, `*` comment markers stripped, no wording changed.
