# Releasing Loom

How to cut a Loom release end-to-end. Distribution rationale (why npm, the channel model, the
deferred desktop/single-binary phases) lives in
[`docs/spikes/releases-distribution-research.md`](spikes/releases-distribution-research.md); this doc
is the **operational runbook**.

> Status: Loom is **pre-1.0 and not yet published**. The flow below is the agreed process. The npm
> package itself (`bin`, publishable `loom`) shipped in Releases v1 **Part 2** — `pnpm pack:npm`
> produces a locally-installable `loom-X.Y.Z.tgz` (see *Building & locally installing the npm package*
> below). The CI that automates the GitHub Release + npm publish from a pushed tag shipped in
> **Part 4** (`.github/workflows/release.yml` — see *Automated release (CI)* below). Until the owner
> performs the one-time setup (public repo, reserved name, license, `NPM_TOKEN`), nothing actually
> publishes; the workflow is authored and waiting.

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

Once the owner's one-time setup is done (see *Automated release (CI)* below), cutting a release is
**land the changelog + version bump, then push the tag** — CI does the build, test, npm publish, and
GitHub Release.

1. **Land everything** for the release on `main` and confirm green: `pnpm build` + the hermetic
   daemon suite (`pnpm --filter @loom/daemon test:daemon`).
2. **Update `CHANGELOG.md`.** Move the `Unreleased` items into a new `## [X.Y.Z] — YYYY-MM-DD`
   section (keep an empty `Unreleased` on top). This section's text becomes the GitHub Release notes
   (the CI extracts it with `scripts/extract-changelog.mjs X.Y.Z`).
3. **Bump the version** with npm so the tag and the root `package.json` move together:
   ```sh
   npm version <major|minor|patch>     # e.g. `npm version minor` → 0.1.0 → 0.2.0
   ```
   `npm version` edits the root `package.json` `version`, commits it, and creates an annotated
   **`vX.Y.Z` git tag** in one step. (Use `--no-git-tag-version` only if you need to stage the
   CHANGELOG edit into the same commit, then tag manually with `git tag -a vX.Y.Z`.) **The tag
   version must match `package.json`** — the release workflow fails fast if they diverge.
   - For a **prerelease**, tag `vX.Y.Z-beta.N` (the version carries the `-beta.N`): CI publishes it
     to the **`beta`** npm dist-tag and marks the GitHub Release as a prerelease.
4. **Push** the commit and the tag — this **triggers the release workflow**:
   ```sh
   git push && git push --tags         # pushing vX.Y.Z runs .github/workflows/release.yml
   ```
   The workflow then (steps 5–7, automated): checks out → Node 22 + pnpm → `pnpm install` →
   `pnpm build` → daemon test gate → `pnpm pack:npm` → **`npm publish`** (to `latest`, or `beta`
   for a prerelease tag, with `--provenance`) → **creates the GitHub Release** with the CHANGELOG
   section as notes and `loom-X.Y.Z.tgz` attached. Watch it under the repo's **Actions** tab.

If you ever need to run any of these by hand (no CI, or a recovery), the manual equivalents are:

- **Build the artifact:** `pnpm pack:npm` → `loom-X.Y.Z.tgz` at the repo root.
- **Create the GitHub Release:** `gh release create vX.Y.Z --title "vX.Y.Z" \`
  `--notes-file <(node scripts/extract-changelog.mjs X.Y.Z) loom-X.Y.Z.tgz`.
- **Publish to npm:** owner-only, irreversible, outward — see *Owner publish steps* below.

## Automated release (CI)

`.github/workflows/release.yml` automates the publish + GitHub Release from a pushed `v*` tag (it
also accepts a manual **workflow_dispatch** run, which releases the version currently in
`package.json`). A companion `.github/workflows/ci.yml` runs the **build + daemon test gate** on
every PR and `main` push (no publish, no secrets) — the same gate the release runs before shipping.

**Owner one-time setup (the release workflow is inert until all are done):**

1. **The public GitHub repo must exist.** Pushing tags + Actions + Releases all require the repo to
   be published on GitHub (tied to the repo-publication work in the blocked lane). Until then the
   workflow file simply rides along unused.
2. **Reserve the npm name + add a license.** Same prerequisites as a manual publish (see *Owner
   publish steps*): own the `loom` name (or set the published name in `scripts/build-npm-package.mjs`)
   and add a `LICENSE` + `"license"` to the generated `package.json` — the workflow publishes
   whatever `pnpm pack:npm` produces.
3. **Add the `NPM_TOKEN` repo secret.** Create an npm **automation** (or publish) token on the
   publishing account and add it under *Settings → Secrets and variables → Actions* as `NPM_TOKEN`.
   The workflow reads it as `NODE_AUTH_TOKEN` for `npm publish`. (`GITHUB_TOKEN` is provided
   automatically; the workflow grants it `contents: write` for the Release and `id-token: write` for
   npm provenance — no extra secret needed.)

**Cut a release:** push a `vX.Y.Z` tag (step 4 above). That's the whole trigger. Prerelease tags
(`vX.Y.Z-beta.N`) go to the `beta` channel; normal tags go to `latest`.

## Building & locally installing the npm package

The publishable `loom` package is **assembled**, not the dev root packed directly — the published
shape differs from the monorepo (clean deps, a generated `package.json`, the private `@loom/*` built
output bundled in). One command does it:

```sh
pnpm pack:npm        # → loom-X.Y.Z.tgz at the repo root
```

`scripts/build-npm-package.mjs` builds the workspace, then assembles `dist-npm/` and runs `npm pack`:

| In the package | Source | Why there |
|---|---|---|
| `dist/` | `packages/daemon/dist` (copied as-is, **not** bundled) | daemon entry `dist/index.js`; copying preserves each module's `import.meta.url` so the daemon's relative asset lookups still resolve |
| `dist/web/` | `packages/web/dist` | Part 1's `resolveWebDistDir()` resolves `<daemon-dist>/web` |
| `assets/` | `packages/daemon/assets` | the daemon reads `hook-relay.mjs` / `vault-lint.mjs` / bundled skills LIVE from here |
| `node_modules/@loom/shared/` | `packages/shared/dist` | `@loom/shared` is private (not on npm) → shipped as a **`bundledDependency`** |
| `bin/loom.mjs` | repo `bin/` | the `loom` command: boots the daemon, waits for `/api/version`, opens the browser |
| `package.json` | generated; `version` = root `package.json` | `name:"loom"` above the daemon satisfies Part 3's `loomVersion()` walk-up — `GET /api/version` returns the real version |

Native deps (`better-sqlite3`, `node-pty`) and the runtime-resolved `@playwright/mcp` stay **real
`dependencies`**, so a plain `npm install` fetches their prebuilt binaries. **pnpm is a contributor
tool only** — end users need just Node 22+.

**Smoke-test the tarball in a clean dir** (the install path an end user takes — never the repo):

```sh
mkdir /tmp/loom-test && cd /tmp/loom-test && npm init -y
npm install /path/to/loom-X.Y.Z.tgz
# isolate state so the smoke test never touches the real ~/.loom or a running :4317 daemon:
LOOM_HOME=$PWD/.home npx loom --no-open --port 4399
curl -s http://127.0.0.1:4399/api/version     # → {"version":"X.Y.Z"}  (the real installed version)
```

`loom` (no flags) boots on `:4317` and opens the browser; `--port <n>` / `--no-open` / `--version` /
`--help` are the flags.

## Owner publish steps (the irreversible, outward part)

`npm publish` is gated on the owner — it needs npm credentials, the `loom` name, and the
license/signing decisions below. **A worker/manager never runs it.** One-time + per-release:

1. **Reserve the name.** Confirm `loom` is available/owned on npm (`npm view loom`); claim it while
   logged in if free. If taken, pick the published name and set it in `scripts/build-npm-package.mjs`
   (the generated `package.json` `name`) before the first publish.
2. **Pick a license.** The generated `package.json` ships **no `license` field** (deliberate — it's an
   owner/legal call). Add the chosen license (`LICENSE` file + `"license"` in the script's generated
   `package.json`) before publishing a public package.
3. **`npm login`** as the publishing account.
4. **Build fresh + publish** (always re-run `pnpm pack:npm` immediately before, so the tarball matches
   the tag):
   ```sh
   pnpm pack:npm
   npm publish loom-X.Y.Z.tgz --access public        # → the `latest` dist-tag (stable channel)
   ```
5. **Signing / provenance (optional, recommended).** npm has no app-signing burden (see the research
   doc), but you can add **publish provenance** by running the publish from CI with
   `npm publish --provenance` — which the release workflow (`.github/workflows/release.yml`) already
   does (it grants `id-token: write` for OIDC). For pre-release betas use `--tag beta` (below).

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
