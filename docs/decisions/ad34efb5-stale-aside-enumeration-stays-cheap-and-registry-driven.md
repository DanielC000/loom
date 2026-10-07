# ad34efb5 — `listStaleAsideWorktrees` stays a cheap, byte-free, registry-driven readdir

`listStaleAsideWorktrees` (git/worktrees.ts) enumerates renamed-aside stale worktree leftovers
(`<path>.stale-<ts>` dirs — see `renameWorktreeDirAside`) under `WORKTREES_DIR`. It is called on EVERY
`served_status` / `GET /api/deploy-status` read (a polled surface), so two design choices keep it cheap:

1. **No byte measurement here.** An earlier draft of this card had `listStaleAsideWorktrees` (or the
   `served_status` wiring around it) call `measureDirSize` per entry to report a total. The manager
   reviewing the design corrected this: N leftovers at ~270 MB / ~16K entries each would make every poll
   walk gigabytes. Byte totals are reported ONLY by `GET /api/worktrees/stale-leftovers` (a human calls it
   deliberately) and by the reclaim result — never by the polled `served_status`/`deploy-status` surface,
   which gets only `{count, oldestStaleSinceMs}`.
2. **The level-2→level-3 probe is registry-driven, not name-shape-guessed.** The secondary-repo axis
   (`WORKTREES_DIR/<projectId>/<repoKey>/<taskKey>`, multi-repo epic 49136451) means a stale leaf can sit
   one level deeper than the primary axis. The naive way to find it is to probe one level deeper into
   EVERY entry that doesn't itself look like a stale leaf — but that means `readdirSync`-ing every LIVE
   worktree's own root content on every single poll, which is exactly the per-poll disk cost point (1)
   above exists to avoid (a live worktree's root typically has a real directory listing — package.json,
   src/, node_modules/, .git, …). Instead, the probe only descends into an entry whose name is a
   project's own REGISTERED repoKey (from `Project.repos`, via `repoKeysByProjectFromProjects`) — never a
   guess from the entry's name shape (e.g. "doesn't look like a 12-hex taskKey", which a repoKey could
   coincidentally match or fail to match either way).

## Round 2 (Code Review b674e1fb, Major — proven data loss)

The level-2 loop checked the basename-shape regex BEFORE the registry (`repoKeys?.has(entry.name)`), so
a registered repoKey whose name happens to ALSO match `.stale-<ts>` (e.g. `svc.stale-1` — the charset
validator in `projects/repos.ts` allowed it) made its own axis dir — which holds that repo's LIVE
worktrees one level below — look exactly like a renamed-aside leftover. The reclaim POST then passed
every existing guard (the live-claimant check is exact-path, and sessions live one level below the axis
dir) and deleted the live worktrees underneath. Fixed on both sides — defence-in-depth: either guard alone
protects the POST path (correction, card `e3fcd8ea` item 4 — "neither alone is sufficient" overstated it;
the two fixes protect different surfaces, but on the reclaim POST path specifically each is independently
sufficient on its own):

1. **Enumeration now checks the registry FIRST.** An entry whose name is a registered repoKey (active OR
   archived) for that project is NEVER treated as a stale leaf, regardless of whether it also matches the
   suffix shape — it is only ever probed one level deeper. See `listStaleAsideWorktrees`'s own doc.
2. **Reclaim refuses independently, never trusting "the fresh listing didn't show it to me" alone.**
   `isRegisteredRepoKeyAxisDir` re-derives the same registry check directly against the requested path,
   and `reclaimStaleAsideWorktreeDir` refuses on it before ever reaching `worktreeRemovalRefusal` — a
   second, structurally separate line of defense against the exact same collision.
3. **The write side is closed too.** `validateRepoRegistry` now rejects a NEW repoKey shaped like
   `.stale-<ts>` outright. An already-stored key from before this fix is NOT migrated or revoked — it
   stays registered and relies on (1)/(2) above for protection, forever (fix 1/2 are not conditioned on
   fix 3 having run). **Correction (card `e3fcd8ea` item 2):** this write-side rejection also used to
   re-fire against such an already-stored key on every later rebind/echo (three RE-validation call sites
   re-ran the full check against the project's own pre-patch registry) — a project carrying one got a
   permanent 400 on every future settings edit. `validateRepoRegistry` now accepts `opts.existingKeys`,
   exempting a key already in the caller's pre-patch registry from the shape check ONLY (every other check
   still applies); see `docs/decisions/e3fcd8ea-*` for the full fix and tests.
4. **Enumeration also skips a planted junction/symlink** named to look like a leftover (a cheap, single
   `lstatSync` on a name-matched candidate only — never a scan-wide stat). **Correction (card `e3fcd8ea`
   item 3):** the original claim here — "a Windows directory junction reports as a directory at the
   readdir level" — is FALSE as measured on Node 22.16/Win11 (see `docs/decisions/e3fcd8ea-*`): both
   `fs.readdirSync(..., {withFileTypes:true})`'s Dirent and `fs.lstatSync` report a real junction as
   `isSymbolicLink()===true` / `isDirectory()===false`, so the pre-existing `isDirectory()` filter alone
   already excludes a junction on this Node/libuv version, making this helper measured-redundant today.
   Kept anyway as declared, inert defence-in-depth (junction/Dirent reporting is libuv-/Node-version-
   dependent and may change, and this guards a host-path delete) — see `e3fcd8ea`'s own record for the full
   reasoning and the test that pins the measured behavior so a future Node upgrade that changes it is
   caught loudly.

**Known, accepted residual (nit, left as-is):** two concurrent `POST /api/worktrees/reclaim-stale-leftover`
calls on the SAME path can both pass the live-claimant/confinement checks and both report
`bytesReclaimed` for the same bytes (the second call's `removeDir` just finds the path already gone and
reports accordingly, but the measured size was already read by both before either deleted). Harmless
double-counting in a human-triggered, singular-reclaim surface — not worth a lock for.

## Round 3 (card `04e4262d`, Code Review `b674e1fb` minor #2) — a narrow, opt-in exception to "do not widen the probe"

Round 1's registry-driven design has a gap: removing a repoKey from a project's `repos` is a supported
operation, and once removed, its axis dir no longer appears in `repoKeysByProject` — so the level-2 loop
falls to the primary-leaf fallback, which never matches an (unsuffixed) axis-dir name, and every leftover
nested one level below it becomes permanently invisible: no `served_status` count, no GET listing, no
boot warning, and the reclaim POST says "not-found".

This is fixed WITHOUT widening the probe unconditionally (the "Do not" below still holds for the DEFAULT
case) — `listStaleAsideWorktrees` gained a third, optional `opts.probeUnregistered` parameter, default
`false`/omitted. `served-status.ts`'s polled call never passes it, so that surface stays byte-identical
in both output AND cost — it remains a deliberate, accepted undercount for this one edge case, same
posture as its existing count-vs-bytes split. Boot-reconcile's warning and both the GET listing and POST
reclaim's fresh re-derivation (`SessionService`) now pass `probeUnregistered: true` — these are exactly
the "deliberate, not polled" surfaces round 1 already carved byte-measurement out to.

With the flag on, an unregistered level-2 entry gets:

1. **Suffix-named (today's primary-leaf case), unchanged, PLUS a collision backstop that runs
   UNCONDITIONALLY (round 4 amendment — see below).** The basename-only check is NOT touched — a
   renamed-aside leaf is reported with no `.git`-presence check at all, because `renameWorktreeDirAside`
   is a bare rename that never touches contents, and NOT every caller guarantees the leaf had no `.git`
   link before the rename (`reclaimWedgedWorktreePathForSpawn`'s wedge-retry rename does not share
   `createWorktree`'s own `!worktreeHasGitLink` precondition). The ONLY addition is: if
   `findNestedWorktreeLikeChild` (the same shape+`.git`-FILE proof `c994ffeb` established) finds a LIVE
   nested worktree underneath, the entry is excluded — it's the round-2 "svc.stale-1" collision shape
   again, just now for a repoKey that is no longer (or never was) registered.
2. **Non-suffix (the gap-closing case).** Only descended into once proven the entry is not a PRIMARY task
   worktree key by shape (round 4 amendment — see below) and holds NO `.git` entry of its own — file, dir,
   or link, readable or not, case-folded on win32 (round 4 amendment): any plain name-presence hit for
   `.git` in the one bounded `readdirSync` already being done, never a separate stat. A dir that has one is
   a checkout, a nested clone, or a worktree mid-`git worktree add`, and its content is arbitrary/
   user-controlled, never a Loom-managed container shape — it is excluded before anything inside it is
   read. A dir with none is treated exactly like a registered axis dir already was: its children are
   matched by basename only, and any `.stale-<ts>`-suffixed one is reported.

## Round 4 (card `04e4262d`, Code Review `c1929951`) — a host-delete exposure in the gap-closing probe, plus two smaller fixes

Round 3's gap-closing probe (item 2 above) had a real host-delete exposure: it keyed solely on "does this
entry have a `.git` entry of its own", with no check that the entry wasn't already a REAL task worktree. A
PRIMARY task worktree whose `.git` is transiently missing (e.g. a crash mid-`git worktree add`, or a wedge
in progress) is indistinguishable from a removed/never-registered repo-axis container by that test alone —
so the probe descended into it and surfaced (and reclaim then deleted) ordinary user content sitting
inside a live task worktree. Repro: `projR/0123456789ab/{src/x, cache.stale-123}` with no `.git` at
`projR/0123456789ab/` — `cache.stale-123` was listed, and the reclaim POST reported `"removed"`. The POST's
live-claimant check (`findLiveSessionClaimingWorktreePath`) is an exact-path match against the session's
own worktree path (`projR/0123456789ab`), so it never protected a child path one level below.

Fixed in `listStaleAsideWorktrees`'s gap-closing branch: before probing an unregistered, non-suffix level-2
entry at all, skip it outright if its name matches `TASK_KEY_SHAPE_RE` (the same 12-lowercase-hex shape a
primary task worktree's basename always is). `validateRepoRegistry` (`projects/repos.ts`) already rejects
any NEW repoKey of this shape, so going forward this name shape can only ever be a real primary task
worktree — never a legitimate repo-axis container. The one residual: a repoKey registered BEFORE that
guard existed (grandfathered via `opts.existingKeys`) could still carry this exact shape; such a key's
leftovers become permanently undercounted by this probe, same accepted-undercount posture as round 3's own
`served_status` tradeoff — there is no registry lookup available at this point in the branch (it already
fell through "not a registered key") to tell the two apart.

Two smaller fixes landed alongside it:

- **The collision backstop (item 1 above) is now unconditional**, not gated behind `probeUnregistered`.
  Gating it meant `served_status` (which never passes `probeUnregistered`) could OVERcount relative to the
  GET listing for a suffix-named unregistered entry that collided with a live nested worktree — the GET
  listing (with the backstop) would exclude it while `served_status` (without it) would still count it.
  Running the backstop unconditionally is a single extra bounded `readdirSync`, charged only for an entry
  that already matches the rare `.stale-<ts>` suffix shape — not the per-poll "readdir every live
  worktree's root content" cost the "Do not" rule below still forbids; that rule is about the UNSUFFIXED
  gap-closing descent (item 2), not this backstop.
- **The `.git`-entry presence check in the gap-closing probe now folds case on win32**, mirroring
  `isRegisteredRepoKeyName`'s own platform-conditional fold — a bare `c.name === ".git"` missed a
  differently-cased `.GIT` entry even though win32's real filesystem treats it as the same container.

## Do not

- Do not add byte-size measurement (or any `fs.stat`/`measureDirSize` call) to `listStaleAsideWorktrees`
  itself — it must stay a pure `readdirSync` enumeration so it's safe to call on every polled
  `served_status`/`deploy-status` read. Put byte totals in a caller that is invoked deliberately instead
  (the REST listing, the reclaim result). A single `lstatSync` per NAME-MATCHED candidate (round 2, item
  4 above) is NOT this — it's bounded by match count, never a scan-wide stat.
- Do not widen the level-2→level-3 probe to "any entry not matching the stale-leaf regex" UNCONDITIONALLY
  — that reintroduces the per-poll readdir-every-live-worktree cost onto `served-status.ts`'s polled call,
  which must stay on the default (`repoKeysByProject`-only) path, no `opts.probeUnregistered`, forever.
  **Round 3** added a narrow, explicitly OPT-IN widening (`opts.probeUnregistered`) for the three
  deliberately-not-polled callers (boot-reconcile's warning, the GET listing, the POST reclaim's fresh
  re-derivation) — see Round 3 above for the safety argument. Do not flip that default to `true`, and do
  not let `served-status.ts` start passing it.
- Do not go back to checking the basename-shape regex before the registry in the level-2 loop (round 2
  Major, above) — the registry check must run first, or a registered repoKey shaped like `.stale-<ts>`
  is indistinguishable from a real leftover again.
- Do not let `reclaimStaleAsideWorktreeDir`/`reclaimStaleWorktreeLeftover` rely SOLELY on a fresh
  `listStaleAsideWorktrees()` call having excluded a path — always also call `isRegisteredRepoKeyAxisDir`
  independently before removing anything matching the stale-aside shape.
- Do not let the gap-closing probe (round 3 item 2) descend into a level-2 entry shaped like a primary
  task worktree key (`TASK_KEY_SHAPE_RE`) without first checking the registry — round 4's fix is to skip
  it outright by shape; going back to "probe it like any other non-suffix entry" reopens the host-delete
  exposure that round found (listing, and then reclaiming, real content from inside a live task worktree
  whose `.git` link was transiently absent).
- Do not re-gate the collision backstop (round 3 item 1) behind `opts.probeUnregistered` again — round 4
  made it unconditional specifically so `served_status` and the GET listing agree on this one shape; see
  Round 4 above for the overcount it previously caused.
