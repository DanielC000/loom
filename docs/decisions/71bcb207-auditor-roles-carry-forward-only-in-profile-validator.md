# 71bcb207 — `auditor`/`workspace-auditor` are in the profile role enum, but carry-forward only

## Narrative

Card 71bcb207: `packages/daemon/src/profiles/validate.ts`'s `role` enum previously omitted `"auditor"` and `"workspace-auditor"` entirely, on the stated rationale that both are caller-set only via their dedicated `start*` paths (`startAuditor` / the future `startWorkspaceAuditor` — the real security boundary) and a profile must never confer either.

That omission was sound for MINTING but had an unintended side effect: both are real, seeded `SessionRole`s with bundled profiles (`profiles/seed.ts`'s `BUNDLED_PROFILES`) persisted via a direct `db.insertProfile`, bypassing `validateProfile` entirely. Every write path that EDITS an existing profile (`PUT /api/profiles/:id`, `mcp/platform.ts`'s `profile_update`) re-validates the WHOLE merged object (`validateProfile({ ...base, ...patch })`), not just the patched fields — so any write to an already-existing bundled `auditor`/`workspace-auditor` profile, including a patch that touches only an unrelated field, failed validation on the profile's own pre-existing `role` value and 400'd. These two profiles were effectively read-only through the validated write path, and the error blamed a field the caller never sent.

The fix distinguishes MINT/ASSIGN from EDIT at the validator level: `role` now accepts both values in the zod enum, but `roleCarryForwardOnlyError` rejects any resolved role that is one of these two values AND differs from `opts.previousRole` — a `CREATE` (no `previousRole`) or an `UPDATE` patch that changes role into or out of either value. An `UPDATE` that leaves the role unchanged (the common case — an unrelated field edit on an already-auditor profile) passes. This applies uniformly to every caller of `validateProfile`, including the human-only REST PUT and the Platform Lead's `profile_update` (`mcp/platform.ts`), neither of which layers any additional role-specific gate on top of the validator for this boundary.

`mcp/setup.ts`'s Setup Assistant surface is unaffected either way: it already layers `setupRoleError` (`SETUP_ALLOWED_PROFILE_ROLES = {manager, worker, setup}`) on top of `validateProfile`'s result, which independently rejects any resolved role outside that allowlist — including `auditor`/`workspace-auditor` — regardless of whether the value is a carry-forward or a fresh assignment. That is a separate, intentionally stricter gate for a lower-trust surface and this card does not touch it.

## Do not

- Do not let `role` resolve to `"auditor"` or `"workspace-auditor"` via `validateProfile` unless it equals `opts.previousRole` (an unchanged carry-forward) — a create or a reassignment into/out of either value must stay rejected; only their dedicated `start*` path may confer them.
- Do not add `setupRoleError`-allowlisted roles or otherwise loosen `SETUP_ALLOWED_PROFILE_ROLES` to "fix" this — the Setup Assistant's stricter posture toward these two roles is a separate, intentional gate, unrelated to this card.

## Source

`packages/daemon/src/profiles/validate.ts` (`role` field comment + `roleCarryForwardOnlyError`), card 71bcb207.
