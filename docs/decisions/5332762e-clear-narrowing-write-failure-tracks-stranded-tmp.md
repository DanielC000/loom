# 5332762e — `clearTokenFromPendingIndices`' own reduce-branch write-failure also tracks its stranded tmp

Found by the `59e758e5` CR round 2 (reviewer `6aee1d61`, probe9 L2), named as a CONFIRMED, OPEN gap by
card `8d80b736`'s own "Scope" section (which fixed the analogous shape at the 3 RAISE callers only, and
deliberately left this reduce-branch write-failure site to this follow-up card rather than widening its
own scope without a Lead ruling).

## The bug

`clearTokenFromPendingIndices`'s own reduce branch calls `writePendingDivertFile(live.sourceFile, updated,
new Set([token]), true)` to durably narrow a pending entry after a partial by-token clear. When that
write's own rename fails (e.g. EPERM), `writePendingDivertFile` returns `{ok:false, strandedTmp}` — the
tmp it already wrote (holding the correctly-narrowed, pre-fail token set) survives on disk, per decision
`59e758e5`'s own "never unlink" rule. Unlike the 3 raise callers' own triple-fault "keep" branches (card
`8d80b736`), this write-failure branch never referenced `written.strandedTmp` anywhere — so a LATER,
successful clear of the remaining token(s) sweeps/narrows only whatever `live.sourceFile` names, leaving
the untracked tmp's own stale (pre-later-clear) content on disk, unreferenced and unswept.

Reproduced hermetically (`merge-quarantine-5332762e-clear-narrowing-tmp-loss.mjs`, Scenario A): raise
t1, t2, t3 for an unresolvable repo. Clear t1 with the rename forced to EPERM — the stranded tmp holds
[t2,t3] (by content), untracked. Clear t2 and t3 cleanly — in-process `stillBlockedEntryFor` reports
`undefined`, and the primary pending-divert file is swept, but the untracked tmp survives untouched. A
real reboot (fresh module re-import + `reenterMergeQuarantinesAtBoot`) then re-arms the untouched tmp as
a fail-CLOSED **duplicate** pending entry (the same resurrection mechanism as `8d80b736`):
`stillBlockedEntryFor` comes back non-`undefined`, naming both t2 and t3 — two durably-cleared tokens
resurrected after a clean-looking full lift.

## Fix

At the `else` (write-failure) branch, when `written.strandedTmp` is truthy, track
`path.basename(written.strandedTmp)` into the entry's own `orphanLatchFiles` (Set-deduped, mirroring the
established pattern), route it through `replaceEntryEverywhere(activeQuarantines, updated,
withStrandedTmp)` (so a dual-tracked twin stays one object, never split — the exact regression `8d80b736`
Round 2 found in its own first draft), and reassign `updated`/`live.entry` to the tracked object.

No new sweep/narrowing logic was needed, for the same reason `8d80b736`'s own record gives: this module's
existing `orphanLatchFiles`-aware machinery already handles a `.json.tmp-`-shaped filename correctly. With
the tmp now referenced, a LATER partial clear's own `rewriteOrphanLatchFilesAfterPartialClear` durably
narrows it in place, and a LATER full lift's own `sweepOrphanLatchFilesUnioned` deletes it once every
on-disk token is accounted for — closing the resurrection gap.

## Ordering: track AFTER, never before, this same call's own `rewriteOrphanLatchFilesAfterPartialClear`

This is the one place this card's fix does not blindly copy `8d80b736`'s own 3-site shape verbatim.
`rewriteOrphanLatchFilesAfterPartialClear(updated, writtenBasenames, new Set([token]))` is called
immediately above the tracking, in the SAME write-failure branch, and it walks `updated.orphanLatchFiles`
to durably narrow every entry it finds there.

If the stranded tmp were tracked into `orphanLatchFiles` BEFORE that call ran (in this same branch, same
call to `clearTokenFromPendingIndices`), the helper's own loop would immediately attempt to re-narrow the
tmp THIS SAME call just minted — even though it already holds the correct, narrowed content (the
`writePendingDivertFile` call that failed had already computed and written that exact content to the tmp
before its own rename failed). That redundant rewrite is:

- **A pointless no-op on success** — a fresh second tmp gets created, written with the identical content,
  and renamed over the first tmp's own path; functionally inert, but wasted work and a second gratuitous
  tmp-create-then-rename cycle for no behavioral gain.
- **A newly-introduced instance of card `e1572b69`'s own defect, on the FAILURE path.** If that redundant
  rewrite's own rename ALSO fails (the same host condition that caused the original failure, still
  present), `writePendingDivertFile` is called with an already-`.tmp-`-shaped `orphanFile` as its target —
  producing a DOUBLY-`.tmp-`-suffixed stranded tmp (e.g.
  `pending-<hash>.json.tmp-<pid1>-<hex1>.tmp-<pid2>-<hex2>`) that matches none of this module's own
  residue-recognition regexes (`PENDING_DIVERT_TMP_RE`, `TMP_RESIDUE_FILENAME_RE`, `SAFETY_TMP_RE`) — see
  card `e1572b69` for the full investigation of that shape. Tracking the tmp before calling the helper
  would manufacture exactly that defect as a side effect of THIS fix, inside the very call meant to close
  a different resurrection gap.

Tracking AFTER the helper call avoids both: the helper only ever sees the entry's PRE-EXISTING
`orphanLatchFiles` (never the tmp this same call just minted), and the newly-tracked tmp is left for a
LATER clear's own `rewriteOrphanLatchFilesAfterPartialClear`/`sweepOrphanLatchFilesUnioned` call to
narrow or sweep, exactly as `8d80b736`'s own Scenario A already demonstrates for the analogous raise-site
shape.

**UPDATE (card `e1572b69`):** this ordering rule is now tested — not in this card's own suite, but in
`merge-quarantine-e1572b69-nested-orphan-tmp.mjs`'s Scenario B, via an exact stranded-file-count
assertion. A reorder mutant (track the OUTER write's own stranded tmp BEFORE calling
`rewriteOrphanLatchFilesAfterPartialClear`) no longer produces nested debris on its own — `e1572b69`'s own
fix (b) prevents nesting regardless of ordering — so the test asserts the exact COUNT of newly-stranded
files instead (2 under correct ordering, 3 under the reorder, since the reorder causes one redundant
extra write attempt). See that card's own decision record for the full detail.

## Verification

Mutation-tested: an API-keeping mutant (`false &&` gating the `written.strandedTmp` guard — keeps every
signature and call shape, disables only the tracking) run against the fix turns Scenario A's new
"THE FIX" assertions RED, confirming the tracking itself — not some other incidental change — is what
closes the gap. Negative-controlled via `node scripts/negative-control.mjs --file
packages/daemon/src/git/merge-quarantine.ts --test
packages/daemon/test/merge-quarantine-5332762e-clear-narrowing-tmp-loss.mjs --ref
12bae9dc1a3b778a5333b6f1a2349ce5df790861` (the explicit pre-fix sha, not bare `HEAD` — `HEAD` would
silently no-op once this fix is committed) — RED against that sha, GREEN against the fix, working tree
restored.

## Site B (CLOSED by card `e1572b69`)

`rewriteOrphanLatchFilesAfterPartialClear`'s own per-orphan-file write-failure branch (the sibling site
`8d80b736`'s own record named as "untested") was investigated during this card's checkpoint and DOES
reproduce a real, confirmed defect — but not a resurrection. When the orphan file being narrowed is
itself already `.tmp-`-shaped (the ordinary case once `8d80b736`'s own fix, or this card's, has tracked
one), a failed rewrite there produces a doubly-`.tmp-`-suffixed stranded tmp that matches no residue
regex in this module, so it is NEVER picked up by boot's tmp-recovery pass — it simply leaks forever as
untracked, unrecognized disk debris, contradicting that site's own inline comment ("boot's recovery pass
re-arms it as a duplicate"). Fixed by card `e1572b69` (track the stranded tmp there too, AND stage onto a
clean `.json` base so a stranded name is never nested in the first place) — see that card's own decision
record, `docs/decisions/e1572b69-nested-orphan-tmp-track-and-prevent.md`, including why its own fix also
changed this ordering rule's test coverage (the reorder mutant below no longer produces nesting on its
own, so `e1572b69`'s own test catches it via an exact stranded-file-count assertion instead).

## Do not

- Do not unlink the stranded tmp instead of tracking it. Decision `59e758e5` forbids any non-raise caller
  from unlinking a stranded tmp without proof its content is secured elsewhere — here nothing is: the
  on-disk primary file still holds the STALE, un-narrowed full token set (its own rename never landed).
  Unlinking would discard the only durable copy of the narrowed state and, on reboot, re-arm from the
  stale primary — resurrecting the just-cleared token too, strictly worse than the pre-fix bug.
- Do not track the stranded tmp into `orphanLatchFiles` before calling this same branch's own
  `rewriteOrphanLatchFilesAfterPartialClear` — see "Ordering" above; that order manufactures card
  `e1572b69`'s own defect shape as a side effect of this fix.
- Do not store `written.strandedTmp` itself (an ABSOLUTE path) in `orphanLatchFiles` — always
  `path.basename(written.strandedTmp)`, mirroring every other site in this module that tracks a stranded
  tmp this same way.
- Do not forget `replaceEntryEverywhere` when reassigning to the tracked object — `8d80b736` Round 2 found
  exactly this omission at its own 3 sites, splitting a dual-tracked twin into two same-identity objects.
- Do not fix card `e1572b69`'s own sibling site as part of this card without a separate Lead ruling to
  widen scope — it is a different write site with its own mechanics and a different consequence
  (permanent disk-debris leak, not resurrection), tracked separately.
