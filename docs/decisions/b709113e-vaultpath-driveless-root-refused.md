# b709113e — refuse a win32 drive-less rooted vaultPath (e.g. "/tmp") at the shared validateVaultPath chokepoint

Card `b709113e`. The live Loom DB turned up a non-archived project row (`id:"p1"`, `name:"N"`,
`repoPath`/`vaultPath:"/tmp"`, created 2026-10-03), and the vault auto-committer had git-inited and
committed a real `C:\tmp` on the host (2026-10-05/06). Investigating the WRITER ruled out every committed
test/script source — no fixture in `packages/daemon/test` or `packages/daemon/scripts` ever constructs a
project with a literal `"/tmp"` (every fixture that uses `/tmp` uses it as a sub-path, e.g.
`/tmp/rgo-c-own`, never the bare root) — and this exact incident was already independently investigated
and attributed by card `0a03059e` (`docs/decisions/0a03059e-prod-db-default-refuse.md`): an uncommitted,
ad-hoc script imported `dist/db.js` directly and called `db.insertProject()` against the real DB with no
`LOOM_HOME` override. That card's fix (`declareDaemonProcess`/`assertProdDbOpenAllowed`) already closes
the "how did an ad-hoc script reach the real DB at all" hole; this card closes a DIFFERENT, narrower hole
that survives even with that fix in place: **what happens if a row with this shape exists regardless**
(a legacy row, a future bypass, a hand-edited DB) — the vault auto-committer must refuse to act on it.

## The gap

`validateVaultPath` (card `96c4b245`) was believed to already reject this shape, since it requires an
absolute path. It does not: `path.isAbsolute("/tmp")` returns `true` on win32 — Node treats a POSIX-root
path as "absolute" (rooted) even with no drive letter — and `path.resolve("/tmp")` resolves it to
`C:\tmp`, i.e. whatever drive the current process happens to be on. This is a real, existing Windows
ambiguity (see `git/bounded.ts`'s own `S2 (win32)` comment on `canonicalGit`'s gitdir-pointer resolution,
which refuses the identical shape for a different reason) — not something invented for this card.

So `validateVaultPath` passed `"/tmp"` as valid at every one of its 6 write sites (REST, loom-setup,
loom-platform create/update), and the vault-commit boot loop (`startVaultVersioners`, which also calls
`validateVaultPath` to skip a bad legacy row) passed it too — the ONE shared guard both layers lean on had
the hole in it.

## The fix

`validateVaultPath` now ALSO rejects a win32 drive-less rooted path (`isWin32DriveLessRootedPath`,
`projects/vault-path.ts`): absolute per `path.isAbsolute`, but no drive letter (`^[A-Za-z]:[\\/]`) and no
UNC prefix (`\\`/`//`). POSIX hosts are entirely unaffected — `/tmp` there is a real, correctly-rooted
path, so the check is gated on `process.platform === "win32"`.

Because every create/rebind write site AND the vault-commit boot loop already route through this one
function, fixing it here closes both:
- **Create/rebind** (REST `POST`/`PATCH /api/projects`, loom-setup's `project_create`/`project_update`,
  loom-platform's `project_create`/`project_update`): a drive-less rooted vaultPath is now rejected with a
  named error, same shape as the existing non-absolute rejection.
- **Vault-commit boot time** (`startVaultVersioners`): a PRE-EXISTING row carrying this shape (inserted
  directly, bypassing every write-site validator — exactly how the real incident row got in) is named
  loudly and skipped, never handed to `resolveVaultRepoContext`/`git init`.

`vault/versioner.ts`'s boot-loop warning now interpolates `check.error` directly (whichever of the two
`validateVaultPath` failure reasons actually fired) instead of a single hardcoded "not absolute" string,
so the log line is accurate for both failure shapes.

## Do not

- Do not re-introduce a bare `path.isAbsolute` check as "the" absolute-path guard for a vaultPath (or any
  structurally identical field) on win32 without ALSO checking for a drive letter/UNC root — `/tmp`-shaped
  input passes `path.isAbsolute` and is still dangerous there.
- Do not gate `isWin32DriveLessRootedPath` on anything other than `process.platform === "win32"` — a POSIX
  host's `/tmp` is a real, correctly-rooted path; refusing it there would be a regression, not a fix.
- Do not hand-roll a second "is this path safe on win32" check elsewhere for a vaultPath/referenceRepos-
  shaped field — route it through `validateVaultPath` (or extend it) the same way every other vaultPath
  write site already does; see `96c4b245`'s own "Do not" for the same rule about the non-absolute case.
- Do not revert `vault/versioner.ts`'s boot-loop warning back to a single hardcoded "vaultPath is not
  absolute" string — it must reflect `validateVaultPath`'s own returned `error`, since there are now two
  distinct failure reasons it can report.
