# 24f53a72 — a forced "build" still WRITES a cache entry that can clobber "stamp"'s build-info.json

## Narrative

Card 24f53a72 (done, filed by the Loom lead `gen 205`, follow-up to `3d7dccb9`, merged `cac321a`) found the `3d7dccb9` defect REPRODUCING, and worse: `processBuiltSha` was frozen at a foreign, non-ancestor merge sha across MULTIPLE rebuilds, including a `--force` deploy build — while the deployed content itself was verified fine (content-diffed against a running `dist/sessions/service.js`, not the sha pair).

Root cause: `--force` on turbo's `"build"` task bypasses READING the cache for that one invocation, but does NOT, by itself, protect `"build"`'s own CACHE WRITE — a forced `"build"` still WRITES a fresh cache entry after it finishes (turbo always caches a successful run unless told not to). That entry's `"dist/**"` snapshot used to be taken BEFORE `"stamp"` (which `dependsOn: ["build"]`) ever touched `build-info.json` — so the write silently baked in whatever `build-info.json` happened to be sitting in `dist/` pre-stamp. A LATER, non-forced invocation elsewhere (`daemon-supervisor.mjs`'s boot build, a plain `pnpm build`) that omitted `"stamp"` and cache-hit THIS entry would restore that frozen pre-stamp value, clobbering whatever the real `"stamp"` step most recently wrote. **Reproduced live:** a correctly re-stamped real HEAD reverted to an unrelated sha via nothing more than a same-hash, no-source-change cache hit.

`--force` here only bypasses reading turbo's cache for THIS invocation; it does nothing to stop THIS invocation's own `"build"` cache write from poisoning a later one.

The fix is in `turbo.json`: `"build"`'s `outputs` now explicitly exclude `"!dist/build-info.json"`, so a `"build"` cache hit/restore can never touch that file from ANY invocation, forced or not, `"stamp"`-included or not — `"stamp"` (`cache: false`) is the sole writer.

## The rejected fear this fix disproves

`3d7dccb9`'s own original design had already considered excluding `build-info.json` from `"build"`'s cached `outputs` — and rejected it, on the theory that doing so (rather than just adding the separate `"stamp"` task) would "leave a stale or absent stamp behind on the common cache-hit path." That reasoning was WRONG: this card's fix is exactly that exclusion, and the feared "stale or absent stamp" never materializes, because every real invocation site in this repo (`pnpm build` at the root, the deploy build, `daemon-supervisor.mjs`'s boot build) already requests `"stamp"` alongside `"build"`, so `"stamp"` still runs unconditionally on every one of them. The only case actually affected is an ad-hoc `turbo build` that omits `"stamp"` entirely — there the file is now simply left UNTOUCHED (the last real stamp survives) rather than overwritten with a foreign or frozen one, strictly safer than before, not worse.

## Why it matters — the cry-wolf direction

`3d7dccb9` had already named the risk: "a check that false-alarms gets discounted, and then the one time it is RIGHT nobody believes it." This card is that prediction playing out a second time — the lead nearly recorded a genuinely-clean deploy as failed, and only a content-based check (grepping the running `dist/` for a token from a merged commit, with a positive control — never the sha pair alone) caught that the deploy itself was fine even while the stamp was wrong. `deploySignatureMismatch`/`builtContentMatchesHead` were RIGHT about their input; the fix was to stop feeding them a frozen stamp, not to weaken them.

## Do not

- Do not weaken or silence `deploySignatureMismatch`/`builtContentMatchesHead` to quiet a stamp-freeze symptom — they are correctly reporting on the (bad) input they're given; muting a correct alarm because it's fed bad data is how a real staleness signal becomes untrustworthy.
- Do not assume a forced `"build"` task protects its own cache WRITE the way it protects the READ — the two are independent, and only excluding `dist/build-info.json` from `"build"`'s tracked `outputs` (in `turbo.json`) closes the write side.

## Source

Inline comment in `packages/daemon/src/orchestration/restart.ts` (`deployBuildSteps`, STEP 2), as of commit `779f3ce7`. Relocated by card `0a525ae1` ("restart.ts, tranche 1"); no wording changed, `//`-prefixed lines joined into a flowing paragraph. See also card `3d7dccb9` (this defect's first sighting) and its own record, `docs/decisions/3d7dccb9-stamp-rides-the-deploy-builds-own-turbo-invocation.md`.

"The rejected fear this fix disproves" section sourced from a second site's inline comment in `packages/daemon/src/deploy-staleness.ts`'s module doc, as of commit `8c64cf77`. Relocated by card `f63b17e5` ("deploy-staleness.ts, tranche 1"); no wording changed, `*`-prefixed lines joined into a flowing paragraph.
