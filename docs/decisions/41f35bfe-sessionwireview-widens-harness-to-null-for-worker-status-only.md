# 41f35bfe — `SessionWireView` widens `harness` to include `null` so `worker_status` can tell "unset" from "dropped"

## Narrative

Card 41f35bfe (the symmetric `Session` half of `3edf6ef7`'s `profileFields`/`ProfileWireView` — see that function's own doc comment for the full reasoning): an unset `harness` (a NULL column becomes `undefined` per `db.ts`'s `toSession`) and a field this projection simply doesn't carry were INDISTINGUISHABLE once this router's `ok()` envelope's `JSON.stringify` drops the undefined-valued key — `worker_status` could not answer "has this worker's harness been set" (observed directly: a real `worker_status` call on a live claude worker returned every sibling field and no `harness` key at all). `null` = unset, `"claude"`/`"codex"` = explicitly set — mirroring what the DB column itself already means (`db.ts`'s `insertSession` comment: "NULL = 'claude' (absent ⇒ today's only harness)").

Deliberately NOT fixed by changing `db.ts`'s `toSession()` to stop returning `undefined` for an unset harness — but NOT for the reason a first read of the Profile-side precedent above might suggest by analogy. `Session.harness` is typed `?: "claude" | "codex"` with NO `null` member, so `toSession()` returning an explicit `null` would not even COMPILE without widening that shared type, which is out of scope here. This differs from the Profile side: `Profile.harness` has the identical type shape, but `updateProfile`'s column binding (`db.ts:4806`, `patch.harness === undefined ? undefined : patch.harness ?? null`) genuinely DOES read an unresolved `undefined` as "leave the column as-is" on a real partial-PATCH path (`profile_update`/`PUT /api/profiles/:id`) — that hazard is real for Profiles. It does NOT transfer to Sessions: no `UPDATE sessions SET` statement in `db.ts` touches the `harness` column at all, and the fork/recycle "carry the pinned vendor CLI forward" call sites (`sessions/service.ts`) each build a brand-new `Session` literal via `old.harness ?? undefined`, which `insertSession`'s own binding (`s.harness ?? null`) then collapses to the same NULL value whether the source was `undefined` or an explicit `null` — so there is no "leave-as-is" semantic on the Session side to disturb.

Widening a LOCAL, wire-only return type (`SessionWireView`) — never `Session` itself — is still the right call regardless, on its own independent merit: `worker_status` is this field's only exposed reader (`fleetView`'s own curated `worker_list` row never names `harness` at all — a separate, pre-existing curation choice, not this bug) and it spreads this function's result straight into `ok({...})` alongside other computed fields, never treating it as a real `Session` — so this widening has zero blast radius outside this one function's return value.

## Do not

- Do not fix this by changing `db.ts`'s `toSession()` to stop returning `undefined` for an unset harness — `Session.harness` has no `null` member, so that wouldn't even compile without widening the shared type, and (unlike Profiles) no Session UPDATE statement has an "unresolved `undefined` means leave as-is" hazard to justify it anyway.
- Do not widen `Session` itself to accommodate this — widen only the LOCAL, wire-only `SessionWireView` return type, which has zero blast radius outside `worker_status`'s own response.

## Source

Inline comment in `packages/daemon/src/mcp/orchestration.ts` (above `projectSessionRowFields`): lines 2821-2854 (pre-tranche-2 numbering), as of commit `f81f9c1108773e559efe78b7166cbf78b6201480`. Relocated by card `a2278b09` (tranche 2).
