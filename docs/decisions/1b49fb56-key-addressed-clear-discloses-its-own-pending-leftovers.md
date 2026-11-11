# 1b49fb56 — a key-addressed quarantine clear discloses the same-identity pending entries it leaves blocking

From the c4f0d786 round-2 Code Review. `clearMergeQuarantine`'s ordinary `!freshIsForeign` route is a direct `clearMergeQuarantineByKey(…, identityWide=true)` with no pending pass afterwards. A same-identity pending entry the key-addressed clear deliberately leaves (a "reduce"-planned tied twin keeping its private token, or an UNTIED one: not the same object, no shared armed key, no orphan ref, tokens not a subset) keeps the claimant blocked, while the raw result read as a clean success (`wasQuarantined:true`, `liftedRepoPaths:[]`, no `stillQuarantined`).

Ruling (manager, 2026-11-11): DISCLOSE, never clear. `64119847` scenario 4 pins that the private token surviving a key-addressed clear is correct and fail-closed; the identity-wide sweep is `clear-by-path`'s job.

## Fix

`discloseStillBlockedAfterKeyClear` wraps that one route. After the clear it re-resolves with the PURE `stillBlockedEntryFor`; when the claimant is still blocked it returns `stillQuarantined:true`, the same reason text the project-resolved wrapper composes (`stillQuarantinedReason`, which names `clear-by-path` and an id only when the id is followable, `613e4592`), and `liftedRepoPaths`/`releasedRepoPaths` without the queried identity.

## Which surface each shape reaches (measured, not assumed)

- Raw `clearMergeQuarantine` export: S1 (reduced twin) and S2 (untied pending) are both reachable and were RED on `ec88046d`.
- `clearMergeQuarantineReporting` (the REST `/clear`): NOT reached by either shape in these seedings (2 and 3 claimants). Its `before = resolveQuarantineFor` lazily graduates/absorbs the pending entries first, so the claimant is cleared outright. The raw export is public and 80+ tests call it, so its result must be truthful regardless.
- The `"none"` route is NOT affected: the card said it was, but `tryClearMergeQuarantineByOwnIdentityBody` already composes `stillQuarantined` from its own re-resolve; its test is GREEN on `ec88046d`. It is kept as a pin and the route is not wrapped.

## Do not

- Do not make the key-addressed route clear those pending entries to "fix" this: that reverses `64119847` and the over-unblock it guards against.
- Do not call `resolveQuarantineFor`/`activeMergeQuarantineFor` for the re-check: both mutate (lazy graduation, sibling absorb) and would change the state being disclosed. Use `stillBlockedEntryFor`.
- Do not set `refusedBeforeClear` here: `clearMergeQuarantineReporting` forwards a refusal's reason verbatim on it (`3b1944b6` round 8); this is a post-clear still-blocked disclosure.
- Do not name the queried identity in `liftedRepoPaths`/`releasedRepoPaths` of a `stillQuarantined` result (`2a169469`).

Tests: `merge-quarantine-1b49fb56-untied-pending-disclosed.mjs`, `-reduced-twin-disclosed.mjs` (each 2 and 3 claimants, raw and Reporting, plus a clean-clear negative control), `-none-route-disclosed.mjs` (pin).
