# 3edf6ef7 — `profileFields` resolves an unset `harness` to `null`, not the shipped default

## Narrative

An unset `harness` (a NULL column becomes `undefined` per `db.ts`'s `toProfile`) and a field this projection simply doesn't carry are INDISTINGUISHABLE once this router's `ok()` envelope's `JSON.stringify` drops the undefined-valued key — `profile_get`/`list_all_profiles` could not answer "has this profile's harness been set" without querying the `profiles` table directly.

The fix has to answer a SEMANTIC question, not just a structural one: what should an unset harness serialize as? Resolving it to the shipped default literal ("claude") only trades one ambiguity for another — a reader could no longer tell "never touched" from "explicitly set to claude", which is exactly the property this card exists to make readable (a human write path now exists with no trustworthy read-back). `null` is the right value: it mirrors what the DB column itself already means (NULL = unset; `insertProfile`'s own comment: "NULL = 'claude' (absent ⇒ today's only harness)"), so `null` = unset, `"claude"`/`"codex"` = explicitly set — three distinguishable, always-present wire states from two DB states plus the resolved default.

Widening a LOCAL, wire-only return type (`ProfileWireView`, in `entityRowFields.ts`) — never `Profile` itself — deliberately sidesteps the type constraint this card also flags (`Profile.harness` is `?: "claude" | "codex"` with NO `null` member): nothing downstream treats `profileFields()`'s result as a real `Profile` (every call site pipes it straight into `ok(...)` for the wire), so this widening has zero blast radius outside this one function's return value.

Deliberately NOT fixed by changing `db.ts`'s `toProfile()` (or the analogous `toSession()`) to stop returning `undefined` for an unset harness: that shared object is reused UNWRAPPED as the merge base in `profile_update`/`PUT /api/profiles/:id` (`{...existing, ...patch}` → `validateProfile` → `updateProfile`), whose partial-edit semantics treat an `undefined` `harness` as "leave the column as-is" (`validate.ts`'s own doc comment on this field). Resolving it to ANY concrete value at that shared layer — `null` included — would silently persist it into a previously-NULL column on ANY unrelated profile edit — a write-path side effect this READ-only card must not introduce. `Session.harness` (`db.ts`'s other mapper, `toSession`) does NOT have this hazard, despite sharing the identical `?: "claude" | "codex"` type shape: no `UPDATE sessions SET` statement in `db.ts` touches the `harness` column at all, and the fork/recycle "carry the pinned vendor CLI forward" call sites (`sessions/service.ts`) each build a brand-new `Session` literal (never a partial update) via `old.harness ?? undefined`, which `insertSession`'s own binding (`s.harness ?? null`) collapses to the same NULL regardless of whether the source was `undefined` or an explicit `null` — so there is no "leave-as-is" semantic on the Session side to disturb. The real blocker on `toSession()` is a TYPE one instead: `Session.harness` has no `null` member, so returning an explicit `null` there wouldn't compile without widening that shared type — out of scope here.

## Do not

- Do not resolve an unset `harness` to the shipped default literal (`"claude"`) anywhere on the wire — that loses the "never touched" vs "explicitly set to claude" distinction this card exists to make readable.
- Do not "fix" this by changing `db.ts`'s `toProfile()`/`toSession()` to stop returning `undefined` for an unset harness — that object is reused unwrapped as the merge base in `profile_update`'s partial-edit path, and any concrete resolved value there (including `null`) would silently persist into a previously-NULL column on an unrelated profile edit.
- Do not widen `Profile.harness` itself to include `null` — widen only the local, wire-only `ProfileWireView` return type.

## Source

Inline comment in `packages/daemon/src/mcp/entityRowFields.ts` (inside `profileFields`), as of commit `24f7f64fb468a77258c85d2fc97961ca98abd5e2`. Relocated by card `13455de9` (tranche 1).
