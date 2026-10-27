# 69635a8d — a degraded occupant's own stale boot-time arm relocates a legacy union's real record on clear

Split from card `24ed371f`'s own second triage note (originally card `3be11be4`'s CR3/Round-4 MAJOR-1).

## The shape

LEGACY `S` (no `identityAtRaise`), dual-armed `[Ks, Kr]` via a stale `resolvedKey=Kr`; a degraded occupant
`D` whose own `resolvedKey=Ks` differs from both its own physical filename and its own walked-up canonical
key; boot with no registered repos; `r` (a real, resolvable repo) raises at runtime, so `S` has contributor
`[r]`. In readdir order `D,S`, `/clear(r)` RELOCATED `S`'s own genuine physical record instead of reaching
`reduceForeignUnionContributor` — `S` ended up permanently stuck: every human route refused the latch id as
"ambiguous," surviving a reboot. Fail-closed (no wrong release), but stuck forever. Reproduced in that exact
order; the SAME shape in order `S,D` never reproduced (see "Order dependence" below).

## Root cause

At boot, `D` (unresolvable) is read first. Its `resolvedKey=Ks` candidate succeeds (`Ks` is still empty),
landing `D` in-memory at `Ks` via `armKeyUnlessDegradedCollision`'s own secondary-arm branch, and queuing
`D`'s own CORRECT `(entry, sourceFile)` pair into `degradedDivertsToFlush` (not yet flushed into
`pendingUnresolvedQuarantines`).

`S` is read second. Its PRIMARY arm at its own real key `Ks` collides with `D` there; since `S` is a real,
resolvable primary claim and `D` is not, `D` is evicted from `Ks` via `evictPriorFromKey`'s zero-remaining-
keys branch. `D` has no TRACKED pending reference yet (only the not-yet-flushed `degradedDivertsToFlush`,
which eviction deliberately never reads — see `d163aef5`'s own Round 3/6 history below), so the fallback
fires: `priorSourceFile = path.basename(quarantinePathForKey(key))`, i.e. `h(Ks).json` — `S`'s OWN genuine
physical latch file. This inference is only valid when the evicted entry reached `key` via its own self-
consistent PRIMARY arm; `D` reached it via the SECONDARY, non-tautological arm instead, so the inference is
simply wrong here. The wrong pair `{entry: D, sourceFile: h(Ks).json}` is durably pushed into
`pendingUnresolvedQuarantines`. `D`'s own CORRECT pair (`sourceFile: h(Kr).json`, its real file) is pushed
moments later when `flushDegradedDiverts()` runs — `D` now has TWO pending records, one correct, one wrong.

`S`'s secondary arm at `Kr` then succeeds cleanly (nothing occupies `Kr` in-memory), so `S` ends dual-armed
`[Ks, Kr]`.

Later, `/clear(r)` reaches `clearMergeQuarantine`. Because `canonicalRepoLockKey(r)` genuinely equals
`directPathIdentity(r)` (`r` owns its own key tautologically), `freshIsForeign` is FALSE by the explicit,
documented `3b1944b6`-Round-3 rule ("a path owning its own key is never foreign") — this routes to the
"not foreign" branch's own full-lift call, `clearMergeQuarantineByKey(Kr, r, undefined, true)`, never
`reduceForeignUnionContributor`. **Verified via a direct control** (the identical fixture with `D` entirely
absent): this branch selection is SAFE and INTENDED on its own — without `D` it cleanly fully-lifts both `r`
and `s` every time. This is not part of the bug.

`clearMergeQuarantineByKey` computes `keysToLift=[Ks,Kr]` and calls `deleteMergeQuarantineLatchByKey` once
per key. For `key=Ks`, `final=h(Ks).json` — `S`'s own real file. The `foreignPending` check there (`merge-
quarantine.ts`, inside `deleteMergeQuarantineLatchByKey`) found the WRONG pending entry (`D`'s bad record)
and — since its own `quarantineFileRepoPathIdentity(final) !== clearIdentity (r)` guard only ever compared
against the CLEARER's identity, never against the matched pending entry's OWN claimed identity — trusted it
unconditionally and relocated `S`'s own genuine record into a new `pending-<hash>.json` divert file under
`D`'s identity, instead of letting `S`'s own key be cleanly lifted as part of the (otherwise correct) full
release. The surviving divert still carried `S`'s legacy dual-arm ambiguity and its never-reduced `r`
contributor membership, so every later human route refused as "ambiguous" — permanently stuck.

## Order dependence

In readdir order `S,D`: `S` is read first and occupies `Ks`/`Kr` cleanly (nothing to evict). `D`'s later
secondary-candidate attempt at `Ks` then simply LOSES (CASE 2 of `armKeyUnlessDegradedCollision`'s
resolvability-mismatch branch — `!entryClaimIsTautological && !entryResolvable` returns `undefined`), and
`D` is pushed to `pendingUnresolvedQuarantines` via the DIRECT, always-correct push (never via
`evictPriorFromKey`'s fallback inference at all). No wrong pair is ever created, so this order never
reproduced the bug.

## The fix — at the chokepoint, not per-caller

`deleteMergeQuarantineLatchByKey`'s own `foreignPending` check (the one place every one of its four callers
shares) already had ONE content verification, from `d163aef5` Round 5 — `quarantineFileRepoPathIdentity(final)
!== clearIdentity` — covering a narrower, different shape (a clearer resurrecting its own content). It never
verified the match against the matched pending entry's OWN claimed identity. The fix reads `final`'s real
content ONCE (unchanged) and classifies it:

| case | content identity | action |
|---|---|---|
| (a) | matches `foreignPending`'s own claim | unchanged — protect under it, exactly as before |
| (b) | matches the entry THIS clear is itself lifting (`clearedEntry`, already threaded into every call site) | the claim is STALE — never protect under it; drop the stale `(entry, sourceFile)` pair from `pendingUnresolvedQuarantines` (fresh `indexOf` immediately before the splice, mirroring every other removal site — `9c681680`) so it can never misattribute this file again; `D`'s own OTHER, correct pending pair is never touched |
| (c) | a genuinely THIRD identity (neither (a) nor (b) nor the clearer) | fail CLOSED — protect under the identity the CONTENT itself names, never the stale pending label |
| (d) | unreadable/unparseable (`quarantineFileRepoPathIdentity` returns `undefined`) | unchanged — protect under the pending label, the only identity available; fail-closed exactly as before this card |

**Case (c)'s own safety**: `protectOccupantContentBeforeDelete`'s pending-rebind logic (`atFilenameIdx`/
`atFinalBasenameIdx`, gated by `directPathIdentity` per `cd5a3cf9`'s own fix) derives EVERY identity it
unions against from the REAL on-disk content it just read (`toPersist.repoPath`/`occupantIdentity`) — never
from the caller-supplied `occupantRepoPath` label. Passing `contentIdentity` (an already-normalized
`directPathIdentity` value) as that label is safe: it is used only for logging and for
`inMemoryProvenanceUnknownFor`'s own identity-scan lookup, both of which re-normalize via `directPathIdentity`
anyway (idempotent on an already-normalized string).

**"the entry this clear is lifting" was already available** — `clearedEntry`, the function's own third
parameter, already threaded into all four call sites (`clearMergeQuarantineByKey`'s primary loop and its
tied-pending "remove" branch, `clearMergeQuarantineByToken`'s pending-indices loop,
`tryClearMergeQuarantineByOwnIdentity`'s pending-removal branch). No new parameter was needed.

**Splice safety across all four callers**: `clearTokenFromPendingIndices` (card `9c681680`) and
`clearMergeQuarantineByKey`'s own pending loops already key their own bookkeeping by WRAPPER OBJECT and
resolve any index fresh, immediately before use — exactly the discipline that makes an unrelated mid-loop
splice (triggered deep inside a nested `deleteMergeQuarantineLatchByKey` call) safe. `foreignPending` is, by
construction, never a member of any caller's own `pendingPlan`/`matchedPending` set (those are always
identity-gated to `clearIdentity`, while `foreignPending`'s own identity is, by definition, different) — so
dropping it can never desynchronize an outer loop's own plan or in-flight iteration.

## Why this doesn't reopen `3b1944b6` / `3be11be4` / `6de79dc0`

The fix only narrows WHEN `protectOccupantContentBeforeDelete` is invoked, and under which identity label —
it never touches `clearMergeQuarantine`'s own branch selection, `reduceForeignUnionContributor`,
`selfClearRefusesForStaleKeyContributors`, or any of the stale-key-ownership/contributor-ambiguity refusal
logic those three cards built. The `noD` control above proves that logic is unaffected and already correct
on its own. None of those three cards' own regression fixtures
(`merge-quarantine-3b1944b6-stale-key-active-record-overclear.mjs`,
`merge-quarantine-3be11be4-self-clear-stale-key-contributor-refusal.mjs`,
`merge-quarantine-6de79dc0-sibling-key-contributor-wrong-release.mjs`) constructs a degraded occupant
sharing a physical file at all, so none of them exercises the `foreignPending` branch this card touches.

## Case (b)'s own reachability — ONE caller only

Case (b) requires `directPathIdentity(clearedEntry.repoPath)` to be able to differ from `clearIdentity`
inside the `contentIdentity !== clearIdentity` guard. Of `deleteMergeQuarantineLatchByKey`'s four call
sites, only `clearMergeQuarantineByKey`'s own primary `keysToLift` loop (`merge-quarantine.ts:5291`) can
ever produce that: `entry` there is whatever genuinely occupies the fresh key (`S` in this card's own
shape), while `identity` is the identity actually being cleared (`r`) — the two are independently derived
and can differ. The other three call sites (`clearMergeQuarantineByKey`'s own tied-pending "remove" branch,
`clearMergeQuarantineByToken`'s pending-indices loop, `tryClearMergeQuarantineByOwnIdentity`'s pending-
removal branch) all pass a `clearedEntry`/`identity` pair that is, by construction, the SAME identity
(each site's own pending/active match is filtered to `directPathIdentity(p.entry.repoPath) === identity`
before it is ever reached) — `liftedEntryIdentity` there always equals `clearIdentity`, so inside a branch
already gated on `contentIdentity !== clearIdentity`, the case-(b) condition can never be true. Case (b)
therefore always falls through to case (a)/(c)/(d)'s own `else` branch at those three sites — correct,
since there is nothing stale to drop there in the first place.

## Known residual — ordering against `survivingSharedClaimRepoPaths` (not shown reachable)

Case (b)'s own splice (`merge-quarantine.ts:2347-2348`) runs BEFORE `survivingSharedClaimRepoPaths(finalBasename)`
(`:2384`), which separately asks whether some OTHER surviving record still structurally claims this exact
file. If `foreignPending` were ALSO such a structural claimant (not just a `sourceFile`-matched pending
entry, but tied to `final` some OTHER way `survivingSharedClaimRepoPaths` would independently discover),
dropping it in case (b) before that later check runs could make `survivingSharedClaimRepoPaths` report
"nothing shared" when `foreignPending` itself was arguably such a claim. **Not shown reachable** — every
concrete case-(b) repro in this card's own corpus has `foreignPending` tied to `final` ONLY via the
`sourceFile` match this card's own fix is correcting, never via a second, independent structural tie. The
current ordering is arguably correct regardless: a case-(b) claim has already been PROVEN wrong against
the file's own real content, so a later check that happens to also "see" it is itself the thing that would
need re-deriving, not a reason to keep the wrong claim around. **Excluding a placeholder entry from case
(b) is explicitly NOT a safe alternative fix** — a CORRUPT placeholder (not just an unverifiable-content
one) can reach the exact same zero-remaining-keys eviction path as any other degraded entry, so "is this a
placeholder" does not discriminate a genuinely-wrong claim from a genuinely-right one either.

## Tests

`packages/daemon/test/merge-quarantine-69635a8d-degraded-stale-arm-relocate.mjs` — real-fs, each scenario
its own cache-busted module import (fresh `activeQuarantines`/`pendingUnresolvedQuarantines` AND its own
`MERGE_QUARANTINE_DIR`, per `d163aef5`'s own Round 5 lesson):

- `(DS)` — the card's own exact shape, readdir order `D,S` (forced deterministically: `D`'s own filename is
  `000000000000000000000000.json`, guaranteed to sort first). Asserts a FULL release of both `r` and `s`,
  that exactly ONE pending entry for `D` survives (naming `D`'s own correct `sourceFile`), and that `D`
  itself stays genuinely quarantined, untouched.
- `(SD)` — the same shape, order forced to `S,D` (`D`'s filename `ffffffffffffffffffffffff.json`, sorts
  last) — a control proving this order already worked and still does.
- `(C)` — case (c): a real raise's own physical file is overwritten to name a third, uninvolved identity,
  with an independently-injected (via `pushPendingQuarantineTestOnly`) wrong pending claim on the same
  file. Asserts the owner's own clear still succeeds, the third party's real content survives protected
  under its OWN identity (never the stale label), and the wrong pending claim's own entry is left exactly
  as it was. **This scenario alone is NOT RED pre-fix** — `toPersist` (the content actually persisted by
  `protectOccupantContentBeforeDelete`) always comes from `final`'s own real bytes, label or no label, so
  every one of `(C)`'s own assertions above passes identically whether or not the `occupantRepoPath` label
  is correct.
- `(C-provenance)` — the SAME case (c) shape, but the wrong pending claim's own in-memory record is itself
  `provenanceUnknown:true`. The mislabeled `occupantRepoPath` IS what `protectOccupantContentBeforeDelete`'s
  own `inMemoryProvenanceUnknownFor(occupantRepoPath)` read (`:3044`) resolves by identity — pre-fix, that
  resolves to the WRONG claimant's own identity and leaks its `provenanceUnknown` mark onto the third
  party's divert, which never carried one; post-fix it resolves to the content's own (correct) identity and
  nothing leaks. This is the ONE genuine behavioral effect the label change has for case (c) — see the RED
  set below.
- `(D)` — case (d): the same shape, but the physical file is corrupted (unparseable) instead of rewritten
  to a third identity. Asserts the owner's own clear still succeeds and the wrong pending claim survives
  untouched — unchanged, fail-closed behavior.

**`listPendingMergeQuarantinesTestOnly` is itself part of this card's own fix** (new export, absent on
pre-fix dist) — every scenario's own pending-count assertions go through a `pendingSnapshot(mq)` helper
that feature-detects it and falls back to `[]` (every dependent check then fails for real, not vacuously,
and never crashes) specifically so a pre-fix negative-control run executes every scenario instead of
aborting at the FIRST missing-export reference.

RED/GREEN proven via `scripts/negative-control.mjs --file packages/daemon/src/git/merge-quarantine.ts --test
packages/daemon/test/merge-quarantine-69635a8d-degraded-stale-arm-relocate.mjs --ref HEAD^` (the real
pre-fix commit `2958d0c5` — this fix is commit `b50559a8`, so plain `HEAD` is itself the fix and proves
nothing). **The real RED set is 9 failed checks, not vacuous, every scenario executed:**

| check | why it fails pre-fix |
|---|---|
| `(DS) *** THE FIX *** /clear(r) fully releases s — no longer stuck` | genuine — the card's own stuck shape |
| `(DS) a SECOND /clear(s) is a genuine no-op` | genuine — `s` is still blocked, so this is not a no-op |
| `(DS) exactly ONE pending entry for D survives` | **apparatus-only** — `listPendingMergeQuarantinesTestOnly` does not exist yet; `pendingSnapshot` returns `[]`, so this can never be verified either way pre-fix |
| `(DS) D's surviving pending entry names its own correct sourceFile` | apparatus-only, same reason |
| `(SD) exactly ONE pending entry for D` | apparatus-only, same reason — `(SD)`'s own underlying behavior was NEVER broken; this FAIL is not evidence of a regression |
| `(SD) D's pending entry names its own correct sourceFile` | apparatus-only, same reason |
| `(C) the wrong pending claim's own entry is left exactly as it was` | apparatus-only, same reason |
| `*** THE FIX (C-provenance) *** does NOT inherit the WRONG claimant's provenanceUnknown` | **genuine** — pre-fix, the third party's divert DOES inherit it (see `(C-provenance)` above) |
| `(D) the wrong pending claim is never dropped` | apparatus-only, same reason |

Three checks are genuine behavioral discriminators for this fix (the two `(DS)` release checks, and the
new `(C-provenance)` provenance-leak check); the other six fail only because this card's own new test-only
introspection export cannot exist on pre-fix code by construction, not because the specific claim they
each make was independently falsified — `negative-control.mjs` reverts the WHOLE file, so there is no way
to test "pre-fix behavior, post-fix introspection" through it. GREEN after; tree restored byte-identical,
confirmed both times this card's own negative-control was run.

## Do not

- Do not re-add eviction-side hardening to `evictPriorFromKey`'s own zero-remaining-keys fallback inference
  — `d163aef5` Round 3 and Round 6 each tried exactly that, twice, and each attempt opened a NEW durable-
  loss hole (see that record's own Round 5/6 sections). The fix for a wrong inference belongs on the CLEAR
  side, verified against the file's own real content — never by trying to make the inference itself smarter.
- Do not compare `quarantineFileRepoPathIdentity(final)` only against `clearIdentity` when deciding whether
  to trust a `foreignPending` match — also compare against the matched entry's OWN claimed identity, and
  (case b) against the entry THIS clear is itself lifting. Checking only `clearIdentity` is exactly the gap
  this card closes.
- Do not drop a stale pending pair by a precomputed index — resolve `pendingUnresolvedQuarantines.indexOf(...)`
  fresh, immediately before the splice (same reasoning as `9c681680`).
- Do not pass the stale `foreignPending.entry.repoPath` label to `protectOccupantContentBeforeDelete` once a
  genuinely different, THIRD identity has been confirmed from the file's own content (case c) — protect
  under what the content itself names.
- Do not assume `D`'s two pending records (correct and wrong) ever collapse to one via
  `listActiveMergeQuarantines()` — that function dedupes by OBJECT REFERENCE, and both records share the
  SAME `entry` object, so it can never distinguish "one pending record" from "two for the same entry." Use
  `listPendingMergeQuarantinesTestOnly()` (added by this card) for an assertion that needs the real count.
