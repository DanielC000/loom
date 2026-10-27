# 3df24991 — `remediationTextFor`'s own-key clause names "a key of its own," never "this key"

Found by `6de79dc0`'s gen-1 worker (session `c28f42b2`) while closing CR3 item 3, pinned as the
`(entry-vs-perkey-discriminator)` scenario in `merge-quarantine-6de79dc0-sibling-key-contributor-wrong-release.mjs`.

`refuseSelfClearStaleKeyContributors(entry, key)` builds two clauses about ownership in the SAME refusal
text:

1. Its own `ownershipClause`, built from the PER-KEY fact `entryOwnsKey = entry.identityAtRaise === key`
   — true/false about the SPECIFIC `key` this call was addressed by.
2. `remediationTextFor`'s own `ownKeyAlsoReleasedClause`, built from the ENTRY-level fact
   `entryGenuinelyOwnsALiveArmedKeyOfItsOwn(entry)` — whether `entry` owns ANY of its own live-armed keys,
   deliberately NEVER keyed to the specific key a caller addressed it by (this entry-level shape is
   intentional — see `6de79dc0`'s CR round 3 MAJOR: a per-key fact was WRONG whenever a human addressed an
   entry by a different one of its own live-armed keys, e.g. a genuine contributor's own latch id).

A real reboot's directory-scan order can insert a dual-armed entry's SECONDARY key into `activeQuarantines`
before its PRIMARY (`identityAtRaise`) key. When `refuseSelfClearStaleKeyContributors` is then reached via
that secondary key, `entryOwnsKey` is false (correctly — the entry doesn't own THAT key) while
`entryGenuinelyOwnsALiveArmedKeyOfItsOwn(entry)` is `"owned"` (correctly — the entry DOES own its own,
different, primary key). The two facts are both true and not in conflict — but the OLD wording collapsed
both into "this key," producing one sentence that says "it does not own this key itself" and, later,
"(it genuinely owns this key)" — a direct, self-contradictory reversal from the reader's point of view,
even though the two clauses are honestly about two different keys.

## The fix

Text-only. `remediationTextFor`'s `ownKeyAlsoReleasedClause` no longer says "owns this key" / "owns this
key" (negated). It says "owns at least one of its own currently-armed keys" (the `"owned"` branch) or
"owns any of its own currently-armed keys" (the `"unknown"` branch) — true exactly whenever
`ownKeyOwnership` says so, and never implies it is the SAME key some other clause in the same sentence
addressed. This also covers `remediationTextFor`'s other three call sites
(`clearMergeQuarantineLatchFile`'s ambiguous-active-match branch, `assertRepoNotQuarantined`'s ambiguous
branch) — neither call site pairs this clause with a conflicting per-key ownership claim today, and the
reworded text stays accurate at every one of them regardless.

The refusal DECISION (whether to refuse) is unaffected — this card is diagnosed, and verified, as text-only.

## Do not

- Do not make `ownKeyAlsoReleasedClause`'s wording name the specific key string — `remediationTextFor`
  doesn't receive the entry's own key value as a parameter (only the tri-state `ownKeyOwnership`), and raw
  canonical-lock-key strings are not meant to be human-displayed; "a key of its own" / "its own currently-
  armed keys" is the deliberate, generic form.
- Do not revert `entryGenuinelyOwnsALiveArmedKeyOfItsOwn`'s entry-level (never per-key) semantics to "fix"
  this — that would reopen `6de79dc0`'s own CR round 3 MAJOR regression (wrong answer when addressed by a
  genuine contributor's own latch id). The entry-level fact is correct; only the WORDING around it was
  self-contradictory.
- Do not assume `refuseSelfClearStaleKeyContributors`'s own `ownershipClause` (the per-key half) needed
  changing too — it is already correctly scoped to `key` throughout all four of its branches; only the
  entry-level remediation clause's wording conflated "this key" with "a key of its own."

Tests: `merge-quarantine-6de79dc0-sibling-key-contributor-wrong-release.mjs`'s
`(entry-vs-perkey-discriminator)` scenario, extended to assert the non-contradictory text in BOTH
`activeQuarantines` insertion orders (`kr-first`, `ks-first`).
