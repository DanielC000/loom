# ec994992 — `isRetainedResultUsable` states what IS usable, not what isn't

## Narrative

Card ec994992, polarity-inverted from the original card 79b0ee52 guard, which enumerated ONE unusable shape (`ran:true` + `headCurrent:false`) and so silently kept serving every OTHER unusable shape it never named, including a CANCELLED result: cancel always settles `ran:false`, which the old `!(value.ran && …)` form vacuously passed as "usable" since `value.ran` was already false.

The predicate itself — what it now checks, and why each of its three conjuncts is written the way it is — stays inline in `packages/daemon/src/sessions/service.ts`, right after this record's anchor; that inline text is the current, authoritative description and is not restated here.

## Do not

- Do not go back to enumerating what's unusable when touching `isRetainedResultUsable` — the predicate is deliberately written to state what IS usable instead, so a new, not-yet-considered contamination shape defaults to falling through to a fresh run rather than being silently served stale (the exact defect this card fixed).

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (the `isRetainedResultUsable` option, in `runWorkerGate`'s `pendingOps.attach` call): originally lines 16076-16080 (the polarity-inversion history only), as of this tranche's HEAD (tranche 62). The predicate's own contract description (what each conjunct excludes and why) was kept inline per lead review and is not part of this record's extracted text.
