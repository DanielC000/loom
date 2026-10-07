# a2f381dc — a same-identity union still orphaned a flushed pending ref, and the boot return deduped only half its own output

From Code Review `0a408575` of `fd189d91` (CR @ `4a5dfc92`), items M-1/M-2/m-3 — reproduced by this
card's own worker before any fix was written. `fd189d91`'s own round already fixed two spread-replace
sites (Phase 0's pending-protection map, PASS 2's orphan-reference merge); this card found the SAME bug
class still live at `armQuarantineKey`'s own union, plus an unrelated boot-return dedupe gap.

## M-1 — `armQuarantineKey`'s own union, for the SAME identity, still orphaned a flushed pending ref

`armQuarantineKey` (merge-quarantine.ts) deliberately excludes its own union from
`replaceEntryEverywhere` (`@decision fd189d91`), because `prior` and `entry` can be two DIFFERENT logical
identities sharing one key (a degraded occupant and the sibling that degraded-occupies it) — see that
record for the real regression (`round4-G2-...-clobbers-degraded-occupant`) an unconditional route caused.

But the exclusion was absolute, and `armQuarantineKey` is also reached for the SAME identity, read twice
from two sources: a ghost `X` (unresolvable, `resolvedKey: Kx`) whose own backing file lives at
`sha(Kx).json` (PASS 1's degraded branch), PLUS its own torn `sha(Kx).json.tmp-<pid>` residue (PASS 1b's
tmp loop, same `resolvedKey`). PASS 1's own `flushDegradedDiverts()` call (merge-quarantine.ts:~1809)
pushes a pending reference to `byRepoKey.get(Kx)` — PASS 1's own armed object — into
`pendingUnresolvedQuarantines`. PASS 1b then reads the tmp, calls `armQuarantineKey(byRepoKey, Kx,
tmpEntry)`, which unions with the PASS-1 object and produces a brand-new object (a plain object spread,
never a mutation) — orphaning PASS 1's already-flushed pending reference. PASS 1b's OWN
`flushDegradedDiverts()` call then pushes a SECOND pending reference, to the new post-union object. The
two references are not reference-equal; `listActiveMergeQuarantines`'s own by-reference Set-dedup reports
X twice, stable across reboots (both references are durable `pendingUnresolvedQuarantines` entries).

### The fix — identity-conditional, not absolute

```ts
if (prior && directPathIdentity(prior.repoPath) === directPathIdentity(armed.repoPath)) {
  replaceEntryEverywhere(byRepoKey, prior, armed);
}
```

Compare `prior.repoPath` against `armed.repoPath` (the union's OWN resulting identity —
`unionQuarantineEntries`'s "older" pick — never `entry.repoPath`, the raw second input). This is the
semantically correct comparison, not merely the simpler one: re-pointing every existing reference to
`prior` onto `armed` is safe exactly when `armed` still asserts `prior`'s own identity, because a future
query by `prior.repoPath` then resolves to data still describing that same repo. It is UNSAFE exactly when
the OTHER side (`entry`) wins the union's own tie-break — `armed.repoPath` then differs from
`prior.repoPath`, re-pointing would silently swap `prior`'s own identity out from under any existing
reference to it, and the condition above is false, leaving the (pre-existing, untouched) exclusion in
place. Comparing against `entry.repoPath` instead would give the WRONG answer for a two-identity
collision where `prior` itself wins the tie-break (see "Do not", below) — it was considered and rejected.

For the M-1 shape itself, `prior.repoPath` and `entry.repoPath` are the same string to begin with (the
same ghost `X`, read from two files), so `armed.repoPath` equals both regardless of which one wins
"older" — the condition is always true and the stale reference is correctly re-pointed.

### Verified against both tie-break orderings for the two-identity shape, not just the one `round4-G2` covers

`round4-G2-recovery-writeback-clobbers-degraded-occupant` (merge-quarantine-migrate-source-owner-durable.mjs)
only exercises "the sibling (the SECOND-arriving entry) wins the tie-break" — `armed.repoPath` ends up
being the sibling's, differing from the degraded occupant's own `prior.repoPath`, so the condition above
is false under EITHER candidate comparison (`entry` or `armed`) and the test alone cannot distinguish
them. A new scenario, `round4-G2-reversed-occupant-wins-union` (same file), flips the age order so the
DEGRADED OCCUPANT (`prior`) wins instead — asserting X's own queries resolve to the union (no data loss),
X's own pending reference is now reference-identical to the `byRepoKey` object (no split — the bug this
card's fix closes, under the occupant-wins ordering), and recording (not changing) the sibling's own
behavior in that ordering. Both `round4-G2` scenarios stay green under the real fix.

## M-2 — a DIFFERENT, pre-existing, accepted residual: a union that drops the losing side's own identity entirely

A degraded `X` at `Kx` (its own resolvedKey), plus an OLDER stale-named sibling `S` that currently
resolves to `Kx` itself and migrates there this boot. `Kx` is degraded-occupied by `X`, so `S`'s migrate
write is refused at boot (`@decision 97cff6db`) and `S`'s own data is folded into the shared in-memory
union plus given its own separate pending reference instead — `S` wins `unionQuarantineEntries`'s own
tie-break (older). At the END OF BOOT, nothing has actually been written to disk yet: `X`'s own backing
file at `sha(Kx).json` still carries only `X`'s own content, and `S`'s own stale file is still on disk,
untouched — the boot log's own "never deleted, never written" wording is accurate for THIS instant.

**The real operator impact is NOT the boot-time state above — it is what the FIRST RUNTIME QUERY does.**
Reproduced directly (not merely argued), on this branch and on main, with the same result on both:

(a) The first call to `activeMergeQuarantineFor(S)` (any query for `S`'s own, currently-resolvable,
repoPath) reaches the fast-path sibling absorb (`activeMergeQuarantineFor`'s own `direct` branch,
merge-quarantine.ts:1129, calling `consumeMatchedPendingsIntoArmedEntry` → `writeMergeQuarantineLatch(armed,
false, key)` at merge-quarantine.ts:551) — and THIS call **durably overwrites `X`'s own backing file at `sha(Kx).json`
with the S-identity union** (`repoPath: S`, tokens from both `S` and `X`) and unlinks `S`'s own
now-superseded stale file. After this single query, `X`'s identity is gone from disk for good — directly
contradicting the boot log's own "never deleted, never written" framing, which describes only the
boot-time state, not what the very next ordinary query does to it.

(b) `clearMergeQuarantine(X)` (X's own repoPath) after that first query: NOT FOUND —
`{wasQuarantined: false, reason: "no active or pending quarantine is stored under the exact repoPath
'<X>' — ..."}`. And `activeMergeQuarantineFor(X)` itself returns `undefined` (not `false` — corrected
wording; `undefined` is the function's own documented "no entry of its own" return, never a boolean).

(c) `clearMergeQuarantine(S)` after that same first query SILENTLY lifts `X`'s own token too — both are
now the SAME physical entry, so clearing `S` clears everything the union carries, with no indication to
the caller that an unrelated identity (`X`) was also just lifted.

**Enforcement itself does not fail open.** While the union stands (after the first query, before `S` is
cleared), `X`'s own token is still carried inside the SAME union object governing `Kx` — a query against
`Kx` (e.g. the merge gate's own quarantine check) still sees it and still blocks. The defect is
QUERYABILITY-by-own-path and CLEAR-GRANULARITY, not a silent loss of enforcement.

This is NOT the M-1 shape: it is a genuine two-different-identity union where the losing side's own
identity is not merely "not re-pointed" (M-1) but structurally UNREPRESENTED once a live query durably
commits the union — no per-site re-point can fix it, including this card's own M-1 fix (verified: M-1's
identity-conditional check is false here too, by the same logic that excludes `round4-G2`, so M-1's fix
does not touch this shape at all). The only real fix is redefining the module's own identity model (e.g.
over token sets rather than a single `repoPath`/`armedKeys` per object) — a structural rearchitecture,
not a scoped bugfix, and out of this card's scope.

**Known limitation, noted but not addressed here (nitpick, CR `baecb690`):** M-1's own identity check
uses `directPathIdentity` (merge-quarantine.ts:209), which is deliberately FROZEN and does NO filesystem
lookup for a non-existent path (see its own doc comment) — unlike the separate `ancestorAwarePathIdentity`
(merge-quarantine.ts:231), it does not normalize a junction/8.3-short-name alias. Two paths that denote
the SAME physical location but are SPELLED differently via such an alias would compare as different
identities under M-1's check, which only means a legitimate same-identity re-point could occasionally be
missed (fails toward the pre-existing, safe-but-split behavior) — never a false re-point. Not reproduced
or fixed here; worth knowing if a future report describes an M-1-shaped double-report that persists
despite the fix.

**Ruling: ACCEPT and DOCUMENT.** `assertQuarantineIdentityInvariantTestOnly`'s own doc comment (landed in
`fd189d91`/`50613de7`) already names this exact fixture as a known, pre-existing, by-design
counter-example — a violation here is the invariant doing its job against a case no current fix reaches,
not a sign the invariant itself is broken. Follow-up card filed: "X is unqueryable by its own path when it
loses a union" (discovered from `a2f381dc`) — a deliberately-scoped future redesign, not part of this
round. One narrower, NOT pursued, alternative is noted in that follow-up's own body: closing only the
"`S` reported twice" half (deduping `97cff6db`'s own double push) while still accepting "`X` zero times"
— left for that card to weigh, not decided here.

## m-3 — the boot RETURN VALUE deduped only half its own output

`reenterMergeQuarantinesAtBoot`'s own return statement (merge-quarantine.ts:~2549) was
`[...new Set(byRepoKey.values()), ...pendingUnresolvedQuarantines.map((p) => p.entry)]` — the `Set` only
dedupes WITHIN `byRepoKey.values()`; the pending side is concatenated afterward with no shared dedup. A
"self-divert" entry — armed in `byRepoKey` AND present, by the SAME object reference, in
`pendingUnresolvedQuarantines` via its own degraded divert (the documented "same object, two structures"
shape `listActiveMergeQuarantines` already handles correctly) — is therefore returned TWICE in the boot
return array specifically, even though `listActiveMergeQuarantines()` itself reports it once. `index.ts`'s
own boot-log line (`"N latch(es)"`) reads this count directly, so it over-reports by one for every
self-divert entry.

**The fix:** one `Set` over BOTH structures, mirroring `listActiveMergeQuarantines`'s own existing
pattern exactly:
```ts
return [...new Set([...byRepoKey.values(), ...pendingUnresolvedQuarantines.map((p) => p.entry)])];
```

## Do not

- Do not compare `prior.repoPath` against `entry.repoPath` (the raw second input) to decide whether
  `armQuarantineKey`'s union may re-point existing references to `prior` — compare against `armed.repoPath`
  (the union's own resulting identity) instead. The raw-input comparison gives the WRONG answer for a
  genuine two-identity collision where `prior` itself wins the tie-break: it would skip re-pointing
  (leaving the SAME split bug M-1 fixes, just one identity over — `prior`'s own flushed pending reference
  stays stale even though the union's result still legitimately asserts `prior`'s own identity).
- Do not treat M-2 as the same bug class as M-1/`fd189d91`'s item (d)/`a2f381dc`'s own PASS-2 trigger — it
  is a different shape (a union that drops the LOSING side's identity entirely, not a replace that merely
  forgets to re-point an existing reference) and `replaceEntryEverywhere` cannot reach it by construction
  (it re-points references to ONE object; M-2 has no surviving object representing `X`'s own identity to
  re-point TO). Do not attempt a per-site fix for it without first redefining the identity model.
- Do not revert the boot-return dedupe to `[...new Set(byRepoKey.values()), ...pending.map(...)]` — that
  reintroduces the self-divert double-count in the boot return specifically (index.ts's own "N latch(es)"
  log), even though `listActiveMergeQuarantines()` itself would stay correct.
- Do not loosen `clearMergeQuarantineByKey`'s own pending-filter identity gate (merge-quarantine.ts:937,
  `directPathIdentity(p.entry.repoPath) !== identity`) to match by key/armedKeys alone — it is what keeps
  a clear scoped to ONE identity (e.g. the occupant in M-1's reversed-tie-break shape) from also sweeping
  a DIFFERENTLY-identified sibling's own pending reference merely because both happen to be at-risk
  under/armed at the same key. Measured directly: dropping it turns a real, previously-green assertion RED.

## Verification

`merge-quarantine-identity-split-sync.mjs`: new scenarios `armqk-union-trigger-age-order-a` /
`armqk-union-trigger-age-order-b` (M-1 — ghost X's own final `.json` + own torn `.json.tmp-<pid>`, both
age orders between the two sources), `armqk-union-trigger-3boot-count-stable` (3-boot stability), and
`m3-boot-return-self-divert-dedupe` (m-3 — asserts the RAW boot return array, not
`listActiveMergeQuarantines()`, reports a self-divert entry exactly once). Each measured RED against the
fix reverted (M-1 scenarios: count 2, invariant violation naming 2 distinct objects; m-3: boot-return
array length 2 for the one entry) and GREEN restored.

`merge-quarantine-migrate-source-owner-durable.mjs`: new scenario
`round4-G2-reversed-occupant-wins-union` (the occupant-wins tie-break ordering `round4-G2` itself does not
cover) — X's queries resolve to the union, X's own pending reference becomes reference-identical to the
`byRepoKey` object (no split, asserted via report count), then CLEARED BY ID (`quarantineLatchFileIdsFor`
+ `clearMergeQuarantineLatchFile`, not just by repoPath) after the re-point, asserting `sub` STILL holds
its own token after a further reboot (CR `baecb690`, Minor 2 — this survival was previously only logged,
never asserted). `round4-G2-recovery-writeback-clobbers-degraded-occupant` itself re-verified GREEN,
unaffected.

Three behavioral RED proofs, all measured directly (not merely argued): dropping the identity condition
(re-pointing unconditionally whenever `prior` exists) turns `round4-G2-recovery-writeback-clobbers-degraded-occupant`
RED; removing the re-point entirely (reverting to `fd189d91`'s own absolute exclusion) turns the new M-1
scenarios RED; mutating `clearMergeQuarantineByKey`'s pending-filter (merge-quarantine.ts:937) to drop
every pending entry regardless of identity (a scratch `dist/git/merge-quarantine.js` edit, restored
byte-identical by checksum afterward) turns the new "sub still holds its own token after clearing X by
id" assertion RED — confirming that assertion can fail, not just that it currently passes.

M-2's own "real operator impact" section above was verified directly against the real compiled module
(ad-hoc scratch scripts, not committed — the shape is already covered by the existing
`merge-quarantine*.mjs` corpus's own boot-time behavior; no new test was added for M-2 itself per the
ACCEPT-AND-DOCUMENT ruling), confirming (a)/(b)/(c) and the corrected `activeMergeQuarantineFor` return
value (`undefined`, not `false`) match the Code Reviewer's own findings exactly.
