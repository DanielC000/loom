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

Sections (B) and (E) of the test stay green under a revert of the helper (B is masked by the queried-identity backstop, E by the hard-coded `liftedRepoPaths` on that route): they are agreement/regression pins. Sections (F), (F2), (G), (H1), (H2) use a NON-queried candidate and are what only the helper can decide. The by-id ACTIVE branch returns only the id's own entry, so it cannot carry a non-queried candidate by design; the by-id PENDING multi-claimant branch can (section (I5), seam-built).

## Round 3: one rule for `releasedStillBlockedRepoPaths` (card 6ac1894a)

The routes disagreed on whether the addressed identity appears in `releasedStillBlockedRepoPaths`: the tryClear still-quarantined branch excluded it by a post-filter, while the by-id active and pending branches and the `clearMergeQuarantineByKey` fall-throughs included it. By-id also omitted `addressedRepoPaths` on its still-blocked return, so `alsoReleasedRepoPaths` named the ADDRESSED identity itself (a "also released" warning exists to point at OTHER repos). By-id could also set `blockedByRepoPath` to the same identity's own independent record, contradicting the type doc ("a DIFFERENT identity's entry").

**Rule (owner-approved, option A):** `releasedStillBlockedRepoPaths` names only released-but-blocked identities that are neither (a) an ADDRESSED identity nor (b) blocked by an entry of the SAME `directPathIdentity`. The addressed identity's own still-blocked state is reported by `stillQuarantined`/`reason` (and the route's existing equivalents), never here. The rule lives in `releasedStillBlockedEntryFor` (`git/merge-quarantine.ts`), called from `resolveReleasedAndLiftedRepoPaths` (which gained an `addressedRepoPaths` parameter, passed by `clearMergeQuarantineByKey` and the tryClear path) and from the by-id pending loop (addressed = the first matched identity, the same one `addressedRepoPaths` reports). The by-id active still-blocked return now carries `addressedRepoPaths` and an empty `releasedStillBlockedRepoPaths` (its only candidate is the addressed one). The tryClear post-filter on `releasedStillBlockedRepoPaths` was removed (the helper covers it; the `liftedRepoPaths`/`releasedRepoPaths` backstop filters stay).

**REST behaviour change (by-id only):** the addressed identity no longer appears in `releasedStillBlockedRepoPaths` nor in `alsoReleasedRepoPaths`; `stillQuarantined:true` and `reason` (naming the blocker) still do. Pinned by sections (H1), (H2), (I3) and (I5) of the test; (I5) is the one by-id state with a non-addressed released-blocked identity, built through `pushPendingQuarantineTestOnly` with two pending entries sharing one source file.

### Do not (round 3)

- Do not inline the addressed/self-blocked exclusion at a route; call `releasedStillBlockedEntryFor`.
- Do not drop the addressed identity's `stillQuarantined`/`reason`: moving it out of `releasedStillBlockedRepoPaths` must not make it vanish.
- Do not pass an empty addressed list to the helper to "fix" a missing field; that reopens the self-naming.
- The self-blocked half is witnessed by (I5'): disabling the self-blocked line in `releasedStillBlockedEntryFor` (API kept) fails it.

### Round 3 follow-up (CR BLOCK, card 6ac1894a)

`/clear-broad-union` passed `[entry.repoPath]` as addressed but its response carried no `stillQuarantined`/`reason`, so a still-blocked addressed primary (foreign F orphan-armed at its key) vanished from the response entirely. `composeBroadUnionClearResult` now takes the addressed path and adds `stillQuarantined:true` plus `reason` (via `stillBlockedEntryFor` + `stillQuarantinedReason`, the same pair the other routes use); the REST route spreads the whole result, so it reaches the wire and the event detail unchanged. Witness: (I4') — RED against the pre-fix source with the API kept. The `releasedStillBlockedRepoPaths` doc now scopes the "reported via `stillQuarantined`/`reason`" claim to routes with an addressed identity (/clear, /clear-by-path, /clear-by-id, /clear-broad-union).

**Addressed vs. body path (reviewer question):** broad-union's addressed identity is `entry.repoPath`, not the `body.repoPath` as sent. They cannot differ by `directPathIdentity`: `broadUnionTargetFor` selects only an active entry whose `directPathIdentity(entry.repoPath)` equals the caller's identity, so a contributor's path never resolves to its union (it refuses with "does not match any union"). Only the string form can differ, and every comparison here is identity-based.
