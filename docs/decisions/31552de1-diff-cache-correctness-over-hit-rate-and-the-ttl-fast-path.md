# 31552de1 — worker-diff cache: correctness over hit-rate, and why the walk needed a TTL

## Narrative

`workerDiff()` always shells out to git (350-415ms/poll on a real profile). A cache wraps `workerDiff` keyed on a CHEAP, git-subprocess-free freshness proof, so a repeat poll on an unchanged worker skips git entirely. ACTUAL client cadence (verified by grep, not restated from memory): `reviewQueue.tsx` polls every 8000ms for review-queue cards only; other panels set NO `refetchInterval` and react-query's own default `staleTime: 0` means those refetch on every component MOUNT instead, so the actual hot path is likely BURST mount traffic, not a steady interval. This cache helps both shapes: a steady poll less dramatically, a mount-driven burst far more.

## Key design: correctness over hit-rate

A false HIT serves a stale diff, worse than the perf cost it saves.
- The canonical repo's HEAD sha, read via fs (not `git rev-parse`) — covers stage 2/3 (committed-only and merged-and-reconstructed diffs), whose result only changes if HEAD moves or the branch/worktree lifecycle transitions.
- When a live worktree exists (stage 1 — the case that ALSO reflects UNCOMMITTED work), HEAD sha alone is NOT enough: an unstaged edit never touches any git ref or the index, only the file's own mtime. So stage 1 additionally fingerprints the worktree's actual file contents (path + mtime + size + mode) via a bounded, git-free recursive walk. `.git` and `node_modules` (Loom-provisioned per worktree, never git-tracked) are skipped as a pure perf optimization; every other path is walked.
- The walk is capped (`DIFF_FINGERPRINT_MAX_ENTRIES`) — past the cap the worktree can't be CHEAPLY proven unchanged, so the key resolves to `null` and the caller always recomputes: a false MISS, which only costs perf, never correctness.

## The TTL fast path — the walk was the real cost

The walk IS the cache key, so it used to run BEFORE the cache was ever consulted — every poll paid the full recursive stat walk (~94ms / ~1742 stats), even a cache HIT, running IN-DAEMON (event loop + libuv threadpool), unlike the git subprocess it replaces — at N live workers, continuous fs-syscall churn on the daemon. `DIFF_FINGERPRINT_TTL_MS` bounds how often the walk actually runs: within the TTL, a repeat poll trusts the existing fingerprint WITHOUT re-walking — it only re-reads the CANONICAL repo's HEAD (one or two small file reads, never a walk), which catches the canonical repo's own checked-out branch moving (e.g. another worker's PR landing on main) immediately, TTL or not.

It does NOT, and does not need to, catch the worker's OWN commits as a separate case: `fingerprintWorktree` walks the WORKING TREE, not `.git`, so a commit that writes no working-tree bytes is invisible to the walk too, at ANY TTL — correctly, because stage-1 diffs `merge-base(canonical HEAD, branch) -> WORKING TREE`, so a commit of already-fingerprinted content changes nothing about the diff it would serve. What the TTL bounds is working-tree WRITES — the only thing that can change the stage-1 diff — whether or not committed. A write inside the TTL window is served stale until the walk runs again; bounded staleness, acceptable for a DISPLAY read (the merge gate does its own diff via `reviewWorkerMerge`, never through this cache). The TTL clock is anchored to the last REAL walk, not the last served poll, so a fast-path hit never pushes the deadline out.

Bounded via simple LRU eviction (`DIFF_CACHE_MAX_ENTRIES`) keyed by branch — branches come and go over the daemon's whole lifetime, so an unbounded map would leak.

## Measured, not assumed (2026-07-17, real pnpm-monorepo worktree, not a synthetic fixture)

The HIT path is NOT free, it still walks the tree: 1566 files walked (excl `.git`/`node_modules`). HIT (`fingerprintWorktree` alone) ~94ms avg across 8 warm runs (83-145ms range). MISS (the git subprocess trio this replaces) ~235-253ms avg locally, vs 350-415ms/poll on the live profile (a larger host). Net: a real, repeatable ~2x reduction, not an order-of-magnitude one. Threadpool contention (libuv's default pool is only 4 threads) was checked: production runs `UV_THREADPOOL_SIZE=16` for exactly this class of fs-heavy work; under that config, N=4/8/16 concurrent calls ran FASTER per-call than sequential — caveat: that test repeated ONE worktree (favorable OS cache sharing), so fleet-scale contention isn't fully ruled out.

DECLINED ALTERNATIVE (don't build unless a future profile shows the walk is hot): a cheaper key fingerprinting only git-TRACKED paths (a cached `git ls-files`, invalidated on the index file's mtime) — measured ~1566 files down to ~800 tracked, another ~2x on the HIT path. Declined: index mtime does NOT move on an UNSTAGED edit to an already-tracked file, so this would need its own separate invalidation proof — layering exactly the kind of hazard this cache exists to eliminate.

## Do not

- Do not treat a cache HIT as free — it still walks the tree; the TTL fast path bounds how OFTEN the walk runs, it doesn't eliminate it.
- Do not build the git-tracked-only-fingerprint alternative without a fresh profile showing the walk is hot — declined once already: index mtime doesn't move on unstaged edits, reintroducing an invalidation-correctness risk against an already-real 2x.
- Do not let a false HIT ever serve a stale diff for correctness's sake — every design choice here trades toward a false MISS (recompute) over a false HIT (stale).

## Consequences

A repeat poll on an unchanged worker skips the git subprocess trio, a real ~2x reduction, with bounded staleness accepted for a display-only read.

## Source

`//`-style header comment in `packages/daemon/src/git/worktrees.ts`, immediately preceding `DIFF_CACHE_MAX_ENTRIES`, as of this worktree's pre-extraction HEAD. Wrapped lines joined into a flowing paragraph, `//` comment markers stripped, no wording changed.
