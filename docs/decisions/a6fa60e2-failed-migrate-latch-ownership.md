# a6fa60e2 — a failed-migrate quarantine latch's old filename must be tracked as owned, or a raw clear-by-id deletes its only durable copy

From Code Review `d37fd1aa` of `9cabd143` (pre-existing defect; the old code did a plain unlink here too,
before `9cabd143` routed it through the shared `sweepOrphanLatchFileIfUnreferenced` helper).

## The bug

In `reenterMergeQuarantinesAtBoot`'s PASS 1, when a successfully-parsed latch is filed under a STALE key
(`freshHash !== hash`) and the path currently resolves, PASS 1 attempts to MIGRATE it: write the same
content under the fresh key's path, then delete the old file `f` once that write succeeds
(`deleteSourceLatchIfSuperseded`).

When that migrate write FAILS (disk full, permissions, a transient EACCES/EMFILE), the entry is still
armed in-memory under the fresh key (`currentKey`) — the quarantine takes effect for this process either
way — but its ONLY durable copy stays at the OLD filename `f`. That filename is not the hash of
`currentKey` (that's the whole reason this is "stale"), and it is not `quarantinePathFor(entry.repoPath)`
either (which also resolves to the fresh key's hash). So `physicalOwnerRepoPaths` — the "does any live
entry currently own this filename" check every sweep/clear-by-id path relies on — does not recognize `f`
as belonging to this entry at all.

A raw clear-by-id of `f`'s hash (the exact id the boot-time error log names when the migrate write fails)
therefore falls through `clearMergeQuarantineLatchFile`'s active/pending match loops (neither matches: the
entry is armed under `currentKey`, not `f`'s hash) into the "no in-memory entry matches this id" fallback,
which calls `sweepOrphanLatchFileIfUnreferenced('<f>')`. With nothing referencing `f`, that function
deletes it outright and reports `wasQuarantined: false` with no `latchKept` — a clean-looking result that
actually just destroyed the quarantine's only durable record. The in-memory entry stays active for the
rest of this process's life, so nothing looks wrong until the NEXT restart: PASS 1 has no file left to
re-arm the quarantine from, and the repo comes back up unquarantined — a silent fail-open.

## The fix

PASS 1's failed-migrate branch folds `f` into the entry's own `orphanLatchFiles` — the same
owner-bookkeeping field this module already uses elsewhere for "a filename a live entry still needs, even
though it isn't the entry's current physical write target" (see PASS 2's orphan-reference fan-out, and
`quarantineAllRegisteredFailClosed`'s own tagging). `sweepOrphanLatchFileIfUnreferenced`'s check (1) (an
entry's own `orphanLatchFiles` still lists this filename) then keeps `f` alive against a raw clear-by-id,
while a LEGITIMATE clear of the entry itself still sweeps it: `clearMergeQuarantineByKey` folds
`orphanLatchFiles` into `orphanFilesToSweep` and sweeps each one once the entry is actually removed from
`activeQuarantines`.

## A second consequence this same fix closes (Code Review `4d619c1f` round 2)

The SAME gap also broke a LEGITIMATE clear, not just a raw clear-by-id. Before this fix,
`orphanLatchFiles` never named `f`, so `clearMergeQuarantine`/`clearMergeQuarantineByKey`'s own orphan
sweep (`orphanFilesToSweep = new Set(entry?.orphanLatchFiles ?? [])`) was always EMPTY for an entry stuck
in this state — a human (or `confirmWorkerMerge`'s own auto-clear) calling `clearMergeQuarantine(repoPath)`
lifted the entry from memory and deleted the FRESH-key file (which was never written), but never touched
`f` at all. `f` survived on disk, still bearing its own stale-key hash. A FRESH BOOT then re-read `f` as
if nothing had ever been cleared and RE-ARMED the quarantine — a quarantine a human genuinely cleared came
back after the next restart. Folding `f` into `orphanLatchFiles` fixes this the same way: a legitimate
clear's own sweep now actually reaches and deletes `f`, so a fresh boot has nothing left to resurrect
from. Covered by the RESURRECTION-ON-LEGITIMATE-CLEAR scenario in
`merge-quarantine-failed-migrate-latch-owner.mjs`.

## The dangling-reference follow-up (Code Review `4d619c1f` round 2)

Folding `f` into `orphanLatchFiles` created a NEW, narrower gap: PASS 1's SUCCESSFUL-migrate branch
deletes `f` from disk (`deleteSourceLatchIfSuperseded`) but, pre-round-2, never removed `f` from
`entry.orphanLatchFiles` — an entry that had previously picked up `orphanLatchFiles: [f]` (e.g. a failed
migrate attempt that later succeeded in the same process) kept listing a now-nonexistent file forever.
`sweepOrphanLatchFileIfUnreferenced`'s check (1) reads this field literally, so that dangling reference
would falsely "protect" (`latchKept: true`) ANY future, unrelated file that happened to reuse the name
`f` — a real file that should be deletable would be reported as kept, attributed to an entry that no
longer needs it. Fixed by stripping `f` from `entry.orphanLatchFiles` BEFORE the migrate write is
attempted: on success, `f` is never persisted/armed as a needed reference; on failure, the existing
failed-migrate branch re-adds it (the genuinely-still-needed case). Covered by the
DANGLING-ORPHAN-STRIPPED-ON-SUCCESSFUL-MIGRATE scenario in the same test file.

## Do not

- Do not gate this fix on `writeMergeQuarantineLatch`'s return value alone without also updating `entry`
  BEFORE it is armed into `byRepoKey` below (the same `entry` variable PASS 1 threads through
  `armQuarantineKey`) — arming the pre-mutation object silently drops the bookkeeping.
- Do not reach for `physicalOwnerRepoPaths`/check (2) to solve this instead — that check is deliberately
  keyed on an entry's CURRENT armed keys and its TRUE write target (`quarantinePathFor`), recomputed
  fresh; `f` is neither, by construction (that's the entire reason PASS 1 is migrating away from it), so
  it can never be made to pass check (2) without breaking that check's own contract for every other caller
  (see `physicalOwnerRepoPaths`'s own doc comment).
- The PASS 1b `.json.tmp-<pid>` tmp-residue analogue of this gap (and the SEPARATE lazy-graduation code
  path in `activeMergeQuarantineFor`, which this card never touched at all) was confirmed real and fixed
  by card `be79f4d5` — see docs/decisions/be79f4d5-lazy-graduation-source-latch-ownership.md. Do not
  re-derive that analysis from scratch; read it there.
- Do not write a test for this that calls the real `enterMergeQuarantine(` to manufacture the stale-key
  latch — the stale-key shape only exists for a pre-upgrade/legacy-keyed file, which must be manufactured
  by hand (see `merge-quarantine-key-migration.mjs`'s own technique) the same way this card's own test
  (`merge-quarantine-failed-migrate-latch-owner.mjs`) does.
- Do not strip `f` from `entry.orphanLatchFiles` AFTER the `writeMergeQuarantineLatch` call, and do not
  skip re-adding it in the failure branch — the strip must happen BEFORE the write attempt (so a
  successful write never persists/arms the dangling name) and the failure branch's existing fold-in must
  stay, or a migrate that fails after a prior successful strip loses the only-durable-copy protection this
  card exists for in the first place.
