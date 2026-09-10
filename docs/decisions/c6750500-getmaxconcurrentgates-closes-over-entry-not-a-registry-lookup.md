# c6750500 — `getMaxConcurrentGates` closes over `entry` directly so it stays correct after the entry is deleted

## Narrative

Card c6750500: `runExclusive`'s `fn` receives a fourth param, `getMaxConcurrentGates` — a live getter reading THIS entry's `RegistryEntry.maxConcurrent` directly off the closed-over `entry` object, NOT a registry lookup by id. This is deliberate: it stays correct even called AFTER this entry has already been deleted from the registry in the `finally` block (the value is frozen at that point anyway, since no further admission can touch a deleted entry). A caller can therefore capture the getter reference inside `fn` and call it any time after — even outside `fn`, once `runExclusive` itself has resolved — and always read the true final max-over-run. A caller whose `fn` ignores it (every call site that predates this param) is byte-identical to before it existed.

`maxConcurrent` itself is bumped ONLY inside `admit()`, the ONLY place `active` can ever increase (a release can only decrease it, so it can never raise anyone's max). On every admission, EVERY currently-running entry's `maxConcurrent` — not just the one just admitted — is bumped to `max(current, active)`: this is what correctly captures "admitted alone, joined mid-run" — the joined entry's OWN recorded max must reflect the join too, not just the joiner's.

## Do not

- Do not look up `maxConcurrent` by registry id from inside or after `fn` — the entry may already be deleted by the time the getter is called; close over the `entry` object directly instead, as `getMaxConcurrentGates` does.
- Do not bump `maxConcurrent` only on the newly-admitted entry — every currently-running entry's own max must be bumped too, or an entry admitted solo and joined later never reflects that join in its own recorded value.

## Source

Inline comment in `packages/daemon/src/orchestration/gate-semaphore.ts` (`runExclusive`'s `getMaxConcurrentGates` param doc, lines 915-922; `RegistryEntry.maxConcurrent`'s own doc, lines 318-329; the bump loop in `admit()`, lines 468-476), commit `593f5f93d`, as of `beeeb7c2`. Relocated by card `772735d2` (tranche 2); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
