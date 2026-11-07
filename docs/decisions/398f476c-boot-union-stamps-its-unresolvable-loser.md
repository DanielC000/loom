# 398f476c — a boot cross-identity union stamps its unresolvable loser as a contributor

## The shape

A degraded, unresolvable `X` (resolvedKey `Kx`, its own latch file at `sha(Kx).json`) plus an OLDER stale-named
resolvable `S` that migrates onto `Kx`. `S` wins `unionQuarantineEntries`'s tie-break, so the in-memory union
carries both tokens under `S`'s identity. Boot never writes that union (the degraded-occupied key is refused), so
`X`'s file and `S`'s stale file both stay on disk.

Before this card: `activeMergeQuarantineFor(X)` was `undefined`, `clearMergeQuarantine(X)` was NOT FOUND, `X` had no
latch id, and `clearMergeQuarantine(S)` silently lifted `X`'s token and deleted `X`'s file (in memory and on disk,
so a reboot reintroduced nothing). Enforcement never failed open on its own; the surprise was the undisclosed
over-lift on a human clear. The persistence half (a runtime write clobbering `X`'s file) was closed earlier by
`e1cb7d33`.

## The fix

`armQuarantineKey` stamps every LOSING identity into the union's `contributorRepoPaths` when the winner is
currently resolvable and the loser is not. The stamp is RE-DERIVED on every boot at a degraded-occupied key, from the
two source files (X's file keeps no such field); if a later write persists the union, the writer carries
`contributorRepoPaths` forward from both sides. Boot-written is not reached in the shapes tried (X at `sha(Kx).json`,
and X under a legacy file name, both with resolvedKey `Kx`): boot refuses to write a degraded-occupied key either way,
pinned by `legacy-named-x-no-boot-write-disclosed-lift`. The existing contributor machinery then takes over:
clear-by-path of the winner is refused, naming `X`; clear-by-id fails closed; `clear-broad-union` is the
confirm-first human escape.

The refusal predicate: `selfClearRefusesForStaleKeyContributors` only fired for a LEGACY winner (no `identityAtRaise`)
or a nested one. A MODERN winner (`identityAtRaise` equal to the union key, `genuineContributorKeys: []`) slipped
through and still over-lifted, and `clear-broad-union` then said "does not match any union". A new first arm fires
when a contributor's own latch file physically occupies a live armed key (`bootUnionOccupantContributors`). Stamping
`genuineContributorKeys` instead was tried and dropped: an absent array (a legacy X) stays absent through the
absorbing union, so it never fires, and replacing absence with `[key]` would narrow the legacy broad refusal.

Supporting changes:
- `broadUnionTargetFor` no longer treats boot's own self-reference as a "tied pending twin": the pending ref that is
  the union object itself, or a ref to one of the union's own `orphanLatchFiles` that adds no tokens/contributors.
  Without this the route named by the refusal would itself refuse in exactly this shape.
- `refuseSelfClearStaleKeyContributors` names a contributor whose own latch file occupies the key ("unioned with")
  instead of the generic "raised before Loom recorded a raise-time identity" wording. The wording is neutral because
  the stamp also fires on the runtime kept-file arming path (`armSecondaryKeys`), not only at boot.

## Do not

- Do not stamp when the union's winner is UNRESOLVABLE. Measured two ways: (a) with a resolvable loser (X-older
  order) `clear(x)` refused where it used to lift only `x` and keep `S` pending; (b) with an unresolvable loser too,
  removing the winner guard turns `clear(winner)` into a refusal and turns
  `d2582692-clearing-union-winner-keeps-loser-pending` (`merge-quarantine-pass1-degraded-union-guard.mjs`) RED.
  The x-older and pure-pending controls must stay byte-identical;
  `merge-quarantine-398f476c-boot-union-contributor-stamp.mjs` pins them.
- Do not stamp a `provenanceUnknown` union. Measured: in `merge-quarantine-e7652e06-boot-freshness-discriminator.mjs`
  case 4 (resolvable winner x, unresolvable z, union already marked) a stamp made `clear-by-path(x)` refuse while
  `clear-broad-union` also refuses for unknown provenance, stranding the human at a manual file delete. That union's
  clear already carries its own disclosure; that test pins the exclusion.
- Do not stamp for a same-`directPathIdentity` union (twins, path aliases): that is not a cross-identity union.
- Do not persist the stamp onto a degraded occupant's file to "make it stick": that file is X's own record.
- Do not add the benign-reference exemption for any pending ref that carries its own tokens, contributors or
  provenance gap; only the union object itself or an `orphanLatchFiles` ref adding nothing is exempt.

## Residuals

- The tail of `remediationTextFor` still says a contributor was folded in "at runtime" for a boot union.
- The unresolvable-winner order is unchanged: `clear(S)` there reports still-quarantined and `clear(x)` lifts the
  union (measured baseline, identical with and without the stamp).
- Two unresolvable `.json` identities sharing one key (no resolvable side): `clear(winner)` lifts the WHOLE union,
  loser included (measured baseline, pinned by `both-unresolvable-no-stamp`). Not changed here.
- The contributor-occupant refusal arm needs X's own latch file to be readable at a live key. If that file is corrupt
  or missing (outside damage), the arm fails open back to the pre-fix lift, which still names X in
  `liftedRepoPaths`. Accepted, no code change. The arm is also gated off for a `provenanceUnknown` union, whose
  `clear-broad-union` route refuses, so the human keeps the disclosed lift instead of only a manual delete.
- X under a legacy file name with a modern S: `clear(S)` is not refused but names X in `liftedRepoPaths`.
