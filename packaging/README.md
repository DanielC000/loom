# `packaging/` — package-manager manifests

The Homebrew / Scoop / winget manifests that **wrap the published `loomctl` npm package** (Releases v1
distribution spike, Option C / Phase 2). These are convenience wrappers around the same payload `npm i
-g loomctl` installs — Loom is genuinely Node, so npm stays the primary channel.

> **These files are IN-REPO ARTIFACTS only.** Generating and committing them here is a worker/CI task.
> **Submitting them to a registry (and creating the brew tap / scoop bucket) is an OWNER action** —
> see [`docs/packaging-submission.md`](../docs/packaging-submission.md) for the full runbook.

## Layout

```
packaging/
  homebrew/loomctl.rb                    Homebrew formula (Node-CLI-from-npm pattern; depends node@22)
  scoop/loomctl.json                     Scoop manifest (Windows; depends nodejs-lts)
  winget/Loom.Loomctl.yaml               winget version manifest (multi-file layout, schema 1.6.0)
  winget/Loom.Loomctl.installer.yaml     winget installer manifest
  winget/Loom.Loomctl.locale.en-US.yaml  winget default-locale manifest
```

## Generated — do not hand-edit

All five files are **generated** by [`scripts/generate-manifests.mjs`](../scripts/generate-manifests.mjs)
from the **root `package.json` version** — the same single source of truth `scripts/build-npm-package.mjs`
reads for the published `loomctl` package. A release bumps them in lockstep:

```sh
npm version <major|minor|patch>   # moves the root version (per docs/releasing.md)
pnpm manifests                    # regenerate packaging/** at the new version
git add packaging && git commit
```

The `sha256` of each published artifact is unknown until it is published, so the generator leaves a loud
`REPLACE_WITH_SHA256_OF_PUBLISHED_ARTIFACT` placeholder. Fill them at submission time — either by hand or
by re-running the generator with the hashes (it overwrites the files):

```sh
pnpm manifests --sha-npm=<sha256 of the npm tarball> --sha-win-zip=<sha256 of the win zip>
```

See the runbook for how to compute/fetch each hash.

## What wraps what

| Manifest | Wraps | Notes |
|---|---|---|
| Homebrew | the **npm registry tarball** `registry.npmjs.org/loomctl/-/loomctl-X.Y.Z.tgz` | `Language::Node` + `std_npm_args`; `depends_on "node@22"`. Native deps (`better-sqlite3`, `node-pty`) install via npm-fetched prebuilt binaries. |
| Scoop | the same **npm registry tarball** | `depends: nodejs-lts`; install script runs `npm install --omit=dev` then writes a `loom.cmd` shim. `checkver`/`autoupdate` track the npm registry. |
| winget | a **GitHub-Release zip** `loomctl-X.Y.Z-win.zip` | winget has no npm step and its `portable` type accepts only an **`.exe`**, so the zip must bundle a `loom.exe` launcher — a **deferred OWNER prerequisite** (the single-binary phase). winget is the weakest fit; npm/brew/scoop are the real channels today. |

## Validation done at authoring (2026-06-16)

- **winget** — `winget validate --manifest <dir>` → **passed** (validated against schema 1.6.0 with a
  stand-in sha; the committed files keep the placeholder).
- **Scoop** — the JSON is machine-generated and parses; **`scoop` is not installed on the authoring box**,
  so it was not run through Scoop's own checks. Manual review against the Scoop manifest reference.
- **Homebrew** — **`brew`/`ruby` are not installed on the authoring box**, so `brew style`/`brew audit`
  were not run. The formula follows the conventional Node-from-npm pattern; `desc` is kept ≤ 80 chars and
  free of em dashes per `brew audit --strict`. Re-run `brew audit --strict --new loomctl` on a mac before
  the first tap submission (an OWNER step in the runbook).
