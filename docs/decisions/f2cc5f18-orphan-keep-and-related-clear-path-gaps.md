# f2cc5f18 — orphan-keep and related clear-path gaps found by Code Review of the raise-divert chain

_Split out of the former single `8db913e2` record by card `3608937e` so each record's injected Do-not extract fits the per-record cap; every section below is verbatim from it (pinned blob `2f1a55286d01`). The core record keeps the card's own rounds 1 and 3 and holds the index of every split-out record (rounds 2 and 4 of the card are in `sha:d529d42d`, record `d529d42d-raise-divert-rounds-2-and-4-chokepoint-union-and-in-memory-repoint.md`): `8db913e2-raise-diverts-instead-of-overwriting-a-kept-occupant.md`._

## Follow-up f2cc5f18

Layer (b) (`orphanRewriteOwnershipConfirmed`) only protects the PARTIAL-clear REWRITE of an orphan file —
a FULL clear reached `sweepOrphanLatchFileIfUnreferenced` directly, content-blind, permanently destroying
a real foreign token nothing in memory owned or referenced. Hermetically reproduced against main first.

THE FIX: `sweepOrphanLatchFileIfUnreferenced` takes `candidateTokens` (every token the caller's clear is
lifting, captured before any mutation) and gates its unlink on `orphanSweepSafeToDelete` — every real
on-disk token must already be in `candidateTokens` or globally tombstoned. All 6 real call sites updated
(one more than first traced: `clearMergeQuarantineLatchFile`'s RAW-FALLBACK branch passes `[]`).

Deliberately does NOT reuse `orphanFileTokensAccountedForByUpdate`/`markedFinalFullyCoveredByClear`
verbatim: both treat a parse failure as "cannot prove" (keep), which would regress merge-quarantine-
clear-by-path.mjs's own (J)/(Z1)/(Z1-route) — genuinely corrupt debris must stay deletable once
unreferenced (no `repoPath` can ever be parsed back out of it).

Regression found while verifying: `merge-quarantine-raise-protect-failure.mjs`'s own pre-existing
`29fe2372-isolate-b` scenario left its orphan file on disk after its full clear, previously relying on
the old content-blind delete to keep the shared LOOM_HOME clean — fixed with an explicit assertion plus
an `fs.rmSync` cleanup.

ROUND 2 (Code Review 745c3736): (1) test D never rebooted, so the fixture never reached the sweep at all
— vacuous; fixed, and proven RED under the "EACCES -> safe:true" mutant, GREEN restored. (2)
`clearMergeQuarantineLatchFile`'s RAW-FALLBACK kept a foreign-token orphan SILENTLY (`ok:true,
wasQuarantined:false`, no `latchKept`) — `orphanSweepSafeToDelete` now also returns the parsed
`repoPath`, so a keep is reported via `latchKept`/`referencingRepoPaths` (or `anyKeptUnattributed` when
no repoPath parsed), never silent. (3) a readable record with valid `repoPath`/`branch`/`reason` but
ZERO tokens was deleted (`[].every(...)` vacuously true) even though `reenterMergeQuarantinesAtBootImpl`'s
own PASS 1 arms that exact shape as a real quarantine — fixed: tokenless + PASS-1-armable now KEEPS. (4)
dropped the clear-by-path.mjs child re-run (redundant with its own standalone suite run). Tests E/F added
for (2)/(3). All proven RED (negative control against the prior commit) and GREEN restored, byte-identical.

KNOWN RESIDUAL, DELIBERATELY UNCHANGED: a TORN write of a real record (crash mid-write leaving truncated
JSON) parses as corrupt and is still deleted once unreferenced — identical to pre-fix behavior.

Tests: `merge-quarantine-orphan-sweep-content-aware.mjs` — isolate-b survival across a fresh reboot (A),
a positive control (B), a tombstone case (C), a non-ENOENT read failure (D), a tokenless-genuine keep
(E), a RAW-FALLBACK latchKept report naming a parsed repoPath (F), and the SAME report with no parsable
repoPath — only `anyKeptUnattributed` can surface it (G, Code Review e726e2ba). All 44
`merge-quarantine*.mjs` files run serially, exit 0, under both env states.
