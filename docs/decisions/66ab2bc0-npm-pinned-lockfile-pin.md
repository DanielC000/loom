# 66ab2bc0 — npm-pinned installs now lock the WHOLE resolved tree via a committed lockfile + `npm ci`

## The gap this closes

Card `e7d6e43b` pinned the `npm-pinned` capability kind's TOP-LEVEL package version exactly, but
deliberately left transitive dependencies unpinned — `npm install` with no lockfile in the (fresh,
per-version) install directory re-resolves every dependency's own range against whatever the registry
currently publishes. That record's own words: "a future, stricter pin … is a real option if transitive
drift ever becomes a concrete problem, but is out of scope for this card."

Card `66ab2bc0` (INVESTIGATE-FIRST, manager-approved) measured that bar as met, not just theoretically
bumped: a fresh `npm install --package-lock-only` of each shipped row's exact pinned version, run during
this card's own investigation, found the CURRENT live resolution already carries known vulnerabilities —
6 for `shadcn@4.23.0` (2 low: `deepmerge` prototype-poisoning via `mergeObject()`; 4 moderate: `minimatch`
globstar-amplification DoS, propagating into `@ts-morph/common`/`ts-morph`/`shadcn` itself) and 2 HIGH for
`mcp-imagenate@0.2.1` (`zod` memory-exhaustion DoS on oversized constrained collections). Re-verified
again while generating the committed assets below — same counts, same packages.

## Options evaluated (the investigation phase)

- **(a) chosen — a per-row committed `package-lock.json` asset + `npm ci`.** Closes top-level AND
  transitive version/integrity for the WHOLE tree.
- (b) a Loom-owned integrity map for the top-level tarball only (github-binary-style). Rejected: npm
  already verifies the top-level tarball against the registry's own live `dist.integrity` before
  extracting, so this would mostly duplicate an existing guarantee while leaving the transitive tree —
  the card's actual stated concern — completely untouched.
- (c) leave + document. Rejected now that the "concrete problem" bar is measured as met, not hypothetical.

Measured before implementing: `npm ci` from a committed lock costs no meaningful install-time penalty
over today's `npm install` (~5-9s either way, same package count/disk size, both runs observed directly
against the real registry during investigation); the only os-gated package in either tree
(`systeminformation`, shadcn's tree only) lists win32/linux/darwin all explicitly, so no per-OS lockfile
divergence; a tampered transitive integrity hash makes `npm ci` refuse loudly (`EINTEGRITY`, non-zero
exit); a package.json dependency value that doesn't match what's resolved in the lock makes `npm ci`
refuse loudly too — non-zero exit, typically `EUSAGE` ("lock file's X does not satisfy Y") when online,
measured as `ENOTCACHED` instead when offline (npm 10.9.2) — this is what makes a stale lock asset, left
behind after a version bump, fail closed rather than silently installing the wrong version; see "Do not"
below.

## The trade-off this accepts

**A lock stops silent drift, but it also stops silent security patching.** Freezing the dependency tree
means the install from a committed lock reproduces the EXACT resolution captured when the lock was
generated — including whatever vulnerable transitive versions were live at that moment (see the counts
above). Under the OLD unpinned `npm install`, a fresh install could pick up a newer, already-patched
transitive version automatically (if the dependent's own range allows it) OR a newer, compromised one —
unbounded in both directions, which is the whole reason this card exists. Under the lock, neither happens
automatically: the tree never silently drifts toward compromise, and it never silently drifts toward a
fix either. A `npm audit` finding against a locked tree stays true until a human regenerates the lock.

## The bump ritual is extended, not duplicated

`docs/decisions/c3f9ce1f-shadcn-mcp-dotenv-exfil-mitigation.md`'s own "Do not" section already requires
re-running `test/shadcn-dotenv-exfil-real-spawn.mjs` by hand before bumping `SHADCN_VERSION` — read that
record for the full existing ritual text; it is not repeated here. This card adds ONE more step to that
same ritual, for both npm-pinned rows (`shadcn` AND `image-gen`/`mcp-imagenate`), not just shadcn:
**regenerate the row's committed lock asset and re-read its `npm audit` output before committing the
change.** Concretely: in a scratch dir, `npm init -y && npm install <pkg>@<version> --save-exact
--package-lock-only --ignore-scripts`, then `npm audit --json` against that same scratch dir, read the
result, and only then copy the generated `package-lock.json` over the committed asset at
`packages/daemon/assets/npm-pinned-locks/<pkg>/<version>/package-lock.json`. The generated lock's root
`name`/`version`/`license` fields are cosmetic noise from the scratch dir's own `npm init` — normalize
them to `{"name": "loom-npm-pinned-install", "version": "0.0.0"}` (no `license` field) before committing,
matching what `ensureNpmPinnedAsync` synthesizes at install time; `npm ci` does not require these to match
the synthesized package.json's own `name`/`version` (verified directly — only the `dependencies` map is
checked), but a mismatched placeholder name baked into committed history is needless noise. If the audit
shows a vulnerability that wasn't there before, that is information to weigh, not an automatic blocker —
the bump ritual's job is to make the trade-off VISIBLE, not to force clean audits that would also require
relaxing the exact top-level pin.

**Two distinct triggers for this ritual, both landing in the same place (round 2):**
- **A top-level VERSION bump** (`SHADCN_VERSION`/`MCP_IMAGENATE_VERSION` in seed.ts changes): the new
  committed asset goes into a NEW version directory (`<pkg>/<new-version>/package-lock.json`) — the old
  version's own committed lock is left untouched, mirroring `loomNpmPinnedDir`'s per-version namespacing.
- **A TRANSITIVE-only fix at the SAME top-level version** (no seed.ts change): the regenerated lock
  OVERWRITES the existing `<pkg>/<version>/package-lock.json` asset IN PLACE. This is now safe, and is the
  one sanctioned path for this case — see "Round 2" below for why an in-place overwrite used to have
  nowhere safe to land, and how the install-dir content-hash keying fixes that.

## Do not

- Do not fall back to a plain `npm install` when the committed lock asset for a package/version is
  missing — `ensureNpmPinnedAsync` fails closed with outcome `lock-missing`, checked BEFORE any tmp
  install dir is created. A row with no lock asset installs nothing, ever, rather than silently reverting
  to the exact unpinned-transitive-tree behavior this card closes.
- Do not commit a `package.json` alongside the lock asset. `ensureNpmPinnedAsync` SYNTHESIZES
  `package.json` at install time from `opts.package`/`opts.version` (the validated, authoritative DB-row
  values) and writes it into the temp install dir fresh on every attempt. This is load-bearing, not a
  simplification: it is what makes a STALE lock asset (left behind after a DB-row version bump that
  forgot to regenerate it) fail LOUD — `npm ci` compares the synthesized package.json's dependency value
  against what the lock actually resolves and refuses on a mismatch (typically `EUSAGE`; see "Measured
  before implementing" above for the offline exception). A committed, static package.json would remove
  that check's teeth the moment someone edited it to match a bumped version without also regenerating the
  lock — the two static files could agree with each other while both disagreeing with reality.
- Do not widen `validateNpmPinnedSpec`'s allowlists to accommodate this change — the lock asset path is
  derived from the SAME already-validated `package`/`version` pair the e7d6e43b decision record's own
  validator covers; nothing new needs validating here beyond "does the asset file exist."
- Do not leave the committed lock stale while trying to force a patched transitive version some other
  way (an `overrides`/`resolutions` entry, a hand-edited integrity hash) — that reintroduces an
  unreviewed, undocumented drift vector in the one place this card closed it. Regenerate the whole lock
  (in place, for a transitive-only fix — see the bump ritual above) and re-read the audit instead.
- Do not key the lock asset path on anything other than `package`/`version` (e.g. the capability's
  `slug`) — two different slugs that happen to seed the same `package@version` (not something Loom's own
  seed data does today) must resolve to the SAME lock asset, the same way they already resolve to the
  same install dir (see e7d6e43b's own "named residual" on the per-slug dedupe).

## Round 2 (Code Review, reviewer `dc5d706f`) — the install dir is now ALSO keyed on the lock's content

**M1 (no test tied a seeded version to its lock):** `test/npm-pinned-seed-lock-parity.mjs` now iterates
every bundled `npm-pinned` capability row and asserts, against the REAL committed asset: it exists;
`lockfileVersion` is 3; `packages[""].dependencies[pkg]` equals the seed row's version EXACTLY; every
resolved entry carries a real `sha512-` integrity; every resolved URL is under
`https://registry.npmjs.org/`. Proven to bite: bumping `SHADCN_VERSION` in the compiled `dist/` (then
restoring it byte-identically, checksum-verified) turns the "lock asset exists" assertion RED. It belongs
on, and was added to, `ASSET_READING_TEST_REPO_PATHS` (`git/worktrees.ts`) — it's a direct reader (route
1) of real committed content under `packages/daemon/assets/npm-pinned-locks/**`.

**M2 (the install dir was keyed on `package`/`version` alone, never the lock):** this had two
consequences, both closed the same way. (a) A host that already had `<LOOM_HOME>/node/<pkg>/<version>/`
from before this round kept that drifted (unpinned-transitive) tree forever — the lock could never apply
to it. (b) A transitive-only security fix had no sanctioned path: the ritual said "regenerate the whole
lock" but gave nowhere safe to put the regenerated file, since overwriting the existing asset in place
would never invalidate an already-installed host's tree (same install dir, same `fs.existsSync` hot-path
check, so a warm install never re-resolved).

**The fix:** `loomNpmPinnedDir`/`loomNpmPinnedBin` now take a required `lockHash: string | null` —
`<LOOM_HOME>/node/<package>/<version>-<lockHash>/` (`null` ⇒ a fixed `-nolock` dead-end suffix).
`npmPinnedLockContentHash(lockAssetPath)` (first 12 hex chars of `sha256(file bytes)`) is MEMOIZED per
absolute lock path (round 3 below replaces the original round-2 memoization — see that section for why
the original "safe because immutable for a version's lifetime" framing here was wrong). `ensureNpmPinnedAsync`
checks lock existence BEFORE any hashing, tmp dir, or mkdir (unchanged ordering intent, now literally
enforced by data dependency: there's nothing to hash without a lock). The hot path (`registry.ts`'s
`resolveNpmPinned`) computes the SAME hash the SAME way, so a cold spawn and a background install always
agree on which dir they mean.

**Consequence (a) closed, by construction:** a pre-round-2, version-only install dir is simply a
different path than any hash-suffixed one — it is never resolved again. **Do NOT delete it** — this is an
INERT RESIDUAL, not a bug: nothing currently reads that shape, nothing currently writes it, and deleting
it would be a human/ops cleanup task entirely orthogonal to this fix (a stray directory under
`<LOOM_HOME>/node/` costs disk space, nothing else).

**Consequence (b) closed, by construction:** the bump ritual's "transitive-only fix" case (above) now has
a real destination — overwrite the committed lock asset in place, and the new content hash mints a FRESH
install dir on every host's next cold resolve, so the fix actually reaches already-installed hosts instead
of only ever reaching a fresh install.

**Verification:** `npm-pinned-lock-asset.mjs`'s (D1-a)/(D1-b) cases and `npm-pinned-provision.mjs`'s
(8e) case assert this directly (two different lock contents at the same package/version mint two
different, independently-existing dirs with a genuinely fresh install each time; a pre-existing old-shape
dir with a real bin is never mistaken for ready, via both `ensureNpmPinnedAsync` and the real
`resolveCapabilityServer` hot path). RED/GREEN proven against an API-KEEPING mutant (per lesson 298 — a
plain `git --ref` revert of `npm-pinned.ts` would fail these tests STRUCTURALLY instead, on the missing
`npmPinnedLockContentHash` export the tests themselves now import, proving nothing about behavior):
`dist/capabilities/npm-pinned.js`'s compiled `loomNpmPinnedDir` was hand-patched to keep its
`(pkg, version, lockHash)` signature and every export, but silently DROP `lockHash` from the returned
path (`path.join(LOOM_HOME, "node", pkg, version)` — the old, pre-round-2 shape). Against that mutant,
exactly the D1-a/D1-b/8e assertions above went RED (checksum-verified before/after: the patched file's
MD5 differed from, and the restored file's MD5 was byte-identical to, the pre-mutant build); every other
assertion in both files stayed green. `npm-pinned-lock-asset.mjs`'s pre-existing (i)/(ii)/(iii) cases, and
`npm-pinned-provision.mjs`'s full suite, stay green across both — round 2 is additive, not a rewrite of
round 1's own contract.

**Minor fixes (same Code Review):** `npm-pinned-real-spawn.mjs`'s own header no longer claims a committed
`semver@7.6.3` lock asset (none exists; the opt-in network case generates one at run time via
`lockAssetPathOverride`, like the default local-tarball case already did). `npm-pinned-lock-asset.mjs`'s
case (ii) is relabeled as a generic non-zero-exit classification test (it passes against pre-round-1 code
too; it was never stale-lock-specific). The offline `ENOTCACHED` exception is now stated everywhere the
`EUSAGE` shape was claimed unconditionally (this record, and the `NpmPinnedProvisionOutcome` doc in
`npm-pinned.ts`). The dead "see worker_report" pointer in `npm-pinned-lock-asset.mjs`'s header is replaced
with this section. `packages/shared/src/types.ts`'s `CapabilityProvisionKind` doc, the web
`capabilityProvisioning.ts` reason text, and `scripts/build-npm-package.mjs`'s required-built-inputs check
(a scanned, not hardcoded, sentinel lock path under `assets/npm-pinned-locks/**`) are all updated to match
`npm ci` + the lock-asset packaging requirement.

## Round 3 (second Code Review) — the "immutable, needs a restart" memo framing was wrong; closed two ways

**MINOR 1 (two related staleness bugs in `npmPinnedLockContentHash`'s round-2 memoization):**
- **Lock absent, then added, no restart:** a `null` result (file doesn't exist yet) was cached FOREVER
  per `lockAssetPath`. `ensureNpmPinnedAsync` called this SAME memoized function, so once it had observed
  a missing lock once, a human adding the lock asset and then hitting the retry endpoint
  (`POST /api/capabilities/:slug/provisioning/retry`) with no daemon restart still got the stale cached
  `null`, resolved `lockHash: null`, and installed into the fixed `-nolock` dead-end dir — `ready`, but
  wrong (not the pinned, lock-verified tree). Reproduced by the reviewer.
- **Sibling TOCTOU on an in-place overwrite:** `ensureNpmPinnedAsync` hashed via the memoized function
  (so it could return a STALE hash `H1` for a lock that had since been overwritten in place — the
  ritual's own sanctioned "transitive-only fix" case, see above) but then `copyFileSync`'d the file
  FRESH, i.e. the NEW bytes. The install dir got named `H1` while its content was actually the new tree
  — the dir name no longer provably matched what was installed under it.

**The fix, two parts:**
1. `ensureNpmPinnedAsync` no longer calls the memoized `npmPinnedLockContentHash` at all. It now reads the
   lock's bytes ONCE (`fs.readFileSync`), hashes THOSE SAME bytes, and writes THOSE SAME bytes into the
   temp install dir (`fs.writeFileSync`, replacing the old `fs.copyFileSync` from `lockAssetPath`) — the
   install dir name and the installed content are now provably the same bytes, independent of any cache.
   A read failure (including "doesn't exist") classifies `lock-missing` directly from the read, not from
   a pre-check against a possibly-stale cache.
2. `npmPinnedLockContentHash` (now used ONLY by the hot path, `registry.ts`'s `resolveNpmPinned`) is
   rekeyed on the file's own `(mtimeMs, size)`, read via one cheap `fs.statSync` per call — a changed
   stat invalidates the cached hash and forces a re-read+re-hash; a `null` (missing/unreadable) is never
   cached. This keeps the hot path's "one cheap read" cost on the common case (unchanged lock) while
   closing both staleness windows above.

**Staleness-until-restart: no longer exists, for either case.** The original round-2 framing above ("safe
because immutable… a transitive-only fix overwrites it in place, but that's a NEW process/daemon boot
away") was true of the ORIGINAL memoization (permanent, keyed on path alone) but is no longer true of the
current one. After this fix, both a lock that was missing and is now added, and a lock that was
overwritten in place, are picked up on the very next call to `npmPinnedLockContentHash` (hot path) or the
very next `ensureNpmPinnedAsync` attempt (background path) — no daemon restart is needed in either case.
`npm-pinned.ts`'s own doc comments on both functions state this directly; this record and those comments
no longer disagree.

**Verification:** new tests prove the lock-absent-then-added case (`ensureNpmPinnedAsync` resolves the
real lock, not `-nolock`, once the lock appears, with no cache reset between calls) and the in-place
overwrite case (the install dir name matches a hash of the content actually written, for two different
lock contents at the same path, read on two successive calls with no process restart between them).
RED/GREEN proven against an API-keeping mutant (per lesson 298): the pre-round-3 `npmPinnedLockContentHash`
shape (permanent memo, caching `null`) was restored as a hand-patched `dist/capabilities/npm-pinned.js`
mutant; against it, exactly the new lock-absent-then-added and in-place-overwrite assertions went RED,
every other assertion in both affected test files stayed green, checksum-verified before/after.

## Accepted audit findings (2026-11-04)

Card `b7d6b7f3` re-ran `npm audit` against both committed locks and triaged every finding (table + full
exploitability analysis in that card). Two `shadcn@4.23.0` findings are accepted and documented here
rather than fixed; the third (`mcp-imagenate`'s 2 HIGH `zod` findings) was bumped — see `MCP_IMAGENATE_VERSION`
in `capabilities/seed.ts`.

- **`deepmerge` (2 LOW, GHSA-gcqx-w48m-w2h4, prototype poisoning).** No patched release exists at any
  version — the advisory's own range (`>=4.2.0 <=4.3.1`) already covers deepmerge's own latest. Reachable
  only through `@shadcn/registry`'s registry-tree resolver, which merges `tailwind`/`cssVars`/`css`/`envVars`
  across a resolved item tree — never through the model's own tool-call args, which only ever name
  registry NAMES already configured in a project's `components.json`. **Re-opens if:** deepmerge ships a
  patch, Loom starts spawning `shadcn add`/`init` (today `mcp` only), or a project configures an untrusted
  custom registry (an operational risk this row's design already discloses, not a code gap here).
- **`minimatch` (4 MODERATE, GHSA-g3hv-75wg-m249, globstar DoS, via `ts-morph`/`@ts-morph/common`).**
  Capped below the fix by `@ts-morph/common`'s own `minimatch: "^10.0.1"` dependency, itself pinned via
  `ts-morph@^26.0.0`, which only an upstream shadcn release controls. Measured UNREACHABLE today: the
  bundled `shadcn mcp` server's own registered-tools module never imports `ts-morph` — it only backs the
  CLI `add`/transform code paths Loom never spawns. **Re-opens if:** Loom ever spawns `shadcn add`/`init`,
  or a future shadcn release starts importing `ts-morph` from the MCP-reachable registry-resolution path.
