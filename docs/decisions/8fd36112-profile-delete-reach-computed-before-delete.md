# 8fd36112 — a profile-delete's reach is computed BEFORE the delete, filed only after it succeeds

From `be447b3f` round-3 Code Review (reviewer `8f0a0ef0`, 2026-10-06, Minor 3). `recordProfileDeleteGrantReach`
computed the bound-agent reach (`db.listAllAgents()` + the widening diff) and filed the audit event AFTER
`db.deleteProfile` had already run, with no transaction wrapping the two. If `listAllAgents()` throws
post-delete, the profile is already gone, no `profile_grant_reach` event is filed, and the caller sees a
bare error/500 — indistinguishable from "the delete failed," when it actually succeeded with the audit
trail silently lost.

## What was decided

`recordProfileDeleteGrantReach` (one function, both phases, no caller-visible transaction) split into two:

1. `computeProfileDeleteGrantReach(db, {profileId, existing})` — the READ-ONLY half (`listAllAgents()` +
   `profileWideningsOf` against the backstop). Call this **before** `db.deleteProfile`. A fault here now
   aborts before the destructive write — the profile row still exists if it throws, so the caller's error
   response is consistent with reality (nothing happened) instead of describing a deletion that already
   committed.
2. `fileProfileDeleteGrantReachEvent(db, {profileId, profileName, source, reach})` — the WRITE half
   (`db.appendEvent`, best-effort, already wrapped in try/catch). Call this **after** `db.deleteProfile`
   has actually returned successfully, and only when step 1 returned non-null.

All three `profile_delete` write paths (platform MCP tool, manager MCP tool, REST route) now call
`computeProfileDeleteGrantReach` first, then `db.deleteProfile`, then (if non-null) `fileProfileDeleteGrantReachEvent`
— replacing the old `db.deleteProfile()` → `recordProfileDeleteGrantReach()` order at all three.

`recordProfileGrantReach` (the `profile_update` / `profile_create` grant-reach helper, unaffected by the
ordering hazard above — updating a profile never makes it vanish mid-computation) is internally split the
same way (`computeProfileGrantReach` / `fileProfileGrantReachEvent`) purely so the delete path's two new
exports can reuse the same pure computation and the same best-effort write, rather than duplicating either.

This also resolves `grantReach.ts`'s own prior doc note that `db.deleteProfile` could be called "in
whichever order that path's own existing logic already uses" — that was only ever true because
`deleteProfile` never nulls out an agent's `profileId` on cascade (plain `DELETE FROM profiles`, verified
`db.ts`), so the ordering happened not to matter for the BOUND-AGENT SCAN specifically. It still mattered
for crash-safety (this card's actual defect), which the old doc never addressed.

## Do not

- Do not call `fileProfileDeleteGrantReachEvent` before `db.deleteProfile` — the audit event must describe
  a widening that has actually happened, not one about to be attempted.
- Do not reintroduce a single `recordProfileDeleteGrantReach(db, {...})` call positioned after
  `db.deleteProfile` at any of the three (or a future fourth) call site — that is exactly the ordering this
  card removed. A new delete path must call the compute phase first, delete second, file phase third.
- Do not assume `db.deleteProfile` nulls an affected agent's `profileId` — it doesn't (plain `DELETE FROM
  profiles`), which is WHY the bound-agent scan read the same answer either side of the delete in practice.
  Do not use that as license to skip the before/after split again; the crash-safety hazard is independent
  of that detail and would resurface the moment `deleteProfile` ever did cascade.
