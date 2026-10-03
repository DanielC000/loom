# resolveExecutable cache re-verifies its hit with existsSync

Card `8e08eec1`, found during the PTY host review (card `b14d3441`).

`capabilities/registry.ts`'s `resolveCapabilityServer` re-runs `resolveExecutable` on every spawn for a
`bundled`/`command` capability — explicitly so a bare PATH-searched name (e.g. an `npx` shim managed by
fnm/nvm/volta) "self-heals" if the real binary moves, is reinstalled, or becomes available after a
stripped-PATH boot. That re-run was defeated by `resolveExecutable`'s own internal cache
(`pty/resolve-bin.ts`): once a bare name resolved to an absolute path, the cache returned that path
forever for the life of the daemon process, with no re-check. A capability whose shim moved after the
first successful resolution would 404 silently until the daemon restarted — exactly the case the
registry's own re-run was written to prevent, just one layer further down.

## Fix

On a cache hit, `resolveExecutable` now calls `fs.existsSync` on the cached path before trusting it. If
the file is gone, the entry is evicted and resolution falls through to a fresh PATH search (and re-caches
on success). This is a single `existsSync` per cache hit — cheap, never a blocking re-resolve (a full
`PATH` walk) on every spawn — so the common warm-cache path stays fast while a moved/uninstalled/upgraded
binary gets a chance to re-resolve on the very next call instead of waiting for a restart.

## Do not

- Do not remove the `existsSync` re-check on a cache hit to "optimize" this back to a pure memoized
  lookup — that reintroduces the exact staleness this card fixed, silently, since a passing build/test
  run on a machine where the binary never moves will not catch the regression.
- Do not make this a blocking full re-resolve (PATH walk) on every call "to be safe" — the existsSync
  check on the cached path is the cheap, correct middle ground; a full re-walk on every hit defeats the
  point of caching at all.
