# 3d19ecc7 — mark `bindings_seeded` at the binding WRITE chokepoint, not each caller

See a8480338 (`docs/decisions/a8480338-bootstrap-seed-must-not-reseed-a-revoked-binding.md`) for the
original bug this record extends.

## Context: the two-path asymmetry

a8480338 shipped `bindings_seeded` marked by TWO independent call sites: `factory.ts`'s bootstrap-seed
(`db.markCompanionBindingsSeeded(sessionId)`, right after its own `db.upsertCompanionBinding` call) and the
provision endpoint (`bindingsSeeded: true` on its own `upsertCompanionConfig` call). Neither a REST bind
(`POST /api/companion/bindings`) nor pairing-code redemption EVER marked it, despite both also calling
`db.upsertCompanionBinding` — the one chokepoint every binding write already goes through. Reachable path
back to the ORIGINAL bug: a refused env-bootstrap seed (fresh, or narrowed to 0) → the owner binds the
corrected chat via `POST /api/companion/bindings` → fixes `allowedChatId` via a config PUT (`bindings.length
> 0` so nothing seeds, flag stays 0) → revokes everything → the next restart re-seeds the chat just
revoked, because the flag was never set on the REST-bind path.

## Decision: the mark lives in `db.upsertCompanionBinding` itself

`db.upsertCompanionBinding` now marks `companion_config.bindings_seeded = 1` for `input.sessionId` in the
SAME transaction as its own INSERT/ON CONFLICT write (a crash can't land one without the other). A throw
(the `InvalidTelegramChatIdError` refusal) happens before the transaction and marks nothing — a refused
write never counts as "genuinely seeded." Every writer — the env bootstrap seed, a REST bind, pairing-code
redemption, provision — enforces the invariant for free, nothing left for a new call site to forget.

**Factory's own mark and provision's explicit flag are REMOVED, deliberately, not kept.** The standalone
`db.markCompanionBindingsSeeded(sessionId)` method is deleted (it had exactly one caller). Keeping either
caller-side mark alongside the new chokepoint would restore the same shape that caused this bug: a durable
fact set from more than one place, able to drift the moment someone adds a THIRD call site and forgets it
too. Single-sourcing it in the one write chokepoint makes that class of bug structurally impossible to
reintroduce, not just fixed for the two paths audited.

## Migration atomicity

`migrateCompanionConfig`'s `ADD COLUMN` loop and `narrowBindingsSeededBackfillForRefusedRows` now run
inside one `this.db.transaction(...)`. Before: `bindingsSeededJustAdded` is computed once from `PRAGMA
table_info` BEFORE the column exists; a crash between the `ADD COLUMN` and the narrowing left a refused
row stranded at the blanket backfill's `1` PERMANENTLY — the column already exists on the next boot, so
`bindingsSeededJustAdded` is false and the narrowing never retries. Wrapping both in one transaction makes
the pair atomic: either neither change is durable, or both are. Boot-tested against a COPY of a real
`~/.loom` backup (production DB never written) — opened clean, column added, both real rows backfilled
correctly, second open idempotent.

## The never-armed population — why `enabled=0` stays un-narrowed

Naming it precisely: a `companion_config` row created `enabled:false`, or disabled by the token-collision
guard (`findEnabledTokenCollision`), was never built into a live gateway ⇒ `factory.ts`'s bootstrap-seed
never ran for it ⇒ it was never genuinely seeded ⇒ the blanket backfill still marks it `1`.

**Decision: do NOT also narrow `enabled=0 AND zero bindings` to 0.** A revoked-then-disabled companion is
byte-identical in storage to a never-armed disabled one — both `enabled:0`, zero bindings, unresolved
either way without a history this schema doesn't keep. Same asymmetric trade-off as Shape 2 in a8480338:
biasing toward "already seeded" costs a never-armed row one `POST /api/companion/bindings` call to recover
once enabled; biasing the other way would silently re-arm a genuinely revoked chat the moment the owner
re-enables a long-disabled companion, with no signal that it happened. Leave it at the blanket backfill's
`1`, same as Shape 2.

## Round 4 (012d0089): the chokepoint UPDATE can still no-op

`upsertCompanionBinding`'s mark is an `UPDATE ... WHERE session_id = ?` — a no-op with no `companion_config`
row yet. Reachable: an unprovisioned session takes a REST bind BEFORE its first config POST; that later
INSERT then starts the flag at its own omitted-param default (`false`), discarding the binding that already
exists. Closed WITHOUT a second explicit mark: `upsertCompanionConfig`'s genuine-first-INSERT path (no
existing row, `bindingsSeeded` omitted) now defaults to `EXISTS(binding for this session)`, not a bare
`false` — fires once, at insert time, never on an UPDATE, and marks nothing for a session with no binding.
Same shape in the backfill: `narrowBindingsSeededBackfillForRefusedRows` now also requires
`NOT EXISTS(binding for that session)` — a legacy row that LOOKS refused but whose session already HOLDS a
binding (via some other, valid route) stays `1`.

## Do not

- Do not reintroduce a caller-side `bindings_seeded` mark passing an explicit `true` — the two-path shape
  this record closed. Round 4's INSERT-path default above is NOT this: fires once, on a genuine first row,
  reading existing state only.
- Do not mark it for a refused write — strictly AFTER the binding row is durably written, never before,
  never on the `InvalidTelegramChatIdError` throw path.
- Do not narrow `enabled=0 AND zero bindings` to 0 — see "The never-armed population" above; a
  revoked-then-disabled row is indistinguishable from a never-armed one, and the existing bias is safer.
- Do not run `migrateCompanionConfig`'s `ADD COLUMN`s and `narrowBindingsSeededBackfillForRefusedRows`
  outside one shared transaction — see "Migration atomicity" above.
