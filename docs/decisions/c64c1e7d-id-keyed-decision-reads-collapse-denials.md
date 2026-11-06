# c64c1e7d — id-keyed Companion decision lookups collapse every denial into one error

## Narrative

`decision_get` (the single-decision read) and `decision_resolve` both look a decision up by an id the
Companion supplies. If a lookup answered "missing" and "out of your scope" differently, the Companion (or an
injected prompt driving it) could probe arbitrary ids and learn which exist in projects it is not granted.
So both tools return the same `{error:"no such decision"}` (`NO_SUCH_DECISION`,
`companion/capabilities.ts`) for: a nonexistent id, an id in a project outside the grant, a `notice` row,
and (`decision_get` only) a consumed or cancelled row. The refusal is decided before any side effect —
`decision_get` writes no surfaced stamp, `decision_resolve` proposes/commits nothing.

## Exception to f4d04609

`@decision sha:f4d04609` routes every per-project scope denial through `scopeDenialMessage` so the error
names the missing capability. That is right when the caller names a PROJECT it was handed. It is wrong for an
ID-keyed lookup: a scope message on an id confirms the id exists. Id-keyed lookups therefore collapse; the
`project`-keyed `decisions_list` selector keeps `scopeDenialMessage`.

## Do not

- Do not route an id-keyed decision lookup's scope denial through `scopeDenialMessage`, and do not give
  "nonexistent" and "out of scope" different text — that reintroduces the existence oracle.
- Do not stamp `last_surfaced_at` (or do any other write) before the scope/state checks have passed.
- Do not widen `decision_get`'s readable states beyond what `decisions_list` returns (pending, answered).
