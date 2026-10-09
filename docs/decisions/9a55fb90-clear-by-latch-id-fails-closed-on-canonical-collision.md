# 9a55fb90 — clear-by-latch-id fails closed when a different, resolvable identity also owns the key

From Code Review of `c9114934`, finding #4 — `clearMergeQuarantineLatchFile(id)` passes its matched
entry's own `repoPath` as `clearMergeQuarantineByKey`'s `identityRepoPath` argument, so `clearingRepoPath`
inside that function is a tautological comparison (`entry.repoPath !== entry.repoPath` is always false)
and is always `undefined` — `protectDegradedOccupantBeforeDelete` can never run via this path, no matter
what currently occupies the matched key.

## The shape, and why "pick the other identity" is wrong

`X` (unresolvable, a stale/manufactured `resolvedKey` walking to `Ky`) is armed directly at `Ky`. `Y`
(resolvable, genuinely owns `Ky`) gets its own migrate-write refused (the key is degraded-occupied) and is
tracked as a standalone pending entry instead. A canonical-repo mutation against EITHER `X` or `Y` is
refused by `assertRepoNotQuarantined`, and — this is the load-bearing fact — **both refusals are
byte-identical**: `resolveQuarantineFor(Y)` falls through to `activeMergeQuarantineFor(Y)`, whose `direct`
tier returns `X`'s own entry unconditionally once `isKeyVerifiedFor(X, Ky)` is false (it never even looks
at `Y`'s own pending sibling); `resolveQuarantineFor(X)` resolves to the same `X` entry via
`ownIdentityEntryFor`. Both refusals therefore name `blocking repo 'X', latch id 'hash(Ky)'`.

An earlier round of this fix picked "the other, resolvable canonical sibling" (`Y`) as the identity to
clear whenever exactly one such sibling existed, reusing `clearMergeQuarantineByKey`'s existing
protection/sweep machinery. **This was rejected by Lead ruling.** Since `X`'s own refusal text is
identical to `Y`'s, a human reading `X`'s refusal and using its id to resolve `X`'s OWN issue would be
silently redirected into clearing `Y` instead — leaving `X` quarantined for a human who meant `X`. The
id alone cannot discriminate "I mean the entry armed here" from "I mean the other identity whose refusal
happened to name this same id", and guessing either way is wrong for the other case.

## The fix: FAIL CLOSED, not "pick one"

`canonicalSiblingsFor(key, ownIdentityRepoPath)` (`git/merge-quarantine.ts`) finds every pending entry
whose own `repoPath` is CURRENTLY RESOLVABLE and whose freshly-computed `canonicalRepoLockKey` equals
`key`, excluding whichever entry shares `ownIdentityRepoPath`'s own `directPathIdentity`. A non-empty
result means the id is genuinely ambiguous right now.

- `clearMergeQuarantineLatchFile`'s active-match branch calls this BEFORE delegating to
  `clearMergeQuarantineByKey`. A non-empty result refuses the clear outright (`{ok:false, reason}`,
  naming every candidate repoPath) — nothing is deleted, nothing is diverted, both identities stay exactly
  as they were. An empty result (the overwhelming majority of real clears — no collision at all) proceeds
  exactly as before: `clearMergeQuarantineByKey(key, activeMatch.entry.repoPath)`, unchanged.
- `assertRepoNotQuarantined` and `clearMergeQuarantineReporting` both call `canonicalSiblingsForLatchId`
  (see round 2 below for why this is a dedicated wrapper, not `canonicalSiblingsFor(q.armedKeys?.[0], …)`
  directly) to decide whether to offer the bare-id clear shortcut in their refusal text at all. When a
  collision exists, each drops the `{id: latchId}` suggestion and names only `clear-by-path
  {repoPath: q.repoPath}` — the route that already discriminates correctly
  (`clearMergeQuarantineByRecordedPath`/`clearMergeQuarantine` pass the HUMAN-SUPPLIED repoPath,
  independent of whatever entry occupies the resolved key, so `protectDegradedOccupantBeforeDelete`
  already runs there whenever the occupant differs — this is `c9114934`'s own, already-working mechanism,
  confirmed by its own passing `in-memory-twin-clear-destroys-degraded-file` test; no change was needed on
  that path for this card).

Both call sites read the identical helper, so they can never disagree about when a bare id is unsafe.

## Do not

- Do not pick one of the colliding identities (even "the resolvable one") as a fallback clearing target
  for clear-by-id — see "why 'pick the other identity' is wrong" above. Refuse instead.
- Do not narrow `canonicalSiblingsFor` to exclude a `.tmp-safety-`-shaped pending entry (or any other
  sourceFile shape) to make a specific existing test pass — see "a second collision route exists" below;
  the same ambiguity is reachable through more than one mechanism, and the fix must stay mechanism-blind.
- Do not derive the collision check from `activeMatch.entry.repoPath`'s own freshly-recomputed canonical
  key — it is unresolvable by construction in the shape this card addresses (that is WHY it is degraded),
  so there is nothing to recompute. Compare candidate PENDING siblings' own canonical key against the
  `key` the matched entry is actually ARMED at instead.
- Do not reach for this check anywhere `clearMergeQuarantineByKey`'s `identityRepoPath` already comes from
  a human-supplied, independent repoPath (`clearMergeQuarantineByRecordedPath`/`clearMergeQuarantine`) —
  that route already discriminates correctly by comparing the supplied identity against whatever actually
  occupies the key; this collision only exists for the bare-id route, which has no independent identity to
  compare against at all.
- Do not restate `clearMergeQuarantineByKey`'s own pending-sweep logic at the clear-by-id call site — it
  does not need one. The sweep only ever needs to run on the `clear-by-path(Y)` route, which already does
  it (folds `Y`'s own stale source file into the shared union's `orphanLatchFiles`, swept by
  `clearMergeQuarantineByKey`'s existing identity-matched pending filter) — confirmed already passing.
- Do not derive the key to check siblings against from `entry.armedKeys?.[0]` in any TEXT-producing
  caller (round 2, finding 2) — derive it from the SPECIFIC armed key that hashes to the OFFERED latchId
  (`canonicalSiblingsForLatchId`), or a dual-armed entry can make the text and the actual clear-by-id
  disagree about the same id.
- Do not treat an empty `canonicalSiblingsFor`/`canonicalSiblingsForLatchId` result as proof of "no
  ambiguity" in general (round 2, residual) — it only scans `pendingUnresolvedQuarantines`; a sibling
  unioned into the active entry at runtime (`enterMergeQuarantine`'s `existing` branch) is invisible to
  it. See "known residual" below before relying on this for a NEW runtime union path.

## A second collision route exists — reached via safety-tmp recovery, not migrate-refusal

`merge-quarantine-migrate-source-owner-durable.mjs`'s `round4-G2-reversed-occupant-wins-union` (card
`97cff6db`/`a2f381dc`, CR `baecb690`) hits this SAME ambiguity through a DIFFERENT mechanism: `X`
(degraded, `resolvedKey=Ksub`) and `sub` (a real, resolvable nested repo whose own canonical key genuinely
IS `Ksub`) collide via the same-boot safety-tmp-recovery path (`ef651188`/`97cff6db`) rather than PASS 1's
plain migrate-refusal — the attempted union re-persist fails that boot, leaving `sub` as its own
independent, currently-resolvable pending record (`sourceFile` a `.tmp-safety-...` residue). Traced and
confirmed: `assertRepoNotQuarantined(sub)` resolves to the exact same `q` object/latch id as
`assertRepoNotQuarantined(x)` — the identical byte-identical-refusal shape this card's own X/Y
verification established. `canonicalSiblingsFor` correctly (and deliberately) flags this too, since it
scans `pendingUnresolvedQuarantines` by resolvability + canonical-key match, never by HOW the pending
record got there. **Do not narrow the predicate to exclude `.tmp-safety-`-shaped pending entries** — that
would silently reopen the exact hole this card fixes for any collision reached via the safety-tmp-recovery
route instead of the plain migrate-refusal route; the human-facing refusal text is byte-identical either
way, so the risk is identical either way too.

That scenario's own clear-by-id step was updated to assert the refusal (deletes nothing, names
clear-by-path) followed by a `clearMergeQuarantine(x)` (clear-by-path) call, which still achieves the
scenario's original intent — `sub` survives with its own token, migrates to its own canonical key once
`Ksub` is vacated, and stays correct across a further reboot — confirmed by probe before editing the test
(`clearMergeQuarantine(x)` in that exact state lifts `X` cleanly with no collateral effect on `sub`).

## Round 2 (CR `e31c5809`) — offered-id/sibling-check mismatch for a dual-armed entry, a leftover nit, and a known residual

**Finding 2 (MAJOR-adjacent): the refusal text checked siblings at `q.armedKeys?.[0]`, but the id it
offers is `quarantineLatchFileIdsFor(q)[0]`, which is sorted REAL-FILE-FIRST, never `armedKeys` order.**
For an entry armed under two keys (PASS 1's dual-arm branch — a resolvable entry whose stored
`resolvedKey` differs from its freshly-computed current key — `git/merge-quarantine.ts` ~2272-2276), the
two can name DIFFERENT keys: `armedKeys[0]` and the sorted-first id can legitimately disagree whenever
one key's own physical file exists and the other's doesn't. If a sibling collides at the key the
OFFERED id actually names (not `armedKeys[0]`), the OLD text-side check would silently find NOTHING
(wrong key) and offer the id as if safe, while `clearMergeQuarantineLatchFile` — which resolves ITS OWN
key directly from the SAME offered id, never from `armedKeys[0]` — would correctly refuse it. Text says
safe; the id it names is not. **Fix:** `canonicalSiblingsForLatchId(entry, latchId)` — finds the
specific armed key whose hash equals `latchId` (`entry.armedKeys?.find(k => quarantineHashForKey(k) ===
latchId)`), falling back to `armedKeys?.[0]` only when no armed key matches at all (defensive; should not
happen for a real latchId) — and both refusal-text call sites (`assertRepoNotQuarantined`,
`clearMergeQuarantineReporting`) now call this instead of indexing `armedKeys` directly. This keeps every
text-producing caller evaluating the IDENTICAL `(key, ownIdentity)` predicate input
`clearMergeQuarantineLatchFile` itself will use when a human acts on that same offered id.

Test: `dual-armed-sibling-at-non-first-key-text-and-id-agree` in
`merge-quarantine-pass1-migrate-union.mjs`. Constructing the disagreement needed TWO independently
empirically-verified facts, not assumed ones — see that scenario's own header comment for the full
derivation: (1) which side of a dual-arm union ends up FIRST in `armedKeys` is controlled by WHICH side
`unionQuarantineEntries` treats as "older" (older's own `armedKeys` land first in the merged array), not
by file read order; (2) by default BOTH of a dual-armed entry's own physical files exist after a normal
boot (each `armQuarantineKey` call writes its own key), so the file-exists sort is a no-op TIE that
happens to preserve `armedKeys` order — reproducing the real disagreement needed deliberately forcing one
physical file missing and a stand-in present at the other, never relying on an unassisted boot sequence
to produce it. RED on pre-round-2 `HEAD` (confirmed via `negative-control`): the TEXT check fails to flag
the ambiguity (checks the wrong key) while clear-by-id on that SAME id still correctly refuses — the exact
disagreement this finding describes. GREEN after.

**Nit: `clearMergeQuarantineReporting`'s leftover-blocker message offered `{id: latchId}`
unconditionally**, the same bare-shortcut defect `assertRepoNotQuarantined` had, just in a different
caller. Routed through the SAME `canonicalSiblingsForLatchId` helper — never a second, independently
re-derived check.

**Known residual, named rather than silently left unnoticed: `canonicalSiblingsFor` only scans
`pendingUnresolvedQuarantines`.** A sibling whose token was UNIONED into the active entry at RUNTIME
(`enterMergeQuarantine`'s own `existing` branch, ~line 937 — not a boot-time path) is invisible to it —
an empty result from `canonicalSiblingsFor`/`canonicalSiblingsForLatchId` therefore does NOT prove there
is no ambiguity in general, only that none is visible among currently-pending entries. Today this residual
is masked by a separate, stray durable write along that same runtime path (observed, not yet carded under
its own id at the time of this writing) that keeps such a collision from surviving as a genuinely separate
identity in practice. Follow-up cards (filed by the Lead, ids not finalized at this writing — see the
board): one for the stray union write itself, and a second for union PROVENANCE tracking more generally
under `398f476c`'s own identity-model redesign (the same structural gap `a2f381dc`'s M-2 and `c9114934`'s
own "Hook 2" scope note both already point at). Do not read this card as having closed that gap — it
closes the two mechanisms (migrate-refusal, safety-tmp-recovery) that currently leave a GENUINELY separate
pending record behind; a future mechanism that unions instead of diverting would need its own fix here.

## Verification

New scenarios in `packages/daemon/test/merge-quarantine-pass1-migrate-union.mjs`: the same X/Y fixture as
`in-memory-twin-clear-destroys-degraded-file`, but clearing by `quarantineHashForKey(ky)` (the bare id)
instead of `clearMergeQuarantine(y)`. RED on pre-fix `HEAD` (confirmed via
`negative-control --file packages/daemon/src/git/merge-quarantine.ts --test
packages/daemon/test/merge-quarantine-pass1-migrate-union.mjs`): the id-based clear hard-deletes `X` with
no protective copy, and `Y`'s own stale source file is never swept. GREEN after: the clear is refused,
`X`'s physical file and in-memory entry are untouched, `Y`'s own pending entry is untouched, and both
`activeMergeQuarantineFor(x)` and `activeMergeQuarantineFor(y)`-shaped checks still read blocked. A second
scenario pins the ordinary, non-colliding clear-by-id path stays byte-identical (still succeeds, still
deletes, no spurious refusal). A third asserts `assertRepoNotQuarantined`'s refusal text for both `x` and
`y` in the collision shape names `clear-by-path` and omits the bare `{id}` suggestion, while an ordinary
(non-colliding) refusal still offers both. `round4-G2-reversed-occupant-wins-union` (updated, see above)
covers the second collision route end to end, including the clear-by-path follow-up and 2-further-reboot
stability.
