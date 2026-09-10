# sha:c56ba944 — `worker_spawn`'s `taskId` is validated BEFORE any side effect, not after

## Narrative

`worker_spawn` validates the caller-supplied `taskId` BEFORE any side effect (worktree/session/branch
creation) — mirroring the pre-existing `agentId` existence guard above it in the same function. A
truncated id WITH a trailing space, paired with a placeholder kickoff, once SUCCEEDED: it bound a live
worker to a bogus task string (a zombie — a real running worker with no real task backing it), while the
actual intended task stayed untouched in backlog.

The fix trims the caller-supplied id first (so a pasted id with stray whitespace normalizes), rejects an
id that still contains whitespace after trimming, then requires the id to resolve to a REAL, NON-terminal
task IN THIS PROJECT — a truncated/malformed/unknown id won't resolve and is rejected with the same "does
not resolve" shape the `agentId` guard already uses. A bad id must create NOTHING: no worktree, no
session, no branch.

## Do not

- Do not create a worktree/session/branch before the `taskId` has been validated to resolve to a real,
  non-terminal task in this project — a malformed or stale id must be rejected with no side effect at all.
- Do not accept a `taskId` with embedded whitespace after trimming — a trailing-space id has previously
  succeeded and bound a live worker to a bogus task string.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`worker_spawn`'s taskId validation, above the
`taskRef` derivation): lines 5873-5879, as of commit `c56ba94414bea74f09a511f1f87d0d8097adb6d4`
(`fix(orchestration): validate worker_spawn taskId before spawning (reject malformed/non-existent ids)`).
No board card cited anywhere in the block or the introducing commit — sha-keyed per `CLAUDE.md`'s comment
taxonomy (`@decision sha:<commit>`), verified with `git cat-file -t c56ba94414` (a real commit). Relocated
by card `61632c05` (tranche 15); no wording changed, wrapped source lines joined into a flowing paragraph
and the `//` comment markers stripped.
