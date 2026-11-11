# 5fa6069e: a third raise that merges a twin and an independent pending unlinks the absorbed, unowned file

From CR 3439677b on 64283e06. After a reboot a boot-diverted twin (armed at `Ks`, also pending) and an
independent same-identity pending entry are a real shape. A third unverified raise matches BOTH in
`mergeTokenIntoPendingEntries`, which merges them into the earliest entry's file and, pre-fix, left the
absorbed entry's own file on disk (referenced only through `orphanLatchFiles`). The next boot re-read it as a
second object with overlapping tokens: `assertQuarantineIdentityInvariantTestOnly` `ok:false`, 2 distinct objects.
Fails closed (over-blocks), never lifts.

## What was measured (main 816d59e2, probe through the real `enterMergeQuarantine`, unresolvable repoPath)

- Twin OLDER (it is the base; absorbed file `pending-<hash>.json`, unowned): in-process state correct,
  stale `pending-*.json` [tok-B] stays, reboot gives 2 objects, invariant `ok:false`. Reproduced.
- Pending OLDER (it is the base; absorbed file is the twin's own armed-key file `Ks.json`): in-process the
  active object has `armedKeys` (1) and `resolvedKey` (Ks). The card's "armedKeys/resolvedKey undefined" claim
  does NOT reproduce on main (the 3d27c045 / 00fd29d7 unions fixed it). Reboot invariant `ok:true`.

## Decision

Only the `written.ok` branch of `mergeTokenIntoPendingEntries` changes: each absorbed `others` file goes
through `sweepAbsorbedPendingFile`, which first proves the content (readable record, same identity, every
on-disk token in `merged.tokens`; anything unprovable keeps the file) and then calls
`sweepOwnLatchFileUnlessOwnedElsewhere` with NO `candidateTokens`. Failed unlink: `console.warn`.

## Named, accepted residue

In the pending-older ordering the leftover `Ks.json` is the active entry's own armed-key latch, so it is owned
and kept (9cabd143). It holds a stale subset (tok-A), fails closed, and re-unions with the merged pending
record at the next boot (invariant `ok:true`, `armedKeys`/`resolvedKey` retained). "Exactly one durable
record" therefore holds only where the absorbed file is unowned. Rewriting the armed key's file would be a
larger change through `writeLatchAndAdopt` and is not done here.

A second, also accepted, residue: the merged entry's `orphanLatchFiles` still names the unlinked file, so the
next boot logs the "known residual (card 5669cb78)" dangling-reference warning once per boot.

## Do not

- Do not replace the sweep with a bare `fs.unlinkSync`: the twin's own armed-key file (owned) would be deleted
  (9cabd143), and the pending-older check in the test goes red.
- Do not pass `candidateTokens` to the sweep, to keep the call on its narrowest contract. Measured: the
  pending-older `Ks.json` is kept either way (`activeOwnerClaimIsSettledByCoverage` refuses an owner's own
  record); omitting `candidateTokens` additionally means a kept-marked file (`keptUnreadableLatchFiles`) can
  never be coverage-settled, which is what the kept-marked control pins.
- Do not drop the content precondition: a foreign-identity occupant, a file holding a token the merge does
  not carry, or a file holding the fresh raise's own token (only the merged record can) must be kept
  (the degraded-occupant class, c9114934). A non-ENOENT read failure keeps the file too (63e49ee2).
- Do not compare filenames byte-exactly on win32: a case-variant of the merged record's own file is that file.
- Do not sweep in the write-failure / safety-tmp branches: the absorbed file may be the only durable copy.

## Not covered (probed, did not reproduce a stale absorbed file)

- `consumeMatchedPendingsIntoArmedEntry` (resolvable raise over twin + independent pending): one durable
  file after the raise and after reboot, invariant `ok`, both orderings.
- The `survivingSharedClaimRepoPaths` early return (a placeholder claimant sharing the base file): the merge is
  diverted; the shared base file stays for its claimant, the other file holds the merged record, reboot
  invariant `ok`.

Tests: `packages/daemon/test/merge-quarantine-5fa6069e-third-raise-absorbed-file.mjs`.
