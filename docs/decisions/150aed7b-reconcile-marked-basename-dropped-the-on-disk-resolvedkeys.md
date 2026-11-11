# 150aed7b — `reconcileMarkedBasenameBeforeWrite` folded `tokens` only, silently dropping the on-disk record's own `resolvedKey`/`resolvedKeys`

_Split out of the former single `8db913e2` record by card `3608937e` so each record's injected Do-not extract fits the per-record cap; every section below is verbatim from it (pinned blob `2f1a55286d01`). The core record keeps the card's own rounds 1 and 3 and holds the index of every split-out record (rounds 2 and 4 of the card are in `sha:d529d42d`, record `d529d42d-raise-divert-rounds-2-and-4-chokepoint-union-and-in-memory-repoint.md`): `8db913e2-raise-diverts-instead-of-overwriting-a-kept-occupant.md`._

## Follow-up 150aed7b — `reconcileMarkedBasenameBeforeWrite` folded `tokens` only, silently dropping the on-disk record's own `resolvedKey`/`resolvedKeys`

Card `150aed7b`, discovered from `43cf3b26`'s own Code Review (`46c5c492`, gen 418), not probed until this
card's own INVESTIGATE-FIRST pass. `reconcileMarkedBasenameBeforeWrite` (the chokepoint every writer in
this module goes through for a basename marked `keptUnreadableLatchFiles`) unioned `final`'s own on-disk
SURVIVING TOKENS into the in-memory `entry` before a write, but never carried forward the on-disk
record's own scalar `resolvedKey` or plural `resolvedKeys` — both are simply overwritten by whatever
`entry` already held in memory, which can be NOTHING (a fresh raise after a full clear carries no
resolvedKey/resolvedKeys of its own).

### Repro (hermetic, confirmed before any fix was written)

Y dual-armed at two secondary keys (W1, W2 — the same shape as `43cf3b26`'s own
`raise-after-boot-multi-key` scenario). A clear of Y hits an injected, transient read failure on Y's own
`final` (same fault-injection technique as `merge-quarantine-protect-read-failure.mjs`) — the clear
deletes Y's in-memory entry UNCONDITIONALLY before any protect call runs (`63e49ee2`'s own documented
ordering), so the file is left on disk, bytes untouched, and its basename is marked
`keptUnreadableLatchFiles`. A FRESH `enterMergeQuarantine(y)` then reaches this chokepoint with an
in-memory `entry` carrying no `resolvedKey`/`resolvedKeys` at all; the read of `final` now succeeds (no
injection this time), and the pre-fix code unioned `tokens` only — the written record's `resolvedKeys`
came back `undefined`. CONFIRMED CONSEQUENCE: a reboot after this leaves BOTH W1 and W2 unblocked, even
though they were genuinely, durably armed immediately before the read failure — a real fail-open, not a
cosmetic data loss.

### The fix

`reconcileMarkedBasenameBeforeWrite` now ALSO computes `informativeKeysFor` (card `43cf3b26`'s own
scalar-∪-plural helper) of the on-disk record, excluding `entry`'s own current key (mirrors
`secondaryKeysToAttempt`'s own `anchorKey` exclusion), and folds the result into `entry.resolvedKeys` via
the SAME `unionResolvedKeysRetaining` retention/cap/eviction-log every other writer in this module
already uses for this field. The broadened early-return guard (`resurrectable.length>0 ||
onDiskKeys.length>0`) means this now also fires a union when there's a key to fold even if there happens
to be no NEW token to resurrect.

**Why this is safe — it can never arm a key for a repo that was never quarantined:** the function's
PRE-EXISTING same-identity gate (`directPathIdentity(parsed.repoPath) !== directPathIdentity(entry.repoPath)
→ return entry unchanged`) already restricts every fold in this function — tokens AND, now, keys — to a
record that is CONFIRMED to be the SAME repoPath identity as the entry already being written. The keys
being folded are therefore never a foreign identity's keys; they are this SAME already-quarantined
entry's OWN historical secondary keys, being carried forward rather than originated.

**Why this is fail-closed-consistent, not merely loss-prevention:** a kept-unreadable file's own
`resolvedKey`/`resolvedKeys` would already have been picked back up and RE-ARMED at the very next boot
(PASS 1/1b's own `secondaryKeysToAttempt` loop reads them straight off the same on-disk bytes this
chokepoint reads). This fix only makes a RUNTIME write preserve what a REBOOT would already have done —
it never introduces a NEW source of truth, and never arms anything a reboot of the unmodified file
wouldn't also have armed.

### Do not

- Do not drop the same-identity gate to "simplify" this fold — it is the entire reason this can never
  cross-contaminate a foreign identity's keys into `entry`.
- Do not fold the on-disk keys WITHOUT excluding `entry`'s own current key first — an unfiltered fold can
  write a record's own current key into its own `resolvedKeys` (observed directly in this card's own
  repro output, via a pre-existing, unrelated `isInformativeKey` fallback quirk that self-references a
  fresh entry's own key) — harmless at the point it's later re-attempted (`secondaryKeysToAttempt` filters
  by `anchorKey` too), but confusing noise worth excluding at the source.
- Do not assume the broadened early-return guard (`resurrectable.length>0 || onDiskKeys.length>0`) is
  equivalent to the old one (`resurrectable.length>0` alone) — a record with keys to fold but no NEW
  token to resurrect (e.g. the in-memory and on-disk token sets already coincide) must still trigger the
  union, or the key-only case silently reverts to the original bug.

### Tests

`merge-quarantine-reconcile-fold-150aed7b.mjs` (new, 2 scenarios in one process): `fold-survives-reboot`
(the repro above, now asserting W1 AND W2 both stay blocked after the reboot that follows the
read-failure-then-fresh-raise sequence — the exact fail-open this card closes) and
`human-clear-lifts-all` (continuing from scenario 1's own post-fold state — Y is dual-armed again via the
fold — a SUCCESSFUL human clear of Y, no injection, must lift Y, W1, AND W2 together, immediately and
after a further reboot, with no orphan left armed at either secondary key). `pnpm --filter @loom/daemon
negative-control --file packages/daemon/src/git/merge-quarantine.ts --test
packages/daemon/test/merge-quarantine-reconcile-fold-150aed7b.mjs` proves RED (reverted to `HEAD`,
3 of 24 checks fail — the two reboot-survival assertions plus the on-disk resolvedKeys assertion) →
GREEN (restored) → byte-identical clean tree.

### CR follow-up (same card) — two findings

1. **The fold's own key-exclusion filtered by a RECOMPUTED `canonicalRepoLockKey(entry.repoPath)`**, the
   exact anti-pattern `82032b5c`/`97cff6db` already name: a write can target a SECONDARY key via
   `writeMergeQuarantineLatch`'s own `targetKey` param, which can differ from `entry.repoPath`'s own
   recomputed key. Fixed: exclude by `quarantineHashForKey(k) !== path.basename(final, ".json")` instead
   — the key `final` is ITSELF physically filed under right now, regardless of which key the write is
   targeting.
2. **`human-clear-lifts-all` was vacuous** — it drove the clear on the ORIGINAL module, where
   `enterMergeQuarantine(y)`'s own fresh-raise branch only ever arms Y's OWN key in memory; W1/W2 were
   never armed there to begin with, so "W1/W2 ALSO unblocked" could never fail even with the fold
   reverted. Fixed: the scenario now drives the clear on the POST-REBOOT module from scenario 1 (where
   W1/W2 are genuinely armed via the fold-preserved `resolvedKeys`), asserting blocked-before and
   unblocked-after. `pnpm --filter @loom/daemon negative-control --file
   packages/daemon/src/git/merge-quarantine.ts --test
   packages/daemon/test/merge-quarantine-reconcile-fold-150aed7b.mjs --ref 3a9e0027` (pre-150aed7b
   baseline — plain `HEAD` no longer isolates the fold fix once it's committed) now correctly fails the
   scenario's own PRECONDITION (W1/W2 never re-armed after the reboot), not merely the post-clear
   assertion — proving the test is sensitive to the bug, not merely never-armed either way.
