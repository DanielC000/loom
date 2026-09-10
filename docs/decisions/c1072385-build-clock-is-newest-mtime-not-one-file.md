# c1072385 — the build clock is the newest mtime across the whole dist tree, and the date-vs-ancestry tradeoff it accepts

## Narrative

`tsc` builds are INCREMENTAL: only files whose input changed get rewritten, so `dist/index.js`'s own mtime means "when `index.ts` last changed" (rare), NOT "when this daemon was last built" (frequent — a build that touches only e.g. `deploy-staleness.ts` leaves `index.js` untouched). Measured live: `dist/` mtimes spanned a THREE-HOUR range for one deploy, and comparing against `index.js` alone reported a false `stale:true` for a daemon that had the latest commit compiled the whole time.

The fix: the build clock is the NEWEST mtime across every file recursively under BOTH `packages/daemon/dist` and `packages/shared/dist` (the shared package is in the same restart-relevant pathspec, so a shared-only rebuild must not read clean off a stale daemon dist either). Measured cost on one checkout: 664 daemon-dist files + 24 shared-dist files, ~18ms wall time for both recursive scans combined — negligible next to the git budget spent elsewhere in this module.

## Known, accepted limitation

`commitsBehind`/`webCommitsBehind` are a DATE comparison, not an ANCESTRY computation: they count commits whose COMMITTER DATE is later than the relevant dist's mtime — the only signal available from an mtime (there is no built-from-sha stamped anywhere to diff against, prior to card `f26339d7`'s baked-sha addition). This can be wrong in both directions: a commit landing with a non-monotonic committer date (rebase, cherry-pick, clock skew) can be MISSED ⇒ false CLEAN; a build that runs BEFORE a commit is made (build locally, then commit) counts that commit ⇒ false STALE. In practice this holds: Loom lands every card via a squash merge, which stamps a fresh committer date at merge time, so mainline dates are effectively monotonic — the failure modes above need an unusual git operation directly on mainline to trigger. This is a deliberately accepted tradeoff, not something later cards changed.

## Do not

- Do not read a single dist file's mtime (e.g. `dist/index.js`) as the build clock — an incremental build can leave it untouched for hours after a real rebuild.
- Do not treat `commitsBehind` as an ancestry-proof count — it is a date heuristic, deliberately accepted for the monotonic-squash-merge case Loom actually produces.

## Source

Inline module-doc comment in `packages/daemon/src/deploy-staleness.ts`, as of commit `8c64cf77`. Relocated by card `f63b17e5` ("deploy-staleness.ts, tranche 1"); no wording changed, `*`-prefixed lines joined into flowing paragraphs.
