# bdb09095 — the foreign-group union's own write failure now tracks its stranded tmp

Found by the `444cd8e2` Code Review, by trace only (not reproduced there). Same missing-tracking defect
class `5332762e`/`444cd8e2`/`8d80b736` already fixed elsewhere — at a SIXTH site neither card's scope
covered: `consumeMatchedPendingsIntoArmedEntry`'s own `foreignGroups` `group.length > 1` arm
(merge-quarantine.ts, the `writePendingDivertFile(base.sourceFile, foreignUnion, new Set())` call inside
the raise-divert branch).

## The bug

When that write fails, `written.strandedTmp` (holding the full `foreignUnion`) was kept on disk — correct,
per `59e758e5`'s "never unlink without proof the content is secured elsewhere" rule — but never referenced
in `foreignUnion.orphanLatchFiles`. A later, fully legitimate in-process full lift of every outstanding
token for the identity (including a cross-tier sibling's own fresh raise token, card `8a1bc2ef`) swept only
the tracked `sourceFile`; the untracked stranded tmp survived on disk, untouched.

Reproduced hermetically, by content, across a real reboot (reused `67136b71`'s own TOP/F/twin setup;
forced `writePendingDivertFile`'s rename to fail only for the foreign-group's own write, leaving the
raiser's own divert write to succeed normally):

- When the group's `base` (earliest `enteredAt`) happens to share a `canonicalRepoLockKey`-derived hash
  with something a later full lift separately deletes at that same hash, an unrelated, hash-keyed sweep
  (`sweepTmpResidueForHashIfUnreferenced`) incidentally also removes the stray — coincidental, not a fix,
  and not the general case (`base` is picked purely by oldest `enteredAt`, never by name shape).
- When `base` is instead a label-named pending record with no identity-hash tie (e.g. a prior raise's own
  `legacy-…json` fallback name), the stranded tmp survives the full lift and a real reboot. PASS 1b's
  tmp-recovery pass re-arms it — logged verbatim as "recovered a torn-write quarantine latch … re-armed
  as the full union" — wrongly RE-BLOCKING the repo by tokens the user had already fully cleared.
- Worse: the untracked stray also interacts with `d2592cd5`. The full-identity-clear path's bare
  `identityHasAnyPhysicalRecordOnDisk` check (no `excludeBasenames`, by that card's own design for a FULL
  clear) finds the stray's physical bytes and withholds the durable tombstone for the WHOLE identity, not
  only the tokens physically inside the stray — a token never present in the stray (`fb` in the repro) is
  ALSO never durably tombstoned, so the reboot resurrects every token for the identity, not just the ones
  the stray itself carried.
- Never fail-open in either ordering: no cleared token ever unblocks a repo it shouldn't.

## The fix

At the `written.ok === false` branch, when `written.strandedTmp` is truthy: build a new `foreignUnion`
with `path.basename(written.strandedTmp)` added to `orphanLatchFiles` (Set-deduped, mirroring
`5332762e`/`444cd8e2`), `replaceEntryEverywhere(activeQuarantines, <old foreignUnion>, <updated
foreignUnion>)` for the group (the loop just above this write already re-pointed every group member to
the ORIGINAL `foreignUnion` object — `67136b71`'s own fix — so a second re-point is needed once the object
identity changes again here), then reassign the local `foreignUnion` binding before the push. No new
sweep/narrowing logic needed — existing `orphanLatchFiles`-aware sweep machinery (the same machinery
`444cd8e2`'s own fix relies on) already handles a `.json.tmp-` name once referenced, and the exclusion set
`identityHasAnyPhysicalRecordHoldingToken` builds from `trackedBasenamesForIdentity` will now also account
for it at the partial-clear sites that use that token-aware check.

The misleading comment ("Keep the stranded tmp; boot's own tmp-recovery pass re-arms it as a fail-closed
duplicate" — true as mechanism, silent on the real consequence, resurrection) was corrected to say the tmp
is now tracked and boot recovery is a backstop only, mirroring `444cd8e2`'s own comment fix at its two
sites.

## Compatibility with `59e758e5`

`59e758e5`'s own "Do not" list forbids UNLINKING a stranded tmp at any non-raise site without proof its
content is secured elsewhere — it says nothing about TRACKING a basename into `orphanLatchFiles`, and
`444cd8e2`'s own fix (the established pattern this card follows) explicitly keeps `59e758e5`'s "never
unlink" rule in force while adding tracking at its own two sites. This card does the same: the tmp is
never unlinked here, only referenced, so a later clear's own content-checked sweep decides — by content,
at that later time — whether it is genuinely safe to remove.

## Verification

- `merge-quarantine-bdb09095-foreign-group-union-tmp-tracking.mjs`: both `base`-ordering scenarios (the
  coincidental-hash-sweep case and the label-named/legacy-base case that strands pre-fix), asserting by
  content: no stray tmp remains on disk after the full lift, `listActiveMergeQuarantines()` shows the
  identity unblocked after a real reboot, and the durable tombstone sidecar records every one of the
  identity's tokens (including one never physically present in the stray) after the full lift.
- Negative-controlled (`node packages/daemon/scripts/negative-control.mjs --file
  packages/daemon/src/git/merge-quarantine.ts --test packages/daemon/test/merge-quarantine-bdb09095-
  foreign-group-union-tmp-tracking.mjs --ref 497b443f`): RED against that pre-fix sha, GREEN after,
  working tree restored byte-identical.
- API-keeping mutant (skip the `orphanLatchFiles` add, keep the push unchanged): turns the new test's own
  "no stray tmp remains"/"unblocked after reboot"/"tombstone records every token" assertions RED; reverted
  byte-identical.
- Full named regression sweep: `5332762e`, `444cd8e2`, `8d80b736`, `e1572b69`, all `59e758e5` files,
  `67136b71`, `d2592cd5`, `merge-quarantine-boot-hardening.mjs` — green, both env states where applicable.
  `guards` + the lesson-299 named list — green.

## Round 2 (card `da7bf48e`'s own triage note) — the 2nd `replaceEntryEverywhere` (~L2976) is already behaviorally pinned, not merely structural

Card `da7bf48e`'s handoff flagged this call as "pinned only STRUCTURALLY (a mutant that skips it leaves
every end-state green)" and asked for a behavioral case or this note. Checked directly, 2026-11-04: an
API-keeping mutant that skips ONLY this `replaceEntryEverywhere` call (keeps building
`trackedForeignUnion` and keeps `foreignUnion = trackedForeignUnion`, so the PENDING push still carries
the tracked object) turns `merge-quarantine-bdb09095-foreign-group-union-tmp-tracking.mjs`'s own
pre-existing "*** THE FIX (${tag}) *** the in-memory record now TRACKS the stranded tmp's basename in
orphanLatchFiles" check RED, for both the `hash` and `legacy` tags — restored byte-identical, GREEN after.

That check reads `activeMergeQuarantineFor(sF)` (S_F's own degraded key) right after the raise, before any
clear. Because `direct` at that key is the group's own `foreignUnion`/`trackedForeignUnion` object (re-
pointed there by the `group.length > 1` loop just above this write, `67136b71`'s own fix) and
`isKeyVerifiedFor(f, KsF)` is false (F is now resolvable at a DIFFERENT real key), `activeMergeQuarantineFor`
returns `direct` as-is rather than self-healing through `pendingUnresolvedQuarantines` — so skipping the
`replaceEntryEverywhere` call genuinely leaves the ACTIVE slot stale and untracked, exactly as this fix's
own commit message describes. The predecessor's observation about the FULL-LIFT END-STATE checks (no
stray tmp on disk, unblocked after reboot, every token tombstoned) staying green under this same mutant is
correct — those are reached via `f`'s own identity, which the mutant leaves correctly tracked on the
PENDING copy — but "end-state checks stay green" is not the same claim as "no check pins it," and the
in-process check above already does. No new test was added; this round corrects the record instead.

## Do not

- Do not unlink the stranded tmp here — `59e758e5` forbids unlinking without proof content is secured
  elsewhere; here nothing is. Tracking is the only change; the tmp itself stays on disk until a later,
  content-checked sweep decides it is safe to remove.
- Do not store `written.strandedTmp` itself (an absolute path) in `orphanLatchFiles` — always
  `path.basename(written.strandedTmp)`.
- Do not skip the second `replaceEntryEverywhere` call on the grounds that the loop above already
  re-pointed the group — that earlier call re-points to the ORIGINAL `foreignUnion` object; once tracking
  produces a NEW object, every group member must be re-pointed again or a dual-tracked twin splits.
- Do not widen this fix to also change the FULL-identity-clear sites' own bare
  `identityHasAnyPhysicalRecordOnDisk` check into a token-aware one — that is `d2592cd5`'s own documented,
  deliberate design for a full clear (nothing should legitimately remain on disk afterward); this card
  only removes the stray that made that premise false in this one shape.
