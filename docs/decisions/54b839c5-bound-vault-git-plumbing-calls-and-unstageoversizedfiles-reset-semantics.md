# 54b839c5 — Bound vault-versioner git calls; `unstageOversizedFiles` reset semantics

## Narrative

`unstageOversizedFiles` uses `git reset -- <path>` rather than `git reset HEAD -- <path>` so it also works on a brand-new repo's first commit — verified: `reset -- <path>` unstages cleanly with no HEAD yet, while `reset HEAD -- <path>` fails there. A reset failure is swallowed PER-FILE (leaves that file staged) rather than aborting the whole commit: refusing to commit ANYTHING over one bad unstage would be worse than a rare stray oversized commit, and the failure is still logged.

`unstageOversizedFiles` is narrowed to `Pick<SimpleGit, "raw">` and `timeoutMs`-bounded: a `git reset` is cheap plumbing (local index, no hooks), so it shares `VAULT_GIT_OP_TIMEOUT_MS` with this module's other plumbing-tier calls rather than the working-tree-scale ceiling `commitVault`'s `add`/`commit` use.

This card also decided, for `commitVault` itself, to deliberately NOT set `GIT_TERMINAL_PROMPT=0` — the short guard stays inline at `boundedVaultGit`'s own doc comment in `vault/versioner.ts`; the incident narrative behind that guard is below.

## Why `GIT_TERMINAL_PROMPT=0` was tried and reverted

The obvious shape, `simpleGit(p, {...}).env({ ...process.env, GIT_TERMINAL_PROMPT: "0" })` (the shape `restart.ts`'s `defaultGitLogSince` used to use — card 469b5e67 removed it there, and that call site now points back at this record instead of carrying its own copy), was tried and reverted after it broke two real things, verified live rather than assumed:

1. It throws outright the instant an ambient editor/pager var is set (`GitPluginError: Use of "GIT_EDITOR" is not permitted without enabling allowUnsafeEditor` — reproduced in the shell this fix was developed in; this repo's own worker/session spawn recipe also sets `GIT_PAGER`/`PAGER` — see root `CLAUDE.md`). Fixable alone by stripping that family, same as `git/writer.ts`'s `nonInteractiveEnv()` does — but:
2. `simpleGit(...).env(obj)` REPLACES the instance's whole env (verified: `Git2.prototype.env` sets `this._executor.env = obj` outright, not a merge) — so `obj` must ALSO carry `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` when the caller has them, to preserve legitimate config redirection. But having those two keys present at all trips simple-git's `blockUnsafeOperationsPlugin` (`allowUnsafeConfigPaths` — the same category `commitVault`'s own identity fallback already avoids, via `-c` args instead of env). Stripping them instead isn't safe either — verified live: `test/vault-write-tool.mjs`'s hermetic identity-fallback case (f1) sets both to nonexistent paths specifically so `commitVault` sees no resolvable identity and exercises its Loom-fallback path; stripping them from the child env instead lets git fall back to this dev host's real, configured `~/.gitconfig`, making that test silently commit under the WRONG identity instead of throwing — a failure that depends on the runner's own host config rather than the code.

Given neither path is safe, and `commitVault` does NO network operation (all calls local), `GIT_TERMINAL_PROMPT` has no live effect here regardless — it only governs git's credential-prompt logic during HTTP(S) auth. The timeout bounding is the actual, load-bearing fix for the hang this card is about, and doesn't depend on `.env()`.

## `commitVault`'s bound: mechanism, verified rather than assumed

simple-git's `block` timeout is a NO-OUTPUT timer (re-arms on every stdout/stderr `data` event — verified in the installed `simple-git@3.36.0` `timeoutPlugin`), not a hard wall-clock cap. On expiry it calls `spawned.kill("SIGINT")` on the directly-spawned child; simple-git spawns with no `shell: true` anywhere, so unlike `flushSync`'s shell-string `execSync` calls (a timeout there only kills the wrapping `cmd.exe`, not the real `git.exe` grandchild — see the 816f0056 record), a timeout here kills `git.exe` directly. On Windows, `child.kill()` ignores the signal argument and forcibly terminates that process regardless. This still does NOT guarantee a pre-commit hook's own already-spawned child (a `sh`/`sleep`) dies with it — no job object, no tree kill, same risk `flushSync` documents — so a bound here means "how long this function waits", not what the hook does afterward; whether a killed `git commit` still lands its object is the same race `flushSync`'s doc describes, not asserted either way.

No `maxBuffer` ceiling applies to `commitVault`'s bounded calls (re-checked, not assumed to carry over from `flushSync`'s own fix): simple-git accumulates stdout/stderr itself with no size cap and no `maxBuffer` option anywhere (verified: zero occurrences in the installed `simple-git@3.36.0` source) — so this path can't ENOBUFS the way `flushSync`'s shell-`execSync` calls did.

A bound expiring on the REST path (`vault/writer.ts`) never drops a user's edit, by design: `writeVaultFile`/`createVaultFile`/`deleteVaultFile` write to disk FIRST, call `commitVault` SECOND — a timeout only delays the commit, never the edit. Every real caller treats a rejection as "not committed this round" (`writer.ts`'s `.catch(() => false)` → `{ ok: true, committed: false }`) — the uncommitted file stays on disk, so the next debounced tick picks it back up: self-healing, not permanent loss. `commitVault` still REJECTS on expiry rather than swallowing it — what changed is it no longer hangs, and a timeout is no longer silent.

## Do not

- Do not aggregate a reset failure across files into one abort — a single unstage failure must not block committing every other, already-safe file.
- Do not use `git reset HEAD -- <path>` here — it fails on a repo with no HEAD yet (a brand-new repo's first commit).
- Do not re-add a `.env({ ...process.env, GIT_TERMINAL_PROMPT: "0" })` override to `commitVault`'s git calls — tried and reverted for the two reasons above, and moot since this path never touches the network.
