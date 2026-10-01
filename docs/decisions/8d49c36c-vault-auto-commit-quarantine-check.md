# 8d49c36c — vault auto-commit checks quarantine on its governing root; GitWriter.commit surfaces swept-in residue

Follow-up from the Code Review of `d8bb2074`/`cb6ba196` — read those first.

## Narrative

`vault/versioner.ts` had NO merge-quarantine awareness at all. `GitWriter.withVaultPauseLease` (writer.ts)
pauses `VaultVersioner`'s own commit tick for the duration of one git-surgery op, but always resumes it in
`finally` — including when that op left the canonical repo QUARANTINED via an unconfirmed kill (`d8bb2074`).
The instant the lease lifts, the vault's debounced tick (or a human `vault_write`, which shares the same
`commitVault` path) could run `add`/`commit` straight into the still-possibly-live orphan. Separately, the
pause lease is only ever acquired by `GitWriter`'s own ops — the merge/batch path
(`mergeBranchLocked`/`fastForwardCanonicalMain`/`assembleBatchBranches`) can quarantine the SAME canonical
repo with no pause-lease interaction at all, so the vault tick could race that trigger too, independent of
GitWriter entirely.

This is reachable because `checkVaultRepoTripleContainment` (`cb6ba196`, `5ba4412d`) only refuses a NEW
create/update into a vaultPath that aliases or nests a code repo — an EXISTING row whose vaultPath already
canonically equals its repoPath (the "intentional pairing" exemption) keeps that shape through any later
update that leaves repoPath/vaultPath untouched. Those legacy rows are the ones exposed.

**Fix:** `assertRepoNotQuarantined` checked directly in the two real vault-git mutation chokepoints —
`commitVault` (used by both the debounced tick and `vault/writer.ts`'s three UI-write functions) and
`VaultVersioner.flushSync()` (the synchronous shutdown flush, a sibling path with its own raw
`execFileSync` git calls, found during this investigation and previously uncovered by anything). Keyed on
the CONFIRMED governing root — `commitVault`'s own `vaultPath` parameter, by that point in the function
already resolved to the repo toplevel, and `VaultVersioner.flushSync`'s own `this.commitPath`, resolved
once in `start()` via `resolveVaultRepoContext`'s upward walk. **A legacy vault that's a SUBDIR of a code
repo DOES reach this check on its real auto-commit path:** `VaultVersioner.start()` resolves such a
`vaultPath` UP to the repo toplevel via `resolveVaultRepoContext`, and both the debounced tick and
`flushSync` call into `commitVault`/do their own commit keyed on that already-RESOLVED root — never the
raw subdir — so the root-keyed check is live for them (confirmed by `vault-commit-quarantine.mjs`'s own
case [2]). The `externallyManaged` backoff returning `false` for a raw, unresolved subdir argument only
matters for a caller that passes `commitVault` an UNRESOLVED path directly — `vault/writer.ts`'s three
UI-write functions take whatever raw `vaultPath` their caller supplies, so a human UI write against a
legacy subdir-vault row's raw configured path backs off there before ever reaching the quarantine check;
the tick/flushSync path is unaffected because it never passes that raw path in the first place.
`assertRepoNotQuarantined` → `canonicalRepoLockKey` already normalizes via `fs.realpathSync.native` +
win32 lowercasing, so a spelling variant (case/trailing separator/slash direction) of the same real
directory matches without any extra normalization here. `commitVault` re-checks a SECOND time immediately
before the actual `git commit` call (after `hasConfiguredGitIdentity`'s own two `git config` subprocesses,
not before them — doing it before would widen the window this re-check exists to close), not just once up
front — `git add .` alone can run for minutes (`VAULT_FLUSH_WORKING_TREE_TIMEOUT_MS`), long enough for a
quarantine to appear mid-call; `flushSync` is one synchronous burst, so one check suffices there.

**Rejected: holding the vault pause lease open until the quarantine clears.** Conflicts with `614dfbef`'s
own stated invariant ("never let a caller request an unbounded pause... a mistaken huge duration can't
silence auto-commit for good") — a quarantine is explicitly POTENTIALLY-PERMANENT
(`merge-quarantine.ts`'s own doc) pending a human clearing it, so holding the lease open until it clears
could silence vault auto-commit indefinitely. It also structurally cannot help against a merge/batch-raised
quarantine, since that path never touches the vault pause lease.

**Rejected: routing `commitVault`'s `add`/`commit` through `killableCanonicalRaw`.** That helper's real
(non-test-seam) spawn path hardcodes `CANONICAL_GIT_CONFIG_ARGS` (`core.useReplaceRefs=false` only), with
no way to inject extra `-c` config. Switching would silently drop this module's own hook/fsmonitor/gpgsign
neutralization (`VAULT_GIT_SAFETY_CONFIG`, decision `ffe98495`) — a real security regression on a
trust-boundary surface (a hostile `vault_write` could again plant a `.git/hooks/pre-commit`). The only
escape hatch, passing a custom `gitFactory`, forfeits the real tree-kill protection too (that helper's own
doc: a supplied `gitFactory` "has no real child to kill... stays on a plain withTimeout"). Properly fixing
this would mean extending the shared primitive used by all six call sites (`git/writer.ts`,
`git/worktrees.ts`, `git/batch-merge.ts`, `orchestration/restart.ts`, `sessions/service.ts`,
`setup/bootstrap.ts`) with a config-args parameter — out of this card's scope and against that module's own
documented design ("does NOT bundle... per-call-class differences... folding those away would be a
regression"). **Tracked follow-up, not fixed here:** `commitVault`'s own `add`/`commit` calls remain on a
bare `withTimeout` (never kill-confirmed), so a hung vault commit can itself leave an unconfirmed orphan
that nothing quarantines — the SAME class of gap `d8bb2074` closed for `GitWriter`, left open here for the
reason above.

**`commitVault`'s own pre-existing-staged-residue risk:** its `git add .` is just as capable as
`GitWriter.commit`'s `add -A` of sweeping an escaped descendant's already-staged residue (left behind by an
earlier unconfirmed kill, now auto-cleared) into its own next unattended commit. Unlike `GitWriter.commit`
(a deliberate human/agent act with a result a UI can render), nothing reviews this path per-call — so this
is logged only (a `console.warn` naming the swept-in path(s) before `git add .` runs), never refused or
built into a structured field; see `git-writer.ts`'s `commit()` for the human-facing equivalent.

**`GitWriter.commit`'s swept-in residue (separate, human-facing surface):** `commit()` already reads
`git.status()` before its own `add -A` runs (to decide `isClean()`) — that same read tells us which files
were ALREADY staged (index char not blank/`?`) before this call touched anything. Surfaced as a structured
`residue?: string[]` field on the success result (scoped to `paths` when given — exact or nested-under
match — else every already-staged file) AND folded into the existing joined `warning` string, alongside
`oversizedWarning`/`strippedWarning`. **Chosen: WARN, never refuse** — refusing would also break a
legitimate, pre-existing workflow (a human staging extra content via a terminal outside Loom before using
the UI "commit" button is not corruption), and this project's own precedent for this exact
human/agent-driven surface (decision `237d1899`: oversized files WARN, never refuse, because "this path is
a deliberate human/agent act") already draws the line the same way.

## Do not

- Do not key the vault quarantine check on a caller's raw/possibly-unresolved `vaultPath` — always use the
  CONFIRMED governing root (`commitVault`'s own `vaultPath` by the point of the check; `this.commitPath` in
  `VaultVersioner`), the same path a `GitWriter`/merge-path quarantine on the physical repo is keyed on.
- Do not check quarantine only once at the top of `commitVault` — re-check again immediately before the
  actual `git commit` call; the `git add .` call alone can run long enough for one to appear mid-call.
- Do not route `commitVault`'s (or `flushSync`'s) mutating git calls through `killableCanonicalRaw` without
  first giving it a way to carry this module's own `VAULT_GIT_SAFETY_CONFIG` (hooksPath/fsmonitor/gpgsign/
  safe.bareRepository) — doing so today silently drops that hook-injection defense.
- Do not build `commitVault`'s own pre-existing-staged-residue finding into a refusal or a structured field
  — it is a logged-only, unattended-path visibility note by design; the structured, refuse-or-warn decision
  belongs to `GitWriter.commit`'s own human-facing `residue` field, a separate surface.
- Do not refuse `GitWriter.commit()` on pre-existing staged residue — warn (fold into `warning` + the
  structured `residue` field) so a legitimate out-of-band `git add` by the human isn't blocked.
- Do not forget `VaultVersioner.flushSync()` when touching this area again — it is a THIRD git-mutation path
  for a vault's governing repo (sibling to `commitVault`, used only at daemon shutdown, with its own raw
  `execFileSync` calls) that is easy to miss since it doesn't call `commitVault` at all.

## Source

Card `8d49c36c`. Tests: `vault-commit-quarantine.mjs` (new), `git-writer-kill-confirm.mjs` (section [5]
extended).
