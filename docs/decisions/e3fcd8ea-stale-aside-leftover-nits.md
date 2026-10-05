# e3fcd8ea — fail closed without repo keys, exempt a legacy stored key, and correct two false record claims

Four non-blocking minors from delta Code Review `37bf2f37` of `ad34efb5` round 2 (tip `9f192cef`,
APPROVE-with-minors). All four concern `ad34efb5`'s own stale-aside-leftover machinery
(`git/worktrees.ts`, `projects/repos.ts`); nothing here changes what counts as a stale leftover or what
gets deleted.

## Item 1 — `reclaimStaleAsideWorktreeDir`'s registry-axis refusal is now load-bearing, not optional

`repoKeysByProject` was an OPTIONAL dep: a future caller that simply omitted it would silently lose
`isRegisteredRepoKeyAxisDir`'s independent refusal (the sole production caller,
`SessionService.reclaimStaleWorktreeLeftover`, already passed it — the risk was a caller not yet written).

Fixed two ways, deliberately BOTH, since each closes a different gap:

1. **Compile-time:** `repoKeysByProject` is now a REQUIRED field on `deps` (the `?` dropped). Any future
   TypeScript caller must supply it or the build fails.
2. **Runtime:** a `deps?.repoKeysByProject` check immediately after the basename-shape check refuses
   (`outcome:"refused"`, reason naming the missing dep) rather than silently proceeding. This is the part
   that actually matters for testability and for any caller that bypasses TypeScript (a plain `.mjs` test,
   hand-compiled JS) — the required TYPE alone gives no runtime guarantee, since nothing stops a
   non-typechecked caller from invoking the function with fewer arguments than its signature declares.

Six existing call sites in `test/stale-worktree-leftovers.mjs` (tests 6/7/8/9/10 and the (18) junction
test) called this function WITHOUT `repoKeysByProject`, exercising unrelated refusal/removal paths
(basename mismatch, out-of-root, missing, truncated-size propagation, the happy-path removal itself).
Updated all six to pass `repoKeysByProject: new Map()` explicitly — an empty map preserves their exact
prior behavior (no registered repoKey ever found, so `isRegisteredRepoKeyAxisDir` always returns `false`),
but now makes that a visible, deliberate no-op instead of an implicit default. New regression test (19):
omitting the dep ENTIRELY (not even `{}`) refuses, never silently proceeding.

## Item 2 — a legacy stale-shaped STORED key no longer permanently blocks every future rebind

`validateRepoRegistry`'s `STALE_ASIDE_SUFFIX_RE` rejection (the write-side half of `ad34efb5` round 2 fix
3) was correctly scoped to CREATE-time NEW keys, but three RE-validation call sites re-ran the SAME check
against the project's own already-STORED registry on every rebind/echo:

- `gateway/server.ts`'s `PATCH /api/projects/:id` with an explicit `repos` (echoing or editing the
  registry).
- The SAME route's repoPath/vaultPath-only rebind branch (`repos` omitted), which re-validates `p.repos`
  itself against the new primary (the anti-alias re-check `ad34efb5`/code-review Major 1 added).
- `mcp/platform.ts`'s elevated `project_update`, same repoPath/vaultPath-only rebind shape.

Since CREATE has rejected this key shape since `ad34efb5`, the ONLY way a project can carry one is data
written before that guard existed (a migration, a direct DB write, or — now — a test fixture simulating
that). Such a project got a permanent 400 on every future PATCH that didn't explicitly strip the offending
key, even an unrelated `repoPath` rebind.

**Fix:** `validateRepoRegistry` gained `opts.existingKeys?: ReadonlySet<string>`. The shape check alone
(`STALE_ASIDE_SUFFIX_RE.test(key) && !opts.existingKeys?.has(key)`) is skipped for a key already in that
set — every OTHER check (uniqueness, absolute path, `isGitRepo`, alias/dedup, `gateCommand`) still runs
unconditionally for it. Wired at the three re-validation sites above with `existingKeys` built from the
PRE-patch stored keys (`p.repos`/`project.repos`, as applicable). CREATE (`POST /api/projects`,
`POST /api/setup/project-init`) passes no `existingKeys` — unchanged, a brand-new stale-shaped key is still
rejected there, and a NEW stale-shaped key added alongside a kept legacy one on a rebind is still rejected
(the exemption is per-KEY, keyed to the pre-patch set, never a blanket pass for the whole call).

Tests: `test/repos-registry-rebind-conflict.mjs` PARTS E/F — a project seeded via `Db.insertProject`
directly (bypassing the validator, simulating pre-fix data) with a `svc.stale-1`-shaped stored key: a
repoPath-only rebind now succeeds (E1), an explicit echo of the unchanged registry now succeeds (E2), a
rebind that tries to ADD a new, differently-named stale-shaped key alongside the legacy one still 400s
(E3, control — the exemption doesn't widen), and the same repoPath-only-rebind success is proven on the
elevated `project_update` surface (F1).

## Item 3 — `isLikelyJunctionOrSymlink` is MEASURED redundant today, kept as declared defence-in-depth

MEASURED on this host (Node 22.16.0 / Win11), a real directory junction created via PowerShell
`New-Item -ItemType Junction`: `fs.readdirSync(dir, {withFileTypes:true})`'s Dirent for the junction
reports `isDirectory()===false` / `isSymbolicLink()===true`; `fs.lstatSync` on it reports the same
(`isSymbolicLink()===true`, `isDirectory()===false`). Both call sites of `isLikelyJunctionOrSymlink` in
`listStaleAsideWorktrees` (the level-2 and level-3 loops) are reached only AFTER
`!entry.isDirectory()`/`!leaf.isDirectory()` has already filtered the candidate out — so on this
Node/libuv version, the helper can never actually observe a real junction; it is structurally redundant
for its stated purpose today. Verified by temporarily forcing it to `return false`, rebuilding, and
confirming `test (18)` (the junction/symlink test in `test/stale-worktree-leftovers.mjs`) still fully
passes — the enumeration-skip half passes via the `isDirectory()` filter alone, and the reclaim-refusal
half passes via `worktreeRemovalRefusal`'s out-of-root confinement check, not this helper — then reverted
before committing.

This DIRECTLY CONTRADICTS `docs/decisions/ad34efb5-*`'s own Round 2 item 4 claim ("a Windows directory
junction reports as a directory at the readdir level") — that claim is corrected in that file now (see
its own Round 2 item 4, amended below this record's own Source section).

**Decision: KEEP the helper**, as declared, inert defence-in-depth — NOT dropped. Reasoning (manager
direction): junction/Dirent reporting is libuv-/Node-version-dependent and may change; this guards a
host-path DELETE; a single name-matched `lstatSync` costs nothing; and removing it saves nothing today
while costing a guard outright if a future Node ever reports a junction as a directory again. Its own doc
comment (`git/worktrees.ts`) now states the measured fact plainly rather than the false claim it used to
carry forward from `ad34efb5`.

**New test, `test/junction-dirent-shape.mjs` (win32-only, skips elsewhere):** PINS the measured Dirent
shape (`isDirectory()===false`, `isSymbolicLink()===true` for a real junction via both `readdirSync`
Dirent and `lstatSync`) as an explicit assertion, independent of `stale-worktree-leftovers.mjs`'s own
end-to-end test (18) — so a future Node upgrade that changes this behavior fails LOUDLY and names exactly
which assumption broke, rather than this helper silently going from "redundant" to "load-bearing" (or
vice versa) with nothing calling it out.

## Item 4 — two false/imprecise claims in `ad34efb5`'s own record, corrected there

- Round 2's "neither alone is sufficient" (describing the registry-first enumeration fix + the independent
  `isRegisteredRepoKeyAxisDir` reclaim-time refusal) is imprecise: the two fixes protect DIFFERENT
  surfaces (enumeration vs. the POST /reclaim path), but on the POST /reclaim path specifically, EITHER
  guard alone is sufficient — the reclaim-time refusal doesn't depend on enumeration having excluded the
  path first, and vice versa for a path that never reaches reclaim. Corrected to: "defence-in-depth: either
  guard alone protects the POST path."
- Round 2 item 4's junction/Dirent claim, corrected per Item 3 above.

Both corrected directly in `docs/decisions/ad34efb5-stale-aside-enumeration-stays-cheap-and-registry-driven.md`.

## Do not

- Do not make `reclaimStaleAsideWorktreeDir`'s `repoKeysByProject` optional again — a future typed caller
  that omits it would silently lose the independent registry-axis refusal, exactly the gap this card closed.
- Do not call `reclaimStaleAsideWorktreeDir` without passing `repoKeysByProject` (an empty `Map()` is the
  explicit no-registry-context no-op) — omitting it now refuses at runtime rather than silently proceeding.
- Do not widen `validateRepoRegistry`'s `existingKeys` exemption beyond the `STALE_ASIDE_SUFFIX_RE` shape
  check — a key in `existingKeys` still must pass every other check (uniqueness, absolute path, `isGitRepo`,
  alias/dedup, `gateCommand`) unconditionally.
- Do not pass `existingKeys` from a CREATE path (`POST /api/projects`, `POST /api/setup/project-init`) — a
  brand-new stale-shaped key must still be rejected there; the exemption exists only for RE-validation of
  a project's own pre-patch stored registry.
- Do not drop `isLikelyJunctionOrSymlink` as "proven dead code" — it is measured redundant on THIS
  Node/libuv version only; junction/Dirent reporting is libuv-/Node-version-dependent and may change, and
  this guards a host-path delete. If `junction-dirent-shape.mjs` ever goes red on a Node upgrade,
  re-examine whether the helper has become load-bearing again rather than assuming it's still inert.
- Do not re-derive the "neither alone is sufficient" framing from `ad34efb5`'s pre-correction text — on
  the POST /reclaim path specifically, either guard (registry-first enumeration, or the independent
  `isRegisteredRepoKeyAxisDir` reclaim-time refusal) is sufficient alone; see `ad34efb5`'s own corrected text.

## Source

Card `e3fcd8ea`, delta Code Review `37bf2f37` of `ad34efb5` round 2 (tip `9f192cef`, APPROVE-with-minors).
Tests: `test/stale-worktree-leftovers.mjs` (updated + new test 19), `test/repos-registry-rebind-conflict.mjs`
(new PARTS E/F), `test/junction-dirent-shape.mjs` (new, win32-only).
