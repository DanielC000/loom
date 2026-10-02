# af1e0eb4 — `resolveInVault` lstats the final target to catch a dangling symlink/junction

Card `af1e0eb4` ("fix(vault): reject a symlinked final target in resolveInVault"), discovered from the
full review of `67179c22`.

## Problem

`vault/writer.ts`'s `resolveInVault` is the shared traversal guard for every vault write (`writeVaultFile`,
`createVaultFile`, `deleteVaultFile`). To find the "deepest existing ancestor" of a target that may not
exist yet (an ordinary create), it walked up the path using `while (!fs.existsSync(probe))`.

`fs.existsSync` follows a symlink/junction and stats its *destination* — it does not report whether the
link itself exists. For a **dangling** link (a symlink/junction whose destination does not exist),
`existsSync` on the link's own path returns `false`, identical to the path not existing at all.

So for a vault-relative path whose final component is a dangling symlink/junction, the walk-up treated the
link's own (real, existing) *parent* directory as the deepest existing ancestor, ran the realpath
containment check against that parent (which is trivially inside the vault), and handed back the dangling
link's own path as a "safe" resolved target — without ever inspecting the link itself. A subsequent write
through that target is governed by wherever the link resolves on disk, which this guard never checked.

Confirmed directly: against the pre-fix code, writing to a path whose final component was a dangling
junction returned `{ ok: false, reason: "error" }` (a downstream `mkdirSync`/`writeFileSync` failure)
instead of `{ ok: false, reason: "traversal" }` — proof the traversal guard never fired and a filesystem
mutation was attempted against an unvetted path. A dangling **file** symlink (the shape that would turn
this into a true content-escape, since `fs.writeFileSync` follows a file symlink through to its — possibly
nonexistent, possibly outside-the-vault — destination) needs symlink privilege Windows denies by default;
this was reproduced via a dangling directory junction instead (no privilege required), which exercises the
identical `existsSync`-blindness mechanism.

## Fix

`resolveInVault` now `fs.lstatSync`s the final target *before* the existing walk-up/realpath check, and
refuses outright (`return null`) if the result is a symlink (`isSymbolicLink()` — true for both a POSIX
symlink and a Windows junction, dangling or not; `lstat` never follows the final path component, so it
sees the link itself regardless of whether its destination exists). An `ENOENT` from `lstat` (the target
doesn't exist at all, not even as a link) falls through to the existing walk-up unchanged — a normal
create under a real, non-linked parent is untouched.

The walk-up's own realpath check was also switched from `fs.realpathSync` to `fs.realpathSync.native`
(falling back to `fs.realpathSync` if the native call throws), matching the technique `f9360c84`'s
`isLoomHomeOrAncestor` (`vault/versioner.ts`) already uses: the native OS call normalizes a Windows 8.3
short-name alias that Node's own JS-level `realpathSync` does not.

## Do not

- Do not swap the final-target check back to `fs.existsSync` — that is precisely the blindness this
  record exists to close; see "Problem" above for the exact mechanism.
- Do not scope the `lstat` check to POSIX only — a Windows junction satisfies `isSymbolicLink()` too (and
  is createable, dangling or not, without admin/Developer-Mode privilege, unlike a file symlink), so the
  check must run unconditionally on every platform.
- Do not treat an `lstat` `ENOENT` as a refusal — it means the target doesn't exist at all (the ordinary
  create case), not that it's a disguised link; only an actual symlink result refuses.
- Do not drop the existing walk-up/realpath check in favor of the `lstat` check alone — they cover
  different cases: `lstat` catches the final target itself being a link; the walk-up/realpath check
  catches an ancestor *directory* being a link that resolves outside the vault (or into its `.git`).

## Addendum (card `b2fde796`): the write-vs-delete asymmetry

The final-target `lstat`-symlink refusal above was, for a while, applied uniformly to every caller of
`resolveInVault`, including `deleteVaultFile` — so deleting a symlink final target (an in-vault alias, or
a dangling planted link) was refused with `reason: "traversal"`, identical to a genuine escape.

That is over-broad for delete specifically. `fs.rmSync`/`fs.unlinkSync` on a symlink removes only the
single directory entry the link occupies — it never dereferences the link, so it never touches whatever
the link points at, live or dangling, in-vault or out. There is no write-through-a-link escape on the
delete path the way there is for `writeVaultFile`/`createVaultFile`: refusing the delete bought no safety
and only left behind a planted or stale link the owner could not remove through the vault UI/tools.

**Fix:** `deleteVaultFile` now resolves through a delete-specific sibling, `resolveInVaultForDelete`,
which runs the same lexical/segment/root-containment guards and the same ancestor-chain check (still
anchored at the target's *parent* directory, so an intermediate ancestor symlink pointing outside the
vault is still refused exactly as it is for a write) — but deliberately does **not** refuse a final
target that is itself a symlink/junction. `deleteVaultFile` then `lstat`s the resolved target directly
(never `fs.existsSync`, which follows a link and is blind to a dangling one — the exact mechanism this
record's main fix closes) and `fs.unlinkSync`s it unconditionally, whether it is a symlink or a regular
file.

Write-through-a-link stays refused, unchanged — only delete's own unlink-the-entry semantics make
skipping the final-symlink refusal safe.

## Do not (write-vs-delete addendum)

- Do not fold `resolveInVaultForDelete` back into `resolveInVault` by making its final-symlink refusal
  conditional on the caller — write must refuse a symlink final target unconditionally; only delete's
  unlink semantics make the exemption safe, and conflating the two resolvers risks losing that
  distinction on a future edit.
- Do not swap `deleteVaultFile`'s existence check back to `fs.existsSync` — same blindness as the main
  fix above, just on the delete path: it would misreport a live or dangling link as `"not-found"`.
