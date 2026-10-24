# d69a6744 — the last two `armedKeys`-only consumers `1fc3a561` left untouched, widened via `liveArmedKeysOf`/`entryStillOwnsKey` — site 2 is a real, reproduced FAIL-OPEN

From the Code Review of `1fc3a561` (finding S1). Two sites in `packages/daemon/src/git/merge-quarantine.ts`
still read `entry.armedKeys` alone (line numbers as of `c7bd3663`, the card's own parent):

1. `ambiguousIdentitiesForLatchId` (~:531): `entry.armedKeys?.find(k => hash(k)===latchId) ??
   entry.armedKeys?.[0]`. For a re-pointed twin (`armedKeys:[]`) this resolves `key=undefined`, so
   `siblingRepoPaths` is always `[]` regardless of a real canonical collision.
2. `writeMergeQuarantineLatch`'s `freshSecondaryKeys` (~:1399): `(entry.armedKeys ?? []).filter(k => k
   !== ownKeyForWrite)`. This persists `resolvedKey`/`resolvedKeys` from `armedKeys` alone — a stale
   member here can be a key belonging to a totally different, currently-registered repo.

## Investigation — required checkpoint before any fix (worker_report blocked, Lead ruling obtained)

**Site 1 is advisory-TEXT only, confirmed NOT fail-open.** Both of its two call sites
(`assertRepoNotQuarantined`'s `clearGuidance`, `stillQuarantinedReason`'s `clearByIdSuggestion`) only
shape the WORDING of an already-decided refusal/still-quarantined report. The REAL clear-by-id decision
(`clearMergeQuarantineLatchFile`'s active-match branch, ~:5486) calls `ambiguousIdentitiesFor(activeMatch.key,
...)` — a DIFFERENT function that already has the correct key from its own `activeQuarantines` map scan,
never derived from `armedKeys` at all. A wrongly-offered bare-id shortcut, if followed, still gets
correctly refused by the real route. Fixed anyway for text accuracy (the Lead's own ruling), since it is
low-risk and matches `1fc3a561`'s own established pattern.

**Site 2 IS a real, reproducible FAIL-OPEN** — proven end-to-end through the real exported functions, with
a reboot via a cache-busted dynamic re-import of the compiled module IN THE SAME PROCESS, on the same temp
`LOOM_HOME` (never merely argued, and never an actual OS process restart — see the Verification section's
own note on this) — in TWO constructions, named after the committed test's own Scenario numbers:

- **Scenario 2 (the active-only dual-key twin, no pending record at all)**: a degraded twin armed by
  reference at two keys, with stale `armedKeys:[kF]` where `kF` genuinely belongs to a separate, real,
  REGISTERED repo F. After a reduce-clear (through `clearMergeQuarantineByToken` →
  `clearActiveEntryTokenAtKey`, which has no pending-divert backstop), both of the twin's own physical
  latches persist `resolvedKey`/`resolvedKeys` = `kF`. On the very NEXT REBOOT — no clear of anything
  ever run — PASS 1's degraded-arm re-resolve logic (`armKeyUnlessDegradedCollision`, driven by
  `informativeKeysFor`) reads that bogus key and, because it genuinely belongs to a REGISTERED repo, takes
  the "legitimate same-toplevel union" branch: it durably UNIONS the twin's own still-outstanding token
  into F's genuine active entry at `kF`. Two confirmed consequences: (a) the twin's OWN quarantine becomes
  COMPLETELY UNREACHABLE by its own identity immediately after reboot (`assertRepoNotQuarantined` on it
  returns `ok:true` before any clear at all — its real quarantine is silently lost); (b) F's own tokens
  array now contains the twin's foreign token. **Load-bearing precondition, empirically verified in the
  committed test (never assumed):** this specific consequence (a) only manifests when PASS 1 processes
  F's OWN latch file BEFORE the twin's degraded files — whichever side reaches the shared key first
  becomes `prior` in `armQuarantineKey`'s own union, and `prior`'s identity is what survives; the twin
  arriving first instead keeps the twin's OWN identity queryable (no outcome (a)), though the underlying
  write bug and the contamination (b) are unaffected by ordering either way. The committed test forces
  this via `keyHashSortingAfter` (same `fs.readdirSync`-is-plain-alphabetical technique
  `merge-quarantine-pass1-migrate-union.mjs`'s own `empiricalOrder`/`placeStaleBeforeFixed` already
  established), with its own on-disk order asserted, not assumed.
- **Scenario 3 (the pending twin, `tiedViaKeyOrOrphanRef` reduce shape)**: the same underlying write bug
  and the same contamination at `kF`, but this twin shape always ALSO durably writes an independent
  pending-divert record for the twin (`writePendingDivertFile`, a mechanism wholly UNRELATED to this
  bug) — and THAT record is what keeps the twin itself durably BLOCKED after reboot, regardless of
  whatever the (still-contaminated) active union at `kF` does. So Scenario 3 does NOT reproduce outcome
  (a) above (the twin stays queryable throughout, by design of its own backstop) — its own distinct,
  still-real consequence is narrower: clearing F by its OWN token (`clearMergeQuarantineByToken`) no
  longer fully unblocks F — F stays wrongly STRANDED, blocked by a token it never owned, until a human
  separately discovers and clears the twin's foreign token too.

Neither construction needed an exotic setup — both are reachable through ordinary, already-exported clear
routes once `armedKeys` carries a stale foreign key, which the file's own pre-existing, deliberately-open
root cause (`protectOccupantContentBeforeDelete`'s re-point never stamps `armedKeys`; see `8db913e2`) is
already known to produce.

## The fix

Both sites now derive their candidate key set from LIVE occupancy via `liveArmedKeysOf(entry)` — the SAME
shared helper `6be6c9ff`/`c52b290e`/`1fc3a561` already established — never bare `entry.armedKeys`:

- Site 1: `const liveKeys = liveArmedKeysOf(entry); const key = latchId ? (liveKeys.find(k =>
  quarantineHashForKey(k) === latchId) ?? liveKeys[0]) : undefined;`
- Site 2: `const freshSecondaryKeys = liveArmedKeysOf(entry, ownershipMap).filter(k => k !== ownKeyForWrite
  && entryStillOwnsKey(k, entry, ownershipMap));` — ADDITIONALLY filtered through `entryStillOwnsKey`,
  unlike site 1: this is a WRITE site (it durably persists what it computes), so a stale/foreign member
  must never merely be unioned-in — it must be excluded. `entryStillOwnsKey` admits a key via either
  reference equality OR a same-identity, token-subset occupant — proven (Scenario 4 below) to still
  correctly retain a LEGITIMATE secondary key via either admission path. **This is NOT a claim that the
  filter never drops a secondary** — it DOES drop one whose slot is currently empty, or held by a
  same-identity occupant that is NOT (yet, or ever) a token subset at write time (a real exclusion, not a
  bug). The actual safety bound is `unionResolvedKeysRetaining`'s own retention: any key already present
  in `entry.resolvedKeys` survives the union regardless of what `freshSecondaryKeys` computes this time —
  no reverse fail-open (a legitimate secondary silently, permanently lost) was found at any write site
  tested.

**Boot-time correction (found by the full-corpus verification step, not by review):** `entryStillOwnsKey`/
`liveArmedKeysOf` default to reading the module-global `activeQuarantines` map — correct for every
existing (runtime-only) caller, but WRONG for `writeMergeQuarantineLatch`'s own `bootWriteLatch` caller:
`reenterMergeQuarantinesAtBootImpl` builds a LOCAL `byRepoKey` map and only copies it into
`activeQuarantines` once, at the very end of the whole boot function (`for (const [key, entry] of
byRepoKey) activeQuarantines.set(key, entry);`) — long after every boot-time write has already run. A
boot-time write that reached the live-occupancy filter against the stale, not-yet-synced
`activeQuarantines` therefore saw NONE of that same boot pass's own in-progress arming, including a key
this very entry was *genuinely, freshly* dual-armed at this boot (the `8bff3cae`
`shared-ancestor-sibling-survives-divergence` scenario's own `staleKeyRetentionCandidates` mechanism,
which arms a migrated entry at BOTH its new key and a still-live sibling key via `byRepoKey` directly) —
wrongly excluding that live secondary and reopening `8bff3cae`'s own regression on the VERY NEXT reboot
after the fix's own first write. Fixed by giving `entryStillOwnsKey`/`liveArmedKeysOf` an optional `map`
parameter (default `activeQuarantines`, byte-identical for every existing call — see the "Do not" entry
on why these two stayed optional) and `writeMergeQuarantineLatch` a REQUIRED `ownershipMap` parameter (no
default — same precedent as `58957b1e`'s own `droppedTokens`: a forgotten argument here has been shown to
fail open, so every one of its ~9 call sites now passes it explicitly: every runtime caller passes
`activeQuarantines`, and `bootWriteLatch` — the ONE caller reachable during boot — passes its own
closure-captured `byRepoKey`). Caught by this card's own DoD (the full `merge-quarantine*.mjs` corpus
run), not by code review — see `merge-quarantine-pass1-migrate-resolvedkey-8bff3cae.mjs`'s own
`shared-ancestor-sibling` scenario, the one that went red.

## The resolvedKeys-retention residual — CLOSED at the fold-in by `f575cebf`; the PASS1 upgrade case stays open on `e7652e06`

`unionResolvedKeysRetaining(entry.resolvedKeys, freshSecondaryKeys, ...)` unions TWO sources. This card's
own fix only cleaned the SECOND (`freshSecondaryKeys`, ownership-filtered). The FIRST, `entry.resolvedKeys`
itself (the in-memory field), is retained FOREVER by design (`8db913e2`/`43cf3b26`'s own union-never-drop
rule) — `f575cebf` proved the gap this left open was real and reproducible: an EARLIER write persisting a
foreign key into `resolvedKeys`, folded back into memory by `reconcileMarkedBasenameBeforeWrite`/
`foldInOnDiskTokensIfMarked` (card `150aed7b`), re-persisted the contamination and caused a confirmed
cross-repo identity/token bleed and stranding on the very next reboot. **`f575cebf` closed this AT THE
FOLD-IN** — every newly-folded on-disk key is now filtered through `positivelyForeignKey` (drop ONLY a key
with a live, different-identity occupant; never a merely-unprovable one, which would reopen the
union-never-drop rule in the other direction) before it ever reaches `entry.resolvedKeys`.
`f575cebf`'s own investigation ALSO confirmed a SEPARATE, still-open "upgrade case" the fold-in fix cannot
reach: a latch already contaminated on disk before ANY fold-in runs is unioned by PASS1's own
`armKeyUnlessDegradedCollision` ("legitimate same-toplevel union" fallthrough, which has NO identity check
when both colliding sides are resolvable — it DOES compare `directPathIdentity` between two
resolvable-but-different repos, ~:6131, but only reaches that comparison when exactly one side is
unresolvable) — independent of how the contamination got there. That is tracked on the Lead's separate
card `e7652e06`, not this one or `f575cebf`.

## Do not

- Do not pass `activeQuarantines` as `writeMergeQuarantineLatch`'s own (REQUIRED) `ownershipMap` argument
  from inside `reenterMergeQuarantinesAtBootImpl` — `activeQuarantines` is correct for every RUNTIME
  caller but structurally stale for any write that happens before that function's own end-of-function sync
  loop runs; pass its local `byRepoKey` instead. Same rule for any NEW call to `entryStillOwnsKey`/
  `liveArmedKeysOf` added inside that function — pass `byRepoKey` explicitly (their own `map` parameter
  stays optional/defaulted, see below, so a forgotten explicit pass there silently falls back to the
  stale default — a real residual risk, not closed by this card; a reviewer touching that function should
  grep for both helpers, not just `writeMergeQuarantineLatch`).
- Do not have `protectOccupantContentBeforeDelete`'s own re-point stamp `armedKeys` onto `written.entry`
  as "the" fix for this shape — same prohibition `1fc3a561`/`c52b290e` already state, for the same reason
  (it covers only one of 20+ `replaceEntryEverywhere` sites in this file). This card never unions an OLD
  object's list forward either — every site here derives fresh from LIVE occupancy.
- Do not filter `entry.resolvedKeys`/`entry.resolvedKey` through `entryStillOwnsKey` at the
  `unionResolvedKeysRetaining` call in `writeMergeQuarantineLatch` itself — `f575cebf` deliberately closed
  this residual one step EARLIER instead, at the fold-in (`reconcileMarkedBasenameBeforeWrite`), via a
  narrower `positivelyForeignKey` predicate; see that card's own record for why `entryStillOwnsKey` here
  would itself be a fail-open (it treats an empty slot as unowned, dropping a legitimate secondary).
- Do not read "site 2 is now safe" as "a stale `armedKeys` member can never again reach a persisted latch"
  — only the live-occupancy-derived, ownership-filtered secondary set is clean; an already-contaminated
  `entry.resolvedKeys` is now filtered at the fold-in (`f575cebf`), but the PASS1 boot-time "upgrade case"
  (an already-contaminated disk file, independent of any fold-in) stays open on card `e7652e06`.
- Do not assume Scenario 3's (the pending-twin) own "the twin stays blocked regardless" outcome
  generalizes to every reduce-shape twin — it depends on `writePendingDivertFile`'s own, UNRELATED
  backstop write (which durably keeps the twin blocked via an independent pending record, no matter what
  the contaminated active union at `kF` does) existing for that specific twin shape. Scenario 2 (the
  active-only twin, with no such backstop) is the one that proves the fix itself closes the headline
  fail-open (the twin's own identity becoming unreachable); Scenario 3 only proves a further, narrower
  consequence of the SAME underlying write bug (F wrongly stranded by the twin's foreign token).
- Do not make `entryStillOwnsKey`/`liveArmedKeysOf` take a REQUIRED map parameter the way
  `writeMergeQuarantineLatch`'s own `ownershipMap` now is — deliberately left DEFAULTED (chosen over
  making them required too): they have ~20 combined existing call sites spanning several unrelated
  cards' own established code, all runtime-only, and `writeMergeQuarantineLatch` is the one function
  genuinely reachable from both boot and runtime — making the OTHER two required would balloon this
  card's diff without closing a reachable gap the required `ownershipMap` doesn't already close.
- Do not re-derive this card's own line numbers from a stale copy — read `merge-quarantine.ts` fresh; this
  record states them only as of the card's own parent commit.

## Verification

- `test/merge-quarantine-d69a6744-liveoccupancy-ambiguity-and-write.mjs` — four scenarios: 1 (site 1 text
  fix, a real resolvable sibling F correctly flags the latch id as ambiguous), 2 (the active-only
  dual-key twin, the PRIMARY reproduction of the headline fail-open; forces F's own latch file to be
  processed by PASS 1 BEFORE the twin's degraded files — via `keyHashSortingAfter`, with the real on-disk
  order asserted, not assumed — which is the load-bearing precondition for the twin's own identity
  becoming unreachable; asserts the fail-open polarity explicitly: `assertRepoNotQuarantined(T)` is still
  BLOCKED post-reboot, and F's tokens never contain T's token, both before and after F's own clear), 3
  (the pending twin, a SECOND, narrower consequence of the same bug — F wrongly stranded by the twin's
  foreign token, while the twin itself stays blocked throughout via its own, unrelated
  `writePendingDivertFile` backstop — same fail-open-polarity assertions on the F side, plus F unblocking
  cleanly by its own token alone), 4 (GREEN-only regression — a legitimate dual-key entry, including a
  secondary admitted via `entryStillOwnsKey`'s SUBSET-TOKEN branch rather than reference equality,
  survives a reboot with neither key dropped). Every "reboot" leg is a cache-busted dynamic re-import of
  the compiled module (`?b=N`) in the SAME process, on the same temp `LOOM_HOME` — never an actual OS
  process restart; this re-import gets a genuinely fresh, empty `activeQuarantines`/
  `pendingUnresolvedQuarantines` because Node's ESM loader instantiates each distinct specifier
  separately, which is what actually makes it behave like a reboot for this module's own state.
- RED/GREEN via `pnpm --filter @loom/daemon negative-control --file packages/daemon/src/git/merge-quarantine.ts
  --test packages/daemon/test/merge-quarantine-d69a6744-liveoccupancy-ambiguity-and-write.mjs --ref
  c7bd3663` (this card's own true parent, before any of its three commits) — a logic-only revert (every
  symbol this test imports already existed pre-fix; only the widened expressions' own formulas changed),
  never `--ref HEAD` once committed. Three commits land this card's own fix: the first is the
  Lead-approved formula (plus the original, non-deterministic version of this test); the second is the
  boot-time `ownershipMap` correction (the first commit's own formula regressed `8bff3cae`'s boot-time
  scenario, found by the full-corpus run below); the third makes the headline Scenario 2 reproduction
  deterministic and fixes the issues a Code Review of the first two found. The negative-control's own RED
  phase reverts the FULL, corrected diff in one step (one `--file`), never an intermediate state —
  confirmed: all of Scenario 2's own `*** THE FAIL-OPEN POLARITY ***` checks (including the headline "T
  is STILL BLOCKED after reboot") go RED on `c7bd3663` and GREEN after, deterministically (5/5 repeat
  runs against the fixed code, no flake).
- Full `merge-quarantine*.mjs` corpus, individually, fresh `LOOM_HOME` per file, both env states
  (`env -u LOOM_DEV -u LOOM_SUPERVISED` / `LOOM_DEV=1 LOOM_SUPERVISED=1`), one lane — this is what caught
  the boot-time regression (`merge-quarantine-pass1-migrate-resolvedkey-8bff3cae.mjs`), not code review.
- `pnpm --filter @loom/daemon guards`, committed first.

See `docs/decisions/1fc3a561-remaining-armedkeys-consumers-closed-via-live-scan.md`'s own "Do not" section,
updated to state this card closes the two remaining sites it tracked.
