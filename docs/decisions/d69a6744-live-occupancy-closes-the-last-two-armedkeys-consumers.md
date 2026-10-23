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
a reboot in a fresh process on the same temp `LOOM_HOME` (never merely argued), in TWO constructions:

- **PRIMARY (the active-only dual-key twin, no pending record at all)**: a degraded twin armed by
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
  array now contains the twin's foreign token.
- **SECOND (the pending twin, `tiedViaKeyOrOrphanRef` reduce shape)**: the same contamination at `kF`, but
  this twin shape always ALSO writes an independent pending-divert backstop file (`writePendingDivertFile`,
  unrelated to this bug) that happens to keep the twin blocked regardless of what happens to the active
  union. The visible symptom here is narrower but still real: clearing F by its OWN token
  (`clearMergeQuarantineByToken`) no longer fully unblocks F — F stays wrongly STRANDED, blocked by a
  token it never owned, until a human separately discovers and clears the twin's foreign token too.

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
  correctly retain a LEGITIMATE secondary key via either admission path, so the ownership filter is
  additive safety, never a narrowing that could strand a real secondary.

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
after the fix's own first write. Fixed by giving both helpers an optional `map` parameter (default
`activeQuarantines`, byte-identical for every existing call) and threading it through
`writeMergeQuarantineLatch`'s own new `ownershipMap` parameter (default `activeQuarantines`), with
`bootWriteLatch` the one caller passing its own closure-captured `byRepoKey` instead. Caught by this
card's own DoD (the full `merge-quarantine*.mjs` corpus run), not by code review — see
`merge-quarantine-pass1-migrate-resolvedkey-8bff3cae.mjs`'s own `shared-ancestor-sibling` scenario, the
one that went red.

## The resolvedKeys-retention residual — OUT OF SCOPE, tracked on `f575cebf`

`unionResolvedKeysRetaining(entry.resolvedKeys, freshSecondaryKeys, ...)` unions TWO sources. This card's
fix only cleans the SECOND (`freshSecondaryKeys`, now ownership-filtered). The FIRST, `entry.resolvedKeys`
itself (the in-memory field), is retained FOREVER by design (`8db913e2`/`43cf3b26`'s own union-never-drop
rule) — if an EARLIER write already durably persisted a foreign key into `resolvedKeys`, and a LATER
reconcile path (`reconcileMarkedBasenameBeforeWrite`/`foldInOnDiskTokensIfMarked`) folds that bad on-disk
value back into memory, this card's own fix does not purge it; the contaminated key could keep being
retained forward via the union regardless. The Lead's ruling: do **not** filter `entry.resolvedKeys`/
`resolvedKey` in this card — dropping from that union risks reopening exactly what the union-never-drop
rule prevents, and the propagation path (a pre-existing contaminated on-disk file plus a kept-unreadable-
basename reconcile) is unproven, not merely unfixed. Filed as card `f575cebf` (p2, reproduce first).

## Do not

- Do not add a new boot-time caller of `writeMergeQuarantineLatch` (directly, or via `bootWriteLatch`)
  without passing the boot's own local `byRepoKey` as `ownershipMap` — the default (`activeQuarantines`)
  is correct for every RUNTIME caller but structurally stale for any write that happens before
  `reenterMergeQuarantinesAtBootImpl`'s own end-of-function sync loop runs. Same rule for any NEW call to
  `entryStillOwnsKey`/`liveArmedKeysOf` added inside that function — pass `byRepoKey` explicitly.
- Do not have `protectOccupantContentBeforeDelete`'s own re-point stamp `armedKeys` onto `written.entry`
  as "the" fix for this shape — same prohibition `1fc3a561`/`c52b290e` already state, for the same reason
  (it covers only one of 20+ `replaceEntryEverywhere` sites in this file). This card never unions an OLD
  object's list forward either — every site here derives fresh from LIVE occupancy.
- Do not filter `entry.resolvedKeys`/`entry.resolvedKey` through `entryStillOwnsKey` before the
  `unionResolvedKeysRetaining` call in `writeMergeQuarantineLatch` — that is the residual this card
  deliberately left open; see card `f575cebf`. Fixing `freshSecondaryKeys` alone is this card's full scope.
- Do not read "site 2 is now safe" as "a stale `armedKeys` member can never again reach a persisted latch"
  — only the live-occupancy-derived, ownership-filtered secondary set is clean; an already-contaminated
  `entry.resolvedKeys` (the residual above) is a separate, still-open path.
- Do not assume Scenario 2's (the pending-twin) own "F unblocks cleanly" outcome generalizes to every
  reduce-shape twin — it depends on `writePendingDivertFile`'s own, UNRELATED backstop write existing for
  that specific twin shape. Scenario 1 (the active-only twin) is the one that proves the fix itself closes
  the fail-open; Scenario 2 only proves one more concrete consequence of the same underlying bug.
- Do not re-derive this card's own line numbers from a stale copy — read `merge-quarantine.ts` fresh; this
  record states them only as of the card's own parent commit.

## Verification

- `test/merge-quarantine-d69a6744-liveoccupancy-ambiguity-and-write.mjs` — four scenarios: 1 (site 1 text
  fix, a real resolvable sibling F correctly flags the latch id as ambiguous), 2 (site 2 PRIMARY — the
  active-only dual-key twin; asserts the fail-open polarity explicitly: `assertRepoNotQuarantined(T)` is
  still BLOCKED post-reboot, and F's tokens never contain T's token, both before and after F's own clear),
  3 (site 2 SECOND — the pending twin; same fail-open-polarity assertions, plus F unblocking cleanly by
  its own token alone), 4 (GREEN-only regression — a legitimate dual-key entry, including a secondary
  admitted via `entryStillOwnsKey`'s SUBSET-TOKEN branch rather than reference equality, survives a reboot
  with neither key dropped).
- RED/GREEN via `pnpm --filter @loom/daemon negative-control --file packages/daemon/src/git/merge-quarantine.ts
  --test packages/daemon/test/merge-quarantine-d69a6744-liveoccupancy-ambiguity-and-write.mjs --ref
  <this card's own first commit>~1` (the parent BEFORE either of this card's two commits) — a logic-only
  revert (every symbol this test imports already existed pre-fix; only the widened expressions' own
  formulas changed), never `--ref HEAD` once committed. Two commits land this card's own fix: the first
  (the Lead-approved formula) regressed `8bff3cae`'s own boot-time scenario, found by the full-corpus run
  below; the second is the `ownershipMap` correction described above. The negative-control's own RED
  phase reverts BOTH in one step (one `--file`), so it proves the full, corrected diff, not an intermediate
  state.
- Full `merge-quarantine*.mjs` corpus, individually, fresh `LOOM_HOME` per file, both env states
  (`env -u LOOM_DEV -u LOOM_SUPERVISED` / `LOOM_DEV=1 LOOM_SUPERVISED=1`), one lane — this is what caught
  the boot-time regression (`merge-quarantine-pass1-migrate-resolvedkey-8bff3cae.mjs`), not code review.
- `pnpm --filter @loom/daemon guards`, committed first.

See `docs/decisions/1fc3a561-remaining-armedkeys-consumers-closed-via-live-scan.md`'s own "Do not" section,
updated to state this card closes the two remaining sites it tracked.
