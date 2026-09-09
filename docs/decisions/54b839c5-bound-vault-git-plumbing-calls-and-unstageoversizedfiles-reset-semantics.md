# 54b839c5 — Bound vault-versioner git plumbing calls; `unstageOversizedFiles`'s reset semantics

## Narrative

`unstageOversizedFiles` uses `git reset -- <path>` rather than `git reset HEAD -- <path>` so it also works on a brand-new repo's very first commit — verified: `reset -- <path>` unstages cleanly even with no HEAD yet, while `reset HEAD -- <path>` fails there. A reset failure is swallowed PER-FILE (leaves that one file staged) rather than aborting the whole commit: refusing to commit ANYTHING because one file couldn't be unstaged would be a worse outcome than the rare case of a stray oversized commit slipping through, and the failure is still logged.

`unstageOversizedFiles` is narrowed to `Pick<SimpleGit, "raw">` and `timeoutMs`-bounded as part of this card's pass over the module: a `git reset` here is cheap plumbing (local index manipulation, no hooks), so it shares `VAULT_GIT_OP_TIMEOUT_MS` with this module's other plumbing-tier calls rather than the working-tree-scale ceiling `commitVault`'s `add`/`commit` use.

This card also decided, for `commitVault` itself, to deliberately NOT set `GIT_TERMINAL_PROMPT=0` — that reasoning is a Class-A guard and stays inline at `boundedVaultGit`'s own doc comment in `vault/versioner.ts`, not duplicated here.

## Do not

- Do not aggregate a reset failure across files into one abort — a single unstage failure must not block committing every other, already-safe file.
- Do not use `git reset HEAD -- <path>` here — it fails on a repo with no HEAD yet (a brand-new repo's first commit).
