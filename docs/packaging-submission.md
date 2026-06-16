# Package-manager submission runbook (Homebrew · Scoop · winget)

How to ship the Loom CLI through Homebrew, Scoop, and winget — the Phase-2 convenience wrappers around
the published [`loomctl`](https://www.npmjs.com/package/loomctl) npm package (distribution rationale:
[`docs/spikes/releases-distribution-research.md`](spikes/releases-distribution-research.md), Option C).
npm stays the **primary** channel ([`docs/releasing.md`](releasing.md)); these wrap the same payload.

The **manifest files** live in [`packaging/`](../packaging/) and are generated from the root version
(see [`packaging/README.md`](../packaging/README.md)). This doc is the **submission** half.

> ## ⚠️ Everything in this runbook is an OWNER ACTION
> Creating registry/tap/bucket repos, computing hashes against published artifacts, and opening
> submission PRs all require accounts, credentials, and outward publishing the owner controls. **A
> worker or manager never performs these steps.** The in-repo deliverable is the generated, validated,
> version-templated manifests + this runbook. Each step below is tagged **[OWNER]**.

## Prerequisites (must be true before any submission)

1. **[OWNER]** The release is **published to npm** as `loomctl@X.Y.Z` (per `docs/releasing.md`). brew and
   scoop pull the npm registry tarball, so it must exist first.
2. **[OWNER]** The public GitHub repo `DanielC000/loom` exists with the `vX.Y.Z` release (tag + Release).
3. **[OWNER]** `packaging/**` has been regenerated at the release version and the `sha256` placeholders
   filled (see *Computing the hashes* below). Confirm `PackageVersion` / `url` / `version` all read
   `X.Y.Z` and no `REPLACE_WITH_SHA256_OF_PUBLISHED_ARTIFACT` remains.

## Computing the hashes

The generator leaves `REPLACE_WITH_SHA256_OF_PUBLISHED_ARTIFACT`. Fill the real values once the artifacts
are published, then re-run `pnpm manifests --sha-npm=… --sha-win-zip=…` (or hand-edit).

### npm tarball sha256 (Homebrew + Scoop)

Both wrap `https://registry.npmjs.org/loomctl/-/loomctl-X.Y.Z.tgz`. Download the **published** tarball
(not your locally-built one — they can differ) and hash it:

```sh
# [OWNER]
curl -fsSLO https://registry.npmjs.org/loomctl/-/loomctl-X.Y.Z.tgz
shasum -a 256 loomctl-X.Y.Z.tgz          # macOS/Linux  → the sha256 (hex)
# Windows:  (Get-FileHash -Algorithm SHA256 loomctl-X.Y.Z.tgz).Hash.ToLower()
```

> npm also exposes an integrity hash, but it is **SRI `sha512-<base64>`**
> (`npm view loomctl@X.Y.Z dist.integrity`) — that is NOT the sha256 hex these manifests need. Always
> compute sha256 from the downloaded `.tgz`. (Scoop's `autoupdate` is configured to recompute the hash
> itself on a version bump, so only the committed `hash` needs filling by hand.)

### win zip sha256 (winget) — **plus a prerequisite artifact**

winget cannot run npm, and its `portable` installer type accepts only an **`.exe`**. So winget wraps a
GitHub-Release zip `loomctl-X.Y.Z-win.zip` that must contain a `loom.exe` launcher:

- **[OWNER / INFRA — deferred]** Produce `loomctl-X.Y.Z-win.zip`. It must contain the assembled bundle
  under a top-level `loomctl-X.Y.Z-win/` dir with a working **`loom.exe`** at its root (the manifest's
  `NestedInstallerFiles.RelativeFilePath`). Options for `loom.exe`: a **Node SEA** (single-executable
  app) wrapping `bin/loom.mjs`, a packager (`pkg`/`nexe`), or a thin native stub that execs
  `node bin\loom.mjs`. If the launcher does **not** bundle Node, Node 22+ must be on the user's PATH —
  winget cannot declare a node/npm dependency. This artifact is **not produced by the release today**
  (the release attaches only the `.tgz`); building it is the deferred single-binary work. **Until it
  exists, do not submit the winget manifest.**
- Then hash it: `shasum -a 256 loomctl-X.Y.Z-win.zip` (or `Get-FileHash`).

## Homebrew

Two routes; **a custom tap is the right first step** (homebrew-core has a high bar and review latency).

### Route A — custom tap (recommended first) **[OWNER]**

1. Create a public repo **`DanielC000/homebrew-loom`** (the `homebrew-` prefix is mandatory; the tap is
   then `DanielC000/loom`).
2. Copy `packaging/homebrew/loomctl.rb` → `Formula/loomctl.rb` in that repo, with the sha256 filled.
3. (On a mac) audit + smoke-test before pushing:
   ```sh
   brew audit --strict --online --new Formula/loomctl.rb
   brew install --build-from-source Formula/loomctl.rb
   loom --version    # → v X.Y.Z
   ```
4. Commit + push. Users then install with:
   ```sh
   brew tap DanielC000/loom
   brew install loomctl       # exposes `loom`
   ```
5. **Per release:** regenerate the formula (`pnpm manifests`), fill the sha256, copy it into the tap repo,
   commit. (Optionally automate this from the release workflow with a PAT to the tap repo.)

### Route B — homebrew-core **[OWNER, later]**

Only once Loom is established (homebrew-core requires notability + a stable release history). Fork
`Homebrew/homebrew-core`, add `Formula/l/loomctl.rb`, run `brew audit --strict --new loomctl` +
`brew test`, and open a PR. Expect maintainer review. The tap (Route A) is the practical channel.

## Scoop

Scoop distributes via **buckets** (git repos of manifests). **[OWNER]**

1. Create a public repo **`DanielC000/scoop-loom`** (a Scoop bucket = a repo with a `bucket/` dir of
   `*.json` manifests).
2. Copy `packaging/scoop/loomctl.json` → `bucket/loomctl.json` with the sha256 filled.
3. (On Windows, with Scoop installed) validate + smoke-test:
   ```powershell
   scoop install main/dark   # if you want to lint; or use the bucket's checkver/autoupdate scripts
   # from a clone of the bucket repo:
   .\bin\checkver.ps1 loomctl        # if you vendor Scoop's checkver (optional)
   scoop install .\bucket\loomctl.json
   loom --version
   ```
   (Scoop ships `checkver.ps1`/`auto-pr.ps1` in its `Scoop-Bucket` template — the committed manifest's
   `checkver` + `autoupdate` blocks drive them so a version bump can be auto-PR'd.)
4. Commit + push. Users then install with:
   ```powershell
   scoop bucket add loom https://github.com/DanielC000/scoop-loom
   scoop install loomctl      # exposes `loom`
   ```
5. **Per release:** `checkver`/`autoupdate` (configured in the manifest) let Scoop's tooling bump the
   version + recompute the hash automatically; otherwise regenerate via `pnpm manifests` and fill the hash.

## winget

winget uses a **central community repo** — `microsoft/winget-pkgs` — there is no private bucket. **[OWNER]**

> **Blocked on the win-zip prerequisite above.** Do not start until `loomctl-X.Y.Z-win.zip` with a real
> `loom.exe` exists as a GitHub Release asset and `InstallerSha256` is filled.

1. Validate locally (Windows): `winget validate --manifest packaging\winget` *(done at authoring — passes
   against schema 1.6.0)*.
2. Test the install against the real manifest:
   ```powershell
   winget install --manifest packaging\winget
   loom --version
   ```
3. Submit. Easiest via **`wingetcreate`** (`winget install wingetcreate`):
   ```powershell
   wingetcreate submit packaging\winget       # opens the PR to microsoft/winget-pkgs for you
   ```
   Or manually: fork `microsoft/winget-pkgs`, place the three files under
   `manifests/l/Loom/Loomctl/X.Y.Z/`, and open a PR. An automated validation pipeline + maintainer review
   runs on the PR.
4. Users then install with:
   ```powershell
   winget install Loom.Loomctl       # exposes `loom`
   ```

## Per-release checklist (the whole loop)

1. **[OWNER]** Publish `loomctl@X.Y.Z` to npm + the GitHub Release (`docs/releasing.md`).
2. **[OWNER]** Compute the npm tarball sha256 (and, if shipping winget, build the win zip + its sha256).
3. **[OWNER]** `pnpm manifests --sha-npm=… [--sha-win-zip=…]`; commit `packaging/**`.
4. **[OWNER]** Homebrew: copy the formula into the tap repo (or let `autoupdate` PR it).
5. **[OWNER]** Scoop: `checkver`/`autoupdate` bumps the bucket, or copy the manifest in.
6. **[OWNER]** winget: `wingetcreate submit` (only once the win zip exists).
