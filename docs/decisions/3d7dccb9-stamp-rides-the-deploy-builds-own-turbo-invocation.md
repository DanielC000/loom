# 3d7dccb9 — deploy build's "stamp" task rides the SAME turbo invocation as "build"

## Narrative (this file's site: `orchestration/restart.ts`)

Card 3d7dccb9 (done, merged `63b0473`) found that `dist/build-info.json` could be stamped with a stale/foreign sha: a worker worktree's own `pnpm build` writes `dist/build-info.json` stamped with THAT worktree's HEAD, and a later canonical build with a matching turbo cache key can replay that cached artifact — `build-info.json` included — into the canonical `dist/`, because turbo's content-keyed cache is SHARED across every git worktree of this repo (see `deploy-staleness.ts`'s module doc for the full mechanism and the `served_status` content-based fallback this card also added).

In `deployBuildSteps`, the fix is that `"stamp"` runs in the SAME turbo invocation as `"build"`, immediately after it (`turbo.json`: `dependsOn: ["build"]`, `cache: false`) — `[turboBin(), "build", "stamp", ...filters, "--force"]`. Because `"stamp"` is uncached, it (re)writes `dist/build-info.json` fresh from THIS checkout's real HEAD on every deploy build, cache hit or miss on `"build"` itself — so the deploy build's own artifact identity can never be a stale/foreign sha replayed off turbo's cache.

## Narrative (second site: `deploy-staleness.ts`'s module doc — the mechanism this stamp step protects)

`build-info.json` is written by `scripts/write-build-info.mjs` as its own, separate, UNCACHED turbo task (`stamp`, `cache:false`, `dependsOn:["build"]` — see `turbo.json`), never as a step inside the cached `build` task's own script — it always re-executes, cache hit or miss, stamping the current checkout's real `git rev-parse HEAD` on every build invocation.

The original design ran this step LAST inside the cached `build` script instead, on the theory that a turbo cache-HIT replay restoring the file's original baked sha (while every mtime-derived clock reads fresh) would make a cache-replay detectable, not silently invisible. That reasoning missed a load-bearing fact: turbo 2.x's local cache is SHARED ACROSS EVERY GIT WORKTREE of the same repo by default (confirmed live via `TURBO_LOG=debug turbo build`: `"Using shared worktree cache at: <main checkout>/.turbo/cache"`, `is_shared_worktree=true` — NOT scoped to `node_modules`, which Loom otherwise deliberately never shares across worktrees). A worker's own `pnpm build` (e.g. during its merge-gate self-check, in its own isolated worktree) can populate a cache entry whose CONTENT matches a later build on a completely different checkout — turbo correctly serves that cache hit — but the old design then replayed that worker worktree's own baked `build-info.json` along with it: content-right, IDENTITY-wrong, naming a commit (e.g. an ephemeral union-forward merge commit created only inside that worker's own worktree) not even reachable from mainline HEAD.

This card caught it live: a genuinely-current daemon read `processBuiltShaMatchesHead:false` / `deploySignatureMismatch:true` — the CRY-WOLF direction, a false "not deployed" for code that was actually current — because the running daemon's own boot build (`daemon-supervisor.mjs`, a non-`--force` turbo build) had cache-hit-served a worker worktree's stamp. The uncached `stamp` task closes this: since a cache hit already proves content-equivalence to compiling THIS checkout right now, re-stamping THIS checkout's own HEAD on every invocation is always correct.

⚠️ The `deploy-staleness.ts` site's own `24f53a72` follow-up section is NOT duplicated here — it already has its own complete record (`docs/decisions/24f53a72-build-cache-write-can-clobber-stamps-build-info-json.md`); this site's mention of it is just an anchor, not new content.

## Do not

- Do not remove or bypass the `"stamp"` task from the deploy build's turbo invocation, and do not let it run cached — an uncached, same-invocation stamp is what guarantees the deploy's artifact identity reflects the checkout that actually built it, not a replayed cache entry from a different worktree.

## Source

Inline comment in `packages/daemon/src/orchestration/restart.ts` (`deployBuildSteps`, STEP 2), as of commit `779f3ce7`. Relocated by card `0a525ae1` ("restart.ts, tranche 1"); no wording changed, `//`-prefixed lines joined into a flowing paragraph.

Second site's inline comment in `packages/daemon/src/deploy-staleness.ts`'s module doc, as of commit `8c64cf77`. Relocated by card `f63b17e5` ("deploy-staleness.ts, tranche 1"); no wording changed, `*`-prefixed lines joined into flowing paragraphs.
