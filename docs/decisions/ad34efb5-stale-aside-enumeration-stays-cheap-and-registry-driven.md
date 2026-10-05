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

## Do not

- Do not add byte-size measurement (or any `fs.stat`/`measureDirSize` call) to `listStaleAsideWorktrees`
  itself — it must stay a pure `readdirSync` enumeration so it's safe to call on every polled
  `served_status`/`deploy-status` read. Put byte totals in a caller that is invoked deliberately instead
  (the REST listing, the reclaim result). A single `lstatSync` per NAME-MATCHED candidate (round 2, item
  4 above) is NOT this — it's bounded by match count, never a scan-wide stat.
- Do not widen the level-2→level-3 probe to "any entry not matching the stale-leaf regex" — that
  reintroduces the per-poll readdir-every-live-worktree cost. Only probe an entry that
  `repoKeysByProject` names as a real registered repoKey for that project.
- Do not go back to checking the basename-shape regex before the registry in the level-2 loop (round 2
  Major, above) — the registry check must run first, or a registered repoKey shaped like `.stale-<ts>`
  is indistinguishable from a real leftover again.
- Do not let `reclaimStaleAsideWorktreeDir`/`reclaimStaleWorktreeLeftover` rely SOLELY on a fresh
  `listStaleAsideWorktrees()` call having excluded a path — always also call `isRegisteredRepoKeyAxisDir`
  independently before removing anything matching the stale-aside shape.
