# e7d6e43b — npm-pinned: why `shell:true` is safe here, and what "pinned" actually covers

Card e7d6e43b added a seed-only "npm-pinned" capability provision kind
(`packages/daemon/src/capabilities/npm-pinned.ts`) that installs a pinned npm package with
`npm install --ignore-scripts` into `<LOOM_HOME>/node/<package>/<version>/`.

## Why `npm install` is spawned with `shell:true`

On Windows, `npm` resolves to `npm.cmd`, a batch file. Node's own CVE-2024-27980 mitigation
(18.20.2/20.12.2/22.x+) refuses to `spawn()`/`spawnSync()` a `.cmd`/`.bat` `command` directly without
`shell:true` — Windows' `CreateProcess` implicitly hands a batch file to `cmd.exe` regardless of the
caller's shell option, so Node throws a synchronous `EINVAL` rather than risk an unescaped argument
reaching that implicit shell.

`pty/resolve-bin.ts`'s `parseNpmCmdShim`/`winCmdShimSpawnTarget` already solve this shell-free for an
**installed package's own bin** — a real npm `cmd-shim`-generated `.cmd`. They do NOT apply to `npm`'s
own launcher, which is NOT cmd-shim-generated (it ships with the Node.js Windows distribution, a
different, hand-written template) — so that module's parser simply does not match it, and there is no
existing shell-free path to spawn `npm` itself on Windows.

`shell:true` + a single hardcoded command **string** (never an argv array built from untrusted input) is
the established daemon-internal precedent for exactly this situation — `git/worktrees.ts`'s
`pnpmInstall`/`runBoundedInstall` (worktree dep-provisioning) and `orchestration/gate-runner.ts`'s gate
step runner both do the same thing, for the same reason.

## Why it is safe specifically here

Every value interpolated into the command string is validated by `validateNpmPinnedSpec` **before** the
string is ever built — `package` against a strict npm-name allowlist, `version` against an exact-semver
allowlist (no ranges/tags/URLs/`file:`/`git:` specs), `binRelativeToPackageJson` against a
relative-path-with-no-`..` allowlist. This kind is SEED-ONLY (`validateCapabilityDefInput` never accepts
it from an owner, same posture as `github-binary`) — so every value that ever reaches this module was
authored in `capabilities/seed.ts`, reviewed, and committed. The validator exists as defense-in-depth
against a hand-edited or otherwise corrupted DB row, not because seed-authored constants are expected to
be hostile.

The install's own working directory (never put through the shell's own `%VAR%`/`$`/backtick parsing) is
used via `--prefix .` with `cwd` set to the Loom-created temp install directory — no path is ever
interpolated into the command string at all (see Code Review round 1's Minor #1: an earlier revision
quoted `--prefix "${dir}"` directly in the command string, which is NOT shell-safe — `%VAR%` still expands
on `cmd.exe` and `$`/`` ` `` still expand on `sh` even inside double quotes).

## Atomicity and tree-kill (Code Review round 1's Major finding)

`npm install` extracts straight into its `--prefix` target over many small file writes. A killed-mid-
install child (a timeout, a daemon crash, a daemon restart) can leave a tree whose bin file already exists
but whose package is only partially written — if the hot path (`resolveNpmPinned`'s `fs.existsSync`) ever
checked that path directly, it could observe a half-written install as "ready".

`ensureNpmPinnedAsync` therefore installs into a TEMP SIBLING directory (`.{version}.tmp-{random}`, a
sibling of the final `<version>` dir, same parent) first — verifies the real exit code AND the expected
bin INSIDE the temp dir, and only THEN `fs.renameSync`s the whole tree into the final path as the LAST
step (mirrors `github-binary.ts`'s `extractGithubBinary` atomic temp-then-rename shape, generalized from
one file to a whole installed package tree). The hot path can therefore only ever observe a FULLY
installed tree at the final path, never a partial one.

The timeout path kills the WHOLE PROCESS TREE via the shared `killGateProcessTree` helper
(`orchestration/gate-runner.ts`, the same one `git/bounded.ts` reuses), not a plain `child.kill()`.
`shell:true` makes the spawned `child` a `cmd.exe`/`sh` whose own child (the real `npm`, and its own
node-process descendants) a plain kill never reaches — on Windows this left the real npm process (and
whatever reify work it was mid-way through) running as an orphan after a timeout, and a later retry kick
could then race a SECOND npm into a sibling temp directory. Verified directly (round 2 Code Review): a
real Windows timeout probe with a negative control confirmed the orphan is actually killed.

An abandoned `.{version}.tmp-{random}` dir (left by a crash, a failed tree-kill, or a daemon restart
mid-install) is swept at the START of every `ensureNpmPinnedAsync` call via `sweepStaleTmpInstallDirs` —
best-effort, logged, keyed only on the `.`-prefixed `.tmp-` naming shape (never the final, un-prefixed
`<version>` dir), and only once its mtime is older than the install timeout (young enough to plausibly
still be in-flight is left alone).

**Named residual, not closed by this card:** the per-slug in-flight dedupe (`kickCapabilityProvision`,
registry.ts) keys on SLUG, never on `package@version`. Two DIFFERENT slugs whose rows both resolve to the
same `package@version` (not something Loom's own seed data does today — only "image-gen" uses this kind)
could both call `ensureNpmPinnedAsync` concurrently for that same install. The atomic rename makes this
benign (a wasted duplicate install, last-rename-wins) rather than a corruption or a rename failure, but it
is not deduped the way two resolves of the SAME slug are.

## Do not (atomicity / tree-kill)

- Do not install directly into the final `<version>` dir — always a temp sibling, verified, then renamed
  into place as the LAST step. A direct-install "optimization" reopens the exact partial-tree-visible-as-
  ready defect this section exists to close.
- Do not kill only the shell (a plain `child.kill()`) on timeout — it leaves the real `npm` process (and
  its own descendants) running as an orphan on Windows, and a later retry can race a second install. Kill
  the whole process tree via the shared `killGateProcessTree` helper, never a hand-rolled kill-by-pid.
- Do not treat the stale-tmp-dir sweep as a substitute for the atomic rename, or vice versa — the rename
  is what keeps a PARTIAL install from ever being visible as ready; the sweep is what keeps an ABANDONED
  tmp dir from accumulating forever. Removing either reopens a different defect.

## Do not

- Do not re-attempt interpolating a path (or any other value) directly into the `npm install` command
  string "just this once" — route it through `cwd` + a relative `--prefix .` instead, or validate it with
  the same rigor `validateNpmPinnedSpec` already applies to `package`/`version`/`binRelativeToPackageJson`.
- Do not widen `validateNpmPinnedSpec`'s allowlists to accept a version range, a dist-tag, a URL, or a
  `file:`/`git:` spec — the whole point of this kind is an EXACT, reviewed pin; any of those would let
  `npm install` resolve to something other than the exact release this kind exists to guarantee.
- Do not call `ensureNpmPinnedAsync`/spawn `npm install` from any path that skips `resolveNpmPinned`'s own
  validate-before-existsSync ordering (registry.ts) — validation must run before ANY path is built from
  the provision's own fields, including the `fs.existsSync` hot-path check itself. An earlier revision
  validated only inside `ensureNpmPinnedAsync` (the cold/background path), which meant a corrupted row's
  `binRelativeToPackageJson` (e.g. `"../../x.js"`) could resolve `loomNpmPinnedBin`'s `path.join` outside
  the intended install directory and have the HOT PATH's `fs.existsSync` see a real, unrelated,
  already-existing file as "ready" — a validator bypass, never exercised, found by Code Review.

## What "pinned" actually covers (document this scope, don't silently rely on it being wider)

`version` pins the **top-level package only**. Its own transitive dependencies are NOT pinned by this
kind — `npm install` with no lockfile present in the (fresh, per-version) install directory resolves each
dependency's own `package.json` `dependencies` ranges (typically caret ranges) against whatever is
currently published at install time. A dependency could legitimately resolve to a different concrete
version between two installs of the exact same top-level pin.

This is **not a regression** versus the original `bundled`/npx shape it replaces — an unpinned `npx`
re-resolved the top-level package itself on every spawn, which this kind fixes; transitive-dependency
drift existed under npx too (npx's own install has the same no-lockfile resolution) and is unchanged
either way. A future, stricter pin (committing a lockfile per package/version, or `npm install
--package-lock-only` + `npm ci`) is a real option if transitive drift ever becomes a concrete problem,
but is out of scope for this card.
