# 11c3dc70 — `resetProfileToBundled` silently kept omitted fields custom under a raw spread

## Narrative

`resetProfileToBundled` previously wrote a raw `{ ...bundled }` spread as its update patch — NOT a
`MERGEABLE_PROFILE_FIELDS`-filtered patch, unlike `adoptProfileUpdate`. `db.updateProfile` treats an
absent key as "leave column as-is", so ANY optional field a `BUNDLED_PROFILES` entry OMITS (not just
`harness` — also `browserTesting`/`documentConversion`/`restrictedTools`/`noCommit`/`connections`/
`vaultWrite`/`capabilities`) was simply absent from the raw spread and silently survived reset instead
of reverting to the shipped default.

This was proven empirically per field: card 11c3dc70's own DoD-1 probe showed `STILL_CUSTOM_AFTER_RESET`
for every one of those fields before the fix, with a `description` positive control proving the probe
itself could detect a real revert (so the clean result on the other fields wasn't just a broken probe).

Root fix: overlay `normalizedShippedFields(bundled)` (customization.ts) — the SAME normalization
`adoptProfileUpdate` already gets via `mergeProfile`'s `ns[f]` lookups — so every
`MERGEABLE_PROFILE_FIELDS` entry always carries a concrete, defined value in the patch, never an
absence for `updateProfile` to skip. This also resolved reset and adopt disagreeing about what "every
shipped field" means: both now derive it from ONE normalization instead of reset's own one-off
`?? "claude"` literal. Per-field null-vs-absent contracts stay exactly as `normalizeFields` already
documents them (e.g. `harness` has no `null` member, so its absence there is a defined `"claude"`
literal, not `?? null`).

## Do not

- Do not revert `resetProfileToBundled` to a raw `{ ...bundled }` spread — any `MERGEABLE_PROFILE_FIELDS`
  entry a bundled profile omits would then silently survive reset instead of reverting.
- Do not re-derive "every shipped field" ad hoc at a new call site — reuse
  `normalizedShippedFields(bundled)`, the same normalization `adoptProfileUpdate` uses, so reset and
  adopt can't disagree again.

## Source

Inline comment in `packages/daemon/src/profiles/seed.ts`, above `resetProfileToBundled`: lines 274-300,
as of this tranche's HEAD.
