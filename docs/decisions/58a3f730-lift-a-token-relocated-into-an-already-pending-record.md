# 58a3f730 — lift a cleared token relocated by the pre-existing protect/relocate path into an already-pending record

Found by a Code Reviewer during card `028837ad` (2026-10-29), explicitly named there as its own S-1 —
"a fail-closed strand via the relocate-foreign-occupant path (`c9114934`/`d4b25feb`) when the identity was
already pending at call start" — and carded separately on this id per the Lead's own ruling at the time.
Confirmed pre-existing: the SAME hermetic repro, re-run against `62f88046` (a scratch `git worktree`
checkout, built independently, `62f88046` predates `028837ad` entirely) reproduces byte-identically.

## The bug

`clearMergeQuarantineByToken` (`merge-quarantine.ts`) captures `identitiesPendingBeforeCall` at the TOP of
the function — every identity with ANY pending representation at call start — and uses it to exclude those
identities from the post-active-loop pending sweep (`postArmPendingIndices`, card `028837ad`'s own second
pass). That exclusion's safety argument was scoped entirely to `armForeignOrphanContentInMemoryIfUnenforced`
(which only ever arms a ZERO-representation identity, so excluding an already-represented one can never
exclude the real target) — it never covered the PRE-EXISTING protect/relocate-foreign-occupant mechanism
(`c9114934`/`d4b25feb`, `protectOccupantContentBeforeDelete`'s own `atFilenameSameIdentity` union branch,
`merge-quarantine.ts:3708-3716`), which can MUTATE an already-pending identity's EXISTING record mid-call,
folding the just-cleared token into it.

Reproduced directly (hermetic, own `LOOM_HOME`, real git repos, real `enterMergeQuarantine`/
`clearMergeQuarantineByToken`/`reenterMergeQuarantinesAtBoot` calls — no hand-set derived fields): R is
raised and resolvable (single token `tR`). X is raised INDEPENDENTLY FIRST (its own real token `tX`) —
already genuinely pending at `clearMergeQuarantineByToken(R, tR)`'s own call start. A `.json.tmp-<pid>`
residue is then planted at R's own canonical-key hash, naming X with tokens `[tR, tF2]` — modelling a
crash-left degraded-collision write sharing R's toplevel key before X's own later raise resolved
independently to its own identity hash. The clear's own full lift of R discovers this residue via the
relocate path (confirmed by its own distinct "... also relocated 1 foreign co-occupant(s) ..." log line)
and merges `[tR, tF2]` into X's ALREADY-LIVE pending record, at the SAME physical filename X's own
canonical pending record already occupies. Because X's identity was already in
`identitiesPendingBeforeCall`, the post-loop pass skips it entirely — even though X's record, as of right
now (same call), genuinely holds the just-relocated `tR`. Confirmed fail-closed and PERMANENT: X stays
blocked on `tR` both in-process and after a reboot taken right after, and even after X's own two genuinely
real tokens (`tX`, `tF2`) are both separately cleared later — `tR` is a dead raiser's token with no holder
left able to clear it short of a human `/clear`.

## The fix

Narrow what `identitiesPendingBeforeCall` captures, from "any pending representation at call start" to "a
pending record that ALREADY held `token` at call start" — one filter added to its construction:

```
const identitiesPendingBeforeCall = new Set(
  pendingUnresolvedQuarantines.filter((p) => p.entry.tokens.includes(token)).map((p) => directPathIdentity(p.entry.repoPath)),
);
```

No other line changes — the post-loop predicate (`postArmPendingIndices`) and its identity-keyed (never
record/reference-keyed) exclusion stay exactly as they are; only the SET fed into it narrows.

**Why identity-keyed, not record-keyed (the reviewer's alternative direction), survives `3315b08a`'s own
ambiguous multi-record identity (its S3a scenario) unchanged:** a record/reference-keyed exclusion cannot
work here at all — `protectOccupantContentBeforeDelete`'s own `atFilenameSameIdentity` branch ASSIGNS a
brand-new wrapper object into the array slot it mutates (never splices), so BOTH the bug's own merged
record (X's) and `3315b08a`'s own ambiguously-reassigned record (Y's canonical slot) are, by the time the
post-loop pass runs, objects that were never present at call start — a reference snapshot could not tell
them apart. The identity-keyed set, narrowed to "held `token` already," correctly separates the two cases
instead: in `3315b08a`'s S3a, Y's canonical slot DID hold the cleared token at call start (the scenario's
own deliberately-shared token), so Y's identity stays in the (now narrower) set and BOTH of Y's live
records stay excluded from the post-loop pass exactly as before — the pre-loop pass's own
`clearTokenFromPendingIndices` re-resolve-by-identity ambiguity fail-closed branch is what actually decided
to leave Y's canonical slot untouched (still holding the token) a moment earlier; the post-loop exclusion's
job is only to never give that identity a "second bite" once the ambiguity is already settled. In this
card's own bug, X's identity held only `[tX]` at call start — never `tR` — so X's identity is NOT in the
narrowed set, and the post-loop pass is free to catch X's post-relocate record and correctly lift `tR`.

Every scenario in both `028837ad`'s own test file and `3315b08a`'s own test file was traced by hand against
the narrowed filter before this fix was written (not merely argued): every foreign identity the arm/relocate
helpers touch in `028837ad`'s own ORPHAN / TMP-RESIDUE-RELOCATE / PENDING-A / CONTRIB-ORPHAN / CONTRIB-TMP /
RESOLVEDKEY / EPERM-UNION / MULTI-EPERM scenarios has ZERO pending representation at call start at all
(brand new) — narrowing "any representation" to "held token" changes nothing for any of them, since they
were never excluded for holding the token in the first place (they were excluded, pre-fix, for mere
presence, which they never had). `028837ad`'s own TWIN GUARD scenario's twin already holds the cleared
token at call start, same outcome as today.

**Also verified directly, not merely traced, for a genuine TWO-INDEPENDENT-RECORDS shape neither of
028837ad's own scenarios nor 3315b08a's own S3a construct** (X with a canonical slot and an untouched
twin, same identity, DIFFERENT sourceFiles, NEITHER holding the cleared token before the call, with the
relocate merging into the canonical slot only): the twin survives completely untouched — no splice, no
collapse, no cross-contamination — while the canonical slot correctly has the relocated token lifted,
leaving its own real tokens intact. See "Tests" below.

## Do not

- Do not widen `identitiesPendingBeforeCall` back to bare pending presence — that is the exact defect this
  card fixes; a presence-only exclusion strands a token the relocate path folds into an already-pending
  record mid-call, permanently (no human route reaches this path at all — see the relocate mechanism's own
  logging comments).
- Do not key this exclusion by pending-record REFERENCE or sourceFile instead of identity — the relocate
  path (and `3315b08a`'s own ASSIGN shape) both replace the array slot's object wholesale mid-call; neither
  a reference snapshot nor a sourceFile snapshot taken at call start would still be meaningfully
  comparable against the post-relocate object, and `3315b08a`'s own ambiguous-identity protection
  fundamentally depends on BOTH of an identity's records being excluded together, not just the one that
  happened to hold the token.
- Do not assume the multi-record (canonical + twin) shape needs its own splice-hazard fix — `collectPendingIndices`'
  predicate is a per-entry `.tokens.includes(token)` check; an untouched twin that never holds the cleared
  token is never selected regardless of the identity exclusion's own membership, so there was nothing to
  fix there once the identity-level narrowing was correct. Verified directly rather than assumed (see
  "Tests").
- Do not construct a "two independent pending records sharing one identity" test scenario via a real
  in-process raise sequence — a second real raise for the same identity merges into the SAME existing
  record (`mergeTokenIntoPendingEntries`); use the `reenterMergeQuarantinesAtBootTestOnly` injection seam
  instead, the same technique `3315b08a`'s own S3a scenario uses, since this shape is a
  boot/crash-recovery-time artifact no real raise sequence constructs.

## Tests

`merge-quarantine-58a3f730-relocate-into-existing-pending.mjs`:
- (STRAND) the card's own repro: X pre-pending via its own independent raise, tmp residue at R's hash
  relocates `[tR, tF2]` into X's existing record — `tR` lifted within the same call, durable after a
  reboot, and X's own later clears of its real tokens (`tX`, `tF2`) fully unblock it (no permanent strand),
  durable after a further reboot too.
- (MULTIRECORD) X has two independent pending records (canonical + untouched twin, neither holding `tR`
  before the call) — the relocate merges into the canonical slot only; the twin survives completely
  untouched (tokens, sourceFile, on-disk bytes), the canonical slot correctly lifts the relocated token,
  X's own real tokens still block it, and a reboot agrees.
- (AMBIGUOUS, NO REGRESSION) `3315b08a`'s own S3a shape reproduced directly in this file: Y's canonical
  slot already holds the to-be-cleared token at call start, alongside an untouched twin holding a private
  token — both must stay excluded and untouched, exactly as before this fix (this scenario is expected to
  pass on BOTH sides of the fix; it pins what must never change, not what the fix changes).

RED proof: `negative-control --ref c8cff22f002fb27cc647858a2cc6ed61e29ccc64` (the full pre-fix sha) — the
STRAND and MULTIRECORD scenarios' own checks RED specifically (the exact permanent-strand shape this card
fixes); the AMBIGUOUS scenario stays GREEN on both refs, confirming it is a non-regression pin, not
coverage of this fix.
