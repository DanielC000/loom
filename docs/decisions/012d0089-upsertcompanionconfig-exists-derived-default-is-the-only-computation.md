# 012d0089 — `upsertCompanionConfig`'s `bindings_seeded` default is the ONLY computation, never a caller input

See 3d19ecc7 (`docs/decisions/3d19ecc7-mark-bindings-seeded-at-the-binding-write-chokepoint.md`) for the
write-chokepoint decision this extends, and a8480338
(`docs/decisions/a8480338-bootstrap-seed-must-not-reseed-a-revoked-binding.md`) for the original bug.

## Round 4: the chokepoint UPDATE can still no-op

`upsertCompanionBinding`'s mark is an `UPDATE ... WHERE session_id = ?` — a no-op with no `companion_config`
row yet. Reachable: an unprovisioned session takes a REST bind BEFORE its first config POST; that later
INSERT then starts the flag at its own omitted-param default (`false`), discarding the binding that already
exists. Closed WITHOUT a second explicit mark: `upsertCompanionConfig`'s genuine-first-INSERT path (no
existing row, `bindingsSeeded` omitted) defaulted to `EXISTS(binding for this session)`, not a bare
`false` — fires once, at insert time, never on an UPDATE, and marks nothing for a session with no binding.
Same shape in the backfill: `narrowBindingsSeededBackfillForRefusedRows` also requires
`NOT EXISTS(binding for that session)` — a legacy row that LOOKS refused but whose session already HOLDS a
binding (via some other, valid route) stays `1`.

## Round 5 (ba2e1508, from the 012d0089 Code Review): delete the dead `bindingsSeeded?` input entirely

Round 4 left `upsertCompanionConfig`'s `bindingsSeeded?: boolean` param in place, defaulting to the
EXISTS-derived value only when omitted (`input.bindingsSeeded ?? (...)`). A repo-wide, positive-controlled
grep (every `bindingsSeeded:` literal in `packages/`, cross-checked against every real
`upsertCompanionConfig(`/`db.upsertCompanionConfig(` call site in `packages/daemon/src` and
`packages/daemon/test`) found **zero** callers passing it — every hit was a `CompanionConfig`/row-mapping
object literal unrelated to this call, never an argument to this method. The param was exactly the door
3d19ecc7's first "Do not" forbids: a caller passing `true` would restore the two-path asymmetry that record
closed; a caller passing `false` on an UPDATE would silently CLEAR a genuinely-seeded row, undoing the
revoke-safety this whole decision chain exists for — with nothing in the type system stopping either.

**Decision: delete the param from both `Db.upsertCompanionConfig`'s input type (`db.ts`) and
`CompanionConfigStore.upsertCompanionConfig`'s input type (`companion/store.ts`), and make the
EXISTS-derived computation unconditional** — `existing ? (existing stored value) : EXISTS(binding for
session)`, with no `??` and no caller-passed branch at all. The invariant is now compiler-enforced: there
is no parameter shape left for a future caller to misuse, not just a comment asking them not to.

## Round 5 also: wrap the read-then-INSERT in one transaction

The existing-row SELECT and the INSERT/ON CONFLICT write were two separate statements with no transaction
around them. **Not a race fix** — better-sqlite3 is synchronous on a single connection, so the SELECT and
the INSERT could never interleave with another call in this process; there was no concurrency bug here to
close. The method now runs entirely inside `this.db.transaction((): CompanionConfigRow => { ... })()` for
atomicity (a crash between the SELECT and the INSERT can't land one without the other) and for
consistency with convention — it's the same read-then-write shape `upsertCompanionBinding` already wraps
in `this.db.transaction` for its own INSERT + `bindings_seeded` mark.

## Round 5 also: the `CompanionConfigRow.bindingsSeeded` doc states the invariant precisely

Restated (`db.ts`'s own `CompanionConfigRow.bindingsSeeded` doc) as: "held a binding during this config
row's lifetime, or at its creation" — not merely "has genuinely held a binding at least once," which read
as a single lifetime-spanning claim and obscured that the two halves (chokepoint-set vs. INSERT-derived)
answer different questions at different times.

**Named, accepted limitation:** a REST bind on an unprovisioned session, followed by deleting that same
binding, followed by the session's first config POST, reads zero bindings at insert time and seeds
`false` — even though a binding for that `allowedChatId` existed, briefly, earlier in the session's life.
Not a bug: the owner is at that point creating a config that names the very chat they're about to be
(re-)seeded into, which is intent-consistent, not a silent re-arm of something they revoked. (The
revoke-safety this record chain protects is about a REVOKE surviving a config row's OWN lifetime, not
about erasing all trace that a binding briefly existed before the row did.)

## Do not

- Do not reintroduce a `bindingsSeeded?` (or similarly-named) caller-facing input on
  `upsertCompanionConfig` / `CompanionConfigStore.upsertCompanionConfig` — see "zero callers" above; it is
  exactly the asymmetry door 3d19ecc7 closed, reopened with a friendlier name.
- Do not split `upsertCompanionConfig`'s existing-row read from its INSERT/ON CONFLICT write across two
  un-transactioned statements — see "wrap the read-then-INSERT" above.
- Do not read the "or held one already at creation" half of `CompanionConfigRow.bindingsSeeded`'s doc as a
  promise that a since-deleted binding is remembered forever — see "named, accepted limitation" above.
