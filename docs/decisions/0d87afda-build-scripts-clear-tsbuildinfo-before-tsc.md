# 0d87afda — `@loom/daemon` and `@loom/shared` build scripts delete `tsconfig.tsbuildinfo` before `tsc`

## Incident (2026-11-06)

A worker made behavioural mutants by hand-editing `packages/daemon/dist/**`, then restored and rebuilt. A Code Reviewer spawned afterwards got a FRESH worktree whose `dist/gateway/server.js` was a mutant (not a git-tracked file; mtime = the provisioning build). Its first test run was RED 3/3 until it ran `pnpm --filter @loom/daemon build`.

## Mechanism (reproduced in a throwaway fixture with its own turbo cache dir)

1. turbo's `build` task keys on git-tracked inputs only and stores `dist/**`. `dist/` and `tsconfig.tsbuildinfo` are gitignored: neither is in the key, and the tsbuildinfo is not an output.
2. With a hand-mutated `dist/` and a CURRENT tsbuildinfo, any src change gives a new key (cache MISS). Incremental `tsc` re-emits only the changed file and skips the mutated one, so turbo stores the mutant `dist/**` under that key.
3. The author restores their own dist (direct tsc), but the cache entry stays poisoned.
4. A fresh worktree on the same tree computes the same key. `provisionWorktreeDeps` runs `pnpm build`, which replays the mutant (a review rig builds only when the reviewed diff touches a test-shaped file — card 503cd822). A merge/`run_gate` worktree on an identical tree (e.g. a solo squash onto an unchanged base) is exposed the same way; the `daemon_restart` deploy build is not (`--cache=local:,remote:`).

## Fix

The `build` scripts of `@loom/daemon` and `@loom/shared` delete `tsconfig.tsbuildinfo` first, so every build is a full emit and every EMITTED file in `dist/**` is rewritten from `src/**`. Known limit of the tsbuildinfo clear alone: ORPHANED dist files (a deleted or renamed source's old output, or a hand-ADDED file) are not removed by it; they are closed by the prune step in the "Orphaned dist files" section below. The script text is part of the package's turbo hash, so every cache entry that already exists for these packages (possibly poisoned) becomes unreachable. `@loom/web` needs no change (`tsc --noEmit` + vite, which empties its own outDir).

Cost (one host, foreground, 3 runs each): daemon package build ~3.8-4.3 s incremental no-change before, ~17-20 s after; shared ~1.4-1.6 s before, ~1.9-2.2 s after.

Regression test: `packages/daemon/test/build-script-turbo-cache-poison.mjs` (real turbo, temp `TURBO_CACHE_DIR`).

## Orphaned dist files (follow-up, card 2b6d469c)

Clearing tsbuildinfo makes every EMITTED file fresh but never deletes a dist file whose source was renamed/deleted, or one added by hand. Reproduced by the Code Review: rename `src/other.ts`, commit, build — `dist/other.js` survived in main and turbo replayed it into a fresh `git worktree add`, where a test importing it passed and then went red on clean CI.

**Fix.** `scripts/prune-orphan-dist.mjs <pkgDir>` runs in the `@loom/daemon` and `@loom/shared` `build` scripts between the tsbuildinfo delete and `tsc`. A dist file named `X.js`, `X.d.ts`, `X.js.map` or `X.d.ts.map` is deleted iff neither `src/X.ts` nor `src/X.tsx` exists; `X.mjs`, `X.mjs.map`, `X.d.mts`, `X.d.mts.map` iff `src/X.mts` is absent; `X.cjs`, `X.cjs.map`, `X.d.cts`, `X.d.cts.map` iff `src/X.cts` is absent (each output kind needs its OWN source kind, so a `baz.mjs` beside only `src/baz.ts` is an orphan). (tsconfig is `rootDir: src` / `outDir: dist` with declaration + declarationMap + sourceMap, so every emit maps 1:1 to a source path; measured on daemon: 278 .js, 278 .d.ts, 556 .map, plus `build-info.json`). Every empty directory under `dist/` is then removed, pre-existing empty ones included. It prints `N files pruned` and the paths when N > 0, so a deploy log shows what went.

**Safety properties (all asserted by the test).**
- `dist/build-info.json` (and any file that is not one of the twelve tsc output suffixes above) is never touched. It is written by the uncached `stamp` task; a direct `pnpm --filter` build does not re-run `stamp`, so it must survive a direct build as well as a turbo build.
- A symlink or junction under `dist/` is never followed and never removed; a path whose realpath leaves `<pkg>/dist` is skipped.
- A missing `src/` or `dist/` deletes nothing. An unexpected error exits non-zero (the build fails closed rather than caching an unpruned dist).

**Deploy-path reasoning.** The `daemon_restart` deploy build runs inside the LIVE self-hosting daemon's own main-checkout `dist/`. A grep of daemon `src` for dynamic `import(` / `new Worker(` found: `import("typescript")`, one scripts-path import (`unanchored-comment-blocks.ts`, not dist), and two `eval:true` Worker sources (`sshRegex.ts`, `graceful-teardown.ts`) that load no dist file. The session hook assets do NOT import dist (`assets/git-resolve.mjs` is deliberately a dist-free copy of the resolver in `src/git/bounded.ts`), so no shipped code lazily loads a dist path. Static ESM imports are fully resolved at startup. Pruning only removes files with NO source in the tree being built, so the running process cannot lose a module it still needs, bar a module renamed away in that very build, which no lazy loader references.

**Rejected alternative: a turbo `clean` task scoped like `@loom/web`'s.** The deploy passes `--cache=local:,remote:`, which still runs the uncached `clean` task, so the live daemon's `dist/` would be EMPTY for the whole build window under the running process (any module it loads late, and the on-disk entry the staleness checks read, would be missing), and `build-info.json` would be lost on any non-turbo path, where `stamp` does not re-run. A prune that deletes only source-less files has neither effect.

**Limits.** The prune runs only when the build script runs (a turbo cache MISS or a direct build); a cache HIT replays stored outputs without it, and a worktree that already holds its own orphan keeps it — but only a MISS stores outputs, so such an orphan cannot be written into the cache. Cost: one directory walk over ~1100 files and a stat per candidate (tens of ms).

Regression test: the rename / hand-added / `build-info.json` / junction probes in `build-script-turbo-cache-poison.mjs`; RED against the committed pre-change scripts (6 FAIL: rename, hand-added, fresh-worktree replay, for daemon and shared), GREEN after.

## Do not

- Do not replace the prune with a wholesale `dist/` wipe or a turbo `clean` for daemon/shared (live-daemon deploy hazard above), and do not let the prune delete anything with a source counterpart, anything outside `<pkg>/dist`, or `build-info.json`.

- Do not read the fix as "dist is a pure function of src". Remaining limits: files with a non-tsc extension are never pruned (`.json`, `.txt`, anything hand-added under another name); an orphan already sitting in a worktree that only ever takes turbo cache hits stays there (it cannot be written into the cache, but it is in that tree); and a case-only rename on Windows (`Foo.ts` to `foo.ts`) is not detected, because the case-insensitive filesystem still finds the old name's source.
- Do not drop the tsbuildinfo-clearing segment to win back incremental build speed; it is what keeps the cache write side honest.
- Do not hand-edit `dist/` for a negative control; edit `src/` and rebuild (the `/worker` skill states this rule).
- Do not rely on clearing tsbuildinfo AFTER mutating dist: it repairs the author's own tree, not an entry turbo already stored.
