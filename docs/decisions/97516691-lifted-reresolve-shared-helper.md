# 97516691 — every clear route's `liftedRepoPaths` re-resolves through the shared helper

Found by `25d0d45b`'s re-CR. State: raise R; a foreign D co-located at R's canonical key K is armed in memory during R's own clear (`1dd00dca`/`25d0d45b`). `/clear` returned `liftedRepoPaths:[R]` while `/clear-by-path` returned `[]` + `stillQuarantined:true`; `assertRepoNotQuarantined(R)` refuses, so the first claim was untrue.

## Cause

`resolveGenuinelyLiftedRepoPaths` decided "lifted" by IDENTITY only (`ownIdentityEntryFor`) and cannot see a foreign entry armed at the candidate's KEY. Only `tryClearMergeQuarantineByOwnIdentity` patched this afterwards (filtering the queried identity); `clearMergeQuarantineByKey`, which `/clear` reaches, did not.

## Fix

The one shared helper now also requires `!stillBlockedEntryFor(candidate)` (the pure mirror of `assertRepoNotQuarantined`). Both callers get it; the per-caller filter in `tryClearMergeQuarantineByOwnIdentity` stays as a redundant backstop.

## Do not

- Do not add a second, per-route copy of this re-resolve. Fix the helper.
- Do not use `resolveQuarantineFor`/`activeMergeQuarantineFor` for it (they can mutate state); use the pure `stillBlockedEntryFor`.
- Do not report an identity lifted on the strength of "no entry of its own" alone: lifted implies `assertRepoNotQuarantined` passes (an implication, not an equivalence: own-identity entries armed at a different key make the code slightly stricter than assert for a resolvable path).

## Pinned old behaviour that changed (each now equals assert's verdict)

- `merge-quarantine-1fea8b15-tmp-sweep-content-check.mjs` (twoclear, first clear): R was pinned as lifted while refused; now not lifted.
- `merge-quarantine-f8e11853-freed-key-cross-hash-residue.mjs` (main, rocc): Y was pinned as "genuinely lifted" while X armed at Y's key refused it; now not lifted.

Test: `merge-quarantine-97516691-lifted-reresolve.mjs` (`/clear`, `/clear-by-path`, `/clear-by-id`, cross-route agreement, no-D positive control).

## Round 2: released vs admitted (Code Review finding 1)

Narrowing `liftedRepoPaths` to "admitted now" silently dropped a NON-queried candidate whose own tokens the clear DISCARDED while a different identity still blocks it: it left `alsoReleasedRepoPaths` (the "confirm no merge is running" safety warning), the `provenanceUnknown` notice, and every later disclosure.

The shared helper (`resolveReleasedAndLiftedRepoPaths`) now returns THREE sets from one pass: `released` (tokens discarded, the old meaning of "lifted"), `lifted` (released AND `!stillBlockedEntryFor`, unchanged), and `releasedStillBlocked` (`{repoPath, blockedByRepoPath}`, no tokens). Routes expose `releasedRepoPaths` (module-level), and the REST responses add `releasedStillBlockedRepoPaths` on `/clear`, `/clear-by-path`, `/clear-by-id` and `/clear-broad-union`. `alsoReleasedRepoPaths` and the `provenanceUnknown` notice are computed over RELEASED. The queried identity is left out of the released sets on the still-quarantined branch (it is already reported by `stillQuarantined`).

### Do not (round 2)

- Do not compute `alsoReleased` or the provenance notice over `liftedRepoPaths`; that is the dropped-warning bug.
- Do not add a second fork of the partition; extend the helper.
- Do not put tokens or secrets in `releasedStillBlockedRepoPaths` entries.

### Test sensitivity

Sections (B) and (E) of the test stay green under a revert of the helper (B is masked by the queried-identity backstop, E by the hard-coded `liftedRepoPaths` on that route): they are agreement/regression pins. Sections (F), (F2), (G), (H1), (H2) use a NON-queried candidate and are what only the helper can decide. `/clear-by-id` returns only the id's own entry, so it cannot carry a non-queried candidate by design.
