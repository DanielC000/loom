# 3880f783 — `computeFulfillment`'s "unwritable" does not cover every profile write path

## Narrative

`computeFulfillment` (`packages/daemon/src/mcp/questionTool.ts`) derives a permission answer's `fulfillment: {state, detail}` by checking a declared `fulfillmentTarget` against the live `Profile` row. Its `"unwritable"` state fires when the declared `key` doesn't name a real `Profile` field, checked live against `PROFILE_FIELD_NAMES` — the schema-derived enumeration, never hand-copied, so it can't itself drift from the real schema.

NOTE (verified against commit `635e347e`, not inferred from its subject): the ORIGINAL harness specimen's failure mode — a real schema field silently dropped from `validateProfile`'s own return literal — is now compile-time impossible on that path, via the `satisfies Record<keyof Omit<Profile,"id">, unknown>` clause in `profiles/validate.ts`.

It does NOT cover every write path to a profile field, though: `Db.insertProfile`/`updateProfile`'s manual per-column SQL binding has no equivalent compile-time totality check. A field silently dropped there would still read `"not_yet_done"` forever, with no way for `computeFulfillment` to tell the difference between "not yet done" and "can never be done because the write path itself drops it." This is a real, separate, still-open gap this card's design does not attempt to close.

## Do not

- Do not treat `"unwritable"`/`"not_yet_done"` as a full audit of every profile write path — `Db.insertProfile`/`updateProfile`'s manual per-column binding is NOT covered by `validateProfile`'s compile-time totality guarantee.
- Do not assume a field silently dropped at the `Db.insertProfile`/`updateProfile` layer would ever surface as `"unwritable"` — it reads `"not_yet_done"` forever instead, indistinguishable from a fulfillment that simply hasn't happened yet.

## Source

Inline comment in `packages/daemon/src/mcp/questionTool.ts`, above `computeFulfillment` (lines 250-275, pre-tranche-1 numbering), as of commit `beeeb7c2`. Relocated by card `8691d4a0` (tranche 1).
