# 884c8d56 — never ship `@loom/shared` via `bundledDependencies`

`npm i -g loomctl` failed on Windows for every published version (confirmed back to the first
npm-installable commit, 2026-06-09). `fsevents@2.3.2` — a transitive, macOS-only optional dependency
pulled in via `@playwright/mcp -> playwright -> chokidar` (`os:["darwin"]`) — tried to run its install
script (`node-gyp rebuild`) and failed (`gyp: binding.gyp not found`) instead of being skipped.

Root cause, confirmed by a controlled A/B test (two near-identical packed tarballs, both depending on
`@playwright/mcp`, differing only in whether `bundledDependencies` was set): `npm install --global` of
**any** tarball declaring `bundledDependencies` fails to os-gate-skip a transitive, OS-restricted
`optionalDependency` elsewhere in the tree. A plain `npm install` (local, non-global) of the identical
deps, and a `--global` install of the identical deps WITHOUT `bundledDependencies`, both skip it
gracefully. This matches a known, still-open upstream bug —
[npm/cli#7355](https://github.com/npm/cli/issues/7355), a regression from
[npm/cli#7126](https://github.com/npm/cli/pull/7126) on npm ≥10.4 — and a commenter on that thread
independently reports the exact same `bundledDependencies` trigger.

`@loom/shared` is private (not published to npm) and had been shipped via `bundledDependencies` since
the very first npm-installable commit (35abae9d, 2026-06-09) — the only reason `bundledDependencies` was
ever set at all. The fix (`scripts/build-npm-package.mjs`): vendor `@loom/shared`'s compiled `dist/`
**outside** `node_modules` (under `vendor/loom-shared/dist/`, listed in the package's `files`), and
resolve it at runtime via the package.json
[`imports`](https://nodejs.org/api/packages.html#subpath-imports) map (`"#loom-shared": "./vendor/loom-shared/dist/index.js"`)
instead of a bare `"@loom/shared"` specifier. Every compiled `from "@loom/shared"` import in the staged
`dist/**/*.js` is mechanically rewritten to `from "#loom-shared"` (`rewriteSharedSpecifiers` — narrow,
deliberately: only the one form tsc emits for a value import/re-export). The build refuses to pack
(exit 1) if any `@loom/shared` specifier of ANY form survives the rewrite — `from`, a bare `import`, a
dynamic `import()`, a `require()`, either quote style, or a subpath (`survivingSharedImportSpecifiers`,
restricted to `.js` — the shipped `.d.ts` files also carry the `from`-form harmlessly, with no runtime
import resolution to break) — or if the package.json ACTUALLY WRITTEN to disk carries
`bundledDependencies` or its alias `bundleDependencies` at all, regardless of array length (re-read from
disk, not checked against the in-memory object literal, which never set either key and so could never
have caught a reintroduction). Proven end-to-end: the pre-fix staging (reverted to HEAD) packs a tarball
that fails `npm i -g` with the same `binding.gyp` error; the post-fix staging packs a tarball that
installs cleanly (exit 0, `fsevents` correctly skipped), `loom --version` runs from the installed global
prefix via the platform-correct shim on `PATH`, and a dynamic import of a real nested `dist/` module
resolves `"#loom-shared"` correctly.

A release-CI job (`global-install-smoke`, `.github/workflows/release.yml`) now packs the real tarball and,
on both `windows-latest` and `ubuntu-latest` before publish, runs a real `npm i -g` + `loom --version`
(resolved via the platform-correct bin dir on `PATH` — POSIX puts shims in `<prefix>/bin`, Windows puts
them directly in `<prefix>`; a hand-built `<prefix>/node_modules/loomctl/bin/loom.mjs` path is correct on
Windows only and would `MODULE_NOT_FOUND` on the ubuntu leg — and on Windows the prefix is `cygpath -u`'d
into POSIX form before joining `PATH`, so the bare `loom` shim resolves correctly on both legs, one code
path; see the "Do not" below for why) AND a dynamic-import smoke
(`scripts/smoke-dist-shared-import.mjs`) that imports a real nested `dist/` module through the
`"#loom-shared"` imports map — `loom --version` alone only proves `bin/loom.mjs` runs; it never loads
`dist/` or `vendor/`, so it cannot catch a broken imports-map resolution, a missed rewrite, or a missing
`vendor` entry in the packed `files` (it does NOT, on its own, prove anything about a missing *runtime*
dependency — the imported module itself pulls in no third-party dependency). Together they close the gap
so a regression of this kind fails the release instead of shipping silently (there was previously no real
global-install smoke test at all).

## Do not

- Do not reintroduce `bundledDependencies` (or `bundleDependencies`) anywhere in the generated/published
  `loomctl` package.json for any dependency, however private or small — the trigger is the field's mere
  *presence*, not which package it names. If a future private workspace package needs to ship inside the
  tarball, vendor it the same way (outside `node_modules`, resolved via `imports` or an equivalent
  relative path), not via `bundledDependencies`.
- Do not assume removing today's one offending dependency (`@playwright/mcp` → `fsevents`) closes this —
  the upstream npm bug (npm/cli#7355) is still open. Any future dependency with a transitive
  OS-restricted `optionalDependency` would silently reintroduce the exact same failure if
  `bundledDependencies` ever comes back. The `global-install-smoke` CI job is the standing guard against
  that, not a one-time check — do not remove it once this specific dependency chain changes.
- Do not add a per-file relative-path rewrite (computing `../../vendor/...` depth per importing file)
  as an alternative to the `imports` map — it was considered and rejected for needing more moving parts
  (every file's depth under `dist/` would need computing and would silently break if a file moved).
- Do not rewrite a bare substring match of `@loom/shared` anywhere in the compiled JS — only the exact
  `from "@loom/shared"` import-specifier form. `packages/daemon/src/orchestration/deploy-packages.ts`
  (compiled to `dist/deploy-packages.js`) has a legitimate **data** string `{ name: "@loom/shared", ... }`
  (the daemon-restart dependency-change map) that must never be rewritten — it names a workspace package
  for an unrelated purpose, not a module specifier. The post-rewrite SURVIVOR check is the opposite: keep
  it WIDE (every specifier form), since under-catching there ships a tarball with an unresolvable runtime
  reference.
- Do not hand-build a global-install bin path (e.g. `<prefix>/node_modules/loomctl/bin/loom.mjs`) in a
  release-CI smoke step — npm's `--prefix` global-install layout differs by platform (POSIX:
  `<prefix>/bin` + `<prefix>/lib/node_modules`; Windows: `<prefix>` + `<prefix>/node_modules`), so a
  hand-built path is correct on one platform and `MODULE_NOT_FOUND`s on the other. Put the right bin dir
  on `PATH` and run the real installed shim; resolve the package-tree root via `npm root -g --prefix`,
  never a hand-built join.
- Do not join a Windows-form path (e.g. `$RUNNER_TEMP`, which reaches a `shell: bash` step on
  `windows-latest` as e.g. `D:\a\_temp`) directly into `PATH` in a Git-for-Windows MSYS Git Bash step
  (`PATH="$PREFIX:$PATH"`). `PATH` is colon-separated, so a backslash path's own drive-letter colon
  splits it and the drive letter is lost (`D:\a\_temp\...` -> `D` + `\a\_temp\...`). npm's generated sh
  shim computes its own `$0`/basedir via `sed`+`cygpath -w`, and a drive-missing basedir gets re-mapped
  onto the MSYS/Git install root (e.g. `C:\Program Files\Git\a\_temp\...`) instead of the real path — a
  genuine `MODULE_NOT_FOUND` for a path that was never real. Reproduced directly in Git Bash with a
  scratch prefix + a shim mirroring npm's real basedir computation (logs under
  `$LOOM_PROJECT_WORK_DIR/884c8d56/` at the time this was fixed). Fix: `cygpath -u` the prefix into POSIX
  form before putting it on `PATH`, then run the bare `loom` name — this works identically on both
  platforms, one code path. **Do not instead reach for `loom.cmd` as the fix** — an earlier round of this
  card did exactly that, misdiagnosing the failure as an "MSYS argv-mangling bug" specific to the bare
  `loom` shim; `loom.cmd` only happened to avoid the failure because it's a plain batch wrapper that never
  computes a basedir from `$0` at all, and the Windows-form `PATH` entry it was still given "worked" only
  because the drive-relative remainder happened to resolve against the runner's own cwd drive — it never
  fixed the real cause, and a host where cwd and `$RUNNER_TEMP` sit on different drives would still break.
- Do not assume `loom --version` (`bin/loom.mjs`) exercising cleanly is proof the `"#loom-shared"`
  resolution works — it only reads `package.json`, never `dist/` or `vendor/`. A smoke that wants to
  prove the vendored-shared resolution end to end must dynamic-import a real nested `dist/` module.
- Do not check `bundledDependencies`/`bundleDependencies` against the in-memory package.json object
  literal `scripts/build-npm-package.mjs` builds — re-read the file ACTUALLY WRITTEN to disk. A check
  against a literal that never sets either key anywhere in the script can never fire even if a future
  edit reintroduces the field.
