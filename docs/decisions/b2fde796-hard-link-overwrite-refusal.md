# b2fde796 — refuse a hard-linked overwrite target; check-and-write on one open fd

From Code Review `c2a63924` of `af1e0eb4` (2026-10-02). Finding 1, reproduced in WSL Ubuntu-22.04 on both
the parent commit and the `af1e0eb4` fix.

## Problem

A **hard link** inside the vault pointing at a file outside it passes `resolveInVault`'s checks cleanly:
it `lstat`s as an ordinary regular file (a hard link is not a symlink — it's a second directory entry for
the same inode), and its *path* is lexically confined to the vault root. Those checks guard a symlink
escape; they say nothing about a shared inode.

`writeVaultFile` then opened the target with `fs.writeFileSync`, which truncates and overwrites whatever
inode the path currently resolves to — including an inode shared with a file outside the vault. Repro:
`vault/h.md` hard-linked to `outside/hard.md`; `writeVaultFile(vault, "h.md", "PWNED-H")` returned
`{ ok: true }` and the **outside** file's content became `"PWNED-H"`.

## Fix

Refuse an existing overwrite target whose `stat.nlink > 1`. The check and the write happen on the **same
open file descriptor**, never a separate `lstat`-then-`writeFileSync`:

1. `fs.openSync(target, O_WRONLY | O_CREAT | O_NOFOLLOW-on-POSIX)` — no `O_TRUNC` yet.
2. `fs.fstatSync(fd).nlink` — read off the fd, i.e. the exact inode that is about to be written, not a
   separate `lstat` call that could race against a swap between the check and the open.
3. `nlink > 1` → close the fd and return `{ ok: false, reason: "hard-link" }`, having never truncated.
4. Otherwise `fs.ftruncateSync(fd, 0)` then `fs.writeSync(fd, content, 0, "utf8")`.

`O_NOFOLLOW` additionally closes the symlink-swap half of the same TOCTOU window: if the final component
became a symlink between `resolveInVault`'s own `lstat` check and this `open`, the open fails with
`ELOOP` instead of silently following it. `fs.constants.O_NOFOLLOW` is POSIX-only (confirmed empirically
absent — `undefined`, not merely `0` — on a win32 Node build); it is included unconditionally in the
open-flags bitmask since `0 | anything` is a no-op, so the same call works, inertly, on Windows.

`stat.nlink` itself is populated correctly cross-platform, including on NTFS hard links (verified:
`fs.linkSync` plus `fs.statSync(...).nlink` reports `2` on both sides on a stock, non-admin Windows host
— no special privilege needed, unlike a Windows file *symlink*).

**Delete is deliberately excluded from this check** — see the `af1e0eb4` record's "write-vs-delete
asymmetry" addendum for the companion decision and why deleting a hard-linked vault path is allowed
(`unlinkSync` removes only the vault's own directory entry; the shared inode, and whatever else points at
it, is untouched).

## Do not

- Do not check `nlink` via a separate `lstat`/`statSync` call before opening the file for write — that
  reintroduces the exact check-to-write TOCTOU gap this record exists to close. The check must read the
  fd that will actually be written.
- Do not drop `O_NOFOLLOW` from the open call on POSIX, and do not add it unconditionally without the
  `typeof fs.constants.O_NOFOLLOW === "number"` guard — it is genuinely absent on win32, not `0`.
- Do not apply this `nlink` refusal to `deleteVaultFile` — see the `af1e0eb4` addendum; delete's own
  unlink-the-entry semantics make a hard-linked target's deletion safe.
- Do not apply the `O_CREAT` + no-`O_TRUNC`-until-checked pattern loosely — `ftruncateSync` must stay
  strictly after the `nlink` check, never before, or a hard-linked target's shared content is destroyed
  before the refusal has a chance to fire.
