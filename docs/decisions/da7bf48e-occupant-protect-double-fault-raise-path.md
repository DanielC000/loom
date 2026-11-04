# da7bf48e — occupant-protect double-fault: the raise-path needed the fix, the clear-path didn't

Card `da7bf48e` (INVESTIGATE-FIRST; re-raised, trace-only, by the `444cd8e2` and `bdb09095` Code Reviews).
Target: `protectOccupantContentBeforeDelete`'s own double-fault branch (merge-quarantine.ts, the
`written.ok === false` branch that keeps a degraded occupant's content self-owned at `finalBasename` and
keeps the stranded tmp from the failed pending-divert write on disk, per `59e758e5`'s "never unlink
without proof the content is secured elsewhere").

## Outcome

The full investigation, both fixes, and their verification are recorded in
`docs/decisions/8d80b736-stranded-tmp-orphan-tracking.md`'s own "Round 3" and "Round 4" sections — that
record had already ruled this exact site "CONFIRMED SAFE" and this card's own job was to re-check that
ruling, not to re-derive it from scratch. Short version:

- **Clear-path (scenario `cp`): CONFIRMED SAFE, no fix needed** — `deleteMergeQuarantineLatchByKey`'s own
  trailing `sweepTmpResidueForHashIfUnreferenced` is content-aware (`f8e11853`) and removes the stray
  within the same synchronous clear call, regardless of whether anything tracks it.
- **Raise-path, double-fault branch (scenario `rp`): NOT safe — fixed (Round 3).** The double-fault
  branch's own `kept` record now tracks `written.strandedTmp`'s own basename in `orphanLatchFiles`, AND
  unions `oldAtFinalBasename`'s own `orphanLatchFiles` forward when `atFinalBasenameSameIdentity` — needed
  because `resolveRaiseOverwrite` can call this same function a second, redundant time for the same
  identity on the raise path, and without that union the second call's own slot-overwrite silently drops
  the first call's own tracked stray.
- **Raise-path, SUCCESS branches (scenarios `v1`/`v6`/`v3`): ALSO NOT safe — fixed separately (Round 4,
  Code Review finding M1).** A LATER protect call for the same identity that SUCCEEDS (a transient fault's
  own retry, or a genuinely separate later raise) replaces the slot with `written.entry`, built from
  `toWrite` alone — Round 3's own fix never reached this path, since it only touched the double-fault
  branch's own `kept` record. Fixed by carrying the replaced slot's own `orphanLatchFiles` forward into
  `toWrite` BEFORE the write. Round 3's own self-healing-reader-trap note mischaracterised this exact
  mechanism as a test artifact — see Round 4's own correction.

Test: `merge-quarantine-da7bf48e-occupant-protect-double-fault.mjs` — `cp`/`rp` (Round 3) plus `v1`
(transient fault), `v6` (persistent fault then a separate later raise), `v3` (partial clear → reboot →
clear → reboot) (Round 4). Each new scenario negative-controlled against both `fda21b05` and the
pre-Round-4 tip (`4bca8b30`): RED, GREEN after, tree restored byte-identical.

- **Round 5 (2nd Code Review M1): the SUCCESS branches' own carry-forward (Round 4) included a stale
  `finalBasename` self-reference.** Fixed by excluding `finalBasename` from the `toWrite` carry's union
  specifically (`kept`'s own carry, which self-references it on purpose, is untouched). `v1`/`v6` now
  additionally assert, after X's full clear, that the raiser (teamA/W) is never named in
  `referencingRepoPaths`/`stillBlockedCoOccupants`, `latchKept` is never set for its file, and it stays
  blocked in-process and after a reboot with its latch file surviving on disk. Full mechanism:
  `8d80b736-stranded-tmp-orphan-tracking.md`'s own "Round 5" section.

## Do not

- Do not regress scenario `rp` to the simpler shape where the degraded occupant shares its own enclosing
  repo's NATURAL canonical key — that shape never reaches `protectOccupantContentBeforeDelete` at all
  (`unincorporatedOccupantRepoPathAt`'s same-identity check returns "none" there). The genuine repro needs
  decision `e0192ffb`'s own fixture shape instead: a foreign, pure-pending occupant sitting at a key that
  `existing` — a DIFFERENT, just-graduated identity — does not share.
- Do not scope a rename-failure injection in this test to a bare `"pending-"` prefix — it also faults the
  unrelated raiser's own divert mint and produces a confusing triple fault. Scope it to the occupant's own
  EXACT pending-divert mint basename (mirror the unexported `pendingDivertFilenameFor`: sha256 of the
  realpath'd, win32-lowercased identity, first 24 hex, `pending-<hash>.json`).
- Do not assert "still blocked" via `activeMergeQuarantineFor` anywhere in this test, and do not add an
  intervening `activeMergeQuarantineFor` read between the raise and the clear in scenario `rp` — it lazily
  re-resolves/rewrites the occupant's record as a side effect of being merely queried, silently discarding
  the tracking the fix just added before the test's own real assertions run (this is what made an earlier
  version of this test "fail" against already-fixed code). Use the pure, non-mutating `stillBlockedEntryFor`
  for every "still blocked" check instead.
- Do not treat this record as the mechanism's source of truth — it is the test's own scope/guard record;
  the fix's full mechanism, the self-healing-reader-trap correction, and the negative-control detail live
  in `8d80b736-stranded-tmp-orphan-tracking.md`'s "Round 3"/"Round 4" sections. Update both if either
  narrative changes.
- Do not assume `v1`/`v6`/`v3`'s own fault-injection scoping differs from `rp`'s — the same "exact
  pending-divert mint basename, never a bare prefix" rule above applies to every scenario in this file.
