# 5150fdc2 — Detect and auto-forward a reused/reattached branch whose base has fallen behind main

## Narrative

Card `5150fdc2` part 1: for a REUSED/reattached branch (either reuse path of `createWorktree`, called AFTER `recutStaleReusedBranch` has already had its say), `detectStaleBase` asks whether this branch's history is missing commits current main HEAD carries. A 0-ahead branch was already re-cut onto `mainSha` by `recutStaleReusedBranch`, so this only ever fires for a RECOVERY branch (>0 commits ahead of its own old base, correctly left untouched by the recut's fail-safe) whose base has since fallen behind — the systematic case a mockups-first branch hits: `recutStaleReusedBranch` never advances it (correctly — see `mayRecutOntoMain`), so a build that started at the old fork point silently stays rooted there across every re-spawn.

`detectStaleBase` uses `countCommitsBehind` for the "how many" signal (fail-safe to `undefined`/not-stale on any error, and already bounded itself); only when that's genuinely > 0 does it pay for `merge-base` + a `diff --name-only` to name the fork point and what changed since — also bounded via `boundedGit`/`withTimeout`. Any error past the count read (including a timeout) also reads as "not stale" — this is purely advisory and must never block or alter a spawn. Part 3, `autoForwardStaleBase`, is the OPTIONAL auto-forward attempted only when staleness was found: it reuses `mergeMainIntoWorktree` VERBATIM — the exact clean-merge-only, abort-on-conflict-or-failure primitive `confirmWorkerMerge`'s own union-merge already uses (card `c0aeb5b2`) — rather than reimplementing it. It NEVER rebases (that would rewrite the retained history `mayRecutOntoMain`'s 0-ahead fail-safe exists to protect) and never forces past a conflict. It returns `undefined` on a clean forward (branch now carries main's tip, nothing left to tell the worker/manager) and the ORIGINAL `info` unchanged on a conflict or failure, so the caller still surfaces it. `resolveStaleBase` combines both parts; its separate `forwarded` boolean (card `047af53b` item 4) exists because `staleBase` alone is `undefined` on BOTH "never stale" and "successfully forwarded" — a caller that needs to know specifically whether a real file mutation (possibly a package.json/lockfile change) just happened cannot derive that from `staleBase` alone.

## Do not

- Do not rebase a stale-base branch to catch it up — only a clean merge (`mergeMainIntoWorktree`) is used; rebasing would rewrite history the 0-ahead fail-safe exists to protect.
- Do not force past a merge conflict during auto-forward — abort cleanly and surface the original `staleBase` info unchanged so the caller still sees it.
- Do not treat `staleBase: undefined` as proof nothing happened — it also means "successfully forwarded"; use the separate `forwarded` flag when a caller needs to know a file mutation occurred.

## Source

Inline comment in `packages/daemon/src/git/worktrees.ts`, `detectStaleBase`'s own doc comment (~line 860), as of commit `f8d18a2cbc315a3020b962ac7e85cf2194ca09ba`. Relocated by card `5b001dde`; wrapped source lines joined into a flowing paragraph, `*` comment markers stripped, no wording changed.
