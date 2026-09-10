# 3d7dccb9 — deploy build's "stamp" task rides the SAME turbo invocation as "build"

## Narrative (this file's site: `orchestration/restart.ts`)

Card 3d7dccb9 (done, merged `63b0473`) found that `dist/build-info.json` could be stamped with a stale/foreign sha: a worker worktree's own `pnpm build` writes `dist/build-info.json` stamped with THAT worktree's HEAD, and a later canonical build with a matching turbo cache key can replay that cached artifact — `build-info.json` included — into the canonical `dist/`, because turbo's content-keyed cache is SHARED across every git worktree of this repo (see `deploy-staleness.ts`'s module doc for the full mechanism and the `served_status` content-based fallback this card also added).

In `deployBuildSteps`, the fix is that `"stamp"` runs in the SAME turbo invocation as `"build"`, immediately after it (`turbo.json`: `dependsOn: ["build"]`, `cache: false`) — `[turboBin(), "build", "stamp", ...filters, "--force"]`. Because `"stamp"` is uncached, it (re)writes `dist/build-info.json` fresh from THIS checkout's real HEAD on every deploy build, cache hit or miss on `"build"` itself — so the deploy build's own artifact identity can never be a stale/foreign sha replayed off turbo's cache.

⚠️ This file's own site does not cover the FULL `3d7dccb9` decision (the `served_status` content-based fallback, the turbo-cache-across-worktrees mechanism, and the DoD options considered) — that lives at the primary site in `packages/daemon/src/deploy-staleness.ts`, out of scope for this tranche (file-fenced to `restart.ts`). A future `deploy-staleness.ts` extraction tranche should EXTEND this record (never create a second file for `3d7dccb9`) with that fuller narrative — see card `24f53a72`'s own record for the closely-related follow-up defect this stamp step's own CACHE WRITE could still cause.

## Do not

- Do not remove or bypass the `"stamp"` task from the deploy build's turbo invocation, and do not let it run cached — an uncached, same-invocation stamp is what guarantees the deploy's artifact identity reflects the checkout that actually built it, not a replayed cache entry from a different worktree.

## Source

Inline comment in `packages/daemon/src/orchestration/restart.ts` (`deployBuildSteps`, STEP 2), as of commit `779f3ce7`. Relocated by card `0a525ae1` ("restart.ts, tranche 1"); no wording changed, `//`-prefixed lines joined into a flowing paragraph.
