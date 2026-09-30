# ffe98495 — refuse `.git`/`.obsidian` vault writes; run vault commits with hooks/fsmonitor disabled

## Narrative

`resolveInVault` (`vault/writer.ts`) had no in-root deny-list. `commitVault` (`vault/versioner.ts`) ran
plain `git add .`/`git commit` with no hooksPath override, `--no-verify`, fsmonitor neutralisation, or
repo pinning. Any `vault_write` caller — a `vaultWrite`-granted session, the Elevated Operator, or the
`LOOM_DEV`-gated Platform Lead — could plant a hook/fsmonitor/gpg-program, and the daemon's own next
`commitVault` would execute it: host code execution as the daemon user. Round 1 reproduced this on
Windows with real git; round 2 (Code Review of `c929219d`) found the round-1 fix incomplete in five ways,
folded into the current state below. Record `be8be211` frames `vaultWrite` as confined note-writing.

## Decision

**1. `resolveInVault` refuses, on every `/`-split segment** (ancestor or leaf — e.g. `relPath === ".git"`
is refused too):
- a literal `:` ANYWHERE (round 2, CRITICAL) — NTFS resolves `<dir>::$INDEX_ALLOCATION` and
  `<file>:<stream>` to the BASE name (alternate-data-stream aliases), so a segment-name check that never
  sees a literal `.git` string can still land inside a real `.git` this way;
- a trailing dot or space (round 2: widened to EVERY segment, not just a `.git`/`.obsidian` alias) —
  Windows silently drops it on disk, so an unguarded write leaves a REAL, mismatched directory behind
  (e.g. `notes` for a written `notes.`) that then makes `git add` fail hard for the WHOLE repo (verified
  live);
- a Windows 8.3 short-name SHAPE, `/~[0-9]+$/` (round 2: widened from a fixed `GIT~`/`OBSIDI~` prefix to
  the shape itself) — a short name can be a HASHED collision form unrelated to the long name's own prefix;
- an exact, case-insensitive match against `.git` or `.obsidian`. `.obsidian` is Obsidian's own plugin/
  config dir — a written plugin file is code Obsidian executes on the vault's next open with community
  plugins enabled; `versioner.ts`'s `buildIgnoredPattern` already treats it as operational the same way.
  `node_modules`/`worktrees` (that pattern's other two exclusions) are NOT added — an unrelated reason.

**1b (round 2, defense in depth).** The realpath walk also refuses when it resolves into the vault's own
`.git` — closing a pre-existing symlink/junction planted by some OTHER means (`vault_write` cannot create
one at all) whose OWN segment name is innocuous.

**2. `commitVault` and `VaultVersioner.flushSync` (its sync shutdown-flush twin) neutralise every git
invocation, not just the commit call, and pin the target repo once it is confirmed:**
- `boundedVaultGit` (DISCOVERY-only) unconditionally applies `-c core.hooksPath=<os.devNull>`, `-c
  core.fsmonitor=false`, `-c commit.gpgsign=false` (round 2 — vault commits are automated snapshots;
  nobody asked for signed ones, so this is FORCED off), and `-c safe.bareRepository=explicit` (round 2),
  plus `{allowUnsafeHooksPath, allowUnsafeFsMonitor}` in `unsafe` (simple-git's `blockUnsafeOperationsPlugin`
  refuses either `-c` by default; opted in for this module's instances only). A `-c` override takes
  precedence over the vault's own (agent-writable) `.git/config`.
- **`boundedVaultGitAtConfirmedRoot` (round 2, new)** — the repo-PINNED sibling, same config, PLUS
  `GIT_DIR`/`GIT_WORK_TREE` pinned via `localReadGitEnv` (also strips the transport env-var family, so an
  ambient `GIT_ASKPASS` etc. can't make simple-git throw "unsafe" once this becomes an explicit env).
  `commitVault` uses the UNPINNED factory ONLY for its initial "is this a repo, is it externally managed"
  discovery (pinning there breaks subfolder-of-a-bigger-repo detection), then switches to PINNED for every
  remaining call. Verified live: an ambient `GIT_DIR`/`GIT_WORK_TREE` no longer redirects `commitVault`.
- `os.devNull`, not a fresh `mkdtemp`'d dir, is the hooksPath target — mirrors `AUTOCOMMIT_HOOKS_PATH`
  (`git/worktrees.ts`): a `<devNull>/<hookname>` path can never exist, so `find_hook()` always fails.
- The commit call also passes `--no-verify` — belt-and-suspenders on the hooksPath override.
- `flushSync` (`execFileSync` directly, never `boundedSimpleGit`) carries the same `-c` flags AND
  `GIT_DIR`/`GIT_WORK_TREE` pins itself, on every invocation — `this.commitPath` is already the confirmed
  root by `start()` time. Its `add`/`status` moved off shell-string `execSync` in round 1 since they
  interpolate a real path (`@decision 816f0056`).

`flushSync` is in scope even though the card's DoD names only `commitVault`: a second, independently-
reachable commit path over the same vault history. `@decision 54b839c5`'s timeout split is unaffected.

## Do not

- Do not apply the safety config to only `commit` — apply it at `boundedVaultGit`/
  `boundedVaultGitAtConfirmedRoot`, the shared factories every real vault git instance goes through.
- Do not drop `--no-verify`, and do not move `flushSync`'s `add`/`status` back to shell-string `execSync`.
- Do not remove `.obsidian` from the refusal list, or add `node_modules`/`worktrees` to it.
- Do not check only exact, case-sensitive `.git`/`.obsidian` equality, or accept a literal `:` anywhere.
- Do not rely on the segment-name guard alone — the git invocation itself is ALSO pinned, independently.
- Do not pin `GIT_DIR` during `commitVault`'s discovery step — breaks subfolder-of-a-bigger-repo detection.

## Source

Card `ffe98495`, full review lane 4 (`486d4238`) finding B1. Round 2: Code Review of `c929219d`. Blocked
by, and built alongside, `68cc29db`. `packages/daemon/src/vault/writer.ts` (`resolveInVault`),
`packages/daemon/src/vault/versioner.ts` (`boundedVaultGit`, `boundedVaultGitAtConfirmedRoot`,
`commitVault`, `VaultVersioner.flushSync`).
