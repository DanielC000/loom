# 37452ddd — `protectOccupantContentBeforeDelete`'s own re-point could leave a boot-diverted twin stale

_Split out of the former single `8db913e2` record by card `3608937e` so each record's injected Do-not extract fits the per-record cap; every section below is verbatim from it (pinned blob `2f1a55286d01`). The core record keeps the card's own rounds 1 and 3 and holds the index of every split-out record (rounds 2 and 4 of the card are in `sha:d529d42d`, record `d529d42d-raise-divert-rounds-2-and-4-chokepoint-union-and-in-memory-repoint.md`): `8db913e2-raise-diverts-instead-of-overwriting-a-kept-occupant.md`._

## Follow-up 37452ddd — `protectOccupantContentBeforeDelete`'s own re-point could leave a boot-diverted twin stale

Card 37452ddd, CR of `6451a749`'s own Round 2 fix (the `atFilenameIdx`/`atFinalBasenameIdx` re-point block
added there). `mergeTokenIntoPendingEntries` already knows (`@decision 64283e06`) that a matched pending
entry can be an `883e29bc` boot-diverted TWIN — the SAME object reference ALSO armed in `activeQuarantines`
— and routes its own re-point through `replaceEntryEverywhere` for exactly that reason. The re-point this
card's own block added at `protectOccupantContentBeforeDelete` never did: it reassigned
`pendingUnresolvedQuarantines[atFilenameIdx]` (or `[atFinalBasenameIdx]`) directly to a fresh `toWrite`
object, discarding the OLD reference with no re-point of its own. A twin's `activeQuarantines` entry (and,
for `atFilenameIdx`, any OTHER pending slot still sharing the old reference) was left pointing at the
stale object — missing whatever tokens a LATER same-identity merge (`mergeTokenIntoPendingEntries`) then
added only to the surviving pending slot, since that merge's own `replaceEntryEverywhere` call finds
nothing in `activeQuarantines` matching an object it was never armed under in the first place.

### The repro (first reported `blocked`, before any production edit)

Two hermetic scenarios, GREEN after the Round 1 fix:

- **`37452ddd-twin-repoint`** (`atFilenameIdx`) — TWO independent on-disk latch files for one unresolvable
  identity D, both recording `resolvedKey` as S's own canonical key: one at the ordinary hash-named final,
  one at D's own deterministic pending-divert filename. PASS 1 scans every `.json` file by CONTENT
  (filename-agnostic), so both resolve to the same degraded identity at the same `resolvedKey`;
  `armKeyUnlessDegradedCollision`'s same-identity union (plus its own `degradedDivertsToFlush` rebind)
  converges both onto ONE merged object — armed in `activeQuarantines` AND present in
  `pendingUnresolvedQuarantines` TWICE (once per `sourceFile`): the twin. A THIRD, unrelated occupant file
  for D is written directly to a DIFFERENT repo R's own key (never scanned into this process), and R
  raises — reaching `protectOccupantContentBeforeDelete` via the "no existing" front door, which finds the
  twin at `atFilenameIdx`.
- **`37452ddd-twin-repoint-finalbasename`** (`atFinalBasenameIdx`) — a SINGLE boot-time latch file is named
  as if it belongs to R's own key (`sourceFile = "<Krhash>.json"`) but its own content records
  `resolvedKey` as a DIFFERENT, unrelated repo S's key — PASS 1 arms an entry at its own `resolvedKey`,
  never at a hash derived from its filename, so this produces a twin whose ONLY pending reference sits at
  R's own `final` basename (not the pending-divert path — nothing sits there, so `atFilenameIdx` is `-1`).
  R raises — reaching `protectOccupantContentBeforeDelete` via the same front door, which finds the twin
  via `atFinalBasenameIdx` only.

**Correction (Round 2 CR of commit `01f2ae25`) — Round 1's own claim that both scenarios were
independently proven RED was FALSE for `37452ddd-twin-repoint`.** That scenario's original assertions ran
only AFTER D's own second raise — by then, `mergeTokenIntoPendingEntries`'s own (already-correct,
`64283e06`) `replaceEntryEverywhere` calls had already re-discovered and re-pointed the stale twin via its
OWN surviving pending slot, self-healing the exact staleness the scenario meant to catch. Removing Round
1's fix entirely still left this scenario green; `scripts/negative-control.mjs`'s own file-level RED on
that run came ENTIRELY from `37452ddd-twin-repoint-finalbasename`, which genuinely did (and still does)
discriminate. **Fixed (Round 2): both scenarios now assert in the window BETWEEN R's raise and D's own next
raise** — `activeMergeQuarantineFor` on the twin's own armed-key repo must already show the newly
discovered token, and exactly ONE object for D must exist — before anything downstream gets a chance to
self-heal it. Both scenarios then raise D itself a second time and assert the newest token is visible via
BOTH `activeMergeQuarantineFor` on the twin's own armed-key repo AND on D directly, that exactly ONE D
object exists in `listActiveMergeQuarantines()`, and that every token survives a fresh-process reboot.

### The fix (Round 1)

A `replaceEntryEverywhere(activeQuarantines, <old entry at that index>, toWrite)` call immediately before
each of the two re-point assignments — mirroring `mergeTokenIntoPendingEntries`'s own fix exactly.

## Round 2 (Code Review of commit `01f2ae25`) — Round 1 was incomplete: TWO more unguarded re-points, same shape

Besides the test-discrimination gap corrected above, CR found Round 1's own fix never covered every
re-point it needed to: `replaceEntryEverywhere` re-points `activeQuarantines` AND (by scanning it directly)
every `pendingUnresolvedQuarantines` entry sharing the SAME old reference — but Round 1 called it only
ONCE per branch, using only `atFilenameIdx`'s own entry as `oldEntry`. When `atFilenameIdx`'s entry and
`atFinalBasenameIdx`'s entry are TWO DIFFERENT objects (not the same twin), re-pointing one never touches
the other.

### CRITICAL — branch 1's own splice discarded `atFinalBasenameIdx`'s slot with no re-point at all

`if (atFilenameIdx >= 0) { ...; if (atFinalBasenameIdx >= 0) pendingUnresolvedQuarantines.splice(atFinalBasenameIdx, 1); }`
— reachable on the SUCCESS path, no fault needed, whenever the two indices hold DIFFERENT objects and the
`atFinalBasenameIdx` one is the one ARMED in `activeQuarantines`. **Repro (`37452ddd-branch1-dual-twin`):**
object X — a single latch file named as R's own key but `resolvedKey` = S's key (the SAME single-file twin
shape as `37452ddd-twin-repoint-finalbasename`, ARMED at S's key) — PLUS an INDEPENDENT pending-divert file
for the SAME identity with NO `resolvedKey` (object Y, never armed anywhere). R raises, discovering X's
content at its own final; `atFilenameIdx` matches Y's slot (the deterministic pending-divert filename),
`atFinalBasenameIdx` matches X's slot — branch 1. Pre-fix: the splice discards X's own slot without ever
calling `replaceEntryEverywhere` for it, so `activeQuarantines` keeps the STALE X object forever — `S`'s
own active entry never sees Y's token, D's later raise, or anything added after. Named consequence,
confirmed by the test: `clearMergeQuarantineByToken(d, <X's own token>)` then fail-open-LIFTS `S`'s key
entirely (nothing else is armed there), even though Y's (and D's later) tokens are still outstanding —
exactly the shape this whole card exists to prevent. **Fix:** a SECOND `replaceEntryEverywhere` call,
re-pointing `atFinalBasenameIdx`'s own entry, before that slot is spliced away.

### MAJOR — the double-fault `kept` branch had the IDENTICAL gap

`pendingUnresolvedQuarantines[atFinalBasenameIdx] = { entry: kept, ... }` (the branch reached when the
CHOSEN write, to `filename`, ALSO fails) never went through `replaceEntryEverywhere` either — Round 1's own
new "Do not" bullet (below) already named this exact line as forbidden, and it was reachable the whole
time. **Repro (`37452ddd-double-fault-kept-twin`):** the same single-file twin shape as
`37452ddd-twin-repoint-finalbasename`, with R's raise wrapped in `injectOpenSyncFailureForPrefix` targeting
D's own pending-divert filename so `writePendingDivertFile` fails and the double-fault branch runs.
**Fix:** `replaceEntryEverywhere(activeQuarantines, <atFinalBasenameIdx's own entry>, kept)` before the
slot is overwritten with `kept`.

### ACCEPTED RESIDUAL — `toWrite`/`kept` never carry `resolvedKey` forward, so a reboot can unblock the wrong side

**The concrete consequence (reproduced, not merely argued):** in the `37452ddd-twin-repoint-finalbasename`
fixture, after R raises (triggering `protectOccupantContentBeforeDelete`'s copy-aside) and the process then
reboots, `activeMergeQuarantineFor(s)` is UNBLOCKED (returns nothing) while `activeMergeQuarantineFor(d)`
still correctly returns the full entry (tokens `x`, `d2`, ...). This is a FAIL-OPEN for exactly as long as D
stays unmounted: anything that queries by `s` — R's own real repo — stops seeing D's quarantine at all,
even though D's own identity is still genuinely, durably blocked.

**Cause:** `toPersist`'s own field whitelist (this function's pre-existing, pre-`37452ddd` code) never
carries `resolvedKey` onto the protective copy it writes to `pending-<hash>.json`. On the NEXT boot, PASS 1
reads that file with no `resolvedKey` and no currently-resolvable path, so it takes the "defer to a lazy
re-resolve on first query" branch (never arms anywhere) — and `findPendingIndicesFor`'s own 4th tier
(~L3450, `merge-quarantine.ts`) is gated on `!!entry.resolvedKey`, so it never matches a query for `s`
either. Both the boot-time lazy-re-resolve path and the runtime query-time fallback need `resolvedKey` to
re-derive the connection to `s`, and the protective copy carries neither.

**Pre-existing, not introduced by this diff** — `toPersist`'s whitelist has excluded `resolvedKey` since
before card `37452ddd` touched this function at all; this round's own four `replaceEntryEverywhere` fixes
change WHICH in-memory object is correct and consistent, never WHAT FIELDS that object persists to disk.

**Tried carrying `resolvedKey` forward anyway, and it REGRESSES a different, deliberate, already-tested
invariant** — `merge-quarantine-runtime-union-provenance.mjs`'s own `clear-by-path-still-proceeds-and-protects`
scenario (card `82032b5c`/`c9114934`: "a protective copy must never re-occupy a resolved identity
collision") went RED the moment `resolvedKey` was carried forward from the REPLACED IN-MEMORY OBJECT: that
scenario's own protective copy (minted for a DIFFERENT identity, X, sharing a key with Y only via a genuine
collision) picked up `resolvedKey` from the stale pre-clear armed object it replaced, and a subsequent
reboot re-armed X at Y's own key — the EXACT resurrection `82032b5c` exists to prevent. The two concerns are
in real tension: a SELF-CONSISTENTLY-armed twin (this card's own scenarios) legitimately wants its
`resolvedKey` preserved so the 4th tier can still find it after a reboot; a GENUINE two-identity collision
(`82032b5c`'s own shape) must NOT have its `resolvedKey` preserved, or the losing side resurrects.

**Untested variant, not yet tried:** the regression above came specifically from carrying forward the
REPLACED IN-MEMORY OBJECT's own `resolvedKey` (which can belong to a DIFFERENT identity in the collision
case). A narrower variant — carrying forward the OCCUPANT's OWN on-disk `parsed.resolvedKey` (read directly
off `final`'s own bytes at the top of this function, `toPersist`'s own source) behind a check that this is
genuinely a SELF-CONSISTENT twin rather than a two-identity collision — was never built or measured. It may
avoid the `82032b5c` regression (the occupant's own `resolvedKey`, unlike the replaced object's, can never
belong to a different identity), but "may" is not "proven" — it still needs the same genuine-twin-vs-
collision discrimination the identity-model work (`398f476c`) exists to provide, and a hermetic repro before
trusting it.

**FIXED by card `4b06875f`** ("fix(git): keep a resolvedKey-armed twin blocking its key after a reboot") —
see the "Follow-up 4b06875f" section in `4b06875f`'s own record for the guarded variant that was actually built, and why it
avoids the regression above. This round (`37452ddd`) did not fix it; `toWrite`/`kept` kept their ORIGINAL
(pre-`37452ddd`) field set, and this round fixed the REFERENCE staleness only (the four
`replaceEntryEverywhere` calls), never the durable field set.

### `armedKeys` — a SEPARATE question from `resolvedKey`, not yet fixed either, open question filed separately

`armedKeys` is NEVER persisted to disk at all (it is purely an in-memory bookkeeping field, rebuilt fresh by
`armQuarantineKey`/`armKeyUnlessDegradedCollision` on every boot) — so, unlike `resolvedKey`, carrying it
forward onto `toWrite`/`kept` is COMPATIBLE with the `82032b5c`/`c9114934` reboot invariant above; it cannot
resurrect anything on reboot because nothing durable reads it back. Its absence here is fail-CLOSED, not
fail-open, IN-PROCESS: when the replaced object was dual-armed (`armedKeys.length > 1`), the replacement
carries no `armedKeys` of its own, so a LATER full clear of the replacement's own (single, newly-armed) key
never learns about the SECOND key the original twin also occupied — that second key stays armed (over-
blocking, the safe direction) rather than silently unblocking. **If this is ever fixed, derive `armedKeys`
from LIVE occupancy scanned fresh AFTER the re-point (which keys in `activeQuarantines` now actually point
at the new object), never from the old object's own `armedKeys` list** — a stale list is exactly the shape
`d4b25feb`'s own "Do not" section already warns against copying forward uncritically.

**Second, separate open question, also not investigated here: card `af948556`** — whether the raise-divert
path inside `consumeMatchedPendingsIntoArmedEntry` can strand a twin's own ACTIVE slot (unverified; filed
as its own follow-up, not explored as part of this card).

### Tests

Three scenarios in `merge-quarantine-raise-protect-failure.mjs`, mirroring the Round 1 pair:
`37452ddd-twin-repoint`/`37452ddd-twin-repoint-finalbasename` (Round 1, test-discrimination fixed per the
correction above), `37452ddd-branch1-dual-twin` (the CRITICAL repro), and
`37452ddd-double-fault-kept-twin` (the MAJOR repro). **Discrimination proof, per call site** (each of the
four `replaceEntryEverywhere` calls this card adds, one at a time: commented out in the TypeScript SOURCE,
rebuilt — which regenerates `dist` from that edited source — re-run against the resulting build to confirm
RED, then the comment-out reverted in source and rebuilt again to confirm GREEN; a bare `dist` edit would
never survive its own rebuild step, so the source is what was actually mutated each time):
1. Branch 1's own `atFilenameIdx` call — RED on `37452ddd-twin-repoint`'s mid-window assertions.
2. Branch 1's own `atFinalBasenameIdx` call (Round 2) — RED on `37452ddd-branch1-dual-twin`'s mid-window
   assertions AND its fail-open-lift assertion.
3. Branch 2's (`atFinalBasenameIdx`-only) call — RED on `37452ddd-twin-repoint-finalbasename`.
4. The double-fault `kept` branch's call (Round 2) — RED on `37452ddd-double-fault-kept-twin`'s mid-window
   and post-second-raise assertions.

All 34 `merge-quarantine*.mjs` files re-verified individually, each exit 0 — including
`merge-quarantine-unknown-provenance.mjs` (the `CHANGED_TS_TEXT_SCANNER_REPO_PATHS` member) and
`merge-quarantine-runtime-union-provenance.mjs` (the scenario the rejected `resolvedKey` carry-forward
regressed, now confirmed green with it reverted). All static guards (`pnpm --filter @loom/daemon guards`)
re-verified green (30/30).

### Do not

- Do not reassign a `pendingUnresolvedQuarantines[idx]` slot in place, inside this function or any sibling
  writer of this module's shared `byRepoKey`/`pendingUnresolvedQuarantines` state, without first asking
  whether the entry CURRENTLY at that index could be an `883e29bc` boot-diverted twin — route the
  replacement through `replaceEntryEverywhere` by default; a hand-rolled direct assignment is the recurring
  shape this bug class keeps reopening (see `d4b25feb`'s own "Do not" section for the earlier instance of
  the identical lesson).
- Do not union `atFinalBasenameIdx`'s own entry into `toWrite` to "fix" this — `c9114934` already forbids
  that (its own tokens may not be fully captured by `toPersist`'s read of `final`); the stale-reference
  hazard this follow-up fixes is orthogonal, and the fix here re-points the REPLACEMENT only, never adds a
  union source.
- Do not assume re-pointing ONE of `atFilenameIdx`/`atFinalBasenameIdx`'s own entries covers the other —
  they can be TWO DIFFERENT objects (one armed, one pending-only, or vice versa); re-point BOTH, every time
  either index is `>= 0`, including in the double-fault `kept` branch (Round 2's own CRITICAL + MAJOR).
- Do not carry `resolvedKey` forward from the REPLACED IN-MEMORY OBJECT onto `toWrite`/`kept` in this
  function — see the "ACCEPTED RESIDUAL" section above for the concrete regression this reopens
  (`82032b5c`/`c9114934`). Card `4b06875f` (see the "Follow-up 4b06875f" section in `4b06875f`'s own record) instead carries
  the OCCUPANT's OWN `parsed.resolvedKey`, behind a guard — never the replaced object's.
- Do not copy a replaced object's own `armedKeys` list forward uncritically either, if that is ever
  attempted — derive it from live occupancy after the re-point (card `d4b25feb`'s own lesson), and remember
  its absence today is fail-CLOSED (over-blocking), not fail-open, so it is lower priority than the
  `resolvedKey` residual above.
- Do not trust a test's own mid-raise assertions to discriminate a fix if they run only AFTER a SECOND
  same-identity raise — `mergeTokenIntoPendingEntries`'s own (correct) `replaceEntryEverywhere` calls can
  silently self-heal a staleness this module's OTHER writers failed to fix, making the later assertion pass
  for the wrong reason. Assert in the window BEFORE that second raise too.
