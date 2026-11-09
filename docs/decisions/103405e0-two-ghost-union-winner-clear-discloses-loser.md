# 103405e0 — a two-ghost boot union's winner clear names the loser it lifts

## The shape

Two wholly-UNRESOLVABLE identities X and Y, each with a `.json` final (not a tmp residue), carry the same
`resolvedKey` and union at boot under one key. The older record wins `unionQuarantineEntries`'s tie-break; the
union carries both tokens under the winner's identity and has no contributors. The loser has no queryable record
(`activeMergeQuarantineFor(loser)` is undefined, `clear(loser)` is NOT FOUND).

Measured on main `1e926924`, both age orders: `clear(winner)` lifts the WHOLE union. The loser's token is lifted
in memory, both files are deleted, a reboot stays clear, and `liftedRepoPaths` named only the winner. It is a
silent, durable over-lift on an explicit human clear. It never fails open without a human clear, and the
loser is itself an unresolvable, unregistered path.

## The fix: disclosure only

`clearMergeQuarantineByKey` snapshots, BEFORE it deletes anything (`unionedUnresolvableLoserRecords`), every
latch record the union physically occupies whose identity differs from the union's, is currently unresolvable
and is not already a contributor. The records are found through the union's live armed keys, its
`orphanLatchFiles`, and any pending wrapper whose `.entry` is the union object itself (boot's source-file
reference to the stale-named loser). After the clear, a loser is added to the candidate set only if every one of
its files is gone (`unionedLosersWhoseFilesAreGone`). The shared `resolveReleasedAndLiftedRepoPaths` re-resolve
then drops one that survives as its own entry or sits in `excludeRepoPaths`. The existing field carries the
name; no response key was added.

## Do not

- Do not stamp the unresolvable loser as a contributor to get this. A stamp on an unresolvable winner turns
  `clear(winner)` into a refusal and turns `d2582692-clearing-union-winner-keeps-loser-pending`
  (`merge-quarantine-pass1-degraded-union-guard.mjs`) RED; `clear-broad-union` is also untested for an
  unresolvable winner (see `398f476c-boot-union-stamps-its-unresolvable-loser.md`).
- Do not name a loser whose file survived, was kept, or was protected as a pending entry. Mixed `.json`/`.tmp`
  pairs keep the tmp identity as pending today, so it is not named (pinned by the mixed scenarios in
  `merge-quarantine-103405e0-two-ghost-union-lift-disclosed.mjs`).
- Do not take the by-key snapshot when the clear is NOT addressed at the union's own identity (a foreign occupant
  being protected, d2582692's shape): its extra `readFileSync` of the occupant's file shifted the Nth-read fault
  injection in `merge-quarantine-protect-read-failure.mjs` and `merge-quarantine-raise-protect-failure.mjs`
  (measured RED with the ungated snapshot, GREEN at the parent).
- Do not widen this to resolvable losers: their lifts already surface through existing paths and naming them
  would change existing assertions.

## Residuals

- Routes covered (each pinned): by-key, by-path / by-recorded-path (via by-key), and by-id (which builds its own
  `liftedRepoPaths` and appends the losers only when each is gone and no longer blocked by any entry). A loser backed
  by a record that is neither at a live armed key, an `orphanLatchFiles` entry, nor a union-self pending wrapper is
  not found.
- Disclosure is DURABLE-only. When the loser's file survives (an unlink failure, or a route the own-identity gate
  skips), its token is still lifted in-process until the next reboot without being named; `latchKept` is the only
  signal, and a reboot re-arms it from the surviving file (measured by the `unlink-fail-*` scenarios: loser unnamed,
  `latchKept` true, token absent in memory right after the clear, re-armed after a reboot).
- `clear-broad-union`: a loser name not in its `confirmedSet` would trip the existing "UNCONFIRMED DESTRUCTION"
  backstop in `composeBroadUnionClearResult`. That would be a true positive. No reachable shape is known, since
  398f476c stamps the loser for a resolvable winner, and the unstamped provenance-unknown shape was NOT built or
  tested here (untested). Both clear sites share one rule, `unionedLosersLifted`.
- `clear(loser)` stays NOT FOUND; the loser remains unaddressable by its own path.
