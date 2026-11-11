# 3de60f6e — round 2 of 0dc514dc (the resolveRaiseOverwrite two-path asymmetry)

_Split out of the former single `8db913e2` record by card `3608937e` so each record's injected Do-not extract fits the per-record cap; every section below is verbatim from it (pinned blob `2f1a55286d01`). The core record keeps the card's own rounds 1 and 3 and holds the index of every split-out record (rounds 2 and 4 of the card are in `sha:d529d42d`, record `d529d42d-raise-divert-rounds-2-and-4-chokepoint-union-and-in-memory-repoint.md`): `8db913e2-raise-diverts-instead-of-overwriting-a-kept-occupant.md`._

## Round 2 (Code Review `582ce5a9`) — a two-path asymmetry: `resolveRaiseOverwrite`'s own independent slow-path re-read of the SAME "resolvable ⇒ safe" shortcut was untouched by Round 1

Round 1 relaxed `differentUnresolvableOccupantRepoPathAt`'s own "resolvable ⇒ safe" shortcut (for Repro
B(b)). `resolveRaiseOverwrite`'s own slow path has an INDEPENDENT copy of that same shortcut
(`if (isRepoPathCurrentlyResolvable(parsed.repoPath)) return false;`), reached whenever a protect call's
own `protectOk` return is `false` — including a DOUBLE FAULT, where the detector correctly flags D (Round
1's own fix) but D's own protect-copy write ALSO fails, so there is nowhere durable for D's content to
land. `protectOccupantContentBeforeDelete` falls back to keeping `final` as D's own self-owned pending
record (its OWN write never attempted a different file) and returns `false` — `resolveRaiseOverwrite`
then independently re-reads `final`, sees D is resolvable, and (pre-this-round) blindly proceeds anyway.

### Repro P3 (the reviewer's own, verbatim)

1. Run Repro A steps 1-5 (`carda`'s own setup): D kept as a self-owned pending via a failed divert write,
   then graduates to ACTIVE at its own key Kd (graduation write there ALSO fails).
2. Inject an `openSync` failure on `pending-<hash(D)>.json`, then call `enterMergeQuarantine(r)`.
3. The detector flags D (Round 1's own fix). `protectOccupantContentBeforeDelete` fails to write the
   copy-aside, so it keeps `Krhash.json` as D's own self-owned pending and returns `false`.
4. `resolveRaiseOverwrite` re-reads, sees D is resolvable, and (pre-fix) proceeds. r's write overwrites
   `Krhash.json`.
5. `clearMergeQuarantine(r)` gives `latchKept:[D]`, keeping a file that now holds r's data.
6. Fresh-import reboot (pre-fix — reproducible on `4dba1d37`, this card's own parent, AND still on
   `f89cfbd2`, Round 1's own commit): d-token is LOST — a pre-existing fail-open this round CLOSES, not
   an accepted residual — and r's own CLEARED token RESURRECTS (the regression Round 1's own content
   check introduced, since it reaches this far without ever being consulted by this slow path).

### The fix

`resolveRaiseOverwrite`'s own `isRepoPathCurrentlyResolvable(parsed.repoPath)` branch now runs the SAME
content check, reusing `parsed` (never a second read) — but gated on `!protectOk` ONLY, which also
CLOSES the pre-existing d-token loss above (diverting instead of proceeding means D's content is never
overwritten in the first place). `protectOk === true` reaching this branch at all requires `marked` to
ALSO be true (the fast path above already returns for `protectOk && !marked`), and means ONE of two
things: either the protect call durably copied a genuine occupant's content aside for THIS SAME
invocation, or the detector found nothing to protect at all (`differentUnresolvableOccupantRepoPathAt`'s
own `"none"`). A content check reached there would double-count the FIRST case's own fresh copy (the
transient-duplicate false positive this card's own Do-not list already warns about) — and the SECOND
case needs no such check either: a stale mark on this SAME (same-identity) basename is already correctly
handled by the write's own chokepoint (`reconcileMarkedBasenameBeforeWrite`/`foldInOnDiskTokensIfMarked`),
which unions any genuinely on-disk tokens forward for THIS exact write before it ever proceeds. Every
`protectOk === false` path reaching this branch, by contrast, never durably writes a fresh copy of
anything (a read-failure mark, or a self-owned-pending fallback that points at `final` itself, never a
different file) — so there is nothing to double-count, and nothing else already covers it.

### Open question — `wouldOverwriteDifferentUnresolvableOccupant` (non-raise writers) shares the SAME
detector Round 1 touched, and a quick repro confirmed it IS a real, new fail-closed

`differentUnresolvableOccupantRepoPathAt` is shared by `protectDegradedOccupantBeforeDelete` (raise +
clear) AND `wouldOverwriteDifferentUnresolvableOccupant` (a NON-raise writer's own degraded-occupant
guard — graduation, sibling-absorb). Round 1's own content check, applied uniformly via the shared
detector, can flag a GENUINELY STALE leftover of an occupant that is ALREADY durably, independently
backed elsewhere (its own real key, properly migrated) — purely because the stale leftover's own bytes
still carry the SAME token the occupant's CURRENT, real record also holds. Confirmed empirically: D
raises fresh and writes successfully to its own key Kd; a stale leftover of D (same repoPath, same
token) is placed at a DIFFERENT key Kr; E (an unrelated, unresolvable entity walking up to Kr) raises,
then becomes resolvable and queries — the lazy-graduation write at Kr (guard ACTIVE, unlike a raise) was
refused, verified by reverting only this round's own exclusion and re-running: `Krhash.json` was left
unchanged, still holding D's stale data (the write was durably refused). **Correction (CR2 `a5b84e8e`):**
`eActive?.armedKeys` is NOT the discriminator here — an entry is armed IN-MEMORY unconditionally, whether
or not the durable write itself succeeds (e1cb7d33: enforcement for this process must not wait on disk
I/O), so `armedKeys` is non-empty on BOTH sides. `Krhash.json`'s own CONTENT (does it hold D's stale
bytes, or e's own) is the real discriminator. Restoring the fix, E's write durably succeeds.

**The fix:** `confirmedDurableBackingElsewhere(entry, token, excludeFinalPath)` — `true` iff `entry` has
an INDEPENDENT, confirmed-on-disk backing for `token` at one of its OWN `armedKeys` OTHER than
`excludeFinalPath` (a real file exists there right now, names the SAME identity, and still carries
`token`). Never checks `excludeFinalPath` itself — that would tautologically "confirm" a stale leftover
using its own soon-to-be-destroyed/overwritten bytes. `survivingTokenHolderRepoPaths` gained an optional
`excludeFinalPath` parameter: when given, an ACTIVE entry whose every MATCHED token is already confirmed
durably backed elsewhere is excluded from the result. Every existing caller that omits the parameter
(the clear path, both `resolveRaiseOverwrite` uses) keeps today's behavior byte-identical — this is
additive, and does not reopen Repro A/B(b)/P3, since in every one of those shapes the occupant's own
`armedKeys` target has NO durable backing at all (confirmed by the injected write failures that define
those repros) — `confirmedDurableBackingElsewhere` only ever EXCLUDES a genuinely safe case, never
re-includes an unsafe one. `differentUnresolvableOccupantRepoPathAt`'s own resolvable branch passes
`final` as `excludeFinalPath`.

### Tests

`merge-quarantine-raise-protect-failure.mjs`:
- **`p3`** — the reviewer's own repro, ported verbatim. Asserts `final` is NEVER overwritten (D's own
  content survives byte-for-byte — a double fault has nothing safe to divert TO, so proceeding would be
  the only alternative to diverting), r's own raise persists (diverted), the clear reports `latchKept`
  naming D, and — the discriminating check — after a fresh-import reboot, d-token SURVIVES and r's own
  CLEARED token does NOT resurrect (unchanged from the parent commit's own behavior for that half).
- **`openq`** (the open question's own repro) — D raises fresh to its own key Kd; a stale leftover of D
  (same token) is placed at a DIFFERENT key Kr; E raises while unresolvable (walking up to Kr), then
  becomes resolvable and is queried (lazy graduation, guard ACTIVE). Asserts `Krhash.json` now holds e's
  own content (the real discriminator — `armedKeys` non-empty is asserted too, but labeled as NOT
  discriminating: it passes on `f89cfbd2` as well, per the correction above) and D's own token is
  unaffected throughout. **Reboot leg (CR2 `582ce5a9`/`a5b84e8e`):** the card's own real failure mode here
  is a CLEARED-TOKEN RESURRECTION, not merely a refused write — `clearMergeQuarantineByToken(d, dToken)`,
  then a fresh-import reboot, asserting D's own cleared token does NOT resurrect and e's own raise
  survives. Proven RED on `f89cfbd2` and GREEN after, via `negative-control --ref f89cfbd2` — both the
  content-match assertion and the reboot assertion discriminate against that exact ref; every other
  `openq` check (including the relabeled `armedKeys` one) passes on both sides.

Both `p3` and `openq` proven RED on `f89cfbd2` (Round 1's own commit) and GREEN after, via
`negative-control --ref f89cfbd2` against the whole test file. All `merge-quarantine*.mjs` files
re-verified individually, each exit 0. All static guards
(`pnpm --filter @loom/daemon guards`) re-verified green (30/30).

## Do not

- **(Round 2)** Do not leave `resolveRaiseOverwrite`'s own slow-path "resolvable ⇒ safe" shortcut
  unguarded by a content check just because `differentUnresolvableOccupantRepoPathAt` already has one —
  the two are INDEPENDENT re-reads at two different call sites; fixing one does not fix the other (P3's
  own regression).
- **(Round 2)** Do not gate `resolveRaiseOverwrite`'s own new content check on anything other than
  `!protectOk` — the slow path only reaches this branch with `protectOk === true` when `marked` is ALSO
  true, meaning either a protect call JUST durably copied something aside for THIS SAME invocation (a
  content check there would double-count that fresh copy — the exact transient-duplicate false positive
  this card's own Do-not list already warns about) or there was nothing to protect at all, in which case
  the write's own chokepoint (`reconcileMarkedBasenameBeforeWrite`) already correctly unions any
  genuinely on-disk tokens forward — never assume the first case is the ONLY reason `protectOk` can be
  `true` here, or the safety argument is incomplete.
- **(Round 2)** Do not assume fixing `differentUnresolvableOccupantRepoPathAt`'s own "resolvable" branch
  is safe for EVERY one of its callers without checking which ones share it — `wouldOverwriteDifferentUnresolvableOccupant`
  (non-raise writers) shares the identical detector, and Round 1's own content check, applied there
  unguarded, created a genuine new fail-closed: a stale leftover of an occupant ALREADY durably backed
  elsewhere got wrongly flagged, refusing an unrelated entity's own legitimate write. Add
  `confirmedDurableBackingElsewhere` rather than assuming the fix is universally safe.
- **(Round 2)** Do not check `excludeFinalPath` itself inside `confirmedDurableBackingElsewhere` — a
  stale leftover's own bytes trivially "confirm" themselves if the exclusion is dropped, defeating the
  entire point of the check (it exists specifically to require an INDEPENDENT, different physical
  backing, not a tautological self-match).
- **(Round 2, CR2 `a5b84e8e`)** Do not assert `armedKeys` non-empty as proof a durable write succeeded —
  an entry is armed IN-MEMORY unconditionally the instant it's constructed, whether or not the physical
  write behind it ever lands (e1cb7d33: enforcement for this process must not wait on disk I/O). It
  passes on BOTH sides of a refused-vs-succeeded write; the file's own CONTENT is the only thing that
  actually discriminates. `openq`'s own `armedKeys` check is kept, but labeled as non-discriminating.
- **(Round 2)** Do not claim "all N new scenarios proven RED" from a single `negative-control` run's
  overall exit code — that proves the FILE regresses somewhere, never that every individual assertion in
  every new scenario does. State which specific assertion(s) discriminate (often only the reboot check;
  an in-process check can legitimately pass on both sides, since an in-memory active entry is untouched
  by what happens to a physical file's own bytes) and which scenarios are deliberately GREEN on the
  parent by design (a documentation-only correction with no code change, like `crnit2`).
- **(Round 2)** Do not claim a content-check exclusion exists in code without grepping for it — this
  record's own Repro A section once claimed `clearedEntry.tokens` was excluded "in addition to the
  identity exclusion"; no such code exists, because the content check there is gated OFF entirely
  whenever `clearedEntry` is given. See the correction inserted at that section in `0dc514dc`'s own record.
