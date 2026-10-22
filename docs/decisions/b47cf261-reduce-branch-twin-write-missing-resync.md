# b47cf261 — `clearMergeQuarantineByKey`'s tied-twin "reduce" branch was missing the twin resync after its own `writePendingDivertFile` call

Flagged by Code Reviewer `cea0cede`'s review of `2dd97aaa` as a QUESTION, not yet probed. Investigated
firsthand (required checkpoint, before any edit) and confirmed real by direct source reading, before this
card's own fix was written.

## The bug

In `clearMergeQuarantineByKey`'s tied-twin "reduce" branch (`packages/daemon/src/git/merge-quarantine.ts`),
after `replaceEntryEverywhere(activeQuarantines, p.entry, updated)` re-points every in-memory reference
(including `p.entry` itself, since `p` is the live `pendingUnresolvedQuarantines` element) to `updated`,
the branch calls `writePendingDivertFile(p.sourceFile, updated, ...)`. That call's own stale-mark
re-read-and-union branch (`keptUnreadableLatchFiles.has(filename)` + a matching-identity reread) ALWAYS
returns a freshly-constructed object via `unionIntoOnDiskPendingEntry` → `unionQuarantineEntries`'s own
object spread — provably `!== updated` whenever that branch fires, by construction. The code then did:

```ts
if (writtenTwin) {
  p.entry = writtenTwin.entry;
  p.sourceFile = writtenTwin.filename;
}
```

— a hand-rolled partial update of the PENDING side alone. `activeQuarantines`'s slot(s) for this twin's
own armed key(s) were never told about the new object; they stayed pointing at the now-stale `updated`.
This breaks `64283e06`'s by-value twin invariant: the SAME logical twin is now represented by two
non-reference-equal, non-disjoint-token objects, one on each side.

The sibling function `clearTokenFromPendingIndices` already has the correct shape at its own identical
write (`merge-quarantine.ts` ~:3567): `if (written.entry !== updated) replaceEntryEverywhere(activeQuarantines,
updated, written.entry);` before the same kind of hand assignment. The reduce branch above never had this
guard — the exact "Do not" `64283e06` already states ("Do not rewrite only the pending side of a
merge/split at a site that can reach an `883e29bc` twin — route every entry being replaced through
`replaceEntryEverywhere`, never a hand-rolled partial update") applied to a site that rule's own author
did not yet know existed.

## Reachability

The stale-mark precondition is realistic, not contrived — the reduce branch's own pre-existing comment
(right above this call) already anticipated it: "a stale on-disk copy of this twin can hold OTHER tokens
of `entry` already dropped from `p.entry.tokens` in memory by an **earlier reduce whose write failed**."
It is the identical chokepoint cards `535fd69d`/`58957b1e` already exploited via the exported
`markLatchFileUnreadableTestOnly` test-only helper to reproduce the sibling bugs at this same write.

## Observable consequence

Once the two sides diverge: `listActiveMergeQuarantines()` (a reference-deduped `Set` union of
`activeQuarantines.values()` and `pendingUnresolvedQuarantines.map(p => p.entry)`) reports the SAME
logical identity TWICE — once via the stale `updated` (missing whatever the union pulled in from disk),
once via the correctly-written object — instead of once. `assertQuarantineIdentityInvariantTestOnly`
flags this directly: two non-reference-equal objects for one identity whose token sets are NOT disjoint
is exactly the violation shape it exists to catch (`64283e06`'s own 2-object rule requires either a
genuine reference twin, or two fully independent objects with disjoint tokens — this shape is neither).
The divergence does not self-heal in-process; it self-heals only across a reboot, since the durable
WRITE itself succeeded and boot re-derives fresh from disk.

## The fix

Mirror `clearTokenFromPendingIndices`'s own guard exactly, one line, right before the existing hand
assignment:

```ts
if (writtenTwin.entry !== updated) replaceEntryEverywhere(activeQuarantines, updated, writtenTwin.entry);
p.entry = writtenTwin.entry;
p.sourceFile = writtenTwin.filename;
```

`replaceEntryEverywhere` already re-syncs BOTH `activeQuarantines` and `pendingUnresolvedQuarantines` (it
scans both for `=== oldEntry`), so the subsequent `p.entry = writtenTwin.entry` becomes redundant-but-
harmless after this line runs — same shape the sibling keeps at its own equivalent site.

## Do not

- Do not hand-roll a partial update of only one side (`p.entry =` / a bare map `.set()`) at ANY site in
  this module that can reach a reference-twin — route every replacement through `replaceEntryEverywhere`.
  This is the SAME rule `64283e06`/`fd189d91` already state; this card is a case neither of those authors
  had yet found.
- Do not assume `writePendingDivertFile`'s return is reference-equal to its own `entry` input just
  because the ordinary (non-stale-mark) path happens to return it unchanged — the union/collision
  branches ALWAYS construct a fresh object; any caller using the return value must compare it against
  what it passed in before relying on reference identity elsewhere.

## Verification

`test/merge-quarantine-b47cf261-reduce-branch-twin-resync.mjs` — one scenario: a genuine reference twin
(armed in `activeQuarantines` at its own key via `setActiveQuarantineTestOnly`, and the SAME object
present in `pendingUnresolvedQuarantines` via `reenterMergeQuarantinesAtBootTestOnly`'s injection seam),
tied to the entry being cleared via an orphan-file reference (not a key overlap, to keep the twin's own
arming key independent and directly inspectable). The twin's own on-disk backing file is marked
`keptUnreadableLatchFiles` via `markLatchFileUnreadableTestOnly` before the clear, and carries one token
("stale-only-token") that exists ONLY on disk, not in the in-memory twin — so the written, unioned object
is provably `!==`, and non-disjoint from, the in-memory `updated` the reduce branch computed.

Negative control (`pnpm --filter @loom/daemon negative-control`, reverting only this card's source line):
RED — `assertQuarantineIdentityInvariantTestOnly().ok` is `false` with exactly the predicted violation
text, and `listActiveMergeQuarantines()` reports the identity twice, with the active-side copy missing
"stale-only-token". GREEN restored after re-applying the fix; tree confirmed byte-identical.
