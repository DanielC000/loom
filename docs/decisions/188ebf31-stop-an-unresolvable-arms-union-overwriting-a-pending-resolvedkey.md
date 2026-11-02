# 188ebf31 — stop an unresolvable arm's union overwriting a pending resolvedKey

Investigate-first card, split from `6b327712` item 3's own "Do not" ("Do not attempt to fix item 3 by
changing `armForeignOrphanContentInMemoryIfUnenforced`'s own unconditional Step B union for unresolvable
identities — tracked separately on card `188ebf31`"). The worry: `5d0820c7`'s own Step B calls
`armQuarantineKey` unconditionally for an unresolvable/pending identity T's secondary key, and that
function's own legacy union (no `explicitResolvedKeyRule`) can make T's in-memory `resolvedKey` become a
different occupant's value — diverging from T's own on-disk orphan bytes. The question this card had to
settle first: for the SAME bytes and the SAME arm order, does a REBOOT's PASS 1 produce the same
`resolvedKey`/`resolvedKeys`/`repoPath` on the merged object as the in-process arm?

## The answer: PARITY, not a defect

Both legs call the IDENTICAL `armQuarantineKey` (`merge-quarantine.ts` ~`:1254`) with no explicit rule —
PASS 1's own secondary-key union, on its "legitimate same-toplevel union" fallthrough
(`armKeyUnlessDegradedCollision` ~`:8891`), and Step B's own secondary-key loop
(`armForeignOrphanContentInMemoryIfUnenforced` ~`:5302`) both reach this SAME function. So wherever the
GATING before that call agrees between the two legs, the computed object is byte-identical by
construction, not by coincidence. The gating DOES agree for the realistic shape this card's own repro
pins (the occupant IS a registered, resolvable project — `5d0820c7`'s own already-confirmed "common
case"): Step B can only ever run from inside an orphan sweep that is itself part of a CLEAR operation,
and there is no code path to a clear without the process having already run
`reenterMergeQuarantinesAtBoot` at least once (nothing else ever populates `activeQuarantines`) — so by
the time Step B's own `activeQuarantines.get(key)` lookup runs, PASS 1's own boot-time arm has ALREADY
produced whatever dual-arm state a registered occupant carries.

**Confirmed empirically, twice, deliberately rebuilt the second time to close a circularity gap found
during review (lesson 287):** a first repro hand-constructed the in-process seed's `armedKeys` field to
match the expected post-boot shape — a hand-asserted seed is circular, since of course it then agreed
with the reboot leg it was built to match. The repro was rebuilt so U's own dual-arm (at `[KEY_U, KEY_V]`)
is derived from a GENUINE `reenterMergeQuarantinesAtBoot` read-back (a separate module instance, reading
only U's own file, T not yet on disk) — never hand-set — and the on-disk JSON straight out of
`enterMergeQuarantine` was directly inspected and confirmed to carry NO `armedKeys` field at all (it is a
purely derived/runtime field). Ran both T-older and U-older orderings this way: `repoPath`,
`resolvedKey`, `armedKeys`, and tokens all AGREE between the in-process leg and a wholly independent
second boot, in both orderings.

## The one assumption this relies on

A dual-armed entry (armed under a SECOND key, i.e. one whose `resolvedKey` differs from its own canonical
key) only ever ORIGINATES from a boot-time read of on-disk content that already carries a foreign
`resolvedKey` field — never from an ordinary runtime raise. Verified at source: `enterMergeQuarantine`'s
own FRESH-raise branch sets `resolvedKey: key` (its own canonical key, self-referential — `:4470`); its
EXISTING/re-raise branch never reassigns `resolvedKey` at all, only spreads `{...existing, ...}` (`:4305`),
so a re-raise can only CARRY FORWARD a value that already existed, never originate a new divergent one. A
grep of every `resolvedKey:` object-field assignment in the file confirms every OTHER runtime
(non-PASS-1/1b) site is the same shape — either self-key (`resolvedKey: key`/`currentKey`) or a
conditional carry-forward via `isInformativeKey(...) ? X.resolvedKey : key` (never a fresh foreign value).

**If a future change adds a runtime path that gives an entry `resolvedKey !== its own key` WITHOUT a
prior boot, this card's own reachability argument no longer covers that path — re-open the question
rather than assuming the pin test still proves parity for it.**

## A separate, already-accepted divergence (not this card's finding, confirmed not reopened)

When the secondary-key occupant is resolvable but NOT a currently-registered project (the
resolvability-mismatch branch, no registered repo backs the key), Step B's own unconditional union (for
an unresolvable record) unions the foreign token into the occupant where a reboot's PASS 1 instead
DECLINES/evicts it, leaving the ghost as its own standalone pending entry. This is NOT new — it is exactly
the second named divergence already in `5d0820c7`'s own "Step B" section, and that record already rules
it "stricter, never weaker... holds cleanly for the UNRESOLVABLE case, where unioning never touches a
primary-key slot to begin with" — reproduced here only as an EXPLICIT ASSERTED pin (scenario 4) so a
future polarity change in either direction fails loudly, never as a new finding or a defect this card
fixes.

## Do not

- Do not read this card as license to replicate PASS 1's own freshness/registered-backing decision tree
  at Step B's own call site — `1dd00dca`'s "never replicate the boot-only degraded-collision dance"
  rule still governs; parity holds because both legs call the SAME terminal `armQuarantineKey`, not
  because Step B independently re-derives PASS 1's own gating.
- Do not treat scenario 4's own asserted divergence as a bug to fix — `5d0820c7` already ruled it safe
  for the unresolvable case; a change there belongs to that card's own scope, not this one's.
- Do not drop the "raw on-disk JSON carries no armedKeys field" check from the pin test if this file is
  ever edited — it is what rules out re-introducing the exact hand-asserted-seed circularity this card's
  own review caught once already.
- Do not widen this card's own reachability argument to cover a runtime-originated divergent
  `resolvedKey` without first verifying, at source, that no such path exists (same method as the "one
  assumption" section above) — the assumption is load-bearing, not decorative.

## Tests

`merge-quarantine-188ebf31-pass1-stepb-union-parity.mjs`: SCENARIO1/2 (T-older/U-older dual-arm parity,
real-boot-derived seed), SCENARIO3 (positive control — a deliberately under-seeded map IS detected as a
mismatch, proving the comparison is not vacuous), SCENARIO4 (the unregistered-occupant divergence,
asserted explicitly in both directions).
