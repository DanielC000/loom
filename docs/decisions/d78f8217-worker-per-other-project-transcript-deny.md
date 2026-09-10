# d78f8217 — worker-role per-other-project transcript-root deny

## Narrative

Card `d78f8217`, implementing `31613c1e`'s approved option (d): a per-OTHER-project transcript-root deny for the `worker` role's PROJECT-SCOPED deny — as opposed to the BLANKET `TRANSCRIPT_ROOT_READ_DENY_RULE` applied to `assistant`/`auditor`/`workspace-auditor`/`manager`/`platform`/`setup` (`pty/host.ts`'s `TRANSCRIPT_ROOT_DENY_ROLES`). A worker legitimately reads its own project's transcripts (six in-tree investigations depend on it — see card `31613c1e`'s own doc), so it can't take the blanket rule; but its native reach otherwise spans every OTHER project's transcripts too, which this closes.

Two rules per other project, both MEASURED against the real `claude` binary (see `pty/host.ts`'s `withTranscriptRootDenyForSpawn` doc for the measurement):

- A mid-segment wildcard on the other project's id: a worktree cwd is `WORKTREES_DIR/<projectId>/[repoKey/]<taskKey>`, and `encodeProjectDir` flattens every path separator to `-`, so `<projectId>` (a UUID — alphanumeric+dashes, glob-safe) sits as a `-`-delimited token inside the encoded dir name regardless of repoKey/taskKey — `*-<id>-*` matches it selectively without needing to know the exact repoKey/taskKey.
- The other project's own encoded repoPath: a NON-worker session for that other project (its manager, for instance) spawns with cwd = repoPath directly — no worktree, no projectId token at all (see `sessions/service.ts`'s `cwd: project.repoPath` spawns) — so the id-token rule alone would miss it.

## Do not

- This is a DENY-LIST over a DB-derived set and so FAILS OPEN on anything not enumerated here — most notably a non-Loom `claude` session's transcripts elsewhere on the host. Best-effort narrowing, NEVER a structural guarantee. Card `31613c1e`'s LEAD RULING, verbatim: "CARRY ITS LIMIT VERBATIM OR THIS BECOMES THE NEXT OVERCLAIMED CONTAINMENT DOC" — carry that sentence, not a softened paraphrase, wherever this decision is cited.

## Source

`otherProjectTranscriptDenyRules`'s doc comment in `packages/daemon/src/pty/claude-transcript.ts` (lines 57-80 pre-extraction). Card `31613c1e`'s own ruling/doc is referenced here but not reproduced in full — its fuller content (the rejected alternatives, the "one-knob blanket for all four" option it turned down) lives with `pty/host.ts`'s own citations of it, which a future `pty/host.ts` extraction tranche is the right place to record.
