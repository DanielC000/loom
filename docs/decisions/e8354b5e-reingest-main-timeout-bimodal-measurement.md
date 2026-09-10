# e8354b5e — `reingest-main` timeout raised to 120s after a bimodal measurement overturned the ~9-11s estimate

## Narrative

Bound (ms) for `POST /project/<id>/reingest-main` (`DEFAULT_REINGEST_TIMEOUT_MS`, `codescape/supervisor.ts`). AS-OF 2026-08-04, measured against Codescape sha `439e65f`: endpoint blocking time (client fetch issue -> response, covering `getWarmProject` + queue wait + `ingestRepo`) is BIMODAL — ~13-19s warm, ~24-29s cold (a cold reingest rebuilds the same ts-morph `Project` as the initial `codescape ingest`'s own `DEFAULT_INGEST_TIMEOUT_MS`) — which mode fires is not a property of the request; it depends on what another tenant last touched. The prior "blocks ~9-11s" figure this bound was derived from was never re-measured and was off by 2.5-3x.

CORPUS: presumed the Loom repo (the project this `reingest-main` call re-indexes — see `sessions/service.ts`'s `fireCodescapeReingest`), but the exact corpus sha/commit and a size proxy (file count or similar) were NOT recorded alongside the timing figures above and could not be recovered after the fact. Ingest time scales with corpus size, not just tool version, so these figures are NOT safely comparable once this repo has grown materially past whatever size it was at measurement time — an unpinned population, stated honestly rather than silently omitted.

Aligned to `DEFAULT_INGEST_TIMEOUT_MS` (120s) rather than re-deriving a tighter number: `reingestMain` is fire-and-forget from a caller that never awaits it (`fireCodescapeReingest`), and codescape's own route has no cancellation wiring — our abort closes only OUR socket, their ingest runs to completion regardless. So a tight bound buys nothing by being tight: it only decides whether we're still listening when the (server-side unobserved either way) answer arrives. Sizing around SURVIVAL of a single mode invites exactly this staleness; sizing around OBSERVABILITY of the slower mode does not. The tail beyond the measured range is UNMEASURED on this host — this is a floor on the sample maximum, not a proven ceiling.

A liveness/progress-based bound (indifferent to which mode fires) would be the more principled SHAPE, but codescape's `reingest-main` route reports no partial progress to key off, and building one was out of this fix's scope (client half only) — flagged as a follow-up, not attempted.

## Do not

- Do not retune `DEFAULT_REINGEST_TIMEOUT_MS` tighter than `DEFAULT_INGEST_TIMEOUT_MS` without re-measuring — the prior tighter bound (the "~9-11s" estimate) was stale and caused exactly the failure this fix corrects.
- Do not treat the measured percentiles above as safe once this repo's corpus has grown materially past measurement time — the corpus size at measurement time was never pinned.

## Source

JSDoc comment above `DEFAULT_REINGEST_TIMEOUT_MS` in `packages/daemon/src/codescape/supervisor.ts`: originally lines 33-60, as of this tranche's HEAD. Introduced by commit `e8354b5e` (no board card cited anywhere in the block, the file, or the introducing commit message — sha-keyed per the extraction program's rule; verify with `git cat-file -t e8354b5e`). Relocated by card `0b5f7673` (tranche 2); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
