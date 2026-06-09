# Releasing Loom

How to cut a Loom release end-to-end. Distribution rationale (why npm, the channel model, the
deferred desktop/single-binary phases) lives in
[`docs/spikes/releases-distribution-research.md`](spikes/releases-distribution-research.md); this doc
is the **operational runbook**.

> Status: Loom is **pre-1.0 and not yet published**. The flow below is the agreed process; the npm
> package itself (`bin`, publishable `loom`) is built in Releases v1 **Part 2**, and the CI that
> automates the GitHub Release is **Part 4**. Until the first publish, steps still run locally
> (`npm pack`, a git tag, a GitHub Release) — only `npm publish` waits on Part 2 + the owner's go.

## Versioning scheme

- **Single source of truth:** the umbrella **`loom`** package version in the **root `package.json`**.
  That is the one number users see (`loom --version`, `GET /api/version`, the web header chip). The
  daemon reads it **at runtime** (`packages/daemon/src/version.ts` walks up to the `name:"loom"`
  package.json) — there is no second hardcoded copy to drift, and `LOOM_VERSION` can override it.
- **Internal `@loom/*` packages stay private `0.0.0`.** `@loom/shared`, `@loom/daemon`, and
  `@loom/web` are `private: true` workspace packages that are never published on their own — they
  ship *inside* the `loom` package. They are deliberately **not** moved in lockstep: bumping them
  would be churn with no consumer. Only the umbrella `loom` version moves.
- **Semver, pre-1.0.** We are in `0.y.z`. While `< 1.0.0`, the **minor** (`y`) carries breaking
  changes and notable features; **patch** (`z`) is fixes and small additions. The first real version
  is **`0.1.0`**. The `1.0.0` line begins when the public surface (the npm package + update flows) is
  stable; from `1.0.0` on, standard semver (major = breaking) applies.

## Cutting a release

1. **Land everything** for the release on `main` and confirm green: `pnpm build` + the hermetic
   daemon suite (`pnpm --filter @loom/daemon test:daemon`).
2. **Update `CHANGELOG.md`.** Move the `Unreleased` items into a new `## [X.Y.Z] — YYYY-MM-DD`
   section (keep an empty `Unreleased` on top). This section's text becomes the GitHub Release notes.
3. **Bump the version** with npm so the tag and the root `package.json` move together:
   ```sh
   npm version <major|minor|patch>     # e.g. `npm version minor` → 0.1.0 → 0.2.0
   ```
   `npm version` edits the root `package.json` `version`, commits it, and creates an annotated
   **`vX.Y.Z` git tag** in one step. (Use `--no-git-tag-version` only if you need to stage the
   CHANGELOG edit into the same commit, then tag manually with `git tag -a vX.Y.Z`.)
4. **Push** the commit and the tag:
   ```sh
   git push && git push --tags
   ```
5. **Build the artifact** to attach to the release:
   ```sh
   pnpm build                          # builds shared → daemon → web
   npm pack                            # → loom-X.Y.Z.tgz (the publishable tarball)
   ```
6. **Create the GitHub Release** from the tag, with the CHANGELOG section as notes and the tarball
   attached (the owner wants tagged releases "like other repos have"):
   ```sh
   # notes = that version's CHANGELOG section (extract it into a temp file, e.g. notes-X.Y.Z.md)
   gh release create vX.Y.Z --title "vX.Y.Z" --notes-file notes-X.Y.Z.md loom-X.Y.Z.tgz
   ```
   Part 4 automates exactly this from the pushed tag in CI.
7. **Publish to npm** (after Part 2 makes `loom` publishable, and only on the owner's explicit go):
   ```sh
   npm publish --access public                 # → the `latest` dist-tag (stable channel)
   ```

## Channels (npm dist-tags)

Following the OpenClaw model in the research doc:

- **stable** → the `latest` dist-tag. End users install/update with:
  ```sh
  npm i -g loom@latest
  ```
- **beta** → a `beta` dist-tag for pre-releases (`X.Y.Z-beta.N`), published with
  `npm publish --tag beta` and installed via `npm i -g loom@beta`. A beta publish must **not** move
  `latest`.
- Promote a vetted beta to stable by re-tagging instead of re-publishing:
  `npm dist-tag add loom@X.Y.Z latest`.

## Updating an installed Loom

- **CLI:** `npm i -g loom@latest` (or `loom@X.Y.Z` to pin / `loom@beta` for the beta channel).
- A daemon run under the **supervisor** (`pnpm daemon:stable`) adopts new code by exiting with the
  restart sentinel (exit `75`); outside the supervisor, restart `loom` after the install. A
  dep-adding upgrade needs the install to land **before** the restart (see `CLAUDE.md`).
- **From the UI** (a later layer, after the first publish): the daemon polls the npm registry's
  `dist-tags.latest`, shows an unobtrusive "update available" banner, and a **human-only** "Update &
  restart" REST action runs the install + exit-75 restart. Self-update is a privileged, outward-acting
  operation, so — like the vault/git writers — it is **never** an agent MCP tool.
