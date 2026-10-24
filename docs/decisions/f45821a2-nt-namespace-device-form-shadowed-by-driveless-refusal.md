# f45821a2 — keep the device-form refusal for NT-namespace vault paths, instead of shadowing it with the generic drive-less message

Card `f45821a2`. REGRESSION ON MAIN from `b709113e` ("fix(vault): refuse a drive-less rooted vaultPath on
Windows"), caught by an ungated landing's dist-importer check: `packages/daemon/test/vault-path-review-bypasses.mjs`'s
(A8) assertion expects a `vaultPath` spelled as the NT native namespace prefix (`\??\<drive>:\...\docs`)
to be refused with a message matching `/network\/device form/` — the specific, established device-form
refusal `checkVaultPathRepoContainment`/`canonicalizeForContainment` (via `isUnsafeToCanonicalize`) already
produce for exactly this form.

`b709113e`'s `isWin32DriveLessRootedPath` (`projects/vault-path.ts`) treats any win32-absolute path with
no drive letter and no `\\`/`//`-rooted UNC prefix as "drive-less". The NT native namespace prefix
(`\??\...`) is rooted with a SINGLE leading backslash — not a drive letter, not a double-backslash UNC
form — so it fell through to "drive-less" and got refused by `validateVaultPath` with the generic
drive-less message, BEFORE the path ever reached the more specific device-form check. The path was still
refused either way (never a security regression — only a wrong, less actionable message), but it broke
the test's reliance on the established, specific wording.

Root cause, verified: `validateVaultPath` (called via `checkVaultPathUpdate`/directly) always runs BEFORE
`checkVaultRepoTripleContainment` on every write surface (REST create/PATCH, the manager's own
`project_update`, `loom-setup`'s, and the elevated `loom-platform`'s) — confirmed by reading all five call
sites in `gateway/server.ts`, `sessions/service.ts`, `mcp/platform.ts`, and `mcp/setup.ts`. So whichever
check fires first on a given form OWNS that form's error message.

## Fix

`isWin32DriveLessRootedPath` now also excludes any path `isUnsafeToCanonicalize` already recognizes as a
network/device form (the NT native namespace prefix, a DOS device namespace path, a UNC share, or the UNC
spelling of extended-length — everything that regex refuses) — letting such a path flow through
`validateVaultPath` as `ok`, so the downstream `checkVaultRepoTripleContainment` → `canonicalizeForContainment`
→ `isUnsafeToCanonicalize` call (run unconditionally on every create/update surface whenever vaultPath is
part of the effective triple) is the one that refuses it, with its own specific message. The safe
extended-length LOCAL drive form (`\\?\<drive>:\...`) was already excluded from the drive-less check (it
starts with `\\`), so it is unaffected and continues to validate as `ok` all the way through.

A plain POSIX-rooted path with no device/network prefix at all (e.g. `/tmp`, `\tmp`) is NOT a recognized
network/device form (`isUnsafeToCanonicalize` returns `false` for it), so it is untouched by this change
and still gets `b709113e`'s drive-less refusal exactly as before.

## Verified

`vault-path-review-bypasses.mjs` and `vault-path-absolute.mjs`, run directly, in both `LOOM_DEV` states
(unset and `LOOM_DEV=1`): before the fix, exactly one assertion failed in both states — (A8) in
`vault-path-review-bypasses.mjs` — and `vault-path-absolute.mjs` was clean in both states throughout.
After the fix, both files pass fully in both states. `b709113e`'s own guard (the drive-less refusal for a
plain `/tmp`/`\tmp`) was independently re-checked and stays green.

## Do not

- Do not re-widen `isWin32DriveLessRootedPath`'s UNC/drive exclusions ad hoc for a new device/namespace
  form — route the exclusion through `isUnsafeToCanonicalize` (as this fix does) so the two checks can
  never again classify the same form two different, drifting ways.
- Do not assume a network/device form is unreachable past `validateVaultPath` without re-confirming every
  write surface still runs `checkVaultRepoTripleContainment` right after it — this fix's correctness
  depends on that invariant holding on every create/update path; if a new write surface is ever added that
  skips the triple-containment check, a network/device form it accepts would pass `validateVaultPath` with
  no refusal at all.
- Do not change the ORDER of these two checks (drive-less first, device-form second via containment) to
  "fix" this a second way — the fix here is narrowing which forms the FIRST check claims, not reordering
  which check runs first; reordering would re-open the question of what a write surface that never reaches
  the containment check (today, none) would do with a bare device-form path.
