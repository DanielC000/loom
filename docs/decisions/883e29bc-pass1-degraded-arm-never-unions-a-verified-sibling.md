# 883e29bc — PASS 1/1b's degraded-arm branch never arms (and so never unions) the walked-up key directly; it diverts to pending instead

From Code Reviewer `2ae805f3`'s round-2 review of `8a1bc2ef` — PRE-EXISTING, CRITICAL fail-open in
`merge-quarantine.ts`'s `reenterMergeQuarantinesAtBoot`. `8a1bc2ef` closed the IN-PROCESS absorb fail-open
(`isKeyVerifiedFor` gating the `direct` fast path and `enterMergeQuarantine`'s `existing`/pending-merge
branches) but explicitly scoped out PASS 1/1b's own boot-time union, which reaches the identical shape
through a restart instead of a live query. See `docs/decisions/8a1bc2ef-cross-tier-sibling-pending-absorb.md`'s
"Scope correction" section for the exact hand-off.

## The bug

`X = R/nested` is its own separate repo (own `.git`, own real key `Kx`); `R` is its enclosing repo; `T =
R/teamA` is a plain subdir of `R` with no `.git` of its own (collapses onto `R`'s own canonical key the
ordinary way). At boot, `X`'s latch carries a recorded `resolvedKey` (`Kx`) but `X` itself is currently
unresolvable — `canonicalRepoLockKey(X)` walks up to the nearest EXISTING ancestor with a `.git`, landing
on `R`'s own real key. `T`'s latch is genuinely resolvable at this same boot.

PASS 1's old code called `armQuarantineKey(byRepoKey, currentKey, entry)` for `X`'s DEGRADED, walked-up
key UNCONDITIONALLY (then a second call for `entry.resolvedKey`) — and `armQuarantineKey` UNIONS
unconditionally with whatever already (or later) occupies that key, with no verification of either side.
When `T`'s own ordinary migrate-arm (processed in the same `for (const f of files)` loop, order-independent
either way — `armQuarantineKey`'s union doesn't care which side arrived first) also lands at `R`'s key, the
two get silently merged into ONE armed object sharing `armedKeys = [Kr, Kx]`. Since
`clearMergeQuarantineByKey` lifts every key in `armedKeys`, a human clearing `X` by its own recorded `Kx`
then also lifts `T`'s genuine, unrelated quarantine — and `T`'s own on-disk latch was already consumed
into the union during its own migrate-arm, so nothing durable survives to resurrect it: `T` stays lifted
across a LATER boot too, not just in-process.

Reproduced standalone, deterministically (3/3, separate OS processes, fresh `LOOM_HOME` each run) for BOTH
PASS 1 (a clean `.json` final for `X`) and PASS 1b (`X`'s latch existing only as a `.json.tmp-<pid>-<hex>`
torn-write residue) — see the two scenarios of that name in
`test/merge-quarantine-pass1-degraded-union-guard.mjs`.

Also: the PASS 1/1b warn text for this branch claimed "`${entry.repoPath}` (and every one of its
ancestors) does not currently resolve on disk" — false whenever an ancestor (like `R` here) DOES resolve;
`isRepoPathCurrentlyResolvable` only ever tests the entry's own path, never its ancestors. Reworded at all
three sites that carried this claim (the no-resolvedKey branches too, since they're reached via the exact
same shape and the fix is identical there).

## The fix

In PASS 1's `!resolvableNow` branch (entry has a recorded `resolvedKey` differing from the degraded,
walked-up `currentKey`): arm ONLY at `entry.resolvedKey` (still trusted per `7673d096`) via the ordinary
`armQuarantineKey` call, and — only when `currentKey !== entry.resolvedKey` — divert the degraded key's
own signal to `pendingUnresolvedQuarantines` (the SAME shape the no-resolvedKey branch already uses)
instead of ever calling `armQuarantineKey` for `currentKey` directly. PASS 1b's tmp-residue mirror gets the
identical change (it had no equivalent `resolvableNow` branch at all — the dual-arm fired unconditionally
whenever `resolvedKey` was set and differed from `currentKey`, regardless of resolvability — so the new
guard there is explicitly gated on `!isRepoPathCurrentlyResolvable(entry.repoPath)`).

`activeMergeQuarantineFor` gained a 4th, dedicated pending-lookup tier (after the three existing
`54054c01`/`8a1bc2ef` tiers, none of which can ever find this entry while it stays unresolvable — two
require identity equality, one requires current resolvability): match by `canonicalRepoLockKey` equality
alone, gated on (a) still being unresolvable AND (b) carrying its OWN recorded `resolvedKey`. Condition (b)
is load-bearing — see "Do not" below; without it this tier collides with `abccee85`/round 7's own
"nothing to walk yet" rule for a bare, never-yet-resolved, no-resolvedKey pending latch. Every match this
tier can ever produce is unresolvable by construction of its own predicate, so it can only ever hit the
shared "still can't be verified — report active, never graduate" branch immediately below — it can NEVER
absorb, or be absorbed by, anything.

`clearMergeQuarantineByKey`'s pending-sweep (matched by `directPathIdentity`, unchanged) now ALSO lifts
every key in a matched pending entry's own `armedKeys` — a diverted entry is genuinely armed elsewhere
(its own resolvedKey), and a clear issued while the path is STILL unresolvable recomputes the SAME
degraded key PASS 1 no longer arms anything under; without this, `entry = activeQuarantines.get(key)`
misses entirely and the fallback `keysToLift = [key]` addresses nothing real, leaving the entry's actual
armed slot/file behind to resurrect the "cleared" quarantine. This was the exact regression `54054c01`'s
own SCENARIO E/R3 caught (a human clear issued while the whole repo is absent) — fixed here, in the one
shared helper every clear path already delegates to.

`listActiveMergeQuarantines`'s dedup now runs across BOTH `activeQuarantines.values()` AND
`pendingUnresolvedQuarantines` in ONE `Set`, not `activeQuarantines` alone — a diverted entry is the SAME
object reference in both structures (armed at resolvedKey, pending at its degraded key), so a dedup
scoped to only one of them reported it twice.

## The two mandated residual properties (owner directive, approving direction (a))

The diverted pending copy going inert once its own path remounts to a DIFFERENT real key than the one it
was diverted under (never explicitly pruned — it just stops matching any future query's key) is an
ACCEPTED tradeoff, same shape `54054c01` itself already carries for a repo "gone for good." Verified
directly (scenario `residual`, `test/merge-quarantine-pass1-degraded-union-guard.mjs`):

1. **Clearing the degraded entry sweeps its diverted pending copy.** `clearMergeQuarantineByKey`'s
   `directPathIdentity` sweep already finds the pending copy; the `armedKeys` lift added above means the
   clear also reaches the entry's REAL armed slot. After the clear, a query for the enclosing ancestor
   finds nothing left at all.
2. **A later direct query for the entry's own identity, once it remounts (never cleared), still returns
   its own quarantine.** Querying by its own path recomputes its NOW-real key (no longer degraded) and
   hits the `direct` fast path immediately — the entry's own pending copy, found via `collectCrossTierSiblingIndices`
   matching its OWN now-resolvable identity, gets absorbed into itself (a harmless, idempotent self-union)
   and durably migrates to its proper on-disk location as a side effect — which also happens to clean up
   the "inert" residual for exactly this path, though that cleanup is incidental, not load-bearing.

## What a human/admin sees for R while X is unmounted (fail-closed confirmed)

- **T absent, X alone:** querying `R` misses `activeQuarantines` (nothing armed there) and falls to the
  new 4th pending tier, which finds `X`'s diverted entry and reports `R` as quarantined via `X`'s own
  reason — same practical signal as before the fix, just sourced from pending instead of a static arm.
- **T present, genuinely verified:** querying `R` hits `T`'s own clean, directly-armed entry — `R` reads
  quarantined via `T`'s real, accurate reason instead of a false reason merged from `X`. Clearing `X` (by
  `Kx`) never touches `T`; clearing `T` never touches `X` — if `T` is later cleared, `R`'s NEXT query falls
  through to the same 4th tier and finds `X` again, so the fail-closed signal is continuous across either
  clear order.

Neither case ever reads "not quarantined" while `X` is genuinely unresolved and nothing else occupies its
walked-up key.

## A separate, adjacent finding — NOT fixed here, reported for a follow-up card

While isolating PASS 1b's own repro, including `nested` (X's registered path) in `reenterMergeQuarantinesAtBoot`'s
`registeredRepoPaths` argument caused `X`'s own `.json.tmp-<pid>-<hex>` residue to be silently UNLINKED
as "already-superseded stale residue" (the `matchedRepo && cleanlyParsedKeys.has(canonicalRepoLockKey(matchedRepo))`
guard at the top of PASS 1b's tmp loop) — BEFORE ever reaching the dual-arm code this card targets. The
guard recomputes `canonicalRepoLockKey(matchedRepo)` FRESH, which degrades to `R`'s key while `nested` is
unresolvable — and `R`'s key IS in `cleanlyParsedKeys` (via `T`'s own clean parse), even though `T` and `X`
are genuinely unrelated repos. This is the SAME root class of bug (trusting a degraded, walked-up key as
if it reliably identifies "this repo") reached through PASS 1b's OWN unrelated tmp-cleanup short-circuit,
not through `armQuarantineKey`. `test/merge-quarantine-pass1-degraded-union-guard.mjs`'s `pass1b` scenario
deliberately OMITS `nested` from its own `registeredRepoPaths` argument to isolate the dual-arm shape this
card actually fixes from this adjacent one — see that scenario's own header comment. Not reproduced as a
standalone minimal repro here; flagged for whoever picks up the follow-up card to do that work.

## Pre-existing tests updated as a direct, intentional consequence of this fix

- `test/merge-quarantine-cross-tier-sibling-absorb.mjs` scenario 6 (`8a1bc2ef`'s own round-2 repro):
  previously asserted the FIRST `activeMergeQuarantineFor(R)` query (made once `T` has become resolvable
  while `X` stays unmounted) returns `X`'s entry. Under this fix, nothing is armed at `R`'s key for `X`
  anymore, so that SAME query now hits `T`'s own, just-graduated entry directly instead — an IMPROVEMENT
  (the query result is now always the most ACCURATE currently-known reason, not a stale degraded guess),
  not a loss of the property the scenario exists to prove (clearing `X` never lifts `T`, which every
  downstream assertion in that scenario — unchanged — still confirms).
- `test/merge-quarantine-clear-by-path.mjs` scenario (I) (`c0be9bf9`'s own round-2/3 repro): previously
  manufactured and asserted a genuinely DUAL-armed entry (two distinct keys, two ids) for a repo that never
  resolves at all. That shape can no longer occur for an entry with no verified sibling sharing its
  degraded key — it is now single-armed, under `resolvedKey` alone. Rewritten to assert the new contract
  directly (one id, not two; clearing by the now-meaningless degraded id is a benign no-op; clearing by the
  real id still works) rather than silently leaving a now-permanently-false precondition in the suite,
  which was ALSO contaminating later scenarios (L, M) in the same process — the stale precondition's own
  "clear" call no longer actually cleared anything, leaking `repoDual`'s entry into every scenario that ran
  afterward in that one file/process.

## Round 2 (Code Review, reviewer unnamed in the relayed verdict) — round 1's own fix left the CLEAR side, and two coverage gaps, open

Round 1 closed PASS 1/1b's OWN boot-time union (the bug above). This round found: round 1's fix made
`activeQuarantines` NEVER directly hold a degraded entry's own walked-up key anymore — but two
clear-path functions and one coverage check still assumed the OLD (round-1-fixed) shape, and the new
divert mechanism itself had two further gaps (findings 5/6). All reproduced/verified via
`test/merge-quarantine-pass1-degraded-union-guard.mjs`'s new scenarios, each proven RED on the round-1
commit (`5a3c9326`) and GREEN after, via `scripts/negative-control.mjs`.

### Finding 1 (CRITICAL) — `clearMergeQuarantine` still recomputed a possibly-degraded key

`POST /internal/merge-quarantine/clear` → `clearMergeQuarantineReporting` → `clearMergeQuarantine(repoPath)`
addressed a FRESHLY-recomputed `canonicalRepoLockKey(repoPath)` UNCONDITIONALLY. For `X` (unmounted), that
recompute walks UP to `R`'s own real key — so clearing `X` by its own project/repoPath actually lifted
`T` (a genuinely separate, verified occupant of `R`'s key) instead of `X`'s own entry, durably across a
restart. **Fix:** when `repoPath` is NOT currently resolvable, `clearMergeQuarantine` now delegates to
`clearMergeQuarantineByRecordedPath` (resolves by STORED identity) instead of the fresh-key address;
`abccee85`'s own choice to keep the RESOLVABLE case on the fresh key is unchanged. `assertRepoNotQuarantined`
was given the same identity-first treatment (via the new shared `resolveQuarantineFor`) so the refusal
text for an unresolvable `repoPath` names ITS OWN recorded blocker, never an unrelated repo that merely
occupies the same walked-up key. Scenario `clear-x-unmounted`.

### Finding 2 (MAJOR) — `clearMergeQuarantineReporting` could report false success

With `T` absent and `X` diverted, `/clear` on `R` (resolvable, so its own key is addressed unchanged)
finds NOTHING at `R`'s key and lifts nothing — but the old code still reported `wasQuarantined:true` with
no further signal, which reads as success. `R` stays blocked with no indication why the clear didn't
help (abccee85 round-6 Finding 1's own shape, reopened by this card's diversion). **Fix:** `clearMergeQuarantineReporting`
now resolves the blocker (`resolveQuarantineFor`) BEFORE calling `clearMergeQuarantine`, and checks by
OBJECT IDENTITY (`isEntryStillPresent`) whether that exact entry is still reachable afterward — if so, it
reports `wasQuarantined:true` (truthful: `R` genuinely still is) plus a `reason` naming the TRUE blocker's
repoPath/id and pointing at `/clear-by-path`. The `/clear` gateway route threads the optional `reason`
through, mirroring `/clear-by-path`'s own shape. Scenario `clear-r-truthful-reporting`.

### Finding 3 (MAJOR) — round 1 removed the only coverage of 8a1bc2ef's own `direct`-fast-path guard

`activeMergeQuarantineFor`'s `direct` fast path's `isKeyVerifiedFor` check (the ORIGINAL `8a1bc2ef`
round-2 fix) is now UNREACHABLE via scenario 6's own construction, since PASS 1 never arms a degraded
entry directly at a walked-up key anymore — deleting that guard line left 0/18 test files RED. **Fix:**
no code change (the guard is still correct and still load-bearing for a DIFFERENT shape) — added scenario
`direct-verified-guard`, which reconstructs an unverified `direct` occupant through a route round 1's fix
does NOT close: an entry (`X`) whose own `repoPath` NEVER resolves at all, with its recorded `resolvedKey`
deliberately COLLIDING with a genuinely resolvable repo `Y`'s own real key — PASS 1's divert still arms
`X` there (trusting `resolvedKey` unconditionally, per `7673d096`; this card never gated THAT arm). Proven
RED by temporarily disabling the guard line and re-running just this scenario, then restored.

### Finding 4 (MINOR) — round 1's own test rewrite lost `quarantineLatchFileIdsFor`'s sort coverage

Scenario (I)'s rewrite (see above) no longer exercises the round-3 (`c0be9bf9`) real-file-first SORT at
all, since a genuine dual-arm with a no-file-first NATURAL insertion order can no longer be produced the
way (I) used to. **Fix:** no code change — added scenario (I2) (`test/merge-quarantine-clear-by-path.mjs`)
restoring a genuine PRODUCTION dual-arm (PASS 1b's RESOLVABLE fall-through, gated only on
`!isRepoPathCurrentlyResolvable`, untouched by this card) — but its OWN natural insertion order already
happens to put the real-file key first, so it does NOT by itself discriminate the sort (verified: disabling
the sort does not flip (I2)'s own result). Added scenario (I3), a direct unit-style proof of the sort's
own contract (hand-constructed `armedKeys` with the no-file key inserted first) — proven RED by temporarily
disabling the sort, GREEN restored.

### Finding 5 (MINOR) — a diverted pending copy was a stale object snapshot

PASS 1/1b pushed `armedAtResolvedKey` — the result of `armQuarantineKey` AT THE MOMENT of that call — into
`pendingUnresolvedQuarantines`. If a LATER file in the SAME pass legitimately unions with that same key
(a genuine same-boot sibling), `byRepoKey`'s own slot gets REBUILT to a new object, but the pending copy
still referenced the stale pre-union one — `listActiveMergeQuarantines` could then report the same
logical entry twice, inconsistently. **Fix:** collect `{resolvedKey, sourceFile}` pairs during each pass
(`degradedDivertsToFlush`) and push the pending copy only AFTER that pass's own loop fully finishes,
re-reading `byRepoKey.get(resolvedKey)` at that point — guaranteeing the pushed reference is that pass's
OWN final value. (This also surfaced — and fixed — a pre-existing instance of the SAME double-listing
shape: `listActiveMergeQuarantines`'s old `[...new Set(activeQuarantines.values()), ...pending]` deduped
only within `activeQuarantines`, never across the two sources; now one `Set` covers both.)

### Finding 6 (MINOR) — `clearMergeQuarantineByRecordedPath`'s pending-only branch lacked the `armedKeys` lift

`clearMergeQuarantineByKey`'s pending-sweep (finding fixed in round 1) lifts a matched pending entry's own
`armedKeys` too. `clearMergeQuarantineByRecordedPath`'s OWN, separate pending-only branch (reached only
when NOTHING matches by identity in `activeQuarantines` first — e.g. a pending entry orphaned from its own
active counterpart by an unrelated key-addressed clear) did not. **Fix:** mirrored the same `armedKeys`
lift there, for symmetry with `clearMergeQuarantineByKey`.

### Findings 7/8 — accepted as-is, no code change

Finding 7 was accepted as-is (not relayed to this worker in further detail). **Finding 8:** the rule "never
arm a degraded entry at its walked-up `currentKey` directly" (this card's own central fix) is NOT
structurally enforced at PASS 1's own unconditional fall-through (~line 1318 in this revision — the block
immediately after the `if (freshHash !== hash) {...}` branch, shared by every entry that reaches it,
resolvable or not) — nothing there re-checks `isKeyVerifiedFor` before a dual-arm. **There is no KNOWN
production writer that currently reaches this fall-through with an unresolvable, degraded-key entry** (the
two actual degraded-arm sites — PASS 1's own `!resolvableNow` branch, and PASS 1b's mirror — both now
`continue` before ever reaching their shared fall-through). Accepted as a known, unenforced invariant
rather than a structural guarantee: a FUTURE change that lands a new call site writing an unresolvable,
`resolvedKey`-carrying entry into this fall-through (instead of through the existing divert branches)
would silently reopen this card's own bug. Any such future change must route through the SAME divert
pattern, not fall through to the unconditional block.

## Round 3 (Code Review) — round 2's own finding-6 lift created a NEW fail-open; the reporting fix answered the wrong question

### Finding 1 (MAJOR) — a stale `armedKeys` snapshot could delete an UNRELATED repo's genuine quarantine

Round 2's finding-6 fix (symmetric `armedKeys` lift in `clearMergeQuarantineByRecordedPath`'s pending-only
branch) and round 1's own `clearMergeQuarantineByKey` pending-sweep fix both deleted EVERY key in a matched
pending entry's own `armedKeys`, unconditionally. Reviewer probe: `Y` is a real, resolvable repo; `X` never
exists, with `resolvedKey` manufactured to collide with `Y`'s own real key `Ky`. `/clear(Y)` correctly lifts
`X`'s ACTIVE arm at `Ky` — but `X`'s own PENDING copy survives untouched (its identity never matched `Y`'s),
now STALE: its `armedKeys` still names `Ky`, which nothing occupies anymore. `Y` then takes a fresh, genuine
raise, reusing `Ky` (nothing stops it — the key is genuinely free). `clear-by-path(X)` — matching `X`'s
now-orphaned pending record by identity, exactly as the earlier refusal told the human to do — then blindly
deleted `Ky` and its latch, DESTROYING `Y`'s brand-new, wholly unrelated quarantine. The branch only ever
runs when NO active entry has `X`'s own identity (checked first) — so by construction, any key still in a
matched pending entry's own `armedKeys` either genuinely still belongs to it, or belongs to someone else
entirely by now.

**Fix:** a new `pendingEntryStillOwnsKey(key, pendingEntry)` — `true` iff `activeQuarantines.get(key)` is
`pendingEntry` itself (by reference) OR a legitimate rebuild sharing its own recorded identity (a union, an
orphan merge) — gates EVERY `armedKeys` lift in BOTH pending-sweep sites
(`clearMergeQuarantineByKey`, `clearMergeQuarantineByRecordedPath`'s pending-only branch). A key that fails
this check is simply skipped, never touched. Scenario `stale-armedkeys-no-collateral`; proven RED by
temporarily hard-coding the guard to always return `true`, GREEN restored.

### Finding 2 (MAJOR) — `clearMergeQuarantineReporting` judged the wrong question

Round 2's fix checked whether the PRE-clear object (`before`) was still reachable BY OBJECT IDENTITY after
the clear — the wrong question, failing in BOTH directions. (a) Full pass1 shape (`T` direct-masks `X` at
`tier 4`): `/clear(R)` genuinely lifts `T`'s own entry — but `R` is STILL quarantined afterward, now via
`X`, which the pre-clear snapshot never named at all (`before` was `T`, not `X`). The old check saw `before`
(`T`) was gone and reported a clean, reason-less success — while `R` remained genuinely blocked. (b) The
finding-1 shape (`Y`/`X` collision): a SINGLE `/clear(Y)` genuinely, fully clears `Y` (lifting `X`'s only
real blocking power, its active arm) — but `X`'s own entry OBJECT is still technically reachable (its stale
pending copy, per finding 5's own same-reference design) — the old check saw `before` still "present" and
wrongly reported "still quarantined by X," even though `Y` is genuinely, fully clear (the 4th tier can never
re-match `X`'s pending copy for a query on `Y`, since it recomputes BY KEY from `X`'s own path, never from
`X`'s stored `resolvedKey`).

**Fix:** re-resolve `repoPath` FRESH via `resolveQuarantineFor` AFTER the clear (`after`), and judge by
WHETHER repoPath is still quarantined by anything right now — never by the specific pre-clear object's own
survival. `isEntryStillPresent` (round 2's own helper) is now dead and removed. Scenarios
`clear-unmasks-different-blocker` (a) and `clear-stale-pending-not-blocking` (b).

### Finding 3 (MINOR) — `clearMergeQuarantineByToken`'s last-token clear could re-derive by a drifted `repoPath`

`clearMergeQuarantineByToken` already has the CORRECT entry in hand (`current`, matched by `key` — the
SAME key this very function just resolved) — but on the LAST remaining token, it used to delegate via
`clearMergeQuarantine(repoPath)`, which (post round 2) now resolves by IDENTITY when `repoPath` is
unresolvable. `current.repoPath` is not always `repoPath`: `enterMergeQuarantine`'s `existing` branch keeps
the LONGEST-outstanding raiser's own identity when appending a later raise's token into a shared entry — so
`current.repoPath` can be a genuinely DIFFERENT raiser's own path than the `repoPath` this specific
`clearMergeQuarantineByToken` call was given. If that `repoPath` is now unresolvable and its OWN identity
doesn't match `current.repoPath`'s, the identity-based delegate silently no-ops, leaving the shared entry
armed FOREVER with only a now-dead token — exactly the "re-derive an address from repoPath instead of using
the already-matched key" anti-pattern `c0be9bf9` banned. **Fix:** delegate via `clearMergeQuarantineByKey(
key, current.repoPath)` instead — addressing the ALREADY-matched key/entry directly, never re-deriving from
the function's own `repoPath` parameter again. Scenario `token-clear-identity-drift`.

### Finding 4 (MINOR) — the `/clear` HTTP route's own `reason` threading was untested

Round 2 added `reason` to `clearMergeQuarantineReporting`'s return and threaded it through the `/clear`
gateway route's own response spread — but nothing exercised the ROUTE itself with a diverted blocker, so a
future edit dropping that spread would go unnoticed. **Fix:** no code change — scenario (H7),
`test/merge-quarantine-clear-by-path.mjs`, raises a real HTTP `/clear` call (via `app.inject`) against a
project-bound repo with a diverted blocker and asserts the response body's own `reason` field.

### Finding 5 (discriminating test only) — round 2's deferred-flush fix had no dedicated regression test

Round 2's own finding-5 fix (defer the degraded-divert's pending push until after each pass's own loop,
re-reading `byRepoKey` at that point) was never directly exercised by a test that would catch a revert back
to an immediate snapshot push. **Fix:** no code change — scenario `deferred-flush-no-stale-snapshot`: two
entries (`X1`, `X2`) both diverted with the SAME manufactured colliding `resolvedKey` within one boot,
asserting the final listing is a single, consistent, fully-unioned entry. Proven RED by temporarily
reverting the push to an immediate snapshot, GREEN restored.

### Finding 6 (NIT) — stale doc comment

`clearMergeQuarantineByRecordedPath`'s own doc comment claimed it was "Used ONLY by `/clear-by-path`'s
`{repoPath}` form" — stale since round 2 made `clearMergeQuarantine` itself delegate here whenever its own
`repoPath` is unresolvable (reaching it transitively from `/clear` too). Reworded.

## Round 4 (Code Review) — round 3's own fix protected the IN-MEMORY state but still deleted the FILE unconditionally

**CRITICAL:** both pending-sweep sites (`clearMergeQuarantineByKey`, `clearMergeQuarantineByRecordedPath`'s
pending-only branch) still ran a bare `fs.unlinkSync(p.sourceFile)` after round 3's `pendingEntryStillOwnsKey`
guard — that guard protects `activeQuarantines`/`deleteMergeQuarantineLatchByKey`, but never the pending
entry's own `sourceFile` delete, which happened unconditionally regardless. With REALISTIC naming (a
diverted entry's `sourceFile` genuinely is `hash(resolvedKey).json` — the same physical path a later fresh
raise at that key durably writes to), the exact `stale-armedkeys-no-collateral` sequence (round 3's own
scenario) deletes `Y`'s brand-new latch FILE on disk even though its in-memory entry is correctly left
untouched — invisible until a restart, which then finds nothing for `Y` and silently lifts it. Violates
`9cabd143`'s own rule (no bare per-entry unlink of a latch).

**Fix:** both sites now route the sourceFile delete through `sweepOwnLatchFileUnlessOwnedElsewhere` (the
SAME helper `clearMergeQuarantineLatchFile` already uses), called AFTER the matched pending entries are
already removed from `pendingUnresolvedQuarantines` — in `clearMergeQuarantineByKey`, the unlink was moved
out of the `.filter()` callback into a deferred list, swept once the filter itself has fully run, so the
ownership check correctly sees only SURVIVING entries (never the one being removed) when deciding whether
a SURVIVING repo (e.g. `Y`'s fresh raise) now physically owns that exact filename.

Extended `stale-armedkeys-no-collateral`: `X`'s latch is now named `hash(Ky).json` (realistic, matching
what a genuine prior raise/migrate would have written — never a synthetic filename of its own), and a
SECOND `reenterMergeQuarantinesAtBoot` (restart) asserts `Y`'s quarantine survives with only its own
token. Proven RED by temporarily restoring the bare unlink at `clearMergeQuarantineByRecordedPath`'s
pending-only branch — GREEN restored. (Fixing this also surfaced two PRE-EXISTING test fragilities:
scenarios (Q) and (T) in `merge-quarantine-clear-by-path.mjs` parsed a child process's ENTIRE stdout as
JSON, assuming no other code would ever write to it — `sweepOwnLatchFileUnlessOwnedElsewhere`'s own
`unlinkLatchFile` logs on a successful delete, unlike the old silent bare unlink, so both now parse only
the LAST stdout line, matching the pattern several OTHER scenarios in that file already used.)

**MINOR (finding 2):** `pendingEntryStillOwnsKey` was declared BETWEEN `clearMergeQuarantineByKey`'s own
JSDoc and the function itself, detaching the doc from what it documents (`6237bef6`'s own rule). Moved
above the JSDoc.

**MINOR (finding 3):** `clearMergeQuarantineReporting`'s `reason` text uniformly said "a DIFFERENT
recorded entry... that this clear did not lift," which is misleading when `after` is literally the SAME
entry `before` already was (the clear never touched it at all, not "different"). Now distinguishes: the
SAME entry as before ("still quarantined by its own recorded entry... this clear did not lift it") versus
a genuinely DIFFERENT repo's own, separate quarantine unmasked by lifting `before` ("quarantined by
ANOTHER repo's own, separate quarantine... that this clear never addressed").

## Do not

- Do not route a diverted pending entry's own `sourceFile` delete through a bare `fs.unlinkSync` at either
  pending-sweep site, even after gating its `armedKeys` lift (round 3) — that guard protects the IN-MEMORY
  map, never the file. Always `sweepOwnLatchFileUnlessOwnedElsewhere(sourceFile)`, called only AFTER the
  matched pending entries are already removed from `pendingUnresolvedQuarantines`, so the ownership check
  can see whether a SURVIVING entry (a fresh raise reusing the freed key) now physically owns that exact
  filename (round 4, CRITICAL).
- Do not widen the new `activeMergeQuarantineFor` 4th tier to match a pending entry regardless of whether
  it carries its own `resolvedKey` — a bare, never-yet-resolved, no-resolvedKey latch (the ordinary
  "pending, nothing to walk yet" shape `abccee85`/round 7 already governs) must NOT block an ancestor query
  before its own path has ever resolved even once; RED on `test/merge-quarantine-unresolvable-path.mjs`'s
  own R7-SUB-THEN-QUERY-ROOT precondition otherwise.
- Do not arm a degraded, unresolvable, `resolvedKey`-carrying entry at its walked-up `currentKey` in
  `byRepoKey`/`activeQuarantines` directly, in PASS 1, PASS 1b, OR any future call site that can reach this
  shape — route the degraded key's own signal through `pendingUnresolvedQuarantines` instead, exactly like
  a no-resolvedKey latch already does.
- Do not forget `clearMergeQuarantineByKey`'s pending-sweep now also needs to lift a matched pending
  entry's own `armedKeys` — without it, a clear issued while the path is STILL unresolvable (recomputing
  the same degraded key PASS 1 no longer arms) finds no `entry` via `activeQuarantines.get(key)` and
  silently fails to touch the entry's REAL armed slot/file at all.
- Do not revert `listActiveMergeQuarantines`'s single-`Set`-across-both-sources dedup back to deduping
  `activeQuarantines.values()` alone before appending pending entries — a diverted entry is the exact same
  object reference in both structures and would be reported twice.
- Do not read the "diverted pending copy goes inert after a remount to a different key" residual as a bug
  to fix reactively — it is an ACCEPTED tradeoff (owner directive), same shape `54054c01` already carries.
  Do not, however, assume it is ALWAYS inert: a direct query for the entry's own identity after remount
  incidentally self-absorbs and cleans it up (see "residual property 2" above) — this is a side effect of
  the ordinary cross-tier-sibling-absorb path, not something a future change should rely on as the
  PRIMARY cleanup mechanism.
- Do not assume PASS 1b's own `matchedRepo && cleanlyParsedKeys.has(...)` tmp-cleanup guard is safe against
  a degraded-key coincidence — see "A separate, adjacent finding" above. It is NOT fixed by this card.
- Do not address a clear/query by a freshly-recomputed `canonicalRepoLockKey(repoPath)` when `repoPath`
  itself is not currently resolvable — route through `resolveQuarantineFor`/`clearMergeQuarantineByRecordedPath`
  (identity-based) instead; the fresh recompute can walk UP to an unrelated enclosing repo's real key
  (round 2, finding 1).
- Do not judge `clearMergeQuarantineReporting`'s own success by whether the PRE-clear object is still
  reachable by OBJECT IDENTITY (the round-2 `isEntryStillPresent` design — now REMOVED, round 3 finding 2)
  — that answers the wrong question both ways: a lifted blocker can unmask a DIFFERENT one the pre-clear
  snapshot never named, and a harmless stale pending remnant of an already-lifted blocker can look like
  "still quarantined" when it genuinely is not. Always re-resolve `repoPath` FRESH, via
  `resolveQuarantineFor`, AFTER the clear instead.
- Do not land a NEW call site that writes an unresolvable, `resolvedKey`-carrying entry into PASS 1's
  unconditional fall-through (after the `if (freshHash !== hash) {...}` branch) instead of through the
  existing divert branches — that fall-through has no `isKeyVerifiedFor` check of its own (round 2,
  finding 8; accepted as a residual only because no current writer reaches it this way).
- Do not push a degraded-divert's pending copy into `pendingUnresolvedQuarantines` as an immediate
  snapshot of `armQuarantineKey`'s own return value — collect and flush it only after that pass's own
  loop fully finishes, re-reading `byRepoKey` at that point (round 2, finding 5).
- Do not lift a key from a matched PENDING entry's own `armedKeys` without first confirming, via
  `pendingEntryStillOwnsKey`, that the key still genuinely occupies THAT entry — a stale `armedKeys`
  snapshot (e.g. after an earlier, unrelated clear already lifted the entry's own ACTIVE arm but left its
  pending copy behind) can otherwise name a key a wholly UNRELATED later raise has since reused, and
  blindly deleting it destroys that unrelated repo's own genuine quarantine (round 3, finding 1).
- Do not have `clearMergeQuarantineByToken`'s last-remaining-token branch delegate via
  `clearMergeQuarantine(repoPath)` (the function's own raw parameter) — delegate via
  `clearMergeQuarantineByKey(key, current.repoPath)` instead, addressing the entry ALREADY matched above.
  `current.repoPath` can be a DIFFERENT, longer-outstanding raiser's own identity than `repoPath`
  (`enterMergeQuarantine`'s `existing` branch keeps the older identity when appending a token), and
  `clearMergeQuarantine`'s own identity-based resolution (round 2) can silently no-op against it,
  leaving the entry armed forever with a dead token (round 3, finding 3).

Tests: `test/merge-quarantine-pass1-degraded-union-guard.mjs` (scenarios `pass1`, `pass1b`, `residual`,
`negative-control-cross-key`, `direct-verified-guard`, `clear-x-unmounted`, `clear-r-truthful-reporting`,
`stale-armedkeys-no-collateral`, `clear-unmasks-different-blocker`, `clear-stale-pending-not-blocking`,
`token-clear-identity-drift`, `deferred-flush-no-stale-snapshot` — each in its own child process with its
own fresh `LOOM_HOME`), plus updates to `test/merge-quarantine-cross-tier-sibling-absorb.mjs` (scenario 6)
and `test/merge-quarantine-clear-by-path.mjs` (scenario I, rewritten; I2/I3/H7, new) described above.
