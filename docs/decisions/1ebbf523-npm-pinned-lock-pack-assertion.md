# 1ebbf523 — assert every npm-pinned lock survives `npm pack`, not just the source tree

Card 66ab2bc0's second Code Review (reviewer fb56182b) found that `scripts/build-npm-package.mjs`'s
`firstNpmPinnedLockAsset()` check (added by that card) only verifies ONE representative lock asset
exists in the SOURCE `assets/npm-pinned-locks/` tree, before the copy into the staged npm package. It
cannot see `npm pack`'s own file-inclusion logic potentially dropping a nested `package-lock.json` at
PACK time (behavior that can differ across npm versions — npm 10.9.2 was verified locally to keep them;
the release workflow's npm (≥11.5.1, required for OIDC trusted publishing) was unverified), and it
passes even when one seeded row's lock is lost from the pack while another survives, since it only ever
checks a single sentinel.

`requiredNpmPinnedLockPackedPaths()` (`scripts/build-npm-package.mjs`) derives the full expected set of
packed lock paths straight from the daemon's own seed data (`bundledCapabilities()`,
`dist/capabilities/seed.js`) and its own lock-path function (`npmPinnedLockAssetPath()`,
`dist/capabilities/npm-pinned.js`). `missingPackedPaths()` is the pure diff against npm's own `npm pack
--dry-run --json` file list (`files[].path`) for the assembled `dist-npm/` staging dir — the ACTUAL
packed contents, never an assumption about what should be there. The build script's own `isMain` block
wires these together as a new step, after the staging dir is fully assembled and before the real `npm
pack`, and refuses the whole build (exit 1) if any seeded row's lock is missing from the packed list.

## Do not

- Do not hardcode the expected lock path set (file names, package names, or a fixed count) anywhere in
  this check — derive it from `bundledCapabilities()` + `npmPinnedLockAssetPath()` every time, so a
  future npm-pinned row added to `seed.ts` is covered automatically, with no second list to keep in sync.
- Do not check only the SOURCE assets tree (`fs.existsSync` before the copy) and call that equivalent to
  checking the PACKED output — the whole point of this check is that the two can diverge; `firstNpmPinnedLockAsset()` above stays as a cheap "built inputs exist" precondition, not a substitute for this one.
- Do not check only a single representative lock and assume the rest — the defect this closes is
  specifically "it passes when ONE row's lock survives while ANOTHER is lost." Every seeded npm-pinned
  row's lock must be verified individually.
- Do not derive the packed file list by re-implementing npm's own ignore-rule logic — read it straight
  from `npm pack --dry-run --json`'s own `files[].path`, the one source of truth npm itself uses for what
  actually gets published, so this check stays correct even if npm's own inclusion rules change across
  versions.
