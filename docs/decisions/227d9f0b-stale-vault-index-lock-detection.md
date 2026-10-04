# 227d9f0b — stale vault `.git/index.lock`: stat-only detection, loud signal only, no auto-removal

## The problem

A git child `commitVault`/`flushSync` spawn (or kill on timeout — see `816f0056` and project memory
`execsync-timeout-kills-only-the-shell-on-windows`) can leave `.git/index.lock` behind in a vault's
governing repo. Before this card, nothing detected it: every later `git add`/`git commit` against that
repo fails forever with `fatal: Unable to create '<path>/index.lock': File exists.` (measured verbatim
against this host's real git), silently swallowed by `commitVault`'s/`flushSync`'s existing best-effort
catches — a human has to notice the vault stopped versioning and manually delete the lock.

## Detection is a direct stat, not a message-classified git error

`detectStaleVaultLock` (`vault/versioner.ts`) reads `<commitPath>/.git/index.lock`'s own `mtime` directly
off disk and compares its age against `VAULT_LOCK_STALE_THRESHOLD_MS`. This is deliberate, not
incidental: `commitVault`'s real working-tree git calls (`boundedVaultGitAtConfirmedRoot`) do not pin
`LC_ALL`/`LANGUAGE` the way the discovery probes (`messageClassifiedProbeEnv`) do, so message-classifying
the add/commit failure itself would silently never fire on a non-English-locale host. A stat is
locale-independent and needs no env change on every other vault git call to stay correct.

`STALE_LOCK_MESSAGE_RE` exists only as a SECONDARY corroborator (stamped into the filed event's
`detail.corroboratedByMessage` for a human reading it) — it is never required, and detection must never
be gated on it.

## No auto-removal — there is no sound Windows liveness proof available with this codebase's tools

Investigated and rejected. Two structural gaps, not merely "hard":

1. Neither `commitVault`'s bounded git calls nor `flushSync`'s `execFileSync`/`execSync` calls ever
   capture the child's own pid — those sync wrappers return only stdout, never a pid (unlike
   `spawnSync`, which does expose `.pid` even on timeout). There is nothing to anchor a liveness check on
   the way `orchestration/restart.ts`'s `isSupervisorProcessAlive` anchors on a known `self.ppid`.
2. Even with every live `git.exe` process enumerated (the same bulk-enumeration shape
   `isSupervisorProcessAlive`/`pty/host.ts`'s `reapOrphanedDescendants` already use), Windows
   `Win32_Process`/CIM exposes `CommandLine` and `ParentProcessId` but not a process's current working
   directory or environment block — and this module pins `GIT_DIR`/`GIT_WORK_TREE` via env, never argv,
   so a live `git.exe`'s own argv never names the repo it is operating on. There is no way to attribute a
   live `git.exe` process to THIS specific repo without reading its PEB (native/elevated access this
   codebase does not have).

The only signal that IS sound is TIME — `VAULT_LOCK_STALE_THRESHOLD_MS` is a margin multiple (×3) over
`VAULT_FLUSH_WORKING_TREE_TIMEOUT_MS`, the longest bound any of this module's own add/commit calls may
legitimately hold the lock for (`816f0056`) — but that is a probabilistic "very likely dead," never a
proof, and an abandoned child is known (same project memory) to sometimes keep running for a nontrivial
tail past its own bound. A sound auto-heal is possible ONLY as a separate, larger refactor: switch
`flushSync`'s `execFileSync`/`execSync` (and `commitVault`'s bounded calls) to capture the child's pid at
spawn (e.g. via `spawnSync`) so a creation-time-anchored, pid-scoped check becomes possible — out of scope
here, and not to be added incidentally under this card.

## Dedupe is keyed on the lock file's own mtime, on disk, not in memory

`maybeAlertStaleVaultLock` writes `<commitPath>/.git/loom-vault-lock-alert.json` (`{lockMtimeMs,
notifiedAt}`) — same `.git/`-scoped-marker convention as the pause lease / push-outcome record elsewhere
in this file. A repeat detection against the SAME lock instance (same mtime) is a no-op; a genuinely NEW
lock instance (a different mtime — e.g. a human cleared the old one and a fresh one later got stuck) is
treated as a new episode and re-fires. This keeps a 5s-debounced auto-commit retry storm, or a 30-minute
watcher tick, from refiling the same alert over and over.

## Round 2 (Code Review 0858c93d of 41529894): linked worktrees, marker-after-success, and the "cleared" pairing

Round 1 shipped with four gaps a follow-up Code Review found:

1. **Linked-worktree/submodule vaults were never detected.** `detectStaleVaultLock` stat'd
   `<root>/.git/index.lock` directly — but a linked git WORKTREE's `.git` is a FILE (a `gitdir: <path>`
   pointer), not a directory, and its own `index.lock` lives in the PRIVATE gitdir that pointer names, not
   under `<root>/.git/`. Reproduced against a real `git worktree add` fixture. Fixed by resolving through
   `resolveLeaseGitDir` (the SAME gitfile-aware resolution the advisory pause lease already uses) for both
   the lock path AND the dedupe marker's path — never a direct `path.join(root, ".git", …)` again. The
   claim "every vault repo is a plain repo" in this detector's own doc (and originally in this record) was
   simply false; corrected here and at the function's own doc comment.
2. **The dedupe marker was written unconditionally**, even when `appendEvent` itself threw — a swallowed
   append failure permanently silenced that lock instance, since no later tick would ever see a missing
   marker and retry. Fixed: the marker is now written ONLY after `appendEvent` succeeds, and only when
   `lockAlert.db` is set.
3. Added a standalone test for `flushSync()`'s own catch-site wiring (stale lock, NO prior `commit()`
   call) — the round-1 test only exercised `flushSync()` AFTER `commit()` had already fired+marked the
   alert, so a `flushSync()` catch that never called `maybeAlertStaleVaultLock` at all would still have
   passed the "doesn't duplicate" assertion; dedupe state masked the omission.
4. **Added the `_cleared` sibling kind** (see "The cleared event" below) — superseding the round-1
   decision immediately below.

## The cleared event (round 2 — supersedes round 1's "no cleared counterpart" call)

Round 1 deliberately shipped WITHOUT a `vault_index_lock_cleared` counterpart (see the "Do not" below this
record used to carry, now corrected) on the reasoning that the web attention surface could just keep
"latest stale event per repoPath, superseded only by a NEWER stale episode" — the same shape as
`context_escalated`/`board_quiet_cause`. That was accepted as a scoped limitation, not a final design.

Round 2 adds the pairing: `VaultPushStatusWatcher.tick()` now also runs
`maybeClearStaleVaultLockAlert` per commit path — when a repo's dedupe marker is present AND its lock has
since disappeared, it files `vault_index_lock_cleared` (`detail: { repoPath, projectId? }`) and removes
the marker. This mirrors `claude_boot_dialog_stuck`/`claude_boot_dialog_resolved`'s latest-wins pairing
exactly: the web attention surface (`lib/fleet.ts`'s `activeVaultLockAlerts`, mirroring
`activeBootStuckAlerts`) sorts both kinds by `ts`, keeps the latest event per `detail.repoPath`, and only
surfaces an item when that latest event is `vault_index_lock_stale` — a later `_cleared` for the same
repoPath drops the item instead of waiting for a NEWER stale episode to replace it. The clear check runs
ONLY from the watcher's periodic tick, never from `commit()`/`flushSync()` — a clear is an observed
absence on an otherwise-idle check, not something either mutating call site discovers on its own failure
path.

## Do not

- Do not message-classify `commitVault`'s/`flushSync`'s add/commit failure as the primary stale-lock
  signal — it needs a locale pin (`LC_ALL`/`LANGUAGE`) that those calls deliberately do not carry; use the
  direct stat (`detectStaleVaultLock`) instead, and keep the message regex (`STALE_LOCK_MESSAGE_RE`) as a
  secondary corroborator only, never a gate.
- Do not add auto-removal of `.git/index.lock` gated on this detector without first giving `flushSync`/
  `commitVault` a way to capture the holding child's own pid (e.g. switching off `execFileSync`/`execSync`
  to `spawnSync`) — a bare age-based "it's probably dead" check is NOT a sound liveness proof, and this
  codebase has no Windows mechanism today to attribute a live `git.exe` process to a specific repo.
- Do not lower `VAULT_LOCK_STALE_THRESHOLD_MS` below a real multiple of `VAULT_FLUSH_WORKING_TREE_TIMEOUT_MS`
  — a tight threshold manufactures a false alert on an ordinary slow flush over a large or network-backed
  vault, the same class of mistake `816f0056` already rejected for the flush timeout itself. Always derive
  it from that imported constant, never a copied raw number.
- Do not key the on-disk dedupe marker, or the web attention item, on anything other than the lock file's
  own mtime / `detail.repoPath` — those are the only values guaranteed to change between genuinely
  distinct lock episodes.
- Do not resolve the lock path or the dedupe marker's path via a direct `path.join(root, ".git", …)` —
  always go through `resolveLeaseGitDir` (round 2), or a linked-worktree/submodule vault's lock is never
  found at all.
- Do not write the dedupe marker before `appendEvent` succeeds (round 2) — a marker written on a failed
  append permanently silences that lock instance, since no later tick ever sees a missing marker to retry
  against.
- Do not add a `maybeClearStaleVaultLockAlert` call to `commit()`/`flushSync()` — the clear check belongs
  ONLY on `VaultPushStatusWatcher.tick()`'s periodic, otherwise-idle check (round 2); a clear is an
  observed absence, not something either mutating call site's own failure path discovers.
