# 96c4b245 — reject a non-absolute `vaultPath` at the write boundary; never guess a base to resolve it against at render time

## Narrative

`vaultPath` never got the same absolute-path treatment as the structurally identical `referenceRepos`
field (`validateReferenceRepos`, `projects/reference-repos.ts`): every write site only `expandTilde`d
the input, so a relative value — e.g. a path copied out of Obsidian's own vault-relative note browser
instead of a real filesystem path — was accepted and stored verbatim. It then surfaced later as a
confidently-wrong-looking relative path in a manager's "Where things live" startup context block
(`sessions/manager-prompt.ts`).

There is no recoverable "vault root" Loom could resolve a relative value against — no such config
exists anywhere in the system. Guessing one at render time (e.g. `path.resolve` against whatever the
daemon process's own cwd happens to be) would fabricate a confidently-wrong absolute path, which is
worse than surfacing the relative value as an error. So the only correct fix is to **reject** a
relative value at the bind boundary, not to guess a base and silently "fix" it downstream.

`validateVaultPath` (`packages/daemon/src/projects/vault-path.ts`) is the single shared guard this
produced: `expandTilde`, then `path.isAbsolute` — idempotent on an already-expanded absolute input, so
callers that already `expandTilde`d upstream can pass the result straight through. It is deliberately
narrower than `referenceRepos`' `isGitRepo` existence check: existence is call-site-specific (a
vault-only project requires an existing directory; a code project's optional vault gets
auto-scaffolded via `ensureVaultRoot` rather than required to pre-exist), so this shared guard checks
only the one thing every call site agrees on — absoluteness.

By the time of this record, six write-time call sites share this one guard: `gateway/server.ts`'s
`POST /api/projects` create path and `PATCH /api/projects/:id` rebind path, `mcp/platform.ts`'s
elevated `project_create` and `project_update` MCP tools, and `mcp/setup.ts`'s `project_create` and
`update`/`configure` tools on the Platform-operator surface. A seventh site, `vault/versioner.ts`'s
`startVaultVersioners`, uses the same guard at **boot**, not at write time — to detect and skip a
LEGACY row that predates this guard (card `78dc99e3`) and still holds a relative value, rather than
letting it fall through to `resolveVaultRepoContext`/`git init` and fail opaquely or write into the
wrong place via `resolveInVault`'s `path.resolve`.

`sessions/manager-prompt.ts`'s `composeManagerStartupPrompt` is a third consumer, also read-time: a
project with `vaultPathInvalid` (an already-stored legacy relative value, same root cause as the
versioner case) skips the vault-dir/resume-doc lines in the manager's startup context block entirely,
rather than feeding a relative path into `resolveResumeDocPath` and having it resolve against the
daemon's own cwd — the exact rejected-at-write-time failure mode, still reachable read-time for any
row bound before this guard existed.

## Do not

- Do not resolve a relative `vaultPath` against any guessed base (daemon cwd, a hardcoded vault root)
  at render or boot time — there is no recoverable root. Reject it at the write boundary instead
  (`validateVaultPath`), and for an already-stored legacy relative row, surface the problem loudly
  (a console warning naming the project, a skipped render line) rather than silently computing a
  confidently-wrong absolute path.
- Do not add a new project write-path (REST, MCP, or otherwise) that `expandTilde`s a `vaultPath`
  without also running it through `validateVaultPath` — that is exactly the gap this guard closed
  across its six write sites.

## Source

JSDoc comment above `validateVaultPath` in `packages/daemon/src/projects/vault-path.ts` (originally
lines 9-27, plus the file's whole original introduction). Also cited (comment-only, no additional
call-site logic) in `gateway/server.ts` (create + PATCH rebind), `mcp/platform.ts` (`project_update`),
`sessions/manager-prompt.ts`, and `vault/versioner.ts`. Introduced by commit `ec22669e7` — note its
subject line ("...emit an absolute vault dir + resume-doc path...; treat a cap-truncated Read as
read-for-overwrite") does NOT describe this diff: the actual change is 100% the new `vaultPath`
absolute-path validator introduced here and its write sites; the subject describes unrelated,
differently-scoped work bundled into the same commit. Verify with `git show ec22669e7`, not the
subject alone.
