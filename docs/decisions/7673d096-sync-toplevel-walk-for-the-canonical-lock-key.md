# 7673d096 — synchronous filesystem walk for the canonical lock key's toplevel resolution

## Narrative

`canonicalRepoLockKey` (`git/repo-lock.ts`) keys the canonical-index mutex, the merge quarantine store,
the merge-danger latch/window trackers, and a ContextWatcher emergency-redirect gate. Before this card it
hashed the project's BOUND `repoPath` directly (realpath + lowercase on win32) — for a project bound to a
SUBDIR of a repo with no `.git` of its own (real specimen: a vault project bound inside a shared Obsidian
vault repo), that locks on the subdir, while git itself operates against the TOPLEVEL's index. A
`GitWriter` op on that project and a merge/GitWriter op on a SIBLING project bound directly at the same
physical toplevel computed DIFFERENT keys and never serialized against each other, despite mutating the
SAME physical `.git` index concurrently.

The investigation found every caller of `canonicalRepoLockKey` is SYNCHRONOUS — including
`reenterMergeQuarantinesAtBoot`, which must finish before the gateway accepts any request, and
`redirectManagerForEmergencyRecycle` (sessions/service.ts), a sync ContextWatcher-triggered method. A real
`git rev-parse --show-toplevel` is an async subprocess call; making the key resolver do that would force
roughly twenty call sites across five files to become async, a far wider ripple than "key the lock on the
toplevel." A plain filesystem walk — starting at the bound path's realpath and checking at each ancestor
for a `.git` entry (directory or file, so a linked worktree/submodule still counts) — stays synchronous and
gives the one property this machinery needs: two paths inside the same physical repo collapse to the same
key. It does not consult `GIT_DIR`, `GIT_CEILING_DIRECTORIES`, or `safe.directory`, since those answer
"which repo does a git INVOCATION target" (an env/config-driven question), not "which key does this
filesystem path hash to" (a pure function of the path) — and there is no subprocess here for them to
influence in the first place.

**Verified call-site count (re-derive, never trust this number without re-grepping):** `grep -rn
"canonicalRepoLockKey(" packages/daemon/src --include="*.ts"` finds 21 real call sites (excluding the
function's own definition line) across 5 files — `git/repo-lock.ts`, `git/merge-quarantine.ts`,
`git/merge-danger-latch.ts`, `git/merge-danger-window.ts`, `sessions/service.ts`. An earlier draft of this
record said "~15" — that was an estimate made before the Code Review round below added several more
`armQuarantineKey`/`resolvedKey`-related call sites; re-grep before citing a count elsewhere.

No memoization was added. Each call is a handful of `fs.existsSync` checks bounded by how many directories
separate the bound path from its enclosing repo's root. For a path that genuinely IS inside a repo, that is
typically 0-3 levels in this codebase's real registered repos — negligible next to the 15s-bounded git
subprocess calls that already surround every real caller. **That "0-3 levels" figure describes ONLY the
inside-a-repo case** — a path with NO enclosing repo at all (a vault-only project, a test fixture) walks
every ancestor up to the filesystem root before falling back to the literal input, which can be
arbitrarily many levels on a deeply nested path. Still cheap (bounded by real path depth, never unbounded),
but do not read "0-3" as a universal bound. A cache would need its own invalidation story (a project
repoPath rebind, a `.git` appearing where there was none) for a cost that measures out to noise — not
worth the complexity.

### Durable quarantine latch migration

`merge-quarantine.ts`'s durable latch filenames are a hash of `canonicalRepoLockKey(repoPath)`. A
toplevel-bound project's key is unchanged by this card, so its latch filename is unchanged too. A
subdir-bound project's key changes, so a latch written under the OLD key's hash would otherwise become
unreachable by `clearMergeQuarantine` (which always computes the CURRENT key's path) — a cleared
quarantine's stale old-hash file would survive on disk forever and silently re-enter on every later boot,
because `reenterMergeQuarantinesAtBoot`'s PASS 1 parses the file fine (it is not corrupt) and would
otherwise never re-persist it under the new name. PASS 1 now compares the file's own name-hash against a
freshly-computed `quarantineHashFor(entry.repoPath)` for every successfully-parsed latch and, on a
mismatch, self-heals: writes the same content under the current-key path and deletes the stale one. PASS
1b's tmp-residue recovery gets the equivalent treatment.

### Code Review round — BLOCKING: a path that is transiently unresolvable at boot must never be migrated

The round above had a fail-open BLOCKER: `resolveGitToplevelSync` fell back to the literal
`path.resolve(bp)` (no walk at all) the instant `bp` itself failed to realpath — so a subdir-bound repo
that is momentarily absent at boot (an unmounted drive, a not-yet-synced cloud folder — the real Obsidian-
vault-on-a-cloud-drive case) computed a DIFFERENT key than its own correct, already-written latch. PASS 1
then "migrated" the GOOD file onto that degraded key and deleted the original — and once the drive
remounted, every later check computed the real toplevel key again, found nothing there, and the quarantine
was silently unenforced for the rest of that boot. Reproduced cross-boot in
`test/merge-quarantine-unresolvable-path.mjs` (RED against commit a4198110 — the file was destroyed and
`assertRepoNotQuarantined` wrongly read `{ok:true}` once the repo was restored).

Fixed in three parts:
1. `findExistingAncestorRealpath` (`git/repo-lock.ts`) makes `resolveGitToplevelSync` tolerate `bp` itself
   being momentarily absent: it realpaths the NEAREST EXISTING ancestor and reattaches the missing tail, so
   the common case (the leaf subdir not yet materialized, the enclosing repo folder still present) computes
   the SAME stable key regardless of the leaf's own existence — no migration drama needed there at all.
2. `isRepoPathCurrentlyResolvable` (`git/repo-lock.ts`) checks `bp` ITSELF directly via `realpathSync` —
   deliberately NOT "does some ancestor resolve" (that is almost always true, even when the registered path
   itself is gone, and would protect nothing). `reenterMergeQuarantinesAtBoot`'s PASS 1/1b gate every
   migration/promotion decision on this: a hash mismatch is trusted enough to rewrite/delete a latch ONLY
   when the registered path itself currently resolves; otherwise the file is left exactly as written and a
   loud warning is logged.
3. `MergeQuarantineEntry.resolvedKey` records the exact key an entry was raised (or last migrated) under,
   persisted in the latch's own JSON. Boot re-entry arms the in-memory map under BOTH the current key and
   `resolvedKey` (when they differ) — so enforcement holds before, during, and after the registered path
   becomes resolvable again within the same boot, even on the genuinely degenerate "nothing resolves at
   all" path a transiently-unresolvable repo can still fall into.

### Code Review round — legacy-hash matching for a corrupt/torn latch

`reenterMergeQuarantinesAtBoot`'s `hashToRepo` map (used to classify a corrupt/unparsable `.json` or `.tmp`
as "matches this registered repo" vs. "orphan, quarantine everything") used to index only the FRESH
(current, toplevel-walked) hash per registered repo. A pre-upgrade corrupt/torn latch for a subdir-bound
repo was filed under the LEGACY (pre-toplevel-walk, realpath-only) hash, so it matched nothing and fell
through to the broad every-registered-repo fail-closed sweep instead of narrowly quarantining just that one
repo. `legacyQuarantineHashFor` (a frozen replica of the pre-7673d096 key algorithm, kept ONLY for this
matching purpose — never "fixed" to track current behavior) is now ALSO indexed into `hashToRepo` per
registered repo, alongside the fresh hash.

### Code Review round — union, never last-writer-wins, on a key collision

Two previously-distinct latches can now collapse onto the SAME key (two sibling subdir-bound projects of
one physical repo, each with their OWN pre-existing quarantine). PASS 1/1b used to `byRepoKey.set(key,
entry)` unconditionally, so the SECOND entry processed silently overwrote the first's tokens/identity —
real data loss. `armQuarantineKey`/`unionQuarantineEntries` now union on collision: token sets are merged,
and the EARLIER `enteredAt` entry's identity (repoPath/branch/reason/opId) wins, mirroring
`enterMergeQuarantine`'s own existing "longest-outstanding, still-unresolved raise" rule.

**This collapse is a real, user-visible behavioral consequence worth stating plainly, not just an internal
bookkeeping detail: once two sibling projects' bound paths resolve to the SAME physical toplevel, they
share ONE quarantine.** Raising a quarantine against either sibling's repoPath refuses canonical-index
mutations for BOTH; a single human clear (`POST /internal/merge-quarantine/clear`, keyed on either
sibling's path) lifts it for both at once, since there is only ever one underlying `.git` index to protect.
This is intentional — it is the exact invariant the toplevel walk exists to establish — but it is a
behavior change from the pre-card world where two subdir-bound siblings could never see each other's
quarantine at all.

### `resolveLeaseGitDir`'s own tradeoff (vault/versioner.ts)

`resolveLeaseGitDir` now routes through the same `resolveGitToplevelSync` walk, so a GitWriter op's
`pauseVaultAutoCommit(this.repoPath)` for a subdir-bound project lands its lease at the TOPLEVEL's `.git`,
where `VaultVersioner`'s own tick actually checks it (see below). This inherits the SAME tradeoff the lock
key itself accepts: a `commitPath` that is NOT itself a repo, but happens to sit nested under some
UNRELATED ancestor directory that IS a git repo (e.g. a dotfiles-managed home directory, or an accidental
`git init` somewhere up the tree), now resolves to THAT ancestor's `.git` — a pause lease could land in a
repo that has nothing to do with the vault. This is accepted, not guarded against: distinguishing "the
intended enclosing repo" from "a coincidental unrelated ancestor repo" is not resolvable from filesystem
structure alone (the project's own configured path IS the source of truth for what it's bound to), and the
failure mode is a harmless stray lease file in the unrelated repo's `.git`, never a corruption of that
repo's own history. The common, realistic case this card targets — a subdir genuinely inside the SAME
physical repo as its vault's toplevel — is unaffected and is what this walk is for.

### Consequence for a09b81a0's `isCommitPathMergeEligible` (vault/versioner.ts)

That function decides whether the vault auto-committer must take `withCanonicalIndexLock` before
committing — i.e. whether a real merge for some registered project could also target the exact same
physical repo. It matches EXACT `canonicalRepoLockKey` equality only, deliberately never at-or-under (see
its own doc for why at-or-under would reopen the monorepo-subdir danger `isCanonicallyAtOrUnder`'s
collision match exists to catch). Before this card, that exact-match check had a known gap: a project
bound to a SUBDIRECTORY of a repo with no `.git` of its own (real specimen, "P&C Oslo Case Study" — bound
inside the shared Obsidian vault, not at the vault's own root) computed a DIFFERENT `canonicalRepoLockKey`
than the vault root's own, so the lock never fired for that shape even though both are the same physical
`.git` index. This card's toplevel-walk key closes that gap by construction: both now resolve to the same
nearest-`.git` ancestor, so the exact-match check (and the lock it gates) correctly fires. No code change
was needed in `isCommitPathMergeEligible` itself — only its own doc comment, which used to describe this
as a known, unclosed gap and now points here instead. Verified: a synthetic repo-root + no-`.git` subdir
fixture resolves to the identical key via `canonicalRepoLockKey`.

## Do not

- Do not make `canonicalRepoLockKey`/`resolveGitToplevelSync` async, or thread a `git rev-parse
  --show-toplevel` subprocess call into it — see the "21 sync call sites across 5 files" reasoning above;
  that migration belongs to its own card if it's ever needed, not a silent side effect of this one.
- Do not add a cache to `resolveGitToplevelSync` without first re-measuring that the walk is actually a
  hot-path cost — it was deliberately left unmemoized here because the cost is noise next to the
  surrounding bounded git subprocess calls, and a cache's invalidation story (rebind, a `.git` appearing)
  is real complexity to take on for free.
- Do not honor `GIT_DIR`/`GIT_CEILING_DIRECTORIES`/`safe.directory` in this walk — it is a lock-key
  resolver, not a `git` invocation; those env/config overrides answer a different question.
- Do not skip the quarantine-latch migration in `reenterMergeQuarantinesAtBoot`'s PASS 1 when touching
  this area again — a successfully-parsed latch whose filename-hash no longer matches
  `quarantineHashFor(entry.repoPath)` must be re-persisted under the fresh path and the stale file removed,
  OR (when `isRepoPathCurrentlyResolvable(entry.repoPath)` is false) left exactly as written — never
  migrate on an unverifiable key, or a transiently-unresolvable path destroys a genuinely good latch.
- Do not gate that migration decision on "does some ANCESTOR of the path resolve" — that is almost always
  true (even `C:\`/`/` itself) and protects nothing; gate on the registered path ITSELF resolving
  (`isRepoPathCurrentlyResolvable`).
- Do not `byRepoKey.set(key, entry)` directly in PASS 1/1b — route every write through `armQuarantineKey`,
  which unions with whatever already occupies that key rather than silently overwriting it.
- Do not forget `hashToRepo` needs BOTH the fresh and the legacy hash per registered repo, or a pre-upgrade
  corrupt/torn latch for a subdir-bound repo falls through to the broad every-repo sweep.
- Do not fix `mergeBranch`/`mergeBranchLocked`'s own separate gap (it never calls `pauseVaultAutoCommit` at
  all, even for a toplevel-bound repo) as part of this card — filed as its own follow-up (card `87a3c87e`).

## Source

`git/repo-lock.ts` (`resolveGitToplevelSync`/`isRepoPathCurrentlyResolvable`/`canonicalRepoLockKey`),
`vault/versioner.ts` (`resolveLeaseGitDir`, routed through the same walk; `isCommitPathMergeEligible`,
whose exact-match check now covers the subdir-bound shape by construction), `git/merge-quarantine.ts`
(`MergeQuarantineEntry.resolvedKey`, `legacyQuarantineHashFor`, `armQuarantineKey`/
`unionQuarantineEntries`, `reenterMergeQuarantinesAtBoot`'s PASS 1/1b).
