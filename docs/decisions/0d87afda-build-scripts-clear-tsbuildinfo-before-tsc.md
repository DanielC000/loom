# 0d87afda — `@loom/daemon` and `@loom/shared` build scripts delete `tsconfig.tsbuildinfo` before `tsc`

## Incident (2026-11-06)

A worker made behavioural mutants by hand-editing `packages/daemon/dist/**`, then restored and rebuilt. A Code Reviewer spawned afterwards got a FRESH worktree whose `dist/gateway/server.js` was a mutant (not a git-tracked file; mtime = the provisioning build). Its first test run was RED 3/3 until it ran `pnpm --filter @loom/daemon build`.

## Mechanism (reproduced in a throwaway fixture with its own turbo cache dir)

1. turbo's `build` task keys on git-tracked inputs only and stores `dist/**`. `dist/` and `tsconfig.tsbuildinfo` are gitignored: neither is in the key, and the tsbuildinfo is not an output.
2. With a hand-mutated `dist/` and a CURRENT tsbuildinfo, any src change gives a new key (cache MISS). Incremental `tsc` re-emits only the changed file and skips the mutated one, so turbo stores the mutant `dist/**` under that key.
3. The author restores their own dist (direct tsc), but the cache entry stays poisoned.
4. A fresh worktree on the same tree computes the same key. `provisionWorktreeDeps` runs `pnpm build`, which replays the mutant (a review rig builds only when the reviewed diff touches a test-shaped file — card 503cd822). A merge/`run_gate` worktree on an identical tree (e.g. a solo squash onto an unchanged base) is exposed the same way; the `daemon_restart` deploy build is not (`--cache=local:,remote:`).

## Fix

The `build` scripts of `@loom/daemon` and `@loom/shared` delete `tsconfig.tsbuildinfo` first, so every build is a full emit and every EMITTED file in `dist/**` is rewritten from `src/**`. Known limit: ORPHANED dist files (a deleted or renamed source's old output, or a hand-ADDED file) are not removed by this, so they can still be cached and replayed; that is tracked separately. The script text is part of the package's turbo hash, so every cache entry that already exists for these packages (possibly poisoned) becomes unreachable. `@loom/web` needs no change (`tsc --noEmit` + vite, which empties its own outDir).

Cost (one host, foreground, 3 runs each): daemon package build ~3.8-4.3 s incremental no-change before, ~17-20 s after; shared ~1.4-1.6 s before, ~1.9-2.2 s after.

Regression test: `packages/daemon/test/build-script-turbo-cache-poison.mjs` (real turbo, temp `TURBO_CACHE_DIR`).

## Do not

- Do not read the fix as "dist is a pure function of src": orphaned dist files survive it (see the known limit above).
- Do not drop the tsbuildinfo-clearing segment to win back incremental build speed; it is what keeps the cache write side honest.
- Do not hand-edit `dist/` for a negative control; edit `src/` and rebuild (the `/worker` skill states this rule).
- Do not rely on clearing tsbuildinfo AFTER mutating dist: it repairs the author's own tree, not an entry turbo already stored.
